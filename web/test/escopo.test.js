'use strict';
// Escopo do colaborador: tabela de casos. Regra: tudo que tem o slug do agente dele passa; o que é de outro agente
// ou da caixa inteira é negado; rota nova sem slug nasce fechada.
const test = require('node:test');
const assert = require('node:assert/strict');
const { avaliar, websocketLiberado } = require('../lib/escopo');

const DONO = { usuario: 'dono', papel: 'dono', agente: null };
const CAIXA = { usuario: 'agente:ana', via: 'caixa', agente: 'ana' };
const COLAB = { usuario: 'maria@x.com', papel: 'colaborador', agente: 'ana', trocar_senha: false };
const COLAB_TEMP = Object.assign({}, COLAB, { trocar_senha: true });

const LIBERADOS = [
  ['GET', '/'], ['HEAD', '/'],
  ['GET', '/a/ana'], ['GET', '/a/ana/'], ['GET', '/conectar'], ['GET', '/conectar/'], ['GET', '/trocar-senha'],
  ['GET', '/conversa.js'], ['GET', '/casca.css'], ['GET', '/icons/icon-192.png'], ['GET', '/manifest.webmanifest'], ['GET', '/sw.js'], ['GET', '/videos/x.mp4'],
  ['GET', '/api/v1/eu'], ['POST', '/api/v1/eu/senha'], ['GET', '/api/v1/agents'], ['GET', '/api/v1/nao-lidas'],
  ['GET', '/api/v1/agents/ana'], ['GET', '/api/v1/agents/ana/avatar'], ['HEAD', '/api/v1/agents/ana/avatar'],
  ['GET', '/api/v1/agents/ana/messages'], ['GET', '/api/v1/agents/ana/stream'], ['GET', '/api/v1/agents/ana/wait'],
  ['POST', '/api/v1/agents/ana/send'], ['POST', '/api/v1/agents/ana/permissao'], ['POST', '/api/v1/agents/ana/pergunta'],
  ['POST', '/api/v1/agents/ana/reiniciar'], ['POST', '/api/v1/agents/ana/lido'], ['POST', '/api/v1/agents/ana/nao-lido'],
  ['DELETE', '/api/v1/agents/ana/nao-lido'], ['POST', '/api/v1/agents/ana/vendo'], ['POST', '/api/v1/agents/ana/upload'],
  ['GET', '/api/v1/agents/ana/compartilhados'],
  ['GET', '/api/v1/agents/ana/alertas'], ['POST', '/api/v1/agents/ana/alertas/0123456789abcdef01234567/visto'],
  ['GET', '/api/v1/agents/ana/alertas/0123456789abcdef01234567/mensagem'],
  // tudo sob o slug dele passa, inclusive o que ainda não existe
  ['GET', '/api/v1/agents/ana/rota-nova'], ['PUT', '/api/v1/agents/ana/algo/mais/fundo'], ['DELETE', '/api/v1/agents/ana/qualquer-coisa'],
  ['GET', '/api/v1/media/0123456789abcdef'], ['GET', '/api/v1/media/0123456789abcdef/thumb'], ['GET', '/api/v1/media/0123456789abcdef/visual'],
  ['POST', '/api/v1/transcribe'], ['POST', '/api/v1/tts'], ['GET', '/api/v1/tts/cota'],
  ['GET', '/api/v1/conectar/docs.md'], ['GET', '/api/v1/login/docs.md'],
  // o painel inteiro do agente dele
  ['GET', '/p/ana/'], ['GET', '/p/ana'], ['GET', '/p/ana/index.html'], ['GET', '/p/ana/js/app.js'], ['GET', '/p/ana/css/estilo.css'],
  ['GET', '/p/ana/api/sessoes'], ['GET', '/p/ana/api/sessoes/abc/conversa'], ['POST', '/p/ana/api/sessoes/abc/arquivar'], ['POST', '/p/ana/api/sessoes/abc/renomear'], ['POST', '/p/ana/api/sessoes/abc/favorito'], ['POST', '/p/ana/api/sessoes/abc/desarquivar'],
  ['GET', '/p/ana/api/sessoes-config'], ['GET', '/p/ana/api/rotinas'], ['GET', '/p/ana/api/rotinas/usuario'],
  ['GET', '/p/ana/api/memory'], ['GET', '/p/ana/api/memoria/arquivo'],
  ['GET', '/p/ana/api/arquivos'],
  ['GET', '/p/ana/api/socorro/estado'],
  ['GET', '/p/ana/api/uso'],
  ['GET', '/p/ana/api/chat/mensagens'], ['POST', '/p/ana/api/chat/transcrever'], ['GET', '/p/ana/api/apps'], ['GET', '/p/ana/api/skills'],
  // o prefixo fechado é por segmento: um nome parecido não fecha
  ['GET', '/p/ana/api/cofre-outra-coisa'], ['GET', '/p/ana/api/chaves-api-outra-coisa'],
  // nome com espaço ou acento codificado é legítimo na aba Pasta
  ['GET', '/p/ana/api/arquivos/baixar?caminho=a%20b.txt'], ['GET', '/p/ana/api/arquivos/conteudo?caminho=%C3%A9.txt'],
];

