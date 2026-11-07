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
  promptHooks: string[];
}

/** Os hooks que este agente recebe. Mesmos comandos e tempos do `hooks/hooks.json` do Claude. */
export function hooksDoAgente(e: EntradaDeHooks): HookDoDgclaw[] {
  const out: HookDoDgclaw[] = [];
  // A marca fica no começo do comando; o workspace vem logo depois como atribuição de ambiente
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
  for (const p of e.promptHooks) {
    if (typeof p === "string" && p.trim()) out.push({ evento: "UserPromptSubmit", command: prefixo + p.trim(), timeout: 10 });
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

/** Comando do DG Claw: a marca no começo (formato antigo) ou logo depois do `cd '<pasta>' && ` (formato atual). */
export const ehComandoDoDgclaw = (c: unknown): boolean => typeof c === "string" && (c.startsWith(MARCA_DO_DGCLAW) || (c.startsWith("cd ") && c.includes(` && ${MARCA_DO_DGCLAW}DGCLAW_WORKSPACE=`)));
const ehDoDgclaw = (m: Manipulador) => ehComandoDoDgclaw(m?.command);

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

/** Varre o TOML linha a linha: cabeçalhos de tabela e chaves (com o caminho completo). Ignora o miolo de strings de várias linhas. */
function varrer(linhas: string[]): Item[] {
  const itens: Item[] = [];
  let tabela: Parte[] = [];
  let multi: string | null = null;
  linhas.forEach((l, n) => {
    if (multi) {
      if (l.includes(multi) && (l.split(multi).length - 1) % 2 === 1) multi = null;
      return;
    }
    const t = l.trimStart();
    if (t === "" || t.startsWith("#")) return;
    if (t.startsWith("[[")) {
      itens.push({ tipo: "tabelaDeArray", linha: n });
      tabela = ["[["];
      return;
    }
    if (t.startsWith("[")) {
      const k = lerChave(t, 1);
      if (k && t[k.fim] === "]") {
        const resto = t.slice(k.fim + 1).trim();
        if (resto === "" || resto.startsWith("#")) {
          itens.push({ tipo: "cab", partes: k.partes, linha: n });
          tabela = k.partes;
        }
      }
      return; // o resto é continuação de array de várias linhas, por exemplo
    }
    const k = lerChave(t, 0);
    if (k && t[k.fim] === "=") {
      itens.push({ tipo: "chave", tabela, caminho: [...tabela, ...k.partes], linha: n });
      const valor = t.slice(k.fim + 1);
      for (const d of ['"""', "'''"]) {
        if ((valor.split(d).length - 1) % 2 === 1) multi = d;
      }
    }
  });
  return itens;
}

const igual = (a: Parte[], b: Parte[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const comecaCom = (a: Parte[], pre: Parte[]) => a.length >= pre.length && pre.every((x, i) => x === a[i]);

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
    const mapa = varrer(linhas);
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
  const mapa = varrer(saida.split("\n"));
  for (const { chave, hash } of itens) {
    const alvo = ["hooks", "state", chave];
    const n = mapa.filter((x) => x.tipo === "cab" && igual(x.partes, alvo)).length;
    const h = mapa.filter((x) => x.tipo === "chave" && igual(x.caminho, [...alvo, "trusted_hash"])).length;
    if (n !== 1 || h !== 1 || !saida.includes(JSON.stringify(hash))) {
      throw new TomlNaoEditavel(`a conferência final falhou para ${chave} (cabeçalhos: ${n}, trusted_hash: ${h})`);
    }
  }
  return saida;
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
  const hooks = hooksDoAgente({ raiz, workspace: ws, temWorkspace, temBun, promptHooks: opts.promptHooks });
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
    // O config.toml é calculado ANTES de gravar qualquer coisa: se ele não puder ser editado com
    // segurança, nada é gravado (nem o hooks.json) e os arquivos da pessoa ficam como estavam.
    let t = "";
    let modo = 0o600;
    let novoToml = "";
    if (confiar.length) {
      try {
        t = fs.readFileSync(toml, "utf8");
        modo = fs.statSync(toml).mode & 0o777;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      try {
        novoToml = garantirConfiancaNoToml(t, confiar);
      } catch (err) {
        if (!(err instanceof TomlNaoEditavel)) throw err;
        log.aviso(
          area,
          `não gravei os hooks do DG Claw no Codex: ${err.message}. O config.toml (${toml}) ficou como estava e o agente sobe sem o recall de memória e sem o quadro de avisos. ` +
            `Para ligar, deixe a confiança de cada hook como uma seção comum [hooks.state."<chave>"] (ou apague a definição que está em outra forma) e reinicie o agente`,
        );
        return { instalados: 0, motivo: "config.toml não editável" };
      }
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    if (texto !== bruto) gravarAtomico(arquivo, texto, existe ? fs.statSync(arquivo).mode & 0o777 : 0o600);
    if (confiar.length && novoToml !== t) gravarAtomico(toml, novoToml, modo);
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
