const express = require('express');
const db = require('../db/supabaseAdmin'); // Cliente Supabase Admin
const router = express.Router();

// --- Rota POST /finalizar (Atualizada para RPC - Transação Segura) ---
router.post('/finalizar', async (req, res) => {
    
    const { estabelecimentoId, valor_total, meio_pagamento, carrinho, clienteId } = req.body;
    
    const totalVendaFloat = parseFloat(valor_total); 

    if (!estabelecimentoId || isNaN(totalVendaFloat) || totalVendaFloat <= 0 || !meio_pagamento || !carrinho || carrinho.length === 0) {
        return res.status(400).json({ error: 'Dados da venda incompletos ou valor total inválido.' });
    }
    if (meio_pagamento === 'Fiado' && (!clienteId || typeof clienteId !== 'string')) {
        return res.status(400).json({ error: 'ID do Cliente é obrigatório para vendas fiado.' });
    }

    try {
        // O Supabase (JS) não suporta transações complexas (BEGIN/COMMIT) via API
        // A maneira correta é criar uma "Stored Procedure" (Função SQL) no Supabase.
        // Vamos criar a função 'finalizar_venda' (ver PASSO 5)
        
        const { data: vendaId, error } = await db
            .rpc('finalizar_venda', {
                p_mercearia_id: estabelecimentoId,
                p_valor_total: totalVendaFloat,
                p_meio_pagamento: meio_pagamento,
                p_carrinho_itens: carrinho, // Envia o JSON do carrinho
                p_cliente_id: clienteId || null
            });
        
        if (error) throw error;

        console.log(`[INFO] Venda finalizada (RPC). ID: ${vendaId}, Meio: ${meio_pagamento}`);
        res.status(201).json({ message: 'Venda registrada com sucesso!', vendaId: vendaId });

    } catch (error) {
        console.error("[ERRO CRÍTICO] Falha ao finalizar venda (RPC):", error.message);
        return res.status(500).json({ error: 'Erro ao processar a venda. O estoque não foi alterado.' });
    }
});

module.exports = router;