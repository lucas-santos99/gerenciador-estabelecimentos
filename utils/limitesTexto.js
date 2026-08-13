// utils/limitesTexto.js
//
// Limites de tamanho para campos de texto vindos do cliente (frontend).
// Espelham os `maxLength` já aplicados nos formulários do frontend — aqui
// servem como segunda camada de defesa (defense in depth), pra garantir que
// ninguém consiga salvar um valor gigante direto pela API, contornando o
// limite do input no navegador (Postman, curl, DevTools, etc.).
//
// Uso:
//   const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');
//   const erro = validarTamanhos(
//     { nome, telefone, endereco },
//     { nome: LIMITES.NOME, telefone: LIMITES.TELEFONE, endereco: LIMITES.ENDERECO }
//   );
//   if (erro) return res.status(400).json({ error: erro });

const LIMITES = {
  NOME: 100,             // nome de pessoa, cliente, funcionário, produto, categoria...
  NOME_FANTASIA: 150,     // nome_fantasia, razão social, nome de produto mais descritivo
  EMAIL: 150,
  TELEFONE: 20,           // telefone / whatsapp
  CPF_CNPJ: 18,            // CPF ou CNPJ, com ou sem máscara
  SENHA: 72,               // bcrypt trunca em 72 bytes — acima disso é ilusão de segurança
  ENDERECO: 200,
  OBSERVACAO_CURTA: 300,   // motivo de bloqueio/ajuste/liberação, uma linha
  OBSERVACAO_LONGA: 500,   // textarea de observações gerais
  MENSAGEM_TEMPLATE: 3000, // templates de cobrança (WhatsApp/e-mail), avisos globais
  TITULO: 200,             // assunto de e-mail, título de tela, texto promocional
  BUSCA: 100,              // termos de busca/filtro (não persistidos, mas por segurança)
  CODIGO: 50,              // código de barras, número de nota fiscal
  VALOR_TEXTO: 15,         // valores monetários/quantidades digitados como texto
  CATEGORIA: 80,           // nome de categoria/subcategoria
  VARIACAO: 50,            // tamanho, cor, gênero, marca de variação de produto
};

/**
 * Verifica se algum dos campos informados excede o limite de caracteres definido.
 * @param {Object} campos - objeto com os valores recebidos (ex: { nome, telefone })
 * @param {Object} regras - objeto mapeando o mesmo nome de campo pro limite (ex: { nome: LIMITES.NOME })
 * @returns {string|null} mensagem de erro (pt-BR) do primeiro campo inválido, ou null se tudo ok
 */
function validarTamanhos(campos, regras) {
  for (const [campo, max] of Object.entries(regras)) {
    const valor = campos[campo];
    if (typeof valor === 'string' && valor.length > max) {
      return `O campo "${campo}" excede o limite de ${max} caracteres.`;
    }
  }
  return null;
}

module.exports = { LIMITES, validarTamanhos };
