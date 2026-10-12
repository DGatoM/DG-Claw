// Prefixo do painel quando ele vive atrás de uma fachada (ex.: /agente/ana/painel).
// index.html grava window.DGCLAW_BASE ANTES deste script carregar; vazio = raiz, igual
// a sempre. Toda URL chamada por este arquivo precisa passar por aqui.
const BASE = window.DGCLAW_BASE || '';

/**
 * Avisa a tela que uma leitura falhou, com o motivo que o servidor mandou.
 *
 * POR QUE ISTO EXISTE (vistoria de 01/10/2026, docs/VISTORIA-2026-10-01.md 2.3).
 * O `get` transformava qualquer erro em `null` e quem chamava fazia `if (!data)
 * return;`. A tela congelava no último estado (a Conversa ficava dizendo
 * "trabalhando" com o painel fora do ar), e a frase em português que o servidor
 * tinha mandado no corpo do erro ia para o lixo. Agora o `get` continua devolvendo
 * `null` (os carregadores antigos seguem funcionando), mas ANTES dispara um evento
 * com o motivo, e o app.js mostra esse motivo numa faixa no topo da tela.
 */
function avisarErroApi(url, status, corpo) {
  try {
    window.dispatchEvent(new CustomEvent('dgclaw:erro-api', {
      detail: { url, status, error: (corpo && (corpo.error || corpo.erro)) || null, howToFix: (corpo && corpo.howToFix) || null },
    }));
  } catch { /* navegador sem CustomEvent: o erro só não aparece na faixa */ }
}
function avisarOkApi(url) {
  try { window.dispatchEvent(new CustomEvent('dgclaw:ok-api', { detail: { url } })); } catch { /* idem */ }
}

