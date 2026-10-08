// ===== server.js =====

// Carregar .env apenas em desenvolvimento
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const cors = require("cors");
const db = require("./db/supabaseAdmin");

// --- IMPORTAÇÃO DAS ROTAS DO SISTEMA (PAINEL ESTABELECIMENTO/OPERADOR) ---
const estabelecimentoRoutes = require("./routes/estabelecimentoRoutes");
const categoriaRoutes = require("./routes/categoriaRoutes");
const vendaRoutes = require("./routes/vendaRoutes");
const clienteRoutes = require("./routes/clienteRoutes");
const financeiroRoutes = require("./routes/financeiroRoutes");
const operadoresRoutes = require("./routes/operadoresRoutes");
const auditoriaRoutes   = require("./routes/auditoriaRoutes");
const inventarioRoutes  = require("./routes/inventarioRoutes");
const fornecedoresRoutes = require("./routes/fornecedoresRoutes");
const comprasRoutes      = require("./routes/comprasRoutes");
const solicitacoesRoutes = require("./routes/solicitacoesRoutes");
const comunicadosRoutes  = require("./routes/comunicadosRoutes");
const cobrancaNotifRoutes = require("./routes/cobrancaNotifRoutes");
const notificacoesRoutes = require("./routes/notificacoesRoutes");
const rastroRoutes = require("./routes/rastroRoutes");
const consultaRoutes = require("./routes/consultaRoutes");
const { limiteGlobalIp, limiteWebhook } = require("./middlewares/limiteRequisicoes");
const whatsappAdminRoutes = require("./routes/whatsappAdminRoutes");
const whatsappLojaRoutes = require("./routes/whatsappLojaRoutes");
const whatsappWebhookRoutes = require("./routes/whatsappWebhookRoutes");

// --- IMPORTAÇÃO DAS ROTAS DO ASAAS ---
const asaasRoutes = require("./routes/asaasRoutes");

// --- IMPORTAÇÃO DAS ROTAS DO EFÍ (Pix da mensalidade) ---
const efiRoutes = require("./routes/efiRoutes");

// --- IMPORTAÇÃO DAS ROTAS DO ADMIN ---
const adminEstabelecimentosRoutes = require("./routes/adminEstabelecimentosRoutes");
const adminOperadoresRoutes = require("./routes/adminOperadoresRoutes");
const superAdminRoutes = require("./routes/superAdminRoutes");

// Criar app
const app = express();
const PORT = process.env.PORT || 3001;

// Atrás do Railway há um proxy: sem isto, `req.ip` seria sempre o IP do proxy
// (todo mundo pareceria o mesmo usuário) e o limite por IP não funcionaria.
// `1` = confia só no primeiro proxy (o do Railway).
app.set("trust proxy", 1);

// --- MIDDLEWARES ---
// verify: guarda o corpo cru só do webhook do WhatsApp — a Meta assina o
// corpo exato (X-Hub-Signature-256) e a conferência precisa dele intacto.
// Limite do corpo JSON: 5 MB (antes 20 MB em qualquer rota). A maior coisa que
// vai em JSON é a foto de produto, que o navegador já comprime (~400x400 px).
// Upload de logo/foto/imagem de comunicado usa multipart, que não passa aqui.
app.use(express.json({
  limit: "5mb",
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith("/api/whatsapp/webhook")) req.rawBody = buf;
  },
}));

// --- CORS CONFIGURAÇÃO ---
app.use(
  cors({
    // 22/09/2026: removidos os dois domínios antigos do Render
    // (gerenciador-mercearia-frontend / gerenciador-estabelecimentos-frontend
    // .onrender.com) — o frontend em produção é o da Vercel. Se algum dia
    // voltar a usar outro domínio, adicionar aqui.
    origin: [
      "http://localhost:5173", // desenvolvimento local
      "https://gerenciador-estabelecimentos-fronte.vercel.app", // produção (Vercel)
    ],
    credentials: true,
  })
);

// --- LIMITE DE REQUISIÇÕES (rate limit) ---
// Geral por IP (folgado, só barra abuso) e mais apertado nos webhooks públicos.
// Limites por usuário (cobrança, ações sensíveis, WhatsApp) ficam nas próprias rotas.
app.use((req, res, next) => (req.path === "/ping" ? next() : limiteGlobalIp(req, res, next)));
app.use(["/api/whatsapp/webhook", "/api/efi/webhook", "/api/asaas/webhook"], limiteWebhook);

// --- ROTAS DO ASAAS (cobrança de licença) ---
// Webhook deve ser registrado ANTES do express.json para receber raw body se necessário
app.use("/api/asaas", asaasRoutes);

// --- ROTAS DO EFÍ (Pix da mensalidade — cartão continua no Asaas acima) ---
app.use("/api/efi", efiRoutes);

// --- ROTAS DO ADMIN (super_admin) ---
app.use("/admin/estabelecimentos", adminEstabelecimentosRoutes);
app.use("/admin/operadores", adminOperadoresRoutes);

// --- ROTAS DO SISTEMA (estabelecimento / operador) ---
app.use("/api/estabelecimentos", estabelecimentoRoutes);
app.use("/api/categorias", categoriaRoutes);
app.use("/api/vendas", vendaRoutes);
app.use("/api/clientes", clienteRoutes);
app.use("/api/financeiro", financeiroRoutes);
app.use("/api/operadores", operadoresRoutes);
app.use("/api/auditoria",    auditoriaRoutes);
app.use("/api/inventario",   inventarioRoutes);
app.use("/api/fornecedores", fornecedoresRoutes);
app.use("/api/compras",      comprasRoutes);
app.use("/api/solicitacoes", solicitacoesRoutes);
app.use("/api/comunicados",  comunicadosRoutes);
app.use("/api/cobranca-notif", cobrancaNotifRoutes);
app.use("/api/notificacoes",  notificacoesRoutes);
app.use("/api/rastro",        rastroRoutes); // "cadastrado por / alterado por" dos cadastros
app.use("/api/consulta",       consultaRoutes); // consulta de CNPJ (BrasilAPI) para preencher o nome
app.use("/api/whatsapp/admin", whatsappAdminRoutes);
app.use("/api/whatsapp/loja", whatsappLojaRoutes);
app.use("/api/whatsapp/webhook", whatsappWebhookRoutes); // chamado pela Meta, sem login (assinatura conferida)

app.use("/superadmin", superAdminRoutes);

// --- ROTA INICIAL / TESTE ---
app.get("/", (req, res) => {
  res.status(200).send("Servidor do Gerenciador de Estabelecimentos online!");
});

// --- HEAD para uptime robot ---
app.head("/ping", (req, res) => res.status(200).end());

// --- GET para teste ---
app.get("/ping", (req, res) => res.status(200).send("pong"));

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`\n[INFO] Servidor rodando na porta ${PORT}`);
  console.log(`[STATUS] Acesse: http://localhost:${PORT}`);
  console.log("----------------------------------------\n");
});