'use strict';
// Saída controlada (bloco H): regras de lista, proxy com destinos falsos (CONNECT e HTTP), cerca contra DNS que aponta
// para dentro, registro sem URL e a CLI de listas. Nada sai da máquina: o resolvedor é injetado e os destinos são
// servidores em 127.0.0.1 (liberados só neste teste, pela opção excecoesIp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const lista = require('../../saida/lista');
const { criarProxy } = require('../../saida/proxy');

const CLI = path.join(__dirname, '..', '..', 'saida', 'cli.js');
const BASE = path.join(__dirname, '..', '..', 'config', 'saida-base.json');

test('normalizarHost: minúsculas, ponto final, punycode e IPv6', () => {
  assert.equal(lista.normalizarHost('API.Exemplo.COM.'), 'api.exemplo.com');
  assert.equal(lista.normalizarHost('münchen.de'), 'xn--mnchen-3ya.de');
  assert.equal(lista.normalizarHost('[::1]'), '::1');
  assert.equal(lista.normalizarHost('1.2.3.4'), '1.2.3.4');
  for (const ruim of ['', 'a b.com', 'a/b.com', 'user@host.com', 'a..com', '*.com', 'x:80', null]) assert.equal(lista.normalizarHost(ruim), null, String(ruim));
});

test('validarEntrada: curinga só no começo e com dois níveis; URL e * no meio são recusados com o que fazer', () => {
  assert.deepEqual(lista.validarEntrada('*.Empresa.com.br'), { valor: '*.empresa.com.br' });
  assert.deepEqual(lista.validarEntrada(' api.exemplo.com '), { valor: 'api.exemplo.com' });
  for (const ruim of ['*.com', 'api.*.com', 'https://x.com/a', 'a*.com', '', '*.1.2.3.4']) {
    const r = lista.validarEntrada(ruim);
    assert.ok(r.erro && r.como, `deveria recusar "${ruim}"`);
  }
});

test('casa: o curinga cobre subdomínios, nunca o próprio domínio nem um nome que só termina igual', () => {
  const l = ['*.empresa.com.br', 'api.anthropic.com'];
  assert.equal(lista.casa(l, 'x.empresa.com.br'), true);
  assert.equal(lista.casa(l, 'a.b.empresa.com.br'), true);
  assert.equal(lista.casa(l, 'empresa.com.br'), false);
  assert.equal(lista.casa(l, 'malempresa.com.br'), false);
  assert.equal(lista.casa(l, 'api.anthropic.com'), true);
  assert.equal(lista.casa(l, 'x.api.anthropic.com'), false);
});

