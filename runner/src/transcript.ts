// Ler a conversa do agente de volta do disco.
//
// O `agents-server` pede isto para mostrar as últimas trocas na tela da pessoa
// (`conversaDoCard`), e o painel do DG Claw usa o mesmo caminho. É uma leitura
// pequena de propósito: as últimas N mensagens de texto, sem tool call, sem
// sidechain e sem o system-reminder, que é o que alguém quer ver ao abrir a
// janela. Análise profunda de transcript é problema do Bunker, não do runner.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./logger.js";
import { mascarar } from "./mascara.js";

export interface Mensagem {
  role: string;
  text: string;
}

/** A pasta onde o CLI guarda as sessões. Respeita CLAUDE_CONFIG_DIR, que é o que
 *  um agente com config próprio usa: procurar só em ~/.claude devolveria "sem
 *  conversa" para um agente que tem conversa. */
function pastaDeProjetos(configDir?: string | null): string {
  const casa = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(casa, "projects");
}

/**
 * Acha o arquivo de uma sessão pelo id. Varre as pastas de projeto em vez de
 * calcular o nome a partir do cwd porque o encoding do nome muda entre
 * plataformas, e porque um `/resume` digitado dentro do TUI grava a sessão sob
 * outra pasta. Varredura de umas dezenas de diretórios é barata; errar o nome
 * calculado custa uma janela de conversa vazia sem nenhum erro no caminho.
 */
