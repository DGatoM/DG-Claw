import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ctxDeTeste, lerTexto, pastaTemporaria, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("codex-hooks");
const { hashDoHook, mesclarHooks, garantirConfiancaNoToml, hooksDoAgente, instalarHooksNoCodex, raizDoPlugin, citarParaShell, gravarPromptHooksDaSessao, pareceDoDgclaw, TomlNaoEditavel, MARCA_DO_DGCLAW } = await import("./provedores/codex-hooks.js");
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
  fs.writeFileSync(path.join(bin, "python3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const estado = path.join(raiz, "estado");
  fs.mkdirSync(estado);
  return { raiz, plugin, ws, home, bin, estado, env: { PATH: bin, DGCLAW_WORKSPACE: ws } as Record<string, string> };
}

/** Instala como o runner faz: com a pasta de estado e o id da sessão. */
function instala(c: ReturnType<typeof cenario>, promptHooks: string[] = [], sessaoId = "principal", extra: Record<string, unknown> = {}) {
  return instalarHooksNoCodex({ home: c.home, env: c.env, cwd: c.ws, promptHooks, area: "t", raiz: c.plugin, sessaoId, pastaDeEstado: c.estado, ...extra } as never);
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

test("hooksDoAgente: os quatro hooks do plugin com os mesmos timeouts do hooks.json do Claude, mais o hook fixo dos promptHooks", () => {
  const hooks = hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/home/a/ws", temWorkspace: true, temBun: true, pastaDeEstado: "/home/a/.plataforma" });
  const pre = "cd '/opt/dgclaw/app/hooks' && DGCLAW_WORKSPACE='/home/a/ws' ";
  assert.deepEqual(
    hooks.map((h) => [h.evento, h.matcher ?? "", h.command.replace(MARCA_DO_DGCLAW, ""), h.timeout]),
    [
      ["SessionStart", "", pre + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" session-start', 8],
      ["SessionStart", "compact|clear", pre + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos-reset', 5],
      ["UserPromptSubmit", "", pre + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" user-prompt', 8],
      ["UserPromptSubmit", "", pre + 'bun "/opt/dgclaw/app/hooks/dispatch.ts" avisos', 6],
      ["UserPromptSubmit", "", pre + "DGCLAW_PROMPT_HOOKS_DIR='/home/a/.plataforma/prompt-hooks' python3 -I '/opt/dgclaw/app/hooks/prompt-hooks-sessao.py'", 10],
    ],
  );
  // o conjunto não depende da sessão nem dos promptHooks dela: só dos dados do runner
  assert.deepEqual(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/home/a/ws", temWorkspace: true, temBun: true, pastaDeEstado: "/home/a/.plataforma" }), hooks);
  // sem workspace do DG Claw ou sem bun, só o hook dos promptHooks fica; sem python3, os do plugin
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/w", temWorkspace: false, temBun: true, pastaDeEstado: "/e" }).length, 1);
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/w", temWorkspace: true, temBun: false, temPython: false, pastaDeEstado: "/e" }).length, 0);
  assert.equal(hooksDoAgente({ raiz: "/opt/dgclaw/app", workspace: "/w", temWorkspace: true, temBun: true }).length, 4);
});

test("config.toml gerado: hooks.json e confiança só dos hooks do DG Claw, preservando o que já havia", () => {
  const c = cenario("preserva");
  const alheio = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo da-pessoa", timeout: 3 }] }] }, outro: 1 };
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(alheio));
  const tomlAntes = '# meu\nmodel = "gpt-5"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[hooks.state."/outro/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:aaa"\nenabled = false\n';
  fs.writeFileSync(path.join(c.home, "config.toml"), tomlAntes, { mode: 0o640 });

  const r = instala(c, ["node /x/novidades-hook.mjs"]);
  assert.equal(r.instalados, 5);

  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  assert.equal(hj.outro, 1);
  assert.equal(hj.hooks.UserPromptSubmit[0].hooks[0].command, "echo da-pessoa", "o hook da pessoa fica na frente, intacto");
  assert.equal(hj.hooks.UserPromptSubmit.length, 4);
  assert.equal(JSON.stringify(hj).includes("novidades-hook.mjs"), false, "os promptHooks da sessão não vão para o hooks.json");
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
  instala(c, ["node /x/n.mjs"]);
  const j1 = lerTexto(path.join(c.home, "hooks.json"));
  const t1 = lerTexto(path.join(c.home, "config.toml"));
  instala(c, ["node /x/n.mjs"]);
  assert.equal(lerTexto(path.join(c.home, "hooks.json")), j1);
  assert.equal(lerTexto(path.join(c.home, "config.toml")), t1);
});

test("conteúdo do hook mudou: a confiança é regravada e o hash velho some", () => {
  const c = cenario("muda");
  instala(c);
  const antes = lerTexto(path.join(c.home, "config.toml"));
  const hooksAntes = hooksDoAgente({ raiz: c.plugin, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: c.estado });
  const h1 = hashDoHook(hooksAntes[4]);
  assert.ok(antes.includes(h1));
  // a pasta de estado muda de lugar: o comando do hook fixo muda, e com ele o hash
  const novoEstado = path.join(c.raiz, "estado2");
  instala(c, [], "principal", { pastaDeEstado: novoEstado });
  const depois = lerTexto(path.join(c.home, "config.toml"));
  const h2 = hashDoHook(hooksDoAgente({ raiz: c.plugin, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: novoEstado })[4]);
  assert.ok(depois.includes(h2));
  assert.equal(depois.includes(h1), false, "a seção do mesmo lugar foi atualizada, não duplicada");
  assert.equal((depois.match(/\[hooks\.state\./g) ?? []).length, 5);
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
    const r = instalarHooksNoCodex({ home: c.home, env, cwd: ws2, promptHooks: ["node /x/n.mjs"], area: "t", raiz: c.plugin, sessaoId: "principal", pastaDeEstado: c.estado });
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
      const saida = execFileSync("sh", ["-c", cmd.replace(/ (bun|node|DGCLAW_PROMPT_HOOKS_DIR=\S+ python3) .*$/, " printenv DGCLAW_WORKSPACE")], { encoding: "utf8" });
      assert.equal(saida.trimEnd(), ws2);
    }
    assert.equal(fs.existsSync(path.join(c.raiz, "PWNED")), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), "PWNED")), false);
  }
  assert.equal(citarParaShell("a'b"), `'a'\\''b'`);
});

test("o workspace fixo vem do agente, não do cwd de quem roda a sessão: o hash acompanha o comando", () => {
  const c = cenario("hash-ws");
  instala(c);
  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  const toml = lerTexto(path.join(c.home, "config.toml"));
  for (const g of hj.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string; timeout: number }> }>) {
    assert.ok(toml.includes(hashDoHook({ evento: "UserPromptSubmit", command: g.hooks[0].command, timeout: g.hooks[0].timeout })));
  }
});

