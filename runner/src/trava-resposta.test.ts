import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { TRAVA_RESPOSTA_SOURCE } from "./trava-resposta-source.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trava-resposta-"));
const script = path.join(dir, "trava-resposta.mjs");
fs.writeFileSync(script, TRAVA_RESPOSTA_SOURCE, "utf8");
const log = path.join(dir, "trava-resposta.log");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const DG = '<dgchat from="Ana" chat="c_x" msg="p1" ts="2026-11-13T10:00:00Z">oi, tudo bem?</dgchat>';
const WA = '<canal-externo origem="whatsapp" de="+5511999999999" msg="w1" ts="2026-11-13T10:00:00Z">oi</canal-externo>';
const PLAT = '<plataforma recado="x">aviso interno</plataforma>';

const fala = (texto: string) => ({ type: "user", message: { role: "user", content: texto } });
const falaEmBlocos = (texto: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: texto }] } });
const texto = (t: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const uso = (name: string, id = "t1") => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
const resultado = (id = "t1") => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const resultadoComErro = (id: string, conteudo: unknown) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: conteudo }] } });

function transcript(linhas: unknown[]): string {
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, linhas.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

function rodar(stdin: string, args: string[] = []): { saida: string; codigo: number | null } {
  const r = spawnSync(process.execPath, [script, ...args], { input: stdin, encoding: "utf8", timeout: 8000 });
  return { saida: r.stdout, codigo: r.status };
}
const evento = (linhas: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ transcript_path: transcript(linhas), ...extra });
const lerLog = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");

test.beforeEach(() => fs.rmSync(log, { force: true }));

test("turno dgchat com texto e sem reply: bloqueia citando mcp__dgchat__reply e loga", () => {
  const r = rodar(evento([fala(DG), texto("Oi! Tudo bem sim.")]));
  assert.equal(r.codigo, 0);
  const j = JSON.parse(r.saida);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /mcp__dgchat__reply/);
  assert.match(lerLog(), /bloqueou/);
  assert.doesNotMatch(lerLog(), /Tudo bem sim|oi, tudo bem/, "o log não guarda o conteúdo das mensagens");
});

test("fala em blocos de texto também é reconhecida", () => {
  const r = rodar(evento([falaEmBlocos(DG), texto("resposta solta")]));
  assert.equal(JSON.parse(r.saida).decision, "block");
});

test("turno dgchat com tool_use de reply: passa", () => {
  const r = rodar(evento([fala(DG), uso("mcp__dgchat__reply"), resultado(), texto("feito")]));
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, "");
});

test("send_file também conta como resposta", () => {
  const r = rodar(evento([fala(DG), uso("mcp__dgchat__send_file"), resultado(), texto("feito")]));
  assert.equal(r.saida, "");
});

test("turno iniciado por <plataforma> sem reply: passa", () => {
  const r = rodar(evento([fala(PLAT), texto("entendi o recado")]));
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, "");
});

test("texto cru sem envelope: passa", () => {
  assert.equal(rodar(evento([fala("oi"), texto("olá")])).saida, "");
});

test("stop_hook_active true no mesmo turno dgchat sem reply: passa", () => {
  const r = rodar(evento([fala(DG), texto("solto")], { stop_hook_active: true }));
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, "");
  assert.match(lerLog(), /passou-segunda-parada/);
});

test("canal-externo sem reply bloqueia citando whatsapp_reply; com whatsapp_reply passa", () => {
  const ruim = rodar(evento([fala(WA), texto("resposta solta")]));
  const j = JSON.parse(ruim.saida);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /mcp__dgchat__whatsapp_reply/);
  const bom = rodar(evento([fala(WA), uso("mcp__dgchat__whatsapp_reply"), resultado(), texto("ok")]));
  assert.equal(bom.saida, "");
});

test("stdin vazio passa e loga o motivo", () => {
  const r = rodar("");
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, "");
  assert.match(lerLog(), /erro \| stdin vazio/);
});

