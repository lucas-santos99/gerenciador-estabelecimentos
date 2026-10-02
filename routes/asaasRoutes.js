// routes/asaasRoutes.js
// Integração com Asaas — cobrança de licença (Pix + Cartão de Crédito/Débito)

const express = require("express");
const router  = express.Router();
const db      = require("../db/supabaseAdmin");
const { TIMEZONE_PADRAO, hojeStrTZ } = require("../utils/fusoHorario");
const { registrar } = require("./auditoriaRoutes");
const authUser = require("../middlewares/authUser");
const { liberarComLicencaBloqueada, donoDaMerceariaOuSuperAdmin } = require("../middlewares/acessoCobranca");
const {
  buscarValorPlano, valorDoPlano, diasDoPlano, registrarCobranca, marcarCobrancaCancelada,
  aplicarPagamento, estornarPagamento, podeVerCobranca, tokenConfere,
} = require("../utils/licencaPagamentos");
const WC = require("../utils/whatsappCobrancas"); // (02/10/2026) cartão do plano de WhatsApp

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_API_URL  = process.env.ASAAS_API_URL || "https://api.asaas.com/v3";
const WEBHOOK_TOKEN  = process.env.ASAAS_WEBHOOK_TOKEN;

// Valor da licença: utils/licencaPagamentos.js (buscarValorPlano) — o
// mesmo cálculo para cartão, Pix e prévia de planos.

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
router.post("/gerar-cobranca/:mercearia_id", liberarComLicencaBloqueada, authUser, donoDaMerceariaOuSuperAdmin, async (req, res) => {
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
    const valor       = valorDoPlano(valorMensal, plano);
    const diasPlano   = diasDoPlano(plano);

    // ── Tenta reaproveitar uma cobrança de cartão ainda pendente, em
    // vez de gerar uma nova toda vez — evita acumular cobranças
    // penduradas no painel do Asaas. Confirma o status direto com o
    // Asaas (fonte da verdade) e só reaproveita se ainda não venceu. ──
    //
    // ⚠️ BUG REAL corrigido (26/08): o valor de uma cobrança já criada no
    // Asaas fica travado (não muda depois) — se `valor_mensalidade` mudar
    // em Configurações enquanto ainda existe uma cobrança PENDING dentro
    // do prazo, reaproveitar sem checar o valor devolvia o valor ANTIGO
    // no link de pagamento mesmo a prévia (`/api/asaas/planos`, que lê o
    // valor atual do banco) já mostrando o valor novo pro usuário. Mesma
    // causa do bug já corrigido no Pix (Efí) — agora também compara o
    // valor da cobrança existente com o valor atual configurado.
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
        const valorAindaBate = Number.isFinite(dataCheck.value) && Math.abs(dataCheck.value - valor) < 0.01;
        const aindaValida = respCheck.ok
          && dataCheck.status === "PENDING"
          && dataCheck.dueDate
          && dataCheck.dueDate >= hojeStr
          && valorAindaBate;

        if (respCheck.ok && dataCheck.status === "PENDING" && !valorAindaBate) {
          console.log(`[ASAAS] Cobrança anterior (${mercearia.asaas_payment_id}) tem valor desatualizado (R$ ${dataCheck.value} salva vs R$ ${valor} atual) — gerando nova em vez de reaproveitar.`);
        }

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

        // Chegou aqui: a cobrança antiga NÃO vai ser reaproveitada (vencida
        // ou valor desatualizado), mas ainda está "PENDING" no Asaas —
        // cancela ela explicitamente (26/08) pra blindar contra alguém
        // conseguir pagar aquele link antigo por engano enquanto o novo é
        // gerado. Best-effort: se falhar, não impede a criação da nova
        // cobrança abaixo.
        if (respCheck.ok && dataCheck.status === "PENDING" && !aindaValida) {
          try {
            await fetch(`${ASAAS_API_URL}/payments/${mercearia.asaas_payment_id}`, {
              method:  "DELETE",
              headers: asaasHeaders(),
            });
            await marcarCobrancaCancelada("asaas", mercearia.asaas_payment_id);
            console.log(`[ASAAS] Cobrança anterior (${mercearia.asaas_payment_id}) cancelada (${dataCheck.dueDate < hojeStr ? "vencida" : "valor desatualizado"}).`);
          } catch (e) {
            console.error("[ASAAS] Falha ao cancelar cobrança anterior (não bloqueia a geração da nova):", e.message);
          }
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

    // 6. Registra a cobrança (trava contra renovação em dobro — ver
    // utils/licencaPagamentos.js) e salva o ID na loja (informativo — a
    // confirmação continua chegando pelo webhook, via externalReference)
    await registrarCobranca({
      provedor: "asaas", cobranca_id: cobrancaCartao.id, mercearia_id,
      forma: "cartao", plano, dias: diasPlano, valor,
    });
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
router.get("/status-pagamento/:payment_id", authUser, async (req, res) => {
  try {
    const { payment_id } = req.params;

    // 29/09/2026: antes qualquer usuário logado consultava qualquer cobrança.
    if (!(await podeVerCobranca(req.user, "asaas", payment_id))) {
      return res.status(403).json({ error: "Acesso negado a esta cobrança." });
    }

    const resp = await fetch(`${ASAAS_API_URL}/payments/${encodeURIComponent(payment_id)}`, {
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
router.get("/planos", authUser, async (req, res) => {
  try {
    // Loja com valor individual vê o próprio valor (o mesmo que será cobrado).
    const merceariaId = req.user?.role === "super_admin" ? null : (req.user?.mercearia_id || null);
    const valorMensal = await buscarValorPlano(merceariaId);
    const valorAnual  = valorDoPlano(valorMensal, "anual");

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
router.get("/config-tela-bloqueio", authUser, async (req, res) => {
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
// Recebe notificações do Asaas — libera (ou estorna) a licença.
//
// ⚠️ BUG REAL corrigido (29/09/2026): cada pagamento de cartão renovava
// DUAS vezes — no PAYMENT_CONFIRMED (cartão aprovado, na hora) e de novo
// no PAYMENT_RECEIVED (dinheiro cai na conta ~30 dias depois). Agora:
//   • cada cobrança soma dias uma vez só (cobrancas_licenca + função
//     licenca_aplicar_pagamento, com trava no banco);
//   • o status e o valor são conferidos na API do Asaas, não no corpo
//     do webhook;
//   • estorno e contestação (chargeback) tiram os dias de volta;
//   • reembolso parcial / chargeback revertido geram alerta pro SuperAdmin.
// ═══════════════════════════════════════════════════════════
const EVENTOS_PAGO    = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"];
const EVENTOS_ESTORNO = [
  "PAYMENT_REFUNDED",
  "PAYMENT_CHARGEBACK_REQUESTED",
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
];
const EVENTOS_ALERTA  = ["PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_AWAITING_CHARGEBACK_REVERSAL"];
const STATUS_PAGO     = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];
const REF_LICENCA     = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\|(\d{1,4})$/i;
const ORIGEM          = "Sistema (Asaas)";

function registrarSistema(mercearia_id, acao, descricao, meta, escopo) {
  return registrar({
    mercearia_id,
    usuario_nome:  ORIGEM,
    usuario_email: ORIGEM, // evita o "Nome ()" que registrar() monta quando só tem nome — aqui não tem usuário autenticado, é webhook
    modulo:        "assinatura",
    acao,
    descricao,
    meta,
    escopo,
  });
}

router.post("/webhook", async (req, res) => {
  try {
    const token = req.headers["asaas-access-token"] || req.query.token;
    if (!tokenConfere(token, WEBHOOK_TOKEN)) {
      console.warn("⚠️ Webhook Asaas com token inválido (ou ASAAS_WEBHOOK_TOKEN não configurado).");
      return res.status(401).json({ error: "Token inválido." });
    }

    const { event, payment } = req.body || {};
    console.log(`📩 Webhook Asaas: ${event} — payment ${payment?.id}`);

    const tipo = EVENTOS_PAGO.includes(event) ? "pago"
      : EVENTOS_ESTORNO.includes(event) ? "estorno"
      : EVENTOS_ALERTA.includes(event) ? "alerta"
      : null;
    if (!tipo || !payment?.id) return res.status(200).json({ ok: true, ignorado: true });

    // (02/10/2026) Cartão do plano de WhatsApp (externalReference
    // "whatsapp|<id da cobrança>"): fluxo próprio — utils/whatsappCobrancas.js.
    const refWa = WC.REF_ASAAS.exec(payment.externalReference || "");
    if (refWa) return await webhookWhatsapp(res, event, tipo, payment, refWa[1].toLowerCase());

    // Só cobranças de licença (externalReference "mercearia_id|dias").
    // Outras cobranças da conta Asaas não são deste fluxo.
    const refWebhook = REF_LICENCA.exec(payment.externalReference || "");
    if (!refWebhook) return res.status(200).json({ ok: true, ignorado: true });

    // Fonte da verdade: a própria API do Asaas. Se não der pra consultar,
    // devolve 500 e o Asaas reenvia depois (é seguro: nada soma duas vezes).
    const respApi = await fetch(`${ASAAS_API_URL}/payments/${encodeURIComponent(payment.id)}`, { headers: asaasHeaders() });
    const pag = await respApi.json().catch(() => ({}));
    if (respApi.status === 404) {
      // Não existe na conta — não é um pagamento real. 200 pra não travar
      // a fila de webhooks do Asaas (ela pausa depois de muitas falhas).
      console.warn(`[ASAAS] Pagamento ${payment.id} não existe na API — ignorado.`);
      return res.status(200).json({ ok: true, ignorado: true });
    }
    if (!respApi.ok || !pag?.id) {
      console.error(`[ASAAS] Não consegui confirmar o pagamento ${payment.id} na API (HTTP ${respApi.status}).`);
      return res.status(500).json({ error: "Falha ao confirmar pagamento no Asaas." });
    }

    const ref = REF_LICENCA.exec(pag.externalReference || "");
    if (!ref || ref[0] !== refWebhook[0]) {
      console.warn(`[ASAAS] externalReference do webhook não confere com a API (${payment.id}) — ignorado.`);
      return res.status(200).json({ ok: true, ignorado: true });
    }
    const mercearia_id = ref[1];
    const diasRef      = parseInt(ref[2], 10);
    const valorPago    = Number(pag.value);

    // ── Pagamento confirmado ───────────────────────────────
    if (tipo === "pago") {
      if (!STATUS_PAGO.includes(pag.status)) {
        console.log(`[ASAAS] ${event} de ${pag.id}, mas o status atual no Asaas é ${pag.status} — não libera.`);
        return res.status(200).json({ ok: true, ignorado: true });
      }

      const r = await aplicarPagamento({
        provedor:     "asaas",
        cobranca_id:  pag.id,
        mercearia_id,
        dias:         diasRef,
        forma:        "cartao",
        valor_pago:   valorPago,
        evento:       event,
        origem:       ORIGEM,
      });

      if (r.aplicado) {
        registrarSistema(mercearia_id, "licenca_renovada_cartao",
          `Licença renovada via cartão (Asaas) — ${r.dias} dia(s), vence ${r.venc_novo}`,
          { dias: r.dias, data_vencimento: r.venc_novo, venc_anterior: r.venc_anterior, asaas_payment_id: pag.id, evento: event, valor: valorPago });
        console.log(`✅ Licença renovada: ${r.nome} — ${r.dias} dias — vence ${r.venc_novo} (${event})`);
      } else if (r.motivo === "ja_processado") {
        // Caso normal: PAYMENT_RECEIVED chegando depois do PAYMENT_CONFIRMED.
        console.log(`[ASAAS] ${event} de ${pag.id} ignorado — pagamento já processado (${r.status}).`);
      } else {
        registrarSistema(r.mercearia_id || mercearia_id, "licenca_pagamento_alerta",
          r.motivo === "valor_menor"
            ? `Pagamento ${pag.id} de R$ ${valorPago.toFixed(2)} é menor que o cobrado (R$ ${Number(r.valor).toFixed(2)}) — licença NÃO renovada, confira no Asaas`
            : `Pagamento ${pag.id} não foi aplicado (${r.motivo}) — confira no Asaas`,
          { asaas_payment_id: pag.id, motivo: r.motivo, evento: event, valor_pago: valorPago },
          "admin_global");
        console.warn(`[ASAAS] Pagamento ${pag.id} não aplicado: ${r.motivo}`);
      }

      await atualizarStatusNaLoja(mercearia_id, pag.id, "RECEIVED");
      return res.status(200).json({ ok: true });
    }

    // ── Estorno / contestação ──────────────────────────────
    if (tipo === "estorno") {
      if (STATUS_PAGO.includes(pag.status)) {
        console.log(`[ASAAS] ${event} de ${pag.id}, mas no Asaas ele segue ${pag.status} — nada a desfazer.`);
        return res.status(200).json({ ok: true, ignorado: true });
      }
      const r = await estornarPagamento({ provedor: "asaas", cobranca_id: pag.id, evento: event, origem: ORIGEM });
      if (r.revertido) {
        registrarSistema(r.mercearia_id, "licenca_pagamento_estornado",
          `Pagamento ${pag.id} estornado/contestado no Asaas (${event}) — ${r.dias} dia(s) removidos, vencimento ${r.venc_anterior} → ${r.venc_novo}${r.bloqueou ? " (acesso bloqueado)" : ""}`,
          { asaas_payment_id: pag.id, evento: event, dias: r.dias, venc_anterior: r.venc_anterior, data_vencimento: r.venc_novo, bloqueou: !!r.bloqueou });
        console.log(`↩️ [ASAAS] Estorno aplicado: ${r.nome} — -${r.dias} dias — vence ${r.venc_novo}`);
      } else {
        console.log(`[ASAAS] ${event} de ${pag.id} sem efeito (${r.motivo}).`);
      }
      await atualizarStatusNaLoja(mercearia_id, pag.id, pag.status || "REFUNDED");
      return res.status(200).json({ ok: true });
    }

    // ── Só alerta (reembolso parcial, chargeback revertido) ─
    registrarSistema(mercearia_id, "licenca_pagamento_alerta",
      event === "PAYMENT_PARTIALLY_REFUNDED"
        ? `Pagamento ${pag.id} teve reembolso parcial no Asaas — a licença não foi alterada, revise se precisa ajustar`
        : `Contestação do pagamento ${pag.id} foi revertida a nosso favor no Asaas — se os dias tinham sido removidos, libere de novo manualmente`,
      { asaas_payment_id: pag.id, evento: event, status: pag.status },
      "admin_global");
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("WEBHOOK ASAAS error:", err);
    res.status(500).json({ error: "Erro interno no webhook." });
  }
});

// (02/10/2026) Pagamento do plano de WhatsApp pelo cartão. Confere na API
// do Asaas (status, valor, taxa real = value − netValue) e aplica uma vez
// só. Estorno / contestação viram alerta pro SuperAdmin (não tiram
// créditos sozinhos). Erro aqui sobe pro catch do webhook (500 → reenvio).
async function webhookWhatsapp(res, event, tipo, payment, cobId) {
  const respApi = await fetch(`${ASAAS_API_URL}/payments/${encodeURIComponent(payment.id)}`, { headers: asaasHeaders() });
  const pag = await respApi.json().catch(() => ({}));
  if (respApi.status === 404) {
    console.warn(`[ASAAS] Pagamento ${payment.id} (WhatsApp) não existe na API — ignorado.`);
    return res.status(200).json({ ok: true, ignorado: true });
  }
  if (!respApi.ok || !pag?.id) {
    console.error(`[ASAAS] Não consegui confirmar o pagamento ${payment.id} (WhatsApp) na API (HTTP ${respApi.status}).`);
    return res.status(500).json({ error: "Falha ao confirmar pagamento no Asaas." });
  }
  const cob = await WC.buscar(db, "asaas", pag.id);
  const refApi = WC.REF_ASAAS.exec(pag.externalReference || "");
  if (!cob || !refApi || refApi[1].toLowerCase() !== cob.id || cob.id !== cobId) {
    console.warn(`[ASAAS] Pagamento ${payment.id}: referência de WhatsApp não confere com a cobrança registrada — ignorado.`);
    return res.status(200).json({ ok: true, ignorado: true });
  }

  if (tipo === "pago") {
    const r = await WC.receberAsaas(db, cob, pag, event);
    if (r.resultado === "ocupado") return res.status(500).json({ error: "Pagamento em processamento, reenviar." });
    console.log(`[ASAAS] Cartão do WhatsApp ${pag.id} (${event}): ${r.resultado}`);
    return res.status(200).json({ ok: true });
  }
  if (tipo === "estorno") {
    if (STATUS_PAGO.includes(pag.status)) return res.status(200).json({ ok: true, ignorado: true });
    await WC.estornar(db, cob, event, "estornado ou contestado");
    return res.status(200).json({ ok: true });
  }
  WC.alertar(cob, event === "PAYMENT_PARTIALLY_REFUNDED"
    ? `Pagamento ${pag.id} do WhatsApp teve reembolso parcial no Asaas — os créditos não foram alterados, revise se precisa ajustar`
    : `Contestação do pagamento ${pag.id} do WhatsApp foi revertida a nosso favor no Asaas`, { evento: event, status: pag.status });
  return res.status(200).json({ ok: true });
}

// Atualiza o status informativo em mercearias só se for a cobrança que
// está salva lá — não apaga a referência de uma cobrança mais nova.
async function atualizarStatusNaLoja(mercearia_id, payment_id, status) {
  try {
    await db.from("mercearias")
      .update({ asaas_payment_status: status })
      .eq("id", mercearia_id)
      .eq("asaas_payment_id", payment_id);
  } catch (e) {
    console.error("[ASAAS] Falha ao atualizar asaas_payment_status:", e.message);
  }
}

module.exports = router;
// (02/10/2026) Ajudantes usados pela cobrança do WhatsApp (utils/whatsappCobrancas.js)
module.exports.asaas = {
  url: ASAAS_API_URL,
  headers: asaasHeaders,
  clienteDe: obterOuCriarClienteAsaas,
  configurado: () => !!ASAAS_API_KEY,
};
