// utils/licencaPagamentos.js
//
// Regras únicas de pagamento da licença (cartão via Asaas e Pix via Efí),
// criadas em 29/09/2026 depois do bug das renovações em dobro: o webhook
// do Asaas somava dias no PAYMENT_CONFIRMED (cartão aprovado) e de novo no
// PAYMENT_RECEIVED (dinheiro caiu, ~30 dias depois no cartão).
//
// Como funciona agora:
//   • Toda cobrança gerada é registrada em `cobrancas_licenca` (pendente),
//     com o valor e os dias combinados naquele momento.
//   • Quando o pagamento confirma, a função do banco
//     `licenca_aplicar_pagamento` soma os dias UMA vez só, travando a
//     cobrança e o estabelecimento na mesma transação. Qualquer outro
//     evento do mesmo pagamento (RECEIVED depois do CONFIRMED, reenvio do
//     webhook, aviso de devolução do Pix) encontra a cobrança já "pago" e
//     não soma nada.
//   • Estorno / contestação (chargeback) tira os dias daquele pagamento
//     (`licenca_estornar_pagamento`), também uma vez só.
//   • Os webhooks não confiam no corpo recebido: sempre conferem o status
//     e o valor direto na API do provedor antes de liberar.

const crypto = require("crypto");
const db     = require("../db/supabaseAdmin");

const VALOR_PADRAO = 49.90;

// Valor da mensalidade: valor individual do estabelecimento (se houver)
// ou o valor global de Configurações. Usado pelo cartão, pelo Pix e pela
// prévia de planos — antes o Pix ignorava o valor individual.
async function buscarValorPlano(mercearia_id = null) {
  if (mercearia_id) {
    const { data: merc } = await db
      .from("mercearias")
      .select("valor_mensalidade")
      .eq("id", mercearia_id)
      .maybeSingle();
    const individual = parseFloat(merc?.valor_mensalidade);
    if (Number.isFinite(individual) && individual > 0) return individual;
  }
  const { data } = await db
    .from("config_sistema")
    .select("valor")
    .eq("chave", "valor_mensalidade")
    .maybeSingle();
  const global = parseFloat(data?.valor);
  return Number.isFinite(global) && global > 0 ? global : VALOR_PADRAO;
}

function valorDoPlano(valorMensal, plano) {
  return plano === "anual"
    ? parseFloat((valorMensal * 12 * 0.8).toFixed(2)) // 20% de desconto no anual
    : valorMensal;
}

function diasDoPlano(plano) {
  return plano === "anual" ? 365 : 30;
}

// Registra a cobrança recém-gerada. Falha aqui não pode impedir o cliente
// de pagar: o webhook também registra cobranças que não encontrar.
async function registrarCobranca({ provedor, cobranca_id, mercearia_id, forma, plano, dias, valor }) {
  try {
    const { error } = await db.from("cobrancas_licenca").insert({
      provedor, cobranca_id, mercearia_id, forma,
      plano: plano || null,
      dias,
      valor,
      status: "pendente",
    });
    // 23505 = já registrada (ex.: cobrança reaproveitada) — tudo certo.
    if (error && error.code !== "23505") console.error(`[LICENÇA] Falha ao registrar cobrança ${provedor} ${cobranca_id}:`, error.message);
  } catch (e) {
    console.error(`[LICENÇA] Falha ao registrar cobrança ${provedor} ${cobranca_id}:`, e.message);
  }
}

// Cobrança substituída por outra (vencida / valor desatualizado).
// Só mexe se ainda estiver pendente — nunca desfaz um pagamento.
async function marcarCobrancaCancelada(provedor, cobranca_id) {
  try {
    await db.from("cobrancas_licenca")
      .update({ status: "cancelada", atualizado_em: new Date().toISOString() })
      .eq("provedor", provedor)
      .eq("cobranca_id", cobranca_id)
      .eq("status", "pendente");
  } catch (e) {
    console.error(`[LICENÇA] Falha ao marcar cobrança ${provedor} ${cobranca_id} como cancelada:`, e.message);
  }
}

async function buscarCobranca(provedor, cobranca_id) {
  const { data, error } = await db.from("cobrancas_licenca")
    .select("id, provedor, cobranca_id, mercearia_id, forma, plano, dias, valor, status, venc_novo")
    .eq("provedor", provedor)
    .eq("cobranca_id", cobranca_id)
    .maybeSingle();
  if (error) throw new Error(`cobrancas_licenca: ${error.message}`);
  return data || null;
}

// Soma os dias de um pagamento confirmado — uma vez só por cobrança.
// Lança erro se o banco falhar (o webhook devolve 500 e o provedor reenvia;
// reenviar é seguro justamente porque a função é idempotente).
async function aplicarPagamento({ provedor, cobranca_id, mercearia_id, dias, forma, valor_pago, evento, pagamento_ref, origem }) {
  const { data, error } = await db.rpc("licenca_aplicar_pagamento", {
    p_provedor:      provedor,
    p_cobranca_id:   cobranca_id,
    p_mercearia_id:  mercearia_id,
    p_dias:          dias,
    p_forma:         forma,
    p_valor_pago:    Number.isFinite(valor_pago) ? valor_pago : null,
    p_evento:        evento || null,
    p_pagamento_ref: pagamento_ref || null,
    p_origem:        origem || null,
  });
  if (error) throw new Error(`licenca_aplicar_pagamento: ${error.message}`);
  return data || {};
}

async function estornarPagamento({ provedor, cobranca_id, evento, origem }) {
  const { data, error } = await db.rpc("licenca_estornar_pagamento", {
    p_provedor:    provedor,
    p_cobranca_id: cobranca_id,
    p_evento:      evento || null,
    p_origem:      origem || null,
  });
  if (error) throw new Error(`licenca_estornar_pagamento: ${error.message}`);
  return data || {};
}

// Quem pode consultar o status de uma cobrança: SuperAdmin, ou alguém do
// próprio estabelecimento dono dela.
async function podeVerCobranca(user, provedor, cobranca_id) {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (!user.mercearia_id) return false;
  const cob = await buscarCobranca(provedor, cobranca_id).catch(() => null);
  if (cob) return String(cob.mercearia_id) === String(user.mercearia_id);
  const campo = provedor === "efi" ? "efi_pix_txid" : "asaas_payment_id";
  const { data } = await db.from("mercearias").select("id").eq(campo, cobranca_id).maybeSingle();
  return !!data && String(data.id) === String(user.mercearia_id);
}

// Comparação de token sem vazar tempo. Token não configurado = recusa tudo.
function tokenConfere(recebido, esperado) {
  if (!esperado || typeof recebido !== "string" || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  buscarValorPlano,
  valorDoPlano,
  diasDoPlano,
  registrarCobranca,
  marcarCobrancaCancelada,
  buscarCobranca,
  aplicarPagamento,
  estornarPagamento,
  podeVerCobranca,
  tokenConfere,
};
