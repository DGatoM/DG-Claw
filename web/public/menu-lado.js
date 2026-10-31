'use strict';
/* menu-lado.js: o menu do agente na tela de conversa (gaveta no celular, barra fixa no computador).

   Mostra a foto do agente, o seletor para trocar de agente (cada item com a PRÓPRIA foto), a
   Conversa, as páginas do painel daquele agente e a seção Configurações (instalar o app).
   As partes que só montam texto (itemAgente, linksPainel, instrucaoInstalar) ficam fora do DOM e
   têm teste em web/test/menu-lado.test.js. Quem chama é o conversa.js, que já buscou a lista de
   /api/v1/agents: aqui ela não é buscada de novo, a não ser para o botão "recarregar". */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGMenuLado = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* chave = o que vai depois de #aba= (o painel abre a aba por ela) */
  const ABAS_PAINEL = [
    ['status', '◉', 'Status'], ['skills', '✦', 'Skills'], ['rotinas', '↻', 'Rotinas'],
    ['cofre', '⚿', 'Cofre (chaves)'], ['arquivos', '▢', 'Pasta do agente'],
    ['memory', '▤', 'Memória'], ['operations', '⚙', 'Operações'], ['costs', '◇', 'Custos'],
    ['como', '◎', 'Como funciona'], ['identity', '◈', 'Identidade'], ['personality', '◐', 'Personalidade'],
    ['apps', '▨', 'Apps'], ['socorro', '✚', 'Socorro'],
  ];


  /* Entradas fixas do menu: a tela de lembretes e a de avisos (valem para qualquer agente). */
  const LINK_LEMBRETES = { nome: 'Lembretes', ico: '⏰', href: '/lembretes' };
  const LINK_AVISOS = { nome: 'Avisos', ico: '🔔', href: '/avisos' };
  const LINK_SEGURANCA = { nome: 'Segurança', ico: '🛡', href: '/seguranca' };

  /* Sessões é item fixo para todo agente com painel (a tela fica no painel dele). Devolve o link do menu e os
     endereços que o menu consulta (config: a aba está ligada? pedidos: quantas sessões esperam o dono), ou null. */
  function linkSessoes(a) {
    if (!a || !a.tem_painel) return null;
    const base0 = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    const base = base0.replace(/\/*$/, '/');
    return { nome: 'Sessões', ico: '🖥', href: base + '#aba=sessoes',
      config: base + 'api/sessoes-config', pedidos: base + 'api/sessoes?grupo=esperando_voce&limite=1' };
  }

  /* Páginas fora do painel (Mesa, Lembretes) não têm o agente no caminho: levam ?a=<slug> para a
     tela saber de quem é o menu. */
  function comAgente(href, id) {
    if (!id) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'a=' + encodeURIComponent(id);
  }

  /* Qual item do menu o link representa: 'mesa', 'lembretes', a chave de #aba=... ou '' (outro). */
  function chaveDoHref(href) {
    const h = String(href || '');
    const aba = /#aba=([^&]*)/.exec(h);
    if (aba) return decodeURIComponent(aba[1]);
    const caminho = h.split(/[?#]/)[0].replace(/\/+$/, '');
    if (caminho === '/mesa') return 'mesa';
    if (caminho === '/lembretes') return 'lembretes';
    if (caminho === '/avisos') return 'avisos';
    if (caminho === '/seguranca') return 'seguranca';
    if (/^\/a\/[^/]+$/.test(caminho)) return 'conversa';
    return '';
  }

  /* Itens extras do painel que dependem do que está ligado (Sessões e os poderes). Cada um: { chave, ico, nome }. */
  function linksExtras(a, extras) {
    if (!a || !a.tem_painel || !Array.isArray(extras)) return [];
    const base = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    // Sessões é item fixo (linkSessoes): um painel de versão antiga que ainda a mande como extra não a duplica
    return extras.filter(x => x && x.chave && x.chave !== 'sessoes' && x.nome).map(x => ({ nome: x.nome, ico: x.ico || '•', href: base + '#aba=' + x.chave }));
  }

  /* Passos da visita guiada do menu, os mesmos na Conversa e nas outras telas.
     o = { nome, abre(), fecha(), comTroca, naConversa } */
  function passosMenu(o) {
    const nome = o.nome;
    const abre = o.abre || function () {};
    const passos = [{
      alvo: '#mlMoldura', antes: abre, titulo: 'O menu do agente',
      oque: 'A foto, o nome e as páginas de ' + nome + ', sempre no lado esquerdo. No computador ele fica aberto o tempo todo; no celular abre pelo botão ☰.',
      como: (o.naConversa ? 'O item Conversa (esta tela) fica no alto.' : 'O item Conversa, no alto, leva de volta ao chat.') +
        ' Os outros itens levam à Mesa, às Sessões de trabalho dele, aos Lembretes, aos Avisos, à Segurança e às páginas do painel dele. O Tutorial, aqui em cima, repete esta visita.',
      porque: 'Assim a conversa e o painel de cada agente ficam no mesmo lugar, sem link escondido.',
    }];
    if (o.comTroca) {
      passos.push({
        alvo: '#mlTroca', antes: abre, titulo: 'Trocar de agente',
        oque: 'Um seletor com todos os agentes que trabalham para você, cada um com a sua foto. O Admin vem primeiro, com o selo "admin"; o agente em que você está aparece marcado com "aqui".',
        como: 'Toque em "trocar de agente" e escolha um da lista: a conversa e o menu passam a ser dele. Cada agente tem a própria conversa e a própria memória.',
        porque: 'Você escolhe com quem falar sem sair desta tela. O Admin cuida da instalação e dos ajustes; os outros fazem o trabalho do dia a dia.',
      });
    }
    return passos;
  }

  /* A foto vem SEMPRE do próprio agente do item. Sem foto, círculo com a cor dele e a letra. */
  function fotoDe(a) {
    const img = a.avatar_img || (/^https:\/\//i.test(a.avatar || '') ? a.avatar : '');
    if (img) return `<img src="${esc(img)}" alt="">`;
    return esc(a.avatar || (a.nome || '?').slice(0, 1));
  }

  /* Hora da última mensagem: "hh:mm" se foi hoje, "ontem" ou "dd/mm". ts em epoch ms; sem ts (null,
     0 ou inválido) devolve '' e o item fica sem hora, porque "não sei" não é "meia-noite de 1970". */
  function horaCurta(ts, agora) {
    if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return '';
    const d = new Date(ts), hoje = agora ? new Date(agora) : new Date();
    const dia = x => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate();
    const p2 = n => String(n).padStart(2, '0');
    if (dia(d) === dia(hoje)) return p2(d.getHours()) + ':' + p2(d.getMinutes());
    const ontem = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);
    if (dia(d) === dia(ontem)) return 'ontem';
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1);
  }

  /* O selo de atenção de um agente. `a` traz o que o servidor diz (GET /api/v1/estados): estado, resumo,
     nao_lidas, marcada_nao_lida. Prioridade: precisa de você > não lido > trabalhando. O agente em que a pessoa
     já está não ganha selo (a própria conversa mostra o que ele faz). Devolve { tipo, rotulo, resumo } ou null.
     `nao_lidas` null (não medido) não vira bolinha; "sem sinal" também não vira selo nenhum. */
  function seloDe(a, aqui) {
    if (!a || aqui) return null;
    if (a.estado === 'precisa_de_voce') {
      return { tipo: 'precisa', rotulo: 'precisa de você' + (a.resumo ? ': ' + a.resumo : ''), resumo: a.resumo || '' };
    }
    const n = a.nao_lidas;
    const temN = typeof n === 'number' && isFinite(n) && n > 0;
    if (temN) return { tipo: 'nao_lido', rotulo: n + (n === 1 ? ' mensagem não lida' : ' mensagens não lidas') + (a.mais ? ' ou mais' : ''), n };
    if (a.marcada_nao_lida === true) return { tipo: 'marcada', rotulo: 'marcada como não lida' };
    if (a.estado === 'trabalhando') return { tipo: 'trabalhando', rotulo: 'trabalhando' };
    return null;
  }

  function seloMenu(a, aqui) {
    const s = seloDe(a, aqui);
    if (!s) return '';
    if (s.tipo === 'precisa') return `<span class="ml-aten" role="img" aria-label="${esc(s.rotulo)}">!</span>`;
    if (s.tipo === 'nao_lido') return bolinhaMenu(a, aqui);
    if (s.tipo === 'marcada') return `<span class="ml-nl ml-nl-ponto" role="img" aria-label="${esc(s.rotulo)}"></span>`;
    return `<span class="ml-trab" role="img" aria-label="${esc(s.rotulo)}"><i></i><i></i><i></i></span>`;
  }

  function itemAgente(a, atualId) {
    const aqui = a.id === atualId;
    const selo = seloDe(a, aqui);
    // quem precisa de você mostra o motivo no lugar do subtítulo: é a razão de olhar para ele agora
    const sub = selo && selo.tipo === 'precisa' && selo.resumo ? selo.resumo
      : (a.subtitulo || [a.provedor, a.modelo].filter(Boolean).join(' · '));
    const link = `<a class="ml-ag${aqui ? ' atual' : ''}${selo && selo.tipo === 'precisa' ? ' precisa' : ''}" role="menuitem" href="/a/${encodeURIComponent(a.id)}"` +
      `${aqui ? ' aria-current="page"' : ''}>` +
      `<span class="ml-mini" style="background:${esc(a.cor || '#2f9e5e')}">${fotoDe(a)}</span>` +
      `<span class="ml-quem"><b>${esc(a.nome)}</b><small>${esc(sub)}</small></span>` +
      `${aqui ? '<span class="ml-aqui">aqui</span>' : ''}` +
      `${horaCurta(a.ultima_ts) ? `<span class="ml-hora">${esc(horaCurta(a.ultima_ts))}</span>` : ''}` +
      `${seloMenu(a, aqui)}</a>`;
    if (aqui) return link;
    // O ⋯ é a via acessível para marcar como não lida (o toque longo no item faz o mesmo).
    const marcada = a.marcada_nao_lida === true;
    const id = esc(a.id);
    return `<div class="ml-linha">${link}` +
      `<button type="button" class="ml-mais" data-mais="${id}" aria-haspopup="true" aria-expanded="${a.acoes_abertas ? 'true' : 'false'}" ` +
      `aria-label="Mais ações de ${esc(a.nome)}" title="Mais ações">⋯</button>` +
      `<div class="ml-acoes"${a.acoes_abertas ? '' : ' hidden'}>` +
      `<button type="button" data-nao-lida="${id}" data-ligar="${marcada ? '0' : '1'}">${marcada ? 'Desmarcar como não lida' : 'Marcar como não lida'}</button></div></div>`;
  }

  /* Bolinha de não lidas. `a.nao_lidas` é número (a contagem do servidor), `a.mais` marca "passou do teto".
     null (não medido), 0 e o agente em que a pessoa já está não mostram nada: sumir é melhor que mentir. */
  function bolinhaMenu(a, aqui) {
    const n = a.nao_lidas;
    if (aqui || typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    const texto = (a.mais || n > 99) ? '99+' : String(n);
    const rot = n + (n === 1 ? ' mensagem não lida' : ' mensagens não lidas') + (a.mais ? ' ou mais' : '');
    return `<span class="ml-nl" role="img" aria-label="${esc(rot)}">${texto}</span>`;
  }

  /* Soma das não lidas dos OUTROS agentes. null (não medido) entra como nada, nunca como número.
     Conversa marcada como não lida, sem mensagem nova, conta como 1. */
  function totalNaoLidas(lista, contagens, atualId) {
    let total = 0;
    for (const a of lista || []) {
      const c = contagens && contagens[a.id];
      const n = c && c.nao_lidas;
      if (a.id === atualId) continue;
      if (typeof n === 'number' && isFinite(n) && n > 0) total += n;
      else if (c && c.marcada_nao_lida === true) total += 1;
    }
    return total;
  }

  /* Quantos dos OUTROS agentes precisam de você agora (liga o selo âmbar do ☰). */
  function totalPrecisam(lista, contagens, atualId) {
    let total = 0;
    for (const a of lista || []) {
      const c = contagens && contagens[a.id];
      if (a.id !== atualId && c && c.estado === 'precisa_de_voce') total += 1;
    }
    return total;
  }


  /* Uso das assinaturas (☰ > Uso das assinaturas). Verde abaixo de 70, âmbar de 70 a 89, vermelho a partir de 90. */
  function corUso(pct) { return pct >= 90 ? 'vermelho' : pct >= 70 ? 'ambar' : 'verde'; }

  /* "hoje 18:40", "amanhã 09:00", "qua 09:00" ou "25/10 09:00", no horário do aparelho. */
  function quandoZeraUso(iso, agora) {
    const d = new Date(iso), hoje = agora ? new Date(agora) : new Date();
    if (!isFinite(d.getTime())) return '';
    const p2 = n => String(n).padStart(2, '0');
    const dia0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dias = Math.round((dia0(d) - dia0(hoje)) / 86400000);
    const hora = p2(d.getHours()) + ':' + p2(d.getMinutes());
    if (dias === 0) return 'hoje ' + hora;
    if (dias === 1) return 'amanhã ' + hora;
    if (dias > 1 && dias < 7) return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()] + ' ' + hora;
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + ' ' + hora;
  }

  /* Uma mini barra. janela = { usado_pct, zera_em, vencida } ou null (não medido: "sem dado", nunca 0%). */
  function miniBarraUso(rotulo, janela, agora) {
    if (!janela || typeof janela.usado_pct !== 'number' || !isFinite(janela.usado_pct)) {
      return `<div class="ml-uso-lin"><span class="ml-uso-rot">${esc(rotulo)}</span><span class="ml-uso-bar"><i style="width:0"></i></span><span class="ml-uso-pct sem">sem dado</span></div>`;
    }
    if (janela.vencida) {
      return `<div class="ml-uso-lin" title="Zerou em ${esc(quandoZeraUso(janela.zera_em, agora))}. A nova medição chega na próxima resposta do agente."><span class="ml-uso-rot">${esc(rotulo)}</span><span class="ml-uso-bar"><i style="width:0"></i></span><span class="ml-uso-pct sem">zerou</span></div>`;
    }
    const pct = Math.max(0, Math.min(100, janela.usado_pct));
    const txt = (Number.isInteger(pct) ? String(pct) : pct.toFixed(1).replace('.', ',')) + '%';
    return `<div class="ml-uso-lin" title="Zera em ${esc(quandoZeraUso(janela.zera_em, agora))}"><span class="ml-uso-rot">${esc(rotulo)}</span>` +
      `<span class="ml-uso-bar ${corUso(pct)}" role="img" aria-label="${esc(rotulo)}: ${esc(txt)} usado"><i style="width:${pct}%"></i></span><span class="ml-uso-pct">${esc(txt)}</span></div>`;
  }

  /* Um agente na lista de uso. entrada = { uso, motivo? } ou { uso:null, erro }. */
  function itemUso(a, entrada, agora) {
    const nome = `<b class="ml-uso-nome">${esc(a.nome || a.id)}</b>`;
    if (!entrada) return `<div class="ml-uso-ag">${nome}<div class="ml-uso-nota">Sem resposta do servidor sobre este agente.</div></div>`;
    if (entrada.erro || !entrada.uso) {
      return `<div class="ml-uso-ag">${nome}${miniBarraUso('5 h', null)}${miniBarraUso('Sem', null)}` +
        `<div class="ml-uso-nota">${esc(entrada.erro || 'Sem dado de uso.')}</div></div>`;
    }
    const u = entrada.uso;
    const nota = entrada.motivo ? `<div class="ml-uso-nota">${esc(entrada.motivo)}</div>` : '';
    return `<div class="ml-uso-ag">${nome}${miniBarraUso('5 h', u.sessao_5h, agora)}${miniBarraUso('Sem', u.semanal, agora)}${nota}</div>`;
  }

  function linksPainel(a) {
    if (!a || !a.tem_painel) return [];
    const base = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    return ABAS_PAINEL.map(([chave, ico, nome]) => ({ nome, ico, href: base + '#aba=' + chave }));
  }

  /* env = { standalone, ios, promptGuardado }. Devolve { tipo, texto }:
     'instalado' (esconde o item), 'prompt' (chama o prompt do navegador), 'ios' ou 'sem' (só explica). */
  function instrucaoInstalar(env) {
    if (env.standalone) return { tipo: 'instalado', texto: '' };
    if (env.promptGuardado) return { tipo: 'prompt', texto: '' };
    if (env.ios) {
      return { tipo: 'ios', texto: 'Toque em Compartilhar (o quadrado com a seta para cima) e depois em Adicionar à Tela de Início.' };
    }
    return { tipo: 'sem', texto: 'Este navegador não oferece a instalação por aqui. No Chrome ou no Edge, abra o menu do navegador e procure Instalar app. No Firefox para computador, o recurso não existe.' };
  }

  if (!raiz.document) return { corUso, quandoZeraUso, miniBarraUso, itemUso, ABAS_PAINEL, LINK_LEMBRETES, LINK_AVISOS, LINK_SEGURANCA, linkSessoes, itemAgente, bolinhaMenu, seloDe, totalNaoLidas, totalPrecisam, horaCurta, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  let promptGuardado = null;
  // O Chrome dispara isto uma vez, cedo; sem guardar aqui o toque no item não teria o que chamar.
  window.addEventListener('beforeinstallprompt', ev => {
    ev.preventDefault();
    promptGuardado = ev;
    pintaInstalar();
  });
  window.addEventListener('appinstalled', () => { promptGuardado = null; pintaInstalar(); });

  const ehStandalone = () => navigator.standalone === true ||
    (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const ehIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function pintaInstalar() {
    const sec = $('mlConfig');
    if (!sec) return;
    const r = instrucaoInstalar({ standalone: ehStandalone(), ios: ehIos(), promptGuardado: !!promptGuardado });
    sec.hidden = r.tipo === 'instalado';
    $('mlInstalarSub').textContent = r.tipo === 'prompt' ? 'atalho na tela, abre sem barra do navegador'
      : 'como colocar na tela inicial';
  }

  function mostraCaixa(texto) {
    const c = $('mlInstalarAjuda');
    c.textContent = texto;
    c.hidden = !texto;
  }

  async function aoInstalar() {
    const r = instrucaoInstalar({ standalone: ehStandalone(), ios: ehIos(), promptGuardado: !!promptGuardado });
    if (r.tipo !== 'prompt') { mostraCaixa($('mlInstalarAjuda').hidden ? r.texto : ''); return; }
    const p = promptGuardado;
    promptGuardado = null;
    try {
      await p.prompt();
      const esc_ = await p.userChoice;
      mostraCaixa(esc_ && esc_.outcome === 'accepted' ? '' : 'Tudo bem. Se mudar de ideia, o item continua aqui no menu.');
    } catch (e) {
      console.warn('menu-lado: o navegador recusou abrir a instalação:', e.message);
      mostraCaixa('O navegador não abriu a instalação (' + e.message + '). Tente pelo menu do navegador, em Instalar app.');
    }
    pintaInstalar();
  }

  function pintaLista(ag, lista, erro) {
    const caixa = $('mlLista'), troca = $('mlTroca');
    if (erro) {
      troca.hidden = false;
      caixa.innerHTML = `<div class="ml-vazio" role="alert">Não consegui listar os agentes: ${esc(erro)}. ` +
        '<button type="button" id="mlRecarrega">Recarregar a lista</button></div>';
      $('mlRecarrega').onclick = recarrega.bind(null, ag);
      return;
    }
    // sem outro agente para onde ir, o seletor só atrapalha
    troca.hidden = lista.length < 2;
    const ordem = lista.filter(a => a.tipo === 'admin').concat(lista.filter(a => a.tipo !== 'admin'));
    ultimaLista = { ag, lista };
    caixa.innerHTML = ordem.map(a => {
      const c = contagens[a.id];
      const base = c ? Object.assign({}, a, { nao_lidas: c.nao_lidas, mais: c.mais, estado: c.estado, resumo: c.resumo, marcada_nao_lida: c.marcada_nao_lida }) : a;
      return itemAgente(Object.assign(base, { acoes_abertas: acoesAbertaDe === a.id }), ag.id);
    }).join('');
    pintaTotalTroca(totalNaoLidas(lista, contagens, ag.id), totalPrecisam(lista, contagens, ag.id));
  }

  /* A lista vem recolhida: sem o total no botão, a bolinha de cada agente só aparece depois do toque. */
  function pintaTotalTroca(total, precisam) {
    const btn = $('mlTrocaBtn');
    if (!btn) return;
    let aten = $('mlTrocaAten');
    if (!aten) {
      aten = document.createElement('span');
      aten.id = 'mlTrocaAten'; aten.className = 'ml-aten'; aten.setAttribute('role', 'img'); aten.textContent = '!';
      btn.insertBefore(aten, btn.querySelector('.ml-seta'));
    }
    aten.style.display = precisam > 0 ? '' : 'none';
    aten.setAttribute('aria-label', precisam + (precisam === 1 ? ' agente precisa de você' : ' agentes precisam de você'));
    let marca = $('mlTrocaNl');
    if (!marca) {
      marca = document.createElement('span');
      marca.id = 'mlTrocaNl'; marca.className = 'ml-nl'; marca.setAttribute('role', 'img');
      btn.insertBefore(marca, btn.querySelector('.ml-seta'));
    }
    marca.style.display = total > 0 ? '' : 'none';
    marca.textContent = total > 99 ? '99+' : String(total);
    marca.setAttribute('aria-label', total + (total === 1 ? ' mensagem não lida' : ' mensagens não lidas') + ' em outros agentes');
  }

  /* Contagens de não lidas por agente (slug -> objeto do servidor). Guardadas aqui para a lista de 30 s
     também pintar a bolinha, e repintada quando a tela entrega uma contagem nova. */
  let contagens = {}, ultimaLista = null, acoesAbertaDe = null;
  function defineNaoLidas(mapa) {
    contagens = mapa && typeof mapa === 'object' ? mapa : {};
    if (ultimaLista) pintaLista(ultimaLista.ag, ultimaLista.lista, null);
  }

  /* silencioso: nas buscas automáticas uma falha de rede passageira não troca a lista por um erro. */
  async function recarrega(ag, silencioso) {
    try {
      const r = await fetch('/api/v1/agents', { cache: 'no-store' });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
      pintaLista(ag, Array.isArray(d.agentes) ? d.agentes : [], null);
    } catch (e) {
      if (silencioso) console.warn('menu-lado: não consegui atualizar a lista de agentes (mantive a anterior):', e.message);
      else pintaLista(ag, [], e.message);
    }
  }


  /* ── Uso das assinaturas: só busca quando a seção é aberta, e repete a cada 60 s enquanto ela está aberta ── */
  let timerUso = null;
  async function carregaUso() {
    const caixa = $('mlUsoLista');
    if (!caixa) return;
    if (!caixa.innerHTML) caixa.innerHTML = '<div class="ml-vazio">Conferindo o uso...</div>';
    try {
      const r = await fetch('/api/v1/uso', { cache: 'no-store', credentials: 'same-origin' });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
      const lista = ultimaLista ? ultimaLista.lista : [];
      const nomes = new Map(lista.map(a => [a.id, a]));
      const slugs = Object.keys(d.agentes || {});
      const ordem = lista.map(a => a.id).filter(id => slugs.includes(id)).concat(slugs.filter(id => !nomes.has(id)));
      caixa.innerHTML = ordem.length
        ? ordem.map(id => itemUso(nomes.get(id) || { id, nome: id }, d.agentes[id], Date.now())).join('')
        : '<div class="ml-vazio">Nenhum agente no registro.</div>';
    } catch (e) {
      console.warn('menu-lado: não consegui ler o uso das assinaturas:', e.message);
      caixa.innerHTML = `<div class="ml-vazio" role="alert">Não consegui ver o uso das assinaturas: ${esc(e.message)}. Feche e abra esta seção para tentar de novo.</div>`;
    }
  }

  function ligaUso() {
    const det = $('mlUsoDet');
    if (!det || det._ligado) return;
    det._ligado = true;
    det.addEventListener('toggle', () => {
      if (timerUso) { clearInterval(timerUso); timerUso = null; }
      if (!det.open) return;
      carregaUso();
      timerUso = setInterval(() => { if (document.visibilityState === 'visible') carregaUso(); }, 60000);
    });
  }

  let agenteAtual = null;

  /* ── Sessões: o item do menu e o botão 🖥 do cabeçalho ──────────────────────
     Perguntamos UMA vez por agente se a aba está ligada (GET <painel>/api/sessoes-config), sem travar a tela.
     Só ligado:false esconde o item e o botão. Erro de rede ou resposta estranha NÃO esconde: o item fica e o
     motivo vai para o console, porque sumir com a porta por causa de um tropeço seria pior que mostrá-la. */
  const consultaSessoes = new Map();   // id do agente -> Promise<{ ligado: boolean|null }>
  function configSessoes(l, id) {
    if (!consultaSessoes.has(id)) {
      consultaSessoes.set(id, fetch(l.config, { cache: 'no-store', credentials: 'same-origin' })
        .then(async r => {
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) throw new Error('o painel respondeu ' + r.status + ' a ' + l.config);
          return { ligado: d.ligado === false ? false : true };
        })
        .catch(e => {
          console.warn('menu-lado: não consegui saber se a aba Sessões está ligada (' + e.message + '). Deixei o item no menu.');
          return { ligado: null };
        }));
    }
    return consultaSessoes.get(id);
  }

  /* Bolinha de pedidos: quantas sessões esperam uma decisão do dono. Sem contagem na resposta, sem bolinha. */
  async function contaPedidos(l) {
    const r = await fetch(l.pedidos, { cache: 'no-store', credentials: 'same-origin' });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.contagem) throw new Error('o painel respondeu ' + r.status + ' a ' + l.pedidos);
    return Number(d.contagem.esperando_voce) || 0;
  }

  function ligaSessoes(ag) {
    const l = linkSessoes(ag);
    if (!l) return;
    const itens = [$('mlSessoes'), $('btnSessoes')].filter(Boolean);
    const btn = $('btnSessoes');
    if (btn) { btn.href = l.href; btn.hidden = true; }
    const pinta = n => itens.forEach(el => {
      let b = el.querySelector('.sx-bol');
      if (n > 0 && !b) { b = document.createElement('i'); b.className = 'sx-bol'; b.setAttribute('aria-hidden', 'true'); el.appendChild(b); }
      if (b) b.hidden = !(n > 0);
      el.title = n > 0 ? 'Sessões (' + n + (n === 1 ? ' pedido esperando você)' : ' pedidos esperando você)') : 'Sessões de trabalho deste agente';
    });
    let avisouPedidos = false;
    const atualiza = () => {
      if (document.visibilityState !== 'visible') return;
      contaPedidos(l).then(pinta, e => {
        if (!avisouPedidos) { avisouPedidos = true; console.warn('menu-lado: sem a contagem de pedidos das Sessões (' + e.message + '); a bolinha fica apagada.'); }
      });
    };
    configSessoes(l, ag.id).then(c => {
      if (c.ligado === false) {
        const item = $('mlSessoes');
        if (item) item.parentElement.remove();
        if (btn) btn.remove();
        marca(chaveAtiva);
        return;
      }
      if (btn) btn.hidden = false;
      atualiza();
      document.addEventListener('visibilitychange', atualiza);
      setInterval(atualiza, 45000);
    });
  }

  /* Marca o item da página aberta (.ativo e aria-current). chave: 'conversa', 'mesa', 'lembretes' ou a de uma aba do painel.
     Chave sem item no menu (ex.: 'avisos') não marca nenhum. */
  let chaveAtiva = '';
  function marca(chave) {
    chaveAtiva = chave;
    document.querySelectorAll('#mlTabs .ml-tab').forEach(el => {
      const ativo = !!chave && chaveDoHref(el.getAttribute('href') || (el.id === 'gmIrConversa' ? '/a/x' : '')) === chave;
      el.classList.toggle('ativo', ativo);
      if (ativo) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
  }

  /* Troca os itens extras do painel (Sessões, Posts...): chamado de novo quando o que está ligado muda. */
  function extras(lista) {
    const painel = $('mlPainel');
    if (!painel || !agenteAtual) return;
    painel.querySelectorAll('[data-extra]').forEach(el => el.remove());
    const links = linksExtras(agenteAtual, lista);
    painel.insertAdjacentHTML('beforeend', links.map(l => `<a class="ml-tab" data-extra="1" href="${esc(l.href)}">` +
      `<span class="ml-ico" aria-hidden="true">${esc(l.ico)}</span>${esc(l.nome)}</a>`).join(''));
    painel.hidden = !painel.children.length;
    marca(chaveAtiva);
  }

  /* O ⋯ de cada item e o toque longo abrem "Marcar como não lida". A lista é repintada a cada contagem nova,
     então qual item está com as ações abertas fica guardado (acoesAbertaDe) e a repintura o mantém aberto. */
  function ligaAcoes(opcoes, troca) {
    const caixa = $('mlLista');
    const repinta = () => { if (ultimaLista) pintaLista(ultimaLista.ag, ultimaLista.lista, null); };
    caixa.addEventListener('click', async ev => {
      const mais = ev.target.closest('[data-mais]');
      if (mais) { acoesAbertaDe = acoesAbertaDe === mais.dataset.mais ? null : mais.dataset.mais; repinta(); return; }
      const acao = ev.target.closest('[data-nao-lida]');
      if (!acao) return;
      const slug = acao.dataset.naoLida, ligar = acao.dataset.ligar === '1';
      acao.disabled = true;
      try {
        if (typeof opcoes.marcarNaoLida !== 'function') throw new Error('esta tela não sabe marcar como não lida');
        await opcoes.marcarNaoLida(slug, ligar);
        acoesAbertaDe = null;
      } catch (e) {
        console.warn('menu-lado: não consegui ' + (ligar ? 'marcar' : 'desmarcar') + ' ' + slug + ' como não lida:', e.message);
        acao.disabled = false;
        acao.textContent = 'Não consegui: ' + e.message;
        return;
      }
      repinta();
    });
    /* Toque longo (~0,5 s) no item: abre as ações em vez de navegar. O clique que vem logo depois do
       soltar é engolido uma vez, senão a pessoa seria levada para a conversa. */
    let timer = null, longo = false;
    const cancela = () => { clearTimeout(timer); timer = null; };
    caixa.addEventListener('pointerdown', ev => {
      const item = ev.target.closest('a.ml-ag'); if (!item || item.classList.contains('atual')) return;
      longo = false; cancela();
      timer = setTimeout(() => {
        longo = true;
        const m = item.parentElement && item.parentElement.querySelector('[data-mais]');
        if (m) { acoesAbertaDe = m.dataset.mais; repinta(); }
      }, 500);
    });
    for (const nome of ['pointerup', 'pointerleave', 'pointercancel', 'scroll']) caixa.addEventListener(nome, cancela, true);
    caixa.addEventListener('click', ev => { if (longo && ev.target.closest('a.ml-ag')) { ev.preventDefault(); ev.stopPropagation(); } longo = false; }, true);
    caixa.addEventListener('contextmenu', ev => { if (ev.target.closest('a.ml-ag')) ev.preventDefault(); });
  }

  /* opcoes: { agente, agentes (a lista já carregada), fecha() (fecha a gaveta), ativo (chave da página aberta; padrão 'conversa'), extras (itens extras do painel), erroLista (texto: a lista de agentes falhou) } */
  function inicia(opcoes) {
    const ag = opcoes.agente;
    $('mlMoldura').innerHTML = `<span class="ml-foto" style="background:${esc(ag.cor || '#2f9e5e')}">${fotoDe(ag)}</span>`;
    $('mlNome').textContent = ag.nome;
    $('mlSub').textContent = ag.tipo === 'admin' ? 'administrador do servidor'
      : (ag.subtitulo || [ag.provedor, ag.modelo].filter(Boolean).join(' · '));
    document.documentElement.classList.add('ml-ativo');

    const troca = $('mlTroca'), btn = $('mlTrocaBtn');
    const abre = sim => { troca.classList.toggle('aberto', sim); btn.setAttribute('aria-expanded', String(sim)); };
    btn.onclick = () => abre(!troca.classList.contains('aberto'));
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && troca.classList.contains('aberto')) { abre(false); ev.stopPropagation(); }
    }, true);
    ligaAcoes(opcoes, troca);
    if (opcoes.erroLista) { pintaLista(ag, [], opcoes.erroLista); abre(true); }   // a lista não veio: o erro aparece já aberto
    else if (Array.isArray(opcoes.agentes)) pintaLista(ag, opcoes.agentes, null);
    else recarrega(ag);
    /* Agente criado ou apagado em outra aba aparece sem recarregar a página: a cada 30 s e quando a aba volta a ficar visível. */
    const atualiza = () => { if (document.visibilityState === 'visible') recarrega(ag, true); };
    document.addEventListener('visibilitychange', atualiza);
    setInterval(atualiza, 30000);

    const painel = $('mlPainel'), links = linksPainel(ag);
    painel.innerHTML = links.map(l => `<a class="ml-tab" href="${esc(l.href)}">` +
      `<span class="ml-ico" aria-hidden="true">${l.ico}</span>${esc(l.nome)}</a>`).join('');
    painel.hidden = !links.length;
    $('mlTabs').insertAdjacentHTML('beforeend', `<div data-tour="gm-lembretes"><a class="ml-tab" href="${comAgente(LINK_LEMBRETES.href, ag.id)}">` +
      `<span class="ml-ico" aria-hidden="true">${LINK_LEMBRETES.ico}</span>${LINK_LEMBRETES.nome}</a></div>`);
    $('mlTabs').insertAdjacentHTML('beforeend', `<div data-tour="gm-avisos"><a class="ml-tab" href="${comAgente(LINK_AVISOS.href, ag.id)}">` +
      `<span class="ml-ico" aria-hidden="true">${LINK_AVISOS.ico}</span>${LINK_AVISOS.nome}</a></div>`);
    $('mlTabs').insertAdjacentHTML('beforeend', `<div data-tour="gm-seguranca"><a class="ml-tab" href="${comAgente(LINK_SEGURANCA.href, ag.id)}">` +
      `<span class="ml-ico" aria-hidden="true">${LINK_SEGURANCA.ico}</span>${LINK_SEGURANCA.nome}</a></div>`);
    // a Mesa já está no HTML com href="/mesa": passa a levar o agente junto
    const mesa = document.querySelector('#mlTabs a[href="/mesa"]');
    if (mesa) mesa.setAttribute('href', comAgente('/mesa', ag.id));
    // Sessões logo depois da Mesa, para todo agente com painel, em todas as telas
    const sess = linkSessoes(ag);
    if (sess && mesa) {
      mesa.parentElement.insertAdjacentHTML('afterend', `<div data-tour="gm-sessoes"><a class="ml-tab" id="mlSessoes" href="${esc(sess.href)}">` +
        `<span class="ml-ico" aria-hidden="true">${sess.ico}</span>${sess.nome}</a></div>`);
    }
    ligaSessoes(ag);
    agenteAtual = ag;
    if (Array.isArray(opcoes.extras)) extras(opcoes.extras);

    /* Fora da Conversa, o item Conversa vira link para ela; na Conversa, só fecha a gaveta. */
    const irConversa = $('gmIrConversa');
    if (opcoes.ativo && opcoes.ativo !== 'conversa') {
      const a = document.createElement('a');
      a.className = 'ml-tab'; a.id = 'gmIrConversa';
      a.href = ag.id ? '/a/' + encodeURIComponent(ag.id) : '/';
      a.innerHTML = '<span class="ml-ico" aria-hidden="true">◔</span>Conversa';
      irConversa.replaceWith(a);
    } else {
      irConversa.onclick = () => opcoes.fecha();
    }
    marca(opcoes.ativo || 'conversa');
    $('mlInstalar').onclick = aoInstalar;
    // escolher uma página fecha a gaveta (a navegação em seguida troca a tela)
    $('mlTabs').addEventListener('click', ev => { if (ev.target.closest('a')) opcoes.fecha(); });
    ligaUso();
    pintaInstalar();
  }

  return { corUso, quandoZeraUso, miniBarraUso, itemUso, ABAS_PAINEL, LINK_LEMBRETES, LINK_AVISOS, LINK_SEGURANCA, linkSessoes, itemAgente, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar, inicia, marca, extras, defineNaoLidas, totalNaoLidas, totalPrecisam, seloDe };
});
