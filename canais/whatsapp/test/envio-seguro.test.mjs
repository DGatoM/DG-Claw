// envio-seguro.test.mjs - As travas contra banimento, o adaptador da Z-API e o script do agente.
// Relogio, espera e sorteio sao injetados: nenhum teste dorme de verdade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarEnvioSeguro, lerConfig, PADRAO } from '../lib/envio-seguro.mjs';
import { criarAdaptadorZapi } from '../lib/adaptador-zapi.mjs';
import { executar } from '../enviar-zapi.mjs';

const A = '+5511911111111';
const B = '+5511922222222';
const C = '+5511933333333';

function montar({ config = null, sorteio = 0 } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envio-')));
  const arqConfig = path.join(home, 'envio.json');
  if (config) fs.writeFileSync(arqConfig, JSON.stringify(config));
  const relogio = { t: Date.parse('2026-11-16T15:00:00Z') };
  const esperas = [];
  const logs = [];
  const envio = criarEnvioSeguro({
    dir: path.join(home, 'envio'), arqConfig,
    agora: () => new Date(relogio.t),
    dormir: async (ms) => { esperas.push(ms); relogio.t += ms; },
    aleatorio: () => sorteio,
    registrar: (m) => logs.push(m),
  });
  const enviados = [];
  const mandar = (para, texto, falhar = null) => envio.enviar({
    para, texto,
    executar: async () => { if (falhar) throw new Error(falhar); enviados.push({ para, texto }); return { key: { id: 'X' + enviados.length } }; },
  });
  return { home, relogio, esperas, logs, envio, enviados, mandar, arqConfig, limpar: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('conversa com uma pessoa so: sem espera e sem teto de rodada', async () => {
  const m = montar();
  for (let i = 0; i < 40; i++) {
    const r = await m.mandar(A, `mensagem numero ${i} da conversa`);
    assert.equal(r.ok, true);
    assert.equal(r.disparo, false);
    m.relogio.t += 1000;
  }
  assert.deepEqual(m.esperas, []);
  m.limpar();
});

test('disparo: a segunda pessoa dentro de 60 min espera o intervalo aleatorio (8 a 20 s)', async () => {
  for (const [sorteio, esperado] of [[0, 8000], [1, 20000]]) {
    const m = montar({ sorteio });
    assert.equal((await m.mandar(A, 'oi, tudo bem com voce hoje?')).ok, true);
    m.relogio.t += 1000;
    const r = await m.mandar(B, 'bom dia, como vai o seu dia?');
    assert.equal(r.ok, true);
    assert.equal(r.disparo, true);
    assert.equal(m.esperas.length, 1);
    assert.ok(Math.abs(m.esperas[0] - (esperado - 1000)) <= 1, `esperou ${m.esperas[0]}`);
    m.limpar();
  }
});

test('disparo: ja passou o intervalo, nao espera mais nada', async () => {
  const m = montar();
  await m.mandar(A, 'primeira mensagem para a Ana');
  m.relogio.t += 5 * 60 * 1000;
  await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.deepEqual(m.esperas, []);
  m.limpar();
});

test('RITMO: espera maior que o maximo aceito volta o tempo restante e nao envia', async () => {
  const m = montar({ config: { intervalo_min_s: 60, intervalo_max_s: 90 } });
  await m.mandar(A, 'primeira mensagem para a Ana');
  const r = await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.equal(r.ok, false);
  assert.equal(r.codigo, 'RITMO');
  assert.match(r.erro, /segundos/);
  assert.equal(m.enviados.length, 1);
  m.limpar();
});

test('rodada: no teto, pausa; passada a pausa, volta; so conta envios de disparo', async () => {
  const m = montar({ config: { teto_rodada: 3, pausa_rodada_min: 30 } });
  await m.mandar(A, 'mensagem um para a Ana aqui');
  await m.mandar(B, 'mensagem dois para o Bruno');   // disparo comeca aqui
  await m.mandar(C, 'mensagem tres para a Carla');
  await m.mandar(A, 'mensagem quatro para a Ana');
  const r = await m.mandar(B, 'mensagem cinco para o Bruno');
  assert.equal(r.codigo, 'PAUSA_DA_RODADA');
  assert.match(r.erro, /minutos/);
  m.relogio.t += 31 * 60 * 1000;
  assert.equal((await m.mandar(B, 'mensagem cinco, depois da pausa')).ok, true);
  m.limpar();
});

test('teto do dia: em disparo, 24 h; depois das 24 h libera', async () => {
  const m = montar({ config: { teto_dia: 4, teto_rodada: 100 } });
  const nomes = [A, B, C];
  for (let i = 0; i < 4; i++) assert.equal((await m.mandar(nomes[i % 3], `mensagem ${i} bem diferente das outras`)).ok, true);
  const r = await m.mandar(A, 'mais uma mensagem bem diferente');
  assert.equal(r.codigo, 'TETO_DIA');
  m.relogio.t += 24 * 3600 * 1000 + 1000;
  assert.equal((await m.mandar(A, 'mais uma mensagem bem diferente')).ok, true);
  m.limpar();
});

test('texto igual para duas pessoas em 24 h e recusado; para a mesma pessoa e texto curto, nao', async () => {
  const m = montar();
  assert.equal((await m.mandar(A, 'Oi, tudo bem? Passando para avisar da reuniao')).ok, true);
  let r = await m.mandar(B, '  OI, tudo bem?   passando para avisar da reuniao ');
  assert.equal(r.codigo, 'TEXTO_REPETIDO');
  assert.equal((await m.mandar(A, 'Oi, tudo bem? Passando para avisar da reuniao')).ok, true);
  assert.equal((await m.mandar(B, 'ok')).ok, true);
  assert.equal((await m.mandar(C, 'ok')).ok, true);
  m.relogio.t += 25 * 3600 * 1000;
  assert.equal((await m.mandar(B, 'Oi, tudo bem? Passando para avisar da reuniao')).ok, true);
  m.limpar();
});

test('o primeiro erro trava tudo, a trava sobrevive a novo processo, e liberar destrava', async () => {
  const m = montar();
  const r = await m.mandar(A, 'primeira mensagem para a Ana', 'socket fechado');
  assert.equal(r.codigo, 'FALHA_ENVIO');
  assert.match(r.erro, /TRAVADOS/);
  assert.match(r.erro, /retomar/);
  const r2 = await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.equal(r2.codigo, 'PARADO');
  assert.equal(m.enviados.length, 0);
  const outro = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig });
  assert.ok(outro.paradoMotivo());
  assert.equal(outro.liberar(), true);
  assert.equal((await m.mandar(B, 'segunda mensagem para o Bruno')).ok, true);
  m.limpar();
});

