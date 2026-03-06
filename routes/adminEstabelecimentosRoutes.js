const express = require("express");
const router = express.Router();
const db = require("../db/supabaseAdmin"); // Cliente SUPABASE ADMIN (service_role)
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// =======================================================
// LISTAR TODAS OS ESTABELECIMENTOS (ATIVAS)
// =======================================================
router.get("/listar", async (req, res) => {
  try {
    const { data, error } = await db
      .from("mercearias")
      .select("*")
      .neq("status_assinatura", "excluida")
      .order("created_at", { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.json(data);
  } catch (e) {
    console.error("Exception listar:", e);
    res.status(500).json({ error: "Erro ao listar estabelecimnento" });
  }
});

// =======================================================
// LISTAR ESTABELECIMENTOS EXCLUÍDAS
// =======================================================
router.get("/excluidas", async (req, res) => {
  try {
    const { data, error } = await db
      .from("mercearias")
      .select("*")
      .in("status_assinatura", [
        "excluida",
        "excluído",
        "Excluída",
        "EXCLUIDA"
      ])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Erro Supabase:", error);
      return res.status(400).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Erro listar excluídas:", err);
    res.status(500).json({ error: "Erro ao listar mercearias excluídas" });
  }
});

// =======================================================
// RESTAURAR ESTABELECIMENTO EXCLUÍDA
// =======================================================
router.put("/:id/restaurar", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await db
      .from("mercearias")
      .update({ status_assinatura: "ativa" })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (e) {
    console.error("Erro restaurar:", e);
    res.status(500).json({ error: "Erro ao restaurar mercearia" });
  }
});

// =======================================================
// OBTER UM ESTABELECIMENTO ESPECÍFICA
// =======================================================
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await db
      .from("mercearias")
      .select("*")
      .eq("id", id)
      .single();

    if (error) return res.status(404).json({ error: "Mercearia não encontrada" });

    res.json(data);
  } catch (e) {
    console.error("GET /:id error:", e);
    res.status(500).json({ error: "Erro ao buscar mercearia" });
  }
});

// =======================================================
// ATUALIZAR ESTABELECIMENTO
// =======================================================
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      nome_fantasia,
      cnpj,
      telefone,
      email_contato,
      endereco_completo,
      status_assinatura,
      data_vencimento,
      logo_url,
      tipo_estabelecimento
    } = req.body;

    const { data, error } = await db
      .from("mercearias")
      .update({
        nome_fantasia,
        cnpj,
        telefone,
        email_contato,
        endereco_completo,
        status_assinatura,
        data_vencimento,
        logo_url,
        tipo_estabelecimento
      })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, mercearia: data });

  } catch (e) {
    console.error("PUT /:id error:", e);
    res.status(500).json({ error: "Erro interno ao atualizar mercearia" });
  }
});

// =======================================================
// CRIAR ESTABELECIMENTO + USER
// =======================================================
router.post("/criar", async (req, res) => {
  try {
    const { nome, cnpj, telefone, email, senha, tipo_estabelecimento } = req.body;

    // Criar usuário no Auth
    const { data: userData, error: userErr } = await db.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });

    if (userErr) return res.status(400).json({ error: userErr.message });

    const userId = userData.user.id;

    // Criar ESTABELECIMENTO
    const { data: mercData, error: mercErr } = await db
      .from("mercearias")
      .insert({
        nome_fantasia: nome,
        cnpj,
        telefone,
        email_contato: email,
        status_assinatura: "ativa",
        logo_url: null,
        endereco_completo: null,
        data_vencimento: null,
        tipo_estabelecimento: tipo_estabelecimento || "mercearia"
      })
      .select()
      .single();

    if (mercErr) return res.status(400).json({ error: mercErr.message });

    // Atualizar profile
    const { error: profErr } = await db
      .from("profiles")
      .update({
        role: "merchant",
        mercearia_id: mercData.id,
        email,
        nome,
      })
      .eq("id", userId);

    if (profErr) return res.status(400).json({ error: profErr.message });

    res.json({ success: true, estabelecimentoId: mercData.id });

  } catch (err) {
    console.error("POST criar error:", err);
    res.status(500).json({ error: "Erro interno ao criar mercearia" });
  }
});

// =======================================================
// UPLOAD DE LOGO
// =======================================================
router.post("/:id/upload-logo", upload.single("logo"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });

    const ext = req.file.originalname.split(".").pop();
    const nomeArquivo = `logos/${id}/${Date.now()}.${ext}`;

    const { error: uploadErr } = await db.storage
      .from("logos")
      .upload(nomeArquivo, req.file.buffer, {
        upsert: true,
        contentType: req.file.mimetype,
      });

    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { data: urlData } = db.storage.from("logos").getPublicUrl(nomeArquivo);

    const url = urlData.publicUrl;

    await db.from("mercearias").update({ logo_url: url }).eq("id", id);

    res.json({ success: true, logo_url: url });

  } catch (err) {
    console.error("UPLOAD LOGO error:", err);
    res.status(500).json({ error: "Erro interno ao enviar logo" });
  }
});

// =======================================================
// REMOVER LOGO
// =======================================================
router.delete("/:id/remover-logo", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: merc } = await db
      .from("mercearias")
      .select("logo_url")
      .eq("id", id)
      .single();

    if (!merc || !merc.logo_url)
      return res.status(400).json({ error: "Não há logo para remover." });

    const baseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/logos/`;
    const path = merc.logo_url.replace(baseUrl, "");

    await db.storage.from("logos").remove([path]);

    await db.from("mercearias").update({ logo_url: null }).eq("id", id);

    res.json({ success: true });

  } catch (err) {
    console.error("REMOVER LOGO error:", err);
    res.status(500).json({ error: "Erro interno ao remover logo" });
  }
});

// =======================================================
// SOFT DELETE (enviar para "excluída")
// =======================================================
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await db
      .from("mercearias")
      .update({ status_assinatura: "excluida" })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });

  } catch (err) {
    console.error("DELETE error:", err);
    res.status(500).json({ error: "Erro ao excluir mercearia" });
  }
});

// =======================================================
// EXCLUSÃO PERMANENTE (BACKUP + REMOÇÃO DEFINITIVA)
// =======================================================
router.delete("/:id/apagar-definitivo", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: merc, error: errBusca } = await db
      .from("mercearias")
      .select("*")
      .eq("id", id)
      .single();

    if (errBusca || !merc)
      return res.status(400).json({ error: "Mercearia não encontrada" });

    const { error: backupErr } = await db
      .from("mercearias_backup")
      .insert({
        mercearia_id: id,
        dados: merc,
      });

    if (backupErr) return res.status(400).json({ error: "Erro ao salvar backup" });

    if (merc.logo_url) {
      const baseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/logos/`;
      const path = merc.logo_url.replace(baseUrl, "");

      await db.storage.from("logos").remove([path]);
    }

    const { error: delErr } = await db
      .from("mercearias")
      .delete()
      .eq("id", id);

    if (delErr) return res.status(400).json({ error: "Erro ao apagar definitivamente" });

    res.json({ success: true });

  } catch (err) {
    console.error("APAGAR DEFINITIVO error:", err);
    res.status(500).json({ error: "Erro interno ao apagar definitivamente" });
  }
});

module.exports = router;