// A conversa de um card do OpenCode, para o `GET /conversation`.
//
// O OpenCode guarda a conversa num banco próprio, sem arquivo de texto para ler. O caminho suportado
// é o comando `opencode export <ses_...>`, que escreve um JSON no stdout ({ info, messages: [{ info:
// { role }, parts: [{ type: "text", text } | ferramentas...] }] }) e uma linha de aviso no stderr.
// Roda com o MESMO ambiente e a mesma pasta do card, funciona com a TUI aberta e não chama modelo
// nenhum (não gasta crédito). Só o texto entra na resposta, e passa pela máscara de segredos.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";

/** A leitura falhou: o motivo e o que fazer já em português, para a rota responder com erro e não com lista vazia. */
export class ErroDeConversa extends Error {
  constructor(
    mensagem: string,
    readonly comoResolver: string,
  ) {
    super(mensagem);
  }
}

export interface MensagemDoOpenCode {
  role: string;
  text: string;
}

const ID_DE_SESSAO = /^ses_[A-Za-z0-9]{6,60}$/;
const PRAZO_MS = 10_000;
const TETO_DA_SAIDA = 32 * 1024 * 1024;

interface ParteBruta {
  type?: unknown;
  text?: unknown;
  synthetic?: unknown;
  ignored?: unknown;
}
interface MensagemBruta {
  info?: { role?: unknown };
  parts?: ParteBruta[];
}

/** Do JSON do `opencode export` para as últimas `quantas` mensagens de texto, mais antiga primeiro. */
export function mensagensDoExport(json: string, quantas = 6, segredos?: Iterable<string>): MensagemDoOpenCode[] | null {
  let o: { messages?: MensagemBruta[] };
  try {
    o = JSON.parse(json) as typeof o;
  } catch (err) {
    // Só o tipo da falha e o tamanho: a mensagem do JSON.parse pode trazer um pedaço da própria conversa.
    log.erro(
      "conversa",
      `o 'opencode export' não devolveu um JSON válido (${err instanceof Error ? err.name : "erro"}, ${json.length} caracteres de saída)`,
      "conferir a versão do OpenCode (a conversa não foi perdida, só não foi lida)",
    );
    return null;
  }
  if (!o || !Array.isArray(o.messages)) {
    log.erro("conversa", "o JSON do 'opencode export' veio sem a lista 'messages'", "conferir a versão do OpenCode; o formato do export pode ter mudado");
    return null;
  }
  const fora: MensagemDoOpenCode[] = [];
  for (const m of o.messages) {
    const role = m?.info?.role;
    if (role !== "user" && role !== "assistant") continue;
    const texto = (Array.isArray(m.parts) ? m.parts : [])
      .filter((p) => p?.type === "text" && typeof p.text === "string" && p.synthetic !== true && p.ignored !== true)
      .map((p) => (p.text as string).trim())
      .filter(Boolean)
      .join("\n\n");
    if (!texto) continue;
    fora.push({ role, text: mascarar(texto, segredos) });
  }
  return fora.slice(-Math.max(1, quantas));
}

export interface PedidoDeConversa {
  sessionId: string;
  env: Record<string, string>;
  cwd: string;
  quantas: number;
  segredos?: Iterable<string>;
  /** Só os testes trocam (um programa falso no lugar do `opencode`). */
  binario?: string;
}

// O `opencode export` escreve a conversa INTEIRA, mesmo quando só a última mensagem interessa, e cada chamada
// é um processo novo. Por isso: no máximo UMA leitura por sessão ao mesmo tempo (quem chega no meio pega a que já
// está rodando), um cache curto do resultado (o painel pergunta várias vezes por segundo) e no máximo
// MAX_LEITURAS processos ao mesmo tempo no runner inteiro, o resto espera na fila.
const MAX_LEITURAS = 2;
const CACHE_MS = 2_000;
let leiturasAtivas = 0;
const esperando: Array<() => void> = [];
const emAndamento = new Map<string, Promise<MensagemDoOpenCode[]>>();
const cache = new Map<string, { ate: number; msgs: MensagemDoOpenCode[]; bytes: number }>();
/** Teto da soma dos históricos guardados (e de um só): passou, o resultado não é guardado e o painel só relê. */
const TETO_DO_CACHE = 16 * 1024 * 1024;
const TETO_DE_UM = 4 * 1024 * 1024;
const FALHA_RECENTE = new Map<string, { ate: number; erro: ErroDeConversa }>();

