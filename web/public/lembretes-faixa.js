'use strict';
/* lembretes-faixa.js: a faixa de lembretes no alto da conversa com os lembretes que estão tocando agora.

   Lê GET /api/v1/lembretes (campo "insistindo") a cada 15 s e quando a aba volta ao foco. Cada
   ocorrência vira uma linha com o agente, o texto, "aviso n de teto" e os botões Feito e Adiar
   (10 min, 30 min, 1 h). Erro do servidor aparece na própria faixa, com a frase que ele mandou.
   Contrato das rotas: web/docs/LEMBRETES.md. As funções que só montam texto ficam fora do DOM e
   têm teste em web/test/lembretes-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGLembretesFaixa = m;
})(this, function (raiz) {
  const POLL_MS = 15000;
  const ADIAR = [[10, '10 min'], [30, '30 min'], [60, '1 h']];

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* "aviso 3 de 12" */
  function rotuloAviso(item) {
    return 'aviso ' + (item.envio || 1) + ' de ' + item.teto;
  }

  function linhaHtml(item) {
    const id = esc(item.id);
    const menu = ADIAR.map(([min, nome]) =>
      `<button type="button" class="lf-min" data-adiar="${id}" data-min="${min}">${nome}</button>`).join('');
    return `<li class="lf-item" data-oc="${id}">` +
      `<div class="lf-txt"><b>${esc(item.agente_nome || item.agente)}</b> ${esc(item.texto)} ` +
      `<small>${esc(rotuloAviso(item))}</small></div>` +
      `<div class="lf-acoes"><button type="button" class="lf-feito" data-feito="${id}">Feito</button>` +
      `<button type="button" class="lf-adiar" data-menu="${id}" aria-expanded="false">Adiar</button></div>` +
      `<div class="lf-menu" hidden>${menu}</div></li>`;
  }

  const PASSO = {
    alvo: '#faixaLembretes',
    titulo: 'Faixa de lembretes',
    oque: 'Os lembretes que estão tocando agora, de qualquer agente. Cada linha mostra quem lembra, o que é e quantos avisos já saíram.',
    como: 'O ' + (typeof dsMarca !== 'undefined' ? dsMarca.nome : 'DG Claw') + ' confere a cada 15 segundos e repete o aviso no intervalo do lembrete (5 minutos, se você não mudou) até o teto. Feito encerra a ocorrência em todos os aparelhos. Adiar traz o aviso de volta no prazo que você escolher, com a contagem de avisos zerada.',
    porque: 'Para você não esquecer de algo que pediu para ser lembrado, mesmo que tenha deixado passar o primeiro aviso.',
  };

  if (!raiz.document) return { rotuloAviso, linhaHtml, PASSO, ADIAR };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let faixa = null;
  let lista = null;
  let erroEl = null;
  let atual = [];
  let ocupado = false;

  function monta() {
    faixa = document.createElement('section');
    faixa.id = 'faixaLembretes';
    faixa.className = 'lf';
    faixa.setAttribute('role', 'region');
    faixa.setAttribute('aria-live', 'polite');
    faixa.setAttribute('aria-label', 'Lembretes tocando agora');
    faixa.hidden = true;
    faixa.innerHTML = '<div class="lf-topo"><span class="lf-tit">' + dsIcone('clock') + ' Lembretes</span>' +
      '<a class="lf-ver" href="/lembretes">ver todos</a>' +
      '<button type="button" class="lf-ajuda" id="faixaLembretesAjuda" aria-label="Tutorial da faixa de lembretes" ' +
      'title="O que é esta faixa">?</button></div><ul class="lf-lista" id="faixaLembretesLista"></ul>' +
      '<p class="lf-erro" id="faixaLembretesErro" role="alert" hidden></p>';
    const cab = document.querySelector('header');
    if (cab && cab.parentNode) cab.parentNode.insertBefore(faixa, cab.nextSibling);
    else document.body.insertBefore(faixa, document.body.firstChild);
    lista = faixa.querySelector('#faixaLembretesLista');
    erroEl = faixa.querySelector('#faixaLembretesErro');
    faixa.querySelector('#faixaLembretesAjuda').onclick = () => {
      if (!window.DGTour) { mostraErro('A visita guiada não carregou. Recarregue a página e tente de novo.'); return; }
      window.DGTour.inicia({ passos: [PASSO] });
    };
    lista.addEventListener('click', aoClicar);
  }

  function mostraErro(texto) {
    erroEl.textContent = texto || '';
    erroEl.hidden = !texto;
    if (texto) faixa.hidden = false;
  }

  function pinta() {
    lista.innerHTML = atual.map(linhaHtml).join('');
    faixa.hidden = !atual.length && erroEl.hidden;
  }

  async function chamar(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) {
      return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão; tento de novo em instantes.' };
    }
    let json = null;
    try { json = await r.json(); } catch (e) { console.warn('lembretes-faixa: a resposta de ' + caminho + ' não veio em JSON:', e.message); }
    if (!r.ok) return { ok: false, erro: (json && json.erro) || ('O servidor respondeu ' + r.status + ' em ' + caminho + '.') };
    return { ok: true, json: json || {} };
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      const r = await chamar('GET', '/api/v1/lembretes');
      if (!r.ok) { mostraErro('Não consegui ler os lembretes: ' + r.erro); return; }
      mostraErro('');
      atual = Array.isArray(r.json.insistindo) ? r.json.insistindo : [];
      pinta();
    } finally { ocupado = false; }
  }

  async function aoClicar(ev) {
    const b = ev.target.closest('button');
    if (!b) return;
    const li = b.closest('.lf-item');
    if (b.dataset.menu) {
      const menu = li.querySelector('.lf-menu');
      menu.hidden = !menu.hidden;
      b.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }
    let caminho; let corpo;
    if (b.dataset.feito) { caminho = '/api/v1/lembretes/ocorrencias/' + encodeURIComponent(b.dataset.feito) + '/feito'; corpo = { origem: 'tela' }; }
    else if (b.dataset.adiar) { caminho = '/api/v1/lembretes/ocorrencias/' + encodeURIComponent(b.dataset.adiar) + '/adiar'; corpo = { minutos: Number(b.dataset.min) }; }
    else return;
    li.querySelectorAll('button').forEach(x => { x.disabled = true; });
    const r = await chamar('POST', caminho, corpo);
    if (!r.ok) {
      li.querySelectorAll('button').forEach(x => { x.disabled = false; });
      mostraErro(r.erro);
      return;
    }
    mostraErro('');
    atualiza();
  }

  function inicia() {
    monta();
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  // Colaborador não vê lembretes: o servidor negaria a chamada.
  if (raiz.DGPapel && raiz.DGPapel.colaborador) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { rotuloAviso, linhaHtml, PASSO, ADIAR, atualiza };
});
