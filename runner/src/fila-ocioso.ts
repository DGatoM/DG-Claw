// Persistência da fila "quando ficar ocioso".
//
// O POST /api/agents/:id/input responde 202 antes de o texto ser digitado. Se o runner
// reiniciar nesse intervalo (systemd Restart=always, troca de provedor, cofre mudou), um
// texto só em memória some em silêncio, e ali pode estar a mensagem de um cliente ou de
// uma rotina. Por isso a fila é espelhada em disco a cada mudança.
//
// O conteúdo é mensagem de cliente: pasta 0700, arquivo 0600.
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

export interface ItemDaFila {
  texto: string;
  /** epoch ms de quando entrou na fila. */
  em: number;
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
    if (dado?.versao !== 1 || !Array.isArray(dado.itens)) throw new Error("formato inesperado (esperava versao 1 e uma lista de itens)");
    const itens: ItemDaFila[] = [];
    for (const it of dado.itens as Array<{ texto?: unknown; em?: unknown }>) {
      if (typeof it?.texto !== "string") throw new Error("item sem texto em formato de string");
      itens.push({ texto: it.texto, em: typeof it.em === "number" ? it.em : Date.now() });
    }
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

/**
 * Grava a fila de forma atômica (arquivo .tmp na mesma pasta + rename). Fila vazia apaga o
 * arquivo. Nunca lança: se falhar, loga e a fila continua valendo em memória.
 */
export function gravarFila(caminho: string, itens: ItemDaFila[], area: string): void {
  try {
    if (itens.length === 0) {
      fs.rmSync(caminho, { force: true });
      return;
    }
    const pasta = path.dirname(caminho);
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    const tmp = `${caminho}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ versao: 1, itens }), { mode: 0o600 });
    fs.renameSync(tmp, caminho);
  } catch (err) {
    log.erro(
      area,
      `não consegui gravar a fila de textos pendentes em ${caminho}: ${err instanceof Error ? err.message : err}`,
      "conferir espaço em disco e permissões da pasta de estado; a fila continua em memória, mas um reinício agora perderia os textos",
    );
  }
}
