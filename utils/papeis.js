// utils/papeis.js
//
// Nome em português de cada papel (role) para tudo que aparece na tela.
// Os valores internos (super_admin / merchant / operator) continuam os
// mesmos no banco e no código — são da época em que o sistema era só
// para mercearias. Trocar os internos é o item 24 (b) do roadmap; aqui é
// só o que o usuário lê (29/09/2026).

const ROTULO_PAPEL = {
  super_admin: 'SuperAdmin',
  merchant:    'Administrador',
  operator:    'Operador',
};

function rotuloPapel(role) {
  return ROTULO_PAPEL[role] || role || '';
}

// Registros de auditoria antigos foram gravados com o papel cru, ex.:
// "Loja X fez login (merchant)". Traduz na hora de devolver pra tela
// (vale também pro Excel/PDF, que usam a mesma rota).
const PAPEL_ENTRE_PARENTESES = /\((super_admin|merchant|operator)\)/g;

function traduzirDescricao(texto) {
  if (typeof texto !== 'string' || !texto.includes('(')) return texto;
  return texto.replace(PAPEL_ENTRE_PARENTESES, (_, r) => `(${rotuloPapel(r)})`);
}

function traduzirRegistrosAuditoria(lista) {
  return (lista || []).map(r => (r && r.descricao ? { ...r, descricao: traduzirDescricao(r.descricao) } : r));
}

module.exports = { ROTULO_PAPEL, rotuloPapel, traduzirDescricao, traduzirRegistrosAuditoria };
