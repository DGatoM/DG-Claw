import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";
import { RX_LOGIN_EXPIRADO } from "../transcript.js";
import { spawn } from "./ciclo.js";
import { STOP_CONFIRM_MS, SUBAGENTE_SEM_SINAL_MAX_MS, SUBAGENTES_RASTREADOS_MAX } from "./constantes.js";
import { talvezSoltarFila } from "./fila.js";
import { conferirLoginExpiradoNoTranscript, marcarLoginExpirado } from "./login.js";
import { nonceConfere } from "./telas.js";

/** O que o handler de hook (Claude) ou o `notify` (Codex) manda ao runner. */
export interface PayloadDeEvento {
  event?: string;
  sessionId?: string | null;
  toolName?: string | null;
  /** O `tool_use_id` do PreToolUse (o Claude Code manda no stdin do hook). */
  toolUseId?: string | null;
  source?: string | null;
  error?: string | null;
  lastAssistantMessage?: string | null;
  /** Presente só em evento disparado de DENTRO de um subagente (Agent tool). Não confundir com o `agentId` do DG Claw. */
  subagentId?: string | null;
  subagentType?: string | null;
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
  // O id do subagente vem do JSON do hook: só vale se for texto curto e simples; senão é tratado como ausente.
  if (payload.subagentId != null && !(typeof payload.subagentId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(payload.subagentId))) {
    log.debug(s.a("hook"), `subagentId ignorado (fora do formato esperado) no evento ${payload.event ?? "?"}`);
    payload = { ...payload, subagentId: null };
  }
  // O session_id do evento é a fonte mais confiável que existe: vem do próprio
  // CLI. É assim que o runner descobre quando o agente trocou de sessão por
  // dentro (um `/resume` digitado no TUI), caso em que o id que guardamos
  // ficaria apontando para uma conversa que ninguém mais escreve.
  // Evento de subagente nunca troca a sessão viva: o session_id dele é o da principal, e um atrasado (de antes de um
  // /resume) restauraria a conversa antiga.
  if (payload.sessionId && payload.sessionId !== s.estado.sessionId && !payload.subagentId) {
    log.info(s.a("hook"), `a sessão viva mudou por dentro: ${s.estado.sessionId} -> ${payload.sessionId}`);
    s.mudar({
      sessionId: payload.sessionId,
      previousSessionId: s.estado.sessionId ?? s.estado.previousSessionId ?? null,
    });
  }

  // Ferramenta de um subagente (em especial o que roda em segundo plano) não decide o estado da sessão principal.
  // O session_id é o mesmo, então sem este filtro cada PreToolUse dele cancelava o Stop já confirmado da
  // principal: o status ficava em working e as mensagens do dono presas na fila de ocioso por ~25 min.
  // Não muda status, não cancela o Stop pendente e não mexe em currentTool. Ainda assim é sinal de vida:
  // renova a atividade (o relógio de suspensão dos cards não pode dormir um card com subagente trabalhando) e
  // guarda o id da ferramenta (o Notification de permissão usa o do último PreToolUse, que pode ser o do subagente).
  // A pergunta ao dono (AskUserQuestion) continua valendo, porque o turno só segue quando ele responde.
  // Com a sessão em waiting_input o filtro não vale: é o subagente em primeiro plano seguindo depois de uma
  // permissão (o de segundo plano não abre diálogo), e o caminho normal o devolve a working, como antes.
  const eventoDeFerramenta = payload.event === "PreToolUse" || payload.event === "PostToolUse";
  // Em qualquer status (inclusive waiting_input): o subagente está vivo e a suspensão não pode matá-lo.
  if (payload.subagentId && eventoDeFerramenta) registrarSubagente(s, payload.subagentId);
  if (
    payload.subagentId &&
    !(s.estado.status === "waiting_input" && s.estado.motivo === "permissao") &&
    (payload.event === "PreToolUse" || payload.event === "PostToolUse") &&
    payload.toolName !== "AskUserQuestion"
  ) {
    log.debug(
      s.a("hook"),
      `evento de subagente (${payload.event} ${payload.toolName ?? ""}, subagente ${payload.subagentType ?? payload.subagentId}): renova a atividade, sem mudar o estado da sessão principal`,
    );
    s.marcarAtividade();
    s.ultimoEventoEm = Date.now();
    if (payload.event === "PreToolUse") s.ultimoToolUseId = payload.toolUseId ?? null;
    s.hooksVivos = true;
    if (!s.estado.hookActive) s.estado.hookActive = true;
    return { ok: true };
  }

