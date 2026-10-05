// utils/inventarioTrava.js
//
// Inventário em andamento "congela" os produtos que estão sendo contados:
// enquanto a contagem não for finalizada ou cancelada, eles não podem ser
// vendidos nem ter o estoque mexido (ajuste, compra, cancelamento, exclusão).
// Sem isso, a contagem ficava errada — ao finalizar, o estoque passava a
// ser a quantidade contada e apagava o que foi vendido no meio do caminho.
//
// Inventário "completo" trava a loja toda; "por categoria" trava só os
// produtos daquela categoria.
const db = require('../db/supabaseAdmin');

// Inventário em andamento da loja (só pode existir um) ou null.
async function inventarioEmAndamento(merceariaId) {
  if (!merceariaId) return null;
  const { data, error } = await db
    .from('inventarios')
    .select('id, nome, tipo, categoria_id, usuario_nome, iniciado_em, total_produtos')
    .eq('mercearia_id', merceariaId)
    .eq('status', 'em_andamento')
    .limit(1);
  if (error) throw new Error(`inventarios: ${error.message}`);
  return (data && data[0]) || null;
}

// Dos produtos informados, quais estão no inventário em andamento.
// Devolve null se não há inventário ou nenhum produto está nele.
async function produtosEmContagem(merceariaId, produtoIds) {
  const ids = [...new Set((produtoIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return null;
  const inv = await inventarioEmAndamento(merceariaId);
  if (!inv) return null;
  const { data, error } = await db
    .from('itens_inventario')
    .select('produto_id, produto_nome')
    .eq('inventario_id', inv.id)
    .in('produto_id', ids);
  if (error) throw new Error(`itens_inventario: ${error.message}`);
  if (!data || data.length === 0) return null;
  return { inventario: inv, produtos: data };
}

// Para usar dentro das rotas. `acao` completa a frase "…para <acao>."
// (ex.: "vender", "ajustar o estoque"). Devolve true se já respondeu 409.
async function negarSeEmContagem(req, res, produtoIds, acao) {
  const travado = await produtosEmContagem(req.user.mercearia_id, produtoIds);
  if (!travado) return false;
  const nomes = travado.produtos.map(p => p.produto_nome).filter(Boolean);
  const lista = nomes.length <= 3
    ? nomes.join(', ')
    : `${nomes.slice(0, 3).join(', ')} e mais ${nomes.length - 3}`;
  res.status(409).json({
    error: `Inventário "${travado.inventario.nome}" em andamento — ${nomes.length === 1 ? 'o produto' : 'os produtos'} ${lista} ${nomes.length === 1 ? 'está' : 'estão'} em contagem. Finalize ou cancele o inventário para ${acao}.`,
    codigo: 'INVENTARIO_EM_ANDAMENTO',
    inventario: { id: travado.inventario.id, nome: travado.inventario.nome, tipo: travado.inventario.tipo },
    produtos: travado.produtos,
  });
  return true;
}

module.exports = { inventarioEmAndamento, produtosEmContagem, negarSeEmContagem };
