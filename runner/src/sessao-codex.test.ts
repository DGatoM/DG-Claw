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
const { acharRolloutPorId } = await import("./provedores/codex-rollout.js");

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
  assert.match(lerTexto(amb.logDoRunner), /o Enter 1\/3 não virou turno em 3000ms; o mesmo texto continua na caixa, batendo na tecla de novo/);
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
  assert.match(log, /AVISO .*ignorei stopHooks, allowTools\/askTools\/denyTools, extraArgs \(são flags do Claude\)/);
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
  // Limpeza de tela seguida de um prompt curto: o menu velho não pode continuar valendo.
  assert.equal(telaDeConfiancaDoCodex(menu + "\x1b[2J\x1b[H› \n"), false, "limpou a tela e redesenhou um prompt curto");
});

// --- login expirado no Codex -----------------------------------------------------------------
const AUTH = () => path.join(amb.codexHome, "auth.json");
/** Põe a data do auth.json `deltaMs` em relação a agora (negativo = login antigo, positivo = login refeito depois). */
const datarAuth = (deltaMs: number) => {
  logarCodex(amb);
  const t = new Date(Date.now() + deltaMs);
  fs.utimesSync(AUTH(), t, t);
};
/** Sobe a sessão, faz um turno e deixa o rollout pronto para receber o erro de fim de turno. */
async function comTurnoFeito(opcoes: Record<string, unknown> = {}) {
  const r = await nova({}, undefined, opcoes);
  await r.s.subir("nova");
  await esperarAte(() => r.s.estado.status === "idle", 6_000);
  await r.s.digitarEEnviar("pergunta");
  await esperarAte(() => r.s.estado.sessionId !== null, 6_000, "o id sair do rollout");
  await esperarAte(() => r.s.estado.status === "idle" && lerTexto(path.join(r.pasta, "runner-state.json")).includes('"idle"'), 14_000, "o turno acabar");
  const arquivo = acharRolloutPorId(r.s.estado.sessionId!, amb.codexHome)!;
  assert.ok(arquivo, "rollout da sessão");
  const erro = (categoria: string, message: string) =>
    fs.appendFileSync(arquivo, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete", error: { message, codex_error_info: categoria } } }) + "\n");
  return { ...r, erro };
}

test("Codex login expirado: task_complete unauthorized depois do auth.json vira errored/login-expirado com a mensagem do ChatGPT", async () => {
  datarAuth(-60_000);
  const { s, erro } = await comTurnoFeito();
  erro("unauthorized", '{"status":401,"detail":"Your refresh token has expired"}');
  await esperarAte(() => s.estado.statusReason === "runner:login-expirado", 6_000, "o login expirado ser detectado no rollout");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.motivo, "login");
  assert.match(s.estado.error ?? "", /conta do ChatGPT de .* expirou às \d\d:\d\d/);
  assert.match(s.estado.error ?? "", /codex login --device-auth/);
  assert.equal(s.recusaDeEntrada()?.tipo, "login-expirado");
  assert.ok(lerTexto(amb.logDoRunner).includes("login expirado detectado por rollout do Codex"));
  await dormir(1_500);
  assert.equal(s.estado.statusReason, "runner:login-expirado", "o Stop do mesmo turno não desfaz o aviso");
});

test("Codex login expirado: credencial ecoada na mensagem do erro não chega ao log", async () => {
  datarAuth(-60_000);
  const { s, erro } = await comTurnoFeito();
  // o segredo atravessa o corte de 160 caracteres: a máscara precisa vir antes do corte
  erro("unauthorized", `${"x".repeat(150)} 401 chave=${OAI}`);
  await esperarAte(() => s.estado.statusReason === "runner:login-expirado", 6_000, "o login expirado ser detectado no rollout");
  const logs = lerTexto(amb.logDoRunner);
  assert.ok(logs.includes("login expirado detectado por rollout do Codex"));
  assert.equal(logs.includes(OAI), false, "a chave do cofre não pode aparecer no log");
  assert.equal(logs.includes(OAI.slice(0, 12)), false, "nem um pedaço dela");
  assert.equal((s.estado.error ?? "").includes(OAI), false);
});

test("Codex login expirado: erro anterior ao auth.json (login refeito depois) NÃO marca", async () => {
  datarAuth(-60_000);
  const { s, erro } = await comTurnoFeito();
  datarAuth(60_000);
  erro("unauthorized", "401");
  await dormir(2_000);
  assert.notEqual(s.estado.statusReason, "runner:login-expirado");
  assert.notEqual(s.estado.status, "errored");
});

