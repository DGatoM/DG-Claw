const fs = require('fs');
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
  const VOLTAR_HTML =
    `<a class="btn-voltar" href="${URL_CONVERSA}" aria-label="voltar para a conversa">` +
    '<span aria-hidden="true">←</span><span class="btn-voltar-texto">conversa</span></a>';

  // {{CASCA}}: o cabeçalho e o menu da Conversa também no painel (web/public/casca.js).
  // Só sob a plataforma (BASE preenchido): os arquivos são servidos pelo Web, na raiz da MESMA origem,
  // por isso os caminhos são absolutos e não levam o prefixo. Painel solto não tem esses arquivos:
  // vira vazio e a tela fica exatamente como era. O casca.css vem ANTES do menu-lado.css (a ordem importa).
  const CASCA_HTML = [
    '<link rel="stylesheet" href="/casca.css">',
    '<link rel="stylesheet" href="/menu-lado.css">',
    '<script src="/tour.js"></script>',
    '<script src="/menu-lado.js"></script>',
    '<script src="/casca.js"></script>',
  ].join('\n  ');

  // Devolve o HTML já com {{BASE}} trocado, ou null se o arquivo não existe.
  function carregarTemplate(filePath) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
    const cached = _htmlCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.html;
    const html = fs.readFileSync(filePath, 'utf-8')
      .split('{{CASCA}}').join(BASE ? CASCA_HTML : '')
      .split('{{VOLTAR}}').join(BASE ? VOLTAR_HTML : '')
      .split('{{BASE_JSON}}').join(JSON.stringify(BASE))
      .split('{{BASE}}').join(BASE);
    _htmlCache.set(filePath, { mtimeMs, html });
    return html;
  }

  function renderHtmlTemplate(filePath) {
    return (req, res) => {
      const html = carregarTemplate(filePath);
      if (html === null) return res.status(404).send('Nao encontrado.');
      res.type('html').send(html);
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
    const html = carregarTemplate(LOGIN_HTML);
    if (html === null) return res.status(404).send('Nao encontrado.');
    const modo = auth.trancado ? 'trancado' : (auth.usuarioObrigatorio ? 'usuario' : 'senha');
    const erro = o.erro === 'bloqueado' ? `bloqueado:${o.min || 1}` : '';
    res.status(o.status || 200).type('html').send(html
      .split('{{LOGIN_MODO}}').join(modo)
      .split('{{LOGIN_MOTIVO}}').join(escHtml(auth.motivo || ''))
      .split('{{LOGIN_COMO}}').join(escHtml(COMO_RESOLVER))
      .split('{{LOGIN_ERRO}}').join(erro));
  }

  return { PUBLIC_DIR, INDEX_HTML, renderHtmlTemplate, renderLogin };
};
