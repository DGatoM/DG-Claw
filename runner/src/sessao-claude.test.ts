import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dormir, abrirServidorDeHooks, chaveFalsa, chaveFalsaOpenai, esperarAte, lerLinhasJson, lerTexto, logarClaude, prepararAmbiente,
} from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-claude");
const { Sessao, nonceConfere } = await import("./sessao.js");
const { gravarProvedorJson } = await import("./provedores/escolha.js");

const OAI = chaveFalsaOpenai();
const ANT = chaveFalsa();
fs.writeFileSync(path.join(amb.raiz, "cofre.env"), `OPENAI_API_KEY='${OAI}'\nTELEGRAM_BOT_TOKEN='123:telegram-falso'\n`);
process.env.DGCLAW_COFRE_ARQUIVO = path.join(amb.raiz, "cofre.env");
process.env.OPENAI_API_KEY = OAI;
process.env.TELEGRAM_BOT_TOKEN = "123:telegram-falso";
process.env.ANTHROPIC_API_KEY = ANT;

let n = 0;
async function nova(config: Record<string, unknown> = {}, opcoes: Record<string, unknown> = {}) {
  n += 1;
  const id = (opcoes.idFixo as string | undefined) ?? `sess-${n}`;
  delete opcoes.idFixo;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const cfg = { name: id, cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions", ...config };
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
/** As entradas do Claude falso que pertencem a ESTA sessão (o settings de cada uma tem o id no nome). */
const entradasDe = (id: string) =>
  lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude" && l.modo === "interativo" && l.argv.some((a: string) => a.endsWith(`/${id}.settings.json`)));

const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

test("Claude na assinatura: argv, ambiente por modo, canal desligado e nada gravado ao lado do descritor", async () => {
  logarClaude(amb);
  const { s, pasta, id } = await nova();
  assert.equal(await s.subir("nova"), "nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
  const e = entradasDe(id)[0];
  assert.deepEqual(e.argv.slice(0, 1), ["--session-id"]);
  assert.equal(e.argv[1], s.estado.sessionId);
  assert.deepEqual(e.argv.slice(2, 4), ["--permission-mode", "bypassPermissions"]);
  assert.equal(e.argv[4], "--settings");
  assert.equal(e.argv.includes("--model"), false, "modelo vazio não passa --model");
  assert.equal(e.argv.includes("--channels"), false);
  // Ambiente: a chave da Anthropic (herdada e de outro modo) sai; a da OpenAI vem do cofre e passa.
  assert.equal(e.env.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(e.env.includes("OPENAI_API_KEY"), true);
  assert.equal(e.valores.IS_SANDBOX, "1");
  // O plugin do Telegram faria polling sozinho: o token sai e o estado aponta para a pasta vazia.
  assert.equal(e.env.includes("TELEGRAM_BOT_TOKEN"), false);
  assert.equal(e.valores.TELEGRAM_STATE_DIR, path.join(amb.casa, ".dgclaw", "telegram-desligado"));
  // A pasta de estado recebe tudo; o descritor continua sozinho na pasta dele.
  assert.deepEqual(fs.readdirSync(path.dirname(amb.descritor)), ["runner.json"]);
  assert.ok(fs.existsSync(path.join(pasta, "runner-hooks", "runner-hook.mjs")));
  assert.ok(fs.existsSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`)));
  const estado = JSON.parse(fs.readFileSync(path.join(pasta, "runner-state.json"), "utf8"));
  assert.deepEqual(estado.escolha, { provedor: "claude", auth: "assinatura", modelo: "" });
  // A chave da OpenAI do cofre existe no ambiente do CLI, mas nunca no argv nem no log.
  assert.equal(JSON.stringify(e.argv).includes(OAI), false);
  assert.equal(lerTexto(amb.logDoRunner).includes(OAI), false);
  assert.equal(lerTexto(amb.logDoRunner).includes(ANT), false);
});

test("hook de status: o nonce é de 64 hex, vem do settings, compara em tempo constante e nunca vai para o log", async () => {
  logarClaude(amb);
  const { s, pasta, hooks } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const settings = JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`), "utf8"));
  const comando: string = settings.hooks.Stop[0].hooks[0].command;
  const nonce = comando.match(/--nonce ([0-9a-f]+)/)![1];
  assert.match(nonce, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`)).mode & 0o777, 0o600);
  assert.deepEqual(s.receberHook({ agentId: s.id, event: "Stop", nonce: nonce.slice(0, 63) }), { ok: false, motivo: "nonce de um spawn antigo" });
  assert.deepEqual(s.receberHook({ agentId: s.id, event: "Stop", nonce: nonce + "0" }), { ok: false, motivo: "nonce de um spawn antigo" });
  assert.deepEqual(s.receberHook({ agentId: s.id, event: "Stop", nonce: undefined }), { ok: false, motivo: "nonce de um spawn antigo" });
  assert.equal(s.receberHook({ agentId: s.id, event: "Stop", nonce }).ok, true);
  assert.equal(nonceConfere(nonce, nonce), true);
  assert.equal(nonceConfere(nonce, "x"), false);
  assert.equal(nonceConfere(null, "x"), false);
  // novo spawn, novo nonce
  s.parar("troca");
  await s.subir("nova");
  const depois = JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`), "utf8")).hooks.Stop[0].hooks[0].command.match(/--nonce ([0-9a-f]+)/)[1];
  assert.notEqual(depois, nonce);
  assert.equal(s.receberHook({ agentId: s.id, event: "Stop", nonce }).ok, false, "o nonce do spawn anterior morreu");
  assert.equal(lerTexto(amb.logDoRunner).includes(nonce), false);
  assert.equal(lerTexto(amb.logDoRunner).includes(depois), false);
});

