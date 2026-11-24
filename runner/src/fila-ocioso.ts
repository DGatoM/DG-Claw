// Persistência da fila "quando ficar ocioso".
//
// O POST /api/agents/:id/input responde 202 antes de o texto ser digitado. Se o runner
// reiniciar nesse intervalo (systemd Restart=always, troca de provedor, cofre mudou), um
// texto só em memória some em silêncio, e ali pode estar a mensagem de um cliente ou de
// uma rotina. Por isso a fila é espelhada em disco a cada mudança.
//
// O conteúdo é mensagem de cliente: pasta 0700, arquivo 0600.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { log } from "./logger.js";

export interface ItemDaFila {
  texto: string;
  /** epoch ms de quando entrou na fila. */
  em: number;
  /** true quando a mensagem entrou com o agente ocupado ou com outras na frente: ela vai ser lida depois de falas
   *  dele que o dono ainda não viu. Falta (arquivo antigo) vale falso. */
  esperou?: boolean;
  /** Identificador curto, só para o log dizer de qual pedido fala (nunca o texto). */
  id?: string;
  /** Só no disco: o texto foi (ou ia ser) digitado no terminal e o CLI ainda não confirmou que o aceitou (sem
   *  recibo). É gravado ANTES da primeira escrita no terminal. Ao carregar, um item `digitado` nunca é digitado de
   *  novo: fica retido como `incerto` (ver recuperarDoDisco em sessao/fila.ts). */
  digitado?: boolean;
  /** O pedido pode ter sido recebido ou não e não deu para provar: fica guardado no arquivo, NÃO é enviado
   *  sozinho, nunca, e não bloqueia os próximos. */
  incerto?: boolean;
}

/** Nome de arquivo seguro: só [A-Za-z0-9._-], o resto vira "_". */
export function nomeSeguro(id: string): string {
  const limpo = id.replace(/[^A-Za-z0-9._-]/g, "_");
  // "." e ".." seriam caminhos especiais; um id vazio não nomearia nada.
  return limpo === "" || limpo === "." || limpo === ".." ? "_" + limpo : limpo;
}

export function caminhoDaFila(pastaDeEstado: string, idDaSessao: string): string {
  return path.join(pastaDeEstado, "fila-ocioso", `${nomeSeguro(idDaSessao)}.json`);
}

