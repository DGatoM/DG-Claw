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
  /* Ícone de item: 'i-<nome>' vira o ícone do sprite (/ds/icones.svg); qualquer outro texto (os itens que o painel
     acrescenta trazem um símbolo) sai escapado, como antes. */
  const icoHtml = v => /^i-[a-z0-9-]+$/.test(String(v)) ? '<svg class="ds-ico" aria-hidden="true"><use href="/ds/icones.svg#' + v + '"/></svg>' : esc(v);

  /* chave = o que vai depois de #aba= (o painel abre a aba por ela) */
  const ABAS_PAINEL = [
    ['status', 'i-activity', 'Status'], ['skills', 'i-sparkle', 'Skills'], ['rotinas', 'i-repeat', 'Rotinas'],
    ['cofre', 'i-vault', 'Cofre (chaves)'], ['arquivos', 'i-folder', 'Pasta do agente'],
    ['memory', 'i-layers', 'Memória'], ['operations', 'i-settings', 'Operações'], ['costs', 'i-gem', 'Custos'],
    ['como', 'i-info', 'Como funciona'], ['identity', 'i-id', 'Identidade'], ['personality', 'i-smile', 'Personalidade'],
    ['apps', 'i-layout', 'Apps'], ['socorro', 'i-lifebuoy', 'Socorro'],
  ];


  /* Entradas fixas do menu: a tela de lembretes e a de avisos (valem para qualquer agente). */
  const LINK_LEMBRETES = { nome: 'Lembretes', ico: 'i-clock', href: '/lembretes' };
  const LINK_AVISOS = { nome: 'Avisos', ico: 'i-bell', href: '/avisos' };
  const LINK_MANUAL = { nome: 'Manual', ico: 'i-book', href: '/manual' };
  const LINK_SEGURANCA = { nome: 'Segurança', ico: 'i-shield', href: '/seguranca' };
  const LINK_CONECTAR = { nome: 'Conectar conta', ico: 'i-key', href: '/conectar' };
  const LINK_COLABORADOR = { nome: 'Convidar colaborador', ico: 'i-users', href: '/colaboradores' };
  const ehColaborador = () => !!(raiz.DGPapel && raiz.DGPapel.colaborador);
  const LINK_ANONIMIZAR = { nome: 'Anonimizar', ico: 'i-glasses', href: '/anonimizar' };

  /* Sessões é item fixo para todo agente com painel (a tela fica no painel dele). Devolve o link do menu e os
     endereços que o menu consulta (config: a aba está ligada? pedidos: quantas sessões esperam o dono), ou null. */
  function linkSessoes(a) {
    if (!a || !a.tem_painel) return null;
    const base0 = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    const base = base0.replace(/\/*$/, '/');
    return { nome: 'Sessões', ico: 'i-monitor', href: base + '#aba=sessoes',
      config: base + 'api/sessoes-config', pedidos: base + 'api/sessoes?grupo=esperando_voce&limite=1' };
  }

  /* Navegador: abre em outra aba o painel do agente já na Tela (VNC interativo), onde o dono faz os logins. O Admin não tem. */
  function linkTela(a) {
    if (!a || !a.tem_painel || a.tipo === 'admin') return null;
    const base = (a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/')).replace(/\/*$/, '/');
    return { nome: 'Navegador', ico: 'i-globe', href: base + '#aba=tela', alvo: '_blank' };
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
    if (caminho === '/manual' || caminho.startsWith('/manual/')) return 'manual';
    if (caminho === '/conectar') return 'conectar';
    if (caminho === '/colaboradores') return 'colaboradores';
    if (caminho === '/anonimizar') return 'anonimizar';
    if (/^\/a\/[^/]+$/.test(caminho)) return 'conversa';
    return '';
  }

  /* Ícones dos itens extras que o painel conhece; qualquer outro usa o ponto. */
  const ICONES_EXTRAS = { posts: 'i-image', followers: 'i-users', reunioes: 'i-video' };

  /* Itens extras do painel que dependem do que está ligado (Sessões e os poderes). Cada um: { chave, ico, nome }. */
  function linksExtras(a, extras) {
    if (!a || !a.tem_painel || !Array.isArray(extras)) return [];
    const base = a.painel_url || ('/p/' + encodeURIComponent(a.id) + '/');
    // Sessões é item fixo (linkSessoes): um painel de versão antiga que ainda a mande como extra não a duplica
    return extras.filter(x => x && x.chave && x.chave !== 'sessoes' && x.nome).map(x => ({ nome: x.nome, ico: ICONES_EXTRAS[x.chave] || (/^i-[a-z0-9-]+$/.test(String(x.ico)) ? x.ico : 'i-dot'), href: base + '#aba=' + x.chave }));
  }

  /* ── Grupos do menu ─────────────────────────────────────────────────────────────────────────────────────
     Conversa e Mesa ficam fixas no alto (casca.js), seguidas de Pasta do agente. As outras páginas ficam em acordeões;
     Como funciona, Manual e Socorro ficam soltos no fim. O que não está nesta tabela (Navegador, Posts, Seguidores, Reuniões e os
     itens que o painel acrescentar) vai para o grupo "Conexões", que só existe quando há pelo menos um deles.
     Conectar conta e Anonimizar entram em Ferramentas, e Convidar colaborador em Segurança (quem tem acesso ao quê). */
  const GRUPOS_MENU = [
    { id: 'perfil', nome: 'Perfil do agente', ico: 'i-id', chaves: ['identity', 'personality', 'memory'] },
    { id: 'dia', nome: 'Dia a dia', ico: 'i-calendar', chaves: ['rotinas', 'lembretes', 'sessoes'] },
    { id: 'ferramentas', nome: 'Ferramentas', ico: 'i-package', chaves: ['skills', 'apps', 'conectar', 'anonimizar'] },
    { id: 'operacao', nome: 'Operação', ico: 'i-activity', chaves: ['status', 'operations', 'costs'] },
    { id: 'seguranca', nome: 'Segurança', ico: 'i-shield', chaves: ['seguranca', 'cofre', 'avisos', 'colaboradores'] },
  ];
  const GRUPO_CONEXOES = { id: 'conexoes', nome: 'Conexões', ico: 'i-globe' };
  const CHAVES_FIXAS = ['arquivos'];
  const CHAVES_RODAPE = ['como', 'manual', 'socorro'];
  const CHAVE_ABERTOS = 'dgclaw:menu-grupos';

  /* Todos os itens que este agente tem no menu (fora Conversa e Mesa, que vêm no HTML). Cada um: { chave, nome, ico, href, id?, alvo?, tour? }. */
  function montaItens(ag, colab) {
    const itens = linksPainel(ag).filter(l => !colab || chaveDoHref(l.href) !== 'cofre')
      .map(l => ({ chave: chaveDoHref(l.href), nome: l.nome, ico: l.ico, href: l.href }));
    const id = ag && ag.id;
    const fixo = (chave, l, tour) => itens.push({ chave, nome: l.nome, ico: l.ico, href: comAgente(l.href, id), tour });
    if (!colab) { fixo('lembretes', LINK_LEMBRETES, 'gm-lembretes'); fixo('avisos', LINK_AVISOS, 'gm-avisos'); fixo('seguranca', LINK_SEGURANCA, 'gm-seguranca'); itens.push({ chave: 'manual', nome: LINK_MANUAL.nome, ico: LINK_MANUAL.ico, href: LINK_MANUAL.href, tour: 'gm-manual' }); }
    fixo('conectar', LINK_CONECTAR, 'gm-conectar');
    if (!colab) fixo('anonimizar', LINK_ANONIMIZAR, 'gm-anonimizar');
    // Convidar colaborador: só o dono, e nunca para o Admin (o Admin mexe no servidor inteiro)
    if (!colab && ag && ag.tipo !== 'admin' && id) {
      itens.push({ chave: 'colaboradores', nome: LINK_COLABORADOR.nome, ico: LINK_COLABORADOR.ico, href: LINK_COLABORADOR.href + '?agente=' + encodeURIComponent(id), tour: 'gm-colaborador' });
    }
    const sess = linkSessoes(ag);
    if (sess) itens.push({ chave: 'sessoes', nome: sess.nome, ico: sess.ico, href: sess.href, id: 'mlSessoes', tour: 'gm-sessoes' });
    // Colaborador não vê a Tela do agente: o navegador logado é do dono.
    const tela = colab ? null : linkTela(ag);
    if (tela) itens.push({ chave: 'tela', nome: tela.nome, ico: tela.ico, href: tela.href, id: 'mlTela', alvo: tela.alvo, tour: 'gm-tela' });
    return itens;
  }

  /* Reparte os itens: { fixos, grupos: [{ id, nome, ico, itens }], conexoes, rodape }. Grupo sem item não aparece. */
  function organizaMenu(itens) {
    const por = new Map();
    for (const i of itens) if (i && i.chave && !por.has(i.chave)) por.set(i.chave, i);
    const usados = new Set();
    const pega = chaves => chaves.map(c => por.get(c)).filter(Boolean).map(i => { usados.add(i.chave); return i; });
    const fixos = pega(CHAVES_FIXAS);
    const grupos = GRUPOS_MENU.map(g => ({ id: g.id, nome: g.nome, ico: g.ico, itens: pega(g.chaves) })).filter(g => g.itens.length);
    const rodape = pega(CHAVES_RODAPE);
    const conexoes = (itens || []).filter(i => i && !usados.has(i.chave));
    return { fixos, grupos, conexoes, rodape };
  }

  function itemMenuHtml(it) {
    const a = `<a class="ml-tab"${it.id ? ` id="${esc(it.id)}"` : ''}${it.extra ? ' data-extra="1"' : ''} href="${esc(it.href)}"` +
      `${it.alvo ? ` target="${esc(it.alvo)}" rel="noopener"` : ''}>` +
      `<span class="ml-ico" aria-hidden="true">${icoHtml(it.ico)}</span>${esc(it.nome)}</a>`;
    return it.tour ? `<div data-tour="${esc(it.tour)}">${a}</div>` : a;
  }

  /* Um acordeão. aberto: boolean. O cabeçalho é um botão com aria-expanded e aria-controls; o conteúdo fechado fica invisível
     (visibility:hidden no CSS) e sai da ordem do Tab. Os selos de atenção entram em [data-selos], sempre visíveis no cabeçalho. */
  function grupoHtml(g, aberto) {
    const idLista = 'mlG-' + g.id;
    return `<div class="ml-grupo${aberto ? ' aberto' : ''}" data-grupo="${esc(g.id)}" data-tour="gm-grupo-${esc(g.id)}"${g.vazio ? ' hidden' : ''}>` +
      `<button type="button" class="ml-grupo-cab" id="${idLista}-b" aria-expanded="${aberto ? 'true' : 'false'}" aria-controls="${idLista}">` +
      `<span class="ml-ico" aria-hidden="true">${icoHtml(g.ico)}</span><span class="ml-grupo-nome">${esc(g.nome)}</span>` +
      `<span class="ml-grupo-selos" data-selos></span>` +
      `<span class="ml-grupo-seta" aria-hidden="true">${icoHtml('i-chevron-down')}</span></button>` +
      `<div class="ml-grupo-itens" id="${idLista}" role="group" aria-labelledby="${idLista}-b"><div class="ml-grupo-lista" data-itens>` +
      g.itens.map(i => itemMenuHtml(i)).join('') + `</div></div></div>`;
  }

  /* O miolo do #mlPainel. abertos: { [idDoGrupo]: boolean } (o que a pessoa deixou aberto, vindo do aparelho). */
  function menuHtml(org, abertos) {
    const ab = abertos || {};
    const cx = Object.assign({ itens: org.conexoes, vazio: !org.conexoes.length }, GRUPO_CONEXOES);
    return org.fixos.map(i => itemMenuHtml(i)).join('') +
      org.grupos.map(g => grupoHtml(g, ab[g.id] === true)).join('') +
      grupoHtml(cx, ab[GRUPO_CONEXOES.id] === true) +
      (org.rodape.length ? `<div class="ml-solto">${org.rodape.map(i => itemMenuHtml(i)).join('')}</div>` : '');
  }

  /* Qual grupo guarda o item dessa chave ('' se for fixo, solto ou não existir). */
  function grupoDaChave(chave) {
    if (!chave) return '';
    const g = GRUPOS_MENU.find(x => x.chaves.indexOf(chave) >= 0);
    if (g) return g.id;
    return CHAVES_FIXAS.indexOf(chave) >= 0 || CHAVES_RODAPE.indexOf(chave) >= 0 || chave === 'conversa' || chave === 'mesa' ? '' : GRUPO_CONEXOES.id;
  }

  /* Passos da visita guiada do menu, os mesmos na Conversa e nas outras telas.
     o = { nome, abre(), fecha(), comTroca, naConversa } */
  function passosMenu(o) {
    const nome = o.nome;
    const abre = o.abre || function () {};
    if (o.colaborador) {
      return [{
        alvo: '#mlMoldura', antes: abre, titulo: 'O menu',
        oque: 'A foto e o nome de ' + nome + ', o agente com quem você conversa, e as páginas dele: a Conversa, as Sessões de trabalho, as páginas do painel (Rotinas, Memória, Pasta e as outras, reunidas em grupos que abrem e fecham) e Conectar conta.',
        como: (o.naConversa ? 'O item Conversa (esta tela) fica no alto.' : 'O item Conversa, no alto, leva de volta ao chat.') + ' Cada página do painel abre na mesma janela. Conectar conta serve para ligar a sua conta de IA ao agente, quando ele ainda não tem uma. No fim do menu, o botão Sair encerra a sua sessão.',
        porque: 'Você tem acesso a tudo deste agente. Os outros agentes e as configurações do sistema inteiro (chaves, colaboradores, cofre) ficam com o dono.',
      }];
    }
    const passos = [{
      alvo: '#mlMoldura', antes: abre, titulo: 'O menu do agente',
      oque: 'A foto, o nome e as páginas de ' + nome + ', sempre no lado esquerdo. No computador ele fica aberto o tempo todo; no celular abre pelo botão de menu (as três linhas).',
      como: (o.naConversa ? 'O item Conversa (esta tela) fica no alto.' : 'O item Conversa, no alto, leva de volta ao chat.') +
        ' Os outros itens levam à Mesa, às Sessões de trabalho dele, à Tela (o navegador dele, onde você faz os logins), aos Lembretes, aos Avisos, à Segurança, à Anonimizar (documentos sem dados pessoais), a Conectar conta (onde você conecta a conta do Claude de cada agente) e às páginas do painel dele. O Tutorial, aqui em cima, repete esta visita.',
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
    // Os grupos: o passo seguinte aponta para um item que fica dentro de um grupo e abre esse grupo antes de apontar.
    const abreGrupo = id => {
      abre();
      const f = typeof o.abreGrupo === 'function' ? o.abreGrupo : (raiz.DGMenuLado && raiz.DGMenuLado.abreGrupo);
      if (typeof f === 'function') f(id);
    };
    passos.push({
      alvo: '[data-tour="gm-painel"]', antes: abre, titulo: 'Os grupos do menu',
      oque: 'As páginas de ' + nome + ' estão reunidas em grupos que abrem e fecham: Perfil do agente, Dia a dia, Ferramentas, Operação e Segurança. Conversa, Mesa e Pasta do agente ficam sempre à vista, e Como funciona e Socorro ficam soltos no fim.',
      como: 'Toque no nome de um grupo para abrir ou fechar. O grupo da página em que você está abre sozinho, e o menu lembra neste aparelho quais você deixou abertos. Uma bolinha no nome do grupo avisa que há algo esperando você lá dentro, mesmo com ele fechado. Um grupo só aparece se ele tiver algo para você.',
      porque: 'Eram mais de vinte itens em fila. Agrupados, o que você usa todo dia fica à mão e o resto fica a um toque.',
    });
    passos.push({
      alvo: '[data-tour="gm-lembretes"]', antes: () => abreGrupo('dia'), titulo: 'Um item dentro de um grupo',
      oque: 'Os Lembretes ficam no grupo Dia a dia, junto com as Rotinas e as Sessões. Esta visita abriu o grupo para apontar o item.',
      como: 'Quando a visita precisa mostrar um item de um grupo fechado, ela abre o grupo sozinha. Fora da visita, você abre o grupo tocando no nome dele.',
      porque: 'Assim nenhum item fica escondido de quem está aprendendo o menu.',
    });
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

  /* Quantos dos OUTROS agentes precisam de você agora (liga o selo âmbar do menu). */
  function totalPrecisam(lista, contagens, atualId) {
    let total = 0;
    for (const a of lista || []) {
      const c = contagens && contagens[a.id];
      if (a.id !== atualId && c && c.estado === 'precisa_de_voce') total += 1;
    }
    return total;
  }


  /* Uso das assinaturas (menu > Uso das assinaturas). Verde abaixo de 70, âmbar de 70 a 89, vermelho a partir de 90. */
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

  if (!raiz.document) return { GRUPOS_MENU, GRUPO_CONEXOES, montaItens, organizaMenu, menuHtml, grupoHtml, grupoDaChave, corUso, quandoZeraUso, miniBarraUso, itemUso, ABAS_PAINEL, LINK_LEMBRETES, LINK_AVISOS, LINK_MANUAL, LINK_SEGURANCA, LINK_CONECTAR, LINK_COLABORADOR, LINK_ANONIMIZAR, linkSessoes, linkTela, itemAgente, bolinhaMenu, seloDe, totalNaoLidas, totalPrecisam, horaCurta, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar };

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

  /* ── Sessões: o item do menu e o botão monitor do cabeçalho ──────────────────────
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
      if (el.id === 'mlSessoes') seloDoGrupo(el, n, n + (n === 1 ? ' pedido esperando você nas Sessões' : ' pedidos esperando você nas Sessões'));
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
    const g = grupoDaChave(chave);
    if (g) { const el = document.querySelector('#mlPainel [data-grupo="' + g + '"]'); if (el && !el.hidden) alternaGrupo(el, true, false); }
  }

  /* Troca os itens extras do painel (Posts, Seguidores, Reuniões...): chamado de novo quando o que está ligado muda.
     Eles vão para o grupo Conexões, ao lado do Navegador; o grupo só aparece com pelo menos um item. */
  function extras(lista) {
    const painel = $('mlPainel');
    if (!painel || !agenteAtual) return;
    painel.querySelectorAll('[data-extra]').forEach(el => el.remove());
    const grupo = painel.querySelector('[data-grupo="conexoes"]');
    if (!grupo) return;
    const links = linksExtras(agenteAtual, lista).map(l => ({ chave: 'extra-' + chaveDoHref(l.href), nome: l.nome, ico: l.ico, href: l.href, extra: true }));
    grupo.querySelector('[data-itens]').insertAdjacentHTML('beforeend', links.map(l => itemMenuHtml(l)).join(''));
    grupo.hidden = !grupo.querySelector('[data-itens]').children.length;
    marca(chaveAtiva);
  }

  /* ── Acordeões ─────────────────────────────────────────────────────────────────────────────────────────
     O que a pessoa deixou aberto fica neste aparelho (localStorage). Sem armazenamento (navegação privada, bloqueio), o menu
     funciona igual e só não lembra. O grupo da página em que a pessoa está abre sozinho, sem gravar nada. */
  function abertosGuardados() {
    try {
      const v = JSON.parse(localStorage.getItem(CHAVE_ABERTOS) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) {
      console.warn('menu-lado: não consegui ler quais grupos do menu estavam abertos (' + e.message + '); eles começam fechados.');
      return {};
    }
  }
  function guardaAberto(id, sim) {
    try {
      const v = abertosGuardados();
      v[id] = sim;
      localStorage.setItem(CHAVE_ABERTOS, JSON.stringify(v));
    } catch (e) {
      console.warn('menu-lado: não consegui guardar o grupo "' + id + '" do menu como ' + (sim ? 'aberto' : 'fechado') + ' (' + e.message + '); ele vale só até recarregar a página.');
    }
  }
  function alternaGrupo(el, sim, guardar) {
    el.classList.toggle('aberto', sim);
    const b = el.querySelector('.ml-grupo-cab');
    if (b) b.setAttribute('aria-expanded', String(sim));
    if (guardar) guardaAberto(el.dataset.grupo, sim);
  }
  function ligaGrupos(painel) {
    painel.addEventListener('click', ev => {
      const b = ev.target.closest('.ml-grupo-cab');
      if (!b) return;
      const g = b.closest('.ml-grupo');
      alternaGrupo(g, !g.classList.contains('aberto'), true);
    });
  }
  /* Abre um grupo sem gravar (a visita guiada usa, para apontar um item que está dentro dele). */
  function abreGrupo(id) {
    const g = document.querySelector('#mlPainel [data-grupo="' + String(id).replace(/[^a-z0-9-]/g, '') + '"]');
    if (g && !g.hidden) alternaGrupo(g, true, false);
  }
  /* Selo de atenção no cabeçalho do grupo (visível com o grupo fechado). n = 0 tira o selo. */
  function seloDoGrupo(el, n, rotulo) {
    const g = el && el.closest && el.closest('.ml-grupo');
    const alvo = g && g.querySelector('[data-selos]');
    if (!alvo) return;
    alvo.innerHTML = n > 0 ? `<span class="ml-nl" role="img" aria-label="${esc(rotulo)}">${n > 99 ? '99+' : n}</span>` : '';
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
    const colab = ehColaborador();
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
    else if (!colab) recarrega(ag);
    /* Agente criado ou apagado em outra aba aparece sem recarregar a página: a cada 30 s e quando a aba volta a ficar visível. */
    if (!colab) {
      const atualiza = () => { if (document.visibilityState === 'visible') recarrega(ag, true); };
      document.addEventListener('visibilitychange', atualiza);
      setInterval(atualiza, 30000);
    }

    // Os itens do menu, repartidos em grupos (montaItens/organizaMenu). O cofre do agente é do dono: o colaborador não vê a entrada.
    const painel = $('mlPainel');
    const itens = montaItens(ag, colab);
    painel.innerHTML = menuHtml(organizaMenu(itens), abertosGuardados());
    painel.hidden = !painel.children.length;
    ligaGrupos(painel);
    // A Mesa já está no HTML com href="/mesa": passa a levar o agente junto (e some para o colaborador).
    const mesa = document.querySelector('#mlTabs a[href="/mesa"]');
    if (mesa) {
      if (colab) mesa.parentElement.remove();
      else mesa.setAttribute('href', comAgente('/mesa', ag.id));
    }
    ligaSessoes(ag);
    agenteAtual = ag;
    if (Array.isArray(opcoes.extras)) extras(opcoes.extras);
    if (colab) mostraQuem();

    /* Fora da Conversa, o item Conversa vira link para ela; na Conversa, só fecha a gaveta. */
    const irConversa = $('gmIrConversa');
    if (opcoes.ativo && opcoes.ativo !== 'conversa') {
      const a = document.createElement('a');
      a.className = 'ml-tab'; a.id = 'gmIrConversa';
      a.href = ag.id ? '/a/' + encodeURIComponent(ag.id) : '/';
      a.innerHTML = '<span class="ml-ico" aria-hidden="true">'+icoHtml('i-message')+'</span>Conversa';
      irConversa.replaceWith(a);
    } else {
      irConversa.onclick = () => opcoes.fecha();
    }
    marca(opcoes.ativo || 'conversa');
    $('mlInstalar').onclick = aoInstalar;
    // escolher uma página fecha a gaveta (a navegação em seguida troca a tela)
    $('mlTabs').addEventListener('click', ev => { if (ev.target.closest('a')) opcoes.fecha(); });
    if (colab) { const uso = $('mlUso'); if (uso) uso.remove(); } else ligaUso();
    pintaInstalar();
  }

  /* Colaborador: mostra quem está logado, debaixo do nome do agente. O nome vem de GET /api/v1/eu (rota que ele tem). */
  function mostraQuem() {
    const marca = document.querySelector('.ml-marca');
    if (!marca || $('mlQuem')) return;
    const p = document.createElement('div');
    p.className = 'ml-sub'; p.id = 'mlQuem';
    marca.insertBefore(p, $('mlSub').nextSibling);
    fetch('/api/v1/eu', { cache: 'no-store', credentials: 'same-origin' })
      .then(async r => { const d = await r.json().catch(() => null); if (!r.ok || !d) throw new Error('a API respondeu ' + r.status); return d; })
      .then(d => { p.textContent = 'Você: ' + (d.nome ? d.nome + ' (' + d.usuario + ')' : d.usuario); })
      .catch(e => { console.warn('menu-lado: não consegui saber quem está logado (' + e.message + '); o menu segue sem o nome.'); });
  }

  return { GRUPOS_MENU, GRUPO_CONEXOES, montaItens, organizaMenu, menuHtml, grupoHtml, grupoDaChave, abreGrupo, corUso, quandoZeraUso, miniBarraUso, itemUso, ABAS_PAINEL, LINK_LEMBRETES, LINK_AVISOS, LINK_MANUAL, LINK_SEGURANCA, LINK_CONECTAR, LINK_COLABORADOR, LINK_ANONIMIZAR, linkSessoes, linkTela, itemAgente, linksPainel, linksExtras, comAgente, chaveDoHref, passosMenu, instrucaoInstalar, inicia, marca, extras, defineNaoLidas, totalNaoLidas, totalPrecisam, seloDe };
});
