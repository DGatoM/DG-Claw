import type { Sessao } from "../sessao.js";
import { log } from "../logger.js";
import { ErroDeMotor } from "../provedores/motor.js";
import { MOTIVO_CAIXA_COM_RASCUNHO, MOTIVO_ENVIO_PENDENTE, MOTIVO_NAO_ENTROU, MOTIVO_RECUSA_DE_ENTRADA, type SemRecibo, caixaVaziaComProva, devolverNaoDigitado, levantarSuspensao, liberarBarra, outroEnvioSemRecibo, pararComCaixaSuja, pendenteEm, reciboDoTexto, reter, suspenderPorRascunho, talvezSoltarFila, telaServeDeProva, terminalQuietoParaLerTela } from "./fila.js";
import { INTERVALO_MS, MAX_BYTES_DIRETOS_ESPERANDO, MAX_ENVIOS_DIRETOS_ESPERANDO, PEDACO, RECIBO_ENTER_TENTATIVAS, SILENCIO_DA_MASCARA_MS } from "./constantes.js";
import { caixaVaziaNaTela, ehDialogoDeAutoMode, estadoDaCaixa, caixaIdentificada, telaDeConfiancaDoCodex } from "./telas.js";

/**
 * Digita e ENVIA. Espera a fila de colagem drenar antes do Enter, que é o
 * detalhe que separa "funciona" de "digita o prompt e não envia": acima de
 * 256 caracteres o texto vai em pedaços, e um Enter cedo demais é tratado como
 * parte da colagem e vira quebra de linha dentro do campo. O Codex é mais
 * sensível ainda: trata texto rápido como colagem, então espera 500 ms.
 *
 * `envio` é o item da fila que este texto representa (null numa chamada direta, como o POST /input): é ele, e
 * não um campo global da sessão, que a rotina do Enter marca. Os envios de texto de um mesmo terminal são
 * serializados: um texto só começa a ser colado depois que o anterior terminou o Enter dele.
 *
 * `cancelado` diz que quem pediu (o cliente HTTP do envio direto) desistiu: um envio que ainda espera a vez na cadeia
 * e ainda não escreveu nada é cancelado sem escrever, para um reenvio do cliente não deixar duas cópias aptas a rodar.
 */
export function digitarEEnviar(
  s: Sessao,
  texto: string,
  daFila = false,
  envio: SemRecibo | null = null,
  cancelado: () => boolean = () => false,
  sinal?: AbortSignal,
): Promise<boolean> {
  // Limite dos pedidos diretos que esperam a vez (a fila tem o próprio limite e o próprio arquivo): sem ele, vários POST
  // concorrentes seguram texto e contexto HTTP em memória enquanto um texto longo ocupa o PTY.
  const bytes = Buffer.byteLength(texto);
  const direto = !daFila && envio === null;
  if (direto) {
    const e = s.diretosEsperando;
    if (e.pedidos >= MAX_ENVIOS_DIRETOS_ESPERANDO || e.bytes + bytes > MAX_BYTES_DIRETOS_ESPERANDO) {
      log.aviso(
        s.a("entrada"),
        `recusei um envio direto de ${bytes} bytes: já há ${e.pedidos} esperando a vez (${e.bytes} bytes); os limites são ${MAX_ENVIOS_DIRETOS_ESPERANDO} pedidos e ${MAX_BYTES_DIRETOS_ESPERANDO} bytes. Nada foi escrito`,
      );
      return Promise.reject(new ErroEnviosDemais(e.pedidos, e.bytes));
    }
    e.pedidos += 1;
    e.bytes += bytes;
  }
  let contado = direto;
  const largar = () => {
    if (!contado) return;
    contado = false;
    s.diretosEsperando.pedidos -= 1;
    s.diretosEsperando.bytes -= bytes;
  };
  // O terminal é capturado AGORA, quando o envio é aceito, e não depois da espera na cadeia: se a sessão reiniciar
  // (ou trocar de provedor) enquanto este envio espera a vez, nada é escrito no terminal novo.
  const procAceito = s.proc;
  // O texto fica num suporte que a desistência esvazia: o elo da cadeia continua existindo (a ordem dos envios não muda),
  // mas deixa de segurar o texto.
  const suporte: { texto: string | null; comecou: boolean } = { texto, comecou: false };
  let resolver!: (v: boolean) => void;
  let rejeitar!: (e: unknown) => void;
  const resposta = new Promise<boolean>((ok, erro) => {
    resolver = ok;
    rejeitar = erro;
  });
  const elo = s.cadeiaDeEnvio.then(async () => {
    const t = suporte.texto;
    if (t === null) return; // desistiu antes da vez: já foi respondido e a contagem já foi liberada
    suporte.comecou = true;
    largar();
    suporte.texto = null;
    try {
      resolver(await digitar(s, t, daFila, envio, procAceito, cancelado));
    } catch (err) {
      rejeitar(err);
    }
  });
  s.cadeiaDeEnvio = elo;
  if (sinal && direto) {
    const desistir = () => {
      if (suporte.comecou || suporte.texto === null) return;
      suporte.texto = null;
      largar();
      log.aviso(s.a("entrada"), "quem pediu desistiu da chamada antes da vez: tirei o pedido da espera sem escrever nada");
      rejeitar(new ErroDeMotor("Não digitei o texto: quem pediu desistiu da chamada antes de o texto começar a ser digitado.", MOTIVO_NAO_ENTROU, "reenviar a mensagem se ainda for necessária"));
    };
    if (sinal.aborted) desistir();
    else sinal.addEventListener("abort", desistir, { once: true });
  }
  return resposta;
}

/** Envios diretos demais esperando a vez de um mesmo agente (a rota responde 429 ENVIOS_DEMAIS). Nada foi escrito. */
export class ErroEnviosDemais extends Error {
  constructor(
    readonly pedidos: number,
    readonly bytes: number,
  ) {
    super(
      `Há envios demais esperando a vez neste agente (${pedidos} pedidos, ${bytes} bytes; o limite é ${MAX_ENVIOS_DIRETOS_ESPERANDO} pedidos ou ${MAX_BYTES_DIRETOS_ESPERANDO} bytes). Não escrevi nada.`,
    );
    this.name = "ErroEnviosDemais";
  }
  readonly howToFix = "esperar os envios anteriores terminarem (o agente digita um por vez) e reenviar a mensagem";
}

/** O terminal deste envio saiu ou foi trocado: nada mais é escrito no terminal novo e o pedido fica retido. */
function terminalTrocado(s: Sessao, envio: SemRecibo | null): false {
  log.aviso(
    s.a("entrada"),
    "o terminal mudou no meio do envio (saiu ou foi trocado); parei de escrever para não digitar no terminal novo, e não sei se o pedido foi recebido",
  );
  if (envio) envio.parada = { tipo: "terminal", motivo: "o terminal foi trocado no meio do envio" };
  return false;
}

