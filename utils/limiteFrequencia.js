// utils/limiteFrequencia.js
//
// Limite de AÇÕES POR MINUTO, por loja + pessoa + tipo de ação. É uma trava
// técnica contra script/disparo em excesso — bem acima do uso humano normal
// (quem usa a tela nunca chega perto). Fica na memória do processo: se o
// servidor reiniciar, zera (é só proteção, não cobrança).
//
// Uso:  router.post('/rota', limitarFrequencia('atributos', 30), ...)

const baldes = new Map();

function limitarFrequencia(nome, max, janelaMs = 60000) {
  return (req, res, next) => {
    const quem = `${nome}:${req.params?.id || ''}:${req.user?.id || req.ip}`;
    const agora = Date.now();
    let b = baldes.get(quem);
    if (!b || agora - b.inicio >= janelaMs) {
      b = { inicio: agora, n: 0 };
      baldes.set(quem, b);
    }
    b.n += 1;
    if (b.n > max) {
      const espera = Math.max(1, Math.ceil((b.inicio + janelaMs - agora) / 1000));
      res.set('Retry-After', String(espera));
      console.error(`[LIMITE] ${nome}: ${max}/min excedido (${quem})`);
      return res.status(429).json({ error: `Muitas ações em pouco tempo. Aguarde ${espera} segundo(s) e tente de novo.` });
    }
    next();
  };
}

// Limpa baldes vencidos (a cada 5 min) pra o mapa não crescer.
setInterval(() => {
  const agora = Date.now();
  for (const [k, b] of baldes) if (agora - b.inicio > 120000) baldes.delete(k);
}, 300000).unref();

module.exports = { limitarFrequencia };
