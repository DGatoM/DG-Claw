'use strict';
// Vigia das integrações dos agentes: incidentes, silêncio, "lembrar em 1 hora", pedido ao Admin (manual e
// automático) e as rotas /api/v1/integracoes. Plano: docs/PLANO-INTEGRACOES-E-VIGIA.md (seções 3.5 e 3.6).
// Contrato das rotas: web/docs/INTEGRACOES.md.
//
// O Web só LÊ o estado.json de cada agente (web/lib/integracoes-leitura.js, leitura blindada). O que o
// agente escreveu nunca entra no texto do pedido ao Admin: o texto só usa frases fixas, o slug do registro do
// host, o id da integração (se estiver no catálogo), a categoria (lista fechada) e o id do incidente.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const { gravaArquivoSeguro } = require('./grava-seguro');
const leituraPadrao = require('./integracoes-leitura');
const { RX_SLUG } = require('./registro');

const BASE = '/api/v1/integracoes';
const HORA_MS = 3600 * 1000;
const SETE_DIAS_MS = 7 * 24 * HORA_MS;
const SEIS_HORAS_MS = 6 * HORA_MS;
const DIA_MS = 24 * HORA_MS;
const MAX_POR_DIA = 5;
const INTERVALO_MS = 60 * 1000;
const RX_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const CATEGORIAS = {
  credencial_recusada: 'a chave de acesso foi recusada',
  sem_saldo: 'o saldo ou crédito acabou',
  fora_do_ar: 'o sistema está fora do ar',
  desconectado: 'a conexão caiu e precisa ser refeita',
  outra: 'falha sem classificação',
};
const categoriaDe = (resultado) => (typeof resultado === 'string' && Object.hasOwn(CATEGORIAS, resultado) && resultado !== 'outra' ? resultado : 'outra');

const FRASE_INTEGRACAO_PROPRIA = 'uma integração própria do agente';

function lerCatalogo(arquivo, log) {
  try {
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const lista = j && j.integracoes && typeof j.integracoes === 'object' ? j.integracoes : {};
    const out = {};
    for (const [id, v] of Object.entries(lista)) {
      if (RX_ID.test(id) && v && typeof v.nome === 'string') out[id] = { nome: v.nome, icone: typeof v.icone === 'string' ? v.icone : null };
    }
    return out;
  } catch (e) {
    log('aviso', `Integrações: não consegui ler o catálogo ${arquivo} (${e.code || e.message}). Os nomes saem como o próprio id e o pedido ao Admin chama todas de "${FRASE_INTEGRACAO_PROPRIA}".`);
    return {};
  }
}

const ARQUIVO_CATALOGO = path.join(__dirname, '..', '..', 'templates', 'integracoes', 'catalogo.json');
let catalogoEmCache = null;
function catalogoPadrao() {
  if (!catalogoEmCache) catalogoEmCache = lerCatalogo(ARQUIVO_CATALOGO, () => {});
  return catalogoEmCache;
}

/**
 * O texto que vai ao Admin, só com frases fixas. Por incidente entram apenas: o slug do agente (do registro do
 * host, conferido pelo formato), o id da integração SE estiver no catálogo, a categoria (por tabela) e o id do
 * incidente. Nada escrito pelo agente. `registro` tem estado().agentes; `catalogo` é { id: {nome, icone} }.
 */
function textoDoPedido(incidentes, registro, catalogo) {
  const agentes = registro && registro.estado ? registro.estado().agentes || [] : [];
  const cat = catalogo || catalogoPadrao();
  const linhas = [];
  for (const inc of incidentes || []) {
    const ag = agentes.find((a) => a && a.slug === inc.agente);
    if (!ag || typeof ag.slug !== 'string' || !RX_SLUG.test(ag.slug)) continue;
    if (typeof inc.id !== 'string' || !/^[0-9a-f-]{8,40}$/.test(inc.id)) continue;
    const integ = typeof inc.integracao === 'string' && RX_ID.test(inc.integracao) && Object.hasOwn(cat, inc.integracao)
      ? `a integração ${inc.integracao}` : FRASE_INTEGRACAO_PROPRIA;
    linhas.push(`- Agente ${ag.slug}: ${integ}, ${CATEGORIAS[categoriaDe(inc.categoria)]}. Incidente ${inc.id}.`);
  }
  if (!linhas.length) return null;
  return [
    linhas.length === 1 ? 'O DG Claw detectou uma integração com defeito.' : 'O DG Claw detectou integrações com defeito.',
    'Investigue e proponha uma solução. Comece pelo diagnóstico de leitura que já existe, sem alterar nada.',
    'Traga a proposta como [PEDIDO] e não aplique nada antes do ok do dono.',
    ...linhas,
  ].join('\n');
}

