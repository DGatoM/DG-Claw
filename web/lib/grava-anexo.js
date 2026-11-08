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

/** uid e gid do dono da casa; recusa casa de root e casa que é atalho. Lança ErroAnexo em português. */
function donoDaCasa(agente) {
  const home = agente.home_host;
  let st;
  try { st = fs.lstatSync(home); } catch (e) {
    throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) não existe ou não pode ser lida (${e.code || e.name}). Confira o home_host no registro de agentes.`);
  }
  if (st.isSymbolicLink()) throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) é um atalho; recusei gravar por ele. Corrija o home_host no registro de agentes.`);
  if (!st.isDirectory()) throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) não é uma pasta.`);
  if (st.uid === 0 || st.gid === 0) throw new ErroAnexo(`A casa do agente ${agente.nome} (${home}) pertence ao root; recusei gravar anexo ali, porque o Web gravaria como root. Confira o home_host no registro de agentes.`);
  return { uid: st.uid, gid: st.gid };
}

/**
 * `gravaAnexo({ agente, pastas, nome, dados })`: grava `dados` em <home_host>/<pastas...>/<nome> (com -1, -2 se o nome
 * existir). Devolve o caminho gravado (no host). Rejeita com ErroAnexo ou Error em português.
 */
function gravaAnexo({ agente, pastas, nome, dados }) {
  return new Promise((resolve, reject) => {
    let dono;
    try { dono = donoDaCasa(agente); } catch (e) { reject(e); return; }
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
