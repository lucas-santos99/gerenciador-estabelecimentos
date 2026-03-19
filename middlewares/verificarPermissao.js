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
          .select("permissao_id")
          .eq("operador_id", operador.id);

        if (permError) {
          return res.status(500).json({ error: "Erro ao buscar permissões" });
        }

        const permissoesIds = permissoes.map(p => p.permissao_id);

// 🔥 buscar códigos manualmente
const { data: permissoesDetalhes } = await supabase
  .from("permissoes")
  .select("codigo")
  .in("id", permissoesIds);

req.permissoes = permissoesDetalhes.map(p => p.codigo);
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