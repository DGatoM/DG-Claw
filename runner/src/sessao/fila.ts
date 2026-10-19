import type { Sessao } from "../sessao.js";
import { gravarFila } from "../fila-ocioso.js";
import { log } from "../logger.js";
import { JANELA_DE_PRONTIDAO_MS, PRONTO_APOS_SPAWN_MS, QUIETO_ANTES_DE_DIGITAR_MS } from "./constantes.js";

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
  s.itemEmVoo = s.filaQuandoIdle.shift()!;
  const texto = s.itemEmVoo.texto;
  s.soltandoFila = true;
  log.info(
    s.a("entrada"),
    `soltando os ${texto.length} caracteres enfileirados (agente ocioso; restam ${s.filaQuandoIdle.length} na fila)`,
  );
  s.digitarEEnviar(texto)
    .catch((err) =>
      log.erro(
        s.a("entrada"),
        `falhei ao digitar o texto enfileirado: ${err instanceof Error ? err.message : err}`,
        "reenviar pelo POST /api/agents/:id/input",
      ),
    )
    .finally(() => {
      s.soltandoFila = false;
      s.itemEmVoo = null;
      espelharFila(s);
    });
}

/** Grava no disco o que ainda não foi entregue: o item em digitação e a fila. */
export function espelharFila(s: Sessao): void {
  const pendentes = s.itemEmVoo ? [s.itemEmVoo, ...s.filaQuandoIdle] : s.filaQuandoIdle;
  gravarFila(s.arquivoDaFila, pendentes, s.a("fila"));
}
