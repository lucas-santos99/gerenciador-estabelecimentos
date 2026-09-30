// routes/whatsappAdminRoutes.js
// ============================================================
// WhatsApp — painel do SuperAdmin (24/09/2026). Montado em /api/whatsapp/admin.
// Ainda NÃO fala com a Meta: é a estrutura (planos, parâmetros de custo,
// calculadora, uso do mês, cobrança automática da mensalidade) que fica
// pronta pra ligar quando o número brasileiro estiver conectado.
//
// Leitura: qualquer SuperAdmin. Gravação: só o master (mesmo critério das
// outras configurações estruturais — Config Geral, Config de Cobrança).
//
//   GET    /parametros                → parâmetros + custos calculados
//   PUT    /parametros                → (master) salva parâmetros
//   GET    /planos                    → planos/pacotes + números de cada um
//   POST   /planos                    → (master) cria
//   PUT    /planos/:id                → (master) edita
//   PATCH  /planos/:id/ativo          → (master) ativa/desativa
//   DELETE /planos/:id                → (master) exclui
//   GET    /historico                 → alterações de planos e parâmetros
//   POST   /simular                   → simulador (Meta +X%, dólar, custo IA)
//   GET    /uso?mes=YYYY-MM           → consumo e custo do mês (whatsapp_envios)
//   GET    /lojas                     → lista enxuta de estabelecimentos
//   POST   /dolar/atualizar           → busca a cotação do dólar agora
//   GET    /assinaturas               → planos contratados pelas lojas (29/09)
//   POST   /assinaturas/:id/ativar    → (master) ativa a solicitação
//   POST   /assinaturas/:id/recusar   → (master) recusa a solicitação
//   POST   /assinaturas/:id/encerrar  → (master) encerra (agora ou no fim do ciclo)
//   POST   /assinaturas/:id/ajuste    → (master) soma/tira créditos do ciclo
//   POST   /assinaturas/:id/retomar   → (master) retoma assistente pausado pelo teto (30/09)
//   GET    /assinaturas/:id/extrato   → movimentos do ciclo atual
//   POST   /pacotes/:id/aprovar       → (master) aprova pacote extra
//   POST   /pacotes/:id/recusar       → (master) recusa pacote extra
//
// Dólar automático (25/09): cotação PTAX de venda do Banco Central (fonte
// oficial, grátis, sem chave); se falhar, AwesomeAPI. Guardada em
// config_sistema.whatsapp_dolar e renovada no máximo a cada 6 horas, quando
// alguém abre o painel. Se as duas fontes falharem, fica o último valor.
// ============================================================
const express = require('express');
const router = express.Router();
const db = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const somenteSuperAdmin = require('../middlewares/somenteSuperAdmin');
const onlyMaster = require('../middlewares/onlyMaster');
const { registrar } = require('./auditoriaRoutes');
const { TIMEZONE_PADRAO, inicioDiaTZ, hojeStrTZ } = require('../utils/fusoHorario');
const W = require('../utils/whatsappCustos');
const A = require('../utils/whatsappAssinaturas');
const Assistente = require('../utils/whatsappAssistente');

router.use(authUser, somenteSuperAdmin);

const CHAVE_PARAMS = 'whatsapp_params';
const CHAVE_DOLAR = 'whatsapp_dolar';
const DOLAR_VALIDADE_MS = 6 * 60 * 60 * 1000;
const RECURSOS = ['alertas', 'consultas', 'pdf', 'cadastro', 'ia_audio', 'foto'];

/* ── Cotação do dólar ──────────────────────────────────────── */
const valorValido = (v) => Number.isFinite(v) && v >= 0.5 && v <= 100;

async function buscarJson(url) {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'GerenciadorEstabelecimentos - LucasJSystems' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// PTAX (Banco Central): última cotação dos últimos 10 dias (cobre fim de
// semana e feriado). Datas no formato MM-DD-AAAA exigido pela API.
async function cotacaoBancoCentral() {
  const fmt = (d) => {
    const [a, m, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE_PADRAO }).format(d).split('-');
    return `${m}-${dd}-${a}`;
  };
  const fim = new Date();
  const ini = new Date(fim.getTime() - 10 * 86400000);
  const url = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/'
    + 'CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)'
    + `?@dataInicial='${fmt(ini)}'&@dataFinalCotacao='${fmt(fim)}'&$format=json&$orderby=dataHoraCotacao%20desc&$top=1`;
  const j = await buscarJson(url);
  const item = Array.isArray(j?.value) ? j.value[0] : null;
  const v = Number(item?.cotacaoVenda);
  if (!item || !valorValido(v)) throw new Error('resposta sem cotação');
  return { valor: v, fonte: 'Banco Central (PTAX venda)', data: item.dataHoraCotacao || null };
}

async function cotacaoAwesome() {
  const j = await buscarJson('https://economia.awesomeapi.com.br/json/last/USD-BRL');
  const q = j?.USDBRL;
  const v = Number(q?.ask);
  if (!q || !valorValido(v)) throw new Error('resposta sem cotação');
  return { valor: v, fonte: 'AwesomeAPI (comercial)', data: q.create_date || null };
}

async function lerCotacaoSalva() {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', CHAVE_DOLAR).maybeSingle();
  try { return data?.valor ? JSON.parse(data.valor) : null; } catch { return null; }
}

