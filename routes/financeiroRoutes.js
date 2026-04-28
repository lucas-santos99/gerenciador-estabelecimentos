console.log("🔥 FINANCEIRO ROUTES ATUALIZADO 🔥");
// ===== routes/financeiroRoutes.js (VERSÃO RLS + JWT + PERMISSÕES) =====

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
//const createSupabaseUserClient = require('../db/supabaseUser');

// 🔥 PROTEGE TODAS AS ROTAS
router.use(authUser);

// 🔥 NOVO
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');



// ============================================================
// 1) LISTAR CONTAS A PAGAR
// ============================================================

router.get('/',
    //verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;
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
  error: error.message,
  detalhe: error
});

    }

});


// ============================================================
// 2) RESUMO DO CAIXA (DIA)
// ============================================================

router.get('/resumo',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;

    // Início do dia no timezone de Brasília (UTC-3)
    // Usa a data atual em UTC e subtrai 3 horas para alinhar com BRT
    const now = new Date();
    const todayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0, 0
    ));

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        const { data: transacoes, error } = await supabaseAdmin
            .from('transacoes_caixa')
            .select('tipo, meio_pagamento, valor')
            .eq('mercearia_id', req.user.mercearia_id)
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
  error: error.message,
  detalhe: error
});

    }

});


// ============================================================
// 3) CRIAR CONTA A PAGAR
// ============================================================

router.post('/',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;

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
  error: error.message,
  detalhe: error
});

    }

});


// ============================================================
// 4) MARCAR CONTA COMO PAGA
// ============================================================

router.put('/:contaId/pagar',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;
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
  error: error.message,
  detalhe: error
});
    }

});


// ============================================================
// 5) RELATÓRIO DRE
// ============================================================

router.get('/relatorio_dre',
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const supabase = req.supabase;

    const { data_inicio, data_fim } = req.query;

    if (!data_inicio || !data_fim) {

        return res.status(400).json({
            error: 'Data de início e fim são obrigatórias.'
        });

    }

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        const { data, error } = await supabaseAdmin.rpc('gerar_relatorio_dre', {
            p_data_inicio: data_inicio,
            p_data_fim: data_fim,
            p_mercearia_id: req.user.mercearia_id
        });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Relatório DRE:', error.message);

       res.status(500).json({
  error: error.message,
  detalhe: error
});
    }

});


// ============================================================
// 6) EXCLUIR CONTA
// ============================================================

router.delete('/:contaId',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;
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
  error: error.message,
  detalhe: error
});
    }

});


// ============================================================
// 7) EDITAR CONTA
// ============================================================

router.put('/:contaId',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabase = req.supabase;
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
  error: error.message,
  detalhe: error
});
    }

});


// ============================================================
// 8) RELATÓRIO PRODUTOS VENDIDOS
// ============================================================

router.get('/relatorio_produtos',
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const supabase = req.supabase;

    const { data_inicio, data_fim, categoria_id } = req.query;

    if (!data_inicio || !data_fim) {

        return res.status(400).json({
            error: 'Datas obrigatórias.'
        });

    }

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        const { data, error } = await supabaseAdmin.rpc('gerar_relatorio_produtos', {
            p_data_inicio: data_inicio,
            p_data_fim: data_fim,
            p_categoria_id: categoria_id || null,
            p_mercearia_id: req.user.mercearia_id
        });

        if (error) throw error;

        res.status(200).json(data || []);

    } catch (error) {

        console.error('[ERRO] Relatório produtos:', error.message);

       res.status(500).json({
  error: error.message,
  detalhe: error
});
    }

});

module.exports = router;