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

async function graph(metodo, caminho, corpo) {
  if (!token()) throw new ErroMeta('WHATSAPP_TOKEN não configurado no servidor.', { codigo: 'SEM_TOKEN' });
  const resp = await fetch(`${GRAPH}/${caminho}`, {
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

/* ── Envio de texto (dentro da janela de 24h) ───────────────── */
// Registra toda tentativa em whatsapp_envios (inclusive as que falham).
// tipo: 'resposta' | 'teste' | 'alerta' | 'cobranca_mensalidade'
async function enviarTexto({ para, texto, tipo = 'resposta', mercearia_id = null, categoria = null, pedido_tipo = null, creditos = 0 }) {
  const destino = String(para || '').replace(/\D/g, '');
  const p = await parametros();
  const custo = tipo === 'alerta' || tipo === 'cobranca_mensalidade' ? p.meta.preco_utilidade : p.meta.preco_resposta;
  const base = {
    mercearia_id, direcao: 'saida', tipo, categoria, pedido_tipo, destino,
    custo_meta_estimado: custo, creditos,
  };
  try {
    const r = await graph('POST', `${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: 'text',
      text: { body: String(texto).slice(0, 4096), preview_url: false },
    });
    const id = r.messages?.[0]?.id || null;
    await db.from('whatsapp_envios').insert({ ...base, meta_message_id: id, status: 'enviado' });
    return { ok: true, id };
  } catch (e) {
    await db.from('whatsapp_envios').insert({
      ...base, custo_meta_estimado: 0, status: 'falhou',
      erro_codigo: Number.isInteger(e.codigo) ? e.codigo : null,
      erro_mensagem: String(e.message || 'erro').slice(0, 300),
    }).then(() => {}, () => {});
    return { ok: false, erro: e.message, codigo: e.codigo, subcodigo: e.subcodigo, detalhe: e.detalhe };
  }
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
  PHONE_NUMBER_ID, WABA_ID, configuracao, graph, ErroMeta,
  variantesTelefone, enviarTexto, statusNumero, appsAssinados, assinarWebhook,
  assinaturaValida, verifyTokenConfere, explicarErro,
};
