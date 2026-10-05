// middlewares/verificarPermissao.js
const supabaseAdmin = require('../db/supabaseAdmin');

// ── Como usar ──────────────────────────────────────────────────────
// verificarPermissao('x')                       → exige a permissão x
// verificarPermissao(['modulo', 'acao'])        → exige as DUAS
// verificarPermissao(['a', 'b'], ['c', 'd'])    → (a E b) OU (c E d)
// verificarPermissao('x', { mensagem: '...' })  → texto do 403
//
// Cada argumento é um "grupo": um código sozinho ou uma lista de
// códigos (todos exigidos). Passa se QUALQUER grupo for atendido.
// Dono (merchant) e super_admin passam sempre.

const MENSAGEM_PADRAO = 'Você não tem permissão para fazer isso.';

// Transforma os argumentos em lista de grupos (cada grupo = lista de códigos).
function normalizarGrupos(grupos) {
  return (grupos || [])
    .filter(g => g != null)
    .map(g => (Array.isArray(g) ? g : [g]).filter(Boolean))
    .filter(g => g.length > 0);
}

// Função pura: a lista de permissões atende a algum dos grupos?
function listaAtende(lista, grupos) {
  const tem = Array.isArray(lista) ? lista : [];
  return grupos.some(grupo => grupo.every(codigo => tem.includes(codigo)));
}

function ehDonoOuAdmin(user) {
  return !!user && (user.role === 'super_admin' || user.role === 'merchant');
}

// Para usar DENTRO das rotas: temPermissao(req, ['modulo', 'acao'], ...)
// Aceita o `req` ou o `req.user`. Não consulta o banco — usa a lista que
// o authUser já carregou para o operador.
function temPermissao(alvo, ...grupos) {
  if (!alvo) return false;
  const user = alvo.user || alvo;
  if (ehDonoOuAdmin(user)) return true;
  const lista = alvo.permissoes || user.permissoes || [];
  return listaAtende(lista, normalizarGrupos(grupos));
}

const verificarPermissao = (...args) => {
  // Último argumento pode ser um objeto de opções: { mensagem }
  let opcoes = {};
  const ultimo = args[args.length - 1];
  if (ultimo && typeof ultimo === 'object' && !Array.isArray(ultimo)) {
    opcoes = args.pop();
  }
  const grupos = normalizarGrupos(args);
  // Formato de sempre quando é um código só; lista de grupos nos demais casos
  const necessaria = (grupos.length === 1 && grupos[0].length === 1) ? grupos[0][0] : grupos;

  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) return res.status(401).json({ error: 'Usuário não autenticado' });

      // super_admin e merchant passam sempre
      if (ehDonoOuAdmin(user)) return next();

      // Operadores: verificar permissão no banco via supabaseAdmin (ignora RLS)
      // req.permissoes pode estar em cache da mesma requisição
      if (!req.permissoes) {
        if (Array.isArray(user.permissoes)) {
          req.permissoes = user.permissoes;
        } else {
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
      }

      if (!listaAtende(req.permissoes, grupos)) {
        return res.status(403).json({
          error: opcoes.mensagem || MENSAGEM_PADRAO,
          codigo: 'SEM_PERMISSAO',
          permissao_necessaria: necessaria,
        });
      }

      next();
    } catch (err) {
      console.error('ERRO GERAL verificarPermissao:', err);
      return res.status(500).json({ error: 'Erro interno' });
    }
  };
};

module.exports = { verificarPermissao, temPermissao };