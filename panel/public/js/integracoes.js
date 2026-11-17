// integracoes.js: a aba Integrações. Um mapa em constelação: a foto do agente no centro e, ligado
// por uma linha reta, cada sistema externo que ele já usou (WhatsApp, Instagram, banco...).
//
// DE ONDE VEM O DADO. De /api/integracoes (lib/integracoes.js), que lê o estado.json anotado pelos
// programas que falam com cada sistema. QUEM DECIDE A COR É O SERVIDOR: esta tela só desenha. Se ela
// calculasse cor também, seriam duas regras para a mesma coisa.
//
// SEGURANÇA. Todo texto vindo da API entra por textContent ou setAttribute (nunca HTML montado com
// dado). A classe de cor sai de uma tabela deste arquivo, indexada pelo `estado` já validado, e o
// ícone sai de uma lista deste arquivo (nome desconhecido vira `link`).
//
// MOVIMENTO. O pulso é um ponto que anda pela reta. Ele para quando a aba do navegador fica
// escondida e não existe com "reduzir movimento": nesse caso ficam só a cor e a palavra.
//
// As funções puras (layout, tabelas de cor e de ícone, frase-resumo) ficam em `DGIntegracoes.puro`
// para o teste rodar sem navegador (panel/test-integracoes-tela.mjs).

