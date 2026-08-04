// utils/fusoHorario.js
//
// Converte limites de dia ('YYYY-MM-DD' + hora) para o instante UTC correto,
// considerando o fuso horário IANA de cada estabelecimento (ex: 'America/Sao_Paulo',
// 'America/Manaus', 'America/Rio_Branco', 'America/Noronha').
//
// Por que não usar '-03:00' fixo:
// O Brasil tem 4 fusos (UTC-2 a UTC-5) — só o de Brasília é -03:00. Um
// estabelecimento no Amazonas, Acre, Mato Grosso ou Roraima teria os
// filtros de data errados por 1h ou 2h se a gente fixasse -03:00 pra todo mundo.
//
// Por que isso resolve o horário de verão de vez:
// Usamos o identificador IANA da timezone (não o offset numérico). Se o
// horário de verão voltar um dia, o Node já traz as regras atualizadas via
// tzdata — o Intl.DateTimeFormat abaixo aplica a regra certa pra cada data
// automaticamente, sem precisar tocar em nenhuma linha deste arquivo.

const db = require('../db/supabaseAdmin');

const TIMEZONE_PADRAO = 'America/Sao_Paulo'; // fallback se o estabelecimento não tiver timezone salva

// Os 4 fusos horários do Brasil (identificador IANA, não offset numérico —
// resolve horário de verão sozinho se algum dia voltar). Usado tanto pra
// calcular limites de dia quanto pra validar o que vem do front no
// cadastro/edição de estabelecimento.
const TIMEZONES_VALIDAS = [
  'America/Sao_Paulo',   // UTC-3 — Brasília, a maioria do país
  'America/Manaus',      // UTC-4 — AM, MT, MS, RO, RR
  'America/Rio_Branco',  // UTC-5 — AC, oeste do AM
  'America/Noronha',     // UTC-2 — Fernando de Noronha
];

/**
 * Busca o fuso horário salvo do estabelecimento (coluna mercearias.timezone).
 * Cai pro fuso de Brasília se o estabelecimento ainda não tiver essa coluna
 * preenchida (ex: cadastros antigos, antes da migration).
 */
async function buscarTimezone(mercearia_id) {
  if (!mercearia_id) return TIMEZONE_PADRAO;
  const { data } = await db.from('mercearias').select('timezone').eq('id', mercearia_id).single();
  return data?.timezone || TIMEZONE_PADRAO;
}

/**
 * Retorna a data de HOJE ('YYYY-MM-DD') no calendário da timezone informada.
 * Ex: se são 21h40 em Brasília (já 00h40 UTC do dia seguinte), hojeStrTZ()
 * ainda retorna o dia de hoje em Brasília, não o de amanhã em UTC.
 */
function hojeStrTZ(timeZone = TIMEZONE_PADRAO) {
  // locale 'en-CA' formata datas como YYYY-MM-DD nativamente — sem montar string na mão
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/**
 * Calcula o offset (em minutos) de uma timezone IANA num instante específico.
 * Negativo = atrás de UTC (ex: -180 pra America/Sao_Paulo).
 */
function offsetMinutos(instanteUTC, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const partes = dtf.formatToParts(instanteUTC).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const comoSeUTC = Date.UTC(
    Number(partes.year), Number(partes.month) - 1, Number(partes.day),
    Number(partes.hour), Number(partes.minute), Number(partes.second),
  );
  return (comoSeUTC - instanteUTC.getTime()) / 60000;
}

/**
 * Retorna o instante UTC correspondente a 'dataStr' + 'horaStr' NO HORÁRIO
 * LOCAL da timezone informada. Ex: limiteDiaTZ('2026-08-03', '00:00:00', 'America/Sao_Paulo')
 * → Date representando 2026-08-03T03:00:00Z (meia-noite em Brasília = 03h em UTC).
 */
function limiteDiaTZ(dataStr, horaStr, timeZone = TIMEZONE_PADRAO) {
  const aproxUTC = new Date(`${dataStr}T${horaStr}Z`);
  const offset = offsetMinutos(aproxUTC, timeZone);
  return new Date(aproxUTC.getTime() - offset * 60000);
}

/** Início do dia (00:00:00) no fuso do estabelecimento, como instante UTC. */
function inicioDiaTZ(dataStr, timeZone = TIMEZONE_PADRAO) {
  return limiteDiaTZ(dataStr, '00:00:00', timeZone);
}

/** Fim do dia (23:59:59) no fuso do estabelecimento, como instante UTC. */
function fimDiaTZ(dataStr, timeZone = TIMEZONE_PADRAO) {
  return limiteDiaTZ(dataStr, '23:59:59', timeZone);
}

module.exports = { TIMEZONE_PADRAO, TIMEZONES_VALIDAS, buscarTimezone, hojeStrTZ, inicioDiaTZ, fimDiaTZ };