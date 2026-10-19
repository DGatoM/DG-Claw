import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { pastaTemporaria } from "./apoio-teste.js";
import { MedidorDeUso, deRolloutRateLimits, deStatusline, instanteEmIso, paraResposta, percentualValido, usoDaLinhaDoRollout } from "./uso.js";
import { USO_HANDLER_SOURCE } from "./uso-handler-source.js";

const avisos: string[] = [];
const avisar = (m: string) => void avisos.push(m);
const EPOCH = 1792879374; // segundos

test("percentual: fora de 0..100, NaN, negativo e texto lixo viram null com aviso, e 0 continua 0", () => {
  avisos.length = 0;
  assert.equal(percentualValido(0, "x", avisar), 0);
  assert.equal(percentualValido("42.5", "x", avisar), 42.5);
  assert.equal(percentualValido(100, "x", avisar), 100);
  assert.equal(avisos.length, 0);
  for (const ruim of [-1, 100.5, NaN, Infinity, "abc", "", {}, true]) assert.equal(percentualValido(ruim, "x", avisar), null, String(ruim));
  assert.equal(avisos.length, 8, "cada valor inválido deixa um aviso");
  assert.equal(percentualValido(undefined, "x", avisar), null);
  assert.equal(percentualValido(null, "x", avisar), null);
});

test("horário: segundos, ms, texto numérico e ISO dão o mesmo instante", () => {
  const esperado = new Date(EPOCH * 1000).toISOString();
  assert.equal(instanteEmIso(EPOCH, "x", avisar), esperado);
  assert.equal(instanteEmIso(EPOCH * 1000, "x", avisar), esperado);
  assert.equal(instanteEmIso(String(EPOCH), "x", avisar), esperado);
  assert.equal(instanteEmIso(esperado, "x", avisar), esperado);
  assert.equal(instanteEmIso("amanhã", "x", avisar), null);
  assert.equal(instanteEmIso(0, "x", avisar), null);
  assert.equal(instanteEmIso(null, "x", avisar), null);
});

test("statusline: duas janelas, utilization como sinônimo e janela que falta fica null", () => {
  const l = deStatusline({
    cwd: "/segredo/caminho",
    rate_limits: { five_hour: { used_percentage: 37.5, resets_at: EPOCH }, seven_day: { utilization: 12, resets_at: new Date(EPOCH * 1000).toISOString() } },
  }, avisar);
  assert.deepEqual(l, {
    sessao_5h: { usado_pct: 37.5, zera_em: new Date(EPOCH * 1000).toISOString() },
    semanal: { usado_pct: 12, zera_em: new Date(EPOCH * 1000).toISOString() },
    plano: null,
  });
  const so5 = deStatusline({ rate_limits: { five_hour: { used_percentage: 0, resets_at: EPOCH } } }, avisar);
  assert.equal(so5?.sessao_5h?.usado_pct, 0, "zero medido continua zero");
  assert.equal(so5?.semanal, null, "semanal ausente é null, nunca 0");
});

test("statusline: sem rate_limits, ou só com lixo, é ignorado (null)", () => {
  assert.equal(deStatusline({}, avisar), null);
  assert.equal(deStatusline(null, avisar), null);
  assert.equal(deStatusline({ rate_limits: {} }, avisar), null);
  assert.equal(deStatusline({ rate_limits: { five_hour: { used_percentage: -3, resets_at: EPOCH } } }, avisar), null);
  assert.equal(deStatusline({ rate_limits: { five_hour: { used_percentage: 30 } } }, avisar), null, "percentual sem horário não serve");
});

test("Codex: primary semanal com secondary null (exemplo real) e plano", () => {
  const l = deRolloutRateLimits(
    { limit_id: "codex", primary: { used_percent: 21.0, window_minutes: 10080, resets_at: 1792879374 }, secondary: null, plan_type: "prolite" },
    Date.now(),
    avisar,
  );
  assert.equal(l?.sessao_5h, null);
  assert.equal(l?.semanal?.usado_pct, 21);
  assert.equal(l?.semanal?.zera_em, "2026-10-24T22:02:54.000Z");
  assert.equal(l?.plano, "prolite");
});

