const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');


// ============================================================
// FINALIZAR VENDA (PDV)
// ============================================================

router.post('/finalizar', authUser, async (req, res) => {

    const supabase = createSupabaseUserClient(req.userToken);

    const { valor_total, meio_pagamento, carrinho, clienteId } = req.body;

    const totalVendaFloat = parseFloat(valor_total);

    if (
        isNaN(totalVendaFloat) ||
        totalVendaFloat <= 0 ||
        !meio_pagamento ||
        !carrinho ||
        carrinho.length === 0
    ) {
        return res.status(400).json({
            error: 'Dados da venda incompletos ou valor total inválido.'
        });
    }

    if (meio_pagamento === 'Fiado' && !clienteId) {
        return res.status(400).json({
            error: 'ID do cliente é obrigatório para vendas fiado.'
        });
    }

    try {

        const { data: vendaId, error } = await supabase.rpc('finalizar_venda', {
            p_valor_total: totalVendaFloat,
            p_meio_pagamento: meio_pagamento,
            p_carrinho_itens: carrinho,
            p_cliente_id: clienteId || null
        });

        if (error) throw error;

        console.log(`[INFO] Venda finalizada. ID: ${vendaId}`);

        res.status(201).json({
            message: 'Venda registrada com sucesso!',
            vendaId
        });

    } catch (error) {

        console.error('[ERRO CRÍTICO] Falha ao finalizar venda:', error.message);

        res.status(500).json({
            error: 'Erro ao processar a venda. O estoque não foi alterado.'
        });

    }

});

module.exports = router;