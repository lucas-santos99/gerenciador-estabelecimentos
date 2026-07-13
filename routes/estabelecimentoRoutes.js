const express = require('express');
const db = require('../db/supabaseAdmin');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
const { verificarPermissao } = require('../middlewares/verificarPermissao');
const { PERMISSOES } = require('../utils/permissoes');
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
                .select('id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo, vendido_por_peso, plu_balanca, codigo_barras, categoria_id')
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500);

            if (errPlu) {
                console.error(`[ERRO] fallback PLU busca-global:`, errPlu.message);
            } else {
                const porPlu = (candidatos || []).filter(p => {
                    const pluNum = parseInt(String(p.plu_balanca).trim(), 10);
                    return !isNaN(pluNum) && pluNum === termoNum;
                });
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
            .select('id, nome_fantasia, status_assinatura, data_vencimento, logo_url')
            .eq('id', userId)
            .single();

        if (error || !mercearia) {
            return res.status(404).json({ error: 'Estabelecimento não encontrado.' });
        }

        let statusFinal = mercearia.status_assinatura;

        const dataVencimento = mercearia.data_vencimento ? new Date(mercearia.data_vencimento) : null;
        const hoje = new Date();

        if (dataVencimento && dataVencimento < hoje && mercearia.status_assinatura === 'ativa') {

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
                categorias ( nome )
            `)
            .eq('mercearia_id', estabelecimentoId)
            .order('nome', { ascending: true });

        if (error) throw error;

        const produtosFormatados = data.map(p => ({
            ...p,
            nome_categoria: p.categorias ? p.categorias.nome : null
        }));

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

// Consulta a Open Food Facts (API pública, gratuita, sem chave).
// Retorna { nome, marca } ou null se não encontrar.
async function consultarOpenFoodFacts(codigo) {
  try {
    const resp = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json?fields=product_name,brands`,
      { headers: { 'User-Agent': 'GerenciadorEstabelecimentos - LucasJSystems - contato via app' } }
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== 1 || !json.product) return null;

    const nome  = (json.product.product_name || '').trim();
    const marca = (json.product.brands || '').split(',')[0].trim();
    if (!nome) return null;

    return { nome, marca: marca || null };
  } catch (err) {
    console.error('[CATALOGO] Erro consultar Open Food Facts:', err.message);
    return null;
  }
}

// Salva/atualiza o catálogo global — usado tanto pelo fallback do Open Food
// Facts quanto pelo cadastro manual de produtos (contribuição colaborativa).
async function salvarNoCatalogoGlobal(codigo_barras, nome, marca, fonte = 'colaborativo') {
  if (!codigo_barras || !nome) return;
  try {
    await db.from('catalogo_global_produtos').upsert({
      codigo_barras,
      nome,
      marca: marca || null,
      fonte,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'codigo_barras' });
  } catch (err) {
    console.error('[CATALOGO] Erro salvar no catálogo global:', err.message);
  }
}

