// routes/solicitacoesRoutes.js
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');

console.log('🔥 SOLICITAÇÕES ROUTES ATUALIZADO 🔥');

router.use(authUser);

// Mapa de campo da solicitação -> coluna real em mercearias. Só esses
// são aplicados automaticamente ao "Atender" — 'logo' e 'outro' não têm
// como ser aplicados sozinhos (imagem / descrição livre), então ficam
// só de contexto pro admin, sem alteração automática no cadastro.
const CAMPO_PARA_COLUNA = {
  nome_fantasia:     'nome_fantasia',
  cnpj:              'cnpj',
  telefone:          'telefone',
  email_contato:     'email_contato',
  endereco_completo: 'endereco_completo',
};
// Esses dois guardam lista (telefones/endereços extras) — no modal o
// valor novo vem como texto separado por vírgula, então precisa
// desmontar de volta pra array antes de gravar.
const CAMPOS_LISTA = ['telefones_extras', 'enderecos_extras'];

/* ════════════════════════════════════════════════════════════
   1. CRIAR SOLICITAÇÃO — merchant do estabelecimento envia pro painel
      POST /api/solicitacoes
      body: { campos: [{ campo, label, valor_atual, valor_novo }], detalhes }
════════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  const { mercearia_id, role, nome, email } = req.user;

  if (!mercearia_id) {
    return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });
  }

  const { campos, detalhes } = req.body;

  if (!Array.isArray(campos) || campos.length === 0) {
    return res.status(400).json({ error: 'Selecione ao menos um campo pra alterar.' });
  }

  try {
    const { data: merc } = await db
      .from('mercearias')
      .select('nome_fantasia, telefone')
      .eq('id', mercearia_id)
      .single();

    const { data, error } = await db
      .from('solicitacoes_alteracao')
      .insert({
        mercearia_id,
        nome_estabelecimento:     merc?.nome_fantasia || null,
        telefone_estabelecimento: merc?.telefone || null,
        solicitado_por_nome:  nome || email,
        campos,
        detalhes: detalhes?.trim() || null,
        status: 'pendente',
      })
      .select()
      .single();

    if (error) throw error;

    await registrar({
      mercearia_id,
      operador_id:  role === 'operator' ? req.user.id : null,
      usuario_nome: nome,
      usuario_email: email,
      modulo: 'configuracoes',
      acao: 'solicitacao_alteracao_enviada',
      descricao: `Solicitou alteração de dados: ${campos.map(c => c.label).join(', ')}`,
      meta: { solicitacao_id: data.id, campos: campos.map(c => c.campo) },
      escopo: 'estabelecimento',
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro criar:', err.message);
    res.status(500).json({ error: 'Erro ao enviar solicitação.' });
  }
});

/* ════════════════════════════════════════════════════════════
   2. ADMIN — LISTAR SOLICITAÇÕES
      GET /api/solicitacoes/admin?status=pendente
════════════════════════════════════════════════════════════ */
router.get('/admin', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { status } = req.query;

  try {
    let query = db
      .from('solicitacoes_alteracao')
      .select('*')
      .order('criado_em', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json(data || []);
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar solicitações.' });
  }
});

/* ════════════════════════════════════════════════════════════
   3. ADMIN — CONTAGEM DE PENDENTES (badge/popup no login)
      GET /api/solicitacoes/admin/contagem-pendentes
════════════════════════════════════════════════════════════ */
router.get('/admin/contagem-pendentes', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { count, error } = await db
      .from('solicitacoes_alteracao')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pendente');

    if (error) throw error;

    res.json({ pendentes: count || 0 });
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro contagem:', err.message);
    res.status(500).json({ error: 'Erro ao contar solicitações.' });
  }
});