// ---------------------------------------------------------------------------------------------
// config.toml: formas válidas do cabeçalho e recusa das que não dá para editar com segurança.

const CH = "/h/hooks.json:session_start:0:0";
const numCab = (t: string) => (t.match(/^\s*\[\s*hooks\s*\.\s*state\s*\./gm) ?? []).length;

test("hooks já instalados no formato antigo (marca no começo, guarda de sessão) são tirados e substituídos, sem duplicar", () => {
  const c = cenario("migra");
  const antigo = { hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command: `${MARCA_DO_DGCLAW}bun "/velho/hooks/dispatch.ts" avisos`, timeout: 6 }] },
    { hooks: [{ type: "command", command: `cd '/x' && { [ "$DGCLAW_SESSAO_ID" = 'p' ] || exit 0; } && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE='/w' node /velho/p.mjs`, timeout: 10 }] },
  ] } };
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(antigo));
  instala(c);
  const txt = lerTexto(path.join(c.home, "hooks.json"));
  assert.equal(txt.includes("/velho/"), false);
  assert.equal((txt.match(/dispatch\.ts/g) ?? []).length, 4);
  assert.equal((txt.match(/prompt-hooks-sessao\.py/g) ?? []).length, 1);
});

test("SEGURANÇA: comando forjado no hooks.json (marca e guarda inventadas) não ganha trusted_hash nem sobrevive; o hook legítimo da pessoa sobrevive sem confiança nossa", () => {
  const c = cenario("forjado");
  const arq = path.join(c.home, "hooks.json");
  const forjado = `cd / && printf PROVA; # ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE='/w' { [ "$DGCLAW_SESSAO_ID" = 'principal' ] || exit 0; } touch ${path.join(c.raiz, "PWNED")}`;
  const outroForjado = `${MARCA_DO_DGCLAW}touch ${path.join(c.raiz, "PWNED2")}`;
  const da_pessoa = "echo da-pessoa";
  fs.writeFileSync(arq, JSON.stringify({ hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command: forjado, timeout: 5 }] },
    { hooks: [{ type: "command", command: da_pessoa, timeout: 5 }, { type: "command", command: outroForjado, timeout: 5 }] },
  ] } }));
  // a pessoa já tinha confiado no próprio hook e, por engano ou ataque, há um hash velho no lugar do forjado
  const chaveForjado = `${arq}:user_prompt_submit:2:0`; // onde cai um dos hooks calculados (o forjado do grupo 0 vira o primeiro)
  fs.writeFileSync(path.join(c.home, "config.toml"), `[hooks.state.${JSON.stringify(chaveForjado)}]\ntrusted_hash = "sha256:de-outro"\n`);
  const r = instala(c);
  assert.equal(r.instalados, 5);
  const hj = JSON.parse(lerTexto(arq));
  const comandos: string[] = (hj.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((m) => m.command));
  assert.equal(comandos.includes(forjado), false);
  assert.equal(comandos.includes(outroForjado), false);
  assert.ok(comandos.includes(da_pessoa), "o hook legítimo da pessoa continua");
  const toml = lerTexto(path.join(c.home, "config.toml"));
  // a única confiança gravada é a dos comandos calculados; o hook da pessoa não ganha nenhuma
  const doDgclaw = comandos.filter((x) => pareceDoDgclaw(x));
  assert.equal(doDgclaw.length, 3);
  const grupos = hj.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
  const idxPessoa = grupos.findIndex((g) => g.hooks.some((m) => m.command === da_pessoa));
  assert.equal(toml.includes(`${arq}:user_prompt_submit:${idxPessoa}:0`), false, "o hook da pessoa não ganha trusted_hash nosso");
  assert.equal(toml.includes("sha256:de-outro"), false, "o valor velho foi trocado pelo hash do comando que nós escrevemos");
  for (const h of hooksDoAgente({ raiz: c.plugin, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: c.estado })) {
    assert.ok(toml.includes(hashDoHook(h)), "cada comando calculado tem o seu hash");
  }
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
  const r = instala(c, ["node /x/n.mjs"]);
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
  const r = instala(c);
  assert.equal(r.instalados, 5);
  const t = lerTexto(path.join(c.home, "config.toml"));
  assert.equal((t.match(new RegExp(ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), "g")) ?? []).length, 1, "a mesma chave não aparece em duas tabelas");
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
  const ctxJson = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX-DO-PROMPTHOOK" } });
  const r = instalarHooksNoCodex({ home: c.home, env: { PATH, DGCLAW_WORKSPACE: c.ws }, cwd: c.ws, promptHooks: [`echo '${ctxJson}'`, "cat >/dev/null; echo texto-simples"], area: "t", raiz: raizDoRepo, sessaoId: "principal", pastaDeEstado: c.estado });
  assert.equal(r.instalados, 5);
  const hj = JSON.parse(lerTexto(path.join(c.home, "hooks.json")));
  const cmds: Array<{ ev: string; cmd: string }> = [];
  for (const [ev, grupos] of Object.entries(hj.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)) {
    for (const g of grupos) for (const m of g.hooks) cmds.push({ ev, cmd: m.command });
  }
  assert.equal(cmds.length, 5);
  let injetou = false;
  let promptHooksRodaram = false;
  for (const { ev, cmd } of cmds) {
    const env = { ...process.env, PATH, HOME: c.raiz, DGCLAW_SESSAO_ID: "principal" } as NodeJS.ProcessEnv;
    delete env.DGCLAW_WORKSPACE;
    const out = spawnSync("sh", ["-c", cmd], {
      cwd: ext,
      env,
      input: JSON.stringify({ cwd: ext, session_id: "s1", prompt: "oi", source: "startup", hook_event_name: ev }),
      encoding: "utf8",
      timeout: 60000,
    });
    if (out.stdout.includes("AVISO-DE-TESTE")) injetou = true;
    if (out.stdout.includes("CTX-DO-PROMPTHOOK")) {
      promptHooksRodaram = true;
      assert.equal(out.stdout.trim().split("\n").length, 1, "uma única linha de JSON por hook");
      assert.equal(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, "CTX-DO-PROMPTHOOK\n\ntexto-simples");
    }
    const fora = fs.readdirSync(c.raiz).filter((n) => n.startsWith("PWNED-"));
    assert.deepEqual(fora, [], `o comando executou código do repositório externo: ${cmd}\n${out.stderr}`);
  }
  assert.ok(injetou, "o hook de avisos não rodou de verdade (nenhuma saída com o aviso do workspace do agente)");
  assert.ok(promptHooksRodaram, "o hook dos promptHooks não rodou de verdade");
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
// Posição dos hooks da pessoa: a chave de confiança do Codex inclui o índice.

