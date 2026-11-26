const dgHtmlFull_cerebro = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_cerebro = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_cerebro = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);
const dgFragFull_cerebro = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : dgPhraseFull_cerebro(fonte,valores).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

const dgTexto_cerebro = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
// cerebro.js — o raio-X do cérebro (aba Status) e a aba "Como funciona".
//
// O RAIO-X (01/10/2026): "eu conseguir ver todos os arquivos que ele está
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
    const quem = autor.voceFoiOUltimo ? dgTextFull_cerebro("a última mudança foi sua") : (QUEM[autor.quem] || '');
    let corpo;
    if (Array.isArray(c.destaques) && c.destaques.length) {
      corpo = c.destaques.map((d) => `<div class="cb-secao">
          <div class="cb-secao-titulo">${esc(d.titulo)}</div>
          ${d.vazia ? dgHtmlFull_cerebro(`<div class="cb-secao-vazia"><!--dg-i18n:948b9d5c52c4-->nada anotado aqui ainda<!--/dg-i18n--></div>`)
            : `<div class="md-leitura compacto">${md(d.markdown)}</div>${d.cortado ? dgHtmlFull_cerebro(`<div class="cb-mais"><!--dg-i18n:a35e9c30fbda-->continua no arquivo<!--/dg-i18n--></div>`) : ''}`}
        </div>`).join('');
      if ((c.faltamSecoesNovas || []).length) {
        corpo += dgHtmlFull_cerebro(`<div class="cb-nota" data-dg-i18n-title="e06dbd6b53bf" title="Estas seções estão chegando com uma atualização do plugin. Quando ele começar a escrevê-las, elas aparecem aqui sozinhas.">
          ${dgFragFull_cerebro("Ainda não existe nesta memória: {v0}.",{v0:(c.faltamSecoesNovas.join(', '))})}</div>`);
      }
    } else {
      corpo = `<div class="md-leitura compacto">${md(c.previa || '')}</div>${c.cortado ? dgHtmlFull_cerebro(`<div class="cb-mais"><!--dg-i18n:a35e9c30fbda-->continua no arquivo<!--/dg-i18n--></div>`) : ''}`;
    }
    const grande = Array.isArray(c.destaques) ? ' grande' : '';
    return `<article class="cb-cartao${grande}" data-i="${i}" tabindex="0" role="button"
        aria-label="${esc(dgPhraseFull_cerebro("Abrir {v0}",{v0:(c.titulo)}))}">
      <header class="cb-topo">
        <h3 class="cb-titulo" title="${esc(c.explica)}">${esc(c.titulo)}</h3>
        <span class="cb-meta" title="${esc([autor.frase, c.atualizadoEm ? `Última mudança: ${new Date(c.atualizadoEm).toLocaleString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'))}` : ''].filter(Boolean).join('\n'))}">
          ${esc(haQuanto(c.atualizadoEm))}${quem ? ` · ${esc(quem)}` : ''}</span>
      </header>
      <div class="cb-corpo">${corpo}</div>
      <footer class="cb-pe"><code>${esc(c.path)}</code><span>${dgFragFull_cerebro(c.editavel ? dgTextFull_cerebro("abrir e editar") : 'abrir')} ${dsIcone('arrow-right')}</span></footer>
    </article>`;
  }

  /** O raio-X da aba Status. */
  async function carregarRaioX(el, aoMudar) {
    if (!el) return null;
    const r = await API.cerebro();
    if (!r.ok) {
      el.innerHTML = `<div class="vazio-util">Não consegui ler a memória dele: ${rl((r.corpo && r.corpo.error) || dgTextFull_cerebro("sem resposta"))}. `
        + `${rl((r.corpo && r.corpo.howToFix) || '')}</div>`;
      return null;
    }
    const cartoes = r.corpo.cartoes || [];
    if (!cartoes.length) {
      el.innerHTML = dgHtmlFull_cerebro(`<div class="vazio-util"><!--dg-i18n:e6467df4ad38-->Ele ainda não escreveu memória nenhuma. Os arquivos aparecem aqui<!--/dg-i18n--> `)
        + dgHtmlFull_cerebro(`<!--dg-i18n:c3a7b2dcdad4-->depois da primeira conversa e da primeira reflexão da noite.<!--/dg-i18n--></div>`);
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
    el.innerHTML = dgHtmlFull_cerebro(`<div class="vazio-util"><!--dg-i18n:1221935e6f6e-->Juntando os números dele...<!--/dg-i18n--></div>`);
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
      ? camadas.map((c) => `<li title="${esc(c.explica)}"><span>${esc(c.titulo)}</span><b>${c.arquivos ? `${esc(bytes(c.bytes))}${c.arquivos > 1 ? dgPhraseFull_cerebro(" em {v0} arquivos",{v0:(c.arquivos)}) : ''}` : 'vazia'}</b></li>`).join('')
      : dgHtmlFull_cerebro(`<li><span><!--dg-i18n:e482fdf7b093-->não consegui ler<!--/dg-i18n--></span></li>`);

    const resumo = ops.ok ? ops.corpo.resumo || {} : null;
    const opsTexto = resumo
      ? (resumo.total ? dgPhraseFull_cerebro("{v0} de {v1} verdes",{v0:(resumo.verdes),v1:(resumo.total)}) : dgTextFull_cerebro("nenhuma ainda"))
      : dgTextFull_cerebro("não consegui ler");
    const opsCor = !resumo ? 'sem' : (resumo.estado === 'ok' ? 'ok' : (resumo.estado === 'atencao' ? 'atencao' : 'sem'));

    const rotinas = rot.ok ? (rot.corpo.rotinas || []) : null;
    const rotTexto = rotinas == null ? dgTextFull_cerebro("não consegui ler") : (rotinas.length ? `${rotinas.length} ${rotinas.length === 1 ? 'rotina' : 'rotinas'}` : dgTextFull_cerebro("nenhuma ainda"));

    el.innerHTML = dgHtmlFull_cerebro(`
      <div class="mapa-caixa" data-dg-i18n-title="e4cfb4b94fe9" title="A sessão é a conversa contínua em que ele pensa e lembra do que foi dito. É ela que responde você.">
        <div class="mapa-rot"><!--dg-i18n:e6f5e060790e-->Sessão<!--/dg-i18n--></div>
        <div class="mapa-num ${esc(sessao.cor)}">${esc(sessao.texto)}</div>
        <div class="mapa-pe">${esc(sessao.pe)}</div>
      </div>
      <div class="mapa-caixa larga" data-dg-i18n-title="af441a61037e" title="Cada camada é uma pasta ou arquivo de texto. O tamanho é o do arquivo no disco, medido agora.">
        <div class="mapa-rot"><!--dg-i18n:e8e9bb41eb23-->Memória, por camada<!--/dg-i18n--></div>
        <ul class="mapa-camadas">${memoria}</ul>
      </div>
      <div class="mapa-caixa" data-dg-i18n-title="1e58c86a2376" title="As rotinas automáticas que mantêm ele de pé, lembrando e de olho nos custos. Verde é a última execução que deu certo.">
        <div class="mapa-rot"><!--dg-i18n:bca18b5f3f5d-->Operações do sistema<!--/dg-i18n--></div>
        <div class="mapa-num ${esc(opsCor)}">${esc(opsTexto)}</div>
        <div class="mapa-pe"><a href="#" class="link-aba" data-ir-para="operations"><!--dg-i18n:e29be789bd8a-->ver Operações<!--/dg-i18n--></a></div>
      </div>
      <div class="mapa-caixa" title="As rotinas que você pediu a ele, como 'todo sábado às 9h me manda o resumo'.">
        <div class="mapa-rot"><!--dg-i18n:48ed414d2368-->Rotinas que você pediu<!--/dg-i18n--></div>
        <div class="mapa-num">${esc(rotTexto)}</div>
        <div class="mapa-pe"><a href="#" class="link-aba" data-ir-para="status"><!--dg-i18n:55f624d23ca9-->ver no Status<!--/dg-i18n--></a></div>
      </div>`);
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
      doc.innerHTML = `<div class="vazio-util">Não consegui abrir o texto: ${rl((r.corpo && r.corpo.error) || dgTextFull_cerebro("sem resposta"))}.</div>`;
      return;
    }
    if (r.corpo.ausente) {
      doc.innerHTML = `<div class="vazio-util">${esc(r.corpo.mensagem)}</div>`;
      return;
    }
    doc.innerHTML = `<div class="md-leitura">${md(desdobrar(r.corpo.markdown))}</div>`
      + dgHtmlFull_cerebro(`<p class="como-origem">${dgFragFull_cerebro("Texto do {v0}, atualizado {v1}.",{v0:(r.corpo.origem),v1:(haQuanto(r.corpo.atualizadoEm))})}</p>`);
  }

  window.DGCerebro = { carregarRaioX, carregarComoFunciona, carregarMapa };
})();