// Devolve a cotação (renova se passou da validade ou se forcar=true).
// Nunca lança erro: na falha devolve a última salva com `erro`.
async function obterCotacao({ forcar = false } = {}) {
  const salva = await lerCotacaoSalva();
  const idade = salva?.atualizado_em ? Date.now() - new Date(salva.atualizado_em).getTime() : Infinity;
  if (!forcar && salva && idade < DOLAR_VALIDADE_MS) return salva;
  const erros = [];
  for (const fonte of [cotacaoBancoCentral, cotacaoAwesome]) {
    try {
      const c = await fonte();
      const nova = { ...c, valor: W.arred(c.valor, 4), atualizado_em: new Date().toISOString() };
      const { error } = await db.from('config_sistema')
        .upsert({ chave: CHAVE_DOLAR, valor: JSON.stringify(nova) }, { onConflict: 'chave' });
      if (error) console.error('[WHATSAPP] salvar cotação:', error.message);
      return nova;
    } catch (e) {
      erros.push(`${fonte.name}: ${e.message}`);
    }
  }
  console.error('[WHATSAPP] cotação do dólar indisponível:', erros.join(' | '));
  return salva
    ? { ...salva, erro: 'Não foi possível atualizar agora; usando a última cotação.' }
    : { valor: null, erro: 'Não foi possível buscar a cotação; usando o valor manual.' };
}

/* ── Parâmetros ────────────────────────────────────────────── */
// Parâmetros salvos + dólar do dia (quando o automático está ligado).
async function carregarParametros({ comCotacao = false } = {}) {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', CHAVE_PARAMS).maybeSingle();
  let salvo = null;
  try { salvo = data?.valor ? JSON.parse(data.valor) : null; } catch { salvo = null; }
  const base = W.normalizarParametros(salvo);
  const cotacao = base.ia.dolar_auto ? await obterCotacao() : await lerCotacaoSalva();
  const p = W.aplicarDolarAuto(base, cotacao);
  return comCotacao ? { p, cotacao } : p;
}

function resumoCustos(p) {
  const pc = W.piorCasoPorPedido(p);
  const r = {};
  Object.keys(pc).forEach(t => {
    r[t] = {
      meta: W.arred(pc[t].meta, 4), ia: W.arred(pc[t].ia, 4), total: W.arred(pc[t].total, 4),
      peso: pc[t].peso, por_credito: W.arred(pc[t].por_credito, 4),
    };
  });
  return {
    pior_caso_por_pedido: r,
    custo_max_credito: W.arred(W.custoMaxPorCredito(p), 4),
    ia_reais_por_interpretacao: W.arred(W.iaEmReais(p.ia.usd_por_interpretacao, p), 4),
    ia_reais_por_imagem: W.arred(W.iaEmReais(p.ia.usd_por_imagem, p), 4),
  };
}

function autor(req) {
  return { usuario_id: req.user.id, usuario_nome: req.user.nome || req.user.email || 'SuperAdmin' };
}

async function historico(req, { plano_id = null, plano_nome = null, acao, antes = null, depois = null }) {
  try {
    await db.from('whatsapp_planos_historico').insert({ plano_id, plano_nome, acao, antes, depois, ...autor(req) });
  } catch (e) { console.error('[WHATSAPP] histórico:', e.message); }
}

function auditar(req, acao, descricao, meta = {}) {
  registrar({
    mercearia_id: null, operador_id: null,
    usuario_nome: req.user.nome, usuario_email: req.user.email,
    modulo: 'whatsapp', acao, descricao, meta, escopo: 'admin_global',
  });
}

router.get('/parametros', async (req, res) => {
  try {
    const { p, cotacao } = await carregarParametros({ comCotacao: true });
    res.json({ parametros: p, padrao: W.PARAMS_PADRAO, calculo: resumoCustos(p), cotacao, pode_editar: !!req.user.is_master });
  } catch (err) {
    console.error('[WHATSAPP] GET parametros:', err.message);
    res.status(500).json({ error: 'Erro ao carregar os parâmetros do WhatsApp.' });
  }
});

router.put('/parametros', onlyMaster, async (req, res) => {
  try {
    const antes = await carregarParametros();
    const cotacao = await lerCotacaoSalva();
    const novo = W.aplicarDolarAuto(W.normalizarParametros(req.body?.parametros), cotacao);
    // "Liberado para as lojas" só muda pela aba Conexão (/conexao/liberar) —
    // aqui mantém o que está salvo, pra um rascunho antigo não desfazer.
    novo.integracao = { ...novo.integracao, ativo: antes.integracao?.ativo === true };
    const { error } = await db.from('config_sistema')
      .upsert({ chave: CHAVE_PARAMS, valor: JSON.stringify(novo) }, { onConflict: 'chave' });
    if (error) throw error;
    await historico(req, { acao: 'parametros', antes, depois: novo });
    auditar(req, 'whatsapp_parametros', 'Alterou os parâmetros do WhatsApp (custos, pesos, travas, cobrança automática)', {});
    res.json({ parametros: novo, calculo: resumoCustos(novo), cotacao });
  } catch (err) {
    console.error('[WHATSAPP] PUT parametros:', err.message);
    res.status(500).json({ error: 'Erro ao salvar os parâmetros.' });
  }
});

// Busca a cotação agora (botão "Atualizar agora"). Qualquer SuperAdmin:
// não muda nenhuma regra, só renova o valor de referência.
router.post('/dolar/atualizar', async (req, res) => {
  try {
    const cotacao = await obterCotacao({ forcar: true });
    const p = await carregarParametros();
    res.json({ cotacao, parametros: p, calculo: resumoCustos(p) });
  } catch (err) {
    console.error('[WHATSAPP] atualizar dólar:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar a cotação.' });
  }
});

