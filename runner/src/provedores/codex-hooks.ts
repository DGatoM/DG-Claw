// Hooks nativos do Codex para os agentes do DG Claw.
//
// O Claude recebe os hooks do plugin (recall de memória, quadro de avisos, contexto de início) pelo
// plugin e os `promptHooks` pelo `--settings`. O Codex 0.163 tem hooks nativos, mas só roda um hook
// depois de CONFIADO. Este módulo faz as duas metades, só com o que o DG Claw distribui:
//
//   1. grava (mesclando) o `<CODEX_HOME>/hooks.json` com os hooks do DG Claw;
//   2. grava no `<CODEX_HOME>/config.toml` a confiança SÓ desses hooks: uma seção
//      `[hooks.state."<arquivo>:<evento>:<grupo>:<posição>"]` com `trusted_hash`.
//
// Nunca se usa `--dangerously-bypass-hook-trust`: um `.codex/hooks.json` de um repositório clonado
// pelo agente continua `untrusted` e não roda (o teste codex-hooks.test.ts confere).
//
// Medido em 07/11/2026 com o Codex 0.163.0 (`hooks/list` do app-server):
//   - o arquivo do usuário é `<CODEX_HOME>/hooks.json`; a chave do hook é
//     `<caminho do hooks.json>:<evento em snake_case>:<índice do grupo>:<índice do hook no grupo>`;
//   - `currentHash` = "sha256:" + sha256 do JSON compacto, de chaves ordenadas, de
//     `{event_name, matcher (só se houver), hooks: [{type, command, timeout, async:false, statusMessage (só se houver)}]}`.
//     O teste confere o cálculo contra o `currentHash` que o próprio Codex devolve, quando há codex.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

/** Marca os comandos que são do DG Claw: tudo o que começa assim, no hooks.json, é regravado a cada spawn. */
export const MARCA_DO_DGCLAW = "DGCLAW_MOTOR=codex ";

export type EventoDoCodex = "SessionStart" | "UserPromptSubmit";

export interface HookDoDgclaw {
  evento: EventoDoCodex;
  /** Casa com o `source` do SessionStart (ex.: "compact|clear"). */
  matcher?: string;
  command: string;
  timeout: number;
}

const SNAKE: Record<EventoDoCodex, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
};

/** JSON compacto com as chaves de todo objeto em ordem, que é o que o Codex faz antes do sha256. */
function jsonOrdenado(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonOrdenado).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonOrdenado(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function hashDoHook(h: { evento: EventoDoCodex; matcher?: string; command: string; timeout: number; statusMessage?: string }): string {
  const handler: Record<string, unknown> = { type: "command", command: h.command, timeout: h.timeout, async: false };
  if (h.statusMessage) handler.statusMessage = h.statusMessage;
  const grupo: Record<string, unknown> = { event_name: SNAKE[h.evento], hooks: [handler] };
  if (h.matcher) grupo.matcher = h.matcher;
  return "sha256:" + createHash("sha256").update(jsonOrdenado(grupo)).digest("hex");
}

/**
 * Acha a raiz do plugin do DG Claw (a pasta que tem `hooks/dispatch.ts`) subindo a partir deste
 * arquivo: no container é `/opt/dgclaw/app` (da imagem, de root, fora da casa do agente); no
 * repositório é a raiz dele. Nunca usa `.dgclaw/plugin`, que fica na casa do agente e ele pode escrever.
 */
export function raizDoPlugin(partida: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = partida;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "hooks", "dispatch.ts"))) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
  return null;
}

/** O `bun` está no PATH do agente? Os hooks do plugin são `bun .../dispatch.ts`, como no Claude. */
export function achaNoPath(binario: string, pathVar: string | undefined): boolean {
  for (const d of (pathVar ?? "").split(path.delimiter)) {
    if (!d) continue;
    try {
      fs.accessSync(path.join(d, binario), fs.constants.X_OK);
      return true;
    } catch {
      /* próximo */
    }
  }
  return false;
}

export interface EntradaDeHooks {
  /** Pasta do plugin (de root). */
  raiz: string | null;
  /** O agente está num workspace servidor do DG Claw (tem `.dgclaw/config.sh`). */
  temWorkspace: boolean;
  temBun: boolean;
  promptHooks: string[];
}