test("Codex login expirado: server_overloaded, usage_limit_exceeded e other NÃO marcam", async () => {
  datarAuth(-60_000);
  const { s, erro } = await comTurnoFeito();
  erro("server_overloaded", "Selected model is at capacity");
  erro("usage_limit_exceeded", "You've hit your usage limit");
  erro("other", "alguma falha qualquer");
  await dormir(2_000);
  assert.notEqual(s.estado.statusReason, "runner:login-expirado");
  assert.notEqual(s.estado.status, "errored");
});

test("Codex login expirado: auth.json regravado depois do aviso reinicia RETOMANDO a mesma sessão", async () => {
  datarAuth(-60_000);
  const { s, id, erro } = await comTurnoFeito({ vigiaLoginExpiradoMs: 100 });
  const uuid = s.estado.sessionId!;
  erro("unauthorized", "401 Unauthorized");
  await esperarAte(() => s.estado.statusReason === "runner:login-expirado", 6_000, "o aviso");
  const antes = entradasDe(id).length;
  datarAuth(60_000);
  await esperarAte(() => entradasDe(id).length > antes, 8_000, "o runner reiniciar sozinho");
  const reinicio = entradasDe(id).at(-1)!;
  assert.deepEqual(reinicio.argv.slice(0, 2), ["resume", uuid], "retomou a MESMA conversa");
  await esperarAte(() => s.estado.status === "idle", 8_000, "voltar a idle");
  assert.equal(s.estado.loginExpiradoEm, null);
  assert.equal(s.recusaDeEntrada(), null);
});

// --- pedido digitado sem recibo (incidente de 18/11/2026), no Codex --------------------------------------------

const promptsDe = (texto: string) =>
  lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "codex" && l.modo === "prompt" && l.texto === texto).length;
const filaEmDisco = (s: { arquivoDaFila: string }): Array<Record<string, unknown>> => {
  try {
    return JSON.parse(fs.readFileSync(s.arquivoDaFila, "utf8")).itens;
  } catch {
    return [];
  }
};
const matarOTerminal = (s: { proc: unknown }) => (s.proc as { kill(): void }).kill();

test("Codex sem recibo: o pedido digitado sem task_started fica pendente e, com o terminal morto, fica retido e NUNCA é digitado de novo", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarCodex(amb);
  const { s } = await nova({}, undefined, { reciboVigiaPassosMs: [300, 300] });
  process.env.FAKE_CODEX_IGNORE_ENTERS = "999";
  await s.subir("nova");
  delete process.env.FAKE_CODEX_IGNORE_ENTERS;
  await esperarAte(() => s.estado.status === "idle", 6_000);
  s.enfileirarQuandoOcioso("pedido-codex-que-some-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 40_000, "o aviso de pedido sem recibo");
  assert.equal(promptsDe("pedido-codex-que-some-1"), 0, "o Codex ignorou todos os Enters");
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.digitado]), [["pedido-codex-que-some-1", true]]);

  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable" || s.estado.status === "stopped", 8_000, "o terminal morrer");
  assert.equal(s.semRecibo.length, 0);
  assert.equal(s.filaQuandoIdle.length, 0, "não volta para a fila");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-codex-que-some-1", true]]);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /ficou retido sem confirmação: o terminal (saiu|foi encerrado)/);

  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 10_000);
  await dormir(2_500);
  assert.equal(promptsDe("pedido-codex-que-some-1"), 0, "não foi enviado sozinho");
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-codex-que-some-1", true]]);
});

test("Codex: mesmo com o id da conversa e o rollout sem o pedido, o pedido sem recibo fica retido e não sai sozinho", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarCodex(amb);
  const { s } = await nova({}, undefined, { reciboVigiaPassosMs: [300, 300] });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("primeira-conversa-codex");
  await esperarAte(() => s.estado.sessionId !== null && s.estado.status === "idle", 10_000, "o turno acabar com o id conhecido");
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  process.env.FAKE_CODEX_IGNORE_ENTERS = "999"; // o Codex retomado ignora todos os Enters
  await s.subir("retomar");
  delete process.env.FAKE_CODEX_IGNORE_ENTERS;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("pedido-codex-seguro-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 40_000, "o aviso de pedido sem recibo");
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 10_000);
  await dormir(2_500);
  assert.equal(s.semRecibo.length, 0);
  assert.equal(s.filaQuandoIdle.length, 0);
  assert.equal(promptsDe("pedido-codex-seguro-1"), 0, "o Codex ignorou os Enters e o pedido não foi digitado de novo");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-codex-seguro-1", true]]);
});

