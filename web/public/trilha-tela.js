'use strict';
const dgUiText_trilha_tela_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
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
    return 'rodou ' + itens.length + ' comandos' + (erros ? ' (' + erros + dgUiText_trilha_tela_js(" com erro)") : '');
  }

  /** Há quanto tempo a mensagem espera, em palavras ("há 3 min"). Vazio quando é pouco ou não se sabe. */
  function esperaFila(desdeMs, agoraMs) {
    if (typeof desdeMs !== 'number' || typeof agoraMs !== 'number') return '';
    const seg = Math.floor((agoraMs - desdeMs) / 1000);
    if (seg < 60) return '';
    const min = Math.floor(seg / 60);
    return min < 60 ? dgUiText_trilha_tela_js("há ") + min + ' min' : dgUiText_trilha_tela_js("há ") + Math.floor(min / 60) + ' h';
  }

  /** Por que a mensagem está na fila, na frase que o balão mostra. Com `desdeMs` e `agoraMs`, diz há quanto tempo. */
  function textoFila(motivo, estaEsperandoPermissao, desdeMs, agoraMs) {
    if (motivo !== 'permissao' && motivo !== 'resposta' && motivo !== 'pergunta') return '';
    const espera = esperaFila(desdeMs, agoraMs);
    const quando = espera ? ' ' + espera : '';
    if (motivo === 'pergunta') return 'na fila' + quando + dgUiText_trilha_tela_js(": o agente fez uma pergunta e espera a resposta dela");
    // se o agente passou a esperar permissão depois do envio, essa é a razão de verdade
    if (estaEsperandoPermissao || motivo === 'permissao') return 'na fila' + quando + dgUiText_trilha_tela_js(": o agente está esperando a sua permissão");
    return 'na fila' + quando + dgUiText_trilha_tela_js(": o agente ainda está respondendo a anterior");
  }

  /** O que o cartão de permissão descreve: "Bash: <comando>" ou um aviso de que o detalhe não veio. */
  function descricaoPedido(p) {
    if (!p || !p.titulo) return dgUiText_trilha_tela_js("O agente não informou o que quer fazer. Abra o terminal dele para ver.");
    return p.ferramenta + ': ' + (p.comando || p.titulo);
  }

  return { agrupa, rotuloGrupo, textoFila, esperaFila, descricaoPedido, ehTrilha };
});
