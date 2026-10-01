// routes/whatsappWebhookRoutes.js
// ============================================================
// Webhook da WhatsApp Cloud API (Meta) — 30/09/2026
// Montado em /api/whatsapp/webhook, SEM login (quem chama é a Meta).
//
//   GET  → verificação do cadastro da URL no painel da Meta
//          (hub.mode=subscribe + hub.verify_token + hub.challenge)
//   POST → avisos: mensagens recebidas e status das enviadas
//          (enviado → entregue → lido / falhou)
//
// Segurança: todo POST precisa da assinatura X-Hub-Signature-256
// (HMAC-SHA256 do corpo com a chave secreta do app). Sem WHATSAPP_APP_SECRET
// configurado, nada é aceito.
//
// O que o robô faz:
//   1. confirma o número da loja quando chega o código de 6 dígitos
//      (whatsapp_vinculos — o código foi gerado na tela WhatsApp da loja);
//   2. número já confirmado → assistente de consultas por menu
//      (utils/whatsappAssistente.js, 30/09/2026). Enquanto o WhatsApp não
//      está liberado para as lojas (integracao.ativo), responde só um aviso
//      curto — no máximo 1 vez a cada 12h por número;
//   3. responde quem não é cadastrado explicando como usar — no máximo
//      1 vez a cada 7 dias por número.
// Resposta de consulta que a Meta avisa como "falhou" devolve o crédito.
// Tudo fica registrado em whatsapp_envios (custo estimado incluído).
// Reenvio do mesmo aviso pela Meta é ignorado (meta_message_id é único).
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../db/supabaseAdmin');
const { registrar } = require('./auditoriaRoutes');
const A = require('../utils/whatsappAssinaturas');
const M = require('../utils/whatsappMeta');
const Assistente = require('../utils/whatsappAssistente');

const MAX_TENTATIVAS = 5;
const RANK = { enviado: 1, entregue: 2, lido: 3, falhou: 4 };
const STATUS_META = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou' };

/* ── GET: verificação da URL ───────────────────────────────── */
router.get('/', (req, res) => {
  const modo = req.query['hub.mode'];
  const tok = req.query['hub.verify_token'];
  const desafio = req.query['hub.challenge'];
  if (modo === 'subscribe' && M.verifyTokenConfere(tok)) {
    return res.status(200).type('text/plain').send(String(desafio || ''));
  }
  return res.sendStatus(403);
});

