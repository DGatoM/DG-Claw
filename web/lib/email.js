'use strict';
// Cliente SMTP mínimo (Node puro, net e tls) só para mandar o convite do colaborador.
// Configuração, toda opcional, no web.env: DGCLAW_SMTP_HOST, DGCLAW_SMTP_PORTA (465 = TLS direto,
// 587 = STARTTLS obrigatório; outra porta exige STARTTLS), DGCLAW_SMTP_USUARIO, DGCLAW_SMTP_SENHA,
// DGCLAW_SMTP_REMETENTE. Sem DGCLAW_SMTP_HOST o envio não existe e o convite vai pelo texto da tela.
// O certificado do servidor é sempre conferido. A senha nunca vai para o log nem para o motivo devolvido.

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const tls = require('node:tls');

const TEMPO_TOTAL_MS = 20000;
const MOTIVO_SEM_CONFIG = 'O envio de e-mail não está configurado neste DG Claw (DGCLAW_SMTP_HOST no web.env). Mande o convite pelo texto abaixo.';

/** Pontos no começo da linha ganham outro ponto (RFC 5321 4.5.2); sem isso uma linha "." encerraria o DATA. */
function dotStuff(texto) {
  return String(texto).replace(/\r?\n/g, '\r\n').replace(/^\./, '..').replace(/\r\n\./g, '\r\n..');
}

function temQuebra(v) { return /[\r\n\0]/.test(String(v)); }

