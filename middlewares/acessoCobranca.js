// middlewares/acessoCobranca.js
// Proteção das rotas de cobrança da licença (Asaas cartão / Efí Pix),
// criada em 22/09/2026. Antes, essas rotas não exigiam login: qualquer
// pessoa na internet gerava cobrança pra qualquer estabelecimento — e,
// como a rota cancela a cobrança anterior antes de gerar outra, dava
// pra invalidar o Pix que o comerciante estava prestes a pagar.

// Tem que vir ANTES do authUser: marca a requisição pra que o authUser
// NÃO barre com "licença bloqueada" — renovar a licença é justamente o
// que um estabelecimento bloqueado precisa conseguir fazer.
function liberarComLicencaBloqueada(req, res, next) {
  req.permitirLicencaBloqueada = true;
  next();
}

// Depois do authUser: só o próprio estabelecimento (merchant/operator
// daquela loja) ou um SuperAdmin (tela de Cobranças) gera cobrança pro
// :mercearia_id da URL.
function donoDaMerceariaOuSuperAdmin(req, res, next) {
  if (req.user?.role === 'super_admin') return next();
  if (req.user?.mercearia_id && String(req.user.mercearia_id) === String(req.params.mercearia_id)) return next();
  return res.status(403).json({ error: 'Acesso negado a este estabelecimento.' });
}

module.exports = { liberarComLicencaBloqueada, donoDaMerceariaOuSuperAdmin };
