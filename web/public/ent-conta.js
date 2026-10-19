'use strict';
/* ent-conta.js: com o multiusuário ligado, põe "Minha conta" ("Usuários" e "Auditoria", para o TI) no menu do lado, acima do Sair.
   Sem multiusuário o servidor responde só { ok, usuario } em /api/v1/eu e este arquivo não faz nada. */
(function () {
  const sair = document.getElementById('formSair');
  if (!sair || document.getElementById('entContaLinks')) return;
  // Admin desligado (bloco J): o TI cria agentes pelo formulário, então o menu ganha o atalho. Com o Admin ligado, nada muda.
  fetch('/api/v1/novo-agente/estado', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((e) => {
    if (!e || !e.ativo || !e.ti || document.getElementById('entNovoAgente')) return;
    const caixa = document.createElement('div');
    caixa.id = 'entNovoAgente';
    caixa.innerHTML = '<a class="ml-tab" href="/novo-agente"><span class="ml-ico" aria-hidden="true">+</span>Novo agente</a>';
    sair.parentNode.insertBefore(caixa, sair);
  }).catch(() => { /* sem o atalho; a tela continua em /novo-agente */ });
  fetch('/api/v1/eu', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((eu) => {
    if (!eu || !eu.papel) return;
    const a = (href, ico, nome) => '<a class="ml-tab" href="' + href + '"><span class="ml-ico" aria-hidden="true">' + ico + '</span>' + nome + '</a>';
    const caixa = document.createElement('div');
    caixa.id = 'entContaLinks';
    caixa.innerHTML = a('/conta', '☺', 'Minha conta') + (eu.papel === 'ti' ? a('/usuarios', '☷', 'Usuários') + a('/auditoria', '☰', 'Auditoria') : '');
    sair.parentNode.insertBefore(caixa, sair);
  }).catch(() => { /* sem o atalho no menu; as telas continuam em /conta e /usuarios */ });
})();
