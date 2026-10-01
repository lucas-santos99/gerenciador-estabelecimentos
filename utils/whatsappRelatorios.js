// utils/whatsappRelatorios.js
// ============================================================
// WhatsApp — relatórios em PDF (01/10/2026).
// Cada função lê o banco da PRÓPRIA loja (sempre mercearia_id), monta o
// PDF no molde da Identidade dos Relatórios (utils/relatorioPdf.js) e
// devolve { pdf: Buffer, arquivo, legenda }. Nada aqui envia mensagem nem
// debita crédito — isso é do utils/whatsappAssistente.js.
//
// Mesma regra de ouro das consultas: todo número vem do banco e o PDF diz
// o que foi consultado (período, filtros).
// ============================================================
const db = require('../db/supabaseAdmin');
const C = require('./whatsappConsultas');
const P = require('./relatorioPdf');

const brl = C.brl;
const qtdTxt = (v, un) => C.qtd(v, un);
const pct = (v, total) => (total > 0 ? `${((v / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '-');
const dataBR = (s) => { const [a, m, d] = String(s || '').split('-'); return a && m && d ? `${d}/${m}/${a}` : String(s || ''); };
const DIREITA = { halign: 'right' };

// Nome de arquivo seguro: "Vendas-do-mes_MerceariaX_2026-10-01.pdf"
function nomeArquivo(base, loja, hoje) {
  const limpa = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${[limpa(base), limpa(loja?.nome), hoje].filter(Boolean).join('_')}.pdf`;
}

/* ── Catálogo ───────────────────────────────────────────────── */
// `pode` recebe a pessoa (mesmas permissões das consultas/painel).
const tem = (pessoa, ...ps) => pessoa.dono || ps.some(p => pessoa.permissoes.includes(p));
const podeVendas = (x) => tem(x, 'financeiro', 'relatorios');
const RELATORIOS = {
  vendas_hoje:        { titulo: 'Vendas de hoje',      atalho: 'pdf vendas hoje', lista: 'Vendas de hoje',      desc: 'Resumo, pagamentos e produtos',   pode: podeVendas },
  vendas_ontem:       { titulo: 'Vendas de ontem',     atalho: 'pdf vendas ontem', lista: 'Vendas de ontem',     desc: 'Resumo, pagamentos e produtos',   pode: podeVendas },
  vendas_7d:          { titulo: 'Vendas dos últimos 7 dias', atalho: 'pdf vendas semana', lista: 'Vendas 7 dias', desc: 'Dia a dia, pagamentos e produtos', pode: podeVendas },
  vendas_mes:         { titulo: 'Vendas do mês',       atalho: 'pdf vendas mês', lista: 'Vendas do mês',       desc: 'Do dia 1 até hoje',               pode: podeVendas },
  vendas_mes_passado: { titulo: 'Vendas do mês passado', atalho: 'pdf mês passado', lista: 'Vendas mês passado', desc: 'Mês fechado, dia a dia',         pode: podeVendas },
  estoque:            { titulo: 'Estoque completo',    atalho: 'pdf estoque', lista: 'Estoque completo',    desc: 'Todos os produtos e quantidades', pode: (x) => tem(x, 'estoque') },
  estoque_baixo:      { titulo: 'Estoque baixo',       atalho: 'pdf estoque baixo', lista: 'Estoque baixo',       desc: 'Sem estoque e abaixo do mínimo',  pode: (x) => tem(x, 'estoque') },
  fiado:              { titulo: 'Fiado — quem deve',   atalho: 'pdf fiado', lista: 'Fiado (quem deve)',   desc: 'Todos os clientes com saldo',     pode: (x) => tem(x, 'clientes') },
  contas:             { titulo: 'Contas a pagar',      atalho: 'pdf contas', lista: 'Contas a pagar',      desc: 'Atrasadas e próximos 30 dias',    pode: (x) => tem(x, 'financeiro', 'financeiro_contas_pagar', 'fornecedores') },
};
const ORDEM = ['vendas_hoje', 'vendas_ontem', 'vendas_7d', 'vendas_mes', 'vendas_mes_passado', 'estoque', 'estoque_baixo', 'fiado', 'contas'];

