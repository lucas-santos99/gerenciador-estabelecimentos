// ============================================================
// clienteRoutes.js (VERSÃO RLS + JWT)
// ============================================================

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');
const supabaseAdmin = require('../db/supabaseAdmin');
const { registrar } = require('./auditoriaRoutes');

router.use(authUser);

// ── Helper: Fiado é opcional por estabelecimento agora. Mesmo que o
// frontend já esconda a interface quando desativado, as rotas
// específicas de fiado (não o cadastro de cliente em si, que é
// universal) checam de novo aqui — nunca confiar só na tela escondida.
async function garantirFiadoAtivo(req, res) {
  const { data, error } = await supabaseAdmin
    .from('mercearias')
    .select('fiado_ativo')
    .eq('id', req.user.mercearia_id)
    .single();
  if (error || data?.fiado_ativo === false) {
    res.status(403).json({ error: 'O módulo de Fiado está desativado para este estabelecimento.' });
    return false;
  }
  return true;
}


// ============================================================
// 1) BUSCAR CLIENTES POR TERMO (PDV / BUSCA RÁPIDA)
// ============================================================

router.get('/buscar', async (req, res) => {

    const { termo } = req.query;

    if (!termo)
        return res.status(400).json({ error: 'Termo de busca é obrigatório.' });

    try {

        // Busca por nome, telefone, CPF (com ou sem pontuação) ou pelo
        // código curto do cliente (ex: digitou "42" → acha o #42)
        const termoLimpo = termo.replace(/\D/g, '');
        let query = supabaseAdmin
            .from('clientes')
            .select('id, nome, telefone, cpf, codigo_cliente, saldo_devedor, limite_credito')
            .eq('mercearia_id', req.user.mercearia_id);

        const filtros = [`nome.ilike.${termo}%`, `telefone.ilike.${termo}%`];
        if (termoLimpo) {
            filtros.push(`cpf.ilike.%${termoLimpo}%`);
            if (/^\d+$/.test(termoLimpo)) filtros.push(`codigo_cliente.eq.${termoLimpo}`);
        }
        query = query.or(filtros.join(',')).limit(10);

        const { data, error } = await query;

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Busca rápida clientes:', error.message);
        res.status(500).json({ error: 'Erro ao buscar clientes.' });

    }

});


// ============================================================
// 2) LISTAR CLIENTES (TELA CLIENTES / FIADO)
// ============================================================

router.get('/', async (req, res) => {

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .select('id, nome, telefone, cpf, codigo_cliente, saldo_devedor, limite_credito, data_vencimento')
            .eq('mercearia_id', req.user.mercearia_id)
            .order('nome', { ascending: true });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] GET /api/clientes:', error.message);
        res.status(500).json({ error: 'Erro ao carregar clientes.' });

    }

});


// ============================================================
// 3) LISTAR CLIENTES COM DÍVIDA
// ============================================================

router.get('/dividas', async (req, res) => {

    if (!(await garantirFiadoAtivo(req, res))) return;

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .select('id, nome, telefone, saldo_devedor, limite_credito, data_vencimento')
            .eq('mercearia_id', req.user.mercearia_id)
            .gt('saldo_devedor', 0.01)
            .order('saldo_devedor', { ascending: false });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Listar dívidas:', error.message);
        res.status(500).json({ error: 'Erro ao listar dívidas.' });

    }

});


// ============================================================
// 4) CRIAR CLIENTE
// ============================================================

router.post('/criar', async (req, res) => {

    const { nome, telefone, cpf, limiteCredito, dataVencimento } = req.body;

    if (!nome)
        return res.status(400).json({ error: 'Nome é obrigatório.' });

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .insert({
                nome,
                telefone:        telefone || null,
                cpf:             (cpf || '').replace(/\D/g, '') || null,
                mercearia_id:    req.user.mercearia_id,
                limite_credito:  parseFloat(limiteCredito) || 0,
                data_vencimento: dataVencimento || null,
            })
            .select()
            .single();

        if (error) throw error;

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo:       'clientes',
          acao:         'cliente_criado',
          descricao:    `Cliente "${nome}" criado`,
          meta:         { cliente_id: data.id },
        });

        res.status(201).json(data);

    } catch (error) {

        console.error('[ERRO] Criar cliente:', error.message);

        res.status(500).json({ error: 'Erro ao criar cliente.' });

    }

});


