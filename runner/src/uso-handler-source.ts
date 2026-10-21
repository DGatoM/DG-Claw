// O handler do `statusLine` do Claude Code, como TEXTO, gravado ao lado do hook de status.
//
// O Claude chama este comando a cada atualização da linha de status e passa no stdin um JSON
// grande (caminho da pasta, custo, modelo...). Daquilo só `rate_limits` sai do processo: o resto
// nunca é enviado, nem logado. O formato de `rate_limits` e o limite de um POST a cada 15 s se
// inspiram no projeto Orca (MIT, Copyright (c) 2026 Lovecast Inc., https://github.com/stablyai/orca).
//
// Invariantes, as mesmas do hook de status: SEMPRE sai com código 0 e nunca segura o Claude por
// mais de ~2 s. A saída é vazia de propósito: o statusLine aparece no terminal do agente, e uma
// linha com número ali só atrapalharia a leitura da conversa.
export const USO_HANDLER_SOURCE = String.raw`import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERVALO_MS = 15000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const agentId = arg("--agent") || "";
const port = parseInt(arg("--port") || "0", 10);
const nonce = arg("--nonce") || "";

// Cinto de segurança: nunca segura o Claude além de ~2s.
const t = setTimeout(() => process.exit(0), 2000);
if (t && typeof t.unref === "function") t.unref();

let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch { /* stdin fechado: não há o que medir */ }
let ev = {};
try { ev = JSON.parse(stdin) || {}; } catch { /* corpo que não é JSON: não há o que medir */ }

const limites = ev && typeof ev === "object" ? ev.rate_limits : null;
if (!agentId || !port || !limites || typeof limites !== "object") process.exit(0);

// Throttle por arquivo de carimbo: o Claude chama a cada tecla e a cada resposta.
const carimbo = path.join(path.dirname(fileURLToPath(import.meta.url)), agentId + ".uso.carimbo");
try {
  const idade = Date.now() - fs.statSync(carimbo).mtimeMs;
  if (idade >= 0 && idade < INTERVALO_MS) process.exit(0);
} catch { /* sem carimbo ainda: é a primeira medição */ }
try { fs.writeFileSync(carimbo, String(Date.now())); } catch { /* sem carimbo, o runner só recebe mais POSTs; não é falha */ }

const payload = JSON.stringify({ agentId, nonce, rate_limits: limites });
const req = http.request(
  {
    host: "127.0.0.1",
    port,
    path: "/api/agent-uso",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    timeout: 1000,
  },
  (res) => { res.resume(); res.on("end", () => process.exit(0)); },
);
req.on("error", () => process.exit(0));
req.on("timeout", () => { try { req.destroy(); } catch { /* já caiu */ } process.exit(0); });
req.write(payload);
req.end();
`;
