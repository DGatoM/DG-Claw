import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ctxDeTeste, lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("codex-hooks");
const { hashDoHook, mesclarHooks, garantirConfiancaNoToml, hooksDoAgente, instalarHooksNoCodex, raizDoPlugin, citarParaShell, guardaDaSessao, donoDoComando, TomlNaoEditavel, MARCA_DO_DGCLAW } = await import("./provedores/codex-hooks.js");
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
  const hooks = hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/home/a/ws", temWorkspace: true, temBun: true, promptHooks: ["node /x/novidades-hook.mjs", "  "] });
  const fixo = "cd '/opt/dgclaw/app/hooks' && DGCLAW_WORKSPACE='/home/a/ws' ";
  assert.deepEqual(
    hooks.map((h) => [h.evento, h.matcher ?? "", h.command.replace(MARCA_DO_DGCLAW, ""), h.timeout]),
    [
      ["SessionStart", "", fixo + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" session-start', 8],
      ["SessionStart", "compact|clear", fixo + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos-reset', 5],
      ["UserPromptSubmit", "", fixo + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" user-prompt', 8],
      ["UserPromptSubmit", "", fixo + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos', 6],
      ["UserPromptSubmit", "", fixo + "node /x/novidades-hook.mjs", 10],
    ],
  );
  // sem workspace do DG Claw ou sem bun, só os promptHooks entram
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/w", temWorkspace: false, temBun: true, promptHooks: [] }).length, 0);
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/w", temWorkspace: true, temBun: false, promptHooks: ["node /x.mjs"] }).length, 1);
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
  const h1 = hashDoHook({ evento: "UserPromptSubmit", command: `cd ${citarParaShell(path.join(c.plugin, "hooks"))} && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE=${citarParaShell(c.ws)} node /x/v1.mjs`, timeout: 10 });
  assert.ok(antes.includes(h1));
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/v2.mjs"], area: "t", raiz: c.plugin });
  const depois = lerTexto(path.join(c.home, "config.toml"));
  const h2 = hashDoHook({ evento: "UserPromptSubmit", command: `cd ${citarParaShell(path.join(c.plugin, "hooks"))} && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE=${citarParaShell(c.ws)} node /x/v2.mjs`, timeout: 10 });
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

test("todo comando instalado fixa DGCLAW_WORKSPACE, citado para o shell (espaço e aspa simples no caminho)", () => {
  for (const nome of ["comum", "com espaco", "d'aspa; touch PWNED #"]) {
    const c = cenario("ws-" + nome.length);
    const ws2 = path.join(c.raiz, nome);
    fs.renameSync(c.ws, ws2);
    const env = { PATH: c.bin, DGCLAW_WORKSPACE: ws2 };
    const r = instalarHooksNoCodex({ home: c.home, env, cwd: ws2, promptHooks: ["node /x/n.mjs"], area: "t", raiz: c.plugin });
    assert.equal(r.instalados, 5);
    const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
    const comandos: string[] = Object.values(hj.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .flat()
      .flatMap((g) => g.hooks.map((m) => m.command));
    assert.equal(comandos.length, 5);
    const esperado = `cd ${citarParaShell(path.join(c.plugin, "hooks"))} && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE=${citarParaShell(ws2)} `;
    for (const cmd of comandos) {
      assert.ok(cmd.startsWith(esperado), `comando sem o workspace fixo: ${cmd}`);
      // o shell enxerga o caminho como UMA palavra, igual ao original, sem executar nada
      const saida = execFileSync("sh", ["-c", cmd.replace(/ (bun|node) .*$/, " printenv DGCLAW_WORKSPACE")], { encoding: "utf8" });
      assert.equal(saida.trimEnd(), ws2);
    }
    assert.equal(fs.existsSync(path.join(c.raiz, "PWNED")), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), "PWNED")), false);
  }
  assert.equal(citarParaShell("a'b"), `'a'\\''b'`);
});

test("o workspace fixo vem do agente, não do cwd de quem roda a sessão: o hash acompanha o comando", () => {
  const c = cenario("hash-ws");
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  const toml = lerTexto(path.join(c.home, "config.toml"));
  for (const g of hj.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>) {
    assert.ok(toml.includes(hashDoHook({ evento: "UserPromptSubmit", command: g.hooks[0].command, timeout: g.hooks[0].command.includes(" avisos") ? 6 : 8 })));
  }
});

// ---------------------------------------------------------------------------------------------
// config.toml: formas válidas do cabeçalho e recusa das que não dá para editar com segurança.

const CH = "/h/hooks.json:session_start:0:0";
const numCab = (t: string) => (t.match(/^\s*\[\s*hooks\s*\.\s*state\s*\./gm) ?? []).length;

test("hooks já instalados no formato antigo (marca no começo) são reconhecidos e substituídos, sem duplicar", () => {
  const c = cenario("migra");
  const antigo = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${MARCA_DO_DGCLAW}bun "/velho/hooks/dispatch.ts" avisos`, timeout: 6 }] }] } };
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(antigo));
  instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  const txt = lerTexto(path.join(c.home, "hooks.json"));
  assert.equal(txt.includes("/velho/"), false);
  assert.equal((txt.match(/dispatch\.ts/g) ?? []).length, 4);
});

test("toml: cabeçalho com comentário no fim é reconhecido, o comentário e as outras linhas ficam", () => {
  const t = `a = 1\n\n[hooks.state.${JSON.stringify(CH)}] # meu hook\nenabled = true # fica\ntrusted_hash = "sha256:velho" # antigo\n\n[z]\nb = 2\n`;
  const r = garantirConfiancaNoToml(t, [{ chave: CH, hash: "sha256:novo" }]);
  assert.equal(r, `a = 1\n\n[hooks.state.${JSON.stringify(CH)}] # meu hook\nenabled = true # fica\ntrusted_hash = "sha256:novo" # antigo\n\n[z]\nb = 2\n`);
  assert.equal(numCab(r), 1);
});

test("toml: espaços em volta dos colchetes e dos pontos", () => {
  const t = `[ hooks . state . ${JSON.stringify(CH)} ]\nx = 1\n`;
  const r = garantirConfiancaNoToml(t, [{ chave: CH, hash: "sha256:n" }]);
  assert.equal(r, `[ hooks . state . ${JSON.stringify(CH)} ]\nx = 1\ntrusted_hash = "sha256:n"\n`);
});

test("toml: chave em aspas literais (e hooks entre aspas)", () => {
  const t = `[hooks.state.'${CH}']\ntrusted_hash = 'sha256:velho'\n[outra]\n`;
  const r = garantirConfiancaNoToml(t, [{ chave: CH, hash: "sha256:n" }]);
  assert.equal(r, `[hooks.state.'${CH}']\ntrusted_hash = "sha256:n"\n[outra]\n`);
  const r2 = garantirConfiancaNoToml(`["hooks"."state".${JSON.stringify(CH)}]\n`, [{ chave: CH, hash: "sha256:n" }]);
  assert.equal(numCab(r2.replace(/"hooks"\."state"/, "hooks.state")), 1);
});

test("toml: chave com aspa dupla escapada no cabeçalho", () => {
  const ch = '/h "x"/hooks.json:user_prompt_submit:1:0';
  const r = garantirConfiancaNoToml(`[hooks.state.${JSON.stringify(ch)}]\ntrusted_hash = "sha256:a"\n`, [{ chave: ch, hash: "sha256:b" }]);
  assert.equal(r, `[hooks.state.${JSON.stringify(ch)}]\ntrusted_hash = "sha256:b"\n`);
});

test("toml: formas inline ou pontilhadas não são editadas, recusa com motivo", () => {
  const h = [{ chave: CH, hash: "sha256:n" }];
  const casos = [
    `[hooks]\nstate = { ${JSON.stringify(CH)} = { trusted_hash = "sha256:a" } }\n`,
    `[hooks.state]\n${JSON.stringify(CH)} = { trusted_hash = "sha256:a" }\n`,
    `hooks.state.${JSON.stringify(CH)}.trusted_hash = "sha256:a"\n`,
    `hooks = { state = {} }\n`,
    `[hooks.state.${JSON.stringify(CH)}]\ntrusted_hash = "a"\n[hooks.state.'${CH}']\n`,
  ];
  for (const t of casos) {
    assert.throws(() => garantirConfiancaNoToml(t, h), TomlNaoEditavel, t);
  }
});

test("toml: instalar com forma não editável não grava nada (nem o hooks.json) e deixa o config.toml igual", () => {
  const c = cenario("toml-inline");
  const arq = path.join(c.home, "hooks.json");
  const ch = `${arq}:user_prompt_submit:0:0`;
  const original = `# meu\nmodelo = 1\n[hooks]\nstate = { ${JSON.stringify(ch)} = { trusted_hash = "sha256:x" } }\n`;
  fs.writeFileSync(path.join(c.home, "config.toml"), original);
  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: ["node /x/n.mjs"], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 0);
  assert.equal(lerTexto(path.join(c.home, "config.toml")), original);
  assert.equal(fs.existsSync(arq), false);
});

test("toml: instalar com cabeçalho equivalente (comentário) não duplica a tabela e preserva as linhas alheias na ordem", () => {
  const c = cenario("toml-equiv");
  const arq = path.join(c.home, "hooks.json");
  const ch = `${arq}:user_prompt_submit:0:0`;
  const antes = `# topo\nmodel = "gpt-5"\n\n[ hooks.state.'${ch}' ] # meu hook\nenabled = false\n\n[projects."/a"]\ntrust_level = "trusted"\n`;
  fs.writeFileSync(path.join(c.home, "config.toml"), antes);
  const r = instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks: [], area: "t", raiz: c.plugin });
  assert.equal(r.instalados, 4);
  const t = lerTexto(path.join(c.home, "config.toml"));
  assert.equal((t.match(new RegExp(ch.replace(/[/.]/g, "\\$&"), "g")) ?? []).length, 1, "a mesma chave não aparece em duas tabelas");
  assert.ok(t.startsWith(`# topo\nmodel = "gpt-5"\n\n[ hooks.state.'${ch}' ] # meu hook\nenabled = false\ntrusted_hash = "sha256:`));
  assert.ok(t.includes('[projects."/a"]\ntrust_level = "trusted"\n'));
  assert.ok(t.indexOf("[projects") > t.indexOf("# meu hook"));
});

