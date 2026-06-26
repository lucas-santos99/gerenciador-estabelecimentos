const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const onlyMaster = require('../middlewares/onlyMaster');

const {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin,
  toggleAtivo,
  alterarSenha,
  tornarMaster // 🔥 ADICIONADO
} = require('../controllers/superAdminController');

// 🔥 TODAS ROTAS PRECISAM ESTAR AUTENTICADAS
router.use(authUser);

// ============================================================
// 🔥 PERFIL (IMPORTANTE PRO LOGIN)
// ============================================================
router.get('/perfil', (req, res) => {
  try {
    return res.json(req.user);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ============================================================
// 🔒 APENAS MASTER
// ============================================================

// CRIAR
router.post('/criar', onlyMaster, criarSuperAdmin);

// LISTAR
router.get('/listar', onlyMaster, listarSuperAdmins);

// EXCLUIR
router.delete('/:id', onlyMaster, excluirSuperAdmin);

// ATIVAR/DESATIVAR
router.patch('/:id/ativo', onlyMaster, toggleAtivo);

// ALTERAR SENHA
router.patch('/:id/senha', onlyMaster, alterarSenha);

// 🔥 TORNAR MASTER (NOVO)
router.patch('/:id/master', onlyMaster, tornarMaster);

// ============================================================
// CONFIGURAÇÕES GLOBAIS DO SISTEMA
// ============================================================

router.get('/config', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { data, error } = await db
      .from('config_sistema')
      .select('chave, valor');
    if (error) throw error;

    const config = {};
    (data || []).forEach(r => { config[r.chave] = r.valor; });

    res.json({
      limite_operadores_padrao: parseInt(config.limite_operadores_padrao) || 3,
      valor_mensalidade:        parseFloat(config.valor_mensalidade)      || 49.90,
      whatsapp_suporte:         config.whatsapp_suporte                   || '',
    });
  } catch (err) {
    console.error('ERRO GET config:', err);
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

router.put('/config', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { limite_operadores_padrao, valor_mensalidade, whatsapp_suporte } = req.body;

    const updates = [];

    if (limite_operadores_padrao !== undefined) {
      const val = parseInt(limite_operadores_padrao);
      if (isNaN(val) || val < 0 || val > 50)
        return res.status(400).json({ error: 'Limite inválido (0–50)' });
      updates.push({ chave: 'limite_operadores_padrao', valor: String(val) });
    }

    if (valor_mensalidade !== undefined) {
      const val = parseFloat(valor_mensalidade);
      if (isNaN(val) || val < 0 || val > 9999)
        return res.status(400).json({ error: 'Valor de mensalidade inválido' });
      updates.push({ chave: 'valor_mensalidade', valor: String(val.toFixed(2)) });
    }

    if (whatsapp_suporte !== undefined) {
      const limpo = String(whatsapp_suporte).replace(/\D/g, '');
      if (limpo.length < 10 || limpo.length > 15)
        return res.status(400).json({ error: 'WhatsApp inválido (só números, com DDD e DDI)' });
      updates.push({ chave: 'whatsapp_suporte', valor: limpo });
    }

    for (const u of updates) {
      const { error } = await db
        .from('config_sistema')
        .upsert(u, { onConflict: 'chave' });
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('ERRO PUT config:', err);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

module.exports = router;