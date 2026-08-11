// routes/auditoriaRoutes.js
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { TIMEZONE_PADRAO, buscarTimezone, inicioDiaTZ, fimDiaTZ } = require('../utils/fusoHorario');

console.log('🔥 AUDITORIA ROUTES ATUALIZADO (fuso por estabelecimento) 🔥');

router.use(authUser);

/* ── helpers ─────────────────────────────────────────────── */
function garantirMerchant(req, res) {
  if (!req.user.mercearia_id) {
    res.status(403).json({ error: 'Sem mercearia associada' });
    return false;
  }
  return true;
}

/* ============================================================
   REGISTRAR AÇÃO (interno — chamado por outras rotas)
   Exportado como função auxiliar
============================================================ */
async function registrar({ mercearia_id, operador_id, usuario_nome, usuario_email, modulo, acao, descricao, meta, escopo }) {
  try {
    // Monta label legível: "João Silva (joao@email.com)" ou só o email
    const nomeLabel = usuario_nome && usuario_nome !== usuario_email
      ? `${usuario_nome} (${usuario_email || ''})`
      : (usuario_email || usuario_nome || 'Sistema');

    await db.from('auditoria').insert({
      mercearia_id: mercearia_id || null,
      operador_id:  operador_id || null,
      usuario_nome: nomeLabel,
      modulo,
      acao,
      descricao,
      meta: meta || null,
      // 'estabelecimento' = ação de operador/merchant dentro do próprio estabelecimento
      // 'admin_global'    = ação de super_admin no painel administrativo
      // 'login'           = registro de login (estabelecimento ou admin)
      escopo: escopo || 'estabelecimento',
    });
  } catch (err) {
    console.error('[AUDITORIA] Erro ao registrar:', err.message);
  }
}

/* ============================================================
   REGISTRAR LOGIN (estabelecimento OU admin)
   POST /api/auditoria/login
   Chamada pelo AuthProvider logo após um login bem-sucedido.
   Usa o próprio token da sessão recém-criada — authUser (aplicado
   no topo deste router) já popula req.user com role/mercearia_id.
============================================================ */
router.post('/login', async (req, res) => {
  try {
    await registrar({
      mercearia_id:  req.user.mercearia_id || null,
      operador_id:   req.user.role === 'operator' ? req.user.id : null,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        'auth',
      acao:          'login',
      descricao:     `${req.user.nome || req.user.email} fez login (${req.user.role})`,
      meta:          { role: req.user.role },
      escopo:        'login',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[AUDITORIA] Erro registrar login:', err.message);
    // Nunca deve travar o fluxo de login por causa disso
    res.status(200).json({ success: false });
  }
});

/* ============================================================
   LISTAR AUDITORIA DO ESTABELECIMENTO (merchant)
   GET /api/auditoria?modulo=&operador_id=&data_inicio=&data_fim=&limit=&offset=
============================================================ */
router.get('/', verificarPermissao(PERMISSOES.AUDITORIA), async (req, res) => {
  if (!garantirMerchant(req, res)) return;

  const { mercearia_id } = req.user;
  const {
    modulo, operador_id, acao, busca,
    data_inicio, data_fim,
    limit = 50, offset = 0,
  } = req.query;

  try {
    const timezone = await buscarTimezone(mercearia_id);

    let query = db
      .from('auditoria')
      .select(`
        id, modulo, acao, descricao, meta, criado_em,
        usuario_nome,
        operador_id
      `, { count: 'exact' })
      .eq('mercearia_id', mercearia_id)
      .order('criado_em', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (modulo)      query = query.eq('modulo', modulo);
    if (operador_id === 'merchant') {
      query = query.is('operador_id', null);
    } else if (operador_id) {
      query = query.eq('operador_id', operador_id);
    }
    if (acao)        query = query.eq('acao', acao);
    // Busca livre por palavra dentro da descrição do registro — útil pra
    // achar, por exemplo, uma tentativa de cadastro com palavra proibida
    // (a descrição do registro guarda o nome/marca que foi digitado).
    if (busca)       query = query.ilike('descricao', `%${busca.trim()}%`);
    if (data_inicio) query = query.gte('criado_em', inicioDiaTZ(data_inicio, timezone).toISOString());
    if (data_fim)    query = query.lte('criado_em', fimDiaTZ(data_fim, timezone).toISOString());


    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ registros: data || [], total: count || 0 });
  } catch (err) {
    console.error('[AUDITORIA] Erro listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar auditoria' });
  }
});

