// ═══════════════════════════════════════════════
// DG ALIVE - Painel - Main Application
// ═══════════════════════════════════════════════

// BASE já existe neste escopo: api.js declara `const BASE` no topo e carrega ANTES
// deste arquivo (ver a ordem dos <script> no index.html). Scripts clássicos (sem
// type="module") compartilham o mesmo escopo léxico de topo, então reusar em vez de
// redeclarar; declarar de novo aqui daria "Identifier 'BASE' has already been declared".

// ─── Helpers ───────────────────────────────────

function makeBar(label, value, maxVal, colorClass, delta) {
  const pct = Math.round((value / maxVal) * 100);
  // Escala de 0 a 10 (personalidade, proatividade) mostra "7/10"; escrever "7%" ao lado
  // de uma barra 70% cheia fazia a tela se contradizer (vistoria de 08/10/2026).
  const emDez = maxVal > 1;
  const displayVal = emDez ? value : (typeof value === 'number' && value <= 1 ? Math.round(value * 100) : value);
  let deltaHtml = '';
  if (delta !== undefined && delta !== 0) {
    const absDelta = Math.abs(delta);
    const displayDelta = maxVal <= 1 ? Math.round(absDelta * 100) : absDelta;
    if (delta > 0) {
      deltaHtml = `<span class="delta-badge up">▲${displayDelta}</span>`;
    } else {
      deltaHtml = `<span class="delta-badge down">▼${displayDelta}</span>`;
    }
  }
  // Nome e numero na MESMA linha, barra embaixo: duas linhas por medida, nunca tres.
  return `<div class="rpg-bar">
    <div class="rpg-bar-label"><span>${label}</span><span class="rpg-bar-value">${displayVal}${emDez ? '/' + maxVal : '%'}${deltaHtml}</span></div>
    <div class="rpg-bar-track"><div class="rpg-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
  </div>`;
}

function formatDate(d) {
  if (!d) return '--';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return d; }
}

function formatAge(isoDate) {
  if (!isoDate) return '';
  const age = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(age / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min atrás`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `${days}d atrás`;
}

function ageColor(isoDate) {
  if (!isoDate) return 'var(--text-dim)';
  const hours = (Date.now() - new Date(isoDate).getTime()) / 3600000;
  if (hours < 1) return 'var(--green)';
  if (hours < 8) return 'var(--yellow)';
  return 'var(--red)';
}

function updatedTag(isoDate, label) {
  if (!isoDate) return '';
  const color = ageColor(isoDate);
  const text = formatAge(isoDate);
  const prefix = label ? `${label}: ` : '';
  const dica = `Quando ${label ? `o arquivo ${label}` : 'este arquivo'} foi alterado pela última vez. A cor vai do verde (mexeu há pouco) ao vermelho (faz muito tempo que ninguém mexe).`;
  return `<span class="updated-tag" style="color:${color}" title="${escapeHtml(dica)}">● ${prefix}${text}</span>`;
}

function encurtar(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

/**
 * Texto livre do agente (12/10/2026). O pensamento chegava como bloco cru, com ** e crases
 * à mostra. Estes três ajudantes passam tudo pelo renderizador único (js/markdown.js).
 * Sem ele carregado, cai no escape de sempre: nunca em innerHTML cru.
 */
function ricoBloco(txt, opts) {
  const D = window.DGMarkdown;
  return D && D.rico ? D.rico(txt, opts) : escapeHtml(txt == null ? '' : txt);
}
function ricoLinha(txt) {
  const D = window.DGMarkdown;
  return D && D.ricoLinha ? D.ricoLinha(txt) : escapeHtml(txt == null ? '' : txt);
}
/** Corta texto cru sem deixar marca aberta. Sem o renderizador, usa o corte antigo. */
function cortarTexto(txt, n) {
  const D = window.DGMarkdown;
  if (D && D.cortar) return D.cortar(txt, n);
  const t = String(txt == null ? '' : txt);
  return t.length > n ? { texto: t.slice(0, n) + '...', cortou: true } : { texto: t, cortou: false };
}
/** Linha rica já cortada: o corte é feito no texto cru, antes de virar HTML. */
function ricoLinhaCurta(txt, n) {
  return ricoLinha(cortarTexto(txt, n).texto);
}

// Os pensamentos cortados guardam aqui o texto inteiro, para o botão "ler inteiro".
const _pensamentosCheios = [];
function pensamentoRico(txt, limite) {
  const corte = cortarTexto(txt, limite);
  if (!corte.cortou) return ricoBloco(txt, { titulo: true });
  const D = window.DGMarkdown;
  let parcial = corte.texto;
  if (D && D.tituloCaixaAlta) {
    const { titulo, corpo } = D.tituloCaixaAlta(txt);
    if (titulo) parcial = `${titulo}. ${cortarTexto(corpo, Math.max(40, limite - titulo.length)).texto}`;
  }
  _pensamentosCheios.push(txt);
  const id = _pensamentosCheios.length - 1;
  return `<div data-pensamento="${id}">${ricoBloco(parcial, { titulo: true })}` +
    `<button type="button" class="rt-mais" data-pensamento-mais="${id}" ` +
    `title="Mostra o pensamento inteiro, do jeito que ele escreveu.">ler inteiro</button></div>`;
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest && ev.target.closest('[data-pensamento-mais]');
  if (!b) return;
  const id = Number(b.getAttribute('data-pensamento-mais'));
  const caixa = b.closest('[data-pensamento]');
  if (caixa && _pensamentosCheios[id] != null) caixa.innerHTML = ricoBloco(_pensamentosCheios[id], { titulo: true });
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Markdown para HTML: delega para o js/markdown.js, o renderizador ÚNICO do painel.
// Aqui havia uma versão de seis regex que achatava lista, tabela e código, e era ela
// que fazia o histórico da Personalidade e os arquivos da Identidade aparecerem
// tortos. Duas versões do mesmo renderizador é o começo de duas telas diferentes.
function mdToHtml(md) {
  if (!md) return '';
  return window.DGMarkdown ? window.DGMarkdown.md(md) : escapeHtml(md).replace(/\n/g, '<br>');
}

// Config carregada do backend no boot (/api/config). Default seguro até chegar.
let APP_CONFIG = {
  agentName: 'DG Claw', creatorName: 'Dono', avatar: BASE + '/assets/sprites/avatar.jpg',
  level: null, logs: [{ id: 'heartbeat', label: 'HEARTBEAT' }], moodSprites: null,
  tabPowers: { posts: 'instagram', followers: 'instagram', reunioes: 'meetings' },
};

// Mood→sprite default (genérico). config.moodSprites sobrescreve no boot.
const DEFAULT_MOOD_SPRITES = {
  // cobre os humores que o emotion-engine gera (pt-BR) + alguns extras
  neutra: 'default', tranquila: 'default', serena: 'default',
  otimista: 'happy', feliz: 'happy', confiante: 'happy', animada: 'excited', empolgada: 'excited',
  triste: 'sad', melancolica: 'sad',
  reflexiva: 'thinking', pensativa: 'thinking', curiosa: 'thinking', ansiosa: 'thinking', apreensiva: 'thinking',
  irritada: 'angry', frustrada: 'angry',
  cansada: 'tired', entediada: 'tired',
};
let MOOD_SPRITES = { ...DEFAULT_MOOD_SPRITES };

// Nome das oito emocoes e das cinco necessidades, em portugues por extenso. O painel
// antigo mostrava ANTCIP, SURPRS e DISGST: sigla cortada em ingles, que ninguem le.
const EMOCAO_LABELS = {
  joy: 'Alegria', trust: 'Confiança', anticipation: 'Expectativa', surprise: 'Surpresa',
  sadness: 'Tristeza', fear: 'Medo', anger: 'Raiva', disgust: 'Aversão',
};
const NECESSIDADE_LABELS = {
  connection: 'Conexão', validation: 'Reconhecimento', creativity: 'Criatividade',
  autonomy: 'Autonomia', growth: 'Crescimento',
};

// Nome dos acontecimentos que mexem com o humor. Tipo desconhecido aparece cru (com os
// underscores trocados por espaco): melhor mostrar o id de verdade do que inventar nome.
const EVENTO_LABELS = {
  post_success: 'post publicado', post_error: 'post falhou',
  comment_reply: 'respondeu comentário', comment_received: 'comentário recebido',
  comment_positive: 'comentário elogioso', comment_neutral: 'comentário neutro',
  comment_negative: 'comentário ruim',
  positive_feedback: 'elogio recebido', negative_feedback: 'cobrança recebida',
  new_follower: 'seguidor novo', goal_completed: 'meta concluída',
  interaction: 'interação', error: 'erro',
};

/**
 * O estado grava acontecimentos em lote: um item com timestamp e uma lista dentro. Abre
 * os lotes e joga fora os vazios, senao a tela mostra so uma fila de horarios sem nada
 * escrito ao lado, que foi o que aconteceu com um agente de meses de uso.
 */
function achatarEventos(lista) {
  const fora = [];
  for (const e of (lista || [])) {
    if (e && e.batch && Array.isArray(e.events)) {
      for (const dentro of e.events) {
        if (dentro && dentro.type) fora.push({ type: dentro.type, count: dentro.count, timestamp: e.timestamp });
      }
    } else if (e && e.type) {
      fora.push(e);
    }
  }
  return fora;
}

// Extensões instaladas no agente (vem do /api/config). Vazio = DG Claw puro, sem emoções.
let EXTENSIONS = [];

// Mapa de poderes (id→enabled). Default: só core; resto travado.
let POWERS_STATE = {};
const POWER_LABELS = { instagram: 'Instagram', meetings: 'Reuniões', crm: 'CRM', secretary: 'Secretaria' };

function moodSpriteFor(mood) {
  const key = MOOD_SPRITES[(mood || '').toLowerCase()];
  return key || 'default';
}

// Toast curto (aviso de poder travado). Sem libs.
function showToast(msg) {
  let el = document.getElementById('dg-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dg-toast';
    el.style.cssText = 'position:fixed;bottom:50px;left:50%;transform:translateX(-50%);' +
      'background:var(--bg-card,#222);color:var(--text,#eee);border:2px solid var(--border,#555);' +
      'padding:8px 14px;font-family:"Press Start 2P",monospace;font-size:8px;z-index:9999;' +
      'box-shadow:0 0 12px rgba(0,0,0,.6)';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 2500);
}

function getMoodColor(mood) {
  const m = (mood || '').toLowerCase();
  if (['triste', 'melancólica'].includes(m)) return 'sad';
  if (['irritada', 'frustrada'].includes(m)) return 'angry';
  if (['animada', 'empolgada', 'feliz'].includes(m)) return 'excited';
  return '';
}

// ─── Delta Tracking ───────────────────────────

let prevValues = {};

function loadPrevValues() {
  try {
    const stored = localStorage.getItem('isa_prev_values');
    if (stored) prevValues = JSON.parse(stored);
  } catch { prevValues = {}; }
}

function savePrevValues() {
  try { localStorage.setItem('isa_prev_values', JSON.stringify(prevValues)); } catch {}
}

function getDelta(key, newVal) {
  if (typeof newVal !== 'number') return undefined;
  const old = prevValues[key];
  if (old === undefined || old === newVal) return undefined;
  const delta = +(newVal - old).toFixed(4);
  return delta;
}

function setTracked(key, val) {
  if (typeof val === 'number') prevValues[key] = val;
}

loadPrevValues();

// ─── Tab Navigation ────────────────────────────

let currentTab = 'conversa';
const tabLoaded = {};

// Sob a plataforma (BASE = "/p/<slug>") a tela principal do agente é a conversa do chat
// (/a/<slug>) e este painel são as "páginas" dele. Painel solto tem BASE vazio: nada muda.
const NA_PLATAFORMA = !!BASE;
const SLUG_PLATAFORMA = (BASE.match(/^\/p\/([^/]+)/) || [])[1] || '';
const URL_CONVERSA = SLUG_PLATAFORMA ? `/a/${SLUG_PLATAFORMA}` : '/';
const ABAS_VALIDAS = [...document.querySelectorAll('.tab[data-tab]')].map((t) => t.dataset.tab);

// Abre a aba: marca o botão, mostra o painel, carrega. Usado pelo clique e pelo deep link.
function abrirAba(tab, botao) {
  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
  botao.classList.add('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${tab}`).classList.add('active');
  currentTab = tab;
  tituloDaAba(tab, botao);
  if (NA_PLATAFORMA && window.DGCasca) window.DGCasca.ativa(tab, (document.getElementById('titulo-aba') || {}).textContent || '');
  loadPanel(tab);
  // replaceState: trocar de aba não empilha histórico, e o link da barra fica compartilhável.
  if (NA_PLATAFORMA) history.replaceState(null, '', `#aba=${tab}`);
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const botao = e.target.closest ? e.target.closest('.tab') : e.target;
  if (!botao || !botao.classList.contains('tab')) return;
  const tab = botao.dataset.tab;
  if (!tab) return;

  // Aba travada (poder não instalado): bloqueia troca e avisa.
  if (botao.classList.contains('locked')) {
    const power = botao.dataset.power;
    const label = POWER_LABELS[power] || power;
    showToast(`Poder ${label} não instalado`);
    return;
  }

  // Sob a plataforma a conversa é a tela principal do chat, não uma aba daqui.
  if (NA_PLATAFORMA && tab === 'conversa') {
    location.href = URL_CONVERSA;
    return;
  }

  abrirAba(tab, botao);
});

// Aba pedida na URL (#aba=<chave>), só sob a plataforma. Sem hash: status.
function abaInicialDaPlataforma() {
  const m = location.hash.match(/^#aba=([^&]*)/);
  const pedida = m ? decodeURIComponent(m[1]) : '';
  if (pedida && pedida !== 'conversa' && ABAS_VALIDAS.includes(pedida)) return pedida;
  if (pedida) console.warn(`[painel] aba "${pedida}" pedida em #aba= não existe aqui (ou é a conversa, que fica no chat). Abrindo status. Abas válidas: ${ABAS_VALIDAS.join(', ')}.`);
  return 'status';
}

// ─── Casca da Conversa (cabeçalho e menu iguais aos da Conversa) ───────────────
// Sob a plataforma o menu lateral e o cabeçalho de cima são os da Conversa (web/public/casca.js, carregado
// pelo {{CASCA}} do index.html). O menu das abas do painel passa a ser o dela; estes botões ficam escondidos.

// Nome da aba como aparece no menu (sem o ícone colado no texto).
function rotuloDaAba(botao) {
  return [...botao.childNodes]
    .filter((n) => !(n.nodeType === 1 && n.classList && (n.classList.contains('ico') || n.classList.contains('lock'))))
    .map((n) => n.textContent).join('').trim();
}

// Abas que o menu da casca não conhece de fábrica: Sessões (só quando ligada) e as dos poderes (só quando instalados).
const ABAS_EXTRAS_CASCA = ['sessoes', 'posts', 'followers', 'reunioes'];
function sincronizaCasca() {
  if (!NA_PLATAFORMA || !window.DGCasca) return;
  const itens = [];
  for (const chave of ABAS_EXTRAS_CASCA) {
    const b = document.querySelector(`.tab[data-tab="${chave}"]`);
    if (!b || b.hidden || b.classList.contains('locked')) continue;
    const ico = b.querySelector('.ico');
    itens.push({ chave, ico: ico ? ico.textContent : '•', nome: rotuloDaAba(b) });
  }
  const assinatura = JSON.stringify(itens);
  if (sincronizaCasca._ultima === assinatura) return;
  sincronizaCasca._ultima = assinatura;
  window.DGCasca.extras(itens);
}

// O botão Tutorial do cabeçalho da casca abre o tutorial da aba; sem tutorial na aba, o do menu.
function tutorialDaCasca() {
  const btn = document.getElementById('btn-tutorial-aba');
  if (btn && !btn.hidden) btn.click();
  else if (window.DGCasca) window.DGCasca.tutorialMenu();
}

// Clicar num item do menu da casca estando já no painel só muda o #aba= (a página não recarrega).
window.addEventListener('hashchange', () => {
  if (!NA_PLATAFORMA) return;
  const m = location.hash.match(/^#aba=([^&]*)/);
  const pedida = m ? decodeURIComponent(m[1]) : '';
  if (!pedida || pedida === currentTab) return;
  const botao = document.querySelector(`.tab[data-tab="${pedida}"]`);
  if (!botao || pedida === 'conversa') {
    console.warn(`[painel] aba "${pedida}" pedida em #aba= não existe aqui. Abas válidas: ${ABAS_VALIDAS.join(', ')}.`);
    return;
  }
  if (botao.classList.contains('locked')) { showToast(`Poder ${POWER_LABELS[botao.dataset.power] || botao.dataset.power} não instalado`); return; }
  abrirAba(pedida, botao);
});

// Titulo e subtitulo da area principal: quem manda e a aba escolhida no menu.
const SUBTITULO_ABA = {
  conversa: 'fale com ele por aqui',
  status: 'como ele está agora',
  identity: 'quem ele é, em arquivos que você edita',
  personality: 'os nove números e o que ele pensa',
  memory: 'o que ficou, em texto que você pode ler',
  costs: 'quanto ele custou este mês',
  operations: 'está tudo funcionando? cada rotina do sistema',
  sessoes: 'os cards do Bunker: o que cada um faz agora',
  como: 'as peças dele, com os números de agora',
  apps: 'o que ele já produziu, etapa por etapa',
  skills: 'o que ele sabe fazer, e onde cada skill fica salva',
  rotinas: 'o que ele faz sozinho, na hora marcada',
  arquivos: 'os arquivos que ele guarda, e os que você sobe',
  cofre: 'as chaves de serviço que ele pode usar',
  posts: 'o que ele publicou',
  followers: 'quem conversa com ele',
  reunioes: 'o que foi dito e o que ficou',
};
/**
 * O BALÃO DE CADA ABA. Fonte única: aqui, e não espalhado no index.html.
 *
 * Das doze abas, só duas tinham `title` (Apps e Pasta, escritas quando essas
 * telas nasceram). As outras dez eram uma palavra e um símbolo, e a única forma
 * de descobrir o que "Operações" mostrava era clicar e adivinhar. O Danilo
 * abriu o painel e perguntou qual era a diferença entre Pulso e Operações: se
 * quem construiu o sistema precisa perguntar, o cliente não tem chance.
 *
 * O subtítulo (SUBTITULO_ABA) continua curto porque ele aparece SEMPRE, embaixo
 * do título; o balão pode ser mais longo porque só aparece se a pessoa procurar.
 * São dois textos com dois trabalhos, e não uma duplicação.
 */
const EXPLICACAO_ABA = {
  conversa: 'Onde você fala com ele e onde ele responde. Quando ele tem canal no Telegram, '
    + 'é a MESMA conversa: as duas caem na mesma sessão, em ordem.',
  status: 'A página inicial: os números do mês, se as operações do sistema estão funcionando, '
    + 'se a memória de trabalho está em dia, o que ele sabe agora sobre você (a memória dele, para ler '
    + 'e corrigir) e as rotinas que você pediu.',
  identity: 'Quem ele é, em arquivos de texto que você mesmo edita aqui: o nome, o papel e as '
    + 'regras que ele segue.',
  personality: 'Os nove números que regulam o jeito dele, mais as ideias e as metas que ele '
    + 'mesmo escreveu.',
  memory: 'Todos os arquivos de memória dele, em texto que você pode ler e corrigir à mão.',
  costs: 'Quanto ele custou este mês, separado por categoria e por rotina, contra o teto que '
    + 'você configurou.',
  operations: 'Cada rotina do sistema com a fileira das últimas execuções: verde deu certo, vermelho '
    + 'falhou, amarelo pede atenção. Na vista Registros ficam os logs e a sessão viva.',
  sessoes: 'Os cards do Bunker, que são as conversas de Claude trabalhando em pastas. Veja o que cada um '
    + 'está fazendo, leia a conversa, mande recado e crie sessões novas. Pedido de permissão só se decide no DG Telegram.',
  como: 'Como ele funciona por dentro: as camadas de memória, as rotinas e a sessão, explicadas, '
    + 'com os números de verdade deste agente ao lado.',
  apps: 'Os aplicativos que este agente opera sozinho, e o que ele já produziu em cada um, '
    + 'etapa por etapa.',
  skills: 'As skills são roteiros que ensinam o agente a fazer uma tarefa do seu jeito. Cada uma é uma pasta com um '
    + 'arquivo SKILL.md, e esta página lista todas e mostra onde cada uma fica salva.',
  rotinas: 'As rotinas e lembretes que ele marcou a seu pedido, com a próxima hora e como foi a última vez. '
    + 'A lista se atualiza sozinha enquanto a página está aberta.',
  arquivos: 'A pasta de trabalho do agente: o que ele guardou enquanto trabalhava, e onde você '
    + 'deixa um arquivo para ele usar.',
  cofre: 'As chaves de serviço que este agente pode usar (gerar imagem, transcrever áudio). '
    + 'A chave é gerada por você, no site do serviço, e o gasto é cobrado de você.',
  posts: 'O que ele publicou. Só faz sentido com o poder de Instagram ligado.',
  followers: 'Quem conversa com ele no Instagram.',
  reunioes: 'O que foi dito nas reuniões que ele acompanhou, e o que ficou de cada uma.',
};

/**
 * Põe o balão em cada aba. Chamada no boot E depois do initPowers, porque o
 * initPowers tira o `title` das abas cujo poder foi ligado (o cadeado some) e
 * sem esta segunda chamada a aba liberada ficaria justamente sem explicação.
 */
function aplicarTooltipsDasAbas() {
  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    // Aba travada tem texto próprio, dizendo o que falta instalar: esse é mais
    // útil ali do que a descrição do que ela mostraria.
    if (tab.classList.contains('locked')) return;
    const texto = EXPLICACAO_ABA[tab.dataset.tab];
    if (texto) tab.title = texto;
  });
}

