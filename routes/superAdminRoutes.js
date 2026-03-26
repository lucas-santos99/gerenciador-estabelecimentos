const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const { verificarPermissao } = require('../middlewares/verificarPermissao');

const {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin
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

router.patch(
  "/:id/ativo",
  authUser,
  verificarPermissao("super_admin"),
  toggleAtivo
);

module.exports = router;