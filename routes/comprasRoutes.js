// routes/comprasRoutes.js
// "Lançar Compra" — o coração da integração Fornecedores + Estoque +
// Financeiro. Uma compra dá entrada automática no estoque de cada item
// (mesmo mecanismo do Ajuste Rápido do Inventário) e, se for a prazo,
// gera a conta a pagar sozinha.

const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { registrar } = require('./auditoriaRoutes');
const { buscarTimezone, hojeStrTZ } = require('../utils/fusoHorario');

console.log('🔥 COMPRAS ROUTES ATUALIZADO 🔥');

router.use(authUser);

/* ── helpers ─────────────────────────────────────────────── */
function mercearia(req) { return req.user.mercearia_id; }
function operadorId(req) { return req.user.role === 'operator' ? req.user.id : null; }

function fmtMoeda(v) {
  return (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtQtd(v, u) {
  return u === 'kg'
    ? parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg'
    : Math.trunc(parseFloat(v) || 0) + ' un';
}
// Resumo curto pra caber na descrição da auditoria sem ficar ilegível
function resumoItens(itensRegistrados) {
  const nomes = itensRegistrados.map(i => `${i.produto_nome} (${fmtQtd(i.quantidade, i.unidade_medida)})`);
  if (nomes.length <= 3) return nomes.join(', ');
  return `${nomes.slice(0, 3).join(', ')} e mais ${nomes.length - 3}`;
}

/* ════════════════════════════════════════════════════════════
   1. LISTAR COMPRAS — GET /api/compras?fornecedor_id=&status=
════════════════════════════════════════════════════════════ */
router.get('/', verificarPermissao(PERMISSOES.FORNECEDORES_COMPRAR), async (req, res) => {
  const mid = mercearia(req);
  const { fornecedor_id, data_inicio, data_fim, limit = 50, offset = 0 } = req.query;

  try {
    let query = db
      .from('compras')
      .select('*, fornecedores(nome)', { count: 'exact' })
      .eq('mercearia_id', mid)
      .order('data_compra', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (fornecedor_id) query = query.eq('fornecedor_id', fornecedor_id);
    if (data_inicio)   query = query.gte('data_compra', data_inicio);
    if (data_fim)       query = query.lte('data_compra', data_fim);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      registros: (data || []).map(c => ({ ...c, fornecedor_nome: c.fornecedores?.nome })),
      total: count || 0,
    });
  } catch (err) {
    console.error('[COMPRAS] Erro listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar compras' });
  }
});

