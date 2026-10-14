console.log("🔥 FINANCEIRO ROUTES ATUALIZADO 🔥");
// ===== routes/financeiroRoutes.js (VERSÃO RLS + JWT + PERMISSÕES) =====

const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');

// 🔥 PROTEGE TODAS AS ROTAS
router.use(authUser);

const { verificarPermissao, temPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { buscarTimezone, hojeStrTZ, inicioDiaTZ, fimDiaTZ } = require('../utils/fusoHorario');
const { registrar } = require('./auditoriaRoutes');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');
const { rotulosDosItens, nomeComVariacao, selecionarItensVenda } = require('../utils/rotulosVariacao');
const { carimboCriacao, carimboAlteracao } = require('../utils/rastro');
const { erroTeto, erroTetoDoBanco } = require('../utils/tetoCadastros');
const { limitarFrequencia } = require('../utils/limiteFrequencia');
const ContasFixas = require('../utils/contasFixas');

// ── Permissões do operador (módulo + ação marcada na tela) ─────────
// Dono e super_admin passam sempre.
const PERM_CONTAS = [PERMISSOES.FINANCEIRO, PERMISSOES.FINANCEIRO_CONTAS_PAGAR];
const exigeContas = (mensagem) => verificarPermissao(PERM_CONTAS, { mensagem });

// Mexer numa conta específica (pagar, editar, excluir): a permissão do
// operador depende do tipo da conta. Conta nascida de uma compra de
// fornecedor (compras.conta_a_pagar_id) é de quem pode "Lançar compras";
// as demais, de quem gerencia as contas a pagar do Financeiro.
// Devolve true se já respondeu 403 (a rota deve parar).
async function negouPelaConta(req, res, contaId, textoCompra, textoConta) {
    if (temPermissao(req)) return false; // dono / super_admin
    const supabaseAdmin = require('../db/supabaseAdmin');
    const { data: comprasDaConta, error: errCompra } = await supabaseAdmin
        .from('compras')
        .select('id')
        .eq('conta_a_pagar_id', contaId)
        .eq('mercearia_id', req.user.mercearia_id)
        .limit(1);
    if (errCompra) throw errCompra;

    const ehContaDeCompra = (comprasDaConta || []).length > 0;
    const pode = ehContaDeCompra
        ? temPermissao(req, [PERMISSOES.FORNECEDORES, PERMISSOES.FORNECEDORES_COMPRAR])
        : temPermissao(req, PERM_CONTAS);
    if (pode) return false;

    res.status(403).json({ error: ehContaDeCompra ? textoCompra : textoConta, codigo: 'SEM_PERMISSAO' });
    return true;
}


// ============================================================
// 1) LISTAR CONTAS A PAGAR
// ============================================================

router.get('/',
    exigeContas('Sem permissão para ver as contas a pagar.'),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { status } = req.query;

    try {

        // "Hoje" no fuso do próprio estabelecimento — sem isso, a partir
        // de ~21h locais o servidor (que roda em UTC) já "pensa" que é o
        // dia seguinte e marca contas como atrasadas antes da hora.
        const timezone = await buscarTimezone(req.user.mercearia_id);
        const hojeBR = hojeStrTZ(timezone);

        // Contas fixas: gera a conta do mês / registra pagamentos automáticos que já chegaram
        await ContasFixas.processarLojaSePreciso(req.user.mercearia_id);

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
    verificarPermissao([PERMISSOES.FINANCEIRO, PERMISSOES.FINANCEIRO_VER_RESUMO], { mensagem: 'Sem permissão para ver o resumo do dia.' }),
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

        // Pendências (os dois cartões da tela): antes a tela lia estes
        // campos e eles não vinham — mostrava sempre R$ 0,00. Se uma das
        // somas falhar, o resto do resumo continua saindo normalmente.
        resumo.total_fiado_pendente = 0;
        resumo.total_contas_pagar_pendente = 0;
        try {
            const [fiado, comprasComConta, contas] = await Promise.all([
                supabaseAdmin.from('clientes').select('saldo_devedor')
                    .eq('mercearia_id', req.user.mercearia_id).gt('saldo_devedor', 0.01),
                supabaseAdmin.from('compras').select('conta_a_pagar_id')
                    .eq('mercearia_id', req.user.mercearia_id).not('conta_a_pagar_id', 'is', null),
                supabaseAdmin.from('contas_a_pagar').select('id, valor')
                    .eq('mercearia_id', req.user.mercearia_id).eq('status', 'pendente'),
            ]);
            if (fiado.error) throw fiado.error;
            if (contas.error) throw contas.error;
            resumo.total_fiado_pendente = (fiado.data || [])
                .reduce((s, c) => s + (parseFloat(c.saldo_devedor) || 0), 0);
            // Só as despesas da loja (as mesmas da aba Contas a Pagar daqui):
            // conta de compra de fornecedor fica no módulo Fornecedores.
            const deFornecedor = new Set((comprasComConta.data || []).map(c => c.conta_a_pagar_id));
            resumo.total_contas_pagar_pendente = (contas.data || [])
                .filter(c => !deFornecedor.has(c.id))
                .reduce((s, c) => s + (parseFloat(c.valor) || 0), 0);
        } catch (e) {
            console.error('[ERRO] GET /api/financeiro/resumo (pendências):', e.message);
        }

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
    limitarFrequencia('contas-criar', 60),
    exigeContas('Sem permissão para lançar contas a pagar.'),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.status(400).json({
            error: 'Todos os campos obrigatórios devem ser preenchidos.'
        });
    }

    const erroTamanho = validarTamanhos({ descricao }, { descricao: LIMITES.NOME_FANTASIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const erroLimite = await erroTeto(supabaseAdmin, 'contas_a_pagar', req.user.mercearia_id);
    if (erroLimite) return res.status(400).json({ error: erroLimite });

    try {

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .insert({
                mercearia_id: req.user.mercearia_id,
                descricao,
                valor: parseFloat(valor),
                data_vencimento,
                status: 'pendente',
                ...carimboCriacao(req),
            })
            .select()
            .single();

        if (error) throw error;

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_criada',
          descricao: `Conta a pagar criada — "${data.descricao}" (${parseFloat(data.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, vence ${data.data_vencimento})`,
          meta: { conta_id: data.id, valor: data.valor, data_vencimento: data.data_vencimento },
        });

        console.log(`[INFO] Nova conta registrada: ${data.descricao}`);
        res.status(201).json(data);

    } catch (error) {

        console.error('[ERRO] POST /api/financeiro:', error.message);
        const erroLimiteBanco = erroTetoDoBanco(error);
        if (erroLimiteBanco) return res.status(400).json({ error: erroLimiteBanco });
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 4) MARCAR CONTA COMO PAGA
// ============================================================

router.put('/:contaId/pagar',
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;

    try {

        if (await negouPelaConta(req, res, contaId,
            'Sem permissão para marcar compras como pagas.',
            'Sem permissão para marcar contas como pagas.')) return;

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .update({
                status: 'paga',
                data_pagamento: new Date().toISOString(),
                ...carimboAlteracao(req),
            })
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Conta não encontrada.' });
        }

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_paga',
          descricao: `Conta a pagar marcada como paga — "${data.descricao}" (${parseFloat(data.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})`,
          meta: { conta_id: data.id, valor: data.valor },
        });

        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/financeiro/${contaId}/pagar:`, error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});


// ============================================================
// 4b) DESFAZER PAGAMENTO (marcada como paga por engano)
//     Motivo obrigatório. A conta volta a "pendente", sai do DRE
//     (que só conta despesas pagas) e o fato fica registrado.
// ============================================================

router.put('/:contaId/desfazer-pagamento',
    limitarFrequencia('contas-desfazer', 30),
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;
    const motivo = String(req.body?.motivo || '').trim().slice(0, 200);

    try {

        if (motivo.length < 3) {
            return res.status(400).json({ error: 'Informe o motivo de desfazer o pagamento (mínimo 3 letras).' });
        }

        if (await negouPelaConta(req, res, contaId,
            'Sem permissão para desfazer o pagamento de compras.',
            'Sem permissão para desfazer o pagamento de contas.')) return;

        const { data: atual, error: errAtual } = await supabaseAdmin
            .from('contas_a_pagar')
            .select('id, descricao, valor, status, data_pagamento')
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .maybeSingle();
        if (errAtual) throw errAtual;
        if (!atual) return res.status(404).json({ error: 'Conta não encontrada.' });
        if (atual.status !== 'paga') {
            return res.status(409).json({ error: 'Esta conta não está marcada como paga.' });
        }

        const base = { status: 'pendente', data_pagamento: null, ...carimboAlteracao(req) };
        const rastro = {
            pagamento_desfeito_motivo: motivo,
            pagamento_desfeito_em:     new Date().toISOString(),
            pagamento_desfeito_por:    req.user.nome || req.user.email || null,
        };

        const gravar = (campos) => supabaseAdmin
            .from('contas_a_pagar')
            .update(campos)
            .eq('id', contaId)
            .eq('mercearia_id', req.user.mercearia_id)
            .eq('status', 'paga')
            .select()
            .maybeSingle();

        let { data, error } = await gravar({ ...base, ...rastro });
        // SQL 38 ainda não aplicado: desfaz do mesmo jeito (o motivo fica na auditoria)
        if (error && (error.code === '42703' || error.code === 'PGRST204')) {
            ({ data, error } = await gravar(base));
        }
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Esta conta não está marcada como paga.' });
        if (data.pago_automaticamente) {
            await supabaseAdmin.from('contas_a_pagar').update({ pago_automaticamente: false }).eq('id', contaId);
            data.pago_automaticamente = false;
        }

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_pagamento_desfeito',
          descricao: `Pagamento desfeito — "${atual.descricao}" (${parseFloat(atual.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}). Motivo: ${motivo}`,
          meta: { conta_id: atual.id, valor: atual.valor, data_pagamento: atual.data_pagamento, motivo },
        });

        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/financeiro/${contaId}/desfazer-pagamento:`, error.message);
        res.status(500).json({ error: error.message, detalhe: error });

    }

});



