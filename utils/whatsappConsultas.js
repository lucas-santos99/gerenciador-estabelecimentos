// utils/whatsappConsultas.js
// ============================================================
// WhatsApp — consultas do menu (30/09/2026).
// Cada função lê o banco da PRÓPRIA loja (sempre .eq('mercearia_id'))
// e devolve o texto pronto da resposta. Nada aqui envia mensagem nem
// debita crédito — isso é do utils/whatsappAssistente.js.
//
// Regra de ouro (doc do Projeto): número na resposta vem sempre do banco
// e a resposta diz o que foi consultado (período, produto), pra quem
// perguntou perceber na hora se foi mal entendido.
// ============================================================
const db = require('../db/supabaseAdmin');
const { hojeStrTZ, inicioDiaTZ } = require('./fusoHorario');

/* ── Formatação ─────────────────────────────────────────────── */
const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const inteiro = (v) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
function qtd(v, unidade) {
  const n = Number(v) || 0;
  if (String(unidade || '').toLowerCase() === 'kg') {
    return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
  }
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} un`;
}
function fmtData(dataStr) {
  const [a, m, d] = String(dataStr).split('-');
  return a && m && d ? `${d}/${m}` : String(dataStr);
}
function somarDias(dataStr, n) {
  const d = new Date(`${dataStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diasEntre(deStr, ateStr) {
  return Math.round((Date.parse(`${ateStr}T12:00:00Z`) - Date.parse(`${deStr}T12:00:00Z`)) / 86400000);
}
function dataStrTZ(instante, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instante));
}
function horaTZ(tz) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
}
// "coca-côla Zero" → "coca cola zero"
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const ROTULO_MEIO = { Credito: 'Crédito', Debito: 'Débito', Cartao: 'Cartão' };
const rotuloMeio = (m) => ROTULO_MEIO[m] || m || 'Outros';