async function pegarVaga(): Promise<void> {
  if (leiturasAtivas < MAX_LEITURAS) {
    leiturasAtivas += 1;
    return;
  }
  await new Promise<void>((ok) => esperando.push(ok));
}
function soltarVaga(): void {
  const proxima = esperando.shift();
  if (proxima) proxima();
  else leiturasAtivas -= 1;
}

function tamanhoDe(msgs: MensagemDoOpenCode[]): number {
  return msgs.reduce((t, m) => t + m.text.length * 2 + 64, 0);
}

/** Tira do cache o que venceu e, passando do teto global, o mais antigo; cada entrada some sozinha ao vencer. */
function guardarNoCache(sessionId: string, msgs: MensagemDoOpenCode[]): void {
  const agora = Date.now();
  for (const [k, v] of cache) if (v.ate <= agora) cache.delete(k);
  for (const [k, v] of FALHA_RECENTE) if (v.ate <= agora) FALHA_RECENTE.delete(k);
  const bytes = tamanhoDe(msgs);
  if (bytes > TETO_DE_UM) return;
  let total = bytes;
  for (const v of cache.values()) total += v.bytes;
  for (const k of [...cache.keys()]) {
    if (total <= TETO_DO_CACHE) break;
    total -= cache.get(k)?.bytes ?? 0;
    cache.delete(k);
  }
  const entrada = { ate: agora + CACHE_MS, msgs, bytes };
  cache.set(sessionId, entrada);
  const t = setTimeout(() => {
    if (cache.get(sessionId) === entrada) cache.delete(sessionId);
  }, CACHE_MS + 50);
  t.unref();
}

/** Quantas conversas estão guardadas agora (só os testes). */
export function tamanhoDoCacheDeConversa(): number {
  return cache.size;
}

/** Limpa o cache e as leituras guardadas (só os testes). */
export function zerarConversaDoOpenCode(): void {
  cache.clear();
  FALHA_RECENTE.clear();
  emAndamento.clear();
}

/** As únicas variáveis que o `opencode export` recebe: ele só lê o banco local, não precisa de chave nenhuma. */
const VARIAVEIS_DA_LEITURA = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

/**
 * Um ambiente de LEITURA, montado do zero a cada exportação: o `opencode export` carrega a configuração antes de
 * ler o banco, e as pastas do agente são graváveis por ele. Por isso o processo recebe uma lista mínima de variáveis
 * (nenhuma credencial do Cofre, do OpenRouter ou do agente), uma pasta de configuração nova, vazia e de uso único
 * (sem plugins, sem dependências para instalar) e a configuração da pasta de trabalho desligada. Um plugin plantado
 * pelo agente não roda e, se rodasse, não teria chave nenhuma para levar.
 */
