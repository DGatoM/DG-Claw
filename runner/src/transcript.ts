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
