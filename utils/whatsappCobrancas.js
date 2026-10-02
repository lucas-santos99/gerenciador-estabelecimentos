// utils/whatsappCobrancas.js
// ============================================================
// WhatsApp — cobrança automática do plano (02/10/2026, SQL 19).
// A loja paga na própria tela, por Pix (Efí) ou cartão (Asaas), e o
// pagamento confirmado pelo provedor registra o pagamento
// (whatsapp_pagamentos, com a taxa) e libera sozinho:
//   ativacao     → ativa o plano solicitado (ou a troca de plano)
//   mensalidade  → libera os créditos do ciclo que está aguardando, ou
//                  fica guardado pro ciclo seguinte (pago adiantado)
//   pacote       → aprova o pacote extra e soma os créditos
//   numero_extra → libera os números extras pedidos (SQL 20). Valor na hora
//                  = proporcional aos dias que faltam do ciclo; o valor
//                  cheio entra na mensalidade seguinte.
//
// Mesmas regras de segurança do pagamento da licença
// (utils/licencaPagamentos.js):
//   • toda cobrança gerada fica em whatsapp_cobrancas; o webhook acha por lá;
//   • status e valor são conferidos na API do provedor, nunca no corpo do
//     webhook;
//   • cada cobrança é aplicada UMA vez (trava pendente → processando → pago
//     + índices únicos do banco); reenvio do webhook não soma nada;
//   • dinheiro que chegou e não pôde ser aplicado (pago duas vezes, pedido
//     desistido, valor menor) NUNCA some: vira alerta pro SuperAdmin;
//   • devolução / estorno não tira créditos sozinho: vira alerta.
//
// As chamadas aos provedores usam os ajudantes das rotas (efiRoutes /
// asaasRoutes), carregados só na hora do uso pra não criar dependência
// circular (os webhooks de lá chamam este arquivo).
// ============================================================
const crypto = require('crypto');
const { hojeStrTZ } = require('./fusoHorario');
const W = require('./whatsappCustos');
const A = require('./whatsappAssinaturas');

const ORIGEM = { efi: 'Sistema (Efí)', asaas: 'Sistema (Asaas)' };
const NOME_PROVEDOR = { efi: 'Pix (Efí)', asaas: 'cartão (Asaas)' };
const VALIDADE_DIAS = 3;                 // prazo pra pagar uma cobrança gerada
const CARTAO_MINIMO = 5;                 // o Asaas não aceita cobrança abaixo de R$ 5,00
const STATUS_PAGO_ASAAS = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];
const REF_ASAAS = /^whatsapp\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const efi = () => require('../routes/efiRoutes');
const asaas = () => require('../routes/asaasRoutes').asaas;
const registrar = (x) => require('../routes/auditoriaRoutes').registrar(x);

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const reais = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (d) => String(d || '').slice(0, 10).split('-').reverse().join('/');

async function parametros(db) {
  const { data } = await db.from('config_sistema').select('valor').eq('chave', 'whatsapp_params').maybeSingle();
  let salvo = null;
  try { salvo = data?.valor ? JSON.parse(data.valor) : null; } catch { salvo = null; }
  return W.normalizarParametros(salvo);
}

function auditar(cob, acao, descricao, meta = {}, escopo = 'estabelecimento') {
  const origem = ORIGEM[cob.provedor] || 'Sistema';
  return registrar({
    mercearia_id: cob.mercearia_id, usuario_nome: origem, usuario_email: origem,
    modulo: 'whatsapp', acao, descricao: String(descricao).slice(0, 600),
    meta: { cobranca: cob.id, provedor: cob.provedor, cobranca_id: cob.cobranca_id, tipo: cob.tipo, ...meta }, escopo,
  });
}

// Aviso pro SuperAdmin (central de notificações) sobre um pagamento
const alertar = (cob, texto, meta = {}) => auditar(cob, 'whatsapp_pagamento_alerta', texto, meta, 'admin_global');

/* ── Número extra: quanto pagar agora ──────────────────────── */
const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000);
// Preço por número: o travado da loja (se ela já tem extras) ou o atual
const precoNumeroExtra = (a, p) => (a.numero_extra_preco != null && Number(a.numeros_extras) > 0 ? Number(a.numero_extra_preco) : p.numeros.preco_extra);
// Proporcional aos dias que faltam do ciclo (contando hoje). Se a próxima
// mensalidade já foi paga adiantada (sem o número novo), soma o mês cheio dela.
async function valorNumeroExtra(db, a, qtd, p, hoje) {
  const preco = precoNumeroExtra(a, p);
  const diasCiclo = Math.max(1, diasEntre(a.ciclo_inicio, a.ciclo_fim) + 1);
  const restam = Math.min(diasCiclo, Math.max(1, diasEntre(hoje, a.ciclo_fim) + 1));
  const proporcional = Math.max(0.01, r2(qtd * preco * restam / diasCiclo));
  const proximoPago = !!(await A.pagamentoDoCiclo(db, a.id, A.somarDias(a.ciclo_fim, 1)));
  const proximo = proximoPago ? r2(qtd * preco) : 0;
  return { preco, dias_ciclo: diasCiclo, dias_restantes: restam, proporcional, proximo, valor: r2(proporcional + proximo) };
}

