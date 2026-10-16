// routes/barraSistemaRoutes.js
// ============================================================
// BARRA INFERIOR DO SISTEMA (16/10/2026)
// Faixa fina no rodapé do sistema do estabelecimento: licença, marca do
// sistema (nome / logo / link), Fale Conosco, tema e Sair. O SuperAdmin
// controla a marca e o tamanho da barra pelo painel de admin.
//
// Montado em superAdminRoutes.js (/superadmin/barra-sistema), que já exige
// login. Leitura: qualquer usuário logado (a barra aparece pra todos).
// Gravação: só SuperAdmin.
// Salvo em config_sistema, chave 'barra_sistema' (JSON).
// ============================================================
const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const somenteSuperAdmin = require('../middlewares/somenteSuperAdmin');
const { registrar } = require('./auditoriaRoutes');
const { otimizarImagem } = require('../utils/otimizarImagem');
const { apagarAnterior } = require('../utils/storageLimpeza');

const CHAVE = 'barra_sistema';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const BLOCOS = ['licenca', 'boas_vindas', 'marca', 'redes', 'livre', 'versao'];
const FONTES = ['padrao', 'serifada', 'mono', 'cursiva', 'arredondada', 'condensada'];
const TEXTO_PADRAO = (t) => ({ ativa: false, texto: t, link: '', fonte: 'padrao', tamanho: 12, negrito: false, italico: false, sublinhado: false, cor: '', cor_escuro: '' });
// Mensagens livres da barra: 'boas_vindas' (aceita {nome}) e 'livre' (texto e/ou link).
const TEXTOS = { boas_vindas: 'Bem-vindo, {nome}!', livre: '' };
const COR = /^#[0-9a-f]{6}$/i;
const bool = (v) => v === true || v === 'true';
const PADRAO = {
  mostrar_marca: true,
  nome: 'Lucas J. Systems',
  link: '',
  logo_url: '',
  exibicao: 'nome',      // 'nome' | 'logo' | 'logo_e_nome'
  tamanho: 'medio',      // 'pequeno' | 'medio' | 'grande'
  mostrar_prefixo: true, // "Desenvolvido por" antes da marca
  prefixo: 'Desenvolvido por',
  redes: { instagram: '', facebook: '', whatsapp: '', twitter: '' },
  ordem_blocos: ['licenca', 'boas_vindas', 'marca', 'redes', 'livre', 'versao'],
  ordem_redes: ['instagram', 'facebook', 'whatsapp', 'twitter'],
  ordem_botoes: ['fale_conosco', 'tema', 'sair'],
  textos: { boas_vindas: TEXTO_PADRAO('Bem-vindo, {nome}!'), livre: TEXTO_PADRAO('') },
  posicoes: { licenca: 'esq', boas_vindas: 'esq', marca: 'esq', redes: 'esq', livre: 'esq', versao: 'esq' }, // 'esq' | 'centro' | 'dir'
  mostrar_versao: false,
  versao: '', // vazio = usa a identificação automática do build
};
const BOTOES = ['fale_conosco', 'tema', 'sair'];
// Aceita só itens válidos, sem repetir, e completa o que faltar no fim.
function ordenar(lista, validos) {
  const l = Array.isArray(lista) ? lista.filter((x, i) => validos.includes(x) && lista.indexOf(x) === i) : [];
  return [...l, ...validos.filter(x => !l.includes(x))];
}
const REDES = ['instagram', 'facebook', 'whatsapp', 'twitter'];
const EXIBICOES = ['nome', 'logo', 'logo_e_nome'];
const TAMANHOS  = ['pequeno', 'medio', 'grande'];

function texto(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);
}

// Só aceita http(s). Qualquer outra coisa (javascript:, data:…) é descartada.
function urlHttp(v) {
  const t = texto(v, 300);
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : null;
  } catch { return null; }
}