(function (raiz) {
  'use strict';

  // ── tabelas do código ───────────────────────────────────────────────────────
  // Estado validado -> classe de cor e palavra de reserva. Valor fora daqui NUNCA vira verde.
  const ESTADOS = {
    verde: { cls: 'verde', palavra: 'Funcionando', pulso: 'calmo' },
    amarelo: { cls: 'amarelo', palavra: 'Atenção', pulso: 'lento' },
    vermelho: { cls: 'vermelho', palavra: 'Com defeito', pulso: 'falha' },
    desligado: { cls: 'desligado', palavra: 'Desligado', pulso: null },
    sem_uso_recente: { cls: 'sem-uso', palavra: 'Sem uso recente', pulso: null },
  };
  const ESTADO_DESCONHECIDO = { cls: 'sem-uso', palavra: 'Estado desconhecido', pulso: null };

  // Duração de cada volta do pulso, em ms.
  const DURACAO = { calmo: 2600, lento: 4000, falha: 3000 };

  // Ícones do sprite /ds/icones.svg que esta tela aceita. Qualquer outro nome vira `link`.
  const ICONES = ['message', 'send', 'camera', 'mail', 'vault', 'file-text', 'users', 'calendar', 'volume', 'sparkle', 'link', 'layers'];

  const MAX_ANEL = 12;
  const RAIO_NO = 26;
  const RAIO_FOTO = 46;

  function estadoDe(estado) {
    return Object.prototype.hasOwnProperty.call(ESTADOS, estado) ? ESTADOS[estado] : null;
  }
  function classeDoEstado(estado) {
    const e = estadoDe(estado);
    return e ? e.cls : null;
  }
  function iconeSeguro(nome) {
    return typeof nome === 'string' && ICONES.indexOf(nome) !== -1 ? nome : 'link';
  }

  // ── layout ──────────────────────────────────────────────────────────────────
  // Hash estável (FNV-1a de 32 bits): o mesmo id dá sempre o mesmo número, então o desenho não
  // muda a cada visita.
  function hash(texto) {
    let h = 0x811c9dc5;
    const s = String(texto);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function fracao(id, sal) { return hash(id + ':' + sal) / 4294967296; } // [0, 1)

  /**
   * Posição de cada nó. O centro é (0,0), o ângulo começa no topo e gira no sentido horário.
   * Até 12 nós num anel; acima disso, o resto vai para um segundo anel, defasado meio passo.
   * O raio varia até 12% para mais ou para menos por um hash do id; o ângulo ganha um pequeno
   * desvio (no máximo 15% do passo) também por hash.
   */
  function layout(ids, opcoes) {
    const o = opcoes || {};
    const base1 = o.raioBase || 190;
    const base2 = o.raioSegundo || base1 * 1.7;
    const lista = (ids || []).slice();
    const n1 = Math.min(lista.length, MAX_ANEL);
    const n2 = lista.length - n1;
    const nos = [];
    const poe = (id, i, n, base, anel, meioPasso) => {
      const passo = (Math.PI * 2) / n;
      const desvio = (fracao(id, 'a') * 2 - 1) * passo * 0.15;
      const angulo = -Math.PI / 2 + i * passo + (meioPasso ? passo / 2 : 0) + desvio;
      const raio = base * (1 + 0.12 * (fracao(id, 'r') * 2 - 1));
      const x = Math.cos(angulo) * raio, y = Math.sin(angulo) * raio;
      // O rótulo fica do lado de FORA, no prolongamento da reta: acima (metade de cima), abaixo
      // (metade de baixo) ou ao lado, alinhado para fora, quando o nó está perto da horizontal.
      const sen = Math.sin(angulo);
      const lado = Math.abs(sen) < 0.4 ? (x >= 0 ? 'dir' : 'esq') : (y < 0 ? 'cima' : 'baixo');
      nos.push({ id, anel, angulo, raio, x, y, lado });
    };
    for (let i = 0; i < n1; i++) poe(lista[i], i, n1, base1, 1, false);
    for (let i = 0; i < n2; i++) poe(lista[n1 + i], i, n2, base2, 2, true);
    const maior = nos.reduce((m, n) => Math.max(m, n.raio), 0);
    // Caixa justa em volta de tudo (círculos, rótulos e o agente), para o desenho não sobrar vazio.
    let x0 = -(RAIO_FOTO + 8), x1 = RAIO_FOTO + 8, y0 = -(RAIO_FOTO + 8), y1 = RAIO_FOTO + 40;
    for (const n of nos) {
      const folga = { cima: [60, 60, RAIO_NO + 38, RAIO_NO], baixo: [60, 60, RAIO_NO, RAIO_NO + 42],
        dir: [RAIO_NO, RAIO_NO + 120, RAIO_NO, RAIO_NO], esq: [RAIO_NO + 120, RAIO_NO, RAIO_NO, RAIO_NO] }[n.lado];
      x0 = Math.min(x0, n.x - folga[0]); x1 = Math.max(x1, n.x + folga[1]);
      y0 = Math.min(y0, n.y - folga[2]); y1 = Math.max(y1, n.y + folga[3]);
    }
    const pad = 8;
    return { nos, meia: Math.ceil(Math.max(maior, base1) + 90), caixa: { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: Math.ceil(x1 - x0 + pad * 2), h: Math.ceil(y1 - y0 + pad * 2) } };
  }

  // ── textos ──────────────────────────────────────────────────────────────────
  function frase(integracoes) {
    const lista = Array.isArray(integracoes) ? integracoes : [];
    if (!lista.length) {
      return 'Ainda não usou nenhum sistema externo. Cada sistema aparece aqui sozinho na primeira vez que o agente o usar.';
    }
    const ligados = lista.filter((i) => i.estado !== 'desligado').length;
    const defeito = lista.filter((i) => i.estado === 'vermelho').length;
    if (!ligados) return 'Todos os sistemas estão desligados no mapa.';
    let t = 'Ligado em ' + ligados + (ligados === 1 ? ' sistema' : ' sistemas');
    if (defeito) t += ' · ' + defeito + ' com defeito';
    return t;
  }
  function quando(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function aparar(texto, max) {
    const s = String(texto == null ? '' : texto);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function visiveis(integracoes, modoAula) {
    const lista = Array.isArray(integracoes) ? integracoes : [];
    return modoAula ? lista.filter((i) => i.estado === 'verde') : lista;
  }
  function palavraDe(i) {
    const e = estadoDe(i.estado) || ESTADO_DESCONHECIDO;
    return aparar(i.palavra || e.palavra, 24);
  }

  const puro = { hash, layout, estadoDe, classeDoEstado, iconeSeguro, frase, quando, visiveis, ESTADOS, ICONES, DURACAO, MAX_ANEL };

  // Fora do navegador (teste), só as funções puras.
  if (typeof document === 'undefined' || !document || !document.createElementNS) {
    raiz.DGIntegracoes = { puro };
    return;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────
  const BASE = raiz.DGCLAW_BASE || '';
  const NS = 'http://www.w3.org/2000/svg';

  const estadoTela = { dados: null, modoAula: false, selecionado: null, foto: '', animacao: [], raf: 0, timer: 0 };

  function h(tag, attrs, texto) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    if (texto != null) e.textContent = texto;
    return e;
  }
  function s(tag, attrs, texto) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (texto != null) e.textContent = texto;
    return e;
  }
  function iconeSvg(nome, atributos) {
    const u = s('use');
    u.setAttribute('href', '/ds/icones.svg#i-' + iconeSeguro(nome));
    const a = Object.assign({ width: 24, height: 24 }, atributos || {});
    const el = s('svg', Object.assign({ viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, a));
    el.appendChild(u);
    return el;
  }
  const el$ = (id) => document.getElementById(id);
  const reduzMovimento = () => !!(raiz.matchMedia && raiz.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function fotoValida(url) {
    return typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/';
  }

  // ── o mapa em SVG ───────────────────────────────────────────────────────────
  function desenharMapa(destino, agente, lista) {
    parar();
    estadoTela.animacao = [];
    destino.textContent = '';
    // O raio base cresce com a largura disponível (com teto), para o mapa ocupar o cartão.
    const largura = destino.clientWidth || 0;
    const raioBase = largura ? Math.max(150, Math.min(235, largura / 2 - 150)) : 190;
    const { nos, caixa } = layout(lista.map((i) => i.id), { raioBase });
    const porId = {};
    lista.forEach((i) => { porId[i.id] = i; });
    estadoTela.larguraDesenhada = largura;
    const svg = s('svg', {
      class: 'int-svg', viewBox: caixa.x + ' ' + caixa.y + ' ' + caixa.w + ' ' + caixa.h,
      role: 'group', 'aria-label': 'Mapa das integrações de ' + aparar(agente.nome, 40),
    });

    const defs = s('defs');
    const filtro = s('filter', { id: 'int-brilho', x: '-100%', y: '-100%', width: '300%', height: '300%' });
    filtro.appendChild(s('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }));
    const merge = s('feMerge');
    merge.appendChild(s('feMergeNode', { in: 'b' }));
    merge.appendChild(s('feMergeNode', { in: 'SourceGraphic' }));
    filtro.appendChild(merge);
    defs.appendChild(filtro);
    const clip = s('clipPath', { id: 'int-recorte-foto' });
    clip.appendChild(s('circle', { cx: 0, cy: 0, r: RAIO_FOTO }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    const camadaLinhas = s('g', { class: 'int-linhas' });
    const camadaPulsos = s('g', { class: 'int-pulsos', 'aria-hidden': 'true' });
    const camadaNos = s('g', { class: 'int-nos' });
    svg.appendChild(camadaLinhas);
    svg.appendChild(camadaPulsos);
    svg.appendChild(camadaNos);

    const animar = !reduzMovimento();
    nos.forEach((pos) => {
      const it = porId[pos.id];
      const e = estadoDe(it.estado) || ESTADO_DESCONHECIDO;
      const palavra = palavraDe(it);
      const nome = aparar(it.nome || it.id, 40);

      // A linha vai da borda do círculo do agente à borda do círculo do nó, nunca ao centro.
      const dx = Math.cos(pos.angulo), dy = Math.sin(pos.angulo);
      const ini = { x: dx * (RAIO_FOTO + 4), y: dy * (RAIO_FOTO + 4) };
      const fim = { x: pos.x - dx * RAIO_NO, y: pos.y - dy * RAIO_NO };
      const linha = s('line', { x1: ini.x.toFixed(1), y1: ini.y.toFixed(1), x2: fim.x.toFixed(1), y2: fim.y.toFixed(1), class: 'int-linha int-e-' + e.cls });
      camadaLinhas.appendChild(linha);

      if (animar && e.pulso) {
        const ponto = s('circle', { cx: fim.x.toFixed(1), cy: fim.y.toFixed(1), r: 3.4, class: 'int-pulso int-e-' + e.cls, filter: 'url(#int-brilho)', opacity: 0 });
        camadaPulsos.appendChild(ponto);
        estadoTela.animacao.push({
          ponto, linha, fim, ini, tipo: e.pulso, dur: DURACAO[e.pulso],
          fase: fracao(pos.id, 'fase') * DURACAO[e.pulso],
        });
      }

      const g = s('g', {
        class: 'int-no int-e-' + e.cls + (estadoTela.selecionado === it.id ? ' int-sel' : ''),
        transform: 'translate(' + pos.x.toFixed(1) + ' ' + pos.y.toFixed(1) + ')',
        tabindex: 0, role: 'button', 'aria-label': nome + ': ' + palavra,
        'aria-pressed': estadoTela.selecionado === it.id ? 'true' : 'false',
      });
      g.appendChild(s('circle', { class: 'int-no-circulo', r: RAIO_NO }));
      g.appendChild(iconeSvg(it.icone, { x: -12, y: -12, class: 'int-no-icone' }));
      // Rótulo do lado de fora, no prolongamento da reta: nenhuma linha passa por ele.
      const pos2 = {
        cima: { x: 0, a: 'middle', yn: -(RAIO_NO + 24), yp: -(RAIO_NO + 9) },
        baixo: { x: 0, a: 'middle', yn: RAIO_NO + 17, yp: RAIO_NO + 32 },
        dir: { x: RAIO_NO + 10, a: 'start', yn: -2, yp: 13 },
        esq: { x: -(RAIO_NO + 10), a: 'end', yn: -2, yp: 13 },
      }[pos.lado];
      g.appendChild(s('text', { class: 'int-rotulo', x: pos2.x, y: pos2.yn, 'text-anchor': pos2.a }, aparar(nome, 16)));
      g.appendChild(s('text', { class: 'int-palavra', x: pos2.x, y: pos2.yp, 'text-anchor': pos2.a }, palavra));
      const abrir = () => selecionar(it.id, g);
      g.addEventListener('click', abrir);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); }
      });
      camadaNos.appendChild(g);
    });

    // O centro: a foto do agente, ou a inicial sobre o acento.
    const centro = s('g', { class: 'int-centro' });
    centro.appendChild(s('circle', { class: 'int-centro-aro', r: RAIO_FOTO + 4 }));
    const inicial = s('g', { class: 'int-centro-inicial' });
    inicial.appendChild(s('circle', { class: 'int-centro-fundo', r: RAIO_FOTO }));
    const letra = (String(agente.nome || '?').trim().charAt(0) || '?').toUpperCase();
    inicial.appendChild(s('text', { class: 'int-centro-letra', y: 11, 'text-anchor': 'middle' }, letra));
    centro.appendChild(inicial);
    if (fotoValida(estadoTela.foto)) {
      const img = s('image', {
        href: estadoTela.foto, x: -RAIO_FOTO, y: -RAIO_FOTO, width: RAIO_FOTO * 2, height: RAIO_FOTO * 2,
        'clip-path': 'url(#int-recorte-foto)', preserveAspectRatio: 'xMidYMid slice',
      });
      img.addEventListener('error', () => img.remove());
      centro.appendChild(img);
    }
    centro.appendChild(s('text', { class: 'int-centro-nome', y: RAIO_FOTO + 28, 'text-anchor': 'middle' }, aparar(agente.nome, 30)));
    svg.appendChild(centro);

    destino.appendChild(svg);
    iniciar();
  }

  // ── o pulso ─────────────────────────────────────────────────────────────────
  function quadro(agora) {
    estadoTela.raf = 0;
    if (document.hidden) return;
    const a = estadoTela.animacao;
    if (!a.length || !a[0].ponto.isConnected) return;
    // Aba do painel escondida (ou mapa trocado pela lista no celular): sem trabalho.
    if (a[0].ponto.ownerSVGElement && !a[0].ponto.ownerSVGElement.getClientRects().length) {
      estadoTela.raf = raf(quadro);
      return;
    }
    for (const p of a) {
      const t = ((agora + p.fase) % p.dur) / p.dur; // 0..1 dentro da volta
      // d: 0 na borda do nó, 1 na borda do agente.
      const ponto = (d) => {
        p.ponto.setAttribute('cx', (p.fim.x + (p.ini.x - p.fim.x) * d).toFixed(1));
        p.ponto.setAttribute('cy', (p.fim.y + (p.ini.y - p.fim.y) * d).toFixed(1));
      };
      if (p.tipo === 'falha') {
        // Sai do nó, para no meio da linha e some. A linha pisca devagar.
        const k = Math.min(t / 0.6, 1);
        ponto(0.5 * k);
        p.ponto.setAttribute('opacity', t < 0.6 ? (1 - k * k).toFixed(2) : '0');
        p.linha.setAttribute('stroke-opacity', (0.65 + 0.35 * Math.cos(t * Math.PI * 2)).toFixed(2));
      } else {
        // Vai do nó ao agente e volta.
        ponto(t < 0.5 ? t * 2 : 2 - t * 2);
        p.ponto.setAttribute('opacity', '1');
      }
    }
    estadoTela.raf = raf(quadro);
  }
  function raf(fn) { return raiz.requestAnimationFrame(fn); }
  function iniciar() {
    if (estadoTela.raf || !estadoTela.animacao.length || document.hidden) return;
    estadoTela.raf = raf(quadro);
  }
  function parar() {
    if (estadoTela.raf) raiz.cancelAnimationFrame(estadoTela.raf);
    estadoTela.raf = 0;
  }
  raiz.addEventListener('resize', () => {
    const m = el$('int-mapa');
    if (m && estadoTela.dados && m.clientWidth && Math.abs(m.clientWidth - estadoTela.larguraDesenhada) > 40) desenhar();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) parar(); else iniciar(); });

  // ── a lista do celular ──
  // No celular o SVG some; a foto e o nome do agente ficam no topo da lista.
  function desenharAgenteMovel(destino, agente) {
    destino.textContent = '';
    const nome = aparar(agente.nome, 30);
    let foto = null;
    if (fotoValida(estadoTela.foto)) {
      foto = h('img', { class: 'int-agente-foto', alt: '', src: estadoTela.foto });
      foto.addEventListener('error', () => { foto.remove(); });
      destino.appendChild(foto);
    }
    destino.appendChild(h('span', { class: 'int-agente-letra', 'aria-hidden': 'true' }, (String(agente.nome || '?').trim().charAt(0) || '?').toUpperCase()));
    destino.appendChild(h('span', { class: 'int-agente-nome' }, nome));
  }
  function desenharLista(destino, lista) {
    destino.textContent = '';
    lista.forEach((it) => {
      const e = estadoDe(it.estado) || ESTADO_DESCONHECIDO;
      const palavra = palavraDe(it);
      const nome = aparar(it.nome || it.id, 40);
      const li = h('li');
      const b = h('button', {
        type: 'button', class: 'int-item int-e-' + e.cls + (estadoTela.selecionado === it.id ? ' int-sel' : ''),
        'aria-label': nome + ': ' + palavra, 'aria-pressed': estadoTela.selecionado === it.id ? 'true' : 'false',
      });
      b.appendChild(h('span', { class: 'int-bolinha', 'aria-hidden': 'true' }));
      const ic = iconeSvg(it.icone, { class: 'int-item-icone' });
      b.appendChild(ic);
      b.appendChild(h('span', { class: 'int-item-nome' }, nome));
      b.appendChild(h('span', { class: 'int-item-palavra' }, palavra));
      b.addEventListener('click', () => selecionar(it.id, b));
      li.appendChild(b);
      destino.appendChild(li);
    });
  }

  // ── o cartão do nó ──────────────────────────────────────────────────────────
  function linhaDoCartao(dl, rotulo, valor) {
    dl.appendChild(h('dt', null, rotulo));
    dl.appendChild(h('dd', null, valor));
  }
  function desenharCartao() {
    const caixa = el$('int-cartao');
    if (!caixa) return;
    const dados = estadoTela.dados;
    const it = dados && estadoTela.selecionado
      ? visiveis(dados.integracoes, estadoTela.modoAula).find((i) => i.id === estadoTela.selecionado) : null;
    if (!it) { caixa.hidden = true; caixa.textContent = ''; return; }
    const e = estadoDe(it.estado) || ESTADO_DESCONHECIDO;
    caixa.hidden = false;
    caixa.textContent = '';
    caixa.className = 'cartao int-cartao int-e-' + e.cls;

    const cab = h('div', { class: 'int-cartao-cab' });
    const titulo = h('h3', { class: 'int-cartao-nome' }, aparar(it.nome || it.id, 60));
    cab.appendChild(titulo);
    cab.appendChild(h('span', { class: 'int-selo int-e-' + e.cls }, palavraDe(it)));
    const ajuda = h('button', { type: 'button', class: 'app-ajuda-secao', 'aria-label': 'O que é este cartão', title: 'O que é este cartão, e como a conta é feita' }, '?');
    ajuda.addEventListener('click', () => { if (raiz.DGTutoriais) raiz.DGTutoriais.abrir('integracoes', 'cartao'); });
    cab.appendChild(ajuda);
    const fechar = h('button', { type: 'button', class: 'int-fechar', 'aria-label': 'Fechar o cartão' }, '×');
    fechar.addEventListener('click', () => { estadoTela.selecionado = null; desenhar(); });
    cab.appendChild(fechar);
    caixa.appendChild(cab);

    const dl = h('dl', { class: 'int-dl' });
    const okEm = quando(it.ultimoOk);
    linhaDoCartao(dl, 'Última vez que funcionou', okEm || 'ainda não funcionou nenhuma vez');
    const falhaEm = quando(it.ultimaFalha);
    let falha = 'nenhum problema registrado';
    if (it.ultimaFalhaExplica) falha = aparar(it.ultimaFalhaExplica, 300) + (falhaEm ? ' (' + falhaEm + ')' : '');
    else if (falhaEm) falha = falhaEm;
    linhaDoCartao(dl, 'Último problema', falha);
    caixa.appendChild(dl);

    caixa.appendChild(h('div', { class: 'int-dl-rotulo' }, 'Quais skills usam'));
    const skills = Array.isArray(it.skills) ? it.skills : [];
    if (skills.length) {
      const ul = h('ul', { class: 'int-skills' });
      skills.slice(0, 30).forEach((n) => ul.appendChild(h('li', null, aparar(n, 60))));
      caixa.appendChild(ul);
    } else {
      caixa.appendChild(h('p', { class: 'int-skills-vazio' }, 'nenhuma skill declarou'));
    }

    const desligada = it.estado === 'desligado';
    const botao = h('button', { type: 'button', class: 'int-botao' }, desligada ? 'Ligar no mapa' : 'Desligar no mapa');
    const msg = h('p', { class: 'int-erro', role: 'alert', hidden: '' });
    botao.addEventListener('click', async () => {
      botao.disabled = true;
      msg.hidden = true;
      const r = await alternarLigada(it.id, !desligada);
      if (r.ok) { await carregar(); return; }
      botao.disabled = false;
      const c = r.corpo || {};
      msg.textContent = (c.error || 'Não consegui mudar isso agora.') + (c.howToFix ? ' ' + c.howToFix : '');
      msg.hidden = false;
    });
    caixa.appendChild(botao);
    caixa.appendChild(msg);
  }

  async function alternarLigada(id, desligar) {
    const url = '/api/integracoes/' + encodeURIComponent(id) + (desligar ? '/desligar' : '/ligar');
    if (raiz.API && raiz.API.post) return raiz.API.post(url, {});
    return { ok: false, corpo: { error: 'O painel não carregou por inteiro.', howToFix: 'Recarregue a página.' } };
  }

  function selecionar(id, origem) {
    estadoTela.selecionado = estadoTela.selecionado === id ? null : id;
    desenhar();
    const caixa = el$('int-cartao');
    if (estadoTela.selecionado && caixa && !caixa.hidden && caixa.scrollIntoView && raiz.matchMedia && raiz.matchMedia('(max-width: 600px)').matches) {
      caixa.scrollIntoView({ block: 'nearest', behavior: reduzMovimento() ? 'auto' : 'smooth' });
    }
    // O foco volta para o nó (o desenho foi refeito).
    const candidatos = document.querySelectorAll('#panel-integracoes .int-no[aria-pressed="true"], #panel-integracoes .int-item[aria-pressed="true"]');
    for (const novo of candidatos) {
      if (origem && novo.focus && (novo.getClientRects().length || novo.ownerSVGElement && novo.ownerSVGElement.getClientRects().length)) { novo.focus({ preventScroll: true }); break; }
    }
  }

  // ── a tela ──────────────────────────────────────────────────────────────────
  function mostrarAviso(texto, tom) {
    const a = el$('int-aviso');
    if (!a) return;
    if (!texto) { a.hidden = true; a.textContent = ''; return; }
    a.className = 'int-aviso int-aviso-' + (tom === 'info' ? 'info' : 'erro');
    a.textContent = texto;
    a.hidden = false;
  }

  function desenhar() {
    const dados = estadoTela.dados;
    const resumo = el$('int-resumo-texto');
    const mapa = el$('int-mapa');
    const lista = el$('int-lista');
    const caixa = el$('int-mapa-caixa');
    if (!dados || !mapa || !lista) return;

    if (dados.medido === false) {
      // Nunca o mapa verde: só o motivo.
      resumo.textContent = 'Não foi possível medir as integrações agora.';
      mostrarAviso(aparar(dados.motivo || 'O painel não conseguiu ler o registro das integrações.', 400));
      mapa.textContent = ''; lista.textContent = ''; parar();
      if (el$('int-agente')) el$('int-agente').textContent = '';
      if (caixa) caixa.hidden = true;
      desenharCartao();
      return;
    }
    mostrarAviso('');
    const todas = Array.isArray(dados.integracoes) ? dados.integracoes : [];
    resumo.textContent = frase(todas);
    const vis = visiveis(todas, estadoTela.modoAula);
    if (!vis.some((i) => i.id === estadoTela.selecionado)) estadoTela.selecionado = null;
    if (caixa) caixa.hidden = !todas.length;
    if (!todas.length) { mapa.textContent = ''; lista.textContent = ''; parar(); desenharCartao(); return; }
    if (!vis.length) {
      mapa.textContent = ''; lista.textContent = ''; parar();
      mapa.appendChild(h('p', { class: 'int-vazio' }, 'Nenhum sistema está funcionando agora, então o modo aula não tem o que mostrar.'));
      desenharCartao();
      return;
    }
    const agente = dados.agente || { nome: 'Agente', slug: '' };
    desenharMapa(mapa, agente, vis);
    const movel = el$('int-agente');
    if (movel) desenharAgenteMovel(movel, agente);
    desenharLista(lista, vis);
    desenharCartao();
  }

  function mostrarErro(r) {
    const c = (r && r.corpo) || {};
    const causa = c.error || (r && r.status ? 'o painel respondeu com o código ' + r.status : 'sem resposta do painel');
    const resumo = el$('int-resumo-texto');
    if (resumo) resumo.textContent = 'Não consegui carregar as integrações.';
    mostrarAviso('Não consegui carregar as integrações: ' + aparar(causa, 300) + ' ' + aparar(c.howToFix || 'Confira a internet e tente de novo.', 200));
    const caixa = el$('int-mapa-caixa');
    if (caixa) caixa.hidden = true;
    parar();
  }

  async function carregar(opcoes) {
    if (opcoes && typeof opcoes.foto === 'string') estadoTela.foto = opcoes.foto;
    if (!el$('int-mapa')) return;
    ligar();
    const get = raiz.API && raiz.API.pedir ? raiz.API.pedir('/api/integracoes') : null;
    if (!get) { mostrarErro({ corpo: { error: 'O painel não carregou por inteiro.', howToFix: 'Recarregue a página.' } }); return; }
    const r = await get;
    if (!r.ok || !r.corpo || r.corpo.ok === false) { mostrarErro(r); return; }
    // Recarga automática que não mudou nada não refaz o desenho (o foco do teclado fica onde está).
    const assinatura = JSON.stringify(r.corpo);
    if (opcoes && opcoes.silencioso && assinatura === estadoTela.assinatura) return;
    estadoTela.assinatura = assinatura;
    estadoTela.dados = r.corpo;
    desenhar();
  }

  // Liga o alternador, o "?" do resumo e a recarga a cada 30 s (só com a aba do painel à vista).
  let ligado = false;
  function ligar() {
    if (ligado) return;
    ligado = true;
    document.querySelectorAll('#int-alternar [data-modo]').forEach((b) => {
      b.addEventListener('click', () => {
        estadoTela.modoAula = b.dataset.modo === 'aula';
        document.querySelectorAll('#int-alternar [data-modo]').forEach((x) => {
          const ativo = x === b;
          x.classList.toggle('ativo', ativo);
          x.setAttribute('aria-pressed', String(ativo));
        });
        desenhar();
      });
    });
    const res = el$('int-resumo');
    if (res && !res.querySelector('.app-ajuda-secao')) {
      const aj = h('button', { type: 'button', class: 'app-ajuda-secao', 'aria-label': 'O que é esta seção', title: 'O que é esta seção, e como a conta é feita' }, '?');
      aj.addEventListener('click', () => { if (raiz.DGTutoriais) raiz.DGTutoriais.abrir('integracoes', 'resumo'); });
      res.appendChild(aj);
    }
    estadoTela.timer = raiz.setInterval(() => {
      const painel = el$('panel-integracoes');
      if (!document.hidden && painel && painel.getClientRects().length) carregar({ silencioso: true });
    }, 30000);
  }

  raiz.DGIntegracoes = { carregar, puro };
})(typeof window !== 'undefined' ? window : globalThis);