test("Codex: a retomada passa ao vigia o rollout já achado, mesmo mais antigo que a janela de busca do vigia", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("conversa-antiga-codex");
  await esperarAte(() => s.estado.sessionId !== null && s.estado.status === "idle", 10_000);
  const uuid = s.estado.sessionId!;
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  // O rollout vai para um dia antigo, atrás de 50 pastas de dias mais novos (a busca do vigia olha só as 45 mais novas).
  const atual = acharRolloutPorId(uuid, amb.codexHome)!;
  const antiga = path.join(amb.codexHome, "sessions", "2020", "01", "01");
  fs.mkdirSync(antiga, { recursive: true });
  fs.renameSync(atual, path.join(antiga, path.basename(atual)));
  for (let d = 1; d <= 50; d++) fs.mkdirSync(path.join(amb.codexHome, "sessions", "2025", "01", String(d).padStart(2, "0")), { recursive: true });
  assert.equal(acharRolloutPorId(uuid, amb.codexHome), null, "a busca padrão do vigia não alcança o rollout");
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const antes = s.promptsAceitos;
  await s.digitarEEnviar("segunda-na-antiga");
  await esperarAte(() => s.promptsAceitos > antes, 10_000, "o vigia ler o rollout antigo e dar o recibo");
});

test("Codex com recibo: o pedido que abriu turno (task_started) não é reentregue depois do terminal morrer e subir de novo", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  s.enfileirarQuandoOcioso("pedido-codex-com-recibo-1");
  await esperarAte(() => promptsDe("pedido-codex-com-recibo-1") === 1, 30_000, "o pedido ser digitado");
  await esperarAte(() => s.semRecibo.length === 0 && filaEmDisco(s).length === 0 && !s.soltandoFila, 10_000, "o recibo limpar o pendente");
  await esperarAte(() => s.estado.sessionId !== null, 6_000);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(s.filaQuandoIdle.length, 0);
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(4_000);
  assert.equal(promptsDe("pedido-codex-com-recibo-1"), 1);
});

test("Codex com recibo atrasado: o task_started que chega depois dos 3 Enters tira o pedido do pendente e não duplica", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarCodex(amb);
  const { s } = await nova({}, undefined, { reciboVigiaPassosMs: [500, 500] });
  process.env.FAKE_CODEX_IGNORE_ENTERS = "3";
  await s.subir("nova");
  delete process.env.FAKE_CODEX_IGNORE_ENTERS;
  await esperarAte(() => s.estado.status === "idle", 6_000);
  s.enfileirarQuandoOcioso("pedido-codex-atrasado-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 40_000, "o aviso de pedido sem recibo");
  await esperarAte(() => /o recibo do texto digitado \(\d+ caracteres\) chegou atrasado/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 10_000, "o recibo atrasado");
  assert.equal(promptsDe("pedido-codex-atrasado-1"), 1);
  await esperarAte(() => s.semRecibo.length === 0 && filaEmDisco(s).length === 0, 8_000);
  await esperarAte(() => s.estado.sessionId !== null, 6_000);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(s.filaQuandoIdle.length, 0, "o pedido não volta para a fila");
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(3_000);
  assert.equal(promptsDe("pedido-codex-atrasado-1"), 1, "nunca duplicado");
});

test("Codex: id sem rollout no disco sobe a sessão NOVA direto (sem 'codex resume' que falha)", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarCodex(amb);
  const { s, id } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  s.parar("reboot simulado");
  const fantasma = "11111111-2222-4333-8444-555555555555";
  s.mudar({ sessionId: fantasma });
  assert.equal(await s.subir("retomar"), "nova");
  assert.equal(s.estado.previousSessionId, fantasma);
  await esperarAte(() => entradasDe(id).length >= 2, 5_000, "o Codex reabrir");
  assert.equal(entradasDe(id)[1].argv[0] === "resume", false, "nem tentou o resume");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), new RegExp(`não retomo a sessão ${fantasma}: o histórico dela não está no disco \\(rollout do Codex`));
});

