// grupos.test.mjs - Envio para grupo pela Z-API: ID, lista de liberados, listagem paginada e as mesmas travas.
// Fetch, relogio e espera sao falsos; nenhum teste fala com a rede nem dorme de verdade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { criarAdaptadorZapi } from '../lib/adaptador-zapi.mjs';
import { criarEnvioSeguro } from '../lib/envio-seguro.mjs';
import { idDeGrupoValido, lerGruposLiberados, limparNome } from '../lib/grupos.mjs';
import { executar } from '../enviar-zapi.mjs';

const entrada = (txt) => Readable.from([Buffer.from(txt)]);
const G1 = '120363000000000001-group';
const G2 = '120363000000000002-group';
const CHAVES = { instancia: 'INST123', token: 'TOK456', clientToken: 'CLI789' };
const ENV = { ZAPI_INSTANCE: 'INST123', ZAPI_TOKEN: 'TOK456', ZAPI_CLIENT_TOKEN: 'CLI789' };

function casa({ liberados = [G1] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grupos-')));
  const pasta = path.join(home, '.dgclaw', 'whatsapp');
  fs.mkdirSync(pasta, { recursive: true });
  const arq = path.join(pasta, 'grupos-liberados.json');
  if (liberados) {
    fs.writeFileSync(arq, JSON.stringify({ versao: 1, grupos: liberados.map((id) => ({ id, nome: 'Grupo', liberado_em: '2026-11-19T10:00:00Z' })) }));
  }
  return { home, arq, limpar: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** Ambiente do filho sem as variaveis que o executor de testes do node injeta (o filho nao e um teste). */
function envLimpo() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('NODE_TEST')) delete e[k];
  return e;
}

function fetchGravando() {
  const chamadas = [];
  const fetchImpl = async (url, init) => {
    chamadas.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ messageId: 'M' + chamadas.length }) };
  };
  return { chamadas, fetchImpl };
}

test('ID de grupo: so digitos seguidos de -group', () => {
  assert.equal(idDeGrupoValido(G1), true);
  for (const ruim of ['', 'abc', '120363-group', '120363000000000001', '+5511911111111', '120363000000000001-group\n', '120363000000000001-groups', '1203630000000000010000000000000000-group', '12a363000000000001-group', null, 5]) {
    assert.equal(idDeGrupoValido(ruim), false, String(ruim));
  }
});

test('enviar --grupo manda o ID intacto no phone e nao mexe no envio para numero', async () => {
  const c = casa();
  const g = fetchGravando();
  const opc = { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {} };
  let r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc, stdin: entrada('aviso para o grupo') });
  assert.equal(r.codigoSaida, 0);
  assert.equal(r.resposta.grupo, G1);
  assert.equal(r.resposta.para, undefined);
  assert.deepEqual(JSON.parse(g.chamadas[0].init.body), { phone: G1, message: 'aviso para o grupo' });
  assert.equal(g.chamadas[0].url, 'https://api.z-api.io/instances/INST123/token/TOK456/send-text');
  r = await executar(['enviar', '--para', '+55 11 91111-1111', '--texto', 'oi, tudo bem por ai?'], opc);
  assert.equal(r.codigoSaida, 0);
  assert.equal(r.resposta.para, '+5511911111111');
  assert.deepEqual(JSON.parse(g.chamadas[1].init.body), { phone: '5511911111111', message: 'oi, tudo bem por ai?' });
  c.limpar();
});

test('o adaptador continua aceitando numero em texto simples', async () => {
  const g = fetchGravando();
  const z = criarAdaptadorZapi({ ...CHAVES, fetchImpl: g.fetchImpl });
  await z.enviarTexto('+55 11 91111-1111', 'oi');
  await z.enviarTexto({ tipo: 'numero', valor: '+55 11 92222-2222' }, 'oi');
  assert.equal(JSON.parse(g.chamadas[0].init.body).phone, '5511911111111');
  assert.equal(JSON.parse(g.chamadas[1].init.body).phone, '5511922222222');
});

