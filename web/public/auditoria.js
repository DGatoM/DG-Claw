'use strict';
/* auditoria.js: a tela Auditoria (/auditoria), só para o TI. Filtros, lista paginada, indicação da corrente e exportação.
   Fala com /api/v1/auditoria (web/lib/ent/auditoria-completa.js). Só lê: ninguém altera a trilha por aqui.
   Parte pura (com teste): PASSOS, htmlIntegridade, htmlEvento, htmlLista, htmlFiltros, htmlExterna, paramsDoFiltro, urlDeExportar.
   Parte com DOM: DGAuditoria.montar(elemento). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGAuditoria = m;
    m.registra();
  }
})(this, function (raiz) {
  const C = raiz.DGContaComum || require('./conta-comum');
  const { esc } = C;

  const CAMPOS = ['de', 'ate', 'evento', 'quem', 'origem', 'q'];
  const ALERTAS = new Set(['login_falha', 'conta_trancada', 'acesso_negado', 'sso_falha', 'login_recusado_sso', 'login_emergencia_tentativa', '2fa_falha']);

  function paramsDoFiltro(f, extra) {
    const p = new URLSearchParams();
    for (const c of CAMPOS) if (f && f[c]) p.set(c, f[c]);
    for (const [k, v] of Object.entries(extra || {})) if (v != null && v !== '') p.set(k, v);
    return p.toString();
  }
  const urlDeExportar = (f, formato) => '/api/v1/auditoria/exportar?' + paramsDoFiltro(f, { formato });

  function htmlIntegridade(i) {
    if (!i) return '';
    if (i.ok) return '<div class="au-integra au-ok" role="status">Corrente íntegra: ' + esc(i.linhas) + ' linha(s) conferidas, nada foi alterado ou apagado no meio.</div>';
    const onde = i.quebradaEm ? 'Corrente quebrada na linha ' + esc(i.quebradaEm) + (i.arquivo ? ' (' + esc(i.arquivo) + ', linha ' + esc(i.linhaNoArquivo) + ')' : '') : 'Não consegui conferir a corrente';
    return '<div class="au-integra au-quebrada" role="alert">' + onde + '. ' + esc(i.motivo || '') + ' Veja o que fazer em docs/enterprise/SSO-AUDITORIA.md e rode no servidor: dgclaw auditoria verificar</div>';
  }

  function htmlExterna(e) {
    if (!e) return '';
    if (!e.configurado) return '<p class="cn-vazio">Envio para fora: ' + (e.erro_config ? esc(e.erro_config) : 'sem destino configurado. Rode no servidor: dgclaw auditoria externa configurar') + '</p>';
    const selos = ['<span class="cn-selo cn-on">' + esc(e.tipo) + ': ' + esc(e.destino) + '</span>'];
    selos.push(e.alerta ? '<span class="cn-selo cn-off">atrasado' + (e.corrente_alterada ? ' (corrente alterada)' : '') + '</span>' : '<span class="cn-selo cn-on">em dia</span>');
    if (e.pendentes) selos.push('<span class="cn-selo cn-aviso">' + esc(e.pendentes) + ' pendente(s)</span>');
    return '<div class="cn-linha">' + selos.join(' ') + '</div>' +
      '<div class="cn-fraco">Último envio: ' + esc(C.dataBr(e.ultimo_envio_ok && Date.parse(e.ultimo_envio_ok))) + ' · último selo: ' + esc(C.dataBr(e.selo_em && Date.parse(e.selo_em))) + '</div>' +
      (e.ultimo_erro ? '<div class="cn-erro">' + esc(e.ultimo_erro) + '</div>' : '');
  }

  function htmlEvento(e) {
    const dados = e.dados && Object.keys(e.dados).length ? '<pre class="au-dados">' + esc(JSON.stringify(e.dados, null, 2)) + '</pre>' : '';
    return '<li class="au-evento' + (ALERTAS.has(e.evento) ? ' au-alerta' : '') + '">' +
      '<div class="cn-linha"><span class="au-nome">' + esc(e.evento) + '</span> <span class="cn-selo">' + esc(e.origem) + '</span></div>' +
      '<div class="cn-fraco">' + esc(C.dataBr(Date.parse(e.ts))) + ' · ' + esc(e.quem) + '</div>' + dados +
      '<div class="au-hash">' + esc(String(e.hash).slice(0, 16)) + '…</div></li>';
  }

  function htmlLista(d) {
    if (!d.eventos.length) return '<p class="cn-vazio">Nenhum evento com esses filtros.</p>';
    return '<ul class="cn-lista">' + d.eventos.map(htmlEvento).join('') + '</ul>' +
      '<div class="au-pag"><button type="button" class="cn-btn cn-mini" data-acao="anterior"' + (d.pagina <= 1 ? ' disabled' : '') + '>Mais novos</button>' +
      '<span class="cn-fraco">página ' + esc(d.pagina) + ' de ' + esc(d.paginas) + ' · ' + esc(d.total) + ' evento(s)</span>' +
      '<button type="button" class="cn-btn cn-mini" data-acao="proxima"' + (d.pagina >= d.paginas ? ' disabled' : '') + '>Mais antigos</button></div>';
  }

  function opcoes(lista, atual, vazio) {
    return '<option value="">' + esc(vazio) + '</option>' + (lista || []).map((v) => '<option value="' + esc(v) + '"' + (v === atual ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
  }

  function htmlFiltros(f, ops) {
    const o = ops || {};
    return '<form class="au-filtros" data-form="filtro">' +
      '<label>De<input type="date" name="de" value="' + esc(f.de || '') + '"></label>' +
      '<label>Até<input type="date" name="ate" value="' + esc(f.ate || '') + '"></label>' +
      '<label>Evento<select name="evento">' + opcoes(o.eventos, f.evento, 'Todos') + '</select></label>' +
      '<label>Quem<select name="quem">' + opcoes(o.quem, f.quem, 'Todos') + '</select></label>' +
      '<label>Origem<select name="origem">' + opcoes(o.origens, f.origem, 'Todas') + '</select></label>' +
      '<label>Procurar no texto<input type="text" name="q" maxlength="80" value="' + esc(f.q || '') + '" autocomplete="off"></label>' +
      '<div class="cn-acoes"><button type="submit" class="cn-btn cn-forte">Filtrar</button><button type="button" class="cn-btn" data-acao="limpar">Limpar</button></div></form>';
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-cn-tour="titulo"]', titulo: 'Auditoria',
        oque: 'O registro de tudo o que as pessoas e o sistema fizeram: entradas, mudanças, comandos de agentes e ações do serviço de controle.',
        como: 'Cada linha guarda o hash da anterior, como elos de uma corrente. Mexer numa linha antiga quebra as seguintes, e esta tela confere a corrente inteira toda vez que abre.',
        porque: 'Para saber quem fez o quê e conseguir provar a um auditor, anos depois, que o registro não foi alterado.' },
    ],
    corrente: [
      { alvo: '[data-cn-tour="corrente"]', titulo: 'A corrente',
        oque: 'Diz se o registro está inteiro: "íntegra" ou "quebrada na linha N".',
        como: 'O servidor recalcula o hash de cada linha e compara com o que está gravado, atravessando os arquivos de cada mês. Uma linha alterada, apagada ou reordenada aparece com o arquivo e o número dela.',
        porque: 'Quebrada não prova má-fé (disco cheio também quebra), mas é o sinal para investigar antes de confiar no registro.' },
    ],
    filtros: [
      { alvo: '[data-cn-tour="filtros"]', titulo: 'Filtros',
        oque: 'Escolha o período, o tipo de evento, a pessoa ou a origem (web, cli, controle) e procure um texto.',
        como: 'As datas são em UTC. A origem diz de onde veio a linha: web (painel), cli (comando no servidor) ou controle (serviço de controle).',
        porque: 'O registro cresce rápido; o filtro leva você direto ao que importa, por exemplo "todos os acessos negados da semana".' },
    ],
    lista: [
      { alvo: '[data-cn-tour="lista"]', titulo: 'Os eventos',
        oque: 'Do mais novo para o mais antigo: nome do evento, origem, quando, quem e os detalhes.',
        como: 'Os eventos em vermelho são os que merecem olho: login recusado, acesso negado, conta trancada, falha no login único.',
        porque: 'A senha, a saída dos comandos e o conteúdo das conversas nunca entram aqui: só o que foi feito, por quem e quando.' },
    ],
    exportar: [
      { alvo: '[data-cn-tour="exportar"]', titulo: 'Exportar',
        oque: 'Baixa os eventos do filtro atual em JSONL (as linhas originais, que continuam conferíveis) ou em CSV (para planilha).',
        como: 'A exportação também é registrada na auditoria, com o filtro usado e quantos eventos saíram.',
        porque: 'É o arquivo que você entrega à auditoria da empresa ou ao jurídico. No servidor, o mesmo comando é: dgclaw auditoria exportar.' },
    ],
  };

  const puros = { PASSOS, CAMPOS, htmlIntegridade, htmlExterna, htmlEvento, htmlLista, htmlFiltros, paramsDoFiltro, urlDeExportar };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null;
  let filtro = {};
  let pagina = 1;

  const q = (s) => raizEl.querySelector(s);
  function status(msg, erro) {
    const s = q('#cnStatus');
    s.textContent = msg || '';
    s.className = 'cn-status' + (erro ? ' cn-erro' : (msg ? ' cn-ok' : ''));
  }

  function tela() {
    return '<div class="cn-tela"><header class="cn-cab" data-cn-tour="titulo"><h1>Auditoria</h1>' +
      '<button type="button" class="cn-btn" data-cn-tutorial="pagina">Tutorial</button></header>' +
      '<p id="cnStatus" class="cn-status" role="status" aria-live="polite"></p>' +
      '<section class="cn-sec" data-cn-tour="corrente"><h2>A corrente <button type="button" class="cn-ajuda" data-cn-tutorial="corrente" aria-label="Ajuda sobre a corrente">?</button></h2><div id="auIntegra"></div><div id="auExterna"></div></section>' +
      '<section class="cn-sec" data-cn-tour="filtros"><h2>Filtros <button type="button" class="cn-ajuda" data-cn-tutorial="filtros" aria-label="Ajuda sobre os filtros">?</button></h2><div id="auFiltros"></div></section>' +
      '<section class="cn-sec" data-cn-tour="exportar"><h2>Exportar <button type="button" class="cn-ajuda" data-cn-tutorial="exportar" aria-label="Ajuda sobre exportar">?</button></h2>' +
      '<div class="cn-acoes"><button type="button" class="cn-btn" data-acao="exportar-jsonl">Baixar JSONL</button><button type="button" class="cn-btn" data-acao="exportar-csv">Baixar CSV</button></div></section>' +
      '<section class="cn-sec" data-cn-tour="lista"><h2>Eventos <button type="button" class="cn-ajuda" data-cn-tutorial="lista" aria-label="Ajuda sobre os eventos">?</button></h2><div id="auLista"></div></section></div>';
  }

  async function carrega() {
    status('Carregando…');
    try {
      const d = await C.api('GET', '/api/v1/auditoria?' + paramsDoFiltro(filtro, { pagina, por: 50 }));
      pagina = d.pagina;
      q('#auIntegra').innerHTML = htmlIntegridade(d.integridade);
      q('#auExterna').innerHTML = htmlExterna(d.externa);
      q('#auFiltros').innerHTML = htmlFiltros(filtro, d.opcoes);
      q('#auLista').innerHTML = htmlLista(d);
      status('');
    } catch (e) { status(e.message, true); }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.corrente, PASSOS.filtros, PASSOS.exportar, PASSOS.lista) : PASSOS[chave];
    const cab = q('.cn-cab');
    if (chave === 'pagina' && cab && cab.offsetParent === null && document.getElementById('cabecalho')) {
      passos = passos.map((p) => (p.alvo === '[data-cn-tour="titulo"]' ? Object.assign({}, p, { alvo: '#cabecalho' }) : p));
    }
    raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('cn-raiz');
    elemento.innerHTML = tela();
    elemento.addEventListener('click', (ev) => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.cnTutorial) tour(t.dataset.cnTutorial);
      else if (t.dataset.acao === 'proxima') { pagina += 1; carrega(); }
      else if (t.dataset.acao === 'anterior') { pagina = Math.max(1, pagina - 1); carrega(); }
      else if (t.dataset.acao === 'limpar') { filtro = {}; pagina = 1; carrega(); }
      else if (t.dataset.acao === 'exportar-jsonl') raiz.location.href = urlDeExportar(filtro, 'jsonl');
      else if (t.dataset.acao === 'exportar-csv') raiz.location.href = urlDeExportar(filtro, 'csv');
    });
    elemento.addEventListener('submit', (ev) => {
      if (!ev.target.dataset || ev.target.dataset.form !== 'filtro') return;
      ev.preventDefault();
      const fd = new FormData(ev.target);
      filtro = {};
      for (const c of CAMPOS) { const v = String(fd.get(c) || '').trim(); if (v) filtro[c] = v; }
      pagina = 1;
      carrega();
    });
    return carrega();
  }

  function registra() {
    const el = document.getElementById('auditoriaRaiz');
    if (el) montar(el);
  }

  return Object.assign({ montar, registra }, puros);
});
