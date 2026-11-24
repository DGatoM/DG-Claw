import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  dormir, abrirServidorDeHooks, chaveFalsa, chaveFalsaOpenai, esperarAte, gravarTranscriptDoClaude, alimentarTela, lerLinhasJson, lerTexto, logarClaude, prepararAmbiente,
} from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-claude");
const { Sessao, nonceConfere } = await import("./sessao.js");
const { gravarProvedorJson } = await import("./provedores/escolha.js");
const { HOOK_TIMEOUT_S } = await import("./sessao/configuracao.js");

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
  return { s, hooks, hook, transcript, id, arquivo };
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

const INTERROMPIDO = (texto: unknown) => ({ type: "user", message: { role: "user", content: texto } });
test("Stop perdido: interrupção do usuário ('[Request interrupted by user]') no fim do transcript vira idle e solta a fila", async () => {
  for (const texto of [[{ type: "text", text: "[Request interrupted by user for tool use]" }], "[Request interrupted by user]"]) {
    const { s, hook, transcript } = await novaComRedeCurta(600);
    hook("UserPromptSubmit");
    s.escrever("\u001b");
    transcript([[{ type: "assistant" }, 100], [INTERROMPIDO(texto), 200]]);
    s.enfileirarQuandoOcioso("mensagem presa na fila");
    await esperarAte(() => s.estado.status === "idle", 5_000, "o fim de turno por interrupção marcar idle");
    assert.match(s.estado.statusReason ?? "", /^transcript:/);
  }
});
test("Stop perdido: texto que só começa pelo prefixo de interrupção, ou interrupção antiga, não encerram o turno", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  transcript([[INTERROMPIDO([{ type: "text", text: "[Request interrupted by user] e mais coisa" }]), 200]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), -60_000]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});
test("Stop perdido: o marcador literal sem Esc, ou com Esc de outro processo, não encerra o turno", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), 200]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working", "sem nenhum Esc registrado");
  s.ultimoEscReal = { em: Date.now(), proc: {} };
  await dormir(2_000);
  assert.equal(s.estado.status, "working", "Esc de um processo anterior");
});
test("Stop perdido: dois Parar separados por 4 s, com o marcador do primeiro no transcript, vira idle e entrega a fila", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  const rel = { t: 1_000_000 };
  s.agora = () => rel.t;
  assert.equal(s.interromper().ok, true);
  const primeiro = s.ultimoEscReal;
  rel.t += 4_000;
  assert.equal(s.interromper().ok, true);
  assert.equal(s.ultimoEscReal, primeiro, "o segundo Esc não sobrescreve o pendente");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), 200]]);
  const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length;
  s.enfileirarQuandoOcioso("mensagem presa na fila");
  await esperarAte(() => s.estado.status === "idle", 5_000, "o fim de turno por interrupção marcar idle");
  assert.equal(s.ultimoEscReal, null, "o turno terminou: o Esc pendente cai");
  await esperarAte(() => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length > antes, 12_000, "a fila soltar o texto no CLI");
});
test("Stop perdido: Esc de um turno já encerrado + marcador literal num turno novo não encerram o turno", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  s.escrever("\u001b");
  assert.ok(s.ultimoEscReal);
  s.mudar({ status: "idle", statusReason: "teste: turno acabou" });
  assert.equal(s.ultimoEscReal, null);
  hook("UserPromptSubmit");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), 200]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});
test("Stop perdido: marcador que já era a última linha antes do Esc (horário anterior ao clique) não encerra o turno", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), -1_000]]);
  s.escrever("\u001b");
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});
test("Stop perdido: marcador com o mesmo horário do Esc vale, e entradas ai-title depois dele são puladas", async () => {
  const { s, hook, arquivo } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  await dormir(20);
  s.escrever("\u001b");
  const em = s.ultimoEscReal!.em;
  const linha = (o: Record<string, unknown>, ms: number) => JSON.stringify({ ...o, timestamp: new Date(ms).toISOString() });
  fs.writeFileSync(arquivo, [linha(INTERROMPIDO("[Request interrupted by user]"), em), linha({ type: "ai-title", aiTitle: "titulo" }, em + 50), linha({ type: "file-history-snapshot" }, em + 60)].join("\n") + "\n");
  await esperarAte(() => s.estado.status === "idle", 5_000, "o marcador no mesmo ms valer apesar dos tipos extras depois");
});
test("Stop perdido: queue-operation (ou qualquer registro não metadado) depois do marcador impede a prova", async () => {
  const { s, hook, arquivo } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  await dormir(20);
  s.escrever("\u001b");
  const em = s.ultimoEscReal!.em;
  const linha = (o: Record<string, unknown>, ms: number) => JSON.stringify({ ...o, timestamp: new Date(ms).toISOString() });
  fs.writeFileSync(arquivo, [linha(INTERROMPIDO("[Request interrupted by user]"), em + 10), linha({ type: "queue-operation", operation: "enqueue" }, em + 20)].join("\n") + "\n");
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});
test("Stop perdido: user/assistant DEPOIS do marcador, mesmo com ai-title no meio, não encerram", async () => {
  const { s, hook, arquivo } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  s.escrever("\u001b");
  const em = s.ultimoEscReal!.em;
  const linha = (o: Record<string, unknown>, ms: number) => JSON.stringify({ ...o, timestamp: new Date(ms).toISOString() });
  fs.writeFileSync(arquivo, [linha(INTERROMPIDO("[Request interrupted by user]"), em + 10), linha({ type: "ai-title" }, em + 20), linha({ type: "assistant", message: { content: [] } }, em + 30)].join("\n") + "\n");
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
});
test("Stop perdido: linhas 'null', número e lixo no fim do transcript não derrubam a leitura", async () => {
  const { s, hook, transcript, arquivo } = await novaComRedeCurta(600);
  hook("UserPromptSubmit");
  s.escrever("\u001b");
  transcript([[INTERROMPIDO("[Request interrupted by user]"), 200]]);
  fs.appendFileSync(arquivo, "null\n7\n[1]\nisto não é json\n");
  await esperarAte(() => s.estado.status === "idle", 5_000, "o fim de turno ser reconhecido apesar das linhas estranhas");
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

const RECUSA_DO_COMPACT = {
  type: "system",
  subtype: "local_command",
  content: "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
  commandRun: { command: "compact", args: "" },
};

test("PreCompact: o CLI recusa o /compact (transcript com local_command e sem compact_boundary) e o agente volta a idle soltando a fila", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  assert.equal(s.estado.statusReason, "hook:PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100]]);
  const antes = lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length;
  s.enfileirarQuandoOcioso("mensagem atrás do /compact recusado");
  await esperarAte(() => s.estado.status === "idle", 5_000, "a recusa do compact virar idle");
  assert.equal(s.estado.statusReason, "transcript:compact recusado pelo CLI");
  await esperarAte(
    () => lerLinhasJson(amb.logDosClis).filter((l) => l.modo === "prompt").length > antes,
    12_000,
    "a fila soltar o texto no CLI",
  );
  const log = lerTexto(amb.logDoRunner);
  assert.ok(log.includes("compact recusado: poucas mensagens"), "o aviso traz o motivo fixo");
  assert.equal(log.includes("Not enough messages to compact."), false, "o texto cru do transcript não vai para o log");
});

test("PreCompact: recusa ANTERIOR ao PreCompact não vale", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  transcript([[RECUSA_DO_COMPACT, -60_000]]);
  hook("PreCompact");
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.statusReason, "hook:PreCompact");
});

test("PreCompact: compact normal termina pelo SessionStart source=compact, como sempre", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("PreCompact");
  assert.equal(s.estado.status, "working");
  hook("SessionStart", { source: "compact" });
  await esperarAte(() => s.estado.status === "idle", 12_000, "o fim do compact virar idle");
  assert.notEqual(s.estado.statusReason, "transcript:compact recusado pelo CLI");
});

test("PreCompact: com compact_boundary depois do local_command a regra da recusa não dispara", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100], [{ type: "system", subtype: "compact_boundary" }, 200]]);
  await dormir(2_000);
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.statusReason, "hook:PreCompact");
});

test("PreCompact: recusa com conteúdo vazio ou desconhecido não conta, e o texto desconhecido não aparece no log", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  const marca = "CONTEUDO-DESCONHECIDO-DO-CLI";
  transcript([[{ ...RECUSA_DO_COMPACT, content: "" }, 100]]);
  await dormir(1_500);
  assert.equal(s.estado.status, "working");
  transcript([[{ ...RECUSA_DO_COMPACT, content: `<local-command-stdout>${"x".repeat(150)}${marca}</local-command-stdout>` }, 100]]);
  await dormir(1_500);
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.statusReason, "hook:PreCompact");
  assert.equal(lerTexto(amb.logDoRunner).includes(marca), false);
});

test("PreCompact: recusa com timestamp numérico ou objeto não lança e não conta", async () => {
  const { s, hook, arquivo } = await novaComRedeCurta(600);
  hook("PreCompact");
  for (const ts of [Date.now() + 100, { a: 1 }]) {
    fs.writeFileSync(arquivo, JSON.stringify({ ...RECUSA_DO_COMPACT, timestamp: ts }) + "\n");
    await dormir(1_500);
    assert.equal(s.estado.status, "working");
    assert.equal(s.estado.statusReason, "hook:PreCompact");
  }
});

test("PreCompact: recusa seguida de linha de fila ou anexo (metadado desconhecido) não conta", async () => {
  for (const extra of [{ type: "queue-operation", operation: "enqueue" }, { type: "attachment", attachment: { type: "queued_command" } }]) {
    const { s, hook, transcript } = await novaComRedeCurta(600);
    hook("PreCompact");
    transcript([[RECUSA_DO_COMPACT, 100], [extra, 200]]);
    await dormir(1_500);
    assert.equal(s.estado.status, "working");
    assert.equal(s.estado.statusReason, "hook:PreCompact");
  }
});

test("ultimoEventoEm anda num PreToolUse repetido da mesma ferramenta, sem mexer no updatedAt", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("PreToolUse", { toolName: "Bash", toolUseId: "tu-1" });
  const evento1 = s.ultimoEventoEm;
  const atualizado1 = s.estado.updatedAt;
  await dormir(50);
  hook("PreToolUse", { toolName: "Bash", toolUseId: "tu-2" });
  assert.ok(s.ultimoEventoEm > evento1);
  assert.equal(s.estado.updatedAt, atualizado1);
});

test("PreCompact: linha de usuário com local-command-stderr citando a recusa não conta e anula a recusa anterior", async () => {
  const stderr = { type: "user", message: { role: "user", content: "<local-command-stderr>\u001b[31mError: Not enough messages to compact.\u001b[0m</local-command-stderr>" } };
  {
    const { s, hook, transcript } = await novaComRedeCurta(600);
    hook("PreCompact");
    transcript([[stderr, 100]]);
    await dormir(1_500);
    assert.equal(s.estado.status, "working");
  }
  {
    const { s, hook, transcript } = await novaComRedeCurta(600);
    hook("PreCompact");
    transcript([[RECUSA_DO_COMPACT, 100], [stderr, 200]]);
    await dormir(1_500);
    assert.equal(s.estado.status, "working");
  }
});

test("PreCompact: recusa seguida de ai-title ainda conta", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100], [{ type: "ai-title", aiTitle: "x" }, 200]]);
  await esperarAte(() => s.estado.status === "idle", 5_000, "a recusa com ai-title depois virar idle");
});

test("PreCompact: linha ilegível depois da recusa (ainda sendo escrita) anula a recusa", async () => {
  const { s, hook, transcript, arquivo } = await novaComRedeCurta(600);
  hook("PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100]]);
  fs.appendFileSync(arquivo, '{"type":"assistant","message":{"content":[{"type":"te');
  await dormir(1_500);
  assert.equal(s.estado.status, "working");
});

test("fila: dois /compact seguidos com o agente ocupado ficam em 1; /compact + mensagem + /compact ficam em 2", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  s.enfileirarQuandoOcioso("/compact");
  s.enfileirarQuandoOcioso(" /compact ");
  assert.equal(s.filaQuandoIdle.length, 1);
  s.filaQuandoIdle.length = 0;
  s.enfileirarQuandoOcioso("/compact");
  s.enfileirarQuandoOcioso("uma mensagem");
  s.enfileirarQuandoOcioso("/compact");
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["/compact", "uma mensagem"]);
  s.filaQuandoIdle.length = 0;
  s.enfileirarQuandoOcioso("/compact foque nas decisões");
  s.enfileirarQuandoOcioso("/compact foque nas decisões");
  s.enfileirarQuandoOcioso("/compact");
  s.enfileirarQuandoOcioso("/compactar não é o comando");
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["/compact foque nas decisões", "/compactar não é o comando"]);
});

test("fila: /compact não entra se já há um sendo digitado ou um compact em andamento, e devolve false", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  s.itemEmVoo = { texto: "/compact", em: Date.now() };
  assert.equal(s.enfileirarQuandoOcioso("/compact"), "deduplicado");
  assert.equal(s.filaQuandoIdle.length, 0);
  s.itemEmVoo = null;
  hook("PreCompact");
  assert.equal(s.enfileirarQuandoOcioso("/compact"), "deduplicado");
  assert.equal(s.filaQuandoIdle.length, 0);
  assert.equal(s.enfileirarQuandoOcioso("uma mensagem"), "enfileirado");
  assert.equal(s.filaQuandoIdle.length, 1);
});

test("PreCompact: recusa seguida de linha assistant (o agente seguiu trabalhando) não conta", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100], [{ type: "assistant", message: { content: [] } }, 200]]);
  await dormir(1_500);
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.statusReason, "hook:PreCompact");
});

test("PreCompact: compact bom seguido de ferramenta longa e terminal quieto não solta a fila nem vai para idle", async () => {
  const { s, hook, transcript } = await novaComRedeCurta(600);
  hook("PreCompact");
  hook("SessionStart", { source: "compact" });
  hook("PreToolUse", { toolName: "Bash", toolUseId: "tu-1" });
  assert.equal(s.compactComecouEm, 0);
  assert.notEqual(s.estado.statusReason, "hook:PreCompact");
  transcript([[RECUSA_DO_COMPACT, 100]]);
  s.enfileirarQuandoOcioso("mensagem que tem que esperar a ferramenta");
  await dormir(9_000);
  assert.equal(s.estado.status, "working");
  assert.equal(s.filaQuandoIdle.length, 1);
});

