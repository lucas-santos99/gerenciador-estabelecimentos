// utils/whatsappAssistente.js
// ============================================================
// WhatsApp — assistente de consultas por MENU, sem IA (30/09/2026).
// Chamado pelo webhook (routes/whatsappWebhookRoutes.js) quando chega
// mensagem de um número CONFIRMADO de uma loja e o WhatsApp está liberado
// para as lojas (integracao.ativo).
//
// Como funciona
//   • "menu" (ou oi, ajuda…) → lista do WhatsApp com as consultas que
//     AQUELA PESSOA pode fazer (permissões iguais às do painel: cada número
//     é ligado a um usuário da loja — dono ou operador).
//   • Também entende atalhos escritos: "vendas hoje", "vendas mês",
//     "estoque coca", "fiado", "contas", "estoque baixo", "saldo".
//   • Produto com mais de um parecido → lista pra escolher (nunca chuta).
//
// Créditos (doc do Projeto, "Mensalidade justa e sem prejuízo")
//   • 1 pedido = do começo ao fim (lista de escolha + resposta). Só a
//     RESPOSTA com dados gasta crédito (peso "consulta", editável no
//     SuperAdmin). Menu, instruções, "não achei", "sem permissão", saldo e
//     erros não gastam.
//   • Débito atômico e único por pedido (função whatsapp_consumir_creditos,
//     SQL 15). Mensagem que a Meta avisa como "falhou" devolve o crédito.
//   • Travas: pedidos por minuto (por número) e por dia (por loja).
//   • Teto de custo por loja (disjuntor): soma o custo real do ciclo
//     (whatsapp_envios) e compara com o preço do plano. Aviso% → avisa o
//     SuperAdmin; Ação% → pausa o assistente (ou só avisa), até o master
//     retomar ou o ciclo virar.
// ============================================================
const crypto = require('crypto');
const db = require('../db/supabaseAdmin');
const { registrar } = require('../routes/auditoriaRoutes');
const { TIMEZONE_PADRAO, hojeStrTZ, inicioDiaTZ } = require('./fusoHorario');
const W = require('./whatsappCustos');
const A = require('./whatsappAssinaturas');
const M = require('./whatsappMeta');
const C = require('./whatsappConsultas');

const MIN = 1 / 60; // 1 minuto, em horas (para respondeuRecente)

/* ── Catálogo de consultas ──────────────────────────────────── */
const tem = (pessoa, ...ps) => pessoa.dono || ps.some(p => pessoa.permissoes.includes(p));
const podeVendas = (x) => tem(x, 'financeiro', 'relatorios');
const CONSULTAS = {
  vendas_hoje:     { titulo: 'Vendas de hoje',      desc: 'Total, quantidade e formas de pagamento', pode: podeVendas },
  vendas_ontem:    { titulo: 'Vendas de ontem',     desc: 'Total do dia anterior',                  pode: podeVendas },
  vendas_7d:       { titulo: 'Vendas 7 dias',       desc: 'Últimos 7 dias, com o melhor dia',        pode: podeVendas },
  vendas_mes:      { titulo: 'Vendas do mês',       desc: 'Do dia 1º até hoje',                      pode: podeVendas },
  estoque_produto: { titulo: 'Estoque de produto',  desc: 'Você escreve o nome ou o código',         pode: (x) => tem(x, 'estoque', 'pdv') },
  estoque_baixo:   { titulo: 'Estoque baixo',       desc: 'Sem estoque e abaixo do mínimo',          pode: (x) => tem(x, 'estoque') },
  fiado:           { titulo: 'Quem deve (fiado)',   desc: 'Total em aberto e maiores dívidas',       pode: (x) => tem(x, 'clientes') },
  contas:          { titulo: 'Contas a pagar',      desc: 'Atrasadas e próximos 7 dias',             pode: (x) => tem(x, 'financeiro', 'financeiro_contas_pagar', 'fornecedores') },
  saldo:           { titulo: 'Meus créditos',       desc: 'Saldo do WhatsApp (não gasta crédito)',   pode: () => true, gratis: true },
};

/* ── Leitura da mensagem ────────────────────────────────────── */
function lerEntrada(msg) {
  if (msg.type === 'text') return { tipo: 'texto', texto: String(msg.text?.body || '') };
  if (msg.type === 'interactive') {
    const r = msg.interactive?.list_reply || msg.interactive?.button_reply;
    if (r?.id) return { tipo: 'escolha', id: String(r.id), titulo: r.title || '' };
  }
  if (msg.type === 'button' && msg.button?.payload) return { tipo: 'escolha', id: String(msg.button.payload), titulo: msg.button.text || '' };
  return { tipo: 'outro', formato: msg.type || 'desconhecido' };
}

