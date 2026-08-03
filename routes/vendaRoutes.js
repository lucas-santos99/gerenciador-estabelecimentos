const express = require('express');
const router  = express.Router();
const db      = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

console.log('🔥 VENDAS ROUTES ATUALIZADO 🔥');

router.use(authUser);

// ============================================================
// FINALIZAR VENDA (PDV)
// ============================================================

router.post('/finalizar', async (req, res) => {
  const { valor_total, meio_pagamento, carrinho, clienteId, cpfNota } = req.body;
  const totalVendaFloat = parseFloat(valor_total);

  if (isNaN(totalVendaFloat) || totalVendaFloat <= 0 || !meio_pagamento || !carrinho?.length) {
    return res.status(400).json({ error: 'Dados da venda incompletos ou valor total inválido.' });
  }

  if (meio_pagamento === 'Fiado' && !clienteId) {
    return res.status(400).json({ error: 'ID do cliente é obrigatório para vendas fiado.' });
  }

  const { id: userId, role, mercearia_id } = req.user;

  // Fiado é opcional por estabelecimento agora — esse é o único lugar
  // onde isso deveria bloquear alguma coisa (criar venda fiado NOVA).
  // Cobrar dívida antiga continua liberado em qualquer configuração,
  // então não checamos isso em nenhuma outra rota.
  if (meio_pagamento === 'Fiado') {
    const { data: merc } = await db
      .from('mercearias')
      .select('fiado_ativo')
      .eq('id', mercearia_id)
      .single();
    if (merc?.fiado_ativo === false) {
      return res.status(403).json({ error: 'O módulo de Fiado está desativado para este estabelecimento.' });
    }

    const { data: cli } = await db
      .from('clientes')
      .select('permite_fiado')
      .eq('id', clienteId)
      .eq('mercearia_id', mercearia_id)
      .single();
    if (cli?.permite_fiado === false) {
      return res.status(403).json({ error: 'Esse cliente não está habilitado para comprar fiado.' });
    }
  }

  // operador_id: só preenche se for operador, merchant deixa null
  const operadorId = role === 'operator' ? userId : null;

  try {
    // clienteId vai direto pra função em qualquer forma de pagamento —
    // ela já só mexe em saldo_devedor quando meio_pagamento = 'Fiado'
    // (confirmado lendo o código-fonte da função no Supabase), então
    // não tem risco de criar dívida fantasma numa venda paga na hora.
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

    // A função não grava operador_id nem cpf_nota (esse último nem
    // existia quando ela foi escrita) — completa isso aqui.
    const updatesPosVenda = {};
    if (operadorId) updatesPosVenda.operador_id = operadorId;
    if (cpfNota) updatesPosVenda.cpf_nota = String(cpfNota).replace(/\D/g, '') || null;

    if (Object.keys(updatesPosVenda).length > 0 && vendaId) {
      await db.from('vendas').update(updatesPosVenda).eq('id', vendaId);
    }

    // Registrar na auditoria
    const nomeUsuario = req.user.email;
    const meioLabel = { Dinheiro:'Dinheiro', Pix:'Pix', Debito:'Débito', Credito:'Crédito', Fiado:'Fiado' }[meio_pagamento] || meio_pagamento;
    const { error: errAuditoria } = await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  operadorId,
      usuario_nome: req.user.nome || req.user.email,
      modulo:       'pdv',
      acao:         'venda_realizada',
      descricao:    `Venda de ${totalVendaFloat.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })} — ${meioLabel}${clienteId ? (meio_pagamento === 'Fiado' ? ' (Fiado)' : ' (cliente identificado)') : ''}`,
      meta:         { venda_id: vendaId, valor: totalVendaFloat, meio_pagamento, itens: carrinho.length },
      escopo:       'estabelecimento',
    });
    if (errAuditoria) console.error('[AUDITORIA] Falha ao registrar venda_realizada:', errAuditoria.message);

    console.log(`[INFO] Venda finalizada. ID: ${vendaId}`);
    res.status(201).json({ message: 'Venda registrada com sucesso!', vendaId });

  } catch (err) {
    console.error('[ERRO CRÍTICO] Falha ao finalizar venda:', err.message);
    res.status(500).json({ error: 'Erro ao processar a venda. O estoque não foi alterado.' });
  }
});

// ============================================================
// CANCELAR VENDA
// ============================================================
// Estorna o estoque dos itens vendidos, estorna a entrada no caixa
// (Dinheiro/Pix/Cartão) ou a dívida no cliente (Fiado), e marca a
// venda como cancelada. Não apaga nada — a venda continua no
// histórico, só marcada, pra manter rastro do que aconteceu.

