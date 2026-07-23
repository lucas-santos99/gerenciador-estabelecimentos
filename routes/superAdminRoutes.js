const express = require('express');
const router = express.Router();

const authUser = require('../middlewares/authUser');
const onlyMaster = require('../middlewares/onlyMaster');
const { registrar } = require('./auditoriaRoutes');

const {
  criarSuperAdmin,
  listarSuperAdmins,
  excluirSuperAdmin,
  toggleAtivo,
  alterarSenha,
  tornarMaster // 🔥 ADICIONADO
} = require('../controllers/superAdminController');

// 🔥 TODAS ROTAS PRECISAM ESTAR AUTENTICADAS
router.use(authUser);

// ============================================================
// 🔥 PERFIL (IMPORTANTE PRO LOGIN)
// ============================================================
router.get('/perfil', (req, res) => {
  try {
    return res.json(req.user);
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ============================================================
// 🔒 APENAS MASTER
// ============================================================

// CRIAR
router.post('/criar', onlyMaster, criarSuperAdmin);

// LISTAR
router.get('/listar', onlyMaster, listarSuperAdmins);

// EXCLUIR
router.delete('/:id', onlyMaster, excluirSuperAdmin);

// ATIVAR/DESATIVAR
router.patch('/:id/ativo', onlyMaster, toggleAtivo);

// ALTERAR SENHA
router.patch('/:id/senha', onlyMaster, alterarSenha);

// 🔥 TORNAR MASTER (NOVO)
router.patch('/:id/master', onlyMaster, tornarMaster);

// ============================================================
// CONFIGURAÇÕES GLOBAIS DO SISTEMA
// ============================================================

router.get('/config', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { data, error } = await db
      .from('config_sistema')
      .select('chave, valor');
    if (error) throw error;

    const config = {};
    (data || []).forEach(r => { config[r.chave] = r.valor; });

    res.json({
      limite_operadores_padrao: parseInt(config.limite_operadores_padrao) || 3,
      valor_mensalidade:        parseFloat(config.valor_mensalidade)      || 49.90,
      whatsapp_suporte:         config.whatsapp_suporte                   || '',
    });
  } catch (err) {
    console.error('ERRO GET config:', err);
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

router.put('/config', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { limite_operadores_padrao, valor_mensalidade, whatsapp_suporte } = req.body;

    const updates = [];

    if (limite_operadores_padrao !== undefined) {
      const val = parseInt(limite_operadores_padrao);
      if (isNaN(val) || val < 0 || val > 50)
        return res.status(400).json({ error: 'Limite inválido (0–50)' });
      updates.push({ chave: 'limite_operadores_padrao', valor: String(val) });
    }

    if (valor_mensalidade !== undefined) {
      const val = parseFloat(valor_mensalidade);
      if (isNaN(val) || val < 0 || val > 9999)
        return res.status(400).json({ error: 'Valor de mensalidade inválido' });
      updates.push({ chave: 'valor_mensalidade', valor: String(val.toFixed(2)) });
    }

    if (whatsapp_suporte !== undefined) {
      const limpo = String(whatsapp_suporte).replace(/\D/g, '');
      if (limpo.length < 10 || limpo.length > 15)
        return res.status(400).json({ error: 'WhatsApp inválido (só números, com DDD e DDI)' });
      updates.push({ chave: 'whatsapp_suporte', valor: limpo });
    }

    for (const u of updates) {
      const { error } = await db
        .from('config_sistema')
        .upsert(u, { onConflict: 'chave' });
      if (error) throw error;
    }

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'configuracoes',
      acao:          'editar_config_global',
      descricao:     `Alterou configurações globais do sistema (${updates.map(u => u.chave).join(', ')})`,
      meta:          { updates },
      escopo:        'admin_global',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('ERRO PUT config:', err);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});


// ============================================================
// CONFIGURAÇÕES DA TELA DE BLOQUEIO (textos editáveis)
// ============================================================

router.get('/config-tela-bloqueio', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { data } = await db
      .from('config_sistema')
      .select('chave, valor')
      .in('chave', [
        'tela_bloqueio_titulo', 'tela_bloqueio_mensagem', 'tela_bloqueio_info',
        'promo_ativa', 'promo_texto', 'promo_validade',
      ]);
    const cfg = {};
    (data || []).forEach(r => { cfg[r.chave] = r.valor; });
    res.json({
      titulo:         cfg.tela_bloqueio_titulo   || 'Acesso Bloqueado',
      mensagem:       cfg.tela_bloqueio_mensagem || '',
      info:           cfg.tela_bloqueio_info     || '',
      promo_ativa:    cfg.promo_ativa === 'true',
      promo_texto:    cfg.promo_texto            || '',
      promo_validade: cfg.promo_validade         || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações da tela.' });
  }
});

router.put('/config-tela-bloqueio', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { titulo, mensagem, info, promo_ativa, promo_texto, promo_validade } = req.body;

    const updates = [
      { chave: 'tela_bloqueio_titulo',   valor: titulo   || 'Acesso Bloqueado' },
      { chave: 'tela_bloqueio_mensagem', valor: mensagem || '' },
      { chave: 'tela_bloqueio_info',     valor: info     || '' },
      { chave: 'promo_ativa',            valor: promo_ativa ? 'true' : 'false' },
      { chave: 'promo_texto',            valor: promo_texto    || '' },
      { chave: 'promo_validade',         valor: promo_validade || '' },
    ];

    for (const u of updates) {
      await db.from('config_sistema').upsert(u, { onConflict: 'chave' });
    }

    await registrar({
      usuario_nome:  req.user?.nome,
      usuario_email: req.user?.email,
      modulo:        'configuracoes',
      acao:          'editar_tela_bloqueio',
      descricao:     'Alterou os textos da tela de bloqueio',
      escopo:        'admin_global',
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar configurações da tela.' });
  }
});

// ============================================================
// CONTATOS DE SUPORTE (WhatsApp / E-mail) — múltiplos, configuráveis
// ============================================================

// Leitura liberada pra qualquer usuário autenticado (merchant/operador
// também precisam ver isso — botão "Fale Conosco" e tela de bloqueio)
router.get('/contatos-suporte', async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { data, error } = await db
      .from('contatos_suporte')
      .select('id, tipo, valor, label, ordem')
      .order('tipo')
      .order('ordem');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('ERRO GET contatos-suporte:', err);
    res.status(500).json({ error: 'Erro ao buscar contatos de suporte' });
  }
});

router.post('/contatos-suporte', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { tipo, valor, label } = req.body;

    if (!['whatsapp', 'email'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido (use whatsapp ou email).' });
    }
    if (!valor || !valor.trim()) {
      return res.status(400).json({ error: 'Informe o valor do contato.' });
    }

    const valorLimpo = tipo === 'whatsapp' ? valor.replace(/\D/g, '') : valor.trim();

    const { data: existentes } = await db
      .from('contatos_suporte')
      .select('ordem')
      .eq('tipo', tipo)
      .order('ordem', { ascending: false })
      .limit(1);
    const proximaOrdem = (existentes?.[0]?.ordem ?? -1) + 1;

    const { data, error } = await db
      .from('contatos_suporte')
      .insert({ tipo, valor: valorLimpo, label: label?.trim() || null, ordem: proximaOrdem })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('ERRO POST contatos-suporte:', err);
    res.status(500).json({ error: 'Erro ao criar contato de suporte' });
  }
});

router.delete('/contatos-suporte/:id', onlyMaster, async (req, res) => {
  try {
    const db = require('../db/supabaseAdmin');
    const { error } = await db.from('contatos_suporte').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('ERRO DELETE contatos-suporte:', err);
    res.status(500).json({ error: 'Erro ao remover contato de suporte' });
  }
});

module.exports = router;