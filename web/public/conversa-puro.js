'use strict';
/* conversa-puro.js: regras da conversa que não dependem da tela (testadas em web/test/conversa-puro.test.js).
   Carregado antes do conversa.js; no navegador vira window.DGConversaPuro. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGConversaPuro = m;
})(this, function () {
  /* Aviso amarelo fechado no ✕ descansa 48 h. A assinatura troca número por #, então
     "92%" e "93%" contam como o mesmo aviso. */
  const AVISO_DESCANSO_MS = 48 * 3600 * 1000;

  const assinaturaAviso = t => String(t).replace(/\d+(?:[.,]\d+)*/g, '#').trim();

  /** `mapa` é { assinatura: timestamp do fechamento }. */
  function avisoDescansando(mapa, texto, agora) {
    const quando = (mapa || {})[assinaturaAviso(texto)];
    return typeof quando === 'number' && agora - quando < AVISO_DESCANSO_MS;
  }

  /** Devolve um mapa novo com o aviso marcado como fechado agora e as assinaturas vencidas removidas. */
  function registraFechamento(mapa, texto, agora) {
    const novo = {};
    for (const [k, v] of Object.entries(mapa || {})) {
      if (typeof v === 'number' && agora - v < AVISO_DESCANSO_MS) novo[k] = v;
    }
    novo[assinaturaAviso(texto)] = agora;
    return novo;
  }

  /* Áudio transcrito: o texto que vai ao agente leva esta marca quando foi enviado direto, sem a
     pessoa revisar. O agente sabe que pode haver erro de transcrição; o balão esconde a marca e
     mostra um microfone discreto. */
  const MARCA_AUDIO = '[áudio transcrito] ';

  const marcaAudio = texto => MARCA_AUDIO + texto;

  /** O que vai ao agente depois de uma transcrição: marcado no envio direto, cru quando vai ao campo para revisar. */
  const textoDaFala = (texto, manda) => (manda ? marcaAudio(texto) : String(texto));

  /** { audio, texto }: tira a marca do começo, se houver. Mensagem sem marca volta igual. */
  function separaAudio(texto) {
    const t = String(texto == null ? '' : texto);
    if (t.startsWith(MARCA_AUDIO)) return { audio: true, texto: t.slice(MARCA_AUDIO.length) };
    return { audio: false, texto: t };
  }

  /**
   * Reinício da sessão: decide a cada olhada se o agente voltou. Só conta retrato NOVO do servidor
   * (`foto.agora`, em segundos): maior que o `marco` do pedido e diferente do último já contado.
   * Devolve { acao: 'esperar'|'voltou'|'sem_login'|'login_expirado', vivas, ultimoAgora, motivo? }.
   * "Voltou" = 2 retratos novos seguidos com o agente fora de sem_sinal, stream aberto e 3 s passados.
   */
  function avaliaVolta({ marco, ultimoAgora, vivas, foto, agenteId, streamAberto, decorridoMs }) {
    const parado = { acao: 'esperar', vivas: vivas || 0, ultimoAgora: ultimoAgora == null ? null : ultimoAgora };
    if (!foto || typeof foto.agora !== 'number' || !(foto.agora > marco) || foto.agora === ultimoAgora) return parado;
    const est = foto.agentes ? foto.agentes[agenteId] : null;
    if (est && est.alerta === 'sem_login') return { acao: 'sem_login', vivas: 0, ultimoAgora: foto.agora, motivo: est.motivo || null };
    // O login ainda (ou de novo) expirado. Nos primeiros 3 s um retrato com este alerta pode ser o do
    // estado de ANTES do reinício, ainda em cache: espera, como espera a volta.
    if (est && est.alerta === 'login_expirado') {
      if (decorridoMs < 3000) return { acao: 'esperar', vivas: 0, ultimoAgora: foto.agora };
      return { acao: 'login_expirado', vivas: 0, ultimoAgora: foto.agora, motivo: est.motivo || null };
    }
    const n = est && est.estado !== 'sem_sinal' && streamAberto && decorridoMs >= 3000 ? (vivas || 0) + 1 : 0;
    return { acao: n >= 2 ? 'voltou' : 'esperar', vivas: n, ultimoAgora: foto.agora };
  }

  return { avaliaVolta, AVISO_DESCANSO_MS, MARCA_AUDIO, assinaturaAviso, avisoDescansando, registraFechamento, marcaAudio, textoDaFala, separaAudio };
});
