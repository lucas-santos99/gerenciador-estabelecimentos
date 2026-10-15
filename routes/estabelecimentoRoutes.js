const express = require('express');
const db = require('../db/supabaseAdmin');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const { listarHistoricoLicenca } = require('../utils/historicoLicenca');
const { registrar } = require('./auditoriaRoutes');
const { verificarPermissao, temPermissao } = require('../middlewares/verificarPermissao');
const { negarSeEmContagem } = require('../utils/inventarioTrava');
const { PERMISSOES } = require('../utils/permissoes');
const { TIMEZONE_PADRAO, hojeStrTZ } = require('../utils/fusoHorario');
const { contemPalavraProibida } = require('../utils/filtroPalavroes');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');
const rotulosVariacao = require('../utils/rotulosVariacao');
const { erroTeto, erroTetoDoBanco } = require('../utils/tetoCadastros');
const { carimboCriacao, carimboAlteracao } = require('../utils/rastro');
const AV = require('../utils/atributosVariacao');
const { limitarFrequencia } = require('../utils/limiteFrequencia');

// Valida o tamanho dos campos de texto livre de cada variação enviada
// (tamanho/cor/gênero/código de barras) antes de gravar no banco — mesma
// defesa aplicada aos campos do produto "pai".
function erroTamanhoVariacoes(variacoesEnviadas = []) {
  if (variacoesEnviadas.length > AV.TETOS_ATRIBUTOS.VARIACOES_PRODUTO) return `Variações demais neste produto (máximo ${AV.TETOS_ATRIBUTOS.VARIACOES_PRODUTO}).`;
  for (const v of variacoesEnviadas) {
    const erro = validarTamanhos(
      { tamanho: v.tamanho, cor: v.cor, genero: v.genero, codigo_barras: v.codigo_barras },
      { tamanho: LIMITES.VARIACAO, cor: LIMITES.VARIACAO, genero: LIMITES.VARIACAO, codigo_barras: LIMITES.CODIGO }
    );
    if (erro) return erro;
  }
  return null;
}

// ── Códigos de barras e variações sem repetição (23/09/2026) ─────────
// Dentro de UM estabelecimento, cada código de barras aponta pra um único
// produto ou variação — senão o PDV não sabe o que vender ao bipar. Entre
// estabelecimentos diferentes o mesmo número pode existir (cada loja só
// enxerga os próprios produtos e o código interno nunca vai pro catálogo
// global), então a checagem é sempre por loja.
// A variação é identificada pela COMBINAÇÃO de todos os atributos preenchidos
// (tamanho, cor, gênero e os extras da loja).
function chaveVariacao(v) {
  const legados = ['tamanho', 'cor', 'genero'].map(k => String(v?.[k] || '').trim().toLowerCase());
  const extras = AV.extrasDaVariacao(v);
  return [...legados, ...Object.keys(extras).map(k => `${k}=${extras[k].toLowerCase()}`)].join('|');
}
function variacaoVazia(v) {
  return ['tamanho', 'cor', 'genero'].every(k => !String(v?.[k] || '').trim()) && Object.keys(AV.extrasDaVariacao(v)).length === 0;
}
function rotuloVariacao(v) {
  const legados = ['tamanho', 'cor', 'genero'].map(k => String(v?.[k] || '').trim());
  return [...legados, ...Object.values(AV.extrasDaVariacao(v))].filter(Boolean).join(' · ') || 'sem nome';
}

// Consulta que pede a coluna `atributos`; se ela ainda não existir (42703), repete sem ela.
async function consultarComAtributos(montar) {
  let r = await montar(true);
  if (r.error && r.error.code === '42703') r = await montar(false);
  return r;
}

// Acrescenta `rotulo` (valores na ordem dos atributos da loja) em cada variação dos produtos.
// Se não conseguir ler os atributos da loja, usa a ordem padrão (tamanho · cor · gênero · extras).
async function anexarRotulos(estabelecimentoId, produtos) {
  let atributos = [];
  try { atributos = (await carregarAtributosLoja(estabelecimentoId)).atributos; }
  catch (e) { console.error('[ERRO] atributos da loja (rótulos das variações):', e.message); }
  for (const p of produtos || []) {
    if (!Array.isArray(p?.variacoes)) continue;
    p.variacoes = p.variacoes.map(v => ({ ...v, rotulo: AV.rotuloDaVariacao(v, atributos) }));
  }
  return produtos;
}

// Confere os atributos EXTRAS enviados nas variações: só atributos que a loja conhece,
// valores curtos, JSON pequeno e no máximo N atributos diferentes por produto.
// Só consulta o banco quando alguma variação traz atributo extra.
async function erroAtributosVariacoes(mercearia_id, variacoes) {
  const lista = Array.isArray(variacoes) ? variacoes : [];
  let temExtra = false;
  for (const v of lista) {
    if (v && v.atributos !== undefined && v.atributos !== null) {
      if (typeof v.atributos !== 'object' || Array.isArray(v.atributos)) return 'Atributos da variação em formato inválido.';
      if (Object.keys(v.atributos).length) temExtra = true;
    }
  }
  if (temExtra) {
    let conhecidos;
    try {
      const r = await carregarAtributosLoja(mercearia_id);
      conhecidos = new Set(r.atributos.map(a => a.chave));
    } catch (e) {
      console.error('[ERRO] atributos da loja (validação de variações):', e.message);
      return 'Não foi possível conferir os atributos agora. Tente de novo.';
    }
    for (const v of lista) {
      for (const [k, bruto] of Object.entries(v?.atributos || {})) {
        if (!AV.chaveValida(k) || AV.ehLegado(k)) return 'Atributo inválido na variação.';
        if (typeof bruto !== 'string' && typeof bruto !== 'number' && bruto !== null && bruto !== '') return 'Valor de atributo inválido na variação.';
        if (!conhecidos.has(k)) return 'Há um atributo que não existe mais na loja. Reabra o produto e tente de novo.';
        if (String(bruto ?? '').trim().length > LIMITES.VARIACAO) return `Cada valor de atributo pode ter no máximo ${LIMITES.VARIACAO} caracteres.`;
      }
      if (Buffer.byteLength(JSON.stringify(AV.extrasDaVariacao(v)), 'utf8') > AV.TETOS_ATRIBUTOS.JSON_BYTES) {
        return 'Os atributos de uma variação ficaram grandes demais.';
      }
    }
  }
  const usadas = AV.chavesUsadas(lista);
  if (usadas.size > AV.TETOS_ATRIBUTOS.ATRIBUTOS_PRODUTO) {
    return `Este produto usa ${usadas.size} atributos nas variações, mas o máximo é ${AV.TETOS_ATRIBUTOS.ATRIBUTOS_PRODUTO}. Deixe em branco algum atributo que não precisa.`;
  }
  return null;
}

async function erroCodigosEVariacoes(mercearia_id, produtoIdAtual, codigo_barras, tem_variacoes, variacoes) {
  const temVar = (tem_variacoes === true || tem_variacoes === 'true') && Array.isArray(variacoes);
  const lista = temVar ? variacoes : [];

  // Variações repetidas (mesmo tamanho + cor + gênero) no mesmo produto
  const vistas = new Map();
  for (const v of lista) {
    const k = chaveVariacao(v);
    if (variacaoVazia(v)) continue; // variação vazia já é barrada pelo formulário
    if (vistas.has(k)) return `Há duas variações iguais (${rotuloVariacao(v)}). Mude algum atributo de uma delas.`;
    vistas.set(k, true);
  }
  // Códigos repetidos dentro do próprio formulário
  const codigos = [];
  const cProd = String(codigo_barras || '').trim();
  if (cProd) codigos.push({ codigo: cProd, onde: 'o produto' });
  lista.forEach(v => {
    const c = String(v.codigo_barras || '').trim();
    if (c) codigos.push({ codigo: c, onde: `a variação ${rotuloVariacao(v)}` });
  });
  const usados = new Map();
  for (const c of codigos) {
    if (usados.has(c.codigo)) return `O código de barras ${c.codigo} está repetido (${usados.get(c.codigo)} e ${c.onde}). Cada um precisa de um código diferente.`;
    usados.set(c.codigo, c.onde);
  }
  if (codigos.length === 0) return null;

  // Códigos já usados por OUTRO produto/variação desta loja
  const valores = codigos.map(c => c.codigo);
  let qProd = db.from('produtos').select('id, nome, codigo_barras').eq('mercearia_id', mercearia_id).in('codigo_barras', valores).limit(1);
  if (produtoIdAtual) qProd = qProd.neq('id', produtoIdAtual);
  const { data: emProduto } = await qProd;
  if (emProduto && emProduto.length) {
    return `O código de barras ${emProduto[0].codigo_barras} já está cadastrado no produto "${emProduto[0].nome}".`;
  }
  const { data: emVariacao } = await consultarComAtributos((comAtr) => {
    let qVar = db.from('produto_variacoes').select(`codigo_barras, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}produtos!inner(nome)`)
      .eq('mercearia_id', mercearia_id).eq('ativo', true).in('codigo_barras', valores).limit(1);
    if (produtoIdAtual) qVar = qVar.neq('produto_id', produtoIdAtual);
    return qVar;
  });
  if (emVariacao && emVariacao.length) {
    const v = emVariacao[0];
    return `O código de barras ${v.codigo_barras} já está cadastrado na variação ${rotuloVariacao(v)} do produto "${v.produtos?.nome || ''}".`;
  }
  return null;
}

// Sincroniza a lista de variações (tamanho/cor) de um produto com o que
// veio do formulário — cria as novas, atualiza as existentes, e remove
// (ou só desativa, se já apareceu numa venda) as que sumiram da lista.
// Toda mudança de estoque fica no histórico (Inventário → Movimentações),
// com motivo e quem fez — inclusive o estoque inicial de um produto novo e
// o estoque das variações. `ctx` = { req, produto: { id, nome, marca,
// unidade_medida }, categoria_nome }.
async function registrarMovimentacaoEstoque(ctx, { tipo, antes, depois, motivo, referencia_tipo, variacaoId = null }) {
  try {
    const { req, produto } = ctx;
    const { error } = await db.from('movimentacoes_estoque').insert({
      mercearia_id:            req.user.mercearia_id,
      produto_id:              produto.id,
      produto_nome:            produto.nome,
      produto_marca:           produto.marca || null,
      unidade_medida:          produto.unidade_medida || 'un',
      tipo,
      quantidade_anterior:     antes,
      quantidade_movimentacao: Math.abs(depois - antes),
      quantidade_posterior:    depois,
      motivo,
      referencia_tipo,
      categoria_nome:          ctx.categoria_nome || null,
      operador_id:             req.user.role === 'operator' ? req.user.id : null,
      usuario_nome:            req.user.nome || req.user.email,
      produto_variacao_id:     variacaoId,
    });
    if (error) console.error('[ESTOQUE] movimentação não registrada:', error.message);
  } catch (e) {
    console.error('[ESTOQUE] movimentação não registrada:', e.message);
  }
}

// Variações já existentes cujo estoque veio diferente do que está gravado.
async function variacoesComEstoqueAlterado(produtoId, variacoesEnviadas = []) {
  const comId = (variacoesEnviadas || []).filter(v => v && v.id);
  if (comId.length === 0) return [];
  const { data: atuais } = await db
    .from('produto_variacoes')
    .select('id, estoque_atual, tamanho, cor, genero')
    .eq('produto_id', produtoId)
    .eq('ativo', true);
  const porId = new Map((atuais || []).map(v => [v.id, v]));
  return comId.filter(v => {
    const atual = porId.get(v.id);
    return atual && Math.abs((parseFloat(v.estoque_atual) || 0) - (parseFloat(atual.estoque_atual) || 0)) > 0.0005;
  });
}

// Grava (id = atualiza, sem id = cria) uma variação. Se a coluna `atributos` ainda não existir
// no banco (42703), repete sem ela — as colunas tamanho/cor/gênero continuam funcionando.
async function gravarVariacao(payload, id) {
  const executar = (p) => (id
    ? db.from('produto_variacoes').update(p).eq('id', id).select().single()
    : db.from('produto_variacoes').insert(p).select().single());
  let r = await executar(payload);
  if (r.error && r.error.code === '42703') {
    const { atributos, ...semAtributos } = payload; // eslint-disable-line no-unused-vars
    r = await executar(semAtributos);
  }
  return r;
}

async function sincronizarVariacoes(produtoId, mercearia_id, variacoesEnviadas = [], ctx = null) {
  const { data: existentes } = await db
    .from('produto_variacoes')
    .select('id, estoque_atual')
    .eq('produto_id', produtoId)
    .eq('ativo', true);

  const idsExistentes = new Set((existentes || []).map(v => v.id));
  const estoqueAntes = new Map((existentes || []).map(v => [v.id, parseFloat(v.estoque_atual) || 0]));
  const idsEnviados = new Set(variacoesEnviadas.filter(v => v.id).map(v => v.id));

  // Removeu da lista — apaga de vez, a não ser que já tenha sido vendida
  // alguma vez (nesse caso, só desativa, pra manter o histórico íntegro)
  for (const idExistente of idsExistentes) {
    if (idsEnviados.has(idExistente)) continue;
    const { count } = await db
      .from('itens_venda')
      .select('id', { count: 'exact', head: true })
      .eq('produto_variacao_id', idExistente);
    if (count > 0) {
      await db.from('produto_variacoes').update({ ativo: false }).eq('id', idExistente);
    } else {
      await db.from('produto_variacoes').delete().eq('id', idExistente);
    }
  }

  // Cria as novas, atualiza as que já existiam — e guarda o resultado (com
  // o id real de cada linha) pra devolver pra quem chamou, já que produtos
  // recém-criados/variações recém-criadas só ganham um id depois desse passo.
  const resultado = [];
  for (const v of variacoesEnviadas) {
    const payload = {
      produto_id:     produtoId,
      mercearia_id,
      tamanho:        v.tamanho?.trim() || null,
      cor:            v.cor?.trim() || null,
      genero:         v.genero?.trim() || null,
      atributos:      AV.extrasDaVariacao(v),
      codigo_barras:  v.codigo_barras?.trim() || null,
      preco_custo:    v.preco_custo !== '' && v.preco_custo != null ? parseFloat(v.preco_custo) : null,
      preco_venda:    v.preco_venda !== '' && v.preco_venda != null ? parseFloat(v.preco_venda) : null,
      estoque_atual:  parseFloat(v.estoque_atual) || 0,
      estoque_minimo: v.estoque_minimo !== '' && v.estoque_minimo != null ? parseFloat(v.estoque_minimo) : null,
      imagem_url:     v.imagem_url?.trim() || null,
      imagem_origem:  v.imagem_url?.trim() ? (v.imagem_origem?.trim() || null) : null,
      ativo: true,
    };
    if (v.id && idsExistentes.has(v.id)) {
      const { data: linha, error: errUpd } = await gravarVariacao(payload, v.id);
      if (errUpd) console.error(`[ERRO] variação ${v.id} (produto ${produtoId}) não atualizada:`, errUpd.message);
      if (linha) resultado.push(linha);
      // Estoque de variação alterado no cadastro → fica no histórico, com o motivo informado
      const antes = estoqueAntes.get(v.id) || 0;
      if (linha && ctx && Math.abs(payload.estoque_atual - antes) > 0.0005) {
        await registrarMovimentacaoEstoque(ctx, {
          tipo: 'correcao', antes, depois: payload.estoque_atual,
          motivo: `Variação ${rotuloVariacao(payload)}: ${ctx.motivo || 'estoque alterado no cadastro do produto'}`,
          referencia_tipo: 'cadastro_produto', variacaoId: v.id,
        });
      }
    } else {
      const { data: linha, error: errIns } = await gravarVariacao(payload, null);
      if (errIns) console.error(`[ERRO] variação nova (produto ${produtoId}) não criada:`, errIns.message);
      if (linha) resultado.push(linha);
      // Variação nova que já nasce com estoque → entrada de estoque inicial
      if (linha && ctx && payload.estoque_atual > 0) {
        await registrarMovimentacaoEstoque(ctx, {
          tipo: 'entrada', antes: 0, depois: payload.estoque_atual,
          motivo: `Estoque inicial — cadastro da variação ${rotuloVariacao(payload)}`,
          referencia_tipo: 'cadastro_produto', variacaoId: linha.id,
        });
      }
    }
  }

  // Salva valores novos digitados como sugestão pra próxima vez (só se
  // ainda não existir esse valor pra esse tipo, nesse estabelecimento)
  const novosPresets = [];
  variacoesEnviadas.forEach(v => {
    if (v.tamanho?.trim()) novosPresets.push({ tipo: 'tamanho', valor: v.tamanho.trim() });
    if (v.cor?.trim())     novosPresets.push({ tipo: 'cor',     valor: v.cor.trim() });
    if (v.genero?.trim())  novosPresets.push({ tipo: 'genero',  valor: v.genero.trim() });
    for (const [k, val] of Object.entries(AV.extrasDaVariacao(v))) novosPresets.push({ tipo: k, valor: val });
  });
  for (const p of novosPresets) {
    await db.from('opcoes_variacao')
      .upsert({ mercearia_id, tipo: p.tipo, valor: p.valor }, { onConflict: 'mercearia_id,tipo,valor', ignoreDuplicates: true });
  }

  return resultado;
}

