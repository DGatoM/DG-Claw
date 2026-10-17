'use strict';
/* foco-tela.js: o "Modo foco" na conversa, a lista curta que o agente monta e o dono tica.

   Contrato em web/docs/MODO-FOCO.md. Consome GET /api/v1/foco/<agente> (carga inicial) e
   PATCH /api/v1/foco/<agente>/itens/<id> {feito} (tique). As mudanças feitas pelo agente chegam pelo
   evento `foco` do stream; o conversa.js repassa para DGFoco.recebe(dados).

   Layout: com espaço livre à esquerda da coluna da conversa (#wrap), vira painel fixo ali; sem espaço
   (celular, janela estreita), vira uma faixa fixa logo abaixo do cabeçalho, e tocar nela abre a lista.
   A parte de medir espaço (modoLayout) e de contar (contador) é pura e tem teste em web/test/foco-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGFoco = m.inicia(raiz);
})(this, function () {
  const LARGURA_MIN = 240, LARGURA_MAX = 300, FOLGA = 12;

  /** Decide painel ou faixa. colunaEsq = borda esquerda da coluna da conversa; menuDir = borda direita do menu fixo (0 no celular). */
  function modoLayout(colunaEsq, menuDir) {
    const espaco = (Number(colunaEsq) || 0) - (Number(menuDir) || 0);
    if (espaco < LARGURA_MIN + FOLGA) return { tipo: 'faixa' };
    const largura = Math.min(LARGURA_MAX, espaco - FOLGA);
    return { tipo: 'painel', largura, esq: Math.round(colunaEsq - largura - 8) };
  }

  /** { feitos, total, pct } a partir dos itens (não confia nos totais que vieram prontos). */
  function contador(lista) {
    const itens = lista && Array.isArray(lista.itens) ? lista.itens : [];
    const feitos = itens.filter(i => i.feito).length;
    return { feitos, total: itens.length, pct: itens.length ? Math.round(feitos / itens.length * 100) : 0 };
  }

  const ordenados = lista => (lista.itens || []).slice().sort((a, b) => (a.ordem || 0) - (b.ordem || 0) || (a.id || 0) - (b.id || 0));

  const EXEMPLO = {
    titulo: 'Foco de hoje', versao: 0,
    itens: [
      { id: 1, texto: 'Revisar o contrato da Vitória', feito: true, ordem: 1 },
      { id: 2, texto: 'Ligar pro Fernando', feito: false, ordem: 2 },
      { id: 3, texto: 'Mandar a proposta pra Carla', feito: false, ordem: 3 },
    ],
  };

  /** Monta a instância. amb = { doc, win, fetch, storage, agente }. Separado de inicia() para o teste injetar tudo falso. */
  function criar(amb) {
    const { doc, win, storage, agente } = amb;
    const URL_LISTA = '/api/v1/foco/' + encodeURIComponent(agente);
    const CHAVE = 'dgclaw:foco:aberto:' + agente;
    const est = { lista: null, erro: '', aviso: '', demo: false, aberto: null, emVoo: new Set(), modo: { tipo: 'faixa' } };

    const h = (tag, cls, texto) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (texto != null) e.textContent = texto;
      return e;
    };
    const limpa = e => { while (e.firstChild) e.removeChild(e.firstChild); };

    // ── Esqueleto (montado uma vez, redesenhado a cada mudança) ──
    const raizEl = h('section', 'foco');
    raizEl.setAttribute('data-tour', 'foco');
    raizEl.setAttribute('aria-label', 'Modo foco');
    raizEl.hidden = true;
    const cab = h('div', 'foco-cab');
    const btnAbre = h('button', 'foco-abre');
    btnAbre.type = 'button';
    const rotulo = h('span', 'foco-rotulo');
    const placar = h('span', 'foco-placar');
    const seta = h('span', 'foco-seta');
    seta.setAttribute('aria-hidden', 'true');
    btnAbre.appendChild(rotulo); btnAbre.appendChild(placar); btnAbre.appendChild(seta);
    const btnAjuda = h('button', 'foco-ajuda', '?');
    btnAjuda.type = 'button';
    btnAjuda.setAttribute('aria-label', 'Como funciona o modo foco');
    btnAjuda.title = 'Como funciona o modo foco';
    cab.appendChild(btnAbre); cab.appendChild(btnAjuda);
    const corpo = h('div', 'foco-corpo');
    const barra = h('div', 'foco-barra');
    barra.setAttribute('role', 'progressbar');
    barra.setAttribute('aria-valuemin', '0'); barra.setAttribute('aria-valuemax', '100');
    const enche = h('i', 'foco-enche');
    barra.appendChild(enche);
    const ul = h('ul', 'foco-lista');
    const avisoEl = h('p', 'foco-aviso');
    avisoEl.setAttribute('role', 'alert');
    corpo.appendChild(barra); corpo.appendChild(ul); corpo.appendChild(avisoEl);
    raizEl.appendChild(cab); raizEl.appendChild(corpo);

    const exibida = () => (est.demo ? EXEMPLO : est.lista);
    const temItens = () => { const l = exibida(); return !!l && Array.isArray(l.itens) && l.itens.length > 0; };

    function lerAberto() {
      if (est.aberto !== null) return est.aberto;
      let v = null;
      try { v = storage.getItem(CHAVE); } catch (e) { console.warn('foco: não consegui ler ' + CHAVE + ' do aparelho:', e.message); }
      est.aberto = v === '1' ? true : v === '0' ? false : null;
      return est.aberto;
    }
    // sem escolha guardada: painel começa aberto, faixa começa recolhida
    const estaAberto = () => { const v = lerAberto(); return v === null ? est.modo.tipo === 'painel' : v; };
    function alternar() {
      est.aberto = !estaAberto();
      try { storage.setItem(CHAVE, est.aberto ? '1' : '0'); } catch (e) { console.warn('foco: não consegui guardar ' + CHAVE + ' no aparelho:', e.message); }
      desenha();
    }

    // ── Layout ──
    function mede() {
      const wrap = doc.getElementById('wrap'), menu = doc.getElementById('menu');
      if (!wrap || !wrap.getBoundingClientRect) return { tipo: 'faixa' };
      const esq = wrap.getBoundingClientRect().left;
      const menuDir = menu && menu.getBoundingClientRect ? Math.max(0, menu.getBoundingClientRect().right) : 0;
      return modoLayout(esq, menuDir);
    }
    /* painel: solto no body (fixo à esquerda). Faixa: item do fluxo flex do body, logo depois do
       cabeçalho (e da faixa de lembretes, se existir), então empurra a conversa sozinha. */
    function colocaRaiz(painel) {
      const cab = !painel && doc.querySelector ? doc.querySelector('header') : null;
      if (!cab || !cab.parentNode) { if (raizEl.parentNode !== doc.body) doc.body.appendChild(raizEl); return; }
      let ref = cab;
      const lem = doc.getElementById('faixaLembretes');
      if (lem && lem.parentNode === cab.parentNode) ref = lem;
      if (raizEl.previousSibling !== ref || raizEl.parentNode !== cab.parentNode) cab.parentNode.insertBefore(raizEl, ref.nextSibling);
    }
    function posiciona() {
      est.modo = est.erro && !exibida() ? { tipo: 'faixa' } : mede();
      const painel = est.modo.tipo === 'painel';
      colocaRaiz(painel);
      raizEl.className = 'foco ' + (painel ? 'foco-painel' : 'foco-faixa') + (estaAberto() ? ' aberto' : '') + (est.erro && !exibida() ? ' foco-so-erro' : '');
      if (painel) { raizEl.style.width = est.modo.largura + 'px'; raizEl.style.left = est.modo.esq + 'px'; }
      else { raizEl.style.width = ''; raizEl.style.left = ''; }
    }

    function desenha() {
      const l = exibida();
      const visivel = temItens() || !!est.erro;
      raizEl.hidden = !visivel;
      if (!visivel) { posiciona(); return; }
      const c = contador(l);
      posiciona();
      const aberto = estaAberto();
      if (!l && est.erro) {
        rotulo.textContent = '🎯 Foco indisponível';
        placar.textContent = '';
        avisoEl.textContent = est.erro;
        avisoEl.title = est.erro;
        avisoEl.hidden = false;
        limpa(ul); barra.hidden = true;
        btnAjuda.hidden = true;
        btnAbre.setAttribute('aria-expanded', 'false');
        seta.textContent = '';
        return;
      }
      btnAjuda.hidden = false; barra.hidden = false;
      rotulo.textContent = '🎯 ' + (l.titulo || 'Foco');
      placar.textContent = c.feitos + ' de ' + c.total;
      seta.textContent = aberto ? '▴' : '▾';
      btnAbre.setAttribute('aria-expanded', aberto ? 'true' : 'false');
      btnAbre.title = aberto ? 'Recolher a lista' : 'Abrir a lista';
      enche.style.width = c.pct + '%';
      barra.setAttribute('aria-valuenow', String(c.pct));
      barra.setAttribute('aria-label', c.feitos + ' de ' + c.total + ' feitos');
      limpa(ul);
      for (const it of ordenados(l)) {
        const li = h('li', 'foco-item' + (it.feito ? ' feito' : ''));
        const b = h('button', 'foco-tique');
        b.type = 'button';
        b.setAttribute('role', 'checkbox');
        b.setAttribute('aria-checked', it.feito ? 'true' : 'false');
        b.appendChild(h('span', 'foco-caixa', it.feito ? '✓' : ''));
        b.appendChild(h('span', 'foco-texto', it.texto));
        b.addEventListener('click', () => tica(it.id));
        li.appendChild(b);
        ul.appendChild(li);
      }
      const msg = est.aviso || (est.erro && l ? est.erro : '');
      avisoEl.textContent = msg;
      avisoEl.hidden = !msg;
    }

    // ── Dados ──
    function aplica(lista) {
      if (!lista || !Array.isArray(lista.itens)) return false;
      if (est.lista && typeof lista.versao === 'number' && typeof est.lista.versao === 'number' && lista.versao < est.lista.versao) return false;
      est.lista = lista; est.erro = ''; est.aviso = '';
      desenha();
      return true;
    }

    /** Chamado pelo conversa.js com o evento `foco` do stream: { agente, lista } ou { agente, lista: null, erro }. */
    function recebe(d) {
      if (!d || (d.agente && d.agente !== agente)) return;
      if (d.lista) { aplica(d.lista); return; }
      const motivo = d.erro || 'o servidor mandou o foco sem a lista e sem dizer o motivo';
      console.warn('foco: o stream avisou que não leu a lista de ' + agente + ': ' + motivo);
      est.erro = 'Não consegui ler a lista do foco: ' + motivo;
      desenha();
    }

    async function pede(url, init) {
      let r;
      try { r = await amb.fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, init)); }
      catch (e) { throw new Error('o app não respondeu (' + (e.message || 'sem rede') + ')'); }
      let d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      if (!r.ok || (d && d.ok === false)) {
        const base = (d && d.erro) || ('a API respondeu ' + r.status);
        throw new Error(r.status === 401 ? base + ' (entre de novo: a sessão expirou)' : base);
      }
      return d || {};
    }

    async function carrega() {
      try {
        const d = await pede(URL_LISTA);
        if (d.lista) aplica(d.lista);
      } catch (e) {
        console.warn('foco: GET ' + URL_LISTA + ' falhou:', e.message);
        est.erro = 'Não consegui carregar o foco: ' + e.message + '. Recarregue a página.';
        desenha();
      }
    }

    async function tica(id) {
      if (est.demo) return;
      const item = est.lista && est.lista.itens.find(i => i.id === id);
      if (!item || est.emVoo.has(id)) return;
      const antes = item.feito, novo = !antes;
      est.emVoo.add(id);
      item.feito = novo; est.aviso = '';
      desenha();
      try {
        const d = await pede(URL_LISTA + '/itens/' + encodeURIComponent(id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feito: novo }),
        });
        est.emVoo.delete(id);
        if (!d.lista || !aplica(d.lista)) desenha();
      } catch (e) {
        est.emVoo.delete(id);
        console.warn('foco: PATCH do item ' + id + ' falhou:', e.message);
        // volta ao estado anterior, a não ser que uma lista nova já tenha trazido outro valor
        const atual = est.lista && est.lista.itens.find(i => i.id === id);
        if (atual && atual.feito === novo) atual.feito = antes;
        est.aviso = 'Não consegui ' + (novo ? 'marcar' : 'desmarcar') + ' o item: ' + e.message + '. Tente de novo.';
        desenha();
      }
    }

    // ── Tutorial ──
    function passoTutorial() {
      return {
        alvo: '[data-tour="foco"]',
        // sem lista de verdade, mostra um exemplo só durante a visita
        antes: () => { if (!temItens()) { est.demo = true; desenha(); } },
        depois: () => { if (est.demo) { est.demo = false; desenha(); } },
        titulo: 'O modo foco',
        oque: 'Uma lista curta do que você quer fechar agora, pendurada ao lado da conversa (ou numa faixa no alto, no celular). Mostra o placar, como "3 de 6", e uma barra de progresso. Ela só aparece quando o agente monta uma lista.',
        como: 'Peça ao agente algo como "monta meu foco de hoje". Ele cria a lista e ela surge aqui sozinha. Toque num item para marcar como feito (de novo para desmarcar). O agente fica sabendo do que você marcou na sua próxima mensagem, ou quando ele conferir. Para recolher ou abrir a lista, toque no título.',
        porque: 'Assim você vê de relance o que falta, sem perder a conversa de vista, e o agente trabalha olhando para a mesma lista que você.',
      };
    }

    btnAbre.addEventListener('click', alternar);
    btnAjuda.addEventListener('click', () => {
      if (win.DGTour) win.DGTour.inicia({ passos: [passoTutorial()] });
      else { est.aviso = 'A visita guiada não carregou. Recarregue a página e tente de novo.'; desenha(); }
    });
    if (win.addEventListener) {
      win.addEventListener('resize', () => { if (!raizEl.hidden) desenha(); });
      win.addEventListener('dgclaw:foco', ev => recebe(ev && ev.detail));
    }

    return { passoTutorial, recebe, carrega, _est: est, _raiz: raizEl, _tica: tica, _desenha: desenha };
  }

  /** No navegador: descobre o agente pela URL (/a/<slug>), liga tudo e faz a carga inicial. */
  function inicia(win) {
    const mm = win.location && /^\/a\/([^/?#]+)/.exec(win.location.pathname || '');
    if (!mm || !win.document) {
      return { passoTutorial: () => ({ alvo: '[data-tour="foco"]', titulo: 'O modo foco', oque: '', como: '', porque: '' }), recebe() {} };
    }
    let agente;
    try { agente = decodeURIComponent(mm[1]); } catch (e) { agente = mm[1]; }
    const f = criar({ doc: win.document, win, fetch: win.fetch.bind(win), storage: win.localStorage, agente });
    f.carrega();
    return { passoTutorial: f.passoTutorial, recebe: f.recebe };
  }

  return { criar, inicia, modoLayout, contador };
});
