const express = require("express");
const router = express.Router();
const db = require("../db/supabaseAdmin"); // Cliente SUPABASE ADMIN (service_role)
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const authUser = require("../middlewares/authUser");
const { registrar } = require("./auditoriaRoutes");

// ⚠️ NOTA: as demais rotas deste arquivo (listar, criar, editar, excluir,
// limite-operadores, upload-logo) ainda não exigem authUser porque o
// frontend correspondente (NovoEstabelecimento/EditarEstabelecimento/
// Excluidas) ainda não envia o Bearer token. Aplicado authUser apenas
// em bloquear-acesso e liberar-acesso, que já são chamadas com token
// pelo DashboardAdmin.jsx e DetalhesEstabelecimento.jsx.

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
router.put("/:id/restaurar", authUser, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await db
      .from("mercearias")
      .update({ status_assinatura: "ativa" })
      .eq("id", id)
      .select("nome_fantasia")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "restaurar_estabelecimento",
      descricao:     `Restaurou o estabelecimento "${data.nome_fantasia}"`,
      escopo:        "admin_global",
    });

    res.json({ success: true });
  } catch (e) {
    console.error("Erro restaurar:", e);
    res.status(500).json({ error: "Erro ao restaurar mercearia" });
  }
});

// =======================================================
// BLOQUEAR ACESSO MANUALMENTE (SuperAdmin)
// POST /api/admin/estabelecimentos/:id/bloquear-acesso
// Motivo é OBRIGATÓRIO — vai para liberacoes_licenca e auditoria
// =======================================================
router.post("/:id/bloquear-acesso", authUser, async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const { id } = req.params;
    const motivo = (req.body.motivo || "").trim();

    if (motivo.length < 3) {
      return res.status(400).json({ error: "Informe o motivo do bloqueio (mínimo 3 caracteres)." });
    }

    const { data, error } = await db
      .from("mercearias")
      .update({ status_assinatura: "bloqueada" })
      .eq("id", id)
      .select("nome_fantasia, data_vencimento")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const hoje = new Date().toISOString().split("T")[0];
    const nomeUsuario = req.user.nome || req.user.email;

    // Histórico de licença — aparece junto com as liberações
    await db.from("liberacoes_licenca").insert({
      mercearia_id:    id,
      dias:             0,
      data_inicio:      hoje,
      data_vencimento:  data.data_vencimento || hoje,
      forma_pagamento:  "bloqueio_manual",
      motivo,
      liberado_por:     nomeUsuario,
      liberado_por_id:  req.user.id,
    });

    // Auditoria geral do painel admin
    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "bloquear_acesso",
      descricao:     `Bloqueou acesso de "${data.nome_fantasia}" — motivo: ${motivo}`,
      meta:          { mercearia_id: id, motivo },
      escopo:        "admin_global",
    });

    console.log(`🔴 Acesso bloqueado: ${data.nome_fantasia} — ${motivo} (por ${nomeUsuario})`);
    res.json({ success: true, nome_fantasia: data.nome_fantasia });
  } catch (err) {
    console.error("BLOQUEAR ACESSO error:", err);
    res.status(500).json({ error: "Erro interno ao bloquear acesso." });
  }
});