/* ── Planos ────────────────────────────────────────────────── */
function validarPlano(b) {
  if (!b || typeof b !== 'object') return { erro: 'Dados inválidos.' };
  const nome = String(b.nome || '').trim();
  if (!nome) return { erro: 'Informe o nome do plano.' };
  if (nome.length > 80) return { erro: 'Nome muito longo (máx. 80).' };
  const descricao = String(b.descricao || '').trim();
  if (descricao.length > 500) return { erro: 'Descrição muito longa (máx. 500).' };
  const tipo = b.tipo === 'pacote' ? 'pacote' : 'plano';
  const preco = Number(String(b.preco ?? '').replace(',', '.'));
  if (!Number.isFinite(preco) || preco < 0 || preco > 100000) return { erro: 'Preço inválido.' };
  const creditos = parseInt(b.creditos, 10);
  if (!Number.isInteger(creditos) || creditos < 1 || creditos > 1000000) return { erro: 'Créditos inválidos (mínimo 1).' };
  const numeros = b.numeros === undefined ? 1 : parseInt(b.numeros, 10);
  if (!Number.isInteger(numeros) || numeros < 1 || numeros > 50) return { erro: 'Quantidade de números inválida (1 a 50).' };
  const r = b.recursos && typeof b.recursos === 'object' ? b.recursos : {};
  const recursos = {};
  RECURSOS.forEach(k => { recursos[k] = r[k] === true; });
  const ordem = Number.isInteger(parseInt(b.ordem, 10)) ? parseInt(b.ordem, 10) : 0;
  return {
    dados: {
      tipo, nome, descricao: descricao || null,
      preco: Math.round(preco * 100) / 100, creditos, numeros, recursos,
      destaque: b.destaque === true, ordem, ativo: b.ativo !== false,
    },
  };
}

async function buscarPlano(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { data } = await db.from('whatsapp_planos').select('*').eq('id', id).maybeSingle();
  return data || null;
}

router.get('/planos', async (req, res) => {
  try {
    const p = await carregarParametros();
    const { data, error } = await db.from('whatsapp_planos').select('*')
      .order('tipo', { ascending: false }).order('ordem', { ascending: true }).order('preco', { ascending: true });
    if (error) throw error;
    res.json({
      planos: (data || []).map(pl => ({ ...pl, calculo: W.calcularPlano(pl, p) })),
      custo_max_credito: W.arred(W.custoMaxPorCredito(p), 4),
      pode_editar: !!req.user.is_master,
    });
  } catch (err) {
    console.error('[WHATSAPP] GET planos:', err.message);
    res.status(500).json({ error: 'Erro ao carregar os planos.' });
  }
});

// Preço abaixo do mínimo só com confirmação explícita do master
function travaPrecoMinimo(dados, p, confirmar) {
  const calc = W.calcularPlano(dados, p);
  if (calc.situacao === 'abaixo_minimo' && confirmar !== true) {
    return {
      status: 409,
      body: {
        error: `Preço abaixo do mínimo calculado (R$ ${calc.preco_minimo.toFixed(2).replace('.', ',')}). Confirme se quer salvar mesmo assim.`,
        codigo: 'ABAIXO_MINIMO', calculo: calc,
      },
    };
  }
  return null;
}

router.post('/planos', onlyMaster, async (req, res) => {
  const { erro, dados } = validarPlano(req.body);
  if (erro) return res.status(400).json({ error: erro });
  try {
    const p = await carregarParametros();
    const trava = travaPrecoMinimo(dados, p, req.body.confirmar_abaixo_minimo);
    if (trava) return res.status(trava.status).json(trava.body);
    const { data, error } = await db.from('whatsapp_planos')
      .insert({ ...dados, atualizado_por_nome: autor(req).usuario_nome }).select().single();
    if (error) throw error;
    await historico(req, { plano_id: data.id, plano_nome: data.nome, acao: 'criado', depois: data });
    auditar(req, 'whatsapp_plano_criado', `Criou o ${data.tipo} de WhatsApp "${data.nome}" (R$ ${data.preco}, ${data.creditos} créditos)`, { plano_id: data.id });
    res.status(201).json({ ...data, calculo: W.calcularPlano(data, p) });
  } catch (err) {
    console.error('[WHATSAPP] POST planos:', err.message);
    res.status(500).json({ error: 'Erro ao criar o plano.' });
  }
});