test("stdin que não é JSON passa e loga", () => {
  const r = rodar("isto não é json");
  assert.equal(r.saida, "");
  assert.match(lerLog(), /stdin não é JSON/);
});

test("transcript inexistente passa e loga o caminho", () => {
  const caminho = path.join(dir, "nao-existe.jsonl");
  const r = rodar(JSON.stringify({ transcript_path: caminho }));
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, "");
  assert.match(lerLog(), new RegExp("transcript ilegível: " + caminho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sem transcript_path passa e loga", () => {
  const r = rodar(JSON.stringify({}));
  assert.equal(r.saida, "");
  assert.match(lerLog(), /sem transcript_path/);
});

test("turno dgchat sem nenhum texto do assistente: passa (silêncio deliberado)", () => {
  assert.equal(rodar(evento([fala(DG)])).saida, "");
  assert.equal(rodar(evento([fala(DG), uso("Bash"), resultado()])).saida, "");
});

test("last_assistant_message preenchido conta como texto", () => {
  const r = rodar(evento([fala(DG)], { last_assistant_message: "escrevi isto" }));
  assert.equal(JSON.parse(r.saida).decision, "block");
});

test("o reply de um turno anterior não conta", () => {
  const r = rodar(evento([
    fala(DG), uso("mcp__dgchat__reply"), resultado(), texto("ok"),
    fala(DG.replace("p1", "p2")), texto("resposta solta"),
  ]));
  assert.equal(JSON.parse(r.saida).decision, "block");
});

test("tool_result depois do dgchat não é confundido com o início do turno", () => {
  const r = rodar(evento([fala(DG), uso("Bash"), resultado(), texto("terminei, mas só em texto")]));
  assert.equal(JSON.parse(r.saida).decision, "block");
  const ok = rodar(evento([fala(DG), uso("mcp__dgchat__reply", "a"), resultado("a"), uso("Bash", "b"), resultado("b"), texto("fim")]));
  assert.equal(ok.saida, "");
});

test("isMeta e isCompactSummary não abrem turno", () => {
  const meta = { ...fala("<dgchat from=\"x\" chat=\"c\">meta</dgchat>"), isMeta: true };
  const r = rodar(evento([fala(PLAT), texto("a"), meta, texto("b")]));
  assert.equal(r.saida, "");
});

test("transcript grande: só o final é lido e a primeira linha parcial é descartada", () => {
  const enchimento = Array.from({ length: 3000 }, () => texto("x".repeat(1000)));
  const r = rodar(evento([fala(DG), ...enchimento, fala(DG.replace("p1", "p9")), texto("solto")]));
  assert.equal(JSON.parse(r.saida).decision, "block");
});

// --- correlação com o resultado da tool ---

test("reply que voltou com is_error não conta: bloqueia", () => {
  const r = rodar(evento([fala(DG), uso("mcp__dgchat__reply", "r1"), resultadoComErro("r1", "falhou"), texto("solto")]));
  assert.equal(JSON.parse(r.saida).decision, "block");
});

test("reply com is_error de entrega incerta conta como entregue (conteúdo string ou blocos)", () => {
  const incerto = "A ponte não respondeu. Pode ou não ter saído. Não repita às cegas.";
  assert.equal(rodar(evento([fala(DG), uso("mcp__dgchat__reply", "r1"), resultadoComErro("r1", incerto), texto("fim")])).saida, "");
  assert.equal(rodar(evento([fala(DG), uso("mcp__dgchat__reply", "r1"), resultadoComErro("r1", [{ type: "text", text: incerto }]), texto("fim")])).saida, "");
});

test("dgchat respondido só com whatsapp_reply bloqueia; canal-externo respondido só com reply bloqueia", () => {
  const a = rodar(evento([fala(DG), uso("mcp__dgchat__whatsapp_reply"), resultado(), texto("fim")]));
  assert.equal(JSON.parse(a.saida).decision, "block");
  const b = rodar(evento([fala(WA), uso("mcp__dgchat__reply"), resultado(), texto("fim")]));
  assert.equal(JSON.parse(b.saida).decision, "block");
});

test("reply sem tool_result passa (conservador)", () => {
  assert.equal(rodar(evento([fala(DG), uso("mcp__dgchat__reply"), texto("fim")])).saida, "");
});

// --- o log nunca guarda conteúdo recebido ---

test("stdin inválido com marcador privado: o marcador não aparece no log", () => {
  rodar("{ MARCADOR_PRIVADO_123 isto não é json");
  assert.match(lerLog(), /stdin não é JSON/);
  assert.doesNotMatch(lerLog(), /MARCADOR_PRIVADO_123/);
});

test("transcript com linha corrompida e marcador privado: o marcador não aparece no log", () => {
  const f = path.join(dir, "corrompido.jsonl");
  fs.writeFileSync(f, "{MARCADOR_PRIVADO_123 quebrado\n" + JSON.stringify(fala(DG)) + "\n" + JSON.stringify(texto("solto")) + "\n");
  const r = rodar(JSON.stringify({ transcript_path: f }));
  assert.equal(JSON.parse(r.saida).decision, "block", "a linha corrompida é ignorada e o resto vale");
  assert.doesNotMatch(lerLog(), /MARCADOR_PRIVADO_123/);
});

test("transcript ilegível: o log leva o caminho e o código, nunca a mensagem do erro", () => {
  rodar(JSON.stringify({ transcript_path: path.join(dir, "nao-existe.jsonl") }));
  assert.match(lerLog(), /Error ENOENT/);
  assert.doesNotMatch(lerLog(), /no such file/i);
});

// --- aviso StopBloqueado ao runner ---

async function comServidor(corpo: (porta: number, recebidos: any[]) => Promise<void>): Promise<void> {
  const recebidos: any[] = [];
  const srv = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      recebidos.push({ url: req.url, corpo: JSON.parse(d) });
      res.setHeader("Content-Type", "application/json");
      res.end('{"success":true}');
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    await corpo((srv.address() as { port: number }).port, recebidos);
  } finally {
    srv.close();
  }
}

