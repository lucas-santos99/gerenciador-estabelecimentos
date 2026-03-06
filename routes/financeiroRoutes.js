// ===== routes/financeiroRoutes.js (COM ROTA DE PRODUTOS VENDIDOS) =====
const express = require('express');
const db = require('../db/supabaseAdmin'); 
const router = express.Router();

// --- 1. Rota GET: Listar Contas a Pagar ---
// (Código existente, sem alteração)
router.get('/:estabelecimentoId', async (req, res) => {
    // ... (seu código de listar contas)
    const { estabelecimentoId } = req.params;
    const { status } = req.query; 

    if (!estabelecimentoId) {
        return res.status(400).json({ error: 'ID da Mercearia obrigatório.' });
    }
    try {
        let query = db.from('contas_a_pagar').select('*').eq('mercearia_id', estabelecimentoId);

        if (status === 'pendente') {
            query = query.eq('status', 'pendente').gte('data_vencimento', new Date().toISOString());
        } else if (status === 'paga') {
            query = query.eq('status', 'paga');
        } else if (status === 'atrasada') {
            query = query.eq('status', 'pendente').lt('data_vencimento', new Date().toISOString());
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
        console.error(`[ERRO] GET /api/financeiro/${estabelecimentoId}?status=${status}:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar contas a pagar.' });
    }
});

// --- 2. Rota GET: Resumo do Caixa (Dia) ---
// (Código existente, sem alteração)
router.get('/resumo/:estabelecimentoId', async (req, res) => {
    // ... (seu código de resumo)
    const { estabelecimentoId } = req.params;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0); 
    
    try {
        const { data: transacoes, error } = await db
            .from('transacoes_caixa')
            .select('tipo, meio_pagamento, valor')
            .eq('mercearia_id', estabelecimentoId)
            .eq('tipo', 'entrada') 
            .gte('data_transacao', todayStart.toISOString());
        if (error) throw error;

        let resumo = { total_entradas_dia: 0, total_dinheiro: 0, total_pix: 0, total_cartao: 0 };
        transacoes.forEach(t => {
            const valor = parseFloat(t.valor);
            resumo.total_entradas_dia += valor;
            const meio = t.meio_pagamento ? t.meio_pagamento.toLowerCase() : '';
            if (meio === 'dinheiro') { resumo.total_dinheiro += valor; }
            else if (meio === 'pix') { resumo.total_pix += valor; }
            else if (meio === 'debito' || meio === 'credito' || meio === 'cartao') { resumo.total_cartao += valor; }
        });
        res.status(200).json(resumo);
    } catch (error) {
        console.error(`[ERRO] GET /api/financeiro/resumo/${estabelecimentoId}:`, error.message);
        res.status(500).json({ error: 'Erro ao gerar resumo financeiro.' });
    }
});

// --- 3. Rota POST: Adicionar Nova Conta ---
// (Código existente, sem alteração)
router.post('/', async (req, res) => {
    // ... (seu código de adicionar conta)
    const { estabelecimentoId, descricao, valor, data_vencimento } = req.body;
    if (!estabelecimentoId || !descricao || !valor || !data_vencimento) {
        return res.status(400).json({ error: 'Todos os campos obrigatórios devem ser preenchidos.' });
    }
    try {
        const { data, error } = await db
            .from('contas_a_pagar')
            .insert({
                mercearia_id: estabelecimentoId,
                descricao: descricao,
                valor: parseFloat(valor), 
                data_vencimento: data_vencimento,
                status: 'pendente'
            })
            .select()
            .single();
        if (error) throw error;
        console.log(`[INFO] Nova conta a pagar registrada: ${data.descricao}`);
        res.status(201).json(data);
    } catch (error) {
        console.error(`[ERRO] POST /api/financeiro:`, error.message);
        res.status(500).json({ error: 'Erro ao registrar a conta.' });
    }
});

// --- 4. Rota PUT: Marcar Conta como Paga ---
// (Código existente, sem alteração)
router.put('/:contaId/pagar', async (req, res) => {
    // ... (seu código de pagar conta)
    const { contaId } = req.params;
    const { estabelecimentoId } = req.body;
    if (!estabelecimentoId) {
        return res.status(400).json({ error: 'ID da Mercearia obrigatório.' });
    }
    try {
        const { data, error } = await db
            .from('contas_a_pagar')
            .update({ status: 'paga', data_pagamento: new Date().toISOString() })
            .eq('id', contaId)
            .eq('mercearia_id', estabelecimentoId) 
            .select()
            .single();
            
        if (error) throw error;
        
        if (!data) {
             return res.status(404).json({ error: 'Conta não encontrada ou não pertence a esta mercearia.' });
        }
        
        console.log(`[INFO] Conta marcada como paga: ${contaId}`);
        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] PUT /api/financeiro/${contaId}/pagar:`, error.message);
        res.status(500).json({ error: 'Erro ao marcar conta como paga.' });
    }
});

// --- 5. Rota GET: Relatório DRE ---
// (Código existente, sem alteração)
router.get('/relatorio_dre/:estabelecimentoId', async (req, res) => {
    // ... (seu código do DRE)
    const { estabelecimentoId } = req.params;
    const { data_inicio, data_fim } = req.query; 

    if (!data_inicio || !data_fim) {
        return res.status(400).json({ error: 'Data de início e data de fim são obrigatórias.' });
    }

    try {
        const { data, error } = await db.rpc('gerar_relatorio_dre', {
            p_mercearia_id: estabelecimentoId,
            p_data_inicio: data_inicio,
            p_data_fim: data_fim
        });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] GET /api/financeiro/relatorio_dre:`, error.message);
        res.status(500).json({ error: 'Erro ao gerar relatório DRE.' });
    }
});

// --- 6. Rota DELETE: Excluir Conta a Pagar ---
// (Código existente, sem alteração)
router.delete('/:contaId', async (req, res) => {
    // ... (seu código de excluir conta)
    const { contaId } = req.params;
    const { estabelecimentoId } = req.body; 

    if (!estabelecimentoId) {
        return res.status(400).json({ error: 'ID da Mercearia obrigatório.' });
    }

    try {
        const { data, error } = await db
            .from('contas_a_pagar')
            .delete()
            .eq('id', contaId)
            .eq('mercearia_id', estabelecimentoId)
            .eq('status', 'pendente') 
            .select() 
            .single(); 
        
        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada, já paga ou não pertence a esta mercearia.' });
        }

        console.log(`[INFO] Conta pendente excluída: ${data.id}`);
        res.status(200).json(data); 

    } catch (error) {
        console.error(`[ERRO] DELETE /api/financeiro/${contaId}:`, error.message);
        res.status(500).json({ error: 'Erro ao excluir conta.' });
    }
});


// --- 7. Rota PUT: Editar Conta a Pagar ---
// (Código existente, sem alteração)
router.put('/:contaId', async (req, res) => {
    // ... (seu código de editar conta)
    const { contaId } = req.params;
    const { estabelecimentoId, descricao, valor, data_vencimento } = req.body;

    if (!estabelecimentoId || !descricao || !valor || !data_vencimento) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    try {
        const { data, error } = await db
            .from('contas_a_pagar')
            .update({
                descricao: descricao,
                valor: parseFloat(valor.replace(/\./g, '').replace(',', '.')),
                data_vencimento: data_vencimento
            })
            .eq('id', contaId)
            .eq('mercearia_id', estabelecimentoId)
            .eq('status', 'pendente')
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada, já paga ou não pertence a esta mercearia.' });
        }

        console.log(`[INFO] Conta pendente atualizada: ${data.id}`);
        res.status(200).json(data); 

    } catch (error) {
        console.error(`[ERRO] PUT /api/financeiro/${contaId}:`, error.message);
        res.status(500).json({ error: 'Erro ao atualizar conta.' });
    }
});

// --- 8. Rota GET: Relatório de Produtos Vendidos (NOVO) ---
router.get('/relatorio_produtos/:estabelecimentoId', async (req, res) => {
    const { estabelecimentoId } = req.params;
    const { data_inicio, data_fim, categoria_id } = req.query;

    if (!data_inicio || !data_fim) {
        return res.status(400).json({ error: 'Data de início e data de fim são obrigatórias.' });
    }

    try {
        const { data, error } = await db.rpc('gerar_relatorio_produtos', {
            p_mercearia_id: estabelecimentoId,
            p_data_inicio: data_inicio,
            p_data_fim: data_fim,
            p_categoria_id: categoria_id || null // Envia null se for "Todas"
        });

        if (error) throw error;

        // A função RPC retorna [null] se a consulta não achar nada, em vez de []
        res.status(200).json(data || []); // Garante que o frontend receba um array

    } catch (error) {
        console.error(`[ERRO] GET /api/financeiro/relatorio_produtos:`, error.message);
        res.status(500).json({ error: 'Erro ao gerar relatório de produtos.' });
    }
});

module.exports = router;