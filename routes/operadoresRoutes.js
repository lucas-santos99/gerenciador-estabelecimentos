// routes/operadoresRoutes.js
const express = require("express");
const router  = express.Router();

const db        = require("../db/supabaseAdmin");
const authUser  = require("../middlewares/authUser");
const { limiteAcaoSensivel } = require("../middlewares/limiteRequisicoes");
const verificarPermissao = require("../middlewares/verificarPermissao");
const { PERMISSOES } = require("../utils/permissoes");
const { registrar } = require("./auditoriaRoutes");
const { LIMITES, validarTamanhos } = require("../utils/limitesTexto");
const { erroSenhaFraca } = require("../utils/senha");
const { erroEmail } = require("../utils/emailValido");
const { carimboCriacao, carimboAlteracao } = require("../utils/rastro");

// Todas as rotas deste arquivo exigem autenticação
router.use(authUser);

// Gerenciar operadores (listar, criar, editar, ativar/desativar, excluir,
// permissões, senha) é só do DONO da loja. Antes as rotas só conferiam se
// o operador era do mesmo estabelecimento — um operador conseguia chamar
// a API direto e dar todas as permissões pra si mesmo. A única rota que o
// operador usa aqui é a que devolve as próprias permissões.
router.use((req, res, next) => {
  if (req.method === "GET" && req.path === "/minhas-permissoes") return next();
  if (req.user.role !== "merchant") {
    return res.status(403).json({ error: "Só o dono da loja gerencia os operadores.", codigo: "SOMENTE_DONO" });
  }
  next();
});

function quemFez(req) { return req.user.role === "operator" ? req.user.id : null; }

/* ============================================================
   HELPER — garante que o req.user é merchant e dono do operador.
   Devolve o registro do operador (nome/email) pra reaproveitar
   nas descrições de auditoria sem precisar buscar de novo.
============================================================ */
async function garantirDono(alvoId, merceariaId) {
  const { data, error } = await db
    .from("operadores")
    .select("id, nome, email, mercearia_id")
    .eq("id", alvoId)
    .single();
  if (error || !data) throw new Error("Operador não encontrado");
  if (data.mercearia_id !== merceariaId) throw new Error("Sem permissão");
  return data;
}