type Gr = { matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> };
const lerHooks = (c: ReturnType<typeof cenario>) => JSON.parse(lerTexto(path.join(c.home, "hooks.json"))) as { hooks: Record<string, Gr[]> };
const deles = (g: Gr) => g.hooks.some((m) => !pareceDoDgclaw(m.command));

test("hook da pessoa acrescentado e confiado depois da instalação fica no mesmo índice, com o mesmo trusted_hash, ao reinstalar", () => {
  const c = cenario("posicao-depois");
  instala(c);
  const hj = lerHooks(c);
  const antes = hj.hooks.UserPromptSubmit.length;
  const dela = { type: "command", command: "echo meu-hook-confiado", timeout: 7 };
  hj.hooks.UserPromptSubmit.push({ hooks: [dela] });
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(hj, null, 2));
  const chave = `${path.join(c.home, "hooks.json")}:user_prompt_submit:${antes}:0`;
  const hashDela = hashDoHook({ evento: "UserPromptSubmit", command: dela.command, timeout: 7 });
  fs.appendFileSync(path.join(c.home, "config.toml"), `\n[hooks.state.${JSON.stringify(chave)}]\ntrusted_hash = ${JSON.stringify(hashDela)}\n`);
  const tomlAntes = lerTexto(path.join(c.home, "config.toml"));
  for (let i = 0; i < 3; i++) instala(c);
  const depois = lerHooks(c).hooks.UserPromptSubmit;
  assert.equal(depois[antes].hooks[0].command, dela.command, "o hook dela continua no mesmo índice");
  assert.equal(depois.length, antes + 1);
  const toml = lerTexto(path.join(c.home, "config.toml"));
  assert.equal(toml, tomlAntes, "a confiança dela e todo o resto ficaram idênticos");
  assert.equal(toml.split(hashDela).length - 1, 1);
});

test("hooks da pessoa na frente ficam onde estão; os nossos entram depois e não mexem no índice dela", () => {
  const c = cenario("posicao-frente");
  const a = { type: "command", command: "echo a", timeout: 5 };
  const b = { type: "command", command: "echo b", timeout: 5 };
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [a] }, { hooks: [b] }] } }));
  instala(c);
  instala(c, ["x"]);
  const g = lerHooks(c).hooks.UserPromptSubmit;
  assert.deepEqual([g[0].hooks[0].command, g[1].hooks[0].command], ["echo a", "echo b"]);
  assert.equal(g.slice(2).every((x) => pareceDoDgclaw(x.hooks[0].command)), true);
  const toml = lerTexto(path.join(c.home, "config.toml"));
  for (const i of [0, 1]) assert.equal(toml.includes(`user_prompt_submit:${i}:0`), false, "nunca grava confiança para o hook da pessoa");
});

test("arquivo antigo com os nossos na frente: são trocados NO LUGAR e o hook da pessoa não muda de índice", () => {
  const c = cenario("posicao-antigo");
  const dela = { type: "command", command: "echo da-pessoa", timeout: 5 };
  const velho = (n: string) => ({ hooks: [{ type: "command", command: `${MARCA_DO_DGCLAW}bun "/velho/${n}" avisos`, timeout: 6 }] });
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [velho("a"), velho("b"), { hooks: [dela] }] } }));
  instala(c);
  const g = lerHooks(c).hooks.UserPromptSubmit;
  assert.equal(g[2].hooks[0].command, "echo da-pessoa", "continua no índice 2");
  assert.equal(g.length, 4);
  assert.equal(g.filter(deles).length, 1);
});

