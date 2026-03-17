const jwt = require("jsonwebtoken");
const createSupabaseUserClient = require("../db/supabaseUser");

module.exports = async function authUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Token não enviado" });
    }

    const token = authHeader.replace("Bearer ", "");

    let decoded;

    try {
      decoded = jwt.decode(token);
    } catch (e) {
      console.error("Erro ao decodificar token:", e);
      return res.status(401).json({ error: "Token inválido" });
    }

    if (!decoded || !decoded.sub) {
      return res.status(401).json({ error: "Token inválido" });
    }

    console.log("USER ID:", decoded.sub);

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };

    req.userToken = token;

    try {
      req.supabase = createSupabaseUserClient(token);
    } catch (e) {
      console.error("Erro ao criar supabase client:", e);
      return res.status(500).json({ error: "Erro interno (supabase)" });
    }

    next();

  } catch (err) {
    console.error("ERRO GERAL authUser:", err);
    return res.status(500).json({ error: "Erro interno geral" });
  }
};