router.put('/planos/:id', onlyMaster, async (req, res) => {
  try {
    const atual = await buscarPlano(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Plano não encontrado.' });
    const { erro, dados } = validarPlano({ ...atual, ...req.body });
    if (erro) return res.status(400).json({ error: erro });
    const p = await carregarParametros();
    const precoMudou = Number(dados.preco) !== Number(atual.preco) || dados.creditos !== atual.creditos;
    if (precoMudou || (dados.ativo && !atual.ativo)) {
      const trava = travaPrecoMinimo(dados, p, req.body.confirmar_abaixo_minimo);
      if (trava) return res.status(trava.status).json(trava.body);
    }
    const { data, error } = await db.from('whatsapp_planos')
      .update({ ...dados, atualizado_em: new Date().toISOString(), atualizado_por_nome: autor(req).usuario_nome })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    await historico(req, { plano_id: data.id, plano_nome: data.nome, acao: 'editado', antes: atual, depois: data });
    auditar(req, 'whatsapp_plano_editado', `Editou o ${data.tipo} de WhatsApp "${data.nome}" (R$ ${atual.preco} → R$ ${data.preco}; ${atual.creditos} → ${data.creditos} créditos)`, { plano_id: data.id });
    res.json({ ...data, calculo: W.calcularPlano(data, p) });
  } catch (err) {
    console.error('[WHATSAPP] PUT planos:', err.message);
    res.status(500).json({ error: 'Erro ao salvar o plano.' });
  }
});

router.patch('/planos/:id/ativo', onlyMaster, async (req, res) => {
  try {
    const atual = await buscarPlano(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Plano não encontrado.' });
    const ativo = req.body?.ativo === true;
    if (ativo) {
      const p = await carregarParametros();
      const trava = travaPrecoMinimo(atual, p, req.body.confirmar_abaixo_minimo);
      if (trava) return res.status(trava.status).json(trava.body);
    }
    const { data, error } = await db.from('whatsapp_planos')
      .update({ ativo, atualizado_em: new Date().toISOString(), atualizado_por_nome: autor(req).usuario_nome })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    await historico(req, { plano_id: data.id, plano_nome: data.nome, acao: ativo ? 'ativado' : 'desativado', antes: { ativo: atual.ativo }, depois: { ativo } });
    auditar(req, ativo ? 'whatsapp_plano_ativado' : 'whatsapp_plano_desativado', `${ativo ? 'Ativou' : 'Desativou'} o ${data.tipo} de WhatsApp "${data.nome}"`, { plano_id: data.id });
    res.json(data);
  } catch (err) {
    console.error('[WHATSAPP] PATCH ativo:', err.message);
    res.status(500).json({ error: 'Erro ao alterar o plano.' });
  }
});

router.delete('/planos/:id', onlyMaster, async (req, res) => {
  try {
    const atual = await buscarPlano(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Plano não encontrado.' });
    // Quando existir contratação por loja, planos em uso só poderão ser desativados.
    const { error } = await db.from('whatsapp_planos').delete().eq('id', atual.id);
    if (error) throw error;
    await historico(req, { plano_id: null, plano_nome: atual.nome, acao: 'excluido', antes: atual });
    auditar(req, 'whatsapp_plano_excluido', `Excluiu o ${atual.tipo} de WhatsApp "${atual.nome}"`, {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP] DELETE planos:', err.message);
    res.status(500).json({ error: 'Erro ao excluir o plano.' });
  }
});

router.get('/historico', async (req, res) => {
  try {
    const { data, error } = await db.from('whatsapp_planos_historico')
      .select('id, plano_id, plano_nome, acao, antes, depois, usuario_nome, criado_em')
      .order('criado_em', { ascending: false }).limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[WHATSAPP] GET historico:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o histórico.' });
  }
});

/* ── Simulador ─────────────────────────────────────────────── */
router.post('/simular', async (req, res) => {
  try {
    const base = await carregarParametros();
    const b = req.body || {};
    const s = W.simular(base, {
      meta_pct: Math.min(500, Math.max(-90, Number(b.meta_pct) || 0)),
      dolar: b.dolar != null && b.dolar !== '' ? Math.min(100, Math.max(0.5, Number(b.dolar))) : null,
      usd_interp: b.usd_interp != null && b.usd_interp !== '' ? Math.min(5, Math.max(0, Number(b.usd_interp))) : null,
    });
    const { data } = await db.from('whatsapp_planos').select('*').order('ordem', { ascending: true });
    res.json({
      custo_max_credito_atual: W.arred(W.custoMaxPorCredito(base), 4),
      custo_max_credito_simulado: W.arred(W.custoMaxPorCredito(s), 4),
      planos: (data || []).map(pl => ({
        id: pl.id, nome: pl.nome, tipo: pl.tipo, preco: pl.preco, creditos: pl.creditos, ativo: pl.ativo,
        atual: W.calcularPlano(pl, base), simulado: W.calcularPlano(pl, s),
      })),
    });
  } catch (err) {
    console.error('[WHATSAPP] simular:', err.message);
    res.status(500).json({ error: 'Erro ao simular.' });
  }
});

/* ── Receita dos planos no mês (ciclos iniciados + pacotes aprovados) ── */
async function receitaDoMes(mesStr) {
  try {
    const [a, m] = mesStr.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    const ini = `${mesStr}-01`, fim = `${mesStr}-${String(ultimo).padStart(2, '0')}`;
    const { data: ciclos } = await db.from('whatsapp_creditos_mov').select('assinatura_id')
      .eq('tipo', 'credito_ciclo').gte('ciclo_inicio', ini).lte('ciclo_inicio', fim).limit(5000);
    let planos = 0;
    const ids = (ciclos || []).map(c => c.assinatura_id);
    if (ids.length) {
      const { data: ass } = await db.from('whatsapp_assinaturas').select('id, preco').in('id', [...new Set(ids)]);
      const preco = Object.fromEntries((ass || []).map(x => [x.id, Number(x.preco) || 0]));
      ids.forEach(id => { planos += preco[id] || 0; });
    }
    const { data: pacs } = await db.from('whatsapp_pacotes_compras').select('preco')
      .eq('status', 'aprovado')
      .gte('resolvido_em', inicioDiaTZ(ini, TIMEZONE_PADRAO).toISOString())
      .lt('resolvido_em', inicioDiaTZ(A.somarDias(fim, 1), TIMEZONE_PADRAO).toISOString());
    const pacotes = (pacs || []).reduce((s, x) => s + (Number(x.preco) || 0), 0);
    return { planos: W.arred(planos), pacotes: W.arred(pacotes), total: W.arred(planos + pacotes), ciclos: ids.length };
  } catch (e) {
    console.error('[WHATSAPP] receita do mês:', e.message);
    return null;
  }
}

/* ── Uso do mês (a partir do registro de envios) ───────────── */
router.get('/uso', async (req, res) => {
  try {
    const mesStr = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.mes || ''))
      ? req.query.mes
      : new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE_PADRAO }).format(new Date()).slice(0, 7);
    const [a, m] = mesStr.split('-').map(Number);
    const proximo = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
    const ini = inicioDiaTZ(`${mesStr}-01`, TIMEZONE_PADRAO).toISOString();
    const fim = inicioDiaTZ(`${proximo}-01`, TIMEZONE_PADRAO).toISOString();

    const p = await carregarParametros();
    const linhas = [];
    for (let de = 0; de < 50000; de += 1000) {
      const { data, error } = await db.from('whatsapp_envios')
        .select('mercearia_id, direcao, tipo, pedido_tipo, status, custo_meta_estimado, custo_ia_estimado, creditos')
        .gte('criado_em', ini).lt('criado_em', fim).range(de, de + 999);
      if (error) throw error;
      linhas.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // 29/09/2026: o mesmo número atende duas coisas, contadas SEPARADAS:
    //   • "seu"   → uso do dono do sistema: cobrança da mensalidade, testes
    //               e qualquer envio sem loja. Sai da mensalidade, não dos planos.
    //   • "lojas" → uso dos estabelecimentos (alertas, respostas da IA,
    //               mensagens recebidas): é o serviço vendido nos planos.
    const ehSeu = (l) => !l.mercearia_id || l.tipo === 'cobranca_mensalidade' || l.tipo === 'teste';
    const novoGrupo = () => ({ mensagens: 0, meta: 0, ia: 0, porTipo: {} });
    const G = { seu: novoGrupo(), lojas: novoGrupo() };

    const porTipo = {};
    const porLoja = {};
    let meta = 0, ia = 0, respostas = 0, cobranca = 0;
    linhas.forEach(l => {
      const cm = Number(l.custo_meta_estimado) || 0;
      const ci = Number(l.custo_ia_estimado) || 0;
      meta += cm; ia += ci;
      if (l.direcao === 'saida' && l.tipo === 'resposta' && l.status !== 'falhou') respostas++;
      if (l.tipo === 'cobranca_mensalidade') cobranca += cm;
      const t = porTipo[l.tipo] || (porTipo[l.tipo] = { quantidade: 0, custo: 0 });
      t.quantidade++; t.custo += cm + ci;
      const g = G[ehSeu(l) ? 'seu' : 'lojas'];
      g.mensagens++; g.meta += cm; g.ia += ci;
      const gt = g.porTipo[l.tipo] || (g.porTipo[l.tipo] = { quantidade: 0, custo: 0 });
      gt.quantidade++; gt.custo += cm + ci;
      if (!ehSeu(l)) {
        const lj = porLoja[l.mercearia_id] || (porLoja[l.mercearia_id] = { mercearia_id: l.mercearia_id, mensagens: 0, creditos: 0, custo_meta: 0, custo_ia: 0 });
        lj.mensagens++; lj.creditos += Number(l.creditos) || 0; lj.custo_meta += cm; lj.custo_ia += ci;
      }
    });

    const idsLojas = Object.keys(porLoja);
    const nomes = {};
    if (idsLojas.length) {
      const { data: ms } = await db.from('mercearias').select('id, nome_fantasia').in('id', idsLojas);
      (ms || []).forEach(x => { nomes[x.id] = x.nome_fantasia; });
    }
    const gratis = Math.min(respostas, p.meta.respostas_gratis_mes) * p.meta.preco_resposta;
    const total = Math.max(0, meta + ia - gratis) + p.custos_fixos.chip_mensal;
    const receita = await receitaDoMes(mesStr);
    const tipos = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { quantidade: v.quantidade, custo: W.arred(v.custo) }]));
    // A franquia grátis é de respostas — respostas são sempre das lojas.
    const custoLojas = Math.max(0, G.lojas.meta + G.lojas.ia - gratis);
    const custoSeu = G.seu.meta + G.seu.ia;
    const chip = p.custos_fixos.chip_mensal;

    res.json({
      mes: mesStr,
      total_mensagens: linhas.length,
      custo_meta: W.arred(meta),
      custo_ia: W.arred(ia),
      desconto_respostas_gratis: W.arred(gratis),
      custo_cobranca_mensalidade: W.arred(cobranca),
      custo_fixo_chip: W.arred(p.custos_fixos.chip_mensal),
      custo_total: W.arred(total),
      teto_global: p.teto_global.mensal_reais,
      acima_teto_global: p.teto_global.mensal_reais > 0 && total > p.teto_global.mensal_reais,
      por_tipo: Object.fromEntries(Object.entries(porTipo).map(([k, v]) => [k, { quantidade: v.quantidade, custo: W.arred(v.custo) }])),
      por_loja: Object.values(porLoja)
        .map(l => ({ ...l, nome: nomes[l.mercearia_id] || 'Estabelecimento', creditos: W.arred(l.creditos), custo_meta: W.arred(l.custo_meta), custo_ia: W.arred(l.custo_ia), custo_total: W.arred(l.custo_meta + l.custo_ia) }))
        .sort((x, y) => y.custo_total - x.custo_total),
      receita_planos: receita,
      lojas: {
        mensagens: G.lojas.mensagens,
        custo_meta: W.arred(G.lojas.meta),
        custo_ia: W.arred(G.lojas.ia),
        desconto_respostas_gratis: W.arred(gratis),
        custo_total: W.arred(custoLojas),
        por_tipo: tipos(G.lojas.porTipo),
        // Resultado do serviço: receita dos planos − custo das lojas − chip
        // (o chip existe por causa do serviço). Antes de impostos e taxas.
        sobra: receita ? W.arred(receita.total - custoLojas - chip) : null,
      },
      seu: {
        mensagens: G.seu.mensagens,
        custo_meta: W.arred(G.seu.meta),
        custo_ia: W.arred(G.seu.ia),
        custo_total: W.arred(custoSeu),
        por_tipo: tipos(G.seu.porTipo),
      },
    });
  } catch (err) {
    console.error('[WHATSAPP] GET uso:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o uso do mês.' });
  }
});

