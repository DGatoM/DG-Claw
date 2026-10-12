// Quantas conversas acordadas cabem na máquina deste agente.
//
// O runner roda dentro de um container com limite de memória. Cada `claude`
// acordado custa RAM, e passar do limite não dá erro bonito: o kernel mata o
// processo que estiver maior, que pode ser a conversa do cliente. Por isso as
// sessões paralelas só acordam se couberem, e a principal nunca é barrada.
import fs from "node:fs";
import { CAPACIDADE_PADRAO, type CapacidadeDescrita } from "./config-runner.js";
import { log } from "./logger.js";

const GB = 1024 ** 3;
const CGROUP_MAX = "/sys/fs/cgroup/memory.max";
const CGROUP_CURRENT = "/sys/fs/cgroup/memory.current";
const MEMINFO = "/proc/meminfo";

export interface LeituraDeMemoria {
  fonte: "cgroup" | "host";
  limiteBytes?: number;
  usoBytes?: number;
  disponivelBytes?: number;
}

export interface Capacidade extends LeituraDeMemoria {
  reservaBytes: number;
  porSessaoBytes: number;
  teto: number;
  acordadas: number;
  folga: number;
  pertoDoTeto: boolean;
  /** Cabe mais uma sessão paralela acordada? */
  podeAcordar: boolean;
}

function lerNumero(arquivo: string): number | null {
  try {
    const t = fs.readFileSync(arquivo, "utf8").trim();
    if (!/^\d+$/.test(t)) return null;
    return Number(t);
  } catch {
    return null;
  }
}

/** Lê a memória disponível para este processo. Cgroup quando o container tem
 *  limite; senão o MemAvailable do host (que já desconta quem está acordado). */
export function lerMemoria(): LeituraDeMemoria {
  const forcado = process.env.RUNNER_CAPACIDADE_LIMITE_BYTES?.trim();
  if (forcado) {
    const limite = Number(forcado);
    if (Number.isFinite(limite) && limite > 0) {
      return { fonte: "cgroup", limiteBytes: limite, usoBytes: lerNumero(CGROUP_CURRENT) ?? undefined };
    }
    log.erro(
      "capacidade",
      `RUNNER_CAPACIDADE_LIMITE_BYTES="${forcado}" não é um número positivo`,
      "essa variável é só para ensaio; remover do ambiente ou colocar o limite em bytes. Ignorada: usando a leitura real",
    );
  }
  const limite = lerNumero(CGROUP_MAX);
  if (limite !== null) {
    return { fonte: "cgroup", limiteBytes: limite, usoBytes: lerNumero(CGROUP_CURRENT) ?? undefined };
  }
  try {
    const m = fs.readFileSync(MEMINFO, "utf8").match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (m) return { fonte: "host", disponivelBytes: Number(m[1]) * 1024 };
    throw new Error("linha MemAvailable não encontrada");
  } catch (err) {
    // Sem leitura nenhuma não dá para barrar ninguém com base em número
    // inventado. Devolve zero disponível: o teto cai para 1 (só a principal) e o
    // log diz por quê, que é o lado seguro.
    log.erro(
      "capacidade",
      `não consegui ler a memória de ${MEMINFO}: ${err instanceof Error ? err.message : err}`,
      "conferir se /proc está montado neste container. Enquanto isso o teto fica em 1 e nenhuma sessão paralela acorda",
    );
    return { fonte: "host", disponivelBytes: 0 };
  }
}

export function calcularCapacidade(cfg: CapacidadeDescrita | undefined, acordadas: number): Capacidade {
  const mem = lerMemoria();
  const porSessaoBytes = (cfg?.gbPorSessao ?? CAPACIDADE_PADRAO.gbPorSessao) * GB;
  const aviso = cfg?.avisoFaltando ?? CAPACIDADE_PADRAO.avisoFaltando;
  let reservaBytes: number;
  let teto: number;
  if (mem.fonte === "cgroup") {
    const limite = mem.limiteBytes!;
    reservaBytes = cfg?.reservaGb !== undefined ? cfg.reservaGb * GB : limite * 0.25;
    teto = Math.max(1, Math.floor((limite - reservaBytes) / porSessaoBytes));
  } else {
    reservaBytes = (cfg?.reservaGb ?? 2) * GB;
    teto = Math.max(1, acordadas + Math.floor((mem.disponivelBytes! - reservaBytes) / porSessaoBytes));
  }
  const folga = teto - acordadas;
  return {
    ...mem,
    reservaBytes,
    porSessaoBytes,
    teto,
    acordadas,
    folga,
    pertoDoTeto: folga <= aviso,
    podeAcordar: acordadas + 1 <= teto,
  };
}

const gb = (b: number | undefined): string => (b === undefined ? "?" : `${(b / GB).toFixed(1)} GB`);

/** Os números de memória, em português, para a mensagem de recusa e o log. */
export function descreverMemoria(c: Capacidade): string {
  if (c.fonte === "cgroup") {
    return (
      `limite do container ${gb(c.limiteBytes)}` +
      (c.usoBytes !== undefined ? `, em uso ${gb(c.usoBytes)}` : "") +
      `, reserva ${gb(c.reservaBytes)}, ${gb(c.porSessaoBytes)} por conversa`
    );
  }
  return `memória disponível na máquina ${gb(c.disponivelBytes)}, reserva ${gb(c.reservaBytes)}, ${gb(c.porSessaoBytes)} por conversa`;
}
