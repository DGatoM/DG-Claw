'use strict';
/* tour.js: visita guiada em JS puro, sem biblioteca.

   Uso: DGTour.inicia({ passos: [...], aoFechar: fn })

   Cada passo: { alvo: 'seletor CSS', titulo, oque, como, porque,
                 antes(): roda antes de mostrar (ex.: abrir o menu),
                 depois(): roda ao sair do passo (ex.: desfazer uma demonstração) }

   O holofote é uma caixa transparente com uma sombra enorme em volta: o resto
   da tela escurece e o elemento em foco fica claro. Anterior, Próximo e Fechar
   funcionam por toque; Esc também fecha. Nada aqui depende de animação. */
(function () {
  let estado = null;      // { passos, i, aoFechar }

  function el(tag, id, texto) {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function alvoDe(passo) {
    const e = document.querySelector(passo.alvo);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    // elemento escondido (display:none) não tem tamanho: o passo é pulado
    return r.width > 0 && r.height > 0 ? e : null;
  }

  function posiciona() {
    if (!estado) return;
    const passo = estado.passos[estado.i];
    const alvo = passo && alvoDe(passo);
    const luz = document.getElementById('tourLuz');
    const cx = document.getElementById('tourCaixa');
    if (!alvo || !luz || !cx) return;
    const r = alvo.getBoundingClientRect(), m = 4;
    luz.style.top = (r.top - m) + 'px';
    luz.style.left = (r.left - m) + 'px';
    luz.style.width = (r.width + 2 * m) + 'px';
    luz.style.height = (r.height + 2 * m) + 'px';
    const h = cx.offsetHeight, vh = window.innerHeight;
    // a caixa fica do lado com mais espaço: embaixo do alvo se ele está na metade de cima
    const embaixo = r.top + r.height / 2 < vh / 2;
    if (embaixo) {
      cx.style.bottom = '';
      cx.style.top = Math.max(8, Math.min(vh - h - 12, r.bottom + 14)) + 'px';
    } else {
      cx.style.top = '';
      cx.style.bottom = Math.max(8, Math.min(vh - h - 12, vh - r.top + 14)) + 'px';
    }
  }

  function sai(passo) {
    if (passo && typeof passo.depois === 'function') {
      try { passo.depois(); } catch (e) { console.warn('tour: depois() falhou:', e); }
    }
  }

  function fecha() {
    if (!estado) return;
    const { passos, i, aoFechar } = estado;
    sai(passos[i]);
    for (const id of ['tourFundo', 'tourLuz', 'tourCaixa']) {
      const e = document.getElementById(id);
      if (e) e.remove();
    }
    window.removeEventListener('resize', posiciona);
    document.removeEventListener('keydown', tecla, true);
    estado = null;
    if (typeof aoFechar === 'function') {
      try { aoFechar(); } catch (e) { console.warn('tour: aoFechar() falhou:', e); }
    }
  }

  function tecla(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); fecha(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); vai(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); vai(-1); }
  }

  function linha(rotulo, texto) {
    const p = el('p');
    p.appendChild(el('b', null, rotulo + ' '));
    p.appendChild(document.createTextNode(texto));
    return p;
  }

  function mostra(sentido) {
    const passo = estado.passos[estado.i];
    if (typeof passo.antes === 'function') {
      try { passo.antes(); } catch (e) { console.warn('tour: antes() falhou:', e); }
    }
    const alvo = alvoDe(passo);
    // o menu desliza (cerca de 0,25 s): confere de novo antes de desistir do passo
    if (!alvo && !passo._tentou) {
      passo._tentou = true;
      setTimeout(() => { if (estado && estado.passos[estado.i] === passo) mostra(sentido); }, 320);
      return;
    }
    passo._tentou = false;
    if (!alvo) {
      // alvo que não existe nesta tela: pula para o próximo (ou anterior)
      const prox = estado.i + sentido;
      if (prox < 0 || prox >= estado.passos.length) { fecha(); return; }
      sai(passo);
      estado.i = prox;
      mostra(sentido);
      return;
    }
    alvo.scrollIntoView({ block: 'nearest' });
    const total = estado.passos.length, ultimo = estado.i === total - 1;
    const cx = document.getElementById('tourCaixa');
    cx.textContent = '';
    cx.appendChild(el('h4', null, passo.titulo));
    cx.appendChild(el('div', null, 'Passo ' + (estado.i + 1) + ' de ' + total)).className = 'tour-n';
    cx.appendChild(linha('O que é:', passo.oque));
    cx.appendChild(linha('Como funciona:', passo.como));
    cx.appendChild(linha('Por que está aqui:', passo.porque));
    const acoes = el('div');
    acoes.className = 'tour-acoes';
    const bFechar = el('button', 'tourFechar', 'Fechar');
    bFechar.type = 'button';
    bFechar.className = 'tour-x';
    bFechar.onclick = fecha;
    const bAnt = el('button', 'tourAnterior', 'Anterior');
    bAnt.type = 'button';
    bAnt.disabled = estado.i === 0;
    bAnt.onclick = () => vai(-1);
    const bProx = el('button', 'tourProximo', ultimo ? 'Concluir' : 'Próximo');
    bProx.type = 'button';
    bProx.className = 'pri';
    bProx.onclick = () => (ultimo ? fecha() : vai(1));
    acoes.append(bFechar, bAnt, bProx);
    cx.appendChild(acoes);
    posiciona();
    // depois do rolar e do menu deslizar, a posição pode mudar
    setTimeout(posiciona, 330);
    try { cx.focus({ preventScroll: true }); } catch (e) { cx.focus(); }
  }

  function vai(sentido) {
    if (!estado) return;
    const prox = estado.i + sentido;
    if (prox < 0 || prox >= estado.passos.length) return;
    sai(estado.passos[estado.i]);
    estado.i = prox;
    mostra(sentido);
  }

  function inicia(opcoes) {
    if (estado) return;
    const passos = (opcoes && opcoes.passos) || [];
    if (!passos.length) return;
    estado = { passos: passos, i: 0, aoFechar: opcoes.aoFechar };
    const fundo = el('div', 'tourFundo');
    fundo.onclick = fecha;
    const luz = el('div', 'tourLuz');
    const cx = el('div', 'tourCaixa');
    cx.setAttribute('role', 'dialog');
    cx.setAttribute('aria-modal', 'true');
    cx.setAttribute('aria-label', 'Visita guiada');
    cx.tabIndex = -1;
    document.body.append(fundo, luz, cx);
    window.addEventListener('resize', posiciona);
    document.addEventListener('keydown', tecla, true);
    mostra(1);
  }

  window.DGTour = { inicia: inicia, fecha: fecha };
})();
