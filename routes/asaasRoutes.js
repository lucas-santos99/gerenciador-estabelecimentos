// routes/asaasRoutes.js
// Integração com Asaas — cobrança de licença (Pix + Cartão de Crédito/Débito)

const express = require("express");
const router  = express.Router();
const db      = require("../db/supabaseAdmin");
const { TIMEZONE_PADRAO, hojeStrTZ } = require("../utils/fusoHorario");
const { registrar } = require("./auditoriaRoutes");

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_API_URL  = process.env.ASAAS_API_URL || "https://api.asaas.com/v3";
const WEBHOOK_TOKEN  = process.env.ASAAS_WEBHOOK_TOKEN;

// Valor da licença em config_sistema — busca do banco
async function buscarValorPlano(mercearia_id = null) {
  // Verificar se a mercearia tem valor individual
  if (mercearia_id) {
    const { data: merc } = await db
      .from("mercearias")
      .select("valor_mensalidade")
      .eq("id", mercearia_id)
      .single();
    if (merc?.valor_mensalidade) return parseFloat(merc.valor_mensalidade);
  }
  // Fallback: valor padrão global
  const { data } = await db
    .from("config_sistema")
    .select("valor")
    .eq("chave", "valor_mensalidade")
    .single();
  return parseFloat(data?.valor) || 49.90;
}

async function buscarWhatsappSuporte() {
  const { data } = await db
    .from("config_sistema")
    .select("valor")
    .eq("chave", "whatsapp_suporte")
    .single();
  return data?.valor || "5500000000000";
}

// Headers padrão para todas as chamadas Asaas
function asaasHeaders() {
  return {
    "Content-Type": "application/json",
    "access_token": ASAAS_API_KEY,
  };
}

