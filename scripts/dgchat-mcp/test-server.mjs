// test-server.mjs - Bancada do servidor MCP do DG Chat.
//
// Fala JSON-RPC no stdio do server.mjs de verdade, em subprocesso, do jeito que o
// Claude Code fala. Nada de importar funcao solta: o que quebra num servidor de
// stdio quase nunca e a logica, e sim o enquadramento (linha partida, ruido no
// stdin, notificacao sem id) e o texto que volta pro agente.
//
// O caso que da nome a esta bancada e o 8: no modo "transcript" (DG Claw sozinho,
// que e a VPS da aluna) a entrega JA ACONTECEU quando a tool foi chamada, porque a
// chamada fica no transcript e o painel le de la. Se o registro de entrega falhar,
// responder "NAO ENTREGUEI" faria o agente repetir uma mensagem que chegou. Foi
// exatamente essa frase, copiada da plataforma sem pensar, que este arquivo existe
// para impedir de voltar.
//
// Uso: node scripts/dgchat-mcp/test-server.mjs
//   (sem dependencia nenhuma; roda em qualquer VPS de aluna)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SERVIDOR = path.join(AQUI, 'server.mjs');

let falhas = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const falhou = (msg) => { console.error(`❌ ${msg}`); falhas++; };

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dgchat-mcp-'));

/**
 * Sobe o servidor, manda as linhas, devolve as respostas em ordem.
 *
 * Cada caso sobe o seu: o modo (transcript x plataforma) e decidido por ambiente
 * no boot, entao reaproveitar um processo entre casos testaria um servidor so.
 */
function conversar(linhas, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVIDOR], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let saida = '';
    let erro = '';
    p.stdout.on('data', (b) => { saida += b; });
    p.stderr.on('data', (b) => { erro += b; });
    p.on('error', reject);
    p.on('close', () => {
      const respostas = saida.split('\n').filter((l) => l.trim()).map((l) => {
        try { return JSON.parse(l); } catch { return { __naoEhJson: l }; }
      });
      resolve({ respostas, erro });
    });
    for (const l of linhas) p.stdin.write(typeof l === 'string' ? l + '\n' : JSON.stringify(l) + '\n');
    p.stdin.end();
    setTimeout(() => p.kill('SIGKILL'), 20000).unref();
  });
}

const chamar = (nome, args, id = 1) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name: nome, arguments: args },
});

/** Um caso com casa propria, para o outbound de um nao contaminar o do outro. */
function casa(nome) {
  const dir = path.join(raiz, nome);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, outbound: path.join(dir, 'outbound.jsonl') };
}

const linhasDo = (arquivo) =>
  (fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : '')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// ── 1. initialize ───────────────────────────────────────────────────────────
{
  const { respostas } = await conversar([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  ], { DGCHAT_AGENT: 'ana' });
  const r = respostas[0];
  if (r?.result?.serverInfo?.name === 'dgchat' && r.result.capabilities?.tools) {
    ok('1. initialize se apresenta como "dgchat" e anuncia tools');
  } else {
    falhou(`1. initialize devolveu ${JSON.stringify(r)}`);
  }
}

