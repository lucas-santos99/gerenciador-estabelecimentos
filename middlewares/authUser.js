const jwt = require("jsonwebtoken");
const createSupabaseUserClient = require("../db/supabaseUser");
const supabaseAdmin = require("../db/supabaseAdmin");

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

    const userId = decoded.sub;

    // 🔥 cria client com token (para uso nas rotas)
    req.supabase = createSupabaseUserClient(token);

    // 🔥 BUSCA PROFILE COM ADMIN (IGNORA RLS)
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return res.status(403).json({ error: "Perfil não encontrado" });
    }

    // 🚨 BLOQUEIO REAL DE USUÁRIO INATIVO
    if (!profile.is_active) {
      return res.status(403).json({
        error: "Usuário inativo. Contate o administrador."
      });
    }

    // 🔥 monta usuário completo
    req.user = {
      id: profile.id,
      email: profile.email,
      role: profile.role,
      is_master: profile.is_master,
    };

    req.userToken = token;

    next();

  } catch (err) {
    console.error("ERRO GERAL authUser:", err);
    return res.status(500).json({ error: "Erro interno geral" });
  }
};