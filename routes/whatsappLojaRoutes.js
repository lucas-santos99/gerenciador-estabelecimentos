// routes/whatsappLojaRoutes.js
// ============================================================
// WhatsApp — lado da loja (29/09/2026). Montado em /api/whatsapp/loja.
// Só o DONO do estabelecimento (role merchant) usa: ver os planos,
// contratar (com aceite dos termos), acompanhar saldo/extrato, pedir
// pacote extra, cancelar e cadastrar os números que podem usar o saldo.
//
// Nesta fase a contratação fica "aguardando ativação" até o SuperAdmin
// master ativar (cobrança combinada à parte). Regras de ciclo/saldo em
// utils/whatsappAssinaturas.js.
//
//   GET    /                        → tudo que a tela precisa
//   POST   /assinar                 → solicita um plano (ou troca)
//   POST   /aceitar-termos          → aceita a versão nova dos termos (plano ativo)
//   POST   /desistir                → desiste da solicitação pendente
//   POST   /cancelar                → cancela ao fim do ciclo
//   POST   /manter                  → desfaz o cancelamento
//   GET    /extrato                 → movimentos do ciclo atual
//   POST   /pacotes                 → pede um pacote extra
//   POST   /pacotes/:id/desistir    → desiste do pacote pendente
//   POST   /numeros-extras          → pede +N números além do plano (01/10)
//   POST   /numeros-extras/desistir → desiste do pedido de extras
//   POST   /numeros-extras/remover  → tira 1 número extra (na hora)
//   POST   /vinculos                → cadastra número (gera código)
//   PATCH  /vinculos/:id            → troca a pessoa ligada ao número
//   POST   /vinculos/:id/codigo     → gera um código novo
//   DELETE /vinculos/:id            → remove o número
// ============================================================
const express = require('express');
const router = express.Router();
const db = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
const { hojeStrTZ } = require('../utils/fusoHorario');
const W = require('../utils/whatsappCustos');
const A = require('../utils/whatsappAssinaturas');

function somenteDono(req, res, next) {
  if (req.user?.role === 'merchant' && req.user.mercearia_id) return next();
  return res.status(403).json({ error: 'Só o dono do estabelecimento gerencia o WhatsApp.' });
}
router.use(authUser, somenteDono);

const UUID = /^[0-9a-f-]{36}$/i;
const CAMPOS_PLANO_PUBLICO = 'id, tipo, nome, descricao, preco, creditos, numeros, recursos, destaque, ordem';

function auditar(req, acao, descricao, meta = {}) {
  registrar({
    mercearia_id: req.user.mercearia_id, operador_id: null,
    usuario_nome: req.user.nome, usuario_email: req.user.email,
    modulo: 'whatsapp', acao, descricao, meta, escopo: 'estabelecimento',
  });
}

async function parametros() {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', 'whatsapp_params').maybeSingle();
  let salvo = null;
  try { salvo = data?.valor ? JSON.parse(data.valor) : null; } catch { salvo = null; }
  return W.normalizarParametros(salvo);
}

async function assinaturasAbertas(mid) {
  const { data, error } = await db.from('whatsapp_assinaturas').select('*')
    .eq('mercearia_id', mid).in('status', ['aguardando', 'ativa']);
  if (error) throw error;
  return {
    ativa: (data || []).find(a => a.status === 'ativa') || null,
    pendente: (data || []).find(a => a.status === 'aguardando') || null,
  };
}

// Assinatura ativa já com o ciclo em dia
async function ativaEmDia(mid) {
  const { ativa, pendente } = await assinaturasAbertas(mid);
  if (!ativa) return { ativa: null, pendente };
  const tz = await A.timezoneDaLoja(db, mid);
  const a = await A.garantirCiclo(db, ativa, hojeStrTZ(tz));
  return { ativa: a && a.status === 'ativa' ? a : null, pendente, tz };
}

