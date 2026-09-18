// routes/comunicadosRoutes.js
//
// Central de comunicados do SuperAdmin (backlog item 20) — avisos globais
// (mudança de valores, instabilidade, manutenção programada, etc.) que
// aparecem pro comerciante/operador ao acessar o sistema, em um ou mais
// formatos de exibição escolhidos por comunicado.
//
// Mesmo padrão de "admin.../minhas" já usado em solicitacoesRoutes.js: um
// arquivo só, montado em /api/comunicados, com sub-rotas /admin para o
// SuperAdmin (checado via req.user.role, não onlyMaster — qualquer
// super_admin pode gerenciar comunicados) e rotas soltas pro
// comerciante/operador autenticado.
//
// Segmentação (adicionada depois do MVP): todo comunicado tem um alvo —
// 'todos' | 'tipo_estabelecimento' | 'especificos' — pra dar liberdade de
// mandar pra rede inteira, só pra um ou mais tipos de estabelecimento
// (mercearias.tipo_estabelecimento), ou só pra um ou mais estabelecimentos
// específicos (a mesma tabela de junção cobre "um" e "vários").
const express  = require('express');
const router   = express.Router();
const db       = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');
const { registrar } = require('./auditoriaRoutes');
const { LIMITES, validarTamanhos } = require('../utils/limitesTexto');

router.use(authUser);

// Formatos de exibição suportados hoje. Adicionar um novo formato no
// futuro (faixa no topo, toast periódico) é só acrescentar o valor aqui —
// nenhuma migration nova é necessária (formatos é jsonb).
const FORMATOS_VALIDOS = ['modal', 'fixo'];

function validarFormatos(formatos) {
  if (!Array.isArray(formatos) || formatos.length === 0) {
    return 'Escolha ao menos um formato de exibição.';
  }
  for (const f of formatos) {
    if (!f || typeof f !== 'object' || !FORMATOS_VALIDOS.includes(f.tipo)) {
      return `Formato inválido (use: ${FORMATOS_VALIDOS.join(', ')}).`;
    }
  }
  return null;
}

// Valores de segmentação suportados hoje. Igual a FORMATOS_VALIDOS, dá pra
// acrescentar um novo alvo (ex: "por plano de assinatura") sem migration —
// alvo_tipos_estabelecimento já é jsonb, e a tabela comunicado_estabelecimentos
// já cobre listas específicas.
const ALVO_TIPOS_VALIDOS = ['todos', 'tipo_estabelecimento', 'especificos'];

function validarAlvo({ alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids }) {
  if (!ALVO_TIPOS_VALIDOS.includes(alvo_tipo)) {
    return `Alvo inválido (use: ${ALVO_TIPOS_VALIDOS.join(', ')}).`;
  }
  if (alvo_tipo === 'tipo_estabelecimento') {
    if (!Array.isArray(alvo_tipos_estabelecimento) || alvo_tipos_estabelecimento.length === 0) {
      return 'Selecione ao menos um tipo de estabelecimento.';
    }
    if (alvo_tipos_estabelecimento.some(t => typeof t !== 'string' || !t.trim())) {
      return 'Tipo de estabelecimento inválido na lista selecionada.';
    }
  }
  if (alvo_tipo === 'especificos') {
    if (!Array.isArray(estabelecimento_ids) || estabelecimento_ids.length === 0) {
      return 'Selecione ao menos um estabelecimento.';
    }
  }
  return null;
}

// Sincroniza a tabela de junção comunicado_estabelecimentos com a lista
// atual de estabelecimento_ids. Usada tanto na criação quanto na edição —
// na edição, se o alvo deixou de ser "especificos", isso também limpa
// qualquer vínculo antigo que tivesse ficado.
async function sincronizarEstabelecimentosAlvo(comunicadoId, alvoTipo, estabelecimentoIds) {
  await db.from('comunicado_estabelecimentos').delete().eq('comunicado_id', comunicadoId);

  if (alvoTipo === 'especificos' && Array.isArray(estabelecimentoIds) && estabelecimentoIds.length) {
    const linhas = estabelecimentoIds.map(mercearia_id => ({
      comunicado_id: comunicadoId,
      mercearia_id,
    }));
    const { error } = await db.from('comunicado_estabelecimentos').insert(linhas);
    if (error) throw error;
  }
}

