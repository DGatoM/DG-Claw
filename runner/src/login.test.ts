import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { esperarAte, lerLinhasJson, lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("login");
const { LoginAssistido, ErroDeLogin, extrairDoCodex, extrairLinkDoClaude, limparSaida } = await import("./provedores/login.js");

const ESC = "\u001b";
const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc123&state=xyz789";

test("limparSaida tira cores, cursor e hiperlink OSC 8, e deixa o texto visível", () => {
  const bruto = `${ESC}[1mAbrindo${ESC}[0m ${ESC}]8;;${LINK}\u0007clique aqui${ESC}]8;;\u0007${ESC}[2K\r\n`;
  assert.equal(limparSaida(bruto), "Abrindo clique aqui\n");
});

test("link do Claude: sai do alvo do OSC 8 mesmo quando o texto visível é só um rótulo", () => {
  assert.equal(extrairLinkDoClaude(`${ESC}]8;;${LINK}\u0007clique aqui${ESC}]8;;\u0007`), LINK);
  assert.equal(extrairLinkDoClaude(`visite: ${LINK} e cole o código`), LINK);
  assert.equal(extrairLinkDoClaude("https://example.com/outra/coisa"), null);
  assert.equal(extrairLinkDoClaude("https://claude.ai/login"), null, "só a URL de autorização conta");
});

test("device auth do Codex: link e código, ignorando cores", () => {
  const saida = `${ESC}[1m1.${ESC}[0m abra https://auth.openai.com/codex/device\r\n2. código ${ESC}[94mABCD-12345${ESC}[0m (expira em 15 min)`;
  assert.deepEqual(extrairDoCodex(saida), { link: "https://auth.openai.com/codex/device", codigo: "ABCD-12345" });
  assert.deepEqual(extrairDoCodex("https://auth.openai.com/codex/device sem codigo ainda"), { link: "https://auth.openai.com/codex/device", codigo: null });
  assert.equal(extrairDoCodex("ABCD-1234 sem link").link, null);
});

function iniciar(login: InstanceType<typeof LoginAssistido>, provedor: "claude" | "codex", extras: Record<string, string> = {}, aoConcluir = () => undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: amb.raiz, FAKE_LOG: amb.logDosClis, CLAUDE_CONFIG_DIR: amb.claudeDir, CODEX_HOME: amb.codexHome, ...extras };
  return login.iniciar({ sessao: "s1", provedor, env, cwd: amb.casa, aoConcluir });
}

test("Claude: aguardando_link -> aguardando_codigo com o link -> código digitado -> concluido", async () => {
  const login = new LoginAssistido();
  assert.deepEqual(login.visao("s1"), { estado: "nenhum" });
  let concluiu = 0;
  const v0 = iniciar(login, "claude", {}, () => void (concluiu += 1));
  assert.equal(v0.estado, "aguardando_link");
  await esperarAte(() => login.visao("s1").estado === "aguardando_codigo", 5_000, "o link do Claude");
  assert.equal(login.visao("s1").link, LINK);

  // O fake roda com BROWSER=/bin/true, como pede a spec.
  const reg = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "auth-login").pop()!;
  assert.deepEqual(reg.argv, ["auth", "login"]);
  assert.equal(reg.valores.BROWSER, "/bin/true");

  assert.throws(() => login.enviarCodigo("s1", "tem espaço e ! símbolo"), (e: Error & { status?: number }) => e instanceof ErroDeLogin && e.status === 400);
  assert.throws(() => login.enviarCodigo("s1", "a".repeat(513)), (e: Error & { code?: string }) => e.code === "CODIGO_INVALIDO");
  assert.throws(() => login.enviarCodigo("s1", 42), (e: Error & { code?: string }) => e.code === "CODIGO_INVALIDO");
  login.enviarCodigo("s1", "CODIGO-da_pagina.123~#x");
  await esperarAte(() => login.visao("s1").estado === "concluido", 5_000, "o login concluir");
  const digitado = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "auth-login-codigo").pop()!;
  assert.equal(digitado.codigo, "CODIGO-da_pagina.123~#x");
  assert.equal(concluiu, 1);
  assert.ok(fs.existsSync(path.join(amb.claudeDir, ".credentials.json")));
  assert.throws(() => login.enviarCodigo("s1", "outro"), (e: Error & { status?: number }) => e.status === 409, "fora do estado aguardando_codigo");
});

