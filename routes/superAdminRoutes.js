const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const onlyMaster = require('../middlewares/onlyMaster');

const {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin,
  toggleAtivo,
  alterarSenha
} = require('../controllers/superAdminController');

// 🔥 TODAS ROTAS PROTEGIDAS
router.use(authUser);

// 🔒 APENAS MASTER PODE ACESSAR
router.use(onlyMaster);

// ============================================================
// 🔥 CRIAR SUPER ADMIN
// ============================================================
router.post('/criar', criarSuperAdmin);

// ============================================================
// 🔥 LISTAR SUPER ADMINS
// ============================================================
router.get('/listar', listarSuperAdmins);

// ============================================================
// 🔥 EXCLUIR SUPER ADMIN
// ============================================================
router.delete('/:id', excluirSuperAdmin);

// ============================================================
// 🔥 ATIVAR / DESATIVAR
// ============================================================
router.patch('/:id/ativo', toggleAtivo);

// ============================================================
// 🔥 ALTERAR SENHA
// ============================================================
router.patch('/:id/senha', alterarSenha);

// ============================================================
// 🔥 PERFIL DO USUÁRIO LOGADO (USADO NO LOGIN)
// ============================================================
router.get('/perfil', (req, res) => {
  try {
    return res.json(req.user);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

module.exports = router;