'use strict';
/* ronda-aviso.js: a janela VERMELHA da ronda de segurança, em todas as telas do painel.

   Lê GET /api/v1/seguranca/ronda ao carregar, a cada 2 minutos e quando a aba volta ao foco. Se há falha crítica
   (nível 2) aberta, sem decisão e sem "lembrar depois", abre a janela com a mais grave, no mesmo molde da janela de
   boletins (seguranca-aviso.js). Ela reaparece a cada carregamento até o dono decidir: aplicar, agendar ou tirar do ar.
   "Lembrar depois" esconde por 30 minutos, só neste aparelho. Com o sistema fora do ar (emergência), não abre.
   Tudo que vem da API é escapado. Funções puras com teste em web/test/ronda-tela.test.js. */
(function (raiz, fabrica) {
  const R = typeof module === 'object' && module.exports ? require('./ronda-comum') : raiz.DGRondaComum;
  const m = fabrica(raiz, R);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGRondaAviso = m;
})(this, function (raiz, R) {
  const { esc } = R;
  const POLL_MS = 2 * 60 * 1000;

  function textoIntro(total) {
    return 'Foi encontrada uma falha crítica que afeta o seu sistema e precisa de uma decisão sua.' +
      (total > 1 ? ' Há mais ' + (total - 1) + (total - 1 === 1 ? ' falha crítica esperando depois desta.' : ' falhas críticas esperando depois desta.') : '');
  }

  function modalHtml(a, total) {
    const pode = R.podeAplicar(a);
    return '<div class="sb-caixa rp-caixa-verm" id="rpCaixa">' +
      '<div class="sb-cab"><h2 id="rpTitulo">Ação necessária: ' + esc(a.nome_simples) + '</h2>' +
      '<button type="button" class="sb-ajuda" data-ra="ajuda" aria-label="Tutorial da janela de ação necessária" title="O que é esta janela">?</button></div>' +
      '<p class="sb-texto" id="rpTexto">' + esc(textoIntro(total)) + '</p>' + R.fatosHtml(a) +
      '<p class="rp-aviso" id="rpAviso">' + esc(pode ? R.avisoReinicio(a) : 'A correção ainda não está pronta. Enquanto isso, "Tirar do ar" é a proteção disponível.') + '</p>' +
      '<div class="rp-agenda" id="rpAgenda" hidden><label>Aplicar em<input type="datetime-local" id="rpQuando"></label>' +
      '<button type="button" class="sb-btn sb-pri" data-ra="agendar">Confirmar agendamento</button></div>' +
      '<p class="rp-msg-verm" id="rpMsgVerm" role="alert" hidden></p>' +
      '<div class="sb-acoes" id="rpAcoes">' +
      '<button type="button" class="sb-btn sb-pri" id="rpAplicar" data-ra="aplicar"' + (pode ? '' : ' disabled') + '>Aplicar correção</button>' +
      '<button type="button" class="sb-btn" id="rpAgendar" data-ra="agendar-abre"' + (pode && a.estado === 'aberto' ? '' : ' disabled') + '>Agendar</button>' +
      '<button type="button" class="sb-btn rp-perigo" id="rpTirar" data-ra="tirar">Tirar do ar</button>' +
      '<button type="button" class="sb-btn" id="rpLembrar" data-ra="lembrar">Lembrar depois</button></div></div>';
  }

  function passosDoModal(doc) {
    const tem = sel => !doc || !!doc.querySelector(sel);
    return [
      { alvo: '#rpTexto', titulo: 'A janela vermelha',
        oque: 'Um aviso de falha crítica que atinge algo instalado e exposto no seu servidor, e que pede uma decisão sua.',
        como: 'A ronda de segurança compara o que o servidor tem com as fontes oficiais de falhas. Quando a falha é grave e existe aqui, ela vira nível 2 e esta janela abre.',
        porque: 'Falha crítica sem decisão é risco aberto. Por isso a janela volta a cada visita ao painel, até você escolher.' },
      { alvo: '.rp-fatos', titulo: 'Os fatos da falha',
        oque: 'Quando foi publicada, a gravidade, onde afeta, o que ela faz, como corrigir e os links da fonte oficial e da notícia.',
        como: 'Vêm do registro oficial da falha. Os links abrem em outra aba e você pode conferir tudo com os seus olhos.',
        porque: 'Para você decidir com base em prova que está fora do nosso sistema.' },
      { alvo: '#rpAplicar', titulo: 'Aplicar correção',
        oque: 'Pede ao servidor que aplique a correção agora.',
        como: 'O painel só envia o pedido; quem executa é o servidor, que confere de novo se a correção é do catálogo aprovado. Pode reiniciar um serviço por alguns segundos.',
        porque: 'É o caminho normal: corrige a falha de vez.' },
      { alvo: '#rpAgendar', titulo: 'Agendar',
        oque: 'Escolhe um dia e hora para aplicar a correção.',
        como: 'O servidor guarda o horário e aplica sozinho na hora marcada.',
        porque: 'Para aplicar de madrugada ou fora do horário de trabalho, quando reiniciar um serviço atrapalha menos.' },
      { alvo: '#rpTirar', titulo: 'Tirar do ar',
        oque: 'Leva ao botão de emergência, que tira o sistema da internet e mantém só o seu acesso pelo Tailscale.',
        como: 'Lá você vê o plano, recebe um código de uso único e digita uma frase de confirmação. Sem confirmação em 5 minutos, o servidor religa sozinho.',
        porque: 'Quando a falha está sendo explorada e a correção ainda não chegou, é a única proteção.' },
      { alvo: '#rpLembrar', titulo: 'Lembrar depois',
        oque: 'Esconde esta janela por 30 minutos, neste aparelho.',
        como: 'Passado o prazo, ou ao recarregar em outro aparelho, a janela volta. A falha continua aberta na tela Segurança.',
        porque: 'Para você escolher a hora de decidir, sem que a janela atrapalhe o que está fazendo, mas sem esquecer.' },
    ].filter(p => tem(p.alvo));
  }

  if (!raiz.document) return { textoIntro, modalHtml, passosDoModal };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let fundo = null;
  let aberto = null;
  let ocupado = false;
  let lista = [];

  function garanteCss() {
    for (const href of ['/seguranca-aviso.css', '/ronda-aviso.css']) {
      if (document.querySelector('link[href="' + href + '"]')) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
    }
  }

  function mostraMsg(texto) {
    const e = fundo && fundo.querySelector('#rpMsgVerm');
    if (!e) return;
    e.textContent = texto || '';
    e.classList.toggle('erro', !!texto);
    e.hidden = !texto;
  }

  function travaBotoes(sim) {
    if (fundo) fundo.querySelectorAll('button').forEach(b => { b.disabled = sim; });
  }

  function fecha() {
    if (fundo) { fundo.remove(); fundo = null; }
    aberto = null;
    document.removeEventListener('keydown', aoTeclar, true);
  }

  function aoTeclar(ev) {
    if (ev.key === 'Escape' && !document.getElementById('tourCaixa')) fecha();
  }

  function abre(a, total) {
    garanteCss();
    aberto = a;
    fundo = document.createElement('div');
    fundo.id = 'rpFundo';
    fundo.className = 'sb-fundo';
    fundo.setAttribute('role', 'alertdialog');
    fundo.setAttribute('aria-modal', 'true');
    fundo.setAttribute('aria-labelledby', 'rpTitulo');
    fundo.innerHTML = modalHtml(a, total);
    fundo.addEventListener('click', aoClicar);
    document.body.appendChild(fundo);
    document.addEventListener('keydown', aoTeclar, true);
    const foco = fundo.querySelector('.sb-pri:not([disabled])') || fundo.querySelector('#rpTirar');
    if (foco) foco.focus({ preventScroll: true });
  }

  async function pedir(a, acao, corpo) {
    travaBotoes(true);
    mostraMsg('');
    const e = fundo.querySelector('#rpMsgVerm');
    e.hidden = false; e.classList.remove('erro'); e.textContent = 'Enviando o pedido…';
    const res = await R.pedirEEsperar(raiz.fetch.bind(raiz), R.urlAchado(a.id, acao), corpo, {
      aoProgresso: t => { if (fundo) e.textContent = t; },
    });
    if (!fundo) return;
    travaBotoes(false);
    if (res.ok) {
      R.marcaDecidido(raiz.localStorage, a.id, Date.now());
      fecha();
      await atualiza();
      return;
    }
    mostraMsg(res.mensagem || 'O servidor não executou o pedido e não explicou o motivo. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30');
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => mostraMsg('A visita guiada não carregou. Recarregue a página e tente de novo.');
    document.head.appendChild(s);
  }

  function aoClicar(ev) {
    const bt = ev.target.closest('button[data-ra]');
    if (!bt || !aberto || bt.disabled) return;
    const k = bt.dataset.ra;
    if (k === 'aplicar') pedir(aberto, 'aplicar', {});
    else if (k === 'agendar-abre') { const b = fundo.querySelector('#rpAgenda'); b.hidden = !b.hidden; }
    else if (k === 'agendar') {
      const iso = R.agendaParaIso(fundo.querySelector('#rpQuando').value, Date.now());
      if (!iso) { mostraMsg('Escolha uma data e hora pelo menos 1 minuto à frente.'); return; }
      pedir(aberto, 'agendar', { quando: iso });
    } else if (k === 'tirar') {
      fecha();
      if (location.pathname.replace(/\/+$/, '') === '/seguranca') {
        const s = document.getElementById('secEmergencia');
        if (s) s.scrollIntoView({ block: 'start' });
      } else location.href = '/seguranca#emergencia';
    } else if (k === 'lembrar') {
      R.lembrarDepois(raiz.localStorage, aberto.id, Date.now());
      fecha();
      atualiza();
    } else if (k === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: passosDoModal(document) }));
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      const f = raiz.fetch.bind(raiz);
      const r = await R.chama(f, 'GET', R.API + '/ronda');
      if (!r.ok) {
        if (r.status !== 401 && r.status !== 0) console.warn('ronda-aviso: ' + r.erro + ' Sigo sem a janela vermelha.');
        return;
      }
      let em = null;
      const e = await R.chama(f, 'GET', R.API + '/emergencia');
      if (e.ok) em = e.json;
      lista = R.paraJanelaVermelha(r.json, raiz.localStorage, Date.now(), em);
      if (!aberto && lista.length && !document.getElementById('sbFundo') && !document.getElementById('tourCaixa')) abre(lista[0], lista.length);
    } catch (err) {
      console.warn('ronda-aviso: falhou ao montar a janela vermelha:', err);
    } finally { ocupado = false; }
  }

  function inicia() {
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { textoIntro, modalHtml, passosDoModal, atualiza };
});
