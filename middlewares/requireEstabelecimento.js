// middlewares/requireEstabelecimento.js

const db = require("../db/supabaseAdmin");

async function requireEstabelecimento(req, res, next) {
  try {

    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(401).json({ error: "Usuário não autenticado" });
    }

    const { data, error } = await db
      .from("profiles")
      .select("mercearia_id")
      .eq("id", userId)
      .single();

    if (error || !data) {
      return res.status(403).json({ error: "Estabelecimento não encontrado" });
    }

    req.merceariaId = data.mercearia_id;

    next();

  } catch (err) {
    console.error("Middleware estabelecimento:", err);
    res.status(500).json({ error: "Erro interno" });
  }
}

module.exports = requireEstabelecimento;