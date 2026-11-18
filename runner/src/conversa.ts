// A conversa de uma sessão como o GET /conversation a devolve. Fica fora do servidor.ts para
// poder ser testada sem subir o runner.
import { ultimasMensagens, type Mensagem } from "./transcript.js";
import { acharRolloutPorId, mensagensDoRollout } from "./provedores/codex-rollout.js";

export interface PedidoDeConversa {
  provedor: "claude" | "codex";
  sessionId: string;
  /** A conversa de antes da última troca de sessão (estado.previousSessionId), se houver. */
  previousSessionId?: string | null;
  limite: number;
  /** CLAUDE_CONFIG_DIR da sessão (onde o transcript do Claude é gravado). */
  configDir?: string | null;
  /** CODEX_HOME da sessão (onde o rollout do Codex é gravado). */
  codexHome: string;
  segredos?: Iterable<string>;
}

export interface Conversa {
  msgs: Mensagem[];
  /** Só vem quando as mensagens são da sessão ANTERIOR, porque a atual ainda não gravou nada. */
  aviso?: string;
}

function lerDe(provedor: "claude" | "codex", id: string, p: PedidoDeConversa): Mensagem[] | null {
  if (provedor === "codex") {
    const arquivo = acharRolloutPorId(id, p.codexHome);
    return arquivo ? mensagensDoRollout(arquivo, p.limite, p.segredos) : null;
  }
  return ultimasMensagens(id, p.limite, p.configDir, p.segredos);
}

/** Lê a conversa da sessão atual. Se ela ainda não tem arquivo (a sessão acabou de nascer, ou o pedido
 *  nunca virou turno) e existe uma sessão anterior com arquivo, devolve as mensagens dela com um aviso.
 *  A anterior pode ser do outro motor (a troca de provedor é justamente o que a cria), então tenta os dois. */
export function lerConversa(p: PedidoDeConversa): Conversa {
  const atual = lerDe(p.provedor, p.sessionId, p);
  if (atual) return { msgs: atual };
  const antes = p.previousSessionId;
  if (antes && antes !== p.sessionId) {
    const outro = p.provedor === "codex" ? "claude" : "codex";
    const velha = lerDe(p.provedor, antes, p) ?? lerDe(outro, antes, p);
    if (velha) {
      return {
        msgs: velha,
        aviso:
          "A sessão atual ainda não gravou nenhuma mensagem. O que aparece aqui é a conversa da sessão anterior, " +
          "que continua guardada no disco.",
      };
    }
  }
  return { msgs: [] };
}
