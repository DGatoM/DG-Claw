// test-cf-access.mjs — o painel atrás do Cloudflare Access entra sem a senha, e só nesse caso.
//
// Sobe o painel de verdade numa porta livre, com um JWKS falso servido aqui mesmo, e assina
// JWTs com uma chave RSA gerada na hora. Nada sai da máquina e nenhum agente real é tocado.
// `node test-cf-access.mjs` na pasta do painel (precisa do `npm i` feito).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const TEAM = 'time-teste.cloudflareaccess.com';
const AUD = 'aud-do-painel-teste';
const EMAIL = 'dono@exemplo.com';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const outra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt(payload, { chave = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const corpo = `${b64({ alg, kid, typ: 'JWT' })}.${b64(payload)}`;
  const ass = crypto.sign('RSA-SHA256', Buffer.from(corpo), chave).toString('base64url');
  return `${corpo}.${ass}`;
}
const agora = () => Math.floor(Date.now() / 1000);
const bom = () => ({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: agora() + 600, iat: agora() });

function porta() {
  return new Promise((ok) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

let jwksNoAr = true;
const jwks = http.createServer((req, res) => {
  if (!jwksNoAr) { res.writeHead(503); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
const portaJwks = await porta();
await new Promise((ok) => jwks.listen(portaJwks, '127.0.0.1', ok));
const portaPainel = await porta();

const painel = spawn(process.execPath, [path.join(AQUI, 'server.js')], {
  cwd: AQUI,
  env: {
    ...process.env,
    DGCLAW_PANEL_PORT: String(portaPainel),
    DGCLAW_PANEL_HOST: '127.0.0.1',
    DGCLAW_PANEL_PASSWORD: 'senha-do-teste',
    DGCLAW_PANEL_CF_ACCESS_AUD: AUD,
    DGCLAW_PANEL_CF_TEAM: TEAM,
    DGCLAW_PANEL_CF_EMAILS: `outro@exemplo.com, ${EMAIL.toUpperCase()}`,
    DGCLAW_PANEL_CF_CERTS_URL: `http://127.0.0.1:${portaJwks}/cdn-cgi/access/certs`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saida = '';
painel.stdout.on('data', (d) => { saida += d; });
painel.stderr.on('data', (d) => { saida += d; });

const URL_API = `http://127.0.0.1:${portaPainel}/api/agents`;
let noAr = false;
for (let i = 0; i < 100 && !noAr; i++) {
  try { await fetch(URL_API); noAr = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
if (!noAr) {
  console.error(`O painel não subiu em 10 s na porta ${portaPainel}. Saída dele:\n${saida}`);
  painel.kill(); jwks.close();
  process.exit(2);
}

async function status(headers = {}) {
  const r = await fetch(URL_API, { headers, redirect: 'manual' });
  return r.status;
}

let falhas = 0;
function ok(condicao, oQue) {
  if (condicao) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}

try {
  console.log('\nO que ENTRA sem senha');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt(bom()) }) === 200, 'JWT válido no header');
  ok(await status({ Cookie: `CF_Authorization=${jwt(bom())}` }) === 200, 'JWT válido no cookie CF_Authorization');

  console.log('\nO que cai na senha (401)');
  ok(await status() === 401, 'sem JWT nenhum');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt({ ...bom(), aud: ['outro-app'] }) }) === 401, 'aud de outro app');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt({ ...bom(), email: 'intruso@exemplo.com' }) }) === 401, 'e-mail fora da lista');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt({ ...bom(), exp: agora() - 3600 }) }) === 401, 'JWT vencido');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt({ ...bom(), iss: 'https://outro.cloudflareaccess.com' }) }) === 401, 'iss de outro time');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt(bom(), { chave: outra.privateKey }) }) === 401, 'assinado por outra chave');
  ok(await status({ 'Cf-Access-Jwt-Assertion': jwt(bom(), { alg: 'HS256' }) }) === 401, 'algoritmo HS256');
  ok(await status({ 'Cf-Access-Jwt-Assertion': 'lixo.lixo' }) === 401, 'JWT malformado');

  console.log('\nO erro se explica sozinho');
  await new Promise((r) => setTimeout(r, 200));
  ok(/e-mail intruso@exemplo\.com fora da lista/.test(saida), 'o log diz o motivo da recusa');
  ok(!saida.includes(jwt(bom()).split('.')[2].slice(0, 20)), 'o log não traz a assinatura do JWT');
} finally {
  painel.kill();
  jwks.close();
}

console.log(falhas ? `\n${falhas} falha(s).` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
