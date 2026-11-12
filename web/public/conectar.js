'use strict';
/* conectar.js: a página /conectar. Um cartão por agente (o Admin primeiro) para o dono conectar sozinho a
   conta do Claude ou do Codex de cada um.

   Os cartões e o fluxo de login vêm de conectar-cartoes.js (compartilhado com o modal da conversa). Aqui ficam
   a lista de agentes, o mini tutorial "Tudo pronto" e a visita guiada. Contrato: web/docs/CONECTAR-CONTA.md.

   SEGREDOS: o link de login e o código colado nunca vão para console, log, localStorage, URL nem atributo
   title (conectar-cartoes.js cuida disso). Todo texto que vem do servidor entra com textContent. */
(function () {
  const P = window.DGConectar;
  const LC = window.DGLoginCartao;
  const CC = window.DGConectarCartoes;
  const AQUI = '/conectar';
  const $ = id => document.getElementById(id);

  const COLAB = !!(window.DGPapel && window.DGPapel.colaborador);
  const est = { usuario: '', pronto: false, principal: null, ctrl: null };

  function msgGeral(texto) {
    const e = $('cnMsgGeral');
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function botao(texto, classe, aoClicar, desligado) {
    const b = el('button', 'cn-btn ' + classe, texto);
    b.type = 'button';
    b.disabled = !!desligado;
    b.addEventListener('click', aoClicar);
    return b;
  }

  /* Depois de cada desenho dos cartões: mostra o "Tudo pronto" quando todos conectaram. */
  function aoMudar(ctrl) {
    const tudo = P.tudoConectado(ctrl.selos());
    $('cnPronto').hidden = !tudo;
    if (tudo && !est.pronto) { est.pronto = true; desenhaPronto(); }
  }

  /* ── Mini tutorial "Tudo pronto" ────────────────────────────────────────── */
  async function copiaEndereco(aviso, endereco) {
    try { await navigator.clipboard.writeText(endereco); aviso.textContent = 'Endereço copiado.'; }
    catch (err) { aviso.textContent = 'Não consegui copiar sozinho (' + ((err && err.message) || 'o navegador recusou') + '). Toque no endereço, segure e escolha copiar.'; }
  }

  /* Montado uma vez só: refazer o vídeo a cada desenho reiniciaria a reprodução. */
  function desenhaPronto() {
    const endereco = location.origin + '/';
    const t = P.pronto({ usuario: est.usuario, principalNome: est.principal && est.principal.nome, endereco, colaborador: COLAB });
    const corpo = [];
    corpo.push(el('p', 'cn-texto', t.passo1));
    corpo.push(el('div', 'cn-endereco', t.endereco));
    const aviso = el('p', 'cn-nota', '');
    aviso.setAttribute('role', 'status');
    const abrir = el('a', 'cn-btn cn-principal', 'Abrir o painel');
    abrir.href = endereco; abrir.target = '_blank'; abrir.rel = 'noopener noreferrer';
    const linha = el('div', 'cn-pe');
    linha.append(abrir, botao('Copiar endereço', 'cn-leve', () => copiaEndereco(aviso, endereco)));
    corpo.push(linha, aviso);
    corpo.push(el('p', 'cn-texto', t.passo2));
    corpo.push(el('p', 'cn-texto', t.passo3));
    const ul = el('ul', 'cn-lista-passos');
    for (const i of t.itens) ul.append(el('li', '', i));
    corpo.push(ul);

    const bloco = el('div', 'cn-video');
    bloco.append(el('p', 'cn-legenda', t.legendaVideo));
    const v = document.createElement('video');
    v.controls = true; v.playsInline = true; v.preload = 'metadata';
    v.poster = '/videos/conhecendo-o-dgclaw.jpg';
    v.src = '/videos/conhecendo-o-dgclaw.mp4';
    // vídeo ausente ou quebrado: some o bloco, o resto do passo a passo continua
    v.addEventListener('error', () => { bloco.hidden = true; });
    bloco.append(v);
    corpo.push(bloco);
    $('cnProntoCorpo').replaceChildren(...corpo);
  }

  /* Colaborador: a página é a mesma, mas fala do agente dele e não manda "repetir no próximo cartão". */
  function adaptaParaColaborador() {
    const titulo = document.querySelector('#cnAgentes h2 span');
    if (titulo) titulo.textContent = 'O seu agente';
    const ultimo = document.querySelector('#cnPassos .cn-passos li:last-child');
    if (ultimo) ultimo.remove();
    const aviso = document.querySelector('#cnPassos .cn-fraco');
    if (aviso) aviso.textContent = 'Só dá para conectar quando o agente ainda não tem uma conta. O link vale por poucos minutos: gere só quando for fazer o login na hora.';
  }

  async function carrega() {
    if (COLAB) adaptaParaColaborador();
    const r = await CC.chama('GET', '/api/v1/agents', undefined, 'conferir', 'os agentes', 15000, AQUI);
    if (!r.ok) {
      $('cnLista').replaceChildren(el('p', 'cn-erro', 'Não consegui carregar a lista de agentes. ' + r.erro.texto));
      msgGeral('');
      return;
    }
    const agentes = P.ordenar(r.dados.agentes);
    est.principal = P.principal(agentes);
    est.usuario = typeof r.dados.usuario === 'string' ? r.dados.usuario : '';
    if (!agentes.length) {
      $('cnLista').replaceChildren(el('p', 'cn-fraco', 'Ainda não há agentes. Peça ao Admin para criar o primeiro e volte aqui.'));
      return;
    }
    $('cnLista').replaceChildren();
    est.ctrl = CC.cria({ lista: $('cnLista'), agentes, principal: est.principal, prefixoId: 'cnCodigo-', voltarPara: AQUI, aoMudar });
    await est.ctrl.inicia();
  }

  /* ── Tutorial ───────────────────────────────────────────────────────────── */
  const PASSOS = {
    passos: [
      { alvo: '#cnPassos', titulo: 'O passo a passo',
        oque: 'Os quatro passos para conectar a conta do Claude de cada agente, sem terminal.',
        como: 'Não há conta aqui: cada passo é uma ação sua. Você gera o link, entra na sua conta do Claude, copia o código que a página mostra e cola no cartão.',
        porque: 'O link de login vale por poucos minutos. Por isso ele só nasce quando você toca em Gerar, e não antes.' },
    ],
    agentes: [
      { alvo: '#cnAgentes', titulo: 'Os seus agentes',
        oque: 'Um cartão por agente, com o Admin primeiro. Cada um tem a própria conta.',
        como: 'A lista vem do painel e cada cartão pergunta ao programa do agente como está a conta dele.',
        porque: 'Cada agente precisa da conta conectada para responder. Assim você resolve todos num lugar só.' },
      { alvo: '[data-tour="cn-selo"]', titulo: 'O selo de estado',
        oque: 'Diz se a conta do agente está conectada: Conectado, Falta conectar, Login expirou, Usa chave de API ou Não consegui conferir.',
        como: 'O selo vem do próprio programa do Claude, que o agente consulta na hora (o campo conferido), e não de uma anotação do painel. Se o programa do agente não responde, o selo diz isso em vez de chutar.',
        porque: 'Para você ver de relance quem precisa de atenção. Cinza não é problema: o agente usa chave de API e não tem conta para conectar.' },
      { alvo: '[data-tour="cn-gerar"]', titulo: 'Gerar link de login',
        oque: 'O botão que começa o login. É só aqui que o link nasce.',
        como: 'Ao tocar, o programa do agente pede um link ao Claude. Ele vale por poucos minutos e o prazo conta a partir deste toque; passados 15 minutos o login é cancelado sozinho.',
        porque: 'Gerar só na hora de usar evita o link vencido que ninguém abriu a tempo. Só um login por vez fica em andamento na página.' },
      { alvo: '[data-tour="cn-codigo"]', titulo: 'Cole aqui o código',
        oque: 'Onde você cola o código que a página de login do Claude mostra no fim.',
        como: 'Não mexo no que você colar além de tirar espaços das pontas. Se o celular quebrou o código em linhas, o painel recusa e explica; copie de novo, de uma vez.',
        porque: 'O código prova ao Claude que foi você quem entrou. Ele vence em poucos minutos e só serve uma vez, e some do campo assim que é enviado.' },
    ],
  };

  /* Os mesmos passos, com o texto de quem tem um agente só e não vê o Admin. */
  const TEXTO_COLAB = {
    '#cnPassos': { oque: 'Os passos para conectar a sua conta do Claude ao seu agente, sem terminal.', como: 'Você gera o link, entra na sua conta do Claude, copia o código que a página mostra e cola no cartão. Só dá para conectar quando o agente ainda não tem conta.' },
    '#cnAgentes': { titulo: 'O seu agente', oque: 'O cartão do seu agente, que mostra se ele já tem uma conta conectada.', como: 'O cartão pergunta ao programa do agente como está a conta dele. Se já estiver conectado, só aparece o aviso, sem botões.', porque: 'O agente precisa de uma conta conectada para responder. Se a conta já é do dono, quem mexe nela é o dono.' },
    '[data-tour="cn-selo"]': { como: 'O selo vem do próprio agente, que confere na hora se a conta está conectada. Se outra pessoa estiver conectando no mesmo momento, o cartão avisa e espera ela terminar (no máximo 15 minutos).' },
  };
  function comTour(passos) {
    if (COLAB) passos = passos.map(p => Object.assign({}, p, TEXTO_COLAB[p.alvo] || {}));
    if (!window.DGTour) { msgGeral('A visita guiada não carregou. Recarregue a página e tente de novo.'); return; }
    window.DGTour.inicia({ passos: passos.filter(p => document.querySelector(p.alvo)) });
  }
  PASSOS.pronto = [
    { alvo: '#cnPronto', titulo: 'Tudo pronto',
      oque: 'Aparece quando todos os agentes que usam assinatura estão conectados. Diz onde acessar o painel e o que você vai ver.',
      como: 'O endereço é o deste mesmo painel. O usuário vem da sua sessão e a senha é a mesma que você usou para entrar aqui; ela nunca aparece na tela.',
      porque: 'Para você sair daqui sabendo o próximo passo e ver, em menos de 1 minuto, como o DG Claw funciona.' },
  ];
  function tutorial() { comTour([PASSOS.passos[0]].concat(PASSOS.agentes, PASSOS.pronto)); }

  document.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-cn="ajuda"]');
    if (b) { ev.preventDefault(); comTour(PASSOS[b.dataset.secao] || []); }
  });

  window.DGConectarTela = { tutorial };
  if (!P || !LC || !CC) msgGeral('Parte da página não carregou. Recarregue; se continuar, peça ao Admin para conferir a instalação do painel.');
  else carrega();
})();