/** Separa o que o server.js entrega (pathname) do caminho cru (com a consulta), como no pedido de verdade. */
const avalia = (sessao, m, cru) => avaliar(sessao, m, new URL(cru, 'http://local').pathname, cru);

test('escopo: dono e caixa passam por tudo, inclusive o que é só do dono', () => {
  for (const s of [DONO, CAIXA, { usuario: 'antigo' }]) {
    for (const [m, p] of [...LIBERADOS, ['GET', '/mesa'], ['GET', '/p/bob/'], ['GET', '/p/ana/api/cofre'], ['POST', '/p/ana/api/provedor'], ['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/agents/bob/send'], ['GET', '/api/v1/cofre']]) {
      assert.deepEqual(avalia(s, m, p), { ok: true }, `${s.usuario} ${m} ${p}`);
    }
  }
});

test('escopo: sem sessão não avalia nada como liberado', () => {
  assert.equal(avaliar(null, 'GET', '/a/ana').ok, false);
});

test('escopo: colaborador passa o agente dele inteiro (conversa, painel, sessões, rotinas, memória, arquivos)', () => {
  for (const [m, p] of LIBERADOS) assert.deepEqual(avalia(COLAB, m, p), { ok: true }, `${m} ${p}`);
});

test('escopo: slug de outro agente é negado em cada forma, na API e no painel', () => {
  const casos = [
    ['GET', '/api/v1/agents/bob'], ['GET', '/api/v1/agents/bob/messages'], ['POST', '/api/v1/agents/bob/send'], ['GET', '/api/v1/agents/bob/stream'],
    ['POST', '/api/v1/agents/bob/upload'], ['GET', '/api/v1/agents/bob/login'], ['POST', '/api/v1/agents/bob/login/codigo'], ['POST', '/api/v1/agents/bob/login/oi'],
    ['GET', '/api/v1/agents/bob/alertas'], ['GET', '/api/v1/agents/bob/avatar'], ['POST', '/api/v1/agents/bob/comando'], ['GET', '/api/v1/agents/bob/x'],
    ['GET', '/api/v1/agents/admin/messages'], ['GET', '/api/v1/agents/ANA/messages'], ['GET', '/api/v1/agents/An%61/messages'],
    ['GET', '/api/v1/agents/ana%2Fbob/messages'], ['GET', '/api/v1/agents/%2e%2e/messages'], ['GET', '/api/v1/agents/bob%20/send'],
    ['GET', '/p/bob/'], ['GET', '/p/bob'], ['GET', '/p/admin/'], ['GET', '/p/ANA/'], ['GET', '/p/An%61/'], ['POST', '/p/bob/api/sessoes'], ['GET', '/p/bob/api/memory'], ['GET', '/p/%2e%2e/x'],
  ];
  for (const [m, p] of casos) {
    const r = avalia(COLAB, m, p);
    assert.equal(r.ok, false, `${m} ${p} devia ser negado`);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.motivo, /agente/i, `${m} ${p}`);
  }
  // slug com codificação inválida: a URL nem normaliza, o escopo avalia o texto como veio
  const r = avaliar(COLAB, 'GET', '/api/v1/agents/%E0%A4%A/messages');
  assert.equal(r.ok, false); assert.equal(r.status, 403);
});

test('escopo: páginas de outro agente e telas globais viram redirecionamento para o agente dele', () => {
  for (const p of ['/a/bob', '/a/admin', '/a/ANA', '/a/An%61', '/mesa', '/lembretes', '/avisos', '/seguranca', '/colaboradores', '/mesa.html', '/conversa.html', '//a/ana', '/a//ana', '/a/ana/extra']) {
    const r = avaliar(COLAB, 'GET', p);
    assert.equal(r.ok, false, p);
    assert.equal(r.status, 302, p);
    assert.equal(r.redirecionar, '/a/ana', p);
  }
  assert.equal(avaliar(COLAB, 'GET', '/p').ok, false);
  assert.equal(avaliar(COLAB, 'GET', '/p/').ok, false);
});

