// Texto das variações (ex.: "Frozen · P · Azul") na ordem dos atributos da loja, para quem fica fora
// de estabelecimentoRoutes (notificações, WhatsApp). Nunca lança: se algo falhar, devolve a ordem
// padrão (tamanho · cor · gênero · extras). Dependente do SQL 31 só para os atributos extras.
const db = require('../db/supabaseAdmin');
const AV = require('./atributosVariacao');

const cacheAtributos = new Map(); // mid → { em, lista } (30 s: evita reler a cada venda do histórico)
async function atributosDaLoja(mid) {
  const c = cacheAtributos.get(mid);
  if (c && Date.now() - c.em < 30000) return c.lista;
  const lista = await lerAtributosDaLoja(mid);
  if (cacheAtributos.size > 500) cacheAtributos.clear();
  cacheAtributos.set(mid, { em: Date.now(), lista });
  return lista;
}
async function lerAtributosDaLoja(mid) {
  try {
    const { data: loja } = await db.from('mercearias').select('tipo_estabelecimento').eq('id', mid).maybeSingle();
    const { data, error } = await db.from('atributos_variacao').select('chave, nome, ordem, ativo').eq('mercearia_id', mid).limit(100);
    return AV.montarAtributos(loja?.tipo_estabelecimento, error ? [] : (data || []));
  } catch (e) {
    console.error('[rotulosVariacao] atributos da loja:', e.message);
    return [];
  }
}

// Seleciona variações pedindo `atributos`; se a coluna não existir (42703), repete sem ela.
async function selecionarVariacoes(montar) {
  let r = await montar(true);
  if (r.error && r.error.code === '42703') r = await montar(false);
  return r;
}

// Map id da variação → rótulo.
async function rotulosPorId(mid, ids) {
  const out = new Map();
  const lista = [...new Set((ids || []).filter(Boolean))].slice(0, 500);
  if (!lista.length) return out;
  const atributos = await atributosDaLoja(mid);
  const { data } = await selecionarVariacoes((comAtr) => db.from('produto_variacoes')
    .select(`id, tamanho, cor, genero${comAtr ? ', atributos' : ''}`).eq('mercearia_id', mid).in('id', lista));
  for (const v of data || []) out.set(v.id, AV.rotuloDaVariacao(v, atributos));
  return out;
}

// Itens de venda (linhas de itens_venda) → rótulo de cada um: o que foi gravado na hora da venda
// (variacao_rotulo) ou, nas vendas antigas, o texto atual da variação. Devolve array paralelo.
async function rotulosDosItens(mid, itens) {
  const lista = itens || [];
  const faltam = lista.filter(i => i.produto_variacao_id && !i.variacao_rotulo).map(i => i.produto_variacao_id);
  const atuais = faltam.length ? await rotulosPorId(mid, faltam) : new Map();
  return lista.map(i => {
    if (!i.produto_variacao_id) return '';
    return i.variacao_rotulo || atuais.get(i.produto_variacao_id) || '';
  });
}

// "Camiseta" + "P · Azul" → "Camiseta (P · Azul)"
const nomeComVariacao = (nome, rotulo) => (rotulo ? `${nome} (${rotulo})` : nome);

// Consulta itens_venda pedindo a coluna variacao_rotulo; se ainda não existir (42703), repete sem ela.
async function selecionarItensVenda(montar) {
  let r = await montar(true);
  if (r.error && r.error.code === '42703') r = await montar(false);
  return r;
}

module.exports = { atributosDaLoja, selecionarVariacoes, rotulosPorId, rotulosDosItens, nomeComVariacao, selecionarItensVenda };