/** Os hooks que este agente recebe. Mesmos comandos e tempos do `hooks/hooks.json` do Claude. */
export function hooksDoAgente(e: EntradaDeHooks): HookDoDgclaw[] {
  const out: HookDoDgclaw[] = [];
  if (e.raiz && e.temWorkspace && e.temBun) {
    const d = (ev: string) => `${MARCA_DO_DGCLAW}bun ${JSON.stringify(path.join(e.raiz as string, "hooks", "dispatch.ts"))} ${ev}`;
    out.push({ evento: "SessionStart", command: d("session-start"), timeout: 8 });
    out.push({ evento: "SessionStart", matcher: "compact|clear", command: d("avisos-reset"), timeout: 5 });
    out.push({ evento: "UserPromptSubmit", command: d("user-prompt"), timeout: 8 });
    out.push({ evento: "UserPromptSubmit", command: d("avisos"), timeout: 6 });
  }
  for (const p of e.promptHooks) {
    if (typeof p === "string" && p.trim()) out.push({ evento: "UserPromptSubmit", command: MARCA_DO_DGCLAW + p.trim(), timeout: 10 });
  }
  return out;
}

interface Manipulador {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface Grupo {
  matcher?: string;
  hooks?: Manipulador[];
  [k: string]: unknown;
}
type Arquivo = { hooks?: Record<string, Grupo[]>; [k: string]: unknown };

const ehDoDgclaw = (m: Manipulador) => typeof m?.command === "string" && m.command.startsWith(MARCA_DO_DGCLAW);

/**
 * Mescla os hooks do DG Claw no objeto do hooks.json: tira os que já eram do DG Claw (marca no
 * começo do comando) e acrescenta os atuais no fim de cada evento, cada um no seu grupo. O que a
 * pessoa já tinha fica onde estava. Devolve o novo objeto e a lista (chave, hash) de cada hook NOSSO.
 */
export function mesclarHooks(atual: Arquivo, hooks: HookDoDgclaw[], arquivo: string): { novo: Arquivo; confiar: Array<{ chave: string; hash: string }> } {
  const novo: Arquivo = { ...atual, hooks: { ...(atual.hooks ?? {}) } };
  const eventos = new Set<string>([...Object.keys(novo.hooks!), ...hooks.map((h) => h.evento)]);
  const confiar: Array<{ chave: string; hash: string }> = [];
  for (const ev of eventos) {
    const grupos: Grupo[] = [];
    for (const g of novo.hooks![ev] ?? []) {
      const resto = (g.hooks ?? []).filter((m) => !ehDoDgclaw(m));
      if (resto.length) grupos.push({ ...g, hooks: resto });
    }
    for (const h of hooks.filter((x) => x.evento === ev)) {
      grupos.push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command, timeout: h.timeout }] });
      const i = grupos.length - 1;
      confiar.push({ chave: `${arquivo}:${SNAKE[h.evento]}:${i}:0`, hash: hashDoHook(h) });
    }
    if (grupos.length) novo.hooks![ev] = grupos;
    else delete novo.hooks![ev];
  }
  return { novo, confiar };
}

