'use strict';
/* login-2fa.js: a segunda etapa do login (/login/2fa). Duas formas, conforme o servidor diz em GET /api/v1/login/2fa:
   etapa "codigo": a pessoa já tem 2FA e digita o código (ou um código de reserva);
   etapa "ativar": o nível exige 2FA e ela ainda não ativou: mostra a chave, ela digita o primeiro código e recebe os códigos de reserva.
   O destino (?next=) só vale se for caminho do próprio site. */
(function () {
  const C = window.DGContaComum;
  const q = new URLSearchParams(location.search);
  let next = q.get('next') || '/';
  if (next.charAt(0) !== '/' || next.charAt(1) === '/' || next.indexOf('\\') >= 0) next = '/';

  const $ = (id) => document.getElementById(id);
  const erro = (msg) => { $('erro').textContent = msg; $('erro').hidden = !msg; };
  let etapa = null;

  function mostra(d) {
    etapa = d.etapa;
    if (d.etapa === 'ativar') {
      $('sub').textContent = 'Seu perfil precisa do segundo fator. Vamos ativar agora, leva um minuto.';
      $('ativacao').innerHTML = C.htmlSegredo(d);
      $('ativacao').hidden = false;
      $('rotuloCodigo').textContent = 'Código de 6 números do aplicativo';
      $('enviar').textContent = 'Ativar e entrar';
    } else {
      $('sub').textContent = 'Digite o código de 6 números do seu aplicativo autenticador.';
      $('ajudaReserva').hidden = false;
      $('enviar').textContent = 'Entrar';
    }
    $('form').hidden = false;
    $('codigo').focus();
  }

  C.api('GET', '/api/v1/login/2fa').then(mostra).catch((e) => {
    if (e.status === 401) { location.replace('/login?erro=sessao'); return; }
    erro(e.message);
  });

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    erro('');
    $('enviar').disabled = true;
    try {
      const r = await C.api('POST', '/api/v1/login/2fa', { codigo: $('codigo').value, next });
      if (r.codigos_reserva) {
        $('form').hidden = true; $('ativacao').hidden = true; $('sub').textContent = 'Segundo fator ativado.';
        $('reserva').innerHTML = C.htmlCodigosReserva(r.codigos_reserva) + '<a id="continuar" href="' + C.esc(r.destino) + '">Já guardei, continuar</a>';
        $('reserva').hidden = false;
        $('reserva').addEventListener('click', (e) => {
          const b = e.target.closest('[data-acao="copiar-codigos"]');
          if (b) C.copiar(r.codigos_reserva.join('\n'), b);
        });
        return;
      }
      location.replace(r.destino || '/');
    } catch (e) {
      if (e.corpo && e.corpo.reiniciar) { location.replace('/login?erro=sessao'); return; }
      erro(e.message);
      $('enviar').disabled = false;
      $('codigo').select();
    }
  });

  $('tutorial').addEventListener('click', () => {
    if (!window.DGTour) return;
    const passos = [
      { alvo: '[data-tour="etapa"]', titulo: 'Segundo fator', oque: 'Uma segunda prova de que é você, além da senha.', como: 'O aplicativo autenticador do celular mostra um código de 6 números que muda a cada 30 segundos; o servidor calcula o mesmo e compara.', porque: 'Se alguém descobrir a sua senha, sem o seu celular não entra.' },
    ];
    if (etapa === 'ativar') passos.push({ alvo: '[data-tour="ativacao"]', titulo: 'Adicionar a conta no aplicativo', oque: 'A chave que liga o aplicativo à sua conta.', como: 'Digite a chave no aplicativo (ou toque no link, no celular). Ele passa a mostrar os códigos.', porque: 'Sem esse passo o aplicativo não sabe qual código gerar para você.' });
    passos.push({ alvo: '[data-tour="codigo"]', titulo: 'O código', oque: 'Os 6 números que o aplicativo mostra agora.', como: 'Cada código vale uma vez. Se errar 5 vezes, o servidor pede a senha de novo; com 10 erros em 15 minutos a conta tranca por 15 minutos.', porque: 'Impede que alguém tente todos os códigos até acertar.' });
    window.DGTour.inicia({ passos });
  });
})();
