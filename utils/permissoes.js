// utils/permissoes.js
// Sistema unificado: módulos do painel + ações granulares dentro de cada módulo

const PERMISSOES = {
  // ── Módulos (acesso à aba inteira) ──────────────────────
  PDV:           'pdv',
  ESTOQUE:       'estoque',
  CLIENTES:      'clientes',
  FINANCEIRO:    'financeiro',
  CONFIGURACOES: 'configuracoes',

  // ── Ações granulares — PDV ───────────────────────────────
  PDV_CANCELAR_VENDA: 'pdv_cancelar_venda',
  PDV_FIADO:          'pdv_fiado',

  // ── Ações granulares — Estoque ───────────────────────────
  ESTOQUE_ADICIONAR:  'estoque_adicionar',
  ESTOQUE_EDITAR:     'estoque_editar',
  ESTOQUE_EXCLUIR:    'estoque_excluir',

  // ── Ações granulares — Clientes ──────────────────────────
  CLIENTES_ADICIONAR: 'clientes_adicionar',
  CLIENTES_EDITAR:    'clientes_editar',
  CLIENTES_EXCLUIR:   'clientes_excluir',
  CLIENTES_RECEBER:   'clientes_receber',

  // ── Ações granulares — Financeiro ────────────────────────
  FINANCEIRO_VER_DRE:       'financeiro_ver_dre',
  FINANCEIRO_VER_RELATORIO: 'financeiro_ver_relatorio',
  FINANCEIRO_CONTAS_PAGAR:  'financeiro_contas_pagar',

  // ── Ações granulares — Configurações ────────────────────
  CONFIG_EDITAR_DADOS: 'config_editar_dados',
  CONFIG_EDITAR_LOGO:  'config_editar_logo',

  // ── Legado (mantidos para compatibilidade) ───────────────
  VER_CAIXA:        'pdv',
  VER_FINANCEIRO:   'financeiro',
  CANCELAR_VENDA:   'pdv_cancelar_venda',
  CADASTRAR_PRODUTO:'estoque_adicionar',
  EDITAR_PRODUTO:   'estoque_editar',
  VER_RELATORIOS:   'financeiro_ver_relatorio',
};

// Agrupamento para a UI de permissões
const MODULOS_PERMISSOES = [
  {
    id:    'pdv',
    label: 'PDV (Caixa)',
    icone: '🖥️',
    desc:  'Acesso ao caixa e realização de vendas',
    acoes: [
      { id: 'pdv_cancelar_venda', label: 'Cancelar vendas' },
      { id: 'pdv_fiado',          label: 'Registrar fiado' },
    ],
  },
  {
    id:    'estoque',
    label: 'Estoque',
    icone: '📦',
    desc:  'Visualização e gestão de produtos',
    acoes: [
      { id: 'estoque_adicionar', label: 'Adicionar produtos' },
      { id: 'estoque_editar',    label: 'Editar produtos' },
      { id: 'estoque_excluir',   label: 'Excluir produtos' },
    ],
  },
  {
    id:    'clientes',
    label: 'Clientes / Fiado',
    icone: '👥',
    desc:  'Gestão de clientes e cobranças',
    acoes: [
      { id: 'clientes_adicionar', label: 'Adicionar clientes' },
      { id: 'clientes_editar',    label: 'Editar clientes' },
      { id: 'clientes_excluir',   label: 'Excluir clientes' },
      { id: 'clientes_receber',   label: 'Registrar recebimentos' },
    ],
  },
  {
    id:    'financeiro',
    label: 'Financeiro',
    icone: '💰',
    desc:  'Fluxo de caixa e relatórios',
    acoes: [
      { id: 'financeiro_ver_dre',       label: 'Ver DRE' },
      { id: 'financeiro_ver_relatorio', label: 'Ver relatório de vendas' },
      { id: 'financeiro_contas_pagar',  label: 'Gerenciar contas a pagar' },
    ],
  },
  {
    id:    'configuracoes',
    label: 'Configurações',
    icone: '⚙️',
    desc:  'Configurações do estabelecimento',
    acoes: [
      { id: 'config_editar_dados', label: 'Editar dados do estabelecimento' },
      { id: 'config_editar_logo',  label: 'Alterar logo' },
    ],
  },
];

module.exports = { PERMISSOES, MODULOS_PERMISSOES };