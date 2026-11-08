'use strict';
/* modal-login.js: o modal "Faça o login nos seus agentes" da tela de conversa.

   Ao abrir a conversa, confere se algum agente está sem login (ou com o login vencido). Se estiver, abre este
   <dialog> modal com um cartão por agente (os mesmos cartões da página /conectar, de conectar-cartoes.js). Quando
   todos ficam conectados, o modal troca para a tela final, com o que fazer agora e o vídeo "Conhecendo o DG Claw".

   - O modal aparece uma única vez por pessoa: ao abrir, o servidor guarda os agentes sem login que ele mostrou
     (POST /api/v1/modal-login/preferencia). "Fazer depois", Esc e recarregar não o trazem de volta. Só um agente
     NOVO sem login, que o modal ainda não mostrou, o reabre uma vez.
   - "Não mostrar mais" guarda no servidor que nem agente novo reabre o modal. O caminho para conectar continua
     na página Conectar conta e no cartão do agente.
   - Se o servidor não responder, o modal NÃO abre (melhor calar do que repetir); a causa vai para o console.
   - O modal substitui o pop-up "Seu login do Claude expirou" nesta carga da página: se ele abriu, o pop-up não
     abre nem depois que o modal fechar (conversa.js consulta DGModalLogin e ouve 'dgmodallogin:abriu').
   - Erro na conferência inicial (rede, 401, 5xx) não abre modal nem redireciona: só um aviso no console com a
     causa. Só o 401 DURANTE o uso do modal leva ao login e volta para esta mesma conversa.
   - Nenhuma rota nova: usa GET /api/v1/agents e as rotas de login que /conectar já usa.

   SEGREDOS: link de login e código colado nunca vão para console, storage, URL nem title (conectar-cartoes.js).
   Todo texto do servidor entra com textContent. Contrato: web/docs/CONECTAR-CONTA.md. */