// Preço de venda "geral" do produto é obrigatório — EXCETO quando o produto
// tem variações e cada uma delas já veio com o próprio preço de venda
// preenchido, caso em que o preço geral nunca seria usado mesmo (o PDV só
// recorre a ele pra variação que não tiver preço próprio). Se sobrar
// qualquer variação sem preço, o geral volta a ser exigido, como rede de
// segurança pra nunca deixar algo à venda sem um preço válido.
function precoVendaEhValido(preco_venda, tem_variacoes, variacoes) {
  const temPrecoGeral = preco_venda !== undefined && preco_venda !== null && preco_venda !== '' && parseFloat(preco_venda) > 0;
  if (temPrecoGeral) return true;

  const temVariacoes = tem_variacoes === true || tem_variacoes === 'true';
  const lista = temVariacoes && Array.isArray(variacoes) ? variacoes : [];
  if (lista.length === 0) return false;

  return lista.every(v =>
    v.preco_venda !== undefined && v.preco_venda !== null && v.preco_venda !== '' && parseFloat(v.preco_venda) > 0
  );
}

router.use(authUser);

// ── Isolamento entre estabelecimentos (22/09/2026) ─────────────────
// Várias rotas deste arquivo usam o `:id` da URL como estabelecimento
// (produtos, variações, imagens, busca, código interno...) e, antes, não
// conferiam se esse id era o do usuário logado — trocando o id na URL,
// um usuário de uma loja lia/alterava produtos de outra. Agora qualquer
// rota com `:id` só passa se o id for o do próprio estabelecimento de
// quem está logado. O frontend só chama essas rotas a partir do painel
// do comerciante/operador (rota /estabelecimentos/:id, liberada só pra
// merchant/operator), sempre com o próprio id — nenhum fluxo legítimo
// é afetado. Personificação também passa: o master vira o usuário-alvo.
router.param('id', (req, res, next, id) => {
  if (req.user?.mercearia_id && String(id) === String(req.user.mercearia_id)) return next();
  return res.status(403).json({ error: 'Acesso negado a este estabelecimento.' });
});

// Histórico de renovações da assinatura — só o dono da loja vê (operador não).
// Sem motivo interno nem quem liberou; pagamentos pendentes não aparecem.
router.get('/:id/assinatura/historico', async (req, res) => {
  if (req.user.role === 'operator') return res.status(403).json({ error: 'Só o dono da loja vê o histórico da assinatura.' });
  try {
    res.json(await listarHistoricoLicenca(req.params.id, { completo: false }));
  } catch (e) {
    console.error('[ERRO] Histórico da assinatura:', e.message);
    res.status(500).json({ error: 'Erro ao carregar o histórico da assinatura.' });
  }
});

/* Estoque mínimo é OPCIONAL: vazio, ausente, 0, negativo ou inválido
   viram 0, que significa "sem estoque mínimo" (sem alerta de estoque
   baixo). A coluna produtos.estoque_minimo é NOT NULL — nunca gravar null. */
function normalizarEstoqueMinimo(valor) {
  const n = parseFloat(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* Texto do estoque mínimo pra auditoria: 0 → "sem mínimo" */
function fmtEstoqueMinimo(valor, unidade) {
  const n = normalizarEstoqueMinimo(valor);
  return n > 0 ? fmtEstoque(n, unidade) : 'sem mínimo';
}

/* Formata estoque no padrão brasileiro com unidade */
function fmtEstoque(valor, unidade) {
  const v = parseFloat(valor) || 0;
  const u = unidade || 'un';
  if (u === 'kg') {
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' kg';
  }
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' un';
}


// --- Rota GET: /:id/produtos/buscar-global ---
router.get('/:id/produtos/buscar-global', async (req, res) => {
    const { id: estabelecimentoId } = req.params;
    const { termo } = req.query;

    if (!estabelecimentoId || !termo) {
        return res.status(400).json({ error: 'ID do estabelecimento e termo de busca são obrigatórios.' });
    }

    try {
        const { data, error } = await db.rpc('buscar_produtos_sem_acento', {
            p_mercearia_id: estabelecimentoId,
            p_termo: termo
        });

        if (error) throw error;
        await anexarRotulos(estabelecimentoId, data);

        // Fallback: se não achou por nome/código de barras, tenta por PLU
        // da balança — permite digitar o PLU manualmente no PDV quando a
        // balança está fora do ar, puxando o produto igual ao código de barras.
        // PLU costuma ter zeros à esquerda (ex: "0018"), então comparamos
        // o valor numérico, não a string exata — "18", "018" e "0018" batem
        // com o mesmo produto.
        if ((!data || data.length === 0) && /^\d+$/.test(termo.trim())) {
            const termoNum = parseInt(termo.trim(), 10);

            const { data: candidatos, error: errPlu } = await consultarComAtributos((comAtr) => db
                .from('produtos')
                .select(`
                    id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                    vendido_por_peso, plu_balanca, codigo_barras, categoria_id, tem_variacoes, imagem_url,
                    produto_variacoes ( id, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
                `)
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500));

            if (errPlu) {
                console.error(`[ERRO] fallback PLU busca-global:`, errPlu.message);
            } else {
                const porPlu = (candidatos || [])
                    .filter(p => {
                        const pluNum = parseInt(String(p.plu_balanca).trim(), 10);
                        return !isNaN(pluNum) && pluNum === termoNum;
                    })
                    .map(p => ({
                        ...p,
                        variacoes: (p.produto_variacoes || []).filter(v => v.ativo),
                    }));
                if (porPlu.length > 0) { await anexarRotulos(estabelecimentoId, porPlu); return res.status(200).json(porPlu); }
            }
        }

        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] GET /api/estabelecimentos/${estabelecimentoId}/produtos/buscar-global:`, error.message);
        return res.status(500).json({ error: 'Erro ao buscar produto (global).' });
    }
});


// --- Rota GET: /:id/produtos/por-ids?ids=a,b,c ---
// Tempo real (22/09/2026): quando chega um aviso de que produtos mudaram,
// o PDV usa isso pra reler SÓ os produtos que estão no carrinho / na
// lista de resultados (preço e estoque atuais), sem baixar o catálogo
// inteiro. Mesmos campos da busca do PDV. Declarada antes de qualquer
// rota /:id/produtos/:produtoId (convenção: específicas antes de params).
router.get('/:id/produtos/por-ids', async (req, res) => {
    const estabelecimentoId = req.params.id;
    const ids = String(req.query.ids || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => /^[0-9a-f-]{36}$/i.test(s))
        .slice(0, 200);

    if (ids.length === 0) return res.status(200).json([]);

    try {
        const { data, error } = await consultarComAtributos((comAtr) => db
            .from('produtos')
            .select(`
                id, nome, preco_venda, estoque_atual, estoque_minimo, unidade_medida, tem_variacoes,
                produto_variacoes ( id, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}preco_venda, estoque_atual, ativo )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .in('id', ids));

        if (error) throw error;

        const lista = (data || []).map(p => ({
            ...p,
            variacoes: (p.produto_variacoes || []).filter(v => v.ativo),
            produto_variacoes: undefined,
        }));
        await anexarRotulos(estabelecimentoId, lista);
        res.status(200).json(lista);
    } catch (error) {
        console.error(`[ERRO] GET /api/estabelecimentos/${estabelecimentoId}/produtos/por-ids:`, error.message);
        return res.status(500).json({ error: 'Erro ao buscar produtos.' });
    }
});


// --- Rota GET: /status/:userId ---
router.get('/status/:userId', async (req, res) => {

    const { userId } = req.params;

    // 🔒 22/09/2026: só a própria loja (ou SuperAdmin) — antes devolvia
    // status/vencimento de qualquer estabelecimento pelo id.
    if (req.user.role !== 'super_admin' && String(req.user.mercearia_id) !== String(userId)) {
        return res.status(403).json({ error: 'Acesso negado a este estabelecimento.' });
    }

    if (!userId) {
        return res.status(400).json({ error: 'ID do usuário é obrigatório.' });
    }

    try {

        const { data: mercearia, error } = await db
            .from('mercearias')
            .select('id, nome_fantasia, status_assinatura, data_vencimento, logo_url, timezone')
            .eq('id', userId)
            .single();

        if (error || !mercearia) {
            return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
        }

        let statusFinal = mercearia.status_assinatura;

        // Compara como DATA ('YYYY-MM-DD'), no fuso do próprio
        // estabelecimento — antes usava `new Date(mercearia.data_vencimento)`,
        // que o JS interpreta como meia-noite EM UTC. Isso bloqueava o
        // acesso até 3h (ou mais, fora de Brasília) ANTES da hora certa,
        // já na noite anterior ao vencimento de verdade. Mesmo bug já
        // corrigido em adminEstabelecimentosRoutes.js (verificarVencimentos),
        // essa é uma implementação separada que tinha o mesmo problema.
        const hojeEstabelecimento = hojeStrTZ(mercearia.timezone || TIMEZONE_PADRAO);
        const venceu = mercearia.data_vencimento && mercearia.data_vencimento < hojeEstabelecimento;

        if (venceu && mercearia.status_assinatura === 'ativa') {

            console.log(`[AVISO] Assinatura expirada para ${mercearia.nome_fantasia}. Atualizando para 'bloqueada'.`);

            await db
                .from('mercearias')
                .update({ status_assinatura: 'bloqueada' })
                .eq('id', userId);

            statusFinal = 'bloqueada';
        }

        res.status(200).json({
            status: statusFinal,
            nome:              mercearia.nome_fantasia,
            logo_url:          mercearia.logo_url,
            status_assinatura: statusFinal,
            data_vencimento:   mercearia.data_vencimento || null,
        });

    } catch (error) {

        console.error(`[ERRO] GET /api/estabelecimentos/status/${userId}:`, error.message);
        return res.status(500).json({ error: 'Erro ao verificar status da assinatura.' });

    }
});


