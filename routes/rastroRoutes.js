// routes/rastroRoutes.js
// GET /api/rastro/:entidade/:id — "Cadastrado por / Alterado por" de um
// cadastro (05/10/2026). Só leitura. A tela chama quando abre um cadastro
// para editar (componente <Rastro />).
//
// Rota própria (em vez de acrescentar as colunas em cada SELECT do
// sistema) para que nenhuma listagem dependa do SQL nº 25: se ele ainda
// não rodou, esta rota responde { disponivel: false } e o resto do sistema
// segue igual.
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

// entidade → tabela, coluna da data de cadastro e quem pode ver:
//   'loja'  = registro com mercearia_id (dono/operador da própria loja ou SuperAdmin)
//   'proprio' = a própria loja (id = mercearia do usuário) ou SuperAdmin
//   'admin' = só SuperAdmin
const ENTIDADES = {
  produto:         { tabela: 'produtos',         criado: 'criado_em',  escopo: 'loja' },
  cliente:         { tabela: 'clientes',         criado: 'criado_em',  escopo: 'loja' },
  fornecedor:      { tabela: 'fornecedores',     criado: 'criado_em',  escopo: 'loja' },
  categoria:       { tabela: 'categorias',       criado: 'created_at', escopo: 'loja' },
  operador:        { tabela: 'operadores',       criado: 'created_at', escopo: 'loja' },
  conta:           { tabela: 'contas_a_pagar',   criado: 'criado_em',  escopo: 'loja' },
  estabelecimento: { tabela: 'mercearias',       criado: 'created_at', escopo: 'proprio' },
  comunicado:      { tabela: 'comunicados',      criado: 'criado_em',  escopo: 'admin' },
  contato_suporte: { tabela: 'contatos_suporte', criado: 'criado_em',  escopo: 'admin' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Coluna "timestamp sem fuso" (operadores.created_at) vem sem o Z: é UTC.
function comoIso(valor) {
  if (!valor) return null;
  const s = String(valor);
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
}

router.use(authUser);

router.get('/:entidade/:id', async (req, res) => {
  const cfg = ENTIDADES[req.params.entidade];
  const { id } = req.params;
  if (!cfg || !UUID.test(id)) return res.status(400).json({ error: 'Cadastro inválido.' });

  const ehAdmin = req.user.role === 'super_admin';
  const mid     = req.user.mercearia_id;
  if (cfg.escopo === 'admin' && !ehAdmin) return res.status(403).json({ error: 'Acesso negado.' });
  if (cfg.escopo === 'proprio' && !ehAdmin && id !== mid) return res.status(403).json({ error: 'Acesso negado.' });

  const vazio = { disponivel: false, criado_em: null, criado_por: null, atualizado_em: null, atualizado_por: null };

  try {
    const colunas = [cfg.criado, 'criado_por_nome', 'atualizado_em', 'atualizado_por_nome'];
    if (cfg.escopo === 'loja') colunas.push('mercearia_id');

    const { data, error } = await db.from(cfg.tabela).select(colunas.join(', ')).eq('id', id).maybeSingle();

    // SQL nº 25 ainda não rodou (coluna não existe) → sem rastro, sem erro.
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204' || /does not exist|could not find/i.test(error.message || '')) {
        return res.json(vazio);
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Cadastro não encontrado.' });
    if (cfg.escopo === 'loja' && !ehAdmin && data.mercearia_id !== mid) {
      return res.status(404).json({ error: 'Cadastro não encontrado.' });
    }

    res.json({
      disponivel:     true,
      criado_em:      comoIso(data[cfg.criado]),
      criado_por:     data.criado_por_nome || null,
      atualizado_em:  comoIso(data.atualizado_em),
      atualizado_por: data.atualizado_por_nome || null,
    });
  } catch (err) {
    console.error('[RASTRO] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao buscar o registro do cadastro.' });
  }
});

module.exports = router;