test("digitar e enviar: o Enter vira turno pelo recibo do hook, e a sessão volta a idle", async () => {
  logarClaude(amb);
  const { s, hooks } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length;
  await s.digitarEEnviar("olá, mundo");
  await esperarAte(() => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length > antes, 5_000, "o prompt chegar no CLI");
  assert.equal(lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").pop()!.texto, "olá, mundo");
  await esperarAte(() => s.estado.status === "working" || hooks.recebidos.some((h) => h.event === "UserPromptSubmit"), 5_000);
  await esperarAte(() => s.estado.status === "idle" && hooks.recebidos.some((h) => h.event === "Stop"), 12_000, "o Stop confirmar");
});

/** Sobe a sessão com o gatilho do Stop perdido num prazo curto; devolve o hook falso e um escritor de transcript. */
async function novaComRedeCurta(prazoMs: number, opcoes: Record<string, unknown> = {}) {
  logarClaude(amb);
  const { s, pasta, hooks, id } = await nova({}, { quietoParaOlharTranscriptMs: prazoMs, ...opcoes });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const settings = JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`), "utf8"));
  const nonce: string = settings.hooks.Stop[0].hooks[0].command.match(/--nonce ([0-9a-f]+)/)[1];
  const hook = (event: string, extra: Record<string, unknown> = {}) => s.receberHook({ agentId: s.id, event, nonce, ...extra });
  const arquivo = path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "projects", "proj-teste", `${s.estado.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  /** Grava o transcript; `em` é o deslocamento em ms em relação a agora. */
  const transcript = (linhas: Array<[Record<string, unknown>, number]>) =>
    fs.writeFileSync(arquivo, linhas.map(([o, em]) => JSON.stringify({ ...o, timestamp: new Date(Date.now() + em).toISOString() })).join("\n") + "\n");
  return { s, hooks, hook, transcript, id };
}
const FIM_DO_TURNO = { type: "system", subtype: "turn_duration" };

test("Stop perdido: transcript termina em turn_duration depois do prompt + terminal mudo vira idle e solta a fila", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  assert.equal(s.estado.status, "working");
  transcript([[{ type: "assistant" }, 100], [{ type: "system", subtype: "stop_hook_summary" }, 200], [FIM_DO_TURNO, 300]]);
  const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length;
  s.enfileirarQuandoOcioso("mensagem presa na fila");
  await esperarAte(() => s.estado.status === "idle", 5_000, "a rede de segurança marcar idle");
  assert.equal(s.estado.statusReason, "transcript:turno encerrado sem o hook Stop");
  await esperarAte(
    () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length > antes,
    12_000,
    "a fila soltar o texto no CLI",
  );
  assert.ok(lerTexto(amb.logDoRunner).includes("o transcript já registra o fim do turno"), "o aviso explica o que aconteceu");
});

test("Stop perdido: transcript terminando em tool_use (sleep longo) com o terminal mudo continua working", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  transcript([[FIM_DO_TURNO, -60_000], [{ type: "assistant", message: { content: [{ type: "tool_use" }] } }, 100]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});

test("Stop perdido: turn_duration ANTERIOR ao último prompt não conta", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  transcript([[FIM_DO_TURNO, -60_000]]);
  hook("UserPromptSubmit");
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});

test("Stop perdido: waiting_input mudo não muda, mesmo com o fim do turno no transcript", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  hook("Notification");
  transcript([[FIM_DO_TURNO, 300]]);
  assert.equal(s.estado.status, "waiting_input");
  await dormir(2_000);
  assert.equal(s.estado.status, "waiting_input");
});

test("AskUserQuestion: PreToolUse vira waiting_input/pergunta, a resposta (PostToolUse) volta a working e zera o motivo", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  const settings = JSON.parse(fs.readFileSync(path.join(amb.estado, s.id, "runner-hooks", `${s.id}.settings.json`), "utf8"));
  assert.equal(settings.hooks.PostToolUse[0].matcher, "AskUserQuestion", "só a ferramenta de pergunta dispara o PostToolUse");
  hook("UserPromptSubmit");
  hook("PreToolUse", { toolName: "AskUserQuestion" });
  assert.equal(s.estado.status, "waiting_input");
  assert.equal(s.estado.motivo, "pergunta");
  hook("Notification");
  assert.equal(s.estado.motivo, "pergunta", "a permissão não rebaixa a pergunta aberta");
  hook("PostToolUse", { toolName: "AskUserQuestion" });
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.motivo, null);
});