/** A tela sincronizada com o emulador. A máscara de segredos segura o fim da saída do CLI até o silêncio
 *  (SILENCIO_DA_MASCARA_MS) e o CLI pode ter acabado de desenhar: logo depois de uma saída a tela pode estar incompleta. Se a
 *  caixa não aparece identificada, até 2 releituras, depois dessa folga, evitam recusar à toa (um diálogo de verdade continua
 *  sendo recusado, só 2 folgas depois). */
async function lerTelaDaCaixa(s: Sessao, proc: Sessao["proc"], paraPrimeiraEscrita = false): Promise<string> {
  // Antes do primeiro byte a caixa também precisa estar VAZIA (e a tela precisa ser posterior à última tecla do dono).
  const pronta = (tela: string) => caixaIdentificada(tela) && (!paraPrimeiraEscrita || caixaVaziaComProva(s, tela));
  let tela = await lerTelaSemSaidaNova(s, proc);
  for (let k = 0; k < 2 && s.proc === proc && !pronta(tela); k++) {
    await new Promise((r) => setTimeout(r, SILENCIO_DA_MASCARA_MS + 30));
    tela = await lerTelaSemSaidaNova(s, proc);
  }
  return tela;
}

/** Quantas vezes a leitura é refeita quando chega saída nova do terminal enquanto ela espera o emulador. */
const LEITURAS_SEM_SAIDA_NOVA = 5;

/** A tela sincronizada, descartando a leitura se o terminal escreveu algo enquanto se esperava o emulador (o contador de saída
 *  `seq` mudou): um diálogo pode estar sendo desenhado e a leitura seria de antes dele. Relê, até LEITURAS_SEM_SAIDA_NOVA vezes. Se a
 *  saída não assenta, devolve "" (tela não identificada): quem chamou não escreve nada. */
