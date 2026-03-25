const express = require('express');
const router = express.Router();
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { criarSuperAdmin } = require('../controllers/superAdminController');

// 🔥 só super admin acessa
router.post(
  '/criar',
  verificarPermissao('qualquer_coisa'),
  criarSuperAdmin
);

module.exports = router;