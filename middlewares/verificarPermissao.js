const verificarPermissao = (permissaoCodigo) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      if (user.is_superadmin) {
        return next();
      }

      const supabase = req.supabase;

      const { data: operador, error: opError } = await supabase
        .from("operadores")
        .select("id")
        .eq("auth_user_id", user.id)
        .single();

      if (opError || !operador) {
        return res.status(403).json({ error: "Operador não encontrado" });
      }

      if (!req.permissoes) {
        const { data: permissoes, error: permError } = await supabase
          .from("permissoes_operador")
          .select(`
            permissoes (
              codigo
            )
          `)
          .eq("operador_id", operador.id);

        if (permError) {
          return res.status(500).json({ error: "Erro ao buscar permissões" });
        }

        req.permissoes = permissoes.map(p => p.permissoes.codigo);
      }

      if (!req.permissoes.includes(permissaoCodigo)) {
        return res.status(403).json({
          error: "Acesso negado",
          permissao_necessaria: permissaoCodigo
        });
      }

      next();

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Erro interno" });
    }
  };
};

module.exports = { verificarPermissao };