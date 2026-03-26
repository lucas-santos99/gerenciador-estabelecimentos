const supabaseAdmin = require('../db/supabaseAdmin');

// 🔥 CRIAR SUPERADMIN
const criarSuperAdmin = async (req, res) => {
  const { email, senha, nome } = req.body;

  try {
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
          is_master: false
        }
      ]);

    if (upsertError) throw upsertError;

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
        error: "Não é permitido excluir o SuperAdmin principal"
      });
    }

    await supabaseAdmin.auth.admin.deleteUser(id);

    await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", id);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin
};