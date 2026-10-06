// utils/rastro.js
// "Cadastrado por / Alterado por" dos cadastros (05/10/2026).
//
// As tabelas de cadastro ganharam, no SQL nº 25, as colunas
//   criado_por_nome, atualizado_em, atualizado_por_nome
// (e criado_em onde não existia). Toda rota que CRIA um cadastro espalha
// `...carimboCriacao(req)` no insert; toda rota que ALTERA os dados do
// cadastro espalha `...carimboAlteracao(req)` no update.
//
// Só vale para alteração do CADASTRO feita por uma pessoa. Mudança
// automática (baixa de estoque na venda, saldo do fiado, webhook de
// pagamento, bloqueio por vencimento) NÃO carimba — senão o "alterado por"
// viraria o caixa que fez a última venda.
//
// Enquanto o SQL 25 não tiver rodado as colunas não existem e gravar nelas
// derrubaria o insert/update inteiro. Por isso os carimbos só saem depois
// que uma sondagem confirma que a coluna existe; até lá devolvem {} e nada
// muda no comportamento das rotas.
const db = require('../db/supabaseAdmin');

let disponivel = false;
let emCurso    = null; // sondagem em andamento (quem chamar junto espera a mesma)

function sondar() {
  if (disponivel) return Promise.resolve(true);
  if (emCurso) return emCurso;
  emCurso = (async () => {
    try {
      const { error } = await db.from('produtos').select('atualizado_por_nome').limit(1);
      if (!error) disponivel = true;
    } catch { /* tenta de novo depois */ }
    emCurso = null;
    return disponivel;
  })();
  return emCurso;
}

// Sonda ao carregar e, enquanto as colunas não existirem, de minuto em minuto.
sondar();
const timer = setInterval(() => { if (disponivel) clearInterval(timer); else sondar(); }, 60 * 1000);
if (timer.unref) timer.unref();

function quem(req) {
  const u = (req && req.user) || {};
  return String(u.nome || u.email || 'Sistema').slice(0, 150);
}

function carimboCriacao(req) {
  if (!disponivel) return {};
  return { criado_por_nome: quem(req) };
}

function carimboAlteracao(req) {
  if (!disponivel) return {};
  return { atualizado_em: new Date().toISOString(), atualizado_por_nome: quem(req) };
}

module.exports = { carimboCriacao, carimboAlteracao, rastroDisponivel: () => disponivel, sondarRastro: sondar };
