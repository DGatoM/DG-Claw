// casca-ponte.js: no painel isolado (iframe sandbox dentro da moldura do Web, X-DGClaw-Base) o cabeçalho e o menu da
// casca não são montados aqui: moram na moldura, na origem do Web. Este arquivo define window.DGCasca com a mesma
// interface que o app.js usa (monta, ativa, extras, tutorialMenu) e repassa tudo à moldura por postMessage.
//
// Só dados sem segredo saem daqui: a chave da aba, o título, a lista de itens extras e o endereço pedido em `ir`.
// A moldura trata tudo como não confiável e só responde a mensagens vindas deste iframe.
(function () {
  'use strict';
  const pai = window.parent;
  let aoTutorial = null;

  function envia(msg) {
    if (!pai || pai === window) return;
    try { pai.postMessage(Object.assign({ dgclaw: 1 }, msg), '*'); } catch (e) {
      console.warn('[painel] não consegui falar com a moldura do painel (' + e.message + '). A página fica sem cabeçalho e menu.');
    }
  }

  const texto = (v, max) => String(v == null ? '' : v).slice(0, max);

  window.DGCasca = {
    monta(o) {
      const opcoes = o || {};
      aoTutorial = typeof opcoes.aoTutorial === 'function' ? opcoes.aoTutorial : null;
      envia({ tipo: 'ativa', pagina: texto(opcoes.pagina, 40), titulo: texto(opcoes.titulo, 120) });
      return Promise.resolve();
    },
    ativa(pagina, titulo) {
      envia({ tipo: 'ativa', pagina: texto(pagina, 40), titulo: titulo == null ? null : texto(titulo, 120) });
    },
    extras(lista) {
      const itens = (Array.isArray(lista) ? lista : []).filter((x) => x && x.chave).slice(0, 20)
        .map((x) => ({ chave: texto(x.chave, 40), ico: texto(x.ico, 8), nome: texto(x.nome, 60) }));
      envia({ tipo: 'extras', lista: itens });
    },
    tutorialMenu() { envia({ tipo: 'tutorial-menu' }); },
    /** Pede à moldura para abrir uma página do Web (/a/<agente>, /mesa...): o sandbox não deixa o iframe navegar o topo. */
    ir(para) { envia({ tipo: 'ir', para: texto(para, 200) }); },
  };

  // Links do painel que levam a páginas do Web: <a data-dgclaw-ir="/a/ana">
  document.addEventListener('click', (ev) => {
    const alvo = ev.target && ev.target.closest ? ev.target.closest('[data-dgclaw-ir]') : null;
    if (!alvo) return;
    ev.preventDefault();
    window.DGCasca.ir(alvo.getAttribute('data-dgclaw-ir'));
  });

  // O que a moldura manda de volta: só vale se vier da janela de cima.
  window.addEventListener('message', (ev) => {
    if (ev.source !== pai) return;
    const m = ev.data;
    if (!m || m.dgclaw !== 1) return;
    if (m.tipo === 'aba' && typeof m.chave === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(m.chave)) {
      // O app.js já ouve o hashchange e abre a aba.
      location.hash = '#aba=' + m.chave;
    } else if (m.tipo === 'tutorial') {
      if (aoTutorial) aoTutorial(); else window.DGCasca.tutorialMenu();
    } else if (m.tipo === 'tema' && (m.valor === 'claro' || m.valor === 'escuro')) {
      document.documentElement.dataset.tema = m.valor;
    }
  });

  // Avisa que está de pé: a moldura responde com o tema.
  envia({ tipo: 'pronto' });
})();