/** Assunto em UTF-8/base64, em "encoded-words" de até 45 bytes (o limite de cada uma é 75 caracteres). */
function codificaAssunto(assunto) {
  const palavras = [];
  let atual = '';
  for (const ch of Array.from(String(assunto))) {
    if (Buffer.byteLength(atual + ch, 'utf8') > 45) { palavras.push(atual); atual = ''; }
    atual += ch;
  }
  if (atual || !palavras.length) palavras.push(atual);
  return palavras.map((p) => `=?UTF-8?B?${Buffer.from(p, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Só o endereço de um remetente do tipo "Nome <a@b.com>" ou "a@b.com". Devolve '' se não achar. */
function enderecoDe(texto) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(texto) || /^\s*([^<>\s]+@[^<>\s]+)\s*$/.exec(texto);
  return m ? m[1] : '';
}

function montaMensagem({ remetente, para, assunto, texto, dominio }) {
  const corpo = Buffer.from(String(texto).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${remetente}`,
    `To: ${para}`,
    `Subject: ${codificaAssunto(assunto)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${dominio}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    corpo,
  ].join('\r\n');
}

function criarEmail({ config, log }) {
  const env = config.env || {};
  const host = String(env.DGCLAW_SMTP_HOST || '').trim();
  const porta = Number(env.DGCLAW_SMTP_PORTA) || 587;
  const usuario = String(env.DGCLAW_SMTP_USUARIO || '');
  const senha = String(env.DGCLAW_SMTP_SENHA || '');
  const remetente = String(env.DGCLAW_SMTP_REMETENTE || '').trim() || (usuario.includes('@') ? usuario : '');
  // Só para os testes: servidor falso em 127.0.0.1 sem TLS. Em qualquer outro host a variável não vale nada.
  const semTlsDeTeste = env.DGCLAW_SMTP_TESTE_SEM_TLS === '1' && (host === '127.0.0.1' || host === 'localhost');

  const limpa = (t) => {
    let s = String(t);
    if (senha) s = s.split(senha).join('***');
    return s.slice(0, 300);
  };

  async function sessao({ para, assunto, texto }) {
    const dominio = (enderecoDe(remetente).split('@')[1] || 'dgclaw.local');
    const mensagem = montaMensagem({ remetente, para, assunto, texto, dominio });
    const st = { sock: null, buf: '', linhas: [], prontas: [], esperas: [], erro: null };
    let acabou = false;

    const rejeitaTudo = (err) => {
      if (!st.erro) st.erro = err;
      for (const w of st.esperas.splice(0)) w.reject(err);
    };
    const processa = () => {
      for (;;) {
        const i = st.buf.indexOf('\n');
        if (i < 0) return;
        const linha = st.buf.slice(0, i).replace(/\r$/, '');
        st.buf = st.buf.slice(i + 1);
        st.linhas.push(linha);
        if (/^\d{3}(?: |$)/.test(linha)) {
          const r = { codigo: Number(linha.slice(0, 3)), linhas: st.linhas };
          st.linhas = [];
          const w = st.esperas.shift();
          if (w) w.resolve(r); else st.prontas.push(r);
        }
      }
    };
    const liga = (sock) => {
      st.sock = sock;
      // sem setEncoding: o mesmo socket pode virar TLS no STARTTLS e precisa entregar bytes crus
      sock.on('data', (d) => { st.buf += d.toString('utf8'); processa(); });
      sock.on('error', (e) => rejeitaTudo(new Error(`falha na conexão (${e.code || e.message})`)));
      sock.on('close', () => { if (!acabou) rejeitaTudo(new Error('o servidor SMTP fechou a conexão antes de terminar')); });
    };
    const resposta = () => {
      if (st.prontas.length) return Promise.resolve(st.prontas.shift());
      if (st.erro) return Promise.reject(st.erro);
      return new Promise((resolve, reject) => st.esperas.push({ resolve, reject }));
    };
    const falhou = (etapa, r) => new Error(`o servidor SMTP respondeu "${r.linhas[r.linhas.length - 1]}" ${etapa}`);
    // comando -> resposta; `esperados` são os códigos aceitos
    const cmd = async (linha, esperados, etapa) => {
      st.sock.write(linha + '\r\n');
      const r = await resposta();
      if (!esperados.includes(r.codigo)) throw falhou(etapa, r);
      return r;
    };

    const direto = porta === 465;
    const t = setTimeout(() => { rejeitaTudo(new Error(`o servidor SMTP não respondeu em ${TEMPO_TOTAL_MS / 1000} s`)); if (st.sock) st.sock.destroy(); }, TEMPO_TOTAL_MS);
    try {
      await new Promise((resolve, reject) => {
        const opcoes = { host, port: porta };
        const s = direto
          ? tls.connect(Object.assign({ servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true }, opcoes), resolve)
          : net.connect(opcoes, resolve);
        s.once('error', (e) => reject(new Error(`não consegui conectar (${e.code || e.message})`)));
        s.once('close', () => reject(new Error(st.erro ? st.erro.message : 'a conexão foi encerrada antes de abrir')));
        liga(s);
      });
      st.sock.removeAllListeners('error');
      st.sock.on('error', (e) => rejeitaTudo(new Error(`falha na conexão (${e.code || e.message})`)));

      const saudacao = await resposta();
      if (saudacao.codigo !== 220) throw falhou('ao conectar', saudacao);
      const eu = (os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost');
      let ehlo = await cmd(`EHLO ${eu}`, [250], 'ao cumprimentar (EHLO)');
      const oferece = (nome) => ehlo.linhas.some((l) => new RegExp(`^250[- ]${nome}(?:[ =]|$)`, 'i').test(l));

      let criptografado = direto;
      if (!direto && !semTlsDeTeste) {
        if (!oferece('STARTTLS')) {
          throw new Error(porta === 587
            ? 'o servidor SMTP não oferece STARTTLS, que é obrigatório na porta 587'
            : 'o servidor SMTP não oferece STARTTLS, e não envio e-mail nem senha sem criptografia');
        }
        await cmd('STARTTLS', [220], 'ao pedir STARTTLS');
        const antigo = st.sock;
        antigo.removeAllListeners('data'); antigo.removeAllListeners('close'); antigo.removeAllListeners('error');
        antigo.on('error', () => undefined);
        await new Promise((resolve, reject) => {
          const seguro = tls.connect({ socket: antigo, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true }, resolve);
          seguro.once('error', (e) => reject(new Error(`o certificado ou a criptografia do servidor SMTP falhou (${e.code || e.message})`)));
          liga(seguro);
        });
        criptografado = true;
        ehlo = await cmd(`EHLO ${eu}`, [250], 'depois do STARTTLS (EHLO)');
      }

      if (usuario) {
        if (!criptografado && !semTlsDeTeste) throw new Error('não envio a senha do SMTP sem criptografia');
        const mecanismos = ehlo.linhas.filter((l) => /^250[- ]AUTH[ =]/i.test(l)).join(' ').toUpperCase();
        if (/\bPLAIN\b/.test(mecanismos)) {
          await cmd('AUTH PLAIN ' + Buffer.from(`\0${usuario}\0${senha}`, 'utf8').toString('base64'), [235], 'à autenticação');
        } else if (/\bLOGIN\b/.test(mecanismos)) {
          await cmd('AUTH LOGIN', [334], 'à autenticação');
          await cmd(Buffer.from(usuario, 'utf8').toString('base64'), [334], 'ao usuário');
          await cmd(Buffer.from(senha, 'utf8').toString('base64'), [235], 'à autenticação');
        } else {
          throw new Error('o servidor SMTP não oferece AUTH PLAIN nem AUTH LOGIN');
        }
      }

      await cmd(`MAIL FROM:<${enderecoDe(remetente)}>`, [250], 'ao remetente (MAIL FROM)');
      await cmd(`RCPT TO:<${para}>`, [250, 251], 'ao destinatário (RCPT TO)');
      await cmd('DATA', [354], 'ao pedir DATA');
      st.sock.write(dotStuff(mensagem) + '\r\n.\r\n');
      const fim = await resposta();
      if (fim.codigo !== 250) throw falhou('ao receber a mensagem', fim);
      acabou = true;
      try { st.sock.write('QUIT\r\n'); await resposta(); } catch (_) { /* já encerrou: o e-mail foi aceito */ }
    } finally {
      clearTimeout(t);
      acabou = true;
      if (st.sock) st.sock.destroy();
    }
  }

  return {
    configurado: !!host,
    host,
    porta,

    /** Manda um e-mail de texto. Nunca lança: devolve { enviado, motivo? }. */
    async enviar({ para, assunto, texto }) {
      if (!host) return { enviado: false, motivo: MOTIVO_SEM_CONFIG };
      if (!remetente || !enderecoDe(remetente)) {
        return { enviado: false, motivo: 'Falta o remetente do e-mail. Defina DGCLAW_SMTP_REMETENTE no web.env (por exemplo: DG Claw <voce@exemplo.com>). Mande o convite pelo texto abaixo.' };
      }
      for (const [nome, v] of [['destinatário', para], ['assunto', assunto], ['remetente', remetente]]) {
        if (typeof v !== 'string' || !v || temQuebra(v)) {
          return { enviado: false, motivo: `O ${nome} do e-mail está vazio ou tem quebra de linha, então não enviei. Mande o convite pelo texto abaixo.` };
        }
      }
      try {
        await sessao({ para, assunto, texto });
        log('info', `E-mail de convite enviado para ${para} por ${host}:${porta}.`);
        return { enviado: true };
      } catch (e) {
        const motivo = limpa(e.message);
        log('aviso', `Não consegui mandar o e-mail para ${para} por ${host}:${porta}: ${motivo}. Confira as variáveis DGCLAW_SMTP_* no web.env (host, porta, usuário e senha) e mande o convite pelo texto da tela.`);
        return { enviado: false, motivo: `Não consegui mandar o e-mail: ${motivo}. Mande o convite pelo texto abaixo.` };
      }
    },
  };
}

module.exports = { criarEmail, dotStuff, codificaAssunto, enderecoDe, montaMensagem, MOTIVO_SEM_CONFIG };
