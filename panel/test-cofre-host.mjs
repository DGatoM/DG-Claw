// test-cofre-host.mjs — o modo "host" do cofre (DG Claw v1): o painel de dentro só LÊ os nomes.
//
// Neste modo quem guarda a chave é o DG Claw Web, no host. O painel recusa tudo o que escreve e
// NÃO PODE deixar rastro em disco: nem pasta de cofre, nem chave mestra, nem arquivo de segredo
// (foi o que uma versão anterior fez, e o agente conseguia decifrar). Roda numa pasta temporária.
//
// `node test-cofre-host.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(new URL(import.meta.url).pathname);
const { buildCofre } = require('./lib/cofre.js');
const registrar = require('./lib/provedores.js');

let falhas = 0;
const ok = (cond, oQue) => { console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`); if (!cond) falhas++; };

const logs = [];
console.error = (...a) => { logs.push(a.map((x) => String(x)).join(' ')); };

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-host-'));
const AGENTE = path.join(RAIZ, 'home-agente');
fs.mkdirSync(AGENTE);
const NOMES = path.join(RAIZ, 'cofre-nomes');
const VALOR = 'valor-de-teste-que-nao-pode-vazar-123456';
const config = { agentSlug: 'teste', agentName: 'Agente de Teste', agentDir: AGENTE, creatorName: 'Dono de Teste', cofreNomesArquivo: NOMES };

function arvore(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p); if (e.isDirectory()) out.push(...arvore(p));
  }
  return out;
}

console.log('\nNada é criado em disco');
const antes = arvore(RAIZ);
const cofre = buildCofre(config);
ok(cofre.modoHost === true, 'o config.cofreNomesArquivo liga o modo host');
ok(JSON.stringify(arvore(RAIZ)) === JSON.stringify(antes), 'buildCofre não criou pasta nem arquivo (sem chave mestra, sem pasta de cofre)');
ok(!fs.existsSync(path.join(AGENTE, '.dgclaw')), 'a casa do agente continua sem .dgclaw/cofre nem cofre.chave');

console.log('\nOs nomes vêm do arquivo');
{
  const e0 = cofre.estado();
  ok(Array.isArray(e0.chaves) && e0.chaves.length === 0, 'arquivo ausente: nenhuma chave, sem erro');
  ok(cofre.tem('OPENAI_API_KEY') === false, 'tem() é falso sem o arquivo');
  fs.writeFileSync(NOMES, '# comentário\nOPENAI_API_KEY=\nGEMINI_API_KEY=\n\nlinha-estranha\n');
  const e = cofre.estado();
  ok(e.chaves.map((c) => c.envName).join(',') === 'OPENAI_API_KEY,GEMINI_API_KEY', 'estado().chaves traz os nomes do arquivo, na ordem');
  ok(e.chaves.every((c) => c.ultimos4 === '' && c.cadastradaPor === 'DG Claw Web' && c.revogadaEm === null), 'ultimos4 vazio, cadastradaPor "DG Claw Web", ativas');
  ok(e.guarda.motor === 'host' && /fora da pasta do agente/.test(e.guarda.motorExplicacao), 'guarda.motor é host, com a explicação');
  ok(e.aplicar.pode === false && e.aplicar.motivo && e.aplicar.howToFix, 'aplicar.pode é falso e diz por quê');
  ok(cofre.tem('openai_api_key') === true && cofre.tem('XAI_API_KEY') === false && cofre.tem('../x') === false, 'tem() usa os nomes (normaliza a caixa, recusa nome ruim)');
  ok(e.agente.dono === 'Dono de Teste' && Array.isArray(e.provedores), 'agente e provedores no formato de sempre');
}

console.log('\nTudo o que escreve é recusado com 409');
for (const [nome, r] of [
  ['guardar', cofre.guardar({ envName: 'OPENAI_API_KEY', valor: VALOR, provedor: 'openai' })],
  ['revogar', cofre.revogar('OPENAI_API_KEY', 'Dono')],
  ['aplicar', cofre.aplicar()],
  ['materializar', cofre.materializar()],
]) {
  ok(r.status === 409 && /DG Claw Web/.test(r.erro) && /endereço do DG Claw/.test(r.howToFix) && /dgclaw agente cofre/.test(r.howToFix), `${nome}: 409 com o caminho certo em português`);
  ok(!JSON.stringify(r).includes(VALOR), `${nome}: o valor não volta na resposta`);
}
ok(JSON.stringify(arvore(RAIZ).filter((p) => p !== NOMES)) === JSON.stringify(antes), 'depois de tudo isso, nenhum arquivo ou pasta novos (só o cofre-nomes do teste)');

console.log('\nPOST /api/provedor com chave: 409, sem 500 e sem falar com o runner');
{
  let chamadas = 0;
  const srv = http.createServer((req, res) => { chamadas++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { ...config, bunkerUrl: `http://127.0.0.1:${srv.address().port}`, bunkerCard: 'teste' };
  const rotas = {}; const router = {};
  for (const m of ['get', 'post', 'delete']) router[m] = (p, h) => { rotas[`${m.toUpperCase()} ${p}`] = h; };
  registrar(router, { CONFIG: cfg, cofre, serverDir: AQUI });
  async function chamar(rota, body) {
    let status = 200; let corpo;
    const res = { status(s) { status = s; return res; }, json(o) { corpo = o; return res; } };
    await rotas[rota]({ body, query: {} }, res);
    return { status, corpo };
  }
  const r = await chamar('POST /api/provedor', { provedor: 'codex', auth: 'api', modelo: '', chave: VALOR });
  ok(r.status === 409 && r.corpo.error && r.corpo.howToFix, 'com chave: 409 {error, howToFix}');
  ok(!JSON.stringify(r).includes(VALOR) && !logs.join('\n').includes(VALOR), 'a chave não aparece na resposta nem no log');
  const r2 = await chamar('POST /api/provedor', { provedor: 'codex', auth: 'api', modelo: '' });
  ok(r2.status === 409 && /DG Claw Web/.test(r2.corpo.error), 'sem chave e modo com variável: também 409 (nada fica gravado pela metade)');
  ok(chamadas === 0, 'o runner não recebeu nenhum pedido');
  const g = await chamar('GET /api/provedor');
  ok(g.status === 200 || g.status === 503, 'GET segue funcionando (sem 500)');
  srv.closeAllConnections(); srv.close();
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo certo');
process.exit(falhas ? 1 : 0);
