'use strict';
/* sigilo.js: o modo escondido (olhinho 👁) da conversa. Esconde nomes, valores e contatos para
   mostrar a tela numa aula sem expor cliente. Contrato do servidor: web/docs/SIGILO.md.

   Duas partes no mesmo arquivo:
   1) o MOTOR, puro (sem DOM, com teste em web/test/sigilo-tela.test.js): acha o que esconder
      (filtro automático no cliente + trechos que o modelo apontou) e devolve o texto com asteriscos;
   2) a TELA: liga o motor às mensagens que já estão no #wrap, sem depender do conversa.js. Um
      MutationObserver vê toda mensagem que entra (carga, SSE, rolar para cima) ou muda, e troca
      só nós de texto (markdown, links e botões continuam inteiros). O original fica guardado para
      revelar.

   Falha fechada: com o modo ligado, uma mensagem que o JS ainda não viu fica invisível por CSS
   (sigilo.css), e uma vista mas ainda não analisada pelo modelo mostra "🔒 escondendo…". O texto
   cru nunca é pintado. O estado fica no aparelho (localStorage), então recarregar a página no meio
   da aula não mostra nada cru. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGSigiloMotor = m;
    if (typeof document !== 'undefined') m.iniciaTela(raiz, document);
  }
})(this, function () {
  /* ── Motor ──────────────────────────────────────────────────────────── */

  /* A rede de segurança que não depende do modelo. */
  const FIXOS = [
    /\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/g,         // e-mail
    /(?:R\$|US\$|U\$)\s?\d(?:[\d.,]*\d)?(?:\s?(?:mil|k|K|mi|milhões|milhão)\b)?/g,                   // valor em dinheiro
    /\b\d[\d.,]*\s?(?:mil\s+|milhões?\s+)?reais\b/gi,
    /\b\d+(?:[.,]\d+)?\s?(?:mil|milhões|milhão)\b/gi,
    /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,                                                  // CPF
    /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,                                          // CNPJ
    /(?<!\d)(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-.\s]?\d{4}(?!\d)/g,                       // telefone BR
    /\b(?:sk|pk|ghp|gho|xoxb|AIza)[-_][A-Za-z0-9_-]{8,}/g,                                // chave de API
    /\b[A-Za-z0-9_-]{32,}\b/g,                                                            // bloco longo (token, hash)
    /\b\d{12,}\b/g,                                                                       // id de pedido, transação
  ];

  const RX_PALAVRA = /[\p{L}\p{N}_]+/gu;
  const escRx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Troca um trecho por asteriscos, deixando a forma (e-mail, dinheiro, palavra) reconhecível. */
  function mascaraTrecho(t) {
    t = String(t).replace(/\s+/g, ' ');
    const mail = t.match(/^([^@\s])[^@\s]*@([^@\s])[^@\s]*$/);
    if (mail) return mail[1] + '****@' + mail[2] + '*****';
    const din = t.match(/^(R\$|US\$|U\$|\$|€)\s?/);
    if (din) return din[1] + ' ***';
    if (/^\S{16,}$/.test(t)) return t.slice(0, 3) + '*****';    // chave, token, id
    return t.replace(/[\p{L}\p{N}]+/gu, (w) => (/^\p{N}/u.test(w) ? '***' : w[0] + '*'.repeat(Math.max(2, w.length - 1))))
      .replace(/\*\*\*([.,]\*\*\*)+/g, '***');
  }

  /** Várias partes (um nó de texto cada) viram um texto só. `sep` marca fronteira de bloco (vira \n). */
  function junta(partes) {
    let texto = ''; const ini = [];
    partes.forEach((p, i) => {
      if (i > 0 && p.sep) texto += '\n';
      ini.push(texto.length);
      texto += p.texto;
    });
    return { texto, ini };
  }

  function criarMotor() {
    const porTexto = new Map();          // texto -> [trechos] | null (o modelo falhou)
    let versao = 0;
    let indice = null; let indiceVersao = -1;
    const rxCache = new Map();
    const memo = new Map(); let memoVersao = -1;

    /* Os trechos indexados pela primeira palavra: uma regex só com milhares de trechos custava
       segundos no WebKit (iPhone). Com o índice, cada texto monta a regex só dos trechos cuja
       primeira palavra aparece nele (quase sempre nenhum ou poucos). Mesmo resultado. */
    function indiceDosTrechos() {
      if (indiceVersao === versao) return indice;
      const termos = new Set();
      for (const lista of porTexto.values()) for (const t of lista || []) if (t.length >= 3) termos.add(t);
      const porPalavra = new Map();
      const sempre = [];
      for (const t of termos) {
        const p = t.match(/[\p{L}\p{N}_]+/u);
        if (!p) { sempre.push(t); continue; }
        const k = p[0].toLowerCase();
        if (!porPalavra.has(k)) porPalavra.set(k, []);
        porPalavra.get(k).push(t);
      }
      indice = { porPalavra, sempre };
      indiceVersao = versao;
      rxCache.clear();
      return indice;
    }

    function regexDoTexto(texto) {
      const ind = indiceDosTrechos();
      const cand = new Set(ind.sempre);
      // "%20" de URL separa palavra: "…%20Maria%20…" é o nome inteiro
      for (const p of texto.replace(/%[0-9A-Fa-f]{2}/g, ' ').toLowerCase().match(RX_PALAVRA) || []) {
        const l = ind.porPalavra.get(p);
        if (l) for (const t of l) cand.add(t);
      }
      if (!cand.size) return null;
      const ord = Array.from(cand).sort((a, b) => b.length - a.length);
      const chave = ord.join('\u0000');
      let rx = rxCache.get(chave);
      if (!rx) {
        rx = new RegExp('(?<!(?<!%[0-9A-Fa-f])[\\p{L}\\p{N}_])(?:' + ord.map(escRx).join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
        if (rxCache.size > 3000) rxCache.clear();
        rxCache.set(chave, rx);
      }
      return rx;
    }

    /** Faixas [ini, fim) a esconder em `texto`. `soFixos`: ignora o que o modelo apontou. */
    function faixas(texto, soFixos) {
      if (memoVersao !== versao) { memo.clear(); memoVersao = versao; }
      const mk = (soFixos ? 'f|' : 'm|') + texto;
      const feito = memo.get(mk);
      if (feito) return feito;
      const achadas = [];
      if (!soFixos) {
        // trecho curto ("Lu", "PH") vale só no texto de onde veio: espalhado, apagaria "de", "do"...
        const curtos = (porTexto.get(texto) || []).filter((t) => t.length < 3).map(escRx);
        if (curtos.length) {
          const rc = new RegExp('(?<![\\p{L}\\p{N}_])(?:' + curtos.join('|') + ')(?![\\p{L}\\p{N}_])', 'gu');
          for (const x of texto.matchAll(rc)) achadas.push([x.index, x.index + x[0].length]);
        }
        const rx = regexDoTexto(texto);
        if (rx) for (const x of texto.matchAll(rx)) achadas.push([x.index, x.index + x[0].length]);
      }
      for (const fx of FIXOS) for (const x of texto.matchAll(fx)) achadas.push([x.index, x.index + x[0].length]);
      achadas.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const fund = [];
      for (const f of achadas) {
        const ult = fund[fund.length - 1];
        if (ult && f[0] <= ult[1]) ult[1] = Math.max(ult[1], f[1]); else fund.push([f[0], f[1]]);
      }
      if (memo.size > 5000) memo.clear();
      memo.set(mk, fund);
      return fund;
    }

    /** Texto -> texto com asteriscos (usa tudo: modelo + filtro). */
    function aplica(texto, soFixos) {
      let saida = ''; let p = 0;
      for (const [a, b] of faixas(texto, soFixos)) { saida += texto.slice(p, a) + mascaraTrecho(texto.slice(a, b)); p = b; }
      return saida + texto.slice(p);
    }

    /**
     * Partes (um nó de texto cada) -> o texto novo de cada parte. A busca roda no texto inteiro,
     * então um nome partido entre dois nós ("Ana <b>Paula</b>") também é pego.
     */
    function mascaraPartes(partes, soFixos, textoAnalisado) {
      const { texto, ini } = junta(partes);
      const fx = faixas(textoAnalisado != null ? textoAnalisado : texto, soFixos);
      return partes.map((p, i) => {
        const a0 = ini[i]; const b0 = a0 + p.texto.length;
        let saida = ''; let pos = a0;
        for (const [a, b] of fx) {
          if (b <= a0 || a >= b0) continue;
          const s = Math.max(a, a0); const e = Math.min(b, b0);
          saida += texto.slice(pos, s);
          const inteiro = a >= a0 && b <= b0;
          saida += inteiro ? mascaraTrecho(texto.slice(s, e)) : texto.slice(s, e).replace(/[\p{L}\p{N}]/gu, '*');
          pos = e;
        }
        return saida + texto.slice(pos, b0);
      });
    }

    return {
      registra(texto, trechos) { porTexto.set(texto, trechos); versao++; },
      tem: (texto) => porTexto.has(texto),
      /** 'ok' | 'espera' | 'falhou' */
      situacao(texto) { if (!porTexto.has(texto)) return 'espera'; return porTexto.get(texto) === null ? 'falhou' : 'ok'; },
      pendentes(textos, deNovo) { return Array.from(new Set(textos.filter((t) => !porTexto.has(t) || (deNovo && porTexto.get(t) === null)))); },
      get versao() { return versao; },
      faixas, aplica, mascaraPartes,
    };
  }

  /* ── Tela ───────────────────────────────────────────────────────────── */

  const CHAVE = 'dgclaw:sigilo';
  const ESPERA_MS = 350;          // texto parado por este tempo antes de ir ao modelo (não martela a API)
  const LOTE_TELA = 150;
  const BLOCOS = 'p,div,li,pre,h1,h2,h3,h4,h5,h6,tr,td,th,summary,details,blockquote,section,header,footer,ul,ol';
  const PASSA_CLIQUE = 'button:not(.mid),summary,audio,input,textarea,select,[data-sigx]';

  function iniciaTela(win, doc) {
    const wrap = doc.getElementById('wrap');
    if (!wrap || !win.MutationObserver) return;
    const motor = criarMotor();
    const corpo = doc.body;
    let ligado = false;
    try { ligado = win.localStorage.getItem(CHAVE) === '1'; } catch (e) { console.warn('modo escondido: não consegui ler o estado guardado:', e.message); }

    const raizes = [wrap, doc.getElementById('acervoLista'), doc.getElementById('permCartao'), doc.getElementById('lbNome')].filter(Boolean);
    const origem = new WeakMap();      // nó de texto -> original
    const feito = new WeakMap();       // nó de texto -> o que eu pus nele
    const reveladosId = new Set();     // ids de mensagem reveladas (um toque)
    const reveladosEl = new WeakSet(); // as que não têm id
    const fila = new Map();            // texto -> quando foi visto pela última vez
    const emVoo = new Set();
    let caps = { so_regex: null, modelo: null };
    let timer = null; let tudo = false; let rodando = false; let pedeDeNovo = false;
    const sujas = new Set();
    let btn = null; let aviso = null;

    const ehSecundario = (u) => u.parentElement !== wrap;

    function unidadeDe(no) {
      let e = no.nodeType === 1 ? no : no.parentElement;
      while (e && e !== corpo) {
        const p = e.parentElement;
        if (p === wrap) return e;
        if (p && p.id === 'acervoLista') return e;
        if (e.id === 'permCartao' || e.id === 'lbNome') return e;
        e = p;
      }
      return null;
    }
    const chaveRev = (u) => u.dataset && u.dataset.msg;
    const revelada = (u) => (chaveRev(u) ? reveladosId.has(chaveRev(u)) : reveladosEl.has(u));

    function coletaNos(u) {
      const lista = [];
      const w = doc.createTreeWalker(u, 4 /* SHOW_TEXT */, null);
      let n;
      while ((n = w.nextNode())) {
        const pai = n.parentElement;
        if (!pai || /^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT)$/.test(pai.tagName)) continue;
        if (pai.closest('.sigx')) continue;
        lista.push(n);
      }
      return lista;
    }
    function origDe(n) {
      if (feito.has(n) && feito.get(n) === n.nodeValue) return origem.get(n);
      origem.set(n, n.nodeValue);
      feito.delete(n);
      return n.nodeValue;
    }
    function poe(n, valor) {
      if (n.nodeValue !== valor) n.nodeValue = valor;
      feito.set(n, valor);
    }
    const blocoDe = (n) => (n.parentElement && n.parentElement.closest(BLOCOS)) || null;

    function marca(u, estado) {
      if (u.getAttribute('data-sig') !== estado) u.setAttribute('data-sig', estado);
      const temBub = !!u.querySelector('.bub');
      if (temBub) u.setAttribute('data-sigb', ''); else u.removeAttribute('data-sigb');
    }
    function botaoVolta(u, pode) {
      const atual = u.querySelector(':scope .sigx');
      if (!pode) { if (atual) atual.remove(); return; }
      if (atual) return;
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'sigx'; b.setAttribute('data-sigx', '');
      b.textContent = '🙈 esconder de novo';
      (u.querySelector('.bub') || u).appendChild(b);
    }

    function processaUnidade(u) {
      if (u.classList && (u.classList.contains('topo') || u.classList.contains('dia'))) return;
      const nos = coletaNos(u);
      const originais = nos.map(origDe);
      const partes = [];
      nos.forEach((n, i) => {
        if (!originais[i].trim()) return;
        const blocoAnt = partes.length ? partes[partes.length - 1].bloco : null;
        const bl = blocoDe(n);
        partes.push({ n, texto: originais[i], bloco: bl, sep: partes.length > 0 && bl !== blocoAnt });
      });
      const sec = ehSecundario(u);
      const { texto } = junta(partes);
      if (revelada(u)) {
        for (const n of nos) { const o = origem.get(n); if (o != null) poe(n, o); }
        marca(u, 'rev'); botaoVolta(u, true);
        return;
      }
      botaoVolta(u, false);
      const sit = texto.trim() ? motor.situacao(texto) : 'ok';
      // enquanto espera (ou se o modelo falhou) o DOM já fica só com o filtro automático; o CSS esconde o resto
      const soFixos = sit !== 'ok';
      const novos = partes.length ? motor.mascaraPartes(partes, soFixos, texto) : [];
      partes.forEach((p, i) => poe(p.n, novos[i]));
      const comTexto = new Set(partes.map((p) => p.n));
      for (const n of nos) if (!comTexto.has(n)) poe(n, origem.get(n));
      if (sit === 'espera') {
        fila.set(texto, Date.now());
        marca(u, 'espera');
        agenda();
      } else if (sit === 'falhou') {
        marca(u, sec ? 'ok' : 'falhou');
      } else {
        marca(u, 'ok');
      }
    }

    function processa(lista) {
      for (const u of lista) {
        try { processaUnidade(u); } catch (e) {
          console.warn('modo escondido: falhei ao esconder uma mensagem, ela fica coberta:', e);
          try { marca(u, 'falhou'); } catch (e2) { /* sem DOM: nada a fazer */ }
        }
      }
    }
    function todasUnidades() {
      const u = [];
      for (const r of raizes) {
        if (r === wrap || r.id === 'acervoLista') u.push(...Array.from(r.children));
        else u.push(r);
      }
      return u;
    }

    function restaura() {
      for (const u of todasUnidades()) {
        for (const n of coletaNos(u)) { const o = origem.get(n); if (o != null && feito.get(n) === n.nodeValue) { n.nodeValue = o; } feito.delete(n); }
        u.removeAttribute('data-sig'); u.removeAttribute('data-sigb');
        const b = u.querySelector('.sigx'); if (b) b.remove();
      }
    }

    // ── observador ───────────────────────────────────────────────────────
    const obs = new win.MutationObserver((registros) => {
      if (!ligado) return;
      const us = new Set();
      for (const r of registros) {
        if (r.type === 'characterData') {
          if (feito.get(r.target) === r.target.nodeValue) continue;      // fui eu
          const u = unidadeDe(r.target); if (u) us.add(u);
          continue;
        }
        const soMeu = (lista) => lista.length > 0 && Array.from(lista).every((x) => x.nodeType === 1 && x.classList && x.classList.contains('sigx'));
        if (soMeu(r.addedNodes) || soMeu(r.removedNodes)) continue;     // o meu botão
        if (raizes.includes(r.target) && r.target !== doc.getElementById('permCartao') && r.target !== doc.getElementById('lbNome')) {
          for (const x of r.addedNodes) if (x.nodeType === 1) us.add(x);
          continue;
        }
        const u = unidadeDe(r.target); if (u) us.add(u);
      }
      if (us.size) processa(us);
    });
    function observa() { for (const r of raizes) obs.observe(r, { childList: true, characterData: true, subtree: true }); }

    // ── análise pelo servidor ────────────────────────────────────────────
    function agenda() { if (timer || !ligado) return; timer = setTimeout(() => { timer = null; envia(); }, ESPERA_MS); }

    function textosDaTela() {
      const out = [];
      for (const u of todasUnidades()) {
        if (u.classList && (u.classList.contains('topo') || u.classList.contains('dia'))) continue;
        const ns = coletaNos(u);
        const partes = [];
        ns.forEach((n) => {
          const o = origDe(n);
          if (!o.trim()) return;
          const bl = blocoDe(n);
          partes.push({ texto: o, sep: partes.length > 0 && bl !== partes[partes.length - 1].bloco, bloco: bl });
        });
        const t = junta(partes).texto;
        if (t.trim()) out.push(t);
      }
      return out;
    }

    async function envia() {
      if (!ligado) return;
      if (rodando) { pedeDeNovo = true; return; }
      const agora = Date.now();
      let lista = Array.from(fila.entries()).filter(([t, quando]) => agora - quando >= ESPERA_MS && !emVoo.has(t)).map(([t]) => t);
      if (tudo) { lista = motor.pendentes(textosDaTela(), true).filter((t) => !emVoo.has(t)); tudo = false; }
      if (!lista.length) { if (fila.size) agenda(); return; }
      rodando = true;
      const avisos = [];
      try {
        for (let i = 0; i < lista.length && ligado; i += LOTE_TELA) {
          const parte = lista.slice(i, i + LOTE_TELA);
          parte.forEach((t) => emVoo.add(t));
          try {
            const r = await win.fetch('/api/v1/sigilo', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
              body: JSON.stringify({ textos: parte }),
            });
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            if (r.status === 401) { win.location.href = '/login?next=' + encodeURIComponent(win.location.pathname); return; }
            if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('o servidor respondeu ' + r.status));
            parte.forEach((t, n) => motor.registra(t, Array.isArray(d.trechos) && Array.isArray(d.trechos[n]) ? d.trechos[n] : null));
            (d.avisos || []).forEach((a) => avisos.push(a));
            caps = { so_regex: !!d.so_regex, modelo: d.modelo || null };
          } catch (e) {
            parte.forEach((t) => { if (!motor.tem(t) || motor.situacao(t) === 'falhou') motor.registra(t, null); });
            avisos.push('Não consegui analisar parte das mensagens (' + e.message + '). Elas continuam escondidas.');
          } finally {
            parte.forEach((t) => { emVoo.delete(t); fila.delete(t); });
          }
          processa(todasUnidades());
          pintaAviso();
        }
      } finally {
        rodando = false;
      }
      if (avisos.length) mostraMensagem(avisos[0]);
      if (pedeDeNovo || fila.size) { pedeDeNovo = false; agenda(); }
    }

    // ── interface: botão, avisos, clique ─────────────────────────────────
    function mostraMensagem(txt) {
      const f = doc.getElementById('faixaAviso');
      const t = f && f.querySelector('.txt');
      console.warn('modo escondido:', txt);
      if (!t) return;
      t.textContent = txt; f.classList.add('aparece');
      win.setTimeout(() => { if (t.textContent === txt) f.classList.remove('aparece'); }, 9000);
    }

    function pintaBotao() {
      if (!btn) return;
      btn.classList.toggle('on', ligado);
      btn.setAttribute('aria-pressed', String(ligado));
      const l = btn.querySelector('.lbl'); if (l) l.textContent = ligado ? 'escondido' : 'mostrando';
    }
    function pintaAviso() {
      if (!aviso) return;
      const mostra = ligado && caps.so_regex === true;
      aviso.hidden = !mostra;
    }
    const EXPLICA = 'Sem chave de modelo, só o filtro automático (e-mail, valor, CPF, telefone, chave) esconde. ' +
      'Nomes de pessoas e empresas passam. Para ligar o completo, peça ao Admin: "liga o modo escondido completo". ' +
      'Ele copia a chave ANTHROPIC_API_KEY ou OPENAI_API_KEY do cofre para o web.env.';
    function criaAviso() {
      aviso = doc.createElement('div');
      aviso.id = 'sigAviso'; aviso.hidden = true;
      const b = doc.createElement('button');
      b.type = 'button'; b.setAttribute('aria-expanded', 'false');
      b.textContent = 'Só o filtro automático: nomes passam. Toque para saber como ligar o completo.';
      const p = doc.createElement('p'); p.textContent = EXPLICA; p.hidden = true;
      b.addEventListener('click', () => { p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); });
      aviso.append(b, p);
      corpo.appendChild(aviso);
    }

    async function buscaEstado() {
      try {
        const r = await win.fetch('/api/v1/sigilo/estado', { cache: 'no-store', credentials: 'same-origin' });
        if (r.status === 401) return;
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.erro || ('o servidor respondeu ' + r.status));
        caps = { so_regex: !!d.so_regex, modelo: d.modelo || null };
        pintaAviso();
      } catch (e) {
        console.warn('modo escondido: não consegui saber qual modelo está ativo (' + e.message + '). A análise tenta mesmo assim.');
      }
    }

    function liga(sim) {
      ligado = sim;
      try { win.localStorage.setItem(CHAVE, sim ? '1' : '0'); } catch (e) { console.warn('modo escondido: não consegui guardar o estado no aparelho:', e.message); }
      corpo.classList.toggle('sigilo', sim);
      reveladosId.clear();
      pintaBotao(); pintaAviso();
      if (sim) {
        buscaEstado();
        tudo = true;
        processa(todasUnidades());     // na hora: tudo escondido ou "escondendo…"
        agenda();
      } else {
        restaura();
        fila.clear();
      }
    }

    function revela(u, sim) {
      const k = chaveRev(u);
      if (sim) { if (k) reveladosId.add(k); else reveladosEl.add(u); }
      else if (k) reveladosId.delete(k); else reveladosEl.delete(u);
      processa([u]);
    }

    function aoClicar(ev) {
      if (!ligado) return;
      const alvo = ev.target;
      if (!alvo || !alvo.closest) return;
      const sigx = alvo.closest('[data-sigx]');
      if (sigx) { const u = unidadeDe(sigx); if (u) { ev.preventDefault(); ev.stopPropagation(); revela(u, false); } return; }
      const u = unidadeDe(alvo);
      if (!u || ehSecundario(u)) return;
      const est = u.getAttribute('data-sig');
      if (est !== 'ok' && est !== 'falhou') return;
      if (alvo.closest(PASSA_CLIQUE)) return;
      ev.preventDefault(); ev.stopPropagation();
      revela(u, true);
    }

    function monta() {
      const tools = doc.getElementById('tools');
      btn = doc.createElement('button');
      btn.id = 'btnSigilo'; btn.type = 'button'; btn.className = 'btn';
      btn.setAttribute('data-tour', 'sigilo');
      btn.title = 'Modo escondido: esconde nomes, valores e contatos para mostrar a tela';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '👁 <span class="lbl">mostrando</span>';
      if (tools) tools.insertBefore(btn, doc.getElementById('btnLer') || (doc.getElementById('btnLembretes') || {}).nextSibling || tools.firstChild); else (doc.getElementById('cabecalho') || corpo).appendChild(btn);
      btn.addEventListener('click', () => liga(!ligado));
      criaAviso();
      wrap.addEventListener('click', aoClicar, true);
      corpo.addEventListener('click', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('[data-sigx]')) aoClicar(ev); }, true);
      const acervo = doc.getElementById('acervoLista');
      if (acervo) acervo.addEventListener('click', (ev) => { if (ligado && ev.target.closest && ev.target.closest('.mid, img, video')) { ev.preventDefault(); ev.stopPropagation(); } }, true);
      pintaBotao();
      observa();
      if (ligado) { corpo.classList.add('sigilo'); buscaEstado(); tudo = true; processa(todasUnidades()); agenda(); }
    }

    // O corpo recebe a classe já na carga: o CSS cobre toda mensagem nova antes de qualquer pintura.
    if (ligado) corpo.classList.add('sigilo');
    monta();

    win.DGSigilo = {
      ligado: () => ligado,
      modelo: () => caps.modelo,
      /** Passo do tour (conversa.js chama ao montar a visita guiada). */
      passoTour() {
        const modelo = caps.so_regex === false && caps.modelo ? 'O modelo ativo agora é o ' + caps.modelo + '.'
          : (caps.so_regex === true ? 'Agora só o filtro automático está ligado (falta chave de modelo): nomes de pessoas e empresas passam.' : 'Ligue o modo para ver qual modelo está ativo.');
        return {
          alvo: '#btnSigilo', titulo: 'Modo escondido (olhinho)',
          oque: 'O botão 👁 esconde nomes, empresas, valores, e-mails, telefones, documentos e chaves de todas as mensagens da tela, trocando por asteriscos.',
          como: 'Um filtro automático pega e-mail, valor, CPF, CNPJ, telefone e chave na hora. Um modelo de IA aponta o resto (nomes e empresas) e o mesmo nome some em todas as mensagens. ' + modelo + ' Toque num texto escondido para mostrar só aquela mensagem, e em "esconder de novo" para voltar. Fotos e vídeos ficam borrados. Enquanto uma mensagem não foi analisada, aparece "escondendo…" em vez do texto.',
          porque: 'Para mostrar a tela numa aula ou palestra sem expor cliente nem dado pessoal. É uma defesa, não uma garantia: confira a tela antes de gravar.',
        };
      },
    };
  }

  return { criarMotor, mascaraTrecho, junta, FIXOS, iniciaTela, CHAVE };
});
