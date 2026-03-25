const supabaseAdmin = require('../db/supabaseAdmin');

const criarSuperAdmin = async (req, res) => {
  const { email, senha, nome } = req.body;

  try {
    // 🔥 cria usuário no auth
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true
    });

    if (error) throw error;

    // 🔥 salva no profiles
    const { error: insertError } = await supabaseAdmin
      .from('profiles')
      .insert([
        {
          id: data.user.id,
          email,
          nome,
          role: 'super_admin'
        }
      ]);

    if (insertError) throw insertError;

    return res.json({ success: true });

  } catch (err) {
    console.error("ERRO CRIAR SUPERADMIN:", err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { criarSuperAdmin };