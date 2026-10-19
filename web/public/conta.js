'use strict';
/* conta.js: a tela Minha conta (/conta). Trocar a senha, ativar ou desativar o segundo fator (TOTP) e ver/encerrar as sessões abertas.
   Fala com /api/v1/eu, /eu/senha, /eu/2fa/(iniciar|ativar|desativar) e /eu/sessoes (web/lib/ent/usuarios.js).
   Parte pura (com teste): PASSOS, htmlDados, htmlDoisFatores. Parte com DOM: DGConta.montar(elemento). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGConta = m;
    m.registra();
  }
})(this, function (raiz) {
  const C = raiz.DGContaComum || require('./conta-comum');
  const { esc } = C;

  const PAPEL = { ti: 'TI (vê tudo)', funcionario: 'Funcionário (vê só os agentes liberados)' };

  function htmlDados(eu) {
    return '<dl class="cn-det">' +
      '<dt>Usuário</dt><dd>' + esc(eu.usuario) + '</dd>' +
      '<dt>Nome</dt><dd>' + esc(eu.nome) + '</dd>' +
      '<dt>Perfil</dt><dd>' + esc(PAPEL[eu.papel] || eu.papel) + '</dd>' +
      (eu.papel === 'funcionario' ? '<dt>Agentes liberados</dt><dd>' + (eu.agentes && eu.agentes.length ? esc(eu.agentes.join(', ')) : 'nenhum ainda (peça ao TI)') + '</dd>' : '') +
      '<dt>Último acesso</dt><dd>' + esc(C.dataBr(eu.ultimo_login)) + '</dd></dl>';
  }

  /* O bloco do segundo fator conforme o estado. `ativacao` (opcional) é a resposta de /eu/2fa/iniciar. */
  function htmlDoisFatores(eu, ativacao) {
    const obrig = eu.exige_2fa;
    let h = '<p>' + (eu.totp.ativo
      ? '<span class="cn-selo cn-on">ligado</span> desde ' + esc(C.dataBr(eu.totp.ativado_em)) + '. Códigos de reserva que restam: <b>' + esc(eu.totp.codigos_reserva) + '</b>.'
      : '<span class="cn-selo cn-off">desligado</span> ' + (obrig ? 'Neste nível de proteção ele é obrigatório para o seu perfil.' : 'É opcional para o seu perfil, mas protege sua conta se a senha vazar.')) + '</p>';
    if (!eu.totp.ativo) {
      if (ativacao) {
        h += C.htmlSegredo(ativacao) +
          '<form class="cn-form" data-form="ativar-2fa"><label for="cnCodigoAtiva">Código de 6 números</label>' +
          '<input id="cnCodigoAtiva" name="codigo" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required>' +
          '<button type="submit" class="cn-btn cn-forte">Confirmar e ativar</button></form>';
      } else {
        h += '<div class="cn-acoes"><button type="button" class="cn-btn cn-forte" data-acao="iniciar-2fa">Ativar o segundo fator</button></div>';
      }
    } else if (!eu.pode_desativar_2fa) {
      h += '<p class="cn-fraco">Não dá para desligar neste nível de proteção (2fa = ' + esc(eu.nivel_2fa) + ').</p>';
    } else {
      h += '<form class="cn-form" data-form="desativar-2fa"><label for="cnDesSenha">Sua senha</label>' +
        '<input id="cnDesSenha" name="senha" type="password" autocomplete="current-password" required>' +
        '<label for="cnDesCodigo">Código de 6 números</label>' +
        '<input id="cnDesCodigo" name="codigo" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required>' +
        '<button type="submit" class="cn-btn cn-perigo">Desativar o segundo fator</button></form>';
    }
    return h;
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-cn-tour="titulo"]', titulo: 'Minha conta',
        oque: 'O lugar onde você cuida do seu acesso: senha, segundo fator e as sessões abertas.',
        como: 'Cada bloco chama o servidor na hora e mostra o que está valendo agora para o seu usuário.',
        porque: 'Quem entra num painel com vários agentes precisa poder fechar a porta sozinho se perder o celular ou a senha vazar.' },
    ],
    senha: [
      { alvo: '[data-cn-tour="senha"]', titulo: 'Trocar a senha',
        oque: 'Você digita a senha atual e a nova (mínimo de 12 caracteres).',
        como: 'O servidor confere a atual, grava a nova só como hash e encerra as suas outras sessões. Esta continua aberta.',
        porque: 'Se alguém soubesse a senha antiga, ficaria sem acesso na hora.' },
    ],
    doisfatores: [
      { alvo: '[data-cn-tour="2fa"]', titulo: 'Segundo fator (2FA)',
        oque: 'Um código de 6 números que muda a cada 30 segundos, gerado pelo aplicativo autenticador do seu celular.',
        como: 'Ao ativar, o servidor guarda um segredo, confere o primeiro código que você digitar e mostra 10 códigos de reserva uma única vez. Daí em diante o login pede senha e código.',
        porque: 'Senha vaza. Com o segundo fator, quem roubou a senha ainda precisa do seu celular.' },
    ],
    sessoes: [
      { alvo: '[data-cn-tour="sessoes"]', titulo: 'Sessões abertas',
        oque: 'Cada aparelho ou navegador em que você está logado agora, com IP e último uso.',
        como: 'Sair de uma sessão apaga a chave dela no servidor; o aparelho volta para a tela de login na hora.',
        porque: 'Esqueceu logado no computador de outra pessoa? Encerre daqui, sem esperar a sessão vencer.' },
    ],
  };

  const puros = { PASSOS, PAPEL, htmlDados, htmlDoisFatores };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null;
  let eu = null;
  let ativacao = null;
  let codigosNovos = null;

  const q = (s) => raizEl.querySelector(s);
  function status(msg, erro) {
    const s = q('#cnStatus');
    s.textContent = msg || '';
    s.className = 'cn-status' + (erro ? ' cn-erro' : (msg ? ' cn-ok' : ''));
  }
  const falhou = (e) => status(e.message, true);

  function tela() {
    return '<div class="cn-tela"><header class="cn-cab" data-cn-tour="titulo"><h1>Minha conta</h1>' +
      '<button type="button" class="cn-btn" data-cn-tutorial="pagina">Tutorial</button></header>' +
      '<p id="cnStatus" class="cn-status" role="status" aria-live="polite"></p>' +
      '<section class="cn-sec" data-cn-tour="dados"><h2>Seus dados</h2><div id="cnDados"></div></section>' +
      '<section class="cn-sec" data-cn-tour="senha"><h2>Senha <button type="button" class="cn-ajuda" data-cn-tutorial="senha" aria-label="Ajuda sobre a senha">?</button></h2>' +
      '<form class="cn-form" data-form="senha"><label for="cnSenhaAtual">Senha atual</label><input id="cnSenhaAtual" name="senha_atual" type="password" autocomplete="current-password" required>' +
      '<label for="cnSenhaNova">Senha nova (12 caracteres ou mais)</label><input id="cnSenhaNova" name="senha_nova" type="password" autocomplete="new-password" minlength="12" required>' +
      '<label for="cnSenhaConf">Repita a senha nova</label><input id="cnSenhaConf" name="confirmacao" type="password" autocomplete="new-password" minlength="12" required>' +
      '<button type="submit" class="cn-btn cn-forte">Trocar a senha</button></form></section>' +
      '<section class="cn-sec" data-cn-tour="2fa"><h2>Segundo fator <button type="button" class="cn-ajuda" data-cn-tutorial="doisfatores" aria-label="Ajuda sobre o segundo fator">?</button></h2><div id="cn2fa"></div></section>' +
      '<section class="cn-sec" data-cn-tour="sessoes"><h2>Sessões abertas <button type="button" class="cn-ajuda" data-cn-tutorial="sessoes" aria-label="Ajuda sobre as sessões">?</button></h2>' +
      '<div id="cnSessoes"></div><div class="cn-acoes"><button type="button" class="cn-btn cn-perigo" data-acao="sair-todas">Sair de todas as sessões</button></div></section></div>';
  }

  function pinta() {
    q('#cnDados').innerHTML = htmlDados(eu);
    q('#cn2fa').innerHTML = (codigosNovos ? C.htmlCodigosReserva(codigosNovos) : '') + htmlDoisFatores(eu, ativacao);
  }

  async function carregaSessoes() {
    const d = await C.api('GET', '/api/v1/eu/sessoes');
    q('#cnSessoes').innerHTML = C.htmlSessoes(d.sessoes, { botao: 'Sair desta sessão' });
  }

  async function carrega() {
    try {
      eu = await C.api('GET', '/api/v1/eu');
      if (!eu.papel) throw new Error('O multiusuário não está ligado neste nível de proteção, então não há conta para gerenciar aqui.');
      pinta();
      await carregaSessoes();
      status('');
    } catch (e) { falhou(e); }
  }

  const campos = (form) => Object.fromEntries(new FormData(form).entries());

  async function enviar(form) {
    const nome = form.dataset.form;
    const v = campos(form);
    status('');
    try {
      if (nome === 'senha') {
        const r = await C.api('POST', '/api/v1/eu/senha', v);
        form.reset();
        status('Senha trocada.' + (r.sessoes_encerradas ? ' Encerrei ' + r.sessoes_encerradas + ' outra(s) sessão(ões).' : ''));
        await carregaSessoes();
      } else if (nome === 'ativar-2fa') {
        const r = await C.api('POST', '/api/v1/eu/2fa/ativar', { codigo: v.codigo });
        ativacao = null; codigosNovos = r.codigos_reserva;
        eu = await C.api('GET', '/api/v1/eu');
        pinta();
        status('Segundo fator ativado. Guarde os códigos de reserva.');
      } else if (nome === 'desativar-2fa') {
        await C.api('POST', '/api/v1/eu/2fa/desativar', v);
        codigosNovos = null;
        eu = await C.api('GET', '/api/v1/eu');
        pinta();
        status('Segundo fator desativado.');
      }
    } catch (e) { falhou(e); }
  }

  async function clique(b) {
    const acao = b.dataset.acao;
    status('');
    try {
      if (acao === 'iniciar-2fa') {
        ativacao = await C.api('POST', '/api/v1/eu/2fa/iniciar', {});
        pinta();
      } else if (acao === 'copiar-codigos') {
        await C.copiar((codigosNovos || []).join('\n'), b);
      } else if (acao === 'sair-sessao') {
        const r = await C.api('DELETE', '/api/v1/eu/sessoes/' + encodeURIComponent(b.dataset.id));
        if (r.inclui_a_atual) { location.href = '/login'; return; }
        await carregaSessoes();
        status('Sessão encerrada.');
      } else if (acao === 'sair-todas') {
        await C.api('DELETE', '/api/v1/eu/sessoes');
        location.href = '/login';
      }
    } catch (e) { falhou(e); }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.senha, PASSOS.doisfatores, PASSOS.sessoes) : PASSOS[chave];
    const cab = q('.cn-cab');
    if (chave === 'pagina' && cab && cab.offsetParent === null && document.getElementById('cabecalho')) {
      passos = passos.map(p => (p.alvo === '[data-cn-tour="titulo"]' ? Object.assign({}, p, { alvo: '#cabecalho' }) : p));
    }
    raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('cn-raiz');
    elemento.innerHTML = tela();
    elemento.addEventListener('click', ev => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.cnTutorial) tour(t.dataset.cnTutorial);
      else if (t.dataset.acao) clique(t);
    });
    elemento.addEventListener('submit', ev => {
      if (ev.target.dataset && ev.target.dataset.form) { ev.preventDefault(); enviar(ev.target); }
    });
    return carrega();
  }

  function registra() {
    const el = document.getElementById('contaRaiz');
    if (el) montar(el);
  }

  return Object.assign({ montar, registra }, puros);
});
