// Texto das variações (ex.: "Frozen · P · Azul") na ordem dos atributos da loja, para quem fica fora
// de estabelecimentoRoutes (notificações, WhatsApp). Nunca lança: se algo falhar, devolve a ordem
// padrão (tamanho · cor · gênero · extras). Dependente do SQL 31 só para os atributos extras.
const db = require('../db/supabaseAdmin');
const AV = require('./atributosVariacao');

async function atributosDaLoja(mid) {
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

module.exports = { atributosDaLoja, selecionarVariacoes, rotulosPorId };
