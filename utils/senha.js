// Regra única de senha do sistema (22/09/2026): mínimo 8 caracteres,
// com pelo menos uma letra e um número (máximo 72 — o bcrypt do Supabase
// Auth ignora o que passar disso). Vale só ao CRIAR ou TROCAR senha;
// senhas que já existem continuam funcionando normalmente.
// Mesma regra espelhada no frontend (src/utils/senha.js) — mudar os dois juntos.
const SENHA_MIN = 8;
const SENHA_MAX = 72;

function erroSenhaFraca(senha) {
  if (typeof senha !== 'string' || senha.length === 0) return 'Informe a senha.';
  if (senha.length < SENHA_MIN) return `A senha deve ter no mínimo ${SENHA_MIN} caracteres.`;
  if (senha.length > SENHA_MAX) return `A senha deve ter no máximo ${SENHA_MAX} caracteres.`;
  if (!/[A-Za-zÀ-ÿ]/.test(senha) || !/[0-9]/.test(senha)) return 'A senha deve ter letras e números.';
  return null;
}

module.exports = { erroSenhaFraca, SENHA_MIN, SENHA_MAX };
