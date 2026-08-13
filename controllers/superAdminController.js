const supabaseAdmin = require('../db/supabaseAdmin');
const { registrar } = require('../routes/auditoriaRoutes');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');

// 🔥 CRIAR SUPERADMIN
const criarSuperAdmin = async (req, res) => {
  const { email, senha, nome } = req.body;

  try {
    const erroTamanho = validarTamanhos(
      { nome, email, senha },
      { nome: LIMITES.NOME, email: LIMITES.EMAIL, senha: LIMITES.SENHA }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true
    });

    if (error) throw error;

    const { error: upsertError } = await supabaseAdmin
      .from('profiles')
      .upsert([
        {
          id: data.user.id,
          email,
          nome,
          role: 'super_admin',
          is_master: false,
          is_active: true
        }
      ]);

    if (upsertError) throw upsertError;

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'superadmins',
      acao:          'criar_superadmin',
      descricao:     `Criou o SuperAdmin "${nome}" (${email})`,
      meta:          { novo_id: data.user.id, email },
      escopo:        'admin_global',
    });

    return res.json({ success: true });

  } catch (err) {
    console.error("ERRO CRIAR SUPERADMIN:", err);
    return res.status(500).json({ error: err.message });
  }
};

// 🔥 LISTAR SUPERADMINS
const listarSuperAdmins = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'super_admin');

    if (error) throw error;

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 🔥 EXCLUIR SUPERADMIN
const excluirSuperAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;

    if (user.is_master) {
      return res.status(403).json({
        error: "Não é permitido excluir um usuário master"
      });
    }

    await supabaseAdmin.auth.admin.deleteUser(id);

    await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", id);

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'superadmins',
      acao:          'excluir_superadmin',
      descricao:     `Excluiu o SuperAdmin "${user.nome || user.email}"`,
      meta:          { excluido_id: id },
      escopo:        'admin_global',
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// 🔥 ATIVAR/DESATIVAR
async function toggleAtivo(req, res) {
  try {
    const { id } = req.params;

    const { data: user, error: erroBusca } = await supabaseAdmin
      .from("profiles")
      .select("is_master, is_active")
      .eq("id", id)
      .single();

    if (erroBusca) throw erroBusca;

    if (user.is_master) {
      return res.status(403).json({
        error: "Não pode desativar um master"
      });
    }

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: !user.is_active })
      .eq("id", id);

    if (error) throw error;

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'superadmins',
      acao:          !user.is_active ? 'ativar_superadmin' : 'desativar_superadmin',
      descricao:     `${!user.is_active ? "Ativou" : "Desativou"} o SuperAdmin ID ${id}`,
      meta:          { alvo_id: id },
      escopo:        'admin_global',
    });

    res.json({ success: true });

  } catch (err) {
    console.error("ERRO TOGGLE ATIVO:", err);
    res.status(500).json({ error: "Erro interno" });
  }
}

// 🔥 ALTERAR SENHA (CORRIGIDO)
async function alterarSenha(req, res) {
  try {
    const { id } = req.params;
    const { senha } = req.body;

    // 🔒 valida senha
    if (!senha || senha.length < 6) {
      return res.status(400).json({
        error: "Senha deve ter pelo menos 6 caracteres"
      });
    }
    if (senha.length > LIMITES.SENHA) {
      return res.status(400).json({
        error: `Senha excede o limite de ${LIMITES.SENHA} caracteres`
      });
    }

    // 🔍 buscar usuário alvo
    const { data: user, error: erroBusca } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", id)
      .single();

    if (erroBusca || !user) {
      return res.status(404).json({
        error: "Usuário não encontrado"
      });
    }

    // 🔒 REGRA DE PERMISSÃO
    const isMaster = req.user?.is_master;
    const isOwnUser = req.user?.id === id;

    if (!isMaster && !isOwnUser) {
      return res.status(403).json({
        error: "Sem permissão para alterar esta senha"
      });
    }

    // 🔥 atualizar senha no Supabase
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: senha
    });

    if (error) throw error;

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'superadmins',
      acao:          'alterar_senha_superadmin',
      descricao:     isOwnUser ? "Alterou a própria senha" : `Alterou a senha do SuperAdmin ID ${id}`,
      meta:          { alvo_id: id },
      escopo:        'admin_global',
    });

    return res.json({ success: true });

  } catch (err) {
    console.error("ERRO ALTERAR SENHA:", err);
    res.status(500).json({ error: err.message });
  }
}

// 🔥 TORNAR MASTER
async function tornarMaster(req, res) {
  try {
    const { id } = req.params;

    const { data: user, error: erroBusca } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (erroBusca || !user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.is_master) {
      return res.status(400).json({ error: "Usuário já é master" });
    }

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ is_master: true })
      .eq('id', id);

    if (error) {
      return res.status(500).json({ error: 'Erro ao definir como master' });
    }

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'superadmins',
      acao:          'tornar_master',
      descricao:     `Tornou "${user.nome || user.email}" um usuário Master`,
      meta:          { alvo_id: id },
      escopo:        'admin_global',
    });

    return res.json({ success: true });

  } catch (err) {
    console.error("ERRO TORNAR MASTER:", err);
    return res.status(500).json({ error: "Erro interno" });
  }
}

module.exports = {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin,
  toggleAtivo,
  alterarSenha,
  tornarMaster
};