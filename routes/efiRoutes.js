// routes/efiRoutes.js
// Integração com Efí Bank — SÓ PARA O PIX da mensalidade (taxa 1,19% em vez
// dos R$1,99 fixos do Asaas). O cartão de crédito CONTINUA no Asaas
// (asaasRoutes.js) — decisão consciente, não mexer nisso aqui.
//
// ⚠️ A API Pix do Efí exige um certificado .p12 em TODA requisição,
// diferente do Asaas que só usa um token. Por isso usamos axios (não o
// fetch nativo do Node, que não lida bem com certificado cliente via
// https.Agent) — é o mesmo padrão que a documentação oficial do Efí usa.

const express = require("express");
const router  = express.Router();
const https   = require("https");
const axios   = require("axios");
const crypto  = require("crypto");
const db      = require("../db/supabaseAdmin");
const { TIMEZONE_PADRAO, hojeStrTZ } = require("../utils/fusoHorario");
const { registrar } = require("./auditoriaRoutes");

const EFI_CLIENT_ID       = process.env.EFI_CLIENT_ID;
const EFI_CLIENT_SECRET   = process.env.EFI_CLIENT_SECRET;
const EFI_CERT_BASE64     = process.env.EFI_CERTIFICADO_BASE64; // conteúdo do .p12 convertido pra base64 (texto)
const EFI_SANDBOX         = process.env.EFI_SANDBOX !== "false"; // 'false' explícito = produção; qualquer outra coisa = homologação (mais seguro por padrão)
const EFI_CHAVE_PIX       = process.env.EFI_CHAVE_PIX;    // SUA chave Pix cadastrada na conta Efí (recebe a mensalidade)
const EFI_WEBHOOK_TOKEN   = process.env.EFI_WEBHOOK_TOKEN; // token que você escolhe, vai na URL do webhook cadastrado no Efí

const EFI_PIX_BASE = EFI_SANDBOX
  ? "https://pix-h.api.efipay.com.br"
  : "https://pix.api.efipay.com.br";

const faltando = [];
if (!EFI_CLIENT_ID)     faltando.push("EFI_CLIENT_ID");
if (!EFI_CLIENT_SECRET) faltando.push("EFI_CLIENT_SECRET");
if (!EFI_CERT_BASE64)   faltando.push("EFI_CERTIFICADO_BASE64");
if (!EFI_CHAVE_PIX)     faltando.push("EFI_CHAVE_PIX");

if (faltando.length > 0) {
  console.warn(`⚠️ [EFI] Faltando configurar: ${faltando.join(", ")} — rotas de Pix Efí vão falhar até isso ser corrigido.`);
} else {
  // Checagem de sanidade no boot — confirma nos logs do Railway que o
  // certificado colado tem o tamanho esperado (não foi cortado ao colar).
  try {
    const tamanho = Buffer.from(EFI_CERT_BASE64, "base64").length;
    console.log(`✅ [EFI] Certificado carregado — ${tamanho} bytes (confira se bate com o tamanho do arquivo .p12 original).`);
  } catch (e) {
    console.error("❌ [EFI] EFI_CERTIFICADO_BASE64 não é um base64 válido:", e.message);
  }
}

// ── Agente HTTPS com o certificado — obrigatório em toda chamada Pix ──
// O certificado fica só em memória (decodificado do base64), nunca
// grava em disco — mais simples e não depende de Volume no Railway.
let certificadoBuffer = null;
function agenteComCertificado() {
  if (!certificadoBuffer) {
    certificadoBuffer = Buffer.from(EFI_CERT_BASE64, "base64");
  }
  return new https.Agent({ pfx: certificadoBuffer, passphrase: "" });
}

// ── Token de acesso — cacheado em memória até expirar ──────────────
let tokenCache = { token: null, expiraEm: 0 };

