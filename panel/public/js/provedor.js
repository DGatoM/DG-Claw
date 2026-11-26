const dgReviewPanelUI_provedor = (s,p) => globalThis.DGI18n ? globalThis.DGI18n.frase(s,p) : s.replace(/\{([a-z_][a-z_0-9]*)\}/g,(m,k)=>p&&Object.hasOwn(p,k)?String(p[k]):m);
const dgHtmlFull_provedor = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_provedor = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_provedor = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);
const dgFragFull_provedor = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : dgPhraseFull_provedor(fonte,valores).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
const dgBindFull_provedor = (el, fonte, atributo, valores) => { if (globalThis.DGI18n) return globalThis.DGI18n.rotulo(el,fonte,atributo,valores); const valor=dgPhraseFull_provedor(fonte,valores); if(atributo) el.setAttribute(atributo,valor); else el.textContent=valor; };

const dgTexto_provedor = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgHtml_provedor = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
// provedor.js: o cartão "Modelo e autenticação" da aba Status e a janela "Trocar".
//
// O que o cartão mostra vem de GET /api/provedor (lib/provedores.js): a escolha que o
// agente tem agora, o que o próprio programa do Claude/Codex CONFIRMA (conferido), o
// catálogo de provedores e, para cada chave de API, apenas se ela está no Cofre. O valor
// de uma chave nunca chega aqui. A chave que a pessoa digita na janela sai direto no POST
// e é apagada do campo logo em seguida.
//
// Não depende de nenhum outro script do painel além de window.DGCLAW_BASE.