test('travar() de fora (bloqueio sinalizado pela conexao) tambem para os envios', async () => {
  const m = montar();
  m.envio.travar('o WhatsApp recusou o aparelho (403)');
  assert.equal((await m.mandar(A, 'mensagem qualquer para alguem')).codigo, 'PARADO');
  m.limpar();
});

test('configuracao: valor ruim recusa o envio com o motivo, nunca vira padrao em silencio', async () => {
  for (const [cfg, trecho] of [
    [{ intervalo_min_s: 1 }, /intervalo_min_s/],
    [{ intervalo_min_s: 30, intervalo_max_s: 10 }, /nao pode ser maior/],
    [{ teto_dia: 100000 }, /teto_dia/],
    [{ inventada: 1 }, /desconhecida/],
    [{ numero_novo_desde: 'ontem' }, /AAAA-MM-DD/],
    [{ numero_novo_desde: '2026-13-16' }, /AAAA-MM-DD/],
    [{ numero_novo_desde: '2026-02-30' }, /AAAA-MM-DD/],
  ]) {
    const m = montar({ config: cfg });
    const r = await m.mandar(A, 'mensagem qualquer para alguem');
    assert.equal(r.codigo, 'CONFIG_INVALIDA', JSON.stringify(cfg));
    assert.match(r.erro, trecho);
    assert.equal(m.enviados.length, 0);
    m.limpar();
  }
  const m = montar();
  fs.writeFileSync(m.arqConfig, '{quebrado');
  assert.match(lerConfig(m.arqConfig).erro, /JSON valido/);
  m.limpar();
});

test('configuracao: o dono pode ir mais devagar (intervalo maior) e os padroes sao os calibrados', async () => {
  assert.equal(PADRAO.intervalo_min_s, 8);
  assert.equal(PADRAO.intervalo_max_s, 20);
  assert.equal(PADRAO.teto_rodada, 30);
  assert.equal(PADRAO.pausa_rodada_min, 30);
  assert.equal(PADRAO.teto_dia, 60);
  const m = montar({ config: { intervalo_min_s: 15, intervalo_max_s: 22 }, sorteio: 0 });
  await m.mandar(A, 'primeira mensagem para a Ana');
  await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.equal(m.esperas[0], 15000);
  m.limpar();
});

