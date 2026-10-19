// O medidor de uso da assinatura: quanto da janela de 5 horas e da semana já foi gasto.
//
// Duas fontes, sem rede e sem consultar a conta:
//   - Claude: o `statusLine` do Claude Code recebe, a cada atualização, um JSON com
//     `rate_limits.five_hour` e `rate_limits.seven_day`. O handler (uso-handler-source.ts)
//     manda só esse pedaço para cá.
//   - Codex: o rollout traz, em cada evento `token_count`, o objeto `rate_limits` com
//     `primary` e `secondary`. A janela é classificada pela duração, e não pela posição.
//
// O formato do statusline e a classificação das janelas por duração se inspiram no
// projeto Orca (MIT, Copyright (c) 2026 Lovecast Inc., https://github.com/stablyai/orca).
//
// Regra que vale para o arquivo todo: `null` quer dizer "não medido" e NUNCA vira 0.
// Valor inválido (não numérico, negativo, acima de 100) é descartado com aviso.
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

export interface JanelaDeUso {
  usado_pct: number;
  /** Quando a janela zera, em ISO 8601 (UTC). */
  zera_em: string;
}
export type Janela = JanelaDeUso | null;

export type ProvedorDeUso = "claude" | "codex";
export type FonteDeUso = "statusline" | "rollout";

export interface Uso {
  provedor: ProvedorDeUso;
  sessao_5h: Janela;
  semanal: Janela;
  plano: string | null;
  /** Quando o número foi medido (ISO). Null quando nunca houve medição. */
  medido_em: string | null;
  fonte: FonteDeUso | null;
}

/** O que um normalizador entende de uma leitura: só as janelas (e o plano, no Codex). */
export interface Leitura {
  sessao_5h: Janela;
  semanal: Janela;
  plano: string | null;
}

/** A janela como a rota entrega: com a marca de que o horário de zerar já passou. */
export type JanelaNaResposta = (JanelaDeUso & { vencida: boolean }) | null;
export type UsoNaResposta = Omit<Uso, "sessao_5h" | "semanal"> & {
  sessao_5h: JanelaNaResposta;
  semanal: JanelaNaResposta;
};

export const MOTIVO_SEM_MEDICAO =
  "Ainda não houve resposta desde que o medidor foi instalado; o número aparece depois da próxima resposta do agente.";

type Avisar = (mensagem: string) => void;
const avisarNoLog: Avisar = (m) => log.aviso("uso", m);

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Percentual válido (0 a 100) ou null. Texto numérico ("42.5") é aceito. */
export function percentualValido(v: unknown, onde: string, avisar: Avisar = avisarNoLog): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    avisar(`percentual inválido em ${onde}: ${JSON.stringify(v)} (esperado um número de 0 a 100); descartei e deixei "não medido"`);
    return null;
  }
  return n;
}

/** ISO de um instante em ms, ou null se o Date não aceita o número (acima de 8,64e15 ms o
 *  toISOString lança RangeError; revisão adversarial do PR #58). */
function isoOuNull(ms: number): string | null {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Horário em ISO a partir de epoch em segundos, epoch em ms (heurística: > 1e10) ou texto ISO. */
export function instanteEmIso(v: unknown, onde: string, avisar: Avisar = avisarNoLog): string | null {
  if (v === null || v === undefined) return null;
  let ms = NaN;
  if (typeof v === "number") ms = v > 1e10 ? v : v * 1000;
  else if (typeof v === "string" && v.trim() !== "") {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      ms = n > 1e10 ? n : n * 1000;
    } else ms = Date.parse(t);
  }
  const iso = Number.isFinite(ms) && ms > 0 ? isoOuNull(ms) : null;
  if (iso === null) {
    avisar(`horário de zerar inválido em ${onde}: ${JSON.stringify(v)} (esperado epoch em segundos ou ms, ou data ISO); descartei a janela`);
    return null;
  }
  return iso;
}

function janelaDoStatusline(bruta: unknown, nome: string, avisar: Avisar): Janela {
  if (!ehObjeto(bruta)) return null;
  const pct = percentualValido(bruta.used_percentage ?? bruta.utilization, `rate_limits.${nome}`, avisar);
  const zera = instanteEmIso(bruta.resets_at, `rate_limits.${nome}.resets_at`, avisar);
  // Percentual sem horário não serve: a tela não saberia dizer quando zera nem se já venceu.
  if (pct === null || zera === null) return null;
  return { usado_pct: pct, zera_em: zera };
}

