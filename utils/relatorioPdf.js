// utils/relatorioPdf.js
// ============================================================
// PDF de relatório no SERVIDOR (01/10/2026) — usado pelos relatórios
// enviados pelo WhatsApp (utils/whatsappRelatorios.js).
//
// É a versão Node do molde do painel (frontend: src/utils/relatorioIdentidade.js,
// função novoPdfRelatorio): mesmo cabeçalho, rodapé e cores, lidos da MESMA
// configuração que o SuperAdmin edita na tela "Identidade dos Relatórios"
// (config_sistema, chave 'relatorio_identidade'). Mudou lá → muda aqui.
// Se mexer no desenho de um, mexer no outro.
//
// Diferenças do painel:
//   • As logos são baixadas aqui (só PNG/JPEG e só do Storage do próprio
//     Supabase — nunca de outro endereço). Logo que não carregar vira o nome.
//   • Data e hora de "Gerado em" no fuso da loja (o servidor roda em UTC).
// ============================================================
const { jsPDF } = require('jspdf');
const { autoTable } = require('jspdf-autotable');
const db = require('../db/supabaseAdmin');

/* ── Valores de fábrica (iguais aos do painel) ──────────────── */
const IDENTIDADE_PADRAO = Object.freeze({
  cabecalho_modo: 'loja_e_marca',
  nome_sistema: 'Gerenciador de Estabelecimentos',
  marca_nome: 'Lucas J. Systems',
  marca_logo_url: '',
  sistema_logo_url: '',
  marca_exibicao: 'logo',
  sistema_exibicao: 'logo',
  escala_cabecalho: 100,
  escala_rodape: 100,
  alinhamento_cabecalho: 'lados',
  alinhamento_rodape: 'lados',
  cor_faixa: '#0f172a',
  cor_texto_faixa: '#e6f7f1',
  cor_destaque: '#0f766e',
  mostrar_logo_loja: true,
  mostrar_cnpj: true,
  mostrar_endereco: true,
  mostrar_telefone: true,
  mostrar_email: false,
  rodape_gerado_por: 'Gerado por {sistema} · {marca}',
  site: '',
  instagram: '',
  whatsapp: '',
  email: '',
  rodape_texto_livre: '',
  mostrar_contatos_rodape: true,
  mostrar_data_geracao: true,
  mostrar_paginacao: true,
});

const EXIBICOES = ['logo', 'nome', 'logo_e_nome'];
const ALINHAMENTOS = ['lados', 'centro'];

