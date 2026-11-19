// Runner falso para o teste do dgclaw-card. Grava cada requisicao em $LOG (uma linha JSON com
// metodo, url, corpo e o cabecalho Authorization) e simula o ciclo de um card:
// criado dormindo -> /input -> working -> idle com resposta do assistente.
// Chaves de ambiente: RUNNER_BEARER (token esperado), MODO (normal|limite|sem-login|input-falha|nunca-termina|sem-turno|turno-lento|leitura-403|leitura-503|sem-contador|restaurado|lento-leitura|erro-turno|erro-campo|input-recusado|input-perdido).
const http = require("http");
const fs = require("fs");
const LOG = process.env.LOG;
const MODO = process.env.MODO || "normal";
const cards = new Map(); // id -> { titulo, provedor, auth, modelo, msgs, polls, status }

http.createServer((req, res) => {
  let corpo = "";
  req.on("data", (c) => { corpo += c; });
  req.on("end", () => {
    fs.appendFileSync(LOG, JSON.stringify({ metodo: req.method, url: req.url, corpo, auth: req.headers.authorization || null }) + "\n");
    const j = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== "Bearer " + process.env.RUNNER_BEARER) {
      return j(401, { success: false, error: "o token enviado esta errado", howToFix: "mande o Bearer certo", code: "TOKEN_ERRADO" });
    }
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const visao = (id) => {
      const c = cards.get(id);
      // turno-lento: o pedido so vira turno ~2 s depois do /input (o 202 sai antes, como no runner de verdade).
      if (c.viraEm && Date.now() >= c.viraEm) { c.viraEm = 0; c.status = "working"; c.turnos = 1; c.polls = 0; }
      // sem-contador: runner que nao informa turnosAceitos.
      if (MODO === "sem-contador") return { id, status: c.status, sessao: { tipo: "card", titulo: c.titulo, fila: 0 } };
      return { id, status: c.status, ...(c.erro ? { error: c.erro } : {}), turnosAceitos: c.turnos, turnosAceitosSessao: c.turnos, sessao: { tipo: "card", titulo: c.titulo, fila: 0 } };
    };
    let m;
    if (p === "/api/sessoes" && req.method === "POST") {
      if (MODO === "limite") {
        return j(429, { success: false, code: "LIMITE_DE_SESSOES", error: "Ja existem 3 sessoes criadas por API e o limite e 3. Nao criei outra.", howToFix: "fechar uma" });
      }
      const b = JSON.parse(corpo);
      const id = b.id || "card-abc123";
      cards.set(id, { titulo: b.titulo, provedor: b.provedor, auth: b.auth || "assinatura", modelo: b.modelo || "", msgs: [], polls: 0, status: "stopped", turnos: 0, viraEm: 0 });
      return j(201, { success: true, data: visao(id) });
    }
    if ((m = p.match(/^\/api\/sessoes\/([^/]+)$/)) && req.method === "DELETE") {
      if (!cards.delete(m[1])) return j(404, { success: false, code: "SESSAO_INEXISTENTE", error: "Este runner nao tem a sessao " + m[1], howToFix: "ver GET /api/agents?todas=1" });
      return j(200, { success: true, data: { removida: true } });
    }
    if (p === "/api/agents" && req.method === "GET") {
      const lista = [{ id: "principal", status: "idle", sessao: { tipo: "principal" } }, { id: "bast", status: "idle", sessao: { tipo: "bastidores", titulo: "Bastidores" } }];
      for (const id of cards.keys()) lista.push(visao(id));
      return j(200, { success: true, data: lista });
    }
    if (p === "/api/provedor" && req.method === "GET") {
      const c = cards.get(u.searchParams.get("sessao"));
      if (!c) return j(404, { success: false, code: "SESSAO_INEXISTENTE", error: "sem essa sessao", howToFix: "listar" });
      return j(200, { sessao: u.searchParams.get("sessao"), provedor: c.provedor, auth: c.auth, modelo: c.modelo });
    }
    if ((m = p.match(/^\/api\/agents\/([^/]+)(\/input|\/conversation)?$/))) {
      const c = cards.get(m[1]);
      if (!c) return j(404, { success: false, code: "AGENTE_DE_OUTRO_RUNNER", error: "pedido para " + m[1], howToFix: "ver o card" });
      if (m[2] === "/input" && req.method === "POST") {
        if (MODO === "sem-login") return j(409, { success: false, code: "SEM_LOGIN", error: "O agente ainda nao entrou no Codex", howToFix: "login" });
        if (MODO === "input-falha") return j(500, { success: false, code: "ERRO_INTERNO", error: "estourou" });
        // input-recusado: 4xx, recusa comprovadamente anterior ao enfileiramento.
        if (MODO === "input-recusado") return j(400, { success: false, code: "PEDIDO_INVALIDO", error: "texto recusado" });
        // input-perdido: o texto e enfileirado, mas a resposta se perde (conexao derrubada).
        if (MODO === "input-perdido") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); return res.socket.destroy(); }
        // erro-campo: o card em idle com turnos 1, mas com o campo de erro preenchido (falha de turno conhecida).
        if (MODO === "erro-campo") { c.status = "resumable"; c.turnos = 1; c.erro = "o CLI caiu no meio do turno"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // sem-turno: 202 enfileirado, mas o CLI nunca aceita o pedido (nada na conversa, status parado, turnos 0).
        if (MODO === "sem-turno") return j(202, { success: true, data: { enfileirado: true, acordando: true } });
        c.msgs.push({ role: "user", text: JSON.parse(corpo).text });
        // restaurado: runner reiniciado (contador zerado), mas a conversa atual ja tem resposta do agente.
        if (MODO === "restaurado") { c.status = "idle"; c.msgs.push({ role: "assistant", text: "Ja respondi antes do reinicio." }); return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // erro-turno: o pedido virou turno e o card caiu em erro.
        if (MODO === "erro-turno") { c.status = "errored"; c.turnos = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        if (MODO === "turno-lento") { c.viraEm = Date.now() + 2000; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        c.status = "working"; c.polls = 0; c.turnos = 1;
        return j(202, { success: true, data: { enfileirado: true, acordando: true } });
      }
      if (m[2] === "/conversation") return j(200, { success: true, data: c.msgs.slice(-Number(u.searchParams.get("limit") || 6)) });
      if (!m[2]) {
        // leitura-403/503: so a leitura do estado de UM card falha; criar, enviar e apagar seguem normais.
        if (MODO === "lento-leitura") { return setTimeout(() => j(200, { success: true, data: visao(m[1]) }), 6000); }
        if (MODO === "leitura-403") return j(403, { success: false, error: "sem permissao para ler este card", code: "PROIBIDO" });
        if (MODO === "leitura-503") return j(503, { success: false, error: "runner ocupado", code: "INDISPONIVEL" });
        if (c.status === "working" && MODO !== "nunca-termina" && ++c.polls >= 2) { c.status = "idle"; c.msgs.push({ role: "assistant", text: "Resposta do card sobre: " + c.msgs[0].text }); }
        return j(200, { success: true, data: visao(m[1]) });
      }
    }
    j(404, { success: false, error: "rota desconhecida", code: "ROTA_INEXISTENTE" });
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.env.PORTA_ARQ, String(this.address().port)); });
