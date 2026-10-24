'use strict';
// Modo roteiro: o roteiro fica parado num lugar só e a conversa serve para pedir ajustes.
// Contrato em docs/MODO-ROTEIRO.md. Cada roteiro é <dir>/<id>.json (0600, substituição atômica) e os
// pedidos de abrir ficam em <dir>/_aberto.json. Arquivo inválido nunca é sobrescrito: aquele roteiro
// responde 503 com o motivo até alguém corrigir.
//
// Roteiro `local`: o texto de cada versão mora aqui. Roteiro `dgsocial`: o texto atual é o arquivo do
// conteúdo no DG Social (lido a cada abertura, gravado a cada versão); aqui fica só o registro das
// versões, o aviso "ajustando", o estado marcado e os eventos.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const { isoLocal } = require('./mesa');

const MAX_CORPO = 512 * 1024;
const MAX_TEXTO = 200 * 1024;
const MAX_VERSOES = 300;
const MAX_EVENTOS = 200;
const AJUSTANDO_MIN = 15;
const LIMITES = { titulo: 120, resumo: 160, nota: 160 };
const ESTADOS = ['em_ajuste', 'aguardando_aprovacao', 'aprovado', 'arquivado'];
const RX_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RX_SLUG_AGENTE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ARQUIVO_ABERTO = '_aberto.json';

