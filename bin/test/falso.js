// Servidor falso: faz de API do Telegram e de runner. Grava cada requisicao em $LOG (uma linha JSON).
const http = require("http");
const fs = require("fs");
const LOG = process.env.LOG;
const VALIDO = process.env.BOT_VALIDO;
const COM_MENSAGEM = process.env.COM_MENSAGEM === "1";
http.createServer((req, res) => {
  fs.appendFileSync(LOG, JSON.stringify({ metodo: req.method, url: req.url, auth: req.headers.authorization || null }) + "\n");
  const j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
  if (m) {
    if (m[1] !== VALIDO) return j(401, { ok: false, description: "Unauthorized" });
    if (m[2] === "getMe") return j(200, { ok: true, result: { id: 1, is_bot: true, username: "meu_teste_bot" } });
    if (m[2] === "getUpdates") {
      const r = COM_MENSAGEM ? [
        { update_id: 1, message: { chat: { id: 555111, type: "private" }, from: { first_name: "Maria", last_name: "Silva", username: "maria_s" }, text: "/start" } },
        { update_id: 2, message: { chat: { id: 555111, type: "private" }, from: { first_name: "Maria" }, text: "oi" } },
        { update_id: 3, message: { chat: { id: -100, type: "group" }, from: { first_name: "Grupo" }, text: "x" } },
      ] : [];
      return j(200, { ok: true, result: r });
    }
  }
  if (/^\/api\/agents\/[^/]+\/reiniciar$/.test(req.url) && req.method === "POST") {
    if (req.headers.authorization !== "Bearer " + process.env.RUNNER_BEARER) return j(401, { erro: "sem permissao" });
    return j(202, { ok: true, sessao: "s1", modo: "mesma-conversa" });
  }
  j(404, { erro: "rota desconhecida" });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.env.PORTA_ARQ, String(this.address().port)); });
