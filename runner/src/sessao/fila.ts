import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Sessao } from "../sessao.js";
import { type ItemDaFila, gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { configDirDoClaude } from "../provedores/claude.js";
import { acharRolloutPorId, pedidoNoRollout } from "../provedores/codex-rollout.js";
import { codexHomeDe } from "../provedores/codex.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { inspecionarArquivoDaSessao, pedidoNoTranscript } from "../transcript.js";
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
  /** true depois que o primeiro Enter foi escrito no terminal. Antes disso a digitação ainda estava no meio. */
  enterEscrito: boolean;
  /** true quando a repetição do Enter parou porque houve outra escrita no terminal: o que está na caixa já não é
   *  garantidamente este pedido. */
  interrompido: boolean;
}

const MOTIVOS_DE_TELA_BLOQUEADA = ["runner:dialogo-auto-mode", "runner:tela-de-confianca"];

/** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
 *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
 *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
export function enfileirarQuandoOcioso(s: Sessao, texto: string): void {
  s.marcarAtividade();
  s.filaQuandoIdle.push({ texto, em: Date.now(), id: randomUUID().slice(0, 8) });
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
  // Um envio automático sem recibo por vez: enquanto houver um digitado sem confirmação, a fila espera.
  if (s.semRecibo.length) return;
  // Um item que já foi digitado sem recibo só sai de novo se for seguro; senão fica retido e não trava os próximos.
  let item: ItemDaFila | undefined;
  while ((item = s.filaQuandoIdle[0])) {
    if (!item.digitado) break;
    const veredito = avaliarReentrega(s, item);
    if (veredito.acao === "reentregar") break;
    s.filaQuandoIdle.shift();
    if (veredito.acao === "descartar") {
      log.info(s.a("entrada"), `o pedido ${item.id ?? "?"} (${item.texto.length} caracteres) já consta no histórico da conversa: ${veredito.motivo}; não repito`);
    } else {
      reter(s, item, veredito.motivo);
    }
  }
  if (!item) {
    espelharFila(s);
    return;
  }
  s.filaQuandoIdle.shift();
  s.itemEmVoo = item;
  const texto = item.texto;
  // Comando de barra (/compact, /clear...) não tem recibo confiável (não dispara UserPromptSubmit), então
  // não fica pendente: repetir um /clear depois de um reinício seria pior que o risco que se evita.
  const ehBarra = texto.trim().startsWith("/");
  const antesDaTentativa = { digitado: item.digitado, tentativa: item.tentativa, provedor: item.provedor, conta: item.conta, sessaoId: item.sessaoId };
  let entrada: SemRecibo | null = null;
  if (!ehBarra) {
    // O estado da tentativa vai para o disco ANTES da primeira escrita no terminal: se o runner cair no meio,
    // o próximo processo sabe que houve uma tentativa e que o limite de uma repetição já está contando.
    item.digitado = true;
    item.tentativa = (item.tentativa ?? 0) + 1;
    item.provedor = s.motor.provedor;
    item.conta = s.escolhaVigente.auth;
    item.sessaoId = s.estado.sessionId ?? null;
    entrada = { item, promptsAntes: s.promptsAceitos, aguardando: false, enterEscrito: false, interrompido: false };
    s.semRecibo.push(entrada);
  }
  s.envioAtual = entrada;
  s.soltandoFila = true;
  espelharFila(s);
  if (!s.bloqueioDaFilaLogado) log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto, true)
    .then((recebido) => {
      s.bloqueioDaFilaLogado = false;
      if (!entrada || !s.semRecibo.includes(entrada)) return;
      if (entrada.interrompido) {
        reter(s, item, "a repetição do Enter parou porque houve outra escrita no terminal depois do primeiro Enter");
        return;
      }
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
        if (s.itemEmVoo && !jaDevolvido) {
          // Nada foi digitado: a tentativa não conta.
          Object.assign(s.itemEmVoo, antesDaTentativa);
          if (antesDaTentativa.digitado === undefined) delete s.itemEmVoo.digitado;
          s.filaQuandoIdle.unshift(s.itemEmVoo);
        }
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
      s.envioAtual = null;
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

/** Grava no disco o que ainda não foi entregue: o digitado sem recibo, o item em digitação, a fila e os
 *  pedidos retidos (incertos). Cada item aparece uma vez só. */
export function espelharFila(s: Sessao): void {
  const vistos = new Set<ItemDaFila>();
  const lista: ItemDaFila[] = [];
  const somar = (it: ItemDaFila | null | undefined) => {
    if (it && !vistos.has(it)) {
      vistos.add(it);
      lista.push(it);
    }
  };
  for (const e of s.semRecibo) somar(e.item);
  somar(s.itemEmVoo);
  for (const it of s.filaQuandoIdle) somar(it);
  for (const it of s.retidos) somar(it);
  gravarFila(s.arquivoDaFila, lista, s.a("fila"));
}