test('--grupo: invalido, junto com --para e sem valor saem com codigo 2', async () => {
  const c = casa();
  const g = fetchGravando();
  const opc = { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {} };
  let r = await executar(['enviar', '--grupo', '5511911111111', '--texto-stdin'], { ...opc, stdin: entrada('x') });
  assert.equal(r.codigoSaida, 2);
  assert.equal(r.resposta.codigo, 'PEDIDO_INVALIDO');
  assert.match(r.resposta.erro, /-group/);
  r = await executar(['enviar', '--grupo', G1, '--para', '+5511911111111', '--texto-stdin'], { ...opc, stdin: entrada('x') });
  assert.equal(r.codigoSaida, 2);
  assert.match(r.resposta.erro, /nunca os dois/);
  r = await executar(['enviar', '--grupo'], opc);
  assert.equal(r.codigoSaida, 2);
  assert.equal(g.chamadas.length, 0);
  c.limpar();
});

test('grupo nao liberado, lista ausente ou ilegivel: recusa sem chamar a Z-API', async () => {
  const g = fetchGravando();
  const c1 = casa({ liberados: [G2] });
  const opc = (c) => ({ uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {} });
  let r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc(c1), stdin: entrada('aviso para o grupo') });
  assert.equal(r.codigoSaida, 1);
  assert.equal(r.resposta.codigo, 'GRUPO_NAO_LIBERADO');
  assert.match(r.resposta.erro, /grupo liberar 120363000000000001-group/);
  const c2 = casa({ liberados: null }); // arquivo ausente: nenhum grupo liberado
  r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc(c2), stdin: entrada('aviso para o grupo') });
  assert.equal(r.resposta.codigo, 'GRUPO_NAO_LIBERADO');
  const c3 = casa();
  for (const lixo of ['{"grupos":', '{"versao":1}', '{"versao":1,"grupos":[{"id":"abc"}]}']) {
    fs.writeFileSync(c3.arq, lixo);
    r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc(c3), stdin: entrada('aviso para o grupo') });
    assert.equal(r.codigoSaida, 1);
    assert.equal(r.resposta.codigo, 'LISTA_DE_GRUPOS_ILEGIVEL', lixo);
    assert.match(r.resposta.erro, /nenhum grupo esta liberado/);
  }
  assert.equal(g.chamadas.length, 0);
  assert.deepEqual(lerGruposLiberados(c2.arq), { grupos: [] });
  for (const c of [c1, c2, c3]) c.limpar();
});

test('grupo removido durante a espera do ritmo nao sai', async () => {
  const c = casa();
  const g = fetchGravando();
  const opc = { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => { fs.writeFileSync(c.arq, JSON.stringify({ versao: 1, grupos: [] })); } };
  let r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'primeira mensagem para a Ana'], opc);
  assert.equal(r.resposta.ok, true);
  r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc, aleatorio: () => 0, stdin: entrada('segunda mensagem, agora para o grupo') });
  assert.equal(r.resposta.codigo, 'GRUPO_NAO_LIBERADO');
  assert.equal(g.chamadas.length, 1);
  c.limpar();
});

test('travas: PARADO vem antes e a falha de envio para grupo trava tudo', async () => {
  const c = casa();
  let falhar = false;
  const fetchImpl = async () => (falhar
    ? { ok: false, status: 500, json: async () => ({ error: 'caiu' }) }
    : { ok: true, status: 200, json: async () => ({ messageId: 'M' + Math.random() }) });
  const opc = { uid: 1000, env: ENV, home: c.home, fetchImpl, dormir: async () => {} };
  assert.equal((await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc, stdin: entrada('primeiro aviso para o grupo') })).codigoSaida, 0);
  falhar = true;
  let r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc, stdin: entrada('segundo aviso para o grupo') });
  assert.equal(r.resposta.codigo, 'FALHA_ENVIO');
  falhar = false;
  r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opc, stdin: entrada('terceiro aviso para o grupo') });
  assert.equal(r.resposta.codigo, 'PARADO');
  r = await executar(['enviar', '--grupo', G2, '--texto-stdin'], { ...opc, stdin: entrada('aviso para grupo nao liberado') });
  assert.equal(r.resposta.codigo, 'PARADO');
  c.limpar();
});

