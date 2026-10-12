// test-auth.mjs — a porta do painel: senha, sessão, limite de tentativas, CSRF e chave de API.
//
// Duas camadas. A primeira monta o middleware de lib/auth.js num express pequeno, com
// relógio que o teste controla (vencimento de sessão sem esperar 30 dias). A segunda
// sobe o server.js de verdade numa porta livre, com pasta temporária, para conferir a
// fiação: modo trancado, Bearer no cofre, recusa em /api/chaves-api, cabeçalhos.
// Nada aqui toca um agente real, e todo valor abaixo é falso de propósito.
// `node test-auth.mjs` na pasta do painel (precisa do `npm i` feito).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const express = require('express');
const cookieParser = require('cookie-parser');
const { buildAuth, gerarHash, conferirHash, lerHash, lerSenhaConfigurada } = require('./lib/auth.js');
const { buildChavesApi } = require('./lib/chaves-api.js');

let falhas = 0;
function ok(condicao, oQue) {
  if (condicao) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-teste-'));
// Valores falsos de teste. Ficam em constantes para o corpo dos testes ler como prosa.
const CERTA = 'senha-de-teste-bem-longa';
const OUTRA = 'outra-senha-de-teste-longa';
const ERRADA = 'errada-errada-errada';
const CURTA = 'curtinha';
const ADMIN = 'admin';
const SEGREDO_PROXY = 'segredo-do-proxy-de-teste';
const OUTRO_SITE = 'https://site-do-mal.exemplo.com';
// Uma chave de API com o formato certo (dgc_ + 32 caracteres) que nunca foi criada.
const CHAVE_INEXISTENTE = `dgc_${'0'.repeat(32)}`;

// O cabeçalho de chave de API, num lugar só.
function bearerDe(chave) {
  return { Authorization: `Bearer ${chave}` };
}

// ─── Hash scrypt ─────────────────────────────────────────────────────────────
console.log('\nHash scrypt da senha');
const hash = await gerarHash(CERTA);
ok(/^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/.test(hash), 'a linha tem o formato scrypt$N$r$p$sal$hash');
ok((await gerarHash(CERTA)) !== hash, 'duas gerações da mesma senha dão linhas diferentes (sal aleatório)');
ok(await conferirHash(CERTA, hash), 'a senha certa confere');
ok(!(await conferirHash(OUTRA, hash)), 'a senha errada não confere');
ok(!(await conferirHash(CERTA, 'scrypt$16384$8$1$curto$curto')), 'linha com sal e hash minúsculos é recusada');
ok(lerHash('scrypt$1073741824$8$1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') === null, 'N absurdo (2^30) é recusado antes de travar o painel');
ok(lerHash('md5$1$2$3$a$b') === null, 'outro algoritmo é recusado');

console.log('\nModos de senha');
const modo = (env) => lerSenhaConfigurada(env);
ok(modo({}).modo === 'trancado', 'sem nenhuma senha: trancado');
ok(modo({ DGCLAW_PANEL_PASSWORD: ADMIN }).modo === 'trancado', 'senha "admin": trancado');
ok(modo({ DGCLAW_PANEL_PASSWORD: '   ' }).modo === 'trancado', 'senha só de espaços: trancado');
ok(modo({ DGCLAW_PANEL_PASSWORD_HASH: 'lixo' }).modo === 'trancado', 'hash malformado: trancado, com motivo');
ok(modo({ DGCLAW_PANEL_PASSWORD_HASH: hash }).modo === 'hash', 'hash válido: modo hash');
ok(modo({ DGCLAW_PANEL_PASSWORD_HASH: hash, DGCLAW_PANEL_PASSWORD: ERRADA }).modo === 'hash', 'hash vence a senha em texto');
{
  const c = modo({ DGCLAW_PANEL_PASSWORD: CURTA });
  ok(c.modo === 'texto' && c.curta === true, 'texto com menos de 12 caracteres: NÃO tranca, marca como curta');
  ok(modo({ DGCLAW_PANEL_PASSWORD: CERTA }).curta === false, 'texto com 12 ou mais: sem aviso');
}

// ─── O middleware, num express pequeno ───────────────────────────────────────
let agora = Date.now();
const logs = [];

async function montar(env, { chaves } = {}) {
  const auth = buildAuth({
    env, authSalt: 'sal-de-teste', base: '', chavesApi: chaves,
    agora: () => agora, log: (...a) => logs.push(a.join(' ')),
    renderLogin: (req, res, o) => res.status(o.status || 200).type('html').send(`login:${o.erro || ''}:${o.min || ''}`),
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(auth.cabecalhos);
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.post('/login', (req, res, next) => auth.login(req, res).catch(next));
  app.use(auth.requireAuth);
  app.use(auth.csrf);
  app.all('/api/ping', (req, res) => res.json({ ok: true, quem: req.dgclawAuth }));
  app.all('/api/chaves-api', (req, res) => res.json({ ok: true }));
  const srv = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { auth, url, fechar: () => srv.close() };
}

// O formulário de login: senha, usuário opcional e cabeçalhos extras (Accept json, por exemplo).
function formulario(senha, usuario, extra) {
  const campos = new URLSearchParams();
  campos.set('password', senha);
  if (usuario !== undefined) campos.set('user', usuario);
  return {
    method: 'POST', redirect: 'manual', body: campos.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(extra || {}) },
  };
}
function cookieDe(r) { return (r.headers.get('set-cookie') || '').split(';')[0]; }

console.log('\nLogin com hash, sessão assinada e validade');
{
  const m = await montar({ DGCLAW_PANEL_PASSWORD_HASH: hash });
  const errado = await fetch(`${m.url}/login`, formulario(ERRADA));
  ok(errado.status === 302 && /error=1/.test(errado.headers.get('location')) && !cookieDe(errado), 'senha errada: volta ao login sem cookie');
  const certo = await fetch(`${m.url}/login`, formulario(CERTA));
  const cookie = cookieDe(certo);
  ok(certo.status === 302 && cookie.startsWith('dash_token=v1.'), 'senha certa: cookie no formato v1.<expira>.<hmac>');
  const flags = certo.headers.get('set-cookie') || '';
  ok(/HttpOnly/i.test(flags) && /SameSite=Lax/i.test(flags), 'cookie é httpOnly e sameSite lax');
  ok(!/Secure/i.test(flags), 'sem proxy dizendo https, o cookie não leva Secure (senão o navegador o descartaria)');
  const https = await fetch(`${m.url}/login`, formulario(CERTA, undefined, { 'X-Forwarded-Proto': 'https' }));
  ok(/Secure/i.test(https.headers.get('set-cookie') || ''), 'com X-Forwarded-Proto https vindo do loopback, o cookie leva Secure');
  const maxAge = /Max-Age=(\d+)/i.exec(flags);
  ok(maxAge && Number(maxAge[1]) === 30 * 24 * 3600, 'o cookie vale 30 dias');

  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: cookie } })).status === 200, 'o cookie abre a API');
  ok((await fetch(`${m.url}/api/ping`)).status === 401, 'sem cookie: 401');

  const [v, exp, ass] = cookie.replace('dash_token=', '').split('.');
  const adulterado = `dash_token=${v}.${Number(exp) + 86400000}.${ass}`;
  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: adulterado } })).status === 401, 'validade estendida à mão invalida a assinatura');
  const assErrada = `dash_token=${v}.${exp}.${ass.slice(0, -2)}AA`;
  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: assErrada } })).status === 401, 'assinatura errada é recusada');
  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: 'dash_token=v1.1.x' } })).status === 401, 'token mal formado é recusado');

  agora += 30 * 24 * 3600 * 1000 + 1000;
  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: cookie } })).status === 401, 'passados 30 dias, o token vence NO SERVIDOR');
  agora = Date.now();

  const outro = await montar({ DGCLAW_PANEL_PASSWORD_HASH: await gerarHash(OUTRA) });
  ok((await fetch(`${outro.url}/api/ping`, { headers: { Cookie: cookie } })).status === 401, 'trocar a senha invalida as sessões que já existiam');
  outro.fechar();

  const semHeader = await fetch(`${m.url}/api/ping`);
  ok(semHeader.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  ok(semHeader.headers.get('referrer-policy') === 'same-origin', 'Referrer-Policy: same-origin');
  ok(!semHeader.headers.get('x-frame-options') && !/frame-ancestors/.test(semHeader.headers.get('content-security-policy') || ''), 'sem X-Frame-Options nem frame-ancestors (o painel abre em fachada)');
  m.fechar();
}

