'use strict';
/* barra.js: a lista de comandos que abre quando o campo da conversa começa com "/".

   As funções puras (deveAbrir, filtrar) não tocam no DOM e têm teste em web/test/barra.test.js.
   O resto liga a lista ao campo: busca o catálogo do agente (GET .../comandos), guarda 60 s,
   filtra enquanto a pessoa digita e põe "/nome " no campo ao escolher. Quem decide se o comando
   roda é o servidor; aqui a lista só ajuda a escolher. Contrato: web/docs/COMANDOS-DE-BARRA.md. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGBarra = m;
})(this, function (raiz) {
  const VALIDADE_MS = 60000;
  const MAX_ITENS = 50;
  const VAZIO = 'Nenhum comando com esse nome. Para mandar como texto, comece com //.';

  /** O texto digitado até o cursor, se a lista deve estar aberta; senão null. */
  function nomeDigitado(texto, cursor) {
    texto = String(texto == null ? '' : texto);
    if (texto.charAt(0) !== '/' || texto.charAt(1) === '/') return null;
    const fimNome = texto.search(/\s/);
    const limite = fimNome === -1 ? texto.length : fimNome;
    const c = typeof cursor === 'number' ? cursor : texto.length;
    if (c < 1 || c > limite) return null;   // cursor já passou do nome (ou está antes da barra)
    return texto.slice(1, limite);
  }

  /** A lista abre? Campo começa com uma barra (só uma) e o cursor ainda está no nome. */
  function deveAbrir(texto, cursor) {
    return nomeDigitado(texto, cursor) !== null;
  }

  /** Filtra o catálogo: primeiro quem começa com o digitado, depois quem contém. Sem diferenciar maiúsculas. */
  function filtrar(comandos, termo, max) {
    const t = String(termo == null ? '' : termo).replace(/^\//, '').toLowerCase();
    const limite = max || MAX_ITENS;
    const comeca = [], contem = [];
    for (const c of comandos || []) {
      const nome = String(c.nome || '').replace(/^\//, '').toLowerCase();
      if (!t || nome.startsWith(t)) comeca.push(c);
      else if (nome.includes(t)) contem.push(c);
    }
    return comeca.concat(contem).slice(0, limite);
  }

  /** O que a pessoa lê quando escolhe um item que não roda. */
  function textoMotivo(c) {
    return c.nome + ' não roda por aqui: ' + (c.motivo || 'o servidor não disse o motivo') + '.';
  }

  const api = { deveAbrir, nomeDigitado, filtrar, textoMotivo, VAZIO };

  const doc = raiz && raiz.document;
  if (!doc || !doc.createElement) return api;

  const ROTULO_TIPO = { nativo: 'Comandos do agente', skill: 'Skills', tela: 'Da tela' };

  /**
   * Liga a lista ao campo. opt.url: endereço do catálogo. Devolve { fecha, aberta }.
   * Nada acontece enquanto a lista está fechada: o teclado segue como sempre.
   */
  function liga(campo, opt) {
    opt = opt || {};
    const pai = campo.parentElement;
    const lista = doc.createElement('div');
    lista.className = 'barra-lista';
    lista.id = 'barraLista';
    lista.setAttribute('role', 'listbox');
    lista.setAttribute('aria-label', 'Comandos disponíveis');
    lista.hidden = true;
    pai.appendChild(lista);
    campo.setAttribute('aria-controls', 'barraLista');
    campo.setAttribute('aria-autocomplete', 'list');

    let aberta = false, catalogo = null, buscouEm = 0, buscando = null, erro = null;
    let itens = [], ativo = 0, aviso = '', suprimido = null;   // suprimido: texto já escolhido (/login), não reabre

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function carrega() {
      if (catalogo && Date.now() - buscouEm < VALIDADE_MS) return Promise.resolve();
      if (buscando) return buscando;
      erro = null;
      buscando = fetch(opt.url, { cache: 'no-store' }).then(async r => {
        let d = null;
        try { d = await r.json(); } catch (e) { d = null; }
        if (r.status === 401) throw new Error('a sessão expirou, entre de novo');
        if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('o app respondeu ' + r.status));
        catalogo = Array.isArray(d.comandos) ? d.comandos : [];
        buscouEm = Date.now();
      }).catch(e => {
        erro = e.message || 'sem resposta do app';
        console.warn('barra: não consegui carregar os comandos:', erro);
      }).then(() => { buscando = null; if (aberta) desenha(); });
      return buscando;
    }

    function termoAtual() {
      return nomeDigitado(campo.value, campo.selectionStart);
    }

    function desenha() {
      const termo = termoAtual();
      if (termo === null) { fecha(); return; }
      let html = '';
      itens = [];
      if (buscando && !catalogo) {
        html = '<div class="barra-msg">' + dsCarregando({ rotulo: 'Carregando os comandos', tamanho: 'p' }) + ' Carregando os comandos…</div>';
      } else if (erro && !catalogo) {
        html = '<div class="barra-msg erro">Não consegui carregar os comandos: ' + esc(erro) +
               '. Você ainda pode enviar; o servidor confere o comando.</div>';
      } else {
        itens = filtrar(catalogo || [], termo);
        if (!itens.length) html = '<div class="barra-msg">' + esc(VAZIO) + '</div>';
        if (ativo >= itens.length) ativo = Math.max(0, itens.length - 1);
        let tipoAnterior = null;
        itens.forEach((c, i) => {
          if (c.tipo !== tipoAnterior && ROTULO_TIPO[c.tipo] && !termo) {
            html += '<div class="barra-grupo" role="presentation">' + esc(ROTULO_TIPO[c.tipo]) + '</div>';
          }
          tipoAnterior = c.tipo;
          const cls = 'barra-item' + (c.roda === false ? ' off' : '') + (i === ativo ? ' ativo' : '');
          html += '<div class="' + cls + '" role="option" id="barraOp' + i + '" data-i="' + i + '"' +
            ' aria-selected="' + (i === ativo) + '"' + (c.roda === false ? ' aria-disabled="true"' : '') + '>' +
            '<div class="barra-topo"><b class="barra-nome">' + esc(c.nome) + '</b>' +
            (c.argumentos ? ' <span class="barra-args">' + esc(c.argumentos) + '</span>' : '') + '</div>' +
            (c.descricao ? '<div class="barra-desc">' + esc(c.descricao) + '</div>' : '') +
            (c.roda === false ? '<div class="barra-motivo">' + esc(c.motivo || 'Não roda pela conversa.') + '</div>' : '') +
            '</div>';
        });
      }
      if (aviso) html = '<div class="barra-aviso" role="status">' + esc(aviso) + '</div>' + html;
      lista.innerHTML = html;
      lista.hidden = false;
      aberta = true;
      campo.setAttribute('aria-expanded', 'true');
      const el = itens.length ? doc.getElementById('barraOp' + ativo) : null;
      if (el) {
        campo.setAttribute('aria-activedescendant', el.id);
        if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      } else campo.removeAttribute('aria-activedescendant');
    }

    function fecha() {
      aberta = false; aviso = ''; ativo = 0;
      lista.hidden = true;
      lista.innerHTML = '';
      campo.setAttribute('aria-expanded', 'false');
      campo.removeAttribute('aria-activedescendant');
    }

    function atualiza() {
      if (suprimido !== null && campo.value === suprimido) { if (aberta) fecha(); return; }
      suprimido = null;
      if (!deveAbrir(campo.value, campo.selectionStart)) { if (aberta) fecha(); return; }
      if (!aberta) { ativo = 0; aviso = ''; }
      aberta = true;
      carrega();
      desenha();
    }

    function escolhe(i) {
      const c = itens[i];
      if (!c) return;
      if (c.roda === false) { aviso = textoMotivo(c); desenha(); return; }
      const texto = c.tipo === 'tela' ? c.nome : c.nome + ' ';
      campo.value = texto;
      suprimido = c.tipo === 'tela' ? texto : null;
      fecha();
      campo.focus();
      try { campo.setSelectionRange(texto.length, texto.length); } catch (e) { /* campo sem seleção */ }
      campo.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Em fase de captura, antes do Enter do conversa.js (que envia). Só age com a lista aberta.
    doc.addEventListener('keydown', ev => {
      if (!aberta || ev.target !== campo || ev.isComposing) return;
      const k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (!itens.length) return;
        ativo = (ativo + (k === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length;
        aviso = '';
        desenha();
      } else if ((k === 'Enter' && !ev.shiftKey) || k === 'Tab') {
        if (!itens.length) { if (k === 'Tab') return; fecha(); return; }   // Enter sem itens envia como texto
        // Nome já digitado por inteiro (ex.: "/compact" e Enter): fecha e deixa o Enter enviar.
        const c = itens[ativo], termo = termoAtual();
        if (k === 'Enter' && c && c.roda !== false && termo !== null &&
            String(c.nome).toLowerCase() === '/' + termo.toLowerCase()) { fecha(); return; }
        escolhe(ativo);
      } else if (k === 'Escape') {
        fecha();
      } else return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);

    campo.addEventListener('input', atualiza);
    campo.addEventListener('click', atualiza);
    campo.addEventListener('keyup', ev => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') atualiza();
    });
    // No celular o toque na lista tira o foco do campo antes do click: o blur espera um pouco e
    // não fecha enquanto o dedo está na lista. Escolher é no click, para arrastar a lista (rolar)
    // não escolher item nenhum.
    let tocandoLista = false;
    campo.addEventListener('blur', () => {
      setTimeout(() => { if (aberta && !tocandoLista && doc.activeElement !== campo) fecha(); }, 200);
    });
    lista.addEventListener('pointerdown', ev => {
      tocandoLista = true;
      if (ev.pointerType === 'mouse') ev.preventDefault();   // no mouse o campo nem perde o foco
    });
    const soltou = () => { setTimeout(() => { tocandoLista = false; }, 300); };
    doc.addEventListener('pointerup', soltou);
    doc.addEventListener('pointercancel', soltou);
    lista.addEventListener('mousedown', ev => ev.preventDefault());
    lista.addEventListener('click', ev => {
      const el = ev.target.closest ? ev.target.closest('[data-i]') : null;
      if (el) escolhe(Number(el.getAttribute('data-i')));
      if (doc.activeElement !== campo) campo.focus();   // item que não roda: o motivo aparece e o foco volta
    });
    // enviar (botão) fecha: o campo é esvaziado sem evento de input
    campo.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) setTimeout(() => { if (aberta && !deveAbrir(campo.value, campo.selectionStart)) fecha(); }, 0);
    });
    const fechaSeVazio = () => { if (aberta && !deveAbrir(campo.value, campo.selectionStart)) fecha(); };
    doc.addEventListener('click', fechaSeVazio);

    return { fecha, aberta: () => aberta, atualiza };
  }

  api.liga = liga;
  return api;
});
