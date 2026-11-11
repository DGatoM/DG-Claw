'use strict';
/* icone.js: window.dsIcone('nome') devolve o HTML de um ícone do sprite /ds/icones.svg.
   O nome precisa ser um literal do código (nunca texto vindo de fora); aqui ele ainda é validado. */
(function () {
  window.dsIcone = function (nome, classe) {
    if (typeof nome !== 'string' || !/^[a-z0-9-]+$/.test(nome)) {
      if (window.console) console.warn('dsIcone: nome de ícone inválido (' + String(nome).slice(0, 40) + '). Use só letras minúsculas, números e hífen, como em /ds/icones.svg.');
      return '';
    }
    const extra = typeof classe === 'string' && /^[a-z0-9 -]+$/.test(classe) ? ' ' + classe : '';
    return '<svg class="ds-ico' + extra + '" aria-hidden="true" focusable="false"><use href="/ds/icones.svg#i-' + nome + '"/></svg>';
  };
})();