  // Começo e fim de um subagente: só mexem no rastreio. O estado da principal é decidido pelo Stop dela, em qualquer status.
  if (payload.event === "SubagentStart" || payload.event === "SubagentStop") {
    if (payload.subagentId) {
      if (payload.event === "SubagentStart") registrarSubagente(s, payload.subagentId);
      else s.subagentesAtivos.delete(payload.subagentId);
    }
    s.marcarAtividade();
    s.ultimoEventoEm = Date.now();
    s.hooksVivos = true;
    return { ok: true };
  }

  if (["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopBloqueado", "StopFailure", "PreCompact"].includes(payload.event ?? "")) {
    s.marcarAtividade();
    s.ultimoEventoEm = Date.now();
  }
  s.hooksVivos = true;
  if (!s.estado.hookActive) s.estado.hookActive = true;

  // Estado terminal não é mexido por hook: quem manda no fim é o onExit do PTY.
  if (s.estado.status === "stopped" || s.estado.status === "resumable" || s.estado.status === "errored") {
    return { ok: true };
  }

  // Qualquer hook depois do PreCompact prova que o CLI seguiu em frente (compact bom, ferramenta, prompt, fim de turno):
  // a vigia do PreCompact sem fim (vigias.ts) deixa de valer e o motivo "hook:PreCompact" sai de cena.
  if (payload.event !== "PreCompact" && s.compactComecouEm !== 0) {
    s.compactComecouEm = 0;
    if (s.estado.statusReason === "hook:PreCompact") s.mudar({ statusReason: `hook:${payload.event}` });
  }

