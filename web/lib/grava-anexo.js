'use strict';
// Grava um anexo na casa do agente SEM privilégio. O Web roda como root no host e a casa é do agente (que roda
// num container e pode trocar qualquer pasta dela por um atalho para fora). Gravar como root seguindo esse atalho
// escreveria em /etc/cron.d, por exemplo. Aqui quem grava é um processo filho com o uid/gid do dono da casa:
// o kernel recusa tudo o que o próprio agente não poderia escrever. Ver grava-anexo-filho.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODIGO_FILHO = fs.readFileSync(path.join(__dirname, 'grava-anexo-filho.js'), 'utf8');
const TEMPO_FILHO_MS = 60000;

class ErroAnexo extends Error {}

/** uid e gid do dono da casa; recusa casa que é atalho. Casa de root só é aceita para o Admin. Lança ErroAnexo em português. */
function donoDaCasa(agente) {
  const home = agente.home_host;
  let st;
  try { st = fs.lstatSync(home); } catch (e) {
    throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) não existe ou não pode ser lida (${e.code || e.name}). Confira o home_host no registro de agentes.`);
  }
  if (st.isSymbolicLink()) throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) é um atalho; recusei gravar por ele. Corrija o home_host no registro de agentes.`);
  if (!st.isDirectory()) throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) não é uma pasta.`);
  if (st.uid === 0 || st.gid === 0) {
    // A casa do Admin é do root por padrão, e o Admin já roda como root no host: não há privilégio a mais para ganhar.
    // Agente de trabalho com casa de root é erro de registro (o Web gravaria como root numa pasta que o agente alcança).
    if (agente.tipo === 'admin') return { uid: st.uid, gid: st.gid, comoRoot: true };
    throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) pertence ao root; recusei gravar anexo ali, porque o Web gravaria como root. Confira o home_host no registro de agentes.`);
  }
  return { uid: st.uid, gid: st.gid };
}

/**
 * Instalações antigas criaram uploads/ (e uploads/<dia>) como root. Antes de chamar o filho, o Web (root) passa SÓ a
 * pasta uploads/ para o dono da casa: abre com O_NOFOLLOW|O_DIRECTORY, confere pelo fstat que é pasta do root e faz
 * fchown no descritor (nunca chown por caminho, nunca recursivo, nunca segue atalho). Pasta do dia que não é do dono
 * não é tocada: devolve outro nome de dia (<dia>-2, <dia>-3...). Nada é apagado nem movido.
 */
function migraUploadsDoRoot(agente, dono, pastas) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || pastas[0] !== 'uploads') return pastas;
  const home = agente.home_host;
  try {
    const fd = fs.openSync(path.join(home, 'uploads'), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (st.isDirectory() && st.uid === 0) fs.fchownSync(fd, dono.uid, dono.gid);
    } finally { fs.closeSync(fd); }
  } catch (_) { /* não existe (o filho cria) ou é atalho (o filho recusa): nada a migrar */ }
  if (pastas.length < 2) return pastas;
  for (let i = 1; i < 100; i += 1) {
    const dia = i === 1 ? pastas[1] : `${pastas[1]}-${i}`;
    let st;
    try { st = fs.lstatSync(path.join(home, 'uploads', dia)); } catch (e) {
      if (e.code === 'ENOENT') return [pastas[0], dia, ...pastas.slice(2)];
      return pastas;
    }
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === dono.uid) return [pastas[0], dia, ...pastas.slice(2)];
  }
  return pastas;
}

/**
 * Gravação no próprio processo (que é root), só para a casa do Admin. Mesmas proteções do filho: pasta a pasta com
 * lstat, recusa de atalho e abertura com O_CREAT|O_EXCL|O_NOFOLLOW.
 */
