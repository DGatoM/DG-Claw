import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

function transcript(linhas: unknown[]): string {
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, linhas.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

function rodar(stdin: string): { saida: string; codigo: number | null } {
  const r = spawnSync(process.execPath, [script], { input: stdin, encoding: "utf8", timeout: 8000 });
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
