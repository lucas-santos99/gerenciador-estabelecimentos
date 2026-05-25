const express = require("express");
const router = express.Router();
const db = require("../db/supabaseAdmin"); // Cliente SUPABASE ADMIN (service_role)
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// =======================================================
// 🔴 FUNÇÃO: BLOQUEAR VENCIDOS AUTOMATICAMENTE
// =======================================================
async function verificarVencimentos() {
  try {
    const { data, error } = await db
      .from("mercearias")
      .select("id, data_vencimento, status_assinatura");

    if (error) return;

    const hoje = new Date();

    for (const m of data) {
      if (!m.data_vencimento) continue;

      const venc = new Date(m.data_vencimento);

      if (venc < hoje && m.status_assinatura === "ativa") {
        await db
          .from("mercearias")
          .update({ status_assinatura: "bloqueada" })
          .eq("id", m.id);
      }
    }
  } catch (err) {
    console.error("Erro verificar vencimentos:", err);
  }
}

// =======================================================
// LISTAR TODAS OS ESTABELECIMENTOS (ATIVAS)
// =======================================================
router.get("/listar", async (req, res) => {
  try {
    await verificarVencimentos(); // ✅ LINHA NOVA
    
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
// LIMITE DE OPERADORES (deve vir ANTES de /:id)
// =======================================================

/* PUT /api/admin/estabelecimentos/:id/limite-operadores */
router.put("/:id/limite-operadores", async (req, res) => {
  try {
    const { id } = req.params;
    const { limite } = req.body;

    const limiteNum = parseInt(limite);
    if (isNaN(limiteNum) || limiteNum < 0 || limiteNum > 50) {
      return res.status(400).json({ error: "Limite inválido (0–50)" });
    }
    const limite_val = limiteNum;

    const { error } = await db
      .from("mercearias")
      .update({ limite_operadores: limite_val })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true, limite: limite_val });
  } catch (err) {
    console.error("Erro atualizar limite operadores:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

/* GET /api/admin/estabelecimentos/:id/limite-operadores */
router.get("/:id/limite-operadores", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: merc, error: mercErr } = await db
      .from("mercearias")
      .select("limite_operadores")
      .eq("id", id)
      .single();

    if (mercErr) return res.status(400).json({ error: mercErr.message });

    const { count } = await db
      .from("operadores")
      .select("id", { count: "exact", head: true })
      .eq("mercearia_id", id)
      .neq("status", "excluido");

    res.json({
      limite:     merc.limite_operadores ?? 3,
      total:      count ?? 0,
      pode_criar: (count ?? 0) < (merc.limite_operadores ?? 3),
    });
  } catch (err) {
    console.error("Erro buscar limite:", err);
    res.status(500).json({ error: "Erro interno" });
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
      tipo_estabelecimento,
      limite_operadores,
    } = req.body;

    const updateData = {
      nome_fantasia,
      cnpj,
      telefone,
      email_contato,
      endereco_completo,
      status_assinatura,
      data_vencimento,
      logo_url,
      tipo_estabelecimento,
    };

    // Atualiza limite apenas se enviado e válido
    if (typeof limite_operadores === 'number' && limite_operadores >= 0 && limite_operadores <= 50) {
      updateData.limite_operadores = limite_operadores;
    }

    const { data, error } = await db
      .from("mercearias")
      .update(updateData)
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
// CRIAR ESTABELECIMENTO + USER (🔥 CORRIGIDO)
// =======================================================
router.post("/criar", async (req, res) => {
  try {

    const {
      nome_fantasia,
      cnpj,
      telefone,
      email_contato,
      endereco_completo,
      data_vencimento,
      status_assinatura,
      tipo_estabelecimento,
      senha,
      limite_operadores,
    } = req.body;

    // validação da senha
    if (!senha || senha.length < 6) {
      return res.status(400).json({
        error: "Senha deve ter no mínimo 6 caracteres."
      });
    }

    // 1️⃣ Criar usuário no Auth
    const { data: userData, error: userErr } =
      await db.auth.admin.createUser({
        email: email_contato,
        password: senha,
        email_confirm: true
      });

    if (userErr) {
      return res.status(400).json({ error: userErr.message });
    }

    const userId = userData.user.id;

    // 2️⃣ Criar estabelecimento (✅ AGORA SALVA ENDEREÇO)
    const { data: mercData, error: mercErr } = await db
      .from("mercearias")
      .insert({
        nome_fantasia,
        cnpj,
        telefone,
        email_contato,
        endereco_completo: endereco_completo || null,
        status_assinatura: status_assinatura || "ativa",
        logo_url: null,
        data_vencimento: data_vencimento || null,
        tipo_estabelecimento: tipo_estabelecimento || "mercearia",
        limite_operadores: parseInt(limite_operadores) || 3,
      })
      .select()
      .single();

    if (mercErr) {
      return res.status(400).json({ error: mercErr.message });
    }

    // 3️⃣ Atualizar JWT (app_metadata)
    await db.auth.admin.updateUserById(userId, {
      app_metadata: {
        mercearia_id: mercData.id,
        role: "merchant"
      }
    });

    // 4️⃣ Atualizar profile
    const { error: profErr } = await db
      .from("profiles")
      .update({
        role: "merchant",
        mercearia_id: mercData.id,
        email: email_contato,
        nome: nome_fantasia
      })
      .eq("id", userId);

    if (profErr) {
      return res.status(400).json({ error: profErr.message });
    }

    res.json({
      success: true,
      estabelecimentoId: mercData.id
    });

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
// SOFT DELETE
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
// EXCLUSÃO PERMANENTE
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