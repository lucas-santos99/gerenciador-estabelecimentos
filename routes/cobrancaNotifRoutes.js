// ===== routes/cobrancaNotifRoutes.js =====
//
// Notificação de cobrança no canto de tela (merchant) — pequeno "card
// fixo" avisando que o vencimento está próximo, com título/mensagem/
// imagem configuráveis pelo SuperAdmin (mesma ideia dos Comunicados),
// aparecendo JUNTO com o banner "Renovar Antecipado" já existente.
//
// Diferença chave em relação a comunicadosRoutes.js: aqui não existem
// "vários comunicados" — é UMA notificação (a config global de
// cobrança), sobre o PRÓPRIO vencimento de cada mercearia. Por isso o
// "visto" é escopado ao mercearia_id (não a um id de comunicado) e
// re-escopado ao ciclo de vencimento vigente (data_vencimento_referencia).

const express = require('express');
const router = express.Router();
const db = require('../db/supabaseAdmin');
const authUser = require('../middlewares/authUser');

router.use(authUser);

const FREQUENCIA_TIPOS_VALIDOS = ['uma_vez', 'quantidade', 'sempre'];

/* ════════════════════════════════════════════════════════════
   GET /api/cobranca-notif/estado
   Devolve se a notificação deve aparecer pra essa mercearia agora,
   junto com o conteúdo configurado (título/mensagem/imagem) — o
   frontend só decide onde/quando renderizar, toda a lógica de
   janela de dias + frequência fica aqui, igual em /comunicados/ativos.
════════════════════════════════════════════════════════════ */
router.get('/estado', async (req, res) => {
  const { mercearia_id } = req.user;
  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const { data: cfgRows } = await db
      .from('config_sistema')
      .select('chave, valor')
      .in('chave', [
        'cobranca_notif_ativo',
        'cobranca_notif_titulo',
        'cobranca_notif_mensagem',
        'cobranca_notif_mensagem_html',
        'cobranca_notif_frequencia_tipo',
        'cobranca_notif_frequencia_quantidade',
        'cobranca_dias_aviso',
        'cobranca_imagem_url',
      ]);
    const cfg = {};
    (cfgRows || []).forEach(r => { cfg[r.chave] = r.valor; });

    const notifAtiva = cfg.cobranca_notif_ativo === 'true';
    if (!notifAtiva) return res.json({ deve_mostrar: false });

    const { data: merc, error: errMerc } = await db
      .from('mercearias')
      .select('data_vencimento, status_assinatura')
      .eq('id', mercearia_id)
      .single();
    if (errMerc || !merc) return res.json({ deve_mostrar: false });

    if (merc.status_assinatura !== 'ativa' || !merc.data_vencimento) {
      return res.json({ deve_mostrar: false });
    }

    const diasAviso = parseInt(cfg.cobranca_dias_aviso) || 5;
    const hoje = new Date();
    const vencimento = new Date(merc.data_vencimento + 'T00:00:00Z');
    const diasRestantes = Math.ceil((vencimento - Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())) / 86400000);

    if (diasRestantes < 0 || diasRestantes > diasAviso) {
      return res.json({ deve_mostrar: false });
    }

    const frequenciaTipo = FREQUENCIA_TIPOS_VALIDOS.includes(cfg.cobranca_notif_frequencia_tipo)
      ? cfg.cobranca_notif_frequencia_tipo
      : 'sempre';
    const frequenciaQuantidade = parseInt(cfg.cobranca_notif_frequencia_quantidade) || 1;

    const { data: vista } = await db
      .from('cobranca_notif_vista')
      .select('vezes, data_vencimento_referencia')
      .eq('mercearia_id', mercearia_id)
      .maybeSingle();

    // Ciclo mudou (venceu e renovou) desde a última vez que foi vista →
    // trata como reiniciada em 0, mesmo sem apagar a linha no banco.
    const mesmoCiclo = vista?.data_vencimento_referencia === merc.data_vencimento;
    const vezesVisto = mesmoCiclo ? (vista?.vezes || 0) : 0;

    let deveMostrar;
    if (frequenciaTipo === 'sempre') deveMostrar = true;
    else if (frequenciaTipo === 'quantidade') deveMostrar = vezesVisto < frequenciaQuantidade;
    else deveMostrar = vezesVisto < 1; // 'uma_vez'

    if (!deveMostrar) return res.json({ deve_mostrar: false });

    res.json({
      deve_mostrar:    true,
      titulo:          cfg.cobranca_notif_titulo || 'Sua assinatura está vencendo',
      mensagem:        cfg.cobranca_notif_mensagem || '',
      mensagem_html:   cfg.cobranca_notif_mensagem_html || '',
      imagem_url:      cfg.cobranca_imagem_url || '',
      dias_restantes:  diasRestantes,
    });
  } catch (err) {
    console.error('[COBRANCA-NOTIF] Erro buscar estado:', err.message);
    res.status(500).json({ error: 'Erro ao buscar notificação de cobrança.' });
  }
});

/* ════════════════════════════════════════════════════════════
   POST /api/cobranca-notif/marcar-visto
   Incrementa a contagem de vistas dessa mercearia, reiniciando o
   contador se o vencimento vigente já é outro (ciclo novo).
════════════════════════════════════════════════════════════ */
router.post('/marcar-visto', async (req, res) => {
  const { mercearia_id } = req.user;
  if (!mercearia_id) return res.status(403).json({ error: 'Sem estabelecimento vinculado.' });

  try {
    const { data: merc } = await db
      .from('mercearias')
      .select('data_vencimento')
      .eq('id', mercearia_id)
      .single();
    const vencimentoAtual = merc?.data_vencimento || null;

    const { data: existente } = await db
      .from('cobranca_notif_vista')
      .select('id, vezes, data_vencimento_referencia')
      .eq('mercearia_id', mercearia_id)
      .maybeSingle();

    const mesmoCiclo = existente && existente.data_vencimento_referencia === vencimentoAtual;
    const novoVezes  = mesmoCiclo ? existente.vezes + 1 : 1;

    if (existente) {
      const { error } = await db
        .from('cobranca_notif_vista')
        .update({
          vezes: novoVezes,
          data_vencimento_referencia: vencimentoAtual,
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', existente.id);
      if (error) throw error;
    } else {
      const { error } = await db
        .from('cobranca_notif_vista')
        .insert({ mercearia_id, vezes: 1, data_vencimento_referencia: vencimentoAtual });
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[COBRANCA-NOTIF] Erro marcar visto:', err.message);
    res.status(500).json({ error: 'Erro ao dispensar notificação.' });
  }
});

module.exports = router;
