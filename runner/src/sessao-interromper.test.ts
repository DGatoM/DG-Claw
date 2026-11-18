import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { abrirServidorDeHooks, esperarAte, portaLivre, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-interromper");
const TOKEN = "teste-" + "c".repeat(40);
fs.writeFileSync(path.join(amb.raiz, "runner.token"), TOKEN + "\n", { mode: 0o600 });
process.env.RUNNER_TOKEN_FILE = path.join(amb.raiz, "runner.token");
const { Sessao } = await import("./sessao.js");
const { GerenteDeSessoes } = await import("./sessoes.js");
const { criarServidor } = await import("./servidor.js");
const { lerDescritor } = await import("./config-runner.js");
const { aoReceberDados, confirmarInterrupcaoDoRollout, desarmarVigiaDaInterrupcao } = await import("./sessao/terminal.js");
const { aplicarEvento } = await import("./sessao/eventos.js");
const { MascaraDeFluxo } = await import("./mascara.js");

const servidores: Array<{ fechar(): void }> = [];
let n = 0;
async function nova() {
  n += 1;
  const id = `int-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const hooks = await abrirServidorDeHooks(() => undefined);
  servidores.push(hooks);
  const cfg = { name: id, cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions" };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
  } as never);
  return s;
}

/** Troca o PTY por um falso que só anota o que foi escrito, e o relógio por um que o teste controla. */
function falso(s: InstanceType<typeof Sessao>) {
  const escritas: string[] = [];
  const rel = { t: 1_000_000 };
  (s as unknown as { proc: unknown }).proc = { write: (t: string) => escritas.push(t), pid: 0 };
  s.agora = () => rel.t;
  s.estado.status = "working";
  return { escritas, rel };
}

test.after(() => {
  for (const h of servidores) h.fechar();
});

test("interromper sem PTY: 409 NO_PTY e nada escrito", async () => {
  const s = await nova();
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.equal(r.code, "NO_PTY");
    assert.match(r.erro, /não há o que parar/);
  }
});

test("interromper com PTY: escreve exatamente um Esc e devolve o status de antes", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  s.estado.status = "working";
  const r = s.interromper();
  assert.equal(r.ok, true);
  assert.deepEqual(escritas, ["\u001b"]);
  if (r.ok) {
    assert.equal(r.statusAntes, "working");
    assert.equal(r.provedor, "claude");
    assert.match(r.enviadoEm, /^\d{4}-\d\d-\d\dT/);
  }
});

test("segundo pedido em menos de 3 s: 429 MUITO_RAPIDO com espereS e nada escrito; depois de 3 s passa", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  assert.equal(s.interromper().ok, true);
  rel.t += 1000;
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 429);
    assert.equal(r.code, "MUITO_RAPIDO");
    assert.ok((r.espereS ?? 0) > 0 && (r.espereS ?? 0) <= 2);
    assert.match(r.erro, /menu de voltar/);
  }
  assert.equal(escritas.length, 1);
  rel.t += 2000;
  assert.equal(s.interromper().ok, true);
  assert.equal(escritas.length, 2);
});

test("negar permissão e depois Parar em menos de 3 s: 429 (o Esc da permissão também conta)", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  s.estado.status = "waiting_input";
  assert.equal(s.responderPermissao("negar").ok, true);
  assert.deepEqual(escritas, ["\u001b"]);
  s.estado.status = "working";
  rel.t += 500;
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MUITO_RAPIDO");
  assert.equal(escritas.length, 1);
});

test("Parar e depois negar permissão em menos de 3 s: 429 com espereS e nada escrito; passados 3 s, nega", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  s.estado.status = "working";
  assert.equal(s.interromper().ok, true);
  s.estado.status = "waiting_input";
  rel.t += 1000;
  const r = s.responderPermissao("negar");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 429);
    assert.equal(r.code, "MUITO_RAPIDO");
    assert.ok((r.espereS ?? 0) > 0);
  }
  assert.equal(escritas.length, 1);
  rel.t += 3000;
  assert.equal(s.responderPermissao("negar").ok, true);
  assert.equal(escritas.length, 2);
});

test("cancelar pergunta (Esc) e depois Parar em menos de 3 s: 429", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  s.estado.status = "working";
  (s as unknown as { escreverSemContar(t: string): void }).escreverSemContar("\u001b");
  assert.deepEqual(escritas, ["\u001b"]);
  rel.t += 500;
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MUITO_RAPIDO");
  assert.equal(escritas.length, 1);
});

test("esperando permissão ou pergunta: 409 ESPERANDO_DECISAO e nada escrito", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  for (const motivo of [null, "pergunta"] as const) {
    s.estado.status = "waiting_input";
    s.estado.motivo = motivo as never;
    const r = s.interromper();
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409);
      assert.equal(r.code, "ESPERANDO_DECISAO");
      assert.match(r.comoResolver, /cartão da permissão ou da pergunta/);
    }
  }
  assert.deepEqual(escritas, []);
});

test("fora de working (idle, spawning): 409 NAO_TRABALHANDO e nada escrito", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  for (const st of ["idle", "spawning"] as const) {
    s.estado.status = st;
    const r = s.interromper();
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 409);
      assert.equal(r.code, "NAO_TRABALHANDO");
      assert.match(r.erro, /nada foi enviado/);
    }
  }
  assert.deepEqual(escritas, []);
});

test("Parar e depois /input com Esc cru em menos de 3 s: 429 sem escrever; passados 3 s, escreve", async () => {
  const porta = await portaLivre();
  const descritor = lerDescritor();
  const gerente = new GerenteDeSessoes(descritor, porta);
  const servidor: http.Server = criarServidor(gerente);
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  try {
    const { escritas, rel } = falso(gerente.principal);
    assert.equal(gerente.principal.interromper().ok, true);
    const input = async (texto: string) => {
      const r = await fetch(`http://127.0.0.1:${porta}/api/agents/${descritor.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: texto, submit: false }),
      });
      return { status: r.status, corpo: (await r.json()) as any };
    };
    rel.t += 500;
    const barrado = await input("\u001b");
    assert.equal(barrado.status, 429);
    assert.equal(barrado.corpo.code, "MUITO_RAPIDO");
    assert.ok(barrado.corpo.espereS > 0);
    assert.equal(escritas.length, 1);
    rel.t += 3000;
    assert.equal((await input("\u001b")).status, 200);
    assert.equal(escritas.length, 2);
  } finally {
    (gerente.principal as unknown as { proc: unknown }).proc = null;
    gerente.pararTodas("fim dos testes");
    servidor.closeAllConnections?.();
    servidor.close();
  }
});

