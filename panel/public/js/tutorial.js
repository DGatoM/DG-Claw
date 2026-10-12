// tutorial.js — a visita guiada, com holofote, que toda tela deste painel tem.
//
// POR QUE ELE SAIU DE DENTRO DA ABA APPS. O motor nasceu lá, e quando a aba Pasta
// precisou de tutorial havia duas saídas: copiar as 120 linhas, ou tirar o motor
// do lugar. Copiar é o começo de duas visitas guiadas que um dia se comportam
// diferente (o Esc fecha numa e não na outra, o balão trava na borda numa e não na
// outra) sem ninguém ter decidido isso. Aqui o motor é um só e cada aba entrega só
// o que é dela: a LISTA DE PASSOS.
//
// AS CLASSES DE CSS CONTINUAM COM O PREFIXO `app-tut-`, e o estilo delas continua
// em `css/apps.css`, porque foi ali que nasceram. Renomear agora mexeria em dois
// arquivos para não mudar um pixel na tela.
//
// O CONTRATO DE UM PASSO, e ele não é decorativo:
//   { chave, alvo, titulo, corpo, porque }
// `alvo` é um seletor de CSS, ou `null` para o passo que fala da tela inteira.
// `porque` é obrigatório por regra do repo: todo passo responde o que é, como a
// conta é feita e POR QUE aquilo está na tela. Passo sem o "por que" vira legenda,
// e legenda a pessoa já tinha no tooltip.
//
// PASSO CUJO ALVO NÃO ESTÁ NA TELA NAQUELE MOMENTO É PULADO, nunca apontado para o
// vazio: metade dos passos fala de coisa que só aparece em certo estado (o selo de
// "lido da pasta", a lista de arquivos de uma pasta vazia).

(function () {
  let estado = null;

  function fechar() {
    if (!estado) return;
    document.removeEventListener('keydown', estado.tecla);
    window.removeEventListener('resize', estado.reposicionar);
    window.removeEventListener('scroll', estado.reposicionar, true);
    estado.fundo.remove();
    estado = null;
  }

  function abrir(todosOsPassos, comecarEm) {
    fechar();

    // Só entram os passos cujo alvo está de fato na tela agora. "Na tela" quer dizer
    // existir E estar visível: um alvo dentro de uma vista escondida (a vista
    // Registros da aba Operações, por exemplo) tem tamanho zero, e o holofote
    // apontaria para um canto vazio da página.
    const visivel = (el) => !!el && el.getClientRects().length > 0;
    const passos = (todosOsPassos || []).filter((p) => p && (!p.alvo || visivel(document.querySelector(p.alvo))));
    if (!passos.length) return;

    const fundo = document.createElement('div');
    fundo.className = 'app-tut-fundo';
    fundo.innerHTML = `
      <div class="app-tut-holofote" hidden></div>
      <div class="app-tut-balao" role="dialog" aria-modal="true" aria-labelledby="app-tut-titulo">
        <button type="button" class="app-tut-x" aria-label="Fechar o tutorial">&times;</button>
        <h4 id="app-tut-titulo"></h4>
        <p class="app-tut-corpo"></p>
        <p class="app-tut-porque"><strong>Por que está aqui:</strong> <span></span></p>
        <div class="app-tut-rodape">
          <span class="app-tut-conta"></span>
          <span class="app-tut-botoes">
            <button type="button" class="app-tut-voltar">Voltar</button>
            <button type="button" class="app-tut-proximo">Próximo</button>
          </span>
        </div>
      </div>`;
    document.body.appendChild(fundo);

    const holofote = fundo.querySelector('.app-tut-holofote');
    const balao = fundo.querySelector('.app-tut-balao');
    // `comecarEm` vem como chave ('cartao') quando o clique foi num "?" de seção,
    // e como número só de dentro daqui. Chave, porque a lista de passos encolhe
    // quando um alvo não está na tela e um índice fixo apontaria para outro passo.
    let i = 0;
    if (typeof comecarEm === 'string') {
      const achou = passos.findIndex((p) => p.chave === comecarEm);
      if (achou >= 0) i = achou;
    } else if (typeof comecarEm === 'number') {
      i = Math.min(Math.max(comecarEm, 0), passos.length - 1);
    }

    function posicionar() {
      const passo = passos[i];
      const el = passo.alvo ? document.querySelector(passo.alvo) : null;
      if (!el) {
        holofote.hidden = true;
        fundo.classList.add('sem-alvo');
        balao.style.top = '50%';
        balao.style.left = '50%';
        balao.style.transform = 'translate(-50%, -50%)';
        return;
      }
      fundo.classList.remove('sem-alvo');
      const r = el.getBoundingClientRect();
      const folga = 6;
      holofote.hidden = false;
      holofote.style.top = `${r.top - folga}px`;
      holofote.style.left = `${r.left - folga}px`;
      holofote.style.width = `${r.width + folga * 2}px`;
      holofote.style.height = `${r.height + folga * 2}px`;

      // O balão cabe embaixo? Se não couber, vai para cima. Preso na janela dos
      // dois lados, para nunca sair pela borda em tela estreita.
      balao.style.transform = 'none';
      const alturaBalao = balao.offsetHeight || 190;
      const larguraBalao = balao.offsetWidth || 320;
      const cabeEmbaixo = r.bottom + alturaBalao + 18 < window.innerHeight;
      const topo = cabeEmbaixo ? r.bottom + 12 : Math.max(10, r.top - alturaBalao - 12);
      let esquerda = r.left + r.width / 2 - larguraBalao / 2;
      esquerda = Math.max(10, Math.min(esquerda, window.innerWidth - larguraBalao - 10));
      balao.style.top = `${topo}px`;
      balao.style.left = `${esquerda}px`;
    }

    function desenhar() {
      const passo = passos[i];
      const el = passo.alvo ? document.querySelector(passo.alvo) : null;
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      balao.querySelector('#app-tut-titulo').textContent = passo.titulo;
      balao.querySelector('.app-tut-corpo').textContent = passo.corpo;
      balao.querySelector('.app-tut-porque span').textContent = passo.porque;
      balao.querySelector('.app-tut-conta').textContent = `${i + 1} de ${passos.length}`;
      balao.querySelector('.app-tut-voltar').disabled = i === 0;
      balao.querySelector('.app-tut-proximo').textContent = i === passos.length - 1 ? 'Entendi' : 'Próximo';
      // Espera o scroll suave assentar antes de medir o alvo.
      posicionar();
      setTimeout(posicionar, 320);
    }

    function ir(passo) {
      if (i + passo >= passos.length) { fechar(); return; }
      i = Math.max(0, i + passo);
      desenhar();
    }

    balao.querySelector('.app-tut-proximo').addEventListener('click', () => ir(1));
    balao.querySelector('.app-tut-voltar').addEventListener('click', () => ir(-1));
    balao.querySelector('.app-tut-x').addEventListener('click', fechar);
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(); });

    const tecla = (ev) => {
      if (ev.key === 'Escape') fechar();
      else if (ev.key === 'ArrowRight') ir(1);
      else if (ev.key === 'ArrowLeft') ir(-1);
    };
    document.addEventListener('keydown', tecla);
    window.addEventListener('resize', posicionar);
    window.addEventListener('scroll', posicionar, true);

    estado = { fundo, tecla, reposicionar: posicionar };
    desenhar();
  }

  window.DGTutorial = { abrir, fechar };
})();
