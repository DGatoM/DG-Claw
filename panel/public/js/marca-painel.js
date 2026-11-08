'use strict';
/* marca-painel.js: o nome da marca (white label) no painel.
   O painel é servido na mesma origem do DG Claw Web, que publica o nome em /manifest.webmanifest. Lê de lá e troca
   o texto dos elementos marcados com data-marca-nome e o título da aba. Sem o Web por perto (painel solto), a rota
   não existe, o nome fica "DG Claw" e nada é trocado. */
(function () {
  const PADRAO = 'DG Claw';
  function aplicar(nome) {
    if (nome === PADRAO) return;
    document.title = document.title.split(PADRAO).join(nome);
    document.querySelectorAll('[data-marca-nome]').forEach((el) => { el.textContent = nome; });
  }
  fetch('/manifest.webmanifest', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) { console.info('marca-painel: o nome da marca não veio do Web (HTTP ' + r.status + '); o painel segue com o nome padrão, ' + PADRAO + '.'); return null; }
      return r.json();
    })
    .then((m) => {
      const nome = m && typeof m.name === 'string' ? m.name.trim() : '';
      if (!nome) return;
      if (nome.length > 60 || /[<>\r\n]/.test(nome)) {
        console.warn('marca-painel: o nome recebido do Web foi recusado (tem mais de 60 caracteres, "<", ">" ou quebra de linha). Confira "nome" no marca.json.');
        return;
      }
      aplicar(nome);
    })
    .catch((e) => console.warn('marca-painel: não consegui ler o nome da marca em /manifest.webmanifest (' + (e && e.message) + '). O painel segue com o nome padrão, ' + PADRAO + '.'));
})();