test("nossos obsoletos ANTES de um grupo da pessoa: o índice dela muda (inevitável) e mesclarHooks avisa", () => {
  const dela = { type: "command", command: "echo da-pessoa", timeout: 5 };
  const velho = (n: number) => ({ hooks: [{ type: "command", command: `${MARCA_DO_DGCLAW}bun "/velho/${n}" avisos`, timeout: 6 }] });
  const atual = { hooks: { UserPromptSubmit: [velho(1), velho(2), velho(3), velho(4), { hooks: [dela] }] } };
  const hooks = hooksDoAgente({ raiz: "/p", workspace: "/w", temWorkspace: true, temBun: true, pastaDeEstado: "/e" }).filter((h) => h.evento === "UserPromptSubmit");
  assert.equal(hooks.length, 3);
  const r = mesclarHooks(atual, hooks, "/h/hooks.json");
  assert.equal(r.deslocados, 1);
  assert.equal(r.novo.hooks!.UserPromptSubmit.length, 4);
  assert.equal(r.novo.hooks!.UserPromptSubmit[3].hooks![0].command, "echo da-pessoa");
  assert.equal(r.confiar.some((x) => x.chave.endsWith(":user_prompt_submit:3:0")), false, "o índice 3 é dela e não ganha confiança");
});

// ---------------------------------------------------------------------------------------------
// Confiança da pasta e dos hooks: uma transação só.