test('envio-seguro: um grupo conta como UM destinatario, nao colide com numero e o texto repetido vale', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grupos-')));
  const relogio = { t: Date.parse('2026-11-19T15:00:00Z') };
  const esperas = [];
  const envio = criarEnvioSeguro({
    dir: path.join(home, 'envio'), arqConfig: path.join(home, 'envio.json'),
    agora: () => new Date(relogio.t), dormir: async (ms) => { esperas.push(ms); relogio.t += ms; }, aleatorio: () => 0,
  });
  const mandar = (para, texto) => envio.enviar({ para, texto, executar: async () => ({ id: 'X' }) });
  // Varias mensagens para o MESMO grupo: conversa, sem disparo e sem espera.
  for (let i = 0; i < 5; i++) {
    const r = await mandar(`grupo:${G1}`, `aviso numero ${i} para o grupo da turma`);
    assert.equal(r.ok, true);
    assert.equal(r.disparo, false);
  }
  assert.deepEqual(esperas, []);
  // Um numero logo depois: sao 2 destinatarios na janela, entao e disparo e espera o intervalo.
  const r2 = await mandar('+5511911111111', 'oi, tudo bem por ai? so conferindo');
  assert.equal(r2.disparo, true);
  assert.equal(esperas.length, 1);
  // O mesmo texto do grupo para um numero e recusado; para o proprio grupo, nao.
  assert.equal((await mandar('+5511922222222', 'aviso numero 0 para o grupo da turma')).codigo, 'TEXTO_REPETIDO');
  assert.equal((await mandar(`grupo:${G1}`, 'aviso numero 0 para o grupo da turma')).ok, true);
  // ID de grupo com os mesmos digitos de um telefone nao colide com o telefone.
  const envio2 = criarEnvioSeguro({ dir: path.join(home, 'envio2'), arqConfig: null, agora: () => new Date(relogio.t), dormir: async () => {}, aleatorio: () => 0 });
  const m2 = (para, texto) => envio2.enviar({ para, texto, executar: async () => ({ id: 'X' }) });
  await m2('+5511911111111', 'mensagem para a Ana sobre o curso');
  const r3 = await m2('grupo:5511911111111-group', 'mensagem para o grupo sobre o curso');
  assert.equal(r3.disparo, true); // 2 destinatarios diferentes
  fs.rmSync(home, { recursive: true, force: true });
});

test('envio-seguro: o teto por dia conta o grupo como uma mensagem', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grupos-')));
  const relogio = { t: Date.parse('2026-11-19T15:00:00Z') };
  fs.writeFileSync(path.join(home, 'envio.json'), JSON.stringify({ teto_dia: 3, intervalo_min_s: 3, intervalo_max_s: 3, teto_rodada: 100 }));
  const envio = criarEnvioSeguro({
    dir: path.join(home, 'envio'), arqConfig: path.join(home, 'envio.json'),
    agora: () => new Date(relogio.t), dormir: async (ms) => { relogio.t += ms; }, aleatorio: () => 0,
  });
  const mandar = (para, texto) => envio.enviar({ para, texto, executar: async () => ({ id: 'X' }) });
  assert.equal((await mandar('+5511911111111', 'mensagem um para a pessoa')).ok, true);
  assert.equal((await mandar(`grupo:${G1}`, 'mensagem dois para o grupo')).ok, true);
  assert.equal((await mandar(`grupo:${G1}`, 'mensagem tres para o grupo')).ok, true);
  assert.equal((await mandar(`grupo:${G1}`, 'mensagem quatro para o grupo')).codigo, 'TETO_DIA');
  fs.rmSync(home, { recursive: true, force: true });
});