// ─────────────────────────────────────────────────────────
// Buscar ou criar cliente no Asaas pelo mercearia_id
// ─────────────────────────────────────────────────────────
async function obterOuCriarClienteAsaas(mercearia) {
  // Se já tem ID do Asaas salvo, retorna direto
  if (mercearia.asaas_customer_id) return mercearia.asaas_customer_id;

  // Validar CPF/CNPJ — Asaas só aceita 11 dígitos (CPF) ou 14 dígitos (CNPJ)
  const cnpjLimpo = (mercearia.cnpj || "").replace(/\D/g, "");
  const cpfCnpjValido = cnpjLimpo.length === 11 || cnpjLimpo.length === 14
    ? cnpjLimpo
    : undefined;

  console.log(`[Asaas] CPF/CNPJ recebido: "${mercearia.cnpj}" → limpo: "${cnpjLimpo}" (${cnpjLimpo.length} dígitos) → enviando: "${cpfCnpjValido}"`);

  // Validar telefone — Asaas exige mínimo 10 dígitos (DDD + número)
  const telLimpo = (mercearia.telefone || "").replace(/\D/g, "");
  const telefoneValido = telLimpo.length >= 10 && telLimpo.length <= 11
    ? telLimpo
    : undefined;

  // Criar cliente no Asaas
  const resp = await fetch(`${ASAAS_API_URL}/customers`, {
    method:  "POST",
    headers: asaasHeaders(),
    body: JSON.stringify({
      name:              mercearia.nome_fantasia,
      email:             mercearia.email_contato || undefined,
      phone:             telefoneValido,
      cpfCnpj:           cpfCnpjValido,
      externalReference: mercearia.id,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.errors?.[0]?.description || "Erro ao criar cliente no Asaas");

  const customerId = data.id;

  // Salvar o ID do Asaas na mercearia
  await db
    .from("mercearias")
    .update({ asaas_customer_id: customerId })
    .eq("id", mercearia.id);

  return customerId;
}

// ═══════════════════════════════════════════════════════════
// POST /api/asaas/gerar-cobranca/:mercearia_id
// Gera cobrança de CARTÃO para renovação de licença.
// ⚠️ O Pix saiu daqui — agora é gerado pelo Efí (efiRoutes.js),
// que tem taxa bem menor. O frontend chama os dois em paralelo.
// ═══════════════════════════════════════════════════════════
router.post("/gerar-cobranca/:mercearia_id", async (req, res) => {
  try {
    const { mercearia_id } = req.params;
    const { plano = "mensal" } = req.body; // mensal | anual

    // 1. Buscar dados da mercearia
    const { data: mercearia, error } = await db
      .from("mercearias")
      .select("id, nome_fantasia, email_contato, telefone, cnpj, asaas_customer_id, asaas_payment_id, asaas_payment_status, timezone")
      .eq("id", mercearia_id)
      .single();

    if (error || !mercearia) return res.status(404).json({ error: "Estabelecimento não encontrado." });

    // 2. Buscar valor do plano
    const valorMensal = await buscarValorPlano(mercearia_id);
    const valor = plano === "anual"
      ? parseFloat((valorMensal * 12 * 0.8).toFixed(2)) // 20% desconto anual
      : valorMensal;

    const diasPlano = plano === "anual" ? 365 : 30;

    // ── Tenta reaproveitar uma cobrança de cartão ainda pendente, em
    // vez de gerar uma nova toda vez — evita acumular cobranças
    // penduradas no painel do Asaas. Confirma o status direto com o
    // Asaas (fonte da verdade) e só reaproveita se ainda não venceu. ──
    if (mercearia.asaas_payment_id && mercearia.asaas_payment_status === "PENDING") {
      try {
        const respCheck = await fetch(`${ASAAS_API_URL}/payments/${mercearia.asaas_payment_id}`, {
          headers: asaasHeaders(),
        });
        const dataCheck = await respCheck.json();
        const timezone = mercearia.timezone || TIMEZONE_PADRAO;
        // Compara como DATA, no fuso do estabelecimento — antes usava
        // new Date() com setHours(0,0,0,0), que reflete o fuso do
        // SERVIDOR (Railway roda em UTC), não o do Brasil.
        const hojeStr = hojeStrTZ(timezone);
        const aindaValida = respCheck.ok
          && dataCheck.status === "PENDING"
          && dataCheck.dueDate
          && dataCheck.dueDate >= hojeStr;

        if (aindaValida) {
          return res.json({
            success:            true,
            payment_id_cartao:  dataCheck.id,
            valor:              dataCheck.value ?? valor,
            plano,
            dias:               diasPlano,
            due_date:           dataCheck.dueDate,
            invoice_url_cartao: dataCheck.invoiceUrl || null,
            reaproveitada:      true,
          });
        }
      } catch (e) {
        // Cobrança antiga não existe mais / erro ao consultar — segue
        // o fluxo normal abaixo e cria uma nova, sem interromper nada.
        console.log("[ASAAS] Cobrança anterior não pôde ser reaproveitada, gerando nova:", e.message);
      }
    }

    // 3. Buscar ou criar cliente no Asaas
    const customerId = await obterOuCriarClienteAsaas(mercearia);

    // 4. Data de vencimento da cobrança (3 dias para pagar)
    const vencCobranca = new Date();
    vencCobranca.setDate(vencCobranca.getDate() + 3);
    const dueDate = vencCobranca.toISOString().split("T")[0];

    const descricao = `Licença ${plano === "anual" ? "Anual" : "Mensal"} — Gerenciador de Estabelecimentos`;
    const externalRef = `${mercearia_id}|${diasPlano}`;

    // 5. Criar cobrança Cartão de Crédito
    const respPagCartao = await fetch(`${ASAAS_API_URL}/payments`, {
      method:  "POST",
      headers: asaasHeaders(),
      body:    JSON.stringify({
        customer:          customerId,
        billingType:       "CREDIT_CARD",
        value:             valor,
        dueDate:           dueDate,
        description:       descricao,
        externalReference: externalRef,
      }),
    });
    const cobrancaCartao = await respPagCartao.json();
    if (!respPagCartao.ok) {
      console.error("Erro Asaas criar cobrança Cartão:", cobrancaCartao);
      return res.status(400).json({ error: cobrancaCartao.errors?.[0]?.description || "Erro ao gerar cobrança de cartão." });
    }

    // 6. Salva o ID da cobrança de cartão (informativo — a confirmação
    // continua chegando pelo webhook, via externalReference)
    await db.from("mercearias").update({
      asaas_payment_id:     cobrancaCartao.id,
      asaas_payment_status: "PENDING",
    }).eq("id", mercearia_id);

    res.json({
      success:            true,
      payment_id_cartao:  cobrancaCartao.id,
      valor,
      plano,
      dias:               diasPlano,
      due_date:           dueDate,
      invoice_url_cartao: cobrancaCartao.invoiceUrl || null,
    });

  } catch (err) {
    console.error("GERAR COBRANÇA error:", err);
    res.status(500).json({ error: "Erro interno ao gerar cobrança." });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/asaas/status-pagamento/:payment_id
// Consulta status de uma cobrança (polling do frontend)
// ═══════════════════════════════════════════════════════════
router.get("/status-pagamento/:payment_id", async (req, res) => {
  try {
    const { payment_id } = req.params;

    const resp = await fetch(`${ASAAS_API_URL}/payments/${payment_id}`, {
      headers: asaasHeaders(),
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(400).json({ error: "Pagamento não encontrado." });

    res.json({
      status:    data.status,   // PENDING | RECEIVED | CONFIRMED | OVERDUE
      valor:     data.value,
      due_date:  data.dueDate,
    });

  } catch (err) {
    console.error("STATUS PAGAMENTO error:", err);
    res.status(500).json({ error: "Erro ao consultar status." });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/asaas/planos
// Retorna valores dos planos configurados no sistema
// ═══════════════════════════════════════════════════════════
router.get("/planos", async (req, res) => {
  try {
    const valorMensal = await buscarValorPlano();
    const valorAnual  = parseFloat((valorMensal * 12 * 0.8).toFixed(2));

    const whatsapp = await buscarWhatsappSuporte();
    res.json({
      mensal:    { valor: valorMensal, dias: 30,  descricao: "Plano Mensal" },
      anual:     { valor: valorAnual,  dias: 365, descricao: "Plano Anual (20% off)", economia: parseFloat((valorMensal * 12 - valorAnual).toFixed(2)) },
      whatsapp,
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar planos." });
  }
});


// ═══════════════════════════════════════════════════════════
// GET /api/asaas/config-tela-bloqueio
// Retorna textos editáveis da tela de bloqueio
// ═══════════════════════════════════════════════════════════
router.get("/config-tela-bloqueio", async (req, res) => {
  try {
    const { data } = await db
      .from("config_sistema")
      .select("chave, valor")
      .in("chave", [
        "tela_bloqueio_titulo",
        "tela_bloqueio_mensagem",
        "tela_bloqueio_info",
        "promo_ativa",
        "promo_texto",
        "promo_validade",
      ]);

    const cfg = {};
    (data || []).forEach(r => { cfg[r.chave] = r.valor; });

    res.json({
      titulo:         cfg.tela_bloqueio_titulo   || "",
      mensagem:       cfg.tela_bloqueio_mensagem || "",
      info:           cfg.tela_bloqueio_info     || "",
      promo_ativa:    cfg.promo_ativa === "true",
      promo_texto:    cfg.promo_texto            || "",
      promo_validade: cfg.promo_validade         || "",
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar configurações da tela." });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/asaas/webhook
// Recebe notificações do Asaas — libera acesso automaticamente
// ═══════════════════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  try {
    // Validar token do webhook
    const token = req.headers["asaas-access-token"] || req.query.token;
    if (token !== WEBHOOK_TOKEN) {
      console.warn("⚠️ Webhook Asaas com token inválido:", token);
      return res.status(401).json({ error: "Token inválido." });
    }

    const { event, payment } = req.body;

    console.log(`📩 Webhook Asaas: ${event} — payment ${payment?.id}`);

    // Só processa pagamentos confirmados
    const eventosConfirmados = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"];
    if (!eventosConfirmados.includes(event)) {
      return res.status(200).json({ ok: true, ignorado: true });
    }

    if (!payment?.externalReference) {
      return res.status(200).json({ ok: true, ignorado: true });
    }

    // externalReference = "mercearia_id|dias"
    const [mercearia_id, diasStr] = payment.externalReference.split("|");
    const dias = parseInt(diasStr) || 30;

    // Calcular nova data de vencimento
    // Se já tem data futura, adiciona a partir dela (acumula)
    const { data: merc } = await db
      .from("mercearias")
      .select("data_vencimento, nome_fantasia, timezone")
      .eq("id", mercearia_id)
      .single();

    // Compara como DATA ('YYYY-MM-DD'), no fuso do estabelecimento —
    // antes usava `new Date(merc.data_vencimento) > new Date()`, que
    // interpreta a data de vencimento como meia-noite EM UTC. Perto da
    // virada do dia isso podia fazer o vencimento "ainda válido" ser
    // tratado como já passado, e o cliente perder dias já pagos (a
    // renovação recomeçava do zero em vez de acumular a partir do
    // vencimento atual). Mesmo bug já corrigido no webhook do Efí.
    const timezoneMerc = merc?.timezone || TIMEZONE_PADRAO;
    const hojeStr = hojeStrTZ(timezoneMerc);
    const vencimentoAindaValido = merc?.data_vencimento && merc.data_vencimento >= hojeStr;

    const base = vencimentoAindaValido
      ? new Date(merc.data_vencimento + "T12:00:00Z") // acumula a partir do vencimento atual — 'Z' explícito, não depende do fuso do servidor
      : new Date();                                    // começa do zero

    base.setUTCDate(base.getUTCDate() + dias);
    const novaData = base.toISOString().split("T")[0];

    // Atualizar licença
    await db.from("mercearias").update({
      status_assinatura:    "ativa",
      data_vencimento:      novaData,
      asaas_payment_id:     payment.id,
      asaas_payment_status: "RECEIVED",
    }).eq("id", mercearia_id);

    // Fica no radar do SuperAdmin (aba Auditoria) mesmo sendo um evento
    // automático — sem isso, uma renovação via cartão só aparecia no
    // console.log do servidor, invisível no painel.
    registrar({
      mercearia_id,
      usuario_nome:  "Sistema (Asaas)",
      usuario_email: "Sistema (Asaas)", // evita o "Nome ()" que registrar() monta quando só tem nome — aqui não tem usuário autenticado, é webhook
      modulo:       "assinatura",
      acao:         "licenca_renovada_cartao",
      descricao:    `Licença renovada via cartão (Asaas) — ${dias} dia(s), vence ${novaData}`,
      meta:         { dias, data_vencimento: novaData, asaas_payment_id: payment.id },
    });

    console.log(`✅ Licença renovada: ${merc?.nome_fantasia} — ${dias} dias — vence ${novaData}`);

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error("WEBHOOK ASAAS error:", err);
    res.status(500).json({ error: "Erro interno no webhook." });
  }
});

module.exports = router;