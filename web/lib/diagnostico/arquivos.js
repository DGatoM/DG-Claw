'use strict';
// Leitura de arquivos da casa do agente. A casa é do agente (container sem root) e o Web lê como root:
// qualquer caminho lá dentro pode ter virado link para /etc/dgclaw, para o cofre ou para a chave do runner.
// Por isso a leitura só passa se o caminho real ficar dentro da casa, se for arquivo comum, e só traz o fim.

const fs = require('node:fs');
const path = require('node:path');

const LIMITE_PADRAO = 256 * 1024;

/**
 * Lê no máximo os últimos `max` bytes de <home>/<relativo>.
 * Devolve { estado:'ok', texto, tamanho, mtimeMs } | { estado:'ausente' } | { estado:'invalido', motivo }.
 * O motivo nunca cita o destino de um link, só o que há de errado.
 */
function lerSeguro(home, relativo, opcoes) {
  const max = (opcoes && opcoes.max) || LIMITE_PADRAO;
  if (!home || typeof home !== 'string') return { estado: 'invalido', motivo: 'o registro não informa a pasta do agente' };
  if (path.isAbsolute(relativo) || relativo.split(/[\\/]/).includes('..')) {
    return { estado: 'invalido', motivo: 'caminho relativo inválido (erro do diagnóstico)' };
  }
  let casa;
  let real;
  try { casa = fs.realpathSync(home); } catch (e) {
    return { estado: 'invalido', motivo: `não consegui abrir a pasta do agente (${e.code || e.name})` };
  }
  try { real = fs.realpathSync(path.join(home, relativo)); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { estado: 'ausente' };
    return { estado: 'invalido', motivo: `não consegui abrir o arquivo (${e.code || e.name})` };
  }
  if (real !== casa && !real.startsWith(casa + path.sep)) {
    return { estado: 'invalido', motivo: 'o arquivo aponta para fora da pasta do agente, então não foi lido' };
  }
  let fd;
  try {
    // O_NOFOLLOW: se alguém trocar o arquivo por um link entre a checagem e a abertura, a abertura falha.
    // O_NONBLOCK: um arquivo especial (fila, dispositivo) não pode prender o Web esperando.
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    // O_NOFOLLOW só protege o último pedaço do caminho: uma pasta no meio pode virar link depois do realpath.
    // O caminho que o kernel realmente abriu fica em /proc/self/fd, e é ele que precisa estar dentro da casa.
    let aberto = null;
    try { aberto = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch (_) { aberto = null; /* sem /proc (fora do Linux): vale a checagem do realpath */ }
    if (aberto !== null && aberto !== casa && !aberto.startsWith(casa + path.sep)) {
      return { estado: 'invalido', motivo: 'o arquivo aponta para fora da pasta do agente, então não foi lido' };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { estado: 'invalido', motivo: 'o caminho não é um arquivo comum' };
    const inicio = Math.max(0, st.size - max);
    const buf = Buffer.alloc(st.size - inicio);
    let lidos = 0;
    while (lidos < buf.length) {
      const n = fs.readSync(fd, buf, lidos, buf.length - lidos, inicio + lidos);
      if (n === 0) break;
      lidos += n;
    }
    let texto = buf.subarray(0, lidos).toString('utf8');
    if (inicio > 0) texto = texto.replace(/^[^\n]*\n/, ''); // a primeira linha do corte vem partida
    return { estado: 'ok', texto, tamanho: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { estado: 'invalido', motivo: `não consegui ler o arquivo (${e.code || e.name})` };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* o descritor já estava fechado */ } }
  }
}

/** Como lerSeguro, mas já interpreta JSON de objeto. JSON inválido vira { estado:'invalido' }. */
function lerJsonSeguro(lerArquivo, home, relativo, opcoes) {
  const r = lerArquivo(home, relativo, opcoes);
  if (r.estado !== 'ok') return r;
  try {
    const dados = JSON.parse(r.texto);
    if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return { estado: 'invalido', motivo: 'o arquivo não tem o formato esperado (objeto JSON)' };
    return Object.assign({}, r, { dados });
  } catch (_) {
    return { estado: 'invalido', motivo: 'o arquivo não é um JSON válido' };
  }
}

module.exports = { lerSeguro, lerJsonSeguro, LIMITE_PADRAO };
