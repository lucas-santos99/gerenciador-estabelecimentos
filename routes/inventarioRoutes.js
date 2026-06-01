// routes/inventarioRoutes.js
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { registrar } = require('./auditoriaRoutes');

router.use(authUser);

/* ── helpers ─────────────────────────────────────────────── */
function mercearia(req) { return req.user.mercearia_id; }
function operadorId(req) { return req.user.role === 'operator' ? req.user.id : null; }

function fmtQtd(valor, unidade) {
  const v = parseFloat(valor) || 0;
  if (unidade === 'kg') return v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg';
  return Math.trunc(v) + ' un';
}

/* ════════════════════════════════════════════════════════════
   1. LISTAR INVENTÁRIOS
   GET /api/inventario?status=&limit=20&offset=0
════════════════════════════════════════════════════════════ */
router.get('/', verificarPermissao(PERMISSOES.INVENTARIO), async (req, res) => {
  const mid = mercearia(req);
  if (!mid) return res.status(403).json({ error: 'Sem mercearia vinculada' });

  const { status, limit = 20, offset = 0 } = req.query;

  try {
    let q = db
      .from('inventarios')
      .select('*', { count: 'exact' })
      .eq('mercearia_id', mid)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ inventarios: data || [], total: count || 0 });
  } catch (err) {
    console.error('[INVENTÁRIO] Listar:', err.message);
    res.status(500).json({ error: 'Erro ao listar inventários' });
  }
});

/* ════════════════════════════════════════════════════════════
   2. CRIAR NOVO INVENTÁRIO (snapshot dos produtos)
   POST /api/inventario
   body: { nome, tipo, categoria_id?, observacoes? }
════════════════════════════════════════════════════════════ */
router.post('/', verificarPermissao(PERMISSOES.INVENTARIO_CONTAR), async (req, res) => {
  const mid = mercearia(req);
  if (!mid) return res.status(403).json({ error: 'Sem mercearia vinculada' });

  const { nome, tipo = 'completo', categoria_id, observacoes } = req.body;
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome do inventário é obrigatório.' });

  // Verificar se já existe um inventário em andamento
  const { data: emAndamento } = await db
    .from('inventarios')
    .select('id, nome')
    .eq('mercearia_id', mid)
    .eq('status', 'em_andamento')
    .limit(1);

  if (emAndamento?.length > 0) {
    return res.status(409).json({
      error: `Já existe um inventário em andamento: "${emAndamento[0].nome}". Finalize ou cancele-o antes de criar um novo.`
    });
  }

  try {
    // Buscar produtos para snapshot
    let prodQ = db
      .from('produtos')
      .select('id, nome, marca, unidade_medida, estoque_atual, preco_custo, preco_venda, categoria_id')
      .eq('mercearia_id', mid)
      .order('nome');

    if (tipo === 'por_categoria' && categoria_id) {
      prodQ = prodQ.eq('categoria_id', categoria_id);
    }

    const { data: produtos, error: prodErr } = await prodQ;
    if (prodErr) throw prodErr;
    if (!produtos?.length) return res.status(400).json({ error: 'Nenhum produto encontrado para este filtro.' });

    // Criar inventário
    const { data: inv, error: invErr } = await db
      .from('inventarios')
      .insert({
        mercearia_id:    mid,
        nome:            nome.trim(),
        status:          'em_andamento',
        tipo,
        categoria_id:    categoria_id || null,
        operador_id:     operadorId(req),
        usuario_nome:    req.user.nome || req.user.email,
        total_produtos:  produtos.length,
        produtos_contados: 0,
        observacoes:     observacoes || null,
      })
      .select()
      .single();
    if (invErr) throw invErr;

    // Criar itens (snapshot do estoque atual)
    const itens = produtos.map(p => ({
      inventario_id:   inv.id,
      produto_id:      p.id,
      produto_nome:    p.nome,
      produto_marca:   p.marca || null,
      unidade_medida:  p.unidade_medida || 'un',
      preco_custo:     parseFloat(p.preco_custo) || 0,
      preco_venda:     parseFloat(p.preco_venda) || 0,
      estoque_sistema: parseFloat(p.estoque_atual) || 0,
      estoque_contado: null,
      diferenca:       null,
    }));

    const { error: itensErr } = await db.from('itens_inventario').insert(itens);
    if (itensErr) throw itensErr;

    registrar({
      mercearia_id:  mid,
      operador_id:   operadorId(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'inventario', acao: 'inventario_iniciado',
      descricao: `Inventário "${nome}" iniciado (${produtos.length} produtos)`,
      meta: { inventario_id: inv.id, tipo, total_produtos: produtos.length },
    });

    res.status(201).json({ ...inv, total_produtos: produtos.length });
  } catch (err) {
    console.error('[INVENTÁRIO] Criar:', err.message);
    res.status(500).json({ error: 'Erro ao criar inventário' });
  }
});

/* ════════════════════════════════════════════════════════════
   3. DETALHE DO INVENTÁRIO COM ITENS
   GET /api/inventario/:id
════════════════════════════════════════════════════════════ */
router.get('/:id', verificarPermissao(PERMISSOES.INVENTARIO), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;
  const { busca, filtro } = req.query; // filtro: 'todos'|'nao_contados'|'com_diferenca'

  try {
    const { data: inv, error: invErr } = await db
      .from('inventarios')
      .select('*')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (invErr || !inv) return res.status(404).json({ error: 'Inventário não encontrado' });

    let itensQ = db
      .from('itens_inventario')
      .select('*')
      .eq('inventario_id', id)
      .order('produto_nome');

    const { data: itens, error: itensErr } = await itensQ;
    if (itensErr) throw itensErr;

    // Filtros no servidor
    let itensFiltrados = itens || [];
    if (busca?.trim()) {
      const b = busca.toLowerCase();
      itensFiltrados = itensFiltrados.filter(i =>
        i.produto_nome.toLowerCase().includes(b) ||
        (i.produto_marca || '').toLowerCase().includes(b)
      );
    }
    if (filtro === 'nao_contados') {
      itensFiltrados = itensFiltrados.filter(i => i.estoque_contado === null);
    } else if (filtro === 'com_diferenca') {
      itensFiltrados = itensFiltrados.filter(i => i.diferenca !== null && i.diferenca !== 0);
    }

    res.json({ ...inv, itens: itensFiltrados });
  } catch (err) {
    console.error('[INVENTÁRIO] Detalhe:', err.message);
    res.status(500).json({ error: 'Erro ao buscar inventário' });
  }
});

