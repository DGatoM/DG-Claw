// Lista de modelos do OpenRouter para o provedor OpenCode (que só abre cards).
//
// Porta para TypeScript do trecho "OpenRouter" de scripts/provedores/catalogo.mjs, que é a
// referência: a regra de filtro, o formato do cache e a validade têm que ser os MESMOS nos
// dois lados. A lista vem da API pública do OpenRouter (sem chave), fica num cache em disco
// e, sem cache, vale a lista de reserva do catálogo.
import { randomBytes } from "node:crypto";
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

const FORMATO_ID_OPENROUTER = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

/** Um registro do cache em disco tem o formato que a própria atualização grava (id, nome, preços número ou null). */
function registroValido(m: unknown): m is ModeloOpenRouter {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  const preco = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  return (
    typeof r.id === "string" &&
    FORMATO_ID_OPENROUTER.test(r.id) &&
    typeof r.nome === "string" &&
    r.nome.length > 0 &&
    r.nome.length <= 300 &&
    preco(r.entradaPorMilhao) &&
    preco(r.saidaPorMilhao)
  );
}

/**
 * O cache fica numa pasta que o agente consegue escrever, então o arquivo pode não ser o que parece: um link
 * para outro arquivo, ou um FIFO que travaria a leitura síncrona (e com ela o runner inteiro). Abre sem seguir
 * link (O_NOFOLLOW) e sem bloquear (O_NONBLOCK), e confere pelo descritor que é um arquivo comum de tamanho limitado.
 */
export function lerCacheOpenRouter(arquivo: string = arquivoCacheOpenRouter()): CacheOpenRouter | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LIMITE_RESPOSTA_OPENROUTER) return null;
    const c = JSON.parse(fs.readFileSync(fd, "utf8")) as CacheOpenRouter;
    // O agente escreve nessa pasta: conteúdo fora do esquema (registro nulo, id estranho, preço que não é número)
    // inteiro é descartado e vale a lista de reserva, em vez de derrubar quem resolve a escolha.
    if (c && typeof c === "object" && typeof c.buscadoEm === "string" && Array.isArray(c.modelos) && c.modelos.length && c.modelos.every(registroValido)) {
      return { buscadoEm: c.buscadoEm, modelos: c.modelos.map((m) => ({ ...m, apelidos: [] })) };
    }
  } catch {
    /* sem cache legível (ou que não é arquivo comum): vale a lista de reserva do catálogo, que é o comportamento desenhado */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* descritor já fechado */
      }
    }
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

/** Lê o corpo contando os bytes DURANTE a leitura: passou do teto, cancela e para (sem guardar tudo antes de conferir). */
async function lerCorpoLimitado(resp: Response): Promise<{ texto: string } | { grande: true }> {
  const declarado = Number(resp.headers?.get?.("content-length"));
  if (Number.isFinite(declarado) && declarado > LIMITE_RESPOSTA_OPENROUTER) {
    await resp.body?.cancel().catch(() => undefined);
    return { grande: true };
  }
  if (!resp.body || typeof resp.body.getReader !== "function") {
    const texto = await resp.text();
    return Buffer.byteLength(texto) > LIMITE_RESPOSTA_OPENROUTER ? { grande: true } : { texto };
  }
  const leitor = resp.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITE_RESPOSTA_OPENROUTER) {
      await leitor.cancel().catch(() => undefined);
      return { grande: true };
    }
    pedacos.push(value);
  }
  return { texto: Buffer.concat(pedacos).toString("utf8") };
}

const emCurso = new Map<string, Promise<ResultadoAtualizacao>>();

/** Busca a lista pública (sem chave) e grava o cache de forma atômica. Nunca lança: devolve
 *  { ok, quantos } ou { ok:false, erro } com o motivo em português, e o cache antigo segue valendo.
 *  Uma atualização por vez por arquivo: quem chega no meio espera a que já está rodando. */
export function atualizarCacheOpenRouter(o: OpcoesDeAtualizacao = {}): Promise<ResultadoAtualizacao> {
  const arquivo = o.arquivo ?? arquivoCacheOpenRouter();
  const rodando = emCurso.get(arquivo);
  if (rodando) return rodando;
  const p = atualizarDeVerdade({ ...o, arquivo }).finally(() => emCurso.delete(arquivo));
  emCurso.set(arquivo, p);
  return p;
}

async function atualizarDeVerdade(o: OpcoesDeAtualizacao & { arquivo: string }): Promise<ResultadoAtualizacao> {
  const arquivo = o.arquivo;
  const buscar = o.buscar ?? globalThis.fetch;
  const url = o.url ?? URL_MODELOS_OPENROUTER;
  const prazoMs = o.prazoMs ?? 8000;
  let tmp: string | null = null;
  try {
    const resp = await buscar(url, { signal: AbortSignal.timeout(prazoMs), headers: { accept: "application/json" } });
    if (!resp.ok) return { ok: false, erro: `o OpenRouter respondeu ${resp.status} ao pedir a lista de modelos` };
    const corpo = await lerCorpoLimitado(resp);
    if ("grande" in corpo) {
      return { ok: false, erro: "a lista de modelos do OpenRouter veio grande demais; mantive a anterior" };
    }
    const lista = filtrarModelosOpenRouter(JSON.parse(corpo.texto));
    if (!lista.length) {
      return { ok: false, erro: "a lista de modelos do OpenRouter veio vazia ou em formato novo; mantive a anterior" };
    }
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    // Temporário com nome aleatório e abertura exclusiva ("wx" não segue link nem sobrescreve): um link plantado
    // no nome previsível não faz a gravação truncar outro arquivo.
    tmp = `${arquivo}.${randomBytes(8).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ buscadoEm: new Date().toISOString(), modelos: lista }), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, arquivo);
    tmp = null;
    return { ok: true, quantos: lista.length };
  } catch (err) {
    if (tmp) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* o temporário não existe mais */
      }
    }
    return {
      ok: false,
      erro: `não consegui buscar a lista de modelos do OpenRouter (${err instanceof Error ? err.message : err}); vale a lista guardada ou a de reserva`,
    };
  }
}

/** Depois de uma falha, só tenta de novo daqui a este tempo (a lista é opcional: a reserva do catálogo cobre). */
export const INTERVALO_APOS_FALHA_MS = 5 * 60 * 1000;
const ultimaFalha = new Map<string, number>();

/** Melhor esforço: se o cache está velho, busca a lista nova; se falhar, avisa no log e segue com o cache ou a reserva. */
export async function garantirCacheOpenRouter(area: string, o: OpcoesDeAtualizacao = {}): Promise<void> {
  const arquivo = o.arquivo ?? arquivoCacheOpenRouter();
  if (!cacheOpenRouterVelho(arquivo)) return;
  const falhouEm = ultimaFalha.get(arquivo);
  if (falhouEm !== undefined && Date.now() - falhouEm < INTERVALO_APOS_FALHA_MS) return;
  const r = await atualizarCacheOpenRouter({ ...o, arquivo });
  if (r.ok) {
    ultimaFalha.delete(arquivo);
  } else {
    ultimaFalha.set(arquivo, Date.now());
    log.aviso(area, `${r.erro}. O que fazer: nada, a lista guardada (ou a de reserva do catálogo) continua valendo; tento de novo em ${INTERVALO_APOS_FALHA_MS / 60000} min`);
  }
}

/** Esquece as falhas guardadas (só os testes). */
export function zerarFalhasDoOpenRouter(): void {
  ultimaFalha.clear();
}
