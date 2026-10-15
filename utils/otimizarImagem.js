// utils/otimizarImagem.js
//
// Padrão único de imagens do sistema: NENHUMA imagem vai pro Storage no tamanho original.
// Redimensiona (maior lado limitado), comprime e respeita a transparência do PNG.
// Mantém o mesmo formato de entrada (JPEG→JPEG, PNG→PNG, WebP→WebP) pra não quebrar
// quem consome a imagem (PDF de relatório, e-mail, etc.). GIF/SVG passam direto.
// Falhou ou ficou maior que o original? Devolve o original — otimizar nunca quebra um upload.

const sharp = require('sharp');

// maior lado (px) e alvo de tamanho (bytes) por tipo de uso
const PERFIS = {
  logo:       { lado: 600,  bytes: 150 * 1024 },
  banner:     { lado: 1280, bytes: 220 * 1024 },
  avatar:     { lado: 400,  bytes: 80 * 1024 },
  catalogo:   { lado: 800,  bytes: 150 * 1024 },
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

async function codificar(img, tipo, qualidade) {
  if (tipo === 'image/jpeg') return img.jpeg({ quality: qualidade, mozjpeg: true }).toBuffer();
  if (tipo === 'image/webp') return img.webp({ quality: qualidade }).toBuffer();
  return img.png({ palette: true, quality: qualidade, compressionLevel: 9, effort: 7 }).toBuffer();
}

async function otimizarImagem(buffer, mimetype, perfil = 'logo') {
  const tipo = mimetype === 'image/jpg' ? 'image/jpeg' : mimetype;
  const original = { buffer, mimetype: tipo, ext: EXT[tipo] || 'jpg' };
  if (!EXT[tipo] || tipo === 'image/gif') return original; // gif/outros: não mexe
  const cfg = PERFIS[perfil] || PERFIS.logo;
  try {
    let lado = cfg.lado;
    let melhor = null;
    for (const q of [82, 72, 62, 50]) {
      const img = sharp(buffer, { failOn: 'none' }).rotate() // respeita a orientação da foto do celular
        .resize({ width: lado, height: lado, fit: 'inside', withoutEnlargement: true });
      const out = await codificar(img, tipo, q);
      melhor = out;
      if (out.length <= cfg.bytes) break;
      if (q === 62) lado = Math.round(lado * 0.8); // ainda grande: diminui também as dimensões
    }
    if (!melhor || melhor.length >= buffer.length) return original;
    return { buffer: melhor, mimetype: tipo, ext: EXT[tipo] };
  } catch (err) {
    console.error('[IMAGEM] Falha ao otimizar, usando o original:', err.message);
    return original;
  }
}

module.exports = { otimizarImagem, PERFIS };
