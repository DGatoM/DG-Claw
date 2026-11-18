// test-integracoes.mjs - a rota /api/integracoes: lê o estado.json do agente, valida e marca.
//
// Sobe o painel de verdade numa pasta de agente falsa e confere: sem arquivo, arquivo inválido,
// acima de 64 KiB, id fora do catálogo, desligar/ligar, skills anotando e rota sem sessão.
// Uso: NODE_PATH=$PWD/node_modules node test-integracoes.mjs (na pasta panel)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
let falhas = 0;
const ok = (cond, msg) => { console.log(cond ? `  ok   ${msg}` : `  FALHOU  ${msg}`); if (!cond) falhas++; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'integracoes-'));
const agente = path.join(RAIZ, 'agente');
const pasta = path.join(agente, '.dgclaw', 'integracoes');
const skillsDir = path.join(agente, '.claude', 'skills');
const skillsCodex = path.join(agente, '.agents', 'skills');
fs.mkdirSync(skillsDir, { recursive: true });
fs.mkdirSync(skillsCodex, { recursive: true });
const mk = (dir, nome, conteudo) => { fs.mkdirSync(path.join(dir, nome), { recursive: true }); fs.writeFileSync(path.join(dir, nome, 'SKILL.md'), conteudo); };
mk(skillsDir, 'publicar', '---\nname: publicar\ndescription: Publica no Instagram\nintegracoes: instagram, openai, Inválido!, nao-existe-no-mapa\n---\n');
mk(skillsCodex, 'postar-codex', '---\nname: postar-codex\ndescription: Posta pelo Codex\nintegracoes: instagram\n---\n');

const PORTA = 19100 + Math.floor(Math.random() * 100);
const SENHA = crypto.randomBytes(18).toString('hex');   // nova a cada execução
const cfg = path.join(RAIZ, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ agentName: 'Agente Teste', agentSlug: 'agente-teste', agentDir: agente }));
// O filho recebe só o necessário, não o ambiente herdado de quem roda o teste.
const env = { PATH: process.env.PATH, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), HOME: RAIZ, DGCLAW_PANEL_PORT: String(PORTA), DGCLAW_PANEL_HOST: '127.0.0.1',
  DGCLAW_PANEL_PASSWORD: SENHA, DGCLAW_SAUDE_CHECAR_LOGIN: 'off', DGCLAW_PANEL_CONFIG: cfg,
  // Sem herdar do ambiente de quem roda o teste: a casa do agente e as skills extras apontam para a pasta temporária.
  DGCLAW_INTEGRACOES_DIR: pasta, DGCLAW_PANEL_SKILLS_DIR: '' };
const filho = spawn('node', ['server.js'], { cwd: AQUI, env, stdio: 'ignore' });
const URL_ = `http://127.0.0.1:${PORTA}`;

const agora = new Date();
const iso = (msAtras) => new Date(agora.getTime() - msAtras).toISOString().replace(/\.\d+Z$/, 'Z');
const item = (id, estado, ultimoResultado, extra = {}) => ({ id, estado, ultimoEvento: iso(60000), ultimoResultado,
  ultimoOk: null, ultimaTentativaReal: iso(60000), ultimaFalha: null, ultimaFalhaResultado: null, ...extra });
const gravaEstado = (corpo) => { fs.mkdirSync(pasta, { recursive: true }); fs.writeFileSync(path.join(pasta, 'estado.json'), typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); };