/** Lê o JSON do statusline do Claude Code (ou só o `{rate_limits}` que o handler manda).
 *  Devolve null quando não há nenhuma janela medida: a leitura é então ignorada. */
export function deStatusline(json: unknown, avisar: Avisar = avisarNoLog): Leitura | null {
  if (!ehObjeto(json) || !ehObjeto(json.rate_limits)) return null;
  const rl = json.rate_limits;
  const sessao_5h = janelaDoStatusline(rl.five_hour, "five_hour", avisar);
  const semanal = janelaDoStatusline(rl.seven_day, "seven_day", avisar);
  if (!sessao_5h && !semanal) return null;
  return { sessao_5h, semanal, plano: null };
}

/** Lê o `rate_limits` de um `token_count` do rollout do Codex. `tsEvento` (ms) só entra nas
 *  versões antigas, que traziam `resets_in_seconds` em vez de `resets_at`. */
export function deRolloutRateLimits(obj: unknown, tsEvento: number, avisar: Avisar = avisarNoLog): Leitura | null {
  if (!ehObjeto(obj)) return null;
  let sessao_5h: Janela = null;
  let semanal: Janela = null;
  for (const nome of ["primary", "secondary"] as const) {
    const j = obj[nome];
    if (!ehObjeto(j)) continue;
    const pct = percentualValido(j.used_percent, `rate_limits.${nome}.used_percent`, avisar);
    const minutos = typeof j.window_minutes === "number" && Number.isFinite(j.window_minutes) ? j.window_minutes : null;
    let zera: string | null = null;
    if (j.resets_at !== undefined && j.resets_at !== null) {
      zera = instanteEmIso(j.resets_at, `rate_limits.${nome}.resets_at`, avisar);
    } else if (typeof j.resets_in_seconds === "number" && Number.isFinite(j.resets_in_seconds) && Number.isFinite(tsEvento)) {
      zera = isoOuNull(tsEvento + j.resets_in_seconds * 1000);
      if (zera === null) avisar(`rate_limits.${nome}.resets_in_seconds fora do intervalo de datas: ${j.resets_in_seconds}; descartei a janela`);
    }
    if (pct === null || zera === null) continue;
    if (minutos === null) {
      avisar(`a janela ${nome} do Codex veio sem window_minutes; sem a duração não sei se é a de 5 horas ou a semanal, então a descartei`);
      continue;
    }
    const janela: JanelaDeUso = { usado_pct: pct, zera_em: zera };
    if (minutos <= 360) sessao_5h = janela;
    else if (minutos >= 1440) semanal = janela;
    else avisar(`a janela ${nome} do Codex tem ${minutos} minutos, que não é nem a de 5 horas nem a semanal; descartei`);
  }
  if (!sessao_5h && !semanal) return null;
  const plano = typeof obj.plan_type === "string" && obj.plan_type.trim() ? obj.plan_type.trim().slice(0, 40) : null;
  return { sessao_5h, semanal, plano };
}

/** Uma linha do rollout que traz `rate_limits` (event_msg token_count), com o horário do evento. */
export function usoDaLinhaDoRollout(registro: unknown, avisar: Avisar = avisarNoLog): { leitura: Leitura; em: number } | null {
  if (!ehObjeto(registro) || registro.type !== "event_msg") return null;
  const p = registro.payload;
  if (!ehObjeto(p) || p.type !== "token_count" || !ehObjeto(p.rate_limits)) return null;
  const em = Date.parse(typeof registro.timestamp === "string" ? registro.timestamp : "");
  if (!Number.isFinite(em)) return null;
  const leitura = deRolloutRateLimits(p.rate_limits, em, avisar);
  return leitura ? { leitura, em } : null;
}

function usoVazio(provedor: ProvedorDeUso): Uso {
  return { provedor, sessao_5h: null, semanal: null, plano: null, medido_em: null, fonte: null };
}