/* ============================================================
   1) LISTAR OPERADORES DA MERCEARIA (MERCHANT)
   GET /api/operadores
============================================================ */
router.get("/", async (req, res) => {
  try {
    const { mercearia_id } = req.user;
    if (!mercearia_id) return res.status(403).json({ error: "Sem estabelecimento vinculado" });

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
router.post("/criar", limiteAcaoSensivel, async (req, res) => {
  try {
    const { mercearia_id } = req.user;
    if (!mercearia_id) return res.status(403).json({ error: "Sem estabelecimento vinculado" });

    if (typeof req.body?.nome === 'string') req.body.nome = req.body.nome.replace(/\s+/g, ' ').trim(); // sem espaço duplo/sobrando
    const { nome, email, telefone, senha, permissoes } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ error: "Nome, email e senha são obrigatórios" });
    }
    const erroSenha = erroSenhaFraca(senha);
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const erroTamanho = validarTamanhos(
      { nome, email, telefone, senha },
      { nome: LIMITES.NOME, email: LIMITES.EMAIL, telefone: LIMITES.TELEFONE, senha: LIMITES.SENHA }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const erroDominio = await erroEmail(email);
    if (erroDominio) return res.status(400).json({ error: erroDominio });

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
        ...carimboCriacao(req),
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

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'criar_operador',
      descricao: `Cadastrou o operador "${nome}"`,
      meta: { operador_id: userId, email },
    });

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

    const operadorAtual = await garantirDono(id, mercearia_id);

    if (typeof req.body?.nome === 'string') req.body.nome = req.body.nome.replace(/\s+/g, ' ').trim(); // sem espaço duplo/sobrando
    const { nome, telefone } = req.body;
    let { email } = req.body;

    const erroTamanho = validarTamanhos(
      { nome, telefone, email },
      { nome: LIMITES.NOME, telefone: LIMITES.TELEFONE, email: LIMITES.EMAIL }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    // O e-mail do operador é o e-mail com que ele ENTRA no sistema.
    // 05/10/2026: antes só o cadastro mudava e ele seguia entrando com o
    // e-mail antigo. Agora, se o e-mail foi trocado, o login é trocado
    // ANTES de gravar; se o e-mail já estiver em uso, nada é gravado.
    const emailAntigo = String(operadorAtual.email || "").trim().toLowerCase();
    let loginAlterado = false;
    if (email !== undefined && email !== null) {
      email = String(email).trim().toLowerCase();
      if (email !== emailAntigo) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res.status(400).json({ error: "Informe um e-mail válido — é com ele que o operador entra no sistema." });
        }
        const erroDominio = await erroEmail(email);
        if (erroDominio) return res.status(400).json({ error: erroDominio });
        const MSG_EM_USO = "Este e-mail já está em uso por outro usuário. Escolha outro e-mail.";
        const { data: perfilMesmoEmail } = await db.from("profiles").select("id").eq("email", email).neq("id", id).limit(1);
        if ((perfilMesmoEmail || []).length > 0) return res.status(400).json({ error: MSG_EM_USO });

        const { error: authErr } = await db.auth.admin.updateUserById(id, { email, email_confirm: true });
        if (authErr) {
          const emUso = authErr.code === "email_exists" || /already|registered|exists|duplicate/i.test(authErr.message || "");
          return res.status(400).json({ error: emUso ? MSG_EM_USO : `Não foi possível trocar o e-mail de login: ${authErr.message}` });
        }
        loginAlterado = true;
      }
    }

    const { data, error } = await db
      .from("operadores")
      .update({ nome, telefone, email, ...carimboAlteracao(req) })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      // Não deixa login e cadastro diferentes: desfaz a troca do login
      if (loginAlterado && emailAntigo) {
        const { error: desfazErr } = await db.auth.admin.updateUserById(id, { email: emailAntigo, email_confirm: true });
        if (desfazErr) console.error("Erro ao desfazer troca de e-mail de login:", desfazErr.message);
      }
      return res.status(400).json({ error: error.message });
    }

    await db.from("profiles").update({ nome, email }).eq("id", id);

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'editar_operador',
      descricao: loginAlterado
        ? `Editou o operador "${nome}" e trocou o e-mail de login de ${emailAntigo} para ${email}`
        : `Editou o operador "${nome}"`,
      meta: { operador_id: id, ...(loginAlterado ? { email_login_antigo: emailAntigo, email_login_novo: email } : {}) },
    });

    res.json({ success: true, operador: data, login_alterado: loginAlterado });
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

    const operadorAtual = await garantirDono(id, mercearia_id);

    const { error } = await db
      .from("operadores")
      .update({ status, ...carimboAlteracao(req) })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'alterar_status_operador',
      descricao: `${status === 'ativo' ? 'Ativou' : 'Desativou'} o operador "${operadorAtual.nome}"`,
      meta: { operador_id: id, status },
    });

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

    const operadorAtual = await garantirDono(id, mercearia_id);

    const { error } = await db
      .from("operadores")
      .update({ status: "excluido", ...carimboAlteracao(req) })
      .eq("id", id);

    if (error) return res.status(400).json({ error: error.message });

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'excluir_operador',
      descricao: `Excluiu o operador "${operadorAtual.nome}"`,
      meta: { operador_id: id },
    });

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

    const operadorAtual = await garantirDono(id, mercearia_id);

    // Remove tudo e reinsere
    await db.from("permissoes_operador").delete().eq("operador_id", id);

    if (permissoes.length > 0) {
      await db.from("permissoes_operador").insert(
        permissoes.map(permissao_id => ({ operador_id: id, permissao_id }))
      );
    }

    // "Alterado por": as permissões ficam em outra tabela, então o carimbo
    // vai num update só dele no cadastro do operador. Se falhar, não
    // derruba a rota — as permissões já foram gravadas.
    try {
      const carimbo = carimboAlteracao(req);
      if (Object.keys(carimbo).length > 0) {
        const { error: errCarimbo } = await db.from("operadores").update(carimbo).eq("id", id).eq("mercearia_id", mercearia_id);
        if (errCarimbo) console.error("Permissões salvas, mas falhou ao gravar o 'alterado por':", errCarimbo.message);
      }
    } catch (e) {
      console.error("Permissões salvas, mas falhou ao gravar o 'alterado por':", e.message);
    }

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'editar_permissoes_operador',
      descricao: `Atualizou as permissões do operador "${operadorAtual.nome}" (${permissoes.length} permissão${permissoes.length !== 1 ? 'ões' : ''})`,
      meta: { operador_id: id, total_permissoes: permissoes.length },
    });

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
      return res.json(['pdv','estoque','clientes','financeiro','relatorios','inventario','fornecedores','operadores','auditoria','config']);
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
    if (!mercearia_id) return res.status(403).json({ error: "Sem estabelecimento vinculado" });

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
router.post('/:id/reset-senha', limiteAcaoSensivel, async (req, res) => {
  try {
    const { id } = req.params;
    const { mercearia_id } = req.user;
    const { senha } = req.body;

    const erroSenha = erroSenhaFraca(senha);
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const erroTamanho = validarTamanhos({ senha }, { senha: LIMITES.SENHA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const operadorAtual = await garantirDono(id, mercearia_id);

    const { error } = await db.auth.admin.updateUserById(id, { password: senha });
    if (error) return res.status(400).json({ error: error.message });

    registrar({
      mercearia_id:  mercearia_id,
      operador_id:   quemFez(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'operadores', acao: 'reset_senha_operador',
      descricao: `Redefiniu a senha do operador "${operadorAtual.nome}"`,
      meta: { operador_id: id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Erro reset senha:', err);
    res.status(500).json({ error: err.message || 'Erro interno' });
  }
});

/* ============================================================
   DIAGNÓSTICO USUÁRIO — REMOVIDO em 22/09/2026
   Dizia se um e-mail pertencia a operador/comerciante pra qualquer
   usuário logado (permitia descobrir e-mails cadastrados) e não era
   chamado por nenhuma tela.
============================================================ */

module.exports = router;