export function ambienteDeLeitura(env: Record<string, string>): { env: Record<string, string>; pasta: string } {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "dgclaw-opencode-leitura-"));
  fs.chmodSync(pasta, 0o700);
  fs.mkdirSync(path.join(pasta, "xdg", "opencode"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(pasta, "casa-vazia"), { mode: 0o700 });
  const minimo: Record<string, string> = {};
  for (const nome of VARIAVEIS_DA_LEITURA) {
    const v = env[nome];
    if (typeof v === "string") minimo[nome] = v;
  }
  return {
    pasta,
    env: {
      ...minimo,
      XDG_CONFIG_HOME: path.join(pasta, "xdg"),
      OPENCODE_TEST_HOME: path.join(pasta, "casa-vazia"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    },
  };
}

function exportar(p: PedidoDeConversa): Promise<MensagemDoOpenCode[]> {
  const leitura = ambienteDeLeitura(p.env);
  return new Promise((resolve, reject) => {
    execFile(
      p.binario ?? "opencode",
      ["export", p.sessionId],
      { env: leitura.env, cwd: p.cwd, timeout: PRAZO_MS, maxBuffer: TETO_DA_SAIDA },
      (err, stdout) => {
        try {
          fs.rmSync(leitura.pasta, { recursive: true, force: true });
        } catch (e) {
          log.aviso("conversa", `não consegui apagar ${leitura.pasta} (config temporária da leitura): ${e instanceof Error ? e.message : e}`);
        }
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          const motivo =
            e.code === "ENOENT"
              ? "o programa 'opencode' não está no PATH do agente"
              : e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? `a conversa passou de ${TETO_DA_SAIDA / 1024 / 1024} MiB no 'opencode export' e não pôde ser lida`
                : e.killed
                  ? `o 'opencode export' passou de ${PRAZO_MS / 1000} s e foi encerrado`
                  : `o 'opencode export ${p.sessionId}' falhou (${e.message.split("\n")[0]})`;
          const como =
            e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "a conversa não foi perdida: ela segue no card e no terminal. Para continuar lendo por aqui, fechar este card e abrir outro com o resumo do que já foi feito"
              : "conferir se o OpenCode está instalado na imagem do agente e se a sessão existe; a conversa não foi perdida, só não foi lida";
          log.erro("conversa", motivo, como);
          return reject(new ErroDeConversa(motivo, como));
        }
        // Todas as mensagens de texto (já mascaradas): quem pede recorta as últimas `quantas`.
        const todas = mensagensDoExport(String(stdout), Number.MAX_SAFE_INTEGER, p.segredos);
        if (!todas) {
          return reject(
            new ErroDeConversa(
              "o 'opencode export' devolveu algo que o runner não entendeu (detalhe no log do runner)",
              "conferir a versão do OpenCode; o formato do export pode ter mudado. A conversa não foi perdida, só não foi lida",
            ),
          );
        }
        resolve(todas);
      },
    );
  });
}

/**
 * Roda `opencode export` e devolve as últimas mensagens. Falha = lança ErroDeConversa (o motivo e o que
 * fazer), nunca uma lista vazia que pareça "sem conversa".
 */
export async function lerConversaDoOpenCode(p: PedidoDeConversa): Promise<MensagemDoOpenCode[]> {
  if (!ID_DE_SESSAO.test(p.sessionId)) {
    const motivo = `o id de sessão '${p.sessionId.slice(0, 40)}' não tem a forma de um id do OpenCode (ses_...)`;
    const como = "esperar a primeira mensagem do card; o id é descoberto quando ele a recebe";
    log.erro("conversa", motivo, como);
    throw new ErroDeConversa(motivo, como);
  }
  const quantas = Math.max(1, p.quantas);
  const agora = Date.now();
  const guardada = cache.get(p.sessionId);
  if (guardada && guardada.ate > agora) return guardada.msgs.slice(-quantas);
  // Falhou há pouco: repete o mesmo erro por alguns segundos em vez de abrir outro processo para falhar igual.
  const falhou = FALHA_RECENTE.get(p.sessionId);
  if (falhou && falhou.ate > agora) throw falhou.erro;
  let leitura = emAndamento.get(p.sessionId);
  if (!leitura) {
    leitura = (async () => {
      await pegarVaga();
      try {
        const msgs = await exportar(p);
        guardarNoCache(p.sessionId, msgs);
        return msgs;
      } catch (err) {
        if (err instanceof ErroDeConversa) FALHA_RECENTE.set(p.sessionId, { ate: Date.now() + 5_000, erro: err });
        throw err;
      } finally {
        soltarVaga();
        emAndamento.delete(p.sessionId);
      }
    })();
    emAndamento.set(p.sessionId, leitura);
  }
  return (await leitura).slice(-quantas);
}
