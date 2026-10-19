import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";
import { RX_LOGIN_EXPIRADO } from "../transcript.js";
import { spawn } from "./ciclo.js";
import { STOP_CONFIRM_MS } from "./constantes.js";
import { talvezSoltarFila } from "./fila.js";
import { conferirLoginExpiradoNoTranscript, marcarLoginExpirado } from "./login.js";
import { nonceConfere } from "./telas.js";

/** O que o handler de hook (Claude) ou o `notify` (Codex) manda ao runner. */
export interface PayloadDeEvento {
  event?: string;
  sessionId?: string | null;
  toolName?: string | null;
  source?: string | null;
  error?: string | null;
  lastAssistantMessage?: string | null;
}

export interface PayloadDeHook extends PayloadDeEvento {
  agentId?: string;
  nonce?: string;
}

/** Recebe o POST do handler de hook (o do Claude ou o `notify` do Codex). Nonce errado é
 *  descartado: é hook de um PTY já morto, ou de um processo que não é este. O evento SÓ
 *  muda o status: nunca injeta texto, nunca dispara comando e nunca devolve conteúdo. */
export function receberHook(s: Sessao, payload: PayloadDeHook): { ok: boolean; motivo?: string } {
  if (!payload.agentId || !payload.event) return { ok: false, motivo: "faltou agentId ou event" };
  if (payload.agentId !== s.descritor.id) return { ok: false, motivo: "agentId de outro agente" };
  if (!nonceConfere(s.nonce, payload.nonce)) return { ok: false, motivo: "nonce de um spawn antigo" };
  return aplicarEvento(s, payload);
}

