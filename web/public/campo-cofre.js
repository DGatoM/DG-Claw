'use strict';
/* campo-cofre.js: "campo de senha na conversa".
   Duas portas para a mesma caixa:
   1. o bloco ```dgcofre\nNOME_DA_VARIAVEL\nrótulo opcional``` na resposta do agente (porta principal);
   2. a peça .dv-cofre da lousa (docs/VISUAIS.md), em que o iframe só PEDE e o conversa.js chama montar().
   O valor vai direto para POST /p/<agente>/api/cofre e NUNCA passa pelo chat, pelo transcript, por log,
   por localStorage nem pelo iframe (guardamos só o marcador "salvo", com o valor ausente). */
(function (raiz) {
  const NOME_OK = /^[A-Z_][A-Z0-9_]{1,63}$/;
  let cfg = { agente: '', nome: '' };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Corpo do bloco (o que vem depois de ```): devolve {envName, rotulo} ou null
     quando não é dgcofre ou o nome não é um nome de variável válido. */
  function analisa(bloco) {
    const m = /^dgcofre[ \t]*\r?\n([\s\S]*)$/.exec(String(bloco));
    if (!m) return null;
    const linhas = m[1].split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!linhas.length) return null;
    const envName = linhas[0].replace(/\\([_\\`])/g, '$1');
    if (!NOME_OK.test(envName)) return null;
    const rotulo = (linhas[1] || '').replace(/\\([_\\`])/g, '$1').slice(0, 80);
    return { envName, rotulo };
  }

  /* Pedido que veio do iframe (entrada hostil): devolve {ok:{nome, rotulo, ajuda}} ou {erro:{motivo, msg}}.
     Rótulo e ajuda são texto puro: sem caracteres de controle, nos tamanhos da espec. */
  function limpaTexto(v, max) {
    return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
  }
  function validaPedido(d) {
    const nome = d && typeof d.nome === 'string' ? d.nome.trim() : '';
    if (!NOME_OK.test(nome)) {
      return { erro: { motivo: 'nome', msg: 'Nome de chave inválido: "' + nome.slice(0, 40) + '". Use letras maiúsculas, números e _ (por exemplo HOSTINGER_API_TOKEN).' } };
    }
    return { ok: { nome, rotulo: limpaTexto(d.rotulo, 80), ajuda: limpaTexto(d.ajuda, 200) } };
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function chaveSalvo(agente, id) { return 'dgcofre-salvo:' + agente + ':' + id; }
  function jaSalvo(agente, id) {
    try { return raiz.localStorage && raiz.localStorage.getItem(chaveSalvo(agente, id)) === '1'; }
    catch (_) { return false; }
  }
  function marcaSalvo(agente, id) {
    try { if (raiz.localStorage) raiz.localStorage.setItem(chaveSalvo(agente, id), '1'); }
    catch (_) { /* sem localStorage: o cartão só não lembra após recarregar */ }
  }

  function htmlSalvo(envName, final) {
    return `<span class="dgc-ok" role="status">✓ <code>${esc(envName)}</code> salva no cofre` +
      (final ? ` (final ${esc(final)})` : '') + `</span>`;
  }

  function agenteTxt() { return cfg.nome || 'agente'; }

  function interiorForm(d, cancelavel) {
    const ag = esc(agenteTxt());
    return `<div class="dgc-tit">${esc(d.rotulo || 'Chave segura')}</div>` +
      `<code class="dgc-nome">${esc(d.envName)}</code>` +
      (d.ajuda ? `<div class="dgc-ajuda">${esc(d.ajuda)}</div>` : '') +
      `<div class="dgc-ja" role="status" hidden></div>` +
      `<div class="dgc-linha"><input type="password" class="dgc-valor" autocomplete="off" autocapitalize="off" ` +
      `autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" ` +
      `aria-label="Valor de ${esc(d.envName)}" placeholder="Cole a chave aqui">` +
      `<button type="button" class="dgc-olho" aria-label="Mostrar a chave" aria-pressed="false">👁</button>` +
      `<button type="button" class="dgc-salvar">Salvar no cofre</button>` +
      (cancelavel ? `<button type="button" class="dgc-cancelar">Cancelar</button>` : '') + `</div>` +
      `<div class="dgc-msg" role="alert" hidden></div>` +
      `<div class="dgc-garantia">O valor vai direto para o cofre. Não entra na conversa nem chega à ${ag}. ` +
      `Salvar reinicia a ${ag} para a chave valer; a conversa continua de onde parou.</div>`;
  }

  /* HTML do cartão. `id` identifica o cartão (hash da mensagem) para o marcador. */
  function html(envName, rotulo, id, extra) {
    const x = extra || {};
    const d = { envName, rotulo: rotulo || '', ajuda: x.ajuda || '' };
    const salvo = !!(id && jaSalvo(cfg.agente, id));
    return `<div class="dgcofre" data-env="${esc(envName)}" data-id="${esc(id || '')}" ` +
      `data-rotulo="${esc(d.rotulo)}" data-ajuda="${esc(d.ajuda)}"` +
      (x.cancelavel ? ' data-cancelavel="1"' : '') + (salvo ? ' data-salvo="1"' : '') + `>` +
      (salvo ? htmlSalvo(envName, '') : interiorForm(d, !!x.cancelavel)) + `</div>`;
  }

  /* Para conversa.js: se o bloco é dgcofre válido devolve o HTML, senão null. */
  function blocoParaHtml(bloco, textoMsg) {
    const a = analisa(bloco);
    return a ? html(a.envName, a.rotulo, hash(String(textoMsg || '') + '|' + a.envName)) : null;
  }

  /* ── Estado do servidor (só nomes e final, nunca valor) ─────────────── */
  let cacheEstado = null;
  function consultaEstado(forcar) {
    if (!forcar && cacheEstado && (cacheEstado.pend || Date.now() - cacheEstado.t < 3000)) return cacheEstado.p;
    const p = fetch('/p/' + encodeURIComponent(cfg.agente) + '/api/cofre', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(async r => {
        if (!r.ok) throw new Error('o servidor respondeu ' + r.status);
        const j = await r.json();
        const m = {};
        (j.chaves || []).forEach(c => { if (c && c.envName && !c.revogadaEm) m[c.envName] = { guardada: true, final: c.ultimos4 || null }; });
        return m;
      });
    const reg = { t: Date.now(), p, pend: true };
    cacheEstado = reg;
    p.then(() => { reg.pend = false; reg.t = Date.now(); }, () => { reg.pend = false; });
    p.catch(() => { if (cacheEstado && cacheEstado.p === p) cacheEstado = null; });
    return p;
  }
  /* Para o visual: { NOME: {guardada} } dos nomes pedidos. O final da chave NUNCA sai daqui: o visual é
     código do agente, não confiável, e só o cartão desenhado pelo app (fora do iframe) mostra o final.
     Usa o cache e a promessa pendente: pedidos repetidos não geram GET novo. */
  async function estados(nomes) {
    const m = await consultaEstado(false);
    const out = {};
    nomes.forEach(n => { out[n] = { guardada: !!m[n] }; });
    return out;
  }

  /* Freio do pedido de estado vindo do visual: no máximo 1 resposta a cada 3 s por visual e 20 nomes por
     pedido. `reg` é { ultimo, avisou }. O aviso (avisar:true) vem só na primeira recusa de cada visual. */
  const ESTADO_INTERVALO_MS = 3000, ESTADO_MAX_NOMES = 20;
  function freioEstado(reg, agora, qtdNomes) {
    if (agora - reg.ultimo < ESTADO_INTERVALO_MS || qtdNomes > ESTADO_MAX_NOMES) {
      const avisar = !reg.avisou; reg.avisou = true;
      return { ok: false, avisar };
    }
    reg.ultimo = agora;
    return { ok: true, avisar: false };
  }

  function dadosDe(card) {
    return { envName: card.dataset.env, rotulo: card.dataset.rotulo || '', ajuda: card.dataset.ajuda || '' };
  }

  function aplicaEstado(card, est) {
    if (!card.isConnected) return;
    if (card.dataset.salvo === '1') {
      if (est) card.innerHTML = htmlSalvo(card.dataset.env, est.final);
      else { card.dataset.salvo = ''; card.innerHTML = interiorForm(dadosDe(card), card.dataset.cancelavel === '1'); armaSalvar(card); }
      return;
    }
    const ja = card.querySelector('.dgc-ja');
    if (!ja) return;
    if (est) {
      ja.textContent = 'Já tem uma guardada' + (est.final ? ' (final ' + est.final + ')' : '') + '. Salvar de novo substitui.';
      ja.hidden = false;
    } else ja.hidden = true;
  }

  /* O botão só vale depois de 400 ms (um toque duplo ao abrir não grava por acidente) E depois de um gesto
     confiável do dono dentro do cartão (pointerdown/touchstart com isTrusted). Um visual (iframe) consegue
     abrir o cartão e até focar o campo por script, mas não consegue fabricar o toque do dono. */
  const DICA_GESTO = 'Toque no campo e cole a chave';
  function atualizaBotao(card) {
    const btn = card.querySelector('.dgc-salvar');
    if (!btn) return;
    const liberado = card.dataset.pronto === '1' && card.dataset.gesto === '1' && card.dataset.enviando !== '1';
    btn.disabled = !liberado;
    if (card.dataset.gesto === '1') btn.removeAttribute('title'); else btn.setAttribute('title', DICA_GESTO);
  }
  function armaSalvar(card) {
    if (!card.querySelector('.dgc-salvar')) return;
    card.dataset.pronto = '';
    atualizaBotao(card);
    setTimeout(() => { card.dataset.pronto = '1'; atualizaBotao(card); }, 400);
  }

  /* Registra o gesto do dono. Só conta evento confiável (isTrusted) vindo de dentro do cartão: `gesto` libera
     o botão; `toque` (gesto no próprio campo) é o que autoriza gravar, porque o valor tem de ter sido
     colocado depois de o dono tocar no campo. */
  function registraGesto(card, ev) {
    if (!card) return false;
    if (!ev || ev.isTrusted !== true) { atualizaBotao(card); return false; }
    card.dataset.gesto = '1';
    const alvo = ev.target;
    if (alvo && alvo.classList && alvo.classList.contains('dgc-valor')) card.dataset.toque = '1';
    atualizaBotao(card);
    return true;
  }

  function hidratar(card) {
    if (card.dataset.hid === '1') return;
    card.dataset.hid = '1';
    armaSalvar(card);
    consultaEstado(false).then(
      m => aplicaEstado(card, m[card.dataset.env] || null),
      e => console.warn('campo-cofre: não consegui consultar o cofre para mostrar o estado de ' + card.dataset.env + ':', e && e.message));
  }

  function mostraErro(card, texto) {
    const m = card.querySelector('.dgc-msg');
    if (!m) return;
    m.textContent = texto; m.hidden = false;
  }

  async function salvar(card) {
    if (card.dataset.enviando === '1') return;
    const inp = card.querySelector('.dgc-valor');
    const btn = card.querySelector('.dgc-salvar');
    if (!inp || !btn || btn.disabled) return;
    if (card.dataset.toque !== '1') { mostraErro(card, DICA_GESTO + ' antes de salvar.'); return; }
    const envName = card.dataset.env;
    const cb = card._cb || {};
    const valor = inp.value.trim();
    if (!valor) { mostraErro(card, 'Cole o valor da chave antes de salvar.'); inp.focus(); return; }
    card.dataset.enviando = '1'; btn.disabled = true; btn.textContent = 'Salvando…';
    const msg = card.querySelector('.dgc-msg'); if (msg) msg.hidden = true;
    let corpo = null, status = 0, falhaRede = '';
    try {
      const r = await fetch('/p/' + encodeURIComponent(cfg.agente) + '/api/cofre', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ envName, valor, aplicar: true, avisar: true }),
      });
      status = r.status;
      // Resposta que não é JSON: segue com corpo nulo e a mensagem abaixo mostra o código do status.
      corpo = await r.json().catch(() => null);
    } catch (e) { falhaRede = (e && e.message) || 'sem conexão'; }
    finally { card.dataset.enviando = ''; atualizaBotao(card); btn.textContent = 'Salvar no cofre'; }

    const guardou = !falhaRede && ((status >= 200 && status < 300) || (corpo && corpo.guardado));
    if (!guardou) {
      const txt = falhaRede ? 'Não consegui falar com o servidor (' + falhaRede + '). Tente de novo.'
        : ((corpo && corpo.error) || 'Não consegui salvar (erro ' + status + ').') +
          (corpo && corpo.howToFix ? ' ' + corpo.howToFix : '');
      mostraErro(card, txt);
      if (cb.aoErro) cb.aoErro({ motivo: 'envio', msg: txt });
      return;
    }
    inp.value = ''; card.dataset.toque = '';
    const naoAplicou = !(status >= 200 && status < 300);
    const g = (corpo && (corpo.ultimos4 ? corpo : corpo.guardado)) || {};
    const final = typeof g.ultimos4 === 'string' ? g.ultimos4 : '';
    cacheEstado = null;
    if (card.dataset.id) marcaSalvo(cfg.agente, card.dataset.id);
    card.dataset.salvo = '1';
    card.innerHTML = htmlSalvo(envName, final) + (naoAplicou
      ? `<div class="dgc-aviso">O agente ainda não reiniciou para usar a chave${corpo && corpo.howToFix ? ': ' + esc(corpo.howToFix) : ''}.</div>` : '');
    if (cb.aoGuardar) cb.aoGuardar({ envName, final });
  }

  /* Abre o cartão dentro de `contêiner` (a caixa da peça da lousa). opcoes: {envName, rotulo, ajuda,
     aoGuardar({envName, final}), aoErro({motivo, msg}), aoCancelar()}. */
  function montar(conteiner, opcoes) {
    conteiner.innerHTML = html(opcoes.envName, opcoes.rotulo, '', { ajuda: opcoes.ajuda, cancelavel: true });
    const card = conteiner.firstElementChild;
    card._cb = opcoes;
    hidratar(card);
    // Sem focus(): o pedido vem de um iframe não confiável e não pode roubar o teclado do dono.
    return card;
  }

  function limpaCampo(card) {
    const inp = card.querySelector('.dgc-valor');
    if (inp) inp.value = '';
    const m = card.querySelector('.dgc-msg'); if (m) m.hidden = true;
  }

  function configurar(c) { cfg = Object.assign({}, cfg, c || {}); }

  function ligar(doc) {
    ['pointerdown', 'touchstart'].forEach(tipo => doc.addEventListener(tipo, ev => {
      const t = ev.target && ev.target.closest ? ev.target : null;
      const card = t && t.closest('.dgcofre');
      if (card) registraGesto(card, ev);
    }, true));
    doc.addEventListener('click', ev => {
      const t = ev.target.closest ? ev.target : null;
      if (!t) return;
      const b = t.closest('.dgcofre .dgc-salvar');
      if (b) { ev.preventDefault(); salvar(b.closest('.dgcofre')); return; }
      const o = t.closest('.dgcofre .dgc-olho');
      if (o) {
        const inp = o.closest('.dgcofre').querySelector('.dgc-valor');
        const ver = inp.type === 'password';
        inp.type = ver ? 'text' : 'password';
        o.setAttribute('aria-pressed', ver ? 'true' : 'false');
        o.setAttribute('aria-label', ver ? 'Esconder a chave' : 'Mostrar a chave');
        return;
      }
      const c = t.closest('.dgcofre .dgc-cancelar');
      if (c) { const card = c.closest('.dgcofre'); limpaCampo(card); if (card._cb && card._cb.aoCancelar) card._cb.aoCancelar(); }
    });
    /* Captura no document: o que se digita ou cola no campo não chega aos atalhos da conversa,
       ao ditado nem a nada que escute o teclado (o Esc da tela cheia, por exemplo). */
    const noCampo = ev => ev.target && ev.target.classList && ev.target.classList.contains('dgc-valor');
    ['keydown', 'keyup', 'keypress', 'paste'].forEach(tipo => doc.addEventListener(tipo, ev => {
      if (!noCampo(ev)) return;
      ev.stopPropagation();
      if (tipo !== 'keydown') return;
      const card = ev.target.closest('.dgcofre');
      if (ev.key === 'Enter') { ev.preventDefault(); salvar(card); }
      else if (ev.key === 'Escape') {
        ev.preventDefault(); limpaCampo(card);
        if (card._cb && card._cb.aoCancelar) card._cb.aoCancelar();
      }
    }, true));
    const varre = no => {
      if (no.nodeType !== 1) return;
      if (no.matches('.dgcofre')) hidratar(no);
      no.querySelectorAll('.dgcofre').forEach(hidratar);
    };
    const iniciaObs = () => {
      doc.querySelectorAll('.dgcofre').forEach(hidratar);
      if (!raiz.MutationObserver || !doc.body) return;
      new raiz.MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(varre))).observe(doc.body, { childList: true, subtree: true });
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciaObs); else iniciaObs();
  }

  const api = { analisa, validaPedido, salvar, html, htmlSalvo, blocoParaHtml, configurar, ligar, montar, estados, freioEstado, registraGesto, esc, hash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz.document) { raiz.campoCofre = api; ligar(raiz.document); }
})(typeof window !== 'undefined' ? window : globalThis);
