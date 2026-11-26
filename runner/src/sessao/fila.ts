import { randomUUID } from "node:crypto";
import type { Sessao } from "../sessao.js";
import { type ItemDaFila, type ResultadoDaGravacao, gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { caixaVaziaNaTela } from "./telas.js";
import { AVISO_DE_FILA_APOS_MS, JANELA_DE_PRONTIDAO_MS, REDESENHO_DEPOIS_DA_TECLA_MS, PRONTO_APOS_SPAWN_MS, QUIETO_ANTES_DE_DIGITAR_MS, QUIETO_PARA_LER_TELA_MS, ENTER_MANUAL_SEGURA_FILA_MS, MAX_RETIDOS } from "./constantes.js";

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
  /** O valor de `entradasManuais` logo depois do último Enter que o runner escreveu para este pedido. Se o contador
   *  for outro quando o recibo chegar, alguém escreveu no terminal depois (o dono, por exemplo): o recibo pode ser de
   *  outro turno e não prova nada sobre este pedido. */
  entradasNoEnter?: number;
  /** true depois que algum byte deste envio foi escrito no terminal (marcado imediatamente antes da primeira escrita).
   *  Sem ele, parar ou reiniciar o terminal devolve o pedido para a frente da fila em vez de retê-lo como incerto. */
  escreveuAlgo?: boolean;
  /** true para o comando de barra (/compact, /clear): não tem o recibo do prompt (UserPromptSubmit). Fica em
   *  `Sessao.barraPendente`, no disco, até o recibo próprio (PreCompact) ou até ser retido como incerto. */
  barra?: boolean;
  /** O texto exato que o runner escreveu no terminal para este item (o do item mais o aviso de atraso, quando há). O recibo do
   *  Codex é conferido contra ele, nunca contra o texto cru do item. */
  textoEnviado?: string;
  /** true quando não deu para gravar a marca `digitado` no disco imediatamente antes da primeira escrita: nada foi escrito
   *  e o item voltou intacto para a frente da fila. */
  gravacaoFalhou?: boolean;
}

/** `runner:recusa-de-entrada`: o agente deixou de poder conversar (login, chave, restrição) enquanto o pedido esperava a vez;
 *  nada foi digitado, o pedido volta para a frente da fila e a fila olha de novo sozinha. */
export const MOTIVO_RECUSA_DE_ENTRADA = "runner:recusa-de-entrada";
/** Chamada direta com a digitação suspensa e a caixa do terminal ainda com texto: nada foi digitado. */
export const MOTIVO_CAIXA_COM_RASCUNHO = "runner:caixa-com-rascunho";
/** Chamada direta que NÃO escreveu nada (tela sem a caixa de composição, agente esperando resposta, terminal trocado antes
 *  da primeira escrita, cliente que desistiu): a rota responde 409 e a mensagem pode ser reenviada sem risco de duplicar. */
export const MOTIVO_NAO_ENTROU = "runner:nao-entrou";
/** Chamada direta que NÃO escreveu nada porque outro pedido automático ainda está sem recibo confirmado (a vigia dele segue ativa):
 *  escrever agora acrescentaria o texto ao que ficou na caixa, e um Enter mandaria os dois juntos. A rota responde 409. */
export const MOTIVO_ENVIO_PENDENTE = "runner:envio-pendente";
const MOTIVOS_DE_TELA_BLOQUEADA = ["runner:dialogo-auto-mode", "runner:tela-de-confianca", MOTIVO_RECUSA_DE_ENTRADA];

/** O que aconteceu com o texto: entrou na fila (e no arquivo), era um /compact repetido, ou NÃO foi gravado no arquivo
 *  da fila e por isso foi tirado da fila em memória (quem pediu precisa saber, para reenviar). */
export type ResultadoDoEnfileirar = "enfileirado" | "deduplicado" | "nao-gravado";

/** Guarda um texto para digitar assim que o agente ficar ocioso. É como uma
 *  rotina agendada (ou o cliente, numa sessão que estava dormindo) fala com ele
 *  sem atropelar o turno em andamento. A fila é FIFO: nenhum texto apaga outro. */
