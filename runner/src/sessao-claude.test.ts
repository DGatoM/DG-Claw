import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
  const id = `sess-${n}`;
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