// ============================================================
// CONTAS FIXAS (recorrentes) — SQL 39
// ============================================================

const brl = (v) => parseFloat(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const MODOS_PAGAMENTO = ['manual', 'no_vencimento', 'antes'];
const semTabelaFixas = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || e.code === '42703' || e.code === 'PGRST204');
const AVISO_SQL39 = 'Contas fixas ainda não estão ativas neste sistema (falta aplicar o SQL 39).';

function lerFixa(body) {
    const descricao = String(body.descricao || '').trim();
    const valor = Number(body.valor);
    const pagamento = MODOS_PAGAMENTO.includes(body.pagamento) ? body.pagamento : 'manual';
    const diasAntes = pagamento === 'antes' ? Math.min(15, Math.max(1, parseInt(body.dias_antes, 10) || 1)) : 0;
    const lembrar = body.lembrar_valor !== false;
    return { descricao, valor, pagamento, dias_antes: diasAntes, lembrar_valor: lembrar };
}

router.get('/fixas',
    exigeContas('Sem permissão para ver as contas fixas.'),
    async (req, res) => {
    const supabaseAdmin = require('../db/supabaseAdmin');
    const { data, error } = await supabaseAdmin.from('contas_fixas').select('*')
        .eq('mercearia_id', req.user.mercearia_id).order('descricao', { ascending: true });
    if (error) {
        if (semTabelaFixas(error)) return res.status(200).json([]);
        return res.status(500).json({ error: error.message });
    }
    res.status(200).json(data || []);
});

