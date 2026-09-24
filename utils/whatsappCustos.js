// utils/whatsappCustos.js
// ============================================================
// WhatsApp (24/09/2026) — parâmetros de custo e cálculo do "pior caso".
// Fonte única das contas usadas pelo painel do SuperAdmin (planos,
// calculadora, simulador). O frontend tem um espelho em
// src/utils/whatsappCustos.js — manter os dois iguais.
//
// Ideia central (ver doc do Projeto claude/whatsapp-planos-2026-09-24.md):
//   - o comerciante tem um SALDO de créditos por mês e usa como quiser;
//   - cada tipo de pedido gasta um peso em créditos;
//   - as travas limitam envios/interpretações por pedido, então existe um
//     custo MÁXIMO por pedido → custo máximo por crédito;
//   - preço mínimo do plano = créditos × custo máx. por crédito
//     × margem de segurança ÷ (1 − impostos − taxa do gateway).
// ============================================================

const TIPOS_PEDIDO = ['consulta', 'pdf', 'cadastro', 'foto', 'alerta'];
const ACOES_TETO = ['pausar', 'modelo_barato', 'so_avisar'];

const PARAMS_PADRAO = Object.freeze({
  integracao: { ativo: false },
  meta: {
    preco_utilidade: 0.035,      // R$ por modelo de utilidade entregue (alertas, cobrança)
    preco_resposta: 0.035,       // R$ por resposta na janela de 24h (a partir de 01/10/2026)
    preco_marketing: 0.3217,     // só referência — nunca usamos marketing
    respostas_gratis_mes: 1000,  // franquia provável (no total do número central) — NÃO entra no preço mínimo
  },
  ia: {
    modelo: 'Gemini 2.5 Flash-Lite',
    usd_por_interpretacao: 0.001, // US$ por interpretação (~6.000 tokens de entrada + 400 de saída)
    usd_por_imagem: 0.004,        // US$ por leitura de foto
    dolar: 5.5,                   // R$ por US$ — atualizar
    iof_pct: 3.5,                 // IOF sobre cartão internacional — conferir
  },
  pesos: { consulta: 1, pdf: 1, cadastro: 2, foto: 4, alerta: 0.5 },
  travas: {
    envios:         { consulta: 2, pdf: 2, cadastro: 5, foto: 8, alerta: 1 },
    interpretacoes: { consulta: 2, pdf: 1, cadastro: 4, foto: 4, alerta: 0 },
    correcoes_max: 3,
    pedidos_por_minuto: 5,
    pedidos_por_dia: 200,
  },
  precificacao: { impostos_pct: 6, taxa_gateway_pct: 5, margem_seguranca: 1.3, margem_minima_pct: 20 },
  teto_loja: { aviso_pct: 50, acao_pct: 70, acao: 'pausar' },
  teto_global: { mensal_reais: 200 },
  custos_fixos: { chip_mensal: 0 },
  cobranca_auto: { ativo: false, dias_antes: [3, 1], dias_depois: [1, 3], lojas_desligadas: [] },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

function num(v, min, max, padrao) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}
function inteiro(v, min, max, padrao) {
  const n = num(v, min, max, NaN);
  return Number.isFinite(n) ? Math.round(n) : padrao;
}
function listaDias(v, padrao) {
  if (!Array.isArray(v)) return padrao;
  const dias = [...new Set(v.map(d => parseInt(d, 10)).filter(d => Number.isInteger(d) && d >= 0 && d <= 60))];
  return dias.sort((a, b) => b - a).slice(0, 10);
}

// Junta o que está salvo com os padrões e garante tipos/limites.
function normalizarParametros(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const p = clone(PARAMS_PADRAO);
  const g = (sec) => (e[sec] && typeof e[sec] === 'object' ? e[sec] : {});

  p.integracao.ativo = g('integracao').ativo === true;

  const m = g('meta');
  p.meta.preco_utilidade      = num(m.preco_utilidade, 0, 10, p.meta.preco_utilidade);
  p.meta.preco_resposta       = num(m.preco_resposta, 0, 10, p.meta.preco_resposta);
  p.meta.preco_marketing      = num(m.preco_marketing, 0, 10, p.meta.preco_marketing);
  p.meta.respostas_gratis_mes = inteiro(m.respostas_gratis_mes, 0, 1000000, p.meta.respostas_gratis_mes);

  const ia = g('ia');
  p.ia.modelo                = typeof ia.modelo === 'string' && ia.modelo.trim() ? ia.modelo.trim().slice(0, 80) : p.ia.modelo;
  p.ia.usd_por_interpretacao = num(ia.usd_por_interpretacao, 0, 5, p.ia.usd_por_interpretacao);
  p.ia.usd_por_imagem        = num(ia.usd_por_imagem, 0, 5, p.ia.usd_por_imagem);
  p.ia.dolar                 = num(ia.dolar, 0.5, 100, p.ia.dolar);
  p.ia.iof_pct               = num(ia.iof_pct, 0, 50, p.ia.iof_pct);

  const pe = g('pesos');
  TIPOS_PEDIDO.forEach(t => { p.pesos[t] = num(pe[t], 0.1, 100, p.pesos[t]); });

  const tr = g('travas');
  const env = tr.envios && typeof tr.envios === 'object' ? tr.envios : {};
  const itp = tr.interpretacoes && typeof tr.interpretacoes === 'object' ? tr.interpretacoes : {};
  TIPOS_PEDIDO.forEach(t => {
    p.travas.envios[t]         = inteiro(env[t], 1, 50, p.travas.envios[t]);
    p.travas.interpretacoes[t] = inteiro(itp[t], 0, 50, p.travas.interpretacoes[t]);
  });
  p.travas.correcoes_max      = inteiro(tr.correcoes_max, 0, 10, p.travas.correcoes_max);
  p.travas.pedidos_por_minuto = inteiro(tr.pedidos_por_minuto, 1, 60, p.travas.pedidos_por_minuto);
  p.travas.pedidos_por_dia    = inteiro(tr.pedidos_por_dia, 1, 5000, p.travas.pedidos_por_dia);

  const pr = g('precificacao');
  p.precificacao.impostos_pct      = num(pr.impostos_pct, 0, 60, p.precificacao.impostos_pct);
  p.precificacao.taxa_gateway_pct  = num(pr.taxa_gateway_pct, 0, 30, p.precificacao.taxa_gateway_pct);
  p.precificacao.margem_seguranca  = num(pr.margem_seguranca, 1, 5, p.precificacao.margem_seguranca);
  p.precificacao.margem_minima_pct = num(pr.margem_minima_pct, 0, 90, p.precificacao.margem_minima_pct);
  if (p.precificacao.impostos_pct + p.precificacao.taxa_gateway_pct >= 90) {
    p.precificacao.taxa_gateway_pct = Math.max(0, 89 - p.precificacao.impostos_pct);
  }

  const tl = g('teto_loja');
  p.teto_loja.aviso_pct = inteiro(tl.aviso_pct, 1, 100, p.teto_loja.aviso_pct);
  p.teto_loja.acao_pct  = inteiro(tl.acao_pct, 1, 100, p.teto_loja.acao_pct);
  if (p.teto_loja.aviso_pct > p.teto_loja.acao_pct) p.teto_loja.aviso_pct = p.teto_loja.acao_pct;
  p.teto_loja.acao      = ACOES_TETO.includes(tl.acao) ? tl.acao : p.teto_loja.acao;

  p.teto_global.mensal_reais = num(g('teto_global').mensal_reais, 0, 1000000, p.teto_global.mensal_reais);
  p.custos_fixos.chip_mensal = num(g('custos_fixos').chip_mensal, 0, 10000, p.custos_fixos.chip_mensal);

  const cb = g('cobranca_auto');
  p.cobranca_auto.ativo       = cb.ativo === true;
  p.cobranca_auto.dias_antes  = listaDias(cb.dias_antes, p.cobranca_auto.dias_antes);
  p.cobranca_auto.dias_depois = listaDias(cb.dias_depois, p.cobranca_auto.dias_depois);
  p.cobranca_auto.lojas_desligadas = Array.isArray(cb.lojas_desligadas)
    ? [...new Set(cb.lojas_desligadas.filter(id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 5000)
    : [];

  return p;
}

// Custo em R$ de algo cobrado em dólar pelo provedor de IA (com IOF)
function iaEmReais(usd, p) {
  return usd * p.ia.dolar * (1 + p.ia.iof_pct / 100);
}

// Pior caso de cada tipo de pedido (tudo que as travas permitem)
function piorCasoPorPedido(p) {
  const interp = iaEmReais(p.ia.usd_por_interpretacao, p);
  const imagem = iaEmReais(p.ia.usd_por_imagem, p);
  const out = {};
  TIPOS_PEDIDO.forEach(t => {
    const precoEnvio = t === 'alerta' ? p.meta.preco_utilidade : p.meta.preco_resposta;
    const meta = p.travas.envios[t] * precoEnvio;
    const ia = p.travas.interpretacoes[t] * interp + (t === 'foto' ? imagem : 0);
    const total = meta + ia;
    out[t] = { meta, ia, total, peso: p.pesos[t], por_credito: total / p.pesos[t] };
  });
  return out;
}

// Recursos do plano → tipos de pedido que ele permite (sem recurso marcado = todos)
const RECURSO_PARA_TIPO = { alertas: 'alerta', consultas: 'consulta', pdf: 'pdf', cadastro: 'cadastro', foto: 'foto' };
function tiposDoPlano(recursos) {
  const r = recursos && typeof recursos === 'object' ? recursos : {};
  const tipos = Object.keys(RECURSO_PARA_TIPO).filter(k => r[k] === true).map(k => RECURSO_PARA_TIPO[k]);
  return tipos.length ? tipos : TIPOS_PEDIDO;
}

function custoMaxPorCredito(p, tipos = TIPOS_PEDIDO) {
  const pc = piorCasoPorPedido(p);
  return Math.max(...tipos.map(t => pc[t].por_credito));
}

// Números de um plano: custo no pior caso, preço mínimo e margem
function calcularPlano(plano, p) {
  const creditos = Number(plano.creditos) || 0;
  const preco = Number(plano.preco) || 0;
  const cmc = custoMaxPorCredito(p, tiposDoPlano(plano.recursos));
  const pctDescontos = (p.precificacao.impostos_pct + p.precificacao.taxa_gateway_pct) / 100;
  const custo_pior = creditos * cmc;
  const preco_minimo = (custo_pior * p.precificacao.margem_seguranca) / (1 - pctDescontos);
  const descontos = preco * pctDescontos;
  const margem = preco - custo_pior - descontos;
  const margem_pct = preco > 0 ? (margem / preco) * 100 : 0;
  let situacao = 'ok';
  if (preco + 0.005 < preco_minimo) situacao = 'abaixo_minimo';
  else if (margem_pct < p.precificacao.margem_minima_pct) situacao = 'margem_baixa';
  return {
    custo_max_credito: arred(cmc, 4),
    custo_pior: arred(custo_pior),
    preco_minimo: arred(preco_minimo),
    impostos_taxas: arred(descontos),
    margem: arred(margem),
    margem_pct: arred(margem_pct, 1),
    situacao,
  };
}

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) || 0) * f) / f;
}

// Simulador: "e se a Meta subir X%" / "e se o dólar for R$ Y"
function simular(p, { meta_pct = 0, dolar = null, usd_interp = null } = {}) {
  const s = clone(p);
  const f = 1 + (Number(meta_pct) || 0) / 100;
  s.meta.preco_utilidade *= f;
  s.meta.preco_resposta *= f;
  if (dolar != null && Number(dolar) > 0) s.ia.dolar = Number(dolar);
  if (usd_interp != null && Number(usd_interp) >= 0) s.ia.usd_por_interpretacao = Number(usd_interp);
  return s;
}

module.exports = {
  TIPOS_PEDIDO, ACOES_TETO, PARAMS_PADRAO,
  normalizarParametros, iaEmReais, piorCasoPorPedido, custoMaxPorCredito, tiposDoPlano, calcularPlano, simular, arred,
};
