'use strict';
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
    origem: 'Não deu para confirmar de onde veio o pedido. Recarregue a página e tente de novo.',
    /* login único (enterprise): o servidor manda sso_<motivo> */
    sso_estado: 'A tentativa de entrar pelo login único expirou ou não é desta janela. Comece de novo.',
    sso_provedor: 'Não consegui falar com o provedor de login da empresa agora. Tente de novo em instantes ou fale com o TI.',
    sso_token: 'O provedor de login da empresa devolveu uma resposta que não consegui confirmar. Fale com o TI.',
    sso_dominio: 'Este e-mail não é de um domínio autorizado a entrar neste painel.',
    sso_email: 'O provedor não informou um e-mail confirmado para a sua conta. Fale com o TI.',
    sso_desativado: 'Este usuário está desativado. Fale com o TI.',
    sso_recusado: 'O provedor de login da empresa não autorizou a entrada.',
    sso_ambiguo: 'Há mais de um usuário com o seu e-mail cadastrado. Fale com o TI para deixar só um.',
    sso_config: 'O login único não está configurado direito neste servidor. Fale com o TI.',
    sso_obrigatorio: 'Neste nível de proteção a entrada é só pelo login único da empresa. Use o botão de entrar com a conta da empresa.',
    sso_emergencia: 'A conta de emergência só entra com senha e segundo fator, e esta ainda não tem o segundo fator. Peça ao TI para ligar o 2FA dela antes.',
  };
  if (q.has('erro')) {
    const cod = (q.get('erro') || '').toLowerCase();
    const caixa = document.getElementById('erro');
    caixa.textContent = FRASES[cod] || 'Não foi possível entrar. Confira os dados e tente de novo.';
    caixa.hidden = false;
    const u = q.get('usuario');
    if (u && u.length < 80) document.getElementById('usuario').value = u;
  }

  /* Instalação sem senha ainda: avisa (em tom neutro, não de erro) para usar o link de primeiro acesso. */
  fetch('/api/login-estado', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (j && j.sso) mostraSso(j.sso);
    if (!j || !j.sem_senha) return;
    const caixa = document.getElementById('erro');
    caixa.textContent = j.mensagem || 'Use o link de primeiro acesso que apareceu no fim da instalação.';
    caixa.style.background = '#e8f3ea'; caixa.style.color = '#25593a'; caixa.style.borderColor = '#bcdcc4';
    caixa.hidden = false;
  }).catch(() => { /* sem aviso, o login segue normal */ });

  /* Login único: opcional = botão ao lado da senha; padrão = botão em destaque, senha atrás de "Entrar com senha";
     obrigatório = só o botão, e a senha fica atrás de um link discreto para a conta de emergência do TI. */
  function mostraSso(sso) {
    const caixa = document.getElementById('sso');
    const form = document.getElementById('form');
    const botao = document.getElementById('ssoBotao');
    const link = document.getElementById('ssoSenha');
    if (!caixa || !form) return;
    if (sso.indisponivel || !sso.url) {
      const e = document.getElementById('erro');
      e.textContent = 'O login único é obrigatório neste servidor, mas ainda não está configurado. Fale com o TI. A conta de emergência continua entrando com senha e segundo fator.';
      e.hidden = false;
    } else {
      botao.textContent = 'Entrar com ' + sso.provedor;
      botao.href = sso.url + '?next=' + encodeURIComponent(next);
    }
    caixa.hidden = false;
    botao.hidden = !!sso.indisponivel || !sso.url;
    if (sso.modo === 'opcional') return;
    caixa.classList.add('sso-destaque');
    form.parentNode.insertBefore(caixa, form);
    form.hidden = true;
    link.textContent = sso.modo === 'obrigatorio' ? 'Sou a conta de emergência do TI' : 'Entrar com senha';
    link.hidden = false;
    link.addEventListener('click', function () {
      form.hidden = false;
      link.hidden = true;
      document.getElementById('usuario').focus();
    });
  }
})();
