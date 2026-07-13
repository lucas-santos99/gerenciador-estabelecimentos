// routes/auditoriaRoutes.js
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

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
router.get('/', async (req, res) => {
  if (!garantirMerchant(req, res)) return;

  const { mercearia_id } = req.user;
  const {
    modulo, operador_id, acao,
    data_inicio, data_fim,
    limit = 50, offset = 0,
  } = req.query;

  try {
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
    if (data_inicio) query = query.gte('criado_em', data_inicio);
    if (data_fim)    query = query.lte('criado_em', data_fim + 'T23:59:59');

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
router.get('/operadores', async (req, res) => {
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
router.get('/resumo', async (req, res) => {
  if (!garantirMerchant(req, res)) return;
  const { mercearia_id } = req.user;
  const { data_inicio, data_fim } = req.query;

  try {
    let query = db
      .from('auditoria')
      .select('operador_id, usuario_nome, modulo, acao')
      .eq('mercearia_id', mercearia_id);

    if (data_inicio) query = query.gte('criado_em', data_inicio);
    if (data_fim)    query = query.lte('criado_em', data_fim + 'T23:59:59');

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
    escopo, modulo, acao, mercearia_id, usuario,
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
    if (data_inicio)  query = query.gte('criado_em', data_inicio);
    if (data_fim)     query = query.lte('criado_em', data_fim + 'T23:59:59');

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
   ADMIN — LISTAR AUDITORIA DE UM ESTABELECIMENTO
   GET /api/auditoria/admin/:mercearia_id
============================================================ */
router.get('/admin/:mercearia_id', async (req, res) => {
  if (!['super_admin', 'merchant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { mercearia_id } = req.params;
  const { limit = 100, offset = 0, modulo, data_inicio, data_fim } = req.query;

  try {
    let query = db
      .from('auditoria')
      .select('id, modulo, acao, descricao, meta, criado_em, usuario_nome, operador_id', { count: 'exact' })
      .eq('mercearia_id', mercearia_id)
      .order('criado_em', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (modulo)      query = query.eq('modulo', modulo);
    if (data_inicio) query = query.gte('criado_em', data_inicio);
    if (data_fim)    query = query.lte('criado_em', data_fim + 'T23:59:59');

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ registros: data || [], total: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar auditoria' });
  }
});

module.exports = router;
module.exports.registrar = registrar;