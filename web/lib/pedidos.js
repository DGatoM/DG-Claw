'use strict';
// Fila de pedidos: cada pedido do dono a um agente vira um item, em ordem de chegada. Contrato em
// web/docs/PEDIDOS.md. Estado em <dados>/pedidos/pedidos.json (0600, gravação segura). Arquivo
// inválido nunca é sobrescrito: todas as rotas respondem 503 com o motivo até alguém corrigir.
//
// Quem cria e move os itens é o agente (pela caixa, dgclaw-mesa pedido ...). O agente NUNCA marca
// "feito": isso é do dono, que abre o item na tela ou responde na conversa depois da entrega.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const { gravaArquivoSeguro } = require('./grava-seguro');
const { isoLocal, diaLocal } = require('./mesa');
const { instanciaDe } = require('./instancia');

const MAX_CORPO = 16 * 1024;
const MAX_HISTORICO = 50;
const MAX_ABERTOS_POR_AGENTE = 100;
// cota de encerrados POR AGENTE: quem cria e cancela em massa só consome a própria cota, nunca a dos outros
const MAX_FECHADOS_POR_AGENTE = 500;
const DIAS_FECHADOS = 180;
const LIMITES = { texto: 300, motivo: 300 };

const ESTADOS = ['fazendo', 'esperando_dono', 'entregue', 'feito', 'cancelado'];
const ABERTOS = new Set(['fazendo', 'esperando_dono', 'entregue']);
const ESTADOS_DO_AGENTE = new Set(['fazendo', 'esperando_dono', 'entregue', 'cancelado']);
const RX_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RX_MSG = /^[a-f0-9]{16}$/;

const ehTexto = (v) => typeof v === 'string';
const umaLinha = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
// Caractere de controle (fora quebra de linha, que vira espaço) não entra em texto que vai para a tela.
const RX_CONTROLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function textoCampo(v, nome, max, { obrigatorio }, erros) {
  if (v === undefined || v === null || (ehTexto(v) && !v.trim())) {
    if (obrigatorio) erros[nome] = 'obrigatório (texto não vazio)';
    return undefined;
  }
  if (!ehTexto(v)) { erros[nome] = 'precisa ser texto'; return undefined; }
  if (RX_CONTROLE.test(v)) { erros[nome] = 'tem caractere de controle; use só texto'; return undefined; }
  const t = umaLinha(v);
  if (t.length > max) { erros[nome] = `passou de ${max} caracteres (tem ${t.length})`; return undefined; }
  return t;
}

