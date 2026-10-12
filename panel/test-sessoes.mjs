// test-sessoes.mjs — a aba Sessões: o proxy fala certo com o DG Telegram e não vaza a chave?
//
// POR QUE ESTE TESTE EXISTE. O proxy de lib/sessoes-proxy.js guarda a chave da agente
// no servidor e repassa o corpo em stream. Os defeitos que custam caro aqui não
// derrubam a tela, eles são silenciosos: a chave aparecendo numa resposta ou num log, o
// cookie do navegador chegando à origem, um anexo chegando com um byte trocado, um
// "decidir" que passa porque ninguém barrou. Tudo isto roda contra um DG Telegram FALSO
// em porta aleatória: o DG Telegram real (porta 4045) nunca é chamado.
//
// `node test-sessoes.mjs` na pasta do painel.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
const CHAVE = 'dgtg-chave-secreta-de-teste-9f8e7d6c5b4a';
const COOKIE_NAVEGADOR = 'dash_token=NAO-PODE-CHEGAR-NA-ORIGEM';
const BEARER_NAVEGADOR = 'Bearer segredo-do-navegador-que-nao-pode-passar';
const APP_URL = 'https://tg.exemplo.test';

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const RAIZ = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessoes-teste-')));
const cfgPath = path.join(RAIZ, 'painel-teste.json');
fs.writeFileSync(cfgPath, JSON.stringify({ agentName: 'Teste', agentSlug: 'luna', agentDir: RAIZ, authSalt: 'sal-de-teste' }));

function portaLivre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ─── o DG Telegram falso ─────────────────────────────────────────────────────
const chamadas = [];
const BYTES_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7) % 256)), Buffer.from('\n%%EOF')]);

async function subirOrigem() {
  const srv = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (b) => pedacos.push(b));
    req.on('end', () => {
      const corpo = Buffer.concat(pedacos);
      chamadas.push({ metodo: req.method, url: req.url, headers: req.headers, corpo });
      const caminho = req.url.split('?')[0];
      const json = (status, obj, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
        res.end(JSON.stringify(obj));
      };
      const cod = /\/c1\/codigo(\d{3})$/.exec(caminho);
      if (cod) {
        const status = +cod[1];
        return json(status, status < 400 ? { ok: true, status } : { ok: false, erro: `frase da origem para ${status}`, como_resolver: 'faça assim' },
          { 'Set-Cookie': 'sessao_da_origem=1; Path=/' });
      }
      if (caminho.endsWith('/c1/lento')) return; // nunca responde
      if (caminho.endsWith('/c1/trancado')) return json(423, { ok: false, erro: 'O cofre do Bunker está trancado (frase da origem).' });
      if (caminho.endsWith('/c1/ecoa')) return json(500, { ok: false, erro: `erro que repete o cabeçalho: ${req.headers.authorization}` });
      if (caminho.endsWith('/documentos/conteudo')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': BYTES_PDF.length, 'Content-Disposition': 'inline; filename="relatorio.pdf"' });
        return res.end(BYTES_PDF);
      }
      if (req.method === 'GET' && caminho === '/api/v1/sessoes') {
        return json(200, { ok: true, itens: [], contagem: {}, query: req.url.split('?')[1] || '' });
      }
      return json(200, { ok: true, recebido_bytes: corpo.length });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, porta: srv.address().port };
}