export function enfileirarQuandoOcioso(s: Sessao, texto: string, esperouNoPainel = false): ResultadoDoEnfileirar {
  s.marcarAtividade();
  // Um /compact atrás de outro /compact só empilha recusas ("Not enough messages to compact."): se já há um na fila,
  // um sendo digitado, ou o PTY de agora está compactando, o segundo não entra. Devolve false nesse caso, para a rota
  // dizer que não enfileirou.
  // Vale também com argumentos ("/compact foque nas decisões"): o segundo cairia na mesma recusa.
  const ehCompact = (t: string) => /^\/compact(?:\s|$)/.test(t.trim());
  if (
    ehCompact(texto) &&
    (s.filaQuandoIdle.some((item) => ehCompact(item.texto)) ||
      (s.itemEmVoo !== null && ehCompact(s.itemEmVoo.texto)) ||
      (s.barraPendente !== null && ehCompact(s.barraPendente.item.texto)) ||
      (s.compactando !== null && s.compactando === s.proc))
  ) {
    log.info(s.a("entrada"), "já havia um /compact na fila, sendo digitado ou em andamento; não enfileirei outro");
    return "deduplicado";
  }
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
  const novo: ItemDaFila = { texto, em: Date.now(), id: randomUUID().slice(0, 8), ...(esperou ? { esperou: true } : {}) };
  s.filaQuandoIdle.push(novo);
  // "sem-fsync-da-pasta" vale como enfileirado: o arquivo tem o pedido, e quem pediu não deve reenviar (duplicaria).
  if (espelharFilaDetalhado(s) === "falhou") {
    // Só em memória o pedido se perderia num reinício, e quem pediu receberia um "aceito". Sai da fila e é recusado.
    const i = s.filaQuandoIdle.indexOf(novo);
    if (i >= 0) s.filaQuandoIdle.splice(i, 1);
    log.erro(
      s.a("entrada"),
      `não enfileirei o pedido ${novo.id} (${texto.length} caracteres) porque não consegui gravar o arquivo da fila ${s.arquivoDaFila}; ele foi tirado da fila em memória`,
      "conferir espaço em disco e permissões da pasta de estado do runner e reenviar o pedido depois",
    );
    return "nao-gravado";
  }
  log.info(
    s.a("entrada"),
    `${texto.length} caracteres enfileirados para quando ficar ocioso (fila: ${s.filaQuandoIdle.length})`,
  );
  talvezSoltarFila(s);
  return "enfileirado";
}

const ABERTURA_CANAL_EXTERNO = "<canal-externo ";

function duasCasas(n: number): string {
  return String(n).padStart(2, "0");
}

/** Texto acrescentado DEPOIS da mensagem do chat do painel quando ela esperou na fila. Resposta curta ("ok", "sim")
 *  escrita antes de o agente falar de outro assunto pode parecer autorização do que ele propôs depois; o aviso diz
 *  isso ao agente. Vale para a mensagem que entrou com o agente ocupado (qualquer tempo de espera) ou que esperou
 *  mais que AVISO_DE_FILA_APOS_MS. Recebem o aviso o envelope <dgchat> e o <canal-externo> do WhatsApp; comando
 *  literal (/model...) sai intacto. O aviso vai depois do envelope (ver textoComAviso). */
export function avisoDeAtraso(item: { texto?: string; em: number; esperou?: boolean }, agora: number = Date.now()): string {
  if (item.texto !== undefined && !item.texto.startsWith("<dgchat") && !item.texto.startsWith(ABERTURA_CANAL_EXTERNO)) return "";
  const espera = agora - item.em;
  if (!item.esperou && espera < AVISO_DE_FILA_APOS_MS) return "";
  const minutos = Math.round(espera / 60_000);
  const duracao = minutos < 1 ? "alguns segundos" : `cerca de ${minutos} min`;
  // No <dgchat> a hora de escrita é a da entrada na fila. No canal externo a hora de escrita é a do atributo `ts` do envelope
  // (a hora da mensagem no WhatsApp), quando for uma data ISO válida; sem ela, o texto diz só que a mensagem entrou na fila.
  let inicio: string;
  const ts = item.texto?.startsWith(ABERTURA_CANAL_EXTERNO) ? horaDoEnvelope(item.texto) : null;
  if (item.texto?.startsWith(ABERTURA_CANAL_EXTERNO)) {
    inicio = ts !== null ? `foi escrita às ${ts}` : `entrou na fila às ${horaLocal(item.em)}`;
  } else {
    inicio = `foi escrita às ${horaLocal(item.em)}`;
  }
  return (
    `\n\n[Aviso do sistema: a mensagem acima ${inicio} e esperou ${duracao} na fila, ` +
    `enquanto você respondia outras coisas. Ela pode ter sido escrita antes das suas últimas respostas. ` +
    `Uma resposta curta (ok, sim, pode, beleza) não autoriza uma ação nova que você propôs depois disso: ` +
    `se for o caso, confirme com o dono antes de agir.]`
  );
}

