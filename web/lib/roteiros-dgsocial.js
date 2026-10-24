'use strict';
// Conector opcional do modo roteiro com o DG Social. Contrato em docs/MODO-ROTEIRO.md.
// Desligado quando falta URL ou chave. Toda falha vira um Error com `status` HTTP (502 quando o DG Social
// não responde ou recusa; 404 quando o conteúdo não existe lá) e uma frase com a causa e o que fazer.
// A chave nunca entra em mensagem nem em log.

const TIMEOUT_MS = 8000;
const CACHE_MS = 10000;
const LOG_REPETIDO_MS = 60000;

// Fase do card no DG Social -> estado do roteiro. Ideia, pesquisa e coleta ainda não têm roteiro.
const ESTADO_DA_FASE = {
  aprovada: 'em_ajuste',
  roteiro: 'aguardando_aprovacao',
  assets: 'aprovado',
  prontos: 'aprovado',
  render: 'aprovado',
  publicar: 'aprovado',
};

function criarConectorDgSocial(opcoes) {
  const o = opcoes || {};
  const base = String(o.url || '').trim().replace(/\/+$/, '');
  const chave = String(o.chave || '').trim();
  const log = o.log || (() => {});
  const relogio = o.agora || (() => Date.now());
  const agoraMs = () => { const a = relogio(); return a instanceof Date ? a.getTime() : Number(a); };
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const linkBase = String(o.link || base).trim().replace(/\/+$/, '');
  const usaFetch = o.fetch || fetch;
  const ligado = Boolean(base && chave);

  let cacheFases = null;                 // { ate, itens }
  const cacheTexto = new Map();          // slug -> { ate, texto, artefato }
  const ultimaFalha = new Map();         // mensagem -> instante do último log

  function logaFalha(msg) {
    const t = agoraMs();
    const antes = ultimaFalha.get(msg);
    if (antes !== undefined && t - antes < LOG_REPETIDO_MS) return;
    ultimaFalha.set(msg, t);
    if (ultimaFalha.size > 200) ultimaFalha.clear();
    log('erro', msg);
  }

  function falha(status, msg) {
    logaFalha(msg);
    const e = new Error(msg);
    e.status = status;
    return e;
  }

  /** Chama o DG Social. Devolve o `data` do envelope { ok, data }; lança erro com causa se não for ok. */
  async function chamar(metodo, caminho, corpo, { aceita404 } = {}) {
    const url = base + caminho;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await usaFetch(url, {
        method: metodo,
        headers: Object.assign({ Authorization: `Bearer ${chave}`, Accept: 'application/json' }, corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const motivo = e && e.name === 'AbortError' ? `não respondeu em ${Math.round(timeoutMs / 1000)} s` : `não abriu a conexão (${(e && e.cause && e.cause.code) || e.message})`;
      throw falha(502, `O DG Social ${motivo}: ${metodo} ${url}. Confira se o DG Social está no ar e se DGCLAW_ROTEIROS_DGSOCIAL_URL está certa; o roteiro continua guardado aqui.`);
    }
    let texto;
    try { texto = await r.text(); } catch (e) {
      clearTimeout(timer);
      throw falha(502, `A resposta do DG Social foi cortada (${e.message}): ${metodo} ${url}. Tente de novo em instantes.`);
    }
    clearTimeout(timer);
    let json = null;
    try { json = JSON.parse(texto); } catch (_) { /* resposta que não é JSON é tratada abaixo */ }
    if (r.ok && json && json.ok !== false) return json.data;
    const detalhe = json && json.error ? String(json.error).slice(0, 300) : texto.slice(0, 160).replace(/\s+/g, ' ');
    if (r.status === 404 && aceita404) { const e = new Error(detalhe); e.status = 404; e.naoEncontrado = true; throw e; }
    if (r.status === 401 || r.status === 403) {
      throw falha(502, `O DG Social recusou a chave (HTTP ${r.status}) em ${metodo} ${url}. Confira DGCLAW_ROTEIROS_DGSOCIAL_CHAVE.`);
    }
    if (r.status === 404) throw falha(404, `O DG Social respondeu 404 em ${metodo} ${url}: ${detalhe}. Confira se o conteúdo ainda existe lá.`);
    throw falha(502, `O DG Social respondeu HTTP ${r.status} em ${metodo} ${url}: ${detalhe || 'sem detalhe'}. Tente de novo; se continuar, veja o log do DG Social.`);
  }

  /** Itens do DG Social que já podem ter roteiro, no formato que o módulo usa. Cache de 10 s. */
  async function listar() {
    const t = agoraMs();
    if (cacheFases && cacheFases.ate > t) return cacheFases.itens;
    const data = await chamar('GET', '/api/v1/content/fases');
    const fases = data && Array.isArray(data.fases) ? data.fases : null;
    if (!fases) throw falha(502, `O DG Social respondeu em ${base}/api/v1/content/fases, mas sem a lista "fases". A versão dele pode ser incompatível; atualize o DG Social ou o DG Claw.`);
    const itens = [];
    for (const f of fases) {
      for (const it of (f.items || [])) {
        const fase = it.fase || f.key;
        const estado = ESTADO_DA_FASE[fase];
        if (!estado || !it.folder || !it.slug) continue;
        itens.push({
          slug: it.slug, titulo: it.title || it.slug, fase, estado,
          atualizado_em: it.updatedAt || null, criado_em: it.createdAt || null, canal: it.canal || null,
          link: `${linkBase}/content/v2?slug=${encodeURIComponent(it.slug)}`,
        });
      }
    }
    cacheFases = { ate: t + CACHE_MS, itens };
    return itens;
  }

  async function item(slug) {
    return (await listar()).find((i) => i.slug === slug) || null;
  }

  /** Texto atual do roteiro. Arquivo ainda não escrito (404) vale texto vazio. Cache de 10 s. */
  async function lerTexto(slug) {
    const t = agoraMs();
    const c = cacheTexto.get(slug);
    if (c && c.ate > t) return c.texto;
    const sl = encodeURIComponent(slug);
    let detalhe;
    try { detalhe = await chamar('GET', `/api/v1/content/${sl}`, undefined, { aceita404: true }); } catch (e) {
      if (e.naoEncontrado) { const err = new Error(`O DG Social não tem o conteúdo "${slug}". Ele pode ter sido apagado lá; confira a lista de roteiros.`); err.status = 404; throw err; }
      throw e;
    }
    const etapa = detalhe && Array.isArray(detalhe.stages) ? detalhe.stages.find((s) => s.key === 'roteiro') : null;
    const artefato = (etapa && etapa.artifactPath) || 'roteiro.md';
    let texto = '';
    try {
      const arq = await chamar('GET', `/api/v1/content/${sl}/files?path=${encodeURIComponent(artefato)}`, undefined, { aceita404: true });
      texto = arq && typeof arq.text === 'string' ? arq.text : '';
    } catch (e) {
      if (!e.naoEncontrado) throw e;
    }
    cacheTexto.set(slug, { ate: t + CACHE_MS, texto });
    return texto;
  }

  async function gravar(slug, texto, actor) {
    await chamar('POST', `/api/v1/content/${encodeURIComponent(slug)}/roteiro`, { text: texto, actor });
    cacheTexto.set(slug, { ate: agoraMs() + CACHE_MS, texto });
    cacheFases = null;
  }

  async function aprovar(slug) {
    const data = await chamar('POST', `/api/v1/content/${encodeURIComponent(slug)}/aprovar-roteiro`, { actor: 'danilo' });
    cacheFases = null;
    return data && data.session !== undefined ? data.session : null;
  }

  return { ligado, listar, item, lerTexto, gravar, aprovar, link: (slug) => `${linkBase}/content/v2?slug=${encodeURIComponent(slug)}` };
}

module.exports = { criarConectorDgSocial, ESTADO_DA_FASE };
