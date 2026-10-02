// utils/whatsappAssinaturas.js
// ============================================================
// WhatsApp — plano contratado pela loja (29/09/2026).
// Regras do ciclo mensal, saldo de créditos e termos de contratação,
// usadas pelas rotas da loja (/api/whatsapp/loja) e do SuperAdmin
// (/api/whatsapp/admin/assinaturas).
//
//   - Nesta fase a loja SOLICITA o plano e o SuperAdmin master ATIVA
//     (a cobrança é combinada à parte). Somar na mensalidade Pix/cartão
//     fica pra quando o serviço for pro ar.
//   - Ciclo: do dia da ativação até a véspera do mesmo dia do mês
//     seguinte, no fuso da loja. Na virada, o que sobrou expira (créditos
//     não acumulam) e entra o saldo do novo ciclo. A virada é feita
//     "sob demanda" — na primeira leitura depois do fim do ciclo —, com
//     trava otimista (só quem ainda vê o ciclo antigo consegue virar).
//   - Saldo do ciclo = soma de whatsapp_creditos_mov.quantidade com o
//     mesmo ciclo_inicio (entradas positivas, consumo negativo).
//   - (01/10/2026, SQL 18) O ciclo novo só libera os créditos depois do
//     PAGAMENTO: na virada fica `aguardando_pagamento_desde` = início do
//     ciclo novo, sem créditos, até o SuperAdmin registrar o pagamento
//     (whatsapp_pagamentos, com forma, taxa e valor líquido). A ativação e
//     o pacote extra também registram o pagamento.
//   - (02/10/2026, SQL 19) A loja paga por Pix (Efí) ou cartão (Asaas) na
//     própria tela; o pagamento confirmado registra tudo sozinho
//     (utils/whatsappCobrancas.js). Dá pra pagar a renovação alguns dias
//     antes: o pagamento fica guardado pro ciclo seguinte e, na virada, os
//     créditos entram na hora (garantirCiclo → liberarSePago).
// ============================================================
const crypto = require('crypto');
const { TIMEZONE_PADRAO, hojeStrTZ } = require('./fusoHorario');
const W = require('./whatsappCustos');