test("Parar e depois cancelar pergunta (Esc) em menos de 3 s: 429 antes de escrever qualquer tecla", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  assert.equal(s.interromper().ok, true);
  s.estado.status = "waiting_input";
  s.estado.motivo = "pergunta";
  s.estado.pendenteId = "tu1";
  rel.t += 500;
  const r = await s.responderPergunta("tu1", ["\u001b"]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 429);
    assert.equal(r.code, "MUITO_RAPIDO");
  }
  assert.equal(escritas.length, 1);
  assert.equal(s.perguntaTentada, null, "a pergunta não foi marcada como respondida");
});

const desarmarVigia = (s: InstanceType<typeof Sessao>) => desarmarVigiaDaInterrupcao(s);
const PROCESSA = (s: InstanceType<typeof Sessao>, texto: string, m = new MascaraDeFluxo([])) => aoReceberDados(s, texto, m);

/** Grava o transcript da sessão; `em` é o deslocamento em ms em relação a agora. */
function transcriptDe(s: InstanceType<typeof Sessao>, linhas: Array<[Record<string, unknown>, number]>) {
  s.estado.sessionId ??= `sess-int-${n}`;
  const arquivo = path.join(amb.claudeDir, "projects", "proj-teste", `${s.estado.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, linhas.map(([o, em]) => JSON.stringify({ ...o, timestamp: new Date(Date.now() + em).toISOString() })).join("\n") + "\n");
}
const INTERROMPIDO = { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
const FALA = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "trabalhando" }] } };

test("Claude: transcript com a interrupção EXATA depois do Esc => idle e a fila é solta", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  assert.equal(s.interromper().ok, true);
  s.enfileirarQuandoOcioso("mensagem presa na fila");
  assert.equal(escritas.some((t) => t.includes("mensagem presa")), false);
  transcriptDe(s, [[FALA, -50], [INTERROMPIDO, 50]]);
  await esperarAte(() => s.estado.status === "idle", 3_000, "o transcript confirmar");
  assert.equal(s.estado.statusReason, "runner:interrompido");
  await esperarAte(() => escritas.some((t) => t.includes("mensagem presa na fila")), 3_000, "a mensagem da fila ser escrita");
  assert.equal(s.vigiaInterrupcao, null);
});

test("Claude: a variante 'for tool use' e o conteúdo em string também valem", async () => {
  const s = await nova();
  falso(s);
  assert.equal(s.interromper().ok, true);
  transcriptDe(s, [[{ type: "user", message: { role: "user", content: "[Request interrupted by user for tool use]" } }, 50]]);
  await esperarAte(() => s.estado.status === "idle", 3_000, "o transcript confirmar");
});

test("Claude: texto que só começa pelo prefixo, ou interrupção anterior ao Esc, não contam", async () => {
  const s = await nova();
  falso(s);
  assert.equal(s.interromper().ok, true);
  transcriptDe(s, [[{ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user] e mais texto" }] } }, 50]]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(s.estado.status, "working");
  transcriptDe(s, [[INTERROMPIDO, -5000]]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(s.estado.status, "working");
  transcriptDe(s, [[INTERROMPIDO, 50], [FALA, 80]]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(s.estado.status, "working", "a última entrada é fala do agente");
  desarmarVigia(s);
});

test("Claude: linhas 'null', número, array e lixo na cauda são ignoradas", async () => {
  const s = await nova();
  falso(s);
  assert.equal(s.interromper().ok, true);
  transcriptDe(s, [[INTERROMPIDO, 50]]);
  const arquivo = path.join(amb.claudeDir, "projects", "proj-teste", `${s.estado.sessionId}.jsonl`);
  fs.appendFileSync(arquivo, "null\n7\n[1,2]\nisto não é json\n");
  await esperarAte(() => s.estado.status === "idle", 3_000, "o transcript confirmar");
});

test("exceção dentro da vigia vira aviso e desarma, sem derrubar o runner", async () => {
  const s = await nova();
  falso(s);
  assert.equal(s.interromper().ok, true);
  (s.estado as unknown as { config: unknown }).config = null;
  s.estado.sessionId ??= "sess-int-erro";
  await esperarAte(() => s.vigiaInterrupcao === null, 3_000, "a vigia desarmar");
  assert.equal(s.estado.status, "working");
});

test("UserPromptSubmit no meio desarma a vigia", async () => {
  const s = await nova();
  falso(s);
  assert.equal(s.interromper().ok, true);
  assert.ok(s.vigiaInterrupcao);
  aplicarEvento(s, { event: "UserPromptSubmit" } as never);
  assert.equal(s.vigiaInterrupcao, null);
});

test("segundo Parar com a vigia armada não troca a vigia: vale o horário do primeiro Esc", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  assert.equal(s.interromper().ok, true);
  const v = s.vigiaInterrupcao!;
  const desde = v.desdeMs;
  await new Promise((r) => setTimeout(r, 20));
  rel.t += 3500;
  assert.equal(s.interromper().ok, true);
  assert.equal(escritas.length, 2);
  assert.equal(s.vigiaInterrupcao, v);
  assert.equal(s.vigiaInterrupcao!.desdeMs, desde);
  desarmarVigia(s);
});

test("Codex: aborto do rollout depois do Esc => idle e fila solta; anterior ao Esc não conta", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  (s as unknown as { motor: unknown }).motor = { ...(s.motor as object), provedor: "codex" };
  assert.equal(s.interromper().ok, true);
  PROCESSA(s, "\u001b[1m■ Conversation interrupted\u001b[0m");
  assert.equal(s.estado.status, "working", "a tela não conta");
  assert.equal(confirmarInterrupcaoDoRollout(s, Date.now() - 60_000), false);
  s.enfileirarQuandoOcioso("fila do codex");
  assert.equal(confirmarInterrupcaoDoRollout(s, Date.now() + 10), true);
  assert.equal(s.estado.status, "idle");
  assert.equal(s.estado.statusReason, "runner:interrompido");
  await esperarAte(() => escritas.some((t) => t.includes("fila do codex")), 3_000, "a fila ser solta");
  assert.equal(s.vigiaInterrupcao, null);
  assert.equal(confirmarInterrupcaoDoRollout(s, Date.now() + 10), false, "sem Parar em curso, o Stop normal cuida");
});

test("Codex: lote com aborto seguido de início de turno NÃO solta a fila", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  (s as unknown as { motor: unknown }).motor = { ...(s.motor as object), provedor: "codex" };
  assert.equal(s.interromper().ok, true);
  s.enfileirarQuandoOcioso("não pode sair");
  assert.equal(confirmarInterrupcaoDoRollout(s, Date.now() + 10), true);
  aplicarEvento(s, { event: "UserPromptSubmit" } as never);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.estado.status, "working");
  assert.equal(escritas.some((t) => t.includes("não pode sair")), false);
  assert.equal(s.vigiaInterrupcao, null);
});

test("rollout do Codex: turn_aborted e task_aborted saem marcados como abortados; task_complete não", async () => {
  const { eventoDoRollout } = await import("./provedores/codex-rollout.js");
  const r = (tipo: string) => ({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: tipo } });
  assert.equal(eventoDoRollout(r("turn_aborted"))?.abortado, true);
  assert.equal(eventoDoRollout(r("task_aborted"))?.abortado, true);
  assert.equal(eventoDoRollout(r("task_complete"))?.abortado, undefined);
});

test("respondendo pergunta: 409 RESPOSTA_EM_ANDAMENTO e nada escrito", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  s.respondendoPergunta = true;
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.equal(r.code, "RESPOSTA_EM_ANDAMENTO");
  }
  assert.deepEqual(escritas, []);
});

test("rota POST /api/agents/:id/interromper: token obrigatório, corpo ignorado, 200 e depois 429", async () => {
  const porta = await portaLivre();
  const descritor = lerDescritor();
  const gerente = new GerenteDeSessoes(descritor, porta);
  const servidor: http.Server = criarServidor(gerente);
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  try {
    const { escritas } = falso(gerente.principal);
    const chamar = async (comToken: boolean, corpo?: string) => {
      const r = await fetch(`http://127.0.0.1:${porta}/api/agents/${descritor.id}/interromper`, {
        method: "POST",
        headers: comToken ? { Authorization: `Bearer ${TOKEN}` } : {},
        body: corpo,
      });
      return { status: r.status, corpo: (await r.json()) as any };
    };
    assert.equal((await chamar(false)).status, 401);
    assert.deepEqual(escritas, []);
    const ok = await chamar(true, "texto qualquer que não pode chegar no terminal \u0003");
    assert.equal(ok.status, 200);
    assert.equal(ok.corpo.success, true);
    assert.equal(ok.corpo.data.enviado, true);
    assert.equal(typeof ok.corpo.data.statusAntes, "string");
    assert.deepEqual(escritas, ["\u001b"]);
    const de_novo = await chamar(true);
    assert.equal(de_novo.status, 429);
    assert.equal(de_novo.corpo.success, false);
    assert.equal(de_novo.corpo.code, "MUITO_RAPIDO");
    assert.ok(de_novo.corpo.espereS > 0);
    assert.ok(de_novo.corpo.howToFix);
    assert.equal(escritas.length, 1);
  } finally {
    (gerente.principal as unknown as { proc: unknown }).proc = null;
    gerente.pararTodas("fim dos testes");
    servidor.closeAllConnections?.();
    servidor.close();
  }
});

test("rota POST /pergunta: o 429 da trava do Esc preserva espereS na resposta", async () => {
  const porta = await portaLivre();
  const descritor = lerDescritor();
  const gerente = new GerenteDeSessoes(descritor, porta);
  const servidor: http.Server = criarServidor(gerente);
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  try {
    const sess = gerente.principal;
    falso(sess);
    assert.equal(sess.interromper().ok, true);
    sess.estado.status = "waiting_input";
    sess.estado.motivo = "pergunta";
    sess.estado.pendenteId = "tu9";
    const r = await fetch(`http://127.0.0.1:${porta}/api/agents/${descritor.id}/pergunta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu9", teclas: ["\u001b"] }),
    });
    const corpo = (await r.json()) as any;
    assert.equal(r.status, 429);
    assert.equal(corpo.code, "MUITO_RAPIDO");
    assert.ok(corpo.espereS > 0);
  } finally {
    desarmarVigiaDaInterrupcao(gerente.principal);
    (gerente.principal as unknown as { proc: unknown }).proc = null;
    gerente.pararTodas("fim dos testes");
    servidor.closeAllConnections?.();
    servidor.close();
  }
});