/** Formas de escrever o mesmo caminho fechado: barra final, maiúsculas, subcaminho. */
const formas = (base) => [base, `${base}/`, `${base.replace('/api/', '/API/')}`, base.toUpperCase().replace('/P/ANA', '/p/ana'), `${base}/sub`, `${base}/sub/`];

test('escopo: o cofre do agente é fechado dentro do painel, com a frase certa, em todos os métodos e formas', () => {
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    for (const v of formas('/p/ana/api/cofre')) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
      assert.equal(r.motivo, 'O cofre é só do dono do DG Claw.', `${m} ${v}`);
      assert.equal(r.extra.error, 'O cofre é só do dono do DG Claw.');
    }
  }
  assert.equal(avalia(COLAB, 'POST', '/p/ana/api/cofre/aplicar').ok, false);
});

test('escopo: as chaves de API do painel são fechadas, em todos os métodos e formas', () => {
  for (const m of ['GET', 'POST', 'DELETE']) {
    for (const v of formas('/p/ana/api/chaves-api')) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
      assert.match(r.motivo, /chaves de API/, `${m} ${v}`);
    }
  }
});

test('escopo: trocar a conta de IA pelo painel é fechado (qualquer escrita); a leitura passa', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const v of ['/p/ana/api/provedor', '/p/ana/api/provedor/', '/p/ana/API/Provedor', '/p/ana/api/provedor/login', '/p/ana/api/provedor/login/codigo']) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
      assert.match(r.motivo, /página Conectar conta/, `${m} ${v}`);
    }
  }
  assert.equal(avalia(COLAB, 'GET', '/p/ana/api/provedor').ok, false, 'a leitura traz o link e o código do login');
});

test('escopo: login da conta de IA do agente dele chega ao handler (que decide); o do painel (/p/.../api/provedor*) continua fechado', () => {
  for (const [m, v] of [['GET', '/api/v1/agents/ana/login'], ['POST', '/api/v1/agents/ana/login'], ['DELETE', '/api/v1/agents/ana/login'], ['POST', '/api/v1/agents/ana/login/codigo'], ['POST', '/api/v1/agents/ana/login/oi']]) {
    assert.deepEqual(avalia(COLAB, m, v), { ok: true }, `${m} ${v}`);
  }
  // de outro agente, nunca
  for (const v of ['/api/v1/agents/bob/login', '/api/v1/agents/bob/login/codigo', '/api/v1/agents/admin/login', '/api/v1/agents/ANA/login', '/api/v1/agents/An%61/login/oi']) {
    for (const m of ['GET', 'POST', 'DELETE']) assert.equal(avalia(COLAB, m, v).ok, false, `${m} ${v}`);
  }
  // com a senha temporária pendente, nada disso
  assert.equal(avalia(COLAB_TEMP, 'POST', '/api/v1/agents/ana/login').ok, false);
  // o painel do agente continua sem a conta de IA, em qualquer método e forma
  for (const m of ['GET', 'POST', 'DELETE', 'PUT']) {
    for (const v of ['/p/ana/api/provedor', '/p/ana/api/provedor/login', '/p/ana/api/provedor/login/codigo', '/p/ana/API/Provedor/Login/', '/p/ana/api/provedor/qualquer']) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
    }
  }
});