export async function lerTelaSemSaidaNova(s: Sessao, proc: Sessao["proc"]): Promise<string> {
  for (let k = 0; k < LEITURAS_SEM_SAIDA_NOVA; k++) {
    const seq = s.seq;
    const tela = await s.telaAtualSincronizada();
    if (s.proc !== proc || s.seq === seq) return tela;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "";
}

/** Nada do texto foi escrito e o envio não pôde começar. Pela fila o item volta intacto para a frente dela (devolve false).
 *  Numa chamada direta lança ErroDeMotor, que a rota responde com 409 ("não entrou, pode reenviar"): o 202 de entrega
 *  incerta é só para quando algo foi escrito. */
function naoEntrou(s: Sessao, envio: SemRecibo | null, motivo: string, comoResolver: string): false {
  if (envio) return naoEscreveu(s, envio, motivo);
  log.aviso(s.a("entrada"), `não escrevi nada no terminal: ${motivo}`);
  throw new ErroDeMotor(`Não digitei o texto: ${motivo}.`, MOTIVO_NAO_ENTROU, comoResolver);
}
const REENVIAR = "esperar o agente voltar a ficar livre (sem diálogo aberto) e reenviar a mensagem";

/** Nada foi escrito porque a caixa de entrada tem texto (ou a tela ainda não mostra o redesenho depois da tecla do dono). Pela
 *  fila o item volta intacto para a frente dela; numa chamada direta a rota responde 409 CAIXA_COM_RASCUNHO. */
function caixaComTexto(s: Sessao, envio: SemRecibo | null, motivo: string): false {
  if (envio) return naoEscreveu(s, envio, motivo);
  const mensagem = `A caixa de entrada do agente não está vazia (${motivo}). Não digitei nada para não misturar o texto com o que já está lá.`;
  const comoResolver = "abrir o terminal do agente (aba Sessões, botão Terminal), enviar ou apagar o texto que está na caixa e depois reenviar a mensagem";
  log.erro(s.a("entrada"), mensagem, comoResolver);
  throw new ErroDeMotor(mensagem, MOTIVO_CAIXA_COM_RASCUNHO, comoResolver);
}

async function digitar(
  s: Sessao,
  texto: string,
  daFila: boolean,
  envio: SemRecibo | null,
  procAceito: Sessao["proc"],
  cancelado: () => boolean,
): Promise<boolean> {
  // O terminal de quando o envio foi aceito: toda escrita abaixo confere que ele continua sendo o da sessão.
  const proc = procAceito;
  if (!proc) throw new Error("não há terminal vivo para digitar");
  // Item da fila que já não está pendente (foi retido como incerto enquanto esperava a vez): nada é escrito.
  if (envio && !pendenteEm(s, envio)) {
    log.aviso(s.a("entrada"), "o pedido deixou de estar pendente enquanto esperava a vez de ser digitado; não escrevi nada no terminal");
    return false;
  }
  // O cliente HTTP do envio direto desistiu enquanto o pedido esperava a vez: nada é escrito.
  if (!envio && cancelado()) {
    return naoEntrou(s, null, "quem pediu desistiu da chamada antes de o texto começar a ser digitado", "reenviar a mensagem se ainda for necessária");
  }
  if (s.proc !== proc) {
    // Nada foi escrito: o item da fila volta para a frente da fila (se ainda for dele) em vez de ficar incerto.
    log.aviso(
      s.a("entrada"),
      "o terminal mudou (reinício ou troca de provedor) entre aceitar o envio e começar a digitar; não escrevi nada no terminal novo",
    );
    if (envio && !devolverNaoDigitado(s, envio)) envio.parada = { tipo: "terminal", motivo: "o terminal foi trocado antes de começar a digitar" };
    if (!envio) return naoEntrou(s, null, "o terminal mudou (reinício ou troca de provedor) antes de o texto começar a ser digitado", REENVIAR);
    return false;
  }
  // Esperou a vez na cadeia: o agente pode ter deixado de poder conversar (login, chave, restrição) enquanto isso.
  // Nada foi escrito ainda. Pela fila o pedido volta para a frente dela e a fila tenta de novo sozinha; numa chamada
  // direta a rota responde com o motivo, como faz antes de aceitar o pedido.
  const recusa = s.recusaDeEntrada();
  if (recusa) {
    if (!daFila) log.erro(s.a("entrada"), `não digitei o texto: ${recusa.mensagem}`, recusa.comoResolver);
    throw new ErroDeMotor(recusa.mensagem, MOTIVO_RECUSA_DE_ENTRADA, recusa.comoResolver);
  }
  // O pedido da fila só é digitado com o agente ocioso: enquanto esperava a vez, um turno pode ter começado. Nada foi
  // escrito, então o item volta para a fila, que tenta de novo no próximo idle.
  if (envio && s.estado.status !== "idle") {
    log.aviso(s.a("entrada"), `o agente deixou de estar ocioso (${s.estado.status}) enquanto o pedido esperava a vez; não escrevi nada no terminal e o pedido volta para a fila`);
    if (!devolverNaoDigitado(s, envio)) envio.parada = { tipo: "caixa", motivo: "o agente não está ocioso e nada foi digitado" };
    return false;
  }
  // O terminal pode ter passado a esperar uma resposta (permissão, pergunta) enquanto isso, e
  // colar o texto e apertar Enter ali responderia o diálogo. Nada foi escrito ainda, então o item volta para a fila.
  if (s.estado.status === "waiting_input") {
    log.aviso(s.a("entrada"), "o agente passou a esperar uma resposta (permissão ou pergunta) enquanto o pedido esperava a vez; não escrevi nada no terminal");
    if (envio && !devolverNaoDigitado(s, envio)) envio.parada = { tipo: "caixa", motivo: "o agente está esperando uma resposta e nada foi digitado" };
    if (!envio) return naoEntrou(s, null, "o agente está esperando uma resposta (permissão ou pergunta)", REENVIAR);
    return false;
  }
  // Outro pedido automático ainda sem recibo confirmado (a vigia dele segue ativa em segundo plano, ou ele está digitado sem
  // recibo): o texto dele pode continuar na caixa, e escrever agora o acrescentaria a ele, com um único Enter mandando os dois.
  // Nada é escrito. Pela fila o item volta intacto para a frente dela. A chamada direta NÃO espera a vigia (a CLI tem
  // timeout de 60 s): a rota responde 409 e a mensagem pode ser reenviada depois.
  const pendente = outroEnvioSemRecibo(s, envio);
  if (pendente) {
    if (envio) return naoEscreveu(s, envio, `${pendente}; só escrevo depois que ele for confirmado`);
    const mensagem = `Outro pedido enviado a este agente ainda não foi confirmado (${pendente}). Não digitei nada, para os dois textos não se juntarem na caixa de entrada.`;
    const comoResolver = "esperar o pedido anterior ser confirmado pelo agente (a vigia dele termina em cerca de 2 minutos), conferir a conversa e reenviar a mensagem";
    log.aviso(s.a("entrada"), `não digitei o texto: ${pendente}`);
    throw new ErroDeMotor(mensagem, MOTIVO_ENVIO_PENDENTE, comoResolver);
  }
  // Digitação suspensa (rascunho do dono, diálogo): vale para a chamada direta e também para o item da fila que esperava a
  // vez na cadeia (o dono pode ter começado a escrever nesse meio tempo). Só segue se a tela de AGORA, já sincronizada e com
  // o terminal quieto, mostrar a caixa vazia. Senão nada é escrito: o item da fila volta intacto para a frente da fila e
  // quem chamou direto recebe o motivo.
  if (s.digitacaoSuspensaEm !== null) {
    const tela = await s.telaAtualSincronizada();
    if (s.proc !== proc) return envio ? naoEscreveu(s, envio, "o terminal foi trocado antes de começar a digitar") : naoEntrou(s, null, "o terminal foi trocado antes de começar a digitar", REENVIAR);
    if (terminalQuietoParaLerTela(s) && caixaVaziaComProva(s, tela)) {
      levantarSuspensao(s);
    } else {
      if (envio) return naoEscreveu(s, envio, "a digitação está suspensa e a caixa do terminal ainda tem texto, um diálogo ou acabou de escrever");
      const motivo =
        "A digitação automática deste terminal está suspensa e a caixa de entrada do agente ainda tem texto (ou um diálogo aberto, ou o terminal acabou de escrever). " +
        "Não digitei nada para não misturar com ele.";
      const comoResolver = "abrir o terminal do agente (aba Sessões, botão Terminal), enviar ou apagar o texto que está na caixa e depois reenviar a mensagem";
      log.erro(s.a("entrada"), motivo, comoResolver);
      throw new ErroDeMotor(motivo, MOTIVO_CAIXA_COM_RASCUNHO, comoResolver);
    }
  }
  s.marcarAtividade();
  if (s.motor.provedor === "codex") await s.vencerTelaDeConfianca(daFila, proc, envio);
  if (s.proc !== proc) return envio ? terminalTrocado(s, envio) : naoEntrou(s, null, "o terminal foi trocado antes de o texto começar a ser digitado", REENVIAR);
  if (s.motor.provedor === "claude") recusarSeEstiverNoAvisoDoAutoMode(s, daFila);
  const pausa = s.motor.pausaAntesDoEnterMs;
  const ehComandoDeBarra = texto.trim().startsWith("/");
  // Quantas escritas o PTY deve ter contado se só ESTE envio escreveu: guardado depois de cada escrita dele.
  let esperadas = s.entradasManuais;
  // Antes de CADA escrita do texto (o primeiro byte e cada pedaço da colagem longa): a tela de AGORA, sincronizada com o
  // emulador, precisa mostrar a caixa de composição. Com um diálogo de permissão aberto (e o hook waiting_input ainda a
  // caminho) um caractere do texto poderia acionar o atalho de uma opção. null = pode escrever; senão, o motivo.
  let porRascunho = false;
  const caixaLivre = async (primeira: boolean): Promise<string | null> => {
    const tela = await lerTelaDaCaixa(s, proc, primeira);
    if (s.proc !== proc) return "o terminal foi trocado antes de o texto ser escrito";
    if (!caixaIdentificada(tela)) {
      return primeira
        ? "a tela não mostra com clareza a caixa de composição (pode haver um diálogo, um menu ou outro marcador)"
        : "a tela mudou no meio da colagem e já não mostra com clareza a caixa de composição";
    }
    // Antes do primeiro byte a caixa precisa estar VAZIA: com um rascunho (do dono, ou o que sobrou de um pedido sem recibo) o texto
    // novo seria acrescentado a ele e um Enter mandaria os dois juntos.
    if (primeira && !caixaVaziaNaTela(tela)) {
      porRascunho = true;
      return "a caixa de entrada tem texto";
    }
    if (primeira && !telaServeDeProva(s)) {
      porRascunho = true;
      return "o dono acabou de escrever no terminal e a tela ainda não mostra o redesenho depois da tecla";
    }
    return null;
  };
  const recusarAntes = (motivo: string): false => (porRascunho ? caixaComTexto(s, envio, motivo) : naoEntrou(s, envio, motivo, REENVIAR));
  if (texto.length <= 256) {
    const antes = motivoDeCaixaMudada(s, esperadas) ?? (await caixaLivre(true)) ?? motivoDeCaixaMudada(s, esperadas) ?? (!envio && cancelado() ? "quem pediu desistiu da chamada" : null);
    if (antes) return recusarAntes(antes);
    if (s.proc !== proc) return naoEntrou(s, envio, "o terminal foi trocado antes de o texto ser escrito", REENVIAR);
    if (envio) envio.escreveuAlgo = true;
    s.escrever(texto);
    esperadas = s.entradasManuais;
    await new Promise((r) => setTimeout(r, pausa));
    return enviarComRecibo(s, { texto, comandoDeBarra: ehComandoDeBarra, envio, proc, entradasAposTexto: esperadas });
  }
  let i = 0;
  let parou: { motivo?: string; escreveu: boolean } | null = null;
  while (i < texto.length) {
    if (s.proc !== proc) {
      parou = { escreveu: i > 0 };
      break;
    }
    // Antes de CADA pedaço: o agente passou a esperar uma resposta, alguém escreveu no terminal no meio da colagem, ou a tela
    // já não mostra a caixa de composição?
    const motivo = motivoDeCaixaMudada(s, esperadas) ?? (await caixaLivre(i === 0)) ?? motivoDeCaixaMudada(s, esperadas) ?? (i === 0 && !envio && cancelado() ? "quem pediu desistiu da chamada" : null);
    if (motivo) {
      parou = { motivo, escreveu: i > 0 };
      break;
    }
    if (s.proc !== proc) {
      parou = { escreveu: i > 0 };
      break;
    }
    if (envio) envio.escreveuAlgo = true;
    s.escrever(texto.slice(i, i + PEDACO));
    esperadas = s.entradasManuais;
    i += PEDACO;
    if (i >= texto.length) {
      // Uma folga depois do último pedaço: o TUI ainda está processando o burst quando o write retorna.
      await new Promise((r) => setTimeout(r, Math.max(120, pausa)));
    } else {
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
    }
  }
  if (parou) {
    if (parou.motivo !== undefined) {
      return parou.escreveu ? parouComTextoNaCaixa(s, envio, parou.motivo) : recusarAntes(parou.motivo);
    }
    return parou.escreveu ? terminalTrocado(s, envio) : naoEntrou(s, envio, "o terminal foi trocado antes de o texto ser escrito", REENVIAR);
  }
  if (s.proc !== proc) return terminalTrocado(s, envio);
  return enviarComRecibo(s, { texto, comandoDeBarra: ehComandoDeBarra, envio, proc, entradasAposTexto: esperadas });
}

/** Por que não se pode escrever mais nada AGORA neste envio: o agente passou a esperar uma resposta (permissão,
 *  pergunta) ou houve uma escrita no terminal que não foi deste envio (o dono digitando, outro texto). null = pode. */
function motivoDeCaixaMudada(s: Sessao, esperadas: number): string | null {
  if (s.estado.status === "waiting_input") return "o agente passou a esperar uma resposta (permissão ou pergunta) no meio do envio";
  if (s.entradasManuais !== esperadas) return "houve outra escrita no terminal no meio do envio, e a caixa já não é só este texto";
  return null;
}

/** Nada foi escrito neste envio: o item da fila volta para a frente da fila; numa chamada direta só devolve false. */
function naoEscreveu(s: Sessao, envio: SemRecibo | null, motivo: string): false {
  log.aviso(s.a("entrada"), `não escrevi nada no terminal: ${motivo}`);
  if (envio && !devolverNaoDigitado(s, envio)) envio.parada = { tipo: "caixa", motivo: `${motivo}; nada foi digitado` };
  return false;
}

/** O texto (parcial ou inteiro) já está na caixa e o envio parou: não se escreve mais nada, e a caixa fica suspensa. */
function parouComTextoNaCaixa(s: Sessao, envio: SemRecibo | null, motivo: string): false {
  log.aviso(
    s.a("entrada"),
    `parei de escrever no terminal: ${motivo}; parte do texto (ou ele inteiro) pode estar na caixa de entrada, e não sei se o pedido foi recebido`,
  );
  return pararComCaixaSuja(s, envio, motivo);
}

/** Orientação quando a tela bloqueia a caixa. Pela fila o pedido fica guardado e a fila tenta de novo
 *  sozinha; numa chamada direta não existe fila, então a pessoa precisa reenviar. */
function comoResolverTelaBloqueada(daFila: boolean): string {
  return daFila
    ? "responder o aviso no terminal do agente (aba Sessões, botão Terminal); o pedido está guardado e é entregue sozinho assim que o aviso sumir. Não reenvie."
    : "responder o aviso no terminal do agente e enviar a mensagem de novo";
}

/** O Claude parou na pergunta de primeira vez do auto mode: o texto digitado cairia dentro do menu e
 *  ficaria parado (nenhum Enter vira turno). Não se responde sozinho porque aceitar muda o modo padrão
 *  do dono. Não digita nada e falha com o motivo, como o aviso do Bypass. */
function recusarSeEstiverNoAvisoDoAutoMode(s: Sessao, daFila: boolean): void {
  if (!ehDialogoDeAutoMode(s.telaInteira())) return;
  const motivo =
    "O Claude Code está parado na pergunta 'Make auto mode your default permission mode?' (aviso de primeira vez do auto mode) " +
    "e a chave skipAutoPermissionPrompt não chegou ao settings. Não digitei o texto para ele não cair dentro do menu.";
  const comoResolver = comoResolverTelaBloqueada(daFila);
  // Pela fila quem loga é ela, uma vez por bloqueio: a tentativa se repete a cada poucos segundos.
  if (!daFila) log.erro(s.a("entrada"), motivo, comoResolver);
  throw new ErroDeMotor(motivo, "runner:dialogo-auto-mode", comoResolver);
}

/**
 * O Codex 0.162.1 pode abrir "Trust this folder?" mesmo com o `trust_level` gravado (B6, 12/10/2026).
 * Se o texto do dono fosse digitado ali, o primeiro caractere escolheria uma opção do menu (o "2" de
 * uma data era "Quit": o Codex saiu com código 0). Então, antes de digitar, olha o fim da tela:
 * se o menu está lá, responde 1 + Enter e só segue quando a tela mudou e o menu não voltou.
 * Se não sumir, NÃO digita: erro claro, e quem chamou trata como trata qualquer falha de digitação.
 */
export async function vencerTelaDeConfianca(s: Sessao, daFila = false, procDoEnvio: Sessao["proc"] = s.proc, envio: SemRecibo | null = null): Promise<void> {
  if (!s.proc || s.proc !== procDoEnvio || !telaDeConfiancaDoCodex(s.telaInteira())) return;
  const area = s.a("entrada");
  log.aviso(
    area,
    "o Codex está na tela 'Trust this folder?' (o trust_level gravado não foi respeitado); respondendo 1 + Enter antes de digitar o texto",
  );
  let novo = "";
  const ouvir = (t: string) => {
    novo += t;
  };
  s.on("terminal", ouvir);
  try {
    if (envio) envio.escreveuAlgo = true;
    s.escrever("1");
    await new Promise((r) => setTimeout(r, 300));
    // Se o terminal foi trocado nesse meio tempo, o Enter não pode cair no terminal novo.
    if (s.proc !== procDoEnvio) return;
    s.escrever("\r");
    const limite = Date.now() + 3_000;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 100));
      if (s.proc !== procDoEnvio) return;
      if (novo.length > 0 && !telaDeConfiancaDoCodex(novo)) return;
    }
  } finally {
    s.off("terminal", ouvir);
  }
  const motivo =
    "O Codex está parado na tela 'Trust this folder?' e não saiu dela depois de responder 1 + Enter. " +
    "Não digitei o texto para ele não cair no menu.";
  const comoResolver = comoResolverTelaBloqueada(daFila);
  if (!daFila) log.erro(area, motivo, comoResolver);
  throw new ErroDeMotor(motivo, "runner:tela-de-confianca", comoResolver);
}


