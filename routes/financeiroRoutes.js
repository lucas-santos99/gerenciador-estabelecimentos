// ===== routes/financeiroRoutes.js (VERSÃO RLS + JWT + PERMISSÕES) =====

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');

// 🔥 NOVO
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');


// ============================================================
// 1) LISTAR CONTAS A PAGAR
// ============================================================

router.get('/',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);
    const { status } = req.query;

    try {

        let query = supabase.from('contas_a_pagar').select('*');

        if (status === 'pendente') {
            query = query
                .eq('status', 'pendente')
                .gte('data_vencimento', new Date().toISOString());
        }

        else if (status === 'paga') {
            query = query.eq('status', 'paga');
        }

        else if (status === 'atrasada') {
            query = query
                .eq('status', 'pendente')
                .lt('data_vencimento', new Date().toISOString());
        }

        query = query.order('data_vencimento', { ascending: true });

        const { data, error } = await query;

        if (error) throw error;

        const contas = data.map(c => {

            if (c.status === 'pendente' && new Date(c.data_vencimento) < new Date()) {
                return { ...c, status: 'atrasada' };
            }

            return c;

        });

        res.status(200).json(contas);

    } catch (error) {

        console.error('[ERRO] GET /api/financeiro:', error.message);

        res.status(500).json({
            error: 'Erro ao buscar contas a pagar.'
        });

    }

});


// ============================================================
// 2) RESUMO DO CAIXA (DIA)
// ============================================================

router.get('/resumo',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    try {

        const { data: transacoes, error } = await supabase
            .from('transacoes_caixa')
            .select('tipo, meio_pagamento, valor')
            .eq('tipo', 'entrada')
            .gte('data_transacao', todayStart.toISOString());

        if (error) throw error;

        let resumo = {
            total_entradas_dia: 0,
            total_dinheiro: 0,
            total_pix: 0,
            total_cartao: 0
        };

        transacoes.forEach(t => {

            const valor = parseFloat(t.valor);

            resumo.total_entradas_dia += valor;

            const meio = t.meio_pagamento ? t.meio_pagamento.toLowerCase() : '';

            if (meio === 'dinheiro') resumo.total_dinheiro += valor;
            else if (meio === 'pix') resumo.total_pix += valor;
            else if (meio === 'debito' || meio === 'credito' || meio === 'cartao')
                resumo.total_cartao += valor;

        });

        res.status(200).json(resumo);

    } catch (error) {

        console.error('[ERRO] GET /api/financeiro/resumo:', error.message);

        res.status(500).json({
            error: 'Erro ao gerar resumo financeiro.'
        });

    }

});


// ============================================================
// 3) CRIAR CONTA A PAGAR
// ============================================================

router.post('/',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);

    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {

        return res.status(400).json({
            error: 'Todos os campos obrigatórios devem ser preenchidos.'
        });

    }

    try {

        const { data, error } = await supabase
            .from('contas_a_pagar')
            .insert({
                descricao,
                valor: parseFloat(valor),
                data_vencimento,
                status: 'pendente'
            })
            .select()
            .single();

        if (error) throw error;

        console.log(`[INFO] Nova conta registrada: ${data.descricao}`);

        res.status(201).json(data);

    } catch (error) {

        console.error('[ERRO] POST /api/financeiro:', error.message);

        res.status(500).json({
            error: 'Erro ao registrar a conta.'
        });

    }

});


// ============================================================
// 4) MARCAR CONTA COMO PAGA
// ============================================================

router.put('/:contaId/pagar',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);
    const { contaId } = req.params;

    try {

        const { data, error } = await supabase
            .from('contas_a_pagar')
            .update({
                status: 'paga',
                data_pagamento: new Date().toISOString()
            })
            .eq('id', contaId)
            .select()
            .single();

        if (error) throw error;

        if (!data) {

            return res.status(404).json({
                error: 'Conta não encontrada.'
            });

        }

        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/financeiro/${contaId}/pagar:`, error.message);

        res.status(500).json({
            error: 'Erro ao marcar conta como paga.'
        });

    }

});


// ============================================================
// 5) RELATÓRIO DRE
// ============================================================

router.get('/relatorio_dre',
    authUser,
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);

    const { data_inicio, data_fim } = req.query;

    if (!data_inicio || !data_fim) {

        return res.status(400).json({
            error: 'Data de início e fim são obrigatórias.'
        });

    }

    try {

        const { data, error } = await supabase.rpc('gerar_relatorio_dre', {
            p_data_inicio: data_inicio,
            p_data_fim: data_fim
        });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Relatório DRE:', error.message);

        res.status(500).json({
            error: 'Erro ao gerar relatório.'
        });

    }

});


// ============================================================
// 6) EXCLUIR CONTA
// ============================================================

router.delete('/:contaId',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);
    const { contaId } = req.params;

    try {

        const { data, error } = await supabase
            .from('contas_a_pagar')
            .delete()
            .eq('id', contaId)
            .eq('status', 'pendente')
            .select()
            .single();

        if (error) throw error;

        if (!data) {

            return res.status(404).json({
                error: 'Conta não encontrada ou já paga.'
            });

        }

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] DELETE conta:', error.message);

        res.status(500).json({
            error: 'Erro ao excluir conta.'
        });

    }

});


// ============================================================
// 7) EDITAR CONTA
// ============================================================

router.put('/:contaId',
    authUser,
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);
    const { contaId } = req.params;

    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {

        return res.status(400).json({
            error: 'Todos os campos são obrigatórios.'
        });

    }

    try {

        const { data, error } = await supabase
            .from('contas_a_pagar')
            .update({
                descricao,
                valor: parseFloat(valor),
                data_vencimento
            })
            .eq('id', contaId)
            .eq('status', 'pendente')
            .select()
            .single();

        if (error) throw error;

        if (!data) {

            return res.status(404).json({
                error: 'Conta não encontrada ou já paga.'
            });

        }

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] PUT conta:', error.message);

        res.status(500).json({
            error: 'Erro ao atualizar conta.'
        });

    }

});


// ============================================================
// 8) RELATÓRIO PRODUTOS VENDIDOS
// ============================================================

router.get('/relatorio_produtos',
    authUser,
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);

    const { data_inicio, data_fim, categoria_id } = req.query;

    if (!data_inicio || !data_fim) {

        return res.status(400).json({
            error: 'Datas obrigatórias.'
        });

    }

    try {

        const { data, error } = await supabase.rpc('gerar_relatorio_produtos', {
            p_data_inicio: data_inicio,
            p_data_fim: data_fim,
            p_categoria_id: categoria_id || null
        });

        if (error) throw error;

        res.status(200).json(data || []);

    } catch (error) {

        console.error('[ERRO] Relatório produtos:', error.message);

        res.status(500).json({
            error: 'Erro ao gerar relatório.'
        });

    }

});

module.exports = router;