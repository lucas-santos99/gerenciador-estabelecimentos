const express = require('express');
const router = express.Router();
const authUser = require('../middlewares/authUser');
const createSupabaseUserClient = require('../db/supabaseUser');
const supabaseAdmin = require('../db/supabaseAdmin');
const { registrar } = require('./auditoriaRoutes');

router.use(authUser);

// --- Rota GET: Buscar categorias ---
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('categorias')
            .select('id, nome')
            .eq('mercearia_id', req.user.mercearia_id)
            .order('nome', { ascending: true });

        if (error) throw error;

        res.status(200).json(data);

    } catch (error) {
        console.error('[ERRO] GET /api/categorias:', error.message);
        res.status(500).json({ error: 'Erro ao buscar categorias.' });
    }
});

// --- Rota POST: Criar categoria ---
router.post('/', async (req, res) => {
    const { nome } = req.body;

    if (!nome) {
        return res.status(400).json({ error: 'Nome da categoria é obrigatório.' });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('categorias')
            .insert({ nome, mercearia_id: req.user.mercearia_id })
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
          descricao: `Categoria "${data.nome}" criada`,
          meta: { categoria_id: data.id },
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

// --- Rota PUT: Atualizar categoria ---
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome } = req.body;

    if (!nome) {
        return res.status(400).json({ error: 'Nome é obrigatório.' });
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('categorias')
            .update({ nome })
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