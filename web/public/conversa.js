'use strict';
/* conversa.js: a tela de conversa do DG Claw Web.

   O que o servidor entrega por rota (nada mais é chamado daqui):
   GET /api/v1/agents, /messages, /stream (SSE), /wait, POST /send, /upload,
   GET /media/:id, /media/:id/thumb, POST /transcribe, /tts, GET /tts/cota.

   O ciclo de voz (só quando o servidor libera microfone e voz): grava -> o
   servidor transcreve -> o texto vai como mensagem -> a tela espera a resposta
   aparecer na conversa -> lê em voz alta no MESMO <audio> que foi destravado no
   primeiro toque.

   Duas coisas do iPhone mandam no desenho deste arquivo:
   1) som só toca depois de um gesto, e só no elemento que foi tocado dentro do
      gesto. Daí o destravarAudio() e o #player reusado pra sempre.
   2) quem usa "Reduzir Movimento" não pode depender de animação: tudo que muda
      vira TEXTO em #estado ou em #micTxt. */

const $ = id => document.getElementById(id);

/* ── Partida: quem é o agente desta página? ───────────────────────────────
   O endereço é /a/<slug>. A lista de agentes vem da API; o agente da página é o
   da lista com esse id. Sem lista ou sem agente, a tela explica o que houve. */