test('aquecimento: numero novo tem teto por dia, todas as mensagens contam', async () => {
  const m = montar({ config: { numero_novo_desde: '2026-11-15' } }); // dia 2: teto 10
  for (let i = 0; i < 10; i++) assert.equal((await m.mandar(A, `mensagem ${i} da conversa com a Ana`)).ok, true);
  const r = await m.mandar(A, 'mensagem onze da conversa com a Ana');
  assert.equal(r.codigo, 'AQUECIMENTO');
  assert.match(r.erro, /dia 2/);
  m.limpar();
});

test('estado em disco: 600, pasta 700, sem numero e sem texto', async () => {
  const m = montar();
  await m.mandar(A, 'texto secreto da mensagem aqui');
  const arq = path.join(m.home, 'envio', 'estado.json');
  assert.equal(fs.statSync(arq).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(m.home, 'envio')).mode & 0o777, 0o700);
  const bruto = fs.readFileSync(arq, 'utf8');
  assert.ok(!bruto.includes('secreto') && !bruto.includes('911111111'));
  m.limpar();
});

test('envios simultaneos sao serializados: um de cada vez, com intervalo entre eles', async () => {
  const m = montar();
  const rs = await Promise.all([
    m.mandar(A, 'mensagem para a Ana, primeira'), m.mandar(B, 'mensagem para o Bruno, segunda'), m.mandar(C, 'mensagem para a Carla, terceira'),
  ]);
  assert.ok(rs.every((r) => r.ok));
  assert.equal(m.esperas.length, 2);
  m.limpar();
});

// --- Z-API -------------------------------------------------------------------

const CHAVES = { instancia: 'INST123', token: 'TOK456', clientToken: 'CLI789' };

test('zapi: manda POST send-text com Client-Token e so os digitos do numero', async () => {
  const chamadas = [];
  const fetchImpl = async (url, init) => { chamadas.push({ url, init }); return { ok: true, status: 200, json: async () => ({ messageId: 'MSG1', zaapId: 'Z1' }) }; };
  const z = criarAdaptadorZapi({ ...CHAVES, fetchImpl });
  assert.deepEqual(await z.enviarTexto('+55 11 91111-1111', 'oi'), { id: 'MSG1' });
  assert.equal(chamadas[0].url, 'https://api.z-api.io/instances/INST123/token/TOK456/send-text');
  assert.equal(chamadas[0].init.headers['Client-Token'], 'CLI789');
  assert.deepEqual(JSON.parse(chamadas[0].init.body), { phone: '5511911111111', message: 'oi' });
});

test('zapi: erro nunca carrega token, instancia nem client-token; sem id nao conta como enviado', async () => {
  const z1 = criarAdaptadorZapi({ ...CHAVES, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad TOK456 CLI789 INST123' }) }) });
  await assert.rejects(() => z1.enviarTexto('+5511911111111', 'oi'), (e) => /HTTP 401/.test(e.message) && !/TOK456|CLI789|INST123/.test(e.message));
  const z2 = criarAdaptadorZapi({ ...CHAVES, fetchImpl: async () => { throw new Error('boom em https://api.z-api.io/instances/INST123/token/TOK456/send-text'); } });
  await assert.rejects(() => z2.enviarTexto('+5511911111111', 'oi'), (e) => !/TOK456|INST123/.test(e.message));
  const z3 = criarAdaptadorZapi({ ...CHAVES, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(() => z3.enviarTexto('+5511911111111', 'oi'), /sem id/);
  assert.throws(() => criarAdaptadorZapi({ instancia: 'a', token: '', clientToken: 'c' }), /ZAPI_TOKEN/);
});

test('script do agente: enviar passa pelas travas, 2o erro e PARADO, status mostra a trava', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-')));
  const env = { ZAPI_INSTANCE: 'INST123', ZAPI_TOKEN: 'TOK456', ZAPI_CLIENT_TOKEN: 'CLI789' };
  let falhar = false;
  const fetchImpl = async () => (falhar
    ? { ok: false, status: 500, json: async () => ({ error: 'caiu' }) }
    : { ok: true, status: 200, json: async () => ({ messageId: 'M' + Math.random() }) });
  const opc = { env, home, fetchImpl, dormir: async () => {} };
  let r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'oi, tudo bem por ai?'], opc);
  assert.equal(r.codigoSaida, 0);
  assert.equal(r.resposta.ok, true);
  assert.equal(r.resposta.para, '+5511911111111');
  falhar = true;
  r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'outra mensagem diferente'], opc);
  assert.equal(r.resposta.codigo, 'FALHA_ENVIO');
  falhar = false;
  r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'mais uma mensagem diferente'], opc);
  assert.equal(r.resposta.codigo, 'PARADO');
  assert.equal(r.codigoSaida, 1);
  r = await executar(['status'], opc);
  assert.equal(r.resposta.parado, true);
  r = await executar(['enviar', '--para', 'abc', '--texto', 'x'], opc);
  assert.equal(r.codigoSaida, 2);
  r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'x'], { ...opc, env: {} });
  assert.equal(r.resposta.codigo, 'PARADO'); // a trava vem antes de qualquer outra coisa
  fs.rmSync(home, { recursive: true, force: true });
});