function retirarSemRecibo(s: Sessao, entrada: SemRecibo): void {
  const i = s.semRecibo.indexOf(entrada);
  if (i >= 0) s.semRecibo.splice(i, 1);
}

/** O pedido fica guardado no arquivo da fila, marcado `incerto`, SEM ser enviado sozinho e sem bloquear os
 *  próximos. O log diz o que aconteceu (com o id e o tamanho, nunca o texto) e o que a pessoa faz. */
export function reter(s: Sessao, item: ItemDaFila, motivo: string): void {
  const i = s.semRecibo.findIndex((e) => e.item === item);
  if (i >= 0) s.semRecibo.splice(i, 1);
  if (s.itemEmVoo === item) s.itemEmVoo = null;
  const j = s.filaQuandoIdle.indexOf(item);
  if (j >= 0) s.filaQuandoIdle.splice(j, 1);
  item.incerto = true;
  if (!item.id) item.id = randomUUID().slice(0, 8);
  if (!s.retidos.includes(item)) s.retidos.push(item);
  log.aviso(
    s.a("entrada"),
    `um pedido de ${item.texto.length} caracteres (id ${item.id}) ficou retido sem confirmação: ${motivo}. ` +
      `Não o enviei de novo sozinho, para o agente não executar o mesmo pedido duas vezes, e ele não trava os próximos pedidos. ` +
      `O que fazer: conferir na conversa do agente se o pedido foi executado e, se não foi, reenviá-lo pela conversa. ` +
      `O texto continua guardado em ${s.arquivoDaFila}, marcado como incerto`,
  );
  espelharFila(s);
}

/** O histórico da conversa em que o pedido foi digitado tem esse pedido como turno do usuário?
 *  "tem" e "nao-tem" só saem quando o histórico foi lido; qualquer dúvida é "ilegivel". */
