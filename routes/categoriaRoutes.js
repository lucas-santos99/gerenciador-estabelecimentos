const express = require('express');
const db = require('../db/supabaseAdmin'); // Cliente Supabase Admin
const router = express.Router();

// --- Rota GET: Buscar categorias ---
router.get('/:estabelecimentoId', async (req, res) => {
    const { estabelecimentoId } = req.params;
    try {
        const { data, error } = await db
            .from('categorias')
            .select('id, nome')
            .eq('mercearia_id', estabelecimentoId)
            .order('nome', { ascending: true });
        
        if (error) throw error;
        res.status(200).json(data); 
    } catch (error) {
        console.error(`[ERRO] GET /api/categorias/${estabelecimentoId}:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar categorias.' });
    }
});

// --- Rota POST: Criar categoria ---
router.post('/', async (req, res) => {
    const { estabelecimentoId, nome } = req.body; 
    if (!estabelecimentoId || !nome) return res.status(400).json({ error: 'ID da mercearia e Nome da categoria são obrigatórios.' });

    try {
        const { data, error } = await db
            .from('categorias')
            .insert({ mercearia_id: estabelecimentoId, nome: nome })
            .select()
            .single();

        if (error) throw error;
        
        console.log(`[INFO] Nova categoria criada: ${data.nome}`);
        res.status(201).json(data); 
    } catch (error) {
        console.error(`[ERRO] POST /api/categorias:`, error.message);
        if (error.code === '23505') return res.status(409).json({ error: 'Uma categoria com este nome já existe.' });
        res.status(500).json({ error: 'Erro ao criar categoria.' });
    }
});

// --- Rota PUT: Atualizar categoria ---
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { nome, estabelecimentoId } = req.body; 

    if (!nome || !estabelecimentoId) return res.status(400).json({ error: 'Nome e ID da mercearia são obrigatórios.' });

    try {
        const { data, error } = await db
            .from('categorias')
            .update({ nome: nome })
            .eq('id', id)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Categoria não encontrada.' });
        
        console.log(`[INFO] Categoria atualizada: ${data.nome}`);
        res.status(200).json(data);

    } catch (error) {
        console.error(`[ERRO] PUT /api/categorias/${id}:`, error.message);
        if (error.code === '23505') return res.status(409).json({ error: 'Uma categoria com este nome já existe.' });
        res.status(500).json({ error: 'Erro ao atualizar categoria.' });
    }
});

// --- Rota DELETE: Excluir categoria ---
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const { estabelecimentoId } = req.body; 

    if (!estabelecimentoId) return res.status(400).json({ error: 'ID da mercearia é obrigatório no corpo.' });

    try {
        const { data, error } = await db
            .from('categorias')
            .delete()
            .eq('id', id)
            .eq('mercearia_id', estabelecimentoId)
            .select()
            .single();

        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Categoria não encontrada.' });
        
        console.log(`[INFO] Categoria excluída: ${data.nome}`);
        res.status(200).json({ message: 'Categoria excluída com sucesso' });

    } catch (error) {
        console.error(`[ERRO] DELETE /api/categorias/${id}:`, error.message);
        res.status(500).json({ error: 'Erro ao excluir categoria.' });
    }
});

module.exports = router;