test("permissão: Notification põe motivo permissao, e sair de waiting_input limpa o motivo", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("PreToolUse", { toolName: "Bash" });
  assert.equal(s.estado.motivo ?? null, null);
  hook("Notification");
  assert.equal(s.estado.status, "waiting_input");
  assert.equal(s.estado.motivo, "permissao");
  hook("UserPromptSubmit");
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.motivo, null);
});

test("pergunta dispensada: o Stop sem PostToolUse não deixa o agente preso em waiting_input", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("PreToolUse", { toolName: "AskUserQuestion" });
  hook("Stop");
  assert.equal(s.estado.status, "working", "volta a working e o Stop confirmado leva a idle");
  assert.equal(s.estado.motivo, null);
});

test("modelo escolhido vai em --model (id canônico, também pelo apelido)", async () => {
  logarClaude(amb);
  const { s, pasta, id } = await nova();
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "claude", auth: "assinatura", modelo: "sonnet" });
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length > 0, 5_000, "o CLI abrir");
  const argv: string[] = entradasDe(id)[0].argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "claude-sonnet-5-5");
});

test("modo API sem a chave: errored runner:sem-chave, sem PTY e NUNCA cai na assinatura", async () => {
  logarClaude(amb); // há login de assinatura, e mesmo assim não pode usar
  const guardada = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  test.after(() => void (process.env.ANTHROPIC_API_KEY = guardada));
  const { s, pasta, id } = await nova();
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "claude", auth: "api", modelo: "" });
  await s.subir("nova");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:sem-chave");
  assert.equal(s.temPtyVivo(), false);
  await dormir(300);
  assert.equal(entradasDe(id).length, 0, "o CLI nem foi aberto");
  assert.match(s.estado.error!, /ANTHROPIC_API_KEY não está no ambiente/);
  assert.match(s.estado.error!, /Cofre do painel/);
  const recusa = s.recusaDeEntrada()!;
  assert.equal(recusa.tipo, "chave");
  assert.match(recusa.comoResolver, /trocar a forma de pagar deste agente para a assinatura/);
  assert.match(s.estado.error!, /O que fazer: guardar a chave no Cofre do painel/);
});

test("modo API com a chave: sobe, pré-aprova a chave no .claude.json e mantém a variável do modo", async () => {
  logarClaude(amb);
  process.env.ANTHROPIC_API_KEY = ANT;
  const { s, pasta, id } = await nova();
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "claude", auth: "api", modelo: "" });
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length > 0, 5_000, "o CLI abrir");
  const e = entradasDe(id)[0];
  assert.equal(e.env.includes("ANTHROPIC_API_KEY"), true);
  const json = JSON.parse(fs.readFileSync(path.join(amb.claudeDir, ".claude.json"), "utf8"));
  assert.deepEqual(json.customApiKeyResponses.approved, [ANT.slice(-20)]);
  assert.equal(json.projects[amb.casa].hasTrustDialogAccepted, true);
  assert.equal(lerTexto(amb.logDoRunner).includes(ANT.slice(-20)), false, "o sufixo da chave não vai para o log");
  assert.equal(JSON.stringify(e.argv).includes(ANT.slice(-20)), false);
});

test("troca de provedor ou de auth no boot abre conversa NOVA; só o modelo diferente retoma", async () => {
  logarClaude(amb);
  process.env.ANTHROPIC_API_KEY = ANT;
  const { s, pasta, id } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const idAntigo = s.estado.sessionId!;
  s.parar("reboot simulado");

  // só o modelo muda: retoma com --resume e a flag nova
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "claude", auth: "assinatura", modelo: "claude-haiku-5-5" });
  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => entradasDe(id).length >= 2, 5_000, "o CLI reabrir");
  assert.deepEqual(entradasDe(id)[1].argv.slice(0, 2), ["--resume", idAntigo]);
  assert.equal(entradasDe(id)[1].argv.includes("claude-haiku-5-5"), true);
  s.parar("reboot simulado 2");

  // a forma de pagar muda (assinatura -> token): o id antigo é de outra conta
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-falso";
  test.after(() => void delete process.env.CLAUDE_CODE_OAUTH_TOKEN);
  gravarProvedorJson(path.join(pasta, "provedor.json"), { provedor: "claude", auth: "token", modelo: "" });
  assert.equal(await s.subir("retomar"), "nova");
  assert.notEqual(s.estado.sessionId, idAntigo);
  assert.equal(s.estado.previousSessionId, idAntigo);
  await esperarAte(() => entradasDe(id).length >= 3, 5_000, "o CLI reabrir de novo");
  assert.deepEqual(entradasDe(id)[2].argv.slice(0, 2), ["--session-id", s.estado.sessionId]);
  assert.equal(entradasDe(id)[2].argv.includes("--resume"), false);
});

