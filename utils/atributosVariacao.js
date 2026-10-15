// utils/atributosVariacao.js
//
// Atributos de variação por loja (SQL 31). Cada loja define os atributos que
// seus produtos variam (ex.: brinquedos → personagem, nº de peças, idade, pilha).
//
//  • tamanho / cor / genero são as chaves LEGADAS: continuam gravadas nas colunas
//    de produto_variacoes. Qualquer outra chave vai em produto_variacoes.atributos (jsonb).
//  • A chave nunca muda (é o que fica gravado); renomear muda só o `nome`.
//  • Sem linha na tabela = vale o padrão do tipo de estabelecimento (como o
//    `visivel = NULL` dos tipos de produto). A tabela só guarda o que a loja mexeu.
//  • "Apagar" um atributo = ocultar (ativo = false): os dados das variações ficam.
//
// ⚠️ Os tetos abaixo espelham os do SQL 31 (gatilhos). Mudou um, mude o outro.

const TETOS_ATRIBUTOS = {
  ATRIBUTOS_LOJA: 30,       // atributos cadastrados na loja
  ATRIBUTOS_PRODUTO: 8,     // atributos usados ao mesmo tempo em um produto
  VALORES_ATRIBUTO: 300,    // valores sugeridos por atributo (ex.: cores)
  VALORES_LOJA: 5000,       // valores sugeridos na loja inteira
  VARIACOES_PRODUTO: 300,   // variações ativas por produto
  VARIACOES_LOJA: 100000,   // variações ativas na loja inteira (conferido só no backend)
  JSON_BYTES: 2000,         // tamanho do JSON de atributos de UMA variação
  NOME_ATRIBUTO: 40,        // tamanho do nome de um atributo
};

const LEGADOS = ['tamanho', 'cor', 'genero'];
const NOME_LEGADO = { tamanho: 'Tamanho', cor: 'Cor', genero: 'Gênero' };
const ORDEM_LEGADO = { tamanho: 10, cor: 20, genero: 30 };

// Tipo de estabelecimento → quais atributos legados já vêm ligados e com que nome.
// (Chave normalizada: sem acento, minúscula.) Tipo desconhecido usa 'outro'.
const PADRAO_POR_TIPO = {
  loja:         { tamanho: 'Tamanho', cor: 'Cor', genero: 'Gênero' },
  ferragem:     { tamanho: 'Medida', cor: 'Cor' },
  agropecuaria: { tamanho: 'Peso/embalagem', cor: 'Cor' },
  restaurante:  { tamanho: 'Porção' },
  mercearia:    { tamanho: 'Tamanho', cor: 'Cor' },
  padaria:      { tamanho: 'Tamanho', cor: 'Cor' },
  outro:        { tamanho: 'Tamanho', cor: 'Cor' },
};

// Modelos prontos que a loja pode adicionar com um clique (a tela vem na etapa 2).
const MODELOS_PRONTOS = [
  {
    id: 'brinquedos', nome: 'Brinquedos',
    atributos: [
      { nome: 'Personagem/tema', valores: [] },
      { nome: 'Nº de peças', valores: [] },
      { nome: 'Idade indicada', valores: ['0 a 2 anos', '3 a 5 anos', '6 a 8 anos', '9 a 12 anos', '13 anos ou mais'] },
      { nome: 'Pilha', valores: ['Com pilha', 'Sem pilha'] },
    ],
  },
  {
    id: 'casa', nome: 'Casa e decoração',
    atributos: [
      { nome: 'Material', valores: [] },
      { nome: 'Medida', valores: [] },
    ],
  },
];

function semAcento(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizarTipoEstabelecimento(t) {
  const k = semAcento(t).trim().toLowerCase();
  return PADRAO_POR_TIPO[k] ? k : 'outro';
}

// Nome → chave (a-z, 0-9, _; começa com letra; até 30). Ex.: "Nº de peças" → "n_de_pecas".
function chaveDoNome(nome) {
  let c = semAcento(nome).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(c)) c = 'a_' + c;
  return c.slice(0, 30).replace(/_+$/, '') || 'atributo';
}

const chaveValida = (c) => typeof c === 'string' && /^[a-z][a-z0-9_]{0,29}$/.test(c);
const nomeIgual = (a, b) => semAcento(a).trim().toLowerCase() === semAcento(b).trim().toLowerCase();
const ehLegado = (chave) => LEGADOS.includes(chave);

