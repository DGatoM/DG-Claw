import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ctxDeTeste, lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("codex-hooks");
const { hashDoHook, mesclarHooks, garantirConfiancaNoToml, hooksDoAgente, instalarHooksNoCodex, raizDoPlugin, MARCA_DO_DGCLAW } = await import("./provedores/codex-hooks.js");
const { motorCodex } = await import("./provedores/codex.js");

/** Um plugin falso (só o que o instalador confere) e um workspace servidor falso. */
function cenario(rotulo: string) {
  const raiz = pastaTemporaria(rotulo);
  const plugin = path.join(raiz, "app");
  fs.mkdirSync(path.join(plugin, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "hooks", "dispatch.ts"), "// falso\n");
  const ws = path.join(raiz, "ws");
  fs.mkdirSync(path.join(ws, ".dgclaw"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".dgclaw", "config.sh"), "# falso\n");
  const home = path.join(raiz, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(raiz, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { raiz, plugin, ws, home, bin, env: { PATH: bin, DGCLAW_WORKSPACE: ws } as Record<string, string> };
}

test("raizDoPlugin acha a pasta que tem hooks/dispatch.ts subindo a partir de um arquivo", () => {
  const c = cenario("raiz");
  const fundo = path.join(c.plugin, "runner", "dist", "provedores");
  fs.mkdirSync(fundo, { recursive: true });
  assert.equal(raizDoPlugin(fundo), c.plugin);
  assert.equal(raizDoPlugin(c.raiz + "/bin"), null);
});

test("o hash bate com o que o Codex 0.163 calcula (valores medidos com hooks/list)", () => {
  assert.equal(hashDoHook({ evento: "UserPromptSubmit", command: "echo oi", timeout: 8 }), "sha256:ebdea6d356588fbb926e946d4404b34d6189b4611282ca022b4a1913e9fa60f2");
  assert.equal(hashDoHook({ evento: "SessionStart", matcher: "compact|clear", command: "echo sc", timeout: 5 }), "sha256:7e2a351b079dc4cbcd923a540a79926c5970d3d0db9dda94a0f7753bcee2a217");
});

test("hooksDoAgente: os quatro hooks do plugin com os mesmos timeouts do hooks.json do Claude, mais os promptHooks", () => {
  const hooks = hooksDoAgente({ raiz: "/opt/dgclaw/app", temWorkspace: true, temBun: true, promptHooks: ["node /x/novidades-hook.mjs", "  "] });
  assert.deepEqual(
    hooks.map((h) => [h.evento, h.matcher ?? "", h.command.replace(MARCA_DO_DGCLAW, ""), h.timeout]),
    [
      ["SessionStart", "", 'bun "/opt/dgclaw/app/hooks/dispatch.ts" session-start', 8],
      ["SessionStart", "compact|clear", 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos-reset', 5],
      ["UserPromptSubmit", "", 'bun "/opt/dgclaw/app/hooks/dispatch.ts" user-prompt', 8],
      ["UserPromptSubmit", "", 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos', 6],
      ["UserPromptSubmit", "", "node /x/novidades-hook.mjs", 10],
    ],
  );
  // sem workspace do DG Claw ou sem bun, só os promptHooks entram
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", temWorkspace: false, temBun: true, promptHooks: [] }).length, 0);
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", temWorkspace: true, temBun: false, promptHooks: ["node /x.mjs"] }).length, 1);
});

test("config.toml gerado: hooks.json e confiança só dos hooks do DG Claw, preservando o que já havia", () => {
  const c = cenario("preserva");
  const alheio = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo da-pessoa", timeout: 3 }] }] }, outro: 1 };
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(alheio));
  const tomlAntes = '# meu\nmodel = "gpt-5"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[hooks.state."/outro/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\nenabled = false\n';
  fs.writeFileSync(path.join(c.home, "config.toml"), tomlAntes, { mode: 0o640 });

  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/novidades-hook.mjs"], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 5);

  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  assert.equal(hj.outro, 1);
  assert.equal(hj.hooks.UserPromptSubmit[0].hooks[0].command, "echo da-pessoa", "o hook da pessoa fica na frente, intacto");
  assert.equal(hj.hooks.UserPromptSubmit.length, 4);
  assert.equal(hj.hooks.SessionStart.length, 2);

  const toml = lerTexto(path.join(c.home, "config.toml"));
  assert.ok(toml.startsWith(tomlAntes), "tudo o que existia continua igual, na mesma ordem");
  assert.equal((toml.match(/\[hooks\.state\./g) ?? []).length, 1 + 5);
  assert.equal(fs.statSync(path.join(c.home, "config.toml")).mode & 0o777, 0o640);
  // o hook da pessoa (grupo 0 de UserPromptSubmit) NÃO foi confiado
  const arq = path.join(c.home, "hooks.json");
  assert.equal(toml.includes(`${arq}:user_prompt_submit:0:0`), false);
  assert.ok(toml.includes(`[hooks.state.${JSON.stringify(`${arq}:user_prompt_submit:1:0`)}]`));
  assert.ok(toml.includes(`trusted_hash = ${JSON.stringify(hashDoHook({ evento: "UserPromptSubmit", command: hj.hooks.UserPromptSubmit[1].hooks[0].command, timeout: 8 }))}`));
});

test("rodar duas vezes não duplica nada (hooks.json e config.toml ficam idênticos)", () => {
  const c = cenario("idempotente");
  const args = { home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/n.mjs"], area: "t", raiz: c.plugin };
  instalarHooksNoCodex(args);
  const j1 = lerTexto(path.join(c.home, "hooks.json"));
  const t1 = lerTexto(path.join(c.home, "config.toml"));
  instalarHooksNoCodex(args);
  assert.equal(lerTexto(path.join(c.home, "hooks.json")), j1);
  assert.equal(lerTexto(path.join(c.home, "config.toml")), t1);
});

test("conteúdo do hook mudou: a confiança é regravada e o hash velho some", () => {
  const c = cenario("muda");
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/v1.mjs"], area: "t", raiz: c.plugin });
  const antes = lerTexto(path.join(c.home, "config.toml"));
  const h1 = hashDoHook({ evento: "UserPromptSubmit", command: MARCA_DO_DGCLAW + "node /x/v1.mjs", timeout: 10 });
  assert.ok(antes.includes(h1));
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/v2.mjs"], area: "t", raiz: c.plugin });
  const depois = lerTexto(path.join(c.home, "config.toml"));
  const h2 = hashDoHook({ evento: "UserPromptSubmit", command: MARCA_DO_DGCLAW + "node /x/v2.mjs", timeout: 10 });
  assert.ok(depois.includes(h2));
  assert.equal(depois.includes(h1), false, "a seção do mesmo lugar foi atualizada, não duplicada");
  assert.equal((depois.match(/\[hooks\.state\./g) ?? []).length, 5);
  assert.equal(lerTexto(path.join(c.home, "hooks.json")).includes("v1.mjs"), false);
});

test("garantirConfiancaNoToml: acrescenta a linha em seção que existe sem trusted_hash e não mexe no resto", () => {
  const chave = "/h/hooks.json:session_start:0:0";
  const t = `[hooks.state.${JSON.stringify(chave)}]\nenabled = true\n\n[outra]\nx = 1\n`;
  const r = garantirConfiancaNoToml(t, [{ chave, hash: "sha256:zz" }]);
  assert.equal(r, `[hooks.state.${JSON.stringify(chave)}]\nenabled = true\ntrusted_hash = "sha256:zz"\n\n[outra]\nx = 1\n`);
});

test("hooks.json ilegível não é sobrescrito e ninguém ganha confiança", () => {
  const c = cenario("ilegivel");
  fs.writeFileSync(path.join(c.home, "hooks.json"), "{ isso nao e json");
  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 0);
  assert.equal(lerTexto(path.join(c.home, "hooks.json")), "{ isso nao e json");
  assert.equal(fs.existsSync(path.join(c.home, "config.toml")), false);
});

test("hooks.json que é atalho não é seguido", () => {
  const c = cenario("atalho");
  const alvo = path.join(c.raiz, "alvo.json");
  fs.writeFileSync(alvo, "{}");
  fs.symlinkSync(alvo, path.join(c.home, "hooks.json"));
  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 0);
  assert.equal(lerTexto(alvo), "{}");
});

test("sem workspace do DG Claw nem promptHooks, nada é criado", () => {
  const c = cenario("nada");
  fs.rmSync(path.join(c.ws, ".dgclaw"), { recursive: true });
  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 0);
  assert.equal(fs.existsSync(path.join(c.home, "hooks.json")), false);
});

test("o spawn do Codex instala os hooks e NUNCA passa bypass de confiança nos argumentos", async () => {
  const c = cenario("spawn");
  const ctx = ctxDeTeste({
    escolha: { provedor: "codex", auth: "assinatura", modelo: "" },
    cwd: c.ws,
    pastaDeHooks: pastaTemporaria("ph"),
    env: { CODEX_HOME: c.home, HOME: c.raiz, PATH: c.bin, DGCLAW_WORKSPACE: c.ws },
    config: { name: "x", cwd: c.ws, initialPrompt: "", provider: "codex-cli", permissionMode: "bypassPermissions", promptHooks: ["node /x/novidades-hook.mjs"] },
  } as never);
  await motorCodex.preparar(ctx);
  const todos = [...motorCodex.argsNova(ctx), ...motorCodex.argsRetomar(ctx, "id-1")].join("\n");
  assert.equal(/bypass-hook-trust|bypass_hook_trust|hook.?trust/i.test(todos), false, "nenhum argumento liga a confiança geral de hooks");
  assert.equal(/hooks\.state/.test(todos), false, "a confiança vai para o config.toml, não para -c");
  const hj = lerTexto(path.join(c.home, "hooks.json"));
  assert.ok(hj.includes("novidades-hook.mjs"));
  // promptHooks não são mais "ignorados"
  const fonte = fs.readFileSync(new URL("./provedores/codex.js", import.meta.url), "utf8");
  assert.equal(/bypass-hook-trust|bypass_hook_trust/.test(fonte), false, "o código do motor não cita o bypass");
});

// ---------------------------------------------------------------------------------------------
// Com o Codex de verdade: o que o próprio Codex diz do hook do DG Claw e do hook externo.
// Pulado (com aviso) se não há `codex` no PATH.

/** O codex de verdade: o PATH dos testes tem na frente um codex falso (test/fixtures/bin), que não serve aqui. */
function acharCodexReal(): string | null {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d || d.includes(`fixtures${path.sep}bin`)) continue;
    const f = path.join(d, "codex");
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const codexReal = acharCodexReal();
const temCodex = codexReal !== null && spawnSync(codexReal, ["--version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }).status === 0;

/** Pergunta ao app-server do Codex a lista de hooks de uma pasta (hooks/list) e devolve key -> trustStatus. */
function listarHooks(home: string, cwd: string): Array<{ key: string; trustStatus: string; sourcePath: string; currentHash: string; command: string; matcher: string | null; timeoutSec: number }> {
  const script = `
const { spawn } = require("node:child_process");
const p = spawn(${JSON.stringify(codexReal)}, ["app-server"], { env: { ...process.env, CODEX_HOME: ${JSON.stringify(home)} }, stdio: ["pipe", "pipe", "ignore"] });
let buf = "";
const send = (m) => p.stdin.write(JSON.stringify(m) + "\\n");
p.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "hooks/list", params: { cwds: [${JSON.stringify(cwd)}] } }); }
    if (m.id === 2) { console.log(JSON.stringify(m.result.data[0].hooks)); p.kill(); process.exit(0); }
  }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "0" } } });
setTimeout(() => { console.error("sem resposta do app-server"); p.kill(); process.exit(2); }, 20000);
`;
  return JSON.parse(execFileSync("node", ["-e", script], { encoding: "utf8", timeout: 30_000 }));
}

test("Codex de verdade: o hook do DG Claw sai trusted, o hash calculado aqui é o do Codex e o hook externo fica untrusted", { skip: temCodex ? false : "sem codex no PATH: teste de integração pulado" }, () => {
  const c = cenario("real");
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["echo do-dgclaw"], area: "t", raiz: c.plugin });
  // um repositório clonado pelo agente, com um hooks.json malicioso, numa pasta que o config.toml marca como confiável
  const projeto = path.join(c.raiz, "repo-clonado");
  fs.mkdirSync(path.join(projeto, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(projeto, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${path.join(c.raiz, "PWNED")}`, timeout: 5 }] }] } }));
  fs.appendFileSync(path.join(c.home, "config.toml"), `\n[projects.${JSON.stringify(projeto)}]\ntrust_level = "trusted"\n`);

  const dgclaw = listarHooks(c.home, c.ws);
  assert.equal(dgclaw.length, 5);
  for (const h of dgclaw) assert.equal(h.trustStatus, "trusted", `${h.key} deveria estar confiado`);
  for (const h of dgclaw) {
    const esperado = hashDoHook({
      evento: h.key.includes(":session_start:") ? "SessionStart" : "UserPromptSubmit",
      matcher: h.matcher ?? undefined,
      command: h.command,
      timeout: h.timeoutSec,
    });
    assert.equal(esperado, h.currentHash, `o hash de ${h.key} calculado aqui tem de ser o do Codex`);
  }

  const externo = listarHooks(c.home, projeto).filter((h) => h.sourcePath.startsWith(projeto));
  assert.ok(externo.length >= 1, "o Codex lista o hook do projeto (senão o teste não provaria nada)");
  for (const h of externo) assert.notEqual(h.trustStatus, "trusted", "hook de projeto externo nunca pode estar confiado");
  assert.equal(fs.existsSync(path.join(c.raiz, "PWNED")), false);
});

test("session-context.sh: no Codex a memória é reinjetada mesmo com o CLAUDE.md importando por @; no Claude não", { skip: process.env.DGCLAW_CATALOGO ? false : "sem DGCLAW_CATALOGO para achar o repositório" }, () => {
  const repo = path.dirname(path.dirname(process.env.DGCLAW_CATALOGO as string));
  const script = path.join(repo, "hooks", "session-context.sh");
  if (!fs.existsSync(script)) return;
  const ws = pastaTemporaria("sessao-ctx");
  fs.mkdirSync(path.join(ws, ".dgclaw"), { recursive: true });
  fs.writeFileSync(path.join(ws, "working-memory.md"), "# WM\n\n## Tarefas\n\nTOKEN-ABC-123\n");
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "regras\n@working-memory.md\n");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "regras\n");
  const rodar = (motor: string) =>
    spawnSync("bash", [script], { input: JSON.stringify({ source: "startup" }), encoding: "utf8", env: { ...process.env, DGCLAW_WORKSPACE: ws, DGCLAW_MOTOR: motor } }).stdout;
  assert.ok(rodar("codex").includes("TOKEN-ABC-123"), "Codex: a working-memory entra no contexto de início");
  assert.equal(rodar("claude").includes("TOKEN-ABC-123"), false, "Claude: o @ do CLAUDE.md já a carrega, então não duplica");
});
