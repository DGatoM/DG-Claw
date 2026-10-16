'use strict';
// Roda como processo filho, JÁ com o uid/gid do agente (quem chama usa spawn com uid e gid).
// Lê do stdin um JSON {"token": "..."}; a casa do agente vem em HOME_ALVO.
// Como roda como o agente, o kernel só deixa escrever onde o agente já pode escrever:
// um atalho trocado no meio do caminho não leva o token para fora da casa dele.
// Imprime no stdout só {"ok":true} ou {"ok":false,"erro":"..."} (nunca o token).

const fs = require('node:fs');
const path = require('node:path');

const CHAVE = 'TELEGRAM_BOT_TOKEN';
process.umask(0o077);

function saida(o) { process.stdout.write(JSON.stringify(o)); }

function garantePasta(dir) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && !st.isDirectory()) throw new Error(`${dir} existe mas não é uma pasta (ou é um atalho). Remova ou mova esse item para o token poder ser guardado ali`);
  if (!st) fs.mkdirSync(dir, { mode: 0o700 });
  else fs.chmodSync(dir, 0o700);
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function principal(token, home) {
  const dotdg = path.join(home, '.dgclaw');
  const tg = path.join(dotdg, 'telegram');
  garantePasta(dotdg);
  garantePasta(tg);
  const env = path.join(tg, '.env');
  let atual = '';
  try { atual = fs.readFileSync(env, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const linhas = atual.split('\n').filter((l) => l.trim() !== '' && !/^\s*(export\s+)?TELEGRAM_BOT_TOKEN\s*=/.test(l));
  linhas.unshift(`${CHAVE}=${token}`);
  const tmp = path.join(tg, `.env.tmp-${process.pid}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, `${linhas.join('\n')}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, env); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* já sumiu */ } throw e; }
  fsyncDir(tg);
}

const partes = [];
process.stdin.on('data', (c) => partes.push(c));
process.stdin.on('end', () => {
  let token = '';
  try {
    const entrada = JSON.parse(Buffer.concat(partes).toString('utf8'));
    token = typeof entrada.token === 'string' ? entrada.token : '';
    const home = process.env.HOME_ALVO || '';
    if (!token || !home) throw new Error('faltou o token ou a casa do agente na entrada do gravador');
    principal(token, home);
    saida({ ok: true });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    saida({ ok: false, erro: token ? msg.split(token).join('[token]') : msg });
    process.exitCode = 1;
  }
});
