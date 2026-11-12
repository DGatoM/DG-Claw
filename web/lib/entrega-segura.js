'use strict';
// Ponte para web/bin/entrega-segura.py: grava e lê arquivos na casa do agente descendo cada pasta com
// O_NOFOLLOW (o agente pode trocar uma pasta por um atalho no meio da operação, e o Web roda como root).
// Sem shell, argumentos em lista, ambiente mínimo.

const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'bin', 'entrega-segura.py');

class ErroEntrega extends Error {
  constructor(status, mensagem, codigo) { super(mensagem); this.status = status; this.codigo = codigo || null; }
}

function rodar(args, python) {
  return new Promise((resolve, reject) => {
    execFile(python || 'python3', ['-I', SCRIPT, ...args], {
      timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' },
    }, (e, saida) => {
      let r = null;
      try { r = JSON.parse(String(saida || '').trim().split('\n').pop()); } catch (_) { /* sem JSON */ }
      if (r && r.ok) return resolve(r);
      if (r && r.erro) return reject(new ErroEntrega(500, r.erro, r.codigo));
      reject(new ErroEntrega(500, `Não consegui rodar a gravação segura de arquivos (${e ? (e.code || e.message) : 'sem resposta'}). Confira se o python3 está instalado no servidor. Nada foi gravado na pasta do agente.`, 'ENTREGA_FALHOU'));
    });
  });
}

/** Grava `origem/<nome>` em `<casa>/uploads/<dia>/`. Devolve os nomes finais (podem ganhar -1, -2...). */
async function entregar({ casa, dia, origem, nomes, python }) {
  return (await rodar(['entregar', casa, dia, origem, ...nomes], python)).nomes;
}

/** Copia `<casa>/<relativo>` para `destino` (arquivo novo numa pasta do root), só se for arquivo comum. */
async function ler({ casa, relativo, destino, maximo, python }) {
  return (await rodar(['ler', casa, relativo, destino, String(maximo)], python)).bytes;
}

module.exports = { entregar, ler, ErroEntrega };