/* ── Termos (mudou o texto → mudar a versão; o aceite registra a versão) ── */
// 01/10/2026: entrou a regra das "mensagens sem consulta" (respostas a oi,
// ok, obrigado, menu…), que só vale pra loja que aceitou esta versão.
const TERMOS_VERSAO_CONVERSA = '2026-10-01';
const TERMOS = Object.freeze({
  versao: '2026-10-02b',
  novidades: 'Número extra pode ser comprado a qualquer hora: você paga na hora só o proporcional aos dias que faltam do ciclo e ele é liberado assim que o pagamento é confirmado. O pagamento do plano, da mensalidade e dos pacotes extras passa a ser feito por Pix ou cartão na própria tela do WhatsApp, com liberação automática quando o pagamento é confirmado. Os créditos de cada ciclo novo entram quando o pagamento da mensalidade do WhatsApp é confirmado (até lá, o assistente fica aguardando o pagamento). Respostas a mensagens que não pedem dados (como “oi”, “ok” ou “obrigado”) gastam crédito depois de algumas grátis por dia na loja, e toda resposta mostra o saldo. Números de WhatsApp extras têm valor mensal por número.',
  titulo: 'Termos do serviço de WhatsApp',
  secoes: [
    { t: 'O que é', p: [
      'Um serviço adicional em que o seu estabelecimento conversa com o sistema pelo WhatsApp: alertas automáticos e, conforme o plano, perguntas, relatórios em PDF, cadastros e leitura de fotos.',
      'É um atendimento automático do sistema. Para falar com uma pessoa, use o contato de suporte informado pelo próprio robô.',
    ] },
    { t: 'Créditos', p: [
      'Cada plano dá um saldo de créditos por ciclo mensal. Cada pedido completo gasta créditos conforme o tipo (tabela mostrada antes da contratação). Confirmações, PIN e até 3 correções dentro do mesmo pedido não gastam de novo.',
      'Mensagens que você envia não gastam crédito; o que gasta é a resposta do assistente. Pedido que dá erro ou mensagem que não é entregue também não gasta.',
      'Respostas a mensagens que não pedem dados (como “oi”, “ok”, “obrigado”, pedir o menu de novo ou algo que o assistente não entendeu) são grátis até um limite por dia na loja (somando todos os números); depois disso, cada uma gasta a quantidade de créditos mostrada na tabela de créditos. Ver o saldo, “produto não encontrado” e “sem permissão” não gastam.',
      'Cada resposta mostra quantos créditos usou e o saldo que sobrou.',
      'Créditos que sobram no fim do ciclo não passam para o ciclo seguinte.',
    ] },
    { t: 'Quando o saldo acaba', p: [
      'O assistente e os alertas pausam até o próximo ciclo ou até você comprar um pacote extra. Nunca há cobrança extra automática.',
      'Para proteger o serviço, o assistente pode ser pausado em caso de uso fora do normal (por exemplo, volume anormal de mensagens), independentemente do saldo.',
    ] },
    { t: 'Preço, reajuste e cancelamento', p: [
      'O preço contratado vale para o seu ciclo. Reajustes são avisados com pelo menos 30 dias de antecedência e só valem a partir do ciclo seguinte; você pode cancelar antes.',
      'Você pode cancelar quando quiser: o serviço segue até o fim do ciclo já iniciado.',
      'O ciclo renova todo mês na mesma data. Os créditos do ciclo novo entram assim que o pagamento da mensalidade do WhatsApp for confirmado; até lá, o assistente avisa que está aguardando o pagamento. O ciclo não muda de data por causa de atraso.',
      'Cada plano inclui uma quantidade de números de WhatsApp. Números extras, quando disponíveis, têm valor mensal por número (mostrado antes de pedir), somado à mensalidade do plano enquanto estiverem ativos. Todos os números da loja usam o mesmo saldo de créditos.',
      'Número extra comprado no meio do ciclo: você paga na hora só o valor proporcional aos dias que faltam até a renovação, e ele é liberado quando o pagamento é confirmado. A partir da mensalidade seguinte entra o valor mensal cheio. Ao retirar um número extra, o que já foi pago no ciclo não é devolvido.',
      'O pagamento é feito por Pix ou cartão na própria tela do WhatsApp do sistema. O plano, os créditos do ciclo e os pacotes extras são liberados automaticamente quando o pagamento é confirmado. A mensalidade do ciclo seguinte pode ser paga alguns dias antes da renovação; nada é debitado sem você pagar.',
    ] },
    { t: 'Seus dados', p: [
      'O sistema só responde com dados do seu próprio estabelecimento e respeita as permissões de cada pessoa vinculada. Toda ação feita pelo WhatsApp fica registrada na auditoria.',
      'Só números cadastrados e confirmados por você recebem mensagens. Responder PARAR interrompe o envio de alertas para aquele número.',
    ] },
  ],
});