test('escopo: o colaborador só grava no painel o que está na lista de permissão; o resto é permanente e fechado com 403', () => {
  const fechadas = [
    ['PUT', '/p/ana/api/memoria/arquivo'], ['POST', '/p/ana/api/memoria/arquivo'], ['PUT', '/p/ana/api/arquivos'], ['DELETE', '/p/ana/api/arquivos'], ['POST', '/p/ana/api/arquivos/upload'],
    ['POST', '/p/ana/api/arquivos/enviar'], ['POST', '/p/ana/api/saude/reiniciar'], ['POST', '/p/ana/api/costs/analyze'], ['POST', '/p/ana/api/apps/x/conteudos/y/compartilhar'],
    ['PATCH', '/p/ana/api/sessoes/abc'], ['DELETE', '/p/ana/api/sessoes/abc'], ['POST', '/p/ana/api/skills'], ['PUT', '/p/ana/api/rotinas'], ['POST', '/p/ana/api/rotinas'],
    ['PUT', '/p/ana/api/claude-md'], ['POST', '/p/ana/api/qualquer-rota-nova'], ['POST', '/p/ana/'], ['PUT', '/p/ana/api/MEMORIA/arquivo/'],
  ];
  for (const [m, v] of fechadas) {
    const r = avalia(COLAB, m, v);
    assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
    assert.match(r.motivo, /(muda o agente de forma permanente|Mandar mensagem|só do dono)/, `${m} ${v}`);
  }
  for (const [m, v] of [['POST', '/p/ana/api/chat/transcrever'], ['POST', '/p/ana/api/sessoes/abc/arquivar'], ['POST', '/p/ana/api/sessoes/abc/desarquivar'], ['POST', '/p/ana/api/sessoes/abc/renomear'], ['POST', '/p/ana/api/sessoes/abc/favorito'], ['GET', '/p/ana/api/memoria/arquivo'], ['GET', '/p/ana/api/arquivos']]) {
    assert.equal(avalia(COLAB, m, v).ok, true, `${m} ${v}`);
  }
});

test('escopo: o painel não manda mensagem, decisão nem instrução como se fosse o dono (cada rota, todas as formas)', () => {
  const fechadas = [
    ['POST', '/p/ana/api/chat/mensagem'], ['POST', '/p/ana/api/chat/parar'], ['POST', '/p/ana/api/chat/reativar'],
    ['POST', '/p/ana/api/socorro/mensagem'], ['POST', '/p/ana/api/socorro/encerrar'],
    ['POST', '/p/ana/api/sessoes'], ['POST', '/p/ana/api/sessoes/'],
    ['POST', '/p/ana/api/sessoes/abc/recado'], ['POST', '/p/ana/api/sessoes/abc/decidir'], ['POST', '/p/ana/api/sessoes/abc/tecla'],
    ['POST', '/p/ana/api/sessoes/abc/retomar'], ['POST', '/p/ana/api/sessoes/abc/handoff'], ['POST', '/p/ana/api/sessoes/abc/anexo'], ['POST', '/p/ana/api/sessoes/abc/apagar'],
  ];
  for (const [m, p] of fechadas) {
    for (const v of [p, p.replace('/api/', '/API/').toUpperCase().replace('/P/ANA', '/p/ana'), `${p.replace(/\/$/, '')}/`]) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.equal(r.status, 403, `${m} ${v}`);
      assert.match(r.motivo, /só do dono/, `${m} ${v}`);
    }
  }
  for (const v of ['/p/ana/api/sessoes%2fabc/recado', '/p/ana/api/sessoes/abc/./recado', '/p/ana/api/sessoes//abc/decidir', '/p/ana/api/sessoes/abc/dec%69dir']) {
    assert.equal(avaliar(COLAB, 'POST', new URL(v, 'http://local').pathname, v).ok, false, v);
  }
  // a leitura e a transcrição de áudio seguem abertas
  for (const [m, p] of [['GET', '/p/ana/api/chat/mensagens'], ['GET', '/p/ana/api/socorro/estado'], ['GET', '/p/ana/api/sessoes/abc/conversa'], ['POST', '/p/ana/api/chat/transcrever']]) assert.equal(avalia(COLAB, m, p).ok, true, `${m} ${p}`);
});

test('escopo: credencial de canal (token de bot) e a Tela são fechadas', () => {
  for (const m of ['POST', 'PUT', 'DELETE']) {
    for (const v of ['/p/ana/api/canais', '/p/ana/api/canais/telegram', '/p/ana/api/telegram/token', '/p/ana/api/whatsapp', '/p/ana/api/Canal/']) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.match(r.motivo, /canais/, `${m} ${v}`);
    }
  }
  for (const m of ['PUT', 'POST', 'GET', 'DELETE']) {
    for (const v of ['/p/ana/api/tela/senha', '/p/ana/api/tela/senha/', '/p/ana/API/TELA/SENHA']) {
      const r = avalia(COLAB, m, v);
      assert.equal(r.ok, false, `${m} ${v}`); assert.match(r.motivo, /A Tela do agente/, `${m} ${v}`);
    }
  }
  assert.equal(avalia(COLAB, 'GET', '/p/ana/api/tela').ok, false);
});