// Aceita o endereço completo, o @usuário ou só o nome/número e devolve o link https.
// Retorna '' (vazio), um link, ou null (inválido).
function normalizarRede(rede, bruto) {
  const t = texto(bruto, 300);
  if (!t) return '';
  if (rede === 'whatsapp') {
    if (/^https?:\/\//i.test(t) || /^(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/i.test(t)) return urlHttp(t);
    const d = t.replace(/\D/g, '');
    if (d.length < 10 || d.length > 15) return null;
    return `https://wa.me/${d.length <= 11 ? '55' + d : d}`;
  }
  if (/^https?:\/\//i.test(t) || /^(www\.)?[a-z0-9-]+\.[a-z]{2,}\//i.test(t)) return urlHttp(t);
  const usuario = t.replace(/^@/, '');
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(usuario)) return null;
  const base = { instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', twitter: 'https://x.com/' }[rede];
  return base + usuario;
}

function limpar(entrada) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const erros = [];
  const cfg = { ...PADRAO, redes: { ...PADRAO.redes }, ordem_blocos: [...PADRAO.ordem_blocos], ordem_redes: [...PADRAO.ordem_redes], ordem_botoes: [...PADRAO.ordem_botoes], posicoes: { ...PADRAO.posicoes }, textos: { boas_vindas: { ...PADRAO.textos.boas_vindas }, livre: { ...PADRAO.textos.livre } } };
  if ('mostrar_marca' in e) cfg.mostrar_marca = e.mostrar_marca === true || e.mostrar_marca === 'true';
  if ('nome' in e) cfg.nome = texto(e.nome, 60);
  if ('link' in e) {
    const l = urlHttp(e.link);
    if (l === null) erros.push('Link inválido. Use um endereço começando com http:// ou https://.');
    else cfg.link = l;
  }
  if ('logo_url' in e) {
    const l = urlHttp(e.logo_url);
    if (l === null) erros.push('Endereço da logo inválido.');
    else cfg.logo_url = l;
  }
  if ('exibicao' in e) {
    if (!EXIBICOES.includes(e.exibicao)) erros.push('Exibição inválida.');
    else cfg.exibicao = e.exibicao;
  }
  if ('tamanho' in e) {
    if (!TAMANHOS.includes(e.tamanho)) erros.push('Tamanho inválido.');
    else cfg.tamanho = e.tamanho;
  }
  if ('mostrar_prefixo' in e) cfg.mostrar_prefixo = e.mostrar_prefixo === true || e.mostrar_prefixo === 'true';
  if ('prefixo' in e) cfg.prefixo = texto(e.prefixo, 30);
  cfg.ordem_blocos = ordenar(e.ordem_blocos, BLOCOS);
  cfg.ordem_redes = ordenar(e.ordem_redes, REDES);
  cfg.ordem_botoes = ordenar(e.ordem_botoes, BOTOES);
  if (e.posicoes && typeof e.posicoes === 'object') {
    cfg.posicoes = { ...cfg.posicoes };
    for (const b of BLOCOS) if (['esq', 'centro', 'dir'].includes(e.posicoes[b])) cfg.posicoes[b] = e.posicoes[b];
  }
  if ('mostrar_versao' in e) cfg.mostrar_versao = bool(e.mostrar_versao);
  if ('versao' in e) cfg.versao = texto(e.versao, 30);
  if (e.textos && typeof e.textos === 'object') {
    const textos = {};
    for (const k of Object.keys(TEXTOS)) {
      const t = e.textos[k] && typeof e.textos[k] === 'object' ? e.textos[k] : {};
      const item = TEXTO_PADRAO(TEXTOS[k]);
      if ('ativa' in t) item.ativa = bool(t.ativa);
      if ('texto' in t) item.texto = texto(t.texto, 140);
      if ('link' in t) {
        const l = urlHttp(t.link);
        if (l === null) erros.push('Link da mensagem inválido. Use um endereço http:// ou https://.');
        else item.link = l;
      }
      if ('fonte' in t) item.fonte = FONTES.includes(t.fonte) ? t.fonte : 'padrao';
      if ('tamanho' in t) { const n = parseInt(t.tamanho, 10); item.tamanho = n >= 10 && n <= 20 ? n : 12; }
      item.negrito = bool(t.negrito); item.italico = bool(t.italico); item.sublinhado = bool(t.sublinhado);
      for (const c of ['cor', 'cor_escuro']) {
        const v = texto(t[c], 7);
        if (v && !COR.test(v)) erros.push('Cor inválida. Use o formato #RRGGBB.');
        else item[c] = v.toLowerCase();
      }
      textos[k] = item;
    }
    cfg.textos = textos;
  }
  if (e.redes && typeof e.redes === 'object') {
    for (const r of REDES) {
      if (!(r in e.redes)) continue;
      const v = normalizarRede(r, e.redes[r]);
      if (v === null) erros.push(`Endereço de ${r === 'twitter' ? 'X (Twitter)' : r[0].toUpperCase() + r.slice(1)} inválido.`);
      else cfg.redes = { ...cfg.redes, [r]: v };
    }
  }
  // Mostrar "só logo" sem logo, ou "só nome" sem nome, deixaria a marca vazia.
  if (cfg.exibicao === 'logo' && !cfg.logo_url) cfg.exibicao = 'nome';
  if (cfg.exibicao === 'logo_e_nome' && !cfg.logo_url) cfg.exibicao = 'nome';
  return { config: cfg, erros };
}

async function ler(db) {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', CHAVE).maybeSingle();
  if (!data?.valor) return { ...PADRAO, redes: { ...PADRAO.redes } };
  try { return limpar(JSON.parse(data.valor)).config; } catch { return { ...PADRAO }; }
}

router.get('/', async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    res.set('Cache-Control', 'no-store');
    res.json(await ler(db));
  } catch (err) {
    console.error('ERRO GET barra-sistema:', err);
    res.status(500).json({ error: 'Erro ao buscar a barra do sistema.' });
  }
});