/* ════════════════════════════════════════════════════════════
   ADMIN — LISTAR TODOS OS COMUNICADOS (ativos e inativos)
   GET /api/comunicados/admin
   Devolve, para os comunicados com alvo "especificos", também os
   estabelecimentos vinculados (id + nome_fantasia), pra popular o
   formulário de edição sem uma segunda chamada.
════════════════════════════════════════════════════════════ */
router.get('/admin', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { data, error } = await db
      .from('comunicados')
      .select('*')
      .order('criado_em', { ascending: false });

    if (error) throw error;

    const comunicados = data || [];
    const idsEspecificos = comunicados.filter(c => c.alvo_tipo === 'especificos').map(c => c.id);

    let vinculosPorComunicado = {};
    if (idsEspecificos.length) {
      const { data: vinculos } = await db
        .from('comunicado_estabelecimentos')
        .select('comunicado_id, mercearia_id, mercearias(nome_fantasia)')
        .in('comunicado_id', idsEspecificos);

      (vinculos || []).forEach(v => {
        (vinculosPorComunicado[v.comunicado_id] ||= []).push({
          id:   v.mercearia_id,
          nome: v.mercearias?.nome_fantasia || v.mercearia_id,
        });
      });
    }

    const resultado = comunicados.map(c => ({
      ...c,
      estabelecimentos_alvo: vinculosPorComunicado[c.id] || [],
    }));

    res.json(resultado);
  } catch (err) {
    console.error('[COMUNICADOS] Erro listar:', err.message);
    res.status(500).json({ error: 'Erro ao buscar comunicados.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — LISTAR TIPOS DE ESTABELECIMENTO EXISTENTES
   GET /api/comunicados/admin/tipos-estabelecimento
   Usado pra popular o seletor de "por tipo" com os valores realmente em
   uso (evita digitar tipo errado e o comunicado não bater com ninguém).
════════════════════════════════════════════════════════════ */
router.get('/admin/tipos-estabelecimento', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { data, error } = await db
      .from('mercearias')
      .select('tipo_estabelecimento')
      .not('tipo_estabelecimento', 'is', null);

    if (error) throw error;

    const tipos = [...new Set((data || []).map(r => r.tipo_estabelecimento).filter(Boolean))].sort();
    res.json(tipos);
  } catch (err) {
    console.error('[COMUNICADOS] Erro listar tipos:', err.message);
    res.status(500).json({ error: 'Erro ao buscar tipos de estabelecimento.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — LISTAR ESTABELECIMENTOS PARA O SELETOR "ESPECÍFICOS"
   GET /api/comunicados/admin/estabelecimentos-lista
   Endpoint enxuto (id, nome, tipo) só pra popular o multi-select de alvo
   específico — não reaproveita /admin/estabelecimentos/listar porque
   aquela rota é do padrão antigo (cookie de sessão), fora do authUser
   Bearer que o restante desta tela já usa via apiFetch.
════════════════════════════════════════════════════════════ */
router.get('/admin/estabelecimentos-lista', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const { data, error } = await db
      .from('mercearias')
      .select('id, nome_fantasia, tipo_estabelecimento')
      .neq('status_assinatura', 'excluida')
      .order('nome_fantasia', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[COMUNICADOS] Erro listar estabelecimentos:', err.message);
    res.status(500).json({ error: 'Erro ao buscar estabelecimentos.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — CRIAR COMUNICADO
   POST /api/comunicados/admin
   body: {
     titulo, mensagem, formatos: [{ tipo }], ativo?,
     alvo_tipo: 'todos' | 'tipo_estabelecimento' | 'especificos',
     alvo_tipos_estabelecimento?: string[],   // quando alvo_tipo = tipo_estabelecimento
     estabelecimento_ids?: string[],          // quando alvo_tipo = especificos (1 ou vários)
   }
════════════════════════════════════════════════════════════ */
router.post('/admin', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const {
    titulo, mensagem, formatos, ativo,
    alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids,
  } = req.body;

  if (!titulo?.trim())   return res.status(400).json({ error: 'Informe o título do comunicado.' });
  if (!mensagem?.trim()) return res.status(400).json({ error: 'Informe a mensagem do comunicado.' });

  const erroTamanho = validarTamanhos(
    { titulo, mensagem },
    { titulo: LIMITES.TITULO, mensagem: LIMITES.MENSAGEM_TEMPLATE }
  );
  if (erroTamanho) return res.status(400).json({ error: erroTamanho });

  const erroFormatos = validarFormatos(formatos);
  if (erroFormatos) return res.status(400).json({ error: erroFormatos });

  const erroAlvo = validarAlvo({ alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids });
  if (erroAlvo) return res.status(400).json({ error: erroAlvo });

  try {
    const { data, error } = await db
      .from('comunicados')
      .insert({
        titulo:   titulo.trim(),
        mensagem: mensagem.trim(),
        formatos,
        ativo: ativo !== false,
        alvo_tipo,
        alvo_tipos_estabelecimento: alvo_tipo === 'tipo_estabelecimento' ? alvo_tipos_estabelecimento : null,
      })
      .select()
      .single();

    if (error) throw error;

    await sincronizarEstabelecimentosAlvo(data.id, alvo_tipo, estabelecimento_ids);

    const alvoDescricao =
      alvo_tipo === 'todos' ? 'todos os estabelecimentos'
      : alvo_tipo === 'tipo_estabelecimento' ? `tipo(s): ${alvo_tipos_estabelecimento.join(', ')}`
      : `${estabelecimento_ids.length} estabelecimento(s) específico(s)`;

    await registrar({
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        'comunicados',
      acao:          'comunicado_criado',
      descricao:     `Criou o comunicado "${data.titulo}" (${formatos.map(f => f.tipo).join(' + ')}) para ${alvoDescricao}`,
      meta:          { comunicado_id: data.id, formatos, alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids },
      escopo:        'admin_global',
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('[COMUNICADOS] Erro criar:', err.message);
    res.status(500).json({ error: 'Erro ao criar comunicado.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — EDITAR COMUNICADO
   PUT /api/comunicados/admin/:id
════════════════════════════════════════════════════════════ */
router.put('/admin/:id', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { id } = req.params;
  const {
    titulo, mensagem, formatos, ativo,
    alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids,
  } = req.body;

  if (!titulo?.trim())   return res.status(400).json({ error: 'Informe o título do comunicado.' });
  if (!mensagem?.trim()) return res.status(400).json({ error: 'Informe a mensagem do comunicado.' });

  const erroTamanho = validarTamanhos(
    { titulo, mensagem },
    { titulo: LIMITES.TITULO, mensagem: LIMITES.MENSAGEM_TEMPLATE }
  );
  if (erroTamanho) return res.status(400).json({ error: erroTamanho });

  const erroFormatos = validarFormatos(formatos);
  if (erroFormatos) return res.status(400).json({ error: erroFormatos });

  const erroAlvo = validarAlvo({ alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids });
  if (erroAlvo) return res.status(400).json({ error: erroAlvo });

  try {
    const { data, error } = await db
      .from('comunicados')
      .update({
        titulo:   titulo.trim(),
        mensagem: mensagem.trim(),
        formatos,
        ativo: ativo !== false,
        alvo_tipo,
        alvo_tipos_estabelecimento: alvo_tipo === 'tipo_estabelecimento' ? alvo_tipos_estabelecimento : null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Comunicado não encontrado.' });

    await sincronizarEstabelecimentosAlvo(id, alvo_tipo, estabelecimento_ids);

    await registrar({
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        'comunicados',
      acao:          'comunicado_editado',
      descricao:     `Editou o comunicado "${data.titulo}"`,
      meta:          { comunicado_id: id, formatos, alvo_tipo, alvo_tipos_estabelecimento, estabelecimento_ids },
      escopo:        'admin_global',
    });

    res.json(data);
  } catch (err) {
    console.error('[COMUNICADOS] Erro editar:', err.message);
    res.status(500).json({ error: 'Erro ao editar comunicado.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — ATIVAR/DESATIVAR RÁPIDO (sem abrir o formulário inteiro)
   PATCH /api/comunicados/admin/:id/ativo
   body: { ativo }
════════════════════════════════════════════════════════════ */
router.patch('/admin/:id/ativo', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { id } = req.params;
  const { ativo } = req.body;

  try {
    const { data, error } = await db
      .from('comunicados')
      .update({ ativo: !!ativo })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Comunicado não encontrado.' });

    await registrar({
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        'comunicados',
      acao:          ativo ? 'comunicado_ativado' : 'comunicado_desativado',
      descricao:     `${ativo ? 'Ativou' : 'Desativou'} o comunicado "${data.titulo}"`,
      meta:          { comunicado_id: id },
      escopo:        'admin_global',
    });

    res.json(data);
  } catch (err) {
    console.error('[COMUNICADOS] Erro toggle ativo:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar comunicado.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ADMIN — EXCLUIR COMUNICADO
   DELETE /api/comunicados/admin/:id
   comunicado_estabelecimentos tem ON DELETE CASCADE — não precisa
   limpar manualmente os vínculos.
════════════════════════════════════════════════════════════ */
router.delete('/admin/:id', async (req, res) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { id } = req.params;

  try {
    // Busca o título antes de apagar, pra descrição da auditoria não
    // ficar sem contexto (mesma convenção já usada em outras exclusões).
    const { data: existente } = await db
      .from('comunicados')
      .select('titulo')
      .eq('id', id)
      .single();

    const { error } = await db.from('comunicados').delete().eq('id', id);
    if (error) throw error;

    await registrar({
      usuario_nome:  req.user.nome,
      usuario_email: req.user.email,
      modulo:        'comunicados',
      acao:          'comunicado_excluido',
      descricao:     `Excluiu o comunicado "${existente?.titulo || id}"`,
      meta:          { comunicado_id: id },
      escopo:        'admin_global',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[COMUNICADOS] Erro excluir:', err.message);
    res.status(500).json({ error: 'Erro ao excluir comunicado.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ESTABELECIMENTO — COMUNICADOS ATIVOS AINDA NÃO DISPENSADOS
   GET /api/comunicados/ativos
   Devolve os comunicados ativos (já filtrados pela segmentação: alvo
   "todos", ou "tipo_estabelecimento" batendo com o tipo dessa mercearia,
   ou "especificos" incluindo essa mercearia) junto com quais formatos JÁ
   foram vistos — o frontend decide o que ainda precisa mostrar (fechar o
   card fixo não dispensa o modal, e vice-versa).
════════════════════════════════════════════════════════════ */
router.get('/ativos', async (req, res) => {
  const { mercearia_id } = req.user;
  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const { data: comunicados, error } = await db
      .from('comunicados')
      .select('id, titulo, mensagem, formatos, criado_em, alvo_tipo, alvo_tipos_estabelecimento')
      .eq('ativo', true)
      .order('criado_em', { ascending: false });

    if (error) throw error;
    if (!comunicados?.length) return res.json([]);

    // Só precisa saber o tipo_estabelecimento dessa mercearia se existir
    // ao menos um comunicado segmentado por tipo.
    let tipoDaMercearia = null;
    if (comunicados.some(c => c.alvo_tipo === 'tipo_estabelecimento')) {
      const { data: merc } = await db
        .from('mercearias')
        .select('tipo_estabelecimento')
        .eq('id', mercearia_id)
        .single();
      tipoDaMercearia = merc?.tipo_estabelecimento || null;
    }

    // Idem pra "especificos": só busca a tabela de junção se precisar.
    const idsEspecificos = comunicados.filter(c => c.alvo_tipo === 'especificos').map(c => c.id);
    let mercIncluidaEm = new Set();
    if (idsEspecificos.length) {
      const { data: vinculos } = await db
        .from('comunicado_estabelecimentos')
        .select('comunicado_id')
        .eq('mercearia_id', mercearia_id)
        .in('comunicado_id', idsEspecificos);
      mercIncluidaEm = new Set((vinculos || []).map(v => v.comunicado_id));
    }

    const alvejaEssaMercearia = (c) => {
      if (c.alvo_tipo === 'especificos') return mercIncluidaEm.has(c.id);
      if (c.alvo_tipo === 'tipo_estabelecimento') {
        return !!tipoDaMercearia && (c.alvo_tipos_estabelecimento || []).includes(tipoDaMercearia);
      }
      return true; // 'todos'
    };

    const comunicadosDoAlvo = comunicados.filter(alvejaEssaMercearia);
    if (!comunicadosDoAlvo.length) return res.json([]);

    const { data: vistos } = await db
      .from('comunicados_vistos')
      .select('comunicado_id, formato')
      .eq('mercearia_id', mercearia_id)
      .in('comunicado_id', comunicadosDoAlvo.map(c => c.id));

    const vistosPorComunicado = {};
    (vistos || []).forEach(v => {
      (vistosPorComunicado[v.comunicado_id] ||= new Set()).add(v.formato);
    });

    // Só devolve comunicados que ainda têm pelo menos um formato pendente.
    const pendentes = comunicadosDoAlvo
      .map(c => ({
        id: c.id, titulo: c.titulo, mensagem: c.mensagem, criado_em: c.criado_em,
        formatos: c.formatos.filter(f => !vistosPorComunicado[c.id]?.has(f.tipo)),
      }))
      .filter(c => c.formatos.length > 0);

    res.json(pendentes);
  } catch (err) {
    console.error('[COMUNICADOS] Erro buscar ativos:', err.message);
    res.status(500).json({ error: 'Erro ao buscar comunicados.' });
  }
});

/* ════════════════════════════════════════════════════════════
   ESTABELECIMENTO — DISPENSAR UM FORMATO DE UM COMUNICADO
   POST /api/comunicados/:id/marcar-visto
   body: { formato }
════════════════════════════════════════════════════════════ */
router.post('/:id/marcar-visto', async (req, res) => {
  const { mercearia_id } = req.user;
  const { id } = req.params;
  const { formato } = req.body;

  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });
  if (!FORMATOS_VALIDOS.includes(formato)) {
    return res.status(400).json({ error: 'Formato inválido.' });
  }

  try {
    const { error } = await db
      .from('comunicados_vistos')
      .upsert(
        { comunicado_id: id, mercearia_id, formato },
        { onConflict: 'comunicado_id,mercearia_id,formato' }
      );

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[COMUNICADOS] Erro marcar visto:', err.message);
    res.status(500).json({ error: 'Erro ao dispensar comunicado.' });
  }
});

module.exports = router;