test("AskUserQuestion: PreToolUse vira waiting_input/pergunta, a resposta (PostToolUse) volta a working e zera o motivo", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  const settings = JSON.parse(fs.readFileSync(path.join(amb.estado, s.id, "runner-hooks", `${s.id}.settings.json`), "utf8"));
  assert.equal(settings.hooks.PostToolUse[0].matcher, "AskUserQuestion", "só a ferramenta de pergunta dispara o PostToolUse");
  // Todo hook do runner tem teto: um node travado no arranque não pode segurar o turno pelo padrão longo do Claude.
  // A mensagem de falha leva só o evento e o timeout (o comando tem o nonce da sessão).
  assert.equal(HOOK_TIMEOUT_S, 10, "o teto dos hooks do runner é 10 s (2,5 s do cinto + folga para a partida do node)");
  let conferidos = 0;
  for (const [ev, grupos] of Object.entries(settings.hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>)) {
    for (const grupo of grupos) {
      for (const h of grupo.hooks) {
        if (h.command.includes("runner-hook.mjs")) {
          assert.equal(h.timeout, HOOK_TIMEOUT_S, `hook ${ev} do runner com timeout ${String(h.timeout)}`);
          conferidos++;
        } else if (h.command.includes("trava-resposta.mjs")) {
          assert.equal(h.timeout, 10, `trava-resposta com timeout ${String(h.timeout)}`);
        }
      }
    }
  }
  assert.equal(conferidos, 8, "os oito eventos do runner têm teto");
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

test("StopBloqueado depois do Stop cancela o idle agendado", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("Stop");
  assert.ok(s.stopPendente, "o Stop agenda o idle");
  hook("StopBloqueado");
  assert.equal(s.stopPendente, null, "o idle agendado foi cancelado, então a fila não é solta");
  assert.equal(s.estado.status, "working");
  assert.equal(s.estado.statusReason, "hook:Stop devolvido pela trava de resposta");
  // A recuperação rápida (reenvio pela tool em menos de 6s) termina num Stop que precisa valer.
  hook("PreToolUse", { toolName: "mcp__dgchat__reply" });
  hook("Stop");
  assert.ok(s.stopPendente, "o Stop da recuperação agenda o idle, o agente não fica preso em working");
});

test("aviso da trava que sobrou (Stop perdido) não engole o Stop da recuperação", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("StopBloqueado");
  hook("PreToolUse", { toolName: "mcp__dgchat__reply" });
  hook("Stop");
  assert.ok(s.stopPendente, "atividade nova zera o aviso, e o Stop seguinte agenda o idle");
});

test("StopBloqueado antes do Stop faz o Stop seguinte ser ignorado, uma vez só", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("StopBloqueado");
  hook("Stop");
  assert.equal(s.stopPendente, null, "o Stop do mesmo turno não agenda idle");
  assert.equal(s.estado.status, "working");
  hook("Stop");
  assert.ok(s.stopPendente, "o Stop seguinte, sem novo bloqueio, volta ao normal");
});

