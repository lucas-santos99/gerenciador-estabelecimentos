module.exports = function onlyMaster(req, res, next) {
  try {
    if (!req.user?.is_master) {
      return res.status(403).json({
        error: "Acesso restrito ao superadmin master"
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: "Erro de permissão" });
  }
};