// =======================================================
// LIBERAR ACESSO MANUALMENTE (SuperAdmin)
// POST /api/admin/estabelecimentos/:id/liberar-acesso
// =======================================================
router.post("/:id/liberar-acesso", authUser, async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const { id } = req.params;
    const {
      dias            = 30,
      motivo          = "",
      forma_pagamento = "manual",
    } = req.body;
    // Usa sempre o usuário autenticado — não confia no que o frontend mandar
    const liberado_por    = req.user.nome || req.user.email;
    const liberado_por_id = req.user.id;

    const diasNum = parseInt(dias);
    if (isNaN(diasNum) || diasNum < 1 || diasNum > 3650) {
      return res.status(400).json({ error: "Período inválido (1–3650 dias)." });
    }

    // Calcular nova data de vencimento
    // Se já tem data futura, acumula; senão começa de hoje
    const { data: mercAtual } = await db
      .from("mercearias")
      .select("data_vencimento, nome_fantasia")
      .eq("id", id)
      .single();

    const base = mercAtual?.data_vencimento &&
      new Date(mercAtual.data_vencimento + "T12:00:00") > new Date()
        ? new Date(mercAtual.data_vencimento + "T12:00:00")
        : new Date();

    const dataInicio = new Date().toISOString().split("T")[0];
    base.setDate(base.getDate() + diasNum);
    const dataVencimento = base.toISOString().split("T")[0];

    // Atualizar licença
    const { data, error } = await db
      .from("mercearias")
      .update({
        status_assinatura: "ativa",
        data_vencimento:   dataVencimento,
      })
      .eq("id", id)
      .select("nome_fantasia")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Registrar no histórico de liberações
    await db.from("liberacoes_licenca").insert({
      mercearia_id:    id,
      dias:            diasNum,
      data_inicio:     dataInicio,
      data_vencimento: dataVencimento,
      forma_pagamento: forma_pagamento,
      motivo:          motivo || null,
      liberado_por:    liberado_por,
      liberado_por_id: liberado_por_id || null,
    });

    console.log(`✅ Acesso liberado: ${data.nome_fantasia} | ${diasNum}d | ${forma_pagamento} | ${liberado_por} | ${motivo || "sem motivo"}`);

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "liberar_acesso",
      descricao:     `Liberou acesso de "${data.nome_fantasia}" por ${diasNum} dia(s) (${forma_pagamento})${motivo ? " — " + motivo : ""}`,
      meta:          { mercearia_id: id, dias: diasNum, forma_pagamento, motivo },
      escopo:        "admin_global",
    });

    res.json({
      success:          true,
      data_vencimento:  dataVencimento,
      dias:             diasNum,
      nome_fantasia:    data.nome_fantasia,
    });
  } catch (err) {
    console.error("LIBERAR ACESSO error:", err);
    res.status(500).json({ error: "Erro interno ao liberar acesso." });
  }
});

// =======================================================
// MARCAR COBRANÇA MANUAL COMO ENVIADA (módulo de Cobranças)
// POST /api/admin/estabelecimentos/:id/marcar-cobrado
// Chamado pelo frontend logo depois de abrir o WhatsApp/e-mail —
// tira o estabelecimento da lista de cobrança até o dia seguinte.
// =======================================================
router.post("/:id/marcar-cobrado", authUser, async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ error: "Acesso negado." });
    }

    const { id } = req.params;
    const { canal = "whatsapp", desfazer = false } = req.body; // canal só informativo, pra auditoria

    const agora = desfazer ? null : new Date().toISOString();

    const { data, error } = await db
      .from("mercearias")
      .update({ cobranca_manual_em: agora })
      .eq("id", id)
      .select("nome_fantasia")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          desfazer ? "cobranca_manual_desfeita" : "cobranca_manual_enviada",
      descricao:     desfazer
        ? `Desfez a marcação de cobrado de "${data.nome_fantasia}"`
        : `Marcou "${data.nome_fantasia}" como cobrado (${canal})`,
      meta:          { mercearia_id: id, canal },
      escopo:        "admin_global",
    });

    res.json({ success: true, cobranca_manual_em: agora });
  } catch (err) {
    console.error("MARCAR COBRADO error:", err);
    res.status(500).json({ error: "Erro interno ao marcar cobrança." });
  }
});

// =======================================================
// HISTÓRICO DE LIBERAÇÕES DE UM ESTABELECIMENTO
// GET /api/admin/estabelecimentos/:id/liberacoes
// =======================================================
router.get("/:id/liberacoes", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await db
      .from("liberacoes_licenca")
      .select("*")
      .eq("mercearia_id", id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("LIBERACOES error:", err);
    res.status(500).json({ error: "Erro ao buscar histórico." });
  }
});

// =======================================================
// LIMITE DE OPERADORES (deve vir ANTES de /:id)
// =======================================================