test('grupos: pagina ate a pagina curta, tira repetido e marca o que o dono liberou', async () => {
  const c = casa({ liberados: [G2] });
  const urls = [];
  const todos = Array.from({ length: 120 }, (_, i) => ({ isGroup: true, name: `Grupo ${i}`, phone: `1203630000000${String(10000 + i)}-group` }));
  const fetchImpl = async (url, init) => {
    urls.push({ url, init });
    const m = /page=(\d+)&pageSize=(\d+)/.exec(url);
    const p = Number(m[1]); const t = Number(m[2]);
    return { ok: true, status: 200, json: async () => todos.slice((p - 1) * t, p * t) };
  };
  todos[1] = { isGroup: true, name: 'Turma\n\x07da   tarde‮ ' + 'x'.repeat(200), phone: G2 };
  const r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl });
  assert.equal(r.codigoSaida, 0);
  assert.equal(r.resposta.ok, true);
  assert.equal(r.resposta.grupos.length, 120);
  assert.equal(urls.length, 3);
  assert.equal(urls[0].init.method, 'GET');
  assert.equal(urls[0].init.headers['Client-Token'], 'CLI789');
  assert.match(urls[0].url, /\/token\/TOK456\/groups\?page=1&pageSize=50$/);
  const turma = r.resposta.grupos.find((g) => g.id === G2);
  assert.equal(turma.liberado, true);
  assert.ok(turma.nome.length <= 100);
  assert.match(turma.nome, /^Turma da tarde/);
  assert.doesNotMatch(turma.nome, /[\u0000-\u001f‮]/);
  assert.equal(r.resposta.grupos.filter((g) => g.liberado).length, 1);
  assert.equal(r.resposta.aviso, undefined);
  c.limpar();
});

test('grupos: a Z-API que ignora a pagina nao prende o loop, e o teto de paginas avisa', async () => {
  const c = casa({ liberados: null });
  const tudo = Array.from({ length: 60 }, (_, i) => ({ name: `G${i}`, phone: `1203630000000${String(20000 + i)}-group` }));
  let n = 0;
  let r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => { n++; return { ok: true, status: 200, json: async () => tudo }; } });
  assert.equal(r.resposta.grupos.length, 60);
  assert.equal(n, 2);
  assert.match(r.resposta.aviso, /cortada/);
  assert.ok(r.resposta.grupos.every((g) => g.liberado === false));
  n = 0;
  const infinito = async (url) => {
    n++;
    const p = Number(/page=(\d+)/.exec(url)[1]);
    return { ok: true, status: 200, json: async () => Array.from({ length: 50 }, (_, i) => ({ name: 'g', phone: `${p}00000000000${String(i).padStart(5, '0')}-group` })) };
  };
  r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: infinito });
  assert.equal(n, 20);
  assert.equal(r.resposta.grupos.length, 1000);
  assert.match(r.resposta.aviso, /cortada/);
  c.limpar();
});

test('grupos: erro, resposta estranha e lista de liberados ilegivel; a credencial nunca aparece', async () => {
  const c = casa();
  let r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad TOK456 CLI789 INST123' }) }) });
  assert.equal(r.codigoSaida, 1);
  assert.equal(r.resposta.codigo, 'FALHA_LISTA');
  assert.match(r.resposta.erro, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(r.resposta), /TOK456|CLI789|INST123/);
  r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => { throw new Error('boom em https://api.z-api.io/instances/INST123/token/TOK456/groups'); } });
  assert.equal(r.resposta.codigo, 'FALHA_LISTA');
  assert.doesNotMatch(JSON.stringify(r.resposta), /TOK456|INST123/);
  r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) }) });
  assert.match(r.resposta.erro, /formato inesperado/);
  r = await executar(['grupos'], { uid: 1000, env: {}, home: c.home });
  assert.equal(r.resposta.codigo, 'SEM_CHAVE');
  fs.writeFileSync(c.arq, '{lixo');
  r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ name: 'A', phone: G1 }] }) });
  assert.equal(r.codigoSaida, 0);
  assert.equal(r.resposta.grupos[0].liberado, false);
  assert.match(r.resposta.aviso_liberados, /ilegivel/);
  c.limpar();
});