test('script do agente: sem as chaves diz quais faltam, sem enviar', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-')));
  const r = await executar(['enviar', '--para', '+5511911111111', '--texto', 'oi'], { env: {}, home });
  assert.equal(r.resposta.codigo, 'SEM_CHAVE');
  assert.match(r.resposta.erro, /ZAPI_INSTANCE/);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- Revisao adversarial, rodada 1 ----------------------------------------------

test('historico corrompido recusa o envio em vez de zerar os contadores', async () => {
  const m = montar();
  await m.mandar(A, 'primeira mensagem para a Ana');
  fs.writeFileSync(path.join(m.home, 'envio', 'estado.json'), '{"envios":');
  const r = await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.equal(r.codigo, 'ESTADO_INVALIDO');
  assert.equal(m.enviados.length, 1);
  m.limpar();
});

test('historico que nao grava: a mensagem ja saiu, avisa, e o resto fica travado', async () => {
  const m = montar();
  fs.mkdirSync(path.join(m.home, 'envio', `estado.json.${process.pid}.tmp`), { recursive: true }); // gravar o historico falha
  const r = await m.mandar(A, 'primeira mensagem para a Ana');
  assert.equal(r.ok, true);
  assert.match(r.aviso, /travados/);
  const r2 = await m.mandar(B, 'segunda mensagem para o Bruno');
  assert.equal(r2.codigo, 'PARADO');
  assert.equal(m.enviados.length, 1);
  m.limpar();
});

test('trava na memoria vale mesmo se o arquivo PARADO nao puder ser gravado', async () => {
  const m = montar();
  fs.mkdirSync(path.join(m.home, 'envio', 'PARADO'), { recursive: true }); // escrever o arquivo falha
  m.envio.travar('teste');
  assert.ok(m.envio.paradoMotivo());
  assert.equal((await m.mandar(A, 'mensagem qualquer para alguem')).codigo, 'PARADO');
  m.limpar();
});

test('a trava entre processos nao e tomada por idade: so quando o dono morreu', async () => {
  const m = montar();
  const arq = path.join(m.home, 'envio', 'envio.lock');
  // dono vivo (o pai deste processo) com arquivo "velho": nao pode ser roubada, vira OCUPADO no prazo
  fs.writeFileSync(arq, String(process.ppid));
  const velho = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(arq, velho, velho);
  const t0 = Date.now();
  const origNow = Date.now;
  let n = 0;
  Date.now = () => origNow() + (n++ > 3 ? 60000 : 0); // faz o prazo de 45 s estourar sem esperar
  const r = await m.mandar(A, 'mensagem qualquer para alguem');
  Date.now = origNow;
  assert.equal(r.codigo, 'OCUPADO');
  assert.equal(m.enviados.length, 0);
  assert.ok(Date.now() - t0 < 5000);
  // dono morto (pid inexistente): a trava e tomada
  fs.writeFileSync(arq, '999999999');
  assert.equal((await m.mandar(A, 'mensagem qualquer para alguem')).ok, true);
  m.limpar();
});

test('pedido velho na fila (prazo vencido) nao e enviado', async () => {
  const m = montar();
  const r = await m.envio.enviar({ para: A, texto: 'x', prazoMs: -1, executar: async () => { throw new Error('nao devia enviar'); } });
  assert.equal(r.codigo, 'EXPIRADO');
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'PARADO')), false);
  m.limpar();
});

// --- Revisao adversarial, rodada 2 ----------------------------------------------

