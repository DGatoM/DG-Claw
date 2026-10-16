/* dgvis.js: base dos "Visuais na conversa" do DG Telegram.
   Roda no <head>, antes do HTML da agente. Sem dependências. Fala com o app por postMessage
   (protocolo em docs/ESPEC-VISUAIS.md, seção 3) e monta as peças dv-* (números, barras, linhas, ciclo,
   tabela, tempo e, na fase 2, abas, passos com play, acordeão, slider e opções).
   Fase 2: clique que volta para a agente. O iframe só PEDE (dgvis.perguntar / [data-pergunta]); quem
   confirma e envia é o app, com um toque do dono fora do iframe. */
(function () {
  'use strict';
  var W = window, D = document, ROOT = D.documentElement;
  // O código da agente roda depois e pode sujar globais: guardo o que uso.
  var JS = JSON, M = Math, Num = Number, Str = String, Arr = Array.prototype;
  var rAF = W.requestAnimationFrame.bind(W), cAF = W.cancelAnimationFrame.bind(W);
  var setT = W.setTimeout.bind(W), clrT = W.clearTimeout.bind(W);
  var setI = W.setInterval.bind(W), clrI = W.clearInterval.bind(W);
  var agora = function () { return W.performance && W.performance.now ? W.performance.now() : Date.now(); };
  var emb = !!(W.parent && W.parent !== W);

  var PECAS = '.dv-titulo,.dv-sub,.dv-numero,.dv-fluxo,.dv-ciclo,.dv-passos,.dv-compara,.dv-linha-tempo,.dv-tabela,.dv-barras,.dv-linhas,.dv-cartao,.dv-abas,.dv-acordeao,.dv-slider,.dv-opcoes';
  var CDNS = 'só cdn.jsdelivr.net e cdnjs.cloudflare.com são aceitos, e nenhum pedido de dados (fetch/XHR) é permitido';

  var estado = {
    tema: ROOT.getAttribute('data-tema') === 'escuro' ? 'escuro' : 'claro',
    reduzido: false,
    visivel: true,
    tela: false
  };
  var ouvintes = {};
  var iniciou = false, domPronto = false, queroIniciar = false, recebeuVisivel = false;
  var pausouGsap = false;

  ROOT.classList.add('dv-prep');

  // ---------- eventos ----------
  function emite(ev, v) {
    var l = ouvintes[ev];
    if (!l) return;
    l.slice().forEach(function (fn) { try { fn(v); } catch (e) { reportaErro('um ouvinte do evento "' + ev + '" falhou: ' + (e && e.message ? e.message : e)); } });
  }
  function on(ev, fn) {
    if (typeof fn !== 'function') return function () {};
    (ouvintes[ev] = ouvintes[ev] || []).push(fn);
    return function () { ouvintes[ev] = (ouvintes[ev] || []).filter(function (f) { return f !== fn; }); };
  }

  // ---------- mensagens para o app ----------
  function manda(obj) {
    if (!emb) return;
    obj.dgvis = 1;
    try { W.parent.postMessage(obj, '*'); } catch (e) { /* o app pode ter fechado o balão */ }
  }

  // ---------- erros ----------
  var errosVistos = {}, nErros = 0, tarja = null, tarjaMsgs = [];
  function mostraTarja(msg) {
    if (!D.body) { tarjaMsgs.push(msg); return; }
    tarjaMsgs.push(msg);
    if (!tarja) {
      tarja = D.createElement('div');
      tarja.className = 'dv-erro-tarja';
      D.body.appendChild(tarja);
    }
    tarja.textContent = 'O visual teve um erro: ' + tarjaMsgs[0] + (tarjaMsgs.length > 1 ? ' (e mais ' + (tarjaMsgs.length - 1) + ')' : '');
    agendaAltura();
  }
  function reportaErro(msg, extra) {
    msg = Str(msg).slice(0, 400);
    if (errosVistos[msg] || nErros >= 8) return;
    errosVistos[msg] = 1; nErros++;
    var o = { tipo: 'erro', msg: msg };
    if (extra) for (var k in extra) o[k] = extra[k];
    manda(o);
    // dentro do app o balão já mostra o erro numa tarja própria (com a linha); a
    // tarja interna fica só para o arquivo aberto direto, sem app em volta
    if (W.parent === W) mostraTarja(msg);
  }
  W.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== W && t.nodeType === 1) {
      var src = t.src || t.href || '';
      if (INJETADO.test(src)) return;
      reportaErro('o visual tentou carregar ' + (src || 'um arquivo') + ' e não conseguiu: confira o endereço (' + CDNS + ').');
      return;
    }
    var m = ev.message || 'erro sem mensagem';
    if (m === 'Script error.') m = 'um script de fora do arquivo falhou (o navegador não diz o motivo)';
    // a linha do navegador conta o documento montado (base + arquivo); o servidor diz
    // quantas linhas a base ocupa, e só erro do próprio documento é corrigido
    var ln = ev.lineno || 0, base = parseInt(D.documentElement.getAttribute('data-linhas-base'), 10);
    if (ln && base > 0 && (!ev.filename || ev.filename === W.location.href) && ln > base) ln -= base;
    reportaErro('o JavaScript do visual falhou: ' + m, ln ? { linha: ln } : null);
  }, true);
  W.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    reportaErro('uma promessa do visual foi rejeitada: ' + (r && r.message ? r.message : Str(r)));
  });
  // script que o proxy injeta (beacon do Cloudflare) não é do visual: bloqueado e calado
  var INJETADO = /cloudflareinsights\.com|\/cdn-cgi\//i;
  D.addEventListener('securitypolicyviolation', function (ev) {
    var dir = Str(ev.violatedDirective || ev.effectiveDirective || '');
    var alvo = ev.blockedURI || 'um recurso';
    if (INJETADO.test(Str(ev.blockedURI) + ' ' + Str(ev.sourceFile))) return;
    var m;
    if (dir.indexOf('connect-src') === 0) m = 'o visual tentou fazer um pedido de dados (fetch/XHR) para ' + alvo + ' e o sandbox bloqueou: ' + CDNS + '.';
    else if (dir.indexOf('img-src') === 0 || dir.indexOf('media-src') === 0) m = 'o visual tentou carregar ' + alvo + ' e o sandbox bloqueou: imagens e mídia só entram embutidas em data: ou blob:.';
    else if (dir.indexOf('form-action') === 0) m = 'o visual tentou enviar um formulário e o sandbox bloqueou: formulários não são permitidos.';
    else m = 'o visual tentou carregar ' + alvo + ' e o sandbox bloqueou (' + dir + '): ' + CDNS + '.';
    reportaErro(m);
  });

  // ---------- altura ----------
  var alturaPend = false, ultimaAltura = -1;
  function medeAltura() {
    var b = D.body, h = ROOT.getBoundingClientRect().height;
    if (b) {
      var cs = W.getComputedStyle(b);
      h = M.max(h, b.scrollHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0));
    }
    return M.ceil(h);
  }
  function agendaAltura() {
    if (alturaPend) return;
    alturaPend = true;
    rAF(function () {
      alturaPend = false;
      var h = medeAltura();
      if (h !== ultimaAltura) { ultimaAltura = h; manda({ tipo: 'altura', h: h }); }
    });
  }

  // ---------- movimento ----------
  var mq = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function aplicaReduzido() {
    estado.reduzido = !!(mq && mq.matches);
    ROOT.classList.toggle('dv-reduzido', estado.reduzido);
  }
  aplicaReduzido();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', aplicaReduzido);
    else if (mq.addListener) mq.addListener(aplicaReduzido);
  }

  // ---------- números ----------
  function formata(n, o) {
    o = o || {};
    n = Num(n);
    if (!isFinite(n)) return '';
    var opt = {};
    if (o.moeda) { opt.style = 'currency'; opt.currency = typeof o.moeda === 'string' ? o.moeda : 'BRL'; }
    if (o.casas != null && o.casas !== '') { opt.minimumFractionDigits = opt.maximumFractionDigits = Num(o.casas); }
    else if (!o.moeda) { opt.minimumFractionDigits = 0; opt.maximumFractionDigits = 2; }
    var txt;
    try { txt = new Intl.NumberFormat('pt-BR', opt).format(n); } catch (e) { txt = Str(n); }
    return (o.prefixo || '') + txt + (o.sufixo || '');
  }
  function compacto(n) {
    try { return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch (e) { return Str(n); }
  }
  function esc(s) { return Str(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function casasDe(raw) { var p = Str(raw).split(/[.,]/); return p.length > 1 ? p[1].length : 0; }
  function num(raw) { return parseFloat(Str(raw).replace(',', '.')); }

  // Anima de 0 a 1 contando só o tempo em que o visual está visível (pausa de verdade).
  function tween(dur, delay, passo, fim) {
    var t = 0, ult = agora(), esperando = delay || 0, cancelado = false, id = 0;
    function quadro() {
      if (cancelado) return;
      var n = agora(), dt = M.min(n - ult, 100); ult = n;
      if (estado.visivel) {
        if (esperando > 0) esperando -= dt;
        else t += dt;
      }
      var p = M.min(1, t / dur);
      passo(1 - M.pow(1 - p, 3));
      if (p < 1) id = rAF(quadro); else if (fim) fim();
    }
    passo(0);
    id = rAF(quadro);
    return function () { cancelado = true; cAF(id); };
  }
  function dur(ms) { return estado.reduzido ? ms * 0.5 : ms; }
  function atraso(el) { return (Num(el.style.getPropertyValue('--i')) || 0) * (estado.reduzido ? 35 : 70); }

  // ---------- peças ----------
  var pecas = [];   // {el, tipo, play}
  function tipoDe(el) {
    var c = el.classList;
    if (c.contains('dv-numero')) return 'numero';
    if (c.contains('dv-barras')) return 'barras';
    if (c.contains('dv-linhas')) return 'linhas';
    if (c.contains('dv-ciclo')) return 'ciclo';
    if (c.contains('dv-tabela')) return 'tabela';
    if (c.contains('dv-linha-tempo')) return 'tempo';
    if (c.contains('dv-passos') && el.hasAttribute('data-play')) return 'passos';
    if (c.contains('dv-abas')) return 'abas';
    if (c.contains('dv-acordeao')) return 'acordeao';
    if (c.contains('dv-slider')) return 'slider';
    if (c.contains('dv-opcoes')) return 'opcoes';
    if (c.contains('dv-fluxo') || c.contains('dv-passos') || c.contains('dv-compara')) return 'lista';
    return null;
  }
  function falhaPeca(el, nome, e) {
    reportaErro('o dgvis não conseguiu montar ' + nome + ': ' + (e && e.message ? e.message : e) + '. Confira os atributos data-* dessa peça.');
  }
  function numeraFilhos(el) {
    Arr.forEach.call(el.children, function (c, i) { c.style.setProperty('--k', i); });
  }

  function montaNumero(el) {
    var bruto = el.getAttribute('data-valor');
    var v = num(bruto);
    if (!isFinite(v)) throw new Error('data-valor "' + bruto + '" não é um número');
    var rot = el.querySelector('.dv-rotulo'), leg = el.querySelector('.dv-legenda');
    var o = { casas: el.getAttribute('data-casas'), prefixo: el.getAttribute('data-prefixo') || '', sufixo: el.getAttribute('data-sufixo') || '', moeda: el.getAttribute('data-moeda') };
    if (o.casas == null && !o.moeda) o.casas = casasDe(bruto);
    el.textContent = '';
    if (rot) el.appendChild(rot);
    var val = D.createElement('span'); val.className = 'dv-valor'; el.appendChild(val);
    var dl = el.getAttribute('data-delta');
    if (dl) {
      var d = D.createElement('span'); d.className = 'dv-delta ' + (/^\s*\+/.test(dl) ? 'pos' : /^\s*[-−]/.test(dl) ? 'neg' : '');
      d.textContent = dl; el.appendChild(d);
    }
    var mx = num(el.getAttribute('data-max'));
    var barra = null;
    if (isFinite(mx) && mx > 0) {
      barra = D.createElement('div'); barra.className = 'dv-barra';
      var i = D.createElement('i'); i.style.setProperty('--w', M.max(0, M.min(1, v / mx))); barra.appendChild(i);
      el.appendChild(barra);
    }
    if (leg) el.appendChild(leg);
    val.textContent = formata(v, o);
    el.setAttribute('aria-label', (rot ? rot.textContent + ': ' : '') + val.textContent);
    el._dv = { val: val, v: v, o: o, parar: null, ajustado: false };
    return function play() {
      var s = el._dv;
      if (s.parar) s.parar();
      val.textContent = formata(0, o);
      s.parar = tween(dur(1100), atraso(el) + (estado.reduzido ? 60 : 120), function (p) { val.textContent = formata(v * p, o); }, function () { val.textContent = formata(v, o); });
    };
  }
  function ajustaNumero(el) {
    var s = el._dv; if (!s || s.ajustado || !s.val.clientWidth) return;
    var cs = W.getComputedStyle(s.val), tam = parseFloat(cs.fontSize);
    var txt = s.val.textContent; s.val.textContent = formata(s.v, s.o);
    var n = 0;
    while (s.val.scrollWidth > s.val.clientWidth + 1 && tam > 14 && n++ < 40) { tam -= 1; s.val.style.fontSize = tam + 'px'; }
    s.val.textContent = txt; s.ajustado = true;
  }

  function montaBarras(el) {
    var filhos = Arr.slice.call(el.children).filter(function (c) { return c.hasAttribute('data-valor'); });
    if (!filhos.length) throw new Error('nenhum filho tem data-valor');
    var o = { prefixo: el.getAttribute('data-prefixo') || '', sufixo: el.getAttribute('data-unidade') || el.getAttribute('data-sufixo') || '', casas: el.getAttribute('data-casas'), moeda: el.getAttribute('data-moeda') };
    if (o.casas == null && !o.moeda) { var mc = 0; filhos.forEach(function (f) { mc = M.max(mc, casasDe(f.getAttribute('data-valor'))); }); o.casas = mc; }
    var vals = filhos.map(function (f) { return num(f.getAttribute('data-valor')); });
    if (vals.some(function (v) { return !isFinite(v); })) throw new Error('algum data-valor não é número');
    var mx = num(el.getAttribute('data-max'));
    if (!isFinite(mx) || mx <= 0) mx = M.max.apply(null, vals.concat([0])) || 1;
    var dest = filhos.some(function (f) { return f.hasAttribute('data-destaque'); });
    el.textContent = '';
    el.classList.toggle('tem-destaque', dest);
    var vs = [];
    filhos.forEach(function (f, i) {
      var l = D.createElement('div'); l.className = 'dv-barra-linha' + (f.hasAttribute('data-destaque') ? ' dest' : '');
      l.style.setProperty('--k', i);
      var cor = f.getAttribute('data-cor') || el.getAttribute('data-cor');
      if (cor) l.setAttribute('data-cor', cor);
      l.innerHTML = '<div class="dv-b-rot"></div><div class="dv-b-trilho"><i></i></div><div class="dv-b-val"></div>';
      l.firstChild.textContent = f.getAttribute('data-rotulo') || '';
      l.querySelector('i').style.setProperty('--w', M.max(0, M.min(1, vals[i] / mx)));
      var ve = l.lastChild; ve.textContent = formata(vals[i], o);
      vs.push({ ve: ve, v: vals[i] });
      el.appendChild(l);
    });
    var ml = 0; vs.forEach(function (x) { ml = M.max(ml, x.ve.textContent.length); });
    el.style.setProperty('--vw', (ml * 0.62 + 0.3).toFixed(1) + 'em');
    el._dv = { vs: vs, o: o, parar: [] };
    return function play() {
      var s = el._dv;
      s.parar.forEach(function (p) { p(); }); s.parar = [];
      vs.forEach(function (x, i) {
        s.parar.push(tween(dur(1100), atraso(el) + 120 + i * (estado.reduzido ? 45 : 90), function (p) { x.ve.textContent = formata(x.v * p, o); }, function () { x.ve.textContent = formata(x.v, o); }));
      });
    };
  }

  function montaTabela(el) {
    var ths = Arr.map.call(el.querySelectorAll('thead th'), function (t) { return t.textContent.trim(); });
    Arr.forEach.call(el.querySelectorAll('tr'), function (tr) {
      Arr.forEach.call(tr.children, function (td, i) {
        if (td.tagName === 'TD' && !td.hasAttribute('data-rotulo') && ths[i]) td.setAttribute('data-rotulo', ths[i]);
      });
    });
    return null;
  }

  // Gráfico de linhas em SVG. Desenha de novo quando a largura muda, sem repetir a animação.
  var uid = 0;
  function montaLinhas(el) {
    var rot, ser;
    try { rot = JS.parse(el.getAttribute('data-rotulos') || '[]'); } catch (e) { throw new Error('data-rotulos não é JSON válido (use aspas simples no atributo e aspas duplas dentro)'); }
    try { ser = JS.parse(el.getAttribute('data-series') || '[]'); } catch (e) { throw new Error('data-series não é JSON válido'); }
    if (!ser.length || !ser[0].valores || !ser[0].valores.length) throw new Error('data-series precisa de [{"nome":"…","valores":[…]}]');
    var o = { prefixo: el.getAttribute('data-prefixo') || '', sufixo: el.getAttribute('data-unidade') || el.getAttribute('data-sufixo') || '', casas: el.getAttribute('data-casas'), moeda: el.getAttribute('data-moeda') };
    var id = 'dvg' + (++uid), st = { larg: 0, feito: false };
    var tip, cruz, pts = [];
    function desenha() {
      // dentro de aba fechada ou acordeão fechado a largura é 0: desenha provisório e refaz ao aparecer
      var real = M.round(el.clientWidth);
      if (!real && st.larg) return;
      var w = real || 320;
      if (w === st.larg && !st.prov) return;
      var primeiro = !st.larg || st.prov; st.larg = w; st.prov = !real;
      var h = w < 420 ? 210 : 250, n = M.max.apply(null, ser.map(function (s) { return s.valores.length; }));
      var todos = []; ser.forEach(function (s) { s.valores.forEach(function (v) { if (isFinite(Num(v))) todos.push(Num(v)); }); });
      var ymin = M.min(0, M.min.apply(null, todos)), ymax = M.max.apply(null, todos);
      if (ymax === ymin) ymax = ymin + 1;
      var passo = bonito((ymax - ymin) / 4); ymax = M.ceil(ymax / passo) * passo; ymin = M.floor(ymin / passo) * passo;
      var ticks = []; for (var t = ymin; t <= ymax + passo / 1000; t += passo) ticks.push(t);
      var maxLab = 0; ticks.forEach(function (t) { maxLab = M.max(maxLab, compacto(t).length); });
      var pe = M.max(34, 10 + maxLab * 6.6), pd = 12, pt = 10, pb = 26;
      var iw = w - pe - pd, ih = h - pt - pb;
      var X = function (i) { return pe + (n > 1 ? i * iw / (n - 1) : iw / 2); };
      var Y = function (v) { return pt + ih - (v - ymin) / (ymax - ymin) * ih; };
      var s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img"><defs>';
      s += '<linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--dv-c1)" stop-opacity=".22"/><stop offset="1" stop-color="var(--dv-c1)" stop-opacity="0"/></linearGradient></defs>';
      ticks.forEach(function (t) {
        s += '<line class="dv-grade-y" x1="' + pe + '" x2="' + (w - pd) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/>';
        s += '<text class="dv-eixo" x="' + (pe - 8) + '" y="' + (Y(t) + 4).toFixed(1) + '" text-anchor="end">' + esc(compacto(t)) + '</text>';
      });
      var ml = 3; for (var li = 0; li < n; li++) ml = M.max(ml, Str(rot[li] != null ? rot[li] : li + 1).length);
      var cada = M.max(1, M.ceil(n * (ml * 6.4 + 14) / iw));
      for (var i = 0; i < n; i += cada) {
        var anc = i === 0 && n > 1 ? 'start' : (i + cada >= n && n > 1 && i === n - 1 ? 'end' : 'middle');
        s += '<text class="dv-eixo" x="' + X(i).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="' + anc + '">' + esc(rot[i] != null ? rot[i] : i + 1) + '</text>';
      }
      s += '<line class="dv-cruz" y1="' + pt + '" y2="' + (pt + ih) + '"/>';
      ser.forEach(function (sr, si) {
        var cor = 'var(--dv-c' + ((si % 6) + 1) + ')';
        var d = '', pontos = [];
        sr.valores.forEach(function (v, i) { if (v == null || !isFinite(Num(v))) return; var x = X(i).toFixed(1), y = Y(Num(v)).toFixed(1); d += (d ? 'L' : 'M') + x + ' ' + y; pontos.push([x, y, i]); });
        if (ser.length === 1 && pontos.length > 1) s += '<path class="dv-area" style="--cor:' + cor + '" d="' + d + 'L' + pontos[pontos.length - 1][0] + ' ' + (pt + ih) + 'L' + pontos[0][0] + ' ' + (pt + ih) + 'Z" fill="url(#' + id + ')"/>';
        s += '<path class="dv-serie" pathLength="1" style="--cor:' + cor + ';--s:' + si + '" d="' + d + '"/>';
        if (n <= 14) pontos.forEach(function (p, pi) { s += '<circle class="dv-pt" style="--cor:' + cor + ';--s:' + si + ';--p:' + pi + '" cx="' + p[0] + '" cy="' + p[1] + '" r="3.8"/>'; });
      });
      s += '<rect x="' + pe + '" y="' + pt + '" width="' + iw + '" height="' + ih + '" fill="transparent" class="dv-alvo"/></svg>';
      var svgBox = el.querySelector('.dv-svg-box');
      svgBox.innerHTML = s;
      el._dv.geo = { pe: pe, iw: iw, pt: pt, ih: ih, n: n, X: X, Y: Y, w: w, h: h };
      var svg = svgBox.firstChild; cruz = svg.querySelector('.dv-cruz');
      var mover = function (ev) {
        var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * (w / r.width);
        var i = M.max(0, M.min(n - 1, M.round((x - pe) / (n > 1 ? iw / (n - 1) : 1))));
        mostra(i);
      };
      var alvo = svg.querySelector('.dv-alvo');
      alvo.addEventListener('pointermove', mover); alvo.addEventListener('pointerdown', mover);
      alvo.addEventListener('pointerleave', esconde);
      if (!primeiro) el.classList.add('dv-feito');
    }
    function mostra(i) {
      var g = el._dv.geo; if (!g) return;
      var x = g.X(i);
      cruz.setAttribute('x1', x); cruz.setAttribute('x2', x); cruz.style.opacity = 1;
      var h = '<b>' + esc(rot[i] != null ? rot[i] : i + 1) + '</b>';
      ser.forEach(function (sr, si) {
        var v = sr.valores[i]; if (v == null) return;
        h += '<div><i style="--cor:var(--dv-c' + ((si % 6) + 1) + ')"></i>' + (ser.length > 1 ? esc(sr.nome || '') + ': ' : '') + '<strong>' + esc(formata(v, o)) + '</strong></div>';
      });
      tip.innerHTML = h; tip.style.opacity = 1;
      var tw = tip.offsetWidth, px = x * (el.clientWidth / g.w);
      tip.style.left = M.max(0, M.min(el.clientWidth - tw, px - tw / 2)) + 'px';
      tip.style.top = (el.querySelector('.dv-svg-box').offsetTop + 4) + 'px';
    }
    function esconde() { if (cruz) cruz.style.opacity = 0; tip.style.opacity = 0; }

    el.textContent = '';
    if (ser.length > 1) {
      var leg = D.createElement('div'); leg.className = 'dv-linhas-leg';
      ser.forEach(function (sr, si) { var sp = D.createElement('span'); sp.style.setProperty('--cor', 'var(--dv-c' + ((si % 6) + 1) + ')'); sp.innerHTML = '<i></i>'; sp.appendChild(D.createTextNode(sr.nome || ('Série ' + (si + 1)))); leg.appendChild(sp); });
      el.appendChild(leg);
    }
    var box = D.createElement('div'); box.className = 'dv-svg-box'; el.appendChild(box);
    tip = D.createElement('div'); tip.className = 'dv-tip'; el.appendChild(tip);
    el._dv = { redesenha: desenha };
    desenha();
    if (W.ResizeObserver) { var ro = new W.ResizeObserver(function () { rAF(desenha); }); ro.observe(el); }
    return null;
  }
  function bonito(x) {
    var e = M.floor(M.log(x) / M.LN10), f = x / M.pow(10, e);
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * M.pow(10, e);
  }

  // Ciclo: anel com setas no largo, lista com seta de volta no estreito.
  function montaCiclo(el) {
    var itens = Arr.map.call(el.children, function (c) {
      var b = c.querySelector('b'), p = c.querySelector('p');
      return { ico: c.getAttribute('data-ico') || '', cor: c.getAttribute('data-cor') || '', t: b ? b.textContent : (p ? '' : c.textContent.trim()), p: p ? p.textContent : '' };
    });
    if (itens.length < 2) throw new Error('o ciclo precisa de pelo menos 2 itens');
    var centro = el.getAttribute('data-centro') || '', st = { modo: '', tam: 0 };
    function desenha() {
      var real = M.round(el.clientWidth);
      if (!real && st.modo) return;
      var w = real || 320, modo = w < 440 ? 'lista' : 'anel';
      var tam = M.min(w, 480);
      if (modo === st.modo && (modo === 'lista' || tam === st.tam) && !st.prov) return;
      var primeiro = !st.modo || st.prov; st.modo = modo; st.tam = tam; st.prov = !real;
      el.textContent = '';
      if (modo === 'lista') {
        var ol = D.createElement('ol'); ol.className = 'dv-ciclo-lista';
        itens.forEach(function (it, i) {
          var li = D.createElement('li'); li.style.setProperty('--k', i);
          if (it.ico) li.setAttribute('data-ico', it.ico);
          if (it.cor) li.setAttribute('data-cor', it.cor);
          var b = D.createElement('b'); b.textContent = it.t; li.appendChild(b);
          if (it.p) { var p = D.createElement('p'); p.textContent = it.p; li.appendChild(p); }
          ol.appendChild(li);
        });
        var v = D.createElement('li'); v.className = 'dv-volta'; v.style.setProperty('--k', itens.length);
        var vb = D.createElement('b'); vb.textContent = 'e volta ao começo' + (itens[0].t ? ': ' + itens[0].t : ''); v.appendChild(vb);
        ol.appendChild(v);
        el.appendChild(ol);
      } else {
        var n = itens.length, c = tam / 2, R = c - 46;
        var nw = M.min(tam * 0.27, 2 * R * M.sin(M.PI / n) * 0.95);
        var anel = D.createElement('div'); anel.className = 'dv-anel'; anel.style.width = anel.style.height = tam + 'px';
        var svg = '<svg viewBox="0 0 ' + tam + ' ' + tam + '">';
        var ang = function (i) { return -M.PI / 2 + 2 * M.PI * i / n; };
        for (var i = 0; i < n; i++) {
          var a1 = ang(i), a2 = ang(i + 1), am = (a1 + a2) / 2;
          var x1 = c + R * M.cos(a1), y1 = c + R * M.sin(a1), x2 = c + R * M.cos(a2), y2 = c + R * M.sin(a2);
          svg += '<path class="dv-arco" pathLength="1" style="--k:' + i + '" d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'A' + R + ' ' + R + ' 0 0 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '"/>';
          var mx = c + R * M.cos(am), my = c + R * M.sin(am), tx = -M.sin(am), ty = M.cos(am), nx = M.cos(am), ny = M.sin(am);
          var pp = [mx + tx * 8, my + ty * 8, mx - tx * 5 + nx * 6, my - ty * 5 + ny * 6, mx - tx * 5 - nx * 6, my - ty * 5 - ny * 6].map(function (q) { return q.toFixed(1); });
          svg += '<polygon class="dv-seta" style="--k:' + i + '" points="' + pp[0] + ',' + pp[1] + ' ' + pp[2] + ',' + pp[3] + ' ' + pp[4] + ',' + pp[5] + '"/>';
        }
        anel.innerHTML = svg + '</svg>';
        itens.forEach(function (it, i) {
          var no = D.createElement('div'); no.className = 'dv-no'; no.style.setProperty('--k', i);
          no.style.left = (c + R * M.cos(ang(i))).toFixed(1) + 'px'; no.style.top = (c + R * M.sin(ang(i))).toFixed(1) + 'px'; no.style.width = nw.toFixed(0) + 'px';
          if (it.cor) no.setAttribute('data-cor', it.cor);
          var h = it.ico ? '<span class="dv-ico"></span>' : '';
          no.innerHTML = h + '<b></b>' + (it.p ? '<p></p>' : '');
          if (it.ico) no.firstChild.textContent = it.ico;
          no.querySelector('b').textContent = it.t;
          if (it.p) no.querySelector('p').textContent = it.p;
          anel.appendChild(no);
        });
        if (centro) { var ce = D.createElement('div'); ce.className = 'dv-centro'; ce.textContent = centro; anel.appendChild(ce); }
        el.appendChild(anel);
      }
      if (!primeiro) el.classList.add('dv-feito');
      agendaAltura();
    }
    el._dv = { redesenha: desenha };
    desenha();
    if (W.ResizeObserver) { var ro = new W.ResizeObserver(function () { rAF(desenha); }); ro.observe(el); }
    return null;
  }

  function montaTempo(el) {
    Arr.forEach.call(el.children, function (m, i) {
      m.classList.add('dv-marco'); m.style.setProperty('--k', i);
      var d = m.getAttribute('data-data');
      if (d && !m.querySelector('.dv-data')) { var s = D.createElement('span'); s.className = 'dv-data'; s.textContent = d; m.insertBefore(s, m.firstChild); }
    });
    return null;
  }


  // ---------- clique que volta para a agente ----------
  // O iframe nunca manda mensagem sozinho: ele PEDE e o app abre uma barrinha de confirmação.
  var pedidos = {}, perguntaSeq = 0, vivo = null;
  var ROT_ERRO = {
    vazio: 'texto vazio', longo: 'texto longo demais', html: 'texto não aceito', rapido: 'espere um pouco',
    limite: 'confirme ou cancele o anterior no app', ocupado: 'já tem um pedido aberto',
    fora: 'só com o visual na tela', cancelado: 'cancelado', envio: 'não enviou, tente de novo',
    sigilo: 'indisponível agora', indisponivel: 'indisponível agora'
  };
  function anuncia(t) {
    if (!D.body) return;
    if (!vivo) {
      vivo = D.createElement('div'); vivo.className = 'dv-sr';
      vivo.setAttribute('role', 'status'); vivo.setAttribute('aria-live', 'polite');
      D.body.appendChild(vivo);
    }
    vivo.textContent = t;
  }
  function pEstado(el, st, rot, ms) {
    if (el._dvT) { clrT(el._dvT); el._dvT = 0; }
    var l = el._dvRot;
    if (!st) {
      el.removeAttribute('data-dv-pergunta');
      if (l) l.textContent = '';
      agendaAltura(); return;
    }
    if (!l) { l = D.createElement('span'); l.className = 'dv-pergunta-rot'; el.appendChild(l); el._dvRot = l; }
    el.setAttribute('data-dv-pergunta', st); l.textContent = rot; anuncia(rot);
    if (ms) el._dvT = setT(function () { el._dvT = 0; pEstado(el, null); }, ms);
    agendaAltura();
  }
  function perguntar(texto, el) {
    texto = Str(texto == null ? '' : texto);
    if (!el || el.nodeType !== 1) el = null;
    if (!emb) { if (el) pEstado(el, 'erro', 'só funciona dentro do DG Telegram', 3000); return -1; }
    if (!texto.trim()) { if (el) pEstado(el, 'erro', ROT_ERRO.vazio, 4000); return -1; }
    var id = ++perguntaSeq;
    pedidos[id] = { el: el };
    manda({ tipo: 'pergunta', texto: texto.slice(0, 2000), id: id });
    if (el) {
      el._dvPedido = id;
      pEstado(el, 'espera', 'enviando…');
      // app antigo ou sem resposta: não deixa o botão preso em "enviando"
      el._dvT = setT(function () {
        el._dvT = 0;
        if (el._dvPedido === id && el.getAttribute('data-dv-pergunta') === 'espera') {
          delete pedidos[id]; el._dvPedido = 0; pEstado(el, 'erro', 'o app não respondeu', 4000);
        }
      }, 6000);
    }
    return id;
  }
  function marcaEscolha(el) {
    var c = el.closest('.dv-opcoes');
    if (!c) return;
    Arr.forEach.call(c.children, function (x) {
      if (!x.hasAttribute('data-pergunta')) return;
      var sel = x === el;
      x.classList.toggle('dv-escolhida', sel);
      x.setAttribute('aria-pressed', sel ? 'true' : 'false');
    });
    c.classList.add('dv-tem-escolha');
  }
  function aoPergunta(d, novo) {
    var id = Num(d.id), p = pedidos[id];
    if (!p) return;
    var el = p.el, motivo = d.motivo ? Str(d.motivo) : '';
    if (novo === 'confirme') {
      if (el) pEstado(el, 'confirme', 'confirme no app ↓', 90000);
    } else {
      delete pedidos[id];
      if (el) {
        el._dvPedido = 0;
        if (novo === 'ok') { pEstado(el, 'ok', 'enviado ✓', 4000); marcaEscolha(el); }
        else pEstado(el, 'erro', ROT_ERRO[motivo] || 'não foi enviado', 4000);
      }
    }
    emite('pergunta', { id: id, estado: novo, motivo: motivo, el: el });
  }
  function dispara(el) {
    var st = el.getAttribute('data-dv-pergunta'), t = agora();
    if (st === 'espera' || st === 'confirme') return;
    if (el._dvUlt && t - el._dvUlt < 800) return;
    el._dvUlt = t;
    perguntar(el.getAttribute('data-pergunta'), el);
  }
  function preparaPergunta(el) {
    if (el.tagName === 'BUTTON') { if (!el.getAttribute('type')) el.setAttribute('type', 'button'); return; }
    if (el.tagName === 'A') return;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  }
  D.addEventListener('click', function (ev) {
    var t = ev.target, el = t && t.closest ? t.closest('[data-pergunta]') : null;
    if (!el) return;
    ev.preventDefault();
    dispara(el);
  }, true);
  D.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || !el.hasAttribute('data-pergunta') || el.tagName === 'BUTTON') return;
    if (el.tagName === 'A' && el.hasAttribute('href') && ev.key === 'Enter') return;
    ev.preventDefault();
    dispara(el);
  }, true);

  // ---------- peças da fase 2 ----------
  // Dentro de aba fechada ou acordeão fechado nada é medido nem animado: anima quando aparece.
  function escondida(el) {
    if (el.closest('[data-aba][hidden]')) return true;
    var d = el.closest('details:not([open])');
    return !!(d && !el.closest('summary'));
  }

  function montaAbas(el) {
    var paineis = Arr.filter.call(el.children, function (c) { return c.hasAttribute('data-aba'); });
    if (!paineis.length) throw new Error('nenhum filho tem data-aba="Rótulo"');
    var base = 'dvab' + (++uid), tabs = [], atual = -1;
    var ini = M.max(1, M.min(paineis.length, parseInt(el.getAttribute('data-inicial'), 10) || 1)) - 1;
    var lista = D.createElement('div'); lista.className = 'dv-abas-lista'; lista.setAttribute('role', 'tablist');
    paineis.forEach(function (p, i) {
      var b = D.createElement('button');
      b.type = 'button'; b.className = 'dv-aba'; b.setAttribute('role', 'tab');
      b.id = base + 't' + i; b.textContent = p.getAttribute('data-aba') || ('Aba ' + (i + 1));
      if (!p.id) p.id = base + 'p' + i;
      b.setAttribute('aria-controls', p.id);
      p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', b.id); p.setAttribute('tabindex', '0');
      b.addEventListener('click', function () { vai(i, true); });
      tabs.push(b); lista.appendChild(b);
    });
    lista.addEventListener('keydown', function (ev) {
      var k = ev.key, n = tabs.length, i = atual;
      if (k === 'ArrowRight' || k === 'ArrowDown') i = (i + 1) % n;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') i = (i - 1 + n) % n;
      else if (k === 'Home') i = 0;
      else if (k === 'End') i = n - 1;
      else return;
      ev.preventDefault(); vai(i, true); tabs[i].focus();
    });
    el.insertBefore(lista, el.firstChild);
    function vai(i, interativo) {
      if (i === atual) return;
      var antes = atual; atual = i;
      paineis.forEach(function (p, k) {
        var ativo = k === i;
        p.hidden = !ativo;
        tabs[k].setAttribute('aria-selected', ativo ? 'true' : 'false');
        tabs[k].tabIndex = ativo ? 0 : -1;
      });
      var p = paineis[i];
      if (interativo) { p.classList.remove('dv-aba-entra'); void p.offsetWidth; p.classList.add('dv-aba-entra'); }
      if (antes < 0) p._dvVisto = true;
      else if (!p._dvVisto) { p._dvVisto = true; anima(p); }
      else Arr.forEach.call(p.querySelectorAll(PECAS), function (c) { c.classList.add('dv-feito'); });
      agendaAltura();
    }
    vai(ini, false);
    return null;
  }

  function montaAcordeao(el) {
    var itens = Arr.filter.call(el.children, function (c) { return c.tagName === 'DETAILS'; });
    if (!itens.length) throw new Error('nenhum filho é <details><summary>Título</summary>…</details>');
    var unico = el.hasAttribute('data-unico');
    function corpoDe(det) { return det.querySelector(':scope > .dv-ac-corpo'); }
    function abre(det) {
      det.open = true;
      var corpo = corpoDe(det);
      if (!corpo || estado.reduzido || !corpo.animate) return;
      var h = corpo.offsetHeight;
      corpo.style.overflow = 'hidden';
      var a = corpo.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
      det._dvAnim = a;
      a.onfinish = a.oncancel = function () { corpo.style.overflow = ''; det._dvAnim = null; agendaAltura(); };
    }
    function fecha(det) {
      var corpo = corpoDe(det);
      if (!corpo || estado.reduzido || !corpo.animate) { det.open = false; return; }
      var h = corpo.offsetHeight;
      corpo.style.overflow = 'hidden';
      var a = corpo.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 220, easing: 'ease', fill: 'forwards' });
      det._dvAnim = a;
      a.onfinish = function () { det.open = false; a.cancel(); };
      a.oncancel = function () { corpo.style.overflow = ''; det._dvAnim = null; agendaAltura(); };
    }
    itens.forEach(function (det) {
      var sum = det.querySelector(':scope > summary');
      if (!sum) throw new Error('um <details> está sem <summary>');
      var corpo = D.createElement('div'); corpo.className = 'dv-ac-corpo';
      var dentro = D.createElement('div'); dentro.className = 'dv-ac-in';
      Arr.slice.call(det.childNodes).forEach(function (n) { if (n !== sum) dentro.appendChild(n); });
      corpo.appendChild(dentro); det.appendChild(corpo);
      det._dvVisto = det.open;
      sum.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (det._dvAnim) return;
        if (det.open) fecha(det); else abre(det);
      });
      det.addEventListener('toggle', function () {
        if (det.open) {
          if (!det._dvVisto) { det._dvVisto = true; anima(corpo); }
          if (unico) itens.forEach(function (o) { if (o !== det && o.open && !o._dvAnim) fecha(o); });
        }
        agendaAltura();
      });
    });
    return null;
  }

  function montaSlider(el) {
    function attr(n, pad) {
      var raw = el.getAttribute(n);
      if (raw == null || raw === '') return pad;
      var v = num(raw);
      if (!isFinite(v)) throw new Error(n + ' "' + raw + '" não é um número');
      return v;
    }
    var mn = attr('data-min', 0), mx = attr('data-max', 100), pa = attr('data-passo', 1), v0 = attr('data-valor', mn);
    if (!(mx > mn)) throw new Error('data-max (' + mx + ') precisa ser maior que data-min (' + mn + ')');
    if (!(pa > 0)) throw new Error('data-passo precisa ser maior que zero');
    v0 = M.max(mn, M.min(mx, v0));
    var o = { casas: el.getAttribute('data-casas'), prefixo: el.getAttribute('data-prefixo') || '', sufixo: el.getAttribute('data-sufixo') || '', moeda: el.getAttribute('data-moeda') };
    if (o.casas == null && !o.moeda) o.casas = M.max(casasDe(el.getAttribute('data-passo') || ''), casasDe(el.getAttribute('data-min') || ''));
    var leg = el.querySelector('.dv-legenda');
    var id = 'dvsl' + (++uid);
    el.textContent = '';
    var rot = D.createElement('label'); rot.className = 'dv-rotulo'; rot.setAttribute('for', id);
    rot.textContent = el.getAttribute('data-rotulo') || '';
    var out = D.createElement('output'); out.className = 'dv-valor'; out.setAttribute('for', id);
    var inp = D.createElement('input'); inp.type = 'range'; inp.id = id; inp.className = 'dv-sl-in';
    inp.min = mn; inp.max = mx; inp.step = pa; inp.value = v0;
    if (rot.textContent) inp.setAttribute('aria-label', rot.textContent);
    var ext = D.createElement('div'); ext.className = 'dv-sl-ext';
    var e1 = D.createElement('span'), e2 = D.createElement('span');
    e1.textContent = formata(mn, o); e2.textContent = formata(mx, o); ext.appendChild(e1); ext.appendChild(e2);
    if (rot.textContent) el.appendChild(rot);
    el.appendChild(out); el.appendChild(inp); el.appendChild(ext);
    if (leg) el.appendChild(leg);
    var atual = v0;
    function sync(avisa) {
      var v = Num(inp.value), txt = formata(v, o);
      atual = v;
      out.textContent = txt; inp.setAttribute('aria-valuetext', txt);
      el.style.setProperty('--f', (v - mn) / (mx - mn));
      if (el.id) {
        Arr.forEach.call(D.querySelectorAll('[data-dv-mostra]'), function (m) { if (m.getAttribute('data-dv-mostra') === el.id) m.textContent = txt; });
      }
      if (avisa) {
        try { el.dispatchEvent(new W.CustomEvent('dv-valor', { detail: { valor: v }, bubbles: true })); } catch (e) { reportaErro('um ouvinte do evento dv-valor falhou: ' + (e && e.message ? e.message : e)); }
        emite('slider', { el: el, valor: v });
      }
    }
    Object.defineProperty(el, 'dvValor', {
      configurable: true,
      get: function () { return atual; },
      set: function (x) { x = num(x); if (isFinite(x)) { inp.value = x; sync(true); } }
    });
    inp.addEventListener('input', function () { sync(true); });
    sync(true);
    return null;
  }

  function montaOpcoes(el) {
    var botoes = Arr.filter.call(el.children, function (c) { return c.hasAttribute('data-pergunta'); });
    if (!botoes.length) throw new Error('nenhum filho tem data-pergunta="texto que vai para a agente"');
    numeraFilhos(el);
    var tit = el.getAttribute('data-titulo');
    if (tit) {
      var t = D.createElement('div'); t.className = 'dv-opcoes-titulo'; t.id = 'dvot' + (++uid); t.textContent = tit;
      el.insertBefore(t, el.firstChild);
      el.setAttribute('role', 'group'); el.setAttribute('aria-labelledby', t.id);
    }
    botoes.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    return null;
  }

  var ICO = {
    ant: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.5v14H6zM19 5v14L9 12z"/></svg>',
    prox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5H18v14h-2.5zM5 5v14l10-7z"/></svg>',
    toca: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    pausa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
  };
  function montaPassosPlay(el) {
    var itens = Arr.slice.call(el.children), n = itens.length;
    if (n < 2) throw new Error('data-play precisa de pelo menos 2 passos');
    var padMs = num(el.getAttribute('data-ms'));
    if (!isFinite(padMs) || padMs < 300) padMs = 2600;
    var loop = el.hasAttribute('data-loop');
    var s = { i: 0, tocando: false, acum: 0, auto: false, timer: 0, noView: true };
    el._dv = s;
    var barra = D.createElement('div'); barra.className = 'dv-controles';
    barra.setAttribute('role', 'group'); barra.setAttribute('aria-label', 'Controles dos passos');
    function botao(cls, rot, ico) {
      var b = D.createElement('button'); b.type = 'button'; b.className = cls; b.setAttribute('aria-label', rot); b.innerHTML = ico;
      barra.appendChild(b); return b;
    }
    var bAnt = botao('dv-ctl', 'Passo anterior', ICO.ant), bPlay = botao('dv-ctl dv-ctl-play', 'Tocar', ICO.toca), bProx = botao('dv-ctl', 'Próximo passo', ICO.prox);
    var cont = D.createElement('span'); cont.className = 'dv-contagem'; barra.appendChild(cont);
    el.parentNode.insertBefore(barra, el.nextSibling);

    function msDe(k) { var m = num(itens[k].getAttribute('data-ms')); return isFinite(m) && m >= 300 ? m : padMs; }
    function pinta() {
      itens.forEach(function (li, k) {
        li.classList.toggle('dv-atual', k === s.i);
        li.classList.toggle('dv-passado', k < s.i);
        li.classList.toggle('dv-futuro', k > s.i);
        if (k === s.i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      cont.textContent = (s.i + 1) + ' de ' + n;
      bAnt.disabled = s.i === 0; bProx.disabled = s.i === n - 1;
      bPlay.innerHTML = s.tocando ? ICO.pausa : ICO.toca;
      bPlay.setAttribute('aria-label', s.tocando ? 'Pausar' : 'Tocar');
    }
    function vai(k) {
      if (k < 0 || k >= n) return;
      var mudou = k !== s.i;
      s.i = k; s.acum = 0; pinta();
      if (mudou) emite('passo', { el: el, i: k });
    }
    function pode() { return estado.visivel && iniciou && s.noView && el.getClientRects().length > 0; }
    function tick() {
      if (!pode()) return;
      if (!s.auto) { s.auto = true; s.tocando = true; s.acum = 0; pinta(); return; }
      if (!s.tocando) return;
      s.acum += 100;
      if (s.acum < msDe(s.i)) return;
      if (s.i < n - 1) vai(s.i + 1);
      else if (loop) vai(0);
      else { s.tocando = false; pinta(); }
    }
    function liga() { if (!s.timer) s.timer = setI(tick, 100); }
    function pausaUsuario() { s.auto = true; s.tocando = false; pinta(); }
    itens.forEach(function (li, k) {
      li.tabIndex = 0;
      li.addEventListener('click', function () { pausaUsuario(); vai(k); });
      li.addEventListener('keydown', function (ev) {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === li) { ev.preventDefault(); pausaUsuario(); vai(k); }
      });
    });
    bAnt.addEventListener('click', function () { pausaUsuario(); vai(s.i - 1); });
    bProx.addEventListener('click', function () { pausaUsuario(); vai(s.i + 1); });
    bPlay.addEventListener('click', function () {
      s.auto = true;
      if (s.tocando) { s.tocando = false; pinta(); return; }
      if (s.i >= n - 1) vai(0);
      s.tocando = true; s.acum = 0; pinta();
    });
    if (W.IntersectionObserver) {
      new W.IntersectionObserver(function (es) { s.noView = es[es.length - 1].isIntersecting; }, { threshold: [0, 0.05] }).observe(el);
    }
    pinta(); liga();
    return function play() {
      s.auto = false; s.tocando = false; s.i = 0; s.acum = 0; pinta(); liga();
    };
  }

  var MONTA = { numero: montaNumero, barras: montaBarras, linhas: montaLinhas, ciclo: montaCiclo, tabela: montaTabela, tempo: montaTempo, passos: function (el) { numeraFilhos(el); return montaPassosPlay(el); }, abas: montaAbas, acordeao: montaAcordeao, slider: montaSlider, opcoes: montaOpcoes, lista: function (el) { numeraFilhos(el); return null; } };
  var NOMES = { numero: 'o .dv-numero', barras: 'o .dv-barras', linhas: 'o .dv-linhas', ciclo: 'o .dv-ciclo', tabela: 'a .dv-tabela', tempo: 'a .dv-linha-tempo', passos: 'os .dv-passos com data-play', abas: 'o .dv-abas', acordeao: 'o .dv-acordeao', slider: 'o .dv-slider', opcoes: 'o .dv-opcoes', lista: 'a peça' };

  function monta(el) {
    if (el._dvPeca) return el._dvPeca;
    var tipo = tipoDe(el), p = { el: el, tipo: tipo, play: null };
    el._dvPeca = p;
    if (tipo) {
      try { p.play = MONTA[tipo](el); } catch (e) { falhaPeca(el, NOMES[tipo], e); }
    }
    pecas.push(p);
    return p;
  }
  function montaTudo(raiz) {
    Arr.forEach.call((raiz || D).querySelectorAll(PECAS), monta);
  }

  function toca(p, i) {
    var el = p.el;
    el.classList.remove('dv-vai', 'dv-feito'); void el.offsetWidth;
    if (i != null) el.style.setProperty('--i', M.min(i, 8));
    el.classList.add('dv-vai');
    if (p.tipo === 'numero') ajustaNumero(el);
    if (p.play) p.play();
  }

  function comeca() {
    if (iniciou) return;
    if (!domPronto) { queroIniciar = true; return; }
    iniciou = true;
    ROOT.classList.remove('dv-prep');
    var topo = pecas.filter(function (p) { return !(p.el.parentElement && p.el.parentElement.closest(PECAS)); });
    topo.forEach(function (p, i) { toca(p, i); });
    // pecas aninhadas (ex.: número dentro de comparação) animam junto do pai: só contam
    pecas.forEach(function (p) {
      if (topo.indexOf(p) < 0 && p.play && !escondida(p.el)) { p.el.style.setProperty('--i', 0); if (p.tipo === 'numero') ajustaNumero(p.el); p.play(); }
    });
    agendaAltura();
  }

  // ---------- recebendo do app ----------
  function setVisivel(v) {
    estado.visivel = !!v;
    ROOT.classList.toggle('dv-pausado', !estado.visivel);
    var g = W.gsap && W.gsap.globalTimeline;
    if (g) {
      try {
        if (!estado.visivel && !g.paused()) { g.pause(); pausouGsap = true; }
        else if (estado.visivel && pausouGsap) { g.resume(); pausouGsap = false; }
      } catch (e) { /* gsap de outra versão */ }
    }
    emite('visivel', estado.visivel);
  }
  W.addEventListener('message', function (ev) {
    if (!emb || ev.source !== W.parent) return;
    var d = ev.data;
    if (!d || d.dgvis !== 1) return;
    if (d.tipo === 'tema') {
      var t = d.valor === 'escuro' ? 'escuro' : 'claro';
      estado.tema = t; ROOT.setAttribute('data-tema', t); emite('tema', t);
    } else if (d.tipo === 'visivel') {
      recebeuVisivel = true;
      setVisivel(d.v);
      if (d.v) comeca();
    } else if (d.tipo === 'pergunta-espera') {
      aoPergunta(d, 'confirme');
    } else if (d.tipo === 'pergunta-ok') {
      aoPergunta(d, 'ok');
    } else if (d.tipo === 'pergunta-erro') {
      aoPergunta(d, 'erro');
    } else if (d.tipo === 'tela') {
      estado.tela = !!d.cheia; ROOT.classList.toggle('dv-tela-cheia', estado.tela);
      emite('tela', estado.tela); agendaAltura();
    }
  });

  // ---------- visual vazio ----------
  function estaVazio() {
    var b = D.body; if (!b) return true;
    var vazio = true;
    Arr.forEach.call(b.children, function (c) {
      if (!vazio || c === tarja || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') return;
      if ((c.innerText || '').trim()) { vazio = false; return; }
      var m = c.matches('canvas,svg,img,video') ? [c] : Arr.slice.call(c.querySelectorAll('canvas,svg,img,video'));
      m.forEach(function (x) { var r = x.getBoundingClientRect(); if (r.width > 1 && r.height > 1) vazio = false; });
    });
    return vazio;
  }

  // ---------- API pública ----------
  function cores() {
    var cs = W.getComputedStyle(ROOT), g = function (n) { return cs.getPropertyValue('--dv-' + n).trim(); };
    var o = { fundo: g('fundo'), superficie: g('superficie'), superficie2: g('superficie-2'), texto: g('texto'), suave: g('suave'), linha: g('linha'), acento: g('acento'), ok: g('ok'), alerta: g('alerta'), perigo: g('perigo'), info: g('info') };
    o.series = [];
    for (var i = 1; i <= 6; i++) { o['c' + i] = g('c' + i); o.series.push(o['c' + i]); }
    return o;
  }
  function anima(el) {
    if (!el || el.nodeType !== 1) return;
    if (!iniciou) { comeca(); }
    var alvos = [];
    if (el.matches(PECAS)) alvos.push(monta(el));
    Arr.forEach.call(el.querySelectorAll(PECAS), function (c) { alvos.push(monta(c)); });
    if (!alvos.length) { alvos.push({ el: el, tipo: null, play: null }); }
    alvos.forEach(function (p, i) { toca(p, i); });
    agendaAltura();
  }
  var api = {
    on: on, cores: cores, anima: anima, formata: formata, perguntar: perguntar
  };
  ['tema', 'reduzido', 'visivel', 'tela'].forEach(function (k) {
    Object.defineProperty(api, k, { get: function () { return estado[k]; }, enumerable: true });
  });
  W.dgvis = api;

  // ---------- DOM ----------
  function aoCarregarDom() {
    domPronto = true;
    montaTudo();
    Arr.forEach.call(D.querySelectorAll('[data-pergunta]'), preparaPergunta);
    if (W.MutationObserver) {
      new W.MutationObserver(function (muts) {
        muts.forEach(function (m) {
          Arr.forEach.call(m.addedNodes, function (nd) {
            if (nd.nodeType !== 1) return;
            if (nd.hasAttribute('data-pergunta')) preparaPergunta(nd);
            Arr.forEach.call(nd.querySelectorAll('[data-pergunta]'), preparaPergunta);
          });
        });
      }).observe(D.body, { childList: true, subtree: true });
    }
    mostraTarjaPendente();
    var titulo = (D.title || '').trim();
    if (!titulo) { var h = D.querySelector('h1,.dv-titulo'); titulo = h ? h.textContent.trim() : ''; }
    var md = D.querySelector('meta[name="description"]');
    manda({ tipo: 'pronto', titulo: titulo.slice(0, 120), descricao: md ? (md.getAttribute('content') || '').slice(0, 300) : '' });
    if (W.ResizeObserver) {
      var ro = new W.ResizeObserver(agendaAltura);
      ro.observe(ROOT); ro.observe(D.body);
    }
    agendaAltura();
    if (queroIniciar) comeca();
    else if (!emb) setT(comeca, 1200);
    else setT(function () { if (!recebeuVisivel) comeca(); }, 1200);
    if (D.fonts && D.fonts.ready) D.fonts.ready.then(agendaAltura, function () {});
  }
  function mostraTarjaPendente() {
    if (tarjaMsgs.length && !tarja) { var m = tarjaMsgs.slice(); tarjaMsgs = []; m.forEach(mostraTarja); }
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', aoCarregarDom);
  else aoCarregarDom();

  W.addEventListener('load', function () {
    agendaAltura();
    setT(function () {
      if (estaVazio()) reportaErro('o visual chegou vazio: o arquivo não desenhou nada (sem texto, canvas, svg ou imagem visível).', { vazio: true });
    }, 1500);
  });
})();
