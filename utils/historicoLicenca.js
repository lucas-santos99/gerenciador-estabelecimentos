// ============================================================
// historicoLicenca.js
// Histórico de renovações da assinatura (mensalidade) de um
// estabelecimento: junta os pagamentos automáticos (Pix/cartão, tabela
// cobrancas_licenca — inclusive estornos) com as liberações manuais do
// SuperAdmin (liberacoes_licenca) numa linha do tempo só, mais recente
// primeiro. `completo` = visão do SuperAdmin (com motivo e quem liberou);
// sem ele (visão do dono) esses detalhes internos não saem.
// ============================================================

const db = require('../db/supabaseAdmin');

const TAMANHO = 200;

async function listarHistoricoLicenca(merceariaId, { completo = false } = {}) {
    const [rCob, rLib] = await Promise.all([
        db.from('cobrancas_licenca')
            .select('id, provedor, forma, plano, dias, valor, status, valor_pago, pago_em, venc_anterior, venc_novo, estornado_em, venc_apos_estorno, criado_em')
            .eq('mercearia_id', merceariaId)
            .in('status', completo ? ['pago', 'estornado', 'pendente'] : ['pago', 'estornado'])
            .order('criado_em', { ascending: false })
            .limit(TAMANHO),
        db.from('liberacoes_licenca')
            .select('id, dias, data_inicio, data_vencimento, forma_pagamento, motivo, liberado_por, created_at')
            .eq('mercearia_id', merceariaId)
            .order('created_at', { ascending: false })
            .limit(TAMANHO),
    ]);
    if (rCob.error) throw rCob.error;
    if (rLib.error) throw rLib.error;

    const linhas = [];

    for (const c of rCob.data || []) {
        const valor = c.valor_pago != null ? c.valor_pago : c.valor;
        linhas.push({
            id: `c-${c.id}`,
            origem: 'pagamento',
            data: c.pago_em || c.criado_em,
            forma: c.forma, // 'pix' | 'cartao'
            status: c.status, // 'pago' | 'estornado' | 'pendente'
            dias: c.dias,
            valor: valor != null ? parseFloat(valor) : null,
            venc_anterior: c.venc_anterior || null,
            venc_novo: c.venc_novo || null,
            estornado_em: c.estornado_em || null,
            venc_apos_estorno: c.venc_apos_estorno || null,
            plano: c.plano || null,
            ...(completo ? { provedor: c.provedor } : {}),
        });
    }

    for (const l of rLib.data || []) {
        const estorno = l.forma_pagamento === 'estorno';
        linhas.push({
            id: `l-${l.id}`,
            origem: 'liberacao',
            data: l.created_at,
            forma: completo ? l.forma_pagamento : (estorno ? 'estorno' : 'liberacao'),
            status: estorno ? 'estornado' : 'pago',
            dias: l.dias,
            valor: null,
            venc_anterior: null,
            venc_novo: l.data_vencimento || null,
            estornado_em: null,
            venc_apos_estorno: null,
            plano: null,
            ...(completo ? { motivo: l.motivo || null, liberado_por: l.liberado_por || null } : {}),
        });
    }

    linhas.sort((a, b) => String(b.data).localeCompare(String(a.data)));
    return linhas;
}

module.exports = { listarHistoricoLicenca };