/* ── Lista enxuta de lojas (pra desligar a cobrança automática por loja) ── */
router.get('/lojas', async (req, res) => {
  try {
    const { data, error } = await db.from('mercearias')
      .select('id, nome_fantasia, status_assinatura, data_vencimento')
      .neq('status_assinatura', 'excluida')
      .order('nome_fantasia', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[WHATSAPP] GET lojas:', err.message);
    res.status(500).json({ error: 'Erro ao listar os estabelecimentos.' });
  }
});

/* ── Planos contratados pelas lojas (29/09) ────────────────── */
const UUID = /^[0-9a-f-]{36}$/i;

function auditarLoja(req, merceariaId, acao, descricao, meta = {}) {
  registrar({
    mercearia_id: merceariaId, operador_id: null,
    usuario_nome: req.user.nome, usuario_email: req.user.email,
    modulo: 'whatsapp', acao, descricao, meta, escopo: 'admin_global',
  });
}

async function buscarAssinatura(id) {
  if (!UUID.test(String(id))) return null;
  const { data } = await db.from('whatsapp_assinaturas').select('*').eq('id', id).maybeSingle();
  return data || null;
}

router.get('/assinaturas', async (req, res) => {
  try {
    const desde = new Date(Date.now() - 60 * 86400000).toISOString();
    const [{ data: abertas, error: e1 }, { data: fechadas }, { data: pacotes }] = await Promise.all([
      db.from('whatsapp_assinaturas').select('*').in('status', ['aguardando', 'ativa']).order('criado_em', { ascending: true }),
      db.from('whatsapp_assinaturas').select('*').in('status', ['recusada', 'cancelada', 'substituida', 'desistiu'])
        .gte('encerrado_em', desde).order('encerrado_em', { ascending: false }).limit(100),
      db.from('whatsapp_pacotes_compras').select('*').eq('status', 'aguardando').order('criado_em', { ascending: true }),
    ]);
    if (e1) throw e1;

    const ids = [...new Set([...(abertas || []), ...(fechadas || []), ...(pacotes || [])].map(x => x.mercearia_id))];
    const lojas = {};
    if (ids.length) {
      const { data: ms } = await db.from('mercearias').select('id, nome_fantasia, timezone').in('id', ids);
      (ms || []).forEach(x => { lojas[x.id] = x; });
    }
    const nome = (id) => lojas[id]?.nome_fantasia || 'Estabelecimento';

    const ativas = [];
    for (const a0 of (abertas || []).filter(x => x.status === 'ativa')) {
      const a = await A.garantirCiclo(db, a0, hojeStrTZ(lojas[a0.mercearia_id]?.timezone || TIMEZONE_PADRAO));
      if (!a || a.status !== 'ativa') continue;
      const r = await A.resumoCiclo(db, a.id, a.ciclo_inicio);
      ativas.push({ ...a, ...r, loja_nome: nome(a.mercearia_id), teto: await situacaoTeto(a, lojas[a.mercearia_id]?.timezone || TIMEZONE_PADRAO) });
    }
    const pendentes = (abertas || []).filter(x => x.status === 'aguardando').map(x => {
      const anterior = (abertas || []).find(y => y.id === x.substitui_id);
      return { ...x, loja_nome: nome(x.mercearia_id), troca_de: anterior ? anterior.plano_nome : null };
    });

    res.json({
      pendentes,
      ativas: ativas.sort((x, y) => x.loja_nome.localeCompare(y.loja_nome, 'pt-BR')),
      pacotes: (pacotes || []).map(x => ({ ...x, loja_nome: nome(x.mercearia_id) })),
      encerradas: (fechadas || []).map(x => ({ ...x, loja_nome: nome(x.mercearia_id) })),
      pode_editar: !!req.user.is_master,
    });
  } catch (err) {
    console.error('[WHATSAPP] GET assinaturas:', err.message);
    res.status(500).json({ error: 'Erro ao carregar os planos das lojas.' });
  }
});

router.post('/assinaturas/:id/ativar', onlyMaster, async (req, res) => {
  try {
    const a = await buscarAssinatura(req.params.id);
    if (!a) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (a.status !== 'aguardando') return res.status(409).json({ error: 'Essa solicitação já foi resolvida.' });
    const ativa = await A.ativar(db, a, req.user.nome || req.user.email);
    if (!ativa) return res.status(409).json({ error: 'Essa solicitação já foi resolvida.' });
    auditarLoja(req, a.mercearia_id, 'whatsapp_plano_ativado_loja',
      `Ativou o plano de WhatsApp "${a.plano_nome}" (R$ ${a.preco}/mês, ${a.creditos} créditos) — ciclo ${ativa.ciclo_inicio} a ${ativa.ciclo_fim}`,
      { assinatura_id: a.id });
    res.json(ativa);
  } catch (err) {
    console.error('[WHATSAPP] ativar:', err.message);
    res.status(500).json({ error: 'Erro ao ativar o plano.' });
  }
});

router.post('/assinaturas/:id/recusar', onlyMaster, async (req, res) => {
  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  try {
    const a = await buscarAssinatura(req.params.id);
    if (!a) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    const agora = new Date().toISOString();
    const { data } = await db.from('whatsapp_assinaturas')
      .update({ status: 'recusada', motivo: motivo || null, encerrado_em: agora, encerrado_por_nome: req.user.nome, atualizado_em: agora })
      .eq('id', a.id).eq('status', 'aguardando').select();
    if (!data || !data.length) return res.status(409).json({ error: 'Essa solicitação já foi resolvida.' });
    auditarLoja(req, a.mercearia_id, 'whatsapp_plano_recusado_loja', `Recusou a solicitação do plano de WhatsApp "${a.plano_nome}"${motivo ? ` — ${motivo}` : ''}`, { assinatura_id: a.id });
    res.json(data[0]);
  } catch (err) {
    console.error('[WHATSAPP] recusar:', err.message);
    res.status(500).json({ error: 'Erro ao recusar.' });
  }
});

router.post('/assinaturas/:id/encerrar', onlyMaster, async (req, res) => {
  const imediato = req.body?.imediato === true;
  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  try {
    const a = await buscarAssinatura(req.params.id);
    if (!a || a.status !== 'ativa') return res.status(404).json({ error: 'Plano ativo não encontrado.' });
    let r;
    if (imediato) {
      r = await A.encerrarAgora(db, a, req.user.nome, motivo);
      if (!r) return res.status(409).json({ error: 'O plano já foi encerrado.' });
    } else {
      const { data, error } = await db.from('whatsapp_assinaturas')
        .update({ cancelar_no_fim: true, motivo: motivo || a.motivo, atualizado_em: new Date().toISOString() })
        .eq('id', a.id).eq('status', 'ativa').select().single();
      if (error) throw error;
      r = data;
    }
    auditarLoja(req, a.mercearia_id, 'whatsapp_plano_encerrado_loja',
      `${imediato ? 'Encerrou agora o' : 'Agendou o encerramento (no fim do ciclo) do'} plano de WhatsApp "${a.plano_nome}"${motivo ? ` — ${motivo}` : ''}`, { assinatura_id: a.id });
    res.json(r);
  } catch (err) {
    console.error('[WHATSAPP] encerrar:', err.message);
    res.status(500).json({ error: 'Erro ao encerrar o plano.' });
  }
});

router.post('/assinaturas/:id/ajuste', onlyMaster, async (req, res) => {
  const q = Number(String(req.body?.quantidade ?? '').replace(',', '.'));
  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  if (!Number.isFinite(q) || q === 0 || Math.abs(q) > 100000) return res.status(400).json({ error: 'Quantidade inválida.' });
  if (!motivo) return res.status(400).json({ error: 'Informe o motivo do ajuste.' });
  try {
    const a0 = await buscarAssinatura(req.params.id);
    if (!a0 || a0.status !== 'ativa') return res.status(404).json({ error: 'Plano ativo não encontrado.' });
    const tz = await A.timezoneDaLoja(db, a0.mercearia_id);
    const a = await A.garantirCiclo(db, a0, hojeStrTZ(tz));
    if (!a || a.status !== 'ativa') return res.status(409).json({ error: 'O plano não está mais ativo.' });
    const quantidade = Math.round(q * 100) / 100;
    await A.lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'ajuste', quantidade, descricao: motivo, criado_por_nome: req.user.nome });
    auditarLoja(req, a.mercearia_id, 'whatsapp_creditos_ajuste', `Ajustou ${quantidade > 0 ? '+' : ''}${quantidade} créditos de WhatsApp — ${motivo}`, { assinatura_id: a.id });
    res.json({ ...a, ...(await A.resumoCiclo(db, a.id, a.ciclo_inicio)) });
  } catch (err) {
    console.error('[WHATSAPP] ajuste:', err.message);
    res.status(500).json({ error: 'Erro ao ajustar os créditos.' });
  }
});