test('--grupo repetido e recusado com codigo 2, sem ler a lista nem chamar a Z-API', async () => {
  const c = casa();
  const g = fetchGravando();
  const opc = { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {} };
  const r = await executar(['enviar', '--grupo', G1, '--grupo', G2, '--texto', 'x'], opc);
  assert.equal(r.codigoSaida, 2);
  assert.equal(r.resposta.codigo, 'USO_INVALIDO');
  assert.match(r.resposta.erro, /mais de uma vez/);
  assert.equal(g.chamadas.length, 0);
  c.limpar();
});

test('limparNome tira marcas de link Markdown e quebra URL', () => {
  const n = limparNome('[Confirmar grupo](https://x.example) <https://y.example> `z`');
  assert.equal(n, 'Confirmar grupohttps:/ /x.example https:/ /y.example z');
  assert.doesNotMatch(n, /[\[\]()<>`]|:\/\//);
});

test('limparNome tira controle e quebra de linha e corta em 100', () => {
  assert.equal(limparNome('a\r\nb\tc\u0000d'), 'a b c d');
  assert.equal(limparNome('x'.repeat(300)).length, 100);
  assert.equal(limparNome(undefined), '');
});

test('lista ilegivel: o erro nao copia JSON.parse nem o valor bruto do arquivo', () => {
  const c = casa({ liberados: null });
  const segredo = 'sk-' + 'SEGREDO123456';
  fs.writeFileSync(c.arq, `{"grupos": [{"id": "${segredo}"} ${segredo}`);
  let r = lerGruposLiberados(c.arq);
  assert.match(r.erro, /ilegivel/);
  assert.doesNotMatch(r.erro, /SEGREDO123456/);
  fs.writeFileSync(c.arq, JSON.stringify({ versao: 1, grupos: [{ id: G1 }, { id: segredo }] }));
  r = lerGruposLiberados(c.arq);
  assert.match(r.erro, /entrada 2/);
  assert.doesNotMatch(r.erro, /SEGREDO123456/);
  c.limpar();
});

test('lista que e link simbolico e recusada, mesmo apontando para uma lista valida', async () => {
  const c = casa({ liberados: null });
  const real = path.join(c.home, 'real.json');
  fs.writeFileSync(real, JSON.stringify({ versao: 1, grupos: [{ id: G1, nome: 'A', liberado_em: 'x' }] }));
  fs.symlinkSync(real, c.arq);
  const r = lerGruposLiberados(c.arq);
  assert.match(r.erro, /link simbolico/);
  const g = fetchGravando();
  const e = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {}, stdin: entrada('oi pessoal') });
  assert.equal(e.resposta.codigo, 'LISTA_DE_GRUPOS_ILEGIVEL');
  assert.equal(g.chamadas.length, 0);
  c.limpar();
});

test('lista com versao 2 ou sem versao e recusada antes de chamar a Z-API', async () => {
  for (const corpo of [{ versao: 2, grupos: [{ id: G1 }] }, { grupos: [{ id: G1 }] }]) {
    const c = casa({ liberados: null });
    fs.writeFileSync(c.arq, JSON.stringify(corpo));
    const g = fetchGravando();
    const e = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {}, stdin: entrada('oi pessoal') });
    assert.equal(e.resposta.codigo, 'LISTA_DE_GRUPOS_ILEGIVEL');
    assert.equal(g.chamadas.length, 0);
    c.limpar();
  }
});

test('lista que e FIFO e recusada sem travar', () => {
  const c = casa({ liberados: null });
  execFileSync('mkfifo', [c.arq]);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { lerGruposLiberados } from ${JSON.stringify(new URL('../lib/grupos.mjs', import.meta.url).href)};
     const r = lerGruposLiberados(process.argv[1]); console.log(JSON.stringify(r));`, c.arq], { timeout: 10000, encoding: 'utf8' });
  assert.equal(r.error, undefined, 'o leitor travou no FIFO');
  assert.match(JSON.parse(r.stdout).erro, /nao e um arquivo comum/);
  c.limpar();
});

test('grupos: pagina inteira no formato antigo nao esconde a pagina seguinte, e conta os omitidos', async () => {
  const c = casa({ liberados: null });
  const legados = Array.from({ length: 50 }, (_, i) => ({ name: `Velho ${i}`, phone: `5511999990${String(100 + i)}-1600000000` }));
  const fetchImpl = async (url) => {
    const p = Number(/page=(\d+)/.exec(url)[1]);
    return { ok: true, status: 200, json: async () => (p === 1 ? legados : p === 2 ? [{ name: 'Novo', phone: G1 }] : []) };
  };
  const r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl });
  assert.deepEqual(r.resposta.grupos.map((g) => g.id), [G1]);
  assert.equal(r.resposta.omitidos, 50);
  assert.match(r.resposta.aviso_omitidos, /50 grupo/);
  c.limpar();
});

