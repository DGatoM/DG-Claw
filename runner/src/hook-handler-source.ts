// O handler de hook, como TEXTO, para ser gravado ao lado do agente.
//
// Cópia deliberada de `apps/server/src/hook-handler-source.ts`. Duplicar em vez
// de importar é decisão, não descuido: o runner tem que compilar e rodar numa
// máquina onde `apps/server` não existe (a VPS do cliente), e um import
// cruzando os dois apps devolveria ao produto exatamente a dependência do
// Bunker que este trabalho veio cortar.
//
// O contrato que os dois lados precisam manter igual é pequeno e está todo
// aqui: agentId, nonce e event vão por ARGUMENTO (o stdin do Stop chega vazio
// em alguns ambientes), o resto vem do JSON do evento, e o POST vai para
// `/api/agent-hook` do processo que spawnou. Se um dia o Bunker mudar o formato
// do payload, é este arquivo que precisa mudar junto.
//
// Duas invariantes que não podem ser perdidas numa futura edição: ele SEMPRE
// sai com código 0, e nunca segura o turno do agente por mais de ~2,5s. Um hook
// que falha barulhento, ou que demora, trava a conversa de um cliente.
export const HOOK_HANDLER_SOURCE = String.raw`import http from "node:http";
import fs from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const event = arg("--event") || "?";
const agentId = arg("--agent") || "";
const port = parseInt(arg("--port") || "0", 10);
const nonce = arg("--nonce") || "";

// Lê o JSON do evento do stdin (best-effort; pode vir vazio no Stop).
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch { /* stdin fechado ou vazio: o evento segue só com os argumentos */ }
let ev = {};
try { ev = JSON.parse(stdin) || {}; } catch { /* corpo que não é JSON: segue sem os campos extras do evento */ }

const payload = JSON.stringify({
  agentId,
  nonce,
  event,
  cwd: ev.cwd || null,
  sessionId: ev.session_id || process.env.CLAUDE_CODE_SESSION_ID || null,
  toolName: ev.tool_name || null,
  source: ev.source || null,
  error: ev.error || null,
  lastAssistantMessage: typeof ev.last_assistant_message === "string" ? ev.last_assistant_message.slice(0, 500) : null,
});

// Sem destino válido, não faz nada e sai limpo.
if (!agentId || !port) process.exit(0);

// Um POST perdido deixa o runner achando que o turno nunca acabou. Erro de conexão
// ou timeout ganham UMA segunda tentativa depois de ~300ms; o cinto abaixo manda
// em tudo e continua em 2,5s.
function enviar(tentativa) {
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/agent-hook",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 1000,
    },
    (res) => {
      res.resume();
      res.on("end", () => process.exit(0));
    },
  );
  const falhou = () => {
    try { req.destroy(); } catch { /* a conexão já caiu: não há o que destruir */ }
    if (tentativa === 1) setTimeout(() => enviar(2), 300);
    else process.exit(0);
  };
  let tratado = false;
  const uma = () => { if (tratado) return; tratado = true; falhou(); };
  req.on("error", uma);
  req.on("timeout", uma);
  req.write(payload);
  req.end();
}
enviar(1);

// Cinto de segurança: nunca segura o turno do agente além de ~2,5s.
const t = setTimeout(() => process.exit(0), 2500);
if (t && typeof t.unref === "function") t.unref();
`;
