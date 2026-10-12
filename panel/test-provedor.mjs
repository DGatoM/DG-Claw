// test-provedor.mjs — as rotas do bloco "Modelo e autenticação" (lib/provedores.js).
//
// Roda contra um runner FALSO (http em porta aleatória, que implementa o contrato de
// docs/PROVEDORES.md) e o cofre REAL numa pasta temporária (só o aplicar() é espiado,
// porque ele reiniciaria uma unidade de verdade). Nunca toca agente nenhum.
// O que mais importa aqui: a chave de teste NÃO aparece em resposta, em log nem no que o
// runner recebeu.
//
// AS CHAVES DE TESTE VÊM DO AMBIENTE (o guardião de segredos do ambiente de trabalho
// recusa chave escrita no código, mesmo falsa). Inventar um valor com o formato certo:
//   DGCLAW_TESTE_CHAVE_ANTHROPIC=<prefixo da Anthropic>SEGREDO-DE-TESTE-1234567890abcdef
//   DGCLAW_TESTE_CHAVE_OPENAI=<prefixo da OpenAI>SEGREDO-DE-TESTE-9876543210
// Sem elas, os blocos que precisam de chave são PULADOS, o teste avisa em voz alta e
// termina com código 3 (nunca com 0): pulado não é verde.
//
// `node test-provedor.mjs` na pasta do painel.

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
let pulados = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};
const CHAVE = process.env.DGCLAW_TESTE_CHAVE_ANTHROPIC || '';
const CHAVE_OPENAI = process.env.DGCLAW_TESTE_CHAVE_OPENAI || '';
const COM_CHAVES = !!(CHAVE && CHAVE_OPENAI && CHAVE.includes('SEGREDO-DE-TESTE') && CHAVE_OPENAI.includes('SEGREDO-DE-TESTE'));
function pular(oQue) {
  pulados++;
  console.log(`  PULADO  ${oQue} (faltam DGCLAW_TESTE_CHAVE_ANTHROPIC e DGCLAW_TESTE_CHAVE_OPENAI, ambas com SEGREDO-DE-TESTE no valor)`);
}

// ── tudo o que sai em console.error é guardado para a conferência final ──────
const logs = [];
const erroOriginal = console.error;
console.error = (...a) => { logs.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')); };

// ── o runner falso ───────────────────────────────────────────────────────────
const runner = { recebidos: [], modo: 'ok', escolha: { provedor: 'claude', auth: 'assinatura', modelo: 'claude-opus-5-5' }, extra: {} };
const srv = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (d) => { corpo += d; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    runner.recebidos.push({ metodo: req.method, caminho: url.pathname, query: url.search, corpo });
    const json = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (runner.modo === 'antigo') return json(404, {});
    if (url.pathname === '/api/provedor' && req.method === 'GET') {
      return json(200, {
        sessao: 'cardX', ...runner.escolha, rotulo: 'Claude Opus 5.5, na assinatura',
        conferido: { ok: true, metodo: 'claude auth status --json', detalhe: 'logado', em: new Date().toISOString() },
        login: { estado: 'nenhum' }, ...runner.extra,
      });
    }
    if (url.pathname === '/api/provedor' && req.method === 'POST') return json(200, { ok: true, rotulo: 'rotulo novo' });
    if (url.pathname === '/api/provedor/login' && req.method === 'POST') return json(200, { estado: 'aguardando_link' });
    if (url.pathname === '/api/provedor/login' && req.method === 'GET') return json(200, { estado: 'aguardando_codigo', link: 'https://claude.ai/oauth/x' });
    if (url.pathname === '/api/provedor/login/codigo') return json(200, { ok: true });
    if (url.pathname === '/api/provedor/login' && req.method === 'DELETE') return json(200, { ok: true });
    json(404, {});
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const porta = srv.address().port;

// ── o cofre real, na pasta temporária; aplicar() espiado ─────────────────────
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'provedor-teste-'));
const CONFIG = {
  agentSlug: 'teste', agentName: 'Agente de Teste', agentDir: RAIZ, creatorName: 'Dono de Teste',
  cofreDir: path.join(RAIZ, 'cofre'), cofreChaveMestra: path.join(RAIZ, 'cofre.chave'),
  cofreRuntimeDir: path.join(RAIZ, 'run'),
  bunkerUrl: `http://127.0.0.1:${porta}`, bunkerCard: 'cardX',
};
const real = buildCofre(CONFIG);
const espiao = { guardar: [], aplicar: 0 };
const cofre = {
  estado: () => real.estado(),
  guardar: (p) => { espiao.guardar.push(p.envName); return real.guardar(p); },
  aplicar: () => { espiao.aplicar++; return { ok: true, feito: 'reiniciado (falso)' }; },
};

// ── o roteador falso ─────────────────────────────────────────────────────────
const rotas = {};
const router = {};
for (const m of ['get', 'post', 'delete']) router[m] = (p, h) => { rotas[`${m.toUpperCase()} ${p}`] = h; };
registrar(router, { CONFIG, cofre, serverDir: AQUI });

