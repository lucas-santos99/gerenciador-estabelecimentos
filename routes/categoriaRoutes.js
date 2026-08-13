const express = require('express');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');
const supabaseAdmin = require('../db/supabaseAdmin');
const { registrar } = require('./auditoriaRoutes');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');

router.use(authUser);

// --- Rota GET: Buscar categorias ---
// Retorna a lista plana (com categoria_pai_id) — o front monta a árvore
// de exibição agrupando por pai.
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('categorias')
            .select('id, nome, categoria_pai_id')
            .eq('mercearia_id', req.user.mercearia_id)
            .order('nome', { ascending: true });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {
        console.error('[ERRO] GET /api/categorias:', error.message);
        res.status(500).json({ error: 'Erro ao buscar categorias.' });
    }
});

// --- Rota POST: Criar categoria (ou subcategoria) ---
router.post('/', async (req, res) => {
    const { nome, categoria_pai_id } = req.body;

    if (!nome) {
        return res.status(400).json({ error: 'Nome da categoria é obrigatório.' });
    }

    const erroTamanho = validarTamanhos({ nome }, { nome: LIMITES.CATEGORIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    try {
        let paiIdFinal = null;

        if (categoria_pai_id) {
            // Só permite 1 nível: a categoria-pai escolhida precisa ser ela
            // mesma uma categoria PRINCIPAL (sem pai) — senão viraria neto,
            // que não é o desenho aqui.
            const { data: pai, error: errPai } = await supabaseAdmin
                .from('categorias')
                .select('id, categoria_pai_id')
                .eq('id', categoria_pai_id)
                .eq('mercearia_id', req.user.mercearia_id)
                .single();

            if (errPai || !pai) {
                return res.status(400).json({ error: 'Categoria principal não encontrada.' });
            }
            if (pai.categoria_pai_id) {
                return res.status(400).json({ error: 'Só é permitido um nível de subcategoria — escolha uma categoria principal, não outra subcategoria.' });
            }
            paiIdFinal = categoria_pai_id;
        }

        const { data, error } = await supabaseAdmin
            .from('categorias')
            .insert({ nome, mercearia_id: req.user.mercearia_id, categoria_pai_id: paiIdFinal })
            .select()
            .single();

        if (error) throw error;

        console.log(`[INFO] Nova categoria criada: ${data.nome}`);
        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_criado',
          descricao: paiIdFinal ? `Subcategoria "${data.nome}" criada` : `Categoria "${data.nome}" criada`,
          meta: { categoria_id: data.id, categoria_pai_id: paiIdFinal },
        });
        res.status(201).json(data);

    } catch (error) {
        console.error('[ERRO] POST /api/categorias:', error.message);

        if (error.code === '23505') {
            return res.status(409).json({
                error: 'Uma categoria com este nome já existe.'
            });
        }

        res.status(500).json({ error: 'Erro ao criar categoria.' });
    }
});

// --- Rota PUT: Atualizar categoria (nome e/ou categoria-pai) ---
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, categoria_pai_id } = req.body;

    if (!nome) {
        return res.status(400).json({ error: 'Nome é obrigatório.' });
    }

    const erroTamanho = validarTamanhos({ nome }, { nome: LIMITES.CATEGORIA });
    if (erroTamanho) return res.status(400).json({ error: erroTamanho });

    try {
        const updateData = { nome };

        // categoria_pai_id só é considerado se a chave vier no corpo da
        // requisição — assim o rename simples (só nome) não mexe no pai.
        if ('categoria_pai_id' in req.body) {
            if (categoria_pai_id === id) {
                return res.status(400).json({ error: 'Uma categoria não pode ser subcategoria de si mesma.' });
            }

            if (categoria_pai_id) {
                const { data: pai, error: errPai } = await supabaseAdmin
                    .from('categorias')
                    .select('id, categoria_pai_id')
                    .eq('id', categoria_pai_id)
                    .eq('mercearia_id', req.user.mercearia_id)
                    .single();

                if (errPai || !pai) {
                    return res.status(400).json({ error: 'Categoria principal não encontrada.' });
                }
                if (pai.categoria_pai_id) {
                    return res.status(400).json({ error: 'Só é permitido um nível de subcategoria — escolha uma categoria principal, não outra subcategoria.' });
                }

                // Se ESSA categoria já tem subcategorias próprias, ela não pode
                // virar subcategoria de outra (criaria 2 níveis de profundidade)
                const { count } = await supabaseAdmin
                    .from('categorias')
                    .select('id', { count: 'exact', head: true })
                    .eq('categoria_pai_id', id);
                if (count > 0) {
                    return res.status(400).json({ error: 'Essa categoria tem subcategorias — não pode virar subcategoria de outra.' });
                }
            }

            updateData.categoria_pai_id = categoria_pai_id || null;
        }

        const { data, error } = await supabaseAdmin
            .from('categorias')
            .update(updateData)
            .eq('id', id)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Categoria não encontrada.' });
        }

        console.log(`[INFO] Categoria atualizada: ${data.nome}`);
        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_editado',
          descricao: `Categoria "${data.nome}" atualizada`,
          meta: { categoria_id: id },
        });
        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] PUT /api/categorias/${id}:`, error.message);

        if (error.code === '23505') {
            return res.status(409).json({
                error: 'Uma categoria com este nome já existe.'
            });
        }

        res.status(500).json({ error: 'Erro ao atualizar categoria.' });
    }
});

// --- Rota DELETE: Excluir categoria ---
// Se tiver subcategorias, elas não são apagadas — o banco promove elas
// pra categoria principal sozinho (ON DELETE SET NULL na migration).
router.delete('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { data, error } = await supabaseAdmin
            .from('categorias')
            .delete()
            .eq('id', id)
            .eq('mercearia_id', req.user.mercearia_id)
            .select()
            .single();

        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Categoria não encontrada.' });
        }

        console.log(`[INFO] Categoria excluída: ${data.nome}`);
        registrar({
          mercearia_id: req.user.mercearia_id,
          operador_id:  req.user.role === 'operator' ? req.user.id : null,
          usuario_nome: req.user.nome,
          usuario_email: req.user.email,
          modulo: 'estoque', acao: 'produto_excluido',
          descricao: `Categoria "${data.nome}" excluída`,
          meta: { categoria_id: id },
        });
        res.status(200).json({ message: 'Categoria excluída com sucesso' });

    } catch (error) {
        console.error(`[ERRO] DELETE /api/categorias/${id}:`, error.message);
        res.status(500).json({ error: 'Erro ao excluir categoria.' });
    }
});

module.exports = router;