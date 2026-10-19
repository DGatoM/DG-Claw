'use strict';
// Modo foco: lista curta do que o dono quer fechar agora, uma por agente. O agente monta,
// o dono tica na tela. Estado em <dir>/<slug>.json (gravação atômica, modo 0600), com a
// lista, os contadores de id e os últimos 1000 eventos. Contrato em docs/MODO-FOCO.md.
const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');

const MAX_ITENS = 50;
const MAX_TEXTO = 300;
const MAX_TITULO = 80;
const TITULO_PADRAO = 'Modo foco';
const MAX_EVENTOS = 1000;
const EVENTOS_NO_RETRATO = 50;
const EVENTOS_POR_LEITURA = 200;
const MAX_CORPO = 256 * 1024;
const DOC = path.join(__dirname, '..', 'docs', 'MODO-FOCO.md');

class ErroFoco extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

const falta = (status, msg) => new ErroFoco(status, msg);

function normalizaTexto(v, ondeFalou) {
  if (typeof v !== 'string') throw falta(400, `${ondeFalou} precisa ser um texto. Recebi: ${v === null ? 'null' : typeof v}.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) throw falta(400, `${ondeFalou} não pode ficar vazio. Escreva de 1 a ${MAX_TEXTO} caracteres.`);
  if (t.length > MAX_TEXTO) throw falta(400, `${ondeFalou} tem ${t.length} caracteres e o máximo é ${MAX_TEXTO}. Encurte o texto.`);
  return t;
}

function normalizaTitulo(v) {
  if (typeof v !== 'string') throw falta(400, `"titulo" precisa ser um texto. Recebi: ${v === null ? 'null' : typeof v}.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TITULO) throw falta(400, `"titulo" tem ${t.length} caracteres e o máximo é ${MAX_TITULO}. Encurte o título.`);
  return t || TITULO_PADRAO;
}

function soCampos(obj, permitidos, onde) {
  for (const k of Object.keys(obj)) {
    if (!permitidos.includes(k)) throw falta(400, `Campo desconhecido "${k}" em ${onde}. Campos aceitos: ${permitidos.map(c => `"${c}"`).join(', ')}.`);
  }
}

function ehObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** ISO 8601 no fuso `tz`, com o deslocamento (ex.: 2026-10-16T10:12:03-03:00). */
function isoNoFuso(data, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(data)) p[x.type] = x.value;
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((comoUtc - Math.floor(data.getTime() / 1000) * 1000) / 60000);
  const sinal = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sinal}${hh}:${mm}`;
}

function criarFoco({ dir, tz, log, registro, gravaRetrato, push, quemChamou, agora }) {
  const relogio = agora || (() => new Date());
  const fuso = tz || 'UTC';
  const avisa = (msg) => { try { (log || H.logPadrao)('aviso', msg); } catch (_) { /* log nunca derruba */ } };

  const quem = quemChamou || ((sessao) => (sessao && sessao.via === 'caixa' && sessao.agente
    ? { tipo: 'agente', slug: sessao.agente }
    : { tipo: 'dono', usuario: sessao && sessao.usuario }));

  const arquivoDe = (slug) => path.join(dir, `${slug}.json`);
  const vazio = () => ({ versao_arquivo: 1, titulo: TITULO_PADRAO, itens: [], proximo_item_id: 1, versao: 0, atualizada_em: null, eventos: [], proximo_evento_id: 1 });

  function ler(slug) {
    const arq = arquivoDe(slug);
    let bruto;
    try { bruto = fs.readFileSync(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return vazio();
      throw falta(503, `Não consegui ler a lista de foco em ${arq}: ${e.message}. Confira as permissões da pasta e tente de novo.`);
    }
    try {
      const d = JSON.parse(bruto);
      if (!ehObjeto(d) || !Array.isArray(d.itens) || !Array.isArray(d.eventos)
        || !Number.isInteger(d.proximo_item_id) || !Number.isInteger(d.proximo_evento_id) || !Number.isInteger(d.versao)) {
        throw new Error('formato inesperado');
      }
      return d;
    } catch (e) {
      throw falta(503, `O arquivo da lista de foco ${arq} está inválido (${e.message}). Ele não foi alterado: preserve-o, confira o backup e só então apague ou conserte.`);
    }
  }

  function salvar(slug, d) {
    const arq = arquivoDe(slug);
    const tmp = `${arq}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
      fs.renameSync(tmp, arq);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* a falha que importa é a de cima */ }
      throw falta(503, `Não consegui gravar a lista de foco em ${arq}: ${e.message}. Confira espaço e permissões e tente de novo.`);
    }
  }

  function paraLista(slug, d) {
    const itens = d.itens.map((it, i) => ({
      id: it.id, texto: it.texto, feito: !!it.feito, feito_em: it.feito_em ?? null, feito_por: it.feito_por ?? null, ordem: i + 1,
    }));
    return {
      agente: slug, titulo: d.titulo || TITULO_PADRAO, itens,
      feitos: itens.filter(i => i.feito).length, total: itens.length,
      versao: d.versao, atualizada_em: d.atualizada_em ?? null,
    };
  }

  const lista = (slug) => paraLista(slug, ler(slug));
  const versao = (slug) => ler(slug).versao;

  function evento(d, slug, item_id, tipo, texto, por, em) {
    d.eventos.push({ id: d.proximo_evento_id++, agente: slug, item_id, tipo, texto, por, em });
    if (d.eventos.length > MAX_EVENTOS) d.eventos.splice(0, d.eventos.length - MAX_EVENTOS);
  }

  // ── operações (todas síncronas: ler, mudar e gravar sem intervalo para outro pedido) ──
  function novoItem(d, texto, feito, por, em) {
    return { id: d.proximo_item_id++, texto, feito: !!feito, feito_em: feito ? em : null, feito_por: feito ? por : null };
  }

  function opSubstituir(slug, corpo, por) {
    soCampos(corpo, ['titulo', 'itens'], 'PUT /api/v1/foco/<agente>');
    if (!Array.isArray(corpo.itens)) throw falta(400, 'O campo "itens" é obrigatório e precisa ser uma lista. Exemplo: {"itens": ["Revisar o contrato", {"texto": "Ligar pro Fernando", "feito": true}]}.');
    if (corpo.itens.length > MAX_ITENS) throw falta(400, `A lista tem ${corpo.itens.length} itens e o máximo é ${MAX_ITENS}. Corte os menos urgentes.`);
    const d = ler(slug);
    const titulo = corpo.titulo === undefined ? (d.titulo || TITULO_PADRAO) : normalizaTitulo(corpo.titulo);
    const em = isoNoFuso(relogio(), fuso);
    const itens = [];
    corpo.itens.forEach((x, i) => {
      const onde = `itens[${i}]`;
      if (typeof x === 'string') { itens.push(novoItem(d, normalizaTexto(x, onde), false, por, em)); return; }
      if (!ehObjeto(x)) throw falta(400, `${onde} precisa ser um texto ou um objeto {"texto", "feito"?}. Recebi: ${x === null ? 'null' : Array.isArray(x) ? 'lista' : typeof x}.`);
      soCampos(x, ['texto', 'feito'], onde);
      if (x.feito !== undefined && typeof x.feito !== 'boolean') throw falta(400, `${onde}.feito precisa ser true ou false.`);
      itens.push(novoItem(d, normalizaTexto(x.texto, `${onde}.texto`), x.feito === true, por, em));
    });
    d.titulo = titulo; d.itens = itens; d.versao += 1; d.atualizada_em = em;
    evento(d, slug, null, 'substituiu', `${itens.length} ${itens.length === 1 ? 'item' : 'itens'}`, por, em);
    salvar(slug, d);
    return { mudou: true, d };
  }

  function opAcrescentar(slug, corpo, por) {
    soCampos(corpo, ['texto', 'feito'], 'POST /api/v1/foco/<agente>/itens');
    const texto = normalizaTexto(corpo.texto, '"texto"');
    if (corpo.feito !== undefined && typeof corpo.feito !== 'boolean') throw falta(400, '"feito" precisa ser true ou false.');
    const d = ler(slug);
    if (d.itens.length >= MAX_ITENS) throw falta(400, `A lista já tem ${MAX_ITENS} itens, o máximo. Apague algum (DELETE /api/v1/foco/${slug}/itens/<id>) antes de acrescentar.`);
    const em = isoNoFuso(relogio(), fuso);
    const it = novoItem(d, texto, corpo.feito === true, por, em);
    d.itens.push(it); d.versao += 1; d.atualizada_em = em;
    evento(d, slug, it.id, 'criou', texto, por, em);
    if (it.feito) evento(d, slug, it.id, 'ticou', texto, por, em);
    salvar(slug, d);
    return { mudou: true, d, item: it };
  }

  function achaItem(d, slug, id) {
    const it = d.itens.find(i => i.id === id);
    if (!it) throw falta(404, `Não existe o item ${id} na lista de foco de ${slug}. Liste os itens com GET /api/v1/foco/${slug}.`);
    return it;
  }

  function opAtualizar(slug, id, corpo, por) {
    soCampos(corpo, ['feito', 'texto'], 'PATCH /api/v1/foco/<agente>/itens/<id>');
    if (corpo.feito === undefined && corpo.texto === undefined) throw falta(400, 'Mande "feito" (true ou false) e/ou "texto" para mudar o item. Exemplo: {"feito": true}.');
    if (corpo.feito !== undefined && typeof corpo.feito !== 'boolean') throw falta(400, '"feito" precisa ser true ou false.');
    const texto = corpo.texto === undefined ? undefined : normalizaTexto(corpo.texto, '"texto"');
    const d = ler(slug);
    const it = achaItem(d, slug, id);
    const em = isoNoFuso(relogio(), fuso);
    const eventos = [];
    if (texto !== undefined && texto !== it.texto) { it.texto = texto; eventos.push('editou'); }
    if (corpo.feito !== undefined && corpo.feito !== !!it.feito) {
      it.feito = corpo.feito; it.feito_em = corpo.feito ? em : null; it.feito_por = corpo.feito ? por : null;
      eventos.push(corpo.feito ? 'ticou' : 'desticou');
    }
    if (!eventos.length) return { mudou: false, d, item: it };
    d.versao += 1; d.atualizada_em = em;
    for (const tipo of eventos) evento(d, slug, it.id, tipo, it.texto, por, em);
    salvar(slug, d);
    return { mudou: true, d, item: it };
  }

  function opApagarItem(slug, id, por) {
    const d = ler(slug);
    const it = achaItem(d, slug, id);
    const em = isoNoFuso(relogio(), fuso);
    d.itens = d.itens.filter(i => i.id !== id); d.versao += 1; d.atualizada_em = em;
    evento(d, slug, it.id, 'apagou', it.texto, por, em);
    salvar(slug, d);
    return { mudou: true, d };
  }

  function opLimpar(slug, por) {
    const d = ler(slug);
    if (!d.itens.length && (d.titulo || TITULO_PADRAO) === TITULO_PADRAO) return { mudou: false, d };
    const em = isoNoFuso(relogio(), fuso);
    d.itens = []; d.titulo = TITULO_PADRAO; d.versao += 1; d.atualizada_em = em;
    evento(d, slug, null, 'limpou', '', por, em);
    salvar(slug, d);
    return { mudou: true, d };
  }

  function opEventos(slug, desde) {
    const d = ler(slug);
    const todos = d.eventos.filter(e => e.id > desde);
    const eventos = todos.slice(0, EVENTOS_POR_LEITURA);
    return { eventos, ultimo_id: eventos.length ? eventos[eventos.length - 1].id : desde, tem_mais: todos.length > eventos.length };
  }

  // ── retrato e aviso ──
  async function retrato(slug, d) {
    if (!gravaRetrato) return;
    try {
      await gravaRetrato(slug, 'foco', {
        lista: paraLista(slug, d), eventos: d.eventos.slice(-EVENTOS_NO_RETRATO), ultimo_id: d.proximo_evento_id - 1,
      });
    } catch (e) {
      avisa(`Foco de ${slug}: a lista foi gravada, mas não consegui regravar o retrato na casa do agente (${e.message}). A próxima mudança tenta de novo.`);
    }
  }

  function avisaCelular(slug, d) {
    if (!push) return;
    const nome = (registro && registro.obter(slug) && registro.obter(slug).nome) || slug;
    const n = d.itens.length;
    Promise.resolve()
      .then(() => push.enviar({ titulo: `🎯 ${nome} montou seu foco`, corpo: `${n} ${n === 1 ? 'item' : 'itens'}`, tag: `foco-${slug}`, url: `/a/${slug}` }))
      .then((r) => { if (r && r.falhas && r.falhas.length) avisa(`Foco de ${slug}: aviso no celular com ${r.falhas.length} falha(s): ${r.falhas.map(f => `${f.servico || '?'} ${f.status || ''} ${f.motivo || ''}`.trim()).join('; ')}.`); })
      .catch((e) => avisa(`Foco de ${slug}: não consegui mandar o aviso no celular (${e.message}). A lista foi gravada normalmente.`));
  }

  // ── HTTP ──
  async function lerCorpoObjeto(req, obrigatorio) {
    let buf;
    try { buf = await H.lerCorpo(req, MAX_CORPO); } catch (e) { throw falta(e.status || 400, e.message); }
    if (!buf.length) {
      if (obrigatorio) throw falta(400, 'Mande o corpo como objeto JSON (Content-Type: application/json).');
      return {};
    }
    let v;
    try { v = JSON.parse(buf.toString('utf8')); } catch (_) { throw falta(400, 'O corpo não é um JSON válido. Mande um objeto JSON com Content-Type: application/json.'); }
    if (!ehObjeto(v)) throw falta(400, 'O corpo precisa ser um objeto JSON ({...}), não uma lista, texto ou número.');
    return v;
  }

  function resolveAgente(sessao, bruto) {
    const q = quem(sessao);
    let slug = bruto;
    if (slug === 'eu') {
      if (q.tipo !== 'agente') throw falta(400, 'O atalho "eu" só vale para o agente chamando pela caixa (dgclaw-api). Com login, informe o id do agente (veja GET /api/v1/agents).');
      slug = q.slug;
    } else if (q.tipo === 'agente' && q.slug !== slug) {
      throw falta(403, `Pedido do agente "${q.slug}" para a lista de foco de "${slug}". Cada agente só mexe na própria lista: use /api/v1/foco/eu ou /api/v1/foco/${q.slug}.`);
    }
    if (registro) {
      const est = registro.estado();
      if (!est.ok) throw falta(503, est.erro);
      if (!registro.obter(slug)) throw falta(404, `Não existe agente com o id "${String(slug).slice(0, 40)}". Veja GET /api/v1/agents.`);
    }
    return { slug, q };
  }

  const porDe = (q) => (q.tipo === 'agente' ? 'agente' : q.usuario);

  async function tratarRota(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== '/api/v1/foco' && !p.startsWith('/api/v1/foco/')) return false;
    const m = req.method;
    try {
      if (p === '/api/v1/foco/docs.md') {
        if (m !== 'GET') throw falta(405, 'Esta rota só aceita GET.');
        let doc;
        try { doc = fs.readFileSync(DOC); } catch (e) { throw falta(503, `Não consegui ler a documentação em ${DOC}: ${e.message}.`); }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(doc);
        return true;
      }
      const r = /^\/api\/v1\/foco\/([^/]+)(?:\/(itens|eventos)(?:\/([^/]+))?)?$/.exec(p);
      if (!r) throw falta(404, `Não existe a rota ${m} ${p}. Veja GET /api/v1/foco/docs.md.`);
      const [, agBruto, sub, idBruto] = r;
      let aceitos;
      if (!sub) aceitos = ['GET', 'PUT', 'DELETE'];
      else if (sub === 'itens' && !idBruto) aceitos = ['POST'];
      else if (sub === 'itens') aceitos = ['PATCH', 'DELETE'];
      else if (sub === 'eventos' && !idBruto) aceitos = ['GET'];
      else throw falta(404, `Não existe a rota ${m} ${p}. Veja GET /api/v1/foco/docs.md.`);
      if (!aceitos.includes(m)) {
        res.setHeader('Allow', aceitos.join(', '));
        throw falta(405, `${p} não aceita ${m}. Métodos aceitos: ${aceitos.join(', ')}.`);
      }
      const { slug, q } = resolveAgente(sessao, decodeURIComponent(agBruto));
      const por = porDe(q);
      let id = null;
      if (idBruto !== undefined) {
        if (!/^\d+$/.test(idBruto)) throw falta(400, `O id do item precisa ser um número. Recebi: ${decodeURIComponent(idBruto).slice(0, 40)}. Liste os itens com GET /api/v1/foco/${slug}.`);
        id = Number(idBruto);
      }

      let saida;
      if (!sub) {
        if (m === 'GET') { H.enviaJson(res, 200, { ok: true, lista: lista(slug) }); return true; }
        if (m === 'PUT') saida = opSubstituir(slug, await lerCorpoObjeto(req, true), por);
        else {
          // ?versao=N: a versão que a tela mostrava ao tocar em Concluir. Se o agente mexeu na lista
          // depois disso, limpar apagaria itens que a pessoa nunca viu. Sem o parâmetro, limpa sempre.
          const bruto = url.searchParams.get('versao');
          if (bruto !== null) {
            if (!/^\d+$/.test(bruto)) throw falta(400, `O parâmetro "versao" precisa ser um inteiro maior ou igual a zero. Recebi: ${bruto.slice(0, 40)}. Use o campo "versao" de GET /api/v1/foco/${slug}.`);
            if (Number(bruto) !== versao(slug)) {
              H.erroJson(res, 409, `A lista de ${slug} mudou desde a versão ${bruto} (agora está na ${versao(slug)}). Nada foi apagado: confira os itens atuais e peça de novo com a versão nova.`, { lista: lista(slug) });
              return true;
            }
          }
          saida = opLimpar(slug, por);
        }
      } else if (sub === 'eventos') {
        const bruto = url.searchParams.get('desde_id');
        if (bruto !== null && !/^\d+$/.test(bruto)) throw falta(400, `O parâmetro "desde_id" precisa ser um inteiro maior ou igual a zero. Recebi: ${bruto.slice(0, 40)}.`);
        H.enviaJson(res, 200, { ok: true, ...opEventos(slug, bruto === null ? 0 : Number(bruto)) });
        return true;
      } else if (m === 'POST') {
        saida = opAcrescentar(slug, await lerCorpoObjeto(req, true), por);
      } else if (m === 'PATCH') {
        saida = opAtualizar(slug, id, await lerCorpoObjeto(req, true), por);
      } else {
        saida = opApagarItem(slug, id, por);
      }

      if (saida.mudou) {
        await retrato(slug, saida.d);
        if (m === 'PUT' && q.tipo === 'agente') avisaCelular(slug, saida.d);
      }
      const corpo = { ok: true, mudou: saida.mudou, lista: paraLista(slug, saida.d) };
      if (saida.item) corpo.item = corpo.lista.itens.find(i => i.id === saida.item.id) || null;
      H.enviaJson(res, m === 'POST' ? 201 : 200, corpo);
      return true;
    } catch (e) {
      if (e instanceof ErroFoco) {
        if (e.status >= 500) (log || H.logPadrao)('erro', `Foco ${req.method} ${p}: ${e.message}`);
        H.erroJson(res, e.status, e.message);
      } else {
        (log || H.logPadrao)('erro', `Foco ${req.method} ${p}: falha inesperada (${e.stack || e.message})`);
        H.erroJson(res, 500, `Falha inesperada no modo foco: ${e.message}. Tente de novo; se repetir, veja o log do Web.`);
      }
      return true;
    }
  }

  return { tratarRota, lista, versao, ErroFoco };
}

module.exports = { criarFoco, isoNoFuso, MAX_ITENS, MAX_TEXTO, MAX_TITULO };
