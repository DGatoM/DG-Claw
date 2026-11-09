'use strict';
/* sistemas.js: a tela Sistemas conectados (modo demonstração).
   Busca GET /api/demo/sistemas a cada 20 s e desenha o agente no centro, os sistemas em círculo,
   linhas curvas em SVG e partículas de luz (SMIL, sem biblioteca) só nas conexões confirmadas.
   Atualiza sem piscar: se nada mudou (mesmos sistemas, estados e tamanho), só muda o texto. */
(function (raiz) {
  const NS = 'http://www.w3.org/2000/svg';
  const ESTADOS = { conectado: 'Conectado', caido: 'Caído', nao_medido: 'Não medido' };
  const ICONES = { whatsapp: '💬', email: '✉️', crm: '📇', imagem: '🎨' };
  const INTERVALO_MS = 20000;
  const $ = id => document.getElementById(id);
  const semMovimento = () => !!(raiz.matchMedia && raiz.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const celular = () => raiz.matchMedia('(max-width: 760px)').matches;

  function h(tag, cls, texto) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function svg(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
    return e;
  }

  const E = { dados: null, recebidoEm: 0, assinatura: '', erro: null, buscando: false };

  function mostraErro(msg, link) {
    const p = $('scErro');
    p.textContent = msg;
    if (link) { p.append(' '); const a = h('a', null, link.texto); a.href = link.href; a.style.color = 'inherit'; p.append(a); }
    p.hidden = false;
  }

  async function busca() {
    if (E.buscando) return;
    E.buscando = true;
    try {
      const r = await fetch('/api/demo/sistemas', { cache: 'no-store', credentials: 'same-origin' });
      const d = await r.json().catch(() => null);
      if (r.status === 401) { E.erro = 'Sua sessão expirou.'; mostraErro('Sua sessão expirou, então não consigo medir os sistemas.', { texto: 'Entre de novo.', href: '/login?next=/sistemas' }); }
      else if (r.status === 404) { E.erro = 'modo desligado'; mostraErro('O modo demonstração não está ligado neste painel, então não há sistemas para medir.'); }
      else if (!r.ok || !d || d.ok === false) { E.erro = (d && d.erro) || ('a API respondeu ' + r.status); mostraErro('Não consegui medir os sistemas: ' + E.erro); }
      else { E.dados = d; E.recebidoEm = Date.now(); E.erro = null; $('scErro').hidden = true; }
    } catch (e) {
      E.erro = e.message;
      mostraErro('Não consegui falar com o painel (' + e.message + '). Confira a conexão; vou tentar de novo em 20 s.');
    } finally { E.buscando = false; }
    desenha();
  }

  /* Com erro, nenhum sistema pode continuar verde: tudo vira "não medido" com a causa. */
  function sistemasVisiveis() {
    if (!E.dados) return [];
    const lista = E.dados.sistemas || [];
    if (!E.erro) return lista;
    return lista.map(s => Object.assign({}, s, { estado: 'nao_medido', motivo: 'Sem resposta do painel agora: ' + E.erro, detalhe: null }));
  }

  function pintaAgente(ag, doAgente) {
    $('scAgenteNome').textContent = ag.nome || 'Agente';
    const foto = $('scFoto');
    const est = doAgente ? doAgente.estado : 'nao_medido';
    foto.className = 'sc-foto ' + est;
    const letra = () => { foto.textContent = ag.letra || (ag.nome || '?').slice(0, 1).toUpperCase(); foto.style.background = ag.cor || '#2f9e5e'; };
    const atual = foto.firstChild && foto.firstChild.tagName === 'IMG' ? foto.firstChild.getAttribute('src') : null;
    if (ag.avatar_url) {
      if (atual !== ag.avatar_url) {
        foto.textContent = '';
        foto.style.background = '';
        const img = h('img');
        img.alt = 'Foto de ' + (ag.nome || 'agente');
        img.onerror = () => { console.warn('sistemas: a foto do agente (' + ag.avatar_url + ') não carregou; uso a letra.'); letra(); };
        img.src = ag.avatar_url;
        foto.appendChild(img);
      }
    } else letra();
    const e = $('scAgenteEstado');
    e.className = 'sc-agente-estado ' + est;
    e.textContent = doAgente
      ? (est === 'conectado' ? 'Sessão ativa' : (est === 'caido' ? 'Sem resposta: ' + (doAgente.motivo || 'motivo desconhecido') : 'Não medido' + (doAgente.motivo ? ': ' + doAgente.motivo : '')))
      : 'Não medido';
  }

  function desenhaLista(nos) {
    const ul = $('scLista');
    ul.textContent = '';
    for (const s of nos) {
      const li = h('li', 'sc-item ' + s.estado);
      li.appendChild(h('div', 'sc-item-ico', ICONES[s.tipo] || '◎'));
      const c = h('div', 'sc-item-corpo');
      c.appendChild(h('div', 'sc-item-rotulo', s.rotulo));
      c.appendChild(h('div', 'sc-item-estado', ESTADOS[s.estado] || s.estado));
      if (s.motivo) c.appendChild(h('div', 'sc-item-motivo', s.motivo));
      else if (s.detalhe) c.appendChild(h('div', 'sc-item-motivo', s.detalhe));
      li.appendChild(c);
      ul.appendChild(li);
    }
  }

  function desenhaPalco(nos) {
    const palco = $('scPalco'), cam = $('scSvg'), caixa = $('scNos');
    const W = palco.clientWidth, H = palco.clientHeight;
    const cx = W / 2, cy = H / 2;
    const rx = Math.max(120, W / 2 - 125), ry = Math.max(120, H / 2 - 105);
    const reduz = semMovimento();
    cam.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    cam.textContent = '';
    caixa.textContent = '';
    const n = nos.length;
    nos.forEach((s, i) => {
      const ang = (-90 + 180 / n + i * 360 / n) * Math.PI / 180;
      const x = cx + rx * Math.cos(ang), y = cy + ry * Math.sin(ang);
      const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1;
      const kx = (cx + x) / 2 - dy / len * len * 0.16, ky = (cy + y) / 2 + dx / len * len * 0.16;
      const d = 'M' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' Q' + kx.toFixed(1) + ' ' + ky.toFixed(1) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1);
      cam.appendChild(svg('path', { d, class: 'linha ' + s.estado }));
      if (s.estado === 'conectado' && !reduz) {
        for (let k = 0; k < 2; k++) {
          const bola = svg('circle', { r: 4.5, class: 'luz' });
          const mov = svg('animateMotion', { path: d, dur: '3.6s', begin: (-k * 1.8) + 's', repeatCount: 'indefinite', calcMode: 'linear', keyPoints: '0;1;0', keyTimes: '0;0.5;1' });
          bola.appendChild(mov);
          cam.appendChild(bola);
        }
      }
      const no = h('div', 'sc-no ' + s.estado);
      no.style.left = (x - 105).toFixed(1) + 'px';
      no.style.top = y.toFixed(1) + 'px';
      no.appendChild(h('div', 'sc-no-bola', ICONES[s.tipo] || '◎'));
      no.appendChild(h('div', 'sc-no-rotulo', s.rotulo));
      no.appendChild(h('div', 'sc-no-estado', ESTADOS[s.estado] || s.estado));
      if (s.estado !== 'conectado' && s.motivo) no.appendChild(h('div', 'sc-no-motivo', s.motivo));
      else if (s.detalhe) no.appendChild(h('div', 'sc-no-detalhe', s.detalhe));
      caixa.appendChild(no);
    });
  }

  function desenha() {
    if (!E.dados) {
      $('scAgenteNome').textContent = E.erro ? 'Sem dados' : 'Conferindo...';
      $('scAgenteEstado').textContent = E.erro ? 'A tela não recebeu o estado dos sistemas.' : '';
      return;
    }
    const todos = sistemasVisiveis();
    const doAgente = todos.find(s => s.tipo === 'agente') || null;
    const nos = todos.filter(s => s.tipo !== 'agente');
    pintaAgente(E.dados.agente || {}, doAgente);
    const palco = $('scPalco');
    const ass = [celular() ? 'c' : 'd', palco.clientWidth, palco.clientHeight, semMovimento() ? 'r' : 'm']
      .concat(nos.map(s => s.id + ':' + s.estado + ':' + (s.motivo || '') + ':' + (s.detalhe || ''))).join('|');
    if (ass !== E.assinatura) {
      E.assinatura = ass;
      desenhaLista(nos);
      if (!celular()) desenhaPalco(nos);
    }
    const cont = { conectado: 0, caido: 0, nao_medido: 0 };
    for (const s of todos) if (cont[s.estado] != null) cont[s.estado]++;
    $('scNConectado').textContent = cont.conectado;
    $('scNCaido').textContent = cont.caido;
    $('scNNaoMedido').textContent = cont.nao_medido;
    pintaIdade();
  }

  function pintaIdade() {
    const el = $('scMedido');
    if (!E.dados) { el.textContent = E.erro ? 'Sem medição' : 'Conferindo...'; return; }
    const seg = Math.max(0, Math.round((Date.now() - Date.parse(E.dados.medido_em)) / 1000));
    el.textContent = (E.erro ? 'Última medição boa há ' : 'Medido há ') + seg + ' s' + (E.erro ? ' (sem resposta agora)' : '');
  }

  /* ── Tutorial ── */
  function passos() {
    const alvoNo = celular() ? '#scLista .sc-item' : '#scNos .sc-no';
    return [
      { alvo: '#scPalco', titulo: 'O mapa dos sistemas',
        oque: 'O agente no centro e, em volta dele, tudo o que ele usa: as linhas de WhatsApp, o e-mail, o CRM e a geração de imagens.',
        como: 'Cada ligação é conferida de verdade no servidor, a cada 20 segundos, com prazo de 6 segundos por sistema. Nada aqui é desenho fixo.',
        porque: 'Numa reunião você mostra que o agente está plugado nos sistemas reais do cliente, e sabe na hora se algum caiu.' },
      { alvo: '#scAgente', titulo: 'O agente',
        oque: 'A foto e o nome do agente desta demonstração. O halo mostra se a sessão dele está de pé.',
        como: 'O painel pergunta ao runner do agente se a sessão está viva. Halo verde pulsando é sessão ativa; vermelho parado é sem resposta.',
        porque: 'Sem o agente de pé, nenhum dos outros sistemas adianta, então ele fica no centro.' },
      { alvo: alvoNo, titulo: 'Um sistema ligado',
        oque: 'Um sistema por círculo, com o nome, o estado e, quando não está conectado, o motivo escrito.',
        como: 'WhatsApp: a instância precisa estar conectada e a chave precisa poder enviar. CRM: a rota de saúde responde 200 com ok. Imagens: a chave é aceita pela OpenAI. Quando o provedor não oferece uma rota de status, aparece "não medido" com o porquê.',
        porque: 'Verde só aparece quando foi confirmado. O que não deu para medir nunca finge que está bem.' },
      { alvo: '#scLegenda', titulo: 'A legenda',
        oque: 'A contagem de sistemas conectados, caídos e não medidos, e há quantos segundos a última medição foi feita.',
        como: 'Luz correndo na linha é conexão confirmada. Linha vermelha parada é sistema caído. Linha cinza tracejada é sistema que não deu para medir.',
        porque: 'Para quem está de longe, na tela da reunião, entender o quadro em um olhar.' },
    ];
  }

  function boot() {
    raiz.DGSistemasTutorial = () => {
      if (!raiz.DGTour) { mostraErro('A visita guiada não carregou (tour.js). Recarregue a página.'); return; }
      raiz.DGTour.inicia({ passos: passos() });
    };
    busca();
    setInterval(busca, INTERVALO_MS);
    setInterval(pintaIdade, 1000);
    let t = null;
    raiz.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(desenha, 150); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') busca(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
