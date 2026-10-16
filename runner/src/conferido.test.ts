import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chaveFalsaOpenai, dormir, lerLinhasJson, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("conferido");
const { Conferidor, CONFERINDO, conferirProvedor, interpretarStatusDoClaude, interpretarStatusDoCodex } = await import("./provedores/conferido.js");

const SAIDA_DO_CLAUDE = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "fulano.de.tal@example.com",
  orgId: "org-0123456789abcdef",
  orgName: "Organizacao Exemplo",
  subscriptionType: "max",
});

/** Nada que identifique a pessoa ou a chave pode sobrar no resultado, de nenhum jeito. */
function semVazamento(r: unknown, proibidos: string[]): void {
  const texto = JSON.stringify(r);
  for (const p of proibidos) assert.equal(texto.includes(p), false, `vazou ${p.slice(0, 12)}...`);
}

test("Claude: loggedIn, authMethod e subscriptionType; e-mail, orgId e orgName são descartados", () => {
  const r = interpretarStatusDoClaude(SAIDA_DO_CLAUDE, "assinatura");
  assert.equal(r.ok, true);
  assert.equal(r.metodo, "assinatura");
  assert.equal(r.detalhe, "Conta do Claude conectada (plano max).");
  assert.match(r.em!, /^\d{4}-/);
  semVazamento(r, ["fulano", "example.com", "org-0123", "Organizacao"]);
  assert.deepEqual(Object.keys(r).sort(), ["detalhe", "em", "metodo", "ok"]);
});

test("Claude: o mapa de authMethod e a divergência com o que foi escolhido", () => {
  const com = (authMethod: string, escolhido: string, loggedIn = true) =>
    interpretarStatusDoClaude(JSON.stringify({ loggedIn, authMethod, email: "x@y.z" }), escolhido);
  assert.equal(com("oauth_token", "token").metodo, "token");
  assert.equal(com("api_key", "api").metodo, "api");
  const diverge = com("claude.ai", "api");
  assert.equal(diverge.ok, false);
  assert.equal(diverge.metodo, "assinatura");
  assert.match(diverge.detalhe, /configurado para chave de API, mas o Claude está conectado por assinatura/);
  assert.equal(com("none", "assinatura", false).ok, false);
  assert.equal(com("none", "assinatura", false).metodo, null);
  assert.match(com("none", "assinatura", false).detalhe, /Entre com a conta do Claude/);
});

test("Claude na API: com chave falsa o CLI diz loggedIn, e o detalhe NÃO promete que a chave funciona", () => {
  const r = interpretarStatusDoClaude(JSON.stringify({ loggedIn: true, authMethod: "api_key" }), "api");
  assert.equal(r.ok, true);
  assert.match(r.detalhe, /configurada/);
  assert.match(r.detalhe, /não confirma se ela vale/);
  assert.equal(/válida/.test(r.detalhe), false);
});

test("Claude: saída que não é JSON vira ok:false sem repetir a saída", () => {
  const r = interpretarStatusDoClaude("erro com fulano@example.com", "assinatura");
  assert.equal(r.ok, false);
  semVazamento(r, ["fulano"]);
});

test("Codex: ChatGPT é assinatura, API key é api, exit 1 é não logado; a linha da chave nunca é repassada", () => {
  const chave = chaveFalsaOpenai("CONFERIDO0000000000");
  const linhaApi = `Logged in using an API key - ${chave.slice(0, 10)}***${chave.slice(-6)}`;
  const api = interpretarStatusDoCodex(linhaApi, 0, "api");
  assert.equal(api.ok, true);
  assert.equal(api.metodo, "api");
  semVazamento(api, [chave.slice(0, 10), chave.slice(-6), "Logged in"]);
  const assinatura = interpretarStatusDoCodex("Logged in using ChatGPT", 0, "assinatura");
  assert.deepEqual([assinatura.ok, assinatura.metodo], [true, "assinatura"]);
  const fora = interpretarStatusDoCodex("Not logged in", 1, "assinatura");
  assert.deepEqual([fora.ok, fora.metodo], [false, null]);
  const diverge = interpretarStatusDoCodex("Logged in using ChatGPT", 0, "api");
  assert.equal(diverge.ok, false);
  assert.equal(diverge.metodo, "assinatura");
  assert.match(diverge.detalhe, /configurado para chave de API, mas o Codex está conectado por assinatura/);
  const apiDivergente = interpretarStatusDoCodex(linhaApi, 0, "assinatura");
  assert.equal(apiDivergente.ok, false);
  semVazamento(apiDivergente, [chave.slice(0, 10), chave.slice(-6)]);
});

