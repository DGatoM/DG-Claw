// A entrada conferir-conta-cli.js (usada por scripts/_lib/restricoes-rotina.sh): código 0 ou 1, motivo no stderr,
// ferramentas negadas no stdout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "conferir-conta-cli.js");
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "cli-conta-"));
test.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
fs.mkdirSync(path.join(pasta, "bin"));
fs.writeFileSync(path.join(pasta, "bin", "claude"), '#!/bin/sh\nprintf "%s\\n" "$FALSO_CONTA"\n', { mode: 0o755 });
fs.writeFileSync(path.join(pasta, "runner.json"), JSON.stringify({ config: { denyTools: ["Bash", "Monitor"] } }));

function rodar(restricoes: string | null, conta: string) {
  const arq = path.join(pasta, "restricoes.json");
  if (restricoes === null) fs.rmSync(arq, { force: true });
  else fs.writeFileSync(arq, restricoes);
  return spawnSync(process.execPath, [CLI, "rotina-teste"], {
    encoding: "utf8",
    env: { PATH: `${path.join(pasta, "bin")}:${process.env.PATH}`, HOME: pasta, FALSO_CONTA: conta, RUNNER_RESTRICOES_FILE: arq, RUNNER_AGENT_FILE: path.join(pasta, "runner.json") },
  });
}
const TRAVA = '{"versao":1,"sem_bash":true}';
const PESSOAL = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}';
const ORG = '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"enterprise"}';

test("sem restrição: código 0 e nada no stdout, mesmo com conta de organização", () => {
  const r = rodar(null, ORG);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
test("restrição e conta pessoal: código 0 e as ferramentas negadas, uma por linha", () => {
  const r = rodar(TRAVA, PESSOAL);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "Bash\nMonitor\n");
});
test("restrição e conta de organização: código 1 e o motivo em português no stderr", () => {
  const r = rodar(TRAVA, ORG);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /rotina-teste: RECUSADA/);
  assert.match(r.stderr, /Team\/Enterprise/);
  assert.match(r.stderr, /O que fazer/);
});
test("restrição e conta ilegível: código 1", () => {
  assert.equal(rodar(TRAVA, "").status, 1);
});
test("restrições.json inválido: código 1", () => {
  assert.equal(rodar("{lixo", PESSOAL).status, 1);
});