// Texto livre → comando. null = não reconheceu.
function interpretar(texto) {
  const t = C.normalizar(texto);
  if (!t) return { acao: 'menu' };
  if (/^(menu|inicio|opcoes|opcao|ajuda|help|oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|voltar|0)$/.test(t)) return { acao: 'menu' };
  if (/^(trocar|mudar)( de)? loja$|^lojas?$/.test(t)) return { acao: 'trocar_loja' };
  if (/\b(suporte|atendente|humano|atendimento|falar com (alguem|uma pessoa|voces))\b/.test(t)) return { acao: 'suporte' };
  if (/^(meu |meus |ver )?(saldo|creditos?)( do whatsapp)?$/.test(t)) return { acao: 'consulta', chave: 'saldo' };
  if (/\bestoque (baixo|minimo|acabando)\b|\b(acabando|em falta|sem estoque|zerados?|repor|reposicao)\b/.test(t)) return { acao: 'consulta', chave: 'estoque_baixo' };
  // "estoque coca" / "produto coca" (prefixo forte, vem antes de tudo)
  const termoApos = (n) => String(texto).trim().split(/\s+/).slice(n).join(' ');
  let m = /^(estoque|produto)\s+(.+)$/.exec(t);
  if (m) return { acao: 'consulta', chave: 'estoque_produto', termo: termoApos(1) };
  if (/^(estoque|produto|produtos)$/.test(t)) return { acao: 'consulta', chave: 'estoque_produto' };
  if (/\b(fiado|fiados|devedor|devedores|devem|devendo|caderneta)\b|\bquem (me )?deve\b/.test(t)) return { acao: 'consulta', chave: 'fiado' };
  if (/\b(contas?|boletos?|vencimentos?)\b|\bpagar\b/.test(t)) return { acao: 'consulta', chave: 'contas' };
  if (/\b(vend\w*|faturamento|fatur\w*)\b/.test(t)) {
    if (/\bontem\b/.test(t)) return { acao: 'consulta', chave: 'vendas_ontem' };
    if (/\b(semana|7 dias|sete dias)\b/.test(t)) return { acao: 'consulta', chave: 'vendas_7d' };
    if (/\b(mes|mensal)\b/.test(t)) return { acao: 'consulta', chave: 'vendas_mes' };
    return { acao: 'consulta', chave: 'vendas_hoje' };
  }
  // Só um código de barras
  if (/^\d{8,14}$/.test(t)) return { acao: 'consulta', chave: 'estoque_produto', termo: t };
  // Prefixos fracos: "tem coca?", "quantos sabão em pó"
  m = /^(tem|quantos|quantas|qtd|quanto tem de|quanto tem|buscar|procurar)\s+(.+)$/.exec(t);
  if (m) return { acao: 'consulta', chave: 'estoque_produto', termo: termoApos(m[1].split(' ').length) };
  return null;
}

/* ── Conversa (estado por número) ───────────────────────────── */
async function lerConversa(tel) {
  const { data } = await db.from('whatsapp_conversas').select('*').eq('telefone', tel).maybeSingle();
  if (!data) return { telefone: tel, mercearia_id: null, estado: null, dados: {} };
  if (data.estado && data.expira_em && new Date(data.expira_em).getTime() < Date.now()) {
    return { ...data, estado: null, dados: {} };
  }
  return { ...data, dados: data.dados || {} };
}
async function salvarConversa(tel, campos) {
  const { error } = await db.from('whatsapp_conversas').upsert({
    telefone: tel, ...campos, atualizado_em: new Date().toISOString(),
  }, { onConflict: 'telefone' });
  if (error) console.error('[WHATSAPP] conversa:', error.message);
}
const expiraEm = (min) => new Date(Date.now() + min * 60000).toISOString();

/* ── Auxiliares ─────────────────────────────────────────────── */
async function respondeuRecente(variantes, horas, categoria) {
  const desde = new Date(Date.now() - horas * 3600000).toISOString();
  const { data } = await db.from('whatsapp_envios').select('id')
    .in('destino', variantes).eq('direcao', 'saida').eq('categoria', categoria).gte('criado_em', desde).limit(1);
  return !!(data && data.length);
}