// Lê todas as linhas de uma consulta, de 1000 em 1000 (limite do Supabase)
async function todas(montar, max = 20000) {
  const out = [];
  for (let de = 0; de < max; de += 1000) {
    const { data, error } = await montar().range(de, de + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/* ── Vendas ─────────────────────────────────────────────────── */
const PERIODOS = {
  vendas_hoje:  { titulo: 'Vendas de hoje' },
  vendas_ontem: { titulo: 'Vendas de ontem' },
  vendas_7d:    { titulo: 'Vendas dos últimos 7 dias' },
  vendas_mes:   { titulo: 'Vendas do mês' },
};

function intervalo(chave, tz) {
  const hoje = hojeStrTZ(tz);
  if (chave === 'vendas_ontem') { const o = somarDias(hoje, -1); return { de: o, ate: o }; }
  if (chave === 'vendas_7d') return { de: somarDias(hoje, -6), ate: hoje };
  if (chave === 'vendas_mes') return { de: `${hoje.slice(0, 8)}01`, ate: hoje };
  return { de: hoje, ate: hoje };
}

async function vendas(mid, tz, chave) {
  const { de, ate } = intervalo(chave, tz);
  const inicio = inicioDiaTZ(de, tz).toISOString();
  const fim = inicioDiaTZ(somarDias(ate, 1), tz).toISOString(); // até o fim do dia (exclusivo)
  const lista = await todas(() => db.from('vendas')
    .select('id, valor_total, meio_pagamento, data_venda')
    .eq('mercearia_id', mid).neq('status', 'cancelada')
    .gte('data_venda', inicio).lt('data_venda', fim)
    .order('data_venda', { ascending: true }));

  const total = lista.reduce((s, v) => s + (Number(v.valor_total) || 0), 0);
  const porMeio = {};
  const soma = (m, v) => { const k = rotuloMeio(m); porMeio[k] = (porMeio[k] || 0) + (Number(v) || 0); };

  // Venda dividida: abre as fatias (pagamentos_venda)
  const divididas = lista.filter(v => v.meio_pagamento === 'Dividido').map(v => v.id);
  const fatiasPorVenda = {};
  for (let i = 0; i < divididas.length; i += 200) {
    const { data, error } = await db.from('pagamentos_venda').select('venda_id, meio_pagamento, valor')
      .eq('mercearia_id', mid).in('venda_id', divididas.slice(i, i + 200));
    if (error) throw new Error(error.message);
    (data || []).forEach(f => { (fatiasPorVenda[f.venda_id] = fatiasPorVenda[f.venda_id] || []).push(f); });
  }
  lista.forEach(v => {
    const fatias = v.meio_pagamento === 'Dividido' ? fatiasPorVenda[v.id] : null;
    if (fatias && fatias.length) fatias.forEach(f => soma(f.meio_pagamento, f.valor));
    else soma(v.meio_pagamento, v.valor_total);
  });

  const periodoTxt = de === ate ? fmtData(de) : `${fmtData(de)} a ${fmtData(ate)}`;
  const linhas = [`📊 *${PERIODOS[chave].titulo}* (${periodoTxt})`];
  if (!lista.length) {
    linhas.push('', 'Nenhuma venda registrada nesse período.');
    return linhas.join('\n');
  }
  linhas.push('', `Total: *${brl(total)}*`, `Vendas: ${inteiro(lista.length)} · Ticket médio: ${brl(total / lista.length)}`);

  const meios = Object.entries(porMeio).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]);
  if (meios.length) {
    linhas.push('', 'Por forma de pagamento:');
    meios.forEach(([m, v]) => linhas.push(`• ${m}: ${brl(v)}`));
  }

  if (de !== ate) {
    const porDia = {};
    lista.forEach(v => { const d = dataStrTZ(v.data_venda, tz); porDia[d] = (porDia[d] || 0) + (Number(v.valor_total) || 0); });
    const dias = Object.entries(porDia).sort((a, b) => b[1] - a[1]);
    const nDias = diasEntre(de, ate) + 1;
    if (dias.length) linhas.push('', `Melhor dia: ${fmtData(dias[0][0])} (${brl(dias[0][1])})`, `Média por dia: ${brl(total / nDias)}`);
  }
  return linhas.join('\n');
}

/* ── Fiado ──────────────────────────────────────────────────── */
async function fiado(mid, tz, loja) {
  if (loja && loja.fiado_ativo === false) return '📒 O fiado está desligado nas configurações desta loja.';
  const hoje = hojeStrTZ(tz);
  const lista = await todas(() => db.from('clientes')
    .select('id, nome, saldo_devedor, data_vencimento')
    .eq('mercearia_id', mid).gt('saldo_devedor', 0.009)
    .order('saldo_devedor', { ascending: false }), 5000);
  if (!lista.length) return '📒 *Fiado*\n\nNinguém está devendo no momento. 🎉';

  const total = lista.reduce((s, c) => s + (Number(c.saldo_devedor) || 0), 0);
  const vencidos = lista.filter(c => c.data_vencimento && c.data_vencimento < hoje);
  const totalVenc = vencidos.reduce((s, c) => s + (Number(c.saldo_devedor) || 0), 0);
  const linhas = [
    '📒 *Fiado — quem deve*', '',
    `Total em aberto: *${brl(total)}* (${inteiro(lista.length)} cliente${lista.length === 1 ? '' : 's'})`,
  ];
  if (vencidos.length) linhas.push(`Vencidos: ${inteiro(vencidos.length)} (${brl(totalVenc)})`);
  linhas.push('', lista.length > 10 ? 'Maiores dívidas:' : 'Dívidas:');
  lista.slice(0, 10).forEach(c => {
    let prazo = '';
    if (c.data_vencimento) {
      const d = diasEntre(hoje, c.data_vencimento);
      prazo = d < 0 ? ` · ⚠️ venceu ${fmtData(c.data_vencimento)}` : d === 0 ? ' · vence hoje' : ` · vence ${fmtData(c.data_vencimento)}`;
    }
    linhas.push(`• ${c.nome}: ${brl(c.saldo_devedor)}${prazo}`);
  });
  if (lista.length > 10) linhas.push(`… e mais ${lista.length - 10}. A lista completa está na tela Clientes do sistema.`);
  return linhas.join('\n');
}

/* ── Contas a pagar (atrasadas + próximos 7 dias) ───────────── */
// verContas: contas "da casa" (Financeiro); verFornecedores: contas de compras a prazo
async function contas(mid, tz, { verContas, verFornecedores }) {
  const hoje = hojeStrTZ(tz);
  const limite = somarDias(hoje, 7);
  const { data: lista, error } = await db.from('contas_a_pagar')
    .select('id, descricao, valor, data_vencimento, status')
    .eq('mercearia_id', mid).neq('status', 'paga')
    .not('data_vencimento', 'is', null).lte('data_vencimento', limite)
    .order('data_vencimento', { ascending: true }).limit(300);
  if (error) throw new Error(error.message);

  let fornecedorDaConta = {};
  if ((lista || []).length) {
    const { data: compras } = await db.from('compras').select('conta_a_pagar_id, fornecedor_id, status')
      .eq('mercearia_id', mid).in('conta_a_pagar_id', lista.map(c => c.id));
    const ids = [...new Set((compras || []).map(c => c.fornecedor_id).filter(Boolean))];
    const nomes = {};
    if (ids.length) {
      const { data: fs } = await db.from('fornecedores').select('id, nome').eq('mercearia_id', mid).in('id', ids);
      (fs || []).forEach(f => { nomes[f.id] = f.nome; });
    }
    (compras || []).forEach(c => { fornecedorDaConta[c.conta_a_pagar_id] = nomes[c.fornecedor_id] || 'fornecedor'; });
  }
  const visiveis = (lista || []).filter(c => (fornecedorDaConta[c.id] ? verFornecedores : verContas));
  const titulo = '🧾 *Contas a pagar* (atrasadas e próximos 7 dias)';
  if (!visiveis.length) return `${titulo}\n\nNenhuma conta atrasada ou vencendo nos próximos 7 dias. ✅`;

  const atrasadas = visiveis.filter(c => c.data_vencimento < hoje);
  const proximas = visiveis.filter(c => c.data_vencimento >= hoje);
  const somar = (l) => l.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const nome = (c) => (fornecedorDaConta[c.id] ? `${fornecedorDaConta[c.id]}${c.descricao ? ` (${c.descricao})` : ''}` : (c.descricao || 'Conta sem descrição'));
  const linhas = [titulo];
  let mostradas = 0;
  if (atrasadas.length) {
    linhas.push('', `⚠️ Atrasadas: ${atrasadas.length} · ${brl(somar(atrasadas))}`);
    atrasadas.slice(0, 8).forEach(c => { linhas.push(`• ${fmtData(c.data_vencimento)} — ${nome(c)}: ${brl(c.valor)}`); mostradas++; });
  }
  if (proximas.length) {
    linhas.push('', `📅 Próximos 7 dias: ${proximas.length} · ${brl(somar(proximas))}`);
    proximas.slice(0, Math.max(3, 12 - mostradas)).forEach(c => {
      const d = diasEntre(hoje, c.data_vencimento);
      linhas.push(`• ${d === 0 ? 'Hoje' : fmtData(c.data_vencimento)} — ${nome(c)}: ${brl(c.valor)}`);
      mostradas++;
    });
  }
  if (mostradas < visiveis.length) linhas.push(`… e mais ${visiveis.length - mostradas}. Veja todas no sistema.`);
  return linhas.join('\n');
}

/* ── Estoque baixo ──────────────────────────────────────────── */
async function estoqueBaixo(mid) {
  const { data, error } = await db.rpc('notif_estoque_baixo', { p_mercearia_id: mid, p_limite: 300 });
  if (error) throw new Error(error.message);
  const lista = data || [];
  if (!lista.length) return '📦 *Estoque baixo*\n\nNenhum produto abaixo do estoque mínimo. ✅';
  const zerados = lista.filter(p => Number(p.estoque) <= 0);
  const baixos = lista.filter(p => Number(p.estoque) > 0);
  const linhas = ['📦 *Estoque baixo*', '', `Sem estoque: ${zerados.length} · Abaixo do mínimo: ${baixos.length}`];
  const nome = (p) => (p.detalhe ? `${p.nome} (${p.detalhe})` : p.nome);
  let n = 0;
  if (zerados.length) {
    linhas.push('', '🔴 Sem estoque:');
    zerados.slice(0, 10).forEach(p => { linhas.push(`• ${nome(p)}`); n++; });
  }
  if (baixos.length) {
    linhas.push('', '🟡 Abaixo do mínimo:');
    baixos.slice(0, Math.max(5, 15 - n)).forEach(p => { linhas.push(`• ${nome(p)}: ${qtd(p.estoque, p.unidade)} (mín. ${qtd(p.minimo, p.unidade)})`); n++; });
  }
  if (n < lista.length) linhas.push('', `… e mais ${lista.length - n}. A lista completa está na tela Estoque do sistema.`);
  return linhas.join('\n');
}

/* ── Produto: busca e estoque ───────────────────────────────── */
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'o', 'a', 'os', 'as', 'e', 'um', 'uma']);
// Palavras de pergunta que não fazem parte do nome do produto (01/10):
// "quantas pepsi twist tenho no estoque?" → busca só "pepsi twist"
const PALAVRAS_PERGUNTA = new Set([
  'tenho', 'temos', 'tem', 'ha', 'existe', 'existem', 'no', 'na', 'nos', 'nas', 'em', 'meu', 'minha', 'meus', 'minhas',
  'estoque', 'estoques', 'loja', 'mercado', 'aqui', 'ai', 'ainda', 'hoje', 'agora', 'sobrou', 'sobrando', 'resta', 'restam',
  'disponivel', 'disponiveis', 'unidade', 'unidades', 'quantos', 'quantas', 'quanto', 'quanta', 'qtd', 'quantidade',
  'produto', 'produtos', 'ver', 'consultar', 'saber', 'quero', 'me', 'diga', 'fala', 'por', 'favor', 'pf', 'pfv',
]);