/* ── Vendas ─────────────────────────────────────────────────── */
async function itensDasVendas(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const parte = ids.slice(i, i + 200);
    out.push(...await C.todas(() => db.from('itens_venda')
      .select('venda_id, produto_id, produto_variacao_id, quantidade, preco_unitario, preco_de_custo')
      .in('venda_id', parte).order('id', { ascending: true }), 50000));
  }
  return out;
}

async function relVendas(ctx, chave) {
  const { mid, tz, loja, pessoa } = ctx;
  const { de, ate, lista, total, porMeio } = await C.dadosVendas(mid, tz, chave);
  const def = RELATORIOS[chave];
  const periodo = de === ate ? dataBR(de) : `${dataBR(de)} a ${dataBR(ate)}`;
  const rel = await P.novoPdfRelatorio({ tipo: 'vendas_historico', titulo: def.titulo, subtitulo: `Período: ${periodo} · sem vendas canceladas`, loja, tz });
  const verLucro = pessoa.dono || pessoa.permissoes.includes('financeiro');

  // Itens (produtos vendidos e custo)
  const itens = lista.length ? await itensDasVendas(lista.map(v => v.id)) : [];
  const porProduto = {};
  let custo = 0, custoCompleto = true;
  itens.forEach(it => {
    const q = Number(it.quantidade) || 0;
    const valor = q * (Number(it.preco_unitario) || 0);
    if (it.preco_de_custo == null) custoCompleto = false;
    custo += q * (Number(it.preco_de_custo) || 0);
    const k = it.produto_id || 'sem';
    const p = porProduto[k] || (porProduto[k] = { id: it.produto_id, qtd: 0, valor: 0 });
    p.qtd += q; p.valor += valor;
  });
  const idsProd = Object.values(porProduto).map(p => p.id).filter(Boolean);
  const nomes = {};
  for (let i = 0; i < idsProd.length; i += 300) {
    const { data, error } = await db.from('produtos').select('id, nome, unidade_medida').eq('mercearia_id', mid).in('id', idsProd.slice(i, i + 300));
    if (error) throw new Error(error.message);
    (data || []).forEach(p => { nomes[p.id] = p; });
  }

  // Resumo
  rel.secao('Resumo', { espaco: 2 });
  const resumo = [
    ['Total vendido', brl(total)],
    ['Número de vendas', lista.length.toLocaleString('pt-BR')],
    ['Ticket médio', lista.length ? brl(total / lista.length) : '-'],
  ];
  const nDias = C.diasEntre(de, ate) + 1;
  if (nDias > 1) resumo.push(['Média por dia', brl(total / nDias)]);
  if (verLucro && lista.length) {
    resumo.push(['Custo dos produtos (estimado)', brl(custo)]);
    resumo.push(['Lucro bruto (estimado)', `${brl(total - custo)} (${pct(total - custo, total)})`]);
  }
  rel.tabela({ body: resumo, theme: 'plain', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 }, 1: DIREITA }, tableWidth: 130 });

  if (!lista.length) {
    rel.nota('Nenhuma venda registrada nesse período.');
    return { rel, resumoTxt: `Nenhuma venda em ${periodo}.`, periodo };
  }

  // Formas de pagamento
  const meios = Object.entries(porMeio).filter(([, v]) => v > 0.004).sort((a, b) => b[1] - a[1]);
  rel.secao('Por forma de pagamento');
  rel.tabela({
    head: [['Forma de pagamento', { content: 'Valor', styles: DIREITA }, { content: '%', styles: DIREITA }]],
    body: meios.map(([m, v]) => [m, brl(v), pct(v, total)]),
    foot: [['Total', { content: brl(total), styles: DIREITA }, { content: '100%', styles: DIREITA }]],
    columnStyles: { 1: DIREITA, 2: DIREITA }, tableWidth: 130,
  });

  // Dia a dia
  if (nDias > 1) {
    const porDia = {};
    lista.forEach(v => {
      const d = C.dataStrTZ(v.data_venda, tz);
      const x = porDia[d] || (porDia[d] = { n: 0, v: 0 });
      x.n++; x.v += Number(v.valor_total) || 0;
    });
    const dias = [];
    for (let d = de; d <= ate; d = C.somarDias(d, 1)) dias.push(d);
    const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    rel.secao('Dia a dia');
    rel.tabela({
      head: [['Dia', { content: 'Vendas', styles: DIREITA }, { content: 'Total', styles: DIREITA }, { content: 'Ticket médio', styles: DIREITA }]],
      body: dias.map(d => {
        const x = porDia[d] || { n: 0, v: 0 };
        const sem = SEMANA[new Date(`${d}T12:00:00Z`).getUTCDay()];
        return [`${dataBR(d)} (${sem})`, String(x.n), brl(x.v), x.n ? brl(x.v / x.n) : '-'];
      }),
      foot: [['Total', { content: String(lista.length), styles: DIREITA }, { content: brl(total), styles: DIREITA }, { content: brl(total / lista.length), styles: DIREITA }]],
      columnStyles: { 1: DIREITA, 2: DIREITA, 3: DIREITA }, tableWidth: 150,
    });
  }

  // Produtos mais vendidos
  const prods = Object.values(porProduto).sort((a, b) => b.valor - a.valor);
  const somaItens = prods.reduce((s, p) => s + p.valor, 0);
  const TOP = 30;
  if (prods.length) {
    rel.secao(prods.length > TOP ? `Produtos mais vendidos (${TOP} de ${prods.length})` : 'Produtos vendidos');
    rel.tabela({
      head: [['#', 'Produto', { content: 'Quantidade', styles: DIREITA }, { content: 'Valor', styles: DIREITA }, { content: '%', styles: DIREITA }]],
      body: prods.slice(0, TOP).map((p, i) => [String(i + 1), nomes[p.id]?.nome || 'Produto excluído', qtdTxt(p.qtd, nomes[p.id]?.unidade_medida), brl(p.valor), pct(p.valor, somaItens)]),
      columnStyles: { 0: { cellWidth: 9 }, 2: DIREITA, 3: DIREITA, 4: DIREITA },
    });
  }
  if (verLucro && !custoCompleto) rel.nota('Custo e lucro são estimativas: alguns itens foram vendidos sem preço de custo cadastrado.');
  if (Math.abs(somaItens - total) > 0.05 && prods.length) rel.nota('A soma dos produtos pode diferir do total vendido por causa de descontos e acréscimos nas vendas.');

  const melhor = meios[0] ? ` · mais usado: ${meios[0][0]}` : '';
  return { rel, resumoTxt: `${brl(total)} em ${lista.length} venda${lista.length === 1 ? '' : 's'} (${periodo})${melhor}.`, periodo };
}

