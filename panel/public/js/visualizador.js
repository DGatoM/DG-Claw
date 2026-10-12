// visualizador.js — a janela que abre por cima da tela para ver UM arquivo.
//
// POR QUE ELE NÃO MORA DENTRO DA ABA APPS, QUE FOI ONDE NASCEU. A aba Pasta
// precisa exatamente da mesma janela: clicar numa imagem e ver a imagem. Com uma
// cópia em cada aba, um dia o vídeo ganha controle de volume numa e não na outra,
// o Esc fecha numa e não na outra, e ninguém decidiu isso. Uma janela só, dois
// chamadores.
//
// O QUE ELE ABRE E O QUE ELE SE RECUSA A FINGIR QUE ABRE:
//   imagem  → <img>
//   vídeo   → <video controls>
//   áudio   → <audio controls>
//   pdf     → <iframe>
//   o resto → a frase que diz que aquele formato não abre no navegador, mais o
//             botão de baixar.
//
// A última linha é a que importa. Um .xlsx dentro de um <iframe> vira uma tela
// cinza sem explicação, e a pessoa fica achando que o painel travou. Dizer "isto
// não abre aqui, baixe" é mais curto e é verdade.
//
// FECHAR TEM TRÊS CAMINHOS: o X, a tecla Esc e o clique no fundo. Quem abriu uma
// imagem em tela cheia por engano não deveria precisar procurar onde clicar.

(function () {
  const BASE = window.DGCLAW_BASE || '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  let estado = null;

  function fechar() {
    if (!estado) return;
    document.removeEventListener('keydown', estado.tecla);
    estado.fundo.remove();
    // O foco volta para o botão que abriu a janela. Sem isto, quem usa teclado
    // fecha a imagem e é devolvido para o começo da página, longe da lista.
    if (estado.voltarFoco && document.contains(estado.voltarFoco)) estado.voltarFoco.focus();
    estado = null;
  }

  /** O miolo da janela, por família de arquivo. */
  function corpo(item) {
    const url = esc(item.url);
    const nome = esc(item.nome);
    if (item.tipo === 'imagem') {
      return `<img class="dgv-midia" src="${url}" alt="${nome}">`;
    }
    if (item.tipo === 'video') {
      return `<video class="dgv-midia" src="${url}" controls playsinline preload="metadata"></video>`;
    }
    if (item.tipo === 'audio') {
      return `<div class="dgv-audio"><audio src="${url}" controls preload="metadata"></audio></div>`;
    }
    if (item.tipo === 'pdf') {
      // O PDF do agente é lido pelo leitor do próprio navegador. Em celular alguns
      // navegadores ignoram o iframe e não desenham nada, e é para isso que o
      // botão de baixar continua ali embaixo em todos os casos.
      return `<iframe class="dgv-pdf" src="${url}" title="${nome}"></iframe>`;
    }
    return `<div class="dgv-sem-previa">
        <strong>Este formato não abre dentro do navegador.</strong>
        <p>Arquivo <code>${esc(item.ext || 'sem extensão')}</code>. Nenhum navegador mostra este tipo de arquivo
           por conta própria, e eu prefiro dizer isso a te deixar olhando para uma janela cinza.
           Baixe o arquivo e abra no programa que já está no seu computador.</p>
      </div>`;
  }

  /**
   * Abre a janela.
   *
   * `item`: { nome, url, tipo, ext, bytes }. A `url` já vem pronta de quem chamou,
   * porque cada aba tem a sua rota: a aba Apps serve o material de um conteúdo, a
   * aba Pasta serve um arquivo qualquer da pasta de trabalho.
   */
  function abrir(item) {
    if (!item || !item.url) return;
    const voltarFoco = document.activeElement;
    fechar();

    const fundo = document.createElement('div');
    fundo.className = 'dgv-fundo';
    fundo.innerHTML = `
      <div class="dgv-janela" role="dialog" aria-modal="true" aria-label="${esc(item.nome)}">
        <header class="dgv-topo">
          <span class="dgv-nome" title="${esc(item.nome)}">${esc(item.nome)}</span>
          <span class="dgv-bytes">${esc(bytes(item.bytes))}</span>
          <a class="dgv-baixar" href="${esc(item.url)}" download="${esc(item.nome)}"
             title="Salva o arquivo no seu computador, do jeito que ele está na pasta do agente.">baixar</a>
          <button type="button" class="dgv-x" aria-label="Fechar" title="Fechar (Esc)">&times;</button>
        </header>
        <div class="dgv-corpo">${corpo(item)}</div>
      </div>`;
    document.body.appendChild(fundo);

    const tecla = (ev) => { if (ev.key === 'Escape') fechar(); };
    document.addEventListener('keydown', tecla);
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(); });
    fundo.querySelector('.dgv-x').addEventListener('click', fechar);
    fundo.querySelector('.dgv-x').focus();

    estado = { fundo, tecla, voltarFoco };
  }

  window.DGVisualizador = { abrir, fechar, BASE };
})();