function corValida(c, reserva) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : reserva;
}
function hexParaRgb(hex) {
  const h = corValida(hex, '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function escalaValida(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 100;
  return Math.min(160, Math.max(70, n));
}
function oQueMostrar(exibicao, temLogo, temNome) {
  return { logo: temLogo && exibicao !== 'nome', nome: temNome && (exibicao !== 'logo' || !temLogo) };
}
function aplicarMarcadores(texto, id) {
  return String(texto || '')
    .replace(/\{sistema\}/g, id.nome_sistema || '')
    .replace(/\{marca\}/g, id.marca_nome || '')
    .replace(/\s*·\s*$/, '').replace(/^\s*·\s*/, '')
    .trim();
}
function instagramFormatado(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  return s.startsWith('@') ? s : `@${s}`;
}
function linhaContatos(id) {
  if (!id.mostrar_contatos_rodape) return '';
  const partes = [];
  if (id.site) partes.push(String(id.site).replace(/^https?:\/\//i, '').replace(/\/$/, ''));
  if (id.instagram) partes.push(instagramFormatado(id.instagram));
  if (id.whatsapp) partes.push(`WhatsApp ${id.whatsapp}`);
  if (id.email) partes.push(id.email);
  return partes.join('  ·  ');
}
function linhasDadosLoja(loja, id) {
  if (!loja) return [];
  const linha1 = [];
  if (id.mostrar_cnpj && loja.cnpj) linha1.push(`CNPJ ${loja.cnpj}`);
  if (id.mostrar_telefone && loja.telefone) linha1.push(`Tel. ${loja.telefone}`);
  if (id.mostrar_email && loja.email) linha1.push(loja.email);
  const linhas = [];
  if (linha1.length) linhas.push(linha1.join('  ·  '));
  if (id.mostrar_endereco && loja.endereco) linhas.push(loja.endereco);
  return linhas;
}

function resolverIdentidade(tipo, cfg) {
  const c = cfg || {};
  const doTipo = (tipo && c.por_tipo && Object.prototype.hasOwnProperty.call(c.por_tipo, tipo) && c.por_tipo[tipo]) || {};
  const id = { ...IDENTIDADE_PADRAO, ...(c.padrao || {}), ...doTipo };
  id.cor_faixa = corValida(id.cor_faixa, IDENTIDADE_PADRAO.cor_faixa);
  id.cor_texto_faixa = corValida(id.cor_texto_faixa, IDENTIDADE_PADRAO.cor_texto_faixa);
  id.cor_destaque = corValida(id.cor_destaque, IDENTIDADE_PADRAO.cor_destaque);
  if (!['loja', 'loja_e_marca'].includes(id.cabecalho_modo)) id.cabecalho_modo = IDENTIDADE_PADRAO.cabecalho_modo;
  if (!EXIBICOES.includes(id.marca_exibicao)) id.marca_exibicao = IDENTIDADE_PADRAO.marca_exibicao;
  if (!EXIBICOES.includes(id.sistema_exibicao)) id.sistema_exibicao = IDENTIDADE_PADRAO.sistema_exibicao;
  id.escala_cabecalho = escalaValida(id.escala_cabecalho);
  id.escala_rodape = escalaValida(id.escala_rodape);
  if (!ALINHAMENTOS.includes(id.alinhamento_cabecalho)) id.alinhamento_cabecalho = IDENTIDADE_PADRAO.alinhamento_cabecalho;
  if (!ALINHAMENTOS.includes(id.alinhamento_rodape)) id.alinhamento_rodape = IDENTIDADE_PADRAO.alinhamento_rodape;
  return id;
}

/* ── Configuração (cache de 60s) ────────────────────────────── */
const cacheConfig = { valor: null, em: 0 };
async function carregarConfig() {
  if (cacheConfig.valor && Date.now() - cacheConfig.em < 60000) return cacheConfig.valor;
  try {
    const { data } = await db.from('config_sistema').select('valor').eq('chave', 'relatorio_identidade').maybeSingle();
    const v = data?.valor ? (typeof data.valor === 'string' ? JSON.parse(data.valor) : data.valor) : {};
    cacheConfig.valor = {
      padrao: v?.padrao && typeof v.padrao === 'object' ? v.padrao : {},
      por_tipo: v?.por_tipo && typeof v.por_tipo === 'object' ? v.por_tipo : {},
    };
    cacheConfig.em = Date.now();
  } catch (e) {
    console.warn('[PDF] identidade dos relatórios:', e.message);
  }
  return cacheConfig.valor || { padrao: {}, por_tipo: {} };
}

/* ── Logos ──────────────────────────────────────────────────── */
// Só baixa do Storage público do nosso Supabase (nada de endereço qualquer).
function urlLogoPermitida(u) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || typeof u !== 'string' || !/^https:\/\//.test(base)) return false;
  return u.startsWith(`${base}/storage/v1/object/public/`) && !/[\s"'<>\\]|\.\.\//.test(u);
}
function formatoImagem(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'PNG';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'JPEG';
  return null;
}
const MAX_LOGO_BYTES = 3 * 1024 * 1024;
const cacheLogos = new Map(); // url -> { em, logo|null }
async function baixarLogo(url, buscar = fetch) {
  if (!urlLogoPermitida(url)) return null;
  const c = cacheLogos.get(url);
  if (c && Date.now() - c.em < 10 * 60000) return c.logo;
  let logo = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const resp = await buscar(url, { signal: ctrl.signal, redirect: 'error' });
      if (resp.ok && Number(resp.headers?.get?.('content-length') || 0) <= MAX_LOGO_BYTES) {
        const buf = new Uint8Array(await resp.arrayBuffer());
        const fmt = buf.length <= MAX_LOGO_BYTES ? formatoImagem(buf) : null;
        if (fmt) {
          // Lê as dimensões (e confirma que o jsPDF consegue abrir a imagem)
          const props = new jsPDF().getImageProperties(buf);
          if (props?.width > 0 && props?.height > 0) logo = { dados: buf, formato: fmt, w: props.width, h: props.height, alias: url };
        }
      }
    } finally { clearTimeout(t); }
  } catch (e) {
    console.warn('[PDF] logo não carregou:', String(e.message || e).slice(0, 120));
  }
  cacheLogos.set(url, { em: Date.now(), logo });
  if (cacheLogos.size > 200) cacheLogos.delete(cacheLogos.keys().next().value);
  return logo;
}

/* ── Texto (Helvetica do jsPDF: sem emoji) ──────────────────── */
function textoPdf(v) {
  return String(v ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0009\u000A\u000D -~ -ÿ]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function caberImagem(img, maxW, maxH) {
  const r = img.w / img.h;
  let w = maxW, h = maxW / r;
  if (h > maxH) { h = maxH; w = maxH * r; }
  return { w, h };
}
function agoraFormatado(tz) {
  try {
    return new Date().toLocaleString('pt-BR', { timeZone: tz || 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  } catch {
    return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
}

/** Dados da loja pro cabeçalho (mesmos campos do painel). */
async function dadosLoja(mid) {
  const { data } = await db.from('mercearias')
    .select('nome_fantasia, logo_url, cnpj, telefone, email_contato, endereco_completo, timezone')
    .eq('id', mid).maybeSingle();
  if (!data) return null;
  return {
    nome: data.nome_fantasia || '', logo_url: data.logo_url || '', cnpj: data.cnpj || '',
    telefone: data.telefone || '', email: data.email_contato || '', endereco: data.endereco_completo || '',
    timezone: data.timezone || null,
  };
}

/**
 * Cria o PDF com o cabeçalho da identidade na 1ª página.
 *   const rel = await novoPdfRelatorio({ tipo: 'estoque', titulo, subtitulo, loja, tz });
 *   rel.tabela({ head, body, ... });     // autoTable já com margens/cores
 *   rel.secao('Por forma de pagamento'); // título de seção antes de uma tabela
 *   const buffer = rel.finalizar();      // Buffer do PDF (rodapés desenhados)
 */
async function novoPdfRelatorio({ tipo = 'geral', titulo = '', subtitulo = '', loja = null, tz = null, orientacao = 'portrait', buscar } = {}) {
  const cfg = await carregarConfig();
  const id = resolverIdentidade(tipo, cfg);
  const [logoMarca, logoSistema, logoLojaBruta] = await Promise.all([
    id.marca_logo_url ? baixarLogo(id.marca_logo_url, buscar) : null,
    id.cabecalho_modo === 'loja_e_marca' && id.sistema_logo_url ? baixarLogo(id.sistema_logo_url, buscar) : null,
    loja && id.mostrar_logo_loja && loja.logo_url ? baixarLogo(loja.logo_url, buscar) : null,
  ]);

  const doc = new jsPDF({ orientation: orientacao, unit: 'mm', format: 'a4', compress: true });
  doc.setProperties({ title: textoPdf([loja?.nome, titulo].filter(Boolean).join(' - ')), creator: textoPdf(id.nome_sistema || 'Relatório') });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const geradoEm = agoraFormatado(tz || loja?.timezone);
  const corFaixa = hexParaRgb(id.cor_faixa);
  const corTextoFaixa = hexParaRgb(id.cor_texto_faixa);
  const corDestaque = hexParaRgb(id.cor_destaque);
  const sc = id.escala_cabecalho / 100;
  const sr = id.escala_rodape / 100;
  const ALTURA_FAIXA = 13 * sc;

  const linhasRodape = [];
  const geradoPor = aplicarMarcadores(id.rodape_gerado_por, id);
  if (geradoPor) linhasRodape.push({ t: geradoPor, b: true });
  const contatosRodape = linhaContatos(id);
  if (contatosRodape) linhasRodape.push({ t: contatosRodape, b: false });
  if (id.rodape_texto_livre) linhasRodape.push({ t: id.rodape_texto_livre, b: false });
  const PASSO_RODAPE = 3.6 * sr;
  const rodCentro = id.alinhamento_rodape === 'centro';
  const cabCentro = id.alinhamento_cabecalho === 'centro';
  const temMarcaRodape = oQueMostrar(id.marca_exibicao, !!logoMarca, !!id.marca_nome);
  const ALTURA_MARCA_RODAPE = (temMarcaRodape.logo || temMarcaRodape.nome) ? 6.5 * sr : 0;
  const linhasCentro = linhasRodape.length + (id.mostrar_paginacao ? 1 : 0);
  const ALTURA_RODAPE = rodCentro
    ? Math.max(11 * sr, 5 * sr + ALTURA_MARCA_RODAPE + linhasCentro * PASSO_RODAPE)
    : Math.max(11 * sr, 5 * sr + linhasRodape.length * PASSO_RODAPE);

  function desenharMarca({ logo, nome, exibicao, x, yCentro, alturaLogo, larguraMaxLogo, fonte, negrito, direita = false, medir = false }) {
    const quer = oQueMostrar(exibicao, !!logo, !!nome);
    let wLogo = 0, hLogo = 0;
    if (quer.logo) ({ w: wLogo, h: hLogo } = caberImagem(logo, larguraMaxLogo, alturaLogo));
    doc.setFont('helvetica', negrito ? 'bold' : 'normal');
    doc.setFontSize(fonte);
    const txt = quer.nome ? textoPdf(nome) : '';
    const wTxt = txt ? doc.getTextWidth(txt) : 0;
    const espaco = quer.logo && txt ? alturaLogo * 0.4 : 0;
    const total = wLogo + espaco + wTxt;
    if (medir) return total;
    let cx = direita ? x - total : x;
    if (quer.logo) {
      doc.addImage(logo.dados, logo.formato, cx, yCentro - hLogo / 2, wLogo, hLogo, logo.alias, 'FAST');
      cx += wLogo + espaco;
    }
    if (txt) {
      doc.setTextColor(...corTextoFaixa);
      doc.text(txt, cx, yCentro + fonte * 0.3528 * 0.35);
    }
    return total;
  }

  let y = M;
  if (id.cabecalho_modo === 'loja_e_marca') {
    doc.setFillColor(...corFaixa);
    doc.rect(0, 0, W, ALTURA_FAIXA, 'F');
    const argMarca = { logo: logoMarca, nome: id.marca_nome, exibicao: id.marca_exibicao, yCentro: ALTURA_FAIXA / 2, alturaLogo: 8 * sc, larguraMaxLogo: 55 * sc, fonte: 11 * sc, negrito: true };
    const argSistema = { logo: logoSistema, nome: id.nome_sistema, exibicao: id.sistema_exibicao, yCentro: ALTURA_FAIXA / 2, alturaLogo: 8 * sc, larguraMaxLogo: 55 * sc, fonte: 8.5 * sc, negrito: false };
    if (cabCentro) {
      const wM = desenharMarca({ ...argMarca, x: 0, medir: true });
      const wS = desenharMarca({ ...argSistema, x: 0, medir: true });
      const vao = wM > 0 && wS > 0 ? 10 * sc : 0;
      const xc = (W - (wM + vao + wS)) / 2;
      if (wM > 0) desenharMarca({ ...argMarca, x: xc });
      if (vao) {
        doc.setDrawColor(...corTextoFaixa); doc.setLineWidth(0.3);
        doc.line(xc + wM + vao / 2, ALTURA_FAIXA * 0.3, xc + wM + vao / 2, ALTURA_FAIXA * 0.7);
      }
      if (wS > 0) desenharMarca({ ...argSistema, x: xc + wM + vao });
    } else {
      desenharMarca({ ...argMarca, x: M });
      desenharMarca({ ...argSistema, x: W - M, direita: true });
    }
    y = ALTURA_FAIXA + 6 * sc;
  }

  const topo = y;
  const larguraUtil = W - 2 * M;
  let xTexto = M;
  let alturaLogo = 0;
  const logoLoja = logoLojaBruta;
  const nomeEsq = loja ? (loja.nome || '') : (id.nome_sistema || id.marca_nome || '');
  const linhasEsq = loja ? linhasDadosLoja(loja, id) : (id.marca_nome && id.marca_nome !== nomeEsq ? [id.marca_nome] : []);

  let fimBloco;
  if (cabCentro) {
    const cx = W / 2;
    let yc = topo;
    if (logoLoja) {
      const { w, h } = caberImagem(logoLoja, 30 * sc, 18 * sc);
      doc.addImage(logoLoja.dados, logoLoja.formato, cx - w / 2, yc, w, h, logoLoja.alias, 'FAST');
      yc += h + 3 * sc;
    }
    yc += 4 * sc;
    if (nomeEsq) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13 * sc); doc.setTextColor(20, 20, 20);
      const partes = doc.splitTextToSize(textoPdf(nomeEsq), larguraUtil);
      doc.text(partes, cx, yc, { align: 'center' });
      yc += partes.length * 5.4 * sc;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8 * sc); doc.setTextColor(95, 100, 110);
    linhasEsq.forEach(l => {
      const partes = doc.splitTextToSize(textoPdf(l), larguraUtil);
      doc.text(partes, cx, yc, { align: 'center' });
      yc += partes.length * 3.8 * sc;
    });
    if (titulo) {
      yc += 2.5 * sc;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12 * sc); doc.setTextColor(...corDestaque);
      const partes = doc.splitTextToSize(textoPdf(titulo), larguraUtil);
      doc.text(partes, cx, yc, { align: 'center' });
      yc += partes.length * 5 * sc;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5 * sc); doc.setTextColor(95, 100, 110);
    if (subtitulo) {
      const partes = doc.splitTextToSize(textoPdf(subtitulo), larguraUtil);
      doc.text(partes, cx, yc, { align: 'center' });
      yc += partes.length * 4 * sc;
    }
    if (id.mostrar_data_geracao) {
      doc.setFontSize(7.5 * sc);
      doc.text(`Gerado em ${geradoEm}`, cx, yc, { align: 'center' });
      yc += 3.6 * sc;
    }
    fimBloco = yc - 2 * sc;
  } else {
    if (logoLoja) {
      const { w, h } = caberImagem(logoLoja, 26 * sc, 20 * sc);
      doc.addImage(logoLoja.dados, logoLoja.formato, M, topo, w, h, logoLoja.alias, 'FAST');
      xTexto = M + w + 4 * sc;
      alturaLogo = h;
    }
    const larguraEsq = larguraUtil * 0.56 - (xTexto - M);
    let yEsq = topo + 5 * sc;
    if (nomeEsq) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13 * sc); doc.setTextColor(20, 20, 20);
      const partes = doc.splitTextToSize(textoPdf(nomeEsq), larguraEsq);
      doc.text(partes, xTexto, yEsq);
      yEsq += partes.length * 5.4 * sc;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8 * sc); doc.setTextColor(95, 100, 110);
    linhasEsq.forEach(l => {
      const partes = doc.splitTextToSize(textoPdf(l), larguraEsq);
      doc.text(partes, xTexto, yEsq);
      yEsq += partes.length * 3.8 * sc;
    });
    const larguraDir = larguraUtil * 0.42;
    let yDir = topo + 5 * sc;
    if (titulo) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12 * sc); doc.setTextColor(...corDestaque);
      const partes = doc.splitTextToSize(textoPdf(titulo), larguraDir);
      doc.text(partes, W - M, yDir, { align: 'right' });
      yDir += partes.length * 5 * sc;
    }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5 * sc); doc.setTextColor(95, 100, 110);
    if (subtitulo) {
      const partes = doc.splitTextToSize(textoPdf(subtitulo), larguraDir);
      doc.text(partes, W - M, yDir, { align: 'right' });
      yDir += partes.length * 4 * sc;
    }
    if (id.mostrar_data_geracao) {
      doc.setFontSize(7.5 * sc);
      doc.text(`Gerado em ${geradoEm}`, W - M, yDir, { align: 'right' });
      yDir += 3.6 * sc;
    }
    fimBloco = Math.max(topo + alturaLogo, yEsq - 2 * sc, yDir - 2 * sc);
  }
  const yLinha = fimBloco + 3 * sc;
  doc.setDrawColor(...corDestaque);
  doc.setLineWidth(0.6);
  doc.line(M, yLinha, W - M, yLinha);

  const MARGEM_TOPO_OUTRAS = 18;
  const margemTabela = { top: MARGEM_TOPO_OUTRAS, bottom: ALTURA_RODAPE + 5, left: M, right: M };
  let cursor = yLinha + 5;

  function desenharRodapes() {
    const total = doc.getNumberOfPages();
    const tituloCurto = textoPdf([nomeEsq, titulo].filter(Boolean).join(' - '));
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      if (p > 1) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(95, 100, 110);
        if (cabCentro) doc.text(doc.splitTextToSize(tituloCurto, larguraUtil * 0.6)[0] || '', W / 2, 10, { align: 'center' });
        else doc.text(doc.splitTextToSize(tituloCurto, larguraUtil * 0.8)[0] || '', M, 10);
        if (id.mostrar_data_geracao) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
          doc.text(geradoEm, W - M, 10, { align: 'right' });
        }
        doc.setDrawColor(...corDestaque); doc.setLineWidth(0.3);
        doc.line(M, 12.5, W - M, 12.5);
      }
      const yR = H - ALTURA_RODAPE;
      doc.setFillColor(...corFaixa);
      doc.rect(0, yR, W, ALTURA_RODAPE, 'F');

      const ajustar = (l, largura) => {
        doc.setFont('helvetica', l.b ? 'bold' : 'normal');
        let fonte = (l.b ? 7.5 : 6.8) * sr;
        const minimo = fonte * 0.7;
        let txt = textoPdf(l.t);
        doc.setFontSize(fonte);
        while (doc.getTextWidth(txt) > largura && fonte > minimo) { fonte -= 0.25; doc.setFontSize(fonte); }
        if (doc.getTextWidth(txt) > largura) {
          while (txt.length > 1 && doc.getTextWidth(txt + '...') > largura) txt = txt.slice(0, -1);
          txt = txt.trimEnd() + '...';
        }
        return txt;
      };

      if (rodCentro) {
        const larguraCentro = W - 2 * M;
        const altConteudo = ALTURA_MARCA_RODAPE + linhasCentro * PASSO_RODAPE;
        let yc = yR + (ALTURA_RODAPE - altConteudo) / 2;
        if (ALTURA_MARCA_RODAPE) {
          const argM = { logo: logoMarca, nome: id.marca_nome, exibicao: id.marca_exibicao, yCentro: yc + ALTURA_MARCA_RODAPE / 2, alturaLogo: 5 * sr, larguraMaxLogo: 30 * sr, fonte: 7.5 * sr, negrito: true };
          const wM = desenharMarca({ ...argM, x: 0, medir: true });
          desenharMarca({ ...argM, x: (W - wM) / 2 });
          yc += ALTURA_MARCA_RODAPE;
        }
        doc.setTextColor(...corTextoFaixa);
        const textos = linhasRodape.map(l => ({ ...l }));
        if (id.mostrar_paginacao) textos.push({ t: `Página ${p} de ${total}`, b: false });
        textos.forEach((l, i) => {
          const txt = ajustar(l, larguraCentro);
          doc.text(txt, W / 2, yc + (i + 0.75) * PASSO_RODAPE, { align: 'center' });
        });
        continue;
      }

      const larguraMarca = desenharMarca({
        logo: logoMarca, nome: id.marca_nome, exibicao: id.marca_exibicao,
        x: M, yCentro: yR + ALTURA_RODAPE / 2, alturaLogo: 6 * sr, larguraMaxLogo: 30 * sr, fonte: 7.5 * sr, negrito: true,
      });
      const xR = larguraMarca > 0 ? M + larguraMarca + 5 * sr : M;
      const larguraTextoRodape = W - M - xR - 30 * sr;
      doc.setTextColor(...corTextoFaixa);
      const yInicio = yR + (ALTURA_RODAPE - (linhasRodape.length - 1) * PASSO_RODAPE) / 2 + 1 * sr;
      linhasRodape.forEach((l, i) => {
        const txt = ajustar(l, larguraTextoRodape);
        doc.text(txt, xR, yInicio + i * PASSO_RODAPE);
      });
      if (id.mostrar_paginacao) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5 * sr);
        doc.text(`Página ${p} de ${total}`, W - M, yR + ALTURA_RODAPE / 2 + 1.2 * sr, { align: 'right' });
      }
    }
  }

  // Limpa o texto das células (emoji etc.) antes de mandar pra tabela
  const limparLinhas = (linhas) => (linhas || []).map(l => (Array.isArray(l)
    ? l.map(c => (c && typeof c === 'object' && 'content' in c ? { ...c, content: textoPdf(c.content) } : textoPdf(c)))
    : l));

  const alturaUtil = H - margemTabela.bottom;
  return {
    doc,
    identidade: id,
    largura: W,
    margem: M,
    corDestaque,
    get y() { return cursor; },
    /** Título de seção (pula de página se não couber com um pedaço da tabela). */
    secao(texto, { espaco = 4 } = {}) {
      if (cursor + espaco + 18 > alturaUtil) { doc.addPage(); cursor = MARGEM_TOPO_OUTRAS; }
      cursor += espaco;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...corDestaque);
      doc.text(textoPdf(texto), M, cursor);
      cursor += 2.5;
    },
    /** Parágrafo curto (observação). */
    nota(texto) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(95, 100, 110);
      const partes = doc.splitTextToSize(textoPdf(texto), larguraUtil);
      if (cursor + partes.length * 3.6 + 2 > alturaUtil) { doc.addPage(); cursor = MARGEM_TOPO_OUTRAS; }
      cursor += 3;
      doc.text(partes, M, cursor);
      cursor += partes.length * 3.6;
    },
    /** Tabela com as margens e a cor da identidade. */
    tabela(opcoes) {
      autoTable(doc, {
        theme: 'striped',
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.8, textColor: [30, 34, 40], overflow: 'linebreak' },
        alternateRowStyles: { fillColor: [244, 247, 248] },
        showFoot: 'lastPage', // total só no fim (não repete em cada página)
        ...opcoes,
        head: limparLinhas(opcoes.head),
        body: limparLinhas(opcoes.body),
        foot: opcoes.foot ? limparLinhas(opcoes.foot) : undefined,
        headStyles: { fillColor: corDestaque, textColor: 255, fontStyle: 'bold', ...(opcoes.headStyles || {}) },
        footStyles: { fillColor: [226, 232, 236], textColor: [20, 20, 20], fontStyle: 'bold', ...(opcoes.footStyles || {}) },
        startY: cursor + 1.5,
        margin: margemTabela,
      });
      cursor = doc.lastAutoTable.finalY + 2;
    },
    /** Desenha rodapés/cabeçalhos das páginas e devolve o PDF (Buffer). */
    finalizar() {
      desenharRodapes();
      return Buffer.from(doc.output('arraybuffer'));
    },
  };
}

module.exports = { novoPdfRelatorio, dadosLoja, resolverIdentidade, textoPdf, urlLogoPermitida, IDENTIDADE_PADRAO, _limparCache: () => { cacheConfig.valor = null; cacheLogos.clear(); } };
