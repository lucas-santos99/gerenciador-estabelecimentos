// routes/consultaRoutes.js
// Consulta de CNPJ (dados públicos da Receita) pela BrasilAPI — usada pelo
// botão "Validar" das telas de cadastro para preencher o nome da empresa.
//   GET /api/consulta/cnpj/:cnpj  →  { encontrado, razao_social, nome_fantasia, situacao }
// CPF não tem consulta pública de nome, então só CNPJ.
// O serviço externo é gratuito e pode ficar fora do ar: qualquer falha vira
// uma resposta simples e a tela segue funcionando (é só uma ajuda).
const express = require("express");
const router = express.Router();
const authUser = require("../middlewares/authUser");

router.use(authUser);

const URL_BASE = "https://brasilapi.com.br/api/cnpj/v1/";
const CACHE_MS = 24 * 60 * 60 * 1000;     // dados de empresa mudam pouco
const CACHE_MAX = 2000;
const LIMITE_POR_HORA = 40;               // por usuário
const cache = new Map();                  // cnpj -> { ate, dados }
const usos = new Map();                   // userId -> { janelaAte, qtd }

function cnpjValido(valor) {
  const d = String(valor || "").replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const tam of [12, 13]) {
    const pesos = tam === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(d[i]) * pesos[i];
    const resto = soma % 11;
    if ((resto < 2 ? 0 : 11 - resto) !== Number(d[tam])) return false;
  }
  return true;
}

function passouDoLimite(userId) {
  const agora = Date.now();
  const u = usos.get(userId);
  if (!u || u.janelaAte <= agora) {
    usos.set(userId, { janelaAte: agora + 60 * 60 * 1000, qtd: 1 });
    return false;
  }
  u.qtd += 1;
  return u.qtd > LIMITE_POR_HORA;
}

router.get("/cnpj/:cnpj", async (req, res) => {
  try {
    const cnpj = String(req.params.cnpj || "").replace(/\D/g, "");
    if (!cnpjValido(cnpj)) return res.status(400).json({ error: "CNPJ inválido." });

    const emCache = cache.get(cnpj);
    if (emCache && emCache.ate > Date.now()) return res.json(emCache.dados);

    if (passouDoLimite(req.user?.id || req.ip)) {
      return res.status(429).json({ error: "Muitas consultas seguidas. Tente de novo daqui a pouco." });
    }

    let resp;
    try {
      resp = await fetch(URL_BASE + cnpj, { signal: AbortSignal.timeout(6000) });
    } catch (err) {
      console.error("[CONSULTA] CNPJ — serviço fora do ar ou lento:", err.message);
      return res.status(502).json({ error: "Não foi possível consultar o CNPJ agora." });
    }

    if (resp.status === 404) {
      const dados = { encontrado: false };
      cache.set(cnpj, { ate: Date.now() + CACHE_MS, dados });
      return res.json(dados);
    }
    if (!resp.ok) {
      console.error("[CONSULTA] CNPJ — resposta", resp.status);
      return res.status(502).json({ error: "Não foi possível consultar o CNPJ agora." });
    }

    const j = await resp.json();
    const dados = {
      encontrado:    true,
      razao_social:  (j.razao_social || "").trim() || null,
      nome_fantasia: (j.nome_fantasia || "").trim() || null,
      situacao:      (j.descricao_situacao_cadastral || "").trim() || null,
    };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cnpj, { ate: Date.now() + CACHE_MS, dados });
    res.json(dados);
  } catch (err) {
    console.error("[CONSULTA] CNPJ erro:", err.message);
    res.status(500).json({ error: "Erro ao consultar o CNPJ." });
  }
});

module.exports = router;
