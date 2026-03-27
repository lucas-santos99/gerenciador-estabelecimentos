const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const { verificarPermissao } = require('../middlewares/verificarPermissao');

const {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin,
  toggleAtivo,
  alterarSenha // ✅ agora sim importado corretamente
} = require('../controllers/superAdminController');

// 🔥 CRIAR SUPER ADMIN
router.post(
  '/criar',
  authUser,
  verificarPermissao('super_admin'),
  criarSuperAdmin
);

// 🔥 LISTAR SUPER ADMINS
router.get(
  '/listar',
  authUser,
  verificarPermissao('super_admin'),
  listarSuperAdmins
);

// 🔥 EXCLUIR SUPER ADMIN
router.delete(
  '/:id',
  authUser,
  verificarPermissao('super_admin'),
  excluirSuperAdmin
);

// 🔥 ATIVAR / DESATIVAR
router.patch(
  '/:id/ativo',
  authUser,
  verificarPermissao('super_admin'),
  toggleAtivo
);

// 🔥 ALTERAR SENHA (ROTA CORRETA SEPARADA)
router.patch(
  '/:id/senha',
  authUser,
  verificarPermissao('super_admin'),
  alterarSenha
);

// 🔥 PERFIL DO USUÁRIO LOGADO
router.get(
  '/perfil',
  authUser,
  async (req, res) => {
    try {
      return res.json(req.user);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar perfil' });
    }
  }
);

module.exports = router;