'use strict';
const dgIntegracoesIdioma = require('./idioma-contexto');
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
const { instanciaDe: instanciaReal } = require('./instancia');

const BASE = '/api/v1/integracoes';
const HORA_MS = 3600 * 1000;
const SETE_DIAS_MS = 7 * 24 * HORA_MS;
const SEIS_HORAS_MS = 6 * HORA_MS;
const DIA_MS = 24 * HORA_MS;
const MAX_POR_DIA = 5;
const INTERVALO_MS = 60 * 1000;
const RX_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Pedido manual: no máximo esta quantidade de linhas (o texto precisa caber no limite de uma mensagem da conversa).
const MAX_LINHAS_PEDIDO = 9;

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
  const excedentes = linhas.length - MAX_LINHAS_PEDIDO;
  if (excedentes > 0) {
    linhas.length = MAX_LINHAS_PEDIDO;
    linhas.push(excedentes === 1 ? 'e mais 1 integração com defeito; a lista completa está na faixa do painel.' : `e mais ${excedentes} integrações com defeito; a lista completa está na faixa do painel.`);
  }
  return [
    linhas.length === 1 ? 'O DG Claw detectou uma integração com defeito.' : 'O DG Claw detectou integrações com defeito.',
    'Investigue e proponha uma solução. Comece pelo diagnóstico de leitura que já existe, sem alterar nada.',
    'Traga a proposta como [PEDIDO] e não aplique nada antes do ok do dono.',
    ...linhas,
  ].join('\n');
}