test("confiança da pasta e dos hooks entram no mesmo config.toml, numa só gravação, preservando o que havia", () => {
  const c = cenario("pasta-e-hooks");
  const antigo = '[tui]\nx = 1\n';
  fs.writeFileSync(path.join(c.home, "config.toml"), antigo, { mode: 0o640 });
  instala(c, [], "principal", { confiancaDaPasta: "/casa/agente" });
  instala(c, [], "principal", { confiancaDaPasta: "/casa/agente" });
  const t = lerTexto(path.join(c.home, "config.toml"));
  assert.ok(t.startsWith(antigo));
  assert.equal(t.split('[projects."/casa/agente"]').length - 1, 1);
  assert.equal((t.match(/\[hooks\.state\./g) ?? []).length, 5);
  assert.equal(fs.statSync(path.join(c.home, "config.toml")).mode & 0o777, 0o640);
  confereToml(t);
});

test("sem hooks para instalar (hooks.json ilegível) a confiança da pasta ainda é gravada", () => {
  const c = cenario("pasta-sem-hooks");
  fs.writeFileSync(path.join(c.home, "hooks.json"), "{ nao e json");
  const r = instala(c, [], "principal", { confiancaDaPasta: "/casa/x" });
  assert.equal(r.instalados, 0);
  assert.ok(lerTexto(path.join(c.home, "config.toml")).includes('[projects."/casa/x"]\ntrust_level = "trusted"\n'));
});

test("trava ocupada: nem os hooks nem a confiança da pasta são gravados", () => {
  const c = cenario("pasta-trava");
  fs.mkdirSync(path.join(c.home, ".dgclaw-hooks.lock"));
  const r = instala(c, [], "principal", { esperaDaTravaMs: 200, confiancaDaPasta: "/casa/x" });
  assert.equal(r.instalados, 0);
  assert.equal(fs.existsSync(path.join(c.home, "config.toml")), false);
});

// ---------------------------------------------------------------------------------------------
// Hooks do AGENTE: principal e paralelas dividem o CODEX_HOME. O hooks.json e a confiança são iguais
// para todas as sessões; os promptHooks de cada uma ficam no arquivo de estado dela.

const arquivosDoAgente = (c: ReturnType<typeof cenario>) => [lerTexto(path.join(c.home, "hooks.json")), lerTexto(path.join(c.home, "config.toml"))];

test("principal e paralela dividem o hooks.json: o resultado é o mesmo em qualquer ordem e cada uma tem o seu arquivo de promptHooks", () => {
  const ordens: string[][] = [["p", "q", "p", "q"], ["q", "p", "q", "p"], ["p", "q"], ["q", "p"], ["p", "p", "q", "q", "p"]];
  const resultados: string[][] = [];
  for (const ordem of ordens) {
    const c = cenario("compartilha-" + ordem.join(""));
    for (const quem of ordem) instala(c, quem === "p" ? ["node /x/da-principal.mjs"] : ["node /x/da-paralela.mjs"], quem === "p" ? "principal" : "bastidores");
    const [hj, toml] = arquivosDoAgente(c);
    assert.equal(hj.includes("da-principal.mjs") || hj.includes("da-paralela.mjs"), false, "nenhum promptHook de sessão está no hooks.json");
    assert.equal((hj.match(/dispatch\.ts/g) ?? []).length, 4, "os hooks do plugin aparecem uma vez só");
    assert.equal((toml.match(/\[hooks\.state\./g) ?? []).length, 5);
    assert.deepEqual(JSON.parse(lerTexto(path.join(c.estado, "prompt-hooks", "principal.json"))).comandos, ["node /x/da-principal.mjs"]);
    assert.deepEqual(JSON.parse(lerTexto(path.join(c.estado, "prompt-hooks", "bastidores.json"))).comandos, ["node /x/da-paralela.mjs"]);
    // o conjunto calculado e o hash de cada comando
    const esperados = hooksDoAgente({ raiz: c.plugin, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: c.estado });
    for (const h of esperados) assert.ok(toml.includes(hashDoHook(h)));
    resultados.push([hj.replaceAll(c.raiz, "RAIZ"), toml.replaceAll(c.raiz, "RAIZ").replace(/trusted_hash = "[^"]*"/g, "trusted_hash = H")]);
  }
  for (const r of resultados) assert.deepEqual(r, resultados[0], "o arquivo final não depende da ordem em que as sessões subiram");
});

test("subir a mesma sessão de novo não regrava nada; trocar os promptHooks dela só muda o arquivo de estado dela", () => {
  const c = cenario("compartilha-estavel");
  instala(c, ["node /x/a.mjs"], "principal");
  const antes = arquivosDoAgente(c);
  const arqEstado = path.join(c.estado, "prompt-hooks", "principal.json");
  const mtH = fs.statSync(path.join(c.home, "hooks.json")).mtimeMs;
  const mtE = fs.statSync(arqEstado).mtimeMs;
  instala(c, ["node /x/a.mjs"], "principal");
  assert.deepEqual(arquivosDoAgente(c), antes);
  assert.equal(fs.statSync(path.join(c.home, "hooks.json")).mtimeMs, mtH, "conteúdo igual: o hooks.json nem é regravado");
  assert.equal(fs.statSync(arqEstado).mtimeMs, mtE, "o arquivo de estado também não");
  assert.equal(fs.statSync(arqEstado).mode & 0o777, 0o600);
  instala(c, ["node /x/a2.mjs"], "principal");
  assert.deepEqual(arquivosDoAgente(c), antes, "mudar os promptHooks não mexe no hooks.json nem na confiança");
  assert.deepEqual(JSON.parse(lerTexto(arqEstado)).comandos, ["node /x/a2.mjs"]);
  assert.equal(fs.existsSync(path.join(c.home, ".dgclaw-hooks.lock")), false, "a trava é solta");
});

test("id de sessão com caractere perigoso não vira nome de arquivo", () => {
  const c = cenario("id-ruim");
  for (const id of ["../x", "a/b", "a.b", "", "a b"]) {
    assert.equal(gravarPromptHooksDaSessao({ pastaDeEstado: c.estado, sessaoId: id, promptHooks: ["echo oi"], area: "t" }), false, id);
  }
  assert.equal(fs.existsSync(path.join(c.estado, "x.json")), false);
  assert.equal(fs.existsSync(path.join(c.estado, "prompt-hooks")), false);
});

// O despachante de verdade (Python do repositório), rodado como o Codex roda: sh -c, com cwd hostil.
const despachante = raizDoRepo ? path.join(raizDoRepo, "hooks", "prompt-hooks-sessao.py") : "";
const temPython = spawnSync("python3", ["--version"]).status === 0;
const pularDespachante = !raizDoRepo || !temPython ? "sem python3 ou sem a raiz do repositório: o despachante NÃO foi testado" : false;
if (pularDespachante) console.error(`AVISO: ${pularDespachante}`);

function rodaDespachante(c: ReturnType<typeof cenario>, env: Record<string, string>, cwd: string, entrada = "{}") {
  const e = { ...process.env, ...env } as NodeJS.ProcessEnv;
  for (const k of Object.keys(env)) if (env[k] === "") delete e[k];
  return spawnSync("python3", ["-I", despachante], { cwd, env: e, input: entrada, encoding: "utf8", timeout: 30000 });
}

test("despachante: roda só os promptHooks da sessão do ambiente, repassa o stdin e junta as saídas num JSON", { skip: pularDespachante }, () => {
  const c = cenario("desp");
  const m1 = path.join(c.raiz, "m-principal");
  const m2 = path.join(c.raiz, "m-paralela");
  const ent = path.join(c.raiz, "stdin-visto");
  gravarPromptHooksDaSessao({ pastaDeEstado: c.estado, sessaoId: "principal", promptHooks: [`touch ${m1}`, `cat > ${ent}; echo '{"hookSpecificOutput":{"additionalContext":"A"}}'`, "echo B"], area: "t" });
  gravarPromptHooksDaSessao({ pastaDeEstado: c.estado, sessaoId: "paralela", promptHooks: [`touch ${m2}`], area: "t" });
  const dir = path.join(c.estado, "prompt-hooks");
  const r = rodaDespachante(c, { DGCLAW_SESSAO_ID: "principal", DGCLAW_PROMPT_HOOKS_DIR: dir, DGCLAW_WORKSPACE: c.ws }, c.raiz, '{"prompt":"oi"}');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(m1), true);
  assert.equal(fs.existsSync(m2), false, "o hook da outra sessão não roda");
  assert.equal(lerTexto(ent), '{"prompt":"oi"}', "o stdin do hook chega a cada comando");
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "A\n\nB" } });
  // sem variável, sem arquivo ou com a pasta errada: sai 0 e calado
  for (const env of [{ DGCLAW_SESSAO_ID: "", DGCLAW_PROMPT_HOOKS_DIR: dir }, { DGCLAW_SESSAO_ID: "nao-existe", DGCLAW_PROMPT_HOOKS_DIR: dir }, { DGCLAW_SESSAO_ID: "principal", DGCLAW_PROMPT_HOOKS_DIR: "" }]) {
    const q = rodaDespachante(c, env, c.raiz);
    assert.equal(q.status, 0);
    assert.equal(q.stdout, "");
  }
});

