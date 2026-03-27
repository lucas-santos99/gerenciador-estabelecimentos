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

module.exports = router;