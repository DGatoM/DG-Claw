// sessoes.js — a aba Sessões: os cards do Bunker, dentro do painel (12/10/2026).
//
// O QUE ELA É: o desenho da aba "Sessões" do DG Telegram (o mini-Bunker), trazido para cá.
// Cada sessão é um card do Bunker, uma conversa de Claude trabalhando numa pasta. Aqui o
// dono vê o que cada uma está fazendo, lê a conversa, manda recado, cria uma nova, pede
// handoff, arquiva e renomeia.
//
// O PAINEL SÓ APRESENTA. Estado, dono, filtro e fonte dos cards moram no DG Telegram; o
// servidor (lib/sessoes-proxy.js) repassa os pedidos com a chave da agente, que nunca chega
// aqui. A aba SOME quando /api/sessoes-config diz ligado:false (instalação sem DG Telegram).
//
// O QUE NÃO EXISTE AQUI, DE PROPÓSITO: decidir pedido de permissão, mandar tecla ao terminal
// e mexer no cofre. Um card não pode aprovar o próprio pedido, então isso só se faz no DG
// Telegram, com o login do Danilo. A tela mostra o pedido e leva até lá pelo botão
// "Decidir no DG Telegram"; o servidor recusa essas rotas mesmo que alguém tente chamá-las.
//
// TODO TEXTO QUE VEM DA API entra no DOM por textContent (função `el`), nunca por innerHTML.
//
// A aba é desenhada inteira por este arquivo (o mesmo padrão do cofre.js e do socorro.js) e
// o js/app.js só chama `DGSessoes.carregar()` no clique.

