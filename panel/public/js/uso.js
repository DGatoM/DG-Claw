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

  const hhmm = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  /** "hoje 18:40", "amanhã 09:00", "qua 09:00" ou, depois de uma semana, "25/10 09:00". */
  function quandoZera(iso, agora = new Date()) {
    const d = new Date(iso);
    const dia0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dias = Math.round((dia0(d) - dia0(agora)) / 86_400_000);
    let rotulo;
    if (dias === 0) rotulo = 'hoje';
    else if (dias === 1) rotulo = 'amanhã';
    else if (dias > 1 && dias < 7) rotulo = d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
    else rotulo = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `${rotulo} ${hhmm(d)}`;
  }

  function haQuanto(iso, agora = Date.now()) {
    const t = Date.parse(iso || '');
    if (!t) return 'sem hora de medição';
    const m = Math.max(0, Math.round((agora - t) / 60_000));
    if (m < 1) return 'medido agora';
    if (m < 60) return `medido há ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `medido há ${h} h`;
    return `medido há ${Math.round(h / 24)} dias`;
  }

  function linha(titulo, janela, uso, semDadoMotivo) {
    const cab = `<div class="uso-topo"><span class="uso-nome">${esc(titulo)}</span>`;
    if (!janela) {
      return `<div class="uso-item">${cab}<span class="uso-pct sem">sem dado</span></div>`
        + `<div class="uso-barra" role="img" aria-label="${esc(titulo)}: sem dado"><i style="width:0"></i></div>`
        + `<div class="uso-pe">${esc(semDadoMotivo)}</div></div>`;
    }
    if (janela.vencida) {
      return `<div class="uso-item">${cab}<span class="uso-pct sem">zerou</span></div>`
        + `<div class="uso-barra" role="img" aria-label="${esc(titulo)}: zerou"><i style="width:0"></i></div>`
        + `<div class="uso-pe">zerou às ${esc(hhmm(new Date(janela.zera_em)))}, nova medição na próxima resposta</div></div>`;
    }
    const pct = Math.max(0, Math.min(100, janela.usado_pct));
    const txt = `${Number.isInteger(pct) ? pct : pct.toFixed(1).replace('.', ',')}%`;
    return `<div class="uso-item">${cab}<span class="uso-pct ${corDe(pct)}">${esc(txt)}</span></div>`
      + `<div class="uso-barra ${corDe(pct)}" role="img" aria-label="${esc(titulo)}: ${esc(txt)} usado"><i style="width:${pct}%"></i></div>`
      + `<div class="uso-pe">zera em ${esc(quandoZera(janela.zera_em))} · ${esc(haQuanto(uso.medido_em))}</div></div>`;
  }

  function desenhar() {
    const el = document.getElementById('uso-assinatura');
    if (!el) return;
    if (auth === 'api') {
      el.innerHTML = '<p class="uso-fraco">Uso por chave de API não tem limite de janela; o custo aparece no painel do provedor.</p>';
      return;
    }
    if (!ultimo) {
      el.innerHTML = '<p class="uso-fraco">Conferindo o uso...</p>';
      return;
    }
    if (ultimo.erro) {
      el.innerHTML = `<p class="uso-aviso">${esc(ultimo.erro)}${ultimo.comoResolver ? ` <span class="uso-fraco">${esc(ultimo.comoResolver)}</span>` : ''}</p>`;
      return;
    }
    const uso = ultimo.uso || {};
    const naoMedido = ultimo.motivo || 'O provedor ainda não informou esta janela.';
    const semOutra = 'O provedor não informou esta janela na última medição.';
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
      ultimo = { erro: `Não alcancei o painel para ver o uso da assinatura: ${e.message}`, comoResolver: 'Confira a internet e tente de novo.' };
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