function slugDaUrl() {
  const m = /^\/a\/([^/]+)\/?$/.exec(location.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

function mostraErroTela(titulo, texto, agentes) {
  const caixa = $('erroTela');
  $('erroTelaTit').textContent = titulo;
  $('erroTelaTxt').textContent = texto;
  const links = $('erroTelaLinks');
  links.textContent = '';
  for (const a of agentes || []) {
    const l = document.createElement('a');
    l.href = '/a/' + encodeURIComponent(a.id);
    l.textContent = 'Abrir ' + a.nome;
    links.appendChild(l);
    links.appendChild(document.createTextNode('  '));
  }
  caixa.hidden = false;
  for (const id of ['cabecalho', 'chat']) { const e = $(id); if (e) e.hidden = true; }
  const barra = document.querySelector('.barra');
  if (barra) barra.hidden = true;
}

async function boot() {
  let d = null;
  try {
    const r = await fetch('/api/v1/agents', { cache: 'no-store' });
    if (r.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    try { d = await r.json(); } catch (e) { d = null; }
    if (!r.ok || !d || d.ok === false) {
      throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
    }
  } catch (e) {
    mostraErroTela('Não consegui listar os agentes',
                   e.message + '. Recarregue a página; se continuar, avise quem cuida do servidor.');
    return;
  }
  const lista = Array.isArray(d.agentes) ? d.agentes : [];
  if (!lista.length) {
    mostraErroTela('Nenhum agente por aqui ainda',
                   'O servidor não devolveu nenhum agente. Peça para cadastrarem um e recarregue.');
    return;
  }
  const slug = slugDaUrl();
  if (!slug) { location.replace('/a/' + encodeURIComponent(lista[0].id)); return; }
  const ag = lista.find(a => a.id === slug);
  if (!ag) {
    mostraErroTela('Não achei o agente "' + slug + '"',
                   'Esse endereço não corresponde a nenhum agente cadastrado. Escolha um da lista:',
                   lista);
    return;
  }
  // voz e microfone: o servidor diz por agente (ou, se preferir, uma vez para todos)
  const cap = nome => (ag[nome] !== undefined ? ag[nome] : d[nome]) === true;
  iniciaTela(ag, lista, { voz: cap('voz'), microfone: cap('microfone') });
}

function iniciaTela(AGENTE, agentesLista, caps) {
const dormir = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Admin primeiro (com selo "admin"); o resto na ordem que o servidor mandou. */
const agentesMenu = agentesLista.filter(a => a.tipo === 'admin')
  .concat(agentesLista.filter(a => a.tipo !== 'admin'));

const chat = $('chat'), wrap = $('wrap'), estadoEl = $('estado'), entrada = $('entrada');
const btnEnviar = $('btnEnviar'), btnMic = $('btnMic'), micTxt = $('micTxt');
const btnParar = $('btnParar'), btnContinua = $('btnContinua');
const btnLer = $('btnLer'), player = $('player'), avEl = $('av');
const menu = $('menu'), overlayMenu = $('overlayMenu'), listaAgentes = $('listaAgentes');
const fErro = $('faixaErro'), fAviso = $('faixaAviso');
const btnAnexo = $('btnAnexo'), inputArquivo = $('arquivo');
const anexoChip = $('anexoChip'), anexoLista = $('anexoLista'), anexoInfo = $('anexoInfo');
const lightbox = $('lightbox'), lbCorpo = $('lbCorpo'), lbNome = $('lbNome'),
      lbBaixar = $('lbBaixar');
const btnFim = $('btnFim'), fimNovas = $('fimNovas');

const API = '/api/v1/agents/' + encodeURIComponent(AGENTE.id);
const AQUI = location.pathname + location.search;
const EH_ADMIN = AGENTE.tipo === 'admin';
let novasAbaixo = 0, setaVisivel = false;   // a seta pro fim e o contador dela
/* mp3 de 0,08s em silêncio: é o que destrava o áudio no iOS dentro do gesto. */
const SILENCIO = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//NwwAAAAAAAAAAAAEluZm8AAAAPAAAABgAAAVMAnZ2dnZ2dnZ2dnZ2dnZ2dnbGxsbGxsbGxsbGxsbGxsbGxxcXFxcXFxcXFxcXFxcXFxdjY2NjY2NjY2NjY2NjY2NjY7Ozs7Ozs7Ozs7Ozs7Ozs7Oz/////////////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQEUQAAAAAAAAFTx3TIuwAAAAAAAAAAAAAAAAD/8xDEAAAAA0gAAAAATEFNRTMuMTAwVVVVVf/zEsQNAAADSAAAAABVVVVVVVVVVVVVVVVVVf/zEMQbAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxCgAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDENQAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRCAAADSAAAAABVVVVVVVVVVVVVVVVV';

/* Quem escreveu cada mensagem, pelo campo `origin` que o servidor manda:
   "dono" é quem conversa com o agente; "agente" e "rotina" são as falas do agente. */
const ehDono = m => !!m && m.origin === 'dono';
const ehAgente = m => !!m && (m.origin === 'agente' || m.origin === 'rotina');

let msgs = [];          // thread que veio da API
let pendentes = [];     // balões otimistas de quem escreve, ainda não confirmados
let lerRespostas = false;   // sempre desligada ao abrir; só o toque no botão liga
let continua = false;
let gravando = false, esperando = false, falando = false;
let pararPedido = false;
let resyncTimer = null;
let audioDestravado = false, ctxAudio = null;
let fonte = null;                   // EventSource do /stream
let streamAberto = false, jaConectou = false;
let religaTimer = null, religaEspera = 3000;
let avisoThread = null;             // último aviso da THREAD posto na faixa amarela
const ouvintesChegada = [];         // chamados no fim de cada integra()
let anexos = [];                    // arquivos colados/arrastados/escolhidos esperando o Enter
let carregouUmaVez = false;         // a primeira página já chegou (ou falhou)
let demoAtividade = false;         // o tutorial mostra um exemplo da faixa de atividade

/* Cabeçalho, título da aba e campo de texto com o nome do agente. */
function pintaAvatar(el, a) {
  if (!el) return;
  const img = a.avatar_img || (/^https:\/\//i.test(a.avatar || '') ? a.avatar : '');
  el.innerHTML = img ? `<img src="${esc(img)}" alt="">` : esc(a.avatar || (a.nome || '?').slice(0, 1));
  el.style.background = a.cor || '#2f9e5e';
}
document.documentElement.style.setProperty('--accent', AGENTE.cor || '#2f9e5e');
document.title = AGENTE.nome + ' - DG Claw';
$('nomeAgente').textContent = AGENTE.nome;
pintaAvatar(avEl, AGENTE);
entrada.placeholder = 'Escrever para ' + AGENTE.nome;
$('gmConversaSub').textContent = AGENTE.nome;
if (EH_ADMIN) $('avisoAdmin').hidden = false;
if (!caps.microfone) document.documentElement.classList.add('sem-mic');
if (!caps.voz) document.documentElement.classList.add('sem-voz');

/* ── Texto de estado, faixas, utilidades ──────────────────────────────────── */
function setEstado(txt, ehErro) {
  estadoEl.textContent = txt;
  estadoEl.style.color = ehErro ? '#c0392b' : '';
  pintaAtividade();
}

/* ── Indicador "O agente está trabalhando · rodando um comando" ────────────
   O evento SSE "atividade" traz a foto de todos os agentes; aqui vale a deste.
   Fica numa faixa entre a última mensagem e o campo de digitar (#atividade) e
   aparece sempre que o agente trabalha e o stream está aberto; o #estado do
   cabeçalho segue contando o que o app faz (gravando, enviando, erro). A foto
   fica em window.atividadeFoto. */
const atividadeEl = $('atividade');
const atvNomeEl = atividadeEl && atividadeEl.querySelector('.atv-nome');
const atvSepEl = atividadeEl && atividadeEl.querySelector('.atv-sep');
const atvAcaoEl = atividadeEl && atividadeEl.querySelector('.atv-acao');
window.atividadeFoto = null;
let atvDeslocaMs = 0;          // relógio do servidor menos o do aparelho
let atvDetalheAte = 0;         // até quando o toque mostra o detalhe no lugar do texto
let atvBase = null;            // a ação mostrada, pra fazer a troca com fade só quando ela muda
let atvFadeTimer = null;

function atvAgoraMs() { return Date.now() + atvDeslocaMs; }
function atvDuracao(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
function atvHora(iso) {
  const t = Date.parse(iso || '');
  if (!isFinite(t)) return '';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Sao_Paulo' }).replace(':', 'h');
}
/* {nome, acao, classe, titulo}: as duas metades da linha e o estilo */
function atvFrase(est) {
  const nome = AGENTE.nome;
  const ha = iso => { const t = Date.parse(iso || ''); return isFinite(t) ? atvDuracao(atvAgoraMs() - t) : null; };
  if (est.estado === 'sem_sinal') {
    const h = atvHora(est.ultimo_sinal);
    return { nome: nome + ' sem sinal' + (h ? ' desde ' + h : ''), acao: '', classe: 'atv-cinza',
             titulo: est.motivo || '' };
  }
  const d = ha(est.desde);
  if (est.alerta === 'permissao') {
    return { nome: nome + ' esperando sua autorização', acao: '', classe: 'atv-alerta',
             titulo: est.detalhe || '' };
  }
  if (est.alerta === 'ferramenta_longa') {
    return { nome: nome, acao: (est.detalhe || est.acao) + ' rodando' + (d ? ' há ' + d : ''), classe: 'atv-alerta',
             titulo: est.detalhe || '' };
  }
  if (est.alerta === 'sem_escrita') {
    const sem = ha(est.ultimo_sinal);
    return { nome: nome + ' sem escrever' + (sem ? ' há ' + sem : ''), acao: '', classe: 'atv-alerta',
             titulo: 'Sem nada escrito no registro da sessão' };
  }
  const longa = est.acao !== 'pensando' && est.desde &&
    atvAgoraMs() - Date.parse(est.desde) >= 60000;
  const oQue = est.detalhe || est.acao;
  return { nome: nome + ' está trabalhando',
           acao: oQue + (longa && d ? ', há ' + d : ''),
           base: oQue, classe: longa ? 'atv-longa' : '', titulo: est.detalhe || '' };
}
function pintaAtividade() {
  if (!atividadeEl || demoAtividade) return;
  const foto = window.atividadeFoto;
  const est = foto && foto.agentes ? foto.agentes[AGENTE.id] : null;
  // sem o stream aberto a foto está velha: não acusa trabalho
  const mostra = !!est && est.estado !== 'ocioso' && streamAberto;
  if (atividadeEl.hidden === mostra) {
    // a faixa entra e sai do fluxo e a área de mensagens muda de altura: quem
    // estava no fim da conversa continua no fim
    const noFim = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    atividadeEl.hidden = !mostra;
    if (noFim) chat.scrollTop = chat.scrollHeight;
  }
  if (!mostra) { atvBase = null; return; }
  const f = atvFrase(est);
  atividadeEl.className = f.classe;
  atividadeEl.title = f.titulo;
  if (Date.now() < atvDetalheAte) {
    // toque: o detalhe (ex.: "Bash: npm test, há 40 s") no lugar da linha
    const d = Date.parse(est.desde || '');
    const detalhe = est.detalhe || est.acao || est.motivo || f.nome;
    atvNomeEl.textContent = detalhe + (est.detalhe && isFinite(d) ? ', há ' + atvDuracao(atvAgoraMs() - d) : '');
    atvSepEl.hidden = true;
    atvAcaoEl.textContent = '';
    return;
  }
  atvNomeEl.textContent = f.nome;
  atvSepEl.hidden = !f.acao;
  const base = f.base || f.acao;
  if (atvBase !== null && atvBase !== base && f.acao) {
    // ação nova: some e volta em 150 ms. O texto só entra quando o fade-out acaba
    atvAcaoEl.classList.add('troca');
    clearTimeout(atvFadeTimer);
    atvFadeTimer = setTimeout(() => { pintaAtividade(); atvAcaoEl.classList.remove('troca'); }, 150);
    atvBase = base;
    return;
  }
  atvBase = base;
  atvAcaoEl.textContent = f.acao;
}
function integraAtividade(d) {
  if (!d || !d.agentes) return;
  if (typeof d.agora === 'number') atvDeslocaMs = d.agora * 1000 - Date.now();
  window.atividadeFoto = d;
  pintaAtividade();
}
if (atividadeEl) {
  atividadeEl.addEventListener('click', ev => {
    ev.stopPropagation();           // o #who em volta abre as mídias
    atvDetalheAte = Date.now() + 4000;
    pintaAtividade();
    setTimeout(pintaAtividade, 4100);
  });
  /* "há 3 min" anda sozinho, sem evento: um timer local. */
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !window.atividadeFoto) return;
    pintaAtividade();
  }, 15000);
}

/* O estado de descanso da tela depende do stream: sem ele as mensagens novas
   não chegam sozinhas, e a pessoa precisa ler isso (sem animação nenhuma). */
const ESTADOS_CONEXAO = ['pronto', 'conectando…', 'reconectando…'];
function estadoOcioso() {
  setEstado(streamAberto ? 'pronto' : (jaConectou ? 'reconectando…' : 'conectando…'));
}

/* Ociosa = nada do ciclo em curso. Os estados de trabalho terminam em
   reticências ("gravando…", "esperando o agente…", "transcrevendo…") ou em
   porcentagem ("enviando 40%"); os de conexão também têm reticências, por isso
   entram como exceção. Assim o "reconectando…" nunca pisa num estado de trabalho. */
function telaOciosa() {
  if (gravando || esperando || falando) return false;
  const t = estadoEl.textContent;
  return ESTADOS_CONEXAO.includes(t) || !/(…|%)$/.test(t);
}

function faixa(el, txt) {
  el.classList.remove('ok');
  // botões de uma faixa anterior (ex.: "Tentar de novo") não valem pro texto novo
  const acoes = el.querySelector('.acoes');
  if (acoes) acoes.remove();
  el.querySelector('.txt').textContent = txt || '';
  el.classList.toggle('aparece', !!txt);
  respiroDasFaixas();
}

/* As faixas flutuam sobre o fim da thread e escondiam o balão de baixo (no
   celular, o botão "reenviar" ficava embaixo da faixa de erro). O #wrap ganha
   um respiro do tamanho das faixas visíveis, e a thread desce junto se já
   estava no fim. */
function respiroDasFaixas() {
  const perto = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  let altura = 0;
  for (const f of [fErro, fAviso]) {
    if (f.classList.contains('aparece')) altura += f.offsetHeight + 8;
  }
  // a faixa do áudio pendente (05/10/2026) fica em cima das outras duas
  const fa = document.getElementById('faixaAudio');
  if (fa) {
    fa.style.bottom = '';
    if (fa.classList.contains('aparece')) {
      let topo = Infinity;
      for (const f of [fErro, fAviso]) {
        if (f.classList.contains('aparece')) topo = Math.min(topo, f.getBoundingClientRect().top);
      }
      if (topo !== Infinity) fa.style.bottom = Math.round(window.innerHeight - topo + 8) + 'px';
      altura += fa.offsetHeight + 8;
    }
  }
  wrap.style.paddingBottom = altura ? altura + 'px' : '';
  if (perto && altura) chat.scrollTop = chat.scrollHeight;
  posicionaSeta();
}
const mostraErro = t => faixa(fErro, t);
const mostraAviso = t => faixa(fAviso, t);
fErro.querySelector('.x').onclick = () => faixa(fErro, '');
fAviso.querySelector('.x').onclick = () => faixa(fAviso, '');

/* Avisos que vêm da thread (ex.: "Nenhum transcript...") valem enquanto o
   servidor manda. Lista vazia limpa a faixa, mas só se o que está nela é o aviso
   da thread: aviso de TTS ou de cota fica. O mesmo aviso repetido não reabre a
   faixa que foi fechada no ✕. */
function trataAvisosThread(avisos) {
  if (!Array.isArray(avisos)) return;
  if (avisos.length) {
    if (avisos[0] !== avisoThread) { avisoThread = avisos[0]; mostraAviso(avisoThread); }
    return;
  }
  if (avisoThread !== null && fAviso.querySelector('.txt').textContent === avisoThread) {
    mostraAviso('');
  }
  avisoThread = null;
}

/* Link na mensagem. O ponto, a vírgula ou o parêntese que fecham a frase não
   são do endereço: antes entravam no link e ele abria quebrado ("...mc83T.").
   Parêntese só fica se abriu dentro da própria URL (Wikipédia). Roda sobre
   texto já escapado, por isso o &quot; é tratado como uma aspa só. */
const linkify = s => s.replace(/https?:\/\/[^\s<]+/g, url => {
  let fim = '';
  for (;;) {
    if (url.endsWith('&quot;')) { fim = '&quot;' + fim; url = url.slice(0, -6); continue; }
    const c = url.slice(-1);
    if (!/[.,;:!?'\])}*_]/.test(c)) break;
    if (c === ')' && url.split('(').length > url.split(')').length - 1) break;
    fim = c + fim;
    url = url.slice(0, -1);
  }
  if (/^https?:\/\/$/.test(url)) return url + fim;
  return `<a href="${url}" target="_blank" rel="noopener">${url}</a>${fim}`;
});

/* Formatação em texto simples: **x** vira negrito, e o formato markdownv2 usa *x*, _x_ e
   `x`.
   Tudo é escapado ANTES: o que vira tag aqui é só o que eu mesmo escrevo.
   O `código` vale em qualquer formato. */
function formata(htmlSeguro, fmt) {
  let s = htmlSeguro.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>')
    // [texto](url): o linkify já fez o <a> da url, aqui ele ganha o texto
    .replace(/\[([^\]\n]+)\]\((<a href="([^"]+)"[^>]*>[^<]*<\/a>)\)/g,
             '<a href="$3" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  if (fmt === 'markdownv2') {
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<b>$2</b>')
         .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
         .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');
  }
  return s;
}

const ICONE_COPIAR = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
  '<rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" ' +
  'stroke="currentColor" stroke-width="2"/></svg>';

function textoEmParagrafos(txt, fmt) {
  return txt.split(/\n[ \t]*\n+/).filter(p => p.trim() !== '')
    .map(p => `<div class="p">${formata(linkify(esc(p.trim())), fmt)}</div>`).join('');
}

/* ```bloco``` vira a "caixa de texto" com fundo mais escuro e o botão de
   copiar: o agente põe ali o texto pronto pra colar em outro
   lugar, e um toque copia só ele, sem a introdução. Separado ANTES dos
   parágrafos, porque bloco com linha em branco no meio se partia em dois. */
function paragrafos(txt, fmt) {
  const partes = String(txt).split('```');
  let html = '';
  for (let i = 0; i < partes.length; i++) {
    const fechado = i % 2 === 1 && i < partes.length - 1;
    if (!fechado) {
      // ``` sem par fica como texto, com as crases
      const t = i % 2 === 1 ? '```' + partes[i] : partes[i];
      html += textoEmParagrafos(t, fmt);
      continue;
    }
    let cod = partes[i].replace(/^[A-Za-z0-9_+.-]{1,20}\n/, '')
                         .replace(/^\n+/, '').replace(/\s+$/, '');
    // no MarkdownV2, dentro do bloco só a crase e a barra vêm escapadas
    if (fmt === 'markdownv2') cod = cod.replace(/\\([`\\])/g, '$1');
    if (!cod) continue;
    html += `<div class="cod"><button type="button" class="codcopia" ` +
            `aria-label="Copiar o texto do bloco" title="Copiar o texto do bloco">` +
            `${ICONE_COPIAR}</button><pre>${esc(cod)}</pre></div>`;
  }
  return html;
}

const ROTULO_MIDIA = { photo: '📷 foto', video: '🎬 vídeo',
                       document: '📄 arquivo', voice: '🎤 áudio',
                       audio: '🎤 áudio' };

/* Mídia da thread por id, pro lightbox achar o que abrir sem reconsultar a API. */
const midias = {};

function tamanhoHumano(n) {
  if (!n && n !== 0) return '';
  const mb = n / (1024 * 1024);
  if (mb < 0.1) return Math.round(n / 1024) + ' KB';
  return (mb < 1 ? mb.toFixed(2) : mb.toFixed(1)).replace('.', ',') + ' MB';
}

/* O balão da mídia. Áudio toca ali mesmo (é o uso número um: ouvir o que o agente
   mandou); foto, vídeo e PDF abrem no lightbox ao toque. */
function htmlMidia(m) {
  const md = m.media;
  if (!md) return '';
  midias[md.id] = md;
  const rot = ROTULO_MIDIA[md.kind] || '📄 arquivo';
  if (!md.disponivel) {
    return `<span class="midoff">${rot} (o arquivo não está mais disponível)` +
           `<br><small>${esc(md.nome || '')}</small></span>`;
  }
  if (md.kind === 'audio' || md.kind === 'voice') {
    // data-aud: é por ele que o render reconhece o player que já está tocando e
    // reaproveita o mesmo nó, em vez de criar outro do zero a cada poll.
    return `<span class="midaudio combx"><audio controls playsinline preload="none" ` +
           `data-aud="${esc(md.id)}" src="${esc(md.url)}"></audio>${botaoBaixaMidia(md, rot)}</span>`;
  }
  const legenda = esc(md.nome || '') + (md.bytes ? ' (' + tamanhoHumano(md.bytes) + ')' : '');
  if (md.thumb) {
    return `<span class="midcx"><button class="mid" data-mid="${esc(md.id)}" aria-label="Abrir ${rot}">` +
           `<img loading="lazy" alt="${rot}" src="${esc(md.thumb)}" ` +
           `onerror="semThumb(this)">` +
           `<span class="midfb">${rot} ${legenda}</span>` +
           (md.kind === 'video' ? '<span class="play" aria-hidden="true">▶</span>' : '') +
           `<span class="lupa">${md.kind === 'video' ? 'vídeo' : 'toque para abrir'}</span></button>` +
           `${botaoBaixaMidia(md, rot)}</span>`;
  }
  return `<span class="midcx"><button class="mid semthumb" data-mid="${esc(md.id)}">` +
         `<img alt="" src="" hidden><span class="midfb">${rot} ${legenda}</span></button>` +
         `${botaoBaixaMidia(md, rot)}</span>`;
}

/* O ⬇ de todo anexo da thread: um link com `download`, FORA do botão da mídia
   (botão dentro de botão não vale). */
function botaoBaixaMidia(md, rot) {
  return `<a class="midbx" href="${esc(md.url)}" download="${esc(md.nome || '')}" ` +
         `title="Baixar ${esc(md.nome || '')}" aria-label="Baixar ${rot.replace(/^\S+\s/, '')}">⬇</a>`;
}

/* Miniatura que não veio (documento que não é PDF, ou geração falhou): o balão
   vira uma linha com o nome do arquivo, e o toque continua abrindo. */
function semThumb(img) {
  const caixa = img.closest('.mid');
  if (caixa) caixa.classList.add('semthumb');
}
window.semThumb = semThumb;

/* As prévias do balão otimista com vários anexos (já subiram; falta a mensagem
   sair e a cópia de verdade voltar na thread). */
function htmlAnexosLocal(lista) {
  const itens = lista.map(a => {
    if (a.previa && a.kind === 'photo') {
      return `<span class="mid"><img alt="${esc(a.nome)}" src="${a.previa}"></span>`;
    }
    if (a.previa && a.kind === 'video') {
      return `<span class="mid"><video src="${a.previa}" muted playsinline ` +
             `preload="metadata"></video></span>`;
    }
    return `<span class="midoff">${ROTULO_MIDIA[a.kind] || '📄 arquivo'} ` +
           `${esc(a.nome || '')} (${tamanhoHumano(a.bytes)})</span>`;
  });
  return `<span class="midgrade${lista.length > 1 ? ' varios' : ''}">${itens.join('')}</span>`;
}

/* Chama a API e traduz falha em mensagem que se lê. Nunca deixa erro mudo.
   opt.timeoutMs: no iPhone em segundo plano o fetch pode ficar pendurado pra
   sempre sem erro nenhum; o AbortController transforma isso em falha legível. */
async function api(url, opt) {
  opt = opt || {};
  const init = { cache: 'no-store', method: opt.method || 'GET' };
  if (opt.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opt.body);
  }
  let ctl = null, relogio = null;
  if (opt.timeoutMs) {
    ctl = new AbortController();
    init.signal = ctl.signal;
    relogio = setTimeout(() => ctl.abort(), opt.timeoutMs);
  }
  const estourou = () => ctl && ctl.signal.aborted;
  const msgEstouro = () => 'o app não respondeu em ' + Math.round(opt.timeoutMs / 1000) + ' s';
  try {
    let r;
    try {
      r = await fetch(url, init);
    } catch (e) {
      if (estourou()) throw new Error(msgEstouro());
      throw new Error('o app não respondeu (' + (e.message || 'sem rede') + ')');
    }
    if (r.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(AQUI);
      throw new Error('sessão expirada');
    }
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    // o corpo pode ter sido cortado pelo abort no meio da leitura
    if (estourou()) throw new Error(msgEstouro());
    if (!r.ok || (d && d.ok === false)) {
      throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
    }
    return d || {};
  } finally {
    if (relogio) clearTimeout(relogio);
  }
}

/* ── Thread ───────────────────────────────────────────────────────────────── */
/* Renderização por chave: cada nó da thread (separador de dia, mensagem,
   balão otimista) guarda o HTML com que foi montado. Nó com o mesmo HTML é o
   MESMO elemento de antes, então o <audio> que está tocando nem sabe que houve
   render (foi o bug de 20/09: trocar o innerHTML inteiro matava o áudio). */
const nosThread = new Map();   // chave -> { html, el }
const modelo = document.createElement('template');

function criaNo(html) {
  modelo.innerHTML = html;
  return modelo.content.firstElementChild;
}

/* Nó refeito (a mensagem mudou) com um áudio em uso dentro: o player vivo vai
   pro nó novo no lugar do player recém-criado. Um <audio> fora do documento
   continua tocando, então a troca não interrompe o som. */
function transplantaAudio(velho, novo) {
  for (const el of velho.querySelectorAll('audio[data-aud]')) {
    if (el.ended || (el.paused && el.currentTime === 0)) continue;
    const alvo = novo.querySelector('audio[data-aud="' + CSS.escape(el.dataset.aud) + '"]');
    if (alvo) alvo.replaceWith(el);
  }
}

/* Três estados do balão otimista. 'enviada' fica como "✓ hh:mm" até a cópia
   real aparecer (e para sempre, se ela não vier: a mensagem foi entregue).
   'falhou' não some sozinho: a pessoa decide se reenvia ou descarta. */
function metaPendente(p) {
  if (p.estado === 'enviada') {
    return `<span class="meta" title="entregue">✓ ${esc(p.hhmm)}</span>`;
  }
  if (p.estado === 'falhou') {
    const ocupado = p.conferindo ? ' disabled' : '';
    return `<span class="meta"><span style="color:#c0392b;font-weight:600" ` +
           `title="${esc(p.erro || 'motivo desconhecido')}">não foi enviada</span> ` +
           `<button class="mini reenviar" data-pend="${p.n}"${ocupado}>reenviar</button> ` +
           `<button class="mini descartar" data-pend="${p.n}"${ocupado}>descartar</button></span>`;
  }
  if (p.estado === 'fila') {
    return '<span class="meta" title="sai assim que a parte anterior chegar">na fila…</span>';
  }
  return '<span class="meta">enviando…</span>';
}

/* A legenda que só repete o tipo ("📷 foto" embaixo da foto) não aparece. */
function legendaUtil(m) {
  if (!m.text) return '';
  if (m.media && Object.values(ROTULO_MIDIA).includes(m.text)) return '';
  return m.text;
}

function htmlCorpo(m) {
  let midia = '';
  if (m.local && m.local.anexos) {
    midia = htmlAnexosLocal(m.local.anexos);
  } else if (m.media) {
    midia = htmlMidia(m);
  } else if (m.kind && m.kind !== 'text' && ROTULO_MIDIA[m.kind]) {
    // veio marcado como mídia e o arquivo não chegou até aqui: o rótulo explica o que era
    midia = `<span class="midia">${ROTULO_MIDIA[m.kind]} (não baixada)</span>`;
  }
  const cita = m.cita ? `<div class="cita"><b>${ehDono({ origin: m.cita.origin }) ? 'Você' :
      esc(AGENTE.nome)}</b>${esc(m.cita.texto)}</div>` : '';
  const leg = legendaUtil(m);
  const corpo = leg ? paragrafos(leg, m.fmt) : '';
  const reac = (m.reacoes && m.reacoes.length)
    ? `<span class="reac">${m.reacoes.map(esc).join(' ')}</span>` : '';
  const meta = m.pendente ? metaPendente(m.local)
    : `<span class="meta">${m.editada ? 'editada · ' : ''}${esc(m.hhmm)}</span>`;
  return cita + midia + corpo + reac + meta;
}

/* Conversa vazia: nunca tela em branco. */
function htmlVazio() {
  return '<div class="vazio"><div class="vz-ico" aria-hidden="true">🦞</div>' +
    `<b>O ${esc(AGENTE.nome)} está acordando...</b>` +
    '<small>Ele ainda não escreveu nada por aqui. Assim que responder, a conversa ' +
    'aparece nesta tela sozinha. Você já pode mandar a primeira mensagem.</small></div>';
}

function render(opt) {
  opt = opt || {};
  const perto = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  const todas = msgs.slice();
  // o pendente entra na posição cronológica dele (hora local da criação), e
  // não colado no fim, por baixo das respostas que chegaram depois
  for (const p of pendentes) {
    todas.push({ id: 'pend-' + p.n, ep: p.epLocal, dia: p.dia,
                 hhmm: p.hhmm, origin: 'dono', text: p.texto,
                 kind: p.kind || 'text', pendente: true, local: p });
  }
  todas.sort((a, b) => a.ep - b.ep);
  const itens = [];            // [chave, html]
  if (todas.length) {
    itens.push(['topo', maisAntigas
      ? `<div class="topo">${carregandoAntigas ? 'carregando mensagens antigas…'
                                              : 'role para ver as antigas'}</div>`
      : '<div class="topo">início da conversa</div>']);
  }
  let dia = '', anterior = null;
  for (const m of todas) {
    if (m.dia !== dia) {
      dia = m.dia;
      itens.push(['dia:' + dia, `<div class="dia"><span>${esc(dia)}</span></div>`]);
      anterior = null;
    }
    const lado = ehDono(m) ? 'me' : 'her';
    const troca = anterior !== null && anterior !== lado ? ' gap' : '';
    itens.push([m.id, `<div class="row ${lado}${troca}" data-msg="${esc(m.id)}">` +
                      `<div class="bub">${htmlCorpo(m)}</div></div>`]);
    anterior = lado;
  }
  if (!itens.length && carregouUmaVez) itens.push(['vazio', htmlVazio()]);

  const usadas = new Set(), nos = [];
  for (let [chave, html] of itens) {
    // chave repetida não pode reusar o mesmo elemento duas vezes no wrap
    while (usadas.has(chave)) chave += '+';
    usadas.add(chave);
    const velho = nosThread.get(chave);
    let el;
    if (velho && velho.html === html) {
      el = velho.el;
    } else {
      el = criaNo(html);
      if (velho) transplantaAudio(velho.el, el);
      nosThread.set(chave, { html: html, el: el });
    }
    nos.push(el);
  }
  for (const chave of Array.from(nosThread.keys())) {
    if (!usadas.has(chave)) nosThread.delete(chave);
  }
  // mesma lista de nós na mesma ordem: não encosta no DOM
  const atuais = wrap.children;
  const igual = atuais.length === nos.length && nos.every((el, i) => atuais[i] === el);
  if (igual) return;
  // Mensagens antigas entrando no topo: a tela fica parada onde a pessoa está
  // lendo (a altura nova vai toda pra cima do que ele vê).
  const alturaAntes = chat.scrollHeight, topoAntes = chat.scrollTop;
  aplicaNos(nos);
  if (opt.segurarPosicao) chat.scrollTop = topoAntes + (chat.scrollHeight - alturaAntes);
  else if (perto && !opt.semRolar) chat.scrollTop = chat.scrollHeight;
  respiroDasFaixas();
  guardaCache();
  atualizaSeta();
}

/* Põe a lista de nós no #wrap mexendo só no que mudou. O replaceChildren
   recolocava TODOS: com milhares de balões (depois de um pulo da busca), cada
   cartão de prévia que chegava custava 300 ms de tela travada. Os nós que
   ficam já estão na ordem certa entre si (a thread é ordenada por ep), então
   basta tirar os que saíram e inserir os novos no lugar. */
function aplicaNos(nos) {
  const ficam = new Set(nos);
  for (const el of Array.from(wrap.children)) if (!ficam.has(el)) el.remove();
  let atual = wrap.firstElementChild;
  for (const el of nos) {
    if (el === atual) { atual = atual.nextElementSibling; continue; }
    wrap.insertBefore(el, atual);
  }
}

const normaliza = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

/* Some com o balão otimista quando a mensagem de verdade aparece na thread.
   Casa pendente 'enviada' e também 'falhou' (um envio dado como perdido pode
   ter ido: timeout do lado de cá com o relay tendo entregado). Nunca casa
   'enviando', pra prévia de upload não sumir no meio. Só vale mensagem de
   quem escreve mais nova que o envio (ep do servidor, ou a hora local de criação
   quando o servidor não chegou a responder), pra um "ok" antigo não apagar um
   "ok" novo. Cada mensagem real consome um pendente só. */
function limpaPendentes() {
  if (!pendentes.length) return;
  const consumidas = new Set();
  pendentes = pendentes.filter(p => {
    if (p.estado !== 'enviada' && p.estado !== 'falhou') return true;
    const piso = (p.ep != null ? p.ep : p.epLocal) - 60;
    const achou = msgs.find(m => ehDono(m) && !consumidas.has(m.id) &&
      m.ep >= piso &&
      ((p.path && m.media && m.media.path === p.path) ||
       (p.anexos && m.media && p.anexos.some(a => a.path === m.media.path)) ||
       (p.texto && normaliza(m.text) === normaliza(p.texto))));
    if (!achou) return true;
    consumidas.add(achou.id);
    soltaPrevias(p);
    return false;
  });
}

/* Recebe o evento "msgs" do stream ({novas, sumidas, avisos}) ou, por
   compatibilidade, uma lista simples de mensagens (/wait). */
function integra(d) {
  if (!d) return;
  const lista = Array.isArray(d);
  const novas = lista ? d : (d.novas || []);
  const sumidas = lista ? [] : (d.sumidas || []);
  if (sumidas.length) {
    // o id muda quando a mídia é resolvida depois: a versão velha sai
    const fora = new Set(sumidas);
    msgs = msgs.filter(m => !fora.has(m.id));
  }
  const vistos = new Set(msgs.map(m => m.id));
  // a seta conta a resposta que chegou com a pessoa lendo lá em cima
  const longe = distanciaDoFim() >= 160, topoAntes = maiorEp();
  for (const m of novas) {
    if (!vistos.has(m.id)) {
      msgs.push(m);
      vistos.add(m.id);
      if (longe && m.ep > topoAntes && ehAgente(m)) novasAbaixo++;
    }
  }
  msgs.sort((a, b) => a.ep - b.ep);
  limpaPendentes();
  render();
  atualizaSeta();
  if (!lista) trataAvisosThread(d.avisos);
  for (const f of ouvintesChegada.slice()) {
    try { f(novas); } catch (e) { console.warn('ouvinte de chegada falhou:', e); }
  }
}

/* ── Carregar: a página mais nova, e as antigas quando rola pra cima ─────── */
/* A tela pede só as últimas 60. Rolar até perto do topo traz mais 80, quantas
   vezes precisar, até o começo da conversa. */
const PAGINA = 60, PAGINA_ANTIGAS = 80;
let maisAntigas = true, carregandoAntigas = false;
/* Sobe a cada troca inteira de `msgs`: uma página pedida antes da troca chega
   depois e não pode ser colada na janela nova. */
let geracaoJanela = 0;

const menorEp = () => msgs.reduce((m, x) => Math.min(m, x.ep), Infinity);

/* Devolve true se a página chegou e foi aplicada. */
async function carregar(primeiraVez) {
  let ok = false;
  try {
    const d = await api(API + '/messages?limit=' + PAGINA);
    const novas = d.msgs || [];
    if (primeiraVez || !msgs.length) {
      geracaoJanela++;
      msgs = novas;
      maisAntigas = !!d.mais_antigas;
    } else if (novas.length) {
      // a página nova manda em tudo do primeiro ep dela pra frente; o que veio
      // rolando pra cima (mais velho que isso) fica
      const piso = novas[0].ep;
      msgs = msgs.filter(m => m.ep < piso).concat(novas);
    }
    msgs.sort((a, b) => a.ep - b.ep);
    carregouUmaVez = true;
    limpaPendentes();
    render();
    if (primeiraVez) {
      chat.scrollTop = chat.scrollHeight;
      // conversa curta ou página que não encheu a tela: já pede as antigas
      verificaBordas();
    }
    trataAvisosThread(d.avisos || []);
    for (const f of ouvintesChegada.slice()) {
      try { f([]); } catch (e) { console.warn('ouvinte de chegada falhou:', e); }
    }
    ok = true;
  } catch (e) {
    mostraErro('Não consegui carregar a conversa: ' + e.message);
    if (!carregouUmaVez) { carregouUmaVez = true; render(); }
  }
  return ok;
}

async function carregaAntigas() {
  if (carregandoAntigas || !maisAntigas || !msgs.length) return;
  carregandoAntigas = true;
  const geracao = geracaoJanela;
  let ok = false;
  render({ segurarPosicao: true });
  try {
    const d = await api(API + '/messages?limit=' + PAGINA_ANTIGAS + '&before=' +
                        encodeURIComponent(menorEp()));
    // a janela foi trocada no meio do pedido: esta página é de outro trecho
    if (geracao === geracaoJanela) {
      const ids = new Set(msgs.map(m => m.id));
      const antigas = (d.msgs || []).filter(m => !ids.has(m.id));
      msgs = antigas.concat(msgs);
      maisAntigas = !!d.mais_antigas && antigas.length > 0;
      ok = true;
    }
  } catch (e) {
    mostraErro('Não consegui trazer as mensagens antigas: ' + e.message);
  } finally {
    carregandoAntigas = false;
    render({ segurarPosicao: true });
  }
  // A página nova pode não ter enchido a tela e, com o scrollTop reposicionado,
  // o iPhone não dispara mais scroll: sem este encadeamento a rolagem parava.
  if (ok || geracao !== geracaoJanela) requestAnimationFrame(verificaBordas);
}

/* Leva ao fim da conversa. */
function voltaAoFim() {
  chat.scrollTop = chat.scrollHeight;
  atualizaSeta();
}

function verificaBordas() {
  if (!chat.clientHeight) return;      // tela escondida: não é rolagem de verdade
  if (chat.scrollTop < 600) carregaAntigas();
}
chat.addEventListener('scroll', verificaBordas, { passive: true });

/* Sentinelas fora do #wrap (o aplicaNos só mexe nos filhos dele). O evento de
   scroll sozinho falha no iPhone: com a inércia e o scrollTop reposicionado ele
   deixa de disparar, e o observador pega o mesmo caso por outro caminho. */
const sentTopo = document.createElement('div');
const sentFim = document.createElement('div');
for (const el of [sentTopo, sentFim]) {
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'height:1px;pointer-events:none';
}
chat.insertBefore(sentTopo, wrap);
chat.appendChild(sentFim);
if (typeof IntersectionObserver !== 'undefined') {
  const io = new IntersectionObserver(es => {
    if (es.some(e => e.isIntersecting)) verificaBordas();
  }, { root: chat, rootMargin: '600px 0px 600px 0px' });
  io.observe(sentTopo);
  io.observe(sentFim);
}

/* Cache no aparelho: ao abrir, a conversa aparece NA HORA com o que estava na
   tela da última vez, e a página nova chega por cima em seguida. Sai no logout. */
const CHAVE_CACHE = 'dgclaw:' + AGENTE.id + ':ultimas';
let cacheTimer = null;
function guardaCache() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    try {
      const ultimas = msgs.slice(-PAGINA);
      localStorage.setItem(CHAVE_CACHE, JSON.stringify({ em: Date.now(), msgs: ultimas }));
    } catch (e) {
      console.warn('não consegui guardar a conversa no aparelho:', e.message);
    }
  }, 1500);
}
function leCache() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAVE_CACHE) || 'null');
    if (d && Array.isArray(d.msgs) && d.msgs.length) return d.msgs;
  } catch (e) {
    console.warn('cache da conversa ilegível, ignorado:', e.message);
  }
  return null;
}
/* Sair apaga o que ficou guardado neste aparelho. */
$('formSair').addEventListener('submit', () => {
  try {
    for (const k of Object.keys(localStorage)) if (k.indexOf('dgclaw:') === 0) localStorage.removeItem(k);
  } catch (e) { console.warn('não consegui limpar o aparelho ao sair:', e.message); }
});

/* ── Stream: as mensagens chegam sozinhas (SSE) ──────────────────────────── */
/* Um EventSource só. Queda simples (rede, o servidor fechando depois de ~50
   min) o próprio navegador religa mandando Last-Event-ID. Se ele desistir
   (CLOSED: 401, 5xx, servidor fora), religo com espera crescente até 30 s. */
function maiorEp() {
  let ep = 0;
  for (const m of msgs) if (m.ep > ep) ep = m.ep;
  return ep;
}

function mudouStream() {
  pintaAtividade();
  if (streamAberto) {
    // só troca de volta pra "pronto" o que era estado de conexão
    if (ESTADOS_CONEXAO.includes(estadoEl.textContent) && !gravando && !esperando &&
        !falando) estadoOcioso();
  } else if (telaOciosa()) {
    estadoOcioso();
  }
}

let versaoVista = null;     // versao_js do primeiro "ola"; se mudar, o servidor foi atualizado

function ligaStream() {
  if (religaTimer) { clearTimeout(religaTimer); religaTimer = null; }
  if (fonte) fonte.close();
  streamAberto = false;
  const ep = maiorEp();
  const since = ep ? Math.floor(ep - 120) : 0;
  const es = new EventSource(API + '/stream?since=' + since);
  fonte = es;
  mudouStream();
  const abriu = () => {
    religaEspera = 3000;
    if (!streamAberto) { streamAberto = true; jaConectou = true; mudouStream(); }
  };
  /* Cada evento traz JSON; JSON ruim vira aviso no console com o começo do
     texto, nunca erro mudo. */
  const ouve = (nome, fn, marcaAberto) => es.addEventListener(nome, ev => {
    if (fonte !== es) return;
    if (marcaAberto) abriu();
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch (e) {
      console.warn('stream: evento ' + nome + ' com JSON inválido (' + e.message + '):',
                   String(ev.data).slice(0, 200));
      return;
    }
    fn(d);
  });
  ouve('ola', d => {
    if (d && d.versao_js) {
      if (versaoVista === null) versaoVista = d.versao_js;
      else if (versaoVista !== d.versao_js) {
        console.warn('versão da tela mudou no servidor (' + versaoVista + ' -> ' + d.versao_js +
                     '): recarrego a página assim que a tela estiver ociosa');
        precisaRecarregar = true;
        tentaRecarregar();
      }
    }
  }, true);
  ouve('msgs', integra, true);
  ouve('atividade', integraAtividade, false);
  es.onerror = () => {
    if (fonte !== es) return;
    if (streamAberto) { streamAberto = false; mudouStream(); }
    if (es.readyState !== EventSource.CLOSED) return;   // o navegador religa sozinho
    console.warn('stream: conexão encerrada em ' + API + '/stream, religo em ' +
                 (religaEspera / 1000) + ' s');
    const espera = religaEspera;
    religaEspera = Math.min(religaEspera * 2, 30000);
    religaTimer = setTimeout(() => {
      religaTimer = null;
      // carregar() primeiro: se a sessão caiu, é ele que leva pro login
      carregar(false).then(ligaStream);
    }, espera);
  };
}

/* O iPhone mata a conexão com o app em segundo plano: ao voltar, conexão nova
   e a thread recarregada. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  /* O fetch que estava no ar quando o app foi pro fundo pode nunca voltar.
     Passados 90 s, o balão vira 'falhou' (com reenviar); se a resposta ainda
     chegar depois, mandaTexto promove pra 'enviada'. */
  for (const p of pendentes) {
    if (p.estado === 'enviando' && Date.now() - p.tentouEm > 90000) {
      marcaFalhou(p, 'o envio ficou pendurado enquanto o app estava em segundo plano');
    }
  }
  ligaStream();
  carregar(false);
});

/* ── Página velha: o servidor avisa no "ola" que o JS mudou ─────────────── */
/* Recarregar joga fora o que só existe na memória desta página: gravação,
   espera, chip de anexo, texto no campo e balão ainda não resolvido. Então só
   recarrega com tudo isso vazio, e tenta de novo a cada 5 s. */
let precisaRecarregar = false, recargaTimer = null;

function podeRecarregar() {
  return telaOciosa() && !anexos.length && !entrada.value.trim() &&
         !pendentes.some(p => p.estado === 'enviando' || p.estado === 'falhou' ||
                              p.estado === 'fila');
}

function tentaRecarregar() {
  if (!precisaRecarregar) return;
  if (podeRecarregar()) {
    console.warn('recarregando a página pra pegar o JS novo');
    location.reload();
    return;
  }
  if (!recargaTimer) recargaTimer = setInterval(tentaRecarregar, 5000);
}

/* Rede de segurança: o stream é a via principal; isto só pega o que ele
   perder por algum motivo que eu não previ. */
function ligaResync() {
  if (resyncTimer) return;
  resyncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !gravando) carregar(false);
  }, 90000);
}

/* ── Visor de arquivos ────────────────────────────────────────────────────
   Foto, vídeo e áudio abrem direto do arquivo. PDF abre numa moldura (no
   computador) e todo o resto vira um cartão com "abrir" e "baixar". O ✕ fica
   sempre no topo (abaixo do notch), e o "voltar" do sistema fecha o visor em
   vez de sair da conversa (pushState ao abrir, popstate fecha). */
let lbMid = null;
let visorNoHistorico = false, voltaPendente = false, voltaRelogio = null;
const visorAberto = () => lightbox.classList.contains('abre');
const btnLbFechar = $('lbFechar');
const lbTopo = lightbox.querySelector('.lbtopo');
// o ✕ vai pra esquerda, onde o polegar procura o "voltar" no iPhone
if (lbTopo && lbTopo.firstElementChild !== btnLbFechar) lbTopo.prepend(btnLbFechar);
btnLbFechar.setAttribute('aria-label', 'Fechar o arquivo e voltar pra conversa');

function marcaHistorico() {
  try {
    history.pushState(Object.assign({}, history.state || {}, { dgVisor: 1 }), '');
    visorNoHistorico = true;
  } catch (e) {
    visorNoHistorico = false;
    console.warn('visor sem entrada no histórico:', e.message);
  }
}
window.addEventListener('popstate', () => {
  if (voltaPendente) {
    voltaPendente = false;
    clearTimeout(voltaRelogio);
    // abriu outro arquivo antes do back terminar: empilha agora
    if (visorAberto() && !visorNoHistorico) marcaHistorico();
    return;
  }
  if (visorAberto() && visorNoHistorico) {
    visorNoHistorico = false;
    fechaLightbox(true);
  }
});

const ICONE_DOC = { document: '📄', photo: '🖼️', video: '🎬', audio: '🎤', voice: '🎤' };

function cartaoDoc(md) {
  const ico = ICONE_DOC[md.kind] || '📦';
  const tam = md.bytes ? tamanhoHumano(md.bytes) : '';
  return `<div class="vcard"><div class="ico" aria-hidden="true">${ico}</div>` +
    `<b>${esc(md.nome || 'arquivo')}</b>` +
    `<small>${esc(tam)}${tam ? ' · ' : ''}Esse tipo de arquivo não abre aqui dentro.</small>` +
    `<a href="${esc(md.url)}" target="_blank" rel="noopener">Abrir em outra aba</a>` +
    `<a class="sec" href="${esc(md.url)}" download="${esc(md.nome || '')}">Baixar</a></div>`;
}

function abreLightbox(mid) {
  const md = midias[mid];
  if (!md) return;
  const jaAberto = visorAberto();
  lbCorpo.innerHTML = '';
  lbMid = mid;
  lbNome.textContent = md.nome || 'arquivo';
  lbBaixar.href = md.url;
  lbBaixar.setAttribute('download', md.nome || '');
  const ehPdf = /\.pdf$/i.test(md.nome || '');
  if (md.kind === 'photo') {
    const img = document.createElement('img');
    img.alt = md.nome || 'foto';
    img.src = md.url;
    img.onerror = () => { lbCorpo.innerHTML = cartaoDoc(md); };
    lbCorpo.appendChild(img);
  } else if (md.kind === 'video') {
    const v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.playsInline = true; v.src = md.url;
    v.onerror = () => { lbCorpo.innerHTML = cartaoDoc(md); };
    lbCorpo.appendChild(v);
  } else if (md.kind === 'audio' || md.kind === 'voice') {
    const a = document.createElement('audio');
    a.controls = true; a.autoplay = true; a.src = md.url;
    lbCorpo.appendChild(a);
  } else if (ehPdf && !ehToque) {
    const f = document.createElement('iframe');
    f.src = md.url;
    f.title = md.nome || 'PDF';
    lbCorpo.appendChild(f);
  } else {
    lbCorpo.innerHTML = cartaoDoc(md);
  }
  lightbox.classList.add('abre');
  if (!jaAberto) {
    if (!voltaPendente) marcaHistorico();
    else visorNoHistorico = false;      // empilha quando o back pendente chegar
  }
}

function fechaLightbox(peloHistorico) {
  if (!visorAberto()) return;
  lightbox.classList.remove('abre');
  lbCorpo.innerHTML = '';       // para o vídeo/áudio de tocar ao fechar
  lbMid = null;
  if (peloHistorico !== true && visorNoHistorico) {
    // tira do histórico a entrada que o abrir empilhou
    visorNoHistorico = false;
    voltaPendente = true;
    clearTimeout(voltaRelogio);
    voltaRelogio = setTimeout(() => { voltaPendente = false; }, 1500);
    history.back();
  }
}
btnLbFechar.onclick = () => fechaLightbox();
lightbox.addEventListener('click', ev => {
  // tocar fora da foto fecha; no cartão não, que o toque ali é nos botões
  if (ev.target === lightbox || ev.target === lbCorpo) fechaLightbox();
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && visorAberto()) fechaLightbox();
});

/* Link pra um arquivo do próprio app (o agente escreveu a URL na mensagem):
   abre no visor em vez de navegar. */
const RE_URL_MIDIA = /^\/api\/v1\/media\/([^/?#]+)(?:\/.*)?$/;
document.addEventListener('click', ev => {
  const a = ev.target.closest ? ev.target.closest('a[href]') : null;
  if (!a || a === lbBaixar || a.hasAttribute('download') || a.closest('#lightbox')) return;
  let u;
  try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
  if (u.host !== location.host) return;
  const m = RE_URL_MIDIA.exec(u.pathname);
  if (!m || !midias[m[1]]) return;
  ev.preventDefault();
  ev.stopPropagation();
  destravarAudio();
  abreLightbox(m[1]);
}, true);

/* App instalado no iPhone: link de fora abria numa janela do sistema POR CIMA
   do app, e a pessoa ficava presa nela. O esquema x-safari-https (iOS 17 em
   diante) entrega o endereço pro Safari de verdade. No navegador comum e fora
   do iPhone nada muda: o target=_blank já abre aba nova. */
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
document.addEventListener('click', ev => {
  if (!IOS || !document.documentElement.classList.contains('pwa')) return;
  if (ev.defaultPrevented) return;
  const a = ev.target.closest ? ev.target.closest('a[href]') : null;
  if (!a || a.hasAttribute('download')) return;
  let u;
  try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
  if (u.origin === location.origin || !/^https?:$/.test(u.protocol)) return;
  ev.preventDefault();
  location.href = 'x-safari-' + u.href;
});

async function copiaTexto(t) {
  try {
    await navigator.clipboard.writeText(t);
    setEstado('texto copiado');
    return true;
  } catch (e) {
    mostraErro('O navegador não deixou copiar (' + e.message + '). Segure o texto ' +
               'no balão e use o "Copiar" do sistema.');
    return false;
  }
}

/* O quadradinho do bloco copia só o que está dentro dele. */
wrap.addEventListener('click', ev => {
  const bt = ev.target.closest ? ev.target.closest('.codcopia') : null;
  if (!bt) return;
  ev.preventDefault();
  ev.stopPropagation();
  const pre = bt.parentElement ? bt.parentElement.querySelector('pre') : null;
  if (!pre) return;
  copiaTexto(pre.textContent).then(ok => {
    if (!ok) return;
    bt.classList.add('ok');
    setTimeout(() => bt.classList.remove('ok'), 1600);
  });
}, true);

wrap.addEventListener('click', ev => {
  const alvo = ev.target.closest ? ev.target.closest('.mid[data-mid]') : null;
  if (alvo) { destravarAudio(); abreLightbox(alvo.getAttribute('data-mid')); }
});

const ehToque = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');

/* ── Mandar arquivo (foto, vídeo, áudio, PDF) ─────────────────────────────── */
/* Um arquivo por pedido (POST /upload, multipart): até 200 MB cada. */
const TETO_UPLOAD = 200 * 1024 * 1024;

function kindLocal(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/.test(n)) return 'photo';
  if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/.test(n)) return 'audio';
  return 'document';
}

/* Vários anexos numa mensagem. Cada arquivo colado, arrastado ou escolhido ENTRA na
   fila do chip, na ordem, e já começa a subir (upload com enviar=0: fica
   guardado no servidor, nada sai pra agente). O Enter manda o texto e os ids
   de todos juntos pelo /send. Se um não sobe, a mensagem não sai: o cartão dele
   mostra o erro com "tentar de novo", e a pessoa decide. */
const MAX_ANEXOS = 10;          // teto de arquivos por mensagem
const SUBIDAS_JUNTAS = 2;       // em paralelo, sem afogar o 4G do iPhone
let seqAnexo = 0;
let enviarQuandoSubir = false;  // Enter apertado com anexo ainda subindo

/* Sobe um anexo (ou tenta de novo). Resposta de tentativa velha, ou de anexo
   já removido, não mexe em nada. */
function subirAnexo(a) {
  const tentativa = ++a.tentativa;
  a.estado = 'subindo';
  a.pct = 0;
  a.erro = null;
  atualizaCartao(a);
  const fd = new FormData();
  fd.append('file', a.file, a.nome);
  fd.append('enviar', '0');
  fd.append('cliente_id', a.cid);
  const xhr = new XMLHttpRequest();
  a.xhr = xhr;
  xhr.open('POST', API + '/upload');
  xhr.timeout = 600000;
  const vale = () => anexos.includes(a) && a.tentativa === tentativa;
  xhr.upload.onprogress = ev => {
    if (!ev.lengthComputable || !vale()) return;
    // 100% do envio ainda não é "pronto": falta o servidor gravar (e transcrever áudio)
    const pct = Math.min(99, Math.round(100 * ev.loaded / ev.total));
    if (pct !== a.pct) { a.pct = pct; atualizaCartao(a); pintaInfoAnexos(); }
  };
  const acaba = () => { if (a.xhr === xhr) a.xhr = null; };
  const falha = motivo => {
    acaba();
    if (!vale()) return;
    falhaAnexo(a, motivo);
  };
  xhr.onload = () => {
    if (xhr.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(AQUI);
      return;
    }
    let d = null;
    try {
      d = JSON.parse(xhr.responseText);
    } catch (e) {
      console.warn('upload de anexo: resposta não é JSON (status ' + xhr.status + '):',
                   String(xhr.responseText).slice(0, 200));
    }
    if (xhr.status < 200 || xhr.status >= 300 || !d || d.ok === false || !d.anexo) {
      falha((d && d.erro) || ('o app respondeu ' + xhr.status));
      return;
    }
    acaba();
    if (!vale()) return;
    prontoAnexo(a, d);
  };
  xhr.onerror = () => falha('a rede caiu no meio do upload');
  xhr.ontimeout = () => falha('o app não respondeu em 10 min');
  xhr.onabort = () => acaba();
  xhr.send(fd);
}

function falhaAnexo(a, motivo) {
  a.estado = 'falhou';
  a.erro = motivo;
  a.pct = null;
  atualizaCartao(a);
  pintaInfoAnexos();
  const quem = '"' + a.nome + '"';
  if (enviarQuandoSubir) {
    enviarQuandoSubir = false;
    mostraErro('A mensagem NÃO saiu: o anexo ' + quem + ' não subiu (' + motivo +
               '). Toque em "tentar de novo" no cartão dele, ou tire ele no ✕, ' +
               'e envie de novo.');
    setEstado('anexo não subiu', true);
  } else {
    mostraErro('O anexo ' + quem + ' não subiu (' + motivo + '). Toque em ' +
               '"tentar de novo" no cartão dele ou tire ele no ✕.');
  }
  tocaSubidas();
}

function prontoAnexo(a, d) {
  if (d.media) midias[d.media.id] = d.media;
  a.estado = 'pronto';
  a.pct = null;
  a.id = d.anexo.id;
  a.path = d.anexo.path;
  atualizaCartao(a);
  pintaInfoAnexos();
  tocaSubidas();
  if (enviarQuandoSubir && anexos.every(x => x.estado === 'pronto')) despachaAnexos();
}

/* Põe pra subir os que estão na fila, até SUBIDAS_JUNTAS de cada vez. */
function tocaSubidas() {
  while (anexos.filter(a => a.estado === 'subindo').length < SUBIDAS_JUNTAS) {
    const prox = anexos.find(a => a.estado === 'espera');
    if (!prox) break;
    subirAnexo(prox);
  }
}

/* Enter com anexos. Tudo pronto: manda já. Algum falhou: não manda, explica.
   Algum ainda subindo: manda sozinho quando o último terminar. */
function enviarComAnexos() {
  const falhos = anexos.filter(a => a.estado === 'falhou');
  if (falhos.length) {
    mostraErro('A mensagem não saiu: ' + (falhos.length === 1
      ? 'o anexo "' + falhos[0].nome + '" não subiu'
      : falhos.length + ' anexos não subiram (' + falhos.map(a => a.nome).join(', ') + ')') +
      '. Toque em "tentar de novo" no cartão, ou tire no ✕, e envie de novo.');
    return;
  }
  if (anexos.every(a => a.estado === 'pronto')) { despachaAnexos(); return; }
  enviarQuandoSubir = true;
  mostraErro('');
  pintaInfoAnexos();
  setEstado('esperando os anexos subirem…');
}

/* Tudo subiu: o chip esvazia e vira um balão com o texto e as prévias. As URLs
   locais das prévias passam pro balão (ele é que as libera depois). */
function despachaAnexos() {
  enviarQuandoSubir = false;
  const lista = anexos.map(a => ({ id: a.id, kind: a.kind, nome: a.nome, path: a.path,
                                   bytes: a.bytes, previa: a.semPrevia ? null : a.url }));
  for (const a of anexos) if (a.semPrevia && a.url) URL.revokeObjectURL(a.url);
  anexos = [];
  pintaAnexos();
  const t = entrada.value.trim();
  entrada.value = '';
  ajustaCampo();
  vozNoCampo = false;
  enviarTexto(t, lista);
}

btnAnexo.onclick = () => {
  if (gravando) { cancelaGravacao(); return; }   // durante a gravação o 📎 vira ✕
  destravarAudio(); inputArquivo.click();
};
/* O 📎 também passa pelo chip: anexa, mostra a prévia, a legenda vai no campo
   e só o Enter (ou ➤) manda, tudo numa mensagem só. O input
   tem `multiple`: no iPhone dá pra marcar várias fotos de uma vez. */
inputArquivo.onchange = () => {
  const fs = Array.from(inputArquivo.files || []);
  inputArquivo.value = '';     // escolher o MESMO arquivo de novo tem que disparar
  anexaArquivos(fs);
};

/* ── Anexo pendente: colar (Ctrl+V) ou arrastar ───────────────────────────── */
/* Print colado ou arquivo solto na thread não vai na hora: vira um cartão no
   chip acima do campo (sobe em segundo plano), a pessoa escreve a legenda se
   quiser, e o Enter (ou ➤) manda tudo junto. */
const PLACEHOLDER_ORIGINAL = entrada.placeholder;
const raiz = document.documentElement;

/* O chip aumenta a barra de baixo, e as faixas de aviso (e o #chat fora do modo
   app) se posicionam por --barra-h: sem isto o chip ficaria por cima da faixa. */
function ajustaBarra() {
  // quem estava no fim da conversa continua no fim: a faixa de miniaturas tem
  // uns 150 px e, sem isto, empurrava a última mensagem pra baixo da barra
  const noFim = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  raiz.style.removeProperty('--barra-h');
  // o campo crescido (texto longo) também aumenta a barra
  const extra = (anexoChip.hidden ? 0 : anexoChip.offsetHeight + 6) +
                Math.max(0, entrada.offsetHeight - CAMPO_MIN);
  if (extra) {
    const base = parseFloat(getComputedStyle(raiz).getPropertyValue('--barra-h')) || 104;
    raiz.style.setProperty('--barra-h', Math.ceil(base + extra) + 'px');
  }
  if (noFim) chat.scrollTop = chat.scrollHeight;
}

/* O campo cresce de 1 até 4 linhas com o texto (colar um texto longo agora dá
   pra ver o que vai sair, pedido de 03/10/2026); dali pra frente rola por
   dentro. Chamado a cada digitação e sempre que o código muda o valor. */
const CAMPO_MIN = 46, CAMPO_LINHAS = 4;
function ajustaCampo() {
  const perto = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const antes = entrada.offsetHeight;
  entrada.style.height = CAMPO_MIN + 'px';
  const cs = getComputedStyle(entrada);
  const linha = parseFloat(cs.lineHeight) || 20;
  const max = Math.ceil(linha * CAMPO_LINHAS + parseFloat(cs.paddingTop) +
                        parseFloat(cs.paddingBottom) + 2);
  // vazio: 1 linha (o placeholder comprido no celular não conta)
  const quer = entrada.value ? entrada.scrollHeight + 2 : CAMPO_MIN;
  const h = Math.max(CAMPO_MIN, Math.min(quer, max));
  entrada.style.height = h + 'px';
  entrada.style.overflowY = quer > max ? 'auto' : 'hidden';
  const l1 = entrada.parentElement;
  if (l1) l1.classList.toggle('cresceu', h > CAMPO_MIN);
  if (h !== antes) {
    ajustaBarra();
    if (perto) chat.scrollTop = chat.scrollHeight;
    if (typeof posicionaSeta === 'function') posicionaSeta();
  }
}
entrada.addEventListener('input', ajustaCampo);

/* O cartão de cada anexo é montado uma vez (a miniatura não pisca a cada 1% de
   progresso); depois só o estado dele muda. */
function criaCartao(a) {
  const el = document.createElement('div');
  el.className = 'anx';
  el.setAttribute('role', 'listitem');
  el.dataset.anx = String(a.n);
  const rotulo = ROTULO_MIDIA[a.kind] || '📄 arquivo';
  let mid;
  if (a.url && a.kind === 'photo') {
    mid = `<img alt="${esc(a.nome)}" src="${a.url}">`;
  } else if (a.url && a.kind === 'video') {
    mid = `<video src="${a.url}" muted playsinline preload="metadata"></video>` +
          '<span class="anxplay" aria-hidden="true">▶</span>';
  } else {
    mid = `<span class="anxico">${esc(rotulo.split(' ')[0])}</span>`;
  }
  el.innerHTML =
    `<div class="anxmid">${mid}<span class="anxest"></span></div>` +
    `<div class="anxnome" title="${esc(a.nome)}">${esc(a.nome)}</div>` +
    `<div class="anxtam">${esc(tamanhoHumano(a.bytes))}</div>` +
    `<button class="anxde" type="button" hidden>tentar de novo</button>` +
    `<button class="anxx" type="button" aria-label="Tirar ${esc(a.nome)} da mensagem">✕</button>`;
  // imagem que o navegador não desenha (HEIC no Chrome): fica o ícone, o envio segue
  const img = el.querySelector('img');
  if (img) {
    img.onerror = () => {
      a.semPrevia = true;
      img.replaceWith(Object.assign(document.createElement('span'),
                                    { className: 'anxico', textContent: '📷' }));
    };
  }
  a.el = el;
  return el;
}

function atualizaCartao(a) {
  if (!a.el) return;
  const est = a.el.querySelector('.anxest');
  a.el.dataset.estado = a.estado;
  if (a.estado === 'subindo') a.el.style.setProperty('--pct', (a.pct || 0) + '%');
  est.textContent = a.estado === 'subindo' ? a.pct + '%'
    : a.estado === 'espera' ? 'na fila'
    : a.estado === 'falhou' ? '⚠ não subiu' : '✓';
  a.el.title = a.estado === 'falhou' ? a.nome + ': ' + a.erro : a.nome;
  a.el.querySelector('.anxde').hidden = a.estado !== 'falhou';
}

/* A linha embaixo das miniaturas: quantos, quanto falta e o que deu errado. */
function pintaInfoAnexos() {
  pintaInfoAnexosTexto();
  // o cartão que falhou ganha o botão "tentar de novo" e a linha pode quebrar:
  // a barra cresce, e as faixas de aviso sobem junto (senão cobrem o ✕)
  ajustaBarra();
}

function pintaInfoAnexosTexto() {
  if (!anexos.length) { anexoInfo.textContent = ''; anexoInfo.classList.remove('erro'); return; }
  const n = anexos.length;
  const falhos = anexos.filter(a => a.estado === 'falhou');
  const faltam = anexos.filter(a => a.estado === 'subindo' || a.estado === 'espera').length;
  let t = n === 1 ? '1 anexo' : n + ' anexos';
  if (falhos.length) {
    t += ' · ' + falhos.map(a => a.nome + ': ' + a.erro).join(' · ');
  } else if (faltam) {
    t += ' · ' + (n - faltam) + ' de ' + n + ' prontos, subindo o resto' +
         (enviarQuandoSubir ? ' (a mensagem sai sozinha quando terminar)' : '');
    // arquivo grande (em pedaços): quanto já foi, em MB, que 1% de 500 MB demora
    const gr = anexos.find(a => a.estado === 'subindo' && a.subidos != null);
    if (gr) t += ' · ' + gr.nome + ': ' + tamanhoHumano(gr.subidos) + ' de ' + tamanhoHumano(gr.bytes);
  } else {
    t += ' · prontos, Enter envia tudo junto';
  }
  if (n >= MAX_ANEXOS) t += ' (máximo de ' + MAX_ANEXOS + ')';
  anexoInfo.textContent = t;
  anexoInfo.classList.toggle('erro', falhos.length > 0);
}

/* Põe os cartões na ordem da fila e mostra ou esconde o chip. */
function pintaAnexos() {
  for (const el of Array.from(anexoLista.children)) {
    if (!anexos.some(a => a.el === el)) el.remove();
  }
  for (const a of anexos) {
    anexoLista.appendChild(a.el || criaCartao(a));   // appendChild reordena se já existe
    atualizaCartao(a);
  }
  anexoChip.hidden = !anexos.length;
  entrada.placeholder = anexos.length ? 'Legenda (opcional), Enter envia'
                                      : PLACEHOLDER_ORIGINAL;
  pintaInfoAnexos();
}

function tiraAnexo(a) {
  if (a.xhr) { try { a.xhr.abort(); } catch (e) { /* já acabou */ } }
  a.xhr = null;
  if (a.url) URL.revokeObjectURL(a.url);
  anexos = anexos.filter(x => x !== a);
  pintaAnexos();
  tocaSubidas();
  if (!anexos.length) {
    if (enviarQuandoSubir) { enviarQuandoSubir = false; estadoOcioso(); }
    mostraErro('');
  } else if (enviarQuandoSubir && anexos.every(x => x.estado === 'pronto')) {
    despachaAnexos();
  } else if (!anexos.some(x => x.estado === 'falhou')) {
    mostraErro('');
  }
}

/* Acrescenta (nunca substitui) os arquivos ao chip, na ordem em que vieram. */
function anexaArquivos(lista) {
  const fs = Array.from(lista || []).filter(Boolean);
  if (!fs.length) return;
  const recusados = [], deFora = [];
  for (const f of fs) {
    const nome = f.name || 'sem nome';
    if (f.size === 0) { recusados.push('"' + nome + '" tem 0 byte'); continue; }
    if (f.size > TETO_UPLOAD) {
      recusados.push('"' + nome + '" tem ' + tamanhoHumano(f.size) +
                     ' e o limite é 200 MB por arquivo');
      continue;
    }
    if (anexos.length >= MAX_ANEXOS) { deFora.push(nome); continue; }
    const kind = kindLocal(f);
    anexos.push({
      n: ++seqAnexo, file: f, kind: kind, nome: nome, bytes: f.size,
      url: (kind === 'photo' || kind === 'video') ? URL.createObjectURL(f) : null,
      estado: 'espera', pct: null, erro: null, id: null, path: null, xhr: null,
      tentativa: 0, el: null, semPrevia: false, cid: novoClienteId(),
    });
  }
  const avisos = [];
  if (recusados.length) avisos.push('Não anexei: ' + recusados.join('; ') + '.');
  if (deFora.length) {
    avisos.push('Cabem até ' + MAX_ANEXOS + ' anexos por mensagem e ' +
                (deFora.length === 1 ? 'ficou de fora "' + deFora[0] + '"'
                                     : 'ficaram de fora ' + deFora.length + ' (' +
                                       deFora.join(', ') + ')') +
                '. Envie esta e mande o resto na próxima.');
  }
  if (avisos.length) mostraErro(avisos.join(' '));
  pintaAnexos();
  tocaSubidas();
  entrada.focus();
}

anexoLista.addEventListener('click', ev => {
  const bt = ev.target.closest ? ev.target.closest('button') : null;
  const card = bt && bt.closest('.anx');
  if (!card) return;
  const a = anexos.find(x => String(x.n) === card.dataset.anx);
  if (!a) return;
  if (bt.classList.contains('anxx')) {
    tiraAnexo(a);
    entrada.focus();
  } else if (bt.classList.contains('anxde')) {
    mostraErro('');
    a.estado = 'espera';
    atualizaCartao(a);
    pintaInfoAnexos();
    tocaSubidas();
  }
});

/* Todos os arquivos do que foi colado: print, várias imagens copiadas de uma
   vez, ou arquivos copiados no Finder/Explorer. */
function arquivosColados(ev) {
  const dt = ev.clipboardData;
  if (!dt) return [];
  const doItens = [];
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) doItens.push(f);
    }
  }
  return doItens.length ? doItens : Array.from(dt.files || []);
}

/* O campo é um <textarea> comum: o evento paste nativo já entrega a imagem, sem
   precisar do navigator.clipboard.read(). O listener no document cobre o colar
   com o foco fora do campo. */
function aoColar(ev) {
  const fs = arquivosColados(ev);
  if (!fs.length) return;       // texto colado segue o caminho normal
  ev.preventDefault();
  ev.stopPropagation();
  anexaArquivos(fs);
}
entrada.addEventListener('paste', aoColar);
document.addEventListener('paste', ev => { if (ev.target !== entrada) aoColar(ev); });

const temArquivo = ev => ev.dataTransfer &&
  Array.from(ev.dataTransfer.types || []).includes('Files');
chat.addEventListener('dragover', ev => {
  if (!temArquivo(ev)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'copy';
});
chat.addEventListener('drop', ev => {
  if (!temArquivo(ev)) return;
  ev.preventDefault();
  const fs = Array.from((ev.dataTransfer.files) || []);
  if (fs.length) anexaArquivos(fs);
  else console.warn('drop na thread sem arquivo legível:', ev.dataTransfer.types);
});

/* ── Menu lateral (gaveta do ☰) ───────────────────────────────────────────── */
function abreMenu(abrir) {
  menu.classList.toggle('abre', abrir);
  overlayMenu.classList.toggle('abre', abrir);
}
$('btnMenu').onclick = () => { destravarAudio(); abreMenu(true); };
$('btnFechaMenu').onclick = () => abreMenu(false);
overlayMenu.onclick = () => abreMenu(false);
$('gmIrConversa').onclick = () => abreMenu(false);
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && menu.classList.contains('abre') && !document.getElementById('tourCaixa')) {
    abreMenu(false);
  }
});

/* Lista de agentes: Admin primeiro (com selo), avatar, nome e provedor/modelo.
   Trocar de agente navega para /a/<slug>. */
function textoProvedor(a) {
  const partes = [a.provedor, a.modelo].filter(Boolean);
  return partes.length ? partes.join(' · ') : (a.subtitulo || '');
}
function itemMenu(a) {
  const ativo = a.id === AGENTE.id;
  const av = a.avatar_img ? `<img src="${esc(a.avatar_img)}" alt="">`
    : (/^https:\/\//i.test(a.avatar || '') ? `<img src="${esc(a.avatar)}" alt="">`
       : esc(a.avatar || (a.nome || '?').slice(0, 1)));
  const selo = a.tipo === 'admin' ? '<span class="selo">admin</span>' : '';
  const prov = textoProvedor(a);
  return `<a class="item${ativo ? ' ativo' : ''}" href="/a/${encodeURIComponent(a.id)}"` +
    `${ativo ? ' aria-current="page"' : ''}>` +
    `<div class="av" style="background:${esc(a.cor || '#2f9e5e')}">${av}</div>` +
    `<div class="meio"><b>${esc(a.nome)}${selo}</b><small>${esc(prov)}</small>` +
    `${ativo ? '<span class="agora">conversa atual</span>' : ''}</div></a>`;
}
function pintaListaAgentes() {
  listaAgentes.innerHTML = agentesMenu.map(itemMenu).join('');
}
pintaListaAgentes();

/* Painel do agente: link na mesma janela, escondido no Admin (ele não tem painel). */
(function () {
  const sec = $('gmSecPainel');
  if (EH_ADMIN) { sec.hidden = true; return; }
  sec.hidden = false;
  $('gmPainelTit').textContent = 'Painel de ' + AGENTE.nome;
  $('gmPainelNome').textContent = 'Painel de ' + AGENTE.nome;
  const a = $('gmPainel');
  a.href = '/p/' + encodeURIComponent(AGENTE.id) + '/';
  a.title = 'Abrir o painel de ' + AGENTE.nome + ': status, memória e custos';
})();

/* O Safari só deixa tocar som num <audio> que já tocou dentro de um gesto do
   dedo. Então no PRIMEIRO toque da tela eu toco um mp3 em silêncio nesse mesmo
   elemento, e daí pra frente o play() assíncrono do TTS passa. Trocar de
   elemento quebra tudo, por isso o #player é um só pra toda a sessão. */
function destravarAudio() {
  if (audioDestravado) return;
  audioDestravado = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      ctxAudio = ctxAudio || new AC();
      if (ctxAudio.state === 'suspended') ctxAudio.resume();
    }
  } catch (e) {
    console.warn('AudioContext:', e.message);
  }
  try {
    player.src = SILENCIO;
    const p = player.play();
    if (p && p.catch) p.catch(e => console.warn('destrave:', e.message));
  } catch (e) {
    console.warn('destrave:', e.message);
  }
}
document.addEventListener('pointerdown', destravarAudio, { once: true, capture: true });
document.addEventListener('touchstart', destravarAudio, { once: true, capture: true });

/* ── Gravar e transcrever (só quando o servidor libera o microfone) ───────── */
function melhorMime() {
  if (!window.MediaRecorder) return null;
  const cands = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const c of cands) {
    if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function extensaoDe(mime) {
  if (!mime) return 'bin';
  if (mime.indexOf('mp4') >= 0) return 'm4a';
  if (mime.indexOf('webm') >= 0) return 'webm';
  if (mime.indexOf('ogg') >= 0) return 'ogg';
  if (mime.indexOf('wav') >= 0) return 'wav';
  return 'bin';
}

/* Parar a gravação ESCREVE a transcrição no campo pra revisar; a seta verde
   durante a gravação transcreve e manda direto. Na conversa contínua, parar já
   manda. */
let vozNoCampo = false;    // o texto do campo veio de uma transcrição
let micAbrindo = false;
let gravacao = null;       // { stream, rec, pedacos, mime, inicio, parado }
let pedindoMic = false;    // getUserMedia em voo: o segundo toque espera
let transcrevendo = false;
let timerGravando = null;

function tempoGravando() {
  const t0 = gravacao && gravacao.inicio;
  const s = t0 ? Math.max(0, Math.floor((Date.now() - t0) / 1000)) : 0;
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function pintaMic() {
  btnMic.classList.toggle('gravando', gravando);
  btnMic.textContent = gravando ? '■' : '🎤';
  btnMic.setAttribute('aria-label', gravando
    ? (continua ? 'Parar e enviar' : 'Parar e escrever no campo')
    : 'Gravar áudio');
  btnEnviar.classList.toggle('direto', gravando);
  btnEnviar.setAttribute('aria-label', gravando ? 'Parar e enviar direto' : 'Enviar');
  /* O estado vai dentro do campo (#micTxt) e o 📎 vira ✕ que cancela a gravação. */
  if (micAbrindo) micTxt.textContent = 'abrindo o microfone…';
  else if (gravando) micTxt.textContent = '● ' + tempoGravando();
  else micTxt.textContent = '';
  micTxt.classList.toggle('vivo', gravando && !micAbrindo);
  btnAnexo.classList.toggle('cancela', gravando);
  btnAnexo.textContent = gravando ? '✕' : '📎';
  btnAnexo.setAttribute('aria-label', gravando ? 'Cancelar a gravação'
    : 'Anexar fotos, vídeos, áudios ou PDFs');
  btnAnexo.title = gravando ? 'Cancelar a gravação (nada é enviado)'
    : 'Anexar fotos, vídeos, áudios ou PDFs (vários de uma vez)';
  clearInterval(timerGravando);
  timerGravando = gravando && !micAbrindo ? setInterval(pintaMic, 500) : null;
}

function soltaMicrofone(g) {
  try {
    if (g && g.stream) g.stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.warn('não consegui parar as trilhas do microfone:', e.message);
  }
  if (g) g.stream = null;
}

async function comecaGravar() {
  destravarAudio();
  if (!caps.microfone) return;
  if (gravando || pedindoMic || gravacao) return;
  const mime = melhorMime();
  if (mime === null) {
    mostraErro('Este navegador não grava áudio (sem MediaRecorder). ' +
               'No iPhone use o Safari, ou escreva no campo de texto.');
    return;
  }
  mostraErro('');
  setEstado('pedindo o microfone…');
  let stream;
  pedindoMic = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const nome = e && e.name;
    if (nome === 'NotAllowedError' || nome === 'SecurityError') {
      mostraErro('Microfone negado: libere o microfone para ' + location.host +
                 ' nas permissões do navegador e recarregue esta página.');
    } else if (nome === 'NotFoundError') {
      mostraErro('Nenhum microfone encontrado neste aparelho.');
    } else {
      mostraErro('Não consegui abrir o microfone (' + (nome || 'erro') + ': ' +
                 (e && e.message) + ').');
    }
    setEstado('erro no microfone', true);
    return;
  } finally {
    pedindoMic = false;
  }
  const g = { stream: stream, rec: null, pedacos: [], mime: mime, inicio: 0, parado: false,
              erro: null, blob: null, aoParar: null };
  let r;
  try {
    r = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    soltaMicrofone(g);
    mostraErro('Não consegui iniciar a gravação (' + e.message + ').');
    setEstado('erro no microfone', true);
    return;
  }
  g.rec = r;
  gravacao = g;
  // cada gravação enxerga só os pedaços dela (um pedaço atrasado da anterior
  // no começo da seguinte corrompe o arquivo)
  r.ondataavailable = ev => {
    if (!ev.data || !ev.data.size || g.parado) return;
    g.pedacos.push(ev.data);
  };
  r.onerror = ev => {
    g.erro = (ev.error && ev.error.name) || 'erro';
    mostraErro('A gravação falhou no meio (' + g.erro + '). O que já foi gravado vai ser enviado.');
    setEstado('erro na gravação', true);
  };
  r.onstop = () => {
    if (g.parado) return;
    g.parado = true;
    soltaMicrofone(g);
    g.blob = g.pedacos.length
      ? new Blob(g.pedacos, { type: (g.rec && g.rec.mimeType) || g.mime || 'audio/mp4' }) : null;
    if (g.aoParar) { g.aoParar(); return; }
    // Parou sem ninguém pedir (o aparelho tomou o microfone pra uma ligação):
    // o que foi gravado segue o caminho normal em vez de sumir.
    if (gravacao === g && gravando) paraEEnvia(false);
  };
  /* "Gravando" só aparece quando o gravador avisa que começou de verdade: antes
     o começo da frase se perdia no iPhone. */
  micAbrindo = true;
  gravando = true;
  pintaMic();
  setEstado('abrindo o microfone…');
  r.onstart = () => {
    g.inicio = Date.now();
    if (gravacao !== g) return;
    micAbrindo = false;
    pintaMic();
    setEstado('gravando…');
  };
  try {
    r.start(1000);
  } catch (e) {
    micAbrindo = false;
    gravando = false;
    gravacao = null;
    soltaMicrofone(g);
    pintaMic();
    mostraErro('Não consegui começar a gravar (' + e.message + ').');
    setEstado('erro no microfone', true);
  }
}

/* Termina a gravação e devolve o blob (ou null se não sobrou nada). */
function paraGravacao() {
  const g = gravacao;
  gravacao = null;
  if (!g) return Promise.resolve(null);
  return new Promise(resolve => {
    const fim = () => { soltaMicrofone(g); resolve(g.blob || null); };
    if (g.parado) { fim(); return; }
    g.aoParar = fim;
    try {
      if (g.rec.state !== 'inactive') g.rec.stop();
    } catch (e) {
      console.warn('stop() falhou:', e.message);
    }
    // o Safari às vezes não dispara o onstop: em 4 s fica com o que já chegou
    setTimeout(() => {
      if (g.parado) return;
      console.warn('o onstop não veio em 4 s; sigo com ' + g.pedacos.length + ' pedaços');
      g.parado = true;
      g.blob = g.pedacos.length ? new Blob(g.pedacos, { type: g.mime || 'audio/mp4' }) : null;
      fim();
    }, 4000);
  });
}

/* Para e transcreve. `direto`: manda na hora; senão o texto vai pro campo. */
async function paraEEnvia(direto) {
  micAbrindo = false;
  if (!gravando && !gravacao) return;   // dois toques no ■: o segundo não faz nada
  const blob = await paraGravacao();
  gravando = false;
  pintaMic();
  if (!blob || blob.size < 1024) {
    mostraErro('A gravação saiu vazia (' + (blob ? blob.size : 0) + ' bytes). ' +
               'Toque no microfone, espere aparecer "gravando", fale, e toque de novo.');
    estadoOcioso();
    return;
  }
  const item = { blob: blob, manda: direto || continua, clienteId: novoClienteId() };
  await transcreveEEntrega(item);
}

async function cancelaGravacao() {
  await paraGravacao();
  gravando = false;
  micAbrindo = false;
  pintaMic();
  estadoOcioso();
}

btnMic.onclick = () => {
  if (transcrevendo) return;
  if (gravando) paraEEnvia(false); else comecaGravar();
};

/* Uma ida ao /transcribe: multipart com o áudio (`audio`) e o `cliente_id`.
   Devolve o texto; erro leva a mensagem pronta pra tela. */
async function transcreveAudio(item) {
  const fd = new FormData();
  fd.append('audio', item.blob, 'fala.' + extensaoDe(item.blob.type));
  fd.append('cliente_id', item.clienteId);
  fd.append('agent_id', AGENTE.id);
  let r;
  try {
    r = await fetch('/api/v1/transcribe', { method: 'POST', body: fd });
  } catch (e) {
    throw new Error('a rede caiu antes da resposta (' + (e.message || 'sem rede') + ')');
  }
  if (r.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(AQUI);
    throw new Error('a sessão expirou');
  }
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  if (r.ok && d && d.ok !== false) return (d.text || '').trim();
  if (r.status === 413) throw new Error('o áudio passou do limite de tamanho (413)');
  throw new Error((d && d.erro) || ('a API respondeu ' + r.status + ' sem explicar o motivo'));
}

/* Transcreve e entrega o texto pelo caminho de sempre (campo ou envio direto). */
async function transcreveEEntrega(item) {
  if (transcrevendo) return;
  transcrevendo = true;
  mostraErro('');
  setEstado('transcrevendo…');
  micTxt.textContent = 'transcrevendo…';
  micTxt.classList.add('vivo');
  btnMic.disabled = true;
  let texto = '';
  try {
    texto = await transcreveAudio(item);
  } catch (e) {
    erroComTentarDeNovo('Não consegui transcrever: ' + e.message +
                        '. O áudio ficou guardado nesta tela até você sair dela.', item);
    setEstado('erro na transcrição', true);
    return;
  } finally {
    transcrevendo = false;
    btnMic.disabled = false;
    pintaMic();
  }
  await entregaTranscricao(texto, item.manda);
}

async function entregaTranscricao(texto, manda) {
  if (!texto) {
    mostraErro('A transcrição voltou vazia: não ouvi fala nenhuma nesse áudio. ' +
               'Fale mais perto do microfone.');
    estadoOcioso();
    return;
  }
  if (!manda) {
    // escreve no campo, somando ao que já estava lá; a pessoa revisa e manda
    const atual = entrada.value.trim();
    entrada.value = atual ? atual + ' ' + texto : texto;
    ajustaCampo();
    entrada.focus();
    try { entrada.setSelectionRange(entrada.value.length, entrada.value.length); }
    catch (e) { /* campo sem seleção (raro): segue */ }
    vozNoCampo = true;
    setEstado('transcrição no campo: revise e envie');
    return;
  }
  await enviarTexto(texto);
}

/* Botões dentro de uma faixa. A faixa() limpa os botões a cada texto novo,
   então um aviso que chega depois nunca herda o "Tentar de novo" de outro. */
function faixaComAcoes(el, txt, acoes) {
  faixa(el, txt);
  const caixa = document.createElement('span');
  caixa.className = 'acoes';
  for (const a of acoes) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.type = 'button';
    b.textContent = a.rotulo;
    if (a.id) b.id = a.id;
    b.onclick = ev => { ev.stopPropagation(); a.fn(b); };
    caixa.appendChild(b);
  }
  el.appendChild(caixa);
  respiroDasFaixas();
}

function erroComTentarDeNovo(msg, item) {
  faixaComAcoes(fErro, msg, [{
    rotulo: 'Tentar de novo', id: 'audioTentar',
    fn: () => { if (!transcrevendo && !gravando) transcreveEEntrega(item); },
  }]);
}

/* ── Mandar e esperar ─────────────────────────────────────────────────────── */
let seqPendente = 0;

/* Id do balão (ou do anexo) que o servidor usa pra não mandar duas vezes: o
   "reenviar" leva o MESMO id, e se a tentativa antiga ainda está no ar o
   servidor espera ela e devolve a mesma resposta (05/10/2026). */
function novoClienteId() {
  return 'tela-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
}

function novoPendente(texto) {
  const agora = new Date();
  return {
    n: ++seqPendente, texto: texto, estado: 'enviando', erro: null, cid: novoClienteId(),
    criadoEm: Date.now(), epLocal: Date.now() / 1000, tentativa: 0,
    hhmm: agora.toTimeString().slice(0, 5),
    dia: agora.toLocaleDateString('pt-BR'),
  };
}

/* Cada envio ganha um número: é assim que uma resposta atrasada sabe se ainda
   é a tentativa corrente. tentouEm mede os 90 s do segundo plano. */
function comecaTentativa(p) {
  p.tentativa += 1;
  p.estado = 'enviando';
  p.erro = null;
  p.tentouEm = Date.now();
  return p.tentativa;
}

function marcaFalhou(p, motivo, prefixo) {
  p.estado = 'falhou';
  p.erro = motivo;
  render();
  mostraErro((prefixo || 'Não consegui entregar a mensagem: ') + motivo +
             '. Toque em "reenviar" no balão.');
  setEstado('erro no envio', true);
  btnEnviar.disabled = false;
  btnAnexo.disabled = false;
}

function falhouTentativa(p, tentativa, prefixo, motivo) {
  if (pendentes.includes(p) && p.tentativa === tentativa && p.estado === 'enviando') {
    marcaFalhou(p, motivo, prefixo);
  } else {
    console.warn('envio antigo do pendente ' + p.n + ' falhou depois de substituído ' +
                 'ou descartado:', motivo);
  }
}

/* O servidor confirmou a entrega. Vale até pra resposta atrasada de um
   pendente já dado como 'falhou'. Devolve false se o balão foi descartado. */
function entregue(p, d) {
  if (!pendentes.includes(p)) {
    console.warn('pendente ' + p.n + ' foi descartado, mas o envio foi entregue');
    return false;
  }
  p.estado = 'enviada';
  p.erro = null;
  p.ep = d.ep_enviado;
  limpaPendentes();
  render();
  return true;
}

/* `anexosMsg`: arquivos que já subiram e vão juntos com o texto. */
async function enviarTexto(texto, anexosMsg) {
  texto = (texto || '').trim();
  const comAnexos = !!(anexosMsg && anexosMsg.length);
  if (!texto && !comAnexos) return;
  mostraErro('');
  const pend = novoPendente(texto);
  if (comAnexos) pend.anexos = anexosMsg;
  pendentes.push(pend);
  await mandaTexto(pend);
}

/* O relay do servidor desiste em 60 s; 75 s aqui cobre isso com folga.
   Devolve true se a mensagem foi entregue. `semEsperar`: não fica esperando
   a resposta depois do envio. */
async function mandaTexto(pend, semEsperar) {
  const tentativa = comecaTentativa(pend);
  render();
  setEstado('enviando…');
  btnEnviar.disabled = true;
  let d;
  // com anexos o servidor pode mandar mais de uma mensagem (marcador não se corta)
  const corpo = pend.anexos ? { text: pend.texto, anexos: pend.anexos.map(a => a.id) }
                            : { text: pend.texto };
  corpo.cliente_id = pend.cid;
  try {
    d = await api(API + '/send', { method: 'POST', body: corpo,
                                   timeoutMs: pend.anexos ? 120000 : 75000 });
  } catch (e) {
    falhouTentativa(pend, tentativa, 'Não consegui entregar a mensagem: ', e.message);
    return false;
  } finally {
    btnEnviar.disabled = false;
  }
  // o /send respondeu: a mensagem foi entregue, falta só a cópia na thread
  if (!entregue(pend, d)) return true;
  if (!semEsperar && !esperando) await esperaResposta(d.ep_enviado);
  return true;
}

/* Reenviar: antes confere a thread, porque o envio dado como perdido pode ter
   ido. Se a cópia está lá, o balão some e pronto; senão, manda de novo pelo
   mesmo caminho, no MESMO balão. */
async function reenviar(p) {
  if (p.estado !== 'falhou' || p.conferindo) return;
  p.conferindo = true;
  render();
  setEstado('conferindo se já foi…');
  await carregar(false);
  p.conferindo = false;
  limpaPendentes();
  render();
  if (!pendentes.includes(p)) { estadoOcioso(); return; }
  if (p.estado !== 'falhou') return;   // a resposta atrasada chegou enquanto eu conferia
  mostraErro('');
  // com anexos os arquivos já estão no servidor: reenviar não sobe nada de novo
  await mandaTexto(p);
}

/* As prévias locais (URL.createObjectURL) do balão otimista. */
function soltaPrevias(p) {
  for (const a of p.anexos || []) if (a.previa) URL.revokeObjectURL(a.previa);
}

function descartar(p) {
  pendentes = pendentes.filter(x => x !== p);
  soltaPrevias(p);
  mostraErro('');
  render();
  if (telaOciosa()) estadoOcioso();
}

wrap.addEventListener('click', ev => {
  const bt = ev.target.closest ? ev.target.closest('button[data-pend]') : null;
  if (!bt) return;
  const p = pendentes.find(x => String(x.n) === bt.getAttribute('data-pend'));
  if (!p) return;
  if (bt.classList.contains('reenviar')) reenviar(p);
  else if (bt.classList.contains('descartar')) descartar(p);
});

const LIMITE_ESPERA_MS = 180000;   // 3 minutos, com botão de parar

/* Espera a resposta pelo stream: um ouvinte de chegada olha a thread a cada
   integra(), e um relógio de 500 ms confere o limite e o "parar de esperar".
   Devolve true (chegou), false (desistiu) ou 'reserva' (o stream caiu de vez
   no meio da espera e o resto é com o /wait). */
function esperaPeloStream(temResposta, limite) {
  return new Promise(resolve => {
    let feito = false, relogio = null;
    const ouvinte = () => { if (temResposta()) acaba(true); };
    function acaba(v) {
      if (feito) return;
      feito = true;
      clearInterval(relogio);
      const i = ouvintesChegada.indexOf(ouvinte);
      if (i >= 0) ouvintesChegada.splice(i, 1);
      resolve(v);
    }
    ouvintesChegada.push(ouvinte);
    relogio = setInterval(() => {
      if (temResposta()) acaba(true);
      else if (pararPedido || Date.now() >= limite) acaba(false);
      else if (!streamAberto && fonte && fonte.readyState === EventSource.CLOSED) {
        acaba('reserva');
      }
    }, 500);
    ouvinte();    // a resposta pode ter chegado antes do /send responder
  });
}

/* Reserva: long-poll no /wait, só quando o stream não está no ar. O /wait
   devolve msgs também quando estoura o timeout, então sempre integra. */
async function esperaPeloWait(since, limite) {
  while (!pararPedido && Date.now() < limite) {
    let d;
    try {
      d = await api(API + '/wait?since=' + encodeURIComponent(since) + '&timeout=25');
    } catch (e) {
      mostraErro('Parei de esperar a resposta: ' + e.message);
      return false;
    }
    integra(d.msgs);
    if (!d.timeout) return true;
  }
  return false;
}

/* Resposta = qualquer fala nova do agente depois do envio. */
const ehResposta = (m, since) => ehAgente(m) && m.ep > since;

/* Depois da pergunta por voz, por 5 minutos, toda resposta nova dele também é
   lida (ele costuma mandar "vou fazer" e, um tempo depois, o resultado). */
const ESCUTA_MS = 5 * 60000;
let escuta = null;            // { since, ate }
const faladas = new Set();
let filaFala = Promise.resolve();

function falaNovas() {
  if (!escuta || !lerRespostas || Date.now() > escuta.ate) return;
  const novas = msgs.filter(m => ehResposta(m, escuta.since) && !faladas.has(m.id));
  if (!novas.length) return;
  for (const m of novas) faladas.add(m.id);
  filaFala = filaFala.then(async () => {
    if (gravando) return;
    await falar(novas.map(m => legendaUtil(m) || m.text).join('\n\n'));
  });
}
ouvintesChegada.push(() => { if (!esperando) falaNovas(); });

async function esperaResposta(since) {
  esperando = true;
  pararPedido = false;
  btnParar.style.display = '';
  btnParar.textContent = 'parar de esperar';
  setEstado('esperando a ' + AGENTE.nome + '…');
  const limite = Date.now() + LIMITE_ESPERA_MS;
  const temResposta = () => msgs.some(m => ehResposta(m, since));

  let chegou = streamAberto ? await esperaPeloStream(temResposta, limite) : 'reserva';
  if (chegou === 'reserva') {
    console.warn('esperaResposta: stream fora do ar, esperando pelo /wait');
    chegou = await esperaPeloWait(since, limite);
  }

  if (chegou && !pararPedido) {
    // ela costuma mandar 2 ou 3 balões seguidos: espera até 5 s sem balão
    // novo (no máximo 40 s) antes de começar a ler
    setEstado('recebendo…');
    const teto = Date.now() + 40000;
    let qtd = -1, quieto = Date.now();
    while (!pararPedido && Date.now() < teto) {
      const n = msgs.filter(m => ehResposta(m, since)).length;
      if (n !== qtd) { qtd = n; quieto = Date.now(); }
      if (Date.now() - quieto >= 5000) break;
      await dormir(500);
    }
  }

  esperando = false;
  btnParar.style.display = 'none';
  const respostas = msgs.filter(m => ehResposta(m, since));
  if (pararPedido) {
    setEstado('parei de esperar');
    mostraAviso('Parei de esperar. A mensagem foi entregue: a resposta aparece ' +
                'aqui sozinha quando ela mandar.');
  } else if (!respostas.length) {
    setEstado('sem resposta ainda');
    mostraAviso('A ' + AGENTE.nome + ' não respondeu em 3 minutos. A mensagem foi ' +
                'entregue: a resposta aparece aqui sozinha quando ela mandar.');
    if (lerRespostas) escuta = { since: since, ate: Date.now() + ESCUTA_MS };
  } else if (lerRespostas) {
    escuta = { since: since, ate: Date.now() + ESCUTA_MS };
    falaNovas();
    await filaFala;
  } else {
    estadoOcioso();
  }
}

btnParar.onclick = () => {
  pararPedido = true;
  if (falando) pararFala();
  btnParar.textContent = 'parando…';
};

/* ── Falar a resposta ─────────────────────────────────────────────────────── */
function pararFala() {
  try {
    player.pause();
  } catch (e) {
    console.warn('pararFala: player.pause() falhou:', e.message);
  }
  falando = false;
  btnParar.style.display = 'none';
  estadoOcioso();
}

async function falar(texto) {
  setEstado('preparando a voz…');
  let blob;
  try {
    const r = await fetch('/api/v1/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: AGENTE.id, text: texto }),
    });
    if (r.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(AQUI);
      return;
    }
    if (!r.ok) {
      let motivo = 'a API respondeu ' + r.status;
      try { const d = await r.json(); if (d && d.erro) motivo = d.erro; }
      catch (e) { console.warn('tts: a resposta de erro não veio em JSON:', e.message); }
      // a resposta JÁ está na tela: isto é aviso, não é falha do ciclo
      mostraAviso(motivo);
      setEstado('resposta só em texto');
      return;
    }
    if (r.headers.get('X-TTS-Cortado') === '1') {
      mostraAviso('A resposta é longa: a voz leu os primeiros 1200 caracteres. ' +
                  'O texto completo está na tela.');
    }
    blob = await r.blob();
  } catch (e) {
    mostraAviso('A resposta está na tela, mas não consegui gerar a voz: ' + e.message);
    setEstado('resposta só em texto');
    return;
  }

  falando = true;
  btnParar.style.display = '';
  btnParar.textContent = 'parar de falar';
  setEstado('falando…');
  const url = URL.createObjectURL(blob);
  await new Promise(resolve => {
    let pronto = false;
    const fim = () => {
      if (pronto) return;
      pronto = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    player.onended = fim;
    player.onerror = () => {
      mostraAviso('O iPhone não tocou o áudio da resposta. O texto está na tela.');
      fim();
    };
    player.src = url;
    const p = player.play();
    if (p && p.catch) {
      p.catch(e => {
        mostraAviso('O iPhone bloqueou o som (' + e.message + '). Toque no ' +
                    'microfone uma vez para liberar o áudio e tente de novo.');
        fim();
      });
    }
  });
  falando = false;
  btnParar.style.display = 'none';
  if (pararPedido) { estadoOcioso(); return; }
  estadoOcioso();
  if (continua) {
    mostraAviso('');
    await comecaGravar();
  }
}

/* ── Modo texto e toggles ─────────────────────────────────────────────────── */
function enviarDoCampo() {
  if (anexos.length) {
    // a legenda é o texto do campo: despachaAnexos lê e limpa o campo sozinho
    enviarComAnexos();
    return;
  }
  const t = entrada.value.trim();
  if (!t) { entrada.focus(); return; }
  entrada.value = '';
  ajustaCampo();
  vozNoCampo = false;
  enviarTexto(t);
}
btnEnviar.onclick = () => {
  destravarAudio();
  if (gravando) { paraEEnvia(true); return; }
  enviarDoCampo();
};
// Enter manda (é a tecla "enviar" do teclado do iPhone); Shift+Enter, no
// computador, quebra a linha. Durante a composição de acento não manda.
entrada.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  ev.preventDefault(); destravarAudio(); enviarDoCampo();
});

function pintaLer() {
  btnLer.classList.toggle('on', lerRespostas);
  btnLer.title = lerRespostas ? 'Ler respostas em voz alta: ligado'
                              : 'Ler respostas em voz alta: desligado';
  btnLer.setAttribute('aria-pressed', String(lerRespostas));
  btnLer.setAttribute('aria-label', 'Leitura em voz alta: ' + (lerRespostas ? 'ligada' : 'desligada'));
  btnLer.innerHTML = (lerRespostas ? '🔊' : '🔇') +
    ' <span class="lbl">' + (lerRespostas ? 'ler: sim' : 'ler: não') + '</span>';
}
btnLer.onclick = () => { destravarAudio(); lerRespostas = !lerRespostas; pintaLer(); };

function pintaContinua() {
  btnContinua.classList.toggle('on', continua);
  btnContinua.setAttribute('aria-pressed', String(continua));
  btnContinua.setAttribute('aria-label', 'Conversa contínua: ' + (continua ? 'ligada' : 'desligada'));
  btnContinua.innerHTML = '🔁 <span class="lbl">' + (continua ? 'contínua: sim' : 'contínua: não') + '</span>';
}
btnContinua.onclick = () => {
  destravarAudio();
  continua = !continua;
  if (continua && !lerRespostas) { lerRespostas = true; pintaLer(); }
  pintaContinua();
};

/* ── Cota da voz (custo é assunto sensível: avisa antes de falhar) ── */
async function conferecota() {
  try {
    const d = await api('/api/v1/tts/cota');
    if (d.pct == null) {
      if (d.aviso) console.warn('cota:', d.aviso);
      return;
    }
    if (d.pct >= (d.teto_pct || 97)) {
      mostraAviso('A cota de voz está no limite (' + d.usado + ' de ' + d.limite +
                  ' caracteres, ' + d.pct + '%). As respostas ficam só em texto ' +
                  'até o mês virar.');
    } else if (d.pct >= 90) {
      mostraAviso('A cota de voz está em ' + d.pct + '% (' + d.usado + ' de ' +
                  d.limite + ' caracteres). Perto do teto de ' +
                  (d.teto_pct || 97) + '%, quando a voz para sozinha.');
    }
  } catch (e) {
    console.warn('cota:', e.message);
  }
}

/* ── Seta pro fim ─────────────────────────────────────────────────────────
   Rolou mais de uma tela pra cima: aparece a seta; o toque leva ao fim NA HORA
   (nada de rolagem animada), e o número em cima dela é quantas respostas
   chegaram enquanto a pessoa lia lá em cima. */
function distanciaDoFim() { return chat.scrollHeight - chat.scrollTop - chat.clientHeight; }

/* Quanto do fundo da janela está ocupado: a barra de baixo e as faixas de
   aviso, que mudam de altura. A seta fica acima disso. */
function fundoLivre() {
  let fundo = window.innerHeight - chat.getBoundingClientRect().bottom;
  for (const f of [fErro, fAviso, document.getElementById('faixaAudio')]) {
    if (!f) continue;
    if (f.classList.contains('aparece')) {
      fundo = Math.max(fundo, window.innerHeight - f.getBoundingClientRect().top);
    }
  }
  return Math.max(fundo, 0);
}

function posicionaSeta() {
  if (!btnFim || btnFim.hidden) return;
  btnFim.style.bottom = Math.round(fundoLivre() + 12) + 'px';
}

function atualizaSeta() {
  const d = distanciaDoFim();
  if (d < 160) { novasAbaixo = 0; setaVisivel = false; }
  else if (d > chat.clientHeight || novasAbaixo > 0) setaVisivel = true;
  const apareceu = setaVisivel && btnFim.hidden;
  btnFim.hidden = !setaVisivel;
  const txt = novasAbaixo > 99 ? '99+' : String(novasAbaixo);
  if (fimNovas.textContent !== txt) fimNovas.textContent = txt;
  fimNovas.hidden = !novasAbaixo;
  const rot = novasAbaixo
    ? 'Ir para o fim: ' + novasAbaixo + (novasAbaixo === 1 ? ' resposta nova' : ' respostas novas')
    : 'Ir para a mensagem mais nova';
  if (btnFim.getAttribute('aria-label') !== rot) btnFim.setAttribute('aria-label', rot);
  if (apareceu) posicionaSeta();
}
btnFim.onclick = () => {
  novasAbaixo = 0;
  voltaAoFim();
};
chat.addEventListener('scroll', atualizaSeta, { passive: true });
window.addEventListener('resize', () => { atualizaSeta(); posicionaSeta(); });

/* ── Visita guiada (Tutorial) ─────────────────────────────────────────────
   O tour em si mora no tour.js (holofote, Anterior/Próximo/Fechar). Aqui ficam
   os passos desta tela: cada um responde o que é, como funciona e por que está
   ali, em linguagem de quem nunca viu o sistema. */

function passosTutorial() {
  const abreM = () => abreMenu(true), fechaM = () => abreMenu(false);
  const nome = AGENTE.nome;
  const passos = [
    { alvo: '#listaAgentes', antes: abreM, titulo: 'A lista de agentes',
      oque: 'Os agentes que trabalham para você. O Admin vem primeiro, com o selo "admin", e embaixo do nome de cada um aparece qual inteligência ele usa.',
      como: 'Toque num agente para abrir a conversa com ele. Cada agente tem a própria conversa e a própria memória.',
      porque: 'Assim você escolhe com quem falar sem sair desta tela. O Admin cuida da instalação e dos ajustes; os outros fazem o trabalho do dia a dia.' },
    { alvo: '#chat', antes: fechaM, titulo: 'A conversa',
      oque: 'Aqui aparece tudo o que você e ' + nome + ' já escreveram, na ordem, como num aplicativo de mensagens.',
      como: 'As respostas chegam sozinhas, sem precisar atualizar a página. Role para cima para ver as mensagens mais antigas; a seta no canto leva de volta para a mais nova.',
      porque: 'É o histórico do seu trabalho com o agente. Nada se perde quando você fecha a tela.' },
    { alvo: '.campo', titulo: 'O campo de mensagem',
      oque: 'O lugar onde você escreve para ' + nome + '.',
      como: 'Escreva e aperte Enter (ou a seta verde) para enviar. Para pular de linha no computador, use Shift+Enter.' +
        (EH_ADMIN ? ' Aqui no Admin, comandos que começam com / (como /compact e /clear) funcionam: o primeiro resume a conversa para liberar memória, o segundo começa do zero.' : ''),
      porque: 'Falar com o agente por texto é o jeito mais direto de pedir alguma coisa. Se o envio falhar, o balão fica marcado e você escolhe entre reenviar e descartar.' },
    { alvo: '#btnAnexo', titulo: 'Anexos',
      oque: 'O clipe serve para mandar fotos, vídeos, áudios e PDFs para o agente.',
      como: 'Toque nele e escolha os arquivos (até 10 por mensagem), ou cole uma imagem direto no campo. Cada arquivo sobe em segundo plano e a mensagem sai quando todos estiverem prontos.',
      porque: 'Muita coisa é mais fácil de mostrar do que de explicar: um print de erro, um documento, uma foto.' },
  ];
  if (caps.microfone) {
    passos.push({ alvo: '#btnMic', titulo: 'O microfone',
      oque: 'Em vez de escrever, você pode falar.',
      como: 'Toque uma vez para começar a gravar e outra para parar: o texto aparece no campo para você revisar antes de enviar. A seta verde durante a gravação transcreve e já envia.',
      porque: 'Quando você está com as mãos ocupadas ou no celular, falar é bem mais rápido do que digitar.' });
  }
  passos.push({ alvo: '#atividade', titulo: 'O indicador de atividade',
    antes: () => {
      demoAtividade = true;
      const el = $('atividade');
      el.hidden = false;
      el.className = '';
      el.querySelector('.atv-nome').textContent = nome + ' está trabalhando';
      el.querySelector('.atv-sep').hidden = false;
      el.querySelector('.atv-acao').textContent = 'lendo um arquivo (exemplo)';
    },
    depois: () => { demoAtividade = false; pintaAtividade(); },
    oque: 'Uma faixa que aparece sozinha quando o agente está trabalhando. O que você vê agora é só um exemplo.',
    como: 'Ela mostra o que ele está fazendo naquele momento. Fica amarela se ele estiver esperando uma autorização sua, e cinza se a conexão com ele cair ("sem sinal").',
    porque: 'Alguns pedidos demoram. Com a faixa você sabe que o agente não travou, e sabe quando precisa agir.' });
  passos.push({ alvo: '#btnMenu', antes: fechaM, titulo: 'O menu',
    oque: 'O botão ☰ abre a gaveta com a lista de agentes' + (EH_ADMIN ? '' : ', o painel do agente') + ' e o botão Sair.',
    como: 'Toque nele quando quiser trocar de agente ou sair. Toque fora da gaveta, ou no ✕, para fechar.',
    porque: 'Mantém a tela da conversa limpa: o que não é conversa fica guardado na gaveta.' });
  if (!EH_ADMIN) {
    passos.push({ alvo: '#gmSecPainel', antes: abreM, titulo: 'O painel de ' + nome,
      oque: 'Uma página à parte com o estado de ' + nome + ': como ele está, o que ele guarda na memória e quanto está gastando.',
      como: 'Toque em "Painel de ' + nome + '" e a página abre na mesma janela. Para voltar à conversa, use o voltar do navegador.',
      porque: 'A conversa serve para pedir coisas; o painel serve para acompanhar e ajustar o agente.' });
  }
  return passos;
}

function iniciaTutorial() {
  if (!window.DGTour) {
    mostraErro('A visita guiada não carregou. Recarregue a página e tente de novo.');
    return;
  }
  window.DGTour.inicia({ passos: passosTutorial(), aoFechar: () => abreMenu(false) });
}
$('btnTutorial').onclick = iniciaTutorial;
$('gmTutorial').onclick = iniciaTutorial;

/* ── Faixa de ferramentas: sombra só do lado que ainda tem ícone escondido ──
   A faixa (#tools) rola para o lado no celular; .tem-esq / .tem-dir no #ferr
   acendem a sombra da borda. */
(function () {
  const ferr = $('ferr'), tools = $('tools');
  if (!ferr || !tools) return;
  function confere() {
    const max = tools.scrollWidth - tools.clientWidth;
    ferr.classList.toggle('tem-esq', tools.scrollLeft > 2);
    ferr.classList.toggle('tem-dir', max > 2 && tools.scrollLeft < max - 2);
  }
  tools.addEventListener('scroll', confere, { passive: true });
  window.addEventListener('resize', confere);
  if (window.ResizeObserver) new ResizeObserver(confere).observe(tools);
  new MutationObserver(confere).observe(tools, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'style'] });
  confere();
})();

/* ── Partida ──────────────────────────────────────────────────────────────── */
pintaLer();
pintaContinua();
pintaMic();
estadoOcioso();
const emCache = leCache();
if (emCache) {
  msgs = emCache;
  carregouUmaVez = true;
  render();
  chat.scrollTop = chat.scrollHeight;
}
carregar(true).then(() => ligaStream());
ligaResync();
if (caps.voz) conferecota();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('sw:', e.message));
}
}   // fim de iniciaTela

boot();
