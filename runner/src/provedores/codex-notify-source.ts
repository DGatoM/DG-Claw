// O handler de `notify` do Codex, como TEXTO, para ser gravado na pasta de hooks.
//
// Porta de `codex-notify-source.ts` do Bunker. O Codex não tem hooks por `--settings`;
// o análogo é o `notify` (programa chamado com o JSON do evento como ÚLTIMO argumento,
// não no stdin), injetado por spawn com `-c notify=[...]`, sem tocar no config.toml.
// O único evento documentado é `agent-turn-complete`, o "Stop" do Codex.
//
// Mesmas invariantes do hook do Claude: sai SEMPRE com código 0, nunca segura o
// turno por mais de ~2,5 s, e só avisa mudança de status. O evento nunca injeta
// texto nem comando e o handler não devolve conteúdo da sessão para ninguém.
export const CODEX_NOTIFY_SOURCE = String.raw`import http from "node:http";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const agentId = arg("--agent") || "";
const port = parseInt(arg("--port") || "0", 10);
const nonce = arg("--nonce") || "";

// O Codex APENDA o JSON do evento como último argv, depois dos nossos flags.
let ev = {};
const last = process.argv[process.argv.length - 1] || "";
if (last.startsWith("{")) {
  try { ev = JSON.parse(last) || {}; } catch { ev = {}; }
}

// Só o fim de turno interessa; qualquer outro tipo passa sem efeito.
if (ev["type"] !== "agent-turn-complete" || !agentId || !port) process.exit(0);

const payload = JSON.stringify({
  agentId,
  nonce,
  event: "Stop",
  sessionId: typeof ev["thread-id"] === "string" ? ev["thread-id"] : null,
});

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
    timeout: 2000,
  },
  (res) => {
    res.resume();
    res.on("end", () => process.exit(0));
  },
);

req.on("error", () => process.exit(0));
req.on("timeout", () => { try { req.destroy(); } catch {} process.exit(0); });
req.write(payload);
req.end();

const t = setTimeout(() => process.exit(0), 2500);
if (t && typeof t.unref === "function") t.unref();
`;
