'use strict';
// Intercepta o token do BotFather colado no chat: ele é guardado no .env do agente
// (pelo gravador seguro) e NUNCA chega ao runner, ao transcript nem à busca.
// O agente só vê "[token do Telegram guardado com segurança, final XXXX]".

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RX_TOKEN = /^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$/;

const erro = (status, motivo) => ({ status, corpo: { ok: false, erro: motivo } });

/** O texto inteiro (sem espaços nas pontas) é um token do BotFather? */
function ehToken(texto) {
  return typeof texto === 'string' && RX_TOKEN.test(texto.trim());
}

function mascara(token) {
  return `${token.split(':')[0]}:••••••${token.slice(-4)}`;
}

function marcaParaAgente(token) {
  return `[token do Telegram guardado com segurança, final ${token.slice(-4)}]`;
}

// O código do filho vai por -e: o usuário do agente não precisa poder ler a pasta onde o Web está instalado.
const CODIGO_FILHO = fs.readFileSync(path.join(__dirname, 'grava-token-filho.js'), 'utf8');
const TEMPO_FILHO_MS = 10000;

/**
 * Gravador real: um processo filho com o uid/gid do agente grava o .env (ver grava-token-filho.js).
 * O token vai pelo stdin, nunca por argv nem por ambiente. Lança Error em português, sem o token.
 */
function gravaComoAgente({ token, home, uid, gid }) {
  return new Promise((resolve, reject) => {
    const filho = spawn(process.execPath, ['-e', CODIGO_FILHO], { uid, gid, stdio: ['pipe', 'pipe', 'pipe'], env: { HOME_ALVO: home, PATH: process.env.PATH || '' } });
    const saida = [];
    let terminou = false;
    const fim = (fn, v) => { if (terminou) return; terminou = true; clearTimeout(relogio); fn(v); };
    const relogio = setTimeout(() => { filho.kill('SIGKILL'); fim(reject, new Error(`o gravador demorou mais de ${TEMPO_FILHO_MS / 1000} s e foi interrompido`)); }, TEMPO_FILHO_MS);
    filho.stdout.on('data', (c) => saida.push(c));
    filho.stderr.on('data', () => { /* descartado de propósito: pode conter o token */ });
    filho.on('error', (e) => fim(reject, new Error(`não consegui iniciar o gravador como o agente (uid ${uid}, gid ${gid}): ${e.code || e.name}`)));
    filho.on('close', (codigo) => {
      let r = null;
      try { r = JSON.parse(Buffer.concat(saida).toString('utf8')); } catch (_) { /* sem JSON */ }
      if (codigo === 0 && r && r.ok === true) return fim(resolve);
      const motivo = r && r.erro ? r.erro : `o gravador terminou com código ${codigo} sem explicar`;
      return fim(reject, new Error(motivo.split(token).join('[token]')));
    });
    filho.stdin.on('error', () => { /* o 'close' conta o que houve */ });
    filho.stdin.end(JSON.stringify({ token }));
  });
}

/**
 * `gravaToken({ token, home, uid, gid })`: assíncrona, rejeita com Error em português.
 * O padrão é gravaComoAgente; os testes de rota injetam um gravador falso.
 */
function criaInterceptor(opcoes) {
  const o = opcoes || {};
  const grava = o.gravaToken || gravaComoAgente;

  /** Guarda o token. Devolve { erro: {status, corpo} } ou { mascarado, marca }. Nunca loga nem devolve o token. */
  async function guardar(agente, tokenBruto) {
    const token = tokenBruto.trim();
    if (agente.tipo === 'admin') {
      return { erro: erro(400, 'O Admin não tem canal externo. Abra a conversa do agente que vai usar o Telegram e cole o token lá.') };
    }
    const home = agente.home_host;
    if (!home) return { erro: erro(500, `O agente ${agente.nome} não tem home_host no registro, então não sei onde guardar o token. Ele NÃO foi guardado nem enviado ao agente.`) };
    let st;
    try { st = fs.statSync(home); } catch (e) {
      return { erro: erro(500, `A pasta do agente ${agente.nome} (${home}) não existe ou não pode ser lida (${e.code || e.name}), então o token NÃO foi guardado nem enviado ao agente. Confira home_host no registro de agentes.`) };
    }
    if (st.uid === 0 || st.gid === 0) {
      return { erro: erro(500, `A casa do agente (${home}) pertence ao root; o token não foi guardado nem enviado ao agente. Confira o agentes.json/home_host.`) };
    }
    try {
      await grava({ token, home, uid: st.uid, gid: st.gid });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split(token).join('[token]');
      return { erro: erro(500, `Não consegui guardar o token do Telegram de ${agente.nome} em ${home}/.dgclaw/telegram: ${msg}. O token NÃO foi guardado nem enviado ao agente.`) };
    }
    return { mascarado: mascara(token), marca: marcaParaAgente(token) };
  }

  return { ehToken, guardar };
}

module.exports = { criaInterceptor, gravaComoAgente, ehToken, mascara, marcaParaAgente, RX_TOKEN };
