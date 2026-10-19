'use strict';
/* campo-cofre.js: "campo de senha na conversa".
   O agente responde com um bloco ```dgcofre\nNOME_DA_VARIAVEL\nrótulo opcional```. A tela
   troca esse bloco por um cartão com um campo de senha; o valor vai direto para
   POST /p/<agente>/api/cofre e NUNCA passa pelo chat, pelo transcript, por log ou
   por localStorage (guardamos só o marcador "salvo", com o valor ausente). */
(function (raiz) {
  const NOME_OK = /^[A-Z_][A-Z0-9_]{1,63}$/;
  let cfg = { agente: '', enviar: null };

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

  function htmlSalvo(envName) {
    return `<span class="dgc-ok" role="status">✓ <code>${esc(envName)}</code> salva no cofre</span>`;
  }

  /* HTML do cartão. `id` identifica o cartão (hash da mensagem) para o marcador. */
  function html(envName, rotulo, id) {
    const salvo = !!(id && jaSalvo(cfg.agente, id));
    return `<div class="dgcofre" data-env="${esc(envName)}" data-id="${esc(id || '')}">` +
      (salvo ? htmlSalvo(envName) :
        `<div class="dgc-tit">${esc(rotulo || 'Chave segura')}</div>` +
        `<code class="dgc-nome">${esc(envName)}</code>` +
        `<div class="dgc-linha"><input type="password" class="dgc-valor" autocomplete="off" ` +
        `spellcheck="false" autocapitalize="off" aria-label="Valor de ${esc(envName)}" placeholder="Cole a chave aqui">` +
        `<button type="button" class="dgc-salvar">Salvar no cofre</button></div>` +
        `<div class="dgc-msg" role="alert" hidden></div>`) +
      `</div>`;
  }

  /* Para conversa.js: se o bloco é dgcofre válido devolve o HTML, senão null. */
  function blocoParaHtml(bloco, textoMsg) {
    const a = analisa(bloco);
    return a ? html(a.envName, a.rotulo, hash(String(textoMsg || '') + '|' + a.envName)) : null;
  }

  const espera = ms => new Promise(r => setTimeout(r, ms));

  /* Entrega a mensagem ao agente, que pode estar reiniciando: até 5 tentativas, 3 s entre elas. */
  async function avisaAgente(texto) {
    if (!cfg.enviar) return;
    for (let i = 0; i < 5; i++) {
      await espera(3000);
      try { await cfg.enviar(texto); return; }
      catch (e) { console.warn('campo-cofre: o agente ainda não recebeu o aviso (tentativa ' + (i + 1) + '):', e && e.message); }
    }
    console.warn('campo-cofre: desisti de avisar o agente depois de 5 tentativas.');
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
    if (!inp || !btn) return;
    const envName = card.dataset.env;
    const valor = inp.value.trim();
    if (!valor) { mostraErro(card, 'Cole o valor da chave antes de salvar.'); inp.focus(); return; }
    card.dataset.enviando = '1'; btn.disabled = true; btn.textContent = 'Salvando…';
    const msg = card.querySelector('.dgc-msg'); if (msg) msg.hidden = true;
    let corpo = null, status = 0, falhaRede = '';
    try {
      const r = await fetch('/p/' + encodeURIComponent(cfg.agente) + '/api/cofre', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ envName, valor, aplicar: true }),
      });
      status = r.status;
      // Resposta que não é JSON: segue com corpo nulo e a mensagem abaixo mostra o código do status.
      corpo = await r.json().catch(() => null);
    } catch (e) { falhaRede = (e && e.message) || 'sem conexão'; }
    finally { card.dataset.enviando = ''; btn.disabled = false; btn.textContent = 'Salvar no cofre'; }

    const guardou = !falhaRede && ((status >= 200 && status < 300) || (corpo && corpo.guardado));
    if (!guardou) {
      const txt = falhaRede ? 'Não consegui falar com o servidor (' + falhaRede + '). Tente de novo.'
        : ((corpo && corpo.error) || 'Não consegui salvar (erro ' + status + ').') +
          (corpo && corpo.howToFix ? ' ' + corpo.howToFix : '');
      mostraErro(card, txt);
      return;
    }
    inp.value = '';
    const naoAplicou = !(status >= 200 && status < 300);
    if (card.dataset.id) marcaSalvo(cfg.agente, card.dataset.id);
    card.innerHTML = htmlSalvo(envName) + (naoAplicou
      ? `<div class="dgc-aviso">O agente ainda não reiniciou para usar a chave${corpo && corpo.howToFix ? ': ' + esc(corpo.howToFix) : ''}.</div>` : '');
    avisaAgente(naoAplicou ? envName + ' salva no cofre (o agente ainda não reiniciou para usar).'
                           : envName + ' salva no cofre.');
  }

  function configurar(c) { cfg = Object.assign({}, cfg, c || {}); }

  function ligar(doc) {
    doc.addEventListener('click', ev => {
      const b = ev.target.closest && ev.target.closest('.dgcofre .dgc-salvar');
      if (b) { ev.preventDefault(); salvar(b.closest('.dgcofre')); }
    });
    doc.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' || !ev.target.classList || !ev.target.classList.contains('dgc-valor')) return;
      ev.preventDefault(); salvar(ev.target.closest('.dgcofre'));
    });
  }

  const api = { analisa, html, htmlSalvo, blocoParaHtml, configurar, ligar, esc, hash };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz.document) { raiz.campoCofre = api; ligar(raiz.document); }
})(typeof window !== 'undefined' ? window : globalThis);
