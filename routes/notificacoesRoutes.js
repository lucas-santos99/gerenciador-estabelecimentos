// routes/notificacoesRoutes.js
// ============================================================
// CENTRAL DE NOTIFICAÇÕES (23/09/2026) — comerciante/operador e SuperAdmin
//
// Os avisos automáticos NÃO são gravados em tabela: são calculados na hora
// a partir do que já existe (clientes, contas_a_pagar, compras, produtos,
// mercearias, comunicados, solicitações, auditoria). Só três coisas ficam
// guardadas (SQL 10):
//   - lembretes           → criados pelo usuário (loja ou SuperAdmin)
//   - notif_preferencias  → o que cada usuário quer receber, antecedência,
//                           frequência, resumo ao entrar
//   - notif_estado        → lido / adiado / "não mostrar mais", por aviso
//
// Cada aviso tem uma CHAVE estável (ex.: "fiado:<cliente>:<vencimento>").
// Se o fato muda (novo vencimento, estoque passou de baixo pra zerado,
// próxima ocorrência de um lembrete), a chave muda e o aviso volta como
// novo. A frequência escolhida decide por quanto tempo um "lido" vale:
//   sempre   → até o próximo login (sessão)
//   diaria   → até o fim do dia (fuso da loja)
//   horas    → por N horas
//   uma_vez  → pra sempre (enquanto a chave for a mesma)
//
// Rotas (montadas em /api/notificacoes, todas com authUser):
//   GET    /                      → avisos + contagem + preferências
//   GET    /preferencias          → preferências + catálogo de categorias
//   PUT    /preferencias
//   POST   /estado                → { chaves[], acao: lida|nao_lida|adiar|dispensar|restaurar, minutos? }
//   GET    /lembretes             → ?status=pendentes|concluidos|todos
//   POST   /lembretes
//   PUT    /lembretes/:id
//   DELETE /lembretes/:id
//   POST   /lembretes/:id/concluir
//   POST   /lembretes/:id/reabrir
// ============================================================

const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
const { TIMEZONE_PADRAO, buscarTimezone, hojeStrTZ, inicioDiaTZ } = require('../utils/fusoHorario');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');

router.use(authUser);

/* ── Catálogo de categorias ────────────────────────────────── */
// padrao = valores de fábrica das preferências de cada categoria.
//   antecedencia_dias: quantos dias antes do vencimento começa a avisar
//     (nas categorias do SuperAdmin "pagamentos"/"cadastros" é a janela
//     de "últimos N dias").
const CATEGORIAS_ESTAB = [
  { id: 'fiado',        label: 'Fiado dos clientes',  icone: '📋', descricao: 'Clientes com o fiado vencendo ou vencido.',
    padrao: { ativo: true, antecedencia_dias: 3, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true } },
  { id: 'contas',       label: 'Contas a pagar',      icone: '💸', descricao: 'Contas lançadas no Financeiro vencendo ou vencidas.',
    padrao: { ativo: true, antecedencia_dias: 3, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true } },
  { id: 'fornecedores', label: 'Pagar fornecedores',  icone: '🚚', descricao: 'Compras de fornecedor a prazo chegando na data de pagar.',
    padrao: { ativo: true, antecedencia_dias: 3, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true } },
  { id: 'estoque',      label: 'Estoque',             icone: '📦', descricao: 'Produtos e variações zerados ou abaixo do estoque mínimo.',
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true, nivel_estoque: 'baixo' } },
  { id: 'assinatura',   label: 'Assinatura do sistema', icone: '🔑', descricao: 'Vencimento da licença do sistema.', somenteDono: true,
    padrao: { ativo: true, antecedencia_dias: 7, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true } },
  { id: 'comunicados',  label: 'Comunicados',         icone: '📣', descricao: 'Avisos enviados pela equipe do sistema.',
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'uma_vez', intervalo_horas: 4, no_resumo: false } },
  { id: 'sistema',      label: 'Solicitações',        icone: '🛎️', descricao: 'Respostas às suas solicitações de alteração de dados.', somenteDono: true,
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'uma_vez', intervalo_horas: 4, no_resumo: false } },
  { id: 'lembretes',    label: 'Lembretes',           icone: '⏰', descricao: 'Lembretes criados por você ou pra toda a loja.',
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'sempre', intervalo_horas: 4, no_resumo: true } },
];

const CATEGORIAS_ADMIN = [
  { id: 'licencas',     label: 'Licenças',            icone: '🔑', descricao: 'Estabelecimentos com a assinatura vencendo, vencida ou bloqueada.',
    padrao: { ativo: true, antecedencia_dias: 7, frequencia: 'diaria', intervalo_horas: 4, no_resumo: true } },
  { id: 'pagamentos',   label: 'Pagamentos recebidos', icone: '💰', descricao: 'Renovações pagas via Pix (Efí) ou cartão (Asaas).',
    padrao: { ativo: true, antecedencia_dias: 7, frequencia: 'uma_vez', intervalo_horas: 4, no_resumo: true } },
  { id: 'solicitacoes', label: 'Solicitações',        icone: '✉️', descricao: 'Solicitações de alteração esperando resposta.',
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'sempre', intervalo_horas: 4, no_resumo: true } },
  { id: 'cadastros',    label: 'Novos cadastros',     icone: '🏪', descricao: 'Estabelecimentos cadastrados recentemente.',
    padrao: { ativo: true, antecedencia_dias: 7, frequencia: 'uma_vez', intervalo_horas: 4, no_resumo: false } },
  { id: 'lembretes',    label: 'Lembretes',           icone: '⏰', descricao: 'Lembretes seus ou de toda a equipe do SuperAdmin.',
    padrao: { ativo: true, antecedencia_dias: 0, frequencia: 'sempre', intervalo_horas: 4, no_resumo: true } },
];

const FREQUENCIAS   = ['sempre', 'diaria', 'horas', 'uma_vez'];
const NIVEIS_ESTOQUE = ['baixo', 'zerado'];
const PREFS_GERAIS_PADRAO = { resumo_login: true, som: false };

const ehAdmin = (u) => u?.role === 'super_admin';
const ehDono  = (u) => u?.role === 'merchant';

function catalogoDo(user) {
  return ehAdmin(user) ? CATEGORIAS_ADMIN : CATEGORIAS_ESTAB;
}