// ─── o painel ────────────────────────────────────────────────────────────────
async function subirPainel(envExtra) {
  const porta = await portaLivre();
  const env = { ...process.env, DGCLAW_PANEL_CONFIG: cfgPath, DGCLAW_PANEL_PORT: String(porta), DGCLAW_PANEL_PASSWORD: 'senha-teste', DGCLAW_PANEL_HOST: '127.0.0.1' };
  for (const k of Object.keys(env)) if (k.startsWith('DGCLAW_PANEL_SESSOES')) delete env[k];
  Object.assign(env, envExtra);
  const proc = spawn(process.execPath, [path.join(AQUI, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  proc.stdout.on('data', (d) => { saida += d; });
  proc.stderr.on('data', (d) => { saida += d; });
  for (let i = 0; i < 80 && !/rodando/.test(saida); i++) await new Promise((r) => setTimeout(r, 100));
  if (!/rodando/.test(saida)) throw new Error(`o painel não subiu: ${saida}`);
  const base = `http://127.0.0.1:${porta}`;
  const prefixo = envExtra.DGCLAW_PANEL_BASE || '';
  const login = await fetch(`${base}${prefixo}/login`, { method: 'POST', body: 'password=senha-teste', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  return {
    porta, prefixo, cookie, saida: () => saida, parar: () => proc.kill(),
    // Mutação sem Origin é recusada pelo proxy; como a tela, o teste manda o Origin do próprio painel.
    pedir: (url, op = {}) => {
      const h = { ...(op.headers || {}), Cookie: cookie };
      if (op.method && op.method !== 'GET' && !('Origin' in h) && !('origin' in h)) h.Origin = base;
      return fetch(base + prefixo + url, { ...op, headers: h });
    },
    base,
    semLogin: (url, op = {}) => fetch(base + prefixo + url, op),
  };
}

const respostas = []; // tudo o que o "navegador" recebeu, para procurar a chave
async function ler(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  respostas.push(buf.toString('latin1'));
  for (const [k, v] of r.headers) respostas.push(`${k}: ${v}`);
  let json = null;
  try { json = JSON.parse(buf.toString('utf-8')); } catch { /* corpo que não é JSON */ }
  return { status: r.status, buf, json, headers: r.headers };
}
const ultima = () => chamadas[chamadas.length - 1];

const { srv: origem, porta: portaOrigem } = await subirOrigem();
const URL_ORIGEM = `http://127.0.0.1:${portaOrigem}`;
const portaMorta = await portaLivre();
const servidores = [];

try {
  // ─── 1. desligada ──────────────────────────────────────────────────────────
  console.log('\n1. Sem URL ou sem chave: 501 dizendo qual falta');
  {
    const sem = await subirPainel({});
    servidores.push(sem);
    const cfg = await ler(await sem.pedir('/api/sessoes-config'));
    ok(cfg.status === 200 && cfg.json.ligado === false, '/api/sessoes-config diz ligado:false');
    ok(/DGCLAW_PANEL_SESSOES_URL/.test(cfg.json.motivo) && /chave/.test(cfg.json.motivo), 'o motivo cita a URL e a chave que faltam');
    const r = await ler(await sem.pedir('/api/sessoes'));
    ok(r.status === 501 && r.json.ok === false && /não está ligada nesta instalação/.test(r.json.erro), 'GET /api/sessoes devolve 501 com a frase');
    sem.parar();

    const soUrl = await subirPainel({ DGCLAW_PANEL_SESSOES_URL: URL_ORIGEM });
    servidores.push(soUrl);
    const r2 = await ler(await soUrl.pedir('/api/sessoes'));
    ok(r2.status === 501 && /falta a chave/.test(r2.json.erro) && !/falta DGCLAW_PANEL_SESSOES_URL/.test(r2.json.erro), 'só a URL: a frase diz que falta a chave');
    soUrl.parar();

    const soChave = await subirPainel({ DGCLAW_PANEL_SESSOES_KEY: CHAVE });
    servidores.push(soChave);
    const r3 = await ler(await soChave.pedir('/api/sessoes'));
    ok(r3.status === 501 && /falta DGCLAW_PANEL_SESSOES_URL/.test(r3.json.erro), 'só a chave: a frase diz que falta a URL');
    ok(!r3.buf.toString().includes(CHAVE), 'e a frase não mostra o valor da chave');
    soChave.parar();
  }

  // ─── painel ligado ─────────────────────────────────────────────────────────
  const arquivoChave = path.join(RAIZ, 'chave.txt');
  fs.writeFileSync(arquivoChave, `  ${CHAVE}\n`);
  const p = await subirPainel({
    DGCLAW_PANEL_SESSOES_URL: URL_ORIGEM, DGCLAW_PANEL_SESSOES_KEY_FILE: arquivoChave,
    DGCLAW_PANEL_SESSOES_AGENTE: 'luna', DGCLAW_PANEL_SESSOES_APP_URL: `${APP_URL}/`,
    DGCLAW_PANEL_SESSOES_TIMEOUT_MS: '700',
  });
  servidores.push(p);

  console.log('\n2. Configuração ligada (chave lida de arquivo, com espaços cortados)');
  {
    const cfg = await ler(await p.pedir('/api/sessoes-config'));
    ok(cfg.json.ligado === true && cfg.json.agente === 'luna' && cfg.json.appUrl === APP_URL, 'ligado:true, agente e appUrl (sem a barra do fim)');
    ok(Object.keys(cfg.json).sort().join() === 'agente,appUrl,ligado,soLeitura', 'só esses quatro campos: nada de URL interna nem de chave');
    const c = await ler(await p.pedir('/api/config'));
    ok(!c.buf.toString().includes(CHAVE) && !c.buf.toString().includes(URL_ORIGEM), '/api/config não traz a chave nem a URL interna');
  }

  console.log('\n3. Repasse: método, caminho, query, status e corpo');
  {
    const r = await ler(await p.pedir('/api/sessoes?agente=luna&grupo=ativos&q=a%20b'));
    ok(r.status === 200 && ultima().url === '/api/v1/sessoes?agente=luna&grupo=ativos&q=a%20b', 'GET lista: caminho e query chegam intactos');
    ok(ultima().metodo === 'GET' && r.json.ok === true, 'o corpo da origem volta');

    const conversa = await ler(await p.pedir('/api/sessoes/c1/conversa?limite=30&before=12'));
    ok(ultima().url === '/api/v1/sessoes/c1/conversa?limite=30&before=12' && conversa.status === 200, 'GET conversa com before');

    for (const codigo of [200, 201, 202, 400, 403, 404, 409, 413, 501]) {
      const rr = await ler(await p.pedir(`/api/sessoes/c1/codigo${codigo}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
      const bom = codigo < 400 ? rr.json && rr.json.ok === true : rr.json && rr.json.erro === `frase da origem para ${codigo}` && rr.json.como_resolver === 'faça assim';
      ok(rr.status === codigo && bom, `status ${codigo} e corpo voltam iguais`);
    }
    const semCookie = await ler(await p.pedir('/api/sessoes/c1/codigo200', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    ok(!semCookie.headers.get('set-cookie'), 'o Set-Cookie da origem não passa para o navegador');

    const corpo = JSON.stringify({ texto: 'continue pelo passo 3 ✓ acentuação', quando: 'agora', retomar: false });
    const post = await ler(await p.pedir('/api/sessoes/c1/recado', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo }));
    ok(post.status === 200 && ultima().metodo === 'POST' && ultima().url === '/api/v1/sessoes/c1/recado', 'POST recado: método e caminho');
    ok(ultima().corpo.toString('utf-8') === corpo && ultima().headers['content-type'] === 'application/json', 'o JSON do POST chega igual, byte a byte');

    const arq = crypto.randomBytes(300 * 1024);
    const fim = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const boundary = '----teste' + crypto.randomBytes(6).toString('hex');
    const multi = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="arquivo"; filename="foto.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      arq, fim, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const anexo = await ler(await p.pedir('/api/sessoes/c1/anexo', { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: multi }));
    ok(anexo.status === 200 && ultima().url === '/api/v1/sessoes/c1/anexo', 'anexo multipart chega ao caminho certo');
    ok(Buffer.compare(ultima().corpo, multi) === 0, `o multipart chega íntegro (${multi.length} bytes, todos iguais)`);
    ok(ultima().headers['content-type'] === `multipart/form-data; boundary=${boundary}`, 'com o boundary no Content-Type');

    const pdf = await ler(await p.pedir('/api/sessoes/c1/documentos/conteudo?caminho=%2Ftmp%2Frelatorio.pdf'));
    ok(pdf.status === 200 && pdf.headers.get('content-type') === 'application/pdf', 'PDF cru volta com o mesmo Content-Type');
    ok(Buffer.compare(pdf.buf, BYTES_PDF) === 0, 'e com os mesmos bytes');
    ok(/inline/.test(pdf.headers.get('content-disposition') || ''), 'e com o Content-Disposition da origem');
  }

  console.log('\n4. A chave vai para a origem; o navegador não manda nada dele para lá');
  {
    await ler(await p.pedir('/api/sessoes', { headers: { Authorization: BEARER_NAVEGADOR, 'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' } }));
    const h = ultima().headers;
    ok(h.authorization === `Bearer ${CHAVE}`, 'a origem recebe Authorization: Bearer <chave da agente>');
    ok(!JSON.stringify(h).includes('NAO-PODE-CHEGAR') && h.cookie === undefined, 'o cookie do navegador não chega à origem');
    ok(!JSON.stringify(h).includes('segredo-do-navegador'), 'o Authorization do navegador não chega à origem');
    ok(h['x-forwarded-for'] === undefined && h['cf-connecting-ip'] === undefined, 'cabeçalhos de proxy e do Cloudflare não passam');
    ok(h.host === `127.0.0.1:${portaOrigem}`, 'o Host é o da origem, não o do painel');
  }

  console.log('\n5. Recusas no próprio proxy (403 com a frase e o link), sem chegar à origem');
  {
    const antes = chamadas.length;
    const casos = [
      ['POST', '/api/sessoes/c1/decidir', `${APP_URL}/a/luna?sessoes=pedidos&card=c1`],
      ['POST', '/api/sessoes/c1/tecla', `${APP_URL}/a/luna?sessoes=pedidos&card=c1`],
      ['POST', '/api/sessoes/c1/DECIDIR', `${APP_URL}/a/luna?sessoes=pedidos&card=c1`],
      ['POST', '/api/sessoes/c1/%64ecidir', `${APP_URL}/a/luna?sessoes=pedidos&card=c1`],
      ['GET', '/api/sessoes/cofre', `${APP_URL}/a/luna?sessoes=1`],
      ['POST', '/api/sessoes/cofre/destrancar', `${APP_URL}/a/luna?sessoes=1`],
      ['GET', '/api/sessoes/pedidos', `${APP_URL}/a/luna?sessoes=pedidos`],
      ['POST', '/api/sessoes/pedidos/x/decidir', `${APP_URL}/a/luna?sessoes=pedidos`],
    ];
    for (const [metodo, url, link] of casos) {
      const r = await ler(await p.pedir(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: metodo === 'POST' ? '{"acao":"permitir"}' : undefined }));
      ok(r.status === 403 && r.json.ok === false && /Isso só se faz no DG Telegram/.test(r.json.erro) && /Decidir no DG Telegram/.test(r.json.erro), `${metodo} ${url}: 403 com a frase`);
      ok(r.json.abrir_em === link, `${metodo} ${url}: abrir_em = ${link}`);
    }
    ok(chamadas.length === antes, 'nenhuma dessas chegou ao DG Telegram falso');
    const estranho = await ler(await p.pedir('/api/sessoes/c1/..%2fcofre'));
    ok(estranho.status === 400 && /parte inválida/.test(estranho.json.erro), 'caminho com barra escondida ou ".." é recusado (400)');
    ok(chamadas.length === antes, 'e também não chega à origem');
  }

  console.log('\n6. 423 da origem vira 503');
  {
    const r = await ler(await p.pedir('/api/sessoes/c1/trancado'));
    ok(r.status === 503 && r.json.cofre_trancado === true && /frase da origem/.test(r.json.erro), '423 vira 503 com a frase da origem');
    ok(r.json.abrir_em === `${APP_URL}/a/luna?sessoes=1`, 'com o link para destravar no DG Telegram');
  }

  console.log('\n7. DG Telegram fora do ar');
  {
    const morto = await subirPainel({ DGCLAW_PANEL_SESSOES_URL: `http://127.0.0.1:${portaMorta}`, DGCLAW_PANEL_SESSOES_KEY: CHAVE });
    servidores.push(morto);
    const r = await ler(await morto.pedir('/api/sessoes'));
    ok(r.status === 502 && r.json.ok === false && /ECONNREFUSED/.test(r.json.erro) && r.json.erro.includes(`127.0.0.1:${portaMorta}`), '502 com a causa (ECONNREFUSED) e o endereço');
    ok(/dg-telegram está de pé/.test(r.json.erro), 'e com o que fazer');
    morto.parar();

    const t0 = Date.now();
    const lento = await ler(await p.pedir('/api/sessoes/c1/lento'));
    ok(lento.status === 502 && /ETIMEDOUT/.test(lento.json.erro), `timeout vira 502 com a causa (em ${Date.now() - t0} ms)`);
  }

  console.log('\n8. Login do painel');
  {
    const antes = chamadas.length;
    const a = await p.semLogin('/api/sessoes');
    const b = await p.semLogin('/api/sessoes/c1/recado', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"texto":"x"}' });
    const c = await p.semLogin('/api/sessoes-config');
    ok(a.status === 401 && b.status === 401 && c.status === 401, 'sem o cookie do painel: 401 na lista, no POST e na config');
    ok(chamadas.length === antes, 'e nada chega ao DG Telegram');
  }

  console.log('\n8b. Trava de origem nas mutações (CSRF) e tipo de conteúdo');
  {
    const antes = chamadas.length;
    const corpo = '{"texto":"x","quando":"agora"}';
    const json = { 'Content-Type': 'application/json' };
    const post = (h, extra = {}) => fetch(`http://127.0.0.1:${p.porta}/api/sessoes/c1/recado`, { method: 'POST', body: corpo, ...extra, headers: { Cookie: p.cookie, ...h } });
    const semOrigem = await ler(await post(json));
    ok(semOrigem.status === 403 && /não veio da tela deste painel/.test(semOrigem.json.erro), 'POST sem Origin e sem Referer: 403 com a frase');
    const outro = await ler(await post({ ...json, Origin: 'https://site-malicioso.test' }));
    ok(outro.status === 403, 'POST com Origin de outro site: 403');
    const nulo = await ler(await post({ ...json, Origin: 'null' }));
    ok(nulo.status === 403, 'POST com Origin "null" (form de página sandbox): 403');
    ok(chamadas.length === antes, 'nenhuma dessas chegou ao DG Telegram falso');
    // A trava geral do painel (lib/auth.js) pega o Origin de outro site antes da trava
    // das sessões; qualquer uma das duas linhas de log serve, desde que traga o que se pede.
    ok((/recusado: Origin de outro site ou ausente \(visto: site-malicioso\.test\)/.test(p.saida()) ||
        /CSRF: POST \/api\/sessoes\/c1\/recado recusado, Origin https:\/\/site-malicioso\.test/.test(p.saida())) && !p.saida().includes(CHAVE), 'o log tem método, caminho e o host do Origin recebido, sem a chave');

    const certo = await ler(await post({ ...json, Origin: `http://127.0.0.1:${p.porta}` }));
    ok(certo.status === 200, 'POST com Origin do próprio host passa');
    const maiusc = await ler(await post({ ...json, Origin: `HTTP://127.0.0.1:${p.porta}` }));
    ok(maiusc.status === 200, 'a comparação do host não diferencia maiúscula');
    const ref = await ler(await post({ ...json, Referer: `http://127.0.0.1:${p.porta}/painel?x=1` }));
    ok(ref.status === 200, 'POST só com o Referer do próprio host passa');
    const refOutro = await ler(await post({ ...json, Referer: 'https://outro.test/pagina' }));
    ok(refOutro.status === 403, 'POST com Referer de outro site: 403');
    const fwd = await ler(await post({ ...json, Origin: 'https://painel.exemplo.test', 'X-Forwarded-Host': 'painel.exemplo.test' }));
    ok(fwd.status === 200, 'X-Forwarded-Host é respeitado');
    const fwdErrado = await ler(await post({ ...json, Origin: `http://127.0.0.1:${p.porta}`, 'X-Forwarded-Host': 'painel.exemplo.test' }));
    ok(fwdErrado.status === 403, 'com X-Forwarded-Host, o host da conexão deixa de valer');

    const texto = await ler(await post({ 'Content-Type': 'text/plain', Origin: `http://127.0.0.1:${p.porta}` }));
    ok(texto.status === 415 && /JSON/.test(texto.json.erro), 'POST text/plain: 415 com a frase');
    const get = await ler(await fetch(`http://127.0.0.1:${p.porta}/api/sessoes`, { headers: { Cookie: p.cookie } }));
    ok(get.status === 200, 'GET sem Origin continua passando');
  }

  console.log('\n9. A chave nunca aparece');
  {
    const eco = await ler(await p.pedir('/api/sessoes/c1/ecoa'));
    ok(eco.status === 500 && eco.json.erro.includes('***') && !eco.buf.toString().includes(CHAVE), 'erro da origem que repete a chave sai com ***');
    ok(!respostas.join('\n').includes(CHAVE), `a chave não aparece em nenhuma das ${respostas.length} respostas e cabeçalhos recebidos`);
    ok(!p.saida().includes(CHAVE), 'nem no log do painel');
    ok(/sessoes: POST \/c1\/recado -> 200/.test(p.saida()), 'o log tem uma linha por mutação (sessoes: POST /c1/recado -> 200)');
    ok(!p.saida().includes('continue pelo passo 3'), 'e sem o corpo do recado');
    ok(/sessoes: GET \/c1\/lento falhou: ETIMEDOUT/.test(p.saida()), 'erro de proxy loga a causa técnica');
    ok(!/caminho=/.test(p.saida()), 'o log não traz a query de documentos/conteudo');
  }

  console.log('\n10b. Modo só leitura (DGCLAW_PANEL_SESSOES_SO_LEITURA=1)');
  {
    const l = await subirPainel({
      DGCLAW_PANEL_SESSOES_URL: URL_ORIGEM, DGCLAW_PANEL_SESSOES_KEY: CHAVE,
      DGCLAW_PANEL_SESSOES_AGENTE: 'isa', DGCLAW_PANEL_SESSOES_APP_URL: APP_URL, DGCLAW_PANEL_SESSOES_SO_LEITURA: '1',
    });
    servidores.push(l);
    const cfgL = await ler(await l.pedir('/api/sessoes-config'));
    ok(cfgL.json.soLeitura === true && cfgL.json.ligado === true, '/api/sessoes-config diz soLeitura:true');
    const cfgP = await ler(await p.pedir('/api/sessoes-config'));
    ok(cfgP.json.soLeitura === false, 'e o painel normal diz soLeitura:false');
    const antes = chamadas.length;
    const json = { 'Content-Type': 'application/json' };
    const casos = [
      ['POST', '/api/sessoes', `${APP_URL}/a/isa?sessoes=1`],
      ['POST', '/api/sessoes/c1/recado', `${APP_URL}/a/isa?sessoes=pedidos&card=c1`],
      ['POST', '/api/sessoes/c1/arquivar', `${APP_URL}/a/isa?sessoes=pedidos&card=c1`],
      ['PUT', '/api/sessoes/c1/renomear', `${APP_URL}/a/isa?sessoes=pedidos&card=c1`],
      ['DELETE', '/api/sessoes/c1', `${APP_URL}/a/isa?sessoes=1`],
      ['POST', '/api/sessoes/c1/anexo', `${APP_URL}/a/isa?sessoes=pedidos&card=c1`],
    ];
    for (const [metodo, url, link] of casos) {
      const r = await ler(await l.pedir(url, { method: metodo, headers: json, body: metodo === 'DELETE' ? undefined : '{}' }));
      ok(r.status === 403 && r.json.ok === false && /só para ler/.test(r.json.erro) && r.json.abrir_em === link, `${metodo} ${url}: 403 só leitura, abrir_em = ${link}`);
    }
    ok(chamadas.length === antes, 'nenhuma escrita chegou ao DG Telegram falso');
    for (const url of ['/api/sessoes?grupo=ativos', '/api/sessoes/c1', '/api/sessoes/c1/conversa?limite=30', '/api/sessoes/c1/documentos', '/api/sessoes/c1/documentos/conteudo?caminho=%2Ftmp%2Fa.pdf', '/api/sessoes/c1/handoff']) {
      const r = await ler(await l.pedir(url));
      ok(r.status === 200, `GET ${url.split('?')[0]} continua passando`);
    }
    ok(/painel em modo só leitura/.test(l.saida()) && !l.saida().includes(CHAVE), 'o log registra a recusa, sem a chave');
  }

  console.log('\n10. Painel atrás de um prefixo (DGCLAW_PANEL_BASE): o corpo chega em stream');
  {
    const b = await subirPainel({
      DGCLAW_PANEL_BASE: '/agente/luna/painel', DGCLAW_PANEL_SESSOES_URL: URL_ORIGEM, DGCLAW_PANEL_SESSOES_KEY: CHAVE,
    });
    servidores.push(b);
    const corpo = JSON.stringify({ nome: 'x', prompt: 'y', permissao: 'auto' });
    const r = await ler(await b.pedir('/api/sessoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo }));
    ok(r.status === 200 && ultima().corpo.toString() === corpo && ultima().url === '/api/v1/sessoes', 'POST JSON com prefixo: corpo intacto (nenhum parser global o consumiu)');
    const form = await ler(await b.pedir('/api/sessoes/c1/recado', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' }));
    ok(form.status === 415, 'e um form urlencoded é recusado (415)');
    b.parar();
  }
} finally {
  for (const s of servidores) s.parar();
  origem.closeAllConnections();
  origem.close();
  fs.rmSync(RAIZ, { recursive: true, force: true });
}


// ─── a tela (public/js/sessoes.js), sem navegador ────────────────────────────
console.log('\n11. A tela: funções puras, tutorial completo e nada de HTML montado com texto da API');
{
  const fonteTela = fs.readFileSync(path.join(AQUI, 'public/js/sessoes.js'), 'utf-8');
  const janela = {};
  new Function('window', 'document', fonteTela)(janela, { querySelector: () => null, readyState: 'complete' });
  const { prefixoNome, linkDoTelegram, passosDoTutorial, textoErro } = janela.DGSessoes._interno;

  const card = { nome: '▶️ ATIVA [VPS] — Mini-Bunker: fase 1', nome_limpo: 'Mini-Bunker: fase 1' };
  ok(prefixoNome(card) === '▶️ ATIVA [VPS] — ', 'renomear: o prefixo de status do card é preservado');
  ok(prefixoNome({ nome: '✅ Feito', nome_limpo: 'Feito' }) === '✅ ', 'renomear: prefixo ✅');
  ok(prefixoNome({ nome: '⏳ Espera', nome_limpo: 'Espera' }) === '⏳ ', 'renomear: prefixo ⏳');
  ok(prefixoNome({ nome: 'Sem prefixo', nome_limpo: 'Sem prefixo' }) === '', 'card sem prefixo: nada é inventado');
  ok(prefixoNome({ nome: 'Só o nome' }) === '', 'sem nome_limpo: nada é inventado');

  const c = { appUrl: 'https://tg.exemplo.test/', agente: 'luna' };
  ok(linkDoTelegram(c, 'pedidos', 'abc') === 'https://tg.exemplo.test/a/luna?sessoes=pedidos&card=abc', 'Decidir no DG Telegram: <appUrl>/a/<agente>?sessoes=pedidos&card=<id>');
  ok(linkDoTelegram(c, 'cofre') === 'https://tg.exemplo.test/a/luna?sessoes=1', 'cofre trancado: <appUrl>/a/<agente>?sessoes=1');
  ok(linkDoTelegram({ appUrl: 'javascript:alert(1)', agente: 'luna' }, 'cofre') === '', 'endereço que não é http(s) não vira link');

  ok(textoErro({ status: 409, corpo: { erro: 'frase da API', como_resolver: 'faça isto' } }) === 'frase da API faça isto', 'erro mostra a frase da API e o como resolver');
  ok(textoErro({ status: 502, corpo: {} }).length > 30 && !/desconhecido/i.test(textoErro({ status: 502, corpo: {} })), 'erro sem corpo ainda diz algo útil, nunca vazio');

  const passos = passosDoTutorial();
  ok(passos.length >= 10 && passos[0].chave === 'tela' && passos[0].alvo === null, `o tutorial tem ${passos.length} passos e começa pela tela inteira`);
  ok(passos.every((p) => p.titulo && p.corpo && p.porque), 'todo passo responde o que é, como funciona e POR QUE está aqui');
  ok(new Set(passos.map((p) => p.chave)).size === passos.length, 'nenhuma chave de passo repetida');
  const chavesUsadas = [...fonteTela.matchAll(/ajuda\('([^']+)'/g)].map((m) => m[1]);
  ok(chavesUsadas.length >= 11 && chavesUsadas.every((k) => passos.some((p) => p.chave === k)), `os ${chavesUsadas.length} "?" da tela abrem passos que existem`);
  for (const p of passos.filter((x) => x.alvo)) {
    const tokens = [...p.alvo.matchAll(/[#.]([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    ok(tokens.every((t) => fonteTela.includes(t)), `passo ${p.chave}: o alvo ${p.alvo} existe no desenho da tela`);
  }

  const codigo = fonteTela.replace(/\/\/.*$/gm, '');
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(codigo), 'nenhum innerHTML: todo texto da API entra por textContent');

  const html = fs.readFileSync(path.join(AQUI, 'public/index.html'), 'utf-8');
  const app = fs.readFileSync(path.join(AQUI, 'public/js/app.js'), 'utf-8');
  ok(/data-tab="sessoes"[^>]*hidden/.test(html) && html.includes('id="panel-sessoes"'), 'a aba está no menu (escondida até a config ligar) e tem painel');
  ok(html.includes('css/sessoes.css') && html.includes('js/sessoes.js'), 'o index.html carrega o CSS e o JS da aba');
  ok(/EXPLICACAO_ABA[\s\S]*?\n  sessoes:/.test(app) && /SUBTITULO_ABA[\s\S]*?\n  sessoes:/.test(app) && app.includes("case 'sessoes'"), 'o app.js registra o balão, o subtítulo e o carregamento da aba');
  const css = fs.readFileSync(path.join(AQUI, 'public/css/sessoes.css'), 'utf-8');
  ok(/max-width:\s*560px/.test(css) && !/overflow-x:\s*scroll/.test(css), 'o CSS tem regra de celular e não força rolagem horizontal');
}

console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