function janelaDoDisco(v: unknown): Janela {
  if (!ehObjeto(v)) return null;
  const pct = typeof v.usado_pct === "number" && v.usado_pct >= 0 && v.usado_pct <= 100 ? v.usado_pct : null;
  const zera = typeof v.zera_em === "string" && Number.isFinite(Date.parse(v.zera_em)) ? v.zera_em : null;
  return pct !== null && zera !== null ? { usado_pct: pct, zera_em: zera } : null;
}

/**
 * Guarda o último uso de UMA sessão: em memória e em `uso.json` (modo 600, gravação atômica),
 * para o número sobreviver a um reinício do runner. Uma leitura nova substitui as duas janelas
 * de uma vez: janela que a leitura não traz volta a "não medido", em vez de ficar com um número
 * velho carimbado com a hora de agora.
 */
export class MedidorDeUso {
  private uso: Uso | null = null;

  constructor(
    private readonly arquivo: string,
    private readonly agora: () => number = Date.now,
    private readonly assunto = "uso",
  ) {
    this.carregar();
  }

  private carregar(): void {
    let cru: string;
    try {
      cru = fs.readFileSync(this.arquivo, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.erro(
          this.assunto,
          `não consegui ler ${this.arquivo}: ${err instanceof Error ? err.message : err}`,
          "conferir a permissão do arquivo; o medidor recomeça vazio e o número volta na próxima resposta do agente",
        );
      }
      return;
    }
    try {
      const o = JSON.parse(cru) as unknown;
      if (!ehObjeto(o) || (o.provedor !== "claude" && o.provedor !== "codex")) throw new Error("falta o campo provedor (claude ou codex)");
      this.uso = {
        provedor: o.provedor,
        sessao_5h: janelaDoDisco(o.sessao_5h),
        semanal: janelaDoDisco(o.semanal),
        plano: typeof o.plano === "string" ? o.plano : null,
        medido_em: typeof o.medido_em === "string" && Number.isFinite(Date.parse(o.medido_em)) ? o.medido_em : null,
        fonte: o.fonte === "statusline" || o.fonte === "rollout" ? o.fonte : null,
      };
    } catch (err) {
      log.erro(
        this.assunto,
        `${this.arquivo} está ilegível (${err instanceof Error ? err.message : err})`,
        "apagar o arquivo uso.json; o medidor recomeça vazio e o número volta na próxima resposta do agente",
      );
    }
  }

  /** O uso guardado para o provedor vigente. Medição de outro provedor (o dono trocou de Claude
   *  para Codex) não vale: seria o número de outra conta. */
  atual(provedor: ProvedorDeUso): Uso {
    return this.uso && this.uso.provedor === provedor ? { ...this.uso } : usoVazio(provedor);
  }

  /** Aceita uma leitura. `emMs` é o horário da medição (o do evento, no Codex); leitura mais
   *  antiga que a guardada é ignorada. Devolve true quando guardou. */
  registrar(provedor: ProvedorDeUso, leitura: Leitura, fonte: FonteDeUso, emMs: number = this.agora()): boolean {
    const guardado = this.uso && this.uso.provedor === provedor ? this.uso : null;
    if (guardado?.medido_em && Date.parse(guardado.medido_em) > emMs) return false;
    this.uso = {
      provedor,
      sessao_5h: leitura.sessao_5h,
      semanal: leitura.semanal,
      plano: leitura.plano ?? guardado?.plano ?? null,
      medido_em: isoOuNull(emMs) ?? new Date(this.agora()).toISOString(),
      fonte,
    };
    this.gravar();
    return true;
  }

  private gravar(): void {
    const tmp = `${this.arquivo}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.uso, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.arquivo);
    } catch (err) {
      log.erro(
        this.assunto,
        `não consegui gravar ${this.arquivo}: ${err instanceof Error ? err.message : err}`,
        `conferir permissão de escrita em ${path.dirname(this.arquivo)}; o número continua em memória, mas se perde ao reiniciar o runner`,
      );
    }
  }
}

/** O uso como a rota entrega: janela com horário vencido continua com o valor velho, marcada
 *  `vencida: true`, e a tela decide não mostrá-lo como atual. */
export function paraResposta(uso: Uso, agora: number): UsoNaResposta {
  const marcar = (j: Janela): JanelaNaResposta => (j ? { ...j, vencida: Date.parse(j.zera_em) <= agora } : null);
  return { ...uso, sessao_5h: marcar(uso.sessao_5h), semanal: marcar(uso.semanal) };
}