export interface ContextoDoEnvio {
  texto: string;
  comandoDeBarra: boolean;
  /** O item da fila deste envio (null numa chamada direta). */
  envio: SemRecibo | null;
  /** O terminal em que o texto foi digitado. */
  proc: NonNullable<Sessao["proc"]>;
  /** O valor de `entradasManuais` logo depois da última escrita do texto deste envio (antes da pausa da colagem).
   *  Se for outro quando o primeiro Enter vai ser escrito, alguém escreveu no terminal no meio. Falta = não confere. */
  entradasAposTexto?: number;
  /** Os contadores de `promptsAceitos` e `compactsIniciados` de antes do PRIMEIRO Enter do envio, passados à vigia em segundo plano
   *  para ela não redefinir a referência do recibo. Falta = a vigia usa os do item da fila, ou os de quando começa. */
  promptsAntes?: number;
  compactsAntes?: number;
  /** O dono tinha um Enter no terminal ainda sem recibo quando o Enter deste envio foi escrito. Vale para o envio inteiro (todas as
   *  tentativas e a vigia): o recibo do contador pode ser da mensagem dele, então nada o confirma. */
  enterDoDonoAmbiguo?: boolean;
}

/** Só /compact tem recibo próprio (o PreCompact). Os outros comandos de barra não têm. */
function ehCompact(texto: string): boolean {
  return /^\/compact(\s|$)/.test(texto.trim());
}