test('duas instancias na mesma pasta entram uma de cada vez', async () => {
  const m = montar();
  const outra = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig, agora: () => new Date(m.relogio.t), dormir: async () => {}, aleatorio: () => 0 });
  let dentro = 0; let max = 0;
  const exec = async () => { dentro++; max = Math.max(max, dentro); await new Promise((r) => setTimeout(r, 20)); dentro--; return {}; };
  await Promise.all([
    m.envio.enviar({ para: A, texto: 'mensagem para a Ana, primeira', executar: exec }),
    outra.enviar({ para: B, texto: 'mensagem para o Bruno, segunda', executar: exec }),
  ]);
  assert.equal(max, 1);
  const est = JSON.parse(fs.readFileSync(path.join(m.home, 'envio', 'estado.json'), 'utf8'));
  assert.equal(est.envios.length, 2);
  m.limpar();
});

test('trava de dono morto e retomada uma vez so, e a trava nunca nasce vazia', async () => {
  const m = montar();
  fs.writeFileSync(path.join(m.home, 'envio', 'envio.lock'), '999999999');
  const rs = await Promise.all([A, B, C].map((p, i) => m.mandar(p, `mensagem numero ${i} bem diferente`)));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'envio.lock')), false);
  m.limpar();
});

test('trava acionada durante a espera impede o envio pendente', async () => {
  const m = montar();
  await m.mandar(A, 'primeira mensagem para a Ana');
  const envio = criarEnvioSeguro({
    dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig, agora: () => new Date(m.relogio.t), aleatorio: () => 1,
    dormir: async () => { envio.travar('desconexao 403 durante a espera'); },
  });
  const r = await envio.enviar({ para: B, texto: 'segunda mensagem para o Bruno', executar: async () => { throw new Error('nao devia enviar'); } });
  assert.equal(r.codigo, 'PARADO');
  m.limpar();
});

test('conferir() recusa o envio depois da espera, sem travar', async () => {
  const m = montar();
  const r = await m.envio.enviar({ para: A, texto: 'x', conferir: () => ({ ok: false, codigo: 'FORA_DA_LISTA', erro: 'saiu' }), executar: async () => { throw new Error('nao devia enviar'); } });
  assert.equal(r.codigo, 'FORA_DA_LISTA');
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'PARADO')), false);
  m.limpar();
});

// --- Revisao adversarial, rodada 4 ----------------------------------------------

test('se o disco recusa o PARADO depois de um erro, o marcador PENDENTE segura os envios em outro processo', async () => {
  const m = montar();
  const r = await m.envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: async () => {
    fs.mkdirSync(path.join(m.home, 'envio', 'PARADO'), { recursive: true }); // a partir daqui, gravar PARADO falha
    throw new Error('api caiu');
  } });
  assert.equal(r.codigo, 'FALHA_ENVIO');
  fs.rmSync(path.join(m.home, 'envio', 'PARADO'), { recursive: true });
  const outro = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig });
  const bloqueado = await outro.enviar({ para: B, texto: 'segunda mensagem para o Bruno', executar: async () => { throw new Error('nao devia enviar'); } });
  assert.equal(bloqueado.codigo, 'PARADO');
  assert.match(bloqueado.erro, /resultado conhecido/);
  assert.equal(outro.liberar(), false); // so havia o PENDENTE, que foi removido
  assert.equal(outro.pendente(), false);
  m.limpar();
});

test('sucesso nao deixa PENDENTE; pasta sem escrita recusa antes de enviar', async () => {
  const m = montar();
  assert.equal((await m.mandar(A, 'primeira mensagem para a Ana')).ok, true);
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'PENDENTE')), false);
  fs.mkdirSync(path.join(m.home, 'envio', 'PENDENTE'));
  assert.equal(m.envio.pendente(), true);
  m.limpar();
});

test('marcador PENDENTE so sai depois do historico gravado; se o historico falha, ele fica', async () => {
  const m = montar();
  await m.envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: async () => {
    fs.mkdirSync(path.join(m.home, 'envio', `estado.json.${process.pid}.tmp`), { recursive: true }); // gravar o historico falha
    return {};
  } });
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'PENDENTE')), true);
  const outro = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig });
  assert.equal(outro.pendente(), true);
  assert.equal((await outro.enviar({ para: B, texto: 'segunda mensagem para o Bruno', executar: async () => ({}) })).codigo, 'PARADO');
  m.limpar();
});