try {
  let login;
  for (let i = 0; i < 40 && !login; i++) {
    try { login = await fetch(`${URL_}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(SENHA)}` }); }
    catch { await dormir(250); }
  }
  ok(!!login, 'painel subiu e aceitou o login');
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const get = async () => { const r = await fetch(`${URL_}/api/integracoes`, { headers: { cookie } }); return { status: r.status, j: await r.json() }; };
  const post = (rota) => fetch(`${URL_}/api/integracoes/${rota}`, { method: 'POST', headers: { cookie } });

  // sem sessão
  const sem = await fetch(`${URL_}/api/integracoes`, { redirect: 'manual' });
  ok(sem.status === 401 || sem.status === 302 || sem.status === 403, `GET sem sessão é recusado (veio ${sem.status})`);
  const semPost = await fetch(`${URL_}/api/integracoes/instagram/desligar`, { method: 'POST', redirect: 'manual' });
  ok(semPost.status === 401 || semPost.status === 302 || semPost.status === 403, `POST sem sessão é recusado (veio ${semPost.status})`);

  // sem arquivo
  let r = await get();
  ok(r.status === 200 && r.j.medido === true && Array.isArray(r.j.integracoes) && r.j.integracoes.length === 0, 'sem estado.json: lista vazia e medido:true');
  ok(r.j.agente?.nome === 'Agente Teste' && r.j.agente?.slug === 'agente-teste', 'traz o nome e o slug do agente');

  // arquivo inválido
  gravaEstado('{isso não é json');
  r = await get();
  ok(r.j.medido === false && /JSON quebrado/.test(r.j.motivo) && r.j.integracoes.length === 0, 'JSON quebrado: medido:false com motivo em português');
  gravaEstado({ versao: 1, integracoes: [{ id: 'Id Ruim', estado: 'verde', ultimoResultado: 'ok', ultimoEvento: iso(1000) }] });
  r = await get();
  ok(r.j.medido === false && /fora do formato/.test(r.j.motivo), 'id fora do formato: medido:false');
  gravaEstado({ versao: 1, integracoes: [item('instagram', 'azul', 'ok')] });
  r = await get();
  ok(r.j.medido === false, 'estado fora da lista: medido:false');

  // acima de 64 KiB
  gravaEstado(JSON.stringify({ versao: 1, integracoes: [], enchimento: 'x'.repeat(70 * 1024) }));
  r = await get();
  ok(r.j.medido === false && /acima do limite/.test(r.j.motivo), 'estado.json acima de 64 KiB: medido:false');

  // estado bom, com catálogo, id fora do catálogo, sem uso recente e skills
  gravaEstado({ versao: 1, geradoEm: iso(1000), integracoes: [
    item('instagram', 'vermelho', 'credencial_recusada', { ultimoOk: iso(86400000), ultimaFalha: iso(60000), ultimaFalhaResultado: 'credencial_recusada' }),
    item('openai', 'verde', 'ok', { ultimoOk: iso(60000) }),
    item('sistema-do-cliente', 'amarelo', 'rede', { ultimaFalha: iso(60000), ultimaFalhaResultado: 'rede' }),
    item('groq', 'verde', 'ok', { ultimoEvento: iso(8 * 86400000), ultimoOk: iso(8 * 86400000) }),
  ] });
  r = await get();
  const por = Object.fromEntries((r.j.integracoes || []).map((x) => [x.id, x]));
  ok(r.j.medido === true && r.j.integracoes.length === 4, 'estado válido: 4 integrações e medido:true');
  ok(por.instagram?.nome === 'Instagram' && por.instagram?.icone === 'camera', 'id do catálogo traz nome e ícone');
  ok(por.instagram?.palavra === 'Com defeito' && por.instagram?.ultimaFalhaExplica === 'A senha de acesso (chave) foi recusada pelo sistema.', 'vermelho: palavra e explicação em português leigo');
  ok(por['sistema-do-cliente']?.nome === 'sistema-do-cliente' && por['sistema-do-cliente']?.icone === 'link', 'id fora do catálogo: nome é o id e ícone link');
  ok(por.openai?.palavra === 'Funcionando' && por.openai?.ultimaFalhaExplica === null, 'verde: Funcionando, sem explicação de falha');
  ok(por.groq?.estado === 'sem_uso_recente' && por.groq?.palavra === 'Sem uso recente', 'verde com último evento de 8 dias vira sem_uso_recente');
  ok(JSON.stringify(por.instagram?.skills?.sort()) === JSON.stringify(['postar-codex', 'publicar']), 'skills do .claude e do .agents anotam a integração');
  ok(JSON.stringify(por.openai?.skills) === '["publicar"]', 'id inválido do frontmatter é ignorado; id válido anota');
  ok(!por['nao-existe-no-mapa'], 'o frontmatter não cria nó no mapa');

  // skill que não é arquivo comum (FIFO) ou é enorme não trava nem derruba o mapa
  execFileSync('mkfifo', [path.join(skillsDir, 'fifo-skill')]);
  fs.mkdirSync(path.join(skillsDir, 'fifo'), { recursive: true });
  fs.renameSync(path.join(skillsDir, 'fifo-skill'), path.join(skillsDir, 'fifo', 'SKILL.md'));
  mk(skillsDir, 'grande', '---\nname: grande\ndescription: Skill com corpo enorme\nintegracoes: groq\n---\n' + 'x'.repeat(300 * 1024));
  r = await get();
  const por2 = Object.fromEntries((r.j.integracoes || []).map((x) => [x.id, x]));
  ok(r.status === 200 && r.j.medido === true, 'skill FIFO no meio: o mapa continua respondendo');
  ok(JSON.stringify(por2.instagram?.skills?.sort()) === JSON.stringify(['postar-codex', 'publicar']), 'a skill FIFO é ignorada e as outras seguem anotando');
  ok(JSON.stringify(por2.groq?.skills) === '["grande"]', 'skill com corpo de 300 KB: só o cabeçalho é lido e a integração é anotada');

  // preferências ilegíveis: o mapa não diz "Funcionando", diz que não mediu
  fs.writeFileSync(path.join(pasta, 'preferencias.json'), '{quebrado');
  r = await get();
  ok(r.j.medido === false && /preferências/.test(r.j.motivo), 'preferencias.json ilegível: GET traz medido:false com motivo');
  fs.rmSync(path.join(pasta, 'preferencias.json'));

  // pasta de integrações que é link simbólico: a gravação recusa e nada vai para o destino do link
  const alvoLink = path.join(RAIZ, 'alvo-do-link');
  fs.mkdirSync(alvoLink);
  const pastaReal = `${pasta}.real`;
  fs.renameSync(pasta, pastaReal);
  fs.symlinkSync(alvoLink, pasta);
  let pl = await post('instagram/desligar');
  ok(pl.status === 500 && /link simbólico/.test(JSON.stringify(await pl.json())), 'pasta de integrações é link simbólico: POST recusa');
  ok(fs.readdirSync(alvoLink).length === 0, 'nada foi gravado no destino do link');
  fs.rmSync(pasta);
  fs.renameSync(pastaReal, pasta);
  ok(!fs.readdirSync(pasta).some((n) => n.endsWith('.tmp')), 'nenhum temporário ficou na pasta');

  // desligar / ligar
  let p = await post('instagram/desligar');
  ok(p.status === 200 && (await p.json()).desligada === true, 'POST desligar responde 200');
  r = await get();
  ok(r.j.integracoes.find((x) => x.id === 'instagram').estado === 'desligado' && r.j.integracoes.find((x) => x.id === 'instagram').palavra === 'Desligado', 'integração desligada aparece como desligado');
  const prefs = JSON.parse(fs.readFileSync(path.join(pasta, 'preferencias.json'), 'utf8'));
  ok(JSON.stringify(prefs) === '{"desligadas":["instagram"]}', 'preferencias.json gravado');
  p = await post('instagram/ligar');
  ok(p.status === 200 && (await p.json()).desligada === false, 'POST ligar responde 200');
  r = await get();
  ok(r.j.integracoes.find((x) => x.id === 'instagram').estado === 'vermelho', 'depois de ligar volta ao estado calculado');
  // preferências existentes mas inválidas: recusa gravar (não parte de lista vazia) e não apaga o arquivo
  fs.writeFileSync(path.join(pasta, 'preferencias.json'), '{quebrado');
  p = await post('instagram/desligar');
  ok(p.status === 409 && fs.readFileSync(path.join(pasta, 'preferencias.json'), 'utf8') === '{quebrado', 'preferencias.json inválido: o POST recusa com 409 e não sobrescreve');
  fs.rmSync(path.join(pasta, 'preferencias.json'));
  // item 6: o trecho do conteúdo inválido não aparece na resposta
  gravaEstado('{"segredo-do-agente": QUEBRADO');
  r = await get();
  ok(r.j.medido === false && /JSON quebrado/.test(r.j.motivo) && !/segredo-do-agente|QUEBRADO|position|Unexpected/.test(JSON.stringify(r.j)), 'estado.json inválido: motivo fixo, sem trecho do conteúdo');
  gravaEstado({ versao: 1, geradoEm: iso(0), integracoes: [item('instagram', 'vermelho', 'credencial_recusada', { ultimaFalha: iso(60000), ultimaFalhaResultado: 'credencial_recusada' })] });
  // item 10: id desconhecido no desligar
  p = await post('nao-existe-no-mapa-x/desligar');
  ok(p.status === 404 && /não está no mapa/.test(JSON.stringify(await p.json())), 'desligar id desconhecido: 404 com motivo');
  ok(!fs.existsSync(path.join(pasta, 'preferencias.json')), 'id desconhecido não gravou nada');
  // ligar aceita id que sumiu do mapa (recuperação)
  fs.writeFileSync(path.join(pasta, 'preferencias.json'), '{"desligadas":["sumiu-do-mapa"]}');
  p = await post('sumiu-do-mapa/ligar');
  ok(p.status === 200 && fs.readFileSync(path.join(pasta, 'preferencias.json'), 'utf8').includes('"desligadas": []'), 'ligar remove da lista mesmo id que sumiu do mapa');
  // lista que passaria do limite de leitura: 413
  {
    const ids = []; let n = 0;
    const tam = () => Buffer.byteLength(JSON.stringify({ desligadas: ids }, null, 1) + '\n');
    while (tam() < 65536 - 12) ids.push(`z${String(n++).padStart(5, '0')}`);
    fs.writeFileSync(path.join(pasta, 'preferencias.json'), JSON.stringify({ desligadas: ids }, null, 1) + '\n');
    p = await post('instagram/desligar');
    ok(p.status === 413 && /passaria de/.test(JSON.stringify(await p.json())), 'lista acima de 64 KiB: 413 com motivo');
    ok(JSON.parse(fs.readFileSync(path.join(pasta, 'preferencias.json'), 'utf8')).desligadas.length === ids.length, 'arquivo anterior intacto após o 413');
    fs.rmSync(path.join(pasta, 'preferencias.json'));
  }
  p = await post('Id%20Ruim/desligar');
  ok(p.status === 400 && /howToFix|Use de 1/.test(JSON.stringify(await p.json())), 'id fora do formato no POST: 400 com orientação');
  const cross = await fetch(`${URL_}/api/integracoes/instagram/desligar`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
  ok(cross.status === 403, `POST vindo de outro site é recusado pela proteção de escrita (veio ${cross.status})`);
  // o logo do centro do palco: o painel solto serve o logo padrão do DG Claw em /marca/logo
  const logo = await fetch(`${URL_}/marca/logo`);
  const corpoLogo = await logo.text();
  ok(logo.status === 200 && /svg/.test(logo.headers.get('content-type') || '') && corpoLogo.includes('<svg'), `/marca/logo serve o logo padrão em SVG (veio ${logo.status})`);
} finally {
  filho.kill();
  fs.rmSync(RAIZ, { recursive: true, force: true });
}
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO CERTO');
process.exit(falhas ? 1 : 0);
