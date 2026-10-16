// O rollout do Codex: o arquivo onde o CLI grava a conversa, e a nossa única fonte de
// status e de id de sessão para ele.
//
// Porta de `codex-cli.ts` e `codex-activity.ts` do Bunker (apps/server/src). O Codex
// não tem hooks por `--settings` nem aceita pré-fixar o id da sessão. Ele grava
// `<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<data>-<uuid>.jsonl`, cuja primeira linha
// (`session_meta`) traz o id e o cwd, e o resto é a conversa. Ler esse arquivo dá:
//   - o id (descoberto por cwd + hora do spawn);
//   - o status (task_started, ferramentas, task_complete);
//   - a conversa do `GET /conversation`.
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT_UUID_RE = new RegExp(`rollout-.*-(${UUID})\\.jsonl$`, "i");
const SO_UUID_RE = new RegExp(`^${UUID}$`, "i");

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Pastas AAAA/MM/DD existentes, da mais nova para a mais antiga, até `limite`. */
function pastasDeDia(codexHome: string, limite: number): string[] {
  const raiz = path.join(codexHome, "sessions");
  const fora: string[] = [];
  const ler = (dir: string, re: RegExp): string[] => {
    try {
      return fs.readdirSync(dir).filter((d) => re.test(d)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const ano of ler(raiz, /^\d{4}$/)) {
    for (const mes of ler(path.join(raiz, ano), /^\d{2}$/)) {
      for (const dia of ler(path.join(raiz, ano, mes), /^\d{2}$/)) {
        fora.push(path.join(raiz, ano, mes, dia));
        if (fora.length >= limite) return fora;
      }
    }
  }
  return fora;
}

/** Acha o rollout de uma sessão pelo uuid, nos últimos `maxDias` dias com sessão. */
export function acharRolloutPorId(sessionId: string, codexHome: string, maxDias = 45): string | null {
  if (!SO_UUID_RE.test(sessionId)) return null;
  const sufixo = `-${sessionId.toLowerCase()}.jsonl`;
  for (const dir of pastasDeDia(codexHome, maxDias)) {
    let entradas: string[];
    try {
      entradas = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const f = entradas.find((e) => e.toLowerCase().endsWith(sufixo));
    if (f) return path.join(dir, f);
  }
  return null;
}

/**
 * Lê a primeira linha (session_meta) de um rollout. Ela carrega o `base_instructions`
 * inteiro (dezenas de KB) e pode não caber na janela de leitura; nesse caso o
 * id e o cwd, que vêm ANTES dele no payload, saem por regex.
 */
export function lerMetaDoRollout(arquivo: string): { id: string | null; cwd: string | null; criadoEm: number | null } | null {
  let cabeca = "";
  try {
    const fd = fs.openSync(arquivo, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const lidos = fs.readSync(fd, buf, 0, buf.length, 0);
      cabeca = buf.subarray(0, lidos).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!cabeca.trim()) return null;
  const nl = cabeca.indexOf("\n");
  if (nl >= 0) {
    try {
      const o = JSON.parse(cabeca.slice(0, nl).trim()) as { payload?: Record<string, unknown> } & Record<string, unknown>;
      const p = (o.payload ?? o) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : null;
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      const quando = Date.parse(typeof p.timestamp === "string" ? p.timestamp : typeof o.timestamp === "string" ? o.timestamp : "");
      if (id || cwd) return { id, cwd, criadoEm: Number.isFinite(quando) ? quando : null };
    } catch {
      /* linha maior que a janela: cai no regex abaixo */
    }
  }
  const idM = cabeca.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/i) || cabeca.match(/"id"\s*:\s*"([0-9a-f-]{36})"/i);
  const cwdM = cabeca.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let cwd: string | null = null;
  if (cwdM) {
    try {
      cwd = JSON.parse(`"${cwdM[1]}"`) as string;
    } catch {
      cwd = cwdM[1];
    }
  }
  if (!idM && !cwd) return null;
  const tsM = cabeca.match(/"timestamp"\s*:\s*"([^"]+)"/);
  const quandoM = tsM ? Date.parse(tsM[1]) : NaN;
  return { id: idM ? idM[1].toLowerCase() : null, cwd, criadoEm: Number.isFinite(quandoM) ? quandoM : null };
}

/**
 * Descobre a sessão que um spawn recém-criado abriu: o rollout mais novo cujo cwd
 * bate e cujo mtime é >= hora do spawn (com 5 s de folga para o relógio e o flush).
 * `excluir` tira os ids que OUTRA sessão deste runner já reivindicou, porque duas
 * sessões Codex na mesma casa têm o mesmo cwd.
 */
export function descobrirRollout(
  cwd: string,
  desdeMs: number,
  codexHome: string,
  excluir: ReadonlySet<string> = new Set(),
): { id: string; arquivo: string } | null {
  const folga = 5_000;
  const alvo = normPath(cwd);
  let melhor: { id: string; arquivo: string; mtimeMs: number } | null = null;
  for (const dir of pastasDeDia(codexHome, 2)) {
    let entradas: string[];
    try {
      entradas = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entradas) {
      const m = f.match(ROLLOUT_UUID_RE);
      if (!m) continue;
      const arquivo = path.join(dir, f);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(arquivo).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < desdeMs - folga) continue;
      const meta = lerMetaDoRollout(arquivo);
      if (!meta) continue;
      if (meta.cwd && normPath(meta.cwd) !== alvo) continue;
      // A conversa NOVA de um spawn nasce depois do spawn. Um rollout cuja sessão começou antes é de
      // outra conversa na mesma casa (o mtime sozinho engana: ela pode ter escrito há pouco).
      if (meta.criadoEm !== null && meta.criadoEm < desdeMs - 2_000) continue;
      const id = (meta.id || m[1]).toLowerCase();
      if (excluir.has(id)) continue;
      if (!melhor || mtimeMs > melhor.mtimeMs) melhor = { id, arquivo, mtimeMs };
    }
  }
  return melhor ? { id: melhor.id, arquivo: melhor.arquivo } : null;
}

/** Os eventos internos que a Sessao já entende (os mesmos que o hook do Claude traz). */
export type EventoInterno = "UserPromptSubmit" | "PreToolUse" | "Stop";

export interface EventoDoRollout {
  evento: EventoInterno;
  em: number;
  ferramenta?: string;
}

/** Uma linha do rollout vira, ou não, um evento de status. `task_started` é o RECIBO do
 *  Enter (o Codex aceitou o prompt); `task_complete`, `task_aborted` e `turn_aborted`
 *  são o fim do turno; chamada de ferramenta é trabalho em andamento. */
export function eventoDoRollout(registro: unknown): EventoDoRollout | null {
  const r = registro as { timestamp?: string; type?: string; payload?: { type?: string; name?: string } } | null;
  const em = Date.parse(r?.timestamp ?? "");
  if (!r || !Number.isFinite(em)) return null;
  const tipo = r.payload?.type ?? "";
  if (r.type === "event_msg") {
    if (tipo === "task_started") return { evento: "UserPromptSubmit", em };
    if (tipo === "task_complete" || tipo === "task_aborted" || tipo === "turn_aborted") return { evento: "Stop", em };
  }
  if (r.type === "response_item" && (tipo === "function_call" || tipo === "custom_tool_call")) {
    return { evento: "PreToolUse", em, ferramenta: typeof r.payload?.name === "string" ? r.payload.name : undefined };
  }
  return null;
}

export interface OpcoesDoVigia {
  /** Devolve o rollout a ler agora, ou null enquanto ele não existe. Chamado a cada pulso. */
  resolverArquivo: () => string | null;
  /** Eventos mais antigos que isto são do passado (de antes do spawn) e são ignorados. */
  desdeMs: number;
  aoEvento: (e: EventoDoRollout) => void;
  intervaloMs?: number;
}

/**
 * Lê o rollout aos poucos (leitura incremental, no máximo 1 MB por pulso) e entrega os
 * eventos NA ORDEM em que foram gravados. Devolve a função que para o vigia.
 * Diferente do Bunker, não colapsa os eventos de um pulso em um só: o recibo do
 * Enter conta cada `task_started`.
 */
export function vigiarRollout(op: OpcoesDoVigia): () => void {
  let parado = false;
  let ocupado = false;
  let arquivo: string | null = null;
  let deslocamento = 0;
  let resto = "";
  const pulso = async (): Promise<void> => {
    if (parado || ocupado) return;
    ocupado = true;
    let fd: fs.promises.FileHandle | undefined;
    try {
      const proximo = op.resolverArquivo();
      if (!proximo) return;
      fd = await fs.promises.open(proximo, "r");
      const st = await fd.stat();
      if (proximo !== arquivo || st.size < deslocamento) {
        arquivo = proximo;
        deslocamento = Math.max(0, st.size - 1024 * 1024);
        resto = "";
      }
      if (st.size === deslocamento) return;
      const buf = Buffer.alloc(Math.min(st.size - deslocamento, 1024 * 1024));
      const { bytesRead } = await fd.read(buf, 0, buf.length, deslocamento);
      deslocamento += bytesRead;
      const linhas = (resto + buf.subarray(0, bytesRead).toString("utf8")).split("\n");
      resto = linhas.pop() ?? "";
      if (resto.length > 2 * 1024 * 1024) resto = "";
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        let reg: unknown;
        try {
          reg = JSON.parse(linha);
        } catch {
          continue; // o primeiro fragmento de uma leitura no meio do arquivo pode estar cortado
        }
        const ev = eventoDoRollout(reg);
        if (ev && ev.em >= op.desdeMs && !parado) op.aoEvento(ev);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.aviso("codex", `o vigia do rollout reclamou: ${err instanceof Error ? err.message : err}; tento de novo no próximo pulso`);
      }
    } finally {
      await fd?.close();
      ocupado = false;
    }
  };
  const timer = setInterval(() => void pulso(), op.intervaloMs ?? 1_000);
  timer.unref?.();
  void pulso();
  return () => {
    parado = true;
    clearInterval(timer);
  };
}