// ============================================================
// 5c) HISTÓRICO GERAL DE COMPRAS DO CLIENTE (qualquer forma de
//     pagamento — não só fiado. Útil pra cliente que nunca usa
//     fiado mas foi identificado na venda, ex: por CPF/código)
// ============================================================

router.get('/:clienteId/historico-compras', async (req, res) => {

    const { clienteId } = req.params;

    try {

        const { data: vendas, error } = await supabaseAdmin
            .from('vendas')
            .select('id, data_venda, valor_total, meio_pagamento')
            .eq('cliente_id', clienteId)
            .eq('mercearia_id', req.user.mercearia_id)
            .order('data_venda', { ascending: false })
            .limit(100);

        if (error) throw error;

        const vendaIds = (vendas || []).map(v => v.id);
        const itensPorVenda = {};
        if (vendaIds.length > 0) {
            const { data: itens } = await supabaseAdmin
                .from('itens_venda')
                .select('venda_id, produto_nome, quantidade, preco_unitario, unidade_medida')
                .in('venda_id', vendaIds);
            (itens || []).forEach(i => {
                if (!itensPorVenda[i.venda_id]) itensPorVenda[i.venda_id] = [];
                itensPorVenda[i.venda_id].push(i);
            });
        }

        const resultado = (vendas || []).map(v => ({ ...v, itens: itensPorVenda[v.id] || [] }));

        res.status(200).json(resultado);

    } catch (error) {

        console.error('[ERRO] Histórico de compras cliente:', error.message);
        res.status(500).json({ error: 'Erro ao buscar histórico de compras.' });

    }

});


// ============================================================
// 5b) HISTÓRICO DE PAGAMENTOS DO CLIENTE
// ============================================================

router.get('/:clienteId/pagamentos', async (req, res) => {

    const { clienteId } = req.params;

    try {

        const { data, error } = await supabaseAdmin
            .from('transacoes_caixa')
            .select('id, valor, meio_pagamento, data_transacao, descricao')
            .eq('cliente_id', clienteId)
            .eq('tipo', 'entrada')
            .order('data_transacao', { ascending: false });

        if (error) throw error;

        res.status(200).json(data || []);

    } catch (error) {

        console.error('[ERRO] Pagamentos cliente:', error.message);
        res.status(500).json({ error: 'Erro ao buscar pagamentos.' });

    }

});


// ============================================================
// 5) LISTAR ITENS DO FIADO
// ============================================================

router.get('/:clienteId/itens-fiado', async (req, res) => {

    if (!(await garantirFiadoAtivo(req, res))) return;

    const { clienteId } = req.params;

    try {

        const { data, error } = await supabaseAdmin.rpc('listar_itens_fiado', {
            p_cliente_id: clienteId
        });

        if (error) throw error;

        const vendasAgrupadas = data.reduce((acc, item) => {

            if (!acc[item.venda_id]) {
                acc[item.venda_id] = {
                    venda_id: item.venda_id,
                    data_venda: item.data_venda,
                    valor_total: item.valor_total,
                    itens: []
                };
            }

            if (item.produto_nome) {
                acc[item.venda_id].itens.push({
                    produto_nome:   item.produto_nome,
                    quantidade:     item.quantidade,
                    preco_unitario: item.preco_unitario,
                    unidade_medida: item.unidade_medida || 'un',
                });
            }

            return acc;

        }, {});

        res.status(200).json(Object.values(vendasAgrupadas));

    } catch (error) {

        console.error('[ERRO] Itens fiado:', error.message);
        res.status(500).json({ error: 'Erro ao listar itens do fiado.' });

    }

});


// ============================================================
// 6b) PAGAR VENDA ESPECÍFICA DO FIADO
// ============================================================

router.post('/pagar-venda', async (req, res) => {

    if (!(await garantirFiadoAtivo(req, res))) return;

    const { vendaId, clienteId, meioPagamento } = req.body;

    if (!vendaId || !clienteId || !meioPagamento)
        return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });

    try {

        const { data: novoSaldo, error } = await supabaseAdmin.rpc('pagar_venda_fiado', {
            p_venda_id:        vendaId,
            p_cliente_id:      clienteId,
            p_mercearia_id:    req.user.mercearia_id,
            p_meio_pagamento:  meioPagamento,
        });

        if (error) return res.status(400).json({ error: error.message });

        const { data: clienteInfo } = await supabaseAdmin
            .from('clientes')
            .select('nome')
            .eq('id', clienteId)
            .single();
        const nomeCliente = clienteInfo?.nome || 'cliente';

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo:       'clientes',
          acao:         'fiado_recebido',
          descricao:    `Recebimento de venda fiado de "${nomeCliente}" — ${meioPagamento}`,
          meta:         { venda_id: vendaId, cliente_id: clienteId, cliente_nome: nomeCliente, meio_pagamento: meioPagamento },
        });

        res.status(200).json({
            message: 'Venda paga com sucesso.',
            novo_saldo: novoSaldo
        });

    } catch (error) {

        console.error('[ERRO] Pagar venda fiado:', error.message);
        res.status(500).json({ error: 'Erro ao pagar venda.' });

    }

});