function gravaComoRoot({ agente, pastas, nome, dados }) {
  const home = agente.home_host;
  let atual = home;
  for (const parte of pastas) {
    atual = path.join(atual, parte);
    let st = null;
    try { st = fs.lstatSync(atual); } catch (e) { if (e.code !== 'ENOENT') throw new ErroAnexo(`Não consegui conferir ${atual} (${e.code || e.name}).`); }
    if (st && st.isSymbolicLink()) throw new ErroAnexo(`${atual} é um atalho (link simbólico); recusei gravar por ele.`);
    if (st && !st.isDirectory()) throw new ErroAnexo(`${atual} existe mas não é uma pasta.`);
    if (!st) fs.mkdirSync(atual, { mode: 0o755 });
  }
  const ext = path.extname(nome);
  const raiz = path.basename(nome, ext);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  for (let i = 0; i < 1000; i += 1) {
    const alvo = path.join(atual, i === 0 ? nome : `${raiz}-${i}${ext}`);
    let fd;
    try { fd = fs.openSync(alvo, flags, 0o644); } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw new ErroAnexo(`Não consegui criar ${alvo} (${e.code || e.name}).`);
    }
    try { fs.writeSync(fd, dados, 0, dados.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return alvo;
  }
  throw new ErroAnexo('Não achei um nome livre para o arquivo.');
}

/**
 * `gravaAnexo({ agente, pastas, nome, dados })`: grava `dados` em <home_host>/<pastas...>/<nome> (com -1, -2 se o nome
 * existir). Devolve o caminho gravado (no host). Rejeita com ErroAnexo ou Error em português.
 */
function gravaAnexo({ agente, pastas, nome, dados }) {
  return new Promise((resolve, reject) => {
    let dono;
    try { dono = donoDaCasa(agente); } catch (e) { reject(e); return; }
    if (dono.comoRoot) {
      try { resolve(gravaComoRoot({ agente, pastas, nome, dados: Buffer.from(dados) })); } catch (e) { reject(e instanceof ErroAnexo ? e : new ErroAnexo(`Não consegui gravar o arquivo (${e.code || e.message}).`)); }
      return;
    }
    pastas = migraUploadsDoRoot(agente, dono, pastas);
    const opcoes = { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '' } };
    // Só troca de usuário quando precisa: se o Web já roda como o dono da casa (teste, instalação sem root), nada a trocar.
    if (typeof process.getuid === 'function' && (process.getuid() !== dono.uid || process.getgid() !== dono.gid)) { opcoes.uid = dono.uid; opcoes.gid = dono.gid; }
    const filho = spawn(process.execPath, ['-e', CODIGO_FILHO], opcoes);
    const saida = [];
    let terminou = false;
    const fim = (fn, v) => { if (terminou) return; terminou = true; clearTimeout(relogio); fn(v); };
    const relogio = setTimeout(() => { filho.kill('SIGKILL'); fim(reject, new ErroAnexo(`O gravador demorou mais de ${TEMPO_FILHO_MS / 1000} s e foi interrompido.`)); }, TEMPO_FILHO_MS);
    filho.stdout.on('data', (c) => saida.push(c));
    filho.stderr.on('data', () => { /* sem detalhe de arquivo no log */ });
    filho.stdin.on('error', () => { /* o filho pode ter fechado antes de ler tudo; o resultado vem do close */ });
    filho.on('error', (e) => fim(reject, new ErroAnexo(`Não consegui iniciar o gravador como o dono da casa (uid ${dono.uid}, gid ${dono.gid}): ${e.code || e.name}.`)));
    filho.on('close', (codigo) => {
      let r = null;
      try { r = JSON.parse(Buffer.concat(saida).toString('utf8')); } catch (_) { /* sem JSON */ }
      if (codigo === 0 && r && r.ok === true) return fim(resolve, r.caminho);
      return fim(reject, new ErroAnexo(r && r.erro ? r.erro : `O gravador terminou com código ${codigo} sem explicar.`));
    });
    filho.stdin.end(JSON.stringify({ home: agente.home_host, pastas, nome, dados: Buffer.from(dados).toString('base64') }));
  });
}

module.exports = { gravaAnexo, donoDaCasa, ErroAnexo };