/* ── O que a loja pode pagar agora ─────────────────────────── */
// Sem pacote: a solicitação pendente (ativação/troca), o ciclo que está
// aguardando pagamento ou a renovação adiantada. Devolve
// { tipo, motivo, assinatura, ciclo_inicio, pacote, valor, descricao } ou { erro }.
async function alvoDaLoja(db, merceariaId, { pacote_id, numero_extra } = {}, params) {
  const p = params || await parametros(db);
  const { data: abertas, error } = await db.from('whatsapp_assinaturas').select('*')
    .eq('mercearia_id', merceariaId).in('status', ['aguardando', 'ativa']);
  if (error) throw error;
  const pendente = (abertas || []).find(a => a.status === 'aguardando') || null;
  let ativa = (abertas || []).find(a => a.status === 'ativa') || null;
  const tz = await A.timezoneDaLoja(db, merceariaId);
  const hoje = hojeStrTZ(tz);
  if (ativa) {
    ativa = await A.garantirCiclo(db, ativa, hoje);
    if (!ativa || ativa.status !== 'ativa') ativa = null;
  }

  if (numero_extra) {
    if (!ativa) return { erro: 'O número extra só pode ser pago com um plano ativo.', http: 409 };
    const qtd = Number(ativa.numeros_extras_pedido) || 0;
    if (!(qtd > 0)) return { erro: 'Não há pedido de número extra aguardando pagamento.', http: 404 };
    const v = await valorNumeroExtra(db, ativa, qtd, p, hoje);
    const nums = `${qtd} número${qtd === 1 ? '' : 's'} extra${qtd === 1 ? '' : 's'}`;
    return {
      tipo: 'numero_extra', motivo: 'numero_extra', assinatura: ativa, ciclo_inicio: null, pacote: null, quantidade: qtd, valor: v.valor, hoje, detalhe: v,
      descricao: `${nums} de WhatsApp — ${v.dias_restantes} dia${v.dias_restantes === 1 ? '' : 's'} até ${dataBR(ativa.ciclo_fim)}${v.proximo > 0 ? ' + próximo ciclo (já pago)' : ''}`,
    };
  }

  if (pacote_id) {
    const { data: pac } = await db.from('whatsapp_pacotes_compras').select('*')
      .eq('id', pacote_id).eq('mercearia_id', merceariaId).maybeSingle();
    if (!pac || pac.status !== 'aguardando') return { erro: 'Esse pedido de pacote não está mais aguardando pagamento.', http: 404 };
    if (!ativa) return { erro: 'O pacote extra só pode ser pago com um plano ativo.', http: 409 };
    return {
      tipo: 'pacote', motivo: 'pacote', assinatura: ativa, ciclo_inicio: null, pacote: pac, valor: r2(pac.preco), hoje,
      descricao: `Pacote extra de WhatsApp "${pac.nome}" (+${pac.creditos} créditos)`,
    };
  }

  if (pendente) {
    // Troca de plano: os números extras da assinatura atual continuam
    const valor = A.valorMensal({ ...pendente, numeros_extras: ativa?.numeros_extras || 0, numero_extra_preco: ativa?.numero_extra_preco });
    return {
      tipo: 'ativacao', motivo: ativa ? 'troca' : 'ativacao', assinatura: pendente, ciclo_inicio: null, pacote: null, valor, hoje,
      descricao: `Plano de WhatsApp "${pendente.plano_nome}" (${pendente.creditos} créditos por mês)`,
    };
  }
  if (!ativa) return { erro: 'Não há nada para pagar agora.', http: 409 };

  const valor = A.valorMensal(ativa);
  if (A.aguardandoPagamento(ativa)) {
    return {
      tipo: 'mensalidade', motivo: 'ciclo', assinatura: ativa, ciclo_inicio: ativa.ciclo_inicio, pacote: null, valor, hoje,
      descricao: `Mensalidade do WhatsApp "${ativa.plano_nome}" — ciclo ${dataBR(ativa.ciclo_inicio)} a ${dataBR(ativa.ciclo_fim)}`,
    };
  }
  // Renovação adiantada: nos últimos N dias do ciclo, se ainda não foi paga
  const dias = p.pagamento_online.dias_antecipar;
  const proximo = A.somarDias(ativa.ciclo_fim, 1);
  const jaPago = await A.pagamentoDoCiclo(db, ativa.id, proximo);
  if (jaPago) return { erro: 'A próxima mensalidade já está paga.', http: 409, proximo_pago: true, assinatura: ativa, hoje };
  if (ativa.cancelar_no_fim) return { erro: 'O plano está com cancelamento agendado. Para pagar a renovação, escolha "Manter meu plano" antes.', http: 409, assinatura: ativa, hoje };
  if (dias > 0 && hoje >= A.somarDias(proximo, -dias)) {
    return {
      tipo: 'mensalidade', motivo: 'antecipado', assinatura: ativa, ciclo_inicio: proximo, pacote: null, valor, hoje,
      descricao: `Mensalidade do WhatsApp "${ativa.plano_nome}" — ciclo ${dataBR(proximo)} a ${dataBR(A.fimDoCiclo(proximo))}`,
    };
  }
  return { erro: 'Não há nada para pagar agora.', http: 409, assinatura: ativa, hoje };
}

