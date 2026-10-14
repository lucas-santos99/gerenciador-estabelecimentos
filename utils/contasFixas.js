// ============================================================
// contasFixas.js — contas a pagar que se repetem todo mês (SQL 39)
//
// A "conta fixa" é o modelo (descrição, valor, dia do vencimento, modo de pagamento).
// Todo mês ela gera UMA conta a pagar (contas_a_pagar.conta_fixa_id + competencia), 10 dias
// antes do vencimento. Se o dono pediu para "lembrar de conferir o valor", a conta nasce com
// valor_confirmado = false: aparece na tela e nas notificações até ele confirmar/atualizar.
//
// Pagamento: 'manual' (só lembra) · 'no_vencimento' · 'antes' (X dias antes). Os automáticos
// apenas REGISTRAM a conta como paga (o sistema não move dinheiro) e só quando o valor está
// confirmado. Conta cujo pagamento foi desfeito nunca é paga automaticamente de novo.
// Roda: ao abrir a lista de contas (no máximo a cada 5 min por loja) e em um agendador de 6 h.
// Se o SQL 39 não foi aplicado, não faz nada e não incomoda o log.
// ============================================================
const db = require('../db/supabaseAdmin');
const { buscarTimezone, hojeStrTZ } = require('./fusoHorario');

const ANTECEDENCIA_GERACAO = 10; // dias antes do vencimento em que a conta do mês aparece
const TOLERANCIA_AUTOMATICO = 5; // não paga sozinho conta vencida há mais que isso

const semTabela = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === '42703' || e.code === 'PGRST204');