/* ── Datas (AAAA-MM-DD, sem fuso) ─────────────────────────── */
function somarDias(dataStr, n) {
  const d = new Date(`${dataStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Fim do ciclo = véspera do mesmo dia no mês seguinte (31/01 → 27/02 em
// ano não bissexto: 28/02 é o "mesmo dia" possível, véspera 27/02).
function fimDoCiclo(inicioStr) {
  const [a, m, d] = inicioStr.split('-').map(Number);
  const ano = m === 12 ? a + 1 : a;
  const mes = m === 12 ? 1 : m + 1;
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const alvo = `${ano}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
  return somarDias(alvo, -1);
}

/* ── Telefone ─────────────────────────────────────────────── */
// Aceita "(53) 99123-4567", "53991234567", "+55 53 99123-4567"…
// Devolve "5553991234567" ou null.
function normalizarTelefone(v) {
  let s = String(v || '').replace(/\D/g, '');
  if (s.length === 10 || s.length === 11) s = `55${s}`;
  return /^55[1-9][0-9]{9,10}$/.test(s) ? s : null;
}
function formatarTelefone(t) {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(String(t || ''));
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(t || '');
}

/* ── Código de vínculo (6 dígitos; guardamos só o hash) ───── */
const CODIGO_VALIDADE_HORAS = 24;
function gerarCodigo() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCodigo(codigo, telefone) {
  return crypto.createHash('sha256').update(`${codigo}:${telefone}`).digest('hex');
}

/* ── Números e valor mensal (01/10/2026) ──────────────────── */
// Números que a loja pode cadastrar = os do plano + os extras aprovados
function limiteNumeros(a) {
  return a ? (Number(a.numeros) || 1) + (Number(a.numeros_extras) || 0) : 0;
}
// Mensalidade do WhatsApp = plano + extras × preço travado por número
function valorMensal(a) {
  if (!a) return 0;
  const extras = (Number(a.numeros_extras) || 0) * (Number(a.numero_extra_preco) || 0);
  return Math.round(((Number(a.preco) || 0) + extras) * 100) / 100;
}

/* ── Saldo / ciclo ────────────────────────────────────────── */
async function timezoneDaLoja(db, merceariaId) {
  const { data } = await db.from('mercearias').select('timezone').eq('id', merceariaId).maybeSingle();
  return data?.timezone || TIMEZONE_PADRAO;
}

// { saldo, entradas, usados } do ciclo `cicloInicio` da assinatura
async function resumoCiclo(db, assinaturaId, cicloInicio) {
  const { data } = await db.from('whatsapp_creditos_mov')
    .select('tipo, quantidade, pedido_tipo')
    .eq('assinatura_id', assinaturaId).eq('ciclo_inicio', cicloInicio);
  let saldo = 0, entradas = 0, usados = 0;
  // 30/09/2026: uso do ciclo por tipo de pedido (pergunta, PDF, alerta...),
  // pra loja ver onde gastou. Estorno abate do tipo de pedido dele.
  const porPedido = {};
  (data || []).forEach(m => {
    const q = Number(m.quantidade) || 0;
    saldo += q;
    if (q > 0 && m.tipo !== 'estorno') entradas += q;
    if (m.tipo === 'consumo') usados += -q;
    if (m.tipo === 'estorno') usados -= q;
    if ((m.tipo === 'consumo' || m.tipo === 'estorno') && m.pedido_tipo) {
      const p = porPedido[m.pedido_tipo] || (porPedido[m.pedido_tipo] = { pedidos: 0, creditos: 0 });
      if (m.tipo === 'consumo') p.pedidos++; else p.pedidos = Math.max(0, p.pedidos - 1);
      p.creditos += -q;
    }
  });
  const r = (x) => Math.round(x * 100) / 100;
  const por_pedido = Object.fromEntries(Object.entries(porPedido)
    .map(([k, v]) => [k, { pedidos: v.pedidos, creditos: r(Math.max(0, v.creditos)) }])
    .filter(([, v]) => v.pedidos > 0 || v.creditos > 0));
  return { saldo: r(saldo), entradas: r(entradas), usados: r(Math.max(0, usados)), por_pedido };
}

async function lancar(db, mov) {
  const { error } = await db.from('whatsapp_creditos_mov').insert(mov);
  if (error) throw error;
}
// Igual ao lancar, mas "já existe" (índice único do SQL 19: créditos do
// ciclo e de pacote só entram uma vez) não é erro. Devolve true se lançou.
async function lancarUmaVez(db, mov) {
  const { error } = await db.from('whatsapp_creditos_mov').insert(mov);
  if (error && error.code === '23505') return false;
  if (error) throw error;
  return true;
}

// Libera os créditos do ciclo atual (uma vez só) e tira o "aguardando
// pagamento". Devolve a assinatura atualizada.
async function creditarCiclo(db, a, descricao, autorNome) {
  await lancarUmaVez(db, {
    mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'credito_ciclo',
    quantidade: a.creditos, descricao: String(descricao || `Créditos do ciclo (${a.plano_nome})`).slice(0, 300), criado_por_nome: autorNome || null,
  });
  if (!a.aguardando_pagamento_desde) return a;
  const { data } = await db.from('whatsapp_assinaturas')
    .update({ aguardando_pagamento_desde: null, atualizado_em: new Date().toISOString() })
    .eq('id', a.id).eq('ciclo_inicio', a.ciclo_inicio).select();
  return (data && data[0]) || { ...a, aguardando_pagamento_desde: null };
}

// Mensalidade registrada para um ciclo desta assinatura (ou null)
async function pagamentoDoCiclo(db, assinaturaId, cicloInicio) {
  const { data } = await db.from('whatsapp_pagamentos').select('*')
    .eq('assinatura_id', assinaturaId).eq('ciclo_inicio', cicloInicio).eq('referencia', 'mensalidade').maybeSingle();
  return data || null;
}

// Ciclo aguardando pagamento que JÁ tem a mensalidade registrada (paga
// adiantada antes da virada): libera os créditos na hora.
async function liberarSePago(db, a) {
  if (!aguardandoPagamento(a)) return a;
  const pg = await pagamentoDoCiclo(db, a.id, a.ciclo_inicio);
  if (!pg) return a;
  return creditarCiclo(db, a, `Créditos do ciclo (${a.plano_nome}) — pagamento adiantado ${W.FORMAS_PAGAMENTO[pg.forma] || pg.forma}`, pg.registrado_por_nome);
}

// Vira o(s) ciclo(s) vencido(s) de uma assinatura ativa. Devolve a
// assinatura atualizada (ou a mesma, se nada mudou).
async function garantirCiclo(db, assinatura, hojeStr) {
  let a = assinatura;
  for (let volta = 0; volta < 24 && a && a.status === 'ativa' && a.ciclo_fim && hojeStr > a.ciclo_fim; volta++) {
    const { saldo } = await resumoCiclo(db, a.id, a.ciclo_inicio);
    const agoraIso = new Date().toISOString();
    if (a.cancelar_no_fim) {
      const { data } = await db.from('whatsapp_assinaturas')
        .update({ status: 'cancelada', encerrado_em: agoraIso, encerrado_por_nome: 'Sistema (fim do ciclo)', atualizado_em: agoraIso })
        .eq('id', a.id).eq('status', 'ativa').eq('ciclo_inicio', a.ciclo_inicio).select();
      if (data && data.length) {
        if (saldo > 0) await lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'expirado', quantidade: -saldo, descricao: 'Fim do ciclo (plano cancelado)' });
        return data[0];
      }
    } else {
      const novoInicio = somarDias(a.ciclo_fim, 1);
      const novoFim = fimDoCiclo(novoInicio);
      // (01/10) Créditos do ciclo novo só depois do pagamento (registrarPagamentoCiclo)
      const { data } = await db.from('whatsapp_assinaturas')
        .update({ ciclo_inicio: novoInicio, ciclo_fim: novoFim, aguardando_pagamento_desde: novoInicio, atualizado_em: agoraIso })
        .eq('id', a.id).eq('status', 'ativa').eq('ciclo_inicio', a.ciclo_inicio).select();
      if (data && data.length) {
        if (saldo > 0) await lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'expirado', quantidade: -saldo, descricao: 'Fim do ciclo — créditos não acumulam' });
        a = data[0];
        continue;
      }
    }
    // Outro pedido virou o ciclo ao mesmo tempo: relê e segue.
    const { data: atual } = await db.from('whatsapp_assinaturas').select('*').eq('id', a.id).maybeSingle();
    a = atual;
  }
  // (02/10) Mensalidade paga adiantada → créditos na virada, sem esperar
  return liberarSePago(db, a);
}

