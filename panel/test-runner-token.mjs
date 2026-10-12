// test-runner-token.mjs: o painel manda `Authorization: Bearer <token>` ao runner.
//
// Cobre lib/runner-token.js (sem configuração, com arquivo, troca do token, arquivo
// ausente) e uma ponta a ponta: um "runner" falso em 127.0.0.1 que EXIGE o Bearer e
// recebe a chamada de verdade de lib/provedores.js. O token é gerado na hora, nunca
// fica escrito no teste. Nada toca agente nenhum.
//
// `node test-runner-token.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(new URL(import.meta.url).pathname);

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const logs = [];
console.error = (...a) => { logs.push(a.map(String).join(' ')); };

delete process.env.RUNNER_TOKEN_FILE;
const { cabecalhoDoRunner, caminhoDoToken } = require('./lib/runner-token.js');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-token-teste-'));
const TOKEN1 = crypto.randomBytes(32).toString('hex');
const TOKEN2 = crypto.randomBytes(32).toString('hex');
const arquivo = path.join(RAIZ, 'runner.token');

console.log('\nsem configuração');
ok(JSON.stringify(cabecalhoDoRunner({})) === '{}', 'sem caminho nenhum devolve {}');
ok(caminhoDoToken({}) === null, 'caminhoDoToken devolve null');

console.log('\ncom arquivo');
fs.writeFileSync(arquivo, `${TOKEN1}\n`, { mode: 0o600 });
ok(cabecalhoDoRunner({ runnerTokenFile: arquivo }).Authorization === `Bearer ${TOKEN1}`, 'config.runnerTokenFile: devolve o Bearer, sem a quebra de linha');
process.env.RUNNER_TOKEN_FILE = arquivo;
ok(cabecalhoDoRunner({}).Authorization === `Bearer ${TOKEN1}`, 'RUNNER_TOKEN_FILE no ambiente também vale');

console.log('\ntroca do token sem reiniciar');
fs.writeFileSync(arquivo, TOKEN2);
const futuro = new Date(Date.now() + 5000);
fs.utimesSync(arquivo, futuro, futuro);
ok(cabecalhoDoRunner({}).Authorization === `Bearer ${TOKEN2}`, 'mtime novo: o token novo é lido');

console.log('\narquivo ausente ou vazio');
const ausente = path.join(RAIZ, 'nao-existe');
logs.length = 0;
ok(JSON.stringify(cabecalhoDoRunner({ runnerTokenFile: ausente })) === '{}', 'arquivo ausente devolve {}');
cabecalhoDoRunner({ runnerTokenFile: ausente });
cabecalhoDoRunner({ runnerTokenFile: ausente });
ok(logs.length === 1, 'loga UMA vez só');
ok(logs[0].includes(ausente) && logs[0].includes('ENOENT'), 'o aviso traz o caminho e o código do erro');
const vazio = path.join(RAIZ, 'vazio');
fs.writeFileSync(vazio, '  \n');
ok(JSON.stringify(cabecalhoDoRunner({ runnerTokenFile: vazio })) === '{}', 'arquivo vazio devolve {}');
ok(!logs.join('\n').includes(TOKEN1) && !logs.join('\n').includes(TOKEN2), 'nenhum log contém o token');
delete process.env.RUNNER_TOKEN_FILE;

console.log('\nponta a ponta: provedores.js contra um runner que exige o Bearer');
const recebidos = [];
const srv = http.createServer((req, res) => {
  recebidos.push(req.headers.authorization || null);
  const json = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== `Bearer ${TOKEN2}`) return json(401, { error: 'sem token' });
  json(200, { estado: 'ocioso' });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

async function chamarLogin(CONFIG) {
  const rotas = {};
  const router = {};
  for (const m of ['get', 'post', 'delete']) router[m] = (p, h) => { rotas[`${m.toUpperCase()} ${p}`] = h; };
  require('./lib/provedores.js')(router, { CONFIG, cofre: {}, serverDir: AQUI });
  let status = 200; let corpo;
  const res = { status(s) { status = s; return res; }, json(o) { corpo = o; return res; } };
  await rotas['GET /api/provedor/login']({ body: {}, query: {} }, res);
  return { status, corpo };
}

const comToken = await chamarLogin({ bunkerUrl: base, bunkerCard: 'cardX', runnerTokenFile: arquivo });
ok(comToken.status === 200 && recebidos.at(-1) === `Bearer ${TOKEN2}`, 'com token configurado o runner recebe o Bearer e responde 200');
const semToken = await chamarLogin({ bunkerUrl: base, bunkerCard: 'cardX' });
ok(semToken.status === 401 && recebidos.at(-1) === null, 'sem token configurado nenhum cabeçalho sai (o runner responde 401)');
srv.close();
fs.rmSync(RAIZ, { recursive: true, force: true });

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