type DecisaoDoEnter = { acao: "enter" } | { acao: "esperar" } | { acao: "parar"; tipo: "caixa"; motivo: string };
/** `valida` é false quando a saída do terminal ou o estado do agente mudaram enquanto a tela era sincronizada: a decisão
 *  não vale para escrever nada (volta-se a decidir no próximo passo). */
type DecisaoConferida = DecisaoDoEnter & { valida: boolean };

/** Antes de repetir o Enter, três perguntas: alguém escreveu no terminal depois do último Enter? A tela mostra o
 *  MESMO texto na caixa de composição? Só com as duas respostas certas o Enter se repete. Caixa vazia: o texto
 *  saiu da caixa (o CLI provavelmente o aceitou e o recibo está atrasado), então só espera. Diálogo, menu, texto
 *  diferente ou tela que não se reconhece: não aperta nada, porque um Enter ali poderia aprovar uma permissão ou
 *  mandar um rascunho do dono. */
function decidirComTela(s: Sessao, tela: string, texto: string, entradasEsperadas: number): DecisaoDoEnter {
  if (s.entradasManuais !== entradasEsperadas) {
    return { acao: "parar", tipo: "caixa", motivo: "houve outra escrita no terminal depois do Enter anterior, e a caixa já não é a mesma" };
  }
  // Com o agente esperando uma resposta (permissão, pergunta) um Enter poderia aprovar ou responder algo por conta própria.
  if (s.estado.status === "waiting_input") {
    return { acao: "parar", tipo: "caixa", motivo: "o agente está esperando uma resposta (permissão ou pergunta), e um Enter ali poderia respondê-la" };
  }
  const caixa = estadoDaCaixa(tela, texto);
  if (caixa === "mesmo-texto") return { acao: "enter" };
  if (caixa === "vazia") return { acao: "esperar" };
  return {
    acao: "parar",
    tipo: "caixa",
    motivo: "a tela não mostra o mesmo texto na caixa de composição (pode haver um diálogo, um menu ou outro texto no lugar)",
  };
}

/** Imediatamente antes de CADA repetição do Enter, depois da leitura assíncrona da tela: o mundo pode ter mudado enquanto o emulador
 *  era esperado (o recibo chegou, o agente abriu turno, o item da fila foi baixado, o terminal foi trocado). Qualquer falha: o
 *  Enter não é escrito, porque a tecla poderia cair na próxima interação do CLI. Roda no mesmo tick da escrita, sem await no meio. */
function enterRepetidoAindaCabe(s: Sessao, proc: Sessao["proc"], envio: SemRecibo | null, antes: number, compactAntes: number, comandoDeBarra: boolean, soCompactVale: boolean, texto: string): boolean {
  if (s.proc !== proc) return false;
  if (!soCompactVale && reciboDoTexto(s, antes, texto)) return false;
  // O contador de compactações só é recibo do /compact: outro comando de barra (/model) não o aceita, senão uma compactação
  // automática no meio daria o comando por consumido sem ele ter sido.
  if (ehCompact(texto) && s.compactsIniciados > compactAntes) return false;
  if (s.estado.status !== "idle") return false;
  if (envio && !pendenteEm(s, envio)) return false;
  return true;
}

/** A decisão sobre o Enter com a tela já sincronizada com o emulador. Quem escreve o Enter o faz no MESMO tick em que recebe
 *  esta resposta, sem await no meio, e só se `valida`. */
async function decidirEnter(s: Sessao, texto: string, entradasEsperadas: number): Promise<DecisaoConferida> {
  const seq = s.seq;
  const status = s.estado.status;
  const tela = await s.telaAtualSincronizada();
  const d = decidirComTela(s, tela, texto, entradasEsperadas);
  return { ...d, valida: s.seq === seq && s.estado.status === status };
}

/** O Enter, com recibo.
 *
 *  Por que não basta escrever "\r": o Enter que chega logo depois de um burst
 *  grande às vezes alcança o TUI enquanto ele ainda está juntando o texto colado,
 *  e vira quebra de linha em vez de envio. O texto fica escrito na caixa de
 *  entrada, ninguém abre turno nenhum, e o POST /input já respondeu 200: que é a
 *  pior forma de falhar: silenciosa e com cara de sucesso. Visto em campo em
 *  25/08/2026, num poke de 293 caracteres; o MESMO texto passou na tentativa
 *  seguinte, então é corrida, e corrida não se resolve aumentando a espera.
 *
 *  O recibo é o hook UserPromptSubmit (Claude) ou o `task_started` do rollout
 *  (Codex), que só aparecem quando o CLI ACEITOU o prompt. Sem recibo, o Enter só se repete se a tela
 *  mostrar que o MESMO texto continua na caixa de composição (ver decidirEnter); em qualquer outro caso o
 *  pedido fica retido como incerto.
 *
 *  Devolve true quando o texto está confirmado e false quando NÃO está: os Enters acabaram sem recibo (a vigia
 *  segue em segundo plano), a repetição parou, ou o terminal saiu no meio. Quem chamou pela fila usa isso, e o
 *  `parada` do item, para reter o pedido em vez de dá-lo como entregue.  */