/* PUT /api/admin/estabelecimentos/:id/limite-operadores */
router.put("/:id/limite-operadores", authUser, async (req, res) => {
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

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "editar_limite_operadores",
      descricao:     `Alterou o limite de operadores para ${limite_val}`,
      meta:          { limite: limite_val },
      escopo:        "admin_global",
    });

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
router.put("/:id", authUser, async (req, res) => {
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
      valor_mensalidade,
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
    // Valor individual de mensalidade (null = usar padrão global)
    updateData.valor_mensalidade = valor_mensalidade ? parseFloat(valor_mensalidade) : null;

    const { data, error } = await db
      .from("mercearias")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "editar_estabelecimento",
      descricao:     `Editou os dados de "${data.nome_fantasia}"`,
      meta:          { campos: Object.keys(updateData) },
      escopo:        "admin_global",
    });

    res.json({ success: true, mercearia: data });

  } catch (e) {
    console.error("PUT /:id error:", e);
    res.status(500).json({ error: "Erro interno ao atualizar mercearia" });
  }
});

// =======================================================
// CRIAR ESTABELECIMENTO + USER (🔥 CORRIGIDO)
// =======================================================
router.post("/criar", authUser, async (req, res) => {
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
      valor_mensalidade,
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
        limite_operadores:    parseInt(limite_operadores) || 3,
        valor_mensalidade:    valor_mensalidade ? parseFloat(valor_mensalidade) : null,
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

    await registrar({
      mercearia_id:  mercData.id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "criar_estabelecimento",
      descricao:     `Criou o estabelecimento "${nome_fantasia}"`,
      escopo:        "admin_global",
    });

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
router.post("/:id/upload-logo", authUser, upload.single("logo"), async (req, res) => {
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

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "atualizar_logo",
      descricao:     "Atualizou a logo do estabelecimento",
      escopo:        "admin_global",
    });

    res.json({ success: true, logo_url: url });

  } catch (err) {
    console.error("UPLOAD LOGO error:", err);
    res.status(500).json({ error: "Erro interno ao enviar logo" });
  }
});

// =======================================================
// REMOVER LOGO
// =======================================================
router.delete("/:id/remover-logo", authUser, async (req, res) => {
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

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "remover_logo",
      descricao:     "Removeu a logo do estabelecimento",
      escopo:        "admin_global",
    });

    res.json({ success: true });

  } catch (err) {
    console.error("REMOVER LOGO error:", err);
    res.status(500).json({ error: "Erro interno ao remover logo" });
  }
});

// =======================================================
// SOFT DELETE
// =======================================================
router.delete("/:id", authUser, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await db
      .from("mercearias")
      .update({ status_assinatura: "excluida" })
      .eq("id", id)
      .select("nome_fantasia")
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await registrar({
      mercearia_id:  id,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "excluir_estabelecimento",
      descricao:     `Excluiu (soft delete) o estabelecimento "${data.nome_fantasia}"`,
      escopo:        "admin_global",
    });

    res.json({ success: true });

  } catch (err) {
    console.error("DELETE error:", err);
    res.status(500).json({ error: "Erro ao excluir mercearia" });
  }
});

// =======================================================
// EXCLUSÃO PERMANENTE
// =======================================================
router.delete("/:id/apagar-definitivo", authUser, async (req, res) => {
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

    // mercearia_id: null porque a linha acabou de ser apagada (evita erro de FK)
    await registrar({
      mercearia_id:  null,
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        "estabelecimentos",
      acao:          "apagar_definitivo_estabelecimento",
      descricao:     `Apagou definitivamente o estabelecimento "${merc.nome_fantasia}"`,
      meta:          { mercearia_id_excluida: id },
      escopo:        "admin_global",
    });

    res.json({ success: true });

  } catch (err) {
    console.error("APAGAR DEFINITIVO error:", err);
    res.status(500).json({ error: "Erro interno ao apagar definitivamente" });
  }
});

module.exports = router;