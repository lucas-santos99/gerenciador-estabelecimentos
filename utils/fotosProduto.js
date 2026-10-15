// utils/fotosProduto.js
//
// Fotos de produto/variação (bucket público `logos`, pasta produtos/<loja>/…).
// Regras pensadas para NÃO pesar no sistema nem no custo de armazenamento:
//  • o navegador já comprime (maior lado 800 px, WebP/JPEG, alvo ≤ ~120 KB);
//  • o servidor confere de novo: só JPEG/WebP/PNG de verdade (assinatura do arquivo)
//    e no máximo 300 KB — o que passar disso é recusado, nunca gravado;
//  • trocar ou remover uma foto APAGA o arquivo antigo do Storage (antes ficava órfão);
//  • cada produto tem no máximo 2 fotos (principal + extra) e cada variação 1.

const db = require('../db/supabaseAdmin');

const BUCKET = 'logos';
const MAX_BYTES = 300 * 1024;

const TIPOS = {
  jpeg: { ext: 'jpg',  mime: 'image/jpeg', confere: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  png:  { ext: 'png',  mime: 'image/png',  confere: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) },
  webp: { ext: 'webp', mime: 'image/webp', confere: b => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

// "data:image/webp;base64,...." → { buffer, tipo } ou { erro }
function lerImagemBase64(dataUrl) {
  if (typeof dataUrl !== 'string') return { erro: 'Envie uma imagem válida.' };
  const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { erro: 'Formato de imagem inválido. Use JPG, PNG ou WebP.' };
  const nome = m[1] === 'jpg' ? 'jpeg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) return { erro: 'Imagem vazia.' };
  if (buffer.length > MAX_BYTES) {
    return { erro: `A foto ficou com ${Math.round(buffer.length / 1024)} KB — o máximo é ${MAX_BYTES / 1024} KB. Tente uma foto menor.` };
  }
  const tipo = TIPOS[nome];
  if (!tipo.confere(buffer)) return { erro: 'O arquivo não parece ser uma imagem válida.' };
  return { buffer, tipo };
}

// Caminho dentro do bucket a partir da URL pública — só aceita arquivo desta loja.
function caminhoDaUrl(url, lojaId) {
  if (typeof url !== 'string') return null;
  const marca = `/${BUCKET}/produtos/${lojaId}/`;
  const i = url.indexOf(marca);
  if (i < 0) return null;
  const caminho = url.slice(i + BUCKET.length + 2).split('?')[0];
  return caminho.startsWith(`produtos/${lojaId}/`) && !caminho.includes('..') ? decodeURIComponent(caminho) : null;
}

// Apaga do Storage (best-effort: nunca derruba a requisição).
async function apagarFoto(url, lojaId) {
  try {
    const caminho = caminhoDaUrl(url, lojaId);
    if (!caminho) return false; // foto de catálogo/Open Food Facts ou de outra origem: não é nossa para apagar
    const { error } = await db.storage.from(BUCKET).remove([caminho]);
    if (error) console.error('[FOTOS] não apagou do storage:', error.message);
    return !error;
  } catch (e) {
    console.error('[FOTOS] erro ao apagar foto:', e.message);
    return false;
  }
}

// Sobe e devolve a URL pública. `pasta` ex.: `produtos/<loja>` ou `produtos/<loja>/variacoes`.
async function subirFoto({ pasta, nomeBase, buffer, tipo }) {
  const caminho = `${pasta}/${nomeBase}-${Date.now()}.${tipo.ext}`;
  const { error } = await db.storage.from(BUCKET).upload(caminho, buffer, {
    upsert: true, contentType: tipo.mime, cacheControl: '31536000', // nome muda a cada envio: cache longo é seguro e acelera
  });
  if (error) return { erro: error.message };
  return { url: db.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl };
}

module.exports = { MAX_BYTES, lerImagemBase64, subirFoto, apagarFoto, caminhoDaUrl };
