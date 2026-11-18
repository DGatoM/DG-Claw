import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

prepararAmbiente("conversa");
const { lerConversa } = await import("./conversa.js");

const ATUAL = "aaaaaaaa-0000-4000-8000-000000000011";
const ANTES = "bbbbbbbb-0000-4000-8000-000000000012";

function transcriptClaude(config: string, id: string, textos: Array<[string, string]>): void {
  const arq = path.join(config, "projects", "proj", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, textos.map(([role, text]) => JSON.stringify({ type: role, message: { role, content: text } })).join("\n") + "\n");
}

function rollout(home: string, id: string, textos: Array<[string, string]>): void {
  const d = new Date();
  const dir = path.join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const linhas = textos.map(([role, text]) =>
    JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } }),
  );
  fs.writeFileSync(path.join(dir, `rollout-2026-11-18T10-00-00-${id}.jsonl`), linhas.join("\n") + "\n");
}

test("Claude: a sessão atual tem transcript, então não há aviso nem uso da anterior", () => {
  const config = pastaTemporaria("conv-claude-1");
  transcriptClaude(config, ATUAL, [["user", "pedido novo"]]);
  transcriptClaude(config, ANTES, [["user", "pedido velho"]]);
  const r = lerConversa({ provedor: "claude", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: config, codexHome: pastaTemporaria("ch1") });
  assert.deepEqual(r.msgs, [{ role: "user", text: "pedido novo" }]);
  assert.equal(r.aviso, undefined);
});

test("Claude: sem transcript da atual, devolve a anterior com aviso", () => {
  const config = pastaTemporaria("conv-claude-2");
  transcriptClaude(config, ANTES, [["user", "pedido velho"], ["assistant", "feito"]]);
  const r = lerConversa({ provedor: "claude", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: config, codexHome: pastaTemporaria("ch2") });
  assert.deepEqual(r.msgs.map((m) => m.text), ["pedido velho", "feito"]);
  assert.match(r.aviso ?? "", /sessão anterior/);
});

test("Claude: sem transcript da atual e sem anterior, a lista vem vazia e sem aviso", () => {
  const config = pastaTemporaria("conv-claude-3");
  const r = lerConversa({ provedor: "claude", sessionId: ATUAL, previousSessionId: null, limite: 6, configDir: config, codexHome: pastaTemporaria("ch3") });
  assert.deepEqual(r, { msgs: [] });
  const r2 = lerConversa({ provedor: "claude", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: config, codexHome: pastaTemporaria("ch3b") });
  assert.deepEqual(r2, { msgs: [] }, "anterior sem arquivo também não inventa nada");
});

test("Codex: sem rollout da atual, devolve o rollout da anterior com aviso", () => {
  const home = pastaTemporaria("conv-codex-1");
  rollout(home, ANTES, [["user", "pedido velho"], ["assistant", "resposta velha"]]);
  const r = lerConversa({ provedor: "codex", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: null, codexHome: home });
  assert.deepEqual(r.msgs.map((m) => m.text), ["pedido velho", "resposta velha"]);
  assert.match(r.aviso ?? "", /sessão anterior/);
});

test("Codex: com rollout da atual, ele é usado e a anterior é ignorada", () => {
  const home = pastaTemporaria("conv-codex-2");
  rollout(home, ATUAL, [["user", "pedido novo"]]);
  rollout(home, ANTES, [["user", "pedido velho"]]);
  const r = lerConversa({ provedor: "codex", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: null, codexHome: home });
  assert.deepEqual(r.msgs, [{ role: "user", text: "pedido novo" }]);
  assert.equal(r.aviso, undefined);
});

test("troca de motor: sessão atual no Codex e anterior no Claude (e o inverso) também aparece", () => {
  const config = pastaTemporaria("conv-troca-c");
  transcriptClaude(config, ANTES, [["user", "veio do Claude"]]);
  const a = lerConversa({ provedor: "codex", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: config, codexHome: pastaTemporaria("ch-troca-a") });
  assert.deepEqual(a.msgs.map((m) => m.text), ["veio do Claude"]);
  const home = pastaTemporaria("conv-troca-x");
  rollout(home, ANTES, [["user", "veio do Codex"]]);
  const b = lerConversa({ provedor: "claude", sessionId: ATUAL, previousSessionId: ANTES, limite: 6, configDir: pastaTemporaria("conv-troca-vazio"), codexHome: home });
  assert.deepEqual(b.msgs.map((m) => m.text), ["veio do Codex"]);
});
