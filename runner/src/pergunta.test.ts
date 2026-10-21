import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dormir, abrirServidorDeHooks, chaveFalsa, esperarAte, logarClaude, prepararAmbiente } from "./apoio-teste.js";

// A resposta da pergunta de escolha e a permissão compartilham as mesmas teclas ("1"): estes testes
// garantem que nenhuma tecla é escrita depois que o terminal saiu da pergunta.
const amb = prepararAmbiente("pergunta");
const { Sessao } = await import("./sessao.js");
const { HOOK_HANDLER_SOURCE } = await import("./hook-handler-source.js");

process.env.ANTHROPIC_API_KEY = chaveFalsa();

let n = 0;
const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

async function nova(pausaTeclaPerguntaMs = 15) {
  logarClaude(amb);
  n += 1;
  const id = `perg-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const cfg = { name: id, cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions" };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
    pausaTeclaPerguntaMs,
    quietoParaOlharTranscriptMs: 60_000,
  } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000);
  const settings = JSON.parse(fs.readFileSync(path.join(pasta, "runner-hooks", `${s.id}.settings.json`), "utf8"));
  const nonce: string = settings.hooks.Stop[0].hooks[0].command.match(/--nonce ([0-9a-f]+)/)[1];
  const hook = (event: string, extra: Record<string, unknown> = {}) => s.receberHook({ agentId: s.id, event, nonce, ...extra });
  // O que o runner escreveria no terminal, sem tocar no Claude falso.
  const escritas: string[] = [];
  // Captura no PTY (e não em s.escrever) para o contador de entradas manuais correr o caminho real.
  s.proc!.write = (t: string) => void escritas.push(t);
  hook("UserPromptSubmit");
  return { s, hook, escritas, hooks };
}
const abrirPergunta = (hook: (e: string, x?: Record<string, unknown>) => unknown, id = "toolu_P") =>
  hook("PreToolUse", { toolName: "AskUserQuestion", toolUseId: id });

test("pergunta respondida: todas as teclas, na ordem, e o estado expõe o pendenteId", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  assert.equal(s.estado.motivo, "pergunta");
  assert.equal(s.estado.pendenteId, "toolu_P");
  const r = await s.responderPergunta("toolu_P", ["2", "azul", "\r", "1"]);
  assert.deepEqual(r, { ok: true, teclas: 4 });
  assert.deepEqual(escritas, ["2", "azul", "\r", "1"]);
  assert.equal(s.respondendoPergunta, false, "a trava é liberada no fim");
  hook("PostToolUse", { toolName: "AskUserQuestion" });
  assert.equal(s.estado.pendenteId, null, "sair de waiting_input limpa o id");
});

test("o estado muda para permissão no meio: para sem escrever o resto e diz em que passo", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  const real = s.proc!;
  const escreveu = real.write;
  real.write = (t: string) => {
    escreveu(t);
    if (escritas.length === 1) {
      // A pessoa respondeu pelo terminal e o agente já pede permissão de um Bash.
      hook("PostToolUse", { toolName: "AskUserQuestion" });
      hook("PreToolUse", { toolName: "Bash", toolUseId: "toolu_B" });
      hook("Notification");
    }
  };
  const r = await s.responderPergunta("toolu_P", ["2", "\r", "1"]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 409);
  assert.equal(r.code, "PERGUNTA_MUDOU");
  assert.match(r.erro, /parou na tecla 1 de 3/);
  assert.match(r.comoResolver, /aba Sessões/);
  assert.deepEqual(escritas, ["2"], "o '1' que aprovaria o Bash não foi escrito");
  assert.equal(s.estado.motivo, "permissao");
  assert.equal(s.estado.pendenteId, "toolu_B");
});

test("pergunta de outro id, ou que não está aberta: 409 sem escrita", async () => {
  const { s, hook, escritas } = await nova();
  let r = await s.responderPergunta("toolu_P", ["1"]);
  assert.ok(!r.ok && r.code === "NAO_ESPERA_PERGUNTA");
  abrirPergunta(hook, "toolu_NOVA");
  r = await s.responderPergunta("toolu_VELHA", ["1"]);
  assert.ok(!r.ok && r.code === "PERGUNTA_DIFERENTE" && r.status === 409);
  assert.deepEqual(escritas, []);
});

test("o processo trocado no meio da resposta: para sem escrever", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  const real = s.proc!;
  const escreveu = real.write;
  real.write = (t: string) => {
    escreveu(t);
    s.proc = { fake: true } as never; // o runner reiniciou o agente e subiu outro PTY
  };
  const r = await s.responderPergunta("toolu_P", ["2", "1"]);
  s.proc = real;
  assert.ok(!r.ok && r.code === "PERGUNTA_MUDOU");
  assert.deepEqual(escritas, ["2"]);
});

test("resposta em andamento: segunda resposta e permissão recusadas; a trava cai no fim", async () => {
  const { s, hook, escritas } = await nova(80);
  abrirPergunta(hook);
  const primeira = s.responderPergunta("toolu_P", ["2", "1"]);
  const segunda = await s.responderPergunta("toolu_P", ["3"]);
  assert.ok(!segunda.ok && segunda.code === "RESPOSTA_EM_ANDAMENTO");
  assert.equal(s.respondendoPergunta, true);
  assert.deepEqual(await primeira, { ok: true, teclas: 2 });
  assert.deepEqual(escritas, ["2", "1"]);
  // Permissão com a trava ligada (a pergunta já saiu da tela): também recusa.
  hook("PostToolUse", { toolName: "AskUserQuestion" });
  hook("PreToolUse", { toolName: "Bash", toolUseId: "toolu_B" });
  hook("Notification");
  s.respondendoPergunta = true;
  const p = s.responderPermissao("aprovar");
  s.respondendoPergunta = false;
  assert.ok(!p.ok && p.code === "RESPOSTA_EM_ANDAMENTO" && p.status === 409);
  assert.equal(escritas.length, 2);
});

test("responderPermissao com pergunta aberta: 409 E_PERGUNTA_NAO_PERMISSAO, sem escrita", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  const r = s.responderPermissao("aprovar");
  assert.ok(!r.ok && r.status === 409 && r.code === "E_PERGUNTA_NAO_PERMISSAO");
  assert.match((r as { erro: string }).erro, /pergunta de escolha, não uma permissão/);
  assert.deepEqual(escritas, []);
});

test("permissão: o id da tela diferente do pendente é 409 sem escrita; igual (ou ausente) aprova", async () => {
  const { s, hook, escritas } = await nova();
  hook("PreToolUse", { toolName: "Bash", toolUseId: "toolu_B" });
  hook("Notification");
  assert.equal(s.estado.motivo, "permissao");
  assert.equal(s.estado.pendenteId, "toolu_B", "o PreToolUse vale para todas as ferramentas: o id da permissão é conhecido");
  const velha = s.responderPermissao("aprovar", "toolu_ANTIGA");
  assert.ok(!velha.ok && velha.code === "PERMISSAO_DIFERENTE" && velha.status === 409);
  assert.deepEqual(escritas, []);
  assert.deepEqual(s.responderPermissao("aprovar", "toolu_B"), { ok: true });
  assert.deepEqual(escritas, ["1"]);
  escritas.length = 0;
  hook("UserPromptSubmit");
  hook("PreToolUse", { toolName: "Bash", toolUseId: "toolu_C" });
  hook("Notification");
  assert.deepEqual(s.responderPermissao("negar"), { ok: true }, "sem id (tela antiga) segue como antes");
});

test("o handler do hook repassa o tool_use_id do stdin e o runner o recebe como toolUseId", async () => {
  const { s, hooks } = await nova();
  const pasta = fs.mkdtempSync(path.join(amb.raiz, "handler-"));
  const arquivo = path.join(pasta, "h.mjs");
  fs.writeFileSync(arquivo, HOOK_HANDLER_SOURCE);
  const antes = hooks.recebidos.length;
  const r = spawnSync(process.execPath, [arquivo, "--event", "PreToolUse", "--agent", s.id, "--port", String(hooks.porta), "--nonce", "errado"], {
    input: JSON.stringify({ tool_name: "Bash", tool_use_id: "toolu_01NFh", tool_input: { command: "ls" } }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  await esperarAte(() => hooks.recebidos.length > antes, 3_000, "o hook chegar");
  const chegou = hooks.recebidos[hooks.recebidos.length - 1];
  assert.equal(chegou.toolName, "Bash");
  assert.equal(chegou.toolUseId, "toolu_01NFh");
  await dormir(10);
});

test("pergunta dupla com tecla manual antes da resposta pelo chat: PERGUNTA_JA_MEXIDA e nada escrito", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  s.escrever("2"); // a pessoa respondeu a primeira pelo terminal
  escritas.length = 0;
  const r = await s.responderPergunta("toolu_P", ["2", "1", "\r"]);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.status, 409);
  assert.equal(r.code, "PERGUNTA_JA_MEXIDA");
  assert.match(r.erro, /Termine pelo terminal, na aba Sessões/);
  assert.deepEqual(escritas, []);
  assert.equal(s.respondendoPergunta, false);
});

test("entradas manuais de antes da pergunta abrir não bloqueiam; uma pergunta nova zera o marco", async () => {
  const { s, hook, escritas } = await nova();
  s.escrever("x");
  abrirPergunta(hook, "toolu_A");
  assert.deepEqual(await s.responderPergunta("toolu_A", ["1"]), { ok: true, teclas: 1 });
  assert.equal(s.entradasManuais, 1, "a resposta do próprio runner não conta");
  hook("PostToolUse", { toolName: "AskUserQuestion" });
  s.escrever("y");
  abrirPergunta(hook, "toolu_B");
  assert.deepEqual(await s.responderPergunta("toolu_B", ["2"]), { ok: true, teclas: 1 });
  assert.deepEqual(escritas, ["x", "1", "y", "2"]);
});

test("tecla manual no meio da sequência: para sem escrever o resto (PERGUNTA_MUDOU)", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  const real = s.proc!;
  const escreveu = real.write;
  real.write = (t: string) => {
    escreveu(t);
    if (escritas.length === 1) s.escrever("9"); // alguém digita no terminal durante a pausa
  };
  const r = await s.responderPergunta("toolu_P", ["2", "1", "\r"]);
  assert.ok(!r.ok && r.code === "PERGUNTA_MUDOU");
  assert.match((r as { erro: string }).erro, /parou na tecla 1 de 3/);
  assert.deepEqual(escritas, ["2", "9"], "as teclas restantes não foram escritas");
});

test("segunda resposta ao mesmo id antes do PostToolUse: PERGUNTA_JA_RESPONDIDA e nada escrito", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  assert.deepEqual(await s.responderPergunta("toolu_P", ["2", "1"]), { ok: true, teclas: 2 });
  const r = await s.responderPergunta("toolu_P", ["2", "1"]);
  assert.ok(!r.ok && r.code === "PERGUNTA_JA_RESPONDIDA" && r.status === 409);
  assert.deepEqual(escritas, ["2", "1"]);
});

test("envio interrompido: nova tentativa ao mesmo id é recusada; id novo funciona", async () => {
  const { s, hook, escritas } = await nova();
  abrirPergunta(hook);
  const real = s.proc!;
  const escreveu = real.write;
  real.write = (t: string) => {
    escreveu(t);
    if (escritas.length === 1) s.escrever("9");
  };
  const a = await s.responderPergunta("toolu_P", ["2", "1", "\r"]);
  assert.ok(!a.ok && a.code === "PERGUNTA_MUDOU");
  real.write = escreveu;
  const b = await s.responderPergunta("toolu_P", ["1"]);
  assert.ok(!b.ok && b.code === "PERGUNTA_JA_RESPONDIDA" && b.status === 409);
  assert.deepEqual(escritas, ["2", "9"]);
  hook("PostToolUse", { toolName: "AskUserQuestion" });
  abrirPergunta(hook, "toolu_Q");
  assert.deepEqual(await s.responderPergunta("toolu_Q", ["1"]), { ok: true, teclas: 1 });
});

test("pergunta cancelada (Esc) seguida de StopFailure: sai de waiting_input e libera o pendenteId", async () => {
  const { s, hook } = await nova();
  abrirPergunta(hook);
  assert.equal(s.estado.motivo, "pergunta");
  hook("StopFailure", { error: "rate_limit" });
  assert.notEqual(s.estado.status, "waiting_input");
  assert.equal(s.estado.motivo ?? null, null);
  assert.equal(s.estado.pendenteId ?? null, null);
});
