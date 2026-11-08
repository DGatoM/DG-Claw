// test-xss-trust-level.mjs: valores vindos da memória do agente não viram HTML no painel.
//
// Cobre (1) a rota /api/followers/top, que normaliza o trust_level; (2) o desenho do cartão do
// dono em app.js, executado de verdade com um valor malicioso; (3) checagens estáticas que
// falham se o trust_level voltar cru para o innerHTML ou se voltar a haver interpolação sem
// escape de e.message, m.mode e dos participantes de reunião.
// `node test-xss-trust-level.mjs` na pasta do painel.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
let falhas = 0;
function ok(c, o, extra) { if (c) console.log(`  ok   ${o}`); else { console.log(`  FALHOU  ${o}${extra !== undefined ? `\n         ${JSON.stringify(extra)}` : ''}`); falhas++; } }

const MAL = '<img src=x onerror=alert(1)>';

console.log('\nServidor: normalização do trust_level');
const instagram = require('./rotas/instagram.js');
const nt = instagram.normalizarTrustLevel;
ok(nt(95) === 95 && nt('80') === 80 && nt(95.6) === 96, 'número e texto numérico passam');
ok(nt(MAL) === null && nt({}) === null && nt([]) === null && nt(null) === null && nt(undefined) === null && nt(NaN) === null && nt(Infinity) === null && nt('') === null, 'o que não é número vira null');
ok(nt(-5) === 0 && nt(5000) === 100, 'preso à faixa 0 a 100');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'xss-trust-'));
const arq = path.join(raiz, 'relationships.json');
fs.writeFileSync(arq, JSON.stringify({ relationships: {
  dono: { trust_level: MAL, dynamic: 'x' },
  top_followers: { ana: { tier: 'close', trust_level: MAL }, bia: { tier: 'regular', trust_level: 70 } },
} }));
const rotas = {};
const router = { get: (url, _mw, fn) => { rotas[url] = fn; } };
instagram(router, { CONFIG: { creatorKey: 'dono' }, P: { RELATIONSHIPS_FILE: arq }, TZ: 'UTC', requirePower: () => (q, r, n) => n() });
let corpo;
rotas['/api/followers/top']({ query: {} }, { json: (x) => { corpo = x; } });
ok(corpo && corpo.owner && corpo.owner.trust_level === null && corpo.agent_owner.trust_level === null, 'dono com trust_level malicioso sai null', corpo && corpo.owner);
const ana = corpo.top_followers.find((f) => f.username === 'ana');
const bia = corpo.top_followers.find((f) => f.username === 'bia');
ok(ana.trust_level === null && bia.trust_level === 70, 'seguidores: malicioso null, válido preservado');
ok(ana.tier === 'close' && corpo.owner.dynamic === 'x', 'os outros campos seguem intactos');
fs.rmSync(raiz, { recursive: true, force: true });

console.log('\nTela: desenho do cartão do dono, executado de verdade');
const src = fs.readFileSync(new URL('./public/js/app.js', import.meta.url), 'utf-8');
function extrair(nome) {
  const i = src.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error(`não achei function ${nome} em app.js`);
  let fim = src.indexOf('\n}\n', i);
  return src.slice(i, fim + 3);
}
const grid = { innerHTML: '' };
const ctx = { APP_CONFIG: { creatorName: 'Dono' }, document: { getElementById: () => grid } };
vm.createContext(ctx);
vm.runInContext([extrair('escapeHtml'), extrair('numeroSeguro'), extrair('renderFollowers')].join('\n'), ctx);
vm.runInContext(`renderFollowers({ agent_owner: { trust_level: ${JSON.stringify(MAL)}, dynamic: ${JSON.stringify(MAL)} }, top_followers: [] })`, ctx);
ok(!grid.innerHTML.includes('<img') && grid.innerHTML.includes('Trust: 95%'), 'trust_level malicioso não vira tag e cai no padrão 95', grid.innerHTML);
vm.runInContext('renderFollowers({ agent_owner: { trust_level: 70 }, top_followers: [] })', ctx);
ok(grid.innerHTML.includes('Trust: 70%'), 'trust_level numérico segue aparecendo igual');
ok(vm.runInContext('escapeHtml(\'a"b\\\'c<\')', ctx) === 'a&quot;b&#39;c&lt;', 'escapeHtml escapa aspas (uso em atributo)');

console.log('\nChecagem estática de app.js');
ok(!/\$\{[^}]*trust_level[^}]*\}/.test(src) || /\$\{numeroSeguro\([^}]*trust_level/.test(src), 'trust_level só entra em template via numeroSeguro');
ok(!/\$\{\s*d\.trust_level\s*(\|\||\})/.test(src), 'não há ${d.trust_level} cru');
// (a linha `falha = ...` passa por escapeHtml(falha) antes de ir para a tela)
ok(!src.split('\n').some((l) => /\$\{\s*e\.message\s*\}/.test(l) && !/falha =/.test(l)), 'e.message nunca vai cru para um template');
ok(!/\$\{\s*m\.mode\b[^}]*\}/.test(src.replace(/\$\{escapeHtml\(m\.mode[^}]*\}\)?\}/g, '')), 'm.mode sempre escapado');
ok(!/\(m\.participants \|\| \[\]\)\.join\(', '\)\}/.test(src), 'participantes da reunião sempre escapados');
ok(!/onclick="[a-zA-Z]+\('\$\{/.test(src), 'nenhum onclick monta JS com valor interpolado');

console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
