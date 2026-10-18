'use strict';
/* rolagem.js: a parte pura da regra de rolagem da conversa (sem DOM, com teste em web/test/rolagem.test.js).

   Regra: depois de qualquer mudança de altura (mensagem nova, faixa de atividade, cartão de login,
   imagem que carregou, teclado), a conversa só acompanha o fim se a pessoa JÁ estava no fim antes da
   mudança. Quem rolou para ler fica exatamente onde estava, preso a um elemento âncora. O Safari do
   iPhone não tem overflow-anchor, então a âncora é feita à mão. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGRolagem = m;
})(this, function () {
  const TOLERANCIA = 80;

  /** A pessoa está no fim (ou a menos de `tol` px dele)? */
  function estaNoFim(scrollTop, scrollHeight, clientHeight, tol) {
    return scrollHeight - scrollTop - clientHeight < (tol == null ? TOLERANCIA : tol);
  }

  /**
   * Nova scrollTop depois de uma mudança de altura.
   *  estavaNoFim: estado medido ANTES da mudança.
   *  scrollTopAgora: posição atual (o navegador pode ter encolhido ao tirar conteúdo).
   *  alvoAncora: scrollTop que devolve a âncora ao lugar em que a pessoa a via, ou null.
   * Nunca devolve negativo nem além do fim possível.
   */
  function novaPosicao(o) {
    const max = Math.max(0, o.scrollHeight - o.clientHeight);
    if (o.estavaNoFim) return max;
    if (typeof o.alvoAncora === 'number' && isFinite(o.alvoAncora)) return Math.min(max, Math.max(0, o.alvoAncora));
    return Math.min(max, Math.max(0, o.scrollTopAgora));
  }

  /**
   * Índice do primeiro item cujo fundo está abaixo do topo da tela (o primeiro visível), por busca
   * binária. `fundoDe(i)` devolve offsetTop+offsetHeight do item i, crescente com i. -1 se não há itens
   * ou se todos estão acima.
   */
  function primeiroVisivel(n, fundoDe, scrollTop) {
    let lo = 0, hi = n - 1, r = -1;
    while (lo <= hi) {
      const meio = (lo + hi) >> 1;
      if (fundoDe(meio) > scrollTop) { r = meio; hi = meio - 1; } else lo = meio + 1;
    }
    return r;
  }

  /** O scrollTop saiu do lugar desde a última captura? Falso para o eco do scroll que nós mesmos fizemos. */
  function moveuDeVerdade(topCapturado, topAgora) {
    return Math.abs(topAgora - topCapturado) > 0.5;
  }

  return { TOLERANCIA, estaNoFim, moveuDeVerdade, novaPosicao, primeiroVisivel };
});
