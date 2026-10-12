// markdown.js — O renderizador de markdown do painel. UM SÓ, para os dois lados.
//
// POR QUE ELE SAIU DE DENTRO DO apps.js (26/08/2026). A página de compartilhar
// um roteiro com o cliente precisa exatamente do mesmo renderizador, só que no
// servidor (Node) em vez do navegador. Com uma cópia em cada lado, um dia a
// tabela do catálogo ganha uma correção numa e não na outra, e o link que sai
// para fora da casa vira o que renderiza pior. É justamente o link que a pessoa
// de fora vê.
//
// O código aqui é o MESMO, movido sem reescrever: o que estava certo continua
// certo, e o que estiver errado está errado nos dois lugares ao mesmo tempo,
// que é o único jeito de consertar uma vez só.
//
// Funciona nos dois mundos: `window.DGMarkdown` no navegador, `module.exports`
// no Node. Sem dependência, sem build.

(function (raiz) {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Marcas dentro da linha. O código e o link são GUARDADOS antes das outras
   * marcas (trocados por um marcador) e devolvidos no fim: assim um `**` dentro
   * de um comando continua sendo dois asteriscos, e um sublinhado num endereço
   * não vira itálico. Recebe texto JÁ ESCAPADO.
   *
   * URL SOLTA (12/10/2026, opção `autolink`). Os pensamentos do agente trazem
   * endereço colado no meio da frase. Com a opção ligada ele vira link, guardado
   * pelo mesmo mecanismo. Como o texto já foi escapado, o endereço termina em
   * espaço ou em `&lt; &gt; &quot; &#39;`: assim uma aspa nunca fecha o href. A
   * pontuação que fecha a frase fica de fora do link. Só http e https.
   */
  function marcasDaLinha(t, autolink) {
    const guardados = [];
    const guarda = (html) => { guardados.push(html); return `\u0000${guardados.length - 1}\u0000`; };
    let s = t
      .replace(/`([^`]+)`/g, (_, c) => guarda(`<code>${c}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, txt, url) => guarda(`<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`));
    if (autolink) {
      s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s\u0000])+/g, (bruto) => {
        let url = bruto;
        let resto = '';
        while (url.length && /[).,;:!?*_~\]]$/.test(url) && !url.endsWith('&amp;')) {
          resto = url.slice(-1) + resto;
          url = url.slice(0, -1);
        }
        if (!/^https?:\/\/[^/\s]+/.test(url)) return bruto;
        return guarda(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + resto;
      });
    }
    s = s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => guardados[Number(i)]);
  }

  /**
   * Markdown do que o agente escreve: título, negrito, itálico, riscado, código
   * (na linha e em bloco), link, lista (com níveis, numerada e de tarefa),
   * citação, linha divisória e tabela.
   *
   * SEGURANÇA, A REGRA QUE NÃO PODE QUEBRAR: o texto vem de arquivo do disco, que
   * o agente (ou quem invadiu o agente) pode reescrever, e este renderizador serve
   * a página que sai para o cliente de fora. Então TUDO é escapado ANTES de virar
   * HTML, e só depois as marcas viram tag. Nenhuma tag do texto original sobrevive:
   * `<script>` chega aqui como `&lt;script&gt;` e nunca volta a ser tag. O link só
   * aceita http e https, então `javascript:` não vira link de jeito nenhum.
   *
   * O QUE MUDOU EM 01/10/2026 (frente B do painel). A aba Status passou a mostrar a
   * memória dele renderizada, e o renderizador antigo achatava lista com nível em
   * lista de um nível só, mostrava `- [ ]` cru, aplicava negrito DENTRO de código
   * (um `**` num comando virava negrito) e não conhecia `~~riscado~~`, que é como o
   * agente marca tarefa feita na memória de trabalho. A saída continua com as
   * mesmas classes de antes (`app-code`, `app-tabela`), para a aba Apps e a página
   * de compartilhar não mudarem de cara.
   */
  function md(texto, opts) {
    const autolink = !!(opts && opts.autolink);
    // \u0000 é o marcador interno dos trechos guardados (ver inline). Um \u0000
    // vindo do arquivo seria confundido com ele, então sai antes de tudo.
    const linhas = esc(String(texto == null ? '' : texto).replace(/\u0000/g, '').replace(/\r\n?/g, '\n')).split('\n');
    const saida = [];
    let emCodigo = false;
    // Linhas de tabela vão sendo guardadas aqui e só viram <table> quando o bloco
    // termina, porque só aí dá pra saber se a primeira linha era cabeçalho.
    let tabela = null;
    // Citação de várias linhas vira UM bloco, e não uma caixa por linha.
    let citacao = null;
    // A pilha das listas abertas, uma por nível: { recuo, tipo: 'ul'|'ol' }.
    const pilha = [];

    const inline = (t) => marcasDaLinha(t, autolink);

    // A linha `|---|---|` que separa o cabeçalho do corpo. Só traço, dois-pontos
    // e pipe: nunca é conteúdo, e é justamente ela que aparecia crua na tela.
    const separadora = (l) => /^\s*\|[\s:|-]*\|\s*$/.test(l) && l.includes('-');
    const ehTabela = (l) => /^\s*\|.*\|\s*$/.test(l.trim()) && l.trim().length > 2;
    const celulas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

    /**
     * Fecha o bloco de tabela acumulado.
     *
     * POR QUE ISTO EXISTE. O catálogo de assets que o agente escreve é uma tabela
     * em markdown. Sem este trecho ela chegava na tela com os pipes crus e com a
     * linha `|---|---|---|` no meio do texto, ilegível justamente no arquivo mais
     * consultado da aba. Rola na horizontal dentro da própria caixa (a regra é o
     * conteúdo largo rolar sozinho, nunca a página).
     */
    const fecharTabela = () => {
      if (!tabela || !tabela.length) { tabela = null; return; }
      const bloco = tabela;
      tabela = null;
      const temCabecalho = bloco.length >= 2 && separadora(bloco[1]);
      const cabeca = temCabecalho
        ? `<thead><tr>${celulas(bloco[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
        : '';
      const linhasCorpo = (temCabecalho ? bloco.slice(2) : bloco).filter((l) => !separadora(l));
      const corpo = `<tbody>${linhasCorpo
        .map((l) => `<tr>${celulas(l).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      saida.push(`<div class="app-tabela-rolagem"><table class="app-tabela">${cabeca}${corpo}</table></div>`);
    };

    const fecharCitacao = () => {
      if (!citacao) return;
      saida.push(`<blockquote>${citacao.map(inline).join('<br>')}</blockquote>`);
      citacao = null;
    };

    // Fecha as listas até sobrar só quem tem recuo MENOR que `recuo` (-1 fecha todas).
    const fecharListas = (recuo) => {
      while (pilha.length && pilha[pilha.length - 1].recuo > recuo) {
        saida.push(`</li></${pilha.pop().tipo}>`);
      }
    };

    // Recuo em espaços, com tab valendo quatro: é o que os editores fazem.
    const recuoDe = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

    for (const linha of linhas) {
      if (linha.trim().startsWith('```')) {
        fecharTabela(); fecharCitacao();
        if (emCodigo) { saida.push('</pre>'); emCodigo = false; }
        else { fecharListas(-1); saida.push('<pre class="app-code">'); emCodigo = true; }
        continue;
      }
      if (emCodigo) { saida.push(linha); continue; }

      if (ehTabela(linha)) {
        fecharListas(-1); fecharCitacao();
        if (!tabela) tabela = [];
        tabela.push(linha);
        continue;
      }
      fecharTabela();

      // Citação: no texto já escapado, o ">" do começo chegou como "&gt;".
      const cit = linha.match(/^\s*&gt;\s?(.*)$/);
      if (cit) {
        fecharListas(-1);
        (citacao = citacao || []).push(cit[1]);
        continue;
      }
      fecharCitacao();

      const h = linha.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        fecharListas(-1);
        const n = Math.min(h[1].length + 2, 6);
        saida.push(`<h${n}>${inline(h[2])}</h${n}>`);
        continue;
      }

      // Linha divisória: três ou mais traços, asteriscos ou sublinhados sozinhos.
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(linha)) {
        fecharListas(-1);
        saida.push('<hr>');
        continue;
      }

      const li = linha.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const recuo = recuoDe(linha);
        const tipo = /\d/.test(li[2]) ? 'ol' : 'ul';
        fecharListas(recuo);
        const topo = pilha[pilha.length - 1];
        if (topo && topo.recuo === recuo && topo.tipo !== tipo) {
          // Mesmo nível, outro tipo de lista: fecha uma e abre a outra.
          saida.push(`</li></${pilha.pop().tipo}>`);
        }
        const atual = pilha[pilha.length - 1];
        if (!atual || recuo > atual.recuo) {
          const inicio = tipo === 'ol' && parseInt(li[2], 10) !== 1 ? ` start="${parseInt(li[2], 10)}"` : '';
          saida.push(`<${tipo}${inicio}>`);
          pilha.push({ recuo, tipo });
        } else {
          saida.push('</li>');
        }
        // Lista de tarefa: "- [ ] fazer" e "- [x] feito". A caixa é só de leitura:
        // marcar aqui sem gravar no arquivo seria mentir que a tarefa mudou.
        const tarefa = li[3].match(/^\[([ xX])\]\s+(.*)$/);
        if (tarefa) {
          const feita = tarefa[1] !== ' ';
          saida.push(`<li class="md-tarefa${feita ? ' feita' : ''}"><input type="checkbox" disabled${feita ? ' checked' : ''} aria-label="${feita ? 'feito' : 'a fazer'}"> ${inline(tarefa[2])}`);
        } else {
          saida.push(`<li>${inline(li[3])}`);
        }
        continue;
      }

      if (!linha.trim()) { fecharListas(-1); saida.push(''); continue; }

      // Linha recuada logo abaixo de um item é continuação dele, e não parágrafo
      // solto: sem isto a segunda linha de um item longo escapava da lista.
      if (pilha.length && recuoDe(linha) > pilha[pilha.length - 1].recuo) {
        saida.push(`<br>${inline(linha.trim())}`);
        continue;
      }
      fecharListas(-1);
      saida.push(`<p>${inline(linha)}</p>`);
    }
    fecharTabela();
    fecharCitacao();
    fecharListas(-1);
    if (emCodigo) saida.push('</pre>');
    return saida.join('\n');
  }

  // ─── Texto livre dos campos do painel (12/10/2026) ──────────────────────────
  // O Danilo abriu a aba Status e viu o pensamento do agente como um bloco cru:
  // asteriscos e crases à mostra, endereço enorme, "- " grudado. Estes helpers
  // são o jeito ÚNICO de mostrar texto livre curto (pensamento, pendência,
  // recado, motivo). A segurança é a de md(): escapa tudo antes de criar tag.

  /**
   * Separa um título em CAIXA ALTA do começo ("IR ATE A ORIGEM (11/10). Duas
   * vezes eu..."). Pelo menos 3 letras maiúsculas seguidas, 7 a 140 caracteres,
   * termina em ". ", ": " ou "! ". Uma frase normal que começa com sigla ("API
   * caiu às 3h. Voltou.") não casa, porque tem minúscula antes do ponto.
   * Sem título: { titulo: '', corpo: texto }.
   */
  function tituloCaixaAlta(texto) {
    const t = String(texto == null ? '' : texto).trim();
    const m = t.match(/^((?=[^a-z]*[A-ZÀ-ÖØ-Þ]{3})[A-ZÀ-ÖØ-Þ0-9][A-ZÀ-ÖØ-Þ0-9 ,;:'"\/&+\u2013\u2014-]{6,}?(?:\s*\([^)]*\))?)\s*[.:!]\s+(\S[\s\S]*)$/);
    if (m && m[1].trim().length >= 7 && m[1].trim().length <= 140) return { titulo: m[1].trim(), corpo: m[2].trim() };
    return { titulo: '', corpo: t };
  }

  /** Texto livre curto, em bloco: parágrafos, listas, negrito, código, link e URL solta. */
  function rico(texto, opts) {
    const bruto = String(texto == null ? '' : texto).trim();
    if (!bruto) return '';
    let titulo = '';
    let corpo = bruto;
    if (opts && opts.titulo) ({ titulo, corpo } = tituloCaixaAlta(bruto));
    const cab = titulo ? `<div class="rt-titulo">${marcasDaLinha(esc(titulo), true)}</div>` : '';
    return `<div class="rt">${cab}${md(corpo, { autolink: true })}</div>`;
  }

  /** Só as marcas de dentro da linha, sem <p>: célula, rótulo e item curto. */
  function ricoLinha(texto) {
    if (texto == null || String(texto).trim() === '') return '';
    return marcasDaLinha(esc(String(texto).replace(/\u0000/g, '').replace(/\s*\n\s*/g, ' ').trim()), true);
  }

  /**
   * Corta texto CRU em até n caracteres, na última fronteira de palavra, sem
   * deixar marca aberta: um `**` ou uma crase sem par viraria asterisco solto na
   * tela. Retorna { texto, cortou }.
   */
  function cortar(texto, n) {
    const t = String(texto == null ? '' : texto);
    if (t.length <= n) return { texto: t, cortou: false };
    let p = t.slice(0, n);
    const nextoVazio = /\s/.test(t[n]);
    if (!nextoVazio) {
      const i = p.search(/\s\S*$/);
      if (i > n * 0.4) p = p.slice(0, i);
    }
    p = p.replace(/\s+$/, '');
    // Link markdown cortado no meio: "[texto](http://..." ou "[texto".
    p = p.replace(/\[[^\]]*\]\([^)]*$/, '').replace(/\[[^\]]*$/, '').replace(/\s+$/, '');
    for (const marca of ['**', '~~', '`']) {
      const partes = p.split(marca);
      if (partes.length % 2 === 0) {
        const k = p.lastIndexOf(marca);
        p = (p.slice(0, k) + p.slice(k + marca.length)).replace(/\s+$/, '');
      }
    }
    p = p.replace(/[\s,;:(\-]+$/, '');
    return { texto: p + '…', cortou: true };
  }

  const api = { md, esc, rico, ricoLinha, cortar, tituloCaixaAlta };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.DGMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
