// cerebro.js — o raio-X do cérebro (aba Status) e a aba "Como funciona".
//
// O RAIO-X (Danilo, 01/10/2026): "eu conseguir ver todos os arquivos que ele está
// usando ali referentes à atividade do usuário: pesquisa, tarefas, preferências...
// sempre renderizado em markdown correto, bonito, e o usuário pode clicar e editar
// à mão". Um cartão por arquivo vivo da memória, com quando mudou e quem escreve, e
// a prévia já renderizada. Clicar abre o arquivo inteiro no js/leitor.js, que é o
// mesmo leitor (e editor) da aba Memória.
//
// O "COMO FUNCIONA" renderiza o docs/RADIOGRAFIA.md do plugin e põe em cima um
// mapa VIVO, com os números de verdade deste agente: o tamanho de cada camada de
// memória, quantas operações do sistema existem e quantas estão verdes, quantas
// rotinas o dono pediu, e se a sessão está de pé. É o texto que explica a máquina,
// com a máquina dele ao lado.

(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Texto livre (12/10/2026): marcas viram negrito/código/link pelo renderizador único; sem ele, escape.
  const rl = (t) => (window.DGMarkdown && window.DGMarkdown.ricoLinha ? window.DGMarkdown.ricoLinha(t) : esc(t));
  const md = (t) => (window.DGMarkdown ? window.DGMarkdown.md(t) : esc(t));
  const haQuanto = (iso) => (window.DGLeitor ? window.DGLeitor.haQuanto(iso) : '');

  function bytes(n) {
    if (n == null) return '--';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',')} KB`;
    return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  }

  const QUEM = { agente: 'escreve: ele', rotina: 'escreve: uma rotina', dono: 'escreve: você' };

  function cartaoHtml(c, i) {
    const autor = c.autoria || {};
    const quem = autor.voceFoiOUltimo ? 'a última mudança foi sua' : (QUEM[autor.quem] || '');
    let corpo;
    if (Array.isArray(c.destaques) && c.destaques.length) {
      corpo = c.destaques.map((d) => `<div class="cb-secao">
          <div class="cb-secao-titulo">${esc(d.titulo)}</div>
          ${d.vazia ? '<div class="cb-secao-vazia">nada anotado aqui ainda</div>'
            : `<div class="md-leitura compacto">${md(d.markdown)}</div>${d.cortado ? '<div class="cb-mais">continua no arquivo</div>' : ''}`}
        </div>`).join('');
      if ((c.faltamSecoesNovas || []).length) {
        corpo += `<div class="cb-nota" title="Estas seções estão chegando com uma atualização do plugin. Quando ele começar a escrevê-las, elas aparecem aqui sozinhas.">
          Ainda não existe nesta memória: ${esc(c.faltamSecoesNovas.join(', '))}.</div>`;
      }
    } else {
      corpo = `<div class="md-leitura compacto">${md(c.previa || '')}</div>${c.cortado ? '<div class="cb-mais">continua no arquivo</div>' : ''}`;
    }
    const grande = Array.isArray(c.destaques) ? ' grande' : '';
    return `<article class="cb-cartao${grande}" data-i="${i}" tabindex="0" role="button"
        aria-label="${esc(`Abrir ${c.titulo}`)}">
      <header class="cb-topo">
        <h3 class="cb-titulo" title="${esc(c.explica)}">${esc(c.titulo)}</h3>
        <span class="cb-meta" title="${esc([autor.frase, c.atualizadoEm ? `Última mudança: ${new Date(c.atualizadoEm).toLocaleString('pt-BR')}` : ''].filter(Boolean).join('\n'))}">
          ${esc(haQuanto(c.atualizadoEm))}${quem ? ` · ${esc(quem)}` : ''}</span>
      </header>
      <div class="cb-corpo">${corpo}</div>
      <footer class="cb-pe"><code>${esc(c.path)}</code><span>${c.editavel ? 'abrir e editar' : 'abrir'} →</span></footer>
    </article>`;
  }

  /** O raio-X da aba Status. */
  async function carregarRaioX(el, aoMudar) {
    if (!el) return null;
    const r = await API.cerebro();
    if (!r.ok) {
      el.innerHTML = `<div class="vazio-util">Não consegui ler a memória dele: ${rl((r.corpo && r.corpo.error) || 'sem resposta')}. `
        + `${rl((r.corpo && r.corpo.howToFix) || '')}</div>`;
      return null;
    }
    const cartoes = r.corpo.cartoes || [];
    if (!cartoes.length) {
      el.innerHTML = '<div class="vazio-util">Ele ainda não escreveu memória nenhuma. Os arquivos aparecem aqui '
        + 'depois da primeira conversa e da primeira reflexão da noite.</div>';
      return r.corpo;
    }
    el.innerHTML = cartoes.map(cartaoHtml).join('');
    el.querySelectorAll('.cb-cartao').forEach((card) => {
      const c = cartoes[Number(card.dataset.i)];
      const abrir = (ev) => {
        // Link dentro da prévia abre o link, não o arquivo.
        if (ev && ev.target && ev.target.closest('a')) return;
        window.DGLeitor.abrir(c.path, { titulo: c.titulo, aoSalvar: () => carregarRaioX(el, aoMudar) });
      };
      card.addEventListener('click', abrir);
      card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); } });
    });
    if (typeof aoMudar === 'function') aoMudar(r.corpo);
    return r.corpo;
  }

  // ─── Como funciona ─────────────────────────────────────────────────────────

  const ESTADO_SESSAO = {
    ativo: { cor: 'ok', texto: 'de pé' },
    atencao: { cor: 'atencao', texto: 'pede atenção' },
    inativo: { cor: 'falha', texto: 'fora do ar' },
    indeterminado: { cor: 'sem', texto: 'não consegui ver' },
  };

  /** O mapa vivo: cinco caixinhas com os números de verdade deste agente. */
  async function carregarMapa(el) {
    if (!el) return;
    el.innerHTML = '<div class="vazio-util">Juntando os números dele...</div>';
    const [cer, ops, rot, sau] = await Promise.all([API.cerebro(), API.operacoes(false), API.rotinasUsuario(), API.saude()]);

    // A sessão: com o diagnóstico novo do /api/saude, se existir; senão, o viva/caiu de sempre.
    let sessao = { cor: 'sem', texto: 'não consegui ver', pe: '' };
    if (sau.ok && sau.corpo) {
      const d = sau.corpo.diagnostico;
      if (d && ESTADO_SESSAO[d.estado]) sessao = { ...ESTADO_SESSAO[d.estado], pe: d.frase || '' };
      else if (sau.corpo.viva === true) sessao = { cor: 'ok', texto: 'de pé', pe: sau.corpo.frase || '' };
      else if (sau.corpo.viva === false) sessao = { cor: 'falha', texto: 'fora do ar', pe: sau.corpo.frase || '' };
    }

    const camadas = cer.ok ? (cer.corpo.camadas || []) : [];
    const memoria = camadas.length
      ? camadas.map((c) => `<li title="${esc(c.explica)}"><span>${esc(c.titulo)}</span><b>${c.arquivos ? `${esc(bytes(c.bytes))}${c.arquivos > 1 ? ` em ${c.arquivos} arquivos` : ''}` : 'vazia'}</b></li>`).join('')
      : '<li><span>não consegui ler</span></li>';

    const resumo = ops.ok ? ops.corpo.resumo || {} : null;
    const opsTexto = resumo
      ? (resumo.total ? `${resumo.verdes} de ${resumo.total} verdes` : 'nenhuma ainda')
      : 'não consegui ler';
    const opsCor = !resumo ? 'sem' : (resumo.estado === 'ok' ? 'ok' : (resumo.estado === 'atencao' ? 'atencao' : 'sem'));

    const rotinas = rot.ok ? (rot.corpo.rotinas || []) : null;
    const rotTexto = rotinas == null ? 'não consegui ler' : (rotinas.length ? `${rotinas.length} ${rotinas.length === 1 ? 'rotina' : 'rotinas'}` : 'nenhuma ainda');

    el.innerHTML = `
      <div class="mapa-caixa" title="A sessão é a conversa contínua em que ele pensa e lembra do que foi dito. É ela que responde você.">
        <div class="mapa-rot">Sessão</div>
        <div class="mapa-num ${esc(sessao.cor)}">${esc(sessao.texto)}</div>
        <div class="mapa-pe">${esc(sessao.pe)}</div>
      </div>
      <div class="mapa-caixa larga" title="Cada camada é uma pasta ou arquivo de texto. O tamanho é o do arquivo no disco, medido agora.">
        <div class="mapa-rot">Memória, por camada</div>
        <ul class="mapa-camadas">${memoria}</ul>
      </div>
      <div class="mapa-caixa" title="As rotinas automáticas que mantêm ele de pé, lembrando e de olho nos custos. Verde é a última execução que deu certo.">
        <div class="mapa-rot">Operações do sistema</div>
        <div class="mapa-num ${esc(opsCor)}">${esc(opsTexto)}</div>
        <div class="mapa-pe"><a href="#" class="link-aba" data-ir-para="operations">ver Operações</a></div>
      </div>
      <div class="mapa-caixa" title="As rotinas que você pediu a ele, como 'todo sábado às 9h me manda o resumo'.">
        <div class="mapa-rot">Rotinas que você pediu</div>
        <div class="mapa-num">${esc(rotTexto)}</div>
        <div class="mapa-pe"><a href="#" class="link-aba" data-ir-para="status">ver no Status</a></div>
      </div>`;
  }

  /**
   * Junta as linhas de um parágrafo que o texto fonte quebrou à mão (em ~95 colunas).
   * O renderizador trata cada linha como um parágrafo, e o "Como o seu agente funciona"
   * aparecia picado no meio das frases (vistoria de 08/10/2026). Só junta prosa com
   * prosa: título, lista, citação, tabela e bloco de código ficam como estão.
   */
  function desdobrar(texto) {
    const especial = /^\s*(#|[-*+]\s|\d+[.)]\s|>|\||```)/;
    const saida = [];
    let emCodigo = false;
    let anteriorProsa = false;
    for (const l of String(texto || '').split('\n')) {
      if (/^\s*```/.test(l)) { emCodigo = !emCodigo; saida.push(l); anteriorProsa = false; continue; }
      const prosa = !emCodigo && l.trim() !== '' && !especial.test(l) && !/^\s{2,}\S/.test(l);
      if (prosa && anteriorProsa) saida[saida.length - 1] += ' ' + l.trim();
      else saida.push(l);
      anteriorProsa = prosa;
    }
    return saida.join('\n');
  }

  async function carregarComoFunciona() {
    const mapa = document.getElementById('como-mapa');
    const doc = document.getElementById('como-doc');
    const [, r] = await Promise.all([carregarMapa(mapa), API.radiografia()]);
    if (!doc) return;
    if (!r.ok) {
      doc.innerHTML = `<div class="vazio-util">Não consegui abrir o texto: ${rl((r.corpo && r.corpo.error) || 'sem resposta')}.</div>`;
      return;
    }
    if (r.corpo.ausente) {
      doc.innerHTML = `<div class="vazio-util">${esc(r.corpo.mensagem)}</div>`;
      return;
    }
    doc.innerHTML = `<div class="md-leitura">${md(desdobrar(r.corpo.markdown))}</div>`
      + `<p class="como-origem">Texto do ${esc(r.corpo.origem)}, atualizado ${esc(haQuanto(r.corpo.atualizadoEm))}.</p>`;
  }

  window.DGCerebro = { carregarRaioX, carregarComoFunciona, carregarMapa };
})();