/* ════════════════════════════════════════════════════════════
   CONTAS A PAGAR DE FORNECEDORES — visão agregada, todos os
   fornecedores juntos (não filtrado por um fornecedor específico)
   GET /api/compras/contas-a-pagar?status=pendente|paga|atrasada
   ⚠️ Precisa vir ANTES de /:id, senão o Express trata
   "contas-a-pagar" como valor do parâmetro :id.
════════════════════════════════════════════════════════════ */
router.get('/contas-a-pagar', verificarPermissao(PERMISSOES.FORNECEDORES_COMPRAR), async (req, res) => {
  const mid = mercearia(req);
  const { status } = req.query; // 'pendente' | 'paga' | 'atrasada' — sem isso, traz tudo

  try {
    const { data: compras, error } = await db
      .from('compras')
      .select('id, numero_nota, data_compra, valor_total, conta_a_pagar_id, fornecedor_id, fornecedores(nome, telefone, email)')
      .eq('mercearia_id', mid)
      .eq('forma_pagamento', 'a_prazo')
      .eq('status', 'ativa')
      .not('conta_a_pagar_id', 'is', null)
      .order('data_compra', { ascending: false });

    if (error) throw error;

    const contaIds = (compras || []).map(c => c.conta_a_pagar_id);
    const contasPorId = {};
    if (contaIds.length > 0) {
      const { data: contas } = await db
        .from('contas_a_pagar')
        .select('id, data_vencimento, status, data_pagamento')
        .in('id', contaIds);
      (contas || []).forEach(c => { contasPorId[c.id] = c; });
    }

    // "Hoje" no fuso do próprio estabelecimento — antes usava -3h fixo
    // (só acerta pra Brasília). Marca como atrasada só depois da meia-
    // noite local de verdade, não da meia-noite UTC do servidor.
    const timezoneCompras = await buscarTimezone(mid);
    const hojeBR = hojeStrTZ(timezoneCompras);

    let resultado = (compras || []).map(c => {
      const conta = contasPorId[c.conta_a_pagar_id] || {};
      let statusFinal = conta.status || 'pendente';
      if (statusFinal === 'pendente' && conta.data_vencimento && conta.data_vencimento < hojeBR) {
        statusFinal = 'atrasada';
      }
      return {
        compra_id:           c.id,
        conta_a_pagar_id:    c.conta_a_pagar_id,
        numero_nota:         c.numero_nota,
        data_compra:         c.data_compra,
        valor:               c.valor_total,
        data_vencimento:     conta.data_vencimento || null,
        data_pagamento:      conta.data_pagamento || null,
        status:              statusFinal,
        fornecedor_id:       c.fornecedor_id,
        fornecedor_nome:     c.fornecedores?.nome || null,
        fornecedor_telefone: c.fornecedores?.telefone || null,
      };
    });

    if (status) resultado = resultado.filter(r => r.status === status);
    resultado.sort((a, b) => (a.data_vencimento || '9999-99-99').localeCompare(b.data_vencimento || '9999-99-99'));

    res.json(resultado);
  } catch (err) {
    console.error('[COMPRAS] Erro listar contas a pagar de fornecedores:', err.message);
    res.status(500).json({ error: 'Erro ao buscar contas a pagar de fornecedores' });
  }
});

/* ════════════════════════════════════════════════════════════
   2. DETALHES DE UMA COMPRA (com itens) — GET /api/compras/:id
════════════════════════════════════════════════════════════ */
router.get('/:id', verificarPermissao(PERMISSOES.FORNECEDORES_COMPRAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;

  try {
    const { data: compra, error } = await db
      .from('compras')
      .select('*, fornecedores(nome, telefone)')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (error || !compra) return res.status(404).json({ error: 'Compra não encontrada' });

    const { data: itens } = await db
      .from('itens_compra')
      .select('*')
      .eq('compra_id', id);

    // Se for a prazo, busca a data de vencimento na conta a pagar
    // vinculada — a compra em si não guarda isso, só a conta gerada.
    let dataVencimentoPrazo = null;
    let statusContaPagar    = null;
    if (compra.forma_pagamento === 'a_prazo' && compra.conta_a_pagar_id) {
      const { data: conta } = await db
        .from('contas_a_pagar')
        .select('data_vencimento, status')
        .eq('id', compra.conta_a_pagar_id)
        .single();
      dataVencimentoPrazo = conta?.data_vencimento || null;
      statusContaPagar    = conta?.status || null;
    }

    res.json({
      ...compra,
      fornecedor_nome: compra.fornecedores?.nome,
      itens: itens || [],
      data_vencimento_prazo: dataVencimentoPrazo,
      status_conta_pagar:    statusContaPagar,
    });
  } catch (err) {
    console.error('[COMPRAS] Erro detalhes:', err.message);
    res.status(500).json({ error: 'Erro ao buscar compra' });
  }
});