// ---------------------------------------------------------------------------------------------
// A cadeia de verdade: o comando instalado no hooks.json, rodado dentro de um "repositório externo"
// hostil (json.py, bunfig.toml com preload, .dgclaw/config.sh), não pode executar nada de lá.

function acharBun(): string | null {
  for (const d of [...(process.env.PATH ?? "").split(path.delimiter), "/tmp/bunx/node_modules/.bin"]) {
    if (!d || d.includes(`fixtures${path.sep}bin`)) continue;
    const f = path.join(d, "bun");
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (spawnSync(f, ["--version"], { encoding: "utf8" }).status === 0) return f;
    } catch {
      /* próximo */
    }
  }
  return null;
}
const bunReal = acharBun();
const raizDoRepo = process.env.DGCLAW_REPO_RAIZ || raizDoPlugin();
const motivoDePular = !bunReal ? "SEM BUN no PATH nem em /tmp/bunx: a cadeia real dos hooks NÃO foi testada" : !raizDoRepo ? "sem a raiz do repositório (DGCLAW_REPO_RAIZ): a cadeia real dos hooks NÃO foi testada" : false;
if (motivoDePular) console.error(`AVISO: ${motivoDePular}`);

test("cadeia real: os hooks instalados, rodados dentro de um repositório externo hostil, não executam nada dele", { skip: motivoDePular }, () => {
  const c = cenario("cadeia");
  const ext = path.join(c.raiz, "repo-externo");
  fs.mkdirSync(path.join(ext, ".dgclaw"), { recursive: true });
  const marca = (n: string) => path.join(c.raiz, `PWNED-${n}`);
  const py = (n: string) => `open(${JSON.stringify(marca(n))}, "w").write("x")\n`;
  for (const m of ["json", "os", "re", "sys", "sqlite3", "datetime", "pathlib", "unicodedata", "time", "tempfile", "hashlib", "argparse", "zoneinfo", "traceback"]) {
    fs.writeFileSync(path.join(ext, `${m}.py`), py(m));
  }
  fs.writeFileSync(path.join(ext, "pre.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marca("bunfig"))}, "x");\n`);
  fs.writeFileSync(path.join(ext, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
  fs.writeFileSync(path.join(ext, ".dgclaw", "config.sh"), `touch ${marca("configsh")}\n`);
  // o workspace legítimo do agente tem um aviso para o hook injetar (prova de que a cadeia rodou)
  fs.mkdirSync(path.join(c.ws, ".dgclaw", "retratos"), { recursive: true });
  const criado = new Date().toISOString();
  fs.writeFileSync(
    path.join(c.ws, ".dgclaw", "retratos", "avisos.json"),
    JSON.stringify({ versao: 1, agente: "a", cursor: 1, atualizado_em: criado, avisos: [{ id: 1, agente: "b", agente_nome: "B", para: ["todos"], tipo: "decisao", texto: "AVISO-DE-TESTE", criado_em: criado, recado: false }] }),
  );
  const bunDir = path.dirname(bunReal as string);
  const PATH = `${bunDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const r = instalarHooksNoCodex({ home: c.home, env: { PATH, DGCLAW_WORKSPACE: c.ws }, cwd: c.ws, promptHooks: [], area: "t", raiz: raizDoRepo });
  assert.equal(r.instalados, 4);
  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  const cmds: Array<{ ev: string; cmd: string }> = [];
  for (const [ev, grupos] of Object.entries(hj.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)) {
    for (const g of grupos) for (const m of g.hooks) cmds.push({ ev, cmd: m.command });
  }
  assert.equal(cmds.length, 4);
  let injetou = false;
  for (const { ev, cmd } of cmds) {
    const env = { ...process.env, PATH, HOME: c.raiz } as NodeJS.ProcessEnv;
    delete env.DGCLAW_WORKSPACE;
    const out = spawnSync("sh", ["-c", cmd], {
      cwd: ext,
      env,
      input: JSON.stringify({ cwd: ext, session_id: "s1", prompt: "oi", source: "startup", hook_event_name: ev }),
      encoding: "utf8",
      timeout: 60000,
    });
    if (out.stdout.includes("AVISO-DE-TESTE")) injetou = true;
    const fora = fs.readdirSync(c.raiz).filter((n) => n.startsWith("PWNED-"));
    assert.deepEqual(fora, [], `o comando executou código do repositório externo: ${cmd}\n${out.stderr}`);
  }
  assert.ok(injetou, "o hook de avisos não rodou de verdade (nenhuma saída com o aviso do workspace do agente)");
  assert.equal(fs.readdirSync(ext).filter((n) => n === "avisos-estado.json").length, 0);
});

// ---------------------------------------------------------------------------------------------
// Scanner de TOML: strings, comentários e arrays de várias linhas não podem enganar a busca do cabeçalho.

/** true/false se o tomllib do Python (>= 3.11) lê o texto; null se não há tomllib para conferir. */
function tomllibLe(texto: string): boolean | null {
  const r = spawnSync("python3", ["-I", "-c", "import sys\ntry:\n import tomllib\nexcept ImportError:\n sys.exit(3)\ntry:\n tomllib.loads(sys.stdin.read())\nexcept Exception:\n sys.exit(1)"], { input: texto, encoding: "utf8" });
  if (r.error || r.status === 3) return null;
  return r.status === 0;
}
const confereToml = (t: string) => {
  const ok = tomllibLe(t);
  if (ok !== null) assert.equal(ok, true, `o tomllib não lê o resultado:\n${t}`);
};
const H = [{ chave: CH, hash: "sha256:n" }];

test("toml: o caso do revisor (aspas triplas dentro de string antes da seção e dentro de comentário depois)", () => {
  const t = `developer_instructions = "Use ''' para strings Python."\n\n[hooks.state.${JSON.stringify(CH)}]\ntrusted_hash = "sha256:velho"\n# comentário com ''' aqui\n[outra]\nx = 1\n`;
  const r = garantirConfiancaNoToml(t, H);
  assert.equal(r, t.replace("sha256:velho", "sha256:n"));
  assert.equal(numCab(r), 1);
  confereToml(r);
});

test("toml: linha que parece cabeçalho dentro de string de várias linhas não é cabeçalho", () => {
  const falso = `[hooks.state.${JSON.stringify(CH)}]`;
  for (const q of ['"""', "'''"]) {
    const t = `texto = ${q}\n${falso}\ntrusted_hash = "sha256:velho"\n${q}\n`;
    const r = garantirConfiancaNoToml(t, H);
    assert.ok(r.startsWith(t), "o texto original fica intacto");
    assert.equal(r.slice(t.length), `\n${falso}\ntrusted_hash = "sha256:n"\n`, "a seção de verdade é acrescentada no fim");
    confereToml(r);
  }
  const t2 = `a = """x "" y\\""""\n[hooks.state.${JSON.stringify(CH)}]\n`;
  const r2 = garantirConfiancaNoToml(t2, H);
  assert.equal(r2, t2 + 'trusted_hash = "sha256:n"\n');
  confereToml(r2);
});

test("toml: [ dentro de array de várias linhas não é cabeçalho; comentário com aspas e string com # também não confundem", () => {
  const t =
    `lista = [\n  [1, 2],\n  ["hooks_falso"],\n  "a # b", # comentario com " e ' e """\n]\nnome = "tem # cerquilha" # e aspa " no comentário\n\n` +
    `[hooks.state.${JSON.stringify(CH)}] # ok\nenabled = true\n\n[fim]\nz = '''a\n[x]\n'''\n`;
  const r = garantirConfiancaNoToml(t, H);
  assert.equal(r, t.replace("enabled = true\n", 'enabled = true\ntrusted_hash = "sha256:n"\n'));
  confereToml(r);
});

test("toml: texto que o scanner não consegue ler é recusado, não adivinhado", () => {
  assert.throws(() => garantirConfiancaNoToml('a = """sem fechar\n', H), TomlNaoEditavel);
  assert.throws(() => garantirConfiancaNoToml("a = [1, 2\n", H), TomlNaoEditavel);
});

test("toml: todos os resultados dos casos de cabeçalho são TOML válido para o tomllib (quando há tomllib)", () => {
  const casos = [
    `[hooks.state.${JSON.stringify(CH)}] # meu hook\nenabled = true\n`,
    `[ hooks . state . ${JSON.stringify(CH)} ]\nx = 1\n`,
    `[hooks.state.'${CH}']\ntrusted_hash = 'sha256:velho'\n[outra]\n`,
    "",
    "a = 1",
  ];
  for (const t of casos) confereToml(garantirConfiancaNoToml(t, H));
});

// ---------------------------------------------------------------------------------------------
// Hooks do AGENTE: principal e paralelas dividem o CODEX_HOME e o hooks.json.

function sobe(c: ReturnType<typeof cenario>, sessaoId: string, promptHooks: string[]) {
  return instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks, area: "t", raiz: c.plugin, sessaoId });
}
const arquivosDoAgente = (c: ReturnType<typeof cenario>) => [lerTexto(path.join(c.home, "hooks.json")), lerTexto(path.join(c.home, "config.toml"))];

test("principal e paralela dividem o hooks.json: o resultado é o mesmo em qualquer ordem e nenhuma apaga a outra", () => {
  const ordens: string[][] = [["p", "q", "p", "q"], ["q", "p", "q", "p"], ["p", "q"], ["q", "p"], ["p", "p", "q", "q", "p"]];
  const resultados: string[][] = [];
  for (const ordem of ordens) {
    const c = cenario("compartilha-" + ordem.join(""));
    for (const quem of ordem) sobe(c, quem === "p" ? "principal" : "bastidores", quem === "p" ? ["node /x/da-principal.mjs"] : ["node /x/da-paralela.mjs"]);
    const [hj, toml] = arquivosDoAgente(c);
    assert.ok(hj.includes("da-principal.mjs") && hj.includes("da-paralela.mjs"), "os dois promptHooks estão no arquivo");
    assert.equal((hj.match(/dispatch\.ts/g) ?? []).length, 4, "os hooks do plugin aparecem uma vez só");
    assert.equal((toml.match(/\[hooks\.state\./g) ?? []).length, 6);
    // o hash depende do caminho da pasta temporária de cada cenário; a coerência dele é conferida em outro teste
    const hjObj = JSON.parse(hj) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>> };
    for (const [ev, grupos] of Object.entries(hjObj.hooks)) {
      for (const g of grupos) {
        const h = hashDoHook({ evento: ev as "SessionStart" | "UserPromptSubmit", matcher: g.matcher, command: g.hooks[0].command, timeout: g.hooks[0].timeout });
        assert.ok(toml.includes(h), `o hash de ${g.hooks[0].command} não está confiado`);
      }
    }
    resultados.push([hj.replaceAll(c.raiz, "RAIZ"), toml.replaceAll(c.raiz, "RAIZ").replace(/trusted_hash = "[^"]*"/g, "trusted_hash = H")]);
  }
  for (const r of resultados) assert.deepEqual(r, resultados[0], "o arquivo final não depende da ordem em que as sessões subiram");
});

test("subir a mesma sessão de novo não regrava nada; trocar os promptHooks dela troca só os dela", () => {
  const c = cenario("compartilha-estavel");
  sobe(c, "principal", ["node /x/a.mjs"]);
  sobe(c, "paralela", ["node /x/b.mjs"]);
  const antes = arquivosDoAgente(c);
  const mt = fs.statSync(path.join(c.home, "hooks.json")).mtimeMs;
  sobe(c, "principal", ["node /x/a.mjs"]);
  assert.deepEqual(arquivosDoAgente(c), antes);
  assert.equal(fs.statSync(path.join(c.home, "hooks.json")).mtimeMs, mt, "conteúdo igual: o arquivo nem é regravado");
  sobe(c, "principal", ["node /x/a2.mjs"]);
  const hj = lerTexto(path.join(c.home, "hooks.json"));
  assert.ok(hj.includes("a2.mjs") && hj.includes("b.mjs") && !hj.includes("/x/a.mjs"));
  sobe(c, "principal", []);
  assert.equal(lerTexto(path.join(c.home, "hooks.json")).includes("a2.mjs"), false, "sem promptHooks, os da sessão saem");
  assert.ok(lerTexto(path.join(c.home, "hooks.json")).includes("b.mjs"));
  assert.equal(fs.existsSync(path.join(c.home, ".dgclaw-hooks.lock")), false, "a trava é solta");
});

test("o promptHook guardado só roda na sessão dona (sh -c com DGCLAW_SESSAO_ID)", () => {
  const c = cenario("guarda");
  const marcador = path.join(c.raiz, "rodou");
  const id = "sessão d'um";
  sobe(c, id, [`touch ${citarParaShell(marcador)}`]);
  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  const cmd = (hj.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>).map((g) => g.hooks[0].command).find((x) => x.includes("touch")) as string;
  assert.ok(cmd);
  assert.equal(donoDoComando(cmd), id);
  assert.ok(cmd.includes(guardaDaSessao(id)));
  const base = { ...process.env } as NodeJS.ProcessEnv;
  delete base.DGCLAW_SESSAO_ID;
  for (const outra of ["paralela", "principal", undefined]) {
    const env = outra === undefined ? base : { ...base, DGCLAW_SESSAO_ID: outra };
    const r = spawnSync("sh", ["-c", cmd], { env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(marcador), false, `rodou na sessão ${outra}`);
  }
  const r = spawnSync("sh", ["-c", cmd], { env: { ...base, DGCLAW_SESSAO_ID: id }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marcador), true, "na sessão dona o hook roda");
});

test("o preparo do Codex põe DGCLAW_SESSAO_ID no ambiente do processo e instala o hook guardado pelo id da sessão", async () => {
  const c = cenario("preparo-sessao");
  const ctx = ctxDeTeste({
    escolha: { provedor: "codex", auth: "assinatura", modelo: "" },
    cwd: c.ws,
    pastaDeHooks: pastaTemporaria("ph"),
    env: { CODEX_HOME: c.home, HOME: c.raiz, PATH: c.bin, DGCLAW_WORKSPACE: c.ws },
    config: { name: "x", cwd: c.ws, initialPrompt: "", provider: "codex-cli", permissionMode: "bypassPermissions", promptHooks: ["node /x/p.mjs"] },
  } as never);
  await motorCodex.preparar(ctx);
  assert.equal(ctx.env.DGCLAW_SESSAO_ID, ctx.id);
  const comandos = JSON.stringify(JSON.parse(lerTexto(path.join(c.home, "hooks.json"))).hooks);
  assert.ok(comandos.includes(JSON.stringify(guardaDaSessao(ctx.id)).slice(1, -1)), "o hook do promptHook traz a guarda desta sessão");
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