test("Codex: pasta de sessões que não abre (erro de leitura, não ENOENT) mantém o 'codex resume' em vez de abandonar a conversa", async () => {
  const { inspecionarRolloutPorId } = await import("./provedores/codex-rollout.js");
  const casa = fs.mkdtempSync(path.join(amb.raiz, "codex-ilegivel-"));
  fs.writeFileSync(path.join(casa, "sessions"), "nao e uma pasta"); // readdir dá ENOTDIR: não é ausência comprovada
  const fantasma = "11111111-2222-4333-8444-555555555556";
  assert.equal(inspecionarRolloutPorId(fantasma, casa).estado, "inconclusivo");
  assert.equal(inspecionarRolloutPorId(fantasma, path.join(casa, "outra")).estado, "nao-existe", "ENOENT é ausência comprovada");
});

/** Grava à mão um rollout do Codex desta sessão (a descoberta o acha por cwd e hora) e devolve o caminho. */
function gravarRolloutDeTeste(cwd: string, id: string, comTaskStarted: boolean, textoDoUsuario?: string): string {
  const dia = new Date();
  const dir = path.join(amb.codexHome, "sessions", String(dia.getFullYear()), String(dia.getMonth() + 1).padStart(2, "0"), String(dia.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, `rollout-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${id}.jsonl`);
  const linha = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  fs.writeFileSync(arquivo, linha("session_meta", { id, session_id: id, cwd }) + (comTaskStarted ? linha("event_msg", { type: "task_started" }) : "") + (comTaskStarted && textoDoUsuario !== undefined ? linha("event_msg", { type: "user_message", message: textoDoUsuario, images: [] }) : ""));
  return arquivo;
}
const pedidoPendenteComEnter = (s: InstanceType<typeof Sessao>, texto: string) => {
  const item = { texto, em: 1, id: "cccc" + texto.length, digitado: true };
  const entrada = { item, promptsAntes: s.promptsAceitos, aguardando: true, enterEscrito: true, interrompido: false, entradasNoEnter: s.entradasManuais };
  s.semRecibo.push(entrada as never);
  return entrada;
};

test("rodada 4, item 5: a descoberta do rollout só vincula o arquivo (não dá baixa nem soma recibo); o task_started lido depois confirma o pedido, uma vez só", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const entrada = pedidoPendenteComEnter(s, "pedido-do-primeiro-enter");
  const id = "5b6c7d8e-1111-4222-8333-944455566677";
  const arquivo = gravarRolloutDeTeste(s.estado.config.cwd as string, id, false);
  await esperarAte(() => s.estado.sessionId === id, 6_000, "o vigia descobrir o rollout");
  await dormir(1_500);
  assert.equal(s.promptsAceitos, 0, "descobrir o arquivo não é recibo");
  assert.deepEqual(s.semRecibo, [entrada], "o pedido continua pendente");
  // O task_started do turno chega: é ele o recibo.
  const registro = (payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload }) + "\n";
  fs.appendFileSync(arquivo, registro({ type: "task_started" }) + registro({ type: "user_message", message: "pedido-do-primeiro-enter", images: [] }));
  await esperarAte(() => s.promptsAceitos === 1, 6_000, "o task_started virar recibo");
  assert.equal(s.semRecibo.length, 0, "agora o pedido está confirmado");
  await dormir(1_500);
  assert.equal(s.promptsAceitos, 1, "contado uma vez só");
});

test("rodada 4, item 5: o primeiro task_started que já está no arquivo quando ele é descoberto é lido depois de vincular (recibo uma vez, sem contar em dobro)", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  pedidoPendenteComEnter(s, "pedido-com-task-started-ja-no-arquivo");
  const id = "6c7d8e9f-2222-4333-8444-a55566677788";
  gravarRolloutDeTeste(s.estado.config.cwd as string, id, true, "pedido-com-task-started-ja-no-arquivo");
  await esperarAte(() => s.estado.sessionId === id && s.promptsAceitos >= 1, 6_000, "o recibo vir do arquivo");
  await dormir(1_500);
  assert.equal(s.promptsAceitos, 1, "nem pulou o começo do arquivo, nem contou em dobro");
  assert.equal(s.semRecibo.length, 0);
});

