'use strict';
// Rotas /api/v1/logs (a seção Logs do Admin): só o dono, pela tela. Ver web/docs/LOGS.md.
//
// A API NÃO é liberada para agentes: não entra em caixa.permitir e `autorizado` recusa qualquer sessão
// que não seja a do dono no navegador. O texto de um log nasceu do que o agente leu e escreveu (páginas,
// e-mails, arquivos), por isso não é de confiança e não pode entrar no contexto de outro agente, nem do Admin.
// A trava de /p/<agente>/... (o painel não repassa estas rotas) fica no server.js.

const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');
const { RX_SLUG } = require('./registro');
const { criarLeitor, decodificaCursor, ErroEntrada, TIPOS, RX_ID_CURTO, RX_UUID } = require('./logs-leitor');

const BASE = '/api/v1/logs';
const MAX_BUSCAS = 2;

/** Só o dono, na sessão do navegador. Colaborador, caixa de agente e papel desconhecido ficam de fora. */
function autorizado(sessao) {
  return !!sessao && !sessao.via && sessao.papel === 'dono';
}

function parseData(texto, fimDoDia, nome) {
  const ruim = () => new ErroEntrada(400, `O parâmetro "${nome}" precisa ser uma data AAAA-MM-DD ou um horário ISO (ex.: 2026-11-08 ou 2026-11-08T14:30:00-03:00). Recebi: ${String(texto).slice(0, 40)}.`);
  const dia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (dia) {
    const y = Number(dia[1]); const m = Number(dia[2]); const d = Number(dia[3]);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw ruim();
    return fimDoDia ? new Date(y, m - 1, d + 1).getTime() - 1 : dt.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(texto)) {
    const t = Date.parse(texto);
    if (Number.isFinite(t)) return t;
  }
  throw ruim();
}

function numeroEntre(texto, nome, min, max, padrao) {
  if (texto == null || texto === '') return padrao;
  const n = Number(texto);
  if (!/^\d{1,6}$/.test(String(texto)) || n < min || n > max) {
    throw new ErroEntrada(400, `O parâmetro "${nome}" precisa ser um número inteiro entre ${min} e ${max}. Recebi: ${String(texto).slice(0, 40)}.`);
  }
  return n;
}

function filtrosDe(url) {
  const sp = url.searchParams;
  const f = { desde: null, ate: null, tipos: null, q: null, sessao: null };
  if (sp.get('desde')) f.desde = parseData(sp.get('desde'), false, 'desde');
  if (sp.get('ate')) f.ate = parseData(sp.get('ate'), true, 'ate');
  if (f.desde != null && f.ate != null && f.desde > f.ate) {
    throw new ErroEntrada(400, 'O parâmetro "desde" vem depois de "ate". Troque a ordem ou ajuste as datas.');
  }
  if (sp.get('tipo')) {
    const lista = sp.get('tipo').split(',').map((x) => x.trim()).filter(Boolean);
    const ruim = lista.find((x) => !TIPOS.includes(x));
    if (ruim !== undefined || !lista.length) {
      throw new ErroEntrada(400, `O parâmetro "tipo" aceita uma lista separada por vírgula com: ${TIPOS.join(', ')}. Recebi: ${sp.get('tipo').slice(0, 60)}.`);
    }
    f.tipos = new Set(lista);
  }
  if (sp.get('q')) {
    const q = sp.get('q');
    if (q.length > 200) throw new ErroEntrada(400, `O parâmetro "q" aceita até 200 caracteres. Recebi ${q.length}.`);
    f.q = q.trim() || null;
  }
  if (sp.get('sessao')) {
    const s = sp.get('sessao');
    if (!RX_ID_CURTO.test(s) && !RX_UUID.test(s)) {
      throw new ErroEntrada(400, `O parâmetro "sessao" precisa ser o id curto (12 caracteres hexadecimais) ou o uuid da sessão. Recebi: ${s.slice(0, 40)}.`);
    }
    f.sessao = s.toLowerCase();
  }
  return f;
}