export function acharArquivoDaSessao(sessionId: string, configDir?: string | null): string | null {
  const raiz = pastaDeProjetos(configDir);
  try {
    if (!fs.existsSync(raiz)) return null;
    for (const dir of fs.readdirSync(raiz)) {
      const alvo = path.join(raiz, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(alvo)) return alvo;
    }
    // Algumas instalações gravam o jsonl solto na raiz.
    const solto = path.join(raiz, `${sessionId}.jsonl`);
    if (fs.existsSync(solto)) return solto;
    return null;
  } catch (err) {
    log.aviso("conversa", `não consegui varrer ${raiz}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function textoDoConteudo(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (!Array.isArray(conteudo)) return "";
  const partes: string[] = [];
  for (const bloco of conteudo) {
    if (bloco && typeof bloco === "object" && (bloco as { type?: string }).type === "text") {
      const t = (bloco as { text?: string }).text;
      if (typeof t === "string") partes.push(t);
    }
  }
  return partes.join("");
}

/** As últimas `quantas` mensagens de texto da sessão, mais antiga primeiro, com os segredos mascarados. */
export function ultimasMensagens(
  sessionId: string,
  quantas = 6,
  configDir?: string | null,
  segredos?: Iterable<string>,
): Mensagem[] | null {
  const arquivo = acharArquivoDaSessao(sessionId, configDir);
  if (!arquivo) {
    log.info("conversa", `não achei o arquivo da sessão ${sessionId} (a conversa pode ainda não ter primeira troca)`);
    return null;
  }
  let cru: string;
  try {
    cru = fs.readFileSync(arquivo, "utf8");
  } catch (err) {
    log.erro(
      "conversa",
      `não consegui ler ${arquivo}: ${err instanceof Error ? err.message : err}`,
      "conferir permissão de leitura do arquivo de sessão; a conversa não foi perdida, só não foi lida",
    );
    return null;
  }
  const fora: Mensagem[] = [];
  for (const linha of cru.split("\n")) {
    if (!linha.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(linha) as Record<string, unknown>;
    } catch {
      continue; // linha truncada no fim do arquivo é normal enquanto o CLI escreve
    }
    // Sidechain é conversa de subagente: não é o que a pessoa mandou nem o que o
    // agente respondeu a ela.
    if (d.isSidechain === true) continue;
    const msg = d.message as { role?: string; content?: unknown } | undefined;
    if (!msg?.role) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const texto = textoDoConteudo(msg.content).trim();
    if (!texto) continue;
    // O system-reminder e os comandos locais são ruído de mecanismo, não fala.
    if (texto.startsWith("<system-reminder>") || texto.startsWith("<command-name>")) continue;
    // O histórico também é tela: valor do cofre que o agente tenha escrito não sai daqui.
    fora.push({ role: msg.role, text: mascarar(texto, segredos) });
  }
  return fora.slice(-Math.max(1, quantas));
}

const CAUDA_DO_TRANSCRIPT = 16 * 1024;

/** Os últimos ~16 KB do arquivo, começando numa linha inteira. Lança se não conseguir ler. */
function lerCauda(arquivo: string): string {
  const fd = fs.openSync(arquivo, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const inicio = Math.max(0, size - CAUDA_DO_TRANSCRIPT);
    const buf = Buffer.alloc(size - inicio);
    fs.readSync(fd, buf, 0, buf.length, inicio);
    let cauda = buf.toString("utf8");
    // Começar no meio do arquivo corta a primeira linha ao meio: descarta.
    if (inicio > 0) cauda = cauda.slice(cauda.indexOf("\n") + 1);
    return cauda;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * O turno acabou? O Claude Code grava `system/turn_duration` (logo depois de `stop_hook_summary`) ao
 * fim de todo turno. Lê só os últimos ~16 KB e olha a ÚLTIMA linha JSON válida: se for uma dessas e
 * mais nova que `desdeMs` (o começo do turno atual), o turno acabou. Qualquer outra coisa (tool_use,
 * assistant parcial, tool_result) quer dizer que segue trabalhando. Sem arquivo, não afirma nada.
 */
export function turnoEncerradoNoTranscript(
  sessionId: string,
  desdeMs: number,
  configDir?: string | null,
): { encerrado: boolean; motivo: string } {
  const arquivo = acharArquivoDaSessao(sessionId, configDir);
  if (!arquivo) return { encerrado: false, motivo: `transcript da sessão ${sessionId} não encontrado` };
  let cauda: string;
  try {
    cauda = lerCauda(arquivo);
  } catch (err) {
    log.aviso("conversa", `não consegui ler o fim de ${arquivo}: ${err instanceof Error ? err.message : err}`);
    return { encerrado: false, motivo: "transcript ilegível" };
  }
  const linhas = cauda.split("\n");
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (!linhas[i].trim()) continue;
    let o: { type?: string; subtype?: string; timestamp?: string };
    try {
      o = JSON.parse(linhas[i]);
    } catch {
      continue;
    }
    const rotulo = `${o.type ?? "?"}${o.subtype ? "/" + o.subtype : ""}`;
    if (o.type !== "system" || (o.subtype !== "turn_duration" && o.subtype !== "stop_hook_summary")) {
      return { encerrado: false, motivo: `última linha é ${rotulo}` };
    }
    const quando = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(quando)) return { encerrado: false, motivo: `${rotulo} sem timestamp válido` };
    if (quando <= desdeMs) return { encerrado: false, motivo: `${rotulo} é anterior ao começo do turno atual` };
    return { encerrado: true, motivo: `última linha é ${rotulo}` };
  }
  return { encerrado: false, motivo: "nenhuma linha JSON válida no fim do transcript" };
}

/** O texto que o Claude Code mostra (e devolve em `claude -p`) quando o OAuth da conta morreu. */
export const RX_LOGIN_EXPIRADO =
  /login expired|please run \/login|oauth session expired|could not be refreshed|failed to authenticate|invalid api key/i;

/**
 * O fim do transcript é a linha sintética de "login expirado"? Quando o OAuth morre, o Claude Code
 * grava uma linha assistant com `message.model "<synthetic>"`, `isApiErrorMessage true`, `error
 * "authentication_failed"` e o texto "Login expired · Please run /login", e NÃO dispara o hook Stop.
 *
 * Olha a ÚLTIMA linha de mensagem (user/assistant; as `system` e outras de bookkeeping são puladas):
 * se for a sintética, expirou; se for qualquer outra coisa, o agente já falou depois. Só vale se a
 * linha for mais nova que `maisNovaQue` (ms): a data da credencial, porque um login refeito depois
 * do erro deixa a linha velha no arquivo para sempre e ela não pode derrubar o agente de novo.
 */
export function loginExpiradoNoFimDoTranscript(
  sessionId: string,
  maisNovaQue: number,
  configDir?: string | null,
): { expirado: boolean; quando: number | null; motivo: string } {
  const arquivo = acharArquivoDaSessao(sessionId, configDir);
  if (!arquivo) return { expirado: false, quando: null, motivo: `transcript da sessão ${sessionId} não encontrado` };
  let cauda: string;
  try {
    cauda = lerCauda(arquivo);
  } catch (err) {
    log.aviso("conversa", `não consegui ler o fim de ${arquivo}: ${err instanceof Error ? err.message : err}`);
    return { expirado: false, quando: null, motivo: "transcript ilegível" };
  }
  const linhas = cauda.split("\n");
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (!linhas[i].trim()) continue;
    let o: {
      type?: string;
      timestamp?: string;
      isApiErrorMessage?: boolean;
      error?: string;
      message?: { model?: string; content?: unknown };
    };
    try {
      o = JSON.parse(linhas[i]);
    } catch {
      continue;
    }
    if (o.type !== "assistant" && o.type !== "user") continue;
    if (o.type === "user") return { expirado: false, quando: null, motivo: "a última mensagem é do usuário ou de uma ferramenta" };
    const sintetica = o.message?.model === "<synthetic>" && o.isApiErrorMessage === true;
    const texto = textoDoConteudo(o.message?.content);
    if (!sintetica || !(o.error === "authentication_failed" || RX_LOGIN_EXPIRADO.test(texto))) {
      return { expirado: false, quando: null, motivo: "a última mensagem não é o erro de login" };
    }
    const quando = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(quando)) return { expirado: false, quando: null, motivo: "o erro de login não tem timestamp válido" };
    if (quando <= maisNovaQue) return { expirado: false, quando, motivo: "o erro de login é anterior à credencial atual" };
    return { expirado: true, quando, motivo: "a última mensagem é o erro sintético de login expirado" };
  }
  return { expirado: false, quando: null, motivo: "nenhuma mensagem no fim do transcript" };
}