/* ── Estoque completo ───────────────────────────────────────── */
async function relEstoque(ctx) {
  const { mid, tz, loja } = ctx;
  const prods = await C.todas(() => db.from('produtos')
    .select('id, nome, marca, categoria_id, estoque_atual, estoque_minimo, preco_venda, unidade_medida, tem_variacoes')
    .eq('mercearia_id', mid).order('nome', { ascending: true }), 20000);
  const { data: cats } = await db.from('categorias').select('id, nome').eq('mercearia_id', mid);
  const nomeCat = Object.fromEntries((cats || []).map(c => [c.id, c.nome]));
  const comVar = prods.filter(p => p.tem_variacoes).map(p => p.id);
  const varPorProd = {};
  for (let i = 0; i < comVar.length; i += 200) {
    const vs = await C.todas(() => db.from('produto_variacoes').select('produto_id, estoque_atual, estoque_minimo, preco_venda')
      .eq('mercearia_id', mid).eq('ativo', true).in('produto_id', comVar.slice(i, i + 200)).order('id', { ascending: true }), 20000);
    vs.forEach(v => { (varPorProd[v.produto_id] = varPorProd[v.produto_id] || []).push(v); });
  }

  let zerados = 0, baixos = 0, valorVenda = 0;
  const body = prods.map(p => {
    let est = Number(p.estoque_atual) || 0;
    let minimo = Number(p.estoque_minimo) || 0;
    let situacao = '';
    let nome = p.nome + (p.marca ? ` · ${p.marca}` : '');
    if (p.tem_variacoes) {
      const vs = varPorProd[p.id] || [];
      est = vs.reduce((s, v) => s + (Number(v.estoque_atual) || 0), 0);
      const zer = vs.filter(v => Number(v.estoque_atual) <= 0).length;
      const bx = vs.filter(v => Number(v.estoque_atual) > 0 && Number(v.estoque_atual) <= (Number(v.estoque_minimo ?? p.estoque_minimo) || 0)).length;
      valorVenda += vs.reduce((s, v) => s + Math.max(0, Number(v.estoque_atual) || 0) * (Number(v.preco_venda ?? p.preco_venda) || 0), 0);
      nome += ` (${vs.length} variaç${vs.length === 1 ? 'ão' : 'ões'})`;
      if (zer) situacao = `${zer} sem estoque`;
      if (bx) situacao = [situacao, `${bx} abaixo do mín.`].filter(Boolean).join(', ');
      if (!vs.length || est <= 0) zerados++; else if (zer || bx) baixos++;
      return [nome, nomeCat[p.categoria_id] || '-', qtdTxt(est, p.unidade_medida), '-', p.preco_venda != null ? brl(p.preco_venda) : '-', situacao || 'OK'];
    }
    valorVenda += Math.max(0, est) * (Number(p.preco_venda) || 0);
    if (est <= 0) { situacao = 'Sem estoque'; zerados++; } else if (minimo > 0 && est <= minimo) { situacao = 'Abaixo do mínimo'; baixos++; }
    return [nome, nomeCat[p.categoria_id] || '-', qtdTxt(est, p.unidade_medida), minimo > 0 ? qtdTxt(minimo, p.unidade_medida) : '-', p.preco_venda != null ? brl(p.preco_venda) : '-', situacao || 'OK'];
  });

  const rel = await P.novoPdfRelatorio({ tipo: 'estoque', titulo: 'Estoque completo', subtitulo: `${prods.length} produto${prods.length === 1 ? '' : 's'} cadastrado${prods.length === 1 ? '' : 's'}`, loja, tz });
  rel.secao('Resumo', { espaco: 2 });
  rel.tabela({
    body: [
      ['Produtos cadastrados', String(prods.length)],
      ['Sem estoque', String(zerados)],
      ['Abaixo do mínimo', String(baixos)],
      ['Estoque a preço de venda', brl(valorVenda)],
    ],
    theme: 'plain', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 }, 1: DIREITA }, tableWidth: 130,
  });
  if (!prods.length) {
    rel.nota('Nenhum produto cadastrado.');
  } else {
    rel.secao('Produtos');
    rel.tabela({
      head: [['Produto', 'Categoria', { content: 'Estoque', styles: DIREITA }, { content: 'Mínimo', styles: DIREITA }, { content: 'Preço', styles: DIREITA }, 'Situação']],
      body,
      columnStyles: { 0: { cellWidth: 62 }, 2: DIREITA, 3: DIREITA, 4: DIREITA },
      didParseCell: (d) => {
        if (d.section === 'body' && d.column.index === 5 && d.cell.raw !== 'OK') d.cell.styles.textColor = String(d.cell.raw).startsWith('Sem') ? [185, 28, 28] : [161, 98, 7];
      },
    });
  }
  return { rel, resumoTxt: `${prods.length} produtos · ${zerados} sem estoque · ${baixos} abaixo do mínimo.` };
}