async function obterTokenPix() {
  if (tokenCache.token && Date.now() < tokenCache.expiraEm) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`).toString("base64");

  const resp = await axios({
    method:  "POST",
    url:     `${EFI_PIX_BASE}/oauth/token`,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    httpsAgent: agenteComCertificado(),
    // Precisa pedir os escopos explicitamente aqui — mesmo com tudo
    // habilitado no painel da aplicação, sem isso o Efí libera um token
    // "mínimo" que não inclui permissão de escrita (ex: criar cobrança).
    data:    JSON.stringify({
      grant_type: "client_credentials",
      scope:      "cob.write cob.read pix.read webhook.read webhook.write payloadlocation.write payloadlocation.read",
    }),
  });

  tokenCache = {
    token:    resp.data.access_token,
    // Renova 60s antes de expirar de verdade, por segurança
    expiraEm: Date.now() + (resp.data.expires_in - 60) * 1000,
  };

  return tokenCache.token;
}

// Helper genérico pra chamar a API Pix já autenticada
async function efiPixRequest(method, path, data, extraHeaders = {}) {
  const token = await obterTokenPix();
  return axios({
    method,
    url:     `${EFI_PIX_BASE}${path}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
    httpsAgent: agenteComCertificado(),
    data:    data ? JSON.stringify(data) : undefined,
  });
}

