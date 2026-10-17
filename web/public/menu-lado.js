'use strict';
/* menu-lado.js: o menu do agente na tela de conversa (gaveta no celular, barra fixa no computador).

   Mostra a foto do agente, o seletor para trocar de agente (cada item com a PRÓPRIA foto), a
   Conversa, as páginas do painel daquele agente e a seção Configurações (instalar o app).
   As partes que só montam texto (itemAgente, linksPainel, instrucaoInstalar) ficam fora do DOM e
   têm teste em web/test/menu-lado.test.js. Quem chama é o conversa.js, que já buscou a lista de
   /api/v1/agents: aqui ela não é buscada de novo, a não ser para o botão "recarregar". */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGMenuLado = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* chave = o que vai depois de #aba= (o painel abre a aba por ela) */
  const ABAS_PAINEL = [
    ['status', '◉', 'Status'], ['skills', '✦', 'Skills'], ['rotinas', '↻', 'Rotinas'],
    ['cofre', '⚿', 'Cofre (chaves)'], ['arquivos', '▢', 'Pasta do agente'],
    ['memory', '▤', 'Memória'], ['operations', '⚙', 'Operações'], ['costs', '◇', 'Custos'],
    ['como', '◎', 'Como funciona'], ['identity', '◈', 'Identidade'], ['personality', '◐', 'Personalidade'],
    ['apps', '▨', 'Apps'], ['socorro', '✚', 'Socorro'],
  ];


  /* Entrada fixa do menu: a tela de lembretes (vale para qualquer agente). */
  const LINK_LEMBRETES = { nome: 'Lembretes', ico: '⏰', href: '/lembretes' };

  /* Páginas fora do painel (Mesa, Lembretes) não têm o agente no caminho: levam ?a=<slug> para a
     tela saber de quem é o menu. */
  function comAgente(href, id) {
    if (!id) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'a=' + encodeURIComponent(id);
  }

  /* Qual item do menu o link representa: 'mesa', 'lembretes', a chave de #aba=... ou '' (outro). */
  function chaveDoHref(href) {
    const h = String(href || '');
    const aba = /#aba=([^&]*)/.exec(h);
    if (aba) return decodeURIComponent(aba[1]);
    const caminho = h.split(/[?#]/)[0].replace(/\/+$/, '');
    if (caminho === '/mesa') return 'mesa';
    if (caminho === '/lembretes') return 'lembretes';
    if (/^\/a\/[^/]+$/.test(caminho)) return 'conversa';
    return '';
  }

  /* Itens extras do painel que dependem do que está ligado (Sessões e os poderes). Cada um: { chave, ico, nome }. */
  function linksExtras(a, extras) {
    if (!a || !a.tem_painel || !Array.isArray(extras)) return [];
    const base = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    return extras.filter(x => x && x.chave && x.nome).map(x => ({ nome: x.nome, ico: x.ico || '•', href: base + '#aba=' + x.chave }));
  }

  /* Passos da visita guiada do menu, os mesmos na Conversa e nas outras telas.
     o = { nome, abre(), fecha(), comTroca, naConversa } */
  function passosMenu(o) {
    const nome = o.nome;
    const abre = o.abre || function () {};
    const passos = [{
      alvo: '#mlMoldura', antes: abre, titulo: 'O menu do agente',
      oque: 'A foto, o nome e as páginas de ' + nome + ', sempre no lado esquerdo. No computador ele fica aberto o tempo todo; no celular abre pelo botão ☰.',
      como: (o.naConversa ? 'O item Conversa (esta tela) fica no alto.' : 'O item Conversa, no alto, leva de volta ao chat.') +
        ' Os outros itens levam à Mesa, aos Lembretes e às páginas do painel dele. O Tutorial, aqui em cima, repete esta visita.',
      porque: 'Assim a conversa e o painel de cada agente ficam no mesmo lugar, sem link escondido.',
    }];
    if (o.comTroca) {
      passos.push({
        alvo: '#mlTroca', antes: abre, titulo: 'Trocar de agente',
        oque: 'Um seletor com todos os agentes que trabalham para você, cada um com a sua foto. O Admin vem primeiro, com o selo "admin"; o agente em que você está aparece marcado com "aqui".',
        como: 'Toque em "trocar de agente" e escolha um da lista: a conversa e o menu passam a ser dele. Cada agente tem a própria conversa e a própria memória.',
        porque: 'Você escolhe com quem falar sem sair desta tela. O Admin cuida da instalação e dos ajustes; os outros fazem o trabalho do dia a dia.',
      });
    }
    return passos;
  }

  /* A foto vem SEMPRE do próprio agente do item. Sem foto, círculo com a cor dele e a letra. */
  function fotoDe(a) {
    const img = a.avatar_img || (/^https:\/\//i.test(a.avatar || '') ? a.avatar : '');
    if (img) return `<img src="${esc(img)}" alt="">`;
    return esc(a.avatar || (a.nome || '?').slice(0, 1));
  }

  function itemAgente(a, atualId) {
    const aqui = a.id === atualId;
    const sub = a.subtitulo || [a.provedor, a.modelo].filter(Boolean).join(' · ');
    return `<a class="ml-ag${aqui ? ' atual' : ''}" role="menuitem" href="/a/${encodeURIComponent(a.id)}"` +
      `${aqui ? ' aria-current="page"' : ''}>` +
      `<span class="ml-mini" style="background:${esc(a.cor || '#2f9e5e')}">${fotoDe(a)}</span>` +
      `<span class="ml-quem"><b>${esc(a.nome)}</b><small>${esc(sub)}</small></span>` +
      `${aqui ? '<span class="ml-aqui">aqui</span>' : ''}</a>`;
  }

  function linksPainel(a) {
    if (!a || !a.tem_painel) return [];
    const base = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    return ABAS_PAINEL.map(([chave, ico, nome]) => ({ nome, ico, href: base + '#aba=' + chave }));
  }

  /* env = { standalone, ios, promptGuardado }. Devolve { tipo, texto }:
     'instalado' (esconde o item), 'prompt' (chama o prompt do navegador), 'ios' ou 'sem' (só explica). */
  function instrucaoInstalar(env) {
    if (env.standalone) return { tipo: 'instalado', texto: '' };
    if (env.promptGuardado) return { tipo: 'prompt', texto: '' };
    if (env.ios) {
      return { tipo: 'ios', texto: 'Toque em Compartilhar (o quadrado com a seta para cima) e depois em Adicionar à Tela de Início.' };
    }
    return { tipo: 'sem', texto: 'Este navegador não oferece a instalação por aqui. No Chrome ou no Edge, abra o menu do navegador e procure Instalar app. No Firefox para computador, o recurso não existe.' };
  }

  if (!raiz.document) return { ABAS_PAINEL, LINK_LEMBRETES, itemAgente, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  let promptGuardado = null;
  // O Chrome dispara isto uma vez, cedo; sem guardar aqui o toque no item não teria o que chamar.
  window.addEventListener('beforeinstallprompt', ev => {
    ev.preventDefault();
    promptGuardado = ev;
    pintaInstalar();
  });
  window.addEventListener('appinstalled', () => { promptGuardado = null; pintaInstalar(); });

  const ehStandalone = () => navigator.standalone === true ||
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const ehIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function pintaInstalar() {
    const sec = $('mlConfig');
    if (!sec) return;
    const r = instrucaoInstalar({ standalone: ehStandalone(), ios: ehIos(), promptGuardado: !!promptGuardado });
    sec.hidden = r.tipo === 'instalado';
    $('mlInstalarSub').textContent = r.tipo === 'prompt' ? 'atalho na tela, abre sem barra do navegador'
      : 'como colocar na tela inicial';
  }

  function mostraCaixa(texto) {
    const c = $('mlInstalarAjuda');
    c.textContent = texto;
    c.hidden = !texto;
  }

  async function aoInstalar() {
    const r = instrucaoInstalar({ standalone: ehStandalone(), ios: ehIos(), promptGuardado: !!promptGuardado });
    if (r.tipo !== 'prompt') { mostraCaixa($('mlInstalarAjuda').hidden ? r.texto : ''); return; }
    const p = promptGuardado;
    promptGuardado = null;
    try {
      await p.prompt();
      const esc_ = await p.userChoice;
      mostraCaixa(esc_ && esc_.outcome === 'accepted' ? '' : 'Tudo bem. Se mudar de ideia, o item continua aqui no menu.');
    } catch (e) {
      console.warn('menu-lado: o navegador recusou abrir a instalação:', e.message);
      mostraCaixa('O navegador não abriu a instalação (' + e.message + '). Tente pelo menu do navegador, em Instalar app.');
    }
    pintaInstalar();
  }

  function pintaLista(ag, lista, erro) {
    const caixa = $('mlLista'), troca = $('mlTroca');
    if (erro) {
      troca.hidden = false;
      caixa.innerHTML = `<div class="ml-vazio" role="alert">Não consegui listar os agentes: ${esc(erro)}. ` +
        '<button type="button" id="mlRecarrega">Recarregar a lista</button></div>';
      $('mlRecarrega').onclick = recarrega.bind(null, ag);
      return;
    }
    // sem outro agente para onde ir, o seletor só atrapalha
    troca.hidden = lista.length < 2;
    const ordem = lista.filter(a => a.tipo === 'admin').concat(lista.filter(a => a.tipo !== 'admin'));
    caixa.innerHTML = ordem.map(a => itemAgente(a, ag.id)).join('');
  }

  /* silencioso: nas buscas automáticas uma falha de rede passageira não troca a lista por um erro. */
  async function recarrega(ag, silencioso) {
    try {
      const r = await fetch('/api/v1/agents', { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
      pintaLista(ag, Array.isArray(d.agentes) ? d.agentes : [], null);
    } catch (e) {
      if (silencioso) console.warn('menu-lado: não consegui atualizar a lista de agentes (mantive a anterior):', e.message);
      else pintaLista(ag, [], e.message);
    }
  }

  let agenteAtual = null;

  /* Marca o item da página aberta (.ativo e aria-current). chave: 'conversa', 'mesa', 'lembretes' ou a de uma aba do painel.
     Chave sem item no menu (ex.: 'avisos') não marca nenhum. */
  let chaveAtiva = '';
  function marca(chave) {
    chaveAtiva = chave;
    document.querySelectorAll('#mlTabs .ml-tab').forEach(el => {
      const ativo = !!chave && chaveDoHref(el.getAttribute('href') || (el.id === 'gmIrConversa' ? '/a/x' : '')) === chave;
      el.classList.toggle('ativo', ativo);
      if (ativo) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
  }

  /* Troca os itens extras do painel (Sessões, Posts...): chamado de novo quando o que está ligado muda. */
  function extras(lista) {
    const painel = $('mlPainel');
    if (!painel || !agenteAtual) return;
    painel.querySelectorAll('[data-extra]').forEach(el => el.remove());
    const links = linksExtras(agenteAtual, lista);
    painel.insertAdjacentHTML('beforeend', links.map(l => `<a class="ml-tab" data-extra="1" href="${esc(l.href)}">` +
      `<span class="ml-ico" aria-hidden="true">${esc(l.ico)}</span>${esc(l.nome)}</a>`).join(''));
    painel.hidden = !painel.children.length;
    marca(chaveAtiva);
  }

  /* opcoes: { agente, agentes (a lista já carregada), fecha() (fecha a gaveta), ativo (chave da página aberta; padrão 'conversa'), extras (itens extras do painel), erroLista (texto: a lista de agentes falhou) } */
  function inicia(opcoes) {
    const ag = opcoes.agente;
    $('mlMoldura').innerHTML = `<span class="ml-foto" style="background:${esc(ag.cor || '#2f9e5e')}">${fotoDe(ag)}</span>`;
    $('mlNome').textContent = ag.nome;
    $('mlSub').textContent = ag.tipo === 'admin' ? 'administrador do servidor'
      : (ag.subtitulo || [ag.provedor, ag.modelo].filter(Boolean).join(' · '));
    document.documentElement.classList.add('ml-ativo');

    const troca = $('mlTroca'), btn = $('mlTrocaBtn');
    const abre = sim => { troca.classList.toggle('aberto', sim); btn.setAttribute('aria-expanded', String(sim)); };
    btn.onclick = () => abre(!troca.classList.contains('aberto'));
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && troca.classList.contains('aberto')) { abre(false); ev.stopPropagation(); }
    }, true);
    if (opcoes.erroLista) { pintaLista(ag, [], opcoes.erroLista); abre(true); }   // a lista não veio: o erro aparece já aberto
    else if (Array.isArray(opcoes.agentes)) pintaLista(ag, opcoes.agentes, null);
    else recarrega(ag);
    /* Agente criado ou apagado em outra aba aparece sem recarregar a página: a cada 30 s e quando a aba volta a ficar visível. */
    const atualiza = () => { if (document.visibilityState === 'visible') recarrega(ag, true); };
    document.addEventListener('visibilitychange', atualiza);
    setInterval(atualiza, 30000);

    const painel = $('mlPainel'), links = linksPainel(ag);
    painel.innerHTML = links.map(l => `<a class="ml-tab" href="${esc(l.href)}">` +
      `<span class="ml-ico" aria-hidden="true">${l.ico}</span>${esc(l.nome)}</a>`).join('');
    painel.hidden = !links.length;
    $('mlTabs').insertAdjacentHTML('beforeend', `<div data-tour="gm-lembretes"><a class="ml-tab" href="${comAgente(LINK_LEMBRETES.href, ag.id)}">` +
      `<span class="ml-ico" aria-hidden="true">${LINK_LEMBRETES.ico}</span>${LINK_LEMBRETES.nome}</a></div>`);
    // a Mesa já está no HTML com href="/mesa": passa a levar o agente junto
    const mesa = document.querySelector('#mlTabs a[href="/mesa"]');
    if (mesa) mesa.setAttribute('href', comAgente('/mesa', ag.id));
    agenteAtual = ag;
    if (Array.isArray(opcoes.extras)) extras(opcoes.extras);

    /* Fora da Conversa, o item Conversa vira link para ela; na Conversa, só fecha a gaveta. */
    const irConversa = $('gmIrConversa');
    if (opcoes.ativo && opcoes.ativo !== 'conversa') {
      const a = document.createElement('a');
      a.className = 'ml-tab'; a.id = 'gmIrConversa';
      a.href = ag.id ? '/a/' + encodeURIComponent(ag.id) : '/';
      a.innerHTML = '<span class="ml-ico" aria-hidden="true">◔</span>Conversa';
      irConversa.replaceWith(a);
    } else {
      irConversa.onclick = () => opcoes.fecha();
    }
    marca(opcoes.ativo || 'conversa');
    $('mlInstalar').onclick = aoInstalar;
    // escolher uma página fecha a gaveta (a navegação em seguida troca a tela)
    $('mlTabs').addEventListener('click', ev => { if (ev.target.closest('a')) opcoes.fecha(); });
    pintaInstalar();
  }

  return { ABAS_PAINEL, LINK_LEMBRETES, itemAgente, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar, inicia, marca, extras };
});