function gravarAtomico(arquivo: string, texto: string, modo: number): void {
  const dir = path.dirname(arquivo);
  const tmp = path.join(dir, `.${path.basename(arquivo)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, texto, { mode: modo });
    fs.chmodSync(tmp, modo);
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Garante a seção `[hooks.state."<chave>"]` com `trusted_hash`, editando o texto do config.toml
 * linha a linha: se a seção existe, troca só a linha `trusted_hash` (ou a acrescenta no fim da
 * seção); se não existe, acrescenta no fim do arquivo. Nada mais é tocado nem reordenado.
 */
export function garantirConfiancaNoToml(texto: string, itens: Array<{ chave: string; hash: string }>): string {
  let linhas = texto === "" ? [] : texto.split("\n");
  const terminaEmQuebra = texto.endsWith("\n");
  if (terminaEmQuebra) linhas.pop();
  for (const { chave, hash } of itens) {
    const cab = `[hooks.state.${JSON.stringify(chave)}]`;
    const ini = linhas.findIndex((l) => l.trim() === cab);
    const linhaHash = `trusted_hash = ${JSON.stringify(hash)}`;
    if (ini < 0) {
      if (linhas.length && linhas[linhas.length - 1].trim() !== "") linhas.push("");
      linhas.push(cab, linhaHash);
      continue;
    }
    let fim = ini + 1;
    while (fim < linhas.length && !/^\s*\[/.test(linhas[fim])) fim++;
    const posHash = linhas.slice(ini + 1, fim).findIndex((l) => /^\s*trusted_hash\s*=/.test(l));
    if (posHash >= 0) linhas[ini + 1 + posHash] = linhaHash;
    else {
      let p = fim;
      while (p > ini + 1 && linhas[p - 1].trim() === "") p--;
      linhas.splice(p, 0, linhaHash);
    }
  }
  return linhas.join("\n") + "\n";
}

export interface ResultadoDosHooks {
  instalados: number;
  /** Por que não instalou, quando não instalou por algo que merece aviso. */
  motivo?: string;
}

/**
 * Instala os hooks do DG Claw no CODEX_HOME e confia só neles. Idempotente: rodar de novo não
 * duplica e regrava a confiança se o conteúdo do hook mudou. Falhar aqui não derruba o spawn: o
 * agente sobe sem os hooks (o log diz o que fazer).
 */
export function instalarHooksNoCodex(opts: {
  home: string;
  env: Record<string, string>;
  cwd: string;
  promptHooks: string[];
  area: string;
  raiz?: string | null;
}): ResultadoDosHooks {
  const { home, area } = opts;
  const raiz = opts.raiz === undefined ? raizDoPlugin() : opts.raiz;
  const ws = opts.env.DGCLAW_WORKSPACE?.trim() || opts.cwd;
  const temWorkspace = fs.existsSync(path.join(ws, ".dgclaw", "config.sh"));
  const temBun = achaNoPath("bun", opts.env.PATH ?? process.env.PATH);
  const hooks = hooksDoAgente({ raiz, temWorkspace, temBun, promptHooks: opts.promptHooks });
  const arquivo = path.join(home, "hooks.json");
  const toml = path.join(home, "config.toml");
  try {
    if (temWorkspace && raiz && !temBun) {
      log.aviso(
        area,
        `o agente está num workspace do DG Claw mas não achei o "bun" no PATH, então o Codex fica sem o recall de memória, o quadro de avisos e o contexto de início. ` +
          `O bun vem na imagem do agente (npm i -g bun); conferir "command -v bun" dentro do container`,
      );
    } else if (temWorkspace && !raiz) {
      log.aviso(area, `não achei hooks/dispatch.ts perto do runner, então o Codex fica sem os hooks do DG Claw. Reinstalar ou atualizar o DG Claw`);
    }
    for (const f of [arquivo, toml]) {
      let ehLink = false;
      try {
        ehLink = fs.lstatSync(f).isSymbolicLink();
      } catch {
        /* não existe: tudo bem */
      }
      if (ehLink) {
        log.aviso(area, `${f} é um atalho (link simbólico): não gravei os hooks do DG Claw para não escrever em outro lugar. Troque o atalho por um arquivo comum e reinicie o agente`);
        return { instalados: 0, motivo: "atalho" };
      }
    }
    let atual: Arquivo = {};
    let existe = true;
    let bruto = "";
    try {
      bruto = fs.readFileSync(arquivo, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      existe = false;
    }
    if (existe && bruto.trim() !== "") {
      try {
        const j = JSON.parse(bruto);
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("não é um objeto JSON");
        atual = j as Arquivo;
      } catch (err) {
        log.aviso(
          area,
          `${arquivo} não é um JSON válido (${err instanceof Error ? err.message : String(err)}): não mexi nele e o Codex fica sem os hooks do DG Claw. ` +
            `Conserte ou apague o arquivo (ele guarda só hooks) e reinicie o agente`,
        );
        return { instalados: 0, motivo: "hooks.json ilegível" };
      }
    }
    if (!existe && hooks.length === 0) return { instalados: 0 };
    const { novo, confiar } = mesclarHooks(atual, hooks, arquivo);
    const texto = JSON.stringify(novo, null, 2) + "\n";
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (texto !== bruto) gravarAtomico(arquivo, texto, existe ? fs.statSync(arquivo).mode & 0o777 : 0o600);
    if (confiar.length) {
      let t = "";
      let modo = 0o600;
      try {
        t = fs.readFileSync(toml, "utf8");
        modo = fs.statSync(toml).mode & 0o777;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const novoToml = garantirConfiancaNoToml(t, confiar);
      if (novoToml !== t) gravarAtomico(toml, novoToml, modo);
    }
    return { instalados: confiar.length };
  } catch (err) {
    log.aviso(
      area,
      `não consegui instalar os hooks do DG Claw no Codex (${arquivo}): ${err instanceof Error ? err.message : String(err)}. ` +
        `O agente sobe sem o recall de memória e sem o quadro de avisos. Conferir a permissão de escrita em ${home}`,
    );
    return { instalados: 0, motivo: "erro de escrita" };
  }
}