test('CLI de verdade com stdout em pipe: 1000 grupos saem inteiros e o JSON faz parse', async () => {
  const c = casa({ liberados: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-falsa-'));
  const todos = Array.from({ length: 1000 }, (_, i) => ({ name: `Grupo ${i} ` + 'n'.repeat(30), phone: `1203630000${String(100000 + i)}-group` }));
  const servidor = http.createServer((req, res) => {
    const p = Number(new URL(req.url, 'http://x').searchParams.get('page') || 1);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(todos.slice((p - 1) * 50, p * 50)));
  });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  // Preload que redireciona o fetch para o servidor local, como a Z-API simulada.
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, `const f = globalThis.fetch; globalThis.fetch = (u, i) => f(String(u).replace('https://api.z-api.io', 'http://127.0.0.1:${porta}'), i);\n`);
  // A CLI real usa o uid do sistema (aqui pode ser root, que o comando grupos recusa). Entao o teste roda um script
  // pequeno que importa executar() com uid 1000 e escreve pelo mesmo emitir() da CLI, sem process.exit.
  const cli = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'enviar-zapi.mjs')).href;
  const script = path.join(dir, 'cli-teste.mjs');
  fs.writeFileSync(script, `import { executar, emitir } from '${cli}';\nconst { codigoSaida, resposta } = await executar(['grupos'], { uid: 1000 });\nemitir(resposta, codigoSaida);\n`);
  // O node liga o stdout do filho a um socket, que tem folga; para ter um pipe de verdade (64 KB) e um leitor lento,
  // o script roda dentro de um "sh" que o liga a "sleep 0.3; cat". Quem sai antes de terminar de escrever perde o resto.
  const filho = spawn('sh', ['-c', '"$0" --import "$1" "$2" | { sleep 0.3; cat; }', process.execPath, preload, script], {
    env: { ...envLimpo(), ...ENV, HOME: c.home }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const partes = [];
  filho.stdout.on('data', (p) => partes.push(p));
  const codigo = await new Promise((ok) => filho.on('close', ok));
  servidor.close();
  servidor.closeAllConnections();
  const saida = Buffer.concat(partes).toString('utf8');
  assert.equal(codigo, 0);
  assert.ok(saida.length > 65536);
  assert.equal(JSON.parse(saida).grupos.length, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
  c.limpar();
});

test('grupos nao cria a pasta de envio', async () => {
  const c = casa({ liberados: null });
  const r = await executar(['grupos'], { uid: 1000, env: ENV, home: c.home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ name: 'A', phone: G1 }] }) });
  assert.equal(r.codigoSaida, 0);
  assert.equal(fs.existsSync(path.join(c.home, '.dgclaw', 'whatsapp', 'envio')), false);
  c.limpar();
});