// Procura no cadastro da loja. Devolve { produtos: [...], exato: bool }.
// Nunca "chuta": com mais de um candidato, quem escolhe é a pessoa.
async function buscarProdutos(mid, termo) {
  const bruto = String(termo || '').trim();
  const soDigitos = bruto.replace(/\D/g, '');
  const campos = 'id, nome, marca, codigo_barras, estoque_atual, estoque_minimo, preco_venda, unidade_medida, tem_variacoes';

  // Código de barras (produto ou variação)
  if (soDigitos.length >= 8 && soDigitos === bruto.replace(/\s/g, '')) {
    const { data: ps } = await db.from('produtos').select(campos).eq('mercearia_id', mid).eq('codigo_barras', soDigitos).limit(5);
    if (ps && ps.length) return { produtos: ps, exato: ps.length === 1 };
    const { data: vs } = await db.from('produto_variacoes').select('produto_id').eq('mercearia_id', mid).eq('codigo_barras', soDigitos).eq('ativo', true).limit(5);
    if (vs && vs.length) {
      const { data: pv } = await db.from('produtos').select(campos).eq('mercearia_id', mid).in('id', [...new Set(vs.map(v => v.produto_id))]);
      if (pv && pv.length) return { produtos: pv, exato: pv.length === 1 };
    }
  }

  const todosTokens = normalizar(bruto).split(' ').filter(t => t && !PALAVRAS_VAZIAS.has(t));
  const semPergunta = todosTokens.filter(t => !PALAVRAS_PERGUNTA.has(t));
  // Se sobrou alguma coisa, busca só pelo que parece nome; senão usa tudo
  const tokens = semPergunta.length ? semPergunta : todosTokens;
  if (!tokens.length) return { produtos: [], exato: false };
  const todos = await todas(() => db.from('produtos').select(campos).eq('mercearia_id', mid).order('nome', { ascending: true }), 20000);

  const alvo = tokens.join(' ');
  const pontuados = [];
  todos.forEach(p => {
    const nome = normalizar(p.nome);
    const texto = `${nome} ${normalizar(p.marca)}`;
    const palavras = texto.split(' ');
    let acertos = 0, pontos = 0;
    tokens.forEach(t => {
      if (palavras.includes(t)) { acertos++; pontos += 3; }
      else if (palavras.some(w => w.startsWith(t))) { acertos++; pontos += 2; }
      else if (t.length >= 3 && texto.includes(t)) { acertos++; pontos += 1; }
    });
    if (!acertos) return;
    if (nome === alvo) pontos += 100;
    else if (nome.startsWith(alvo)) pontos += 5;
    pontuados.push({ p, acertos, pontos });
  });
  const completos = pontuados.filter(x => x.acertos === tokens.length);
  const base = completos.length ? completos : pontuados.filter(x => x.acertos >= Math.ceil(tokens.length / 2));
  base.sort((a, b) => b.pontos - a.pontos || a.p.nome.localeCompare(b.p.nome, 'pt-BR'));
  const exatoUnico = base.length && normalizar(base[0].p.nome) === alvo && (base.length === 1 || normalizar(base[1].p.nome) !== alvo);
  return {
    produtos: base.slice(0, 10).map(x => x.p),
    total: base.length,
    exato: !!completos.length && (completos.length === 1 || exatoUnico),
    parecidos: !completos.length,
  };
}

