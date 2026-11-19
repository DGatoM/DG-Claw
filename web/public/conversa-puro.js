'use strict';
/* conversa-puro.js: regras da conversa que não dependem da tela (testadas em web/test/conversa-puro.test.js).
   Carregado antes do conversa.js; no navegador vira window.DGConversaPuro. */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGConversaPuro = m;
})(this, function () {
  /* Aviso amarelo fechado no X descansa 48 h. A assinatura troca número por #, então
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

  /**
   * Baixar arquivo no app instalado no iPhone (PWA). Um link com `download` ali leva a JANELA DO APP para o arquivo e
   * não há botão de voltar. Então o app nunca navega: busca o arquivo, entrega pela folha de compartilhamento do
   * sistema ("Salvar em Arquivos") e, se o aparelho não compartilhar arquivo, abre uma aba do sistema, que tem o
   * "Concluído" para voltar. O iPhone só deixa compartilhar ou abrir aba logo depois de um toque, e a busca pode
   * demorar mais que isso: quando ele recusa, o arquivo fica pronto em `cache` e o SEGUNDO toque age na hora, sem
   * buscar de novo. Sem `canShare` no aparelho nem se busca: a aba abre direto no toque.
   * `deps`: { fetch, nav, criarArquivo(blob, nome, tipo), abrir(url), cache: {} }.
   * Devolve { via: 'compartilhado' | 'aba' | 'cancelado' | 'segundo-toque' | 'erro', erro? }.
   */
  const TAMANHO_MAX_BLOB = 40 * 1024 * 1024;

  async function baixarNoPwaIos(url, nome, deps) {
    const { nav, cache } = deps;
    const comAba = u => u + (u.includes('?') ? '&' : '?') + 'baixar=1';
    const limpa = () => { cache.url = null; cache.arq = null; cache.modo = null; };
    try {
      const podeCompartilhar = !!(nav && typeof nav.canShare === 'function' && typeof nav.share === 'function');
      if (cache.url === url && cache.modo === 'abrir') { limpa(); deps.abrir(comAba(url)); return { via: 'aba' }; }
      if (!podeCompartilhar) { deps.abrir(comAba(url)); return { via: 'aba' }; }
      let arq = cache.url === url ? cache.arq : null;
      if (!arq) {
        const r = await deps.fetch(url, { credentials: 'same-origin' });
        if (!r.ok) return { via: 'erro', erro: 'o app respondeu ' + r.status };
        const tam = Number(r.headers && r.headers.get && r.headers.get('Content-Length'));
        if (tam > TAMANHO_MAX_BLOB) {
          // arquivo grande (vídeo): não vai para a memória do app. Guarda só o endereço e abre a aba no toque seguinte.
          if (r.body && typeof r.body.cancel === 'function') r.body.cancel();
          cache.url = url; cache.arq = null; cache.modo = 'abrir';
          return { via: 'segundo-toque' };
        }
        const doCab = (/filename\*=UTF-8''([^;]+)/i.exec((r.headers && r.headers.get && r.headers.get('Content-Disposition')) || '') || [])[1];
        const blob = await r.blob();
        arq = deps.criarArquivo(blob, nome || (doCab ? decodeURIComponent(doCab) : 'arquivo'), blob.type || 'application/octet-stream');
      }
      if (!nav.canShare({ files: [arq] })) {
        // o aparelho não compartilha este tipo: a aba só abre num toque novo, então o arquivo já baixado espera por ele
        cache.url = url; cache.arq = null; cache.modo = 'abrir';   // só o endereço: a aba busca o arquivo por conta própria
        return { via: 'segundo-toque' };
      }
      try {
        await nav.share({ files: [arq] });
        limpa();
        return { via: 'compartilhado' };
      } catch (e) {
        if (e && e.name === 'AbortError') { limpa(); return { via: 'cancelado' }; }
        if (e && e.name === 'NotAllowedError') {
          if (cache.url === url && cache.modo === 'compartilhar') {
            // já era o segundo toque, com o arquivo pronto, e o aparelho recusou de novo: abre a aba, que sempre deixa salvar
            limpa(); deps.abrir(comAba(url)); return { via: 'aba' };
          }
          cache.url = url; cache.arq = arq; cache.modo = 'compartilhar';
          return { via: 'segundo-toque' };
        }
        throw e;
      }
    } catch (e) {
      return { via: 'erro', erro: e && e.message ? e.message : String(e) };
    }
  }

  return { avaliaVolta, AVISO_DESCANSO_MS, MARCA_AUDIO, assinaturaAviso, avisoDescansando, registraFechamento, marcaAudio, textoDaFala, separaAudio, baixarNoPwaIos };
});