test("Codex: 5 h no primary e semanal no secondary; ordem trocada dá o mesmo resultado", () => {
  const a = { used_percent: 5, window_minutes: 300, resets_at: EPOCH };
  const b = { used_percent: 60, window_minutes: 10080, resets_at: EPOCH + 100000 };
  const x = deRolloutRateLimits({ primary: a, secondary: b }, 0, avisar);
  const y = deRolloutRateLimits({ primary: b, secondary: a }, 0, avisar);
  assert.deepEqual(x, y);
  assert.equal(x?.sessao_5h?.usado_pct, 5);
  assert.equal(x?.semanal?.usado_pct, 60);
});

test("Codex: resets_in_seconds soma ao horário do evento; janela estranha é descartada", () => {
  const ts = Date.parse("2026-10-19T12:00:00.000Z");
  const l = deRolloutRateLimits({ primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 3600 } }, ts, avisar);
  assert.equal(l?.sessao_5h?.zera_em, "2026-10-19T13:00:00.000Z");
  avisos.length = 0;
  assert.equal(deRolloutRateLimits({ primary: { used_percent: 10, window_minutes: 720, resets_at: EPOCH } }, ts, avisar), null);
  assert.ok(avisos.some((a) => a.includes("720")));
  assert.equal(deRolloutRateLimits({ primary: { used_percent: 10, resets_at: EPOCH } }, ts, avisar), null);
  assert.equal(deRolloutRateLimits(null, ts, avisar), null);
});

test("linha do rollout: só token_count com rate_limits conta, e leva o horário do evento", () => {
  const linha = {
    timestamp: "2026-10-19T12:00:00.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 1, window_minutes: 300, resets_at: EPOCH } } },
  };
  const u = usoDaLinhaDoRollout(linha, avisar);
  assert.equal(u?.em, Date.parse("2026-10-19T12:00:00.000Z"));
  assert.equal(u?.leitura.sessao_5h?.usado_pct, 1);
  assert.equal(usoDaLinhaDoRollout({ ...linha, payload: { type: "agent_message" } }, avisar), null);
  assert.equal(usoDaLinhaDoRollout({ ...linha, payload: { type: "token_count", rate_limits: null } }, avisar), null);
  assert.equal(usoDaLinhaDoRollout({ ...linha, timestamp: "?" }, avisar), null);
});

test("medidor: persiste em uso.json modo 600, sobrevive a reinício e ignora leitura mais antiga", () => {
  const arq = path.join(pastaTemporaria("uso"), "uso.json");
  const m = new MedidorDeUso(arq, () => Date.parse("2026-10-19T12:00:00.000Z"));
  assert.equal(m.atual("claude").medido_em, null);
  const leitura = deStatusline({ rate_limits: { five_hour: { used_percentage: 40, resets_at: EPOCH } } }, avisar)!;
  assert.equal(m.registrar("claude", leitura, "statusline"), true);
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  const depois = new MedidorDeUso(arq);
  const u = depois.atual("claude");
  assert.equal(u.sessao_5h?.usado_pct, 40);
  assert.equal(u.semanal, null);
  assert.equal(u.fonte, "statusline");
  assert.equal(u.medido_em, "2026-10-19T12:00:00.000Z");
  assert.equal(depois.registrar("claude", leitura, "statusline", Date.parse("2026-10-19T11:00:00.000Z")), false, "leitura antiga não recua");
  assert.equal(depois.atual("claude").medido_em, "2026-10-19T12:00:00.000Z");
});

test("medidor: medição de outro provedor não vale; arquivo corrompido recomeça vazio", () => {
  const dir = pastaTemporaria("uso");
  const arq = path.join(dir, "uso.json");
  const m = new MedidorDeUso(arq);
  m.registrar("claude", { sessao_5h: { usado_pct: 9, zera_em: new Date(EPOCH * 1000).toISOString() }, semanal: null, plano: null }, "statusline");
  assert.equal(m.atual("codex").medido_em, null);
  assert.equal(m.atual("codex").sessao_5h, null);
  fs.writeFileSync(arq, "{ não é json");
  assert.equal(new MedidorDeUso(arq).atual("claude").medido_em, null);
});

test("resposta: janela com horário passado vem vencida:true e mantém o valor velho", () => {
  const uso = {
    provedor: "claude" as const,
    sessao_5h: { usado_pct: 80, zera_em: "2026-10-19T10:00:00.000Z" },
    semanal: { usado_pct: 10, zera_em: "2026-10-25T10:00:00.000Z" },
    plano: null,
    medido_em: "2026-10-19T09:00:00.000Z",
    fonte: "statusline" as const,
  };
  const r = paraResposta(uso, Date.parse("2026-10-19T12:00:00.000Z"));
  assert.deepEqual(r.sessao_5h, { usado_pct: 80, zera_em: "2026-10-19T10:00:00.000Z", vencida: true });
  assert.equal(r.semanal?.vencida, false);
});

