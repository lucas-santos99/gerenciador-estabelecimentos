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
// ============================================================
const crypto = require('crypto');
const { TIMEZONE_PADRAO, hojeStrTZ } = require('./fusoHorario');

/* ── Termos (mudou o texto → mudar a versão; o aceite registra a versão) ── */
// 01/10/2026: entrou a regra das "mensagens sem consulta" (respostas a oi,
// ok, obrigado, menu…), que só vale pra loja que aceitou esta versão.
const TERMOS_VERSAO_CONVERSA = '2026-10-01';
const TERMOS = Object.freeze({
  versao: '2026-10-01',
  novidades: 'Respostas do assistente a mensagens que não pedem dados (como “oi”, “ok”, “obrigado” ou pedir o menu de novo) passam a gastar crédito depois de algumas grátis por dia. As respostas mostram sempre o saldo que sobrou.',
  titulo: 'Termos do serviço de WhatsApp',
  secoes: [
    { t: 'O que é', p: [
      'Um serviço adicional em que o seu estabelecimento conversa com o sistema pelo WhatsApp: alertas automáticos e, conforme o plano, perguntas, relatórios em PDF, cadastros e leitura de fotos.',
      'É um atendimento automático do sistema. Para falar com uma pessoa, use o contato de suporte informado pelo próprio robô.',
    ] },
    { t: 'Créditos', p: [
      'Cada plano dá um saldo de créditos por ciclo mensal. Cada pedido completo gasta créditos conforme o tipo (tabela mostrada antes da contratação). Confirmações, PIN e até 3 correções dentro do mesmo pedido não gastam de novo.',
      'Mensagens que você envia não gastam crédito; o que gasta é a resposta do assistente. Pedido que dá erro ou mensagem que não é entregue também não gasta.',
      'Respostas a mensagens que não pedem dados (como “oi”, “ok”, “obrigado”, pedir o menu de novo ou algo que o assistente não entendeu) são grátis até um limite por dia, por número; depois disso, cada uma gasta a quantidade de créditos mostrada na tabela de créditos. Ver o saldo, “produto não encontrado” e “sem permissão” não gastam.',
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
      'Nesta fase de lançamento, a ativação e a cobrança do plano são combinadas diretamente com a nossa equipe.',
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
      const { data } = await db.from('whatsapp_assinaturas')
        .update({ ciclo_inicio: novoInicio, ciclo_fim: novoFim, atualizado_em: agoraIso })
        .eq('id', a.id).eq('status', 'ativa').eq('ciclo_inicio', a.ciclo_inicio).select();
      if (data && data.length) {
        if (saldo > 0) await lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: a.ciclo_inicio, tipo: 'expirado', quantidade: -saldo, descricao: 'Fim do ciclo — créditos não acumulam' });
        await lancar(db, { mercearia_id: a.mercearia_id, assinatura_id: a.id, ciclo_inicio: novoInicio, tipo: 'credito_ciclo', quantidade: a.creditos, descricao: `Créditos do ciclo (${a.plano_nome})` });
        a = data[0];
        continue;
      }
    }
    // Outro pedido virou o ciclo ao mesmo tempo: relê e segue.
    const { data: atual } = await db.from('whatsapp_assinaturas').select('*').eq('id', a.id).maybeSingle();
    a = atual;
  }
  return a;
}

// Ativa uma assinatura "aguardando". Se for troca de plano, encerra a
// anterior (o saldo dela expira). Devolve a assinatura ativa.
async function ativar(db, assinatura, autorNome) {
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

  const { data, error } = await db.from('whatsapp_assinaturas')
    .update({ status: 'ativa', ativado_em: agoraIso, ativado_por_nome: autorNome, ciclo_inicio: hoje, ciclo_fim: fimDoCiclo(hoje), cancelar_no_fim: false, atualizado_em: agoraIso })
    .eq('id', assinatura.id).eq('status', 'aguardando').select();
  if (error) throw error;
  if (!data || !data.length) return null;
  await lancar(db, { mercearia_id: assinatura.mercearia_id, assinatura_id: assinatura.id, ciclo_inicio: hoje, tipo: 'credito_ciclo', quantidade: assinatura.creditos, descricao: `Créditos do ciclo (${assinatura.plano_nome})`, criado_por_nome: autorNome });
  return data[0];
}

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
  timezoneDaLoja, resumoCiclo, lancar, garantirCiclo, ativar, encerrarAgora,
};
