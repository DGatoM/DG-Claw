'use strict';
const dgUiText_atualizacao_faixa_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgUiHtml_atualizacao_faixa_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
const dgUiLabel_atualizacao_faixa_js = (el, fonte, atributo) => { if (globalThis.DGI18n) globalThis.DGI18n.rotulo(el, fonte, atributo); else if (atributo) el.setAttribute(atributo, fonte); else el.textContent = fonte; };
/* atualizacao-faixa.js: a faixa discreta "Nova versão do DG Claw disponível" no alto das telas.

   Lê GET /api/v1/atualizacao ao carregar, a cada 30 minutos e quando a aba volta ao foco. Só aparece
   quando o servidor diz mostrar_faixa. Botões: "Ver o que mudou" (abre a lista), "Instalar" (leva ao
   chat do Admin com o pedido já escrito no campo, SEM enviar) e "Agora não" (a faixa descansa até sair
   uma versão mais nova). Erro de rede ou do servidor não mostra nada nem quebra a tela.
   As novidades são texto do CHANGELOG do GitHub: tudo passa por esc() antes de virar HTML.
   Contrato das rotas: web/docs/ATUALIZACAO.md. As funções que só montam HTML ficam fora do DOM e
   têm teste em web/test/atualizacao-faixa.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGAtualizacaoFaixa = m;
})(this, function (raiz) {
  const POLL_MS = 30 * 60 * 1000;
  const TEXTO_INSTALAR = 'Quero instalar a atualização do DG Claw';
  const CAMINHO_ADMIN = '/a/admin';

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Números diferentes: só os números ("1.0.0 → 1.1.0"). Números iguais ou ausentes de um lado: o commit curto
     (7 caracteres) vai junto ("1.0.0 (abc1234) → 1.0.0 (def5678)"); sem número, só o commit. */
  function nomeDaVersao(v, comCommit, tam) {
    if (!v || typeof v !== 'object') return '?';
    const curto = typeof v.commit === 'string' ? v.commit.slice(0, tam) : '';
    if (typeof v.versao === 'string' && v.versao) return comCommit && curto ? v.versao + ' (' + curto + ')' : v.versao;
    return curto || '?';
  }

  function rotuloVersoes(estado) {
    const i = estado && estado.instalado, p = estado && estado.publicado;
    const num = v => v && typeof v.versao === 'string' && v.versao;
    const comCommit = !(num(i) && num(p) && i.versao !== p.versao);
    /* 7 caracteres; se os dois commits começam igual, aumenta (até 40) para o rótulo distinguir, nos dois lados. */
    let tam = 7;
    const ci = i && typeof i.commit === 'string' ? i.commit : '', cp = p && typeof p.commit === 'string' ? p.commit : '';
    while (tam < 40 && ci && cp && ci !== cp && ci.slice(0, tam) === cp.slice(0, tam)) tam++;
    return nomeDaVersao(i, comCommit, tam) + ' → ' + nomeDaVersao(p, comCommit, tam);
  }

  function novidadesHtml(lista) {
    const itens = (Array.isArray(lista) ? lista : []).filter(n => typeof n === 'string' && n);
    if (!itens.length) return dgUiHtml_atualizacao_faixa_js("<li><!--dg-i18n:60ff2290828b-->O GitHub não trouxe o detalhe do que mudou. Pergunte ao Admin: ele resume para você.<!--/dg-i18n--></li>");
    return itens.map(n => `<li>${esc(n)}</li>`).join('');
  }

  function faixaHtml(estado) {
    return '<div class="af-linha"><span class="af-tit">' + dsIcone('sparkle') + dgUiText_atualizacao_faixa_js(" Nova versão do DG Claw disponível ") +
      `<b>(${esc(rotuloVersoes(estado))})</b></span>` +
      '<span class="af-acoes">' +
      dgUiHtml_atualizacao_faixa_js("<button type=\"button\" class=\"af-btn\" data-af=\"ver\" aria-expanded=\"false\" aria-controls=\"faixaAtualizacaoLista\"><!--dg-i18n:87060d6b889e-->Ver o que mudou<!--/dg-i18n--></button>") +
      dgUiHtml_atualizacao_faixa_js("<button type=\"button\" class=\"af-btn af-instalar\" data-af=\"instalar\"><!--dg-i18n:8e8a1dd48676-->Instalar<!--/dg-i18n--></button>") +
      dgUiHtml_atualizacao_faixa_js("<button type=\"button\" class=\"af-btn\" data-af=\"descansar\"><!--dg-i18n:a73293ea3f24-->Agora não<!--/dg-i18n--></button>") +
      dgUiHtml_atualizacao_faixa_js("<button type=\"button\" class=\"af-ajuda\" data-af=\"ajuda\" aria-label=\"Tutorial da faixa de atualização\" data-dg-i18n-aria-label=\"a3d515d5ccc4\" title=\"O que é esta faixa\" data-dg-i18n-title=\"cd9f6ab3f6a0\">?</button>") +
      '</span></div>' +
      `<ul class="af-lista" id="faixaAtualizacaoLista" hidden>${novidadesHtml(estado && estado.novidades)}</ul>` +
      '<p class="af-erro" role="alert" hidden></p>';
  }

  const PASSO = {
    alvo: '#faixaAtualizacao',
    titulo: 'Aviso de versão nova',
    oque: 'Um aviso de que saiu uma versão nova do DG Claw. Mostra a versão que você tem e a que está publicada, e o que mudou.',
    como: 'A cada 6 horas o servidor olha, de forma pública e sem enviar nada seu, se o repositório oficial do DG Claw ganhou novidades. Se ganhou, esta faixa aparece. Ver o que mudou abre a lista. Instalar leva você ao Admin com o pedido já escrito (você só envia). Agora não esconde o aviso até sair uma versão mais nova.',
    porque: 'Para você saber quando há novidade sem ter que procurar, e decidir se instala agora ou depois. Nada é instalado sozinho.',
  };

  if (!raiz.document) return { esc, nomeDaVersao, rotuloVersoes, novidadesHtml, faixaHtml, PASSO, TEXTO_INSTALAR, CAMINHO_ADMIN };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let faixa = null;
  let atual = null;
  let ocupado = false;

  function garanteCss() {
    if (document.querySelector('link[href="/atualizacao-faixa.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/atualizacao-faixa.css';
    document.head.appendChild(l);
  }

  function garanteFaixa() {
    if (faixa) return;
    garanteCss();
    faixa = document.createElement('section');
    faixa.id = 'faixaAtualizacao';
    faixa.className = 'af';
    faixa.setAttribute('role', 'region');
    dgUiLabel_atualizacao_faixa_js(faixa, "Nova versão do DG Claw", "aria-label");
    faixa.hidden = true;
    const cab = document.querySelector('header');
    if (cab && cab.parentNode) cab.parentNode.insertBefore(faixa, cab.nextSibling);
    else document.body.insertBefore(faixa, document.body.firstChild);
    faixa.addEventListener('click', aoClicar);
  }

  function mostraErro(texto) {
    const e = faixa && faixa.querySelector('.af-erro');
    if (!e) return;
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  function pinta(estado) {
    if (!estado || !estado.mostrar_faixa) {
      if (faixa) { faixa.hidden = true; faixa.innerHTML = ''; }
      atual = null;
      return;
    }
    garanteFaixa();
    const mudou = !atual || !atual.publicado || atual.publicado.commit !== estado.publicado.commit;
    atual = estado;
    if (mudou || faixa.hidden) { faixa.innerHTML = faixaHtml(estado); }
    faixa.hidden = false;
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      let r;
      try { r = await fetch('/api/v1/atualizacao', { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
        return;   // sem rede: a faixa fica como está e tenta de novo na próxima volta
      }
      if (!r.ok) {
        if (r.status !== 401) console.warn('atualizacao-faixa: o servidor respondeu ' + r.status + ' em /api/v1/atualizacao; sigo sem a faixa.');
        return;
      }
      let json = null;
      try { json = await r.json(); } catch (e) { console.warn('atualizacao-faixa: a resposta não veio em JSON:', e.message); return; }
      pinta(json);
    } finally { ocupado = false; }
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => mostraErro(dgUiText_atualizacao_faixa_js("A visita guiada não carregou. Recarregue a página e tente de novo."));
    document.head.appendChild(s);
  }

  /* A tela Segurança reaproveita esta função com o texto do pedido de cada boletim e de cada falha (seguranca.js).
   Estando no chat do Admin, escreve no campo; senão vai para lá com ?texto= (a conversa preenche e não envia). */
  function instalar(textoPedido) {
    const texto = typeof textoPedido === 'string' && textoPedido ? textoPedido : TEXTO_INSTALAR;
    const campo = document.getElementById('entrada');
    if (campo && location.pathname.replace(/\/+$/, '') === CAMINHO_ADMIN) {
      campo.value = texto;
      campo.dispatchEvent(new Event('input'));
      campo.focus();
      return;
    }
    location.href = CAMINHO_ADMIN + '?texto=' + encodeURIComponent(texto);
  }

  async function descansar(botao) {
    if (!atual || !atual.publicado) return;
    botao.disabled = true;
    let r; let json = null;
    try {
      r = await fetch('/api/v1/atualizacao/descansar', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit: atual.publicado.commit }),
      });
      try { json = await r.json(); } catch (e) { json = null; }
    } catch (e) {
      botao.disabled = false;
      mostraErro(dgUiText_atualizacao_faixa_js("Não consegui falar com o servidor (") + e.message + dgUiText_atualizacao_faixa_js("). Confira a conexão e toque de novo."));
      return;
    }
    if (!r.ok) {
      botao.disabled = false;
      mostraErro((json && json.erro) || ('O servidor respondeu ' + r.status + dgUiText_atualizacao_faixa_js('. Atualize a página e tente de novo.')));
      return;
    }
    pinta(null);
  }

  function aoClicar(ev) {
    const b = ev.target.closest('button[data-af]');
    if (!b) return;
    const acao = b.dataset.af;
    if (acao === 'ver') {
      const lista = faixa.querySelector('.af-lista');
      lista.hidden = !lista.hidden;
      b.setAttribute('aria-expanded', String(!lista.hidden));
    } else if (acao === 'instalar') instalar();
    else if (acao === 'descansar') descansar(b);
    else if (acao === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: [PASSO] }));
  }

  function inicia() {
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  // Aviso de versão nova é só do dono.
  if (raiz.DGPapel && raiz.DGPapel.colaborador) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { esc, nomeDaVersao, rotuloVersoes, novidadesHtml, faixaHtml, PASSO, TEXTO_INSTALAR, CAMINHO_ADMIN, atualiza, instalar };
});
