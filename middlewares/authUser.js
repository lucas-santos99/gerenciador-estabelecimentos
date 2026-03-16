module.exports = function authUser(req, res, next) {

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Token não enviado" });
  }

  const token = authHeader.replace("Bearer ", "");

  req.userToken = token;

  next();
};