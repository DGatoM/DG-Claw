'use strict';
// Lembretes que insistem até o dono confirmar. O agente (ou o dono, pela tela) agenda; na hora marcada
// o Web avisa por três caminhos (faixa na tela, aviso no aparelho, recado ao agente) e repete a cada
// intervalo até alguém tocar Feito ou Adiar. Contrato completo em docs/LEMBRETES.md.
//
// Estado em <dataDir>/lembretes/lembretes.json (pasta 0700, arquivo 0600, tmp + fsync + rename).
// Arquivo ilegível nunca é substituído por um vazio: as rotas respondem 503 e o agendador não dispara.
// O agendador é um setInterval de 15 s; `tique()` é uma passada só e é o que os testes chamam.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const { quemChamou } = require('./caixa-agente');
const F = require('./lembretes-fuso');

const BASE = '/api/v1/lembretes';
const INTERVALO_TIQUE_MS = 15000;
const INTERVALO_PADRAO_MIN = 5;
const TETO_PADRAO = 12;
const TETO_MAX = 60;
const TITULO_PADRAO = '⏰ Hora do lembrete';
const MAX_TEXTO = 500;
const MAX_TITULO = 80;
const ATRASO_MAX_MS = 3600 * 1000;
const ATRASADO_MS = 30 * 1000;
const MAX_OC_POR_LEMBRETE = 60;
const MAX_PERDIDAS = 50;
const MAX_ENVIOS_GUARDADOS = 60;
const MAX_ADIAMENTOS = 20;
const MAX_POR_AGENTE = 200;
const ORFAS_DIAS = 30;
const MAX_CORPO = 32 * 1024;

const CAMPOS_GRAVAVEIS = ['texto', 'agente', 'regra', 'fim', 'intervalo_min', 'teto_envios', 'pelo_agente', 'titulo'];
const CAMPOS_DISPARO = ['texto', 'agente', 'intervalo_min', 'teto_envios', 'pelo_agente', 'titulo'];
const CAMPOS_CALCULADOS = ['id', 'estado', 'proxima', 'regra_texto', 'criado_por', 'criado_em', 'atualizado_em', 'ultimas_ocorrencias', 'agente_nome'];
const CAMPOS_DA_REGRA = ['hora', 'dias', 'data', 'tipo', 'n', 'inicio'];

const RX_LEMBRETE = /^lem_[0-9a-f]{8}$/;
const RX_OCORRENCIA = /^oc_[0-9a-f]{8}_\d{12}$/;

class ErroLoja extends Error {
  constructor(mensagem) { super(mensagem); this.name = 'ErroLoja'; }
}

