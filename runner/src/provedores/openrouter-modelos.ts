// Lista de modelos do OpenRouter para o provedor OpenCode (que só abre cards).
//
// Porta para TypeScript do trecho "OpenRouter" de scripts/provedores/catalogo.mjs, que é a
// referência: a regra de filtro, o formato do cache e a validade têm que ser os MESMOS nos
// dois lados. A lista vem da API pública do OpenRouter (sem chave), fica num cache em disco
// e, sem cache, vale a lista de reserva do catálogo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";

export const URL_MODELOS_OPENROUTER = "https://openrouter.ai/api/v1/models";
export const VALIDADE_CACHE_OPENROUTER_MS = 12 * 60 * 60 * 1000;
const LIMITE_RESPOSTA_OPENROUTER = 8 * 1024 * 1024;

export interface ModeloOpenRouter {
  id: string;
  nome: string;
  apelidos: string[];
  entradaPorMilhao: number | null;
  saidaPorMilhao: number | null;
}

export interface CacheOpenRouter {
  buscadoEm: string;
  modelos: ModeloOpenRouter[];
}

export type ResultadoAtualizacao = { ok: true; quantos: number } | { ok: false; erro: string };

export function arquivoCacheOpenRouter(): string {
  return process.env.DGCLAW_OPENROUTER_CACHE?.trim() || path.join(os.homedir(), ".cache", "dgclaw", "openrouter-models.json");
}

interface ModeloBruto {
  id?: unknown;
  name?: unknown;
  architecture?: { output_modalities?: string[] };
  supported_parameters?: string[];
  pricing?: { prompt?: unknown; completion?: unknown };
}

/** Do JSON da API para o que o DG Claw guarda: só modelos de texto que aceitam ferramentas
 *  (o OpenCode trabalha por ferramentas) e sem as variantes ":batch". Preço por milhão de tokens. */
export function filtrarModelosOpenRouter(json: unknown): ModeloOpenRouter[] {
  const dados = Array.isArray((json as { data?: unknown })?.data) ? ((json as { data: ModeloBruto[] }).data) : [];
  const porMilhao = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : null;
  };
  const saida: ModeloOpenRouter[] = [];
  for (const m of dados) {
    if (!m || typeof m.id !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(m.id)) continue;
    if (m.id.endsWith(":batch")) continue;
    if (!(m.architecture?.output_modalities ?? ["text"]).includes("text")) continue;
    if (Array.isArray(m.supported_parameters) && !m.supported_parameters.includes("tools")) continue;
    saida.push({
      id: m.id,
      nome: typeof m.name === "string" && m.name.trim() ? m.name.trim() : m.id,
      apelidos: [],
      entradaPorMilhao: porMilhao(m.pricing?.prompt),
      saidaPorMilhao: porMilhao(m.pricing?.completion),
    });
  }
  return saida;
}

export function lerCacheOpenRouter(arquivo: string = arquivoCacheOpenRouter()): CacheOpenRouter | null {
  try {
    const c = JSON.parse(fs.readFileSync(arquivo, "utf8")) as CacheOpenRouter;
    if (Array.isArray(c.modelos) && c.modelos.length) return c;
  } catch {
    /* sem cache legível: vale a lista de reserva do catálogo, que é o comportamento desenhado */
  }
  return null;
}

export function cacheOpenRouterVelho(arquivo: string = arquivoCacheOpenRouter(), agora: number = Date.now()): boolean {
  const c = lerCacheOpenRouter(arquivo);
  const quando = c ? Date.parse(c.buscadoEm) : NaN;
  return !Number.isFinite(quando) || agora - quando > VALIDADE_CACHE_OPENROUTER_MS;
}

export interface OpcoesDeAtualizacao {
  arquivo?: string;
  buscar?: typeof fetch;
  url?: string;
  prazoMs?: number;
}

/** Busca a lista pública (sem chave) e grava o cache de forma atômica. Nunca lança: devolve
 *  { ok, quantos } ou { ok:false, erro } com o motivo em português, e o cache antigo segue valendo. */
export async function atualizarCacheOpenRouter(o: OpcoesDeAtualizacao = {}): Promise<ResultadoAtualizacao> {
  const arquivo = o.arquivo ?? arquivoCacheOpenRouter();
  const buscar = o.buscar ?? globalThis.fetch;
  const url = o.url ?? URL_MODELOS_OPENROUTER;
  const prazoMs = o.prazoMs ?? 8000;
  try {
    const resp = await buscar(url, { signal: AbortSignal.timeout(prazoMs), headers: { accept: "application/json" } });
    if (!resp.ok) return { ok: false, erro: `o OpenRouter respondeu ${resp.status} ao pedir a lista de modelos` };
    const texto = await resp.text();
    if (texto.length > LIMITE_RESPOSTA_OPENROUTER) {
      return { ok: false, erro: "a lista de modelos do OpenRouter veio grande demais; mantive a anterior" };
    }
    const lista = filtrarModelosOpenRouter(JSON.parse(texto));
    if (!lista.length) {
      return { ok: false, erro: "a lista de modelos do OpenRouter veio vazia ou em formato novo; mantive a anterior" };
    }
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = `${arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ buscadoEm: new Date().toISOString(), modelos: lista }));
    fs.renameSync(tmp, arquivo);
    return { ok: true, quantos: lista.length };
  } catch (err) {
    return {
      ok: false,
      erro: `não consegui buscar a lista de modelos do OpenRouter (${err instanceof Error ? err.message : err}); vale a lista guardada ou a de reserva`,
    };
  }
}

/** Melhor esforço: se o cache está velho, busca a lista nova; se falhar, avisa no log e segue com o cache ou a reserva. */
export async function garantirCacheOpenRouter(area: string, o: OpcoesDeAtualizacao = {}): Promise<void> {
  if (!cacheOpenRouterVelho(o.arquivo)) return;
  const r = await atualizarCacheOpenRouter(o);
  if (!r.ok) log.aviso(area, `${r.erro}. O que fazer: nada, a lista guardada (ou a de reserva do catálogo) continua valendo`);
}