/* ── POST: avisos ──────────────────────────────────────────── */
router.post('/', async (req, res) => {
  if (!M.assinaturaValida(req.rawBody, req.headers['x-hub-signature-256'])) {
    console.warn('⚠️ [WHATSAPP] webhook com assinatura inválida (ou WHATSAPP_APP_SECRET não configurado).');
    return res.sendStatus(401);
  }
  try {
    const corpo = req.body || {};
    if (corpo.object !== 'whatsapp_business_account') return res.sendStatus(200);

    for (const entrada of corpo.entry || []) {
      for (const mudanca of entrada.changes || []) {
        if (mudanca.field !== 'messages') continue;
        const v = mudanca.value || {};
        if (v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(M.PHONE_NUMBER_ID)) continue;

        for (const st of v.statuses || []) await tratarStatus(st);
        for (const msg of v.messages || []) {
          const contato = (v.contacts || []).find(c => c.wa_id === msg.from) || null;
          await tratarMensagem(msg, contato);
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    // 500 → a Meta reenvia depois. É seguro: mensagem repetida é ignorada.
    console.error('[WHATSAPP] webhook:', err.message);
    res.sendStatus(500);
  }
});

/* ── Status das mensagens que enviamos ─────────────────────── */
async function tratarStatus(st) {
  const novo = STATUS_META[st.status];
  if (!novo || !st.id) return;
  const { data: atual } = await db.from('whatsapp_envios').select('id, status, pedido_id, creditos').eq('meta_message_id', st.id).maybeSingle();
  if (!atual) return;
  // Avisos podem chegar fora de ordem (ex.: "entregue" depois de "lido")
  if ((RANK[novo] || 0) <= (RANK[atual.status] || 0) && novo !== 'falhou') return;
  const erro = (st.errors || [])[0];
  await db.from('whatsapp_envios').update({
    status: novo,
    erro_codigo: erro?.code ?? null,
    erro_mensagem: erro ? String(erro.title || erro.message || '').slice(0, 300) : null,
    atualizado_em: new Date().toISOString(),
  }).eq('id', atual.id);
  // Resposta paga que não chegou → devolve o crédito do pedido
  if (novo === 'falhou' && atual.pedido_id && Number(atual.creditos) > 0) {
    await Assistente.estornarPedido(atual.pedido_id, 'Resposta não entregue pelo WhatsApp — crédito devolvido');
  }
}

/* ── Mensagens recebidas ───────────────────────────────────── */
async function tratarMensagem(msg, contato) {
  const de = String(msg.from || '').replace(/\D/g, '');
  if (!de || !msg.id) return;
  const variantes = M.variantesTelefone(de);

  // Vínculos deste número (pode estar em mais de uma loja)
  const { data: vincs } = await db.from('whatsapp_vinculos')
    .select('id, mercearia_id, telefone, apelido, status, codigo_hash, codigo_expira_em, tentativas')
    .in('telefone', variantes).neq('status', 'removido');
  const ativos = (vincs || []).filter(x => x.status === 'ativo');
  const pendentes = (vincs || []).filter(x => x.status === 'pendente');
  const lojaUnica = ativos.length === 1 ? ativos[0].mercearia_id
    : (!ativos.length && pendentes.length === 1 ? pendentes[0].mercearia_id : null);

  // Registra a recebida. Repetida (mesmo id da Meta) → já tratada, sai.
  const { error: errIns } = await db.from('whatsapp_envios').insert({
    mercearia_id: lojaUnica, direcao: 'entrada', tipo: 'recebida', status: 'recebido',
    destino: de, meta_message_id: msg.id, custo_meta_estimado: 0,
  });
  if (errIns) {
    if (errIns.code === '23505') return;
    throw new Error(`whatsapp_envios: ${errIns.message}`);
  }

  const texto = msg.type === 'text' ? String(msg.text?.body || '') : '';
  const codigo = /^\s*(\d{3})[\s.-]?(\d{3})\s*$/.exec(texto);

  // 1) Código de confirmação do número
  if (codigo && pendentes.length) {
    await confirmarCodigo(`${codigo[1]}${codigo[2]}`, pendentes, de);
    return;
  }

  // 2) Número já confirmado → assistente de consultas (se liberado)
  if (ativos.length) {
    const params = await M.parametros();
    if (params.integracao.ativo) {
      try {
        await Assistente.atender({ msg, de, variantes, ativos, contato });
      } catch (e) {
        // A mensagem já foi registrada: um reenvio da Meta seria ignorado,
        // então avisa aqui mesmo (sem gastar crédito).
        console.error('[WHATSAPP] assistente:', e.message);
        if (!(await respondeuRecente(variantes, 0.02, 'erro'))) {
          await M.enviarTexto({ para: de, tipo: 'resposta', mercearia_id: lojaUnica, categoria: 'erro',
            texto: 'Tive um problema para responder agora. Tente de novo em instantes. Nenhum crédito foi usado.' });
        }
      }
      return;
    }
    if (await respondeuRecente(variantes, 12, 'aviso_assistente')) return;
    const nomes = await nomesLojas(ativos.map(a => a.mercearia_id));
    const oi = ativos[0].apelido || contato?.profile?.name || '';
    const lojas = ativos.map(a => nomes[a.mercearia_id]).filter(Boolean).join(', ');
    const suporte = await linkSuporte();
    await M.enviarTexto({
      para: de, tipo: 'resposta', mercearia_id: lojaUnica, categoria: 'aviso_assistente',
      texto: `Olá${oi ? `, ${oi}` : ''}! 👋 Aqui é o assistente automático do sistema${lojas ? ` (${lojas})` : ''}.\n\n` +
        'As consultas pelo WhatsApp estão quase prontas: em breve você vai poder perguntar coisas como "quanto vendi hoje?" ou pedir relatórios.\n\n' +
        (suporte ? `Precisa falar com uma pessoa? Chame o suporte: ${suporte}` : 'Precisa falar com uma pessoa? Use o "Fale Conosco" no sistema.'),
    });
    return;
  }

  // 2b) Tem código pendente mas mandou outra coisa → lembra do código
  if (pendentes.length) {
    if (await respondeuRecente(variantes, 12, 'lembrete_codigo')) return;
    await M.enviarTexto({
      para: de, tipo: 'resposta', mercearia_id: lojaUnica, categoria: 'lembrete_codigo',
      texto: 'Para confirmar este número, envie aqui só o código de 6 dígitos que aparece na tela WhatsApp do sistema.',
    });
    return;
  }

  // 3) Número desconhecido → explica como usar (1× a cada 7 dias)
  if (await respondeuRecente(variantes, 24 * 7, 'boas_vindas')) return;
  const suporte = await linkSuporte();
  await M.enviarTexto({
    para: de, tipo: 'resposta', mercearia_id: null, categoria: 'boas_vindas',
    texto: 'Olá! 👋 Este é o WhatsApp automático do Gerenciador de Estabelecimentos.\n\n' +
      'Para usar, o dono da loja cadastra este número na tela *WhatsApp* do sistema e envia para cá o código de 6 dígitos que aparece lá.' +
      (suporte ? `\n\nDúvidas? Fale com o suporte: ${suporte}` : ''),
  });
}

async function confirmarCodigo(codigo, pendentes, de) {
  const agora = Date.now();
  const valido = pendentes.find(v =>
    v.codigo_hash && v.codigo_hash === A.hashCodigo(codigo, v.telefone) &&
    (!v.codigo_expira_em || new Date(v.codigo_expira_em).getTime() > agora) &&
    (v.tentativas || 0) < MAX_TENTATIVAS);

  if (valido) {
    const { data } = await db.from('whatsapp_vinculos').update({
      status: 'ativo', verificado_em: new Date().toISOString(), codigo_hash: null, codigo_expira_em: null, tentativas: 0,
    }).eq('id', valido.id).eq('status', 'pendente').select();
    if (!data || !data.length) return;
    const nomes = await nomesLojas([valido.mercearia_id]);
    const loja = nomes[valido.mercearia_id] || 'sua loja';
    registrar({
      mercearia_id: valido.mercearia_id, usuario_nome: 'Sistema (WhatsApp)', usuario_email: 'Sistema (WhatsApp)',
      modulo: 'whatsapp', acao: 'whatsapp_numero_confirmado',
      descricao: `Número ${A.formatarTelefone ? A.formatarTelefone(valido.telefone) : valido.telefone} (${valido.apelido}) confirmado pelo WhatsApp`,
      meta: { vinculo_id: valido.id },
    });
    await M.enviarTexto({
      para: de, tipo: 'resposta', mercearia_id: valido.mercearia_id, categoria: 'vinculo',
      texto: `✅ Pronto, ${valido.apelido}! Este número foi confirmado para usar o WhatsApp de ${loja}.\n\n` +
        'Para consultar, pergunte direto o que você quer, por exemplo: *vendas hoje*, *estoque coca* ou *fiado* — a resposta já vem na hora. ' +
        'Para ver todas as opções, escreva *menu*.',
    });
    return;
  }

  // Código errado / expirado / tentativas esgotadas
  const expirou = pendentes.every(v => v.codigo_expira_em && new Date(v.codigo_expira_em).getTime() <= agora);
  const esgotou = pendentes.every(v => (v.tentativas || 0) >= MAX_TENTATIVAS);
  for (const v of pendentes) {
    if ((v.tentativas || 0) < MAX_TENTATIVAS) {
      await db.from('whatsapp_vinculos').update({ tentativas: (v.tentativas || 0) + 1 }).eq('id', v.id).eq('status', 'pendente');
    }
  }
  if (await respondeuRecente(M.variantesTelefone(de), 0.02, 'vinculo')) return; // evita resposta em rajada (~1 min)
  await M.enviarTexto({
    para: de, tipo: 'resposta', mercearia_id: pendentes.length === 1 ? pendentes[0].mercearia_id : null, categoria: 'vinculo',
    texto: esgotou
      ? 'Muitas tentativas com código errado. Gere um novo código na tela WhatsApp do sistema e envie aqui.'
      : expirou
        ? 'Esse código expirou. Gere um novo na tela WhatsApp do sistema e envie aqui.'
        : 'Código não confere. Confira o código de 6 dígitos na tela WhatsApp do sistema e envie de novo.',
  });
}

/* ── Auxiliares ─────────────────────────────────────────────── */
// Já mandamos esse tipo de resposta automática (categoria) pra esse número
// nas últimas `horas`? Evita repetir aviso (e pagar por isso).
async function respondeuRecente(variantes, horas, categoria) {
  const desde = new Date(Date.now() - horas * 3600000).toISOString();
  const { data } = await db.from('whatsapp_envios').select('id')
    .in('destino', variantes).eq('direcao', 'saida').eq('categoria', categoria).gte('criado_em', desde).limit(1);
  return !!(data && data.length);
}

async function nomesLojas(ids) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return {};
  const { data } = await db.from('mercearias').select('id, nome_fantasia').in('id', u);
  return Object.fromEntries((data || []).map(m => [m.id, m.nome_fantasia]));
}

async function linkSuporte() {
  try {
    const { data } = await db.from('config_sistema').select('valor').eq('chave', 'whatsapp_suporte').maybeSingle();
    const n = String(data?.valor || '').replace(/\D/g, '');
    return n.length >= 12 && n !== '5500000000000' ? `https://wa.me/${n}` : null;
  } catch { return null; }
}

module.exports = router;
