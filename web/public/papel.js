'use strict';
/* papel.js: quem está usando o app, dono ou colaborador. Carregue no <head>, antes dos outros scripts.

   Lê o cookie dgclaw_papel (o servidor o põe no login). Serve SÓ para a tela esconder o que não é do
   colaborador e não disparar chamadas que o servidor vai negar: quem barra de verdade é o servidor
   (web/lib/escopo.js). Cookie apagado ou forjado não abre nada. */
(function (raiz) {
  let papel = 'dono';
  try {
    const m = /(?:^|;\s*)dgclaw_papel=([a-z]+)/.exec(raiz.document ? raiz.document.cookie : '');
    if (m && m[1] === 'colaborador') papel = 'colaborador';
  } catch (e) { console.warn('papel: não consegui ler o cookie dgclaw_papel; trato como dono (o servidor barra o que não for dele):', e.message); }
  raiz.DGPapel = { papel, colaborador: papel === 'colaborador' };
  if (raiz.DGPapel.colaborador && raiz.document) raiz.document.documentElement.classList.add('papel-colab');
})(typeof window !== 'undefined' ? window : globalThis);