test('um envio em andamento nao faz o segundo pedido ver PARADO: ele espera a vez', async () => {
  const m = montar();
  let solta;
  const segura = new Promise((r) => { solta = r; });
  const outra = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig, agora: () => new Date(m.relogio.t), dormir: async () => {}, aleatorio: () => 0 });
  const p1 = m.envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: async () => { await segura; return {}; } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.envio.pendente(), true);
  const p2 = outra.enviar({ para: B, texto: 'segunda mensagem para o Bruno', executar: async () => ({}) });
  await new Promise((r) => setTimeout(r, 30));
  solta();
  assert.equal((await p1).ok, true);
  assert.equal((await p2).ok, true);
  m.limpar();
});

test('ponte e Z-API dividem o mesmo estado: texto repetido e trava valem entre elas', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-')));
  const ponte = criarEnvioSeguro({ dir: path.join(home, '.dgclaw', 'whatsapp', 'envio'), arqConfig: path.join(home, '.dgclaw', 'whatsapp', 'envio.json') });
  const texto = 'Oi, tudo bem? Passando para avisar da reuniao';
  assert.equal((await ponte.enviar({ para: A, texto, executar: async () => ({}) })).ok, true);
  const env = { ZAPI_INSTANCE: 'I', ZAPI_TOKEN: 'T', ZAPI_CLIENT_TOKEN: 'C' };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ messageId: 'M' }) });
  let r = await executar(['enviar', '--para', B, '--texto', texto], { env, home, fetchImpl, dormir: async () => {} });
  assert.equal(r.resposta.codigo, 'TEXTO_REPETIDO');
  ponte.travar('teste');
  r = await executar(['enviar', '--para', B, '--texto', 'outro texto bem diferente do anterior'], { env, home, fetchImpl, dormir: async () => {} });
  assert.equal(r.resposta.codigo, 'PARADO');
  fs.rmSync(home, { recursive: true, force: true });
});

test('retomar logo depois de um envio incerto e recusado ate passar o tempo de seguranca', async () => {
  const m = montar();
  const envio = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig, limiteExecucaoMs: 30 });
  await envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: () => new Promise(() => {}) });
  const r = await envio.liberarComTrava();
  assert.equal(r.codigo, 'AINDA_PODE_ESTAR_ENVIANDO');
  assert.equal(envio.pendente(), true);
  const velho = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(m.home, 'envio', 'PENDENTE'), velho, velho);
  assert.equal((await envio.liberarComTrava()).ok, true);
  m.limpar();
});

test('liberarComTrava espera o envio no ar terminar e so entao apaga PARADO e PENDENTE', async () => {
  const m = montar();
  let solta;
  const segura = new Promise((r) => { solta = r; });
  const p1 = m.envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: async () => { await segura; return {}; } });
  await new Promise((r) => setTimeout(r, 30));
  const outra = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig });
  let liberou = false;
  const p2 = outra.liberarComTrava().then((r) => { liberou = true; return r; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(liberou, false); // esperando o envio no ar
  assert.equal(m.envio.pendente(), true);
  solta();
  await p1;
  const r = await p2;
  assert.equal(r.ok, true);
  assert.equal(m.envio.pendente(), false);
  m.limpar();
});

test('script do agente: retomar libera a trava', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zapi-')));
  const opc = { env: {}, home };
  fs.mkdirSync(path.join(home, '.dgclaw', 'whatsapp', 'envio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dgclaw', 'whatsapp', 'envio', 'PARADO'), '{"motivo":"x","quando":"y"}');
  let r = await executar(['retomar'], opc);
  assert.deepEqual(r.resposta, { ok: true, achou: true });
  r = await executar(['retomar'], opc);
  assert.equal(r.resposta.achou, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('envio que nunca responde: passado o limite, trava, mantem PENDENTE e solta a vez', async () => {
  const m = montar();
  const envio = criarEnvioSeguro({ dir: path.join(m.home, 'envio'), arqConfig: m.arqConfig, limiteExecucaoMs: 50 });
  const r = await envio.enviar({ para: A, texto: 'primeira mensagem para a Ana', executar: () => new Promise(() => {}) });
  assert.equal(r.codigo, 'FALHA_ENVIO');
  assert.match(r.erro, /incerto/);
  assert.equal(envio.pendente(), true);
  assert.ok(envio.paradoMotivo());
  assert.equal(fs.existsSync(path.join(m.home, 'envio', 'envio.lock')), false);
  m.limpar();
});