async function linkSuporte() {
  try {
    const { data } = await db.from('config_sistema').select('valor').eq('chave', 'whatsapp_suporte').maybeSingle();
    const n = String(data?.valor || '').replace(/\D/g, '');
    return n.length >= 12 && n !== '5500000000000' ? `https://wa.me/${n}` : null;
  } catch { return null; }
}

const primeiroNome = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const fmtCred = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return `${v.toLocaleString('pt-BR')} crédito${v === 1 ? '' : 's'}`; };

// Pessoa ligada ao número: usuário do vínculo, ou o dono (vínculos antigos,
// sem usuário, eram sempre do dono). null = não pode usar.
async function carregarPessoa(v) {
  let perfil = null;
  if (v.usuario_id) {
    const { data } = await db.from('profiles').select('id, nome, role, mercearia_id, is_active').eq('id', v.usuario_id).maybeSingle();
    perfil = data;
  } else {
    const { data } = await db.from('profiles').select('id, nome, role, mercearia_id, is_active')
      .eq('mercearia_id', v.mercearia_id).eq('role', 'merchant').limit(1);
    perfil = (data || [])[0] || null;
  }
  if (!perfil || String(perfil.mercearia_id) !== String(v.mercearia_id) || perfil.is_active === false) return null;
  if (perfil.role === 'merchant') return { id: perfil.id, nome: perfil.nome || v.apelido, dono: true, permissoes: [] };
  if (perfil.role !== 'operator') return null;
  const [{ data: op }, { data: perms }] = await Promise.all([
    db.from('operadores').select('status').eq('id', perfil.id).eq('mercearia_id', v.mercearia_id).maybeSingle(),
    db.from('permissoes_operador').select('permissao_id').eq('operador_id', perfil.id),
  ]);
  if (op && op.status !== 'ativo') return null;
  return { id: perfil.id, nome: perfil.nome || v.apelido, dono: false, permissoes: (perms || []).map(p => p.permissao_id) };
}

/* ── Teto de custo por loja (disjuntor) ─────────────────────── */
async function custoDoCiclo(mid, a, tz) {
  const desde = inicioDiaTZ(a.ciclo_inicio, tz).toISOString();
  const envs = await C.todas(() => db.from('whatsapp_envios')
    .select('custo_meta_estimado, custo_ia_estimado, tipo, status')
    .eq('mercearia_id', mid).eq('direcao', 'saida').gte('criado_em', desde)
    .in('tipo', ['resposta', 'alerta']).neq('status', 'falhou'), 50000);
  return envs.reduce((s, e) => s + (Number(e.custo_meta_estimado) || 0) + (Number(e.custo_ia_estimado) || 0), 0);
}

// Devolve { pausado } e, se cruzou um limite agora, registra.
async function verificarTeto(ctx) {
  const a = ctx.assinatura;
  const preco = Number(a.preco) || 0;
  if (preco <= 0) return { pausado: false };
  const mesmoCiclo = a.teto_ciclo === a.ciclo_inicio;
  const liberado = mesmoCiclo && !!a.teto_liberado_em;
  if (mesmoCiclo && a.teto_pausado_em && !liberado) return { pausado: true };

  const custo = await custoDoCiclo(ctx.mid, a, ctx.tz);
  const pct = (custo / preco) * 100;
  const { aviso_pct, acao_pct, acao } = ctx.params.teto_loja;
  const agora = new Date().toISOString();
  const reinicio = mesmoCiclo ? {} : { teto_ciclo: a.ciclo_inicio, teto_aviso_em: null, teto_pausado_em: null, teto_liberado_em: null, teto_liberado_por_nome: null };
  const desc = `custo do ciclo R$ ${custo.toFixed(2)} = ${pct.toFixed(0)}% do plano (R$ ${preco.toFixed(2)})`;

  if (pct >= acao_pct && !liberado && acao === 'pausar') {
    await db.from('whatsapp_assinaturas').update({ ...reinicio, teto_pausado_em: agora, teto_aviso_em: (mesmoCiclo && a.teto_aviso_em) || agora })
      .eq('id', a.id).eq('status', 'ativa');
    registrar({
      mercearia_id: ctx.mid, usuario_nome: 'Sistema (WhatsApp)', usuario_email: 'Sistema (WhatsApp)',
      modulo: 'whatsapp', acao: 'whatsapp_teto_pausado', escopo: 'admin_global',
      descricao: `Assistente do WhatsApp pausado pelo teto de custo (${acao_pct}%): ${desc}`,
      meta: { assinatura_id: a.id, custo, pct, preco },
    });
    return { pausado: true, agora: true };
  }
  if (pct >= aviso_pct && !(mesmoCiclo && a.teto_aviso_em)) {
    await db.from('whatsapp_assinaturas').update({ ...reinicio, teto_aviso_em: agora }).eq('id', a.id).eq('status', 'ativa');
    registrar({
      mercearia_id: ctx.mid, usuario_nome: 'Sistema (WhatsApp)', usuario_email: 'Sistema (WhatsApp)',
      modulo: 'whatsapp', acao: 'whatsapp_teto_aviso', escopo: 'admin_global',
      descricao: `WhatsApp passou de ${aviso_pct}% do teto de custo: ${desc}`,
      meta: { assinatura_id: a.id, custo, pct, preco },
    });
  }
  return { pausado: false };
}

