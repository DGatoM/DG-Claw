import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { carregarCatalogoDeTeste, chaveFalsa, chaveFalsaOpenai, pastaTemporaria } from "./apoio-teste.js";
import { montarAmbiente, nomesDoCofre } from "./provedores/ambiente.js";

const catalogo = carregarCatalogoDeTeste();
const ANT = chaveFalsa();
const OAI = chaveFalsaOpenai();

const montar = (provedor: string, auth: string, base: Record<string, string>, cofre: string[] = [], envExtra?: unknown) =>
  montarAmbiente({ base: { PATH: "/usr/bin", ...base }, envExtra, provedor, auth, catalogo, cofre: new Set(cofre) });

test("claude/assinatura com OPENAI e GEMINI do cofre: recebe as duas e NÃO recebe a ANTHROPIC_API_KEY", () => {
  const r = montar(
    "claude",
    "assinatura",
    { OPENAI_API_KEY: OAI, GEMINI_API_KEY: "gem-x", ANTHROPIC_API_KEY: ANT },
    ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"],
  );
  assert.equal(r.env.OPENAI_API_KEY, OAI);
  assert.equal(r.env.GEMINI_API_KEY, "gem-x");
  assert.equal("ANTHROPIC_API_KEY" in r.env, false);
  assert.deepEqual(r.removidas, [{ nome: "ANTHROPIC_API_KEY", motivo: "outra forma de pagar (limpar do modo)" }]);
  assert.equal(r.env.PATH, "/usr/bin", "o resto do ambiente passa");
});

test("chave de LLM HERDADA (fora do cofre) sai; a mesma chave no cofre fica", () => {
  const so = montar("claude", "assinatura", { OPENAI_API_KEY: OAI });
  assert.equal("OPENAI_API_KEY" in so.env, false);
  assert.deepEqual(so.removidas, [{ nome: "OPENAI_API_KEY", motivo: "herdada, não está no cofre" }]);
  const doCofre = montar("claude", "assinatura", { OPENAI_API_KEY: OAI }, ["OPENAI_API_KEY"]);
  assert.equal(doCofre.env.OPENAI_API_KEY, OAI);
});

test("claude/api mantém a ANTHROPIC_API_KEY do cofre e tira a de outro modo", () => {
  const r = montar("claude", "api", { ANTHROPIC_API_KEY: ANT, CLAUDE_CODE_OAUTH_TOKEN: "oauth-x", ANTHROPIC_BASE_URL: "http://x" }, ["ANTHROPIC_API_KEY"]);
  assert.equal(r.env.ANTHROPIC_API_KEY, ANT);
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in r.env, false);
  assert.equal("ANTHROPIC_BASE_URL" in r.env, false);
  assert.equal(r.variavelDoModo, "ANTHROPIC_API_KEY");
  assert.equal(r.chaveDoModoPresente, true);
});

test("claude/token mantém só o CLAUDE_CODE_OAUTH_TOKEN", () => {
  const r = montar("claude", "token", { CLAUDE_CODE_OAUTH_TOKEN: "oauth-x", ANTHROPIC_API_KEY: ANT }, ["ANTHROPIC_API_KEY"]);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-x");
  assert.equal("ANTHROPIC_API_KEY" in r.env, false);
});

test("codex/assinatura com OPENAI_API_KEY no cofre: sai (limitação conhecida do catálogo)", () => {
  const r = montar("codex", "assinatura", { OPENAI_API_KEY: OAI, CODEX_API_KEY: "c", OPENAI_BASE_URL: "http://x" }, ["OPENAI_API_KEY"]);
  for (const nome of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]) assert.equal(nome in r.env, false, nome);
});

test("codex/api mantém a OPENAI_API_KEY e tira CODEX_API_KEY e a URL base", () => {
  const r = montar("codex", "api", { OPENAI_API_KEY: OAI, CODEX_API_KEY: "c", OPENAI_BASE_URL: "http://x", ANTHROPIC_API_KEY: ANT });
  assert.equal(r.env.OPENAI_API_KEY, OAI);
  assert.equal("CODEX_API_KEY" in r.env, false);
  assert.equal("OPENAI_BASE_URL" in r.env, false);
  assert.equal("ANTHROPIC_API_KEY" in r.env, false, "herdada e fora do cofre");
});

test("modo api ou token sem a variável: chaveDoModoPresente é false (a Sessao não sobe, nem cai na assinatura)", () => {
  assert.equal(montar("claude", "api", {}).chaveDoModoPresente, false);
  assert.equal(montar("claude", "api", { ANTHROPIC_API_KEY: "   " }, ["ANTHROPIC_API_KEY"]).chaveDoModoPresente, false);
  assert.equal(montar("claude", "token", {}).chaveDoModoPresente, false);
  assert.equal(montar("codex", "api", {}).chaveDoModoPresente, false);
  assert.equal(montar("claude", "assinatura", {}).chaveDoModoPresente, true);
});

test("envExtra: nome inválido e valor que não é texto são recusados (só os nomes voltam)", () => {
  const r = montar("claude", "assinatura", {}, [], { BOM: "1", "nome ruim": "x", NUMERO: 5, DGCHAT_AGENT: "a" });
  assert.deepEqual(r.aplicadas, ["BOM", "DGCHAT_AGENT"]);
  assert.deepEqual(r.recusadas.sort(), ["NUMERO", "nome ruim"].sort());
  assert.equal(r.env.BOM, "1");
});

test("nomesDoCofre: export, comentário, linha vazia, aspas; só os nomes", () => {
  const dir = pastaTemporaria("cofre");
  const arq = path.join(dir, "cofre.env");
  fs.writeFileSync(
    arq,
    ["# comentário", "", "OPENAI_API_KEY='abc'", "export GEMINI_API_KEY=xyz", "   FOO_BAR=1", "  # outro comentário", "linha sem igual", "1INVALIDO=2"].join("\n"),
  );
  assert.deepEqual([...nomesDoCofre(arq)].sort(), ["FOO_BAR", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
});

test("nomesDoCofre: arquivo inexistente é cofre vazio; erro de leitura não derruba", () => {
  const dir = pastaTemporaria("cofre2");
  assert.equal(nomesDoCofre(path.join(dir, "nao-existe.env")).size, 0);
  // Um diretório no lugar do arquivo dá EISDIR (erro que não é ENOENT): não derruba, devolve vazio.
  assert.equal(nomesDoCofre(dir).size, 0);
});