// --- Rota GET /:id/produtos ---
// --- Rota GET: /:id/produtos/marcas — marcas já cadastradas nesse
// estabelecimento (pra sugerir no cadastro e evitar duplicar a mesma
// marca escrita de formas diferentes) ---
router.get('/:id/produtos/marcas', async (req, res) => {
    const estabelecimentoId = req.params.id;
    try {
        const { data, error } = await db
            .from('produtos')
            .select('marca')
            .eq('mercearia_id', estabelecimentoId)
            .not('marca', 'is', null);

        if (error) throw error;

        const marcas = [...new Set((data || []).map(p => (p.marca || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'pt-BR'));

        res.status(200).json(marcas);
    } catch (error) {
        console.error(`[ERRO] GET /:id/produtos/marcas:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar marcas.' });
    }
});

// --- Rota GET: /:id/produtos/:produtoId/movimentacoes — "de onde veio
// este estoque" (05/10/2026). Junta, do mais novo pro mais antigo:
//   • movimentacoes_estoque do produto (compra de fornecedor, ajuste com
//     motivo, inventário, estoque inicial do cadastro, estorno de compra);
//   • as vendas recentes (itens_venda) — venda não gera linha em
//     movimentacoes_estoque, então entra aqui pra história ficar completa.
// Só leitura. Quem enxerga o Estoque (ou o Inventário) pode ver.
router.get('/:id/produtos/:produtoId/movimentacoes', verificarPermissao(PERMISSOES.ESTOQUE, PERMISSOES.INVENTARIO, { mensagem: 'Sem permissão para ver o histórico de estoque.' }), async (req, res) => {
    const mid = req.user.mercearia_id || req.params.id;
    const { produtoId } = req.params;
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), 100);

    const ORIGENS = {
        compra_fornecedor:   'compra',
        cancelamento_compra: 'compra_cancelada',
        inventario:          'inventario',
        cadastro_produto:    'cadastro',
        ajuste_manual:       'ajuste',
        entrada_fornecedor:  'entrada_fornecedor',
    };

    try {
        const { data: movs, error: errMovs } = await db
            .from('movimentacoes_estoque')
            .select('id, tipo, quantidade_anterior, quantidade_movimentacao, quantidade_posterior, motivo, referencia_tipo, usuario_nome, created_at')
            .eq('mercearia_id', mid)
            .eq('produto_id', produtoId)
            .order('created_at', { ascending: false })
            .limit(limite);
        if (errMovs) throw errMovs;

        const itens = (movs || []).map(m => {
            const antes  = parseFloat(m.quantidade_anterior)  || 0;
            const depois = parseFloat(m.quantidade_posterior) || 0;
            return {
                id:         `m:${m.id}`,
                quando:     m.created_at,
                origem:     ORIGENS[m.referencia_tipo] || (m.tipo === 'inventario_ajuste' ? 'inventario' : 'ajuste'),
                tipo:       m.tipo,
                detalhe:    m.motivo || null,
                quem:       m.usuario_nome || null,
                quantidade: Math.round((depois - antes) * 1000) / 1000,
                antes,
                depois,
            };
        });

        // Vendas: se a consulta falhar, o histórico segue só com as
        // movimentações e a tela avisa (vendas_indisponiveis).
        let vendasIndisponiveis = false;
        const { data: vendidos, error: errVendas } = await db
            .from('itens_venda')
            .select('id, quantidade, vendas!inner ( id, data_venda, mercearia_id, cancelada_em )')
            .eq('produto_id', produtoId)
            .eq('vendas.mercearia_id', mid)
            .order('vendas(data_venda)', { ascending: false })
            .limit(limite);

        if (errVendas) {
            vendasIndisponiveis = true;
            console.error('[ESTOQUE] histórico do produto — vendas não carregadas:', errVendas.message);
        } else {
            (vendidos || []).forEach(v => {
                const venda = v.vendas || {};
                const cancelada = !!venda.cancelada_em;
                itens.push({
                    id:         `v:${v.id}`,
                    quando:     venda.data_venda || null,
                    origem:     cancelada ? 'venda_cancelada' : 'venda',
                    tipo:       'venda',
                    detalhe:    cancelada ? 'Venda cancelada — o produto voltou para o estoque' : 'Venda no caixa',
                    quem:       null,
                    quantidade: cancelada ? 0 : -(parseFloat(v.quantidade) || 0),
                    antes:      null,
                    depois:     null,
                });
            });
        }

        itens.sort((a, b) => String(b.quando || '').localeCompare(String(a.quando || '')));

        res.status(200).json({ itens: itens.slice(0, limite), vendas_indisponiveis: vendasIndisponiveis });
    } catch (error) {
        console.error('[ERRO] GET /:id/produtos/:produtoId/movimentacoes:', error.message);
        res.status(500).json({ error: 'Erro ao buscar o histórico de estoque.' });
    }
});

// --- Rota GET: /:id/produtos/:produtoId/origem-estoque — apoio à
// "Entrada" do Ajustar estoque (05/10/2026): devolve a ÚLTIMA COMPRA
// deste produto lançada em Fornecedores (fornecedor, data e hora, nota,
// quantidade, custo) e a lista de fornecedores ativos da loja (só id e
// nome), pra tela já vir com o fornecedor preenchido. Só leitura; quem
// enxerga o Estoque ou o Inventário pode ver.
router.get('/:id/produtos/:produtoId/origem-estoque', verificarPermissao(PERMISSOES.ESTOQUE, PERMISSOES.INVENTARIO, { mensagem: 'Sem permissão para ver a origem do estoque.' }), async (req, res) => {
    const mid = req.user.mercearia_id || req.params.id;
    const { produtoId } = req.params;
    try {
        const { data: fornecedores, error: errForn } = await db
            .from('fornecedores')
            .select('id, nome')
            .eq('mercearia_id', mid)
            .eq('ativo', true)
            .order('nome');
        if (errForn) throw errForn;

        // Últimas entradas por compra deste produto (a mais nova primeiro).
        // Compra cancelada não conta: procura a mais recente ainda ativa.
        const { data: movs, error: errMovs } = await db
            .from('movimentacoes_estoque')
            .select('compra_id, quantidade_movimentacao, created_at')
            .eq('mercearia_id', mid)
            .eq('produto_id', produtoId)
            .eq('referencia_tipo', 'compra_fornecedor')
            .order('created_at', { ascending: false })
            .limit(8);
        if (errMovs) throw errMovs;

        let ultimaCompra = null;
        const idsCompra = [...new Set((movs || []).map(m => m.compra_id).filter(Boolean))];
        if (idsCompra.length > 0) {
            const { data: compras, error: errCompras } = await db
                .from('compras')
                .select('id, fornecedor_id, numero_nota, status, usuario_nome, criado_em, fornecedores(nome)')
                .eq('mercearia_id', mid)
                .in('id', idsCompra);
            if (errCompras) throw errCompras;
            const porId = new Map((compras || []).map(c => [c.id, c]));

            const mov = (movs || []).find(m => porId.get(m.compra_id) && porId.get(m.compra_id).status !== 'cancelada');
            if (mov) {
                const compra = porId.get(mov.compra_id);
                const { data: item } = await db
                    .from('itens_compra')
                    .select('quantidade, preco_custo_unitario')
                    .eq('compra_id', compra.id)
                    .eq('produto_id', produtoId)
                    .limit(1)
                    .maybeSingle();
                ultimaCompra = {
                    compra_id:       compra.id,
                    fornecedor_id:   compra.fornecedor_id || null,
                    fornecedor_nome: compra.fornecedores?.nome || null,
                    quando:          mov.created_at || compra.criado_em || null,
                    numero_nota:     compra.numero_nota || null,
                    quantidade:      parseFloat(item?.quantidade ?? mov.quantidade_movimentacao) || 0,
                    preco_custo:     item?.preco_custo_unitario != null ? parseFloat(item.preco_custo_unitario) : null,
                    lancado_por:     compra.usuario_nome || null,
                };
            }
        }

        // Última ENTRADA de estoque, de qualquer origem (compra lançada em
        // Fornecedores, entrada com fornecedor, entrada manual com motivo ou
        // estoque inicial do cadastro). Serve pra tela mostrar que a entrada
        // que acabou de ser feita gravou, já que "ultima_compra" só enxerga
        // compras lançadas em Fornecedores. Falha aqui não derruba a rota.
        let ultimaEntrada = null;
        try {
            const { data: entradas, error: errEnt } = await db
                .from('movimentacoes_estoque')
                .select('quantidade_movimentacao, motivo, referencia_tipo, referencia_id, usuario_nome, created_at')
                .eq('mercearia_id', mid)
                .eq('produto_id', produtoId)
                .eq('tipo', 'entrada')
                .order('created_at', { ascending: false })
                .limit(1);
            if (errEnt) throw errEnt;
            const ent = (entradas || [])[0];
            if (ent) {
                const forn = ent.referencia_tipo === 'entrada_fornecedor'
                    ? (fornecedores || []).find(f => f.id === ent.referencia_id)
                    : null;
                ultimaEntrada = {
                    quando:          ent.created_at || null,
                    quantidade:      Math.abs(parseFloat(ent.quantidade_movimentacao) || 0),
                    origem:          ({ compra_fornecedor: 'compra', entrada_fornecedor: 'entrada_fornecedor', cadastro_produto: 'cadastro' })[ent.referencia_tipo] || 'ajuste',
                    fornecedor_nome: forn ? forn.nome : null,
                    detalhe:         ent.motivo || null,
                    quem:            ent.usuario_nome || null,
                };
            }
        } catch (errEntrada) {
            console.error('[ESTOQUE] origem-estoque — última entrada não carregada:', errEntrada.message);
        }

        res.status(200).json({ ultima_compra: ultimaCompra, ultima_entrada: ultimaEntrada, fornecedores: fornecedores || [] });
    } catch (error) {
        console.error('[ERRO] GET /:id/produtos/:produtoId/origem-estoque:', error.message);
        res.status(500).json({ error: 'Erro ao buscar a origem do estoque.' });
    }
});

// --- Rota GET: /:id/opcoes-variacao?tipo=tamanho|cor|genero — valores já
// cadastrados nesse estabelecimento, pra alimentar o autocomplete do
// tamanho/cor/gênero na hora de criar uma variação. Sem ?tipo, devolve os três. ---
router.get('/:id/opcoes-variacao', async (req, res) => {
    const estabelecimentoId = req.params.id;
    const { tipo, comId } = req.query;
    try {
        let query = db
            .from('opcoes_variacao')
            .select('id, tipo, valor')
            .eq('mercearia_id', estabelecimentoId)
            .order('ordem')
            .order('valor');
        if (tipo) query = query.eq('tipo', tipo);

        const { data, error } = await query;
        if (error) throw error;

        if (tipo && !comId) return res.status(200).json((data || []).map(o => o.valor));

        // Modo com id — usado pela tela de gerenciar (precisa do id pra
        // poder apagar um valor específico)
        // Sempre devolve tamanho/cor/genero (mesmo vazios, como antes) + uma lista
        // por cada atributo personalizado que a loja tiver (SQL 31).
        const agrupar = (mapear) => {
            const out = { tamanho: [], cor: [], genero: [] };
            for (const o of data || []) (out[o.tipo] = out[o.tipo] || []).push(mapear(o));
            return out;
        };
        if (comId) return res.status(200).json(agrupar(o => ({ id: o.id, valor: o.valor })));
        res.status(200).json(agrupar(o => o.valor));
    } catch (error) {
        console.error(`[ERRO] GET /:id/opcoes-variacao:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar opções de variação.' });
    }
});

// --- Rota POST: /:id/opcoes-variacao — adiciona um preset manualmente
// (a tela de gerenciar usa essa; a criação "automática" ao digitar um
// valor novo numa variação usa upsert direto, dentro de sincronizarVariacoes) ---
router.post('/:id/opcoes-variacao', limitarFrequencia('opcoes-variacao', 150), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const { tipo } = req.body;
    const valor = typeof req.body.valor === 'string' ? req.body.valor : '';

    // tamanho/cor/genero sempre valem; os outros precisam ser um atributo da loja (SQL 31)
    if (!AV.chaveValida(tipo)) {
        return res.status(400).json({ error: 'Atributo inválido.' });
    }
    if (!valor.trim()) {
        return res.status(400).json({ error: 'Informe um valor.' });
    }

    const erroTamanho = validarTamanhos({ valor }, { valor: LIMITES.VARIACAO });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    try {
        if (!AV.ehLegado(tipo)) {
            const { atributos } = await carregarAtributosLoja(estabelecimentoId);
            if (!atributos.some(a => a.chave === tipo)) return res.status(400).json({ error: 'Esse atributo não existe nesta loja.' });
        }
        const erroLimite = await erroTetoValores(estabelecimentoId, tipo);
        if (erroLimite) return res.status(409).json({ error: erroLimite });

        const { data, error } = await db
            .from('opcoes_variacao')
            .insert({ mercearia_id: estabelecimentoId, tipo, valor: valor.trim() })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'Esse valor já está cadastrado.' });
            const teto = AV.mensagemTeto(error);
            if (teto) return res.status(409).json({ error: teto });
            if (error.code === '23514') return res.status(503).json({ error: 'Esta função ainda será liberada: falta atualizar o banco de dados. Avise o suporte.' }); // antes do SQL 31
            throw error;
        }

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'opcao_variacao_criada',
          descricao: `Opção de variação criada — ${tipo}: "${valor.trim()}"`,
          meta: { opcao_id: data.id, tipo, valor: valor.trim() },
        });

        res.status(201).json(data);
    } catch (error) {
        console.error(`[ERRO] POST /:id/opcoes-variacao:`, error.message);
        res.status(500).json({ error: 'Erro ao adicionar opção.' });
    }
});

// --- Rota DELETE: /:id/opcoes-variacao/:optId ---
// Remove um preset da lista de sugestões. Não afeta produtos que já
// usam esse valor — tamanho/cor ficam gravados como texto simples em
// cada variação, não como referência a essa tabela.
router.delete('/:id/opcoes-variacao/:optId', limitarFrequencia('opcoes-variacao', 150), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const { id: estabelecimentoId, optId } = req.params;
    try {
        // Busca antes de apagar só pra descrever direito na auditoria
        // (depois de apagado não tem mais como saber o que era)
        const { data: opcao } = await db
            .from('opcoes_variacao')
            .select('tipo, valor')
            .eq('id', optId)
            .eq('mercearia_id', estabelecimentoId)
            .single();

        const { error } = await db
            .from('opcoes_variacao')
            .delete()
            .eq('id', optId)
            .eq('mercearia_id', estabelecimentoId);

        if (error) throw error;

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'opcao_variacao_removida',
          descricao: `Opção de variação removida${opcao ? ` — ${opcao.tipo}: "${opcao.valor}"` : ''}`,
          meta: { opcao_id: optId, tipo: opcao?.tipo || null, valor: opcao?.valor || null },
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error(`[ERRO] DELETE /:id/opcoes-variacao/:optId:`, error.message);
        res.status(500).json({ error: 'Erro ao remover opção.' });
    }
});

// ── Atributos de variação por loja (SQL 31, 13/10/2026) ─────────────────────
// Cada loja define os atributos que seus produtos variam (tamanho, cor, personagem,
// nº de peças…). Regras e padrões por tipo de estabelecimento: utils/atributosVariacao.js.
// "Apagar" um atributo = ocultar (ativo=false): o que já foi gravado nas variações fica.
// Antes do SQL 31 a tabela não existe: o GET devolve só os padrões e o resto responde 503.
async function carregarAtributosLoja(estabelecimentoId) {
    const { data: loja } = await db.from('mercearias').select('tipo_estabelecimento').eq('id', estabelecimentoId).maybeSingle();
    let linhas = [];
    let tabelaPronta = true;
    // SQL 40 (coluna `removido`): sem ela vale o modelo antigo (padrão automático por tipo).
    let modeloNovo = true;
    let { data, error } = await db.from('atributos_variacao')
        .select('chave, nome, ordem, ativo, removido').eq('mercearia_id', estabelecimentoId).limit(100);
    if (error && error.code === '42703') {
        modeloNovo = false;
        ({ data, error } = await db.from('atributos_variacao')
            .select('chave, nome, ordem, ativo').eq('mercearia_id', estabelecimentoId).limit(100));
    }
    if (error) {
        if (tabelaAusente(error)) tabelaPronta = false;
        else throw error;
    } else {
        linhas = data || [];
    }
    return {
        tipo_estabelecimento: loja?.tipo_estabelecimento || null,
        atributos: AV.montarAtributos(loja?.tipo_estabelecimento, linhas, modeloNovo && tabelaPronta),
        sugestoes: modeloNovo && tabelaPronta ? AV.sugestoesDoTipo(loja?.tipo_estabelecimento, linhas) : [],
        linhas,
        modeloNovo: modeloNovo && tabelaPronta,
        tabelaPronta,
    };
}

// Teto de valores sugeridos (por atributo e na loja). Se a contagem falhar, não trava (como erroTeto).
async function erroTetoValores(estabelecimentoId, tipo) {
    try {
        const { count: noTipo, error: e1 } = await db.from('opcoes_variacao')
            .select('id', { count: 'exact', head: true }).eq('mercearia_id', estabelecimentoId).eq('tipo', tipo);
        if (!e1 && (noTipo || 0) >= AV.TETOS_ATRIBUTOS.VALORES_ATRIBUTO) {
            return AV.mensagemTeto({ message: `TETO:valores_atributo:${AV.TETOS_ATRIBUTOS.VALORES_ATRIBUTO}` });
        }
        const { count: naLoja, error: e2 } = await db.from('opcoes_variacao')
            .select('id', { count: 'exact', head: true }).eq('mercearia_id', estabelecimentoId);
        if (!e2 && (naLoja || 0) >= AV.TETOS_ATRIBUTOS.VALORES_LOJA) {
            return AV.mensagemTeto({ message: `TETO:valores_loja:${AV.TETOS_ATRIBUTOS.VALORES_LOJA}` });
        }
    } catch (e) {
        console.error('[TETO] contagem de opcoes_variacao falhou:', e.message);
    }
    return null;
}

