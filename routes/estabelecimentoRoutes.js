const express = require('express');
const db = require('../db/supabaseAdmin');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
const { TIMEZONE_PADRAO, hojeStrTZ } = require('../utils/fusoHorario');
const { contemPalavraProibida } = require('../utils/filtroPalavroes');

// Sincroniza a lista de variações (tamanho/cor) de um produto com o que
// veio do formulário — cria as novas, atualiza as existentes, e remove
// (ou só desativa, se já apareceu numa venda) as que sumiram da lista.
async function sincronizarVariacoes(produtoId, mercearia_id, variacoesEnviadas = []) {
  const { data: existentes } = await db
    .from('produto_variacoes')
    .select('id')
    .eq('produto_id', produtoId)
    .eq('ativo', true);

  const idsExistentes = new Set((existentes || []).map(v => v.id));
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
      const { data: linha } = await db.from('produto_variacoes').update(payload).eq('id', v.id).select().single();
      if (linha) resultado.push(linha);
    } else {
      const { data: linha } = await db.from('produto_variacoes').insert(payload).select().single();
      if (linha) resultado.push(linha);
    }
  }

  // Salva valores novos digitados como sugestão pra próxima vez (só se
  // ainda não existir esse valor pra esse tipo, nesse estabelecimento)
  const novosPresets = [];
  variacoesEnviadas.forEach(v => {
    if (v.tamanho?.trim()) novosPresets.push({ tipo: 'tamanho', valor: v.tamanho.trim() });
    if (v.cor?.trim())     novosPresets.push({ tipo: 'cor',     valor: v.cor.trim() });
    if (v.genero?.trim())  novosPresets.push({ tipo: 'genero',  valor: v.genero.trim() });
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

        // Fallback: se não achou por nome/código de barras, tenta por PLU
        // da balança — permite digitar o PLU manualmente no PDV quando a
        // balança está fora do ar, puxando o produto igual ao código de barras.
        // PLU costuma ter zeros à esquerda (ex: "0018"), então comparamos
        // o valor numérico, não a string exata — "18", "018" e "0018" batem
        // com o mesmo produto.
        if ((!data || data.length === 0) && /^\d+$/.test(termo.trim())) {
            const termoNum = parseInt(termo.trim(), 10);

            const { data: candidatos, error: errPlu } = await db
                .from('produtos')
                .select(`
                    id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                    vendido_por_peso, plu_balanca, codigo_barras, categoria_id, tem_variacoes, imagem_url,
                    produto_variacoes ( id, tamanho, cor, genero, codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
                `)
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500);

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
                if (porPlu.length > 0) return res.status(200).json(porPlu);
            }
        }

        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] GET /api/estabelecimentos/${estabelecimentoId}/produtos/buscar-global:`, error.message);
        return res.status(500).json({ error: 'Erro ao buscar produto (global).' });
    }
});


// --- Rota GET: /status/:userId ---
router.get('/status/:userId', async (req, res) => {

    const { userId } = req.params;

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
        if (comId) {
            return res.status(200).json({
                tamanho: (data || []).filter(o => o.tipo === 'tamanho').map(o => ({ id: o.id, valor: o.valor })),
                cor:     (data || []).filter(o => o.tipo === 'cor').map(o => ({ id: o.id, valor: o.valor })),
                genero:  (data || []).filter(o => o.tipo === 'genero').map(o => ({ id: o.id, valor: o.valor })),
            });
        }

        res.status(200).json({
            tamanho: (data || []).filter(o => o.tipo === 'tamanho').map(o => o.valor),
            cor:     (data || []).filter(o => o.tipo === 'cor').map(o => o.valor),
            genero:  (data || []).filter(o => o.tipo === 'genero').map(o => o.valor),
        });
    } catch (error) {
        console.error(`[ERRO] GET /:id/opcoes-variacao:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar opções de variação.' });
    }
});