/* ── Envio com os dados da conversa ─────────────────────────── */
function enviarTexto(ctx, texto, extra = {}) {
  return M.enviarTexto({ para: ctx.de, texto, tipo: 'resposta', mercearia_id: ctx.mid, ...extra });
}
function enviarLista(ctx, interativo, extra = {}) {
  return M.enviarInterativo({ para: ctx.de, interativo, tipo: 'resposta', mercearia_id: ctx.mid, ...extra });
}
// Resposta automática "de aviso", no máximo 1× a cada `horas`
async function avisoUnico(ctx, categoria, horas, texto) {
  if (await respondeuRecente(ctx.variantes, horas, categoria)) return;
  await M.enviarTexto({ para: ctx.de, texto, tipo: 'resposta', mercearia_id: ctx.mid, categoria });
}

/* ── Menu ───────────────────────────────────────────────────── */
function opcoesDoMenu(ctx) {
  const rows = Object.entries(CONSULTAS).filter(([, c]) => c.pode(ctx.pessoa))
    .map(([k, c]) => ({ id: `c:${k}`, title: c.titulo, description: c.desc }));
  if (ctx.multiLoja && rows.length < 10) rows.push({ id: 'c:trocar_loja', title: 'Trocar de loja', description: 'Este número está em mais de uma loja' });
  return rows;
}

async function enviarMenu(ctx, prefixo = '') {
  // Evita menu repetido em rajada (duas mensagens seguidas)
  if (await respondeuRecente(ctx.variantes, 20 / 3600, 'menu')) return;
  const rows = opcoesDoMenu(ctx);
  const peso = ctx.params.pesos.consulta;
  const podeProduto = CONSULTAS.estoque_produto.pode(ctx.pessoa);
  const corpo = [
    prefixo || `Olá, ${primeiroNome(ctx.pessoa.nome) || 'tudo bem'}! 👋 O que você quer consultar?`,
    '',
    'Toque em *Ver opções*.' + (podeProduto ? ' Para um produto, também dá pra escrever direto, por exemplo: *estoque coca*.' : ''),
    '',
    `Cada consulta usa ${fmtCred(peso)}. Saldo: *${fmtCred(ctx.saldo)}*.`,
  ].join('\n');
  await enviarLista(ctx, {
    type: 'list',
    header: { text: ctx.loja.nome_fantasia || 'Consultas' },
    body: { text: corpo },
    footer: { text: 'Falar com uma pessoa: escreva "suporte"' },
    action: { button: 'Ver opções', sections: [{ title: 'Consultas', rows }] },
  }, { categoria: 'menu' });
  await salvarConversa(ctx.de, { mercearia_id: ctx.mid, estado: null, dados: {}, expira_em: null });
}

/* ── Escolha de loja (número em mais de uma loja) ───────────── */
async function pedirLoja(de, variantes, ativos) {
  if (await respondeuRecente(variantes, 20 / 3600, 'escolher_loja')) return;
  const { data } = await db.from('mercearias').select('id, nome_fantasia').in('id', ativos.map(a => a.mercearia_id));
  const nomes = Object.fromEntries((data || []).map(m => [m.id, m.nome_fantasia]));
  await M.enviarInterativo({
    para: de, tipo: 'resposta', mercearia_id: null, categoria: 'escolher_loja',
    interativo: {
      type: 'list',
      body: { text: 'Este número está cadastrado em mais de uma loja. Qual você quer consultar agora?\n\nPara mudar depois, escreva *trocar loja*.' },
      action: { button: 'Escolher loja', sections: [{ title: 'Lojas', rows: ativos.slice(0, 10).map(a => ({ id: `loja:${a.mercearia_id}`, title: nomes[a.mercearia_id] || 'Estabelecimento', description: a.apelido })) }] },
    },
  });
  await salvarConversa(de, { mercearia_id: null, estado: 'escolher_loja', dados: {}, expira_em: expiraEm(30) });
}

