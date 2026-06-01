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

// --- IMPORTAÇÃO DAS ROTAS DO ADMIN ---
const adminEstabelecimentosRoutes = require("./routes/adminEstabelecimentosRoutes");
const adminOperadoresRoutes = require("./routes/adminOperadoresRoutes");
const superAdminRoutes = require("./routes/superAdminRoutes");

// Criar app
const app = express();
const PORT = process.env.PORT || 3001;

// --- MIDDLEWARES ---
app.use(express.json({ limit: "20mb" }));

// --- CORS CONFIGURAÇÃO ---
app.use(
  cors({
    origin: [
      "http://localhost:5173",

      // FRONTEND ANTIGO
      "https://gerenciador-mercearia-frontend.onrender.com",

      // FRONTEND NOVO
      "https://gerenciador-estabelecimentos-frontend.onrender.com",

      // VERCEL
      "https://gerenciador-estabelecimentos-fronte.vercel.app",
    ],
    credentials: true,
  })
);

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