// Ativa uma assinatura "aguardando". Se for troca de plano, encerra a
// anterior (o saldo dela expira). Devolve a assinatura ativa.
async function ativar(db, assinatura, autorNome, pagamento) {
  const tz = await timezoneDaLoja(db, assinatura.mercearia_id);
  const hoje = hojeStrTZ(tz);
  const agoraIso = new Date().toISOString();

  const { data: anterior } = await db.from('whatsapp_assinaturas').select('*')
    .eq('mercearia_id', assinatura.mercearia_id).eq('status', 'ativa').maybeSingle();
  if (anterior) {
    const { saldo } = await resumoCiclo(db, anterior.id, anterior.ciclo_inicio);
    const { error } = await db.from('whatsapp_assinaturas')
      .update({ status: 'substituida', encerrado_em: agoraIso, encerrado_por_nome: autorNome, atualizado_em: agoraIso })
      .eq('id', anterior.id).eq('status', 'ativa');
    if (error) throw error;
    if (saldo > 0) await lancar(db, { mercearia_id: anterior.mercearia_id, assinatura_id: anterior.id, ciclo_inicio: anterior.ciclo_inicio, tipo: 'expirado', quantidade: -saldo, descricao: `Troca de plano para ${assinatura.plano_nome}` });
    // Pacotes pendentes do plano antigo passam pro novo
    await db.from('whatsapp_pacotes_compras').update({ assinatura_id: assinatura.id })
      .eq('assinatura_id', anterior.id).eq('status', 'aguardando');
  }

  // Troca de plano: os números extras (e o preço travado deles) continuam
  const extras = anterior ? {
    numeros_extras: anterior.numeros_extras || 0, numero_extra_preco: anterior.numero_extra_preco ?? null,
    numeros_extras_pedido: anterior.numeros_extras_pedido || 0, numeros_extras_pedido_em: anterior.numeros_extras_pedido_em || null,
    numeros_extras_pedido_por_nome: anterior.numeros_extras_pedido_por_nome || null,
  } : {};
  const { data, error } = await db.from('whatsapp_assinaturas')
    .update({ status: 'ativa', ativado_em: agoraIso, ativado_por_nome: autorNome, ciclo_inicio: hoje, ciclo_fim: fimDoCiclo(hoje), cancelar_no_fim: false, aguardando_pagamento_desde: null, atualizado_em: agoraIso, ...extras })
    .eq('id', assinatura.id).eq('status', 'aguardando').select();
  if (error) throw error;
  if (!data || !data.length) return null;
  // (01/10) Pagamento do primeiro ciclo
  if (pagamento) {
    await inserirPagamento(db, {
      ...pagamento, mercearia_id: assinatura.mercearia_id, assinatura_id: assinatura.id,
      ciclo_inicio: hoje, referencia: 'mensalidade', registrado_por_nome: autorNome,
    });
  }
  await lancarUmaVez(db, { mercearia_id: assinatura.mercearia_id, assinatura_id: assinatura.id, ciclo_inicio: hoje, tipo: 'credito_ciclo', quantidade: assinatura.creditos, descricao: `Créditos do ciclo (${assinatura.plano_nome})`, criado_por_nome: autorNome });
  return data[0];
}

