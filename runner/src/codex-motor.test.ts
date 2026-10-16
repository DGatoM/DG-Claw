import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chaveFalsaOpenai, ctxDeTeste, esperarAte, lerLinhasJson, lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("codex-motor");
const { apagarSnapshotsAntigos, argsDeAprovacao, codexHomeDe, motorCodex, registrarChaveNoCodex, shaDaChave } = await import("./provedores/codex.js");
const { ErroDeMotor, redigirArgs } = await import("./provedores/motor.js");
const { prepararMcpDoCodex, linhaDeAmbiente } = await import("./provedores/mcp-codex.js");
const { eventoDoRollout, descobrirRollout, acharRolloutPorId, vigiarRollout, mensagensDoRollout } = await import("./provedores/codex-rollout.js");

function ctxCodex(sobre: Record<string, unknown> = {}) {
  const hooks = pastaTemporaria("hooks");
  return ctxDeTeste({
    escolha: { provedor: "codex", auth: "assinatura", modelo: "" },
    cwd: amb.casa,
    pastaDeHooks: hooks,
    env: { CODEX_HOME: amb.codexHome, HOME: amb.raiz },
    config: { name: "x", cwd: amb.casa, initialPrompt: "", provider: "codex-cli", permissionMode: "bypassPermissions" },
    ...sobre,
  } as never);
}