async function chamar(rota, body) {
  const h = rotas[rota];
  let status = 200; let corpo;
  const res = { status(s) { status = s; return res; }, json(o) { corpo = o; return res; } };
  await h({ body, query: {} }, res);
  return { status, corpo };
}
const semChave = (o) => !JSON.stringify(o).includes('SEGREDO-DE-TESTE');
const resetar = () => { runner.recebidos.length = 0; espiao.guardar.length = 0; espiao.aplicar = 0; };

console.log('\nGET /api/provedor');
{
  const r = await chamar('GET /api/provedor');
  ok(r.status === 200 && r.corpo.provedor === 'claude' && r.corpo.rotulo.includes('Opus'), 'runner no ar: devolve a escolha e o rótulo');
  ok(r.corpo.conferido && r.corpo.conferido.ok === true, 'devolve o conferido');
  ok(r.corpo.catalogo.claude.auth.api.variavel === 'ANTHROPIC_API_KEY' && r.corpo.catalogo.claude.modelos.length >= 3, 'devolve o catálogo resumido com modos e modelos');
  ok(r.corpo.catalogo.gemini.disponivel === false && r.corpo.catalogo.gemini.motivo, 'Gemini vem indisponível, com o motivo');
  ok(!('instalar' in r.corpo.catalogo.claude) && !('logar' in r.corpo.catalogo.claude.auth.assinatura), 'o catálogo não leva comando de instalar nem de login');
  ok(r.corpo.chaves.ANTHROPIC_API_KEY === false && r.corpo.chaves.OPENAI_API_KEY === false && 'CLAUDE_CODE_OAUTH_TOKEN' in r.corpo.chaves, 'chaves: false para o que o Cofre não tem');
  ok(runner.recebidos[0].query.includes('sessao=cardX'), 'o runner recebeu ?sessao=cardX');
  runner.extra = { modelos: [{ id: 'gpt-x', nome: 'GPT X' }] };
  const r2 = await chamar('GET /api/provedor');
  ok(r2.corpo.catalogo.codex.modelos.length === 1 && r2.corpo.catalogo.codex.modelos[0].id === 'gpt-x', 'modelos do Codex vêm do runner quando ele manda');
  runner.extra = {};
}

console.log('\nGET com runner fora do ar ou antigo');
{
  runner.modo = 'antigo';
  const r = await chamar('GET /api/provedor');
  ok(r.status === 503 && r.corpo.error === 'O agente ainda não sabe informar o modelo' && r.corpo.howToFix, 'runner antigo (404): 503 amigável');
  runner.modo = 'ok';
  const url = CONFIG.bunkerUrl; CONFIG.bunkerUrl = 'http://127.0.0.1:1';
  const r2 = await chamar('GET /api/provedor');
  ok(r2.status === 503 && r2.corpo.howToFix, 'runner desligado: 503 amigável');
  CONFIG.bunkerUrl = url;
}

console.log('\nPOST sem exigir chave (assinatura)');
{
  resetar();
  const r = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'assinatura', modelo: 'sonnet' });
  ok(r.status === 200 && r.corpo.ok === true, 'responde ok');
  const post = runner.recebidos.find((x) => x.metodo === 'POST');
  const corpo = JSON.parse(post.corpo);
  ok(corpo.reiniciar === true && corpo.modelo === 'claude-sonnet-5-5' && corpo.auth === 'assinatura', 'runner recebe reiniciar:true e o id canônico do modelo');
  ok(espiao.aplicar === 0 && espiao.guardar.length === 0, 'cofre não é tocado');
}

console.log('\nPOST exigindo chave, sem chave');
{
  resetar();
  const r = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: '' });
  ok(r.status === 409 && r.corpo.precisaChave === 'ANTHROPIC_API_KEY' && r.corpo.ondeCriar && r.corpo.howToFix, '409 com precisaChave, ondeCriar e howToFix');
  ok(runner.recebidos.length === 0, 'o runner nem foi incomodado');
}

