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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

/** Marca os comandos que são do DG Claw: tudo o que tem esta marca (no começo ou depois do `cd '<pasta>' && `), no hooks.json, é regravado a cada spawn. */
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

/** Cita um texto para o shell (aspas simples; a aspa simples vira `'\''`). */
export function citarParaShell(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export interface EntradaDeHooks {
  /** Pasta do plugin (de root). */
  raiz: string | null;
  /**
   * Workspace autorizado deste agente (caminho absoluto). Todo comando de hook o fixa em
   * DGCLAW_WORKSPACE: sem isso, outra sessão Codex aberta com o mesmo CODEX_HOME (por exemplo
   * dentro de um repositório que o agente clonou) faria o dispatch tratar o cwd do repositório
   * como workspace e ler arquivos dele.
   */
  workspace: string;
  /** O agente está num workspace servidor do DG Claw (tem `.dgclaw/config.sh`). */
  temWorkspace: boolean;
  temBun: boolean;
  /** O `python3` está no PATH do agente (o hook dos promptHooks é um script Python). */
  temPython?: boolean;
  /** Pasta onde o runner guarda o estado do agente (PASTA_DE_ESTADO). Os promptHooks de cada sessão ficam em `<pasta>/prompt-hooks/<id>.json`. */
  pastaDeEstado?: string;
}

/** Nome da variável que o runner põe no ambiente do processo Codex de cada sessão. */
export const VARIAVEL_DA_SESSAO = "DGCLAW_SESSAO_ID";
/** O id de uma sessão só pode ser isto para virar nome de arquivo (sem barra, ponto nem `..`). */
export const ID_DE_SESSAO_VALIDO = /^[A-Za-z0-9_-]+$/;
/** Subpasta de `pastaDeEstado` com um arquivo `<id>.json` por sessão. */
export function pastaDosPromptHooks(pastaDeEstado: string): string {
  return path.join(pastaDeEstado, "prompt-hooks");
}

/**
 * Os hooks que este agente recebe. Mesmos comandos e tempos do `hooks/hooks.json` do Claude.
 * O conjunto sai SÓ de dados do runner (raiz do plugin, workspace, PATH, pasta de estado) e é o
 * MESMO para todas as sessões do agente: o hooks.json e a confiança são do agente, não da sessão.
 * Os promptHooks de cada sessão não entram aqui: o hook fixo `prompt-hooks-sessao.py` os lê do
 * arquivo de estado da sessão (ver `gravarPromptHooksDaSessao`).
 */
export function hooksDoAgente(e: EntradaDeHooks): HookDoDgclaw[] {
  const out: HookDoDgclaw[] = [];
  // A marca fica depois do `cd`; o workspace vem logo depois como atribuição de ambiente
  // (o Codex roda o comando por um shell, então `VAR=valor comando` vale como prefixo).
  // O comando entra primeiro numa pasta de root (a dos hooks do plugin; "/" se não há plugin): a sessão
  // Codex pode ter sido aberta dentro de um repositório de terceiros, e bun, python e node leem
  // arquivos do diretório atual (bunfig.toml com preload, json.py ao lado do script, etc.).
  const confiavel = e.raiz ? path.join(e.raiz, "hooks") : "/";
  const prefixo = `cd ${citarParaShell(confiavel)} && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE=${citarParaShell(path.resolve(e.workspace))} `;
  if (e.raiz && e.temWorkspace && e.temBun) {
    const d = (ev: string) => `${prefixo}bun ${JSON.stringify(path.join(e.raiz as string, "hooks", "dispatch.ts"))} ${ev}`;
    out.push({ evento: "SessionStart", command: d("session-start"), timeout: 8 });
    out.push({ evento: "SessionStart", matcher: "compact|clear", command: d("avisos-reset"), timeout: 5 });
    out.push({ evento: "UserPromptSubmit", command: d("user-prompt"), timeout: 8 });
    out.push({ evento: "UserPromptSubmit", command: d("avisos"), timeout: 6 });
  }
  if (e.raiz && e.pastaDeEstado && e.temPython !== false) {
    // Os promptHooks rodam em paralelo, cada um com teto de 9 s, dentro do teto de 10 s deste hook.
    const script = path.join(e.raiz, "hooks", "prompt-hooks-sessao.py");
    out.push({
      evento: "UserPromptSubmit",
      command: `${prefixo}DGCLAW_PROMPT_HOOKS_DIR=${citarParaShell(pastaDosPromptHooks(e.pastaDeEstado))} python3 -I ${citarParaShell(script)}`,
      timeout: 10,
    });
  }
  return out;
}

/**
 * Grava, atomicamente e com modo 0600, a lista de promptHooks DESTA sessão em
 * `<pastaDeEstado>/prompt-hooks/<id>.json`. Só regrava se o conteúdo mudou. O hook fixo do hooks.json
 * lê esse arquivo pelo DGCLAW_SESSAO_ID do ambiente do Codex. A pasta de estado é do runner, fora do
 * workspace e de qualquer cwd de sessão. Devolve false (com log) se não gravou.
 */
export function gravarPromptHooksDaSessao(opts: { pastaDeEstado: string; sessaoId: string; promptHooks: string[]; area: string }): boolean {
  const { pastaDeEstado, sessaoId, area } = opts;
  if (!ID_DE_SESSAO_VALIDO.test(sessaoId)) {
    log.aviso(area, `o id da sessão (${JSON.stringify(sessaoId)}) tem caracteres que não posso usar em nome de arquivo (só letras, números, _ e -): os promptHooks dela não rodam no Codex. Renomear a sessão no descritor`);
    return false;
  }
  const comandos = opts.promptHooks.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
  const dir = pastaDosPromptHooks(pastaDeEstado);
  const arquivo = path.join(dir, `${sessaoId}.json`);
  try {
    if (comandos.length === 0) {
      // Lista vazia: o arquivo some, em vez de ficar com a lista velha.
      fs.rmSync(arquivo, { force: true });
      return true;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const texto = JSON.stringify({ versao: 1, comandos }) + "\n";
    let atual = "";
    try {
      atual = fs.readFileSync(arquivo, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (atual !== texto) gravarAtomico(arquivo, texto, 0o600);
    return true;
  } catch (err) {
    // Não deu para deixar o arquivo igual à lista atual: tira o velho, se der, para não sobrar comando
    // revogado, e avisa quem chamou para NÃO pôr DGCLAW_SESSAO_ID no Codex deste spawn.
    let sobrou = false;
    try {
      fs.rmSync(arquivo, { force: true });
    } catch {
      sobrou = true;
    }
    log.aviso(
      area,
      `não consegui gravar os promptHooks da sessão em ${arquivo} (${err instanceof Error ? err.message : String(err)}): nesta subida eles NÃO rodam no Codex ` +
        `(o runner não passa o id da sessão ao hook)${sobrou ? `, e não consegui apagar a versão antiga do arquivo` : ""}. Conferir a permissão de escrita em ${dir} e reiniciar o agente`,
    );
    return false;
  }
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

/** Parece comando do DG Claw: tem a marca em qualquer lugar. Só serve para DESCARTAR, nunca para confiar. */
export const pareceDoDgclaw = (c: unknown): boolean => typeof c === "string" && c.includes(MARCA_DO_DGCLAW.trim());

/**
 * Mescla os hooks do DG Claw no objeto do hooks.json. Nada que venha do arquivo existente ganha
 * confiança: o conjunto do DG Claw é só o que o runner calculou (`hooks`). Entradas com a marca do DG
 * Claw que não são exatamente um dos comandos calculados (formato antigo, guarda de sessão, forjadas)
 * são trocadas pelos comandos calculados ou descartadas, e nunca mantidas.
 *
 * A chave de confiança do Codex inclui a POSIÇÃO (`evento:grupo:manipulador`), então tudo o que não é
 * nosso fica exatamente onde estava:
 *   - um grupo nosso que já está no arquivo é atualizado NO LUGAR (se o comando calculado mudou, troca
 *     o texto no mesmo índice);
 *   - os nossos que faltam entram no FIM da lista do evento, depois dos da pessoa;
 *   - nossos a mais (obsoletos) são removidos. Isso só desloca algo da pessoa quando o obsoleto está
 *     ANTES de um grupo dela (arquivo de uma versão antiga, com os nossos na frente): aí o grupo dela
 *     muda de índice e perde a confiança UMA vez. Devolve `deslocados` para o instalador avisar
 *     a pessoa, que confia de novo com /hooks.
 * Um grupo que mistura hooks da pessoa com um nosso fica, sem o nosso. Devolve também a lista
 * (chave, hash) de cada hook NOSSO e quantas entradas descartou.
 */
export function mesclarHooks(atual: Arquivo, hooks: HookDoDgclaw[], arquivo: string): { novo: Arquivo; confiar: Array<{ chave: string; hash: string }>; descartados: number; deslocados: number } {
  const novo: Arquivo = { ...atual, hooks: { ...(atual.hooks ?? {}) } };
  const eventos = [...new Set<string>([...Object.keys(novo.hooks!), ...hooks.map((h) => h.evento)])];
  const confiar: Array<{ chave: string; hash: string }> = [];
  let descartados = 0;
  let deslocados = 0;
  const grupoNosso = (h: HookDoDgclaw): Grupo => ({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command, timeout: h.timeout }] });
  for (const ev of eventos) {
    const calculados = hooks.filter((x) => x.evento === ev);
    const antigos: Grupo[] = novo.hooks![ev] ?? [];
    // 1) classifica cada grupo: da pessoa (fica), nosso (vira "vaga") ou misto (fica sem o nosso)
    type Item = { grupo: Grupo; vaga: boolean; antes: number; manips: number };
    const itens: Item[] = [];
    antigos.forEach((g, i) => {
      const hs = g.hooks ?? [];
      const nossos = hs.filter((m) => pareceDoDgclaw(m?.command));
      if (nossos.length === 0) itens.push({ grupo: g, vaga: false, antes: i, manips: hs.length });
      else if (nossos.length === hs.length) itens.push({ grupo: g, vaga: true, antes: i, manips: hs.length });
      else {
        descartados += nossos.length;
        itens.push({ grupo: { ...g, hooks: hs.filter((m) => !pareceDoDgclaw(m?.command)) }, vaga: false, antes: i, manips: hs.length - nossos.length });
      }
    });
    // 2) as vagas que já têm exatamente um comando calculado ficam com ele; as outras recebem, na
    //    ordem, os calculados que sobraram; o que ainda sobrar entra no fim; vaga sem par é removida
    const livres = [...calculados];
    const colocado = new Map<Item, HookDoDgclaw>();
    for (const it of itens) {
      if (!it.vaga) continue;
      const hs = it.grupo.hooks ?? [];
      const j = hs.length === 1 ? livres.findIndex((h) => h.command === hs[0].command) : -1;
      if (j >= 0) colocado.set(it, livres.splice(j, 1)[0]);
    }
    for (const it of itens) {
      if (!it.vaga || colocado.has(it)) continue;
      const h = livres.shift();
      if (h) colocado.set(it, h);
    }
    const saida: Grupo[] = [];
    const indices: Array<{ h: HookDoDgclaw; i: number }> = [];
    itens.forEach((it) => {
      if (!it.vaga) {
        if (saida.length !== it.antes || it.manips !== (antigos[it.antes].hooks ?? []).length) deslocados++;
        saida.push(it.grupo);
        return;
      }
      const h = colocado.get(it);
      if (!h) {
        descartados++;
        return;
      }
      if (!(it.grupo.hooks?.length === 1 && it.grupo.hooks[0].command === h.command)) descartados++;
      saida.push(grupoNosso(h));
      indices.push({ h, i: saida.length - 1 });
    });
    for (const h of livres) {
      saida.push(grupoNosso(h));
      indices.push({ h, i: saida.length - 1 });
    }
    for (const { h, i } of indices) confiar.push({ chave: `${arquivo}:${SNAKE[h.evento]}:${i}:0`, hash: hashDoHook(h) });
    if (saida.length) novo.hooks![ev] = saida;
    else delete novo.hooks![ev];
  }
  return { novo, confiar, descartados, deslocados };
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

/** O config.toml tem algo que não dá para editar com segurança: nada é gravado e o motivo vai no log. */
export class TomlNaoEditavel extends Error {}

type Parte = string;
/** Lê uma chave composta (`a."b c".'d'`) a partir de `i`. Devolve as partes e onde parou, ou null se não for chave. */
function lerChave(s: string, i: number): { partes: Parte[]; fim: number } | null {
  const partes: Parte[] = [];
  const pulaEsp = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  for (;;) {
    pulaEsp();
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return null;
      try {
        partes.push(JSON.parse(s.slice(i, j + 1)) as string);
      } catch {
        return null;
      }
      i = j + 1;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      partes.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      partes.push(m[0]);
      i += m[0].length;
    }
    pulaEsp();
    if (s[i] === ".") {
      i++;
      continue;
    }
    return { partes, fim: i };
  }
}

type Item =
  | { tipo: "cab"; partes: Parte[]; linha: number }
  | { tipo: "chave"; tabela: Parte[]; caminho: Parte[]; linha: number }
  | { tipo: "tabelaDeArray"; linha: number };

/** Posição logo depois da string que começa em `i` (básica, literal, ou as duas de várias linhas). Lança se não fechar. */
function pularString(t: string, i: number): number {
  const q = t[i];
  if (t.startsWith(q.repeat(3), i)) {
    let p = i + 3;
    for (;;) {
      if (p >= t.length) throw new TomlNaoEditavel("string de várias linhas sem fechar");
      if (q === '"' && t[p] === "\\") {
        p += 2;
        continue;
      }
      if (t.startsWith(q.repeat(3), p)) {
        p += 3;
        // até duas aspas extras logo antes do fecho fazem parte do texto
        let extras = 0;
        while (t[p] === q && extras < 2) {
          p++;
          extras++;
        }
        return p;
      }
      p++;
    }
  }
  let p = i + 1;
  for (;;) {
    const c = t[p];
    if (c === undefined || c === "\n") throw new TomlNaoEditavel("string sem fechar na mesma linha");
    if (q === '"' && c === "\\") {
      p += 2;
      continue;
    }
    if (c === q) return p + 1;
    p++;
  }
}

/** Posição logo depois do valor que começa em `i`: string, array ou tabela inline (que podem atravessar linhas) ou escalar. */
function pularValor(t: string, i: number): number {
  let p = i;
  let prof = 0;
  for (;;) {
    const c = t[p];
    if (c === undefined) {
      if (prof > 0) throw new TomlNaoEditavel("array ou tabela inline sem fechar");
      return p;
    }
    if (c === '"' || c === "'") {
      p = pularString(t, p);
      if (prof === 0) return p;
      continue;
    }
    if (c === "[" || c === "{") {
      prof++;
      p++;
      continue;
    }
    if (c === "]" || c === "}") {
      if (prof === 0) throw new TomlNaoEditavel("fecha colchete ou chave sem abrir");
      prof--;
      p++;
      if (prof === 0) return p;
      continue;
    }
    if (c === "#") {
      if (prof === 0) return p;
      while (p < t.length && t[p] !== "\n") p++;
      continue;
    }
    if (c === "\n" && prof === 0) return p;
    p++;
  }
}

/**
 * Varre o TOML pela gramática léxica (strings básicas e literais, as de várias linhas, comentários só
 * fora de string, arrays e tabelas inline que atravessam linhas) e devolve os cabeçalhos de tabela e as
 * chaves, com o caminho completo. Só as linhas que COMEÇAM fora de string e de array são candidatas a
 * cabeçalho. Texto que não consegue ler lança TomlNaoEditavel, em vez de adivinhar.
 */
function varrer(t: string): Item[] {
  const itens: Item[] = [];
  const iniciosDeLinha = [0];
  for (let k = 0; k < t.length; k++) if (t[k] === "\n") iniciosDeLinha.push(k + 1);
  const linhaDe = (pos: number) => {
    let lo = 0;
    let hi = iniciosDeLinha.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (iniciosDeLinha[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const falha = (pos: number, o: string): never => {
    throw new TomlNaoEditavel(`não consegui ler a linha ${linhaDe(pos) + 1} do config.toml com segurança (${o})`);
  };
  const fimDaLinha = (pos: number) => {
    let p = pos;
    while (t[p] === " " || t[p] === "\t" || t[p] === "\r") p++;
    if (p < t.length && t[p] !== "\n" && t[p] !== "#") falha(pos, "sobrou texto depois do valor ou do cabeçalho");
    while (p < t.length && t[p] !== "\n") p++;
    return p;
  };
  let tabela: Parte[] = [];
  let p = 0;
  while (p < t.length) {
    const c = t[p];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      p++;
      continue;
    }
    if (c === "#") {
      while (p < t.length && t[p] !== "\n") p++;
      continue;
    }
    const inicio = p;
    try {
      if (c === "[") {
        if (t[p + 1] === "[") {
          const fim = t.indexOf("]]", p);
          if (fim < 0) falha(p, "tabela de array sem fechar");
          itens.push({ tipo: "tabelaDeArray", linha: linhaDe(p) });
          tabela = ["[["];
          p = fimDaLinha(fim + 2);
          continue;
        }
        const k = lerChave(t, p + 1);
        if (!k) falha(p, "cabeçalho de tabela inválido");
        let q = k!.fim;
        while (t[q] === " " || t[q] === "\t") q++;
        if (t[q] !== "]") falha(p, "cabeçalho de tabela sem ]");
        itens.push({ tipo: "cab", partes: k!.partes, linha: linhaDe(p) });
        tabela = k!.partes;
        p = fimDaLinha(q + 1);
        continue;
      }
      const k = lerChave(t, p);
      if (!k) falha(p, "esperava uma chave");
      let q = k!.fim;
      while (t[q] === " " || t[q] === "\t") q++;
      if (t[q] !== "=") falha(p, "chave sem =");
      q++;
      while (t[q] === " " || t[q] === "\t") q++;
      if (q >= t.length || t[q] === "\n" || t[q] === "#") falha(p, "chave sem valor");
      itens.push({ tipo: "chave", tabela, caminho: [...tabela, ...k!.partes], linha: linhaDe(p) });
      p = fimDaLinha(pularValor(t, q));
    } catch (err) {
      if (err instanceof TomlNaoEditavel && !err.message.startsWith("não consegui ler a linha")) {
        throw new TomlNaoEditavel(`não consegui ler a linha ${linhaDe(inicio) + 1} do config.toml com segurança (${err.message})`);
      }
      throw err;
    }
  }
  return itens;
}

const igual = (a: Parte[], b: Parte[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const comecaCom = (a: Parte[], pre: Parte[]) => a.length >= pre.length && pre.every((x, i) => x === a[i]);

const PY_TOMLLIB = `
import json, sys
try:
    import tomllib
except ImportError:
    sys.exit(3)
d = json.load(sys.stdin)
def le(t):
    try:
        return tomllib.loads(t), None
    except Exception as e:
        return None, str(e)
def tira(x, chaves):
    for k in chaves:
        h = x.get("hooks")
        st = h.get("state") if isinstance(h, dict) else None
        sec = st.get(k) if isinstance(st, dict) else None
        if isinstance(sec, dict):
            sec.pop("trusted_hash", None)
            if not sec: st.pop(k, None)
        if isinstance(st, dict) and not st and isinstance(h, dict): h.pop("state", None)
        if isinstance(h, dict) and not h: x.pop("hooks", None)
    return x
o, eo = le(d["original"])
n, en = le(d["novo"])
r = {"originalValido": o is not None, "novoValido": n is not None, "erroNovo": en}
if o is not None and n is not None:
    r["hashesOk"] = all(((n.get("hooks") or {}).get("state") or {}).get(k, {}).get("trusted_hash") == v for k, v in d["hashes"].items())
    r["soHash"] = tira(o, d["hashes"].keys()) == tira(n, d["hashes"].keys())
print(json.dumps(r))
`;

/** Confere o resultado com o tomllib do Python (>= 3.11), se houver. Sem ele, nada a conferir (fica a checagem do scanner). */
function conferirComTomllib(original: string, novo: string, itens: Array<{ chave: string; hash: string }>): void {
  let r;
  try {
    r = spawnSync("python3", ["-I", "-c", PY_TOMLLIB], {
      cwd: "/",
      input: JSON.stringify({ original, novo, hashes: Object.fromEntries(itens.map((i) => [i.chave, i.hash])) }),
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return;
  }
  if (r.error || r.status !== 0) return; // sem python3 ou sem tomllib: só o scanner
  let j: { originalValido: boolean; novoValido: boolean; erroNovo?: string; hashesOk?: boolean; soHash?: boolean };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return;
  }
  if (!j.originalValido) return; // já era inválido antes de nós: não dá para comparar
  if (!j.novoValido) throw new TomlNaoEditavel(`o config.toml ficaria inválido depois da edição (${j.erroNovo ?? "erro de TOML"}); não gravei`);
  if (!j.hashesOk) throw new TomlNaoEditavel("depois da edição o trusted_hash lido pelo TOML não bate com o esperado; não gravei");
  if (!j.soHash) throw new TomlNaoEditavel("a edição mudaria algo além do trusted_hash dos hooks do DG Claw; não gravei");
}

/**
 * Garante a seção `[hooks.state."<chave>"]` com `trusted_hash`, editando o texto do config.toml
 * linha a linha: se a seção existe (em qualquer forma válida do cabeçalho: espaços, comentário no
 * fim, chave entre aspas duplas ou literais), troca só a linha `trusted_hash` (ou a acrescenta no
 * fim da seção); se não existe, acrescenta no fim do arquivo. Nada mais é tocado nem reordenado.
 * Se a chave já está definida de um jeito que não dá para editar com segurança (tabela inline,
 * `state = {...}`, chave pontilhada, cabeçalho repetido), lança TomlNaoEditavel sem devolver texto.
 */
export function garantirConfiancaNoToml(texto: string, itens: Array<{ chave: string; hash: string }>): string {
  const linhas = texto === "" ? [] : texto.split("\n");
  if (texto.endsWith("\n")) linhas.pop();
  for (const { chave, hash } of itens) {
    const alvo = ["hooks", "state", chave];
    const mapa = varrer(linhas.join("\n"));
    const cabs = mapa.filter((x): x is Extract<Item, { tipo: "cab" }> => x.tipo === "cab" && igual(x.partes, alvo));
    // Conflito: a chave (ou um pai dela) recebe valor inline, ou algo dentro dela é definido por chave
    // pontilhada FORA do cabeçalho dela. As chaves que estão sob o cabeçalho da própria seção são normais.
    const ruim = mapa.find((x) => x.tipo === "chave" && (comecaCom(alvo, x.caminho) || (comecaCom(x.caminho, alvo) && !comecaCom(x.tabela, alvo))));
    const hashDaSecao = mapa.find((x) => x.tipo === "chave" && igual(x.tabela, alvo) && igual(x.caminho, [...alvo, "trusted_hash"]));
    if (ruim) {
      throw new TomlNaoEditavel(
        `a confiança de ${chave} já está definida no config.toml na linha ${ruim.linha + 1} em forma inline ou por chave pontilhada (${linhas[ruim.linha].trim().slice(0, 60)}), que não edito com segurança`,
      );
    }
    if (cabs.length > 1) {
      throw new TomlNaoEditavel(`o config.toml tem a seção de ${chave} repetida (linhas ${cabs.map((c) => c.linha + 1).join(" e ")}), o que já é um TOML inválido`);
    }
    const linhaHash = `trusted_hash = ${JSON.stringify(hash)}`;
    if (cabs.length === 0) {
      if (linhas.length && linhas[linhas.length - 1].trim() !== "") linhas.push("");
      linhas.push(`[hooks.state.${JSON.stringify(chave)}]`, linhaHash);
      continue;
    }
    const ini = cabs[0].linha;
    const proximo = mapa.find((x) => x.linha > ini && (x.tipo === "cab" || x.tipo === "tabelaDeArray"));
    const fim = proximo ? proximo.linha : linhas.length;
    if (hashDaSecao) {
      const n = hashDaSecao.linha;
      const m = /^(\s*[^=]*?=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(linhas[n]);
      if (!m) throw new TomlNaoEditavel(`a linha ${n + 1} (trusted_hash de ${chave}) tem um formato que não edito com segurança`);
      linhas[n] = `${m[1]}${JSON.stringify(hash)}${m[3]}`;
    } else {
      let p = fim;
      while (p > ini + 1 && linhas[p - 1].trim() === "") p--;
      linhas.splice(p, 0, linhaHash);
    }
  }
  const saida = linhas.join("\n") + "\n";
  // Conferência final: cada chave tem UM cabeçalho, UM trusted_hash e o valor esperado.
  const mapa = varrer(saida);
  for (const { chave, hash } of itens) {
    const alvo = ["hooks", "state", chave];
    const n = mapa.filter((x) => x.tipo === "cab" && igual(x.partes, alvo)).length;
    const h = mapa.filter((x) => x.tipo === "chave" && igual(x.caminho, [...alvo, "trusted_hash"])).length;
    if (n !== 1 || h !== 1 || !saida.includes(JSON.stringify(hash))) {
      throw new TomlNaoEditavel(`a conferência final falhou para ${chave} (cabeçalhos: ${n}, trusted_hash: ${h})`);
    }
  }
  conferirComTomllib(texto, saida, itens);
  return saida;
}

export interface ResultadoDosHooks {
  instalados: number;
  /** Os promptHooks da sessão ficaram gravados e podem rodar. false = o runner NÃO deve pôr DGCLAW_SESSAO_ID no ambiente do Codex. */
  promptHooksOk?: boolean;
  /** Por que não instalou, quando não instalou por algo que merece aviso. */
  motivo?: string;
}

/**
 * Instala os hooks do DG Claw no CODEX_HOME e confia só neles. Idempotente: rodar de novo não
 * duplica e regrava a confiança se o conteúdo do hook mudou. Falhar aqui não derruba o spawn: o
 * agente sobe sem os hooks (o log diz o que fazer).
 */
/**
 * Acrescenta `[projects."<pasta>"] trust_level = "trusted"` ao fim do config.toml se a seção ainda não
 * existe (o Codex 0.162 ignora a confiança de pasta passada por -c na tela de confiança). Seção que já
 * existe, com qualquer trust_level, não é alterada.
 */
export function confiancaDaPastaNoToml(texto: string, cwd: string): string {
  const cabecalho = `[projects.${JSON.stringify(cwd)}]`;
  if (texto.split(/\r?\n/).some((l) => l.trim() === cabecalho)) return texto;
  const separador = texto === "" || texto.endsWith("\n\n") ? "" : texto.endsWith("\n") ? "\n" : "\n\n";
  return `${texto}${separador}${cabecalho}\ntrust_level = "trusted"\n`;
}

export interface OpcoesDeInstalacao {
  home: string;
  env: Record<string, string>;
  cwd: string;
  /** Os promptHooks DESTA sessão: vão para o arquivo de estado da sessão, nunca para o hooks.json. */
  promptHooks: string[];
  area: string;
  raiz?: string | null;
  /** Id da sessão (o runner o põe em DGCLAW_SESSAO_ID no ambiente do Codex). Sem ele, os promptHooks não são gravados. */
  sessaoId?: string;
  /** PASTA_DE_ESTADO do runner: onde ficam os promptHooks de cada sessão. */
  pastaDeEstado?: string;
  /** Quanto esperar pela trava antes de desistir (padrão 8000 ms). */
  esperaDaTravaMs?: number;
  /** Pasta a marcar como confiável no config.toml (`[projects."<pasta>"]`), na MESMA transação dos hooks. */
  confiancaDaPasta?: string;
}

/**
 * O hooks.json e o config.toml são do AGENTE: a principal e as paralelas que usam o mesmo CODEX_HOME
 * os leem e escrevem. Leitura, cálculo e gravação rodam sob uma trava de pasta (mkdir é atômico).
 * Sem a trava no prazo, NADA é gravado (o agente sobe sem os hooks desta vez, com o motivo no log):
 * como o conteúdo é igual para todas as sessões, a próxima subida conserta.
 */
export function instalarHooksNoCodex(opts: OpcoesDeInstalacao): ResultadoDosHooks {
  // Os promptHooks da sessão vão para o arquivo dela, independentemente da trava (é um arquivo por sessão).
  let promptHooksOk = true;
  if (opts.sessaoId && opts.pastaDeEstado) {
    promptHooksOk = gravarPromptHooksDaSessao({ pastaDeEstado: opts.pastaDeEstado, sessaoId: opts.sessaoId, promptHooks: opts.promptHooks, area: opts.area });
  }
  return { ...instalarComTrava(opts), promptHooksOk };
}

function instalarComTrava(opts: OpcoesDeInstalacao): ResultadoDosHooks {
  const trava = path.join(opts.home, ".dgclaw-hooks.lock");
  const espera = opts.esperaDaTravaMs ?? 8000;
  try {
    fs.mkdirSync(opts.home, { recursive: true, mode: 0o700 });
    const limite = Date.now() + espera;
    for (;;) {
      try {
        fs.mkdirSync(trava);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - fs.statSync(trava).mtimeMs > 30000) fs.rmdirSync(trava); // trava abandonada por um runner que caiu
        } catch {
          /* sumiu entre a checagem e a remoção: tenta de novo */
        }
        if (Date.now() > limite) {
          log.aviso(
            opts.area,
            `a trava ${trava} continuou ocupada por ${Math.round(espera / 1000)} s (outra sessão está instalando os hooks, ou um runner caiu no meio): não gravei os hooks do DG Claw nem a confiança da pasta nesta subida: o agente sobe sem o recall de memória e sem o quadro de avisos, e o Codex pode abrir perguntando se confia na pasta (responda 1 no terminal do painel). ` +
              `Reinicie o agente; se a mensagem se repetir, apague a pasta ${trava} (ela só marca "instalando")`,
          );
          return { instalados: 0, motivo: "trava ocupada" };
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      }
    }
  } catch (err) {
    log.aviso(opts.area, `não consegui criar a trava dos hooks em ${trava} (${err instanceof Error ? err.message : String(err)}): não gravei os hooks do DG Claw. Conferir a permissão de escrita em ${opts.home}`);
    return { instalados: 0, motivo: "sem trava" };
  }
  try {
    return instalarSemTrava(opts);
  } finally {
    try {
      fs.rmdirSync(trava);
    } catch {
      /* já tinha sumido */
    }
  }
}

function instalarSemTrava(opts: OpcoesDeInstalacao): ResultadoDosHooks {
  const { home, area } = opts;
  const raiz = opts.raiz === undefined ? raizDoPlugin() : opts.raiz;
  const ws = opts.env.DGCLAW_WORKSPACE?.trim() || opts.cwd;
  const temWorkspace = fs.existsSync(path.join(ws, ".dgclaw", "config.sh"));
  const temBun = achaNoPath("bun", opts.env.PATH ?? process.env.PATH);
  const temPython = achaNoPath("python3", opts.env.PATH ?? process.env.PATH);
  const hooks = hooksDoAgente({ raiz, workspace: ws, temWorkspace, temBun, temPython, pastaDeEstado: opts.pastaDeEstado });
  const arquivo = path.join(home, "hooks.json");
  const toml = path.join(home, "config.toml");
  const ehLink = (f: string) => {
    try {
      return fs.lstatSync(f).isSymbolicLink();
    } catch {
      return false; // não existe: tudo bem
    }
  };
  // O config.toml é lido UMA vez e gravado UMA vez (atômico), com a confiança da pasta e a dos hooks,
  // tudo dentro da trava. `soPasta` grava só a confiança da pasta, quando os hooks não vão entrar.
  let t = "";
  let modo = 0o600;
  let tomlLido = false;
  const leToml = () => {
    if (tomlLido) return;
    tomlLido = true;
    try {
      t = fs.readFileSync(toml, "utf8");
      modo = fs.statSync(toml).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  const comPasta = (base: string) => (opts.confiancaDaPasta ? confiancaDaPastaNoToml(base, opts.confiancaDaPasta) : base);
  const soPasta = () => {
    if (!opts.confiancaDaPasta) return;
    try {
      if (ehLink(toml)) {
        log.aviso(area, `${toml} é um atalho (link simbólico): não gravei a confiança da pasta ${opts.confiancaDaPasta}. Troque o atalho por um arquivo comum e reinicie o agente`);
        return;
      }
      leToml();
      const novo = comPasta(t);
      if (novo !== t) {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        gravarAtomico(toml, novo, modo);
      }
    } catch (err) {
      log.aviso(
        area,
        `não consegui gravar a confiança da pasta ${opts.confiancaDaPasta} em ${toml}: ${err instanceof Error ? err.message : String(err)}. ` +
          `O Codex vai abrir perguntando se confia na pasta; responda 1 no terminal do painel. Para evitar, conferir a permissão de escrita em ${home}`,
      );
    }
  };
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
      if (ehLink(f)) {
        log.aviso(area, `${f} é um atalho (link simbólico): não gravei os hooks do DG Claw para não escrever em outro lugar. Troque o atalho por um arquivo comum e reinicie o agente`);
        if (f !== toml) soPasta();
        else if (opts.confiancaDaPasta) log.aviso(area, `${toml} é um atalho (link simbólico): também não gravei a confiança da pasta ${opts.confiancaDaPasta}`);
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
        soPasta();
        return { instalados: 0, motivo: "hooks.json ilegível" };
      }
    }
    if (!existe && hooks.length === 0) {
      soPasta();
      return { instalados: 0 };
    }
    const { novo, confiar, descartados, deslocados } = mesclarHooks(atual, hooks, arquivo);
    if (descartados > 0) {
      log.info(area, `troquei ou tirei ${descartados} entrada(s) do hooks.json que tinham a marca do DG Claw mas não eram um dos comandos que o runner calcula (formato antigo ou escritas à mão); elas não recebem confiança`);
    }
    if (deslocados > 0) {
      log.aviso(
        area,
        `${deslocados} hook(s) seu(s) em ${arquivo} mudaram de posição porque entradas antigas do DG Claw que vinham antes deles saíram; o Codex liga a confiança à posição, então eles voltam a pedir confiança UMA vez. ` +
          `Confie de novo neles com /hooks no Codex`,
      );
    }
    const texto = JSON.stringify(novo, null, 2) + "\n";
    // O config.toml é calculado ANTES de gravar qualquer coisa: se os hooks não puderem entrar com
    // segurança, o hooks.json não é gravado (só a confiança da pasta, que é um acréscimo simples).
    let novoToml = "";
    if (confiar.length || opts.confiancaDaPasta) {
      leToml();
      novoToml = comPasta(t);
      if (confiar.length) {
        try {
          novoToml = garantirConfiancaNoToml(novoToml, confiar);
        } catch (err) {
          if (!(err instanceof TomlNaoEditavel)) throw err;
          log.aviso(
            area,
            `não gravei os hooks do DG Claw no Codex: ${err.message}. O config.toml (${toml}) ficou como estava (salvo a confiança da pasta) e o agente sobe sem o recall de memória e sem o quadro de avisos. ` +
              `Para ligar, deixe a confiança de cada hook como uma seção comum [hooks.state."<chave>"] (ou apague a definição que está em outra forma) e reinicie o agente`,
          );
          soPasta();
          return { instalados: 0, motivo: "config.toml não editável" };
        }
      }
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (texto !== bruto) gravarAtomico(arquivo, texto, existe ? fs.statSync(arquivo).mode & 0o777 : 0o600);
    if ((confiar.length || opts.confiancaDaPasta) && novoToml !== t) gravarAtomico(toml, novoToml, modo);
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
