// routes/fornecedoresRoutes.js
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

/* ════════════════════════════════════════════════════════════
   1. LISTAR FORNECEDORES (com números rápidos: gasto no mês,
      última compra, formas de pagamento já usadas) — GET /api/fornecedores?busca=
════════════════════════════════════════════════════════════ */
router.get('/', verificarPermissao(PERMISSOES.FORNECEDORES_ADICIONAR), async (req, res) => {
  const mid = mercearia(req);
  const { busca } = req.query;

  try {
    let query = db
      .from('fornecedores')
      .select('*')
      .eq('mercearia_id', mid)
      .eq('ativo', true)
      .order('nome');

    if (busca) query = query.ilike('nome', `%${busca}%`);

    const { data: fornecedores, error } = await query;
    if (error) throw error;

    if (!fornecedores || fornecedores.length === 0) return res.json([]);

    // Números rápidos: gasto no mês corrente + data da última compra +
    // quais formas de pagamento (à vista / a prazo) já apareceram nas
    // compras ativas desse fornecedor, numa única passada
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);

    const { data: compras } = await db
      .from('compras')
      .select('fornecedor_id, valor_total, data_compra, forma_pagamento')
      .eq('mercearia_id', mid)
      .eq('status', 'ativa')
      .order('data_compra', { ascending: false });

    const resumoPorFornecedor = {};
    (compras || []).forEach(c => {
      if (!resumoPorFornecedor[c.fornecedor_id]) {
        resumoPorFornecedor[c.fornecedor_id] = { gasto_mes: 0, ultima_compra: null, formasPagamento: new Set() };
      }
      const r = resumoPorFornecedor[c.fornecedor_id];
      if (!r.ultima_compra) r.ultima_compra = c.data_compra; // já vem ordenado desc
      if (new Date(c.data_compra) >= inicioMes) r.gasto_mes += parseFloat(c.valor_total) || 0;
      if (c.forma_pagamento) r.formasPagamento.add(c.forma_pagamento);
    });

    const resultado = fornecedores.map(f => ({
      ...f,
      gasto_mes:        resumoPorFornecedor[f.id]?.gasto_mes || 0,
      ultima_compra:    resumoPorFornecedor[f.id]?.ultima_compra || null,
      formas_pagamento: Array.from(resumoPorFornecedor[f.id]?.formasPagamento || []),
    }));

    res.json(resultado);
  } catch (err) {
    console.error('[FORNECEDORES] Erro listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar fornecedores' });
  }
});