function criarLogsRotas({ registro, log, agora, orcamento, arquivoDocs }) {
  const leitor = criarLeitor({ log, agora, orcamento });
  const docsPath = arquivoDocs || path.join(__dirname, '..', 'docs', 'LOGS.md');
  let buscasAtivas = 0;

  async function docs(res) {
    let texto;
    try { texto = await fs.promises.readFile(docsPath, 'utf8'); } catch (e) {
      log('erro', `Logs: não li ${docsPath} (${e.code || e.message}).`);
      return H.erroJson(res, 500, 'A documentação dos logs não está instalada neste servidor. Reinstale o DG Claw Web.');
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(texto);
    return undefined;
  }

  function agenteOuErro(res, bruto) {
    let slug;
    try { slug = decodeURIComponent(bruto); } catch (_) { slug = ''; }
    if (!RX_SLUG.test(slug)) { H.erroJson(res, 400, `O id de agente "${String(bruto).slice(0, 40)}" não vale. Veja GET ${BASE}/agentes.`); return null; }
    const ag = registro.obter(slug);
    if (!ag) { H.erroJson(res, 404, `Não existe agente com o id "${slug}". Veja GET ${BASE}/agentes.`); return null; }
    return ag;
  }

  async function listaAgentes(res) {
    const lista = [];
    for (const ag of registro.estado().agentes) {
      const r = await leitor.resumoDasFontes(ag);
      lista.push({ id: ag.slug, nome: ag.nome, tipo: ag.tipo, provedor: ag.provedor, fontes: r.fontes });
    }
    H.enviaJson(res, 200, { ok: true, agentes: lista });
  }

  /** Devolve true quando tratou o pedido. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para ver os logs. Faça login em /login.'); return true; }
    if (!autorizado(sessao)) {
      H.erroJson(res, 403, 'Os logs dos agentes são só do dono do DG Claw, pela tela Logs do Admin. Agentes e colaboradores não usam esta rota.');
      return true;
    }
    if (req.method !== 'GET') { H.erroJson(res, 405, `Use GET em ${p}. Os logs são só de leitura.`); return true; }
    const sub = p.slice(BASE.length);
    try {
      if (sub === '/docs.md') { await docs(res); return true; }
      if (falhaRegistro(res)) return true;
      if (sub === '/agentes') { await listaAgentes(res); return true; }
      const m = /^\/agentes\/([^/]+)\/(sessoes|eventos)$/.exec(sub);
      if (m) {
        const ag = agenteOuErro(res, m[1]);
        if (!ag) return true;
        const limite = numeroEntre(url.searchParams.get('limite'), 'limite', 1, 200, 50);
        const cursor = decodificaCursor(url.searchParams.get('cursor'));
        if (m[2] === 'sessoes') {
          const r = await leitor.sessoes(ag, { limite, cursor });
          H.enviaJson(res, 200, Object.assign({ ok: true, agente: ag.slug }, r));
          return true;
        }
        const f = filtrosDe(url);
        if (buscasAtivas >= MAX_BUSCAS) {
          H.erroJson(res, 429, 'Já há buscas de logs em andamento. Espere um instante e peça de novo.', { retryAfter: 1 }, { 'Retry-After': '1' });
          return true;
        }
        buscasAtivas++;
        try {
          const r = await leitor.eventos(ag, Object.assign(f, { limite, cursor }));
          H.enviaJson(res, 200, Object.assign({ ok: true, agente: ag.slug }, r));
        } finally { buscasAtivas--; }
        return true;
      }
    } catch (e) {
      if (e instanceof ErroEntrada) { H.erroJson(res, e.status, e.message); return true; }
      log('erro', `Logs: falha inesperada em GET ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui ler os logs. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe GET ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  function falhaRegistro(res) {
    const est = registro.estado();
    if (est.ok) return false;
    H.erroJson(res, 503, est.erro);
    return true;
  }

  return { rotas };
}

module.exports = { criarLogsRotas, autorizado };