test("canal Telegram: principal Claude com canais.json ligado leva --channels e o estado dele; o cache needs-auth é limpo", async () => {
  logarClaude(amb);
  const estadoTg = path.join(amb.casa, ".dgclaw", "telegram");
  fs.mkdirSync(estadoTg, { recursive: true });
  fs.writeFileSync(path.join(amb.casa, ".dgclaw", "canais.json"), JSON.stringify({ versao: 1, telegram: { ligado: true, estado_dir: estadoTg } }));
  test.after(() => fs.rmSync(path.join(amb.casa, ".dgclaw", "canais.json"), { force: true }));
  fs.writeFileSync(path.join(amb.claudeDir, "mcp-needs-auth-cache.json"), JSON.stringify({ "plugin:telegram:telegram": { timestamp: 1 }, "x:y": { timestamp: 2 } }));
  const { s, id } = await nova();
  await s.subir("nova");
  await esperarAte(() => entradasDe(id).length >= 1, 5_000, "o CLI abrir");
  const e = entradasDe(id)[0];
  const i = e.argv.indexOf("--channels");
  assert.ok(i >= 0);
  assert.equal(e.argv[i + 1], "plugin:telegram@claude-plugins-official");
  assert.equal(e.valores.TELEGRAM_STATE_DIR, fs.realpathSync(estadoTg));
  assert.equal(e.env.includes("TELEGRAM_BOT_TOKEN"), true, "o token do cofre fica no canal ligado");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(amb.claudeDir, "mcp-needs-auth-cache.json"), "utf8")), { "x:y": { timestamp: 2 } });
  s.parar("a");

  // retomar também leva --channels
  await s.subir("retomar");
  await esperarAte(() => entradasDe(id).length >= 2, 5_000, "o CLI reabrir");
  assert.deepEqual(entradasDe(id)[1].argv.slice(0, 1), ["--resume"]);
  assert.equal(entradasDe(id)[1].argv.includes("--channels"), true);
  s.parar("b");

  // a sessão PARALELA nunca leva o canal, mesmo com o canal ligado
  const par = await nova({}, { papel: "paralela", tipo: "bastidores", chat: "c_x" });
  await par.s.subir("nova");
  await esperarAte(() => entradasDe(par.id).length >= 1, 5_000, "a paralela abrir");
  const ep = entradasDe(par.id)[0];
  assert.equal(ep.argv.includes("--channels"), false);
  assert.equal(ep.env.includes("TELEGRAM_BOT_TOKEN"), false);
  assert.equal(ep.valores.TELEGRAM_STATE_DIR, path.join(amb.casa, ".dgclaw", "telegram-desligado"));
});

test("sem login a assinatura sobe o PTY e fica errored runner:sem-login (o dono vê a tela de login)", async () => {
  fs.rmSync(path.join(amb.claudeDir, ".credentials.json"), { force: true });
  const { s } = await nova();
  await s.subir("nova");
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:sem-login");
  assert.equal(s.temPtyVivo(), true);
  assert.equal(s.recusaDeEntrada()?.tipo, "login");
});

test("máscara de segredo: o valor do cofre que o CLI imprime sai oculto, até partido em dois pedaços; texto comum sai inteiro", async () => {
  logarClaude(amb);
  process.env.FAKE_IMPRIMIR = `chave=${OAI} e mais um pouco`;
  test.after(() => void delete process.env.FAKE_IMPRIMIR);
  const { s } = await nova();
  const ouvidos: string[] = [];
  s.on("terminal", (d: string) => ouvidos.push(d));
  await s.subir("nova");
  await esperarAte(() => ouvidos.join("").includes("texto final sk-"), 6_000, "o texto final sair depois do silêncio da máscara");
  const tudo = ouvidos.join("");
  assert.equal(tudo.includes(OAI), false);
  assert.equal(tudo.includes(OAI.slice(0, 12)), false, "nem a primeira metade");
  assert.equal(tudo.includes(OAI.slice(-12)), false, "nem a segunda");
  assert.match(tudo, /chave=\[segredo oculto\] e mais um pouco/);
  assert.match(tudo, /fake claude pronto/);
  const tela = s.telaInteira();
  assert.equal(tela.includes(OAI), false, "o buffer que o painel pede ao abrir também está limpo");
  assert.match(tela, /texto final sk-/, "o começo de chave solto sai quando passa o silêncio");
});

