'use strict';
// O demo.sh da skill demonstracao, rodando contra o Portão de teste: token por arquivo, corpo montado com jq, códigos de saída.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { subirDemo, TOKEN } = require('./demo-ajuda');
const { pastaTemp } = require('./ajuda');

const SCRIPT = path.join(__dirname, '..', '..', 'templates', 'ambiente', 'skills', 'demonstracao', 'demo.sh');

function rodar(casa, args) {
  return new Promise((ok) => {
    const r = spawn('bash', [SCRIPT, ...args], { env: Object.assign({}, process.env, { HOME: casa }) });
    let out = ''; let err = '';
    r.stdout.on('data', (d) => { out += d; });
    r.stderr.on('data', (d) => { err += d; });
    r.on('close', (codigo) => ok({ codigo, out, err }));
  });
}

test('demo.sh pede contato, acompanha o estado e cria o cartão de envio com o texto exato', async () => {
  const w = await subirDemo({});
  try {
    const home = pastaTemp('demo-sh');
    fs.mkdirSync(path.join(home, '.dgclaw'));
    fs.writeFileSync(path.join(home, '.dgclaw', 'demo.token'), TOKEN + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.dgclaw', 'demo.url'), `http://127.0.0.1:${w.porta}/\n`);

    const c = await rodar(home, ['contato', 'danilo', 'maria']);
    assert.equal(c.codigo, 0, c.err);
    assert.match(c.err, /confirme na tela/i);
    const id = JSON.parse(c.out).id;
    assert.equal(JSON.parse((await rodar(home, ['estado-contato', id])).out).estado, 'aguardando');
    await w.decide(id, { decisao: 'confirmar', candidato: 'chat-maria-silva' });
    const lib = JSON.parse((await rodar(home, ['estado-contato', id])).out);
    assert.equal(lib.estado, 'liberado');
    assert.equal((await rodar(home, ['conversa', lib.contato.ref, '2'])).codigo, 0);

    const texto = 'Linha 1 com "aspas" e acento\nLinha 2 $HOME `x`';
    fs.writeFileSync(path.join(home, 'msg.txt'), texto);
    const e = await rodar(home, ['enviar-whatsapp', '--linha', 'danilo', '--ref', lib.contato.ref, '--texto-arquivo', path.join(home, 'msg.txt')]);
    assert.equal(e.codigo, 0, e.err);
    const cartao = (await w.c.get('/api/demo/cartoes')).json.cartoes.find((x) => x.id === JSON.parse(e.out).id);
    assert.equal(cartao.texto, texto);
    assert.equal((await rodar(home, ['estado-envio', cartao.id])).codigo, 0);

    const nome = await rodar(home, ['contato', 'danilo', 'Ma']);
    assert.equal(nome.codigo, 4);
    assert.match(nome.err, /3 caracteres ou mais/);
    assert.equal((await rodar(home, ['estado-envio', 'nao-e-um-id'])).codigo, 1);
    assert.equal((await rodar(home, ['enviar-whatsapp', '--linha', 'danilo', '--texto', 'x'])).codigo, 1);
    assert.equal((await rodar(home, ['listar'])).codigo, 1, 'não existe comando de listar');
  } finally { await w.fechar(); }
});

test('demo.sh sem token explica o que falta, e com token errado sai com 4', async () => {
  const w = await subirDemo({});
  try {
    const vazio = pastaTemp('demo-sh-vazio');
    const sem = await rodar(vazio, ['contato', 'danilo', 'maria']);
    assert.equal(sem.codigo, 2);
    assert.match(sem.err, /demo\.token/);
    fs.mkdirSync(path.join(vazio, '.dgclaw'));
    fs.writeFileSync(path.join(vazio, '.dgclaw', 'demo.token'), 'errado\n');
    fs.writeFileSync(path.join(vazio, '.dgclaw', 'demo.url'), `http://127.0.0.1:${w.porta}\n`);
    const r = await rodar(vazio, ['contato', 'danilo', 'maria']);
    assert.equal(r.codigo, 4);
    assert.match(r.err, /token do Portão não foi aceito/);
    fs.writeFileSync(path.join(vazio, '.dgclaw', 'demo.url'), 'http://127.0.0.1:1\n');
    assert.equal((await rodar(vazio, ['estado-envio', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])).codigo, 3);
  } finally { await w.fechar(); }
});
