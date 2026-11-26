'use strict';
const dgUiText_login_expirado_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
/* login-expirado.js: a parte pura do pop-up "Seu login do Claude expirou" da conversa.

   Sem DOM e sem rede: decide quando o pop-up aparece, quando fica dispensado e o que ele diz.
   O desenho e as chamadas ficam em conversa.js; aqui fica o que se pode testar com node:test
   (web/test/login-expirado.test.js). O estado que alimenta tudo é a foto de atividade do agente,
   com alerta 'login_expirado', `expirou_em` (ISO) e `provedor`. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGLoginExpirado = m;
})(this, function () {
  /* Quanto o pop-up espera o agente voltar depois do login antes de mostrar o motivo e o botão Reiniciar. */
  const PRAZO_VOLTA_MS = 90 * 1000;
  /* "Pronto, <Nome> voltou." fica na tela por este tempo e fecha sozinho. */
  const FECHA_PRONTO_MS = 3000;

  const nomeProvedor = p => (/codex/i.test(String(p || '')) ? 'Codex' : 'Claude');

  /** "14:05" no fuso do painel (o mesmo das outras horas da conversa); '' se o ISO for inválido. */
  function hora(iso, fuso) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    return new Date(t).toLocaleTimeString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'), { hour: '2-digit', minute: '2-digit', timeZone: fuso || 'America/Sao_Paulo' });
  }

  /** Um incidente = um agente + o instante em que o login morreu. Sem instante, o `desde` da foto faz o papel. */
  function chaveDoIncidente(agenteId, est) {
    return String(agenteId) + '|' + String((est && (est.expirou_em || est.desde)) || '');
  }

  /** `est` é a entrada do agente na foto de atividade. */
  const expirado = est => !!est && est.alerta === 'login_expirado';

  /**
   * O pop-up deve estar na tela? `forcado` é o envio recusado com LOGIN_EXPIRADO: a pessoa acabou de
   * tentar falar com o agente, então vale mesmo que ela tenha dito "Agora não" para este incidente.
   */
  function deveMostrar({ agenteId, est, dispensados, forcado }) {
    if (forcado) return true;
    if (!expirado(est)) return false;
    return !(dispensados || {})[chaveDoIncidente(agenteId, est)];
  }

  /** Mapa novo com o incidente marcado como dispensado (só para este agente + este instante). */
  function dispensar(mapa, agenteId, est) {
    return Object.assign({}, mapa || {}, { [chaveDoIncidente(agenteId, est)]: true });
  }

  /**
   * O que fazer a cada foto de atividade.
   * `fase`: 'aviso' (perguntando), 'cartao' (a pessoa está no login), 'reiniciando' (esperando o agente voltar).
   * Devolve 'abrir' | 'aguardar_volta' | 'nada'. 'aguardar_volta' é: o alerta sumiu com o pop-up ainda
   * aberto fora do 'reiniciando' (login feito pelo terminal, ou o runner reiniciou sozinho), então
   * passa a esperar o "voltou".
   */
  function decisao({ aberto, fase, agenteId, est, dispensados }) {
    if (expirado(est)) return !aberto && deveMostrar({ agenteId, est, dispensados }) ? 'abrir' : 'nada';
    if (aberto && (fase === 'aviso' || fase === 'cartao')) return 'aguardar_volta';
    return 'nada';
  }

  /** Os textos de cada fase. `nome` é o do agente; o texto evita gênero. */
  function textos({ nome, provedor, expirouEm, motivo }) {
    const prov = nomeProvedor(provedor);
    const h = hora(expirouEm);
    return {
      get titulo() { return dgUiText_login_expirado_js("Seu login do ") + prov + ' expirou'; },
      corpo: (h ? dgUiText_login_expirado_js("A sessão de ") + nome + dgUiText_login_expirado_js(" parou de responder às ") + h + dgUiText_login_expirado_js(" porque a conta do ") + prov + ' saiu. '
                : dgUiText_login_expirado_js("A sessão de ") + nome + dgUiText_login_expirado_js(" parou de responder porque a conta do ") + prov + ' saiu. ') +
        dgUiText_login_expirado_js("O que você mandou desde então ficou sem resposta. Reconecte a conta e eu reinicio a sessão dela sozinho."),
      primario: dgUiText_login_expirado_js("Reconectar conta do ") + prov,
      secundario: dgUiText_login_expirado_js("Reiniciar a sessão"),
      agoraNao: dgUiText_login_expirado_js("Agora não"),
      reiniciando: dgUiText_login_expirado_js("Reiniciando a sessão de ") + nome + '…',
      pronto: 'Pronto, ' + nome + ' voltou.',
      naoVoltou: 'Passaram ' + Math.round(PRAZO_VOLTA_MS / 1000) + ' s e ' + nome + dgUiText_login_expirado_js(" ainda não voltou a responder.") +
        (motivo ? ' ' + motivo : dgUiText_login_expirado_js(" Tente reiniciar a sessão.")),
    };
  }

  return { PRAZO_VOLTA_MS, FECHA_PRONTO_MS, nomeProvedor, hora, chaveDoIncidente, expirado, deveMostrar, dispensar, decisao, textos };
});