/* ── Cancelar cobranças pendentes ──────────────────────────── */
async function cancelarNoProvedor(cob) {
  try {
    if (cob.provedor === 'efi') {
      await efi().efiPixRequest('PATCH', `/v2/cob/${encodeURIComponent(cob.cobranca_id)}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' });
    } else {
      const as = asaas();
      await fetch(`${as.url}/payments/${encodeURIComponent(cob.cobranca_id)}`, { method: 'DELETE', headers: as.headers() });
    }
  } catch (e) {
    // Não conseguir cancelar lá não é grave: se alguém pagar uma cobrança
    // cancelada, o pagamento é aplicado ou vira alerta (nunca se perde).
    console.warn(`[WHATSAPP COBRANÇA] Não cancelou ${cob.provedor} ${cob.cobranca_id} no provedor:`, e.response?.data?.nome || e.message);
  }
}

async function cancelar(db, cobs) {
  for (const c of cobs || []) {
    const { data } = await db.from('whatsapp_cobrancas')
      .update({ status: 'cancelada', atualizado_em: new Date().toISOString() })
      .eq('id', c.id).eq('status', 'pendente').select();
    if (data && data.length) await cancelarNoProvedor(c);
  }
}

// Cancela as cobranças pendentes de um alvo (pedido desistido, recusado,
// pago na mão pelo SuperAdmin…). filtro: { assinatura_id, tipo?, pacote_id? }
async function cancelarPendentes(db, filtro = {}) {
  try {
    let q = db.from('whatsapp_cobrancas').select('*').eq('status', 'pendente');
    if (filtro.pacote_id) q = q.eq('pacote_id', filtro.pacote_id);
    else if (filtro.assinatura_id) q = q.eq('assinatura_id', filtro.assinatura_id);
    else return;
    if (filtro.tipo) q = q.eq('tipo', filtro.tipo);
    const { data } = await q;
    await cancelar(db, data || []);
  } catch (e) {
    console.error('[WHATSAPP COBRANÇA] cancelarPendentes:', e.message);
  }
}

/* ── Gerar (ou reaproveitar) a cobrança ────────────────────── */
async function qrDoPix(cob) {
  if (!cob.loc_id) return null;
  try {
    const r = await efi().efiPixRequest('GET', `/v2/loc/${cob.loc_id}/qrcode`);
    return r.data?.imagemQrcode || null;
  } catch (e) {
    console.warn('[WHATSAPP COBRANÇA] QR do Pix:', e.response?.data?.nome || e.message);
    return null;
  }
}

async function criarPix(db, base, mercearia) {
  const E = efi();
  if (!E.efiConfigurado()) return { aviso: 'O Pix não está disponível no momento.' };
  const txid = crypto.randomBytes(16).toString('hex');
  const resp = await E.efiPixRequest('PUT', `/v2/cob/${txid}`, {
    calendario: { expiracao: VALIDADE_DIAS * 86400 },
    valor: { original: base.valor.toFixed(2) },
    chave: E.EFI_CHAVE_PIX,
    solicitacaoPagador: `WhatsApp do sistema - ${mercearia.nome_fantasia || 'estabelecimento'}`.slice(0, 140),
  });
  const reg = {
    ...base, provedor: 'efi', cobranca_id: txid,
    pix_copia_cola: resp.data?.pixCopiaECola || null, loc_id: resp.data?.loc?.id || null,
    expira_em: new Date(Date.now() + VALIDADE_DIAS * 86400000).toISOString(),
  };
  let qr = null;
  if (reg.loc_id) {
    try {
      const q = await E.efiPixRequest('GET', `/v2/loc/${reg.loc_id}/qrcode`);
      qr = q.data?.imagemQrcode || null;
      reg.pix_copia_cola = reg.pix_copia_cola || q.data?.qrcode || null;
    } catch (e) { console.warn('[WHATSAPP COBRANÇA] QR do Pix:', e.response?.data?.nome || e.message); }
  }
  const { data, error } = await db.from('whatsapp_cobrancas').insert(reg).select().single();
  if (error) throw error;
  return { cob: data, qr };
}

async function criarCartao(db, base, mercearia, descricao) {
  const as = asaas();
  if (!as.configurado()) return { aviso: 'O pagamento por cartão não está disponível no momento.' };
  if (base.valor < CARTAO_MINIMO) return { aviso: `Cartão disponível para valores a partir de ${reais(CARTAO_MINIMO)}.` };
  const id = crypto.randomUUID();
  const customer = await as.clienteDe(mercearia);
  const venc = new Date(Date.now() + VALIDADE_DIAS * 86400000);
  const resp = await fetch(`${as.url}/payments`, {
    method: 'POST', headers: as.headers(),
    body: JSON.stringify({
      customer, billingType: 'CREDIT_CARD', value: base.valor, dueDate: venc.toISOString().slice(0, 10),
      description: `${descricao} — Gerenciador de Estabelecimentos`.slice(0, 450), externalReference: `whatsapp|${id}`,
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.id) throw new Error(j.errors?.[0]?.description || `Asaas HTTP ${resp.status}`);
  const { data, error } = await db.from('whatsapp_cobrancas').insert({
    ...base, id, provedor: 'asaas', cobranca_id: j.id, invoice_url: j.invoiceUrl || null,
    expira_em: new Date(`${j.dueDate || venc.toISOString().slice(0, 10)}T23:59:59-03:00`).toISOString(),
  }).select().single();
  if (error) throw error;
  return { cob: data };
}

// Gera o Pix e o link de cartão do que a loja tem pra pagar agora,
// reaproveitando cobranças pendentes do mesmo alvo e valor ainda no prazo.
// Devolve { erro, http } ou { grupo, tipo, motivo, valor, descricao, pix, cartao, avisos }.
async function gerar(db, merceariaId, opcoes = {}) {
  const p = await parametros(db);
  if (!p.pagamento_online.ativo) return { erro: 'O pagamento pela tela está desligado no momento. Fale com o suporte para combinar o pagamento.', http: 409 };
  const alvo = await alvoDaLoja(db, merceariaId, opcoes, p);
  if (alvo.erro) return alvo;
  if (!(alvo.valor > 0)) return { erro: 'Este plano não tem valor a pagar. Fale com o suporte.', http: 409 };

  const { data: mercearia } = await db.from('mercearias')
    .select('id, nome_fantasia, email_contato, telefone, cnpj, asaas_customer_id').eq('id', merceariaId).maybeSingle();
  if (!mercearia) return { erro: 'Estabelecimento não encontrado.', http: 404 };

  // Pendentes do MESMO alvo
  let q = db.from('whatsapp_cobrancas').select('*').eq('assinatura_id', alvo.assinatura.id).eq('tipo', alvo.tipo).eq('status', 'pendente');
  if (alvo.tipo === 'pacote') q = q.eq('pacote_id', alvo.pacote.id);
  if (alvo.tipo === 'mensalidade') q = q.eq('ciclo_inicio', alvo.ciclo_inicio);
  const { data: pend } = await q.order('criado_em', { ascending: false });
  const limite = Date.now() + 10 * 60000;
  const serve = (c) => Math.abs(Number(c.valor) - alvo.valor) < 0.005 && (alvo.tipo !== 'numero_extra' || Number(c.quantidade) === alvo.quantidade) && c.expira_em && new Date(c.expira_em).getTime() > limite;
  const usarPix = (pend || []).find(c => c.provedor === 'efi' && serve(c) && c.pix_copia_cola) || null;
  const usarCartao = (pend || []).find(c => c.provedor === 'asaas' && serve(c) && c.invoice_url) || null;
  await cancelar(db, (pend || []).filter(c => c !== usarPix && c !== usarCartao));

  const grupo = usarPix?.grupo || usarCartao?.grupo || crypto.randomUUID();
  const base = {
    grupo, mercearia_id: merceariaId, assinatura_id: alvo.assinatura.id, tipo: alvo.tipo,
    ciclo_inicio: alvo.tipo === 'mensalidade' ? alvo.ciclo_inicio : null,
    pacote_id: alvo.tipo === 'pacote' ? alvo.pacote.id : null, valor: alvo.valor, status: 'pendente',
    ...(alvo.tipo === 'numero_extra' ? { quantidade: alvo.quantidade } : {}),
  };
  const avisos = [];
  let pix = null, cartao = null;

  if (usarPix) pix = { copia_cola: usarPix.pix_copia_cola, qr_code: await qrDoPix(usarPix), expira_em: usarPix.expira_em };
  else {
    try {
      const r = await criarPix(db, base, mercearia);
      if (r.aviso) avisos.push(r.aviso);
      else if (r.cob.pix_copia_cola) pix = { copia_cola: r.cob.pix_copia_cola, qr_code: r.qr, expira_em: r.cob.expira_em };
    } catch (e) {
      console.error('[WHATSAPP COBRANÇA] criar Pix:', e.response?.data || e.message);
      avisos.push('Não foi possível gerar o Pix agora.');
    }
  }
  if (usarCartao) cartao = { url: usarCartao.invoice_url, expira_em: usarCartao.expira_em };
  else {
    try {
      const r = await criarCartao(db, base, mercearia, alvo.descricao);
      if (r.aviso) avisos.push(r.aviso);
      else if (r.cob.invoice_url) cartao = { url: r.cob.invoice_url, expira_em: r.cob.expira_em };
    } catch (e) {
      console.error('[WHATSAPP COBRANÇA] criar cartão:', e.message);
      avisos.push('Não foi possível gerar o pagamento por cartão agora.');
    }
  }
  if (!pix && !cartao) return { erro: 'Não foi possível gerar o pagamento agora. Tente de novo em instantes ou fale com o suporte.', http: 502 };
  return { grupo, tipo: alvo.tipo, motivo: alvo.motivo, valor: alvo.valor, descricao: alvo.descricao, pix, cartao, avisos, detalhe: alvo.detalhe || null };
}

/* ── Aplicar um pagamento confirmado ───────────────────────── */
async function buscar(db, provedor, cobrancaId) {
  const { data, error } = await db.from('whatsapp_cobrancas').select('*')
    .eq('provedor', provedor).eq('cobranca_id', cobrancaId).maybeSingle();
  if (error) throw new Error(`whatsapp_cobrancas: ${error.message}`);
  return data || null;
}

// Mensalidade do ciclo `cicloAlvo`: registra o pagamento e, se for o ciclo
// atual, libera os créditos. 'aplicado' | 'adiantado' | 'duplicado'
async function pagarCiclo(db, a, cicloAlvo, pag, autor, cobId) {
  try {
    await A.inserirPagamento(db, {
      ...pag, mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: cicloAlvo,
      referencia: 'mensalidade', registrado_por_nome: autor,
    });
  } catch (e) {
    if (e.codigo !== 'JA_PAGO') throw e;
    const existente = await A.pagamentoDoCiclo(db, a.id, cicloAlvo);
    // Já pago por outra via (outra cobrança, ou na mão pelo SuperAdmin)
    if (!existente || existente.cobranca_id !== cobId) return 'duplicado';
  }
  if (cicloAlvo !== a.ciclo_inicio) return 'adiantado';
  await A.creditarCiclo(db, a, `Créditos do ciclo (${a.plano_nome}) — pagamento ${W.FORMAS_PAGAMENTO[pag.forma] || pag.forma}`, autor);
  return 'aplicado';
}

async function resolver(db, cob, pag, autor) {
  const tz = await A.timezoneDaLoja(db, cob.mercearia_id);
  const hoje = hojeStrTZ(tz);
  const emDia = async (a) => (a && a.status === 'ativa' ? A.garantirCiclo(db, a, hoje) : a);
  const { data: a0 } = await db.from('whatsapp_assinaturas').select('*').eq('id', cob.assinatura_id).maybeSingle();

  if (cob.tipo === 'ativacao') {
    let a = a0;
    if (a && a.status === 'aguardando') {
      const ativa = await A.ativar(db, a, autor, pag);
      if (ativa) return { resultado: 'aplicado', assinatura: ativa };
      a = (await db.from('whatsapp_assinaturas').select('*').eq('id', cob.assinatura_id).maybeSingle()).data;
    }
    a = await emDia(a);
    if (!a || a.status !== 'ativa') return { resultado: 'sem_alvo' };
    // Já ativa: reprocessamento desta mesma cobrança, ou ativada na mão
    return { resultado: await pagarCiclo(db, a, a.ciclo_inicio, pag, autor, cob.id), assinatura: a };
  }

  if (cob.tipo === 'mensalidade') {
    const a = await emDia(a0);
    if (!a || a.status !== 'ativa') return { resultado: 'sem_alvo' };
    // Cobrança de um ciclo que já passou vale para o ciclo atual
    const alvo = cob.ciclo_inicio > a.ciclo_inicio ? A.somarDias(a.ciclo_fim, 1) : a.ciclo_inicio;
    // Renovação adiantada de um plano com cancelamento agendado: não aplica
    if (alvo !== a.ciclo_inicio && a.cancelar_no_fim) return { resultado: 'sem_alvo' };
    return { resultado: await pagarCiclo(db, a, alvo, pag, autor, cob.id), assinatura: a, ciclo: alvo };
  }

  if (cob.tipo === 'numero_extra') {
    const a = await emDia(a0);
    if (!a || a.status !== 'ativa') return { resultado: 'sem_alvo' };
    const qtd = Number(cob.quantidade) || 0;
    if (Number(a.numeros_extras_pedido) !== qtd) {
      // Pedido não está mais aberto: ou esta cobrança já foi aplicada
      // (reprocessamento), ou a loja desistiu / o SuperAdmin resolveu na mão.
      const { data: meu } = await db.from('whatsapp_pagamentos').select('id').eq('cobranca_id', cob.id).maybeSingle();
      return { resultado: meu ? 'aplicado' : 'sem_alvo', assinatura: a, quantidade: qtd };
    }
    try {
      await A.inserirPagamento(db, {
        ...pag, mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio,
        referencia: 'numero_extra', registrado_por_nome: autor,
        observacao: `${qtd} número${qtd === 1 ? '' : 's'} extra${qtd === 1 ? '' : 's'} — ${pag.observacao}`.slice(0, 300),
      });
    } catch (e) { if (e.codigo !== 'JA_PAGO') throw e; }   // já gravado por esta mesma cobrança
    const preco = precoNumeroExtra(a, await parametros(db));
    const { data, error } = await db.from('whatsapp_assinaturas')
      .update({ numeros_extras: (Number(a.numeros_extras) || 0) + qtd, numero_extra_preco: preco, numeros_extras_pedido: 0, numeros_extras_pedido_em: null, numeros_extras_pedido_por_nome: null, atualizado_em: new Date().toISOString() })
      .eq('id', a.id).eq('status', 'ativa').eq('numeros_extras_pedido', qtd).eq('numeros_extras', Number(a.numeros_extras) || 0).select();
    if (error) throw error;
    // Mudou no meio (outro processo): devolve pra fila e a próxima tentativa decide
    if (!data || !data.length) throw new Error('número extra: a assinatura mudou durante o pagamento');
    return { resultado: 'aplicado', assinatura: data[0], quantidade: qtd, preco };
  }

  // pacote
  const { data: pac0 } = await db.from('whatsapp_pacotes_compras').select('*').eq('id', cob.pacote_id).maybeSingle();
  if (!pac0) return { resultado: 'sem_alvo' };
  const { data: ativas } = await db.from('whatsapp_assinaturas').select('*').eq('mercearia_id', cob.mercearia_id).eq('status', 'ativa');
  const a = await emDia((ativas || [])[0] || null);
  let pac = pac0;
  if (pac.status === 'aguardando') {
    if (!a || a.status !== 'ativa') return { resultado: 'sem_alvo' };
    const { data } = await db.from('whatsapp_pacotes_compras')
      .update({ status: 'aprovado', resolvido_em: new Date().toISOString(), resolvido_por_nome: autor })
      .eq('id', pac.id).eq('status', 'aguardando').select();
    pac = (data && data[0]) || (await db.from('whatsapp_pacotes_compras').select('*').eq('id', pac.id).maybeSingle()).data || pac;
  }
  if (pac.status !== 'aprovado' || !a || a.status !== 'ativa') return { resultado: 'sem_alvo' };
  try {
    await A.inserirPagamento(db, {
      ...pag, mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio,
      referencia: 'pacote', pacote_id: pac.id, registrado_por_nome: autor,
    });
  } catch (e) {
    if (e.codigo !== 'JA_PAGO') throw e;
    const { data: existente } = await db.from('whatsapp_pagamentos').select('id, cobranca_id').eq('pacote_id', pac.id).maybeSingle();
    if (!existente || existente.cobranca_id !== cob.id) return { resultado: 'duplicado', pacote: pac };
  }
  await A.lancarUmaVez(db, {
    mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'pacote',
    quantidade: pac.creditos, pedido_id: pac.id, descricao: `Pacote extra: ${pac.nome}`, criado_por_nome: autor,
  });
  return { resultado: 'aplicado', assinatura: a, pacote: pac };
}

const TEXTO_TIPO = { ativacao: 'ativação do plano', mensalidade: 'mensalidade', pacote: 'pacote extra', numero_extra: 'número extra' };

// Aplica um pagamento confirmado. dados: { forma, valor_pago, taxa?, pagamento_ref?, evento? }
// Devolve { resultado }: aplicado | adiantado | ja_processado | duplicado |
// sem_alvo | valor_menor | ocupado. Erro de banco sobe (o webhook devolve
// 500 e o provedor reenvia — seguro, porque nada soma duas vezes).
async function confirmar(db, cob, dados) {
  if (cob.status === 'pago') return { resultado: 'ja_processado' };
  const autor = ORIGEM[cob.provedor];
  const via = NOME_PROVEDOR[cob.provedor];
  const valorPago = r2(dados.valor_pago);

  if (!Number.isFinite(Number(dados.valor_pago)) || valorPago + 0.009 < Number(cob.valor)) {
    if (cob.resultado !== 'valor_menor') {
      await db.from('whatsapp_cobrancas').update({ resultado: 'valor_menor', valor_pago: valorPago, atualizado_em: new Date().toISOString() }).eq('id', cob.id);
      auditar(cob, 'whatsapp_pagamento_alerta',
        `Pagamento do WhatsApp por ${via} de ${reais(valorPago)} é menor que o cobrado (${reais(cob.valor)}) — nada foi liberado. Confira no provedor (${cob.cobranca_id}).`,
        { motivo: 'valor_menor', valor_pago: valorPago }, 'admin_global');
    }
    return { resultado: 'valor_menor' };
  }

  // Trava: só um processo aplica (pendente/cancelada → processando)
  const agora = new Date().toISOString();
  let { data: travada } = await db.from('whatsapp_cobrancas')
    .update({ status: 'processando', atualizado_em: agora })
    .eq('id', cob.id).in('status', ['pendente', 'cancelada']).select();
  if (!travada || !travada.length) {
    const { data: atual } = await db.from('whatsapp_cobrancas').select('*').eq('id', cob.id).maybeSingle();
    if (!atual || atual.status === 'pago') return { resultado: 'ja_processado' };
    // "processando" parado há mais de 2 min = tentativa que caiu no meio: retoma
    const parado = atual.status === 'processando' && Date.now() - new Date(atual.atualizado_em).getTime() > 120000;
    if (!parado) return { resultado: 'ocupado' };
    ({ data: travada } = await db.from('whatsapp_cobrancas')
      .update({ status: 'processando', atualizado_em: agora })
      .eq('id', cob.id).eq('status', 'processando').eq('atualizado_em', atual.atualizado_em).select());
    if (!travada || !travada.length) return { resultado: 'ocupado' };
  }
  const eraCancelada = cob.status === 'cancelada';

  let r;
  let taxa;
  try {
    const p = await parametros(db);
    // Taxa real informada pelo provedor (cartão Asaas); sem ela, a taxa dos parâmetros
    const taxaReal = dados.taxa === null || dados.taxa === undefined ? NaN : Number(dados.taxa);
    taxa = Number.isFinite(taxaReal) && taxaReal >= 0 && taxaReal <= valorPago ? r2(taxaReal) : W.taxaRecebimento(p, dados.forma, valorPago);
    const tz = await A.timezoneDaLoja(db, cob.mercearia_id);
    const pag = {
      forma: dados.forma, valor_tabela: r2(cob.valor), valor_bruto: valorPago, taxa, valor_liquido: r2(valorPago - taxa),
      pago_em: hojeStrTZ(tz), observacao: `Pagamento automático — ${cob.provedor === 'efi' ? 'txid' : 'cobrança'} ${cob.cobranca_id}`.slice(0, 300),
      cobranca_id: cob.id,
    };
    r = await resolver(db, cob, pag, autor);
  } catch (e) {
    // Devolve a cobrança pra fila: a próxima notificação tenta de novo
    await db.from('whatsapp_cobrancas').update({ status: 'pendente', atualizado_em: new Date().toISOString() }).eq('id', cob.id).eq('status', 'processando');
    throw e;
  }

  await db.from('whatsapp_cobrancas').update({
    status: 'pago', resultado: r.resultado, valor_pago: valorPago, taxa, pagamento_ref: dados.pagamento_ref || null,
    evento: dados.evento || null, pago_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
  }).eq('id', cob.id);

  const meta = { valor: valorPago, taxa, liquido: r2(valorPago - taxa), resultado: r.resultado, pagamento_ref: dados.pagamento_ref || null };
  if (r.resultado === 'aplicado' || r.resultado === 'adiantado') {
    const a = r.assinatura || {};
    const txt = cob.tipo === 'numero_extra'
      ? `${r.quantidade} número${r.quantidade === 1 ? '' : 's'} extra${r.quantidade === 1 ? '' : 's'} de WhatsApp pago${r.quantidade === 1 ? '' : 's'} por ${via} e liberado${r.quantidade === 1 ? '' : 's'} na hora (agora ${a.numeros_extras || 0} extra${a.numeros_extras === 1 ? '' : 's'})`
      : cob.tipo === 'pacote'
      ? `Pacote extra de WhatsApp "${r.pacote?.nome || ''}" pago por ${via} — +${r.pacote?.creditos || 0} créditos liberados na hora`
      : cob.tipo === 'ativacao' && a.ciclo_inicio
        ? `Plano de WhatsApp "${a.plano_nome}" pago por ${via} e ativado na hora — ciclo ${dataBR(a.ciclo_inicio)} a ${dataBR(a.ciclo_fim)}, ${a.creditos} créditos`
        : r.resultado === 'adiantado'
          ? `Mensalidade do WhatsApp "${a.plano_nome}" paga adiantada por ${via} — os créditos entram em ${dataBR(r.ciclo)}, na renovação`
          : `Mensalidade do WhatsApp "${a.plano_nome}" paga por ${via} — ${a.creditos} créditos do ciclo liberados na hora`;
    auditar(cob, 'whatsapp_pagamento_automatico', `${txt}. Recebido ${reais(valorPago)}, taxa ${reais(taxa)}, líquido ${reais(valorPago - taxa)}.`, meta);
    // A outra forma do mesmo pedido (Pix ↔ cartão) deixa de valer
    const { data: irmas } = await db.from('whatsapp_cobrancas').select('*').eq('grupo', cob.grupo).eq('status', 'pendente');
    await cancelar(db, (irmas || []).filter(c => c.id !== cob.id));
  } else {
    const porque = r.resultado === 'duplicado'
      ? `${TEXTO_TIPO[cob.tipo]} já estava paga por outra via${eraCancelada ? ' (esta cobrança tinha sido cancelada)' : ''}`
      : `o pedido não está mais aberto (${TEXTO_TIPO[cob.tipo]} desistida, recusada ou plano encerrado)`;
    auditar(cob, 'whatsapp_pagamento_alerta',
      `Recebido ${reais(valorPago)} por ${via} do WhatsApp, mas NÃO foi aplicado: ${porque}. Devolva o valor ou aplique na mão (${cob.cobranca_id}).`,
      { ...meta, motivo: r.resultado }, 'admin_global');
  }
  return r;
}

// Devolução do Pix / estorno ou contestação do cartão: só alerta (uma vez).
async function estornar(db, cob, evento, detalhe) {
  const { data: atual } = await db.from('whatsapp_cobrancas').select('id, status, resultado, valor_pago').eq('id', cob.id).maybeSingle();
  if (!atual || atual.resultado === 'estornado') return { resultado: 'ja_processado' };
  await db.from('whatsapp_cobrancas')
    .update({ resultado: 'estornado', evento: evento || null, atualizado_em: new Date().toISOString() }).eq('id', cob.id);
  cob = { ...cob, status: atual.status, valor_pago: atual.valor_pago };
  auditar(cob, 'whatsapp_pagamento_alerta',
    `Pagamento do WhatsApp por ${NOME_PROVEDOR[cob.provedor]} (${TEXTO_TIPO[cob.tipo]}, ${reais(cob.valor_pago ?? cob.valor)}) foi ${detalhe || 'devolvido/estornado'} (${evento || 'estorno'}). ` +
    (cob.status === 'pago' ? 'Os créditos NÃO foram retirados sozinhos — revise a loja (ajuste de créditos, corrigir o pagamento ou encerrar o plano).' : 'Nada tinha sido liberado.'),
    { evento, motivo: 'estorno' }, 'admin_global');
  return { resultado: 'estornado' };
}

/* ── Entrada dos provedores (webhook e conferência) ────────── */
// cobApi = resposta de GET /v2/cob/:txid do Efí
async function receberPix(db, cob, cobApi, endToEndId) {
  if (cobApi?.status !== 'CONCLUIDA') return { resultado: 'nao_pago' };
  const pix = (cobApi.pix || []).find(x => x.endToEndId === endToEndId) || (cobApi.pix || [])[0];
  const valorPago = parseFloat(pix?.valor);
  const devolvido = (pix?.devolucoes || []).filter(d => d.status === 'DEVOLVIDO').reduce((s, d) => s + (parseFloat(d.valor) || 0), 0);
  if (devolvido > 0) {
    return estornar(db, cob, 'PIX_DEVOLVIDO', devolvido + 0.01 >= valorPago ? 'devolvido' : `devolvido em parte (${reais(devolvido)})`);
  }
  return confirmar(db, cob, { forma: 'pix_efi', valor_pago: valorPago, pagamento_ref: pix?.endToEndId || endToEndId, evento: 'PIX_RECEBIDO' });
}

// pag = resposta de GET /payments/:id do Asaas
async function receberAsaas(db, cob, pag, evento) {
  if (!STATUS_PAGO_ASAAS.includes(pag?.status)) return { resultado: 'nao_pago' };
  const valor = Number(pag.value);
  const liquido = Number(pag.netValue);
  const taxa = Number.isFinite(liquido) && liquido > 0 && liquido <= valor ? r2(valor - liquido) : null;
  return confirmar(db, cob, { forma: 'cartao_asaas', valor_pago: valor, taxa, pagamento_ref: pag.id, evento: evento || pag.status });
}

// Conferência pela tela (reserva do webhook): olha o provedor no máximo a
// cada 12 s por cobrança.
const ultimaConsulta = new Map();
async function conferir(db, merceariaId, grupo) {
  const { data: cobs, error } = await db.from('whatsapp_cobrancas').select('*').eq('grupo', grupo).eq('mercearia_id', merceariaId);
  if (error) throw error;
  if (!cobs || !cobs.length) return null;
  const pronto = (lista) => {
    const paga = lista.find(c => c.status === 'pago');
    const agora = Date.now();
    return {
      pago: !!paga, resultado: paga?.resultado || null,
      aberta: lista.some(c => c.status === 'pendente' && (!c.expira_em || new Date(c.expira_em).getTime() > agora)),
    };
  };
  if (cobs.some(c => c.status === 'pago')) return pronto(cobs);
  // "processando" entra pra retomar uma tentativa que caiu no meio
  for (const c of cobs.filter(x => x.status === 'pendente' || x.status === 'processando')) {
    const ult = ultimaConsulta.get(c.id) || 0;
    if (Date.now() - ult < 12000) continue;
    ultimaConsulta.set(c.id, Date.now());
    if (ultimaConsulta.size > 5000) ultimaConsulta.clear();
    try {
      if (c.provedor === 'efi') {
        const r = await efi().efiPixRequest('GET', `/v2/cob/${encodeURIComponent(c.cobranca_id)}`);
        await receberPix(db, c, r.data);
      } else {
        const as = asaas();
        const resp = await fetch(`${as.url}/payments/${encodeURIComponent(c.cobranca_id)}`, { headers: as.headers() });
        const pag = await resp.json().catch(() => ({}));
        if (resp.ok && pag?.id && REF_ASAAS.exec(pag.externalReference || '')?.[1] === c.id) await receberAsaas(db, c, pag, 'CONFERENCIA');
      }
    } catch (e) {
      console.warn(`[WHATSAPP COBRANÇA] conferir ${c.provedor} ${c.cobranca_id}:`, e.response?.data?.nome || e.message);
    }
  }
  const { data: depois } = await db.from('whatsapp_cobrancas').select('*').eq('grupo', grupo).eq('mercearia_id', merceariaId);
  return pronto(depois || cobs);
}

module.exports = {
  REF_ASAAS, STATUS_PAGO_ASAAS, CARTAO_MINIMO,
  parametros, valorNumeroExtra, alvoDaLoja, gerar, cancelarPendentes, buscar, confirmar, estornar, alertar, receberPix, receberAsaas, conferir,
};