/* ── Estoque baixo ──────────────────────────────────────────── */
async function relEstoqueBaixo(ctx) {
  const { mid, tz, loja } = ctx;
  const { data, error } = await db.rpc('notif_estoque_baixo', { p_mercearia_id: mid, p_limite: 3000 });
  if (error) throw new Error(error.message);
  const lista = data || [];
  const zerados = lista.filter(p => Number(p.estoque) <= 0);
  const baixos = lista.filter(p => Number(p.estoque) > 0);
  const rel = await P.novoPdfRelatorio({ tipo: 'estoque', titulo: 'Estoque baixo', subtitulo: 'Produtos sem estoque ou abaixo do estoque mínimo', loja, tz });
  rel.secao('Resumo', { espaco: 2 });
  rel.tabela({ body: [['Sem estoque', String(zerados.length)], ['Abaixo do mínimo', String(baixos.length)]], theme: 'plain', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 }, 1: DIREITA }, tableWidth: 130 });
  const nome = (p) => (p.detalhe ? `${p.nome} (${p.detalhe})` : p.nome);
  const linha = (p) => [nome(p), qtdTxt(p.estoque, p.unidade), qtdTxt(p.minimo, p.unidade), qtdTxt(Math.max(0, (Number(p.minimo) || 0) - (Number(p.estoque) || 0)), p.unidade)];
  const head = [['Produto', { content: 'Estoque', styles: DIREITA }, { content: 'Mínimo', styles: DIREITA }, { content: 'Falta p/ o mínimo', styles: DIREITA }]];
  const col = { 1: DIREITA, 2: DIREITA, 3: DIREITA };
  if (!lista.length) rel.nota('Nenhum produto abaixo do estoque mínimo.');
  if (zerados.length) { rel.secao(`Sem estoque (${zerados.length})`); rel.tabela({ head, body: zerados.map(linha), columnStyles: col }); }
  if (baixos.length) { rel.secao(`Abaixo do mínimo (${baixos.length})`); rel.tabela({ head, body: baixos.map(linha), columnStyles: col }); }
  return { rel, resumoTxt: lista.length ? `${zerados.length} sem estoque · ${baixos.length} abaixo do mínimo.` : 'Nenhum produto abaixo do mínimo.' };
}

