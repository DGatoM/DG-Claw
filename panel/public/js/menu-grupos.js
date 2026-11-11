'use strict';
/* menu-grupos.js: os grupos (acordeões) do menu lateral do painel quando ele roda sozinho, sem a casca do DG Claw Web.
   Mesma ideia do menu da Conversa (web/public/menu-lado.js): o grupo da aba aberta abre sozinho, o que a pessoa deixa
   aberto fica neste aparelho, e um grupo sem nenhuma aba visível não aparece. Os botões .tab continuam sendo os de
   sempre: quem abre a aba é o js/app.js. */
(function () {
  const CHAVE = 'dgclaw:painel-grupos';
  const nav = document.getElementById('tabs');
  if (!nav) { console.warn('menu-grupos: não achei #tabs; o menu fica sem os grupos.'); return; }
  const grupos = [...nav.querySelectorAll('.grupo')];

  function guardados() {
    try {
      const v = JSON.parse(localStorage.getItem(CHAVE) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      console.warn('menu-grupos: não consegui ler quais grupos estavam abertos (' + e.message + '); eles começam fechados.');
      return {};
    }
  }
  function guarda(id, sim) {
    try {
      const v = guardados(); v[id] = sim;
      localStorage.setItem(CHAVE, JSON.stringify(v));
    } catch (e) {
      console.warn('menu-grupos: não consegui guardar o grupo "' + id + '" (' + e.message + '); a escolha vale só até recarregar a página.');
    }
  }
  function alterna(g, sim, gravar) {
    if (g.classList.contains('aberto') !== sim) g.classList.toggle('aberto', sim);
    const b = g.querySelector('.grupo-cab');
    if (b && b.getAttribute('aria-expanded') !== String(sim)) b.setAttribute('aria-expanded', String(sim));
    if (gravar) guarda(g.dataset.grupo, sim);
  }
  function abreDoAtivo() {
    const a = nav.querySelector('.tab.active');
    const g = a && a.closest('.grupo');
    if (g) alterna(g, true, false);
  }
  function visibilidade() {
    for (const g of grupos) {
      const algum = [...g.querySelectorAll('.tab')].some((t) => !t.hidden);
      if (g.hidden === algum) g.hidden = !algum;
    }
  }

  const salvo = guardados();
  for (const g of grupos) alterna(g, salvo[g.dataset.grupo] === true, false);
  nav.addEventListener('click', (ev) => {
    const b = ev.target.closest('.grupo-cab');
    if (!b) return;
    const g = b.closest('.grupo');
    alterna(g, !g.classList.contains('aberto'), true);
  });
  visibilidade();
  abreDoAtivo();
  // As abas mudam de visibilidade (Sessões, poderes) e de estado (ativa) depois do carregamento.
  new MutationObserver(() => { visibilidade(); abreDoAtivo(); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
})();
