'use strict';
// Serviço de ferramentas do DG Claw (bloco I, docs/enterprise/KIT-SENSIVEL.md). Roda no host com um usuário próprio
// SEM privilégio (dgclaw-ferramentas), sem nenhum modelo de linguagem, e escuta num socket unix que só o Web alcança.
//
// Protocolo: uma linha JSON por pedido e uma linha JSON de resposta.
//   {op: "listar", agente}                                    -> {ok: true, ferramentas: [...]}
//   {op: "executar", ferramenta, agente, usuario?, params?}   -> {ok: true, resultado, meta} ou {ok: false, motivo, erro, tipos?, meta?}
// `motivo`: pedido_invalido, ferramenta_desconhecida, ferramenta_invalida, agente_nao_autorizado, parametros, credencial,
// ocupado, tempo_esgotado, memoria_esgotada, falha_execucao, saida_invalida, bloqueado_pelo_verificador.
//
// Quem confere o nível (`kit_sensivel`) e grava a auditoria é o Web: este usuário não lê /etc/dgclaw/protecoes.json nem
// escreve na trilha. O socket é o limite de confiança: só o Web (root) ou o grupo dele abre.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { criarNucleo } = require('./nucleo');
const { resumoPublico } = require('./esquema');

const LINHA_MAX = 64 * 1024;

function criarServidor(opcoes) {
  const o = opcoes || {};
  if (!o.socket || !o.dir) throw new Error('criarServidor precisa de "socket" (caminho do socket unix) e de "dir" (pasta das ferramentas).');
  const log = o.log || (() => {});
  const nucleo = o.nucleo || criarNucleo({ dir: o.dir, credRam: o.credRam, libDir: o.libDir, chavePath: o.chavePath, python: o.python, log, agora: o.agora, tmpBase: o.tmpBase, maxConcorrentes: o.maxConcorrentes });
  let servidor = null;

  async function processar(pedido) {
    if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) return { ok: false, motivo: 'pedido_invalido', erro: 'O pedido precisa ser um objeto JSON {"op": "listar"|"executar", ...}.' };
    if (pedido.op === 'listar') {
      if (typeof pedido.agente !== 'string' || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(pedido.agente)) return { ok: false, motivo: 'pedido_invalido', erro: 'O campo "agente" é obrigatório (o slug do agente).' };
      return { ok: true, ferramentas: nucleo.listar(pedido.agente).ferramentas.map(resumoPublico) };
    }
    if (pedido.op === 'executar') {
      // `executor` é só do teste local (testar.js); pelo socket ele nunca vale.
      const { executor, ...limpo } = pedido;
      return nucleo.executar(limpo);
    }
    return { ok: false, motivo: 'pedido_invalido', erro: `A operação ${JSON.stringify(String(pedido.op).slice(0, 40))} não existe. Use "listar" ou "executar".` };
  }

  function atende(conexao) {
    conexao.setEncoding('utf8');
    conexao.setTimeout(60000, () => conexao.destroy());
    let buf = '';
    let fila = Promise.resolve();
    const responde = (obj) => { if (!conexao.destroyed) conexao.write(`${JSON.stringify(obj)}\n`); };
    conexao.on('error', (e) => log('aviso', `Ferramentas: conexão com erro (${e.code || e.message}).`));
    conexao.on('data', (pedaco) => {
      buf += pedaco;
      if (buf.length > LINHA_MAX && !buf.includes('\n')) {
        responde({ ok: false, motivo: 'pedido_invalido', erro: `O pedido passa de ${LINHA_MAX} bytes numa linha só.` });
        conexao.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const linha = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!linha.trim()) continue;
        fila = fila.then(async () => {
          let pedido;
          try { pedido = JSON.parse(linha); } catch (e) {
            responde({ ok: false, motivo: 'pedido_invalido', erro: `O pedido não é um JSON válido (${e.message}).` });
            return;
          }
          responde(await processar(pedido));
        });
      }
    });
  }

  function ouvir() {
    return new Promise((resolve, reject) => {
      const pasta = path.dirname(o.socket);
      try {
        fs.mkdirSync(pasta, { recursive: true, mode: 0o750 });
        if (fs.existsSync(o.socket)) fs.unlinkSync(o.socket);
      } catch (e) {
        reject(new Error(`Não consegui preparar a pasta do socket ${pasta} (${e.code || e.message}). Ela precisa existir e ser do usuário do serviço (a unidade dgclaw-ferramentas.service cria com RuntimeDirectory).`));
        return;
      }
      servidor = net.createServer(atende);
      servidor.once('error', (e) => reject(new Error(`Não consegui abrir o socket ${o.socket} (${e.code || e.message}).`)));
      servidor.listen(o.socket, () => {
        try {
          // Dono = usuário do serviço. Se o Web deixar de ser root, o grupo dele entra em DGCLAW_FERRAMENTAS_GRUPO (modo 660).
          if (o.gid != null) { fs.chownSync(o.socket, process.getuid(), o.gid); fs.chmodSync(o.socket, 0o660); } else fs.chmodSync(o.socket, 0o600);
        } catch (e) {
          servidor.close();
          reject(new Error(`Não consegui ajustar a permissão do socket ${o.socket} (${e.code || e.message}).`));
          return;
        }
        log('info', `Ferramentas escutando em ${o.socket}.`);
        resolve();
      });
    });
  }

  function fechar() {
    return new Promise((resolve) => {
      if (!servidor) { resolve(); return; }
      servidor.close(() => { try { fs.unlinkSync(o.socket); } catch (_) { /* já sumiu */ } resolve(); });
      if (servidor.closeAllConnections) servidor.closeAllConnections();
    });
  }

  return { ouvir, fechar, processar, nucleo };
}

module.exports = { criarServidor };

if (require.main === module) {
  const env = process.env;
  const log = (nivel, msg) => { process.stderr.write(`[${new Date().toISOString()}] [${nivel}] ${msg}\n`); };
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !env.DGCLAW_FERRAMENTAS_COM_ROOT) {
    log('erro', 'O serviço de ferramentas não pode rodar como root: ele existe para ficar sem privilégio. Suba pela unidade dgclaw-ferramentas.service (User=dgclaw-ferramentas).');
    process.exit(1);
  }
  const s = criarServidor({
    socket: env.DGCLAW_FERRAMENTAS_SOCK || '/run/dgclaw-ferramentas/ferramentas.sock',
    dir: env.DGCLAW_FERRAMENTAS_DIR || '/etc/dgclaw/ferramentas',
    credRam: env.DGCLAW_FERRAMENTAS_CRED_RAM || '/run/dgclaw/ferramentas-cred',
    libDir: env.DGCLAW_FERRAMENTAS_LIB || path.join(__dirname, 'lib'),
    python: env.DGCLAW_FERRAMENTAS_PYTHON || 'python3',
    gid: env.DGCLAW_FERRAMENTAS_GRUPO ? Number(env.DGCLAW_FERRAMENTAS_GRUPO) : null,
    log,
  });
  s.ouvir().catch((e) => { log('erro', e.message); process.exit(1); });
  for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { s.fechar().then(() => process.exit(0)); });
}
