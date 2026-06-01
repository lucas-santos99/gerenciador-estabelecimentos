// utils/permissoes.js
// ⚠️ FONTE DA VERDADE DO BACKEND — mantenha sincronizado com:
//   - OperadoresEstabelecimento.jsx (MODULOS)
//   - DetalhesOperador.jsx (MODULOS_ADMIN)

const PERMISSOES = {
  // ── Módulos (acesso à aba inteira) ──────────────────────
  PDV:           'pdv',
  ESTOQUE:       'estoque',
  CLIENTES:      'clientes',
  FINANCEIRO:    'financeiro',
  RELATORIOS:    'relatorios',
  CONFIGURACOES: 'configuracoes',

  // ── Ações granulares — PDV ───────────────────────────────
  PDV_REALIZAR_VENDA: 'pdv_realizar_venda',
  PDV_CANCELAR_VENDA: 'pdv_cancelar_venda',
  PDV_FIADO:          'pdv_fiado',
  PDV_DESCONTO:       'pdv_desconto',

  // ── Ações granulares — Estoque ───────────────────────────
  ESTOQUE_ADICIONAR: 'estoque_adicionar',
  ESTOQUE_EDITAR:    'estoque_editar',
  ESTOQUE_EXCLUIR:   'estoque_excluir',

  // ── Ações granulares — Clientes ──────────────────────────
  CLIENTES_ADICIONAR: 'clientes_adicionar',
  CLIENTES_EDITAR:    'clientes_editar',
  CLIENTES_EXCLUIR:   'clientes_excluir',
  CLIENTES_RECEBER:   'clientes_receber',

  // ── Ações granulares — Financeiro ────────────────────────
  FINANCEIRO_VER_RESUMO:   'financeiro_ver_resumo',
  FINANCEIRO_VER_DRE:      'financeiro_ver_dre',
  FINANCEIRO_CONTAS_PAGAR: 'financeiro_contas_pagar',

  // ── Ações granulares — Relatórios ────────────────────────
  RELATORIOS_HISTORICO:  'relatorios_historico',
  RELATORIOS_OPERADORES: 'relatorios_operadores',
  RELATORIOS_PRODUTOS:   'relatorios_produtos',
  RELATORIOS_ESTOQUE:    'relatorios_estoque',
  RELATORIOS_AUDITORIA:  'relatorios_auditoria',

  // ── Ações granulares — Configurações ────────────────────
  CONFIG_EDITAR_DADOS: 'config_editar_dados',
  CONFIG_EDITAR_LOGO:  'config_editar_logo',

  // ── Módulo Inventário ───────────────────────────────────────
  INVENTARIO:           'inventario',
  INVENTARIO_CONTAR:    'inventario_contar',
  INVENTARIO_FINALIZAR: 'inventario_finalizar',
  INVENTARIO_AJUSTE:    'inventario_ajuste',

  // ── Legado (mantidos para compatibilidade) ───────────────
  VER_CAIXA:         'pdv',
  VER_FINANCEIRO:    'financeiro',
  CANCELAR_VENDA:    'pdv_cancelar_venda',
  CADASTRAR_PRODUTO: 'estoque_adicionar',
  EDITAR_PRODUTO:    'estoque_editar',
  VER_RELATORIOS:    'relatorios',
};

// Agrupamento para a UI de permissões
const MODULOS_PERMISSOES = [
  {
    id: 'pdv', label: 'PDV (Caixa)', icone: '🖥️',
    desc: 'Acesso ao caixa e realização de vendas',
    acoes: [
      { id: 'pdv_realizar_venda', label: 'Realizar vendas' },
      { id: 'pdv_cancelar_venda', label: 'Cancelar vendas' },
      { id: 'pdv_fiado',          label: 'Vender no fiado' },
      { id: 'pdv_desconto',       label: 'Aplicar desconto' },
    ],
  },
  {
    id: 'estoque', label: 'Estoque', icone: '📦',
    desc: 'Visualização e gestão de produtos',
    acoes: [
      { id: 'estoque_adicionar', label: 'Adicionar produtos' },
      { id: 'estoque_editar',    label: 'Editar produtos' },
      { id: 'estoque_excluir',   label: 'Excluir produtos' },
    ],
  },
  {
    id: 'clientes', label: 'Clientes / Fiado', icone: '👥',
    desc: 'Gestão de clientes e cobranças',
    acoes: [
      { id: 'clientes_adicionar', label: 'Adicionar clientes' },
      { id: 'clientes_editar',    label: 'Editar clientes' },
      { id: 'clientes_excluir',   label: 'Excluir clientes' },
      { id: 'clientes_receber',   label: 'Registrar recebimentos' },
    ],
  },
  {
    id: 'financeiro', label: 'Financeiro', icone: '💰',
    desc: 'Fluxo de caixa e contas a pagar',
    acoes: [
      { id: 'financeiro_ver_resumo',   label: 'Ver resumo do caixa' },
      { id: 'financeiro_ver_dre',      label: 'Ver DRE' },
      { id: 'financeiro_contas_pagar', label: 'Gerenciar contas a pagar' },
    ],
  },
  {
    id: 'relatorios', label: 'Relatórios', icone: '📊',
    desc: 'Histórico de vendas, estoque e auditoria',
    acoes: [
      { id: 'relatorios_historico',  label: 'Ver histórico de vendas' },
      { id: 'relatorios_operadores', label: 'Ver vendas por operador' },
      { id: 'relatorios_produtos',   label: 'Ver produtos mais vendidos' },
      { id: 'relatorios_estoque',    label: 'Ver relatório de estoque' },
      { id: 'relatorios_auditoria',  label: 'Ver auditoria de ações' },
    ],
  },
  {
    id: 'configuracoes', label: 'Configurações', icone: '⚙️',
    desc: 'Configurações do estabelecimento',
    acoes: [
      { id: 'config_editar_dados', label: 'Editar dados do estabelecimento' },
      { id: 'config_editar_logo',  label: 'Alterar logo' },
    ],
  },
  {
    id: 'inventario', label: 'Inventário', icone: '📦',
    desc: 'Contagem física e movimentações de estoque',
    acoes: [
      { id: 'inventario_contar',    label: 'Realizar contagens (inventário)' },
      { id: 'inventario_finalizar', label: 'Finalizar e aplicar inventário ao estoque' },
      { id: 'inventario_ajuste',    label: 'Ajustes rápidos de estoque' },
    ],
  },
];

module.exports = { PERMISSOES, MODULOS_PERMISSOES };