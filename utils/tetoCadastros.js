// utils/tetoCadastros.js
//
// Teto TÉCNICO de cadastros por estabelecimento. Não é limite de plano nem
// de cobrança: é uma trava de segurança, bem acima do que qualquer comércio
// legítimo usa, para evitar que uma conta (ou um script) encha o banco.
// A cobrança do sistema é por operadores e extras, não por quantidade de
// cadastros. Se algum cliente real chegar perto, é só subir o número aqui.

const TETOS = {
  produtos:     { max: 20000, nome: 'produtos' },
  clientes:     { max: 20000, nome: 'clientes' },
  fornecedores: { max: 5000,  nome: 'fornecedores' },
  categorias:   { max: 1000,  nome: 'categorias' },
  compras:      { max: 20000, nome: 'compras' },
  contas_a_pagar: { max: 20000, nome: 'contas a pagar' },
  inventarios:  { max: 2000,  nome: 'inventários' },
  lembretes:    { max: 2000,  nome: 'lembretes' },
  // Só as PENDENTES contam: depois de atendida/recusada a solicitação sai da conta.
  solicitacoes_alteracao: { max: 20, nome: 'solicitações pendentes', filtro: { status: 'pendente' }, aviso: 'Já existem 20 solicitações pendentes para este estabelecimento. Aguarde o atendimento antes de enviar outra.' },
};

/**
 * Devolve uma mensagem de erro se o estabelecimento já chegou ao teto da
 * tabela, ou null se pode cadastrar mais. Se a contagem falhar, NÃO trava o
 * cadastro (a trava é proteção, não pode derrubar o uso normal).
 */
async function erroTeto(db, tabela, merceariaId) {
  const t = TETOS[tabela];
  if (!t || !merceariaId) return null;
  try {
    let q = db
      .from(tabela)
      .select('id', { count: 'exact', head: true })
      .eq('mercearia_id', merceariaId);
    for (const [col, val] of Object.entries(t.filtro || {})) q = q.eq(col, val);
    const { count, error } = await q;
    if (error) {
      console.error(`[TETO] contagem de ${tabela} falhou:`, error.message);
      return null;
    }
    if ((count || 0) >= t.max) {
      console.error(`[TETO] ${tabela} — teto de ${t.max} atingido (mercearia ${merceariaId})`);
      return t.aviso || `Limite de ${t.max.toLocaleString('pt-BR')} ${t.nome} atingido para este estabelecimento. Fale com o suporte para ampliar.`;
    }
  } catch (e) {
    console.error(`[TETO] erro em ${tabela}:`, e.message);
  }
  return null;
}

/**
 * O banco também barra (gatilhos do SQL 35) com a mensagem 'TETO:<assunto>:<máximo>'.
 * Devolve o texto amigável se o erro for desse tipo, ou null se for outro erro.
 * Cobre o caso de dois cadastros ao mesmo tempo (a contagem do backend passa nos dois).
 */
function erroTetoDoBanco(err) {
  const m = /TETO:([a-z_]+):(\d+)/.exec(String(err?.message || err || ''));
  if (!m) return null;
  const [, assunto, max] = m;
  const t = TETOS[assunto === 'solicitacoes_pendentes' ? 'solicitacoes_alteracao' : assunto];
  if (t?.aviso) return t.aviso;
  const nome = t?.nome || (assunto === 'notif_estado' ? 'avisos guardados' : assunto.replace(/_/g, ' '));
  return `Limite de ${Number(max).toLocaleString('pt-BR')} ${nome} atingido para este estabelecimento. Fale com o suporte para ampliar.`;
}

module.exports = { erroTeto, erroTetoDoBanco, TETOS };
