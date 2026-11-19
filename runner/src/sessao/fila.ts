import { randomUUID } from "node:crypto";
import type { Sessao } from "../sessao.js";
import { type ItemDaFila, gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { caixaVaziaNaTela } from "./telas.js";
import { AVISO_DE_FILA_APOS_MS, JANELA_DE_PRONTIDAO_MS, PRONTO_APOS_SPAWN_MS, QUIETO_ANTES_DE_DIGITAR_MS } from "./constantes.js";

/** Um texto que já foi digitado no terminal e ainda não tem recibo do CLI (UserPromptSubmit no Claude,
 *  task_started no Codex). Enquanto estiver aqui o pedido NÃO está entregue: se o terminal sair antes do
 *  recibo, ele fica retido como incerto e nunca é digitado de novo sozinho (ver devolverSemRecibo). */
export interface SemRecibo {
  item: ItemDaFila;
  /** O valor de `promptsAceitos` quando o texto saiu da fila, e de novo quando o primeiro Enter é escrito: o recibo
   *  é `promptsAceitos` passar dele DEPOIS do Enter. */
  promptsAntes: number;
  /** true depois que o envio terminou sem recibo (o Enter segue sendo insistido pela vigia). */
  aguardando: boolean;
  /** true depois que o primeiro Enter foi escrito no terminal. Antes disso a digitação ainda estava no meio. */
  enterEscrito: boolean;
  /** true quando a repetição do Enter parou porque houve outra escrita no terminal: o que está na caixa já não é
   *  garantidamente este pedido. */
  interrompido: boolean;
  /** Por que o envio parou antes de ter o recibo (preenchido pela rotina do Enter, que recebe este item
   *  explicitamente): o terminal foi trocado, a caixa mudou ou não há recibo possível. A fila retém o pedido. */
  parada?: { tipo: "terminal" | "caixa" | "sem-hooks"; motivo: string };
  /** true para o comando de barra (/compact, /clear): não tem o recibo do prompt (UserPromptSubmit). Fica em
   *  `Sessao.barraPendente`, no disco, até o recibo próprio (PreCompact) ou até ser retido como incerto. */
  barra?: boolean;
}

const MOTIVOS_DE_TELA_BLOQUEADA = ["runner:dialogo-auto-mode", "runner:tela-de-confianca"];

/** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
 *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
 *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
export function enfileirarQuandoOcioso(s: Sessao, texto: string, esperouNoPainel = false): void {
  s.marcarAtividade();
  // Entrou com o agente ocupado, com outra na frente ou com um item sendo digitado: vai ser lida depois de falas
  // dele que quem escreveu ainda não viu (ver avisoDeAtraso).
  // Também com um pedido digitado esperando recibo, ou com a digitação suspensa por rascunho: o agente ainda vai falar antes.
  const esperou =
    esperouNoPainel ||
    s.estado.status !== "idle" ||
    s.filaQuandoIdle.length > 0 ||
    s.soltandoFila ||
    s.semRecibo.length > 0 ||
    s.barraPendente !== null ||
    s.digitacaoSuspensaEm !== null;
  s.filaQuandoIdle.push({ texto, em: Date.now(), id: randomUUID().slice(0, 8), ...(esperou ? { esperou: true } : {}) });
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
  // Um envio automático sem recibo por vez: enquanto houver um digitado sem confirmação, a fila espera.
  if (s.semRecibo.length || s.barraPendente) return;
  // Pode haver texto (um rascunho do dono, o pedido que ficou na caixa) ou um diálogo no terminal: nada é digitado
  // por cima. A suspensão só acaba quando, num idle, a tela mostra a caixa de composição vazia. Um recibo (hook)
  // sozinho não basta: ele pode ser de outro turno e a caixa continuar com texto.
  if (s.digitacaoSuspensaEm !== null) {
    if (!caixaVaziaNaTela(s.telaInteira())) {
      if (!s.suspensaoLogada) {
        s.suspensaoLogada = true;
        log.aviso(
          s.a("entrada"),
          "a digitação automática continua suspensa: a tela do terminal não mostra a caixa de composição vazia (pode haver texto ou um diálogo nela). " +
            "Os pedidos continuam guardados na fila. O que fazer: abrir o terminal do agente (aba Sessões, botão Terminal), dar o Enter ou apagar o texto e responder o diálogo, se houver",
        );
      }
      // Olha de novo daqui a pouco: a pessoa pode limpar a caixa sem que nenhum evento chegue ao runner.
      agendarReintento(s);
      return;
    }
    s.digitacaoSuspensaEm = null;
    s.suspensaoLogada = false;
  }
  const item = s.filaQuandoIdle[0];
  if (!item) {
    espelharFila(s);
    return;
  }
  // Um item `digitado` nunca sai de novo sozinho (recuperarDoDisco já retém os do disco; isto é a rede de segurança).
  if (item.digitado) {
    reter(s, item, "ele estava marcado como digitado sem recibo");
    talvezSoltarFila(s);
    return;
  }
  // O pedido vai para o disco como `digitado` ANTES da primeira escrita no terminal. Se a gravação falhar, não
  // digita nada: sem o registro, um reinício no meio da digitação perderia o rastro do que foi feito.
  s.filaQuandoIdle.shift();
  s.itemEmVoo = item;
  item.digitado = true;
  const texto = item.texto + avisoDeAtraso(item);
  // Comando de barra (/compact, /clear...) não tem recibo confiável (não dispara UserPromptSubmit), então não
  // fica em semRecibo. Mas também é gravado como digitado antes de ser digitado, e sai do disco quando termina:
  // se o runner cair no meio, no boot ele aparece digitado e fica retido, nunca é executado de novo.
  const ehBarra = texto.trim().startsWith("/");
  const entrada: SemRecibo = {
    item,
    promptsAntes: s.promptsAceitos,
    aguardando: false,
    enterEscrito: false,
    interrompido: false,
    ...(ehBarra ? { barra: true } : {}),
  };
  if (ehBarra) s.barraPendente = entrada;
  else s.semRecibo.push(entrada);
  if (!espelharFila(s)) {
    retirarSemRecibo(s, entrada);
    delete item.digitado;
    s.itemEmVoo = null;
    s.filaQuandoIdle.unshift(item);
    if (!s.bloqueioDaFilaLogado) {
      s.bloqueioDaFilaLogado = true;
      log.erro(
        s.a("entrada"),
        `não digitei o pedido ${item.id ?? "?"} (${item.texto.length} caracteres) porque não consegui gravar o arquivo da fila ${s.arquivoDaFila}; ` +
          `ele continua na frente da fila e a fila tenta de novo sozinha`,
        "conferir espaço em disco e permissões da pasta de estado do runner (disco cheio é a causa mais comum)",
      );
    }
    agendarReintento(s);
    return;
  }
  s.soltandoFila = true;
  if (!s.bloqueioDaFilaLogado) log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto, true, entrada)
    .then((recebido) => {
      s.bloqueioDaFilaLogado = false;
      if (!pendenteEm(s, entrada)) return;
      if (entrada.parada) {
        // Só a caixa que mudou (rascunho, diálogo) suspende a digitação: terminal trocado ou sem hooks não deixam nada na caixa.
        if (entrada.parada.tipo === "caixa") suspenderPorRascunho(s);
        reter(s, item, entrada.parada.motivo);
        talvezSoltarFila(s);
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
          `ele continua pendente (e guardado em disco) até o recibo chegar, e se o terminal sair antes disso fica retido como incerto, sem ser digitado de novo`,
      );
    })
    .catch((err) => {
      // Tela que bloqueia a caixa (aviso do auto mode, confiança de pasta do Codex): nada foi digitado,
      // então o pedido NÃO pode sumir. Volta para a frente da fila (o `finally` abaixo persiste), a sessão
      // fica como estava e a fila olha de novo sozinha a cada poucos segundos. É seguro repetir: o primeiro
      // passo de digitarEEnviar só OLHA a tela. Quando o dono responder o aviso no terminal, sai uma vez.
      if (err instanceof ErroDeMotor && MOTIVOS_DE_TELA_BLOQUEADA.includes(err.statusReason)) {
        // Se o terminal saiu no meio, devolverSemRecibo já reteve o item (e o tirou de itemEmVoo): não mexe.
        retirarSemRecibo(s, entrada);
        if (s.itemEmVoo === item) {
          // Nada foi digitado: o item volta como estava, sem a marca de digitado.
          delete item.digitado;
          s.itemEmVoo = null;
          s.filaQuandoIdle.unshift(item);
        }
        if (!s.bloqueioDaFilaLogado) {
          s.bloqueioDaFilaLogado = true;
          log.erro(s.a("entrada"), `${err.message} O pedido continua na fila (${s.filaQuandoIdle.length} pendente(s)) e a fila tenta de novo sozinha`, err.comoResolver);
        }
        agendarReintento(s);
        return;
      }
      retirarSemRecibo(s, entrada);
      log.erro(
        s.a("entrada"),
        `falhei ao digitar o texto enfileirado: ${err instanceof Error ? err.message : err}`,
        "conferir se o pedido chegou ao agente; o texto fica guardado como incerto e, se não foi atendido, reenviar pela conversa",
      );
      // O texto pode ter sido digitado em parte: fica retido, nunca é digitado de novo sozinho.
      if (s.itemEmVoo === item) reter(s, item, "a digitação falhou no meio");
    })
    .finally(() => {
      s.soltandoFila = false;
      s.itemEmVoo = null;
      // O comando de barra que ainda espera o recibo próprio continua no disco (barraPendente), não só em memória.
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
export function espelharFila(s: Sessao): boolean {
  const vistos = new Set<ItemDaFila>();
  const lista: ItemDaFila[] = [];
  const somar = (it: ItemDaFila | null | undefined) => {
    if (it && !vistos.has(it)) {
      vistos.add(it);
      lista.push(it);
    }
  };
  for (const e of s.semRecibo) somar(e.item);
  somar(s.barraPendente?.item);
  somar(s.itemEmVoo);
  for (const it of s.filaQuandoIdle) somar(it);
  for (const it of s.retidos) somar(it);
  return gravarFila(s.arquivoDaFila, lista, s.a("fila"));
}

function retirarSemRecibo(s: Sessao, entrada: SemRecibo): void {
  const i = s.semRecibo.indexOf(entrada);
  if (i >= 0) s.semRecibo.splice(i, 1);
  if (s.barraPendente === entrada) s.barraPendente = null;
}

function pendenteEm(s: Sessao, entrada: SemRecibo): boolean {
  return s.semRecibo.includes(entrada) || s.barraPendente === entrada;
}

/** O comando de barra teve o recibo próprio (ou o comando foi consumido e não tem recibo): sai do disco. */
export function liberarBarra(s: Sessao, entrada: SemRecibo): void {
  if (s.barraPendente !== entrada) return;
  s.barraPendente = null;
  if (s.itemEmVoo === entrada.item) s.itemEmVoo = null;
  espelharFila(s);
  talvezSoltarFila(s);
}

/** O que o painel precisa saber da fila: os itens que ainda não foram entregues, sem repetir nenhum
 *  (em digitação, digitado sem recibo, comando de barra à espera do recibo próprio e os que esperam). */
export function itensNaoEntregues(s: Sessao): ItemDaFila[] {
  const vistos = new Set<ItemDaFila>();
  const lista: ItemDaFila[] = [];
  const somar = (it: ItemDaFila | null | undefined) => {
    if (it && !vistos.has(it)) {
      vistos.add(it);
      lista.push(it);
    }
  };
  somar(s.itemEmVoo);
  for (const e of s.semRecibo) somar(e.item);
  somar(s.barraPendente?.item);
  for (const it of s.filaQuandoIdle) somar(it);
  return lista;
}

/** O pedido fica guardado no arquivo da fila, marcado `incerto`, SEM ser enviado sozinho e sem bloquear os
 *  próximos. O log diz o que aconteceu (com o id e o tamanho, nunca o texto) e o que a pessoa faz. */
export function reter(s: Sessao, item: ItemDaFila, motivo: string): void {
  const i = s.semRecibo.findIndex((e) => e.item === item);
  if (i >= 0) s.semRecibo.splice(i, 1);
  if (s.barraPendente?.item === item) s.barraPendente = null;
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

/** A caixa do terminal pode ter texto (rascunho do dono, pedido que ficou lá) ou um diálogo: a digitação automática
 *  fica suspensa até a tela, num idle, mostrar a caixa de composição vazia. Chamar ANTES de reter. */
export function suspenderPorRascunho(s: Sessao): void {
  s.digitacaoSuspensaEm = Date.now();
  s.suspensaoLogada = false;
  log.aviso(
    s.a("entrada"),
    "a caixa do terminal do agente pode ter texto ou um diálogo: a digitação automática dos próximos pedidos fica suspensa até a caixa aparecer vazia com o agente ocioso. " +
      "Os pedidos seguintes continuam guardados na fila",
  );
}

/** O CLI aceitou um prompt (`promptsAceitos` subiu). Só tira o pendente da frente se o Enter dele já foi escrito
 *  e o contador passou do valor de antes desse Enter; um recibo que chega antes é de outro turno (o dono, por
 *  exemplo) e não prova nada. Confirmar o recibo NÃO solta a fila: o próximo texto só sai no próximo idle, depois
 *  que o turno começou e terminou. Chamado pelos dois recibos (hook do Claude, rollout do Codex). */
export function confirmarRecibos(s: Sessao): void {
  // Não limpa a suspensão por rascunho: um recibo não prova que a caixa ficou vazia (pode ser de outro turno, e o
  // texto continuar lá). Quem encerra a suspensão é talvezSoltarFila, ao ver a caixa vazia num idle.
  const e = s.semRecibo[0];
  if (!e) return;
  if (!e.enterEscrito) {
    log.info(s.a("entrada"), `chegou um recibo antes do Enter do pedido ${e.item.id ?? "?"}: é de outro turno e não confirma esse pedido`);
    return;
  }
  if (s.promptsAceitos <= e.promptsAntes) return;
  s.semRecibo = s.semRecibo.slice(1);
  if (s.itemEmVoo === e.item) s.itemEmVoo = null;
  if (e.aguardando) {
    log.info(s.a("entrada"), `o recibo do texto digitado (${e.item.texto.length} caracteres) chegou atrasado: o pedido está entregue e não será repetido`);
  }
  espelharFila(s);
}

/** O terminal saiu (ou foi encerrado) com texto digitado e sem recibo: não há prova de que o pedido chegou ao
 *  agente. Ele fica retido como incerto, com o texto guardado no arquivo da fila, e NUNCA é digitado de novo
 *  sozinho. Vale também para um comando de barra que estava sendo digitado. */
export function devolverSemRecibo(s: Sessao, motivo: string): void {
  const pendentes = s.semRecibo;
  s.semRecibo = [];
  for (const e of pendentes) {
    reter(s, e.item, !e.enterEscrito && !e.aguardando ? `a digitação foi interrompida no meio (${motivo})` : motivo);
  }
  // O comando de barra (em digitação ou à espera do recibo próprio) não está em semRecibo, mas também está marcado como digitado.
  const barra = s.barraPendente;
  if (barra) reter(s, barra.item, `o comando de barra ficou sem o recibo próprio (${motivo})`);
  const emVoo = s.itemEmVoo;
  if (emVoo && emVoo.digitado && s.soltandoFila && !emVoo.incerto) reter(s, emVoo, `a digitação foi interrompida no meio (${motivo})`);
}

/** O que o disco guardava no boot: os retidos (incertos) continuam retidos, e os digitados sem recibo (o runner
 *  parou antes do recibo, ou no meio de um comando de barra) também ficam retidos: nunca são digitados de novo. */
export function recuperarDoDisco(s: Sessao): void {
  const fila: ItemDaFila[] = [];
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
      it.incerto = true;
      s.retidos.push(it);
      mudou = true;
      log.aviso(
        s.a("fila"),
        `o pedido ${it.id} (${it.texto.length} caracteres) tinha sido digitado sem recibo antes do runner parar, e não sei se o agente o recebeu. ` +
          `Não o envio de novo sozinho, para não ser executado duas vezes; ele fica guardado em ${s.arquivoDaFila}, marcado como incerto. ` +
          `O que fazer: conferir na conversa do agente se foi executado e, se não foi, reenviá-lo pela conversa`,
      );
    } else {
      fila.push(it);
    }
  }
  s.filaQuandoIdle = fila;
  if (mudou) espelharFila(s);
}