test("despachante: id com ../ não lê fora da pasta de promptHooks", { skip: pularDespachante }, () => {
  const c = cenario("desp-traversal");
  const marcador = path.join(c.raiz, "PWNED-traversal");
  const dir = path.join(c.estado, "prompt-hooks");
  fs.mkdirSync(dir, { recursive: true });
  // um x.json logo acima da pasta, que um "../x" alcançaria
  fs.writeFileSync(path.join(c.estado, "x.json"), JSON.stringify({ versao: 1, comandos: [`touch ${marcador}`] }));
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ versao: 1, comandos: [`touch ${marcador}-ok`] }));
  for (const id of ["../x", "..", "../prompt-hooks/ok", "ok/../../x", "/etc/passwd"]) {
    const r = rodaDespachante(c, { DGCLAW_SESSAO_ID: id, DGCLAW_PROMPT_HOOKS_DIR: dir }, c.raiz);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(fs.existsSync(marcador), false);
  assert.equal(fs.existsSync(marcador + "-ok"), false);
  rodaDespachante(c, { DGCLAW_SESSAO_ID: "ok", DGCLAW_PROMPT_HOOKS_DIR: dir }, c.raiz);
  assert.equal(fs.existsSync(marcador + "-ok"), true, "o id válido roda");
});

test("despachante: de um cwd hostil (json.py ao lado) não carrega nada do cwd", { skip: pularDespachante }, () => {
  const c = cenario("desp-cwd");
  const ext = path.join(c.raiz, "repo");
  fs.mkdirSync(ext);
  const marcador = path.join(c.raiz, "PWNED-json");
  for (const m of ["json", "os", "re", "subprocess", "sys"]) fs.writeFileSync(path.join(ext, `${m}.py`), `open(${JSON.stringify(marcador)}, "w").write("x")\n`);
  gravarPromptHooksDaSessao({ pastaDeEstado: c.estado, sessaoId: "principal", promptHooks: ["echo ok"], area: "t" });
  const dir = path.join(c.estado, "prompt-hooks");
  // exatamente como o runner instala: cd para a pasta dos hooks e python3 -I
  const hooks = hooksDoAgente({ raiz: raizDoRepo as string, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: c.estado });
  const cmd = hooks[hooks.length - 1].command;
  const r = spawnSync("sh", ["-c", cmd], { cwd: ext, env: { ...process.env, DGCLAW_SESSAO_ID: "principal", PYTHONPATH: ext } as NodeJS.ProcessEnv, input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(marcador), false, "o despachante importou algo do cwd");
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, "ok");
  assert.ok(cmd.includes(citarParaShell(dir)));
});

test("despachante: dois comandos que leem o stdin até o fim e dormem 6 s terminam juntos, em menos de 10 s, com as duas saídas", { skip: pularDespachante }, () => {
  const c = cenario("desp-paralelo");
  const um = (n: string) => `cat >/dev/null; sleep 6; echo ${n}`;
  gravarPromptHooksDaSessao({ pastaDeEstado: c.estado, sessaoId: "principal", promptHooks: [um("UM"), um("DOIS")], area: "t" });
  const t0 = Date.now();
  const r = rodaDespachante(c, { DGCLAW_SESSAO_ID: "principal", DGCLAW_PROMPT_HOOKS_DIR: path.join(c.estado, "prompt-hooks") }, c.raiz, "x".repeat(200_000));
  const dt = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(dt < 9500, `levou ${dt} ms (os dois comandos têm de rodar juntos)`);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, "UM\n\nDOIS");
});

test("despachante: neto que segura o pipe e comando que estoura o prazo não prendem o despachante; o que chegou a tempo sai", { skip: pularDespachante }, () => {
  const c = cenario("desp-neto");
  gravarPromptHooksDaSessao({
    pastaDeEstado: c.estado,
    sessaoId: "principal",
    promptHooks: [`echo '{"hookSpecificOutput":{"additionalContext":"A-TEMPO"}}'; sleep 30 &`, "sleep 30; echo NUNCA", "echo B-TEMPO"],
    area: "t",
  });
  const t0 = Date.now();
  const r = rodaDespachante(c, { DGCLAW_SESSAO_ID: "principal", DGCLAW_PROMPT_HOOKS_DIR: path.join(c.estado, "prompt-hooks"), DGCLAW_PROMPT_HOOKS_PRAZO_S: "2" }, c.raiz);
  const dt = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.ok(dt < 5000, `levou ${dt} ms`);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(ctx, "A-TEMPO\n\nB-TEMPO");
  assert.match(r.stderr, /passou do prazo/);
  // o prazo não se alonga por variável
  const lento = rodaDespachante(c, { DGCLAW_SESSAO_ID: "principal", DGCLAW_PROMPT_HOOKS_DIR: path.join(c.estado, "prompt-hooks"), DGCLAW_PROMPT_HOOKS_PRAZO_S: "999" }, c.raiz);
  assert.equal(lento.status, 0);
});