/** O efeito de um evento de status já autenticado (vindo do hook ou do rollout do Codex). */
export function aplicarEvento(s: Sessao, payload: PayloadDeEvento): { ok: boolean; motivo?: string } {
  // O session_id do evento é a fonte mais confiável que existe: vem do próprio
  // CLI. É assim que o runner descobre quando o agente trocou de sessão por
  // dentro (um `/resume` digitado no TUI), caso em que o id que guardamos
  // ficaria apontando para uma conversa que ninguém mais escreve.
  if (payload.sessionId && payload.sessionId !== s.estado.sessionId) {
    log.info(s.a("hook"), `a sessão viva mudou por dentro: ${s.estado.sessionId} -> ${payload.sessionId}`);
    s.mudar({
      sessionId: payload.sessionId,
      previousSessionId: s.estado.sessionId ?? s.estado.previousSessionId ?? null,
    });
  }

  if (["UserPromptSubmit", "PreToolUse", "Stop", "StopFailure", "PreCompact"].includes(payload.event ?? "")) s.marcarAtividade();
  s.hooksVivos = true;
  if (!s.estado.hookActive) s.estado.hookActive = true;

  // Estado terminal não é mexido por hook: quem manda no fim é o onExit do PTY.
  if (s.estado.status === "stopped" || s.estado.status === "resumable" || s.estado.status === "errored") {
    return { ok: true };
  }

  switch (payload.event) {
    case "SessionStart":
      // O fim do compact chega aqui, como SessionStart com source=compact, e é o
      // único sinal de fim que ele dá. Sem este ramo o PreCompact deixava o agente
      // em working para sempre e a fila de ocioso nunca soltava: um agente de cliente passou 8
      // dias assim (02/09 a 11/09/2026) com o /api/saude dizendo ok. Se o compact
      // foi o automático no meio de um turno, o PreToolUse seguinte cancela.
      if (payload.source === "compact") {
        log.info(s.a("hook"), "fim do compact (SessionStart source=compact): volto para idle depois da janela quieta");
        agendarStop(s);
      }
      if (s.estado.status === "spawning") {
        // Retomada de uma sessão que já tinha morrido por login expirado (runner reiniciado nesse meio tempo).
        if (s.retomando && conferirLoginExpiradoNoTranscript(s, 0, "retomada")) break;
        s.mudar({ status: "idle", statusReason: "hook:SessionStart" });
      }
      break;
    case "UserPromptSubmit":
      cancelarStopPendente(s);
      // O contador é o RECIBO do Enter: é a única prova, vinda do próprio CLI,
      // de que o texto virou turno em vez de ficar escrito na caixa. Quem espera
      // por ele é o enviarComRecibo().
      s.promptsAceitos += 1;
      s.turnoComecouEm = Date.now();
      s.mudar({ status: "working", hookLatched: false, statusReason: "hook:UserPromptSubmit" });
      break;
    case "PreToolUse":
      cancelarStopPendente(s);
      if (s.estado.status !== "working") {
        s.turnoComecouEm = Date.now();
        s.mudar({
          status: "working",
          hookLatched: false,
          currentTool: payload.toolName ?? null,
          statusReason: `hook:PreToolUse ${payload.toolName ?? ""}`,
        });
      } else if (payload.toolName && payload.toolName !== s.estado.currentTool) {
        s.mudar({ currentTool: payload.toolName });
      }
      break;
    case "Notification":
      // Só registramos matcher=permission_prompt, então este evento é sempre
      // "parou para pedir autorização".
      if (s.estado.status !== "waiting_input") {
        s.mudar({
          status: "waiting_input",
          hookLatched: false,
          statusReason: "hook:Notification permission_prompt",
        });
      }
      break;
    case "PreCompact":
      // O compact é o único trabalho que começa e não termina em Stop. Quem
      // devolve o agente para idle é o SessionStart source=compact, lá em cima.
      cancelarStopPendente(s);
      s.mudar({ status: "working", hookLatched: false, statusReason: "hook:PreCompact" });
      break;
    case "Stop":
      agendarStop(s);
      break;
    case "StopFailure": {
      // O turno terminou com erro da API e o hook Stop NÃO dispara: sem este ramo o agente fica
      // "working" para sempre. Medido no Claude Code 2.1.303.
      const texto = mascarar(payload.lastAssistantMessage ?? "", s.segredosParaMascara());
      if (payload.error === "authentication_failed" || RX_LOGIN_EXPIRADO.test(texto)) {
        marcarLoginExpirado(s, "hook StopFailure", null, texto || payload.error || null);
        break;
      }
      log.aviso(
        s.a("hook"),
        `o turno terminou com erro da API (${payload.error ?? "sem código"}${texto ? `: "${texto}"` : ""}); ` +
          `o agente volta a idle e a mensagem não foi respondida. Se repetir, ver o status da API do provedor e os limites da conta`,
      );
      cancelarStopPendente(s);
      if (s.estado.status === "working") {
        s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: `hook:StopFailure ${payload.error ?? ""}`.trim() });
      }
      talvezSoltarFila(s);
      break;
    }
    default:
      log.debug(s.a("hook"), `evento sem tratamento: ${payload.event}`);
  }
  return { ok: true };
}

export function agendarStop(s: Sessao): void {
  cancelarStopPendente(s);
  s.stopPendente = setTimeout(() => {
    s.stopPendente = null;
    if (s.estado.status === "working") {
      s.mudar({
        status: "idle",
        hookLatched: true,
        currentTool: null,
        statusReason: `hook:Stop confirmado (${STOP_CONFIRM_MS / 1000}s quieto)`,
      });
    }
    talvezSoltarFila(s);
  }, STOP_CONFIRM_MS);
  s.stopPendente.unref();
}

export function cancelarStopPendente(s: Sessao): void {
  if (s.stopPendente) {
    clearTimeout(s.stopPendente);
    s.stopPendente = null;
  }
}

export function cancelarQuietoDeBoot(s: Sessao): void {
  if (s.quietoDeBoot) {
    clearTimeout(s.quietoDeBoot);
    s.quietoDeBoot = null;
  }
}