/* ════════════════════════════════════════════════════════════
   3. LANÇAR COMPRA — POST /api/compras
      body: { fornecedor_id, numero_nota, data_compra, forma_pagamento,
              data_vencimento (se a_prazo), observacoes,
              itens: [{ produto_id, quantidade, preco_custo_unitario }] }
════════════════════════════════════════════════════════════ */
router.post('/', verificarPermissao(PERMISSOES.FORNECEDORES_COMPRAR), async (req, res) => {
  const mid = mercearia(req);
  const {
    fornecedor_id, numero_nota, data_compra, forma_pagamento,
    data_vencimento, observacoes, itens,
  } = req.body;

  if (!fornecedor_id) return res.status(400).json({ error: 'Selecione um fornecedor' });
  if (!['a_vista', 'a_prazo'].includes(forma_pagamento)) return res.status(400).json({ error: 'Forma de pagamento inválida' });
  if (forma_pagamento === 'a_prazo' && !data_vencimento) return res.status(400).json({ error: 'Informe a data de vencimento' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ error: 'Adicione pelo menos um produto' });

  for (const it of itens) {
    if (!it.produto_id || !it.quantidade || parseFloat(it.quantidade) <= 0) {
      return res.status(400).json({ error: 'Todos os itens precisam de produto e quantidade válida' });
    }
    if (it.preco_custo_unitario === undefined || parseFloat(it.preco_custo_unitario) < 0) {
      return res.status(400).json({ error: 'Preço de custo inválido em algum item' });
    }
  }

  try {
    // 1. Fornecedor precisa existir e ser desse estabelecimento
    const { data: fornecedor } = await db
      .from('fornecedores')
      .select('id, nome')
      .eq('id', fornecedor_id)
      .eq('mercearia_id', mid)
      .single();
    if (!fornecedor) return res.status(404).json({ error: 'Fornecedor não encontrado' });

    // 2. Busca todos os produtos de uma vez, valida que existem e são do estabelecimento
    const produtoIds = itens.map(it => it.produto_id);
    const { data: produtos } = await db
      .from('produtos')
      .select('id, nome, marca, unidade_medida, estoque_atual, categorias(nome)')
      .in('id', produtoIds)
      .eq('mercearia_id', mid);

    const produtosMap = {};
    (produtos || []).forEach(p => { produtosMap[p.id] = p; });

    for (const it of itens) {
      if (!produtosMap[it.produto_id]) {
        return res.status(404).json({ error: `Produto não encontrado (id: ${it.produto_id})` });
      }
    }

    const valorTotal = itens.reduce((acc, it) => acc + parseFloat(it.quantidade) * parseFloat(it.preco_custo_unitario), 0);

    // 3. Cria a compra
    const { data: compra, error: errCompra } = await db
      .from('compras')
      .insert({
        mercearia_id:     mid,
        fornecedor_id,
        numero_nota:      numero_nota?.trim() || null,
        data_compra:      data_compra || hojeStrTZ(await buscarTimezone(mid)),
        forma_pagamento,
        valor_total:      valorTotal,
        observacoes:       observacoes?.trim() || null,
        operador_id:       operadorId(req),
        usuario_nome:      req.user.nome || req.user.email,
      })
      .select()
      .single();

    if (errCompra) throw errCompra;

    // 4. Pra cada item: grava o item da nota, dá entrada no estoque,
    // registra a movimentação — mesmo padrão do Ajuste Rápido. Guarda
    // também um resumo (antes/depois) pra jogar na auditoria no final.
    const itensRegistrados = [];

    for (const it of itens) {
      const produto = produtosMap[it.produto_id];
      const qtd     = parseFloat(it.quantidade);
      const preco   = parseFloat(it.preco_custo_unitario);
      const qtdAntes  = parseFloat(produto.estoque_atual) || 0;
      const qtdDepois = qtdAntes + qtd;

      await db.from('itens_compra').insert({
        compra_id:             compra.id,
        produto_id:            produto.id,
        produto_nome:          produto.nome,
        produto_marca:         produto.marca,
        unidade_medida:        produto.unidade_medida,
        quantidade:            qtd,
        preco_custo_unitario:  preco,
        subtotal:              qtd * preco,
      });

      await db.from('produtos')
        .update({ estoque_atual: qtdDepois, preco_custo: preco })
        .eq('id', produto.id)
        .eq('mercearia_id', mid);

      await db.from('movimentacoes_estoque').insert({
        mercearia_id:            mid,
        produto_id:              produto.id,
        produto_nome:            produto.nome,
        produto_marca:           produto.marca,
        unidade_medida:          produto.unidade_medida,
        tipo:                    'entrada',
        quantidade_anterior:     qtdAntes,
        quantidade_movimentacao: qtd,
        quantidade_posterior:    qtdDepois,
        motivo:                  `Compra de ${fornecedor.nome}${numero_nota ? ` — Nota ${numero_nota}` : ''}`,
        referencia_tipo:         'compra_fornecedor',
        categoria_nome:          produto.categorias?.nome || null,
        operador_id:             operadorId(req),
        usuario_nome:            req.user.nome || req.user.email,
        compra_id:               compra.id,
      });

      itensRegistrados.push({
        produto_id:       produto.id,
        produto_nome:     produto.nome,
        produto_marca:    produto.marca,
        unidade_medida:   produto.unidade_medida,
        quantidade:       qtd,
        preco_custo_unitario: preco,
        estoque_antes:    qtdAntes,
        estoque_depois:   qtdDepois,
      });
    }

    // 5. Se for a prazo, gera a conta a pagar (mesma tabela/estilo que o
    // módulo Financeiro já usa) e vincula na compra
    let contaAPagar = null;
    if (forma_pagamento === 'a_prazo') {
      try {
        const { data: conta, error: errConta } = await db
          .from('contas_a_pagar')
          .insert({
            mercearia_id:    mid,
            descricao:       `Compra de fornecedor — ${fornecedor.nome}${numero_nota ? ` (Nota ${numero_nota})` : ''}`,
            valor:           valorTotal,
            data_vencimento: data_vencimento,
            status:          'pendente',
          })
          .select()
          .single();

        if (errConta) throw errConta;
        contaAPagar = conta;

        await db.from('compras').update({ conta_a_pagar_id: conta.id }).eq('id', compra.id);
      } catch (contaErr) {
        console.error('[COMPRAS] Compra salva, mas falhou ao gerar conta a pagar:', contaErr.message);
        // Não derruba a resposta — a compra e o estoque já foram registrados
        // corretamente, só a conta a pagar precisa ser lançada manualmente.
        registrar({
          mercearia_id:  mid,
          operador_id:   operadorId(req),
          usuario_nome:  req.user.nome,
          usuario_email: req.user.email,
          modulo: 'fornecedores', acao: 'lancar_compra',
          descricao: `Lançou compra de ${fornecedor.nome} — ${fmtMoeda(valorTotal)} (${resumoItens(itensRegistrados)})`,
          meta: { compra_id: compra.id, fornecedor_id, valor_total: valorTotal, forma_pagamento, itens: itensRegistrados },
        });
        return res.status(201).json({
          ...compra,
          fornecedor_nome: fornecedor.nome,
          aviso: 'Compra registrada e estoque atualizado, mas não foi possível gerar a conta a pagar automaticamente. Lance manualmente no Financeiro.',
        });
      }
    }

    registrar({
      mercearia_id:  mid,
      operador_id:   operadorId(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'fornecedores', acao: 'lancar_compra',
      descricao: `Lançou compra de ${fornecedor.nome} — ${fmtMoeda(valorTotal)} (${resumoItens(itensRegistrados)})`,
      meta: { compra_id: compra.id, fornecedor_id, valor_total: valorTotal, forma_pagamento, itens: itensRegistrados },
    });

    res.status(201).json({ ...compra, fornecedor_nome: fornecedor.nome, conta_a_pagar: contaAPagar });
  } catch (err) {
    console.error('[COMPRAS] Erro lançar:', err.message);
    res.status(500).json({ error: 'Erro ao lançar compra' });
  }
});

/* ════════════════════════════════════════════════════════════
   4. CANCELAR COMPRA — estorna o estoque de cada item e cancela
      a conta a pagar vinculada (se ainda estiver pendente)
      DELETE /api/compras/:id
════════════════════════════════════════════════════════════ */
router.delete('/:id', verificarPermissao(PERMISSOES.FORNECEDORES_CANCELAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;

  try {
    const { data: compra } = await db
      .from('compras')
      .select('*, fornecedores(nome)')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (!compra) return res.status(404).json({ error: 'Compra não encontrada' });
    if (compra.status === 'cancelada') return res.status(400).json({ error: 'Essa compra já está cancelada' });

    // Se a conta a pagar já foi paga, não cancela sozinho — pede pra
    // resolver manualmente no Financeiro primeiro, pra não mexer em
    // dinheiro que já saiu sem o comerciante saber
    if (compra.conta_a_pagar_id) {
      const { data: conta } = await db
        .from('contas_a_pagar')
        .select('status')
        .eq('id', compra.conta_a_pagar_id)
        .eq('mercearia_id', mid)
        .single();
      if (conta?.status === 'paga') {
        return res.status(400).json({ error: 'Essa compra tem uma conta a pagar já quitada. Resolva isso no Financeiro antes de cancelar a compra.' });
      }
    }

    const { data: itens } = await db.from('itens_compra').select('*').eq('compra_id', id);

    // Estorna o estoque de cada item (some com a quantidade que entrou),
    // guardando o antes/depois de cada um pra auditoria
    const itensEstornados = [];

    for (const item of (itens || [])) {
      const { data: produto } = await db
        .from('produtos')
        .select('id, nome, marca, unidade_medida, estoque_atual, categorias(nome)')
        .eq('id', item.produto_id)
        .eq('mercearia_id', mid)
        .single();

      if (!produto) {
        // Produto pode ter sido excluído depois — segue o cancelamento
        // mesmo assim, só registra o que foi cancelado sem o "depois"
        itensEstornados.push({
          produto_id: item.produto_id,
          produto_nome: item.produto_nome,
          produto_marca: item.produto_marca,
          unidade_medida: item.unidade_medida,
          quantidade: parseFloat(item.quantidade),
          estoque_antes: null,
          estoque_depois: null,
          obs: 'produto excluído depois da compra — estoque não pôde ser estornado',
        });
        continue;
      }

      const qtdAntes  = parseFloat(produto.estoque_atual) || 0;
      const qtdDepois = Math.max(0, qtdAntes - parseFloat(item.quantidade));

      await db.from('produtos').update({ estoque_atual: qtdDepois }).eq('id', produto.id).eq('mercearia_id', mid);

      await db.from('movimentacoes_estoque').insert({
        mercearia_id: mid, produto_id: produto.id, produto_nome: produto.nome, produto_marca: produto.marca,
        unidade_medida: produto.unidade_medida, tipo: 'correcao',
        quantidade_anterior: qtdAntes, quantidade_movimentacao: parseFloat(item.quantidade), quantidade_posterior: qtdDepois,
        motivo: `Estorno — cancelamento da compra de ${compra.fornecedores?.nome || 'fornecedor'}`,
        referencia_tipo: 'cancelamento_compra', categoria_nome: produto.categorias?.nome || null,
        operador_id: operadorId(req), usuario_nome: req.user.nome || req.user.email, compra_id: compra.id,
      });

      itensEstornados.push({
        produto_id:     produto.id,
        produto_nome:   produto.nome,
        produto_marca:  produto.marca,
        unidade_medida: produto.unidade_medida,
        quantidade:     parseFloat(item.quantidade),
        estoque_antes:  qtdAntes,
        estoque_depois: qtdDepois,
      });
    }

    // Cancela a conta a pagar vinculada, se ainda pendente
    if (compra.conta_a_pagar_id) {
      await db.from('contas_a_pagar').delete().eq('id', compra.conta_a_pagar_id).eq('mercearia_id', mid);
    }

    await db.from('compras').update({ status: 'cancelada', cancelado_em: new Date().toISOString() }).eq('id', id);

    registrar({
      mercearia_id: mid, operador_id: operadorId(req), usuario_nome: req.user.nome, usuario_email: req.user.email,
      modulo: 'fornecedores', acao: 'cancelar_compra',
      descricao: `Cancelou a compra de ${compra.fornecedores?.nome || 'fornecedor'} — ${fmtMoeda(compra.valor_total)} — estoque estornado (${resumoItens(itensEstornados)})`,
      meta: { compra_id: id, valor_total: compra.valor_total, itens: itensEstornados },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[COMPRAS] Erro cancelar:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar compra' });
  }
});

module.exports = router;