// A conversa de um card do OpenCode, para o `GET /conversation`.
//
// O OpenCode guarda a conversa num banco próprio, sem arquivo de texto para ler. O caminho suportado
// é o comando `opencode export <ses_...>`, que escreve um JSON no stdout ({ info, messages: [{ info:
// { role }, parts: [{ type: "text", text } | ferramentas...] }] }) e uma linha de aviso no stderr.
// Roda com o MESMO ambiente e a mesma pasta do card, funciona com a TUI aberta e não chama modelo
// nenhum (não gasta crédito). Só o texto entra na resposta, e passa pela máscara de segredos.
import { execFile } from "node:child_process";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";

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
    log.erro(
      "conversa",
      `o 'opencode export' não devolveu um JSON válido: ${err instanceof Error ? err.message : err}`,
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

/** Roda `opencode export` e devolve as últimas mensagens; null (com o motivo no log) se não conseguiu. */
export function lerConversaDoOpenCode(p: PedidoDeConversa): Promise<MensagemDoOpenCode[] | null> {
  if (!ID_DE_SESSAO.test(p.sessionId)) {
    log.erro("conversa", `o id de sessão '${p.sessionId.slice(0, 40)}' não tem a forma de um id do OpenCode (ses_...)`, "esperar a primeira mensagem do card; o id é descoberto quando ele a recebe");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile(
      p.binario ?? "opencode",
      ["export", p.sessionId],
      { env: p.env, cwd: p.cwd, timeout: PRAZO_MS, maxBuffer: TETO_DA_SAIDA },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          log.erro(
            "conversa",
            e.code === "ENOENT"
              ? "o programa 'opencode' não está no PATH do agente"
              : e.killed
                ? `o 'opencode export' passou de ${PRAZO_MS / 1000} s e foi encerrado`
                : `o 'opencode export ${p.sessionId}' falhou (${e.message.split("\n")[0]})`,
            "conferir se o OpenCode está instalado na imagem do agente e se a sessão existe; a conversa não foi perdida, só não foi lida",
          );
          return resolve(null);
        }
        resolve(mensagensDoExport(String(stdout), p.quantas, p.segredos));
      },
    );
  });
}