export async function enviarComRecibo(s: Sessao, ctx: ContextoDoEnvio): Promise<boolean> {
  const { texto, comandoDeBarra, envio, proc } = ctx;
  const espera = s.motor.reciboMs;
  // Quantas escritas o PTY deve ter contado se só estes Enters escreveram (ver vigiarReciboAtrasado).
  let entradasEsperadas = ctx.entradasAposTexto ?? s.entradasManuais;
  const compact = ehCompact(texto);
  // No Claude o recibo do /compact é o PreCompact: um prompt comum aceito (de outra pessoa) não prova nada sobre ele.
  const soCompactVale = compact && s.motor.provedor === "claude";
  // Os contadores de antes do PRIMEIRO Enter deste envio. Só são lidos depois de ele ter sido escrito (a tentativa 1 sempre o escreve).
  let referencia: { prompts: number; compacts: number } | null = null;
  // A ambiguidade vista no Enter deste envio (um Enter do dono pendente) vale para TODO o envio, e não só para a tentativa em que foi vista.
  let enterDoDonoAmbiguo = ctx.enterDoDonoAmbiguo === true;
  for (let tentativa = 1; tentativa <= RECIBO_ENTER_TENTATIVAS; tentativa++) {
    if (s.proc !== proc) return terminalTrocado(s, envio);
    let escreveuEnter = false;
    if (tentativa > 1) {
      const d = await decidirEnter(s, texto, entradasEsperadas);
      if (s.proc !== proc) return terminalTrocado(s, envio);
      if (d.acao === "parar") {
        log.aviso(
          s.a("entrada"),
          `parei de repetir o Enter (${tentativa - 1}/${RECIBO_ENTER_TENTATIVAS} sem recibo): ${d.motivo}; não sei se o pedido foi recebido`,
        );
        if (envio) {
          envio.interrompido = true;
          envio.parada = { tipo: "caixa", motivo: `a repetição do Enter parou: ${d.motivo}` };
        }
        return false;
      }
      // Comando de barra sem recibo próprio (/clear, /model...) com a caixa vazia: o comando foi consumido.
      // Só vale com a leitura da tela válida: um redesenho durante a leitura pode mostrar a caixa vazia de antes. Leitura inválida repete a observação.
      if (d.acao === "esperar" && d.valida && comandoDeBarra && !compact) return true;
      escreveuEnter = d.acao === "enter" && d.valida;
      if (escreveuEnter && !enterRepetidoAindaCabe(s, proc, envio, referencia?.prompts ?? s.promptsAceitos, referencia?.compacts ?? s.compactsIniciados, comandoDeBarra, soCompactVale, texto)) {
        log.info(s.a("entrada"), `não repeti o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS}: depois de ler a tela o recibo chegou, o agente já não está ocioso ou o pedido já não está pendente`);
        escreveuEnter = false;
      }
    } else {
      // O primeiro Enter só sai se, depois da pausa da colagem, o agente não passou a esperar uma resposta e ninguém
      // escreveu no terminal: um Enter ali poderia responder um diálogo ou mandar um rascunho junto com o texto.
      // A tela vem sincronizada com o emulador; se a saída do terminal ainda estiver mudando, espera um pouco e tenta de novo.
      let tela: string | null = null;
      for (let k = 0; k < 5 && tela === null; k++) {
        const seq = s.seq;
        const status = s.estado.status;
        const lida = await s.telaAtualSincronizada();
        if (s.proc !== proc) return terminalTrocado(s, envio);
        if (s.seq === seq && s.estado.status === status) tela = lida;
        else await new Promise((r) => setTimeout(r, 50));
      }
      if (tela === null) return parouComTextoNaCaixa(s, envio, "a tela do terminal não parou de mudar antes do primeiro Enter, e não dá para saber o que há na caixa");
      const motivo = motivoDeCaixaMudada(s, entradasEsperadas);
      if (motivo) return parouComTextoNaCaixa(s, envio, motivo);
      if (!caixaIdentificada(tela)) {
        const seq = s.seq;
        tela = await lerTelaDaCaixa(s, proc);
        if (s.proc !== proc) return terminalTrocado(s, envio);
        if (s.seq !== seq && !caixaIdentificada(tela)) return parouComTextoNaCaixa(s, envio, "a tela do terminal não parou de mudar antes do primeiro Enter, e não dá para saber o que há na caixa");
        const motivo2 = motivoDeCaixaMudada(s, entradasEsperadas);
        if (motivo2) return parouComTextoNaCaixa(s, envio, motivo2);
      }
      // Um diálogo aberto (permissão, pergunta, aviso): o Enter o responderia. Aqui não se exige "mesmo texto": uma colagem
      // longa aparece resumida na caixa.
      if (!caixaIdentificada(tela)) return parouComTextoNaCaixa(s, envio, "a tela não mostra com clareza a caixa de composição (pode haver um diálogo, um menu ou outro marcador), e um Enter ali poderia respondê-lo");
      escreveuEnter = true;
    }
    if (escreveuEnter) {
      // O recibo deste pedido só vale se vier depois do PRIMEIRO Enter dele: o contador é marcado aqui, antes da escrita, e
      // fica fixo até o fim do envio (todas as tentativas e a vigia em segundo plano). Uma tentativa sem novo Enter não o redefine:
      // o `task_started` pode ter chegado numa leitura e o texto do usuário só na seguinte.
      if (referencia === null) referencia = { prompts: s.promptsAceitos, compacts: s.compactsIniciados };
      if (envio && !envio.enterEscrito) {
        envio.promptsAntes = s.promptsAceitos;
        envio.enterEscrito = true;
      }
      s.escrever("\r");
      entradasEsperadas = s.entradasManuais;
      if (envio) envio.entradasNoEnter = entradasEsperadas;
    }
    // Um Enter do dono pelo terminal ainda sem recibo: o recibo que chegar agora pode ser dele, e não deste envio.
    if (escreveuEnter && s.enterManualPendente !== null) enterDoDonoAmbiguo = true;
    const ref = referencia ?? { prompts: s.promptsAceitos, compacts: s.compactsIniciados };
    const recebeu = await esperarRecibo(s, ref.prompts, espera, compact ? ref.compacts : undefined, soCompactVale, texto);
    if (recebeu) {
      if (enterDoDonoAmbiguo) {
        return parouComTextoNaCaixa(s, envio, "chegou um recibo, mas o dono tinha dado um Enter no terminal ainda sem recibo, então o recibo pode ser da mensagem dele");
      }
      // Alguém escreveu no terminal depois do nosso Enter: o recibo pode ser de outra mensagem. Não é entrega provada.
      if (s.entradasManuais !== entradasEsperadas) {
        return parouComTextoNaCaixa(s, envio, "chegou um recibo, mas houve outra escrita no terminal depois do Enter deste pedido, então o recibo pode ser de outra mensagem");
      }
      return true;
    }
    if (escreveuEnter) {
      const proxima = tentativa < RECIBO_ENTER_TENTATIVAS ? decidirComTela(s, s.telaAtual(), texto, entradasEsperadas).acao : null;
      const fim =
        proxima === "enter" ? "; o mesmo texto continua na caixa, batendo na tecla de novo"
        : proxima === "esperar" ? "; o texto já saiu da caixa, só espero o recibo"
        : "";
      log.info(s.a("entrada"), `o Enter ${tentativa}/${RECIBO_ENTER_TENTATIVAS} não virou turno em ${espera}ms${fim}`);
    } else {
      log.info(s.a("entrada"), `tentativa ${tentativa}/${RECIBO_ENTER_TENTATIVAS} sem recibo em ${espera}ms (o texto já saiu da caixa, não repeti o Enter)`);
    }
    // Sem nenhum hook há mais de 60 s não existe recibo possível: esperar mais não prova nada. As tentativas
    // acabam aqui e o pedido fica retido como incerto (nunca declarado entregue, nunca digitado de novo).
    if (semHooksDeVerdade(s) && estadoDaCaixa(s.telaAtual(), texto) !== "mesmo-texto") {
      return semRecibosPossivel(s, envio, texto, comandoDeBarra && !compact);
    }
  }
  if (semHooksDeVerdade(s)) return semRecibosPossivel(s, envio, texto, comandoDeBarra && !compact);
  // Ainda dá para insistir sem segurar quem chamou: a vigia segue em segundo plano e só ela dá o ERRO final.
  const total = RECIBO_ENTER_TENTATIVAS + s.reciboVigiaPassosMs.length;
  const segundos = Math.round(s.reciboVigiaPassosMs.reduce((a, b) => a + b, 0) / 1000);
  log.info(
    s.a("entrada"),
    `${RECIBO_ENTER_TENTATIVAS} Enters sem recibo; continuo tentando em segundo plano por ~${segundos}s (até ${s.reciboVigiaPassosMs.length} verificações espaçadas; o Enter só se repete com o mesmo texto na caixa)`,
  );
  if (s.proc !== proc) return terminalTrocado(s, envio);
  vigiarReciboAtrasado(s, { ...ctx, promptsAntes: referencia?.prompts, compactsAntes: referencia?.compacts, enterDoDonoAmbiguo }, total, entradasEsperadas);
  return false;
}

