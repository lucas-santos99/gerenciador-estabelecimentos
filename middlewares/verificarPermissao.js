// middlewares/verificarPermissao.js
const supabaseAdmin = require('../db/supabaseAdmin');

const verificarPermissao = (permissaoCodigo) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) return res.status(401).json({ error: 'Usuário não autenticado' });

      // super_admin e merchant passam sempre
      if (user.role === 'super_admin' || user.role === 'merchant') return next();

      // Operadores: verificar permissão no banco via supabaseAdmin (ignora RLS)
      // req.permissoes pode estar em cache da mesma requisição
      if (!req.permissoes) {
        const { data: rows, error } = await supabaseAdmin
          .from('permissoes_operador')
          .select('permissao_id')
          .eq('operador_id', user.id);  // operadores.id === auth user id

        if (error) {
          console.error('ERRO verificarPermissao:', error);
          return res.status(500).json({ error: error.message });
        }

        req.permissoes = (rows || []).map(r => r.permissao_id);
      }

      if (!req.permissoes.includes(permissaoCodigo)) {
        return res.status(403).json({
          error: 'Acesso negado',
          permissao_necessaria: permissaoCodigo,
        });
      }

      
      next();
    } catch (err) {
      console.error('ERRO GERAL verificarPermissao:', err);
      return res.status(500).json({ error: 'Erro interno' });
    }
  };
};

module.exports = { verificarPermissao };