'use strict';
// O navegador rejeita o script INTEIRO se houver um erro de sintaxe: uma edição que quebra o conversa.js derruba a tela toda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pasta = path.join(__dirname, '..', 'public');
for (const nome of fs.readdirSync(pasta).filter((n) => n.endsWith('.js'))) {
  test(`sintaxe: public/${nome} compila`, () => {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(pasta, nome), 'utf8'), { filename: nome }));
  });
}