function horaLocal(epoch: number): string {
  const q = new Date(epoch);
  return `${duasCasas(q.getHours())}:${duasCasas(q.getMinutes())}`;
}

/** A hora local (HH:MM) do atributo `ts` da tag de abertura do <canal-externo>, ou null se ele não for uma data ISO válida. */
function horaDoEnvelope(texto: string): string | null {
  const abertura = /^<canal-externo\b([^>]*)>/.exec(texto);
  if (!abertura) return null;
  const m = /\bts="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))"/.exec(abertura[1]);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? horaLocal(t) : null;
}

/** O texto que o runner escreve no terminal: o do item mais o aviso de atraso, quando há. O aviso vai SEMPRE depois do
 *  envelope, fora dele (<dgchat> e <canal-externo>): o corpo do <canal-externo> vem com < e > escapados pela ponte, então
 *  nenhuma tag de fechamento real pode vir de quem escreve; tudo depois da tag final é do runner. */
export function textoComAviso(item: { texto: string; em: number; esperou?: boolean }, agora: number = Date.now()): string {
  return item.texto + avisoDeAtraso(item, agora);
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
  // Um Enter do dono, pelo terminal, pode virar um turno cujo recibo ainda não chegou: esse recibo não pode confirmar
  // o pedido que a fila digitar agora. Espera o recibo dele (ou o prazo) antes de soltar.
  const manual = s.enterManualPendente;
  if (manual) {
    if (s.promptsAceitos > manual.promptsAntes) {
      s.enterManualPendente = null;
    } else if (Date.now() - manual.em < ENTER_MANUAL_SEGURA_FILA_MS) {
      agendarReintento(s);
      return;
    }
  }
  // Um envio automático sem recibo por vez: enquanto houver um digitado sem confirmação, a fila espera.
  // Também com a vigia de recibo ativa, mesmo a de um envio direto (que não ocupa semRecibo): um recibo atrasado dele seria
  // tomado como o do pedido seguinte e apagaria do disco um pedido que o CLI talvez nunca tenha aceitado.
  if (s.semRecibo.length || s.barraPendente || s.vigiaDoRecibo !== null) return;
  // Pode haver texto (um rascunho do dono, o pedido que ficou na caixa) ou um diálogo no terminal: nada é digitado
  // por cima. A suspensão só acaba quando, num idle, a tela mostra a caixa de composição vazia. Um recibo (hook)
  // sozinho não basta: ele pode ser de outro turno e a caixa continuar com texto.
  if (s.digitacaoSuspensaEm !== null) {
    // A escrita no emulador é assíncrona: só se confia na leitura com o terminal quieto por um instante.
    // Também espera o terminal redesenhar depois da última tecla do dono: a tela de antes dela mostraria a caixa vazia.
    if (!terminalQuietoParaLerTela(s) || !telaServeDeProva(s)) {
      agendarReintento(s);
      return;
    }
    if (!caixaVaziaNaTela(s.telaAtual())) {
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
    levantarSuspensao(s);
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
  // A marca `digitado` NÃO é gravada aqui: o item ainda pode esperar a vez na cadeia (um envio direto longo pode ocupar o
  // terminal antes), e uma queda nesse intervalo reteria como incerto um pedido que nem saiu. Quem grava é digitar(), dentro
  // da operação serializada, depois de conferir a caixa e imediatamente antes da primeira escrita (ver marcarDigitadoAntesDeEscrever).
  s.filaQuandoIdle.shift();
  s.itemEmVoo = item;
  const texto = textoComAviso(item);
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
    textoEnviado: texto,
    ...(ehBarra ? { barra: true } : {}),
  };
  if (ehBarra) s.barraPendente = entrada;
  else s.semRecibo.push(entrada);
  s.soltandoFila = true;
  if (!s.bloqueioDaFilaLogado) log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto, true, entrada)
    .then((recebido) => {
      // Quando a gravação da marca falhou, o aviso já saiu e a fila só repete a tentativa: não zera a trava do log.
      if (!entrada.gravacaoFalhou) s.bloqueioDaFilaLogado = false;
      if (!pendenteEm(s, entrada)) {
        // O pedido voltou intacto para a frente da fila (nada foi digitado: tela irreconhecível, caixa com texto, outro pedido
        // sem recibo...). Repetir já, com o agente ocioso e a tela igual, regravaria o arquivo da fila (com fsync) várias vezes
        // por segundo: a nova tentativa espera o intervalo de reintento.
        if (s.filaQuandoIdle[0] === item) agendarReintento(s);
        return;
      }
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
      // As tentativas de continuar a fila feitas enquanto a flag estava ligada voltaram sem fazer nada: reavalia
      // agora que ela foi liberada (a própria talvezSoltarFila confere se há motivo para soltar).
      // Se já há uma nova tentativa agendada (tela bloqueada), ela cuida disso: reavaliar agora giraria em falso.
      if (!s.reintentoDaFila) setImmediate(() => talvezSoltarFila(s));
    });
}

