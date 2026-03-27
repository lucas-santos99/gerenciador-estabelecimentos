const express = require("express");
const router = express.Router();
// 🔥 PROTEGE TODAS AS ROTAS
router.use(authUser);

const db = require("../db/supabaseAdmin"); // usado para rotas ADMIN
const authUser = require("../middlewares/authUser");
const createSupabaseUserClient = require("../db/supabaseUser");

const { v4: uuidv4 } = require("uuid");

/* ============================================================
   FUNÇÕES AUXILIARES
   ============================================================ */

async function buscarOperadorPorId(id) {
  const { data, error } = await db
    .from("operadores")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;

  return data;
}

/* ============================================================
   1) LISTAR OPERADORES (ADMIN)
   ============================================================ */

router.get("/admin/operadores/:estabelecimentoId", async (req, res) => {

  const { estabelecimentoId } = req.params;

  try {

    const { data, error } = await db
      .from("operadores")
      .select("id, mercearia_id, nome, email, telefone, status, created_at")
      .eq("mercearia_id", estabelecimentoId)
      .order("nome", { ascending: true });

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao listar operadores"
    });

  }

});

/* ============================================================
   2) DETALHES OPERADOR
   ============================================================ */

router.get("/admin/operadores/detalhes/:id", async (req, res) => {

  const { id } = req.params;

  try {

    const op = await buscarOperadorPorId(id);

    if (!op) {
      return res.status(404).json({
        error: "Operador não encontrado"
      });
    }

    res.json(op);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao buscar operador"
    });

  }

});

/* ============================================================
   3) CRIAR OPERADOR (ADMIN)
   ============================================================ */

router.post("/admin/operadores/criar", async (req, res) => {

  const { mercearia_id, nome, email, telefone } = req.body;

  if (!nome || !email) {
    return res.status(400).json({
      error: "Nome e email são obrigatórios"
    });
  }

  try {

    const newId = uuidv4();

    const { error } = await db
      .from("operadores")
      .insert({
        id: newId,
        mercearia_id,
        nome,
        email,
        telefone: telefone || null,
        status: "ativo"
      });

    if (error) throw error;

    res.status(201).json({
      sucesso: true,
      id: newId
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao criar operador"
    });

  }

});

/* ============================================================
   4) EDITAR OPERADOR (ADMIN)
   ============================================================ */

router.put("/admin/operadores/:id", async (req, res) => {

  const { id } = req.params;
  const { nome, email, telefone, status } = req.body;

  try {

    const { error } = await db
      .from("operadores")
      .update({
        nome,
        email,
        telefone,
        status
      })
      .eq("id", id);

    if (error) throw error;

    res.json({
      sucesso: true
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao editar operador"
    });

  }

});

/* ============================================================
   5) ALTERAR STATUS (ADMIN)
   ============================================================ */

router.put("/admin/operadores/:id/status", async (req, res) => {

  const { id } = req.params;
  const { status } = req.body;

  if (!["ativo", "inativo"].includes(status)) {
    return res.status(400).json({
      error: "Status inválido"
    });
  }

  try {

    const { error } = await db
      .from("operadores")
      .update({ status })
      .eq("id", id);

    if (error) throw error;

    res.json({
      sucesso: true
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao atualizar status"
    });

  }

});

/* ============================================================
   6) EXCLUIR OPERADOR (ADMIN)
   ============================================================ */

router.delete("/admin/operadores/:id", async (req, res) => {

  const { id } = req.params;

  try {

    const { error } = await db
      .from("operadores")
      .delete()
      .eq("id", id);

    if (error) throw error;

    res.json({
      sucesso: true
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao excluir operador"
    });

  }

});

/* ============================================================
   7) LISTAR OPERADORES DA MERCEARIA (MERCHANT)
   ============================================================ */

router.get("/operadores", authUser, async (req, res) => {

  const supabase = createSupabaseUserClient(req.userToken);

  try {

    const { data, error } = await supabase
      .from("operadores")
      .select("id, nome, email, telefone, status, created_at")
      .order("nome", { ascending: true });

    if (error) throw error;

    res.json(data);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao listar operadores da mercearia"
    });

  }

});

/* ============================================================
   8) CRIAR OPERADOR (MERCHANT)
   ============================================================ */

router.post("/operadores/criar", authUser, async (req, res) => {

  const supabase = createSupabaseUserClient(req.userToken);

  const { nome, email, telefone } = req.body;

  if (!nome || !email) {
    return res.status(400).json({
      error: "Nome e email são obrigatórios"
    });
  }

  try {

    const newId = uuidv4();

    const { error } = await supabase
      .from("operadores")
      .insert({
        id: newId,
        nome,
        email,
        telefone: telefone || null,
        status: "ativo"
      });

    if (error) throw error;

    res.status(201).json({
      sucesso: true,
      id: newId
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Erro ao criar operador"
    });

  }

});

/* ============================================================
   DIAGNÓSTICO USUÁRIO
   ============================================================ */

router.post("/diagnostico", async (req, res) => {

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: "E-mail não informado"
    });
  }

  try {

    const { data: operador } = await db
      .from("operadores")
      .select("status")
      .eq("email", email)
      .maybeSingle();

    if (operador) {
      return res.json({
        tipo: "operador",
        status: operador.status
      });
    }

    const { data: mercearia } = await db
      .from("mercearias")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (mercearia) {
      return res.json({
        tipo: "mercearia"
      });
    }

    return res.json({
      tipo: "admin"
    });

  } catch (err) {

    console.error("Erro diagnóstico usuário:", err);

    res.status(500).json({
      error: "Erro interno no diagnóstico"
    });

  }

});

module.exports = router;