test("settings por spawn: skipDangerousModePermissionPrompt só em bypassPermissions", async () => {
  logarClaude(amb);
  const lerSettings = (pasta: string, id: string) =>
    JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${id}.settings.json`), "utf8"));
  const bypass = await nova({ permissionMode: "bypassPermissions" });
  await bypass.s.subir("nova");
  assert.equal(lerSettings(bypass.pasta, bypass.s.id).skipDangerousModePermissionPrompt, true);
  for (const modo of ["default", "auto"]) {
    const outro = await nova({ permissionMode: modo });
    await outro.s.subir("nova");
    assert.equal("skipDangerousModePermissionPrompt" in lerSettings(outro.pasta, outro.s.id), false, `modo ${modo}`);
  }
});

test("aviso do modo Bypass na tela: errored/runner:dialogo-bypass, nenhuma tecla enviada e a fila não é solta", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_BYPASS = "1";
  try {
    // Sem a chave no settings (cenário de uma versão velha do runner ou do settings por spawn que falhou).
    const { s, id } = await nova({ permissionMode: "default" });
    s.enfileirarQuandoOcioso("texto que não pode ser digitado no aviso");
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "errored", 8_000, "o runner reconhecer o aviso do Bypass");
    assert.equal(s.estado.statusReason, "runner:dialogo-bypass");
    assert.match(s.estado.error ?? "", /skipDangerousModePermissionPrompt/);
    assert.match(lerTexto(amb.logDoRunner), /Bypass Permissions mode.*Nenhuma tecla foi enviada/s);
    // Passa do boot-timer de 8s e da janela da fila: continua errored e nada chegou ao CLI.
    await dormir(9_000);
    assert.equal(s.estado.status, "errored");
    const teclas = lerLinhasJson(amb.logDosClis).filter(
      (l) => l.bin === "claude" && ["tecla-no-aviso", "prompt"].includes(l.modo) && l.argv.some((a: string) => a.endsWith(`/${id}.settings.json`)),
    );
    assert.equal(teclas.length, 0, "nenhum Enter nem texto escrito no PTY");
  } finally {
    delete process.env.FAKE_AVISO_BYPASS;
  }
});

test("aviso do modo Bypass: com a chave no settings por spawn o fake não abre o aviso e o agente sobe", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_BYPASS = "1";
  try {
    const { s } = await nova({ permissionMode: "bypassPermissions" });
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
    assert.equal(s.estado.statusReason, "hook:SessionStart");
  } finally {
    delete process.env.FAKE_AVISO_BYPASS;
  }
});

test("auto mode: o settings traz skipAutoPermissionPrompt só no permissionMode auto", async () => {
  logarClaude(amb);
  const lerSettings = (pasta: string, id: string) =>
    JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${id}.settings.json`), "utf8"));
  const auto = await nova({ permissionMode: "auto" });
  await auto.s.subir("nova");
  assert.equal(lerSettings(auto.pasta, auto.s.id).skipAutoPermissionPrompt, true);
  for (const modo of ["default", "bypassPermissions"]) {
    const outro = await nova({ permissionMode: modo });
    await outro.s.subir("nova");
    assert.equal("skipAutoPermissionPrompt" in lerSettings(outro.pasta, outro.s.id), false, `modo ${modo}`);
  }
});

test("auto mode: com a chave no settings o fake não abre a pergunta e o texto vira turno", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_AUTO = "1";
  try {
    const { s, id } = await nova({ permissionMode: "auto" });
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
    await dormir(400);
    await s.digitarEEnviar("pedido do card");
    const prompts = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" && l.texto === "pedido do card");
    assert.ok(prompts.length >= 1, `o prompt chegou ao CLI (sessão ${id})`);
  } finally {
    delete process.env.FAKE_AVISO_AUTO;
  }
});

test("pergunta do auto mode na tela (sem a chave no settings): NÃO digita o texto e falha com o motivo", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_AUTO = "1";
  try {
    // permissionMode default de propósito: simula runner antigo/settings que falhou, sem a chave.
    const { s } = await nova({ permissionMode: "default" });
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
    await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.modo === "aviso-auto"), 5_000, "o fake abrir a pergunta");
    await dormir(300);
    const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" || l.modo === "tecla-no-aviso").length;
    await assert.rejects(s.digitarEEnviar("texto que cairia no menu"), /Make auto mode your default permission mode/);
    await dormir(300);
    const depois = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" || l.modo === "tecla-no-aviso").length;
    assert.equal(depois, antes, "nenhuma tecla chegou ao CLI");
    assert.match(lerTexto(amb.logDoRunner), /Make auto mode your default permission mode.*skipAutoPermissionPrompt/s);
  } finally {
    delete process.env.FAKE_AVISO_AUTO;
  }
});

test("ehDialogoDeAutoMode: reconhece a pergunta aberta, ignora a já respondida e a citação solta", async () => {
  const { ehDialogoDeAutoMode } = await import("./sessao/telas.js");
  const dialogo =
    "\u001b[2JMake\u001b[1Cauto\u001b[1Cmode\u001b[1Cyour default permission mode?\r\nAuto mode lets Claude handle permission prompts.\r\n" +
    "\u276f Yes, set auto mode as my default permission mode\r\n  No, keep Default\r\n";
  assert.equal(ehDialogoDeAutoMode(dialogo), true);
  const depois = dialogo + "\r\n" + "> pronto para o pedido ".repeat(10) + "? for shortcuts";
  assert.equal(ehDialogoDeAutoMode(depois), false, "pergunta já respondida: o prompt voltou depois dela");
  // Cenário do Codex: limpeza de tela + prompt curto (menos de 80 caracteres) depois do diálogo.
  assert.equal(ehDialogoDeAutoMode(dialogo + "\u001b[2J\u001b[H\u276f \r\n? for shortcuts"), false, "limpou a tela e redesenhou um prompt curto");
  assert.equal(ehDialogoDeAutoMode(dialogo + "\u001b[3J\u001b[H\u276f"), false);
  assert.equal(ehDialogoDeAutoMode(dialogo + "\u001b[?1049l\r\nvoltou"), false, "saiu da tela alternativa");
  assert.equal(ehDialogoDeAutoMode(dialogo + "\r\n\u276f"), false, "prompt redesenhado sem limpeza");
  assert.equal(ehDialogoDeAutoMode("lixo velho\u001b[2J" + dialogo), true, "a limpeza ANTES do diálogo não o esconde");
  assert.equal(ehDialogoDeAutoMode("o usuário falou em Make auto mode your default permission mode?"), false);
});