export interface MensagemDoRollout {
  role: string;
  text: string;
}

/** Contexto que o Codex injeta como mensagem de usuário e que não é fala de ninguém. */
const CONTEXTO_INJETADO = ["<environment_context>", "<user_instructions>", "# AGENTS.md"];

function textoDosBlocos(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (!Array.isArray(conteudo)) return "";
  const partes: string[] = [];
  for (const b of conteudo) {
    if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      partes.push((b as { text: string }).text);
    }
  }
  return partes.join("");
}

/** As últimas `quantas` mensagens de texto da conversa, mais antiga primeiro (mesmo
 *  formato e mesmo limite do transcript do Claude). */
export function mensagensDoRollout(arquivo: string, quantas = 6, segredos?: Iterable<string>): MensagemDoRollout[] | null {
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    log.erro(
      "conversa",
      `não consegui ler ${arquivo}: ${err instanceof Error ? err.message : err}`,
      "conferir a permissão de leitura do rollout; a conversa não foi perdida, só não foi lida",
    );
    return null;
  }
  const fora: MensagemDoRollout[] = [];
  for (const linha of cru.split("\n")) {
    if (!linha.trim()) continue;
    let o: { type?: string; payload?: { type?: string; role?: string; content?: unknown } };
    try {
      o = JSON.parse(linha) as typeof o;
    } catch {
      continue; // linha truncada no fim do arquivo é normal enquanto o CLI escreve
    }
    const p = o.payload;
    if (o.type !== "response_item" || p?.type !== "message") continue;
    if (p.role !== "user" && p.role !== "assistant") continue;
    const texto = textoDosBlocos(p.content).trim();
    if (!texto) continue;
    if (p.role === "user" && CONTEXTO_INJETADO.some((c) => texto.startsWith(c))) continue;
    fora.push({ role: p.role, text: mascarar(texto, segredos) });
  }
  return fora.slice(-Math.max(1, quantas));
}