router.put('/', somenteSuperAdmin, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { config, erros } = limpar(req.body);
    if (erros.length) return res.status(400).json({ error: erros[0], erros });

    const anterior = await ler(db).catch(() => ({}));
    const { error } = await db.from('config_sistema').upsert({ chave: CHAVE, valor: JSON.stringify(config) }, { onConflict: 'chave' });
    if (error) throw error;
    if (anterior?.logo_url && anterior.logo_url !== config.logo_url) {
      await apagarAnterior(anterior.logo_url, ['barra/'], config.logo_url);
    }

    await registrar({
      usuario_nome: req.user?.nome, usuario_email: req.user?.email,
      modulo: 'configuracoes', acao: 'editar_barra_sistema',
      descricao: 'Alterou a barra inferior do sistema (marca, link, tamanho)',
      escopo: 'admin_global',
    });
    res.json({ success: true, config });
  } catch (err) {
    console.error('ERRO PUT barra-sistema:', err);
    res.status(500).json({ error: 'Erro ao salvar a barra do sistema.' });
  }
});

// Só envia e devolve o endereço; quem grava é o PUT (botão "Salvar").
router.post('/logo', somenteSuperAdmin, (req, res, next) => {
  upload.single('imagem')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Imagem maior que 5 MB.' : 'Erro ao receber a imagem.';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' });
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Formato não aceito. Use PNG, JPG, WEBP ou GIF.' });
    }
    const otim = await otimizarImagem(req.file.buffer, req.file.mimetype, 'logo');
    if (otim.erro) return res.status(400).json({ error: otim.erro });
    const nomeArquivo = `barra/logo-${Date.now()}.${otim.ext}`;
    const { error: upErr } = await db.storage.from('logos')
      .upload(nomeArquivo, otim.buffer, { upsert: false, contentType: otim.mimetype, cacheControl: '31536000' });
    if (upErr) return res.status(400).json({ error: upErr.message });
    res.json({ success: true, url: db.storage.from('logos').getPublicUrl(nomeArquivo).data.publicUrl });
  } catch (err) {
    console.error('ERRO POST barra-sistema/logo:', err);
    res.status(500).json({ error: 'Erro ao enviar a logo.' });
  }
});

module.exports = router;