/* ── Pagamentos (01/10/2026, SQL 18) ──────────────────────── */
// Monta o pagamento a partir do que o SuperAdmin informou.
//   forma: W.FORMAS_PAGAMENTO (menos 'nao_informado')
//   valor: o que a loja pagou (padrão = valor de tabela); cortesia/teste → 0
//   taxa:  opcional; sem ela usa a taxa estimada da forma (parâmetros)
// Devolve { erro } ou o objeto pronto pra gravar.
function montarPagamento(params, { forma, valor, taxa, pago_em, observacao } = {}, valorTabela, hojeStr) {
  if (!Object.prototype.hasOwnProperty.call(W.FORMAS_PAGAMENTO, forma) || forma === 'nao_informado') {
    return { erro: 'Escolha a forma de pagamento.' };
  }
  const lerValor = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const t = String(v).trim();
    // "1.234,56" (BR) ou "29.90"/29.9
    const n = typeof v === 'number' ? v : parseFloat(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };
  const tabela = Math.round((Number(valorTabela) || 0) * 100) / 100;
  let bruto = W.FORMAS_SEM_RECEITA.includes(forma) ? 0 : lerValor(valor);
  if (bruto === null) bruto = tabela;
  if (!Number.isFinite(bruto) || bruto < 0 || bruto > 100000) return { erro: 'Valor recebido inválido.' };
  let tx = lerValor(taxa);
  if (tx === null) tx = W.taxaRecebimento(params, forma, bruto);
  if (!Number.isFinite(tx) || tx < 0 || tx > bruto) return { erro: 'A taxa precisa ficar entre zero e o valor recebido.' };
  let data = String(pago_em || '').slice(0, 10);
  if (!data) data = hojeStr;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data > somarDias(hojeStr, 1) || data < somarDias(hojeStr, -370)) {
    return { erro: 'Data do pagamento inválida.' };
  }
  return {
    forma, valor_tabela: tabela, valor_bruto: bruto, taxa: Math.round(tx * 100) / 100,
    valor_liquido: Math.round((bruto - tx) * 100) / 100, pago_em: data,
    observacao: String(observacao || '').trim().slice(0, 300) || null,
  };
}

