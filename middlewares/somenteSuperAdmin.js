// middlewares/somenteSuperAdmin.js
// Libera a rota só pra quem tem role 'super_admin' (master ou comum).
// Usar SEMPRE depois do authUser (precisa do req.user). Criado em
// 22/09/2026 pra fechar as rotas /admin/* — antes várias delas não
// exigiam login nenhum e outras aceitavam qualquer usuário logado
// (inclusive comerciante/operador de outra loja).
module.exports = function somenteSuperAdmin(req, res, next) {
  if (req.user?.role === 'super_admin') return next();
  return res.status(403).json({ error: 'Acesso restrito ao SuperAdmin.' });
};
