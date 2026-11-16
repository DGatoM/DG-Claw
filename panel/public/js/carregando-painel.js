'use strict';
/* carregando-painel.js: põe o indicador do logo (dsCarregando) em todo bloco "Carregando..." do painel.
   Várias telas escrevem <div class="app-carregando">...</div> por conta própria; em vez de mexer em cada uma,
   este observador acrescenta o indicador na frente do texto assim que o bloco entra na página. */
(function () {
  if (typeof dsCarregando !== 'function' || typeof MutationObserver === 'undefined') return;
  function decorar(el) {
    if (el.querySelector('.ds-carregando')) return;
    el.insertAdjacentHTML('afterbegin', dsCarregando({ rotulo: 'Carregando', tamanho: 'p' }) + ' ');
  }
  function varrer(no) {
    if (no.nodeType !== 1) return;
    if (no.classList.contains('app-carregando')) decorar(no);
    no.querySelectorAll('.app-carregando').forEach(decorar);
  }
  new MutationObserver((lista) => { for (const m of lista) m.addedNodes.forEach(varrer); })
    .observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => varrer(document.body));
})();