function rodarAsync(stdin: string, args: string[]): Promise<{ saida: string; codigo: number | null }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [script, ...args]);
    let saida = "";
    p.stdout.on("data", (c) => (saida += c));
    p.on("close", (codigo) => ok({ saida, codigo }));
    p.stdin.end(stdin);
  });
}

test("ao bloquear, avisa o runner com StopBloqueado; ao passar, não manda nada", async () => {
  await comServidor(async (porta, recebidos) => {
    const args = ["--agent", "ag1", "--port", String(porta), "--nonce", "n".repeat(8)];
    const ok = await rodarAsync(evento([fala(DG), uso("mcp__dgchat__reply"), resultado(), texto("fim")], { session_id: "s1" }), args);
    assert.equal(ok.saida, "");
    assert.equal(recebidos.length, 0);
    const ruim = await rodarAsync(evento([fala(DG), texto("solto")], { session_id: "s1" }), args);
    assert.equal(JSON.parse(ruim.saida).decision, "block");
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0].url, "/api/agent-hook");
    assert.deepEqual(recebidos[0].corpo, { agentId: "ag1", nonce: "n".repeat(8), event: "StopBloqueado", sessionId: "s1" });
  });
});

test("com a porta fechada, o block sai igual e o log registra a falha do aviso", async () => {
  const srv = http.createServer();
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const porta = (srv.address() as { port: number }).port;
  await new Promise<void>((ok) => srv.close(() => ok()));
  const r = await rodarAsync(evento([fala(DG), texto("solto")]), ["--agent", "ag1", "--port", String(porta), "--nonce", "x"]);
  assert.equal(r.codigo, 0);
  assert.equal(JSON.parse(r.saida).decision, "block");
  assert.match(lerLog(), /aviso StopBloqueado ao runner falhou/);
});
