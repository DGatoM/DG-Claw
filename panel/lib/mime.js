// mime.js — o tipo de um arquivo pela extensão do nome.
//
// POR QUE ISTO É UM MÓDULO E NÃO UMA TABELA DENTRO DE CADA TELA. Duas partes do
// painel servem arquivo do disco para o navegador: a prévia dos assets (aba Apps)
// e o download da aba Pasta. Com uma tabela em cada lugar, um dia o webp abre numa
// tela e vira download na outra, sem ninguém ter decidido isso.
//
// POR QUE A TABELA É CURTA E EXPLÍCITA. O que não está aqui desce como
// `application/octet-stream`, e o navegador oferece para salvar em vez de tentar
// abrir. Adivinhar o tipo lendo o começo do arquivo seria mais esperto e também
// seria uma porta para servir, com o tipo que o navegador executa, qualquer coisa
// que caia na pasta do agente.

const path = require('path');

const MIME_POR_EXT = {
  // imagem
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  // vídeo
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // áudio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  // documento e dado
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** A extensão em minúsculas, sem o ponto. String vazia quando não há extensão. */
function extDe(nome) {
  return path.extname(String(nome || '')).toLowerCase().replace('.', '');
}

function mimeDaExt(ext) {
  return MIME_POR_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * A família do arquivo, que é o que a TELA usa para decidir como mostrar.
 *
 * É mais grosso que o mime de propósito: a tela não precisa saber a diferença
 * entre mp4 e webm, precisa saber que os dois entram num `<video controls>`.
 */
function tipoDaExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(e)) return 'imagem';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(e)) return 'video';
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  return 'arquivo';
}

/**
 * O `Content-Disposition` de uma resposta que serve arquivo.
 *
 * O nome vai DUAS vezes: `filename=` com o que couber em ASCII, para o navegador
 * velho, e `filename*=` com o nome de verdade, acentos e tudo. Aspas e barras são
 * arrancadas do primeiro porque um nome com aspas quebraria o cabeçalho ao meio.
 */
function disposicao(nome, comoAnexo) {
  const seguro = String(nome || 'arquivo').replace(/["\\\r\n]/g, '_');
  const ascii = seguro.replace(/[^\x20-\x7e]/g, '_');
  const modo = comoAnexo ? 'attachment' : 'inline';
  return `${modo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(seguro)}`;
}

module.exports = { MIME_POR_EXT, extDe, mimeDaExt, tipoDaExt, disposicao };
