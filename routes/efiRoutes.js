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
const { registrar } = require("./auditoriaRoutes");
const authUser = require("../middlewares/authUser");
const onlyMaster = require("../middlewares/onlyMaster");
const { liberarComLicencaBloqueada, donoDaMerceariaOuSuperAdmin } = require("../middlewares/acessoCobranca");
const {
  buscarValorPlano, valorDoPlano, diasDoPlano, registrarCobranca, marcarCobrancaCancelada,
  buscarCobranca, aplicarPagamento, estornarPagamento, podeVerCobranca, tokenConfere,
} = require("../utils/licencaPagamentos");
const WC = require("../utils/whatsappCobrancas"); // (02/10/2026) Pix do plano de WhatsApp

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
router.post("/gerar-cobranca-pix/:mercearia_id", liberarComLicencaBloqueada, authUser, donoDaMerceariaOuSuperAdmin, async (req, res) => {
  try {
    const { mercearia_id } = req.params;
    const { plano = "mensal" } = req.body; // mensal | anual

    const { data: mercearia, error } = await db
      .from("mercearias")
      .select("id, nome_fantasia, efi_pix_txid, efi_pix_status, efi_pix_dias")
      .eq("id", mercearia_id)
      .single();

    if (error || !mercearia) return res.status(404).json({ error: "Estabelecimento não encontrado." });

    // Mesmo valor do cartão (utils/licencaPagamentos.js). 29/09/2026:
    // antes o Pix usava só o valor global e ignorava o valor individual
    // do estabelecimento — cartão e Pix podiam sair com valores diferentes.
    const valorMensal = await buscarValorPlano(mercearia_id);
    const valor       = valorDoPlano(valorMensal, plano);
    const diasPlano   = diasDoPlano(plano);

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
            await marcarCobrancaCancelada("efi", mercearia.efi_pix_txid);
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

    // Registra a cobrança (o webhook acha a loja por aqui, mesmo que
    // outra cobrança seja gerada depois) e salva o txid na loja
    await registrarCobranca({
      provedor: "efi", cobranca_id: txid, mercearia_id,
      forma: "pix", plano, dias: diasPlano, valor,
    });
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
router.get("/status-pagamento/:txid", authUser, async (req, res) => {
  try {
    const { txid } = req.params;

    // 29/09/2026: antes qualquer usuário logado consultava qualquer cobrança.
    if (!(await podeVerCobranca(req.user, "efi", txid))) {
      return res.status(403).json({ error: "Acesso negado a esta cobrança." });
    }

    const resp = await efiPixRequest("GET", `/v2/cob/${encodeURIComponent(txid)}`);

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
  if (!tokenConfere(req.params.token, EFI_WEBHOOK_TOKEN)) return res.status(401).json({ error: "Token inválido." });
  res.status(200).json({ ok: true });
});

// ⚠️ BUG corrigido (29/09/2026): o webhook achava a loja pelo txid e
// somava dias toda vez que chegava notificação daquele txid — um reenvio
// do Efí, ou o aviso de uma DEVOLUÇÃO do Pix (que vem no mesmo webhook,
// com o mesmo txid), renovava de novo. Agora:
//   • cada cobrança soma dias uma vez só (cobrancas_licenca + função
//     licenca_aplicar_pagamento, com trava no banco);
//   • status, valor e devoluções são conferidos na API do Efí;
//   • devolução total tira os dias de volta; parcial gera alerta;
//   • a cobrança é achada pelo registro próprio — antes, se uma cobrança
//     nova fosse gerada enquanto a antiga era paga, o pagamento se perdia.
const ORIGEM_EFI = "Sistema (Efí)";

function registrarSistemaEfi(mercearia_id, acao, descricao, meta, escopo) {
  return registrar({
    mercearia_id,
    usuario_nome:  ORIGEM_EFI,
    usuario_email: ORIGEM_EFI, // evita o "Nome ()" que registrar() monta quando só tem nome — aqui não tem usuário autenticado, é webhook
    modulo:        "assinatura",
    acao,
    descricao,
    meta,
    escopo,
  });
}

router.post("/webhook/:token/pix", async (req, res) => {
  try {
    if (!tokenConfere(req.params.token, EFI_WEBHOOK_TOKEN)) {
      console.warn("⚠️ Webhook Efí com token inválido (ou EFI_WEBHOOK_TOKEN não configurado).");
      return res.status(401).json({ error: "Token inválido." });
    }

    const pixList = Array.isArray(req.body?.pix) ? req.body.pix : [];
    if (pixList.length === 0) return res.status(200).json({ ok: true, ignorado: true });

    for (const pagamento of pixList) {
      const txid = pagamento?.txid;
      if (!txid) continue; // Pix direto na chave, sem cobrança — não é licença

      // (02/10/2026) Pix do plano de WhatsApp (ativação, mensalidade do ciclo
      // ou pacote extra): fluxo próprio — utils/whatsappCobrancas.js. Mesmas
      // garantias: confere na API do Efí e aplica uma vez só.
      const cobWa = await WC.buscar(db, "efi", txid);
      if (cobWa) {
        let apiWa;
        try {
          apiWa = (await efiPixRequest("GET", `/v2/cob/${encodeURIComponent(txid)}`)).data;
        } catch (e) {
          if (e.response?.status === 404) { console.warn(`⚠️ Webhook Efí: txid ${txid} (WhatsApp) não existe na API do Efí — ignorado.`); continue; }
          throw e;
        }
        const rWa = await WC.receberPix(db, cobWa, apiWa, pagamento.endToEndId);
        // Outro processo está aplicando este mesmo pagamento: pede reenvio.
        if (rWa.resultado === "ocupado") throw new Error(`cobrança do WhatsApp ${txid} em processamento`);
        console.log(`[EFI] Pix do WhatsApp ${txid}: ${rWa.resultado}`);
        continue;
      }

      // Cobrança registrada (novo) ou, para cobranças antigas, a loja
      // que ainda tem esse txid salvo.
      const cob = await buscarCobranca("efi", txid);
      let mercearia_id = cob?.mercearia_id || null;
      let dias         = cob?.dias || null;
      if (!cob) {
        const { data: merc } = await db
          .from("mercearias")
          .select("id, efi_pix_dias")
          .eq("efi_pix_txid", txid)
          .maybeSingle();
        if (merc) { mercearia_id = merc.id; dias = merc.efi_pix_dias || 30; }
      }
      if (!mercearia_id) {
        console.warn(`⚠️ Webhook Efí: txid ${txid} não corresponde a nenhuma cobrança de licença.`);
        continue;
      }

      // Fonte da verdade: a API do Efí. Erro de rede/servidor → 500 e o
      // Efí reenvia (seguro, nada soma duas vezes). Cobrança inexistente
      // na API → ignora.
      let cobApi;
      try {
        cobApi = (await efiPixRequest("GET", `/v2/cob/${encodeURIComponent(txid)}`)).data;
      } catch (e) {
        if (e.response?.status === 404) {
          console.warn(`⚠️ Webhook Efí: txid ${txid} não existe na API do Efí — ignorado.`);
          continue;
        }
        throw e;
      }

      if (cobApi?.status !== "CONCLUIDA") {
        console.log(`[EFI] Notificação do txid ${txid}, mas a cobrança está ${cobApi?.status} — não libera.`);
        continue;
      }

      const pixApi = (cobApi.pix || []).find(p => p.endToEndId === pagamento.endToEndId) || (cobApi.pix || [])[0];
      const valorPago = parseFloat(pixApi?.valor ?? pagamento.valor);
      const devolvido = (pixApi?.devolucoes || [])
        .filter(d => d.status === "DEVOLVIDO")
        .reduce((s, d) => s + (parseFloat(d.valor) || 0), 0);

      // ── Devolução do Pix ──────────────────────────────────
      if (devolvido > 0) {
        if (Number.isFinite(valorPago) && devolvido + 0.01 >= valorPago) {
          const r = await estornarPagamento({ provedor: "efi", cobranca_id: txid, evento: "PIX_DEVOLVIDO", origem: ORIGEM_EFI });
          if (r.revertido) {
            registrarSistemaEfi(r.mercearia_id, "licenca_pagamento_estornado",
              `Pix ${txid} devolvido — ${r.dias} dia(s) removidos, vencimento ${r.venc_anterior} → ${r.venc_novo}${r.bloqueou ? " (acesso bloqueado)" : ""}`,
              { txid, evento: "PIX_DEVOLVIDO", dias: r.dias, venc_anterior: r.venc_anterior, data_vencimento: r.venc_novo, bloqueou: !!r.bloqueou });
            console.log(`↩️ [EFÍ] Devolução aplicada: ${r.nome} — -${r.dias} dias — vence ${r.venc_novo}`);
          } else {
            console.log(`[EFI] Devolução do txid ${txid} sem efeito (${r.motivo}).`);
          }
        } else {
          registrarSistemaEfi(mercearia_id, "licenca_pagamento_alerta",
            `Pix ${txid} teve devolução parcial (R$ ${devolvido.toFixed(2)} de R$ ${valorPago.toFixed(2)}) — a licença não foi alterada, revise se precisa ajustar`,
            { txid, evento: "PIX_DEVOLUCAO_PARCIAL", devolvido, valor_pago: valorPago },
            "admin_global");
        }
        continue;
      }

      // ── Pagamento ─────────────────────────────────────────
      const r = await aplicarPagamento({
        provedor:      "efi",
        cobranca_id:   txid,
        mercearia_id,
        dias,
        forma:         "pix",
        valor_pago:    valorPago,
        evento:        "PIX_RECEBIDO",
        pagamento_ref: pixApi?.endToEndId || pagamento.endToEndId,
        origem:        ORIGEM_EFI,
      });

      if (r.aplicado) {
        registrarSistemaEfi(mercearia_id, "licenca_renovada_pix",
          `Licença renovada via Pix (Efí) — ${r.dias} dia(s), vence ${r.venc_novo}`,
          { dias: r.dias, data_vencimento: r.venc_novo, venc_anterior: r.venc_anterior, txid, valor: valorPago });
        console.log(`✅ [EFÍ] Licença renovada via Pix: ${r.nome} — ${r.dias} dias — vence ${r.venc_novo}`);
      } else if (r.motivo === "ja_processado") {
        console.log(`[EFI] txid ${txid} ignorado — pagamento já processado (${r.status}).`);
      } else {
        registrarSistemaEfi(r.mercearia_id || mercearia_id, "licenca_pagamento_alerta",
          r.motivo === "valor_menor"
            ? `Pix ${txid} de R$ ${valorPago.toFixed(2)} é menor que o cobrado (R$ ${Number(r.valor).toFixed(2)}) — licença NÃO renovada, confira no Efí`
            : `Pix ${txid} não foi aplicado (${r.motivo}) — confira no Efí`,
          { txid, motivo: r.motivo, valor_pago: valorPago },
          "admin_global");
        console.warn(`[EFI] Pix ${txid} não aplicado: ${r.motivo}`);
      }

      // Status informativo na loja — só se ainda for a cobrança salva lá.
      await db.from("mercearias")
        .update({ efi_pix_status: "CONCLUIDA" })
        .eq("id", mercearia_id)
        .eq("efi_pix_txid", txid);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error("WEBHOOK EFÍ error:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro interno no webhook." });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/efi/configurar-webhook
// Rota de USO ÚNICO — registra a URL do webhook no Efí pra sua chave
// Pix. Chame isso UMA VEZ (via Postman/curl) depois do deploy, não
// precisa disso toda vez que uma cobrança é gerada.
// ═══════════════════════════════════════════════════════════
// 🔒 22/09/2026: antes sem proteção nenhuma — qualquer pessoa conseguia
// apontar o webhook do Pix pra outro endereço (renovação automática para
// de funcionar e os dados de quem pagou vão pra terceiros). Agora só o
// SuperAdmin master, logado (mande o Bearer token no Postman/curl).
router.post("/configurar-webhook", authUser, onlyMaster, async (req, res) => {
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
// (02/10/2026) Ajudantes usados pela cobrança do WhatsApp (utils/whatsappCobrancas.js)
module.exports.efiPixRequest = efiPixRequest;
module.exports.efiConfigurado = () => faltando.length === 0;
module.exports.EFI_CHAVE_PIX = EFI_CHAVE_PIX;