test('escopo: cada forma de desvio do caminho cru é negada no painel e na API', () => {
  const desvios = [
    '/p/ana/api%2fcofre', '/p/ana/api%2Fcofre', '/p/ana%2fapi/cofre', '/p/ana/api/%63ofre', '/p/ana/api/c%6ffre', '/p/ana/%2e%2e/api/cofre',
    '/p/ana/%2E/api/cofre', '/p/ana/api%5ccofre', '/p/ana/api\\cofre', '/p/ana//api/cofre', '/p/ana/api//cofre', '/p/ana/./api/cofre',
    '/p/ana/x/../api/cofre', '/p/ana/api/cofre/..', '/p/ana/api/cofre/.', '/p/ana/api/%252e%252e/cofre', '/p/ana/api/cofre%00', '/p/ana/api/c%',
    '/p/ana/api/prov%65dor', '/p/ana/api/tela/s%65nha', '/p/ana/%2e%2e/%2e%2e/bob/',
  ];
  for (const bruto of desvios) {
    // o pathname que o server.js vê já vem normalizado pela URL; o escopo olha o caminho cru, que é o que o proxy repassa
    let normalizado;
    try { normalizado = new URL(bruto, 'http://local').pathname; } catch (_) { normalizado = bruto; }
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = avaliar(COLAB, m, normalizado, bruto);
      assert.equal(r.ok, false, `${m} ${bruto} (normalizado ${normalizado}) devia ser negado`);
      assert.equal(r.status, 403, `${m} ${bruto}`);
    }
  }
  const api = ['/api/v1/agents/ana/..%2f..%2fcolaboradores', '/api/v1/agents/ana/x/..%2F..%2Fcofre', '/api/v1/agents/ana//send', '/api/v1/agents/ana/./send', '/api/v1/agents/ana%2fsend', '/api/v1/agents/ana/%2e%2e/bob/send', '/api/v1/agents/ana/%252e'];
  for (const bruto of api) {
    let normalizado;
    try { normalizado = new URL(bruto, 'http://local').pathname; } catch (_) { normalizado = bruto; }
    assert.equal(avaliar(COLAB, 'POST', normalizado, bruto).ok, false, `POST ${bruto} (normalizado ${normalizado})`);
  }
});

test('escopo: rotas da caixa inteira, do dono e sem slug são negadas (rota nova sem slug nasce fechada)', () => {
  const nega = [
    ['GET', '/api/v1/colaboradores'], ['POST', '/api/v1/colaboradores'], ['DELETE', '/api/v1/colaboradores/abc'], ['GET', '/api/v1/colaboradores/docs.md'],
    ['GET', '/api/v1/cofre'], ['POST', '/api/v1/cofre'], ['GET', '/api/v1/onboarding'], ['POST', '/api/v1/onboarding'], ['GET', '/api/v1/estados'],
    ['GET', '/api/v1/uso'], ['GET', '/api/v1/push/chave'], ['POST', '/api/v1/push/preferencias'], ['GET', '/api/v1/avisos'], ['GET', '/api/v1/lembretes'], ['POST', '/api/v1/lembretes'],
    ['GET', '/api/v1/foco/ana'], ['GET', '/api/v1/tarefas'], ['POST', '/api/v1/tarefas'], ['GET', '/api/v1/pedidos'], ['POST', '/api/v1/pedidos/1/abrir'], ['GET', '/api/v1/atualizacao'], ['GET', '/api/v1/seguranca'], ['POST', '/api/v1/sigilo'], ['GET', '/api/v1/sigilo/estado'],
    ['GET', '/api/v1/rota-nova-do-futuro'], ['GET', '/api/v1/media/zzzz'],
    ['GET', '/api/v1/agents/ana/comandos'], ['POST', '/api/v1/agents/ana/comando'], ['GET', '/api/v1/agents/ana/comandos/'],
    ['POST', '/api/v1/agents'], ['DELETE', '/api/v1/agents/ana'], ['PUT', '/api/v1/agents/ana'],
    ['GET', '/api/v1/push/docs.md/..'], ['POST', '/mesa'], ['POST', '/colaboradores'], ['DELETE', '/a/ana'],
    ['GET', '/api/saude'], ['GET', '/api/qualquer'],
  ];
  for (const [m, p] of nega) {
    const r = avalia(COLAB, m, p);
    assert.equal(r.ok, false, `${m} ${p}`);
    assert.ok([403, 405].includes(r.status), `${m} ${p}: ${r.status}`);
  }
});

test('escopo: comando de barra continua bloqueado mesmo com o resto do agente aberto', () => {
  for (const [m, p] of [['POST', '/api/v1/agents/ana/comando'], ['GET', '/api/v1/agents/ana/comandos']]) {
    const r = avalia(COLAB, m, p);
    assert.equal(r.status, 403); assert.match(r.motivo, /Comandos de barra/);
  }
});