async function produtoPorId(mid, id) {
  const { data } = await db.from('produtos')
    .select('id, nome, marca, codigo_barras, estoque_atual, estoque_minimo, preco_venda, unidade_medida, tem_variacoes')
    .eq('mercearia_id', mid).eq('id', id).maybeSingle();
  return data || null;
}

async function textoProduto(mid, p) {
  const un = p.unidade_medida;
  const linhas = [`📦 *${p.nome}*${p.marca ? ` · ${p.marca}` : ''}`];
  if (p.tem_variacoes) {
    const { data: vs, error } = await db.from('produto_variacoes')
      .select('tamanho, cor, genero, estoque_atual, estoque_minimo, preco_venda')
      .eq('mercearia_id', mid).eq('produto_id', p.id).eq('ativo', true);
    if (error) throw new Error(error.message);
    const lista = (vs || []).slice().sort((a, b) => [a.tamanho, a.cor, a.genero].join(' ').localeCompare([b.tamanho, b.cor, b.genero].join(' '), 'pt-BR'));
    const total = lista.reduce((s, v) => s + (Number(v.estoque_atual) || 0), 0);
    linhas.push('', `Estoque total: *${qtd(total, un)}* em ${lista.length} variaç${lista.length === 1 ? 'ão' : 'ões'}`);
    lista.slice(0, 20).forEach(v => {
      const rot = [v.tamanho, v.cor, v.genero].filter(Boolean).join(' · ') || 'Variação';
      const minimo = Number(v.estoque_minimo ?? p.estoque_minimo) || 0;
      const alerta = Number(v.estoque_atual) <= 0 ? ' 🔴' : Number(v.estoque_atual) <= minimo ? ' 🟡' : '';
      const preco = v.preco_venda != null ? ` · ${brl(v.preco_venda)}` : '';
      linhas.push(`• ${rot}: ${qtd(v.estoque_atual, un)}${alerta}${preco}`);
    });
    if (lista.length > 20) linhas.push(`… e mais ${lista.length - 20} variações.`);
    if (p.preco_venda != null && Number(p.preco_venda) > 0) linhas.push('', `Preço padrão: ${brl(p.preco_venda)}`);
  } else {
    const est = Number(p.estoque_atual) || 0;
    const minimo = Number(p.estoque_minimo) || 0;
    const alerta = est <= 0 ? ' 🔴 sem estoque' : minimo > 0 && est <= minimo ? ' 🟡 abaixo do mínimo' : '';
    linhas.push('', `Estoque: *${qtd(est, un)}*${alerta}`);
    if (minimo > 0) linhas.push(`Mínimo: ${qtd(minimo, un)}`);
    if (p.preco_venda != null) linhas.push(`Preço: ${brl(p.preco_venda)}`);
  }
  if (p.codigo_barras) linhas.push(`Código: ${p.codigo_barras}`);
  return linhas.join('\n');
}

module.exports = {
  PERIODOS, brl, qtd, fmtData, somarDias, diasEntre, horaTZ, normalizar, todas,
  vendas, fiado, contas, estoqueBaixo, buscarProdutos, produtoPorId, textoProduto,
};
