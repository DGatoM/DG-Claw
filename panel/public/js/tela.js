const dgBindFull_tela = (el, fonte, atributo, valores) => { if(globalThis.DGI18n) return globalThis.DGI18n.rotulo(el,fonte,atributo,valores); const valor=String(fonte).replace(/\{([a-z_][a-z_0-9]*)\}/g,(m,k)=>valores&&Object.hasOwn(valores,k)?String(valores[k]):m); if(atributo)el.setAttribute(atributo,valor);else el.textContent=valor; };
const dgHtmlFull_tela = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_tela = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_tela = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);
const dgFragFull_tela = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : dgPhraseFull_tela(fonte,valores).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

const dgTexto_tela = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgHtml_tela = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
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
    const params = `path=${encodeURIComponent(websockify.replace(/^\//, ''))}&autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000`;
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
        corpo: 'Três verificações: a tela está instalada neste agente, a senha da tela já foi definida, e o navegador do agente está de pé. Cada linha diz sim ou não e, embaixo, uma caixa explica o que houve e o que fazer. O que o painel não conseguiu verificar aparece como "não consegui ver", e não como "não".',
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
  let carregou = false;   // a aba já foi desenhada uma vez
  let esperandoVnc = false; // depois de gravar a primeira senha, espera o x11vnc subir para abrir a tela

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
    return c.error || dgPhraseFull_tela("O painel respondeu {v0}.",{v0:(r.status)});
  }

  // ─── Desenho ──────────────────────────────────────────────────

  function cabecalho() {
    const ajuda = dgTextFull_tela("O navegador do seu agente, para você fazer login nos sistemas que ele vai usar.");
    return dgHtmlFull_tela(`<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(ajuda)}"><!--dg-i18n:2d31efc9c2ed-->Tela<!--/dg-i18n--></h2>
          <button type="button" class="app-tutorial-abrir" id="tela-tutorial-abrir"
                  data-dg-i18n-title="0fb8e9479f21" title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="tela"
                  aria-label="Para que serve a tela" title="Para que serve a tela">?</button>
        </div>
        <p>${dgFragFull_tela("{v1} Ele usa esse mesmo navegador, já logado, e a sua senha nunca passa pela conversa.",{v1:(ajuda)})}</p>
      </div>
      <div id="tela-corpo"></div>`);
  }

  function linhaStatus(rotulo, valor, bom, detalhe) {
    const selo = valor === null ? 'nd' : (bom ? 'sim' : 'nao');
    const texto = valor === null ? dgTextFull_tela("não consegui ver") : (bom ? 'sim' : dgTextFull_tela("não"));
    return `<li class="tela-linha"><span class="tela-selo ${selo}">${texto}</span>
        <span class="tela-rotulo"><b>${esc(rotulo)}</b>${detalhe ? `<span class="tela-detalhe">${esc(detalhe)}</span>` : ''}</span></li>`;
  }

  // A tela só faz sentido com a senha definida: sem ela o x11vnc nem sobe, e o noVNC abriria
  // para uma falha de conexão sem explicação. Então a aba abre direto no formulário.
  function precisaDefinirSenha(s) {
    return !!(s && !s.erro && s.senha_definida === false);
  }

  function blocoProblemas(s) {
    const lista = (s && Array.isArray(s.problemas)) ? s.problemas : [];
    if (!lista.length) return '';
    const itens = lista.map((p) => `<li class="tela-problema ${p.nivel === 'aviso' ? 'aviso' : 'erro'}">
        <strong>${esc(p.texto)}</strong><p>${esc(p.como_resolver)}</p></li>`).join('');
    return `<ul class="tela-problemas">${itens}</ul>`;
  }

  function blocoStatus() {
    const s = estado;
    let corpo;
    if (!s || s.erro) {
      corpo = dgHtmlFull_tela(`<div class="app-erro"><strong><!--dg-i18n:32dbd86f9037-->Não consegui ver o estado da tela.<!--/dg-i18n--></strong><p>${esc(s ? s.erro : dgTextFull_tela("sem resposta"))}</p></div>`);
    } else {
      corpo = `<ul class="tela-lista">
        ${linhaStatus('Tela instalada', s.instalada, s.instalada, s.instalada ? '' : dgTextFull_tela("o serviço da tela não respondeu neste agente"))}
        ${linhaStatus(dgTextFull_tela("Senha da tela definida"), s.senha_definida, s.senha_definida, s.senha_definida ? '' : dgTextFull_tela("defina uma abaixo para poder abrir a tela"))}
        ${linhaStatus('Navegador do agente respondendo', s.cdp, s.cdp, s.cdp ? '' : dgTextFull_tela("o agente ainda não consegue usar o navegador"))}
      </ul>
      ${blocoProblemas(s)}`;
    }
    return dgHtmlFull_tela(`<div class="cartao" id="tela-status">
        <div class="section-title"><!--dg-i18n:cf7d46ded085-->Situação<!--/dg-i18n-->
          <button type="button" class="app-ajuda-secao" data-tutorial="status"
                  data-dg-i18n-aria-label="9d279e9ebb49" aria-label="O que a situação mostra" data-dg-i18n-title="9d279e9ebb49" title="O que a situação mostra">?</button>
        </div>${corpo}</div>`);
  }

  function blocoAbrir() {
    const s = estado || {};
    if (precisaDefinirSenha(s)) return '';
    const pronto = s.instalada && s.senha_definida;
    let motivo = '';
    if (!s.instalada) motivo = dgTextFull_tela("A tela não está instalada neste agente.");
    else if (!s.senha_definida) motivo = dgTextFull_tela("Defina a senha da tela primeiro (formulário abaixo).");
    return dgHtmlFull_tela(`<div class="cartao" id="tela-abrir">
        <div class="section-title"><!--dg-i18n:b7eb5772320f-->Abrir a tela<!--/dg-i18n-->
          <button type="button" class="app-ajuda-secao" data-tutorial="abrir"
                  aria-label="Como a tela abre" title="Como a tela abre">?</button>
        </div>
        <div class="tela-botoes">
          <button type="button" class="btn-principal" id="tela-abrir-btn" ${pronto && !abrindo ? '' : 'disabled'}
                  title="${esc(motivo || dgTextFull_tela("Testa a ligação e abre o navegador do agente aqui embaixo."))}"><!--dg-i18n:b7eb5772320f-->Abrir a tela<!--/dg-i18n--></button>
          <button type="button" class="btn-leve" id="tela-fechar-btn" hidden
                  data-dg-i18n-title="dcdbe7e90ed3" title="Fecha a tela aqui. O navegador do agente continua ligado, com os seus logins."><!--dg-i18n:650113c7b61e-->Fechar a tela<!--/dg-i18n--></button>
        </div>
        ${motivo ? `<p class="tela-nota">${esc(motivo)}</p>` : ''}
        <div id="tela-resultado" role="status"></div>
        <div id="tela-janela"></div>
      </div>`);
  }

  function blocoSenha() {
    const definida = !!(estado && estado.senha_definida);
    const titulo = definida ? dgTextFull_tela("Trocar a senha da tela") : dgTextFull_tela("Defina a senha da tela");
    const porque = definida ? '' : dgHtmlFull_tela(`<div class="tela-primeira" id="tela-primeira-senha"><p><b><!--dg-i18n:0808752423cb-->Falta só isto para abrir a tela.<!--/dg-i18n--></b>
          <!--dg-i18n:4d1144365e41-->A tela do navegador do agente é protegida por uma senha própria, além do login do painel, porque ali você fica logado nos seus sistemas.
          Escolha uma agora (de 6 a 8 caracteres): depois de gravar, a tela abre sozinha.<!--/dg-i18n--></p></div>`);
    const aviso_ = aviso
      ? `<div class="${aviso.tipo === 'ok' ? 'cofre-ok' : 'app-erro'} tela-aviso"><p>${esc(aviso.texto)}</p></div>` : '';
    return dgHtmlFull_tela(`<div class="cartao" id="tela-senha">
        <div class="section-title">${titulo}
          <button type="button" class="app-ajuda-secao" data-tutorial="senha"
                  data-dg-i18n-aria-label="4634a4bb91a2" aria-label="Sobre a senha da tela" data-dg-i18n-title="4634a4bb91a2" title="Sobre a senha da tela">?</button>
        </div>
        ${porque}
        <p class="tela-nota"><!--dg-i18n:927434161c21-->Use de 6 a 8 caracteres, com letras sem acento, números e símbolos do teclado.
          O VNC, o programa que mostra a tela, só usa 8 caracteres, então o painel não aceita mais que isso.<!--/dg-i18n-->
          ${definida ? dgHtmlFull_tela(`<b><!--dg-i18n:7535b98a3ad6-->Trocar a senha desconecta quem estiver vendo a tela agora.<!--/dg-i18n--></b>`) : ''}</p>
        ${aviso_}
        <form id="tela-form-senha" autocomplete="off">
          <div class="tela-campo"><label for="tela-senha-nova">${dgFragFull_tela(definida ? 'Senha nova' : "Senha da tela")}</label>
            <input type="password" id="tela-senha-nova" autocomplete="new-password" minlength="6" required spellcheck="false"></div>
          <div class="tela-campo"><label for="tela-senha-repetir"><!--dg-i18n:d6df2bac4deb-->Repita a senha<!--/dg-i18n--></label>
            <input type="password" id="tela-senha-repetir" autocomplete="new-password" minlength="6" required spellcheck="false"></div>
          <button type="submit" class="btn-principal" id="tela-senha-enviar">${dgFragFull_tela(definida ? "Trocar a senha" : "Definir a senha")}</button>
        </form>
      </div>`);
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
    // Sem senha, o formulário vem antes de tudo; com senha, a ordem de sempre (situação, abrir, senha).
    const ordem = precisaDefinirSenha(estado) ? ['senha', 'status', 'abrir'] : ['status', 'abrir', 'senha'];
    const pai = document.getElementById('tela-corpo');
    // Só mexe na ordem quando ela mudou: mover o iframe no documento o recarregaria.
    if ([...pai.children].map((c) => c.id).join() !== ordem.map((v) => `tela-vaga-${v}`).join()) {
      ordem.forEach((v) => pai.appendChild(document.getElementById(`tela-vaga-${v}`)));
    }
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
      mostrarResultado(dgHtmlFull_tela(`<div class="app-erro"><strong><!--dg-i18n:5e389cada555-->Este endereço não deixa a tela passar.<!--/dg-i18n--></strong>
        <p><!--dg-i18n:d2f5687c5b22-->Abra a tela em outra aba:<!--/dg-i18n--></p>
        <p><a href="${esc(ext)}" target="_blank" rel="noopener">${esc(ext)}</a></p></div>`));
    } else {
      mostrarResultado(dgHtmlFull_tela(`<div class="app-erro"><strong><!--dg-i18n:c95691072213-->A conexão da tela não abriu em 8 segundos.<!--/dg-i18n--></strong>
        <p><!--dg-i18n:74288f0d1b67-->Pode ser que o endereço que você está usando não deixe passar a conexão contínua que a tela precisa,
        que a sua sessão no painel tenha vencido (recarregue a página e entre de novo), ou que o serviço da tela
        tenha caído. Este painel não tem um endereço alternativo configurado: peça a quem instalou para configurar
        um, ou para conferir o serviço da tela.<!--/dg-i18n--></p></div>`));
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
    mostrarResultado(dgHtmlFull_tela(`<p class="tela-nota"><!--dg-i18n:48b2ee40b1b4-->Testando a ligação com a tela...<!--/dg-i18n--></p>`));
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
    const primeira = precisaDefinirSenha(estado);
    aviso = primeira
      ? { tipo: 'ok', texto: 'Senha da tela gravada. Ligando a tela...' }
      : { tipo: 'ok', texto: `Senha da tela gravada. ${(r.corpo.aviso || '').replace(/^./, (x) => x.toUpperCase())}.` };
    await atualizar();
    if (primeira) await abrirQuandoOVncSubir();
  }

  // Na primeira senha o x11vnc ainda não tinha subido (a unidade espera o arquivo) e sobe logo
  // depois da gravação. O painel pergunta de novo a cada 1,5 s, por até 20 s, e abre a tela
  // sozinho quando ele responde; assim o dono não cai numa conexão que falha.
  async function abrirQuandoOVncSubir() {
    if (esperandoVnc) return;
    esperandoVnc = true;
    try {
      const ligando = () => mostrarResultado(dgHtmlFull_tela(`<p class="tela-nota"><!--dg-i18n:4b2e1f1df1fa-->Ligando a tela, só um instante...<!--/dg-i18n--></p>`));
      ligando();
      for (let i = 0; i < 14; i++) {
        if (estado && estado.vnc !== false) break;
        await new Promise((res) => setTimeout(res, 1500));
        const r = await chamar('/api/tela');
        if (r.ok) { estado = r.corpo; desenhar(); ligando(); }
      }
      if (estado && estado.vnc === false) {
        mostrarResultado(dgHtmlFull_tela(`<div class="app-erro"><strong><!--dg-i18n:ec8ba822f49d-->A tela ainda não ligou.<!--/dg-i18n--></strong>
          <p><!--dg-i18n:6d526f216992-->A senha foi gravada, mas o programa que mostra a tela não respondeu em 20 segundos. Atualize a página e clique em
          "Abrir a tela". Se continuar assim, peça ao Admin para rodar "dgclaw agente tela" com o nome deste agente.<!--/dg-i18n--></p></div>`));
        return;
      }
      abrirTela();
    } finally {
      esperandoVnc = false;
    }
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
    carregou = true;
    el.innerHTML = cabecalho();
    const t = document.getElementById('tela-tutorial-abrir');
    if (t) t.addEventListener('click', () => abrirTutorial(0));
    document.querySelectorAll('#tela-root .app-cabeca .app-ajuda-secao[data-tutorial]')
      .forEach((b) => b.addEventListener('click', () => abrirTutorial(b.dataset.tutorial)));
    const corpo = document.getElementById('tela-corpo');
    if (corpo) corpo.innerHTML = dgHtml_tela("<div class=\"app-carregando\"><!--dg-i18n:1258573b225a-->Carregando...<!--/dg-i18n--></div>");
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
    dgBindFull_tela(aba,EXPLICACAO,"title");
    // Quem carrega a aba na primeira vez é o loadPanel do app.js (clique ou link #aba=tela);
    // o clique seguinte só atualiza o estado.
    aba.addEventListener('click', () => {
      setTimeout(() => {
        const sub = document.getElementById('subtitulo-aba');
        if (sub) dgBindFull_tela(sub,SUBTITULO,undefined);
      }, 0);
      if (carregou) atualizar();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pendurar);
  else pendurar();

  // htmlDaAba: o que a aba desenharia para um estado, sem tocar no documento (usado pelos testes).
  function htmlDaAba(s) {
    const anterior = estado;
    estado = s;
    try {
      const semSenha = precisaDefinirSenha(s);
      return {
        primeiro: semSenha ? 'senha' : 'status',
        status: blocoStatus(),
        senha: blocoSenha(),
        abrir: blocoAbrir(),
      };
    } finally {
      estado = anterior;
    }
  }

  window.DGTela = { carregar, abrirTutorial, passosDoTutorial, contaDosCaminhos, htmlDaAba };
})();
