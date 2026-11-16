'use strict';
/* contraste.js: a regra geral de "cor sobre cor" do design system.
   Dado um fundo, escolhe branco ou escuro (o que der MAIOR contraste WCAG) para o texto e o ícone.
   Os ícones do sprite usam currentColor, então basta a cor do texto: ícone e texto sempre andam juntos.

   Três usos:
   1. Tokens estáticos em tokens.css (--cor-sobre-*): os valores foram escolhidos por esta mesma regra,
      e web/test/contraste.test.js falha se algum par ficar abaixo do mínimo (4,5:1 texto, 3:1 ícone).
   2. Marca configurável (white label): dsContraste.sincronizarTokens() confere, no navegador, cada par
      fundo/sobre dos tokens já com o marca.css aplicado e corrige só o par que reprova. O servidor faz a mesma conta
      em web/lib/marca.js, então a página já chega certa, sem piscar.
   3. Fundo dinâmico (cor escolhida na hora): dsContraste.aplicar(elemento) ou dsContraste.aplicar(elemento, '#RRGGBB')
      pinta color do elemento; o ícone dentro herda por currentColor.

   Funciona no navegador (window.dsContraste) e no Node (require), para teste e para o servidor. */
(function (raiz) {
  const MIN_TEXTO = 4.5;
  const MIN_ICONE = 3;
  const BRANCO = '#ffffff';
  const ESCURO = '#1b2430'; // o grafite do sistema (--p-grafite)
  const PRETO = '#000000';

  /** '#rgb', '#rrggbb' ou 'rgb(r, g, b)' / 'rgba(...)' -> [r,g,b] (0 a 255). Devolve null se não entender. */
  function lerCor(c) {
    if (typeof c !== 'string') return null;
    const s = c.trim().toLowerCase();
    let m = /^#([0-9a-f]{6})$/.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
    m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
    if (m) {
      const alfa = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      if (alfa === 0) return null; // transparente: não há fundo para medir
      return [m[1], m[2], m[3]].map((n) => Math.min(255, parseInt(n, 10)));
    }
    return null;
  }

  /** Luminância relativa WCAG 2.x (0 = preto, 1 = branco). */
  function luminancia(cor) {
    const rgb = Array.isArray(cor) ? cor : lerCor(cor);
    if (!rgb) throw new Error('dsContraste: não entendi a cor ' + JSON.stringify(String(cor).slice(0, 40)) + '. Use #RRGGBB.');
    const [r, g, b] = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Razão de contraste WCAG entre duas cores (1 a 21). */
  function razao(a, b) {
    const la = luminancia(a);
    const lb = luminancia(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Branco ou escuro, o que contrasta mais com o fundo. Empate vai no escuro.
      Nos tons médios (um cinza-arroxeado, por exemplo) nem o branco nem o grafite chegam a 4,5:1; aí o preto
      puro é o último recurso, o único que garante o mínimo em qualquer fundo. */
  function corSobre(fundo) {
    const melhor = razao(fundo, BRANCO) > razao(fundo, ESCURO) ? BRANCO : ESCURO;
    return razao(fundo, melhor) >= MIN_TEXTO ? melhor : PRETO;
  }

  // ---- navegador ----
  const PARES_TOKENS = [
    // [fundo, texto/ícone]. Só entra aqui o que a marca configurável pode mudar.
    ['--cor-acento', '--cor-sobre-acento'],
    ['--cor-perigo', '--cor-sobre-perigo'],
    ['--cor-sucesso', '--cor-sobre-sucesso'],
    ['--cor-aviso', '--cor-sobre-aviso'],
    ['--cor-gravando', '--cor-sobre-gravando'],
    ['--cor-atencao', '--cor-sobre-atencao'],
    ['--botao-fundo', '--botao-texto'],
    ['--botao-perigo-fundo', '--botao-perigo-texto'],
  ];

  /** Fundo "de verdade" de um elemento: sobe pelos pais até achar um fundo opaco. */
  function fundoDe(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = lerCor(getComputedStyle(e).backgroundColor);
      if (c) return c;
    }
    return null;
  }

  /** Pinta a cor do texto/ícone de um elemento pelo fundo dele (ou pelo fundo dado). Devolve a cor escolhida. */
  function aplicar(el, fundo) {
    if (!el || !el.style) return null;
    const f = fundo ? lerCor(fundo) : fundoDe(el);
    if (!f) {
      if (typeof console !== 'undefined') console.warn('dsContraste.aplicar: não achei um fundo opaco para medir; deixei a cor como está.');
      return null;
    }
    const cor = corSobre(f);
    el.style.color = cor;
    return cor;
  }

  /** Confere cada par de tokens já resolvido pelo CSS (inclui o marca.css) e corrige o que reprova. */
  function sincronizarTokens(docRaiz) {
    const raizEl = docRaiz || document.documentElement;
    const cs = getComputedStyle(raizEl);
    const corrigidos = [];
    for (const [fundoTok, textoTok] of PARES_TOKENS) {
      const fundo = lerCor(cs.getPropertyValue(fundoTok).trim());
      if (!fundo) continue; // token que esta página não define
      const texto = lerCor(cs.getPropertyValue(textoTok).trim());
      if (texto && razao(fundo, texto) >= MIN_TEXTO) continue;
      raizEl.style.setProperty(textoTok, corSobre(fundo));
      corrigidos.push(textoTok);
    }
    return corrigidos;
  }

  const api = { MIN_TEXTO, MIN_ICONE, BRANCO, ESCURO, PRETO, PARES_TOKENS, lerCor, luminancia, razao, corSobre, aplicar, sincronizarTokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz && raiz.document) {
    raiz.dsContraste = Object.freeze(api);
    const rodar = () => { try { sincronizarTokens(); } catch (e) { if (raiz.console) raiz.console.warn('dsContraste.sincronizarTokens falhou: ' + e.message); } };
    if (raiz.document.readyState === 'loading') raiz.document.addEventListener('DOMContentLoaded', rodar); else rodar();
  }
})(typeof window !== 'undefined' ? window : null);