test("falha ao gravar o arquivo de promptHooks: o runner não passa DGCLAW_SESSAO_ID, o comando revogado não roda e o retorno e o log dizem a verdade", async () => {
  const c = cenario("ph-falha");
  const marcador = path.join(c.raiz, "REVOGADO-RODOU");
  // 1) antes: o promptHook existia
  const r1 = instala(c, [`touch ${marcador}`]);
  assert.equal(r1.promptHooksOk, true);
  const arqEstado = path.join(c.estado, "prompt-hooks", "principal.json");
  assert.ok(fs.existsSync(arqEstado));
  // 2) depois: ele foi revogado, mas a gravação falha
  const original = fs.writeFileSync;
  const original2 = fs.renameSync;
  const original3 = fs.rmSync;
  const falha = (n: unknown) => String(n).includes("prompt-hooks");
  (fs as { writeFileSync: unknown }).writeFileSync = ((f: unknown, ...a: unknown[]) => {
    if (falha(f)) throw Object.assign(new Error("EACCES: sem permissão (simulado)"), { code: "EACCES" });
    return (original as (...x: unknown[]) => unknown)(f, ...a);
  }) as never;
  (fs as { renameSync: unknown }).renameSync = ((a: unknown, b: unknown) => {
    if (falha(b)) throw Object.assign(new Error("EACCES (simulado)"), { code: "EACCES" });
    return (original2 as (...x: unknown[]) => unknown)(a, b);
  }) as never;
  // nem a remoção do arquivo velho funciona: o pior caso
  (fs as { rmSync: unknown }).rmSync = ((f: unknown, ...a: unknown[]) => {
    if (falha(f) && String(f).endsWith("principal.json")) throw Object.assign(new Error("EACCES (simulado)"), { code: "EACCES" });
    return (original3 as (...x: unknown[]) => unknown)(f, ...a);
  }) as never;
  let r2;
  try {
    r2 = instala(c, ["echo novo"]);
  } finally {
    (fs as { writeFileSync: unknown }).writeFileSync = original;
    (fs as { renameSync: unknown }).renameSync = original2;
    (fs as { rmSync: unknown }).rmSync = original3;
  }
  assert.equal(r2.promptHooksOk, false, "o retorno não diz que os promptHooks foram instalados");
  assert.match(lerTexto(arqEstado), /REVOGADO-RODOU|touch/, "o arquivo velho ficou (a falha foi total)");
  // o motor Codex, ao ver promptHooksOk=false, não põe a variável
  const ctx = ctxDeTeste({
    escolha: { provedor: "codex", auth: "assinatura", modelo: "" },
    cwd: c.ws,
    pastaDeHooks: pastaTemporaria("ph"),
    pastaDeEstado: c.estado,
    raizDoPlugin: c.plugin,
    env: { CODEX_HOME: c.home, HOME: c.raiz, PATH: c.bin, DGCLAW_WORKSPACE: c.ws, DGCLAW_SESSAO_ID: "herdado-do-ambiente" },
    config: { name: "x", cwd: c.ws, initialPrompt: "", provider: "codex-cli", permissionMode: "bypassPermissions", promptHooks: ["echo novo"] },
  } as never);
  ctx.id = "principal";
  (fs as { writeFileSync: unknown }).writeFileSync = ((f: unknown, ...a: unknown[]) => {
    if (falha(f)) throw Object.assign(new Error("EACCES (simulado)"), { code: "EACCES" });
    return (original as (...x: unknown[]) => unknown)(f, ...a);
  }) as never;
  (fs as { renameSync: unknown }).renameSync = ((a: unknown, b: unknown) => {
    if (falha(b)) throw Object.assign(new Error("EACCES (simulado)"), { code: "EACCES" });
    return (original2 as (...x: unknown[]) => unknown)(a, b);
  }) as never;
  try {
    await motorCodex.preparar(ctx);
  } finally {
    (fs as { writeFileSync: unknown }).writeFileSync = original;
    (fs as { renameSync: unknown }).renameSync = original2;
  }
  assert.equal(ctx.env.DGCLAW_SESSAO_ID, undefined, "sem o arquivo gravado, o runner não passa o id da sessão");
  // com o arquivo velho ainda lá e sem a variável, o despachante real não roda nada
  if (!pularDespachante) {
    fs.writeFileSync(arqEstado, JSON.stringify({ versao: 1, comandos: [`touch ${marcador}`] }));
    const r = rodaDespachante(c, { DGCLAW_SESSAO_ID: "", DGCLAW_PROMPT_HOOKS_DIR: path.join(c.estado, "prompt-hooks") }, c.raiz);
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(marcador), false, "o comando revogado rodou");
  }
});

test("lista de promptHooks vazia apaga o arquivo da sessão (não deixa a lista velha)", () => {
  const c = cenario("ph-vazio");
  instala(c, ["echo a"]);
  const arq = path.join(c.estado, "prompt-hooks", "principal.json");
  assert.ok(fs.existsSync(arq));
  const r = instala(c, []);
  assert.equal(r.promptHooksOk, true);
  assert.equal(fs.existsSync(arq), false);
  assert.equal(instala(c, []).promptHooksOk, true, "apagar o que não existe também é sucesso");
});

// ---------------------------------------------------------------------------------------------
// Trava: concorrência de verdade entre processos e trava ocupada.

import { spawn } from "node:child_process";

test("dois processos instalando ao mesmo tempo no mesmo CODEX_HOME deixam hooks.json e config.toml válidos e coerentes", async () => {
  const c = cenario("concorrencia");
  const modulo = new URL("./provedores/codex-hooks.js", import.meta.url).href;
  const codigo = `
    const m = await import(${JSON.stringify(modulo)});
    const o = JSON.parse(process.env.OPS);
    for (let i = 0; i < 25; i++) {
      const r = m.instalarHooksNoCodex({ ...o, promptHooks: ["echo " + o.sessaoId + "-" + (i % 3)] });
      if (r.instalados !== 5) { console.error("instalou " + r.instalados + " " + (r.motivo ?? "")); process.exit(2); }
    }
  `;
  const filhos = ["principal", "bastidores", "outra"].map(
    (sessaoId) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", codigo], {
          env: { ...process.env, OPS: JSON.stringify({ home: c.home, env: c.env, cwd: c.ws, area: "t", raiz: c.plugin, sessaoId, pastaDeEstado: c.estado, esperaDaTravaMs: 30000, confiancaDaPasta: "/casa/" + sessaoId }) },
        });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, err }));
      }),
  );
  for (const f of await Promise.all(filhos)) assert.equal(f.code, 0, f.err);
  const [hj, toml] = arquivosDoAgente(c);
  const j = JSON.parse(hj);
  assert.equal(Object.values(j.hooks as Record<string, unknown[]>).flat().length, 5);
  assert.equal((toml.match(/\[hooks\.state\./g) ?? []).length, 5, "uma seção de confiança por hook, sem duplicata");
  for (const id of ["principal", "bastidores", "outra"]) assert.equal(toml.split(`[projects."/casa/${id}"]`).length - 1, 1, `a confiança da pasta de ${id} sobreviveu à concorrência`);
  confereToml(toml);
  for (const h of hooksDoAgente({ raiz: c.plugin, workspace: c.ws, temWorkspace: true, temBun: true, pastaDeEstado: c.estado })) assert.ok(toml.includes(hashDoHook(h)));
  assert.equal(fs.existsSync(path.join(c.home, ".dgclaw-hooks.lock")), false);
  for (const id of ["principal", "bastidores", "outra"]) assert.match(JSON.parse(lerTexto(path.join(c.estado, "prompt-hooks", `${id}.json`))).comandos[0], new RegExp(`^echo ${id}-`));
});