/* ════════════════════════════════════════════════════════════
   4. ATUALIZAR CONTAGEM DE UM ITEM
   PATCH /api/inventario/:id/item/:itemId
   body: { estoque_contado, observacao? }
════════════════════════════════════════════════════════════ */
router.patch('/:id/item/:itemId', verificarPermissao(PERMISSOES.INVENTARIO_CONTAR), async (req, res) => {
  const mid = mercearia(req);
  const { id, itemId } = req.params;
  const { estoque_contado, observacao } = req.body;

  if (estoque_contado === undefined || estoque_contado === null || estoque_contado === '') {
    return res.status(400).json({ error: 'Quantidade contada é obrigatória' });
  }
  if (parseFloat(estoque_contado) < 0) {
    return res.status(400).json({ error: 'Quantidade não pode ser negativa' });
  }

  try {
    // Verificar que o inventário pertence à mercearia e está em andamento
    const { data: inv } = await db
      .from('inventarios')
      .select('id, status, total_produtos, produtos_contados')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (!inv) return res.status(404).json({ error: 'Inventário não encontrado' });
    if (inv.status !== 'em_andamento') return res.status(400).json({ error: 'Inventário não está em andamento' });

    // Buscar item atual
    const { data: itemAtual } = await db
      .from('itens_inventario')
      .select('*')
      .eq('id', itemId)
      .eq('inventario_id', id)
      .single();

    if (!itemAtual) return res.status(404).json({ error: 'Item não encontrado' });

    const qtdContada  = parseFloat(estoque_contado);
    const diferenca   = qtdContada - parseFloat(itemAtual.estoque_sistema);
    const jaContado   = itemAtual.estoque_contado !== null;

    // Atualizar item
    const { data: itemAtualizado, error: updateErr } = await db
      .from('itens_inventario')
      .update({
        estoque_contado: qtdContada,
        diferenca,
        observacao: observacao || null,
        contado_em: new Date().toISOString(),
      })
      .eq('id', itemId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    // Atualizar contadores do inventário
    const novoContados = jaContado
      ? inv.produtos_contados  // já estava contado, não incrementa
      : inv.produtos_contados + 1;

    // Recalcular total de divergências
    const { data: todosItens } = await db
      .from('itens_inventario')
      .select('diferenca')
      .eq('inventario_id', id)
      .not('diferenca', 'is', null);

    const totalDivergencias = (todosItens || []).filter(i => i.diferenca !== 0).length;

    await db
      .from('inventarios')
      .update({ produtos_contados: novoContados, total_divergencias: totalDivergencias })
      .eq('id', id);

    res.json({ item: itemAtualizado, produtos_contados: novoContados, total_divergencias: totalDivergencias });
  } catch (err) {
    console.error('[INVENTÁRIO] Atualizar item:', err.message);
    res.status(500).json({ error: 'Erro ao salvar contagem' });
  }
});

/* ════════════════════════════════════════════════════════════
   5. FINALIZAR INVENTÁRIO (aplica ao estoque)
   POST /api/inventario/:id/finalizar
   body: { aplicar_apenas_divergencias: bool }
════════════════════════════════════════════════════════════ */
router.post('/:id/finalizar', verificarPermissao(PERMISSOES.INVENTARIO_FINALIZAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;
  const { aplicar_apenas_divergencias = false } = req.body;

  try {
    const { data: inv } = await db
      .from('inventarios')
      .select('*')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (!inv) return res.status(404).json({ error: 'Inventário não encontrado' });
    if (inv.status !== 'em_andamento') return res.status(400).json({ error: 'Inventário não está em andamento' });

    // Buscar itens com contagem + categoria via produto
    const { data: itens } = await db
      .from('itens_inventario')
      .select('*, produtos(categoria_id, categorias(nome))')
      .eq('inventario_id', id)
      .not('estoque_contado', 'is', null);

    if (!itens?.length) return res.status(400).json({ error: 'Nenhum produto foi contado ainda.' });

    const itensAplicar = aplicar_apenas_divergencias
      ? itens.filter(i => i.diferenca !== 0)
      : itens;

    if (!itensAplicar.length) {
      // Nenhuma divergência — só finalizar sem alterar estoque
      await db.from('inventarios').update({
        status: 'finalizado',
        finalizado_em: new Date().toISOString(),
        total_divergencias: 0,
        valor_divergencia: 0,
      }).eq('id', id);
      return res.json({ success: true, ajustes: 0, mensagem: 'Inventário finalizado sem divergências.' });
    }

    // Aplicar ajustes ao estoque e registrar movimentações
    let valorDivTotal = 0;
    const movimentacoes = [];

    for (const item of itensAplicar) {
      const qtdAntes  = parseFloat(item.estoque_sistema);
      const qtdDepois = parseFloat(item.estoque_contado);
      const diff      = qtdDepois - qtdAntes;

      // Atualizar estoque do produto
      const { error: updErr } = await db
        .from('produtos')
        .update({ estoque_atual: qtdDepois })
        .eq('id', item.produto_id)
        .eq('mercearia_id', mid);

      if (updErr) console.error(`[INVENTÁRIO] Erro ao atualizar produto ${item.produto_id}:`, updErr.message);

      // Registrar movimentação
      movimentacoes.push({
        mercearia_id:           mid,
        produto_id:             item.produto_id,
        produto_nome:           item.produto_nome,
        produto_marca:          item.produto_marca,
        unidade_medida:         item.unidade_medida,
        tipo:                   'inventario_ajuste',
        quantidade_anterior:    qtdAntes,
        quantidade_movimentacao: Math.abs(diff),
        quantidade_posterior:   qtdDepois,
        motivo:                 `Inventário: ${inv.nome}`,
        referencia_tipo:        'inventario',
        referencia_id:          id,
        categoria_nome:         item.produtos?.categorias?.nome || null,
        operador_id:            operadorId(req),
        usuario_nome:           req.user.nome || req.user.email,
      });

      valorDivTotal += Math.abs(diff) * parseFloat(item.preco_custo || 0);
    }

    if (movimentacoes.length) {
      const { error: movErr } = await db.from('movimentacoes_estoque').insert(movimentacoes);
      if (movErr) console.error('[INVENTÁRIO] Erro movimentações:', movErr.message);
    }

    // Finalizar inventário
    await db.from('inventarios').update({
      status:            'finalizado',
      finalizado_em:     new Date().toISOString(),
      produtos_contados: itens.length,
      total_divergencias: itensAplicar.filter(i => i.diferenca !== 0).length,
      valor_divergencia: valorDivTotal,
    }).eq('id', id);

    registrar({
      mercearia_id:  mid,
      operador_id:   operadorId(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'inventario', acao: 'inventario_finalizado',
      descricao: `Inventário "${inv.nome}" finalizado — ${itensAplicar.length} ajustes aplicados`,
      meta: { inventario_id: id, ajustes: itensAplicar.length, valor_divergencia: valorDivTotal },
    });

    res.json({
      success: true,
      ajustes: itensAplicar.length,
      valor_divergencia: valorDivTotal,
      mensagem: `${itensAplicar.length} produto(s) ajustado(s) no estoque.`,
    });
  } catch (err) {
    console.error('[INVENTÁRIO] Finalizar:', err.message);
    res.status(500).json({ error: 'Erro ao finalizar inventário' });
  }
});

/* ════════════════════════════════════════════════════════════
   6. CANCELAR INVENTÁRIO
   PATCH /api/inventario/:id/cancelar
════════════════════════════════════════════════════════════ */
router.patch('/:id/cancelar', verificarPermissao(PERMISSOES.INVENTARIO_CONTAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;

  try {
    const { data: inv } = await db
      .from('inventarios')
      .select('id, nome, status')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (!inv) return res.status(404).json({ error: 'Inventário não encontrado' });
    if (inv.status !== 'em_andamento') return res.status(400).json({ error: 'Só é possível cancelar inventários em andamento' });

    await db.from('inventarios').update({ status: 'cancelado' }).eq('id', id);

    registrar({
      mercearia_id:  mid,
      operador_id:   operadorId(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'inventario', acao: 'inventario_cancelado',
      descricao: `Inventário "${inv.nome}" cancelado`,
      meta: { inventario_id: id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[INVENTÁRIO] Cancelar:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar inventário' });
  }
});

/* ════════════════════════════════════════════════════════════
   7. LISTAR MOVIMENTAÇÕES
   GET /api/inventario/movimentacoes?tipo=&produto=&data_inicio=&data_fim=&limit=50&offset=0
════════════════════════════════════════════════════════════ */
router.get('/movimentacoes/listar', verificarPermissao(PERMISSOES.INVENTARIO), async (req, res) => {
  const mid = mercearia(req);
  if (!mid) return res.status(403).json({ error: 'Sem mercearia vinculada' });

  const { tipo, produto, data_inicio, data_fim, limit = 50, offset = 0 } = req.query;

  try {
    let q = db
      .from('movimentacoes_estoque')
      .select('*', { count: 'exact' })
      .eq('mercearia_id', mid)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (tipo)        q = q.eq('tipo', tipo);
    if (produto)     q = q.ilike('produto_nome', `%${produto}%`);
    if (data_inicio) q = q.gte('created_at', data_inicio + 'T00:00:00-03:00');
    if (data_fim)    q = q.lte('created_at', data_fim + 'T23:59:59-03:00');
    if (req.query.categoria) q = q.eq('categoria_nome', req.query.categoria);

    const { data, error, count } = await q;
    if (error) throw error;

    res.json({ movimentacoes: data || [], total: count || 0 });
  } catch (err) {
    console.error('[INVENTÁRIO] Movimentações:', err.message);
    res.status(500).json({ error: 'Erro ao listar movimentações' });
  }
});

/* ════════════════════════════════════════════════════════════
   8. AJUSTE RÁPIDO DE ESTOQUE
   POST /api/inventario/ajuste-rapido
   body: { produto_id, tipo, quantidade, motivo }
════════════════════════════════════════════════════════════ */
router.post('/ajuste-rapido', verificarPermissao(PERMISSOES.INVENTARIO_AJUSTE), async (req, res) => {
  const mid = mercearia(req);
  if (!mid) return res.status(403).json({ error: 'Sem mercearia vinculada' });

  const { produto_id, tipo, quantidade, motivo } = req.body;

  const tiposValidos = ['entrada', 'saida', 'perda', 'devolucao', 'correcao'];
  if (!produto_id)                    return res.status(400).json({ error: 'Produto obrigatório' });
  if (!tiposValidos.includes(tipo))   return res.status(400).json({ error: 'Tipo inválido' });
  if (!quantidade || parseFloat(quantidade) <= 0)
    return res.status(400).json({ error: 'Quantidade deve ser maior que zero' });
  if (!motivo?.trim())                return res.status(400).json({ error: 'Motivo é obrigatório' });

  try {
    const { data: produto } = await db
      .from('produtos')
      .select('id, nome, marca, unidade_medida, estoque_atual, categoria_id, categorias(nome)')
      .eq('id', produto_id)
      .eq('mercearia_id', mid)
      .single();

    if (!produto) return res.status(404).json({ error: 'Produto não encontrado' });

    const qtdAntes = parseFloat(produto.estoque_atual) || 0;
    const qtd      = parseFloat(quantidade);
    let   qtdDepois;

    // Calcular novo estoque conforme tipo
    if (['entrada', 'devolucao'].includes(tipo)) {
      qtdDepois = qtdAntes + qtd;
    } else if (['saida', 'perda'].includes(tipo)) {
      qtdDepois = Math.max(0, qtdAntes - qtd);
    } else if (tipo === 'correcao') {
      qtdDepois = qtd; // correção define o valor absoluto
    }

    // Atualizar estoque
    const { error: updErr } = await db
      .from('produtos')
      .update({ estoque_atual: qtdDepois })
      .eq('id', produto_id)
      .eq('mercearia_id', mid);

    if (updErr) throw updErr;

    // Registrar movimentação
    await db.from('movimentacoes_estoque').insert({
      mercearia_id:           mid,
      produto_id:             produto.id,
      produto_nome:           produto.nome,
      produto_marca:          produto.marca,
      unidade_medida:         produto.unidade_medida,
      tipo,
      quantidade_anterior:    qtdAntes,
      quantidade_movimentacao: qtd,
      quantidade_posterior:   qtdDepois,
      motivo:                 motivo.trim(),
      referencia_tipo:        'ajuste_manual',
      categoria_nome:         produto.categorias?.nome || null,
      operador_id:            operadorId(req),
      usuario_nome:           req.user.nome || req.user.email,
    });

    const tipoLabel = { entrada: 'Entrada', saida: 'Saída', perda: 'Perda', devolucao: 'Devolução', correcao: 'Correção' }[tipo];

    registrar({
      mercearia_id:  mid,
      operador_id:   operadorId(req),
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo: 'inventario', acao: 'ajuste_estoque',
      descricao: `${tipoLabel} manual: "${produto.nome}" — ${fmtQtd(qtdAntes, produto.unidade_medida)} → ${fmtQtd(qtdDepois, produto.unidade_medida)}`,
      meta: { produto_id, tipo, quantidade: qtd, qtdAntes, qtdDepois, motivo },
    });

    res.json({
      success: true,
      produto_nome:       produto.nome,
      quantidade_anterior: qtdAntes,
      quantidade_posterior: qtdDepois,
      diferenca:          qtdDepois - qtdAntes,
    });
  } catch (err) {
    console.error('[INVENTÁRIO] Ajuste rápido:', err.message);
    res.status(500).json({ error: 'Erro ao registrar ajuste' });
  }
});

module.exports = router;