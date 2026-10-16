import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pastaTemporaria } from "./apoio-teste.js";

// O config-runner lê o ambiente e chama process.exit na hora do import, então cada caso
// roda num processo filho com o ambiente que quer testar.
const MODULO = fileURLToPath(new URL("./config-runner.js", import.meta.url));

function carregar(env: Record<string, string>, descritor?: unknown | string) {
  const raiz = pastaTemporaria("config");
  const arquivo = path.join(raiz, "runner.json");
  if (descritor !== undefined) fs.writeFileSync(arquivo, typeof descritor === "string" ? descritor : JSON.stringify(descritor));
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(MODULO)}); console.log(JSON.stringify({ d: m.lerDescritor(), estado: m.STATE_FILE, pasta: m.PASTA_DE_ESTADO, porta: m.PORTA }))`],
    { env: { PATH: process.env.PATH!, RUNNER_AGENT_FILE: arquivo, RUNNER_PORT: "4399", ...env }, encoding: "utf8" },
  );
  return { raiz, arquivo, status: r.status, saida: r.stdout, erro: r.stderr };
}

test("descritor válido carrega, e a pasta de estado é a do RUNNER_STATE_FILE, não a do descritor", () => {
  const raiz = pastaTemporaria("config-cwd");
  const estado = path.join(pastaTemporaria("config-estado"), "runner-state.json");
  const r = carregar({ RUNNER_STATE_FILE: estado }, { id: "a1", slug: "agente", config: { name: "x", cwd: raiz, initialPrompt: "", provider: "local-cli" } });
  assert.equal(r.status, 0, r.erro);
  const o = JSON.parse(r.saida);
  assert.equal(o.d.id, "a1");
  assert.equal(o.d.slug, "agente");
  assert.equal(o.estado, estado);
  assert.equal(o.pasta, path.dirname(estado));
  assert.equal(o.porta, 4399);
});

test("sem RUNNER_STATE_FILE, o estado fica ao lado do descritor (o host: as duas pastas coincidem)", () => {
  const cwd = pastaTemporaria("config-cwd2");
  const r = carregar({}, { id: "a1", slug: "agente", config: { name: "x", cwd, initialPrompt: "", provider: "local-cli" } });
  assert.equal(r.status, 0, r.erro);
  const o = JSON.parse(r.saida);
  assert.equal(o.pasta, path.dirname(r.arquivo));
});

test("descritor sem campos obrigatórios: sai com código 1 dizendo quais faltam", () => {
  const r = carregar({}, { slug: "agente", config: { name: "x" } });
  assert.equal(r.status, 1);
  assert.match(r.erro, /está sem: id, config\.cwd/);
  assert.match(r.erro, /O que fazer: preencher os campos que faltam/);
  const semConfig = carregar({}, { id: "a", slug: "b" });
  assert.equal(semConfig.status, 1);
  assert.match(semConfig.erro, /está sem: config, config\.cwd/);
});

test("descritor que não é JSON, casa inexistente e arquivo ausente: erro que se explica", () => {
  const quebrado = carregar({}, "{ nao e json");
  assert.equal(quebrado.status, 1);
  assert.match(quebrado.erro, /não é JSON válido/);
  const semCasa = carregar({}, { id: "a", slug: "b", config: { name: "x", cwd: "/nao/existe/mesmo" } });
  assert.equal(semCasa.status, 1);
  assert.match(semCasa.erro, /a casa do agente não existe: \/nao\/existe\/mesmo/);
  const semArquivo = carregar({});
  assert.equal(semArquivo.status, 1);
  assert.match(semArquivo.erro, /não consegui ler o descritor/);
});

test("ambiente incompleto: RUNNER_AGENT_FILE ou RUNNER_PORT ausentes ou inválidos derrubam o processo com o motivo", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(MODULO)})`], { env: { PATH: process.env.PATH! }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a variável RUNNER_AGENT_FILE não veio no ambiente/);
  const porta = carregar({ RUNNER_PORT: "99999" }, { id: "a", slug: "b", config: { name: "x", cwd: "/tmp" } });
  assert.equal(porta.status, 1);
  assert.match(porta.erro, /RUNNER_PORT="99999" não é uma porta válida/);
});
