// utils/storageLimpeza.js
//
// Ao trocar/remover uma imagem, apaga o arquivo ANTERIOR do Storage (bucket "logos"),
// pra não acumular lixo. Só apaga se o endereço for de uma pasta nossa permitida
// (prefixos) e diferente do arquivo novo — nunca mexe no catálogo compartilhado
// nem em arquivo de outra loja. Falha ao apagar nunca quebra a operação principal.

const db = require('../db/supabaseAdmin');

function caminhoNosso(url, prefixos) {
  const m = String(url || '').match(/\/object\/public\/logos\/([^?#]+)/);
  if (!m) return null;
  let caminho;
  try { caminho = decodeURIComponent(m[1]); } catch { return null; }
  if (caminho.includes('..')) return null;
  return prefixos.some(p => caminho.startsWith(p)) ? caminho : null;
}

async function apagarAnterior(urlAntiga, prefixos, urlNova = null) {
  try {
    const antigo = caminhoNosso(urlAntiga, prefixos);
    if (!antigo) return;
    if (urlNova && caminhoNosso(urlNova, prefixos) === antigo) return; // mesmo arquivo
    const { error } = await db.storage.from('logos').remove([antigo]);
    if (error) console.error('[STORAGE] Não apagou arquivo antigo:', antigo, error.message);
  } catch (err) {
    console.error('[STORAGE] Erro ao apagar arquivo antigo:', err.message);
  }
}

module.exports = { apagarAnterior, caminhoNosso };
