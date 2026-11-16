'use strict';
/* marca.js: o nome da marca (white label) para o JS das telas. O servidor escreve o nome em
   <meta name="marca-nome">; sem o meta, cai em "DG Claw". */
(function () {
  const m = document.querySelector('meta[name="marca-nome"]');
  const nome = (m && m.getAttribute('content')) || 'DG Claw';
  const lg = document.querySelector('meta[name="marca-logo-tem-nome"]');
  const logoTemNome = !!lg && lg.getAttribute('content') === 'sim';
  document.documentElement.setAttribute('data-logo-nome', logoTemNome ? 'sim' : 'nao');
  window.dsMarca = Object.freeze({ nome: nome, logoTemNome: logoTemNome });
})();
