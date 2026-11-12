const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { COMO_RESOLVER } = require('./auth');

// `getAuth` e não `auth`: o login é construído com esta função de renderização, então ela só
// pode olhar o objeto de autenticação na hora do pedido.
module.exports = function buildHtmlTemplate({ BASE, CONFIG, serverDir, getAuth }) {
  // ─── HTML com {{BASE}} ────────────────────────────────────────
  //
  // index.html e login.html carregam caminho absoluto (css, js, assets, /login, /logout).
  // Atrás da fachada esses caminhos precisam do prefixo, então os dois deixam de ser
  // arquivo estático e viram TEMPLATE: lê o arquivo, troca {{BASE}} / {{BASE_JSON}} pelo
  // prefixo real, devolve. Cache por mtime (mesmo espírito do readPowers lá em cima): um
  // `git pull` no painel troca o conteúdo sem precisar reiniciar o processo.
  const PUBLIC_DIR = path.join(serverDir, 'public');
  const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
  const LOGIN_HTML = path.join(PUBLIC_DIR, 'login.html');
  const _htmlCache = new Map();

  // {{VOLTAR}}: a setinha de voltar para a estante.
  //
  // Só existe atrás da fachada, e por isso é template e não CSS: um DG Claw instalado
  // sozinho na máquina do dono não tem estante nenhuma para onde voltar, e um link morto
  // ali em cima seria pior que link nenhum. Servido pela plataforma, o painel vive na
  // MESMA origem da estante, que mora na raiz, e por isso o href é "/" e não precisa saber
  // o endereço de coisa alguma.
  // A tela principal do agente é a conversa do chat (/a/<slug>); o painel são as páginas dele.
  // O slug vem do próprio BASE ("/p/<slug>"), com o do config como reserva.
  const SLUG_DA_FACHADA = (BASE.match(/^\/p\/([^/]+)/) || [])[1] || CONFIG.agentSlug || '';
  const URL_CONVERSA = SLUG_DA_FACHADA ? `/a/${encodeURIComponent(SLUG_DA_FACHADA)}` : '/';
  const VOLTAR_CORPO = '<span aria-hidden="true">←</span><span class="btn-voltar-texto">conversa</span>';
  const VOLTAR_HTML = `<a class="btn-voltar" href="${URL_CONVERSA}" aria-label="voltar para a conversa">${VOLTAR_CORPO}</a>`;
  // Isolado, o iframe não pode navegar o topo: o link pede à moldura, que decide (casca-ponte.js).
  const VOLTAR_ISOLADO_HTML = `<a class="btn-voltar" href="#" data-dgclaw-ir="${URL_CONVERSA}" aria-label="voltar para a conversa">${VOLTAR_CORPO}</a>`;

  // {{CASCA}}: o cabeçalho e o menu da Conversa também no painel (web/public/casca.js).
  // Só sob a plataforma (BASE preenchido): os arquivos são servidos pelo Web, na raiz da MESMA origem,
  // por isso os caminhos são absolutos e não levam o prefixo. Painel solto não tem esses arquivos:
  // vira vazio e a tela fica exatamente como era. O casca.css vem ANTES do menu-lado.css (a ordem importa).
  //
  // Dentro da moldura do Web (painel isolado, X-DGClaw-Base) esses arquivos não valem: eles chamariam a API do Web, que
  // recusa quem não é da própria origem dele. No lugar entra o casca-ponte.js, que repassa à moldura, por postMessage,
  // só dados sem segredo (chave da aba, título, lista de extras).
  const CASCA_HTML = [
    '<link rel="stylesheet" href="/casca.css">',
    '<link rel="stylesheet" href="/menu-lado.css">',
    '<script src="/tour.js"></script>',
    '<script src="/menu-lado.js"></script>',
    '<script src="/casca.js"></script>',
  ].join('\n  ');

  const CASCA_PONTE_HTML = '<script src="{{BASE}}/js/casca-ponte.js"></script>';

  // Sob a plataforma o HTML já nasce com a classe da casca: o layout antigo nunca chega a aparecer
  // (main.css, html.casca.carregando). Sem a plataforma o painel solto fica como era.
  const HTML_CLASSE_PLATAFORMA = ' class="casca carregando"';

  // Versão dos css/js: hash do tamanho e da data de cada arquivo de public/js e public/css. Recalculada
  // a cada 5 segundos no máximo: um `git pull` sem reiniciar o painel muda o ?v= junto com os arquivos,
  // e o navegador, que guarda o arquivo versionado por um ano, busca o novo.
  const _versao = { em: 0, valor: '0' };
  function versaoDosAssets() {
    const agora = Date.now();
    if (agora - _versao.em < 5000) return _versao.valor;
    const h = crypto.createHash('sha1');
    for (const sub of ['css', 'js']) {
      let nomes = [];
      try { nomes = fs.readdirSync(path.join(PUBLIC_DIR, sub)).sort(); } catch { /* pasta ausente: entra vazia */ }
      for (const n of nomes) {
        try {
          const st = fs.statSync(path.join(PUBLIC_DIR, sub, n));
          if (st.isFile()) h.update(`${sub}/${n}:${st.size}:${Math.floor(st.mtimeMs)};`);
        } catch { /* arquivo sumiu entre a lista e a leitura */ }
      }
    }
    _versao.valor = h.digest('hex').slice(0, 10);
    _versao.em = agora;
    return _versao.valor;
  }
  const comVersao = (html) => html.split('{{VERSAO_ASSETS}}').join(versaoDosAssets());

  // {{CARREGANDO}}: o noscript e o vigia do estado "carregando". Só sob a plataforma, junto da classe no <html>.
  // O vigia fica no HTML (e não no app.js) para valer também quando o app.js nem chega a carregar: se a tela
  // não abrir em 8 segundos ela é liberada, e sem a casca montada volta o menu antigo.
  const CARREGANDO_HTML = [
    '<noscript><style>html.casca.carregando .principal{visibility:visible}html.casca.carregando body::before,html.casca.carregando body::after,html.casca.carregando .app::after{display:none}</style></noscript>',
    "<script>setTimeout(function(){var h=document.documentElement;if(!h.classList.contains('carregando'))return;h.classList.remove('carregando');if(!document.getElementById('cabecalho'))h.classList.remove('casca');console.warn('[painel] a tela passou de 8 segundos no estado carregando e foi liberada à força. Recarregue a página; se repetir, confira o console por erros do app.js.')},8000)</script>",
  ].join('\n  ');

  // Devolve o HTML do arquivo, com {{BASE}} trocado por `baseIsolada` quando o pedido veio pela moldura do Web
  // (senão pelo BASE fixo), ou null se o arquivo não existe. O que depende só do arquivo fica em cache por mtime;
  // a troca da base é por pedido, porque cada token do painel isolado tem a sua.
  function carregarTemplate(filePath, baseIsolada) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
    let cached = _htmlCache.get(filePath);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const html = fs.readFileSync(filePath, 'utf-8')
        .split('{{HTML_CLASSE}}').join(BASE ? HTML_CLASSE_PLATAFORMA : '')
        .split('{{CARREGANDO}}').join(BASE ? CARREGANDO_HTML : '');
      cached = { mtimeMs, html };
      _htmlCache.set(filePath, cached);
    }
    const efetiva = baseIsolada || BASE;
    // Ordem: os blocos primeiro (eles trazem {{BASE}} dentro), depois a base, depois o ?v= dos css/js.
    return cached.html
      .split('{{CASCA}}').join(BASE ? (baseIsolada ? CASCA_PONTE_HTML : CASCA_HTML) : '')
      .split('{{VOLTAR}}').join(BASE ? (baseIsolada ? VOLTAR_ISOLADO_HTML : VOLTAR_HTML) : '')
      .split('{{ISOLADO_JSON}}').join(baseIsolada ? JSON.stringify({ slug: SLUG_DA_FACHADA }) : 'null')
      .split('{{BASE_JSON}}').join(JSON.stringify(efetiva))
      .split('{{BASE}}').join(efetiva)
      // css/js do painel ganham ?v=<versão>; o valor entra a cada pedido (comVersao), não no cache do arquivo.
      .replace(/((?:href|src)="[^"]*\/(?:css|js)\/[^"?]+)"/g, '$1?v={{VERSAO_ASSETS}}"');
  }

  function renderHtmlTemplate(filePath) {
    return (req, res) => {
      const html = carregarTemplate(filePath, getAuth().baseIsolada(req));
      if (html === null) return res.status(404).send('Nao encontrado.');
      res.type('html').send(comVersao(html));
    };
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // A tela de login muda com o estado do servidor, e por isso os marcadores dela são
  // trocados a cada pedido (o arquivo em cache continua sendo um só):
  //   {{LOGIN_MODO}}   'trancado' | 'usuario' | 'senha'  (o CSS da página mostra o que cabe)
  //   {{LOGIN_MOTIVO}} por que está trancado (já escapado)
  //   {{LOGIN_COMO}}   o que fazer para destrancar (já escapado)
  //   {{LOGIN_ERRO}}   '' | 'bloqueado:<minutos>' (erro de senha vem por ?error=1)
  function renderLogin(req, res, o = {}) {
    const auth = getAuth();
    const html = carregarTemplate(LOGIN_HTML, auth.baseIsolada(req));
    if (html === null) return res.status(404).send('Nao encontrado.');
    const modo = auth.trancado ? 'trancado' : (auth.usuarioObrigatorio ? 'usuario' : 'senha');
    const erro = o.erro === 'bloqueado' ? `bloqueado:${o.min || 1}` : '';
    res.status(o.status || 200).type('html').send(comVersao(html)
      .split('{{LOGIN_MODO}}').join(modo)
      .split('{{LOGIN_MOTIVO}}').join(escHtml(auth.motivo || ''))
      .split('{{LOGIN_COMO}}').join(escHtml(COMO_RESOLVER))
      .split('{{LOGIN_ERRO}}').join(erro));
  }

  return { PUBLIC_DIR, INDEX_HTML, renderHtmlTemplate, renderLogin };
};
