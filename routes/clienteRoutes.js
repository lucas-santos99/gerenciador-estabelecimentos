// ============================================================
// clienteRoutes.js (VERSÃO RLS + JWT)
// ============================================================

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');
const supabaseAdmin = require('../db/supabaseAdmin');

// 🔥 PROTEGE TODAS AS ROTAS
router.use(authUser);


// ============================================================
// 1) BUSCAR CLIENTES POR TERMO (PDV / BUSCA RÁPIDA)
// ============================================================

router.get('/buscar', async (req, res) => {

    const { termo } = req.query;

    if (!termo)
        return res.status(400).json({ error: 'Termo de busca é obrigatório.' });

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .select('id, nome, telefone, saldo_devedor, limite_credito')
            .eq('mercearia_id', req.user.mercearia_id)
            .or(`nome.ilike.${termo}%,telefone.ilike.${termo}%`)
            .limit(10);

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
            .select('id, nome, telefone, saldo_devedor, limite_credito, data_vencimento')
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

    const { nome, telefone, limiteCredito, dataVencimento } = req.body;

    if (!nome)
        return res.status(400).json({ error: 'Nome é obrigatório.' });

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .insert({
                nome,
                telefone:        telefone || null,
                mercearia_id:    req.user.mercearia_id,
                limite_credito:  parseFloat(limiteCredito) || 0,
                data_vencimento: dataVencimento || null,
            })
            .select()
            .single();

        if (error) throw error;

        res.status(201).json(data);

    } catch (error) {

        console.error('[ERRO] Criar cliente:', error.message);

        res.status(500).json({ error: 'Erro ao criar cliente.' });

    }

});


// ============================================================
// 5) LISTAR ITENS DO FIADO
// ============================================================

router.get('/:clienteId/itens-fiado', async (req, res) => {

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
                    produto_nome: item.produto_nome,
                    quantidade: item.quantidade,
                    preco_unitario: item.preco_unitario
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
// 6) LIQUIDAR FIADO
// ============================================================

router.post('/liquidar', async (req, res) => {

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
    const { nome, telefone, limiteCredito, dataVencimento } = req.body;

    if (!nome)
        return res.status(400).json({ error: 'Nome é obrigatório.' });

    try {

        const { data, error } = await supabaseAdmin
            .from('clientes')
            .update({
                nome,
                telefone:        telefone || null,
                limite_credito:  parseFloat(limiteCredito) || 0,
                data_vencimento: dataVencimento || null
            })
            .eq('id', clienteId)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

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