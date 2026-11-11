'use strict';
/* carregando.js: window.dsCarregando({ rotulo, tamanho }) devolve o HTML do indicador (constelação do logo).
   tamanho: 'p' | 'm' (padrão) | 'g'. O rótulo vai para aria-label (escapado). Geometria igual à do símbolo oficial
   (centro 498,438), escrita em relação ao centro para as bolinhas poderem entrar e sair dele. */
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BRACOS = [[1, -97, -134, 32], [2, 181, 48, 33], [3, -76, 139, 32]];
  window.dsCarregando = function (opcoes) {
    const o = opcoes || {};
    const rotulo = typeof o.rotulo === 'string' && o.rotulo ? o.rotulo : 'Carregando';
    const tam = ['p', 'm', 'g'].includes(o.tamanho) ? o.tamanho : 'm';
    let s = '<span class="ds-carregando ds-carregando--' + tam + '" role="status" aria-label="' + esc(rotulo) + '">' +
      '<svg viewBox="366 269 350 344" aria-hidden="true" focusable="false"><g transform="translate(498 438)">';
    BRACOS.forEach(([n, x, y]) => { s += '<path class="ds-car-lig b' + n + '" d="M0 0L' + x + ' ' + y + '"/>'; });
    BRACOS.forEach(([n, , , r]) => { s += '<circle class="ds-car-no b' + n + '" r="' + r + '"/>'; });
    s += '<circle class="ds-car-centro" r="57"/></g></svg><span class="ds-carregando-logo" aria-hidden="true"></span></span>';
    return s;
  };
  // HTML estático: <span data-carregando="Carregando as tarefas" data-tam="p"></span> vira o indicador assim que o DOM existe.
  // Se a tela já trocou o conteúdo antes disso, o marcador não existe mais e nada é desenhado por cima.
  function hidratar() {
    document.querySelectorAll('[data-carregando]').forEach((el) => {
      el.outerHTML = window.dsCarregando({ rotulo: el.getAttribute('data-carregando') || 'Carregando', tamanho: el.getAttribute('data-tam') || 'p' });
    });
  }
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hidratar); else hidratar();
})();