test("fila + pergunta do auto mode: o pedido NÃO some, a sessão NÃO vira errored, um só log por bloqueio; ao fechar o aviso entrega uma vez", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_AUTO = "1";
  try {
    const { s } = await nova({ permissionMode: "default" }, { reintentoTelaBloqueadaMs: 300 });
    await s.subir("nova");
    await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.modo === "aviso-auto"), 5_000, "o fake abrir a pergunta");
    const teclas = () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" || l.modo === "tecla-no-aviso").length;
    const marca = teclas();
    const pedido = "pedido do card que não pode se perder";
    const logAntes = lerTexto(amb.logDoRunner).length;
    s.enfileirarQuandoOcioso(pedido);
    await esperarAte(() => s.bloqueioDaFilaLogado, 15_000, "a fila reconhecer o bloqueio");
    await dormir(2_000); // várias rodadas de nova tentativa
    assert.notEqual(s.estado.status, "errored");
    assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), [pedido]);
    const noDisco = JSON.parse(fs.readFileSync(s.arquivoDaFila, "utf8"));
    assert.deepEqual(noDisco.itens.map((i: { texto: string }) => i.texto), [pedido]);
    assert.equal(teclas(), marca, "nenhuma tecla chegou ao CLI");
    const novoLog = lerTexto(amb.logDoRunner).slice(logAntes);
    assert.equal((novoLog.match(/Make auto mode your default permission mode/g) ?? []).length, 1, "um só log de erro por bloqueio");
    assert.match(novoLog, /responder o aviso no terminal do agente.*Não reenvie/s);

    // O dono responde o aviso no terminal: o pedido sai uma vez só e a fila esvazia.
    s.escrever("2");
    const entregues = () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" && l.texto === pedido).length;
    await esperarAte(() => entregues() === 1, 15_000, "o pedido ser entregue depois que o aviso sumiu");
    await esperarAte(() => s.filaQuandoIdle.length === 0 && !s.itemEmVoo, 5_000);
    await dormir(1_000);
    assert.equal(entregues(), 1, "entregue uma vez só");
    assert.equal(fs.existsSync(s.arquivoDaFila), false, "a fila persistida esvaziou");
  } finally {
    delete process.env.FAKE_AVISO_AUTO;
  }
});

test("fila + pergunta do auto mode: parar a sessão cancela o timer de nova tentativa", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_AUTO = "1";
  try {
    const { s } = await nova({ permissionMode: "default" }, { reintentoTelaBloqueadaMs: 300 });
    await s.subir("nova");
    await esperarAte(() => lerLinhasJson(amb.logDosClis).some((l) => l.modo === "aviso-auto"), 5_000);
    s.enfileirarQuandoOcioso("pedido que fica guardado");
    await esperarAte(() => s.bloqueioDaFilaLogado, 15_000, "a fila reconhecer o bloqueio");
    await s.pararEEsperar("fim do teste");
    assert.equal(s.reintentoDaFila, null, "sem timer pendente");
    assert.equal(s.filaQuandoIdle.length, 1, "o pedido continua guardado");
  } finally {
    delete process.env.FAKE_AVISO_AUTO;
  }
});

test("fila sem a pergunta do auto mode (chave no settings): o pedido enfileirado é entregue normalmente", async () => {
  logarClaude(amb);
  process.env.FAKE_AVISO_AUTO = "1";
  try {
    const { s } = await nova({ permissionMode: "auto" });
    await s.subir("nova");
    s.enfileirarQuandoOcioso("pedido entregue pela fila");
    await esperarAte(
      () => lerLinhasJson(amb.logDosClis).some((l) => l.modo === "prompt" && l.texto === "pedido entregue pela fila"),
      15_000,
      "o pedido chegar ao CLI",
    );
    await esperarAte(() => s.filaQuandoIdle.length === 0 && !s.itemEmVoo, 5_000);
    assert.notEqual(s.estado.status, "errored");
  } finally {
    delete process.env.FAKE_AVISO_AUTO;
  }
});

// --- recibo do Enter: sinais de processamento sem UserPromptSubmit ------------------------------------