test("aprovação: bypass, auto, default e acceptEdits", () => {
  assert.deepEqual(argsDeAprovacao("bypassPermissions"), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(argsDeAprovacao("auto"), ["--ask-for-approval", "on-request"]);
  assert.deepEqual(argsDeAprovacao("acceptEdits"), ["--ask-for-approval", "on-request"]);
  assert.deepEqual(argsDeAprovacao("default"), ["--ask-for-approval", "untrusted"]);
  assert.deepEqual(argsDeAprovacao(undefined), ["--ask-for-approval", "on-request"]);
});

test("CODEX_HOME: assinatura usa o do ambiente ou $HOME/.codex; api usa uma pasta por sessão", () => {
  assert.equal(codexHomeDe({ auth: "assinatura", env: { CODEX_HOME: "/x" }, cwd: "/c", id: "i" }), "/x");
  assert.equal(codexHomeDe({ auth: "assinatura", env: { HOME: "/h" }, cwd: "/c", id: "i" }), "/h/.codex");
  assert.equal(codexHomeDe({ auth: "api", env: { CODEX_HOME: "/x" }, cwd: "/c", id: "sessao-1" }), "/c/.plataforma/codex-api/sessao-1");
});

test("sessão nova: aprovação, confiança por -c, modelo e notify", async () => {
  const ctx = ctxCodex({ escolha: { provedor: "codex", auth: "assinatura", modelo: "gpt-5.5" } });
  await motorCodex.preparar(ctx);
  const args = motorCodex.argsNova(ctx);
  assert.deepEqual(args.slice(0, 5), ["--dangerously-bypass-approvals-and-sandbox", "-c", `projects.${JSON.stringify(amb.casa)}.trust_level="trusted"`, "-m", "gpt-5.5"]);
  const notify = args.find((a) => a.startsWith("notify="))!;
  const lista = JSON.parse(notify.slice("notify=".length));
  assert.equal(lista[0], process.execPath);
  assert.match(lista[1], /runner-codex-notify\.mjs$/);
  assert.deepEqual(lista.slice(2, 6), ["--agent", "agente-teste", "--port", "4399"]);
  assert.equal(lista[7], ctx.nonce);
  assert.equal(args.join(" ").includes("config.toml"), false);
  // Antes o config.toml não era tocado. B6 (12/10/2026): o Codex 0.162.1 ignorou o -c de confiança e
  // abriu "Trust this folder?", então agora a seção da pasta é gravada, do jeito que o Codex grava.
  const toml = lerTexto(path.join(amb.codexHome, "config.toml"));
  assert.ok(toml.includes(`[projects.${JSON.stringify(amb.casa)}]\ntrust_level = "trusted"\n`));
  assert.ok(fs.existsSync(lista[1]), "o handler de notify é gravado na pasta de hooks");
  assert.equal(ctx.env.CODEX_HOME, amb.codexHome);
});

test("retomar: codex resume <uuid> com os mesmos flags; modelo vazio não passa -m", async () => {
  const ctx = ctxCodex();
  await motorCodex.preparar(ctx);
  const args = motorCodex.argsRetomar(ctx, "01a1305e-424b-7700-98b7-332e82b8d09b");
  assert.deepEqual(args.slice(0, 3), ["resume", "01a1305e-424b-7700-98b7-332e82b8d09b", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.equal(args.includes("-m"), false);
});

test("partida sem a tela de atualização, na sessão nova e ao retomar", async () => {
  const ctx = ctxCodex();
  await motorCodex.preparar(ctx);
  for (const args of [motorCodex.argsNova(ctx), motorCodex.argsRetomar(ctx, "01a1305e-424b-7700-98b7-332e82b8d09b")]) {
    const i = args.indexOf("check_for_update_on_startup=false");
    assert.ok(i > 0 && args[i - 1] === "-c", "o Codex não pode abrir perguntando se quer atualizar");
  }
});

test("shell snapshot desligado: as chaves do ambiente não vão para disco, na sessão nova e ao retomar", async () => {
  const ctx = ctxCodex();
  await motorCodex.preparar(ctx);
  for (const args of [motorCodex.argsNova(ctx), motorCodex.argsRetomar(ctx, "01a1305e-424b-7700-98b7-332e82b8d09b")]) {
    const i = args.indexOf("features.shell_snapshot=false");
    assert.ok(i > 0 && args[i - 1] === "-c", "o snapshot do shell grava as chaves do cofre em CODEX_HOME/shell_snapshots");
  }
});

test("snapshots antigos: o preparar apaga os arquivos de shell_snapshots, sem seguir atalho, e conta no log", async () => {
  const home = pastaTemporaria("codex-snapshots");
  const pasta = path.join(home, "shell_snapshots");
  const fora = pastaTemporaria("fora-dos-snapshots");
  const alvo = path.join(fora, "nao-apagar.txt");
  fs.mkdirSync(path.join(pasta, "sub"), { recursive: true });
  fs.writeFileSync(alvo, "fica");
  fs.writeFileSync(path.join(pasta, "a.sh"), "declare -x OPENAI_API_KEY=x\n");
  fs.writeFileSync(path.join(pasta, "b.sh"), "declare -x OPENAI_API_KEY=x\n");
  fs.writeFileSync(path.join(pasta, "sub", "c.sh"), "x");
  fs.symlinkSync(alvo, path.join(pasta, "atalho.sh"));

  const ctx = ctxCodex({ env: { CODEX_HOME: home, HOME: amb.raiz } });
  await motorCodex.preparar(ctx);
  assert.deepEqual(fs.readdirSync(pasta), ["sub"], "arquivos e atalhos saem; subpasta fica");
  assert.equal(fs.readFileSync(alvo, "utf8"), "fica", "o alvo do atalho não é tocado");
  assert.ok(fs.existsSync(path.join(pasta, "sub", "c.sh")));
  assert.match(lerTexto(amb.logDoRunner), /apaguei 3 snapshot\(s\) antigo\(s\) do shell do Codex/);

  // A própria pasta sendo um atalho: nada é apagado do outro lado.
  const home2 = pastaTemporaria("codex-snapshots-atalho");
  fs.writeFileSync(path.join(fora, "d.sh"), "x");
  fs.symlinkSync(fora, path.join(home2, "shell_snapshots"));
  assert.equal(apagarSnapshotsAntigos(home2, "teste"), 0);
  assert.ok(fs.existsSync(path.join(fora, "d.sh")));
  assert.match(lerTexto(amb.logDoRunner), /shell_snapshots não é uma pasta \(é um atalho\)/);

  assert.equal(apagarSnapshotsAntigos(pastaTemporaria("codex-sem-snapshots"), "teste"), 0, "sem a pasta, nada a fazer");
});

test("identidade: texto em -c developer_instructions=<JSON>, nunca base_instructions", async () => {
  const texto = 'Você é a Ana.\nUse "aspas" e \\ barras.';
  const ctx = ctxCodex({ identidade: { arquivo: "/h/x.md", texto } });
  await motorCodex.preparar(ctx);
  const args = motorCodex.argsNova(ctx);
  const i = args.indexOf(`developer_instructions=${JSON.stringify(texto)}`);
  assert.ok(i > 0 && args[i - 1] === "-c");
  assert.equal(args.join("\n").includes("base_instructions"), false);
  assert.equal(args.join("\n").includes("model_instructions_file"), false);
});

test("identidade acima de 120 000 bytes: errored com motivo, e nunca trunca em silêncio", async () => {
  const dentro = ctxCodex({ identidade: { arquivo: "/h/ok.md", texto: "a".repeat(100_000) } });
  await motorCodex.preparar(dentro);
  const grande = ctxCodex({ identidade: { arquivo: "/h/grande.md", texto: "a".repeat(130_000) } });
  await assert.rejects(
    () => motorCodex.preparar(grande),
    (e: Error & { statusReason?: string; comoResolver?: string }) => {
      assert.ok(e instanceof ErroDeMotor);
      assert.equal(e.statusReason, "runner:identidade-grande");
      assert.match(e.message, /grande\.md/);
      assert.match(e.message, /130000/);
      assert.match(e.message, /120000/);
      assert.match(e.message, /128 KB/);
      assert.match(e.message, /Não vou cortar/);
      assert.match(e.comoResolver, /encurtar/);
      return true;
    },
  );
});

test("MCP: o env do servidor vai para arquivos 600/700 e o argv só leva o caminho do wrapper", async () => {
  const segredo = chaveFalsaOpenai("SEGREDODOMCP12345");
  const mcp = JSON.stringify({
    mcpServers: {
      dgchat: { command: "/bin/sh", args: ["-c", "printenv MEU_SEGREDO DGCHAT_AGENT"], env: { MEU_SEGREDO: segredo, DGCHAT_AGENT: "do-mcp-config" } },
      remoto: { url: "https://mcp.exemplo.com/sse" },
      "nome ruim": { command: "x" },
    },
  });
  const ctx = ctxCodex({ config: { name: "x", cwd: amb.casa, initialPrompt: "", provider: "codex-cli", mcpConfig: mcp }, env: { CODEX_HOME: amb.codexHome, DGCHAT_AGENT: "da-sessao", DGCHAT_OUTBOUND: "/o/outbound.jsonl", OUTRA: "nao-entra" } });
  await motorCodex.preparar(ctx);
  const args = motorCodex.argsNova(ctx);
  const todos = args.join("\n");
  assert.equal(todos.includes(segredo), false, "nenhum valor do env no argv");
  const cmd = args.find((a) => a.startsWith("mcp_servers.dgchat.command="))!;
  const sh = JSON.parse(cmd.slice("mcp_servers.dgchat.command=".length));
  assert.match(sh, /mcp-agente-teste\/[0-9a-f]{12}\/mcp-dgchat\.sh$/);
  assert.ok(args.includes("mcp_servers.dgchat.args=[]"));
  assert.ok(args.includes('mcp_servers.remoto.url="https://mcp.exemplo.com/sse"'));
  assert.equal(todos.includes("nome ruim"), false, "nome fora de ^[A-Za-z0-9_-]+$ é pulado");

  const env = sh.replace(/\.sh$/, ".env");
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sh).mode & 0o777, 0o700);
  const linhas = fs.readFileSync(env, "utf8").trim().split("\n").sort();
  assert.deepEqual(linhas, [`DGCHAT_AGENT='da-sessao'`, `DGCHAT_OUTBOUND='/o/outbound.jsonl'`, `MEU_SEGREDO='${segredo}'`]);
  // As DGCHAT_* da sessão vencem as do mcpConfig, e o script executa o comando de verdade.
  const saida = execFileSync("/bin/sh", [sh], { encoding: "utf8" });
  assert.equal(saida, `${segredo}\nda-sessao\n`);

  for (const f of ctx.limpezas) f();
  assert.equal(fs.existsSync(path.dirname(sh)), false, "os arquivos do spawn saem quando o PTY sai");
});

test("MCP: valor com aspa simples ou quebra de linha é recusado, dizendo QUAL variável e sem o valor", () => {
  const pasta = pastaTemporaria("mcp-ruim");
  const ruim = "valor'com\naspa-SEGREDO";
  const m = prepararMcpDoCodex({
    mcpConfig: JSON.stringify({ mcpServers: { a: { command: "x", env: { VAR_RUIM: ruim } } } }),
    cwd: amb.casa,
    env: {},
    idDaSessao: "s",
    pastaDeHooks: pasta,
    tag: "t",
    area: "spawn",
  });
  assert.deepEqual(m.pulados, ["a"]);
  assert.deepEqual(m.args, []);
  assert.throws(() => linhaDeAmbiente("VAR_RUIM", ruim), (e: Error) => /VAR_RUIM/.test(e.message) && !e.message.includes("SEGREDO"));
  assert.throws(() => linhaDeAmbiente("V", "a\0b"));
  assert.throws(() => linhaDeAmbiente("V", "a\rb"));
  assert.equal(linhaDeAmbiente("V", "ok"), "V='ok'");
  const log = lerTexto(amb.logDoRunner);
  assert.match(log, /VAR_RUIM/);
  assert.equal(log.includes("SEGREDO"), false, "o valor não vai para o log");
});

test("MCP: restos de spawns anteriores da mesma sessão são apagados no começo do spawn", () => {
  const pasta = pastaTemporaria("mcp-restos");
  const resto = path.join(pasta, "mcp-s", "antigo");
  fs.mkdirSync(resto, { recursive: true });
  fs.writeFileSync(path.join(resto, "mcp-x.env"), "A='1'\n");
  prepararMcpDoCodex({ mcpConfig: JSON.stringify({ mcpServers: { b: { command: "y" } } }), cwd: amb.casa, env: {}, idDaSessao: "s", pastaDeHooks: pasta, tag: "novo", area: "spawn" });
  assert.equal(fs.existsSync(resto), false);
  assert.ok(fs.existsSync(path.join(pasta, "mcp-s", "novo", "mcp-b.sh")));
});

test("API: a chave entra no Codex SÓ pelo stdin, uma vez por chave, e a saída crua nunca aparece", async () => {
  const chave = chaveFalsaOpenai();
  const home = path.join(pastaTemporaria("codexapi"), "codex-api", "s1");
  fs.mkdirSync(home, { recursive: true });
  const antes = lerLinhasJson(amb.logDosClis).length;
  const opcoes = { chave, home, env: { PATH: process.env.PATH!, FAKE_LOG: amb.logDosClis, OPENAI_API_KEY: chave }, area: "spawn" };

  await registrarChaveNoCodex(opcoes);
  const chamadas = lerLinhasJson(amb.logDosClis).slice(antes);
  assert.equal(chamadas.length, 1);
  assert.deepEqual(chamadas[0].argv, ["login", "--with-api-key"]);
  assert.equal(chamadas[0].stdinSha256, shaDaChave(chave), "a chave chegou pelo stdin");
  assert.equal(JSON.stringify(chamadas[0]).includes(chave.slice(0, 20)), false, "nem no argv nem no registro");
  assert.equal(chamadas[0].env.includes("OPENAI_API_KEY"), false, "o filho do login não precisa da chave no ambiente");
  assert.equal(chamadas[0].valores.CODEX_HOME, home);
  assert.ok(fs.existsSync(path.join(home, "auth.json")));
  assert.equal(fs.readFileSync(path.join(home, ".dgclaw-chave.sha256"), "utf8").trim(), shaDaChave(chave));

  await registrarChaveNoCodex(opcoes);
  assert.equal(lerLinhasJson(amb.logDosClis).length - antes, 1, "mesma chave e auth.json presente: não repete o login");

  await registrarChaveNoCodex({ ...opcoes, chave: chaveFalsaOpenai("OUTRA00000000000000") });
  assert.equal(lerLinhasJson(amb.logDosClis).length - antes, 2, "chave diferente: registra de novo");
});

test("API: login por chave que falha vira ErroDeMotor sem a saída crua", async () => {
  const chave = chaveFalsaOpenai("FALHA1111111111111");
  const home = pastaTemporaria("codexapi-falha");
  await assert.rejects(
    () => registrarChaveNoCodex({ chave, home, env: { PATH: process.env.PATH!, FAKE_CODEX_LOGIN_FAIL: "1" }, area: "spawn" }),
    (e: Error & { statusReason?: string }) => {
      assert.ok(e instanceof ErroDeMotor);
      assert.equal(e.statusReason, "runner:login-por-chave-falhou");
      assert.equal(e.message.includes(chave.slice(0, 10)), false);
      assert.match(e.message, /pode conter parte da chave/);
      return true;
    },
  );
  assert.equal(lerTexto(amb.logDoRunner).includes(chave.slice(0, 10)), false, "a saída do codex login não vai para o log");
});

test("API: preparar usa o CODEX_HOME da sessão e a OPENAI_API_KEY continua no ambiente (é do cofre)", async () => {
  const chave = chaveFalsaOpenai("PREPARAR222222222");
  const ctx = ctxCodex({ escolha: { provedor: "codex", auth: "api", modelo: "" }, env: { PATH: process.env.PATH!, OPENAI_API_KEY: chave }, variavelDoModo: "OPENAI_API_KEY", id: "sessao-api" });
  await motorCodex.preparar(ctx);
  assert.equal(ctx.env.CODEX_HOME, path.join(amb.casa, ".plataforma", "codex-api", "sessao-api"));
  assert.equal(ctx.env.OPENAI_API_KEY, chave);
  assert.equal(fs.statSync(ctx.env.CODEX_HOME).mode & 0o777, 0o700);
});

test("rollout: o que vira evento de status", () => {
  const r = (type: string, payload: Record<string, unknown>) => ({ timestamp: "2026-10-12T14:00:00.000Z", type, payload });
  assert.equal(eventoDoRollout(r("event_msg", { type: "task_started" }))?.evento, "UserPromptSubmit");
  for (const t of ["task_complete", "task_aborted", "turn_aborted"]) assert.equal(eventoDoRollout(r("event_msg", { type: t }))?.evento, "Stop", t);
  assert.deepEqual(eventoDoRollout(r("response_item", { type: "function_call", name: "shell" })), { evento: "PreToolUse", em: Date.parse("2026-10-12T14:00:00.000Z"), ferramenta: "shell" });
  assert.equal(eventoDoRollout(r("response_item", { type: "custom_tool_call" }))?.evento, "PreToolUse");
  assert.equal(eventoDoRollout(r("response_item", { type: "message", role: "assistant" })), null);
  assert.equal(eventoDoRollout(r("event_msg", { type: "token_count" })), null);
  assert.equal(eventoDoRollout({ type: "event_msg", payload: { type: "task_started" } }), null, "sem timestamp não vira evento");
});

function escreverRollout(home: string, id: string, cwd: string, extra: string[] = [], mtime?: number): string {
  const d = new Date();
  const dir = path.join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-2026-10-12T10-00-00-${id}.jsonl`);
  const meta = { timestamp: new Date().toISOString(), type: "session_meta", payload: { id, cwd, base_instructions: "y".repeat(300_000) } };
  fs.writeFileSync(f, [JSON.stringify(meta), ...extra].join("\n") + "\n");
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

test("descoberta do rollout: cwd + mtime >= spawn - 5 s, e exclui ids de outras sessões", () => {
  const home = pastaTemporaria("descoberta");
  const spawn = Date.now();
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const C = "cccccccc-0000-4000-8000-000000000003";
  escreverRollout(home, A, "/outra/casa");
  escreverRollout(home, B, "/casa/certa", [], spawn - 60_000); // velho demais
  assert.equal(descobrirRollout("/casa/certa", spawn, home), null, "outro cwd e rollout velho não servem");
  const f = escreverRollout(home, C, "/casa/certa/");
  assert.deepEqual(descobrirRollout("/casa/certa", spawn, home), { id: C, arquivo: f }, "a primeira linha tem 300 KB: o id sai mesmo assim");
  assert.equal(descobrirRollout("/casa/certa", spawn, home, new Set([C])), null, "já reivindicado por outra sessão");
  assert.equal(acharRolloutPorId(C, home), f);
  assert.equal(acharRolloutPorId("nao-e-uuid", home), null);
});

test("descoberta: rollout de uma conversa que começou ANTES do spawn é de outra conversa, mesmo com mtime recente", () => {
  const home = pastaTemporaria("descoberta2");
  const spawn = Date.now();
  const velho = "ffffffff-0000-4000-8000-000000000006";
  const d = new Date();
  const dir = path.join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const meta = { timestamp: new Date(spawn - 30_000).toISOString(), type: "session_meta", payload: { id: velho, cwd: "/casa/certa", timestamp: new Date(spawn - 30_000).toISOString() } };
  fs.writeFileSync(path.join(dir, `rollout-2026-10-12T10-00-00-${velho}.jsonl`), JSON.stringify(meta) + "\n"); // mtime = agora
  assert.equal(descobrirRollout("/casa/certa", spawn, home), null);
});

test("vigia do rollout: entrega os eventos NA ORDEM e ignora o que é anterior ao spawn", async () => {
  const home = pastaTemporaria("vigia");
  const id = "dddddddd-0000-4000-8000-000000000004";
  const antes = new Date(Date.now() - 60_000).toISOString();
  const ev = (t: string, type: string, p: Record<string, unknown>) => JSON.stringify({ timestamp: t, type, payload: p });
  const f = escreverRollout(home, id, "/c", [ev(antes, "event_msg", { type: "task_started" }), ev(antes, "event_msg", { type: "task_complete" })]);
  const recebidos: string[] = [];
  const parar = vigiarRollout({ resolverArquivo: () => f, desdeMs: Date.now() - 5_000, intervaloMs: 50, aoEvento: (e) => recebidos.push(e.evento + (e.ferramenta ? `:${e.ferramenta}` : "")) });
  try {
    const agora = () => new Date().toISOString();
    fs.appendFileSync(f, [ev(agora(), "event_msg", { type: "task_started" }), ev(agora(), "response_item", { type: "function_call", name: "shell" }), ev(agora(), "event_msg", { type: "task_complete" })].join("\n") + "\n");
    await esperarAte(() => recebidos.length >= 3, 4_000, "os três eventos");
    assert.deepEqual(recebidos, ["UserPromptSubmit", "PreToolUse:shell", "Stop"]);
  } finally {
    parar();
  }
});

test("conversa pelo rollout: só user/assistant, sem contexto injetado, no formato {role, text}", () => {
  const home = pastaTemporaria("conversa");
  const id = "eeeeeeee-0000-4000-8000-000000000005";
  const msg = (role: string, texto: string, tipo = "input_text") => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role, content: [{ type: tipo, text: texto }] } });
  const f = escreverRollout(home, id, "/c", [
    msg("developer", "instrução do sistema"),
    msg("user", "<environment_context>\ncwd\n</environment_context>"),
    msg("user", "<user_instructions>x</user_instructions>"),
    msg("user", "# AGENTS.md instructions for /c"),
    msg("user", "oi, tudo bem?"),
    msg("assistant", "tudo ótimo", "output_text"),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "function_call", name: "shell" } }),
    msg("system", "sistema"),
    msg("user", "e agora?"),
    "{linha truncada",
  ]);
  assert.deepEqual(mensagensDoRollout(f, 10), [
    { role: "user", text: "oi, tudo bem?" },
    { role: "assistant", text: "tudo ótimo" },
    { role: "user", text: "e agora?" },
  ]);
  assert.deepEqual(mensagensDoRollout(f, 1), [{ role: "user", text: "e agora?" }]);
  // o histórico também é tela: o valor do cofre sai mascarado
  const segredo = chaveFalsaOpenai("NOHISTORICO000000");
  fs.appendFileSync(f, msg("assistant", `a chave é ${segredo}, ok?`, "output_text") + "\n");
  assert.equal(mensagensDoRollout(f, 1, [segredo])![0].text, "a chave é [segredo oculto], ok?");
});

test("redigirArgs: o nonce nunca vai para o log e a identidade enorme vira só o tamanho", () => {
  const nonce = "ab12".repeat(16);
  const log = redigirArgs(["--x", "-c", `notify=["node","/h/n.mjs","--agent","a","--port","1","--nonce","${nonce}"]`, "--nonce", nonce, "-c", `developer_instructions=${JSON.stringify("z".repeat(5_000))}`]);
  const texto = log.join(" ");
  assert.equal(texto.includes(nonce), false);
  assert.match(texto, /"--nonce","\*\*\*"/);
  assert.match(texto, /<5\d{3} bytes>/);
  assert.equal(texto.includes("z".repeat(100)), false);
});

test("confiança da pasta: arquivo inexistente vira config.toml 600 com a seção", async () => {
  const home = path.join(pastaTemporaria("trust-novo"), "codex-novo");
  const ctx = ctxCodex({ env: { CODEX_HOME: home, HOME: amb.raiz } });
  await motorCodex.preparar(ctx);
  const arq = path.join(home, "config.toml");
  assert.equal(fs.readFileSync(arq, "utf8"), `[projects.${JSON.stringify(amb.casa)}]\ntrust_level = "trusted"\n`);
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});

test("confiança da pasta: conteúdo antigo fica idêntico e a seção entra no fim; duas chamadas não duplicam", async () => {
  const home = pastaTemporaria("trust-antigo");
  const antigo = '[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n';
  fs.writeFileSync(path.join(home, "config.toml"), antigo, { mode: 0o640 });
  const ctx = ctxCodex({ env: { CODEX_HOME: home, HOME: amb.raiz } });
  await motorCodex.preparar(ctx);
  await motorCodex.preparar(ctx);
  const arq = path.join(home, "config.toml");
  const texto = fs.readFileSync(arq, "utf8");
  assert.equal(texto, `${antigo}\n[projects.${JSON.stringify(amb.casa)}]\ntrust_level = "trusted"\n`);
  assert.equal(texto.split("[projects.").length - 1, 1);
  assert.equal(fs.statSync(arq).mode & 0o777, 0o640, "preserva o modo do arquivo");
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith(".tmp")), []);
});

test("confiança da pasta: seção já presente, com outro trust_level, não é alterada", async () => {
  const home = pastaTemporaria("trust-existente");
  const feito = `[projects.${JSON.stringify(amb.casa)}]\ntrust_level = "untrusted"\n`;
  fs.writeFileSync(path.join(home, "config.toml"), feito);
  await motorCodex.preparar(ctxCodex({ env: { CODEX_HOME: home, HOME: amb.raiz } }));
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), feito);
});

test("confiança da pasta: no modo api vale na pasta por sessão do runner", async () => {
  const ctx = ctxCodex({ escolha: { provedor: "codex", auth: "api", modelo: "" }, variavelDoModo: "OPENAI_API_KEY", env: { HOME: amb.raiz } });
  await motorCodex.preparar(ctx);
  const home = codexHomeDe({ auth: "api", env: {}, cwd: amb.casa, id: ctx.id });
  assert.ok(fs.readFileSync(path.join(home, "config.toml"), "utf8").includes(`[projects.${JSON.stringify(amb.casa)}]`));
});