/** Lê a fila do disco. Arquivo inexistente é fila vazia, sem log. Nunca lança. */
export function carregarFila(caminho: string, area: string): ItemDaFila[] {
  let bruto: string;
  try {
    bruto = fs.readFileSync(caminho, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.erro(
      area,
      `não consegui ler a fila de textos pendentes em ${caminho}: ${err instanceof Error ? err.message : err}`,
      "conferir as permissões do arquivo e da pasta; a sessão segue com a fila vazia e o arquivo fica como está",
    );
    return [];
  }
  try {
    const dado = JSON.parse(bruto) as { versao?: unknown; itens?: unknown };
    const versao = dado?.versao;
    if ((versao !== 1 && versao !== 2) || !Array.isArray(dado.itens)) throw new Error("formato inesperado (esperava versao 1 ou 2 e uma lista de itens)");
    const itens: ItemDaFila[] = [];
    for (const it of dado.itens as Array<Record<string, unknown>>) {
      if (typeof it?.texto !== "string") throw new Error("item sem texto em formato de string");
      const item: ItemDaFila = { texto: it.texto, em: typeof it.em === "number" ? it.em : Date.now() };
      if (it.esperou === true) item.esperou = true;
      // Só vale o formato que o runner gera (8 hex). Qualquer outro valor é trocado por um id novo, e o valor inválido nunca vai para o log.
      if (typeof it.id === "string") {
        if (/^[0-9a-f]{8}$/.test(it.id)) item.id = it.id;
        else {
          item.id = randomUUID().slice(0, 8);
          log.aviso(area, `um item da fila em ${caminho} tinha um id fora do formato e ganhou o id novo ${item.id}`);
        }
      }
      // A versão 1 não conhecia `digitado` nem `incerto` (veja abaixo o tratamento do primeiro item).
      if (versao === 2 && it.digitado === true) item.digitado = true;
      if (versao === 2 && it.incerto === true) item.incerto = true;
      itens.push(item);
    }
    // A base v1 gravava o item em voo na primeira posição, sem distingui-lo dos outros: ele pode já ter sido aceito
    // pelo CLI antes de o runner antigo cair. Digitá-lo de novo repetiria o pedido, então o primeiro fica incerto
    // (guardado para conferência, nunca enviado sozinho) e os demais seguem na ordem.
    if (versao === 1 && itens.length > 0) itens[0].incerto = true;
    return itens;
  } catch (err) {
    const destino = `${caminho}.corrompido-${Date.now()}`;
    let guardado = `guardei o conteúdo em ${destino}`;
    try {
      fs.renameSync(caminho, destino);
    } catch (e2) {
      guardado = `nem consegui renomear para guardar o conteúdo (${e2 instanceof Error ? e2.message : e2}); o arquivo original continua em ${caminho}`;
    }
    log.erro(
      area,
      `a fila de textos pendentes em ${caminho} está corrompida (${err instanceof Error ? err.message : err}); ${guardado}`,
      "abrir o arquivo .corrompido-* e reenviar à mão os textos que ainda interessem; a sessão segue com a fila vazia",
    );
    return [];
  }
}

/** A versão do arquivo que o runner grava. A 2 acrescenta `digitado` e `incerto`; um runner antigo, que só
 *  aceita a 1, recusa o arquivo (e o guarda como corrompido) em vez de executar um pedido incerto. */
export const VERSAO_DA_FILA = 2;

/** fs.writeSync pode gravar menos bytes do que o pedido (disco quase cheio, sinal): insiste até o Buffer inteiro. */
export function escreverTudo(fd: number, dados: Buffer): void {
  let feito = 0;
  while (feito < dados.length) {
    const n = fs.writeSync(fd, dados, feito, dados.length - feito);
    if (n <= 0) throw new Error("o sistema não gravou nenhum byte do arquivo da fila (disco cheio?)");
    feito += n;
  }
}

function sincronizarPasta(pasta: string): void {
  const fd = fs.openSync(pasta, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** `gravado`: no disco e com a pasta sincronizada. `sem-fsync-da-pasta`: o arquivo está no lugar, mas a sincronização da
 *  pasta falhou (só uma queda de energia agora o perderia). `falhou`: o arquivo não foi gravado. */
export type ResultadoDaGravacao = "gravado" | "falhou" | "sem-fsync-da-pasta";

/** O arquivo já está no lugar (o rename deu certo): uma falha só no fsync da pasta NÃO desfaz isso. Dizer "não gravado" faria
 *  quem chamou reenviar o pedido, e ele entraria duas vezes. O risco que sobra é só o de uma queda de energia agora. */
function sincronizarPastaDepoisDeGravar(pasta: string, caminho: string, area: string): ResultadoDaGravacao {
  try {
    sincronizarPasta(pasta);
    return "gravado";
  } catch (err) {
    log.aviso(
      area,
      `gravei a fila de textos pendentes em ${caminho}, mas a sincronização da pasta falhou (${err instanceof Error ? err.message : err}); ` +
        `o arquivo está no lugar e o pedido vale como gravado, o risco é só de uma queda de energia nos próximos instantes perdê-lo`,
    );
    return "sem-fsync-da-pasta";
  }
}

/**
 * Grava a fila de forma atômica (arquivo .tmp na mesma pasta, fsync do temporário, rename e fsync da pasta). Fila
 * vazia apaga o arquivo. Nunca lança: se falhar, loga e a fila continua valendo em memória. Devolve "gravado" só
 * depois de o conteúdo estar no disco com a pasta sincronizada, "sem-fsync-da-pasta" quando só essa última etapa
 * falhou e "falhou" quando o arquivo não foi gravado: quem vai digitar um texto só digita depois de "gravado".
 */
export function gravarFila(caminho: string, itens: ItemDaFila[], area: string): ResultadoDaGravacao {
  try {
    const pasta = path.dirname(caminho);
    if (itens.length === 0) {
      fs.rmSync(caminho, { force: true });
      return fs.existsSync(pasta) ? sincronizarPastaDepoisDeGravar(pasta, caminho, area) : "gravado";
    }
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    const tmp = `${caminho}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        escreverTudo(fd, Buffer.from(JSON.stringify({ versao: VERSAO_DA_FILA, itens })));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, caminho);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return sincronizarPastaDepoisDeGravar(pasta, caminho, area);
  } catch (err) {
    log.erro(
      area,
      `não consegui gravar a fila de textos pendentes em ${caminho}: ${err instanceof Error ? err.message : err}`,
      "conferir espaço em disco e permissões da pasta de estado; a fila continua em memória, mas um reinício agora perderia os textos",
    );
    return "falhou";
  }
}