// API wrapper - all fetch calls
const API = {
  async get(url) {
    let res;
    try {
      res = await fetch(BASE + url);
    } catch (e) {
      // Sem rede ou painel fora do ar: antes isto virava uma exceção solta, que
      // ninguém pegava, e a tela parava no meio de um carregamento.
      avisarErroApi(url, 0, { error: `não alcancei o painel (${e.message})`, howToFix: 'Confira a internet e recarregue a página.' });
      return null;
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return null; }
    if (!res.ok) {
      let corpo = {};
      try { corpo = await res.json(); } catch { /* resposta sem json */ }
      // 423 é "poder não instalado": a aba já aparece com cadeado, não é erro.
      if (res.status !== 423) avisarErroApi(url, res.status, corpo);
      return null;
    }
    try {
      const dados = await res.json();
      avisarOkApi(url);
      return dados;
    } catch (e) {
      avisarErroApi(url, res.status, { error: 'o painel respondeu algo que não dá para ler', howToFix: 'Recarregue a página.' });
      return null;
    }
  },
  /**
   * Leitura ou escrita que devolve SEMPRE {ok, status, corpo}, como o post. É o
   * contrato das telas novas: quem chama decide o que mostrar com o motivo na mão,
   * em vez de receber um `null` que não diz nada.
   */
  async pedir(url, opcoes) {
    let res;
    try {
      res = await fetch(BASE + url, opcoes);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}`, howToFix: 'Confira a internet e tente de novo.' } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  },
  put: (url, body) => API.pedir(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  }),
  /**
   * POST. Diferente do get: devolve {ok, status, corpo} em vez de null no erro,
   * porque o corpo da recusa TRAZ a frase e o remédio que a tela precisa mostrar.
   * Engolir isso viraria "não funcionou" sem dizer o quê, que é o oposto da regra
   * de erro que se explica sozinho.
   */
  async post(url, body) {
    let res;
    try {
      res = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  },
  config: () => API.get('/api/config'),
  // A conversa. Ler é GET; escrever e parar são as duas ÚNICAS ações do painel que
  // tocam a sessão viva, e por isso vêm com o corpo do erro inteiro (é dele que sai
  // a frase que a tela mostra quando a mensagem não sai).
  chatMensagens: (last) => API.get(`/api/chat/mensagens?last=${last || 80}`),
  chatEnviar: (text) => API.post('/api/chat/mensagem', { text }),
  chatParar: () => API.post('/api/chat/parar', {}),
  // Acordar o terminal. Também POST com o corpo inteiro do erro: se não subir,
  // a frase que a tela mostra é a que veio do servidor.
  chatReativar: () => API.post('/api/chat/reativar', {}),
  /**
   * O ditado. Manda o áudio CRU, sem JSON e sem base64: um blob de dois minutos
   * cresce um terço quando vira texto em base64, e isso é espera a mais na tela de
   * quem acabou de falar. O content-type é o do próprio MediaRecorder, porque é
   * dele que o transcritor deduz o formato.
   */
  async chatTranscrever(blob) {
    let res;
    try {
      res = await fetch(BASE + '/api/chat/transcrever', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  },
  powers: () => API.get('/api/powers'),
  overview: () => API.get('/api/overview'),
  emotions: () => API.get('/api/emotions'),
  thoughts: () => API.get('/api/thoughts'),
  posts: (limit) => API.get(`/api/posts?limit=${limit || 30}`),
  postsByDate: (date) => API.get(`/api/posts?date=${date}`),
  postsStats: () => API.get('/api/posts/stats'),
  commentsRecent: () => API.get('/api/comments/recent'),
  followersTop: () => API.get('/api/followers/top'),
  followersStats: () => API.get('/api/followers/stats'),
  memory: () => API.get('/api/memory'),
  memoryFile: (path) => API.get(`/api/memory/file?path=${encodeURIComponent(path)}`),
  personality: () => API.get('/api/personality'),
  identity: () => API.get('/api/identity'),
  crons: (date) => API.get(`/api/operations/crons${date ? '?date=' + date : ''}`),
  logs: (type, lines) => API.get(`/api/operations/logs?type=${type || 'heartbeat'}&lines=${lines || 30}`),
  session: () => API.get('/api/operations/session'),
  diary: (limit) => API.get(`/api/diary?limit=${limit || 20}`),
  pulso: (date) => API.get(`/api/pulso${date ? '?date=' + date : ''}`),
  rotinas: () => API.get('/api/rotinas'),
  // ── reorganização do painel (frente B, 01/10/2026): contrato {ok,status,corpo} ──
  operacoes: (atualizar) => API.pedir(`/api/operacoes${atualizar ? '?atualizar=1' : ''}`),
  rotinasUsuario: () => API.pedir('/api/rotinas/usuario'),
  cerebro: () => API.pedir('/api/cerebro'),
  memoriaArquivo: (path) => API.pedir(`/api/memoria/arquivo?path=${encodeURIComponent(path)}`),
  memoriaSalvar: (path, conteudo, versaoLida) => API.put('/api/memoria/arquivo', { path, conteudo, versaoLida }),
  radiografia: () => API.pedir('/api/radiografia'),
  saude: () => API.pedir('/api/saude'),
  saudeReiniciar: (modo) => API.post('/api/saude/reiniciar', { modo }),
  workingMemory: () => API.get('/api/working-memory'),
  personalityChangelog: () => API.get('/api/personality/changelog'),
  costsOverview: () => API.get('/api/costs/overview'),
  costsExecutions: (hours, cron, category) => {
    const q = new URLSearchParams();
    if (hours) q.set('hours', hours);
    if (cron) q.set('cron', cron);
    if (category) q.set('category', category);
    return API.get('/api/costs/executions?' + q.toString());
  },
  costsExecution: (sessionId) => API.get('/api/costs/execution/' + encodeURIComponent(sessionId)),
  costsAnalyze: async (sessionId) => {
    const res = await fetch(BASE + '/api/costs/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) return null;
    return res.json();
  },
};
