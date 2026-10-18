'use strict';
/* conta-comum.js: peças que as telas Minha conta (/conta), Usuários (/usuarios) e a do segundo fator (/login/2fa) dividem.
   Parte pura (com teste em web/test/ent-usuarios-tela.test.js): esc, dataBr, resumoUa, htmlSessoes, htmlSegredo, htmlCodigosReserva.
   Parte com DOM: api() (fetch com erro que se explica) e copiar(). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGContaComum = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* epoch em ms -> "18/10/2026 14:05". Sem data (null) é "nunca", nunca "01/01/1970". */
  function dataBr(ms, fuso) {
    if (ms == null || !Number.isFinite(Number(ms))) return 'nunca';
    const d = new Date(Number(ms));
    const o = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
    if (fuso) o.timeZone = fuso;
    return d.toLocaleString('pt-BR', o).replace(',', '');
  }

  /* "Mozilla/5.0 (Windows NT 10.0) ... Chrome/120" -> "Chrome em Windows". Só para a pessoa reconhecer o aparelho. */
  function resumoUa(ua) {
    const t = String(ua || '');
    if (!t) return 'aparelho desconhecido';
    const nav = /Edg\//.test(t) ? 'Edge' : /OPR\/|Opera/.test(t) ? 'Opera' : /Firefox\//.test(t) ? 'Firefox'
      : /Chrome\//.test(t) ? 'Chrome' : /Safari\//.test(t) ? 'Safari' : 'navegador';
    const so = /Windows/.test(t) ? 'Windows' : /Android/.test(t) ? 'Android' : /iPhone|iPad|iOS/.test(t) ? 'iPhone/iPad'
      : /Mac OS X|Macintosh/.test(t) ? 'Mac' : /Linux/.test(t) ? 'Linux' : '';
    return so ? `${nav} em ${so}` : nav;
  }

  /* Lista de sessões em cartões. opcoes: { botao: 'texto do botão por sessão' | null } */
  function htmlSessoes(lista, opcoes) {
    const o = opcoes || {};
    if (!lista || !lista.length) return '<p class="cn-vazio">Nenhuma sessão aberta.</p>';
    return '<ul class="cn-lista">' + lista.map(s =>
      '<li class="cn-item' + (s.atual ? ' cn-atual' : '') + '" data-sessao="' + esc(s.id) + '">' +
      '<div class="cn-linha"><b>' + esc(resumoUa(s.ua)) + '</b>' + (s.atual ? ' <span class="cn-selo cn-on">esta aqui</span>' : '') + '</div>' +
      '<div class="cn-fraco">IP ' + esc(s.ip || 'desconhecido') + ' · aberta em ' + esc(dataBr(s.criada)) +
      ' · último uso ' + esc(dataBr(s.ultimo_uso)) + ' · vale até ' + esc(dataBr(s.expira)) + '</div>' +
      (o.botao ? '<button type="button" class="cn-btn cn-mini" data-acao="sair-sessao" data-id="' + esc(s.id) + '">' + esc(o.botao) + '</button>' : '') +
      '</li>').join('') + '</ul>';
  }

  /* O segredo do 2FA: grupos de 4 para digitar à mão, e o link otpauth para abrir no aplicativo (no celular). */
  function htmlSegredo(d) {
    return '<div class="cn-segredo">' +
      '<p>1. Abra o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password...) e adicione uma conta <b>digitando a chave</b>:</p>' +
      '<p class="cn-chave" data-chave>' + esc(d.segredo_agrupado) + '</p>' +
      '<p class="cn-fraco">Tipo de chave: baseada em tempo. No celular, <a href="' + esc(d.otpauth) + '">toque aqui para abrir direto no aplicativo</a>.</p>' +
      '<p>2. Digite abaixo o código de 6 números que o aplicativo mostrar.</p></div>';
  }

  function htmlCodigosReserva(codigos) {
    return '<div class="cn-reserva" data-reserva>' +
      '<p><b>Guarde estes ' + (codigos || []).length + ' códigos de reserva agora.</b> Eles não aparecem de novo. Cada um vale uma vez, para o dia em que você perder o celular.</p>' +
      '<ul class="cn-codigos">' + (codigos || []).map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' +
      '<button type="button" class="cn-btn" data-acao="copiar-codigos">Copiar os códigos</button></div>';
  }

  const puros = { esc, dataBr, resumoUa, htmlSessoes, htmlSegredo, htmlCodigosReserva };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  /* fetch JSON que explica o erro: o servidor manda { erro } em português; falha de rede também vira frase. */
  async function api(metodo, url, corpo) {
    let r;
    try {
      r = await fetch(url, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: Object.assign({ Accept: 'application/json' }, corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
    } catch (e) {
      throw new Error('Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.');
    }
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Sua sessão acabou. Entre de novo.'); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) {
      const e = new Error((d && d.erro) || ('O servidor respondeu ' + r.status + ' sem explicar. Veja o log do dgclaw-web (journalctl -u dgclaw-web).'));
      e.status = r.status; e.corpo = d;
      throw e;
    }
    return d;
  }

  async function copiar(texto, botao) {
    const antes = botao.textContent;
    try {
      await navigator.clipboard.writeText(texto);
      botao.textContent = 'Copiado';
    } catch (e) {
      botao.textContent = 'Não consegui copiar: selecione e copie à mão';
    }
    setTimeout(() => { botao.textContent = antes; }, 2500);
  }

  return Object.assign({ api, copiar }, puros);
});