function pedidoNoHistorico(s: Sessao, item: ItemDaFila): "tem" | "nao-tem" | "ilegivel" {
  const ctx = s.ctxVivo;
  if (!ctx || !item.sessaoId) return "ilegivel";
  if (item.provedor === "codex") {
    const home = ctx.env.CODEX_HOME ?? codexHomeDe({ auth: ctx.escolha.auth, env: ctx.env, cwd: ctx.cwd, id: ctx.id });
    try {
      fs.readdirSync(path.join(home, "sessions"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "ilegivel";
      return "nao-tem";
    }
    const arquivo = acharRolloutPorId(item.sessaoId, home, Number.MAX_SAFE_INTEGER);
    if (!arquivo) return "nao-tem";
    const r = pedidoNoRollout(arquivo, item.texto, item.em);
    return r === null ? "ilegivel" : r ? "tem" : "nao-tem";
  }
  const achou = inspecionarArquivoDaSessao(item.sessaoId, configDirDoClaude(ctx));
  if (achou.estado === "inconclusivo") return "ilegivel";
  if (achou.estado === "nao-existe") return "nao-tem";
  const r = pedidoNoTranscript(achou.arquivo, item.texto, item.em);
  return r === null ? "ilegivel" : r ? "tem" : "nao-tem";
}

type Veredito = { acao: "reentregar" } | { acao: "reter"; motivo: string } | { acao: "descartar"; motivo: string };

/** Quando um pedido digitado sem recibo pode sair de novo sozinho: só se for seguro. Seguro quer dizer: ainda cabe
 *  uma repetição, é o mesmo CLI e a mesma conta da primeira tentativa, e o histórico da conversa foi lido e NÃO
 *  tem o pedido. Histórico que mostra o pedido quer dizer que ele foi entregue (só o recibo se perdeu): não repete.
 *  Qualquer outra situação deixa o pedido retido. */
export function avaliarReentrega(s: Sessao, item: ItemDaFila): Veredito {
  if ((item.tentativa ?? 1) >= 2) return { acao: "reter", motivo: "ele já foi digitado duas vezes sem que o CLI confirmasse nenhuma" };
  if (!item.provedor) return { acao: "reter", motivo: "não há registro de qual CLI recebeu a primeira tentativa" };
  if (item.provedor !== s.motor.provedor || (item.conta ?? "") !== s.escolhaVigente.auth) {
    return { acao: "reter", motivo: `o provedor ou a forma de pagar mudou desde a primeira tentativa (era ${item.provedor}/${item.conta ?? "?"}, agora é ${s.motor.provedor}/${s.escolhaVigente.auth})` };
  }
  const historico = pedidoNoHistorico(s, item);
  if (historico === "tem") return { acao: "descartar", motivo: "o CLI o registrou como pedido do usuário, só o recibo se perdeu" };
  if (historico === "ilegivel") return { acao: "reter", motivo: "não deu para ler o histórico da conversa para conferir se o pedido chegou a ser recebido" };
  return { acao: "reentregar" };
}

/** Na troca de provedor ou de conta, o pedido digitado sem recibo no CLI antigo não entra no terminal novo. */
export function reterOsDeOutroProvedor(s: Sessao): void {
  for (const it of [...s.filaQuandoIdle]) {
    if (!it.digitado) continue;
    if (it.provedor !== s.motor.provedor || (it.conta ?? "") !== s.escolhaVigente.auth) {
      reter(s, it, `o provedor ou a forma de pagar mudou (era ${it.provedor ?? "?"}/${it.conta ?? "?"}, agora é ${s.motor.provedor}/${s.escolhaVigente.auth})`);
    }
  }
}

/** O CLI aceitou um prompt (`promptsAceitos` subiu): o texto digitado que está pendente está entregue e sai do
 *  pendente, para nunca ser reentregue. Só o pendente correspondente (a fila solta um por vez).
 *  Chamado pelos dois recibos (hook do Claude, rollout do Codex). */
export function confirmarRecibos(s: Sessao): void {
  const e = s.semRecibo[0];
  if (!e || s.promptsAceitos <= e.promptsAntes) return;
  s.semRecibo = s.semRecibo.slice(1);
  if (s.itemEmVoo === e.item) s.itemEmVoo = null;
  if (e.aguardando) {
    log.info(s.a("entrada"), `o recibo do texto digitado (${e.item.texto.length} caracteres) chegou atrasado: o pedido está entregue e não será repetido`);
  }
  espelharFila(s);
  talvezSoltarFila(s);
}

/** O terminal saiu (ou foi encerrado) com texto digitado e sem recibo: esse pedido não chegou ao agente, ou pelo
 *  menos não há prova de que chegou. Se a digitação foi interrompida no meio, o pedido fica retido. Se o Enter
 *  chegou a ser escrito, o pedido volta para a FRENTE da fila marcado como digitado, e só sai de novo se a
 *  conferência de avaliarReentrega disser que é seguro. */
export function devolverSemRecibo(s: Sessao, motivo: string): void {
  if (!s.semRecibo.length) return;
  const voltam: ItemDaFila[] = [];
  const pendentes = s.semRecibo;
  s.semRecibo = [];
  for (const e of pendentes) {
    // A posse passa para a fila ANTES de gravar: o arquivo nunca tem duas cópias do mesmo pedido.
    if (s.itemEmVoo === e.item) s.itemEmVoo = null;
    if (!e.enterEscrito && !e.aguardando) {
      reter(s, e.item, `a digitação foi interrompida no meio (${motivo})`);
      continue;
    }
    voltam.push(e.item);
  }
  s.filaQuandoIdle.unshift(...voltam);
  espelharFila(s);
  if (voltam.length) {
    log.aviso(
      s.a("entrada"),
      `${voltam.length} texto(s) digitado(s) sem recibo do ${s.motor.binario} (${motivo}); voltam para a frente da fila e só saem de novo se o histórico da conversa mostrar que o pedido não foi recebido`,
    );
  }
}

/** O que o disco guardava no boot: os retidos (incertos) continuam retidos, e os digitados sem recibo (o runner
 *  parou antes do recibo) ficam na frente da fila, ainda marcados, para a mesma conferência de segurança. */
export function recuperarDoDisco(s: Sessao): void {
  const fila: ItemDaFila[] = [];
  const digitados: ItemDaFila[] = [];
  let mudou = false;
  for (const it of s.filaQuandoIdle) {
    if (!it.id) {
      it.id = randomUUID().slice(0, 8);
      mudou = true;
    }
    if (it.incerto) {
      s.retidos.push(it);
      log.aviso(
        s.a("fila"),
        `há um pedido de ${it.texto.length} caracteres (id ${it.id}) retido sem confirmação desde antes do runner parar; ele não é enviado sozinho. ` +
          `O que fazer: conferir na conversa do agente se foi executado e, se não foi, reenviá-lo pela conversa`,
      );
    } else if (it.digitado) {
      if (!it.tentativa) it.tentativa = 1;
      digitados.push(it);
      log.aviso(s.a("fila"), `o pedido ${it.id} (${it.texto.length} caracteres) tinha sido digitado sem recibo antes do runner parar; só sai de novo se o histórico da conversa mostrar que ele não foi recebido`);
    } else {
      fila.push(it);
    }
  }
  s.filaQuandoIdle = [...digitados, ...fila];
  if (mudou || digitados.length) espelharFila(s);
}