test('ipBloqueado: redes internas, metadados da nuvem e IPv6 disfarçado', () => {
  for (const ip of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', 'isto-nao-e-ip']) {
    assert.equal(lista.ipBloqueado(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '160.79.104.10', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(lista.ipBloqueado(ip), false, ip);
});

// --- proxy ----------------------------------------------------------------------------------------------

function escutar(server) {
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
}

async function montar(opcoes = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-saida-'));
  const etc = path.join(tmp, 'etc');
  const logDir = path.join(tmp, 'log');
  fs.mkdirSync(path.join(etc, 'saida'), { recursive: true });
  const gravar = (nome, obj) => fs.writeFileSync(path.join(etc, 'saida', nome), JSON.stringify(obj));
  gravar('geral.json', { versao: 1, modo: opcoes.modo || 'bloqueio', retencao_dias: opcoes.retencao || 0, agentes: { ana: { n: 11, provedor: 'claude' }, bia: { n: 12, provedor: 'codex' } } });
  gravar('ana.json', { permitidos: opcoes.permitidos || [] });

  const eco = net.createServer((s) => { s.on('error', () => {}); s.pipe(s); });
  const portaEco = await escutar(eco);
  const visto = [];
  const web = http.createServer((req, res) => { visto.push({ host: req.headers.host, url: req.url }); res.end('ola do destino'); });
  const portaWeb = await escutar(web);

  const resolver = async (h) => {
    const mapa = { 'interno.test': ['10.1.2.3'], 'metadados.test': ['169.254.169.254'], 'misto.test': ['8.8.8.8', '10.9.9.9'], 'sumiu.test': [] };
    if (h in mapa) return mapa[h];
    if (h.endsWith('.test')) return ['127.0.0.1'];
    throw Object.assign(new Error('nao existe'), { code: 'ENOTFOUND' });
  };
  const proxy = criarProxy({
    etc, logDir, baseArq: BASE, porta: 0, intervaloMs: 60000, resolver,
    enderecoDe: (n) => `127.0.0.${n}`, origemOk: opcoes.origemOk || (() => true), excecoesIp: ['127.0.0.1'],
    log: opcoes.log || (() => {}), agora: opcoes.agora,
  });
  proxy.reconciliar();
  await new Promise((ok) => setTimeout(ok, 50));
  const limpar = async () => {
    await proxy.parar();
    eco.close(); web.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, etc, logDir, gravar, proxy, portaEco, portaWeb, visto, limpar, endereco: '127.0.0.11', portaProxy: () => proxy.portaDe('ana') };
}

function conectar(ctx, alvo, enviar) {
  return new Promise((ok, falha) => {
    const s = net.connect({ host: ctx.endereco, port: ctx.portaProxy() });
    let buf = '';
    let status = null;
    let corpo = '';
    s.on('error', falha);
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (status === null && buf.includes('\r\n\r\n')) {
        status = Number(buf.split(' ')[1]);
        corpo = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        if (status === 200 && enviar !== undefined) s.write(enviar);
        else if (status !== 200) return;
      } else if (status === 200) {
        corpo += d.toString('latin1');
      }
      if (status === 200 && enviar !== undefined && corpo.length >= enviar.length) s.end();
    });
    s.on('close', () => ok({ status, corpo, bruto: buf }));
    s.write(`CONNECT ${alvo} HTTP/1.1\r\nHost: ${alvo}\r\n\r\n`);
  });
}

async function linhasDoRegistro(ctx, minimo, slug = 'ana') {
  const arq = path.join(ctx.logDir, `${slug}.jsonl`);
  for (let i = 0; i < 60; i++) {
    await ctx.proxy.esperarRegistro();
    if (fs.existsSync(arq)) {
      const l = fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
      if (l.length >= minimo) return l;
    }
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`o registro de ${slug} não chegou a ${minimo} linha(s)`);
}

test('bloqueio: destino da lista passa (túnel de ida e volta) e vai para o registro só com os campos combinados', async () => {
  const c = await montar({ permitidos: ['permitido.test'] });
  try {
    const r = await conectar(c, `permitido.test:${c.portaEco}`, 'ping-ping');
    assert.equal(r.status, 200);
    assert.ok(r.corpo.includes('ping-ping'), 'o eco precisa voltar pelo túnel');
    const [l] = await linhasDoRegistro(c, 1);
    assert.deepEqual(Object.keys(l).sort(), ['bytes_down', 'bytes_up', 'decisao', 'duracao', 'host', 'porta', 'ts']);
    assert.equal(l.host, 'permitido.test');
    assert.equal(l.porta, c.portaEco);
    assert.equal(l.decisao, 'permitido');
    assert.equal(l.bytes_up, 9);
    assert.equal(l.bytes_down, 9);
  } finally { await c.limpar(); }
});

test('bloqueio: destino fora da lista leva 403 em português e fica anotado como recusado', async () => {
  const c = await montar({ permitidos: ['permitido.test'] });
  try {
    const r = await conectar(c, `fora.test:${c.portaEco}`);
    assert.equal(r.status, 403);
    assert.match(r.bruto, /dgclaw saida permitir ana fora\.test/);
    const [l] = await linhasDoRegistro(c, 1);
    assert.equal(l.decisao, 'recusado');
    assert.equal(l.motivo, 'fora-da-lista');
    assert.equal(l.bytes_up, 0);
  } finally { await c.limpar(); }
});

test('sem geral.json nenhum agente tem política (proxy fechado)', () => {
  const c = criarProxy({ etc: fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-saida-')), logDir: '/nao/importa', baseArq: BASE, log: () => {} });
  assert.deepEqual(c.politica('ana').entradas, []); // sem geral.json o agente nem existe
});

test('lista base: o agente claude alcança api.anthropic.com e o codex api.openai.com, e nenhum dos dois o do outro', async () => {
  const c = await montar();
  try {
    assert.ok(c.proxy.politica('ana').entradas.includes('api.anthropic.com'));
    assert.ok(!c.proxy.politica('ana').entradas.includes('api.openai.com'));
    assert.ok(c.proxy.politica('bia').entradas.includes('api.openai.com'));
    assert.ok(!c.proxy.politica('bia').entradas.includes('api.anthropic.com'));
  } finally { await c.limpar(); }
});

test('curinga cobre subdomínio e não o domínio raiz', async () => {
  const c = await montar({ permitidos: ['*.empresa.test'] });
  try {
    assert.equal((await conectar(c, `api.empresa.test:${c.portaEco}`, 'x')).status, 200);
    assert.equal((await conectar(c, `empresa.test:${c.portaEco}`)).status, 403);
    assert.equal((await conectar(c, `malempresa.test:${c.portaEco}`)).status, 403);
  } finally { await c.limpar(); }
});

test('nome é comparado normalizado: maiúsculas, ponto final e IDN em punycode', async () => {
  const c = await montar({ permitidos: ['münchen.test'] });
  try {
    assert.equal((await conectar(c, `XN--MNCHEN-3YA.test.:${c.portaEco}`, 'x')).status, 200);
  } finally { await c.limpar(); }
});

test('IP literal só passa se estiver na lista', async () => {
  const c = await montar();
  try {
    assert.equal((await conectar(c, `127.0.0.1:${c.portaEco}`)).status, 403);
    c.gravar('ana.json', { permitidos: ['127.0.0.1'] });
    assert.equal((await conectar(c, `127.0.0.1:${c.portaEco}`, 'x')).status, 200);
  } finally { await c.limpar(); }
});

test('destino que resolve para rede interna é recusado mesmo com o nome permitido (DNS rebinding)', async () => {
  const c = await montar({ permitidos: ['interno.test', 'metadados.test', 'misto.test', '10.0.0.5', 'sumiu.test'] });
  try {
    for (const alvo of ['interno.test', 'metadados.test', 'misto.test', '10.0.0.5']) {
      const r = await conectar(c, `${alvo}:${c.portaEco}`);
      assert.equal(r.status, 403, alvo);
    }
    const linhas = await linhasDoRegistro(c, 4);
    assert.ok(linhas.every((l) => l.decisao === 'recusado' && l.motivo === 'destino-interno'));
    assert.equal((await conectar(c, `sumiu.test:${c.portaEco}`)).status, 502);
  } finally { await c.limpar(); }
});

test('modo registro deixa tudo passar e anota; modo do agente só endurece', async () => {
  const c = await montar({ modo: 'registro' });
  try {
    assert.equal((await conectar(c, `qualquer.test:${c.portaEco}`, 'x')).status, 200);
    c.gravar('ana.json', { modo: 'bloqueio', permitidos: [] });
    assert.equal((await conectar(c, `qualquer.test:${c.portaEco}`)).status, 403);
    const l = await linhasDoRegistro(c, 2);
    assert.deepEqual(l.map((x) => x.decisao), ['permitido', 'recusado']);
  } finally { await c.limpar(); }
});

test('um agente não consegue afrouxar abaixo da instalação: modo livre ou registro no arquivo dele não vale', async () => {
  const c = await montar({ modo: 'bloqueio' });
  try {
    for (const m of ['livre', 'registro']) {
      c.gravar('ana.json', { modo: m, permitidos: [] });
      assert.equal(c.proxy.politica('ana').modo, 'bloqueio', m);
    }
  } finally { await c.limpar(); }
});

test('a lista é relida na hora, sem reiniciar o proxy', async () => {
  const c = await montar();
  try {
    assert.equal((await conectar(c, `novo.test:${c.portaEco}`)).status, 403);
    c.gravar('ana.json', { permitidos: ['novo.test'] });
    assert.equal((await conectar(c, `novo.test:${c.portaEco}`, 'x')).status, 200);
    c.gravar('ana.json', { permitidos: [] });
    assert.equal((await conectar(c, `novo.test:${c.portaEco}`)).status, 403);
  } finally { await c.limpar(); }
});

test('arquivo de lista quebrado não derruba nem abre: vale só a lista base e o erro é dito uma vez', async () => {
  const avisos = [];
  const c = await montar({ log: (n, m) => avisos.push(`${n}: ${m}`) });
  try {
    fs.writeFileSync(path.join(c.etc, 'saida', 'ana.json'), '{quebrado');
    assert.equal((await conectar(c, `novo.test:${c.portaEco}`)).status, 403);
    assert.equal((await conectar(c, `novo.test:${c.portaEco}`)).status, 403);
    const erros = avisos.filter((a) => a.includes('não é um JSON válido'));
    assert.equal(erros.length, 1);
    assert.match(erros[0], /ana\.json/);
  } finally { await c.limpar(); }
});

test('HTTP simples: vai ao destino com o Host original, e o registro não guarda caminho nem parâmetros', async () => {
  const c = await montar({ permitidos: ['permitido.test'] });
  try {
    const corpo = await new Promise((ok, falha) => {
      const req = http.request({ host: c.endereco, port: c.portaProxy(), method: 'GET', path: `http://permitido.test:${c.portaWeb}/segredo/pagina?token=abc123`, headers: { host: `permitido.test:${c.portaWeb}` } }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => ok({ status: res.statusCode, b }));
      });
      req.on('error', falha);
      req.end();
    });
    assert.equal(corpo.status, 200);
    assert.equal(corpo.b, 'ola do destino');
    assert.equal(c.visto[0].host, `permitido.test:${c.portaWeb}`);
    assert.equal(c.visto[0].url, '/segredo/pagina?token=abc123');
    await linhasDoRegistro(c, 1);
    const cru = fs.readFileSync(path.join(c.logDir, 'ana.jsonl'), 'utf8');
    assert.ok(!/segredo|token|abc123|pagina/.test(cru), 'o registro não pode ter caminho nem parâmetros');
    const negado = await new Promise((ok, falha) => {
      const req = http.request({ host: c.endereco, port: c.portaProxy(), method: 'GET', path: `http://fora.test:${c.portaWeb}/x` }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
      req.on('error', falha);
      req.end();
    });
    assert.equal(negado, 403);
  } finally { await c.limpar(); }
});

test('conexão que não veio da rede do agente é recusada e anotada', async () => {
  const c = await montar({ permitidos: ['permitido.test'], origemOk: () => false });
  try {
    assert.equal((await conectar(c, `permitido.test:${c.portaEco}`)).status, 403);
    const [l] = await linhasDoRegistro(c, 1);
    assert.equal(l.motivo, 'origem');
  } finally { await c.limpar(); }
});

test('pedido CONNECT mal formado leva 400 e o host fica "(invalido)" no registro, nunca o texto recebido', async () => {
  const c = await montar();
  try {
    const r = await conectar(c, 'isto-nao-tem-porta');
    assert.equal(r.status, 400);
    const [l] = await linhasDoRegistro(c, 1);
    assert.equal(l.host, '(invalido)');
  } finally { await c.limpar(); }
});

test('reconciliar: abre o proxy de quem tem modo, fecha o de quem saiu, e agente em livre fica sem proxy', async () => {
  const c = await montar();
  try {
    assert.deepEqual(c.proxy.escutando(), ['ana', 'bia']);
    c.gravar('geral.json', { versao: 1, modo: 'bloqueio', retencao_dias: 0, agentes: { ana: { n: 11, provedor: 'claude' } } });
    c.proxy.reconciliar();
    assert.deepEqual(c.proxy.escutando(), ['ana']);
    c.gravar('geral.json', { versao: 1, modo: 'livre', retencao_dias: 0, agentes: { ana: { n: 11, provedor: 'claude' } } });
    c.proxy.reconciliar();
    assert.deepEqual(c.proxy.escutando(), []);
  } finally { await c.limpar(); }
});

test('retenção: tira do registro as linhas mais velhas que retencao_dias e mantém o resto', async () => {
  const agora = Date.parse('2026-10-18T12:00:00Z');
  const c = await montar({ retencao: 30, agora: () => agora });
  try {
    fs.mkdirSync(c.logDir, { recursive: true });
    const velha = JSON.stringify({ ts: '2026-08-01T00:00:00.000Z', host: 'velho.test', porta: 443, decisao: 'permitido', bytes_up: 1, bytes_down: 1, duracao: 1 });
    const nova = JSON.stringify({ ts: '2026-10-10T00:00:00.000Z', host: 'novo.test', porta: 443, decisao: 'permitido', bytes_up: 1, bytes_down: 1, duracao: 1 });
    fs.writeFileSync(path.join(c.logDir, 'ana.jsonl'), `${velha}\n${nova}\n`);
    assert.equal(await c.proxy.podar(), 1);
    const resto = fs.readFileSync(path.join(c.logDir, 'ana.jsonl'), 'utf8');
    assert.ok(!resto.includes('velho.test') && resto.includes('novo.test'));
  } finally { await c.limpar(); }
});

// --- CLI de listas ----------------------------------------------------------------------------------------

function cli(etc, logDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--etc', etc, '--log', logDir, '--base', BASE], { encoding: 'utf8' });
  return { rc: r.status, out: r.stdout, err: r.stderr };
}

test('cli: permitir, mostrar, remover e o modo que só endurece', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-saida-cli-'));
  const etc = path.join(tmp, 'etc');
  const logDir = path.join(tmp, 'log');
  fs.mkdirSync(path.join(etc, 'saida'), { recursive: true });
  fs.writeFileSync(path.join(etc, 'saida', 'geral.json'), JSON.stringify({ versao: 1, modo: 'registro', retencao_dias: 0, agentes: { ana: { n: 11, provedor: 'claude' } } }));
  try {
    let r = cli(etc, logDir, 'permitir', 'ana', '*.Empresa.com.br');
    assert.equal(r.rc, 0, r.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(etc, 'saida', 'ana.json'), 'utf8')), { permitidos: ['*.empresa.com.br'] });
    r = cli(etc, logDir, 'permitir', 'ana', 'https://x.com/a');
    assert.equal(r.rc, 1);
    assert.match(r.err, /Nao deu certo: .*URL[\s\S]*O que fazer:/);
    r = cli(etc, logDir, 'permitir', 'zzz', 'a.com');
    assert.equal(r.rc, 1);
    assert.match(r.err, /não conheço o agente "zzz"/);
    r = cli(etc, logDir, 'mostrar', 'ana');
    assert.match(r.out, /api\.anthropic\.com/);
    assert.match(r.out, /\*\.empresa\.com\.br/);
    r = cli(etc, logDir, 'modo', 'ana', 'livre');
    assert.equal(r.rc, 1);
    assert.match(r.err, /mais solto/);
    r = cli(etc, logDir, 'modo', 'ana', 'bloqueio');
    assert.equal(r.rc, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(path.join(etc, 'saida', 'ana.json'), 'utf8')).modo, 'bloqueio');
    r = cli(etc, logDir, 'remover', 'ana', 'api.anthropic.com');
    assert.equal(r.rc, 1);
    assert.match(r.err, /lista base/);
    r = cli(etc, logDir, 'remover', 'ana', '*.empresa.com.br');
    assert.equal(r.rc, 0, r.err);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('cli: relatório soma por destino, marca o que está fora da lista e respeita --dias', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-saida-cli-'));
  const etc = path.join(tmp, 'etc');
  const logDir = path.join(tmp, 'log');
  fs.mkdirSync(path.join(etc, 'saida'), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(etc, 'saida', 'geral.json'), JSON.stringify({ versao: 1, modo: 'registro', retencao_dias: 0, agentes: { ana: { n: 11, provedor: 'claude' } } }));
  const agora = Date.now();
  const l = (h, d, ms, up = 10, down = 20) => JSON.stringify({ ts: new Date(agora - ms).toISOString(), host: h, porta: 443, decisao: d, bytes_up: up, bytes_down: down, duracao: 5 });
  fs.writeFileSync(path.join(logDir, 'ana.jsonl'), [
    l('api.anthropic.com', 'permitido', 1000), l('api.anthropic.com', 'permitido', 2000), l('estranho.test', 'permitido', 3000),
    l('velho.test', 'permitido', 20 * 86400000), 'lixo que nao e json',
  ].join('\n') + '\n');
  try {
    let r = cli(etc, logDir, 'relatorio', 'ana', '--dias', '7', '--json');
    const j = JSON.parse(r.out);
    assert.deepEqual(j.destinos.map((d) => [d.host, d.acessos, d.na_lista]), [['api.anthropic.com', 2, true], ['estranho.test', 1, false]]);
    r = cli(etc, logDir, 'relatorio', 'ana', '--dias', '30');
    assert.match(r.out, /velho\.test/);
    assert.match(r.out, /2 destino\(s\) fora da lista/);
    assert.match(r.out, /1 linha\(s\) do registro estavam ilegíveis/);
    r = cli(etc, logDir, 'relatorio', 'ana', '--dias', '0');
    assert.equal(r.rc, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