(function () {
  const P = window.DGConectar;
  const CC = window.DGConectarCartoes;
  const dlg = document.getElementById('dlgModalLogin');
  const VIDEO = '/videos/conhecendo-o-dgclaw.mp4';
  const POSTER = '/videos/conhecendo-o-dgclaw.jpg';
  const est = { aberto: false, abriu: false, fim: false, ctrl: null, video: null };
  const $ = id => document.getElementById(id);

  window.DGModalLogin = { aberto: () => est.aberto, abriuNestaCarga: () => est.abriu };

  const ROTA_PREF = '/api/v1/modal-login/preferencia';
  async function lePref() {
    const r = await fetch(ROTA_PREF, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  /** Guarda no servidor. Falha vira aviso no console com a causa; o modal já está na tela, então não bloqueia. */
  async function guardaPref(corpo) {
    try {
      const r = await fetch(ROTA_PREF, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) { console.warn('modal de login: não consegui guardar sua escolha no servidor (' + e.message + '); o aviso pode aparecer de novo.'); }
  }

  function textoDe(id, texto) { $(id).textContent = texto; }

  function desenhaInicio(n, principalNome) {
    const t = P.textosModal(n, { principalNome, colaborador: !!(window.DGPapel && window.DGPapel.colaborador) });
    textoDe('mlTit', t.titulo);
    textoDe('mlIntro', t.intro);
    textoDe('mlDepois', t.depois);
    textoDe('mlNunca', t.nunca);
    textoDe('mlComecar', t.comecar);
    return t;
  }

  function montaVideo(legenda) {
    const bloco = document.createElement('div');
    bloco.className = 'cn-video';
    const leg = document.createElement('p');
    leg.className = 'cn-legenda';
    leg.textContent = legenda;
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'none';
    v.poster = POSTER;
    v.src = VIDEO;
    // vídeo ausente ou quebrado: some só o bloco do vídeo, o resto da tela final continua
    v.addEventListener('error', () => { bloco.hidden = true; });
    bloco.append(leg, v);
    est.video = v;
    $('mlVideo').replaceChildren(bloco);
  }

  /* Todos conectados: troca para a tela final. O vídeo é montado uma vez só. */
  function mostraFim(n, principalNome) {
    if (est.fim) return;
    est.fim = true;
    const t = P.textosModal(n, { principalNome, colaborador: !!(window.DGPapel && window.DGPapel.colaborador) });
    textoDe('mlTitFim', t.tituloFim);
    textoDe('mlAgora', t.agora);
    const ul = $('mlItens');
    ul.replaceChildren();
    for (const i of t.itens) { const li = document.createElement('li'); li.textContent = i; ul.append(li); }
    montaVideo(t.legendaVideo);
    $('mlLogin').hidden = true;
    $('mlFim').hidden = false;
    dlg.setAttribute('aria-labelledby', 'mlTitFim');
    dlg.scrollTop = 0;
    try { $('mlComecar').focus({ preventScroll: true }); } catch (e) { console.warn('modal de login: não consegui pôr o foco no botão final:', e.message); }
  }

  function fecha(nunca) {
    if (!est.aberto) return;
    if (nunca) guardaPref({ nao_mostrar_mais: true });
    est.aberto = false;
    if (est.ctrl) est.ctrl.para();
    if (est.video) { try { est.video.pause(); } catch (e) { console.warn('modal de login: não consegui pausar o vídeo:', e.message); } }
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }

  function abre(ctrl, n, principalNome) {
    est.aberto = true; est.abriu = true;
    // o modal substitui o pop-up de login expirado: se ele já estava aberto, conversa.js o fecha
    document.dispatchEvent(new CustomEvent('dgmodallogin:abriu'));
    desenhaInicio(n, principalNome);
    $('mlDepois').onclick = () => fecha(false);
    $('mlNunca').onclick = () => fecha(true);
    $('mlComecar').onclick = () => fecha(false);
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); fecha(false); });
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    // o foco inicial fica com o navegador: o primeiro elemento do primeiro cartão (Gerar link de login)
  }

  async function inicia() {
    if (!dlg || !P || !CC || !window.DGLoginCartao) {
      console.warn('modal de login: ' + (!dlg ? 'falta #dlgModalLogin na página' : 'um dos scripts (conectar-puro, conectar-cartoes, login-cartao) não carregou') + '. A página Conectar conta continua funcionando.');
      return;
    }
    if (window.DGPapel && window.DGPapel.colaborador) return; // login da conta é só do dono
    let pref = null;
    try { pref = await lePref(); } catch (e) { console.warn('modal de login: não consegui ler se a pessoa já viu o aviso (' + e.message + '); não abro o modal.'); return; }
    if (pref && pref.nao_mostrar_mais === true) return;
    let dados = null;
    try {
      const r = await fetch('/api/v1/agents', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) { console.warn('modal de login: a lista de agentes respondeu HTTP ' + r.status + '; não abro o modal.'); return; }
      dados = await r.json();
    } catch (e) { console.warn('modal de login: não consegui ler a lista de agentes (' + e.message + '); não abro o modal.'); return; }
    const agentes = P.ordenar(dados && dados.agentes);
    if (!agentes.length) return;
    const principal = P.principal(agentes);
    const lista = $('mlCartoes');
    lista.replaceChildren();
    const ctrl = CC.cria({
      lista, agentes, principal, prefixoId: 'mlCodigo-',
      voltarPara: location.pathname + location.search,
      aoMudar: c => { if (est.aberto && P.modalCompleto(c.selos())) mostraFim(agentes.length, principal && principal.nome); },
    });
    est.ctrl = ctrl;
    try { await ctrl.inicia(); } catch (e) { console.warn('modal de login: a conferência dos logins falhou (' + e.message + '); não abro o modal.'); ctrl.para(); return; }
    const novos = P.agentesNovosParaModal(agentes.map(a => a.id), ctrl.selos(), pref);
    if (novos.length) {
      guardaPref({ vistos: novos });
      abre(ctrl, agentes.length, principal && principal.nome);
    } else ctrl.para();
  }

  inicia();
})();