test("rodada 5, item 6: o turno do rollout de OUTRO card (task_started com outro texto) não dá baixa no pedido pendente; só o turno com o texto dele confirma", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const entrada = pedidoPendenteComEnter(s, "pedido-do-primeiro-card  com   espacos");
  // O que o runner escreveu no terminal: o texto do item mais o aviso de atraso (o recibo compara o texto COMPLETO).
  (entrada as { textoEnviado?: string }).textoEnviado = "pedido-do-primeiro-card  com   espacos\n\n[Aviso do sistema: esperou na fila]";
  const { aplicarEvento } = await import("./sessao/eventos.js");
  // O segundo card, no mesmo diretório e no mesmo CODEX_HOME, abre um turno com outra mensagem.
  aplicarEvento(s, { event: "UserPromptSubmit" });
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "mensagem do segundo card" });
  assert.equal(s.promptsAceitos, 1, "o turno aconteceu");
  assert.deepEqual(s.semRecibo, [entrada], "mas o pedido do primeiro card continua pendente");
  const { reciboDoTexto } = await import("./sessao/fila.js");
  assert.equal(reciboDoTexto(s, 0, "pedido-do-primeiro-card com espacos"), false);
  // Um turno cujo texto ainda não chegou também não confirma; o texto certo, sim (comparação normalizada de espaços).
  aplicarEvento(s, { event: "UserPromptSubmit" });
  assert.deepEqual(s.semRecibo, [entrada]);
  // O mesmo começo, sem o aviso que o runner acrescentou: é outro texto, não confirma.
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "pedido-do-primeiro-card com espacos" });
  assert.deepEqual(s.semRecibo, [entrada], "só o começo igual não basta");
  aplicarEvento(s, { event: "UserPromptSubmit" });
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "pedido-do-primeiro-card com espacos\n\n[Aviso do sistema: esperou na fila]" });
  assert.equal(s.semRecibo.length, 0, "agora o pedido está confirmado");
  s.promptsAceitos = 0;
  const { eventoDoRollout } = await import("./provedores/codex-rollout.js");
  const em = "2026-11-24T10:00:00.000Z";
  assert.deepEqual(eventoDoRollout({ timestamp: em, type: "event_msg", payload: { type: "user_message", message: "oi" } }), { evento: "TextoDoUsuario", em: Date.parse(em), texto: "oi" });
  assert.deepEqual(eventoDoRollout({ timestamp: em, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "oi 2" }] } }), { evento: "TextoDoUsuario", em: Date.parse(em), texto: "oi 2" });
  assert.equal(eventoDoRollout({ timestamp: em, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] } }), null);
});

test("rodada 6, item 0: Codex de vários turnos pela fixture (histórico e título na tela depois do primeiro turno): a caixa segue identificada e vazia e o segundo pedido é enviado", async () => {
  logarCodex(amb);
  const { s } = await nova();
  const { caixaIdentificada, caixaVaziaNaTela } = await import("./sessao/telas.js");
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  assert.equal(await s.digitarEEnviar("primeiro pedido do teste"), true);
  await esperarAte(() => s.estado.status === "idle", 6_000, "o primeiro turno terminar");
  await dormir(700);
  const tela = await s.telaAtualSincronizada();
  assert.match(tela, /› primeiro pedido do teste/, "o pedido anterior está no histórico acima da caixa");
  assert.match(tela, /GPT-6\.2-Astra high · \/tmp\/fake-codex · primeiro pedido/, "a linha de status ganhou o título");
  assert.equal(caixaIdentificada(tela), true);
  assert.equal(caixaVaziaNaTela(tela), true);
  assert.equal(await s.digitarEEnviar("segundo pedido do teste"), true, "o segundo envio sai, e não só o primeiro");
  await esperarAte(() => s.promptsAceitos === 2, 6_000, "o segundo task_started");
});

test("rodada 7, item 6: título da sessão com \"Do you want coffee?\" na linha de status do Codex não vira diálogo: caixa identificada e vazia, e o segundo envio sai", async () => {
  logarCodex(amb);
  const { s } = await nova();
  const { caixaIdentificada, caixaVaziaNaTela, haDialogoNaTela } = await import("./sessao/telas.js");
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  assert.equal(await s.digitarEEnviar("Do you want coffee?"), true);
  await esperarAte(() => s.estado.status === "idle", 6_000, "o primeiro turno terminar");
  await dormir(700);
  const tela = await s.telaAtualSincronizada();
  assert.match(tela, /GPT-6\.2-Astra high · \/tmp\/fake-codex · Do you want coffee\?/, "a linha de status ganhou o título com a frase");
  assert.equal(caixaIdentificada(tela), true);
  assert.equal(caixaVaziaNaTela(tela), true);
  assert.equal(haDialogoNaTela(tela), false);
  assert.equal(await s.digitarEEnviar("segundo pedido depois do café"), true, "o segundo envio sai normalmente");
  await esperarAte(() => s.promptsAceitos === 2, 6_000, "o segundo task_started");
});