// Teto de custo (disjuntor) de um plano ativo neste ciclo — 30/09/2026
async function situacaoTeto(a, tz) {
  const mesmoCiclo = a.teto_ciclo === a.ciclo_inicio;
  let custo = 0;
  try { custo = await Assistente.custoDoCiclo(a.mercearia_id, a, tz); } catch { custo = 0; }
  const preco = Number(a.preco) || 0;
  return {
    custo: W.arred(custo, 2),
    pct: preco > 0 ? Math.round((custo / preco) * 100) : null,
    aviso: mesmoCiclo && !!a.teto_aviso_em,
    pausado: mesmoCiclo && !!a.teto_pausado_em && !a.teto_liberado_em,
    liberado: mesmoCiclo && !!a.teto_liberado_em,
    liberado_por: mesmoCiclo ? a.teto_liberado_por_nome || null : null,
  };
}

// Retoma o assistente pausado pelo teto de custo (vale até o fim do ciclo)
router.post('/assinaturas/:id/retomar', onlyMaster, async (req, res) => {
  try {
    const a = await buscarAssinatura(req.params.id);
    if (!a || a.status !== 'ativa') return res.status(404).json({ error: 'Plano ativo não encontrado.' });
    if (!(a.teto_ciclo === a.ciclo_inicio && a.teto_pausado_em && !a.teto_liberado_em)) {
      return res.status(409).json({ error: 'O assistente desta loja não está pausado.' });
    }
    const { error } = await db.from('whatsapp_assinaturas')
      .update({ teto_liberado_em: new Date().toISOString(), teto_liberado_por_nome: req.user.nome })
      .eq('id', a.id).eq('status', 'ativa');
    if (error) throw error;
    auditarLoja(req, a.mercearia_id, 'whatsapp_teto_retomado', 'Retomou o assistente do WhatsApp pausado pelo teto de custo (até o fim do ciclo)', { assinatura_id: a.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP] retomar:', err.message);
    res.status(500).json({ error: 'Erro ao retomar o assistente.' });
  }
});

router.get('/assinaturas/:id/extrato', async (req, res) => {
  try {
    const a = await buscarAssinatura(req.params.id);
    if (!a || !a.ciclo_inicio) return res.json({ movimentos: [] });
    const { data, error } = await db.from('whatsapp_creditos_mov')
      .select('id, tipo, quantidade, pedido_tipo, descricao, criado_por_nome, criado_em')
      .eq('assinatura_id', a.id).eq('ciclo_inicio', a.ciclo_inicio)
      .order('criado_em', { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ ciclo_inicio: a.ciclo_inicio, ciclo_fim: a.ciclo_fim, movimentos: data || [] });
  } catch (err) {
    console.error('[WHATSAPP] extrato:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o extrato.' });
  }
});

