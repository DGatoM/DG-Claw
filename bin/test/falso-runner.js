// Runner falso para o teste do dgclaw-card. Grava cada requisicao em $LOG (uma linha JSON com
// metodo, url, corpo e o cabecalho Authorization) e simula o ciclo de um card:
// criado dormindo -> /input -> working -> idle com resposta do assistente.
// Chaves de ambiente: RUNNER_BEARER (token esperado), MODO (normal|limite|sem-login|input-falha|nunca-termina|sem-turno|turno-lento|leitura-403|leitura-503|sem-contador|restaurado|lento-leitura|erro-turno|erro-campo|input-recusado|input-perdido|input-sem-capacidade|input-nao-acordou|working-sem-turno|stop-failure|ferramenta-com-erro-no-nome|sem-login-delete-falha|fila-parada|sem-hook|turno-com-fila|sem-processo|sem-campo-fila|item-em-voo|sem-turno-sem-total|erro-com-pendencia|erro-motivo-com-pendencia|turno-resumable).
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
      if (MODO === "sem-contador") return { id, status: c.status, naFilaTotal: 0, sessao: { tipo: "card", titulo: c.titulo, fila: 0 } };
      return { id, status: c.status, ...(c.erro ? { error: c.erro } : {}), ...(c.motivo ? { statusReason: c.motivo } : {}), turnosAceitos: c.turnos, turnosAceitosSessao: c.turnos, hookActive: MODO !== "sem-hook", ...(MODO === "sem-campo-fila" || MODO === "sem-turno-sem-total" ? {} : { naFilaTotal: (c.fila || 0) + (c.emVoo || 0) }), ...(MODO === "sem-campo-recibo" ? {} : { reciboPendente: c.recibo === true }), sessao: { tipo: "card", titulo: c.titulo, fila: c.fila || 0 } };
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
      if (MODO === "sem-login-delete-falha") return j(500, { success: false, code: "ERRO_INTERNO", error: "nao deu para remover" });
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
        if (MODO === "input-sem-capacidade") return j(503, { success: false, code: "SEM_CAPACIDADE", error: "sem memoria para acordar o card", howToFix: "esperar" });
        if (MODO === "input-nao-acordou") return j(500, { success: false, code: "NAO_ACORDOU", error: "o terminal nao subiu", howToFix: "ver o log" });
        if (MODO === "sem-login-delete-falha" ) return j(409, { success: false, code: "SEM_LOGIN", error: "O agente ainda nao entrou no Codex", howToFix: "login" });
        if (MODO === "input-falha") return j(500, { success: false, code: "ERRO_INTERNO", error: "estourou" });
        // input-recusado: 4xx, recusa comprovadamente anterior ao enfileiramento.
        if (MODO === "input-recusado") return j(400, { success: false, code: "PEDIDO_INVALIDO", error: "texto recusado" });
        // input-perdido: o texto e enfileirado, mas a resposta se perde (conexao derrubada).
        if (MODO === "input-perdido") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); return res.socket.destroy(); }
        // erro-campo: o card em idle com turnos 1, mas com o campo de erro preenchido (falha de turno conhecida).
        if (MODO === "erro-campo") { c.status = "resumable"; c.turnos = 1; c.erro = "o CLI caiu no meio do turno"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // working-sem-turno: o status vira working (ex.: compactacao), mas o contador de turnos fica em 0.
        if (MODO === "working-sem-turno") { c.status = "working"; c.motivo = "hook:PreCompact"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // ferramenta-com-erro-no-nome: turno aceito, rodando uma ferramenta cujo nome tem "error" (nao e falha).
        if (MODO === "ferramenta-com-erro-no-nome") { c.status = "working"; c.turnos = 1; c.motivo = "hook:PreToolUse mcp__logs__error_report"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // stop-failure: turno falhou por limite, so o statusReason diz.
        if (MODO === "stop-failure") { c.status = "working"; c.turnos = 1; c.motivo = "hook:StopFailure rate_limit"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // fila-parada: texto na fila, mas o card segue parado (sem terminal).
        if (MODO === "fila-parada") { c.fila = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // turno-com-fila: ha turno (de outra mensagem, ex.: digitada pelo painel), mas o texto do pedido segue na fila.
        if (MODO === "turno-com-fila") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "working"; c.turnos = 1; c.fila = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // sem-processo: card sem processo vivo (resumable) e contador zerado.
        if (MODO === "sem-processo") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "resumable"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // turno-resumable: o runner viu o turno (contador 1, fila vazia, sem recibo), mas o terminal ja fechou (resumable).
        if (MODO === "turno-resumable") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "resumable"; c.turnos = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // sem-campo-fila: turno aceito, mas a resposta nao traz sessao.fila.
        if (MODO === "sem-campo-fila") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "idle"; c.turnos = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // item-em-voo: turno aceito, sessao.fila 0, mas um texto esta sendo digitado agora (naFilaTotal 1).
        if (MODO === "item-em-voo") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "working"; c.turnos = 1; c.fila = 0; c.emVoo = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // recibo-pendente: turno aceito, fila e item em voo 0, mas o runner ainda espera o recibo do Enter (reciboPendente true).
        if (MODO === "recibo-pendente") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "working"; c.turnos = 1; c.fila = 0; c.recibo = true; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // sem-campo-recibo: turno aceito, tudo certo, mas a resposta nao traz reciboPendente (runner antigo).
        if (MODO === "sem-campo-recibo") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "working"; c.turnos = 1; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // erro-com-pendencia: erro de turno visto (de outra mensagem), mas o pedido segue na fila (turnos 1, naFilaTotal 1).
        if (MODO === "erro-com-pendencia") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "errored"; c.turnos = 1; c.fila = 1; c.erro = "falha na mensagem do painel"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // erro-motivo-com-pendencia: o mesmo, mas a falha so aparece no statusReason (StopFailure).
        if (MODO === "erro-motivo-com-pendencia") { c.msgs.push({ role: "user", text: JSON.parse(corpo).text }); c.status = "working"; c.turnos = 1; c.fila = 1; c.motivo = "hook:StopFailure rate_limit"; return j(202, { success: true, data: { enfileirado: true, acordando: true } }); }
        // sem-turno-sem-total: sem turno (contador 0, idle) e a resposta nao traz naFilaTotal.
        if (MODO === "sem-turno-sem-total") return j(202, { success: true, data: { enfileirado: true, acordando: true } });
        // sem-turno: 202 enfileirado, mas o CLI nunca aceita o pedido (nada na conversa, status parado, turnos 0).
        // sem-hook: igual ao sem-turno, mas o runner nunca recebeu hook do Claude (hookActive false).
        if (MODO === "sem-turno" || MODO === "sem-hook") return j(202, { success: true, data: { enfileirado: true, acordando: true } });
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
        if (c.status === "working" && MODO !== "nunca-termina" && MODO !== "working-sem-turno" && ++c.polls >= 2) { c.status = "idle"; c.msgs.push({ role: "assistant", text: "Resposta do card sobre: " + c.msgs[0].text }); }
        return j(200, { success: true, data: visao(m[1]) });
      }
    }
    j(404, { success: false, error: "rota desconhecida", code: "ROTA_INEXISTENTE" });
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.env.PORTA_ARQ, String(this.address().port)); });