test("rodada 6, item 7: task_started numa leitura e o texto do usuário só na seguinte (depois do prazo da primeira tentativa): o envio é confirmado", async () => {
  logarCodex(amb);
  const { s, id } = await nova();
  void id;
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const escritas: string[] = [];
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    s.entradasManuais += 1;
    escritas.push(t);
  };
  const { aplicarEvento } = await import("./sessao/eventos.js");
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const antes = s.promptsAceitos;
  const texto = "pedido-com-recibo-em-duas-leituras";
  // A caixa do Codex falso fica vazia (nada chega a ele pelo mock): o Enter 1 é escrito, e depois só se espera.
  setTimeout(() => aplicarEvento(s, { event: "UserPromptSubmit" }), 1_000); // task_started, dentro da 1ª espera (3 s)
  setTimeout(() => aplicarEvento(s, { event: "TextoDoUsuario", texto }), 4_200); // o texto, já dentro da 2ª tentativa
  const confirmado = await enviarComRecibo(s, { texto, comandoDeBarra: false, envio: null, proc: s.proc! });
  (s as unknown as { escrever: unknown }).escrever = original;
  assert.equal(confirmado, true, "o contador de referência é o do primeiro Enter, e não o de cada tentativa");
  assert.equal(s.promptsAceitos, antes + 1);
  assert.equal(escritas.filter((e) => e === "\r").length, 1, "um só Enter");
});

test("rodada 8, item 7: o registro de compactação do rollout do Codex é o recibo do /compact; o recado atrás dele sai logo, e o /compact não fica retido como incerto", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const { eventoDoRollout } = await import("./provedores/codex-rollout.js");
  const em = "2026-11-24T10:00:00.000Z";
  assert.deepEqual(eventoDoRollout({ timestamp: em, type: "compacted", payload: { message: "", replacement_history: [] } }), { evento: "Compactado", em: Date.parse(em) });
  assert.deepEqual(eventoDoRollout({ timestamp: em, type: "event_msg", payload: { type: "context_compacted" } }), { evento: "Compactado", em: Date.parse(em) });
  const inicio = Date.now();
  s.enfileirarQuandoOcioso("/compact");
  s.enfileirarQuandoOcioso("recado-depois-do-compact");
  await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.bin === "codex" && l.texto === "recado-depois-do-compact"), 7_000, "o recado sair logo depois da compactação");
  assert.ok(Date.now() - inicio < 8_000, "sem esperar a vigia (os 3 Enters sem recibo levam 9 s)");
  assert.equal(s.retidos.length, 0, "o /compact não ficou como incerto");
  assert.equal(s.barraPendente, null);
  assert.equal(s.compactsIniciados >= 1, true);
});

test("rodada 9, item 1: TextoDoUsuario e Compactado pela rota de hook (com nonce válido) são recusados e não confirmam nada", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const entrada = pedidoPendenteComEnter(s, "pedido-que-ninguem-recebeu");
  const { aplicarEvento } = await import("./sessao/eventos.js");
  aplicarEvento(s, { event: "UserPromptSubmit" }); // um turno aberto (por outro caminho), ainda sem o texto
  const compactsAntes = s.compactsIniciados;
  const base = { agentId: s.descritor.id, nonce: s.nonce as string };
  const r1 = s.receberHook({ ...base, event: "TextoDoUsuario", texto: "pedido-que-ninguem-recebeu" });
  assert.equal(r1.ok, false);
  assert.match(r1.motivo ?? "", /TextoDoUsuario.*rollout/);
  const r2 = s.receberHook({ ...base, event: "Compactado" });
  assert.equal(r2.ok, false);
  assert.match(r2.motivo ?? "", /Compactado.*rollout/);
  assert.deepEqual(s.semRecibo, [entrada], "o pedido continua pendente");
  assert.equal(s.compactsIniciados, compactsAntes, "nenhuma compactação contada");
  // O caminho interno (o leitor do rollout) segue valendo.
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "pedido-que-ninguem-recebeu" });
  assert.equal(s.semRecibo.length, 0, "pelo caminho interno confirma");
});