/** Claude sem nenhum hook há mais de 60 s: o pedido foi digitado e o Enter escrito, mas não há como provar que o
 *  CLI o recebeu. Não é declarado entregue. Comando de barra sem recibo próprio não tem o que provar. */
function semRecibosPossivel(s: Sessao, envio: SemRecibo | null, texto: string, barraSemRecibo: boolean): boolean {
  // Com texto na caixa (ou uma tela que não se reconhece) nada prova que o comando foi consumido, e o texto pode
  // continuar lá: a digitação fica suspensa e o pedido retido, mesmo para comando de barra.
  if (estadoDaCaixa(s.telaAtual(), texto) !== "vazia") {
    return parouComTextoNaCaixa(s, envio, "o agente não manda hooks (não há recibo possível) e a caixa de entrada não aparece vazia: o texto pode continuar nela");
  }
  if (barraSemRecibo) return true;
  log.aviso(
    s.a("entrada"),
    `o ${s.motor.binario} não mandou nenhum hook desde que abriu (mais de ${Math.round(s.prazoSemHooksMs / 1000)}s): não há como provar que ele recebeu o pedido, ` +
      `então o pedido não é dado como entregue e fica retido como incerto`,
  );
  if (envio) envio.parada = { tipo: "sem-hooks", motivo: "o agente não manda hooks, então não há recibo possível" };
  return false;
}

/** Continua olhando, em segundo plano, depois que as tentativas de enviarComRecibo falharam.
 *  Cada passo olha primeiro o recibo (o turno pode ter aberto sozinho, só atrasado) e só então decide
 *  se bate a tecla: com a sessão fora de idle, algo abriu turno por outro caminho e basta esperar; com a
 *  caixa vazia o texto já saiu dela e também basta esperar; só com o MESMO texto na caixa o Enter se repete.
 *  Só no fim, sem recibo, o pedido vai para retidos. Uma vigia por sessão. */