console.log('\nPOST com chave');
if (!COM_CHAVES) pular('POST com chave, chave já no Cofre, chave com forma errada, Codex na API, runner recusa');
else {
  resetar();
  const r = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: 'opus', chave: CHAVE });
  ok(r.status === 200 && r.corpo.ok === true && semChave(r.corpo), 'ok, e a resposta não tem a chave');
  ok(espiao.guardar.join() === 'ANTHROPIC_API_KEY', 'cofre.guardar foi chamado com ANTHROPIC_API_KEY');
  const post = runner.recebidos.find((x) => x.metodo === 'POST');
  ok(JSON.parse(post.corpo).reiniciar === false, 'o runner recebeu reiniciar:false');
  ok(!post.corpo.includes('SEGREDO-DE-TESTE') && !('chave' in JSON.parse(post.corpo)), 'o runner NÃO recebeu a chave');
  ok(espiao.aplicar === 1, 'cofre.aplicar foi chamado depois');
  const g = await chamar('GET /api/provedor');
  ok(g.corpo.chaves.ANTHROPIC_API_KEY === true && semChave(g.corpo), 'depois disso o GET diz que a chave está no Cofre, sem valor');
  resetar();
  const r2 = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: 'opus' });
  ok(r2.status === 200 && espiao.guardar.length === 0 && espiao.aplicar === 1, 'com a chave já no Cofre, não precisa mandar de novo');

  console.log('\nChave com forma errada');
  resetar();
  const f1 = await chamar('POST /api/provedor', { provedor: 'codex', auth: 'api', modelo: '', chave: CHAVE.replace(/^sk-ant-/, 'xx-') });
  ok(f1.status === 400 && /sk-/.test(f1.corpo.error) && semChave(f1.corpo), 'chave sem o prefixo da OpenAI no campo do Codex: 400 e sem eco da chave');
  const f2 = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: '', chave: 'AAAAAAAAAAAAAAAAAAAA' });
  ok(f2.status === 400 && f2.corpo.error.includes('sk-ant-'), 'chave sem o prefixo da Anthropic: 400 com a explicação');
  ok(runner.recebidos.length === 0 && espiao.guardar.length === 0 && espiao.aplicar === 0, 'nenhuma dessas recusas tocou o runner nem o Cofre');

  console.log('\nCodex na API guarda a OPENAI_API_KEY');
  resetar();
  const c = await chamar('POST /api/provedor', { provedor: 'codex', auth: 'api', modelo: '', chave: CHAVE_OPENAI });
  ok(c.status === 200 && espiao.guardar.join() === 'OPENAI_API_KEY' && semChave(c.corpo), 'ok, guardada com o nome certo e sem eco');

  console.log('\nRunner antigo depois de a chave ser guardada');
  resetar();
  runner.modo = 'antigo';
  const a = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: '', chave: CHAVE });
  ok(a.status === 503 && espiao.aplicar === 0 && semChave(a.corpo), '503 amigável, não reinicia, sem chave na resposta');
  runner.modo = 'ok';
}

console.log('\nProvedor indisponível e escolha inválida');
{
  resetar();
  const r3 = await chamar('POST /api/provedor', { provedor: 'gemini', auth: 'api', modelo: '' });
  ok(r3.status === 400 && r3.corpo.error.includes('não está disponível'), 'provedor indisponível: 400 com o motivo');
  const r4 = await chamar('POST /api/provedor', { provedor: 'claude', auth: 'api', modelo: 'modelo-que-nao-existe' });
  ok(r4.status === 400 && r4.corpo.error.includes('não existe'), 'modelo inexistente: 400');
  const r5 = await chamar('POST /api/provedor', { provedor: 'claude' });
  ok(r5.status === 400 && r5.corpo.howToFix, 'faltou campo: 400');
  ok(runner.recebidos.length === 0 && espiao.guardar.length === 0 && espiao.aplicar === 0, 'nenhuma dessas recusas tocou o runner nem o Cofre');
}

console.log('\nLogin assistido repassado');
{
  resetar();
  const a = await chamar('POST /api/provedor/login', {});
  const b = await chamar('GET /api/provedor/login');
  const c = await chamar('POST /api/provedor/login/codigo', { codigo: 'ABC-123' });
  const n = runner.recebidos.length;
  const c2 = await chamar('POST /api/provedor/login/codigo', { codigo: '  ' });
  const d = await chamar('DELETE /api/provedor/login');
  ok(a.corpo.estado === 'aguardando_link' && b.corpo.estado === 'aguardando_codigo' && b.corpo.link && c.corpo.ok && d.corpo.ok, 'as quatro rotas chegam ao runner');
  ok(c2.status === 400 && runner.recebidos.length === n + 1, 'código vazio: 400 sem incomodar o runner');
  const cod = runner.recebidos.find((x) => x.caminho.endsWith('/codigo'));
  ok(JSON.parse(cod.corpo).codigo === 'ABC-123', 'o runner recebeu o código');
}

console.log('\nNenhuma chave vazou');
{
  console.error = erroOriginal;
  const todosLogs = logs.join('\n');
  ok(!todosLogs.includes('SEGREDO-DE-TESTE'), `nenhum log contém a chave (${logs.length} linhas de log conferidas)`);
}

srv.close();
fs.rmSync(RAIZ, { recursive: true, force: true });
const resumo = falhas ? `${falhas} FALHA(S)` : pulados ? `SEM FALHAS, mas ${pulados} BLOCO(S) PULADO(S): defina as duas variáveis DGCLAW_TESTE_CHAVE_*` : 'TUDO CERTO';
console.log(`\n${resumo}\n`);
process.exit(falhas ? 1 : pulados ? 3 : 0);