test('grupos: recusa o Admin (DGCLAW_TIPO=admin ou uid 0) antes de tocar no estado e na Z-API', async () => {
  for (const opcoes of [{ uid: 1000, env: { ...ENV, DGCLAW_TIPO: 'admin' } }, { uid: 0, env: ENV }]) {
    const c = casa();
    let chamadas = 0;
    const fetchImpl = async () => { chamadas++; return { ok: true, status: 200, json: async () => [] }; };
    const r = await executar(['grupos'], { ...opcoes, home: c.home, fetchImpl });
    assert.equal(r.codigoSaida, 2);
    assert.equal(r.resposta.ok, false);
    assert.match(r.resposta.erro || r.resposta.mensagem || JSON.stringify(r.resposta), /agentes de trabalho/);
    assert.equal(chamadas, 0);
    assert.equal(fs.existsSync(path.join(c.home, '.dgclaw', 'whatsapp', 'envio')), false);
    c.limpar();
  }
});

test('enviar --grupo: recusa o Admin (DGCLAW_TIPO=admin ou uid 0) sem chamada de rede e sem criar estado', async () => {
  for (const opcoes of [{ uid: 1000, env: { ...ENV, DGCLAW_TIPO: 'admin' } }, { uid: 0, env: ENV }]) {
    const c = casa();
    const antes = fs.readdirSync(path.join(c.home, '.dgclaw', 'whatsapp')).sort();
    const { chamadas, fetchImpl } = fetchGravando();
    const r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], { ...opcoes, home: c.home, fetchImpl, stdin: entrada('oi') });
    assert.equal(r.codigoSaida, 2);
    assert.equal(r.resposta.ok, false);
    assert.match(JSON.stringify(r.resposta), /agentes de trabalho/);
    assert.equal(chamadas.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(c.home, '.dgclaw', 'whatsapp')).sort(), antes);
    assert.equal(fs.existsSync(path.join(c.home, '.dgclaw', 'whatsapp', 'envio')), false);
    c.limpar();
  }
});

test('--texto-stdin lendo um arquivo: uma linha FIM no meio nao corta o texto', async () => {
  const c = casa();
  const msg = path.join(c.home, 'msg.txt');
  const texto = 'Pessoal, aviso importante.\nFIM\necho isso nao e comando\nAte logo.\n';
  fs.writeFileSync(msg, texto);
  const { chamadas, fetchImpl } = fetchGravando();
  const r = await executar(['enviar', '--grupo', G1, '--texto-stdin'], {
    uid: 1000, env: ENV, home: c.home, fetchImpl, stdin: fs.createReadStream(msg), dormir: async () => {},
  });
  assert.equal(r.codigoSaida, 0, JSON.stringify(r.resposta));
  assert.equal(chamadas.length, 1);
  assert.equal(JSON.parse(chamadas[0].init.body).message, texto);
  c.limpar();
});

test('enviar --grupo com --texto e recusado com erro de uso, antes de tocar na rede ou criar estado', async () => {
  const c = casa();
  const g = fetchGravando();
  const r = await executar(['enviar', '--grupo', G1, '--texto', 'mensagem na linha de comando'], { uid: 1000, env: ENV, home: c.home, fetchImpl: g.fetchImpl, dormir: async () => {} });
  assert.equal(r.codigoSaida, 2);
  assert.equal(r.resposta.codigo, 'USO_INVALIDO');
  assert.match(r.resposta.erro, /--texto-stdin/);
  assert.equal(g.chamadas.length, 0);
  assert.equal(fs.existsSync(path.join(c.home, '.dgclaw', 'whatsapp', 'envio')), false);
  c.limpar();
});
