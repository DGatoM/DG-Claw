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

test("negar permissão e interromper em menos de 3 s: 429 (o Esc da permissão também conta)", async () => {
  const s = await nova();
  const { escritas, rel } = falso(s);
  s.estado.status = "waiting_input";
  assert.equal(s.responderPermissao("negar").ok, true);
  assert.deepEqual(escritas, ["\u001b"]);
  rel.t += 500;
  const r = s.interromper();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MUITO_RAPIDO");
  assert.equal(escritas.length, 1);
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
