const express = require('express');
const router  = express.Router();
const db      = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

router.use(authUser);

// ============================================================
// FINALIZAR VENDA (PDV)
// ============================================================

router.post('/finalizar', async (req, res) => {
  const { valor_total, meio_pagamento, carrinho, clienteId } = req.body;
  const totalVendaFloat = parseFloat(valor_total);

  if (isNaN(totalVendaFloat) || totalVendaFloat <= 0 || !meio_pagamento || !carrinho?.length) {
    return res.status(400).json({ error: 'Dados da venda incompletos ou valor total inválido.' });
  }

  if (meio_pagamento === 'Fiado' && !clienteId) {
    return res.status(400).json({ error: 'ID do cliente é obrigatório para vendas fiado.' });
  }

  const { id: userId, role, mercearia_id } = req.user;

  // operador_id: só preenche se for operador, merchant deixa null
  const operadorId = role === 'operator' ? userId : null;

  try {
    const { data: vendaId, error } = await db.rpc('finalizar_venda', {
      p_valor_total:    totalVendaFloat,
      p_meio_pagamento: meio_pagamento,
      p_carrinho_itens: carrinho,
      p_cliente_id:     clienteId || null,
      p_operador_id:    operadorId,
      p_mercearia_id:   mercearia_id,
    });

    if (error) {
      console.error('[ERRO RPC] finalizar_venda:', JSON.stringify(error));
      throw error;
    }

    // Atualizar operador_id na venda (a RPC pode não fazer isso)
    if (operadorId && vendaId) {
      await db.from('vendas').update({ operador_id: operadorId }).eq('id', vendaId);
    }

    // Registrar na auditoria
    const nomeUsuario = req.user.email;
    const meioLabel = { Dinheiro:'Dinheiro', Pix:'Pix', Debito:'Débito', Credito:'Crédito', Fiado:'Fiado' }[meio_pagamento] || meio_pagamento;
    await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  operadorId,
      usuario_nome: req.user.nome || req.user.email,
      usuario_email: req.user.email,
      modulo:       'pdv',
      acao:         'venda_realizada',
      descricao:    `Venda de ${totalVendaFloat.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })} — ${meioLabel}${clienteId ? ' (Fiado)' : ''}`,
      meta:         { venda_id: vendaId, valor: totalVendaFloat, meio_pagamento, itens: carrinho.length },
    });

    console.log(`[INFO] Venda finalizada. ID: ${vendaId}`);
    res.status(201).json({ message: 'Venda registrada com sucesso!', vendaId });

  } catch (err) {
    console.error('[ERRO CRÍTICO] Falha ao finalizar venda:', err.message);
    res.status(500).json({ error: 'Erro ao processar a venda. O estoque não foi alterado.' });
  }
});

module.exports = router;