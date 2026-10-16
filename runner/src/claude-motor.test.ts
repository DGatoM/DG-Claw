import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chaveFalsa, ctxDeTeste, pastaTemporaria } from "./apoio-teste.js";
import { arquivoClaudeJson, confiarNaPasta, dicaDeLogin, motorClaude, preAprovarChaveDeApi } from "./provedores/claude.js";

test("pré-aprovação: grava os ÚLTIMOS 20 caracteres, é idempotente e preserva o resto do JSON", () => {
  const dir = pastaTemporaria("claudejson");
  const env = { CLAUDE_CONFIG_DIR: dir };
  const arq = path.join(dir, ".claude.json");
  fs.writeFileSync(arq, JSON.stringify({ numStartups: 7, projects: { "/x": { hasTrustDialogAccepted: true } } }), { mode: 0o640 });
  fs.chmodSync(arq, 0o640);
  const chave = chaveFalsa();

  const r1 = preAprovarChaveDeApi(chave, env);
  assert.equal(r1.mudou, true);
  const depois = JSON.parse(fs.readFileSync(arq, "utf8"));
  assert.deepEqual(depois.customApiKeyResponses, { approved: [chave.slice(-20)], rejected: [] });
  assert.equal(depois.numStartups, 7);
  assert.deepEqual(depois.projects, { "/x": { hasTrustDialogAccepted: true } });
  assert.equal(fs.statSync(arq).mode & 0o777, 0o640, "o modo do arquivo é preservado");

  const bytes = fs.readFileSync(arq);
  assert.equal(preAprovarChaveDeApi(chave, env).mudou, false, "a segunda vez não reescreve");
  assert.deepEqual(fs.readFileSync(arq), bytes);
  assert.deepEqual(fs.readdirSync(dir), [".claude.json"], "nenhum temporário sobra");
});

test("pré-aprovação: tira o sufixo de 'rejected', mantém outras aprovadas e cria o arquivo se faltar", () => {
  const dir = pastaTemporaria("claudejson2");
  const arq = path.join(dir, ".claude.json");
  const chave = chaveFalsa("QQQQRRRRSSSSTTTTUUUU5678");
  fs.writeFileSync(arq, JSON.stringify({ customApiKeyResponses: { approved: ["outra-chave-aprovada"], rejected: [chave.slice(-20), "outra-rejeitada"] } }));
  preAprovarChaveDeApi(chave, { CLAUDE_CONFIG_DIR: dir });
  const o = JSON.parse(fs.readFileSync(arq, "utf8"));
  assert.deepEqual(o.customApiKeyResponses.approved, ["outra-chave-aprovada", chave.slice(-20)]);
  assert.deepEqual(o.customApiKeyResponses.rejected, ["outra-rejeitada"]);

  const novo = pastaTemporaria("claudejson3");
  preAprovarChaveDeApi(chave, { CLAUDE_CONFIG_DIR: novo });
  assert.equal(fs.statSync(path.join(novo, ".claude.json")).mode & 0o777, 0o600);
});

test("sem CLAUDE_CONFIG_DIR o arquivo é $HOME/.claude.json", () => {
  assert.equal(arquivoClaudeJson({ HOME: "/h" }), "/h/.claude.json");
  assert.equal(arquivoClaudeJson({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" }), "/c/.claude.json");
});

test("confiarNaPasta marca a casa uma vez só e preserva o JSON", () => {
  const dir = pastaTemporaria("trust");
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ a: 1 }));
  confiarNaPasta("/casa/x", { CLAUDE_CONFIG_DIR: dir }, "spawn");
  confiarNaPasta("/casa/x", { CLAUDE_CONFIG_DIR: dir }, "spawn");
  const o = JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8"));
  assert.deepEqual(o, { a: 1, projects: { "/casa/x": { hasTrustDialogAccepted: true } } });
});