// --- o handler do statusLine ---------------------------------------------------------------

function prepararHandler(): { dir: string; arquivo: string } {
  const dir = pastaTemporaria("uso-handler");
  const arquivo = path.join(dir, "runner-uso.mjs");
  fs.writeFileSync(arquivo, USO_HANDLER_SOURCE);
  return { dir, arquivo };
}

async function subirReceptor(): Promise<{ porta: number; corpos: any[]; fechar: () => void }> {
  const corpos: any[] = [];
  const srv = http.createServer((req, res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      corpos.push({ url: req.url, corpo: JSON.parse(d) });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { porta: (srv.address() as { port: number }).port, corpos, fechar: () => srv.close() };
}

function rodar(arquivo: string, porta: number, stdin: string): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [arquivo, "--agent", "ag1", "--port", String(porta), "--nonce", "n0nce"]);
    let saida = "";
    p.stdout.on("data", (c) => (saida += c));
    p.on("close", (codigo) => resolve({ codigo, saida }));
    p.stdin.end(stdin);
  });
}

test("handler: manda só o rate_limits, com nonce, e imprime nada", async () => {
  const { arquivo } = prepararHandler();
  const r = await subirReceptor();
  try {
    const entrada = JSON.stringify({ cwd: "/segredo", cost: { total_cost_usd: 3 }, rate_limits: { five_hour: { used_percentage: 20, resets_at: EPOCH } } });
    const out = await rodar(arquivo, r.porta, entrada);
    assert.equal(out.codigo, 0);
    assert.equal(out.saida, "");
    assert.equal(r.corpos.length, 1);
    assert.equal(r.corpos[0].url, "/api/agent-uso");
    assert.deepEqual(Object.keys(r.corpos[0].corpo).sort(), ["agentId", "nonce", "rate_limits"]);
    assert.ok(!JSON.stringify(r.corpos[0].corpo).includes("segredo"));
  } finally {
    r.fechar();
  }
});

test("handler: segunda chamada dentro de 15 s não envia; carimbo velho libera", async () => {
  const { dir, arquivo } = prepararHandler();
  const r = await subirReceptor();
  try {
    const entrada = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: EPOCH } } });
    await rodar(arquivo, r.porta, entrada);
    const segunda = await rodar(arquivo, r.porta, entrada);
    assert.equal(segunda.codigo, 0);
    assert.equal(r.corpos.length, 1, "o throttle segurou o segundo POST");
    const velho = new Date(Date.now() - 20_000);
    fs.utimesSync(path.join(dir, "ag1.uso.carimbo"), velho, velho);
    await rodar(arquivo, r.porta, entrada);
    assert.equal(r.corpos.length, 2);
  } finally {
    r.fechar();
  }
});

test("handler: stdin vazio, lixo, sem rate_limits e runner fora do ar saem com 0 e sem enviar", async () => {
  const { arquivo } = prepararHandler();
  const r = await subirReceptor();
  try {
    for (const entrada of ["", "não é json", "{}", JSON.stringify({ rate_limits: null })]) {
      const out = await rodar(arquivo, r.porta, entrada);
      assert.equal(out.codigo, 0, `entrada ${JSON.stringify(entrada)}`);
    }
    assert.equal(r.corpos.length, 0);
  } finally {
    r.fechar();
  }
  const { arquivo: outro } = prepararHandler();
  const fora = await rodar(outro, 1, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1, resets_at: EPOCH } } }));
  assert.equal(fora.codigo, 0, "runner fora do ar não pode falhar o Claude");
  assert.equal(spawnSync(process.execPath, ["--check", outro]).status, 0);
});

test("horário fora do intervalo do Date vira null, sem lançar", () => {
  const avisos: string[] = [];
  assert.equal(instanteEmIso(8640000000000001, "teste", (m) => avisos.push(m)), null);
  assert.equal(avisos.length, 1);
  const l = deRolloutRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 1e20 } }, Date.now(), () => {});
  assert.equal(l?.sessao_5h ?? null, null);
});
