// middlewares/authUser.js
const jwt = require('jsonwebtoken');
const createSupabaseUserClient = require('../db/supabaseUser');
const supabaseAdmin = require('../db/supabaseAdmin');

module.exports = async function authUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Token não enviado' });

    const token = authHeader.replace('Bearer ', '');

    let decoded;
    try {
      decoded = jwt.decode(token);
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    if (!decoded?.sub) return res.status(401).json({ error: 'Token inválido' });

    const userId = decoded.sub;

    req.supabase  = createSupabaseUserClient(token);
    req.userToken = token;

    // Buscar profile via admin (ignora RLS)
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !profile) return res.status(403).json({ error: 'Perfil não encontrado' });

    if (!profile.is_active) {
      return res.status(403).json({ error: 'Usuário inativo. Contate o administrador.' });
    }

    req.user = {
      id:          profile.id,
      email:       profile.email,
      role:        profile.role,
      is_master:   profile.is_master,
      mercearia_id: profile.mercearia_id,
    };

    // Para operadores: carregar permissões e injetar no req.user
    if (profile.role === 'operator') {
      const { data: rows } = await supabaseAdmin
        .from('permissoes_operador')
        .select('permissao_id')
        .eq('operador_id', userId);

      req.user.permissoes = (rows || []).map(r => r.permissao_id);
      req.permissoes      = req.user.permissoes; // cache para verificarPermissao
    }

    next();
  } catch (err) {
    console.error('ERRO GERAL authUser:', err);
    return res.status(500).json({ error: 'Erro interno geral' });
  }
};