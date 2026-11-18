import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { abrirServidorDeHooks, portaLivre, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-interromper");
const TOKEN = "teste-" + "c".repeat(40);
fs.writeFileSync(path.join(amb.raiz, "runner.token"), TOKEN + "\n", { mode: 0o600 });
process.env.RUNNER_TOKEN_FILE = path.join(amb.raiz, "runner.token");
const { Sessao } = await import("./sessao.js");
const { GerenteDeSessoes } = await import("./sessoes.js");
const { criarServidor } = await import("./servidor.js");
const { lerDescritor } = await import("./config-runner.js");

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


test("cancelar pergunta: um Esc só vale sozinho; [Esc, outra tecla] dá 400 TECLAS_INVALIDAS sem escrever", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  s.estado.status = "waiting_input";
  s.estado.motivo = "pergunta";
  s.estado.pendenteId = "tu1";
  for (const teclas of [["\u001b", "1"], ["1", "\u001b"], ["\u001b", "\u001b"]]) {
    const r = await s.responderPergunta("tu1", teclas);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.equal(r.code, "TECLAS_INVALIDAS");
    }
  }
  assert.deepEqual(escritas, []);
  assert.equal(s.perguntaTentada, null);
});

test("compactando (PreCompact): 409 COMPACTANDO e nada escrito", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  s.estado.statusReason = "hook:PreCompact";
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.equal(r.code, "COMPACTANDO");
  }
  assert.deepEqual(escritas, []);
});

test("cancelar pergunta: item que CONTÉM Esc (\"\\u001b1\", \"a\\u001b\") dá 400 TECLAS_INVALIDAS sem escrever nem marcar a pergunta", async () => {
  const s = await nova();
  const { escritas } = falso(s);
  s.estado.status = "waiting_input";
  s.estado.motivo = "pergunta";
  s.estado.pendenteId = "tu1";
  for (const teclas of [["\u001b1"], ["a\u001b"]]) {
    const r = await s.responderPergunta("tu1", teclas);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.equal(r.code, "TECLAS_INVALIDAS");
    }
  }
  assert.deepEqual(escritas, []);
  assert.equal(s.perguntaTentada, null);
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
    (gerente.principal as unknown as { proc: unknown }).proc = null;
    gerente.pararTodas("fim dos testes");
    servidor.closeAllConnections?.();
    servidor.close();
  }
});

test("rota POST /input: Esc sozinho com injectWhenIdle ou submit padrão => 400 ESC_SO_IMEDIATO, sem enfileirar", async () => {
  const porta = await portaLivre();
  const descritor = lerDescritor();
  const gerente = new GerenteDeSessoes(descritor, porta);
  const servidor: http.Server = criarServidor(gerente);
  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  try {
    const { escritas } = falso(gerente.principal);
    const r = await fetch(`http://127.0.0.1:${porta}/api/agents/${descritor.id}/input`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "\u001b", injectWhenIdle: true }),
    });
    const corpo = (await r.json()) as any;
    assert.equal(r.status, 400);
    assert.equal(corpo.code, "ESC_SO_IMEDIATO");
    assert.equal(gerente.principal.tamanhoDaFila(), 0);
    assert.deepEqual(escritas, []);
  } finally {
    (gerente.principal as unknown as { proc: unknown }).proc = null;
    gerente.pararTodas("fim dos testes");
    servidor.closeAllConnections?.();
    servidor.close();
  }
});