/* ============================================================
   LISTAR OPERADORES DO ESTABELECIMENTO (para filtros)
   GET /api/auditoria/operadores
============================================================ */
router.get('/operadores', verificarPermissao(PERMISSOES.AUDITORIA), async (req, res) => {
  if (!garantirMerchant(req, res)) return;
  const { mercearia_id } = req.user;

  try {
    const { data, error } = await db
      .from('operadores')
      .select('id, nome, email')
      .eq('mercearia_id', mercearia_id)
      .neq('status', 'excluido')
      .order('nome');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar operadores' });
  }
});

/* ============================================================
   RESUMO DE AÇÕES POR OPERADOR (merchant)
   GET /api/auditoria/resumo?data_inicio=&data_fim=
============================================================ */
router.get('/resumo', verificarPermissao(PERMISSOES.AUDITORIA), async (req, res) => {
  if (!garantirMerchant(req, res)) return;
  const { mercearia_id } = req.user;
  const { data_inicio, data_fim } = req.query;

  try {
    const timezone = await buscarTimezone(mercearia_id);

    let query = db
      .from('auditoria')
      .select('operador_id, usuario_nome, modulo, acao')
      .eq('mercearia_id', mercearia_id);

    if (data_inicio) query = query.gte('criado_em', inicioDiaTZ(data_inicio, timezone).toISOString());
    if (data_fim)    query = query.lte('criado_em', fimDiaTZ(data_fim, timezone).toISOString());

    const { data, error } = await query;
    if (error) throw error;

    // Agrupa por operador
    const por_operador = {};
    (data || []).forEach(r => {
      const key = r.operador_id || 'merchant';
      if (!por_operador[key]) {
        por_operador[key] = { operador_id: r.operador_id, nome: r.usuario_nome || 'Administrador', total: 0, por_modulo: {} };
      }
      por_operador[key].total++;
      por_operador[key].por_modulo[r.modulo] = (por_operador[key].por_modulo[r.modulo] || 0) + 1;
    });

    res.json(Object.values(por_operador).sort((a, b) => b.total - a.total));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar resumo' });
  }
});

/* ============================================================
   ADMIN — AUDITORIA GERAL (todas as mercearias, escopo admin)
   GET /api/auditoria/admin/geral?escopo=&modulo=&acao=&mercearia_id=&data_inicio=&data_fim=&limit=&offset=
   Só super_admin. Usada na aba "Auditoria" do painel administrativo.
   ⚠️ Precisa vir ANTES de /admin/:mercearia_id, senão o Express
   trata "geral" como valor do parâmetro :mercearia_id.
============================================================ */
router.get('/admin/geral', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const {
    escopo, modulo, acao, mercearia_id, usuario, busca,
    data_inicio, data_fim,
    sort_by = 'criado_em', sort_order = 'desc',
    limit = 50, offset = 0,
  } = req.query;

  // Whitelist pra evitar sort_by arbitrário vindo da query string
  const colunasOrdenaveis = ['criado_em', 'usuario_nome', 'modulo', 'acao', 'escopo'];
  const coluna = colunasOrdenaveis.includes(sort_by) ? sort_by : 'criado_em';
  const ascending = sort_order === 'asc';

  // Cap de segurança — usado pela exportação (CSV/PDF), que pede lotes maiores
  const limitNum = Math.min(parseInt(limit) || 50, 1000);

  try {
    // Filtro cruza vários estabelecimentos, que podem estar em fusos
    // diferentes entre si. Se um mercearia_id específico foi selecionado
    // no filtro, usa o fuso dele; senão (visão geral, todos os
    // estabelecimentos), usa Brasília como referência — é a visão
    // consolidada do próprio SuperAdmin, não de um estabelecimento.
    const timezone = mercearia_id ? await buscarTimezone(mercearia_id) : TIMEZONE_PADRAO;

    let query = db
      .from('auditoria')
      .select(`
        id, mercearia_id, modulo, acao, descricao, meta, criado_em,
        usuario_nome, operador_id, escopo
      `, { count: 'exact' })
      .order(coluna, { ascending })
      .range(parseInt(offset), parseInt(offset) + limitNum - 1);

    if (escopo)       query = query.eq('escopo', escopo);
    if (modulo)       query = query.eq('modulo', modulo);
    if (acao)         query = query.eq('acao', acao);
    if (mercearia_id) query = query.eq('mercearia_id', mercearia_id);
    if (usuario)      query = query.ilike('usuario_nome', `%${usuario}%`);
    // Busca livre por palavra na descrição — cruza todos os estabelecimentos,
    // útil pra achar rápido uma tentativa de nome/marca com palavra proibida
    // (ou qualquer outro evento) sem precisar saber de qual loja veio.
    if (busca)        query = query.ilike('descricao', `%${busca.trim()}%`);
    if (data_inicio)  query = query.gte('criado_em', inicioDiaTZ(data_inicio, timezone).toISOString());
    if (data_fim)     query = query.lte('criado_em', fimDiaTZ(data_fim, timezone).toISOString());

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ registros: data || [], total: count || 0 });
  } catch (err) {
    console.error('[AUDITORIA] Erro listar geral:', err.message);
    res.status(500).json({ error: 'Erro ao buscar auditoria geral' });
  }
});

