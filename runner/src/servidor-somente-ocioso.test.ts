import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chaveFalsa, esperarAte, lerLinhasJson, logarClaude, portaLivre, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("servidor-somente-ocioso");
process.env.ANTHROPIC_API_KEY = chaveFalsa();
const TOKEN = "teste-" + "b".repeat(40);
fs.writeFileSync(path.join(amb.raiz, "runner.token"), TOKEN + "\n", { mode: 0o600 });
process.env.RUNNER_TOKEN_FILE = path.join(amb.raiz, "runner.token");
logarClaude(amb);

const { GerenteDeSessoes } = await import("./sessoes.js");
const { criarServidor } = await import("./servidor.js");
const { lerDescritor } = await import("./config-runner.js");

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
async function input(corpo: unknown): Promise<{ status: number; corpo: any }> {
  const r = await fetch(`http://127.0.0.1:${porta}/api/agents/${ID}/input`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json() };
}
const principal = gerente.principal;
const prompts = () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length;

test("somenteSeOcioso: agente ocupado responde 409 AGENTE_OCUPADO e não enfileira nem digita", async () => {
  await principal.subir("nova");
  await esperarAte(() => principal.estado.status === "idle", 8_000);
  principal.mudar({ status: "working", statusReason: "teste" });
  const antes = prompts();
  const r = await input({ text: "/compact", somenteSeOcioso: true });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.code, "AGENTE_OCUPADO");
  assert.match(r.corpo.error, /working/);
  assert.ok(r.corpo.howToFix);
  assert.equal(principal.tamanhoDaFila(), 0);
  assert.equal(prompts(), antes);
  principal.mudar({ status: "idle", statusReason: "teste" });
});

test("somenteSeOcioso: idle com mensagem na fila responde 409 e não acrescenta nada", async () => {
  principal.filaQuandoIdle.push({ texto: "esperando", em: Date.now() });
  const r = await input({ text: "/compact", somenteSeOcioso: true });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.code, "AGENTE_OCUPADO");
  assert.match(r.corpo.error, /fila/);
  assert.equal(principal.tamanhoDaFila(), 1);
  principal.filaQuandoIdle.length = 0;
});

test("somenteSeOcioso: idle com item em voo responde 409", async () => {
  principal.itemEmVoo = { texto: "digitando", em: Date.now() };
  const r = await input({ text: "/compact", somenteSeOcioso: true });
  assert.equal(r.status, 409);
  assert.match(r.corpo.error, /digitada/);
  principal.itemEmVoo = null;
});

test("somenteSeOcioso: idle e fila vazia entrega o texto como turno", async () => {
  const antes = prompts();
  const r = await input({ text: "olá com somenteSeOcioso", somenteSeOcioso: true });
  assert.equal(r.status, 202);
  assert.equal(r.corpo.success, true);
  await esperarAte(() => prompts() > antes, 12_000, "o texto chegar ao CLI");
});

test("somenteSeOcioso junto com injectWhenIdle responde 400 com o motivo", async () => {
  const r = await input({ text: "x", somenteSeOcioso: true, injectWhenIdle: true });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.success, false);
  assert.equal(r.corpo.code, "CAMPOS_INCOMPATIVEIS");
  assert.match(r.corpo.error, /somenteSeOcioso/);
});