async function inserirPagamento(db, reg) {
  const { data, error } = await db.from('whatsapp_pagamentos').insert(reg).select().maybeSingle();
  if (error) {
    if (error.code === '23505') { const e = new Error('Esse pagamento já foi registrado.'); e.codigo = 'JA_PAGO'; throw e; }
    throw error;
  }
  return data;
}

// Registra a mensalidade do ciclo que está aguardando pagamento e libera os
// créditos. Devolve { assinatura, pagamento } ou null se não estava aguardando.
async function registrarPagamentoCiclo(db, a, pagamento, autorNome) {
  if (!a || a.status !== 'ativa' || !a.aguardando_pagamento_desde || a.aguardando_pagamento_desde !== a.ciclo_inicio) return null;
  const pag = await inserirPagamento(db, {
    ...pagamento, mercearia_id: a.mercearia_id, assinatura_id: a.id,
    ciclo_inicio: a.ciclo_inicio, referencia: 'mensalidade', registrado_por_nome: autorNome,
  });
  const atual = await creditarCiclo(db, a, `Créditos do ciclo (${a.plano_nome}) — pagamento ${W.FORMAS_PAGAMENTO[pagamento.forma] || pagamento.forma}`, autorNome);
  return { assinatura: atual, pagamento: pag };
}

const aguardandoPagamento = (a) => !!(a && a.status === 'ativa' && a.aguardando_pagamento_desde && a.aguardando_pagamento_desde === a.ciclo_inicio);

// Encerra na hora (o saldo expira).
async function encerrarAgora(db, assinatura, autorNome, motivo) {
  const agoraIso = new Date().toISOString();
  const { saldo } = assinatura.ciclo_inicio ? await resumoCiclo(db, assinatura.id, assinatura.ciclo_inicio) : { saldo: 0 };
  const { data, error } = await db.from('whatsapp_assinaturas')
    .update({ status: 'cancelada', encerrado_em: agoraIso, encerrado_por_nome: autorNome, motivo: motivo || null, atualizado_em: agoraIso })
    .eq('id', assinatura.id).eq('status', 'ativa').select();
  if (error) throw error;
  if (!data || !data.length) return null;
  if (saldo > 0) await lancar(db, { mercearia_id: assinatura.mercearia_id, assinatura_id: assinatura.id, ciclo_inicio: assinatura.ciclo_inicio, tipo: 'expirado', quantidade: -saldo, descricao: 'Plano encerrado', criado_por_nome: autorNome });
  await db.from('whatsapp_pacotes_compras').update({ status: 'recusado', resolvido_em: agoraIso, resolvido_por_nome: autorNome, motivo: 'Plano encerrado' })
    .eq('assinatura_id', assinatura.id).eq('status', 'aguardando');
  return data[0];
}

module.exports = {
  TERMOS, TERMOS_VERSAO_CONVERSA, CODIGO_VALIDADE_HORAS,
  somarDias, fimDoCiclo, normalizarTelefone, formatarTelefone, gerarCodigo, hashCodigo,
  timezoneDaLoja, resumoCiclo, lancar, garantirCiclo, ativar, encerrarAgora, limiteNumeros, valorMensal,
  montarPagamento, inserirPagamento, registrarPagamentoCiclo, aguardandoPagamento,
  lancarUmaVez, creditarCiclo, pagamentoDoCiclo, liberarSePago,
};