test("rodada 9, item 6: rollout recém-descoberto com mais de 1 MiB de saída antes da descoberta é lido desde o início: o pedido é confirmado", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const entrada = pedidoPendenteComEnter(s, "pedido-no-comeco-do-rollout-grande");
  const id = "7d8e9fa0-3333-4444-8555-b66677788899";
  const arquivo = gravarRolloutDeTeste(s.estado.config.cwd as string, id, true, "pedido-no-comeco-do-rollout-grande");
  const registro = (payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload }) + "\n";
  // Mais de 1,5 MiB de saída do primeiro turno gravada antes de o vigia olhar o arquivo.
  const enchimento = registro({ type: "agent_message", message: "x".repeat(1_000) }).repeat(1_600);
  assert.ok(enchimento.length > 1.5 * 1024 * 1024);
  fs.appendFileSync(arquivo, enchimento);
  await esperarAte(() => s.estado.sessionId === id && s.promptsAceitos >= 1, 10_000, "o task_started do começo do arquivo ser lido");
  await esperarAte(() => s.semRecibo.length === 0, 6_000, "o texto do usuário do começo confirmar o pedido");
  assert.equal(s.promptsAceitos, 1);
  assert.equal(s.semRecibo.includes(entrada as never), false);
});

test("revisão: num Codex a rota de hook só aceita o Stop do notify; PreCompact é recusado e não conta compactação", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const base = { agentId: s.descritor.id, nonce: s.nonce as string };
  const antes = s.compactsIniciados;
  const r = s.receberHook({ ...base, event: "PreCompact" });
  assert.equal(r.ok, false);
  assert.match(r.motivo ?? "", /Codex.*Stop/);
  assert.equal(s.compactsIniciados, antes, "o PreCompact forjado não dá baixa no /compact");
  assert.equal(s.receberHook({ ...base, event: "Stop" }).ok, true, "o Stop do notify continua aceito");
});

test("revisão: o texto repetido no turno não se duplica e passar de 1 MiB descarta os turnos mais antigos, mantendo o recibo do mais recente", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const { aplicarEvento, TETO_BYTES_TEXTOS_DO_CODEX } = await import("./sessao/eventos.js");
  const { reciboDoTexto } = await import("./sessao/fila.js");
  // user_message e response_item trazem o mesmo texto: fica uma cópia só, também com espaços diferentes.
  aplicarEvento(s, { event: "UserPromptSubmit" });
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "mesmo texto" });
  aplicarEvento(s, { event: "TextoDoUsuario", texto: "mesmo   texto\n" });
  assert.deepEqual(s.turnosDoCodex[s.turnosDoCodex.length - 1].textos, ["mesmo texto"]);
  // Turnos grandes: a soma passa de 1 MiB e os mais antigos saem primeiro.
  const metade = "a".repeat(Math.floor(TETO_BYTES_TEXTOS_DO_CODEX / 2) - 10);
  for (let i = 0; i < 4; i++) {
    aplicarEvento(s, { event: "UserPromptSubmit" });
    aplicarEvento(s, { event: "TextoDoUsuario", texto: `${metade} turno-${i}` });
  }
  const total = s.turnosDoCodex.reduce((a, t) => a + t.textos.reduce((b, x) => b + Buffer.byteLength(x), 0), 0) + s.textosSoltosDoCodex.reduce((b, x) => b + Buffer.byteLength(x), 0);
  assert.ok(total <= TETO_BYTES_TEXTOS_DO_CODEX, `a soma (${total}) cabe no teto`);
  assert.equal(s.turnosDoCodex.some((t) => t.textos.some((x) => x.endsWith("turno-0"))), false, "o mais antigo saiu");
  const n = s.promptsAceitos;
  assert.equal(reciboDoTexto(s, n - 1, `${metade} turno-3`), true, "o recibo do mais recente continua valendo");
  // Textos soltos (antes do primeiro task_started) também entram no teto.
  s.turnosDoCodex.length = 0;
  s.textosSoltosDoCodex.length = 0;
  for (let i = 0; i < 4; i++) aplicarEvento(s, { event: "TextoDoUsuario", texto: `${metade} solto-${i}` });
  assert.ok(s.textosSoltosDoCodex.reduce((b, x) => b + Buffer.byteLength(x), 0) <= TETO_BYTES_TEXTOS_DO_CODEX);
  assert.equal(s.textosSoltosDoCodex[s.textosSoltosDoCodex.length - 1].endsWith("solto-3"), true);
});