// ═══════════════════════════════════════════════════════════
// POST /api/efi/gerar-cobranca-pix/:mercearia_id
// Gera a cobrança Pix da mensalidade (equivalente ao Pix do
// gerar-cobranca do Asaas — o cartão continua vindo de lá, separado)
// ═══════════════════════════════════════════════════════════
router.post("/gerar-cobranca-pix/:mercearia_id", async (req, res) => {
  try {
    const { mercearia_id } = req.params;
    const { plano = "mensal" } = req.body; // mensal | anual

    const { data: mercearia, error } = await db
      .from("mercearias")
      .select("id, nome_fantasia, efi_pix_txid, efi_pix_status, efi_pix_dias")
      .eq("id", mercearia_id)
      .single();

    if (error || !mercearia) return res.status(404).json({ error: "Estabelecimento não encontrado." });

    // Reaproveita a mesma lógica de valor que o asaasRoutes.js usa
    const { data: cfgRow } = await db
      .from("config_sistema")
      .select("valor")
      .eq("chave", "valor_mensalidade")
      .single();
    const valorMensal = parseFloat(cfgRow?.valor) || 49.90;
    const valor = plano === "anual"
      ? parseFloat((valorMensal * 12 * 0.8).toFixed(2))
      : valorMensal;
    const diasPlano = plano === "anual" ? 365 : 30;

    // ── Tenta reaproveitar uma cobrança Pix ainda ativa, em vez de
    // gerar uma nova toda vez — evita acumular cobranças penduradas no
    // painel do Efí quando alguém clica em "cobrar" várias vezes sem o
    // cliente pagar. Confirma o status direto com o Efí (fonte da
    // verdade), não confia só no que está salvo no banco. ──
    //
    // ⚠️ BUG REAL corrigido (21/08): o campo `status` de uma cobrança Pix
    // NÃO muda sozinho pra "expirada" quando o prazo (`calendario.expiracao`)
    // vence — continua "ATIVA" até alguém inativar explicitamente (mesmo
    // comportamento confirmado com outros PSPs, não é bug só do Efí). Sem
    // checar isso aqui, o sistema reaproveitava cobranças velhas (criadas
    // há mais de 3 dias) que a Efí ainda reportava como "ATIVA" — o QR/
    // copia-e-cola gerado saía tecnicamente perfeito (CRC, campos, tudo
    // certo), mas a própria Efí recusava o pagamento por trás por já estar
    // fora do prazo, e o app do banco do pagador mostrava "código inválido"
    // na hora de pagar. Agora a validade real (criação + expiracao) é
    // conferida antes de decidir reaproveitar.
    //
    // ⚠️ SEGUNDO BUG REAL corrigido (26/08): o valor de uma cobrança Pix é
    // travado no momento da criação (a Efí não deixa alterar depois) — se
    // o valor_mensalidade mudar em Configurações enquanto ainda existe uma
    // cobrança ATIVA e dentro do prazo, o código reaproveitava ela do
    // mesmo jeito, devolvendo o valor ANTIGO no QR/copia-e-cola mesmo a
    // prévia (`/api/asaas/planos`, que sempre lê o valor atual do banco)
    // já mostrando o valor novo pro usuário. Agora também compara o valor
    // da cobrança existente com o valor atual configurado antes de decidir
    // reaproveitar.
    if (mercearia.efi_pix_txid && mercearia.efi_pix_status === "ATIVA") {
      try {
        const cobExistente = await efiPixRequest("GET", `/v2/cob/${mercearia.efi_pix_txid}`);

        const criacaoStr        = cobExistente.data.calendario?.criacao;
        const expiracaoSegundos = cobExistente.data.calendario?.expiracao || 0;
        const expiraEm          = criacaoStr ? new Date(criacaoStr).getTime() + expiracaoSegundos * 1000 : 0;
        const aindaDentroDoPrazo = expiraEm > Date.now();

        const valorExistente = parseFloat(cobExistente.data.valor?.original);
        const valorAindaBate = Number.isFinite(valorExistente) && Math.abs(valorExistente - valor) < 0.01;

        if (!aindaDentroDoPrazo) {
          console.log(`[EFI] Cobrança anterior (${mercearia.efi_pix_txid}) está com status ATIVA mas já passou do prazo de expiração (calendario) — gerando nova em vez de reaproveitar.`);
        } else if (!valorAindaBate) {
          console.log(`[EFI] Cobrança anterior (${mercearia.efi_pix_txid}) tem valor desatualizado (R$ ${valorExistente} salva vs R$ ${valor} atual) — gerando nova em vez de reaproveitar.`);
        }

        if (cobExistente.data.status === "ATIVA" && aindaDentroDoPrazo && valorAindaBate) {
          const locId = cobExistente.data.loc?.id;
          let qrcodeBase64  = null;
          let pixCopiaECola = cobExistente.data.pixCopiaECola || null;
          if (locId) {
            try {
              const qrResp = await efiPixRequest("GET", `/v2/loc/${locId}/qrcode`);
              qrcodeBase64  = qrResp.data.imagemQrcode || null;
              pixCopiaECola = pixCopiaECola || qrResp.data.qrcode || null;
            } catch (e) {
              console.error("[EFI] Falha ao buscar QR da cobrança reaproveitada:", e.response?.data || e.message);
            }
          }
          if (pixCopiaECola) {
            return res.json({
              success:        true,
              txid:           mercearia.efi_pix_txid,
              valor:          parseFloat(cobExistente.data.valor?.original) || valor,
              plano,
              dias:           mercearia.efi_pix_dias || diasPlano,
              pix_qr_code:    qrcodeBase64,
              pix_copy_paste: pixCopiaECola,
              reaproveitada:  true,
            });
          }
        }

        // Chegou aqui: a cobrança antiga NÃO vai ser reaproveitada (prazo
        // vencido ou valor desatualizado), mas ainda está "ATIVA" segundo a
        // Efí — inativa ela explicitamente (26/08) pra blindar contra
        // alguém conseguir pagar aquele QR antigo por engano enquanto a
        // nova é gerada (print salvo, aba ainda aberta, copia-e-cola
        // encaminhado pra alguém, etc.). Best-effort: se falhar, não
        // impede a criação da cobrança nova abaixo.
        if (cobExistente.data.status === "ATIVA" && (!aindaDentroDoPrazo || !valorAindaBate)) {
          try {
            await efiPixRequest("PATCH", `/v2/cob/${mercearia.efi_pix_txid}`, { status: "REMOVIDA_PELO_USUARIO_RECEBEDOR" });
            console.log(`[EFI] Cobrança anterior (${mercearia.efi_pix_txid}) inativada (${!aindaDentroDoPrazo ? "prazo vencido" : "valor desatualizado"}).`);
          } catch (e) {
            console.error("[EFI] Falha ao inativar cobrança anterior (não bloqueia a geração da nova):", e.response?.data || e.message);
          }
        }
      } catch (e) {
        // Cobrança antiga não existe mais / expirou no Efí — segue o
        // fluxo normal abaixo e cria uma nova, sem interromper nada.
        console.log("[EFI] Cobrança anterior não pôde ser reaproveitada, gerando nova:", e.response?.data?.nome || e.message);
      }
    }

    // txid precisa ser alfanumérico, 26 a 35 caracteres
    const txid = crypto.randomBytes(16).toString("hex"); // 32 caracteres

    let cobResp;
    try {
      cobResp = await efiPixRequest("PUT", `/v2/cob/${txid}`, {
        calendario:          { expiracao: 3 * 24 * 60 * 60 }, // 3 dias pra pagar, igual o Asaas
        valor:                { original: valor.toFixed(2) },
        chave:                EFI_CHAVE_PIX,
        solicitacaoPagador:   `Licença ${plano === "anual" ? "Anual" : "Mensal"} — ${mercearia.nome_fantasia}`,
      });
    } catch (e) {
      console.error("[EFI] Falha ao CRIAR a cobrança (PUT /v2/cob):", e.response?.data || e.message);
      throw e;
    }

    const locId = cobResp.data.loc?.id;
    let pixCopiaECola = cobResp.data.pixCopiaECola || null;
    let qrcodeBase64   = null;

    // Busca o QR Code (imagem) e a garantia do copia-e-cola via /loc
    if (locId) {
      try {
        const qrResp = await efiPixRequest("GET", `/v2/loc/${locId}/qrcode`);
        qrcodeBase64   = qrResp.data.imagemQrcode || null;
        pixCopiaECola  = pixCopiaECola || qrResp.data.qrcode || null;
      } catch (e) {
        console.error("[EFI] Falha ao BUSCAR o QR Code (GET /v2/loc/:id/qrcode):", e.response?.data || e.message);
        // Não derruba a resposta inteira — se já temos o pixCopiaECola do
        // /cob, o front ainda pode gerar o QR a partir dele se precisar.
      }
    }

    // Salva a cobrança pendente pra o webhook conseguir achar depois
    await db.from("mercearias").update({
      efi_pix_txid:   txid,
      efi_pix_dias:   diasPlano,
      efi_pix_status: "ATIVA",
    }).eq("id", mercearia_id);

    res.json({
      success:        true,
      txid,
      valor,
      plano,
      dias:           diasPlano,
      pix_qr_code:    qrcodeBase64,   // já vem como data:image/png;base64,... — usar direto num <img>
      pix_copy_paste: pixCopiaECola,
    });

  } catch (err) {
    console.error("GERAR COBRANÇA PIX EFÍ error:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro interno ao gerar cobrança Pix." });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/efi/status-pagamento/:txid
// Consulta status da cobrança (polling do frontend, mesmo padrão do Asaas)
// ═══════════════════════════════════════════════════════════
router.get("/status-pagamento/:txid", async (req, res) => {
  try {
    const { txid } = req.params;
    const resp = await efiPixRequest("GET", `/v2/cob/${txid}`);

    res.json({
      status: resp.data.status, // ATIVA | CONCLUIDA | REMOVIDA_PELO_USUARIO_RECEBEDOR | REMOVIDA_PELO_PSP
      valor:  resp.data.valor?.original,
    });
  } catch (err) {
    console.error("STATUS PAGAMENTO PIX EFÍ error:", err.response?.data || err.message);
    res.status(400).json({ error: "Pagamento não encontrado." });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/efi/webhook/:token/pix
// (o Efí sempre adiciona "/pix" no final da URL registrada — por isso o
// token vai no caminho e não na query string, senão o "/pix" quebraria
// o valor do token)
// Recebe a notificação do Efí quando um Pix é pago — libera acesso
// automaticamente, igual o webhook do Asaas já faz hoje.
//
// ⚠️ O Efí protege esse callback com mTLS (certificado do lado deles),
// não com um header de token como o Asaas. Por simplicidade, validamos
// só um token na URL (é o que você vai cadastrar como webhookUrl no
// Efí) — suficiente pra esse estágio, mas não é validação criptográfica
// de verdade. Dá pra reforçar depois com validação mTLS se quiser.
// ═══════════════════════════════════════════════════════════
// O Efí testa se a URL responde ANTES de aceitar o cadastro do webhook —
// esse teste bate na URL exata que foi registrada (sem o "/pix" que ele
// mesmo adiciona depois pras notificações de verdade). Essa rota só
// existe pra passar nesse teste de verificação inicial.
router.all("/webhook/:token", (req, res) => {
  if (req.params.token !== EFI_WEBHOOK_TOKEN) return res.status(401).json({ error: "Token inválido." });
  res.status(200).json({ ok: true });
});

router.post("/webhook/:token/pix", async (req, res) => {
  try {
    if (req.params.token !== EFI_WEBHOOK_TOKEN) {
      console.warn("⚠️ Webhook Efí com token inválido. originalUrl:", req.originalUrl);
      return res.status(401).json({ error: "Token inválido." });
    }

    const pixList = req.body.pix || [];
    if (pixList.length === 0) return res.status(200).json({ ok: true, ignorado: true });

    for (const pagamento of pixList) {
      const txid = pagamento.txid;
      if (!txid) continue;

      const { data: merc } = await db
        .from("mercearias")
        .select("id, nome_fantasia, data_vencimento, efi_pix_dias, efi_pix_txid, timezone")
        .eq("efi_pix_txid", txid)
        .single();

      if (!merc) {
        console.warn(`⚠️ Webhook Efí: txid ${txid} não corresponde a nenhum estabelecimento (já processado ou expirado).`);
        continue;
      }

      const dias = merc.efi_pix_dias || 30;
      const timezone = merc.timezone || TIMEZONE_PADRAO;

      // Compara como DATA ('YYYY-MM-DD'), no fuso do estabelecimento —
      // antes usava `new Date(merc.data_vencimento) > new Date()`, que
      // interpreta a data de vencimento como meia-noite EM UTC. Perto da
      // virada do dia isso podia fazer o vencimento "ainda válido" ser
      // tratado como já passado, e o cliente perder dias já pagos (a
      // renovação recomeçava do zero em vez de acumular a partir do
      // vencimento atual).
      const hojeStr = hojeStrTZ(timezone);
      const vencimentoAindaValido = merc.data_vencimento && merc.data_vencimento >= hojeStr;

      const base = vencimentoAindaValido
        ? new Date(merc.data_vencimento + "T12:00:00Z") // acumula a partir do vencimento atual — 'Z' explícito, não depende do fuso do servidor
        : new Date();                                    // começa do zero
      base.setUTCDate(base.getUTCDate() + dias);
      const novaData = base.toISOString().split("T")[0];

      await db.from("mercearias").update({
        status_assinatura: "ativa",
        data_vencimento:   novaData,
        efi_pix_status:    "CONCLUIDA",
      }).eq("id", merc.id);

      // Fica no radar do SuperAdmin (aba Auditoria) mesmo sendo um evento
      // automático — sem isso, uma renovação via Pix só aparecia no
      // console.log do servidor, invisível no painel.
      registrar({
        mercearia_id: merc.id,
        usuario_nome:  "Sistema (Efí)",
        usuario_email: "Sistema (Efí)", // evita o "Nome ()" que registrar() monta quando só tem nome — aqui não tem usuário autenticado, é webhook
        modulo:       "assinatura",
        acao:         "licenca_renovada_pix",
        descricao:    `Licença renovada via Pix (Efí) — ${dias} dia(s), vence ${novaData}`,
        meta:         { dias, data_vencimento: novaData },
      });

      console.log(`✅ [EFÍ] Licença renovada via Pix: ${merc.nome_fantasia} — ${dias} dias — vence ${novaData}`);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error("WEBHOOK EFÍ error:", err.message);
    res.status(500).json({ error: "Erro interno no webhook." });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/efi/configurar-webhook
// Rota de USO ÚNICO — registra a URL do webhook no Efí pra sua chave
// Pix. Chame isso UMA VEZ (via Postman/curl) depois do deploy, não
// precisa disso toda vez que uma cobrança é gerada.
// ═══════════════════════════════════════════════════════════
router.post("/configurar-webhook", async (req, res) => {
  try {
    const { url } = req.body; // ex: https://seu-backend.up.railway.app/api/efi/webhook/SEU_TOKEN — NÃO inclua "/pix" no final, o Efí adiciona sozinho
    if (!url) return res.status(400).json({ error: "Informe a URL do webhook." });

    // x-skip-mtls-checking: pulamos a exigência de mTLS do nosso lado —
    // configurar um servidor que aceita handshake mTLS de entrada é uma
    // complexidade adicional grande, e o token na URL já dá uma proteção
    // razoável nesse estágio.
    await efiPixRequest("PUT", `/v2/webhook/${EFI_CHAVE_PIX}`, { webhookUrl: url }, { "x-skip-mtls-checking": "true" });
    res.json({ success: true, mensagem: "Webhook configurado no Efí." });

  } catch (err) {
    console.error("CONFIGURAR WEBHOOK EFÍ error:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao configurar webhook." });
  }
});

module.exports = router;