/** Um único timer de nova tentativa; `cancelarReintentoDaFila` o desarma ao parar a sessão. */
export function agendarReintento(s: Sessao): void {
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
  if (s.reentregaDoRecado) clearTimeout(s.reentregaDoRecado);
  s.reentregaDoRecado = null;
  // A vigia do Enter sem recibo também morre quando a sessão para.
  if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
  s.vigiaDoRecibo = null;
  s.vigiaDoEnvio = null;
  s.vigiaGeracao += 1;
  s.bloqueioDaFilaLogado = false;
}

/** Grava no disco o que ainda não foi entregue: o digitado sem recibo, o item em digitação, a fila e os
 *  pedidos retidos (incertos). Cada item aparece uma vez só. */
export function espelharFila(s: Sessao): boolean {
  return espelharFilaDetalhado(s) !== "falhou";
}

/** Quem vai digitar um texto exige "gravado" (a marca `digitado` precisa estar firme no disco antes da primeira tecla). */
export function espelharFilaDetalhado(s: Sessao): ResultadoDaGravacao {
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
  // Nada mudou desde a última gravação que deu certo: não regrava (cada gravação faz fsync do arquivo e da pasta). Só pula
  // com gravação anterior bem-sucedida e conteúdo idêntico; qualquer resultado que não seja "gravado" esquece a marca, porque
  // o disco pode ter ficado com um conteúdo diferente do que esta sessão guarda (o rename pode ter publicado antes do fsync da pasta).
  const representacao = JSON.stringify(lista);
  if (s.ultimaFilaGravada === representacao) return "gravado";
  const resultado = gravarFila(s.arquivoDaFila, lista, s.a("fila"));
  s.ultimaFilaGravada = resultado === "gravado" ? representacao : null;
  return resultado;
}

function retirarSemRecibo(s: Sessao, entrada: SemRecibo): void {
  const i = s.semRecibo.indexOf(entrada);
  if (i >= 0) s.semRecibo.splice(i, 1);
  if (s.barraPendente === entrada) s.barraPendente = null;
}

export function pendenteEm(s: Sessao, entrada: SemRecibo): boolean {
  return s.semRecibo.includes(entrada) || s.barraPendente === entrada;
}

/** Grava a marca `digitado` do item no disco, imediatamente antes da primeira escrita do pedido (dentro da operação
 *  serializada, com a caixa já conferida). Se a gravação falhar, desfaz a marca e devolve false: nada pode ser escrito, porque
 *  sem o registro um reinício no meio da digitação perderia o rastro do que foi feito. */
export function marcarDigitadoAntesDeEscrever(s: Sessao, entrada: SemRecibo): boolean {
  const item = entrada.item;
  if (item.digitado) return true;
  item.digitado = true;
  if (espelharFilaDetalhado(s) === "gravado") return true;
  entrada.gravacaoFalhou = true;
  delete item.digitado;
  // Com "sem-fsync-da-pasta" o rename já publicou digitado:true no disco; regrava sem a marca para um reinício não reter o pedido.
  espelharFila(s);
  if (!s.bloqueioDaFilaLogado) {
    s.bloqueioDaFilaLogado = true;
    log.erro(
      s.a("entrada"),
      `não digitei o pedido ${item.id ?? "?"} (${item.texto.length} caracteres) porque não consegui gravar o arquivo da fila ${s.arquivoDaFila}; ` +
        `ele continua na frente da fila e a fila tenta de novo sozinha`,
      "conferir espaço em disco e permissões da pasta de estado do runner (disco cheio é a causa mais comum)",
    );
  }
  return false;
}