/* ════════════════════════════════════════════════════════════
   4. ADMIN — RESOLVER SOLICITAÇÃO (atender ou recusar)
      PATCH /api/solicitacoes/admin/:id
      body: { status: 'atendida' | 'recusada', resposta? }
════════════════════════════════════════════════════════════ */
router.patch('/admin/:id', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { id } = req.params;
  const { status, resposta } = req.body;

  if (!['atendida', 'recusada'].includes(status)) {
    return res.status(400).json({ error: "Status inválido (use 'atendida' ou 'recusada')." });
  }

  try {
    const { data, error } = await db
      .from('solicitacoes_alteracao')
      .update({
        status,
        resposta:    resposta?.trim() || null,
        atendido_em: new Date().toISOString(),
        atendido_por: req.user.nome || req.user.email,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Solicitação não encontrada.' });

    // Ao atender, aplica direto no cadastro do estabelecimento — sem
    // precisar abrir a tela de edição manualmente depois.
    let camposAplicados = [];
    if (status === 'atendida') {
      const updateMerc = {};
      for (const c of data.campos || []) {
        if (!c?.valor_novo) continue;
        if (CAMPO_PARA_COLUNA[c.campo]) {
          updateMerc[CAMPO_PARA_COLUNA[c.campo]] = c.valor_novo;
          camposAplicados.push(c.label || c.campo);
        } else if (CAMPOS_LISTA.includes(c.campo)) {
          updateMerc[c.campo] = c.valor_novo.split(',').map(s => s.trim()).filter(Boolean);
          camposAplicados.push(c.label || c.campo);
        }
        // 'logo' e 'outro' ficam de fora — não têm como aplicar sozinhos
      }

      if (Object.keys(updateMerc).length > 0) {
        const { error: errMerc } = await db
          .from('mercearias')
          .update(updateMerc)
          .eq('id', data.mercearia_id);
        if (errMerc) {
          console.error('[SOLICITAÇÕES] Falha ao aplicar mudanças no estabelecimento:', errMerc.message);
          return res.status(500).json({
            error: 'A solicitação foi marcada como atendida, mas houve erro ao aplicar as mudanças no cadastro. Confira manualmente.',
          });
        }
      }
    }

    await registrar({
      mercearia_id: data.mercearia_id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'configuracoes',
      acao: status === 'atendida' ? 'solicitacao_atendida' : 'solicitacao_recusada',
      descricao: status === 'atendida'
        ? `Atendeu a solicitação de "${data.nome_estabelecimento}"` + (camposAplicados.length ? ` — aplicou: ${camposAplicados.join(', ')}` : '')
        : `Recusou a solicitação de "${data.nome_estabelecimento}"`,
      meta: { solicitacao_id: id, campos_aplicados: camposAplicados },
      escopo: 'admin_global',
    });

    res.json({ ...data, campos_aplicados: camposAplicados });
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro resolver:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar solicitação.' });
  }
});

/* ════════════════════════════════════════════════════════════
   5. ESTABELECIMENTO — VER AS PRÓPRIAS SOLICITAÇÕES
      GET /api/solicitacoes/minhas
      Usado pra mostrar o aviso quando uma solicitação foi
      atendida/recusada e o comerciante ainda não viu.
════════════════════════════════════════════════════════════ */
router.get('/minhas', async (req, res) => {
  const { mercearia_id } = req.user;
  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const { data, error } = await db
      .from('solicitacoes_alteracao')
      .select('*')
      .eq('mercearia_id', mercearia_id)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro listar minhas:', err.message);
    res.status(500).json({ error: 'Erro ao buscar suas solicitações.' });
  }
});

/* ════════════════════════════════════════════════════════════
   6. ESTABELECIMENTO — MARCAR AVISO DE RESOLUÇÃO COMO VISTO
      PATCH /api/solicitacoes/minhas/:id/marcar-visto
════════════════════════════════════════════════════════════ */
router.patch('/minhas/:id/marcar-visto', async (req, res) => {
  const { mercearia_id } = req.user;
  const { id } = req.params;
  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const { error } = await db
      .from('solicitacoes_alteracao')
      .update({ visto_pelo_estabelecimento: true })
      .eq('id', id)
      .eq('mercearia_id', mercearia_id); // garante que só marca solicitação do próprio estabelecimento

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[SOLICITAÇÕES] Erro marcar visto:', err.message);
    res.status(500).json({ error: 'Erro ao marcar como visto.' });
  }
});

module.exports = router;