test("args da sessão nova: --session-id, permissão, settings, mcp, identidade, modelo", () => {
  const ctx = ctxDeTeste({
    novoId: "11111111-2222-3333-4444-555555555555",
    settings: "/h/x.settings.json",
    identidade: { arquivo: "/h/x.identidade.md", texto: "persona" },
    escolha: { provedor: "claude", auth: "assinatura", modelo: "claude-opus-5-5" },
    config: { name: "x", cwd: "/c", initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions", mcpConfig: '{"mcpServers":{}}', extraArgs: ["--verbose", "--strict-mcp-config"] },
  });
  assert.deepEqual(motorClaude.argsNova(ctx), [
    "--session-id", "11111111-2222-3333-4444-555555555555",
    "--permission-mode", "bypassPermissions",
    "--settings", "/h/x.settings.json",
    "--mcp-config", '{"mcpServers":{}}',
    "--verbose",
    "--append-system-prompt-file", "/h/x.identidade.md",
    "--model", "claude-opus-5-5",
  ]);
});

test("args da retomada: --resume, e modelo vazio não passa --model", () => {
  const ctx = ctxDeTeste({ settings: "/h/s.json" });
  assert.deepEqual(motorClaude.argsRetomar(ctx, "abc"), ["--resume", "abc", "--permission-mode", "bypassPermissions", "--settings", "/h/s.json"]);
});

test("canal Telegram: --channels em nova e em retomar, sem duplicar quando o descritor já traz", () => {
  const ligado = ctxDeTeste({ canalTelegram: true, novoId: "n" });
  assert.deepEqual(motorClaude.argsNova(ligado).slice(-2), ["--channels", "plugin:telegram@claude-plugins-official"]);
  assert.deepEqual(motorClaude.argsRetomar(ligado, "r").slice(-2), ["--channels", "plugin:telegram@claude-plugins-official"]);
  const legado = ctxDeTeste({
    canalTelegram: true,
    config: { name: "x", cwd: "/c", initialPrompt: "", provider: "local-cli", extraArgs: ["--channels", "plugin:x"] },
  });
  assert.equal(motorClaude.argsRetomar(legado, "r").filter((a) => a === "--channels").length, 1);
});

test("motivoSemLogin: assinatura olha o .credentials.json do config dir", () => {
  const dir = pastaTemporaria("cred");
  const ctx = ctxDeTeste({ env: { CLAUDE_CONFIG_DIR: dir } });
  const r = motorClaude.motivoSemLogin(ctx);
  assert.equal(r?.tipo, "login");
  assert.match(r!.mensagem, /ainda não fez login: não achei .*\.credentials\.json/);
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
  assert.equal(motorClaude.motivoSemLogin(ctx), null);
  fs.writeFileSync(path.join(dir, ".credentials.json"), "");
  assert.equal(motorClaude.motivoSemLogin(ctx)?.tipo, "login", "arquivo vazio não conta");
});

test("motivoSemLogin: api e token pedem a variável do modo, e nunca caem na assinatura", () => {
  const dir = pastaTemporaria("cred2");
  fs.writeFileSync(path.join(dir, ".credentials.json"), "{}"); // há login de assinatura, e mesmo assim:
  const api = ctxDeTeste({ escolha: { provedor: "claude", auth: "api", modelo: "" }, env: { CLAUDE_CONFIG_DIR: dir }, variavelDoModo: "ANTHROPIC_API_KEY", chaveDoModoPresente: false });
  const r = motorClaude.motivoSemLogin(api);
  assert.equal(r?.tipo, "chave");
  assert.match(r!.mensagem, /ANTHROPIC_API_KEY não está no ambiente/);
  assert.match(r!.mensagem, /NÃO volta para a assinatura/);
  assert.match(r!.comoResolver, /Cofre do painel com o nome ANTHROPIC_API_KEY/);
  assert.equal(motorClaude.motivoSemLogin({ ...api, chaveDoModoPresente: true }), null);
});

test("RUNNER_LOGIN_HINT: {host} vira o hostname; vazio não acrescenta nada à mensagem", () => {
  const dir = pastaTemporaria("hint");
  const ctx = ctxDeTeste({ env: { CLAUDE_CONFIG_DIR: dir } });
  process.env.RUNNER_LOGIN_HINT = "Rode: podman exec -it {host} claude auth login";
  try {
    assert.equal(dicaDeLogin(), ` Rode: podman exec -it ${os.hostname()} claude auth login`);
    assert.match(motorClaude.motivoSemLogin(ctx)!.mensagem, new RegExp(`podman exec -it ${os.hostname()} claude auth login$`));
    process.env.RUNNER_LOGIN_HINT = "   ";
    assert.equal(dicaDeLogin(), "");
    delete process.env.RUNNER_LOGIN_HINT;
    assert.equal(dicaDeLogin(), "");
    assert.match(motorClaude.motivoSemLogin(ctx)!.mensagem, /assim que a credencial aparecer\.$/, "sem dica a mensagem termina na frase de sempre");
  } finally {
    delete process.env.RUNNER_LOGIN_HINT;
  }
});
