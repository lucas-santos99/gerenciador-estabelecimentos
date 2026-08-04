console.log("🔥 FINANCEIRO ROUTES ATUALIZADO 🔥");
// ===== routes/financeiroRoutes.js (VERSÃO RLS + JWT + PERMISSÕES) =====

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');

// 🔥 PROTEGE TODAS AS ROTAS
router.use(authUser);

const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { buscarTimezone, hojeStrTZ, inicioDiaTZ, fimDiaTZ } = require('../utils/fusoHorario');


// ============================================================
// 1) LISTAR CONTAS A PAGAR
// ============================================================

router.get('/',
    //verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { status } = req.query;

    try {

        // "Hoje" no fuso do próprio estabelecimento — sem isso, a partir
        // de ~21h locais o servidor (que roda em UTC) já "pensa" que é o
        // dia seguinte e marca contas como atrasadas antes da hora.
        const timezone = await buscarTimezone(req.user.mercearia_id);
        const hojeBR = hojeStrTZ(timezone);

        // Contas ligadas a compras de fornecedor ficam de fora daqui —
        // elas têm visão própria agora, dentro do módulo Fornecedores
        // (GET /api/compras/contas-a-pagar). Aqui só sobra despesa "de
        // verdade" (água, luz, aluguel, etc.), que é o que realmente
        // desconta do Lucro Líquido no DRE.
        const { data: comprasComConta } = await supabaseAdmin
            .from('compras')
            .select('conta_a_pagar_id')
            .eq('mercearia_id', req.user.mercearia_id)
            .not('conta_a_pagar_id', 'is', null);
        const idsFornecedor = (comprasComConta || []).map(c => c.conta_a_pagar_id);

        let query = supabaseAdmin
            .from('contas_a_pagar')
            .select('*')
            .eq('mercearia_id', req.user.mercearia_id);

        if (idsFornecedor.length > 0) {
            query = query.not('id', 'in', `(${idsFornecedor.join(',')})`);
        }

        if (status === 'pendente') {
            query = query
                .eq('status', 'pendente')
                .gte('data_vencimento', hojeBR);
        }

        else if (status === 'paga') {
            query = query.eq('status', 'paga');
        }

        else if (status === 'atrasada') {
            query = query
                .eq('status', 'pendente')
                .lt('data_vencimento', hojeBR);
        }

        query = query.order('data_vencimento', { ascending: true });

        const { data, error } = await query;

        if (error) throw error;

        const contas = data.map(c => {
            if (c.status === 'pendente' && c.data_vencimento < hojeBR) {
                return { ...c, status: 'atrasada' };
            }
            return c;
        });

        res.status(200).json(contas);

    } catch (error) {

        console.error('[ERRO] GET /api/financeiro:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 2) RESUMO DO CAIXA (DIA)
// ============================================================

router.get('/resumo',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        // Início do dia de HOJE no fuso do estabelecimento — antes isso
        // usava Date.UTC() puro, ou seja, sempre meia-noite UTC (21h em
        // Brasília do dia anterior), incluindo transações da noite
        // anterior no resumo "de hoje" por engano.
        const timezone   = await buscarTimezone(req.user.mercearia_id);
        const todayStart = inicioDiaTZ(hojeStrTZ(timezone), timezone);

        const { data: transacoes, error } = await supabaseAdmin
            .from('transacoes_caixa')
            .select('tipo, meio_pagamento, valor, descricao')
            .eq('mercearia_id', req.user.mercearia_id)
            .eq('tipo', 'entrada')
            .gte('data_transacao', todayStart.toISOString());

        if (error) throw error;

        let resumo = {
            total_entradas_dia:   0,
            total_vendas_dia:     0,
            total_fiado_recebido: 0,
            total_dinheiro:       0,
            total_pix:            0,
            total_cartao:         0,
            total_debito:         0,
            total_credito:        0,
        };

        transacoes.forEach(t => {

            const valor    = parseFloat(t.valor);
            const descricao = (t.descricao || '').toLowerCase();
            const isFiado  = descricao.includes('fiado') || descricao.includes('fiada');

            resumo.total_entradas_dia += valor;

            if (isFiado) {
                resumo.total_fiado_recebido += valor;
            } else {
                resumo.total_vendas_dia += valor;
            }

            const meio = t.meio_pagamento ? t.meio_pagamento.toLowerCase() : '';
            if (meio === 'dinheiro') resumo.total_dinheiro += valor;
            else if (meio === 'pix') resumo.total_pix += valor;
            else if (['debito', 'credito', 'cartao'].includes(meio)) {
                resumo.total_cartao += valor;
                if (meio === 'debito')  resumo.total_debito  += valor;
                if (meio === 'credito') resumo.total_credito += valor;
                // 'cartao' genérico (legado) vai só no total_cartao
            }

        });

        res.status(200).json(resumo);

    } catch (error) {

        console.error('[ERRO] GET /api/financeiro/resumo:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 3) CRIAR CONTA A PAGAR
// ============================================================

router.post('/',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.status(400).json({
            error: 'Todos os campos obrigatórios devem ser preenchidos.'
        });
    }

    try {

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .insert({
                mercearia_id: req.user.mercearia_id,
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
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 4) MARCAR CONTA COMO PAGA
// ============================================================

router.put('/:contaId/pagar',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;

    try {

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .update({
                status: 'paga',
                data_pagamento: new Date().toISOString()
            })
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada.' });
        }

        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/financeiro/${contaId}/pagar:`, error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 5) HISTÓRICO DE VENDAS
// ============================================================

router.get('/historico',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const { data_inicio, data_fim } = req.query;
    const supabaseAdmin = require('../db/supabaseAdmin');

    // Limites do dia no fuso do próprio estabelecimento — inclusive nos
    // defaults (quando não vem data_inicio/data_fim), que antes usavam
    // setHours() no horário do SERVIDOR (Railway roda em UTC), não do
    // Brasil.
    const timezone = await buscarTimezone(req.user.mercearia_id);
    const inicio = data_inicio
        ? inicioDiaTZ(data_inicio, timezone).toISOString()
        : inicioDiaTZ(hojeStrTZ(timezone), timezone).toISOString();

    const fim = data_fim
        ? fimDiaTZ(data_fim, timezone).toISOString()
        : fimDiaTZ(hojeStrTZ(timezone), timezone).toISOString();

    try {

        const { data: vendas, error } = await supabaseAdmin
            .from('vendas')
            .select(`
                id,
                data_venda,
                valor_total,
                meio_pagamento,
                status,
                motivo_cancelamento,
                operador_id,
                cliente_id,
                clientes ( nome )
            `)
            .eq('mercearia_id', req.user.mercearia_id)
            .gte('data_venda', inicio)
            .lte('data_venda', fim)
            .order('data_venda', { ascending: false });

        if (error) throw error;

        // Busca nomes dos operadores presentes nas vendas
        const operadorIds = [...new Set(vendas.map(v => v.operador_id).filter(Boolean))];
        let operadoresMap = {};
        if (operadorIds.length > 0) {
            const { data: ops } = await supabaseAdmin
                .from('operadores')
                .select('id, nome')
                .in('id', operadorIds)
                .eq('mercearia_id', req.user.mercearia_id);
            (ops || []).forEach(op => { operadoresMap[op.id] = op.nome; });
        }

        // Busca nome_fantasia para vendas sem operador (feitas pelo merchant)
        let nomeMerchant = 'Administrador';
        if (vendas.some(v => !v.operador_id)) {
            const { data: m } = await supabaseAdmin
                .from('mercearias')
                .select('nome_fantasia')
                .eq('id', req.user.mercearia_id)
                .single();
            if (m?.nome_fantasia) nomeMerchant = m.nome_fantasia;
        }

        const vendasComItens = await Promise.all(vendas.map(async (venda) => {
            const { data: itens } = await supabaseAdmin
                .from('itens_venda')
                .select('quantidade, preco_unitario, produtos ( nome, marca, unidade_medida )')
                .eq('venda_id', venda.id);

            return {
                ...venda,
                cliente_nome:   venda.clientes?.nome || null,
                operador_nome:  venda.operador_id
                                    ? (operadoresMap[venda.operador_id] || 'Operador removido')
                                    : nomeMerchant,
                itens: (itens || []).map(i => ({
                    produto_nome:   i.produtos?.nome || 'Produto',
                    produto_marca:  i.produtos?.marca || null,
                    quantidade:     i.quantidade,
                    preco_unitario: i.preco_unitario,
                    unidade_medida: i.produtos?.unidade_medida || 'un',
                })),
            };
        }));

        res.status(200).json(vendasComItens);

    } catch (error) {
        console.error('[ERRO] GET /api/financeiro/historico:', error.message);
        res.status(500).json({ error: error.message });
    }

});


// ============================================================
// 6) RELATÓRIO DRE
// ============================================================

router.get('/relatorio_dre',
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const { data_inicio, data_fim } = req.query;

    if (!data_inicio || !data_fim) {
        return res.status(400).json({
            error: 'Data de início e fim são obrigatórias.'
        });
    }

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        // data_inicio/data_fim vão como 'YYYY-MM-DD' pra função SQL
        // gerar_relatorio_dre(), que busca o fuso do próprio
        // estabelecimento (mercearias.timezone) e converte certo lá
        // dentro via AT TIME ZONE — não precisa de tratamento aqui.
        const { data, error } = await supabaseAdmin.rpc('gerar_relatorio_dre', {
            p_data_inicio:  data_inicio,
            p_data_fim:     data_fim,
            p_mercearia_id: req.user.mercearia_id
        });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] Relatório DRE:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 7) EXCLUIR CONTA
// ============================================================

router.delete('/:contaId',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;

    try {

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .delete()
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .eq('status', 'pendente')
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada ou já paga.' });
        }

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] DELETE conta:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 8) EDITAR CONTA
// ============================================================

router.put('/:contaId',
    verificarPermissao(PERMISSOES.VER_FINANCEIRO),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;
    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    try {

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .update({
                descricao,
                valor: parseFloat(valor),
                data_vencimento
            })
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .eq('status', 'pendente')
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada ou já paga.' });
        }

        res.status(200).json(data);

    } catch (error) {

        console.error('[ERRO] PUT conta:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 9) RELATÓRIO PRODUTOS VENDIDOS
// ============================================================

router.get('/relatorio_produtos',
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const { data_inicio, data_fim, categoria_id } = req.query;

    if (!data_inicio || !data_fim) {
        return res.status(400).json({ error: 'Datas obrigatórias.' });
    }

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        // Mesmo caso do gerar_relatorio_dre() acima — fuso resolvido
        // dentro da função SQL, via mercearias.timezone.
        const { data, error } = await supabaseAdmin.rpc('gerar_relatorio_produtos', {
            p_data_inicio:  data_inicio,
            p_data_fim:     data_fim,
            p_categoria_id: categoria_id || null,
            p_mercearia_id: req.user.mercearia_id
        });

        if (error) throw error;

        res.status(200).json(data || []);

    } catch (error) {

        console.error('[ERRO] Relatório produtos:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 10) RELATÓRIO DE VENDAS POR OPERADOR
// ============================================================

router.get('/relatorio_vendas_operador',
    verificarPermissao(PERMISSOES.VER_RELATORIOS),
    async (req, res) => {

    const { data_inicio, data_fim } = req.query;

    if (!data_inicio || !data_fim) {
        return res.status(400).json({
            error: 'data_inicio e data_fim são obrigatórias.'
        });
    }

    const timezone = await buscarTimezone(req.user.mercearia_id);
    const inicio = inicioDiaTZ(data_inicio, timezone).toISOString();
    const fim    = fimDiaTZ(data_fim, timezone).toISOString();

    try {
        const supabaseAdmin = require('../db/supabaseAdmin');

        // 1) Busca todas as vendas concluídas do período
        const { data: vendas, error: erroVendas } = await supabaseAdmin
            .from('vendas')
            .select('id, valor_total, meio_pagamento, status, operador_id, data_venda')
            .eq('mercearia_id', req.user.mercearia_id)
            .eq('status', 'concluida')
            .gte('data_venda', inicio)
            .lte('data_venda', fim);

        if (erroVendas) throw erroVendas;

        if (!vendas || vendas.length === 0) {
            return res.status(200).json([]);
        }

        // 2) Coleta IDs únicos de operadores presentes nas vendas
        const operadorIds = [...new Set(vendas.map(v => v.operador_id).filter(Boolean))];

        // 3) Busca nomes dos operadores
        let operadoresMap = {};
        if (operadorIds.length > 0) {
            const { data: operadores, error: erroOps } = await supabaseAdmin
                .from('operadores')
                .select('id, nome')
                .in('id', operadorIds)
                .eq('mercearia_id', req.user.mercearia_id);

            if (erroOps) throw erroOps;

            (operadores || []).forEach(op => {
                operadoresMap[op.id] = op.nome;
            });
        }

        // 3b) Busca nome_fantasia da mercearia para vendas sem operador_id
        let nomeEstabelecimento = 'Administrador';
        const temVendasSemOperador = vendas.some(v => !v.operador_id);
        if (temVendasSemOperador) {
            const { data: mercearia } = await supabaseAdmin
                .from('mercearias')
                .select('nome_fantasia')
                .eq('id', req.user.mercearia_id)
                .single();
            if (mercearia?.nome_fantasia) {
                nomeEstabelecimento = mercearia.nome_fantasia;
            }
        }

        // 4) Agrupa vendas por operador
        const agrupado = {};

        vendas.forEach(v => {
            const chave = v.operador_id || '__sem_operador__';

            if (!agrupado[chave]) {
                agrupado[chave] = {
                    operador_id:    v.operador_id || null,
                    operador_nome:  v.operador_id
                                        ? (operadoresMap[v.operador_id] || 'Operador removido')
                                        : nomeEstabelecimento,
                    total_vendas:   0,
                    qtd_vendas:     0,
                    total_dinheiro: 0,
                    total_pix:      0,
                    total_cartao:   0,
                    total_fiado:    0,
                };
            }

            const valor = parseFloat(v.valor_total || 0);
            const meio  = (v.meio_pagamento || '').toLowerCase();

            agrupado[chave].total_vendas += valor;
            agrupado[chave].qtd_vendas   += 1;

            if (meio === 'dinheiro')                               agrupado[chave].total_dinheiro += valor;
            else if (meio === 'pix')                               agrupado[chave].total_pix      += valor;
            else if (['debito','credito','cartao'].includes(meio)) agrupado[chave].total_cartao   += valor;
            else if (meio === 'fiado')                             agrupado[chave].total_fiado    += valor;
        });

        // 5) Converte para array, ordena por total decrescente
        const resultado = Object.values(agrupado).sort(
            (a, b) => b.total_vendas - a.total_vendas
        );

        res.status(200).json(resultado);

    } catch (error) {
        console.error('[ERRO] GET /api/financeiro/relatorio_vendas_operador:', error.message);
        res.status(500).json({ error: error.message, detalhe: error });
    }

});


module.exports = router;