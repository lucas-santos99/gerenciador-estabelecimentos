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
// ============================================================
const express = require('express');
const router = express.Router();
const db = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const somenteSuperAdmin = require('../middlewares/somenteSuperAdmin');
const onlyMaster = require('../middlewares/onlyMaster');
const { registrar } = require('./auditoriaRoutes');
const { TIMEZONE_PADRAO, inicioDiaTZ } = require('../utils/fusoHorario');
const W = require('../utils/whatsappCustos');

router.use(authUser, somenteSuperAdmin);

const CHAVE_PARAMS = 'whatsapp_params';
const RECURSOS = ['alertas', 'consultas', 'pdf', 'cadastro', 'ia_audio', 'foto'];

/* ── Parâmetros ────────────────────────────────────────────── */
async function carregarParametros() {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', CHAVE_PARAMS).maybeSingle();
  let salvo = null;
  try { salvo = data?.valor ? JSON.parse(data.valor) : null; } catch { salvo = null; }
  return W.normalizarParametros(salvo);
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
    const p = await carregarParametros();
    res.json({ parametros: p, padrao: W.PARAMS_PADRAO, calculo: resumoCustos(p), pode_editar: !!req.user.is_master });
  } catch (err) {
    console.error('[WHATSAPP] GET parametros:', err.message);
    res.status(500).json({ error: 'Erro ao carregar os parâmetros do WhatsApp.' });
  }
});

router.put('/parametros', onlyMaster, async (req, res) => {
  try {
    const antes = await carregarParametros();
    const novo = W.normalizarParametros(req.body?.parametros);
    const { error } = await db.from('config_sistema')
      .upsert({ chave: CHAVE_PARAMS, valor: JSON.stringify(novo) }, { onConflict: 'chave' });
    if (error) throw error;
    await historico(req, { acao: 'parametros', antes, depois: novo });
    auditar(req, 'whatsapp_parametros', 'Alterou os parâmetros do WhatsApp (custos, pesos, travas, cobrança automática)', {});
    res.json({ parametros: novo, calculo: resumoCustos(novo) });
  } catch (err) {
    console.error('[WHATSAPP] PUT parametros:', err.message);
    res.status(500).json({ error: 'Erro ao salvar os parâmetros.' });
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
      if (l.mercearia_id && l.tipo !== 'cobranca_mensalidade') {
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
      receita_planos: null, // entra quando existir contratação por loja
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

module.exports = router;
module.exports._interno = { validarPlano };
