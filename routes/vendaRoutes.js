const express = require('express');
const router  = express.Router();
const db      = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

console.log('🔥 VENDAS ROUTES ATUALIZADO 🔥');

router.use(authUser);

const MEIOS_VALIDOS = ['Dinheiro', 'Pix', 'Debito', 'Credito', 'Fiado'];
const MEIO_LABEL = { Dinheiro: 'Dinheiro', Pix: 'Pix', Debito: 'Débito', Credito: 'Crédito', Fiado: 'Fiado', Dividido: 'Dividido' };
const fmtBRL = (v) => parseFloat(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ============================================================
// FINALIZAR VENDA (PDV)
// ============================================================
// Pagamento dividido entre várias pessoas (backlog item 19, Fase 1):
// o corpo pode trazer um array `pagamentos` (mais de 1 item) em vez de
// (ou além de) `meio_pagamento`/`clienteId` únicos — cada item é
// { meioPagamento, valor, clienteId?, valorRecebido?, troco?, pessoaLabel? }.
// Quando `pagamentos` não vem ou tem só 1 item, o comportamento é
// IDÊNTICO ao de antes (mesmo caminho de sempre, sem passar
// `p_pagamentos` pra RPC). Ver `finalizar_venda` no Supabase e o plano
// em claude/roadmap-status.md.

router.post('/finalizar', async (req, res) => {
  const { valor_total, meio_pagamento, carrinho, clienteId, cpfNota, pagamentos } = req.body;
  const totalVendaFloat = parseFloat(valor_total);
  const dividida = Array.isArray(pagamentos) && pagamentos.length > 1;

  if (isNaN(totalVendaFloat) || totalVendaFloat <= 0 || !carrinho?.length) {
    return res.status(400).json({ error: 'Dados da venda incompletos ou valor total inválido.' });
  }
  if (!dividida && !meio_pagamento) {
    return res.status(400).json({ error: 'Dados da venda incompletos ou valor total inválido.' });
  }

  if (!dividida && meio_pagamento === 'Fiado' && !clienteId) {
    return res.status(400).json({ error: 'ID do cliente é obrigatório para vendas fiado.' });
  }

  // Validação da divisão — mesma checagem que a função no banco faz de
  // novo (defesa em profundidade), só que aqui já devolve uma mensagem
  // amigável pro PDV antes de gastar uma chamada RPC.
  if (dividida) {
    for (const [i, p] of pagamentos.entries()) {
      if (!MEIOS_VALIDOS.includes(p.meioPagamento)) {
        return res.status(400).json({ error: `Fatia ${i + 1}: forma de pagamento inválida.` });
      }
      if (isNaN(parseFloat(p.valor)) || parseFloat(p.valor) <= 0) {
        return res.status(400).json({ error: `Fatia ${i + 1}: valor inválido.` });
      }
      if (p.meioPagamento === 'Fiado' && !p.clienteId) {
        return res.status(400).json({ error: `Fatia ${i + 1} (Fiado): cliente é obrigatório.` });
      }
    }
    const somaFatias = pagamentos.reduce((s, p) => s + parseFloat(p.valor), 0);
    if (Math.abs(somaFatias - totalVendaFloat) > 0.001) {
      return res.status(400).json({ error: `A soma das fatias (${fmtBRL(somaFatias)}) não bate com o total da venda (${fmtBRL(totalVendaFloat)}).` });
    }

    // Pagamento dividido, Fase 2 (backlog item 19) — divisão por item:
    // cada item do carrinho pode trazer opcionalmente `pagamento_index`
    // (0-based), indicando qual fatia de `pagamentos` ficou com ele. A
    // RPC já ignora um índice fora da faixa (trata como "sem fatia
    // própria"), mas validamos aqui antes de gastar a chamada — mesma
    // defesa em profundidade já usada pra soma das fatias acima.
    for (const [i, item] of carrinho.entries()) {
      if (item.pagamento_index == null) continue;
      if (!Number.isInteger(item.pagamento_index) || item.pagamento_index < 0 || item.pagamento_index >= pagamentos.length) {
        return res.status(400).json({ error: `Item ${i + 1} do carrinho: pagamento_index inválido.` });
      }
    }
  }

  const { id: userId, role, mercearia_id } = req.user;

  // Fiado é opcional por estabelecimento agora — esse é o único lugar
  // onde isso deveria bloquear alguma coisa (criar venda fiado NOVA).
  // Cobrar dívida antiga continua liberado em qualquer configuração,
  // então não checamos isso em nenhuma outra rota. Numa venda dividida,
  // a mesma checagem roda uma vez (nível do estabelecimento) e depois
  // por cliente distinto de cada fatia Fiado.
  const fatiasFiado = dividida ? pagamentos.filter(p => p.meioPagamento === 'Fiado') : [];
  if ((!dividida && meio_pagamento === 'Fiado') || fatiasFiado.length > 0) {
    const { data: merc } = await db
      .from('mercearias')
      .select('fiado_ativo')
      .eq('id', mercearia_id)
      .single();
    if (merc?.fiado_ativo === false) {
      return res.status(403).json({ error: 'O módulo de Fiado está desativado para este estabelecimento.' });
    }

    const clienteIdsFiado = dividida
      ? [...new Set(fatiasFiado.map(p => p.clienteId))]
      : [clienteId];

    const { data: clientesFiado } = await db
      .from('clientes')
      .select('id, permite_fiado')
      .in('id', clienteIdsFiado)
      .eq('mercearia_id', mercearia_id);

    for (const cid of clienteIdsFiado) {
      const cli = clientesFiado?.find(c => c.id === cid);
      if (cli?.permite_fiado === false) {
        return res.status(403).json({ error: 'Esse cliente não está habilitado para comprar fiado.' });
      }
    }
  }

  // operador_id: só preenche se for operador, merchant deixa null
  const operadorId = role === 'operator' ? userId : null;

  try {
    const rpcParams = {
      p_valor_total:    totalVendaFloat,
      p_meio_pagamento: dividida ? 'Dividido' : meio_pagamento,
      p_carrinho_itens: carrinho,
      // clienteId vai direto pra função em qualquer forma de pagamento
      // não-dividida — ela já só mexe em saldo_devedor quando
      // meio_pagamento = 'Fiado', então não tem risco de criar dívida
      // fantasma numa venda paga na hora. Numa venda dividida o
      // cliente_id da venda fica NULL — o vínculo de verdade é por
      // fatia, dentro de `pagamentos`.
      p_cliente_id:     dividida ? null : (clienteId || null),
      p_operador_id:    operadorId,
      p_mercearia_id:   mercearia_id,
    };
    if (dividida) {
      rpcParams.p_pagamentos = pagamentos.map(p => ({
        meio_pagamento: p.meioPagamento,
        valor:          parseFloat(p.valor),
        pessoa_label:   p.pessoaLabel || null,
        cliente_id:     p.clienteId || null,
        valor_recebido: p.valorRecebido != null ? parseFloat(p.valorRecebido) : null,
        troco:          p.troco != null ? parseFloat(p.troco) : null,
      }));
    }

    const { data: vendaId, error } = await db.rpc('finalizar_venda', rpcParams);

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

    // Registrar na auditoria — busca nome do cliente e dos produtos
    // vendidos, pra descrição ficar completa (não só o valor)
    const { data: itensAud } = await db
      .from('itens_venda')
      .select('quantidade, produtos ( nome )')
      .eq('venda_id', vendaId);
    const resumoItens = (itensAud || [])
      .map(i => `${parseFloat(i.quantidade).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}× ${i.produtos?.nome || 'Produto'}`)
      .join(', ');

    let descricaoVenda;
    let metaVenda;

    if (dividida) {
      // Nomes dos clientes citados em alguma fatia (normalmente só as
      // de Fiado, mas não custa cobrir qualquer fatia com cliente_id).
      const clienteIdsParaNome = [...new Set(pagamentos.filter(p => p.clienteId).map(p => p.clienteId))];
      let nomesPorId = {};
      if (clienteIdsParaNome.length > 0) {
        const { data: clis } = await db.from('clientes').select('id, nome').in('id', clienteIdsParaNome);
        (clis || []).forEach(c => { nomesPorId[c.id] = c.nome; });
      }

      const fatiasDescritas = pagamentos.map((p, i) => {
        const label = p.pessoaLabel || `Pessoa ${i + 1}`;
        const clienteTxt = p.clienteId && nomesPorId[p.clienteId] ? ` (Cliente: ${nomesPorId[p.clienteId]})` : '';
        return { label, meioPagamento: p.meioPagamento, valor: parseFloat(p.valor), clienteId: p.clienteId || null, clienteNome: p.clienteId ? (nomesPorId[p.clienteId] || null) : null, clienteTxt };
      });

      const resumoFatias = fatiasDescritas
        .map(f => `${f.label}: ${fmtBRL(f.valor)} ${MEIO_LABEL[f.meioPagamento] || f.meioPagamento}${f.clienteTxt}`)
        .join('; ');

      descricaoVenda = `Venda de ${fmtBRL(totalVendaFloat)} — Dividida em ${pagamentos.length}: ${resumoFatias}`
        + (resumoItens ? ` — Itens: ${resumoItens}` : '');

      metaVenda = {
        venda_id: vendaId,
        valor: totalVendaFloat,
        meio_pagamento: 'Dividido',
        pagamentos: fatiasDescritas.map(f => ({ pessoa_label: f.label, meio_pagamento: f.meioPagamento, valor: f.valor, cliente_id: f.clienteId, cliente_nome: f.clienteNome })),
        itens: itensAud?.length || 0,
      };
    } else {
      const meioLabel = MEIO_LABEL[meio_pagamento] || meio_pagamento;

      let clienteNomeAud = null;
      if (clienteId) {
        const { data: cliAud } = await db.from('clientes').select('nome').eq('id', clienteId).single();
        clienteNomeAud = cliAud?.nome || null;
      }

      descricaoVenda = `Venda de ${fmtBRL(totalVendaFloat)} — ${meioLabel}`
        + (clienteNomeAud ? ` — Cliente: ${clienteNomeAud}` : '')
        + (resumoItens ? ` — Itens: ${resumoItens}` : '');

      metaVenda = { venda_id: vendaId, valor: totalVendaFloat, meio_pagamento, cliente_nome: clienteNomeAud, itens: itensAud?.length || 0 };
    }

    const { error: errAuditoria } = await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  operadorId,
      usuario_nome: req.user.nome || req.user.email,
      modulo:       'pdv',
      acao:         'venda_realizada',
      descricao:    descricaoVenda,
      meta:         metaVenda,
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
//
// Venda dividida (meio_pagamento = 'Dividido'): pode ter mais de um
// cliente fiado na mesma venda — o estorno de saldo roda em loop, uma
// vez por fatia Fiado, lendo `pagamentos_venda`. As linhas de
// `pagamentos_venda` em si NÃO são apagadas (mesmo espírito de nunca
// apagar rastro que já vale pra `itens_venda`).

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

    // 1) Estorna o estoque de cada item vendido — se o item era de uma
    // variação específica (tamanho/cor), devolve pro estoque DA
    // VARIAÇÃO, não do produto base.
    const { data: itens } = await db
      .from('itens_venda')
      .select('produto_id, produto_variacao_id, quantidade, produtos ( nome )')
      .eq('venda_id', id);

    for (const item of itens || []) {
      if (item.produto_variacao_id) {
        const { data: variacao } = await db
          .from('produto_variacoes')
          .select('estoque_atual')
          .eq('id', item.produto_variacao_id)
          .single();
        if (variacao) {
          await db.from('produto_variacoes')
            .update({ estoque_atual: parseFloat(variacao.estoque_atual || 0) + parseFloat(item.quantidade) })
            .eq('id', item.produto_variacao_id);
        }
      } else {
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
    }

    // 2) Estorna o dinheiro — se foi fiado, tira do saldo devedor do
    // cliente; se foi dividida, tira o saldo de CADA cliente fiado
    // envolvido (pode ter mais de um) e ainda apaga as entradas de
    // caixa das fatias não-fiado; se não, só remove a(s) entrada(s)
    // que tinham sido lançadas no caixa.
    let fatiasDivididas = null;
    if (venda.meio_pagamento === 'Dividido') {
      const { data: fatias } = await db
        .from('pagamentos_venda')
        .select('ordem, pessoa_label, meio_pagamento, valor, cliente_id')
        .eq('venda_id', id)
        .order('ordem');
      fatiasDivididas = fatias || [];

      for (const fatia of fatiasDivididas.filter(f => f.meio_pagamento === 'Fiado' && f.cliente_id)) {
        const { data: cliente } = await db
          .from('clientes')
          .select('saldo_devedor')
          .eq('id', fatia.cliente_id)
          .single();
        if (cliente) {
          const novoSaldo = Math.max(0, parseFloat(cliente.saldo_devedor || 0) - parseFloat(fatia.valor));
          await db.from('clientes').update({ saldo_devedor: novoSaldo }).eq('id', fatia.cliente_id);
        }
      }
      await db.from('transacoes_caixa').delete().eq('venda_id', id);
    } else if (venda.meio_pagamento === 'Fiado' && venda.cliente_id) {
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

    // 4) Auditoria — nome do cliente e resumo dos itens cancelados,
    // pra descrição ficar completa (não só o valor)
    const resumoItens = (itens || [])
      .map(i => `${parseFloat(i.quantidade).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}× ${i.produtos?.nome || 'Produto'}`)
      .join(', ');

    let descricaoCancel;
    let metaCancel;

    if (venda.meio_pagamento === 'Dividido') {
      const clienteIdsParaNome = [...new Set((fatiasDivididas || []).filter(f => f.cliente_id).map(f => f.cliente_id))];
      let nomesPorId = {};
      if (clienteIdsParaNome.length > 0) {
        const { data: clis } = await db.from('clientes').select('id, nome').in('id', clienteIdsParaNome);
        (clis || []).forEach(c => { nomesPorId[c.id] = c.nome; });
      }

      const fatiasDescritas = (fatiasDivididas || []).map((f, i) => {
        const label = f.pessoa_label || `Pessoa ${i + 1}`;
        const clienteTxt = f.cliente_id && nomesPorId[f.cliente_id] ? ` (Cliente: ${nomesPorId[f.cliente_id]})` : '';
        return { label, meioPagamento: f.meio_pagamento, valor: parseFloat(f.valor), clienteId: f.cliente_id || null, clienteNome: f.cliente_id ? (nomesPorId[f.cliente_id] || null) : null, clienteTxt };
      });

      const resumoFatias = fatiasDescritas
        .map(f => `${f.label}: ${fmtBRL(f.valor)} ${MEIO_LABEL[f.meioPagamento] || f.meioPagamento}${f.clienteTxt}`)
        .join('; ');

      descricaoCancel = `Venda de ${fmtBRL(venda.valor_total)} (Dividida em ${fatiasDescritas.length}: ${resumoFatias}) cancelada`
        + (resumoItens ? ` — Itens: ${resumoItens}` : '')
        + (motivo ? ` — Motivo: ${motivo}` : '');

      metaCancel = {
        venda_id: id,
        valor: venda.valor_total,
        meio_pagamento: 'Dividido',
        pagamentos: fatiasDescritas.map(f => ({ pessoa_label: f.label, meio_pagamento: f.meioPagamento, valor: f.valor, cliente_id: f.clienteId, cliente_nome: f.clienteNome })),
        motivo: motivo || null,
      };
    } else {
      const meioLabel = MEIO_LABEL[venda.meio_pagamento] || venda.meio_pagamento;

      let clienteNomeAud = null;
      if (venda.cliente_id) {
        const { data: cliAud } = await db.from('clientes').select('nome').eq('id', venda.cliente_id).single();
        clienteNomeAud = cliAud?.nome || null;
      }

      descricaoCancel = `Venda de ${fmtBRL(venda.valor_total)} (${meioLabel}) cancelada`
        + (clienteNomeAud ? ` — Cliente: ${clienteNomeAud}` : '')
        + (resumoItens ? ` — Itens: ${resumoItens}` : '')
        + (motivo ? ` — Motivo: ${motivo}` : '');

      metaCancel = { venda_id: id, valor: venda.valor_total, meio_pagamento: venda.meio_pagamento, cliente_nome: clienteNomeAud, motivo: motivo || null };
    }

    const { error: errAuditoria } = await db.from('auditoria').insert({
      mercearia_id,
      operador_id:  role === 'operator' ? userId : null,
      usuario_nome: req.user.nome || req.user.email,
      modulo:       'pdv',
      acao:         'venda_cancelada',
      descricao:    descricaoCancel,
      meta:         metaCancel,
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