/** Grava de uma vez só (por rename) um rollout grande, com o task_started e o texto do usuário no COMEÇO e mais de 1,5 MiB depois. */
function gravarRolloutGrandeDeUmaVez(cwd: string, id: string, textoDoUsuario: string, emDoComeco: Date, metaEm = new Date()): string {
  const dia = new Date();
  const dir = path.join(amb.codexHome, "sessions", String(dia.getFullYear()), String(dia.getMonth() + 1).padStart(2, "0"), String(dia.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, `rollout-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${id}.jsonl`);
  const linha = (type: string, payload: unknown, em = new Date()) => JSON.stringify({ timestamp: em.toISOString(), type, payload }) + "\n";
  const enchimento = linha("event_msg", { type: "agent_message", message: "x".repeat(1_000) }).repeat(1_600);
  const conteudo = linha("session_meta", { id, session_id: id, cwd }, metaEm) + linha("event_msg", { type: "task_started" }, emDoComeco) + linha("event_msg", { type: "user_message", message: textoDoUsuario, images: [] }, emDoComeco) + enchimento;
  assert.ok(conteudo.length > 1.5 * 1024 * 1024);
  const temporario = path.join(amb.codexHome, `grande-${id}.tmp`);
  fs.writeFileSync(temporario, conteudo);
  fs.renameSync(temporario, arquivo);
  return arquivo;
}

test("correção D: sessão NOVA com o id chegando primeiro (Stop do notify) lê o rollout grande desde o início e confirma o pedido", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  assert.equal(s.modoDoUltimoSpawn, "nova");
  const entrada = pedidoPendenteComEnter(s, "pedido-no-comeco-do-rollout-novo");
  const id = "8e9fa0b1-4444-4555-8666-c77788899900";
  s.mudar({ sessionId: id }); // o id chega pelo Stop do notify ANTES de qualquer varredura achar o rollout
  gravarRolloutGrandeDeUmaVez(s.estado.config.cwd as string, id, "pedido-no-comeco-do-rollout-novo", new Date());
  await esperarAte(() => s.promptsAceitos >= 1, 10_000, "o task_started do começo do arquivo ser lido");
  await esperarAte(() => s.semRecibo.length === 0, 6_000, "o texto do usuário do começo confirmar o pedido");
  assert.equal(s.semRecibo.includes(entrada as never), false);
});

test("correção D: RETOMADA de conversa existente continua lendo o rollout grande só pela cauda (o começo não é lido)", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000);
  await s.digitarEEnviar("conversa-que-sera-retomada");
  await esperarAte(() => s.estado.sessionId !== null && s.estado.status === "idle", 10_000);
  const uuid = s.estado.sessionId!;
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  // Um task_started com data do futuro (passa do filtro de "depois do spawn") no COMEÇO de um rollout com mais de 1,5 MiB.
  const atual = acharRolloutPorId(uuid, amb.codexHome)!;
  const antigo = fs.readFileSync(atual, "utf8");
  const linha = (type: string, payload: unknown, em: Date) => JSON.stringify({ timestamp: em.toISOString(), type, payload }) + "\n";
  const futuro = new Date(Date.now() + 600_000);
  const primeiraQuebra = antigo.indexOf("\n") + 1;
  const enchimento = linha("event_msg", { type: "agent_message", message: "x".repeat(1_000) }, new Date(0)).repeat(1_600);
  fs.writeFileSync(atual, antigo.slice(0, primeiraQuebra) + linha("event_msg", { type: "task_started" }, futuro) + antigo.slice(primeiraQuebra) + enchimento);
  const antes = s.promptsAceitos;
  await s.subir("retomar");
  assert.equal(s.modoDoUltimoSpawn, "retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(2_000);
  assert.equal(s.promptsAceitos, antes, "o task_started do começo ficou fora da leitura pela cauda");
});

test("correção D: sessão NOVA cujo Stop traz o id de uma conversa ANTIGA (/resume no TUI) lê esse rollout só pela cauda", async () => {
  logarCodex(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 6_000, "a tela quieta virar idle");
  const entrada = pedidoPendenteComEnter(s, "pedido-que-so-a-conversa-antiga-tem");
  const id = "9f0ab1c2-5555-4666-8777-d88899900011";
  s.mudar({ sessionId: id });
  // A conversa começou uma hora antes do spawn: não é o rollout novo deste spawn, então o começo dela não é relido.
  gravarRolloutGrandeDeUmaVez(s.estado.config.cwd as string, id, "pedido-que-so-a-conversa-antiga-tem", new Date(), new Date(Date.now() - 3_600_000));
  await dormir(3_000);
  assert.equal(s.promptsAceitos, 0, "o task_started do começo da conversa antiga ficou fora da leitura");
  assert.equal(s.semRecibo.includes(entrada as never), true);
});