/** Nada foi escrito no terminal para este envio (o terminal mudou antes da primeira escrita): o item volta para a
 *  frente da fila, sem a marca de digitado. Devolve false se o item já não está pendente ou já foi retido como incerto. */
export function devolverNaoDigitado(s: Sessao, entrada: SemRecibo): boolean {
  if (!pendenteEm(s, entrada) || entrada.item.incerto || entrada.enterEscrito) return false;
  retirarSemRecibo(s, entrada);
  delete entrada.item.digitado;
  if (s.itemEmVoo === entrada.item) s.itemEmVoo = null;
  s.filaQuandoIdle.unshift(entrada.item);
  espelharFila(s);
  return true;
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
  descartarRetidosAlemDoLimite(s);
  log.aviso(
    s.a("entrada"),
    `um pedido de ${item.texto.length} caracteres (id ${item.id}) ficou retido sem confirmação: ${motivo}. ` +
      `Não o enviei de novo sozinho, para o agente não executar o mesmo pedido duas vezes, e ele não trava os próximos pedidos. ` +
      `O que fazer: conferir na conversa do agente se o pedido foi executado e, se não foi, reenviá-lo pela conversa. ` +
      `O texto continua guardado em ${s.arquivoDaFila}, marcado como incerto`,
  );
  espelharFila(s);
}

