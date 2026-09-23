// routes/identidadeRelatoriosRoutes.js
// ============================================================
// IDENTIDADE DOS RELATÓRIOS (23/09/2026)
//
// Cabeçalho e rodapé padrão de TODOS os relatórios do sistema — PDFs,
// impressões, planilhas Excel e o recibo do PDV. Editável a qualquer
// momento por qualquer SuperAdmin (master ou comum).
//
// Montado dentro de superAdminRoutes.js (/superadmin/identidade-relatorios),
// que já exige login (authUser) em tudo.
//
// Onde fica salvo: config_sistema, chave 'relatorio_identidade', um JSON
//   { versao: 1, padrao: { ...campos }, por_tipo: { <tipo>: { ...campos } } }
// - padrao   → vale pra todos os relatórios (opção 1, em uso hoje)
// - por_tipo → sobrescreve campos só de um tipo de relatório (opção 2,
//              aba "Por tipo de relatório" da tela). O frontend resolve na
//              ordem: valores de fábrica → padrao → por_tipo.
//
// Leitura (GET) liberada pra qualquer usuário logado: comerciante e
// operador precisam dela pra montar o relatório. Não tem nada sigiloso
// aqui — é o mesmo texto que sai impresso no papel.
// ============================================================
const express = require('express');
const multer  = require('multer');

const somenteSuperAdmin = require('../middlewares/somenteSuperAdmin');
const { registrar } = require('./auditoriaRoutes');

const router = express.Router();

const CHAVE = 'relatorio_identidade';
const TAMANHO_MAX_LOGO = 5 * 1024 * 1024; // mesmo limite do bucket "logos"
const TIPOS_IMAGEM = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXTENSAO = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAX_LOGO, files: 1 },
});

// ── Campos aceitos (qualquer outro é descartado) ─────────────
// tipo: 'texto' (com limite), 'bool', 'cor' (#rrggbb), 'url' (https),
//       'enum' (lista fechada), 'numero' (inteiro entre min e max)
const CAMPOS = {
  cabecalho_modo:        { tipo: 'enum', valores: ['loja', 'loja_e_marca'] },
  nome_sistema:          { tipo: 'texto', max: 80 },
  marca_nome:            { tipo: 'texto', max: 80 },
  marca_logo_url:        { tipo: 'url' },
  sistema_logo_url:      { tipo: 'url' },
  marca_exibicao:        { tipo: 'enum', valores: ['logo', 'nome', 'logo_e_nome'] },
  sistema_exibicao:      { tipo: 'enum', valores: ['logo', 'nome', 'logo_e_nome'] },
  escala_cabecalho:      { tipo: 'numero', min: 70, max: 160 },
  escala_rodape:         { tipo: 'numero', min: 70, max: 160 },
  cor_faixa:             { tipo: 'cor' },
  cor_texto_faixa:       { tipo: 'cor' },
  cor_destaque:          { tipo: 'cor' },
  mostrar_logo_loja:     { tipo: 'bool' },
  mostrar_cnpj:          { tipo: 'bool' },
  mostrar_endereco:      { tipo: 'bool' },
  mostrar_telefone:      { tipo: 'bool' },
  mostrar_email:         { tipo: 'bool' },
  rodape_gerado_por:     { tipo: 'texto', max: 160 },
  site:                  { tipo: 'texto', max: 120 },
  instagram:             { tipo: 'texto', max: 60 },
  whatsapp:              { tipo: 'texto', max: 30 },
  email:                 { tipo: 'texto', max: 120 },
  rodape_texto_livre:    { tipo: 'texto', max: 300 },
  mostrar_contatos_rodape: { tipo: 'bool' },
  mostrar_data_geracao:  { tipo: 'bool' },
  mostrar_paginacao:     { tipo: 'bool' },
  recibo_mostrar_logo_loja: { tipo: 'bool' },
  recibo_mostrar_dados_loja: { tipo: 'bool' },
  recibo_mensagem:       { tipo: 'texto', max: 120 },
  recibo_rodape:         { tipo: 'texto', max: 120 },
};

// Tipos de relatório que podem ter override próprio (opção 2).
// 23/09/2026: o backend NÃO guarda mais a lista de tipos — ela existe só
// no frontend (TIPOS_RELATORIO em src/utils/relatorioIdentidade.js). Assim
// um relatório novo entra na aba "Por tipo" só de ser cadastrado lá.
// Aqui só confere se o NOME do tipo tem formato válido (minúsculas,
// números e "_", começando por letra, até 40 caracteres) e limita a
// quantidade. O conteúdo de cada tipo continua passando pela mesma
// validação campo a campo do padrão (CAMPOS acima).
const FORMATO_TIPO = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TIPOS = 100;

function limparTexto(v, max) {
  if (v === null || v === undefined) return '';
  // Sem quebra de linha nem caractere de controle — é texto de uma linha
  // que vai pro PDF, pra planilha e pra página de impressão.
  return String(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);
}

