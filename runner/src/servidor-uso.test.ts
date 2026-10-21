import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { portaLivre, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("servidor-uso");
const TOKEN = "teste-" + "b".repeat(40);
fs.writeFileSync(path.join(amb.raiz, "runner.token"), TOKEN + "\n", { mode: 0o600 });
process.env.RUNNER_TOKEN_FILE = path.join(amb.raiz, "runner.token");

const { GerenteDeSessoes } = await import("./sessoes.js");
const { criarServidor } = await import("./servidor.js");
const { lerDescritor } = await import("./config-runner.js");
const { escreverSettings } = await import("./sessao/configuracao.js");

const porta = await portaLivre();
const descritor = lerDescritor();
const gerente = new GerenteDeSessoes(descritor, porta);
const servidor: http.Server = criarServidor(gerente);
await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
test.after(() => {
  gerente.pararTodas("fim dos testes");
  servidor.closeAllConnections?.();
  servidor.close();
});

const ID = descritor.id;
const principal = gerente.principal;
const NONCE = "ab".repeat(32);
principal.nonce = NONCE;
const EPOCH = Math.floor(Date.now() / 1000) + 3600;

async function req(metodo: string, rota: string, corpo?: unknown, comToken = true): Promise<{ status: number; corpo: any }> {
  const r = await fetch(`http://127.0.0.1:${porta}${rota}`, {
    method: metodo,
    headers: {
      ...(comToken ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json() };
}

test("GET /api/agents/:id/uso: nunca medido devolve janelas null (nunca 0) e o motivo", async () => {
  const r = await req("GET", `/api/agents/${ID}/uso`);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ok, true);
  assert.equal(r.corpo.uso.sessao_5h, null);
  assert.equal(r.corpo.uso.semanal, null);
  assert.equal(r.corpo.uso.medido_em, null);
  assert.equal(r.corpo.uso.provedor, "claude");
  assert.match(r.corpo.motivo, /próxima resposta do agente/);
});

test("GET /api/agents/:id/uso exige o token do runner", async () => {
  const r = await req("GET", `/api/agents/${ID}/uso`, undefined, false);
  assert.equal(r.status, 401);
});

test("POST /api/agent-uso: nonce errado é recusado; nonce certo guarda e a rota GET mostra", async () => {
  const corpo = { agentId: ID, rate_limits: { five_hour: { used_percentage: 33, resets_at: EPOCH } } };
  const ruim = await req("POST", "/api/agent-uso", { ...corpo, nonce: "x".repeat(64) }, false);
  assert.equal(ruim.status, 401);
  assert.ok(ruim.corpo.howToFix);
  const outro = await req("POST", "/api/agent-uso", { ...corpo, agentId: "outro", nonce: NONCE }, false);
  assert.equal(outro.status, 404);
  const certo = await req("POST", "/api/agent-uso", { ...corpo, nonce: NONCE }, false);
  assert.equal(certo.status, 200);
  assert.equal(certo.corpo.guardou, true);
  const r = await req("GET", `/api/agents/${ID}/uso`);
  assert.equal(r.corpo.motivo, undefined);
  assert.equal(r.corpo.uso.sessao_5h.usado_pct, 33);
  assert.equal(r.corpo.uso.sessao_5h.vencida, false);
  assert.equal(r.corpo.uso.semanal, null);
  assert.equal(r.corpo.uso.fonte, "statusline");
  assert.ok(fs.existsSync(path.join(amb.estado, "uso.json")));
});

test("POST /api/agent-uso com rate_limits sem nada válido não apaga a medição guardada", async () => {
  const r = await req("POST", "/api/agent-uso", { agentId: ID, nonce: NONCE, rate_limits: { five_hour: { used_percentage: 500, resets_at: EPOCH } } }, false);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.guardou, false);
  const g = await req("GET", `/api/agents/${ID}/uso`);
  assert.equal(g.corpo.uso.sessao_5h.usado_pct, 33);
});

test("settings do Claude levam o statusLine do medidor, sem sobrescrever o de outro dono", () => {
  const arquivo = (): any => JSON.parse(fs.readFileSync(path.join(amb.estado, "runner-hooks", `${ID}.settings.json`), "utf8"));
  assert.ok(escreverSettings(principal, NONCE));
  const sl = arquivo().statusLine;
  assert.equal(sl.type, "command");
  assert.match(sl.command, /runner-uso\.mjs" --agent .* --port \d+ --nonce [0-9a-f]{64}/);
  assert.ok(fs.existsSync(path.join(amb.estado, "runner-hooks", "runner-uso.mjs")));

  // O settings do usuário não conta: o --settings do spawn ganha dele no Claude Code real.
  fs.writeFileSync(path.join(amb.claudeDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo oi" } }));
  escreverSettings(principal, NONCE);
  assert.match(arquivo().statusLine.command, /runner-uso\.mjs/, "medidor entra mesmo com statusLine no settings do usuário");
  fs.rmSync(path.join(amb.claudeDir, "settings.json"));

  (principal.descritor.config as { statusLine?: unknown }).statusLine = { type: "command", command: "echo oi" };
  escreverSettings(principal, NONCE);
  assert.equal(arquivo().statusLine, undefined, "statusLine do descritor é respeitado");
  assert.match(fs.readFileSync(amb.logDoRunner, "utf8"), /statusLine próprio/);
});

test("falha no arquivo do medidor desliga só o statusLine e mantém as regras de permissão", () => {
  // Revisão adversarial do PR #58: antes, a exceção derrubava o settings inteiro.
  const cfg = principal.descritor.config as { statusLine?: unknown; denyTools?: string[] };
  delete cfg.statusLine;
  cfg.denyTools = ["Bash(rm:*)"];
  const usoHandler = path.join(amb.estado, "runner-hooks", "runner-uso.mjs");
  fs.rmSync(usoHandler, { force: true });
  fs.mkdirSync(usoHandler); // um diretório no lugar do arquivo: ler e gravar falham
  try {
    const arquivo = escreverSettings(principal, NONCE);
    assert.ok(arquivo, "o settings continua sendo escrito");
    const st = JSON.parse(fs.readFileSync(arquivo!, "utf8"));
    assert.equal(st.statusLine, undefined);
    assert.deepEqual(st.permissions.deny, ["Bash(rm:*)"]);
    assert.ok(st.hooks.PreToolUse);
  } finally {
    fs.rmSync(usoHandler, { recursive: true, force: true });
    delete cfg.denyTools;
  }
});
