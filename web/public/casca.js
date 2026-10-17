'use strict';
/* casca.js: o cabeçalho e o menu do agente (os mesmos da tela de Conversa) para as outras telas:
   Mesa, Lembretes, Avisos e o painel do agente (/p/<slug>/).

   Uso: DGCasca.monta({ pagina, titulo, aoTutorial })
     pagina     chave do item ativo do menu: 'mesa', 'lembretes', 'avisos' ou a de uma aba do painel
     titulo     o que aparece sob o nome do agente, no cabeçalho
     aoTutorial função chamada pelo botão Tutorial do cabeçalho (o tutorial da página)
   Depois: DGCasca.ativa(pagina, titulo) troca o item ativo e o título (o painel faz isso a cada aba);
           DGCasca.extras([{chave, ico, nome}]) acrescenta itens do painel que dependem do que está ligado.

   Quem é o agente: o caminho (/p/<slug>/), senão ?a=<slug>, senão o último aberto (localStorage
   'dgclaw:agente', gravado pela Conversa), senão o primeiro agente que não é o Admin.
   O visual mora em casca.css (não depende do chat.css nem do conversa.css); o menu, em menu-lado.js/css. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGCasca = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ctx = { caminho, busca, guardado }. Devolve o agente da lista ou null (lista vazia). */
  function escolheAgente(lista, ctx) {
    lista = Array.isArray(lista) ? lista : [];
    const c = ctx || {};
    const doCaminho = /^\/p\/([^/]+)/.exec(c.caminho || '');
    let doParam = null;
    try { doParam = new URLSearchParams(c.busca || '').get('a'); } catch (_) { /* busca ilegível: segue */ }
    let slug = null;
    try { slug = doCaminho ? decodeURIComponent(doCaminho[1]) : null; } catch (_) { /* caminho ilegível: segue */ }
    for (const id of [slug, doParam, c.guardado]) {
      const a = id && lista.find(x => x.id === id);
      if (a) return a;
    }
    return lista.find(a => a.tipo !== 'admin') || lista[0] || null;
  }

  const MARCACAO_CABECALHO =
    '<header data-tour="casca-cabecalho" id="cabecalho">' +
    '<button class="btn ghost" id="btnMenu" type="button" aria-label="Abrir o menu" data-tour="casca-menu">☰</button>' +
    '<div class="av" id="av" aria-hidden="true"></div>' +
    '<div class="who" id="who" data-tour="casca-titulo"><b id="nomeAgente">DG Claw</b><span id="estado"></span></div>' +
    '<button class="btn" id="btnTutorial" type="button" title="Visita guiada desta tela: o que é cada parte e por que está aqui">Tutorial</button>' +
    '</header>';

  /* A mesma marcação do menu do conversa.html (menu-lado.js mexe nestes ids). */
  const MARCACAO_MENU =
    '<div id="overlayMenu"></div>' +
    '<aside id="menu" aria-label="Menu do agente">' +
    '<button class="fechar" id="btnFechaMenu" type="button" aria-label="Fechar o menu">✕</button>' +
    '<div class="ml-marca" data-tour="gm-marca">' +
    '<div class="ml-moldura" id="mlMoldura" aria-hidden="true"></div>' +
    '<div class="ml-nome" id="mlNome">DG Claw</div>' +
    '<div class="ml-sub" id="mlSub"></div>' +
    '<button type="button" class="gm-tut" id="gmTutorial" title="Visita guiada do menu: o que é cada parte e por que está aqui">Tutorial</button>' +
    '<div class="ml-troca" id="mlTroca" data-tour="agentes" hidden>' +
    '<button type="button" id="mlTrocaBtn" aria-haspopup="true" aria-expanded="false"><span>trocar de agente</span><span class="ml-seta" aria-hidden="true">▾</span></button>' +
    '<div class="ml-lista" id="mlLista" role="menu"></div></div></div>' +
    '<nav class="ml-tabs" id="mlTabs" aria-label="Páginas do agente">' +
    '<div data-tour="gm-conversa"><button type="button" class="ml-tab ativo" id="gmIrConversa" aria-current="page"><span class="ml-ico" aria-hidden="true">◔</span>Conversa</button></div>' +
    '<div data-tour="gm-mesa"><a class="ml-tab" href="/mesa"><span class="ml-ico" aria-hidden="true">▦</span>Mesa de tarefas</a></div>' +
    '<div id="mlPainel" data-tour="gm-painel" hidden></div></nav>' +
    '<section class="ml-config" id="mlConfig" data-tour="gm-config" aria-label="Configurações"><h3>Configurações</h3>' +
    '<button type="button" class="ml-tab" id="mlInstalar"><span class="ml-ico" aria-hidden="true">⤓</span><span class="ml-tx">Instalar o app<small id="mlInstalarSub"></small></span></button>' +
    '<p class="ml-ajuda" id="mlInstalarAjuda" role="status" hidden></p></section>' +
    '<div class="pe"><div class="conta"><form method="post" action="/sair" id="formSair"><button type="submit" class="sair">Sair</button></form></div></div>' +
    '</aside>';

  if (!raiz.document) return { escolheAgente, MARCACAO_CABECALHO, MARCACAO_MENU };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const est = { pagina: '', titulo: '', aoTutorial: null, pronto: false, extras: null, agente: null, lista: [] };

  const abreMenu = sim => {
    const menu = $('menu'), ov = $('overlayMenu');
    if (menu) menu.classList.toggle('abre', !!sim);
    if (ov) ov.classList.toggle('abre', !!sim);
  };

  function pintaCabecalho(ag) {
    document.documentElement.style.setProperty('--accent', ag.cor || '#2f9e5e');
    $('nomeAgente').textContent = ag.nome || 'DG Claw';
    const av = $('av');
    const img = ag.avatar_img || (/^https:\/\//i.test(ag.avatar || '') ? ag.avatar : '');
    av.innerHTML = img ? `<img src="${esc(img)}" alt="">` : esc(ag.avatar || (ag.nome || '?').slice(0, 1));
    av.style.background = ag.cor || '#2f9e5e';
  }

  function pintaTitulo() {
    const e = $('estado');
    if (e) e.textContent = est.titulo || '';
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => alert('A visita guiada não carregou. Recarregue a página e tente de novo.');
    document.head.appendChild(s);
  }

  function passosCasca() {
    const nome = (est.agente && est.agente.nome) || 'o agente';
    return [
      { alvo: '#cabecalho', antes: () => abreMenu(false), titulo: 'O cabeçalho',
        oque: 'A foto e o nome do agente, e embaixo o nome da página em que você está. O botão Tutorial, aqui no cabeçalho, explica a página.',
        como: 'O cabeçalho é o mesmo em todas as telas: Conversa, Mesa, Lembretes e as páginas do painel. A cor e a foto são as de ' + nome + '.',
        porque: 'Assim você sabe de quem é a tela e nunca fica sem saber onde está.' },
      { alvo: '#btnMenu', antes: () => abreMenu(false), titulo: 'O botão do menu',
        oque: 'No celular, o botão ☰ abre o menu do agente. No computador ele não aparece, porque o menu já fica fixo à esquerda.',
        como: 'Toque nele para ir a outra página, trocar de agente ou sair. Toque fora do menu, no ✕ ou na tecla Esc para fechar.',
        porque: 'Mantém a tela limpa: o que não é a página atual fica guardado no menu.' },
      ...raiz.DGMenuLado.passosMenu({ nome, abre: () => abreMenu(true), fecha: () => abreMenu(false),
        comTroca: est.lista.filter(a => a.tipo === 'admin').concat(est.lista.filter(a => a.tipo !== 'admin')).length > 1,
        naConversa: false }),
    ];
  }

  function tutorialMenu() {
    comTour(() => raiz.DGTour.inicia({ passos: passosCasca(), aoFechar: () => abreMenu(false) }));
  }

  function tutorialPagina() {
    if (typeof est.aoTutorial === 'function') {
      try { est.aoTutorial(); } catch (e) { console.warn('casca: o tutorial da página falhou:', e); }
    } else tutorialMenu();
  }

  async function buscaLista() {
    const r = await fetch('/api/v1/agents', { cache: 'no-store', credentials: 'same-origin' });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
    return Array.isArray(d.agentes) ? d.agentes : [];
  }

  function monta(opcoes) {
    const o = opcoes || {};
    est.pagina = o.pagina || '';
    est.titulo = o.titulo || '';
    est.aoTutorial = o.aoTutorial || null;
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => monta(o)); return Promise.resolve(); }
    if ($('cabecalho')) return Promise.resolve();   // já montada
    document.documentElement.classList.add('casca');
    document.body.insertAdjacentHTML('afterbegin', MARCACAO_CABECALHO + MARCACAO_MENU);
    pintaTitulo();
    $('btnMenu').onclick = () => abreMenu(true);
    $('btnFechaMenu').onclick = () => abreMenu(false);
    $('overlayMenu').onclick = () => abreMenu(false);
    $('btnTutorial').onclick = tutorialPagina;
    $('gmTutorial').onclick = tutorialMenu;
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && $('menu').classList.contains('abre') && !$('tourCaixa')) abreMenu(false);
    });

    let guardado = null;
    try { guardado = localStorage.getItem('dgclaw:agente'); } catch (_) { /* sem armazenamento */ }
    const ctx = { caminho: location.pathname, busca: location.search, guardado };
    return buscaLista().then(lista => ({ lista, erro: null }), e => ({ lista: [], erro: e.message }))
      .then(({ lista, erro }) => {
        est.lista = lista;
        let ag = escolheAgente(lista, ctx);
        const slug = (/^\/p\/([^/]+)/.exec(location.pathname) || [])[1] || new URLSearchParams(location.search).get('a') || guardado || '';
        if (!ag) ag = { id: erro ? slug : '', nome: 'DG Claw', cor: '#2f9e5e', avatar: 'D' };
        est.agente = ag;
        pintaCabecalho(ag);
        if (!erro) { try { localStorage.setItem('dgclaw:agente', ag.id); } catch (_) { /* sem armazenamento */ } }
        if (!raiz.DGMenuLado) {
          console.warn('casca: menu-lado.js não carregou; o menu fica sem conteúdo. Carregue /menu-lado.js antes de /casca.js.');
          return;
        }
        raiz.DGMenuLado.inicia({
          agente: ag, agentes: erro ? undefined : lista, erroLista: erro ? 'o servidor respondeu: ' + erro : undefined,
          fecha: () => abreMenu(false), ativo: est.pagina, extras: est.extras || undefined,
        });
        est.pronto = true;
        raiz.DGMenuLado.marca(est.pagina);
      });
  }

  /* Troca o item ativo e o título (o painel chama a cada aba). */
  function ativa(pagina, titulo) {
    est.pagina = pagina || '';
    if (titulo != null) est.titulo = titulo;
    pintaTitulo();
    if (est.pronto && raiz.DGMenuLado) raiz.DGMenuLado.marca(est.pagina);
  }

  /* Itens do painel que dependem do que está ligado (Sessões, Posts, Seguidores, Reuniões). */
  function extras(lista) {
    est.extras = lista;
    if (est.pronto && raiz.DGMenuLado) raiz.DGMenuLado.extras(lista);
  }

  return { monta, ativa, extras, escolheAgente, abreMenu, tutorialMenu };
});