console.log('\nSenha em texto (compatibilidade) e usuário opcional');
{
  const m = await montar({ DGCLAW_PANEL_PASSWORD: CERTA });
  ok(cookieDe(await fetch(`${m.url}/login`, formulario(CERTA))).startsWith('dash_token='), 'senha em texto continua entrando');
  m.fechar();
  const u = await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_USER: 'dono' });
  ok(!cookieDe(await fetch(`${u.url}/login`, formulario(CERTA))), 'com usuário definido, senha sem usuário não entra');
  ok(!cookieDe(await fetch(`${u.url}/login`, formulario(CERTA, 'intruso'))), 'usuário errado não entra');
  ok(!cookieDe(await fetch(`${u.url}/login`, formulario(ERRADA, 'dono'))), 'usuário certo e senha errada não entra');
  ok(cookieDe(await fetch(`${u.url}/login`, formulario(CERTA, 'dono'))).startsWith('dash_token='), 'usuário e senha certos entram');
  ok(logs.every((l) => !l.includes(CERTA) && !l.includes(ERRADA) && !l.includes('intruso')), 'o log de falha não traz a senha nem o usuário digitados');
  u.fechar();
}

console.log('\nModo trancado');
{
  logs.length = 0;
  const m = await montar({});
  ok(m.auth.trancado, 'sem senha o painel sobe trancado');
  ok(logs.length === 1 && /TRANCADO/.test(logs[0]) && /senha-hash\.js/.test(logs[0]) && /DGCLAW_PANEL_PASSWORD_HASH/.test(logs[0]), 'loga UMA vez, em português, o que falta e como resolver');
  const api = await fetch(`${m.url}/api/ping`);
  const corpo = await api.json();
  ok(api.status === 503 && corpo.error && corpo.howToFix, 'a API responde 503 com error e howToFix');
  const login = await fetch(`${m.url}/login`, formulario(ADMIN, undefined, { Accept: 'application/json' }));
  ok(login.status === 503, 'o POST /login recusa (503), nem com "admin" entra');
  ok(!cookieDe(login), 'e não entrega cookie');
  m.fechar();
  const admin = await montar({ DGCLAW_PANEL_PASSWORD: ADMIN });
  ok((await fetch(`${admin.url}/api/ping`)).status === 503, 'senha "admin" também tranca (some o default silencioso)');
  admin.fechar();
}