const umaLinha = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
const hashDe = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function erro(status, msg, extra) {
  const e = new Error(msg);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function slugDoTitulo(titulo) {
  const s = semAcento(titulo).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'roteiro';
}

function criarRoteiros(opcoes) {
  const o = opcoes || {};
  const { dir, registro } = o;
  const log = o.log || H.logPadrao;
  const tz = o.tz || 'UTC';
  const relogio = o.agora || (() => Date.now());
  const agoraMs = () => { const a = relogio(); return a instanceof Date ? a.getTime() : Number(a); };
  const remoto = o.dgsocial && o.dgsocial.ligado ? o.dgsocial : null;
  const agenteDgSocialConf = String(o.agenteDgSocial || '').trim();
  const quemChamou = o.quemChamou || ((s) => (s && s.via === 'caixa' && typeof s.agente === 'string'
    ? { tipo: 'agente', slug: s.agente }
    : { tipo: 'dono', usuario: s && s.usuario }));
  const docsPath = path.join(__dirname, '..', 'docs', 'ROTEIROS-API.md');

  const cache = new Map();     // id -> { assinatura, rec }
  const travas = new Map();    // id -> fim da fila de pedidos daquele roteiro
  let avisouAgentePadrao = false;

  const iso = (ms) => isoLocal(ms, tz);
  const arquivoDe = (id) => path.join(dir, `${id}.json`);
  const autorDe = (quem) => (quem.tipo === 'agente' ? quem.slug : 'dono');

  // ── disco ──────────────────────────────────────────────────────────────
  function assinatura(arq) {
    try { const st = fs.statSync(arq); return `${st.mtimeMs}:${st.size}`; } catch (e) { return e.code === 'ENOENT' ? null : `erro:${e.code}`; }
  }

  /** Lê um JSON do disco. Ausente = { dados: null }. Ilegível ou inválido = lança 503 sem tocar no arquivo. */
  function lerArquivo(arq, valida) {
    let texto;
    try { texto = fs.readFileSync(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      const msg = `Não consegui ler ${arq} (${e.code || e.message}). O arquivo não foi alterado. Confira as permissões da pasta ${dir}.`;
      log('erro', msg);
      throw erro(503, msg);
    }
    try {
      const d = JSON.parse(texto);
      const problema = valida(d);
      if (problema) throw new Error(problema);
      return d;
    } catch (e) {
      const msg = `O arquivo ${arq} está inválido (${e.message}). Ele não foi alterado e este roteiro fica fora do ar até alguém corrigir o JSON ou restaurar o backup.`;
      log('erro', msg);
      throw erro(503, msg);
    }
  }

  function gravarArquivo(arq, obj) {
    const pasta = path.dirname(arq);
    const tmp = path.join(pasta, `.${path.basename(arq)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let fd = null;
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(obj));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, arq);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* já fechando por erro */ } }
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* temporário órfão não atrapalha */ }
      const msg = `Não consegui gravar ${arq} (${e.code || e.message}). Nada foi alterado. Confira espaço e permissões da pasta ${pasta}.`;
      log('erro', msg);
      throw erro(503, msg);
    }
  }

  const validaRec = (d) => (!d || d.formato !== 1 || typeof d.id !== 'string' || !Array.isArray(d.versoes) || !Array.isArray(d.eventos)
    ? 'formato inesperado (esperava {"formato":1,"id":...,"versoes":[...],"eventos":[...]})' : null);

  /** O registro como está no disco (compartilhado: quem for alterar clona antes). null se não existe. */
  function lerRec(id) {
    const arq = arquivoDe(id);
    const sig = assinatura(arq);
    if (sig === null) { cache.delete(id); return null; }
    const c = cache.get(id);
    if (c && c.assinatura === sig) return c.rec;
    const rec = lerArquivo(arq, validaRec);
    if (!rec) return null;
    cache.set(id, { assinatura: sig, rec });
    return rec;
  }

  function gravarRec(rec) {
    gravarArquivo(arquivoDe(rec.id), rec);
    cache.set(rec.id, { assinatura: assinatura(arquivoDe(rec.id)), rec });
  }

  function idsLocais() {
    try {
      return fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== ARQUIVO_ABERTO && !n.startsWith('.')).map((n) => n.slice(0, -5)).filter((n) => RX_ID.test(n));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw erro(503, `Não consegui listar a pasta de roteiros ${dir} (${e.code || e.message}). Confira as permissões da pasta de dados do Web.`);
    }
  }

  /** Um pedido por vez para cada roteiro (as chamadas ao DG Social são assíncronas e poderiam se cruzar). */
  function serial(id, fn) {
    const antes = travas.get(id) || Promise.resolve();
    const p = antes.then(fn, fn);
    const fim = p.catch(() => {});
    travas.set(id, fim);
    fim.then(() => { if (travas.get(id) === fim) travas.delete(id); });
    return p;
  }

  // ── regras do registro ─────────────────────────────────────────────────
  const ultima = (r) => r.versoes[r.versoes.length - 1] || null;
  const versaoDe = (r, n) => r.versoes.find((v) => v.versao === n) || null;

  function evento(r, tipo, autor, versao, nota, ms) {
    r.eventos.push({ n: r.proximo_evento, tipo, autor, versao: versao == null ? null : versao, quando: iso(ms), nota: nota || null });
    r.proximo_evento += 1;
    if (r.eventos.length > MAX_EVENTOS) r.eventos.splice(0, r.eventos.length - MAX_EVENTOS);
  }

  function empilhaVersao(r, { texto, resumo, autor, restauradaDe }, ms) {
    const v = {
      versao: r.proxima_versao, resumo, autor, criado_em: iso(ms), caracteres: texto.length,
      restaurada_de: restauradaDe == null ? null : restauradaDe, hash: hashDe(texto), texto,
    };
    r.proxima_versao += 1;
    r.versoes.push(v);
    // As mais antigas saem do registro; a versão 1 fica sempre.
    while (r.versoes.length > MAX_VERSOES) r.versoes.splice(1, 1);
    r.ajustando = null;
    r.atualizado_em = iso(ms);
    return v;
  }

  function marcaEstado(r, estado, ms) {
    r.estado = estado;
    r.estado_marcado_em = iso(ms);
  }

  function ajustandoVivo(r, ms) {
    if (!r.ajustando) return null;
    const desde = Date.parse(r.ajustando.desde);
    return Number.isFinite(desde) && desde + AJUSTANDO_MIN * 60000 > ms ? r.ajustando : null;
  }

  /** Estado: no DG Social vale o mais recente entre o derivado da fase e o marcado aqui. */
  function estadoEfetivo(r, item) {
    if (r.origem !== 'dgsocial' || !item) return r.estado;
    const marcado = r.estado_marcado_em ? Date.parse(r.estado_marcado_em) : 0;
    const remoto2 = item.atualizado_em ? Date.parse(item.atualizado_em) : 0;
    return marcado && marcado >= remoto2 ? r.estado : item.estado;
  }

  function visao(r, item, ms, texto) {
    const v = ultima(r);
    const atualizadoLocal = r.atualizado_em ? Date.parse(r.atualizado_em) : 0;
    const atualizadoRemoto = item && item.atualizado_em ? Date.parse(item.atualizado_em) : 0;
    const out = {
      id: r.id, titulo: (item && item.titulo) || r.titulo, agente: r.agente, origem: r.origem, ref: r.ref || null,
      link: r.origem === 'dgsocial' ? ((item && item.link) || (remoto ? remoto.link(r.ref) : null)) : null,
      estado: estadoEfetivo(r, item), ajustando: ajustandoVivo(r, ms),
      versao: v ? v.versao : 0, resumo: v ? v.resumo : null, autor: v ? v.autor : null, hash: v ? v.hash : null,
      atualizado_em: atualizadoRemoto > atualizadoLocal ? item.atualizado_em : (r.atualizado_em || null),
      criado_em: r.criado_em || (item && item.criado_em) || null, aprovado_em: r.aprovado_em || null,
    };
    if (texto !== undefined) out.texto = texto;
    return out;
  }

  function resumoVersao(v) {
    return { versao: v.versao, resumo: v.resumo, autor: v.autor, criado_em: v.criado_em, caracteres: v.caracteres, restaurada_de: v.restaurada_de, hash: v.hash };
  }

  // ── agentes ────────────────────────────────────────────────────────────
  function slugsDoRegistro() {
    const est = registro.estado();
    if (!est.ok) throw erro(503, `Não consegui ler o registro de agentes (${est.erro || 'motivo desconhecido'}). Confira o arquivo de agentes do DG Claw e tente de novo.`);
    return est.agentes.map((a) => a.slug);
  }

  function agentePadraoDgSocial() {
    if (agenteDgSocialConf) return agenteDgSocialConf;
    const slugs = slugsDoRegistro();
    if (!slugs.length) throw erro(503, 'Não há nenhum agente no registro para ficar dono dos roteiros do DG Social. Crie um agente ou defina DGCLAW_ROTEIROS_DGSOCIAL_AGENTE.');
    if (!avisouAgentePadrao) {
      avisouAgentePadrao = true;
      log('aviso', `DGCLAW_ROTEIROS_DGSOCIAL_AGENTE está vazio: os roteiros do DG Social ficam com o primeiro agente do registro (${slugs[0]}). Defina a variável para escolher outro.`);
    }
    return slugs[0];
  }

  // ── carregar um roteiro (com sincronia opcional do texto no DG Social) ──
  const clonar = (rec) => structuredClone(rec);
  const naoExiste = (id) => erro(404, `Não existe o roteiro "${id}". Veja os roteiros em GET /api/v1/roteiros.`);

  function recDgSocialNovo(item) {
    return {
      formato: 1, id: `dgs-${item.slug}`, titulo: item.titulo, agente: agentePadraoDgSocial(), origem: 'dgsocial', ref: item.slug,
      estado: item.estado, estado_marcado_em: null, ajustando: null, versoes: [], proxima_versao: 1, eventos: [], proximo_evento: 1,
      criado_em: item.criado_em, atualizado_em: null, aprovado_em: null,
    };
  }

  /**
   * Devolve { r, item, texto, clonado }. Com `sincronizar`, roteiro do DG Social lê o texto lá e registra
   * a versão `externo` se ele mudou fora do modo roteiro (e grava). Agente só enxerga os próprios.
   */
  async function carregar(id, quem, { sincronizar }) {
    let r = lerRec(id);
    let item = null;
    let clonado = false;
    if (!r) {
      if (!(id.startsWith('dgs-') && remoto)) throw naoExiste(id);
      const slug = id.slice(4);
      item = await remoto.item(slug);
      if (!item) throw erro(404, `O DG Social não tem um conteúdo "${slug}" com roteiro (só aparecem os das fases aprovada até publicar). Veja os roteiros em GET /api/v1/roteiros.`);
      r = recDgSocialNovo(item);
      clonado = true;
    }
    if (quem.tipo === 'agente' && r.agente !== quem.slug) throw naoExiste(id);
    if (r.origem !== 'dgsocial') return { r, item: null, texto: ultima(r) ? ultima(r).texto : '', clonado };
    if (!remoto) {
      throw erro(503, `O roteiro "${id}" vem do DG Social, mas o conector está desligado (faltam DGCLAW_ROTEIROS_DGSOCIAL_URL e DGCLAW_ROTEIROS_DGSOCIAL_CHAVE). Ligue o conector para ler e gravar este roteiro.`);
    }
    if (!sincronizar) return { r, item, texto: undefined, clonado };
    if (!item) item = await remoto.item(r.ref);
    const texto = await remoto.lerTexto(r.ref);
    const v = ultima(r);
    const h = hashDe(texto);
    if (!v || v.hash !== h) {
      if (!clonado) { r = clonar(r); clonado = true; }
      const ms = agoraMs();
      const primeira = !v;
      const nova = empilhaVersao(r, { texto, resumo: primeira ? 'Primeira leitura do DG Social' : 'Mudou fora do modo roteiro', autor: 'externo' }, ms);
      evento(r, 'externo', 'externo', nova.versao, nova.resumo, ms);
      gravarRec(r);
    }
    return { r, item, texto, clonado };
  }

  const editavel = (ctx) => { if (!ctx.clonado) { ctx.r = clonar(ctx.r); ctx.clonado = true; } return ctx.r; };

  // ── validação do corpo ─────────────────────────────────────────────────
  function baseVersao(corpo) {
    if (!Number.isInteger(corpo.base_versao) || corpo.base_versao < 0) {
      throw erro(400, `base_versao é obrigatório e precisa ser o número inteiro da versão que você leu (recebi ${JSON.stringify(corpo.base_versao === undefined ? null : corpo.base_versao)}). Leia o roteiro em GET /api/v1/roteiros/<id> e mande o campo "versao" dele.`);
    }
    return corpo.base_versao;
  }

  function textoDoCorpo(corpo) {
    if (typeof corpo.texto !== 'string' || !corpo.texto.trim()) throw erro(400, 'O campo "texto" é obrigatório (texto do roteiro, não vazio).');
    if (Buffer.byteLength(corpo.texto, 'utf8') > MAX_TEXTO) throw erro(413, `O texto passou de ${MAX_TEXTO / 1024} KB. Corte o roteiro ou divida em dois.`);
    return corpo.texto;
  }

  function resumoDoCorpo(corpo, quem, padraoDono) {
    const bruto = corpo.resumo;
    if (bruto !== undefined && bruto !== null && typeof bruto !== 'string') throw erro(400, 'O campo "resumo" precisa ser texto de uma linha.');
    const t = typeof bruto === 'string' ? umaLinha(bruto) : '';
    if (!t) {
      if (quem.tipo === 'agente') throw erro(400, 'O campo "resumo" é obrigatório para o agente: uma linha, até 160 caracteres, dizendo o que mudou. Ele aparece na faixa da tela do dono.');
      return padraoDono;
    }
    if (t.length > LIMITES.resumo) throw erro(400, `O resumo passou de ${LIMITES.resumo} caracteres (tem ${t.length}). Escreva uma linha só.`);
    return t;
  }

  function conflito(r, item, ms, texto, base) {
    const v = ultima(r);
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.parse(v.criado_em)));
    return erro(409, `A versão atual é a ${v.versao} (de ${v.autor}, ${hora}); você partiu da ${base}. Leia a ${v.versao} e grave de novo, ou mande forcar:true.`,
      { atual: visao(r, item, ms, texto) });
  }

  function exigeDono(quem, acao) {
    if (quem.tipo === 'agente') throw erro(403, `Só o dono ${acao}. O agente grava versões, marca "ajustando" e pede o estado aguardando_aprovacao; a decisão fica com a pessoa.`);
  }

  /** Efeito no estado de uma versão nova: do agente pede aprovação; do dono tira o aprovado. */
  function estadoDepoisDaVersao(r, item, quem, ms) {
    if (quem.tipo === 'agente') marcaEstado(r, 'aguardando_aprovacao', ms);
    else if (estadoEfetivo(r, item) === 'aprovado') marcaEstado(r, 'em_ajuste', ms);
  }

  /** Grava a versão nova (no DG Social primeiro, se for dele) e registra. Devolve { ok, mudou, roteiro }. */
  async function aplicaVersao(ctx, quem, { texto, resumo, autor, restauradaDe, tipoEvento }) {
    const ms = agoraMs();
    const r = editavel(ctx);
    if (r.origem === 'dgsocial') await remoto.gravar(r.ref, texto, autor);
    const v = empilhaVersao(r, { texto, resumo, autor, restauradaDe }, ms);
    evento(r, tipoEvento, autorDe(quem), v.versao, resumo, ms);
    estadoDepoisDaVersao(r, ctx.item, quem, ms);
    gravarRec(r);
    return { ok: true, mudou: true, roteiro: visao(r, ctx.item, ms, texto) };
  }

  // ── rotas por assunto ──────────────────────────────────────────────────
  async function criar(corpo, quem) {
    const ms = agoraMs();
    if (typeof corpo.titulo !== 'string' || !umaLinha(corpo.titulo)) throw erro(400, 'O campo "titulo" é obrigatório (nome do roteiro, até 120 caracteres).');
    const titulo = umaLinha(corpo.titulo);
    if (titulo.length > LIMITES.titulo) throw erro(400, `O título passou de ${LIMITES.titulo} caracteres (tem ${titulo.length}).`);
    const texto = textoDoCorpo(corpo);
    const resumo = corpo.resumo === undefined || corpo.resumo === null || corpo.resumo === '' ? 'Primeira versão' : resumoDoCorpo(corpo, quem, 'Primeira versão');
    const slugs = slugsDoRegistro();
    let agente = corpo.agente;
    if (agente !== undefined && (typeof agente !== 'string' || !RX_SLUG_AGENTE.test(agente))) throw erro(400, 'O campo "agente" precisa ser o slug de um agente (letras minúsculas, números e hífen).');
    if (quem.tipo === 'agente') {
      if (agente !== undefined && agente !== quem.slug) throw erro(403, `O agente ${quem.slug} só cria roteiros para si mesmo (recebi agente "${agente}").`);
      agente = quem.slug;
    } else if (agente === undefined) {
      if (!slugs.length) throw erro(503, 'Não há nenhum agente no registro para ser dono do roteiro. Crie um agente primeiro.');
      agente = slugs[0];
    } else if (!slugs.includes(agente)) {
      throw erro(400, `O agente "${agente}" não existe. Agentes que existem: ${slugs.join(', ') || '(nenhum)'}.`);
    }
    let id;
    const base = slugDoTitulo(titulo);
    for (let i = 0; i < 20; i++) {
      const sufixo = Array.from(crypto.randomBytes(4), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
      id = `rt-${base}-${sufixo}`;
      if (assinatura(arquivoDe(id)) === null) break;
      id = null;
    }
    if (!id) throw erro(500, 'Não consegui achar um id livre para o roteiro. Tente de novo.');
    const r = {
      formato: 1, id, titulo, agente, origem: 'local', ref: null, estado: quem.tipo === 'agente' ? 'aguardando_aprovacao' : 'em_ajuste',
      estado_marcado_em: null, ajustando: null, versoes: [], proxima_versao: 1, eventos: [], proximo_evento: 1,
      criado_em: iso(ms), atualizado_em: iso(ms), aprovado_em: null,
    };
    const v = empilhaVersao(r, { texto, resumo, autor: autorDe(quem) }, ms);
    evento(r, 'criado', autorDe(quem), v.versao, titulo, ms);
    gravarRec(r);
    return { ok: true, roteiro: visao(r, null, ms, texto) };
  }

  async function listar(url, quem) {
    const ms = agoraMs();
    const q = semAcento(url.searchParams.get('q') || '').trim();
    const estadosPedidos = url.searchParams.get('estado');
    let estados = null;
    if (estadosPedidos !== null) {
      estados = estadosPedidos.split(',').map((s) => s.trim()).filter(Boolean);
      const falsos = estados.filter((s) => !ESTADOS.includes(s));
      if (!estados.length || falsos.length) throw erro(400, `O parâmetro "estado" aceita: ${ESTADOS.join(', ')} (separados por vírgula). Recebi ${JSON.stringify(estadosPedidos.slice(0, 60))}.`);
    }
    const agentePedido = url.searchParams.get('agente');

    const fontes = { local: { ok: true }, dgsocial: { ligado: Boolean(remoto), ok: true } };
    const locais = new Map();
    const invalidos = [];
    for (const id of idsLocais()) {
      try { const r = lerRec(id); if (r) locais.set(id, r); } catch (e) { invalidos.push(id); }
    }
    if (invalidos.length) {
      fontes.local = { ok: false, erro: `Não consegui abrir ${invalidos.length} roteiro(s) guardado(s) (${invalidos.slice(0, 5).join(', ')}): arquivo inválido ou ilegível. Veja o log do Web e corrija o JSON; nada foi alterado.` };
    }

    let itens = [];
    if (remoto) {
      try { itens = await remoto.listar(); } catch (e) {
        fontes.dgsocial = { ligado: true, ok: false, erro: e.message };
      }
    }
    const porSlug = new Map(itens.map((i) => [i.slug, i]));

    const saida = [];
    for (const r of locais.values()) {
      const item = r.origem === 'dgsocial' ? porSlug.get(r.ref) || null : null;
      saida.push(visao(r, item, ms));
    }
    if (remoto && fontes.dgsocial.ok) {
      for (const it of itens) {
        if (locais.has(`dgs-${it.slug}`)) continue;
        try { saida.push(visao(recDgSocialNovo(it), it, ms)); } catch (e) { fontes.dgsocial = { ligado: true, ok: false, erro: e.message }; break; }
      }
    }

    const filtrados = saida
      .filter((x) => (quem.tipo === 'agente' ? x.agente === quem.slug : !agentePedido || x.agente === agentePedido))
      .filter((x) => !estados || estados.includes(x.estado))
      .filter((x) => !q || semAcento(x.titulo).includes(q) || x.id.includes(q))
      .sort((a, b) => (Date.parse(b.atualizado_em) || 0) - (Date.parse(a.atualizado_em) || 0) || (a.id < b.id ? -1 : 1));
    return { ok: true, roteiros: filtrados, fontes, agora: iso(ms) };
  }

  function lerAbertos() {
    return lerArquivo(path.join(dir, ARQUIVO_ABERTO), (d) => (d && typeof d === 'object' && !Array.isArray(d) ? null : 'esperava um objeto {"<agente>": {"id":...,"pedido_em":...}}')) || {};
  }

  function aberto(url) {
    const dados = lerAbertos();
    const ag = url.searchParams.get('agente');
    if (ag) return { ok: true, id: dados[ag] ? dados[ag].id : null, pedido_em: dados[ag] ? dados[ag].pedido_em : null };
    const todos = Object.values(dados).filter((x) => x && x.id).sort((a, b) => (Date.parse(b.pedido_em) || 0) - (Date.parse(a.pedido_em) || 0));
    return { ok: true, id: todos[0] ? todos[0].id : null, pedido_em: todos[0] ? todos[0].pedido_em : null };
  }

  async function tratarRoteiro(req, url, id, sub, quem, corpoDe) {
    const m = req.method;
    const ms = agoraMs();
    const so = (...metodos) => { if (!metodos.includes(m)) throw erro(405, `Esta rota aceita ${metodos.join(' ou ')}. Veja o contrato em GET /api/v1/roteiros/docs.md.`); };

    if (sub === '') {
      so('GET');
      const ctx = await carregar(id, quem, { sincronizar: true });
      return [200, Object.assign({ ok: true }, visao(ctx.r, ctx.item, ms, ctx.texto))];
    }
    if (sub === 'estado' && m === 'GET') {
      const ctx = await carregar(id, quem, { sincronizar: true });
      const v = visao(ctx.r, ctx.item, ms);
      return [200, { ok: true, id: v.id, versao: v.versao, estado: v.estado, ajustando: v.ajustando, resumo: v.resumo, autor: v.autor, atualizado_em: v.atualizado_em }];
    }
    if (sub === 'versoes' && m === 'GET') {
      const ctx = await carregar(id, quem, { sincronizar: false });
      return [200, { ok: true, versoes: ctx.r.versoes.map(resumoVersao) }];
    }
    if (sub === 'eventos') {
      so('GET');
      const desdeBruto = url.searchParams.get('desde');
      let desde = 0;
      if (desdeBruto !== null && desdeBruto !== '') {
        desde = Number(desdeBruto);
        if (!Number.isInteger(desde) || desde < 0) throw erro(400, `O parâmetro "desde" precisa ser um número inteiro (o "n" do último evento que você viu). Recebi ${JSON.stringify(desdeBruto.slice(0, 20))}.`);
      }
      const ctx = await carregar(id, quem, { sincronizar: false });
      const eventos = ctx.r.eventos.filter((e) => e.n > desde);
      return [200, { ok: true, eventos, ultimo: ctx.r.proximo_evento - 1 }];
    }
    const mv = /^versoes\/(\d+)$/.exec(sub);
    if (mv) {
      so('GET');
      const ctx = await carregar(id, quem, { sincronizar: false });
      const v = versaoDe(ctx.r, Number(mv[1]));
      if (!v) throw erro(404, `A versão ${mv[1]} do roteiro "${id}" não está no registro (guardo as últimas ${MAX_VERSOES} e a versão 1). Veja as versões em GET /api/v1/roteiros/${id}/versoes.`);
      return [200, { ok: true, versao: Object.assign(resumoVersao(v), { texto: v.texto }) }];
    }

    // Daqui para baixo são escritas: um pedido por vez para cada roteiro.
    const acoes = ['versoes', 'ajustando', 'desfazer', 'restaurar', 'estado', 'aprovar', 'abrir'];
    if (!acoes.includes(sub)) throw erro(404, `A rota /api/v1/roteiros/${id}/${sub} não existe. Veja o contrato em GET /api/v1/roteiros/docs.md.`);
    so('POST');
    const corpo = await corpoDe();

    return serial(id, async () => {
      const exigeSync = ['versoes', 'desfazer', 'restaurar', 'aprovar'].includes(sub);
      const ctx = await carregar(id, quem, { sincronizar: exigeSync });
      const r = ctx.r;

      if (sub === 'versoes') {
        const base = baseVersao(corpo);
        const texto = textoDoCorpo(corpo);
        const resumo = resumoDoCorpo(corpo, quem, 'Edição à mão');
        if (corpo.forcar !== undefined && typeof corpo.forcar !== 'boolean') throw erro(400, 'O campo "forcar" precisa ser true ou false.');
        const v = ultima(r);
        if (v && v.hash === hashDe(texto)) return [200, { ok: true, mudou: false, versao: v.versao, roteiro: visao(r, ctx.item, ms, ctx.texto) }];
        if (v && base !== v.versao && corpo.forcar !== true) throw conflito(r, ctx.item, ms, ctx.texto, base);
        const out = await aplicaVersao(ctx, quem, { texto, resumo, autor: autorDe(quem), tipoEvento: quem.tipo === 'agente' ? 'versao' : 'edicao_dono' });
        return [200, out];
      }

      if (sub === 'desfazer') {
        exigeDono(quem, 'desfaz uma versão');
        const base = baseVersao(corpo);
        const v = ultima(r);
        if (base !== v.versao) throw conflito(r, ctx.item, ms, ctx.texto, base);
        const alvoN = (v.restaurada_de != null ? v.restaurada_de : v.versao) - 1;
        if (alvoN < 1) throw erro(409, 'Não há versão anterior para desfazer: este roteiro está na versão 1.', { atual: visao(r, ctx.item, ms, ctx.texto) });
        const alvo = versaoDe(r, alvoN);
        if (!alvo) throw erro(409, `A versão ${alvoN} já saiu do registro (guardo as últimas ${MAX_VERSOES}). Escolha outra em Histórico e use restaurar.`, { atual: visao(r, ctx.item, ms, ctx.texto) });
        if (alvo.hash === v.hash) return [200, { ok: true, mudou: false, versao: v.versao, roteiro: visao(r, ctx.item, ms, ctx.texto) }];
        const out = await aplicaVersao(ctx, quem, { texto: alvo.texto, resumo: `Voltou ao texto da versão ${alvoN}`, autor: 'desfazer', restauradaDe: alvoN, tipoEvento: 'desfazer' });
        return [200, out];
      }

      if (sub === 'restaurar') {
        const base = baseVersao(corpo);
        if (!Number.isInteger(corpo.versao) || corpo.versao < 1) throw erro(400, 'O campo "versao" é obrigatório: o número da versão que você quer de volta (veja GET /api/v1/roteiros/<id>/versoes).');
        const v = ultima(r);
        if (base !== v.versao) throw conflito(r, ctx.item, ms, ctx.texto, base);
        const alvo = versaoDe(r, corpo.versao);
        if (!alvo) throw erro(404, `A versão ${corpo.versao} não está no registro do roteiro "${id}". Veja as que existem em GET /api/v1/roteiros/${id}/versoes.`);
        if (alvo.hash === v.hash) return [200, { ok: true, mudou: false, versao: v.versao, roteiro: visao(r, ctx.item, ms, ctx.texto) }];
        const out = await aplicaVersao(ctx, quem, { texto: alvo.texto, resumo: `Voltou ao texto da versão ${alvo.versao}`, autor: autorDe(quem), restauradaDe: alvo.versao, tipoEvento: 'restaurar' });
        return [200, out];
      }

      if (sub === 'ajustando') {
        if (typeof corpo.ativo !== 'boolean') throw erro(400, 'O campo "ativo" é obrigatório: true liga o aviso "ajustando", false desliga.');
        let nota = null;
        if (corpo.nota !== undefined && corpo.nota !== null) {
          if (typeof corpo.nota !== 'string') throw erro(400, 'O campo "nota" precisa ser texto.');
          nota = umaLinha(corpo.nota);
          if (nota.length > LIMITES.nota) throw erro(400, `A nota passou de ${LIMITES.nota} caracteres (tem ${nota.length}).`);
        }
        const rw = editavel(ctx);
        rw.ajustando = corpo.ativo ? { desde: iso(ms), por: autorDe(quem), nota: nota || null } : null;
        evento(rw, 'ajustando', autorDe(quem), ultima(rw) ? ultima(rw).versao : null, corpo.ativo ? (nota || 'ajustando') : 'parou de ajustar', ms);
        rw.atualizado_em = rw.atualizado_em || iso(ms);
        gravarRec(rw);
        return [200, { ok: true, ajustando: ajustandoVivo(rw, ms) }];
      }

      if (sub === 'estado') {
        if (!ESTADOS.includes(corpo.estado)) throw erro(400, `O campo "estado" precisa ser um destes: ${ESTADOS.join(', ')} (recebi ${JSON.stringify(corpo.estado === undefined ? null : String(corpo.estado).slice(0, 40))}).`);
        if (corpo.estado === 'aprovado') exigeDono(quem, 'marca um roteiro como aprovado (use POST /aprovar)');
        let nota = null;
        if (corpo.nota !== undefined && corpo.nota !== null) {
          if (typeof corpo.nota !== 'string') throw erro(400, 'O campo "nota" precisa ser texto.');
          nota = umaLinha(corpo.nota).slice(0, LIMITES.nota);
        }
        const rw = editavel(ctx);
        marcaEstado(rw, corpo.estado, ms);
        rw.atualizado_em = iso(ms);
        evento(rw, 'estado', autorDe(quem), ultima(rw) ? ultima(rw).versao : null, nota ? `${corpo.estado}: ${nota}` : corpo.estado, ms);
        gravarRec(rw);
        return [200, { ok: true, roteiro: visao(rw, ctx.item, ms) }];
      }

      if (sub === 'aprovar') {
        exigeDono(quem, 'aprova um roteiro');
        const base = baseVersao(corpo);
        const v = ultima(r);
        if (base !== v.versao) throw conflito(r, ctx.item, ms, ctx.texto, base);
        const rw = editavel(ctx);
        let session = null;
        if (rw.origem === 'dgsocial') session = await remoto.aprovar(rw.ref);
        marcaEstado(rw, 'aprovado', ms);
        rw.aprovado_em = iso(ms);
        rw.atualizado_em = iso(ms);
        evento(rw, 'aprovado', 'dono', v.versao, `Versão ${v.versao} aprovada`, ms);
        gravarRec(rw);
        const saida = { ok: true, roteiro: visao(rw, ctx.item, ms, ctx.texto) };
        if (rw.origem === 'dgsocial') saida.session = session;
        return [200, saida];
      }

      // abrir
      const rw = editavel(ctx);
      const link = `/a/${encodeURIComponent(rw.agente)}?roteiro=${encodeURIComponent(rw.id)}`;
      const abertos = lerAbertos();
      abertos[rw.agente] = { id: rw.id, pedido_em: iso(ms) };
      gravarArquivo(path.join(dir, ARQUIVO_ABERTO), abertos);
      evento(rw, 'abrir', autorDe(quem), ultima(rw) ? ultima(rw).versao : null, null, ms);
      rw.atualizado_em = rw.atualizado_em || iso(ms);
      gravarRec(rw);
      return [200, { ok: true, link, pedido_em: abertos[rw.agente].pedido_em }];
    });
  }

  // ── despacho ───────────────────────────────────────────────────────────
  async function rota(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== '/api/v1/roteiros' && !p.startsWith('/api/v1/roteiros/')) return false;
    const m = req.method;
    const resto = p.slice('/api/v1/roteiros'.length).replace(/^\/+|\/+$/g, '');

    try {
      if (resto === 'docs.md') {
        if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ler a documentação dos roteiros.'); return true; }
        let texto;
        try { texto = fs.readFileSync(docsPath); } catch (e) {
          log('erro', `Não achei a documentação dos roteiros em ${docsPath} (${e.code || e.message}). Reinstale o DG Claw Web.`);
          H.erroJson(res, 500, 'A documentação dos roteiros não está instalada neste servidor. Reinstale o DG Claw Web.');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': texto.length, 'Cache-Control': 'no-store' });
        res.end(texto);
        return true;
      }

      const quem = quemChamou(sessao);
      const corpoDe = async () => {
        let corpo;
        try { corpo = await H.lerJson(req, MAX_CORPO); } catch (e) {
          if (!e.status) throw e;
          throw erro(e.status, e.status === 413 ? `O corpo do pedido passou de ${MAX_CORPO / 1024} KB. Mande um roteiro menor (limite do texto: ${MAX_TEXTO / 1024} KB).` : e.message);
        }
        if (Array.isArray(corpo)) throw erro(400, 'O corpo precisa ser um objeto JSON ({...}), não uma lista.');
        return corpo;
      };

      if (resto === '') {
        if (m === 'GET') { H.enviaJson(res, 200, await listar(url, quem)); return true; }
        if (m === 'POST') {
          const corpo = await corpoDe();
          H.enviaJson(res, 201, await criar(corpo, quem));
          return true;
        }
        H.erroJson(res, 405, 'Use GET para listar os roteiros ou POST para criar um.');
        return true;
      }

      if (resto === 'aberto') {
        if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ver o último pedido de abrir.'); return true; }
        exigeDono(quem, 'lê o pedido de abrir (é a tela da conversa que sonda)');
        H.enviaJson(res, 200, aberto(url));
        return true;
      }

      const i = resto.indexOf('/');
      const id = i < 0 ? resto : resto.slice(0, i);
      const sub = i < 0 ? '' : resto.slice(i + 1);
      if (!RX_ID.test(id)) {
        H.erroJson(res, 400, `O id do roteiro precisa ter letras minúsculas, números e hífen, até 128 caracteres (recebi ${JSON.stringify(id.slice(0, 60))}). Veja os ids em GET /api/v1/roteiros.`);
        return true;
      }
      const [status, corpo] = await tratarRoteiro(req, url, id, sub, quem, corpoDe);
      H.enviaJson(res, status, corpo);
      return true;
    } catch (e) {
      if (e.status) {
        H.erroJson(res, e.status, e.message, e.extra);
        return true;
      }
      log('erro', `Falha inesperada nos roteiros em ${req.method} ${p}: ${e.stack || e.message}. Mande esta linha ao suporte.`);
      H.erroJson(res, 500, 'Erro interno ao tratar o roteiro. O erro foi registrado no log do Web; tente de novo.');
      return true;
    }
  }

  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) {
    log('aviso', `Não consegui preparar a pasta dos roteiros ${dir} (${e.code || e.message}). As rotas vão responder 503 até a pasta existir e ser gravável.`);
  }

  return { rota };
}

module.exports = { criarRoteiros, ESTADOS, slugDoTitulo };
