// routes/operadoresRoutes.js
const express = require("express");
const router  = express.Router();

const db        = require("../db/supabaseAdmin");
const authUser  = require("../middlewares/authUser");
const verificarPermissao = require("../middlewares/verificarPermissao");
const { PERMISSOES } = require("../utils/permissoes");

// Todas as rotas deste arquivo exigem autenticação
router.use(authUser);

/* ============================================================
   HELPER — garante que o req.user é merchant e dono do operador
============================================================ */
async function garantirDono(operadorId, merceariaId) {
  const { data, error } = await db
    .from("operadores")
    .select("mercearia_id")
    .eq("id", operadorId)
    .single();
  if (error || !data) throw new Error("Operador não encontrado");
  if (data.mercearia_id !== merceariaId) throw new Error("Sem permissão");
}

/* ============================================================
   1) LISTAR OPERADORES DA MERCEARIA (MERCHANT)
   GET /api/operadores
============================================================ */
router.get("/", async (req, res) => {
  try {
    const { mercearia_id } = req.user;
    if (!mercearia_id) return res.status(403).json({ error: "Sem mercearia associada" });

    const { data, error } = await db
      .from("operadores")
      .select("id, nome, email, telefone, foto_url, status, created_at")
      .eq("mercearia_id", mercearia_id)
      .neq("status", "excluido")
      .order("nome", { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Erro listar operadores:", err);
    res.status(500).json({ error: "Erro ao listar operadores" });
  }
});

/* ============================================================
   2) CRIAR OPERADOR (MERCHANT)
   POST /api/operadores/criar
============================================================ */
router.post("/criar", async (req, res) => {
  try {
    const { mercearia_id } = req.user;
    if (!mercearia_id) return res.status(403).json({ error: "Sem mercearia associada" });

    const { nome, email, telefone, senha, permissoes } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
    }
    if (senha.length < 6) {
      return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres" });
    }

    /* ── Verificar limite ── */
    const { data: merc } = await db
      .from("mercearias")
      .select("limite_operadores")
      .eq("id", mercearia_id)
      .single();

    const { count } = await db
      .from("operadores")
      .select("id", { count: "exact", head: true })
      .eq("mercearia_id", mercearia_id)
      .neq("status", "excluido");

    const limite = merc?.limite_operadores ?? 3;
    if ((count ?? 0) >= limite) {
      return res.status(400).json({
        error: `Limite de ${limite} operador(es) atingido. Contate o administrador para aumentar o limite.`,
      });
    }

    /* ── Verificar email duplicado ── */
    const { data: existe } = await db
      .from("operadores")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existe) {
      return res.status(400).json({ error: "Já existe um operador com este e-mail." });
    }

    /* ── Criar usuário no Auth ── */
    const { data: userData, error: userErr } = await db.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });

    if (userErr) return res.status(400).json({ error: userErr.message });

    const userId = userData.user.id;

    /* ── Inserir operador ── */
    const { data: operador, error: opErr } = await db
      .from("operadores")
      .insert({
        id:          userId,
        mercearia_id,
        nome,
        email,
        telefone:    telefone || null,
        foto_url:    null,
        status:      "ativo",
      })
      .select()
      .single();

    if (opErr) return res.status(400).json({ error: opErr.message });

    /* ── Atualizar profile ── */
    await db
      .from("profiles")
      .update({ role: "operator", mercearia_id, nome, email })
      .eq("id", userId);

    /* ── Salvar permissões (se enviadas) ── */
    if (Array.isArray(permissoes) && permissoes.length > 0) {
      await db
        .from("permissoes_operador")
        .insert(permissoes.map(permissao_id => ({ operador_id: userId, permissao_id })));
    }

    res.status(201).json({ success: true, operador });
  } catch (err) {
    console.error("Erro criar operador:", err);
    res.status(500).json({ error: "Erro ao criar operador" });
  }
});

/* ============================================================
   3) EDITAR OPERADOR (MERCHANT)
   PUT /api/operadores/:id
============================================================ */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;

    await garantirDono(id, mercearia_id);

    const { nome, telefone, email } = req.body;

    const { data, error } = await db
      .from("operadores")
      .update({ nome, telefone, email })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    await db.from("profiles").update({ nome, email }).eq("id", id);

    res.json({ success: true, operador: data });
  } catch (err) {
    console.error("Erro editar operador:", err);
    res.status(500).json({ error: err.message || "Erro ao editar operador" });
  }
});

/* ============================================================
   4) ALTERAR STATUS (MERCHANT) — ativo / inativo
   PUT /api/operadores/:id/status
============================================================ */
router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;
    const { status } = req.body;

    if (!["ativo", "inativo"].includes(status)) {
      return res.status(400).json({ error: "Status inválido" });
    }

    await garantirDono(id, mercearia_id);

    const { error } = await db
      .from("operadores")
      .update({ status })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro alterar status:", err);
    res.status(500).json({ error: err.message || "Erro ao alterar status" });
  }
});

