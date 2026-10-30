// tela.js: a aba Tela.
//
// O QUE ELA É: o navegador do agente (um Chrome que roda dentro do container dele), aberto
// aqui dentro do painel. O dono entra nos sistemas que o agente vai usar (banco, e-mail,
// plataforma de anúncios) e faz o login com as próprias mãos. Depois o agente usa esse mesmo
// navegador, já logado. A senha do dono não passa pela conversa e não fica guardada no agente.
//
// A aba é desenhada inteira por este arquivo (o mesmo padrão do socorro.js e do cofre.js) e
// se pendura sozinha no botão do menu.
//
// O CAMINHO DO WEBSOCKET É CALCULADO DA URL DA PÁGINA, e não de uma configuração. O painel pode
// estar na raiz (/), atrás de um prefixo (/agente/ana/painel) ou atrás do DG Claw Web
// (/p/<agente>), e só a URL que o navegador está usando sabe qual é. O noVNC recebe esse
// caminho no parâmetro `path`, relativo ao host e SEM a barra do começo.

(function () {
  const BASE = window.DGCLAW_BASE || '';
  const ESPERA_SONDA_MS = 8000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * A conta dos caminhos a partir de location.pathname.
   *   "/"                         -> prefixo ""            path "tela/websockify"
   *   "/p/ana/"                   -> prefixo "/p/ana"      path "p/ana/tela/websockify"
   *   "/agente/ana/painel/"       -> prefixo "/agente/ana/painel"
   *   "/p/ana/index.html"         -> igual a "/p/ana/"
   */
  function contaDosCaminhos(pathname) {
    const prefixo = String(pathname || '/').replace(/\/index\.html$/, '').replace(/\/+$/, '');
    const websockify = `${prefixo}/tela/websockify`;
    const params = `path=${encodeURIComponent(websockify.replace(/^\//, ''))}&autoconnect=1&resize=scale`;
    return {
      prefixo,
      websockify,
      path: websockify.replace(/^\//, ''),
      novnc: `${prefixo}/tela/novnc/vnc.html?${params}`,
    };
  }

  // ─── Tutorial ─────────────────────────────────────────────────

  function passosDoTutorial() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'O navegador do seu agente, na sua frente',
        corpo: 'Aqui você vê o navegador que o agente usa. Faça login nos sistemas que ele vai usar: ele usa esse mesmo navegador, já logado, e a sua senha nunca passa pela conversa.',
        porque: 'Entregar uma senha ao agente numa mensagem a deixa gravada na conversa. Fazendo o login você mesmo, na tela, o sistema só guarda o "estou logado" no navegador, e a senha fica com você.',
      },
      {
        chave: 'status',
        alvo: '#tela-status',
        titulo: 'Está tudo pronto?',
        corpo: 'Três verificações: a tela está instalada neste agente, a senha da tela já foi definida, e o navegador do agente está de pé. Cada linha diz sim ou não e, quando é não, o que fazer. O que o painel não conseguiu verificar aparece como "não consegui ver", e não como "não".',
        porque: 'Se a tela não abre, a causa quase sempre é uma destas três. Mostrar as três de uma vez poupa você de adivinhar qual faltou.',
      },
      {
        chave: 'abrir',
        alvo: '#tela-abrir',
        titulo: 'Abrir a tela',
        corpo: 'O botão abre o navegador do agente aqui embaixo. O painel primeiro testa a ligação por até 8 segundos; se a conexão passar, a tela aparece e pede a senha da tela. Se o endereço que você usa não deixa a conexão passar, o painel avisa e mostra o endereço alternativo, quando existir.',
        porque: 'A tela usa uma conexão contínua (WebSocket), e alguns endereços de acesso não a deixam passar. Testar antes evita uma tela preta sem explicação.',
      },
      {
        chave: 'senha',
        alvo: '#tela-senha',
        titulo: 'A senha da tela',
        corpo: 'É a segunda porta: além de entrar no painel, quem abre a tela precisa dessa senha. Tem de 6 a 8 caracteres, porque o VNC (o programa que mostra a tela) só olha os 8 primeiros; o painel recusa mais que isso em vez de cortar sem avisar. Trocar a senha desconecta quem estiver vendo a tela agora.',
        porque: 'O navegador do agente fica logado nos seus sistemas, então abrir a tela é quase como sentar no seu computador. Duas senhas, a do painel e a da tela, protegem isso mesmo se uma delas vazar.',
      },
    ];
  }

  function abrirTutorial(comecarEm) {
    if (window.DGTutorial) window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  // ─── Estado e chamadas ────────────────────────────────────────

  let estado = null;      // resposta do GET /api/tela, ou { erro }
  let aviso = null;       // { tipo: 'ok'|'erro', texto } do formulário de senha
  let sonda = null;       // WebSocket de teste em andamento
  let relogioSonda = null;
  let abrindo = false;

  function raiz() { return document.getElementById('tela-root'); }

  async function chamar(url, opcoes) {
    let res;
    try {
      res = await fetch(BASE + url, opcoes);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* sem json: o status diz o que houve */ }
    return { ok: res.ok, status: res.status, corpo };
  }

  function motivoDoErro(r) {
    const c = r.corpo || {};
    if (c.error && c.howToFix) return `${c.error} ${c.howToFix}`;
    return c.error || `O painel respondeu ${r.status}.`;
  }

  // ─── Desenho ──────────────────────────────────────────────────

  function cabecalho() {
    const ajuda = 'O navegador do seu agente, para você fazer login nos sistemas que ele vai usar.';
    return `<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(ajuda)}">Tela</h2>
          <button type="button" class="app-tutorial-abrir" id="tela-tutorial-abrir"
                  title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="tela"
                  aria-label="Para que serve a tela" title="Para que serve a tela">?</button>
        </div>
        <p>${esc(ajuda)} Ele usa esse mesmo navegador, já logado, e a sua senha nunca passa pela conversa.</p>
      </div>
      <div id="tela-corpo"></div>`;
  }

  function linhaStatus(rotulo, valor, bom, detalhe) {
    const selo = valor === null ? 'nd' : (bom ? 'sim' : 'nao');
    const texto = valor === null ? 'não consegui ver' : (bom ? 'sim' : 'não');
    return `<li class="tela-linha"><span class="tela-selo ${selo}">${texto}</span>
        <span class="tela-rotulo"><b>${esc(rotulo)}</b>${detalhe ? `<span class="tela-detalhe">${esc(detalhe)}</span>` : ''}</span></li>`;
  }

  function blocoStatus() {
    const s = estado;
    let corpo;
    if (!s || s.erro) {
      corpo = `<div class="app-erro"><strong>Não consegui ver o estado da tela.</strong><p>${esc(s ? s.erro : 'sem resposta')}</p></div>`;
    } else {
      corpo = `<ul class="tela-lista">
        ${linhaStatus('Tela instalada', s.instalada, s.instalada, s.instalada ? '' : 'o serviço da tela não respondeu neste agente')}
        ${linhaStatus('Senha da tela definida', s.senha_definida, s.senha_definida, s.senha_definida ? '' : 'defina uma abaixo para poder abrir a tela')}
        ${linhaStatus('Navegador do agente respondendo', s.cdp, s.cdp, s.cdp ? '' : 'o agente ainda não consegue usar o navegador')}
      </ul>
      ${s.instalada ? '' : `<div class="app-erro tela-sem-tela"><strong>Este agente ainda não tem tela.</strong>
        <p>Ela vem na imagem com navegador; peça a quem instalou para recriar o agente com a tela.</p></div>`}`;
    }
    return `<div class="cartao" id="tela-status">
        <div class="section-title">Situação
          <button type="button" class="app-ajuda-secao" data-tutorial="status"
                  aria-label="O que a situação mostra" title="O que a situação mostra">?</button>
        </div>${corpo}</div>`;
  }

  function blocoAbrir() {
    const s = estado || {};
    const pronto = s.instalada && s.senha_definida;
    let motivo = '';
    if (!s.instalada) motivo = 'A tela não está instalada neste agente.';
    else if (!s.senha_definida) motivo = 'Defina a senha da tela primeiro (formulário abaixo).';
    return `<div class="cartao" id="tela-abrir">
        <div class="section-title">Abrir a tela
          <button type="button" class="app-ajuda-secao" data-tutorial="abrir"
                  aria-label="Como a tela abre" title="Como a tela abre">?</button>
        </div>
        <div class="tela-botoes">
          <button type="button" class="btn-principal" id="tela-abrir-btn" ${pronto && !abrindo ? '' : 'disabled'}
                  title="${esc(motivo || 'Testa a ligação e abre o navegador do agente aqui embaixo.')}">Abrir a tela</button>
          <button type="button" class="btn-leve" id="tela-fechar-btn" hidden
                  title="Fecha a tela aqui. O navegador do agente continua ligado, com os seus logins.">Fechar a tela</button>
        </div>
        ${motivo ? `<p class="tela-nota">${esc(motivo)}</p>` : ''}
        <div id="tela-resultado" role="status"></div>
        <div id="tela-janela"></div>
      </div>`;
  }

  function blocoSenha() {
    const definida = !!(estado && estado.senha_definida);
    const titulo = definida ? 'Trocar a senha da tela' : 'Definir a senha da tela';
    const aviso_ = aviso
      ? `<div class="${aviso.tipo === 'ok' ? 'cofre-ok' : 'app-erro'} tela-aviso"><p>${esc(aviso.texto)}</p></div>` : '';
    return `<div class="cartao" id="tela-senha">
        <div class="section-title">${titulo}
          <button type="button" class="app-ajuda-secao" data-tutorial="senha"
                  aria-label="Sobre a senha da tela" title="Sobre a senha da tela">?</button>
        </div>
        <p class="tela-nota">Use de 6 a 8 caracteres, com letras sem acento, números e símbolos do teclado.
          O VNC, o programa que mostra a tela, só usa 8 caracteres, então o painel não aceita mais que isso.
          ${definida ? '<b>Trocar a senha desconecta quem estiver vendo a tela agora.</b>' : ''}</p>
        ${aviso_}
        <form id="tela-form-senha" autocomplete="off">
          <div class="tela-campo"><label for="tela-senha-nova">${definida ? 'Senha nova' : 'Senha da tela'}</label>
            <input type="password" id="tela-senha-nova" autocomplete="new-password" minlength="6" required spellcheck="false"></div>
          <div class="tela-campo"><label for="tela-senha-repetir">Repita a senha</label>
            <input type="password" id="tela-senha-repetir" autocomplete="new-password" minlength="6" required spellcheck="false"></div>
          <button type="submit" class="btn-principal" id="tela-senha-enviar">${definida ? 'Trocar a senha' : 'Definir a senha'}</button>
        </form>
      </div>`;
  }

  // Três vagas fixas. A de "Abrir" só é redesenhada quando não há tela aberta: mover um iframe
  // no documento o recarrega, e isso desconectaria quem está usando a tela.
  function desenhar() {
    const corpo = document.getElementById('tela-corpo');
    if (!corpo) return;
    if (!document.getElementById('tela-vaga-status')) {
      corpo.innerHTML = '<div id="tela-vaga-status"></div><div id="tela-vaga-abrir"></div><div id="tela-vaga-senha"></div>';
    }
    document.getElementById('tela-vaga-status').innerHTML = blocoStatus();
    document.getElementById('tela-vaga-senha').innerHTML = blocoSenha();
    const vagaAbrir = document.getElementById('tela-vaga-abrir');
    if (!vagaAbrir.querySelector('iframe')) vagaAbrir.innerHTML = blocoAbrir();
    ligarCorpo();
  }

  function ligarCorpo() {
    // `_ligado` evita empilhar ouvintes nos botões da vaga "Abrir", que nem sempre é redesenhada.
    const uma = (el, evento, fn) => { if (el && !el._ligado) { el._ligado = true; el.addEventListener(evento, fn); } };
    document.querySelectorAll('#tela-corpo .app-ajuda-secao[data-tutorial]').forEach((el) => {
      uma(el, 'click', () => abrirTutorial(el.dataset.tutorial));
    });
    uma(document.getElementById('tela-abrir-btn'), 'click', abrirTela);
    uma(document.getElementById('tela-fechar-btn'), 'click', fecharTela);
    const form = document.getElementById('tela-form-senha');
    uma(form, 'submit', enviarSenha);
  }

  // ─── Abrir e fechar ───────────────────────────────────────────

  function mostrarResultado(html) {
    const el = document.getElementById('tela-resultado');
    if (el) el.innerHTML = html;
  }

  function limparSonda() {
    clearTimeout(relogioSonda);
    if (sonda) {
      sonda.onopen = sonda.onerror = sonda.onclose = null;
      try { sonda.close(); } catch { /* já fechada */ }
      sonda = null;
    }
  }

  function falhouConexao() {
    limparSonda();
    abrindo = false;
    const ext = estado && estado.url_externa;
    if (ext && /^https?:\/\//i.test(ext)) {
      mostrarResultado(`<div class="app-erro"><strong>Este endereço não deixa a tela passar.</strong>
        <p>Abra a tela em outra aba:</p>
        <p><a href="${esc(ext)}" target="_blank" rel="noopener">${esc(ext)}</a></p></div>`);
    } else {
      mostrarResultado(`<div class="app-erro"><strong>A conexão da tela não abriu em 8 segundos.</strong>
        <p>Pode ser que o endereço que você está usando não deixe passar a conexão contínua que a tela precisa,
        que a sua sessão no painel tenha vencido (recarregue a página e entre de novo), ou que o serviço da tela
        tenha caído. Este painel não tem um endereço alternativo configurado: peça a quem instalou para configurar
        um, ou para conferir o serviço da tela.</p></div>`);
    }
    const botao = document.getElementById('tela-abrir-btn');
    if (botao) botao.disabled = false;
  }

  // Testa o WebSocket ANTES de montar o iframe: o noVNC, quando falha, mostra uma tela preta
  // com um aviso pequeno, e a pessoa não saberia o que fazer. A sonda abre e fecha na hora.
  function abrirTela() {
    if (abrindo) return;
    abrindo = true;
    limparSonda();
    const c = contaDosCaminhos(window.location.pathname);
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    mostrarResultado('<p class="tela-nota">Testando a ligação com a tela...</p>');
    const botao = document.getElementById('tela-abrir-btn');
    if (botao) botao.disabled = true;
    try {
      sonda = new WebSocket(`${proto}//${window.location.host}${c.websockify}`);
    } catch (e) {
      falhouConexao();
      return;
    }
    relogioSonda = setTimeout(falhouConexao, ESPERA_SONDA_MS);
    sonda.onopen = () => {
      limparSonda();
      abrindo = false;
      montarJanela(c.novnc);
    };
    sonda.onerror = falhouConexao;
    sonda.onclose = falhouConexao;
  }

  function montarJanela(url) {
    mostrarResultado('');
    const janela = document.getElementById('tela-janela');
    if (!janela) return;
    janela.innerHTML = `<iframe class="tela-iframe" src="${esc(url)}" title="Tela do navegador do agente" allow="clipboard-read; clipboard-write"></iframe>`;
    const fechar = document.getElementById('tela-fechar-btn');
    if (fechar) fechar.hidden = false;
    const botao = document.getElementById('tela-abrir-btn');
    if (botao) botao.disabled = false;
  }

  function fecharTela() {
    const janela = document.getElementById('tela-janela');
    if (janela) janela.innerHTML = '';
    const fechar = document.getElementById('tela-fechar-btn');
    if (fechar) fechar.hidden = true;
    mostrarResultado('');
  }

  // ─── Senha ────────────────────────────────────────────────────

  async function enviarSenha(ev) {
    ev.preventDefault();
    const a = document.getElementById('tela-senha-nova');
    const b = document.getElementById('tela-senha-repetir');
    const senha = a.value;
    if (senha !== b.value) {
      aviso = { tipo: 'erro', texto: 'As duas senhas não são iguais. Digite de novo nos dois campos.' };
      desenhar();
      return;
    }
    if (senha.length > 8) {
      aviso = { tipo: 'erro', texto: `A senha tem ${senha.length} caracteres e o máximo é 8: o VNC, o programa que mostra a tela, só olha os 8 primeiros e ignoraria o resto. Escolha uma senha de 6 a 8 caracteres.` };
      desenhar();
      return;
    }
    const botao = document.getElementById('tela-senha-enviar');
    if (botao) botao.disabled = true;
    const r = await chamar('/api/tela/senha', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    // O que a pessoa digitou sai da tela de qualquer jeito.
    a.value = ''; b.value = '';
    if (!r.ok) {
      aviso = { tipo: 'erro', texto: motivoDoErro(r) };
      desenhar();
      return;
    }
    aviso = { tipo: 'ok', texto: `Senha da tela gravada. ${(r.corpo.aviso || '').replace(/^./, (x) => x.toUpperCase())}.` };
    await atualizar();
  }

  // ─── Carregar ─────────────────────────────────────────────────

  async function atualizar() {
    const r = await chamar('/api/tela');
    estado = r.ok ? r.corpo : { erro: motivoDoErro(r) };
    desenhar();
  }

  async function carregar() {
    const el = raiz();
    if (!el) return;
    el.innerHTML = cabecalho();
    const t = document.getElementById('tela-tutorial-abrir');
    if (t) t.addEventListener('click', () => abrirTutorial(0));
    document.querySelectorAll('#tela-root .app-cabeca .app-ajuda-secao[data-tutorial]')
      .forEach((b) => b.addEventListener('click', () => abrirTutorial(b.dataset.tutorial)));
    const corpo = document.getElementById('tela-corpo');
    if (corpo) corpo.innerHTML = '<div class="app-carregando">Carregando...</div>';
    await atualizar();
  }

  // ─── A aba se pendura sozinha no menu (ver socorro.js) ────────
  const EXPLICACAO = 'O navegador do seu agente, aberto aqui dentro. Faça login nos sistemas que ele vai usar: '
    + 'ele usa esse mesmo navegador, já logado, e a sua senha nunca passa pela conversa.';
  const SUBTITULO = 'o navegador do agente, para você fazer login';

  function pendurar() {
    const aba = document.querySelector('.tab[data-tab="tela"]');
    if (!aba || aba._tela) return;
    aba._tela = true;
    aba.title = EXPLICACAO;
    let carregou = false;
    aba.addEventListener('click', () => {
      setTimeout(() => {
        const sub = document.getElementById('subtitulo-aba');
        if (sub) sub.textContent = SUBTITULO;
      }, 0);
      if (!carregou) { carregou = true; carregar(); } else atualizar();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pendurar);
  else pendurar();

  window.DGTela = { carregar, abrirTutorial, passosDoTutorial, contaDosCaminhos };
})();
