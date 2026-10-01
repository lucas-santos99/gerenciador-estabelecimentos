// utils/whatsappMeta.js
//
// Ligação com a WhatsApp Cloud API (Meta) — 30/09/2026.
// Tudo que fala com a Meta passa por aqui: enviar mensagem, ler o status
// do número, assinar o webhook e conferir a assinatura dos avisos.
//
// Segredos só em variáveis de ambiente do Railway (nunca no código, no
// banco ou no chat):
//   WHATSAPP_TOKEN          token permanente do usuário do sistema
//   WHATSAPP_APP_SECRET     chave secreta do app (confere a assinatura
//                           X-Hub-Signature-256 de cada aviso do webhook)
//   WHATSAPP_VERIFY_TOKEN   frase escolhida por nós, usada só no cadastro
//                           da URL do webhook no painel da Meta
// Não são segredo (têm padrão, mas podem ser trocados por variável):
//   WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID, WHATSAPP_GRAPH_VERSION

const crypto = require('crypto');
const db = require('../db/supabaseAdmin');
const W = require('./whatsappCustos');
const { TIMEZONE_PADRAO, inicioDiaTZ } = require('./fusoHorario');

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '1311181085415438';
const WABA_ID         = process.env.WHATSAPP_WABA_ID || '1421993583238754';
const GRAPH_VERSION   = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
const GRAPH           = `https://graph.facebook.com/${GRAPH_VERSION}`;

const token      = () => process.env.WHATSAPP_TOKEN || '';
const appSecret  = () => process.env.WHATSAPP_APP_SECRET || '';
const verifyTok  = () => process.env.WHATSAPP_VERIFY_TOKEN || '';

// O que está configurado (sem nunca devolver o valor dos segredos)
function configuracao() {
  return {
    token: !!token(),
    app_secret: !!appSecret(),
    verify_token: !!verifyTok(),
    phone_number_id: PHONE_NUMBER_ID,
    waba_id: WABA_ID,
    graph_version: GRAPH_VERSION,
  };
}

class ErroMeta extends Error {
  constructor(msg, { status = 0, codigo = null, subcodigo = null, detalhe = null } = {}) {
    super(msg);
    this.status = status; this.codigo = codigo; this.subcodigo = subcodigo; this.detalhe = detalhe;
  }
}

// Falha de rede ("fetch failed": conexão caiu/reiniciou entre o Railway e a
// Meta). Leitura (GET) tenta de novo uma vez; envio (POST) não, pra nunca
// mandar a mesma mensagem duas vezes.
async function chamarFetch(metodo, url, opcoes) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await fetch(url, opcoes);
    } catch (e) {
      const causa = e?.cause?.code || e?.cause?.message || e?.message || 'erro';
      console.warn(`[WHATSAPP] falha de rede com a Meta (${metodo}, tentativa ${tentativa}): ${causa}`);
      if (metodo === 'GET' && tentativa < 2) { await new Promise(r => setTimeout(r, 400)); continue; }
      throw new ErroMeta('Não foi possível falar com a Meta agora (falha de rede). Tente de novo em instantes.', { codigo: 'REDE', detalhe: String(causa).slice(0, 120) });
    }
  }
}

async function graph(metodo, caminho, corpo) {
  if (!token()) throw new ErroMeta('WHATSAPP_TOKEN não configurado no servidor.', { codigo: 'SEM_TOKEN' });
  const resp = await chamarFetch(metodo, `${GRAPH}/${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    const e = json.error || {};
    throw new ErroMeta(e.error_user_msg || e.message || `Meta respondeu HTTP ${resp.status}`, {
      status: resp.status, codigo: e.code ?? null, subcodigo: e.error_subcode ?? null,
      detalhe: e.error_data?.details || null,
    });
  }
  return json;
}

/* ── Telefones do Brasil: com e sem o 9 ─────────────────────── */
// A Meta às vezes identifica o número brasileiro SEM o nono dígito
// (5553 9910 1143 → 555399101143). Pra achar o vínculo, testamos os dois.
function variantesTelefone(t) {
  const s = String(t || '').replace(/\D/g, '');
  const v = new Set([s]);
  let m = /^55(\d{2})9(\d{8})$/.exec(s);
  if (m) v.add(`55${m[1]}${m[2]}`);
  m = /^55(\d{2})(\d{8})$/.exec(s);
  if (m && /^[6-9]/.test(m[2])) v.add(`55${m[1]}9${m[2]}`);
  return [...v];
}

/* ── Parâmetros (preço estimado por mensagem) ───────────────── */
async function parametros() {
  try {
    const { data } = await db.from('config_sistema').select('valor').eq('chave', 'whatsapp_params').maybeSingle();
    return W.normalizarParametros(data?.valor ? JSON.parse(data.valor) : null);
  } catch {
    return W.normalizarParametros(null);
  }
}

/* ── Envio (dentro da janela de 24h) ────────────────────────── */
// Registra toda tentativa em whatsapp_envios (inclusive as que falham).
// tipo: 'resposta' | 'teste' | 'alerta' | 'cobranca_mensalidade'
// pedido_id/pedido_tipo ligam as mensagens de um mesmo pedido (consulta…);
// `creditos` é o que aquele envio debitou (só o envio final do pedido).
async function enviar(conteudo, { para, tipo = 'resposta', mercearia_id = null, categoria = null, pedido_id = null, pedido_tipo = null, creditos = 0 }) {
  const destino = String(para || '').replace(/\D/g, '');
  const p = await parametros();
  const custo = tipo === 'alerta' || tipo === 'cobranca_mensalidade' ? p.meta.preco_utilidade : p.meta.preco_resposta;
  const base = {
    mercearia_id, direcao: 'saida', tipo, categoria, pedido_id, pedido_tipo, destino,
    custo_meta_estimado: custo, creditos,
  };
  try {
    // `conteudo` pode ser uma função (ex.: documento: sobe o arquivo antes);
    // se ela falhar, o envio fica registrado como "falhou", igual aos outros.
    const corpo = typeof conteudo === 'function' ? await conteudo() : conteudo;
    const r = await graph('POST', `${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      ...corpo,
    });
    const id = r.messages?.[0]?.id || null;
    const { data: reg } = await db.from('whatsapp_envios').insert({ ...base, meta_message_id: id, status: 'enviado' }).select('id').maybeSingle();
    return { ok: true, id, envio_id: reg?.id || null };
  } catch (e) {
    await db.from('whatsapp_envios').insert({
      ...base, custo_meta_estimado: 0, creditos: 0, status: 'falhou',
      erro_codigo: Number.isInteger(e.codigo) ? e.codigo : null,
      erro_mensagem: String(e.message || 'erro').slice(0, 300),
    }).then(() => {}, () => {});
    return { ok: false, erro: e.message, codigo: e.codigo, subcodigo: e.subcodigo, detalhe: e.detalhe };
  }
}

