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

  // ── Preço e total conferidos com o cadastro (22/09/2026) ──────────
  // Antes o backend gravava o preço e o total que o PDV mandava, sem
  // conferir. Agora cada item é comparado com o preço ATUAL do cadastro
  // (preço da variação, se tiver um próprio; senão o do produto). Se
  // algum preço mudou desde que o item entrou no carrinho (outra pessoa
  // editou o produto nesse meio-tempo), a venda NÃO é gravada: volta 409
  // com a lista do que mudou, e o PDV mostra o aviso pro caixa aplicar o
  // preço novo antes de finalizar.
  try {
    for (const [i, item] of carrinho.entries()) {
      const qtd = parseFloat(item.quantidade);
      if (!item.produto_id || isNaN(qtd) || qtd <= 0 || isNaN(parseFloat(item.valor_unitario))) {
        return res.status(400).json({ error: `Item ${i + 1} do carrinho está com dados inválidos.` });
      }
    }

    const produtoIds  = [...new Set(carrinho.map(i => i.produto_id))];
    const variacaoIds = [...new Set(carrinho.map(i => i.produto_variacao_id).filter(Boolean))];

    const { data: produtosCadastro, error: errProd } = await db
      .from('produtos')
      .select('id, nome, preco_venda')
      .in('id', produtoIds)
      .eq('mercearia_id', mercearia_id);
    if (errProd) throw errProd;

    let variacoesCadastro = [];
    if (variacaoIds.length > 0) {
      const { data: vars, error: errVar } = await db
        .from('produto_variacoes')
        .select('id, produto_id, preco_venda')
        .in('id', variacaoIds)
        .eq('mercearia_id', mercearia_id);
      if (errVar) throw errVar;
      variacoesCadastro = vars || [];
    }

    const precosAlterados = [];
    let totalConferido = 0;

    for (const [i, item] of carrinho.entries()) {
      const prod = (produtosCadastro || []).find(p => p.id === item.produto_id);
      if (!prod) {
        return res.status(409).json({
          codigo: 'PRODUTO_INDISPONIVEL',
          error: 'Um dos produtos do carrinho não existe mais no cadastro. Remova-o e tente de novo.',
          produto_id: item.produto_id,
        });
      }

      let precoAtual = parseFloat(prod.preco_venda);
      if (item.produto_variacao_id) {
        const v = variacoesCadastro.find(x => x.id === item.produto_variacao_id && x.produto_id === item.produto_id);
        if (!v) {
          return res.status(409).json({
            codigo: 'PRODUTO_INDISPONIVEL',
            error: `A variação escolhida de "${prod.nome}" não existe mais no cadastro. Remova-a e tente de novo.`,
            produto_id: item.produto_id,
          });
        }
        if (v.preco_venda != null) precoAtual = parseFloat(v.preco_venda);
      }

      const precoEnviado = parseFloat(item.valor_unitario);
      if (Math.abs(precoEnviado - precoAtual) > 0.005) {
        precosAlterados.push({
          index: i,
          produto_id: item.produto_id,
          produto_variacao_id: item.produto_variacao_id || null,
          nome: prod.nome,
          preco_anterior: precoEnviado,
          preco_atual: precoAtual,
        });
      }
      totalConferido += precoAtual * parseFloat(item.quantidade);
    }

    if (precosAlterados.length > 0) {
      const nomes = precosAlterados.map(p => `"${p.nome}"`).join(', ');
      return res.status(409).json({
        codigo: 'PRECO_ALTERADO',
        error: `O preço de ${nomes} foi alterado no cadastro enquanto a venda estava aberta. Confira e aplique o preço novo antes de finalizar.`,
        itens: precosAlterados,
      });
    }

    // Mesma tolerância de centavo já usada na soma das fatias.
    if (Math.abs(totalConferido - totalVendaFloat) > 0.01) {
      return res.status(400).json({
        codigo: 'TOTAL_DIVERGENTE',
        error: `O total da venda (${fmtBRL(totalVendaFloat)}) não confere com os itens (${fmtBRL(totalConferido)}). Atualize a tela e tente de novo.`,
      });
    }
  } catch (err) {
    console.error('[ERRO] Conferência de preços da venda:', err.message);
    return res.status(500).json({ error: 'Não foi possível conferir os preços da venda. Tente de novo.' });
  }

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

    // Estoque acabou entre o item entrar no carrinho e a venda ser
    // finalizada (outro caixa vendeu, ou alguém ajustou o estoque). A
    // função no banco desfaz a venda inteira nesse caso — nada é gravado.
    const msg = String(err?.message || '');
    const m = msg.match(/ESTOQUE_INSUFICIENTE:([0-9a-f-]{36}):([0-9a-f-]{36})?/i);
    if (m) {
      const [, produtoId, variacaoId] = m;
      let nome = 'um dos produtos';
      let disponivel = null;
      try {
        const { data: p } = await db.from('produtos').select('nome, estoque_atual, unidade_medida')
          .eq('id', produtoId).eq('mercearia_id', mercearia_id).single();
        if (p) {
          nome = `"${p.nome}"`;
          disponivel = p.estoque_atual;
          if (variacaoId) {
            const { data: v } = await db.from('produto_variacoes').select('estoque_atual')
              .eq('id', variacaoId).eq('mercearia_id', mercearia_id).single();
            if (v) disponivel = v.estoque_atual;
          }
        }
      } catch { /* só enriquece a mensagem */ }
      const dispTxt = disponivel != null
        ? ` Disponível agora: ${parseFloat(disponivel).toLocaleString('pt-BR', { maximumFractionDigits: 3 })}.`
        : '';
      return res.status(409).json({
        codigo: 'ESTOQUE_INSUFICIENTE',
        error: `Estoque insuficiente para ${nome} — ele mudou enquanto a venda estava aberta.${dispTxt} Ajuste a quantidade e finalize de novo.`,
        produto_id: produtoId,
        produto_variacao_id: variacaoId || null,
      });
    }

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

    // 1-3) Estorno de estoque, dinheiro (saldo do cliente / caixa) e
    // status — tudo numa transação só, dentro do banco
    // (`cancelar_venda_atomico`, 22/09/2026). Antes eram várias chamadas
    // separadas lendo e regravando o estoque: duas pessoas cancelando a
    // mesma venda ao mesmo tempo estornavam em dobro, e uma venda feita
    // no meio do estorno podia ter a baixa "apagada". Agora a venda fica
    // travada durante o cancelamento e cada soma é feita no próprio
    // UPDATE. As leituras abaixo são só pra descrição da auditoria.
    const { data: itens } = await db
      .from('itens_venda')
      .select('produto_id, produto_variacao_id, quantidade, produtos ( nome )')
      .eq('venda_id', id);

    let fatiasDivididas = null;
    if (venda.meio_pagamento === 'Dividido') {
      const { data: fatias } = await db
        .from('pagamentos_venda')
        .select('ordem, pessoa_label, meio_pagamento, valor, cliente_id')
        .eq('venda_id', id)
        .order('ordem');
      fatiasDivididas = fatias || [];
    }

    const { error: errCancel } = await db.rpc('cancelar_venda_atomico', {
      p_venda_id:     id,
      p_mercearia_id: mercearia_id,
      p_motivo:       motivo || null,
    });
    if (errCancel) {
      const msgCancel = String(errCancel.message || '');
      if (msgCancel.includes('VENDA_JA_CANCELADA')) {
        return res.status(400).json({ error: 'Essa venda já está cancelada.' });
      }
      if (msgCancel.includes('VENDA_NAO_ENCONTRADA')) {
        return res.status(404).json({ error: 'Venda não encontrada.' });
      }
      throw errCancel;
    }

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
