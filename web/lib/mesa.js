'use strict';
// Mesa de tarefas: o que cada agente está fazendo, numa tela só. Contrato em web/docs/MESA.md.
// Estado em <dados>/mesa/tarefas.json (0600, substituição atômica). Arquivo inválido nunca é
// sobrescrito: todas as rotas respondem 503 com o motivo até alguém corrigir.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');

const MAX_CORPO = 64 * 1024;
const PARADA_MIN = 45;
const MAX_EVENTOS = 50;
const MAX_FECHADAS = 5000;
const DIAS_FECHADAS = 90;
const MAX_PASSOS = 30;
const MAX_ANEXOS = 20;
const LIMITES = { titulo: 120, origem: 300, motivo: 300, nota: 200, passo: 120, rotulo: 120, url: 2000 };

const TIPOS = ['conteudo', 'desenvolvimento', 'projeto', 'outro'];
const ESTADOS = ['fazendo', 'travada', 'esperando_dono', 'concluida', 'cancelada'];
const ABERTOS = new Set(['fazendo', 'travada', 'esperando_dono']);
const PEDEM_MOTIVO = new Set(['travada', 'esperando_dono']);
const CAMPOS_COMPARADOS = ['titulo', 'origem', 'tipo', 'estado', 'motivo', 'progresso', 'passos', 'nota', 'link', 'anexos'];
const RX_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RX_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ── tempo ────────────────────────────────────────────────────────────────
const formatadores = new Map();
function partesLocais(ms, tz) {
  let f = formatadores.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatadores.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** "AAAA-MM-DD" do instante no fuso. */
function diaLocal(ms, tz) {
  const o = partesLocais(ms, tz);
  return `${o.year}-${o.month}-${o.day}`;
}

/** ISO 8601 com o offset do fuso (ex.: 2026-10-05T15:45:00-03:00). */
function isoLocal(ms, tz) {
  const o = partesLocais(ms, tz);
  const comoUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  const off = Math.round((comoUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const sinal = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}:${o.second}${sinal}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// ── validação (funções puras) ────────────────────────────────────────────
const ehTexto = (v) => typeof v === 'string';
const umaLinha = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

function urlValida(s) {
  if (!ehTexto(s) || !s || s.length > LIMITES.url || /[\s\x00-\x1f]/.test(s)) return false;
  if (s.startsWith('/')) return !s.startsWith('//') && !s.startsWith('/\\');
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) { return false; }
}

function textoCampo(v, nome, max, { obrigatorio, anulavel }, erros) {
  if (v === undefined && obrigatorio) { erros[nome] = 'obrigatório: faltou no pedido'; return undefined; }
  if (v === null || (ehTexto(v) && !v.trim())) {
    if (obrigatorio) { erros[nome] = 'obrigatório (texto não vazio)'; return undefined; }
    if (anulavel) return null;
  }
  if (!ehTexto(v)) { erros[nome] = `precisa ser texto${anulavel ? ' ou null' : ''}`; return undefined; }
  const t = umaLinha(v);
  if (t.length > max) { erros[nome] = `passou de ${max} caracteres (tem ${t.length})`; return undefined; }
  return t;
}

function validaAnexos(lista, nome, erros) {
  if (!Array.isArray(lista)) { erros[nome] = 'precisa ser uma lista de {rotulo, url}'; return undefined; }
  if (lista.length > MAX_ANEXOS) { erros[nome] = `no máximo ${MAX_ANEXOS} links (vieram ${lista.length})`; return undefined; }
  const saida = [];
  for (let i = 0; i < lista.length; i++) {
    const it = lista[i];
    const url = ehTexto(it) ? it : it && it.url;
    const rotulo = ehTexto(it) ? null : it && it.rotulo;
    if (!urlValida(url)) { erros[nome] = `o item ${i + 1} precisa de "url" começando com http://, https:// ou / (recebi ${JSON.stringify(url === undefined ? null : String(url).slice(0, 60))})`; return undefined; }
    if (rotulo != null && (!ehTexto(rotulo) || umaLinha(rotulo).length > LIMITES.rotulo)) { erros[nome] = `o item ${i + 1} tem "rotulo" inválido (texto até ${LIMITES.rotulo} caracteres)`; return undefined; }
    saida.push({ rotulo: rotulo ? umaLinha(rotulo) : url, url });
  }
  return saida;
}

function validaPassos(lista, erros) {
  if (lista === null) return [];
  if (!Array.isArray(lista)) { erros.passos = 'precisa ser uma lista de {texto, feito} ou de textos'; return undefined; }
  if (lista.length > MAX_PASSOS) { erros.passos = `no máximo ${MAX_PASSOS} passos (vieram ${lista.length})`; return undefined; }
  const saida = [];
  for (let i = 0; i < lista.length; i++) {
    const it = lista[i];
    const texto = ehTexto(it) ? it : it && it.texto;
    if (!ehTexto(texto) || !texto.trim()) { erros.passos = `o passo ${i + 1} precisa de "texto" não vazio`; return undefined; }
    const t = umaLinha(texto);
    if (t.length > LIMITES.passo) { erros.passos = `o passo ${i + 1} passou de ${LIMITES.passo} caracteres (tem ${t.length})`; return undefined; }
    if (!ehTexto(it) && it.feito !== undefined && typeof it.feito !== 'boolean') { erros.passos = `o passo ${i + 1} tem "feito" que não é true/false`; return undefined; }
    saida.push({ texto: t, feito: !ehTexto(it) && it.feito === true });
  }
  return saida;
}

/**
 * Valida e normaliza o corpo do pedido. modo 'criar' exige titulo e origem.
 * Devolve { erros, v } com só os campos que vieram. Não olha o estado atual da tarefa.
 */
function normalizaEntrada(corpo, modo) {
  const erros = {};
  const v = {};
  const tem = (k) => corpo[k] !== undefined;

  if (tem('titulo') || modo === 'criar') { const t = textoCampo(corpo.titulo, 'titulo', LIMITES.titulo, { obrigatorio: true }, erros); if (t !== undefined) v.titulo = t; }
  if (tem('origem') || modo === 'criar') { const t = textoCampo(corpo.origem, 'origem', LIMITES.origem, { obrigatorio: true }, erros); if (t !== undefined) v.origem = t; }
  for (const [k, max] of [['motivo', LIMITES.motivo], ['nota', LIMITES.nota]]) {
    if (tem(k)) { const t = textoCampo(corpo[k], k, max, { anulavel: true }, erros); if (t !== undefined) v[k] = t; }
  }
  if (tem('tipo')) {
    if (TIPOS.includes(corpo.tipo)) v.tipo = corpo.tipo; else erros.tipo = `valores aceitos: ${TIPOS.join(', ')}`;
  }
  if (tem('estado')) {
    const e = corpo.estado === 'esperando_danilo' ? 'esperando_dono' : corpo.estado;
    if (ESTADOS.includes(e)) v.estado = e; else erros.estado = `valores aceitos: ${ESTADOS.join(', ')} (esperando_danilo vale como esperando_dono)`;
  }
  if (tem('progresso')) {
    if (corpo.progresso === null) v.progresso = null;
    else if (typeof corpo.progresso === 'number' && Number.isFinite(corpo.progresso) && corpo.progresso >= 0 && corpo.progresso <= 100) v.progresso = Math.round(corpo.progresso);
    else erros.progresso = 'precisa ser um número de 0 a 100, ou null';
  }
  if (tem('link')) {
    if (corpo.link === null || corpo.link === '') v.link = null;
    else if (urlValida(corpo.link)) v.link = corpo.link;
    else erros.link = 'precisa começar com http://, https:// ou / (caminho do próprio Web)';
  }
  if (tem('passos')) { const p = validaPassos(corpo.passos, erros); if (p !== undefined) v.passos = p; }
  if (tem('anexos')) {
    if (tem('anexos_add') || tem('anexos_remover')) erros.anexos = 'não combina com anexos_add nem anexos_remover no mesmo pedido';
    else { const a = validaAnexos(corpo.anexos, 'anexos', erros); if (a !== undefined) v.anexos = a; }
  }
  if (modo === 'editar') {
    if (tem('anexos_add')) { const a = validaAnexos(corpo.anexos_add, 'anexos_add', erros); if (a !== undefined) v.anexos_add = a; }
    if (tem('anexos_remover')) {
      if (Array.isArray(corpo.anexos_remover) && corpo.anexos_remover.every(ehTexto)) v.anexos_remover = corpo.anexos_remover;
      else erros.anexos_remover = 'precisa ser uma lista de URLs';
    }
    for (const k of ['passo_feito', 'passo_desfeito']) {
      if (!tem(k)) continue;
      const x = corpo[k];
      if ((typeof x === 'number' && Number.isInteger(x)) || (ehTexto(x) && x.trim())) v[k] = x;
      else erros[k] = 'precisa ser o número do passo (começa em 1) ou o texto exato dele';
    }
  }
  if (tem('avisar_agente')) {
    if (typeof corpo.avisar_agente === 'boolean') v.avisar_agente = corpo.avisar_agente;
    else erros.avisar_agente = 'precisa ser true ou false';
  }
  return { erros, v };
}

// ── leitura calculada ────────────────────────────────────────────────────
/** Progresso e origem: concluída 100; informado vence; senão passos; senão null (nunca 0). */
function calculaProgresso(t) {
  if (t.estado === 'concluida') return { progresso: 100, progresso_origem: 'concluida' };
  if (typeof t.progresso === 'number') return { progresso: t.progresso, progresso_origem: 'informado' };
  if (Array.isArray(t.passos) && t.passos.length) {
    const feitos = t.passos.filter((p) => p.feito).length;
    return { progresso: Math.round((feitos / t.passos.length) * 100), progresso_origem: 'passos' };
  }
  return { progresso: null, progresso_origem: null };
}

/** A tarefa como o cliente vê: campos gravados mais os calculados. */
function calculaLeitura(t, agoraMs, comEventos) {
  const decorrido = Math.max(0, agoraMs - t.atualizada_em_epoch * 1000);
  const aberta = ABERTOS.has(t.estado);
  const saida = {
    id: t.id, agente: t.agente, titulo: t.titulo, origem: t.origem, tipo: t.tipo, estado: t.estado,
    aberta, parada: t.estado === 'fazendo' && decorrido > PARADA_MIN * 60000,
    ...calculaProgresso(t),
    motivo: t.motivo, nota: t.nota, passos: t.passos, link: t.link, anexos: t.anexos,
    versao: String(t.versao), criada_por: t.criada_por, criada_em: t.criada_em,
    atualizada_em: t.atualizada_em, atualizada_em_epoch: t.atualizada_em_epoch,
    concluida_em: t.concluida_em, fechada_em: t.fechada_em,
    atualizada_ha_min: Math.floor(decorrido / 60000),
  };
  if (comEventos) saida.eventos = t.eventos;
  return saida;
}

function rankDaMesa(l) {
  if (l.estado === 'esperando_dono') return 0;
  if (l.estado === 'travada') return 1;
  if (l.estado === 'fazendo') return l.parada ? 2 : 3;
  return l.estado === 'concluida' ? 4 : 5;
}

/** Comparador da mesa: grupo (esperando o dono, travada, parada?, fazendo, concluída, cancelada); dentro, a mais recente. */
function ordemDaMesa(a, b) {
  return rankDaMesa(a) - rankDaMesa(b) || b.atualizada_em_epoch - a.atualizada_em_epoch || b.id - a.id;
}

// ── a mesa ───────────────────────────────────────────────────────────────
function criarMesa(opcoes) {
  const o = opcoes || {};
  const { arquivo, registro, runner } = o;
  const log = o.log || H.logPadrao;
  const tz = o.tz || 'UTC';
  const avisarDono = o.avisarDono || null;
  const relogio = o.agora || (() => Date.now());
  const agoraMs = () => { const a = relogio(); return a instanceof Date ? a.getTime() : Number(a); };
  const quemChamou = o.quemChamou || ((s) => (s && s.via === 'caixa' && typeof s.agente === 'string'
    ? { tipo: 'agente', slug: s.agente }
    : Object.assign({ tipo: 'dono', usuario: s && s.usuario }, s && typeof s.pode === 'function' ? { pode: s.pode } : {})));
  const docsPath = path.join(__dirname, '..', 'docs', 'MESA.md');

  let dados = null;        // { versao, proximo_id, tarefas }
  let assinatura = null;   // mtime:tamanho do que lemos/gravamos por último
  let falha = null;        // motivo do 503 enquanto o arquivo estiver inválido
  let ultimaFalhaLogada = null;
  let rev = agoraMs();     // muda a cada gravação (e é diferente a cada processo): base do ETag
  const recadosPendentes = new Set();

  function avisaFalha(motivo, qualEra) {
    falha = motivo;
    if (ultimaFalhaLogada !== motivo) { ultimaFalhaLogada = motivo; log('erro', `${motivo} ${qualEra}`); }
  }

  function assinaturaDoArquivo() {
    try { const st = fs.statSync(arquivo); return `${st.mtimeMs}:${st.size}`; } catch (e) { return e.code === 'ENOENT' ? 'ausente' : `erro:${e.code}`; }
  }

  /** Carrega (ou recarrega, se o arquivo mudou por fora). Devolve true se a mesa está utilizável. */
  function carregar() {
    const atual = assinaturaDoArquivo();
    if (dados && !falha && atual === assinatura) return true;
    if (atual === 'ausente') {
      dados = { versao: 1, proximo_id: 1, tarefas: [] };
      assinatura = atual; falha = null; ultimaFalhaLogada = null;
      return true;
    }
    let texto;
    try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) {
      avisaFalha(`A mesa de tarefas não abriu: não consegui ler ${arquivo} (${e.code || e.message}). O arquivo não foi alterado.`,
        'Confira as permissões da pasta de dados do Web; a Mesa tenta de novo no próximo pedido.');
      dados = null; assinatura = null;
      return false;
    }
    try {
      const d = JSON.parse(texto);
      if (!d || d.versao !== 1 || !Array.isArray(d.tarefas) || !Number.isInteger(d.proximo_id) || d.proximo_id < 1) {
        throw new Error('formato inesperado (esperava {"versao":1,"proximo_id":N,"tarefas":[...]})');
      }
      dados = d; assinatura = atual; falha = null; ultimaFalhaLogada = null;
      return true;
    } catch (e) {
      avisaFalha(`A mesa de tarefas não abriu: o arquivo ${arquivo} está inválido (${e.message}). O arquivo não foi alterado.`,
        'Corrija o JSON ou restaure o backup; a Mesa o relê sozinha quando ele mudar. Nada é gravado enquanto isso.');
      dados = null; assinatura = null;
      return false;
    }
  }

  function poda(tarefas, ms) {
    const corte = ms - DIAS_FECHADAS * 86400000;
    let saida = tarefas.filter((t) => ABERTOS.has(t.estado) || !t.fechada_em || (Date.parse(t.fechada_em) || ms) >= corte);
    const fechadas = saida.filter((t) => !ABERTOS.has(t.estado));
    if (fechadas.length > MAX_FECHADAS) {
      const fora = new Set(fechadas.sort((a, b) => a.atualizada_em_epoch - b.atualizada_em_epoch).slice(0, fechadas.length - MAX_FECHADAS).map((t) => t.id));
      saida = saida.filter((t) => !fora.has(t.id));
    }
    return saida;
  }

  /** Grava o novo estado (temporário + fsync + rename). Lança Error com a frase pronta se falhar. */
  function gravar(novo, ms) {
    const final = { versao: 1, proximo_id: novo.proximo_id, tarefas: poda(novo.tarefas, ms) };
    const pasta = path.dirname(arquivo);
    const tmp = path.join(pasta, `.tarefas.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let fd = null;
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(final));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, arquivo);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* já fechando por erro */ } }
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* temporário órfão não atrapalha */ }
      const msg = `Não consegui gravar a mesa em ${arquivo} (${e.code || e.message}). Nada foi alterado. Confira espaço e permissões da pasta ${pasta}.`;
      log('erro', msg);
      const err = new Error(msg); err.status = 503; throw err;
    }
    dados = final; assinatura = assinaturaDoArquivo(); rev += 1;
  }

  // ── pedido ─────────────────────────────────────────────────────────────
  function listaDeSlugs() {
    const est = registro.estado();
    return est.ok ? est.agentes.map((a) => a.slug) : null;
  }

  function por(quem) { return quem.tipo === 'agente' ? `agente ${quem.slug}` : `dono (${quem.usuario || 'sessão'})`; }

  function recado(agente, texto, tarefaId) {
    const ag = registro.obter(agente);
    if (!ag) {
      log('aviso', `Não mandei o recado da tarefa #${tarefaId}: o agente ${agente} não está no registro. Peça ao agente que confira a mesa em /mesa.`);
      return 'nao_enviado';
    }
    const p = Promise.resolve()
      .then(() => runner.input(ag, { text: texto, submit: true, injectWhenIdle: true }))
      .then((r) => {
        if (!r || !r.ok) log('aviso', `O recado [Mesa] da tarefa #${tarefaId} para ${agente} falhou: ${r && r.erro ? String(r.erro).replace(/\.+$/, '') : 'sem resposta do runner'}. A tarefa foi gravada; o agente vê a mudança ao consultar a mesa.`);
      })
      .catch((e) => log('aviso', `O recado [Mesa] da tarefa #${tarefaId} para ${agente} falhou (${e.message}). A tarefa foi gravada; o agente vê a mudança ao consultar a mesa.`))
      .finally(() => recadosPendentes.delete(p));
    recadosPendentes.add(p);
    return 'agendado';
  }

  function notifica(agenteSlug, t, motivo) {
    if (!avisarDono) return;
    const ag = registro.obter(agenteSlug);
    const nome = ag ? ag.nome : agenteSlug;
    const aviso = { titulo: t.estado === 'travada' ? `${nome} travou` : `${nome} precisa de você`, corpo: motivo, tag: `mesa-${t.id}`, url: `/mesa#t${t.id}` };
    Promise.resolve().then(() => avisarDono(aviso)).catch((e) => log('aviso', `Não consegui avisar o dono da tarefa #${t.id} (${e.message}). A tarefa continua no topo da mesa em /mesa.`));
  }

  const curto = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function textoDoRecado(acao, t, mudancas, motivoCancel) {
    const ref = `#${t.id} "${curto(t.titulo, 60)}"`;
    let corpo;
    if (acao === 'criou') corpo = `O dono criou a tarefa ${ref} para você (origem: ${curto(t.origem, 120)})`;
    else if (acao === 'concluiu') corpo = `O dono concluiu a tarefa ${ref}`;
    else if (acao === 'cancelou') corpo = `O dono cancelou a tarefa ${ref}${motivoCancel ? `: motivo "${curto(motivoCancel, 120)}"` : ''}`;
    else if (acao === 'reabriu') corpo = `O dono reabriu a tarefa ${ref} (estado ${t.estado})`;
    else {
      const partes = [];
      if (mudancas.nota) partes.push(`nota "${curto(String(mudancas.nota.depois || ''), 140)}"`);
      if (mudancas.estado) partes.push(`estado ${mudancas.estado.antes} para ${mudancas.estado.depois}`);
      if (mudancas.motivo) partes.push(`motivo ${mudancas.motivo.depois ? `"${curto(mudancas.motivo.depois, 100)}"` : 'removido'}`);
      for (const k of ['titulo', 'origem', 'tipo', 'progresso', 'passos', 'link', 'anexos']) if (mudancas[k]) partes.push(`${k} alterado`);
      corpo = `O dono ${mudancas.nota ? 'respondeu' : 'mudou'} na tarefa ${ref}: ${partes.join('; ')}`;
    }
    return curto(`[Mesa] ${corpo}`.replace(/\s+/g, ' '), 600);
  }

  /** Procura o passo por número (1..n) ou texto exato. */
  function acharPasso(passos, ref) {
    const porTexto = passos.findIndex((p) => p.texto === ref);
    if (porTexto >= 0) return porTexto;
    const n = typeof ref === 'number' ? ref : (/^\d+$/.test(String(ref).trim()) ? Number(ref) : NaN);
    return Number.isInteger(n) && n >= 1 && n <= passos.length ? n - 1 : -1;
  }

  /** Aplica `v` (entrada já normalizada) a uma cópia da tarefa. Devolve { t, mudancas, erros, acao }. */
  function aplicar(atual, v, ms, motivoCancel) {
    const erros = {};
    const t = structuredClone(atual);
    if (v.titulo !== undefined) t.titulo = v.titulo;
    if (v.origem !== undefined) t.origem = v.origem;
    if (v.tipo !== undefined) t.tipo = v.tipo;
    if (v.progresso !== undefined) t.progresso = v.progresso;
    if (v.nota !== undefined) t.nota = v.nota;
    if (v.link !== undefined) t.link = v.link;
    if (v.passos !== undefined) t.passos = v.passos;
    if (v.anexos !== undefined) t.anexos = v.anexos;
    for (const [campo, valor] of [['passo_feito', true], ['passo_desfeito', false]]) {
      if (v[campo] === undefined) continue;
      const i = acharPasso(t.passos, v[campo]);
      if (i < 0) erros[campo] = t.passos.length ? `passo não encontrado. Use o número (1 a ${t.passos.length}) ou o texto exato: ${t.passos.map((p, k) => `${k + 1}=${JSON.stringify(p.texto)}`).join(', ')}` : 'a tarefa não tem passos';
      else t.passos[i].feito = valor;
    }
    if (v.anexos_add) {
      for (const a of v.anexos_add) {
        const ex = t.anexos.find((x) => x.url === a.url);
        if (ex) ex.rotulo = a.rotulo; else t.anexos.push(a);
      }
      if (t.anexos.length > MAX_ANEXOS) erros.anexos_add = `a tarefa passaria de ${MAX_ANEXOS} links (ficaria com ${t.anexos.length})`;
    }
    if (v.anexos_remover) {
      const faltam = v.anexos_remover.filter((u) => !t.anexos.some((x) => x.url === u));
      if (faltam.length) erros.anexos_remover = `a tarefa não tem: ${faltam.join(', ')}. Links que ela tem: ${t.anexos.map((x) => x.url).join(', ') || '(nenhum)'}`;
      else t.anexos = t.anexos.filter((x) => !v.anexos_remover.includes(x.url));
    }

    const estadoAntes = atual.estado;
    if (v.estado !== undefined) t.estado = v.estado;
    if (PEDEM_MOTIVO.has(t.estado)) {
      if (v.motivo !== undefined) t.motivo = v.motivo;
      if (!t.motivo) erros.motivo = `obrigatório quando o estado é ${t.estado}`;
    } else {
      t.motivo = null;
    }
    if (t.estado === 'cancelada' && motivoCancel && v.nota === undefined) t.nota = curto(`Cancelada: ${motivoCancel}`, LIMITES.nota);

    const mudancas = {};
    for (const k of CAMPOS_COMPARADOS) {
      if (JSON.stringify(atual[k]) !== JSON.stringify(t[k])) mudancas[k] = { antes: atual[k], depois: t[k] };
    }

    const fechando = !ABERTOS.has(t.estado);
    if (fechando && !atual.fechada_em) {
      t.fechada_em = isoLocal(ms, tz);
      t.concluida_em = t.estado === 'concluida' ? t.fechada_em : null;
    } else if (fechando && estadoAntes !== t.estado) {
      t.fechada_em = isoLocal(ms, tz);
      t.concluida_em = t.estado === 'concluida' ? t.fechada_em : null;
    } else if (!fechando) {
      t.fechada_em = null; t.concluida_em = null;
    }

    let acao = 'atualizou';
    if (t.estado !== estadoAntes && t.estado === 'concluida') acao = 'concluiu';
    else if (t.estado !== estadoAntes && t.estado === 'cancelada') acao = 'cancelou';
    else if (!ABERTOS.has(estadoAntes) && ABERTOS.has(t.estado)) acao = 'reabriu';
    else if (!Object.keys(v).some((k) => k !== 'avisar_agente')) acao = 'sinal de vida';
    return { t, mudancas, erros, acao };
  }

  /** Grava a tarefa alterada (ou nova), com evento. Devolve a tarefa gravada. */
  function persistir(tarefa, evento, ms, novaTarefa) {
    tarefa.versao = (tarefa.versao || 0) + 1;
    tarefa.atualizada_em = isoLocal(ms, tz);
    tarefa.atualizada_em_epoch = ms / 1000;
    tarefa.eventos = [...(tarefa.eventos || []), evento].slice(-MAX_EVENTOS);
    const tarefas = novaTarefa ? [...dados.tarefas, tarefa] : dados.tarefas.map((x) => (x.id === tarefa.id ? tarefa : x));
    gravar({ proximo_id: novaTarefa ? tarefa.id + 1 : dados.proximo_id, tarefas }, ms);
    return tarefa;
  }

  function criar(corpo, quem, ms) {
    const { erros, v } = normalizaEntrada(corpo, 'criar');
    const todos = listaDeSlugs();
    if (!todos) return { status: 503, erro: registro.estado().erro };
    // Enterprise: quem.pode (funcionário) só enxerga, e só cria tarefa para, os agentes liberados para ele.
    const slugs = quem.pode ? todos.filter((s) => quem.pode(s)) : todos;
    let agente;
    if (quem.tipo === 'agente') {
      if (corpo.agente !== undefined && corpo.agente !== null && corpo.agente !== quem.slug) {
        return { status: 403, erro: `O agente ${quem.slug} só pode criar tarefa para si mesmo (o pedido veio com agente ${JSON.stringify(String(corpo.agente).slice(0, 40))}). Tire o campo "agente" ou use o seu.` };
      }
      if (!slugs.includes(quem.slug)) return { status: 403, erro: `O agente ${quem.slug} não está no registro de agentes deste Web. Peça ao dono para conferir o registro.` };
      agente = quem.slug;
    } else if (!ehTexto(corpo.agente) || !corpo.agente) {
      erros.agente = `obrigatório: diga para qual agente é a tarefa (${slugs.join(', ')})`;
    } else if (quem.pode && todos.includes(corpo.agente) && !slugs.includes(corpo.agente)) {
      return { status: 403, erro: `Você não tem acesso ao agente ${JSON.stringify(corpo.agente.slice(0, 40))}, então não cria tarefa para ele. Peça ao TI para liberar. Seus agentes: ${slugs.join(', ') || '(nenhum)'}.` };
    } else if (!slugs.includes(corpo.agente)) {
      erros.agente = `não existe o agente ${JSON.stringify(corpo.agente.slice(0, 40))}. Agentes: ${slugs.join(', ')}`;
    } else {
      agente = corpo.agente;
    }
    if (v.estado === 'concluida' || v.estado === 'cancelada') erros.estado = 'uma tarefa nova nasce aberta (fazendo, travada ou esperando_dono)';
    if (Object.keys(erros).length) return { status: 400, erros };

    const estado = v.estado || 'fazendo';
    if (PEDEM_MOTIVO.has(estado) && !v.motivo) return { status: 400, erros: { motivo: `obrigatório quando o estado é ${estado}` } };
    const id = dados.proximo_id;
    const t = {
      id, agente, titulo: v.titulo, origem: v.origem, tipo: v.tipo || 'outro', estado,
      motivo: PEDEM_MOTIVO.has(estado) ? v.motivo : null,
      progresso: v.progresso === undefined ? null : v.progresso,
      nota: v.nota === undefined ? null : v.nota,
      passos: v.passos || [], link: v.link === undefined ? null : v.link, anexos: v.anexos || [],
      versao: 0, criada_por: por(quem), criada_em: isoLocal(ms, tz), atualizada_em: null, atualizada_em_epoch: 0,
      concluida_em: null, fechada_em: null, eventos: [],
    };
    const depois = {};
    for (const k of CAMPOS_COMPARADOS) depois[k] = { antes: null, depois: t[k] };
    persistir(t, { em: isoLocal(ms, tz), por: por(quem), acao: 'criou', mudancas: depois }, ms, true);
    const saida = { status: 201, corpo: { ok: true, tarefa: calculaLeitura(t, ms, true) } };
    if (quem.tipo === 'dono') {
      saida.corpo.recado = v.avisar_agente === false ? 'nao_enviado' : recado(agente, textoDoRecado('criou', t, {}), id);
    } else if (PEDEM_MOTIVO.has(t.estado)) notifica(agente, t, t.motivo);
    return saida;
  }

  function concordaVersao(req, t, corpo) {
    // pela caixa do agente não há cabeçalho: o campo se_versao do corpo faz o mesmo papel
    const h = req.headers['if-match'] !== undefined ? req.headers['if-match'] : (corpo && corpo.se_versao != null ? String(corpo.se_versao) : undefined);
    if (h === undefined || h === '*') return true;
    const pedido = String(h).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    return pedido === String(t.versao);
  }

  function editar(req, t, corpo, quem, ms, comoDelete) {
    if (quem.tipo === 'agente' && t.agente !== quem.slug) {
      return { status: 403, erro: `A tarefa #${t.id} é do agente ${t.agente}; o agente ${quem.slug} só mexe nas próprias. Peça ao dono ou ao ${t.agente}.` };
    }
    if (!concordaVersao(req, t, corpo)) {
      return { status: 412, erro: `A tarefa #${t.id} mudou desde a versão ${JSON.stringify(String(req.headers['if-match'] !== undefined ? req.headers['if-match'] : corpo.se_versao).replace(/"/g, ''))} (agora é a ${t.versao}). Releia a tarefa e refaça a mudança.`, extra: { tarefa: calculaLeitura(t, ms, true) } };
    }
    let entrada;
    let motivoCancel = null;
    if (comoDelete) {
      if (t.estado === 'cancelada') return { status: 200, corpo: { ok: true, tarefa: calculaLeitura(t, ms, true), acao: 'cancelou', ja_estava: true } };
      const m = textoCampo(corpo.motivo, 'motivo', LIMITES.motivo, { anulavel: true }, {});
      motivoCancel = m || null;
      entrada = { erros: {}, v: { estado: 'cancelada' } };
      if (corpo.motivo !== undefined && corpo.motivo !== null && !ehTexto(corpo.motivo)) return { status: 400, erros: { motivo: 'precisa ser texto' } };
      if (ehTexto(corpo.motivo) && umaLinha(corpo.motivo).length > LIMITES.motivo) return { status: 400, erros: { motivo: `passou de ${LIMITES.motivo} caracteres` } };
    } else {
      entrada = normalizaEntrada(corpo, 'editar');
      if (corpo.agente !== undefined && corpo.agente !== t.agente) entrada.erros.agente = `o agente de uma tarefa não muda (é ${t.agente}). Crie outra tarefa para ${ehTexto(corpo.agente) ? corpo.agente.slice(0, 40) : 'o outro agente'}`;
      if (entrada.v.estado === 'cancelada' && entrada.v.motivo) motivoCancel = entrada.v.motivo;
    }
    const r = aplicar(t, entrada.v, ms, motivoCancel);
    const erros = Object.assign({}, entrada.erros, r.erros);
    if (Object.keys(erros).length) return { status: 400, erros };

    persistir(r.t, { em: isoLocal(ms, tz), por: por(quem), acao: r.acao, mudancas: r.mudancas, ...(motivoCancel ? { motivo: motivoCancel } : {}) }, ms, false);
    const corpoResp = { ok: true, tarefa: calculaLeitura(r.t, ms, true), acao: r.acao };
    if (comoDelete) corpoResp.ja_estava = false;
    const mexeu = r.acao !== 'sinal de vida' && (Object.keys(r.mudancas).length > 0 || r.acao !== 'atualizou');
    if (quem.tipo === 'dono') {
      corpoResp.recado = !mexeu || entrada.v.avisar_agente === false ? 'nao_enviado' : recado(r.t.agente, textoDoRecado(r.acao, r.t, r.mudancas, motivoCancel), r.t.id);
    } else if (PEDEM_MOTIVO.has(r.t.estado) && (r.mudancas.estado || r.mudancas.motivo)) {
      notifica(r.t.agente, r.t, r.t.motivo);
    }
    return { status: 200, corpo: corpoResp };
  }

  function listar(req, url, ms, quem) {
    const q = url.searchParams;
    const erros = {};
    let agentes = null;
    const bruto = q.get('agente');
    const pode = quem && quem.pode ? quem.pode : null;   // enterprise: funcionário só vê tarefa dos agentes liberados
    if (bruto !== null) {
      const todos = listaDeSlugs();
      if (!todos) return { status: 503, erro: registro.estado().erro };
      const slugs = pode ? todos.filter(pode) : todos;
      agentes = bruto.split(',').map((s) => s.trim()).filter(Boolean);
      const proibidos = pode ? agentes.filter((s) => todos.includes(s) && !slugs.includes(s)) : [];
      if (proibidos.length) return { status: 403, erro: `Você não tem acesso ao agente ${proibidos.map((s) => JSON.stringify(s.slice(0, 40))).join(', ')}. Peça ao TI para liberar. Seus agentes: ${slugs.join(', ') || '(nenhum)'}.` };
      const falsos = agentes.filter((s) => !slugs.includes(s));
      if (!agentes.length || falsos.length) erros.agente = `${falsos.length ? `não existe: ${falsos.join(', ')}. ` : 'veio vazio. '}Agentes que existem: ${slugs.join(', ')}`;
    }
    let estados = null;
    if (q.get('estado') !== null) {
      estados = q.get('estado').split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s === 'esperando_danilo' ? 'esperando_dono' : s));
      const falsos = estados.filter((s) => !ESTADOS.includes(s));
      if (!estados.length || falsos.length) erros.estado = `valores aceitos: ${ESTADOS.join(', ')}`;
    }
    const hoje = diaLocal(ms, tz);
    let dia = q.get('dia') || 'hoje';
    if (dia === 'hoje') dia = hoje;
    else if (dia !== 'todos') {
      const ok = RX_DIA.test(dia) && !Number.isNaN(Date.parse(dia + 'T00:00:00Z')) && new Date(dia + 'T00:00:00Z').toISOString().startsWith(dia);
      if (!ok) erros.dia = 'use hoje, todos ou uma data AAAA-MM-DD válida';
    }
    if (Object.keys(erros).length) return { status: 400, erros };

    const filtro = { agente: agentes, estado: estados, dia: q.get('dia') || 'hoje' };
    const visiveis = pode ? (listaDeSlugs() || []).filter(pode).join(',') : '';
    const etag = `"${crypto.createHash('sha1').update(`${rev}|${JSON.stringify(filtro)}|${hoje}|${Math.floor(ms / 60000)}${pode ? `|${visiveis}` : ''}`).digest('hex').slice(0, 16)}"`;
    const cab = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    if (req.headers['if-none-match'] === etag) return { status: 304, cab };

    const tarefas = dados.tarefas
      .filter((t) => !pode || pode(t.agente))
      .filter((t) => !agentes || agentes.includes(t.agente))
      .filter((t) => !estados || estados.includes(t.estado))
      .filter((t) => ABERTOS.has(t.estado) || dia === 'todos' || (t.fechada_em && diaLocal(Date.parse(t.fechada_em), tz) === dia))
      .map((t) => calculaLeitura(t, ms, false))
      .sort(ordemDaMesa);
    const contagem = {
      abertas: tarefas.filter((t) => t.aberta).length,
      esperando_dono: tarefas.filter((t) => t.estado === 'esperando_dono').length,
      travadas: tarefas.filter((t) => t.estado === 'travada').length,
      paradas: tarefas.filter((t) => t.parada).length,
    };
    return { status: 200, cab, corpo: { ok: true, tarefas, agora: isoLocal(ms, tz), parada_min: PARADA_MIN, filtro, contagem } };
  }

  // ── despacho ───────────────────────────────────────────────────────────
  function responde(res, r) {
    if (r.status === 304) { res.writeHead(304, r.cab); res.end(); return; }
    if (r.erro || r.erros) {
      const frase = r.erro || `Pedido recusado: ${Object.entries(r.erros).map(([k, m]) => `${k} ${m}`).join('; ')}.`;
      H.erroJson(res, r.status, frase, Object.assign(r.erros ? { erros: r.erros } : {}, r.extra || {}));
      return;
    }
    H.enviaJson(res, r.status, r.corpo, r.cab);
  }

  async function rota(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== '/api/v1/tarefas' && !p.startsWith('/api/v1/tarefas/')) return false;
    const m = req.method;
    const resto = p.slice('/api/v1/tarefas'.length).replace(/^\/+|\/+$/g, '');

    try {
      if (resto === 'docs.md') {
        if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ler a documentação da Mesa.'); return true; }
        let texto;
        try { texto = fs.readFileSync(docsPath); } catch (e) {
          log('erro', `Não achei a documentação da Mesa em ${docsPath} (${e.code || e.message}). Reinstale o DG Claw Web.`);
          H.erroJson(res, 500, 'A documentação da Mesa não está instalada neste servidor. Reinstale o DG Claw Web.');
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': texto.length, 'Cache-Control': 'no-store' });
        res.end(texto);
        return true;
      }

      let id = null;
      if (resto) {
        if (!/^\d+$/.test(resto)) { H.erroJson(res, 400, `O id da tarefa precisa ser um número. Recebi ${JSON.stringify(resto.slice(0, 40))}. Use /api/v1/tarefas/<número>.`); return true; }
        id = Number(resto);
      }
      const permitidos = id === null ? ['GET', 'POST'] : ['GET', 'PATCH', 'DELETE'];
      if (!permitidos.includes(m)) {
        H.erroJson(res, 405, id === null ? 'Use GET para listar a mesa ou POST para criar uma tarefa.' : 'Use GET para ler, PATCH para mudar ou DELETE para cancelar a tarefa.');
        return true;
      }

      if (!carregar()) { H.erroJson(res, 503, falha); return true; }
      const quem = quemChamou(sessao);
      const ms = agoraMs();

      let corpo = {};
      if (m === 'POST' || m === 'PATCH' || m === 'DELETE') {
        try { corpo = await H.lerJson(req, MAX_CORPO); } catch (e) {
          if (!e.status) throw e;
          H.erroJson(res, e.status, e.status === 413 ? `O corpo do pedido passou de ${MAX_CORPO / 1024} KB. Mande menos texto, passos ou links por vez.` : e.message);
          return true;
        }
        if (Array.isArray(corpo)) { H.erroJson(res, 400, 'O corpo precisa ser um objeto JSON ({...}), não uma lista.'); return true; }
        // lerJson foi assíncrono: outro pedido pode ter mexido na mesa nesse meio tempo
        if (!carregar()) { H.erroJson(res, 503, falha); return true; }
      }

      if (id === null) {
        responde(res, m === 'GET' ? listar(req, url, ms, quem) : criar(corpo, quem, ms));
        return true;
      }
      const t = dados.tarefas.find((x) => x.id === id);
      if (!t) { H.erroJson(res, 404, `Não existe a tarefa #${id}. Veja as tarefas em GET /api/v1/tarefas (as fechadas há muito tempo saem da mesa).`); return true; }
      if (quem.tipo === 'dono' && quem.pode && !quem.pode(t.agente)) {
        H.erroJson(res, 403, `A tarefa #${id} é de um agente que você não tem acesso. Peça ao TI para liberar.`);
        return true;
      }
      if (m === 'GET') { H.enviaJson(res, 200, { ok: true, tarefa: calculaLeitura(t, ms, true) }); return true; }
      responde(res, editar(req, t, corpo, quem, ms, m === 'DELETE'));
      return true;
    } catch (e) {
      if (e.status === 503) { H.erroJson(res, 503, e.message); return true; }
      log('erro', `Falha inesperada na Mesa em ${req.method} ${p}: ${e.stack || e.message}. Mande esta linha ao suporte.`);
      H.erroJson(res, 500, 'Erro interno ao tratar a tarefa. O erro foi registrado no log do Web; tente de novo.');
      return true;
    }
  }

  try { fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 }); } catch (e) {
    log('aviso', `Não consegui preparar a pasta da mesa ${path.dirname(arquivo)} (${e.code || e.message}). As rotas da Mesa vão responder 503 até a pasta existir e ser gravável.`);
  }

  return {
    rota,
    /** Espera os recados [Mesa] em andamento (usado pelos testes). */
    async aguardarRecados() { while (recadosPendentes.size) await Promise.allSettled([...recadosPendentes]); },
  };
}

module.exports = {
  criarMesa, normalizaEntrada, calculaLeitura, calculaProgresso, ordemDaMesa, isoLocal, diaLocal,
  PARADA_MIN, ESTADOS, TIPOS, RX_SLUG,
};
