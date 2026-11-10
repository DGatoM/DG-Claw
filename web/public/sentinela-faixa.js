'use strict';
/* sentinela-faixa.js: a faixa de alerta da saúde do servidor no alto das telas.

   Lê GET /api/v1/sentinela ao carregar, a cada minuto e quando a aba volta ao foco. Só aparece quando o nível geral é
   sério ou crítico, ou quando algum agente está fora do ar. Vermelha no crítico (não some), laranja no sério (o dono
   pode recolher por 1 hora, neste aparelho). Erro de rede ou do servidor não mostra nada nem quebra a tela.
   O texto vem do estado da sentinela: tudo passa por esc() antes de virar HTML. Contrato: web/docs/SENTINELA.md.
   As funções que só montam texto e HTML ficam fora do DOM e têm teste em web/test/sentinela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGSentinelaFaixa = m;
})(this, function (raiz) {
  const POLL_MS = 60 * 1000;
  const RECOLHE_MS = 60 * 60 * 1000;
  const CHAVE_RECOLHIDA = 'dgclaw:sentinela:faixa-recolhida';
  const ALVO = '/seguranca#saude-servidor';

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) + '%' : null);

  /* Vigia parada: sem ela não sai nenhum alarme. Só quando a API marcou parada (instalado falso não entra: instalação nova). */
  function paradaSituacao(estado) {
    if (!estado || estado.instalado !== true || estado.parada !== true) return null;
    const min = typeof estado.idade_s === 'number' && Number.isFinite(estado.idade_s) ? Math.round(estado.idade_s / 60) : null;
    return { nivel: 'serio', parada: true, texto: 'A vigia do servidor parou de atualizar' + (min == null ? '' : ' há ' + min + ' min') + ': os alarmes de disco e memória estão desligados. Peça ao Admin para conferir.' };
  }

  /* { nivel: 'critico'|'serio', texto } ou null quando não há o que mostrar. Escolhe a causa mais grave. */
  function situacao(estado) {
    if (!estado || estado.instalado !== true) return null;
    const agentes = Array.isArray(estado.agentes) ? estado.agentes : [];
    const caidos = agentes.filter(a => a && (a.estado === 'caido' || a.estado === 'canal_caido'));
    const servicos = (Array.isArray(estado.servicos) ? estado.servicos : []).filter(s => s && s.ativo === false);
    const geral = estado.nivel_geral;
    if (geral !== 'serio' && geral !== 'critico' && !caidos.length) return paradaSituacao(estado);
    const nivel = geral === 'critico' || caidos.length ? 'critico' : 'serio';

    if (caidos.length) {
      const a = caidos[0];
      const nome = a.nome || a.slug || 'Um agente';
      const mais = caidos.length > 1 ? ' (e mais ' + (caidos.length - 1) + ')' : '';
      return { nivel, texto: a.estado === 'canal_caido'
        ? 'O WhatsApp do agente ' + nome + ' parou' + mais + ': os clientes não recebem resposta.'
        : 'O agente ' + nome + ' está fora do ar' + mais + ': os clientes não recebem resposta.' };
    }
    if (servicos.length) {
      return { nivel, texto: 'O serviço ' + (servicos[0].nome || 'do servidor') + ' parou: o painel ou os agentes podem ficar sem acesso.' };
    }
    const disco = (Array.isArray(estado.disco) ? estado.disco : [])
      .filter(d => d && (d.nivel === 'serio' || d.nivel === 'critico') && typeof d.usado_pct === 'number')
      .sort((a, b) => b.usado_pct - a.usado_pct)[0];
    if (disco && (!estado.ram || estado.ram.nivel !== 'critico' || disco.nivel === 'critico')) {
      return { nivel, texto: 'Disco do servidor em ' + pct(disco.usado_pct) + ': os agentes podem parar.' };
    }
    const ram = estado.ram || {};
    if ((ram.nivel === 'serio' || ram.nivel === 'critico') && pct(ram.usado_pct)) {
      return { nivel, texto: 'Memória do servidor em ' + pct(ram.usado_pct) + ': os agentes podem ficar lentos ou parar.' };
    }
    return { nivel, texto: 'O servidor está com um problema que pede atenção.' };
  }

  function faixaHtml(sit, noCartao) {
    const href = noCartao ? '#saude-servidor' : ALVO;
    return '<div class="sf-linha"><span class="sf-tit">' + (sit.nivel === 'critico' ? '🔴 ' : '🟠 ') + esc(sit.texto) +
      ' <a class="sf-link" href="' + href + '">Ver o que fazer</a></span>' +
      '<span class="sf-acoes">' +
      (sit.nivel === 'serio' ? '<button type="button" class="sf-btn" data-sf="recolher">Agora não</button>' : '') +
      '<button type="button" class="sf-ajuda" data-sf="ajuda" aria-label="Tutorial da faixa de alerta do servidor" title="O que é esta faixa">?</button>' +
      '</span></div>';
  }

  const PASSO = {
    alvo: '#faixaSentinela',
    titulo: 'Alerta do servidor',
    oque: 'Um aviso de que o servidor está com disco ou memória acima do normal, ou de que um agente saiu do ar.',
    como: 'A sentinela do servidor mede o disco e a memória a cada minuto e vê se cada agente responde. Vermelha é crítico: o servidor pode parar a qualquer momento. Laranja é sério: dá tempo de agir, e você pode recolher o aviso por 1 hora. Ver o que fazer leva ao cartão Saúde do servidor.',
    porque: 'Servidor com disco cheio ou sem memória derruba os agentes que atendem os seus clientes. Avisar cedo, em todas as telas, é o que dá tempo de resolver antes disso.',
  };

  if (!raiz.document) return { esc, situacao, faixaHtml, PASSO, CHAVE_RECOLHIDA, RECOLHE_MS };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let faixa = null;
  let ocupado = false;
  let atual = null;

  function garanteCss() {
    if (document.querySelector('link[href="/sentinela-faixa.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/sentinela-faixa.css';
    document.head.appendChild(l);
  }

  function garanteFaixa() {
    if (faixa) return;
    garanteCss();
    faixa = document.createElement('section');
    faixa.id = 'faixaSentinela';
    faixa.setAttribute('role', 'alert');
    faixa.setAttribute('aria-label', 'Alerta do servidor');
    faixa.hidden = true;
    const cab = document.querySelector('header');
    if (cab && cab.parentNode) cab.parentNode.insertBefore(faixa, cab.nextSibling);
    else document.body.insertBefore(faixa, document.body.firstChild);
    faixa.addEventListener('click', aoClicar);
  }

  function recolhidaAte() {
    try { return Number(raiz.localStorage.getItem(CHAVE_RECOLHIDA)) || 0; } catch (e) { return 0; }
  }

  function pinta(sit) {
    atual = sit;
    if (!sit || (sit.nivel === 'serio' && recolhidaAte() > Date.now())) {
      if (faixa) { faixa.hidden = true; faixa.innerHTML = ''; }
      return;
    }
    garanteFaixa();
    faixa.className = 'sf sf-' + sit.nivel;
    faixa.innerHTML = faixaHtml(sit, location.pathname.replace(/\/+$/, '') === '/seguranca');
    faixa.hidden = false;
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      let r;
      try { r = await fetch('/api/v1/sentinela', { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
        return;   // sem rede: a faixa fica como está e tenta de novo na próxima volta
      }
      if (!r.ok) {
        if (r.status !== 401) console.warn('sentinela-faixa: o servidor respondeu ' + r.status + ' em /api/v1/sentinela; sigo sem a faixa.');
        return;
      }
      let json = null;
      try { json = await r.json(); } catch (e) { console.warn('sentinela-faixa: a resposta não veio em JSON:', e.message); return; }
      pinta(situacao(json));
    } finally { ocupado = false; }
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => console.warn('sentinela-faixa: a visita guiada (/tour.js) não carregou; recarregue a página.');
    document.head.appendChild(s);
  }

  function aoClicar(ev) {
    const b = ev.target.closest('button[data-sf]');
    if (!b) return;
    if (b.dataset.sf === 'recolher') {
      // No crítico a faixa não some: o botão nem existe, e esta checagem é a segunda trava.
      if (!atual || atual.nivel !== 'serio') return;
      try { raiz.localStorage.setItem(CHAVE_RECOLHIDA, String(Date.now() + RECOLHE_MS)); } catch (e) {
        console.warn('sentinela-faixa: não consegui guardar que você recolheu o aviso (' + e.message + '); ele volta no próximo ciclo.');
      }
      pinta(atual);
    } else if (b.dataset.sf === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: [PASSO] }));
  }

  function inicia() {
    if (raiz.__dgSentinelaFaixaIniciada) return;
    raiz.__dgSentinelaFaixaIniciada = true;
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  // O alerta do servidor é só do dono.
  if (raiz.DGPapel && raiz.DGPapel.colaborador) return { esc, situacao, faixaHtml, PASSO };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { esc, situacao, faixaHtml, PASSO, CHAVE_RECOLHIDA, RECOLHE_MS, atualiza };
});
