'use strict';
/* usuarios.js: a tela Usuários (/usuarios), só para o TI. Criar, mudar perfil e agentes, desativar, gerar link de senha,
   zerar o 2FA e ver/encerrar sessões. Fala com /api/v1/usuarios (web/lib/ent/usuarios.js).
   Parte pura (com teste): PASSOS, htmlUsuario, htmlLista, htmlFormNovo, htmlLink. Parte com DOM: DGUsuarios.montar(elemento). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGUsuarios = m;
    m.registra();
  }
})(this, function (raiz) {
  const C = raiz.DGContaComum || require('./conta-comum');
  const { esc } = C;

  const PAPEL = { ti: 'TI', funcionario: 'Funcionário' };

  function checksAgentes(agentes, marcados, prefixo) {
    if (!agentes.length) return '<p class="cn-fraco">Ainda não há agentes de trabalho para liberar.</p>';
    return '<div class="cn-checks">' + agentes.map(a =>
      '<label><input type="checkbox" name="agentes" value="' + esc(a.id) + '"' + (marcados.includes(a.id) ? ' checked' : '') + '> ' + esc(a.nome) + ' <span class="cn-fraco">(' + esc(a.id) + ')</span></label>').join('') + '</div>';
  }

  function htmlLink(l) {
    return '<div class="cn-link" data-link><b>Link de senha para ' + esc(l.usuario) + '</b>' +
      '<code>' + esc(l.link) + '</code>' +
      '<span class="cn-fraco">Vale uma vez, até ' + esc(C.dataBr(l.link_expira_em)) + '. Mande à pessoa por um canal seguro; ele não aparece de novo.</span>' +
      '<div class="cn-acoes"><button type="button" class="cn-btn cn-mini" data-acao="copiar-link" data-link="' + esc(l.link) + '">Copiar o link</button></div></div>';
  }

  function htmlUsuario(u, agentes, aberto) {
    const selos = ['<span class="cn-selo ' + (u.papel === 'ti' ? 'cn-aviso' : '') + '">' + esc(PAPEL[u.papel] || u.papel) + '</span>'];
    selos.push(u.ativo ? '<span class="cn-selo cn-on">ativo</span>' : '<span class="cn-selo cn-off">desativado</span>');
    selos.push(u.totp.ativo ? '<span class="cn-selo cn-on">2FA ligado</span>' : '<span class="cn-selo ' + (u.exige_2fa ? 'cn-off' : '') + '">2FA ' + (u.exige_2fa ? 'pendente' : 'desligado') + '</span>');
    if (u.link_pendente) selos.push('<span class="cn-selo cn-aviso">link de senha pendente</span>');
    const nomeUrl = esc(u.usuario);
    let h = '<li class="cn-item ' + (u.ativo ? 'cn-ativo' : 'cn-inativo') + '" data-usuario="' + nomeUrl + '">' +
      '<div class="cn-linha"><b>' + esc(u.nome) + '</b> <span class="cn-fraco">' + nomeUrl + (u.email ? ' · ' + esc(u.email) : '') + '</span></div>' +
      '<div class="cn-linha">' + selos.join(' ') + '</div>' +
      '<div class="cn-fraco">' + (u.papel === 'ti' ? 'Vê todos os agentes, o Admin e a administração.' : 'Agentes: ' + (u.agentes.length ? esc(u.agentes.join(', ')) : 'nenhum liberado')) +
      ' · último acesso ' + esc(C.dataBr(u.ultimo_login)) + '</div>' +
      '<div class="cn-acoes">' +
      '<button type="button" class="cn-btn cn-mini" data-acao="editar" data-usuario="' + nomeUrl + '">Editar</button>' +
      (u.ativo ? '<button type="button" class="cn-btn cn-mini" data-acao="link" data-usuario="' + nomeUrl + '">Link de senha</button>' : '') +
      (u.totp.ativo ? '<button type="button" class="cn-btn cn-mini" data-acao="zerar-2fa" data-usuario="' + nomeUrl + '">Zerar 2FA</button>' : '') +
      '<button type="button" class="cn-btn cn-mini" data-acao="sessoes" data-usuario="' + nomeUrl + '">Sessões</button>' +
      (u.ativo ? '<button type="button" class="cn-btn cn-mini cn-perigo" data-acao="desativar" data-usuario="' + nomeUrl + '">Desativar</button>'
        : '<button type="button" class="cn-btn cn-mini" data-acao="reativar" data-usuario="' + nomeUrl + '">Reativar</button>') +
      '</div><div class="cn-detalhe" data-detalhe="' + nomeUrl + '"></div>';
    if (aberto === 'editar') h += htmlFormEditar(u, agentes);
    return h + '</li>';
  }

  function htmlFormEditar(u, agentes) {
    return '<form class="cn-form" data-form="editar" data-usuario="' + esc(u.usuario) + '">' +
      '<label>Nome</label><input type="text" name="nome" value="' + esc(u.nome) + '" maxlength="80">' +
      '<label>E-mail</label><input type="email" name="email" value="' + esc(u.email) + '" maxlength="120">' +
      '<label>Perfil</label><select name="papel"><option value="funcionario"' + (u.papel === 'funcionario' ? ' selected' : '') + '>Funcionário</option><option value="ti"' + (u.papel === 'ti' ? ' selected' : '') + '>TI</option></select>' +
      '<label>Agentes liberados (só para funcionário)</label>' + checksAgentes(agentes, u.agentes) +
      '<div class="cn-acoes"><button type="submit" class="cn-btn cn-forte">Salvar</button><button type="button" class="cn-btn" data-acao="cancelar-edicao">Cancelar</button></div></form>';
  }

  function htmlFormNovo(agentes) {
    return '<form class="cn-form" data-form="novo">' +
      '<label for="cnNUsuario">Usuário (letras minúsculas, números, ponto, traço)</label><input id="cnNUsuario" type="text" name="usuario" maxlength="64" autocomplete="off" autocapitalize="none" required>' +
      '<label for="cnNNome">Nome</label><input id="cnNNome" type="text" name="nome" maxlength="80">' +
      '<label for="cnNEmail">E-mail</label><input id="cnNEmail" type="email" name="email" maxlength="120">' +
      '<label for="cnNPapel">Perfil</label><select id="cnNPapel" name="papel"><option value="funcionario">Funcionário (vê só os agentes liberados)</option><option value="ti">TI (vê tudo)</option></select>' +
      '<label>Agentes liberados (só para funcionário)</label>' + checksAgentes(agentes, []) +
      '<button type="submit" class="cn-btn cn-forte">Criar e gerar o link de senha</button></form>';
  }

  function htmlLista(usuarios, agentes) {
    if (!usuarios.length) return '<p class="cn-vazio">Nenhum usuário ainda. Crie o primeiro com o formulário acima ou com: dgclaw usuario criar</p>';
    return '<ul class="cn-lista cn-duas">' + usuarios.map(u => htmlUsuario(u, agentes)).join('') + '</ul>';
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-cn-tour="titulo"]', titulo: 'Usuários',
        oque: 'A lista de quem entra neste painel, com o perfil de cada um e quais agentes enxerga.',
        como: 'Tudo vem do arquivo de usuários do servidor. O TI cria, muda e desativa daqui; cada mudança fica na auditoria.',
        porque: 'Numa empresa cada pessoa tem o seu agente e não pode ver o do colega. O TI é quem decide isso.' },
    ],
    novo: [
      { alvo: '[data-cn-tour="novo"]', titulo: 'Criar usuário',
        oque: 'Escolha o usuário, o perfil e, para funcionário, os agentes que ele pode ver.',
        como: 'O servidor cria a conta sem senha e devolve um link de uso único (vale 24 horas). A pessoa abre o link e cadastra a própria senha.',
        porque: 'Você nunca sabe nem digita a senha de ninguém: não há senha para vazar no caminho.' },
    ],
    lista: [
      { alvo: '[data-cn-tour="lista"]', titulo: 'Os usuários',
        oque: 'Um cartão por pessoa: perfil, se está ativa, se tem segundo fator e quando entrou pela última vez.',
        como: 'Link de senha troca a senha esquecida. Zerar 2FA vale para quem perdeu o celular. Desativar encerra as sessões na hora e não apaga o histórico. Não dá para desativar o último TI.',
        porque: 'Quem sai da empresa perde o acesso no mesmo minuto, e o TI nunca fica trancado para fora.' },
    ],
  };

  const puros = { PASSOS, PAPEL, htmlLink, htmlUsuario, htmlLista, htmlFormNovo, htmlFormEditar };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null;
  let dados = { usuarios: [], agentes_disponiveis: [] };
  let linkVisivel = null;

  const q = (s) => raizEl.querySelector(s);
  function status(msg, erro) {
    const s = q('#cnStatus');
    s.textContent = msg || '';
    s.className = 'cn-status' + (erro ? ' cn-erro' : (msg ? ' cn-ok' : ''));
  }
  const falhou = (e) => status(e.message, true);
  const caminho = (u) => '/api/v1/usuarios/' + encodeURIComponent(u);

  function tela() {
    return '<div class="cn-tela"><header class="cn-cab" data-cn-tour="titulo"><h1>Usuários</h1>' +
      '<button type="button" class="cn-btn" data-cn-tutorial="pagina">Tutorial</button></header>' +
      '<p id="cnStatus" class="cn-status" role="status" aria-live="polite"></p><div id="cnLink"></div>' +
      '<section class="cn-sec" data-cn-tour="novo"><h2>Novo usuário <button type="button" class="cn-ajuda" data-cn-tutorial="novo" aria-label="Ajuda sobre criar usuário">?</button></h2><div id="cnNovo"></div></section>' +
      '<section class="cn-sec" data-cn-tour="lista"><h2>Quem entra aqui <button type="button" class="cn-ajuda" data-cn-tutorial="lista" aria-label="Ajuda sobre a lista">?</button></h2><div id="cnLista"></div></section></div>';
  }

  function pinta(editando) {
    q('#cnNovo').innerHTML = htmlFormNovo(dados.agentes_disponiveis);
    q('#cnLink').innerHTML = linkVisivel ? htmlLink(linkVisivel) : '';
    const lista = q('#cnLista');
    lista.innerHTML = htmlLista(dados.usuarios, dados.agentes_disponiveis);
    if (editando) {
      const li = lista.querySelector('li[data-usuario="' + (window.CSS && CSS.escape ? CSS.escape(editando) : editando) + '"]');
      const u = dados.usuarios.find(x => x.usuario === editando);
      if (li && u) li.insertAdjacentHTML('beforeend', htmlFormEditar(u, dados.agentes_disponiveis));
    }
  }

  async function carrega(editando) {
    try {
      dados = await C.api('GET', '/api/v1/usuarios');
      pinta(editando);
    } catch (e) { falhou(e); }
  }

  function corpoDoForm(form) {
    const fd = new FormData(form);
    const corpo = {};
    for (const [k, v] of fd.entries()) { if (k !== 'agentes') corpo[k] = v; }
    corpo.agentes = fd.getAll('agentes');
    return corpo;
  }

  async function enviar(form) {
    status('');
    try {
      if (form.dataset.form === 'novo') {
        const r = await C.api('POST', '/api/v1/usuarios', corpoDoForm(form));
        linkVisivel = { usuario: r.usuario.usuario, link: r.link, link_expira_em: r.link_expira_em };
        status('Usuário ' + r.usuario.usuario + ' criado.');
        await carrega();
      } else if (form.dataset.form === 'editar') {
        const u = form.dataset.usuario;
        const r = await C.api('PATCH', caminho(u), corpoDoForm(form));
        status(r.mudou ? 'Dados de ' + u + ' salvos.' : 'Nada mudou.');
        await carrega();
      }
    } catch (e) { falhou(e); }
  }

  async function clique(b) {
    const acao = b.dataset.acao; const u = b.dataset.usuario;
    status('');
    try {
      if (acao === 'editar') { await carrega(u); }
      else if (acao === 'cancelar-edicao') { await carrega(); }
      else if (acao === 'copiar-link') { await C.copiar(b.dataset.link, b); }
      else if (acao === 'link') {
        const r = await C.api('POST', caminho(u) + '/link', {});
        linkVisivel = { usuario: u, link: r.link, link_expira_em: r.link_expira_em };
        pinta(); status('Link novo gerado para ' + u + '. O anterior deixou de valer.');
      } else if (acao === 'zerar-2fa') {
        if (!confirm('Zerar o segundo fator de ' + u + '? Ele será desconectado e vai ativar de novo no próximo login.')) return;
        const r = await C.api('POST', caminho(u) + '/zerar-2fa', {});
        status('2FA de ' + u + ' zerado; ' + r.sessoes_encerradas + ' sessão(ões) encerrada(s).');
        await carrega();
      } else if (acao === 'desativar') {
        if (!confirm('Desativar ' + u + '? As sessões dele são encerradas agora.')) return;
        await C.api('DELETE', caminho(u));
        status(u + ' desativado.'); await carrega();
      } else if (acao === 'reativar') {
        await C.api('PATCH', caminho(u), { ativo: true });
        status(u + ' reativado. Se ele esqueceu a senha, gere um link.'); await carrega();
      } else if (acao === 'sessoes') {
        const d = await C.api('GET', caminho(u) + '/sessoes');
        const alvo = raizEl.querySelector('[data-detalhe="' + (window.CSS && CSS.escape ? CSS.escape(u) : u) + '"]');
        alvo.innerHTML = C.htmlSessoes(d.sessoes, { botao: 'Encerrar' }) +
          (d.sessoes.length ? '<div class="cn-acoes"><button type="button" class="cn-btn cn-mini cn-perigo" data-acao="encerrar-todas" data-usuario="' + C.esc(u) + '">Encerrar todas</button></div>' : '');
      } else if (acao === 'sair-sessao') {
        const dono = b.closest('li[data-usuario]').dataset.usuario;
        await C.api('DELETE', caminho(dono) + '/sessoes?id=' + encodeURIComponent(b.dataset.id));
        status('Sessão encerrada.');
        b.closest('li[data-usuario]').querySelector('[data-acao="sessoes"]').click();
      } else if (acao === 'encerrar-todas') {
        const r = await C.api('DELETE', caminho(u) + '/sessoes');
        status(r.encerradas + ' sessão(ões) de ' + u + ' encerrada(s).');
        b.closest('li[data-usuario]').querySelector('[data-detalhe]').innerHTML = '';
      }
    } catch (e) { falhou(e); }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.novo, PASSOS.lista) : PASSOS[chave];
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
    const el = document.getElementById('usuariosRaiz');
    if (el) montar(el);
  }

  return Object.assign({ montar, registra }, puros);
});
