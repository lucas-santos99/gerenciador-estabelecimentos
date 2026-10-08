// middlewares/limiteRequisicoes.js
//
// Limite de requisições (rate limit) em memória, sem dependência externa.
// Serve para barrar abuso (script martelando uma rota, clique repetido que
// geraria cobrança em série, etc.) sem atrapalhar o uso normal.
//
// Como funciona: janela fixa por chave. Passou do máximo na janela → 429 com
// mensagem em português e o cabeçalho Retry-After (segundos).
//
// Limites do servidor único (Railway): o contador vive na memória do
// processo e zera quando o servidor reinicia (deploy). Para o objetivo
// (barrar abuso), isso basta. Se um dia houver mais de uma instância,
// trocar por um contador compartilhado (ex.: Redis).
//
// Chaves:
//   • limiteIp({ max, janelaMs })      → por IP (precisa de `trust proxy`
//                                         no server.js para ler o IP real)
//   • limiteUsuario({ max, janelaMs })  → por usuário logado (use DEPOIS do
//                                         authUser); sem login, cai no IP
//   opção `soEscrita: true` → só conta POST/PUT/PATCH/DELETE (leituras
//   ficam livres).

const MSG_PADRAO = 'Muitas tentativas seguidas. Aguarde um instante e tente de novo.';
const MAX_CHAVES = 50000; // teto de memória: passou disso, limpa tudo

function criarLimite({ max, janelaMs = 60_000, mensagem = MSG_PADRAO, soEscrita = false, nome = 'limite', chaveDe }) {
  const contadores = new Map(); // chave -> { n, ate }

  // Faxina periódica das janelas vencidas.
  const faxina = setInterval(() => {
    const agora = Date.now();
    for (const [k, v] of contadores) if (v.ate <= agora) contadores.delete(k);
  }, Math.max(janelaMs, 30_000));
  if (faxina.unref) faxina.unref();

  return function limite(req, res, next) {
    if (soEscrita && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const chave = chaveDe(req);
    if (!chave) return next();

    const agora = Date.now();
    let c = contadores.get(chave);
    if (!c || c.ate <= agora) {
      if (contadores.size >= MAX_CHAVES) contadores.clear();
      c = { n: 0, ate: agora + janelaMs };
      contadores.set(chave, c);
    }
    c.n += 1;

    if (c.n > max) {
      const espera = Math.max(1, Math.ceil((c.ate - agora) / 1000));
      res.set('Retry-After', String(espera));
      // Registra só na primeira estouro de cada janela, para não encher o log.
      if (c.n === max + 1) console.error(`[LIMITE] ${nome} — 429 para ${chave} em ${req.method} ${req.originalUrl.split('?')[0]}`);
      return res.status(429).json({ error: mensagem });
    }
    next();
  };
}

const ipDe = (req) => req.ip || req.socket?.remoteAddress || null;

// Chave por "quem está logado" sem precisar do authUser (que roda dentro de
// cada rota): usa o próprio token do cabeçalho. O token muda de tempos em
// tempos, o que não atrapalha para o objetivo (contar uma rajada de escritas).
const chaveToken = (req) => {
  const h = req.headers?.authorization;
  if (h && h.length > 20) return `t:${h.slice(-40)}`;
  return ipDe(req);
};

function limiteIp(opcoes) {
  return criarLimite({ nome: 'ip', ...opcoes, chaveDe: (req) => ipDe(req) });
}

function limiteUsuario(opcoes) {
  return criarLimite({
    nome: 'usuario',
    ...opcoes,
    chaveDe: (req) => (req.user?.id ? `u:${req.user.id}` : ipDe(req)),
  });
}

// ── Limites prontos (um contador próprio para cada um) ──────────────────
module.exports = {
  limiteIp, limiteUsuario, criarLimite,

  // Rede de segurança para qualquer rota: bem folgado (uma loja com vários
  // operadores no mesmo Wi-Fi divide o mesmo IP).
  limiteGlobalIp: limiteIp({ max: 1000, janelaMs: 60_000, nome: 'global' }),

  // Webhooks públicos (Meta, Efí, Asaas): chegam sem login.
  limiteWebhook: limiteIp({ max: 300, janelaMs: 60_000, nome: 'webhook' }),

  // Gerar cobrança (Pix/Asaas): cria cobrança de verdade no provedor.
  limiteCobranca: limiteUsuario({ max: 10, janelaMs: 60_000, nome: 'cobranca',
    mensagem: 'Muitas cobranças geradas em pouco tempo. Aguarde um minuto e tente de novo.' }),

  // Criar usuário/estabelecimento, redefinir senha, apagar definitivo.
  limiteAcaoSensivel: limiteUsuario({ max: 20, janelaMs: 60_000, nome: 'acao-sensivel' }),

  // Escritas em geral (criar/editar/excluir qualquer coisa), por usuário.
  // 200/min é bem acima do uso humano (uma venda por vez no PDV, formulários).
  limiteEscritaGeral: criarLimite({ max: 200, janelaMs: 60_000, soEscrita: true, nome: 'escrita-geral', chaveDe: chaveToken,
    mensagem: 'Muitas alterações seguidas. Aguarde um instante e tente de novo.' }),

  // Qualquer escrita nas rotas de WhatsApp do dono (assinar, pacotes, vínculos…).
  limiteEscritaWhatsapp: limiteUsuario({ max: 30, janelaMs: 60_000, soEscrita: true, nome: 'whatsapp-escrita' }),
};
