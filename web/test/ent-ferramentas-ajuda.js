'use strict';
// Apoio dos testes do bloco I: uma pasta de ferramentas de mentira (no tmp), a ferramenta de exemplo já com base sintética
// e credencial, e um jeito curto de criar ferramentas pequenas com o executor que o teste quiser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pastaTemp } = require('./ajuda');

const EXEMPLO = path.join(__dirname, '../../templates/ferramenta-sensivel/exemplo-carteira');

function pastaFerramentas() {
  const raiz = pastaTemp('ferr');
  const dir = path.join(raiz, 'ferramentas');
  const tmpBase = path.join(raiz, 'tmp');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(tmpBase, { mode: 0o700 });
  const chave = path.join(dir, 'chave-pseudonimo');
  fs.writeFileSync(chave, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  let segredos = [];

  /** Copia o exemplo carteira.resumo para a pasta, com base sintética e credencial. `agentes` = quem pode usar. */
  function instalarExemplo(agentes) {
    const destino = path.join(dir, 'carteira.resumo');
    fs.cpSync(EXEMPLO, destino, { recursive: true });
    const def = JSON.parse(fs.readFileSync(path.join(destino, 'ferramenta.json'), 'utf8'));
    def.agentes = agentes || ['ana'];
    fs.writeFileSync(path.join(destino, 'ferramenta.json'), JSON.stringify(def, null, 2));
    const db = path.join(raiz, 'carteira.db');
    const seg = path.join(raiz, 'segredos.json');
    execFileSync('python3', [path.join(destino, 'teste', 'gerar_base.py'), db, seg]);
    segredos = JSON.parse(fs.readFileSync(seg, 'utf8'));
    fs.writeFileSync(path.join(destino, 'credenciais.env'), `BASE_SQLITE=${db}\n`, { mode: 0o600 });
    return destino;
  }

  /** Cria uma ferramenta pequena. `executor` é o código Python; `extra` sobrescreve campos do ferramenta.json. */
  function criar(nome, executor, extra, opcoes) {
    const pasta = path.join(dir, nome);
    fs.mkdirSync(pasta, { mode: 0o700 });
    const def = Object.assign({
      nome, descricao: 'ferramenta de teste', agentes: ['ana'], parametros: {}, finalidade: 'teste', base_legal: 'teste',
      campos_usados: ['x'], retencao_dias: 7, responsavel: 'teste', timeout_s: 10, memoria_mb: 256,
    }, extra || {});
    fs.writeFileSync(path.join(pasta, 'ferramenta.json'), JSON.stringify(def));
    const ext = (opcoes && opcoes.ext) || 'py';
    fs.writeFileSync(path.join(pasta, `executor.${ext}`), executor);
    return pasta;
  }

  const arquivosNoTmp = () => fs.readdirSync(tmpBase);
  return { raiz, dir, tmpBase, chave, instalarExemplo, criar, arquivosNoTmp, segredos: () => segredos };
}

module.exports = { pastaFerramentas, EXEMPLO };
