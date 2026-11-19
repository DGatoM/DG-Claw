import pty from "node-pty";
import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { mascarar } from "../mascara.js";
import { type EventoInterno, acharRolloutPorId, erroDeLoginDoCodex, descobrirRollout, vigiarRollout } from "../provedores/codex-rollout.js";
import { codexHomeDe } from "../provedores/codex.js";
import type { CtxMotor } from "../provedores/motor.js";
import { compactRecusadoNoTranscript, turnoEncerradoNoTranscript } from "../transcript.js";
import { CONFERE_TRANSCRIPT_A_CADA_MS, ROLLOUT_AUSENTE_MS } from "./constantes.js";
import { aplicarEvento, cancelarStopPendente } from "./eventos.js";
import { talvezSoltarFila } from "./fila.js";
import { conferirLoginExpiradoNoTranscript, credencialGravadaEm, marcarLoginExpirado } from "./login.js";

/** Claude: se o hook Stop se perder, o agente ficaria "working" para sempre e a fila de ocioso
 *  nunca soltaria. Com o terminal mudo, olha o fim do transcript: turno encerrado lá e hook
 *  ausente aqui quer dizer aviso perdido. Não vale para waiting_input (quem está parado é a
 *  pessoa), spawning nem compact (PreCompact termina por SessionStart, outra prova). O Codex não
 *  usa hooks e tem o próprio vigia (rollout). */
export function vigiarStopPerdido(s: Sessao, esteProc: pty.IPty): void {
  pararVigiaDoStopPerdido(s);
  const passo = Math.max(50, Math.min(CONFERE_TRANSCRIPT_A_CADA_MS, Math.floor(s.quietoParaOlharTranscriptMs / 3)));
  s.vigiaDoStopPerdido = setInterval(() => {
    if (s.proc !== esteProc) {
      pararVigiaDoStopPerdido(s);
      return;
    }
    if (s.estado.status !== "working" || s.ultimaSaidaEm === null) return;
    const quietoHa = Date.now() - s.ultimaSaidaEm;
    if (s.estado.statusReason === "hook:PreCompact") {
      conferirCompactSemFim(s, quietoHa);
      return;
    }
    if (!s.estado.sessionId) return;
    if (quietoHa < s.quietoParaOlharTranscriptMs) return;
    // O turno que morreu por login expirado não grava turn_duration nem dispara Stop: sem esta
    // checagem ele ficaria "working" para sempre.
    if (conferirLoginExpiradoNoTranscript(s, s.turnoComecouEm, "terminal mudo")) return;
    const prova = turnoEncerradoNoTranscript(
      s.estado.sessionId,
      s.turnoComecouEm,
      s.estado.config.envExtra?.CLAUDE_CONFIG_DIR,
      s.ultimoEscReal && s.ultimoEscReal.proc === s.proc ? s.ultimoEscReal.em : null,
    );
    if (!prova.encerrado) {
      log.debug(s.a("estado"), `terminal mudo há ${Math.round(quietoHa / 1000)}s, mas o transcript diz que o turno segue: ${prova.motivo}`);
      return;
    }
    log.aviso(
      s.a("estado"),
      `estava "working" (${s.estado.statusReason ?? "sem motivo"}) e o terminal ficou mudo há ${Math.round(quietoHa / 1000)}s, ` +
        `mas o transcript já registra o fim do turno (${prova.motivo}) e o hook Stop não chegou; ` +
        `o aviso de fim de turno provavelmente se perdeu no caminho do hook até o runner. ` +
        `Marquei como idle e vou soltar a fila; se repetir, conferir o runner-hook.mjs e a porta do runner`,
    );
    cancelarStopPendente(s);
    s.mudar({
      status: "idle",
      hookLatched: true,
      currentTool: null,
      statusReason: "transcript:turno encerrado sem o hook Stop",
    });
    talvezSoltarFila(s);
  }, passo);
  s.vigiaDoStopPerdido.unref();
}

/** Claude: o agente está em "hook:PreCompact" e o terminal calou. O compact de verdade termina em SessionStart
 *  source=compact; se isso não vem, ou o CLI recusou o /compact (o transcript prova) ou algo se perdeu (rede de
 *  tempo). Compact longo não é cortado enquanto o terminal escreve: as duas saídas pedem terminal quieto.
 *  O Codex não tem PreCompact e nunca chega aqui. */
