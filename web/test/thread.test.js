'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarLeitor } = require('../lib/thread');
const { criarMidia } = require('../lib/media');
const { pastaTemp, capturaLog } = require('./ajuda');

const FIXTURE = path.join(__dirname, 'fixtures', 'sessao-ana.jsonl');

function preparar() {
  const home = pastaTemp('home');
  fs.mkdirSync(path.join(home, 'uploads', '2026-10-12'), { recursive: true });
  fs.mkdirSync(path.join(home, 'out'), { recursive: true });
  fs.writeFileSync(path.join(home, 'uploads', '2026-10-12', 'foto.png'), 'png');
  fs.writeFileSync(path.join(home, 'out', 'relatorio.pdf'), 'pdf');
  const agente = { slug: 'ana', nome: 'Ana', chat_id: 'c_ana', home_host: home, home_container: '/home/agente' };
  const cap = capturaLog();
  const registro = { obter: (s) => (s === 'ana' ? agente : null) };
  const midia = criarMidia({ dataDir: pastaTemp('dados'), log: cap.log, registro });
  const leitor = criarLeitor({ log: cap.log, tz: 'America/Sao_Paulo', canalTelegram: 'plugin:telegram', midia });
  return { agente, leitor, home, cap, midia };
}

test('thread: o que entra e o que some', () => {
  const { agente, leitor } = preparar();
  const { eventos } = leitor.ler(FIXTURE, agente);
  const textos = eventos.map((e) => e.text);
  assert.deepEqual(textos, [
    'Oi, tudo bem?',
    'Tudo certo!',
    'Aviso por conta própria',
    'Olha esta foto',
    'Segue o relatório',
    'oi pelo telegram',
    'Resposta no Telegram',
    'Escapei </dgchat> no meio',
    'Falei após um poke de cron',
  ]);
  // some: system-reminder, tool_result, texto solto, outro chat, plataforma, eco de comando, recado do sistema
  assert.ok(!textos.some((t) => /plataforma|lembrete interno|isto vem de um arquivo|solto|outro chat|STOP/.test(t)));
});

test('thread: origem, via e formato de cada mensagem', () => {
  const { agente, leitor } = preparar();
  const { eventos } = leitor.ler(FIXTURE, agente);
  const por = (t) => eventos.find((e) => e.text === t);
  assert.equal(por('Oi, tudo bem?').origin, 'dono');
  assert.equal(por('Oi, tudo bem?').via, 'plataforma');
  assert.equal(por('Tudo certo!').origin, 'agente');
  assert.equal(por('Aviso por conta própria').origin, 'rotina', 'depois de <plataforma> o agente fala sozinho');
  assert.equal(por('Falei após um poke de cron').origin, 'rotina');
  assert.equal(por('oi pelo telegram').via, 'telegram');
  assert.equal(por('oi pelo telegram').origin, 'dono');
  assert.equal(por('Resposta no Telegram').via, 'telegram');
  const e = por('Oi, tudo bem?');
  assert.match(e.id, /^[0-9a-f]{16}$/);
  assert.equal(typeof e.ep, 'number');
  assert.match(e.hhmm, /^\d\d:\d\d$/);
  assert.match(e.dia, /^\d\d\/\d\d\/\d{4}$/);
  assert.equal(e.hhmm, '12:00', 'o transcript está em UTC e a tela mostra no fuso configurado (15:00Z = 12:00 em São Paulo)');
  assert.deepEqual([e.kind, e.fmt, e.editada, e.reacoes, e.cita, e.media], ['text', 'text', false, [], null, null]);
});

test('thread: anexo do dono e send_file do agente viram mídia, com caminho traduzido para o host', () => {
  const { agente, leitor, home } = preparar();
  const { eventos } = leitor.ler(FIXTURE, agente);
  const foto = eventos.find((e) => e.text === 'Olha esta foto');
  assert.equal(foto.kind, 'photo');
  assert.equal(foto.media.kind, 'photo');
  assert.equal(foto.media.disponivel, true);
  assert.match(foto.media.url, /^\/api\/v1\/media\/[0-9a-f]{16}/);
  assert.equal(foto.media.path, '/home/agente/uploads/2026-10-12/foto.png', 'path mostrado é o visto de dentro');
  assert.ok(!foto.text.includes('[anexo'), 'o marcador sai do texto');
  const pdf = eventos.find((e) => e.text === 'Segue o relatório');
  assert.equal(pdf.kind, 'document');
  assert.equal(pdf.media.nome, 'relatorio.pdf');
  assert.ok(pdf.media.bytes === 3 && fs.existsSync(path.join(home, 'out', 'relatorio.pdf')));
});

test('thread: leitura incremental só processa o que cresceu', () => {
  const { agente, leitor } = preparar();
  const tmp = path.join(pastaTemp('jsonl'), 's.jsonl');
  const linha = (txt, n) => JSON.stringify({ type: 'user', timestamp: `2026-10-12T15:00:0${n}.000Z`, message: { content: `<dgchat from="pessoa" chat="c_ana" msg="m${n}" ts="x">${txt}</dgchat>` } }) + '\n';
  fs.writeFileSync(tmp, linha('primeira', 1));
  let r = leitor.ler(tmp, agente);
  assert.equal(r.eventos.length, 1);
  const v1 = r.versao;
  r = leitor.ler(tmp, agente);
  assert.equal(r.versao, v1, 'sem mudança no arquivo a versão não muda');
  // uma linha ainda incompleta (transcript sendo escrito agora) não conta
  const completa = linha('segunda', 2);
  fs.appendFileSync(tmp, completa.slice(0, 40));
  r = leitor.ler(tmp, agente);
  assert.equal(r.eventos.length, 1);
  fs.appendFileSync(tmp, completa.slice(40));
  r = leitor.ler(tmp, agente);
  assert.deepEqual(r.eventos.map((e) => e.text), ['primeira', 'segunda']);
  assert.ok(r.versao > v1);
  // arquivo truncado/substituído recomeça do zero
  fs.writeFileSync(tmp, linha('nova', 3));
  r = leitor.ler(tmp, agente);
  assert.deepEqual(r.eventos.map((e) => e.text), ['nova']);
});

test('thread: mensagem do dono repetida (mesmo msg) não duplica', () => {
  const { agente, leitor } = preparar();
  const tmp = path.join(pastaTemp('jsonl'), 's.jsonl');
  const l = JSON.stringify({ type: 'user', timestamp: '2026-10-12T15:00:01.000Z', message: { content: '<dgchat from="pessoa" chat="c_ana" msg="igual" ts="x">uma vez</dgchat>' } }) + '\n';
  fs.writeFileSync(tmp, l + l);
  assert.equal(leitor.ler(tmp, agente).eventos.length, 1);
});