// --- Rota POST: /:id/opcoes-variacao — adiciona um preset manualmente
// (a tela de gerenciar usa essa; a criação "automática" ao digitar um
// valor novo numa variação usa upsert direto, dentro de sincronizarVariacoes) ---
router.post('/:id/opcoes-variacao', async (req, res) => {
    const estabelecimentoId = req.params.id;
    const { tipo, valor } = req.body;

    if (!['tamanho', 'cor', 'genero'].includes(tipo)) {
        return res.status(400).json({ error: "Tipo inválido (use 'tamanho', 'cor' ou 'genero')." });
    }
    if (!valor || !valor.trim()) {
        return res.status(400).json({ error: 'Informe um valor.' });
    }

    try {
        const { data, error } = await db
            .from('opcoes_variacao')
            .insert({ mercearia_id: estabelecimentoId, tipo, valor: valor.trim() })
            .select()
            .single();

        if (error) {
            if (error.code === '23505') return res.status(409).json({ error: 'Esse valor já está cadastrado.' });
            throw error;
        }

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
router.delete('/:id/opcoes-variacao/:optId', async (req, res) => {
    const { id: estabelecimentoId, optId } = req.params;
    try {
        const { error } = await db
            .from('opcoes_variacao')
            .delete()
            .eq('id', optId)
            .eq('mercearia_id', estabelecimentoId);

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (error) {
        console.error(`[ERRO] DELETE /:id/opcoes-variacao/:optId:`, error.message);
        res.status(500).json({ error: 'Erro ao remover opção.' });
    }
});

router.get('/:id/produtos', async (req, res) => {

    const estabelecimentoId = req.params.id;

    if (!estabelecimentoId) {
        return res.status(400).json({ error: 'ID do estabelecimento é obrigatório.' });
    }

    try {

        const { data, error } = await db
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
                categorias ( nome ),
                produto_variacoes ( id, tamanho, cor, genero, codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, imagem_url, imagem_origem, ativo )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .order('nome', { ascending: true });

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
  const { data, error } = await db.rpc('incrementar_codigo_interno_seq', { p_mercearia_id: mercearia_id });
  if (error) throw error;
  const seq = data; // já vem incrementado
  const corpo = `20${String(seq).padStart(10, '0')}`;
  const digito = calcularDigitoVerificadorEAN13(corpo);
  return `${corpo}${digito}`;
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
router.get('/:id/produtos/gerar-codigo-interno', verificarPermissao(PERMISSOES.ESTOQUE_ADICIONAR), async (req, res) => {
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
      // Já grava no catálogo global o nome final (traduzido, se foi o caso)
      // — a próxima loja que bipar esse código pega direto do catálogo,
      // sem precisar traduzir de novo.
      await salvarNoCatalogoGlobal(codigoLimpo, doOff.nome, doOff.marca, 'openfoodfacts', doOff.imagem_url);
      return res.json({
        encontrado: true,
        nome: doOff.nome,
        marca: doOff.marca,
        imagem_url: doOff.imagem_url,
        fonte: 'openfoodfacts',
        traduzido: !!doOff.traduzido,
      });
    }

    // 3) Open Products Facts (fallback externo, gratuito — produtos em geral)
    const doOpf = await consultarOpenProductsFacts(codigoLimpo);
    if (doOpf) {
      await salvarNoCatalogoGlobal(codigoLimpo, doOpf.nome, doOpf.marca, 'openproductsfacts', doOpf.imagem_url);
      return res.json({
        encontrado: true,
        nome: doOpf.nome,
        marca: doOpf.marca,
        imagem_url: doOpf.imagem_url,
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



router.post('/:id/produtos', verificarPermissao(PERMISSOES.ESTOQUE_ADICIONAR), async (req, res) => {

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
                mercearia_id: estabelecimentoId,
                nome: nome,
                marca: marca || null,
                codigo_barras: codigo_barras || null,
                estoque_atual: parseFloat(estoque_atual) || 0,
                estoque_minimo: parseFloat(estoque_minimo) || 10,
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
        if ((tem_variacoes === true || tem_variacoes === 'true') && Array.isArray(variacoes) && variacoes.length > 0) {
          data.variacoes = await sincronizarVariacoes(data.id, estabelecimentoId, variacoes);
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
        res.status(500).json({ error: 'Erro ao adicionar produto.' });

    }
});


// --- Rota PUT /:id/produtos/:produtoId ---
router.put('/:id/produtos/:produtoId', verificarPermissao(PERMISSOES.ESTOQUE_EDITAR), async (req, res) => {

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

        const updateData = {
            nome: nome,
            marca: marca || null,
            codigo_barras: codigo_barras || null,
            estoque_atual: parseFloat(estoque_atual) || 0,
            estoque_minimo: parseFloat(estoque_minimo) || 10,
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
            .update(updateData)
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
        data.variacoes = await sincronizarVariacoes(produtoId, estabelecimentoId, Array.isArray(variacoes) ? variacoes : []);

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
            estoque_minimo: parseFloat(produtoAtual.estoque_minimo),
            unidade_medida: produtoAtual.unidade_medida,
        } : null;

        const metaDepois = {
            nome,
            ...(marca ? { marca } : {}),
            preco_venda:    parseFloat(preco_venda) || 0,
            preco_custo:    parseFloat(preco_custo) || 0,
            estoque_atual:  parseFloat(estoque_atual),
            estoque_minimo: parseFloat(estoque_minimo),
            unidade_medida: unidade_medida || 'un',
        };

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_editado',
          descricao: `Produto "${nome}${marca ? ' · ' + marca : ''}" atualizado (estoque: ${fmtEstoque(estoque_atual, unidade_medida)})`,
          meta: { produto_id: produtoId, antes: metaAntes, depois: metaDepois },
        });

        console.log(`[INFO] Produto atualizado: ${data.nome}`);
        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/estabelecimentos/.../produtos/${produtoId}:`, error.message);
        res.status(500).json({ error: 'Erro ao atualizar produto.' });

    }
});

// --- Rota POST: /:id/produtos/:produtoId/imagem — foto própria do lojista ---
// Recebe a imagem já comprimida pelo navegador (canvas, ~400x400px) como
// data URL base64. Fica só nesse estabelecimento — nunca vai pro catálogo
// global (diferente da imagem sugerida do Open Food Facts/catálogo).
router.post('/:id/produtos/:produtoId/imagem', verificarPermissao(PERMISSOES.ESTOQUE_EDITAR), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    const { imagem_base64 } = req.body;

    if (!imagem_base64 || !imagem_base64.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Envie uma imagem válida.' });
    }

    try {
        const { data: produto } = await db
            .from('produtos')
            .select('id')
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .single();
        if (!produto) return res.status(404).json({ error: 'Produto não encontrado.' });

        const match = imagem_base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'Formato de imagem inválido.' });
        const [, extensao, base64Puro] = match;
        const buffer = Buffer.from(base64Puro, 'base64');

        // Limite de segurança — a compressão no navegador já deveria
        // deixar bem menor que isso, mas evita abuso/erro de implementação
        if (buffer.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Imagem muito grande (máx. 2MB).' });
        }

        const nomeArquivo = `produtos/${estabelecimentoId}/${produtoId}-${Date.now()}.${extensao}`;
        const { error: uploadErr } = await db.storage
            .from('logos')
            .upload(nomeArquivo, buffer, { upsert: true, contentType: `image/${extensao}` });
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });

        const { data: urlData } = db.storage.from('logos').getPublicUrl(nomeArquivo);
        const url = urlData.publicUrl;

        const { data: atualizado, error } = await db
            .from('produtos')
            .update({ imagem_url: url, imagem_origem: 'upload' })
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();
        if (error) throw error;

        res.status(200).json(atualizado);
    } catch (error) {
        console.error(`[ERRO] POST .../produtos/${produtoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao enviar imagem.' });
    }
});

// --- Rota DELETE: /:id/produtos/:produtoId/imagem — remove a imagem atual ---
// Volta pro estado "sem imagem" — o lojista pode buscar a sugestão de
// novo depois, se quiser.
router.delete('/:id/produtos/:produtoId/imagem', verificarPermissao(PERMISSOES.ESTOQUE_EDITAR), async (req, res) => {
    const { id: estabelecimentoId, produtoId } = req.params;
    try {
        const { data, error } = await db
            .from('produtos')
            .update({ imagem_url: null, imagem_origem: null })
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Produto não encontrado.' });
        res.status(200).json(data);
    } catch (error) {
        console.error(`[ERRO] DELETE .../produtos/${produtoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao remover imagem.' });
    }
});

// --- Rota POST: /:id/produtos/:produtoId/variacoes/:variacaoId/imagem ---
// Foto própria de uma variação específica (ex: a mesma camiseta em cores
// diferentes) — mesma lógica da imagem do produto, mas por variação.
router.post('/:id/produtos/:produtoId/variacoes/:variacaoId/imagem', verificarPermissao(PERMISSOES.ESTOQUE_EDITAR), async (req, res) => {
    const { id: estabelecimentoId, produtoId, variacaoId } = req.params;
    const { imagem_base64 } = req.body;

    if (!imagem_base64 || !imagem_base64.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Envie uma imagem válida.' });
    }

    try {
        const { data: variacao } = await db
            .from('produto_variacoes')
            .select('id')
            .eq('id', variacaoId)
            .eq('produto_id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .single();
        if (!variacao) return res.status(404).json({ error: 'Variação não encontrada.' });

        const match = imagem_base64.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'Formato de imagem inválido.' });
        const [, extensao, base64Puro] = match;
        const buffer = Buffer.from(base64Puro, 'base64');

        if (buffer.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Imagem muito grande (máx. 2MB).' });
        }

        const nomeArquivo = `produtos/${estabelecimentoId}/variacoes/${variacaoId}-${Date.now()}.${extensao}`;
        const { error: uploadErr } = await db.storage
            .from('logos')
            .upload(nomeArquivo, buffer, { upsert: true, contentType: `image/${extensao}` });
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });

        const { data: urlData } = db.storage.from('logos').getPublicUrl(nomeArquivo);
        const url = urlData.publicUrl;

        const { data: atualizado, error } = await db
            .from('produto_variacoes')
            .update({ imagem_url: url, imagem_origem: 'upload' })
            .eq('id', variacaoId)
            .eq('produto_id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();
        if (error) throw error;

        res.status(200).json(atualizado);
    } catch (error) {
        console.error(`[ERRO] POST .../variacoes/${variacaoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao enviar imagem.' });
    }
});

// --- Rota DELETE: /:id/produtos/:produtoId/variacoes/:variacaoId/imagem ---
router.delete('/:id/produtos/:produtoId/variacoes/:variacaoId/imagem', verificarPermissao(PERMISSOES.ESTOQUE_EDITAR), async (req, res) => {
    const { id: estabelecimentoId, produtoId, variacaoId } = req.params;
    try {
        const { data, error } = await db
            .from('produto_variacoes')
            .update({ imagem_url: null, imagem_origem: null })
            .eq('id', variacaoId)
            .eq('produto_id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Variação não encontrada.' });
        res.status(200).json(data);
    } catch (error) {
        console.error(`[ERRO] DELETE .../variacoes/${variacaoId}/imagem:`, error.message);
        res.status(500).json({ error: 'Erro ao remover imagem.' });
    }
});


// --- Rota DELETE /:id/produtos/:produtoId ---
router.delete('/:id/produtos/:produtoId', verificarPermissao(PERMISSOES.ESTOQUE_EXCLUIR), async (req, res) => {

    const { id: estabelecimentoId, produtoId } = req.params;

    try {

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

        const { data, error } = await db
            .from('produtos')
            .select(`
                id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                vendido_por_peso, plu_balanca, tem_variacoes, imagem_url,
                produto_variacoes ( id, tamanho, cor, genero, codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .or(`codigo_barras.eq.${termo},nome.ilike.${termo}%`)
            .limit(10);

        if (error) throw error;

        const comVariacoes = (rows) => (rows || []).map(p => ({
            ...p,
            variacoes: (p.produto_variacoes || []).filter(v => v.ativo),
        }));

        // Fallback por PLU, ignorando zeros à esquerda (ex: "18" == "0018")
        if ((!data || data.length === 0) && /^\d+$/.test(termo.trim())) {
            const termoNum = parseInt(termo.trim(), 10);
            const { data: candidatos } = await db
                .from('produtos')
                .select(`
                    id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo,
                    vendido_por_peso, plu_balanca, tem_variacoes, imagem_url,
                    produto_variacoes ( id, tamanho, cor, genero, codigo_barras, preco_custo, preco_venda, estoque_atual, estoque_minimo, ativo )
                `)
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500);

            const porPlu = (candidatos || []).filter(p => {
                const pluNum = parseInt(String(p.plu_balanca).trim(), 10);
                return !isNaN(pluNum) && pluNum === termoNum;
            });
            if (porPlu.length > 0) return res.status(200).json(comVariacoes(porPlu));
        }

        res.status(200).json(comVariacoes(data));

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
    // manual no SuperAdmin. Comparação por meia-noite normalizada,
    // mesmo padrão já usado no resto do sistema (evita depender da
    // hora do dia em que a checagem roda).
    let statusFinal = data.status_assinatura;
    if (data.data_vencimento && data.status_assinatura === 'ativa') {
      const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
      const venc = new Date(data.data_vencimento + 'T12:00:00'); venc.setHours(0, 0, 0, 0);
      if (venc < hoje) {
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

// PUT /api/estabelecimentos/dados/:id — somente merchant pode editar
router.put('/dados/:id', async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== 'merchant') {
      return res.status(403).json({ error: 'Apenas o dono do estabelecimento pode editar as configurações' });
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

    // Busca os dados atuais ANTES de atualizar, pra comparar depois e
    // saber exatamente o que mudou (a auditoria genérica "dados
    // atualizados" não dizia nada de útil)
    const { data: antes } = await db
      .from('mercearias')
      .select('nome_fantasia, telefone, endereco_completo, logo_url, pix_chave, pix_tipo_chave, pix_cidade, pix_modo, fiado_ativo')
      .eq('id', mercearia_id)
      .single();

    const updateData = { nome_fantasia, telefone, endereco_completo, logo_url };

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
      .update(updateData)
      .eq('id', mercearia_id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Sincroniza profiles.nome com nome_fantasia para manter auditoria consistente
    if (nome_fantasia) {
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
      operador_id:  null,
      usuario_nome: user.nome || user.email,
      usuario_email: user.email,
      modulo: 'configuracoes', acao: 'config_atualizada',
      descricao,
      meta: { campos: Object.keys(req.body), antes, depois: updateData },
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