router.post('/fixas',
    limitarFrequencia('contas-fixas', 30),
    exigeContas('Sem permissão para criar contas fixas.'),
    async (req, res) => {
    const supabaseAdmin = require('../db/supabaseAdmin');
    const f = lerFixa(req.body);
    const venc = String(req.body.data_vencimento || '').slice(0, 10);

    if (!f.descricao || !Number.isFinite(f.valor) || f.valor <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(venc)) {
        return res.status(400).json({ error: 'Informe descrição, valor e o primeiro vencimento.' });
    }
    const erroTamanho = validarTamanhos({ descricao: f.descricao }, { descricao: LIMITES.NOME_FANTASIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    try {
        const { data: fixa, error } = await supabaseAdmin.from('contas_fixas').insert({
            mercearia_id: req.user.mercearia_id, ...f,
            dia_vencimento: parseInt(venc.slice(8, 10), 10),
            ...carimboCriacao(req),
        }).select().single();
        if (error) {
            if (semTabelaFixas(error)) return res.status(503).json({ error: AVISO_SQL39 });
            const t = erroTetoDoBanco(error); if (t) return res.status(400).json({ error: t });
            throw error;
        }

        // A primeira conta é exatamente a que a pessoa digitou (valor já conferido).
        const { data: conta, error: errConta } = await supabaseAdmin.from('contas_a_pagar').insert({
            mercearia_id: req.user.mercearia_id, descricao: f.descricao, valor: f.valor,
            data_vencimento: venc, status: 'pendente',
            conta_fixa_id: fixa.id, competencia: ContasFixas.primeiroDoMes(venc), valor_confirmado: true,
            ...carimboCriacao(req),
        }).select().single();
        if (errConta) {
            await supabaseAdmin.from('contas_fixas').delete().eq('id', fixa.id);
            throw errConta;
        }

        registrar({
          mercearia_id: req.user.mercearia_id, operador_id: req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome, usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_fixa_criada',
          descricao: `Conta fixa criada — "${f.descricao}" (${brl(f.valor)}, todo dia ${fixa.dia_vencimento}; ${f.pagamento === 'manual' ? 'pagamento manual' : f.pagamento === 'antes' ? `registrada como paga ${f.dias_antes} dia(s) antes` : 'registrada como paga no vencimento'})`,
          meta: { conta_fixa_id: fixa.id, valor: f.valor, pagamento: f.pagamento, dias_antes: f.dias_antes },
        });
        await ContasFixas.processarAgora(req.user.mercearia_id);   // ex.: vence hoje + pagamento automático
        res.status(201).json({ fixa, conta });
    } catch (error) {
        console.error('[ERRO] POST /api/financeiro/fixas:', error.message);
        const t = erroTetoDoBanco(error); if (t) return res.status(400).json({ error: t });
        res.status(500).json({ error: error.message });
    }
});

router.put('/fixas/:id',
    exigeContas('Sem permissão para editar contas fixas.'),
    async (req, res) => {
    const supabaseAdmin = require('../db/supabaseAdmin');
    const f = lerFixa(req.body);
    const dia = parseInt(req.body.dia_vencimento, 10);
    if (!f.descricao || !Number.isFinite(f.valor) || f.valor <= 0 || !(dia >= 1 && dia <= 31)) {
        return res.status(400).json({ error: 'Informe descrição, valor e o dia do vencimento (1 a 31).' });
    }
    const erroTamanho = validarTamanhos({ descricao: f.descricao }, { descricao: LIMITES.NOME_FANTASIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });
    try {
        const { data, error } = await supabaseAdmin.from('contas_fixas').update({
            ...f, dia_vencimento: dia, ativa: req.body.ativa !== false, ...carimboAlteracao(req),
        }).eq('id', req.params.id).eq('mercearia_id', req.user.mercearia_id).select().maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Conta fixa não encontrada.' });
        registrar({
          mercearia_id: req.user.mercearia_id, operador_id: req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome, usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_fixa_editada',
          descricao: `Conta fixa editada — "${data.descricao}" (${brl(data.valor)}, todo dia ${data.dia_vencimento}${data.ativa ? '' : ', pausada'})`,
          meta: { conta_fixa_id: data.id },
        });
        await ContasFixas.processarAgora(req.user.mercearia_id);
        res.status(200).json(data);
    } catch (error) {
        console.error('[ERRO] PUT /api/financeiro/fixas:', error.message);
        res.status(500).json({ error: error.message });
    }
});

router.delete('/fixas/:id',
    exigeContas('Sem permissão para remover contas fixas.'),
    async (req, res) => {
    const supabaseAdmin = require('../db/supabaseAdmin');
    try {
        const { data, error } = await supabaseAdmin.from('contas_fixas').delete()
            .eq('id', req.params.id).eq('mercearia_id', req.user.mercearia_id).select().maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Conta fixa não encontrada.' });
        registrar({
          mercearia_id: req.user.mercearia_id, operador_id: req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome, usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_fixa_removida',
          descricao: `Conta fixa removida — "${data.descricao}" (as contas já geradas continuam)`,
          meta: { conta_fixa_id: data.id },
        });
        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('[ERRO] DELETE /api/financeiro/fixas:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Conferiu o valor do mês (o mesmo valor, ou um novo — que vale também para os próximos meses).
router.put('/:contaId/confirmar-valor',
    async (req, res) => {
    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;
    try {
        if (await negouPelaConta(req, res, contaId,
            'Sem permissão para editar contas de compras de fornecedor.',
            'Sem permissão para editar contas a pagar.')) return;
        const campos = { valor_confirmado: true, ...carimboAlteracao(req) };
        if (req.body?.valor !== undefined && req.body?.valor !== null && req.body?.valor !== '') {
            const v = Number(req.body.valor);
            if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Informe um valor válido, maior que zero.' });
            campos.valor = v;
        }
        const { data, error } = await supabaseAdmin.from('contas_a_pagar').update(campos)
            .eq('id', contaId).eq('mercearia_id', req.user.mercearia_id).eq('status', 'pendente')
            .not('conta_fixa_id', 'is', null).select().maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Conta não encontrada, já paga ou não é uma conta fixa.' });
        if (campos.valor) {
            await supabaseAdmin.from('contas_fixas').update({ valor: campos.valor })
                .eq('id', data.conta_fixa_id).eq('mercearia_id', req.user.mercearia_id);
        }
        registrar({
          mercearia_id: req.user.mercearia_id, operador_id: req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome, usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_valor_confirmado',
          descricao: `Valor da conta fixa conferido — "${data.descricao}" (${brl(data.valor)}, vence ${data.data_vencimento})`,
          meta: { conta_id: data.id, valor: data.valor },
        });
        await ContasFixas.processarAgora(req.user.mercearia_id);   // valor conferido → pagamento automático pode valer já
        res.status(200).json(data);
    } catch (error) {
        console.error(`[ERRO] PUT /api/financeiro/${contaId}/confirmar-valor:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 5) HISTÓRICO DE VENDAS
// ============================================================

router.get('/historico',
    verificarPermissao([PERMISSOES.RELATORIOS, PERMISSOES.RELATORIOS_HISTORICO], { mensagem: 'Sem permissão para ver o histórico de vendas.' }),
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

        // Venda 'Dividido' (backlog item 19, passo 6) não tem um único
        // meio_pagamento — busca em lote as fatias (pagamentos_venda) de
        // todas as vendas divididas do período, pra anexar o detalhe em
        // cada uma (o front usa isso pra abrir "Dividido (N formas)").
        const vendasDivididasIds = vendas.filter(v => v.meio_pagamento === 'Dividido').map(v => v.id);
        let fatiasPorVenda = {};
        if (vendasDivididasIds.length > 0) {
            const { data: fatias, error: erroFatias } = await supabaseAdmin
                .from('pagamentos_venda')
                .select('id, venda_id, ordem, pessoa_label, meio_pagamento, valor, cliente_id')
                .eq('mercearia_id', req.user.mercearia_id)
                .in('venda_id', vendasDivididasIds)
                .order('ordem', { ascending: true });

            if (erroFatias) throw erroFatias;

            // Resolve nome dos clientes citados nas fatias (fatias Fiado)
            const clienteIdsFatias = [...new Set((fatias || []).map(f => f.cliente_id).filter(Boolean))];
            let clientesFatiasMap = {};
            if (clienteIdsFatias.length > 0) {
                const { data: cls } = await supabaseAdmin
                    .from('clientes')
                    .select('id, nome')
                    .in('id', clienteIdsFatias);
                (cls || []).forEach(c => { clientesFatiasMap[c.id] = c.nome; });
            }

            (fatias || []).forEach(f => {
                if (!fatiasPorVenda[f.venda_id]) fatiasPorVenda[f.venda_id] = [];
                fatiasPorVenda[f.venda_id].push({
                    id:             f.id,
                    ordem:          f.ordem,
                    pessoa_label:   f.pessoa_label,
                    meio_pagamento: f.meio_pagamento,
                    valor:          f.valor,
                    cliente_id:     f.cliente_id || null,
                    cliente_nome:   f.cliente_id ? (clientesFatiasMap[f.cliente_id] || null) : null,
                });
            });
        }

        const vendasComItens = await Promise.all(vendas.map(async (venda) => {
            const { data: itens } = await selecionarItensVenda((comRot) => supabaseAdmin
                .from('itens_venda')
                .select(`pagamento_venda_id, produto_variacao_id, ${comRot ? 'variacao_rotulo, ' : ''}quantidade, preco_unitario, produtos ( nome, marca, unidade_medida, imagem_url )`)
                .eq('venda_id', venda.id));
            // Variação vendida (tamanho/cor/…): o texto gravado na venda; nas antigas, o atual.
            const rotulosItens = await rotulosDosItens(req.user.mercearia_id, itens);

            return {
                ...venda,
                cliente_nome:   venda.clientes?.nome || null,
                operador_nome:  venda.operador_id
                                    ? (operadoresMap[venda.operador_id] || 'Operador removido')
                                    : nomeMerchant,
                pagamentos:     venda.meio_pagamento === 'Dividido' ? (fatiasPorVenda[venda.id] || []) : undefined,
                // pagamento_venda_id: em venda dividida por item (Fase 2 do
                // item 19), diz de qual fatia esse item específico é —
                // null quando foi dividido por valor (sem dono por item) ou
                // caiu no "resto" sem atribuição. Usado no front pra abrir
                // o detalhe de itens dentro de cada fatia.
                itens: (itens || []).map((i, ix) => ({
                    produto_nome:       nomeComVariacao(i.produtos?.nome || 'Produto', rotulosItens[ix]),
                    variacao:           rotulosItens[ix] || null,
                    produto_marca:      i.produtos?.marca || null,
                    produto_imagem_url: i.produtos?.imagem_url || null,
                    quantidade:         i.quantidade,
                    preco_unitario:     i.preco_unitario,
                    unidade_medida:     i.produtos?.unidade_medida || 'un',
                    pagamento_venda_id: i.pagamento_venda_id || null,
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
    verificarPermissao([PERMISSOES.FINANCEIRO, PERMISSOES.FINANCEIRO_VER_DRE], { mensagem: 'Sem permissão para ver o DRE.' }),
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
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;

    try {

        if (await negouPelaConta(req, res, contaId,
            'Sem permissão para excluir contas de compras de fornecedor.',
            'Sem permissão para excluir contas a pagar.')) return;

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

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_excluida',
          descricao: `Conta a pagar excluída — "${data.descricao}" (${parseFloat(data.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})`,
          meta: { conta_id: data.id, valor: data.valor },
        });

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
    async (req, res) => {

    const supabaseAdmin = require('../db/supabaseAdmin');
    const { contaId } = req.params;
    const { descricao, valor, data_vencimento } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    const erroTamanho = validarTamanhos({ descricao }, { descricao: LIMITES.NOME_FANTASIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    try {

        if (await negouPelaConta(req, res, contaId,
            'Sem permissão para editar contas de compras de fornecedor.',
            'Sem permissão para editar contas a pagar.')) return;

        const { data, error } = await supabaseAdmin
            .from('contas_a_pagar')
            .update({
                descricao,
                valor: parseFloat(valor),
                data_vencimento,
                ...carimboAlteracao(req),
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

        // Conta que veio de uma conta fixa: alterar o valor é "conferir o valor do mês" —
        // confirma a conta e leva o valor novo para os próximos meses.
        if (data.conta_fixa_id) {
            await supabaseAdmin.from('contas_a_pagar').update({ valor_confirmado: true }).eq('id', data.id);
            await supabaseAdmin.from('contas_fixas').update({ valor: parseFloat(valor), ...carimboAlteracao(req) })
                .eq('id', data.conta_fixa_id).eq('mercearia_id', req.user.mercearia_id);
            data.valor_confirmado = true;
        }

        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'financeiro', acao: 'conta_editada',
          descricao: `Conta a pagar editada — "${data.descricao}" (${parseFloat(data.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, vence ${data.data_vencimento})`,
          meta: { conta_id: data.id, valor: data.valor, data_vencimento: data.data_vencimento },
        });

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
    verificarPermissao([PERMISSOES.RELATORIOS, PERMISSOES.RELATORIOS_PRODUTOS], { mensagem: 'Sem permissão para ver os produtos mais vendidos.' }),
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
    verificarPermissao([PERMISSOES.RELATORIOS, PERMISSOES.RELATORIOS_OPERADORES], { mensagem: 'Sem permissão para ver as vendas por operador.' }),
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

        // 1b) Venda dividida (backlog item 19) não tem um meio_pagamento
        // único — o valor dela precisa ser aberto por fatia
        // (pagamentos_venda) antes de cair nos baldes de dinheiro/pix/
        // cartão/fiado abaixo, senão os baldes por forma de pagamento
        // ficariam subcontados (o total_vendas continua batendo certo,
        // já que soma direto de v.valor_total, sem depender disso).
        const vendasDivididasIds = vendas.filter(v => v.meio_pagamento === 'Dividido').map(v => v.id);
        let fatiasPorVenda = {};
        if (vendasDivididasIds.length > 0) {
            const { data: fatias, error: erroFatias } = await supabaseAdmin
                .from('pagamentos_venda')
                .select('venda_id, meio_pagamento, valor')
                .in('venda_id', vendasDivididasIds);

            if (erroFatias) throw erroFatias;

            (fatias || []).forEach(f => {
                if (!fatiasPorVenda[f.venda_id]) fatiasPorVenda[f.venda_id] = [];
                fatiasPorVenda[f.venda_id].push(f);
            });
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

            if (meio === 'dividido') {
                // Abre cada fatia no balde certo em vez de jogar o
                // valor_total inteiro num balde só.
                (fatiasPorVenda[v.id] || []).forEach(f => {
                    const valorFatia = parseFloat(f.valor || 0);
                    const meioFatia  = (f.meio_pagamento || '').toLowerCase();
                    if (meioFatia === 'dinheiro')                               agrupado[chave].total_dinheiro += valorFatia;
                    else if (meioFatia === 'pix')                               agrupado[chave].total_pix      += valorFatia;
                    else if (['debito','credito','cartao'].includes(meioFatia)) agrupado[chave].total_cartao   += valorFatia;
                    else if (meioFatia === 'fiado')                             agrupado[chave].total_fiado    += valorFatia;
                });
            }
            else if (meio === 'dinheiro')                               agrupado[chave].total_dinheiro += valor;
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