function criarIntegracoesVigia({ dataDir, registro, runner, log, agora, leitura, catalogoArquivo, intervaloMs, filtro, instancia }) {
  const relogio = agora || (() => Date.now());
  const L = leitura || leituraPadrao;
  const filtraTexto = filtro || ((_slug, t) => t);
  const instanciaDe = instancia || instanciaReal;
  const dir = path.join(dataDir, 'integracoes');
  const arqIncidentes = path.join(dir, 'incidentes.json');
  const arqAutomatico = path.join(dir, 'automatico.json');
  const catalogo = lerCatalogo(catalogoArquivo || ARQUIVO_CATALOGO, log);

  let incidentes = [];        // abertos, de agentes ainda no registro
  let silenciadas = [];       // [{ agente, integracao }]
  let automatico = { ligado: false, alteradoEm: null, envios: [], suspenso: false };
  let naFaixaIds = new Set(); // ids dos incidentes que a última reavaliação deixou à vista
  let naoMedidos = [];
  let timer = null;
  // A suspensão (incidentes.json ilegível) vive em automatico.json (campo `suspenso`), não só na memória: assim ela
  // sobrevive a um reinício, mesmo depois que o incidentes.json ruim for regravado. Só o dono, no interruptor, a limpa.

  // ── disco ──────────────────────────────────────────────────────────────────
  // `existiaIlegivel.valor` fica true quando o arquivo EXISTE mas não deu para ler ou interpretar (e `bruto` guarda o texto, se leu).
  function lerJsonOuVazio(arq, existiaIlegivel) {
    let bruto;
    try { bruto = fs.readFileSync(arq, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (existiaIlegivel) existiaIlegivel.valor = true;
      log('erro', `Integrações: não consegui ler ${arq} (${e.code || e.message}); começo vazio. Confira as permissões da pasta ${dir}.`);
      return null;
    }
    try {
      const v = JSON.parse(bruto);
      // arquivo que existe com o conteúdo `null` não é arquivo ausente: é ilegível para o vigia
      if (v === null && existiaIlegivel) { existiaIlegivel.valor = true; existiaIlegivel.bruto = bruto; }
      return v;
    } catch (e) {
      if (existiaIlegivel) { existiaIlegivel.valor = true; existiaIlegivel.bruto = bruto; }
      log('erro', `Integrações: ${arq} está com o JSON quebrado (${e.message}); começo vazio. O arquivo será regravado na próxima mudança.`);
      return null;
    }
  }

  /** Guarda uma cópia do incidentes.json ruim antes que a próxima gravação o substitua, e suspende o automático. */
  function protegeIncidentesRuim(ruim) {
    const copia = `${arqIncidentes}.corrompido`;
    if (typeof ruim.bruto === 'string') {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        gravaArquivoSeguro(copia, ruim.bruto, { raiz: dataDir, modo: 0o600 });
        log('aviso', `Integrações: guardei uma cópia do arquivo ilegível em ${copia}.`);
      } catch (e) {
        log('erro', `Integrações: não consegui guardar a cópia do arquivo ilegível em ${copia} (${e.message}). Copie ${arqIncidentes} à mão antes de mexer nas integrações.`);
      }
    } else {
      log('erro', `Integrações: ${arqIncidentes} existe mas não pôde ser lido, então não há cópia para guardar. Confira as permissões antes de mexer nas integrações.`);
    }
    automatico.suspenso = true;
    // Grava a suspensão ANTES de qualquer regravação do incidentes.json.
    // Se nem a suspensão foi gravada, o incidentes.json não é regravado: assim um reinício não perde a marca.
    if (!tentaGravar(gravaAutomatico, 'a suspensão em automatico.json')) incidentesTravados = true;
    log('erro', `Integrações: o pedido automático ao Admin está suspenso porque ${arqIncidentes} está ilegível (a lista de incidentes e de silenciadas pode ter se perdido). Confira o arquivo (a cópia está em ${copia}) e ligue ou desligue "Chamar o Admin sozinho" na tela Segurança para retomar.`);
  }

  function carregar() {
    const a = lerJsonOuVazio(arqAutomatico);
    if (a && typeof a === 'object') {
      automatico = {
        ligado: a.ligado === true,
        alteradoEm: typeof a.alteradoEm === 'string' ? a.alteradoEm : null,
        envios: Array.isArray(a.envios) ? a.envios.filter((e) => e && typeof e.em === 'string' && Number.isFinite(Date.parse(e.em))) : [],
        suspenso: a.suspenso === true,
      };
    }
    const ruim = { valor: false, bruto: null };
    const i = lerJsonOuVazio(arqIncidentes, ruim);
    if (ruim.valor) protegeIncidentesRuim(ruim);
    const formatoOk = !!i && typeof i === 'object' && Array.isArray(i.incidentes) && (i.silenciadas === undefined || Array.isArray(i.silenciadas));
    if (formatoOk) {
      incidentes = i.incidentes.filter((x) => x && typeof x.id === 'string' && typeof x.agente === 'string' && RX_SLUG.test(x.agente) && typeof x.integracao === 'string' && RX_ID.test(x.integracao))
        .map((x) => ({ id: x.id, agente: x.agente, integracao: x.integracao, categoria: categoriaDe(x.categoria), abertoEm: String(x.abertoEm), adiadoAte: x.adiadoAte || null, pedidoAutomaticoEm: x.pedidoAutomaticoEm || null, instancia: typeof x.instancia === 'string' ? x.instancia : null }));
      silenciadas = Array.isArray(i.silenciadas) ? i.silenciadas.filter((s) => s && typeof s.agente === 'string' && RX_SLUG.test(s.agente) && typeof s.integracao === 'string' && RX_ID.test(s.integracao)).map((s) => ({ agente: s.agente, integracao: s.integracao, instancia: typeof s.instancia === 'string' ? s.instancia : null })) : [];
    } else if (i !== null) {
      log('erro', `Integrações: ${arqIncidentes} não tem o formato esperado; começo vazio.`);
      protegeIncidentesRuim({ bruto: JSON.stringify(i) });
    }
  }

  function grava(arq, obj) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    gravaArquivoSeguro(arq, `${JSON.stringify(obj, null, 1)}\n`, { raiz: dataDir, modo: 0o600 });
  }
  let incidentesTravados = false;
  const gravaIncidentes = () => {
    if (incidentesTravados) throw new Error('a suspensão do automático não foi gravada, então o incidentes.json ilegível fica como está até o dono mexer no interruptor');
    grava(arqIncidentes, { versao: 1, incidentes, silenciadas });
  };
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
    if (automatico.suspenso) { log('erro', `Integrações: não enviei o pedido automático ao Admin para ${rotulo} porque o incidentes.json estava ilegível ao iniciar. Confira ${arqIncidentes}.corrompido e mexa no interruptor "Chamar o Admin sozinho" para retomar.`); return null; }
    const motivo = barradoPorLimite(inc, agoraMs);
    if (motivo) { log('info', `Integrações: não enviei o pedido automático ao Admin para ${rotulo}: ${motivo}.`); return null; }
    const admin = (registro.estado().agentes || []).find((a) => a.tipo === 'admin');
    if (!admin) { log('erro', `Integrações: o pedido automático para ${rotulo} não saiu porque o registro não tem o agente Admin.`); return null; }
    let texto = textoDoPedido([inc], registro, catalogo);
    if (!texto) return null;
    // Mesmo filtro de anonimização do envio do dono ao Admin (/send). Se falhar, não envia.
    try { texto = filtraTexto(admin.slug, texto); } catch (e) {
      log('erro', `Integrações: o pedido automático ao Admin para ${rotulo} não saiu porque o filtro de anonimização falhou (${e.message}). Confira a configuração de anonimização do Admin; peça pelo botão "Pedir ao Admin para verificar".`);
      return null;
    }
    // Mesmo envelope dos outros recados que o Web injeta sozinho (lembretes, login): <plataforma ...> diz que veio do sistema,
    // não do dono. O Claude e o Codex já o reconhecem (web/lib/thread.js e web/lib/rollout.js).
    texto = `<plataforma recado="integracoes-vigia" tipo="aviso" ts="${new Date(agoraMs).toISOString()}">${texto.replace(/</g, '&lt;')}</plataforma>`;
    const em = new Date(agoraMs).toISOString();
    // Reserva e grava ANTES de chamar o runner: se o Web cair no meio do envio, o disco já diz que foi enviado
    // e o pedido não sai duas vezes. Se não der para gravar a reserva, não envia.
    inc.pedidoAutomaticoEm = em;
    const reserva = { em, agente: inc.agente, integracao: inc.integracao, incidente: inc.id };
    automatico.envios.push(reserva);
    const desfazReserva = () => {
      inc.pedidoAutomaticoEm = null;
      automatico.envios = automatico.envios.filter((e) => e !== reserva);
    };
    if (!tentaGravar(() => { gravaIncidentes(); gravaAutomatico(); }, 'a reserva do pedido automático')) {
      desfazReserva();
      log('erro', `Integrações: o pedido automático ao Admin para ${rotulo} (incidente ${inc.id}) não foi enviado porque não consegui gravar a reserva no disco. Peça pelo botão "Pedir ao Admin para verificar".`);
      return null;
    }
    return (async () => {
      let r;
      try { r = await runner.input(admin, { text: texto, submit: true, injectWhenIdle: true }); } catch (e) {
        log('erro', `Integrações: o resultado do pedido automático ao Admin para ${rotulo} (incidente ${inc.id}) ficou incerto (${e.message}). Ele continua contado como enviado e por isso não será reenviado; se o Admin não apareceu, peça pelo botão "Pedir ao Admin para verificar".`);
        return false;
      }
      if (r && r.ok) return true;
      if (r && r.ok === false && r.antesDoEnvio === true) {
        // A conexão nem abriu: o pedido com certeza não chegou ao runner.
        desfazReserva();
        log('erro', `Integrações: o pedido automático ao Admin para ${rotulo} (incidente ${inc.id}) não chegou ao runner: ${r.erro || 'sem motivo informado'}. Não contou como enviado; peça pelo botão "Pedir ao Admin para verificar".`);
        tentaGravar(() => { gravaIncidentes(); gravaAutomatico(); }, 'os incidentes');
        return false;
      }
      if (r && r.ok === false) {
        log('erro', `Integrações: o resultado do pedido automático ao Admin para ${rotulo} (incidente ${inc.id}) ficou incerto: ${r.erro || 'sem motivo informado'}. Ele continua contado como enviado e por isso não será reenviado; se o Admin não apareceu, peça pelo botão "Pedir ao Admin para verificar".`);
        return false;
      }
      log('erro', `Integrações: o runner não respondeu ao pedido automático ao Admin para ${rotulo} (incidente ${inc.id}); o resultado ficou incerto. Ele continua contado como enviado e por isso não será reenviado; se o Admin não apareceu, peça pelo botão "Pedir ao Admin para verificar".`);
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

    // agente que saiu do registro, ou que foi recriado com o mesmo slug (outra instância): o incidente e o silêncio dele somem.
    // Registro antigo, sem instância guardada, adota a instância atual do agente (não descarta).
    const instAtual = new Map(agentes.map((a) => [a.slug, instanciaDe(a)]));
    const mesmaInstancia = (x) => {
      if (!slugs.has(x.agente)) return false;
      const atual = instAtual.get(x.agente);
      if (!x.instancia) { x.instancia = atual; return true; }
      return atual == null || x.instancia === atual;
    };
    incidentes = incidentes.filter(mesmaInstancia);
    silenciadas = silenciadas.filter(mesmaInstancia);

    for (const ag of agentes) {
      const lido = L.lerEstado(ag);
      if (!lido.medido) {
        nao.push(dgIntegracoesIdioma.objeto({ agente: ag.slug, motivo: dgIntegracoesIdioma.campo(lido, "motivo") }));
        // sem medir, não dá para dizer que se recuperou: os incidentes já abertos continuam na faixa
        for (const inc of incidentes) if (inc.agente === ag.slug) faixa.add(inc.id);
        continue;
      }
      const porId = new Map(lido.itens.map((it) => [it.id, it]));
      // fecha o que ficou verde ou sumiu
      incidentes = incidentes.filter((inc) => {
        if (inc.agente !== ag.slug) return true;
        const it = porId.get(inc.integracao);
        return !!it && it.estado !== 'verde';
      });
      for (const it of lido.itens) {
        if (it.estado !== 'vermelho' || !elegivel(it, agoraN)) continue;
        if (ehSilenciada(ag.slug, it.id)) continue;
        let inc = incidentes.find((i) => i.agente === ag.slug && i.integracao === it.id);
        if (!inc) {
          inc = {
            id: crypto.randomUUID(), agente: ag.slug, integracao: it.id,
            categoria: categoriaDe(it.ultimaFalhaResultado || it.ultimoResultado),
            abertoEm: new Date(agoraN).toISOString(), adiadoAte: null, pedidoAutomaticoEm: null, instancia: instAtual.get(ag.slug) || null,
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
    if (automatico.envios.length !== enviosAntes) tentaGravar(gravaAutomatico, 'automatico.json');
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
    const ag = (registro.estado().agentes || []).find((a) => a.slug === agente && a.tipo !== 'admin');
    if (!ehSilenciada(agente, integracao)) silenciadas.push({ agente, integracao, instancia: ag ? instanciaDe(ag) : null });
    incidentes = incidentes.filter((i) => !(i.agente === agente && i.integracao === integracao));
    return tentaGravar(gravaIncidentes, 'incidentes.json');
  }

  function reativar(agente, integracao) {
    silenciadas = silenciadas.filter((s) => !(s.agente === agente && s.integracao === integracao));
    return tentaGravar(gravaIncidentes, 'incidentes.json');
  }

  /** Ligar só vale depois de gravar. Desligar vale na hora (para de enviar) mesmo se a gravação falhar. */
  function definirAutomatico(ligado, agoraMs) {
    const copia = dgIntegracoesIdioma.objeto({ ...dgIntegracoesIdioma.espalhar(automatico), ligado, alteradoEm: new Date(agoraMs).toISOString(), suspenso: false });
    if (ligado) {
      if (!tentaGravar(() => grava(arqAutomatico, copia), 'automatico.json')) return { gravou: false };
      automatico = copia;
      incidentesTravados = false;
      return { gravou: true };
    }
    automatico = copia;
    const gravou = tentaGravar(gravaAutomatico, 'automatico.json');
    if (gravou) incidentesTravados = false;
    return { gravou };
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
      categoria: i.categoria, categoriaTexto: dgIntegracoesIdioma.texto(CATEGORIAS[categoriaDe(i.categoria)]), abertoEm: i.abertoEm,
    }));
    return {
      ok: true, faixa, pedido: textoDoPedido(lista, registro, catalogo),
      automatico: { ligado: automatico.ligado, suspenso: automatico.suspenso === true },
      silenciadas: silenciadas.map((s) => ({ agente: s.agente, integracao: s.integracao })),
      naoMedidos: naoMedidos.map((n) => (dgIntegracoesIdioma.objeto({ agente: n.agente, agenteNome: nomeDoAgente(n.agente), motivo: leituraPadrao.localizarMotivo(n.motivo) }))),
    };
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'INTEGRACOES.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Integrações: não consegui ler docs/INTEGRACOES.md (${e.code || e.message}).`);
      H.erroJson(res, 500, dgIntegracoesIdioma.descricao("O documento das integrações não foi encontrado no servidor. Reinstale o DG Claw Web."));
    }
  }

  /** Confere {agente, integracao} pelo formato e pelo registro. Devolve { agente, integracao } ou responde o erro. */
  function parAgenteIntegracao(res, corpo) {
    const agente = corpo.agente; const integracao = corpo.integracao;
    if (typeof agente !== 'string' || !RX_SLUG.test(agente) || typeof integracao !== 'string' || !RX_ID.test(integracao)) {
      H.erroJson(res, 400, dgIntegracoesIdioma.descricao("Mande {\"agente\": \"<slug do agente>\", \"integracao\": \"<id da integração>\"}, com os dois no formato de letras minúsculas, números e hífen."));
      return null;
    }
    const ag = (registro.estado().agentes || []).find((a) => a.slug === agente && a.tipo !== 'admin');
    if (!ag) {
      H.erroJson(res, 404, dgIntegracoesIdioma.descricao("Não existe o agente \"{p0}\" no registro (o Admin não tem integrações medidas).", {p0: agente}));
      return null;
    }
    return { agente, integracao };
  }

  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    // Agente não usa estas rotas; o servidor já não as libera na caixa, isto é a segunda trava.
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, dgIntegracoesIdioma.descricao("As integrações são só do dono, pelo painel. Agente não usa esta rota."));
      return true;
    }
    if (sessao.papel === 'colaborador') {
      H.erroJson(res, 403, dgIntegracoesIdioma.descricao("Só o dono vê as integrações de todos os agentes."));
      return true;
    }
    const m = req.method;
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, dgIntegracoesIdioma.descricao("Use {p0} em {p1}.", {p0: usar, p1: p})); return true; };
    try {
      if (sub === '') {
        if (m !== 'GET') return metodoErrado('GET');
        H.enviaJson(res, 200, resposta(relogio()));   // só devolve a última avaliação; quem avalia é o temporizador
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
        if (!gravou) { H.erroJson(res, 500, dgIntegracoesIdioma.descricao("Não consegui guardar a mudança no disco. Confira o espaço e as permissões de {p0}; o que mudou vale só até reiniciar o Web.", {p0: dir})); return true; }
        H.enviaJson(res, 200, { ok: true, agente: par.agente, integracao: par.integracao, silenciada: sub === '/silenciar' });
        return true;
      }
      if (sub === '/automatico') {
        if (m !== 'POST') return metodoErrado('POST');
        const corpo = await H.lerJson(req, 1024);
        if (typeof corpo.ligado !== 'boolean') { H.erroJson(res, 400, dgIntegracoesIdioma.descricao("Mande {\"ligado\": true} ou {\"ligado\": false}.")); return true; }
        if (corpo.ligado && corpo.entendoORisco !== true) {
          H.erroJson(res, 400, dgIntegracoesIdioma.descricao("Para ligar, mande também {\"entendoORisco\": true}. Ligado, o Web chama o Admin sozinho quando uma integração cai. O Admin tem acesso total ao servidor, e um agente consegue registrar uma falha que não aconteceu, o que faria o Admin olhar uma integração que está boa. O pedido tem texto fixo e há limites (um por defeito, um a cada 6 horas por integração, cinco por dia)."));
          return true;
        }
        if (!definirAutomatico(corpo.ligado, relogio()).gravou) {
          H.erroJson(res, 500, corpo.ligado
            ? dgIntegracoesIdioma.descricao("Não consegui guardar a escolha no disco, então o automático continua desligado. Confira o espaço e as permissões de {p0} e tente de novo.", {p0: dir})
            : dgIntegracoesIdioma.descricao("O automático já está desligado agora e o Web não envia mais pedidos, mas não consegui guardar a escolha no disco: se o Web reiniciar, ele volta ligado. Confira o espaço e as permissões de {p0} e desligue de novo.", {p0: dir}));
          return true;
        }
        H.enviaJson(res, 200, { ok: true, automatico: { ligado: automatico.ligado } });
        return true;
      }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, dgIntegracoesIdioma.campo(e, "message")); return true; }
      log('erro', `Integrações: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, dgIntegracoesIdioma.descricao("Não consegui tratar o pedido das integrações. O detalhe está no log do Web (journalctl -u dgclaw-web)."));
      return true;
    }
    H.erroJson(res, 404, dgIntegracoesIdioma.descricao("Não existe {p0} {p1}. As rotas estão em GET {p2}/docs.md.", {p0: m, p1: p, p2: BASE}));
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