// Operador só recebe avisos dos módulos que ele acessa.
function podeVerCategoria(user, cat) {
  if (ehAdmin(user)) return true;
  const def = CATEGORIAS_ESTAB.find(c => c.id === cat);
  if (!def) return false;
  if (ehDono(user)) return true;
  if (def.somenteDono) return false;
  const p = user.permissoes || [];
  switch (cat) {
    case 'fiado':        return p.includes('clientes');
    case 'contas':       return p.includes('financeiro') || p.includes('financeiro_contas_pagar');
    case 'fornecedores': return p.includes('fornecedores') || p.includes('financeiro') || p.includes('financeiro_contas_pagar');
    case 'estoque':      return p.includes('estoque');
    default:             return true; // comunicados, lembretes
  }
}

/* ── Utilidades ────────────────────────────────────────────── */
const brl = (v) => parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function diasEntre(deStr, ateStr) {
  return Math.round((Date.parse(`${ateStr}T12:00:00Z`) - Date.parse(`${deStr}T12:00:00Z`)) / 86400000);
}
function somarDias(dataStr, n) {
  const d = new Date(`${dataStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dataStrTZ(instante, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(instante));
}
function fmtData(dataStr) {
  if (!dataStr) return '';
  const [a, m, d] = String(dataStr).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
function textoPrazo(dias) {
  if (dias < 0)  return dias === -1 ? 'venceu ontem' : `venceu há ${-dias} dias`;
  if (dias === 0) return 'vence hoje';
  if (dias === 1) return 'vence amanhã';
  return `vence em ${dias} dias`;
}
function grupoPorDias(dias) {
  if (dias < 0)  return 'atrasado';
  if (dias === 0) return 'hoje';
  return 'proximo';
}
function prioridadePorDias(dias) {
  if (dias < 0)  return 'critica';
  if (dias === 0) return 'alta';
  if (dias <= 2) return 'media';
  return 'baixa';
}

/* ── Preferências ──────────────────────────────────────────── */
function mesclarPreferencias(user, salvas) {
  const s = salvas && typeof salvas === 'object' ? salvas : {};
  const categorias = {};
  for (const c of catalogoDo(user)) {
    categorias[c.id] = { ...c.padrao, ...((s.categorias || {})[c.id] || {}) };
  }
  return {
    resumo_login: typeof s.resumo_login === 'boolean' ? s.resumo_login : PREFS_GERAIS_PADRAO.resumo_login,
    som:          typeof s.som === 'boolean' ? s.som : PREFS_GERAIS_PADRAO.som,
    categorias,
  };
}

async function carregarPreferencias(user) {
  const { data } = await db.from('notif_preferencias').select('prefs').eq('user_id', user.id).maybeSingle();
  return mesclarPreferencias(user, data?.prefs);
}

// Aceita só campos conhecidos e dentro dos limites — o resto é descartado.
function sanitizarPreferencias(user, entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const saida = { categorias: {} };
  if (typeof e.resumo_login === 'boolean') saida.resumo_login = e.resumo_login;
  if (typeof e.som === 'boolean') saida.som = e.som;
  for (const c of catalogoDo(user)) {
    const v = (e.categorias || {})[c.id];
    if (!v || typeof v !== 'object') continue;
    const o = {};
    if (typeof v.ativo === 'boolean') o.ativo = v.ativo;
    if (typeof v.no_resumo === 'boolean') o.no_resumo = v.no_resumo;
    if (Number.isInteger(v.antecedencia_dias) && v.antecedencia_dias >= 0 && v.antecedencia_dias <= 60) o.antecedencia_dias = v.antecedencia_dias;
    if (FREQUENCIAS.includes(v.frequencia)) o.frequencia = v.frequencia;
    if (Number.isInteger(v.intervalo_horas) && v.intervalo_horas >= 1 && v.intervalo_horas <= 24) o.intervalo_horas = v.intervalo_horas;
    if (c.id === 'estoque' && NIVEIS_ESTOQUE.includes(v.nivel_estoque)) o.nivel_estoque = v.nivel_estoque;
    saida.categorias[c.id] = o;
  }
  return saida;
}

/* ── Estado (lido / adiado / dispensado) ───────────────────── */
function lidaAindaVale(estado, pref, { sessaoInicio, hojeStr, tz, agora }) {
  if (!estado?.lida_em) return false;
  const lidaMs = Date.parse(estado.lida_em);
  switch (pref.frequencia) {
    case 'uma_vez': return true;
    case 'diaria':  return dataStrTZ(estado.lida_em, tz) === hojeStr;
    case 'horas':   return agora - lidaMs < (pref.intervalo_horas || 4) * 3600000;
    case 'sempre':
    default:        return !!sessaoInicio && lidaMs >= Date.parse(sessaoInicio);
  }
}

/* ── Visibilidade de lembretes ─────────────────────────────── */
function consultaLembretesVisiveis(user) {
  let q = db.from('lembretes').select('*');
  if (ehAdmin(user)) q = q.eq('escopo', 'admin');
  else q = q.eq('escopo', 'estab').eq('mercearia_id', user.mercearia_id);
  return q.or(`visibilidade.eq.todos,criado_por.eq.${user.id}`);
}

function podeEditarLembrete(user, l) {
  if (!l) return false;
  if (l.criado_por === user.id) return true;
  if (l.visibilidade !== 'todos') return false;
  if (ehAdmin(user)) return l.escopo === 'admin';
  return ehDono(user) && l.escopo === 'estab' && l.mercearia_id === user.mercearia_id;
}

function momentoAlerta(l) {
  return Date.parse(l.data_hora) - (l.antecedencia_min || 0) * 60000;
}

function proximaOcorrencia(dataIso, recorrencia, depoisDe) {
  const d = new Date(dataIso);
  const limite = depoisDe.getTime();
  let guarda = 0;
  while (d.getTime() <= limite && guarda++ < 5000) {
    if (recorrencia === 'diaria')       d.setUTCDate(d.getUTCDate() + 1);
    else if (recorrencia === 'semanal') d.setUTCDate(d.getUTCDate() + 7);
    else if (recorrencia === 'mensal') {
      const dia = d.getUTCDate();
      d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
      const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(dia, ultimo));
    }
    else if (recorrencia === 'anual')   d.setUTCFullYear(d.getUTCFullYear() + 1);
    else break;
  }
  return d.toISOString();
}

function itemDeLembrete(l, { agora, hojeStr, tz }) {
  const inicio = momentoAlerta(l);
  if (inicio > agora) return null; // ainda não chegou a hora de avisar
  const quando = Date.parse(l.data_hora);
  const diaStr = dataStrTZ(l.data_hora, tz);
  let grupo;
  if (l.dia_inteiro) grupo = diaStr < hojeStr ? 'atrasado' : diaStr === hojeStr ? 'hoje' : 'proximo';
  else grupo = quando < agora ? 'atrasado' : diaStr === hojeStr ? 'hoje' : 'proximo';
  const prioridade = l.prioridade === 'alta' ? (grupo === 'atrasado' ? 'critica' : 'alta')
    : l.prioridade === 'baixa' ? 'baixa' : (grupo === 'atrasado' ? 'alta' : 'media');
  return {
    chave: `lembrete:${l.id}:${new Date(l.data_hora).toISOString()}`,
    categoria: 'lembretes',
    tipo: 'lembrete',
    titulo: l.titulo,
    descricao: l.descricao || '',
    grupo,
    prioridade,
    data_ref: l.data_hora,
    dia_inteiro: !!l.dia_inteiro,
    meta: {
      lembrete_id: l.id, recorrencia: l.recorrencia, categoria: l.categoria || null,
      visibilidade: l.visibilidade, criado_por_nome: l.criado_por_nome || null,
    },
    acao: { tipo: 'lembrete', lembrete_id: l.id },
  };
}

/* ════════════════════════════════════════════════════════════
   GERAÇÃO DOS AVISOS — estabelecimento
   ════════════════════════════════════════════════════════════ */
async function avisosEstabelecimento(user, prefs, ctx) {
  const mid = user.mercearia_id;
  const { hojeStr, agora } = ctx;
  const ativa = (cat) => prefs.categorias[cat]?.ativo && podeVerCategoria(user, cat);
  const limiteVenc = (cat) => somarDias(hojeStr, prefs.categorias[cat]?.antecedencia_dias ?? 3);
  const itens = [];
  const tarefas = [];

  // Dados da loja: fiado ativo, licença, tipo (comunicados)
  const { data: loja } = await db.from('mercearias')
    .select('fiado_ativo, status_assinatura, data_vencimento, tipo_estabelecimento')
    .eq('id', mid).maybeSingle();

  // 1) Fiado vencendo/vencido
  if (ativa('fiado') && loja?.fiado_ativo !== false) {
    tarefas.push((async () => {
      const { data } = await db.from('clientes')
        .select('id, nome, telefone, saldo_devedor, data_vencimento')
        .eq('mercearia_id', mid)
        .gt('saldo_devedor', 0.009)
        .not('data_vencimento', 'is', null)
        .lte('data_vencimento', limiteVenc('fiado'))
        .order('data_vencimento', { ascending: true })
        .limit(300);
      (data || []).forEach(c => {
        const dias = diasEntre(hojeStr, c.data_vencimento);
        itens.push({
          chave: `fiado:${c.id}:${c.data_vencimento}`,
          categoria: 'fiado', tipo: 'fiado_vencimento',
          titulo: `Fiado de ${c.nome} ${textoPrazo(dias)}`,
          descricao: `Dívida de ${brl(c.saldo_devedor)} · vencimento ${fmtData(c.data_vencimento)}${c.telefone ? ` · ${c.telefone}` : ''}`,
          grupo: grupoPorDias(dias), prioridade: prioridadePorDias(dias),
          data_ref: c.data_vencimento, valor: Math.round(parseFloat(c.saldo_devedor) * 100) / 100,
          meta: { cliente_id: c.id, cliente_nome: c.nome, telefone: c.telefone || null, dias },
          acao: { tipo: 'aba', aba: 'clientes', cliente_id: c.id },
        });
      });
    })());
  }

  // 2) Contas a pagar + 3) fornecedores (contas geradas por compra a prazo)
  if (ativa('contas') || ativa('fornecedores')) {
    tarefas.push((async () => {
      const maiorAntecedencia = Math.max(
        ativa('contas') ? prefs.categorias.contas.antecedencia_dias : 0,
        ativa('fornecedores') ? prefs.categorias.fornecedores.antecedencia_dias : 0,
      );
      const { data: contas } = await db.from('contas_a_pagar')
        .select('id, descricao, valor, data_vencimento, status')
        .eq('mercearia_id', mid)
        .neq('status', 'paga')
        .not('data_vencimento', 'is', null)
        .lte('data_vencimento', somarDias(hojeStr, maiorAntecedencia))
        .order('data_vencimento', { ascending: true })
        .limit(300);
      if (!contas?.length) return;

      const { data: compras } = await db.from('compras')
        .select('conta_a_pagar_id, fornecedor_id, numero_nota, status')
        .eq('mercearia_id', mid)
        .in('conta_a_pagar_id', contas.map(c => c.id));
      // Mesmo critério do Financeiro (financeiroRoutes GET /): conta ligada a
      // uma compra é "de fornecedor" e aparece no módulo Fornecedores.
      const compraPorConta = {};
      (compras || []).forEach(c => {
        const atual = compraPorConta[c.conta_a_pagar_id];
        if (!atual || atual.status === 'cancelada') compraPorConta[c.conta_a_pagar_id] = c;
      });
      const idsForn = [...new Set(Object.values(compraPorConta).map(c => c.fornecedor_id).filter(Boolean))];
      let nomeForn = {};
      if (idsForn.length) {
        const { data: forns } = await db.from('fornecedores').select('id, nome').eq('mercearia_id', mid).in('id', idsForn);
        (forns || []).forEach(f => { nomeForn[f.id] = f.nome; });
      }

      contas.forEach(c => {
        const compra = compraPorConta[c.id];
        const cat = compra ? 'fornecedores' : 'contas';
        if (!ativa(cat)) return;
        if (c.data_vencimento > limiteVenc(cat)) return;
        const dias = diasEntre(hojeStr, c.data_vencimento);
        const fornecedor = compra ? (nomeForn[compra.fornecedor_id] || 'fornecedor') : null;
        itens.push({
          chave: `${cat === 'fornecedores' ? 'fornecedor' : 'conta'}:${c.id}:${c.data_vencimento}`,
          categoria: cat, tipo: cat === 'fornecedores' ? 'fornecedor_pagamento' : 'conta_vencimento',
          titulo: cat === 'fornecedores'
            ? `Pagar ${fornecedor} — ${textoPrazo(dias)}`
            : `Conta "${c.descricao || 'sem descrição'}" ${textoPrazo(dias)}`,
          descricao: `${brl(c.valor)} · vencimento ${fmtData(c.data_vencimento)}${compra?.numero_nota ? ` · nota ${compra.numero_nota}` : ''}${cat === 'fornecedores' && c.descricao ? ` · ${c.descricao}` : ''}`,
          grupo: grupoPorDias(dias), prioridade: prioridadePorDias(dias),
          data_ref: c.data_vencimento, valor: Math.round(parseFloat(c.valor) * 100) / 100,
          meta: { conta_id: c.id, fornecedor, dias },
          acao: cat === 'fornecedores'
            ? { tipo: 'aba', aba: 'fornecedores', sub: 'contas', conta_id: c.id, status: dias < 0 ? 'atrasada' : 'pendente' }
            : { tipo: 'aba', aba: 'financeiro', sub: 'contas', conta_id: c.id, status: dias < 0 ? 'atrasada' : 'pendente' },
        });
      });
    })());
  }

  // 4) Estoque zerado / baixo
  if (ativa('estoque')) {
    tarefas.push((async () => {
      const { data, error } = await db.rpc('notif_estoque_baixo', { p_mercearia_id: mid, p_limite: 300 });
      if (error) { console.error('[notificacoes] estoque:', error.message); return; }
      const soZerado = prefs.categorias.estoque.nivel_estoque === 'zerado';
      (data || []).forEach(p => {
        const zerado = parseFloat(p.estoque) <= 0;
        if (soZerado && !zerado) return;
        const un = p.unidade || 'un';
        const qtd = un === 'kg'
          ? `${parseFloat(p.estoque).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`
          : `${parseFloat(p.estoque).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} un`;
        const nome = p.detalhe ? `${p.nome} (${p.detalhe})` : p.nome;
        itens.push({
          chave: `estoque:${p.variacao_id || p.produto_id}:${zerado ? 'zerado' : 'baixo'}`,
          categoria: 'estoque', tipo: zerado ? 'estoque_zerado' : 'estoque_baixo',
          titulo: zerado ? `${nome} está sem estoque` : `${nome} com estoque baixo`,
          descricao: zerado ? `Estoque: ${qtd}` : `Estoque: ${qtd} · mínimo ${parseFloat(p.minimo).toLocaleString('pt-BR')}`,
          grupo: 'info', prioridade: zerado ? 'alta' : 'media',
          data_ref: null,
          meta: { produto_id: p.produto_id, variacao_id: p.variacao_id || null },
          acao: { tipo: 'aba', aba: 'estoque', produto_id: p.produto_id },
        });
      });
    })());
  }

  // 5) Assinatura do sistema (só o dono)
  if (ativa('assinatura') && loja) {
    if (loja.status_assinatura === 'bloqueada') {
      itens.push({
        chave: `licenca:bloqueada:${loja.data_vencimento || ''}`,
        categoria: 'assinatura', tipo: 'licenca_bloqueada',
        titulo: 'Assinatura do sistema bloqueada', descricao: 'Renove pra continuar usando todas as funções.',
        grupo: 'atrasado', prioridade: 'critica', data_ref: loja.data_vencimento,
        meta: {}, acao: { tipo: 'renovar' },
      });
    } else if (loja.data_vencimento && loja.data_vencimento <= limiteVenc('assinatura')) {
      const dias = diasEntre(hojeStr, loja.data_vencimento);
      itens.push({
        chave: `licenca:${loja.data_vencimento}:${dias < 0 ? 'vencida' : 'aviso'}`,
        categoria: 'assinatura', tipo: 'licenca_vencimento',
        titulo: `Sua assinatura do sistema ${textoPrazo(dias)}`,
        descricao: `Vencimento ${fmtData(loja.data_vencimento)}. Dá pra renovar antecipado pelo botão "Renovar" no topo da tela.`,
        grupo: grupoPorDias(dias), prioridade: prioridadePorDias(dias), data_ref: loja.data_vencimento,
        meta: { dias }, acao: { tipo: 'renovar' },
      });
    }
  }

  // 6) Comunicados vigentes pra esta loja
  if (ativa('comunicados')) {
    tarefas.push((async () => {
      const { data: ativos } = await db.from('comunicados')
        .select('id, titulo, mensagem, criado_em, alvo_tipo, alvo_tipos_estabelecimento, data_inicio, data_fim')
        .eq('ativo', true).order('criado_em', { ascending: false }).limit(50);
      const vigentes = (ativos || []).filter(c =>
        (!c.data_inicio || Date.parse(c.data_inicio) <= agora) && (!c.data_fim || Date.parse(c.data_fim) >= agora));
      if (!vigentes.length) return;
      const idsEsp = vigentes.filter(c => c.alvo_tipo === 'especificos').map(c => c.id);
      let incluida = new Set();
      if (idsEsp.length) {
        const { data: v } = await db.from('comunicado_estabelecimentos').select('comunicado_id').eq('mercearia_id', mid).in('comunicado_id', idsEsp);
        incluida = new Set((v || []).map(x => x.comunicado_id));
      }
      vigentes.filter(c => c.alvo_tipo === 'especificos' ? incluida.has(c.id)
        : c.alvo_tipo === 'tipo_estabelecimento' ? (c.alvo_tipos_estabelecimento || []).includes(loja?.tipo_estabelecimento)
        : true)
        .forEach(c => {
          const msg = String(c.mensagem || '').replace(/\s+/g, ' ').trim();
          itens.push({
            chave: `comunicado:${c.id}`,
            categoria: 'comunicados', tipo: 'comunicado',
            titulo: c.titulo || 'Comunicado',
            descricao: msg.length > 400 ? `${msg.slice(0, 400)}…` : msg,
            grupo: 'info', prioridade: 'baixa', data_ref: c.criado_em,
            meta: { comunicado_id: c.id }, acao: null,
          });
        });
    })());
  }

  // 7) Respostas às solicitações de alteração (últimos 30 dias)
  if (ativa('sistema')) {
    tarefas.push((async () => {
      const desde = new Date(agora - 30 * 86400000).toISOString();
      const { data } = await db.from('solicitacoes_alteracao')
        .select('id, status, campos, resposta, atendido_em')
        .eq('mercearia_id', mid).in('status', ['atendida', 'recusada'])
        .gte('atendido_em', desde).order('atendido_em', { ascending: false }).limit(30);
      (data || []).forEach(s => {
        const campos = (Array.isArray(s.campos) ? s.campos : []).map(c => c.label).filter(Boolean).join(', ') || 'dados cadastrais';
        itens.push({
          chave: `solicitacao:${s.id}:${s.status}`,
          categoria: 'sistema', tipo: `solicitacao_${s.status}`,
          titulo: `Sua solicitação foi ${s.status === 'atendida' ? 'atendida' : 'recusada'}`,
          descricao: `Alteração de ${campos}${s.resposta ? ` · Resposta: ${s.resposta}` : ''}`,
          grupo: 'info', prioridade: s.status === 'recusada' ? 'media' : 'baixa', data_ref: s.atendido_em,
          meta: { solicitacao_id: s.id }, acao: null,
        });
      });
    })());
  }

  // 8) Lembretes
  if (ativa('lembretes')) {
    tarefas.push(avisosDeLembretes(user, ctx, itens));
  }

  await Promise.all(tarefas);
  return itens;
}

async function avisosDeLembretes(user, ctx, itens) {
  const { data } = await consultaLembretesVisiveis(user)
    .is('concluido_em', null)
    .order('data_hora', { ascending: true })
    .limit(500);
  let proximo = null;
  (data || []).forEach(l => {
    const it = itemDeLembrete(l, ctx);
    if (it) itens.push(it);
    else {
      const m = momentoAlerta(l);
      if (proximo === null || m < proximo) proximo = m;
    }
  });
  if (proximo !== null) ctx.proximosEventos.push(proximo);
}

/* ════════════════════════════════════════════════════════════
   GERAÇÃO DOS AVISOS — SuperAdmin
   ════════════════════════════════════════════════════════════ */
async function avisosAdmin(user, prefs, ctx) {
  const { hojeStr, agora } = ctx;
  const ativa = (cat) => !!prefs.categorias[cat]?.ativo;
  const ant = (cat) => prefs.categorias[cat]?.antecedencia_dias ?? 7;
  const itens = [];
  const tarefas = [];

  // 1) Licenças vencendo / vencidas / bloqueadas
  if (ativa('licencas')) {
    tarefas.push((async () => {
      const { data } = await db.from('mercearias')
        .select('id, nome_fantasia, status_assinatura, data_vencimento')
        .neq('status_assinatura', 'excluida')
        .or(`status_assinatura.eq.bloqueada,data_vencimento.lte.${somarDias(hojeStr, ant('licencas'))}`)
        .limit(500);
      (data || []).forEach(m => {
        const nome = m.nome_fantasia || 'Estabelecimento';
        if (m.status_assinatura === 'bloqueada') {
          itens.push({
            chave: `adm_licenca:${m.id}:bloqueada:${m.data_vencimento || ''}`,
            categoria: 'licencas', tipo: 'licenca_bloqueada',
            titulo: `${nome} está com a licença bloqueada`,
            descricao: m.data_vencimento ? `Venceu em ${fmtData(m.data_vencimento)}` : 'Sem data de vencimento',
            grupo: 'atrasado', prioridade: 'alta', data_ref: m.data_vencimento,
            meta: { mercearia_id: m.id }, acao: { tipo: 'rota', rota: `/admin/estabelecimentos/${m.id}?view=details` },
          });
          return;
        }
        if (!m.data_vencimento) return;
        const dias = diasEntre(hojeStr, m.data_vencimento);
        itens.push({
          chave: `adm_licenca:${m.id}:${m.data_vencimento}:${dias < 0 ? 'vencida' : 'aviso'}`,
          categoria: 'licencas', tipo: 'licenca_vencimento',
          titulo: `Licença de ${nome} ${textoPrazo(dias)}`,
          descricao: `Vencimento ${fmtData(m.data_vencimento)} · status: ${m.status_assinatura || '—'}`,
          grupo: grupoPorDias(dias), prioridade: prioridadePorDias(dias), data_ref: m.data_vencimento,
          meta: { mercearia_id: m.id, dias }, acao: { tipo: 'rota', rota: `/admin/estabelecimentos/${m.id}?view=details` },
        });
      });
    })());
  }

  // 2) Pagamentos recebidos (renovações automáticas)
  if (ativa('pagamentos')) {
    tarefas.push((async () => {
      const desde = new Date(agora - ant('pagamentos') * 86400000).toISOString();
      const { data } = await db.from('auditoria')
        .select('id, mercearia_id, acao, descricao, criado_em')
        .in('acao', ['licenca_renovada_cartao', 'licenca_renovada_pix'])
        .gte('criado_em', desde).order('criado_em', { ascending: false }).limit(100);
      if (!data?.length) return;
      const ids = [...new Set(data.map(a => a.mercearia_id).filter(Boolean))];
      const nomes = {};
      if (ids.length) {
        const { data: ms } = await db.from('mercearias').select('id, nome_fantasia').in('id', ids);
        (ms || []).forEach(m => { nomes[m.id] = m.nome_fantasia; });
      }
      data.forEach(a => {
        itens.push({
          chave: `adm_pagamento:${a.id}`,
          categoria: 'pagamentos', tipo: a.acao,
          titulo: `${nomes[a.mercearia_id] || 'Estabelecimento'} renovou a assinatura (${a.acao.endsWith('pix') ? 'Pix' : 'cartão'})`,
          descricao: a.descricao || '',
          grupo: 'info', prioridade: 'baixa', data_ref: a.criado_em,
          meta: { mercearia_id: a.mercearia_id },
          acao: a.mercearia_id ? { tipo: 'rota', rota: `/admin/estabelecimentos/${a.mercearia_id}?view=details` } : null,
        });
      });
    })());
  }

  // 3) Solicitações pendentes
  if (ativa('solicitacoes')) {
    tarefas.push((async () => {
      const { data } = await db.from('solicitacoes_alteracao')
        .select('id, nome_estabelecimento, solicitado_por_nome, campos, criado_em')
        .eq('status', 'pendente').order('criado_em', { ascending: true }).limit(100);
      (data || []).forEach(s => {
        const campos = (Array.isArray(s.campos) ? s.campos : []).map(c => c.label).filter(Boolean).join(', ') || 'dados cadastrais';
        const diasEsperando = diasEntre(dataStrTZ(s.criado_em, ctx.tz), hojeStr);
        itens.push({
          chave: `adm_solicitacao:${s.id}`,
          categoria: 'solicitacoes', tipo: 'solicitacao_pendente',
          titulo: `${s.nome_estabelecimento || 'Estabelecimento'} pediu alteração de ${campos}`,
          descricao: `${s.solicitado_por_nome ? `Por ${s.solicitado_por_nome} · ` : ''}esperando há ${diasEsperando <= 0 ? 'menos de 1 dia' : `${diasEsperando} dia${diasEsperando === 1 ? '' : 's'}`}`,
          grupo: diasEsperando >= 2 ? 'atrasado' : 'hoje', prioridade: diasEsperando >= 2 ? 'alta' : 'media',
          data_ref: s.criado_em, meta: { solicitacao_id: s.id }, acao: { tipo: 'rota', rota: '/admin/solicitacoes' },
        });
      });
    })());
  }

  // 4) Novos cadastros
  if (ativa('cadastros')) {
    tarefas.push((async () => {
      const desde = new Date(agora - ant('cadastros') * 86400000).toISOString();
      const { data } = await db.from('mercearias')
        .select('id, nome_fantasia, tipo_estabelecimento, created_at')
        .neq('status_assinatura', 'excluida').gte('created_at', desde)
        .order('created_at', { ascending: false }).limit(100);
      (data || []).forEach(m => {
        itens.push({
          chave: `adm_cadastro:${m.id}`,
          categoria: 'cadastros', tipo: 'novo_estabelecimento',
          titulo: `Novo estabelecimento: ${m.nome_fantasia || '—'}`,
          descricao: m.tipo_estabelecimento ? `Tipo: ${m.tipo_estabelecimento}` : '',
          grupo: 'info', prioridade: 'baixa', data_ref: m.created_at,
          meta: { mercearia_id: m.id }, acao: { tipo: 'rota', rota: `/admin/estabelecimentos/${m.id}?view=details` },
        });
      });
    })());
  }

  // 5) Lembretes do SuperAdmin
  if (ativa('lembretes')) tarefas.push(avisosDeLembretes(user, ctx, itens));

  await Promise.all(tarefas);
  return itens;
}

/* ════════════════════════════════════════════════════════════
   GET / — avisos do usuário logado
   ════════════════════════════════════════════════════════════ */
const ORDEM_GRUPO = { atrasado: 0, hoje: 1, proximo: 2, info: 3 };
const ORDEM_PRIORIDADE = { critica: 0, alta: 1, media: 2, baixa: 3 };

router.get('/', async (req, res) => {
  const user = req.user;
  if (!ehAdmin(user) && !user.mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const tz = ehAdmin(user) ? TIMEZONE_PADRAO : await buscarTimezone(user.mercearia_id);
    const agora = Date.now();
    const hojeStr = hojeStrTZ(tz);
    const sessaoInicio = typeof req.query.sessao_inicio === 'string' && !Number.isNaN(Date.parse(req.query.sessao_inicio))
      ? req.query.sessao_inicio : null;
    const ctx = { tz, agora, hojeStr, sessaoInicio, proximosEventos: [] };

    const prefs = await carregarPreferencias(user);
    const itens = ehAdmin(user) ? await avisosAdmin(user, prefs, ctx) : await avisosEstabelecimento(user, prefs, ctx);

    // Estado de cada aviso (lido/adiado/dispensado)
    const estados = {};
    if (itens.length) {
      const chaves = itens.map(i => i.chave);
      for (let i = 0; i < chaves.length; i += 300) {
        const { data } = await db.from('notif_estado')
          .select('chave, lida_em, adiada_ate, dispensada')
          .eq('user_id', user.id).in('chave', chaves.slice(i, i + 300));
        (data || []).forEach(e => { estados[e.chave] = e; });
      }
    }

    const catalogo = catalogoDo(user);
    const icone = Object.fromEntries(catalogo.map(c => [c.id, c.icone]));
    const saida = itens.map(it => {
      const e = estados[it.chave];
      const pref = prefs.categorias[it.categoria] || {};
      const adiada = !!(e?.adiada_ate && Date.parse(e.adiada_ate) > agora);
      if (adiada) ctx.proximosEventos.push(Date.parse(e.adiada_ate));
      return {
        ...it,
        icone: icone[it.categoria] || '🔔',
        lida: lidaAindaVale(e, pref, ctx),
        lida_em: e?.lida_em || null,
        adiada,
        adiada_ate: adiada ? e.adiada_ate : null,
        dispensada: !!e?.dispensada,
        no_resumo: pref.no_resumo !== false,
      };
    }).sort((a, b) =>
      (ORDEM_GRUPO[a.grupo] - ORDEM_GRUPO[b.grupo])
      || (ORDEM_PRIORIDADE[a.prioridade] - ORDEM_PRIORIDADE[b.prioridade])
      || String(a.data_ref || '').localeCompare(String(b.data_ref || '')));

    // Contagem (só o que está "na caixa de entrada": não adiado, não dispensado)
    const visiveis = saida.filter(i => !i.adiada && !i.dispensada);
    const porCategoria = {};
    catalogo.forEach(c => { porCategoria[c.id] = { total: 0, nao_lidas: 0 }; });
    visiveis.forEach(i => {
      const pc = porCategoria[i.categoria] || (porCategoria[i.categoria] = { total: 0, nao_lidas: 0 });
      pc.total++; if (!i.lida) pc.nao_lidas++;
    });

    // Próximo momento em que algo muda sozinho (lembrete chegando, adiamento
    // acabando, virada do dia) — o navegador agenda uma atualização pra lá
    // em vez de ficar perguntando o tempo todo.
    ctx.proximosEventos.push(inicioDiaTZ(somarDias(hojeStr, 1), tz).getTime() + 60000); // virada do dia no fuso da loja
    const futuros = ctx.proximosEventos.filter(t => t > agora);
    const proximo = futuros.length ? Math.min(...futuros) : null;

    // Faxina ocasional de estados antigos (chaves que já não existem)
    if (Math.random() < 0.03) {
      db.from('notif_estado').delete().eq('user_id', user.id)
        .lt('atualizado_em', new Date(agora - 120 * 86400000).toISOString())
        .then(() => {}, () => {});
    }

    res.json({
      itens: saida,
      contagem: {
        total: visiveis.length,
        nao_lidas: visiveis.filter(i => !i.lida).length,
        atrasadas: visiveis.filter(i => i.grupo === 'atrasado').length,
        hoje: visiveis.filter(i => i.grupo === 'hoje').length,
        adiadas: saida.filter(i => i.adiada && !i.dispensada).length,
        dispensadas: saida.filter(i => i.dispensada).length,
        por_categoria: porCategoria,
      },
      categorias: catalogo.filter(c => podeVerCategoria(user, c.id)).map(({ padrao, somenteDono, ...c }) => c),
      preferencias: prefs,
      proximo_evento_em: proximo ? new Date(proximo).toISOString() : null,
      agora: new Date(agora).toISOString(),
      timezone: tz,
    });
  } catch (err) {
    console.error('[ERRO] GET /api/notificacoes:', err.message);
    res.status(500).json({ error: 'Erro ao carregar notificações.' });
  }
});

/* ── Preferências ──────────────────────────────────────────── */
router.get('/preferencias', async (req, res) => {
  try {
    const prefs = await carregarPreferencias(req.user);
    res.json({
      preferencias: prefs,
      categorias: catalogoDo(req.user).filter(c => podeVerCategoria(req.user, c.id)).map(({ padrao, somenteDono, ...c }) => c),
    });
  } catch (err) {
    console.error('[ERRO] GET /api/notificacoes/preferencias:', err.message);
    res.status(500).json({ error: 'Erro ao carregar preferências.' });
  }
});

router.put('/preferencias', async (req, res) => {
  try {
    const prefs = sanitizarPreferencias(req.user, req.body?.preferencias);
    const { error } = await db.from('notif_preferencias')
      .upsert({ user_id: req.user.id, prefs, atualizado_em: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ preferencias: mesclarPreferencias(req.user, prefs) });
  } catch (err) {
    console.error('[ERRO] PUT /api/notificacoes/preferencias:', err.message);
    res.status(500).json({ error: 'Erro ao salvar preferências.' });
  }
});

/* ── Estado dos avisos ─────────────────────────────────────── */
const CHAVE_REGEX = /^[a-z_]{2,20}:[A-Za-z0-9:._\-]{1,180}$/;
const ACOES_ESTADO = ['lida', 'nao_lida', 'adiar', 'dispensar', 'restaurar'];

router.post('/estado', async (req, res) => {
  const { chaves, acao, minutos } = req.body || {};
  if (!ACOES_ESTADO.includes(acao)) return res.status(400).json({ error: 'Ação inválida.' });
  if (!Array.isArray(chaves) || !chaves.length || chaves.length > 500 || chaves.some(c => typeof c !== 'string' || !CHAVE_REGEX.test(c))) {
    return res.status(400).json({ error: 'Lista de avisos inválida.' });
  }
  const agoraIso = new Date().toISOString();
  let campos;
  switch (acao) {
    case 'lida':      campos = { lida_em: agoraIso, adiada_ate: null }; break;
    case 'nao_lida':  campos = { lida_em: null }; break;
    case 'dispensar': campos = { dispensada: true }; break;
    case 'restaurar': campos = { dispensada: false, adiada_ate: null, lida_em: null }; break;
    case 'adiar': {
      const m = parseInt(minutos, 10);
      if (!Number.isInteger(m) || m < 5 || m > 30 * 24 * 60) return res.status(400).json({ error: 'Tempo de adiamento inválido.' });
      campos = { adiada_ate: new Date(Date.now() + m * 60000).toISOString(), lida_em: null };
      break;
    }
  }
  try {
    const linhas = [...new Set(chaves)].map(chave => ({ user_id: req.user.id, chave, ...campos, atualizado_em: agoraIso }));
    const { error } = await db.from('notif_estado').upsert(linhas, { onConflict: 'user_id,chave' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERRO] POST /api/notificacoes/estado:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar notificações.' });
  }
});

/* ════════════════════════════════════════════════════════════
   LEMBRETES
   ════════════════════════════════════════════════════════════ */
const RECORRENCIAS = ['nenhuma', 'diaria', 'semanal', 'mensal', 'anual'];
const PRIORIDADES  = ['baixa', 'normal', 'alta'];
const VISIBILIDADES = ['so_eu', 'todos'];

function validarLembrete(b) {
  if (!b || typeof b !== 'object') return { erro: 'Dados inválidos.' };
  const titulo = String(b.titulo || '').trim();
  if (!titulo) return { erro: 'Informe o título do lembrete.' };
  const erroTam = validarTamanhos(
    { titulo, descricao: b.descricao || '', categoria: b.categoria || '' },
    { titulo: 150, descricao: LIMITES.OBSERVACAO_LONGA, categoria: 40 }
  );
  if (erroTam) return { erro: erroTam };
  if (!b.data_hora || Number.isNaN(Date.parse(b.data_hora))) return { erro: 'Informe a data e a hora do lembrete.' };
  if (b.recorrencia !== undefined && !RECORRENCIAS.includes(b.recorrencia)) return { erro: 'Repetição inválida.' };
  if (b.prioridade !== undefined && !PRIORIDADES.includes(b.prioridade)) return { erro: 'Prioridade inválida.' };
  if (b.visibilidade !== undefined && !VISIBILIDADES.includes(b.visibilidade)) return { erro: 'Visibilidade inválida.' };
  const ant = b.antecedencia_min === undefined ? 0 : parseInt(b.antecedencia_min, 10);
  if (!Number.isInteger(ant) || ant < 0 || ant > 43200) return { erro: 'Antecedência inválida.' };
  return {
    dados: {
      titulo,
      descricao: String(b.descricao || '').trim() || null,
      categoria: String(b.categoria || '').trim() || null,
      data_hora: new Date(b.data_hora).toISOString(),
      dia_inteiro: b.dia_inteiro === true,
      recorrencia: b.recorrencia || 'nenhuma',
      antecedencia_min: ant,
      prioridade: b.prioridade || 'normal',
      visibilidade: b.visibilidade || 'so_eu',
    },
  };
}

async function buscarLembrete(user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { data } = await consultaLembretesVisiveis(user).eq('id', id).maybeSingle();
  return data || null;
}

function auditarLembrete(req, acao, l) {
  registrar({
    mercearia_id:  ehAdmin(req.user) ? null : req.user.mercearia_id,
    operador_id:   req.user.role === 'operator' ? req.user.id : null,
    usuario_nome:  req.user.nome,
    usuario_email: req.user.email,
    modulo:        'notificacoes',
    acao,
    escopo:        ehAdmin(req.user) ? 'admin_global' : 'estabelecimento',
    descricao:     `Lembrete "${l.titulo}" ${acao === 'lembrete_criado' ? 'criado' : acao === 'lembrete_excluido' ? 'excluído' : 'editado'}`,
    meta:          { lembrete_id: l.id, data_hora: l.data_hora, recorrencia: l.recorrencia, visibilidade: l.visibilidade },
  });
}

router.get('/lembretes', async (req, res) => {
  const user = req.user;
  if (!ehAdmin(user) && !user.mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });
  try {
    let q = consultaLembretesVisiveis(user);
    if (req.query.status === 'pendentes') q = q.is('concluido_em', null);
    if (req.query.status === 'concluidos') q = q.not('concluido_em', 'is', null);
    const { data, error } = await q.order('data_hora', { ascending: true }).limit(500);
    if (error) throw error;
    res.json((data || []).map(l => ({ ...l, pode_editar: podeEditarLembrete(user, l) })));
  } catch (err) {
    console.error('[ERRO] GET /api/notificacoes/lembretes:', err.message);
    res.status(500).json({ error: 'Erro ao carregar lembretes.' });
  }
});

router.post('/lembretes', async (req, res) => {
  const user = req.user;
  if (!ehAdmin(user) && !user.mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });
  const { erro, dados } = validarLembrete(req.body);
  if (erro) return res.status(400).json({ error: erro });
  try {
    const { data, error } = await db.from('lembretes').insert({
      ...dados,
      escopo: ehAdmin(user) ? 'admin' : 'estab',
      mercearia_id: ehAdmin(user) ? null : user.mercearia_id,
      criado_por: user.id,
      criado_por_nome: user.nome || user.email || null,
    }).select().single();
    if (error) throw error;
    auditarLembrete(req, 'lembrete_criado', data);
    res.status(201).json({ ...data, pode_editar: true });
  } catch (err) {
    console.error('[ERRO] POST /api/notificacoes/lembretes:', err.message);
    res.status(500).json({ error: 'Erro ao criar lembrete.' });
  }
});

router.put('/lembretes/:id', async (req, res) => {
  const atual = await buscarLembrete(req.user, req.params.id);
  if (!atual) return res.status(404).json({ error: 'Lembrete não encontrado.' });
  if (!podeEditarLembrete(req.user, atual)) return res.status(403).json({ error: 'Só quem criou (ou o dono da loja, se for pra todos) pode editar este lembrete.' });
  const { erro, dados } = validarLembrete({ ...atual, ...req.body });
  if (erro) return res.status(400).json({ error: erro });
  try {
    const { data, error } = await db.from('lembretes')
      .update({ ...dados, atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    auditarLembrete(req, 'lembrete_editado', data);
    res.json({ ...data, pode_editar: true });
  } catch (err) {
    console.error('[ERRO] PUT /api/notificacoes/lembretes:', err.message);
    res.status(500).json({ error: 'Erro ao salvar lembrete.' });
  }
});

router.delete('/lembretes/:id', async (req, res) => {
  const atual = await buscarLembrete(req.user, req.params.id);
  if (!atual) return res.status(404).json({ error: 'Lembrete não encontrado.' });
  if (!podeEditarLembrete(req.user, atual)) return res.status(403).json({ error: 'Só quem criou (ou o dono da loja, se for pra todos) pode excluir este lembrete.' });
  try {
    const { error } = await db.from('lembretes').delete().eq('id', atual.id);
    if (error) throw error;
    auditarLembrete(req, 'lembrete_excluido', atual);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ERRO] DELETE /api/notificacoes/lembretes:', err.message);
    res.status(500).json({ error: 'Erro ao excluir lembrete.' });
  }
});

// Concluir: lembrete único fica concluído; lembrete que se repete pula pra
// próxima ocorrência (e volta a avisar quando ela chegar).
router.post('/lembretes/:id/concluir', async (req, res) => {
  const atual = await buscarLembrete(req.user, req.params.id);
  if (!atual) return res.status(404).json({ error: 'Lembrete não encontrado.' });
  try {
    const agora = new Date();
    const campos = atual.recorrencia === 'nenhuma'
      ? { concluido_em: agora.toISOString(), ultima_conclusao: agora.toISOString() }
      : { data_hora: proximaOcorrencia(atual.data_hora, atual.recorrencia, agora), ultima_conclusao: agora.toISOString() };
    const { data, error } = await db.from('lembretes')
      .update({ ...campos, atualizado_em: agora.toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    res.json({ ...data, pode_editar: podeEditarLembrete(req.user, data) });
  } catch (err) {
    console.error('[ERRO] POST /api/notificacoes/lembretes/concluir:', err.message);
    res.status(500).json({ error: 'Erro ao concluir lembrete.' });
  }
});

router.post('/lembretes/:id/reabrir', async (req, res) => {
  const atual = await buscarLembrete(req.user, req.params.id);
  if (!atual) return res.status(404).json({ error: 'Lembrete não encontrado.' });
  try {
    const { data, error } = await db.from('lembretes')
      .update({ concluido_em: null, atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    res.json({ ...data, pode_editar: podeEditarLembrete(req.user, data) });
  } catch (err) {
    console.error('[ERRO] POST /api/notificacoes/lembretes/reabrir:', err.message);
    res.status(500).json({ error: 'Erro ao reabrir lembrete.' });
  }
});

module.exports = router;
module.exports._interno = { proximaOcorrencia, lidaAindaVale, mesclarPreferencias, sanitizarPreferencias, podeVerCategoria, itemDeLembrete };
