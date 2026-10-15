// utils/otimizarImagem.js
//
// Padrão único de imagens do sistema: NENHUMA imagem vai pro Storage no tamanho original.
// Redimensiona (maior lado limitado), comprime e respeita a transparência do PNG.
// Mantém o mesmo formato de entrada (JPEG→JPEG, PNG→PNG, WebP→WebP) pra não quebrar
// quem consome a imagem (PDF de relatório, e-mail, etc.). GIF/SVG passam direto.
// Devolve { buffer, mimetype, ext } ou { erro } — quem chama responde 400 com a mensagem.

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

// Limite DURO: se mesmo depois de otimizar passar de MAX_FINAL × alvo, a imagem é RECUSADA.
// Falhou de verdade (arquivo corrompido, formato falso, gigante demais)? Também recusa —
// nunca grava no Storage algo que não passou pela otimização.
const MAX_ENTRADA = 8 * 1024 * 1024;        // nada acima de 8 MB nem é processado
const MAX_PIXELS  = 40 * 1000 * 1000;       // ~40 megapixels (protege a memória do servidor)
const MAX_GIF     = 300 * 1024;             // GIF não é recomprimido: só aceita se já for leve
const MAX_FINAL   = 2;                      // resultado ≤ 2× o alvo do perfil

async function otimizarImagem(buffer, mimetype, perfil = 'logo') {
  const tipo = mimetype === 'image/jpg' ? 'image/jpeg' : mimetype;
  if (!EXT[tipo]) return { erro: 'Formato de imagem não aceito. Use PNG, JPG ou WEBP.' };
  if (!buffer || !buffer.length) return { erro: 'Arquivo vazio.' };
  if (buffer.length > MAX_ENTRADA) return { erro: 'Imagem muito grande (máximo 8 MB).' };
  if (tipo === 'image/gif') {
    if (buffer.length > MAX_GIF) return { erro: 'GIF muito pesado (máximo 300 KB). Use PNG, JPG ou WEBP.' };
    return { buffer, mimetype: tipo, ext: 'gif' };
  }
  const cfg = PERFIS[perfil] || PERFIS.logo;
  try {
    let lado = cfg.lado;
    let melhor = null;
    for (const q of [82, 72, 62, 50, 40]) {
      const img = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).rotate() // respeita a orientação da foto do celular
        .resize({ width: lado, height: lado, fit: 'inside', withoutEnlargement: true });
      const out = await codificar(img, tipo, q);
      melhor = out;
      if (out.length <= cfg.bytes) break;
      if (q === 62) lado = Math.round(lado * 0.8); // ainda grande: diminui também as dimensões
      if (q === 50) lado = Math.round(lado * 0.7);
    }
    if (melhor.length > cfg.bytes * MAX_FINAL) {
      return { erro: 'Não foi possível reduzir esta imagem para um tamanho aceitável. Tente uma imagem mais simples ou menor.' };
    }
    // otimizado ficou maior que o original (imagem já minúscula)? mantém o original, que já é leve
    if (melhor.length >= buffer.length && buffer.length <= cfg.bytes) return { buffer, mimetype: tipo, ext: EXT[tipo] };
    return { buffer: melhor, mimetype: tipo, ext: EXT[tipo] };
  } catch (err) {
    console.error('[IMAGEM] Imagem recusada:', err.message);
    return { erro: 'Imagem inválida, corrompida ou grande demais. Tente outra (PNG, JPG ou WEBP).' };
  }
}

module.exports = { otimizarImagem, PERFIS };
