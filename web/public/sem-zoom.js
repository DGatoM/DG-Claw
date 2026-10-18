'use strict';
/* sem-zoom.js: a página nunca amplia (pinça e toque duplo), no iPhone e no Android.

   O viewport com user-scalable=no não basta no iOS (ele ignora por acessibilidade),
   por isso este arquivo fecha as duas portas que sobram:
   1) gesturestart/gesturechange (pinça no Safari): preventDefault.
   2) toque duplo rápido (dois touchend em menos de 300 ms, no mesmo ponto) em algo
      que não é campo, link nem botão: o segundo é cancelado. Botões, links e campos
      já ficam de fora do zoom pelo touch-action: manipulation do sem-zoom.css, e
      cancelar o toque neles engoliria o segundo clique de quem toca rápido.
   Nada aqui mexe em clique, seleção de texto ou rolagem. Um visor que faz o próprio
   zoom (a foto aberta) se marca com data-zoom-proprio e fica de fora. */
(function () {
  const bloqueia = ev => { ev.preventDefault(); };
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(nome => {
    document.addEventListener(nome, bloqueia, { passive: false });
  });

  const INTERATIVO = 'a,button,input,select,textarea,label,summary,[role=button],[contenteditable],[data-zoom-proprio]';
  let ultimo = { t: 0, x: 0, y: 0 };
  document.addEventListener('touchend', ev => {
    if (ev.touches.length || ev.changedTouches.length !== 1) { ultimo.t = 0; return; }
    const alvo = ev.target && ev.target.closest ? ev.target : null;
    if (alvo && alvo.closest(INTERATIVO)) { ultimo.t = 0; return; }
    const c = ev.changedTouches[0], agora = Date.now();
    const perto = Math.abs(c.clientX - ultimo.x) < 30 && Math.abs(c.clientY - ultimo.y) < 30;
    if (agora - ultimo.t < 300 && perto && ev.cancelable) {
      ev.preventDefault();
      ultimo.t = 0;
      return;
    }
    ultimo = { t: agora, x: c.clientX, y: c.clientY };
  }, { passive: false });
})();