/* ════════════════════════════════════════════════════════════
   2. BUSCAR FORNECEDOR (pra selects rápidos, ex: tela de compra)
      GET /api/fornecedores/buscar-rapido?termo=
════════════════════════════════════════════════════════════ */
router.get('/buscar-rapido', async (req, res) => {
  const mid = mercearia(req);
  const { termo } = req.query;
  try {
    let query = db
      .from('fornecedores')
      .select('id, nome, condicao_pagamento')
      .eq('mercearia_id', mid)
      .eq('ativo', true)
      .order('nome')
      .limit(10);

    if (termo) query = query.ilike('nome', `%${termo}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar fornecedores' });
  }
});

/* ════════════════════════════════════════════════════════════
   3. DETALHES DO FORNECEDOR — histórico + produtos fornecidos
      GET /api/fornecedores/:id
════════════════════════════════════════════════════════════ */
router.get('/:id', verificarPermissao(PERMISSOES.FORNECEDORES_ADICIONAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;

  try {
    const { data: fornecedor, error } = await db
      .from('fornecedores')
      .select('*')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (error || !fornecedor) return res.status(404).json({ error: 'Fornecedor não encontrado' });

    const { data: compras } = await db
      .from('compras')
      .select('id, numero_nota, data_compra, forma_pagamento, valor_total, status')
      .eq('fornecedor_id', id)
      .order('data_compra', { ascending: false })
      .limit(50);

    // Itens de cada compra (produto, quantidade, custo, subtotal) — usado
    // pra exportar o histórico com o detalhe do que foi comprado, sem
    // precisar de uma chamada por compra
    const compraIds = (compras || []).map(c => c.id);
    const itensPorCompra = {};
    if (compraIds.length > 0) {
      const { data: itensCompras } = await db
        .from('itens_compra')
        .select('compra_id, produto_nome, produto_marca, unidade_medida, quantidade, preco_custo_unitario, subtotal')
        .in('compra_id', compraIds);
      (itensCompras || []).forEach(i => {
        if (!itensPorCompra[i.compra_id]) itensPorCompra[i.compra_id] = [];
        itensPorCompra[i.compra_id].push(i);
      });
    }
    const comprasComItens = (compras || []).map(c => ({ ...c, itens: itensPorCompra[c.id] || [] }));

    // Produtos fornecidos + último preço de custo pago e quantidade da
    // última compra, derivados dos itens
    const { data: itens } = await db
      .from('itens_compra')
      .select('produto_id, produto_nome, produto_marca, unidade_medida, quantidade, preco_custo_unitario, compras!inner(fornecedor_id, data_compra, status)')
      .eq('compras.fornecedor_id', id)
      .eq('compras.status', 'ativa')
      .order('compras(data_compra)', { ascending: false });

    const produtosMap = {};
    (itens || []).forEach(i => {
      if (!produtosMap[i.produto_id]) {
        produtosMap[i.produto_id] = {
          produto_id: i.produto_id,
          produto_nome: i.produto_nome,
          produto_marca: i.produto_marca,
          unidade_medida: i.unidade_medida,
          ultimo_preco: i.preco_custo_unitario, // primeiro da lista = mais recente (já ordenado)
          ultima_quantidade: i.quantidade,
        };
      }
    });

    const comprasAtivas = (comprasComItens || []).filter(c => c.status === 'ativa');
    const totalGasto = comprasAtivas.reduce((acc, c) => acc + (parseFloat(c.valor_total) || 0), 0);

    res.json({
      ...fornecedor,
      total_gasto_historico: totalGasto,
      total_compras: comprasAtivas.length,
      compras: comprasComItens,
      produtos_fornecidos: Object.values(produtosMap),
    });
  } catch (err) {
    console.error('[FORNECEDORES] Erro detalhes:', err.message);
    res.status(500).json({ error: 'Erro ao buscar fornecedor' });
  }
});

/* ════════════════════════════════════════════════════════════
   4. CRIAR FORNECEDOR — POST /api/fornecedores
════════════════════════════════════════════════════════════ */
router.post('/', verificarPermissao(PERMISSOES.FORNECEDORES_ADICIONAR), async (req, res) => {
  const mid = mercearia(req);
  const {
    nome, razao_social, cnpj_cpf, telefone, whatsapp, email,
    endereco, contato_nome, prazo_entrega_dias, condicao_pagamento, observacoes,
  } = req.body;

  if (!nome?.trim()) return res.status(400).json({ error: 'Nome do fornecedor é obrigatório' });

  try {
    const { data, error } = await db
      .from('fornecedores')
      .insert({
        mercearia_id: mid,
        nome: nome.trim(),
        razao_social: razao_social?.trim() || null,
        cnpj_cpf: cnpj_cpf?.replace(/\D/g, '') || null,
        telefone: telefone || null,
        whatsapp: whatsapp?.replace(/\D/g, '') || null,
        email: email?.trim() || null,
        endereco: endereco?.trim() || null,
        contato_nome: contato_nome?.trim() || null,
        prazo_entrega_dias: prazo_entrega_dias ? parseInt(prazo_entrega_dias) : null,
        condicao_pagamento: condicao_pagamento || null,
        observacoes: observacoes?.trim() || null,
      })
      .select()
      .single();

    if (error) throw error;

    registrar({
      mercearia_id: mid,
      operador_id: operadorId(req),
      usuario_nome: req.user.nome,
      usuario_email: req.user.email,
      modulo: 'fornecedores', acao: 'criar_fornecedor',
      descricao: `Cadastrou o fornecedor "${nome}"`,
      meta: { fornecedor_id: data.id },
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('[FORNECEDORES] Erro criar:', err.message);
    res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

/* ════════════════════════════════════════════════════════════
   5. EDITAR FORNECEDOR — PUT /api/fornecedores/:id
════════════════════════════════════════════════════════════ */
router.put('/:id', verificarPermissao(PERMISSOES.FORNECEDORES_EDITAR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;
  const {
    nome, razao_social, cnpj_cpf, telefone, whatsapp, email,
    endereco, contato_nome, prazo_entrega_dias, condicao_pagamento, observacoes,
  } = req.body;

  if (!nome?.trim()) return res.status(400).json({ error: 'Nome do fornecedor é obrigatório' });

  try {
    const { data, error } = await db
      .from('fornecedores')
      .update({
        nome: nome.trim(),
        razao_social: razao_social?.trim() || null,
        cnpj_cpf: cnpj_cpf?.replace(/\D/g, '') || null,
        telefone: telefone || null,
        whatsapp: whatsapp?.replace(/\D/g, '') || null,
        email: email?.trim() || null,
        endereco: endereco?.trim() || null,
        contato_nome: contato_nome?.trim() || null,
        prazo_entrega_dias: prazo_entrega_dias ? parseInt(prazo_entrega_dias) : null,
        condicao_pagamento: condicao_pagamento || null,
        observacoes: observacoes?.trim() || null,
      })
      .eq('id', id)
      .eq('mercearia_id', mid)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Fornecedor não encontrado' });

    registrar({
      mercearia_id: mid,
      operador_id: operadorId(req),
      usuario_nome: req.user.nome,
      usuario_email: req.user.email,
      modulo: 'fornecedores', acao: 'editar_fornecedor',
      descricao: `Editou o fornecedor "${nome}"`,
      meta: { fornecedor_id: id },
    });

    res.json(data);
  } catch (err) {
    console.error('[FORNECEDORES] Erro editar:', err.message);
    res.status(500).json({ error: 'Erro ao editar fornecedor' });
  }
});

/* ════════════════════════════════════════════════════════════
   6. EXCLUIR (soft) FORNECEDOR — DELETE /api/fornecedores/:id
════════════════════════════════════════════════════════════ */
router.delete('/:id', verificarPermissao(PERMISSOES.FORNECEDORES_EXCLUIR), async (req, res) => {
  const mid = mercearia(req);
  const { id } = req.params;

  try {
    const { data: fornecedor } = await db
      .from('fornecedores')
      .select('nome')
      .eq('id', id)
      .eq('mercearia_id', mid)
      .single();

    if (!fornecedor) return res.status(404).json({ error: 'Fornecedor não encontrado' });

    const { error } = await db
      .from('fornecedores')
      .update({ ativo: false })
      .eq('id', id)
      .eq('mercearia_id', mid);

    if (error) throw error;

    registrar({
      mercearia_id: mid,
      operador_id: operadorId(req),
      usuario_nome: req.user.nome,
      usuario_email: req.user.email,
      modulo: 'fornecedores', acao: 'excluir_fornecedor',
      descricao: `Excluiu o fornecedor "${fornecedor.nome}"`,
      meta: { fornecedor_id: id },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[FORNECEDORES] Erro excluir:', err.message);
    res.status(500).json({ error: 'Erro ao excluir fornecedor' });
  }
});

module.exports = router;