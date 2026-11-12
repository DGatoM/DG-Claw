'use strict';
// Roda como processo filho, JÁ com o uid/gid do dono da casa do agente (quem chama usa spawn com uid e gid).
// Lê do stdin um JSON { home, pastas: [...], nome, dados (base64) }. Cria as pastas uma a uma (mkdir) e grava o
// arquivo com O_CREAT|O_EXCL|O_NOFOLLOW. Como o processo NÃO é root, o kernel só deixa escrever onde o agente já
// pode escrever: um atalho que o agente plante no caminho (para /etc/cron.d, por exemplo) não leva a gravação para fora.
// Imprime só {"ok":true,"caminho":"..."} ou {"ok":false,"erro":"..."}; nunca o conteúdo.

const fs = require('node:fs');
const path = require('node:path');

process.umask(0o022);
function saida(o) { process.stdout.write(JSON.stringify(o)); }

function pasta(dir) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (st && st.isSymbolicLink()) throw new Error(`${dir} é um atalho (link simbólico); recusei gravar por ele`);
  if (st && !st.isDirectory()) throw new Error(`${dir} existe mas não é uma pasta`);
  if (!st) fs.mkdirSync(dir, { mode: 0o755 });
}

function principal(p) {
  if (!p || typeof p.home !== 'string' || !path.isAbsolute(p.home) || !Array.isArray(p.pastas) || typeof p.nome !== 'string' || typeof p.dados !== 'string') {
    throw new Error('pedido de gravação malformado');
  }
  if (p.nome !== path.basename(p.nome) || !p.nome || p.nome === '.' || p.nome === '..') throw new Error('nome de arquivo inválido');
  const casa = fs.lstatSync(p.home);
  if (casa.isSymbolicLink() || !casa.isDirectory()) throw new Error(`${p.home} não é uma pasta comum (é atalho ou outra coisa)`);
  let atual = p.home;
  for (const parte of p.pastas) {
    if (typeof parte !== 'string' || !parte || parte !== path.basename(parte) || parte === '.' || parte === '..') throw new Error('nome de pasta inválido');
    atual = path.join(atual, parte);
    pasta(atual);
  }
  const dados = Buffer.from(p.dados, 'base64');
  const ext = path.extname(p.nome);
  const raiz = path.basename(p.nome, ext);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  for (let i = 0; i < 1000; i += 1) {
    const alvo = path.join(atual, i === 0 ? p.nome : `${raiz}-${i}${ext}`);
    let fd;
    try { fd = fs.openSync(alvo, flags, 0o644); } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try { fs.writeSync(fd, dados, 0, dados.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return alvo;
  }
  throw new Error('não achei um nome livre para o arquivo');
}

const partes = [];
process.stdin.on('data', (c) => partes.push(c));
process.stdin.on('end', () => {
  try {
    const caminho = principal(JSON.parse(Buffer.concat(partes).toString('utf8')));
    saida({ ok: true, caminho });
  } catch (e) {
    saida({ ok: false, erro: `${e.message}${e.code ? ` (${e.code})` : ''}` });
    process.exitCode = 1;
  }
});