router.post('/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  const { motivo } = req.body;
  const { id: userId, role, mercearia_id, permissoes = [] } = req.user;

  // Merchant sempre pode. Operador só com a permissão específica —
  // cancelar venda é uma ação sensível (mexe em estoque e caixa).
  if (role === 'operator' && !permissoes.includes('pdv_cancelar_venda')) {
    return res.status(403).json({ error: 'Sem permissão para cancelar vendas.' });
  }

  try {
    const { data: venda, error: errVenda } = await db
      .from('vendas')
      .select('id, mercearia_id, cliente_id, valor_total, meio_pagamento, status')
      .eq('id', id)
      .eq('mercearia_id', mercearia_id)
      .single();

    if (errVenda || !venda) return res.status(404).json({ error: 'Venda não encontrada.' });
    if (venda.status === 'cancelada') return res.status(400).json({ error: 'Essa venda já está cancelada.' });

    // Se já teve algum pagamento registrado em cima dessa venda depois
    // de finalizada (ex: fiado que já foi parcialmente quitado), não
    // cancela automático — evita bagunçar o saldo do cliente sem
    // saber ao certo o que já foi pago. Pede pra resolver manualmente.
    const { data: pagamentosLigados } = await db
      .from('transacoes_caixa')
      .select('id')
      .eq('venda_id', id)
      .eq('tipo', 'entrada')
      .neq('descricao', 'Venda PDV');
    if (pagamentosLigados && pagamentosLigados.length > 0) {
      return res.status(400).json({
        error: 'Essa venda já teve pagamento registrado depois de finalizada (ex: fiado parcialmente quitado). Cancele manualmente com o suporte pra não bagunçar o saldo do cliente.',
      });
    }

    // 1) Estorna o estoque de cada item vendido
    const { data: itens } = await db
      .from('itens_venda')
      .select('produto_id, quantidade')
      .eq('venda_id', id);

    for (const item of itens || []) {
      const { data: produto } = await db
        .from('produtos')
        .select('estoque_atual')
        .eq('id', item.produto_id)
        .single();
      if (produto) {
        await db.from('produtos')
          .update({ estoque_atual: parseFloat(produto.estoque_atual || 0) + parseFloat(item.quantidade) })
          .eq('id', item.produto_id);
      }
    }

    // 2) Estorna o dinheiro — se foi fiado, tira do saldo devedor do
    // cliente; se não, remove a entrada que tinha sido lançada no caixa
    if (venda.meio_pagamento === 'Fiado' && venda.cliente_id) {
      const { data: cliente } = await db
        .from('clientes')
        .select('saldo_devedor')
        .eq('id', venda.cliente_id)
        .single();
      if (cliente) {
        const novoSaldo = Math.max(0, parseFloat(cliente.saldo_devedor || 0) - parseFloat(venda.valor_total));
        await db.from('clientes').update({ saldo_devedor: novoSaldo }).eq('id', venda.cliente_id);
      }
    } else {
      await db.from('transacoes_caixa').delete().eq('venda_id', id);
    }

    // 3) Marca a venda como cancelada (não apaga, mantém rastro)
    await db.from('vendas').update({
      status:               'cancelada',
      cancelada_em:         new Date().toISOString(),
      motivo_cancelamento:  motivo || null,
    }).eq('id', id);

    // 4) Auditoria
    const meioLabel = { Dinheiro:'Dinheiro', Pix:'Pix', Debito:'Débito', Credito:'Crédito', Fiado:'Fiado' }[venda.meio_pagamento] || venda.meio_pagamento;
    const { error: errAuditoria } = await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  role === 'operator' ? userId : null,
      usuario_nome: req.user.nome || req.user.email,
      modulo:       'pdv',
      acao:         'venda_cancelada',
      descricao:    `Venda de ${parseFloat(venda.valor_total).toLocaleString('pt-BR', { style:'currency', currency:'BRL' })} (${meioLabel}) cancelada${motivo ? ` — ${motivo}` : ''}`,
      meta:         { venda_id: id, valor: venda.valor_total, meio_pagamento: venda.meio_pagamento, motivo: motivo || null },
      escopo:       'estabelecimento',
    });
    if (errAuditoria) console.error('[AUDITORIA] Falha ao registrar venda_cancelada:', errAuditoria.message);

    console.log(`[INFO] Venda cancelada. ID: ${id}`);
    res.status(200).json({ message: 'Venda cancelada com sucesso.' });

  } catch (err) {
    console.error('[ERRO CRÍTICO] Falha ao cancelar venda:', err.message);
    res.status(500).json({ error: 'Erro ao cancelar venda.' });
  }
});

module.exports = router;