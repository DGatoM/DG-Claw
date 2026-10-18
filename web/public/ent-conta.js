'use strict';
/* ent-conta.js: com o multiusuário ligado, põe "Minha conta" (e "Usuários", para o TI) no menu do lado, acima do Sair.
   Sem multiusuário o servidor responde só { ok, usuario } em /api/v1/eu e este arquivo não faz nada. */
(function () {
  const sair = document.getElementById('formSair');
  if (!sair || document.getElementById('entContaLinks')) return;
  fetch('/api/v1/eu', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((eu) => {
    if (!eu || !eu.papel) return;
    const a = (href, ico, nome) => '<a class="ml-tab" href="' + href + '"><span class="ml-ico" aria-hidden="true">' + ico + '</span>' + nome + '</a>';
    const caixa = document.createElement('div');
    caixa.id = 'entContaLinks';
    caixa.innerHTML = a('/conta', '☺', 'Minha conta') + (eu.papel === 'ti' ? a('/usuarios', '☷', 'Usuários') : '');
    sair.parentNode.insertBefore(caixa, sair);
  }).catch(() => { /* sem o atalho no menu; as telas continuam em /conta e /usuarios */ });
})();
