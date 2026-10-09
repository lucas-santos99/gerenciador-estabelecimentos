// ============================================================
// vencimentoRecorrente.js
// Vencimento de fiado que se renova sozinho todo mês.
// Regra: só renova quando o cliente NÃO tem dívida pendente e a data
// já passou. A renovação é feita na hora em que a lista de clientes é
// carregada (sem agendador), sempre a partir do dia do vencimento
// original (vencimento_dia), então 31 → 28/fev → 31/mar sem "escorregar".
// ============================================================

const supabaseAdmin = require('../db/supabaseAdmin');
const { buscarTimezone, hojeStrTZ } = require('./fusoHorario');

function ultimoDiaDoMes(ano, mes) { // mes: 1-12
    return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

// Próximo vencimento mensal estritamente depois de "hoje" (YYYY-MM-DD).
function proximoVencimento(dataStr, dia, hojeStr) {
    let [a, m, d] = String(dataStr).slice(0, 10).split('-').map(Number);
    const alvo = Number(dia) || d;
    for (let i = 0; i < 600; i++) { // trava de segurança
        m += 1;
        if (m > 12) { m = 1; a += 1; }
        const dd = Math.min(alvo, ultimoDiaDoMes(a, m));
        const s = `${a}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        if (s > hojeStr) return s;
    }
    return null;
}

// Renova (no banco e na lista recebida) os clientes com recorrência ligada,
// sem dívida e com vencimento já passado. Nunca derruba a requisição.
async function renovarVencimentos(clientes, merceariaId) {
    try {
        const candidatos = (clientes || []).filter(c =>
            c && c.vencimento_recorrente && c.data_vencimento
            && (parseFloat(c.saldo_devedor) || 0) <= 0.01);
        if (!candidatos.length) return;
        const hojeStr = hojeStrTZ(await buscarTimezone(merceariaId));
        for (const c of candidatos) {
            if (String(c.data_vencimento).slice(0, 10) > hojeStr) continue; // ainda não passou
            const novo = proximoVencimento(c.data_vencimento, c.vencimento_dia, hojeStr);
            if (!novo) continue;
            const { error } = await supabaseAdmin.from('clientes')
                .update({ data_vencimento: novo })
                .eq('id', c.id).eq('mercearia_id', merceariaId);
            if (!error) c.data_vencimento = novo;
        }
    } catch (e) {
        console.error('[AVISO] Renovar vencimentos recorrentes:', e.message);
    }
}

module.exports = { proximoVencimento, renovarVencimentos };