// Junta o padrão do tipo de estabelecimento com o que a loja personalizou.
// `linhas` = linhas da tabela atributos_variacao (pode ser vazio).
//
// modeloNovo = true (SQL 40 aplicado, 15/10/2026): tamanho/cor/gênero NÃO são automáticos.
//   • linha existe e não está `removido` → é um atributo da loja;
//   • sem linha → aparece só como SUGESTÃO (se o tipo de estabelecimento sugere);
//   • linha `removido` → sugestão dispensada (não aparece em lugar nenhum).
// modeloNovo = false (antes do SQL 40): comportamento antigo — sem linha vale o padrão do tipo.
function montarAtributos(tipoEstabelecimento, linhas = [], modeloNovo = false) {
  const padrao = PADRAO_POR_TIPO[normalizarTipoEstabelecimento(tipoEstabelecimento)];
  const porChave = new Map((linhas || []).map(l => [l.chave, l]));
  const lista = [];

  for (const chave of LEGADOS) {
    const l = porChave.get(chave);
    if (modeloNovo) {
      if (!l || l.removido) continue;
      lista.push({ chave, nome: l.nome, ordem: l.ordem, ativo: !!l.ativo, legado: true, personalizado: true });
      continue;
    }
    const nomePadrao = padrao[chave] || NOME_LEGADO[chave];
    lista.push({
      chave,
      nome: l ? l.nome : nomePadrao,
      ordem: l ? l.ordem : ORDEM_LEGADO[chave],
      ativo: l ? !!l.ativo : !!padrao[chave],
      legado: true,
      personalizado: !!l,
    });
  }
  for (const l of linhas || []) {
    if (ehLegado(l.chave) || l.removido) continue;
    lista.push({ chave: l.chave, nome: l.nome, ordem: l.ordem, ativo: !!l.ativo, legado: false, personalizado: true });
  }
  return lista.sort((a, b) => (a.ordem - b.ordem) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Sugestões do tipo de estabelecimento que a loja ainda não adicionou nem dispensou.
function sugestoesDoTipo(tipoEstabelecimento, linhas = []) {
  const padrao = PADRAO_POR_TIPO[normalizarTipoEstabelecimento(tipoEstabelecimento)];
  const porChave = new Map((linhas || []).map(l => [l.chave, l]));
  return LEGADOS.filter(c => padrao[c] && !porChave.has(c)).map(c => ({ chave: c, nome: padrao[c] }));
}

// Nome sugerido para uma chave legada neste tipo de estabelecimento (ou o nome geral).
function nomeSugerido(tipoEstabelecimento, chave) {
  const padrao = PADRAO_POR_TIPO[normalizarTipoEstabelecimento(tipoEstabelecimento)];
  return padrao[chave] || NOME_LEGADO[chave];
}

// Quantos atributos contam para o teto da loja: os ligados + os que a loja mexeu.
const contarParaTeto = (lista) => lista.filter(a => a.ativo || a.personalizado).length;

// Valores EXTRAS de uma variação (os atributos que não são tamanho/cor/gênero), já limpos:
// só chaves válidas, só texto não vazio, ordenados pela chave. Nunca lança.
function extrasDaVariacao(v) {
  const bruto = v && v.atributos && typeof v.atributos === 'object' && !Array.isArray(v.atributos) ? v.atributos : {};
  const out = {};
  for (const k of Object.keys(bruto).sort()) {
    if (!chaveValida(k) || ehLegado(k)) continue;
    const val = typeof bruto[k] === 'string' || typeof bruto[k] === 'number' ? String(bruto[k]).trim() : '';
    if (val) out[k] = val;
  }
  return out;
}

// Chaves de atributo preenchidas em ao menos uma variação (legados + extras).
function chavesUsadas(variacoes) {
  const usadas = new Set();
  for (const v of variacoes || []) {
    for (const k of LEGADOS) if (String(v?.[k] ?? '').trim()) usadas.add(k);
    for (const k of Object.keys(extrasDaVariacao(v))) usadas.add(k);
  }
  return usadas;
}

// Erro de teto levantado pelos gatilhos do SQL 31 ('TETO:<qual>:<numero>') → mensagem em português.
function mensagemTeto(error) {
  const m = /TETO:([a-z_]+):(\d+)/.exec(error?.message || '');
  if (!m) return null;
  const n = Number(m[2]).toLocaleString('pt-BR');
  const msgs = {
    atributos_loja:    `Limite de ${n} atributos de variação atingido para esta loja. Oculte algum que não usa mais ou fale com o suporte.`,
    valores_atributo:  `Limite de ${n} valores para este atributo atingido. Remova valores que não usa mais.`,
    valores_loja:      `Limite de ${n} valores de variação na loja atingido. Remova valores que não usa mais.`,
    variacoes_produto: `Limite de ${n} variações por produto atingido.`,
  };
  return msgs[m[1]] || `Limite atingido (${m[1]}).`;
}

// Texto da variação na ORDEM DOS ATRIBUTOS DA LOJA (ex.: "Frozen · P · Azul"). Só os valores,
// separados por " · ". `atributos` = lista de montarAtributos (ligados e ocultos). Valores de
// atributos que a loja não conhece mais entram no fim. Nunca lança.
function rotuloDaVariacao(v, atributos = []) {
  const extras = extrasDaVariacao(v);
  const partes = [];
  const usados = new Set();
  for (const a of atributos || []) {
    const bruto = ehLegado(a.chave) ? v?.[a.chave] : extras[a.chave];
    const val = bruto == null ? '' : String(bruto).trim();
    usados.add(a.chave);
    if (val) partes.push(val);
  }
  for (const k of LEGADOS) {
    if (usados.has(k)) continue;
    const val = v?.[k] == null ? '' : String(v[k]).trim();
    if (val) partes.push(val);
  }
  for (const [k, val] of Object.entries(extras)) if (!usados.has(k)) partes.push(val);
  return partes.join(' · ');
}

module.exports = {
  TETOS_ATRIBUTOS, LEGADOS, NOME_LEGADO, PADRAO_POR_TIPO, MODELOS_PRONTOS,
  normalizarTipoEstabelecimento, chaveDoNome, chaveValida, nomeIgual, ehLegado,
  montarAtributos, sugestoesDoTipo, nomeSugerido, contarParaTeto, mensagemTeto, extrasDaVariacao, chavesUsadas, rotuloDaVariacao,
};
