// Checagem de e-mail usada em tudo que vira LOGIN (dono, operador).
// Além do formato, confere se o DOMÍNIO existe e recebe e-mail (registro MX,
// ou A/AAAA como o padrão de e-mail manda) e sugere a correção de erros
// comuns de digitação (gmial.com → gmail.com).
// NÃO prova que a caixa existe — só barra endereço impossível. Se a consulta
// de DNS falhar por instabilidade (timeout, servidor indisponível), deixa
// passar: não travamos ninguém por problema de rede nosso.
const dns = require('dns').promises;

const FORMATO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROS_COMUNS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gmil.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.com.br': 'gmail.com', 'gmaill.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'hotmail.com.b': 'hotmail.com.br', 'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com',
  'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yahoo.com.b': 'yahoo.com.br',
};

const SEM_REGISTRO = new Set(['ENOTFOUND', 'ENODATA']);

function comTempo(promessa, ms) {
  return Promise.race([
    promessa,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms)),
  ]);
}

async function dominioRecebeEmail(dominio) {
  try {
    const mx = await comTempo(dns.resolveMx(dominio), 3000);
    if (mx && mx.length > 0) return true;
  } catch (err) {
    if (!SEM_REGISTRO.has(err.code)) return true; // instabilidade: não bloqueia
  }
  // Sem MX: o padrão aceita o endereço A/AAAA do domínio.
  for (const resolver of [dns.resolve4, dns.resolve6]) {
    try {
      const r = await comTempo(resolver.call(dns, dominio), 3000);
      if (r && r.length > 0) return true;
    } catch (err) {
      if (!SEM_REGISTRO.has(err.code)) return true;
    }
  }
  return false;
}

// Devolve a mensagem de erro (texto) ou null se o e-mail está ok.
async function erroEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!FORMATO.test(e)) return 'Informe um e-mail válido.';
  const dominio = e.split('@').pop();
  if (ERROS_COMUNS[dominio]) {
    return `O domínio "${dominio}" parece um erro de digitação. Você quis dizer ${e.split('@')[0]}@${ERROS_COMUNS[dominio]}?`;
  }
  if (!(await dominioRecebeEmail(dominio))) {
    return `O domínio "${dominio}" não existe ou não recebe e-mails. Confira o endereço — ele é usado para entrar e para recuperar a senha.`;
  }
  return null;
}

module.exports = { erroEmail, FORMATO };
