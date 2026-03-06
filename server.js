// ===== server.js =====

// Carregar .env apenas em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const db = require('./db/supabaseAdmin');

// --- IMPORTAÇÃO DAS ROTAS DO SISTEMA (PAINEL ESTABELECIMENTO/OPERADOR) ---
const estabelecimentoRoutes = require('./routes/estabelecimentoRoutes');
const categoriaRoutes = require('./routes/categoriaRoutes');
const vendaRoutes = require('./routes/vendaRoutes');
const clienteRoutes = require('./routes/clienteRoutes');
const financeiroRoutes = require('./routes/financeiroRoutes');

// --- IMPORTAÇÃO DAS ROTAS DO ADMIN ---
const adminEstabelecimentosRoutes = require("./routes/adminEstabelecimentosRoutes");
const adminOperadoresRoutes = require("./routes/adminOperadoresRoutes");

// Criar app
const app = express();
const PORT = process.env.PORT || 3001;

// --- MIDDLEWARES ---
app.use(express.json({ limit: '20mb' }));

// --- CORS CONFIGURAÇÃO ---
app.use(
  cors({
    origin: [
      "http://localhost:5173",  // Para local
      "https://gerenciador-estabelecimentos-frontend.onrender.com"  // Para produção
    ],
    credentials: true,  // Permite o envio de cookies (importante!)
  })
);

// --- ROTAS DO ADMIN (super_admin) ---
app.use("/admin/estabelecimentos", adminEstabelecimentosRoutes);
app.use("/admin/operadores", adminOperadoresRoutes);

// --- ROTAS DO SISTEMA (estabelecimento / operador) ---
app.use('/api/estabelecimentos', estabelecimentoRoutes);
app.use('/api/categorias', categoriaRoutes);
app.use('/api/vendas', vendaRoutes);
app.use('/api/clientes', clienteRoutes);
app.use('/api/financeiro', financeiroRoutes);

// --- ROTA INICIAL / TESTE ---
app.get('/', (req, res) => {
  res.status(200).send('Servidor do Gerenciador de Estabelecimentos online!');
});

// --- HEAD para uptime robot ---
app.head('/ping', (req, res) => res.status(200).end());

// --- GET para teste ---
app.get('/ping', (req, res) => res.status(200).send('pong'));

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`\n[INFO] Servidor rodando na porta ${PORT}`);
  console.log(`[STATUS] Acesse: http://localhost:${PORT}`);
  console.log('----------------------------------------\n');
});