/* ── Fiado ──────────────────────────────────────────────────── */
async function relFiado(ctx) {
  const { mid, tz, loja } = ctx;
  const hoje = require('./fusoHorario').hojeStrTZ(tz);
  const lista = await C.todas(() => db.from('clientes')
    .select('id, nome, telefone, saldo_devedor, limite_credito, data_vencimento')
    .eq('mercearia_id', mid).gt('saldo_devedor', 0.009)
    .order('saldo_devedor', { ascending: false }), 20000);
  const total = lista.reduce((s, c) => s + (Number(c.saldo_devedor) || 0), 0);
  const vencidos = lista.filter(c => c.data_vencimento && c.data_vencimento < hoje);
  const totalVenc = vencidos.reduce((s, c) => s + (Number(c.saldo_devedor) || 0), 0);
  const rel = await P.novoPdfRelatorio({ tipo: 'clientes', titulo: 'Fiado - quem deve', subtitulo: `Posição em ${dataBR(hoje)}`, loja, tz });
  rel.secao('Resumo', { espaco: 2 });
  rel.tabela({
    body: [['Total em aberto', brl(total)], ['Clientes devendo', String(lista.length)], ['Vencidos', `${vencidos.length} (${brl(totalVenc)})`]],
    theme: 'plain', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 }, 1: DIREITA }, tableWidth: 130,
  });
  if (!lista.length) {
    rel.nota('Ninguém está devendo no momento.');
  } else {
    rel.secao('Clientes');
    rel.tabela({
      head: [['Cliente', 'Telefone', { content: 'Deve', styles: DIREITA }, { content: 'Limite', styles: DIREITA }, 'Vencimento', 'Situação']],
      body: lista.map(c => {
        let sit = 'Em dia';
        if (c.data_vencimento) {
          const d = C.diasEntre(hoje, c.data_vencimento);
          sit = d < 0 ? `Vencido há ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'Vence hoje' : 'Em dia';
        }
        return [c.nome, c.telefone || '-', brl(c.saldo_devedor), Number(c.limite_credito) > 0 ? brl(c.limite_credito) : '-', c.data_vencimento ? dataBR(c.data_vencimento) : '-', sit];
      }),
      foot: [['Total', '', { content: brl(total), styles: DIREITA }, '', '', '']],
      columnStyles: { 2: DIREITA, 3: DIREITA },
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === 5 && String(d.cell.raw).startsWith('Vencido')) d.cell.styles.textColor = [185, 28, 28]; },
    });
  }
  return { rel, resumoTxt: lista.length ? `${brl(total)} em aberto com ${lista.length} cliente${lista.length === 1 ? '' : 's'}${vencidos.length ? ` (${vencidos.length} vencido${vencidos.length === 1 ? '' : 's'})` : ''}.` : 'Ninguém está devendo.' };
}

/* ── Contas a pagar ─────────────────────────────────────────── */
async function relContas(ctx) {
  const { mid, tz, loja, pessoa } = ctx;
  const { hoje, visiveis, fornecedorDaConta } = await C.dadosContas(mid, tz, {
    verContas: tem(pessoa, 'financeiro', 'financeiro_contas_pagar'),
    verFornecedores: tem(pessoa, 'fornecedores', 'financeiro', 'financeiro_contas_pagar'),
  }, 30);
  const atrasadas = visiveis.filter(c => c.data_vencimento < hoje);
  const proximas = visiveis.filter(c => c.data_vencimento >= hoje);
  const somar = (l) => l.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const rel = await P.novoPdfRelatorio({ tipo: 'geral', titulo: 'Contas a pagar', subtitulo: `Atrasadas e vencendo até ${dataBR(C.somarDias(hoje, 30))}`, loja, tz });
  rel.secao('Resumo', { espaco: 2 });
  rel.tabela({
    body: [['Atrasadas', `${atrasadas.length} (${brl(somar(atrasadas))})`], ['Próximos 30 dias', `${proximas.length} (${brl(somar(proximas))})`], ['Total', brl(somar(visiveis))]],
    theme: 'plain', columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 }, 1: DIREITA }, tableWidth: 130,
  });
  const head = [['Vencimento', 'Conta', 'Origem', { content: 'Valor', styles: DIREITA }, 'Situação']];
  const linha = (c) => {
    const d = C.diasEntre(hoje, c.data_vencimento);
    const forn = fornecedorDaConta[c.id];
    return [dataBR(c.data_vencimento), forn ? `${forn}${c.descricao ? ` (${c.descricao})` : ''}` : (c.descricao || 'Conta sem descrição'), forn ? 'Fornecedor' : 'Conta da loja', brl(c.valor),
      d < 0 ? `Atrasada ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'Vence hoje' : `Em ${d} dia${d === 1 ? '' : 's'}`];
  };
  const estilo = (d) => { if (d.section === 'body' && d.column.index === 4 && String(d.cell.raw).startsWith('Atrasada')) d.cell.styles.textColor = [185, 28, 28]; };
  if (!visiveis.length) rel.nota('Nenhuma conta atrasada ou vencendo nos próximos 30 dias.');
  if (atrasadas.length) {
    rel.secao(`Atrasadas (${atrasadas.length})`);
    rel.tabela({ head, body: atrasadas.map(linha), foot: [['Total', '', '', { content: brl(somar(atrasadas)), styles: DIREITA }, '']], columnStyles: { 3: DIREITA }, didParseCell: estilo });
  }
  if (proximas.length) {
    rel.secao(`Próximos 30 dias (${proximas.length})`);
    rel.tabela({ head, body: proximas.map(linha), foot: [['Total', '', '', { content: brl(somar(proximas)), styles: DIREITA }, '']], columnStyles: { 3: DIREITA }, didParseCell: estilo });
  }
  return { rel, resumoTxt: visiveis.length ? `${atrasadas.length} atrasada${atrasadas.length === 1 ? '' : 's'} (${brl(somar(atrasadas))}) · ${proximas.length} nos próximos 30 dias (${brl(somar(proximas))}).` : 'Nenhuma conta atrasada ou vencendo nos próximos 30 dias.' };
}

/**
 * Gera o relatório. ctx: { mid, tz, pessoa, mercearia }.
 * Devolve { pdf: Buffer, arquivo, resumoTxt, titulo }.
 */
async function gerar(chave, ctx) {
  const def = RELATORIOS[chave];
  if (!def) throw new Error(`relatório desconhecido: ${chave}`);
  const loja = await P.dadosLoja(ctx.mid);
  const c = { ...ctx, loja };
  let r;
  if (C.PERIODOS[chave] || chave === 'vendas_mes_passado') r = await relVendas(c, chave);
  else if (chave === 'estoque') r = await relEstoque(c);
  else if (chave === 'estoque_baixo') r = await relEstoqueBaixo(c);
  else if (chave === 'fiado') r = await relFiado(c);
  else r = await relContas(c);
  const pdf = r.rel.finalizar();
  const hoje = require('./fusoHorario').hojeStrTZ(ctx.tz);
  return { pdf, arquivo: nomeArquivo(def.titulo, loja, hoje), resumoTxt: r.resumoTxt, titulo: def.titulo, paginas: r.rel.doc.getNumberOfPages() };
}

module.exports = { RELATORIOS, ORDEM, gerar, nomeArquivo };
