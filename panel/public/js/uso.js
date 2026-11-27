const dgReviewPanelUI_uso = (s,p) => globalThis.DGI18n ? globalThis.DGI18n.frase(s,p) : s.replace(/\{([a-z_][a-z_0-9]*)\}/g,(m,k)=>p&&Object.hasOwn(p,k)?String(p[k]):m);
const dgHtmlFull_uso = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_uso = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_uso = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);
const dgFragFull_uso = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : dgPhraseFull_uso(fonte,valores).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));

const dgHtml_uso = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
// uso.js: o cartão "Uso da assinatura" da aba Status.
//
// Os números vêm de GET /api/uso (lib/provedores.js), que repassa o que o runner mediu a partir
// do próprio Claude Code ou Codex. Este arquivo só desenha: não calcula nada. Janela não medida
// aparece como "sem dado", nunca como 0%.
//
// Não depende de nenhum outro script do painel além de window.DGCLAW_BASE. O provedor.js avisa a
// forma de pagar por DGUso.definirAuth, porque em modo API não existe janela para medir.

(function () {
  const BASE = window.DGCLAW_BASE || '';
  const A_CADA_MS = 60_000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let auth = null;
  let ultimo = null; // { uso, motivo } da última resposta boa, ou { erro, comoResolver }

  /** Verde abaixo de 70, âmbar de 70 a 89, vermelho a partir de 90. */
  function corDe(pct) {
    if (pct >= 90) return 'vermelho';
    if (pct >= 70) return 'ambar';
    return 'verde';
  }

  const hhmm = (d) => d.toLocaleTimeString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'), { hour: '2-digit', minute: '2-digit' });

  /** "hoje 18:40", "amanhã 09:00", "qua 09:00" ou, depois de uma semana, "25/10 09:00". */
  function quandoZera(iso, agora = new Date()) {
    const d = new Date(iso);
    const dia0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dias = Math.round((dia0(d) - dia0(agora)) / 86_400_000);
    let rotulo;
    if (dias === 0) rotulo = dgTextFull_uso("hoje");
    else if (dias === 1) rotulo = dgTextFull_uso("amanhã");
    else if (dias > 1 && dias < 7) rotulo = d.toLocaleDateString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'), { weekday: 'short' }).replace('.', '');
    else rotulo = d.toLocaleDateString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'), { day: '2-digit', month: '2-digit' });
    return `${rotulo} ${hhmm(d)}`;
  }

  function haQuanto(iso, agora = Date.now()) {
    const t = Date.parse(iso || '');
    if (!t) return dgTextFull_uso("sem hora de medição");
    const m = Math.max(0, Math.round((agora - t) / 60_000));
    if (m < 1) return dgTextFull_uso("medido agora");
    if (m < 60) return dgPhraseFull_uso("medido há {v0} min",{v0:(m)});
    const h = Math.round(m / 60);
    if (h < 48) return dgPhraseFull_uso("medido há {v0} h",{v0:(h)});
    return dgPhraseFull_uso("medido há {v0} dias",{v0:(Math.round(h / 24))});
  }

  function linha(titulo, janela, uso, semDadoMotivo) {
    const cab = `<div class="uso-topo"><span class="uso-nome">${dgFragFull_uso(titulo)}</span>`;
    if (!janela) {
      return dgHtmlFull_uso(`<div class="uso-item">${cab}<span class="uso-pct sem"><!--dg-i18n:c5df0bcfdaaa-->sem dado<!--/dg-i18n--></span></div>`)
        + `<div class="uso-barra" role="img" aria-label="${dgFragFull_uso(titulo)}: sem dado"><i style="width:0"></i></div>`
        + `<div class="uso-pe">${esc(semDadoMotivo)}</div></div>`;
    }
    if (janela.vencida) {
      return `<div class="uso-item">${cab}<span class="uso-pct sem">zerou</span></div>`
        + `<div class="uso-barra" role="img" aria-label="${dgFragFull_uso(titulo)}: zerou"><i style="width:0"></i></div>`
        + dgHtmlFull_uso(`<div class="uso-pe">${dgFragFull_uso("zerou às {v0}, nova medição na próxima resposta",{v0:(hhmm(new Date(janela.zera_em)))})}</div></div>`);
    }
    const pct = Math.max(0, Math.min(100, janela.usado_pct));
    const txt = `${Number.isInteger(pct) ? pct : pct.toFixed(1).replace('.', ',')}%`;
    return `<div class="uso-item">${cab}<span class="uso-pct ${corDe(pct)}">${esc(txt)}</span></div>`
      + `<div class="uso-barra ${corDe(pct)}" role="img" aria-label="${dgFragFull_uso(titulo)}: ${esc(txt)} usado"><i style="width:${pct}%"></i></div>`
      + dgHtmlFull_uso(`<div class="uso-pe">${dgFragFull_uso("zera em {v0} · {v1}",{v0:(quandoZera(janela.zera_em)),v1:(haQuanto(uso.medido_em))})}</div></div>`);
  }

  function desenhar() {
    const el = document.getElementById('uso-assinatura');
    if (!el) return;
    if (auth === 'api') {
      el.innerHTML = dgHtmlFull_uso(`<p class="uso-fraco"><!--dg-i18n:bf8773e5257e-->Uso por chave de API não tem limite de janela; o custo aparece no painel do provedor.<!--/dg-i18n--></p>`);
      return;
    }
    if (!ultimo) {
      el.innerHTML = dgHtml_uso("<p class=\"uso-fraco\"><!--dg-i18n:d8322e6d1869-->Conferindo o uso...<!--/dg-i18n--></p>");
      return;
    }
    if (ultimo.erro) {
      el.innerHTML = `<p class="uso-aviso">${esc(ultimo.erro)}${ultimo.comoResolver ? ` <span class="uso-fraco">${esc(ultimo.comoResolver)}</span>` : ''}</p>`;
      return;
    }
    const uso = ultimo.uso || {};
    const naoMedido = ultimo.motivo || dgTextFull_uso("O provedor ainda não informou esta janela.");
    const semOutra = dgTextFull_uso("O provedor não informou esta janela na última medição.");
    const motivo = uso.medido_em ? semOutra : naoMedido;
    el.innerHTML = linha('Janela de 5 horas', uso.sessao_5h, uso, motivo) + linha('Semanal', uso.semanal, uso, motivo);
  }

  async function carregar() {
    const el = document.getElementById('uso-assinatura');
    if (!el) return;
    if (auth === 'api') { desenhar(); return; }
    try {
      const res = await fetch(BASE + '/api/uso');
      if (res.status === 401) { window.location = BASE + '/login.html'; return; }
      let json = {};
      try { json = await res.json(); } catch { /* resposta sem json */ }
      if (!res.ok) {
        ultimo = { erro: json.error || `Não consegui ver o uso da assinatura (erro ${res.status}).`, comoResolver: json.howToFix || '' };
      } else {
        ultimo = { uso: json.uso, motivo: json.motivo };
      }
    } catch (e) {
      ultimo = { erro: dgReviewPanelUI_uso("Não alcancei o painel para ver o uso da assinatura: {v0}",{v0:(e.message)}), comoResolver: dgReviewPanelUI_uso("Confira a internet e tente de novo.") };
    }
    desenhar();
  }

  function definirAuth(novo) {
    if (novo === auth) return;
    auth = novo;
    carregar();
  }

  const visivel = () => {
    const painel = document.getElementById('panel-status');
    return document.visibilityState === 'visible' && !!painel && painel.offsetParent !== null;
  };
  setInterval(() => { if (visivel()) carregar(); }, A_CADA_MS);
  document.addEventListener('visibilitychange', () => { if (visivel()) carregar(); });
  document.addEventListener('DOMContentLoaded', carregar);
  if (document.readyState !== 'loading') carregar();

  window.DGUso = { definirAuth, carregar, corDe, quandoZera, haQuanto };
})();