/**
 * Uma aba que descobre depois do boot que o texto dela mudou (a Sessões, que só sabe se está
 * em modo local ou ligada ao DG Telegram depois de perguntar ao servidor) troca aqui o
 * subtítulo e o balão, sem tocar nas constantes acima.
 */
window.definirTextoDaAba = function definirTextoDaAba(tab, { subtitulo, explicacao }) {
  if (subtitulo) SUBTITULO_ABA[tab] = subtitulo;
  if (explicacao) EXPLICACAO_ABA[tab] = explicacao;
  aplicarTooltipsDasAbas();
  const ativa = document.querySelector('.tab.active');
  if (subtitulo && ativa && ativa.dataset.tab === tab) {
    const sub = document.getElementById('subtitulo-aba');
    if (sub) sub.textContent = subtitulo;
  }
};

/**
 * "vá em Operações" vira um link que LEVA até lá.
 *
 * Mandar a pessoa procurar uma aba pelo nome, num menu de doze itens, é metade
 * de uma explicação. O link clica no botão de verdade, então tudo o que já
 * acontece ao trocar de aba (carregar, trocar título, marcar como ativa)
 * continua acontecendo por um caminho só.
 */
function ligarLinksEntreAbas() {
  document.querySelectorAll('.link-aba[data-ir-para]').forEach((a) => {
    if (a._wired) return;
    a._wired = true;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const alvo = document.querySelector(`.tab[data-tab="${a.dataset.irPara}"]`);
      if (alvo) alvo.click();
    });
  });
}

function tituloDaAba(tab, botao) {
  const t = document.getElementById('titulo-aba');
  const sub = document.getElementById('subtitulo-aba');
  if (t && botao) {
    // O rotulo do botao vem com o icone colado no texto ("▨Apps"), porque o
    // <span class="ico"> entra no textContent. No titulo grande da pagina o
    // simbolo nao ajuda a ler e vira um retangulo estranho grudado na palavra.
    const semIcone = [...botao.childNodes]
      .filter((n) => !(n.nodeType === 1 && n.classList && n.classList.contains('ico')))
      .map((n) => n.textContent)
      .join('')
      .trim();
    t.textContent = semIcone || (botao.textContent || tab).trim();
  }
  if (sub) sub.textContent = SUBTITULO_ABA[tab] || '';
  atualizarBotaoTutorial(tab);
}

/**
 * O botão Tutorial do cabeçalho, que serve a TODAS as abas.
 *
 * Ele aparece só onde existe visita guiada, e some onde não existe. Botão que
 * está sempre lá e às vezes não faz nada ensina a pessoa a não clicar nele.
 *
 * A ligação é refeita a cada troca de aba porque o alvo do clique muda: em Apps,
 * Pasta e Cofre ele aciona o botão que aquelas telas desenham por dentro, e nas
 * outras ele abre a lista de passos de js/tutoriais.js. Quem sabe disso é o
 * `DGTutoriais.abrir`, e não este arquivo.
 *
 * O `_aba` guardado no elemento existe porque `addEventListener` empilha: sem
 * ele, trocar de aba dez vezes deixaria dez ouvintes no mesmo botão, e um clique
 * abriria o tutorial das dez abas por onde a pessoa passou.
 */
function atualizarBotaoTutorial(tab) {
  const btn = document.getElementById('btn-tutorial-aba');
  if (!btn || !window.DGTutoriais) return;

  // A aba pode ainda não ter desenhado o botão interno dela (Apps, Pasta e Cofre
  // só o criam depois de carregar). Por isso a pergunta é refeita um instante
  // depois, em vez de o botão sumir para sempre por ter chegado cedo demais.
  const decidir = () => { btn.hidden = !window.DGTutoriais.tem(tab); };
  decidir();
  setTimeout(decidir, 400);

  if (btn._aba === tab) return;
  btn._aba = tab;
  if (btn._ouvinte) btn.removeEventListener('click', btn._ouvinte);
  btn._ouvinte = () => window.DGTutoriais.abrir(tab);
  btn.addEventListener('click', btn._ouvinte);
}

/**
 * Os "?" de seção, que abrem o tutorial NO passo daquela seção.
 *
 * Eles moram no index.html com `data-tutorial="<chave>"`, e a chave casa com a
 * `chave` do passo em js/tutoriais.js. A ligação é feita aqui, uma vez por
 * elemento (`_wired`), pelo mesmo motivo do `_aba` acima.
 *
 * Por que um "?" por seção, e não só o tour da página inteira: quem tem dúvida
 * tem dúvida em UMA coisa, e obrigar a pessoa a passar por seis passos para
 * chegar no que ela quer é o jeito mais rápido de ela fechar o tutorial e
 * continuar sem entender.
 */
function ligarAjudasDeSecao() {
  if (window.DGTutoriais) window.DGTutoriais.pendurarAjudas();
}

/**
 * Copia o título de cada coluna para dentro das células, em `data-rot`.
 *
 * É o que permite a tabela virar CARTÃO no celular (ver `.pixel-table` no
 * main.css) sem que ninguém precise escrever o rótulo duas vezes. O rótulo sai
 * do `<th>` da própria tabela, então ele nunca discorda do cabeçalho: se alguém
 * renomear uma coluna, o cartão do celular acompanha sozinho.
 *
 * Roda depois de cada carga de aba porque as linhas são desenhadas por
 * JavaScript e não existem antes disso. Célula que já tem rótulo é pulada, então
 * chamar de novo não custa nada.
 */
function rotularTabelas() {
  document.querySelectorAll('.pixel-table').forEach((tabela) => {
    const titulos = [...tabela.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!titulos.length) return;
    tabela.querySelectorAll('tbody tr').forEach((linha) => {
      [...linha.children].forEach((celula, i) => {
        // Célula que ocupa a linha toda (mensagem de "nada por aqui") não tem coluna a rotular.
        if (celula.dataset.rot || celula.colSpan > 1) return;
        // Coluna sem título (a dos botões, por exemplo) fica sem rótulo mesmo:
        // um rótulo vazio desenharia uma linha em branco acima do botão.
        if (titulos[i]) celula.dataset.rot = titulos[i];
      });
    });
  });
}

// ─── Panel Loaders ─────────────────────────────

async function loadPanel(tab, force) {
  if (tabLoaded[tab] && !force) return;
  tabLoaded[tab] = true;

  switch (tab) {
    case 'conversa': await loadConversa(); break;
    case 'status': await loadStatus(); break;
    case 'posts': await loadPosts(); break;
    case 'followers': await loadFollowers(); break;
    case 'memory': await loadMemory(); break;
    case 'personality': await loadPersonality(); break;
    case 'operations': await loadOperations(); break;
    case 'sessoes': await window.DGSessoes.carregar(); break;
    case 'como': await window.DGCerebro.carregarComoFunciona(); ligarLinksEntreAbas(); break;
    case 'apps': await window.DGApps.carregar(); break;
    case 'skills': await window.DGSkills.carregar(); break;
    case 'rotinas': await carregarRotinas(); break;
    case 'arquivos': await window.DGArquivos.carregar(); break;
    // A aba Socorro (js/socorro.js, de outra frente) se carrega sozinha no clique da
    // aba dela. Chamar daqui também carregaria duas vezes.
    case 'cofre': await window.DGCofre.carregar(); break;
    case 'costs': await loadCosts(); break;
    case 'reunioes': await loadReunioes(); break;
    case 'identity': await loadIdentity(); break;
  }

  // Depois de carregar, e não antes: metade do conteúdo desta tela só existe
  // agora, e o "?" precisa de um título na página para se pendurar.
  ligarAjudasDeSecao();
  atualizarBotaoTutorial(tab);
  rotularTabelas();
}

// ─── CONVERSA Panel ──────────────────────────────
//
// A conversa vem inteira do servidor a cada leitura, e a tela só desenha o que
// chegou. Não há estado de conversa aqui dentro, de propósito: a fonte é o
// transcript da sessão, e uma cópia local seria uma segunda versão da conversa que
// um dia discorda da primeira.
//
// A MENSAGEM ENVIADA NÃO APARECE POR OTIMISMO. Depois do envio a tela busca a
// conversa de novo, e a bolha só nasce quando o servidor confirma que ela entrou na
// sessão. Uma bolha otimista mostraria como enviada uma mensagem que ficou pelo
// caminho, e a pessoa esperaria uma resposta que nunca viria.

let _conversaTimer = null;
// `null`, e NÃO `''`: uma conversa vazia também produz assinatura vazia, e com `''`
// aqui o "nada mudou" lá embaixo acertava logo no primeiro desenho. O resultado era
// a tela ficar em "carregando a conversa..." para sempre em todo agente que ainda
// não tinha uma primeira mensagem, que é justamente o primeiro minuto de todo mundo.
// Medido em 10/08/2026 no painel de um agente: a rota respondia em 48ms, com aviso e
// tudo, e a tela nunca o mostrava.
let _conversaAssinatura = null;
let _conversaEnviando = false;
// Enquanto acorda, a tela não devolve o botão nem por poll. O card leva alguns
// segundos passando por `spawning`, e nesse intervalo o estado ainda chega como
// caído: sem esta trava, o botão voltaria a aparecer habilitado e um segundo clique
// derrubaria a sessão que estava nascendo.
let _conversaAcordando = false;

// O diagnóstico mais recente do /api/saude e o último estado que a Conversa recebeu.
// O diagnóstico VENCE o estado antigo: com o login vencido o card do Bunker ainda diz
// "trabalhando" (a sessão existe, só não consegue falar com a Anthropic), e a linha do
// sinal contradizia a faixa vermelha logo acima dela. Vistoria de 08/10/2026.
let _diagSinal = null;
let _ultimoEstadoSinal = null;

const SINAL_ROTULO = {
  trabalhando: 'trabalhando',
  autorizacao: 'autorizacao',
  pronto: 'pronto',
  acordando: 'trabalhando',
  interrompido: 'pronto',
  fora: 'fora',
  viva: 'pronto',
};

async function loadConversa() {
  ligarConversa();
  await atualizarConversa();
  // Poll curto: a resposta do agente chega quando chega, e sem isto a pessoa
  // ficaria olhando uma tela parada sem saber se ele leu.
  if (_conversaTimer) clearInterval(_conversaTimer);
  _conversaTimer = setInterval(() => {
    if (currentTab === 'conversa' && !document.hidden) atualizarConversa();
  }, 3000);
}

function ligarConversa() {
  const form = document.getElementById('conversa-form');
  if (!form || form.dataset.ligado) return;
  form.dataset.ligado = '1';

  const campo = document.getElementById('conversa-texto');
  // A caixa cresce com o texto até um teto, em vez de rolar por dentro numa linha só.
  const ajustar = () => {
    campo.style.height = 'auto';
    campo.style.height = Math.min(campo.scrollHeight, 9 * 16) + 'px';
  };
  campo.addEventListener('input', ajustar);
  // Enter envia, Shift+Enter quebra linha. No celular o teclado manda quebra de
  // linha por conta própria, então lá o botão é o caminho.
  campo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await enviarDaConversa();
  });
  document.getElementById('btn-parar')?.addEventListener('click', pararConversa);
  document.getElementById('btn-reativar')?.addEventListener('click', reativarConversa);
  document.getElementById('btn-microfone')?.addEventListener('click', alternarDitado);
  document.getElementById('ditado-cancelar')?.addEventListener('click', () => pararDitado(true));
}

// ─── ditado por voz ──────────────────────────────────────────────
//
// Falar em vez de escrever. O navegador grava, o painel manda para a plataforma
// transcrever, e o texto cai NA CAIXA DE ESCREVER, nunca direto na conversa.
//
// Essa última parte é a decisão que importa. Transcrição erra nome próprio, erra
// número e às vezes corta a última palavra; mandar sozinha significaria a pessoa
// descobrir o erro pela resposta que o agente deu ao que ela não disse. Aqui ela
// lê, corrige o que quiser e aperta enviar, exatamente como quem digitou.

let _ditado = null; // { rec, pedacos, trilha, inicio, relogio, descartado }

function elDitado() {
  return {
    botao: document.getElementById('btn-microfone'),
    barra: document.getElementById('ditado-barra'),
    frase: document.getElementById('ditado-frase'),
    cancelar: document.getElementById('ditado-cancelar'),
  };
}

function alternarDitado() {
  if (_ditado) { pararDitado(false); return; }
  comecarDitado();
}

async function comecarDitado() {
  const { botao, barra, frase, cancelar } = elDitado();
  // getUserMedia só existe em contexto seguro. O painel é servido por HTTPS atrás da
  // plataforma, mas quem abrir por IP e porta crua não tem microfone nenhum, e a
  // frase precisa dizer isso em vez de "não foi possível gravar".
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    mostrarRecado({
      titulo: 'Este navegador não me deixa gravar áudio aqui.',
      texto: '',
      remedio: 'Abra o painel pelo endereço com https (o mesmo link de sempre) ou escreva a mensagem.',
    });
    return;
  }

  let trilha;
  try {
    trilha = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // Recusar o microfone é uma escolha legítima, e a tela não trata como erro do
    // sistema: diz o que aconteceu e lembra que dá para escrever.
    mostrarRecado({
      titulo: 'O navegador não liberou o microfone.',
      texto: '',
      remedio:
        'Autorize o microfone para este endereço nas permissões do navegador e toque de novo. ' +
        'Enquanto isso, dá para escrever normalmente.',
    });
    return;
  }

  const rec = new MediaRecorder(trilha);
  const pedacos = [];
  rec.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) pedacos.push(e.data); });
  rec.addEventListener('stop', () => enviarDitado());
  rec.start();

  _ditado = { rec, pedacos, trilha, inicio: Date.now(), relogio: null, descartado: false };
  _ditado.relogio = setInterval(() => {
    if (!_ditado) return;
    const s = Math.floor((Date.now() - _ditado.inicio) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    if (frase) frase.textContent = `gravando ${mm}:${ss} · toque no microfone para parar`;
  }, 250);

  mostrarRecado(null);
  if (botao) { botao.classList.add('gravando'); botao.title = 'parar de gravar'; }
  if (barra) { barra.hidden = false; barra.classList.remove('transcrevendo'); }
  if (cancelar) cancelar.hidden = false;
  if (frase) frase.textContent = 'gravando 00:00 · toque no microfone para parar';
}

