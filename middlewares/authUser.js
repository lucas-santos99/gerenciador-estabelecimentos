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

  // 🔥 cria client com token
req.supabase = createSupabaseUserClient(token);

// 🔍 busca profile no banco
const { data: profile, error } = await req.supabase
  .from('profiles')
  .select('role')
  .eq('id', decoded.sub)
  .single();

if (error || !profile) {
  return res.status(403).json({ error: "Perfil não encontrado" });
}

// 🔥 agora sim user completo
req.user = {
  id: decoded.sub,
  email: decoded.email,
  role: profile.role,
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