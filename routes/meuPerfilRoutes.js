// routes/meuPerfilRoutes.js
// Perfil de quem está logado (dono, operador ou administrador): dados de exibição + foto.
//   GET    /api/meu-perfil
//   POST   /api/meu-perfil/foto      (multipart, campo "foto")
//   DELETE /api/meu-perfil/foto
// Foto: operador → operadores.foto_url; demais → profiles.foto_url. Sempre pelo padrão 'avatar'
// (otimizarImagem: ~400 px, ≤ 80 KB), guardada em perfis/<id>/ e a anterior é apagada.
const express = require("express");
const multer  = require("multer");
const router  = express.Router();

const db       = require("../db/supabaseAdmin");
const authUser = require("../middlewares/authUser");
const { registrar } = require("./auditoriaRoutes");
const { otimizarImagem } = require("../utils/otimizarImagem");
const { apagarAnterior } = require("../utils/storageLimpeza");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.use(authUser);

const ehOperador = (req) => req.user.role === "operator";

function rotuloPapel(req) {
  if (req.user.role === "merchant") return "Administrador da loja";
  if (req.user.role === "operator") return "Operador";
  return req.user.is_master ? "Super Admin (master)" : "Super Admin";
}

async function lerFoto(req) {
  if (ehOperador(req)) {
    const { data } = await db.from("operadores").select("foto_url, telefone").eq("id", req.user.id).maybeSingle();
    return { foto_url: data?.foto_url || null, telefone: data?.telefone || null };
  }
  const { data } = await db.from("profiles").select("*").eq("id", req.user.id).maybeSingle();
  return { foto_url: data?.foto_url || null, telefone: data?.telefone || null };
}

router.get("/", async (req, res) => {
  try {
    const { foto_url, telefone } = await lerFoto(req);
    let nome = req.user.nome;
    let loja = null;
    if (req.user.mercearia_id && !req.user.is_superadmin) {
      const { data: m } = await db.from("mercearias").select("*").eq("id", req.user.mercearia_id).maybeSingle();
      loja = m?.nome_fantasia || null;
      // Para o dono, o nome de exibição é o do cadastro (profiles.nome é espelho do nome da loja).
      if (req.user.role === "merchant" && m?.dono_nome) nome = m.dono_nome;
    }
    res.json({
      id: req.user.id, nome, email: req.user.email, telefone,
      papel: rotuloPapel(req), foto_url, loja,
    });
  } catch (err) {
    console.error("GET /api/meu-perfil", err);
    res.status(500).json({ error: "Erro ao carregar o perfil." });
  }
});

router.post("/foto", (req, res, next) => {
  upload.single("foto")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "Imagem maior que 5 MB." : "Erro ao receber a imagem.";
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo não enviado." });
    if (!req.file.mimetype?.startsWith("image/")) return res.status(400).json({ error: "Envie um arquivo de imagem." });

    const otim = await otimizarImagem(req.file.buffer, req.file.mimetype, "avatar");
    if (otim.erro) return res.status(400).json({ error: otim.erro });

    const id = req.user.id;
    const tabela = ehOperador(req) ? "operadores" : "profiles";
    const { data: antes, error: errLer } = await db.from(tabela).select("*").eq("id", id).maybeSingle();
    if (errLer) throw errLer;
    if (!antes) return res.status(404).json({ error: "Perfil não encontrado." });
    if (!ehOperador(req) && !("foto_url" in antes)) {
      return res.status(503).json({ error: "Foto de perfil ainda não ativada no banco (falta aplicar o SQL 42)." });
    }

    const arquivo = ehOperador(req) ? `operadores/${id}/${Date.now()}.${otim.ext}` : `perfis/${id}/${Date.now()}.${otim.ext}`;
    const { error: upErr } = await db.storage.from("logos")
      .upload(arquivo, otim.buffer, { upsert: true, contentType: otim.mimetype, cacheControl: "31536000" });
    if (upErr) return res.status(400).json({ error: upErr.message });
    const foto_url = db.storage.from("logos").getPublicUrl(arquivo).data.publicUrl;

    const { error } = await db.from(tabela).update({ foto_url }).eq("id", id);
    if (error) {
      await db.storage.from("logos").remove([arquivo]).catch(() => {});
      throw error;
    }
    await apagarAnterior(antes.foto_url, [`operadores/${id}/`, `perfis/${id}/`], foto_url);

    if (req.user.mercearia_id) {
      registrar({
        mercearia_id: req.user.mercearia_id, operador_id: ehOperador(req) ? id : null,
        usuario_nome: req.user.nome, usuario_email: req.user.email,
        modulo: "perfil", acao: "perfil_foto_enviada", descricao: "Trocou a própria foto de perfil",
      });
    }
    res.json({ success: true, foto_url });
  } catch (err) {
    console.error("POST /api/meu-perfil/foto", err);
    res.status(500).json({ error: "Erro ao enviar a foto." });
  }
});

router.delete("/foto", async (req, res) => {
  try {
    const id = req.user.id;
    const tabela = ehOperador(req) ? "operadores" : "profiles";
    const { data: antes } = await db.from(tabela).select("*").eq("id", id).maybeSingle();
    if (!antes?.foto_url) return res.status(400).json({ error: "Não há foto para remover." });
    const { error } = await db.from(tabela).update({ foto_url: null }).eq("id", id);
    if (error) throw error;
    await apagarAnterior(antes.foto_url, [`operadores/${id}/`, `perfis/${id}/`]);
    if (req.user.mercearia_id) {
      registrar({
        mercearia_id: req.user.mercearia_id, operador_id: ehOperador(req) ? id : null,
        usuario_nome: req.user.nome, usuario_email: req.user.email,
        modulo: "perfil", acao: "perfil_foto_removida", descricao: "Removeu a própria foto de perfil",
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/meu-perfil/foto", err);
    res.status(500).json({ error: "Erro ao remover a foto." });
  }
});

module.exports = router;