/* ── Consulta com débito de crédito ─────────────────────────── */
// gerar() → string (resposta com dados, gasta crédito)
//         | { texto, cobrar:false } (resposta sem dados, não gasta)
//         | { lista } (pedido continua: a pessoa escolhe um item)
async function executarConsulta(ctx, chave, gerar, { pedidoId = null, dadosDepois = {} } = {}) {
  const def = CONSULTAS[chave];
  const peso = def.gratis ? 0 : ctx.params.pesos.consulta;
  if (peso > 0 && ctx.saldo < peso) {
    await avisoUnico(ctx, 'sem_saldo', 1, `Seu saldo de créditos do WhatsApp acabou (${fmtCred(ctx.saldo)}). 😕\n\nAs consultas voltam quando o ciclo renovar${ctx.assinatura.ciclo_fim ? ` (${C.fmtData(A.somarDias(ctx.assinatura.ciclo_fim, 1))})` : ''} ou se o dono pedir um pacote extra na tela *WhatsApp* do sistema.`);
    return;
  }
  const pedido_id = pedidoId || crypto.randomUUID();
  let r;
  try {
    r = await gerar();
  } catch (e) {
    console.error(`[WHATSAPP] consulta ${chave}:`, e.message);
    await avisoUnico(ctx, 'erro', MIN, 'Não consegui fazer essa consulta agora. Tente de novo em instantes. Nenhum crédito foi usado.');
    return;
  }

  if (r && r.lista) {
    const maxEnvios = ctx.params.travas.envios.consulta || 2;
    const envioComPedido = maxEnvios >= 2;
    const env = await enviarLista(ctx, r.lista, { categoria: 'escolha', ...(envioComPedido ? { pedido_id, pedido_tipo: 'consulta' } : {}) });
    if (env.ok) await salvarConversa(ctx.de, { mercearia_id: ctx.mid, estado: 'escolher_produto', dados: { pedido_id: envioComPedido ? pedido_id : null, opcoes: r.opcoes || [] }, expira_em: expiraEm(30) });
    return;
  }
  if (r && typeof r === 'object' && r.cobrar === false) {
    await enviarTexto(ctx, r.texto, { categoria: `consulta_${chave}` });
    if (r.estado) await salvarConversa(ctx.de, { mercearia_id: ctx.mid, ...r.estado });
    return;
  }

  const texto = String(r || '');
  const rodape = peso > 0
    ? `\n\n_${fmtCred(peso)} usado · saldo ${fmtCred(ctx.saldo - peso)} · ${C.horaTZ(ctx.tz)}_\nOutras consultas: escreva *menu*`
    : `\n\n_${C.horaTZ(ctx.tz)}_ · Outras consultas: escreva *menu*`;
  const env = await enviarTexto(ctx, texto + rodape, { categoria: `consulta_${chave}`, pedido_id: peso > 0 ? pedido_id : null, pedido_tipo: peso > 0 ? 'consulta' : null });
  await salvarConversa(ctx.de, { mercearia_id: ctx.mid, estado: null, dados: env.ok ? dadosDepois : {}, expira_em: null });
  if (!env.ok || peso <= 0) return; // falhou → nada debitado

  const { data: deb, error } = await db.rpc('whatsapp_consumir_creditos', {
    p_assinatura_id: ctx.assinatura.id, p_quantidade: peso, p_pedido_id: pedido_id, p_pedido_tipo: 'consulta',
    p_descricao: `Consulta: ${def.titulo}`, p_criado_por_nome: `${ctx.pessoa.nome} (WhatsApp)`,
  });
  if (error || !deb?.ok) {
    console.error('[WHATSAPP] débito de crédito:', error?.message || deb?.motivo);
    return;
  }
  if (env.envio_id && !deb.ja_debitado) await db.from('whatsapp_envios').update({ creditos: peso }).eq('id', env.envio_id);
}