(function () {
  const BASE = window.DGCLAW_BASE || '';
  const INTERVALO_MS = 10000;
  const NOME_MAX = 120;

  const GRUPOS = {
    esperando_voce: { rotulo: 'Esperando você', cor: 'var(--espera)', pulsa: true },
    trabalhando: { rotulo: 'Trabalhando', cor: 'var(--acento1)', pulsa: true },
    concluido: { rotulo: 'Concluído', cor: 'var(--ok)' },
    parado: { rotulo: 'Parado', cor: 'var(--neutro)' },
    erro: { rotulo: 'Com erro', cor: 'var(--erro)' },
    fechado: { rotulo: 'Fechado (sem terminal)', cor: 'var(--neutro)' },
    arquivado: { rotulo: 'Arquivado', cor: 'var(--neutro)' },
  };

  // [filtro, rótulo, mostra a contagem, balão]
  const CHIPS = [
    ['ativos', 'Ativas', false, 'Tudo o que está aberto: esperando você, trabalhando, concluído, parado ou com erro. Não inclui as fechadas nem as arquivadas.'],
    ['esperando_voce', 'Esperando você', true, 'O card parou pedindo permissão ou esperando uma resposta sua. Ele não anda enquanto ninguém decidir (a decisão é no DG Telegram).'],
    ['trabalhando', 'Trabalhando', true, 'O card está trabalhando agora: o Bunker diz que ele está ativo, ou a conversa dele mexeu há menos de 1 minuto.'],
    ['concluido', 'Concluídas', true, 'O terminal está aberto, o card parou e terminou o que tinha para fazer.'],
    ['parado', 'Paradas', true, 'O terminal está aberto e o card parou sem ter terminado. Vale abrir e ler a conversa.'],
    ['erro', 'Com erro', true, 'O Bunker marcou erro no card, ou o estado dele não é conhecido.'],
    ['fechado', 'Fechadas', false, 'Cards sem terminal aberto (foram parados ou terminaram). Dá para retomar. A lista mostra só as 60 mais recentes.'],
    ['arquivado', 'Arquivadas', false, 'Cards que você escondeu da lista. Dá para desarquivar quando quiser.'],
  ];

  // ─── Utilidades ───────────────────────────────────────────────

  /** Monta um elemento. Todo texto entra por nó de texto, nunca como HTML. */
  function el(tag, props, ...filhos) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, String(v));
      }
    }
    for (const f of filhos.flat()) {
      if (f == null || f === false) continue;
      e.append(f.nodeType ? f : document.createTextNode(String(f)));
    }
    return e;
  }

  const $ = (id) => document.getElementById(id);
  const raiz = () => $('sessoes-root');
  const urlSegura = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
  const grupoDe = (it) => (it.arquivado ? 'arquivado' : (GRUPOS[it.grupo] ? it.grupo : 'parado'));
  const precisaRetomar = (it) => !!it && (!it.tem_terminal || it.grupo === 'fechado');

  function tamanho(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }

  function quando(iso) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'agora';
    const min = Math.floor(s / 60);
    const d = new Date(t);
    const hoje = new Date();
    const hora = `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === hoje.toDateString()) return min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h`;
    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);
    if (d.toDateString() === ontem.toDateString()) return `ontem ${hora}`;
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hora}`;
  }

  /**
   * O card pode ter um prefixo de status no nome ("▶️ ATIVA [VPS] — "). A tela edita só o
   * nome limpo e devolve o prefixo como estava, igual à tela do DG Telegram.
   */
  function prefixoNome(it) {
    return it && it.nome && it.nome_limpo && it.nome.endsWith(it.nome_limpo)
      ? it.nome.slice(0, it.nome.length - it.nome_limpo.length) : '';
  }

  /** Para onde "Decidir no DG Telegram" e "destravar o cofre" levam. */
  function linkDoTelegram(cfg, qual, id) {
    if (!cfg || !urlSegura(cfg.appUrl) || !cfg.agente) return '';
    const base = `${cfg.appUrl.replace(/\/+$/, '')}/a/${encodeURIComponent(cfg.agente)}`;
    if (qual === 'cofre') return `${base}?sessoes=1`;
    return id ? `${base}?sessoes=pedidos&card=${encodeURIComponent(id)}` : `${base}?sessoes=pedidos`;
  }

  /** Chamada ao proxy. Devolve {ok, status, corpo}; nunca lança por causa de resposta de erro. */
  async function chama(url, op) {
    op = op || {};
    const init = { credentials: 'same-origin', cache: 'no-store', method: op.method || 'GET' };
    if (op.form) {
      init.body = op.form; // multipart: o navegador escreve o Content-Type com o boundary
    } else if (op.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(op.body);
    }
    const ctl = new AbortController();
    init.signal = ctl.signal;
    const t = setTimeout(() => ctl.abort(), op.timeoutMs || 25000);
    try {
      const r = await fetch(BASE + url, init);
      if (r.status === 401) { window.location = `${BASE}/login.html`; return { ok: false, status: 401, corpo: {} }; }
      let corpo = null;
      try { corpo = await r.json(); } catch { /* corpo vazio ou que não é JSON: o status explica */ }
      return { ok: r.ok && !!corpo && corpo.ok !== false, status: r.status, corpo: corpo || {} };
    } catch (e) {
      throw new Error(e && e.name === 'AbortError'
        ? 'O painel não respondeu a tempo.'
        : `Não alcancei o painel: ${(e && e.message) || 'falha de rede'}.`);
    } finally {
      clearTimeout(t);
    }
  }

  /** A frase da API, com o que fazer. Nunca vazia e nunca "erro desconhecido". */
  function textoErro(res) {
    const c = (res && res.corpo) || {};
    let t = c.erro || c.error || `O painel respondeu com o erro ${res ? res.status : '?'} e sem explicação. Recarregue a aba; se repetir, o DG Telegram pode estar fora do ar.`;
    if (c.como_resolver || c.howToFix) t += ` ${c.como_resolver || c.howToFix}`;
    return t;
  }

  // ─── Tutorial ─────────────────────────────────────────────────
  // Regra do repo: nenhuma tela nasce muda. Cada passo responde o que é, como funciona e
  // por que está aqui. Passo cujo alvo não está na tela agora (o detalhe, quando a lista
  // está aberta, e o contrário) é pulado pelo motor.

  function passosDoTutorial() {
    const todos = passosBase();
    if (!soLeitura()) return todos;
    // Só leitura: o que o passo diria sobre ações não vale, então ele troca de texto. Passos
    // de coisas escondidas (nova sessão, recado) são pulados pelo motor, que ignora alvo ausente.
    return todos.map((p) => {
      if (p.chave === 'detalhe') {
        return Object.assign({}, p, { corpo: 'No alto ficam o nome, o estado e a pasta do card. Aqui não há estrela nem lápis de renomear: nesta aba só se lê.' });
      }
      if (p.chave === 'acoes') {
        return Object.assign({}, p, {
          titulo: 'Abrir no DG Telegram',
          corpo: 'O botão leva ao mesmo card no DG Telegram (no pedido, se houver um esperando você), onde ficam handoff, retomar, arquivar, renomear e o recado.',
          porque: 'Este painel só lê. As ações ficam onde o login do Danilo as protege.',
        });
      }
      return p;
    });
  }

  function passosBase() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'Os cards do Bunker, num lugar só',
        corpo: 'Cada sessão é um card do Bunker: uma conversa de Claude trabalhando numa pasta, como alguém sentado num computador cuidando de uma tarefa. Aqui você vê o que cada um está fazendo, lê a conversa, manda um recado, cria um novo e arquiva os que acabaram.',
        porque: 'Sem esta aba, saber se um card está parado esperando você exigiria abrir o Bunker ou o DG Telegram. Aqui o aviso aparece junto com o resto do agente.',
      },
      {
        chave: 'so-leitura',
        alvo: '#sx-selo',
        titulo: 'Por que esta aba é só para ler',
        corpo: 'O selo "só leitura" aparece quando este painel não tem a proteção de login do Cloudflare na frente. Aqui você vê a lista, a conversa e os documentos, mas não manda recado, não cria sessão e não arquiva. Em cada card, o botão "Abrir no DG Telegram" leva até onde essas ações existem.',
        porque: 'Se a senha deste painel vazasse, alguém conseguiria criar cards e mandar recados para sessões que rodam sem pedir permissão na máquina. Deixar a escrita só no DG Telegram, que tem login mais forte, fecha esse caminho.',
      },
      {
        chave: 'filtros',
        alvo: '#sx-chips',
        titulo: 'Os grupos, com a contagem de cada um',
        corpo: 'Cada botão é um grupo de cards pelo estado em que estão. O número entre parênteses é quantos há naquele grupo, no painel inteiro. "Ativas" junta tudo o que está aberto; "Esperando você" tem borda de alerta quando há alguém parado à sua espera.',
        porque: 'O estado vem do próprio Bunker, calculado pelo DG Telegram. O painel só mostra, para que o número aqui nunca discorde do que você vê lá.',
      },
      {
        chave: 'busca',
        alvo: '#sx-busca',
        titulo: 'Achar um card',
        corpo: 'Escreva parte do nome, da pasta ou do código do card. A busca ignora acento e maiúscula, e vale dentro do grupo escolhido acima.',
        porque: 'Quem tem dezenas de cards não lembra o nome exato; lembra do assunto ou da pasta onde ele trabalhou.',
      },
      {
        chave: 'lista',
        alvo: '#sx-lista',
        titulo: 'A lista de cards',
        corpo: 'Cada linha traz o nome, o estado (a bolinha pulsa quando ele está trabalhando ou esperando você), a pasta, há quanto tempo está nesse estado, o motivo e a última coisa que ele disse. A estrela marca os favoritos, que ficam antes dos outros. Toque numa linha para abrir o card. A lista se atualiza sozinha a cada 10 segundos enquanto a aba está aberta.',
        porque: 'A última fala e o motivo respondem "o que ele está fazendo?" sem abrir o card. Quando a aba fica escondida, a atualização para, para não gastar à toa.',
      },
      {
        chave: 'pedido',
        alvo: '#sx-lista .sx-pedido',
        titulo: 'Card esperando você',
        corpo: 'Quando um card para pedindo permissão (por exemplo, para apagar uma pasta), a linha mostra o pedido. O botão "Decidir no DG Telegram" abre, numa aba nova, a tela onde você aprova ou nega aquele pedido.',
        porque: 'A decisão não é tomada aqui de propósito: um card não pode aprovar o próprio pedido, e só o login do Danilo no DG Telegram pode decidir. O painel mostra o pedido e leva você até lá.',
      },
      {
        chave: 'cofre',
        alvo: '#sx-lista .sx-cofre',
        titulo: 'Cofre do Bunker trancado',
        corpo: 'Quando o servidor do Bunker reinicia, ele volta com o cofre trancado e não abre os cards até alguém digitar a senha mestra. Este cartão aparece no lugar da lista e leva ao DG Telegram, onde a senha é digitada.',
        porque: 'A senha mestra não passa por este painel. Ela só é digitada no DG Telegram, que é quem fala com o Bunker.',
      },
      {
        chave: 'nova',
        alvo: '#sx-nova',
        titulo: 'Criar uma sessão nova',
        corpo: 'Abre um formulário com nome, o pedido que o card vai receber, a pasta de trabalho (se ficar vazia, vale a pasta padrão da agente) e a permissão: "Automática" só barra o que é arriscado; "Pedir sempre" faz cada ação passar por você.',
        porque: 'Quem lê o pedido não viu a sua conversa. Por isso o formulário pede que você diga o que é e onde fica, em vez de deixar o card adivinhar.',
      },
      {
        chave: 'detalhe',
        alvo: '#sx-vista-det .sx-info',
        titulo: 'O card aberto',
        corpo: 'No alto ficam o nome, o estado e a pasta. A estrela marca como favorito e o lápis renomeia. Ao renomear, o prefixo de status que o card já tinha (▶️, ✅ ou ⏳) é mantido; você muda só o resto do nome.',
        porque: 'O prefixo é como o Danilo e as outras agentes reconhecem o estado do card pelo nome. Perder esse prefixo bagunçaria a lista de quem olha o Bunker.',
      },
      {
        chave: 'acoes',
        alvo: '#sx-vista-det .sx-acoes',
        titulo: 'As ações do card',
        corpo: 'Handoff pede ao card um resumo para continuar o trabalho numa sessão nova (primeiro consulta se ele já escreveu um, depois pede confirmação). Retomar reabre o terminal de um card fechado. Arquivar para o terminal e esconde o card da lista; Desarquivar traz de volta.',
        porque: 'Arquivar não apaga nada: a conversa continua guardada e o card pode ser retomado. É a forma de limpar a lista sem perder o trabalho.',
      },
      {
        chave: 'docs',
        alvo: '#sx-vista-det .sx-docs',
        titulo: 'Documentos que o card citou',
        corpo: 'Abra esta seção para listar os arquivos que o card mencionou nas respostas dele e que ainda existem no disco. Texto abre numa janela de leitura aqui mesmo; PDF abre numa aba nova.',
        porque: 'Só entram arquivos que o próprio card citou, para você não abrir por engano algo que ele nunca tocou. Segredos que aparecem nos textos vêm mascarados pelo Bunker.',
      },
      {
        chave: 'conversa',
        alvo: '#sx-vista-det .sx-conv-sec',
        titulo: 'A conversa do card',
        corpo: 'As mensagens mais recentes, as suas à direita e as do card à esquerda. "Carregar anteriores" traz as mais antigas. Enquanto o card está trabalhando, a conversa se atualiza sozinha a cada 10 segundos.',
        porque: 'Ler a conversa é o jeito de saber o que ele fez e por que parou, antes de mandar qualquer recado.',
      },
      {
        chave: 'recado',
        alvo: '#sx-vista-det .sx-recado',
        titulo: 'Mandar um recado',
        corpo: 'Escreva e envie. Com "Esperar ele terminar" marcado, o recado entra numa fila e chega quando o card ficar livre; sem marcar, ele é digitado no terminal na hora. O clipe anexa uma foto ou arquivo e escreve o caminho dele no recado. Se o card está fechado, o painel oferece retomar e enviar.',
        porque: 'Mandar na hora enquanto o card trabalha pode interromper o raciocínio dele; a fila evita isso. Se o card está esperando uma permissão, o recado fica desligado, porque ele cairia dentro do menu de permissão.',
      },
    ];
  }

  function abrirTutorial(comecarEm) {
    if (window.DGTutorial) window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  const ajuda = (chave, rotulo) => el('button', {
    type: 'button', class: 'app-ajuda-secao', 'data-tutorial': chave,
    'aria-label': rotulo, title: rotulo,
    // dentro de um <summary> o clique abriria e fecharia a seção junto
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); abrirTutorial(chave); },
  }, '?');

  // ─── Estado ───────────────────────────────────────────────────

  let cfg = null; // {ligado, motivo, agente, appUrl}
  let filtro = 'ativos';
  let busca = '';
  let dados = null;
  let contagem = null;
  let fonte = null;
  let erroLista = '';
  let cofreTrancado = false;
  let carregando = false;
  let seq = 0;
  let det = null;
  let timer = null;
  let sigLista = '';
  let sigChips = '';
  const rascunhos = new Map();
  let novaRascunho = { nome: '', prompt: '', pasta: '', permissao: 'auto' };

  // Painel sem Cloudflare Access na frente (o da Isa): a aba só lê. O servidor recusa toda escrita
  // com 403; aqui a tela esconde o que não funcionaria, em vez de mostrar botão que só dá erro.
  const soLeitura = () => !!(cfg && cfg.soLeitura);
  const TEXTO_SO_LEITURA = 'Neste painel a aba Sessões é só para ler: as ações (recado, criar, arquivar, renomear...) ficam no DG Telegram, porque este painel não tem a proteção de login do Cloudflare na frente.';

  const FN = () => (fonte && fonte.nome) || 'Bunker';
  // Recurso antigo: assume ligado até a fonte dizer que não. Recurso da fase 2: só aparece se a fonte disser que tem.
  const rec = (k) => !fonte || !fonte.recursos || fonte.recursos[k] === undefined || !!fonte.recursos[k];
  const recOn = (k) => !!(fonte && fonte.recursos && fonte.recursos[k]);

  function painelVisivel() {
    const p = $('panel-sessoes');
    return !document.hidden && !!p && p.classList.contains('active');
  }

  // ─── Esqueleto ────────────────────────────────────────────────

  function cabecalho() {
    const texto = 'Os cards do Bunker, as conversas de Claude que trabalham em pastas. Veja o que cada um faz, mande recado e crie sessões novas.';
    return el('div', { class: 'app-cabeca' },
      el('div', { class: 'app-cabeca-linha' },
        el('h2', { title: texto }, 'Sessões'),
        soLeitura() ? el('span', { class: 'sx-selo', id: 'sx-selo', title: TEXTO_SO_LEITURA, tabindex: '0' }, 'só leitura') : null,
        soLeitura() ? ajuda('so-leitura', 'Por que esta aba é só para ler') : null,
        el('button', { type: 'button', class: 'app-tutorial-abrir', id: 'sessoes-tutorial-abrir', title: 'Uma visita guiada por esta tela, passo a passo.', onclick: () => abrirTutorial(0) }, 'Tutorial'),
        ajuda('tela', 'O que é a aba Sessões')),
      el('p', null, texto));
  }

  function montarBase() {
    const r = raiz();
    r.textContent = '';
    r.append(cabecalho());
    if (!cfg || !cfg.ligado) {
      r.append(el('div', { class: 'app-erro' },
        el('strong', null, 'A aba Sessões não está ligada'),
        el('p', null, (cfg && cfg.motivo) || 'Não consegui saber se esta instalação tem o DG Telegram. Recarregue a página.')));
      return false;
    }
    const aviso = el('div', { class: 'sx-aviso', id: 'sx-aviso', role: 'status', hidden: true });
    const chips = el('div', { class: 'sx-chips', id: 'sx-chips', role: 'tablist', 'aria-label': 'Grupos de sessões' });
    const campo = el('input', {
      type: 'search', id: 'sx-busca-campo', placeholder: 'Buscar por nome, pasta ou código', autocomplete: 'off',
      'aria-label': 'Buscar sessões', title: 'Ignora acento e maiúscula. Vale dentro do grupo escolhido.',
    });
    let espera = null;
    campo.addEventListener('input', () => {
      clearTimeout(espera);
      espera = setTimeout(() => { busca = campo.value.trim(); carregaLista(true); }, 300);
    });
    const nova = el('button', {
      type: 'button', class: 'sx-btn prim', id: 'sx-nova', hidden: true, onclick: abreNova,
      title: 'Cria um card novo no Bunker, com o pedido que você escrever.',
    }, '+ Nova sessão');
    const lista = el('div', { class: 'sx-lista', id: 'sx-lista' });
    const vistaLista = el('div', { id: 'sx-vista-lista' },
      el('div', { class: 'cartao' },
        el('div', { class: 'section-title' }, 'Cards do Bunker', ajuda('lista', 'O que é a lista de cards')),
        chips,
        el('div', { class: 'sx-busca', id: 'sx-busca' }, campo, nova),
        lista));
    r.append(aviso, vistaLista, el('div', { id: 'sx-vista-det', hidden: true }));
    return true;
  }

  function mostraAviso(texto, comRetry) {
    const a = $('sx-aviso');
    if (!a) return;
    a.textContent = '';
    a.hidden = !texto;
    if (!texto) return;
    a.append(texto);
    if (comRetry) a.append(el('button', { type: 'button', onclick: () => carregaLista(true) }, 'Tentar de novo'));
  }

  // ─── Lista ────────────────────────────────────────────────────

  function renderChips() {
    const box = $('sx-chips');
    if (!box) return;
    const c = contagem || {};
    const somaAtivos = ['esperando_voce', 'trabalhando', 'concluido', 'parado', 'erro'].reduce((a, k) => a + (c[k] || 0), 0);
    const sig = JSON.stringify([filtro, contagem]);
    if (sig === sigChips) return;
    sigChips = sig;
    box.textContent = '';
    for (const [g, rot, comN, balao] of CHIPS) {
      if (g === 'erro' && !(c.erro > 0) && filtro !== 'erro') continue;
      let n = '';
      if (g === 'ativos' && contagem) n = ` (${somaAtivos})`;
      else if (comN && contagem) n = ` (${c[g] || 0})`;
      const alerta = g === 'esperando_voce' && (c.esperando_voce || 0) > 0;
      box.append(el('button', {
        type: 'button', role: 'tab', 'aria-selected': String(filtro === g), title: balao,
        class: `sx-chip${alerta ? ' alerta' : ''}${g === 'erro' ? ' erro' : ''}`,
        onclick: () => { filtro = g; sigChips = ''; sigLista = ''; renderChips(); carregaLista(true); },
      }, rot + n));
    }
  }

  function caixaPedido(it) {
    const g = grupoDe(it);
    if (g !== 'esperando_voce' && !it.pedido) return null;
    const link = linkDoTelegram(cfg, 'pedidos', it.id);
    return el('div', { class: 'sx-pedido' },
      el('div', { class: 'sx-ped-cab' }, el('b', null, 'Esperando você'), ajuda('pedido', 'Por que a decisão não é tomada aqui')),
      el('p', { class: 'sx-ped-txt' }, it.pedido || 'O card parou esperando uma permissão ou uma resposta.'),
      link ? el('a', {
        class: 'sx-btn prim', href: link, target: '_blank', rel: 'noopener',
        title: 'A decisão não é tomada aqui: um card não pode aprovar o próprio pedido. Abre o DG Telegram, onde só o login do Danilo decide.',
      }, 'Decidir no DG Telegram') : el('p', { class: 'sx-ped-nota' }, 'Decida no DG Telegram, com o login do Danilo.'));
  }

  function itemDaLista(it) {
    const info = GRUPOS[grupoDe(it)];
    const meta = [it.pasta, quando(it.desde)].filter(Boolean).join(' · ');
    const topo = el('button', { type: 'button', class: 'sx-item-topo', style: `--cor:${info.cor}`, onclick: () => abreDetalhe(it.id, it) },
      el('span', { class: `sx-bol${info.pulsa ? ' pulsa' : ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'sx-meio' },
        el('span', { class: 'sx-nome' },
          it.favorito ? el('span', { class: 'sx-estrela', title: 'Favorito: fica antes dos outros na lista', 'aria-label': 'Favorito' }, '⭐ ') : null,
          it.nome_limpo || it.nome || 'Card sem nome'),
        el('span', { class: 'sx-meta' }, el('span', { class: 'est' }, info.rotulo), meta ? ` · ${meta}` : ''),
        it.motivo ? el('span', { class: 'sx-motivo' }, it.motivo) : null,
        it.ultima_fala && it.ultima_fala.texto ? el('span', { class: 'sx-fala' }, it.ultima_fala.texto) : null));
    return el('div', { class: 'sx-item', 'data-id': it.id }, topo, caixaPedido(it));
  }

  function cartaoCofre() {
    const link = linkDoTelegram(cfg, 'cofre');
    return el('div', { class: 'sx-cofre' },
      el('div', { class: 'sx-ped-cab' }, el('b', null, `Cofre do ${FN()} trancado`), ajuda('cofre', 'Por que o cofre está trancado')),
      el('p', { class: 'sx-ped-txt' }, `O servidor do ${FN()} reiniciou e só volta a abrir os cards depois da senha mestra. Destrave pelo DG Telegram e volte aqui.`),
      link ? el('a', { class: 'sx-btn prim', href: link, target: '_blank', rel: 'noopener', title: 'A senha mestra é digitada só no DG Telegram, nunca neste painel.' }, 'Destravar no DG Telegram') : null);
  }

  function textoVazio() {
    if (busca) return 'Nenhuma sessão encontrada para essa busca.';
    const nomes = { ativos: 'ativa', esperando_voce: 'esperando você', trabalhando: 'trabalhando', concluido: 'concluída', parado: 'parada', erro: 'com erro', fechado: 'fechada', arquivado: 'arquivada' };
    return `Nenhuma sessão ${nomes[filtro]} agora.`;
  }

  function renderLista() {
    const box = $('sx-lista');
    if (!box || det) return;
    const itens = dados ? dados.itens || [] : [];
    const sig = JSON.stringify([itens, cofreTrancado, erroLista, filtro, busca, !!dados, cfg && cfg.appUrl]);
    if (sig === sigLista) return;
    sigLista = sig;
    const topo = box.scrollTop;
    box.textContent = '';
    if (cofreTrancado) {
      box.append(cartaoCofre());
    } else if (erroLista && !dados) {
      box.append(el('div', { class: 'app-erro' },
        el('strong', null, 'Não consegui carregar as sessões'),
        el('p', null, erroLista),
        el('button', { type: 'button', class: 'sx-btn sec', onclick: () => carregaLista(true) }, 'Tentar de novo')));
    } else if (!dados) {
      box.append(el('div', { class: 'sx-vazio' }, 'Carregando as sessões...'));
    } else if (!itens.length) {
      box.append(el('div', { class: 'sx-vazio' }, textoVazio()));
    } else {
      for (const it of itens) box.append(itemDaLista(it));
    }
    box.scrollTop = topo;
    const nova = $('sx-nova');
    if (nova) nova.hidden = !(rec('criar') && !cofreTrancado && !soLeitura());
  }

  async function carregaLista(forca) {
    if (!cfg || !cfg.ligado || (carregando && !forca)) return;
    carregando = true;
    const meu = ++seq;
    const qs = new URLSearchParams({ grupo: filtro });
    if (busca) qs.set('q', busca);
    try {
      const res = await chama(`/api/sessoes?${qs.toString()}`);
      if (meu !== seq) return;
      if (res.corpo && res.corpo.cofre_trancado) {
        cofreTrancado = true;
        erroLista = '';
        dados = null;
      } else if (!res.ok || !Array.isArray(res.corpo.itens)) {
        erroLista = textoErro(res);
      } else {
        erroLista = '';
        cofreTrancado = false;
        dados = res.corpo;
        contagem = res.corpo.contagem || contagem;
        if (res.corpo.fonte) fonte = res.corpo.fonte;
      }
    } catch (e) {
      if (meu !== seq) return;
      erroLista = e.message;
    } finally {
      if (meu === seq) carregando = false;
    }
    if (!det) mostraAviso(erroLista && dados ? `Não consegui atualizar: ${erroLista}` : (dados && dados.aviso_ponte) || '', !!erroLista);
    renderChips();
    renderLista();
  }

  // ─── Confirmações e leitura em janela ─────────────────────────

  function escolhe(o) {
    return new Promise((resolve) => {
      const botoes = o.opcoes.map((op, i) => el('button', { type: 'button', class: `sx-btn ${op.prim ? 'prim' : 'sec'}`, 'data-i': i }, op.rotulo));
      const caixa = el('div', { class: 'sx-fcx' },
        el('h3', null, o.titulo),
        o.texto ? el('p', null, o.texto) : null,
        o.pre ? el('pre', { class: o.grande ? 'grande' : '' }, o.pre) : null,
        el('div', { class: 'sx-btns' }, botoes));
      const folha = el('div', { class: 'sx-folha', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.titulo }, caixa);
      const fim = (v) => { folha.remove(); document.removeEventListener('keydown', tecla, true); resolve(v); };
      const tecla = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); fim(null); } };
      folha.addEventListener('click', (ev) => {
        const b = ev.target.closest && ev.target.closest('[data-i]');
        if (b) fim(o.opcoes[+b.dataset.i].valor);
        else if (ev.target === folha) fim(null);
      });
      document.addEventListener('keydown', tecla, true);
      document.body.append(folha);
      (botoes.find((b) => b.classList.contains('prim')) || botoes[0]).focus();
    });
  }

  // ─── Nova sessão ──────────────────────────────────────────────

  function abreNova() {
    const n = novaRascunho;
    const nome = el('input', { id: 'sx-n-nome', maxlength: NOME_MAX, autocomplete: 'off', value: n.nome, placeholder: 'Ex.: Ajustar a tela de lembretes' });
    const prompt = el('textarea', { id: 'sx-n-prompt', maxlength: 20000, placeholder: 'O que ele precisa fazer. Quem ler não viu a sua conversa: diga o que é e onde fica.' });
    prompt.value = n.prompt;
    const pasta = el('input', { id: 'sx-n-pasta', autocomplete: 'off', value: n.pasta, placeholder: 'Deixe vazio para usar a pasta padrão da agente' });
    const perm = el('select', { id: 'sx-n-perm', title: 'Automática: o Bunker só barra o que é arriscado. Pedir sempre: cada ação passa por você, no DG Telegram.' },
      el('option', { value: 'auto' }, 'Automática (só barra o arriscado)'),
      el('option', { value: 'default' }, 'Pedir sempre (cada ação passa por você)'));
    perm.value = n.permissao;
    const erro = el('p', { class: 'sx-erro', role: 'alert', hidden: true });
    const cria = el('button', { type: 'button', class: 'sx-btn prim' }, 'Criar sessão');
    const cancela = el('button', { type: 'button', class: 'sx-btn sec' }, 'Cancelar');
    const guarda = () => { novaRascunho = { nome: nome.value, prompt: prompt.value, pasta: pasta.value, permissao: perm.value }; };
    for (const e of [nome, prompt, pasta, perm]) e.addEventListener('input', guarda);
    const folha = el('div', { class: 'sx-folha', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Nova sessão' },
      el('div', { class: 'sx-fcx', id: 'sx-form-nova' },
        el('h3', null, el('span', null, 'Nova sessão'), ajuda('nova', 'Como funciona a nova sessão')),
        el('label', null, 'Nome', nome),
        el('label', null, 'Pedido para o card', prompt),
        el('label', null, 'Pasta de trabalho (opcional)', pasta),
        el('label', null, 'Permissão', perm),
        erro,
        el('div', { class: 'sx-btns' }, cria, cancela)));
    const fecha = () => { folha.remove(); document.removeEventListener('keydown', esc); };
    const esc = (ev) => { if (ev.key === 'Escape' && !document.querySelector('.app-tut-fundo')) fecha(); };
    document.addEventListener('keydown', esc);
    cancela.addEventListener('click', fecha);
    folha.addEventListener('click', (ev) => { if (ev.target === folha) fecha(); });
    cria.addEventListener('click', async () => {
      const falha = (t) => { erro.hidden = false; erro.textContent = t; };
      const vNome = nome.value.trim();
      const vPrompt = prompt.value.trim();
      if (!vNome) return falha('Dê um nome para a sessão.');
      if (!vPrompt) return falha('Escreva o pedido que o card vai receber.');
      erro.hidden = true;
      cria.disabled = true;
      cria.textContent = 'Criando...';
      try {
        // Sem `agente`: a chave da agente decide o dono do card.
        const res = await chama('/api/sessoes', { method: 'POST', timeoutMs: 80000, body: { nome: vNome, prompt: vPrompt, pasta: pasta.value.trim() || null, permissao: perm.value } });
        if (!res.ok) { falha(textoErro(res)); return; }
        novaRascunho = { nome: '', prompt: '', pasta: '', permissao: 'auto' };
        fecha();
        carregaLista(true);
        const it = res.corpo.item || res.corpo;
        if (it && it.id) abreDetalhe(it.id, it);
      } catch (e) {
        falha(`${e.message} A sessão pode ter sido criada: confira a lista antes de tentar de novo.`);
      } finally {
        if (cria.isConnected) { cria.disabled = false; cria.textContent = 'Criar sessão'; }
      }
    });
    document.body.append(folha);
    nome.focus();
  }

  // ─── Detalhe ──────────────────────────────────────────────────

  function abreDetalhe(id, itemInicial) {
    const rasc = rascunhos.get(id) || { texto: '', livre: false };
    det = {
      id, item: itemInicial || null, msgs: [], antes: null, truncado: false, carregouConv: false, erroConv: '',
      carregandoConv: false, ocupado: false, enviando: false, anexando: false, editandoNome: false, salvandoNome: false,
      docs: null, docsErro: '', docsCarregando: false, msgAcao: null, notaEnvio: null, notaAnexo: null,
      sigInfo: '', sigPedido: '', sigAcoes: '', sigConv: '', primeiraRolagem: true,
    };
    $('sx-vista-lista').hidden = true;
    const vista = $('sx-vista-det');
    vista.hidden = false;
    vista.textContent = '';

    const r = det.ref = {};
    r.info = el('div', { class: 'sx-info' });
    r.pedido = el('div');
    r.acoes = el('div', { class: 'sx-acoes' });
    r.msg = el('div');
    r.docsCorpo = el('div');
    r.docs = el('details', { class: 'sx-docs cartao', hidden: true },
      el('summary', null, el('span', null, 'Documentos citados'), ajuda('docs', 'Como funcionam os documentos citados')),
      r.docsCorpo);
    r.docs.addEventListener('toggle', () => { if (r.docs.open && !det.docs && !det.docsCarregando) carregaDocs(det); });
    r.mais = el('button', { type: 'button', class: 'sx-mais', hidden: true, title: 'Traz as mensagens mais antigas desta conversa.', onclick: () => carregaConversa('antigos') }, 'Carregar anteriores');
    r.convEstado = el('div', { class: 'sx-vazio' }, 'Carregando a conversa...');
    r.conv = el('div', { class: 'sx-conv' });
    r.texto = el('textarea', { rows: 3, placeholder: 'Escreva o recado para o card', 'aria-label': 'Recado para o card' });
    r.texto.value = rasc.texto;
    r.livre = el('input', { type: 'checkbox', id: 'sx-livre' });
    r.livre.checked = rasc.livre;
    r.enviar = el('button', { type: 'button', class: 'sx-btn prim', onclick: () => envia(false) }, 'Enviar');
    r.anexar = el('button', { type: 'button', class: 'sx-btn sec sx-mini', hidden: true, title: 'Anexa uma foto ou arquivo: o caminho dele entra no recado para o card ler.', 'aria-label': 'Anexar uma foto ou arquivo' }, '📎');
    r.arquivo = el('input', { type: 'file', hidden: true });
    r.anexar.addEventListener('click', () => { if (!r.anexar.disabled) r.arquivo.click(); });
    r.arquivo.addEventListener('change', anexa);
    r.notaAnexo = el('span', { class: 'sx-ferr-nota', role: 'status' });
    r.nota = el('p', { class: 'sx-rec-nota', role: 'status' });
    r.texto.addEventListener('input', guardaRascunho);
    r.livre.addEventListener('change', guardaRascunho);
    r.texto.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); envia(false); } });

    vista.append(
      el('div', { class: 'sx-det-topo' },
        el('button', { type: 'button', class: 'sx-btn sec sx-voltar', onclick: voltaLista, title: 'Volta para a lista de sessões.' }, '← Voltar à lista')),
      el('div', { class: 'cartao' },
        el('div', { class: 'section-title' }, 'O card', ajuda('detalhe', 'O que aparece no alto do card')),
        r.info, r.pedido),
      el('div', { class: 'cartao' },
        el('div', { class: 'section-title' }, 'Ações', ajuda('acoes', 'Como funcionam as ações do card')),
        r.acoes, r.msg),
      r.docs,
      el('div', { class: 'cartao sx-conv-sec' },
        el('div', { class: 'section-title' }, 'Conversa', ajuda('conversa', 'Como ler a conversa do card')),
        r.mais, r.convEstado, r.conv),
      el('div', { class: 'cartao sx-recado', hidden: soLeitura() },
        el('div', { class: 'section-title' }, 'Recado para o card', ajuda('recado', 'Como funciona o recado')),
        r.texto,
        el('div', { class: 'sx-rec-ferr' }, r.anexar, r.arquivo, r.notaAnexo),
        el('div', { class: 'sx-rec-linha' },
          el('label', { title: 'Marcado: o recado fica na fila e chega quando o card ficar livre. Desmarcado: é digitado no terminal agora, o que pode interromper o que ele está fazendo.' },
            r.livre, ' Esperar ele terminar'),
          r.enviar),
        r.nota));
    renderDetalhe();
    renderDocs();
    carregaConversa('inicial');
    if (!det.item) pollDetalhe();
    window.scrollTo({ top: 0 });
  }

  function guardaRascunho() {
    if (det) rascunhos.set(det.id, { texto: det.ref.texto.value, livre: det.ref.livre.checked });
  }

  function voltaLista() {
    if (!det) return;
    det = null;
    $('sx-vista-det').hidden = true;
    $('sx-vista-det').textContent = '';
    $('sx-vista-lista').hidden = false;
    sigLista = '';
    renderChips();
    renderLista();
    carregaLista(true);
  }

  function msgHtml(m) {
    if (!m) return null;
    return el('p', { class: `sx-msg ${m.tom || ''}`, role: 'status' }, m.texto,
      m.link ? [' ', el('a', { href: m.link, target: '_blank', rel: 'noopener' }, 'Abrir no DG Telegram')] : null);
  }

  function blocoInfo(it, info) {
    const d = det;
    const nomeAtual = it.nome_limpo || it.nome || '';
    let linha;
    if (d.editandoNome) {
      const campo = el('input', { id: 'sx-nome-edit', maxlength: Math.max(10, NOME_MAX - prefixoNome(it).length), autocomplete: 'off', 'aria-label': 'Novo nome da sessão' });
      campo.value = nomeAtual;
      campo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') salvaNome(d); if (ev.key === 'Escape') cancelaNome(d); });
      linha = el('span', { class: 'sx-nome-edit' }, campo,
        el('button', { type: 'button', class: 'sx-btn prim sx-mini', disabled: d.salvandoNome, onclick: () => salvaNome(d) }, d.salvandoNome ? 'Salvando...' : 'Salvar'),
        el('button', { type: 'button', class: 'sx-btn sec sx-mini', onclick: () => cancelaNome(d) }, 'Cancelar'));
      setTimeout(() => { if (campo.isConnected) { campo.focus(); campo.select(); } }, 0);
    } else {
      const botoes = [];
      if (recOn('favorito') && !soLeitura()) {
        botoes.push(el('button', {
          type: 'button', class: 'sx-ico-mini', 'aria-pressed': String(!!it.favorito),
          title: it.favorito ? 'Tirar dos favoritos' : 'Marcar como favorito: fica antes dos outros na lista',
          'aria-label': it.favorito ? 'Tirar dos favoritos' : 'Marcar como favorito', onclick: () => acaoFavorito(d),
        }, it.favorito ? '⭐' : '☆'));
      }
      if (recOn('renomear') && !soLeitura()) {
        botoes.push(el('button', {
          type: 'button', class: 'sx-ico-mini', title: 'Renomear a sessão (o prefixo de status ▶️/✅/⏳ é mantido)', 'aria-label': 'Renomear a sessão',
          onclick: () => { d.editandoNome = true; d.sigInfo = ''; renderDetalhe(); },
        }, '✏️'));
      }
      linha = el('span', { class: 'sx-nome-linha' }, el('span', { class: 'sx-nome' }, nomeAtual), botoes.length ? el('span', { class: 'sx-nome-btns' }, botoes) : null);
    }
    return [
      linha,
      el('span', { class: 'sx-estado', style: `--cor:${info.cor}` },
        el('span', { class: `sx-bol${info.pulsa ? ' pulsa' : ''}`, 'aria-hidden': 'true' }), info.rotulo),
      it.motivo ? el('span', { class: 'sx-motivo' }, it.motivo) : null,
      el('span', { class: 'sx-meta', title: it.cwd || '' }, `${it.pasta || it.cwd || ''} · ${quando(it.desde)}`),
    ];
  }

  function renderDetalhe() {
    const d = det;
    if (!d) return;
    const it = d.item;
    const r = d.ref;
    if (!it) { r.info.textContent = 'Carregando o card...'; return; }
    const info = GRUPOS[grupoDe(it)];

    const sigInfo = JSON.stringify([it.nome_limpo, it.nome, grupoDe(it), it.motivo, it.pasta, it.cwd, it.desde, it.favorito, d.editandoNome, d.salvandoNome, recOn('favorito'), recOn('renomear')]);
    if (sigInfo !== d.sigInfo) {
      d.sigInfo = sigInfo;
      r.info.textContent = '';
      r.info.append(...blocoInfo(it, info));
    }

    const caixa = caixaPedido(it);
    const sigPedido = caixa ? JSON.stringify([it.pedido, it.id, cfg && cfg.appUrl]) : '';
    if (sigPedido !== d.sigPedido) {
      d.sigPedido = sigPedido;
      r.pedido.textContent = '';
      if (caixa) r.pedido.append(caixa);
    }

    const off = d.ocupado;
    const botoes = [];
    if (soLeitura()) {
      const href = linkDoTelegram(cfg, 'pedidos', it.id);
      if (href) {
        botoes.push(el('a', { class: 'sx-btn prim', href, target: '_blank', rel: 'noopener', title: TEXTO_SO_LEITURA }, 'Abrir no DG Telegram'));
      } else {
        botoes.push(el('p', { class: 'sx-ped-nota' }, TEXTO_SO_LEITURA));
      }
    } else if (it.tem_terminal && rec('handoff')) {
      botoes.push(el('button', { type: 'button', class: 'sx-btn sec', disabled: off, onclick: () => acaoHandoff(d),
        title: 'Pede ao card um resumo para continuar o trabalho numa sessão nova. Primeiro consulta se ele já escreveu um; depois pede a sua confirmação.' }, 'Handoff'));
    }
    if (!soLeitura() && precisaRetomar(it) && !it.arquivado && rec('retomar')) {
      botoes.push(el('button', { type: 'button', class: 'sx-btn prim', disabled: off, onclick: () => acaoSimples(d, 'retomar'),
        title: 'Reabre o terminal de um card fechado, para ele poder trabalhar e receber recados.' }, 'Retomar'));
    }
    if (soLeitura()) {
      // só o link acima
    } else if (it.arquivado) {
      botoes.push(el('button', { type: 'button', class: 'sx-btn sec', disabled: off, onclick: () => acaoSimples(d, 'desarquivar'),
        title: 'Traz o card de volta para a lista de ativas.' }, 'Desarquivar'));
    } else if (rec('parar')) {
      botoes.push(el('button', { type: 'button', class: 'sx-btn perigo', disabled: off, onclick: () => acaoSimples(d, 'arquivar'),
        title: 'Para o terminal do card e esconde ele da lista. Nada é apagado: dá para retomar e desarquivar depois.' }, 'Arquivar'));
    }
    const sigAcoes = JSON.stringify([it.id, soLeitura(), botoes.length, off, it.tem_terminal, it.arquivado, grupoDe(it), rec('handoff'), rec('retomar'), rec('parar')]);
    if (sigAcoes !== d.sigAcoes) {
      d.sigAcoes = sigAcoes;
      r.acoes.textContent = '';
      r.acoes.append(...botoes);
    }
    const sigMsg = JSON.stringify(d.msgAcao);
    if (sigMsg !== d.sigMsg) {
      d.sigMsg = sigMsg;
      r.msg.textContent = '';
      const m = msgHtml(d.msgAcao);
      if (m) r.msg.append(m);
    }

    r.docs.hidden = !recOn('documentos');

    const bloqueio = it.estado === 'pedindo_permissao';
    const nota = bloqueio
      ? 'O card está esperando você autorizar um pedido. Decida no DG Telegram: um recado agora cairia dentro do menu de permissão.'
      : (d.notaEnvio ? d.notaEnvio.texto : '');
    r.texto.disabled = bloqueio;
    r.livre.disabled = bloqueio;
    r.enviar.disabled = bloqueio || d.enviando;
    r.enviar.textContent = d.enviando ? 'Enviando...' : 'Enviar';
    r.nota.textContent = nota;
    r.nota.classList.toggle('erro', !bloqueio && !!d.notaEnvio && d.notaEnvio.tom === 'erro');
    r.anexar.hidden = !recOn('anexo');
    r.anexar.disabled = bloqueio || d.anexando;
    r.anexar.textContent = d.anexando ? '⏳' : '📎';
    r.notaAnexo.textContent = d.anexando ? 'Enviando o anexo...' : (d.notaAnexo ? d.notaAnexo.texto : '');
    r.notaAnexo.classList.toggle('erro', !d.anexando && !!d.notaAnexo && d.notaAnexo.tom === 'erro');
  }

  async function pollDetalhe() {
    const d = det;
    if (!d || !cfg || !cfg.ligado) return;
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}`);
      if (det !== d) return;
      if (res.ok) {
        d.item = res.corpo.item || res.corpo;
        if (res.corpo.fonte) fonte = res.corpo.fonte;
        mostraAviso('');
      } else if (res.corpo && res.corpo.cofre_trancado) {
        voltaLista();
        return;
      } else if (res.status === 404) {
        mostraAviso(`Esse card não existe mais no ${FN()}. Volte para a lista.`);
        return;
      } else {
        mostraAviso(textoErro(res));
        return;
      }
    } catch (e) {
      if (det === d) mostraAviso(e.message);
      return;
    }
    renderDetalhe();
    if (d.item && d.item.grupo === 'trabalhando') carregaConversa('poll');
  }

  // ─── Conversa ─────────────────────────────────────────────────

  async function carregaConversa(modo) {
    const d = det;
    if (!d || d.carregandoConv) return;
    d.carregandoConv = true;
    let url = `/api/sessoes/${encodeURIComponent(d.id)}/conversa?`;
    if (modo === 'antigos') url += `limite=30&before=${encodeURIComponent(d.antes)}`;
    else url += `limite=${Math.min(100, Math.max(30, d.msgs.length + 15))}`;
    try {
      const res = await chama(url);
      if (det !== d) return;
      if (!res.ok) {
        d.erroConv = textoErro(res);
      } else {
        d.erroConv = '';
        const lista = Array.isArray(res.corpo.mensagens) ? res.corpo.mensagens : [];
        d.msgs = modo === 'antigos' ? lista.concat(d.msgs) : lista;
        d.antes = res.corpo.antes;
        d.truncado = !!res.corpo.truncado;
        d.carregouConv = true;
      }
    } catch (e) {
      if (det !== d) return;
      d.erroConv = e.message;
    } finally {
      d.carregandoConv = false;
    }
    renderConversa(modo === 'antigos');
  }

  function renderConversa(manterTopo) {
    const d = det;
    if (!d) return;
    const r = d.ref;
    r.convEstado.hidden = false;
    if (d.erroConv) { r.convEstado.textContent = d.erroConv; r.convEstado.className = 'sx-msg erro'; }
    else if (!d.carregouConv) { r.convEstado.textContent = 'Carregando a conversa...'; r.convEstado.className = 'sx-vazio'; }
    else if (!d.msgs.length) { r.convEstado.textContent = 'Esta sessão ainda não tem mensagens.'; r.convEstado.className = 'sx-vazio'; }
    else r.convEstado.hidden = true;
    r.mais.hidden = !(d.truncado && d.antes != null && !d.erroConv);
    const sig = JSON.stringify(d.msgs);
    if (sig === d.sigConv) return;
    d.sigConv = sig;
    const alturaAntes = document.documentElement.scrollHeight;
    const topoAntes = window.scrollY;
    r.conv.textContent = '';
    for (const m of d.msgs) {
      r.conv.append(el('div', { class: `sx-bal ${m.role === 'user' ? 'eu' : 'card'}` }, m.texto,
        m.cortado ? el('small', null, 'Texto cortado: era maior que o limite da tela.') : null));
    }
    if (manterTopo) window.scrollTo({ top: topoAntes + (document.documentElement.scrollHeight - alturaAntes) });
  }

  // ─── Recado e anexo ───────────────────────────────────────────

  async function envia(retomar) {
    const d = det;
    if (!d || d.enviando) return;
    const r = d.ref;
    const texto = r.texto.value.trim();
    if (!texto) { d.notaEnvio = { texto: 'Escreva o recado antes de enviar.', tom: 'erro' }; renderDetalhe(); return; }
    if (!retomar && precisaRetomar(d.item)) {
      const sim = await escolhe({
        titulo: 'Retomar o card?', texto: 'Esse card está fechado, sem terminal. Para entregar o recado eu preciso retomar a sessão dele. Retomo e envio?',
        opcoes: [{ rotulo: 'Retomar e enviar', valor: true, prim: true }, { rotulo: 'Cancelar', valor: null }],
      });
      if (!sim || det !== d) return;
      retomar = true;
    }
    d.enviando = true;
    d.notaEnvio = null;
    renderDetalhe();
    const livre = r.livre.checked;
    let pedeRetomar = false;
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/recado`, {
        method: 'POST', timeoutMs: 80000, body: { texto, quando: livre ? 'quando_livre' : 'agora', retomar: !!retomar },
      });
      if (res.ok) {
        if (det === d) {
          r.texto.value = '';
          rascunhos.delete(d.id);
          d.notaEnvio = { texto: livre ? 'Recado na fila: entra quando o card terminar.' : 'Recado enviado.', tom: 'ok' };
        }
        setTimeout(() => { if (det === d) { pollDetalhe(); carregaConversa('poll'); } }, 1800);
      } else if (res.status === 409 && !retomar && /retomar/i.test(res.corpo.como_resolver || '')) {
        pedeRetomar = true;
      } else if (det === d) {
        d.notaEnvio = { texto: textoErro(res), tom: 'erro' };
      }
    } catch (e) {
      if (det === d) d.notaEnvio = { texto: `${e.message} O recado pode ter chegado: confira a conversa antes de reenviar.`, tom: 'erro' };
    } finally {
      d.enviando = false;
    }
    if (det === d) renderDetalhe();
    if (pedeRetomar && det === d) {
      d.item = Object.assign({}, d.item, { tem_terminal: false });
      envia(false);
    }
  }

  async function anexa() {
    const d = det;
    const r = d && d.ref;
    const arq = r && r.arquivo.files && r.arquivo.files[0];
    if (r) r.arquivo.value = '';
    if (!d || !arq || d.anexando) return;
    d.anexando = true;
    d.notaAnexo = null;
    renderDetalhe();
    try {
      const form = new FormData();
      form.append('arquivo', arq, arq.name || 'anexo');
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/anexo`, { method: 'POST', form, timeoutMs: 180000 });
      if (det !== d) return;
      if (res.ok && res.corpo.caminho) {
        const t = r.texto;
        t.value = t.value.replace(/\s+$/, '') + (t.value.trim() ? '\n' : '') + `[anexo: ${res.corpo.caminho}]`;
        guardaRascunho();
        d.notaAnexo = { texto: `Anexado: ${res.corpo.nome || arq.name}. Revise o recado e envie.`, tom: 'ok' };
      } else {
        d.notaAnexo = { texto: `Não consegui anexar ${arq.name || 'o arquivo'}: ${textoErro(res)}`, tom: 'erro' };
      }
    } catch (e) {
      if (det === d) d.notaAnexo = { texto: `${e.message} O arquivo pode ter subido: confira o recado antes de anexar de novo.`, tom: 'erro' };
    } finally {
      d.anexando = false;
    }
    if (det === d) renderDetalhe();
  }

  // ─── Ações do card ────────────────────────────────────────────

  function mensagemAcao(texto, tom, link) {
    if (!det) return;
    det.msgAcao = texto ? { texto, tom: tom || '', link: link || '' } : null;
    renderDetalhe();
  }

  async function postAcao(d, caminho, corpo, okTexto) {
    d.ocupado = true;
    mensagemAcao('Aplicando...', '');
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}${caminho}`, { method: 'POST', body: corpo || {}, timeoutMs: 80000 });
      if (det !== d) return null;
      d.ocupado = false;
      if (res.ok) { mensagemAcao((res.corpo && res.corpo.aviso) || okTexto, 'ok'); return res; }
      mensagemAcao(textoErro(res), 'erro', urlSegura(res.corpo && res.corpo.abrir_em));
    } catch (e) {
      d.ocupado = false;
      if (det === d) mensagemAcao(e.message, 'erro');
    }
    return null;
  }

  async function acaoSimples(d, acao) {
    if (d.ocupado) return;
    if (acao === 'arquivar') {
      const v = await escolhe({
        titulo: 'Arquivar essa sessão?',
        texto: 'Arquivar para o terminal do card (ele continua podendo ser retomado depois) e esconde a sessão da lista de ativas. Dá para desarquivar quando quiser.',
        opcoes: [{ rotulo: 'Arquivar', valor: 'sim', prim: true }, { rotulo: 'Cancelar', valor: null }],
      });
      if (v !== 'sim' || det !== d) return;
      const res = await postAcao(d, '/arquivar', {}, 'Sessão arquivada.');
      if (res && det === d) { rascunhos.delete(d.id); voltaLista(); }
      return;
    }
    if (acao === 'desarquivar') {
      if (await postAcao(d, '/desarquivar', {}, 'Sessão desarquivada.')) pollDetalhe();
      return;
    }
    if (acao === 'retomar') {
      if (await postAcao(d, '/retomar', {}, `Pedi ao ${FN()} para reabrir o terminal desse card.`)) pollDetalhe();
    }
  }

  async function acaoHandoff(d) {
    if (d.ocupado) return;
    d.ocupado = true;
    mensagemAcao('Consultando se o card já escreveu o handoff...', '');
    let h;
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/handoff`);
      if (det !== d) return;
      d.ocupado = false;
      if (!res.ok) { mensagemAcao(textoErro(res), 'erro'); return; }
      h = res.corpo;
    } catch (e) {
      d.ocupado = false;
      if (det === d) mensagemAcao(e.message, 'erro');
      return;
    }
    mensagemAcao('');
    const cancelar = { rotulo: 'Cancelar', valor: null };
    let usar;
    if (h.modo === 'compact-no-lugar') {
      usar = await escolhe({
        titulo: 'Compactar no lugar',
        texto: h.aviso || `Esse card é de conteúdo: em vez de abrir uma sessão nova, o ${FN()} compacta a conversa aqui mesmo e o card continua.`,
        opcoes: [{ rotulo: 'Compactar no lugar', valor: 'sim', prim: true }, cancelar],
      });
      if (usar === 'sim') usar = true; else return;
    } else if (h.encontrado) {
      usar = await escolhe({
        titulo: 'Handoff pronto na conversa', texto: 'O card já escreveu um handoff. Posso usar esse ou pedir um novo.', pre: h.trecho,
        opcoes: [{ rotulo: 'Usar o que já está na conversa', valor: 'usar', prim: true }, { rotulo: 'Pedir um novo', valor: 'novo' }, cancelar],
      });
      if (usar === 'usar') usar = true; else if (usar === 'novo') usar = false; else return;
    } else {
      usar = await escolhe({
        titulo: 'Pedir o handoff', texto: `${h.motivo ? `${h.motivo} ` : ''}Não achei um handoff pronto na conversa. Peço que o card escreva um?`,
        opcoes: [{ rotulo: 'Pedir que o card escreva', valor: 'pedir', prim: true }, cancelar],
      });
      if (usar === 'pedir') usar = false; else return;
    }
    if (det !== d) return;
    const res = await postAcao(d, '/handoff', { usar_existente: usar, apagar_antigo: false },
      h.modo === 'compact-no-lugar' ? 'Pedi para compactar o card no lugar.' : 'Handoff pedido ao card.');
    if (res) pollDetalhe();
  }

  function atualizaItem(d, novo) {
    if (!novo || !novo.id) return;
    const { ok, fonte: _f, ...item } = novo; // a resposta traz `ok` junto do item
    d.item = Object.assign({}, d.item, item);
    d.sigInfo = '';
    d.sigPedido = '';
    if (dados && Array.isArray(dados.itens)) dados.itens = dados.itens.map((i) => (i.id === item.id ? Object.assign({}, i, item) : i));
  }

  async function acaoFavorito(d) {
    const it = d.item;
    if (!it || d.ocupado) return;
    d.ocupado = true;
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/favorito`, { method: 'POST', body: { favorito: !it.favorito } });
      if (det !== d) return;
      if (res.ok) { atualizaItem(d, res.corpo.item || res.corpo); mensagemAcao(''); } else mensagemAcao(textoErro(res), 'erro');
    } catch (e) {
      if (det === d) mensagemAcao(e.message, 'erro');
    } finally {
      d.ocupado = false;
    }
    if (det === d) renderDetalhe();
  }

  function cancelaNome(d) {
    d.editandoNome = false;
    d.sigInfo = '';
    if (det === d) renderDetalhe();
  }

  async function salvaNome(d) {
    const it = d.item;
    const campo = $('sx-nome-edit');
    if (!it || !campo || d.salvandoNome) return;
    const novo = campo.value.trim();
    if (!novo) { mensagemAcao('O nome não pode ficar vazio.', 'erro'); return; }
    if (novo === (it.nome_limpo || it.nome)) { cancelaNome(d); return; }
    d.salvandoNome = true;
    d.sigInfo = '';
    mensagemAcao('');
    renderDetalhe();
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/renomear`, { method: 'POST', body: { nome: prefixoNome(it) + novo } });
      if (det !== d) return;
      d.editandoNome = false;
      if (res.ok) atualizaItem(d, res.corpo.item || res.corpo);
      else mensagemAcao(`Não consegui renomear: ${textoErro(res)}`, 'erro');
    } catch (e) {
      if (det === d) { d.editandoNome = false; mensagemAcao(e.message, 'erro'); }
    } finally {
      d.salvandoNome = false;
      d.sigInfo = '';
    }
    if (det === d) renderDetalhe();
  }

  // ─── Documentos ───────────────────────────────────────────────

  function renderDocs() {
    const d = det;
    if (!d) return;
    const corpo = d.ref.docsCorpo;
    corpo.textContent = '';
    if (d.docsCarregando) {
      corpo.append(el('p', { class: 'sx-vazio' }, 'Procurando os documentos citados...'));
    } else if (d.docsErro) {
      corpo.append(el('p', { class: 'sx-msg erro', role: 'alert' }, d.docsErro),
        el('button', { type: 'button', class: 'sx-mais', onclick: () => carregaDocs(d) }, 'Tentar de novo'));
    } else if (!d.docs) {
      corpo.append(el('p', { class: 'sx-vazio' }, 'Abra esta seção para ver os arquivos que o card citou.'));
    } else if (!d.docs.length) {
      corpo.append(el('p', { class: 'sx-vazio' }, 'O card ainda não citou nenhum documento que exista no disco.'));
    } else {
      corpo.append(el('div', { class: 'sx-docs-lista' }, d.docs.map((x, i) =>
        el('button', { type: 'button', class: 'sx-doc', onclick: () => abreDocumento(i), title: 'PDF abre numa aba nova; texto abre numa janela de leitura aqui.' },
          el('span', { class: 'sx-doc-nome' }, x.nome),
          el('span', { class: 'sx-meta' }, [x.pasta, tamanho(x.tamanho), quando(x.quando)].filter(Boolean).join(' · '))))));
    }
  }

  async function carregaDocs(d) {
    if (!d || d.docsCarregando) return;
    d.docsCarregando = true;
    d.docsErro = '';
    renderDocs();
    try {
      const res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/documentos`, { timeoutMs: 40000 });
      if (det !== d) return;
      if (res.ok && Array.isArray(res.corpo.documentos)) d.docs = res.corpo.documentos;
      else d.docsErro = textoErro(res);
    } catch (e) {
      if (det === d) d.docsErro = e.message;
    } finally {
      d.docsCarregando = false;
    }
    if (det === d) renderDocs();
  }

  const urlDocumento = (id, caminho) => `${BASE}/api/sessoes/${encodeURIComponent(id)}/documentos/conteudo?caminho=${encodeURIComponent(caminho)}`;

  async function abreDocumento(i) {
    const d = det;
    const doc = d && d.docs && d.docs[i];
    if (!doc) return;
    if ((doc.tipo || '').toLowerCase() === 'pdf') {
      window.open(urlDocumento(d.id, doc.caminho), '_blank', 'noopener');
      return;
    }
    let res;
    try {
      res = await chama(`/api/sessoes/${encodeURIComponent(d.id)}/documentos/conteudo?caminho=${encodeURIComponent(doc.caminho)}`, { timeoutMs: 40000 });
    } catch (e) {
      res = { ok: false, status: 0, corpo: { erro: e.message } };
    }
    if (det !== d) return;
    if (!res.ok) { d.docsErro = `Não consegui abrir ${doc.nome}: ${textoErro(res)}`; renderDocs(); return; }
    d.docsErro = '';
    renderDocs();
    await escolhe({
      titulo: res.corpo.nome || doc.nome, grande: true, pre: res.corpo.texto,
      texto: res.corpo.cortado ? 'O arquivo é maior que o limite de leitura: aparece só o começo.' : '',
      opcoes: [{ rotulo: 'Fechar', valor: null, prim: true }],
    });
  }

  // ─── Ciclo de vida ────────────────────────────────────────────

  function tick() {
    if (!painelVisivel() || !cfg || !cfg.ligado) return;
    if (det) pollDetalhe(); else carregaLista(false);
  }

  async function carregarConfig() {
    try {
      const r = await fetch(`${BASE}/api/sessoes-config`, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { window.location = `${BASE}/login.html`; return null; }
      const c = await r.json();
      if (!r.ok) return { ligado: false, motivo: c.erro || c.error || `O painel respondeu ${r.status} ao perguntar se a aba Sessões está ligada.` };
      return c;
    } catch (e) {
      return { ligado: false, motivo: `Não consegui perguntar ao painel se a aba Sessões está ligada (${e.message}). Recarregue a página.`, falhaDeRede: true };
    }
  }

  async function carregar() {
    if (!cfg || cfg.falhaDeRede) cfg = await carregarConfig();
    if (!cfg) return;
    if (!montarBase()) return;
    dados = null; erroLista = ''; cofreTrancado = false; sigLista = ''; sigChips = ''; det = null;
    renderChips();
    renderLista();
    if (!timer) timer = setInterval(tick, INTERVALO_MS);
    await carregaLista(true);
  }

  /** A aba nasce escondida no menu e só aparece se este servidor tem o DG Telegram ligado. */
  async function pendurar() {
    const aba = document.querySelector('.tab[data-tab="sessoes"]');
    if (!aba || aba._sessoes) return;
    aba._sessoes = true;
    cfg = await carregarConfig();
    if (cfg && cfg.ligado) aba.hidden = false;
    // Voltar para a aba atualiza na hora, em vez de esperar o próximo ciclo de 10 s.
    aba.addEventListener('click', () => setTimeout(() => { if (raiz() && raiz().firstChild && cfg && cfg.ligado) tick(); }, 0));
  }

  if (typeof document !== 'undefined' && document.querySelector) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pendurar);
    else pendurar();
  }

  window.DGSessoes = {
    carregar,
    abrirTutorial,
    _interno: { prefixoNome, linkDoTelegram, passosDoTutorial, grupoDe, textoErro, GRUPOS, CHIPS },
  };
})();
