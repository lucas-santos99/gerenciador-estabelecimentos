const express = require('express');
const db = require('../db/supabaseAdmin');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
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
            nome: mercearia.nome_fantasia,
            logo_url: mercearia.logo_url
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
router.post('/:id/produtos', async (req, res) => {

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
        unidade_medida
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
                unidade_medida: unidade_medida || 'un'
            })
            .select()
            .single();

        if (error) throw error;

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_criado',
          descricao: `Produto "${nome}" criado (estoque: ${fmtEstoque(estoque_atual, unidade_medida)})`,
          meta: { produto_id: data.id, depois: { nome, preco_venda: parseFloat(preco_venda), estoque_atual: parseFloat(estoque_atual), unidade_medida } },
        });

        console.log(`[INFO] Novo produto adicionado: ${data.nome}`);
        res.status(201).json(data);

    } catch (error) {

        console.error(`[ERRO] POST /api/estabelecimentos/${estabelecimentoId}/produtos:`, error.message);
        res.status(500).json({ error: 'Erro ao adicionar produto.' });

    }
});


// --- Rota PUT /:id/produtos/:produtoId ---
router.put('/:id/produtos/:produtoId', async (req, res) => {

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
        unidade_medida
    } = req.body;

    if (!nome || !preco_venda || estoque_atual === undefined) {
        return res.status(400).json({ error: 'Nome, Preço de Venda e Estoque Atual são obrigatórios.' });
    }

    try {

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
                unidade_medida: unidade_medida || 'un'
            })
            .eq('id', produtoId)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Produto não encontrado.' });
        }

        registrar({
          mercearia_id: estabelecimentoId,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_editado',
          descricao: `Produto "${nome}" atualizado (estoque: ${fmtEstoque(estoque_atual, unidade_medida)})`,
          meta: { produto_id: produtoId, depois: { nome, preco_venda: parseFloat(preco_venda), estoque_atual: parseFloat(estoque_atual), preco_custo: parseFloat(preco_custo), unidade_medida } },
        });

        console.log(`[INFO] Produto atualizado: ${data.nome}`);
        res.status(200).json(data);

    } catch (error) {

        console.error(`[ERRO] PUT /api/estabelecimentos/.../produtos/${produtoId}:`, error.message);
        res.status(500).json({ error: 'Erro ao atualizar produto.' });

    }
});


// --- Rota DELETE /:id/produtos/:produtoId ---
router.delete('/:id/produtos/:produtoId', async (req, res) => {

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
          descricao: `Produto "${data[0].nome}" excluído`,
          meta: { produto_id: produtoId, antes: { nome: data[0].nome } },
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
            .select('id, nome, marca, preco_venda, estoque_atual, unidade_medida, estoque_minimo')
            .eq('mercearia_id', estabelecimentoId)
            .or(`codigo_barras.eq.${termo},nome.ilike.${termo}%`)
            .limit(10);

        if (error) throw error;

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