(function () {
  const BASE = window.DGCLAW_BASE || '';
  const RISCO_DOC = 'docs/RISCO-DE-BLOQUEIO-DE-CONTA.md';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const $ = (id) => document.getElementById(id);

  async function chamar(metodo, url, corpo) {
    const init = { method: metodo, headers: {} };
    if (corpo !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(corpo);
    }
    let res;
    try {
      res = await fetch(BASE + url, init);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: dgReviewPanelUI_provedor("Não alcancei o painel: {v0}",{v0:(e.message)}), howToFix: dgReviewPanelUI_provedor("Confira a internet e tente de novo.") } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let json = {};
    try { json = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo: json };
  }

  // Só abre em nova aba um link https: o runner é de confiança, mas o link vem de
  // um programa que escreve na tela o que o servidor do provedor mandou.
  const linkSeguro = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

  const TIP = {
    conferido: 'Como é calculado: o painel pergunta ao agente, e o agente pergunta ao próprio programa do Claude ou do Codex, '
      + 'se ele está logado e de que jeito (assinatura ou chave). Não é o que está anotado na configuração: é a resposta do programa, '
      + 'no momento indicado. Em amarelo, o que foi escolhido e o que o programa confirma não batem.',
  };

  let dados = null;
  let timerLogin = null;
  let ultimaChaveDoLogin = '';

  // ── o cartão ─────────────────────────────────────────────────────────────

  function quando(iso) {
    const t = Date.parse(iso || '');
    if (!t) return dgTextFull_provedor("conferido, sem hora registrada");
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return dgTextFull_provedor("conferido agora");
    const m = Math.round(s / 60);
    if (m < 60) return dgPhraseFull_provedor("conferido há {v0} min",{v0:(m)});
    const h = Math.round(m / 60);
    if (h < 48) return dgPhraseFull_provedor("conferido há {v0} h",{v0:(h)});
    return dgPhraseFull_provedor("conferido há {v0} dias",{v0:(Math.round(h / 24))});
  }

  function modoDe(d) {
    const p = d && d.catalogo && d.catalogo[d.provedor];
    return p && p.auth ? p.auth[d.auth] || null : null;
  }

  /** O que diverge, em amarelo: {texto, fazer} ou null. */
  function divergencia(d) {
    const modo = modoDe(d);
    const c = d.conferido;
    if (modo && modo.variavel && d.chaves && d.chaves[modo.variavel] === false) {
      return {
        texto: d.auth === 'api'
          ? 'configurado na API, mas a chave não está no Cofre'
          : 'configurado com código de acesso, mas o código não está no Cofre',
        fazer: 'Clique em Trocar e cole a chave de novo: ela fica guardada no Cofre e não aparece mais.',
      };
    }
    if (c && c.ok === false) {
      if (d.auth === 'assinatura') {
        return {
          texto: 'o agente não está logado na assinatura',
          fazer: 'Clique em "Conectar minha conta" e siga os passos que aparecem aqui.',
          detalhe: c.detalhe,
          curto: true,
        };
      }
      return {
        texto: d.auth === 'api' ? 'o programa não confirmou a chave de API' : 'o programa não confirmou o código de acesso',
        fazer: 'Clique em Trocar e cole a chave de novo. Se continuar, avise quem cuida do sistema.',
        detalhe: c.detalhe,
      };
    }
    if (!c) return { texto: 'ainda não foi possível conferir', fazer: 'Recarregue a página em um minuto.' };
    return null;
  }

  function mostrarIndisponivel(corpo) {
    $('prov-rotulo').textContent = (corpo && corpo.error) || dgTextFull_provedor("Não consegui ver o modelo do agente.");
    dgBindFull_provedor($('prov-rotulo'),'',"title");
    dgBindFull_provedor($('prov-conferido'),'',undefined);
    const av = $('prov-aviso');
    av.hidden = !(corpo && corpo.howToFix);
    av.textContent = (corpo && corpo.howToFix) || '';
    $('prov-trocar').hidden = true;
    $('prov-entrar').hidden = true;
    $('prov-login').hidden = true;
  }

  function desenhar() {
    const d = dados;
    const modo = modoDe(d);
    const rot = $('prov-rotulo');
    const texto = d.rotulo || `${(d.catalogo[d.provedor] || {}).nome || d.provedor}${modo ? ', ' + modo.nome : ''}`;
    if (modo && texto.endsWith(', ' + modo.nome)) {
      const modelo = texto.slice(0, texto.length - modo.nome.length - 2);
      rot.innerHTML = `${esc(modelo)}, <span class="prov-modo" title="${esc(modo.explica)}">${esc(modo.nome)}</span>`;
    } else {
      rot.textContent = texto;
    }
    rot.removeAttribute('title');

    const conf = $('prov-conferido');
    const div = divergencia(d);
    conf.className = 'prov-conferido' + (div ? ' atencao' : '');
    dgBindFull_provedor(conf,TIP.conferido,"title");
    const hora = d.conferido ? quando(d.conferido.em) : '';
    conf.textContent = div ? (d.conferido && d.conferido.em ? `${hora}: ${div.texto}` : div.texto) : hora;

    const av = $('prov-aviso');
    if (div && div.curto) {
      // Aviso de uma ou duas linhas: no celular o botão de conectar tem que ficar na primeira tela.
      av.hidden = false;
      av.innerHTML = dgHtmlFull_provedor(`<div class="prov-aviso-curto"><!--dg-i18n:4c0270ad421e-->Seu agente ainda não está ligado a uma inteligência artificial. Toque no botão abaixo e conecte sua conta.<!--/dg-i18n--></div>`)
        + `<details class="prov-entenda"><summary>Entenda</summary><p>${esc(div.fazer)}${div.detalhe ? ` <span class="prov-detalhe">(${esc(div.detalhe)})</span>` : ''}</p></details>`;
    } else if (div) {
      av.hidden = false;
      av.innerHTML = `${esc(div.fazer)}${div.detalhe ? ` <span class="prov-detalhe">(${esc(div.detalhe)})</span>` : ''}`;
    } else {
      av.hidden = true;
      dgBindFull_provedor(av,'',undefined);
    }

    if (window.DGUso) window.DGUso.definirAuth(d.auth);
    $('prov-trocar').hidden = false;
    const precisaEntrar = d.auth === 'assinatura' && d.conferido && d.conferido.ok === false;
    $('prov-entrar').hidden = !precisaEntrar;
    dgBindFull_provedor($('prov-entrar'),dgTexto_provedor('Conectar minha conta'),undefined);
    // Na página do Status, o aviso vermelho grande do topo cede lugar ao cartão do provedor.
    const painel = document.getElementById('panel-status');
    if (painel) painel.classList.toggle('prov-entrar-pendente', !!precisaEntrar);
    avisarSucesso(d, precisaEntrar);

    const est = d.login && d.login.estado;
    if (est && est !== 'nenhum' && est !== 'concluido') {
      desenharLogin(d.login);
      iniciarPolling();
    } else if (!timerLogin) {
      $('prov-login').hidden = true;
    }
  }

  // Estado anterior: true = precisava entrar, false = já estava logado, null = ainda não sei.
  let estavaPendente = null;
  const CHAVE_LOGIN = 'dgclaw-login-iniciado';

  function avisarSucesso(d, precisaEntrar) {
    const logado = d.auth === 'assinatura' && d.conferido && d.conferido.ok === true;
    let iniciado = false;
    try { iniciado = sessionStorage.getItem(CHAVE_LOGIN) === '1'; } catch { /* sem sessionStorage */ }
    // Passou de "não logado" para "logado" nesta página, ou a pessoa começou o login,
    // saiu para a página do provedor e a tela recarregou ao voltar.
    if (logado && (estavaPendente === true || iniciado)) {
      const ok = $('prov-sucesso');
      if (ok) { ok.hidden = false; dgBindFull_provedor(ok,"Sucesso, o agente foi conectado.",undefined,undefined); }
      try { sessionStorage.removeItem(CHAVE_LOGIN); } catch { /* ignora */ }
    } else if (precisaEntrar) {
      const ok = $('prov-sucesso');
      if (ok) ok.hidden = true;
    }
    estavaPendente = precisaEntrar ? true : (logado ? false : estavaPendente);
  }

  /** Abrindo com ?aba=status e precisando entrar: leva o botão de conectar para a vista. */
  function mostrarBotaoSeNecessario() {
    const b = $('prov-entrar');
    if (b && !b.hidden && new URLSearchParams(location.search).get('aba') === 'status') {
      const reduz = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const cartao = b.closest('.prov-cartao') || b;
      cartao.scrollIntoView({ block: 'start', behavior: reduz ? 'auto' : 'smooth' });
    }
  }

  async function carregar() {
    if (!$('prov-status')) return;
    const r = await chamar('GET', '/api/provedor');
    if (!r.ok) {
      dados = null;
      mostrarIndisponivel(r.corpo);
      return;
    }
    dados = r.corpo;
    desenhar();
    mostrarBotaoSeNecessario();
  }

  // ── o login assistido ────────────────────────────────────────────────────

  function pararPolling() {
    if (timerLogin) { clearInterval(timerLogin); timerLogin = null; }
  }

  function desenharLogin(l) {
    const box = $('prov-login');
    const chave = JSON.stringify([l.estado, l.link, l.codigoDispositivo, l.mensagem]);
    if (chave === ultimaChaveDoLogin && !box.hidden) return;
    ultimaChaveDoLogin = chave;
    box.hidden = false;
    const link = linkSeguro(l.link);
    const linkHtml = link
      ? dgHtmlFull_provedor(`<a class="prov-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer"><!--dg-i18n:0e1eb03924b5-->Abrir a página de login<!--/dg-i18n--></a>`)
      : '';
    let corpo;
    if (l.estado === 'aguardando_link') {
      corpo = dgHtmlFull_provedor(`<p><!--dg-i18n:fe61b5df923f-->Preparando o link de login... isso leva alguns segundos.<!--/dg-i18n--></p>`);
    } else if (l.estado === 'aguardando_codigo') {
      corpo = dgHtmlFull_provedor(`<p><b>1.</b> ${linkHtml ? linkHtml + '.' : dgTextFull_provedor("Abra o link de login que o agente gerou.")} <!--dg-i18n:41b2c40e9069-->Entre com a sua conta.<!--/dg-i18n--></p>`)
        + dgHtmlFull_provedor(`<p><b>2.</b> <!--dg-i18n:7550f5a14cb0-->No fim, a página mostra um código. Cole ele aqui:<!--/dg-i18n--></p>`)
        + dgHtmlFull_provedor(`<div class="prov-codigo-linha"><input type="password" id="prov-codigo" autocomplete="off" autocapitalize="off" spellcheck="false" data-dg-i18n-aria-label="36b983b0012b" aria-label="Código que apareceu depois do login" data-dg-i18n-placeholder="91e0a45449a0" placeholder="cole aqui o código que apareceu">`)
        + dgHtmlFull_provedor(`<button type="button" class="prov-btn leve prov-olho" id="prov-codigo-olho" data-dg-i18n-aria-label="78efd2bdb255" aria-label="Mostrar código" aria-pressed="false" data-dg-i18n-title="bb060aaf836a" title="Mostrar ou ocultar o código. Fica oculto para não aparecer em tela compartilhada.">&#128065;</button>`)
        + dgHtml_provedor(dgHtmlFull_provedor(`<button type="button" class="prov-btn" id="prov-codigo-enviar" data-dg-i18n-title="180623453701" title="Entrega o código ao agente para ele terminar o login."><!--dg-i18n:e1d12d1a29a7-->Enviar<!--/dg-i18n--></button></div>`));
    } else if (l.estado === 'aguardando_navegador') {
      corpo = dgHtmlFull_provedor(`<p><b>1.</b> ${linkHtml ? linkHtml + '.' : dgTextFull_provedor("Abra o link de login que o agente gerou.")} <!--dg-i18n:f401b9e0c570-->Entre com a sua conta do ChatGPT.<!--/dg-i18n--></p>`)
        + dgHtmlFull_provedor(`<p><b>2.</b> <!--dg-i18n:f4233268df00-->Quando a página pedir, digite este código:<!--/dg-i18n--></p><div class="prov-codigo-grande" aria-live="polite">${esc(l.codigoDispositivo || '...')}</div>`)
        + dgHtmlFull_provedor(`<p class="prov-fraco"><!--dg-i18n:407a58fb4e08-->Esta tela confere sozinha a cada 2 segundos e avisa quando o login terminar.<!--/dg-i18n--></p>`);
    } else if (l.estado === 'falhou') {
      corpo = dgHtmlFull_provedor(`<p class="prov-erro"><!--dg-i18n:704bb744a37a-->O login não deu certo<!--/dg-i18n-->${l.mensagem ? ': ' + esc(l.mensagem) : '.'}</p>`)
        + dgHtmlFull_provedor(`<p><!--dg-i18n:b40f6f39b32c-->Clique em "Conectar minha conta" para tentar de novo.<!--/dg-i18n--></p>`);
    } else {
      corpo = `<p>${esc(l.estado)}</p>`;
    }
    const cancelar = (l.estado === 'falhou') ? '' : dgHtml_provedor(dgHtmlFull_provedor(`<button type="button" class="prov-btn leve" id="prov-login-cancelar" data-dg-i18n-title="db3b7f69d72a" title="Desiste do login. Nada muda no agente."><!--dg-i18n:bb9dbb406dcb-->Cancelar<!--/dg-i18n--></button>`));
    box.innerHTML = dgHtmlFull_provedor(`${corpo}<div class="prov-login-pe">${cancelar}<button type="button" class="prov-btn leve" id="prov-login-fechar"><!--dg-i18n:0f2bd88ef0ac-->Fechar<!--/dg-i18n--></button></div>`);
    const env = $('prov-codigo-enviar');
    if (env) {
      const olho = $('prov-codigo-olho');
      const ocultarCodigo = () => {
        $('prov-codigo').type = 'password';
        olho.setAttribute('aria-pressed', 'false');
        dgBindFull_provedor(olho,"Mostrar código","aria-label");
      };
      olho.addEventListener('click', () => {
        const campo = $('prov-codigo');
        if (campo.type === 'password') {
          campo.type = 'text';
          olho.setAttribute('aria-pressed', 'true');
          dgBindFull_provedor(olho,"Ocultar código","aria-label");
        } else ocultarCodigo();
      });
      const enviar = async () => {
        const campo = $('prov-codigo');
        const codigo = campo.value.trim();
        if (!codigo) { campo.focus(); return; }
        env.disabled = true;
        const r = await chamar('POST', '/api/provedor/login/codigo', { codigo });
        campo.value = '';
        ocultarCodigo();
        env.disabled = false;
        if (!r.ok) mostrarErroLogin(r.corpo);
        else conferirLogin();
      };
      env.addEventListener('click', enviar);
      $('prov-codigo').addEventListener('keydown', (e) => { if (e.key === 'Enter') enviar(); });
    }
    const can = $('prov-login-cancelar');
    if (can) can.addEventListener('click', async () => {
      await chamar('DELETE', '/api/provedor/login');
      fecharLogin();
    });
    $('prov-login-fechar').addEventListener('click', fecharLogin);
  }

  function mostrarErroLogin(corpo) {
    const box = $('prov-login');
    let e = box.querySelector('.prov-erro-envio');
    if (!e) {
      e = document.createElement('p');
      e.className = 'prov-erro prov-erro-envio';
      box.insertBefore(e, box.firstChild);
    }
    e.textContent = `${(corpo && corpo.error) || dgTextFull_provedor("Não consegui enviar o código.")} ${(corpo && corpo.howToFix) || ''}`.trim();
  }

  function fecharLogin() {
    pararPolling();
    ultimaChaveDoLogin = '';
    const box = $('prov-login');
    box.hidden = true;
    box.innerHTML = '';
  }

  async function conferirLogin() {
    const box = $('prov-login');
    // Parou de existir na tela (outra aba aberta, página refeita): para de perguntar.
    if (!box || box.hidden) { pararPolling(); return; }
    const r = await chamar('GET', '/api/provedor/login');
    if (!r.ok) { mostrarErroLogin(r.corpo); return; }
    const l = r.corpo;
    if (l.estado === 'concluido') {
      pararPolling();
      ultimaChaveDoLogin = '';
      box.hidden = false;
      box.innerHTML = dgHtmlFull_provedor(`<p class="prov-ok"><!--dg-i18n:9ddfcf08e072-->Login feito. Conferindo o agente...<!--/dg-i18n--></p>`);
      await carregar();
      // Com o estado já conferido, a caixa verde de sucesso toma o lugar da mensagem.
      if (!timerLogin) fecharLogin();
    } else if (l.estado === 'falhou') {
      pararPolling();
      desenharLogin(l);
    } else if (l.estado === 'nenhum') {
      fecharLogin();
    } else {
      desenharLogin(l);
    }
  }

  function iniciarPolling() {
    if (timerLogin) return;
    timerLogin = setInterval(conferirLogin, 2000);
  }

  async function entrar() {
    const b = $('prov-entrar');
    b.disabled = true;
    const r = await chamar('POST', '/api/provedor/login');
    b.disabled = false;
    ultimaChaveDoLogin = '';
    if (!r.ok) {
      const box = $('prov-login');
      box.hidden = false;
      box.innerHTML = `<p class="prov-erro">${esc(r.corpo.error || dgTextFull_provedor("Não consegui começar o login."))} ${esc(r.corpo.howToFix || '')}</p>`;
      return;
    }
    try { sessionStorage.setItem(CHAVE_LOGIN, '1'); } catch { /* ignora */ }
    desenharLogin(r.corpo && r.corpo.estado ? r.corpo : { estado: 'aguardando_link' });
    iniciarPolling();
  }

  // ── a janela "Trocar" ────────────────────────────────────────────────────

  let janela = null;

  function fecharJanela() {
    if (!janela) return;
    document.removeEventListener('keydown', janela.tecla);
    janela.fundo.remove();
    const volta = janela.foco;
    janela = null;
    if (volta && volta.focus) volta.focus();
  }

  function abrirJanela() {
    if (!dados || janela) return;
    const cat = dados.catalogo;
    const sel = { provedor: dados.provedor, auth: dados.auth, modelo: dados.modelo || '' };
    if (!cat[sel.provedor] || !cat[sel.provedor].disponivel) sel.provedor = Object.keys(cat).find((k) => cat[k].disponivel);

    const fundo = document.createElement('div');
    fundo.className = 'prov-fundo';
    fundo.innerHTML = '<div class="prov-janela" role="dialog" aria-modal="true" aria-labelledby="prov-j-titulo" tabindex="-1"></div>';
    document.body.appendChild(fundo);
    const caixa = fundo.firstChild;

    function desenharCaixa() {
      const p = cat[sel.provedor];
      if (!p.auth[sel.auth]) sel.auth = Object.keys(p.auth)[0];
      if (sel.modelo && !p.modelos.some((m) => m.id === sel.modelo)) sel.modelo = '';
      const modo = p.auth[sel.auth];
      const faltaChave = !!(modo.variavel && dados.chaves && dados.chaves[modo.variavel] === false);

      const provs = Object.entries(cat).map(([id, x]) => `
        <label class="prov-op ${x.disponivel ? '' : 'desligada'}" title="${esc(x.disponivel ? dgPhraseFull_provedor("Usar {v0} como o cérebro do agente.",{v0:(x.nome)}) : dgPhraseFull_provedor("{v0} ainda não está disponível: {v1}.",{v0:(x.nome),v1:(x.motivo || dgTextFull_provedor("em preparo"))}))}">
          <input type="radio" name="prov-provedor" value="${esc(id)}" ${id === sel.provedor ? 'checked' : ''} ${x.disponivel ? '' : 'disabled'}>
          <span><b>${esc(x.nome)}</b>${x.disponivel ? '' : dgHtmlFull_provedor(`<small class="prov-fraco">${dgFragFull_provedor("indisponível: {v0}",{v0:(x.motivo || dgTextFull_provedor("em preparo"))})}</small>`)}</span>
        </label>`).join('');

      const padrao = p.modeloPadrao ? (p.modelos.find((m) => m.id === p.modeloPadrao) || {}).nome : '';
      const modelos = [dgHtmlFull_provedor(`<option value="" data-dg-i18n-title="48207d874cc8" title="O modelo que o próprio provedor indica como padrão."><!--dg-i18n:edf767a003d2-->Padrão do provedor<!--/dg-i18n-->${padrao ? ` (${esc(padrao)})` : ''}</option>`)]
        .concat(p.modelos.map((m) => `<option value="${esc(m.id)}" title="${esc(m.id)}" ${m.id === sel.modelo ? 'selected' : ''}>${esc(m.nome)}</option>`)).join('');

      const modos = Object.entries(p.auth).map(([id, a]) => `
        <label class="prov-op" title="${esc(a.explica)}">
          <input type="radio" name="prov-auth" value="${esc(id)}" ${id === sel.auth ? 'checked' : ''}>
          <span><b>${esc(a.nome)}</b><small class="prov-explica">${esc(a.explica)}</small></span>
        </label>`).join('');

      const campoChave = faltaChave ? `
        <div class="prov-chave">
          <label for="prov-chave-in"><b>${dgFragFull_provedor(modo.ondeCriar ? dgTextFull_provedor("Chave da API") : dgTextFull_provedor("Código de acesso"))}</b></label>
          <input type="password" id="prov-chave-in" autocomplete="off" spellcheck="false" placeholder="cole aqui">
          <small class="prov-fraco">${modo.ondeCriar
            ? dgHtmlFull_provedor(`<!--dg-i18n:54779a2fff74-->Ainda não há uma chave guardada no Cofre.<!--/dg-i18n--> <a href="${esc(modo.ondeCriar)}" target="_blank" rel="noopener noreferrer"><!--dg-i18n:700103f3313c-->Onde criar<!--/dg-i18n--></a><!--dg-i18n:fd615a8585c6-->. Depois de salva, ela não aparece mais em lugar nenhum.<!--/dg-i18n-->`)
            : dgTextFull_provedor("Ainda não há um código guardado no Cofre. Gere um com \"claude setup-token\" e cole aqui. Depois de salvo, ele não aparece mais em lugar nenhum.")}</small>
        </div>` : '';

      caixa.innerHTML = dgHtmlFull_provedor(`
        <div class="prov-j-topo"><h3 id="prov-j-titulo"><!--dg-i18n:33a57c474098-->Trocar o modelo do agente<!--/dg-i18n--></h3>
          <button type="button" class="prov-fechar" id="prov-j-x" data-dg-i18n-aria-label="38698ce36e60" aria-label="Fechar a janela" data-dg-i18n-title="b8def1ffcc2a" title="Fechar sem trocar nada.">${dsIcone('x')}</button></div>
        <div class="prov-j-corpo">
          <fieldset><legend>Provedor</legend>${provs}</fieldset>
          <label class="prov-campo" for="prov-modelo" data-dg-i18n-title="1f03fb5054cb" title="O modelo é o cérebro dentro do provedor. Os maiores pensam melhor e gastam mais; os menores respondem mais rápido."><!--dg-i18n:a5ab3212dad1-->Modelo<!--/dg-i18n--></label>
          <select id="prov-modelo" title="Escolha o modelo.">${modelos}</select>
          <fieldset><legend><!--dg-i18n:bcd7eea5538c-->Forma de pagar<!--/dg-i18n--></legend>${modos}</fieldset>
          ${campoChave}
          <div class="prov-aviso-troca"><!--dg-i18n:97fe42aa180f-->A conversa atual vai fechar e o agente volta numa conversa nova. A memória dele continua.<!--/dg-i18n--></div>
          <p class="prov-fraco"><span title="Guia sobre o risco de a conta ser bloqueada ao usar a assinatura num agente. Fica no repositório do plugin: ${esc(RISCO_DOC)}."><!--dg-i18n:93576ea17641-->Usar a assinatura num agente é permitido? Leia aqui<!--/dg-i18n--></span> (${esc(RISCO_DOC)}).</p>
          <div class="prov-j-erro" id="prov-j-erro" role="alert" hidden></div>
        </div>
        <div class="prov-j-pe">
          <button type="button" class="prov-btn leve" id="prov-j-cancelar"><!--dg-i18n:bb9dbb406dcb-->Cancelar<!--/dg-i18n--></button>
          <button type="button" class="prov-btn" id="prov-j-ok" title="Grava a escolha e reinicia o agente."><!--dg-i18n:7014e2c25e95-->Trocar e reiniciar<!--/dg-i18n--></button>
        </div>`);

      caixa.querySelectorAll('input[name="prov-provedor"]').forEach((i) => i.addEventListener('change', () => {
        sel.provedor = i.value; sel.modelo = ''; desenharCaixa();
        caixa.querySelector('input[name="prov-provedor"]:checked').focus();
      }));
      caixa.querySelectorAll('input[name="prov-auth"]').forEach((i) => i.addEventListener('change', () => {
        sel.auth = i.value; desenharCaixa();
        caixa.querySelector('input[name="prov-auth"]:checked').focus();
      }));
      $('prov-modelo').addEventListener('change', (e) => { sel.modelo = e.target.value; });
      $('prov-j-x').addEventListener('click', fecharJanela);
      $('prov-j-cancelar').addEventListener('click', fecharJanela);
      $('prov-j-ok').addEventListener('click', confirmar);
    }

    function erro(corpo) {
      const e = $('prov-j-erro');
      e.hidden = false;
      e.textContent = `${(corpo && corpo.error) || dgTextFull_provedor("Não consegui trocar.")} ${(corpo && corpo.howToFix) || ''}`.trim();
    }

    async function confirmar() {
      const ok = $('prov-j-ok');
      const campo = $('prov-chave-in');
      const corpo = { provedor: sel.provedor, auth: sel.auth, modelo: sel.modelo };
      if (campo && campo.value.trim()) corpo.chave = campo.value.trim();
      ok.disabled = true;
      ok.textContent = 'reiniciando...';
      const r = await chamar('POST', '/api/provedor', corpo);
      if (campo) campo.value = '';
      corpo.chave = undefined;
      if (!r.ok) {
        ok.disabled = false;
        dgBindFull_provedor(ok,"Trocar e reiniciar",undefined,undefined);
        if (r.status === 409 && r.corpo.precisaChave && dados.chaves) {
          // O Cofre não tinha a chave: a janela se redesenha com o campo para ela.
          dados.chaves[r.corpo.precisaChave] = false;
          desenharCaixa();
        }
        erro(r.corpo);
        return;
      }
      fecharJanela();
      reiniciando(r.corpo.rotulo);
    }

    janela = {
      fundo,
      foco: document.activeElement,
      tecla: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); fecharJanela(); return; }
        if (e.key !== 'Tab') return;
        const foc = [...caixa.querySelectorAll('button, input, select, a[href]')].filter((x) => !x.disabled && x.offsetParent !== null);
        if (!foc.length) return;
        const a = foc[0]; const z = foc[foc.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      },
    };
    document.addEventListener('keydown', janela.tecla);
    fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fecharJanela(); });
    desenharCaixa();
    caixa.focus();
  }

  /** Depois de trocar: o agente reinicia, e o cartão pergunta de novo até ele responder. */
  function reiniciando(rotulo) {
    dgBindFull_provedor($('prov-rotulo'),rotulo ? "{v0}: reiniciando..." : "Reiniciando o agente...",undefined,{v0:rotulo});
    $('prov-conferido').className = 'prov-conferido';
    dgBindFull_provedor($('prov-conferido'),"a conversa nova abre em alguns segundos",undefined,undefined);
    $('prov-aviso').hidden = true;
    $('prov-trocar').hidden = true;
    $('prov-entrar').hidden = true;
    let tentativas = 0;
    const volta = async () => {
      tentativas++;
      await carregar();
      if (!dados && tentativas < 6) setTimeout(volta, 5000);
    };
    setTimeout(volta, 6000);
  }

  function ligar() {
    const t = $('prov-trocar');
    if (!t || t._ligado) return;
    t._ligado = true;
    t.addEventListener('click', abrirJanela);
    $('prov-entrar').addEventListener('click', entrar);
  }

  // Voltou para a aba (ex.: veio da página de login do provedor): confere de novo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && dados) carregar();
  });

  document.addEventListener('DOMContentLoaded', ligar);
  if (document.readyState !== 'loading') ligar();

  window.DGProvedor = { carregar };
})();
