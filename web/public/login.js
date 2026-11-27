'use strict';
const dgUiLabel_login_js = (el, fonte, atributo, valores) => { if (globalThis.DGI18n) globalThis.DGI18n.rotulo(el, fonte, atributo, valores); else { const texto = fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m, k) => valores && Object.hasOwn(valores, k) ? String(valores[k]) : m); if (atributo) el.setAttribute(atributo, texto); else el.textContent = texto; } };

const dgTexto_login = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgHtml_login = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
/* login.js: preenche o destino (?next=) e a mensagem de erro (?erro=).
   O destino só vale se for um caminho do próprio site (começa com uma barra
   e não com duas), para o login nunca mandar a pessoa para outro endereço. */
(function () {
  const q = new URLSearchParams(location.search);
  let next = q.get('next') || '/';
  if (next.charAt(0) !== '/' || next.charAt(1) === '/' || next.indexOf('\\') >= 0) next = '/';
  document.getElementById('next').value = next;

  /* O servidor manda um código curto em ?erro=. Códigos conhecidos viram frase;
     qualquer outro vira a frase genérica (texto vindo da barra de endereço
     nunca é mostrado como está). */
  const ERRADO = 'Usuário ou senha incorretos. Confira e tente de novo.';
  const LIMITE = 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.';
  const FRASES = {
    credenciais: ERRADO,
    invalido: ERRADO,
    senha: ERRADO,
    '1': ERRADO,
    limite: LIMITE,
    bloqueado: LIMITE,
    muitas: LIMITE,
    sessao: 'Sua sessão acabou. Entre de novo para continuar.',
    expirada: 'Sua sessão acabou. Entre de novo para continuar.',
    campos: 'Preencha o usuário e a senha.',
    vencida: 'A senha temporária venceu. Peça ao dono do ' + (typeof dsMarca !== 'undefined' ? dsMarca.nome : 'DG Claw') + ' um convite novo.',
    origem: 'Não deu para confirmar de onde veio o pedido. Recarregue a página e tente de novo.',
  };
  if (q.has('erro')) {
    const cod = (q.get('erro') || '').toLowerCase();
    const caixa = document.getElementById('erro');
    const mensagem = FRASES[cod] || 'Não foi possível entrar. Confira os dados e tente de novo.';
    const espera = /^\d{1,4}$/.test(q.get('espera') || '') ? Number(q.get('espera')) : 0;
    if (cod === 'limite' && espera > 0) {
      if (window.DGI18n) window.DGI18n.rotulo(caixa, 'Muitas tentativas seguidas. Tente de novo em {min} min.', undefined, { min: espera });
      else caixa.textContent = 'Muitas tentativas seguidas. Tente de novo em ' + espera + ' min.';
    } else if (window.DGI18n) window.DGI18n.rotulo(caixa, mensagem);
    else caixa.textContent = mensagem;
    caixa.hidden = false;
  }
  /* O link do convite traz ?usuario=<e-mail>: o campo já vem preenchido, e a pessoa só digita a senha temporária. */
  const u = q.get('usuario');
  if (u && u.length < 80) {
    document.getElementById('usuario').value = u;
    document.getElementById('campoSenha').focus();
  }

  /* Olho: mostra e esconde a senha. */
  const ver = document.getElementById('verSenha');
  const campo = document.getElementById('campoSenha');
  ver.addEventListener('click', () => {
    const mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    ver.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
    const rot = mostrar ? dgTexto_login('Ocultar senha') : dgTexto_login('Mostrar senha');
    if (window.DGI18n) { window.DGI18n.rotulo(ver, rot, 'aria-label'); window.DGI18n.rotulo(ver, rot, 'title'); }
    else { ver.setAttribute('aria-label', rot); ver.title = rot; }
    ver.querySelector('use').setAttribute('href', '/ds/icones.svg#' + (mostrar ? 'i-eye-off' : 'i-eye'));
    campo.focus();
  });

  /* Envio: o botão mostra o carregando e fica desabilitado (a página volta pelo bfcache com o botão normal). */
  const form = document.getElementById('form');
  const entrar = document.getElementById('entrar');
  form.addEventListener('submit', () => {
    setTimeout(() => {
      entrar.disabled = true;
      entrar.innerHTML = window.dsCarregando({ rotulo: dgTexto_login('Entrando'), tamanho: 'p' }) + dgHtml_login("<span><!--dg-i18n:93aad5ac9bad-->Entrando…<!--/dg-i18n--></span>");
    }, 0);
  });
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return;
    entrar.disabled = false; dgUiLabel_login_js(entrar, "Entrar", null, {});
  });

  /* Instalação sem senha ainda: avisa (em tom neutro, não de erro) para usar o link de primeiro acesso. */
  fetch('/api/login-estado', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (!j || !j.sem_senha) return;
    const caixa = document.getElementById('erro');
    caixa.textContent = j.mensagem || dgTexto_login('Use o link de primeiro acesso que apareceu no fim da instalação.');
    caixa.classList.add('info');
    caixa.hidden = false;
  }).catch(() => { /* sem aviso, o login segue normal */ });
})();
