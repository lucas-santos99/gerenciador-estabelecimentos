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
      scope:      "cob.write cob.read pix.read webhook.read webhook.write",
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
      .select("id, nome_fantasia")
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

    // txid precisa ser alfanumérico, 26 a 35 caracteres
    const txid = crypto.randomBytes(16).toString("hex"); // 32 caracteres

    const cobResp = await efiPixRequest("PUT", `/v2/cob/${txid}`, {
      calendario:          { expiracao: 3 * 24 * 60 * 60 }, // 3 dias pra pagar, igual o Asaas
      valor:                { original: valor.toFixed(2) },
      chave:                EFI_CHAVE_PIX,
      solicitacaoPagador:   `Licença ${plano === "anual" ? "Anual" : "Mensal"} — ${mercearia.nome_fantasia}`,
    });

    const locId = cobResp.data.loc?.id;
    let pixCopiaECola = cobResp.data.pixCopiaECola || null;
    let qrcodeBase64   = null;

    // Busca o QR Code (imagem) e a garantia do copia-e-cola via /loc
    if (locId) {
      const qrResp = await efiPixRequest("GET", `/v2/loc/${locId}/qrcode`);
      qrcodeBase64   = qrResp.data.imagemQrcode || null;
      pixCopiaECola  = pixCopiaECola || qrResp.data.qrcode || null;
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
// POST /api/efi/webhook?token=...
// Recebe a notificação do Efí quando um Pix é pago — libera acesso
// automaticamente, igual o webhook do Asaas já faz hoje.
//
// ⚠️ O Efí protege esse callback com mTLS (certificado do lado deles),
// não com um header de token como o Asaas. Por simplicidade, validamos
// só um token na URL (é o que você vai cadastrar como webhookUrl no
// Efí) — suficiente pra esse estágio, mas não é validação criptográfica
// de verdade. Dá pra reforçar depois com validação mTLS se quiser.
// ═══════════════════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  try {
    if (req.query.token !== EFI_WEBHOOK_TOKEN) {
      console.warn("⚠️ Webhook Efí com token inválido.");
      return res.status(401).json({ error: "Token inválido." });
    }

    const pixList = req.body.pix || [];
    if (pixList.length === 0) return res.status(200).json({ ok: true, ignorado: true });

    for (const pagamento of pixList) {
      const txid = pagamento.txid;
      if (!txid) continue;

      const { data: merc } = await db
        .from("mercearias")
        .select("id, nome_fantasia, data_vencimento, efi_pix_dias, efi_pix_txid")
        .eq("efi_pix_txid", txid)
        .single();

      if (!merc) {
        console.warn(`⚠️ Webhook Efí: txid ${txid} não corresponde a nenhum estabelecimento (já processado ou expirado).`);
        continue;
      }

      const dias = merc.efi_pix_dias || 30;

      // Mesma lógica de acumular vencimento que o webhook do Asaas usa
      const base = merc.data_vencimento && new Date(merc.data_vencimento) > new Date()
        ? new Date(merc.data_vencimento + "T12:00:00")
        : new Date();
      base.setDate(base.getDate() + dias);
      const novaData = base.toISOString().split("T")[0];

      await db.from("mercearias").update({
        status_assinatura: "ativa",
        data_vencimento:   novaData,
        efi_pix_status:    "CONCLUIDA",
      }).eq("id", merc.id);

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
    const { url } = req.body; // ex: https://seu-backend.up.railway.app/api/efi/webhook?token=SEU_TOKEN
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