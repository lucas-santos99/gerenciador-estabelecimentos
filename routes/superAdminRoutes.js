const express = require('express');
const router = express.Router();
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { criarSuperAdmin } = require('../controllers/superAdminController');
const authUser = require('../middlewares/authUser');

// 🔥 só super admin acessa
router.post(
  '/criar',
  authUser, // 🔥 ESSENCIAL
  verificarPermissao('qualquer_coisa'),
  criarSuperAdmin
);

module.exports = router;