// Pessoas da loja que podem ter um número (30/09/2026): o dono e os
// operadores ativos. Cada número responde com as permissões da pessoa.
async function pessoasDaLoja(mid) {
  const [{ data: perfis }, { data: ops }] = await Promise.all([
    db.from('profiles').select('id, nome, role, is_active').eq('mercearia_id', mid).in('role', ['merchant', 'operator']),
    db.from('operadores').select('id, status').eq('mercearia_id', mid),
  ]);
  const statusOp = Object.fromEntries((ops || []).map(o => [o.id, o.status]));
  return (perfis || [])
    .filter(p => p.is_active !== false && (p.role === 'merchant' || statusOp[p.id] === 'ativo'))
    .map(p => ({ id: p.id, nome: p.nome || (p.role === 'merchant' ? 'Dono' : 'Operador'), papel: p.role === 'merchant' ? 'Administrador' : 'Operador', dono: p.role === 'merchant' }))
    .sort((a, b) => (b.dono - a.dono) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

function vinculoPublico(v, pessoas = []) {
  // Vínculo antigo sem pessoa = dono
  const pessoa = v.usuario_id ? pessoas.find(p => p.id === v.usuario_id) : pessoas.find(p => p.dono);
  return {
    id: v.id, apelido: v.apelido, telefone: v.telefone, telefone_formatado: A.formatarTelefone(v.telefone),
    usuario_id: pessoa ? pessoa.id : (v.usuario_id || null),
    pessoa_nome: pessoa ? pessoa.nome : null, pessoa_papel: pessoa ? pessoa.papel : null,
    pessoa_invalida: !pessoa,
    status: v.status, codigo_expira_em: v.codigo_expira_em, verificado_em: v.verificado_em, criado_em: v.criado_em,
    codigo_expirado: v.status === 'pendente' && (!v.codigo_expira_em || new Date(v.codigo_expira_em) < new Date()),
  };
}

/* ── GET / ─────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  const mid = req.user.mercearia_id;
  try {
    const p = await parametros();
    // Primeiro põe o ciclo em dia (pode encerrar um plano cancelado),
    // depois lê o resto já com o estado atualizado.
    const abertas = await ativaEmDia(mid);
    const [{ data: planos }, { data: vinc }, { data: pacs }, { data: recusa }, pessoas] = await Promise.all([
      db.from('whatsapp_planos').select(CAMPOS_PLANO_PUBLICO).eq('ativo', true)
        .order('ordem', { ascending: true }).order('preco', { ascending: true }),
      db.from('whatsapp_vinculos').select('*').eq('mercearia_id', mid).neq('status', 'removido').order('criado_em', { ascending: true }),
      db.from('whatsapp_pacotes_compras').select('id, nome, preco, creditos, status, criado_em, resolvido_em, motivo')
        .eq('mercearia_id', mid).order('criado_em', { ascending: false }).limit(20),
      db.from('whatsapp_assinaturas').select('id, plano_nome, status, motivo, encerrado_em')
        .eq('mercearia_id', mid).in('status', ['recusada', 'cancelada']).order('encerrado_em', { ascending: false }).limit(1),
      pessoasDaLoja(mid),
    ]);

    let resumo = null;
    if (abertas.ativa) {
      resumo = await A.resumoCiclo(db, abertas.ativa.id, abertas.ativa.ciclo_inicio);
    }
    const limite = abertas.ativa ? A.limiteNumeros(abertas.ativa) : (abertas.pendente?.numeros || 0);
    const ultima = (recusa || [])[0];
    const recente = ultima && ultima.encerrado_em && (Date.now() - new Date(ultima.encerrado_em).getTime()) < 15 * 86400000;

    res.json({
      servico: { ativo: p.integracao.ativo },
      pesos: p.pesos,
      conversa_gratis_dia: p.travas.conversa_gratis_dia,
      planos: (planos || []).filter(x => x.tipo !== 'pacote'),
      pacotes: (planos || []).filter(x => x.tipo === 'pacote'),
      termos: A.TERMOS,
      assinatura: abertas.ativa ? {
        ...abertas.ativa, ...resumo, hoje: hojeStrTZ(abertas.tz),
        // Assistente pausado pelo teto de custo neste ciclo (disjuntor)
        pausado_teto: abertas.ativa.teto_ciclo === abertas.ativa.ciclo_inicio && !!abertas.ativa.teto_pausado_em && !abertas.ativa.teto_liberado_em,
        // Plano ativo com aceite de uma versão antiga dos termos (01/10/2026)
        termos_pendentes: abertas.ativa.termos_versao !== A.TERMOS.versao,
        valor_mensal: A.valorMensal(abertas.ativa),
        // (01/10) Ciclo novo esperando o pagamento: os créditos entram quando for confirmado
        aguardando_pagamento: A.aguardandoPagamento(abertas.ativa),
      } : null,
      pendente: abertas.pendente,
      pacotes_pedidos: pacs || [],
      vinculos: (vinc || []).map(v => vinculoPublico(v, pessoas)),
      pessoas,
      limite_numeros: limite,
      // Números extras (01/10/2026): preço atual por número e quantos dá pra ter
      numero_extra: {
        preco: abertas.ativa?.numero_extra_preco != null && Number(abertas.ativa.numeros_extras) > 0
          ? Number(abertas.ativa.numero_extra_preco) : p.numeros.preco_extra,
        max: p.numeros.max_extras,
        disponivel: p.numeros.preco_extra > 0 && p.numeros.max_extras > 0,
      },
      ultima_encerrada: recente ? ultima : null,
    });
  } catch (err) {
    console.error('[WHATSAPP LOJA] GET:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o WhatsApp.' });
  }
});

/* ── Aceitar a versão nova dos termos (plano já ativo) — 01/10/2026 ── */
router.post('/aceitar-termos', async (req, res) => {
  const b = req.body || {};
  if (b.aceite !== true) return res.status(400).json({ error: 'É preciso ler e aceitar os termos.' });
  if (b.termos_versao !== A.TERMOS.versao) {
    return res.status(409).json({ error: 'Os termos foram atualizados de novo. Recarregue a tela e leia a versão nova.', codigo: 'TERMOS_DESATUALIZADOS' });
  }
  try {
    const { ativa } = await assinaturasAbertas(req.user.mercearia_id);
    if (!ativa) return res.status(404).json({ error: 'Nenhum plano ativo.' });
    const { error } = await db.from('whatsapp_assinaturas')
      .update({ termos_versao: A.TERMOS.versao, termos_aceitos_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq('id', ativa.id).eq('status', 'ativa');
    if (error) throw error;
    auditar(req, 'whatsapp_termos_aceitos', `Aceitou a versão ${A.TERMOS.versao} dos termos do WhatsApp (plano "${ativa.plano_nome}")`, { assinatura_id: ativa.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] aceitar termos:', err.message);
    res.status(500).json({ error: 'Erro ao registrar o aceite.' });
  }
});

/* ── Números extras (01/10/2026) ───────────────────────────────
   A loja pede +N números além dos do plano; o SuperAdmin master aprova
   (cobrança combinada à parte nesta fase). Remover extra é na hora, desde
   que os números cadastrados caibam no novo limite. */
router.post('/numeros-extras', async (req, res) => {
  const mid = req.user.mercearia_id;
  const qtd = parseInt(req.body?.quantidade, 10);
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 50) return res.status(400).json({ error: 'Quantidade inválida.' });
  try {
    const p = await parametros();
    if (!(p.numeros.preco_extra > 0 && p.numeros.max_extras > 0)) return res.status(400).json({ error: 'Números extras não estão disponíveis no momento.' });
    const { ativa } = await ativaEmDia(mid);
    if (!ativa) return res.status(400).json({ error: 'Só dá pra pedir número extra com um plano ativo.' });
    if (ativa.numeros_extras_pedido > 0) return res.status(409).json({ error: 'Já existe um pedido de número extra esperando aprovação.' });
    if ((ativa.numeros_extras || 0) + qtd > p.numeros.max_extras) {
      return res.status(409).json({ error: `O máximo é ${p.numeros.max_extras} número${p.numeros.max_extras === 1 ? '' : 's'} extra${p.numeros.max_extras === 1 ? '' : 's'} por loja.` });
    }
    const agora = new Date().toISOString();
    const { data, error } = await db.from('whatsapp_assinaturas')
      .update({ numeros_extras_pedido: qtd, numeros_extras_pedido_em: agora, numeros_extras_pedido_por_nome: req.user.nome, atualizado_em: agora })
      .eq('id', ativa.id).eq('status', 'ativa').eq('numeros_extras_pedido', 0).select();
    if (error) throw error;
    if (!data || !data.length) return res.status(409).json({ error: 'Já existe um pedido de número extra esperando aprovação.' });
    const preco = ativa.numero_extra_preco != null && ativa.numeros_extras > 0 ? Number(ativa.numero_extra_preco) : p.numeros.preco_extra;
    auditar(req, 'whatsapp_numero_extra_pedido', `Pediu ${qtd} número${qtd === 1 ? '' : 's'} extra${qtd === 1 ? '' : 's'} de WhatsApp (R$ ${preco.toFixed(2)} por número/mês)`, { assinatura_id: ativa.id, quantidade: qtd, preco });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] numero extra:', err.message);
    res.status(500).json({ error: 'Erro ao pedir o número extra.' });
  }
});

router.post('/numeros-extras/desistir', async (req, res) => {
  try {
    const { ativa } = await ativaEmDia(req.user.mercearia_id);
    if (!ativa || !ativa.numeros_extras_pedido) return res.status(404).json({ error: 'Nenhum pedido de número extra pendente.' });
    await db.from('whatsapp_assinaturas')
      .update({ numeros_extras_pedido: 0, numeros_extras_pedido_em: null, numeros_extras_pedido_por_nome: null, atualizado_em: new Date().toISOString() })
      .eq('id', ativa.id).eq('status', 'ativa');
    auditar(req, 'whatsapp_numero_extra_desistiu', 'Desistiu do pedido de número extra de WhatsApp', { assinatura_id: ativa.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] desistir numero extra:', err.message);
    res.status(500).json({ error: 'Erro ao desistir do pedido.' });
  }
});

router.post('/numeros-extras/remover', async (req, res) => {
  const mid = req.user.mercearia_id;
  try {
    const { ativa } = await ativaEmDia(mid);
    if (!ativa || !(ativa.numeros_extras > 0)) return res.status(404).json({ error: 'Você não tem número extra.' });
    const { count } = await db.from('whatsapp_vinculos').select('id', { count: 'exact', head: true })
      .eq('mercearia_id', mid).neq('status', 'removido');
    const novoLimite = A.limiteNumeros(ativa) - 1;
    if ((count || 0) > novoLimite) {
      return res.status(409).json({ error: `Você tem ${count} números cadastrados. Remova um número antes de tirar o extra (o limite vai ficar em ${novoLimite}).` });
    }
    const { data, error } = await db.from('whatsapp_assinaturas')
      .update({ numeros_extras: ativa.numeros_extras - 1, atualizado_em: new Date().toISOString() })
      .eq('id', ativa.id).eq('status', 'ativa').eq('numeros_extras', ativa.numeros_extras).select();
    if (error) throw error;
    if (!data || !data.length) return res.status(409).json({ error: 'Os números mudaram. Atualize a tela e tente de novo.' });
    auditar(req, 'whatsapp_numero_extra_removido', `Tirou 1 número extra de WhatsApp (ficou com ${ativa.numeros_extras - 1})`, { assinatura_id: ativa.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] remover numero extra:', err.message);
    res.status(500).json({ error: 'Erro ao tirar o número extra.' });
  }
});

/* ── Contratação ───────────────────────────────────────────── */
router.post('/assinar', async (req, res) => {
  const mid = req.user.mercearia_id;
  const b = req.body || {};
  if (b.aceite !== true) return res.status(400).json({ error: 'É preciso ler e aceitar os termos.' });
  if (b.termos_versao !== A.TERMOS.versao) {
    return res.status(409).json({ error: 'Os termos foram atualizados. Leia a versão nova antes de continuar.', codigo: 'TERMOS_DESATUALIZADOS' });
  }
  if (!UUID.test(String(b.plano_id || ''))) return res.status(400).json({ error: 'Plano inválido.' });
  try {
    const { data: plano } = await db.from('whatsapp_planos').select('*').eq('id', b.plano_id).maybeSingle();
    if (!plano || !plano.ativo || plano.tipo !== 'plano') return res.status(404).json({ error: 'Plano não disponível.' });
    const { ativa, pendente } = await assinaturasAbertas(mid);
    if (pendente) return res.status(409).json({ error: 'Já existe uma solicitação aguardando ativação.' });
    if (ativa && ativa.plano_id === plano.id) return res.status(400).json({ error: 'Você já está neste plano.' });

    const { data, error } = await db.from('whatsapp_assinaturas').insert({
      mercearia_id: mid, plano_id: plano.id, plano_nome: plano.nome, preco: plano.preco, creditos: plano.creditos,
      numeros: plano.numeros || 1, recursos: plano.recursos || {}, status: 'aguardando', substitui_id: ativa?.id || null,
      termos_versao: A.TERMOS.versao, termos_aceitos_em: new Date().toISOString(),
      solicitado_por: req.user.id, solicitado_por_nome: req.user.nome, solicitado_ip: String(req.ip || '').slice(0, 60),
    }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Já existe uma solicitação aguardando ativação.' });
      throw error;
    }
    auditar(req, ativa ? 'whatsapp_troca_solicitada' : 'whatsapp_plano_solicitado',
      `${ativa ? `Pediu troca do plano de WhatsApp "${ativa.plano_nome}" para` : 'Solicitou o plano de WhatsApp'} "${plano.nome}" (R$ ${plano.preco}/mês, ${plano.creditos} créditos) — aceitou os termos versão ${A.TERMOS.versao}`,
      { assinatura_id: data.id, plano_id: plano.id });
    res.status(201).json(data);
  } catch (err) {
    console.error('[WHATSAPP LOJA] assinar:', err.message);
    res.status(500).json({ error: 'Erro ao solicitar o plano.' });
  }
});

router.post('/desistir', async (req, res) => {
  try {
    const { pendente } = await assinaturasAbertas(req.user.mercearia_id);
    if (!pendente) return res.status(404).json({ error: 'Nenhuma solicitação pendente.' });
    const agora = new Date().toISOString();
    await db.from('whatsapp_assinaturas').update({ status: 'desistiu', encerrado_em: agora, encerrado_por_nome: req.user.nome, atualizado_em: agora })
      .eq('id', pendente.id).eq('status', 'aguardando');
    auditar(req, 'whatsapp_solicitacao_desistiu', `Desistiu da solicitação do plano de WhatsApp "${pendente.plano_nome}"`, { assinatura_id: pendente.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] desistir:', err.message);
    res.status(500).json({ error: 'Erro ao desistir.' });
  }
});

async function mudarCancelamento(req, res, valor) {
  try {
    const { ativa } = await ativaEmDia(req.user.mercearia_id);
    if (!ativa) return res.status(404).json({ error: 'Nenhum plano ativo.' });
    const { data, error } = await db.from('whatsapp_assinaturas')
      .update({ cancelar_no_fim: valor, atualizado_em: new Date().toISOString() })
      .eq('id', ativa.id).eq('status', 'ativa').select().single();
    if (error) throw error;
    auditar(req, valor ? 'whatsapp_cancelamento_agendado' : 'whatsapp_cancelamento_desfeito',
      valor ? `Cancelou o plano de WhatsApp "${ativa.plano_nome}" (vale até ${ativa.ciclo_fim})` : `Desfez o cancelamento do plano de WhatsApp "${ativa.plano_nome}"`,
      { assinatura_id: ativa.id });
    res.json(data);
  } catch (err) {
    console.error('[WHATSAPP LOJA] cancelamento:', err.message);
    res.status(500).json({ error: 'Erro ao alterar o plano.' });
  }
}
router.post('/cancelar', (req, res) => mudarCancelamento(req, res, true));
router.post('/manter', (req, res) => mudarCancelamento(req, res, false));

router.get('/extrato', async (req, res) => {
  try {
    const { ativa } = await ativaEmDia(req.user.mercearia_id);
    if (!ativa) return res.json({ movimentos: [] });
    const { data, error } = await db.from('whatsapp_creditos_mov')
      .select('id, tipo, quantidade, pedido_tipo, descricao, criado_em')
      .eq('assinatura_id', ativa.id).eq('ciclo_inicio', ativa.ciclo_inicio)
      .order('criado_em', { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ ciclo_inicio: ativa.ciclo_inicio, ciclo_fim: ativa.ciclo_fim, movimentos: data || [] });
  } catch (err) {
    console.error('[WHATSAPP LOJA] extrato:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o extrato.' });
  }
});

/* ── Pacotes extras ────────────────────────────────────────── */
router.post('/pacotes', async (req, res) => {
  const mid = req.user.mercearia_id;
  const id = String(req.body?.plano_id || '');
  if (!UUID.test(id)) return res.status(400).json({ error: 'Pacote inválido.' });
  try {
    const { ativa } = await ativaEmDia(mid);
    if (!ativa) return res.status(400).json({ error: 'O pacote extra só pode ser pedido com um plano ativo.' });
    const { data: pac } = await db.from('whatsapp_planos').select('*').eq('id', id).maybeSingle();
    if (!pac || !pac.ativo || pac.tipo !== 'pacote') return res.status(404).json({ error: 'Pacote não disponível.' });
    const { count } = await db.from('whatsapp_pacotes_compras').select('id', { count: 'exact', head: true })
      .eq('mercearia_id', mid).eq('status', 'aguardando');
    if ((count || 0) >= 3) return res.status(409).json({ error: 'Já existem 3 pacotes aguardando aprovação.' });
    const { data, error } = await db.from('whatsapp_pacotes_compras').insert({
      mercearia_id: mid, assinatura_id: ativa.id, plano_id: pac.id, nome: pac.nome, preco: pac.preco, creditos: pac.creditos,
      solicitado_por: req.user.id, solicitado_por_nome: req.user.nome,
    }).select().single();
    if (error) throw error;
    auditar(req, 'whatsapp_pacote_solicitado', `Pediu o pacote extra de WhatsApp "${pac.nome}" (R$ ${pac.preco}, +${pac.creditos} créditos)`, { pacote_id: data.id });
    res.status(201).json(data);
  } catch (err) {
    console.error('[WHATSAPP LOJA] pacote:', err.message);
    res.status(500).json({ error: 'Erro ao pedir o pacote.' });
  }
});

router.post('/pacotes/:id/desistir', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Pacote inválido.' });
  try {
    const { data } = await db.from('whatsapp_pacotes_compras')
      .update({ status: 'desistiu', resolvido_em: new Date().toISOString(), resolvido_por_nome: req.user.nome })
      .eq('id', req.params.id).eq('mercearia_id', req.user.mercearia_id).eq('status', 'aguardando').select();
    if (!data || !data.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    auditar(req, 'whatsapp_pacote_desistiu', `Desistiu do pacote extra "${data[0].nome}"`, { pacote_id: data[0].id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] desistir pacote:', err.message);
    res.status(500).json({ error: 'Erro ao desistir do pacote.' });
  }
});

/* ── Números vinculados ────────────────────────────────────── */
async function novoCodigo(vinculo) {
  const codigo = A.gerarCodigo();
  const expira = new Date(Date.now() + A.CODIGO_VALIDADE_HORAS * 3600000).toISOString();
  const { data, error } = await db.from('whatsapp_vinculos')
    .update({ codigo_hash: A.hashCodigo(codigo, vinculo.telefone), codigo_expira_em: expira, tentativas: 0 })
    .eq('id', vinculo.id).select().single();
  if (error) throw error;
  return { vinculo: data, codigo };
}

router.post('/vinculos', async (req, res) => {
  const mid = req.user.mercearia_id;
  const telefone = A.normalizarTelefone(req.body?.telefone);
  const usuarioId = String(req.body?.usuario_id || '');
  if (!UUID.test(usuarioId)) return res.status(400).json({ error: 'Escolha a pessoa que vai usar este número.' });
  if (!telefone) return res.status(400).json({ error: 'Telefone inválido. Use DDD + número, ex.: (53) 99123-4567.' });
  try {
    const pessoas = await pessoasDaLoja(mid);
    const pessoa = pessoas.find(p => p.id === usuarioId);
    if (!pessoa) return res.status(400).json({ error: 'Pessoa não encontrada ou inativa nesta loja.' });
    const apelido = (String(req.body?.apelido || '').trim() || pessoa.nome).slice(0, 60);
    const { ativa, pendente } = await ativaEmDia(mid);
    const plano = ativa || pendente;
    if (!plano) return res.status(400).json({ error: 'Contrate um plano antes de cadastrar números.' });
    const { count } = await db.from('whatsapp_vinculos').select('id', { count: 'exact', head: true })
      .eq('mercearia_id', mid).neq('status', 'removido');
    const lim = ativa ? A.limiteNumeros(ativa) : (plano.numeros || 1);
    if ((count || 0) >= lim) {
      return res.status(409).json({ error: `Seu plano permite ${lim} número${lim === 1 ? '' : 's'}. Remova um, peça um número extra ou troque de plano.` });
    }
    const { data: v, error } = await db.from('whatsapp_vinculos').insert({
      mercearia_id: mid, telefone, apelido, usuario_id: pessoa.id, status: 'pendente', criado_por_nome: req.user.nome,
    }).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Esse número já está cadastrado.' });
      throw error;
    }
    const r = await novoCodigo(v);
    auditar(req, 'whatsapp_numero_cadastrado', `Cadastrou o número ${A.formatarTelefone(telefone)} (${pessoa.nome} — ${pessoa.papel}) no WhatsApp do sistema`, { vinculo_id: v.id, usuario_id: pessoa.id });
    res.status(201).json({ vinculo: vinculoPublico(r.vinculo, pessoas), codigo: r.codigo });
  } catch (err) {
    console.error('[WHATSAPP LOJA] vinculo:', err.message);
    res.status(500).json({ error: 'Erro ao cadastrar o número.' });
  }
});

// Troca a pessoa ligada a um número (as permissões passam a ser as dela)
router.patch('/vinculos/:id', async (req, res) => {
  const mid = req.user.mercearia_id;
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Número inválido.' });
  const usuarioId = String(req.body?.usuario_id || '');
  if (!UUID.test(usuarioId)) return res.status(400).json({ error: 'Escolha a pessoa.' });
  try {
    const pessoas = await pessoasDaLoja(mid);
    const pessoa = pessoas.find(p => p.id === usuarioId);
    if (!pessoa) return res.status(400).json({ error: 'Pessoa não encontrada ou inativa nesta loja.' });
    const { data, error } = await db.from('whatsapp_vinculos')
      .update({ usuario_id: pessoa.id, apelido: pessoa.nome.slice(0, 60) })
      .eq('id', req.params.id).eq('mercearia_id', mid).neq('status', 'removido').select();
    if (error) throw error;
    if (!data || !data.length) return res.status(404).json({ error: 'Número não encontrado.' });
    auditar(req, 'whatsapp_numero_pessoa', `Ligou o número ${A.formatarTelefone(data[0].telefone)} do WhatsApp a ${pessoa.nome} (${pessoa.papel})`, { vinculo_id: data[0].id, usuario_id: pessoa.id });
    res.json({ vinculo: vinculoPublico(data[0], pessoas) });
  } catch (err) {
    console.error('[WHATSAPP LOJA] pessoa do vinculo:', err.message);
    res.status(500).json({ error: 'Erro ao salvar.' });
  }
});

router.post('/vinculos/:id/codigo', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Número inválido.' });
  try {
    const { data: v } = await db.from('whatsapp_vinculos').select('*')
      .eq('id', req.params.id).eq('mercearia_id', req.user.mercearia_id).maybeSingle();
    if (!v || v.status !== 'pendente') return res.status(404).json({ error: 'Número não encontrado ou já confirmado.' });
    const r = await novoCodigo(v);
    res.json({ vinculo: vinculoPublico(r.vinculo, await pessoasDaLoja(req.user.mercearia_id)), codigo: r.codigo });
  } catch (err) {
    console.error('[WHATSAPP LOJA] codigo:', err.message);
    res.status(500).json({ error: 'Erro ao gerar o código.' });
  }
});

router.delete('/vinculos/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Número inválido.' });
  try {
    const { data } = await db.from('whatsapp_vinculos')
      .update({ status: 'removido', removido_em: new Date().toISOString(), codigo_hash: null })
      .eq('id', req.params.id).eq('mercearia_id', req.user.mercearia_id).neq('status', 'removido').select();
    if (!data || !data.length) return res.status(404).json({ error: 'Número não encontrado.' });
    auditar(req, 'whatsapp_numero_removido', `Removeu o número ${A.formatarTelefone(data[0].telefone)} (${data[0].apelido}) do WhatsApp do sistema`, { vinculo_id: data[0].id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WHATSAPP LOJA] remover vinculo:', err.message);
    res.status(500).json({ error: 'Erro ao remover o número.' });
  }
});

module.exports = router;