/** Guarda no máximo MAX_RETIDOS pedidos incertos: o mais antigo sai do arquivo, com aviso (o texto nunca vai para o log). */
function descartarRetidosAlemDoLimite(s: Sessao): void {
  while (s.retidos.length > MAX_RETIDOS) {
    const velho = s.retidos.shift()!;
    log.aviso(
      s.a("fila"),
      `há pedidos retidos demais (mais de ${MAX_RETIDOS}): descartei do arquivo da fila o mais antigo, o id ${velho.id ?? "?"} (${velho.texto.length} caracteres). ` +
        `O que fazer: conferir na conversa do agente se esse pedido foi executado e, se não foi, reenviá-lo pela conversa`,
    );
  }
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

/** O terminal está quieto há tempo suficiente para a leitura da tela (o emulador escreve de forma assíncrona). */
export function terminalQuietoParaLerTela(s: Sessao): boolean {
  const quieto = s.ultimaSaidaEm ? Date.now() - s.ultimaSaidaEm : Infinity;
  return quieto >= QUIETO_PARA_LER_TELA_MS;
}

/** A caixa apareceu vazia: a digitação automática volta a valer. */
export function levantarSuspensao(s: Sessao): void {
  s.digitacaoSuspensaEm = null;
  s.suspensaoLogada = false;
}

/** O envio parou com a caixa do terminal possivelmente suja (texto parcial ou inteiro, ou um rascunho de outra pessoa):
 *  não se escreve mais nada. Pela fila, `parada` do item faz a fila suspender a digitação e reter o pedido; numa chamada
 *  direta (sem item) não há fila para isso, então a suspensão é feita aqui. Devolve false, para quem chamou devolver. */
export function pararComCaixaSuja(s: Sessao, envio: SemRecibo | null, motivo: string): false {
  if (envio) envio.parada = { tipo: "caixa", motivo };
  else suspenderPorRascunho(s);
  return false;
}

/** Codex: a marca do Enter do dono (que pode ter ficado de um Enter numa caixa vazia, sem turno nenhum) não torna ambíguo o recibo
 *  de um pedido se o texto do turno aberto depois do Enter dele é o do pedido: o turno é do pedido. Vale para o item da fila
 *  (confirmarRecibos) e para o envio direto (enviarComRecibo). Sem texto de turno ainda, ou com outro texto, devolve false. */
export function turnoDoCodexEhDoTexto(s: Sessao, promptsAntes: number, texto: string): boolean {
  return s.motor.reciboPorRollout && reciboDoTexto(s, promptsAntes, texto);
}

/** O CLI aceitou um prompt (`promptsAceitos` subiu). Só tira o pendente da frente se o Enter dele já foi escrito
 *  e o contador passou do valor de antes desse Enter; um recibo que chega antes é de outro turno (o dono, por
 *  exemplo) e não prova nada. Confirmar o recibo NÃO solta a fila: o próximo texto só sai no próximo idle, depois
 *  que o turno começou e terminou. Chamado pelos dois recibos (hook do Claude, rollout do Codex). */
export function confirmarRecibos(s: Sessao): void {
  // Não limpa a suspensão por rascunho: um recibo não prova que a caixa ficou vazia (pode ser de outro turno, e o
  // texto continuar lá). Quem encerra a suspensão é talvezSoltarFila, ao ver a caixa vazia num idle.
  // O prazo de 15 s só deixa a fila soltar: o Enter do dono continua pendente até o recibo dele chegar. Se esse recibo chega
  // com o Enter de um pedido da fila já escrito, não dá para saber de quem ele é.
  const manual = s.enterManualPendente;
  const marcaCumprida = manual !== null && s.promptsAceitos > manual.promptsAntes;
  let reciboDoDono = marcaCumprida;
  const e = s.semRecibo[0];
  // Codex: o `task_started` chega antes do texto do turno, e a marca do Enter do dono (que pode ter ficado de um Enter numa caixa
  // vazia, sem turno nenhum) não decide sozinha. Se o texto do turno é o do pedido, o turno é do pedido e a marca cai; se o turno
  // ainda não trouxe texto, a decisão espera o texto; se trouxe outro texto, vale a regra de sempre (reter, abaixo).
  if (reciboDoDono && s.motor.reciboPorRollout && e && e.enterEscrito && s.promptsAceitos > e.promptsAntes) {
    if (turnoDoCodexEhDoTexto(s, e.promptsAntes, e.textoEnviado ?? e.item.texto)) {
      reciboDoDono = false;
    } else if (!s.turnosDoCodex.some((t) => t.n > e.promptsAntes && t.textos.length > 0)) {
      return;
    }
  }
  if (marcaCumprida) s.enterManualPendente = null;
  if (reciboDoDono && e && e.enterEscrito && s.promptsAceitos > e.promptsAntes) {
    suspenderPorRascunho(s);
    reter(s, e.item, "chegou um recibo, mas o recibo pode ser do Enter que o dono deu no terminal");
    talvezSoltarFila(s);
    return;
  }
  if (!e) return;
  if (!e.enterEscrito) {
    log.info(s.a("entrada"), `chegou um recibo antes do Enter do pedido ${e.item.id ?? "?"}: é de outro turno e não confirma esse pedido`);
    return;
  }
  if (!reciboDoTexto(s, e.promptsAntes, e.textoEnviado ?? e.item.texto)) return;
  if (e.entradasNoEnter !== undefined && s.entradasManuais !== e.entradasNoEnter) {
    // Houve outra escrita no terminal depois do nosso último Enter (o dono apagou o texto e mandou outra mensagem, por
    // exemplo): o recibo pode ser dela, e confirmar apagaria do disco um pedido que o agente talvez nunca tenha aceitado.
    suspenderPorRascunho(s);
    reter(s, e.item, "chegou um recibo, mas houve outra escrita no terminal depois do Enter deste pedido, então o recibo pode ser de outra mensagem");
    talvezSoltarFila(s);
    return;
  }
  s.semRecibo = s.semRecibo.slice(1);
  if (s.itemEmVoo === e.item) s.itemEmVoo = null;
  // A vigia deste pedido não tem mais o que vigiar: encerra, para a fila (que não solta nada com uma vigia ativa) não esperar o
  // próximo passo dela à toa.
  if (s.vigiaDoEnvio === e) {
    if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
    s.vigiaDoRecibo = null;
    s.vigiaDoEnvio = null;
    s.vigiaGeracao += 1;
  }
  if (e.aguardando) {
    log.info(s.a("entrada"), `o recibo do texto digitado (${e.item.texto.length} caracteres) chegou atrasado: o pedido está entregue e não será repetido`);
  }
  espelharFila(s);
}

/** O terminal saiu (ou foi encerrado) com texto digitado e sem recibo: não há prova de que o pedido chegou ao
 *  agente. Ele fica retido como incerto, com o texto guardado no arquivo da fila, e NUNCA é digitado de novo
 *  sozinho. Vale também para um comando de barra que estava sendo digitado. */
export function devolverSemRecibo(s: Sessao, motivo: string): void {
  // Quem nunca teve um byte escrito no terminal (esperava a vez na cadeia quando o terminal saiu) não é incerto: volta
  // para a frente da fila, na mesma ordem. Os outros ficam retidos, como sempre.
  const naoEscritos = [...s.semRecibo, ...(s.barraPendente ? [s.barraPendente] : [])].filter((e) => !e.escreveuAlgo && !e.enterEscrito);
  for (const e of naoEscritos.reverse()) {
    log.info(s.a("entrada"), `o terminal saiu antes de o pedido ${e.item.id ?? "?"} ser digitado (${motivo}); ele volta para a frente da fila`);
    devolverNaoDigitado(s, e);
  }
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
  const antes = s.retidos.length;
  descartarRetidosAlemDoLimite(s);
  if (mudou || s.retidos.length !== antes) espelharFila(s);
}

/** Existe um envio automático (direto ou da fila) sem recibo confirmado que NÃO é `envio`? É o mesmo conjunto que segura a fila
 *  (vigia ativa, digitado sem recibo, comando de barra à espera do recibo próprio). Devolve a descrição, ou null. */
export function outroEnvioSemRecibo(s: Sessao, envio: SemRecibo | null): string | null {
  if (s.vigiaDoRecibo !== null) return "a vigia de um pedido anterior ainda espera o recibo dele";
  if (s.semRecibo.some((e) => e !== envio)) return "há um pedido digitado que o agente ainda não confirmou";
  if (s.barraPendente !== null && s.barraPendente !== envio) return "há um comando de barra à espera do recibo próprio";
  if (s.itemEmVoo !== null && s.itemEmVoo !== envio?.item) return "há um pedido da fila sendo digitado";
  return null;
}

/** O terminal desenhou alguma coisa depois da última escrita do dono (ou o dono nunca escreveu, ou já passou o prazo em que
 *  uma tecla sem redesenho deixa de segurar)? Só então a tela de agora pode provar que a caixa está vazia. */
export function telaServeDeProva(s: Sessao): boolean {
  if (s.escritaDeForaSeq === null) return true;
  if (s.seq > s.escritaDeForaSeq) return true;
  // Só teclas comprovadamente sem efeito no texto (setas, Home/End, PgUp/PgDn, Esc, teclas de função) deixam de segurar pelo
  // prazo. Caractere, colagem, Backspace, Delete, Ctrl+U/W/K exigem um redesenho: sem ele a tela é a imagem de antes da tecla.
  if (s.escritaDeForaComEfeito) return false;
  return Date.now() - s.escritaDeForaEm >= REDESENHO_DEPOIS_DA_TECLA_MS;
}

/** A tela prova que a caixa está vazia: o terminal redesenhou depois da última tecla do dono E a leitura mostra a caixa sem texto. */
export function caixaVaziaComProva(s: Sessao, tela: string): boolean {
  return telaServeDeProva(s) && caixaVaziaNaTela(tela);
}

/** Texto do pedido ou do turno do rollout comparável: espaços repetidos viram um e as pontas são aparadas. */
export function normalizarTexto(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

/** O texto do turno do rollout (mensagem do usuário) é o do pedido? Compara o texto COMPLETO dos dois, normalizado (espaços e
 *  quebras de linha repetidos viram um espaço). `pedido` precisa ser exatamente o que o runner escreveu no terminal, inclusive
 *  o aviso de atraso que ele acrescenta no fim: dois pedidos que só começam igual ("Verifique o backup" e "Verifique o backup da
 *  outra máquina"), ou que diferem só depois de muitos caracteres, NÃO são o mesmo. Sem igualdade não há recibo (o pedido fica
 *  pendente e cai no caminho da entrega incerta). Pedido vazio nunca confere. */
export function textoConfere(pedido: string, turno: string): boolean {
  const a = normalizarTexto(pedido);
  return a !== "" && a === normalizarTexto(turno);
}

/** O CLI aceitou, DEPOIS de `depoisDe` prompts, um turno que é deste texto? No Claude o recibo é o hook UserPromptSubmit
 *  (contador). No Codex o recibo vem do rollout, que pode ser o de outro card no mesmo diretório: só vale um turno novo cuja
 *  mensagem do usuário tenha o texto do pedido; sem o texto do turno (ou com outro texto), não há recibo. */
export function reciboDoTexto(s: Sessao, depoisDe: number, texto: string): boolean {
  if (!s.motor.reciboPorRollout) return s.promptsAceitos > depoisDe;
  return s.turnosDoCodex.some((t) => t.n > depoisDe && t.textos.some((x) => textoConfere(texto, x)));
}
