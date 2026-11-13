'use strict';
/* painel-moldura.js: a moldura do painel do agente (painel.html), na origem do Web.

   O painel é um processo dentro do container do agente e o JavaScript dele não é confiável. Por isso ele nunca roda
   aqui: roda num iframe sandbox sem allow-same-origin (origem opaca, sem cookie), servido por /pv/<token>/..., e fala
   com a própria API pelo token no caminho. Esta página monta a casca (cabeçalho e menu), pede o token ao Web e
   conversa com o iframe por postMessage.

   TUDO que chega do iframe é dado não confiável: só vale se vier da janela dele, com tipo da lista branca, tamanho
   limitado e campos validados; texto entra na tela por textContent e nunca como HTML. As funções de filtro (triagem,
   destinoValido, sandboxSeguro) ficam fora do DOM e têm teste em web/test/painel-moldura.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGPainelMoldura = m;
})(this, function (raiz) {
  const TAM_MAX_MENSAGEM = 4096;
  const RX_CHAVE = /^[A-Za-z0-9_-]{1,40}$/;
  // Páginas do Web que o painel pode pedir para abrir: as do menu da casca.
  const RX_DESTINO = /^\/(?:a\/[A-Za-z0-9_-]{1,40}\/?|p\/[A-Za-z0-9_-]{1,40}\/[^\\\x00-\x1f]*|mesa|lembretes|avisos|seguranca|manual(?:\/[A-Za-z0-9_.-]+)?|conectar|colaboradores|anonimizar|logs)\/?(?:[?#][^\\\x00-\x1f]*)?$/;
  const TIPOS = new Set(['pronto', 'ativa', 'extras', 'tutorial-menu', 'ir', 'expirou']);

  /** O endereço pedido por `ir` é uma página do próprio Web? Começa com uma barra só, sem // nem /\ e sem sair do menu. */
  function destinoValido(para) {
    if (typeof para !== 'string' || para.length > 200) return false;
    if (!para.startsWith('/') || para.startsWith('//') || para.startsWith('/\\')) return false;
    if (/(?:^|\/)\.\.?(?:\/|$|\?|#)/.test(para) || /%2e|%2f|%5c/i.test(para)) return false;
    return RX_DESTINO.test(para);
  }

  /** O iframe do painel precisa de sandbox, sem allow-same-origin e sem permissão de navegar o topo. */
  function sandboxSeguro(valor) {
    if (typeof valor !== 'string' || !valor.trim()) return false;
    return !/\ballow-same-origin\b|\ballow-top-navigation/i.test(valor);
  }

  const texto = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

  /**
   * Filtra uma mensagem do iframe. Devolve a mensagem limpa ({ tipo, ... }) ou null (e avisa no console por quê).
   * `janelaDoIframe` é iframe.contentWindow: mensagem de qualquer outra janela é ignorada em silêncio.
   */
  function triagem(ev, janelaDoIframe) {
    if (!ev || !janelaDoIframe || ev.source !== janelaDoIframe) return null;
    const d = ev.data;
    const recusa = (motivo) => { console.warn('painel: mensagem do iframe ignorada, ' + motivo + '.'); return null; };
    if (!d || typeof d !== 'object' || d.dgclaw !== 1) return recusa('não tem o formato esperado');
    let tam = 0;
    try { tam = JSON.stringify(d).length; } catch (_) { return recusa('não dá para ler'); }
    if (tam > TAM_MAX_MENSAGEM) return recusa('passou do tamanho máximo (' + TAM_MAX_MENSAGEM + ' caracteres)');
    if (typeof d.tipo !== 'string' || !TIPOS.has(d.tipo)) return recusa('o tipo "' + String(d.tipo).slice(0, 30) + '" não é aceito');
    switch (d.tipo) {
      case 'ativa': {
        if (typeof d.pagina !== 'string' || (d.pagina !== '' && !RX_CHAVE.test(d.pagina))) return recusa('a chave da página é inválida');
        const titulo = d.titulo == null ? null : texto(d.titulo, 120);
        if (d.titulo != null && titulo === null) return recusa('o título é inválido');
        return { tipo: 'ativa', pagina: d.pagina, titulo };
      }
      case 'extras': {
        if (!Array.isArray(d.lista) || d.lista.length > 20) return recusa('a lista de itens é inválida');
        const lista = [];
        for (const x of d.lista) {
          const ico = x && texto(x.ico, 8);
          const nome = x && texto(x.nome, 60);
          if (!x || typeof x.chave !== 'string' || !RX_CHAVE.test(x.chave) || ico === null || nome === null) return recusa('um item extra é inválido');
          lista.push({ chave: x.chave, ico, nome });
        }
        return { tipo: 'extras', lista };
      }
      case 'ir':
        if (!destinoValido(d.para)) return recusa('o endereço pedido não é uma página do menu');
        return { tipo: 'ir', para: d.para };
      default:
        return { tipo: d.tipo };
    }
  }

  if (!raiz.document) return { triagem, destinoValido, sandboxSeguro, RX_CHAVE };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const quadro = $('painelQuadro');
  const erro = $('painelErro');
  let slug = '';
  let jaRenovou = false;   // o token foi renovado depois de uma falha de acesso, e o painel ainda não confirmou que abriu
  let tema = null;

  function mostraErro(motivo) {
    erro.textContent = motivo;
    erro.hidden = false;
    quadro.hidden = true;
  }

  /** Pede ao Web o token do painel deste agente e devolve o endereço do iframe. */
  async function enderecoDoPainel() {
    const r = await fetch('/api/v1/agents/' + encodeURIComponent(slug) + '/painel-token', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false || typeof d.token !== 'string') throw new Error((d && d.erro) || ('o servidor respondeu ' + r.status));
    // O caminho do painel é o desta página sem o /p/<agente>; a busca e o #aba= seguem juntos.
    const resto = location.pathname.slice(('/p/' + encodeURIComponent(slug)).length) || '/';
    return '/pv/' + d.token + resto + location.search + location.hash;
  }

  async function abre() {
    try {
      quadro.src = await enderecoDoPainel();
    } catch (e) {
      console.error('painel: não consegui abrir o painel de ' + slug + ': ' + e.message);
      mostraErro('Não consegui abrir o painel deste agente: ' + e.message + '. Recarregue a página; se repetir, avise quem instalou o DG Claw.');
    }
  }

  function paraOIframe(msg) {
    if (quadro.contentWindow) quadro.contentWindow.postMessage(Object.assign({ dgclaw: 1 }, msg), '*');
  }

  function abaDaUrl() {
    const mm = /^#aba=([A-Za-z0-9_-]{1,40})(?:&|$)/.exec(location.hash);
    return mm ? mm[1] : '';
  }

  function aoReceber(ev) {
    const msg = triagem(ev, quadro.contentWindow);
    if (!msg) return;
    switch (msg.tipo) {
      case 'pronto':
        jaRenovou = false;
        if (tema) paraOIframe({ tipo: 'tema', valor: tema });
        break;
      case 'ativa':
        if (msg.pagina) {
          // replaceState não dispara hashchange: o link da barra acompanha a aba sem reabrir nada.
          try { history.replaceState(null, '', location.pathname + location.search + '#aba=' + msg.pagina); } catch (e) { console.warn('painel: não consegui atualizar o endereço (' + e.message + ').'); }
        }
        raiz.DGCasca.ativa(msg.pagina, msg.titulo);
        break;
      case 'extras': raiz.DGCasca.extras(msg.lista); break;
      case 'tutorial-menu': raiz.DGCasca.tutorialMenu(); break;
      case 'ir': {
        // Mesmo endereço já aprovado pela triagem, remontado só se for do próprio Web e do menu.
        const u = new URL(msg.para, location.origin);
        if (u.origin !== location.origin || !destinoValido(u.pathname + u.search + u.hash)) { console.warn('painel: recusei abrir ' + String(msg.para).slice(0, 80) + ' (não é uma página do menu).'); break; }
        location.assign(u.pathname + u.search + u.hash);
        break;
      }
      case 'expirou':
        if (jaRenovou) { mostraErro('O acesso deste painel expirou e não consegui renovar. Recarregue a página.'); break; }
        jaRenovou = true;
        abre();
        break;
      default: break;
    }
  }

  function inicia() {
    const mm = /^\/p\/([^/]+)/.exec(location.pathname);
    try { slug = mm ? decodeURIComponent(mm[1]) : ''; } catch (_) { slug = ''; }
    if (!slug) { mostraErro('Não entendi de qual agente é este painel. Volte ao início e abra o painel pelo menu.'); return; }
    if (!sandboxSeguro(quadro.getAttribute('sandbox'))) {
      console.error('painel: o iframe do painel está sem sandbox ou com allow-same-origin; não vou abri-lo. Reinstale o DG Claw Web.');
      mostraErro('A moldura do painel está com a proteção desligada, então não abri o painel. Reinstale o DG Claw Web.');
      return;
    }
    try { const t = localStorage.getItem('dgclaw-tema'); if (t === 'claro' || t === 'escuro') tema = t; } catch (_) { /* sem armazenamento: o painel segue o tema do sistema */ }
    window.addEventListener('message', aoReceber);
    window.addEventListener('hashchange', () => { const chave = abaDaUrl(); if (chave) paraOIframe({ tipo: 'aba', chave }); });
    raiz.DGCasca.monta({ pagina: abaDaUrl() || 'status', titulo: '', aoTutorial: () => paraOIframe({ tipo: 'tutorial' }) });
    abre();
  }

  inicia();
  return { triagem, destinoValido, sandboxSeguro };
});