function criarLembretes({ config, registro, runner, push, log, agora }) {
  const relogio = agora || (() => Date.now());
  const dirLoja = path.join(config.dataDir, 'lembretes');
  const arqLoja = path.join(dirLoja, 'lembretes.json');

  let tz = config.tz || 'UTC';
  const erroTz = F.erroDoFuso(tz);
  if (erroTz) {
    log('aviso', `Lembretes: o fuso "${tz}" não é válido (${erroTz}). Usei UTC; corrija DGCLAW_WEB_TZ com um nome como America/Sao_Paulo e reinicie o Web.`);
    tz = 'UTC';
  }

  let lembretes = new Map();
  let ocorrencias = new Map();
  let assinatura = null;       // "mtimeMs:size" do arquivo como o Web o leu ou gravou pela última vez
  let falha = null;            // motivo, se o arquivo está ilegível
  let timer = null;
  let emTique = false;
  let ultimoTique = null;
  let erroAgendador = null;
  let ultimoErroLogado = null;

  const iso = (ms) => F.isoLocal(ms, tz);

  // ── disco ──────────────────────────────────────────────────────────────────
  function assinaturaDoArquivo() {
    try {
      const st = fs.statSync(arqLoja);
      return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
      if (e.code === 'ENOENT') return 'ausente';
      throw new ErroLoja(`Não consegui ler ${arqLoja} (${e.code || e.message}). Confira se o Web roda como root e se a pasta de dados existe. Os lembretes ficam parados até isso ser resolvido; nada foi gravado por cima.`);
    }
  }

  function carregar(sig) {
    assinatura = sig;
    falha = null;
    lembretes = new Map();
    ocorrencias = new Map();
    if (sig === 'ausente') return;
    try {
      const d = JSON.parse(fs.readFileSync(arqLoja, 'utf8'));
      if (!d || !Array.isArray(d.lembretes) || !Array.isArray(d.ocorrencias)) throw new Error('faltam as listas "lembretes" e "ocorrencias"');
      for (const l of d.lembretes) lembretes.set(l.id, l);
      for (const o of d.ocorrencias) ocorrencias.set(o.id, o);
    } catch (e) {
      lembretes = new Map();
      ocorrencias = new Map();
      falha = `O arquivo dos lembretes ${arqLoja} está ilegível (${e.message}). Os lembretes estão parados e nada foi gravado por cima. Conserte o JSON ou mova o arquivo para outro lugar (o Web começa vazio); ele relê sozinho quando o arquivo mudar.`;
    }
  }

  /** Relê o arquivo se ele mudou por fora. Lança ErroLoja se estiver ilegível. */
  function garante() {
    const sig = assinaturaDoArquivo();
    if (sig !== assinatura) carregar(sig);
    if (falha) throw new ErroLoja(falha);
  }

  function salvar() {
    const corpo = JSON.stringify({ versao: 1, lembretes: [...lembretes.values()], ocorrencias: [...ocorrencias.values()] });
    const tmp = path.join(dirLoja, `.lembretes-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dirLoja, { recursive: true, mode: 0o700 });
      fs.chmodSync(dirLoja, 0o700);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeSync(fd, corpo); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, arqLoja);
      assinatura = assinaturaDoArquivo();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { if (e2.code !== 'ENOENT') log('aviso', `Lembretes: não consegui apagar o temporário ${tmp} (${e2.code || e2.message}).`); }
      const msg = `Não consegui gravar os lembretes em ${arqLoja} (${e.code || e.message}). Confira o espaço em disco e a permissão da pasta ${dirLoja}. A mudança não foi guardada.`;
      log('erro', msg);
      throw new ErroLoja(msg);
    }
  }

  // ── formas públicas ────────────────────────────────────────────────────────
  const nomeDoAgente = (slug) => { const a = registro.obter(slug); return a ? a.nome : slug; };
  const estadoDe = (l) => (!l.ativo ? 'pausado' : l.proxima_ep == null ? 'encerrado' : 'ativo');
  const passoMs = (o) => o.intervalo_min * 60000;

  function ultimoEnvioEp(o) { return o.envios.length ? o.envios[o.envios.length - 1].ep : null; }

  function proximoEnvioEp(o) {
    if (o.estado === 'adiada') return o.adiada_ate_ep;
    if (o.estado !== 'insistindo' || !o.ciclo_envios || o.ciclo_envios >= o.teto) return null;
    return Math.max(o.ciclo_inicio_ep + o.ciclo_envios * passoMs(o), ultimoEnvioEp(o) + passoMs(o));
  }

  function ocPublica(o) {
    return {
      id: o.id, lembrete_id: o.lembrete_id, agente: o.agente, agente_nome: nomeDoAgente(o.agente), texto: o.texto,
      titulo: o.titulo, agendada_para: iso(o.agendada_ep), estado: o.estado, atrasado: !!o.atrasado,
      envios: o.envios.map((e) => ({ n: e.n, em: e.em, push: e.push, agente: e.agente })),
      total_envios: o.total_envios, teto: o.teto, envio: o.ciclo_envios,
      proximo_envio_em: iso(proximoEnvioEp(o)), adiada_ate: iso(o.adiada_ate_ep), adiamentos: o.adiamentos,
      feito_em: iso(o.feito_ep), feito_por: o.feito_por, feito_origem: o.feito_origem, tarde: !!o.tarde,
      encerrada_em: iso(o.encerrada_ep), motivo: o.motivo,
    };
  }

  const ocsDe = (lid) => [...ocorrencias.values()].filter((o) => o.lembrete_id === lid).sort((a, b) => b.agendada_ep - a.agendada_ep);

  function lemPublico(l, ultimas) {
    return {
      id: l.id, agente: l.agente, agente_nome: nomeDoAgente(l.agente), texto: l.texto, regra: l.regra,
      regra_texto: F.regraEmPortugues(l.regra, l.fim), fim: l.fim, intervalo_min: l.intervalo_min,
      teto_envios: l.teto_envios, pelo_agente: l.pelo_agente, titulo: l.titulo, estado: estadoDe(l),
      proxima: iso(l.proxima_ep), criado_por: l.criado_por, criado_em: l.criado_em, atualizado_em: l.atualizado_em,
      ultimas_ocorrencias: ocsDe(l.id).slice(0, ultimas).map(ocPublica),
    };
  }

  // ── envio ──────────────────────────────────────────────────────────────────
  function recadoAoAgente(o, n) {
    const hora = F.horaLocal(o.agendada_ep, tz);
    const texto = o.texto.replace(/</g, '&lt;');
    const corpo = `[LEMBRETE] envio ${n} de ${o.teto}: "${texto}" (marcado para ${hora}).\n` +
      `Ocorrência ${o.id}. Avise o dono pelo canal que ele usa com você.\n` +
      `Quando ele disser que fez: dgclaw-api POST ${BASE}/ocorrencias/${o.id}/feito\n` +
      `Se pedir para adiar: dgclaw-api POST ${BASE}/ocorrencias/${o.id}/adiar '{"minutos":N}'`;
    // <plataforma ...> é o envelope de recado da máquina: o leitor da conversa não o mostra como fala do dono
    // e o agente sabe que ninguém digitou aquilo.
    return `<plataforma recado="lembrete" tipo="aviso" ts="${new Date(relogio()).toISOString()}">${corpo}</plataforma>`;
  }

  async function enviarPush(o, n) {
    const aviso = {
      titulo: o.titulo,
      corpo: o.texto + (n > 1 ? ` (aviso ${n} de ${o.teto})` : ''),
      tag: 'lembrete-' + o.id,
      url: '/a/' + o.agente + '#lembretes',
      exigir_interacao: true,
      acoes: [
        { acao: 'feito', titulo: '✅ Feito', post: `${BASE}/ocorrencias/${o.id}/feito` },
        { acao: 'adiar', titulo: '⏰ Adiar 10 min', post: `${BASE}/ocorrencias/${o.id}/adiar` },
      ],
    };
    try {
      const r = await push.enviar(aviso);
      if (!r.inscricoes && n === 1) log('info', `Lembrete ${o.id} (${o.agente}): nenhum aparelho com avisos ativados; só a faixa${o.pelo_agente ? ' e o agente' : ''} avisam. O dono ativa em /lembretes.`);
      if (r.falhas && r.falhas.length) log('aviso', `Lembrete ${o.id} (${o.agente}): o aviso no aparelho teve ${r.falhas.length} falha(s): ${r.falhas[0].motivo || 'sem motivo'}.`);
      return r;
    } catch (e) {
      log('erro', `Lembrete ${o.id} (${o.agente}): o aviso no aparelho não saiu (${e.message}). A faixa e o agente seguem avisando.`);
      return { inscricoes: 0, ok: 0, removidas: 0, falhas: [{ id: null, servico: null, status: null, motivo: e.message }] };
    }
  }

  async function enviarAoAgente(o, n) {
    if (!o.pelo_agente) return null;
    const ag = registro.obter(o.agente);
    if (!ag) {
      const erro = `O agente "${o.agente}" não está no registro de agentes; o recado não foi entregue. Confira GET /api/v1/agents.`;
      log('aviso', `Lembrete ${o.id}: ${erro}`);
      return { ok: false, erro };
    }
    try {
      const r = await runner.input(ag, { text: recadoAoAgente(o, n), submit: true, injectWhenIdle: true });
      if (r.ok) return { ok: true };
      log('aviso', `Lembrete ${o.id} (${o.agente}): o recado ao agente não foi entregue: ${r.erro}`);
      return { ok: false, erro: r.erro };
    } catch (e) {
      log('erro', `Lembrete ${o.id} (${o.agente}): falha inesperada ao entregar o recado ao agente (${e.message}).`);
      return { ok: false, erro: e.message };
    }
  }

  /** Um envio por todos os caminhos. Falha de um nunca impede os outros. */
  async function enviarOcorrencia(id, tAgora) {
    const o = ocorrencias.get(id);
    if (!o || o.estado !== 'insistindo') return false;
    o.ciclo_envios += 1;
    o.total_envios += 1;
    if (o.ciclo_envios === 1) o.ciclo_inicio_ep = tAgora;
    const envio = { n: o.ciclo_envios, ep: tAgora, em: iso(tAgora), push: null, agente: null };
    o.envios.push(envio);
    if (o.envios.length > MAX_ENVIOS_GUARDADOS) o.envios.splice(0, o.envios.length - MAX_ENVIOS_GUARDADOS);
    salvar();
    log('info', `Lembrete ${o.id} (${o.agente}): aviso ${envio.n} de ${o.teto}${o.atrasado ? ' (atrasado)' : ''}.`);
    const [rPush, rAgente] = await Promise.all([enviarPush(o, envio.n), enviarAoAgente(o, envio.n)]);
    envio.push = rPush;
    envio.agente = rAgente;
    if (ocorrencias.get(id) === o) {
      try { salvar(); } catch (e) { log('erro', `Lembrete ${o.id}: não guardei o resultado do aviso ${envio.n} (${e.message}).`); }
    }
    return true;
  }

  // ── agendador ──────────────────────────────────────────────────────────────
  const ocId = (l, agEp) => `oc_${l.id.slice(4)}_${F.dataLocal(agEp, tz).replace(/-/g, '')}${F.horaLocal(agEp, tz).replace(':', '')}`;

  function novaOcorrencia(l, agEp, atraso, estado, extra) {
    return Object.assign({
      id: ocId(l, agEp), lembrete_id: l.id, agente: l.agente, texto: l.texto, titulo: l.titulo,
      pelo_agente: l.pelo_agente, intervalo_min: l.intervalo_min, teto: l.teto_envios,
      agendada_ep: agEp, atraso_s: Math.round(atraso / 1000), atrasado: atraso > ATRASADO_MS, estado,
      envios: [], total_envios: 0, ciclo_envios: 0, ciclo_inicio_ep: null,
      adiada_ate_ep: null, adiamentos: 0, feito_ep: null, feito_por: null, feito_origem: null, tarde: false,
      encerrada_ep: null, motivo: null,
    }, extra || {});
  }

  function cancelaInsistencia(lid, motivo, tAgora) {
    for (const o of ocorrencias.values()) {
      if (o.lembrete_id === lid && (o.estado === 'insistindo' || o.estado === 'adiada')) {
        o.estado = 'cancelada';
        o.motivo = motivo;
        o.encerrada_ep = tAgora;
        o.adiada_ate_ep = null;
      }
    }
  }

  function poda(tAgora) {
    const corte = tAgora - ORFAS_DIAS * 86400000;
    for (const [lid, l] of [...lembretes]) {
      if (l.avulso && estadoDe(l) === 'encerrado' && l.criado_ep < corte
        && ![...ocorrencias.values()].some((o) => o.lembrete_id === lid && (o.estado === 'insistindo' || o.estado === 'adiada'))) lembretes.delete(lid);
    }
    const por = new Map();
    for (const o of ocorrencias.values()) {
      if (!por.has(o.lembrete_id)) por.set(o.lembrete_id, []);
      por.get(o.lembrete_id).push(o);
    }
    for (const [lid, lista] of por) {
      lista.sort((a, b) => b.agendada_ep - a.agendada_ep);
      const viva = (o) => o.estado === 'insistindo' || o.estado === 'adiada';
      if (!lembretes.has(lid)) { for (const o of lista) if (!viva(o) && o.agendada_ep < corte) ocorrencias.delete(o.id); continue; }
      for (const o of lista.slice(MAX_OC_POR_LEMBRETE)) if (!viva(o)) ocorrencias.delete(o.id);
    }
  }

  /** Parte síncrona de uma passada: cria ocorrências, fecha tetos, acorda adiadas. Devolve os ids que recebem um envio. */
  function passada(tAgora) {
    const envios = new Set();
    let mudou = false;
    for (const l of lembretes.values()) {
      if (!l.ativo) continue;
      let perdidas = 0;
      while (l.proxima_ep != null && l.proxima_ep <= tAgora) {
        const agEp = l.proxima_ep;
        const atraso = tAgora - agEp;
        const id = ocId(l, agEp);
        if (!ocorrencias.has(id)) {
          if (atraso > ATRASO_MAX_MS) {
            perdidas += 1;
            if (perdidas <= MAX_PERDIDAS) {
              ocorrencias.set(id, novaOcorrencia(l, agEp, atraso, 'perdida', {
                encerrada_ep: tAgora,
                motivo: `o Web estava fora do ar na hora marcada e só voltou ${Math.floor(atraso / 60000)} min depois`,
              }));
            }
          } else {
            ocorrencias.set(id, novaOcorrencia(l, agEp, atraso, 'insistindo'));
            envios.add(id);
          }
        }
        const prox = F.proximaDepois(l.regra, agEp, l.fim, tz);
        l.proxima_ep = prox ? prox.ep : null;
        mudou = true;
      }
      if (perdidas) {
        log('aviso', `Lembrete ${l.id} (${l.agente}): ${perdidas} horário(s) passaram há mais de ${ATRASO_MAX_MS / 60000} min com o Web fora do ar e ficaram como perdidos${perdidas > MAX_PERDIDAS ? ` (guardei só ${MAX_PERDIDAS})` : ''}.`);
      }
    }
    for (const o of ocorrencias.values()) {
      if (o.estado === 'adiada') {
        if (tAgora >= o.adiada_ate_ep) {
          o.estado = 'insistindo';
          o.adiada_ate_ep = null;
          o.ciclo_envios = 0;
          o.ciclo_inicio_ep = null;
          envios.add(o.id);
          mudou = true;
          log('info', `Lembrete ${o.id} (${o.agente}): o adiamento acabou, volta a avisar.`);
        }
        continue;
      }
      if (o.estado !== 'insistindo' || envios.has(o.id)) continue;
      if (!o.ciclo_envios) { envios.add(o.id); continue; }
      if (tAgora >= o.ciclo_inicio_ep + o.teto * passoMs(o)) {
        o.estado = 'sem_resposta';
        o.encerrada_ep = tAgora;
        o.motivo = `${o.ciclo_envios} aviso(s) sem confirmação`;
        mudou = true;
        log('info', `Lembrete ${o.id} (${o.agente}): chegou ao teto de ${o.teto} aviso(s) sem confirmação.`);
      } else if (o.ciclo_envios < o.teto && tAgora >= proximoEnvioEp(o)) {
        envios.add(o.id);
      }
    }
    if (mudou) { poda(tAgora); salvar(); }
    return [...envios];
  }

  function registraErroAgendador(e) {
    erroAgendador = e.message;
    if (ultimoErroLogado !== e.message) {
      ultimoErroLogado = e.message;
      log('erro', `Agendador de lembretes parado nesta passada: ${e.message}`);
    }
  }

  /** Uma passada do agendador. Devolve quantos envios fez. */
  async function tique() {
    if (emTique) return 0;
    emTique = true;
    let feitos = 0;
    try {
      const tAgora = relogio();
      try {
        garante();
        const ids = passada(tAgora);
        erroAgendador = null;
        ultimoErroLogado = null;
        for (const id of ids) if (await enviarOcorrencia(id, tAgora)) feitos += 1;
      } catch (e) {
        registraErroAgendador(e);
        if (!(e instanceof ErroLoja)) log('erro', `Agendador de lembretes: falha inesperada: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`);
      }
      ultimoTique = tAgora;
    } finally { emTique = false; }
    return feitos;
  }

  function iniciar() {
    if (timer) return;
    timer = setInterval(() => { tique().catch((e) => log('erro', `Agendador de lembretes: ${e.message}`)); }, INTERVALO_TIQUE_MS);
    if (timer.unref) timer.unref();
    tique().catch((e) => log('erro', `Agendador de lembretes: ${e.message}`));
  }

  function parar() { if (timer) { clearInterval(timer); timer = null; } }

  // ── validação ──────────────────────────────────────────────────────────────
  const inteiro = (campo, v, min, max, erros, quer) => {
    if (!Number.isInteger(v) || v < min || v > max) { erros[campo] = `veio ${F.veio(v)}, use um número inteiro de ${min} a ${max} (${quer})`; return false; }
    return true;
  };

  /** Confere o corpo de POST, PATCH e disparar. Devolve { limpo, erros }. `agente` é resolvido à parte. */
  function validaCampos(corpo, modo) {
    const erros = {};
    const gravaveis = modo === 'disparar' ? CAMPOS_DISPARO : CAMPOS_GRAVAVEIS.concat(modo === 'criar' ? ['daqui_min'] : []);
    for (const k of Object.keys(corpo)) {
      if (gravaveis.includes(k)) continue;
      if (modo === 'disparar' && (k === 'regra' || k === 'daqui_min')) erros[k] = `esta rota dispara AGORA e não aceita ${k}. Para agendar, use POST ${BASE}`;
      else if (modo === 'disparar' && k === 'fim') erros[k] = `não vale no disparo imediato. Campos desta rota: ${CAMPOS_DISPARO.join(', ')}`;
      else if (k === 'daqui_min') erros[k] = 'só vale ao criar (POST). Para mudar a hora de um lembrete existente, mande a regra inteira';
      else if (CAMPOS_CALCULADOS.includes(k)) erros[k] = `é calculado pelo servidor e não se escreve. Campos que se escrevem: ${gravaveis.join(', ')}`;
      else if (CAMPOS_DA_REGRA.includes(k)) erros[k] = `fica DENTRO de "regra", ex.: "regra": ${F.EXEMPLO_REGRA}`;
      else erros[k] = `campo desconhecido. Os que existem: ${gravaveis.join(', ')}`;
    }
    const limpo = {};
    const criando = modo !== 'editar';
    if ('texto' in corpo || criando) {
      const t = corpo.texto;
      if (typeof t !== 'string' || !t.trim()) erros.texto = `veio ${F.veio(t)}, mande o que lembrar como texto (ex.: "ligar pro contador")`;
      else if (t.trim().length > MAX_TEXTO) erros.texto = `tem ${t.trim().length} caracteres; o máximo é ${MAX_TEXTO}`;
      else limpo.texto = t.trim();
    }
    if (modo === 'criar') {
      if ('regra' in corpo && 'daqui_min' in corpo) erros.daqui_min = 'não vai junto com "regra". Mande uma das duas';
      else if (!('regra' in corpo) && !('daqui_min' in corpo)) erros.regra = `faltou. Mande quando lembrar, ex.: ${F.EXEMPLO_REGRA}, ou "daqui_min": 20`;
    }
    if ('regra' in corpo && modo !== 'disparar') {
      const r = F.validaRegra(corpo.regra);
      Object.assign(erros, r.erros);
      if (r.regra) limpo.regra = r.regra;
    }
    if ('daqui_min' in corpo && modo === 'criar' && !('regra' in corpo)) {
      if (inteiro('daqui_min', corpo.daqui_min, 1, 10080, erros, 'minutos a partir de agora')) limpo.daqui_min = corpo.daqui_min;
    }
    if ('fim' in corpo && modo !== 'disparar') {
      if (corpo.fim === null) limpo.fim = null;
      else { const v = F.validaData('fim', corpo.fim, erros); if (v) limpo.fim = v; }
    }
    for (const [campo, min, max, quer] of [
      ['intervalo_min', 1, 120, `de quantos em quantos minutos insistir; padrão ${INTERVALO_PADRAO_MIN}`],
      ['teto_envios', 1, TETO_MAX, `quantos avisos no máximo por ocorrência; padrão ${TETO_PADRAO}`],
    ]) {
      if (!(campo in corpo)) continue;
      if (corpo[campo] === null) limpo[campo] = null;
      else if (inteiro(campo, corpo[campo], min, max, erros, quer)) limpo[campo] = corpo[campo];
    }
    if ('pelo_agente' in corpo) {
      if (corpo.pelo_agente === null) limpo.pelo_agente = null;
      else if (typeof corpo.pelo_agente !== 'boolean') erros.pelo_agente = `veio ${F.veio(corpo.pelo_agente)}, use true ou false`;
      else limpo.pelo_agente = corpo.pelo_agente;
    }
    if ('titulo' in corpo) {
      const t = corpo.titulo;
      if (t === null) limpo.titulo = null;
      else if (typeof t !== 'string' || !t.trim()) erros.titulo = `veio ${F.veio(t)}, mande um texto de até ${MAX_TITULO} caracteres (padrão "${TITULO_PADRAO}")`;
      else if (t.trim().length > MAX_TITULO) erros.titulo = `tem ${t.trim().length} caracteres; o máximo é ${MAX_TITULO}`;
      else limpo.titulo = t.trim();
    }
    return { limpo, erros };
  }

  // ── rotas ──────────────────────────────────────────────────────────────────
  const quemTexto = (quem) => (quem.tipo === 'agente' ? `agente:${quem.slug}` : `dono:${quem.usuario || '?'}`);
  // quem.pode (enterprise): o funcionário só enxerga os lembretes dos agentes liberados para ele
  const visivel = (quem, o) => (quem.tipo === 'dono' ? !quem.pode || quem.pode(o.agente) : o.agente === quem.slug);

  function erroDeCampos(res, resumo, erros) {
    const lista = Object.entries(erros).map(([c, m]) => `${c}: ${m}`).join('; ');
    H.erroJson(res, 400, `${resumo} ${lista}`, { erros });
  }

  /** Descobre de qual agente é o pedido. Devolve o slug, ou null depois de já ter respondido. */
  function resolverAgente(res, quem, corpo, exigir) {
    const bruto = corpo.agente;
    if (bruto !== undefined && (typeof bruto !== 'string' || !bruto.trim())) {
      erroDeCampos(res, 'Não entendi o agente.', { agente: `veio ${F.veio(bruto)}, mande o id do agente (ex.: "luna"). Os ids estão em GET /api/v1/agents` });
      return null;
    }
    const slug = bruto === undefined ? null : bruto.trim();
    if (quem.tipo === 'agente') {
      if (slug && slug !== quem.slug) {
        H.erroJson(res, 403, `Um agente só cria e mexe em lembretes dele mesmo: você é "${quem.slug}" e o pedido era para "${slug}". Tire o campo "agente" ou use o seu.`);
        return null;
      }
      return quem.slug;
    }
    const est = registro.estado();
    if (!est.ok) { H.erroJson(res, 503, est.erro); return null; }
    if (slug) {
      if (quem.pode && !quem.pode(slug)) { H.erroJson(res, 403, `Você não tem acesso ao agente "${slug.slice(0, 40)}", então não mexe em lembrete dele. Peça ao TI para liberar.`); return null; }
      if (!registro.obter(slug)) { H.erroJson(res, 404, `Não existe agente "${slug}". Veja os ids em GET /api/v1/agents.`); return null; }
      return slug;
    }
    if (!exigir) return undefined;
    const so = est.agentes.filter((a) => a.tipo === 'agente' && (!quem.pode || quem.pode(a.slug)));
    if (so.length === 1) return so[0].slug;
    erroDeCampos(res, 'Faltou dizer de qual agente é o lembrete.', {
      agente: so.length ? `faltou. Há ${so.length} agentes; mande um destes: ${so.map((a) => a.slug).join(', ')}` : 'faltou, e não há nenhum agente criado ainda. Crie um agente antes de agendar lembretes',
    });
    return null;
  }

  const contaDoAgente = (slug) => [...lembretes.values()].filter((l) => l.agente === slug && estadoDe(l) !== 'encerrado').length;

  function limiteDoAgente(res, slug) {
    if (contaDoAgente(slug) < MAX_POR_AGENTE) return false;
    H.erroJson(res, 409, `O agente "${slug}" já tem ${MAX_POR_AGENTE} lembretes ativos ou pausados, que é o máximo. Apague os que não servem mais em DELETE ${BASE}/<id> (a lista está em GET ${BASE}).`);
    return true;
  }

  function achaLembrete(res, quem, id) {
    const l = RX_LEMBRETE.test(id) ? lembretes.get(id) : null;
    if (l && quem.tipo === 'dono' && !visivel(quem, l)) {
      H.erroJson(res, 403, `Esse lembrete é de um agente a que você não tem acesso. Peça ao TI para liberar.`);
      return null;
    }
    if (!l || !visivel(quem, l)) {
      H.erroJson(res, 404, `Não existe o lembrete "${id.slice(0, 40)}". Veja os existentes em GET ${BASE}.`);
      return null;
    }
    return l;
  }

  function achaOcorrencia(res, quem, id) {
    const o = RX_OCORRENCIA.test(id) ? ocorrencias.get(id) : null;
    if (o && quem.tipo === 'dono' && !visivel(quem, o)) {
      H.erroJson(res, 403, `Essa ocorrência é de um agente a que você não tem acesso. Peça ao TI para liberar.`);
      return null;
    }
    if (!o || !visivel(quem, o)) {
      H.erroJson(res, 404, `Não existe a ocorrência "${id.slice(0, 60)}". Veja as ocorrências de um lembrete em GET ${BASE}/<id>/ocorrencias.`);
      return null;
    }
    return o;
  }

  function novoId() {
    for (let i = 0; i < 20; i += 1) { const id = 'lem_' + crypto.randomBytes(4).toString('hex'); if (!lembretes.has(id)) return id; }
    throw new ErroLoja('Não consegui gerar um id livre para o lembrete. Tente de novo.');
  }

  function montaLembrete(campos, agente, quem, tAgora) {
    return {
      id: novoId(), agente, texto: campos.texto, regra: campos.regra, fim: campos.fim || null,
      intervalo_min: campos.intervalo_min == null ? INTERVALO_PADRAO_MIN : campos.intervalo_min,
      teto_envios: campos.teto_envios == null ? TETO_PADRAO : campos.teto_envios,
      pelo_agente: campos.pelo_agente == null ? true : campos.pelo_agente,
      titulo: campos.titulo || TITULO_PADRAO, ativo: true, proxima_ep: null,
      criado_por: quemTexto(quem), criado_em: iso(tAgora), criado_ep: tAgora, atualizado_em: iso(tAgora),
    };
  }

  /** Mensagem de por que uma regra não tem horário no futuro. */
  function semFuturo(regra, fim, tAgora) {
    if (fim && fim < F.dataLocal(tAgora, tz)) return { erro: `fim: veio "${fim}", que já passou (hoje é ${F.dataLocal(tAgora, tz)} no fuso ${tz}). Mande uma data de hoje em diante`, campo: 'fim' };
    if (regra.tipo === 'unico' && !(fim && regra.data > fim)) {
      return { erro: `regra: ${F.dataBr(regra.data)} às ${regra.hora} já passou (agora são ${F.dataBr(F.dataLocal(tAgora, tz))} ${F.horaLocal(tAgora, tz)}, fuso ${tz}). Mande uma data e hora no futuro`, campo: 'regra' };
    }
    return { erro: `fim: com fim em ${fim || 'nenhuma data'} a regra não tem nenhum horário no futuro. Mude o fim ou a regra`, campo: 'fim' };
  }

  async function criar(req, res, quem) {
    const corpo = await H.lerJson(req, MAX_CORPO);
    const agente = resolverAgente(res, quem, corpo, true);
    if (!agente) return;
    const { limpo, erros } = validaCampos(corpo, 'criar');
    if (Object.keys(erros).length) return erroDeCampos(res, 'Não criei o lembrete.', erros);
    garante();
    const tAgora = relogio();
    let regra = limpo.regra;
    let proximaFixa = null;
    if (limpo.daqui_min != null) {
      proximaFixa = Math.ceil((tAgora + limpo.daqui_min * 60000) / 60000) * 60000;
      regra = { tipo: 'unico', data: F.dataLocal(proximaFixa, tz), hora: F.horaLocal(proximaFixa, tz) };
      if (limpo.fim && regra.data > limpo.fim) return erroDeCampos(res, 'Não criei o lembrete.', { fim: `veio "${limpo.fim}", mas daqui_min ${limpo.daqui_min} cai em ${F.dataBr(regra.data)}, depois do fim` });
    }
    if (limiteDoAgente(res, agente)) return;
    const l = montaLembrete(Object.assign({}, limpo, { regra }), agente, quem, tAgora);
    let prox = proximaFixa;
    if (prox == null) {
      const c = F.proximaDepois(regra, tAgora, l.fim, tz);
      if (!c) { const m = semFuturo(regra, l.fim, tAgora); return erroDeCampos(res, 'Não criei o lembrete.', { [m.campo]: m.erro.replace(/^[a-z]+: /, '') }); }
      prox = c.ep;
    }
    l.proxima_ep = prox;
    lembretes.set(l.id, l);
    try { salvar(); } catch (e) { lembretes.delete(l.id); throw e; }
    log('info', `Lembrete ${l.id} criado para ${agente} por ${l.criado_por}: ${F.regraEmPortugues(l.regra, l.fim)} (próxima ${iso(l.proxima_ep)}).`);
    H.enviaJson(res, 201, { ok: true, lembrete: lemPublico(l, 3) });
  }

  async function disparar(req, res, quem) {
    const corpo = await H.lerJson(req, MAX_CORPO);
    const agente = resolverAgente(res, quem, corpo, true);
    if (!agente) return;
    const { limpo, erros } = validaCampos(corpo, 'disparar');
    if (Object.keys(erros).length) return erroDeCampos(res, 'Não disparei o lembrete.', erros);
    garante();
    const tAgora = relogio();
    const regra = { tipo: 'unico', data: F.dataLocal(tAgora, tz), hora: F.horaLocal(tAgora, tz) };
    const l = montaLembrete(Object.assign({}, limpo, { regra }), agente, quem, tAgora);
    l.avulso = true;
    lembretes.set(l.id, l);
    const o = novaOcorrencia(l, tAgora, 0, 'insistindo');
    ocorrencias.set(o.id, o);
    try { salvar(); } catch (e) { lembretes.delete(l.id); ocorrencias.delete(o.id); throw e; }
    log('info', `Lembrete ${l.id} disparado agora para ${agente} por ${l.criado_por}.`);
    await enviarOcorrencia(o.id, tAgora);
    H.enviaJson(res, 201, { ok: true, lembrete: lemPublico(l, 3), ocorrencia: ocPublica(o) });
  }

  function listar(res, quem, url) {
    garante();
    const q = url.searchParams;
    const filtroAgente = q.get('agente');
    const filtroEstado = q.get('estado');
    if (filtroEstado && !['ativo', 'pausado', 'encerrado'].includes(filtroEstado)) {
      return H.erroJson(res, 400, `O filtro "estado" aceita ativo, pausado ou encerrado; recebi "${filtroEstado.slice(0, 40)}".`);
    }
    if (filtroAgente && quem.tipo === 'dono' && quem.pode && !quem.pode(filtroAgente)) {
      return H.erroJson(res, 403, `Você não tem acesso ao agente "${filtroAgente.slice(0, 40)}", então não vê lembretes dele. Peça ao TI para liberar.`);
    }
    if (filtroAgente && quem.tipo === 'agente' && filtroAgente !== quem.slug) {
      return H.erroJson(res, 404, `Não existe agente "${filtroAgente.slice(0, 40)}" para você: um agente só vê os lembretes dele.`);
    }
    const itens = [...lembretes.values()]
      .filter((l) => visivel(quem, l) && (!filtroAgente || l.agente === filtroAgente) && (!filtroEstado || estadoDe(l) === filtroEstado))
      .sort((a, b) => (a.proxima_ep == null) - (b.proxima_ep == null) || (a.proxima_ep || 0) - (b.proxima_ep || 0) || a.criado_ep - b.criado_ep);
    const insistindo = [...ocorrencias.values()]
      .filter((o) => o.estado === 'insistindo' && visivel(quem, o))
      .sort((a, b) => a.agendada_ep - b.agendada_ep)
      .map((o) => ({
        id: o.id, lembrete_id: o.lembrete_id, agente: o.agente, agente_nome: nomeDoAgente(o.agente), texto: o.texto, titulo: o.titulo,
        envio: o.ciclo_envios, teto: o.teto, proximo_envio_em: iso(proximoEnvioEp(o)), agendada_para: iso(o.agendada_ep),
      }));
    H.enviaJson(res, 200, {
      ok: true,
      lembretes: itens.map((l) => lemPublico(l, 3)),
      insistindo,
      agendador: { ultimo_tique_em: iso(ultimoTique), intervalo_s: INTERVALO_TIQUE_MS / 1000, fuso: tz, erro: erroAgendador },
    });
  }

  async function editar(req, res, quem, l) {
    const corpo = await H.lerJson(req, MAX_CORPO);
    const novoAgente = 'agente' in corpo ? resolverAgente(res, quem, corpo, false) : undefined;
    if ('agente' in corpo && !novoAgente) return;
    const { limpo, erros } = validaCampos(corpo, 'editar');
    if (!Object.keys(corpo).length) erros.corpo = `mande ao menos um campo para mudar: ${CAMPOS_GRAVAVEIS.join(', ')}`;
    if (Object.keys(erros).length) return erroDeCampos(res, 'Não mudei o lembrete.', erros);
    garante();
    const tAgora = relogio();
    const novo = Object.assign({}, l);
    for (const k of ['texto', 'regra', 'fim']) if (k in limpo) novo[k] = limpo[k];
    if (novoAgente && novoAgente !== l.agente) {
      if (limiteDoAgente(res, novoAgente)) return;
      novo.agente = novoAgente;
    }
    const padroes = { intervalo_min: INTERVALO_PADRAO_MIN, teto_envios: TETO_PADRAO, pelo_agente: true, titulo: TITULO_PADRAO };
    for (const k of Object.keys(padroes)) if (k in limpo) novo[k] = limpo[k] === null ? padroes[k] : limpo[k];
    if ('regra' in limpo || 'fim' in limpo) {
      const c = F.proximaDepois(novo.regra, tAgora, novo.fim, tz);
      if (!c) { const m = semFuturo(novo.regra, novo.fim, tAgora); return erroDeCampos(res, 'Não mudei o lembrete.', { [m.campo]: m.erro.replace(/^[a-z]+: /, '') }); }
      if (novo.ativo) novo.proxima_ep = c.ep;
    }
    novo.atualizado_em = iso(tAgora);
    lembretes.set(l.id, novo);
    try { salvar(); } catch (e) { lembretes.set(l.id, l); throw e; }
    log('info', `Lembrete ${l.id} editado por ${quemTexto(quem)} (campos: ${Object.keys(limpo).join(', ')}).`);
    H.enviaJson(res, 200, { ok: true, lembrete: lemPublico(novo, 10) });
  }

  function pausar(res, quem, l) {
    garante();
    if (!l.ativo) return H.enviaJson(res, 200, { ok: true, ja_estava: true, lembrete: lemPublico(l, 3) });
    const tAgora = relogio();
    l.ativo = false;
    l.proxima_ep = null;
    l.atualizado_em = iso(tAgora);
    cancelaInsistencia(l.id, 'lembrete pausado', tAgora);
    salvar();
    log('info', `Lembrete ${l.id} pausado por ${quemTexto(quem)}.`);
    return H.enviaJson(res, 200, { ok: true, ja_estava: false, lembrete: lemPublico(l, 3) });
  }

  function retomar(res, quem, l) {
    garante();
    if (l.ativo) return H.enviaJson(res, 200, { ok: true, ja_estava: true, lembrete: lemPublico(l, 3) });
    const tAgora = relogio();
    const c = F.proximaDepois(l.regra, tAgora, l.fim, tz);
    l.ativo = true;
    l.proxima_ep = c ? c.ep : null;
    l.atualizado_em = iso(tAgora);
    salvar();
    log('info', `Lembrete ${l.id} retomado por ${quemTexto(quem)}${c ? `, próxima ${iso(c.ep)}` : ' (a regra já acabou)'}.`);
    const corpo = { ok: true, ja_estava: false, lembrete: lemPublico(l, 3) };
    if (!c) corpo.aviso = 'A regra já acabou (único que já tocou, ou depois do fim): não há próxima vez. Mude a regra ou o fim com PATCH para o lembrete voltar a tocar.';
    return H.enviaJson(res, 200, corpo);
  }

  function apagar(res, quem, l) {
    garante();
    cancelaInsistencia(l.id, 'lembrete apagado', relogio());
    lembretes.delete(l.id);
    salvar();
    log('info', `Lembrete ${l.id} (${l.agente}) apagado por ${quemTexto(quem)}.`);
    return H.enviaJson(res, 200, { ok: true, id: l.id, apagado: true });
  }

  async function confirmar(req, res, quem, o) {
    const corpo = await H.lerJson(req, 4096);
    const erros = {};
    for (const k of Object.keys(corpo)) if (k !== 'origem') erros[k] = 'campo desconhecido. Este pedido aceita só "origem" (opcional, ex.: "telegram")';
    if ('origem' in corpo && corpo.origem !== null && (typeof corpo.origem !== 'string' || !corpo.origem.trim() || corpo.origem.length > 40)) {
      erros.origem = `veio ${F.veio(corpo.origem)}, use um texto curto de até 40 caracteres (ex.: "telegram", "whatsapp")`;
    }
    if (Object.keys(erros).length) return erroDeCampos(res, 'Não confirmei.', erros);
    garante();
    if (o.estado === 'feito') return H.enviaJson(res, 200, { ok: true, ja_estava: true, ocorrencia: ocPublica(o) });
    if (o.estado === 'perdida' || o.estado === 'cancelada') {
      return H.erroJson(res, 409, `Esta ocorrência está "${o.estado}" (${o.motivo || 'sem aviso enviado'}), então não tem o que confirmar. As próximas vezes do lembrete seguem normalmente.`);
    }
    const tAgora = relogio();
    o.tarde = o.estado === 'sem_resposta';
    o.estado = 'feito';
    o.feito_ep = tAgora;
    o.feito_por = quemTexto(quem);
    o.feito_origem = corpo.origem ? String(corpo.origem).trim() : null;
    o.encerrada_ep = tAgora;
    o.adiada_ate_ep = null;
    salvar();
    log('info', `Lembrete ${o.id} (${o.agente}) feito por ${o.feito_por}${o.feito_origem ? ` via ${o.feito_origem}` : ''}${o.tarde ? ', depois do teto' : ''}, com ${o.total_envios} aviso(s).`);
    return H.enviaJson(res, 200, { ok: true, ja_estava: false, ocorrencia: ocPublica(o) });
  }

  async function adiar(req, res, quem, o) {
    const corpo = await H.lerJson(req, 4096);
    const erros = {};
    for (const k of Object.keys(corpo)) if (k !== 'minutos') erros[k] = 'campo desconhecido. Este pedido aceita só "minutos" (1 a 1440)';
    let minutos = 10;
    if ('minutos' in corpo && corpo.minutos !== null) {
      if (inteiro('minutos', corpo.minutos, 1, 1440, erros, 'por quantos minutos adiar; padrão 10')) minutos = corpo.minutos;
    }
    if (Object.keys(erros).length) return erroDeCampos(res, 'Não adiei.', erros);
    garante();
    if (o.estado === 'feito' || o.estado === 'perdida' || o.estado === 'cancelada') {
      return H.erroJson(res, 409, `Esta ocorrência está "${o.estado}"${o.motivo ? ` (${o.motivo})` : ''}, então não dá para adiar.`);
    }
    if (o.adiamentos >= MAX_ADIAMENTOS) {
      return H.erroJson(res, 409, `Esta ocorrência já foi adiada ${MAX_ADIAMENTOS} vezes, que é o máximo. Confirme com Feito ou apague o lembrete em DELETE ${BASE}/${o.lembrete_id}.`);
    }
    const tAgora = relogio();
    o.estado = 'adiada';
    o.adiamentos += 1;
    o.adiada_ate_ep = tAgora + minutos * 60000;
    o.encerrada_ep = null;
    o.motivo = null;
    o.tarde = false;
    salvar();
    log('info', `Lembrete ${o.id} (${o.agente}) adiado por ${minutos} min por ${quemTexto(quem)} (adiamento ${o.adiamentos} de ${MAX_ADIAMENTOS}); volta às ${iso(o.adiada_ate_ep)}.`);
    return H.enviaJson(res, 200, { ok: true, minutos, adiada_ate: iso(o.adiada_ate_ep), ocorrencia: ocPublica(o) });
  }

  function docs(res) {
    try {
      const texto = fs.readFileSync(path.join(__dirname, '..', 'docs', 'LEMBRETES.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(texto);
    } catch (e) {
      log('erro', `Lembretes: não consegui ler docs/LEMBRETES.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento dos lembretes não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  async function despachar(req, res, url, quem) {
    const p = url.pathname;
    const m = req.method;
    const sub = p.slice(BASE.length).replace(/\/+$/, '');
    const metodoErrado = (usar) => H.erroJson(res, 405, `Use ${usar} em ${p}.`);

    if (sub === '/docs.md') return m === 'GET' ? docs(res) : metodoErrado('GET');
    if (sub === '') {
      if (m === 'GET') return listar(res, quem, url);
      if (m === 'POST') return criar(req, res, quem);
      return metodoErrado('GET para listar ou POST para criar');
    }
    if (sub === '/disparar') return m === 'POST' ? disparar(req, res, quem) : metodoErrado('POST');

    const oc = /^\/ocorrencias\/([^/]+)\/(feito|adiar)$/.exec(sub);
    if (oc) {
      if (m !== 'POST') return metodoErrado('POST');
      garante();
      const o = achaOcorrencia(res, quem, oc[1]);
      if (!o) return undefined;
      return oc[2] === 'feito' ? confirmar(req, res, quem, o) : adiar(req, res, quem, o);
    }

    const lm = /^\/([^/]+)(?:\/(pausar|retomar|ocorrencias))?$/.exec(sub);
    if (lm) {
      garante();
      const l = achaLembrete(res, quem, lm[1]);
      if (!l) return undefined;
      const acao = lm[2];
      if (!acao) {
        if (m === 'GET') return H.enviaJson(res, 200, { ok: true, lembrete: lemPublico(l, 10) });
        if (m === 'PATCH') return editar(req, res, quem, l);
        if (m === 'DELETE') return apagar(res, quem, l);
        return metodoErrado('GET, PATCH ou DELETE');
      }
      if (acao === 'ocorrencias') {
        if (m !== 'GET') return metodoErrado('GET');
        const bruto = url.searchParams.get('limit');
        let limite = 30;
        if (bruto != null && bruto !== '') {
          limite = Number(bruto);
          if (!Number.isInteger(limite) || limite < 1 || limite > MAX_OC_POR_LEMBRETE) {
            return H.erroJson(res, 400, `O parâmetro "limit" precisa ser um inteiro de 1 a ${MAX_OC_POR_LEMBRETE}; recebi "${String(bruto).slice(0, 40)}".`);
          }
        }
        return H.enviaJson(res, 200, { ok: true, lembrete_id: l.id, ocorrencias: ocsDe(l.id).slice(0, limite).map(ocPublica) });
      }
      if (m !== 'POST') return metodoErrado('POST');
      return acao === 'pausar' ? pausar(res, quem, l) : retomar(res, quem, l);
    }
    return H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
  }

  /** Trata /api/v1/lembretes/*. Devolve true se respondeu. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname;
    if (p !== BASE && !p.startsWith(BASE + '/')) return false;
    try {
      await despachar(req, res, url, quemChamou(sessao));
    } catch (e) {
      if (e instanceof ErroLoja) H.erroJson(res, 503, e.message);
      else if (e.status) H.erroJson(res, e.status, e.message);
      else throw e;
    }
    return true;
  }

  return { rotas, iniciar, parar, tique };
}

module.exports = { criarLembretes, ErroLoja };