const pad = (n) => String(n).padStart(2, '0');
const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // mes 1-12
function vencimentoDoMes(ano, mes, dia) { return `${ano}-${pad(mes)}-${pad(Math.min(Number(dia), ultimoDia(ano, mes)))}`; }
function somarDias(dataStr, dias) {
  const [a, m, d] = String(dataStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}
function diasEntre(deStr, ateStr) {
  const t = (s) => { const [a, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((t(ateStr) - t(deStr)) / 86400000);
}
const primeiroDoMes = (dataStr) => `${String(dataStr).slice(0, 7)}-01`;

// Vencimentos candidatos de uma conta fixa: o do mês de "hoje" e o do mês seguinte.
function candidatos(dia, hojeStr) {
  let [a, m] = hojeStr.split('-').map(Number);
  const lista = [vencimentoDoMes(a, m, dia)];
  m += 1; if (m > 12) { m = 1; a += 1; }
  lista.push(vencimentoDoMes(a, m, dia));
  return lista;
}

// Cria as contas do mês que ainda não existem. `imediato`: cria já a primeira (cadastro novo).
async function gerarContas(fixas, hojeStr, { imediato = false } = {}) {
  let criadas = 0;
  for (const f of fixas) {
    for (const venc of candidatos(f.dia_vencimento, hojeStr)) {
      if (venc < hojeStr) continue;                                  // não faz "retroativo"
      if (!imediato && diasEntre(hojeStr, venc) > ANTECEDENCIA_GERACAO) continue;
      const { error } = await db.from('contas_a_pagar').insert({
        mercearia_id: f.mercearia_id, descricao: f.descricao, valor: f.valor,
        data_vencimento: venc, status: 'pendente',
        conta_fixa_id: f.id, competencia: primeiroDoMes(venc),
        valor_confirmado: !f.lembrar_valor,
        criado_por_nome: 'Conta fixa (automático)',
      });
      if (!error) criadas += 1;
      else if (error.code !== '23505' && !semTabela(error)) console.error('[CONTAS FIXAS] gerar:', error.message);
      if (imediato) break;                                           // só a primeira
    }
  }
  return criadas;
}

// Marca como paga (registro) as contas fixas de pagamento automático que chegaram no dia.
async function pagarAutomaticas(fixas, mid, hojeStr) {
  const auto = new Map(fixas.filter(f => f.pagamento !== 'manual').map(f => [f.id, f]));
  if (!auto.size) return 0;
  const { data: contas, error } = await db.from('contas_a_pagar')
    .select('id, descricao, valor, data_vencimento, conta_fixa_id')
    .eq('mercearia_id', mid).eq('status', 'pendente').eq('valor_confirmado', true)
    .is('pagamento_desfeito_em', null)
    .in('conta_fixa_id', [...auto.keys()]).limit(200);
  if (error) { if (!semTabela(error)) console.error('[CONTAS FIXAS] buscar:', error.message); return 0; }
  const { registrar } = require('../routes/auditoriaRoutes');
  let pagas = 0;
  for (const c of contas || []) {
    const f = auto.get(c.conta_fixa_id);
    const gatilho = somarDias(c.data_vencimento, f.pagamento === 'antes' ? -f.dias_antes : 0);
    if (hojeStr < gatilho || diasEntre(c.data_vencimento, hojeStr) > TOLERANCIA_AUTOMATICO) continue;
    const { data, error: e2 } = await db.from('contas_a_pagar')
      .update({ status: 'paga', data_pagamento: hojeStr, pago_automaticamente: true, atualizado_em: new Date().toISOString(), atualizado_por_nome: 'Pagamento automático' })
      .eq('id', c.id).eq('status', 'pendente').select('id').maybeSingle();
    if (e2 || !data) continue;
    pagas += 1;
    registrar({
      mercearia_id: mid, operador_id: null, usuario_nome: 'Pagamento automático', usuario_email: null,
      modulo: 'financeiro', acao: 'conta_paga_automatica',
      descricao: `Conta fixa registrada como paga automaticamente — "${c.descricao}" (${parseFloat(c.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, vence ${c.data_vencimento})`,
      meta: { conta_id: c.id, conta_fixa_id: c.conta_fixa_id, valor: c.valor },
    });
  }
  return pagas;
}

async function fixasAtivas(mid) {
  let q = db.from('contas_fixas').select('*').eq('ativa', true).limit(1000);
  if (mid) q = q.eq('mercearia_id', mid);
  const { data, error } = await q;
  if (error) { if (!semTabela(error)) console.error('[CONTAS FIXAS] listar:', error.message); return []; }
  return data || [];
}

async function processarLoja(mid) {
  const fixas = await fixasAtivas(mid);
  if (!fixas.length) return { criadas: 0, pagas: 0 };
  const hojeStr = hojeStrTZ(await buscarTimezone(mid));
  const criadas = await gerarContas(fixas, hojeStr);
  const pagas = await pagarAutomaticas(fixas, mid, hojeStr);
  return { criadas, pagas };
}

const ultimaRodada = new Map();
// Versão "preguiçosa" (chamada ao abrir a lista): no máximo a cada 5 min por loja, nunca derruba a rota.
async function processarLojaSePreciso(mid) {
  const agora = Date.now();
  if (agora - (ultimaRodada.get(mid) || 0) < 5 * 60 * 1000) return;
  ultimaRodada.set(mid, agora);
  try { await processarLoja(mid); } catch (e) { console.error('[CONTAS FIXAS]', e.message); }
}

// Depois de criar/editar/confirmar: processa já (ignora o intervalo de 5 min) e nunca derruba a rota.
async function processarAgora(mid) {
  ultimaRodada.set(mid, Date.now());
  try { await processarLoja(mid); } catch (e) { console.error('[CONTAS FIXAS]', e.message); }
}

async function processarTodas() {
  const fixas = await fixasAtivas(null);
  const lojas = [...new Set(fixas.map(f => f.mercearia_id))];
  let criadas = 0, pagas = 0;
  for (const mid of lojas) {
    try { const r = await processarLoja(mid); criadas += r.criadas; pagas += r.pagas; ultimaRodada.set(mid, Date.now()); }
    catch (e) { console.error('[CONTAS FIXAS]', mid, e.message); }
  }
  if (criadas || pagas) console.log(`[CONTAS FIXAS] ${criadas} conta(s) gerada(s), ${pagas} paga(s) automaticamente`);
}

function agendar() {
  const rodar = () => processarTodas().catch(e => console.error('[CONTAS FIXAS]', e.message));
  setTimeout(rodar, 90 * 1000).unref();
  setInterval(rodar, 6 * 60 * 60 * 1000).unref();
}

module.exports = { gerarContas, processarLoja, processarLojaSePreciso, processarAgora, processarTodas, agendar, vencimentoDoMes, primeiroDoMes };
