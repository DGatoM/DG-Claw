import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { abrirServidorDeHooks, esperarAte, lerTexto, logarClaude, prepararAmbiente } from "./apoio-teste.js";

const amb = prepararAmbiente("sessao-parar");
const { Sessao } = await import("./sessao.js");
logarClaude(amb);

let n = 0;
const abertas: Array<{ parar(m: string): void }> = [];
const servidores: Array<{ fechar(): void }> = [];
async function nova() {
  n += 1;
  const id = `parar-${n}`;
  const pasta = path.join(amb.estado, id);
  fs.mkdirSync(pasta, { recursive: true });
  const ref: { s?: InstanceType<typeof Sessao> } = {};
  const hooks = await abrirServidorDeHooks(() => ref.s);
  const cfg = { name: id, cwd: amb.casa, initialPrompt: "", provider: "local-cli", permissionMode: "bypassPermissions" };
  const s = new Sessao({ id, slug: id, config: cfg as never }, hooks.porta, {
    arquivoDeEstado: path.join(pasta, "runner-state.json"),
    pastaDeEstado: pasta,
  } as never);
  ref.s = s;
  abertas.push(s);
  servidores.push(hooks);
  return s;
}
test.after(() => {
  for (const s of abertas) s.parar("fim do arquivo de testes");
  for (const h of servidores) h.fechar();
});

const pidDe = (s: unknown): number => (s as { proc: { pid: number } }).proc.pid;
function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, "ESRCH");
    return false;
  }
}

test("pararEEsperar: CLI que sai no SIGHUP, só resolve com o processo antigo já morto", async () => {
  const s = await nova();
  await s.subir("nova");
  await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
  const pid = pidDe(s);
  assert.equal(vivo(pid), true);
  await s.pararEEsperar("teste");
  assert.equal(vivo(pid), false, "o pid antigo não pode existir quando a promessa resolve");
  assert.equal(s.temPtyVivo(), false);
});

test("pararEEsperar: sem PTY volta na hora e sem erro", async () => {
  const s = await nova();
  await s.pararEEsperar("nada para parar");
});

test("pararEEsperar: CLI que ignora o SIGHUP é morto com SIGKILL depois do prazo, e o log diz isso", async () => {
  process.env.FAKE_IGNORAR_HUP = "1";
  try {
    const s = await nova();
    await s.subir("nova");
    await esperarAte(() => s.estado.status === "idle", 8_000, "o SessionStart virar idle");
    const pid = pidDe(s);
    // O SIGKILL vai para -pid: isso só é seguro se o CLI for líder do próprio grupo (o node-pty
    // faz setsid), e esse grupo nunca pode ser o do runner. Campo 5 do /proc/<pid>/stat = pgrp.
    const grupoDe = (p: number) => Number(fs.readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[2]);
    assert.equal(grupoDe(pid), pid, "o CLI é líder do próprio grupo");
    assert.notEqual(grupoDe(pid), grupoDe(process.pid), "o grupo do CLI não é o do runner");
    const inicio = Date.now();
    await s.pararEEsperar("teste teimoso", 300);
    assert.ok(Date.now() - inicio >= 250, "esperou o prazo antes de forçar");
    assert.equal(vivo(pid), false, "o pid antigo não pode existir quando a promessa resolve");
    assert.match(lerTexto(amb.logDoRunner), new RegExp(`pid ${pid}\\) não saiu em 0\\.3s com o SIGHUP.*teste teimoso.*SIGKILL`));
  } finally {
    delete process.env.FAKE_IGNORAR_HUP;
  }
});
