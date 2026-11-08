'use strict';
/* manual.js: a tela do Manual (/manual e /manual/<pagina>). Contrato da API em web/docs/MANUAL.md.

   A renderização do markdown é própria e fica fora do DOM (testada em web/test/manual-tela.test.js).
   A conversa (conversa-puro.js) não tem renderizador de markdown que sirva para documento, então não há o que reaproveitar.
   Regra de segurança: todo texto é ESCAPADO antes de virar HTML (HTML cru do markdown aparece como texto), e um link
   só vira <a> se for http/https ou uma página do manual; qualquer outro (javascript:, data:) vira texto; documento do repositório abre no GitHub. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGManual = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const semAcento = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  /** Identificador de título: sem acento, minúsculo, só a-z, 0-9 e hífen. */
  function slug(texto) {
    return semAcento(texto).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'secao';
  }

  const REPO_DOCS = 'https://github.com/DGatoM/DG-Claw/blob/main/';

  /** Decide o que fazer com o destino de um link. Devolve { tipo: 'externo'|'interno'|'ancora'|'texto', href?, ref? }. */
  function destinoLink(bruto) {
    const h = String(bruto || '').trim();
    if (/^https?:\/\//i.test(h)) return { tipo: 'externo', href: h };
    if (h.startsWith('#')) return { tipo: 'ancora', href: '#' + slug(h.slice(1)) };
    if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return { tipo: 'texto', ref: h };
    const mm = /^(?:\.\/)?([A-Za-z0-9-]+)\.md(?:#([^#\s]*))?$/.exec(h);
    if (mm) {
      const nome = mm[1] === 'README' ? '' : mm[1];
      if (nome && !/^[a-z0-9-]+$/.test(nome)) return { tipo: 'texto', ref: h };
      return { tipo: 'interno', href: '/manual' + (nome ? '/' + nome : '') + (mm[2] ? '#' + slug(mm[2]) : '') };
    }
    // Outro documento do repositório: abre no GitHub, porque a tela só serve as páginas do manual.
    const doc = /^(\.\.\/(?:\.\.\/)?)((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md)(#[a-z0-9-]*)?$/.exec(h);
    if (doc && !doc[2].includes('..')) {
      const base = doc[1] === '../' ? 'docs/' : '';
      return { tipo: 'externo', href: REPO_DOCS + base + doc[2] + (doc[3] || '') };
    }
    return { tipo: 'texto', ref: h };
  }

  /** Markdown em linha (código, link, negrito, itálico) para HTML. Tudo escapado. */
  function emLinha(texto, semLinks) {
    const codigos = [];
    let t = String(texto == null ? '' : texto).replace(/\u0001/g, '').replace(/`([^`]+)`/g, (_, c) => {
      codigos.push(c);
      return '\u0001' + (codigos.length - 1) + '\u0001';
    });
    const partes = [];
    if (!semLinks) {
      const rx = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      let ult = 0; let r;
      while ((r = rx.exec(t))) {
        partes.push({ txt: t.slice(ult, r.index) });
        partes.push({ rotulo: r[1], alvo: r[2] });
        ult = r.index + r[0].length;
      }
      partes.push({ txt: t.slice(ult) });
    } else partes.push({ txt: t });
    const estilo = s => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
    let html = partes.map(p => {
      if (p.txt !== undefined) return estilo(p.txt);
      const d = destinoLink(p.alvo);
      const rot = emLinha(p.rotulo, true);
      if (d.tipo === 'externo') return `<a href="${esc(d.href)}" target="_blank" rel="noopener noreferrer">${rot}</a>`;
      if (d.tipo === 'interno' || d.tipo === 'ancora') return `<a href="${esc(d.href)}">${rot}</a>`;
      return `${rot} <span class="mn-ref">(${esc(d.ref)})</span>`;
    }).join('');
    html = html.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${esc(codigos[Number(i)])}</code>`);
    return html;
  }

  const ehLinhaTabela = l => /^\s*\|.*\|\s*$/.test(l);
  const ehSeparadorTabela = l => /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/.test(l);
  const celulas = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const RX_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  /** Markdown do manual para HTML. Devolve { html, titulo } (titulo = primeiro H1). */
  function renderiza(md) {
    const linhas = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    const usados = new Map();
    let titulo = null;
    const saida = [];
    let i = 0;
    const idUnico = (t) => {
      const base = slug(t); const n = usados.get(base) || 0;
      usados.set(base, n + 1);
      return n ? `${base}-${n}` : base;
    };

    while (i < linhas.length) {
      const l = linhas[i];
      if (!l.trim()) { i++; continue; }

      const cerca = /^\s*(```|~~~)/.exec(l);
      if (cerca) {
        const buf = []; i++;
        while (i < linhas.length && !linhas[i].trim().startsWith(cerca[1])) buf.push(linhas[i++]);
        i++;
        saida.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (h) {
        const n = h[1].length;
        if (n === 1 && titulo === null) titulo = h[2];
        const id = idUnico(h[2].replace(/[`*]/g, ''));
        saida.push(`<h${n} id="${esc(id)}">${emLinha(h[2])}</h${n}>`);
        i++; continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { saida.push('<hr>'); i++; continue; }

      if (ehLinhaTabela(l) && i + 1 < linhas.length && ehSeparadorTabela(linhas[i + 1])) {
        const cab = celulas(l); i += 2;
        const corpo = [];
        while (i < linhas.length && ehLinhaTabela(linhas[i])) corpo.push(celulas(linhas[i++]));
        saida.push('<div class="mn-tabela"><table><thead><tr>' + cab.map(c => `<th>${emLinha(c)}</th>`).join('') + '</tr></thead><tbody>' +
          corpo.map(r => '<tr>' + cab.map((_, k) => `<td>${emLinha(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < linhas.length && /^\s*>/.test(linhas[i])) buf.push(linhas[i++].replace(/^\s*>\s?/, ''));
        saida.push(`<blockquote>${renderiza(buf.join('\n')).html}</blockquote>`);
        continue;
      }

      if (RX_ITEM.test(l)) {
        const itens = [];
        while (i < linhas.length) {
          const mi = RX_ITEM.exec(linhas[i]);
          if (mi) { itens.push({ nivel: mi[1].replace(/\t/g, '    ').length, ord: /\d/.test(mi[2]), texto: mi[3] }); i++; continue; }
          if (itens.length && linhas[i].trim() && /^\s{2,}/.test(linhas[i])) { itens[itens.length - 1].texto += ' ' + linhas[i].trim(); i++; continue; }
          break;
        }
        saida.push(htmlLista(itens));
        continue;
      }

      const par = [];
      while (i < linhas.length && linhas[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(linhas[i]) && !RX_ITEM.test(linhas[i])
        && !(ehLinhaTabela(linhas[i]) && i + 1 < linhas.length && ehSeparadorTabela(linhas[i + 1]))) par.push(linhas[i++].trim());
      saida.push(`<p>${emLinha(par.join(' '))}</p>`);
    }
    return { html: saida.join('\n'), titulo };
  }

  /** Lista (com sublistas pela indentação) a partir de itens planos { nivel, ord, texto }. */
  function htmlLista(itens) {
    let k = 0;
    function bloco(nivel) {
      const ord = itens[k].ord;
      let h = ord ? '<ol>' : '<ul>';
      while (k < itens.length && itens[k].nivel >= nivel) {
        h += `<li>${emLinha(itens[k].texto)}`;
        k++;
        if (k < itens.length && itens[k].nivel > nivel) h += bloco(itens[k].nivel);
        h += '</li>';
      }
      return h + (ord ? '</ol>' : '</ul>');
    }
    let h = '';
    while (k < itens.length) h += bloco(itens[k].nivel);
    return h;
  }

  /** Filtra a lista de páginas pelo texto (título ou nome, sem acento nem maiúscula). */
  function filtraPaginas(paginas, busca) {
    const q = semAcento(busca || '').trim();
    if (!q) return paginas;
    return paginas.filter(p => semAcento(p.titulo + ' ' + p.nome).includes(q));
  }

  /** Qual página o endereço pede: '' (índice) ou o nome. */
  function paginaDoCaminho(caminho) {
    const mm = /^\/manual\/([^/]+)\/?$/.exec(caminho || '');
    return mm ? mm[1] : '';
  }

  const puras = { esc, slug, destinoLink, emLinha, renderiza, filtraPaginas, paginaDoCaminho };
  if (!raiz.document) return puras;

  /* ── navegador ── */
  const $ = id => document.getElementById(id);
  const E = { paginas: [], atual: '' };

  async function pega(url) {
    let r;
    try { r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json, text/markdown' } }); } catch (e) {
      throw new Error(`Não consegui falar com o servidor (${e.message}). Confira a conexão e recarregue a página.`);
    }
    const tipo = r.headers.get('content-type') || '';
    if (!r.ok) {
      let motivo = '';
      if (tipo.includes('json')) { try { motivo = (await r.json()).erro || ''; } catch (_) { /* corpo ilegível: usa o status */ } }
      throw new Error(motivo || `O servidor respondeu ${r.status} em ${url}.`);
    }
    return tipo.includes('json') ? r.json() : r.text();
  }

  function mostraErro(msg) {
    $('mnDoc').innerHTML = `<div class="mn-erro"><p><strong>Não consegui abrir esta página do manual.</strong></p><p>${esc(msg)}</p>` +
      '<p><a href="/manual">Voltar ao índice do manual</a></p></div>';
  }

  function pintaLista() {
    const f = filtraPaginas(E.paginas, $('mnBusca').value);
    $('mnPaginas').innerHTML = `<li><a href="/manual"${E.atual === '' ? ' aria-current="page"' : ''}>Índice</a></li>` +
      (f.length ? f.map(p => `<li><a href="/manual/${esc(p.nome)}"${p.nome === E.atual ? ' aria-current="page"' : ''}>${esc(p.titulo)}</a></li>`).join('')
        : '<li class="mn-vazio">Nenhuma página com esse texto.</li>');
  }

  async function abre() {
    E.atual = paginaDoCaminho(location.pathname);
    document.documentElement.classList.add('mn');
    $('mnLista').open = raiz.matchMedia('(min-width:900px)').matches || E.atual === '';
    try {
      const lista = await pega('/api/v1/manual');
      E.paginas = lista.paginas || [];
      pintaLista();
      const md = await pega(`/api/v1/manual/${E.atual || 'README'}.md`);
      const r = renderiza(md);
      $('mnDoc').innerHTML = (E.atual ? '<a class="mn-volta" href="/manual">Índice do manual</a>' : '') + r.html;
      document.title = (r.titulo ? r.titulo + ' - ' : '') + 'Manual - DG Claw';
      const alvo = location.hash && $(decodeURIComponent(location.hash.slice(1)));
      if (alvo) alvo.scrollIntoView();
    } catch (e) { mostraErro(e.message); }
  }

  raiz.DGManualTutorial = () => {
    if (!raiz.DGTour) { mostraErro('A visita guiada não carregou (tour.js). Recarregue a página.'); return; }
    $('mnLista').open = true;
    raiz.DGTour.inicia({ passos: [
      { alvo: '#mnLista', titulo: 'A lista de páginas', oque: 'Todas as páginas do manual do DG Claw, com um campo de busca.',
        como: 'Toque numa página para abrir. Digite no campo para filtrar a lista pelo título; a busca olha só os títulos das páginas.',
        porque: 'O manual é dividido por assunto para você achar só o que precisa, sem ler tudo.' },
      { alvo: '#mnDoc', titulo: 'O texto da página', oque: 'O conteúdo da página escolhida, igual ao que o Admin e os agentes consultam.',
        como: 'Os links entre páginas abrem aqui mesmo. Tabelas largas rolam dentro delas, sem mexer na página.',
        porque: 'Você e os agentes leem a mesma fonte, então a resposta não muda de lugar para lugar.' },
    ] });
  };

  function boot() {
    $('mnBusca').addEventListener('input', pintaLista);
    abre();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  return puras;
});
