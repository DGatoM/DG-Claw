import type { Sessao } from "../sessao.js";
import { gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { AVISO_DE_FILA_APOS_MS, JANELA_DE_PRONTIDAO_MS, PRONTO_APOS_SPAWN_MS, QUIETO_ANTES_DE_DIGITAR_MS } from "./constantes.js";

const MOTIVOS_DE_TELA_BLOQUEADA = ["runner:dialogo-auto-mode", "runner:tela-de-confianca"];

/** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
 *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
 *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
export function enfileirarQuandoOcioso(s: Sessao, texto: string): void {
  s.marcarAtividade();
  // Entrou com o agente ocupado, com outra na frente ou com um item sendo digitado: vai ser lida depois de falas
  // dele que quem escreveu ainda não viu (ver avisoDeAtraso).
  const esperou = s.estado.status !== "idle" || s.filaQuandoIdle.length > 0 || s.soltandoFila;
  s.filaQuandoIdle.push({ texto, em: Date.now(), ...(esperou ? { esperou: true } : {}) });
  espelharFila(s);
  log.info(
    s.a("entrada"),
    `${texto.length} caracteres enfileirados para quando ficar ocioso (fila: ${s.filaQuandoIdle.length})`,
  );
  talvezSoltarFila(s);
}

function duasCasas(n: number): string {
  return String(n).padStart(2, "0");
}

/** Texto acrescentado DEPOIS da mensagem do chat do painel quando ela esperou na fila. Resposta curta ("ok", "sim")
 *  escrita antes de o agente falar de outro assunto pode parecer autorização do que ele propôs depois; o aviso diz
 *  isso ao agente. Vale para a mensagem que entrou com o agente ocupado (qualquer tempo de espera) ou que esperou
 *  mais que AVISO_DE_FILA_APOS_MS. Fica fora do envelope: o painel lê só o que está dentro dele. Só o envelope
 *  <dgchat> recebe o aviso: comando literal (/model...) e mensagem de canal externo (WhatsApp, Telegram), cujo
 *  leitor espera a tag de fechamento no fim, saem intactos. */
export function avisoDeAtraso(item: { texto?: string; em: number; esperou?: boolean }, agora: number = Date.now()): string {
  if (item.texto !== undefined && !item.texto.startsWith("<dgchat")) return "";
  const espera = agora - item.em;
  if (!item.esperou && espera < AVISO_DE_FILA_APOS_MS) return "";
  const quando = new Date(item.em);
  const hora = `${duasCasas(quando.getHours())}:${duasCasas(quando.getMinutes())}`;
  const minutos = Math.round(espera / 60_000);
  const duracao = minutos < 1 ? "alguns segundos" : `cerca de ${minutos} min`;
  return (
    `\n\n[Aviso do sistema: a mensagem acima foi escrita às ${hora} e esperou ${duracao} na fila, ` +
    `enquanto você respondia outras coisas. Ela pode ter sido escrita antes das suas últimas respostas. ` +
    `Uma resposta curta (ok, sim, pode, beleza) não autoriza uma ação nova que você propôs depois disso: ` +
    `se for o caso, confirme com o dono antes de agir.]`
  );
}

/** Solta UM item por vez: o próximo sai no próximo idle, depois que o turno do
 *  anterior terminar. Soltar a fila toda de uma vez empilharia vários prompts
 *  no mesmo turno. */
export function talvezSoltarFila(s: Sessao): void {
  if (!s.filaQuandoIdle.length || !s.proc || s.soltandoFila) return;
  const desdeSpawn = Date.now() - s.spawnEm;
  if (desdeSpawn < JANELA_DE_PRONTIDAO_MS) {
    const quieto = s.ultimaSaidaEm ? Date.now() - s.ultimaSaidaEm : Infinity;
    if (desdeSpawn < PRONTO_APOS_SPAWN_MS || quieto < QUIETO_ANTES_DE_DIGITAR_MS) {
      // O TUI ainda está desenhando: olha de novo daqui a pouco, sem perder a vez.
      if (!s.reolharFila) {
        s.reolharFila = setTimeout(() => {
          s.reolharFila = null;
          talvezSoltarFila(s);
        }, 400);
        s.reolharFila.unref();
      }
      return;
    }
  }
  if (s.estado.status !== "idle") return;
  s.itemEmVoo = s.filaQuandoIdle.shift()!;
  const texto = s.itemEmVoo.texto + avisoDeAtraso(s.itemEmVoo);
  s.soltandoFila = true;
  if (!s.bloqueioDaFilaLogado) log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto, true)
    .then(() => {
      s.bloqueioDaFilaLogado = false;
    })
    .catch((err) => {
      // Tela que bloqueia a caixa (aviso do auto mode, confiança de pasta do Codex): nada foi digitado,
      // então o pedido NÃO pode sumir. Volta para a frente da fila (o `finally` abaixo persiste), a sessão
      // fica como estava e a fila olha de novo sozinha a cada poucos segundos. É seguro repetir: o primeiro
      // passo de digitarEEnviar só OLHA a tela. Quando o dono responder o aviso no terminal, sai uma vez.
      if (err instanceof ErroDeMotor && MOTIVOS_DE_TELA_BLOQUEADA.includes(err.statusReason)) {
        if (s.itemEmVoo) s.filaQuandoIdle.unshift(s.itemEmVoo);
        if (!s.bloqueioDaFilaLogado) {
          s.bloqueioDaFilaLogado = true;
          log.erro(s.a("entrada"), `${err.message} O pedido continua na fila (${s.filaQuandoIdle.length} pendente(s)) e a fila tenta de novo sozinha`, err.comoResolver);
        }
        agendarReintento(s);
        return;
      }
      log.erro(
        s.a("entrada"),
        `falhei ao digitar o texto enfileirado: ${err instanceof Error ? err.message : err}`,
        "reenviar pelo POST /api/agents/:id/input",
      );
    })
    .finally(() => {
      s.soltandoFila = false;
      s.itemEmVoo = null;
      espelharFila(s);
    });
}

/** Um único timer de nova tentativa; `cancelarReintentoDaFila` o desarma ao parar a sessão. */
function agendarReintento(s: Sessao): void {
  if (s.reintentoDaFila) return;
  s.reintentoDaFila = setTimeout(() => {
    s.reintentoDaFila = null;
    talvezSoltarFila(s);
  }, s.reintentoTelaBloqueadaMs);
  s.reintentoDaFila.unref();
}

export function cancelarReintentoDaFila(s: Sessao): void {
  if (s.reintentoDaFila) clearTimeout(s.reintentoDaFila);
  s.reintentoDaFila = null;
  // A vigia do Enter sem recibo também morre quando a sessão para.
  if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
  s.vigiaDoRecibo = null;
  s.bloqueioDaFilaLogado = false;
}

/** Grava no disco o que ainda não foi entregue: o item em digitação e a fila. */
export function espelharFila(s: Sessao): void {
  const pendentes = s.itemEmVoo ? [s.itemEmVoo, ...s.filaQuandoIdle] : s.filaQuandoIdle;
  gravarFila(s.arquivoDaFila, pendentes, s.a("fila"));
}
