// middlewares/verificarPermissao.js

const verificarPermissao = (permissaoCodigo) => {
  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return res.status(401).json({ error: "Usuário não autenticado" });
      }

      // ✅ super_admin passa sempre
      if (user.role === 'super_admin') {
        return next();
      }

      // ✅ merchant passa sempre (dono do estabelecimento tem acesso total ao próprio painel)
      if (user.role === 'merchant') {
        return next();
      }

      // A partir daqui só operadores
      const supabase = req.supabase;

      // 🔍 BUSCAR OPERADOR
      const { data: operador, error: opError } = await supabase
        .from("operadores")
        .select("id")
        .eq("auth_user_id", user.id)
        .single();

      if (opError) {
        console.error("ERRO OPERADOR:", opError);
        return res.status(500).json({ error: opError.message });
      }

      if (!operador) {
        return res.status(403).json({ error: "Operador não encontrado" });
      }

      // 🔍 BUSCAR PERMISSÕES (CACHE na requisição)
      if (!req.permissoes) {
        const { data: permissoes, error: permError } = await supabase
          .from("permissoes_operador")
          .select("permissao_id")
          .eq("operador_id", operador.id);

        if (permError) {
          console.error("ERRO PERMISSOES:", permError);
          return res.status(500).json({ error: permError.message });
        }

        const permissoesIds = permissoes.map(p => p.permissao_id);

        // 🔥 EVITA QUERY VAZIA
        if (permissoesIds.length === 0) {
          req.permissoes = [];
        } else {
          const { data: permissoesDetalhes, error: permDetalheError } = await supabase
            .from("permissoes")
            .select("codigo")
            .in("id", permissoesIds);

          if (permDetalheError) {
            console.error("ERRO DETALHE PERMISSOES:", permDetalheError);
            return res.status(500).json({ error: permDetalheError.message });
          }

          req.permissoes = permissoesDetalhes.map(p => p.codigo);
        }
      }

      // 🔒 VALIDAÇÃO FINAL
      if (!req.permissoes.includes(permissaoCodigo)) {
        return res.status(403).json({
          error: "Acesso negado",
          permissao_necessaria: permissaoCodigo
        });
      }

      next();

    } catch (err) {
      console.error("ERRO GERAL verificarPermissao:", err);
      return res.status(500).json({ error: "Erro interno" });
    }
  };
};

module.exports = { verificarPermissao };