// Crédito de volta quando a resposta de um pedido não foi entregue
async function estornarPedido(pedidoId, motivo) {
  if (!pedidoId) return;
  const { data: movs } = await db.from('whatsapp_creditos_mov').select('*').eq('pedido_id', pedidoId);
  const consumo = (movs || []).find(m => m.tipo === 'consumo');
  if (!consumo || (movs || []).some(m => m.tipo === 'estorno')) return;
  const { error } = await db.from('whatsapp_creditos_mov').insert({
    mercearia_id: consumo.mercearia_id, assinatura_id: consumo.assinatura_id, ciclo_inicio: consumo.ciclo_inicio,
    tipo: 'estorno', quantidade: -Number(consumo.quantidade), pedido_tipo: consumo.pedido_tipo, pedido_id: pedidoId,
    descricao: String(motivo || 'Mensagem não entregue — crédito devolvido').slice(0, 300), criado_por_nome: 'Sistema (WhatsApp)',
  });
  if (error) console.error('[WHATSAPP] estorno:', error.message);
}

/* ── Consultas ──────────────────────────────────────────────── */
async function consultarProduto(ctx, termo, pedidoId) {
  const t = String(termo || '').trim();
  if (!t) {
    // Sem nome ainda: pede o nome (não gasta crédito)
    await executarConsulta(ctx, 'estoque_produto', async () => ({
      cobrar: false,
      texto: '📦 Qual produto? Escreva o nome (ou o código de barras), por exemplo: *coca zero 2l*.',
      estado: { estado: 'aguardando_produto', dados: {}, expira_em: expiraEm(10) },
    }));
    return;
  }
  await executarConsulta(ctx, 'estoque_produto', async () => {
    const r = await C.buscarProdutos(ctx.mid, t.slice(0, 80));
    if (!r.produtos.length) {
      return { cobrar: false, texto: `Não achei nenhum produto com "${t.slice(0, 40)}" no cadastro. Confira o nome ou tente só uma parte (ex.: *coca*). Nenhum crédito foi usado.` };
    }
    if (r.exato || r.produtos.length === 1) return C.textoProduto(ctx.mid, r.produtos[0]);
    const mais = (r.total || 0) > 10 ? `\n\nAchei ${r.total}; mostrando os 10 mais parecidos. Se não estiver aqui, escreva um nome mais completo.` : '';
    return {
      lista: {
        type: 'list',
        body: { text: `${r.parecidos ? 'Não achei exatamente' : 'Achei mais de um produto para'} "${t.slice(0, 40)}". Qual deles?${mais}\n\nA escolha faz parte da mesma consulta (não gasta crédito a mais).` },
        action: { button: 'Escolher produto', sections: [{ title: 'Produtos', rows: r.produtos.map(p => ({
          id: `p:${p.id}`, title: p.nome,
          description: [p.marca, p.tem_variacoes ? 'com variações' : `estoque ${C.qtd(p.estoque_atual, p.unidade_medida)}`].filter(Boolean).join(' · '),
        })) }] },
      },
      opcoes: r.produtos.map(p => p.id),
    };
  }, { pedidoId });
}

async function rodarConsulta(ctx, chave, cmd = {}) {
  const def = CONSULTAS[chave];
  if (!def) return enviarMenu(ctx);
  if (!def.pode(ctx.pessoa)) {
    await avisoUnico(ctx, 'sem_permissao', MIN, `Você não tem permissão para ver *${def.titulo}* no sistema, então também não dá pra consultar por aqui. Se precisar, peça ao dono da loja para liberar. Nenhum crédito foi usado.`);
    return;
  }
  switch (chave) {
    case 'saldo':
      return executarConsulta(ctx, 'saldo', async () => {
        const a = ctx.assinatura;
        const r = await A.resumoCiclo(db, a.id, a.ciclo_inicio);
        const renova = C.diasEntre(hojeStrTZ(ctx.tz), A.somarDias(a.ciclo_fim, 1));
        return [
          `💳 *Créditos do WhatsApp* — ${ctx.loja.nome_fantasia || 'sua loja'}`, '',
          `Saldo: *${fmtCred(r.saldo)}* (plano ${a.plano_nome})`,
          `Usados neste ciclo: ${fmtCred(r.usados)}`,
          `Ciclo: ${C.fmtData(a.ciclo_inicio)} a ${C.fmtData(a.ciclo_fim)} (renova em ${renova} dia${renova === 1 ? '' : 's'})`,
          '', `Cada consulta usa ${fmtCred(ctx.params.pesos.consulta)}. Ver o saldo não gasta.`,
        ].join('\n');
      });
    case 'estoque_produto':
      return consultarProduto(ctx, cmd.termo, null);
    case 'estoque_baixo':
      return executarConsulta(ctx, chave, () => C.estoqueBaixo(ctx.mid));
    case 'fiado':
      return executarConsulta(ctx, chave, () => C.fiado(ctx.mid, ctx.tz, ctx.loja));
    case 'contas':
      return executarConsulta(ctx, chave, () => C.contas(ctx.mid, ctx.tz, {
        verContas: tem(ctx.pessoa, 'financeiro', 'financeiro_contas_pagar'),
        verFornecedores: tem(ctx.pessoa, 'fornecedores', 'financeiro', 'financeiro_contas_pagar'),
      }));
    default:
      if (C.PERIODOS[chave]) return executarConsulta(ctx, chave, () => C.vendas(ctx.mid, ctx.tz, chave));
      return enviarMenu(ctx);
  }
}