/* ============================================================
   ADMIN — LISTA DE ESTABELECIMENTOS COM AUDITORIA (p/ filtro)
   GET /api/auditoria/admin/estabelecimentos
   ⚠️ Também precisa vir ANTES de /admin/:mercearia_id.
============================================================ */
router.get('/admin/estabelecimentos', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  try {
    const { data, error } = await db
      .from('mercearias')
      .select('id, nome_fantasia')
      .neq('status_assinatura', 'excluida')
      .order('nome_fantasia');

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar estabelecimentos' });
  }
});

/* ============================================================
   ADMIN — OPÇÕES PARA OS FILTROS (usuários e ações que de fato
   existem na auditoria, opcionalmente restrito a um estabelecimento
   e/ou escopo). Alimenta os <select> de Usuário e Ação na tela.
   GET /api/auditoria/admin/filtros?mercearia_id=&escopo=
   ⚠️ Também precisa vir ANTES de /admin/:mercearia_id.
============================================================ */
router.get('/admin/filtros', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { mercearia_id, escopo } = req.query;

  try {
    let queryAcao = db.from('auditoria').select('acao').limit(5000);
    let queryUser = db.from('auditoria').select('usuario_nome').limit(5000);

    if (mercearia_id) { queryAcao = queryAcao.eq('mercearia_id', mercearia_id); queryUser = queryUser.eq('mercearia_id', mercearia_id); }
    if (escopo)       { queryAcao = queryAcao.eq('escopo', escopo);             queryUser = queryUser.eq('escopo', escopo); }

    const [{ data: acaoRows, error: e1 }, { data: userRows, error: e2 }] = await Promise.all([queryAcao, queryUser]);
    if (e1) throw e1;
    if (e2) throw e2;

    const acoes    = [...new Set((acaoRows || []).map(r => r.acao).filter(Boolean))].sort();
    const usuarios = [...new Set((userRows || []).map(r => r.usuario_nome).filter(Boolean))].sort();

    res.json({ acoes, usuarios });
  } catch (err) {
    console.error('[AUDITORIA] Erro buscar filtros:', err.message);
    res.status(500).json({ error: 'Erro ao buscar opções de filtro' });
  }
});

/* ============================================================
   ADMIN — LISTAR AUDITORIA DE UM ESTABELECIMENTO
   GET /api/auditoria/admin/:mercearia_id
============================================================ */
router.get('/admin/:mercearia_id', async (req, res) => {
  if (!['super_admin', 'merchant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { mercearia_id } = req.params;
  const { limit = 100, offset = 0, modulo, busca, data_inicio, data_fim } = req.query;

  try {
    const timezone = await buscarTimezone(mercearia_id);

    let query = db
      .from('auditoria')
      .select('id, modulo, acao, descricao, meta, criado_em, usuario_nome, operador_id', { count: 'exact' })
      .eq('mercearia_id', mercearia_id)
      .order('criado_em', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (modulo)      query = query.eq('modulo', modulo);
    if (busca)       query = query.ilike('descricao', `%${busca.trim()}%`);
    if (data_inicio) query = query.gte('criado_em', inicioDiaTZ(data_inicio, timezone).toISOString());
    if (data_fim)    query = query.lte('criado_em', fimDiaTZ(data_fim, timezone).toISOString());

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ registros: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar auditoria' });
  }
});

module.exports = router;
module.exports.registrar = registrar;