'use strict';
// Seção Logs: cada argumento é lido uma vez só (tempo linear) e comando em lista é mascarado respeitando os limites dos elementos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { limpaCamadaAntiga: limpa, comandoDeLista } = require('../lib/logs-leitor');

function medir(entrada) {
  const t0 = process.hrtime.bigint();
  limpa(entrada);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test('flags candidatas que não são sensíveis: tempo linear', () => {
  const um = '"--x"'.repeat(13000);
  const quatro = '"--x"'.repeat(52000);
  limpa(um);
  const t1 = Math.max(medir(um), 1);
  const t4 = medir(quatro);
  assert.ok(t1 < 200, `65 KB levou ${t1} ms`);
  assert.ok(t4 / t1 < 12, `razão 4x/1x = ${t4 / t1}`);
});

const RESTOS = ['ParteExposta', 'palavras', 'cauda', 'barra'];
const SENHAS = ['alice:segredo;ParteExposta', 'duas palavras cauda', "com'aspa cauda", 'com"aspa cauda', 'a/b\\barra c'];

function confere(lista) {
  const saida = limpa(comandoDeLista(lista)).replace(/\[segredo oculto\]/g, '[X]');
  for (const r of RESTOS) assert.ok(!saida.includes(r), `vazou ${r} em: ${saida}`);
  assert.ok(!saida.includes('segredo'), saida);
  assert.ok(saida.includes('ARGUMENTO-SEGUINTE'), `perdeu o argumento seguinte: ${saida}`);
  assert.ok(saida.includes('[X]'), saida);
}

for (const s of SENHAS) {
  const u = s.includes(':') ? s : `alice:${s}`;
  test(`lista: -u com ${JSON.stringify(u)}`, () => confere(['curl', '-u', u, 'ARGUMENTO-SEGUINTE']));
  test(`lista: --password com ${JSON.stringify(s)}`, () => confere(['app', '--password', s, 'ARGUMENTO-SEGUINTE']));
  test(`lista: --password= com ${JSON.stringify(s)}`, () => confere(['app', `--password=${s}`, 'ARGUMENTO-SEGUINTE']));
}

test('lista: o resto do comando continua legível', () => {
  const saida = limpa(comandoDeLista(['curl', '-s', '-u', 'alice:duas palavras', 'ARGUMENTO-SEGUINTE']));
  assert.match(saida, /^curl -s -u /);
});