console.log('\nLimite de tentativas');
{
  const m = await montar({ DGCLAW_PANEL_PASSWORD: CERTA });
  let ultimo;
  for (let i = 0; i < 10; i++) ultimo = await fetch(`${m.url}/login`, formulario(`errada-numero-${i}-longa`));
  ok(ultimo.status === 302, 'as 10 primeiras falhas ainda respondem como senha errada');
  const bloqueado = await fetch(`${m.url}/login`, formulario('errada-numero-11-longa'));
  ok(bloqueado.status === 429 && /bloqueado:15/.test(await bloqueado.text()), 'a 11ª tentativa leva 429 e diz quantos minutos esperar');
  const certaBloqueada = await fetch(`${m.url}/login`, formulario(CERTA));
  ok(certaBloqueada.status === 429 && !cookieDe(certaBloqueada), 'bloqueado, nem a senha certa entra');
  const json = await fetch(`${m.url}/login`, formulario(CERTA, undefined, { Accept: 'application/json' }));
  ok(/Muitas tentativas erradas\. Espere 15 minutos\./.test((await json.json()).error), 'mensagem: "Muitas tentativas erradas. Espere N minutos."');
  agora += 16 * 60 * 1000;
  ok(cookieDe(await fetch(`${m.url}/login`, formulario(CERTA))).startsWith('dash_token='), 'passada a janela de 15 minutos, volta a entrar');
  agora = Date.now();
  m.fechar();
}