test("Stop normal, sem StopBloqueado, agenda o idle", async () => {
  const { s, hook } = await novaComRedeCurta(60_000);
  hook("UserPromptSubmit");
  hook("Stop");
  assert.ok(s.stopPendente);
  assert.equal(s.estado.status, "working");
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
  gravarTranscriptDoClaude(idAntigo);
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
  gravarTranscriptDoClaude(s.estado.sessionId!);
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

test("diálogo de confiança de pasta na tela: errored/runner:tela-de-confianca, com a pasta e nenhuma tecla enviada", async () => {
  logarClaude(amb);
  process.env.FAKE_DIALOGO_CONFIANCA = "1";
  try {
    const { s, id } = await nova({ permissionMode: "default" });
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "errored", 8_000, "o runner reconhecer o diálogo de confiança");
    assert.equal(s.estado.statusReason, "runner:tela-de-confianca");
    assert.match(s.estado.error ?? "", /hasTrustDialogAccepted/);
    assert.match(s.estado.error ?? "", new RegExp(`pasta: ${amb.casa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(lerTexto(amb.logDoRunner), /diálogo de confiança de pasta.*Nenhuma tecla foi enviada/s);
    const teclas = lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude" && l.modo === "tecla-no-aviso");
    assert.equal(teclas.length, 0, "nenhum Enter nem texto escrito no PTY");
  } finally {
    delete process.env.FAKE_DIALOGO_CONFIANCA;
  }
});

test("ehDialogoDeConfiancaDoClaude: reconhece o diálogo aberto, ignora o respondido e a citação solta", async () => {
  const { ehDialogoDeConfiancaDoClaude, pastaDoDialogoDeConfianca } = await import("./sessao/telas.js");
  const dialogo =
    "\u001b[2J\u001b[H\u001b[1m/srv/agente/casa\u001b[0m\r\n\r\nIs\u001b[1Cthis\u001b[1Ca\u001b[1Cdirectory\u001b[1Cyou\u001b[1Ccreated\u001b[1Cor\u001b[1Cone\u001b[1Cyou\u001b[1Ctrust?\r\n" +
    "\u276f 1. No, exit\r\n  2. Yes, I trust this folder\r\nEnter to confirm \u00b7 Esc to cancel";
  assert.equal(ehDialogoDeConfiancaDoClaude(dialogo), true);
  assert.equal(pastaDoDialogoDeConfianca(dialogo), "/srv/agente/casa");
  assert.equal(ehDialogoDeConfiancaDoClaude("Do you trust the files in this folder?\r\n1. Yes, proceed\r\n2. No, exit"), true, "texto das versões antigas");
  assert.equal(ehDialogoDeConfiancaDoClaude(dialogo + "\r\n\u276f \r\n? for shortcuts"), false, "já respondido: o prompt voltou");
  assert.equal(ehDialogoDeConfiancaDoClaude(dialogo + "\u001b[2J\u001b[H\u276f"), false, "limpou a tela depois");
  assert.equal(ehDialogoDeConfiancaDoClaude("o usuário perguntou: Is this a directory you created or one you trust?"), false);
  assert.equal(ehDialogoDeConfiancaDoClaude("citando 'Is this a directory you created or one you trust?' e depois " + "texto longo da conversa ".repeat(20)), false);
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

/** Chama enviarComRecibo com a tela mostrando o texto na caixa de composição (os testes trocam `escrever`, então
 *  nada é digitado de verdade e a tela precisa ser montada à mão). */
async function enviarMock(s: InstanceType<typeof Sessao>, texto = "texto-do-teste-1", barra = false) {
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  await alimentarTela(s, `\u001b[2J\u001b[H\u276f ${texto}\r\n? for shortcuts\r\n`);
  return enviarComRecibo(s, { texto, comandoDeBarra: barra, envio: null, proc: s.proc! });
}

const ERRO_SEM_RECIBO = /digitei (\d) Enters e nenhum abriu turno/;
const PASSOS_CURTOS = { reciboVigiaPassosMs: [150, 150] };

test("recibo: turno anterior emitindo PreToolUse com a mensagem presa NÃO esconde o erro; o 2º Enter que entrega confirma", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...PASSOS_CURTOS });
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
    await enviarMock(s);
    assert.equal(enters.length, 3, "os 3 Enters normais saíram e a função já voltou");
    assert.match(lerTexto(amb.logDoRunner).slice(marca), /continuo tentando em segundo plano/);
    await esperarAte(() => ERRO_SEM_RECIBO.test(lerTexto(amb.logDoRunner).slice(marca)), 5_000, "o erro final da vigia");
    clearInterval(ticker);
    assert.match(lerTexto(amb.logDoRunner).slice(marca), /digitei 5 Enters e nenhum abriu turno/);

    // O 2º Enter entrega: o UserPromptSubmit chega depois dele e o runner para por aí.
    enters.length = 0;
    trocar((t) => { enters.push(t); if (enters.length === 2) hook("UserPromptSubmit"); });
    const marca2 = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    assert.equal(enters.length, 2);
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca2), ERRO_SEM_RECIBO);
  } finally {
    trocar(original);
  }
});

test("recibo atrasado: o turno só abre no 4º Enter, a vigia loga 'abriu atrasado' e não dá o ERRO", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...PASSOS_CURTOS });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const enters: string[] = [];
  const trocar = (f: (t: string) => void) => { (s as unknown as { escrever: (t: string) => void }).escrever = f; };
  try {
    trocar((t) => {
      enters.push(t);
      if (enters.length === 4) s.receberHook({ agentId: s.id, event: "UserPromptSubmit", nonce: s.nonce ?? undefined });
    });
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    await esperarAte(() => /abriu atrasado/.test(lerTexto(amb.logDoRunner).slice(marca)), 5_000, "o log do turno atrasado");
    // A sessão fica em working depois do hook e o 5º passo não bate mais nada.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(enters.length, 4, "3 normais + 1 atrasado");
    assert.match(lerTexto(amb.logDoRunner).slice(marca), /o Enter atrasado 4\/5/);
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca), ERRO_SEM_RECIBO);
  } finally {
    trocar(original);
  }
});

test("recibo atrasado: o recibo chega sozinho logo depois do 3º Enter, sem Enter extra e sem ERRO", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...PASSOS_CURTOS });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const enters: string[] = [];
  const trocar = (f: (t: string) => void) => { (s as unknown as { escrever: (t: string) => void }).escrever = f; };
  try {
    trocar((t) => {
      enters.push(t);
      // Aceita 80ms depois da janela do 3º Enter (reciboMs), sozinho.
      if (enters.length === 3) setTimeout(() => s.receberHook({ agentId: s.id, event: "UserPromptSubmit", nonce: s.nonce ?? undefined }), s.motor.reciboMs + 80);
    });
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    await esperarAte(() => /abriu atrasado/.test(lerTexto(amb.logDoRunner).slice(marca)), 5_000, "o log do turno atrasado");
    assert.equal(enters.length, 3, "nenhum Enter a mais");
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca), ERRO_SEM_RECIBO);
  } finally {
    trocar(original);
  }
});

test("recibo atrasado: parar a sessão durante a vigia não escreve mais Enter", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova({}, { reciboVigiaPassosMs: [400, 400] });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const enters: string[] = [];
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => { enters.push(t); };
  try {
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    assert.equal(enters.length, 3);
    s.parar("teste: parada durante a vigia");
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
    (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => { enters.push(t); };
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(enters.length, 3, "nenhum Enter depois da parada");
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca), ERRO_SEM_RECIBO);
  } finally {
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
  }
});

test("recibo atrasado: outra escrita no terminal durante a vigia cancela os Enters atrasados", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova({}, { reciboVigiaPassosMs: [300, 300] });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const escritas: string[] = [];
  // Conta como o escrever de verdade: toda escrita soma em entradasManuais.
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => { escritas.push(t); s.entradasManuais += 1; };
  try {
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    assert.equal(escritas.length, 3);
    // O dono limpa a caixa pelo terminal e começa outro texto, sem enviar.
    s.escrever("\u0015");
    s.escrever("rascunho ainda sem confirmacao");
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(escritas.at(-1), "rascunho ainda sem confirmacao", "nenhum Enter depois do rascunho");
    await esperarAte(() => /parei de insistir no Enter/.test(lerTexto(amb.logDoRunner).slice(marca)), 3_000, "o log da desistência");
    assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(marca), ERRO_SEM_RECIBO);
  } finally {
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
  }
});

test("recibo atrasado: escrita no terminal enquanto o 3º Enter espera o recibo também cancela a vigia", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova({}, { reciboVigiaPassosMs: [300, 300] });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const escritas: string[] = [];
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    escritas.push(t);
    s.entradasManuais += 1;
    // Logo depois do 3º Enter, o dono limpa a caixa e começa outro texto, ainda durante a espera do recibo.
    if (t === "\r" && escritas.filter((e) => e === "\r").length === 3) {
      setTimeout(() => {
        s.escrever("\u0015");
        s.escrever("rascunho ainda sem confirmacao");
      }, 10);
    }
  };
  try {
    const marca = lerTexto(amb.logDoRunner).length;
    await enviarMock(s);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(escritas.at(-1), "rascunho ainda sem confirmacao", "nenhum Enter depois do rascunho");
    await esperarAte(() => /parei de insistir no Enter/.test(lerTexto(amb.logDoRunner).slice(marca)), 3_000, "o log da desistência");
  } finally {
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
  }
});

test("recibo atrasado: terminal trocado durante a espera do 3º Enter não recebe Enter da vigia", async () => {
  logarClaude(amb);
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  const { s } = await nova({}, { reciboVigiaPassosMs: [300, 300] });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const original = s.escrever.bind(s);
  const procOriginal = s.proc;
  const escritas: Array<{ t: string; proc: unknown }> = [];
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    escritas.push({ t, proc: s.proc });
    // Logo depois do 3º Enter, o terminal é trocado por outro (como num reinício), ainda durante a espera.
    if (t === "\r" && escritas.length === 3) {
      setTimeout(() => {
        (s as unknown as { proc: unknown }).proc = { trocado: true };
      }, 10);
    }
  };
  try {
    await enviarMock(s);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(escritas.length, 3, "nenhuma tecla depois da troca");
    assert.ok(escritas.every((e) => e.proc === procOriginal), "só o terminal original recebeu Enter");
    assert.equal(s.vigiaDoRecibo, null, "a vigia não foi armada para o terminal novo");
  } finally {
    (s as unknown as { proc: unknown }).proc = procOriginal;
    (s as unknown as { escrever: (t: string) => void }).escrever = original;
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
    await enviarMock(s, "/compact meu-resumo-1", true);
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
  gravarTranscriptDoClaude(sessionId);
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
  gravarTranscriptDoClaude(sessionId);
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
  gravarTranscriptDoClaude(s.estado.sessionId!);
  s.parar("teste");
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  assert.ok(lerTexto(amb.logDoRunner).includes("sem que a credencial tenha sido renovada"));
  await dormir(1_000);
  assert.equal(recados(), antes, "nenhum recado novo");
});

// --- hook: nunca segura o turno ---------------------------------------------
test("runner-hook.mjs: stdin que nunca fecha não trava (termina em menos de 3s) e ainda manda o POST", async () => {
  const { spawn } = await import("node:child_process");
  const http = await import("node:http");
  const { HOOK_HANDLER_SOURCE } = await import("./hook-handler-source.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
  const arq = path.join(dir, "runner-hook.mjs");
  fs.writeFileSync(arq, HOOK_HANDLER_SOURCE);
  const recebidos: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { recebidos.push({ url: req.url, corpo: JSON.parse(b) }); res.end("{}"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const porta = (srv.address() as { port: number }).port;
  const rodar = (entrada: string | null) => new Promise<number>((resolve) => {
    const ini = Date.now();
    const p = spawn(process.execPath, [arq, "--agent", "a1", "--port", String(porta), "--nonce", "n1", "--event", "PreToolUse"], { stdio: ["pipe", "ignore", "ignore"] });
    if (entrada !== null) { p.stdin.write(entrada); p.stdin.end(); } // null = stdin aberto para sempre
    p.on("exit", (code) => { assert.equal(code, 0); resolve(Date.now() - ini); });
  });
  try {
    const trava = await rodar(null);
    assert.ok(trava < 3000, `o hook levou ${trava}ms com stdin aberto`);
    assert.equal(recebidos.length, 1, "o POST sai mesmo sem ler o stdin");
    assert.equal(recebidos[0].url, "/api/agent-hook");
    assert.equal(recebidos[0].corpo.event, "PreToolUse");
    assert.equal(recebidos[0].corpo.toolName, null);

    await rodar(JSON.stringify({ cwd: "/x", session_id: "s1", tool_name: "Bash", source: "startup" }));
    assert.deepEqual(recebidos[1].corpo, { agentId: "a1", nonce: "n1", event: "PreToolUse", cwd: "/x", sessionId: "s1", toolName: "Bash", toolUseId: null, source: "startup", error: null, lastAssistantMessage: null });
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- pedido digitado sem recibo (incidente de 18/11/2026) ---------------------------------------------------

const promptsDe = (texto: string) =>
  lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude" && l.modo === "prompt" && l.texto === texto).length;
const filaEmDisco = (s: { arquivoDaFila: string }): Array<Record<string, unknown>> => {
  try {
    return JSON.parse(fs.readFileSync(s.arquivoDaFila, "utf8")).itens;
  } catch {
    return [];
  }
};
const matarOTerminal = (s: { proc: unknown }) => (s.proc as { kill(): void }).kill();
const REDE_CURTA = { reciboVigiaPassosMs: [300, 300] };

test("sem recibo: o texto digitado fica pendente (também em disco); com o terminal morto ele fica retido e NUNCA é digitado de novo", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
  const sessionId = s.estado.sessionId!;
  s.enfileirarQuandoOcioso("pedido-que-some-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 25_000, "o aviso de pedido sem recibo");
  assert.equal(promptsDe("pedido-que-some-1"), 1, "digitado uma vez no primeiro terminal");
  assert.equal(s.filaQuandoIdle.length, 0);
  assert.equal(s.semRecibo.length, 1, "pendente em memória");
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.digitado]), [["pedido-que-some-1", true]], "pendente em disco, marcado como digitado");

  // O terminal morre sozinho (como o runner reiniciado): o pedido fica retido, não volta para a fila.
  gravarTranscriptDoClaude(sessionId);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000, "o terminal morrer");
  assert.equal(s.semRecibo.length, 0);
  assert.equal(s.filaQuandoIdle.length, 0, "não volta para a fila");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-que-some-1", true]]);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-que-some-1", true]]);
  const log = lerTexto(amb.logDoRunner).slice(marcaDoLog);
  assert.match(log, /ficou retido sem confirmação: o terminal saiu com código .* antes do recibo/);
  assert.match(log, /Não o enviei de novo sozinho/);
  assert.match(log, /O que fazer: conferir na conversa do agente/);
  assert.doesNotMatch(log, /ficou retido[^\n]*pedido-que-some-1/, "o log não traz o texto do pedido");

  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(2_000);
  assert.equal(promptsDe("pedido-que-some-1"), 1, "nunca digitado de novo");
  assert.equal(s.retidos.length, 1);
});

test("sem recibo: texto COM recibo nunca é reentregue, mesmo com o terminal morto e o respawn", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const sessionId = s.estado.sessionId!;
  s.enfileirarQuandoOcioso("pedido-com-recibo-1");
  await esperarAte(() => promptsDe("pedido-com-recibo-1") === 1, 25_000, "o pedido ser digitado");
  await esperarAte(() => s.semRecibo.length === 0 && filaEmDisco(s).length === 0 && !s.soltandoFila, 8_000, "o recibo tirar o pedido do pendente e do disco");
  gravarTranscriptDoClaude(sessionId);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(s.filaQuandoIdle.length, 0);
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(7_000);
  assert.equal(promptsDe("pedido-com-recibo-1"), 1, "nada foi repetido");
});

test("sem recibo: recibo atrasado (depois dos 3 Enters, com a vigia armada) tira o pedido do pendente e não duplica", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_ACEITA_APOS_MS = "5000";
  const { s } = await nova({}, { reciboVigiaPassosMs: [1_500, 1_500, 10_000] });
  await s.subir("nova");
  delete process.env.FAKE_ACEITA_APOS_MS;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const sessionId = s.estado.sessionId!;
  s.enfileirarQuandoOcioso("pedido-atrasado-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 25_000, "o aviso de pedido sem recibo");
  assert.equal(s.semRecibo.length, 1);
  await esperarAte(() => /o recibo do texto digitado \(\d+ caracteres\) chegou atrasado/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 10_000, "o recibo atrasado");
  assert.equal(s.semRecibo.length, 0);
  await esperarAte(() => filaEmDisco(s).length === 0, 5_000, "o disco limpar");
  gravarTranscriptDoClaude(sessionId);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(s.filaQuandoIdle.length, 0, "o pedido não volta para a fila");
  await s.subir("retomar");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await dormir(7_000);
  assert.equal(promptsDe("pedido-atrasado-1"), 1, "nunca duplicado");
});

test("sem recibo: sem SessionStart, o Claude que aceita o Enter 5 s depois ainda tem o recibo esperado, os 'Enter n/3' no log e a vigia armada", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_SESSIONSTART_MS = "600000";
  process.env.FAKE_PROMPT_PRONTO = "1";
  process.env.FAKE_ACEITA_APOS_MS = "5000";
  const { s } = await nova({}, { reciboVigiaPassosMs: [1_000, 1_000, 10_000], prazoSemHooksMs: 40_000 });
  await s.subir("nova");
  delete process.env.FAKE_SESSIONSTART_MS;
  delete process.env.FAKE_PROMPT_PRONTO;
  delete process.env.FAKE_ACEITA_APOS_MS;
  await esperarAte(() => s.estado.status === "idle", 8_000, "o prompt na tela virar idle");
  assert.equal(s.hooksVivos, false, "nenhum hook chegou");
  assert.match(s.estado.statusReason!, /sem hooks/);
  const marca = lerTexto(amb.logDoRunner).length;
  const recebido = await s.digitarEEnviar("pedido-boot-lento-1");
  assert.equal(recebido, false, "os 3 Enters passaram sem recibo");
  const log = lerTexto(amb.logDoRunner).slice(marca);
  assert.match(log, /o Enter 1\/3 não virou turno/);
  assert.match(log, /tentativa 3\/3 sem recibo/);
  assert.match(log, /continuo tentando em segundo plano/);
  await esperarAte(() => /o turno abriu atrasado/.test(lerTexto(amb.logDoRunner).slice(marca)), 10_000, "o turno atrasado");
  assert.equal(s.hooksVivos, true);
});

test("boot: sem SessionStart e sem o prompt na tela, o idle só sai no teto, com o aviso no log", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_SEM_HOOKS = "1";
  const { s } = await nova({}, { bootTimerMs: 300, tetoBootSemSinalMs: 2_000 });
  await s.subir("nova");
  delete process.env.FAKE_SEM_HOOKS;
  await dormir(1_200);
  assert.equal(s.estado.status, "spawning", "passou do boot-timer, mas sem sinal a fila não é solta");
  await esperarAte(() => s.estado.status === "idle", 5_000, "o teto soltar");
  assert.match(s.estado.statusReason!, /boot-timer 2s sem hook/);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /nenhum hook chegou em \d+s desde o spawn e a tela não mostra o prompt pronto/);
});

test("boot: sem SessionStart mas com o prompt pronto na tela, vira idle na hora, sem esperar o teto", async () => {
  logarClaude(amb);
  process.env.FAKE_SESSIONSTART_MS = "600000";
  process.env.FAKE_PROMPT_PRONTO = "1";
  const { s } = await nova({}, { bootTimerMs: 300, tetoBootSemSinalMs: 20_000 });
  await s.subir("nova");
  delete process.env.FAKE_SESSIONSTART_MS;
  delete process.env.FAKE_PROMPT_PRONTO;
  await esperarAte(() => s.estado.status === "idle", 4_000, "o prompt na tela virar idle");
  assert.match(s.estado.statusReason!, /\? for shortcuts/);
});

test("esperarRecibo: sem hook, nem antes nem depois do prazo o recibo é dado por bom", async () => {
  const { esperarRecibo } = await import("./sessao/digitacao.js");
  const falso = (extra: Record<string, unknown>) =>
    ({ hooksVivos: false, motor: { reciboPorRollout: false }, promptsAceitos: 0, compactsIniciados: 0, prazoSemHooksMs: 60_000, spawnEm: Date.now(), ...extra }) as never;
  assert.equal(await esperarRecibo(falso({}), 0, 300), false, "boot recente, hook ainda não chegou: não é 'agente sem hooks'");
  assert.equal(await esperarRecibo(falso({ spawnEm: Date.now() - 61_000 }), 0, 300), false, "passou do prazo sem nenhum hook: sem recibo não há entrega comprovada");
  assert.equal(await esperarRecibo(falso({ spawnEm: Date.now() - 100, prazoSemHooksMs: 400 }), 0, 700), false, "o prazo vence durante a espera e continua sem recibo");
});

test("fila: devolverSemRecibo retém tudo o que estava sem recibo; recuperarDoDisco retém os digitados e os incertos (nunca digita de novo)", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  const { devolverSemRecibo } = await import("./sessao/fila.js");
  const { gravarFila } = await import("./fila-ocioso.js");
  const { s } = await nova();
  s.filaQuandoIdle.push({ texto: "ja-na-fila", em: 1 });
  s.semRecibo.push(
    { item: { texto: "com-enter", em: 2, digitado: true, id: "aaaa1111" }, promptsAntes: 0, aguardando: true, enterEscrito: true, interrompido: false },
    { item: { texto: "no-meio", em: 3, digitado: true, id: "bbbb2222" }, promptsAntes: 0, aguardando: false, enterEscrito: false, escreveuAlgo: true, interrompido: false },
  );
  devolverSemRecibo(s, "teste");
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["ja-na-fila"], "nada volta para a fila");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["com-enter", true], ["no-meio", true]]);
  const log = lerTexto(amb.logDoRunner).slice(marcaDoLog);
  assert.match(log, /um pedido de 7 caracteres \(id bbbb2222\) ficou retido sem confirmação: a digitação foi interrompida no meio/);
  assert.doesNotMatch(log, /no-meio/, "o log nunca traz o texto do pedido");
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["ja-na-fila", undefined], ["com-enter", true], ["no-meio", true]]);

  // No boot: o retido continua retido, o digitado vira retido e o resto fica como estava.
  const id = "sess-disco";
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, "fila-ocioso", `${id}.json`);
  gravarFila(arquivo, [
    { texto: "retido-antigo", em: 2, digitado: true, incerto: true },
    { texto: "nunca-digitado", em: 3 },
    { texto: "digitado-sem-recibo", em: 1, digitado: true },
  ], "teste");
  const { s: s2 } = await nova({}, { idFixo: id });
  assert.deepEqual(s2.filaQuandoIdle.map((i) => i.texto), ["nunca-digitado"]);
  assert.deepEqual(s2.retidos.map((i) => i.texto), ["retido-antigo", "digitado-sem-recibo"]);
  assert.deepEqual(filaEmDisco(s2).map((i) => [i.texto, i.incerto]), [["nunca-digitado", undefined], ["retido-antigo", true], ["digitado-sem-recibo", true]]);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /tinha sido digitado sem recibo antes do runner parar.*Não o envio de novo sozinho/);
});

/** Sobe uma sessão cujo CLI nunca confirma o pedido, enfileira `texto` e espera o aviso de pedido sem recibo. */
async function sessaoComPedidoSemRecibo(texto: string, opcoes: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s, id } = await nova(config, { ...REDE_CURTA, ...opcoes });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
  const sessionId = s.estado.sessionId!;
  s.enfileirarQuandoOcioso(texto);
  // Confere também o estado desta sessão: o aviso no log compartilhado pode vir de uma sessão de um teste anterior.
  await esperarAte(
    () => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)) && (s.semRecibo.some((e) => e.aguardando) || s.retidos.length > 0),
    25_000,
    "o aviso de pedido sem recibo",
  );
  return { s, id, sessionId, marcaDoLog };
}

test("terminal que sai com o pedido sem recibo: fica retido, a fila segue com os próximos e o retido nunca é digitado", async () => {
  const { s, marcaDoLog } = await sessaoComPedidoSemRecibo("pedido-retido-1");
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  s.enfileirarQuandoOcioso("proximo-pedido-1");
  await s.subir("nova");
  await esperarAte(() => promptsDe("proximo-pedido-1") === 1, 25_000, "o pedido seguinte sair mesmo com o retido");
  assert.equal(promptsDe("pedido-retido-1"), 1, "o retido não foi enviado de novo");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-retido-1", true]]);
  await esperarAte(() => s.semRecibo.length === 0 && !s.soltandoFila, 8_000);
  assert.ok(filaEmDisco(s).some((i) => i.texto === "pedido-retido-1" && i.incerto === true), "o retido fica no arquivo, marcado");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /um pedido de 15 caracteres \(id [0-9a-f]{8}\) ficou retido sem confirmação/);
});

test("boot com item digitado no arquivo: fica retido (incerto), nunca entra no terminal, e os não digitados saem", async () => {
  const { gravarFila } = await import("./fila-ocioso.js");
  logarClaude(amb);
  const id = "sess-boot-digitado";
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  gravarFila(path.join(pasta, "fila-ocioso", `${id}.json`), [
    { texto: "veio-digitado-1", em: 1, digitado: true },
    { texto: "veio-barra-digitada", em: 2, digitado: true },
    { texto: "normal-1", em: 4 },
  ], "teste");
  const { s } = await nova({}, { idFixo: id });
  await s.subir("nova");
  await esperarAte(() => promptsDe("normal-1") === 1, 25_000, "o pedido normal sair");
  assert.equal(promptsDe("veio-digitado-1"), 0);
  assert.equal(promptsDe("veio-barra-digitada"), 0);
  assert.deepEqual(s.retidos.map((i) => i.texto).sort(), ["veio-barra-digitada", "veio-digitado-1"]);
  await esperarAte(() => s.semRecibo.length === 0 && !s.soltandoFila, 8_000);
  assert.ok(filaEmDisco(s).filter((i) => i.incerto === true).length === 2);
});

test("falha ao gravar a fila: nada é digitado, o pedido volta para a frente, o log diz o arquivo e o que fazer; com o disco de volta ele sai", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  const { talvezSoltarFila } = await import("./sessao/fila.js");
  logarClaude(amb);
  const { s, pasta } = await nova({}, { reintentoTelaBloqueadaMs: 300 });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const certo = s.arquivoDaFila;
  const arquivoQueEBloqueia = path.join(pasta, "bloqueio");
  fs.writeFileSync(arquivoQueEBloqueia, "x"); // um arquivo no lugar da pasta: mkdir/gravação falham (ENOTDIR), até como root
  s.soltandoFila = true; // segura a fila enquanto o disco ainda está bom, para o pedido entrar
  assert.equal(s.enfileirarQuandoOcioso("pedido-sem-disco-1"), "enfileirado");
  (s as unknown as { arquivoDaFila: string }).arquivoDaFila = path.join(arquivoQueEBloqueia, "fila.json");
  s.soltandoFila = false;
  talvezSoltarFila(s);
  await esperarAte(() => /não digitei o pedido .* porque não consegui gravar o arquivo da fila/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 8_000, "o aviso");
  await dormir(800);
  assert.equal(promptsDe("pedido-sem-disco-1"), 0, "nada foi digitado");
  assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [["pedido-sem-disco-1", undefined]], "continua na frente da fila, sem a marca");
  assert.equal(s.semRecibo.length, 0);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /conferir espaço em disco/);
  (s as unknown as { arquivoDaFila: string }).arquivoDaFila = certo;
  await esperarAte(() => promptsDe("pedido-sem-disco-1") === 1, 15_000, "o pedido sair quando o disco voltou");
});

test("comando de barra: é gravado como digitado ANTES de ser digitado; interrompido pelo terminal, fica retido; terminando, sai do disco", async () => {
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  let visto: Array<Record<string, unknown>> | null = null;
  (s as unknown as { digitarEEnviar: (t: string, f: boolean, e: { escreveuAlgo?: boolean }) => Promise<boolean> }).digitarEEnviar = (_t, _f, envio) => {
    visto = filaEmDisco(s);
    envio.escreveuAlgo = true; // já escreveu parte do comando
    return new Promise<boolean>(() => {}); // a digitação não termina: o terminal vai cair no meio
  };
  s.enfileirarQuandoOcioso("/clear");
  await esperarAte(() => visto !== null, 8_000, "a digitação começar");
  assert.deepEqual((visto as unknown as Array<Record<string, unknown>>).map((i) => [i.texto, i.digitado]), [["/clear", true]], "já estava no disco como digitado");
  assert.equal(s.semRecibo.length, 0, "a barra não entra em semRecibo");
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["/clear", true]]);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["/clear", true]]);
});

test("comando de barra que termina: sai do disco (não fica digitado para sempre)", async () => {
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("/status");
  await esperarAte(() => promptsDe("/status") === 1, 25_000, "a barra ser digitada");
  await esperarAte(() => !s.soltandoFila && filaEmDisco(s).length === 0, 10_000, "o disco limpar");
  assert.equal(s.retidos.length, 0);
});

test("vigia do Enter esgotada sem recibo: o pedido vai para retidos (incerto) e a digitação do terminal fica suspensa até recibo ou turno novo", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  process.env.FAKE_IGNORA_ENTER = "5"; // os 5 Enters do runner (3 normais + 2 da vigia) são engolidos: o texto continua na caixa, a vigia esgota
  const { s } = await sessaoComPedidoSemRecibo("pedido-vigia-esgotada-1");
  delete process.env.FAKE_IGNORA_ENTER;
  await esperarAte(() => s.retidos.length === 1, 15_000, "a vigia esgotar e reter o pedido");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /nenhum abriu turno: o texto ficou escrito na caixa/);
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-vigia-esgotada-1", true]]);
  // O texto pode ter ficado na caixa: a digitação do terminal fica suspensa até um recibo ou um turno novo.
  s.enfileirarQuandoOcioso("depois-da-vigia-1");
  await dormir(2_500);
  assert.equal(promptsDe("depois-da-vigia-1"), 0, "o segundo não é digitado por cima do texto que ficou na caixa");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["depois-da-vigia-1"]);
  const { confirmarRecibos, talvezSoltarFila } = await import("./sessao/fila.js");
  s.promptsAceitos += 1; // chegou um recibo: a caixa ainda tem o texto, então a suspensão continua
  confirmarRecibos(s);
  talvezSoltarFila(s);
  await dormir(1_000);
  assert.notEqual(s.digitacaoSuspensaEm, null);
  s.escrever("\r"); // o dono dá o Enter: a caixa fica vazia e a fila é solta no idle
  await esperarAte(() => promptsDe("pedido-vigia-esgotada-1") === 1, 5_000, "o Enter do dono");
  talvezSoltarFila(s);
  await esperarAte(() => promptsDe("depois-da-vigia-1") === 1, 25_000, "o próximo sair com a caixa vazia");
});

test("um envio sem recibo por vez: o próximo espera o pendente; o recibo confirma só o pendente e NÃO solta a fila (só o próximo idle depois do turno)", async () => {
  const { s } = await sessaoComPedidoSemRecibo("primeiro-pendente-1", { reciboVigiaPassosMs: [60_000] });
  s.enfileirarQuandoOcioso("segundo-pedido-1");
  await dormir(2_500);
  assert.equal(promptsDe("segundo-pedido-1"), 0, "a fila não soltou o segundo enquanto o primeiro não tem recibo");
  assert.equal(s.semRecibo.length, 1);
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["segundo-pedido-1"]);
  // O recibo chega (turno aceito): o pendente sai, mas o segundo só sai no próximo idle.
  const { confirmarRecibos, talvezSoltarFila } = await import("./sessao/fila.js");
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.equal(s.semRecibo.some((e) => e.item.texto === "primeiro-pendente-1"), false, "o primeiro saiu do pendente");
  await dormir(1_500);
  assert.equal(promptsDe("segundo-pedido-1"), 0, "confirmar o recibo não solta a fila");
  talvezSoltarFila(s); // o idle depois do turno
  await esperarAte(() => promptsDe("segundo-pedido-1") === 1, 25_000, "o segundo sair no idle");
});

test("recibo que chega ANTES do Enter do pendente não tira nada (é de outro turno)", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  const { confirmarRecibos } = await import("./sessao/fila.js");
  const { s } = await nova();
  const item = { texto: "digitando-ainda", em: 1, digitado: true, id: "cccc3333" };
  s.semRecibo.push({ item, promptsAntes: 0, aguardando: false, enterEscrito: false, interrompido: false });
  s.promptsAceitos = 1; // o dono deu Enter num turno dele
  confirmarRecibos(s);
  assert.equal(s.semRecibo.length, 1, "o pendente continua");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /recibo antes do Enter do pedido cccc3333: é de outro turno/);
  // Depois do Enter dele, o contador de referência é o de ESSE momento: o recibo antigo não vale.
  s.semRecibo[0]!.enterEscrito = true;
  s.semRecibo[0]!.promptsAntes = s.promptsAceitos;
  confirmarRecibos(s);
  assert.equal(s.semRecibo.length, 1, "o recibo antigo não confirma");
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.equal(s.semRecibo.length, 0, "o recibo posterior ao Enter confirma");
});

test("antes de repetir o Enter, outra escrita no terminal para a repetição, deixa o pedido retido e SUSPENDE a digitação do próximo até o dono dar o Enter", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  const { confirmarRecibos, talvezSoltarFila } = await import("./sessao/fila.js");
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("pedido-com-rascunho-1");
  await esperarAte(() => promptsDe("pedido-com-rascunho-1") === 1, 25_000, "o primeiro Enter");
  s.enfileirarQuandoOcioso("segundo-com-rascunho-1");
  s.escrever("rascunho-do-dono"); // alguém digita no terminal enquanto se espera o recibo
  await esperarAte(() => s.retidos.length === 1, 10_000, "o pedido ficar retido");
  await dormir(2_500);
  assert.equal(promptsDe("rascunho-do-dono"), 0, "nenhum Enter a mais mandou o rascunho");
  assert.equal(promptsDe("pedido-com-rascunho-1"), 1);
  assert.equal(promptsDe("segundo-com-rascunho-1"), 0, "o segundo não é digitado por cima do rascunho");
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["segundo-com-rascunho-1"]);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /parei de repetir o Enter .* outra escrita no terminal/);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /a digitação automática dos próximos pedidos fica suspensa/);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["segundo-com-rascunho-1", undefined], ["pedido-com-rascunho-1", true]]);
  // O recibo sozinho não encerra a suspensão (a caixa ainda tem o rascunho); o Enter do dono esvazia a caixa e a fila sai, só com o texto dela.
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.notEqual(s.digitacaoSuspensaEm, null, "o recibo não limpa a suspensão");
  s.escrever("\r");
  await esperarAte(() => promptsDe("rascunho-do-dono") === 1, 5_000, "o Enter do dono");
  await esperarAte(() => promptsDe("segundo-com-rascunho-1") === 1, 25_000, "o segundo sair com a caixa vazia");
  assert.equal(s.digitacaoSuspensaEm, null);
});

test("SIGTERM durante a espera do recibo: o arquivo que o próximo processo carregaria tem UMA cópia do pedido", async () => {
  const { carregarFila } = await import("./fila-ocioso.js");
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("pedido-no-sigterm-1");
  await esperarAte(() => promptsDe("pedido-no-sigterm-1") === 1 && s.soltandoFila, 25_000, "o Enter escrito, ainda esperando o recibo");
  s.parar("SIGTERM de teste");
  const carregado = carregarFila(s.arquivoDaFila, "teste");
  assert.deepEqual(carregado.map((i) => [i.texto, i.digitado, i.incerto]), [["pedido-no-sigterm-1", true, true]], "uma cópia só, retida como incerta");
  assert.equal(s.itemEmVoo, null, "a posse passou para a fila");
});

test("o estado de digitado vai para o disco ANTES da primeira escrita no terminal", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  let visto: Array<Record<string, unknown>> | null = null;
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (x: string) => void }).escrever = (x: string) => {
    if (visto === null && s.itemEmVoo) visto = filaEmDisco(s);
    original(x);
  };
  s.enfileirarQuandoOcioso("pedido-gravado-antes-1");
  await esperarAte(() => visto !== null, 25_000, "a primeira escrita");
  assert.deepEqual((visto as unknown as Array<Record<string, unknown>>).map((i) => [i.texto, i.digitado]), [["pedido-gravado-antes-1", true]]);
  await esperarAte(() => s.semRecibo.length === 0 && filaEmDisco(s).length === 0, 8_000, "o recibo limpar o disco");
});

test("hooksVivos é zerado a cada spawn: dois spawns seguidos no mesmo objeto Sessao", async () => {
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle" && s.hooksVivos, 8_000, "o primeiro terminal mandar hooks");
  s.parar("teste");
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(s.hooksVivos, true, "parar não mexe nisso");
  process.env.FAKE_SEM_HOOKS = "1";
  await s.subir("nova");
  delete process.env.FAKE_SEM_HOOKS;
  assert.equal(s.hooksVivos, false, "o segundo spawn não herda a prova do primeiro");
  assert.equal(s.estado.hookActive, false);
});

test("retomada: o transcript é procurado na pasta de configuração do motor ($HOME/.claude quando não há CLAUDE_CONFIG_DIR)", async () => {
  logarClaude(amb);
  const casa = fs.mkdtempSync(path.join(amb.raiz, "casa-motor-"));
  fs.mkdirSync(path.join(casa, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(casa, ".claude", ".credentials.json"), "{}");
  const { s, id } = await nova({ envExtra: { HOME: casa, CLAUDE_CONFIG_DIR: "" } });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const sessionId = s.estado.sessionId!;
  const pasta = path.join(casa, ".claude", "projects", "p");
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${sessionId}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "oi" } }) + "\n");
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => entradasDe(id).length >= 2, 5_000);
  assert.equal(entradasDe(id)[1].argv[0], "--resume");
});

test("retomada: inspeção do disco inconclusiva (erro de leitura) mantém o --resume em vez de abandonar a conversa", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  const casa = fs.mkdtempSync(path.join(amb.raiz, "casa-ilegivel-"));
  fs.writeFileSync(path.join(casa, ".credentials.json"), "{}");
  fs.writeFileSync(path.join(casa, "projects"), "nao e uma pasta"); // readdir dá ENOTDIR: não é "não existe"
  const { s, id } = await nova({ envExtra: { CLAUDE_CONFIG_DIR: casa } });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  matarOTerminal(s);
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  assert.equal(await s.subir("retomar"), "retomar");
  await esperarAte(() => entradasDe(id).length >= 2, 5_000);
  assert.equal(entradasDe(id)[1].argv[0], "--resume");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /não consegui conferir se o histórico da sessão .* está no disco .*mantenho o --resume/);
});

test("deriva de sessão: evento e source desconhecidos do hook viram 'outro' no log (nada do hook entra no log)", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const nonce = s.nonce ?? undefined;
  s.receberHook({ agentId: s.id, event: "EventoInventado\nINJETADO", nonce, sessionId: "22222222-2222-4222-8222-222222222222", source: "origem\nINJETADA" });
  const log = lerTexto(amb.logDoRunner).slice(marcaDoLog);
  assert.match(log, /\(evento outro, source outro\)/);
  assert.doesNotMatch(log, /INJETAD/);
});

test("retomada: id sem transcript no disco sobe a sessão NOVA direto (sem o --resume que falha) e o pedido sem recibo fica retido, sem ser digitado de novo", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s, id } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const idAntigo = s.estado.sessionId!;
  s.enfileirarQuandoOcioso("pedido-sem-transcript-1");
  await esperarAte(() => /ainda não confirmou que aceitou o pedido/.test(lerTexto(amb.logDoRunner).slice(marcaDoLog)), 25_000);
  matarOTerminal(s); // a sessão nunca gravou transcript: não há o que retomar
  await esperarAte(() => s.estado.status === "resumable", 8_000);
  const inicio = Date.now();
  assert.equal(await s.subir("retomar"), "nova");
  assert.notEqual(s.estado.sessionId, idAntigo);
  assert.equal(s.estado.previousSessionId, idAntigo);
  await esperarAte(() => entradasDe(id).length >= 2, 5_000, "o CLI reabrir");
  assert.deepEqual(entradasDe(id)[1].argv.slice(0, 2), ["--session-id", s.estado.sessionId]);
  assert.equal(entradasDe(id)[1].argv.includes("--resume"), false, "nem tentou o --resume");
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), new RegExp(`não retomo a sessão ${idAntigo}: o histórico dela não está no disco`));
  assert.doesNotMatch(lerTexto(amb.logDoRunner).slice(-4_000), /não abriu: o claude saiu com código/);
  assert.ok(Date.now() - inicio < 30_000);
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-sem-transcript-1", true]]);
  await dormir(1_500);
  assert.equal(promptsDe("pedido-sem-transcript-1"), 1, "nunca digitado de novo");
});

test("deriva de sessão: o log de 'a sessão viva mudou por dentro' traz o evento e o source do hook", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const nonce = s.nonce ?? undefined;
  s.receberHook({ agentId: s.id, event: "SessionStart", nonce, sessionId: "11111111-1111-4111-8111-111111111111", source: "resume" });
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /a sessão viva mudou por dentro: .* -> 11111111-1111-4111-8111-111111111111 \(evento SessionStart, source resume\)/);
});

// --- Enter só com o texto na caixa, envio amarrado ao terminal e ao item ------------------------------------

const modosDoFake = (modo: string) => lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude" && l.modo === modo).length;

test("repetição do Enter: depois do primeiro Enter abre um diálogo de permissão; nenhum Enter extra é escrito e o pedido fica retido", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  process.env.FAKE_DIALOGO_APOS_ENTER = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  delete process.env.FAKE_DIALOGO_APOS_ENTER;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const antesDosEnters = modosDoFake("enter-no-dialogo");
  const antesDasTeclas = modosDoFake("tecla-no-dialogo");
  s.enfileirarQuandoOcioso("pedido-com-dialogo-1");
  await esperarAte(() => s.retidos.length === 1, 25_000, "o pedido ficar retido");
  await dormir(1_500);
  assert.equal(modosDoFake("enter-no-dialogo") - antesDosEnters, 1, "só o primeiro Enter chegou ao terminal");
  assert.equal(modosDoFake("tecla-no-dialogo") - antesDasTeclas, 0, "nenhum Enter extra caiu dentro do diálogo");
  assert.equal(promptsDe("pedido-com-dialogo-1"), 0);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-com-dialogo-1", true]]);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /parei de repetir o Enter .* a tela não mostra o mesmo texto na caixa de composição/);
  assert.notEqual(s.digitacaoSuspensaEm, null, "com diálogo aberto a digitação do terminal fica suspensa");
});

test("estadoDaCaixa: mesmo texto, caixa vazia, diálogo e texto diferente", async () => {
  const { estadoDaCaixa, caixaVaziaNaTela } = await import("./sessao/telas.js");
  const caixa = (t: string) => `\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ ${t}\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n`;
  assert.equal(estadoDaCaixa(caixa("faça o relatório de vendas do mês passado por favor"), "faça o relatório de vendas do mês passado por favor"), "mesmo-texto");
  assert.equal(estadoDaCaixa(caixa("faça o relatório de vendas do mês passado por favor"), "faça o relatório de vendas do\nmês passado por favor"), "mesmo-texto", "quebra de linha não atrapalha");
  assert.equal(estadoDaCaixa(caixa(""), "qualquer pedido"), "vazia");
  assert.equal(estadoDaCaixa(caixa("outro texto qualquer"), "qualquer pedido"), "indeterminada");
  assert.equal(estadoDaCaixa("tela sem nada reconhecível", "qualquer pedido"), "indeterminada");
  const comDialogo = caixa("pedido-x") + " Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n Esc to cancel\r\n";
  assert.equal(estadoDaCaixa(comDialogo, "pedido-x"), "indeterminada");
  assert.equal(caixaVaziaNaTela(caixa("")), true);
  assert.equal(caixaVaziaNaTela(caixa("? posso apagar a pasta de vendas?")), false, "rascunho que começa com ? não é caixa vazia");
  assert.equal(estadoDaCaixa(caixa("? posso apagar a pasta de vendas?"), "qualquer pedido"), "indeterminada", "rascunho com ? é indeterminada");
  assert.equal(estadoDaCaixa(caixa("pedido-x") + "  Do you want to proceed?\r\n", "pedido-x"), "indeterminada", "algo depois do texto que não é o rodapé");
  assert.equal(estadoDaCaixa("╭──────────────────────────────────────────╮\r\n│ ❯ pedido-antigo\r\n╰──────────────────────────────────────────╯\r\n ❯ outro menu\r\n", "pedido-antigo"), "indeterminada", "texto acima do último prompt não conta");
  assert.equal(caixaVaziaNaTela(caixa("rascunho")), false);
  assert.equal(caixaVaziaNaTela(comDialogo), false);
  // Revisão: o conteúdo inteiro precisa ser igual (não um sufixo) e o marcador só vale no início da linha.
  assert.equal(estadoDaCaixa(caixa("pauta antiga da reunião"), "reunião"), "indeterminada", "sufixo não é o mesmo texto");
  assert.equal(estadoDaCaixa(caixa("plano de estudo ›"), "qualquer pedido"), "indeterminada");
  assert.equal(caixaVaziaNaTela(caixa("plano de estudo ›")), false, "› no fim do rascunho não é marcador");
  assert.equal(estadoDaCaixa(caixa("plano ❯ de estudo"), "plano ❯ de estudo"), "mesmo-texto", "❯ no meio é conteúdo");
  const dois = "╭──────────────────────────────────────────╮\r\n│ ❯ primeira linha\r\n│ ❯ segunda linha\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n";
  assert.equal(estadoDaCaixa(dois, "segunda linha"), "indeterminada", "limites ambíguos");
});

test("recibo do /compact no Claude é só o PreCompact; prompt comum aceito não vale", async () => {
  const { esperarRecibo } = await import("./sessao/digitacao.js");
  const falso = () => ({ hooksVivos: true, motor: { reciboPorRollout: false }, promptsAceitos: 0, compactsIniciados: 0 }) as never;
  const a = falso();
  const e1 = esperarRecibo(a, 0, 500, 0, true);
  setTimeout(() => ((a as unknown as Record<string, number>).promptsAceitos += 1), 100);
  assert.equal(await e1, false);
  const b = falso();
  const e2 = esperarRecibo(b, 0, 2_000, 0, true);
  setTimeout(() => ((b as unknown as Record<string, number>).compactsIniciados += 1), 100);
  assert.equal(await e2, true);
});

test("suspensão por rascunho: um recibo NÃO a encerra; só a caixa vazia no idle; o CLI recebe o texto completo, sem o rascunho colado", async () => {
  const { confirmarRecibos, talvezSoltarFila } = await import("./sessao/fila.js");
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("pedido-suspenso-1");
  await esperarAte(() => promptsDe("pedido-suspenso-1") === 1, 25_000, "o primeiro Enter");
  s.enfileirarQuandoOcioso("segundo-suspenso-1");
  s.escrever("rascunho-suspenso-do-dono");
  await esperarAte(() => s.retidos.length === 1, 10_000, "o pedido ficar retido");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  // Chega um recibo (de outro turno qualquer): a caixa ainda tem o rascunho, então a suspensão continua.
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.notEqual(s.digitacaoSuspensaEm, null, "o recibo não limpa a suspensão");
  talvezSoltarFila(s);
  await dormir(1_500);
  assert.equal(promptsDe("segundo-suspenso-1"), 0, "nada é digitado por cima do rascunho");
  assert.equal(promptsDe("rascunho-suspenso-do-dono"), 0, "o rascunho ainda não foi enviado");
  // O dono dá o Enter: o rascunho vira o prompt dele e a caixa fica vazia; no idle a fila é solta.
  s.escrever("\r");
  await esperarAte(() => promptsDe("rascunho-suspenso-do-dono") === 1, 5_000, "o Enter do dono");
  await esperarAte(() => promptsDe("segundo-suspenso-1") === 1, 25_000, "o segundo sair com a caixa vazia");
  assert.equal(s.digitacaoSuspensaEm, null);
  assert.equal(lerLinhasJson(amb.logDosClis).some((l) => typeof l.texto === "string" && l.texto.includes("rascunho-suspenso-do-donosegundo")), false, "sem concatenação com o rascunho");
});

test("envios serializados: o envio direto não se intercala com a colagem longa da fila, e o item da fila só é marcado pelo Enter dele", async () => {
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const longo = "texto-longo-da-fila-" + "x".repeat(3_000);
  s.enfileirarQuandoOcioso(longo);
  await esperarAte(() => s.soltandoFila, 5_000, "a fila começar a colar");
  assert.equal(s.semRecibo[0]!.enterEscrito, false, "a colagem longa ainda está no meio");
  const direto = s.digitarEEnviar("envio-direto-1");
  await direto;
  const prompts = lerLinhasJson(amb.logDosClis).filter((l) => l.bin === "claude" && l.modo === "prompt").map((l) => l.texto as string);
  const iLongo = prompts.indexOf(longo);
  const iDireto = prompts.indexOf("envio-direto-1");
  assert.ok(iLongo >= 0, "o texto longo chegou inteiro ao CLI, sem o texto direto no meio");
  assert.ok(iDireto > iLongo, "o envio direto veio depois do Enter do texto da fila");
  const item = s.semRecibo[0]?.item ?? s.retidos[0];
  assert.equal(item?.texto, longo);
  assert.equal(s.semRecibo[0]?.parada, undefined, "o envio direto não mexeu no item da fila");
});

test("terminal trocado no meio do envio: para de escrever e retém o pedido", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const procAntigo = s.proc;
  const escritas: string[] = [];
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    escritas.push(t);
    if (escritas.length === 2) (s as unknown as { proc: unknown }).proc = { write() {}, kill() {} }; // o terminal é trocado no meio da colagem
  };
  const item = { texto: "y".repeat(1_000), em: 1, id: "dddd4444", digitado: true };
  const entrada: import("./sessao/fila.js").SemRecibo = { item, promptsAntes: 0, aguardando: false, enterEscrito: false, interrompido: false };
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const recebido = await s.digitarEEnviar(item.texto, true, entrada);
  (s as unknown as { proc: unknown }).proc = procAntigo;
  (s as unknown as { escrever: unknown }).escrever = original;
  assert.equal(recebido, false);
  assert.equal(escritas.length, 2, "depois da troca nada mais foi escrito (nem colagem, nem Enter)");
  assert.equal(entrada.enterEscrito, false);
  assert.equal(entrada.parada?.tipo, "terminal");
});

test("reinício entre aceitar o envio e escrever: nada é escrito no terminal novo e o item da fila volta para a frente da fila", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const procAntigo = s.proc;
  const escritas: string[] = [];
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    escritas.push(t);
  };
  // Um envio anterior segura a cadeia; o reinício acontece enquanto o próximo espera a vez.
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => {
    soltar = r;
  });
  const item = { texto: "pedido-do-reinicio", em: 1, id: "eeee5555", digitado: true };
  const entrada: import("./sessao/fila.js").SemRecibo = { item, promptsAntes: 0, aguardando: false, enterEscrito: false, interrompido: false };
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  (s as unknown as { proc: unknown }).proc = { write() {}, kill() {} }; // reinício: terminal novo
  soltar();
  const recebido = await envio;
  (s as unknown as { proc: unknown }).proc = procAntigo;
  (s as unknown as { escrever: unknown }).escrever = original;
  assert.equal(recebido, false);
  assert.deepEqual(escritas, [], "nada foi escrito no terminal novo");
  assert.equal(s.semRecibo.length, 0);
  assert.equal(item.digitado, undefined, "o item não foi digitado");
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["pedido-do-reinicio"], "o item voltou para a frente da fila");
});

test("o agente passa a esperar resposta enquanto o envio espera a vez: nada é colado nem enviado e o item volta para a fila", async () => {
  logarClaude(amb);
  const { s } = await nova({}, { ...REDE_CURTA });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const escritas: string[] = [];
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    escritas.push(t);
  };
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => {
    soltar = r;
  });
  const item = { texto: "pedido-na-permissao", em: 1, id: "ffff6666", digitado: true };
  const entrada: import("./sessao/fila.js").SemRecibo = { item, promptsAntes: 0, aguardando: false, enterEscrito: false, interrompido: false };
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  const estadoAntes = s.estado.status;
  (s.estado as { status: string }).status = "waiting_input"; // o diálogo de permissão abriu na espera
  soltar();
  const recebido = await envio;
  (s.estado as { status: string }).status = estadoAntes;
  (s as unknown as { escrever: unknown }).escrever = original;
  assert.equal(recebido, false);
  assert.deepEqual(escritas, [], "nem colagem nem Enter");
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), ["pedido-na-permissao"]);
});

test("a entrega incerta (202 entregaIncerta) manda esperar e conferir antes de reenviar", () => {
  const fonte = fs.readFileSync(new URL("./servidor.ts", import.meta.url.replace("/dist/", "/src/")), "utf8");
  assert.match(fonte, /ainda pode concluir a entrega nos próximos ~2 minutos: espere, confira a conversa do agente e só reenvie se o pedido não aparecer/);
  assert.doesNotMatch(fonte, /se não aparece, reenviar\./);
});

test("sem nenhum hook além do prazo: o pedido NÃO é declarado entregue e fica retido como incerto", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  logarClaude(amb);
  process.env.FAKE_SEM_HOOKS = "1";
  process.env.FAKE_PROMPT_PRONTO = "1";
  const { s } = await nova({}, { bootTimerMs: 300, tetoBootSemSinalMs: 600, prazoSemHooksMs: 1_000 });
  await s.subir("nova");
  delete process.env.FAKE_SEM_HOOKS;
  delete process.env.FAKE_PROMPT_PRONTO;
  await esperarAte(() => s.estado.status === "idle", 4_000);
  await esperarAte(() => Date.now() - s.spawnEm > 1_200, 3_000, "o prazo vencer");
  s.enfileirarQuandoOcioso("pedido-sem-hooks-retido-1");
  await esperarAte(() => s.retidos.length === 1, 10_000, "o pedido ficar retido");
  assert.equal(promptsDe("pedido-sem-hooks-retido-1"), 1, "um Enter só");
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-sem-hooks-retido-1", true]]);
  assert.match(lerTexto(amb.logDoRunner).slice(marcaDoLog), /não mandou nenhum hook desde que abriu .* fica retido como incerto/);
});

test("pedido que entra com um pendente sem recibo (ou com a digitação suspensa) leva o aviso de atraso; pendentes e naFilaTotal incluem o que está sem recibo", async () => {
  const { s } = await sessaoComPedidoSemRecibo("primeiro-aviso-1");
  assert.equal(s.semRecibo.length, 1);
  assert.deepEqual(s.pendentesDaFila().map((i) => i.texto), ["primeiro-aviso-1"], "o digitado sem recibo aparece como pendente");
  assert.equal(s.tamanhoDaFila(), 1);
  s.enfileirarQuandoOcioso("<dgchat msg=\"m2\">segundo</dgchat>");
  const segundo = s.filaQuandoIdle.at(-1)!;
  assert.equal(segundo.esperou, true, "entrou com um pedido sem recibo pendente");
  assert.deepEqual(s.pendentesDaFila().map((i) => i.texto), ["primeiro-aviso-1", "<dgchat msg=\"m2\">segundo</dgchat>"]);
  assert.equal(s.tamanhoDaFila(), 2);
  // Digitação suspensa por rascunho também conta.
  const { s: s2 } = await nova();
  s2.digitacaoSuspensaEm = Date.now();
  s2.enfileirarQuandoOcioso("com-suspensao-1");
  assert.equal(s2.filaQuandoIdle[0]!.esperou, true);
});

test("comando de barra: continua no disco, associado à vigia, até o recibo específico; o recibo (PreCompact) o tira, o silêncio o retém", async () => {
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  process.env.FAKE_IGNORA_ENTER = "99";
  const { s } = await nova({}, { reciboVigiaPassosMs: [400, 400, 400] });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  delete process.env.FAKE_IGNORA_ENTER;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("/compact");
  await esperarAte(() => s.barraPendente !== null && !s.soltandoFila, 25_000, "o /compact ficar à espera do recibo");
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.digitado]), [["/compact", true]], "o finally não apagou o comando enquanto a vigia está armada");
  assert.deepEqual(s.pendentesDaFila().map((i) => i.texto), ["/compact"]);
  // O Enter é ignorado pelo fake (texto fica na caixa): a vigia repete e acaba retendo o comando como incerto.
  await esperarAte(() => s.retidos.length === 1, 15_000, "a vigia esgotar");
  assert.equal(s.barraPendente, null);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["/compact", true]]);
});

test("comando de barra com recibo próprio (PreCompact): sai do disco", async () => {
  logarClaude(amb);
  process.env.FAKE_NAO_CONFIRMA = "1";
  process.env.FAKE_IGNORA_ENTER = "99";
  const { s } = await nova({}, { reciboVigiaPassosMs: [2_000, 2_000] });
  await s.subir("nova");
  delete process.env.FAKE_NAO_CONFIRMA;
  delete process.env.FAKE_IGNORA_ENTER;
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enfileirarQuandoOcioso("/compact");
  await esperarAte(() => s.barraPendente !== null && !s.soltandoFila, 25_000, "o /compact ficar à espera do recibo");
  s.receberHook({ agentId: s.id, event: "PreCompact", nonce: s.nonce ?? undefined });
  await esperarAte(() => s.barraPendente === null && filaEmDisco(s).length === 0, 8_000, "o recibo limpar o disco");
  assert.equal(s.retidos.length, 0);
});

// --- Correções da revisão de segurança: caixa suja, tela atual, recibo de outro turno, vez na cadeia, vigia e fila ---

/** Sessão idle com o `escrever` trocado por um que só anota (mas conta, como o de verdade) e a cadeia de envio à mão. */
async function sessaoComEscritaAnotada() {
  logarClaude(amb);
  const { s } = await nova({}, { ...PASSOS_CURTOS });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const escritas: string[] = [];
  const original = s.escrever.bind(s);
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    s.entradasManuais += 1;
    escritas.push(t);
  };
  const restaurar = () => ((s as unknown as { escrever: unknown }).escrever = original);
  return { s, escritas, restaurar };
}
/** Executa `acao` logo depois da n-ésima escrita (1 = a primeira) feita pelo mock de `escrever`, no tick seguinte: simula o dono ou o
 *  agente mudando as coisas exatamente depois de o texto (ou de um pedaço dele) sair, sem depender de relógio. */
function depoisDaEscrita(s: { escrever: (t: string) => void }, escritas: string[], n: number, acao: () => void): void {
  const base = s.escrever.bind(s);
  let feito = false;
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    base(t);
    if (!feito && escritas.length === n) {
      feito = true;
      setTimeout(acao, 0); // fora desta escrita: ela não pode contar a ação como se fosse do próprio envio
    }
  };
}
const novoItem = (texto: string) => {
  const item = { texto, em: 1, id: "aaaa" + texto.length, digitado: true };
  const entrada: import("./sessao/fila.js").SemRecibo = { item, promptsAntes: 0, aguardando: false, enterEscrito: false, interrompido: false };
  return { item, entrada };
};

test("caixa suja: escrita de fora durante a pausa da colagem curta impede o Enter, suspende a digitação e devolve false (chamada direta)", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  depoisDaEscrita(s, escritas, 1, () => s.escrever("rascunho-do-dono")); // dentro da pausa antes do Enter
  const envio = s.digitarEEnviar("pedido-curto-sujo");
  assert.equal(await envio, false);
  restaurar();
  assert.deepEqual(escritas, ["pedido-curto-sujo", "rascunho-do-dono"], "nenhum Enter");
  assert.notEqual(s.digitacaoSuspensaEm, null, "sem fila para suspender, a suspensão é feita na hora");
});

test("caixa suja: o agente passar a esperar uma resposta no meio da pausa também impede o Enter (item da fila fica parado como caixa)", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { item, entrada } = novoItem("pedido-curto-permissao");
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const antes = s.estado.status;
  depoisDaEscrita(s, escritas, 1, () => ((s.estado as { status: string }).status = "waiting_input"));
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  assert.equal(await envio, false);
  (s.estado as { status: string }).status = antes;
  restaurar();
  assert.deepEqual(escritas, ["pedido-curto-permissao"], "o Enter não saiu");
  assert.equal(entrada.parada?.tipo, "caixa");
});

test("caixa suja: colagem longa para no pedaço seguinte se alguém escreveu no meio, sem escrever mais nada", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const longo = "x".repeat(700);
  const { item, entrada } = novoItem(longo);
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  depoisDaEscrita(s, escritas, 1, () => s.escrever("rascunho-no-meio")); // depois do 1º pedaço, antes do 2º
  const envio = s.digitarEEnviar(longo, true, entrada);
  assert.equal(await envio, false);
  restaurar();
  assert.equal(escritas.length, 2, "um pedaço e o rascunho, nada mais");
  assert.equal(escritas[0].length, 128);
  assert.equal(entrada.parada?.tipo, "caixa");
  assert.match(entrada.parada!.motivo, /outra escrita no terminal no meio do envio/);
});

test("caixa suja: colagem longa com o agente esperando uma resposta no meio para, e a parada é da caixa", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const longo = "y".repeat(700);
  const { item, entrada } = novoItem(longo);
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const antes = s.estado.status;
  depoisDaEscrita(s, escritas, 1, () => ((s.estado as { status: string }).status = "waiting_input"));
  const envio = s.digitarEEnviar(longo, true, entrada);
  assert.equal(await envio, false);
  (s.estado as { status: string }).status = antes;
  restaurar();
  assert.equal(escritas.length, 1);
  assert.equal(entrada.parada?.tipo, "caixa");
  assert.match(entrada.parada!.motivo, /esperar uma resposta/);
});

test("tela atual: um rascunho escrito com movimento de cursor, sem limpar a tela, não é lido como caixa vazia e a suspensão não é levantada", async () => {
  const { talvezSoltarFila } = await import("./sessao/fila.js");
  const { caixaVaziaNaTela } = await import("./sessao/telas.js");
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  await alimentarTela(s, "\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ \r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n");
  assert.equal(caixaVaziaNaTela(s.telaAtual()), true);
  await alimentarTela(s, "\u001b[2;5Hrascunho-do-dono"); // escreve dentro da caixa sem limpar nada
  assert.equal(caixaVaziaNaTela(s.telaAtual()), false, "a tela de agora tem o rascunho");
  assert.equal(caixaVaziaNaTela(s.telaInteira()), true, "o fluxo bruto enganaria (é por isso que ele não é mais usado)");
  s.spawnEm = 0;
  s.ultimaSaidaEm = Date.now() - 5_000;
  s.digitacaoSuspensaEm = Date.now();
  s.filaQuandoIdle.push({ texto: "pedido-suspenso-na-tela", em: 1, id: "bbbb0001" });
  talvezSoltarFila(s);
  assert.notEqual(s.digitacaoSuspensaEm, null, "a suspensão continua");
  assert.equal(s.semRecibo.length, 0, "nada foi digitado");
  // Caixa vazia de novo, mas o terminal acabou de escrever: ainda não se confia na leitura.
  await alimentarTela(s, "\u001b[2;5H\u001b[K");
  assert.equal(caixaVaziaNaTela(s.telaAtual()), true);
  s.ultimaSaidaEm = Date.now();
  talvezSoltarFila(s);
  assert.notEqual(s.digitacaoSuspensaEm, null, "terminal ainda não está quieto há 500 ms");
  assert.notEqual(s.reintentoDaFila, null, "a leitura é reagendada");
  s.filaQuandoIdle.length = 0;
  (await import("./sessao/fila.js")).cancelarReintentoDaFila(s);
});

test("sem hooks: com texto ainda na caixa, o pedido comum é parado como caixa (suspende) e o comando de barra NÃO vira sucesso", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  s.hooksVivos = false;
  (s as unknown as { prazoSemHooksMs: number }).prazoSemHooksMs = 0;
  s.spawnEm = 0;
  for (const [texto, barra] of [["pedido-sem-hooks-na-caixa", false], ["/clear", true]] as const) {
    s.digitacaoSuspensaEm = null;
    await alimentarTela(s, `\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ ${texto}\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n`);
    const { item, entrada } = novoItem(texto);
    s.semRecibo.push(entrada);
    s.itemEmVoo = item;
    const ok = await enviarComRecibo(s, { texto, comandoDeBarra: barra, envio: entrada, proc: s.proc! });
    assert.equal(ok, false, texto);
    assert.equal(entrada.parada?.tipo, "caixa", texto);
    s.semRecibo.length = 0;
  }
  // Caixa vazia: a regra de hoje. Barra sem recibo próprio = consumido; pedido comum = sem-hooks, sem suspender.
  await alimentarTela(s, "\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ \r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n");
  s.digitacaoSuspensaEm = null;
  assert.equal(await enviarComRecibo(s, { texto: "/clear", comandoDeBarra: true, envio: null, proc: s.proc! }), true);
  const { item, entrada } = novoItem("comum-caixa-vazia");
  s.semRecibo.push(entrada);
  assert.equal(await enviarComRecibo(s, { texto: item.texto, comandoDeBarra: false, envio: entrada, proc: s.proc! }), false);
  assert.equal(entrada.parada?.tipo, "sem-hooks");
  assert.equal(s.digitacaoSuspensaEm, null);
  restaurar();
  assert.ok(escritas.length > 0);
  s.semRecibo.length = 0;
});

test("recibo de outro turno: depois de uma escrita manual o recibo NÃO confirma o item, que fica retido como incerto no arquivo", async () => {
  const { confirmarRecibos } = await import("./sessao/fila.js");
  logarClaude(amb);
  const { s } = await nova({}, { ...PASSOS_CURTOS });
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const { item, entrada } = novoItem("pedido-recibo-de-outro-turno");
  entrada.enterEscrito = true;
  entrada.aguardando = true;
  entrada.promptsAntes = s.promptsAceitos;
  entrada.entradasNoEnter = s.entradasManuais; // o contador logo depois do nosso Enter
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  s.escrever("outra-mensagem-do-dono"); // o dono escreveu pelo terminal depois do nosso Enter
  s.promptsAceitos += 1; // o hook UserPromptSubmit (da outra mensagem)
  confirmarRecibos(s);
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-recibo-de-outro-turno", true]]);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-recibo-de-outro-turno", true]], "não foi apagado do disco");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  // Sem escrita de fora o mesmo recibo confirma, como sempre.
  const { s: s2 } = await nova();
  await s2.subir("nova");
  await esperarAte(() => s2.estado.status === "idle", 8_000);
  const b = novoItem("pedido-recibo-do-proprio-turno");
  b.entrada.enterEscrito = true;
  b.entrada.promptsAntes = s2.promptsAceitos;
  b.entrada.entradasNoEnter = s2.entradasManuais;
  s2.semRecibo.push(b.entrada);
  s2.promptsAceitos += 1;
  confirmarRecibos(s2);
  assert.equal(s2.semRecibo.length, 0);
  assert.equal(s2.retidos.length, 0);
});

test("recibo que chega depois de uma escrita de fora: enviarComRecibo não devolve true (entrega incerta) e suspende a digitação", async () => {
  const { s, restaurar } = await sessaoComEscritaAnotada();
  const { enviarComRecibo } = await import("./sessao/digitacao.js");
  await alimentarTela(s, "\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ texto-do-recibo-duvidoso\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n");
  setTimeout(() => {
    s.entradasManuais += 1; // alguém escreveu depois do nosso Enter
    s.promptsAceitos += 1; // e o recibo é da mensagem dele
  }, 150);
  const ok = await enviarComRecibo(s, { texto: "texto-do-recibo-duvidoso", comandoDeBarra: false, envio: null, proc: s.proc! });
  restaurar();
  assert.equal(ok, false);
  assert.notEqual(s.digitacaoSuspensaEm, null);
});

test("vez na cadeia: item da fila só é digitado com o agente idle; fora disso nada é escrito e ele volta para a frente da fila", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => (soltar = r));
  const { item, entrada } = novoItem("pedido-que-esperou-e-o-agente-ocupou");
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  const antes = s.estado.status;
  (s.estado as { status: string }).status = "working"; // um turno começou enquanto esperava a vez
  soltar();
  assert.equal(await envio, false);
  (s.estado as { status: string }).status = antes;
  restaurar();
  assert.deepEqual(escritas, []);
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(s.filaQuandoIdle.map((i) => i.texto), [item.texto]);
});

test("vez na cadeia: recusa de entrada surgida enquanto esperava (login, chave) devolve o item e agenda o reintento; na chamada direta lança ErroDeMotor", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  const { talvezSoltarFila, cancelarReintentoDaFila } = await import("./sessao/fila.js");
  const recusa = { tipo: "login-expirado", mensagem: "login expirou (teste)", comoResolver: "reconectar a conta (teste)" };
  const original = s.recusaDeEntrada.bind(s);
  (s as unknown as { recusaDeEntrada: () => unknown }).recusaDeEntrada = () => recusa;
  // Pela fila: o pedido volta para a frente e o reintento fica agendado (nada de laço quente).
  s.spawnEm = 0;
  s.filaQuandoIdle.push({ texto: "pedido-na-recusa", em: 1, id: "cccc0001" });
  talvezSoltarFila(s);
  await esperarAte(() => s.reintentoDaFila !== null && !s.soltandoFila, 3_000, "o reintento");
  assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [["pedido-na-recusa", undefined]]);
  assert.equal(s.semRecibo.length, 0);
  cancelarReintentoDaFila(s);
  // Chamada direta: erro com o motivo.
  await assert.rejects(s.digitarEEnviar("direto-na-recusa"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:recusa-de-entrada" && /login expirou/.test(e.message));
  (s as unknown as { recusaDeEntrada: unknown }).recusaDeEntrada = original;
  restaurar();
  assert.deepEqual(escritas, [], "nada foi escrito");
  s.filaQuandoIdle.length = 0;
});

test("vigia substituída: um envio direto que instala vigia nova retém o item da fila antigo como incerto, e a fila não fica bloqueada", async () => {
  const { s, restaurar } = await sessaoComEscritaAnotada();
  const { vigiarReciboAtrasado } = await import("./sessao/digitacao.js");
  const { cancelarReintentoDaFila } = await import("./sessao/fila.js");
  const { item, entrada } = novoItem("pedido-da-vigia-substituida");
  entrada.enterEscrito = true;
  entrada.aguardando = true;
  s.semRecibo.push(entrada);
  vigiarReciboAtrasado(s, { texto: item.texto, comandoDeBarra: false, envio: entrada, proc: s.proc! }, 4, s.entradasManuais);
  assert.equal(s.vigiaDoEnvio, entrada);
  // Um envio direto (sem item) que também esgotou os Enters instala a vigia dele.
  vigiarReciboAtrasado(s, { texto: "envio-direto", comandoDeBarra: false, envio: null, proc: s.proc! }, 4, s.entradasManuais);
  assert.equal(s.vigiaDoEnvio, null);
  assert.equal(s.semRecibo.length, 0, "o item não ficou pendente para sempre");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["pedido-da-vigia-substituida", true]]);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [["pedido-da-vigia-substituida", true]]);
  assert.notEqual(s.digitacaoSuspensaEm, null);
  assert.equal(s.barraPendente, null);
  cancelarReintentoDaFila(s);
  assert.equal(s.vigiaDoRecibo, null);
  restaurar();
});

test("fila: se o arquivo não pode ser gravado o pedido é recusado (nao-gravado) e sai da fila em memória", async () => {
  logarClaude(amb);
  const { s, pasta } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const certo = s.arquivoDaFila;
  const bloqueio = path.join(pasta, "bloqueio-enfileirar");
  fs.writeFileSync(bloqueio, "x");
  (s as unknown as { arquivoDaFila: string }).arquivoDaFila = path.join(bloqueio, "fila.json");
  assert.equal(s.enfileirarQuandoOcioso("pedido-que-nao-grava"), "nao-gravado");
  assert.equal(s.filaQuandoIdle.length, 0);
  assert.equal(s.semRecibo.length, 0);
  (s as unknown as { arquivoDaFila: string }).arquivoDaFila = certo;
});

// --- Rodada 2 da revisão ---

const CAIXA_VAZIA = "\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ \r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n";
const caixaCom = (t: string) => `\u001b[2J\u001b[H╭──────────────────────────────────────────╮\r\n│ ❯ ${t}\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n`;

const DIALOGO_ABERTO = " Do you want to proceed?\r\n   1. Yes\r\n   2. No\r\n Esc to cancel\r\n";

test("primeiro Enter: um diálogo que abre DEPOIS do texto e antes do Enter impede o Enter; sem diálogo o Enter sai", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  await alimentarTela(s, CAIXA_VAZIA);
  const anota = s.escrever;
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    anota(t);
    if (t === "pedido-com-dialogo-aberto") s.guardarEEmitir(caixaCom("pedido-com-dialogo-aberto") + DIALOGO_ABERTO);
  };
  assert.equal(await s.digitarEEnviar("pedido-com-dialogo-aberto"), false);
  assert.deepEqual(escritas, ["pedido-com-dialogo-aberto"], "o Enter não saiu");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  // Controle: a tela sem diálogo deixa o Enter sair (o recibo chega logo depois).
  (s as unknown as { escrever: unknown }).escrever = anota;
  escritas.length = 0;
  s.digitacaoSuspensaEm = null;
  await alimentarTela(s, caixaCom("pedido-sem-dialogo"));
  setTimeout(() => (s.promptsAceitos += 1), 250);
  assert.equal(await s.digitarEEnviar("pedido-sem-dialogo"), true);
  assert.deepEqual(escritas, ["pedido-sem-dialogo", "\r"]);
  restaurar();
});

test("rodada 4, item 1: com um diálogo na tela NADA é escrito (nem o texto): envio direto lança NAO_ENTROU, item da fila volta intacto; sem diálogo escreve", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  await alimentarTela(s, caixaCom("") + DIALOGO_ABERTO);
  await assert.rejects(s.digitarEEnviar("direto-com-dialogo"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  assert.deepEqual(escritas, [], "nenhum byte");
  assert.equal(s.digitacaoSuspensaEm, null, "nada foi escrito, não há o que suspender");
  const { item, entrada } = novoItem("pedido-da-fila-com-dialogo");
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  assert.equal(await s.digitarEEnviar(item.texto, true, entrada), false);
  assert.deepEqual(escritas, []);
  assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [[item.texto, undefined]], "voltou intacto à frente da fila");
  assert.equal(s.semRecibo.length, 0);
  assert.equal(s.retidos.length, 0);
  // Colagem longa: a tela precisa mostrar a caixa também antes do primeiro pedaço.
  const longo = "z".repeat(700);
  await assert.rejects(s.digitarEEnviar(longo), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  assert.deepEqual(escritas, []);
  // Controle: com a caixa na tela escreve.
  await alimentarTela(s, CAIXA_VAZIA);
  setTimeout(() => (s.promptsAceitos += 1), 250);
  assert.equal(await s.digitarEEnviar("direto-sem-dialogo"), true);
  assert.equal(escritas[0], "direto-sem-dialogo");
  restaurar();
});

test("rodada 4, item 1: colagem longa revalida a tela antes de CADA pedaço: diálogo no meio para a colagem sem escrever mais nada", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  await alimentarTela(s, CAIXA_VAZIA);
  const anota = s.escrever;
  (s as unknown as { escrever: (t: string) => void }).escrever = (t: string) => {
    anota(t);
    if (escritas.length === 1) s.guardarEEmitir(caixaCom("z".repeat(40)) + DIALOGO_ABERTO);
  };
  assert.equal(await s.digitarEEnviar("z".repeat(700)), false);
  assert.equal(escritas.length, 1, "só o primeiro pedaço saiu");
  assert.notEqual(s.digitacaoSuspensaEm, null, "o texto parcial pode estar na caixa: suspende");
  restaurar();
});

test("envio direto com a digitação suspensa: caixa com rascunho => ErroDeMotor caixa-com-rascunho e nada escrito; caixa vazia e terminal quieto => levanta a suspensão e segue", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  s.digitacaoSuspensaEm = Date.now();
  s.ultimaSaidaEm = Date.now() - 5_000;
  await alimentarTela(s, caixaCom("rascunho-do-dono"));
  await assert.rejects(s.digitarEEnviar("direto-com-rascunho"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:caixa-com-rascunho" && /terminal do agente/.test(e.comoResolver));
  assert.deepEqual(escritas, []);
  assert.notEqual(s.digitacaoSuspensaEm, null);
  // Caixa vazia, mas o terminal acabou de escrever: ainda não se confia na leitura.
  await alimentarTela(s, CAIXA_VAZIA);
  s.ultimaSaidaEm = Date.now();
  await assert.rejects(s.digitarEEnviar("direto-terminal-barulhento"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:caixa-com-rascunho");
  // Caixa vazia e quieto: segue.
  s.ultimaSaidaEm = Date.now() - 5_000;
  setTimeout(() => (s.promptsAceitos += 1), 300);
  assert.equal(await s.digitarEEnviar("direto-com-caixa-vazia"), true);
  assert.equal(s.digitacaoSuspensaEm, null);
  assert.equal(escritas[0], "direto-com-caixa-vazia");
  restaurar();
});

test("tela sincronizada: se a saída do terminal muda durante a sincronização, o primeiro Enter não é escrito; o Enter da vigia também não", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { enviarComRecibo, vigiarReciboAtrasado } = await import("./sessao/digitacao.js");
  const { cancelarReintentoDaFila } = await import("./sessao/fila.js");
  await alimentarTela(s, caixaCom("texto-que-nao-assenta"));
  const original = s.telaAtualSincronizada.bind(s);
  (s as unknown as { telaAtualSincronizada: () => Promise<string> }).telaAtualSincronizada = async () => {
    const t = await original();
    s.seq += 1; // chegou saída do terminal enquanto se esperava o emulador
    return t;
  };
  assert.equal(await enviarComRecibo(s, { texto: "texto-que-nao-assenta", comandoDeBarra: false, envio: null, proc: s.proc! }), false);
  assert.ok(!escritas.includes("\r"), "nenhum Enter");
  // A vigia: mesmo texto na caixa e agente idle, mas a decisão não é válida: nada escrito.
  vigiarReciboAtrasado(s, { texto: "texto-que-nao-assenta", comandoDeBarra: false, envio: null, proc: s.proc! }, 4, s.entradasManuais);
  await dormir(600);
  cancelarReintentoDaFila(s);
  assert.ok(!escritas.includes("\r"), "a vigia também não escreveu");
  (s as unknown as { telaAtualSincronizada: unknown }).telaAtualSincronizada = original;
  restaurar();
});

test("lerCaixa: rascunho de vários parágrafos, com linha em branco e um parágrafo que começa com ❯ ou ›, não é caixa vazia nem texto reconhecido", async () => {
  const { estadoDaCaixa, caixaVaziaNaTela } = await import("./sessao/telas.js");
  for (const marca of ["❯", "›"]) {
    const tela = `╭──────────────────────────────────────────╮\r\n│ ❯ primeiro parágrafo do rascunho\r\n\r\n${marca} segundo parágrafo\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n`;
    assert.equal(estadoDaCaixa(tela, "qualquer pedido"), "indeterminada", marca);
    assert.equal(caixaVaziaNaTela(tela), false, marca);
  }
  // Um rascunho de parágrafos sem marcador no segundo continua sendo lido inteiro.
  assert.equal(estadoDaCaixa("╭──────────────────────────────────────────╮\r\n│ ❯ um\r\n\r\ndois\r\n╰──────────────────────────────────────────╯\r\n? for shortcuts\r\n", "um dois"), "mesmo-texto");
});

test("Enter do dono pelo terminal segura a fila até o recibo dele (ou 15 s); a rota do terminal e o POST /input cru registram", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { talvezSoltarFila, confirmarRecibos, cancelarReintentoDaFila } = await import("./sessao/fila.js");
  s.spawnEm = 0;
  s.registrarEscritaDeFora("só letras"); // sem Enter: não segura nada
  assert.equal(s.enterManualPendente, null);
  assert.notEqual(s.digitacaoSuspensaEm, null, "texto sem Enter é um rascunho: suspende");
  s.digitacaoSuspensaEm = null; // a caixa foi esvaziada (aqui só importa o portão do Enter do dono)
  s.registrarEscritaDeFora("minha mensagem\r");
  assert.notEqual(s.enterManualPendente, null);
  s.filaQuandoIdle.push({ texto: "pedido-atras-do-enter-do-dono", em: 1, id: "dddd0001" });
  talvezSoltarFila(s);
  assert.equal(s.semRecibo.length, 0, "não foi digitado");
  assert.deepEqual(escritas, []);
  assert.notEqual(s.reintentoDaFila, null, "reagendado");
  // O recibo do Enter do dono chega: a fila volta a soltar.
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.equal(s.enterManualPendente, null);
  talvezSoltarFila(s);
  assert.equal(s.semRecibo.length, 1, "agora o pedido é digitado");
  // Vencido o prazo, também solta.
  const { s: s2, restaurar: r2 } = await sessaoComEscritaAnotada();
  s2.spawnEm = 0;
  s2.enterManualPendente = { promptsAntes: s2.promptsAceitos, em: Date.now() - 16_000 };
  s2.filaQuandoIdle.push({ texto: "pedido-depois-do-prazo", em: 1, id: "dddd0002" });
  talvezSoltarFila(s2);
  assert.equal(s2.semRecibo.length, 1);
  assert.notEqual(s2.enterManualPendente, null, "o prazo só deixa a fila soltar: o Enter do dono segue pendente até o recibo dele");
  cancelarReintentoDaFila(s);
  cancelarReintentoDaFila(s2);
  restaurar();
  r2();
});

test("fila: 'sem-fsync-da-pasta' conta como enfileirado, mas NÃO libera a digitação (a marca digitado exige 'gravado')", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { cancelarReintentoDaFila } = await import("./sessao/fila.js");
  s.spawnEm = 0;
  const original = fs.fsyncSync;
  fs.fsyncSync = ((fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("fsync da pasta falhou de propósito");
    return original(fd);
  }) as typeof fs.fsyncSync;
  try {
    assert.equal(s.enfileirarQuandoOcioso("pedido-sem-fsync-da-pasta"), "enfileirado");
    assert.deepEqual(escritas, [], "nada foi digitado");
    assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [["pedido-sem-fsync-da-pasta", undefined]], "continua na frente da fila, sem a marca");
    assert.notEqual(s.reintentoDaFila, null);
    assert.ok(fs.existsSync(s.arquivoDaFila), "o arquivo tem o pedido");
    assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.digitado]), [["pedido-sem-fsync-da-pasta", undefined]], "o arquivo foi regravado sem a marca digitado");
  } finally {
    fs.fsyncSync = original;
    cancelarReintentoDaFila(s);
    restaurar();
  }
});

test("vigia: recibo do /compact (PreCompact) depois de escrita de fora NÃO libera o comando: fica retido como incerto e suspende; sem escrita de fora libera", async () => {
  const { s, restaurar } = await sessaoComEscritaAnotada();
  const { vigiarReciboAtrasado } = await import("./sessao/digitacao.js");
  for (const deFora of [true, false]) {
    s.digitacaoSuspensaEm = null;
    s.retidos.length = 0;
    const { item, entrada } = novoItem("/compact");
    entrada.barra = true;
    entrada.enterEscrito = true;
    entrada.aguardando = true;
    s.barraPendente = entrada;
    vigiarReciboAtrasado(s, { texto: "/compact", comandoDeBarra: true, envio: entrada, proc: s.proc! }, 4, s.entradasManuais);
    if (deFora) s.entradasManuais += 1; // o dono escreveu depois do nosso Enter
    s.compactsIniciados += 1; // PreCompact
    await esperarAte(() => s.barraPendente === null, 3_000, "a vigia olhar");
    if (deFora) {
      assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [["/compact", true]]);
      assert.notEqual(s.digitacaoSuspensaEm, null);
    } else {
      assert.equal(s.retidos.length, 0);
      assert.equal(s.digitacaoSuspensaEm, null);
    }
    void item;
  }
  restaurar();
});

test("parar com um item ainda esperando a vez na cadeia: nada foi escrito, ele volta para a frente da fila (não fica retido)", async () => {
  const { s, escritas } = await sessaoComEscritaAnotada();
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => (soltar = r));
  const { item, entrada } = novoItem("pedido-esperando-a-vez-ao-parar");
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  s.soltandoFila = true;
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  s.parar("teste da rodada 2"); // o caminho real de parar(): kill, cancelar a fila e devolverSemRecibo
  soltar();
  assert.equal(await envio, false);
  assert.deepEqual(escritas, []);
  assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [[item.texto, undefined]]);
  assert.equal(s.retidos.length, 0);
  assert.equal(s.semRecibo.length, 0);
  s.soltandoFila = false;
});

test("parar: item que JÁ escreveu algo continua retido como incerto", async () => {
  const { s } = await sessaoComEscritaAnotada();
  const { item, entrada } = novoItem("pedido-ja-escrito-ao-parar");
  entrada.escreveuAlgo = true;
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  s.parar("teste da rodada 2");
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [[item.texto, true]]);
  assert.equal(s.filaQuandoIdle.length, 0);
});

test("/compact repetido é deduplicado também enquanto um /compact espera o recibo tardio (barraPendente)", async () => {
  const { s } = await sessaoComEscritaAnotada();
  const { item, entrada } = novoItem("/compact");
  entrada.barra = true;
  entrada.aguardando = true;
  s.barraPendente = entrada;
  assert.equal(s.enfileirarQuandoOcioso("/compact"), "deduplicado");
  assert.equal(s.filaQuandoIdle.length, 0);
  void item;
});

test("retidos: no máximo 20; o mais antigo é descartado do arquivo com aviso (id e tamanho, nunca o texto); o mesmo no boot", async () => {
  const marcaDoLog = lerTexto(amb.logDoRunner).length;
  const { reter, recuperarDoDisco } = await import("./sessao/fila.js");
  logarClaude(amb);
  const { s } = await nova();
  for (let i = 1; i <= 22; i++) reter(s, { texto: `retido-secreto-${i}`, em: i, id: `r${String(i).padStart(7, "0")}` }, "teste");
  assert.equal(s.retidos.length, 20);
  assert.equal(s.retidos[0].id, "r0000003", "os dois mais antigos saíram");
  assert.equal(filaEmDisco(s).length, 20);
  const log = lerTexto(amb.logDoRunner).slice(marcaDoLog);
  assert.match(log, /descartei do arquivo da fila o mais antigo, o id r0000001 \(16 caracteres\)/);
  assert.match(log, /conferir na conversa do agente/);
  assert.doesNotMatch(log, /descartei[^\n]*retido-secreto/);
  // No boot: 25 incertos no arquivo.
  const { s: s2 } = await nova();
  s2.filaQuandoIdle = Array.from({ length: 25 }, (_, i) => ({ texto: `antigo-${i}`, em: i, id: `b${i}`, incerto: true }));
  recuperarDoDisco(s2);
  assert.equal(s2.retidos.length, 20);
  assert.equal(s2.retidos[0].id, "b5");
  assert.equal(filaEmDisco(s2).length, 20);
});

// --- Rodada 3 ---

test("tela ambígua (caixa e um menu de permissão com outro ❯): NADA é escrito, nem o texto nem o Enter", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  const { estadoDaCaixa, caixaIdentificada } = await import("./sessao/telas.js");
  const tela = caixaCom("pedido-na-tela-ambigua") + " Allow this action?\r\n ❯ 1. Allow once\r\n ❯ 2. Deny\r\n";
  assert.equal(caixaIdentificada(tela), false);
  assert.equal(caixaIdentificada(caixaCom("pedido-normal")), true);
  void estadoDaCaixa;
  await alimentarTela(s, tela);
  await assert.rejects(s.digitarEEnviar("pedido-na-tela-ambigua"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  assert.deepEqual(escritas, [], "nada foi escrito");
  restaurar();
});

test("tela sem nada reconhecível também impede qualquer escrita", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  await alimentarTela(s, "\u001b[2J\u001b[Hnada que pareça uma caixa de composição\r\n");
  await assert.rejects(s.digitarEEnviar("pedido-sem-caixa"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  assert.deepEqual(escritas, []);
  restaurar();
});

test("rascunho do dono sem Enter suspende a digitação: a fila não solta e o envio direto recebe ErroDeMotor enquanto a tela mostra o rascunho", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { talvezSoltarFila, cancelarReintentoDaFila } = await import("./sessao/fila.js");
  const { ErroDeMotor } = await import("./provedores/motor.js");
  s.spawnEm = 0;
  s.ultimaSaidaEm = Date.now() - 5_000;
  s.registrarEscritaDeFora("abc");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  await alimentarTela(s, caixaCom("abc"));
  s.filaQuandoIdle.push({ texto: "pedido-atras-do-rascunho", em: 1, id: "eeee0001" });
  talvezSoltarFila(s);
  assert.equal(s.semRecibo.length, 0, "a fila não digitou");
  assert.deepEqual(escritas, []);
  await assert.rejects(s.digitarEEnviar("direto-atras-do-rascunho"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:caixa-com-rascunho");
  // Texto vazio e Enter não são rascunho.
  const antes = s.digitacaoSuspensaEm;
  s.registrarEscritaDeFora("");
  assert.equal(s.digitacaoSuspensaEm, antes);
  cancelarReintentoDaFila(s);
  s.filaQuandoIdle.length = 0;
  restaurar();
});

test("lerCaixa: só é borda a linha de moldura com 40 ou mais caracteres; '─ item' e linhas curtas são conteúdo do rascunho", async () => {
  const { estadoDaCaixa, caixaVaziaNaTela } = await import("./sessao/telas.js");
  const L = "─".repeat(42);
  const tela = `╭${L}╮\r\n│ ❯ \r\n─ item da lista\r\n╰${L}╯\r\n? for shortcuts\r\n`;
  assert.equal(caixaVaziaNaTela(tela), false);
  assert.notEqual(estadoDaCaixa(tela, "qualquer"), "vazia");
  const curta = `╭${L}╮\r\n│ ❯ \r\n── lista\r\n╰${L}╯\r\n? for shortcuts\r\n`;
  assert.equal(caixaVaziaNaTela(curta), false, "uma linha curta que começa com traços é conteúdo");
  assert.equal(caixaVaziaNaTela(caixaCom("")), true, "a borda inteira continua sendo borda");
});

test("Enter do dono pendente depois dos 15 s: o recibo que chega com o Enter de um item da fila já escrito retém o item como incerto (não apaga)", async () => {
  const { confirmarRecibos } = await import("./sessao/fila.js");
  logarClaude(amb);
  const { s } = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  s.enterManualPendente = { promptsAntes: s.promptsAceitos, em: Date.now() - 20_000 }; // prazo vencido, recibo ainda não chegou
  const { item, entrada } = novoItem("pedido-depois-do-prazo-do-dono");
  entrada.enterEscrito = true;
  entrada.promptsAntes = s.promptsAceitos;
  entrada.entradasNoEnter = s.entradasManuais;
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  s.promptsAceitos += 1; // o recibo: pode ser do Enter do dono
  confirmarRecibos(s);
  assert.equal(s.enterManualPendente, null, "esse recibo consumiu o Enter do dono");
  assert.equal(s.semRecibo.length, 0);
  assert.deepEqual(s.retidos.map((i) => [i.texto, i.incerto]), [[item.texto, true]]);
  assert.deepEqual(filaEmDisco(s).map((i) => [i.texto, i.incerto]), [[item.texto, true]], "não foi apagado do disco");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  // Sem item com Enter escrito, o recibo só limpa o Enter do dono.
  s.enterManualPendente = { promptsAntes: s.promptsAceitos, em: Date.now() - 20_000 };
  s.promptsAceitos += 1;
  confirmarRecibos(s);
  assert.equal(s.enterManualPendente, null);
  assert.equal(s.retidos.length, 1);
});

// --- Rodada 4 da revisão ---

test("rodada 4, item 2: menu com UMA opção marcada (pergunta acima, recusa abaixo, sem moldura) NÃO é caixa de composição, no Claude e no Codex", async () => {
  const { caixaIdentificada, estadoDaCaixa, caixaVaziaNaTela } = await import("./sessao/telas.js");
  for (const m of ["❯", "›"]) {
    const menu = `Escolha como seguir\r\n ${m} Yes\r\n   No\r\n`;
    assert.equal(caixaIdentificada(menu), false, m);
    assert.equal(estadoDaCaixa(menu, "qualquer pedido"), "indeterminada", m);
    assert.equal(caixaVaziaNaTela(menu), false, m);
    // Marcador com moldura em cima mas sem a de baixo: a estrutura não se confirma.
    assert.equal(caixaIdentificada(`╭${"─".repeat(42)}╮\r\n│ ${m} \r\n`), false, "só a borda de cima");
    // Marcador com borda de baixo mas sem a de cima.
    assert.equal(caixaIdentificada(`│ ${m} \r\n╰${"─".repeat(42)}╯\r\n? for shortcuts\r\n`), false, "só a borda de baixo");
  }
  // As caixas de verdade continuam sendo caixas: Claude (com moldura) e Codex (rodapé do TUI no fim).
  assert.equal(caixaIdentificada(CAIXA_VAZIA), true);
  assert.equal(caixaIdentificada("› \r\n? for shortcuts\r\n"), true, "Codex");
  assert.equal(caixaVaziaNaTela("› \r\n? for shortcuts\r\n"), true, "Codex vazia");
});

test("rodada 4, item 3: item da fila que esperava a vez e vê a digitação suspensa por rascunho do dono NÃO escreve e volta intacto à frente da fila", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => (soltar = r));
  const { item, entrada } = novoItem("pedido-na-cadeia-com-rascunho");
  s.semRecibo.push(entrada);
  s.itemEmVoo = item;
  s.soltandoFila = true;
  const envio = s.digitarEEnviar(item.texto, true, entrada);
  // O dono começa a escrever enquanto o item espera a vez, e a sessão continua idle.
  s.registrarEscritaDeFora("rascunho-do-dono");
  assert.notEqual(s.digitacaoSuspensaEm, null);
  await alimentarTela(s, caixaCom("rascunho-do-dono"));
  s.ultimaSaidaEm = Date.now() - 5_000;
  soltar();
  assert.equal(await envio, false);
  assert.deepEqual(escritas, [], "nada foi escrito por cima do rascunho");
  assert.deepEqual(s.filaQuandoIdle.map((i) => [i.texto, i.digitado]), [[item.texto, undefined]]);
  assert.equal(s.semRecibo.length, 0);
  assert.notEqual(s.digitacaoSuspensaEm, null);
  s.soltandoFila = false;
  restaurar();
});

test("rodada 4, item 4: com a vigia de recibo de um ENVIO DIRETO ativa a fila não solta; o recibo atrasado dele não confirma o pedido seguinte", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { vigiarReciboAtrasado } = await import("./sessao/digitacao.js");
  const { talvezSoltarFila, cancelarReintentoDaFila } = await import("./sessao/fila.js");
  s.spawnEm = 0;
  await alimentarTela(s, CAIXA_VAZIA);
  vigiarReciboAtrasado(s, { texto: "envio-direto-em-vigilancia", comandoDeBarra: false, envio: null, proc: s.proc! }, 4, s.entradasManuais);
  assert.notEqual(s.vigiaDoRecibo, null);
  s.filaQuandoIdle.push({ texto: "pedido-da-fila-seguinte", em: 1, id: "ffff0004" });
  talvezSoltarFila(s);
  assert.equal(s.semRecibo.length, 0, "a fila não digitou");
  assert.equal(s.filaQuandoIdle.length, 1);
  assert.deepEqual(escritas, []);
  // O recibo atrasado do envio direto chega: ele não pode dar baixa em nada da fila.
  s.promptsAceitos += 1;
  await esperarAte(() => (escritas as string[]).includes("pedido-da-fila-seguinte"), 4_000, "a fila soltar o pedido DEPOIS de a vigia acabar");
  assert.equal(s.retidos.length, 0);
  assert.equal(s.semRecibo.length, 1, "o pedido da fila está pendente, esperando o recibo DELE");
  assert.equal(s.semRecibo[0].promptsAntes >= 1, true, "o recibo do envio direto já tinha passado quando ele foi digitado");
  cancelarReintentoDaFila(s);
  restaurar();
});

test("rodada 4, item 6: primeira linha da caixa vazia e segunda com cara de rodapé ('Plan mode on') seguida de parágrafos: caixa OCUPADA; limite duvidoso mantém a suspensão", async () => {
  const { caixaIdentificada, estadoDaCaixa, caixaVaziaNaTela } = await import("./sessao/telas.js");
  const borda = (a: string, b: string) => `${a}${"─".repeat(42)}${b}`;
  const comBorda = `${borda("╭", "╮")}\r\n│ ❯ \r\n│ Plan mode on\r\n│ primeiro parágrafo do rascunho\r\n│\r\n│ segundo parágrafo\r\n${borda("╰", "╯")}\r\n? for shortcuts\r\n`;
  assert.equal(caixaIdentificada(comBorda), true, "é uma caixa");
  assert.equal(caixaVaziaNaTela(comBorda), false, "mas não está vazia");
  assert.equal(estadoDaCaixa(comBorda, "qualquer pedido"), "indeterminada");
  // O rodapé de verdade, depois da borda de baixo, continua não sendo conteúdo: a caixa vazia segue vazia.
  assert.equal(caixaVaziaNaTela(`${borda("╭", "╮")}\r\n│ ❯ \r\n${borda("╰", "╯")}\r\n  Plan mode on (shift+tab to cycle)\r\n`), true);
  // Sem moldura (Codex): o rodapé é só o trecho final da tela; uma linha assim no meio do rascunho, com texto depois, é conteúdo.
  const semBorda = "› \r\nPlan mode on\r\nprimeiro parágrafo\r\n\r\nsegundo parágrafo\r\n? for shortcuts\r\n";
  assert.equal(caixaVaziaNaTela(semBorda), false);
  assert.equal(estadoDaCaixa(semBorda, "qualquer pedido"), "indeterminada");
  // Limite duvidoso (borda de cima sem a de baixo): indeterminado, nunca vazio.
  const duvidosa = `${borda("╭", "╮")}\r\n│ ❯ \r\n│ Plan mode on\r\n│ parágrafo\r\n`;
  assert.equal(estadoDaCaixa(duvidosa, "x"), "indeterminada");
  assert.equal(caixaVaziaNaTela(duvidosa), false);
  // No fluxo da fila: a suspensão por rascunho NÃO cai e nada é digitado.
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { talvezSoltarFila, cancelarReintentoDaFila } = await import("./sessao/fila.js");
  s.spawnEm = 0;
  s.digitacaoSuspensaEm = Date.now();
  s.ultimaSaidaEm = Date.now() - 5_000;
  await alimentarTela(s, comBorda);
  s.filaQuandoIdle.push({ texto: "pedido-que-nao-pode-sair", em: 1, id: "ffff0006" });
  talvezSoltarFila(s);
  assert.notEqual(s.digitacaoSuspensaEm, null);
  assert.deepEqual(escritas, []);
  assert.equal(s.semRecibo.length, 0);
  cancelarReintentoDaFila(s);
  restaurar();
});

test("rodada 4, item 7: envio direto que não escreveu nada (agente em waiting_input antes da 1ª escrita) lança NAO_ENTROU; nada de entregaIncerta", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  const antes = s.estado.status;
  (s.estado as { status: string }).status = "waiting_input";
  await assert.rejects(s.digitarEEnviar("direto-com-agente-esperando"), (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  (s.estado as { status: string }).status = antes;
  assert.deepEqual(escritas, []);
  restaurar();
});

test("rodada 4, item 8: envio direto cuja chamada foi desistida enquanto esperava a vez na cadeia é cancelado sem escrever nada", async () => {
  const { s, escritas, restaurar } = await sessaoComEscritaAnotada();
  const { ErroDeMotor } = await import("./provedores/motor.js");
  let soltar: () => void = () => {};
  s.cadeiaDeEnvio = new Promise<void>((r) => (soltar = r));
  let desistiu = false;
  const envio = s.digitarEEnviar("direto-que-o-cliente-largou", false, null, () => desistiu);
  desistiu = true;
  soltar();
  await assert.rejects(envio, (e: unknown) => e instanceof ErroDeMotor && e.statusReason === "runner:nao-entrou");
  assert.deepEqual(escritas, []);
  // Controle: sem desistir, escreve.
  await alimentarTela(s, CAIXA_VAZIA);
  setTimeout(() => (s.promptsAceitos += 1), 250);
  assert.equal(await s.digitarEEnviar("direto-que-segue", false, null, () => false), true);
  assert.equal(escritas[0], "direto-que-segue");
  restaurar();
});
