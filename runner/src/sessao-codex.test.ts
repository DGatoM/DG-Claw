import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  abrirServidorDeHooks, chaveFalsa, chaveFalsaOpenai, dormir, esperarAte, lerLinhasJson, lerTexto, logarClaude, logarCodex, prepararAmbiente,
} from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-codex");
const { Sessao, telaDeConfiancaDoCodex } = await import("./sessao.js");
const { gravarProvedorJson } = await import("./provedores/escolha.js");

const OAI = chaveFalsaOpenai();
const ANT = chaveFalsa();
fs.writeFileSync(path.join(amb.raiz, "cofre.env"), `OPENAI_API_KEY='${OAI}'\n`);
process.env.DGCLAW_COFRE_ARQUIVO = path.join(amb.raiz, "cofre.env");
process.env.OPENAI_API_KEY = OAI;
process.env.ANTHROPIC_API_KEY = ANT;

let n = 0;
const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

async function nova(config: Record<string, unknown> = {}, escolha: Record<string, string> = { provedor: "codex", auth: "assinatura", modelo: "" }, opcoes: Record<string, unknown> = {}) {
  n += 1;
  const id = `cdx-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  gravarProvedorJson(path.join(pasta, "provedor.json"), escolha as never);
  // Uma casa por sessão: o Codex descobre o id do rollout por cwd, e testes que dividem a casa se confundiriam.
  const cwd = (config.cwd as string | undefined) ?? path.join(amb.raiz, `casa-${n}`);
  fs.mkdirSync(cwd, { recursive: true });
  const cfg = { name: id, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions", ...config, cwd };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
    ...opcoes,
  } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  return { s, pasta, hooks, id };
}
/** As entradas do Codex falso desta sessão: o handler de notify leva o id da sessão no argv. */
const entradasDe = (id: string) =>
  lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "codex" && l.modo === "interativo" && l.argv.some((a: string) => a.includes(`"--agent","${id}"`)));

test("Codex: sobe com o bypass como argumento, descobre o id no rollout e conta o turno pelo rollout", async () => {
  logarCodex(amb);
  const { s, id, hooks } = await nova();
  assert.equal(await s.subir("nova"), "nova");
  assert.equal(s.estado.sessionId, null, "o id do Codex não é pré-fixado");
  await esperarAte(() => entradasDe(id).length > 0, 5_000, "o Codex abrir");
  const e = entradasDe(id)[0];
  assert.equal(e.argv[0], "--dangerously-bypass-approvals-and-sandbox");
  assert.equal(e.argv.includes("--settings"), false, "o Codex não recebe --settings");
  assert.equal(e.argv.includes("--session-id"), false);
  assert.equal(e.valores.CODEX_HOME, amb.codexHome);
  assert.equal(e.env.includes("IS_SANDBOX"), false, "o Codex aceita o bypass como root sem IS_SANDBOX");
  assert.equal(e.env.includes("OPENAI_API_KEY"), false, "na assinatura do Codex a OPENAI_API_KEY sai (limpar do modo)");
  assert.equal(e.env.includes("ANTHROPIC_API_KEY"), false, "herdada, fora do cofre");
  assert.equal(e.valores.TELEGRAM_STATE_DIR, path.join(amb.raiz, `casa-${id.split("-")[1]}`, ".dgclaw", "telegram-desligado"));

  // Sem SessionStart: a tela quieta por 1,5 s é o "pronto".
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  assert.match(s.estado.statusReason!, /pty:quieto 1500ms \(sem hooks\)/);

  await s.digitarEEnviar("primeira pergunta");
  await esperarAte(() => s.estado.sessionId !== null, 6_000, "o id sair do rollout");
  await esperarAte(() => s.estado.status === "working", 6_000, "task_started virar working");
  assert.match(s.estado.sessionId!, /^[0-9a-f]{8}-/);
  const estado = JSON.parse(fs.readFileSync(path.join(path.dirname(path.join(amb.estado, id, "x")), "runner-state.json"), "utf8"));
  assert.equal(estado.sessionId, s.estado.sessionId, "o id descoberto é gravado");
  assert.deepEqual(estado.escolha, { provedor: "codex", auth: "assinatura", modelo: "" });
  // notify do Codex: o handler gerado POSTou o Stop com o thread-id e o nonce do spawn.
  await esperarAte(() => hooks.recebidos.some((h) => h.event === "Stop" && h.sessionId === s.estado.sessionId), 8_000, "o notify chegar");
  assert.equal(hooks.recebidos.find((h) => h.event === "Stop")!.resultado.ok, true);
  // task_complete -> Stop -> idle depois da janela quieta.
  await esperarAte(() => s.estado.status === "idle", 12_000, "o Stop virar idle");
  assert.equal(lerTexto(amb.logDoRunner).includes(OAI), false);
});

test("Codex: o Enter sem recibo é repetido (o primeiro foi tratado como colagem)", async () => {
  logarCodex(amb);
  const { s, id } = await nova();
  process.env.FAKE_CODEX_IGNORE_ENTERS = "1";
  test.after(() => void delete process.env.FAKE_CODEX_IGNORE_ENTERS);
  await s.subir("nova");
  delete process.env.FAKE_CODEX_IGNORE_ENTERS;
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("texto que precisa de dois Enters");
  await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.bin === "codex" && l.texto === "texto que precisa de dois Enters"), 4_000, "o prompt entrar");
  assert.match(lerTexto(amb.logDoRunner), /o Enter 1\/3 não virou turno em 3000ms; batendo na tecla de novo/);
  assert.ok(entradasDe(id).length >= 1);
});

test("Codex: retomar usa 'codex resume <uuid>' e continua lendo o mesmo rollout", async () => {
  logarCodex(amb);
  const { s, id } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("pergunta antes do reinício");
  await esperarAte(() => s.estado.sessionId !== null, 6_000);
  await esperarAte(() => s.estado.status === "idle" && lerTexto(path.join(amb.estado, id, "runner-state.json")).includes('"idle"'), 14_000, "o turno acabar");
  const uuid = s.estado.sessionId!;
  s.parar("reinício");
  assert.equal(s.estado.status, "resumable");

  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => entradasDe(id).length >= 2, 5_000, "o Codex reabrir");
  const e = entradasDe(id)[1];
  assert.deepEqual(e.argv.slice(0, 3), ["resume", uuid, "--dangerously-bypass-approvals-and-sandbox"]);
  assert.equal(s.estado.sessionId, uuid);
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("pergunta depois do reinício");
  await esperarAte(() => s.estado.status === "working", 6_000, "o rollout antigo continuar valendo");
});

test("trocar de Claude para Codex no boot abre conversa NOVA e guarda a antiga; mesmo provedor e outro modelo retoma", async () => {
  logarClaude(amb);
  logarCodex(amb);
  // 1) a sessão rodava no Claude (escolha gravada) e agora o provedor.json diz Codex
  const { s, pasta, id } = await nova({}, { provedor: "claude", auth: "assinatura", modelo: "" });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "spawning" || s.estado.status === "idle", 5_000);
  const idDoClaude = s.estado.sessionId!;
  assert.match(idDoClaude, /^[0-9a-f]{8}-/);
  s.parar("reboot simulado");

  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "codex", auth: "assinatura", modelo: "" });
  assert.equal(await s.subir("retomar"), "nova");
  assert.equal(s.estado.sessionId, null, "o id do Claude não serve ao Codex");
  assert.equal(s.estado.previousSessionId, idDoClaude);
  await esperarAte(() => entradasDe(id).length >= 1, 5_000, "o Codex abrir");
  assert.equal(entradasDe(id)[0].argv.includes("resume"), false);
  s.parar("reboot simulado 2");

  // 2) mesmo provedor, outro modelo: o estado já tem a escolha do Codex gravada
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("conversa do codex");
  await esperarAte(() => s.estado.sessionId !== null, 6_000);
  const uuid = s.estado.sessionId!;
  s.parar("reboot simulado 3");
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "codex", auth: "assinatura", modelo: "gpt-5.5" });
  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => entradasDe(id).length >= 3, 5_000);
  const e = entradasDe(id)[2];
  assert.deepEqual(e.argv.slice(0, 2), ["resume", uuid]);
  assert.equal(e.argv[e.argv.indexOf("-m") + 1], "gpt-5.5");
});

test("identidade grande demais: errored com motivo, sem abrir o Codex", async () => {
  logarCodex(amb);
  fs.writeFileSync(path.join(amb.casa, "persona-gigante.md"), "x".repeat(130_000));
  const { s, id } = await nova({ cwd: amb.casa }, { provedor: "codex", auth: "assinatura", modelo: "" }, { identidade: ["persona-gigante.md"] });
  await s.subir("nova");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:identidade-grande");
  assert.match(s.estado.error!, /128 KB/);
  assert.equal(s.temPtyVivo(), false);
  await dormir(300);
  assert.equal(entradasDe(id).length, 0);
});

test("identidade pequena vai em developer_instructions; a do descritor (identidadeArquivo) vale só para a principal", async () => {
  logarCodex(amb);
  fs.writeFileSync(path.join(amb.casa, "persona-principal.md"), "Você é a Ana.\nSeja gentil.");
  const principal = await nova({ identidadeArquivo: "persona-principal.md", cwd: amb.casa });
  await principal.s.subir("nova");
  await esperarAte(() => entradasDe(principal.id).length > 0, 5_000);
  assert.ok(entradasDe(principal.id)[0].argv.includes(`developer_instructions=${JSON.stringify("Você é a Ana.\nSeja gentil.")}`));

  const paralela = await nova({ identidadeArquivo: "persona-principal.md", cwd: amb.casa }, undefined, { papel: "paralela", tipo: "card", chat: "c_x" });
  await paralela.s.subir("nova");
  await esperarAte(() => entradasDe(paralela.id).length > 0, 5_000);
  assert.equal(entradasDe(paralela.id)[0].argv.some((a: string) => a.startsWith("developer_instructions=")), false);
});

test("MCP no Codex: wrapper por spawn, com os arquivos apagados quando o PTY sai", async () => {
  logarCodex(amb);
  const mcp = JSON.stringify({ mcpServers: { dgchat: { command: "/bin/true", args: ["a b"], env: { SEGREDO_DO_MCP: "valor-secreto-123" } } } });
  const { s, id, pasta } = await nova({ mcpConfig: mcp });
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length > 0, 5_000);
  const argv: string[] = entradasDe(id)[0].argv;
  assert.equal(JSON.stringify(argv).includes("valor-secreto-123"), false);
  const sh = JSON.parse(argv.find((a) => a.startsWith("mcp_servers.dgchat.command="))!.slice("mcp_servers.dgchat.command=".length));
  assert.ok(sh.startsWith(path.join(pasta, "runner-hooks", `mcp-${id}`)));
  assert.ok(fs.existsSync(sh));
  s.parar("fim");
  await esperarAte(() => !fs.existsSync(sh), 4_000, "o wrapper ser apagado quando o PTY sai");
  assert.equal(lerTexto(amb.logDoRunner).includes("valor-secreto-123"), false);
});

test("Codex na API: registra a chave pelo stdin, mantém a OPENAI_API_KEY no ambiente e usa o CODEX_HOME da sessão", async () => {
  const { s, id } = await nova({}, { provedor: "codex", auth: "api", modelo: "" });
  const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "login-api-key").length;
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length > 0, 8_000, "o Codex abrir");
  const logins = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "login-api-key");
  assert.equal(logins.length, antes + 1);
  assert.equal(JSON.stringify(logins.at(-1)).includes(OAI.slice(0, 20)), false);
  const e = entradasDe(id)[0];
  assert.equal(e.valores.CODEX_HOME, path.join(amb.raiz, `casa-${id.split("-")[1]}`, ".plataforma", "codex-api", id));
  assert.equal(e.env.includes("OPENAI_API_KEY"), true, "a chave veio do cofre e fica para as ferramentas do agente");
  assert.equal(lerTexto(amb.logDoRunner).includes(OAI), false);
  assert.equal(lerTexto(amb.logDoRunner).includes(OAI.slice(0, 12)), false, "nem a saída do codex login");
});

test("Codex na API sem a chave: errored runner:sem-chave, e não cai na assinatura que está logada", async () => {
  logarCodex(amb);
  const guardada = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  test.after(() => void (process.env.OPENAI_API_KEY = guardada));
  const { s, id } = await nova({}, { provedor: "codex", auth: "api", modelo: "" });
  await s.subir("nova");
  assert.equal(s.estado.statusReason, "runner:sem-chave");
  assert.match(s.estado.error!, /OPENAI_API_KEY não está no ambiente/);
  await dormir(300);
  assert.equal(entradasDe(id).length, 0);
});

test("recursos só do Claude numa sessão Codex: um aviso por spawn dizendo o que foi ignorado", async () => {
  logarCodex(amb);
  const { s } = await nova({ stopHooks: ["python3 /x/stop.py"], promptHooks: ["echo oi"], allowTools: ["mcp__dgchat"], extraArgs: ["--verbose"] });
  await s.subir("nova");
  const log = lerTexto(amb.logDoRunner);
  assert.match(log, /AVISO .*ignorei stopHooks, promptHooks, allowTools\/askTools\/denyTools, extraArgs \(são flags do Claude\)/);
});

test("Codex com o canal Telegram ligado: aviso de que o oficial só existe no Claude, e nada quebra", async () => {
  logarCodex(amb);
  const estadoTg = path.join(amb.casa, ".dgclaw", "telegram");
  fs.mkdirSync(estadoTg, { recursive: true });
  fs.writeFileSync(path.join(amb.casa, ".dgclaw", "canais.json"), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: estadoTg } }));
  test.after(() => fs.rmSync(path.join(amb.casa, ".dgclaw", "canais.json"), { force: true }));
  const { s, id } = await nova({ cwd: amb.casa });
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length > 0, 5_000);
  assert.match(lerTexto(amb.logDoRunner), /o Telegram oficial só existe no Claude/);
  assert.equal(entradasDe(id)[0].argv.includes("--channels"), false);
  assert.equal(entradasDe(id)[0].valores.TELEGRAM_STATE_DIR, path.join(amb.casa, ".dgclaw", "telegram-desligado"));
});

test("Codex: a tela 'Trust this folder?' é respondida com 1 + Enter antes de digitar, e o texto só entra depois", async () => {
  const { s } = await nova();
  const escritos: string[] = [];
  const priv = s as unknown as { proc: unknown; guardarEEmitir(t: string): void };
  priv.proc = {
    write(t: string) {
      escritos.push(t);
      if (t === "\r") setTimeout(() => priv.guardarEEmitir("\x1b[2J› Ask Codex anything"), 20);
    },
  };
  priv.guardarEEmitir("\x1b[1mTrust this folder?\x1b[0m\n  › 1. Trust and continue\n    2. Quit\n");
  await s.vencerTelaDeConfianca();
  assert.deepEqual(escritos, ["1", "\r"]);
  assert.match(lerTexto(amb.logDoRunner), /Trust this folder\?/);
  // sem o menu na tela, não faz nada
  escritos.length = 0;
  priv.guardarEEmitir("\n".repeat(60) + "› Ask Codex anything");
  await s.vencerTelaDeConfianca();
  assert.deepEqual(escritos, []);
  priv.proc = null;
});

test("Codex: se o menu de confiança não sai, o texto NÃO é digitado e o erro explica", async () => {
  const { s } = await nova();
  const escritos: string[] = [];
  const priv = s as unknown as { proc: unknown; guardarEEmitir(t: string): void };
  priv.proc = { write: (t: string) => void escritos.push(t) };
  priv.guardarEEmitir("Trust this folder?\n › 1. Trust and continue\n  2. Quit\n");
  await assert.rejects(s.digitarEEnviar("2026-10-12 oi"), /Trust this folder/);
  assert.deepEqual(escritos, ["1", "\r"], "o texto do dono nunca foi digitado");
  priv.proc = null;
});

test("Codex: codexHome na visão da sessão é o do spawn (api: pasta por sessão); Claude e antes do spawn é null", async () => {
  const api = await nova({}, { provedor: "codex", auth: "api", modelo: "" });
  assert.equal(api.s.codexHome(), null, "antes do primeiro spawn");
  await api.s.subir("nova");
  assert.equal(api.s.codexHome(), path.join((api.s as unknown as { descritor: { config: { cwd: string } } }).descritor.config.cwd, ".plataforma", "codex-api", api.id));
  const claude = await nova({}, { provedor: "claude", auth: "assinatura", modelo: "" });
  logarClaude(amb);
  await claude.s.subir("nova");
  assert.equal(claude.s.codexHome(), null);
});

test("tela de confiança: só conta se o menu for a última coisa desenhada", () => {
  // A tela real do B6 (12/10/2026), como o Codex 0.162.1 a desenha.
  const menu = "Trust this folder?\n Codex can read, edit, and run files here.\n › 1. Trust and continue\n   2. Quit\n enter continue · esc quit\n";
  assert.equal(telaDeConfiancaDoCodex(menu), true);
  // Menu já respondido: o texto velho fica no buffer, mas depois dele vêm o rodapé e o prompt.
  const respondido = menu + "\x1b[2J\x1b[H permissions: YOLO mode\n GPT-6.1-Sol default · ~\n › Ask Codex to do anything\n ? for shortcuts\n";
  assert.equal(telaDeConfiancaDoCodex(respondido), false, "um menu respondido não pode virar um '1' a cada mensagem");
  assert.equal(telaDeConfiancaDoCodex(" › Ask Codex to do anything\n"), false);
});