/**
 * Para a gravação. `descartar` é o botão "descartar": nesse caso o áudio morre
 * aqui e nada é enviado para transcrever, que é o certo para quem se arrependeu no
 * meio da frase. Sem essa saída, arrepender-se custaria uma transcrição e um texto
 * errado na caixa para apagar à mão.
 */
function pararDitado(descartar) {
  if (!_ditado) return;
  _ditado.descartado = !!descartar;
  clearInterval(_ditado.relogio);
  try { _ditado.rec.stop(); } catch { /* já parado */ }
}

/** Solta o microfone. Sem isto a luzinha do navegador fica acesa depois de gravar. */
function soltarMicrofone(d) {
  try { d.trilha.getTracks().forEach((t) => t.stop()); } catch { /* já solto */ }
}

async function enviarDitado() {
  const d = _ditado;
  _ditado = null;
  if (!d) return;
  soltarMicrofone(d);

  const { botao, barra, frase, cancelar } = elDitado();
  if (botao) { botao.classList.remove('gravando'); botao.title = 'falar em vez de escrever'; }

  if (d.descartado) {
    if (barra) barra.hidden = true;
    return;
  }

  const blob = new Blob(d.pedacos, { type: d.rec.mimeType || 'audio/webm' });
  if (barra) { barra.hidden = false; barra.classList.add('transcrevendo'); }
  if (cancelar) cancelar.hidden = true;
  if (frase) frase.textContent = 'transcrevendo o que você falou...';
  if (botao) botao.disabled = true;

  const r = await API.chatTranscrever(blob);

  if (barra) { barra.hidden = true; barra.classList.remove('transcrevendo'); }
  if (cancelar) cancelar.hidden = false;
  if (botao) botao.disabled = false;

  if (!r || !r.ok || !r.corpo || !r.corpo.texto) {
    const corpo = (r && r.corpo) || {};
    mostrarRecado({
      titulo: corpo.error || 'Não consegui transcrever o seu áudio.',
      texto: '',
      remedio: corpo.howToFix || 'Tente gravar de novo, ou escreva a mensagem.',
    });
    return;
  }

  // Emenda no que já estava escrito em vez de substituir: quem escreveu meia frase e
  // resolveu ditar o resto não pode perder a metade que digitou.
  const campo = document.getElementById('conversa-texto');
  if (!campo) return;
  const antes = campo.value.trim();
  campo.value = antes ? `${antes} ${r.corpo.texto}` : r.corpo.texto;
  campo.dispatchEvent(new Event('input')); // faz a caixa crescer com o texto novo
  campo.focus();
  campo.setSelectionRange(campo.value.length, campo.value.length);
  mostrarRecado(null);
}

// Quantas leituras seguidas da conversa falharam. Com duas, o sinal deixa de dizer
// o último estado que conhecia ("trabalhando") e passa a dizer que não consegue ver:
// a tela congelada no último estado foi o que a vistoria de 01/10 achou.
let _conversaFalhas = 0;

async function atualizarConversa() {
  const dados = await API.chatMensagens(80);
  if (!dados) {
    _conversaFalhas++;
    if (_conversaFalhas >= 2) {
      const ponto = document.getElementById('sinal-ponto');
      const frase = document.getElementById('sinal-frase');
      if (ponto) ponto.className = 'sinal-ponto';
      if (frase) frase.textContent = 'Não estou conseguindo falar com o painel agora, então não sei como ele está. Tento de novo em instantes.';
      const parar = document.getElementById('btn-parar');
      if (parar) parar.hidden = true;
    }
    return;
  }
  _conversaFalhas = 0;

  desenharSinal(dados.estado);
  mostrarRecado(dados.erro ? { titulo: 'Não consegui ler a conversa', texto: dados.erro } : null);

  const lista = document.getElementById('conversa-lista');
  if (!lista) return;

  // Redesenha só quando algo mudou: repintar a cada 3s roubaria a seleção de texto
  // de quem está lendo uma mensagem comprida.
  // O aviso entra na assinatura: sem conversa nenhuma ele é a única coisa escrita na
  // tela, e se ele mudar (de "ainda não achei o diário" para "a sessão caiu") sem a
  // lista mudar, a pessoa continuaria lendo a frase velha.
  const assinatura = (dados.mensagens || []).map((m) => m.id).join('|') + '#' + (dados.aviso || '');
  if (assinatura === _conversaAssinatura) return;
  const estavaNoFim = perto_do_fim(lista);
  _conversaAssinatura = assinatura;

  if (!dados.mensagens || !dados.mensagens.length) {
    lista.innerHTML = `<div class="conversa-vazia">${escapeHtml(
      dados.aviso ||
      `Ainda não há conversa por aqui. Escreva a primeira mensagem para ${dados.agente || 'ele'} abaixo.`,
    )}</div>`;
    return;
  }

  lista.innerHTML = dados.mensagens.map(bolhaDaMensagem).join('');
  // Só desce sozinho quem já estava no fim. Puxar a tela de quem subiu para reler
  // uma coisa antiga é o jeito mais rápido de irritar alguém.
  if (estavaNoFim) lista.scrollTop = lista.scrollHeight;
}

