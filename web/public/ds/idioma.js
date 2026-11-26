'use strict';
/* Internacionalização explícita: só textos de interface marcados no código.
   Nunca traduz conversas, nomes, arquivos ou respostas recebidas da API. */
(function (raiz, fabrica) {
  const api = fabrica(typeof module === 'object' && module.exports ? require('./idiomas') : raiz.DGIdiomas);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    raiz.DGI18n = api;
    api.iniciar(raiz);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (catalogo) {
  const normaliza = valor => valor === 'en' ? 'en' : 'pt-BR';
  const esc = valor => String(valor).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fontes = new Map(Object.entries(catalogo).map(([k, v]) => [v['pt-BR'], k]));
  const ingles = new Map(Object.entries(catalogo).map(([k, v]) => [v.en, k]));
  // O DOM possui os controles; o catálogo nunca mantém nós removidos vivos.
  // O marcador só permite enumerar controles conectados. A autoridade do vínculo
  // fica no WeakMap, portanto copiar o atributo em HTML externo não cria vínculo.
  const rotulos = new WeakMap();
  let atual = 'pt-BR';
  let janela;
  function texto(chave, idioma = atual) {
    const v = Object.hasOwn(catalogo, chave) && catalogo[chave];
    return v ? v[normaliza(idioma)] : chave;
  }
  function t(fonte, idioma = atual) { return fontes.has(fonte) ? texto(fontes.get(fonte), idioma) : fonte; }
  function frase(fonte, valores, idioma = atual) {
    return t(fonte, idioma).replace(/\{([a-z_][a-z_0-9]*)\}/g, (m, k) => valores && Object.hasOwn(valores, k) ? String(valores[k]) : m);
  }
  function parametros(valores) {
    const saida = Object.create(null);
    if (!valores || typeof valores !== 'object' || Array.isArray(valores)) return saida;
    for (const [nome, valor] of Object.entries(valores)) {
      if (!/^[a-z_][a-z_0-9]*$/.test(nome) || !['string', 'number', 'boolean'].includes(typeof valor)) continue;
      saida[nome] = valor;
    }
    return saida;
  }
  function fragmento(fonte, idioma = atual, valores) {
    if (idioma && typeof idioma === 'object') { valores = idioma; idioma = atual; }
    const k = fontes.get(fonte);
    if (k && valores) {
      const params = parametros(valores);
      return '<span data-dg-i18n-text="' + k + '" data-dg-i18n-vars="' + esc(JSON.stringify(params)) + '">' + esc(frase(fonte, params, idioma)) + '</span>';
    }
    return k ? '<!--dg-i18n:' + k + '-->' + esc(texto(k, idioma)) + '<!--/dg-i18n-->' : esc(fonte);
  }
  function rotulo(elemento, fonte, atributo, valores) {
    if (!elemento) return;
    const k = fontes.get(fonte) || ingles.get(fonte);
    // Só quem renderiza um rótulo de UI chama esta função; dados externos não
    // passam por ela. Rótulo não catalogado continua visível no idioma de origem.
    const props = rotulos.get(elemento) || new Map();
    const params = parametros(valores);
    if (k) props.set(atributo || '', { k, params });
    else props.delete(atributo || '');
    if (props.size) {
      rotulos.set(elemento, props);
      if (elemento.setAttribute) elemento.setAttribute('data-dg-i18n-vinculo', '');
    } else {
      rotulos.delete(elemento);
      if (elemento.removeAttribute) elemento.removeAttribute('data-dg-i18n-vinculo');
    }
    const valor = k ? frase(catalogo[k]['pt-BR'], params) : frase(fonte, params);
    if (atributo) elemento.setAttribute(atributo, valor);
    else elemento.textContent = valor;
  }
  // Só recebe templates do repositório, ANTES de inserir texto vindo de pessoas.
  function html(template, idioma = atual) {
    return String(template)
      .replace(/(<!--dg-i18n:([a-f0-9]{12})-->)[^<]*(<!--\/dg-i18n-->)/g,
        (todo, a, k, b) => Object.hasOwn(catalogo, k) ? a + esc(texto(k, idioma)) + b : todo)
      .replace(/<[^!][^>]*\sdata-dg-i18n-(?:title|placeholder|aria-label|alt)="[a-f0-9]{12}"[^>]*>/g, tag => {
        const marcas = [...tag.matchAll(/data-dg-i18n-(title|placeholder|aria-label|alt)="([a-f0-9]{12})"/g)];
        for (const [, atributo, k] of marcas) {
          if (Object.hasOwn(catalogo, k)) tag = tag.replace(new RegExp('(?<![\\w-])' + atributo + '="[^\"]*"'), atributo + '="' + esc(texto(k, idioma)) + '"');
        }
        return tag;
      })
      .replace(/(<title\s+data-dg-i18n="([a-f0-9]{12})">)[^<]*(<\/title>)/g,
        (todo, a, k, b) => Object.hasOwn(catalogo, k) ? a + esc(texto(k, idioma)) + b : todo);
  }
  function doCookie(cookie, padrao) {
    const m = /(?:^|;\s*)dgclaw_idioma=(pt-BR|en)(?:;|$)/.exec(String(cookie || ''));
    return m ? m[1] : normaliza(padrao);
  }
  function marca(valor) {
    // O nome configurado é dado, não chave de tradução; só substitui o marcador da marca.
    const el = janela.document.querySelector('meta[name="marca-nome"]');
    return valor.replaceAll('{{MARCA_NOME}}', el ? el.content : 'DG Claw');
  }
  function ignorado(el) {
    return el && el.closest && el.closest('[data-dg-i18n-ignore], #wrap, pre, code, textarea, [contenteditable]');
  }
  function aplicar(root) {
    if (!janela) return;
    const doc = janela.document;
    root = root || doc;
    const walker = doc.createTreeWalker(root, 128); // SHOW_COMMENT: apenas marcações explícitas.
    let no;
    while ((no = walker.nextNode())) {
      const m = /^dg-i18n:([a-f0-9]{12})$/.exec(no.data);
      const txt = no.nextSibling;
      if (!m || !Object.hasOwn(catalogo, m[1]) || !txt || txt.nodeType !== 3 || !txt.nextSibling || txt.nextSibling.nodeType !== 8 || txt.nextSibling.data !== '/dg-i18n' || ignorado(no.parentElement)) continue;
      txt.nodeValue = marca(texto(m[1]));
    }
    root.querySelectorAll('[data-dg-i18n-text]').forEach(el => {
      if (ignorado(el)) return;
      const k = el.getAttribute('data-dg-i18n-text');
      if (!Object.hasOwn(catalogo, k)) return;
      let vars;
      try { vars = parametros(JSON.parse(el.getAttribute('data-dg-i18n-vars') || '{}')); }
      catch (_) { return; } // HTML danificado não altera o texto já visível.
      el.textContent = frase(catalogo[k]['pt-BR'], vars);
    });
    root.querySelectorAll('[data-dg-i18n], [data-dg-i18n-title], [data-dg-i18n-placeholder], [data-dg-i18n-aria-label], [data-dg-i18n-alt]').forEach(el => {
      if (ignorado(el)) return;
      for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
        const k = el.getAttribute('data-dg-i18n-' + attr);
        if (k && Object.hasOwn(catalogo, k)) el.setAttribute(attr, marca(texto(k)));
      }
      const k = el.getAttribute('data-dg-i18n');
      if (el.tagName === 'TITLE' && k && Object.hasOwn(catalogo, k)) el.textContent = marca(texto(k));
    });
    doc.documentElement.lang = atual;
    for (const el of doc.querySelectorAll('[data-dg-i18n-vinculo]')) {
      const props = rotulos.get(el);
      if (!props) continue;
      for (const [atributo, dado] of props) {
        const valor = frase(catalogo[dado.k]['pt-BR'], dado.params);
        if (atributo) el.setAttribute(atributo, valor);
        else el.textContent = valor;
      }
    }
    doc.querySelectorAll('[data-dg-idioma-select]').forEach(el => { el.value = atual; });
  }
  function montar(root) {
    if (!janela) return;
    const doc = janela.document;
    const alvo = root || doc.getElementById('cabecalho') || doc.querySelector('.cartao, main, .principal') || doc.body;
    if (!alvo || doc.querySelector('[data-dg-idioma-select]')) return;
    const label = doc.createElement('label'); label.className = 'dg-idioma';
    const nome = doc.createElement('span'); nome.textContent = 'Idioma / Language';
    const select = doc.createElement('select'); select.setAttribute('data-dg-idioma-select', ''); select.setAttribute('aria-label', 'Idioma / Language');
    for (const [valor, rotulo] of [['pt-BR', 'Português (Brasil)'], ['en', 'English']]) {
      const opt = doc.createElement('option'); opt.value = valor; opt.textContent = rotulo; select.appendChild(opt);
    }
    select.value = atual;
    const aviso = doc.createElement('span'); aviso.className = 'dg-idioma-aviso'; aviso.setAttribute('role', 'status');
    select.addEventListener('change', () => {
      atual = normaliza(select.value);
      try {
        doc.cookie = 'dgclaw_idioma=' + atual + '; Path=/; Max-Age=31536000; SameSite=Lax' + (janela.location.protocol === 'https:' ? '; Secure' : '');
        const salvo = new RegExp('(?:^|;\\s*)dgclaw_idioma=' + atual + '(?:;|$)').test(doc.cookie);
        aviso.textContent = salvo ? '' : (atual === 'en' ? 'Language changed for this page. Browser did not save the preference.' : 'Idioma alterado nesta página. O navegador não salvou a preferência.');
      } catch (_) { aviso.textContent = atual === 'en' ? 'Browser could not save the language.' : 'O navegador não conseguiu salvar o idioma.'; }
      aplicar();
      janela.dispatchEvent(new janela.CustomEvent('dgclaw:idioma', { detail: { idioma: atual } }));
    });
    label.append(nome, select, aviso); alvo.appendChild(label);
  }
  function iniciar(win) {
    janela = win;
    const doc = win.document;
    atual = doCookie(doc.cookie, doc.documentElement.lang);
    const pronto = () => { aplicar(); montar(); };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', pronto, { once: true });
    else pronto();
  }
  return { normaliza, doCookie, texto, t, frase, rotulo, fragmento, html, aplicar, montar, iniciar, get idioma() { return atual; }, get locale() { return atual === 'en' ? 'en-US' : 'pt-BR'; } };
});