const PERMISSAO_ATRIBUTOS = [[PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nos atributos de variação.' }];
const MSG_SQL31_PENDENTE = 'Esta função ainda será liberada: falta atualizar o banco de dados. Avise o suporte.';

function auditarAtributo(req, acao, descricao, meta) {
    registrar({
        mercearia_id: req.params.id,
        operador_id: req.user.role === 'operator' ? req.user.id : null,
        usuario_nome: req.user.nome,
        usuario_email: req.user.email,
        modulo: 'estoque', acao, descricao, meta,
    });
}

// Valida o nome digitado; devolve { nome } ou { erro }.
function nomeAtributoValido(bruto) {
    const nome = typeof bruto === 'string' ? bruto.trim().replace(/\s+/g, ' ') : '';
    if (!nome) return { erro: 'Informe o nome do atributo.' };
    if (nome.length > AV.TETOS_ATRIBUTOS.NOME_ATRIBUTO) return { erro: `O nome do atributo pode ter no máximo ${AV.TETOS_ATRIBUTOS.NOME_ATRIBUTO} caracteres.` };
    if (contemPalavraProibida(nome)) return { erro: 'Esse nome não é permitido.' };
    return { nome };
}

router.get('/:id/atributos-variacao', async (req, res) => {
    try {
        const r = await carregarAtributosLoja(req.params.id);
        res.json({
            tipo_estabelecimento: r.tipo_estabelecimento,
            pronto: r.tabelaPronta, // false = SQL 31 ainda não rodou (só leitura dos padrões)
            atributos: r.atributos,
            sugestoes: r.sugestoes,
            modelo_novo: r.modeloNovo,
            modelos_prontos: AV.MODELOS_PRONTOS,
            limites: {
                atributos_loja: AV.TETOS_ATRIBUTOS.ATRIBUTOS_LOJA,
                atributos_produto: AV.TETOS_ATRIBUTOS.ATRIBUTOS_PRODUTO,
                valores_atributo: AV.TETOS_ATRIBUTOS.VALORES_ATRIBUTO,
                variacoes_produto: AV.TETOS_ATRIBUTOS.VARIACOES_PRODUTO,
                nome_atributo: AV.TETOS_ATRIBUTOS.NOME_ATRIBUTO,
            },
        });
    } catch (error) {
        console.error('[ERRO] GET /:id/atributos-variacao:', error.message);
        res.status(500).json({ error: 'Erro ao buscar os atributos de variação.' });
    }
});

// Cria um atributo da loja (ex.: "Personagem/tema"). A chave é gerada do nome e nunca muda.
router.post('/:id/atributos-variacao', limitarFrequencia('atributos-variacao', 30), verificarPermissao(...PERMISSAO_ATRIBUTOS), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const v = nomeAtributoValido(req.body?.nome);
    if (v.erro) return res.status(400).json({ error: v.erro });

    try {
        const r = await carregarAtributosLoja(estabelecimentoId);
        if (!r.tabelaPronta) return res.status(503).json({ error: MSG_SQL31_PENDENTE });

        const igual = r.atributos.find(a => AV.nomeIgual(a.nome, v.nome));
        if (igual) {
            return res.status(409).json({ error: igual.ativo
                ? 'Já existe um atributo com esse nome.'
                : 'Já existe um atributo com esse nome, mas ele está oculto. Reative-o em vez de criar outro.' });
        }
        if (AV.contarParaTeto(r.atributos) >= AV.TETOS_ATRIBUTOS.ATRIBUTOS_LOJA) {
            return res.status(409).json({ error: AV.mensagemTeto({ message: `TETO:atributos_loja:${AV.TETOS_ATRIBUTOS.ATRIBUTOS_LOJA}` }) });
        }

        const usadas = new Set(r.atributos.map(a => a.chave));
        const base = AV.chaveDoNome(v.nome);
        let chave = base;
        const ordem = Math.min(1000, Math.max(...r.atributos.map(a => a.ordem), 30) + 10);

        // Nome igual a tamanho/cor/gênero (livres) → usa a chave legada (fica nas colunas antigas).
        // Se havia uma linha (sugestão dispensada), reaproveita em vez de colidir.
        const linhaLegada = r.modeloNovo && AV.ehLegado(base) && !usadas.has(base);
        if (!linhaLegada) {
            for (let i = 2; usadas.has(chave) || r.linhas.some(l => l.chave === chave); i++) chave = `${base.slice(0, 30 - String(i).length - 1)}_${i}`;
        }
        const reg = { mercearia_id: estabelecimentoId, chave, nome: v.nome, ordem, ativo: true, ...(r.modeloNovo ? { removido: false } : {}), ...carimboCriacao(req) };
        const { data, error } = await (linhaLegada && r.linhas.some(l => l.chave === chave)
            ? db.from('atributos_variacao').update({ nome: v.nome, ordem, ativo: true, removido: false, ...carimboAlteracao(req) })
                .eq('mercearia_id', estabelecimentoId).eq('chave', chave).select('chave, nome, ordem, ativo').single()
            : db.from('atributos_variacao').insert(reg).select('chave, nome, ordem, ativo').single());
        if (error) {
            const teto = AV.mensagemTeto(error);
            if (teto) return res.status(409).json({ error: teto });
            if (error.code === '23505') return res.status(409).json({ error: 'Já existe um atributo com esse nome.' });
            throw error;
        }

        auditarAtributo(req, 'atributo_variacao_criado', `Atributo de variação criado: "${v.nome}"`, { chave, nome: v.nome });
        res.status(201).json({ ...data, legado: AV.ehLegado(data.chave), personalizado: true });
    } catch (error) {
        console.error('[ERRO] POST /:id/atributos-variacao:', error.message);
        res.status(500).json({ error: 'Erro ao criar o atributo.' });
    }
});

// Renomeia, oculta/reativa ou muda a ordem de um atributo (inclusive tamanho/cor/gênero).
router.put('/:id/atributos-variacao/:chave', limitarFrequencia('atributos-variacao', 30), verificarPermissao(...PERMISSAO_ATRIBUTOS), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const chave = req.params.chave;
    if (!AV.chaveValida(chave)) return res.status(400).json({ error: 'Atributo inválido.' });

    const body = req.body || {};
    const mexeNome = body.nome !== undefined;
    const mexeAtivo = body.ativo !== undefined;
    const mexeOrdem = body.ordem !== undefined;
    if (!mexeNome && !mexeAtivo && !mexeOrdem) return res.status(400).json({ error: 'Nada para alterar.' });
    if (mexeAtivo && typeof body.ativo !== 'boolean') return res.status(400).json({ error: 'Valor inválido para ativo.' });
    let ordem;
    if (mexeOrdem) {
        ordem = Number(body.ordem);
        if (!Number.isInteger(ordem) || ordem < 0 || ordem > 1000) return res.status(400).json({ error: 'Ordem inválida.' });
    }
    let novoNome;
    if (mexeNome) {
        const v = nomeAtributoValido(body.nome);
        if (v.erro) return res.status(400).json({ error: v.erro });
        novoNome = v.nome;
    }

    try {
        const r = await carregarAtributosLoja(estabelecimentoId);
        if (!r.tabelaPronta) return res.status(503).json({ error: MSG_SQL31_PENDENTE });

        const atual = r.atributos.find(a => a.chave === chave);
        if (!atual) return res.status(404).json({ error: 'Atributo não encontrado.' });

        const nome = mexeNome ? novoNome : atual.nome;
        const ativo = mexeAtivo ? body.ativo : atual.ativo;
        const novaOrdem = mexeOrdem ? ordem : atual.ordem;

        // Nome não pode repetir o de outro atributo ativo (ocultos não contam, a não ser que este vá ficar ativo)
        if (ativo && r.atributos.some(a => a.chave !== chave && a.ativo && AV.nomeIgual(a.nome, nome))) {
            return res.status(409).json({ error: 'Já existe outro atributo com esse nome.' });
        }
        // A loja precisa de pelo menos um atributo ligado, senão não dá para criar variações
        if (!r.modeloNovo && !ativo && atual.ativo && !r.atributos.some(a => a.chave !== chave && a.ativo)) {
            return res.status(409).json({ error: 'A loja precisa manter pelo menos um atributo ligado.' });
        }

        const { error } = await db.from('atributos_variacao').upsert({
            mercearia_id: estabelecimentoId, chave, nome, ordem: novaOrdem, ativo,
            ...(atual.personalizado ? {} : carimboCriacao(req)),
            ...carimboAlteracao(req),
        }, { onConflict: 'mercearia_id,chave' });
        if (error) {
            const teto = AV.mensagemTeto(error);
            if (teto) return res.status(409).json({ error: teto });
            if (error.code === '23505') return res.status(409).json({ error: 'Já existe outro atributo com esse nome.' });
            throw error;
        }

        const partes = [];
        if (mexeNome && nome !== atual.nome) partes.push(`renomeado de "${atual.nome}" para "${nome}"`);
        if (mexeAtivo && ativo !== atual.ativo) partes.push(ativo ? 'reativado' : 'ocultado');
        if (mexeOrdem && novaOrdem !== atual.ordem) partes.push('ordem alterada');
        auditarAtributo(req, 'atributo_variacao_alterado', `Atributo de variação "${atual.nome}": ${partes.join(', ') || 'sem mudanças'}`,
            { chave, nome, ativo, ordem: novaOrdem });
        res.json({ chave, nome, ordem: novaOrdem, ativo, legado: AV.ehLegado(chave), personalizado: true });
    } catch (error) {
        console.error('[ERRO] PUT /:id/atributos-variacao/:chave:', error.message);
        res.status(500).json({ error: 'Erro ao salvar o atributo.' });
    }
});

// Exclui um atributo da loja (inclusive tamanho/cor/gênero). Só deixa se nenhuma variação da
// loja usa o atributo; apaga junto os valores sugeridos dele. Tamanho/cor/gênero excluídos
// voltam a aparecer como SUGESTÃO (se o tipo de estabelecimento sugere) — dá para dispensar.
router.delete('/:id/atributos-variacao/:chave', limitarFrequencia('atributos-variacao', 30), verificarPermissao(...PERMISSAO_ATRIBUTOS), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const chave = req.params.chave;
    if (!AV.chaveValida(chave)) return res.status(400).json({ error: 'Atributo inválido.' });

    try {
        const r = await carregarAtributosLoja(estabelecimentoId);
        if (!r.tabelaPronta) return res.status(503).json({ error: MSG_SQL31_PENDENTE });
        if (AV.ehLegado(chave) && !r.modeloNovo) return res.status(503).json({ error: MSG_SQL31_PENDENTE });
        const atual = r.atributos.find(a => a.chave === chave && a.personalizado);
        if (!atual) return res.status(404).json({ error: 'Atributo não encontrado.' });

        let uso = db.from('produto_variacoes')
            .select('id, produtos!inner(mercearia_id)', { count: 'exact', head: true })
            .eq('produtos.mercearia_id', estabelecimentoId);
        uso = AV.ehLegado(chave)
            ? uso.not(chave, 'is', null).neq(chave, '')
            : uso.filter(`atributos->>${chave}`, 'not.is', null);
        const { count, error: eUso } = await uso;
        if (eUso) throw eUso;
        if (count > 0) {
            return res.status(409).json({ error: `"${atual.nome}" está preenchido em ${count} variação(ões) de produtos. Para não perder esses dados, use "Ocultar" em vez de excluir.` });
        }

        const { error: eVal } = await db.from('opcoes_variacao').delete().eq('mercearia_id', estabelecimentoId).eq('tipo', chave);
        if (eVal) throw eVal;
        const { error } = await db.from('atributos_variacao').delete().eq('mercearia_id', estabelecimentoId).eq('chave', chave);
        if (error) throw error;

        auditarAtributo(req, 'atributo_variacao_excluido', `Atributo de variação excluído: "${atual.nome}"`, { chave, nome: atual.nome });
        res.json({ ok: true });
    } catch (error) {
        console.error('[ERRO] DELETE /:id/atributos-variacao/:chave:', error.message);
        res.status(500).json({ error: 'Erro ao excluir o atributo.' });
    }
});

// Sugestão do tipo de estabelecimento: "adicionar" (vira atributo da loja) ou "dispensar" (some).
router.post('/:id/atributos-variacao/sugestoes/:chave', limitarFrequencia('atributos-variacao', 30), verificarPermissao(...PERMISSAO_ATRIBUTOS), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const chave = req.params.chave;
    const acao = req.body?.acao;
    if (!AV.ehLegado(chave) || !['adicionar', 'dispensar'].includes(acao)) return res.status(400).json({ error: 'Pedido inválido.' });

    try {
        const r = await carregarAtributosLoja(estabelecimentoId);
        if (!r.tabelaPronta || !r.modeloNovo) return res.status(503).json({ error: MSG_SQL31_PENDENTE });
        const sug = r.sugestoes.find(x => x.chave === chave);
        if (!sug) return res.status(404).json({ error: 'Essa sugestão não está mais disponível.' });

        if (acao === 'adicionar') {
            if (r.atributos.some(a => AV.nomeIgual(a.nome, sug.nome))) {
                return res.status(409).json({ error: `Já existe um atributo chamado "${sug.nome}".` });
            }
            const ordem = Math.min(1000, Math.max(...r.atributos.map(a => a.ordem), 0) + 10);
            const { error } = await db.from('atributos_variacao')
                .insert({ mercearia_id: estabelecimentoId, chave, nome: sug.nome, ordem, ativo: true, removido: false, ...carimboCriacao(req) });
            if (error) {
                const teto = AV.mensagemTeto(error);
                if (teto) return res.status(409).json({ error: teto });
                throw error;
            }
            auditarAtributo(req, 'atributo_variacao_criado', `Atributo de variação criado (sugestão): "${sug.nome}"`, { chave, nome: sug.nome });
        } else {
            const { error } = await db.from('atributos_variacao')
                .insert({ mercearia_id: estabelecimentoId, chave, nome: sug.nome, ordem: 0, ativo: false, removido: true, ...carimboCriacao(req) });
            if (error) {
                const teto = AV.mensagemTeto(error);
                if (teto) return res.status(409).json({ error: teto });
                throw error;
            }
            auditarAtributo(req, 'atributo_variacao_alterado', `Sugestão de atributo dispensada: "${sug.nome}"`, { chave, nome: sug.nome });
        }
        res.json({ ok: true });
    } catch (error) {
        console.error('[ERRO] POST /:id/atributos-variacao/sugestoes:', error.message);
        res.status(500).json({ error: 'Erro ao salvar a sugestão.' });
    }
});

// --- Tipos de produto (modelos de tamanho) — salvos na conta da loja, valem em
// qualquer computador. Ex.: "Boné" com tamanhos 56, 58, 60. (SQL 28) ---
const TABELA_AUSENTE = '42P01';
const tabelaAusente = (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /schema cache|does not exist/i.test(e.message || ''));
function limparTamanhos(lista) {
    const vistos = new Set();
    const out = [];
    for (const t of Array.isArray(lista) ? lista : []) {
        const v = String(t ?? '').trim().slice(0, 50);
        if (!v || vistos.has(v.toLowerCase())) continue;
        vistos.add(v.toLowerCase());
        out.push(v);
        if (out.length >= 60) break;
    }
    return out;
}

router.get('/:id/modelos-variacao', async (req, res) => {
    try {
        const consulta = (cols) => db.from('modelos_variacao').select(cols)
            .eq('mercearia_id', req.params.id).order('criado_em', { ascending: true }).limit(100);
        let { data, error } = await consulta('id, nome, tamanhos, modelo_base, visivel');
        if (error && error.code === '42703') ({ data, error } = await consulta('id, nome, tamanhos, modelo_base')); // antes do SQL 30
        if (error && error.code === '42703') ({ data, error } = await consulta('id, nome, tamanhos'));              // antes do SQL 29
        if (error) {
            if (tabelaAusente(error)) data = []; // antes do SQL 28
            else throw error;
        }
        if (req.query.completo) {
            const { data: loja } = await db.from('mercearias').select('tipo_estabelecimento').eq('id', req.params.id).maybeSingle();
            return res.json({ tipo_estabelecimento: loja?.tipo_estabelecimento || null, modelos: data || [] });
        }
        res.json(data || []);
    } catch (error) {
        console.error('[ERRO] GET /:id/modelos-variacao:', error.message);
        res.status(500).json({ error: 'Erro ao buscar os tipos de produto.' });
    }
});

router.post('/:id/modelos-variacao', limitarFrequencia('modelos-variacao', 40), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const nome = String(req.body?.nome ?? '').trim();
    const tamanhos = limparTamanhos(req.body?.tamanhos);
    if (!nome) return res.status(400).json({ error: 'Dê um nome ao tipo de produto.' });
    if (nome.length > 40) return res.status(400).json({ error: 'O nome do tipo pode ter no máximo 40 caracteres.' });
    if (!tamanhos.length) return res.status(400).json({ error: 'Informe pelo menos um tamanho.' });
    try {
        const { count } = await db.from('modelos_variacao').select('id', { count: 'exact', head: true }).eq('mercearia_id', estabelecimentoId);
        if ((count || 0) >= 100) return res.status(400).json({ error: 'Limite de 100 tipos de produto atingido.' });
        const { data, error } = await db.from('modelos_variacao')
            .insert({ mercearia_id: estabelecimentoId, nome, tamanhos, criado_por_nome: req.user.nome || null })
            .select('id, nome, tamanhos').single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'Já existe um tipo com esse nome.' });
            if (tabelaAusente(error)) return res.status(503).json({ error: 'Recurso ainda não liberado no banco. Fale com o suporte.' });
            throw error;
        }
        registrar({
            mercearia_id: estabelecimentoId,
            operador_id:  req.user.role === 'operator' ? req.user.id : null,
            usuario_nome: req.user.nome, usuario_email: req.user.email,
            modulo: 'estoque', acao: 'modelo_variacao_criado',
            descricao: `Tipo de produto criado: "${nome}" (${tamanhos.length} tamanho(s))`,
            meta: { modelo_id: data.id, nome, tamanhos },
        });
        res.status(201).json(data);
    } catch (error) {
        console.error('[ERRO] POST /:id/modelos-variacao:', error.message);
        res.status(500).json({ error: 'Erro ao salvar o tipo de produto.' });
    }
});