function perto_do_fim(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

/**
 * DE ONDE VEIO CADA MENSAGEM (01/10/2026). A sessão principal é a do painel, e o
 * Telegram (e, no futuro, o WhatsApp) é um canal que fala com ELA. Por isso a
 * conversa é uma lista só, e cada balão que veio de fora do painel ganha uma
 * etiqueta com o nome do canal: na sua mensagem, por onde você mandou; na dele,
 * por onde ele respondeu. Balão do próprio painel não tem etiqueta: é o normal.
 *
 * O `via` vem do scripts/_lib/thread_log.py ("telegram" | "plataforma"). Um canal
 * novo entra em CANAIS abaixo com o nome e a cor; o comentário no thread_log.py diz
 * onde ele se pluga do lado de lá.
 */
const CANAIS = {
  telegram: { nome: 'Telegram', titulo: 'Esta mensagem passou pelo Telegram. É a mesma conversa: o Telegram fala com a mesma sessão do painel.' },
  whatsapp: { nome: 'WhatsApp', titulo: 'Esta mensagem passou pelo WhatsApp. É a mesma conversa: o WhatsApp fala com a mesma sessão do painel.' },
};

function bolhaDaMensagem(m) {
  const classes = ['bolha', m.de === 'voce' ? 'de-voce' : 'de-agente'];
  if (m.porContaPropria) classes.push('sozinho');
  const hora = horaCurta(m.em);
  const marcas = [];
  if (m.porContaPropria) marcas.push('ele falou por conta própria');
  const pe = [hora, ...marcas].filter(Boolean).join(' · ');
  const canal = CANAIS[m.via];
  const etiqueta = canal
    ? `<span class="bolha-canal canal-${escapeHtml(m.via)}" title="${escapeHtml(canal.titulo)}">${escapeHtml(canal.nome)}</span>`
    : '';
  const corpo =
    m.tipo === 'arquivo'
      ? `<span class="bolha-arquivo">📎 ${escapeHtml(m.texto || 'arquivo')}</span>`
      : ricoBloco(m.texto || '');
  return `<div class="${classes.join(' ')}">${etiqueta}${corpo}<span class="bolha-pe">${escapeHtml(pe)}</span></div>`;
}

/** O transcript grava em UTC; quem lê está no fuso da máquina. */
function horaCurta(ts) {
  if (!ts) return '';
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(ts) ? ts : ts + 'Z');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * O sinal de vida. `trabalhando` pode vir null, que quer dizer "não medido", e nesse
 * caso o ponto NÃO pulsa nem fica verde: dizer "pronto" sem ter medido é a mentira
 * que faz a pessoa mandar mensagem para um agente que não vai responder.
 */
function desenharSinal(estado) {
  if (!estado) return;
  _ultimoEstadoSinal = estado;
  // Diagnóstico "inativo" (login vencido, sessão muda...) vence o estado do card:
  // nada de "está trabalhando nisso agora" nem botão de parar com ele calado.
  if (_diagSinal && _diagSinal.estado === 'inativo' && estado.chave !== 'fora') {
    estado = {
      ...estado, chave: 'fora', trabalhando: false,
      frase: 'não está conseguindo responder agora. O aviso acima diz o que fazer.',
    };
  }
  const ponto = document.getElementById('sinal-ponto');
  const frase = document.getElementById('sinal-frase');
  const parar = document.getElementById('btn-parar');
  const reativar = document.getElementById('btn-reativar');
  const campo = document.getElementById('conversa-texto');
  const enviar = document.getElementById('btn-enviar');
  const nome = APP_CONFIG.agentName || 'Ele';

  if (ponto) ponto.className = 'sinal-ponto ' + (SINAL_ROTULO[estado.chave] || '');
  if (frase) frase.textContent = `${nome} ${estado.frase}`;
  // O botão de parar só existe enquanto há o que parar.
  if (parar) {
    parar.hidden = estado.trabalhando !== true;
    parar.disabled = false;
    parar.textContent = 'parar';
  }
  // O botão de acordar só existe com o terminal caído E com uma plataforma que
  // respondeu dizendo que dá para retomar. Enquanto ele está acordando, a tela
  // segura o botão: o card passa por `spawning`, e clicar de novo no meio disso
  // derrubaria a sessão que está justamente nascendo.
  if (reativar && !_conversaAcordando) {
    // Com a faixa do diagnóstico oferecendo "Reiniciar", o "acordar" sai da frente:
    // dois botões fazendo a mesma coisa na mesma tela fazem a pessoa clicar nos dois.
    reativar.hidden = estado.podeReativar !== true || _faixaTemAcao;
    reativar.disabled = false;
    reativar.textContent = `acordar ${nome}`;
  }
  const podeEscrever = estado.podeEscrever !== false;
  if (campo) {
    campo.disabled = !podeEscrever;
    campo.placeholder = podeEscrever
      ? 'Escreva aqui...'
      : estado.podeReativar === true
        ? `A conversa está guardada. Toque em "acordar ${nome}" para continuar de onde vocês pararam.`
        : 'A conversa está guardada, mas ele não consegue receber mensagem agora.';
  }
  if (enviar) enviar.disabled = !podeEscrever || _conversaEnviando;
}

function mostrarRecado(recado) {
  const caixa = document.getElementById('conversa-recado');
  if (!caixa) return;
  if (!recado) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  caixa.hidden = false;
  caixa.innerHTML =
    `<b>${escapeHtml(recado.titulo)}</b>${ricoLinha(recado.texto || '')}` +
    (recado.remedio ? `<div style="margin-top:6px">${ricoLinha(recado.remedio)}</div>` : '');
}

async function enviarDaConversa() {
  if (_conversaEnviando) return;
  const campo = document.getElementById('conversa-texto');
  const botao = document.getElementById('btn-enviar');
  const texto = (campo?.value || '').trim();
  if (!texto) return;

  _conversaEnviando = true;
  if (botao) { botao.disabled = true; botao.textContent = '…'; }
  const r = await API.chatEnviar(texto);
  _conversaEnviando = false;
  if (botao) { botao.disabled = false; botao.textContent = '↑'; }

  if (r && r.ok) {
    // Só limpa a caixa depois da confirmação. Se não saiu, o texto continua ali para
    // a pessoa tentar de novo sem ter que escrever tudo outra vez.
    campo.value = '';
    campo.style.height = 'auto';
    mostrarRecado(null);
    await atualizarConversa();
    return;
  }
  const corpo = (r && r.corpo) || {};
  mostrarRecado({
    titulo: corpo.error || 'A sua mensagem NÃO foi enviada.',
    texto: '',
    remedio: corpo.howToFix || 'Tente de novo em alguns segundos.',
  });
}

async function pararConversa() {
  const botao = document.getElementById('btn-parar');
  if (botao) { botao.disabled = true; botao.textContent = 'parando...'; }
  const r = await API.chatParar();
  if (!r || !r.ok) {
    const corpo = (r && r.corpo) || {};
    mostrarRecado({
      titulo: corpo.error || 'Não consegui interromper.',
      texto: '',
      remedio: corpo.howToFix || '',
    });
    if (botao) { botao.disabled = false; botao.textContent = 'parar'; }
    return;
  }
  mostrarRecado(null);
  await atualizarConversa();
}

/**
 * Acorda o terminal do agente e espera ele dar sinal de vida.
 *
 * NÃO diz "pronto" assim que o servidor responde: a chamada só pede a subida, e o
 * card ainda passa por `spawning` antes de existir de verdade. Anunciar sucesso ali
 * mandaria a pessoa escrever numa sessão que ainda não nasceu, e a mensagem se
 * perderia calada. Por isso a tela fica em "acordando..." até o próprio sinal de
 * vida virar, que é a mesma fonte que o resto desta aba usa.
 */
async function reativarConversa() {
  if (_conversaAcordando) return;
  const botao = document.getElementById('btn-reativar');
  _conversaAcordando = true;
  if (botao) { botao.disabled = true; botao.textContent = 'acordando...'; }
  mostrarRecado(null);

  const r = await API.chatReativar();
  if (!r || !r.ok) {
    const corpo = (r && r.corpo) || {};
    _conversaAcordando = false;
    if (botao) { botao.disabled = false; botao.textContent = `acordar ${APP_CONFIG.agentName || 'ele'}`; }
    mostrarRecado({
      titulo: corpo.error || 'Não consegui acordar o terminal.',
      texto: '',
      remedio: corpo.howToFix || corpo.detalhe || '',
    });
    return;
  }

  // Espera até 45s pelo sinal de vida, olhando de 2 em 2 segundos. O reanimador da
  // plataforma promete menos de 60s numa retomada boa, e aqui quem espera é uma
  // pessoa olhando a tela: passar disso sem dizer nada é pior que dizer que demorou.
  for (let i = 0; i < 22; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const dados = await API.chatMensagens(80);
    if (dados && dados.estado && dados.estado.viva) {
      _conversaAcordando = false;
      if (botao) botao.hidden = true;
      _conversaAssinatura = null; // a sessão pode ter mudado de arquivo: redesenha tudo
      await atualizarConversa();
      return;
    }
  }
  _conversaAcordando = false;
  if (botao) { botao.disabled = false; botao.textContent = `acordar ${APP_CONFIG.agentName || 'ele'}`; }
  mostrarRecado({
    titulo: 'Pedi para ele acordar, mas ele ainda não deu sinal de vida.',
    texto: '',
    remedio: 'A sua conversa continua guardada. Tente de novo, e se não voltar avise quem cuida do sistema.',
  });
}

// ─── REUNIOES Panel ──────────────────────────────

let _reunioesSearchTimer = null;
async function loadReunioes(query) {
  const listEl = document.getElementById('reunioes-list');
  const detailEl = document.getElementById('reunioes-detail');
  detailEl.style.display = 'none';
  listEl.style.display = 'block';
  listEl.innerHTML = 'Carregando...';

  const search = document.getElementById('reunioes-search');
  if (search && !search._wired) {
    search._wired = true;
    search.addEventListener('input', (e) => {
      clearTimeout(_reunioesSearchTimer);
      _reunioesSearchTimer = setTimeout(() => loadReunioes(e.target.value), 300);
    });
  }

  try {
    const url = BASE + '/api/reunioes' + (query ? `?q=${encodeURIComponent(query)}` : '');
    const res = await fetch(url, { credentials: 'include' });
    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-dim);padding:20px">Nenhuma reunião encontrada.</div>';
      return;
    }
    listEl.innerHTML = data.items.map((m) => {
      const dt = m.date ? new Date(m.date) : null;
      const dtStr = dt ? dt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : m.id;
      const dur = m.duration_min != null ? `${m.duration_min}min` : '?';
      const parts = (m.participants || []).join(', ') || 'sem participantes';
      const tldr = m.tldr ? m.tldr.slice(0, 200) + (m.tldr.length > 200 ? '...' : '') : '(sem resumo)';
      const cost = m.total_usd != null ? `$${m.total_usd.toFixed(3)}` : '--';
      return `
        <div class="reuniao-card" data-id="${m.id}">
          <div class="reuniao-head">
            <span class="reuniao-date">${dtStr}</span>
            <span class="reuniao-dur">${dur}</span>
            <span class="reuniao-mode">${m.mode || '?'}</span>
            <span class="reuniao-cost">${cost}</span>
          </div>
          <div class="reuniao-participants">👥 ${parts}</div>
          <div class="reuniao-tldr">${escapeHTML(tldr)}</div>
          <div class="reuniao-meta">
            ${m.decisoes_count} decisões · ${m.action_items_count} action items
          </div>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.reuniao-card').forEach((el) => {
      el.addEventListener('click', () => openReuniaoDetail(el.dataset.id));
    });
  } catch (e) {
    listEl.innerHTML = `<div style="color:#f88">Erro: ${e.message}</div>`;
  }
}

async function openReuniaoDetail(id) {
  const listEl = document.getElementById('reunioes-list');
  const detailEl = document.getElementById('reunioes-detail');
  listEl.style.display = 'none';
  detailEl.style.display = 'block';
  detailEl.innerHTML = 'Carregando...';

  try {
    const res = await fetch(`${BASE}/api/reunioes/${id}`, { credentials: 'include' });
    const m = await res.json();
    if (!res.ok) throw new Error(m.error || 'erro');
    const dt = m.date ? new Date(m.date) : null;
    const dtStr = dt ? dt.toLocaleString('pt-BR') : id;
    const dur = m.duration_min != null ? `${m.duration_min}min` : '?';

    // Cor por speaker (estável via hash simples)
    const colorFor = (name) => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
      const hue = (h * 47) % 360;
      return `hsl(${hue}, 70%, 65%)`;
    };

    // Renderizar blocos
    const transcriptHTML = (m.blocks || []).map((b) => {
      if (b.kind === 'audio') {
        return `<div class="tr-block tr-audio" style="border-left-color:${colorFor(b.speaker)}">
          <div class="tr-spk" style="color:${colorFor(b.speaker)}">${escapeHTML(b.speaker)} <span class="tr-ts">${b.start_ts}</span></div>
          <div class="tr-text">${escapeHTML(b.text)}</div>
        </div>`;
      }
      if (b.kind === 'agent-chat') {
        const agent = escapeHTML(APP_CONFIG.agentName || 'Agente');
        return `<div class="tr-block tr-agent-chat">
          <div class="tr-spk">💚 ${agent} (chat) <span class="tr-ts">${b.start_ts}</span></div>
          <div class="tr-text">${escapeHTML(b.text)}</div>
        </div>`;
      }
      if (b.kind === 'chat') {
        return `<div class="tr-block tr-chat">
          <div class="tr-spk">💬 ${escapeHTML(b.speaker)} <span class="tr-ts">${b.start_ts}</span></div>
          <div class="tr-text">${escapeHTML(b.text)}</div>
        </div>`;
      }
      if (b.kind === 'tool-result' || b.kind === 'tool-call') {
        return `<div class="tr-block tr-tool">
          <div class="tr-spk">⚙ ${b.kind} <span class="tr-ts">${b.start_ts}</span></div>
          <div class="tr-text">${escapeHTML(b.text)}</div>
        </div>`;
      }
      return '';
    }).join('');

    const s = m.summary || {};
    const decisoesHTML = (s.decisoes || []).map((d) => `<li>${escapeHTML(d)}</li>`).join('');
    const actionHTML = (s.action_items || []).map((a) =>
      `<li><strong>${escapeHTML(a.responsavel || '?')}</strong>: ${escapeHTML(a.acao || '')}${a.prazo ? ` <em>(${escapeHTML(a.prazo)})</em>` : ''}</li>`
    ).join('');
    const proxHTML = (s.proximos_passos || []).map((p) => `<li>${escapeHTML(p)}</li>`).join('');
    const campHTML = (s.campanhas || []).map((c) =>
      `<li><strong>${escapeHTML(c.nome || '?')}</strong> <span style="color:var(--text-dim)">[${c.status || '?'}]</span>: ${escapeHTML(c.detalhe || '')}</li>`
    ).join('');

    const costRows = Object.entries(m.cost?.by_provider || {})
      .sort((a, b) => b[1] - a[1])
      .map(([p, u]) => `<tr><td>${p}</td><td style="text-align:right">$${u.toFixed(4)}</td></tr>`).join('');

    detailEl.innerHTML = `
      <div class="reuniao-detail-head">
        <button class="back-btn" id="back-to-list">← voltar</button>
        <div>
          <div class="reuniao-title">${dtStr}</div>
          <div class="reuniao-sub">${dur} · modo: ${m.mode || '?'} · ${(m.participants || []).join(', ')}</div>
        </div>
      </div>

      <div class="reuniao-tabs">
        <button class="rt-tab active" data-rt="resumo">RESUMO</button>
        <button class="rt-tab" data-rt="transcript">TRANSCRIPT</button>
        <button class="rt-tab" data-rt="custos">CUSTOS</button>
        <button class="rt-tab" data-rt="audio">ÁUDIO</button>
      </div>

      <div class="rt-panel active" id="rt-resumo">
        ${s.tldr ? `<div class="rt-tldr">${escapeHTML(s.tldr)}</div>` : ''}
        ${decisoesHTML ? `<h4>📋 Decisões</h4><ul>${decisoesHTML}</ul>` : ''}
        ${actionHTML ? `<h4>✅ Action Items</h4><ul>${actionHTML}</ul>` : ''}
        ${proxHTML ? `<h4>🎯 Próximos Passos</h4><ul>${proxHTML}</ul>` : ''}
        ${campHTML ? `<h4>📣 Campanhas</h4><ul>${campHTML}</ul>` : ''}
      </div>

      <div class="rt-panel" id="rt-transcript">
        ${m.batch_text ? `
          <details open style="margin-bottom:14px">
            <summary style="font-size:11px;color:#7ee787;cursor:pointer">📜 Transcrição oficial Scribe batch (texto contínuo, mais fiel)</summary>
            <div class="rt-tldr" style="border-left-color:#7ee787;white-space:pre-wrap">${escapeHTML(m.batch_text)}</div>
          </details>` : ''}
        <div style="font-size:10px;color:var(--text-dim);margin-bottom:6px">Timeline diarizado (realtime + chat)</div>
        <div class="tr-container">${transcriptHTML || '(sem transcript)'}</div>
      </div>

      <div class="rt-panel" id="rt-custos">
        <div class="rt-total">Total: <strong>$${(m.cost?.total_usd || 0).toFixed(4)}</strong></div>
        <table class="rt-cost-table">
          <thead><tr><th>Provider</th><th style="text-align:right">USD</th></tr></thead>
          <tbody>${costRows || '<tr><td colspan="2">(sem custos registrados)</td></tr>'}</tbody>
        </table>
        <details><summary>Log completo (${(m.cost?.log || []).length} entradas)</summary>
          <pre style="font-size:10px;max-height:300px;overflow:auto">${escapeHTML(JSON.stringify(m.cost?.log || [], null, 2))}</pre>
        </details>
      </div>

      <div class="rt-panel" id="rt-audio">
        ${m.has_audio
          ? `<audio controls src="${BASE}/api/reunioes/${m.id}/audio.wav" style="width:100%"></audio>
             <div style="color:var(--text-dim);margin-top:8px">${(m.bytes_audio / 1024 / 1024).toFixed(1)} MB</div>`
          : '(sem audio.raw)'}
      </div>
    `;

    document.getElementById('back-to-list').addEventListener('click', () => loadReunioes(document.getElementById('reunioes-search')?.value));
    detailEl.querySelectorAll('.rt-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        detailEl.querySelectorAll('.rt-tab').forEach((t) => t.classList.remove('active'));
        detailEl.querySelectorAll('.rt-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('rt-' + tab.dataset.rt).classList.add('active');
      });
    });
  } catch (e) {
    detailEl.innerHTML = `<div style="color:#f88">Erro: ${e.message}</div>`;
  }
}

function escapeHTML(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── STATUS Panel ──────────────────────────────

async function loadStatus() {
  // A home responde "está tudo bem?" (reorganizada em 01/10/2026): os números de
  // cima, UMA linha sobre as operações do sistema, o raio-X da memória e as rotinas
  // que o DONO pediu. Cada pedaço cai sozinho se a rota falhar, sem derrubar o resto.
  const semErro = (p) => p.catch(() => null);
  const [custos, sessao, rotinasUsu, emotions, thoughts] = await Promise.all([
    semErro(API.costsOverview()),
    semErro(API.session()),
    semErro(API.rotinasUsuario()),
    // Emoções só existem com a extensão DG Alive: sem ela nem pergunto.
    aliveOn() ? semErro(API.emotions()) : Promise.resolve(null),
    semErro(API.thoughts()),
  ]);

  if (emotions) renderEmotions(emotions);
  if (thoughts) renderThoughts(thoughts);

  renderDestaqueHumor(emotions);
  renderDestaqueCusto(custos);
  renderDestaqueRotinas(rotinasUsu);
  renderDestaqueSessao(sessao);
  renderSuasRotinas(rotinasUsu);

  await Promise.all([
    window.DGOperacoes.linhaDaHome(document.getElementById('home-operacoes')),
    window.DGCerebro.carregarRaioX(document.getElementById('cerebro-grid')),
    window.DGWmStatus.carregar(document.getElementById('wm-status')),
    window.DGProvedor.carregar(),
  ]);
  ligarLinksEntreAbas();
  savePrevValues();
}

// ─── Faixa de cima: os quatro numeros ──────────────────────────

function destaque(id, num, pe, classeNum, classePe) {
  const n = document.getElementById('dest-' + id);
  const p = document.getElementById('dest-' + id + '-pe');
  if (n) { n.textContent = num; n.className = 'num' + (classeNum ? ' ' + classeNum : ''); }
  if (p) { p.textContent = pe; p.className = 'pe' + (classePe ? ' ' + classePe : ''); }
}

function renderDestaqueHumor(data) {
  // Sem o DG Alive o cartão de humor some inteiro (data-ext="alive"), e nada é escrito
  // nele: um "sem emoções" escondido viraria anúncio do que o dono não tem no dia em
  // que alguém mexer no CSS (Danilo, 05/10/2026: "parece que o agente é um Goku").
  if (!aliveOn()) return;
  if (!data || !data.mood || !data.mood.current) {
    return destaque('humor', '--', 'o agente ainda não registrou humor nenhum', 'apagado');
  }
  const energia = Math.round((data.mood.energy || 0) * 100);
  const alegria = Math.round((data.emotions?.joy || 0) * 100);
  destaque('humor', data.mood.current, `energia ${energia}% · alegria ${alegria}%`, 'palavra');
}

function renderDestaqueCusto(o) {
  if (!o || !o.month) {
    return destaque('custo', '--', 'sem registro de custo neste agente ainda', 'apagado');
  }
  const total = Number(o.month.total) || 0;
  const teto = Number(o.budget) || 0;
  const pct = teto ? Math.round((total / teto) * 100) : null;
  const pe = teto ? `de ${fmtUSD(teto)} de teto (${pct}%)` : `${o.month.executions || 0} execuções no mês`;
  destaque('custo', fmtUSD(total), pe, '', pct != null && pct >= 90 ? 'ruim' : '');
}

/**
 * "Suas rotinas": quantas rotinas o DONO pediu, e como foi a última.
 *
 * Era "Rotinas de hoje", que contava as execuções do dia pelo leitor de sessões
 * antigo (formato de outro produto, que no DG Claw não existe): ele dizia "nada
 * rodou" com o batimento rodando dezenas de vezes. E as rotinas do sistema não
 * são do dono: elas foram para a aba Operações. Aqui fica o que é dele.
 */
function renderDestaqueRotinas(r) {
  if (!r || !r.ok) {
    return destaque('rotinas', '--', 'não consegui ler as suas rotinas agora', 'apagado');
  }
  const lista = (r.corpo.rotinas || []);
  if (!lista.length) {
    return destaque('rotinas', 'nenhuma', 'peça a ele na Conversa, por exemplo: "todo sábado às 9h me manda o resumo"', 'apagado');
  }
  const falhas = lista.filter((x) => x.ultimoResultado === 'falha').length;
  const atencao = lista.filter((x) => x.ultimoResultado === 'atencao' || x.ativo === false).length;
  const proxima = lista.map((x) => x.proxima).filter(Boolean).sort()[0];
  let pe;
  let classe = '';
  if (falhas) { pe = `${falhas} com a última vez falhando`; classe = 'ruim'; }
  else if (atencao) { pe = `${atencao} pedindo atenção`; }
  else pe = proxima ? `a próxima é ${formatDate(proxima)}` : 'nenhuma com data à vista';
  destaque('rotinas', String(lista.length), pe, '', classe);
}

function renderDestaqueSessao(s) {
  if (!s || !s.updated) {
    return destaque('sessao', '--', 'nenhuma sessão viva registrada até agora', 'apagado');
  }
  const horas = (Date.now() - new Date(s.updated).getTime()) / 3600000;
  destaque('sessao', formatAge(s.updated), `sessão viva · ${formatDate(s.updated)}`, '',
    horas > 24 ? 'ruim' : (horas < 8 ? 'ok' : ''));
}

// ─── Suas rotinas (as que o dono pediu) ─────────────────────────────

const RESULTADO_ROTINA = {
  ok: { classe: 'status-ok', icone: '✓', texto: 'a última deu certo' },
  falha: { classe: 'status-err', icone: '✕', texto: 'a última falhou' },
  atencao: { classe: 'status-warn', icone: '!', texto: 'a última pede atenção' },
};

/**
 * O cartão "Suas rotinas". Só as rotinas que o agente marcou a pedido do dono
 * (os timers dgclaw-<slug>-self-*). Vazio é um CONVITE, não um "nada aqui": diz
 * como criar a primeira.
 */
// Editar uma rotina = pedir ao agente: ele mexe no agendador de verdade, e a tela não guarda
// cópia nenhuma que possa discordar do systemd. O link abre a conversa com o pedido pronto.
function linkEditarRotina(x) {
  const texto = `Quero mudar a rotina "${x.nome}" (${x.quando || 'sem horário'}): `;
  return `<div class="rotina-acoes"><a class="btn-editar-rotina" href="${URL_CONVERSA}?texto=${encodeURIComponent(texto)}"
    style="display:inline-flex;align-items:center;min-height:36px;padding:0 14px;margin-top:8px;border-radius:9px;border:1px solid var(--borda, #ddd);text-decoration:none;font-weight:600">editar</a></div>`;
}

function renderSuasRotinas(r, elId = 'home-rotinas', comDica = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!r || !r.ok) {
    const c = (r && r.corpo) || {};
    el.innerHTML = `<div class="vazio-util">Não consegui ler as suas rotinas: ${escapeHtml(c.error || 'sem resposta do painel')}. ${escapeHtml(c.howToFix || '')}</div>`;
    return;
  }
  const { rotinas = [], inconsistencias = [], erro, historico } = r.corpo;
  let html = '';
  if (erro) html += `<div class="vazio-util" style="margin-bottom:10px">Não consegui perguntar ao sistema: ${escapeHtml(erro)}</div>`;
  if (!rotinas.length && !erro) {
    html += '<div class="vazio-util convite">Você ainda não pediu nenhuma rotina. Peça a ele na Conversa, do jeito que '
      + 'pediria a uma pessoa: <b>"todo sábado às 9h me manda o resumo da semana"</b> ou <b>"de segunda a sexta, às 8h, '
      + 'me lembra das tarefas do dia"</b>. Ele marca de verdade nesta máquina e a rotina aparece aqui.</div>';
  }
  html += rotinas.map((x) => {
    const res = RESULTADO_ROTINA[x.ultimoResultado];
    const ultima = x.ultima ? `última: ${formatDate(x.ultima)}` : 'ainda não rodou';
    const proxima = x.ativo === false ? 'desligada: não vai rodar' : (x.proxima ? `próxima: ${formatDate(x.proxima)}` : 'sem próxima data');
    const resultado = res
      ? `<span class="${res.classe}" title="${escapeHtml([x.ultimoTitulo, x.ultimoDetalhe].filter(Boolean).join('\n'))}">${res.icone} ${res.texto}</span>`
      : `<span class="status-pending" title="${escapeHtml(historico && historico.motivo ? historico.motivo : 'Ela ainda não rodou nenhuma vez, ou o painel não conseguiu ler o histórico.')}">sem resultado ainda</span>`;
    return `<div class="rotina">
      <div class="rotina-topo">
        <span class="rotina-nome">${escapeHtml(x.nome)}</span>
        <span class="rotina-quando">${escapeHtml(x.quando || 'sem horário')}</span>
      </div>
      ${x.recado ? `<div class="rotina-recado" title="O recado que ele recebe quando a rotina dispara.">“${ricoLinhaCurta(x.recado, 180)}”</div>`
                 : (x.descricao ? `<div class="rotina-desc">${ricoLinhaCurta(x.descricao, 140)}</div>` : '')}
      <div class="rotina-pe">${resultado} · ${escapeHtml(ultima)} · ${escapeHtml(proxima)}</div>
      ${comDica && NA_PLATAFORMA ? linkEditarRotina(x) : ''}
    </div>`;
  }).join('');
  for (const i of inconsistencias) {
    html += `<div class="rotina alerta"><div class="rotina-topo">
      <span class="rotina-nome"><span class="status-err">!</span> ${escapeHtml(i.nome)}</span></div>
      <div class="rotina-pe">${ricoLinha(i.motivo)}</div></div>`;
  }
  // Na aba Rotinas ninguém edita aqui: mudar ou apagar é pedir ao agente, que mexe no agendador de verdade.
  if (comDica && rotinas.length) {
    html += NA_PLATAFORMA
      ? '<div class="vazio-util" style="margin-top:6px">"Editar" abre a conversa com o pedido já escrito: você completa o que quer mudar e ele ajusta a rotina de verdade.</div>'
      : '<div class="vazio-util" style="margin-top:6px">Para mudar ou apagar uma rotina, peça ao agente na conversa.</div>';
  }
  el.innerHTML = html;
}

// Aba Rotinas: reaproveita o desenho do Status e recarrega a cada 15 s enquanto está aberta e visível,
// para o que o agente acabou de criar aparecer quase na hora.
async function carregarRotinas() {
  renderSuasRotinas(await API.rotinasUsuario(true), 'rotinas-lista', true);
}
setInterval(() => {
  if (currentTab === 'rotinas' && !document.hidden) carregarRotinas();
}, 15000);

function renderEmotions(data) {
  const { emotions, mood, needs, recentEvents, lastUpdate, fileModified } = data;

  // Sem a extensão DG Alive não existe humor pra mostrar: o retrato fica parado, o
  // selo diz que a área está desligada e o resto do painel segue normal.
  if (!aliveOn()) {
    document.getElementById('sprite-img').src = APP_CONFIG.avatar || BASE + '/assets/sprites/default.gif';
    // O selo de humor tem data-ext="alive" e some inteiro sem a extensão: não há
    // mais o que escrever nele.
    const hm = document.getElementById('header-mood');
    if (hm) hm.textContent = '';
    return;
  }

  // Sprite & mood
  const moodText = mood.current || 'desconhecido';
  const spriteKey = moodSpriteFor(moodText);
  document.getElementById('sprite-img').src = `${BASE}/assets/sprites/${spriteKey}.gif`;
  const badge = document.getElementById('mood-badge');
  badge.textContent = moodText.toUpperCase();
  badge.className = 'mood-badge ' + getMoodColor(moodText);
  document.getElementById('last-update').textContent = `Atualizado: ${formatDate(lastUpdate)}`;

  // Header
  document.getElementById('header-mood').textContent = `Mood: ${moodText}`;

  // Footer
  document.getElementById('ft-joy').textContent = Math.round((emotions.joy || 0) * 100) + '%';
  document.getElementById('ft-energy').textContent = Math.round((mood.energy || 0) * 100) + '%';

  // Barras de emocao. Nome em portugues por extenso: o painel e pra ler, nao pra decifrar.
  const energyDelta = getDelta('mood.energy', mood.energy || 0);
  let barsHtml = `<div class="section-updated" style="grid-column:1/-1;margin:0 0 10px">${updatedTag(fileModified || lastUpdate, 'state.json')}</div>`;
  barsHtml += makeBar('Energia', mood.energy || 0, 1, 'joy', energyDelta);
  setTracked('mood.energy', mood.energy || 0);

  for (const [key, val] of Object.entries(emotions)) {
    const dKey = `emotions.${key}`;
    const delta = getDelta(dKey, val);
    // A classe de cor e a propria emocao: o CSS ja sabe pintar alegria, medo e raiva.
    barsHtml += makeBar(EMOCAO_LABELS[key] || key, val, 1, key, delta);
    setTracked(dKey, val);
  }
  document.getElementById('emotion-bars').innerHTML = barsHtml;

  // Necessidades
  let needsHtml = '';
  for (const [key, val] of Object.entries(needs || {})) {
    const dKey = `needs.${key}`;
    const delta = getDelta(dKey, val);
    needsHtml += makeBar(NECESSIDADE_LABELS[key] || key, val, 1, 'trust', delta);
    setTracked(dKey, val);
  }
  document.getElementById('needs-bars').innerHTML = needsHtml ||
    '<div class="vazio-util" style="grid-column:1/-1">Ele ainda não registrou necessidades.</div>';

  // Acontecimentos recentes
  const eventsHtml = achatarEventos(recentEvents).reverse().slice(0, 12).map(e => {
    const tipo = e.type || '';
    const icon = /positiv|success|elogio/.test(tipo) ? '<span class="status-ok">♥</span>' :
                 /negativ|error|fail|falh/.test(tipo) ? '<span class="status-err">✕</span>' :
                 '<span class="status-warn">★</span>';
    const vezes = e.count > 1 ? ` <span style="color:var(--fraco)">(${e.count}x)</span>` : '';
    return `<div>${icon} ${escapeHtml(EVENTO_LABELS[tipo] || tipo.replace(/_/g, ' '))}${vezes} ` +
      `<span style="color:var(--fraco)">${formatDate(e.timestamp)}</span></div>`;
  }).join('');
  document.getElementById('recent-events').innerHTML = eventsHtml ||
    '<div class="vazio-util">Nada aconteceu ainda hoje. Aqui entram elogios, cobranças e ' +
    'surpresas que mexeram com o humor dele.</div>';
}

/**
 * Um agente com meses de vida junta dezenas de pensamentos, e cada um e um paragrafo. Na
 * home isso vira uma coluna sem fim que empurra o resto pra baixo. Aqui a gente mostra os
 * primeiros, cortados no tamanho, e diz quantos ficaram de fora. Nada se perde: o arquivo
 * inteiro continua na aba de Memoria.
 */
function listaCurta(itens, quantos, tamanho, montar) {
  // tamanho null: quem monta decide o corte (os pensamentos cortam por markdown).
  let html = itens.slice(0, quantos).map((t) => montar(tamanho == null ? t : encurtar(t, tamanho))).join('');
  if (itens.length > quantos) {
    html += `<div class="vazio-util">+ ${itens.length - quantos} que não couberam aqui.</div>`;
  }
  return html;
}

/** O item pode vir como texto puro ou como objeto do arquivo de estado. */
function textoDoItem(t) {
  if (typeof t === 'string') return t;
  return t.thought || t.text || t.goal || JSON.stringify(t);
}

function renderThoughts(data) {
  const { thoughts, goals, thoughtsModified, goalsModified } = data;
  // A aba se redesenha sozinha de tempos em tempos: sem zerar, a lista dos textos
  // inteiros cresceria a cada volta. Os botões antigos somem junto com o HTML antigo.
  _pensamentosCheios.length = 0;

  // Present thoughts
  const thoughtsTag = updatedTag(thoughtsModified, 'thoughts');
  const presentHtml = listaCurta(
    (thoughts.present || []).map(textoDoItem), 3, null,
    (txt) => `<div class="thought-box">${pensamentoRico(txt, 300)}</div>`);
  document.getElementById('thoughts-present').innerHTML =
    `<div class="section-updated">${thoughtsTag}</div>` +
    (presentHtml || '<div class="vazio-util">Nenhum pensamento registrado. Ele escreve aqui o que ' +
      'passa pela cabeça entre uma tarefa e outra.</div>');

  // Lingering: quebra de linha visual entre items
  const lingerHtml = listaCurta(
    (thoughts.lingering || []).map(textoDoItem), 4, null,
    (txt) => `<div class="lingering-item">${pensamentoRico(txt, 220)}</div>`);
  document.getElementById('thoughts-lingering').innerHTML = lingerHtml ||
    '<div class="vazio-util">Nada ficou remoendo. Aqui voltam os assuntos que ele não conseguiu fechar.</div>';

  // Goals
  const goalsTag = updatedTag(goalsModified, 'goals');
  const metas = goals.shortTerm || [];
  let goalsHtml = metas.slice(0, 8).map((g) => {
    const feita = typeof g === 'object' && g && (g.progress || 0) >= 100;
    const icon = feita ? '<span class="check">☑</span>' : '<span class="uncheck">☐</span>';
    return `<div class="goal-item">${icon} ${ricoLinhaCurta(textoDoItem(g), 200)}</div>`;
  }).join('');
  if (metas.length > 8) goalsHtml += `<div class="vazio-util">+ ${metas.length - 8} que não couberam aqui.</div>`;
  document.getElementById('goals-short').innerHTML =
    `<div class="section-updated">${goalsTag}</div>` +
    (goalsHtml || '<div class="vazio-util">Sem metas de curto prazo. São os objetivos que ele mesmo ' +
      'se dá pra semana.</div>');
}

// ─── POSTS Panel ───────────────────────────────

async function loadPosts() {
  const [posts, stats] = await Promise.all([
    API.posts(30),
    API.postsStats(),
  ]);

  if (stats) {
    document.getElementById('posts-stats').innerHTML = `
      <div class="stat-block"><div class="stat-val">${stats.total}</div><div class="stat-label">TOTAL POSTS</div></div>
      <div class="stat-block"><div class="stat-val">${stats.today}</div><div class="stat-label">HOJE</div></div>
      <div class="stat-block"><div class="stat-val">${stats.streak}</div><div class="stat-label">STREAK (DIAS)</div></div>
    `;
    document.getElementById('ft-posts').textContent = stats.today + '/' + 3;
  }

  if (posts) renderPostsTable(posts.posts);

  // Date filter
  document.getElementById('posts-date').addEventListener('change', async (e) => {
    const date = e.target.value;
    if (date) {
      const data = await API.postsByDate(date);
      if (data) renderPostsTable(data.posts);
    }
  });
}

function renderPostsTable(posts) {
  const typeIcons = { foto: '📷', carrossel: '📚', reels: '🎬', video: '🎬', carousel: '📚' };
  const tbody = document.getElementById('posts-table');
  tbody.innerHTML = (posts || []).map(p => {
    const status = (p.status || '').toLowerCase();
    const ok = status.includes('publicado') || status.includes('ok') || status.includes('published');
    const icon = ok ? '<span class="status-ok">✓</span>' : '<span class="status-err">✕</span>';
    const type = (p.type || 'foto').toLowerCase();
    const typeIcon = typeIcons[type] || '📷';
    const link = p.postUrl ? `<a href="${escapeHtml(p.postUrl)}" target="_blank" style="color:var(--cyan);text-decoration:none">🔗</a>` : '--';
    return `<tr>
      <td>${icon}</td>
      <td>${escapeHtml(p.date || '')}</td>
      <td>${escapeHtml(p.time || '')}</td>
      <td>${escapeHtml(encurtar(p.theme || p.tema || '', 30))}</td>
      <td>${typeIcon} ${escapeHtml(type)}</td>
      <td>${link}</td>
    </tr>`;
  }).join('');
}

// ─── FOLLOWERS Panel ───────────────────────────

async function loadFollowers() {
  const [top, stats] = await Promise.all([
    API.followersTop(),
    API.followersStats(),
  ]);

  if (stats) {
    const { tiers, total } = stats;
    document.getElementById('followers-stats').innerHTML = `
      <div class="stat-block"><div class="stat-val">${total}</div><div class="stat-label">TOTAL</div></div>
      <div class="stat-block"><div class="stat-val">${tiers.close || 0}</div><div class="stat-label">❤️ CLOSE</div></div>
      <div class="stat-block"><div class="stat-val">${tiers.regular || 0}</div><div class="stat-label">⭐ REGULAR</div></div>
      <div class="stat-block"><div class="stat-val">${tiers.returning || 0}</div><div class="stat-label">⚔️ RETURNING</div></div>
      <div class="stat-block"><div class="stat-val">${tiers.newcomer || 0}</div><div class="stat-label">🛡️ NEWCOMER</div></div>
    `;
  }

  if (top) renderFollowers(top);
}

function renderFollowers(data) {
  const topFollowers = data.top_followers || [];
  const tierIcons = { close: '❤️', regular: '⭐', returning: '⚔️', newcomer: '🛡️', negative: '💀' };
  const grid = document.getElementById('followers-grid');

  // Also show the creator (owner) card
  let html = '';
  if (data.agent_owner) {
    const d = data.agent_owner;
    const creator = (APP_CONFIG.creatorName || 'Dono').toUpperCase();
    html += `<div class="follower-card" style="border-color:var(--green)">
      <div class="fc-name">👑 ${escapeHtml(creator)} (Criador)</div>
      <div class="fc-tier">Trust: ${d.trust_level || 95}%</div>
      <div class="fc-detail">${escapeHtml(d.dynamic || '')}</div>
    </div>`;
  }

  html += topFollowers.map(f => {
    const icon = tierIcons[f.tier] || '🛡️';
    const sentiment = (f.sentiment || '').toLowerCase();
    const sentColor = sentiment.includes('positiv') ? 'var(--green)' : sentiment.includes('negativ') ? 'var(--red)' : 'var(--yellow)';
    return `<div class="follower-card">
      <div class="fc-name">${icon} @${escapeHtml(f.username || f.handle || 'unknown')}</div>
      <div class="fc-tier">${escapeHtml(f.tier || 'newcomer')} | <span style="color:${sentColor}">${escapeHtml(f.sentiment || 'neutral')}</span></div>
      <div class="fc-detail">${escapeHtml(f.emotional_association || f.dynamic || '')}</div>
    </div>`;
  }).join('');

  grid.innerHTML = html || '<div style="color:var(--text-dim)">Nenhum follower documentado</div>';
}

// ─── MEMORY Panel ──────────────────────────────

async function loadMemory() {
  const data = await API.memory();
  const list = document.getElementById('memory-list');
  if (!data) {
    list.innerHTML = '<div class="vazio-util">Não consegui listar a memória dele agora. A faixa no topo da tela diz o motivo.</div>';
    return;
  }

  // Um item por arquivo, todos abrindo no MESMO leitor do raio-X (js/leitor.js).
  const item = (caminho, icone, nome, f, dica) => `<button type="button" class="memory-item" data-path="${escapeHtml(caminho)}" title="${escapeHtml(dica)}">
      <span class="mi-icon" aria-hidden="true">${icone}</span>
      <span class="mi-name">${escapeHtml(nome)}</span>
      <span class="mi-size">${(f.size / 1024).toFixed(1).replace('.', ',')} KB</span>
      <span class="mi-date">${formatDate(f.modified)}</span>
    </button>`;

  let html = '';
  if (data.main && data.main.modified) {
    html += item('MEMORY.md', '📜', 'MEMORY.md, a memória longa', data.main,
      'Os fatos que ficam: uma linha por coisa importante, com o link para o diário do dia. Clique para ler e editar.');
  }
  for (const f of data.files || []) {
    const isDate = /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name);
    const icon = isDate ? '📅' : (f.name.endsWith('.json') ? '💎' : '📖');
    const nome = isDate ? `${f.name.slice(8, 10)}/${f.name.slice(5, 7)}/${f.name.slice(0, 4)}, diário` : f.name;
    const dica = isDate ? 'O diário que a reflexão da noite escreveu sobre este dia.' : 'Um assunto que ele separou num arquivo próprio.';
    html += item(`memory/${f.name}`, icon, nome, f, dica);
  }
  list.innerHTML = html || '<div class="vazio-util">Ele ainda não escreveu memória nenhuma. Os arquivos aparecem aqui depois da primeira reflexão da noite.</div>';
  list.querySelectorAll('[data-path]').forEach((b) => {
    b.addEventListener('click', () => openMemoryFile(b.dataset.path));
  });
}

/** Abre um arquivo de memória no leitor/editor compartilhado. */
function openMemoryFile(filePath) {
  window.DGLeitor.abrir(filePath, { aoSalvar: () => { tabLoaded.memory = false; if (currentTab === 'memory') loadMemory(); } });
}
window.openMemoryFile = openMemoryFile;

function closeModal() {
  document.getElementById('modal').classList.remove('active');
}

// Close modal on overlay click
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ─── PERSONALITY Panel ─────────────────────────

async function loadPersonality() {
  const [data, changelog] = await Promise.all([
    API.personality(),
    API.personalityChangelog(),
  ]);
  if (changelog) {
    const el = document.getElementById('personality-changelog');
    // Era uma caixa de log (letra de código, quebra de linha literal). Agora é texto
    // renderizado, com a tipografia de leitura do resto do painel.
    el.className = 'md-leitura compacto historico-rolagem';
    el.innerHTML = mdToHtml(changelog.content || 'Nenhuma mudança registrada ainda.');
  }
  if (!data) return;

  // Big Five with deltas
  const bigFiveLabels = {
    'extroversão': { label: 'Extroversão', color: 'joy' },
    'extroversao': { label: 'Extroversão', color: 'joy' },
    'abertura': { label: 'Abertura', color: 'trust' },
    'conscienciosidade': { label: 'Conscienciosidade', color: 'trust' },
    'amabilidade': { label: 'Amabilidade', color: 'joy' },
    'neuroticismo': { label: 'Neuroticismo', color: 'anger' },
  };
  const bigFiveKeys = new Set(['extroversão', 'extroversao', 'abertura', 'conscienciosidade', 'amabilidade', 'neuroticismo']);

  let bigFiveHtml = `<div class="section-updated" style="grid-column:1/-1">${updatedTag(data.personalityModified, 'PERSONALITY.md')}</div>`;
  for (const [key, val] of Object.entries(data.bigFive || {})) {
    if (!bigFiveKeys.has(key.toLowerCase())) continue;
    const info = bigFiveLabels[key.toLowerCase()] || { label: key, color: 'trust' };
    const dKey = `bigfive.${key}`;
    const delta = getDelta(dKey, val);
    bigFiveHtml += `<div>${makeBar(info.label, val, 10, info.color, delta)}</div>`;
    setTracked(dKey, val);
  }
  document.getElementById('big-five').innerHTML = bigFiveHtml || '<span style="color:var(--text-dim)">Dados nao encontrados</span>';

  // Proactivity with deltas
  const proLabels = { initiative: 'Iniciativa', humor: 'Humor', curiosity: 'Curiosidade', stubbornness: 'Teimosia' };
  const proColors = { initiative: 'trust', humor: 'joy', curiosity: 'trust', stubbornness: 'anger' };
  let proHtml = `<div class="section-updated">${updatedTag(data.proactivityModified, 'proactivity.json')}</div>`;
  for (const [key, val] of Object.entries(data.proactivity || {})) {
    const dKey = `proactivity.${key}`;
    const delta = getDelta(dKey, val);
    proHtml += makeBar(proLabels[key] || key, val, 10, proColors[key] || 'trust', delta);
    setTracked(dKey, val);
  }
  document.getElementById('proactivity-bars').innerHTML = proHtml;

  // Opinions
  const opinions = Array.isArray(data.opinions) ? data.opinions : Object.values(data.opinions || {});
  let opHtml = `<div class="section-updated">${updatedTag(data.opinionsModified, 'opinions.json')}</div>`;
  for (const op of opinions) {
    const intensity = op.intensity || 0;
    opHtml += `<div class="opinion-card">
      <div class="op-topic">${escapeHtml(op.topic || op.name || 'Sem titulo')}</div>
      <div class="op-position">${ricoLinha(op.position || op.stance || '')}</div>
      ${makeBar('Intensidade', intensity, 10, 'joy')}
      <div style="font-size:12px;color:var(--fraco);margin-top:4px">Em público: ${escapeHtml(op.public_stance || '--')}</div>
    </div>`;
  }
  document.getElementById('opinions-list').innerHTML = opHtml || '<span style="color:var(--text-dim)">Nenhuma opiniao registrada</span>';

  savePrevValues();
}

// ─── OPERATIONS Panel ──────────────────────────
//
// A aba inteira é desenhada por js/operacoes.js (Situação, com os quadradinhos). O
// que mora aqui é só a vista Registros: a sessão viva e o leitor de log, que só
// carregam quando alguém abre essa vista.
//
// O "Rotinas de hoje" e a "Agenda" saíram desta aba em 01/10/2026: o primeiro lia
// o diário de sessões no formato de outro produto e dizia "nada rodou" com o
// batimento rodando dezenas de vezes (vistoria de 01/10, 2.3-1); a segunda virou a
// cadência e a próxima execução de cada linha da Situação.

async function loadOperations() {
  await window.DGOperacoes.carregar(false);
  // Se a pessoa estava nos Registros, o recarregar de minuto em minuto mantém lá.
  const reg = document.getElementById('op-registros');
  if (reg && !reg.hidden) carregarRegistrosDaOperacao();
}

async function carregarRegistrosDaOperacao() {
  const sessionData = await API.session();
  const el = document.getElementById('session-info');
  if (el) {
    el.innerHTML = sessionData && (sessionData.session_id || sessionData.updated)
      ? `<div><span>Sessão</span><b style="font-size:13px;word-break:break-all">${escapeHtml(sessionData.session_id || '--')}</b></div>
         <div><span>Conversa</span><b style="font-size:13px">${escapeHtml(String(sessionData.chat_id || '--'))}</b></div>
         <div><span>Atualizado</span><b style="font-size:13px">${formatDate(sessionData.updated)}</b>${updatedTag(sessionData.updated)}</div>`
      : '<div class="vazio-util" style="grid-column:1/-1">Nenhuma sessão registrada neste arquivo. Num agente que roda pela plataforma, '
        + 'quem diz se ele está de pé é o selo do cabeçalho.</div>';
  }
  const botoes = document.getElementById('log-buttons');
  if (botoes && !botoes.childElementCount) renderLogButtons();
}
window.carregarRegistrosDaOperacao = carregarRegistrosDaOperacao;

// Renderiza os botões de log a partir de APP_CONFIG.logs[] (descobertos pelo backend).
function renderLogButtons() {
  const wrap = document.getElementById('log-buttons');
  if (!wrap) return;
  const logs = (APP_CONFIG.logs && APP_CONFIG.logs.length) ? APP_CONFIG.logs : [{ id: 'heartbeat', label: 'HEARTBEAT' }];
  wrap.innerHTML = logs.map((l, i) =>
    `<button class="tab${i === 0 ? ' active' : ''}" data-log="${escapeHtml(l.id)}">${escapeHtml(l.label || l.id.toUpperCase())}</button>`
  ).join('');
  wrap.querySelectorAll('[data-log]').forEach((btn) => {
    btn.addEventListener('click', () => loadLog(btn.dataset.log, btn));
  });
  if (logs[0]) loadLog(logs[0].id);
}

async function loadLog(type, btn) {
  // Update tab buttons
  if (btn) {
    document.querySelectorAll('[data-log]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  const data = await API.logs(type, 40);
  document.getElementById('log-viewer').textContent = data
    ? (data.content || 'Este registro está vazio: a rotina ainda não escreveu nada nele.')
    : 'Não consegui abrir este registro. A faixa no topo da tela diz o motivo.';
}
// Make loadLog global for onclick
window.loadLog = loadLog;

// ─── IDENTITY Panel ────────────────────────────

async function loadIdentity() {
  // Os arquivos de quem ele é, cada um num cartão que abre no leitor/editor
  // compartilhado. Antes cada um abria embaixo do título em letra de 8px, sem
  // botão de editar, com o tutorial prometendo "edite ali mesmo".
  const files = [
    { name: 'SOUL.md', icon: '🔥', dica: 'A alma dele: o jeito de ser e de falar.' },
    { name: 'IDENTITY.md', icon: '👤', dica: 'O nome, o papel e o que ele faz para você.' },
    { name: 'PERSONALITY.md', icon: '🧠', dica: 'Os traços de personalidade, em números e em palavras.' },
    { name: 'CREATOR.md', icon: '🤝', dica: 'O que ele sabe sobre você, o dono.' },
    { name: 'ETHICS.md', icon: '⚖️', dica: 'O código de ética. Só leitura: ele protege você e quem fala com ele.' },
    { name: 'LAWS.md', icon: '📜', dica: 'As leis que ele nunca quebra. Só leitura, por desenho.' },
  ];
  // Arquivo que este agente não tem não aparece: um cartão que abre em "não achei"
  // ensina a pessoa a desconfiar da tela.
  const data = await API.identity();
  const chave = { 'SOUL.md': 'soul', 'IDENTITY.md': 'identity', 'PERSONALITY.md': 'personality', 'ETHICS.md': 'ethics', 'LAWS.md': 'laws', 'CREATOR.md': 'creator' };
  const existentes = data ? files.filter((f) => !chave[f.name] || (data[chave[f.name]] || '').trim()) : files;
  const el = document.getElementById('identity-files');
  if (!existentes.length) {
    // Agente novo: os arquivos de identidade ainda nascem vazios. Em branco a aba parece quebrada.
    el.innerHTML = '<p class="section-updated" style="padding:12px 4px">Ainda vazio. Peça ao agente na conversa: preencha sua identidade e personalidade e me pergunte o que precisar.</p>';
    return;
  }
  el.innerHTML = `<div class="memory-list">${existentes.map((f) => `<button type="button" class="memory-item" data-path="${f.name}" title="${escapeHtml(f.dica)}">
      <span class="mi-icon" aria-hidden="true">${f.icon}</span>
      <span class="mi-name">${f.name}<small class="mi-dica">${escapeHtml(f.dica)}</small></span>
      <span class="mi-date">abrir →</span>
    </button>`).join('')}</div>`;
  el.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => window.DGLeitor.abrir(b.dataset.path)));
}

// ─── Polling & Auto-refresh ────────────────────

async function refreshOverview() {
  const data = await API.overview();
  if (!data) return;

  // Update header (só faz sentido com a extensão de emoções instalada)
  const mood = data.mood?.current || '--';
  document.getElementById('header-mood').textContent = aliveOn() ? `Mood: ${mood}` : '';

  // Update footer
  document.getElementById('ft-posts').textContent = (data.postsToday || 0) + '/3';
  document.getElementById('ft-pending').textContent = data.pendingComments || 0;
  // SEM O DG ALIVE INSTALADO, HUMOR NÃO É ZERO: É NÃO MEDIDO.
  //
  // Estes dois vinham com "0%" fixo em todo agente sem a extensão de emoções, o
  // que é o mesmo defeito do "Posts 0/3": afirmar um número sobre uma coisa que
  // ninguém está medindo. Aqui não escondo, só troco pelo "--", porque a regra
  // das extensões é que nada some da tela e tudo acende sozinho quando a
  // extensão entra. "--" é o que se escreve quando não há medida.
  const pct = (v) => (aliveOn() ? Math.round((v || 0) * 100) + '%' : '--');
  document.getElementById('ft-joy').textContent = pct(data.emotions?.joy);
  document.getElementById('ft-energy').textContent = pct(data.mood?.energy);

  // Update time
  document.getElementById('header-time').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Refresh current panel
async function refreshCurrentPanel() {
  // A Conversa tem o poll curto dela (3s) e se recarregar por aqui recriaria o timer
  // a cada minuto, empilhando pollers até a tela pedir a conversa dezenas de vezes
  // por segundo.
  if (currentTab === 'conversa') return;
  tabLoaded[currentTab] = false;
  await loadPanel(currentTab, true);
}

// ─── Saúde do agente (o selo do cabeçalho) ─────
//
// POR QUE ISTO EXISTE. O selo nascia verde e escrito "Online" no index.html e
// NENHUM javascript escrevia nele: não media nada, era um adesivo. Em 28/08/2026
// o agente do cliente passou catorze horas fora do ar e o painel dele mostrou
// "Online" em verde o tempo inteiro. Este é o mesmo defeito do avatar, e da mesma
// família: elemento que nasce afirmando no HTML e depende de uma função que não
// existe. Por isso o selo agora nasce NEUTRO, escrito "verificando".
//
// Três estados, e eles não podem virar dois: está de pé (verde), está fora do ar
// (vermelho) e não consegui ver como ele está (amarelo). O terceiro não é um
// detalhe: dizer "fora do ar" quando o painel só perdeu contato é afirmar o que
// não foi medido.

// O texto do balão é ESCRITO AQUI, e não montado colando "O agente " na frente da
// frase que a rota manda. Colar produziu "O agente pronta para o que você
// precisar", que é erro de português em dose dupla: falta o verbo e o gênero vem
// do primeiro agente a existir. As frases de `ESTADOS`, no
// conversa.js, são de outra tela e têm outro entorno; concatenar as duas coisas
// era fazer uma delas depender do jeito que a outra foi escrita.
// Nenhuma frase daqui tem adjetivo com gênero: o painel serve agente de qualquer
// nome, e "pronto/pronta" seria errar metade das vezes.
const SAUDE_VISUAL = {
  pronto:       { cor: 'green',  texto: 'Online',
                  ajuda: 'Está de pé, esperando o que você precisar.' },
  viva:         { cor: 'green',  texto: 'Online',
                  ajuda: 'Está de pé.' },
  trabalhando:  { cor: 'green',  texto: 'Trabalhando',
                  ajuda: 'Está trabalhando em alguma coisa agora. Pode escrever assim mesmo: a sua mensagem entra na fila.' },
  acordando:    { cor: 'yellow', texto: 'Acordando',
                  ajuda: 'Acabou de ser chamado e está subindo. Leva alguns segundos.' },
  autorizacao:  { cor: 'yellow', texto: 'Esperando autorização',
                  ajuda: 'Parou para pedir uma autorização a quem cuida do sistema. Assim que for liberado, continua sozinho.' },
  interrompido: { cor: 'yellow', texto: 'Parado',
                  ajuda: 'Parou porque alguém apertou o freio. É só escrever para retomar.' },
  fora:         { cor: 'red',    texto: 'Fora do ar',
                  ajuda: 'Não está no ar agora, e por isso não vai responder. A sua conversa está guardada, e quem cuida do sistema consegue ver o motivo e resolver.' },
  indeterminado:{ cor: 'yellow', texto: 'Sem contato',
                  ajuda: 'O painel não conseguiu falar com a plataforma agora, então não dá para dizer como ele está. A sua conversa está guardada.' },
};

/**
 * O DIAGNÓSTICO (01/10/2026). Quando o /api/saude traz o objeto `diagnostico`
 * (escrito pela frente do Socorro, lib/saude.js), o selo passa a dizer uma de
 * quatro coisas, com a frase do motivo ao lado e, quando ele está mal, uma faixa
 * na Conversa com o botão CERTO para aquele caso. Sem `diagnostico` (painel com o
 * servidor antigo), vale o comportamento de antes, pelo SAUDE_VISUAL.
 *
 * Contrato: { estado: ativo|atencao|inativo|indeterminado, tipo, frase, trecho,
 * desde, ocorrencias, recomendacao: nada|esperar|reiniciar|modo_seguro|refazer_login,
 * comoResolver, sessionId, verificadoEm }.
 */
const DIAG_VISUAL = {
  ativo: { cor: 'green', texto: 'Ativo', ajuda: 'Está de pé e respondendo.' },
  atencao: { cor: 'yellow', texto: 'Atenção', ajuda: 'Está de pé, mas alguma coisa não vai bem. A frase ao lado diz o quê.' },
  inativo: { cor: 'red', texto: 'Inativo', ajuda: 'Não está respondendo agora. A faixa na Conversa diz o que fazer.' },
  indeterminado: { cor: '', texto: 'Sem contato', ajuda: 'O painel não conseguiu ver como ele está agora. Isso não quer dizer que ele caiu.' },
};

// A faixa da Conversa está oferecendo uma ação? Enquanto estiver, o "acordar" antigo
// some (ver desenharSinal): dois botões para a mesma coisa confundem.
let _faixaTemAcao = false;
// Enquanto um reinício pedido daqui está em andamento, a faixa é dele: o relógio de
// 30 s não redesenha por cima da contagem.
let _reiniciando = false;

async function atualizaSaude() {
  const dot = document.getElementById('health-dot');
  const label = document.getElementById('health-label');
  const selo = document.getElementById('health-selo');
  const frase = document.getElementById('health-frase');
  if (!dot || !label) return;
  ligarSeloSaude();

  const r = await API.saude();
  // Um 500 da rota ainda traz corpo com frase ("não consegui verificar"): ele vale.
  const s = r && r.corpo && (r.ok || r.corpo.chave || r.corpo.diagnostico) ? r.corpo : null;

  // Sem resposta é ausência de resposta, não "está tudo bem" e nem "caiu".
  if (!s) {
    const v = SAUDE_VISUAL.indeterminado;
    dot.className = `status-dot ${v.cor}`;
    label.textContent = v.texto;
    if (selo) { selo.title = `${v.ajuda} O painel tenta de novo em 30 segundos.`; selo.dataset.estado = 'indeterminado'; }
    if (frase) frase.textContent = '';
    desenharPopSaude({ frase: v.ajuda });
    if (!_reiniciando) desenharFaixaSaude(null);
    return;
  }

  const d = s.diagnostico;
  _diagSinal = d || null;
  desenharFaixaStatus(d);
  if (_ultimoEstadoSinal) desenharSinal(_ultimoEstadoSinal);
  if (d && DIAG_VISUAL[d.estado]) {
    const v = DIAG_VISUAL[d.estado];
    dot.className = `status-dot ${v.cor}`;
    label.textContent = v.texto;
    if (selo) {
      selo.dataset.estado = d.estado;
      selo.title = `${v.ajuda} ${d.frase || ''} O painel pergunta de novo a cada 30 segundos. Toque para ver o detalhe.`.trim();
    }
    if (frase) frase.textContent = d.estado === 'ativo' ? '' : (d.frase || '');
    desenharPopSaude(d);
    if (!_reiniciando) desenharFaixaSaude(d);
    return;
  }

  // ── sem diagnóstico: o selo de antes ──
  const v = SAUDE_VISUAL[s.chave] || SAUDE_VISUAL.indeterminado;
  dot.className = `status-dot ${v.cor}`;
  label.textContent = v.texto;
  if (frase) frase.textContent = '';
  if (selo) { selo.dataset.estado = s.viva === true ? 'ativo' : (s.viva === false ? 'inativo' : 'indeterminado'); }

  // O balão diz o estado e o que ele significa para QUEM ABRE ESTE PAINEL. O
  // detalhe técnico (caminho de arquivo, comando de conserto) fica no log do
  // servidor de propósito: quem abre aqui é o dono do agente, e mandar ele rodar
  // comando em servidor seria dar uma tarefa que não é dele nem ele consegue.
  if (selo) {
    selo.title = `${v.ajuda} O painel pergunta de novo a cada 30 segundos.`;
  }
  desenharPopSaude({ frase: v.ajuda });
  if (!_reiniciando) desenharFaixaSaude(null);
}

/** O selo abre e fecha o balão com a frase inteira (no celular não há "passar o mouse"). */
function ligarSeloSaude() {
  const selo = document.getElementById('health-selo');
  const pop = document.getElementById('health-pop');
  if (!selo || !pop || selo._ligado) return;
  selo._ligado = true;
  const fechar = () => { pop.hidden = true; selo.setAttribute('aria-expanded', 'false'); };
  selo.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pop.hidden = !pop.hidden;
    selo.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
    // No celular o selo pode estar em qualquer canto do cabeçalho, e um balão preso
    // nele sairia pela borda da tela. Lá ele vira uma faixa de margem a margem,
    // logo abaixo do selo.
    if (!pop.hidden) {
      const estreita = window.innerWidth <= 860;
      pop.classList.toggle('largo', estreita);
      pop.style.top = estreita ? `${Math.round(selo.getBoundingClientRect().bottom + 8)}px` : '';
    }
  });
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', fechar);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fechar(); });
}

function desenharPopSaude(d) {
  const pop = document.getElementById('health-pop');
  if (!pop) return;
  const linhas = [];
  if (d.frase) linhas.push(`<p class="sp-frase">${ricoLinha(d.frase)}</p>`);
  if (d.trecho) linhas.push(`<blockquote class="sp-trecho" title="O trecho exato que ele escreveu ou que o sistema devolveu.">“${escapeHtml(d.trecho)}”</blockquote>`);
  const pe = [];
  if (d.desde) pe.push(`desde ${formatDate(d.desde)}`);
  if (d.ocorrencias > 1) pe.push(`aconteceu ${d.ocorrencias} vezes`);
  if (d.verificadoEm) pe.push(`conferido ${formatAge(d.verificadoEm)}`);
  if (pe.length) linhas.push(`<p class="sp-pe">${escapeHtml(pe.join(' · '))}</p>`);
  if (d.estado === 'inativo' || d.estado === 'atencao') {
    linhas.push('<p class="sp-pe"><a href="#" class="link-aba" data-ir-para="conversa">ver o que fazer na Conversa</a></p>');
  }
  pop.innerHTML = linhas.join('') || '<p class="sp-frase">Verificando...</p>';
  ligarLinksEntreAbas();
}

const ACAO_FAIXA = {
  reiniciar: { rotulo: 'Reiniciar', modo: 'normal', explica: '' },
  modo_seguro: {
    rotulo: 'Reiniciar em modo de segurança', modo: 'seguro',
    explica: 'Ele volta sem a última conversa na cabeça (ela fica guardada, nada se perde), para não travar de novo no mesmo ponto.',
  },
  esperar: { rotulo: 'Tentar agora mesmo assim', modo: 'normal', discreto: true, explica: '' },
};

/**
 * O mesmo aviso, no topo do Status (pedido de 08/10/2026): a página inicial dizia "$0.00,
 * nenhuma rotina, sem sinal" e nem uma palavra sobre o login vencido, que só aparecia no selo.
 * Reaproveita as classes da faixa da Conversa; sem botão de reiniciar (quem reinicia é na
 * Conversa, com a pergunta de confirmação), só o link para lá.
 */
function desenharFaixaStatus(d) {
  const faixa = document.getElementById('status-faixa');
  if (!faixa) return;
  if (!d || !(d.estado === 'inativo' || d.estado === 'atencao')) {
    faixa.hidden = true;
    faixa.innerHTML = '';
    return;
  }
  faixa.hidden = false;
  faixa.className = `faixa-saude ${d.estado}`;
  faixa.innerHTML = `
    <div class="fs-texto">
      <b>${ricoLinha(d.frase || (d.estado === 'inativo' ? 'Ele não está respondendo agora.' : 'Alguma coisa não vai bem com ele.'))}</b>
      ${d.trecho ? `<blockquote class="fs-trecho">“${escapeHtml(d.trecho)}”</blockquote>` : ''}
      ${d.comoResolver ? `<p class="fs-como">${ricoLinha(d.comoResolver)}</p>` : ''}
      <p class="fs-explica"><a href="#" class="link-aba link-toque" data-ir-para="conversa">ver o que fazer na Conversa</a></p>
    </div>`;
  ligarLinksEntreAbas();
}

/** A faixa de aviso no topo da Conversa. `d` null ou ativo = some. */
function desenharFaixaSaude(d) {
  const faixa = document.getElementById('conversa-faixa');
  if (!faixa) return;
  if (!d || !(d.estado === 'inativo' || d.estado === 'atencao')) {
    faixa.hidden = true;
    faixa.innerHTML = '';
    _faixaTemAcao = false;
    return;
  }
  const acao = ACAO_FAIXA[d.recomendacao];
  _faixaTemAcao = true;
  // O "acordar" da linha do sinal sai na hora, sem esperar o próximo poll da conversa.
  const acordar = document.getElementById('btn-reativar');
  if (acordar && !_conversaAcordando) acordar.hidden = true;
  faixa.hidden = false;
  faixa.className = `faixa-saude ${d.estado}`;
  faixa.innerHTML = `
    <div class="fs-texto">
      <b>${ricoLinha(d.frase || (d.estado === 'inativo' ? 'Ele não está respondendo agora.' : 'Alguma coisa não vai bem com ele.'))}</b>
      ${d.trecho ? `<blockquote class="fs-trecho">“${escapeHtml(d.trecho)}”</blockquote>` : ''}
      ${d.comoResolver ? `<p class="fs-como">${ricoLinha(d.comoResolver)}</p>` : ''}
      ${acao && acao.explica ? `<p class="fs-explica">${escapeHtml(acao.explica)}</p>` : ''}
    </div>
    <div class="fs-acoes" id="conversa-faixa-acoes">${acao
      ? `<button type="button" class="${acao.discreto ? 'btn-leve' : 'btn-reativar'} fs-botao" data-modo="${acao.modo}">${escapeHtml(acao.rotulo)}</button>`
      : ''}</div>`;
  const botao = faixa.querySelector('.fs-botao');
  if (botao) botao.addEventListener('click', () => confirmarReinicio(acao));
}

/** Pergunta antes de reiniciar, ali mesmo na faixa (sem janela do navegador). */
function confirmarReinicio(acao) {
  const caixa = document.getElementById('conversa-faixa-acoes');
  if (!caixa) return;
  caixa.innerHTML = `<span class="fs-pergunta">Tem certeza? Ele para o que estiver fazendo e volta em alguns segundos.</span>
    <button type="button" class="btn-reativar" data-sim>Sim, ${escapeHtml(acao.rotulo.toLowerCase())}</button>
    <button type="button" class="btn-leve" data-nao>Cancelar</button>`;
  caixa.querySelector('[data-nao]').addEventListener('click', () => atualizaSaude());
  caixa.querySelector('[data-sim]').addEventListener('click', () => reiniciarPelaFaixa(acao.modo));
}

async function reiniciarPelaFaixa(modo) {
  const caixa = document.getElementById('conversa-faixa-acoes');
  _reiniciando = true;
  const escrever = (html) => { if (caixa) caixa.innerHTML = html; };
  escrever('<span class="fs-pergunta">Pedindo para reiniciar...</span>');
  const r = await API.saudeReiniciar(modo);
  if (!r || !r.ok) {
    const c = (r && r.corpo) || {};
    _reiniciando = false;
    escrever(`<span class="fs-erro"><b>${escapeHtml(c.error || 'Não consegui pedir o reinício.')}</b> ${escapeHtml(c.howToFix || 'Tente de novo em alguns segundos.')}</span>
      <button type="button" class="btn-leve" data-de-novo>tentar de novo</button>`);
    caixa && caixa.querySelector('[data-de-novo]').addEventListener('click', () => reiniciarPelaFaixa(modo));
    return;
  }
  // Volta a perguntar a saúde de 3 em 3 segundos, até 2 minutos, mostrando o tempo.
  const inicio = Date.now();
  for (let i = 0; i < 40; i++) {
    escrever(`<span class="fs-pergunta"><span class="sinal-ponto trabalhando"></span> Reiniciando... ${Math.round((Date.now() - inicio) / 1000)} s</span>`);
    await new Promise((ok) => setTimeout(ok, 3000));
    const s = await API.saude();
    const corpo = s && s.corpo;
    const voltou = corpo && (corpo.diagnostico ? corpo.diagnostico.estado === 'ativo' : corpo.viva === true);
    if (voltou) {
      _reiniciando = false;
      escrever('<span class="fs-ok">Voltou. Pode escrever.</span>');
      _conversaAssinatura = null;
      await atualizaSaude();
      await atualizarConversa();
      return;
    }
  }
  _reiniciando = false;
  escrever(`<span class="fs-erro"><b>Pedi para reiniciar, mas ele ainda não voltou.</b> A sua conversa continua guardada. Espere mais um minuto; se não voltar, avise quem cuida do sistema.</span>
    <button type="button" class="btn-leve" data-de-novo>conferir agora</button>`);
  caixa && caixa.querySelector('[data-de-novo]').addEventListener('click', () => atualizaSaude());
}

// ─── Config & Powers boot ──────────────────────

async function initConfig() {
  const cfg = await API.config();
  if (!cfg) return;
  APP_CONFIG = Object.assign(APP_CONFIG, cfg);
  // avatar chega cru do servidor (ex.: "/assets/sprites/avatar.jpg"): prefixa aqui, uma
  // vez, pra quem usa APP_CONFIG.avatar depois nao precisar lembrar do BASE.
  if (typeof APP_CONFIG.avatar === 'string') APP_CONFIG.avatar = BASE + APP_CONFIG.avatar;

  // Branding
  if (cfg.agentName) {
    document.title = `${cfg.agentName} - Painel`;
    const charName = document.getElementById('char-name');
    if (charName) charName.textContent = cfg.agentName;
    const title = document.getElementById('header-title');
    if (title) title.textContent = cfg.creatorName ? `agente de ${cfg.creatorName}` : 'agente';
  }
  if (cfg.avatar) {
    // APP_CONFIG.avatar (não cfg.avatar): já veio prefixado pelo BASE duas linhas acima.
    const av = document.getElementById('header-avatar');
    if (av) av.src = APP_CONFIG.avatar;
  }
  if (cfg.level != null && cfg.level !== '') {
    const lv = document.getElementById('char-level');
    if (lv) { lv.textContent = `Lv. ${cfg.level}`; lv.style.display = ''; }
  }
  // moodSprites parametrizável (merge sobre o default; mood sem sprite → default.gif)
  if (cfg.moodSprites && typeof cfg.moodSprites === 'object') {
    MOOD_SPRITES = Object.assign({ ...DEFAULT_MOOD_SPRITES }, cfg.moodSprites);
  }
  // Esconde botão de análise Haiku se backend não tem cost-analyzer.
  if (cfg.costAnalyzer === false) {
    const style = document.createElement('style');
    style.textContent = '.haiku-analysis-btn{display:none!important}';
    document.head.appendChild(style);
  }

  applyExtensions(cfg.extensions);

  // O RETRATO GRANDE, o que a pessoa realmente olha. Ele nasce no index.html com
  // `default.gif` e so trocava dentro de renderEmotions, que nao roda em agente
  // sem DG Alive. Resultado: o avatar configurado ficava invisivel justamente em
  // quem nao tem emocao, e o dono via um bonequinho generico no lugar da cara do
  // proprio agente. (O mini avatar do cabecalho acertava por acaso: o HTML ja
  // nasce apontando para avatar.jpg.) Com DG Alive instalado nada muda aqui, o
  // sprite de humor assume depois, como sempre.
  if (!aliveOn() && APP_CONFIG.avatar) {
    const sp = document.getElementById('sprite-img');
    if (sp) sp.src = APP_CONFIG.avatar;
  }
}

/**
 * Acende ou apaga os blocos que dependem de extensão.
 *
 * MUDOU EM 01/10/2026 (Danilo): sem a extensão, o bloco SOME inteiro. Antes ele
 * aparecia apagado com um bilhete "isso aqui só aparece com o DG Alive", e o dono de
 * um DG Claw puro via a tela cheia de anúncio de uma coisa que ele não tem e não
 * pediu. Com a extensão instalada, tudo volta a aparecer, no mesmo lugar. Quem
 * esconde é o CSS (`[data-ext].ext-off`), e os layouts em volta (faixa, mosaico) são
 * de grade automática, então o sumiço não deixa buraco.
 */
function applyExtensions(installed) {
  EXTENSIONS = Array.isArray(installed) ? installed : [];
  document.querySelectorAll('[data-ext]').forEach((el) => {
    el.classList.toggle('ext-off', !EXTENSIONS.includes(el.dataset.ext));
  });
}

/** A extensão de emoções está instalada? Usado antes de pintar humor e sprite. */
function aliveOn() {
  return EXTENSIONS.includes('alive');
}

async function initPowers() {
  const data = await API.powers();
  POWERS_STATE = {};
  if (data && Array.isArray(data.powers)) {
    for (const p of data.powers) POWERS_STATE[p.id] = !!p.enabled;
  }
  // NÚMERO DE PODER DESLIGADO SOME, e isso é diferente do que se faz com as abas.
  //
  // Aba travada continua na tela com um cadeado, porque ela anuncia uma
  // capacidade que o agente PODERIA ter, e esconder isso esconderia a opção. Um
  // número no rodapé não anuncia nada: ele afirma. "Posts 0/3" com o Instagram
  // desligado não é uma porta fechada, é uma informação falsa sobre uma meta que
  // ninguém combinou. Por isso um trava e o outro some.
  document.querySelectorAll('.footer-stat[data-power]').forEach((el) => {
    el.classList.toggle('escondido', !POWERS_STATE[el.dataset.power]);
  });

  // Trava as abas cujo poder está desligado (NÃO remove).
  document.querySelectorAll('.tab[data-power]').forEach((tab) => {
    const power = tab.dataset.power;
    const enabled = POWERS_STATE[power];
    if (enabled) {
      tab.classList.remove('locked');
      // remove cadeado se reabilitou
      const lk = tab.querySelector('.lock');
      if (lk) lk.remove();
      // Devolve a explicação da aba no lugar do texto do cadeado. Antes isto era
      // um removeAttribute, e a aba recém-liberada ficava sem balão nenhum.
      tab.title = EXPLICACAO_ABA[tab.dataset.tab] || '';
    } else {
      tab.classList.add('locked');
      if (!tab.querySelector('.lock')) {
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.textContent = '🔒';
        tab.insertBefore(lock, tab.firstChild);
      }
      const label = POWER_LABELS[power] || power;
      tab.title = `Instale o poder ${label} (/dgclaw:powers install ${power})`;
    }
  });
}

// ─── Init ──────────────────────────────────────

(async function init() {
  // Config + powers ANTES de tudo (branding, sprites, abas travadas).
  await initConfig();
  await initPowers();
  // Depois do initPowers, que é quem decide quais abas estão travadas.
  aplicarTooltipsDasAbas();
  ligarLinksEntreAbas();
  ligarAjudasDeSecao();
  // A Conversa é a aba que abre por padrão, então o botão de tutorial do
  // cabeçalho precisa nascer apontando para ela. Sem esta linha ele só apareceria
  // depois da primeira troca de aba, e quem entrasse e ficasse na Conversa nunca
  // veria que existe visita guiada.
  const abaInicial = NA_PLATAFORMA ? abaInicialDaPlataforma() : 'conversa';
  atualizarBotaoTutorial(abaInicial);
  if (NA_PLATAFORMA && window.DGCasca) {
    const bi = document.querySelector(`.tab[data-tab="${abaInicial}"]`);
    window.DGCasca.monta({ pagina: abaInicial, titulo: bi ? rotuloDaAba(bi) : '', aoTutorial: tutorialDaCasca });
    sincronizaCasca();
    // Sessões e os poderes aparecem e somem depois do boot: o menu acompanha as abas
    const tabs = document.getElementById('tabs');
    if (tabs && window.MutationObserver) {
      new MutationObserver(sincronizaCasca).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class'] });
    }
  } else if (NA_PLATAFORMA) {
    console.warn('[painel] a casca da Conversa (/casca.js) não carregou: o painel usa o menu antigo. Confira se o Web serve /casca.js.');
  }

  // A saúde começa ANTES da conversa: é ela que decide se a faixa de aviso aparece
  // e, com ela, se o botão "acordar" fica ou sai. Não espero: a conversa não depende.
  atualizaSaude();

  // A Conversa abre por padrão: é o que a dona vem fazer aqui.
  if (NA_PLATAFORMA) {
    // A conversa fica no chat: aqui a tela de entrada é a aba pedida no link, ou status.
    const botaoInicial = document.querySelector(`.tab[data-tab="${abaInicial}"]`);
    if (botaoInicial && botaoInicial.classList.contains('locked')) {
      console.warn(`[painel] aba "${abaInicial}" travada (poder não instalado). Abrindo status.`);
      abrirAba('status', document.querySelector('.tab[data-tab="status"]'));
    } else if (botaoInicial) {
      abrirAba(abaInicial, botaoInicial);
    }
  } else {
    await loadPanel('conversa');
  }
  // O primeiro agente chega aqui pelo botão de conectar a assinatura no Admin.
  if (new URLSearchParams(location.search).get('aba') === 'status') {
    document.querySelector('.tab[data-tab="status"]')?.click();
  }
  await refreshOverview();

  // Re-checa powers periodicamente (instalação de poder reflete sem reload).
  setInterval(async () => { await initPowers(); aplicarTooltipsDasAbas(); }, 60000);

  // Polling: overview every 30s, current panel every 60s
  setInterval(refreshOverview, 30000);
  setInterval(refreshCurrentPanel, 60000);

  // A saude do agente no selo do cabecalho. Junto do overview, porque e a mesma
  // pergunta que a pessoa faz ao abrir a tela: "ele esta de pe?".
  setInterval(atualizaSaude, 30000);

  // Tema claro ou escuro: o do sistema por padrao, e a escolha fica guardada no navegador.
  iniciarTema();

  // A faixa que mostra, com o motivo, quando uma leitura do painel falha.
  iniciarAvisoDeErro();

  // Menu em gaveta (so no celular).
  iniciarMenuCelular();

  // Seletor de agente (so aparece se a maquina tiver mais de um).
  await iniciarSeletorDeAgentes();

  // Update clock
  setInterval(() => {
    document.getElementById('header-time').textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }, 10000);

  // Costs panel listeners
  document.getElementById('costs-refresh')?.addEventListener('click', () => loadCosts(true));
  document.getElementById('costs-hours')?.addEventListener('change', () => loadCostsExecutions());
})();

// ─── COSTS Panel ───────────────────────────────

const CATEGORY_LABELS = {
  'crons': '🟦 Crons',
  'dm': '🟪 DM',
  'webhook': '🟧 Webhook',
  'heartbeat': '🟩 Heartbeat',
  'outro': '⬜ Outro',
};

function fmtUSD(n) {
  return '$' + (Number(n) || 0).toFixed(2);
}
function fmtUSD4(n) {
  return '$' + (Number(n) || 0).toFixed(4);
}
function fmtDur(ms) {
  if (!ms) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

async function loadCosts(force) {
  if (force) tabLoaded.costs = false;
  const o = await API.costsOverview();
  if (!o) return;

  // Summary
  const monthTotal = o.month.total;
  const budget = Number(o.budget) > 0 ? Number(o.budget) : null; // null = sem teto configurado
  const pct = budget ? Math.min(100, Math.round((monthTotal / budget) * 100)) : null;
  const barColor = pct >= 90 ? 'red' : pct >= 75 ? 'yellow' : 'green';
  const tetoHtml = budget
    ? `<span style="color:var(--text-dim)">/ ${fmtUSD(budget)} (${pct}%)</span>`
    : '<span style="color:var(--text-dim)">neste mês (sem teto de gastos configurado)</span>';
  const barraHtml = budget
    ? `<div class="rpg-bar-track" style="max-width:500px;height:14px">
        <div class="rpg-bar-fill ${barColor}" style="width:${pct}%"></div>
      </div>`
    : '';

  const summaryEl = document.getElementById('costs-summary');
  summaryEl.innerHTML = `
    <div style="font-size:13px;line-height:1.7">
      <div style="font-size:15px;margin-bottom:6px">
        <span style="color:var(--text)">${fmtUSD(monthTotal)}</span>
        ${tetoHtml}
      </div>
      ${barraHtml}
      <div style="margin-top:8px;display:flex;gap:18px;flex-wrap:wrap">
        <span>Hoje: <strong>${fmtUSD(o.today.total)}</strong> <span style="color:var(--text-dim)">(${o.today.executions} exec)</span></span>
        <span>Ontem: <strong>${fmtUSD(o.yesterday.total)}</strong></span>
        <span>7d: <strong>${fmtUSD(o.week.total)}</strong></span>
        <span style="color:var(--text-dim)">Total exec mês: ${o.month.executions}</span>
      </div>
    </div>
  `;

  // Categories
  const totalForPct = monthTotal || 1;
  const catEl = document.getElementById('costs-categories');
  const categorias = Object.entries(o.byCategory || {});
  if (!categorias.length) {
    catEl.innerHTML = '<div class="vazio-util">Ainda não houve gasto neste mês, então não há o que dividir por categoria. Quando ele trabalhar, aparece aqui para onde foi o dinheiro.</div>';
  }
  else catEl.innerHTML = categorias
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([cat, v]) => {
      const catPct = Math.round((v.cost / totalForPct) * 100);
      const label = CATEGORY_LABELS[cat] || cat;
      return `
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:4px">
          <span style="min-width:200px">${label}</span>
          <div class="rpg-bar-track" style="flex:1;max-width:300px;height:10px">
            <div class="rpg-bar-fill green" style="width:${catPct}%"></div>
          </div>
          <span style="min-width:80px;text-align:right">${fmtUSD(v.cost)} <span style="color:var(--text-dim)">(${v.executions})</span></span>
        </div>
      `;
    }).join('');

  // Top crons
  const topEl = document.getElementById('costs-top-crons');
  if (!(o.topCrons || []).length) {
    topEl.innerHTML = '<div class="vazio-util">Nenhuma rotina gastou nada neste mês até agora.</div>';
  } else topEl.innerHTML = `
    <table class="pixel-table" style="font-size:13px">
      <thead><tr><th title="O nome da rotina que rodou.">Rotina</th><th title="Quantas vezes ela rodou neste mês.">Vezes</th><th title="Quanto ela custou no mês inteiro, em dólar.">Custo</th><th title="O custo médio de cada vez que ela rodou: custo dividido pelas vezes.">Custo por vez</th></tr></thead>
      <tbody>
        ${o.topCrons.map(r => `
          <tr>
            <td>${escapeHtml(r.cron)}</td>
            <td>${r.executions}</td>
            <td>${fmtUSD(r.cost)}</td>
            <td>${fmtUSD4(r.cost / Math.max(1, r.executions))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  await loadCostsExecutions();
}

async function loadCostsExecutions() {
  const hours = document.getElementById('costs-hours').value || '24';
  const data = await API.costsExecutions(parseInt(hours));
  if (!data) return;

  const tbody = document.getElementById('costs-executions');
  if (!(data.executions || []).length) {
    tbody.innerHTML = '<tr><td colspan="7" class="vazio-util">Nenhuma execução nesta janela. Escolha uma janela maior ali em cima, se quiser ver mais para trás.</td></tr>';
    return;
  }
  tbody.innerHTML = data.executions.map(e => {
    const cost = Number(e.total_cost_usd) || 0;
    const costColor = cost > 1 ? 'var(--red)' : cost > 0.3 ? 'var(--yellow)' : 'var(--text)';
    return `
      <tr style="cursor:pointer" onclick="openExecutionDetail('${e.session_id}')">
        <td style="font-size:12px">${formatDate(e.timestamp)}</td>
        <td>${escapeHtml(e.cron || '?')}</td>
        <td style="color:var(--text-dim);font-size:12px">${escapeHtml(e.tag || '')}</td>
        <td style="font-size:12px">${escapeHtml(e.model || '?')}</td>
        <td>${e.num_turns || '--'}</td>
        <td style="font-size:12px">${fmtDur(e.duration_ms)}</td>
        <td style="color:${costColor};font-weight:bold">${fmtUSD4(cost)}${e.is_error ? ' ⚠️' : ''}</td>
      </tr>
    `;
  }).join('');
}

async function openExecutionDetail(sessionId) {
  const detail = await API.costsExecution(sessionId);
  if (!detail) return;

  const usage = detail.usage || {};
  const modelUsage = detail.model_usage || {};

  const modelUsageHtml = Object.entries(modelUsage).map(([m, v]) => `
    <div style="font-size:12px;margin-bottom:4px">
      <strong>${escapeHtml(m)}:</strong> cost=${fmtUSD4(v.costUSD)} | in=${v.inputTokens || 0} | out=${v.outputTokens || 0} | cache_read=${(v.cacheReadInputTokens || 0).toLocaleString()} | cache_create=${(v.cacheCreationInputTokens || 0).toLocaleString()}
    </div>
  `).join('');

  document.getElementById('modal-title').textContent = `${detail.cron} @ ${formatDate(detail.timestamp)}`;
  document.getElementById('modal-body').innerHTML = `
    <div style="font-size:13px;line-height:1.7">
      <div><strong>Custo:</strong> ${fmtUSD4(detail.total_cost_usd)}</div>
      <div><strong>Modelo:</strong> ${detail.model} | <strong>Turns:</strong> ${detail.num_turns} | <strong>Duração:</strong> ${fmtDur(detail.duration_ms)}</div>
      <div><strong>Session:</strong> <code style="font-size:12px">${detail.session_id || '?'}</code></div>
      <div><strong>Tag:</strong> ${escapeHtml(detail.tag || '--')}</div>
      ${detail.is_error ? '<div style="color:var(--red)"><strong>⚠️ ERROR</strong></div>' : ''}

      <div style="margin-top:12px"><strong>📥 Cache read:</strong> ${(usage.cache_read_input_tokens || 0).toLocaleString()} tokens</div>
      <div><strong>🆕 Cache create:</strong> ${(usage.cache_creation_input_tokens || 0).toLocaleString()} tokens</div>
      <div><strong>📤 Output:</strong> ${(usage.output_tokens || 0).toLocaleString()} tokens</div>
      <div><strong>↪️ Input direto:</strong> ${(usage.input_tokens || 0).toLocaleString()} tokens</div>

      ${modelUsageHtml ? `<div style="margin-top:12px"><strong>Breakdown por modelo:</strong></div>${modelUsageHtml}` : ''}

      <div style="margin-top:14px">
        <button class="tab haiku-analysis-btn" onclick="runHaikuAnalysis('${detail.session_id}')">🤖 ANÁLISE HAIKU</button>
        <span style="font-size:12px;color:var(--text-dim);margin-left:8px">(~$0.005, sob demanda)</span>
      </div>
      <div id="haiku-analysis-out" style="margin-top:12px"></div>
    </div>
  `;
  document.getElementById('modal').classList.add('active');
}

async function runHaikuAnalysis(sessionId) {
  const out = document.getElementById('haiku-analysis-out');
  out.innerHTML = '<div style="font-size:13px;color:var(--text-dim)">Analisando... (pode levar 10-30s)</div>';
  const result = await API.costsAnalyze(sessionId);
  if (!result) {
    out.innerHTML = '<div style="color:var(--red);font-size:13px">Erro na análise (verifique logs server.js)</div>';
    return;
  }
  if (result.error || (result.analysis && result.analysis.error)) {
    const err = result.error || result.analysis.error;
    out.innerHTML = `<div style="color:var(--red);font-size:13px">${escapeHtml(err)}</div>`;
    return;
  }
  const a = result.analysis;
  out.innerHTML = `
    <div style="background:var(--bg-card);border:2px solid var(--border);padding:10px;font-size:13px;line-height:1.7">
      <div style="font-weight:bold;margin-bottom:6px">🤖 ANÁLISE HAIKU</div>
      <div><strong>Resumo:</strong> ${ricoLinha(a.summary || '--')}</div>
      <div style="margin-top:6px"><strong>Onde foi o dinheiro:</strong> ${ricoLinha(a.where_money_went || '--')}</div>
      <div style="margin-top:6px"><strong>Eficiência:</strong> ${a.efficiency || '--'}/10 <span style="color:var(--text-dim)">${ricoLinha(a.efficiency_reason || '')}</span></div>
      <div style="margin-top:6px"><strong>Sugestões:</strong></div>
      <ul style="margin:4px 0 0 16px">${(a.suggestions || []).map(s => `<li>${ricoLinha(s)}</li>`).join('')}</ul>
      <div style="margin-top:8px;color:var(--text-dim);font-size:12px">Transcript ${result.transcript_found ? 'encontrado' : 'não encontrado'} · análise baseada ${result.transcript_found ? 'em transcript + métricas' : 'só em métricas'}</div>
    </div>
  `;
}

// ─── Aviso de erro de leitura ──────────────────

/**
 * Quando uma leitura falha, a tela DIZ, com o motivo que o servidor mandou.
 *
 * Antes o API.get engolia o erro e a tela ficava parada no último estado, calada
 * (vistoria de 01/10/2026, 2.3-2). Agora o api.js dispara `dgclaw:erro-api` e esta
 * faixa aparece no topo, dizendo O QUE não carregou e o que fazer. Quando a mesma
 * leitura volta a dar certo, ela some sozinha.
 */
const ROTULO_DA_LEITURA = [
  ['/api/chat/mensagens', 'a conversa'], ['/api/memory', 'a memória'], ['/api/costs', 'os custos'],
  ['/api/operations/logs', 'o registro'], ['/api/operations/session', 'a sessão viva'],
  ['/api/personality', 'a personalidade'], ['/api/identity', 'a identidade'], ['/api/overview', 'o resumo do menu'],
  ['/api/powers', 'os poderes instalados'], ['/api/config', 'a configuração do painel'], ['/api/thoughts', 'as metas'],
  ['/api/emotions', 'as emoções'], ['/api/reunioes', 'as reuniões'], ['/api/posts', 'os posts'],
  ['/api/followers', 'os seguidores'], ['/api/comments', 'os comentários'], ['/api/diary', 'o diário'],
];

function iniciarAvisoDeErro() {
  const faixa = document.getElementById('aviso-api');
  if (!faixa) return;
  let urlAtual = null;
  const rotulo = (url) => {
    const achou = ROTULO_DA_LEITURA.find(([pref]) => String(url || '').startsWith(pref));
    return achou ? achou[1] : 'uma parte desta tela';
  };
  window.addEventListener('dgclaw:erro-api', (ev) => {
    const d = ev.detail || {};
    urlAtual = String(d.url || '').split('?')[0];
    const motivo = d.error || (d.status ? `o painel respondeu com o código ${d.status}` : 'sem resposta');
    faixa.hidden = false;
    faixa.innerHTML = `<span><b>Não consegui carregar ${escapeHtml(rotulo(d.url))}:</b> ${escapeHtml(motivo)}.`
      + `${d.howToFix ? ` ${escapeHtml(d.howToFix)}` : ''}</span>`
      + '<button type="button" class="aviso-api-x" aria-label="Fechar o aviso" title="Fechar o aviso">&times;</button>';
    faixa.querySelector('.aviso-api-x').addEventListener('click', () => { faixa.hidden = true; urlAtual = null; });
  });
  window.addEventListener('dgclaw:ok-api', (ev) => {
    if (urlAtual && String((ev.detail || {}).url || '').split('?')[0] === urlAtual) { faixa.hidden = true; urlAtual = null; }
  });
}

// ─── Tema e seletor de agente ──────────────────

/**
 * Menu do celular. Na tela pequena a coluna da esquerda vira gaveta: fica fora da tela e
 * desliza quando voce toca no sanduiche. Fecha no veu, no Esc e ao escolher uma aba, pra
 * ninguem ficar preso atras do menu. No desktop nada disso aparece.
 */
function iniciarMenuCelular() {
  const botao = document.getElementById('btn-menu');
  const veu = document.getElementById('veu');
  if (!botao) return;

  const abrir = (sim) => {
    document.body.classList.toggle('menu-aberto', sim);
    botao.setAttribute('aria-expanded', sim ? 'true' : 'false');
  };

  botao.addEventListener('click', () => abrir(!document.body.classList.contains('menu-aberto')));
  veu?.addEventListener('click', () => abrir(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') abrir(false); });
  // Escolheu uma aba: a gaveta sai da frente sozinha.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab') && !e.target.classList.contains('locked')) abrir(false);
  });
  // Voltou pro tamanho grande: o menu e fixo de novo, entao limpa o estado.
  window.matchMedia('(min-width:861px)').addEventListener('change', (ev) => { if (ev.matches) abrir(false); });
}

/**
 * Tema claro ou escuro. Sem escolha guardada, vale o do sistema (o CSS ja cuida disso);
 * o botao grava a preferencia neste navegador e nao mexe em mais ninguem.
 */
function iniciarTema() {
  const raiz = document.documentElement;
  const guardado = (() => { try { return localStorage.getItem('dgclaw-tema'); } catch { return null; } })();
  if (guardado === 'claro' || guardado === 'escuro') raiz.dataset.tema = guardado;

  document.getElementById('btn-tema')?.addEventListener('click', () => {
    const escuroAgora = raiz.dataset.tema
      ? raiz.dataset.tema === 'escuro'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const novo = escuroAgora ? 'claro' : 'escuro';
    raiz.dataset.tema = novo;
    try { localStorage.setItem('dgclaw-tema', novo); } catch { /* navegador sem storage: vale so nesta aba */ }
  });
}

/**
 * Itens do seletor sob a plataforma. Cada agente usa a PRÓPRIA foto (avatar_img); sem foto,
 * um círculo com a cor dele e a letra ou emoji. O link leva à conversa (/a/<id>), na mesma
 * janela, porque a tela principal do agente é o chat.
 */
function htmlSeletorPlataforma(agentes, slugAtual, fotoAtual) {
  return agentes.map((a) => {
    const atual = a.id === slugAtual;
    const rotulo = a.nome || a.id;
    const cor = /^#[0-9a-fA-F]{3,8}$/.test(a.cor || '') ? a.cor : '#888';
    const foto = atual && fotoAtual ? fotoAtual : a.avatar_img;
    const imagem = foto
      ? `<img src="${escapeHtml(foto)}" alt="" class="mini">`
      : `<span class="mini" aria-hidden="true" style="background:${cor};color:#fff;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:600">${escapeHtml(a.avatar || rotulo.slice(0, 1).toUpperCase())}</span>`;
    const miolo = `${imagem}
      <span class="quem">${escapeHtml(rotulo)}<small>${escapeHtml(a.subtitulo || '')}</small></span>
      ${atual ? '<span class="aqui">aqui</span>' : ''}`;
    return atual
      ? `<span class="item">${miolo}</span>`
      : `<a href="/a/${encodeURIComponent(a.id)}">${miolo}</a>`;
  }).join('');
}

/** Itens do seletor de um painel solto: cada agente com a foto que a rota trouxer. */
function htmlSeletorLocal(agentes) {
  return agentes.map(a => {
    const nota = a.atual
      ? [a.servico, a.emocoes ? 'com emoções' : null].filter(Boolean).join(' · ')
      : (a.url ? [a.servico, a.emocoes ? 'com emoções' : null].filter(Boolean).join(' · ')
               : 'o painel dele ainda não está instalado');
    // Os OUTROS nunca usam o sprite padrao: assets/sprites/avatar.jpg e servido pela pasta
    // DESTE painel, e quando o dono troca a foto dele e esse arquivo que muda. Usar o sprite
    // nos outros fazia todos aparecerem com a cara do agente atual (Luna, 17/10/2026).
    const padrao = BASE + '/assets/sprites/avatar.jpg';
    const foto = a.atual ? (APP_CONFIG.avatar || padrao) : a.avatar_img;
    const nome = a.nome || a.slug || '?';
    const imagem = foto
      ? `<img src="${escapeHtml(foto)}" alt="" class="mini">`
      : `<span class="mini" aria-hidden="true" style="background:#888;color:#fff;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:600">${escapeHtml(nome.slice(0, 1).toUpperCase())}</span>`;
    const miolo = `${imagem}
      <span class="quem">${escapeHtml(a.nome || a.slug)}<small>${escapeHtml(nota)}</small></span>
      ${a.atual ? '<span class="aqui">aqui</span>' : ''}`;
    // Sem painel instalado nao ha pra onde ir: mostramos o agente, mas sem link morto.
    return (a.atual || !a.url)
      ? `<span class="item"${a.atual ? '' : ' style="opacity:.6"'}>${miolo}</span>`
      : `<a href="${a.url}" target="_blank" rel="noopener">${miolo}</a>`;
  }).join('') +
  '<span class="item vazio">Cada agente tem o painel dele, numa porta própria. Abrir outro não desliga este.</span>';
}

/**
 * Seletor de agente: a maquina pode ter mais de um assistente, cada um com o seu painel.
 * Trocar aqui abre o painel do outro (porta dele), sem sair do lugar em que voce esta.
 * Se a rota /api/agents nao existir (painel mais antigo) ou vier so este, o seletor some.
 */
async function iniciarSeletorDeAgentes() {
  const troca = document.getElementById('troca');
  if (!troca || !document.getElementById('lista-agentes')) return;

  // Os ouvintes entram uma vez só; a lista é rebuscada a cada 30 s e quando a aba volta a
  // ficar visível, para o seletor aparecer (ou sumir) sem recarregar a página.
  document.getElementById('btn-troca')?.addEventListener('click', (e) => {
    e.stopPropagation();
    troca.classList.toggle('aberto');
  });
  document.addEventListener('click', () => troca.classList.remove('aberto'));
  const rebuscar = () => { if (document.visibilityState === 'visible') atualizarSeletorDeAgentes(); };
  document.addEventListener('visibilitychange', rebuscar);
  setInterval(rebuscar, 30000);

  await atualizarSeletorDeAgentes();
}

async function atualizarSeletorDeAgentes() {
  const troca = document.getElementById('troca');
  const lista = document.getElementById('lista-agentes');
  if (!troca || !lista) return;

  let agentes = [];
  let falha = '';
  try {
    // Sob a plataforma a lista vem da rota do chat (mesma origem, cookie já vale), com a foto
    // de cada agente. Fora dela, da rota do próprio painel.
    const url = NA_PLATAFORMA ? '/api/v1/agents' : BASE + '/api/agents';
    const r = await fetch(url, { credentials: 'include' });
    // A rota do chat devolve `agentes`; a do painel, `agents`.
    if (r.ok) { const d = await r.json(); agentes = (NA_PLATAFORMA ? d.agentes : d.agents) || []; }
    else if (NA_PLATAFORMA) falha = `A lista de agentes respondeu ${r.status}.`;
  } catch (e) {
    if (NA_PLATAFORMA) falha = `Não consegui buscar a lista de agentes (${e.message}).`;
  }

  if (falha) {
    console.error(`[painel] seletor de agentes: ${falha}`);
    troca.style.display = '';
    lista.innerHTML = `<span class="item vazio">${escapeHtml(falha)} Recarregue a página para tentar de novo.</span>`;
  } else if (agentes.length < 2) {
    // O seletor nasce escondido no HTML: aqui ele só é REVELADO, e apenas quando existe
    // de fato outro agente para onde ir.
    troca.style.display = 'none';
    return;
  } else {
    troca.style.display = '';
    lista.innerHTML = NA_PLATAFORMA
      ? htmlSeletorPlataforma(agentes, SLUG_PLATAFORMA, APP_CONFIG.avatar)
      : htmlSeletorLocal(agentes);
  }
}
