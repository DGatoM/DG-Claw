'use strict';
/* roteiro.js: a tela do "modo roteiro" (docs/MODO-ROTEIRO.md). O roteiro fica parado num painel e a
   conversa serve só para pedir os ajustes.

   Módulo autocontido, JS puro, sem build. Este arquivo é COPIADO sem alteração para outro app
   (DG Telegram, Flask), por isso ele não usa nada global da conversa: tudo que precisa do app vem da
   ponte passada a DGRoteiro.iniciar({ agente, enviar(texto, aoEntregar), seletores:{composer, topo, raiz}, api? }).

   As partes puras (dividir em blocos, ler o markdown, diff, prefixo) não tocam no DOM e têm teste em
   web/test/roteiro-tela.test.js. O resto só roda no navegador e só monta DOM quando o modo abre. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGRoteiro = m;
})(this, function (raiz) {
  const BASE = '/api/v1/roteiros';
  const SONDA_ABERTO_MS = 2500, SONDA_FECHADO_MS = 8000, TIMEOUT_MS = 15000;
  const REALCE_MS = 10000, PEDIDO_DESISTE_MS = 10 * 60 * 1000;
  const LIMITE_LCS = 4e6;
  const ALTURA_FAIXA = 44, ALTURA_BARRA = 48;

  /* ───────────── partes puras ───────────── */

  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  function haQuando(iso, agora) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const s = Math.max(0, Math.round(((agora || Date.now()) - t) / 1000));
    if (s < 45) return 'agora';
    const min = Math.round(s / 60);
    if (min < 60) return 'há ' + min + ' min';
    const h = Math.round(min / 60);
    if (h < 24) return 'há ' + h + ' h';
    const d = Math.round(h / 24);
    return 'há ' + d + (d === 1 ? ' dia' : ' dias');
  }

  function dataCurta(iso) {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' às ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* Blocos separados por linha em branco, com a posição de cada um no texto (para trocar um bloco só). */
  function dividirBlocos(texto) {
    const t = String(texto == null ? '' : texto).replace(/\r\n?/g, '\n');
    const blocos = [];
    let ini = -1, fim = 0, pos = 0;
    for (const linha of t.split('\n')) {
      const fimLinha = pos + linha.length;
      if (linha.trim() === '') {
        if (ini >= 0) { blocos.push({ md: t.slice(ini, fim), ini, fim }); ini = -1; }
      } else {
        if (ini < 0) ini = pos;
        fim = fimLinha;
      }
      pos = fimLinha + 1;
    }
    if (ini >= 0) blocos.push({ md: t.slice(ini, fim), ini, fim });
    return blocos;
  }

  /* Texto corrido: **negrito** e *itálico*. Nada de HTML: tudo vira nó de texto. */
  function inline(txt) {
    const nos = [];
    const rx = /\*\*(.+?)\*\*|\*(?![\s*])(.+?)(?<![\s*])\*/gs;
    let ult = 0, mt;
    const texto = (v) => {
      v.split('\n').forEach((parte, i) => {
        if (i > 0) nos.push({ t: 'br' });
        if (parte) nos.push({ t: 'txt', v: parte });
      });
    };
    while ((mt = rx.exec(txt))) {
      if (mt.index > ult) texto(txt.slice(ult, mt.index));
      if (mt[1] !== undefined) nos.push({ t: 'b', filhos: inline(mt[1]) });
      else nos.push({ t: 'i', filhos: inline(mt[2]) });
      ult = mt.index + mt[0].length;
    }
    if (ult < txt.length) texto(txt.slice(ult));
    return nos;
  }

  const RX_H = /^(#{1,6})\s+(.*)$/, RX_HR = /^(-{3,}|\*{3,}|_{3,})$/, RX_UL = /^[-*]\s+(.*)$/, RX_OL = /^\d+[.)]\s+(.*)$/;

  function parseBloco(md) {
    const linhas = md.split('\n');
    const nos = [];
    let i = 0;
    const especial = tl => RX_H.test(tl) || RX_HR.test(tl) || /^>/.test(tl) || RX_UL.test(tl) || RX_OL.test(tl);
    while (i < linhas.length) {
      const tl = linhas[i].trim();
      let m;
      if ((m = RX_H.exec(tl))) { nos.push({ t: 'h', n: m[1].length, filhos: inline(m[2]) }); i++; }
      else if (RX_HR.test(tl)) { nos.push({ t: 'hr' }); i++; }
      else if (/^>/.test(tl)) {
        const ls = [];
        while (i < linhas.length && /^>/.test(linhas[i].trim())) { ls.push(linhas[i].trim().replace(/^>\s?/, '')); i++; }
        nos.push({ t: 'cit', filhos: inline(ls.join('\n')) });
      } else if (RX_UL.test(tl) || RX_OL.test(tl)) {
        const ordenada = RX_OL.test(tl), rx = ordenada ? RX_OL : RX_UL, itens = [];
        while (i < linhas.length && (m = rx.exec(linhas[i].trim()))) { itens.push(inline(m[1])); i++; }
        nos.push({ t: ordenada ? 'ol' : 'ul', itens });
      } else {
        const ls = [];
        while (i < linhas.length && !especial(linhas[i].trim())) { ls.push(linhas[i].trim()); i++; }
        nos.push({ t: 'p', filhos: inline(ls.join('\n')) });
      }
    }
    return nos;
  }

  function mdParse(texto) {
    return dividirBlocos(texto).map(b => ({ ini: b.ini, fim: b.fim, md: b.md, nos: parseBloco(b.md) }));
  }

  /* ── diff ── */

  function mescla(segs) {
    const fora = [];
    for (const s of segs) {
      if (!s.texto) continue;
      const u = fora[fora.length - 1];
      if (u && u.tipo === s.tipo) u.texto += s.texto; else fora.push({ tipo: s.tipo, texto: s.texto });
    }
    return fora;
  }

  /* Tabela LCS de sufixos: t[i][j] = tamanho da maior subsequência comum de a[i:] e b[j:]. */
  function tabelaLcs(a, b) {
    const n = a.length, m = b.length, w = m + 1;
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    return { t, w };
  }

  /* Diff por palavra de um bloco alterado. Textos enormes caem para "saiu tudo, entrou tudo". */
  function diffPalavras(antes, depois) {
    const a = antes.match(/\s+|\S+/g) || [], b = depois.match(/\s+|\S+/g) || [];
    if (a.length * b.length > LIMITE_LCS) {
      return { porBloco: true, segmentos: mescla([{ tipo: 'saiu', texto: antes }, { tipo: 'entrou', texto: depois }]) };
    }
    const { t, w } = tabelaLcs(a, b);
    const segs = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { segs.push({ tipo: 'igual', texto: a[i] }); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { segs.push({ tipo: 'saiu', texto: a[i] }); i++; }
      else { segs.push({ tipo: 'entrou', texto: b[j] }); j++; }
    }
    while (i < a.length) segs.push({ tipo: 'saiu', texto: a[i++] });
    while (j < b.length) segs.push({ tipo: 'entrou', texto: b[j++] });
    return { porBloco: false, segmentos: mescla(segs) };
  }

  function similaridade(x, y) {
    const a = new Set(norm(x).split(/\s+/).filter(Boolean)), b = new Set(norm(y).split(/\s+/).filter(Boolean));
    if (!a.size || !b.size) return 0;
    let c = 0;
    for (const p of a) if (b.has(p)) c++;
    return c / Math.max(a.size, b.size);
  }

  /* Diff por bloco; dentro do bloco alterado, por palavra. Devolve entradas na ordem do texto novo:
     { tipo:'igual', texto } | { tipo:'mudou', antes, depois, segmentos, porBloco } | { tipo:'novo', texto } | { tipo:'saiu', texto }. */
  function diffTexto(antes, depois) {
    const A = dividirBlocos(antes).map(b => b.md.trim()), B = dividirBlocos(depois).map(b => b.md.trim());
    const n = A.length, m = B.length;
    const pares = [];                       // [i, j] de blocos iguais, em ordem
    if (n * m > LIMITE_LCS) {
      for (let k = 0; k < Math.min(n, m); k++) if (A[k] === B[k]) pares.push([k, k]);
    } else {
      const { t, w } = tabelaLcs(A, B);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { pares.push([i, j]); i++; j++; }
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
        else j++;
      }
    }
    pares.push([n, m]);                     // sentinela: fecha o último intervalo
    const saida = [];
    let pi = 0, pj = 0;
    for (const [i, j] of pares) {
      const saidos = A.slice(pi, i), entrados = B.slice(pj, j);
      const usados = new Set();
      let piso = 0;
      entrados.forEach(novo => {
        let melhor = -1, nota = 0.3;
        for (let r = piso; r < saidos.length; r++) {
          if (usados.has(r)) continue;
          const s = similaridade(saidos[r], novo);
          if (s >= nota) { nota = s; melhor = r; }
        }
        if (melhor < 0) { saida.push({ tipo: 'novo', texto: novo }); return; }
        for (let r = piso; r < melhor; r++) if (!usados.has(r)) { usados.add(r); saida.push({ tipo: 'saiu', texto: saidos[r] }); }
        usados.add(melhor);
        piso = melhor + 1;
        const d = diffPalavras(saidos[melhor], novo);
        saida.push({ tipo: 'mudou', antes: saidos[melhor], depois: novo, segmentos: d.segmentos, porBloco: d.porBloco });
      });
      saidos.forEach((s, r) => { if (!usados.has(r)) saida.push({ tipo: 'saiu', texto: s }); });
      if (i < n) saida.push({ tipo: 'igual', texto: A[i] });
      pi = i + 1; pj = j + 1;
    }
    return saida;
  }

  /* Do diff para o realce do texto novo: marca (null | 'mudou' | 'novo') por bloco do texto novo, e quantos
     trechos saíram antes de cada posição (a chave n = depois do último bloco). */
  function marcasDe(entradas) {
    const marcas = [], saiuAntes = {};
    let pend = 0;
    for (const e of entradas) {
      if (e.tipo === 'saiu') { pend++; continue; }
      if (pend) { saiuAntes[marcas.length] = pend; pend = 0; }
      marcas.push(e.tipo === 'igual' ? null : e.tipo);
    }
    if (pend) saiuAntes[marcas.length] = pend;
    return { marcas, saiuAntes };
  }

  const ROTULO_ESTADO = { em_ajuste: 'Em ajuste', aguardando_aprovacao: 'Aguardando aprovação', aprovado: 'Aprovado', arquivado: 'Arquivado' };

  function filtrarLista(itens, q) {
    const busca = norm(q).trim();
    return (itens || []).filter(r => !busca || norm(r.titulo).includes(busca))
      .sort((a, b) => String(b.atualizado_em || '').localeCompare(String(a.atualizado_em || '')));
  }

  function limpaParaFaixa(texto) {
    return String(texto || '').replace(/^\s*\[roteiro [^\]]*\]\s*/i, '').replace(/[*#>_`]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ───────────── estado ───────────── */

  const S = {
    ponte: null, agente: '', nomeAgente: '', id: null, aberto: false,
    rot: null, texto: '', carregando: false, erroCarga: null,
    vista: 'leitura', vdados: null,
    edicao: null, conflito: null, ta: null,
    realce: null, realceFim: false, faixaNova: null, timerRealce: null,
    pedido: null, minhas: new Set(), avisoFalho: null, erroAcao: null,
    faixaTexto: '', faixaTipo: '', recolhido: false,
    lista: null, buscaLista: '', verMaisAprovados: false,
    falhas: 0, timerSonda: null, timerAberto: null,
    el: null, restos: null, obs: null, api: null,
  };

  function ativo() { return !!(S.aberto && S.id); }

  /* Com o modo aberto, o que a pessoa digita vai com o prefixo. Comando de barra (/algo) não recebe. */
  function prefixar(texto) {
    const t = String(texto == null ? '' : texto);
    if (!ativo() || /^\s*\//.test(t)) return t;
    S.pedido = { em: Date.now(), versao: S.rot ? S.rot.versao : null };
    if (S.el) renderAvisos();
    return '[roteiro ' + S.id + '] ' + t;
  }

  function respostaDoAgente(texto) {
    const limpo = limpaParaFaixa(texto);
    if (!limpo) return;
    S.faixaTexto = limpo; S.faixaTipo = 'resposta';
    // o agente respondeu só com texto (uma pergunta, um "já vou"): o aviso deixa de dizer
    // "esperando" e aponta a conversa, senão ficaria 10 min parado mentindo
    if (S.pedido && !S.pedido.respondeu) S.pedido.respondeu = Date.now();
    if (S.el) { renderFaixa(); renderAvisos(); }
  }

  /* ───────────── rede ───────────── */

  const U = {
    lista: q => BASE + (q ? '?' + q : ''),
    rot: id => BASE + '/' + encodeURIComponent(id),
    sub: (id, p) => BASE + '/' + encodeURIComponent(id) + '/' + p,
  };

  async function chamarPadrao(metodo, url, corpo) {
    const ctl = new AbortController();
    const relogio = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const init = { method: metodo, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal, headers: { Accept: 'application/json' } };
    if (corpo !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(corpo); }
    let r;
    try { r = await fetch(url, init); }
    catch (e) {
      throw new Error(ctl.signal.aborted ? 'o servidor não respondeu em ' + TIMEOUT_MS / 1000 + ' s' : 'sem conexão com o servidor (' + (e.message || 'rede') + ')');
    } finally { clearTimeout(relogio); }
    let d = null;
    try { d = await r.json(); } catch (_) { d = null; }   // corpo que não é JSON cai na mensagem genérica abaixo
    if (r.status === 401) throw Object.assign(new Error('sua sessão expirou: entre de novo'), { status: 401 });
    if (!r.ok || (d && d.ok === false)) {
      throw Object.assign(new Error((d && d.erro) || 'o servidor respondeu ' + r.status + ' em ' + metodo + ' ' + url), { status: r.status, dados: d });
    }
    return d || {};
  }

  /* Se o app passou `api`, o contrato é o mesmo de chamarPadrao: (metodo, url, corpo) -> Promise<json>. */
  function chamar(metodo, url, corpo) {
    return (S.api || chamarPadrao)(metodo, url, corpo);
  }

  const desembrulha = (d, chave) => (d && d[chave] && typeof d[chave] === 'object' && !Array.isArray(d[chave]) ? d[chave] : d);
  const normTexto = t => String(t == null ? '' : t).replace(/\r\n?/g, '\n');

  /* ───────────── DOM: utilidades ───────────── */

  const doc = () => raiz.document;

  function el(tag, cls, texto, attrs) {
    const e = doc().createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = texto;
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    return e;
  }
  function botao(cls, rotulo, aoClicar, attrs) {
    const b = el('button', cls, rotulo, attrs);
    b.type = 'button';
    if (aoClicar) b.addEventListener('click', aoClicar);
    return b;
  }
  const limpa = e => { while (e.firstChild) e.removeChild(e.firstChild); };
  const nomeAgente = () => S.nomeAgente || S.agente || 'o agente';
  const maiuscula = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function autorNome(a) {
    if (a === S.agente) return maiuscula(nomeAgente());
    if (a === 'dono') return 'você';
    if (a === 'externo') return 'alteração de fora';
    if (a === 'desfazer') return 'desfazer';
    return maiuscula(a || 'alguém');
  }

  function noDom(n) {
    switch (n.t) {
      case 'txt': return doc().createTextNode(n.v);
      case 'br': return el('br');
      case 'b': { const e = el('strong'); n.filhos.forEach(f => e.appendChild(noDom(f))); return e; }
      case 'i': { const e = el('em'); n.filhos.forEach(f => e.appendChild(noDom(f))); return e; }
      case 'h': { const e = el('h' + Math.min(6, n.n + 1), 'dgr-h'); n.filhos.forEach(f => e.appendChild(noDom(f))); return e; }
      case 'hr': return el('hr');
      case 'cit': { const e = el('blockquote'); n.filhos.forEach(f => e.appendChild(noDom(f))); return e; }
      case 'ul': case 'ol': {
        const e = el(n.t);
        n.itens.forEach(it => { const li = el('li'); it.forEach(f => li.appendChild(noDom(f))); e.appendChild(li); });
        return e;
      }
      default: { const e = el('p'); (n.filhos || []).forEach(f => e.appendChild(noDom(f))); return e; }
    }
  }

  /* Prende o Tab dentro de `caixa` e chama aoEsc no Esc. Devolve a função que solta. */
  function prende(caixa, aoEsc) {
    const aoTeclar = ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); aoEsc(); return; }
      if (ev.key !== 'Tab') return;
      const fs = Array.from(caixa.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter(x => !x.disabled && x.offsetParent !== null);
      if (!fs.length) { ev.preventDefault(); return; }
      const p = fs[0], u = fs[fs.length - 1];
      if (ev.shiftKey && doc().activeElement === p) { ev.preventDefault(); u.focus(); }
      else if (!ev.shiftKey && doc().activeElement === u) { ev.preventDefault(); p.focus(); }
    };
    caixa.addEventListener('keydown', aoTeclar);
    return () => caixa.removeEventListener('keydown', aoTeclar);
  }

  /* ───────────── DOM: construção do painel ───────────── */

  function montar() {
    if (S.el) return;
    const d = doc();
    const painel = el('section', 'dgr-painel dgr-tema', null, { role: 'region', 'aria-label': 'Roteiro' });
    painel.hidden = true;

    const topo = el('header', 'dgr-topo');
    const linhaSel = el('div', 'dgr-linha-sel');
    const seletor = botao('dgr-seletor', '', () => abrirFolha(seletor), { 'aria-haspopup': 'dialog', 'data-dgr-tour': 'seletor' });
    const ajuda = botao('dgr-ajuda', '?', () => tutorialSeletor(), { 'aria-label': 'Tutorial do seletor de roteiros', title: 'O que é este seletor' });
    const mais = botao('dgr-mais', '⋯', () => alternaMenu(), { 'aria-label': 'Mais ações do roteiro', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-dgr-tour': 'mais' });
    linhaSel.append(seletor, ajuda, mais);

    const status = el('div', 'dgr-status', null, { 'data-dgr-tour': 'status', 'aria-live': 'polite' });
    const linhaAcoes = el('div', 'dgr-linha-acoes');
    const aprovar = botao('dgr-aprovar', 'Aprovar e mandar pra produção', () => aprovarRoteiro(), { 'data-dgr-tour': 'aprovar' });
    const aprovadoSelo = el('span', 'dgr-aprovado-selo');
    const sec = el('div', 'dgr-sec', null, { 'data-dgr-tour': 'acoes' });
    linhaAcoes.append(aprovar, aprovadoSelo, sec);
    const menu = el('div', 'dgr-menu', null, { role: 'menu' });
    menu.hidden = true;
    topo.append(linhaSel, status, linhaAcoes, menu);

    const avisos = el('div', 'dgr-avisos');
    const corpo = el('div', 'dgr-corpo', null, { tabindex: '-1' });
    const texto = el('article', 'dgr-texto', null, { 'data-dgr-tour': 'texto' });
    corpo.appendChild(texto);
    painel.append(topo, avisos, corpo);

    const faixa = botao('dgr-faixa dgr-tema', '', () => recolher(true), { 'data-dgr-tour': 'faixa', 'aria-label': 'Esconder o roteiro e mostrar a conversa' });
    faixa.hidden = true;
    const barra = botao('dgr-barra dgr-tema', '', () => recolher(false), { 'aria-label': 'Mostrar o roteiro' });
    barra.hidden = true;

    d.body.append(painel, faixa, barra);

    ligaToque(corpo, texto);
    ligaArrasto(faixa);
    d.addEventListener('keydown', aoTeclarGlobal);
    d.addEventListener('click', aoClicarFora, true);

    S.el = { painel, topo, seletor, ajuda, mais, status, aprovar, aprovadoSelo, sec, menu, avisos, corpo, texto, faixa, barra };
    montaAcoes();
  }

  const ACOES = [
    { k: 'mudou', rotulo: 'Ver o que mudou', f: () => verOQueMudou() },
    { k: 'desfazer', rotulo: 'Desfazer', f: () => desfazer() },
    { k: 'historico', rotulo: 'Histórico', f: () => abrirHistorico() },
    { k: 'editar', rotulo: 'Editar tudo', f: () => iniciaEdicao(null) },
    { k: 'tutorial', rotulo: 'Tutorial', f: () => tutorial() },
    { k: 'fechar', rotulo: 'Fechar', f: () => fechar() },
  ];

  function montaAcoes() {
    ACOES.forEach(a => {
      S.el.sec.appendChild(botao('dgr-btn dgr-btn-' + a.k, a.rotulo, () => a.f(), { 'data-dgr-acao': a.k }));
      const it = botao('dgr-item', a.rotulo, () => { fechaMenu(); a.f(); }, { role: 'menuitem', 'data-dgr-acao': a.k });
      S.el.menu.appendChild(it);
    });
  }

  function alternaMenu() {
    const abre = S.el.menu.hidden;
    S.el.menu.hidden = !abre;
    S.el.mais.setAttribute('aria-expanded', abre ? 'true' : 'false');
    if (abre) { const p = S.el.menu.querySelector('button:not([disabled])'); if (p) p.focus(); }
  }
  function fechaMenu() {
    if (!S.el || S.el.menu.hidden) return;
    S.el.menu.hidden = true;
    S.el.mais.setAttribute('aria-expanded', 'false');
  }
  function aoClicarFora(ev) {
    if (S.el && !S.el.menu.hidden && !ev.target.closest('.dgr-menu, .dgr-mais')) fechaMenu();
  }
  function aoTeclarGlobal(ev) {
    if (ev.key === 'Escape' && S.el && !S.el.menu.hidden) { fechaMenu(); S.el.mais.focus(); }
  }

  /* ───────────── layout ───────────── */

  const ladoAgora = () => !!(raiz.matchMedia && raiz.matchMedia('(min-width: 1024px)').matches);

  function guardaEstilo(e, prop) {
    if (!e) return;
    S.restos = S.restos || [];
    if (!S.restos.some(r => r.e === e && r.prop === prop)) S.restos.push({ e, prop, antes: e.style[prop] });
  }
  function soltaEstilos() {
    (S.restos || []).forEach(r => { r.e.style[r.prop] = r.antes; });
    S.restos = null;
  }

  function aplicaLayout() {
    if (!S.el) return;
    const html = doc().documentElement, sel = S.ponte.seletores || {};
    const topoEl = sel.topo ? doc().querySelector(sel.topo) : null;
    const compEl = sel.composer ? doc().querySelector(sel.composer) : null;
    const raizEl = sel.raiz ? doc().querySelector(sel.raiz) : null;
    const topoB = topoEl ? Math.round(topoEl.getBoundingClientRect().bottom) : 0;
    const { painel, faixa, barra } = S.el;
    const lado = ladoAgora();
    html.classList.toggle('dgr-aberto', S.aberto);
    html.classList.toggle('dgr-lado', S.aberto && lado);
    html.classList.toggle('dgr-recolhido', S.aberto && !lado && S.recolhido);
    if (!S.aberto) return;

    if (lado) {
      html.style.setProperty('--dgr-largura', 'min(56vw, 760px)');
      [raizEl, compEl].forEach(e => { if (e) { guardaEstilo(e, 'marginRight'); e.style.marginRight = 'var(--dgr-largura)'; } });
      painel.style.top = topoB + 'px'; painel.style.height = ''; painel.hidden = false;
      faixa.hidden = true; barra.hidden = true;
      return;
    }
    soltaEstilos();
    html.style.removeProperty('--dgr-largura');
    const compTop = compEl ? Math.round(compEl.getBoundingClientRect().top) : (raiz.innerHeight || 600);
    if (S.recolhido) {
      painel.hidden = true; faixa.hidden = true;
      barra.hidden = false; barra.style.top = topoB + 'px'; barra.style.height = ALTURA_BARRA + 'px';
      return;
    }
    barra.hidden = true;
    painel.hidden = false; faixa.hidden = false;
    painel.style.top = topoB + 'px';
    painel.style.height = Math.max(140, compTop - ALTURA_FAIXA - topoB) + 'px';
    faixa.style.top = Math.max(topoB, compTop - ALTURA_FAIXA) + 'px';
    faixa.style.height = ALTURA_FAIXA + 'px';
  }

  let quadro = 0;
  function reaplicaLayout() {
    if (quadro) return;
    quadro = (raiz.requestAnimationFrame || (f => setTimeout(f, 16)))(() => { quadro = 0; aplicaLayout(); });
  }

  function ligaLayout() {
    soltaLayout();
    const sel = S.ponte.seletores || {};
    raiz.addEventListener('resize', reaplicaLayout);
    if (raiz.visualViewport) { raiz.visualViewport.addEventListener('resize', reaplicaLayout); raiz.visualViewport.addEventListener('scroll', reaplicaLayout); }
    if (typeof raiz.ResizeObserver === 'function') {
      S.obs = new raiz.ResizeObserver(reaplicaLayout);
      [sel.composer, sel.topo].forEach(s => { const e = s && doc().querySelector(s); if (e) S.obs.observe(e); });
    }
  }
  function soltaLayout() {
    raiz.removeEventListener('resize', reaplicaLayout);
    if (raiz.visualViewport) { raiz.visualViewport.removeEventListener('resize', reaplicaLayout); raiz.visualViewport.removeEventListener('scroll', reaplicaLayout); }
    if (S.obs) { S.obs.disconnect(); S.obs = null; }
  }

  function recolher(sim) {
    S.recolhido = !!sim;
    aplicaLayout();
    if (!sim && S.el) renderFaixa();
  }

  /* Tocar na faixa recolhe; arrastar para cima mais de 40 px também (e o toque seguinte ao arrasto é ignorado). */
  function ligaArrasto(faixa) {
    let y0 = null, arrastou = false;
    faixa.addEventListener('touchstart', ev => { y0 = ev.touches[0].clientY; arrastou = false; }, { passive: true });
    faixa.addEventListener('touchmove', ev => {
      if (y0 != null && y0 - ev.touches[0].clientY > 40 && !arrastou) { arrastou = true; recolher(true); }
    }, { passive: true });
    faixa.addEventListener('click', ev => { if (arrastou) { ev.stopImmediatePropagation(); arrastou = false; } }, true);
  }

  /* ───────────── abrir e fechar ───────────── */

  const chaveUltimo = () => 'dgr:ultimo:' + S.agente;
  const chaveAtendido = () => 'dgr:atendido:' + S.agente;
  function lerLS(k) { try { return raiz.localStorage.getItem(k); } catch (_) { return null; } }   // sem armazenamento: o modo funciona, só não lembra
  function gravaLS(k, v) { try { if (v == null) raiz.localStorage.removeItem(k); else raiz.localStorage.setItem(k, v); } catch (_) { /* sem armazenamento: não lembra do último */ } }

  function abrir(id) {
    if (!S.ponte) { console.warn('roteiro: abrir() antes de iniciar()'); return; }
    montar();
    const mudou = id !== S.id;
    S.aberto = true;
    if (mudou) {
      S.id = id || null; S.rot = null; S.texto = ''; S.vista = 'leitura'; S.vdados = null; S.edicao = null; S.conflito = null;
      S.realce = null; S.realceFim = false; S.faixaNova = null; S.pedido = null; S.erroCarga = null; S.avisoFalho = null; S.erroAcao = null;
      S.faixaTexto = ''; S.faixaTipo = ''; S.recolhido = false;
    }
    gravaLS(chaveUltimo(), S.id);
    aplicaLayout();
    ligaLayout();
    renderTudo();
    if (S.id) { if (mudou || !S.rot) carregar(); agendaSonda(); }
    else abrirFolha(S.el.seletor);
  }

  function fechar() {
    if (!S.aberto) return;
    S.aberto = false;
    clearTimeout(S.timerSonda); S.timerSonda = null;
    clearTimeout(S.timerRealce); S.timerRealce = null;
    if (S.el) { S.el.painel.hidden = true; S.el.faixa.hidden = true; S.el.barra.hidden = true; fechaMenu(); }
    fechaFolha(false);
    soltaLayout();
    soltaEstilos();
    const html = doc().documentElement;
    html.classList.remove('dgr-aberto', 'dgr-lado', 'dgr-recolhido');
    html.style.removeProperty('--dgr-largura');
    gravaLS(chaveUltimo(), null);
    S.id = null; S.rot = null; S.edicao = null;
  }

  /* ───────────── carregar, sondar ───────────── */

  async function carregar() {
    const id = S.id;
    if (!id) return;
    S.carregando = true;
    if (!S.rot) { S.erroCarga = null; renderCorpo(); }
    try {
      const d = await chamar('GET', U.rot(id));
      if (id !== S.id) return;
      const rot = desembrulha(d, 'roteiro');
      aplicaRoteiro(rot);
      S.erroCarga = null; S.falhas = 0;
    } catch (e) {
      if (id !== S.id) return;
      S.erroCarga = e;
      if (e.status === 404) gravaLS(chaveUltimo(), null);
    } finally {
      S.carregando = false;
    }
    renderTudo();
  }

  /* Põe o roteiro lido no lugar. Versão nova de outra pessoa ganha realce e a faixa de aviso. */
  function aplicaRoteiro(rot) {
    const ant = S.rot;
    const textoNovo = normTexto(rot.texto);
    const novaVersao = ant && ant.id === rot.id && rot.versao !== ant.versao;
    if (novaVersao) {
      S.pedido = null;
      if (S.minhas.has(rot.versao)) { S.realce = null; S.faixaNova = null; }
      else {
        S.realce = marcasDe(diffTexto(S.texto, textoNovo));
        S.realceFim = false;
        S.faixaNova = { versao: rot.versao, autor: rot.autor, resumo: rot.resumo };
        S.faixaTexto = 'versão ' + rot.versao + ': ' + limpaParaFaixa(rot.resumo); S.faixaTipo = 'resumo';
        clearTimeout(S.timerRealce);
        S.timerRealce = setTimeout(expiraRealce, REALCE_MS);
      }
    } else if (!ant) {
      if (!S.faixaTexto) { S.faixaTexto = 'versão ' + rot.versao + ': ' + limpaParaFaixa(rot.resumo); S.faixaTipo = 'resumo'; }
    }
    if (rot.ajustando) S.pedido = null;
    S.rot = rot;
    S.texto = textoNovo;
    S.id = rot.id || S.id;
  }

  function expiraRealce() {
    S.realceFim = true;
    if (S.el) S.el.texto.classList.add('dgr-sem-realce');
  }

  function agendaSonda() {
    clearTimeout(S.timerSonda);
    if (!S.aberto || !S.id) return;
    S.timerSonda = setTimeout(sondaEstado, SONDA_ABERTO_MS);
  }

  async function sondaEstado() {
    if (!S.aberto || !S.id) return;
    if (doc().hidden) return;   // escondida: para; o visibilitychange retoma
    const id = S.id;
    try {
      const e = await chamar('GET', U.sub(id, 'estado'));
      if (id !== S.id) return;
      if (S.falhas >= 3) { S.falhas = 0; renderAvisos(); }
      S.falhas = 0;
      if (S.pedido && Date.now() - S.pedido.em > PEDIDO_DESISTE_MS) { S.pedido = null; renderAvisos(); }
      aplicaEstado(e);
    } catch (err) {
      S.falhas++;
      console.warn('roteiro: falha ao sondar ' + id + ' (' + S.falhas + 'ª seguida):', err.message);
      if (S.falhas === 3) renderAvisos();
    }
    agendaSonda();
  }

  function aplicaEstado(e) {
    if (!S.rot || !e) return;
    if (e.versao !== S.rot.versao) {
      if (S.edicao) {
        S.conflito = { versao: e.versao, autor: e.autor, resumo: e.resumo };
        renderAvisos();
      } else carregar();
      return;
    }
    const mudou = e.estado !== S.rot.estado || JSON.stringify(e.ajustando) !== JSON.stringify(S.rot.ajustando);
    if (mudou) {
      S.rot.estado = e.estado; S.rot.ajustando = e.ajustando || null;
      if (e.ajustando) S.pedido = null;
      renderCabecalho(); renderAvisos();
    }
  }

  /* Fechado: pergunta se o agente pediu para abrir um roteiro. */
  function sondaAberto() {
    clearTimeout(S.timerAberto);
    S.timerAberto = setTimeout(async () => {
      try {
        if (!S.aberto && !doc().hidden) {
          const d = await chamar('GET', BASE + '/aberto?agente=' + encodeURIComponent(S.agente));
          if (d && d.id && d.pedido_em) {
            const visto = Date.parse(lerLS(chaveAtendido()) || '') || 0;
            if (Date.parse(d.pedido_em) > visto) { gravaLS(chaveAtendido(), d.pedido_em); abrir(d.id); }
          }
        }
      } catch (e) { console.warn('roteiro: não consegui perguntar se há pedido de abrir:', e.message); }
      sondaAberto();
    }, SONDA_FECHADO_MS);
  }

  function aoVisibilidade() {
    if (doc().hidden) return;
    if (S.aberto) { clearTimeout(S.timerSonda); sondaEstado(); }
  }

  /* ───────────── render ───────────── */

  function renderTudo() {
    if (!S.el) return;
    renderCabecalho(); renderAvisos(); renderCorpo(); renderFaixa();
  }

  function renderCabecalho() {
    const { seletor, status, aprovar, aprovadoSelo, sec, menu, barra } = S.el;
    const rot = S.rot;
    limpa(seletor);
    seletor.append(el('span', 'dgr-sel-nome', rot ? rot.titulo : (S.erroCarga ? 'Roteiro' : (S.id ? 'Carregando…' : 'Escolher um roteiro'))), el('span', 'dgr-seta', '▾', { 'aria-hidden': 'true' }));
    seletor.setAttribute('aria-label', 'Trocar de roteiro. Roteiro atual: ' + (rot ? rot.titulo : 'nenhum'));
    barra.textContent = (rot ? rot.titulo : 'Roteiro') + '  ·  Mostrar roteiro ▾';
    limpa(status);
    if (rot) {
      status.append(el('span', 'dgr-st-versao', 'versão ' + rot.versao + ' · ' + autorNome(rot.autor) + ' · ' + haQuando(rot.atualizado_em)));
      status.append(el('span', 'dgr-chip dgr-est-' + rot.estado, ROTULO_ESTADO[rot.estado] || rot.estado));
    }
    const aprovado = !!rot && rot.estado === 'aprovado';
    aprovar.hidden = !rot || aprovado || rot.estado === 'arquivado';
    aprovadoSelo.hidden = !aprovado;
    aprovadoSelo.textContent = aprovado ? '✔ Aprovado' + (rot.aprovado_em ? ' em ' + dataCurta(rot.aprovado_em) : '') : '';
    const semRot = !rot;
    [sec, menu].forEach(c => c.querySelectorAll('[data-dgr-acao]').forEach(b => {
      const k = b.getAttribute('data-dgr-acao');
      if (k === 'fechar' || k === 'tutorial') return;
      b.disabled = semRot || (k === 'desfazer' && rot.versao <= 1);
    }));
  }

  function bloco(msg, cls) { return el('div', 'dgr-aviso ' + (cls || ''), msg); }

  function renderAvisos() {
    const av = S.el.avisos;
    limpa(av);
    if (S.falhas >= 3) av.appendChild(bloco('Sem conexão com o servidor, tentando de novo.', 'dgr-aviso-fraco'));
    if (S.erroAcao) {
      const b = bloco('', 'dgr-aviso-erro');
      b.appendChild(el('span', 'dgr-aviso-txt', S.erroAcao));
      b.appendChild(botao('dgr-btn', 'Fechar', () => { S.erroAcao = null; renderAvisos(); }));
      b.setAttribute('role', 'alert');
      av.appendChild(b);
    }
    if (S.avisoFalho) {
      const b = bloco('', 'dgr-aviso-erro');
      b.appendChild(el('span', 'dgr-aviso-txt', 'Gravei, mas ' + nomeAgente() + ' não foi avisado (' + S.avisoFalho.motivo + ').'));
      b.appendChild(botao('dgr-btn', 'Avisar de novo', async () => {
        const t = S.avisoFalho.texto;
        S.avisoFalho = null; renderAvisos();
        await avisarAgente(t);
      }));
      b.setAttribute('role', 'alert');
      av.appendChild(b);
    }
    if (S.conflito) {
      const c = S.conflito;
      const b = bloco('', 'dgr-aviso-alerta');
      b.appendChild(el('span', 'dgr-aviso-txt', autorNome(c.autor) + ' gravou a versão ' + c.versao + ' enquanto você editava.'));
      b.appendChild(botao('dgr-btn', 'Ver a dela', () => verADela()));
      b.appendChild(botao('dgr-btn dgr-btn-forte', 'Gravar a minha por cima', () => salvaEdicao(true)));
      b.setAttribute('role', 'alert');
      av.appendChild(b);
    }
    if (S.faixaNova && !S.edicao) {
      const n = S.faixaNova;
      const b = bloco('', 'dgr-aviso-nova');
      b.setAttribute('data-dgr-tour', 'faixa-nova');
      b.appendChild(el('span', 'dgr-aviso-txt', 'Versão ' + n.versao + ' de ' + autorNome(n.autor) + (n.resumo ? ': ' + n.resumo : '')));
      b.appendChild(botao('dgr-btn', 'Ver o que mudou', () => verOQueMudou()));
      b.appendChild(botao('dgr-btn', 'Desfazer', () => desfazer()));
      b.appendChild(botao('dgr-btn', 'ok', () => { S.faixaNova = null; renderAvisos(); }, { 'aria-label': 'Dispensar o aviso da versão nova' }));
      av.appendChild(b);
    }
    const r = S.rot;
    if (r && r.ajustando) {
      av.appendChild(estatico('🕒', nomeAgente() + ' ajustando…' + (r.ajustando.nota ? ' (' + r.ajustando.nota + ')' : '')));
    } else if (S.pedido) {
      av.appendChild(S.pedido.respondeu
        ? estatico('💬', nomeAgente() + ' respondeu na conversa (toque na faixa de baixo para ler)')
        : estatico('🕒', 'Pedido enviado, esperando ' + nomeAgente()));
    }
  }

  function estatico(ico, txt) {
    const b = el('div', 'dgr-aviso dgr-aviso-ajuste');
    b.setAttribute('role', 'status');
    b.append(el('span', 'dgr-relogio', ico, { 'aria-hidden': 'true' }), el('span', 'dgr-aviso-txt', txt));
    return b;
  }

  function renderFaixa() {
    if (!S.el) return;
    const f = S.el.faixa;
    limpa(f);
    const rotulo = S.faixaTipo === 'resposta' ? maiuscula(nomeAgente()) + ': ' : '';
    f.append(el('span', 'dgr-faixa-seta', '▲', { 'aria-hidden': 'true' }), el('span', 'dgr-faixa-txt', rotulo + (S.faixaTexto || 'Toque para ver a conversa')));
  }

  /* Rolagem relativa ao bloco que estava no topo, para a versão nova entrar sem o texto pular. */
  function capturaRolagem() {
    const c = S.el.corpo, blocos = S.el.texto.querySelectorAll('.dgr-bloco');
    const topo = c.getBoundingClientRect().top;
    for (let i = 0; i < blocos.length; i++) {
      const r = blocos[i].getBoundingClientRect();
      if (r.bottom > topo + 1) return { i, off: r.top - topo };
    }
    return null;
  }
  function restauraRolagem(p) {
    if (!p) return;
    const c = S.el.corpo, b = S.el.texto.querySelectorAll('.dgr-bloco')[p.i];
    if (!b) return;
    c.scrollTop += (b.getBoundingClientRect().top - c.getBoundingClientRect().top) - p.off;
  }

  function cartaoErro(msg, acoes) {
    const c = el('div', 'dgr-cartao-erro', null, { role: 'alert' });
    c.append(el('strong', null, 'Não consegui abrir o roteiro'), el('p', null, msg));
    const l = el('div', 'dgr-linha-botoes');
    acoes.forEach(([r, f]) => l.appendChild(botao('dgr-btn dgr-btn-forte', r, f)));
    c.appendChild(l);
    return c;
  }

  function renderCorpo() {
    const t = S.el.texto;
    const rolagem = S.rot && S.vista === 'leitura' && !S.edicao ? capturaRolagem() : null;
    limpa(t);
    t.classList.toggle('dgr-sem-realce', S.realceFim);
    S.ta = null;
    if (!S.id) {
      t.appendChild(el('p', 'dgr-vazio', 'Nenhum roteiro aberto. Toque no nome lá em cima para escolher um, ou peça a ' + nomeAgente() + ' para abrir um roteiro aqui.'));
      return;
    }
    if (S.erroCarga && !S.rot) {
      t.appendChild(cartaoErro(S.erroCarga.message, [['Tentar de novo', () => carregar()], ['Escolher outro roteiro', () => abrirFolha(S.el.seletor)]]));
      return;
    }
    if (!S.rot) { t.appendChild(el('p', 'dgr-vazio', 'Carregando o roteiro…')); return; }
    if (S.vista === 'diff') return renderDiff(t);
    if (S.vista === 'historico') return renderHistorico(t);
    if (S.vista === 'versao') return renderVersao(t);
    renderLeitura(t);
    restauraRolagem(rolagem);
  }

  function renderLeitura(t) {
    const blocos = mdParse(S.texto);
    const r = S.realce && !S.realceFim ? S.realce : null;
    const trechos = n => el('div', 'dgr-saiu-marca', n === 1 ? '1 trecho saiu' : n + ' trechos saíram');
    if (!blocos.length) t.appendChild(el('p', 'dgr-vazio', 'Este roteiro ainda está vazio. Peça a ' + nomeAgente() + ' para escrever, ou toque em "Editar tudo".'));
    blocos.forEach((b, i) => {
      if (r && r.saiuAntes[i]) t.appendChild(trechos(r.saiuAntes[i]));
      if (S.edicao && S.edicao.indice === i) { t.appendChild(editorDom(b.md)); return; }
      const e = el('div', 'dgr-bloco', null, { tabindex: '0', 'data-i': String(i), title: 'Toque para editar este trecho' });
      b.nos.forEach(n => e.appendChild(noDom(n)));
      const marca = r ? r.marcas[i] : null;
      if (marca) {
        e.classList.add('dgr-mudou');
        e.appendChild(el('span', 'dgr-etq', marca === 'novo' ? 'novo' : 'mudou'));
      }
      t.appendChild(e);
    });
    if (r && r.saiuAntes[blocos.length]) t.appendChild(trechos(r.saiuAntes[blocos.length]));
    if (S.edicao && S.edicao.indice === null) { limpa(t); t.appendChild(editorDom(S.edicao.textoBase)); }
    if (S.edicao) {
      const ta = S.ta;
      if (ta) { autoaltura(); if (!S.edicao.focou) { S.edicao.focou = true; ta.focus(); } }
    }
  }

  /* ── vistas: antes e depois, histórico, versão antiga ── */

  function voltarBarra(titulo) {
    const b = el('div', 'dgr-vista-topo');
    b.append(botao('dgr-btn', '← Voltar ao roteiro', () => { S.vista = 'leitura'; S.vdados = null; renderCorpo(); S.el.corpo.scrollTop = 0; }), el('strong', 'dgr-vista-tit', titulo));
    return b;
  }

  function segsDom(segs) {
    const p = el('p', 'dgr-dif');
    segs.forEach(s => {
      if (s.tipo === 'igual') p.appendChild(doc().createTextNode(s.texto));
      else {
        const e = el(s.tipo === 'saiu' ? 'del' : 'ins', s.tipo === 'saiu' ? 'dgr-saiu' : 'dgr-entrou');
        e.append(el('span', 'dgr-oculto', s.tipo === 'saiu' ? 'saiu: ' : 'entrou: '), doc().createTextNode(s.texto));
        p.appendChild(e);
      }
    });
    return p;
  }

  function renderDiff(t) {
    const v = S.vdados;
    t.appendChild(voltarBarra(v.titulo));
    const leg = el('p', 'dgr-legenda');
    leg.append('Legenda: ', el('del', 'dgr-saiu', 'riscado em vermelho = saiu'), ' · ', el('ins', 'dgr-entrou', 'sublinhado em verde = entrou'), ' · o resto ficou igual.');
    t.appendChild(leg);
    const entradas = diffTexto(v.antes, v.depois);
    if (!entradas.some(e => e.tipo !== 'igual')) t.appendChild(el('p', 'dgr-vazio', 'Não há diferença entre as duas versões.'));
    entradas.forEach(e => {
      if (e.tipo === 'igual') { const d = el('div', 'dgr-dif-igual'); d.appendChild(el('p', null, e.texto)); t.appendChild(d); }
      else if (e.tipo === 'mudou') t.appendChild(segsDom(e.segmentos));
      else t.appendChild(segsDom([{ tipo: e.tipo === 'novo' ? 'entrou' : 'saiu', texto: e.texto }]));
    });
  }

  function renderVersao(t) {
    const v = S.vdados;
    t.appendChild(el('div', 'dgr-vista-topo')).append(
      botao('dgr-btn', '← Histórico', () => abrirHistorico()),
      el('strong', 'dgr-vista-tit', 'Versão ' + v.versao + (v.autor ? ' · ' + autorNome(v.autor) : '')));
    if (v.resumo) t.appendChild(el('p', 'dgr-legenda', v.resumo));
    const acoes = el('div', 'dgr-linha-botoes');
    acoes.append(
      botao('dgr-btn', 'Comparar com a atual', () => {
        S.vista = 'diff'; S.vdados = { titulo: 'Versão ' + v.versao + ' contra a atual (' + S.rot.versao + ')', antes: v.texto, depois: S.texto }; renderCorpo();
      }),
      botao('dgr-btn dgr-btn-forte', 'Voltar para esta', () => restaurar(v.versao)));
    t.appendChild(acoes);
    const corpoTxt = el('div', 'dgr-versao-texto');
    mdParse(normTexto(v.texto)).forEach(b => { const e = el('div', 'dgr-bloco dgr-bloco-leitura'); b.nos.forEach(n => e.appendChild(noDom(n))); corpoTxt.appendChild(e); });
    t.appendChild(corpoTxt);
  }

  function renderHistorico(t) {
    const v = S.vdados;
    t.appendChild(voltarBarra('Histórico de versões'));
    if (v.carregando) { t.appendChild(el('p', 'dgr-vazio', 'Carregando o histórico…')); return; }
    if (v.erro) { t.appendChild(cartaoErro(v.erro, [['Tentar de novo', () => abrirHistorico()]])); return; }
    const ul = el('ul', 'dgr-historico');
    v.itens.slice().sort((a, b) => b.versao - a.versao).forEach(it => {
      const li = el('li');
      const b = botao('dgr-hist-item', '', () => abrirVersao(it.versao), { 'aria-label': 'Ver a versão ' + it.versao });
      b.append(
        el('span', 'dgr-hist-n', 'v' + it.versao + (S.rot && it.versao === S.rot.versao ? ' (atual)' : '')),
        el('span', 'dgr-hist-meta', autorNome(it.autor) + ' · ' + haQuando(it.criado_em)),
        el('span', 'dgr-hist-resumo', it.resumo || '(sem resumo)'));
      li.appendChild(b);
      ul.appendChild(li);
    });
    t.appendChild(ul);
  }

  /* ───────────── ações: ver o que mudou, histórico, desfazer, restaurar ───────────── */

  async function buscaVersao(n) {
    const d = await chamar('GET', U.sub(S.id, 'versoes/' + n));
    const v = typeof d.texto === 'string' ? d : desembrulha(d, 'versao');
    return v;
  }
  const listaDe = d => (Array.isArray(d) ? d : (d && (d.versoes || d.itens)) || []);

  function erroAcao(e, o) {
    S.erroAcao = 'Não consegui ' + o + ': ' + (e && e.message ? e.message : 'erro sem detalhe') + '.';
    renderAvisos();
    if (e && e.status === 409) carregar();
  }

  async function verOQueMudou() {
    if (!S.rot) return;
    if (S.rot.versao <= 1) { S.erroAcao = 'Esta é a versão 1: não há versão anterior para comparar.'; renderAvisos(); return; }
    try {
      const ant = await buscaVersao(S.rot.versao - 1);
      S.vista = 'diff';
      S.vdados = { titulo: 'Versão ' + (S.rot.versao - 1) + ' → versão ' + S.rot.versao, antes: normTexto(ant.texto), depois: S.texto };
      renderCorpo(); S.el.corpo.scrollTop = 0;
    } catch (e) { erroAcao(e, 'buscar a versão anterior'); }
  }

  async function abrirHistorico() {
    if (!S.rot) return;
    S.vista = 'historico'; S.vdados = { carregando: true };
    renderCorpo();
    try {
      const d = await chamar('GET', U.sub(S.id, 'versoes'));
      if (S.vista !== 'historico') return;
      S.vdados = { itens: listaDe(d) };
    } catch (e) { S.vdados = { erro: e.message }; }
    renderCorpo();
  }

  async function abrirVersao(n) {
    try {
      const v = await buscaVersao(n);
      S.vista = 'versao';
      S.vdados = { versao: n, texto: normTexto(v.texto), autor: v.autor, resumo: v.resumo };
      renderCorpo(); S.el.corpo.scrollTop = 0;
    } catch (e) { erroAcao(e, 'abrir a versão ' + n); }
  }

  async function restaurar(n) {
    const ok = await confirmar({ titulo: 'Voltar para a versão ' + n + '?', texto: 'Isso grava uma versão nova com o texto da versão ' + n + '. A versão ' + S.rot.versao + ' continua no histórico.', ok: 'Voltar para esta' });
    if (!ok) return;
    try {
      const d = await chamar('POST', U.sub(S.id, 'restaurar'), { versao: n, base_versao: S.rot.versao });
      await depoisDeGravar(d);
      S.vista = 'leitura'; S.vdados = null;
      renderTudo();
      await avisarAgente('[roteiro ' + S.id + '] [aviso] Desfiz: voltei ao texto da versão ' + n + ' (agora é a versão ' + S.rot.versao + ').');
    } catch (e) { erroAcao(e, 'voltar para a versão ' + n); }
  }

  /* A versão que a própria pessoa gravou não ganha realce nem faixa de "versão nova". */
  async function depoisDeGravar(d) {
    S.faixaNova = null; S.realce = null;
    S.erroCarga = null;
    const rot = await roteiroDaEscrita(d);
    S.minhas.add(rot.versao);
    aplicaRoteiro(rot);
  }

  /* As escritas devolvem { ok, roteiro:{...com texto} }; se vier sem o texto, lê de novo. */
  async function roteiroDaEscrita(d) {
    if (d && d.roteiro && typeof d.roteiro.texto === 'string') return d.roteiro;
    return desembrulha(await chamar('GET', U.rot(S.id)), 'roteiro');
  }

  async function desfazer() {
    if (!S.rot) return;
    let alvo;
    try {
      const itens = listaDe(await chamar('GET', U.sub(S.id, 'versoes')));
      const atual = itens.find(i => i.versao === S.rot.versao);
      alvo = ((atual && atual.restaurada_de) || S.rot.versao) - 1;
    } catch (e) { erroAcao(e, 'conferir o histórico antes de desfazer'); return; }
    if (alvo < 1) { S.erroAcao = 'Não há versão anterior para voltar: esta é a primeira.'; renderAvisos(); return; }
    const ok = await confirmar({ titulo: 'Voltar ao texto da versão ' + alvo + '?', texto: 'A versão ' + S.rot.versao + ' continua no histórico.', ok: 'Desfazer' });
    if (!ok) return;
    try {
      const d = await chamar('POST', U.sub(S.id, 'desfazer'), { base_versao: S.rot.versao });
      await depoisDeGravar(d);
      S.vista = 'leitura'; S.vdados = null;
      renderTudo();
      await avisarAgente('[roteiro ' + S.id + '] [aviso] Desfiz: voltei ao texto da versão ' + alvo + ' (agora é a versão ' + S.rot.versao + ').');
    } catch (e) { erroAcao(e, 'desfazer'); }
  }

  async function aprovarRoteiro() {
    if (!S.rot) return;
    const dgs = S.rot.origem === 'dgsocial';
    const ok = await confirmar({
      titulo: 'Aprovar a versão ' + S.rot.versao + ' e mandar pra produção?',
      texto: dgs ? 'Isso aprova o roteiro no DG Social e solta a produção do conteúdo.' : 'O roteiro fica marcado como aprovado e ' + nomeAgente() + ' é avisado.',
      ok: 'Aprovar e mandar pra produção',
    });
    if (!ok) return;
    try {
      const v = S.rot.versao;
      const d = await chamar('POST', U.sub(S.id, 'aprovar'), { base_versao: v });
      const rot = await roteiroDaEscrita(d);
      S.minhas.add(rot.versao);
      aplicaRoteiro(rot);
      renderTudo();
      await avisarAgente('[roteiro ' + S.id + '] [aviso] Aprovei a versão ' + v + '. Pode mandar pra produção.');
    } catch (e) { erroAcao(e, 'aprovar'); }
  }

  /* O aviso pode falhar sem desfazer o que já foi gravado: mostra e oferece avisar de novo. */
  function avisarAgente(texto) {
    return new Promise(resolve => {
      let feito = false;
      const fim = (ok, motivo) => {
        if (feito) return;
        feito = true;
        if (!ok) { S.avisoFalho = { texto, motivo: motivo || 'sem motivo informado' }; if (S.el) renderAvisos(); }
        resolve(ok);
      };
      try {
        const r = S.ponte.enviar(texto, (ok, motivo) => fim(ok !== false, motivo));
        if (r && typeof r.catch === 'function') r.catch(e => fim(false, e.message));
      } catch (e) { fim(false, e.message); }
      setTimeout(() => fim(false, 'o app não confirmou a entrega em 20 s'), 20000);
    });
  }

  /* ───────────── edição à mão ───────────── */

  function ligaToque(corpo, texto) {
    let p = null;
    texto.addEventListener('pointerdown', ev => { p = { x: ev.clientX, y: ev.clientY, t: Date.now() }; });
    texto.addEventListener('pointercancel', () => { p = null; });
    texto.addEventListener('pointerup', ev => {
      const ini = p; p = null;
      if (!ini || S.vista !== 'leitura' || S.edicao) return;
      if (Math.abs(ev.clientX - ini.x) >= 8 || Math.abs(ev.clientY - ini.y) >= 8 || Date.now() - ini.t >= 400) return;
      const sel = raiz.getSelection ? String(raiz.getSelection()) : '';
      if (sel) return;
      const b = ev.target.closest && ev.target.closest('.dgr-bloco');
      if (b && texto.contains(b)) iniciaEdicao(Number(b.getAttribute('data-i')));
    });
    texto.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || S.edicao || ev.target.tagName === 'TEXTAREA') return;
      const b = ev.target.closest && ev.target.closest('.dgr-bloco');
      if (b) { ev.preventDefault(); iniciaEdicao(Number(b.getAttribute('data-i'))); }
    });
  }

  function iniciaEdicao(indice) {
    if (!S.rot || S.edicao) return;
    if (S.vista !== 'leitura') { S.vista = 'leitura'; S.vdados = null; }
    S.edicao = { indice, baseVersao: S.rot.versao, textoBase: S.texto, blocos: dividirBlocos(S.texto), focou: false };
    S.conflito = null;
    renderAvisos(); renderCorpo();
  }

  function editorDom(valor) {
    const w = el('div', 'dgr-editor');
    const ta = el('textarea', 'dgr-ta', null, { 'aria-label': S.edicao.indice === null ? 'Texto inteiro do roteiro' : 'Texto deste trecho do roteiro', spellcheck: 'true' });
    ta.value = valor;
    ta.addEventListener('input', autoaltura);
    ta.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); cancelaEdicao(); } });
    const barra = el('div', 'dgr-ed-acoes');
    barra.append(botao('dgr-btn dgr-btn-forte', 'Salvar', () => salvaEdicao(false)), botao('dgr-btn', 'Cancelar', () => cancelaEdicao()));
    w.append(ta, barra);
    S.ta = ta;
    return w;
  }

  function autoaltura() {
    const ta = S.ta;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 4, Math.max(200, (raiz.innerHeight || 700) * 0.6)) + 'px';
  }

  function cancelaEdicao() {
    S.edicao = null; S.conflito = null;
    renderAvisos(); renderCorpo();
  }

  async function verADela() {
    const ok = await confirmar({ titulo: 'Ver a versão de ' + autorNome(S.conflito && S.conflito.autor) + '?', texto: 'O que você escreveu aqui será descartado.', ok: 'Ver a dela' });
    if (!ok) return;
    S.edicao = null; S.conflito = null;
    await carregar();
  }

  async function salvaEdicao(forcar) {
    const ed = S.edicao;
    if (!ed || !S.ta) return;
    const novo = S.ta.value;
    let texto = novo;
    if (ed.indice !== null) {
      const b = ed.blocos[ed.indice];
      texto = ed.textoBase.slice(0, b.ini) + novo + ed.textoBase.slice(b.fim);
    }
    const corpo = { texto, resumo: '', base_versao: forcar && S.conflito ? S.conflito.versao : ed.baseVersao };
    if (forcar) corpo.forcar = true;
    try {
      const d = await chamar('POST', U.sub(S.id, 'versoes'), corpo);
      S.edicao = null; S.conflito = null;
      if (d && d.mudou === false) { await carregar(); return; }
      await depoisDeGravar(d);
      renderTudo();
      await avisarAgente('[roteiro ' + S.id + '] [aviso] Salvei uma edição à mão: versão ' + S.rot.versao + '.');
    } catch (e) {
      if (e.status === 409) {
        const atual = e.dados && e.dados.atual;
        S.conflito = { versao: atual ? atual.versao : (S.rot.versao + 1), autor: atual && atual.autor, resumo: atual && atual.resumo };
        renderAvisos();
      } else erroAcao(e, 'salvar a edição (o texto que você escreveu continua na tela)');
    }
  }

  /* ───────────── folha do seletor ───────────── */

  let folha = null;

  async function abrirFolha(origem) {
    if (folha) return;
    const fundo = el('div', 'dgr-folha-fundo dgr-tema');
    const f = el('div', 'dgr-folha', null, { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Escolher o roteiro' });
    const topo = el('div', 'dgr-folha-topo');
    topo.append(el('strong', null, 'Roteiros'), botao('dgr-btn', 'Fechar', () => fechaFolha(true), { 'aria-label': 'Fechar a lista de roteiros' }));
    const busca = el('input', 'dgr-busca', null, { type: 'search', placeholder: 'Buscar pelo título', 'aria-label': 'Buscar roteiro pelo título', autocomplete: 'off' });
    busca.value = S.buscaLista;
    const lista = el('div', 'dgr-folha-lista');
    f.append(topo, busca, lista);
    fundo.appendChild(f);
    fundo.addEventListener('click', ev => { if (ev.target === fundo) fechaFolha(true); });
    doc().body.appendChild(fundo);
    folha = { fundo, f, lista, busca, origem, solta: prende(f, () => fechaFolha(true)) };
    busca.addEventListener('input', () => { S.buscaLista = busca.value; S.verMaisAprovados = false; pintaLista(); });
    busca.focus();
    lista.appendChild(el('p', 'dgr-vazio', 'Carregando os roteiros…'));
    try {
      const d = await chamar('GET', U.lista('agente=' + encodeURIComponent(S.agente)));
      S.lista = { itens: (Array.isArray(d) ? d : d.roteiros || d.itens || []), fontes: d.fontes || null };
    } catch (e) { S.lista = { itens: [], fontes: null, erro: e.message }; }
    if (folha) pintaLista();
  }

  function fechaFolha(devolveFoco) {
    if (!folha) return;
    const { fundo, origem, solta } = folha;
    solta();
    fundo.remove();
    folha = null;
    if (devolveFoco && origem && origem.focus) origem.focus();
  }

  const GRUPOS = [['em_ajuste', 'Em ajuste'], ['aguardando_aprovacao', 'Aguardando aprovação'], ['aprovado', 'Aprovados']];

  function pintaLista() {
    const { lista } = folha;
    limpa(lista);
    const L = S.lista || { itens: [] };
    if (L.erro) { lista.appendChild(cartaoErro(L.erro, [['Tentar de novo', () => { const o = folha.origem; fechaFolha(false); abrirFolha(o); }]])); return; }
    const dgs = L.fontes && L.fontes.dgsocial;
    if (dgs && dgs.ok === false) {
      lista.appendChild(el('div', 'dgr-aviso dgr-aviso-alerta', 'O DG Social não respondeu' + (dgs.erro ? ': ' + dgs.erro : '') + '. Os roteiros dele podem estar faltando nesta lista.', { role: 'alert' }));
    }
    const q = S.buscaLista.trim();
    const itens = filtrarLista(L.itens, q);
    if (!itens.length) {
      lista.appendChild(el('p', 'dgr-vazio', q ? 'Nenhum roteiro com "' + q + '" no título.' : 'Nenhum roteiro por aqui ainda. Peça a ' + nomeAgente() + ' para abrir um roteiro aqui.'));
      return;
    }
    const grupos = GRUPOS.slice();
    if (q) grupos.push(['arquivado', 'Arquivados']);
    grupos.forEach(([est, nome]) => {
      let doGrupo = itens.filter(r => r.estado === est);
      if (!doGrupo.length) return;
      const total = doGrupo.length;
      const limita = est === 'aprovado' && !q && !S.verMaisAprovados && total > 8;
      if (limita) doGrupo = doGrupo.slice(0, 8);
      lista.appendChild(el('h3', 'dgr-grupo', nome + ' (' + total + ')'));
      doGrupo.forEach(r => lista.appendChild(linhaRoteiro(r)));
      if (limita) lista.appendChild(botao('dgr-btn dgr-ver-mais', 'ver mais (' + (total - 8) + ')', () => { S.verMaisAprovados = true; pintaLista(); }));
    });
  }

  function linhaRoteiro(r) {
    const b = botao('dgr-linha', '', () => { fechaFolha(false); abrir(r.id); });
    if (r.id === S.id) b.setAttribute('aria-current', 'true');
    const l1 = el('span', 'dgr-linha-l1');
    l1.append(el('span', 'dgr-linha-tit', r.titulo));
    if (r.origem === 'dgsocial') l1.append(el('span', 'dgr-selo', 'DG Social'));
    b.append(l1, el('span', 'dgr-linha-sub', 'versão ' + r.versao + ' · ' + haQuando(r.atualizado_em)));
    return b;
  }

  /* ───────────── confirmação ───────────── */

  function confirmar({ titulo, texto, ok }) {
    return new Promise(resolve => {
      const antes = doc().activeElement;
      const fundo = el('div', 'dgr-folha-fundo dgr-modal-fundo dgr-tema');
      const m = el('div', 'dgr-modal', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dgr-modal-tit' });
      const h = el('strong', 'dgr-modal-tit', titulo, { id: 'dgr-modal-tit' });
      const acoes = el('div', 'dgr-linha-botoes');
      let solta = () => {};
      const fim = v => { solta(); fundo.remove(); if (antes && antes.focus) antes.focus(); resolve(v); };
      const bOk = botao('dgr-btn dgr-btn-forte', ok || 'Confirmar', () => fim(true));
      acoes.append(botao('dgr-btn', 'Cancelar', () => fim(false)), bOk);
      m.append(h, el('p', null, texto), acoes);
      fundo.appendChild(m);
      doc().body.appendChild(fundo);
      solta = prende(m, () => fim(false));
      bOk.focus();
    });
  }

  /* ───────────── tutorial ───────────── */

  function tutorial() {
    if (!raiz.DGTour) { S.erroAcao = 'O tutorial não carregou nesta tela. Recarregue a página.'; renderAvisos(); return; }
    const lado = ladoAgora();
    const passos = [
      { alvo: '[data-dgr-tour="seletor"]', titulo: 'Escolher o roteiro',
        oque: 'O nome do roteiro que está aberto, com uma setinha.',
        como: 'Toque nele para abrir a lista. Dá para buscar pelo título; os roteiros vêm separados em Em ajuste, Aguardando aprovação e Aprovados, os mais recentes em cima.',
        porque: 'Você pode ter vários roteiros andando ao mesmo tempo. Aqui você troca de um para o outro sem sair da conversa.' },
      { alvo: '[data-dgr-tour="status"]', titulo: 'Versão e situação',
        oque: 'Qual é a versão do roteiro, quem fez essa versão, quando, e em que situação ele está.',
        como: 'A cada ajuste vira uma versão nova com número. A situação aparece escrita (Em ajuste, Aguardando aprovação ou Aprovado), não só com cor.',
        porque: 'Assim você sabe de relance se está lendo a versão mais nova e se ela já foi aprovada.' },
      { alvo: '[data-dgr-tour="faixa-nova"]', titulo: 'O que mudou',
        oque: 'Um aviso que aparece quando chega uma versão nova que não foi você que fez.',
        como: 'Traz o resumo de uma linha e os botões Ver o que mudou, Desfazer e ok. Os trechos alterados ganham uma barra lateral colorida e a etiqueta "mudou" ou "novo" por uns 10 segundos.',
        porque: 'Você não precisa reler o roteiro inteiro para achar o que foi alterado.' },
      { alvo: '[data-dgr-tour="texto"]', titulo: 'O texto do roteiro',
        oque: 'O roteiro, parado no mesmo lugar. Versão nova entra aqui sem criar mensagem nova na conversa.',
        como: 'Toque em um parágrafo para editar só aquele trecho à mão e depois em Salvar. O que você digitar no campo da conversa vira um pedido de ajuste para ' + nomeAgente() + '.',
        porque: 'Ler fica num lugar só, e a conversa serve apenas para pedir os ajustes.' },
      { alvo: lado ? '[data-dgr-tour="acoes"]' : '[data-dgr-tour="mais"]', titulo: 'Desfazer, histórico e mais',
        oque: 'Os botões Ver o que mudou, Desfazer, Histórico, Editar tudo, Tutorial e Fechar' + (lado ? '.' : ' (no celular ficam neste botão de três pontinhos).'),
        como: 'Desfazer volta ao texto da versão anterior e a versão que você desfez continua guardada. O Histórico lista todas as versões e deixa comparar e voltar para qualquer uma.',
        porque: 'Nada se perde: você pode experimentar um ajuste e voltar atrás quando quiser.' },
      { alvo: '[data-dgr-tour="aprovar"]', titulo: 'Aprovar e mandar pra produção',
        oque: 'O botão que diz que o roteiro está pronto.',
        como: 'Pede uma confirmação, marca a versão como aprovada e avisa ' + nomeAgente() + '. Com o DG Social ligado, também aprova lá e libera a produção do conteúdo.',
        porque: 'É a sua palavra final: nada vai para a produção sem você apertar aqui.' },
      { alvo: '[data-dgr-tour="faixa"]', titulo: 'A faixa de baixo',
        oque: 'Uma linha logo acima do campo de digitar, com a última resposta de ' + nomeAgente() + ' ou o resumo da última versão.',
        como: 'Toque nela (ou arraste para cima) para esconder o roteiro e ver a conversa inteira. Toque na barra que fica no alto para o roteiro voltar.',
        porque: 'Você acompanha a resposta sem tirar os olhos do roteiro e, quando quiser a conversa toda, ela está a um toque.' },
    ];
    raiz.DGTour.inicia({ passos });
  }

  function tutorialSeletor() {
    if (!raiz.DGTour) { S.erroAcao = 'O tutorial não carregou nesta tela. Recarregue a página.'; renderAvisos(); return; }
    raiz.DGTour.inicia({ passos: [
      { alvo: '[data-dgr-tour="seletor"]', titulo: 'O seletor de roteiros',
        oque: 'O botão com o nome do roteiro aberto.', como: 'Tocando nele abre a lista, com busca pelo título e os roteiros agrupados pela situação.',
        porque: 'Com muitos roteiros em andamento, a busca e os grupos evitam ficar procurando.' },
      { alvo: '[data-dgr-tour="status"]', titulo: 'Versão e situação',
        oque: 'A versão atual, quem a fez e quando, mais a situação do roteiro.', como: 'Muda sozinho quando chega uma versão nova ou quando o roteiro é aprovado.',
        porque: 'Mostra se o que você está lendo é o mais recente.' },
    ] });
  }

  /* ───────────── iniciar ───────────── */

  function iniciar(ponte) {
    if (!ponte || typeof ponte.enviar !== 'function' || !ponte.agente) {
      console.warn('roteiro: iniciar() precisa de { agente, enviar, seletores }; recebi', ponte);
      return;
    }
    S.ponte = ponte; S.agente = ponte.agente; S.api = ponte.api || null;
    S.nomeAgente = ponte.nome || '';
    if (!S.nomeAgente) {
      chamar('GET', '/api/v1/agents').then(d => {
        const lista = Array.isArray(d) ? d : (d.agents || d.agentes || []);
        const a = lista.find(x => x.id === S.agente || x.slug === S.agente);
        if (a && a.nome) { S.nomeAgente = a.nome; if (S.el) renderTudo(); }
      }).catch(e => console.warn('roteiro: não consegui descobrir o nome do agente (uso o id):', e.message));
    }
    doc().addEventListener('visibilitychange', aoVisibilidade);

    let pedido = null;
    try { const q = new raiz.URLSearchParams(raiz.location.search); if (q.has('roteiro')) pedido = q.get('roteiro') || ''; } catch (_) { pedido = null; }   // URL ilegível: segue sem o parâmetro
    if (pedido !== null) {
      try {
        const u = new raiz.URL(raiz.location.href); u.searchParams.delete('roteiro');
        raiz.history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch (e) { console.warn('roteiro: não consegui limpar ?roteiro= da URL:', e.message); }
      abrir(pedido || null);
    } else {
      const ultimo = lerLS(chaveUltimo());
      if (ultimo) abrir(ultimo);
    }
    sondaAberto();
  }

  return {
    iniciar, abrir, fechar, ativo, prefixar, respostaDoAgente,
    // internos expostos para teste
    _diff: diffTexto, _md: mdParse, _blocos: dividirBlocos, _marcas: marcasDe, _filtrar: filtrarLista, _haQuando: haQuando,
    _estado: S,
  };
});