function criarPedidos(opcoes) {
  const o = opcoes || {};
  const { arquivo, raiz, registro, conversa } = o;
  const log = o.log || H.logPadrao;
  const tz = o.tz || 'UTC';
  const relogio = o.agora || (() => Date.now());
  const agoraMs = () => { const a = relogio(); return a instanceof Date ? a.getTime() : Number(a); };
  const quemChamou = o.quemChamou || ((s) => (s && s.via === 'caixa' && typeof s.agente === 'string'
    ? { tipo: 'agente', slug: s.agente }
    : { tipo: 'dono', usuario: s && s.usuario }));
  const docsPath = path.join(__dirname, '..', 'docs', 'PEDIDOS.md');
  // Um agente removido e recriado com o mesmo nome mantém o slug mas é outra instância: o pedido fica preso à que o criou.
  const instanciaAtual = (slug) => (o.instancia ? o.instancia(slug) : instanciaDe(registro.obter(slug)));
  // O agente só enxerga e mexe no que a instância dele criou; pedido sem instância gravada (antigo) é só do dono.
  const doAgente = (p, quem) => p.agente === quem.slug && !!quem.inst && p.instancia === quem.inst;

  let dados = null;        // { versao, proximo_id, pedidos }
  let assinatura = null;
  let falha = null;
  let ultimaFalhaLogada = null;
  let rev = agoraMs();     // muda a cada gravação: base do ETag

  function avisaFalha(motivo, qualEra) {
    falha = motivo;
    if (ultimaFalhaLogada !== motivo) { ultimaFalhaLogada = motivo; log('erro', `${motivo} ${qualEra}`); }
  }

  function assinaturaDoArquivo() {
    try { const st = fs.statSync(arquivo); return `${st.mtimeMs}:${st.size}`; } catch (e) { return e.code === 'ENOENT' ? 'ausente' : `erro:${e.code}`; }
  }

  function carregar() {
    const atual = assinaturaDoArquivo();
    if (dados && !falha && atual === assinatura) return true;
    if (atual === 'ausente') {
      dados = { versao: 1, proximo_id: 1, pedidos: [] };
      assinatura = atual; falha = null; ultimaFalhaLogada = null;
      return true;
    }
    let texto;
    try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      avisaFalha(`A fila de pedidos não abriu: não consegui ler ${arquivo} (${e.code || e.message}). O arquivo não foi alterado.`,
        'Confira as permissões da pasta de dados do Web; a fila tenta de novo no próximo pedido.');
      dados = null; assinatura = null;
      return false;
    }
    try {
      const d = JSON.parse(texto);
      if (!d || d.versao !== 1 || !Array.isArray(d.pedidos) || !Number.isInteger(d.proximo_id) || d.proximo_id < 1) {
        throw new Error('formato inesperado (esperava {"versao":1,"proximo_id":N,"pedidos":[...]})');
      }
      dados = d; assinatura = atual; falha = null; ultimaFalhaLogada = null;
      return true;
    } catch (e) {
      avisaFalha(`A fila de pedidos não abriu: o arquivo ${arquivo} está inválido (${e.message}). O arquivo não foi alterado.`,
        'Corrija o JSON ou restaure o backup; a fila o relê sozinha quando ele mudar. Nada é gravado enquanto isso.');
      dados = null; assinatura = null;
      return false;
    }
  }

  function poda(pedidos, ms) {
    const corte = ms - DIAS_FECHADOS * 86400000;
    let saida = pedidos.filter((p) => ABERTOS.has(p.estado) || !p.fechado_em || (Date.parse(p.fechado_em) || ms) >= corte);
    const porAgente = new Map();
    for (const p of saida) {
      if (ABERTOS.has(p.estado)) continue;
      if (!porAgente.has(p.agente)) porAgente.set(p.agente, []);
      porAgente.get(p.agente).push(p);
    }
    const fora = new Set();
    for (const fechados of porAgente.values()) {
      if (fechados.length <= MAX_FECHADOS_POR_AGENTE) continue;
      fechados.sort((a, b) => a.atualizado_em_epoch - b.atualizado_em_epoch).slice(0, fechados.length - MAX_FECHADOS_POR_AGENTE).forEach((p) => fora.add(p.id));
    }
    if (fora.size) saida = saida.filter((p) => !fora.has(p.id));
    return saida;
  }

  function gravar(novo, ms) {
    const final = { versao: 1, proximo_id: novo.proximo_id, pedidos: poda(novo.pedidos, ms) };
    try {
      gravaArquivoSeguro(arquivo, JSON.stringify(final), {
        raiz, modo: 0o600,
        pasta: { modo: 0o700, uid: process.getuid(), gid: process.getgid() },
      });
    } catch (e) {
      const msg = `Não consegui gravar a fila de pedidos em ${arquivo} (${e.code || e.message}). Nada foi alterado. Confira espaço e permissões da pasta ${path.dirname(arquivo)}.`;
      log('erro', msg);
      const err = new Error(msg); err.status = 503; throw err;
    }
    dados = final; assinatura = assinaturaDoArquivo(); rev += 1;
  }

  // ── leitura ────────────────────────────────────────────────────────────
  const slugsDoRegistro = () => { const est = registro.estado(); return est.ok ? est.agentes.map((a) => a.slug) : null; };

  function leitura(p, comHistorico) {
    const ag = registro.obter(p.agente);
    const l = {
      id: p.id, agente: p.agente, agente_nome: ag ? ag.nome : p.agente, texto: p.texto, estado: p.estado,
      aberto: ABERTOS.has(p.estado), motivo: p.motivo, msg_entrega: p.msg_entrega,
      link_conversa: `/a/${encodeURIComponent(p.agente)}${p.msg_entrega ? `?msg=${p.msg_entrega.id}` : ''}`,
      criado_por: p.criado_por, criado_em: p.criado_em, atualizado_em: p.atualizado_em,
      atualizado_em_epoch: p.atualizado_em_epoch, entregue_em: p.entregue_em, fechado_em: p.fechado_em,
    };
    if (comHistorico) l.historico = p.historico;
    return l;
  }

  const rank = (p) => ({ esperando_dono: 0, entregue: 1, fazendo: 2, feito: 3, cancelado: 4 }[p.estado]);
  // Abertos primeiro (esperando o dono, entregue, fazendo), cada grupo na ordem de chegada; fechados do mais novo ao mais velho.
  function ordem(a, b) {
    const ra = rank(a); const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return ABERTOS.has(a.estado) ? a.id - b.id : b.atualizado_em_epoch - a.atualizado_em_epoch || b.id - a.id;
  }

  // ── a conversa do agente ───────────────────────────────────────────────
  /** Mensagens da conversa do agente, ou { erro } com a frase pronta. */
  async function mensagensDe(slug) {
    const ag = registro.obter(slug);
    if (!ag) return { erro: `O agente ${slug} não está no registro de agentes deste Web.` };
    try {
      const t = await conversa.thread(ag);
      if (!t.msgs.length && t.avisos && t.avisos.length) return { erro: `Não consegui abrir a conversa de ${slug}: ${t.avisos[0]}` };
      return { msgs: t.msgs };
    } catch (e) {
      log('aviso', `Pedidos: não consegui ler a conversa de ${slug} (${e.message}). Os pedidos dele não foram conferidos agora; a próxima consulta tenta de novo.`);
      return { erro: `Não consegui ler a conversa de ${slug} (${e.message}).` };
    }
  }

  /**
   * Itens do agente já entregues AGORA, com o número da entrega. O Web chama isto de forma síncrona antes de enviar a
   * mensagem do dono: só a entrega que já existia antes do envio pode ser fechada por ele.
   */
  function entreguesDe(slug) {
    if (!carregar()) return [];
    const inst = instanciaAtual(slug);
    return dados.pedidos.filter((p) => p.agente === slug && !!inst && p.instancia === inst && p.estado === 'entregue').map((p) => ({ id: p.id, entrega_n: p.entrega_n }));
  }

  /**
   * O Web chama isto quando uma mensagem do DONO (não do colaborador) acaba de ser entregue ao agente pelo envio
   * autenticado do painel: os itens `capturados` (entregues antes do envio) que continuam entregues, com o mesmo
   * número de entrega, viram feito. A prova é o evento no Web, nunca o transcript, que o próprio container do agente
   * consegue escrever. Não derruba o envio: falha vira log.
   */
  function donoRespondeu(slug, ms, capturados) {
    try {
      if (!capturados || !capturados.length) return;
      if (!carregar()) {
        log('aviso', `Pedidos: o dono respondeu a ${slug}, mas a fila não abriu (${falha}). Os itens entregues dele continuam entregues; o dono fecha pela tela.`);
        return;
      }
      const inst = instanciaAtual(slug);
      const vale = (p) => p.agente === slug && !!inst && p.instancia === inst && p.estado === 'entregue' && capturados.some((c) => c.id === p.id && c.entrega_n === p.entrega_n);
      if (!dados.pedidos.some(vale)) return;
      const pedidos = dados.pedidos.map((p) => (vale(p) ? mover(p, 'feito', { por: 'dono (respondeu na conversa)', ms }) : p));
      gravar({ proximo_id: dados.proximo_id, pedidos }, ms);
    } catch (e) {
      log('erro', `Pedidos: o dono respondeu a ${slug}, mas não consegui fechar os itens entregues dele (${e.message}). Eles continuam entregues; o dono fecha pela tela ou o agente reentrega.`);
    }
  }

  /** Cópia do pedido no novo estado, com o evento no histórico. Não grava. */
  function mover(p, estado, { por, ms, motivo, msg, nota }) {
    const t = structuredClone(p);
    const de = t.estado;
    t.estado = estado;
    if (estado === 'esperando_dono' || estado === 'cancelado') t.motivo = motivo || null;
    else t.motivo = null;
    if (estado === 'entregue') { t.msg_entrega = msg || null; t.entregue_em = isoLocal(ms, tz); t.entregue_em_epoch = ms / 1000; t.entrega_n = (t.entrega_n || 0) + 1; }
    if (!ABERTOS.has(estado)) t.fechado_em = isoLocal(ms, tz); else t.fechado_em = null;
    t.atualizado_em = isoLocal(ms, tz);
    t.atualizado_em_epoch = ms / 1000;
    const ev = { em: isoLocal(ms, tz), por, de, para: estado };
    if (motivo) ev.motivo = motivo;
    if (nota) ev.nota = nota;
    t.historico = [...t.historico, ev].slice(-MAX_HISTORICO);
    return t;
  }

  const porDe = (quem) => (quem.tipo === 'agente' ? `agente ${quem.slug}` : `dono (${quem.usuario || 'sessão'})`);

  // ── ações ──────────────────────────────────────────────────────────────
  function criar(corpo, quem, ms) {
    if (quem.tipo !== 'agente') {
      return { status: 403, erro: 'Quem cria o item da fila é o agente, ao receber o pedido (dgclaw-mesa pedido criar). Pela tela, o dono só acompanha, abre, marca como feito ou cancela.' };
    }
    const slugs = slugsDoRegistro();
    if (!slugs) return { status: 503, erro: registro.estado().erro };
    if (!slugs.includes(quem.slug)) return { status: 403, erro: `O agente ${quem.slug} não está no registro de agentes deste Web. Peça ao dono para conferir o registro.` };
    if (corpo.agente !== undefined && corpo.agente !== null && corpo.agente !== quem.slug) {
      return { status: 403, erro: `O agente ${quem.slug} só cria pedido para si mesmo (veio agente ${JSON.stringify(String(corpo.agente).slice(0, 40))}). Tire o campo "agente".` };
    }
    if (!quem.inst) return { status: 503, erro: `Não consegui identificar a instância do agente ${quem.slug} (o registro não tem o campo "instancia" nem a casa do agente). Nenhum pedido foi criado; peça ao dono para conferir o agente com o dgclaw.` };
    const erros = {};
    const texto = textoCampo(corpo.texto, 'texto', LIMITES.texto, { obrigatorio: true }, erros);
    if (Object.keys(erros).length) return { status: 400, erros };
    if (dados.pedidos.filter((p) => doAgente(p, quem) && ABERTOS.has(p.estado)).length >= MAX_ABERTOS_POR_AGENTE) {
      return { status: 409, erro: `O agente ${quem.slug} já tem ${MAX_ABERTOS_POR_AGENTE} pedidos abertos. Entregue ou cancele alguns antes de abrir outro.` };
    }
    const id = dados.proximo_id;
    const t = {
      id, agente: quem.slug, instancia: quem.inst, texto, estado: 'fazendo', motivo: null, msg_entrega: null,
      criado_por: porDe(quem), criado_em: isoLocal(ms, tz), criado_em_epoch: ms / 1000, atualizado_em: isoLocal(ms, tz), atualizado_em_epoch: ms / 1000,
      entregue_em: null, entregue_em_epoch: null, fechado_em: null,
      historico: [{ em: isoLocal(ms, tz), por: porDe(quem), de: null, para: 'fazendo' }],
    };
    gravar({ proximo_id: id + 1, pedidos: [...dados.pedidos, t] }, ms);
    return { status: 201, corpo: { ok: true, pedido: leitura(t, true) } };
  }

  function guarda(p, novo) {
    gravar({ proximo_id: dados.proximo_id, pedidos: dados.pedidos.map((x) => (x.id === p.id ? novo : x)) }, agoraMs());
    return novo;
  }

  async function mudar(p, corpo, quem, ms) {
    const erros = {};
    if (corpo.estado === undefined) erros.estado = `obrigatório: ${[...ESTADOS_DO_AGENTE].join(', ')}`;
    else if (!ESTADOS.includes(corpo.estado)) erros.estado = `valores aceitos: ${ESTADOS.join(', ')}`;
    if (Object.keys(erros).length) return { status: 400, erros };
    const novo = corpo.estado;

    if (quem.tipo === 'agente') {
      if (!doAgente(p, quem)) return { status: 403, erro: `O pedido #${p.id} não é deste agente (${quem.slug}); o agente só mexe nos próprios.` };
      if (novo === 'feito') return { status: 403, erro: `O agente não marca o pedido #${p.id} como feito: quem faz isso é o dono, ao abrir o item na tela ou ao responder na conversa depois da entrega. Marque como "entregue".` };
    } else if (novo !== 'feito' && novo !== 'cancelado') {
      return { status: 403, erro: 'O dono só marca pedido como "feito" ou "cancelado". Os outros estados são do agente.' };
    }
    if (!ABERTOS.has(p.estado)) {
      return { status: 409, erro: `O pedido #${p.id} já está ${p.estado}${p.fechado_em ? ` (desde ${p.fechado_em})` : ''} e não muda mais. Se há trabalho novo, crie outro pedido.` };
    }

    const motivo = textoCampo(corpo.motivo, 'motivo', LIMITES.motivo, {}, erros);
    if (novo === 'esperando_dono' && !motivo && !erros.motivo) erros.motivo = 'obrigatório em esperando_dono: diga o que você precisa do dono';
    if (novo === 'cancelado' && quem.tipo === 'agente' && !motivo && !erros.motivo) erros.motivo = 'obrigatório ao cancelar: diga por que o pedido foi cancelado';
    let msg;
    let aviso;
    if (novo === 'entregue') {
      if (corpo.msg !== undefined && corpo.msg !== null && !(ehTexto(corpo.msg) && RX_MSG.test(corpo.msg))) erros.msg = 'precisa ser o id da mensagem da entrega (16 caracteres, 0-9 e a-f), como aparece na conversa';
    }
    if (Object.keys(erros).length) return { status: 400, erros };

    if (novo === 'entregue') {
      const r = await mensagensDe(p.agente);
      if (corpo.msg) {
        if (r.erro) return { status: 503, erro: `${r.erro} Não dá para conferir a mensagem ${corpo.msg}; tente de novo em instantes.` };
        const m = r.msgs.find((x) => x.id === corpo.msg);
        if (!m) return { status: 400, erros: { msg: `não achei a mensagem ${corpo.msg} na conversa de ${p.agente}. Use o id de uma mensagem sua ou tire --msg para usar a última.` } };
        if (p.criado_em_epoch && m.ep < p.criado_em_epoch) return { status: 400, erros: { msg: `a mensagem ${corpo.msg} é anterior à criação do pedido #${p.id}. A entrega tem de ser uma mensagem sua depois que o pedido foi aberto.` } };
        if (m.origin !== 'agente') return { status: 400, erros: { msg: `a mensagem ${corpo.msg} não é do agente. A entrega é uma mensagem sua na conversa.` } };
        msg = { id: m.id, ep: m.ep };
      } else if (r.erro) {
        aviso = `Marquei como entregue, mas sem apontar a mensagem: ${r.erro} O dono abre o item e vai para a conversa, sem pular até a mensagem.`;
      } else {
        // mesmo limite do --msg explícito: a entrega é uma mensagem do agente depois que o pedido foi aberto
        const suas = r.msgs.filter((m) => m.origin === 'agente' && !m.sistema && !(p.criado_em_epoch && m.ep < p.criado_em_epoch));
        const ultima = suas[suas.length - 1];
        if (ultima) msg = { id: ultima.id, ep: ultima.ep };
        else aviso = 'Marquei como entregue, mas a conversa ainda não tem mensagem sua posterior à criação do pedido para apontar.';
      }
      // o pedido pode ter mudado durante a leitura da conversa
      if (!carregar()) return { status: 503, erro: falha };
      const atual = dados.pedidos.find((x) => x.id === p.id);
      if (!atual || !ABERTOS.has(atual.estado)) return { status: 409, erro: `O pedido #${p.id} mudou enquanto eu conferia a conversa. Releia e tente de novo.` };
      p = atual;
    }

    if (p.estado === novo && !(novo === 'entregue' && msg && (!p.msg_entrega || p.msg_entrega.id !== msg.id))) {
      return { status: 200, corpo: { ok: true, pedido: leitura(p, true), ja_estava: true } };
    }
    // o horário é tomado agora, depois das esperas assíncronas e da revalidação do estado
    const gravado = guarda(p, mover(p, novo, { por: porDe(quem), ms: agoraMs(), motivo, msg }));
    const resp = { ok: true, pedido: leitura(gravado, true) };
    if (aviso) resp.aviso = aviso;
    return { status: 200, corpo: resp };
  }

  function abrir(p, quem, ms) {
    if (quem.tipo !== 'dono') return { status: 403, erro: 'Abrir o item é um gesto do dono, pela tela. O agente marca o pedido como "entregue".' };
    if (p.estado !== 'entregue') return { status: 200, corpo: { ok: true, pedido: leitura(p, true), mudou: false } };
    const gravado = guarda(p, mover(p, 'feito', { por: porDe(quem) + ' abriu', ms }));
    return { status: 200, corpo: { ok: true, pedido: leitura(gravado, true), mudou: true } };
  }

  function listar(req, url, quem, ms) {
    const q = url.searchParams;
    const erros = {};
    let agentes = null;
    const slugs = slugsDoRegistro();
    if (!slugs) return { status: 503, erro: registro.estado().erro };
    const bruto = q.get('agente');
    if (quem.tipo === 'agente') {
      if (bruto !== null && bruto !== quem.slug) return { status: 403, erro: `O agente ${quem.slug} só vê os próprios pedidos (veio agente=${bruto.slice(0, 40)}).` };
      agentes = [quem.slug];
    } else if (bruto !== null) {
      agentes = bruto.split(',').map((s) => s.trim()).filter(Boolean);
      const falsos = agentes.filter((s) => !slugs.includes(s));
      if (!agentes.length || falsos.length) erros.agente = `${falsos.length ? `não existe: ${falsos.join(', ')}. ` : 'veio vazio. '}Agentes que existem: ${slugs.join(', ')}`;
    }
    let estados = null;
    if (q.get('estado') !== null) {
      estados = q.get('estado').split(',').map((s) => s.trim()).filter(Boolean);
      const falsos = estados.filter((s) => !ESTADOS.includes(s));
      if (!estados.length || falsos.length) erros.estado = `valores aceitos: ${ESTADOS.join(', ')}`;
    }
    const hoje = diaLocal(ms, tz);
    const ontem = diaLocal(ms - 86400000, tz);
    const dia = q.get('dia') || 'recentes';
    if (!['recentes', 'hoje', 'todos'].includes(dia)) {
      const ok = RX_DIA.test(dia) && !Number.isNaN(Date.parse(dia + 'T00:00:00Z')) && new Date(dia + 'T00:00:00Z').toISOString().startsWith(dia);
      if (!ok) erros.dia = 'use recentes (padrão: hoje e ontem), hoje, todos (inclui os arquivados) ou uma data AAAA-MM-DD válida';
    }
    if (Object.keys(erros).length) return { status: 400, erros };

    const filtro = { agente: agentes, estado: estados, dia };
    const etag = `"${crypto.createHash('sha1').update(`${rev}|${JSON.stringify(filtro)}|${hoje}|${Math.floor(ms / 60000)}`).digest('hex').slice(0, 16)}"`;
    const cab = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    if (req.headers['if-none-match'] === etag) return { status: 304, cab };

    const noDia = (p) => {
      if (ABERTOS.has(p.estado) || dia === 'todos') return true;
      const d = p.fechado_em ? diaLocal(Date.parse(p.fechado_em), tz) : null;
      if (dia === 'recentes') return d === hoje || d === ontem;
      return d === (dia === 'hoje' ? hoje : dia);
    };
    const pedidos = dados.pedidos
      .filter((p) => !agentes || agentes.includes(p.agente))
      .filter((p) => quem.tipo !== 'agente' || doAgente(p, quem))
      .filter((p) => !estados || estados.includes(p.estado))
      .filter(noDia)
      .sort(ordem)
      .map((p) => leitura(p, false));
    const contagem = {
      abertos: pedidos.filter((p) => p.aberto).length,
      esperando_dono: pedidos.filter((p) => p.estado === 'esperando_dono').length,
      entregues: pedidos.filter((p) => p.estado === 'entregue').length,
      fazendo: pedidos.filter((p) => p.estado === 'fazendo').length,
    };
    return { status: 200, cab, corpo: { ok: true, pedidos, agora: isoLocal(ms, tz), filtro, contagem } };
  }

  // ── despacho ───────────────────────────────────────────────────────────
  function responde(res, r) {
    if (r.status === 304) { res.writeHead(304, r.cab); res.end(); return; }
    if (r.erro || r.erros) {
      const frase = r.erro || `Pedido recusado: ${Object.entries(r.erros).map(([k, m]) => `${k} ${m}`).join('; ')}.`;
      H.erroJson(res, r.status, frase, r.erros ? { erros: r.erros } : undefined);
      return;
    }
    H.enviaJson(res, r.status, r.corpo, r.cab);
  }

  async function rota(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== '/api/v1/pedidos' && !p.startsWith('/api/v1/pedidos/')) return false;
    const m = req.method;
    const partes = p.slice('/api/v1/pedidos'.length).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

    try {
      if (partes[0] === 'docs.md' && partes.length === 1) {
        if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ler a documentação da fila de pedidos.'); return true; }
        let texto;
        try { texto = fs.readFileSync(docsPath); } catch (e) {
          log('erro', `Não achei a documentação da fila de pedidos em ${docsPath} (${e.code || e.message}). Reinstale o DG Claw Web.`);
          H.erroJson(res, 500, 'A documentação da fila de pedidos não está instalada neste servidor. Reinstale o DG Claw Web.');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': texto.length, 'Cache-Control': 'no-store' });
        res.end(texto);
        return true;
      }

      let id = null;
      if (partes.length) {
        if (!/^\d{1,9}$/.test(partes[0])) { H.erroJson(res, 400, `O id do pedido precisa ser um número. Recebi ${JSON.stringify(partes[0].slice(0, 40))}. Use /api/v1/pedidos/<número>.`); return true; }
        id = Number(partes[0]);
      }
      const acao = partes[1] || null;
      if (partes.length > 2 || (acao && acao !== 'abrir')) { H.erroJson(res, 404, `Não existe ${m} ${p.slice(0, 120)}. Veja /api/v1/pedidos/docs.md.`); return true; }
      const permitidos = id === null ? ['GET', 'POST'] : acao === 'abrir' ? ['POST'] : ['GET', 'PATCH', 'DELETE'];
      if (!permitidos.includes(m)) {
        H.erroJson(res, 405, id === null ? 'Use GET para listar ou POST para criar um pedido (só o agente cria).'
          : acao === 'abrir' ? 'Use POST para abrir o item.' : 'Use GET para ler, PATCH para mudar o estado ou DELETE para cancelar o pedido.');
        return true;
      }

      if (!carregar()) { H.erroJson(res, 503, falha); return true; }
      const quem = quemChamou(sessao);
      if (quem.tipo === 'agente') quem.inst = instanciaAtual(quem.slug);
      const ms = agoraMs();

      let corpo = {};
      if (m === 'POST' || m === 'PATCH' || m === 'DELETE') {
        try { corpo = await H.lerJson(req, MAX_CORPO); } catch (e) {
          if (!e.status) throw e;
          H.erroJson(res, e.status, e.status === 413 ? `O corpo do pedido passou de ${MAX_CORPO / 1024} KB. Mande menos texto.` : e.message);
          return true;
        }
        if (Array.isArray(corpo)) { H.erroJson(res, 400, 'O corpo precisa ser um objeto JSON ({...}), não uma lista.'); return true; }
        if (!carregar()) { H.erroJson(res, 503, falha); return true; }
      }

      if (id === null) {
        responde(res, m === 'GET' ? listar(req, url, quem, ms) : criar(corpo, quem, ms));
        return true;
      }
      const ped = dados.pedidos.find((x) => x.id === id);
      // Para o agente, o pedido de outro não existe: nem confirma que o número está em uso.
      if (!ped || (quem.tipo === 'agente' && !doAgente(ped, quem))) {
        H.erroJson(res, 404, `Não existe o pedido #${id}${quem.tipo === 'agente' ? ' entre os seus' : ''}. Veja a lista em GET /api/v1/pedidos (os fechados há muito tempo saem da fila).`);
        return true;
      }
      if (m === 'GET') { H.enviaJson(res, 200, { ok: true, pedido: leitura(ped, true) }); return true; }
      if (acao === 'abrir') { responde(res, abrir(ped, quem, ms)); return true; }
      const entrada = m === 'DELETE' ? { estado: 'cancelado', motivo: corpo.motivo } : corpo;
      responde(res, await mudar(ped, entrada, quem, ms));
      return true;
    } catch (e) {
      if (e.status === 503) { H.erroJson(res, 503, e.message); return true; }
      log('erro', `Falha inesperada na fila de pedidos em ${req.method} ${p}: ${e.stack || e.message}. Mande esta linha ao suporte.`);
      H.erroJson(res, 500, 'Erro interno ao tratar o pedido. O erro foi registrado no log do Web; tente de novo.');
      return true;
    }
  }

  return { rota, donoRespondeu, entreguesDe };
}

module.exports = { criarPedidos, ESTADOS, ABERTOS };