// Ajustes de um tipo pronto para esta loja: tamanhos extras (ex.: 56 em Calçados) e se o
// tipo aparece ou não (visivel: true/false/null = padrão do tipo de estabelecimento). (SQL 29/30)
router.put('/:id/modelos-variacao/base/:baseId', limitarFrequencia('modelos-variacao', 40), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const estabelecimentoId = req.params.id;
    const baseId = String(req.params.baseId || '');
    const nome = String(req.body?.nome ?? '').trim();
    if (!/^[a-z][a-z-]{0,19}$/.test(baseId)) return res.status(400).json({ error: 'Tipo inválido.' });
    if (!nome || nome.length > 40) return res.status(400).json({ error: 'Nome do tipo inválido.' });
    const mexeuTamanhos = req.body?.tamanhos !== undefined;
    const mexeuVisivel = req.body?.visivel !== undefined;
    if (mexeuVisivel && ![true, false, null].includes(req.body.visivel)) return res.status(400).json({ error: 'Valor inválido.' });
    try {
        let { data: atual, error: eBusca } = await db.from('modelos_variacao').select('id, tamanhos, visivel')
            .eq('mercearia_id', estabelecimentoId).eq('modelo_base', baseId).maybeSingle();
        if (eBusca && eBusca.code === '42703') { // sem a coluna visivel (antes do SQL 30)
            if (mexeuVisivel) return res.status(503).json({ error: 'Recurso ainda não liberado no banco. Fale com o suporte.' });
            ({ data: atual, error: eBusca } = await db.from('modelos_variacao').select('id, tamanhos')
                .eq('mercearia_id', estabelecimentoId).eq('modelo_base', baseId).maybeSingle());
        }
        if (eBusca) {
            if (tabelaAusente(eBusca) || eBusca.code === '42703') return res.status(503).json({ error: 'Recurso ainda não liberado no banco. Fale com o suporte.' });
            throw eBusca;
        }
        const tamanhos = mexeuTamanhos ? limparTamanhos(req.body.tamanhos) : (atual?.tamanhos || []);
        const visivel = mexeuVisivel ? req.body.visivel : (atual?.visivel ?? null);
        const resultado = { id: atual?.id || null, nome, tamanhos, visivel, modelo_base: baseId };
        if (!tamanhos.length && visivel === null) {
            if (atual) await db.from('modelos_variacao').delete().eq('id', atual.id).eq('mercearia_id', estabelecimentoId);
            resultado.id = null;
        } else if (atual) {
            const { error } = await db.from('modelos_variacao').update({ tamanhos, ...(mexeuVisivel ? { visivel } : {}) }).eq('id', atual.id).eq('mercearia_id', estabelecimentoId);
            if (error) throw error;
        } else {
            const { data, error } = await db.from('modelos_variacao')
                .insert({ mercearia_id: estabelecimentoId, nome, tamanhos, modelo_base: baseId, ...(mexeuVisivel ? { visivel } : {}), criado_por_nome: req.user.nome || null })
                .select('id').single();
            if (error) {
                if (error.code === '23505') return res.status(409).json({ error: 'Já existe um tipo com esse nome.' });
                throw error;
            }
            resultado.id = data.id;
        }
        registrar({
            mercearia_id: estabelecimentoId,
            operador_id:  req.user.role === 'operator' ? req.user.id : null,
            usuario_nome: req.user.nome, usuario_email: req.user.email,
            modulo: 'estoque', acao: 'modelo_variacao_criado',
            descricao: mexeuVisivel
                ? `Tipo de produto "${nome}" ${visivel === false ? 'tirado da lista' : visivel === true ? 'adicionado à lista' : 'voltou ao padrão'}`
                : `Tamanhos extras do tipo "${nome}": ${tamanhos.length ? tamanhos.join(', ') : 'nenhum'}`,
            meta: { modelo_base: baseId, tamanhos, visivel },
        });
        res.json(resultado);
    } catch (error) {
        console.error('[ERRO] PUT /:id/modelos-variacao/base:', error.message);
        res.status(500).json({ error: 'Erro ao salvar o tipo.' });
    }
});

// Troca a lista de tamanhos de um tipo criado pelo comerciante.
router.put('/:id/modelos-variacao/:modeloId', limitarFrequencia('modelos-variacao', 40), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const { id: estabelecimentoId, modeloId } = req.params;
    const tamanhos = limparTamanhos(req.body?.tamanhos);
    if (!tamanhos.length) return res.status(400).json({ error: 'O tipo precisa ter pelo menos um tamanho.' });
    try {
        const { data, error } = await db.from('modelos_variacao').update({ tamanhos })
            .eq('id', modeloId).eq('mercearia_id', estabelecimentoId).select('id, nome, tamanhos').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Tipo não encontrado.' });
        registrar({
            mercearia_id: estabelecimentoId,
            operador_id:  req.user.role === 'operator' ? req.user.id : null,
            usuario_nome: req.user.nome, usuario_email: req.user.email,
            modulo: 'estoque', acao: 'modelo_variacao_criado',
            descricao: `Tamanhos do tipo "${data.nome}" alterados: ${tamanhos.join(', ')}`,
            meta: { modelo_id: modeloId, tamanhos },
        });
        res.json(data);
    } catch (error) {
        console.error('[ERRO] PUT /:id/modelos-variacao/:modeloId:', error.message);
        res.status(500).json({ error: 'Erro ao salvar os tamanhos do tipo.' });
    }
});

router.delete('/:id/modelos-variacao/:modeloId', limitarFrequencia('modelos-variacao', 40), verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para mexer nas opções de variação.' }), async (req, res) => {
    const { id: estabelecimentoId, modeloId } = req.params;
    try {
        const { data: antigo } = await db.from('modelos_variacao').select('nome').eq('id', modeloId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        const { error } = await db.from('modelos_variacao').delete().eq('id', modeloId).eq('mercearia_id', estabelecimentoId);
        if (error) throw error;
        registrar({
            mercearia_id: estabelecimentoId,
            operador_id:  req.user.role === 'operator' ? req.user.id : null,
            usuario_nome: req.user.nome, usuario_email: req.user.email,
            modulo: 'estoque', acao: 'modelo_variacao_removido',
            descricao: `Tipo de produto removido${antigo ? `: "${antigo.nome}"` : ''}`,
            meta: { modelo_id: modeloId },
        });
        res.json({ success: true });
    } catch (error) {
        console.error('[ERRO] DELETE /:id/modelos-variacao/:modeloId:', error.message);
        res.status(500).json({ error: 'Erro ao remover o tipo de produto.' });
    }
});

router.get('/:id/produtos', async (req, res) => {

    const estabelecimentoId = req.params.id;

    if (!estabelecimentoId) {
        return res.status(400).json({ error: 'ID do estabelecimento é obrigatório.' });
    }

    try {

        const { data, error } = await consultarComAtributos((comAtr) => db
            .from('produtos')
            .select(`
                id,
                nome,
                marca,
                estoque_atual,
                estoque_minimo,
                preco_venda,
                preco_custo,
                codigo_barras,
                categoria_id,
                unidade_medida,
                vendido_por_peso,
                plu_balanca,
                tem_variacoes,
                imagem_url,
                imagem_extra_url,
                categorias ( nome ),
                produto_variacoes ( id, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, imagem_url, imagem_origem, ativo )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .order('nome', { ascending: true }));

        if (error) throw error;

        const produtosFormatados = data.map(p => {
            const variacoesAtivas = (p.produto_variacoes || []).filter(v => v.ativo);
            return {
                ...p,
                nome_categoria: p.categorias ? p.categorias.nome : null,
                // Com variações, o estoque "do produto" pra exibição na lista
                // é a soma de todas as variações ativas — o valor bruto da
                // coluna estoque_atual do produto não é usado nesse caso.
                estoque_atual: p.tem_variacoes
                    ? variacoesAtivas.reduce((acc, v) => acc + (parseFloat(v.estoque_atual) || 0), 0)
                    : p.estoque_atual,
                variacoes: variacoesAtivas,
            };
        });
        await anexarRotulos(estabelecimentoId, produtosFormatados);

        res.status(200).json(produtosFormatados);

    } catch (error) {

        console.error(`[ERRO CRÍTICO] Falha na rota GET produtos:`, error.message);
        return res.status(500).json({ error: 'Erro interno ao buscar produtos.' });

    }
});


// --- Rota POST /:id/produtos ---
/* ============================================================
   CATÁLOGO GLOBAL DE PRODUTOS — auto-preenchimento por código de barras
============================================================ */

// Último recurso quando o produto não tem nome em português cadastrado
// em nenhuma base (nem product_name_pt no OFF/OPF) — traduz automático.
// Usa o endpoint público do Google Translate (o mesmo que o "traduzir
// página" do navegador usa por trás), sem chave, com detecção automática
// do idioma de origem (sl=auto), já que o nome pode vir em qualquer
// idioma dependendo de quem cadastrou o produto. É um endpoint não
// documentado oficialmente pelo Google — funciona bem na prática, mas
// pode mudar ou ficar fora do ar sem aviso, por isso a falha aqui nunca
// quebra o fluxo: some erro, some resultado, sem tradução, autopreenche.
// Nunca é usado pra marca — marca de produto nunca deve ser traduzida.
async function traduzirParaPortugues(texto) {
  if (!texto || !texto.trim()) return null;
  try {
    const resp = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(texto)}`
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const traduzido = (json?.[0] || []).map(seg => seg[0]).join('').trim();
    if (!traduzido || traduzido.toLowerCase() === texto.trim().toLowerCase()) return null;
    return traduzido;
  } catch (err) {
    console.error('[CATALOGO] Erro ao traduzir nome:', err.message);
    return null;
  }
}

// Consulta a Open Food Facts (API pública, gratuita, sem chave).
// Retorna { nome, marca, imagem_url, traduzido } ou null se não encontrar.
async function consultarOpenFoodFacts(codigo) {
  try {
    // lc=pt pede pra API priorizar o nome em português quando o produto
    // tiver um cadastrado (comum em produto brasileiro) — e como reforço
    // pedimos também o campo product_name_pt direto, que existe
    // independente do idioma escolhido em lc. Sem isso, o campo genérico
    // product_name vem no idioma que o primeiro contribuidor digitou (às
    // vezes inglês/francês/outro), mesmo quando existe versão em PT.
    const resp = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json?fields=product_name,product_name_pt,brands,image_front_url,image_url&lc=pt`,
      { headers: { 'User-Agent': 'GerenciadorEstabelecimentos - LucasJSystems - contato via app' } }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== 1 || !json.product) return null;

    let nome   = (json.product.product_name_pt || json.product.product_name || '').trim();
    const marca = (json.product.brands || '').split(',')[0].trim();
    if (!nome) return null;

    // Não tinha product_name_pt cadastrado — tenta traduzir o nome que
    // veio (última tentativa antes de deixar assim mesmo pro lojista ver)
    let traduzido = false;
    if (!json.product.product_name_pt) {
      const nomeTraduzido = await traduzirParaPortugues(nome);
      if (nomeTraduzido) { nome = nomeTraduzido; traduzido = true; }
    }

    // image_front_url é a foto de capa (melhor qualidade/recorte);
    // image_url é o fallback genérico quando não tem foto de capa
    const imagem_url = json.product.image_front_url || json.product.image_url || null;

    return { nome, marca: marca || null, imagem_url, traduzido };
  } catch (err) {
    console.error('[CATALOGO] Erro consultar Open Food Facts:', err.message);
    return null;
  }
}

// Open Products Facts — irmão do Open Food Facts, mesma estrutura de API,
// mas pra produtos em geral (não-alimentícios). Cobertura bem menor que
// o OFF (comunidade pequena), mas é grátis e não custa nada tentar —
// só entra em jogo quando nem o catálogo nem o OFF acham nada.
async function consultarOpenProductsFacts(codigo) {
  try {
    // Mesmo motivo do OFF acima: pede o nome já em português (lc=pt +
    // campo product_name_pt) em vez do nome genérico, que pode vir em
    // qualquer idioma dependendo de quem cadastrou o produto lá.
    const resp = await fetch(
      `https://world.openproductsfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json?fields=product_name,product_name_pt,brands,image_front_url,image_url&lc=pt`,
      { headers: { 'User-Agent': 'GerenciadorEstabelecimentos - LucasJSystems - contato via app' } }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== 1 || !json.product) return null;

    let nome   = (json.product.product_name_pt || json.product.product_name || '').trim();
    const marca = (json.product.brands || '').split(',')[0].trim();
    if (!nome) return null;

    let traduzido = false;
    if (!json.product.product_name_pt) {
      const nomeTraduzido = await traduzirParaPortugues(nome);
      if (nomeTraduzido) { nome = nomeTraduzido; traduzido = true; }
    }

    const imagem_url = json.product.image_front_url || json.product.image_url || null;

    return { nome, marca: marca || null, imagem_url, traduzido };
  } catch (err) {
    console.error('[CATALOGO] Erro consultar Open Products Facts:', err.message);
    return null;
  }
}

// Baixa a imagem encontrada no Open Food Facts/Open Products Facts e
// hospeda no nosso próprio Supabase Storage (bucket "logos", mesmo usado
// pra foto que o lojista envia) em vez de guardar o link externo direto.
// Motivo: guardando o link externo, é o NAVEGADOR DE CADA FUNCIONÁRIO que
// busca a imagem direto no servidor do Open Food Facts toda vez que não
// estiver em cache (primeiro acesso naquele aparelho, cache limpo,
// navegação anônima, etc.) — ficando na mão da velocidade/disponibilidade
// de terceiros, e isso acontece de novo pra cada funcionário/dispositivo
// separadamente. Guardando nosso próprio link, o download de verdade só
// acontece AQUI, UMA VEZ (quando o código é bipado pela primeira vez em
// qualquer loja do sistema — o catálogo é global), e todo mundo depois
// carrega rápido do nosso storage. Falha no download/upload nunca quebra
// o autopreenchimento: cai pro link original do OFF/OPF como estava antes.
async function rehospedarImagemCatalogo(urlOriginal, codigoBarras) {
  if (!urlOriginal || !codigoBarras) return urlOriginal || null;
  try {
    const resp = await fetch(urlOriginal, {
      headers: { 'User-Agent': 'GerenciadorEstabelecimentos - LucasJSystems - contato via app' },
    });
    if (!resp.ok) return urlOriginal;

    const buffer = Buffer.from(await resp.arrayBuffer());
    // Limite de segurança — a foto de capa do OFF/OPF nunca deveria chegar
    // perto disso, mas evita guardar algo anormalmente grande no storage.
    if (buffer.length > 3 * 1024 * 1024) return urlOriginal;

    const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const extensao = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    // Nome do arquivo = o próprio código de barras — como o catálogo é
    // global, existe uma imagem só por código (nunca uma por loja), e
    // upsert:true faz uma nova tentativa pro mesmo código sobrescrever
    // sem duplicar arquivo.
    const nomeArquivo = `catalogo/${codigoBarras}.${extensao}`;

    const { error: uploadErr } = await db.storage
      .from('logos')
      .upload(nomeArquivo, buffer, { upsert: true, contentType });
    if (uploadErr) throw uploadErr;

    const { data: urlData } = db.storage.from('logos').getPublicUrl(nomeArquivo);
    return urlData.publicUrl;
  } catch (err) {
    console.error('[CATALOGO] Erro ao re-hospedar imagem, usando link original do OFF/OPF:', err.message);
    return urlOriginal;
  }
}

// Salva no catálogo global — usado tanto pelo fallback do Open Food Facts
// quanto pelo cadastro manual de produtos (contribuição colaborativa).
// IMPORTANTE: nunca sobrescreve um código de barras que já existe no
// catálogo. O primeiro cadastro "vence"; contribuições seguintes pro
// mesmo código são ignoradas — evita que um erro de digitação de um
// estabelecimento estrague um dado bom que já estava lá pra todo mundo.
async function salvarNoCatalogoGlobal(codigo_barras, nome, marca, fonte = 'colaborativo', imagem_url = null) {
  if (!codigo_barras || !nome) return;
  try {
    await db.from('catalogo_global_produtos').upsert({
      codigo_barras,
      nome,
      marca: marca || null,
      fonte,
      imagem_url: imagem_url || null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'codigo_barras', ignoreDuplicates: true });
  } catch (err) {
    console.error('[CATALOGO] Erro salvar no catálogo global:', err.message);
  }
}

// Diferente de salvarNoCatalogoGlobal (que só grava se o código ainda não
// existir — "primeiro cadastro vence"): esta SOBRESCREVE a entrada do
// catálogo global quando o lojista corrige nome/marca de um produto que
// ele já tinha cadastrado. Faz sentido porque o app é só pro Brasil —
// uma correção pro nome certo em português deve valer pra próxima loja
// que bipar esse mesmo código, não só ficar presa nesse estabelecimento.
// Nunca mexe em imagem: foto do lojista nunca vai pro catálogo global.
async function atualizarCatalogoGlobal(codigo_barras, nome, marca) {
  if (!codigo_barras || !nome || codigoNaFaixaInterna(codigo_barras)) return;
  try {
    await db.from('catalogo_global_produtos').upsert({
      codigo_barras,
      nome,
      marca: marca || null,
      fonte: 'colaborativo',
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'codigo_barras' });
  } catch (err) {
    console.error('[CATALOGO] Erro atualizar catálogo global:', err.message);
  }
}

// Calcula o dígito verificador de um EAN-13 (algoritmo padrão: peso
// 1-3-1-3... alternado nos primeiros 12 dígitos, soma, resto da divisão
// por 10, e o dígito é o que falta pra chegar no próximo múltiplo de 10).
function calcularDigitoVerificadorEAN13(doze) {
  let soma = 0;
  for (let i = 0; i < 12; i++) {
    const d = parseInt(doze[i], 10);
    soma += (i % 2 === 0) ? d : d * 3;
  }
  const resto = soma % 10;
  return resto === 0 ? 0 : 10 - resto;
}

// Gera um código de barras EAN-13 interno — prefixo "20" (faixa 20-29 é
// reservada pela GS1 pra uso interno de lojas, nunca colide com código
// de fabricante de verdade) + 10 dígitos sequenciais próprios do
// estabelecimento + dígito verificador. O contador nunca reaproveita
// número, mesmo que um produto seja excluído depois.
async function gerarEAN13Interno(mercearia_id) {
  // O contador é atômico (UPDATE ... RETURNING no banco): dois cadastros ao
  // mesmo tempo nunca recebem o mesmo número. Mesmo assim (23/09/2026),
  // antes de devolver, confere se o código não está em uso nesta loja
  // (alguém pode ter digitado esse número à mão) e se ele não se confunde
  // com a etiqueta de balança de um produto pesável da loja (etiqueta de
  // balança também começa com "2": 2 + código do produto + peso). Se
  // bater, pula pro próximo número.
  for (let tentativa = 0; tentativa < 25; tentativa++) {
    const { data, error } = await db.rpc('incrementar_codigo_interno_seq', { p_mercearia_id: mercearia_id });
    if (error) throw error;
    const seq = data; // já vem incrementado
    const corpo = `20${String(seq).padStart(10, '0')}`;
    const codigo = `${corpo}${calcularDigitoVerificadorEAN13(corpo)}`;
    const codigoBalanca = codigo.substring(1, 6);

    const [{ data: p1 }, { data: p2 }, { data: p3 }] = await Promise.all([
      db.from('produtos').select('id').eq('mercearia_id', mercearia_id).eq('codigo_barras', codigo).limit(1),
      db.from('produto_variacoes').select('id').eq('mercearia_id', mercearia_id).eq('codigo_barras', codigo).limit(1),
      db.from('produtos').select('id').eq('mercearia_id', mercearia_id).eq('codigo_barras', codigoBalanca).limit(1),
    ]);
    if (!(p1 && p1.length) && !(p2 && p2.length) && !(p3 && p3.length)) return codigo;
  }
  throw new Error('Não foi possível gerar um código livre.');
}

// Um código de barras interno (faixa GS1 20-29) é sequencial POR
// ESTABELECIMENTO, não globalmente único — o 1º produto de cada loja
// gera o mesmo código que o 1º produto de qualquer outra loja. Por isso
// esses códigos nunca podem entrar no catálogo global compartilhado nem
// ser usados pra auto-preencher via lookup: se entrassem, o produto de
// uma loja "vazaria" o nome pro produto (completamente diferente) de
// outra loja que gerou o mesmo número internamente.
function codigoNaFaixaInterna(codigo) {
  const c = String(codigo || '').trim();
  if (!/^\d{13}$/.test(c)) return false;
  const prefixo = parseInt(c.slice(0, 2), 10);
  return prefixo >= 20 && prefixo <= 29;
}

// --- Rota GET: /:id/produtos/gerar-codigo-interno ---
// Usada pelo botão "Gerar código interno" no cadastro de produto (e nas
// variações) — devolve um EAN-13 pronto pra imprimir e colar na peça.
router.get('/:id/produtos/gerar-codigo-interno', verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para gerar código de produto.' }), async (req, res) => {
  try {
    const codigo = await gerarEAN13Interno(req.params.id);
    res.json({ codigo });
  } catch (err) {
    console.error('[ERRO] gerar-codigo-interno:', err.message);
    res.status(500).json({ error: 'Erro ao gerar código interno.' });
  }
});

// --- Rota GET: /:id/produtos/lookup-codigo?codigo=EAN ---
// Usada no cadastro de produto novo pra auto-preencher nome/marca/imagem.
// Ordem: 1) catálogo global (grátis, instantâneo) → 2) Open Food Facts
// (grátis, externo, forte em alimentos) → 3) Open Products Facts (grátis,
// externo, cobertura menor mas cobre produtos em geral) — os dois
// últimos já contribuem de volta pro catálogo global.
router.get('/:id/produtos/lookup-codigo', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo || !codigo.trim()) {
    return res.status(400).json({ error: 'Código de barras é obrigatório.' });
  }
  const codigoLimpo = codigo.trim();

  // Código gerado internamente (faixa 20-29) — nunca é um produto de
  // catálogo de verdade, e o mesmo número existe em várias lojas ao
  // mesmo tempo (cada uma com seu próprio contador). Nem consulta o
  // catálogo/Open Food Facts/Open Products Facts pra esse código.
  if (codigoNaFaixaInterna(codigoLimpo)) {
    return res.json({ encontrado: false });
  }

  try {
    // 1) Catálogo global compartilhado
    const { data: doCatalogo } = await db
      .from('catalogo_global_produtos')
      .select('nome, marca, imagem_url')
      .eq('codigo_barras', codigoLimpo)
      .maybeSingle();

    if (doCatalogo) {
      return res.json({
        encontrado: true,
        nome: doCatalogo.nome,
        marca: doCatalogo.marca,
        imagem_url: doCatalogo.imagem_url || null,
        fonte: 'catalogo',
        traduzido: false,
      });
    }

    // 2) Open Food Facts (fallback externo, gratuito — forte em alimentos)
    const doOff = await consultarOpenFoodFacts(codigoLimpo);
    if (doOff) {
      // Baixa e hospeda a imagem no nosso próprio storage antes de salvar
      // no catálogo/responder — ver comentário de rehospedarImagemCatalogo
      // acima pra entender o motivo (cache por dispositivo/funcionário).
      const imagemHospedada = doOff.imagem_url
        ? await rehospedarImagemCatalogo(doOff.imagem_url, codigoLimpo)
        : null;
      // Já grava no catálogo global o nome final (traduzido, se foi o caso)
      // — a próxima loja que bipar esse código pega direto do catálogo,
      // sem precisar traduzir de novo.
      await salvarNoCatalogoGlobal(codigoLimpo, doOff.nome, doOff.marca, 'openfoodfacts', imagemHospedada);
      return res.json({
        encontrado: true,
        nome: doOff.nome,
        marca: doOff.marca,
        imagem_url: imagemHospedada,
        fonte: 'openfoodfacts',
        traduzido: !!doOff.traduzido,
      });
    }

    // 3) Open Products Facts (fallback externo, gratuito — produtos em geral)
    const doOpf = await consultarOpenProductsFacts(codigoLimpo);
    if (doOpf) {
      const imagemHospedada = doOpf.imagem_url
        ? await rehospedarImagemCatalogo(doOpf.imagem_url, codigoLimpo)
        : null;
      await salvarNoCatalogoGlobal(codigoLimpo, doOpf.nome, doOpf.marca, 'openproductsfacts', imagemHospedada);
      return res.json({
        encontrado: true,
        nome: doOpf.nome,
        marca: doOpf.marca,
        imagem_url: imagemHospedada,
        fonte: 'openproductsfacts',
        traduzido: !!doOpf.traduzido,
      });
    }

    // Não encontrado em nenhuma fonte gratuita — comerciante preenche na mão
    res.json({ encontrado: false });

  } catch (err) {
    console.error(`[ERRO] GET lookup-codigo:`, err.message);
    res.status(500).json({ error: 'Erro ao consultar código de barras.' });
  }
});