// ── 2. tools/list ───────────────────────────────────────────────────────────
// O nome importa: o thread_log.py casa "__dgchat__reply" e "__dgchat__send_file"
// por sufixo. Renomear uma tool aqui deixa a conversa muda sem erro nenhum.
{
  const { respostas } = await conversar([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const nomes = (respostas[0]?.result?.tools || []).map((t) => t.name).sort();
  if (JSON.stringify(nomes) === JSON.stringify(['reply', 'send_file'])) {
    ok('2. tools/list traz exatamente reply e send_file (os nomes que o thread_log.py casa)');
  } else {
    falhou(`2. tools/list trouxe ${JSON.stringify(nomes)}`);
  }
}

// ── 3. reply sem chat ───────────────────────────────────────────────────────
{
  const { respostas } = await conversar([chamar('reply', { text: 'oi' })]);
  const r = respostas[0]?.result;
  if (r?.isError && /envelope/.test(r.content?.[0]?.text || '')) {
    ok('3. reply sem "chat" recusa e ensina onde achar o valor');
  } else {
    falhou(`3. reply sem chat devolveu ${JSON.stringify(r)}`);
  }
}

// ── 4. reply vazio e reply gigante ──────────────────────────────────────────
{
  const { outbound } = casa('vazio');
  const { respostas } = await conversar([
    chamar('reply', { chat: 'c_ana', text: '   ' }, 1),
    chamar('reply', { chat: 'c_ana', text: 'x'.repeat(32_001) }, 2),
  ], { DGCHAT_OUTBOUND: outbound });
  const vazio = respostas.find((r) => r.id === 1)?.result;
  const gigante = respostas.find((r) => r.id === 2)?.result;
  if (vazio?.isError && gigante?.isError && /send_file/.test(gigante.content?.[0]?.text || '')) {
    ok('4. texto vazio e texto acima de 32k sao recusados, e o gigante aponta a saida (send_file)');
  } else {
    falhou(`4. vazio=${JSON.stringify(vazio)} gigante=${JSON.stringify(gigante)}`);
  }
  if (linhasDo(outbound).length === 0) {
    ok('4b. o que foi recusado nao entra no registro de entrega');
  } else {
    falhou('4b. mensagem recusada acabou registrada como entregue');
  }
}

// ── 5. reply bom, modo transcript ───────────────────────────────────────────
// Sem DGCHAT_URL. Este e o caso da aluna, e a resposta tem que ser entrega seca:
// nada de "a pessoa ve quando a janela reconectar", que aqui seria mentira.
{
  const { outbound } = casa('reply-ok');
  const { respostas } = await conversar([
    chamar('reply', { chat: 'c_ana', text: 'Ja estou vendo isso.' }),
  ], { DGCHAT_AGENT: 'ana', DGCHAT_OUTBOUND: outbound });
  const r = respostas[0]?.result;
  const texto = r?.content?.[0]?.text || '';
  if (!r?.isError && /entregue/i.test(texto) && !/reconect/i.test(texto)) {
    ok('5. modo transcript: reply responde "entregue", sem prometer reconexao de janela');
  } else {
    falhou(`5. modo transcript devolveu ${JSON.stringify(r)}`);
  }
  const [linha] = linhasDo(outbound);
  if (linha?.kind === 'text' && linha.chat === 'c_ana' && linha.agent === 'ana'
      && linha.modo === 'transcript' && linha.source === 'tool:reply' && linha.ts) {
    ok('5b. o registro de entrega guarda ts, agente, chat, origem e modo');
  } else {
    falhou(`5b. registro saiu ${JSON.stringify(linha)}`);
  }
}

// ── 6. send_file ────────────────────────────────────────────────────────────
{
  const { dir, outbound } = casa('arquivo');
  const arquivo = path.join(dir, 'relatorio.txt');
  fs.writeFileSync(arquivo, 'conteudo\n');
  const { respostas } = await conversar([
    chamar('send_file', { chat: 'c_ana', path: path.join(dir, 'nao-existe.pdf') }, 1),
    chamar('send_file', { chat: 'c_ana', path: dir }, 2),
    chamar('send_file', { chat: 'c_ana', path: arquivo, caption: 'o relatorio' }, 3),
  ], { DGCHAT_AGENT: 'ana', DGCHAT_OUTBOUND: outbound });
  const inexistente = respostas.find((r) => r.id === 1)?.result;
  const pasta = respostas.find((r) => r.id === 2)?.result;
  const bom = respostas.find((r) => r.id === 3)?.result;
  if (inexistente?.isError && pasta?.isError && !bom?.isError) {
    ok('6. send_file recusa caminho que nao existe e pasta, e aceita arquivo de verdade');
  } else {
    falhou(`6. inexistente=${!!inexistente?.isError} pasta=${!!pasta?.isError} bom=${JSON.stringify(bom)}`);
  }
  const registros = linhasDo(outbound);
  const reg = registros[0];
  if (registros.length === 1 && reg?.kind === 'file' && reg.path === arquivo
      && reg.size === 9 && reg.caption === 'o relatorio') {
    ok('6b. so o arquivo entregue e registrado, com caminho, tamanho e legenda');
  } else {
    falhou(`6b. registros=${JSON.stringify(registros)}`);
  }
}

// ── 7. modo plataforma com o servidor fora do ar ────────────────────────────
// Aqui a frase da plataforma esta CERTA: gravou, nao empurrou, entao e atraso e
// nao perda. O agente precisa da diferenca para nao reenviar.
{
  const { outbound } = casa('plataforma-fora');
  const { respostas } = await conversar([
    chamar('reply', { chat: 'c_ana', text: 'oi' }),
  ], {
    DGCHAT_AGENT: 'ana',
    DGCHAT_OUTBOUND: outbound,
    // porta fechada de proposito: ninguem escuta na 9 (discard) por TCP aqui
    DGCHAT_URL: 'http://127.0.0.1:9',
  });
  const r = respostas[0]?.result;
  const texto = r?.content?.[0]?.text || '';
  if (!r?.isError && /registrado para entrega/i.test(texto) && /n[aã]o repita/i.test(texto)) {
    ok('7. modo plataforma sem servidor: nao e falha, e atraso, e a tool manda nao repetir');
  } else {
    falhou(`7. modo plataforma devolveu ${JSON.stringify(r)}`);
  }
  if (linhasDo(outbound)[0]?.modo === 'plataforma') {
    ok('7b. o registro sabe em que modo a entrega saiu');
  } else {
    falhou('7b. o registro nao marcou o modo plataforma');
  }
}

// ── 8. O CASO QUE DA NOME A ESTA BANCADA ────────────────────────────────────
// Modo transcript com o registro impossivel de gravar (outbound apontando para
// dentro de um ARQUIVO, entao o mkdir falha). A entrega ja aconteceu na chamada.
// Responder isError aqui e o bug: o agente repete a mensagem para a pessoa.
{
  const { dir } = casa('registro-quebrado');
  const bloqueio = path.join(dir, 'bloqueio');
  fs.writeFileSync(bloqueio, 'sou um arquivo, nao uma pasta\n');
  const { respostas } = await conversar([
    chamar('reply', { chat: 'c_ana', text: 'o resultado ficou pronto' }),
  ], { DGCHAT_AGENT: 'ana', DGCHAT_OUTBOUND: path.join(bloqueio, 'outbound.jsonl') });
  const r = respostas[0]?.result;
  const texto = r?.content?.[0]?.text || '';
  if (!r?.isError && /entregue/i.test(texto) && /n[aã]o repita/i.test(texto)) {
    ok('8. registro quebrado NAO desmente a entrega: a pessoa recebeu, e a tool manda nao repetir');
  } else {
    falhou(`8. registro quebrado devolveu ${JSON.stringify(r)} (isso faria o agente repetir)`);
  }
  if (/registro de entrega falhou/i.test(texto)) {
    ok('8b. e mesmo assim conta que o log parou de gravar, em vez de engolir');
  } else {
    falhou('8b. a falha do registro sumiu sem ninguem ficar sabendo');
  }
}

// ── 9. tool desconhecida ────────────────────────────────────────────────────
{
  const { respostas } = await conversar([chamar('mandar_email', { chat: 'c_ana' })]);
  const r = respostas[0]?.result;
  if (r?.isError && /reply/.test(r.content?.[0]?.text || '')) {
    ok('9. tool desconhecida recusa dizendo quais existem');
  } else {
    falhou(`9. tool desconhecida devolveu ${JSON.stringify(r)}`);
  }
}

// ── 10. enquadramento: ruido, notificacao e metodo estranho ─────────────────
// Ruido no stdin acontece de verdade (um `console.log` perdido em qualquer lugar
// da arvore vira linha no stdio do MCP). Derrubar o servidor por causa disso
// deixaria o agente mudo pelo resto da sessao.
{
  const { respostas, erro } = await conversar([
    'isto nao e json',
    '',
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 7, method: 'resources/list' },
    chamar('reply', { chat: 'c_ana', text: 'sobrevivi' }, 8),
  ], { DGCHAT_OUTBOUND: casa('ruido').outbound });
  const ids = respostas.map((r) => r.id);
  const ultimo = respostas.find((r) => r.id === 8)?.result;
  if (JSON.stringify(ids) === JSON.stringify([7, 8]) && !ultimo?.isError) {
    ok('10. ruido e notificacao sem id nao viram resposta nem derrubam o servidor');
  } else {
    falhou(`10. ids=${JSON.stringify(ids)} erro=${erro.slice(0, 200)}`);
  }
}

fs.rmSync(raiz, { recursive: true, force: true });

console.log('');
if (falhas) {
  console.error(`${falhas} verificacao(oes) falharam.`);
  process.exit(1);
}
console.log('Bancada do canal DG Chat: tudo verde.');
