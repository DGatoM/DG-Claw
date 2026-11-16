'use strict';
// Processo filho do teste de auditoria de regex (logs-regex.test.js): roda cada regex dos módulos de logs contra entradas
// hostis de 64 KB e imprime uma linha por regex. Fica em processo próprio para uma regex travada ser morta pelo timeout do pai.
const { REGEX_AUDITAVEIS: doLeitor } = require('../lib/logs-leitor');
const { REGEX_AUDITAVEIS: dasRotas } = require('../lib/logs-rotas');

const N = 64 * 1024;
const rep = (u, n) => u.repeat(Math.ceil((n || N) / u.length)).slice(0, n || N);
const BASES = [' ', '\t', '"', "'", '\\', '/', '\n', 'a', '1', '-', '.', ',', '}', ']', '=', ':', ';', '|', '&', '\u0000', 'é'];
const SEPARADORES = [' ', '"', "'", '\\', ',', 'a'];

function entradas(sementes) {
  const out = BASES.map((b) => [`${JSON.stringify(b)} x N`, rep(b)]);
  for (const s of sementes) {
    out.push([`${JSON.stringify(s)} x N`, rep(s)]);
    out.push([`${JSON.stringify(s)} x N + sufixo que falha`, rep(s).slice(0, N - 1) + '\u0000']);
    for (const b of SEPARADORES) {
      out.push([`${JSON.stringify(s)} + ${JSON.stringify(b)} x N`, s + rep(b)]);
      out.push([`(${JSON.stringify(s + b)}) x N`, rep(s + b)]);
      out.push([`${JSON.stringify(b)} x N + ${JSON.stringify(s)}`, rep(b) + s]);
      out.push([`${JSON.stringify(s)} + ${JSON.stringify(b)} x N + linha que falha`, s + rep(b, N - 64) + '\nfalha("x");']);
      out.push([`${JSON.stringify(s)} + ${JSON.stringify(b)} x 8000 + linha que falha`, s + rep(b, 8000) + '\ntext("ok");']);
      out.push([`(${JSON.stringify(s + b + 'x')}) x N + falha`, rep(s + b + 'x').slice(0, N - 1) + '\u0000']);
    }
  }
  return out;
}

for (const { nome, rx, sementes } of [...doLeitor, ...dasRotas]) {
  console.log(JSON.stringify({ evento: 'comeco', nome }));
  let pior = { ms: 0, quem: '' };
  for (const [quem, texto] of entradas(sementes)) {
    rx.lastIndex = 0;
    const ini = process.hrtime.bigint();
    texto.replace(rx, 'X');
    rx.lastIndex = 0;
    rx.test(texto);
    const ms = Number(process.hrtime.bigint() - ini) / 1e6;
    if (ms > pior.ms) pior = { ms, quem };
  }
  console.log(JSON.stringify({ evento: 'fim', nome, ms: Math.round(pior.ms * 10) / 10, quem: pior.quem }));
}