router.post('/:id/produtos', verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_ADICIONAR], { mensagem: 'Sem permissão para cadastrar produtos.' }), async (req, res) => {

    const estabelecimentoId = req.params.id;

    const {
        nome,
        marca,
        codigo_barras,
        estoque_atual,
        estoque_minimo,
        preco_custo,
        preco_venda,
        categoria_id,
        unidade_medida,
        vendido_por_peso,
        plu_balanca,
        tem_variacoes,
        variacoes,
        imagem_url,
        imagem_origem,
    } = req.body;

    if (!nome || estoque_atual === undefined) {
        return res.status(400).json({ error: 'Nome e Estoque Atual são obrigatórios.' });
    }
    if (!precoVendaEhValido(preco_venda, tem_variacoes, variacoes)) {
        return res.status(400).json({ error: 'Informe o Preço de Venda do produto, ou defina um preço de venda próprio pra cada variação.' });
    }

    const erroTamanho = validarTamanhos(
        { nome, marca, codigo_barras },
        { nome: LIMITES.NOME_FANTASIA, marca: LIMITES.NOME, codigo_barras: LIMITES.CODIGO }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const erroLimite = await erroTeto(db, 'produtos', estabelecimentoId);
    if (erroLimite) return res.status(400).json({ error: erroLimite });

    const erroVariacoes = erroTamanhoVariacoes(Array.isArray(variacoes) ? variacoes : []) || (tem_variacoes === true || tem_variacoes === 'true' ? await erroAtributosVariacoes(estabelecimentoId, variacoes) : null);
    if (erroVariacoes) return res.status(400).json({ error: erroVariacoes });

    try {
        const erroCodigos = await erroCodigosEVariacoes(estabelecimentoId, null, codigo_barras, tem_variacoes, variacoes);
        if (erroCodigos) return res.status(409).json({ error: erroCodigos });
    } catch (e) {
        console.error('[ERRO] checagem de códigos (POST produto):', e.message);
    }

    // Nome/marca com palavra ofensiva nunca salva — evita vandalismo tanto
    // no cadastro local quanto no catálogo global (que esse produto pode
    // alimentar logo abaixo, se tiver código de barras). Fica registrado
    // na auditoria mesmo assim (rota /:id/produtos abaixo é só a criação),
    // pra dar pra ver quem tentou, quando, e o que tentou digitar.
    if (contemPalavraProibida(nome) || contemPalavraProibida(marca)) {
        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_bloqueado_palavra',
          descricao: `Tentativa de criar produto com nome/marca bloqueado por palavra proibida: "${nome}${marca ? ' · ' + marca : ''}"`,
          meta: { nome, marca: marca || null },
        });
        return res.status(400).json({ error: 'Nome ou marca contém uma palavra não permitida. Ajuste antes de salvar.' });
    }

    try {

        const { data, error } = await db
            .from('produtos')
            .insert({
                ...carimboCriacao(req),
                mercearia_id: estabelecimentoId,
                nome: nome,
                marca: marca || null,
                codigo_barras: codigo_barras || null,
                estoque_atual: parseFloat(estoque_atual) || 0,
                estoque_minimo: normalizarEstoqueMinimo(estoque_minimo),
                preco_custo: parseFloat(preco_custo) || 0,
                preco_venda: parseFloat(preco_venda) || 0,
                categoria_id: categoria_id || null,
                unidade_medida: unidade_medida || 'un',
                vendido_por_peso: vendido_por_peso === true || vendido_por_peso === 'true' || false,
                plu_balanca: plu_balanca || null,
                tem_variacoes: tem_variacoes === true || tem_variacoes === 'true' || false,
                imagem_url: imagem_url || null,
                imagem_origem: imagem_url ? (imagem_origem || null) : null,
            })
            .select()
            .single();

        if (error) throw error;

        // Cria as variações já na largada, se o produto nasceu com elas —
        // guarda o retorno (com os ids reais) na resposta, pra o front saber
        // pra qual linha subir foto logo em seguida, sem precisar recarregar.
        const ctxEstoque = { req, produto: { id: data.id, nome: data.nome, marca: data.marca, unidade_medida: data.unidade_medida } };

        // Estoque inicial entra no histórico de movimentações, como
        // qualquer outra entrada — o estoque nunca "aparece" sem registro.
        if ((parseFloat(data.estoque_atual) || 0) > 0) {
          await registrarMovimentacaoEstoque(ctxEstoque, {
            tipo: 'entrada', antes: 0, depois: parseFloat(data.estoque_atual),
            motivo: 'Estoque inicial — cadastro do produto',
            referencia_tipo: 'cadastro_produto',
          });
        }

        if ((tem_variacoes === true || tem_variacoes === 'true') && Array.isArray(variacoes) && variacoes.length > 0) {
          data.variacoes = await sincronizarVariacoes(data.id, estabelecimentoId, variacoes, ctxEstoque);
        }

        // Contribui pro catálogo global — próximo estabelecimento que
        // bipar esse mesmo código de barras já acha nome/marca prontos.
        // Imagem só vai junto se veio do catálogo/Open Food Facts — uma
        // foto própria do lojista nunca é compartilhada com outras lojas.
        // Código gerado internamente (faixa 20-29) nunca entra aqui — é
        // sequencial por estabelecimento, então o mesmo número aparece em
        // várias lojas com produtos totalmente diferentes.
        if (codigo_barras && !codigoNaFaixaInterna(codigo_barras)) {
          const imagemParaCatalogo = imagem_origem === 'upload' ? null : (imagem_url || null);
          salvarNoCatalogoGlobal(codigo_barras, nome, marca, 'colaborativo', imagemParaCatalogo);
        }

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_criado',
          descricao: `Produto "${nome}${marca ? ' · ' + marca : ''}" criado (estoque: ${fmtEstoque(estoque_atual, unidade_medida)})`,
          meta: { produto_id: data.id, depois: { nome, ...(marca ? { marca } : {}), preco_venda: parseFloat(preco_venda) || 0, estoque_atual: parseFloat(estoque_atual), unidade_medida } },
        });

        console.log(`[INFO] Novo produto adicionado: ${data.nome}`);
        res.status(201).json(data);

    } catch (error) {

        console.error(`[ERRO] POST /api/estabelecimentos/${estabelecimentoId}/produtos:`, error.message);
        const erroLimiteBanco = erroTetoDoBanco(error);
        if (erroLimiteBanco) return res.status(400).json({ error: erroLimiteBanco });
        res.status(500).json({ error: 'Erro ao adicionar produto.' });

    }
});


