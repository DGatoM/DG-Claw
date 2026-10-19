'use strict';
/* novo-agente.js: a tela Novo agente (rota /novo-agente), usada quando o Admin foi desligado (proteção admin_llm = false).
   O formulário grava o pedido (POST /api/v1/novo-agente) e o servidor cria o agente pelo serviço de controle; o andamento vem de
   GET /api/v1/onboarding, o mesmo de sempre. Só o TI usa. Parte pura (sem DOM, com teste em web/test/ent-admin-desligado.test.js)
   e parte com DOM (window.DGNovoAgente.montar). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGNovoAgente = m;
    m.registra();
  }
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const PASSOS = {
    pagina: [
      { alvo: '[data-na-tour="titulo"]', titulo: 'Novo agente', oque: 'O formulário que cria um agente neste servidor, sem passar pelo Admin.',
        como: 'Você preenche quatro campos e toca em Criar. O servidor pede ao serviço de controle, que cria o agente em um container separado.',
        porque: 'Neste servidor o Admin está desligado de propósito: nenhuma IA tem acesso à máquina, então quem cria é você, com o formulário.' },
      { alvo: '[data-na-tour="nome"]', titulo: 'Nome do agente', oque: 'Como o agente aparece no menu e na conversa.',
        como: 'Escreva um nome curto. O sistema gera sozinho o nome técnico (letras minúsculas e hífen).',
        porque: 'É o nome que as pessoas da equipe vão reconhecer.' },
      { alvo: '[data-na-tour="papel"]', titulo: 'Função', oque: 'O que esse agente faz no dia a dia.',
        como: 'Descreva em uma ou duas frases (até 300 caracteres). O texto vira a instrução de partida do agente.',
        porque: 'Um agente sabe melhor o que fazer, e o que não fazer, quando a função é clara desde o começo.' },
      { alvo: '[data-na-tour="jeito"]', titulo: 'Tom de voz', oque: 'O jeito de falar do agente.',
        como: 'Por exemplo: direto e educado, sem jargão. Até 180 caracteres.',
        porque: 'Mantém as respostas parecidas com o jeito da sua empresa.' },
      { alvo: '[data-na-tour="dono"]', titulo: 'Seu nome', oque: 'Como o agente vai chamar você.', como: 'Digite como quer ser chamado.',
        porque: 'O agente se dirige a você pelo nome desde a primeira mensagem.' },
    ],
    andamento: [
      { alvo: '[data-na-tour="andamento"]', titulo: 'Andamento da criação', oque: 'A etapa em que o agente está sendo preparado.',
        como: 'A barra sobe conforme o servidor avança. Criar leva alguns minutos, na primeira vez mais, porque a imagem dos agentes é construída.',
        porque: 'Assim você sabe se precisa fazer algo ou se é só esperar.' },
    ],
  };

  function htmlFormulario() {
    const campo = (nome, rotulo, tour, extra) => '<label class="na-campo" data-na-tour="' + tour + '"><span class="na-rotulo">' + esc(rotulo) + '</span>' + extra + '</label>';
    return '<section class="na-sec"><h2>Criar um agente</h2>' +
      '<p class="na-fraco">Você escolhe o nome, a função e o tom. O servidor cria o agente em um container separado dos outros.</p>' +
      '<form id="naForm" autocomplete="off">' +
      campo('nome', 'Nome do agente', 'nome', '<input name="nome" maxlength="60" required placeholder="Ex.: Sofia">') +
      campo('papel', 'Função', 'papel', '<textarea name="papel" maxlength="300" required placeholder="Ex.: Responde dúvidas dos clientes sobre pedidos e prazos."></textarea>') +
      campo('jeito', 'Tom de voz', 'jeito', '<input name="jeito" maxlength="180" required placeholder="Ex.: Direto e educado, sem jargão.">') +
      campo('dono', 'Como o agente chama você', 'dono', '<input name="dono" maxlength="60" required placeholder="Ex.: Marta">') +
      '<div class="na-acoes"><button class="na-btn na-principal" type="submit">Criar agente</button></div></form></section>';
  }

  /* d = resposta de GET /api/v1/onboarding. Devolve o HTML do andamento e o que a pessoa pode fazer agora. */
  function htmlAndamento(d) {
    const pr = d.progresso || {};
    const pct = Math.max(0, Math.min(100, Number(pr.pct) || 0));
    let corpo = '<section class="na-sec" data-na-tour="andamento"><h2>' + esc(d.nome || 'Seu agente') + '</h2>';
    if (d.fase === 'pronto') {
      corpo += '<p>Pronto! O agente respondeu e já pode conversar.</p><div class="na-acoes">' +
        (d.conversa ? '<a class="na-btn na-principal" href="' + esc(d.conversa) + '">Abrir a conversa</a>' : '') +
        '<button type="button" class="na-btn" data-na-acao="outro">Criar outro agente</button></div></section>';
      return corpo;
    }
    const erro = d.fase === 'erro' || d.fase === 'erro-envio' || pr.erro;
    corpo += '<div class="na-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>' +
      '<p>' + esc(pr.etapa || d.mensagem || 'Preparando') + (pr.passo && pr.total ? ' (' + esc(pr.passo) + ' de ' + esc(pr.total) + ')' : '') + '</p>';
    if (erro) {
      const e = pr.erro || {};
      corpo += '<p class="na-aviso na-ruim"><b>Parou.</b> ' + esc(e.motivo || d.mensagem || 'A criação parou sem detalhes.') +
        (e.oQueFazer ? '<br>O que fazer: ' + esc(e.oQueFazer) : '') + '</p><div class="na-acoes"><button type="button" class="na-btn na-principal" data-na-acao="retomar">Tentar de novo</button></div>';
    } else if (d.fase === 'login') {
      corpo += '<p class="na-aviso">Falta o agente entrar na assinatura do Claude. Abra o painel dele, toque em Entrar com a assinatura e volte aqui.</p><div class="na-acoes">' +
        (d.login ? '<a class="na-btn na-principal" href="' + esc(d.login) + '" target="_blank" rel="noopener">Conectar a assinatura</a>' : '') +
        '<button type="button" class="na-btn" data-na-acao="testar">Já entrei. Pode testar.</button></div>';
    }
    return corpo + '</section>';
  }

  const ATIVAS = ['enviando', 'solicitado', 'criando', 'testando'];
  const puros = { esc, PASSOS, htmlFormulario, htmlAndamento, ATIVAS };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null, temporizador = null, forcarFormulario = false;

  function status(msg, erro) {
    const s = raizEl && raizEl.querySelector('#naStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'na-status' + (erro ? ' na-erro' : '');
  }

  async function api(metodo, caminho, corpo) {
    const r = await fetch(caminho, { method: metodo, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return null; }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('o servidor respondeu ' + r.status));
    return d;
  }

  async function atualiza() {
    clearTimeout(temporizador);
    const corpo = raizEl.querySelector('#naCorpo');
    try {
      const est = await api('GET', '/api/v1/novo-agente/estado');
      if (!est) return;
      if (!est.ativo) { corpo.innerHTML = '<section class="na-sec"><p>Neste servidor o Admin está ligado: para criar um agente, peça a ele na conversa. Este formulário é para quando o Admin foi desligado (dgclaw admin desligar).</p></section>'; return; }
      if (!est.ti) { corpo.innerHTML = '<section class="na-sec"><p>Criar agentes é com o TI desta instalação. Peça a alguém do TI.</p></section>'; return; }
      const d = await api('GET', '/api/v1/onboarding');
      const emCurso = d && d.id && !forcarFormulario && (ATIVAS.includes(d.fase) || ['login', 'erro', 'erro-envio'].includes(d.fase) || (d.fase === 'pronto' && !d.animacaoVista));
      corpo.innerHTML = emCurso ? htmlAndamento(d) : htmlFormulario();
      status('');
      if (emCurso && ATIVAS.includes(d.fase)) temporizador = setTimeout(atualiza, 1500);
      else if (emCurso && d.fase === 'login') temporizador = setTimeout(atualiza, 6000);
    } catch (e) {
      status('Não consegui falar com o servidor: ' + e.message + '. Recarregue a página; se continuar, veja o log do dgclaw-web (journalctl -u dgclaw-web).', true);
    }
  }

  async function enviar(form) {
    const dados = {};
    new FormData(form).forEach((v, k) => { dados[k] = String(v); });
    const botao = form.querySelector('button[type=submit]');
    botao.disabled = true;
    try {
      await api('POST', '/api/v1/novo-agente', dados);
      forcarFormulario = false;
      await atualiza();
    } catch (e) { status(e.message, true); botao.disabled = false; }
  }

  async function acao(nome, botao) {
    if (nome === 'outro') {
      try {
        const atual = await api('GET', '/api/v1/onboarding');
        if (atual && atual.id) await api('POST', '/api/v1/onboarding/animacao-vista', { id: atual.id });
      } catch (e) { status(e.message, true); return undefined; }
      forcarFormulario = true;
      return atualiza();
    }
    botao.disabled = true;
    try {
      await api('POST', '/api/v1/novo-agente/' + nome);
      await atualiza();
    } catch (e) { status(e.message, true); botao.disabled = false; }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, raizEl.querySelector('[data-na-tour="andamento"]') ? PASSOS.andamento : []) : PASSOS[chave];
    const cab = raizEl.querySelector('.na-cab');
    if (chave === 'pagina' && cab && cab.offsetParent === null && document.getElementById('cabecalho')) {
      passos = passos.map(p => (p.alvo === '[data-na-tour="titulo"]' ? Object.assign({}, p, { alvo: '#cabecalho' }) : p));
    }
    passos = passos.filter(p => document.querySelector(p.alvo));
    if (passos.length) raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('na-raiz');
    elemento.innerHTML = '<header class="na-cab" data-na-tour="titulo"><h1>Novo agente</h1><button type="button" class="na-btn" data-na-tutorial="pagina">Tutorial</button></header>' +
      '<p id="naStatus" class="na-status" role="status" aria-live="polite"></p><div id="naCorpo"></div>';
    elemento.addEventListener('submit', ev => { if (ev.target.id === 'naForm') { ev.preventDefault(); enviar(ev.target); } });
    elemento.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.naTutorial) tour(b.dataset.naTutorial);
      if (b.dataset.naAcao) acao(b.dataset.naAcao, b);
    });
    return atualiza();
  }

  function registra() {
    const el = document.getElementById('novoAgenteRaiz');
    if (el) montar(el);
  }
  return Object.assign({ montar, registra }, puros);
});