/* ── Entrada principal ──────────────────────────────────────── */
// ativos = vínculos confirmados deste número (pode ter mais de uma loja)
async function atender({ msg, de, variantes, ativos }) {
  const entrada = lerEntrada(msg);
  const conversa = await lerConversa(de);

  // Trava por minuto (por número): conta as mensagens recebidas
  const params = await carregarParametros();
  const umMinuto = new Date(Date.now() - 60000).toISOString();
  const { count: recentes } = await db.from('whatsapp_envios').select('id', { count: 'exact', head: true })
    .in('destino', variantes).eq('direcao', 'entrada').gte('criado_em', umMinuto);
  if ((recentes || 0) > params.travas.pedidos_por_minuto) {
    if (!(await respondeuRecente(variantes, 5 * MIN, 'limite_minuto'))) {
      await M.enviarTexto({ para: de, tipo: 'resposta', mercearia_id: ativos[0]?.mercearia_id || null, categoria: 'limite_minuto', texto: 'Muitas mensagens em pouco tempo. Espere um minutinho e tente de novo. 🙂' });
    }
    return;
  }

  // Qual loja?
  const cmdTexto = entrada.tipo === 'texto' ? interpretar(entrada.texto) : null;
  const querTrocar = (cmdTexto && cmdTexto.acao === 'trocar_loja') || (entrada.tipo === 'escolha' && entrada.id === 'c:trocar_loja');
  let v = null;
  if (entrada.tipo === 'escolha' && entrada.id.startsWith('loja:')) {
    v = ativos.find(a => a.mercearia_id === entrada.id.slice(5)) || null;
    if (v) await salvarConversa(de, { mercearia_id: v.mercearia_id, estado: null, dados: {}, expira_em: null });
  } else if (querTrocar && ativos.length > 1) {
    return pedirLoja(de, variantes, ativos);
  } else if (ativos.length === 1) {
    v = ativos[0];
  } else if (conversa.mercearia_id) {
    v = ativos.find(a => a.mercearia_id === conversa.mercearia_id) || null;
  }
  if (!v) return ativos.length > 1 ? pedirLoja(de, variantes, ativos) : undefined;

  const ctx = { de, variantes, mid: v.mercearia_id, vinculo: v, params, multiLoja: ativos.length > 1 };

  // Loja, pessoa e plano
  const { data: loja } = await db.from('mercearias')
    .select('id, nome_fantasia, timezone, status_assinatura, fiado_ativo').eq('id', ctx.mid).maybeSingle();
  if (!loja) return;
  ctx.loja = loja;
  ctx.tz = loja.timezone || TIMEZONE_PADRAO;

  ctx.pessoa = await carregarPessoa(v);
  if (!ctx.pessoa) {
    return avisoUnico(ctx, 'bloqueio_pessoa', 12, `Este número está ligado a um usuário que não está ativo em ${loja.nome_fantasia || 'na loja'}. Peça ao dono para conferir na tela *WhatsApp* do sistema.`);
  }
  if (loja.status_assinatura === 'bloqueada') {
    return avisoUnico(ctx, 'bloqueio_licenca', 12, `O acesso ao sistema de ${loja.nome_fantasia || 'sua loja'} está bloqueado (assinatura vencida). As consultas pelo WhatsApp voltam assim que a assinatura for renovada.`);
  }
  const { data: ass } = await db.from('whatsapp_assinaturas').select('*').eq('mercearia_id', ctx.mid).eq('status', 'ativa').maybeSingle();
  const assinatura = ass ? await A.garantirCiclo(db, ass, hojeStrTZ(ctx.tz)) : null;
  if (!assinatura || assinatura.status !== 'ativa') {
    return avisoUnico(ctx, 'sem_plano', 12, `${loja.nome_fantasia || 'Sua loja'} não tem um plano de WhatsApp ativo no momento. O dono pode contratar na tela *WhatsApp* do sistema.`);
  }
  if (!W.tiposDoPlano(assinatura.recursos).includes('consulta')) {
    return avisoUnico(ctx, 'sem_consultas', 12, `O plano de WhatsApp de ${loja.nome_fantasia || 'sua loja'} (${assinatura.plano_nome}) não inclui consultas. O dono pode trocar de plano na tela *WhatsApp* do sistema.`);
  }
  ctx.assinatura = assinatura;
  ctx.saldo = (await A.resumoCiclo(db, assinatura.id, assinatura.ciclo_inicio)).saldo;

  // Trava por dia (por loja): mensagens de consulta enviadas hoje
  const { count: hoje } = await db.from('whatsapp_envios').select('id', { count: 'exact', head: true })
    .eq('mercearia_id', ctx.mid).eq('direcao', 'saida').not('pedido_id', 'is', null)
    .gte('criado_em', inicioDiaTZ(hojeStrTZ(ctx.tz), ctx.tz).toISOString());
  if ((hoje || 0) >= params.travas.pedidos_por_dia) {
    return avisoUnico(ctx, 'limite_dia', 12, 'O limite de consultas por dia desta loja foi atingido. Tente de novo amanhã. 🙂');
  }

  // Teto de custo
  const teto = await verificarTeto(ctx);
  if (teto.pausado) {
    return avisoUnico(ctx, 'teto_pausado', 12, 'O assistente do WhatsApp desta loja foi pausado por uso fora do normal, para proteger o serviço (como está nos termos). Nossa equipe já foi avisada e vai verificar. Enquanto isso, use o sistema normalmente.');
  }

  // O que a pessoa quer?
  if (entrada.tipo === 'escolha') {
    const id = entrada.id;
    if (id.startsWith('loja:')) return enviarMenu(ctx);
    if (id.startsWith('c:')) return rodarConsulta(ctx, id.slice(2));
    if (id.startsWith('p:')) {
      const prodId = id.slice(2);
      if (!CONSULTAS.estoque_produto.pode(ctx.pessoa)) return rodarConsulta(ctx, 'estoque_produto');
      // Toque repetido no mesmo item da lista (até 2 min) → não reenvia nem cobra de novo
      const ult = conversa.dados.ultimo_produto;
      if (ult && ult.id === prodId && Date.now() - Date.parse(ult.em) < 120000) return;
      const continua = conversa.estado === 'escolher_produto' && (conversa.dados.opcoes || []).includes(prodId) ? conversa.dados.pedido_id : null;
      return executarConsulta(ctx, 'estoque_produto', async () => {
        const p = await C.produtoPorId(ctx.mid, prodId);
        if (!p) return { cobrar: false, texto: 'Esse produto não foi encontrado (pode ter sido excluído). Nenhum crédito foi usado.' };
        return C.textoProduto(ctx.mid, p);
      }, { pedidoId: continua, dadosDepois: { ultimo_produto: { id: prodId, em: new Date().toISOString() } } });
    }
    return enviarMenu(ctx);
  }
  if (entrada.tipo === 'outro') {
    return enviarMenu(ctx, 'Por enquanto eu entendo só mensagens de texto e as opções do menu (áudio e foto ainda não). 🙂');
  }

  const cmd = cmdTexto;
  if (cmd) {
    if (cmd.acao === 'menu' || cmd.acao === 'trocar_loja') return enviarMenu(ctx);
    if (cmd.acao === 'suporte') {
      const link = await linkSuporte();
      return avisoUnico(ctx, 'suporte', 1, link
        ? `Este WhatsApp é automático. Para falar com uma pessoa da nossa equipe, chame aqui: ${link}`
        : 'Este WhatsApp é automático. Para falar com a nossa equipe, use o "Fale Conosco" dentro do sistema.');
    }
    if (cmd.acao === 'consulta') return rodarConsulta(ctx, cmd.chave, cmd);
  }
  // Texto livre depois de "Qual produto?"
  if (conversa.estado === 'aguardando_produto' && conversa.mercearia_id === ctx.mid) {
    return rodarConsulta(ctx, 'estoque_produto', { termo: entrada.texto });
  }
  return enviarMenu(ctx, 'Não entendi. 🙂 Escolha uma opção:');
}

async function carregarParametros() {
  return M.parametros();
}

module.exports = { atender, estornarPedido, interpretar, lerEntrada, CONSULTAS, verificarTeto, custoDoCiclo };