// --- Rota GET: /:id/produtos/lookup-codigo?codigo=EAN ---
// Usada no cadastro de produto novo pra auto-preencher nome/marca.
// Ordem: 1) catálogo global (grátis, instantâneo) → 2) Open Food Facts
// (grátis, externo — e já contribui de volta pro catálogo global).
router.get('/:id/produtos/lookup-codigo', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo || !codigo.trim()) {
    return res.status(400).json({ error: 'Código de barras é obrigatório.' });
  }
  const codigoLimpo = codigo.trim();

  try {
    // 1) Catálogo global compartilhado
    const { data: doCatalogo } = await db
      .from('catalogo_global_produtos')
      .select('nome, marca')
      .eq('codigo_barras', codigoLimpo)
      .maybeSingle();

    if (doCatalogo) {
      return res.json({ encontrado: true, nome: doCatalogo.nome, marca: doCatalogo.marca, fonte: 'catalogo' });
    }

    // 2) Open Food Facts (fallback externo, gratuito)
    const doOff = await consultarOpenFoodFacts(codigoLimpo);
    if (doOff) {
      await salvarNoCatalogoGlobal(codigoLimpo, doOff.nome, doOff.marca, 'openfoodfacts');
      return res.json({ encontrado: true, nome: doOff.nome, marca: doOff.marca, fonte: 'openfoodfacts' });
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
        plu_balanca
    } = req.body;

    if (!nome || !preco_venda || estoque_atual === undefined) {
        return res.status(400).json({ error: 'Nome, Preço de Venda e Estoque Atual são obrigatórios.' });
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
                preco_venda: parseFloat(preco_venda),
                categoria_id: categoria_id || null,
                unidade_medida: unidade_medida || 'un',
                vendido_por_peso: vendido_por_peso === true || vendido_por_peso === 'true' || false,
                plu_balanca: plu_balanca || null,
            })
            .select()
            .single();

        if (error) throw error;

        // Contribui pro catálogo global — próximo estabelecimento que
        // bipar esse mesmo código de barras já acha nome/marca prontos
        if (codigo_barras) {
          salvarNoCatalogoGlobal(codigo_barras, nome, marca, 'colaborativo');
        }

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_criado',
          descricao: `Produto "${nome}${marca ? ' · ' + marca : ''}" criado (estoque: ${fmtEstoque(estoque_atual, unidade_medida)})`,
          meta: { produto_id: data.id, depois: { nome, ...(marca ? { marca } : {}), preco_venda: parseFloat(preco_venda), estoque_atual: parseFloat(estoque_atual), unidade_medida } },
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
        plu_balanca
    } = req.body;

    if (!nome || !preco_venda || estoque_atual === undefined) {
        return res.status(400).json({ error: 'Nome, Preço de Venda e Estoque Atual são obrigatórios.' });
    }

    try {

        // Busca estado atual para registrar o antes
        const { data: produtoAtual } = await db
            .from('produtos')
            .select('nome, marca, preco_venda, preco_custo, estoque_atual, estoque_minimo, unidade_medida')
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .single();

        const { data, error } = await db
            .from('produtos')
            .update({
                nome: nome,
                marca: marca || null,
                codigo_barras: codigo_barras || null,
                estoque_atual: parseFloat(estoque_atual) || 0,
                estoque_minimo: parseFloat(estoque_minimo) || 10,
                preco_custo: parseFloat(preco_custo) || 0,
                preco_venda: parseFloat(preco_venda),
                categoria_id: categoria_id || null,
                unidade_medida: unidade_medida || 'un',
                vendido_por_peso: vendido_por_peso === true || vendido_por_peso === 'true' || false,
                plu_balanca: plu_balanca || null,
            })
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Produto não encontrado.' });
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
            preco_venda:    parseFloat(preco_venda),
            preco_custo:    parseFloat(preco_custo),
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
            .select('id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo, vendido_por_peso, plu_balanca')
            .eq('mercearia_id', estabelecimentoId)
            .or(`codigo_barras.eq.${termo},nome.ilike.${termo}%`)
            .limit(10);

        if (error) throw error;

        // Fallback por PLU, ignorando zeros à esquerda (ex: "18" == "0018")
        if ((!data || data.length === 0) && /^\d+$/.test(termo.trim())) {
            const termoNum = parseInt(termo.trim(), 10);
            const { data: candidatos } = await db
                .from('produtos')
                .select('id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo, vendido_por_peso, plu_balanca')
                .eq('mercearia_id', estabelecimentoId)
                .not('plu_balanca', 'is', null)
                .limit(500);

            const porPlu = (candidatos || []).filter(p => {
                const pluNum = parseInt(String(p.plu_balanca).trim(), 10);
                return !isNaN(pluNum) && pluNum === termoNum;
            });
            if (porPlu.length > 0) return res.status(200).json(porPlu);
        }

        res.status(200).json(data);

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

    res.json(data);

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

    const { nome_fantasia, telefone, endereco_completo, logo_url } = req.body;

    const { data, error } = await db
      .from('mercearias')
      .update({ nome_fantasia, telefone, endereco_completo, logo_url })
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

    registrar({
      mercearia_id,
      operador_id:  null,
      usuario_nome: user.nome || user.email,
      usuario_email: user.email,
      modulo: 'configuracoes', acao: 'config_atualizada',
      descricao: `Dados do estabelecimento atualizados`,
      meta: { campos: Object.keys(req.body) },
    });

    res.json({ success: true, mercearia: data });

  } catch (err) {
    console.error('[ERRO] PUT /api/estabelecimentos/dados/:id', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;