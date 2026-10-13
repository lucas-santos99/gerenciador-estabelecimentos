// Manutenção diária da auditoria (SQL 36): MOVE registros antigos para auditoria_arquivo — nada é apagado.
// Padrão: login com mais de 6 meses e demais com mais de 24 meses. Ajustável por variável de ambiente:
//   AUDITORIA_RETENCAO_LOGIN_MESES (mín. 1) · AUDITORIA_RETENCAO_MESES (mín. 3) · AUDITORIA_ARQUIVAR=desligado
// Roda 3 min depois de subir e depois a cada 24 h, em blocos de 5.000 (no máximo 20 blocos por rodada).
// Se o SQL 36 ainda não foi aplicado, não faz nada e não incomoda o log.
const db = require('../db/supabaseAdmin');

const inteiro = (v, padrao, minimo) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= minimo ? n : padrao;
};

async function arquivarAuditoria() {
  if (String(process.env.AUDITORIA_ARQUIVAR || '').toLowerCase() === 'desligado') return 0;
  const mesesLogin = inteiro(process.env.AUDITORIA_RETENCAO_LOGIN_MESES, 6, 1);
  const mesesGeral = inteiro(process.env.AUDITORIA_RETENCAO_MESES, 24, 3);
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const { data, error } = await db.rpc('auditoria_arquivar', {
      p_meses_login: mesesLogin, p_meses_geral: mesesGeral, p_lote: 5000,
    });
    if (error) {
      if (error.code !== 'PGRST202' && error.code !== '42883') console.error('[AUDITORIA] arquivar:', error.message);
      break;
    }
    total += Number(data) || 0;
    if (!data || Number(data) < 5000) break;
  }
  if (total > 0) console.log(`[AUDITORIA] ${total} registros antigos movidos para o arquivo`);
  return total;
}

function agendarArquivamento() {
  const rodar = () => arquivarAuditoria().catch(e => console.error('[AUDITORIA] arquivar:', e.message));
  setTimeout(rodar, 3 * 60 * 1000).unref();
  setInterval(rodar, 24 * 60 * 60 * 1000).unref();
}

module.exports = { arquivarAuditoria, agendarArquivamento };