function conferirCompactSemFim(s: Sessao, quietoHa: number): void {
  const desde = s.compactComecouEm;
  // Qualquer hook depois do PreCompact zera compactComecouEm (eventos.ts), e o PTY do PreCompact tem que ser o de agora:
  // sem isso, uma ferramenta que começou logo depois de um compact bom seria tomada por compact sem fim.
  if (desde <= 0 || s.compactando === null || s.compactando !== s.proc) return;
  if (quietoHa >= s.quietoParaOlharTranscriptMs && s.estado.sessionId) {
    const r = compactRecusadoNoTranscript(s.estado.sessionId, desde, s.estado.config.envExtra?.CLAUDE_CONFIG_DIR);
    if (r.recusado) {
      log.aviso(
        s.a("estado"),
        `compact recusado: poucas mensagens. O hook PreCompact chegou, mas o transcript ` +
          `tem a recusa e nada depois dela, então não virá SessionStart nem Stop. ` +
          `Marquei como idle e vou soltar a fila; se repetir, o auto-compact está enfileirando /compact em excesso`,
      );
      cancelarStopPendente(s);
      s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: "transcript:compact recusado pelo CLI" });
      talvezSoltarFila(s);
      return;
    }
  }
  const emCompactMs = Date.now() - desde;
  if (emCompactMs > s.compactSemFimMs && quietoHa > s.compactQuietoRedeMs) {
    log.aviso(
      s.a("estado"),
      `PreCompact sem SessionStart há ${Math.round(emCompactMs / 60_000)} min (terminal quieto há ${Math.round(quietoHa / 1000)}s); ` +
        `volto para idle para a fila não ficar presa; se repetir, ver o transcript`,
    );
    cancelarStopPendente(s);
    s.mudar({ status: "idle", hookLatched: true, currentTool: null, statusReason: "timeout:PreCompact sem SessionStart" });
    talvezSoltarFila(s);
  }
}

export function pararVigiaDoStopPerdido(s: Sessao): void {
  if (s.vigiaDoStopPerdido) {
    clearInterval(s.vigiaDoStopPerdido);
    s.vigiaDoStopPerdido = null;
  }
}

/** Codex: status e id da sessão vêm do rollout. Devolve a função que para o vigia. */
export function vigiarRolloutDoCodex(s: Sessao, esteProc: pty.IPty, ctx: CtxMotor): () => void {
  const home = ctx.env.CODEX_HOME ?? codexHomeDe({ auth: ctx.escolha.auth, env: ctx.env, cwd: ctx.cwd, id: ctx.id });
  const desde = s.spawnEm;
  let arquivo: string | null = null;
  let avisouAusencia = false;
  return vigiarRollout({
    desdeMs: desde,
    resolverArquivo: () => {
      if (s.proc !== esteProc) return null;
      if (arquivo) return arquivo;
      const conhecido = s.estado.sessionId;
      if (conhecido) {
        arquivo = acharRolloutPorId(conhecido, home);
      } else {
        const achado = descobrirRollout(ctx.cwd, desde, home, s.idsEmUso());
        if (achado) {
          arquivo = achado.arquivo;
          log.info(s.a("codex"), `id da sessão descoberto no rollout: ${achado.id}`);
          s.mudar({ sessionId: achado.id });
          // O rollout nascer é o recibo do primeiro Enter (ele só existe depois do primeiro turno).
          s.promptsAceitos += 1;
        }
      }
      if (!arquivo && !avisouAusencia && Date.now() - desde > ROLLOUT_AUSENTE_MS) {
        avisouAusencia = true;
        log.erro(
          s.a("codex"),
          `o rollout do Codex não apareceu em ${Math.round(ROLLOUT_AUSENTE_MS / 1000)}s em ${home}/sessions` +
            (conhecido ? ` (procurei o id ${conhecido})` : ` (procurei por cwd ${ctx.cwd})`),
          "conferir se o Codex fez login (a tela do terminal mostra) e se CODEX_HOME é o mesmo do processo; sem o rollout o status do agente não anda e a conversa não aparece no painel",
        );
      }
      return arquivo;
    },
    aoEvento: (e) => {
      if (s.proc !== esteProc) return;
      aplicarEvento(s, { event: e.evento satisfies EventoInterno, toolName: e.ferramenta ?? null });
    },
    aoErroDeTurno: (erro) => {
      if (s.proc !== esteProc || !erroDeLoginDoCodex(erro)) return;
      // Erro de antes do último login não conta: o auth.json foi regravado depois dele.
      if (erro.em <= credencialGravadaEm(s)) return;
      // A mensagem vem do servidor e pode ecoar credencial: mascarar ANTES de cortar, para o corte não
      // deixar meio segredo de fora da máscara.
      const texto = mascarar(erro.mensagem, s.segredosParaMascara()).replace(/\s+/g, " ").slice(0, 160);
      marcarLoginExpirado(s, "rollout do Codex", erro.em, `${erro.categoria || "sem categoria"}: ${texto}`);
    },
    aoUso: (u) => {
      if (s.proc !== esteProc) return;
      s.uso.registrar("codex", u.leitura, "rollout", u.em);
    },
  });
}