test("conferirProvedor roda o CLI de verdade (falso) com o ambiente dado e não deixa nada passar", async () => {
  const chave = chaveFalsaOpenai("RODANDO0000000000");
  const home = pastaTemporaria("conf-codex");
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: chave }));
  const antes = lerLinhasJson(amb.logDosClis).length;
  const r = await conferirProvedor({ provedor: "codex", auth: "api", env: { PATH: process.env.PATH!, CODEX_HOME: home, FAKE_LOG: amb.logDosClis } });
  assert.equal(r.ok, true);
  semVazamento(r, [chave.slice(0, 10), chave.slice(-6)]);
  const reg = lerLinhasJson(amb.logDosClis).slice(antes)[0];
  assert.deepEqual(reg.argv, ["login", "status"]);
  assert.equal(reg.valores.CODEX_HOME, home, "o mesmo ambiente que o spawn usaria");

  const c = await conferirProvedor({ provedor: "claude", auth: "assinatura", env: { PATH: process.env.PATH!, FAKE_CLAUDE_STATUS: SAIDA_DO_CLAUDE } });
  assert.equal(c.ok, true);
  semVazamento(c, ["fulano", "org-0123", "Organizacao"]);
});

test("conferirProvedor: CLI ausente e Codex na API ainda sem login têm mensagem própria", async () => {
  const semBinario = await conferirProvedor({ provedor: "claude", auth: "assinatura", env: { PATH: "/nao-existe" } });
  assert.equal(semBinario.ok, false);
  assert.match(semBinario.detalhe, /não está instalado/);
  const semLogin = await conferirProvedor({ provedor: "codex", auth: "api", env: {}, codexApiAindaSemLogin: true });
  assert.equal(semLogin.ok, null);
  assert.match(semLogin.detalhe, /quando o agente subir/);
});

test("Conferidor: cache de 60 s, uma conferência por vez e o GET nunca espera mais que o limite", async () => {
  const conf = new Conferidor();
  let chamadas = 0;
  let liberar!: () => void;
  const lenta = () =>
    new Promise<import("./provedores/conferido.js").Conferido>((resolve) => {
      chamadas += 1;
      liberar = () => resolve({ ok: true, metodo: "assinatura", detalhe: "pronto", em: "2026-10-12T14:00:00.000Z" });
    });
  const t0 = Date.now();
  const primeira = await conf.obter("s", "claude|assinatura", lenta, 120);
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(primeira, CONFERINDO, "sem resultado em cache responde 'conferindo'");
  const segunda = await conf.obter("s", "claude|assinatura", lenta, 50);
  assert.deepEqual(segunda, CONFERINDO);
  assert.equal(chamadas, 1, "uma conferência por sessão de cada vez");
  liberar();
  await dormir(20);
  const pronta = await conf.obter("s", "claude|assinatura", lenta, 50);
  assert.equal(pronta.detalhe, "pronto");
  await conf.obter("s", "claude|assinatura", lenta, 50);
  assert.equal(chamadas, 1, "cache de 60 s");
  conf.invalidar("s");
  const nova = conf.obter("s", "claude|assinatura", lenta, 30);
  await nova;
  assert.equal(chamadas, 2, "invalidar força uma nova conferência");
  // outra escolha não herda o resultado da anterior
  assert.deepEqual(await conf.obter("s", "codex|api", lenta, 30), CONFERINDO);
});

test("conferirProvedor: o 'codex login status' real escreve no stderr, e isso conta como conectado", async () => {
  // B6 (12/10/2026): o Codex na API respondia turnos e o painel dizia "não está conectado",
  // porque só o stdout era lido e o Codex real imprime "Logged in using ..." no stderr.
  const bin = pastaTemporaria("codex-stderr");
  const exe = path.join(bin, "codex");
  fs.writeFileSync(exe, '#!/bin/sh\necho "Logged in using an API key - sk-proj-ab***wxyz" >&2\nexit 0\n', { mode: 0o755 });
  const r = await conferirProvedor({ provedor: "codex", auth: "api", env: { PATH: `${bin}:${process.env.PATH!}` } });
  assert.equal(r.ok, true);
  assert.equal(r.metodo, "api");
  semVazamento(r, ["sk-proj", "wxyz"]);
});
