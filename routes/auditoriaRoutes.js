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
async function registrar({ mercearia_id, operador_id, usuario_nome, usuario_email, modulo, acao, descricao, meta }) {
  try {
    // Monta label legível: "João Silva (joao@email.com)" ou só o email
    const nomeLabel = usuario_nome && usuario_nome !== usuario_email
      ? `${usuario_nome} (${usuario_email || ''})`
      : (usuario_email || usuario_nome || 'Sistema');

    await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  operador_id || null,
      usuario_nome: nomeLabel,
      modulo,
      acao,
      descricao,
      meta: meta || null,
    });
  } catch (err) {
    console.error('[AUDITORIA] Erro ao registrar:', err.message);
  }
}

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