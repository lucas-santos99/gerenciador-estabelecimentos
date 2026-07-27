// middlewares/requireEstabelecimento.js

const db = require("../db/supabaseAdmin");

async function requireEstabelecimento(req, res, next) {
  try {

    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(401).json({ error: "Usuário não autenticado" });
    }

    // SuperAdmin bypassa verificação de licença — acesso irrestrito
    if (req.user?.is_superadmin) {
      req.merceariaId = req.user.mercearia_id || null;
      return next();
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

    // ── Licença bloqueada: barra ações que ALTERAM algo (venda, editar
    // estoque, lançar compra, etc.), mesmo que a pessoa já esteja com a
    // aba aberta há dias sem dar F5. GET continua liberado de propósito
    // — é o que a própria tela usa pra descobrir que está bloqueada e
    // redirecionar pro /bloqueado; travar isso junto deixaria a pessoa
    // presa numa tela sem conseguir nem carregar o motivo do bloqueio.
    const metodosQueAlteramAlgo = ["POST", "PUT", "PATCH", "DELETE"];
    if (data.mercearia_id && metodosQueAlteramAlgo.includes(req.method)) {
      const { data: merc } = await db
        .from("mercearias")
        .select("status_assinatura")
        .eq("id", data.mercearia_id)
        .single();

      if (merc?.status_assinatura === "bloqueada") {
        return res.status(402).json({
          error: "Licença bloqueada. Renove a assinatura para continuar usando o sistema.",
          licenca_bloqueada: true,
        });
      }
    }

    next();

  } catch (err) {
    console.error("Middleware estabelecimento:", err);
    res.status(500).json({ error: "Erro interno" });
  }
}

module.exports = requireEstabelecimento;