// src/utils/filtroPalavroes.js (backend)
//
// Bloqueia nome/marca de produto com palavras ofensivas -- protege tanto o
// cadastro do proprio estabelecimento quanto o catalogo global
// compartilhado entre lojas (ver atualizarCatalogoGlobal/salvarNoCatalogoGlobal
// em estabelecimentoRoutes.js), que qualquer operador com permissao de
// editar estoque consegue alterar -- sem essa checagem, um funcionario mal
// intencionado numa unica loja conseguiria "vazar" um palavrao pro nome
// sugerido em todas as outras lojas que bipassem o mesmo codigo depois.
//
// Lista base: "List of Dirty, Naughty, Obscene, and Otherwise Bad Words"
// (Shutterstock/LDNOOBW, licenca CC-BY 4.0), recorte em portugues --
// https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
const PALAVRAS_PROIBIDAS = require('./palavrasProibidas.json');

// Faixa Unicode \\u0300-\\u036f = acentos combinantes (mesma tecnica ja
// usada em normalizarMarca, no ProdutoModal.jsx do frontend).
function normalizar(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// A lista tem entradas de uma palavra so e algumas expressoes de mais de
// uma palavra. Palavra unica: compara por token inteiro (Set), pra nao
// barrar um nome legitimo que so contenha um pedaco parecido com a lista
// (coincidencia de silabas). Expressao de varias palavras: compara por
// trecho normalizado dentro do texto, ja que dificilmente aparece por
// coincidencia numa frase qualquer.
const PROIBIDAS_NORMALIZADAS = PALAVRAS_PROIBIDAS.map(normalizar);
const PALAVRAS_UNICAS = new Set(PROIBIDAS_NORMALIZADAS.filter(p => !p.includes(' ')));
const EXPRESSOES = PROIBIDAS_NORMALIZADAS.filter(p => p.includes(' '));

function contemPalavraProibida(texto) {
  if (!texto) return false;
  const normalizado = normalizar(texto);
  const palavras = normalizado.split(/[^a-z0-9]+/).filter(Boolean);
  if (palavras.some(p => PALAVRAS_UNICAS.has(p))) return true;
  return EXPRESSOES.some(exp => normalizado.includes(exp));
}

module.exports = { contemPalavraProibida };
