'use strict';
/* trilha-tela.js: a parte pura da trilha de comandos, do cartão de permissão e do aviso de fila.

   Sem DOM e sem rede: agrupa os itens da trilha, monta os rótulos e os textos. O desenho e as
   chamadas ficam em conversa.js; aqui fica o que se testa com node:test (web/test/trilha-tela.test.js). */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGTrilha = m;
})(this, function () {
  const ehTrilha = m => !!m && m.origin === 'trilha' && !!m.trilha;

  /** Junta os itens da trilha que vêm em sequência (sem mensagem no meio). Devolve [{ trilha:[...] } | { msg }]. */
  function agrupa(lista) {
    const saida = [];
    for (const m of lista) {
      if (ehTrilha(m)) {
        const ultimo = saida[saida.length - 1];
        if (ultimo && ultimo.trilha) ultimo.trilha.push(m);
        else saida.push({ trilha: [m] });
      } else saida.push({ msg: m });
    }
    return saida;
  }

  /** Texto da linha fechada de um grupo. */
  function rotuloGrupo(itens) {
    if (itens.length === 1) return 'rodou: ' + itens[0].trilha.titulo;
    const erros = itens.filter(i => i.trilha.erro).length;
    return 'rodou ' + itens.length + ' comandos' + (erros ? ' (' + erros + ' com erro)' : '');
  }

  /** Por que a mensagem está na fila, na frase que o balão mostra. */
  function textoFila(motivo, estaEsperandoPermissao) {
    if (motivo !== 'permissao' && motivo !== 'resposta' && motivo !== 'pergunta') return '';
    if (motivo === 'pergunta') return 'na fila: o agente fez uma pergunta e espera a resposta dela';
    // se o agente passou a esperar permissão depois do envio, essa é a razão de verdade
    if (estaEsperandoPermissao || motivo === 'permissao') return 'na fila: o agente está esperando a sua permissão';
    return 'na fila: o agente ainda está respondendo a anterior';
  }

  /** O que o cartão de permissão descreve: "Bash: <comando>" ou um aviso de que o detalhe não veio. */
  function descricaoPedido(p) {
    if (!p || !p.titulo) return 'O agente não informou o que quer fazer. Abra o terminal dele para ver.';
    return p.ferramenta + ': ' + (p.comando || p.titulo);
  }

  return { agrupa, rotuloGrupo, textoFila, descricaoPedido, ehTrilha };
});