/* ============================================================
   5) EXCLUIR OPERADOR (MERCHANT) — soft delete
   DELETE /api/operadores/:id
============================================================ */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;

    await garantirDono(id, mercearia_id);

    const { error } = await db
      .from("operadores")
      .update({ status: "excluido" })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error("Erro excluir operador:", err);
    res.status(500).json({ error: err.message || "Erro ao excluir operador" });
  }
});

/* ============================================================
   6) LISTAR PERMISSÕES DO OPERADOR (MERCHANT)
   GET /api/operadores/:id/permissoes
============================================================ */
router.get("/:id/permissoes", async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;

    await garantirDono(id, mercearia_id);

    const { data, error } = await db
      .from("permissoes_operador")
      .select("permissao_id")
      .eq("operador_id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json((data || []).map(p => p.permissao_id));
  } catch (err) {
    console.error("Erro listar permissões:", err);
    res.status(500).json({ error: err.message || "Erro ao listar permissões" });
  }
});

/* ============================================================
   7) SALVAR PERMISSÕES DO OPERADOR (MERCHANT)
   PUT /api/operadores/:id/permissoes
============================================================ */
router.put("/:id/permissoes", async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;
    const { permissoes } = req.body;

    if (!Array.isArray(permissoes)) {
      return res.status(400).json({ error: "permissoes deve ser um array" });
    }

    await garantirDono(id, mercearia_id);

    // Remove tudo e reinsere
    await db.from("permissoes_operador").delete().eq("operador_id", id);

    if (permissoes.length > 0) {
      await db.from("permissoes_operador").insert(
        permissoes.map(permissao_id => ({ operador_id: id, permissao_id }))
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Erro salvar permissões:", err);
    res.status(500).json({ error: err.message || "Erro ao salvar permissões" });
  }
});

/* ============================================================
   MINHAS PERMISSÕES (operador logado consulta as próprias)
   GET /api/operadores/minhas-permissoes
============================================================ */
router.get('/minhas-permissoes', async (req, res) => {
  try {
    if (req.user.role === 'merchant' || req.user.role === 'super_admin') {
      return res.json(['pdv','estoque','clientes','financeiro','relatorios','configuracoes']);
    }
    res.json(req.user.permissoes || []);
  } catch (err) {
    console.error('Erro minhas-permissoes:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

/* ============================================================
   8) LIMITE E CONTAGEM (MERCHANT)
   GET /api/operadores/limite
============================================================ */
router.get("/limite", async (req, res) => {
  try {
    const { mercearia_id } = req.user;
    if (!mercearia_id) return res.status(403).json({ error: "Sem mercearia associada" });

    const { data: merc } = await db
      .from("mercearias")
      .select("limite_operadores")
      .eq("id", mercearia_id)
      .single();

    const { count } = await db
      .from("operadores")
      .select("id", { count: "exact", head: true })
      .eq("mercearia_id", mercearia_id)
      .neq("status", "excluido");

    res.json({
      limite:     merc?.limite_operadores ?? 3,
      total:      count ?? 0,
      pode_criar: (count ?? 0) < (merc?.limite_operadores ?? 3),
    });
  } catch (err) {
    console.error("Erro buscar limite:", err);
    res.status(500).json({ error: "Erro ao buscar limite" });
  }
});

/* ============================================================
   RESET SENHA (MERCHANT reseta operador do próprio estabelecimento)
   POST /api/operadores/:id/reset-senha
============================================================ */
router.post('/:id/reset-senha', async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;
    const { senha } = req.body;

    if (!senha || senha.length < 6) {
      return res.status(400).json({ error: 'Senha inválida (mínimo 6 caracteres)' });
    }

    await garantirDono(id, mercearia_id);

    const { error } = await db.auth.admin.updateUserById(id, { password: senha });
    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    console.error('Erro reset senha:', err);
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
});

/* ============================================================
   DIAGNÓSTICO USUÁRIO (mantido do original)
============================================================ */
router.post("/diagnostico", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail não informado" });

  try {
    const { data: operador } = await db
      .from("operadores")
      .select("status")
      .eq("email", email)
      .maybeSingle();

    if (operador) return res.json({ tipo: "operador", status: operador.status });

    const { data: mercearia } = await db
      .from("mercearias")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (mercearia) return res.json({ tipo: "mercearia" });

    return res.json({ tipo: "admin" });
  } catch (err) {
    console.error("Erro diagnóstico:", err);
    res.status(500).json({ error: "Erro interno no diagnóstico" });
  }
});

module.exports = router;