// --- Rota PUT /:id/produtos/:produtoId ---
router.put('/:id/produtos/:produtoId', verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR], { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {

    const { id: estabelecimentoId, produtoId } = req.params;

    const {
        nome,
        marca,
        codigo_barras,
        estoque_atual,
        estoque_minimo,
        preco_custo,
        preco_venda,
        categoria_id,
        unidade_medida,
        vendido_por_peso,
        plu_balanca,
        tem_variacoes,
        variacoes,
    } = req.body;

    if (!nome || estoque_atual === undefined) {
        return res.status(400).json({ error: 'Nome e Estoque Atual são obrigatórios.' });
    }
    if (!precoVendaEhValido(preco_venda, tem_variacoes, variacoes)) {
        return res.status(400).json({ error: 'Informe o Preço de Venda do produto, ou defina um preço de venda próprio pra cada variação.' });
    }

    const erroTamanho = validarTamanhos(
        { nome, marca, codigo_barras },
        { nome: LIMITES.NOME_FANTASIA, marca: LIMITES.NOME, codigo_barras: LIMITES.CODIGO }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    const erroVariacoes = erroTamanhoVariacoes(Array.isArray(variacoes) ? variacoes : []) || (tem_variacoes === true || tem_variacoes === 'true' ? await erroAtributosVariacoes(estabelecimentoId, variacoes) : null);
    if (erroVariacoes) return res.status(400).json({ error: erroVariacoes });

    try {
        const erroCodigos = await erroCodigosEVariacoes(estabelecimentoId, produtoId, codigo_barras, tem_variacoes, variacoes);
        if (erroCodigos) return res.status(409).json({ error: erroCodigos });
    } catch (e) {
        console.error('[ERRO] checagem de códigos (PUT produto):', e.message);
    }

    if (contemPalavraProibida(nome) || contemPalavraProibida(marca)) {
        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_bloqueado_palavra',
          descricao: `Tentativa de editar produto com nome/marca bloqueado por palavra proibida: "${nome}${marca ? ' · ' + marca : ''}"`,
          meta: { produto_id: produtoId, nome, marca: marca || null },
        });
        return res.status(400).json({ error: 'Nome ou marca contém uma palavra não permitida. Ajuste antes de salvar.' });
    }

    try {

        // Busca estado atual para registrar o antes
        const { data: produtoAtual } = await db
            .from('produtos')
            .select('nome, marca, preco_venda, preco_custo, estoque_atual, estoque_minimo, unidade_medida')
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .single();

        // Estoque de variação alterado na tela precisa de motivo (vai pro
        // histórico de movimentações) e não pode acontecer com o produto
        // em contagem de inventário.
        const motivoEstoque = String(req.body.motivo_estoque || '').trim().slice(0, 200);
        const temVar = tem_variacoes === true || tem_variacoes === 'true';
        const varAlteradas = temVar ? await variacoesComEstoqueAlterado(produtoId, variacoes) : [];
        if (varAlteradas.length > 0) {
            if (!motivoEstoque) {
                return res.status(400).json({ error: 'Informe o motivo da alteração de estoque das variações.', codigo: 'MOTIVO_ESTOQUE' });
            }
            if (await negarSeEmContagem(req, res, [produtoId], 'alterar o estoque')) return;
        }

        // O estoque do produto NÃO é alterado por esta rota: depois de
        // criado, ele só muda por venda, compra, ajuste de estoque (com
        // motivo) ou inventário. O valor que vem do formulário é o de
        // quando a tela foi aberta — gravá-lo de volta apagaria as vendas
        // feitas nesse meio-tempo.
        const updateData = {
            nome: nome,
            marca: marca || null,
            codigo_barras: codigo_barras || null,
            estoque_minimo: normalizarEstoqueMinimo(estoque_minimo),
            preco_custo: parseFloat(preco_custo) || 0,
            preco_venda: parseFloat(preco_venda) || 0,
            categoria_id: categoria_id || null,
            unidade_medida: unidade_medida || 'un',
            vendido_por_peso: vendido_por_peso === true || vendido_por_peso === 'true' || false,
            plu_balanca: plu_balanca || null,
            tem_variacoes: tem_variacoes === true || tem_variacoes === 'true' || false,
        };

        // imagem_url só é tocada se vier explicitamente no corpo — a
        // imagem tem rotas próprias de upload/remoção, então o form
        // geral de edição não precisa (nem deve) mexer nela sem querer.
        if ('imagem_url' in req.body) {
            updateData.imagem_url = req.body.imagem_url || null;
            updateData.imagem_origem = req.body.imagem_url ? (req.body.imagem_origem || null) : null;
        }

        const { data, error } = await db
            .from('produtos')
            .update({ ...updateData, ...carimboAlteracao(req) })
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Produto não encontrado.' });
        }

        // Sincroniza as variações com o que veio do formulário — se
        // desmarcou "tem variações", a lista enviada normalmente vem
        // vazia, e sincronizarVariacoes já cuida de desativar/remover
        // as que existiam antes. Guarda o retorno (ids reais) na resposta,
        // pra o front conseguir subir foto de uma variação recém-criada.
        data.variacoes = await sincronizarVariacoes(produtoId, estabelecimentoId, Array.isArray(variacoes) ? variacoes : [], {
          req, motivo: motivoEstoque,
          produto: { id: produtoId, nome: data.nome, marca: data.marca, unidade_medida: data.unidade_medida },
        });

        // Corrigir nome/marca na edição também atualiza o catálogo global
        // (diferente da criação, que só grava se ainda não existir) — assim
        // a correção pra português beneficia a próxima loja que bipar esse
        // código, em vez de ficar presa só nesse estabelecimento.
        if (codigo_barras) {
          atualizarCatalogoGlobal(codigo_barras, nome, marca);
        }

        const metaAntes = produtoAtual ? {
            nome:           produtoAtual.nome,
            ...(produtoAtual.marca ? { marca: produtoAtual.marca } : {}),
            preco_venda:    parseFloat(produtoAtual.preco_venda),
            preco_custo:    parseFloat(produtoAtual.preco_custo),
            estoque_atual:  parseFloat(produtoAtual.estoque_atual),
            estoque_minimo: normalizarEstoqueMinimo(produtoAtual.estoque_minimo),
            unidade_medida: produtoAtual.unidade_medida,
        } : null;

        const metaDepois = {
            nome,
            ...(marca ? { marca } : {}),
            preco_venda:    parseFloat(preco_venda) || 0,
            preco_custo:    parseFloat(preco_custo) || 0,
            estoque_atual:  parseFloat(data.estoque_atual) || 0,
            estoque_minimo: normalizarEstoqueMinimo(estoque_minimo),
            unidade_medida: unidade_medida || 'un',
        };

        // Só cita o estoque mínimo na descrição quando ele mudou
        const minimoMudou = metaAntes && metaAntes.estoque_minimo !== metaDepois.estoque_minimo;
        const textoMinimo = minimoMudou
          ? ` · estoque mínimo: ${fmtEstoqueMinimo(metaAntes.estoque_minimo, metaAntes.unidade_medida)} → ${fmtEstoqueMinimo(metaDepois.estoque_minimo, metaDepois.unidade_medida)}`
          : '';

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_editado',
          descricao: `Produto "${nome}${marca ? ' · ' + marca : ''}" atualizado (estoque: ${fmtEstoque(data.estoque_atual, unidade_medida)})${textoMinimo}`,
          meta: { produto_id: produtoId, antes: metaAntes, depois: metaDepois },
        });

        console.log(`[INFO] Produto atualizado: ${data.nome}`);
        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/estabelecimentos/.../produtos/${produtoId}:`, error.message);
        res.status(500).json({ error: 'Erro ao atualizar produto.' });

    }
});

// ── Fotos do produto e das variações (utils/fotosProduto.js) ─────────────────
// Principal (produtos.imagem_url) + 1 extra (produtos.imagem_extra_url, SQL 41) por produto,
// e 1 por variação. A imagem chega já comprimida pelo navegador (WebP/JPEG ≤ ~120 KB); o
// servidor recusa o que passar de 300 KB, confere o tipo real do arquivo e APAGA do Storage
// a foto antiga quando ela é trocada ou removida. Fica só nesta loja — nunca vai pro catálogo global.
const Fotos = require('../utils/fotosProduto');
const PERM_FOTO = [PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EDITAR];
const LIM_FOTO = limitarFrequencia('produto-foto', 60);
const MSG_SQL41 = 'Esta função ainda será liberada: falta atualizar o banco de dados. Avise o suporte.';

function auditarFoto(req, acao, descricao, meta) {
    registrar({
        mercearia_id: req.params.id,
        operador_id: req.user.role === 'operator' ? req.user.id : null,
        usuario_nome: req.user.nome, usuario_email: req.user.email,
        modulo: 'estoque', acao, descricao, meta,
    });
}

// Foto PRINCIPAL do produto
router.post('/:id/produtos/:produtoId/imagem', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    const img = Fotos.lerImagemBase64(req.body?.imagem_base64);
    if (img.erro) return res.status(400).json({ error: img.erro });
    try {
        const { data: produto } = await db.from('produtos').select('id, nome, imagem_url')
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).single();
        if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });

        const up = await Fotos.subirFoto({ pasta: `produtos/${estabelecimentoId}`, nomeBase: produtoId, buffer: img.buffer, tipo: img.tipo });
        if (up.erro) return res.status(400).json({ error: up.erro });

        const { data: atualizado, error } = await db.from('produtos')
            .update({ imagem_url: up.url, imagem_origem: 'upload', ...carimboAlteracao(req) })
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).select().single();
        if (error) throw error;

        await Fotos.apagarFoto(produto.imagem_url, estabelecimentoId); // não deixa a antiga órfã no Storage
        auditarFoto(req, 'produto_imagem_enviada', `Foto enviada pro produto "${produto.nome}"`, { produto_id: produtoId });
        res.status(200).json(atualizado);
    } catch (error) {
        console.error(`[ERRO] POST .../produtos/${produtoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao enviar imagem.' });
    }
});

