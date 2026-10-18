'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { criarProtecoes } = require('../lib/protecoes');
const { pastaTemp, capturaLog } = require('./ajuda');

const REPO = path.join(__dirname, '..', '..');
const MATRIZ = path.join(REPO, 'config', 'protecoes-matriz.json');

function cenario(conteudo) {
  const dir = pastaTemp('prot');
  const caminho = path.join(dir, 'protecoes.json');
  if (conteudo !== undefined) fs.writeFileSync(caminho, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
  const cap = capturaLog();
  return { dir, caminho, cap, p: criarProtecoes({ caminho, log: cap.log }) };
}

test('sem o arquivo o nível é pessoal e nada enterprise está ligado', () => {
  const { p, cap } = cenario();
  assert.equal(p.nivel(), 'pessoal');
  assert.equal(p.valor('2fa'), 'nao');
  assert.equal(p.valor('sessao_horas'), 720);
  assert.equal(p.ligada('2fa'), false);
  assert.equal(p.ligada('auditoria'), false);
  assert.equal(p.ligada('runtime'), false);
  assert.equal(p.ligada('multiusuario'), false);
  assert.equal(p.ligada('admin_llm'), true);
  assert.deepEqual(cap.linhas, []);
});

test('padrões por nível seguem a tabela do desenho', () => {
  const casos = [
    ['escritorio', '2fa', 'ti'], ['empresa', '2fa', 'todos'], ['regulado', 'runtime', 'gvisor'],
    ['regulado', 'sessao_horas', 12], ['escritorio', 'retencao_dias', 180], ['regulado', 'sso', 'obrigatorio'],
    ['empresa', 'kit_sensivel', true], ['escritorio', 'sigilo_externo', false], ['regulado', 'backup_retencao_dias', 14],
  ];
  for (const [nivel, chave, esperado] of casos) {
    const { p } = cenario({ versao: 1, nivel, ajustes: {} });
    assert.equal(p.valor(chave), esperado, `${nivel}/${chave}`);
  }
  const { p } = cenario({ nivel: 'regulado' });
  assert.equal(p.ligada('runtime'), true);
  assert.equal(p.ligada('sigilo_externo'), false);
});

test('ajuste que sobe vale; ajuste abaixo da trava é ignorado com aviso que diz o porquê', () => {
  const { p, cap } = cenario({ nivel: 'empresa', ajustes: { sessao_horas: 24, '2fa': 'nao', auditoria: 'ultra' } });
  assert.equal(p.valor('sessao_horas'), 24);
  assert.equal(p.valor('2fa'), 'todos');
  assert.equal(p.valor('auditoria'), 'completa');
  const texto = cap.texto();
  assert.match(texto, /2fa = "nao"/);
  assert.match(texto, /abaixo da trava/);
  assert.match(texto, /auditoria = "ultra"/);
  // lê de novo sem mudar o arquivo: não repete o aviso
  const antes = cap.linhas.length;
  p.valor('2fa');
  assert.equal(cap.linhas.length, antes);
});

test('chave com forte=false (sigilo_externo) trava ao contrário', () => {
  const { p } = cenario({ nivel: 'regulado', ajustes: { sigilo_externo: true } });
  assert.equal(p.valor('sigilo_externo'), false);
  const b = cenario({ nivel: 'escritorio', ajustes: { sigilo_externo: true } });
  assert.equal(b.p.valor('sigilo_externo'), true, 'no escritório não é travada');
});

test('arquivo ilegível ou nível inexistente: pessoal, com aviso que diz o arquivo', () => {
  const a = cenario('isso não é json');
  assert.equal(a.p.nivel(), 'pessoal');
  assert.match(a.cap.texto(), /protecoes\.json não é um JSON válido/);
  const b = cenario({ nivel: 'galactico' });
  assert.equal(b.p.nivel(), 'pessoal');
  assert.match(b.cap.texto(), /galactico/);
});

test('relê quando o arquivo muda, sem reiniciar', () => {
  const { p, caminho } = cenario({ nivel: 'escritorio' });
  assert.equal(p.nivel(), 'escritorio');
  fs.writeFileSync(caminho, JSON.stringify({ nivel: 'regulado', ajustes: {} }));
  assert.equal(p.nivel(), 'regulado');
  fs.unlinkSync(caminho);
  assert.equal(p.nivel(), 'pessoal');
});

test('chave que não existe lança erro que diz o nome', () => {
  const { p } = cenario();
  assert.throws(() => p.valor('xpto'), /"xpto" não existe na matriz/);
  assert.throws(() => p.ligada('xpto'), /"xpto"/);
});

test('resumo traz o valor efetivo, o padrão, a trava e os três textos', () => {
  const { p } = cenario({ nivel: 'escritorio', ajustes: { '2fa': 'todos' }, org_uuid: '123e4567-e89b-12d3-a456-426614174000' });
  const r = p.resumo();
  assert.equal(r.nivel, 'escritorio');
  assert.equal(r.org_uuid, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(r.chaves.length, 22);
  const f = r.chaves.find((c) => c.chave === '2fa');
  assert.equal(f.valor, 'todos');
  assert.equal(f.padrao, 'ti');
  assert.equal(f.ajustado, true);
  assert.equal(f.travado, true);
  assert.equal(f.ligada, true);
  assert.ok(f.descricao && f.como && f.porque);
  assert.deepEqual(f.valores, ['nao', 'ti', 'todos']);
  assert.equal(r.chaves.find((c) => c.chave === 'sessao_horas').travado, false);
});

test('o bash e o Node concordam em todas as chaves de todos os níveis', () => {
  for (const nivel of ['pessoal', 'escritorio', 'empresa', 'regulado']) {
    const { p, dir, caminho } = cenario({ nivel, ajustes: { sessao_horas: 5 } });
    const raiz = path.join(dir, 'raiz');
    fs.mkdirSync(path.join(raiz, 'etc', 'dgclaw'), { recursive: true });
    fs.copyFileSync(caminho, path.join(raiz, 'etc', 'dgclaw', 'protecoes.json'));
    const matriz = JSON.parse(fs.readFileSync(MATRIZ, 'utf8'));
    for (const chave of Object.keys(matriz.chaves)) {
      const bash = execFileSync('bash', ['-c', `. "${REPO}/lib/comum.sh"; APP_DIR="${REPO}"; . "${REPO}/lib/protecoes.sh"; protecao_valor "$1"`, '_', chave],
        { env: { ...process.env, DGCLAW_RAIZ: raiz, NO_COLOR: '1' }, encoding: 'utf8' });
      assert.equal(bash, String(p.valor(chave)), `${nivel}/${chave}`);
    }
  }
});
