'use strict';
/* pedidos.js: a aba "Pedidos" da Mesa (/mesa). Contrato da API em web/docs/PEDIDOS.md.

   Parte pura (sem DOM, com teste em web/test/pedidos-tela.test.js): rótulos, "há X min", link da
   conversa, frase de erro, bolinha e passos do tutorial. Parte com DOM: DGPedidos.montar(elemento).

   Todo texto que vem da API (o pedido, o motivo, o nome do agente) entra na tela por textContent.
   Este arquivo não monta HTML a partir de texto: um pedido com <script> aparece como texto. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGPedidos = m;
    m.registra();
  }
})(this, function (raiz) {
  const INTERVALO_MS = 15000;
  const ESPIA_MS = 60000;

  /* ───────────── partes puras ───────────── */

  const ROTULOS = {
    fazendo: { texto: 'fazendo', classe: 'fazendo' },
    esperando_dono: { texto: 'esperando você', classe: 'esperando' },
    entregue: { texto: 'entregue', classe: 'entregue' },
    feito: { texto: 'feito ✓', classe: 'concluida' },
    cancelado: { texto: 'cancelado', classe: 'cancelada' },
  };

  function rotuloEstado(estado) {
    return ROTULOS[estado] || { texto: String(estado || 'sem estado'), classe: 'outro' };
  }

  const estaAberto = p => !!p && ['fazendo', 'esperando_dono', 'entregue'].includes(p.estado);

  /* "agora mesmo", "há 5 min", "há 3 h", "há 2 d". Data que não dá para ler vira "sem registro". */
  function haTempo(iso, agoraMs) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return 'sem registro de horário';
    const min = Math.max(0, Math.floor(((agoraMs == null ? Date.now() : agoraMs) - t) / 60000));
    if (min < 1) return 'agora mesmo';
    if (min < 60) return 'há ' + min + ' min';
    if (min < 1440) return 'há ' + Math.floor(min / 60) + ' h';
    return 'há ' + Math.floor(min / 1440) + ' d';
  }

  /* O link vem do servidor, mas a tela só segue o que tem a forma /a/<agente> ou /a/<agente>?msg=<id>. */
  function linkSeguro(link) {
    return typeof link === 'string' && /^\/a\/[A-Za-z0-9._%-]{1,80}(\?msg=[a-f0-9]{16})?$/.test(link) ? link : null;
  }

  /* { texto, campos } com o `erro` e os `erros` campo a campo da API. */
  function fraseErro(dados, status) {
    const campos = dados && dados.erros && typeof dados.erros === 'object' ? dados.erros : {};
    let texto = dados && dados.erro ? String(dados.erro) : '';
    if (!texto) texto = Object.keys(campos).length ? 'Alguns campos precisam de ajuste.' : 'O servidor recusou o pedido (código ' + status + ').';
    return { texto, campos };
  }

  /* A bolinha da aba acende com item esperando o dono ou entregue que ainda não foi aberto. */
  function bolinhaLigada(contagem) {
    return !!contagem && ((contagem.esperando_dono || 0) + (contagem.entregues || 0)) > 0;
  }

  function oQueFazOToque(p) {
    return p.estado === 'entregue'
      ? 'Abre a conversa na mensagem da entrega e marca o pedido como feito.'
      : 'Abre a conversa com o agente.';
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-pd-tour="titulo"]', titulo: 'A fila de pedidos',
        oque: 'Tudo o que você pediu a cada agente, na ordem em que chegou, com o estado de cada pedido: fazendo, esperando você, entregue, feito ou cancelado.',
        como: 'O próprio agente abre o item ao receber o seu pedido e vai mudando o estado enquanto trabalha. Esta tela só mostra o que o agente registrou, e se atualiza sozinha a cada 15 segundos.',
        porque: 'Você vê de relance o que ficou pendente, sem precisar conferir a conversa de cada agente.' },
    ],
    contagem: [
      { alvo: '[data-pd-tour="contagem"]', titulo: 'A contagem do topo',
        oque: 'Quantos pedidos esperam você, quantos foram entregues e quantos ainda estão sendo feitos.',
        como: 'O servidor conta os pedidos abertos de todos os agentes. "Esperando você" é o que o agente disse que depende de uma resposta sua. "Entregue" é o que ele deu por pronto e você ainda não abriu. A bolinha vermelha na aba acende quando existe um dos dois.',
        porque: 'O que depende de você fica à vista, mesmo quando você está em outra aba.' },
    ],
    lista: [
      { alvo: '[data-pd-tour="cartao"]', titulo: 'O cartão do pedido',
        oque: 'Um pedido seu a um agente: o texto, o agente, o estado e há quanto tempo mudou.',
        como: 'Os abertos vêm primeiro (esperando você, entregue, fazendo), na ordem de chegada. Depois vêm os feitos e cancelados de hoje e de ontem. Tocar num item entregue abre a conversa na mensagem da entrega e marca o pedido como feito. Você também fecha o pedido pelos botões, ou só respondendo ao agente na conversa depois da entrega.',
        porque: 'O pedido só sai da sua lista quando você viu a entrega. O agente não decide isso por você.' },
      { alvo: '[data-pd-tour="arquivados"]', titulo: 'Ver arquivados',
        oque: 'Os pedidos feitos ou cancelados antes de ontem.',
        como: 'A lista normal mostra só os abertos e os fechados de hoje e de ontem. Este botão pede ao servidor todos os que ele ainda guarda.',
        porque: 'A tela fica curta no dia a dia, e o histórico continua à mão quando você precisa.' },
    ],
  };

  const puros = { ROTULOS, rotuloEstado, estaAberto, haTempo, linkSeguro, fraseErro, bolinhaLigada, oQueFazOToque, PASSOS };
  if (typeof document === 'undefined') return Object.assign({ registra() {}, montar() {} }, puros);

  /* ───────────── navegador ───────────── */

  let setBolinha = null;
  let timerEspia = null;
  let timerLista = null;
  let raizEl = null;
  const E = {
    pedidos: [], contagem: null, etag: null, arquivados: false, jaCarregou: false,
    ocupados: new Set(), cancelando: null, msg: {}, erroCarga: '',
  };

  function no(tag, classe, texto, atrib) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    if (atrib) for (const k of Object.keys(atrib)) e.setAttribute(k, atrib[k]);
    return e;
  }

  async function lerJson(r) {
    try { return await r.json(); } catch (e) { console.warn('pedidos: resposta sem JSON (código ' + r.status + '):', e.message); return null; }
  }

  const vaiParaLogin = () => { location.href = '/login?next=' + encodeURIComponent('/mesa'); };

  async function chama(metodo, url, corpo) {
    const h = { Accept: 'application/json' };
    if (corpo != null) h['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(url, { method: metodo, headers: h, credentials: 'same-origin', cache: 'no-store', body: corpo == null ? undefined : JSON.stringify(corpo) });
    } catch (e) {
      console.warn('pedidos: ' + metodo + ' ' + url + ' falhou:', e);
      return { ok: false, status: 0, erro: { texto: 'Não consegui falar com o servidor (' + e.message + '). Nada foi gravado; tente de novo.', campos: {} } };
    }
    if (r.status === 401) vaiParaLogin();
    const d = await lerJson(r);
    const ok = r.ok && !(d && d.ok === false);
    return { ok, status: r.status, dados: d, erro: ok ? null : fraseErro(d, r.status) };
  }

  function setErroCarga(texto) {
    E.erroCarga = texto || '';
    if (!raizEl) return;
    const el = raizEl.querySelector('[data-pd="erro"]');
    el.replaceChildren();
    if (!texto) return;
    const caixa = no('div', 'mz-erro mz-erro-carga', null, { role: 'alert' });
    caixa.append(no('p', null, texto));
    const b = no('button', 'mz-btn pri', 'Tentar de novo', { type: 'button', 'data-pd-acao': 'recarregar' });
    caixa.append(b);
    el.append(caixa);
  }

  function urlDaLista() {
    return '/api/v1/pedidos?dia=' + (E.arquivados ? 'todos' : 'recentes');
  }

  /* forca = ignora o ETag. Devolve true se a lista mudou. */
  async function carrega(forca) {
    const h = { Accept: 'application/json' };
    if (E.etag && !forca) h['If-None-Match'] = E.etag;
    let r;
    try { r = await fetch(urlDaLista(), { credentials: 'same-origin', headers: h, cache: 'no-store' }); }
    catch (e) {
      console.warn('pedidos: falha de rede ao carregar:', e);
      setErroCarga('Não consegui falar com o servidor (' + e.message + '). Verifique a conexão.');
      return false;
    }
    if (r.status === 304) { setErroCarga(''); return false; }
    if (r.status === 401) { vaiParaLogin(); return false; }
    const d = await lerJson(r);
    if (!r.ok || !d || !Array.isArray(d.pedidos)) {
      const f = fraseErro(d, r.status);
      console.warn('pedidos: falha ao carregar:', r.status, f.texto);
      setErroCarga((r.status === 503 ? 'A fila de pedidos está indisponível: ' : 'Não consegui carregar os pedidos: ') + f.texto);
      return false;
    }
    E.pedidos = d.pedidos; E.contagem = d.contagem || null; E.etag = r.headers.get('ETag'); E.jaCarregou = true;
    setErroCarga('');
    return true;
  }

  async function atualiza(forca) {
    if (E.cancelando != null || E.ocupados.size) return;
    const mudou = await carrega(forca);
    if (mudou || forca) render();
    acendeSeFora();
  }

  function acendeSeFora() {
    const aba = document.getElementById('mzAba-pedidos');
    const ativa = aba && aba.classList.contains('ativa');
    if (setBolinha) setBolinha(!ativa && bolinhaLigada(E.contagem));
  }

  /* ── desenho ── */
  function contador(n, rotulo, classe) {
    const s = no('span', 'mz-cont ' + classe + (n ? ' tem' : ''));
    s.append(no('b', null, String(n || 0)), document.createTextNode(' ' + rotulo));
    return s;
  }

  function renderContagem() {
    const el = raizEl.querySelector('[data-pd="contagem"]');
    el.replaceChildren();
    const c = E.contagem;
    if (!c) { el.append(no('span', 'mz-vazio', 'Carregando os pedidos...')); return; }
    el.append(contador(c.esperando_dono, 'esperando você', 'esperando'), contador(c.entregues, 'entregues', 'entregue'),
      contador(c.fazendo, 'fazendo', 'fazendo'));
  }

  function cartao(p) {
    const sel = rotuloEstado(p.estado);
    const fechado = !estaAberto(p);
    const art = no('article', 'mz-cartao pd-cartao est-' + sel.classe + (fechado ? ' fechada' : ''), null, { id: 'p' + p.id });
    if (p === E.pedidos[0]) art.setAttribute('data-pd-tour', 'cartao');

    const cab = no('button', 'mz-cab', null, { type: 'button', 'data-pd-acao': 'abrir', 'data-id': String(p.id), title: oQueFazOToque(p) });
    cab.append(no('span', 'mz-tit', p.texto), no('span', 'mz-selo ' + sel.classe, sel.texto));
    art.append(cab);

    if (p.estado === 'esperando_dono' && p.motivo) {
      const mo = no('p', 'mz-motivo');
      mo.append(no('b', null, 'Precisa de você:'), document.createTextNode(' ' + p.motivo));
      art.append(mo);
    } else if (p.estado === 'cancelado' && p.motivo) {
      const mo = no('p', 'mz-nota');
      mo.append(no('b', null, 'Motivo:'), document.createTextNode(' ' + p.motivo));
      art.append(mo);
    }
    art.append(no('p', 'mz-quando', (p.agente_nome || p.agente) + ' · #' + p.id + ' · ' + haTempo(p.atualizado_em)));

    const msg = E.msg[p.id];
    if (msg) {
      const er = no('div', 'mz-erro', null, { role: 'alert' });
      er.append(no('p', null, msg.texto));
      art.append(er);
    }

    if (E.cancelando === p.id) {
      const f = no('form', 'mz-form', null, { 'data-pd-form': 'cancelar', 'data-id': String(p.id) });
      f.append(no('h4', null, 'Cancelar este pedido?'));
      const rot = no('label', null, 'Motivo (opcional)');
      rot.append(no('input', null, null, { name: 'motivo', type: 'text', maxlength: '300', autocomplete: 'off' }));
      f.append(rot);
      const lin = no('div', 'mz-linha');
      lin.append(no('button', 'mz-btn pri', 'Cancelar o pedido', { type: 'submit' }),
        no('button', 'mz-btn', 'Voltar', { type: 'button', 'data-pd-acao': 'fechar-form' }));
      f.append(lin);
      art.append(f);
    } else if (!fechado) {
      const ac = no('div', 'mz-acoes', null, { role: 'group', 'aria-label': 'Ações do dono' });
      const ocupado = E.ocupados.has(p.id);
      const feito = no('button', 'mz-btn' + (p.estado === 'entregue' ? ' pri' : ''), 'Marcar como feito', { type: 'button', 'data-pd-acao': 'feito', 'data-id': String(p.id) });
      const canc = no('button', 'mz-btn', 'Cancelar', { type: 'button', 'data-pd-acao': 'cancelar', 'data-id': String(p.id) });
      feito.disabled = ocupado; canc.disabled = ocupado;
      ac.append(feito, canc);
      art.append(ac);
    }
    return art;
  }

  function render() {
    renderContagem();
    const lista = raizEl.querySelector('[data-pd="lista"]');
    const y = window.scrollY;
    lista.replaceChildren();
    if (!E.pedidos.length && E.jaCarregou) {
      lista.append(no('p', 'mz-vazio grande', 'Nenhum pedido por aqui. Quando você pedir algo a um agente, o item aparece nesta lista.'));
    }
    for (const p of E.pedidos) lista.append(cartao(p));
    const b = raizEl.querySelector('[data-pd-acao="arquivados"]');
    b.textContent = E.arquivados ? 'Só os recentes' : 'Ver arquivados';
    b.setAttribute('aria-pressed', String(E.arquivados));
    window.scrollTo(0, y);
    acendeSeFora();
  }

  /* ── ações do dono ── */
  async function aplica(id, metodo, url, corpo, rotulo) {
    E.ocupados.add(id); delete E.msg[id]; render();
    const r = await chama(metodo, url, corpo);
    E.ocupados.delete(id);
    if (!r.ok) {
      console.warn('pedidos: ' + rotulo + ' recusado (' + r.status + '):', r.dados || r.erro);
      E.msg[id] = r.erro;
      E.cancelando = null;
      render();
      return null;
    }
    E.cancelando = null;
    await atualiza(true);
    return r;
  }

  async function abre(id) {
    const p = E.pedidos.find(x => x.id === id);
    if (!p) return;
    let link = linkSeguro(p.link_conversa);
    if (p.estado === 'entregue') {
      const r = await aplica(id, 'POST', '/api/v1/pedidos/' + encodeURIComponent(id) + '/abrir', {}, 'abrir o item');
      if (!r) return;
      link = linkSeguro(r.dados && r.dados.pedido && r.dados.pedido.link_conversa) || link;
    }
    if (!link) {
      E.msg[id] = { texto: 'O servidor mandou um endereço de conversa que a tela não reconhece. Abra a conversa do agente pelo menu.', campos: {} };
      render();
      return;
    }
    location.href = link;
  }

  function aoClicar(ev) {
    const b = ev.target.closest('[data-pd-acao]');
    if (!b) return;
    const acao = b.getAttribute('data-pd-acao');
    const id = b.dataset.id != null ? Number(b.dataset.id) : null;
    switch (acao) {
      case 'abrir': abre(id); break;
      case 'feito': aplica(id, 'PATCH', '/api/v1/pedidos/' + encodeURIComponent(id), { estado: 'feito' }, 'marcar como feito'); break;
      case 'cancelar': delete E.msg[id]; E.cancelando = id; render(); break;
      case 'fechar-form': E.cancelando = null; render(); atualiza(false); break;
      case 'arquivados': E.arquivados = !E.arquivados; E.etag = null; atualiza(true); break;
      case 'recarregar': atualiza(true); break;
      case 'tutorial': tour('pagina'); break;
      case 'ajuda-contagem': tour('contagem'); break;
      case 'ajuda-lista': tour('lista'); break;
      default: console.warn('pedidos: ação desconhecida:', acao);
    }
  }

  function aoEnviar(ev) {
    const f = ev.target;
    if (!(f instanceof HTMLFormElement) || f.getAttribute('data-pd-form') !== 'cancelar') return;
    ev.preventDefault();
    const id = Number(f.dataset.id);
    const motivo = f.elements.motivo.value.trim();
    aplica(id, 'DELETE', '/api/v1/pedidos/' + encodeURIComponent(id), motivo ? { motivo } : {}, 'cancelar');
  }

  /* ── tutorial ── */
  function tour(chave) {
    if (!raiz.DGTour) { setErroCarga('A visita guiada não carregou (tour.js). Recarregue a página.'); return; }
    const passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.contagem, PASSOS.lista) : PASSOS[chave];
    // sem nenhum pedido não há cartão para apontar: a visita pula esses passos (o tour.js ignora alvo ausente)
    raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('pd-raiz');
    elemento.replaceChildren();
    const topo = no('div', 'mz-topo2', null, { 'data-pd-tour': 'titulo' });
    const linCont = no('div', 'mz-contagem-lin');
    linCont.append(no('div', 'mz-contagem', null, { 'data-pd': 'contagem', 'data-pd-tour': 'contagem' }),
      no('button', 'mz-ajuda', '?', { type: 'button', 'data-pd-acao': 'ajuda-contagem', title: 'O que é a contagem', 'aria-label': 'O que é a contagem' }));
    const linBotoes = no('div', 'mz-contagem-lin');
    linBotoes.append(no('button', 'mz-btn', 'Tutorial', { type: 'button', 'data-pd-acao': 'tutorial' }));
    topo.append(linCont, linBotoes);
    const barra = no('div', 'pd-barra');
    barra.append(no('button', 'mz-btn', 'Ver arquivados', { type: 'button', 'data-pd-acao': 'arquivados', 'aria-pressed': 'false', 'data-pd-tour': 'arquivados' }),
      no('button', 'mz-ajuda', '?', { type: 'button', 'data-pd-acao': 'ajuda-lista', title: 'Como ler a lista', 'aria-label': 'Como ler a lista' }));
    elemento.append(topo, barra, no('div', null, null, { 'data-pd': 'erro' }), no('div', 'pd-lista', null, { 'data-pd': 'lista' }));
    elemento.addEventListener('click', aoClicar);
    elemento.addEventListener('submit', aoEnviar);
    renderContagem();
    atualiza(true);
    clearInterval(timerLista);
    timerLista = setInterval(() => {
      if (document.visibilityState !== 'visible' || !elemento.isConnected || elemento.hidden) return;
      atualiza(false);
    }, INTERVALO_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !elemento.hidden) atualiza(false); });
  }

  /* Conta os itens que esperam o dono mesmo com a aba fechada: uma leitura leve por minuto. */
  async function espiar() {
    const r = await chama('GET', '/api/v1/pedidos?estado=esperando_dono,entregue');
    if (!r.ok) { console.warn('pedidos: não consegui conferir se há pedido esperando você:', r.status, r.erro && r.erro.texto); return; }
    const c = r.dados && r.dados.contagem;
    const aba = document.getElementById('mzAba-pedidos');
    if (setBolinha && !(aba && aba.classList.contains('ativa'))) setBolinha(bolinhaLigada(c));
  }

  function bolinha(arg) {
    if (typeof arg === 'function') { setBolinha = arg; return; }
    if (setBolinha) setBolinha(!!arg);
  }

  function registra() {
    const api = raiz.DGMesaAbas;
    if (!api || typeof api.registrar !== 'function') {
      console.warn('pedidos: a Mesa não está nesta página (DGMesaAbas ausente); a aba Pedidos não foi registrada.');
      return;
    }
    api.registrar({ id: 'pedidos', titulo: 'Pedidos', montar, bolinha });
    espiar();
    clearInterval(timerEspia);
    timerEspia = setInterval(() => { if (document.visibilityState === 'visible') espiar(); }, ESPIA_MS);
  }

  return Object.assign({ registra, montar, bolinha, tour: () => tour('pagina') }, puros);
});