test("recibo: só o PreCompact conta (e só para comando de barra); PreToolUse e UserPromptSubmit não mexem nele", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  const base = s.compactsIniciados;
  hook("UserPromptSubmit");
  hook("PreToolUse", { toolName: "Bash" });
  assert.equal(s.compactsIniciados, base);
  hook("PreCompact");
  assert.equal(s.compactsIniciados, base + 1);
});

test("recibo: esperarRecibo aceita PreCompact só quando é comando de barra; PreToolUse nunca vale", async () => {
  const { esperarRecibo } = await import("./sessao/digitacao.js");
  const falso = (extra: Record<string, unknown> = {}) =>
    ({ hooksVivos: true, motor: { reciboPorRollout: false }, promptsAceitos: 0, compactsIniciados: 0, ...extra }) as never;
  const mexer = (s: unknown, campo: string) => setTimeout(() => ((s as Record<string, number>)[campo] += 1), 150);

  const compact = falso();
  const espera1 = esperarRecibo(compact, 0, 2_000, 0);
  mexer(compact, "compactsIniciados");
  assert.equal(await espera1, true, "PreCompact depois do Enter de um /comando vale como recibo");

  const textoComum = falso();
  const espera2 = esperarRecibo(textoComum, 0, 500);
  mexer(textoComum, "compactsIniciados");
  assert.equal(await espera2, false, "para texto comum o PreCompact não vale");

  assert.equal(await esperarRecibo(falso({ compactsIniciados: 5 }), 0, 300, 5), false, "PreCompact ANTERIOR ao Enter não vale");
  assert.equal(await esperarRecibo(falso(), 0, 300), false, "texto preso: nenhum recibo");

  const aceito = falso();
  const espera3 = esperarRecibo(aceito, 0, 2_000);
  mexer(aceito, "promptsAceitos");
  assert.equal(await espera3, true, "UserPromptSubmit continua sendo o recibo normal");
});

test("recibo: turno anterior emitindo PreToolUse com a mensagem presa NÃO esconde o erro; o 2º Enter que entrega confirma", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const nonce = s.nonce ?? undefined;
  const hook = (event: string, extra: Record<string, unknown> = {}) => s.receberHook({ agentId: s.id, event, nonce, ...extra });
  const original = s.escrever.bind(s);
  const enters: string[] = [];
  const trocar = (f: (t: string) => void) => { (s as unknown as { escrever: (t: string) => void }).escrever = f; };
  try {
    // Mensagem presa: os Enters são engolidos e um turno ANTERIOR segue emitindo PreToolUse.
    trocar((t) => { enters.push(t); });
    const ticker = setInterval(() => hook("PreToolUse", { toolName: "Bash" }), 300);
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarComRecibo(s);
    clearInterval(ticker);
    assert.equal(enters.length, 3, "os 3 Enters saíram");
    assert.match(lerTexto(amb.logDoRunner).slice(marca), /digitei \d Enters e nenhum abriu turno/);

    // O 2º Enter entrega: o UserPromptSubmit chega depois dele e o runner para por aí.
    enters.length = 0;
    trocar((t) => { enters.push(t); if (enters.length === 2) hook("UserPromptSubmit"); });
    const marca2 = lerTexto(amb.logDoRunner).length;
    await enviarComRecibo(s);
    assert.equal(enters.length, 2);
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca2), /digitei \d Enters e nenhum abriu turno/);
  } finally {
    trocar(original);
  }
});

test("recibo: /compact sem UserPromptSubmit é confirmado pelo PreCompact e não dá alarme", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = () => {
    setTimeout(() => s.receberHook({ agentId: s.id, event: "PreCompact", nonce: s.nonce ?? undefined }), 200);
  };
  try {
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarComRecibo(s, true);
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca), /digitei \d Enters e nenhum abriu turno/);
  } finally {
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
  }
});

// --- login expirado (caso real de 19/10/2026) --------------------------------------------------

const ERRO_DE_LOGIN = {
  type: "assistant",
  isApiErrorMessage: true,
  error: "authentication_failed",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Login expired · Please run /login" }] },
};
/** Quantas subidas do CLI falso esta sessão já teve; uma linha do log pela metade (escrita agora) conta como "ainda não". */
const subidasDe = (id: string) => {
  try {
    return entradasDe(id).length;
  } catch {
    return -1;
  }
};
const recadosDeLogin = (): Array<Record<string, any>> => {
  try {
    return lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt" && String(l.texto).includes("login-reconectado"));
  } catch {
    return [];
  }
};
const CREDENCIAL = () => path.join(amb.claudeDir, ".credentials.json");
/** Põe a data da credencial `emMs` à frente de agora, como se o login tivesse sido refeito. */
const renovarCredencial = (emMs = 5_000) => {
  logarClaude(amb);
  const t = new Date(Date.now() + emMs);
  fs.utimesSync(CREDENCIAL(), t, t);
};