  switch (payload.event) {
    case "SessionStart":
      // O fim do compact chega aqui, como SessionStart com source=compact, e é o
      // único sinal de fim que ele dá. Sem este ramo o PreCompact deixava o agente
      // em working para sempre e a fila de ocioso nunca soltava: um agente de cliente passou 8
      // dias assim (02/09 a 11/09/2026) com o /api/saude dizendo ok. Se o compact
      // foi o automático no meio de um turno, o PreToolUse seguinte cancela.
      if (payload.source === "compact") {
        s.compactando = null;
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
      s.ultimoEscReal = null;
      cancelarStopPendente(s);
      // Atividade nova: o aviso da trava (se sobrou de um Stop que se perdeu) não pode engolir o Stop que vem.
      s.stopBloqueadoAte = 0;
      // O contador é o RECIBO do Enter: é a única prova, vinda do próprio CLI,
      // de que o texto virou turno em vez de ficar escrito na caixa. Quem espera
      // por ele é o enviarComRecibo().
      s.promptsAceitos += 1;
      s.turnoComecouEm = Date.now();
      s.mudar({ status: "working", hookLatched: false, statusReason: "hook:UserPromptSubmit" });
      break;
    case "PreToolUse":
      cancelarStopPendente(s);
      s.stopBloqueadoAte = 0;
      // Guardado sempre: o Notification de permissão não traz o id, e o do último PreToolUse é o da ferramenta que pede.
      s.ultimoToolUseId = payload.toolUseId ?? null;
      // A pergunta de escolha do Claude (AskUserQuestion) abre a tela de opções logo depois deste hook
      // e o turno só continua quando a pessoa responde: para o dono é o mesmo "precisa de você" da permissão.
      if (payload.toolName === "AskUserQuestion") {
        s.entradasNaAbertura = s.entradasManuais;
        s.turnoComecouEm = Date.now();
        s.mudar({
          status: "waiting_input",
          motivo: "pergunta",
          pendenteId: payload.toolUseId ?? null,
          currentTool: payload.toolName,
          hookLatched: false,
          statusReason: "hook:PreToolUse AskUserQuestion",
        });
        break;
      }
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
    case "PostToolUse":
      // Só chega para AskUserQuestion (matcher do settings): a pessoa respondeu, o turno segue.
      cancelarStopPendente(s);
      if (s.estado.status === "waiting_input" && s.estado.motivo === "pergunta") {
        s.mudar({ status: "working", hookLatched: false, currentTool: null, statusReason: "hook:PostToolUse AskUserQuestion" });
      }
      break;
    case "Notification":
      // Só registramos matcher=permission_prompt, então este evento é sempre
      // "parou para pedir autorização". Se já estamos esperando a resposta de uma pergunta,
      // ela é que vale: não rebaixa para permissão.
      if (s.estado.status !== "waiting_input") {
        s.mudar({
          status: "waiting_input",
          motivo: "permissao",
          pendenteId: s.ultimoToolUseId,
          hookLatched: false,
          statusReason: "hook:Notification permission_prompt",
        });
      }
      break;
    case "PreCompact":
      // O compact é o único trabalho que começa e não termina em Stop. Quem
      // devolve o agente para idle é o SessionStart source=compact, lá em cima. Se o CLI recusar o /compact
      // ("Not enough messages to compact.") ele manda o PreCompact e nada mais: quem resolve é a vigia do
      // Stop perdido (vigias.ts), que só solta a fila com a recusa confirmada no transcript.
      cancelarStopPendente(s);
      s.compactsIniciados += 1;
      s.compactando = s.proc;
      s.compactComecouEm = Date.now();
      s.mudar({ status: "working", hookLatched: false, statusReason: "hook:PreCompact" });
      break;
    case "Stop":
      // Pergunta dispensada (Esc) não gera PostToolUse e o turno acaba em Stop: sem isto o agente
      // ficaria preso em "precisa de você". Permissão continua como antes (waiting_input mudo não muda).
      if (s.estado.status === "waiting_input" && s.estado.motivo === "pergunta") {
        s.mudar({ status: "working", hookLatched: false, statusReason: "hook:Stop com pergunta aberta" });
      }
      // A trava de resposta pode ter devolvido este turno (StopBloqueado): o Claude Code roda os hooks
      // do mesmo evento em paralelo, então o aviso pode ter chegado ANTES do Stop. Nesse caso o fim de
      // turno não vale e não agenda o idle.
      if (Date.now() < (s.stopBloqueadoAte ?? 0)) {
        log.debug(s.a("hook"), "Stop ignorado: a trava de resposta devolveu o turno ao agente, então ele continua trabalhando");
        s.stopBloqueadoAte = 0;
        break;
      }
      agendarStop(s);
      break;
    case "StopBloqueado":
      // A trava de resposta devolveu o turno: o agente vai continuar. Cancela o fim de turno já agendado
      // (e a soltura da fila). Só lembra do aviso quando o Stop deste turno AINDA não chegou: se ele já
      // chegou (havia fim de turno agendado), o próximo Stop é o da recuperação e precisa valer, senão o
      // agente ficaria "working" para sempre.
      {
        const stopJaChegou = s.stopPendente !== null;
        cancelarStopPendente(s);
        if (s.estado.status === "idle" || s.estado.status === "working") {
          s.mudar({ status: "working", hookLatched: false, statusReason: "hook:Stop devolvido pela trava de resposta" });
        }
        s.stopBloqueadoAte = stopJaChegou ? 0 : Date.now() + STOP_CONFIRM_MS;
      }
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
      } else if (s.estado.status === "waiting_input" && s.estado.motivo === "pergunta") {
        // Mesmo caso do Stop: pergunta dispensada (Esc) não gera PostToolUse. Sem isto, Esc seguido de falha do
        // turno deixaria o pendenteId antigo e o chat recusaria toda mensagem com PERGUNTA_PENDENTE.
        // Permissão fica de fora porque o Stop também não a trata.
        s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: `hook:StopFailure com pergunta aberta ${payload.error ?? ""}`.trim() });
      }
      talvezSoltarFila(s);
      break;
    }
    default:
      log.debug(s.a("hook"), `evento sem tratamento: ${payload.event}`);
  }
  return { ok: true };
}

/** Grava o sinal de vida de um subagente. Limpa as entradas sem sinal há mais de 2 h e respeita o teto de entradas
 *  (com o mapa cheio, sai a de sinal mais antigo), para a sessão principal também não acumular. */
export function registrarSubagente(s: Sessao, id: string): void {
  const agora = Date.now();
  for (const [outro, sinal] of s.subagentesAtivos) {
    if (agora - sinal > SUBAGENTE_SEM_SINAL_MAX_MS) s.subagentesAtivos.delete(outro);
  }
  if (!s.subagentesAtivos.has(id) && s.subagentesAtivos.size >= SUBAGENTES_RASTREADOS_MAX) {
    let maisAntigo: string | null = null;
    let menor = Infinity;
    for (const [outro, sinal] of s.subagentesAtivos) {
      if (sinal < menor) { menor = sinal; maisAntigo = outro; }
    }
    if (maisAntigo !== null) s.subagentesAtivos.delete(maisAntigo);
  }
  s.subagentesAtivos.set(id, agora);
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
