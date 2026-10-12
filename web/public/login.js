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
  };
  if (q.has('erro')) {
    const cod = (q.get('erro') || '').toLowerCase();
    const caixa = document.getElementById('erro');
    caixa.textContent = FRASES[cod] || 'Não foi possível entrar. Confira os dados e tente de novo.';
    caixa.hidden = false;
    const u = q.get('usuario');
    if (u && u.length < 80) document.getElementById('usuario').value = u;
  }
})();
