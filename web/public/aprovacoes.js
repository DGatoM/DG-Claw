'use strict';
/* aprovacoes.js: a tela Aprovações (rota /aprovacoes), só para o TI. Lista os pedidos de ações perigosas que um agente (ou
   o próprio TI) fez e deixa aprovar ou recusar. A frase do pedido vem do servidor, gerada pelo dono do tipo a partir de
   parâmetros validados, nunca de texto escrito pelo modelo. Aprovar pede o código do 2FA quando o último foi há mais de 15 min.

   Parte pura (sem DOM, com teste em web/test/ent-aprovacoes-tela.test.js): rótulos e HTML. Parte com DOM: DGAprovacoes.montar(elemento).
   Fala com /api/v1/aprovacoes (web/lib/ent/aprovacoes.js) e, para o código do 2FA, com POST /api/v1/eu/reautenticar. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGAprovacoes = m;
    m.registra();
  }
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ESTADOS = {
    pendente: 'esperando você', aprovada: 'aprovada', recusada: 'recusada',
    expirada: 'venceu', executada: 'feita', falhou: 'falhou',
  };
  const rotuloEstado = e => ESTADOS[e] || String(e);

  function quando(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    return new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* A frase do servidor tem `crases` em volta de nomes; viram destaque, o resto fica escapado. */
  function frase(texto) {
    return esc(texto).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function htmlParametros(params) {
    const chaves = params && typeof params === 'object' ? Object.keys(params) : [];
    if (!chaves.length) return '<p class="ap-meta">Sem parâmetros.</p>';
    return '<dl class="ap-det">' + chaves.map(k => '<dt>' + esc(k) + '</dt><dd>' + esc(typeof params[k] === 'string' ? params[k] : JSON.stringify(params[k])) + '</dd>').join('') + '</dl>';
  }

  function htmlResultado(r) {
    if (!r) return '';
    const t = r.erro || r.motivo || (r.tarefa ? 'Tarefa ' + r.tarefa + ' em andamento (o Admin acompanha).' : (r.saida || ''));
    return t ? '<p class="ap-resultado">' + esc(String(t).slice(0, 400)) + '</p>' : '';
  }

  function htmlPedido(p) {
    const pendente = p.estado === 'pendente';
    return '<li class="ap-item ap-' + esc(p.estado) + '" data-id="' + esc(p.id) + '">' +
      '<p class="ap-desc">' + frase(p.descricao) + '</p>' +
      '<p class="ap-meta"><span class="ap-selo ap-s-' + esc(p.estado) + '">' + esc(rotuloEstado(p.estado)) + '</span> ' +
      'Pedido por ' + esc(p.pedido_por) + ' em ' + esc(quando(p.pedido_em)) + (pendente ? ', vale até ' + esc(quando(p.expira_em)) : '') +
      (p.decidido_por ? '. Decidido por ' + esc(p.decidido_por) + ' em ' + esc(quando(p.decidido_em)) : '') + '</p>' +
      '<details><summary class="ap-meta">Detalhes do pedido</summary>' +
      '<dl class="ap-det"><dt>Tipo</dt><dd>' + esc(p.tipo) + '</dd><dt>Operação</dt><dd>' + esc(p.op) + '</dd></dl>' + htmlParametros(p.params) + '</details>' +
      htmlResultado(p.resultado) +
      (pendente ? '<div class="ap-acoes"><button type="button" class="ap-btn ap-ok" data-ap-acao="aprovar">Aprovar</button>' +
        '<button type="button" class="ap-btn ap-nao" data-ap-acao="recusar">Recusar</button></div>' +
        '<div class="ap-codigo" hidden><p>Faz mais de 15 minutos que você confirmou o código do aplicativo autenticador. Digite o código atual para aprovar.</p>' +
        '<input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="Código de 6 dígitos" data-ap-codigo>' +
        '<button type="button" class="ap-btn ap-ok" data-ap-acao="confirmar">Confirmar e aprovar</button></div>' : '') +
      '</li>';
  }

  function htmlLista(lista, vazio) {
    return lista.length ? '<ul class="ap-lista">' + lista.map(htmlPedido).join('') + '</ul>' : '<p class="ap-vazio">' + esc(vazio) + '</p>';
  }

  function htmlCorpo(d) {
    const todos = Array.isArray(d.aprovacoes) ? d.aprovacoes : [];
    const pend = todos.filter(p => p.estado === 'pendente');
    const resto = todos.filter(p => p.estado !== 'pendente');
    return '<section class="ap-sec" data-ap-tour="pendentes" aria-labelledby="apTPend"><h2 id="apTPend">Esperando você ' +
      '<button type="button" class="ap-ajuda" data-ap-tutorial="pendentes" aria-label="Ajuda sobre os pedidos pendentes">?</button></h2>' +
      htmlLista(pend, 'Nenhum pedido esperando. Quando o Admin precisar de algo perigoso, ele aparece aqui.') + '</section>' +
      '<section class="ap-sec" data-ap-tour="historico" aria-labelledby="apTHist"><h2 id="apTHist">Já decididos ' +
      '<button type="button" class="ap-ajuda" data-ap-tutorial="historico" aria-label="Ajuda sobre o histórico">?</button></h2>' +
      htmlLista(resto, 'Nada decidido ainda.') + '</section>';
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-ap-tour="titulo"]', titulo: 'A tela de aprovações',
        oque: 'A fila de ações perigosas que esperam uma pessoa do TI dizer sim ou não.',
        como: 'Quando o Admin (ou outro bloco do sistema) pede algo que não pode ser desfeito, o pedido para aqui e nada acontece até você decidir.',
        porque: 'Quem escreve a ação é um agente de IA, e um texto enganoso pode levá-lo a pedir o que não deve. Uma pessoa decidindo é a trava que sobra.' },
    ],
    pendentes: [
      { alvo: '[data-ap-tour="pendentes"]', titulo: 'Esperando você',
        oque: 'Cada cartão é um pedido: a frase do que vai acontecer, quem pediu e até quando vale.',
        como: 'A frase é montada pelo sistema a partir de parâmetros conferidos, não escrita pelo agente. Os parâmetros exatos ficam em "Detalhes do pedido". Aprovar executa na hora; se o último código do aplicativo autenticador passou de 15 minutos, a tela pede o código antes.',
        porque: 'Você aprova só o que leu aqui. Um pedido vale 24 horas e uma vez só: se vencer, o agente precisa pedir de novo.' },
    ],
    historico: [
      { alvo: '[data-ap-tour="historico"]', titulo: 'Já decididos',
        oque: 'Os pedidos que foram aprovados, recusados, venceram ou falharam, com quem decidiu.',
        como: 'Mostra o resultado de cada um: "feita" quer dizer que o serviço de controle executou; "falhou" traz o motivo.',
        porque: 'É o seu registro de quem aprovou o quê. A trilha de auditoria guarda o mesmo, com selo de que ninguém mexeu depois.' },
    ],
  };

  const puros = { esc, ESTADOS, rotuloEstado, quando, frase, htmlParametros, htmlResultado, htmlPedido, htmlLista, htmlCorpo, PASSOS };

  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null;

  function tela() {
    return '<div class="ap-tela"><header class="ap-cab" data-ap-tour="titulo"><h1>Aprovações</h1>' +
      '<button type="button" class="ap-btn" data-ap-tutorial="pagina">Tutorial</button></header>' +
      '<p id="apStatus" class="ap-status" role="status" aria-live="polite"></p><div id="apCorpo"></div></div>';
  }

  function status(msg, erro) {
    const s = raizEl && raizEl.querySelector('#apStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'ap-status' + (erro ? ' ap-erro' : '');
  }

  async function chama(metodo, url, corpo) {
    const r = await fetch(url, {
      method: metodo, credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json' }, corpo ? { 'Content-Type': 'application/json' } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
    const d = await r.json().catch(() => null);
    return { status: r.status, d };
  }

  async function carrega() {
    try {
      const r = await chama('GET', '/api/v1/aprovacoes');
      if (!r) return;
      if (r.status !== 200 || !r.d || r.d.ok === false) throw new Error((r.d && r.d.erro) || ('a API respondeu ' + r.status));
      raizEl.querySelector('#apCorpo').innerHTML = htmlCorpo(r.d);
    } catch (e) {
      status('Não consegui carregar as aprovações: ' + e.message + '. Recarregue a página; se continuar, veja o log do dgclaw-web no servidor (journalctl -u dgclaw-web).', true);
    }
  }

  async function decide(cartao, acao) {
    const id = cartao.dataset.id;
    cartao.querySelectorAll('button').forEach(b => { b.disabled = true; });
    status(acao === 'aprovar' ? 'Aprovando e executando…' : 'Recusando…');
    try {
      const r = await chama('POST', '/api/v1/aprovacoes/' + encodeURIComponent(id) + '/' + acao, {});
      if (!r) return;
      if (r.status === 403 && r.d && r.d.reautenticar) {
        cartao.querySelector('.ap-codigo').hidden = false;
        cartao.querySelectorAll('button').forEach(b => { b.disabled = false; });
        const campo = cartao.querySelector('[data-ap-codigo]');
        if (campo) campo.focus();
        status(r.d.erro, true);
        return;
      }
      if (r.status !== 200 || !r.d || r.d.ok === false) {
        status((r.d && r.d.erro) || ('O servidor respondeu ' + r.status + '.'), true);
        await carrega();
        return;
      }
      const a = r.d.aprovacao || {};
      status(acao === 'recusar' ? 'Pedido recusado.' : (r.d.executada ? 'Aprovado e executado.' : 'Aprovado, mas a execução falhou: ' + ((a.resultado && a.resultado.erro) || 'veja os detalhes abaixo') + '.'), acao === 'aprovar' && !r.d.executada);
      await carrega();
    } catch (e) {
      status('Não consegui falar com o servidor: ' + e.message + '. O pedido continua como estava; recarregue a página para conferir.', true);
      cartao.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  async function confirmaCodigo(cartao) {
    const campo = cartao.querySelector('[data-ap-codigo]');
    const codigo = (campo.value || '').replace(/\D/g, '');
    if (codigo.length !== 6) { status('O código tem 6 números. Digite o que o aplicativo mostra agora.', true); campo.focus(); return; }
    status('Conferindo o código…');
    try {
      const r = await chama('POST', '/api/v1/eu/reautenticar', { codigo });
      if (!r) return;
      if (r.status !== 200) { status((r.d && r.d.erro) || ('O servidor respondeu ' + r.status + ' ao conferir o código.'), true); campo.select(); return; }
      cartao.querySelector('.ap-codigo').hidden = true;
      await decide(cartao, 'aprovar');
    } catch (e) {
      status('Não consegui conferir o código: ' + e.message + '. Tente de novo.', true);
    }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.pendentes, PASSOS.historico) : PASSOS[chave];
    const cab = raizEl.querySelector('.ap-cab');
    if (chave === 'pagina' && cab && cab.offsetParent === null && document.getElementById('cabecalho')) {
      passos = passos.map(p => (p.alvo === '[data-ap-tour="titulo"]' ? Object.assign({}, p, { alvo: '#cabecalho' }) : p));
    }
    raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('ap-raiz');
    elemento.innerHTML = tela();
    elemento.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.apTutorial) { tour(b.dataset.apTutorial); return; }
      const cartao = b.closest('[data-id]');
      if (cartao && b.dataset.apAcao === 'confirmar') confirmaCodigo(cartao);
      else if (cartao && b.dataset.apAcao) decide(cartao, b.dataset.apAcao);
    });
    return carrega();
  }

  function registra() {
    const el = document.getElementById('aprovacoesRaiz');
    if (el) montar(el);
  }

  return Object.assign({ montar, registra }, puros);
});