function limparBloco(entrada) {
  const saida = {};
  const erros = [];
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return { saida, erros };

  for (const [campo, regra] of Object.entries(CAMPOS)) {
    if (!(campo in entrada)) continue;
    const v = entrada[campo];
    switch (regra.tipo) {
      case 'bool':
        saida[campo] = v === true || v === 'true';
        break;
      case 'texto':
        saida[campo] = limparTexto(v, regra.max);
        break;
      case 'enum':
        if (regra.valores.includes(v)) saida[campo] = v;
        else erros.push(`Valor inválido em "${campo}".`);
        break;
      case 'cor':
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) saida[campo] = v.toLowerCase();
        else erros.push(`Cor inválida em "${campo}" (use o formato #RRGGBB).`);
        break;
      case 'numero': {
        const n = Math.round(Number(v));
        if (Number.isFinite(n) && n >= regra.min && n <= regra.max) saida[campo] = n;
        else erros.push(`Valor fora do limite em "${campo}" (${regra.min} a ${regra.max}).`);
        break;
      }
      case 'url':
        if (v === '' || v === null) saida[campo] = '';
        else if (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) && v.length <= 500) saida[campo] = v;
        else erros.push(`Endereço de imagem inválido em "${campo}".`);
        break;
      default:
        break;
    }
  }
  return { saida, erros };
}

function limparConfig(body) {
  const erros = [];
  const { saida: padrao, erros: e1 } = limparBloco(body?.padrao);
  erros.push(...e1);

  const por_tipo = {};
  const entradaPorTipo = body?.por_tipo;
  if (entradaPorTipo && typeof entradaPorTipo === 'object' && !Array.isArray(entradaPorTipo)) {
    for (const [tipo, bloco] of Object.entries(entradaPorTipo)) {
      if (!FORMATO_TIPO.test(tipo)) continue;
      if (Object.keys(por_tipo).length >= MAX_TIPOS) break;
      const { saida, erros: e2 } = limparBloco(bloco);
      erros.push(...e2.map(m => `[${tipo}] ${m}`));
      if (Object.keys(saida).length) por_tipo[tipo] = saida;
    }
  }
  return { config: { versao: 1, padrao, por_tipo }, erros };
}

async function lerConfig(db) {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', CHAVE).maybeSingle();
  if (!data?.valor) return { versao: 1, padrao: {}, por_tipo: {} };
  try {
    const obj = JSON.parse(data.valor);
    // Passa pelo mesmo filtro da gravação — se alguém editar o banco à
    // mão com algo estranho, não chega no navegador de ninguém.
    return limparConfig(obj).config;
  } catch {
    return { versao: 1, padrao: {}, por_tipo: {} };
  }
}

// ── GET — qualquer usuário logado ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const config = await lerConfig(db);
    res.set('Cache-Control', 'no-store');
    res.json(config);
  } catch (err) {
    console.error('ERRO GET identidade-relatorios:', err);
    res.status(500).json({ error: 'Erro ao buscar a identidade dos relatórios.' });
  }
});

// ── PUT — só SuperAdmin ──────────────────────────────────────
router.put('/', somenteSuperAdmin, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { config, erros } = limparConfig(req.body);
    if (erros.length) return res.status(400).json({ error: erros[0], erros });

    const { error } = await db
      .from('config_sistema')
      .upsert({ chave: CHAVE, valor: JSON.stringify(config) }, { onConflict: 'chave' });
    if (error) throw error;

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'configuracoes',
      acao:          'editar_identidade_relatorios',
      descricao:     'Alterou a identidade visual dos relatórios (cabeçalho/rodapé)',
      escopo:        'admin_global',
    });

    res.json({ success: true, config });
  } catch (err) {
    console.error('ERRO PUT identidade-relatorios:', err);
    res.status(500).json({ error: 'Erro ao salvar a identidade dos relatórios.' });
  }
});

// ── POST /logo?campo=marca|sistema — só SuperAdmin ───────────
// Só envia a imagem e devolve o endereço público. Quem grava na
// configuração é o PUT (botão "Salvar" da tela) — assim dá pra trocar a
// logo, ver na prévia e desistir sem ter mexido em nada.
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
    const campo = req.query.campo === 'sistema' ? 'sistema' : 'marca';
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado.' });
    if (!TIPOS_IMAGEM.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Formato não aceito. Use PNG, JPG, WEBP ou GIF.' });
    }

    const nomeArquivo = `relatorios/${campo}-${Date.now()}.${EXTENSAO[req.file.mimetype]}`;
    const { error: uploadErr } = await db.storage
      .from('logos')
      .upload(nomeArquivo, req.file.buffer, { upsert: false, contentType: req.file.mimetype });
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { data: urlData } = db.storage.from('logos').getPublicUrl(nomeArquivo);

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'configuracoes',
      acao:          'editar_identidade_relatorios',
      descricao:     `Enviou uma nova logo (${campo === 'sistema' ? 'do sistema' : 'da marca'}) para os relatórios`,
      escopo:        'admin_global',
    });

    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    console.error('ERRO POST identidade-relatorios/logo:', err);
    res.status(500).json({ error: 'Erro ao enviar a logo.' });
  }
});

module.exports = router;