test("só um login por vez no runner: o segundo é 409 LOGIN_EM_ANDAMENTO; DELETE cancela e libera", async () => {
  const login = new LoginAssistido();
  iniciar(login, "claude");
  await esperarAte(() => login.visao("s1").estado === "aguardando_codigo", 5_000);
  assert.throws(
    () => login.iniciar({ sessao: "s2", provedor: "codex", env: { PATH: process.env.PATH! }, cwd: amb.casa, aoConcluir: () => undefined }),
    (e: Error & { status?: number; code?: string }) => e instanceof ErroDeLogin && e.status === 409 && e.code === "LOGIN_EM_ANDAMENTO",
  );
  login.cancelar("s1");
  assert.equal(login.visao("s1").estado, "nenhum");
  await esperarAte(() => {
    try {
      login.iniciar({ sessao: "s2", provedor: "codex", env: { PATH: process.env.PATH!, CODEX_HOME: amb.codexHome }, cwd: amb.casa, aoConcluir: () => undefined });
      return true;
    } catch {
      return false;
    }
  }, 5_000, "o PTY cancelado liberar o runner");
  login.cancelar("s2");
});

test("Codex: aguardando_navegador com link e codigoDispositivo, e concluido quando o CLI sai com 0", async () => {
  const login = new LoginAssistido();
  const home = pastaTemporaria("codex-login");
  let concluiu = 0;
  iniciar(login, "codex", { CODEX_HOME: home, FAKE_DEVICE_MS: "900" }, () => void (concluiu += 1));
  await esperarAte(() => login.visao("s1").estado === "aguardando_navegador", 5_000, "o código de dispositivo");
  const v = login.visao("s1");
  assert.equal(v.link, "https://auth.openai.com/codex/device");
  assert.equal(v.codigoDispositivo, "ABCD-12345");
  await esperarAte(() => login.visao("s1").estado === "concluido", 5_000);
  assert.equal(concluiu, 1);
  assert.ok(fs.existsSync(path.join(home, "auth.json")));
});

test("saída diferente de 0 vira falhou, com mensagem em português e sem a saída crua", async () => {
  const login = new LoginAssistido();
  iniciar(login, "codex", { FAKE_LOGIN_FAIL: "1", FAKE_DEVICE_MS: "300" });
  await esperarAte(() => login.visao("s1").estado === "falhou", 5_000);
  const v = login.visao("s1");
  assert.match(v.mensagem!, /O login do Codex não terminou/);
  assert.equal(JSON.stringify(v).includes("ABCD-12345"), false, "o código não fica na mensagem de falha");
});

test("passou do prazo: mata o login e marca falhou", async () => {
  const login = new LoginAssistido(400);
  iniciar(login, "claude");
  await esperarAte(() => login.visao("s1").estado === "falhou", 5_000, "o prazo estourar");
  assert.match(login.visao("s1").mensagem!, /não foi concluído/);
});

test("o log só diz que o login iniciou, concluiu ou falhou: nada do link, do código ou da saída", () => {
  const log = lerTexto(amb.logDoRunner);
  assert.match(log, /login do Claude iniciado/);
  assert.match(log, /login do Claude concluído, código de saída 0/);
  assert.match(log, /login do Codex falhou, código de saída 1/);
  for (const proibido of ["oauth/authorize", "client_id", "xyz789", "ABCD-12345", "auth.openai.com", "CODIGO-da_pagina"]) {
    assert.equal(log.includes(proibido), false, `o log tem ${proibido}`);
  }
});