function criarIntegracoesVigia({ dataDir, registro, runner, log, agora, leitura, catalogoArquivo, intervaloMs }) {
  const relogio = agora || (() => Date.now());
  const L = leitura || leituraPadrao;
  const dir = path.join(dataDir, 'integracoes');
  const arqIncidentes = path.join(dir, 'incidentes.json');
  const arqAutomatico = path.join(dir, 'automatico.json');
  const catalogo = lerCatalogo(catalogoArquivo || ARQUIVO_CATALOGO, log);

  let incidentes = [];        // abertos, de agentes ainda no registro
  let silenciadas = [];       // [{ agente, integracao }]
  let automatico = { ligado: false, alteradoEm: null, envios: [] };
  let naFaixaIds = new Set(); // ids dos incidentes que a última reavaliação deixou à vista
  let naoMedidos = [];
  let timer = null;

  // ── disco ──────────────────────────────────────────────────────────────────
  function lerJsonOuVazio(arq) {
    let bruto;
    try { bruto = fs.readFileSync(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      log('erro', `Integrações: não consegui ler ${arq} (${e.code || e.message}); começo vazio. Confira as permissões da pasta ${dir}.`);
      return null;
    }
    try { return JSON.parse(bruto); } catch (e) {
      log('erro', `Integrações: ${arq} está com o JSON quebrado (${e.message}); começo vazio. O arquivo será regravado na próxima mudança.`);
      return null;
    }
  }

  function carregar() {
    const i = lerJsonOuVazio(arqIncidentes);
    if (i && Array.isArray(i.incidentes)) {
      incidentes = i.incidentes.filter((x) => x && typeof x.id === 'string' && RX_SLUG.test(String(x.agente)) && RX_ID.test(String(x.integracao)))
        .map((x) => ({ id: x.id, agente: x.agente, integracao: x.integracao, categoria: categoriaDe(x.categoria), abertoEm: String(x.abertoEm), adiadoAte: x.adiadoAte || null, pedidoAutomaticoEm: x.pedidoAutomaticoEm || null }));
      silenciadas = Array.isArray(i.silenciadas) ? i.silenciadas.filter((s) => s && RX_SLUG.test(String(s.agente)) && RX_ID.test(String(s.integracao))).map((s) => ({ agente: s.agente, integracao: s.integracao })) : [];
    } else if (i) {
      log('erro', `Integrações: ${arqIncidentes} não tem o formato esperado; começo vazio.`);
    }
    const a = lerJsonOuVazio(arqAutomatico);
    if (a && typeof a === 'object') {
      automatico = {
        ligado: a.ligado === true,
        alteradoEm: typeof a.alteradoEm === 'string' ? a.alteradoEm : null,
        envios: Array.isArray(a.envios) ? a.envios.filter((e) => e && typeof e.em === 'string' && Number.isFinite(Date.parse(e.em))) : [],
      };
    }
  }

  function grava(arq, obj) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    gravaArquivoSeguro(arq, `${JSON.stringify(obj, null, 1)}\n`, { raiz: dataDir, modo: 0o600 });
  }
  const gravaIncidentes = () => grava(arqIncidentes, { versao: 1, incidentes, silenciadas });
  const gravaAutomatico = () => grava(arqAutomatico, automatico);
  function tentaGravar(fn, o_que) {
    try { fn(); return true; } catch (e) {
      log('erro', `Integrações: não consegui gravar ${o_que} (${e.message}). O que mudou vale só até reiniciar o Web; confira o espaço em disco e as permissões de ${dir}.`);
      return false;
    }
  }

  const ehSilenciada = (agente, integracao) => silenciadas.some((s) => s.agente === agente && s.integracao === integracao);

  // ── automático ─────────────────────────────────────────────────────────────
  function barradoPorLimite(inc, agoraMs) {
    const recentes = automatico.envios.filter((e) => agoraMs - Date.parse(e.em) < DIA_MS);
    if (recentes.length >= MAX_POR_DIA) return `já foram enviados ${MAX_POR_DIA} pedidos automáticos nas últimas 24 horas`;
    if (automatico.envios.some((e) => e.agente === inc.agente && e.integracao === inc.integracao && agoraMs - Date.parse(e.em) < SEIS_HORAS_MS)) {
      return 'já houve um pedido automático para esta integração nas últimas 6 horas';
    }
    return null;
  }

  /** Só ao ABRIR um incidente. Devolve a promessa do envio (para teste) ou null quando não enviou. */
  function pedidoAutomatico(inc, agoraMs) {
    if (!automatico.ligado || inc.pedidoAutomaticoEm) return null;
    const rotulo = `${inc.agente}/${inc.integracao}`;
    const motivo = barradoPorLimite(inc, agoraMs);
    if (motivo) { log('info', `Integrações: não enviei o pedido automático ao Admin para ${rotulo}: ${motivo}.`); return null; }
    const admin = (registro.estado().agentes || []).find((a) => a.tipo === 'admin');
    if (!admin) { log('erro', `Integrações: o pedido automático para ${rotulo} não saiu porque o registro não tem o agente Admin.`); return null; }
    const texto = textoDoPedido([inc], registro, catalogo);
    if (!texto) return null;
    const em = new Date(agoraMs).toISOString();
    // Reserva antes de esperar o runner: duas reavaliações seguidas não mandam o mesmo pedido duas vezes.
    inc.pedidoAutomaticoEm = em;
    automatico.envios.push({ em, agente: inc.agente, integracao: inc.integracao, incidente: inc.id });
    return (async () => {
      let r;
      try { r = await runner.input(admin, { text: texto, submit: true, injectWhenIdle: true }); } catch (e) { r = { ok: false, erro: e.message }; }
      if (r && r.ok) return true;
      inc.pedidoAutomaticoEm = null;
      automatico.envios = automatico.envios.filter((e) => e.incidente !== inc.id);
      log('erro', `Integrações: o pedido automático ao Admin para ${rotulo} (incidente ${inc.id}) falhou: ${(r && r.erro) || 'o runner não respondeu'}. Não contou como enviado; peça pelo botão "Pedir ao Admin para verificar".`);
      tentaGravar(() => { gravaIncidentes(); gravaAutomatico(); }, 'os incidentes');
      return false;
    })();
  }

  // ── reavaliação ────────────────────────────────────────────────────────────
  function elegivel(item, agoraMs) {
    const ref = Date.parse(item.ultimaTentativaReal || item.ultimoEvento);
    return Number.isFinite(ref) && agoraMs - ref < SETE_DIAS_MS && agoraMs - ref > -DIA_MS;
  }

  /** Relê o estado de todos os agentes e acerta os incidentes. Devolve a promessa dos envios automáticos. */
  function reavaliar(agoraMs) {
    const agoraN = Number.isFinite(agoraMs) ? agoraMs : relogio();
    const est = registro.estado();
    if (!est || !est.ok) return Promise.resolve([]);   // registro ilegível: não fecha nada por engano
    const agentes = (est.agentes || []).filter((a) => a.tipo !== 'admin');
    const slugs = new Set(agentes.map((a) => a.slug));
    const antes = JSON.stringify([incidentes, silenciadas]);
    const novos = [];
    const faixa = new Set();
    const nao = [];

    // agente que saiu do registro: o incidente e o silêncio dele somem
    incidentes = incidentes.filter((i) => slugs.has(i.agente));
    silenciadas = silenciadas.filter((s) => slugs.has(s.agente));

    for (const ag of agentes) {
      const lido = L.lerEstado(ag);
      if (!lido.medido) { nao.push({ agente: ag.slug, motivo: lido.motivo }); continue; }
      const desligadas = new Set(L.lerDesligadas(ag));
      const porId = new Map(lido.itens.map((it) => [it.id, it]));
      // fecha o que ficou verde, foi desligado ou sumiu
      incidentes = incidentes.filter((inc) => {
        if (inc.agente !== ag.slug) return true;
        const it = porId.get(inc.integracao);
        return !!it && it.estado !== 'verde' && !desligadas.has(inc.integracao);
      });
      for (const it of lido.itens) {
        if (it.estado !== 'vermelho' || desligadas.has(it.id) || !elegivel(it, agoraN)) continue;
        if (ehSilenciada(ag.slug, it.id)) continue;
        let inc = incidentes.find((i) => i.agente === ag.slug && i.integracao === it.id);
        if (!inc) {
          inc = {
            id: crypto.randomUUID(), agente: ag.slug, integracao: it.id,
            categoria: categoriaDe(it.ultimaFalhaResultado || it.ultimoResultado),
            abertoEm: new Date(agoraN).toISOString(), adiadoAte: null, pedidoAutomaticoEm: null,
          };
          incidentes.push(inc);
          novos.push(inc);
        }
        faixa.add(inc.id);
      }
    }
    naFaixaIds = faixa;
    naoMedidos = nao;

    const envios = [];
    for (const inc of novos) { const p = pedidoAutomatico(inc, agoraN); if (p) envios.push(p); }
    const corte = agoraN - SETE_DIAS_MS;
    const enviosAntes = automatico.envios.length;
    automatico.envios = automatico.envios.filter((e) => Date.parse(e.em) >= corte);
    if (JSON.stringify([incidentes, silenciadas]) !== antes || novos.length) tentaGravar(gravaIncidentes, 'incidentes.json');
    if (novos.some((i) => i.pedidoAutomaticoEm) || automatico.envios.length !== enviosAntes) tentaGravar(gravaAutomatico, 'automatico.json');
    return Promise.all(envios);
  }

  function visiveis(agoraMs) {
    return incidentes.filter((i) => naFaixaIds.has(i.id) && !ehSilenciada(i.agente, i.integracao)
      && !(i.adiadoAte && Date.parse(i.adiadoAte) > agoraMs));
  }

  // ── ações do dono ──────────────────────────────────────────────────────────
  function lembrar(agoraMs) {
    const ate = new Date(agoraMs + HORA_MS).toISOString();
    const lista = visiveis(agoraMs);
    for (const i of lista) i.adiadoAte = ate;
    if (lista.length) tentaGravar(gravaIncidentes, 'incidentes.json');
    return lista.length;
  }

  function silenciar(agente, integracao) {
    if (!ehSilenciada(agente, integracao)) silenciadas.push({ agente, integracao });
    incidentes = incidentes.filter((i) => !(i.agente === agente && i.integracao === integracao));
    return tentaGravar(gravaIncidentes, 'incidentes.json');
  }

  function reativar(agente, integracao) {
    silenciadas = silenciadas.filter((s) => !(s.agente === agente && s.integracao === integracao));
    return tentaGravar(gravaIncidentes, 'incidentes.json');
  }

  function definirAutomatico(ligado, agoraMs) {
    automatico.ligado = ligado;
    automatico.alteradoEm = new Date(agoraMs).toISOString();
    return tentaGravar(gravaAutomatico, 'automatico.json');
  }

  // ── rotas ──────────────────────────────────────────────────────────────────
  function nomeDoAgente(slug) {
    const a = (registro.estado().agentes || []).find((x) => x.slug === slug);
    return a ? a.nome : slug;
  }

  function resposta(agoraMs) {
    const lista = visiveis(agoraMs);
    const faixa = lista.map((i) => ({
      id: i.id, agente: i.agente, agenteNome: nomeDoAgente(i.agente), integracao: i.integracao,
      integracaoNome: catalogo[i.integracao] ? catalogo[i.integracao].nome : i.integracao,
      categoria: i.categoria, categoriaTexto: CATEGORIAS[categoriaDe(i.categoria)], abertoEm: i.abertoEm,
    }));
    return {
      ok: true, faixa, pedido: textoDoPedido(lista, registro, catalogo),
      automatico: { ligado: automatico.ligado },
      silenciadas: silenciadas.map((s) => ({ agente: s.agente, integracao: s.integracao })),
      naoMedidos: naoMedidos.map((n) => ({ agente: n.agente, motivo: n.motivo })),
    };
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INTEGRACOES.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Integrações: não consegui ler docs/INTEGRACOES.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento das integrações não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Confere {agente, integracao} pelo formato e pelo registro. Devolve { agente, integracao } ou responde o erro. */
  function parAgenteIntegracao(res, corpo) {
    const agente = corpo.agente; const integracao = corpo.integracao;
    if (typeof agente !== 'string' || !RX_SLUG.test(agente) || typeof integracao !== 'string' || !RX_ID.test(integracao)) {
      H.erroJson(res, 400, 'Mande {"agente": "<slug do agente>", "integracao": "<id da integração>"}, com os dois no formato de letras minúsculas, números e hífen.');
      return null;
    }
    const ag = (registro.estado().agentes || []).find((a) => a.slug === agente && a.tipo !== 'admin');
    if (!ag) {
      H.erroJson(res, 404, `Não existe o agente "${agente}" no registro (o Admin não tem integrações medidas).`);
      return null;
    }
    return { agente, integracao };
  }

  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    // Agente não usa estas rotas; o servidor já não as libera na caixa, isto é a segunda trava.
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'As integrações são só do dono, pelo painel. Agente não usa esta rota.');
      return true;
    }
    if (sessao.papel === 'colaborador') {
      H.erroJson(res, 403, 'Só o dono vê as integrações de todos os agentes.');
      return true;
    }
    const m = req.method;
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '') {
        if (m !== 'GET') return metodoErrado('GET');
        const t = relogio();
        reavaliar(t);   // a parte síncrona já acertou os incidentes; o envio automático segue sozinho
        H.enviaJson(res, 200, resposta(t));
        return true;
      }
      if (sub === '/docs.md') { if (m !== 'GET') return metodoErrado('GET'); docs(res); return true; }
      if (sub === '/lembrar') {
        if (m !== 'POST') return metodoErrado('POST');
        await H.lerJson(req, 1024);
        const n = lembrar(relogio());
        H.enviaJson(res, 200, { ok: true, adiados: n });
        return true;
      }
      if (sub === '/silenciar' || sub === '/reativar') {
        if (m !== 'POST') return metodoErrado('POST');
        const par = parAgenteIntegracao(res, await H.lerJson(req, 1024));
        if (!par) return true;
        const gravou = sub === '/silenciar' ? silenciar(par.agente, par.integracao) : reativar(par.agente, par.integracao);
        if (!gravou) { H.erroJson(res, 500, `Não consegui guardar a mudança no disco. Confira o espaço e as permissões de ${dir}; o que mudou vale só até reiniciar o Web.`); return true; }
        H.enviaJson(res, 200, { ok: true, agente: par.agente, integracao: par.integracao, silenciada: sub === '/silenciar' });
        return true;
      }
      if (sub === '/automatico') {
        if (m !== 'POST') return metodoErrado('POST');
        const corpo = await H.lerJson(req, 1024);
        if (typeof corpo.ligado !== 'boolean') { H.erroJson(res, 400, 'Mande {"ligado": true} ou {"ligado": false}.'); return true; }
        if (corpo.ligado && corpo.entendoORisco !== true) {
          H.erroJson(res, 400, 'Para ligar, mande também {"entendoORisco": true}. Ligado, o Web chama o Admin sozinho quando uma integração cai. O Admin tem acesso total ao servidor, e um agente consegue registrar uma falha que não aconteceu, o que faria o Admin olhar uma integração que está boa. O pedido tem texto fixo e há limites (um por defeito, um a cada 6 horas por integração, cinco por dia).');
          return true;
        }
        if (!definirAutomatico(corpo.ligado, relogio())) { H.erroJson(res, 500, `Não consegui guardar a escolha no disco. Confira o espaço e as permissões de ${dir}.`); return true; }
        H.enviaJson(res, 200, { ok: true, automatico: { ligado: automatico.ligado } });
        return true;
      }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message); return true; }
      log('erro', `Integrações: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido das integrações. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  // ── ciclo de vida ──────────────────────────────────────────────────────────
  carregar();

  function tique() {
    Promise.resolve().then(() => reavaliar(relogio())).catch((e) => log('erro', `Integrações: a reavaliação falhou (${e.stack || e.message}).`));
  }
  function iniciar() {
    if (timer) return;
    tique();
    timer = setInterval(tique, intervaloMs || INTERVALO_MS);
    if (timer.unref) timer.unref();
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }

  return { rotas, reavaliar, iniciar, parar, textoDoPedido: (inc) => textoDoPedido(inc, registro, catalogo), catalogo, lembrar, silenciar, reativar, visiveis, estado: () => ({ incidentes, silenciadas, automatico, naFaixaIds }), CATEGORIAS };
}

module.exports = { criarIntegracoesVigia, textoDoPedido, CATEGORIAS, categoriaDe, FRASE_INTEGRACAO_PROPRIA };
