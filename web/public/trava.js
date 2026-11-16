'use strict';
/* trava.js: o cadeado com Face ID (WebAuthn) do DG Claw, do lado da tela.

   Entra com uma tag <script> no <head> de toda tela que exige login e não depende de nenhum outro arquivo.
   Quem decide se a sessão está travada é o SERVIDOR (web/lib/cadeado.js); este arquivo só:
     - avisa o uso (toque, tecla, rolagem), no máximo 1 aviso por minuto;
     - pergunta o estado ao voltar para o app, no relógio e a cada minuto;
     - cobre a tela inteira quando o servidor diz que travou (resposta 423 ou "event: travado" no stream);
     - chama o Face ID dentro do toque do botão e manda a assinatura para o servidor;
     - oferece "Entrar com a senha" (sai da sessão e leva ao login), a saída para quem não tem biometria.
   Sem Face ID ativado neste aparelho ele não faz nada visível. Na página /cadeado (body com data-cadeado-pagina) a
   mesma tela aparece como página inteira.

   Também expõe window.DGTrava, que a tela Face ID usa para cadastrar. Contrato: web/docs/CADEADO.md. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else if (!raiz.DGTrava) raiz.DGTrava = m;
})(typeof window !== 'undefined' ? window : globalThis, function (janela) {
  const API = '/api/v1/cadeado';
  const USO_MIN_MS = 20000;           // no máximo 1 aviso de uso a cada 20 s (o menor prazo configurável é 1 min)
  const OPCOES_VALIDADE_MS = 90000;   // o desafio vale 2 min no servidor; renovo antes

  /* ── partes puras (sem DOM), com teste em web/test/face-id-tela.test.js ───── */
  function b64uParaBuf(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufParaB64u(buf) {
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* Como a pessoa chama a biometria do aparelho: Face ID, Touch ID ou, quando não dá para saber, biometria. */
  function rotuloBiometria(ua, toques) {
    ua = ua || ''; toques = toques || 0;
    if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID';
    if (/Macintosh/.test(ua) && toques > 1) return 'Face ID';
    if (/Macintosh/.test(ua)) return 'Touch ID';
    return 'biometria';
  }
  /* 'o Face ID', 'o Touch ID' ou 'a biometria', para frase corrida */
  function comArtigo(rotulo) { return rotulo === 'biometria' ? 'a biometria' : 'o ' + rotulo; }

  /* O erro do navegador em português, dizendo o que fazer. `temApi` é se o navegador tem WebAuthn. */
  function traduzErro(e, acao, temApi, rotulo, host) {
    const n = e && e.name; const a = acao || 'destravar';
    rotulo = rotulo || 'biometria';
    if (temApi === false) return 'Este navegador não tem ' + rotulo + ' para sites. Entre com a senha.';
    if (n === 'NotAllowedError') {
      return 'O ' + rotulo + ' foi cancelado, o tempo acabou ou este aparelho não tem a passkey do DG Claw. Toque de novo para tentar, ou entre com a senha.';
    }
    if (n === 'InvalidStateError') {
      return a === 'cadastrar' ? 'Este aparelho já tem o ' + rotulo + ' cadastrado aqui.' : 'O aparelho recusou a passkey (estado inválido). Tente de novo.';
    }
    if (n === 'SecurityError') {
      return 'O navegador recusou o endereço (' + (host || '') + ') para o ' + rotulo + '. Abra o DG Claw pelo endereço com HTTPS e tente de novo.';
    }
    if (n === 'NotSupportedError') return 'Este aparelho não aceita o tipo de chave pedido. Entre com a senha.';
    if (n === 'AbortError') return 'O ' + rotulo + ' foi interrompido. Toque de novo.';
    return (e && e.message) || String(e);
  }

  /* `next` da página do cadeado: só caminho do próprio site e nunca de volta ao cadeado, ao login ou ao sair. */
  function destinoSeguro(valor) {
    const s = typeof valor === 'string' ? valor : '';
    if (!s.startsWith('/') || s.startsWith('//') || s.indexOf('\\') >= 0 || /[\x00-\x1f]/.test(s)) return '/';
    if (/^\/(?:cadeado|login|sair)(?:[/?#]|$)/.test(s)) return '/';
    return s;
  }

  /* As opções chegam do servidor em JSON (base64url); o navegador quer bytes. */
  function publicKeyGet(op) {
    return {
      challenge: b64uParaBuf(op.challenge), rpId: op.rpId, timeout: op.timeout,
      userVerification: op.userVerification || 'required',
      allowCredentials: (op.allowCredentials || []).map(function (c) { return { type: 'public-key', id: b64uParaBuf(c.id), transports: c.transports }; }),
    };
  }
  function publicKeyCreate(op) {
    const pk = JSON.parse(JSON.stringify(op));
    pk.challenge = b64uParaBuf(op.challenge);
    pk.user.id = b64uParaBuf(op.user.id);
    pk.excludeCredentials = (op.excludeCredentials || []).map(function (c) { return { type: 'public-key', id: b64uParaBuf(c.id) }; });
    return pk;
  }
  function credParaJson(cred) {
    const r = cred.response; const resp = { clientDataJSON: bufParaB64u(r.clientDataJSON) };
    if (r.attestationObject) {
      resp.attestationObject = bufParaB64u(r.attestationObject);
      if (typeof r.getTransports === 'function') {
        try { resp.transports = r.getTransports(); } catch (e) { console.warn('trava: o navegador não informou os transportes da passkey:', e.message); resp.transports = []; }
      }
    }
    if (r.authenticatorData) resp.authenticatorData = bufParaB64u(r.authenticatorData);
    if (r.signature) resp.signature = bufParaB64u(r.signature);
    if (r.userHandle) resp.userHandle = bufParaB64u(r.userHandle);
    return { id: cred.id, rawId: bufParaB64u(cred.rawId), type: cred.type, response: resp };
  }

  /* Sem rede com a tela coberta: precisa de conexão para destravar. */
  function mensagemSemConexao(motivo) {
    return 'Sem conexão com o servidor' + (motivo ? ' (' + motivo + ')' : '') + '. Preciso de internet para destravar: confira a conexão e toque de novo.';
  }

  const puro = { mensagemSemConexao, b64uParaBuf, bufParaB64u, rotuloBiometria, comArtigo, traduzErro, destinoSeguro, publicKeyGet, publicKeyCreate, credParaJson, API };
  if (!janela.document) return puro;

  /* ── Parte com DOM ──────────────────────────────────────────────────────── */
  const rotulo = () => rotuloBiometria(navigator.userAgent, navigator.maxTouchPoints);
  const artigo = () => comArtigo(rotulo());
  const temApi = () => !!(janela.PublicKeyCredential && navigator.credentials);
  const fetchOriginal = janela.fetch ? janela.fetch.bind(janela) : null;

  let estado = null;        // última resposta de /estado
  let vistoAte = 0;         // até quando (relógio local) a sessão está destravada
  let aberto = false; let ocupado = false;
  let opcoes = null; let opcoesEm = 0; let opcoesTimer = null;
  let ultimoUso = 0; let usoTimer = null; let relogio = null;
  let raiz = null; let btn = null; let msgEl = null; let subEl = null; let senhaEl = null;

  const modoPagina = () => !!(document.body && document.body.hasAttribute('data-cadeado-pagina'));
  function destino() {
    if (modoPagina()) return destinoSeguro(new URLSearchParams(location.search).get('next'));
    return location.pathname + location.search;
  }

  /* 423 ou `event: travado` mostram o cadeado. O ramo à parte não mexe na promessa original: stream e corpo seguem iguais. */
  if (fetchOriginal) {
    janela.fetch = function (entrada, init) {
      const p = fetchOriginal(entrada, init);
      // Só o 423 do cadeado (corpo com travado:true) cobre a tela; outro 423 (o painel usa para "poder não instalado") segue para
      // a página. Lê uma CÓPIA da resposta, sem tocar no corpo de quem fez o pedido.
      p.then(function (r) {
        if (!r || r.status !== 423) return;
        r.clone().json().then(function (d) { if (d && d.travado === true) mostra('A tela travou por falta de uso.'); },
          function (e) { console.warn('trava: um 423 sem corpo JSON não é do cadeado, deixei passar:', e.message); });
      }, function () { /* o chamador trata a falha de rede */ });
      return p;
    };
  }
  try {
    const ESOriginal = janela.EventSource;
    if (ESOriginal) {
      const ESVigiado = function (url, cfg) {
        const es = new ESOriginal(url, cfg);
        try { es.addEventListener('travado', function () { mostra('A tela travou por falta de uso.'); }); } catch (e) { console.warn('trava: não consegui ouvir o stream:', e.message); }
        return es;
      };
      ESVigiado.prototype = ESOriginal.prototype;
      ESVigiado.CONNECTING = 0; ESVigiado.OPEN = 1; ESVigiado.CLOSED = 2;
      janela.EventSource = ESVigiado;
    }
  } catch (e) { console.warn('trava: o EventSource ficou sem vigia:', e.message); }

  function pede(url, opt) {
    const o = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, opt || {});
    return fetchOriginal(url, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, ok: r.ok && d.ok !== false, d: d }; });
    });
  }

  function aplicaEstado(d) {
    estado = d;
    vistoAte = d && d.ativo && d.resta_s != null ? Date.now() + d.resta_s * 1000 : 0;
    agendaRelogio();
  }
  function agendaRelogio() {
    if (relogio) { clearTimeout(relogio); relogio = null; }
    if (!estado || !estado.ativo || aberto || estado.resta_s == null) return;
    if (!vistoAte) return;
    relogio = setTimeout(venceuOPrazo, Math.max(0, vistoAte - Date.now()) + 50);
  }

  /* O prazo acabou: a tela é coberta AQUI, sem esperar o servidor (sem rede ela ficaria legível). Ela só descobre quando
     o servidor confirma que a sessão está destravada, e sem rede a tela avisa que precisa de conexão para destravar. */
  function venceuOPrazo() {
    if (aberto || !estado || !estado.ativo || !vistoAte || Date.now() < vistoAte) return;
    mostra();
    confere();
  }

  function confere(contaComoUso) {
    if (!fetchOriginal) return Promise.resolve();
    return pede(API + '/estado').then(function (r) {
      if (r.status === 401) return;          // sem sessão: a própria página leva ao login
      if (!r.ok) { console.warn('trava: /estado respondeu ' + r.status, r.d.erro || ''); avisaSemConexao('o servidor respondeu ' + r.status); return; }
      aplicaEstado(r.d);
      if (r.d.travado) { mostra(); return; }
      if (aberto && modoPagina()) { vaiPraFrente(); return; }
      if (aberto) esconde();
      if (contaComoUso && r.d.ativo) avisaUso();
    }).catch(function (e) {
      console.warn('trava: não consegui perguntar o estado (' + (e.message || 'sem rede') + ')');
      avisaSemConexao(e.message || 'sem rede');
    });
  }
  /* Tela coberta e sem resposta do servidor: continua coberta e diz o que falta. */
  function avisaSemConexao(motivo) {
    if (!aberto || !msgEl) return;
    msgEl.textContent = mensagemSemConexao(motivo);
  }

  function enviaUso() {
    ultimoUso = Date.now();
    pede(API + '/uso', { method: 'POST' }).then(function (r) {
      if (r.status === 423 && r.d && r.d.travado === true) { mostra(); return; }
      if (r.ok && r.d.resta_s != null) {
        estado = Object.assign({}, estado || {}, { resta_s: r.d.resta_s, trava_min: r.d.trava_min });
        vistoAte = Date.now() + r.d.resta_s * 1000;
        agendaRelogio();
      }
    }).catch(function (e) { console.warn('trava: o aviso de uso não chegou (' + (e.message || 'sem rede') + ')'); });
  }

  /* Toque, tecla ou rolagem: avisa já se faz 1 min do último aviso; senão agenda para o fim do minuto. */
  function avisaUso() {
    if (!estado || !estado.ativo || aberto) return;
    const desde = Date.now() - ultimoUso;
    if (desde >= USO_MIN_MS) { enviaUso(); return; }
    if (!usoTimer) usoTimer = setTimeout(function () { usoTimer = null; if (!aberto) enviaUso(); }, USO_MIN_MS - desde);
  }

  /* ── a tela do cadeado ──────────────────────────────────────────────────── */
  const CSS =
    'html.dgclaw-travado,html.dgclaw-travado body{overflow:hidden!important}' +
    'html.dgclaw-travado body>*:not(#dgclawTrava){visibility:hidden!important}' +
    '#dgclawTrava{position:fixed;inset:0;z-index:2147483647;background:#12251b;color:#eef6ef;' +
    'display:flex;align-items:center;justify-content:center;overflow-y:auto;' +
    'padding:calc(24px + env(safe-area-inset-top)) calc(20px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(20px + env(safe-area-inset-left));' +
    'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent;visibility:visible!important}' +
    '#dgclawTrava[hidden]{display:none!important}' +   // display:flex da camada vence o atributo hidden sem esta regra
    '#dgclawTrava *{box-sizing:border-box}' +
    '#dgclawTrava .cx{width:100%;max-width:380px;text-align:center}' +
    '#dgclawTrava .ic{width:84px;height:84px;margin:0 auto 18px;border-radius:26px;background:#2f9e5e;display:flex;align-items:center;justify-content:center;font-size:42px}' +
    '#dgclawTrava h1{font-size:22px;margin:0 0 6px;font-weight:700}' +
    '#dgclawTrava .sub{color:#b7cdbd;font-size:15px;margin:0 0 26px}' +
    '#dgclawTrava button.prin{width:100%;min-height:58px;border:0;border-radius:16px;background:#2f9e5e;color:#fff;font-size:18px;font-weight:700;cursor:pointer;font-family:inherit;padding:14px 18px}' +
    '#dgclawTrava button.prin:active{opacity:.85}#dgclawTrava button[disabled]{opacity:.6}' +
    '#dgclawTrava .msg{margin:14px 0 0;font-size:14.5px;color:#ffd7d2;overflow-wrap:anywhere}#dgclawTrava .msg:empty{display:none}' +
    '#dgclawTrava button.senha{display:inline-flex;align-items:center;justify-content:center;min-height:48px;margin-top:18px;padding:0 14px;border:0;background:none;color:#cfe8d6;font:inherit;font-size:15px;text-decoration:underline;cursor:pointer}';

  function montaTela() {
    if (raiz) return;
    const st = document.createElement('style');
    st.id = 'dgclawTravaCss'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    raiz = document.createElement('div');
    raiz.id = 'dgclawTrava';
    raiz.setAttribute('role', 'dialog'); raiz.setAttribute('aria-modal', 'true'); raiz.setAttribute('aria-labelledby', 'dgclawTravaTit');
    raiz.hidden = true;
    raiz.innerHTML =
      '<div class="cx"><div class="ic" aria-hidden="true">🔒</div>' +
      '<h1 id="dgclawTravaTit">DG Claw travado</h1>' +
      '<p class="sub" id="dgclawTravaSub"></p>' +
      '<button type="button" class="prin" id="dgclawTravaBtn"></button>' +
      '<p class="msg" id="dgclawTravaMsg" role="alert"></p>' +
      '<button type="button" class="senha" id="dgclawTravaSenha">Entrar com a senha</button></div>';
    document.body.appendChild(raiz);
    btn = raiz.querySelector('#dgclawTravaBtn'); msgEl = raiz.querySelector('#dgclawTravaMsg');
    subEl = raiz.querySelector('#dgclawTravaSub'); senhaEl = raiz.querySelector('#dgclawTravaSenha');
    btn.addEventListener('click', destravar);
    senhaEl.addEventListener('click', entrarComSenha);
  }

  const textoBotao = () => 'Destravar com ' + rotulo();

  function mostra(texto) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { mostra(texto); }, { once: true }); return; }
    montaTela();
    const min = estado && estado.trava_min ? Math.round(estado.trava_min) : null;
    subEl.textContent = texto || (min ? 'O DG Claw trava depois de ' + min + ' min sem uso. Destrave para voltar à conversa.' : 'Destrave para voltar à conversa.');
    if (aberto) return;
    aberto = true;
    if (relogio) { clearTimeout(relogio); relogio = null; }
    if (usoTimer) { clearTimeout(usoTimer); usoTimer = null; }
    document.documentElement.classList.add('dgclaw-travado');
    raiz.hidden = false;
    btn.disabled = false; btn.textContent = textoBotao(); msgEl.textContent = '';
    // sem teclado aberto, nada tocando e nada falando por baixo da tela travada
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { console.warn('trava: blur falhou:', e.message); }
    const midias = document.querySelectorAll('audio,video');
    for (let i = 0; i < midias.length; i++) {
      try { midias[i].pause(); } catch (e) { console.warn('trava: pause falhou:', e.message); }
    }
    if (janela.speechSynthesis) { try { janela.speechSynthesis.cancel(); } catch (e) { console.warn('trava: não parei a voz:', e.message); } }
    if (!temApi()) {
      btn.disabled = true;
      msgEl.textContent = 'Este navegador não tem ' + rotulo() + ' para sites. Use "Entrar com a senha".';
      return;
    }
    preBusca();
  }

  function esconde() {
    if (!aberto) return;
    aberto = false;
    document.documentElement.classList.remove('dgclaw-travado');
    if (raiz) raiz.hidden = true;
    if (opcoesTimer) { clearInterval(opcoesTimer); opcoesTimer = null; }
    agendaRelogio();
  }

  /* No iPhone o Face ID só abre dentro do toque. Por isso as opções (o desafio) são buscadas ANTES: no toque,
     o navigator.credentials.get sai na hora. */
  function preBusca() {
    buscaOpcoes().catch(function (e) { if (msgEl && e.message) msgEl.textContent = e instanceof TypeError ? mensagemSemConexao(e.message) : e.message; });
    if (!opcoesTimer) {
      opcoesTimer = setInterval(function () { if (aberto && !ocupado) buscaOpcoes().catch(function (e) { console.warn('trava: não renovei o desafio:', e.message); }); }, OPCOES_VALIDADE_MS - 10000);
    }
  }
  function buscaOpcoes() {
    return pede(API + '/verificar/opcoes').then(function (r) {
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(destino()); throw new Error(''); }
      if (!r.ok) {
        if (r.d && r.d.motivo === 'sem_passkey') {
          if (btn) btn.disabled = true;
          throw new Error('Este aparelho não tem mais o ' + rotulo() + ' cadastrado. Entre com a senha e ative de novo na tela Face ID.');
        }
        throw new Error((r.d && r.d.erro) || ('o servidor respondeu ' + r.status));
      }
      opcoes = r.d.publicKey; opcoesEm = Date.now();
      return opcoes;
    });
  }

  function vaiPraFrente() {
    if (modoPagina()) location.replace(destino());
    else location.reload();   // tudo novo: stream, conversa e mídia
  }

  function destravar() {
    if (ocupado) return;
    if (!temApi()) { msgEl.textContent = traduzErro(null, 'destravar', false, rotulo()); return; }
    ocupado = true;
    msgEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Aguardando ' + artigo() + '...';
    const fresca = opcoes && (Date.now() - opcoesEm < OPCOES_VALIDADE_MS) ? opcoes : null;
    opcoes = null;    // desafio de uso único: este não serve para a próxima tentativa
    // Com as opções já na mão, o navegador é chamado de dentro do toque; sem elas, busca e chama em seguida.
    const pega = fresca ? Promise.resolve(fresca) : buscaOpcoes();
    pega.then(function (op) {
      return navigator.credentials.get({ publicKey: publicKeyGet(op) });
    }).then(function (cred) {
      if (!cred) throw new Error('O aparelho não devolveu credencial nenhuma.');
      return pede(API + '/verificar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credencial: credParaJson(cred) }) });
    }).then(function (r) {
      if (!r.ok) { const e = new Error((r.d && r.d.erro) || ('o servidor respondeu ' + r.status)); e.servidor = true; throw e; }
      btn.textContent = 'Destravado';
      vaiPraFrente();
    }).catch(function (e) {
      ocupado = false;
      btn.disabled = false; btn.textContent = textoBotao();
      msgEl.textContent = e.servidor ? 'O servidor recusou: ' + e.message : (e instanceof TypeError ? mensagemSemConexao(e.message) : traduzErro(e, 'destravar', true, rotulo(), location.host));
      buscaOpcoes().catch(function (e2) { console.warn('trava: não busquei o desafio novo:', e2.message); });
    });
  }

  /* Saída pela senha: encerra a sessão travada e leva ao login. Entrar com a senha cria uma sessão já destravada. */
  function entrarComSenha() {
    senhaEl.disabled = true; msgEl.textContent = '';
    fetchOriginal('/sair', { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        if (r.type !== 'opaqueredirect' && !r.ok && r.status !== 303) throw new Error('o servidor respondeu ' + r.status);
        location.href = '/login?next=' + encodeURIComponent(destino());
      }).catch(function (e) {
        senhaEl.disabled = false;
        msgEl.textContent = 'Não consegui encerrar a sessão para você entrar com a senha (' + (e.message || 'sem rede') + '). Confira a internet e toque de novo.';
      });
  }

  /* ── quando conferir ────────────────────────────────────────────────────── */
  function aoVoltar() {
    // a estimativa local já sabe que passou da hora: cobre antes de perguntar
    if (estado && estado.ativo && vistoAte && Date.now() > vistoAte) mostra();
    confere(true);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') aoVoltar(); });
  janela.addEventListener('pageshow', function (ev) { if (ev.persisted) aoVoltar(); });
  ['pointerdown', 'keydown', 'wheel', 'touchmove'].forEach(function (t) { janela.addEventListener(t, avisaUso, { passive: true, capture: true }); });
  setInterval(function () { if (document.visibilityState === 'visible' && !aberto) confere(false); }, 60000);
  // Os temporizadores dormem com a aba em segundo plano e na economia de bateria: este confere o prazo local a cada 5 s.
  setInterval(venceuOPrazo, 5000);

  function inicia() {
    if (modoPagina()) mostra();
    confere(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia); else inicia();

  return Object.assign({}, puro, {
    confere: confere, mostra: mostra, pede: pede, rotulo: rotulo, comArtigo: artigo, temApi: temApi,
    traduz: function (e, acao) { return traduzErro(e, acao, temApi(), rotulo(), location.host); },
  });
});