test("trava ocupada além do prazo: nada é gravado, o motivo vem no retorno e a trava do outro fica", () => {
  const c = cenario("trava-ocupada");
  const trava = path.join(c.home, ".dgclaw-hooks.lock");
  fs.mkdirSync(trava);
  const r = instala(c, [], "principal", { esperaDaTravaMs: 300 });
  assert.equal(r.instalados, 0);
  assert.match(r.motivo ?? "", /trava ocupada/);
  assert.equal(fs.existsSync(path.join(c.home, "hooks.json")), false);
  assert.equal(fs.existsSync(path.join(c.home, "config.toml")), false);
  assert.equal(fs.existsSync(trava), true, "a trava que não era nossa não é apagada");
});

test("trava abandonada há mais de 30 s é refeita e a instalação segue", () => {
  const c = cenario("trava-velha");
  const trava = path.join(c.home, ".dgclaw-hooks.lock");
  fs.mkdirSync(trava);
  const velho = new Date(Date.now() - 120_000);
  fs.utimesSync(trava, velho, velho);
  const r = instala(c, [], "principal", { esperaDaTravaMs: 2000 });
  assert.equal(r.instalados, 5);
  assert.equal(fs.existsSync(trava), false);
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
    pastaDeEstado: c.estado,
    raizDoPlugin: c.plugin,
    env: { CODEX_HOME: c.home, HOME: c.raiz, PATH: c.bin, DGCLAW_WORKSPACE: c.ws },
    config: { name: "x", cwd: c.ws, initialPrompt: "", provider: "codex-cli", permissionMode: "bypassPermissions", promptHooks: ["node /x/novidades-hook.mjs"] },
  } as never);
  await motorCodex.preparar(ctx);
  assert.equal(ctx.env.DGCLAW_SESSAO_ID, ctx.id, "o runner põe o id da sessão no ambiente do Codex");
  const todos = [...motorCodex.argsNova(ctx), ...motorCodex.argsRetomar(ctx, "id-1")].join("\n");
  assert.equal(/bypass-hook-trust|bypass_hook_trust|hook.?trust/i.test(todos), false, "nenhum argumento liga a confiança geral de hooks");
  assert.equal(/hooks\.state/.test(todos), false, "a confiança vai para o config.toml, não para -c");
  const arqHooks = path.join(c.home, "hooks.json");
  const hj = lerTexto(arqHooks);
  assert.equal(hj.includes("novidades-hook.mjs"), false, "os promptHooks não vão para o hooks.json");
  const estado = JSON.parse(lerTexto(path.join(c.estado, "prompt-hooks", `${ctx.id}.json`)));
  assert.deepEqual(estado.comandos, ["node /x/novidades-hook.mjs"], "os promptHooks da sessão ficam no arquivo de estado dela");
  assert.equal(fs.statSync(path.join(c.estado, "prompt-hooks", `${ctx.id}.json`)).mode & 0o777, 0o600);
  assert.ok(hj.includes("prompt-hooks-sessao.py"), "o hook fixo dos promptHooks está no hooks.json");
  assert.ok(lerTexto(path.join(c.home, "config.toml")).includes(`[projects.${JSON.stringify(c.ws)}]`), "a confiança da pasta vem na mesma transação");
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
  instala(c, ["echo do-dgclaw"]);
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

  // Um hook da PESSOA, acrescentado depois, confiado pelo hash que o próprio Codex calcula: reinstalar
  // (várias vezes) não pode mudar o índice dele nem tirá-lo de `trusted`.
  const hj = lerHooks(c);
  hj.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "echo hook-da-pessoa", timeout: 9 }] });
  fs.writeFileSync(path.join(c.home, "hooks.json"), JSON.stringify(hj, null, 2));
  const dela = listarHooks(c.home, c.ws).find((h) => h.command === "echo hook-da-pessoa");
  assert.ok(dela, "o Codex lista o hook da pessoa");
  assert.notEqual(dela.trustStatus, "trusted");
  fs.appendFileSync(path.join(c.home, "config.toml"), `\n[hooks.state.${JSON.stringify(dela.key)}]\ntrusted_hash = ${JSON.stringify(dela.currentHash)}\n`);
  assert.equal(listarHooks(c.home, c.ws).find((h) => h.command === "echo hook-da-pessoa")?.trustStatus, "trusted");
  instala(c, ["echo do-dgclaw"]);
  instala(c, ["echo outro"]);
  const depois = listarHooks(c.home, c.ws).find((h) => h.command === "echo hook-da-pessoa");
  assert.equal(depois?.key, dela.key, "o índice dela não mudou");
  assert.equal(depois?.trustStatus, "trusted", "e ela continua trusted depois de reinstalar");
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
