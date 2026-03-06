// ===== routes/adminOperadoresRoutes.js =====
const express = require("express");
const router = express.Router();
const db = require("../db/supabaseAdmin"); // cliente SUPABASE ADMIN
const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage() });

/* ============================================================
   LISTAR OPERADORES DE UM ESTABELECIMENTO
   GET /admin/operadores/:estabelecimentoId
============================================================ */
router.get("/:estabelecimentoId", async (req, res) => {
  try {
    const { estabelecimentoId } = req.params;

    const { data, error } = await db
      .from("operadores")
      .select("*")
      .eq("mercearia_id", estabelecimentoId)
      .neq("status", "excluido")
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json(data || []);
  } catch (err) {
    console.error("Erro listar operadores:", err);
    res.status(500).json({ error: "Erro interno ao listar operadores" });
  }
});

/* ============================================================
   BUSCAR UM OPERADOR
   GET /admin/operadores/detalhes/:id
============================================================ */
router.get("/detalhes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await db
      .from("operadores")
      .select("*")
      .eq("id", id)
      .single();

    if (error)
      return res.status(404).json({ error: "Operador não encontrado" });

    res.json(data);
  } catch (err) {
    console.error("Erro buscar operador:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   CRIAR OPERADOR
   POST /admin/operadores/criar
============================================================ */
router.post("/criar", async (req, res) => {
  try {
    const { nome, email, telefone, senha, mercearia_id } = req.body;

    if (!email || !senha || !mercearia_id) {
      return res
        .status(400)
        .json({ error: "Dados obrigatórios não informados." });
    }

    /* ===============================
       VALIDAR EMAIL EXISTENTE
    =============================== */
    const { data: operadorExistente } = await db
      .from("operadores")
      .select("id,status")
      .eq("email", email)
      .maybeSingle();

    if (operadorExistente) {
      return res.status(400).json({
        error:
          "Já existe um operador cadastrado com este e-mail.",
      });
    }

    /* ===============================
       CRIAR USUÁRIO AUTH
    =============================== */
    const { data: userData, error: userErr } =
      await db.auth.admin.createUser({
        email,
        password: senha,
        email_confirm: true,
      });

    if (userErr) return res.status(400).json({ error: userErr.message });

    const userId = userData.user.id;

    /* ===============================
       INSERIR OPERADOR
    =============================== */
    const { data, error } = await db
      .from("operadores")
      .insert({
        id: userId,
        mercearia_id,
        nome,
        email,
        telefone,
        foto_url: null,
        status: "ativo",
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    /* ===============================
       ATUALIZAR PROFILE
    =============================== */
    await db
      .from("profiles")
      .update({
        role: "operator",
        mercearia_id,
        nome,
        email,
      })
      .eq("id", userId);

    res.json({
      success: true,
      operador: data,
    });
  } catch (err) {
    console.error("Erro criar operador:", err);
    res.status(500).json({ error: "Erro interno ao criar operador" });
  }
});

/* ============================================================
   EDITAR OPERADOR
   PUT /admin/operadores/:id
============================================================ */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, telefone, email, status } = req.body;

    const updateData = {
      nome,
      telefone,
      email,
    };

    if (status) updateData.status = status;

    const { data, error } = await db
      .from("operadores")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await db
      .from("profiles")
      .update({ nome, email })
      .eq("id", id);

    res.json({
      success: true,
      operador: data,
    });
  } catch (err) {
    console.error("Erro editar operador:", err);
    res.status(500).json({ error: "Erro interno ao editar operador" });
  }
});

/* ============================================================
   SOFT DELETE
============================================================ */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await db
      .from("operadores")
      .update({ status: "excluido" })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro excluir operador:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   RESTAURAR OPERADOR
============================================================ */
router.put("/:id/restaurar", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await db
      .from("operadores")
      .update({ status: "ativo" })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro restaurar operador:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   UPLOAD FOTO
============================================================ */
router.post("/:id/upload-foto", upload.single("foto"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file)
      return res.status(400).json({ error: "Arquivo não enviado." });

    const ext = req.file.originalname.split(".").pop();
    const filename = `operadores/${id}/${Date.now()}.${ext}`;

    const { error: uploadErr } = await db.storage
      .from("logos")
      .upload(filename, req.file.buffer, {
        upsert: true,
        contentType: req.file.mimetype,
      });

    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { data } = db.storage.from("logos").getPublicUrl(filename);

    await db
      .from("operadores")
      .update({ foto_url: data.publicUrl })
      .eq("id", id);

    res.json({ success: true, foto_url: data.publicUrl });
  } catch (err) {
    console.error("Erro upload foto:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   REMOVER FOTO
============================================================ */
router.delete("/:id/remover-foto", async (req, res) => {
  try {
    const { id } = req.params;

    const { data } = await db
      .from("operadores")
      .select("foto_url")
      .eq("id", id)
      .single();

    if (!data || !data.foto_url)
      return res.status(400).json({ error: "Não há foto para remover." });

    const baseUrl =
      `${process.env.SUPABASE_URL}/storage/v1/object/public/logos/`;

    const path = data.foto_url.replace(baseUrl, "");

    await db.storage.from("logos").remove([path]);

    await db
      .from("operadores")
      .update({ foto_url: null })
      .eq("id", id);

    res.json({ success: true });
  } catch (err) {
    console.error("Erro remover foto:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   RESETAR SENHA
============================================================ */
router.post("/:id/reset-senha", async (req, res) => {
  try {
    const { id } = req.params;
    const { senha } = req.body;

    if (!senha || senha.length < 6) {
      return res
        .status(400)
        .json({ error: "Senha inválida (mínimo 6 caracteres)" });
    }

    const { error } = await db.auth.admin.updateUserById(id, {
      password: senha,
    });

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro reset senha:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* ============================================================
   ATUALIZAR STATUS
============================================================ */
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["ativo", "inativo"].includes(status)) {
      return res.status(400).json({ error: "Status inválido" });
    }

    const { data, error } = await db
      .from("operadores")
      .update({ status })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json({
      success: true,
      operador: data,
    });
  } catch (err) {
    console.error("Erro atualizar status operador:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

module.exports = router;