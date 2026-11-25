'use strict';
const dgTexto_primeiro_acesso = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
/* primeiro-acesso.js: lê o token do fragmento (#token), tira ele da barra de endereço,
   manda senha + confirmação ao servidor e, se der certo, entra no chat do Admin. */
(function () {
  const caixa = document.getElementById('erro');
  const form = document.getElementById('form');
  const botao = document.getElementById('salvar');
  const mostra = (txt) => { caixa.textContent = txt; caixa.hidden = false; };

  const token = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* sem problema */ }

  fetch('/api/login-estado', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (j && j.usuario) document.getElementById('quem').textContent = dgTexto_primeiro_acesso('Usuário: ') + j.usuario;
    if (j && j.sem_senha === false) mostra(dgTexto_primeiro_acesso('Este painel já tem senha. Se o link foi usado, entre pelo login normal. Se não foi você, rode no servidor: sudo dgclaw senha'));
  }).catch(() => { /* a tela continua valendo sem o nome do usuário */ });

  if (!token) {
    mostra(dgTexto_primeiro_acesso('Faltou o link completo. Abra o endereço inteiro que apareceu no fim da instalação (ele termina com # e uma sequência de letras e números). Se perdeu, rode no servidor: sudo dgclaw primeiro-acesso'));
    form.querySelectorAll('input,button').forEach((e) => { e.disabled = true; });
    return;
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    caixa.hidden = true;
    const senha = document.getElementById('senha').value;
    const confirmacao = document.getElementById('confirmacao').value;
    botao.disabled = true;
    fetch('/api/primeiro-acesso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, senha, confirmacao }),
    }).then((r) => r.json().catch(() => ({ ok: false, erro: 'O servidor respondeu algo que não entendi (código ' + r.status + ').' })))
      .then((j) => {
        if (j && j.ok) { location.replace(j.destino || '/a/admin'); return; }
        mostra((j && j.erro) || dgTexto_primeiro_acesso('Não foi possível salvar a senha. Tente de novo.'));
        botao.disabled = false;
      })
      .catch(() => { mostra(dgTexto_primeiro_acesso('Não consegui falar com o servidor. Confira a conexão e tente de novo.')); botao.disabled = false; });
  });
})();
