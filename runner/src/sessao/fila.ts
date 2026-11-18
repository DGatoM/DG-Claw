import type { Sessao } from "../sessao.js";
import { type ItemDaFila, gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { JANELA_DE_PRONTIDAO_MS, PRONTO_APOS_SPAWN_MS, QUIETO_ANTES_DE_DIGITAR_MS } from "./constantes.js";

/** Um texto que já foi digitado no terminal e ainda não tem recibo do CLI (UserPromptSubmit no Claude,
 *  task_started no Codex). Enquanto estiver aqui o pedido NÃO está entregue: se o terminal sair antes do
 *  recibo, ele volta para a frente da fila (ver devolverSemRecibo). */
export interface SemRecibo {
  item: ItemDaFila;
  /** O valor de `promptsAceitos` quando o texto saiu da fila: o recibo é `promptsAceitos` passar dele. */
  promptsAntes: number;
  /** true depois que o envio terminou sem recibo (o Enter segue sendo insistido pela vigia). */
  aguardando: boolean;
}

const MOTIVOS_DE_TELA_BLOQUEADA = ["runner:dialogo-auto-mode", "runner:tela-de-confianca"];

/** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
 *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
 *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
export function enfileirarQuandoOcioso(s: Sessao, texto: string): void {
  s.marcarAtividade();
  s.filaQuandoIdle.push({ texto, em: Date.now() });
  espelharFila(s);
  log.info(
    s.a("entrada"),
    `${texto.length} caracteres enfileirados para quando ficar ocioso (fila: ${s.filaQuandoIdle.length})`,
  );
  talvezSoltarFila(s);
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
  const item = s.filaQuandoIdle.shift()!;
  s.itemEmVoo = item;
  const texto = item.texto;
  // Comando de barra (/compact, /clear...) não tem recibo confiável (não dispara UserPromptSubmit), então
  // não fica pendente: repetir um /clear depois de um reinício seria pior que o risco que se evita.
  const entrada: SemRecibo | null = texto.trim().startsWith("/") ? null : { item, promptsAntes: s.promptsAceitos, aguardando: false };
  if (entrada) s.semRecibo.push(entrada);
  s.soltandoFila = true;
  if (!s.bloqueioDaFilaLogado) log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto, true)
    .then((recebido) => {
      s.bloqueioDaFilaLogado = false;
      if (!entrada || !s.semRecibo.includes(entrada)) return;
      if (recebido) {
        retirarSemRecibo(s, entrada);
        return;
      }
      entrada.aguardando = true;
      log.aviso(
        s.a("entrada"),
        `digitei os ${texto.length} caracteres, mas o ${s.motor.binario} ainda não confirmou que aceitou o pedido; ` +
          `ele continua pendente (e guardado em disco) até o recibo chegar, e se o terminal sair antes disso volta para a frente da fila`,
      );
    })
    .catch((err) => {
      // Tela que bloqueia a caixa (aviso do auto mode, confiança de pasta do Codex): nada foi digitado,
      // então o pedido NÃO pode sumir. Volta para a frente da fila (o `finally` abaixo persiste), a sessão
      // fica como estava e a fila olha de novo sozinha a cada poucos segundos. É seguro repetir: o primeiro
      // passo de digitarEEnviar só OLHA a tela. Quando o dono responder o aviso no terminal, sai uma vez.
      if (err instanceof ErroDeMotor && MOTIVOS_DE_TELA_BLOQUEADA.includes(err.statusReason)) {
        // Se o terminal saiu no meio, devolverSemRecibo já pôs o item de volta na fila: não duplica.
        const jaDevolvido = entrada !== null && !s.semRecibo.includes(entrada);
        if (entrada) retirarSemRecibo(s, entrada);
        if (s.itemEmVoo && !jaDevolvido) s.filaQuandoIdle.unshift(s.itemEmVoo);
        if (!s.bloqueioDaFilaLogado) {
          s.bloqueioDaFilaLogado = true;
          log.erro(s.a("entrada"), `${err.message} O pedido continua na fila (${s.filaQuandoIdle.length} pendente(s)) e a fila tenta de novo sozinha`, err.comoResolver);
        }
        agendarReintento(s);
        return;
      }
      if (entrada) retirarSemRecibo(s, entrada);
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

/** Grava no disco o que ainda não foi entregue: o digitado sem recibo (marcado como tal), o item em
 *  digitação e a fila. */
export function espelharFila(s: Sessao): void {
  const pendentes: ItemDaFila[] = s.semRecibo.map((e) => ({ ...e.item, digitado: true }));
  if (s.itemEmVoo && !s.semRecibo.some((e) => e.item === s.itemEmVoo)) pendentes.push(s.itemEmVoo);
  gravarFila(s.arquivoDaFila, [...pendentes, ...s.filaQuandoIdle], s.a("fila"));
}

function retirarSemRecibo(s: Sessao, entrada: SemRecibo): void {
  const i = s.semRecibo.indexOf(entrada);
  if (i >= 0) s.semRecibo.splice(i, 1);
}

/** O CLI aceitou um prompt (`promptsAceitos` subiu): os textos digitados antes dele estão entregues e saem
 *  do pendente, para nunca serem reentregues. Chamado pelos dois recibos (hook do Claude, rollout do Codex). */
export function confirmarRecibos(s: Sessao): void {
  if (!s.semRecibo.length) return;
  const confirmados = s.semRecibo.filter((e) => s.promptsAceitos > e.promptsAntes);
  if (!confirmados.length) return;
  s.semRecibo = s.semRecibo.filter((e) => !confirmados.includes(e));
  for (const e of confirmados) {
    if (e.aguardando) {
      log.info(s.a("entrada"), `o recibo do texto digitado (${e.item.texto.length} caracteres) chegou atrasado: o pedido está entregue e não será repetido`);
    }
  }
  // Com a digitação em curso o `finally` da soltura já grava; gravar aqui poria o item em voo de volta no disco.
  if (!s.soltandoFila) espelharFila(s);
}

/** O terminal saiu (ou foi encerrado) com texto digitado e sem recibo: esse pedido não chegou ao agente.
 *  Volta para a FRENTE da fila e é entregue de novo, uma única vez; se já tinha sido reentregue e falhou
 *  outra vez, é descartado com um erro explicando (repetir sem fim poderia derrubar o CLI de novo). */
export function devolverSemRecibo(s: Sessao, motivo: string): void {
  if (!s.semRecibo.length) return;
  const volta: ItemDaFila[] = [];
  for (const e of s.semRecibo) {
    if (e.item.reentregue) {
      log.erro(
        s.a("entrada"),
        `um pedido de ${e.item.texto.length} caracteres foi digitado duas vezes e o ${s.motor.binario} não confirmou nenhuma (${motivo}); não repito de novo`,
        "conferir por que o agente não abre turno (hooks, tela do terminal) e reenviar o pedido pelo POST /api/agents/:id/input",
      );
      continue;
    }
    e.item.reentregue = true;
    volta.push(e.item);
  }
  s.semRecibo = [];
  s.filaQuandoIdle.unshift(...volta);
  espelharFila(s);
  if (volta.length) {
    log.aviso(
      s.a("entrada"),
      `${volta.length} texto(s) digitado(s) sem recibo do ${s.motor.binario} (${motivo}); voltam para a frente da fila e saem de novo uma vez, quando a sessão ficar ociosa`,
    );
  }
}

/** Textos que o disco guardava como digitados sem recibo (o runner parou antes do recibo): voltam para a frente
 *  da fila e saem de novo uma vez. A fila em disco já os traz na frente, na ordem em que foram digitados. */
export function recuperarDoDisco(s: Sessao): void {
  let mudou = false;
  const fila: ItemDaFila[] = [];
  for (const it of s.filaQuandoIdle) {
    if (!it.digitado) {
      fila.push(it);
      continue;
    }
    mudou = true;
    delete it.digitado;
    if (it.reentregue) {
      log.erro(
        s.a("fila"),
        `um pedido de ${it.texto.length} caracteres já tinha sido digitado duas vezes sem recibo antes do runner parar; não repito de novo`,
        "conferir por que o agente não abre turno e reenviar o pedido pelo POST /api/agents/:id/input",
      );
      continue;
    }
    it.reentregue = true;
    log.aviso(s.a("fila"), `um pedido de ${it.texto.length} caracteres tinha sido digitado sem recibo antes do runner parar; volta para a frente da fila e sai de novo uma vez`);
    fila.push(it);
  }
  s.filaQuandoIdle = fila;
  if (mudou) espelharFila(s);
}