async function enviarTexto({ texto, ...opcoes }) {
  return enviar({ type: 'text', text: { body: String(texto).slice(0, 4096), preview_url: false } }, opcoes);
}

// Mensagem interativa (lista ou botões). `interativo` segue o formato da
// Cloud API ({ type: 'list' | 'button', body, action, ... }). Os limites
// de tamanho da Meta são aplicados aqui pra nunca dar erro 100.
const corta = (t, n) => { const s = String(t || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function limparInterativo(i) {
  const o = { type: i.type, body: { text: corta(i.body?.text, 1024) } };
  if (i.header?.text) o.header = { type: 'text', text: corta(i.header.text, 60) };
  if (i.footer?.text) o.footer = { text: corta(i.footer.text, 60) };
  if (i.type === 'list') {
    let total = 0;
    o.action = {
      button: corta(i.action.button, 20),
      sections: (i.action.sections || []).slice(0, 10).map(sec => {
        const rows = (sec.rows || []).slice(0, Math.max(0, 10 - total)).map(r => ({
          id: String(r.id).slice(0, 200), title: corta(r.title, 24),
          ...(r.description ? { description: corta(r.description, 72) } : {}),
        }));
        total += rows.length;
        return { ...(sec.title ? { title: corta(sec.title, 24) } : {}), rows };
      }).filter(sec => sec.rows.length),
    };
  } else {
    o.action = {
      buttons: (i.action.buttons || []).slice(0, 3).map(b => ({
        type: 'reply', reply: { id: String(b.id).slice(0, 256), title: corta(b.title, 20) },
      })),
    };
  }
  return o;
}
async function enviarInterativo({ interativo, ...opcoes }) {
  return enviar({ type: 'interactive', interactive: limparInterativo(interativo) }, opcoes);
}

/* ── Documento (PDF) — 01/10/2026 ───────────────────────────── */
// Sobe o arquivo pra Meta (POST /{phone-id}/media, multipart) e devolve o
// id da mídia. A Meta guarda o arquivo por 30 dias; subir não é cobrado.
async function subirMidia(buffer, { nome = 'arquivo.pdf', mime = 'application/pdf' } = {}) {
  if (!token()) throw new ErroMeta('WHATSAPP_TOKEN não configurado no servidor.', { codigo: 'SEM_TOKEN' });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), nome);
  const resp = await chamarFetch('POST', `${GRAPH}/${PHONE_NUMBER_ID}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: form,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error || !json.id) {
    const e = json.error || {};
    throw new ErroMeta(e.error_user_msg || e.message || `Meta respondeu HTTP ${resp.status} ao subir o arquivo`, {
      status: resp.status, codigo: e.code ?? null, subcodigo: e.error_subcode ?? null, detalhe: e.error_data?.details || null,
    });
  }
  return json.id;
}

// Envia um PDF como documento. `legenda` aparece embaixo do arquivo (até 1024).
async function enviarDocumento({ pdf, nomeArquivo, legenda = '', ...opcoes }) {
  const nome = String(nomeArquivo || 'relatorio.pdf').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
  return enviar(async () => {
    const id = await subirMidia(pdf, { nome, mime: 'application/pdf' });
    return { type: 'document', document: { id, filename: nome, ...(legenda ? { caption: corta(legenda, 1024) } : {}) } };
  }, opcoes);
}

/* ── Franquia grátis da Meta (01/10/2026) ───────────────────── */
// Desde 01/10/2026 a Meta cobra cada mensagem livre (resposta dentro da
// janela de 24h), mas cada NÚMERO tem 1.000 grátis por mês. É assunto só do
// SuperAdmin: o comerciante paga a mensalidade fixa do plano (créditos) e
// nunca vê essa franquia. Contamos aqui o que já saiu no mês (respostas +
// testes, sem as que falharam) e projetamos o mês no ritmo atual.
// Mês no fuso de Brasília (aproximação do ciclo de cobrança da Meta).
async function franquiaDoMes(mesStr = null) {
  const p = await parametros();
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE_PADRAO }).format(new Date());
  const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mesStr || '')) ? mesStr : hoje.slice(0, 7);
  const [a, m] = mes.split('-').map(Number);
  const proximo = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
  const { count, error } = await db.from('whatsapp_envios').select('id', { count: 'exact', head: true })
    .eq('direcao', 'saida').in('tipo', ['resposta', 'teste']).neq('status', 'falhou')
    .gte('criado_em', inicioDiaTZ(`${mes}-01`, TIMEZONE_PADRAO).toISOString())
    .lt('criado_em', inicioDiaTZ(`${proximo}-01`, TIMEZONE_PADRAO).toISOString());
  if (error) throw new Error(error.message);
  const usadas = count || 0;
  const gratis = p.meta.respostas_gratis_mes;
  const preco = p.meta.preco_resposta;
  const diasMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const mesAtual = mes === hoje.slice(0, 7);
  const dia = mesAtual ? Number(hoje.slice(8, 10)) : diasMes;
  const projecao = mesAtual && dia > 0 ? Math.round((usadas / dia) * diasMes) : usadas;
  // Dia em que, no ritmo atual, a franquia acaba (se acabar dentro do mês)
  const ritmo = dia > 0 ? usadas / dia : 0;
  const diaFim = mesAtual && ritmo > 0 && usadas < gratis && projecao > gratis ? Math.min(diasMes, Math.ceil(gratis / ritmo)) : null;
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    mes, mes_atual: mesAtual, usadas, gratis, restantes: Math.max(0, gratis - usadas),
    pct: gratis > 0 ? Math.round((usadas / gratis) * 100) : null,
    preco_resposta: preco,
    excedentes: Math.max(0, usadas - gratis), custo_excedente: r2(Math.max(0, usadas - gratis) * preco),
    projecao, custo_projetado: r2(Math.max(0, projecao - gratis) * preco), dia_fim_franquia: diaFim,
  };
}

/* ── Status do número e do webhook ──────────────────────────── */
async function statusNumero() {
  return graph('GET', `${PHONE_NUMBER_ID}?fields=verified_name,display_phone_number,quality_rating,name_status,code_verification_status,platform_type,throughput,status,messaging_limit_tier`);
}
async function appsAssinados() {
  const r = await graph('GET', `${WABA_ID}/subscribed_apps`);
  return r.data || [];
}
async function assinarWebhook() {
  return graph('POST', `${WABA_ID}/subscribed_apps`);
}

/* ── Assinatura dos avisos do webhook ───────────────────────── */
function assinaturaValida(rawBody, cabecalho) {
  const segredo = appSecret();
  if (!segredo || !rawBody || typeof cabecalho !== 'string' || !cabecalho.startsWith('sha256=')) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', segredo).update(rawBody).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(cabecalho);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTokenConfere(recebido) {
  const esperado = verifyTok();
  if (!esperado || typeof recebido !== 'string') return false;
  const a = Buffer.from(esperado), b = Buffer.from(recebido);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mensagem de erro da Meta em português, para a tela do SuperAdmin
function explicarErro(codigo) {
  const m = {
    131047: 'Fora da janela de 24h: a pessoa precisa mandar uma mensagem para o número do sistema antes (ou usar um modelo aprovado).',
    131026: 'O número de destino não tem WhatsApp ou não pode receber mensagens.',
    131042: 'Problema de pagamento na conta da Meta (forma de pagamento).',
    131056: 'Muitas mensagens para o mesmo número em pouco tempo. Tente de novo daqui a pouco.',
    130497: 'A conta não pode enviar para esse país.',
    190: 'Token inválido ou expirado — gere um novo token permanente e troque no Railway.',
    100: 'Parâmetro inválido (confira o número e o ID do telefone).',
    10: 'O token não tem permissão para esse número/conta.',
    200: 'O token não tem permissão para esse número/conta.',
  };
  return m[codigo] || null;
}

module.exports = {
  PHONE_NUMBER_ID, WABA_ID, configuracao, graph, ErroMeta, parametros,
  variantesTelefone, enviarTexto, enviarInterativo, enviarDocumento, subirMidia, limparInterativo, statusNumero, appsAssinados, assinarWebhook,
  assinaturaValida, verifyTokenConfere, explicarErro, franquiaDoMes,
};