router.delete('/:id/produtos/:produtoId/imagem', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    try {
        let { data: antes, error: eAntes } = await db.from('produtos').select('imagem_url, imagem_extra_url').eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        if (eAntes && eAntes.code === '42703') ({ data: antes } = await db.from('produtos').select('imagem_url').eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle());
        // Se existe a 2ª foto, ela vira a principal (o produto não fica sem foto na lista/PDV)
        const promover = antes?.imagem_extra_url || null;
        const novo = promover
            ? { imagem_url: promover, imagem_origem: 'upload', imagem_extra_url: null }
            : { imagem_url: null, imagem_origem: null };
        const { data, error } = await db.from('produtos')
            .update({ ...novo, ...carimboAlteracao(req) })
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Produto não encontrado.' });
        await Fotos.apagarFoto(antes?.imagem_url, estabelecimentoId);
        auditarFoto(req, 'produto_imagem_removida', `Foto removida do produto "${data.nome}"`, { produto_id: produtoId });
        res.status(200).json(data);
    } catch (error) {
        console.error(`[ERRO] DELETE .../produtos/${produtoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao remover imagem.' });
    }
});

// Foto EXTRA (a 2ª) do produto — só lida quando o produto é aberto para editar, não pesa na lista/PDV.
router.get('/:id/produtos/:produtoId/imagem-extra', async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    try {
        const { data, error } = await db.from('produtos').select('imagem_extra_url')
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        if (error) {
            if (error.code === '42703') return res.json({ imagem_extra_url: null, pronto: false }); // antes do SQL 41
            throw error;
        }
        res.json({ imagem_extra_url: data?.imagem_extra_url || null, pronto: true });
    } catch (error) {
        console.error('[ERRO] GET imagem-extra:', error.message);
        res.status(500).json({ error: 'Erro ao buscar a foto.' });
    }
});

router.post('/:id/produtos/:produtoId/imagem-extra', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    const img = Fotos.lerImagemBase64(req.body?.imagem_base64);
    if (img.erro) return res.status(400).json({ error: img.erro });
    try {
        const { data: produto, error: eLer } = await db.from('produtos').select('id, nome, imagem_extra_url')
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        if (eLer) {
            if (eLer.code === '42703') return res.status(503).json({ error: MSG_SQL41 });
            throw eLer;
        }
        if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });

        const up = await Fotos.subirFoto({ pasta: `produtos/${estabelecimentoId}`, nomeBase: `${produtoId}-extra`, buffer: img.buffer, tipo: img.tipo });
        if (up.erro) return res.status(400).json({ error: up.erro });

        const { error } = await db.from('produtos').update({ imagem_extra_url: up.url, ...carimboAlteracao(req) })
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId);
        if (error) throw error;

        await Fotos.apagarFoto(produto.imagem_extra_url, estabelecimentoId);
        auditarFoto(req, 'produto_imagem_enviada', `Segunda foto enviada pro produto "${produto.nome}"`, { produto_id: produtoId, extra: true });
        res.json({ imagem_extra_url: up.url });
    } catch (error) {
        console.error('[ERRO] POST imagem-extra:', error.message);
        res.status(500).json({ error: 'Erro ao enviar imagem.' });
    }
});

router.delete('/:id/produtos/:produtoId/imagem-extra', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    try {
        const { data: produto, error: eLer } = await db.from('produtos').select('nome, imagem_extra_url')
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        if (eLer) {
            if (eLer.code === '42703') return res.status(503).json({ error: MSG_SQL41 });
            throw eLer;
        }
        if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });
        const { error } = await db.from('produtos').update({ imagem_extra_url: null, ...carimboAlteracao(req) })
            .eq('id', produtoId).eq('mercearia_id', estabelecimentoId);
        if (error) throw error;
        await Fotos.apagarFoto(produto.imagem_extra_url, estabelecimentoId);
        auditarFoto(req, 'produto_imagem_removida', `Segunda foto removida do produto "${produto.nome}"`, { produto_id: produtoId, extra: true });
        res.json({ imagem_extra_url: null });
    } catch (error) {
        console.error('[ERRO] DELETE imagem-extra:', error.message);
        res.status(500).json({ error: 'Erro ao remover imagem.' });
    }
});

// Foto de uma VARIAÇÃO (ex.: a mesma camiseta em cores diferentes)
router.post('/:id/produtos/:produtoId/variacoes/:variacaoId/imagem', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId, variacaoId } = req.params;
    const img = Fotos.lerImagemBase64(req.body?.imagem_base64);
    if (img.erro) return res.status(400).json({ error: img.erro });
    try {
        const { data: variacao } = await db.from('produto_variacoes')
            .select('id, tamanho, cor, genero, imagem_url, produtos ( nome )')
            .eq('id', variacaoId).eq('produto_id', produtoId).eq('mercearia_id', estabelecimentoId).single();
        if (!variacao) return res.status(404).json({ error: 'Variação não encontrada.' });

        const up = await Fotos.subirFoto({ pasta: `produtos/${estabelecimentoId}/variacoes`, nomeBase: variacaoId, buffer: img.buffer, tipo: img.tipo });
        if (up.erro) return res.status(400).json({ error: up.erro });

        const { data: atualizado, error } = await db.from('produto_variacoes')
            .update({ imagem_url: up.url, imagem_origem: 'upload' })
            .eq('id', variacaoId).eq('produto_id', produtoId).eq('mercearia_id', estabelecimentoId).select().single();
        if (error) throw error;

        await Fotos.apagarFoto(variacao.imagem_url, estabelecimentoId);
        const labelVariacao = (await rotulosVariacao.rotulosPorId(estabelecimentoId, [variacaoId])).get(variacaoId) || [variacao.tamanho, variacao.cor, variacao.genero].filter(Boolean).join(' · ') || 'sem descrição';
        auditarFoto(req, 'variacao_imagem_enviada', `Foto enviada pra variação "${labelVariacao}" do produto "${variacao.produtos?.nome || 'Produto'}"`, { produto_id: produtoId, variacao_id: variacaoId });
        res.status(200).json(atualizado);
    } catch (error) {
        console.error(`[ERRO] POST .../variacoes/${variacaoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao enviar imagem.' });
    }
});

router.delete('/:id/produtos/:produtoId/variacoes/:variacaoId/imagem', LIM_FOTO, verificarPermissao(PERM_FOTO, { mensagem: 'Sem permissão para editar produtos.' }), async (req, res) => {
    const { id: estabelecimentoId, produtoId, variacaoId } = req.params;
    try {
        const { data: antes } = await db.from('produto_variacoes').select('imagem_url')
            .eq('id', variacaoId).eq('produto_id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
        const { data, error } = await db.from('produto_variacoes')
            .update({ imagem_url: null, imagem_origem: null })
            .eq('id', variacaoId).eq('produto_id', produtoId).eq('mercearia_id', estabelecimentoId).select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Variação não encontrada.' });
        await Fotos.apagarFoto(antes?.imagem_url, estabelecimentoId);
        const labelVariacao = (await rotulosVariacao.rotulosPorId(estabelecimentoId, [variacaoId])).get(variacaoId) || [data.tamanho, data.cor, data.genero].filter(Boolean).join(' · ') || 'sem descrição';
        auditarFoto(req, 'variacao_imagem_removida', `Foto removida da variação "${labelVariacao}"`, { produto_id: produtoId, variacao_id: variacaoId });
        res.status(200).json(data);
    } catch (error) {
        console.error(`[ERRO] DELETE .../variacoes/${variacaoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao remover imagem.' });
    }
});


// --- Rota DELETE /:id/produtos/:produtoId ---
router.delete('/:id/produtos/:produtoId', verificarPermissao([PERMISSOES.ESTOQUE, PERMISSOES.ESTOQUE_EXCLUIR], { mensagem: 'Sem permissão para excluir produtos.' }), async (req, res) => {

    const { id: estabelecimentoId, produtoId } = req.params;

    try {

        // Produto em contagem de inventário não pode ser excluído
        if (await negarSeEmContagem(req, res, [produtoId], 'excluir este produto')) return;

        // Guarda as fotos para apagar do Storage depois que o produto for excluído (sem deixar órfãs)
        let fotosParaApagar = [];
        try {
            let { data: pf, error: ef } = await db.from('produtos').select('imagem_url, imagem_extra_url').eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle();
            if (ef && ef.code === '42703') ({ data: pf } = await db.from('produtos').select('imagem_url').eq('id', produtoId).eq('mercearia_id', estabelecimentoId).maybeSingle());
            const { data: vf } = await db.from('produto_variacoes').select('imagem_url').eq('produto_id', produtoId).eq('mercearia_id', estabelecimentoId);
            fotosParaApagar = [pf?.imagem_url, pf?.imagem_extra_url, ...(vf || []).map(v => v.imagem_url)].filter(Boolean);
        } catch (e) { console.error('[FOTOS] não listou fotos do produto a excluir:', e.message); }

        const { data, error } = await db.rpc('deletar_produto', {
            p_produto_id: produtoId,
            p_mercearia_id: estabelecimentoId
        });

        if (error) {
            console.error(`[ERRO] DELETE produto:`, error.message);
            return res.status(500).json({ error: error.message });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'Produto não encontrado ou não pertence a este estabelecimento.' });
        }

        console.log(`[INFO] Produto excluído: ${data[0].nome}`);
        for (const u of fotosParaApagar) await require('../utils/fotosProduto').apagarFoto(u, estabelecimentoId);

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_excluido',
          descricao: `Produto "${data[0].nome}${data[0].marca ? ' · ' + data[0].marca : ''}" excluído`,
          meta: { produto_id: produtoId, antes: { nome: data[0].nome, ...(data[0].marca ? { marca: data[0].marca } : {}) } },
        });

        res.status(200).json({ message: 'Produto excluído com sucesso' });

    } catch (error) {

        console.error(`[ERRO] DELETE produto:`, error.message);
        return res.status(500).json({ error: 'Erro ao excluir produto.' });

    }
});


// --- ROTA BUSCAR PRODUTO (PDV) ---
router.get('/:id/produtos/buscar', async (req, res) => {

    const { id: estabelecimentoId } = req.params;
    const { termo } = req.query;

    if (!estabelecimentoId || !termo) {
        return res.status(400).json({ error: 'ID do estabelecimento e termo de busca são obrigatórios.' });
    }

    try {

        const { data, error } = await consultarComAtributos((comAtr) => db
            .from('produtos')
            .select(`
                id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                vendido_por_peso, plu_balanca, tem_variacoes, imagem_url,
                produto_variacoes ( id, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .or(`codigo_barras.eq.${termo},nome.ilike.${termo}%`)
            .limit(10));

        if (error) throw error;

        const comVariacoes = async (rows) => {
            const lista = (rows || []).map(p => ({
                ...p,
                variacoes: (p.produto_variacoes || []).filter(v => v.ativo),
            }));
            await anexarRotulos(estabelecimentoId, lista);
            return lista;
        };

        // Fallback por PLU, ignorando zeros à esquerda (ex: "18" == "0018")
        if ((!data || data.length === 0) && /^\d+$/.test(termo.trim())) {
            const termoNum = parseInt(termo.trim(), 10);
            const { data: candidatos } = await consultarComAtributos((comAtr) => db
                .from('produtos')
                .select(`
                    id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                    vendido_por_peso, plu_balanca, tem_variacoes, imagem_url,
                    produto_variacoes ( id, tamanho, cor, genero, ${comAtr ? 'atributos, ' : ''}codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
                `)
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500));

            const porPlu = (candidatos || []).filter(p => {
                const pluNum = parseInt(String(p.plu_balanca).trim(), 10);
                return !isNaN(pluNum) && pluNum === termoNum;
            });
            if (porPlu.length > 0) return res.status(200).json(await comVariacoes(porPlu));
        }

        res.status(200).json(await comVariacoes(data));

    } catch (error) {

        console.error(`[ERRO] Buscar produto PDV:`, error.message);
        return res.status(500).json({ error: 'Erro ao buscar produto.' });

    }
});

// ============================================================
// Rotas do módulo Configurações do painel do estabelecimento
// ============================================================

// GET /api/estabelecimentos/dados/:id
router.get('/dados/:id', async (req, res) => {
  try {
    const user = req.user;
    const mercearia_id = user.mercearia_id;

    if (!mercearia_id) {
      return res.status(403).json({ error: 'Usuário sem estabelecimento vinculado' });
    }

    const { data, error } = await db
      .from('mercearias')
      .select('*')
      .eq('id', mercearia_id)
      .single();

    if (error) return res.status(404).json({ error: 'Estabelecimento não encontrado' });

    // ── Auto-correção da licença: essa é a rota que o sistema de fato
    // usa (tela principal, Tela de Bloqueio e banner de renovação
    // pollam ela), diferente de /status/:userId que não é mais chamada
    // por lugar nenhum do frontend atual. Sem essa checagem aqui,
    // status_assinatura nunca vira "bloqueada" sozinho — só via ação
    // manual no SuperAdmin. Compara como DATA ('YYYY-MM-DD'), no fuso do
    // PRÓPRIO ESTABELECIMENTO — antes usava setHours(0,0,0,0), que
    // normaliza pra meia-noite no fuso do SERVIDOR (Railway roda em
    // UTC), não no do estabelecimento. Isso bloqueava o acesso até 3h
    // (ou mais, fora de Brasília) ANTES da hora certa, já na noite
    // anterior ao vencimento de verdade. Mesmo padrão já usado em
    // verificarVencimentos() (adminEstabelecimentosRoutes.js).
    let statusFinal = data.status_assinatura;
    if (data.data_vencimento && data.status_assinatura === 'ativa') {
      const hojeEstabelecimento = hojeStrTZ(data.timezone || TIMEZONE_PADRAO);
      if (data.data_vencimento < hojeEstabelecimento) {
        console.log(`[LICENÇA] Vencimento passou pra "${data.nome_fantasia}" — atualizando status_assinatura para 'bloqueada'.`);
        await db.from('mercearias').update({ status_assinatura: 'bloqueada' }).eq('id', mercearia_id);
        statusFinal = 'bloqueada';
      }
    }

    res.json({ ...data, status_assinatura: statusFinal });

  } catch (err) {
    console.error('[ERRO] GET /api/estabelecimentos/dados/:id', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/estabelecimentos/dados/:id/logo  { imagem_base64 }
// Envia a logo da loja pelo servidor. Antes a tela gravava direto no
// armazenamento (qualquer usuário logado conseguia enviar arquivo); agora
// quem confere a permissão é esta rota: o dono sempre pode, o operador só
// com Configurações + "Alterar logo".
router.post('/dados/:id/logo', async (req, res) => {
  try {
    const user = req.user;
    const mercearia_id = user.mercearia_id;
    if (user.role !== 'merchant' && user.role !== 'operator') {
      return res.status(403).json({ error: 'Apenas o dono do estabelecimento pode trocar a logo.' });
    }
    if (user.role === 'operator' && !temPermissao(req, [PERMISSOES.CONFIGURACOES, PERMISSOES.CONFIG_EDITAR_LOGO])) {
      return res.status(403).json({ error: 'Sem permissão para trocar a logo da loja.', codigo: 'SEM_PERMISSAO' });
    }

    const { imagem_base64 } = req.body || {};
    const match = typeof imagem_base64 === 'string' && imagem_base64.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (!match) return res.status(400).json({ error: 'Formato inválido. Use PNG, JPG ou WEBP.' });
    const extensao = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Arquivo muito grande. Tamanho máximo: 2MB.' });
    }

    const { data: antes } = await db.from('mercearias').select('logo_url').eq('id', mercearia_id).single();

    const nomeArquivo = `public/${mercearia_id}-${Date.now()}.${extensao}`;
    const { error: uploadErr } = await db.storage
      .from('logos')
      .upload(nomeArquivo, buffer, { upsert: true, contentType: `image/${extensao === 'jpg' ? 'jpeg' : extensao}`, cacheControl: '3600' });
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });

    const { data: urlData } = db.storage.from('logos').getPublicUrl(nomeArquivo);
    const logo_url = urlData.publicUrl;

    const { data, error } = await db.from('mercearias').update({ logo_url, ...carimboAlteracao(req) }).eq('id', mercearia_id).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Apaga o arquivo da logo anterior (só se for mesmo a logo desta loja)
    const antigo = String(antes?.logo_url || '').match(/\/logos\/(public\/[^?]+)/);
    if (antigo && antigo[1].startsWith(`public/${mercearia_id}`) && antigo[1] !== nomeArquivo) {
      db.storage.from('logos').remove([antigo[1]]).catch(() => {});
    }

    registrar({
      mercearia_id,
      operador_id:  user.role === 'operator' ? user.id : null,
      usuario_nome: user.nome,
      usuario_email: user.email,
      modulo: 'configuracoes', acao: 'config_atualizada',
      descricao: 'Logo alterada',
      meta: { campos: ['logo_url'], antes: { logo_url: antes?.logo_url ?? null }, depois: { logo_url } },
    });

    res.json({ success: true, logo_url, mercearia: data });
  } catch (err) {
    console.error('[ERRO] POST /api/estabelecimentos/dados/:id/logo', err);
    res.status(500).json({ error: 'Erro ao enviar a logo.' });
  }
});

// PUT /api/estabelecimentos/dados/:id
// Dono (merchant): edita tudo, como sempre.
// Operador com Configurações + "Alterar logo": pode enviar SOMENTE
// `logo_url`. Chave/modo do Pix, Fiado, nome, telefone e endereço são só
// do dono (a chave Pix decide para onde o dinheiro vai).
router.put('/dados/:id', async (req, res) => {
  try {
    const user = req.user;
    const ehOperador = user.role === 'operator';

    if (user.role !== 'merchant' && !ehOperador) {
      return res.status(403).json({ error: 'Apenas o dono do estabelecimento pode editar as configurações' });
    }
    if (ehOperador && !temPermissao(req, [PERMISSOES.CONFIGURACOES, PERMISSOES.CONFIG_EDITAR_LOGO])) {
      return res.status(403).json({ error: 'Sem permissão para trocar a logo da loja.', codigo: 'SEM_PERMISSAO' });
    }

    const mercearia_id = user.mercearia_id;

    if (!mercearia_id) {
      return res.status(403).json({ error: 'Usuário sem estabelecimento vinculado' });
    }

    const {
      nome_fantasia, telefone, endereco_completo, logo_url,
      pix_chave, pix_tipo_chave, pix_cidade, pix_modo,
      fiado_ativo,
    } = req.body;

    if (ehOperador) {
      const soDoDono = [nome_fantasia, telefone, endereco_completo, pix_chave, pix_tipo_chave, pix_cidade, pix_modo, fiado_ativo];
      if (soDoDono.some(v => v !== undefined)) {
        return res.status(403).json({ error: 'Só o dono da loja pode alterar esses dados.', codigo: 'SOMENTE_DONO' });
      }
      if (logo_url !== null && (typeof logo_url !== 'string' || !logo_url.trim())) {
        return res.status(400).json({ error: 'Envie a nova logo.' });
      }
    }

    const erroTamanho = validarTamanhos(
      { nome_fantasia, telefone, endereco_completo, pix_chave, pix_cidade },
      { nome_fantasia: LIMITES.NOME_FANTASIA, telefone: LIMITES.TELEFONE, endereco_completo: LIMITES.ENDERECO, pix_chave: 100, pix_cidade: 15 }
    );
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    // Busca os dados atuais ANTES de atualizar, pra comparar depois e
    // saber exatamente o que mudou (a auditoria genérica "dados
    // atualizados" não dizia nada de útil)
    const { data: antes } = await db
      .from('mercearias')
      .select('nome_fantasia, telefone, endereco_completo, logo_url, pix_chave, pix_tipo_chave, pix_cidade, pix_modo, fiado_ativo')
      .eq('id', mercearia_id)
      .single();

    // Operador: o update leva só a logo — nada mais entra, venha o que vier.
    const updateData = ehOperador
      ? { logo_url }
      : { nome_fantasia, telefone, endereco_completo, logo_url };

    // Campos de Pix só entram no update se vierem no corpo da requisição —
    // assim essa mesma rota continua funcionando pro upload de logo sem
    // precisar reenviar a config de Pix inteira toda vez.
    if (pix_chave       !== undefined) updateData.pix_chave      = pix_chave || null;
    if (pix_tipo_chave  !== undefined) updateData.pix_tipo_chave = pix_tipo_chave || null;
    if (pix_cidade      !== undefined) updateData.pix_cidade     = pix_cidade || null;
    if (pix_modo        !== undefined) {
      if (!['maquininha', 'sistema'].includes(pix_modo)) {
        return res.status(400).json({ error: 'pix_modo inválido.' });
      }
      updateData.pix_modo = pix_modo;
    }
    // Liga/desliga o módulo de Fiado — mesmo princípio: só mexe se vier
    // explicitamente no corpo da requisição.
    if (fiado_ativo !== undefined) updateData.fiado_ativo = !!fiado_ativo;

    const { data, error } = await db
      .from('mercearias')
      .update({ ...updateData, ...carimboAlteracao(req) })
      .eq('id', mercearia_id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Sincroniza profiles.nome com nome_fantasia para manter auditoria consistente
    // (só para o dono — o nome do operador nunca é trocado por aqui)
    if (nome_fantasia && !ehOperador) {
      await db
        .from('profiles')
        .update({ nome: nome_fantasia })
        .eq('id', user.id);
    }

    // Monta a descrição específica do que mudou, comparando com o que
    // tinha antes — em vez do genérico "dados atualizados" de sempre
    const mudancas = [];
    if (updateData.nome_fantasia !== undefined && updateData.nome_fantasia !== antes?.nome_fantasia) {
      mudancas.push(`Nome fantasia → "${updateData.nome_fantasia}"`);
    }
    if (updateData.telefone !== undefined && updateData.telefone !== antes?.telefone) {
      mudancas.push(`Telefone → ${updateData.telefone || '(vazio)'}`);
    }
    if (updateData.endereco_completo !== undefined && updateData.endereco_completo !== antes?.endereco_completo) {
      mudancas.push('Endereço alterado');
    }
    if (updateData.logo_url !== undefined && updateData.logo_url !== antes?.logo_url) {
      mudancas.push('Logo alterada');
    }
    const pixMudou =
      (updateData.pix_chave      !== undefined && updateData.pix_chave      !== antes?.pix_chave) ||
      (updateData.pix_tipo_chave !== undefined && updateData.pix_tipo_chave !== antes?.pix_tipo_chave) ||
      (updateData.pix_cidade     !== undefined && updateData.pix_cidade     !== antes?.pix_cidade) ||
      (updateData.pix_modo       !== undefined && updateData.pix_modo       !== antes?.pix_modo);
    if (pixMudou) mudancas.push('Configuração de Pix alterada');
    if (updateData.fiado_ativo !== undefined && updateData.fiado_ativo !== antes?.fiado_ativo) {
      mudancas.push(updateData.fiado_ativo ? 'Fiado ativado' : 'Fiado desativado');
    }

    const descricao = mudancas.length > 0
      ? mudancas.join(' · ')
      : 'Dados do estabelecimento atualizados (nenhum campo mudou de valor)';

    registrar({
      mercearia_id,
      operador_id:  ehOperador ? user.id : null,
      usuario_nome: user.nome || user.email,
      usuario_email: user.email,
      modulo: 'configuracoes', acao: 'config_atualizada',
      descricao,
      meta: ehOperador
        ? { campos: ['logo_url'], antes: { logo_url: antes?.logo_url ?? null }, depois: updateData }
        : { campos: Object.keys(req.body), antes, depois: updateData },
    });

    res.json({ success: true, mercearia: data });

  } catch (err) {
    console.error('[ERRO] PUT /api/estabelecimentos/dados/:id', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/estabelecimentos/:id/pix/gerar
// Gera Pix Copia-e-Cola + QR Code usando a CHAVE PIX DO PRÓPRIO
// ESTABELECIMENTO (padrão BR Code do Banco Central — não é Asaas,
// não passa pelo sistema, o dinheiro cai direto na conta do dono).
// Usado no PDV (venda) e no recebimento de fiado.
// ═══════════════════════════════════════════════════════════
router.post('/:id/pix/gerar', async (req, res) => {
  try {
    const { id: mercearia_id } = req.params;

    // Isolamento de tenant: só pode gerar Pix pro próprio estabelecimento
    if (req.user.mercearia_id !== mercearia_id) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { valor, descricao } = req.body;

    const valorNum = parseFloat(valor);
    if (isNaN(valorNum) || valorNum <= 0) {
      return res.status(400).json({ error: 'Valor inválido.' });
    }

    const { data: merc, error } = await db
      .from('mercearias')
      .select('nome_fantasia, pix_chave, pix_cidade')
      .eq('id', mercearia_id)
      .single();

    if (error || !merc) return res.status(404).json({ error: 'Estabelecimento não encontrado.' });

    if (!merc.pix_chave || !merc.pix_cidade) {
      return res.status(400).json({
        error: 'Chave Pix não configurada. Cadastre em Configurações → Pagamentos antes de usar o Pix pelo sistema.',
      });
    }

    const { QrCodePix } = require('qrcode-pix');

    const qrCodePix = QrCodePix({
      version:       '01',
      key:           merc.pix_chave,
      name:          (merc.nome_fantasia || 'Estabelecimento').slice(0, 25),
      city:          merc.pix_cidade.slice(0, 15),
      transactionId: `V${Date.now().toString().slice(-15)}`, // até 25 caracteres
      message:       (descricao || 'Venda').slice(0, 40),
      value:         valorNum,
    });

    const payload = qrCodePix.payload();
    const qrcode_base64 = await qrCodePix.base64();

    res.json({ payload, qrcode_base64 });

  } catch (err) {
    console.error('[PIX] Erro ao gerar cobrança:', err.message);
    res.status(500).json({ error: 'Erro ao gerar o Pix.' });
  }
});

module.exports = router;