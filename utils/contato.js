// Telefone e formato de e-mail — mesma regra do front (fe/src/utils/contato.js).
// Telefone vazio é aceito (campo opcional); preenchido precisa ser válido.
function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

function semPais(d) {
  return (d.length === 12 || d.length === 13) && d.startsWith('55') ? d.slice(2) : d;
}

function telefoneValido(v) {
  const d = semPais(soDigitos(v));
  if (d.length !== 10 && d.length !== 11) return false;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || String(ddd).includes('0')) return false;
  if (/^(\d)\1+$/.test(d.slice(2))) return false;
  if (d.length === 11) return d[2] === '9';
  return /[2-5]/.test(d[2]);
}

// Devolve texto do erro ou null. Aceita vários telefones: erroTelefones([...]).
function erroTelefone(valor, rotulo = 'Telefone') {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  return telefoneValido(valor)
    ? null
    : `${rotulo} inválido. Use DDD + número, ex.: (53) 99194-7320.`;
}

function erroTelefones(lista, rotulo = 'Telefone adicional') {
  if (!Array.isArray(lista)) return null;
  for (let i = 0; i < lista.length; i++) {
    const e = erroTelefone(lista[i], `${rotulo} ${i + 1}`);
    if (e) return e;
  }
  return null;
}

// Só o formato (para e-mail que NÃO vira login). Vazio é aceito.
function erroFormatoEmail(valor, rotulo = 'E-mail') {
  const e = String(valor ?? '').trim();
  if (!e) return null;
  return e.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)
    ? null
    : `${rotulo} inválido. Use o formato nome@dominio.com.`;
}

module.exports = { telefoneValido, erroTelefone, erroTelefones, erroFormatoEmail };
