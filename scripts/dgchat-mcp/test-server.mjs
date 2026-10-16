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
import net from 'node:net';
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
  if (JSON.stringify(nomes) === JSON.stringify(['reply', 'send_file', 'whatsapp_reply', 'whatsapp_send_file'])) {
    ok('2. tools/list traz reply, send_file e as duas do WhatsApp (os nomes que o thread_log.py casa)');
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

// ── 11 a 17. WhatsApp: tools que falam com o socket da ponte ────────────────
/** Servidor unix falso: guarda cada linha recebida e responde o que o caso mandar. */
function pontaFalsa(arquivo, resposta) {
  const recebidas = [];
  const srv = net.createServer((c) => {
    let b = '';
    c.on('data', (d) => {
      b += d;
      const i = b.indexOf('\n');
      if (i < 0) return;
      recebidas.push(b.slice(0, i));
      b = '';
      const r = typeof resposta === 'function' ? resposta() : resposta;
      if (r === null) return; // nao responde nunca (caso de timeout/travado)
      c.end(r + '\n');
    });
    c.on('error', () => {});
  });
  return new Promise((res) => srv.listen(arquivo, () => res({ srv, recebidas })));
}
const texto0 = (r) => r?.content?.[0]?.text || '';
const dirSock = fs.mkdtempSync(path.join(os.tmpdir(), 'dgwa-'));

// 11. socket ausente
{
  const { outbound } = casa('wa-ausente');
  const { respostas } = await conversar([
    chamar('whatsapp_reply', { texto: 'oi' }, 1),
    chamar('whatsapp_send_file', { caminho: '/etc/hostname' }, 2),
  ], { DGCLAW_WHATSAPP_SOCK: path.join(dirSock, 'nao-existe.sock'), DGCHAT_OUTBOUND: outbound });
  const a = respostas.find((r) => r.id === 1)?.result;
  const b = respostas.find((r) => r.id === 2)?.result;
  if (a?.isError && b?.isError && /O WhatsApp está desligado; fale pelo chat do DG Claw \(tool reply\)/.test(texto0(a) + texto0(b))) {
    ok('11. socket ausente: as duas tools falham dizendo que o WhatsApp esta desligado');
  } else {
    falhou(`11. ausente devolveu ${JSON.stringify([a, b])}`);
  }
  if (linhasDo(outbound).length === 0) ok('11b. falha nao entra no registro de entrega');
  else falhou('11b. falha foi registrada como entrega');
}

// 12. socket presente, ok:true, e a linha que chegou
{
  const sock = path.join(dirSock, 'ok.sock');
  const { srv, recebidas } = await pontaFalsa(sock, JSON.stringify({ ok: true, para: '+5511987654321', id: 'ABC' }));
  const { dir, outbound } = casa('wa-ok');
  const arq = path.join(dir, 'a.pdf');
  fs.writeFileSync(arq, 'x');
  const { respostas } = await conversar([
    chamar('whatsapp_reply', { texto: 'ola', para: '+5511987654321' }, 1),
    chamar('whatsapp_reply', { texto: 'sem destino' }, 2),
    chamar('whatsapp_send_file', { caminho: arq, legenda: 'o pdf' }, 3),
    chamar('whatsapp_send_file', { caminho: arq }, 4),
  ], { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_OUTBOUND: outbound, DGCHAT_AGENT: 'ana' });
  srv.close();
  const r1 = respostas.find((r) => r.id === 1)?.result;
  const r3 = respostas.find((r) => r.id === 3)?.result;
  if (!r1?.isError && /Mensagem entregue no WhatsApp de \+5511987654321/.test(texto0(r1))
      && !r3?.isError && /Arquivo entregue no WhatsApp de \+5511987654321/.test(texto0(r3))) {
    ok('12. ponte responde ok: as tools dizem "entregue no WhatsApp de +55..."');
  } else {
    falhou(`12. ok devolveu ${JSON.stringify([r1, r3])}`);
  }
  const l = recebidas.map((x) => JSON.parse(x));
  if (l[0].acao === 'enviar' && l[0].para === '+5511987654321' && l[0].texto === 'ola' && Object.keys(l[0]).length === 3) {
    ok('12b. a linha JSON de enviar chegou na ponte como o contrato manda');
  } else falhou(`12b. enviar chegou ${JSON.stringify(l[0])}`);
  if (!('para' in l[1])) ok('12c. "para" omitido nao vai na linha');
  else falhou(`12c. para vazio foi enviado: ${JSON.stringify(l[1])}`);
  if (l[2].acao === 'arquivo' && l[2].caminho === arq && l[2].legenda === 'o pdf' && Object.keys(l[2]).length === 3
      && !('legenda' in l[3]) && !('para' in l[3])) {
    ok('12d. arquivo chega com legenda quando ha, sem legenda e sem para quando nao ha');
  } else falhou(`12d. arquivo chegou ${JSON.stringify(l.slice(2))}`);
  const regs = linhasDo(outbound);
  if (regs.length === 4 && regs[0].kind === 'whatsapp_text' && regs[0].source === 'tool:whatsapp_reply'
      && regs[2].kind === 'whatsapp_file' && regs[2].source === 'tool:whatsapp_send_file') {
    ok('12e. o registro de entrega leva kind e source do WhatsApp');
  } else falhou(`12e. registros ${JSON.stringify(regs)}`);
}

// 13. ok:false
{
  const sock = path.join(dirSock, 'nao.sock');
  const { srv } = await pontaFalsa(sock, JSON.stringify({ ok: false, codigo: 'FORA_DA_LISTA', erro: 'o numero nao esta na lista' }));
  const { outbound } = casa('wa-nao');
  const { respostas } = await conversar([chamar('whatsapp_reply', { texto: 'oi', para: '+5511900000000' })],
    { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_OUTBOUND: outbound });
  srv.close();
  const r = respostas[0]?.result;
  if (r?.isError && /NÃO foi entregue/.test(texto0(r)) && /FORA_DA_LISTA/.test(texto0(r)) && /o numero nao esta na lista/.test(texto0(r))) {
    ok('13. ok:false vira falha com o codigo e o erro da ponte, dizendo que NAO foi entregue');
  } else falhou(`13. ok:false devolveu ${JSON.stringify(r)}`);
  if (linhasDo(outbound).length === 0) ok('13b. recusa da ponte nao entra no registro');
  else falhou('13b. recusa registrada como entrega');
}

// 14. resposta que nao e JSON
{
  const sock = path.join(dirSock, 'lixo.sock');
  const { srv } = await pontaFalsa(sock, 'isto nao e json');
  const { respostas } = await conversar([chamar('whatsapp_reply', { texto: 'oi' })],
    { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_OUTBOUND: casa('wa-lixo').outbound });
  srv.close();
  const r = respostas[0]?.result;
  if (r?.isError && /não repita às cegas/i.test(texto0(r)) && /pode ou não ter saído/i.test(texto0(r))) {
    ok('14. resposta que nao e JSON: falha explicando que pode ou nao ter saido');
  } else falhou(`14. nao-JSON devolveu ${JSON.stringify(r)}`);
}

// 15. sessao paralela recusa e nem toca no socket
{
  const sock = path.join(dirSock, 'par.sock');
  const { srv, recebidas } = await pontaFalsa(sock, JSON.stringify({ ok: true, para: '+5511987654321', id: 'X' }));
  const { respostas } = await conversar([
    chamar('whatsapp_reply', { texto: 'oi' }, 1),
    chamar('whatsapp_send_file', { caminho: '/etc/hostname' }, 2),
  ], { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_SESSAO_ID: 's_2', DGCHAT_OUTBOUND: casa('wa-par').outbound });
  srv.close();
  const rs = respostas.map((r) => r.result);
  if (rs.every((r) => r?.isError && /Só a sessão principal fala pelo WhatsApp\. Responda pelo reply do chat desta sessão\./.test(texto0(r)))
      && recebidas.length === 0) {
    ok('15. sessao paralela: as duas recusam e nada chega na ponte');
  } else falhou(`15. paralela devolveu ${JSON.stringify(rs)} recebidas=${recebidas.length}`);
}

// 16. sem chat as do WhatsApp funcionam; reply continua exigindo chat
{
  const sock = path.join(dirSock, 'semchat.sock');
  const { srv } = await pontaFalsa(sock, JSON.stringify({ ok: true, para: '+5511987654321', id: 'Y' }));
  const { respostas } = await conversar([
    chamar('whatsapp_reply', { texto: 'sem chat' }, 1),
    chamar('reply', { text: 'sem chat' }, 2),
  ], { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_OUTBOUND: casa('wa-semchat').outbound });
  srv.close();
  const a = respostas.find((r) => r.id === 1)?.result;
  const b = respostas.find((r) => r.id === 2)?.result;
  if (!a?.isError && b?.isError && /envelope/.test(texto0(b))) {
    ok('16. whatsapp_reply nao exige chat, e o reply continua exigindo');
  } else falhou(`16. semchat devolveu ${JSON.stringify([a, b])}`);
}

// 17. validacoes antes do socket
{
  const sock = path.join(dirSock, 'valida.sock');
  const { srv, recebidas } = await pontaFalsa(sock, JSON.stringify({ ok: true, para: '+55', id: 'Z' }));
  const { respostas } = await conversar([
    chamar('whatsapp_reply', { texto: '  ' }, 1),
    chamar('whatsapp_reply', { texto: 'x'.repeat(32_001) }, 2),
    chamar('whatsapp_send_file', { caminho: 'relativo.pdf' }, 3),
    chamar('whatsapp_send_file', { caminho: '/tmp/nao-existe-nunca.pdf' }, 4),
  ], { DGCLAW_WHATSAPP_SOCK: sock, DGCHAT_OUTBOUND: casa('wa-valida').outbound });
  srv.close();
  const rs = [1, 2, 3, 4].map((i) => respostas.find((r) => r.id === i)?.result);
  if (rs.every((r) => r?.isError) && recebidas.length === 0 && /absoluto/.test(texto0(rs[2])) && /não existe/.test(texto0(rs[3]))) {
    ok('17. texto vazio, texto gigante, caminho relativo e inexistente sao recusados antes do socket');
  } else falhou(`17. validacao devolveu ${JSON.stringify(rs)} recebidas=${recebidas.length}`);
}

fs.rmSync(dirSock, { recursive: true, force: true });

fs.rmSync(raiz, { recursive: true, force: true });

console.log('');
if (falhas) {
  console.error(`${falhas} verificacao(oes) falharam.`);
  process.exit(1);
}
console.log('Bancada do canal DG Chat: tudo verde.');