console.log('\nChave de API (Bearer) e CSRF');
{
  const chaves = buildChavesApi({ agentDir: RAIZ, chavesApiArquivo: path.join(RAIZ, 'chaves-ui.json'), agora: () => agora });
  const criada = chaves.criar({ nome: 'Admin de teste', quem: 'Dono de teste' });
  const m = await montar({ DGCLAW_PANEL_PASSWORD: CERTA }, { chaves });
  const cookie = cookieDe(await fetch(`${m.url}/login`, formulario(CERTA)));
  const bearer = bearerDe(criada.token);

  const viaChave = await fetch(`${m.url}/api/ping`, { headers: bearer });
  const quem = (await viaChave.json()).quem;
  ok(viaChave.status === 200 && quem.tipo === 'chave-api' && quem.nome === 'Admin de teste', 'Bearer válido entra na API e marca req.dgclawAuth');
  const g = await fetch(`${m.url}/api/chaves-api`, { headers: bearer });
  const gc = await g.json();
  ok(g.status === 403 && gc.error && gc.howToFix, 'Bearer em /api/chaves-api é recusado (403) com motivo: nenhuma chave gerencia chaves');
  ok((await fetch(`${m.url}/api/chaves-api`, { method: 'POST', headers: bearer })).status === 403, 'nem para criar');
  ok((await fetch(`${m.url}/api/chaves-api`, { headers: { Cookie: cookie } })).status === 200, 'o cookie (a pessoa) gerencia chaves normalmente');
  ok((await fetch(`${m.url}/api/ping`, { headers: bearerDe(CHAVE_INEXISTENTE) })).status === 401, 'Bearer desconhecido: 401');
  ok((await fetch(`${m.url}/api/ping`, { headers: bearerDe('lixo') })).status === 401, 'Bearer sem o formato dgc_: 401');
  ok((await fetch(`${m.url}/api/ping`, { headers: { ...bearer, Cookie: 'dash_token=lixo' } })).status === 200, 'o Bearer não depende do cookie');
  chaves.revogar(criada.id, 'Dono de teste');
  ok((await fetch(`${m.url}/api/ping`, { headers: bearer })).status === 401, 'chave revogada: 401');

  const doOutroSite = await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, Origin: OUTRO_SITE } });
  const cc = await doOutroSite.json();
  ok(doOutroSite.status === 403 && cc.error && cc.howToFix, 'POST por cookie com Origin de outro site: 403 com motivo');
  ok((await fetch(`${m.url}/api/ping`, { method: 'DELETE', headers: { Cookie: cookie, Origin: OUTRO_SITE } })).status === 403, 'DELETE também');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, Origin: 'null' } })).status === 403, 'Origin "null" também');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, Origin: m.url } })).status === 200, 'Origin igual ao Host: passa');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie } })).status === 200, 'sem Origin (curl, script): passa');
  ok((await fetch(`${m.url}/api/ping`, { headers: { Cookie: cookie, Origin: OUTRO_SITE } })).status === 200, 'GET não é checado');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status === 403, 'sem Origin mas com Sec-Fetch-Site cross-site: 403');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: m.url } })).status === 200, 'Sec-Fetch-Site same-origin: passa');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://painel.exemplo.com', 'X-Forwarded-Host': 'painel.exemplo.com' } })).status === 200, 'Origin igual ao X-Forwarded-Host vindo do proxy local: passa');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { Cookie: cookie, Origin: OUTRO_SITE, 'X-Forwarded-Host': 'painel.exemplo.com' } })).status === 403, 'X-Forwarded-Host não abre a porta para Origin diferente dele');
  const nova = chaves.criar({ nome: 'Outra', quem: 'x' });
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { ...bearerDe(nova.token), Origin: OUTRO_SITE } })).status === 200, 'Bearer não passa pela checagem de Origin');
  m.fechar();
}

