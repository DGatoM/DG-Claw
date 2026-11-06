'use strict';
/* conectar.js: a página /conectar. Um cartão por agente (o Admin primeiro) para o dono conectar sozinho a
   conta do Claude ou do Codex de cada um.

   Usa só rotas que já existem: GET /api/v1/agents e GET/POST/DELETE /api/v1/agents/<id>/login, mais
   /login/codigo e /login/oi. Contrato: web/docs/CONECTAR-CONTA.md e web/docs/LOGIN-NA-CONVERSA.md.
   O que cada cartão mostra e como cada erro vira frase vem de conectar-puro.js (com teste).

   SEGREDOS: o link de login e o código colado nunca vão para console, log, localStorage, URL nem atributo
   title. O campo do código é limpo depois de cada envio, com sucesso ou erro. Todo texto que vem do
   servidor entra com textContent. */
(function () {
  const P = window.DGConectar;
  const LC = window.DGLoginCartao;
  const AQUI = '/conectar';
  const $ = id => document.getElementById(id);

  /* por agente: dados (última resposta de GET login), erroConferir, iniciado, concluiuAgora, ocupado,
     erro, aviso, copiado, confirmando, oiFeito, conferindo */
  const est = { agentes: [], por: {}, timer: null };

  function msgGeral(texto) {
    const e = $('cnMsgGeral');
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  function paraOLogin() { location.href = '/login?next=' + encodeURIComponent(AQUI); }

  /* Chama a API sem nunca lançar: devolve { ok, status, dados, erro } com o erro já em frase de leigo. */
  async function chama(metodo, url, corpo, acao, nome, timeoutMs) {
    const init = { method: metodo, cache: 'no-store', credentials: 'same-origin' };
    if (corpo !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(corpo); }
    const ctl = new AbortController();
    init.signal = ctl.signal;
    const relogio = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    let r = null, dados = null, falhaRede = '';
    try {
      r = await fetch(url, init);
      try { dados = await r.json(); } catch (e) { dados = null; }
    } catch (e) {
      falhaRede = ctl.signal.aborted ? 'o painel não respondeu a tempo' : (e && e.message) || 'sem rede';
    } finally { clearTimeout(relogio); }
    if (!r) return { ok: false, status: 0, dados: null, erro: P.traduzErro(0, falhaRede, acao, nome) };
    if (r.ok && !(dados && dados.ok === false)) return { ok: true, status: r.status, dados: dados || {}, erro: null };
    const t = P.traduzErro(r.status, dados && dados.erro, acao, nome);
    if (t.sessaoExpirada) paraOLogin();
    return { ok: false, status: r.status, dados, erro: t };
  }

  const urlLogin = id => '/api/v1/agents/' + encodeURIComponent(id) + '/login';
  const novoEstado = () => ({ dados: null, erroConferir: '', iniciado: false, concluiuAgora: false, ocupado: false,
                              erro: '', erroPoll: '', aviso: '', copiado: false, confirmando: false, oiFeito: false, conferindo: false,
                              geracao: 0 });
  const emAndamento = e => !!e.dados && P.emAndamento(e.dados.estado);

  /* ── Desenho ────────────────────────────────────────────────────────────── */
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

  function outroEmAndamento(id) {
    for (const a of est.agentes) {
      if (a.id !== id && emAndamento(est.por[a.id])) return a.nome;
    }
    return '';
  }

  function visaoDe(a) {
    const e = est.por[a.id];
    return P.visaoCartao(e.dados, { agente: a, iniciado: e.iniciado, concluiuAgora: e.concluiuAgora, erroConferir: e.erroConferir, outroNome: outroEmAndamento(a.id) });
  }

  function foto(a) {
    const f = el('div', 'cn-foto');
    f.setAttribute('aria-hidden', 'true');
    if (a.cor) f.style.background = /^#[0-9a-f]{3,8}$/i.test(a.cor) ? a.cor : '';
    if (a.avatar_img && /^(https:\/\/|\/)/i.test(a.avatar_img) && !a.avatar_img.startsWith('//')) {
      const img = document.createElement('img');
      img.alt = ''; img.src = a.avatar_img;
      f.append(img);
    } else f.textContent = a.avatar && a.avatar.length <= 2 ? a.avatar : (a.nome || '?').slice(0, 1).toUpperCase();
    return f;
  }

  function desenhaCartao(a) {
    const e = est.por[a.id];
    const v = visaoDe(a);
    let cartao = document.querySelector('[data-agente="' + CSS.escape(a.id) + '"]');
    if (!cartao) { cartao = el('article', 'cn-cartao'); cartao.dataset.agente = a.id; $('cnLista').append(cartao); }
    cartao.dataset.fase = v.fase;

    // o campo do código é refeito junto com o cartão: guarda o texto e o foco para o teclado não fechar
    const antes = cartao.querySelector('.cn-campo');
    const valor = antes ? antes.value : '';
    const focado = !!antes && document.activeElement === antes;

    const topo = el('div', 'cn-topo');
    const quem = el('div', 'cn-quem');
    quem.append(el('b', 'cn-nome', v.nome), el('span', 'cn-papel', v.papel));
    if (v.subtitulo) quem.append(el('span', 'cn-sub', v.subtitulo));
    const selo = el('span', 'cn-selo cn-' + v.selo.cor, v.selo.texto);
    selo.dataset.tour = 'cn-selo';
    topo.append(foto(a), quem, selo);
    const corpo = [topo];

    if (v.texto) corpo.push(el('p', 'cn-texto', v.texto));
    if (v.passos.length) {
      const ol = el('ol', 'cn-lista-passos');
      for (const p of v.passos) ol.append(el('li', '', p));
      corpo.push(ol);
    }
    if (v.link) {
      const ab = el('a', 'cn-btn cn-principal cn-grande', 'Abrir a página de login');
      ab.href = v.link; ab.target = '_blank'; ab.rel = 'noopener noreferrer';
      corpo.push(ab);
      corpo.push(botao(e.copiado ? 'Link copiado' : 'Copiar link', 'cn-leve', () => copiaLink(a), e.ocupado));
    }
    if (v.codigoDispositivo) corpo.push(el('div', 'cn-dispositivo', v.codigoDispositivo));
    if (v.campoCodigo) {
      const rot = el('label', 'cn-rotulo', 'Cole aqui o código');
      rot.htmlFor = 'cnCodigo-' + a.id;
      const campo = document.createElement('input');
      campo.type = 'text'; campo.id = rot.htmlFor; campo.className = 'cn-campo';
      campo.autocomplete = 'off'; campo.spellcheck = false; campo.value = valor;
      campo.setAttribute('autocapitalize', 'off');
      campo.setAttribute('autocorrect', 'off');
      campo.dataset.tour = 'cn-codigo';
      campo.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); enviaCodigo(a); } });
      const linha = el('div', 'cn-linha');
      linha.append(campo, botao(e.ocupado ? 'Enviando…' : 'Conectar', 'cn-principal', () => enviaCodigo(a), e.ocupado));
      corpo.push(rot, linha);
    }
    if (e.erro || e.erroPoll) { const p = el('p', 'cn-erro', e.erro || e.erroPoll); p.setAttribute('role', 'alert'); corpo.push(p); }
    if (e.aviso) corpo.push(el('p', 'cn-nota', e.aviso));
    if (v.gerarBloqueio && (v.gerar === false) && v.fase !== 'conectado') corpo.push(el('p', 'cn-nota', v.gerarBloqueio));

    const pe = el('div', 'cn-pe');
    if (v.gerar) {
      const g = botao(e.ocupado ? 'Gerando…' : v.gerarRotulo, 'cn-principal cn-grande', () => comeca(a), e.ocupado);
      g.dataset.tour = 'cn-gerar';
      pe.append(g);
    }
    if (v.fase === 'sem_resposta') pe.append(botao('Conferir de novo', 'cn-principal', () => confere(a, true), e.conferindo));
    if (v.entrarOutra) {
      if (e.confirmando) {
        pe.append(el('p', 'cn-texto', 'Isso troca a conta de ' + v.nome + '. Continuar?'));
        pe.append(botao('Sim, trocar a conta', 'cn-principal', () => { e.confirmando = false; comeca(a); }, e.ocupado));
        pe.append(botao('Não', 'cn-leve', () => { e.confirmando = false; desenhaCartao(a); }));
      } else {
        pe.append(botao('Entrar com outra conta', 'cn-leve', () => { e.confirmando = true; desenhaCartao(a); }, e.ocupado));
      }
    }
    if (v.novoLink) pe.append(botao('Gerar novo link', 'cn-leve', () => novoLink(a), e.ocupado));
    if (v.cancelar) pe.append(botao('Cancelar', 'cn-leve', () => cancela(a), e.ocupado));
    if (pe.childElementCount) corpo.push(pe);
    const vivo = el('p', 'cn-vivo', v.aviso || '');
    vivo.setAttribute('aria-live', 'polite');
    corpo.push(vivo);

    cartao.replaceChildren(...corpo);
    if (focado) {
      const novo = cartao.querySelector('.cn-campo');
      if (novo) novo.focus({ preventScroll: true });
    }
  }

  function desenhaTudo() {
    for (const a of est.agentes) desenhaCartao(a);
    const selos = est.agentes.map(a => visaoDe(a).selo);
    $('cnTudo').hidden = !P.tudoConectado(selos);
  }

  /* ── Ações ──────────────────────────────────────────────────────────────── */
  async function confere(a, mostraCarregando) {
    const e = est.por[a.id];
    if (e.conferindo) return;
    e.conferindo = true;
    if (mostraCarregando) desenhaCartao(a);
    // geração: toda ação (gerar, cancelar, enviar código) a incrementa. Uma consulta que saiu antes da ação
    // e chegou depois dela traz um estado velho e é descartada (corrida apontada na revisão do PR #86).
    const geracao = e.geracao;
    const r = await chama('GET', urlLogin(a.id), undefined, 'conferir', a.nome, 15000);
    e.conferindo = false;
    if (geracao !== e.geracao) return;
    if (!r.ok) {
      // no meio de um login, um tropeço da consulta não esconde o cartão: aparece como aviso e a próxima volta tenta de novo
      if (emAndamento(e)) e.erroPoll = r.erro.texto;
      else e.erroConferir = r.erro.texto;
    } else {
      e.erroConferir = ''; e.erroPoll = '';
      const eraEmAndamento = emAndamento(e);
      e.dados = r.dados;
      if (emAndamento(e)) e.iniciado = true;
      else if (r.dados.estado === 'concluido' && (e.iniciado || eraEmAndamento)) { e.iniciado = true; conclui(a); }
    }
    desenhaCartao(a);
    desenhaTudo();
  }

  /* O oi é pedido uma vez; se falhar, a conta continua conectada e o aviso diz a causa. */
  async function conclui(a) {
    const e = est.por[a.id];
    if (e.concluiuAgora) return;
    e.concluiuAgora = true; e.erro = '';
    desenhaCartao(a); desenhaTudo();
    if (e.oiFeito) return;
    e.oiFeito = true;
    const r = await chama('POST', urlLogin(a.id) + '/oi', {}, 'oi', a.nome, 75000);
    if (!r.ok) e.aviso = 'A conta foi conectada, mas ' + r.erro.texto;
    desenhaCartao(a);
  }

  async function comeca(a) {
    const e = est.por[a.id];
    if (e.ocupado) return;
    e.ocupado = true; e.erro = ''; e.aviso = ''; e.confirmando = false;
    e.geracao++;
    desenhaCartao(a);
    const r = await chama('POST', urlLogin(a.id), {}, 'gerar', a.nome);
    e.ocupado = false;
    if (!r.ok) e.erro = r.erro.texto;
    else {
      const velho = e.dados || {};
      e.dados = Object.assign({ provedor: velho.provedor, auth: velho.auth, conferido: velho.conferido, precisa_login: velho.precisa_login, login_expirado: velho.login_expirado }, r.dados);
      e.iniciado = true; e.concluiuAgora = false; e.oiFeito = false; e.erroConferir = '';
    }
    desenhaCartao(a); desenhaTudo();
  }

  async function cancela(a) {
    const e = est.por[a.id];
    if (e.ocupado) return false;
    e.ocupado = true; e.erro = '';
    e.geracao++;
    desenhaCartao(a);
    const r = await chama('DELETE', urlLogin(a.id), undefined, 'cancelar', a.nome);
    e.ocupado = false;
    if (!r.ok) { e.erro = r.erro.texto; desenhaCartao(a); return false; }
    e.iniciado = false;
    if (e.dados) e.dados = Object.assign({}, e.dados, { estado: 'nenhum', link: undefined, codigoDispositivo: undefined, mensagem: undefined });
    desenhaCartao(a); desenhaTudo();
    confere(a);
    return true;
  }

  async function novoLink(a) {
    if (await cancela(a)) comeca(a);
  }

  async function enviaCodigo(a) {
    const e = est.por[a.id];
    if (e.ocupado) return;
    const campo = document.getElementById('cnCodigo-' + a.id);
    const codigo = P.limpaCodigo(campo ? campo.value : '');
    if (!codigo) { e.erro = 'Cole o código que a página mostrou no fim do login.'; desenhaCartao(a); if (campo) campo.focus(); return; }
    e.ocupado = true; e.erro = '';
    e.geracao++;
    // o código sai do campo antes da chamada, com sucesso ou erro: não fica na tela nem em variável
    campo.value = '';
    desenhaCartao(a);
    const r = await chama('POST', urlLogin(a.id) + '/codigo', { codigo }, 'codigo', a.nome);
    e.ocupado = false;
    if (!r.ok) e.erro = r.erro.texto;
    desenhaCartao(a);
    if (r.ok) confere(a);
  }

  async function copiaLink(a) {
    const e = est.por[a.id];
    const link = e.dados ? LC.linkSeguro(e.dados.link) : null;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      e.copiado = true; e.erro = '';
      setTimeout(() => { e.copiado = false; desenhaCartao(a); }, 2000);
    } catch (err) {
      e.erro = 'Não consegui copiar sozinho (' + ((err && err.message) || 'o navegador recusou') + '). Use o botão Abrir a página de login neste aparelho.';
    }
    desenhaCartao(a);
  }

  /* Confere de 2 em 2 s só os cartões com login em andamento, e só com a aba à vista. */
  function liga() {
    if (est.timer) return;
    est.timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const a of est.agentes) if (emAndamento(est.por[a.id])) confere(a);
    }, 2000);
  }

  async function carrega() {
    const r = await chama('GET', '/api/v1/agents', undefined, 'conferir', 'os agentes', 15000);
    if (!r.ok) {
      $('cnLista').replaceChildren(el('p', 'cn-erro', 'Não consegui carregar a lista de agentes. ' + r.erro.texto));
      msgGeral('');
      return;
    }
    est.agentes = P.ordenar(r.dados.agentes);
    if (!est.agentes.length) {
      $('cnLista').replaceChildren(el('p', 'cn-fraco', 'Ainda não há agentes. Peça ao Admin para criar o primeiro e volte aqui.'));
      return;
    }
    $('cnLista').replaceChildren();
    for (const a of est.agentes) est.por[a.id] = novoEstado();
    desenhaTudo();
    await Promise.all(est.agentes.map(a => confere(a, false)));
    liga();
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

  function comTour(passos) {
    if (!window.DGTour) { msgGeral('A visita guiada não carregou. Recarregue a página e tente de novo.'); return; }
    window.DGTour.inicia({ passos: passos.filter(p => document.querySelector(p.alvo)) });
  }
  function tutorial() { comTour([PASSOS.passos[0]].concat(PASSOS.agentes)); }

  document.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-cn="ajuda"]');
    if (b) { ev.preventDefault(); comTour(PASSOS[b.dataset.secao] || []); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const a of est.agentes) if (emAndamento(est.por[a.id])) confere(a);
  });

  window.DGConectarTela = { tutorial };
  if (!P || !LC) msgGeral('Parte da página não carregou. Recarregue; se continuar, peça ao Admin para conferir a instalação do painel.');
  else carrega();
})();