test("login expirado: StopFailure authentication_failed tira de working, vira errored/login-expirado e recusa turno", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  assert.equal(s.estado.status, "working");
  hook("StopFailure", { error: "authentication_failed", lastAssistantMessage: "Failed to authenticate: OAuth session expired and could not be refreshed" });
  assert.equal(s.estado.status, "errored");
  assert.equal(s.estado.statusReason, "runner:login-expirado");
  assert.equal(s.estado.motivo, "login");
  assert.match(s.estado.loginExpiradoEm ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.match(s.estado.error ?? "", /expirou às \d\d:\d\d/);
  assert.match(s.estado.error ?? "", /O que fazer/);
  const recusa = s.recusaDeEntrada();
  assert.equal(recusa?.tipo, "login-expirado");
  assert.ok(lerTexto(amb.logDoRunner).includes("login expirado detectado por hook StopFailure"));
  assert.equal(s.temPtyVivo(), true, "o terminal continua vivo para o /login");
});

test("StopFailure por outro motivo (rate_limit): sai de working para idle, sem login expirado", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("StopFailure", { error: "rate_limit", lastAssistantMessage: "Rate limit reached" });
  assert.equal(s.estado.status, "idle");
  assert.equal(s.estado.statusReason, "hook:StopFailure rate_limit");
  assert.equal(s.recusaDeEntrada(), null);
  assert.ok(lerTexto(amb.logDoRunner).includes("o turno terminou com erro da API (rate_limit"));
});

test("login expirado: o erro sintético no fim do transcript, com o terminal mudo, tem o mesmo efeito", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  renovarCredencial(-60_000);
  hook("UserPromptSubmit");
  transcript([[{ type: "user", message: { role: "user", content: "oi" } }, 50], [ERRO_DE_LOGIN, 100]]);
  await esperarAte(() => s.estado.statusReason === "runner:login-expirado", 5_000, "a rede de segurança achar o erro de login");
  assert.equal(s.estado.status, "errored");
});

test("login expirado: com a credencial renovada DEPOIS do erro, a linha velha no transcript não derruba o agente", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  transcript([[ERRO_DE_LOGIN, 100]]);
  renovarCredencial(60_000);
  await dormir(1_500);
  assert.equal(s.estado.status, "working", "o erro é anterior à credencial: não conta (e este turno não tem turn_duration)");
});

test("login expirado: credencial mais nova que o erro reinicia RETOMANDO a mesma sessão e entrega UM recado", async () => {
  logarClaude(amb);
  const { s, hook, id } = await novaComRedeCurta(60_000, { vigiaLoginExpiradoMs: 100 });
  const sessionId = s.estado.sessionId!;
  hook("UserPromptSubmit");
  hook("StopFailure", { error: "authentication_failed" });
  assert.equal(s.estado.statusReason, "runner:login-expirado");
  const spawnsAntes = entradasDe(id).length;
  renovarCredencial();
  await esperarAte(() => subidasDe(id) > spawnsAntes, 8_000, "o runner reiniciar sozinho");
  await dormir(200);
  const reinicio = entradasDe(id).at(-1)!;
  assert.equal(reinicio.argv[reinicio.argv.indexOf("--resume") + 1], sessionId, "retomou a MESMA sessão");
  assert.equal(reinicio.argv.includes("--session-id"), false, "não abriu sessão nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "voltar a idle");
  assert.equal(s.estado.loginExpiradoEm, null);
  assert.equal(s.recusaDeEntrada(), null);
  const recado = recadosDeLogin;
  await esperarAte(() => recado().length === 1, 12_000, "o recado de login reconectado chegar ao CLI");
  assert.match(recado()[0].texto, /expirou às \d\d:\d\d e voltou às \d\d:\d\d/);
  await dormir(1_500);
  assert.equal(recado().length, 1, "uma vez por incidente");
});

test("login expirado: aposLoginConcluido (login assistido) também retoma a mesma sessão", async () => {
  logarClaude(amb);
  const { s, hook, id } = await novaComRedeCurta(60_000);
  const sessionId = s.estado.sessionId!;
  hook("UserPromptSubmit");
  hook("StopFailure", { error: "authentication_failed" });
  const spawnsAntes = entradasDe(id).length;
  renovarCredencial();
  s.aposLoginConcluido();
  await esperarAte(() => subidasDe(id) > spawnsAntes, 8_000, "o reinício depois do login");
  await dormir(200);
  const reinicio = entradasDe(id).at(-1)!;
  assert.equal(reinicio.argv[reinicio.argv.indexOf("--resume") + 1], sessionId);
  await esperarAte(() => s.estado.status === "idle", 8_000);
  assert.equal(s.estado.sessionId, sessionId);
});

test("login expirado: reiniciar SEM renovar a credencial não conta recado e deixa o motivo no log", async () => {
  logarClaude(amb);
  const { s, hook } = await novaComRedeCurta(60_000);
  const recados = () => recadosDeLogin().length;
  const antes = recados();
  hook("UserPromptSubmit");
  hook("StopFailure", { error: "authentication_failed" });
  s.parar("teste");
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  assert.ok(lerTexto(amb.logDoRunner).includes("sem que a credencial tenha sido renovada"));
  await dormir(1_000);
  assert.equal(recados(), antes, "nenhum recado novo");
});