console.log('\nSegredo do proxy (DG Claw Web)');
{
  const arq = path.join(RAIZ, 'proxy.segredo');
  fs.writeFileSync(arq, `${SEGREDO_PROXY}\n`, { mode: 0o600 });
  fs.chmodSync(arq, 0o600);
  const m = await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET_FILE: arq });
  const com = (h) => fetch(`${m.url}/api/chaves-api`, { headers: h });
  ok((await com({ 'X-DGClaw-Proxy': SEGREDO_PROXY })).status === 200, 'cabeçalho certo entra (e alcança /api/chaves-api, porque é o dono)');
  const ping = await (await fetch(`${m.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': SEGREDO_PROXY, 'X-DGClaw-Usuario': 'Fulana' } })).json();
  ok(ping.quem.tipo === 'proxy' && ping.quem.usuario === 'Fulana', 'o usuário que o proxy informou fica em req.dgclawAuth');
  ok((await fetch(`${m.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': SEGREDO_PROXY } }).then((r) => r.json())).quem.usuario === 'Dono', 'sem X-DGClaw-Usuario, o usuário é "Dono"');
  ok((await com({ 'X-DGClaw-Proxy': 'segredo-errado-de-teste' })).status === 401, 'cabeçalho errado cai no login (401)');
  ok((await com({})).status === 401, 'cabeçalho ausente cai no login (401)');
  ok((await com({ 'X-DGClaw-Proxy': '' })).status === 401, 'cabeçalho vazio cai no login');
  ok((await fetch(`${m.url}/api/ping`, { method: 'POST', headers: { 'X-DGClaw-Proxy': SEGREDO_PROXY, Origin: OUTRO_SITE } })).status === 200, 'pelo proxy a checagem de Origin é pulada (o proxy faz)');
  m.fechar();

  const vazio = path.join(RAIZ, 'proxy.vazio');
  fs.writeFileSync(vazio, '\n', { mode: 0o600 });
  const v = await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET_FILE: vazio });
  ok((await fetch(`${v.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': '' } })).status === 401, 'segredo vazio nunca libera, nem com cabeçalho vazio');
  ok((await fetch(`${v.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': ' ' } })).status === 401, 'nem com cabeçalho de espaço');
  v.fechar();
  const semNada = await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET: '' });
  ok((await fetch(`${semNada.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': '' } })).status === 401, 'variável vazia nunca libera');
  semNada.fechar();
  const porVar = await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET: 'segredo-por-variavel-teste' });
  ok((await fetch(`${porVar.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': 'segredo-por-variavel-teste' } })).status === 200, 'o segredo também pode vir por variável de ambiente');
  porVar.fechar();

  const aberto = path.join(RAIZ, 'proxy.aberto');
  fs.writeFileSync(aberto, `${SEGREDO_PROXY}\n`);
  fs.chmodSync(aberto, 0o644);
  let erro = '';
  try { await montar({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET_FILE: aberto }); } catch (e) { erro = e.message; }
  ok(/legível por outros/.test(erro) && /chmod 600/.test(erro), 'arquivo do segredo legível por outros: recusa subir, explicando e dizendo o chmod');

  // Trancado (sem senha) desliga só a senha: o proxy e a chave de API continuam valendo.
  const t = await montar({ DGCLAW_PANEL_PROXY_SECRET_FILE: arq });
  ok(t.auth.trancado, 'sem senha, mas com segredo do proxy: o painel sobe trancado para senha');
  ok((await fetch(`${t.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': SEGREDO_PROXY } })).status === 200, 'trancado: o proxy com o segredo certo entra');
  ok((await fetch(`${t.url}/api/ping`, { headers: { 'X-DGClaw-Proxy': 'segredo-errado-de-teste' } })).status === 503, 'trancado: segredo errado leva 503 com o motivo');
  ok((await fetch(`${t.url}/api/ping`)).status === 503, 'trancado: sem credencial nenhuma, 503');
  t.fechar();
}

// ─── O painel de verdade ─────────────────────────────────────────────────────
async function porta() {
  return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function subir(env, nome) {
  const pasta = path.join(RAIZ, nome);
  fs.mkdirSync(pasta, { recursive: true });
  const cfg = path.join(pasta, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    agentName: 'Agente de Teste', agentSlug: 'teste', agentDir: pasta, authSalt: 'sal-de-teste',
    creatorName: 'Dono de Teste',
    cofreDir: path.join(pasta, 'cofre'), cofreChaveMestra: path.join(pasta, 'cofre.chave'),
    cofreRuntimeDir: path.join(pasta, 'run'),
    // Unidade que não existe: o "aplicar" do teste falha sem reiniciar nada de verdade.
    cofreUnidade: 'dgclaw-teste-que-nao-existe-000',
  }));
  const p = await porta();
  const proc = spawn(process.execPath, [path.join(AQUI, 'server.js')], {
    cwd: AQUI,
    env: {
      ...process.env,
      DGCLAW_PANEL_PASSWORD: '', DGCLAW_PANEL_PASSWORD_HASH: '', DGCLAW_PANEL_USER: '',
      DGCLAW_PANEL_PROXY_SECRET: '', DGCLAW_PANEL_PROXY_SECRET_FILE: '',
      DGCLAW_PANEL_CONFIG: cfg, DGCLAW_PANEL_PORT: String(p), DGCLAW_PANEL_HOST: '127.0.0.1', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const painel = { url: `http://127.0.0.1:${p}`, saida: '', proc, pasta, fechar: () => proc.kill() };
  proc.stdout.on('data', (d) => { painel.saida += d; });
  proc.stderr.on('data', (d) => { painel.saida += d; });
  for (let i = 0; i < 100 && !/rodando|NÃO SUBI/.test(painel.saida); i++) await new Promise((r) => setTimeout(r, 100));
  return painel;
}

console.log('\nO server.js de verdade: modo trancado');
{
  const p = await subir({}, 'trancado');
  ok(/TRANCADO/.test(p.saida), 'o log de subida diz que está trancado');
  const api = await fetch(`${p.url}/api/cofre`);
  ok(api.status === 503 && (await api.json()).howToFix, '/api/cofre responde 503 com howToFix');
  const pagina = await (await fetch(`${p.url}/login.html`)).text();
  ok(pagina.includes('data-modo="trancado"') && pagina.includes('Este painel não tem senha configurada.') && pagina.includes('senha-hash.js'), 'a tela de login mostra a explicação no lugar do formulário');
  ok(!pagina.includes('{{LOGIN_'), 'nenhum marcador ficou sem trocar');
  const post = await fetch(`${p.url}/login`, formulario(ADMIN));
  ok(post.status === 503 && !cookieDe(post), 'POST /login recusa');
  p.fechar();
}

console.log('\nO server.js de verdade: segredo do proxy legível por outros');
{
  const aberto = path.join(RAIZ, 'segredo-aberto');
  fs.writeFileSync(aberto, SEGREDO_PROXY);
  fs.chmodSync(aberto, 0o644);
  const p = await subir({ DGCLAW_PANEL_PASSWORD: CERTA, DGCLAW_PANEL_PROXY_SECRET_FILE: aberto }, 'proxy-aberto');
  await new Promise((r) => (p.proc.exitCode !== null ? r() : p.proc.once('exit', r)));
  ok(/NÃO SUBI/.test(p.saida) && /chmod 600/.test(p.saida) && p.proc.exitCode === 1, 'o painel não sobe (saída 1) e diz como consertar');
}

console.log('\nO server.js de verdade: cofre por chave de API');
{
  const p = await subir({ DGCLAW_PANEL_PASSWORD_HASH: hash, DGCLAW_PANEL_USER: 'dono' }, 'normal');
  const pagina = await (await fetch(`${p.url}/login.html`)).text();
  ok(pagina.includes('data-modo="usuario"'), 'com DGCLAW_PANEL_USER a tela pede usuário');
  ok(!cookieDe(await fetch(`${p.url}/login`, formulario(CERTA))), 'senha certa sem usuário não entra');
  const cookie = cookieDe(await fetch(`${p.url}/login`, formulario(CERTA, 'dono')));
  ok(cookie.startsWith('dash_token=v1.'), 'usuário e senha certos entram');
  const json = { 'Content-Type': 'application/json' };
  const cabecalho = (await fetch(`${p.url}/api/cofre`, { headers: { Cookie: cookie } })).headers;
  ok(cabecalho.get('x-content-type-options') === 'nosniff' && cabecalho.get('referrer-policy') === 'same-origin', 'cabeçalhos de segurança no painel real');

  const criar = await fetch(`${p.url}/api/chaves-api`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ nome: 'Admin' }) });
  const nova = await criar.json();
  ok(criar.status === 200 && /^dgc_[\w-]{43}$/.test(nova.token) && nova.id && nova.aviso, 'POST /api/chaves-api devolve id, token (uma vez) e aviso');
  const lista = await (await fetch(`${p.url}/api/chaves-api`, { headers: { Cookie: cookie } })).json();
  const textoLista = JSON.stringify(lista);
  ok(lista.chaves.length === 1 && !textoLista.includes(nova.token) && !/hash/.test(textoLista), 'a lista não traz token nem hash');
  const arquivoChaves = path.join(p.pasta, '.dgclaw', 'panel', 'chaves-api.json');
  ok(!fs.readFileSync(arquivoChaves, 'utf8').includes(nova.token), 'o arquivo guarda só o hash, nunca o token');
  ok((fs.statSync(arquivoChaves).mode & 0o777) === 0o600, 'o arquivo das chaves é modo 600');

  const bearer = bearerDe(nova.token);
  const VALOR = 'sk-teste-000000000000';
  const VALOR_XAI = 'xai-teste-000000000000';
  const guarda = await fetch(`${p.url}/api/cofre`, { method: 'POST', headers: { ...json, ...bearer }, body: JSON.stringify({ envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' }) });
  const gj = await guarda.json();
  ok(guarda.status === 200 && gj.ok && gj.ultimos4 === '0000', 'Bearer guarda uma chave no cofre');
  ok(!JSON.stringify(gj).includes(VALOR), 'a resposta do POST não traz o valor');
  const estado = await (await fetch(`${p.url}/api/cofre`, { headers: { Cookie: cookie } })).text();
  const reg = JSON.parse(estado).chaves.find((c) => c.envName === 'OPENAI_API_KEY');
  ok(!estado.includes(VALOR), 'GET /api/cofre não traz o valor');
  ok(reg.cadastradaPor === 'Admin (por API)' && reg.origem === 'api', 'o registro diz "Admin (por API)" e origem api');
  const pelaTela = await fetch(`${p.url}/api/cofre`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify({ envName: 'GEMINI_API_KEY', valor: 'chave-teste-000000000000', provedor: 'google' }) });
  const regTela = (await (await fetch(`${p.url}/api/cofre`, { headers: { Cookie: cookie } })).json()).chaves.find((c) => c.envName === 'GEMINI_API_KEY');
  ok(pelaTela.status === 200 && regTela.origem === 'tela' && regTela.cadastradaPor === 'Dono de Teste', 'pela tela: origem tela e o nome do dono');

  const comAplicar = await fetch(`${p.url}/api/cofre`, { method: 'POST', headers: { ...json, ...bearer }, body: JSON.stringify({ envName: 'XAI_API_KEY', valor: VALOR_XAI, provedor: 'xai', aplicar: true }) });
  const ca = await comAplicar.json();
  ok(comAplicar.status >= 400 && ca.guardado && ca.guardado.ok && ca.aplicado && ca.aplicado.ok === false && /guardada/.test(ca.error), 'aplicar:true com reinício impossível: diz que guardou E que não reiniciou, com status de erro');
  const depois = (await (await fetch(`${p.url}/api/cofre`, { headers: { Cookie: cookie } })).json()).chaves.map((c) => c.envName);
  ok(depois.includes('XAI_API_KEY'), 'e a chave continua guardada');

  const recusaNome = await fetch(`${p.url}/api/cofre`, { method: 'POST', headers: { ...json, ...bearer }, body: JSON.stringify({ envName: 'NODE_OPTIONS', valor: VALOR, aplicar: true }) });
  const rn = await recusaNome.json();
  ok(recusaNome.status === 400 && rn.error && !JSON.stringify(rn).includes(VALOR) && !rn.aplicado, 'nome recusado volta o motivo do painel e não tenta aplicar');

  ok((await fetch(`${p.url}/api/chaves-api`, { headers: bearer })).status === 403, 'Bearer não lista chaves de API');
  ok((await fetch(`${p.url}/api/chaves-api?id=${nova.id}`, { method: 'DELETE', headers: bearer })).status === 403, 'Bearer não revoga chaves de API');
  const cors = await fetch(`${p.url}/api/cofre`, { method: 'POST', headers: { ...json, Cookie: cookie, Origin: OUTRO_SITE }, body: JSON.stringify({ envName: 'AAA_API_KEY', valor: VALOR }) });
  ok(cors.status === 403, 'o cofre por cookie recusa Origin de outro site');

  const vazamento = [estado, textoLista, p.saida, JSON.stringify(ca)].some((t) => t.includes(VALOR) || t.includes(VALOR_XAI));
  ok(!vazamento, 'nenhum valor guardado aparece em resposta de estado, lista nem no log do painel');

  const revoga = await fetch(`${p.url}/api/chaves-api?id=${nova.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  ok(revoga.status === 200, 'a pessoa revoga a chave de API pelo cookie');
  ok((await fetch(`${p.url}/api/cofre`, { headers: bearer })).status === 401, 'revogada, o Bearer deixa de entrar');
  const aposRevogar = (await (await fetch(`${p.url}/api/chaves-api`, { headers: { Cookie: cookie } })).json()).chaves[0];
  ok(aposRevogar && aposRevogar.revogadaEm, 'revogar é datar: o registro continua na lista, com a data');
  p.fechar();
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s).` : '\nTUDO CERTO');
process.exit(falhas ? 1 : 0);