test('escopo: estáticos só os não-HTML, sem sair da pasta', () => {
  assert.equal(avaliar(COLAB, 'GET', '/seguranca.js').ok, true);
  for (const p of ['/seguranca.html', '/../server.js', '/x/../conversa.js', '/dados.json', '/segredo.txt', '/.env']) assert.equal(avaliar(COLAB, 'GET', p).ok, false, p);
});

test('escopo: com a senha temporária pendente só passa o caminho da troca', () => {
  const ok = [['GET', '/trocar-senha'], ['GET', '/api/v1/eu'], ['POST', '/api/v1/eu/senha'], ['GET', '/trocar-senha.js'], ['GET', '/sem-zoom.css']];
  for (const [m, p] of ok) assert.equal(avaliar(COLAB_TEMP, m, p).ok, true, `${m} ${p}`);
  for (const [m, p] of [['GET', '/api/v1/agents'], ['POST', '/api/v1/agents/ana/send'], ['GET', '/api/v1/agents/ana/stream'], ['GET', '/api/v1/media/0123456789abcdef']]) {
    const r = avaliar(COLAB_TEMP, m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.motivo, 'Troque a senha temporária antes de continuar.');
    assert.deepEqual(r.extra, { trocar_senha: true });
  }
  for (const p of ['/', '/a/ana', '/conectar', '/mesa']) {
    const r = avaliar(COLAB_TEMP, 'GET', p);
    assert.equal(r.status, 302, p); assert.equal(r.redirecionar, '/trocar-senha', p);
  }
  assert.equal(avaliar(COLAB_TEMP, 'GET', '/p/ana/').status, 302);
  assert.equal(websocketLiberado(COLAB_TEMP, '/p/ana/tela/websockify', '/p/ana/tela/websockify').ok, false);
});

test('escopo: nenhum WebSocket para o colaborador; dono e caixa seguem a regra de sempre', () => {
  const ws = (caminho, bruto) => websocketLiberado(COLAB, caminho, bruto || caminho);
  // o único WebSocket do painel é o da Tela, que é só do dono
  assert.equal(ws('/p/ana/tela/websockify').ok, false);
  assert.equal(ws('/p/ana/tela/websockify', '/p/ana/tela/websockify?token=x').ok, false);
  for (const p of ['/p/bob/tela/websockify', '/p/admin/tela/websockify', '/p/ANA/tela/websockify', '/a/ana', '/api/v1/agents/ana/stream', '/', '/p', '/p/']) {
    const r = ws(p); assert.equal(r.ok, false, p); assert.equal(r.status, 403, p);
  }
  for (const bruto of ['/p/ana/%2e%2e/bob/tela/websockify', '/p/ana/../bob/tela/websockify', '/p/ana//tela/websockify', '/p/ana/tela%2fwebsockify', '/p/ana/api/cofre']) {
    assert.equal(ws(new URL(bruto, 'http://local').pathname, bruto).ok, false, bruto);
  }
  assert.equal(websocketLiberado(DONO, '/p/bob/x', '/p/bob/x').ok, true);
  assert.equal(websocketLiberado(CAIXA, '/p/ana/x', '/p/ana/x').ok, true);
  assert.equal(websocketLiberado(null, '/p/ana/x', '/p/ana/x').status, 401);
});

test('escopo: os logs dos agentes são fechados para o colaborador (rotas, documentação e página)', () => {
  const COLAB_LOGS = { usuario: 'maria@x.com', papel: 'colaborador', agente: 'ana' };
  for (const p of ['/api/v1/logs/agentes', '/api/v1/logs/agentes/ana/eventos', '/api/v1/logs/agentes/ana/sessoes', '/api/v1/logs/docs.md', '/api/v1/logs']) {
    const r = avalia(COLAB_LOGS, 'GET', p);
    assert.equal(r.ok, false, p);
    assert.equal(r.status, 403, p);
  }
  const pag = avalia(COLAB_LOGS, 'GET', '/logs');
  assert.equal(pag.ok, false);
  assert.equal(pag.status, 302);
  assert.equal(pag.redirecionar, '/a/ana');
  assert.equal(avalia(COLAB_LOGS, 'GET', '/p/ana/api/v1/logs/agentes').ok, true, 'o painel da ana é dela; a trava de /p/.../logs fica no server.js');
});
