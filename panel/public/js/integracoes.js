// integracoes.js: a aba Integrações. Um palco sóbrio: a foto do agente no centro (o logo do DG Claw se
// ele não tiver foto) e, ligada por uma linha reta, uma placa chapada para cada sistema externo que ele
// já usou (WhatsApp, Instagram, banco...), com ícone, nome, estado escrito e uma forma própria por estado.
//
// DE ONDE VEM O DADO. De /api/integracoes (lib/integracoes.js), que lê o estado.json anotado pelos
// programas que falam com cada sistema. QUEM DECIDE A COR É O SERVIDOR: esta tela só desenha. Se ela
// calculasse cor também, seriam duas regras para a mesma coisa.
//
// SEGURANÇA. Todo texto vindo da API entra por textContent ou setAttribute (nunca HTML montado com
// dado). A classe de cor sai de uma tabela deste arquivo, indexada pelo `estado` já validado, e o
// ícone sai de uma lista deste arquivo (nome desconhecido vira `link`).
//
// MOVIMENTO. As placas flutuam de leve e um pulso chapado anda pela reta. Tudo para quando a aba do
// navegador fica escondida. Com "reduzir movimento" sobra só uma deriva mínima e o pulso não existe:
// ficam a cor, a forma e a palavra do estado.
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
  const NS = 'http://www.w3.org/2000/svg';
  const LOGO = '/marca/logo'; // o logo da marca: o do DG Claw, ou o personalizado quando o Web tem marca própria

  const estadoTela = { dados: null, modoAula: false, selecionado: null, foto: '', nos: [], raf: 0, timer: 0, T: 5, ultimo: 0, larguraDesenhada: 0 };

  function h(tag, attrs, texto) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    if (texto != null) e.textContent = texto;
    return e;
  }
  function s(tag, attrs, pai, texto) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k]));
    if (texto != null) e.textContent = texto;
    if (pai) pai.appendChild(e);
    return e;
  }
  function iconeSvg(nome, atributos, pai) {
    const el = s('use', Object.assign({ href: '/ds/icones.svg#i-' + iconeSeguro(nome) }, atributos || {}), pai);
    return el;
  }
  const el$ = (id) => document.getElementById(id);
  const reduzMovimento = () => !!(raiz.matchMedia && raiz.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function fotoValida(url) {
    return typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/';
  }

  // O desenho do estado: cada estado tem uma FORMA própria, para a cor não ser a única pista.
  // verde = círculo com visto, amarelo = triângulo com "!", vermelho = losango com X,
  // desligado = círculo tracejado com pausa, sem uso recente = círculo com relógio.
  // A cor vem do CSS (classe int-e-<estado> no elemento de fora): aqui só a forma.
  function glifo(estado, r, pai) {
    const k = r / 10;
    const g = s('g', null, pai);
    const furo = { class: 'int-fs int-nf', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (estado === 'verde') {
      s('circle', { r, class: 'int-gf' }, g);
      s('path', Object.assign({ d: 'M' + (-4.6 * k) + ' ' + (0.4 * k) + 'L' + (-1.2 * k) + ' ' + (3.8 * k) + 'L' + (5 * k) + ' ' + (-3.6 * k), 'stroke-width': 2.2 * k }, furo), g);
    } else if (estado === 'amarelo') {
      s('path', { d: 'M0 ' + (-r * 1.15) + 'L' + (r * 1.1) + ' ' + (r * 0.85) + 'L' + (-r * 1.1) + ' ' + (r * 0.85) + 'Z', class: 'int-gf int-gs', 'stroke-width': k, 'stroke-linejoin': 'round' }, g);
      s('path', { d: 'M0 ' + (-3.6 * k) + 'V' + (2 * k), class: 'int-fs', 'stroke-width': 2 * k, 'stroke-linecap': 'round' }, g);
      s('circle', { cy: 4.6 * k, r: 1.2 * k, class: 'int-ff' }, g);
    } else if (estado === 'vermelho') {
      s('rect', { x: -r * 0.82, y: -r * 0.82, width: r * 1.64, height: r * 1.64, rx: r * 0.3, transform: 'rotate(45)', class: 'int-gf' }, g);
      s('path', { d: 'M' + (-3 * k) + ' ' + (-3 * k) + 'L' + (3 * k) + ' ' + (3 * k) + 'M' + (3 * k) + ' ' + (-3 * k) + 'L' + (-3 * k) + ' ' + (3 * k), class: 'int-fs', 'stroke-width': 2.2 * k, 'stroke-linecap': 'round' }, g);
    } else if (estado === 'desligado') {
      s('circle', { r: r * 0.92, class: 'int-ff int-gs', 'stroke-width': 1.5 * k, 'stroke-dasharray': (2.4 * k) + ' ' + (2.2 * k) }, g);
      s('path', { d: 'M' + (-2.2 * k) + ' ' + (-3 * k) + 'V' + (3 * k) + 'M' + (2.2 * k) + ' ' + (-3 * k) + 'V' + (3 * k), class: 'int-gs int-nf', 'stroke-width': 1.8 * k, 'stroke-linecap': 'round' }, g);
    } else {
      s('circle', { r: r * 0.92, class: 'int-ff int-gs', 'stroke-width': 1.4 * k }, g);
      s('path', { d: 'M0 ' + (-4 * k) + 'V0L' + (3 * k) + ' ' + (2 * k), class: 'int-gs int-nf', 'stroke-width': 1.5 * k, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    }
    return g;
  }
  function glifoSolto(estado, lado) {
    const e = estadoDe(estado) || ESTADO_DESCONHECIDO;
    const svg = s('svg', { viewBox: '-12 -12 24 24', width: lado, height: lado, 'aria-hidden': 'true', focusable: 'false', class: 'int-e-' + e.cls });
    glifo(estado, 9, svg);
    return svg;
  }

  // ── o palco em SVG ──────────────────────────────────────────────────────────
  const CELULAR_ATE = 600;
  const JITTER = [0, -8, 6, -4, 8];

  /**
   * Onde cada placa fica quando está parada. `layout` dá o ângulo e a distância de cada uma (com
   * variação por hash do id); aqui isso vira posição no palco. No computador, numa elipse em volta
   * do agente; no celular, em duas colunas (esquerda e direita), cada placa na ordem do ângulo.
   */
  function posicoes(nos, L, movel, pw, ph) {
    const dois = nos.some((n) => n.anel === 2);
    const ref = (dois ? 1.7 : 1) * 1.12;
    if (!movel) {
      const rx = L.w / 2 - pw / 2 - 16, ry = L.hh - ph / 2 - 10;
      return nos.map((n) => ({ bx: n.x / ref * rx, by: n.y / ref * ry }));
    }
    const colx = L.w / 2 - pw / 2 - 6;
    const lado = (n) => (Math.cos(n.angulo) >= 0 ? 1 : -1);
    return nos.map((n, i) => {
      const dir = lado(n);
      const col = nos.filter((m) => lado(m) === dir).sort((a, b) => Math.sin(a.angulo) - Math.sin(b.angulo));
      const r = col.indexOf(n);
      const folga = L.hh - 40;
      const by = col.length > 1 ? (r / (col.length - 1) - 0.5) * 2 * folga : 0;
      return { bx: dir * (colx + JITTER[r % JITTER.length] * dir), by: by + (dir > 0 ? 0 : L.hh * 0.08 * (col.length > 1 ? 1 : 0)) };
    });
  }

  function desenharMapa(destino, agente, lista) {
    parar();
    estadoTela.nos = [];
    destino.textContent = '';
    const palco = el$('int-mapa-caixa');
    const w = Math.max(280, (palco && palco.clientWidth) || destino.clientWidth || 900);
    const movel = w <= CELULAR_ATE;
    estadoTela.larguraDesenhada = w;
    // No celular o agente encolhe e as placas dividem o resto da largura, duas colunas sem se tocar.
    const rf = movel ? 34 : RAIO_FOTO;
    const pw = movel ? Math.max(92, Math.min(122, Math.floor((w - 2 * rf - 32) / 2))) : 160, ph = movel ? 40 : 48;
    const topo = movel ? 34 : 30, legenda = movel ? 84 : 56;
    // No celular a altura vem das colunas: 64 px por fileira da coluna mais cheia.
    const fileiras = Math.max(1, Math.ceil(lista.length / 2));
    const alt = movel ? Math.max(560, topo + legenda + 26 + 2 * ((fileiras - 1) * 32 + 40)) : 640;
    if (palco) palco.style.height = alt + 'px';
    const hh = (alt - legenda - 26 - topo) / 2;
    const L = { w, cx: w / 2, cy: topo + hh, hh };

    const { nos } = layout(lista.map((i) => i.id), { raioBase: 1 });
    const pos = posicoes(nos, L, movel, pw, ph);
    const porId = {};
    lista.forEach((i) => { porId[i.id] = i; });

    const svg = s('svg', {
      class: 'int-svg', viewBox: '0 0 ' + w + ' ' + alt, role: 'group', 'aria-label': 'Mapa das integrações de ' + aparar(agente.nome, 40),
    });
    const clip = s('clipPath', { id: 'int-recorte-foto' }, s('defs', null, svg));
    s('circle', { r: rf, cx: 0, cy: 0 }, clip);
    const camadaLinhas = s('g', null, svg);
    const camadaPulsos = s('g', { 'aria-hidden': 'true' }, svg);
    const camadaNos = s('g', null, svg);
    const animar = !reduzMovimento();

    const itens = nos.map((n, i) => ({ n, it: porId[n.id], bx: pos[i].bx, by: pos[i].by, z: fracao(n.id, 'z'), ph: fracao(n.id, 'p') * 7, f1: 0.3 + fracao(n.id, 'f1') * 0.2, f2: 0.27 + fracao(n.id, 'f2') * 0.2 }));
    itens.sort((a, b) => a.z - b.z); // as de longe primeiro, as de perto por cima

    itens.forEach((o) => {
      const it = o.it;
      const e = estadoDe(it.estado) || ESTADO_DESCONHECIDO;
      const estado = estadoDe(it.estado) ? it.estado : 'sem_uso_recente';
      const palavra = palavraDe(it);
      const nome = aparar(it.nome || it.id, 40);
      const apagado = e.cls === 'desligado' || e.cls === 'sem-uso';
      const vermelho = e.cls === 'vermelho';
      const dash = { verde: '', amarelo: '7 5', vermelho: '3 4', desligado: '2 6', sem_uso_recente: '12 7' }[estado] || '';

      const linha = s('line', { class: 'int-linha int-e-' + e.cls + (apagado ? ' int-linha-apagada' : ''), 'stroke-linecap': 'round' }, camadaLinhas);
      if (dash) linha.setAttribute('stroke-dasharray', dash);
      let marca = null;
      if (vermelho) marca = s('path', { d: 'M-4 -4L4 4M4 -4L-4 4', class: 'int-marca int-e-' + e.cls, 'stroke-linecap': 'round' }, camadaLinhas);
      const ponto = e.pulso && animar ? s('rect', { x: -3.5, y: -3.5, width: 7, height: 7, class: 'int-pulso int-e-' + e.cls, opacity: 0 }, camadaPulsos) : null;

      const g = s('g', {
        class: 'int-no int-e-' + e.cls + (estadoTela.selecionado === it.id ? ' int-sel' : ''),
        tabindex: 0, role: 'button', 'aria-label': nome + ': ' + palavra,
        'aria-pressed': estadoTela.selecionado === it.id ? 'true' : 'false',
      }, camadaNos);
      const corpo = s('g', null, g);
      s('rect', { class: 'int-placa' + (vermelho ? ' int-placa-vermelha' : '') + (e.cls === 'desligado' ? ' int-placa-desligada' : ''), x: -pw / 2, y: -ph / 2, width: pw, height: ph, rx: 6 }, corpo);
      const faixa = vermelho ? 6 : 4;
      s('path', { class: 'int-faixa', d: 'M' + (-pw / 2) + ' ' + (-ph / 2 + 6) + 'a6 6 0 0 1 6 -6h' + faixa + 'v' + ph + 'h' + (-faixa) + 'a6 6 0 0 1 -6 -6z' }, corpo);
      s('rect', { class: 'int-foco', x: -pw / 2 - 3, y: -ph / 2 - 3, width: pw + 6, height: ph + 6, rx: 8 }, corpo);
      const ic = movel ? 17 : 20;
      const svgIcone = s('svg', { viewBox: '0 0 24 24', x: -pw / 2 + (movel ? 12 : 14), y: -ic / 2, width: ic, height: ic, class: 'int-no-icone', 'aria-hidden': 'true', focusable: 'false' }, corpo);
      iconeSvg(it.icone, null, svgIcone);
      const tx = -pw / 2 + (movel ? 33 : 42);
      s('text', { class: 'int-rotulo', x: tx, y: -2, 'font-size': movel ? 11 : 14 }, corpo, aparar(nome, 15));
      s('text', { class: 'int-palavra', x: tx + (movel ? 12 : 15), y: movel ? 11 : 14, 'font-size': movel ? 9.5 : 11.5 }, corpo, aparar(palavra, 17));
      const sel = s('g', { transform: 'translate(' + (tx + (movel ? 4.5 : 6)) + ' ' + (movel ? 7.5 : 10.5) + ')' }, corpo);
      glifo(estado, movel ? 4.6 : 5.4, sel);
      const abrir = () => selecionar(it.id, g);
      g.addEventListener('click', (ev) => { ev.stopPropagation(); abrir(); });
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); abrir(); }
      });
      estadoTela.nos.push({ o, g, linha, marca, ponto, estado, bx: o.bx, by: o.by });
    });

    // O centro: a foto do agente num círculo chapado com borda fina. Sem foto (ou se ela falhar),
    // entra o logo da marca; se nem o logo carregar, a inicial do nome.
    const centro = s('g', { class: 'int-centro' }, svg);
    s('circle', { class: 'int-centro-fundo', r: rf }, centro);
    const letra = (String(agente.nome || '?').trim().charAt(0) || '?').toUpperCase();
    const inicial = s('text', { class: 'int-centro-letra', y: 11, 'text-anchor': 'middle', visibility: 'hidden' }, centro, letra);
    const logo = s('image', { href: LOGO, x: -rf * 0.62, y: -rf * 0.62, width: rf * 1.24, height: rf * 1.24, class: 'int-centro-logo', preserveAspectRatio: 'xMidYMid meet' }, centro);
    logo.addEventListener('error', () => { logo.remove(); inicial.setAttribute('visibility', 'visible'); });
    if (fotoValida(estadoTela.foto)) {
      const img = s('image', {
        href: estadoTela.foto, x: -rf, y: -rf, width: rf * 2, height: rf * 2,
        'clip-path': 'url(#int-recorte-foto)', preserveAspectRatio: 'xMidYMid slice', class: 'int-centro-foto',
      }, centro);
      logo.setAttribute('visibility', 'hidden'); // com foto, o logo só aparece se a foto falhar
      img.addEventListener('error', () => { img.remove(); logo.setAttribute('visibility', 'visible'); });
    }
    s('circle', { class: 'int-centro-aro', r: rf }, centro);
    s('text', { class: 'int-centro-nome', y: rf + (movel ? 20 : 24), 'text-anchor': 'middle' }, centro, aparar(agente.nome, 30));
    s('text', { class: 'int-centro-sub', y: rf + (movel ? 35 : 40), 'text-anchor': 'middle' }, centro, 'agente');
    estadoTela.centro = centro;
    estadoTela.L = L;

    destino.appendChild(svg);

    // A legenda: o desenho de cada estado, escrito ao lado.
    const leg = h('div', { class: 'int-legenda' });
    Object.keys(ESTADOS).forEach((k) => {
      const item = h('span');
      item.appendChild(glifoSolto(k, 16));
      item.appendChild(document.createTextNode(ESTADOS[k].palavra));
      leg.appendChild(item);
    });
    destino.appendChild(leg);
    quadro(performance.now(), true);
    iniciar();
  }

  // ── o movimento ─────────────────────────────────────────────────────────────
  // Flutuação leve de cada placa e o pulso, um quadradinho chapado que anda pela reta do agente
  // até a placa. Verde calmo, amarelo lento e piscando, vermelho para no meio e some (na linha
  // fica o X). Com "reduzir movimento" a flutuação cai ao mínimo e o pulso não existe.
  function sinal(o, T) {
    const dur = DURACAO[ESTADOS[o.estado].pulso];
    const q = (((T * 1000) / dur + o.o.ph) % 1 + 1) % 1;
    if (o.estado === 'amarelo') return { p: q < 0.5 ? q * q * 2 : 1 - (1 - q) * (1 - q) * 2, o: 0.55 + 0.45 * Math.abs(Math.sin(T * 6 + o.o.ph)) > 0.5 ? 1 : 0 };
    if (o.estado === 'vermelho') return { p: Math.min(q * 1.45, 0.62), o: q < 0.5 ? 1 : 0 };
    return { p: q, o: 1 };
  }
  function quadro(agora, soUmQuadro) {
    if (!soUmQuadro) estadoTela.raf = 0;
    if (document.hidden && !soUmQuadro) return;
    const ns = estadoTela.nos;
    if (!ns.length || !estadoTela.centro || !estadoTela.centro.isConnected) return;
    const svg = estadoTela.centro.ownerSVGElement;
    if (!soUmQuadro && svg && !svg.getClientRects().length) { estadoTela.raf = raf(quadro); return; } // aba do painel escondida
    const dt = estadoTela.ultimo ? Math.min(0.05, (agora - estadoTela.ultimo) / 1000) : 0.016;
    estadoTela.ultimo = agora;
    const mov = reduzMovimento() ? 0 : 1;
    estadoTela.T += dt * (0.28 + 0.72 * mov);
    const T = estadoTela.T;
    const amp = 1.3 + 4.7 * mov;
    const { cx, cy } = estadoTela.L;
    estadoTela.centro.setAttribute('transform', 'translate(' + cx + ' ' + (cy + Math.sin(T * 0.3) * amp * 0.3).toFixed(1) + ')');
    for (const n of ns) {
      const o = n.o;
      const x = cx + n.bx + Math.sin(T * o.f1 + o.ph) * amp * (0.6 + 0.8 * o.z);
      const y = cy + n.by + Math.cos(T * o.f2 + o.ph * 1.3) * amp * (0.6 + 0.8 * o.z);
      const sc = 0.8 + 0.24 * o.z; // de perto: maior e opaco. De longe: menor e um pouco apagado
      n.g.setAttribute('transform', 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + sc.toFixed(3) + ')');
      n.g.setAttribute('opacity', (0.78 + 0.22 * o.z).toFixed(2));
      n.linha.setAttribute('x1', cx); n.linha.setAttribute('y1', cy.toFixed(1));
      n.linha.setAttribute('x2', x.toFixed(1)); n.linha.setAttribute('y2', y.toFixed(1));
      const dx = x - cx, dy = y - cy;
      if (n.marca) n.marca.setAttribute('transform', 'translate(' + (cx + dx * 0.64).toFixed(1) + ' ' + (cy + dy * 0.64).toFixed(1) + ')');
      if (n.ponto) {
        const sn = sinal(n, T);
        n.ponto.setAttribute('transform', 'translate(' + (cx + dx * sn.p).toFixed(1) + ' ' + (cy + dy * sn.p).toFixed(1) + ') rotate(45)');
        n.ponto.setAttribute('opacity', sn.o);
      }
    }
    if (!soUmQuadro) estadoTela.raf = raf(quadro);
  }
  function raf(fn) { return raiz.requestAnimationFrame(fn); }
  function iniciar() {
    if (estadoTela.raf || !estadoTela.nos.length || document.hidden) return;
    estadoTela.ultimo = 0;
    estadoTela.raf = raf(quadro);
  }
  function parar() {
    if (estadoTela.raf) raiz.cancelAnimationFrame(estadoTela.raf);
    estadoTela.raf = 0;
  }
  raiz.addEventListener('resize', () => {
    const palco = el$('int-mapa-caixa');
    if (palco && estadoTela.dados && palco.clientWidth && Math.abs(palco.clientWidth - estadoTela.larguraDesenhada) > 40) desenhar();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) parar(); else iniciar(); });

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
    caixa.className = 'int-cartao int-e-' + e.cls;

    const cab = h('div', { class: 'int-cartao-cab' });
    const titulo = h('h3', { class: 'int-cartao-nome' }, aparar(it.nome || it.id, 60));
    cab.appendChild(titulo);
    const selo = h('span', { class: 'int-selo int-e-' + e.cls });
    selo.appendChild(glifoSolto(it.estado, 20));
    selo.appendChild(document.createTextNode(palavraDe(it)));
    cab.appendChild(selo);
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
    // O foco volta para o nó (o desenho foi refeito).
    const candidatos = document.querySelectorAll('#panel-integracoes .int-no[aria-pressed="true"]');
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
    const caixa = el$('int-mapa-caixa');
    if (!dados || !mapa) return;

    if (dados.medido === false) {
      // Nunca o mapa verde: só o motivo.
      resumo.textContent = 'Não foi possível medir as integrações agora.';
      mostrarAviso(aparar(dados.motivo || 'O painel não conseguiu ler o registro das integrações.', 400));
      mapa.textContent = ''; parar();
      estadoTela.nos = [];
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
    if (!todas.length) { mapa.textContent = ''; parar(); estadoTela.nos = []; desenharCartao(); return; }
    if (!vis.length) {
      mapa.textContent = ''; parar(); estadoTela.nos = [];
      if (caixa) caixa.style.height = '';
      mapa.appendChild(h('p', { class: 'int-vazio' }, 'Nenhum sistema está funcionando agora, então o modo aula não tem o que mostrar.'));
      desenharCartao();
      return;
    }
    const agente = dados.agente || { nome: 'Agente', slug: '' };
    desenharMapa(mapa, agente, vis);
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
    const get = typeof API !== 'undefined' && API.integracoes ? API.integracoes() : null;
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