router.post('/pacotes/:id/aprovar', onlyMaster, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Pedido inválido.' });
  try {
    const { data: pac } = await db.from('whatsapp_pacotes_compras').select('*').eq('id', req.params.id).maybeSingle();
    if (!pac || pac.status !== 'aguardando') return res.status(404).json({ error: 'Pedido não encontrado ou já resolvido.' });
    const a0 = await buscarAssinatura(pac.assinatura_id);
    if (!a0 || a0.status !== 'ativa') return res.status(409).json({ error: 'A loja não tem plano ativo.' });
    const tz = await A.timezoneDaLoja(db, a0.mercearia_id);
    const a = await A.garantirCiclo(db, a0, hojeStrTZ(tz));
    if (!a || a.status !== 'ativa') return res.status(409).json({ error: 'A loja não tem plano ativo.' });
    const { data } = await db.from('whatsapp_pacotes_compras')
      .update({ status: 'aprovado', resolvido_em: new Date().toISOString(), resolvido_por_nome: req.user.nome })
      .eq('id', pac.id).eq('status', 'aguardando').select();
    if (!data || !data.length) return res.status(409).json({ error: 'Esse pedido já foi resolvido.' });
    await A.lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'pacote', quantidade: pac.creditos, descricao: `Pacote extra: ${pac.nome}`, criado_por_nome: req.user.nome });
    auditarLoja(req, a.mercearia_id, 'whatsapp_pacote_aprovado', `Aprovou o pacote extra de WhatsApp "${pac.nome}" (+${pac.creditos} créditos, R$ ${pac.preco})`, { pacote_id: pac.id });
    res.json(data[0]);
  } catch (err) {
    console.error('[WHATSAPP] aprovar pacote:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar o pacote.' });
  }
});