export function vigiarReciboAtrasado(s: Sessao, ctx: ContextoDoEnvio, total: number, entradasDoEnvio: number): void {
  const { texto, comandoDeBarra, envio, proc } = ctx;
  // Uma vigia por sessão. Se a que existe acompanhava um item da fila ainda pendente, ela não pode simplesmente sumir:
  // o item ficaria em semRecibo para sempre e travaria a fila. Ele é retido como incerto, explicitamente.
  const anterior = s.vigiaDoEnvio;
  const minhaGeracao = ++s.vigiaGeracao;
  if (s.vigiaDoRecibo) clearTimeout(s.vigiaDoRecibo);
  s.vigiaDoRecibo = null;
  s.vigiaDoEnvio = null;
  const substituido = anterior && anterior !== envio && pendenteEm(s, anterior) ? anterior : null;
  if (substituido) {
    suspenderPorRascunho(s);
    reter(s, substituido.item, "outro envio substituiu a vigia deste pedido antes do recibo");
  }
  if (s.proc !== proc) {
    if (substituido) talvezSoltarFila(s);
    return;
  }
  const antes = ctx.promptsAntes ?? (envio?.enterEscrito ? envio.promptsAntes : s.promptsAceitos);
  const compactAntes = ctx.compactsAntes ?? s.compactsIniciados;
  const compact = ehCompact(texto);
  const inicio = Date.now();
  const passos = s.reciboVigiaPassosMs;
  const soCompactVale = compact && s.motor.provedor === "claude";
  const aceito = () => (!soCompactVale && reciboDoTexto(s, antes, texto)) || (compact && s.compactsIniciados > compactAntes);
  // Toda escrita no PTY passa por s.escrever() e soma em entradasManuais. Se o número mudou sem ser pela
  // própria vigia, alguém mexeu na caixa (o dono pelo terminal, ou um texto novo sendo digitado): o que
  // está lá já não é o texto que esta vigia tenta enviar, e um Enter dela poderia mandar um rascunho.
  let entradasEsperadas = entradasDoEnvio;
  let ambiguo = ctx.enterDoDonoAmbiguo === true;

  // Fim desta vigia (se ela ainda é a vigente): enquanto `vigiaDoRecibo` não for nulo a fila não solta nada (ver
  // talvezSoltarFila), então quem a encerra reavalia a fila.
  const acabar = () => {
    if (s.vigiaGeracao !== minhaGeracao) return;
    if (s.vigiaDoEnvio === envio) s.vigiaDoEnvio = null;
    s.vigiaDoRecibo = null;
    talvezSoltarFila(s);
  };
  const reterEste = (motivo: string, suspender: boolean) => {
    // A suspensão é do TERMINAL: vale também para um envio direto (sem item de fila para reter). O texto dele pode continuar na
    // caixa, e acabar() solta a fila logo depois: sem ela, o próximo pedido seria digitado por cima dele.
    if (suspender && (!envio || envio.aguardando)) suspenderPorRascunho(s);
    if (!envio?.aguardando) return;
    reter(s, envio.item, motivo);
    talvezSoltarFila(s);
  };

  const passo = async (i: number): Promise<void> => {
    if (s.proc !== proc) return acabar();
    // A tela vem sincronizada com o emulador. Durante a espera a vigia pode ter sido substituída ou cancelada.
    // `vigiaDoRecibo` fica preenchido durante todo o passo: é o que segura a fila enquanto a vigia está ativa.
    const d = await decidirEnter(s, texto, entradasEsperadas);
    if (s.vigiaGeracao !== minhaGeracao) return;
    if (s.proc !== proc) return acabar();
    if (aceito()) {
      // Um Enter do dono estava pendente quando o nosso foi escrito: o recibo pode ser da mensagem dele. Entrega incerta.
      if (ambiguo) {
        log.aviso(s.a("entrada"), "chegou um recibo, mas o dono tinha dado um Enter no terminal ainda sem recibo; não o dou como entregue");
        reterEste("chegou um recibo, mas o dono tinha dado um Enter no terminal ainda sem recibo, então o recibo pode ser da mensagem dele", true);
        return acabar();
      }
      // Houve escrita de fora depois do nosso último Enter: o recibo (ou o PreCompact) pode ser de outra coisa.
      if (envio && pendenteEm(s, envio) && s.entradasManuais !== entradasEsperadas) {
        log.aviso(s.a("entrada"), "chegou um recibo, mas houve outra escrita no terminal depois do Enter deste pedido; não o dou como entregue");
        reterEste("chegou um recibo, mas houve outra escrita no terminal depois do Enter deste pedido", true);
        return acabar();
      }
      log.info(
        s.a("entrada"),
        `o turno abriu atrasado, ${Math.round((Date.now() - inicio) / 1000)}s depois do texto digitado`,
      );
      if (envio?.barra) liberarBarra(s, envio);
      return acabar();
    }
    if (comandoDeBarra && !compact && d.acao === "esperar" && d.valida) {
      // Comando de barra sem recibo próprio e a caixa vazia: o comando foi consumido.
      if (envio?.barra) liberarBarra(s, envio);
      return acabar();
    }
    if (i >= passos.length) {
      const naCaixa = d.acao === "enter";
      if (naCaixa) {
        log.erro(
          s.a("entrada"),
          `digitei ${total} Enters e nenhum abriu turno: o texto ficou escrito na caixa de entrada do agente`,
          "olhar a tela (GET /api/agents/:id/terminal) e dar um Enter à mão, ou reenviar por POST /api/agents/:id/input",
        );
      } else {
        log.aviso(
          s.a("entrada"),
          `o texto saiu da caixa de entrada, mas o agente não confirmou o pedido em ~${Math.round((Date.now() - inicio) / 1000)}s; não sei se ele foi recebido`,
        );
      }
      // Sem recibo depois de todas as verificações: o pedido fica retido como incerto (não trava os próximos, e o
      // texto fica guardado no arquivo da fila). Nunca é digitado de novo sozinho. Se o texto pode ter ficado na
      // caixa, a digitação automática deste terminal fica suspensa.
      reterEste(`${total} tentativas e nenhuma virou turno`, d.acao !== "esperar");
      return acabar();
    }
    if (d.acao === "parar") {
      log.info(s.a("entrada"), `parei de insistir no Enter: ${d.motivo}`);
      // O pedido pendente não tem como ser provado nem repetido com segurança: fica retido. Como há outra coisa
      // na caixa (provavelmente o dono escrevendo, ou um diálogo), a digitação automática fica suspensa.
      if (envio) envio.interrompido = true;
      reterEste("a repetição do Enter parou porque a caixa de entrada mudou", true);
      return acabar();
    }
    if (d.acao === "enter" && d.valida && enterRepetidoAindaCabe(s, proc, envio, antes, compactAntes, comandoDeBarra, soCompactVale, texto)) {
      log.info(
        s.a("entrada"),
        `o Enter atrasado ${RECIBO_ENTER_TENTATIVAS + i + 1}/${total} (ainda sem recibo, e o mesmo texto continua na caixa); batendo na tecla de novo`,
      );
      s.escrever("\r");
      entradasEsperadas = s.entradasManuais;
      if (envio) envio.entradasNoEnter = entradasEsperadas;
      if (s.enterManualPendente !== null) ambiguo = true;
    }
    agendar(i + 1);
  };
  // O último passo só confere o recibo do último Enter, então espera o mesmo que o Enter normal.
  const agendar = (i: number): void => {
    s.vigiaDoRecibo = setTimeout(() => void passo(i), i < passos.length ? passos[i] : s.motor.reciboMs);
    s.vigiaDoRecibo.unref();
  };
  s.vigiaDoEnvio = envio;
  agendar(0);
}

/** Claude sem NENHUM hook vivo e já passado o prazo de boot desde o spawn: agente sem hooks registrados
 *  (settings recusado, versão sem hooks), para o qual não existe recibo possível. Antes do prazo a falta de hook
 *  só quer dizer "ainda não chegou", e um Claude com os hooks travados é igual a esse caso (incidente de
 *  18/11/2026: o pedido foi digitado sem recibo e sumiu). Nesse caso o pedido NÃO é dado como entregue: fica
 *  retido como incerto. */
export function semHooksDeVerdade(s: Sessao): boolean {
  return !s.hooksVivos && !s.motor.reciboPorRollout && Date.now() - s.spawnEm >= s.prazoSemHooksMs;
}

/** Espera o contador de prompts aceitos passar de `antes`. Sem recibo dentro do limite, false: nem o prazo de
 *  "agente sem hooks" transforma a falta de recibo em entrega (ver semHooksDeVerdade). */
export function esperarRecibo(s: Sessao, antes: number, limiteMs: number, compactAntes?: number, soCompact = false, texto?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const olhar = () => {
      // `texto`: no Codex o recibo precisa ser de um turno com o texto deste pedido (ver reciboDoTexto).
      if (!soCompact && (texto === undefined ? s.promptsAceitos > antes : reciboDoTexto(s, antes, texto))) return resolve(true);
      // Comando de barra (`/compact`) não dispara UserPromptSubmit: o PreCompact depois deste Enter é o
      // recibo dele. Só para esse caso: PreToolUse de um turno ANTERIOR não prova que a mensagem nova
      // entrou (ela pode estar presa na caixa), então não conta.
      if (compactAntes !== undefined && s.compactsIniciados > compactAntes) return resolve(true);
      if (Date.now() - inicio >= limiteMs) return resolve(false);
      setTimeout(olhar, 100);
    };
    olhar();
  });
}
