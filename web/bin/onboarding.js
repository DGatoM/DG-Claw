#!/usr/bin/env node
'use strict';
// Chamado pelo Admin. Nunca roda comandos vindos do formulário como shell.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { criarServidor } = require('../server');
const { loja, registrarPedido, RX_ID } = require('../lib/onboarding');

// Versão empresa (credencial_empresa): agente de pessoa entra com o assento de quem criou (--usuario); agente de setor usa a
// chave de API da empresa. Sem a proteção, o comando é o de sempre: --auth assinatura.
function argsDeUso(web, p) {
  const ligada = !!web.protecoes && web.protecoes.ligada('credencial_empresa');
  if (!ligada) return ['--auth', 'assinatura'];
  if (p.uso === 'setor') return ['--auth', 'api', '--uso', 'setor'];
  return ['--auth', 'assinatura', '--uso', 'pessoa', ...(p.usuario ? ['--usuario', p.usuario] : [])];
}

async function executar(acao, id, op = {}) {
  const uso = 'Uso: node web/bin/onboarding.js criar|testar|ver <id do pedido|atual>, ou pedir com o JSON {nome, papel, jeito, dono} no STDIN';
  const web = op.web || (acao === 'pedir' || (['criar', 'testar', 'ver'].includes(acao) && (RX_ID.test(id || '') || id === 'atual')) ? criarServidor() : null);
  if (!web) throw new Error(uso);
  if (acao === 'pedir') return registrarPedido({ config: web.config, registro: web.registro, dados: op.dados });
  if (!['criar', 'testar', 'ver'].includes(acao) || !(RX_ID.test(id || '') || id === 'atual')) throw new Error(uso);
  const db = loja(web.config.dataDir);
  if (id === 'atual') id = db.ultimo()?.id;
  let p = id ? db.ler(id) : null;
  if (!p) throw new Error('Não achei o pedido confirmado. Peça ao dono para abrir o formulário no Admin.');
  if (acao === 'ver') return p;
  if (p.fase === 'pronto') return p;
  const lock = path.join(db.dir, id + '.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('Este pedido já está em andamento. Aguarde um pouco e tente de novo.');
    throw e;
  }
  fs.writeFileSync(fd, String(process.pid));
  // ultimaFase e motivo só alimentam a barra de progresso: dizem onde o erro aconteceu e por quê.
  const mudar = (fase, mensagem, extra = {}) => { p = db.gravar({ ...p, fase, mensagem, ultimaFase: fase === 'erro' && p.fase !== 'erro' ? p.fase : p.ultimaFase, ...extra }); };
  try {
    if (acao === 'criar') {
      // Reexecução do MESMO pedido retoma o login sem reprovisionar o agente.
      if (!web.registro.obter(p.slug)) {
        mudar('criando', 'Preparando a casa, a memória e a identidade do seu agente.');
        const logFile = path.join(db.dir, id + '.log');
        const logFd = fs.openSync(logFile, 'a', 0o600);
        let codigo;
        try {
          codigo = await new Promise((resolve, reject) => {
            const proc = (op.spawn || spawn)(op.cli || '/usr/local/bin/dgclaw', ['agente', 'criar', p.slug, '--nome', p.nome, '--provedor', p.provedor, ...argsDeUso(web, p), '--papel', p.papel, '--jeito', p.jeito, '--dono', p.dono, '--canal', 'chat'], { stdio: ['ignore', logFd, logFd], shell: false });
            proc.once('error', reject);
            proc.once('exit', (code) => resolve(code));
          });
        } finally { fs.closeSync(logFd); }
        if (codigo !== 0) throw new Error('A criação parou. O Admin vai conferir o registro e retomar.');
      }
      if (!web.registro.obter(p.slug)) throw new Error('A criação não terminou direito. O Admin vai conferir o registro e retomar.');
      mudar('login', p.uso === 'setor' && web.protecoes && web.protecoes.ligada('credencial_empresa')
        ? 'Seu agente foi criado. Guarde a chave de API da empresa no Cofre do painel dele para ligar a conversa. Depois volte aqui e avise o Admin.'
        : 'Seu agente foi criado. Entre com sua assinatura no painel dele para ligar a conversa. Depois volte aqui e avise o Admin.');
      return p;
    }
    const agente = web.registro.obter(p.slug);
    if (!agente || agente.tipo === 'admin') throw new Error('Seu agente ainda não foi criado. O Admin precisa criar ele primeiro.');
    mudar('testando', 'Conferindo se o seu agente consegue responder.');
    const TEXTO_OI = 'Oi! Sou ' + p.dono + '. Acabei de te criar. Me cumprimente pelo nome, se apresente brevemente e me ofereça estas opções, numeradas e nesta ordem: 1. Conectar a Groq, para conversarmos por áudio. 2. Conectar o Gmail. 3. Mão na massa: começar logo uma tarefa. 4. Conectar a API do Gemini no modo gratuito, para você me ajudar com análise de vídeo. Canais e conexões que ainda não configuramos não são falha: não fale de erro deles.';
    // Envia o oi e espera a resposta. A resposta só conta se for nova em relação ao que existia antes deste envio.
    const tentar = async () => {
      const antes = new Set((await web.conversa.thread(agente)).msgs.map(m => m.id));
      const envio = await web.conversa.enviar(agente, { text: TEXTO_OI });
      if (envio.status >= 300) throw new Error('Seu agente não recebeu a mensagem de teste. O Admin vai conferir a conexão dele.');
      const fim = Date.now() + (op.esperaMs || 60000);
      do {
        const thread = await web.conversa.thread(agente);
        const resposta = thread.msgs.find(m => m.origin === 'agente' && !antes.has(m.id) && m.ep >= envio.corpo.ep_enviado - 1);
        if (resposta) return resposta;
        await new Promise(r => setTimeout(r, op.intervaloMs || 1500));
      } while (Date.now() < fim);
      return null;
    };
    let resposta = await tentar();
    if (!resposta) {
      // O container pode ter subido antes do login terminar: reinicia uma vez e tenta de novo.
      mudar('testando', 'Seu agente ligou antes do login terminar. Estou reiniciando ele para pegar a sua conta.');
      const codigo = await new Promise((resolve, reject) => {
        const proc = (op.spawn || spawn)(op.cli || '/usr/local/bin/dgclaw', ['agente', 'reiniciar', p.slug], { stdio: 'ignore', shell: false });
        proc.once('error', reject);
        proc.once('exit', (code) => resolve(code));
      });
      if (codigo !== 0) throw new Error('Não consegui reiniciar o seu agente. O Admin vai conferir e tentar de novo.');
      await new Promise(r => setTimeout(r, op.reinicioMs ?? 8000));
      resposta = await tentar();
    }
    if (resposta) {
      p.respostaId = resposta.id;
      mudar('pronto', 'Seu agente respondeu e está pronto para conversar.');
      return p;
    }
    throw new Error('Seu agente ainda não respondeu. Confira se a sua conta foi conectada no painel dele e peça ao Admin para testar de novo.');
  } catch (e) {
    mudar('erro', 'A preparação precisa de atenção. O Admin vai conferir o que aconteceu; seus dados continuam guardados.', { motivo: e.message });
    throw e;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
module.exports = { executar };
// O texto da pessoa chega pelo STDIN, nunca por argv, para não passar por shell.
function lerDados() {
  let bruto = '';
  try { bruto = fs.readFileSync(0, 'utf8'); } catch (e) { throw new Error(`Não consegui ler o STDIN (${e.code || e.message}). Envie o JSON {"nome": "...", "papel": "...", "jeito": "...", "dono": "..."} por heredoc.`); }
  if (!bruto.trim()) throw new Error('Não chegou nada pelo STDIN. Envie o JSON {"nome": "...", "papel": "...", "jeito": "...", "dono": "..."} por heredoc.');
  try { return JSON.parse(bruto); } catch (e) {
    throw new Error(`O JSON recebido pelo STDIN é inválido (${e.message}). O formato é {"nome": "...", "papel": "...", "jeito": "...", "dono": "..."}, com aspas duplas e barras escapadas.`);
  }
}
if (require.main === module) Promise.resolve().then(() => executar(process.argv[2], process.argv[3], process.argv[2] === 'pedir' ? { dados: lerDados() } : {})).then(p => console.log(JSON.stringify(p))).catch(e => { console.error(e.message); process.exitCode = 1; });
