// middlewares/requireEstabelecimento.js
//
// ⚠️ 22/09/2026 — REESCRITO POR SEGURANÇA. A versão antiga descobria
// "quem é o usuário" lendo o header `x-user-id` que o próprio navegador
// manda — ou seja, qualquer um se passava por qualquer pessoa só
// mudando esse header. Não era usada em nenhuma rota (conferido), mas
// ficava disponível pra ser importada por engano no futuro.
//
// Agora depende do `authUser` (token validado de verdade) e só usa o
// `req.user` que ele monta. Uso: router.use(authUser, requireEstabelecimento)
// A checagem de licença bloqueada já é feita pelo próprio authUser.

function requireEstabelecimento(req, res, next) {
  if (!req.user) {
    return res.status(500).json({ error: 'requireEstabelecimento precisa vir depois do authUser.' });
  }
  if (req.user.is_superadmin || req.user.role === 'super_admin') {
    req.merceariaId = req.user.mercearia_id || null;
    return next();
  }
  if (!req.user.mercearia_id) {
    return res.status(403).json({ error: 'Estabelecimento não encontrado' });
  }
  req.merceariaId = req.user.mercearia_id;
  next();
}

module.exports = requireEstabelecimento;
