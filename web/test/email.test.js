'use strict';
// Cliente SMTP mínimo contra um servidor SMTP falso (net.createServer, sem TLS).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { criarEmail, dotStuff, codificaAssunto, MOTIVO_SEM_CONFIG } = require('../lib/email');
const { capturaLog } = require('./ajuda');

// Valor gerado na hora, só para conferir que ele nunca aparece em log nem em motivo.
const VALOR_DE_TESTE = `v-${crypto.randomBytes(8).toString('hex')}`;

/** Servidor SMTP falso. `respAuth` define a resposta ao AUTH; `ehlo` as linhas do EHLO. */
function smtpFalso(opcoes) {
  const o = Object.assign({ respAuth: '235 2.7.0 Autenticado', ehlo: ['250-smtp.falso', '250-AUTH PLAIN LOGIN', '250 8BITMIME'], rcpt: '250 2.1.5 Ok' }, opcoes || {});
  const rec = { comandos: [], dados: null, conexoes: 0 };
  const socks = new Set();
  const servidor = net.createServer((sock) => {
    rec.conexoes += 1;
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    sock.setEncoding('utf8');
    let buf = ''; let emDados = false; let loginPasso = 0;
    const diz = (t) => sock.write(t + '\r\n');
    diz('220 smtp.falso ESMTP pronto');
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (emDados) {
          const fim = buf.indexOf('\r\n.\r\n');
          if (fim < 0) return;
          rec.dados = buf.slice(0, fim); buf = buf.slice(fim + 5); emDados = false;
          diz('250 2.0.0 Aceito para entrega');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const linha = buf.slice(0, i); buf = buf.slice(i + 2);
        if (loginPasso > 0) {
          rec.comandos.push(`(login passo ${loginPasso})`);
          if (loginPasso === 1) { loginPasso = 2; diz('334 UGFzc3dvcmQ6'); } else { loginPasso = 0; diz(o.respAuth); }
          continue;
        }
        rec.comandos.push(linha);
        const cmd = linha.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') o.ehlo.forEach((l) => diz(l));
        else if (cmd === 'AUTH') {
          if (/^AUTH LOGIN$/i.test(linha)) { loginPasso = 1; diz('334 VXNlcm5hbWU6'); } else diz(o.respAuth);
        } else if (cmd === 'MAIL') diz('250 2.1.0 Ok');
        else if (cmd === 'RCPT') diz(o.rcpt);
        else if (cmd === 'DATA') { emDados = true; diz('354 Termine com <CR><LF>.<CR><LF>'); }
        else if (cmd === 'QUIT') { diz('221 Tchau'); sock.end(); }
        else diz('500 comando desconhecido');
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve({
    porta: servidor.address().port, rec, fechar: () => new Promise((r) => { servidor.close(() => r()); for (const x of socks) x.destroy(); }),
  })));
}

const envDe = (porta, extra) => Object.assign({
  DGCLAW_SMTP_HOST: '127.0.0.1', DGCLAW_SMTP_PORTA: String(porta), DGCLAW_SMTP_USUARIO: 'robo@exemplo.com', DGCLAW_SMTP_SENHA: VALOR_DE_TESTE,
  DGCLAW_SMTP_REMETENTE: 'DG Claw <robo@exemplo.com>', DGCLAW_SMTP_TESTE_SEM_TLS: '1',
}, extra || {});

const montar = (env) => { const cap = capturaLog(); return { cap, email: criarEmail({ config: { env }, log: cap.log }) }; };
const decodifica = (dados) => {
  const [cab, corpo] = dados.split('\r\n\r\n');
  return { cab, texto: Buffer.from(corpo.replace(/\r\n/g, ''), 'base64').toString('utf8') };
};

test('email: sem DGCLAW_SMTP_HOST não envia, não dá erro e explica o que fazer', async () => {
  const { email, cap } = montar({});
  assert.equal(email.configurado, false);
  const r = await email.enviar({ para: 'a@b.com', assunto: 'Oi', texto: 'oi' });
  assert.deepEqual(r, { enviado: false, motivo: MOTIVO_SEM_CONFIG });
  assert.match(r.motivo, /DGCLAW_SMTP_HOST no web\.env/);
  assert.equal(cap.linhas.length, 0);
});

test('email: conversa completa (EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT) e mensagem em UTF-8/base64', async () => {
  const smtp = await smtpFalso();
  try {
    const { email, cap } = montar(envDe(smtp.porta));
    const texto = 'Olá, Maria!\nSenha temporária: Ab3dEf5hJk7m\nAté logo, pão de açúcar.';
    const assuntoOriginal = 'Convite para conversar com o agente Ana no DG Claw';
    const r = await email.enviar({ para: 'maria@x.com', assunto: assuntoOriginal, texto });
    assert.deepEqual(r, { enviado: true });
    const c = smtp.rec.comandos;
    assert.match(c[0], /^EHLO /);
    assert.equal(c[1], 'AUTH PLAIN ' + Buffer.from(`\0robo@exemplo.com\0${VALOR_DE_TESTE}`).toString('base64'));
    assert.equal(c[2], 'MAIL FROM:<robo@exemplo.com>');
    assert.equal(c[3], 'RCPT TO:<maria@x.com>');
    assert.equal(c[4], 'DATA');
    assert.equal(c[5], 'QUIT');
    const { cab, texto: corpo } = decodifica(smtp.rec.dados);
    assert.equal(corpo, texto.replace(/\n/g, '\r\n'));
    assert.match(cab, /^From: DG Claw <robo@exemplo\.com>\r\nTo: maria@x\.com\r\nSubject: =\?UTF-8\?B\?/);
    assert.match(cab, /\r\nDate: .+\r\nMessage-ID: <[0-9a-f]+@exemplo\.com>\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64$/);
    const linhaAssunto = cab.slice(cab.indexOf('Subject: ') + 9, cab.indexOf('\r\nDate:'));
    const lido = linhaAssunto.split('\r\n ').map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('');
    assert.equal(lido, assuntoOriginal);
    assert.ok(!cap.texto().includes(VALOR_DE_TESTE) && !cap.texto().includes('Ab3dEf5hJk7m'), 'nem a senha do SMTP nem o corpo vão para o log');
  } finally { await smtp.fechar(); }
});

test('email: usa AUTH LOGIN quando só ele é oferecido', async () => {
  const smtp = await smtpFalso({ ehlo: ['250-smtp.falso', '250 AUTH LOGIN'] });
  try {
    const { email } = montar(envDe(smtp.porta));
    assert.equal((await email.enviar({ para: 'maria@x.com', assunto: 'Oi', texto: 'oi' })).enviado, true);
    assert.ok(smtp.rec.comandos.includes('AUTH LOGIN'));
    assert.equal(smtp.rec.comandos.filter((x) => x.startsWith('(login')).length, 2);
  } finally { await smtp.fechar(); }
});

test('email: dot-stuffing nas linhas que começam com ponto', () => {
  assert.equal(dotStuff('a\n.b\n..c\nd'), 'a\r\n..b\r\n...c\r\nd');
  assert.equal(dotStuff('.começa'), '..começa');
  assert.equal(dotStuff('sem ponto no começo.\r\nfim'), 'sem ponto no começo.\r\nfim');
});

test('email: assunto longo vira várias encoded-words de até 75 caracteres', () => {
  const a = codificaAssunto('Convite para conversar com o agente Ana no DG Claw, com acentuação: ção, é, ü');
  for (const palavra of a.split('\r\n ')) assert.ok(palavra.length <= 75, palavra);
  assert.match(a, /^=\?UTF-8\?B\?/);
});

test('email: quebra de linha em qualquer campo de cabeçalho é recusada sem abrir conexão', async () => {
  const smtp = await smtpFalso();
  try {
    const { email } = montar(envDe(smtp.porta));
    const r1 = await email.enviar({ para: 'a@b.com', assunto: 'Oi\r\nBcc: vitima@x.com', texto: 'x' });
    assert.equal(r1.enviado, false); assert.match(r1.motivo, /assunto/);
    const r2 = await email.enviar({ para: 'a@b.com\nBcc: x@y.com', assunto: 'Oi', texto: 'x' });
    assert.equal(r2.enviado, false); assert.match(r2.motivo, /destinatário/);
    const { email: e3 } = montar(envDe(smtp.porta, { DGCLAW_SMTP_REMETENTE: 'Fulano <f@x.com>\r\nBcc: z@z.com' }));
    const r3 = await e3.enviar({ para: 'a@b.com', assunto: 'Oi', texto: 'x' });
    assert.equal(r3.enviado, false); assert.match(r3.motivo, /remetente/);
    assert.equal(smtp.rec.conexoes, 0);
  } finally { await smtp.fechar(); }
});

test('email: servidor que responde 535 vira motivo legível, sem a senha, e a linha de log tem host e porta', async () => {
  const smtp = await smtpFalso({ respAuth: '535 5.7.8 Authentication failed' });
  try {
    const { email, cap } = montar(envDe(smtp.porta));
    const r = await email.enviar({ para: 'maria@x.com', assunto: 'Oi', texto: 'corpo reservado do convite' });
    assert.equal(r.enviado, false);
    assert.match(r.motivo, /535 5\.7\.8 Authentication failed/);
    assert.match(r.motivo, /à autenticação/);
    assert.ok(!r.motivo.includes(VALOR_DE_TESTE));
    const log = cap.texto();
    assert.match(log, new RegExp(`127\\.0\\.0\\.1:${smtp.porta}`));
    assert.ok(!log.includes(VALOR_DE_TESTE) && !log.includes('corpo reservado'));
    assert.ok(!smtp.rec.comandos.includes('DATA'));
  } finally { await smtp.fechar(); }
});

test('email: destinatário recusado (550) e servidor fora do ar viram motivo legível', async () => {
  const smtp = await smtpFalso({ rcpt: '550 5.1.1 Caixa inexistente' });
  try {
    const { email } = montar(envDe(smtp.porta));
    const r = await email.enviar({ para: 'ninguem@x.com', assunto: 'Oi', texto: 'x' });
    assert.equal(r.enviado, false); assert.match(r.motivo, /550 5\.1\.1 Caixa inexistente.*destinatário/);
  } finally { await smtp.fechar(); }
  const porta = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const { email } = montar(envDe(porta));
  const r = await email.enviar({ para: 'a@b.com', assunto: 'Oi', texto: 'x' });
  assert.equal(r.enviado, false); assert.match(r.motivo, /não consegui conectar/);
});

test('email: sem criptografia só vale no teste; fora dele o STARTTLS é exigido e a senha não sai', async () => {
  const smtp = await smtpFalso();
  try {
    const { email } = montar(envDe(smtp.porta, { DGCLAW_SMTP_TESTE_SEM_TLS: '0' }));
    const r = await email.enviar({ para: 'maria@x.com', assunto: 'Oi', texto: 'x' });
    assert.equal(r.enviado, false); assert.match(r.motivo, /STARTTLS/);
    assert.ok(!smtp.rec.comandos.some((x) => x.startsWith('AUTH')), 'a senha não pode ir sem criptografia');
  } finally { await smtp.fechar(); }
});

test('email: falta de remetente é explicada', async () => {
  const { email } = montar({ DGCLAW_SMTP_HOST: 'smtp.exemplo.com', DGCLAW_SMTP_USUARIO: 'usuario-sem-arroba' });
  const r = await email.enviar({ para: 'a@b.com', assunto: 'Oi', texto: 'x' });
  assert.equal(r.enviado, false); assert.match(r.motivo, /DGCLAW_SMTP_REMETENTE/);
});