router.post('/pacotes/:id/recusar', onlyMaster, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Pedido inválido.' });
  const motivo = String(req.body?.motivo || '').trim().slice(0, 300);
  try {
    const { data } = await db.from('whatsapp_pacotes_compras')
      .update({ status: 'recusado', motivo: motivo || null, resolvido_em: new Date().toISOString(), resolvido_por_nome: req.user.nome })
      .eq('id', req.params.id).eq('status', 'aguardando').select();
    if (!data || !data.length) return res.status(404).json({ error: 'Pedido não encontrado ou já resolvido.' });
    auditarLoja(req, data[0].mercearia_id, 'whatsapp_pacote_recusado', `Recusou o pacote extra de WhatsApp "${data[0].nome}"${motivo ? ` — ${motivo}` : ''}`, { pacote_id: data[0].id });
    res.json(data[0]);
  } catch (err) {
    console.error('[WHATSAPP] recusar pacote:', err.message);
    res.status(500).json({ error: 'Erro ao recusar o pacote.' });
  }
});

/* ══════════════════════════════════════════════════════════
   CONEXÃO COM A META (30/09/2026) — número real, webhook e teste
   ══════════════════════════════════════════════════════════ */
const M = require('../utils/whatsappMeta');

// Estado da ligação: o que está configurado no servidor (sem mostrar os
// segredos), dados do número na Meta e se o app recebe os avisos da conta.
router.get('/conexao', async (req, res) => {
  const config = M.configuracao();
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const r = {
    config, numero: null, webhook_assinado: null, erro: null, pode_editar: !!req.user.is_master,
    webhook_url: `${proto}://${req.get('host')}/api/whatsapp/webhook`,
  };
  if (!config.token) return res.json(r);
  try {
    r.numero = await M.statusNumero();
  } catch (e) {
    r.erro = M.explicarErro(e.codigo) || e.message;
  }
  try {
    const apps = await M.appsAssinados();
    r.webhook_assinado = apps.length > 0;
  } catch (e) {
    if (!r.erro) r.erro = M.explicarErro(e.codigo) || e.message;
  }
  res.json(r);
});

// Faz a conta do WhatsApp mandar os avisos (mensagens/status) para o app
router.post('/conexao/assinar-webhook', onlyMaster, async (req, res) => {
  try {
    await M.assinarWebhook();
    auditar(req, 'whatsapp_webhook_assinado', 'Ligou o recebimento de avisos (webhook) da conta do WhatsApp');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: M.explicarErro(e.codigo) || e.message });
  }
});

// Liberar (ou pausar) o WhatsApp para as lojas: a tela da loja deixa de
// mostrar "Em breve" e o serviço passa a contar como no ar.
router.post('/conexao/liberar', onlyMaster, async (req, res) => {
  try {
    const ativo = req.body?.ativo === true;
    const antes = await carregarParametros();
    const novo = { ...antes, integracao: { ...antes.integracao, ativo } };
    const { error } = await db.from('config_sistema')
      .upsert({ chave: CHAVE_PARAMS, valor: JSON.stringify(W.normalizarParametros(novo)) }, { onConflict: 'chave' });
    if (error) throw error;
    await historico(req, { acao: 'parametros', antes, depois: novo });
    auditar(req, 'whatsapp_liberado', ativo ? 'Liberou o WhatsApp para as lojas' : 'Pausou o WhatsApp para as lojas', { ativo });
    res.json({ ok: true, ativo });
  } catch (err) {
    console.error('[WHATSAPP] liberar:', err.message);
    res.status(500).json({ error: 'Erro ao salvar.' });
  }
});

// Mensagem de teste (texto livre). Só funciona dentro da janela de 24h:
// a pessoa precisa ter mandado mensagem para o número do sistema antes.
router.post('/teste', onlyMaster, async (req, res) => {
  const tel = A.normalizarTelefone(req.body?.telefone);
  const texto = String(req.body?.texto || '').trim();
  if (!tel) return res.status(400).json({ error: 'Telefone inválido. Use DDD + número.' });
  if (!texto || texto.length > 1000) return res.status(400).json({ error: 'Escreva a mensagem (até 1000 caracteres).' });
  const r = await M.enviarTexto({ para: tel, texto, tipo: 'teste' });
  auditar(req, 'whatsapp_teste', `Mensagem de teste para ${A.formatarTelefone(tel)} — ${r.ok ? 'enviada' : 'falhou'}`, { ok: r.ok, codigo: r.codigo || null });
  if (!r.ok) return res.status(400).json({ error: M.explicarErro(r.codigo) || r.erro, codigo: r.codigo || null });
  res.json({ ok: true, id: r.id });
});

// Últimas mensagens (enviadas e recebidas) — acompanhamento da ligação
router.get('/mensagens', async (req, res) => {
  try {
    const lim = Math.min(100, Math.max(1, parseInt(req.query.limite, 10) || 30));
    const { data, error } = await db.from('whatsapp_envios')
      .select('id, mercearia_id, direcao, tipo, destino, status, erro_codigo, erro_mensagem, custo_meta_estimado, criado_em')
      .order('criado_em', { ascending: false }).limit(lim);
    if (error) throw error;
    const ids = [...new Set((data || []).map(x => x.mercearia_id).filter(Boolean))];
    const nomes = {};
    if (ids.length) {
      const { data: ms } = await db.from('mercearias').select('id, nome_fantasia').in('id', ids);
      (ms || []).forEach(m => { nomes[m.id] = m.nome_fantasia; });
    }
    res.json((data || []).map(x => ({
      ...x, loja_nome: x.mercearia_id ? (nomes[x.mercearia_id] || 'Estabelecimento') : null,
      destino_formatado: A.formatarTelefone(x.destino), erro_explicado: M.explicarErro(x.erro_codigo),
    })));
  } catch (err) {
    console.error('[WHATSAPP] GET mensagens:', err.message);
    res.status(500).json({ error: 'Erro ao carregar as mensagens.' });
  }
});

module.exports = router;
module.exports._interno = { validarPlano };