// ============================================================
// 6) LIQUIDAR FIADO
// ============================================================

router.post('/liquidar', async (req, res) => {

    if (!(await garantirFiadoAtivo(req, res))) return;

    const { clienteId, valorPago, meioPagamento } = req.body;

    if (!clienteId || !valorPago || !meioPagamento)
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });

    try {

        const { data: novoSaldo, error } = await supabaseAdmin.rpc('liquidar_fiado', {
            p_cliente_id: clienteId,
            p_valor_pago: parseFloat(valorPago),
            p_meio_pagamento: meioPagamento
        });

        if (error) return res.status(400).json({ error: error.message });

        const { data: clienteInfo } = await supabaseAdmin
            .from('clientes')
            .select('nome')
            .eq('id', clienteId)
            .single();
        const nomeCliente = clienteInfo?.nome || 'cliente';

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo:       'clientes',
          acao:         'fiado_recebido',
          descricao:    `Recebimento de fiado de "${nomeCliente}" — ${parseFloat(valorPago).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} (${meioPagamento})`,
          meta:         { cliente_id: clienteId, cliente_nome: nomeCliente, valor: parseFloat(valorPago), meio_pagamento: meioPagamento },
        });

        res.status(200).json({
            message: 'Pagamento registrado com sucesso.',
            novo_saldo: novoSaldo
        });

    } catch (error) {

        console.error('[ERRO] Liquidar fiado:', error.message);
        res.status(500).json({ error: 'Erro ao registrar pagamento.' });

    }

});


// ============================================================
// 7) ATUALIZAR CLIENTE
// ============================================================

router.put('/atualizar/:clienteId', async (req, res) => {

    const { clienteId } = req.params;
    const { nome, telefone, cpf, limiteCredito, dataVencimento } = req.body;

    if (!nome)
        return res.status(400).json({ error: 'Nome é obrigatório.' });

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .update({
                nome,
                telefone:        telefone || null,
                cpf:             (cpf || '').replace(/\D/g, '') || null,
                limite_credito:  parseFloat(limiteCredito) || 0,
                data_vencimento: dataVencimento || null
            })
            .eq('id', clienteId)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.email,
          modulo: 'clientes', acao: 'cliente_editado',
          descricao: `Cliente "${nome}" atualizado`,
          meta: { cliente_id: clienteId, depois: { nome, limite_credito: parseFloat(limiteCredito) || 0 } },
        });

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Atualizar cliente:', error.message);
        res.status(500).json({ error: 'Erro ao atualizar cliente.' });

    }

});


// ============================================================
// 8) EXCLUIR CLIENTE
// ============================================================

router.delete('/deletar/:clienteId', async (req, res) => {

    const { clienteId } = req.params;

    try {

        const { data, error } = await supabaseAdmin.rpc('deletar_cliente_seguro', {
            p_cliente_id: clienteId
        });

        if (error) throw error;

        if (data === true) {
            registrar({
              mercearia_id: req.user.mercearia_id,
              operador_id:  req.user.role === 'operator' ? req.user.id : null,
              usuario_nome: req.user.email,
              modulo: 'clientes', acao: 'cliente_excluido',
              descricao: `Cliente excluído (id: ${clienteId})`,
              meta: { cliente_id: clienteId },
            });
            return res.status(200).json({ message: 'Cliente excluído com sucesso.' });
        } else {
            return res.status(400).json({ error: 'Não é possível excluir cliente com saldo pendente.' });
        }

    } catch (error) {

        console.error('[ERRO] Excluir cliente:', error.message);
        res.status(400).json({
            error: error.message.includes('Não é possível')
                ? error.message
                : 'Erro ao excluir cliente.'
        });

    }

});


// ============================================================

module.exports = router;