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
    const { count, error } = await db
      .from(tabela)
      .select('id', { count: 'exact', head: true })
      .eq('mercearia_id', merceariaId);
    if (error) {
      console.error(`[TETO] contagem de ${tabela} falhou:`, error.message);
      return null;
    }
    if ((count || 0) >= t.max) {
      console.error(`[TETO] ${tabela} — teto de ${t.max} atingido (mercearia ${merceariaId})`);
      return `Limite de ${t.max.toLocaleString('pt-BR')} ${t.nome} atingido para este estabelecimento. Fale com o suporte para ampliar.`;
    }
  } catch (e) {
    console.error(`[TETO] erro em ${tabela}:`, e.message);
  }
  return null;
}

module.exports = { erroTeto, TETOS };
