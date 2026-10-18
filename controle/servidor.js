'use strict';
// Serviço de controle do DG Claw (docs/enterprise/CONTROLE.md). Roda como root no host, SEM nenhum modelo de
// linguagem, e escuta num socket unix. Quem fala com ele é o Web (o Admin pede pela caixa, o TI pelo painel).
//
// Protocolo: uma linha JSON por pedido  {op, params?, quem, aprovacao?}  e uma linha JSON de resposta
//   {ok: true, resultado}  ou  {ok: false, motivo, erro}.   `motivo` é um destes:
//   op_desconhecida, parametros, aprovacao_necessaria, aprovacao_invalida, em_andamento, nao_encontrado, falha_execucao, pedido_invalido.
//
// Defesa em profundidade: operação perigosa sem aprovação válida é recusada AQUI, mesmo que o Web (ou quem tenha
// acesso ao socket) tente. A aprovação precisa existir no armazenamento, estar `aprovada`, ser da mesma operação e
// dos mesmos parâmetros (hash), não estar usada nem vencida; ao ser aceita ela é marcada como usada na mesma trava.
// Toda chamada vai para a auditoria (origem "controle") com quem pediu, a operação, os parâmetros e o resultado.

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const catalogo = require('./catalogo');
const { criarArmazem, hashParams, ErroAprovacao } = require('../web/lib/aprovacoes-arquivo');
const { criarAuditoria } = require('../web/lib/auditoria');
const { criarProtecoes } = require('../web/lib/protecoes');
const { mascarar } = require('../web/lib/mascara');

const RX_QUEM = /^[A-Za-z0-9_.:@-]{1,80}$/;
const LINHA_MAX = 64 * 1024;
const TAREFAS_MAX = 100;

/** Tarefas em segundo plano (memória; as últimas 100). */
function criarTarefas(agora) {
  const mapa = new Map();
  return {
    criar(op, quem, chave) {
      const id = crypto.randomBytes(6).toString('hex');
      const t = { id, op, quem, chave: chave || null, estado: 'rodando', inicio: new Date(agora()).toISOString(), fim: null, resultado: null, erro: null };
      mapa.set(id, t);
      while (mapa.size > TAREFAS_MAX) mapa.delete(mapa.keys().next().value);
      return t;
    },
    emAndamento(op, chave) {
      for (const t of mapa.values()) if (t.estado === 'rodando' && t.op === op && chave && t.chave === chave) return t;
      return null;
    },
    ver(id) {
      const t = mapa.get(id);
      return t ? { id: t.id, op: t.op, estado: t.estado, inicio: t.inicio, fim: t.fim, resultado: t.resultado, erro: t.erro } : null;
    },
    rodando: () => [...mapa.values()].filter((t) => t.estado === 'rodando').length,
  };
}

/** Esconde o que parece segredo nos textos dos parâmetros antes de ir para a auditoria. */
function paramsParaAuditoria(params) {
  const saida = {};
  for (const [k, v] of Object.entries(params || {})) saida[k] = typeof v === 'string' ? mascarar(v) : v;
  return saida;
}

function criarControle(opcoes) {
  const o = opcoes || {};
  const log = o.log || (() => {});
  const agora = o.agora || Date.now;
  const dataDir = o.dataDir;
  if (!o.socket || !dataDir) throw new Error('criarControle precisa de "socket" (o caminho do socket unix) e de "dataDir" (a pasta de dados do Web).');
  const protecoes = o.protecoes || criarProtecoes({ caminho: o.protecoesPath, log });
  const auditoria = o.auditoria || criarAuditoria({ caminho: o.auditoriaPath || '/var/log/dgclaw/auditoria.jsonl', protecoes, log, agora });
  const armazem = criarArmazem({ dataDir, log });
  const tarefas = criarTarefas(agora);
  const base = {
    bin: o.bin || '/usr/local/bin/dgclaw',
    agentesPath: o.agentesPath || '/etc/dgclaw/agentes.json',
    casasDir: o.casasDir || '/var/lib/dgclaw/agentes',
    dataDir, log, tarefas,
  };

  function auditar(evento, dados, quem) {
    try {
      auditoria.registrar(evento, dados, quem || 'desconhecido', 'controle');
    } catch (e) {
      log('erro', `Não consegui gravar o evento "${evento}" na auditoria (${e.message}). A operação seguiu, mas ficou sem registro; confira a pasta da auditoria.`);
    }
  }

  const recusa = (motivo, erro) => ({ ok: false, motivo, erro });

  /** Confere e consome a aprovação. Devolve null se vale, ou a resposta de recusa. */
  function consumirAprovacao(op, params, quem, aprovacao) {
    if (!aprovacao || typeof aprovacao !== 'object' || !armazem.ehId(aprovacao.id)) {
      return recusa('aprovacao_necessaria', `A operação ${op} é perigosa e só executa com a aprovação de uma pessoa do TI no painel. Peça a operação pelo painel ou pelo dgclaw-controle e espere o TI aprovar; não há como pular essa etapa.`);
    }
    const hash = hashParams(params);
    class Recusa extends Error {}
    try {
      armazem.atualizar(aprovacao.id, (reg) => {
        const nao = (txt) => { throw new Recusa(txt); };
        if (reg.tipo !== 'controle') nao(`o pedido ${reg.id} é do tipo "${reg.tipo}", e este serviço só executa pedidos do tipo "controle"`);
        if (reg.op !== op) nao(`o pedido ${reg.id} foi aprovado para a operação "${reg.op}", e não para "${op}"`);
        if (reg.params_hash !== hash) nao(`os parâmetros desta chamada não são os que o TI aprovou no pedido ${reg.id}`);
        if (reg.estado !== 'aprovada') nao(`o pedido ${reg.id} está "${reg.estado}", e só um pedido "aprovada" executa`);
        if (reg.usada_em) nao(`o pedido ${reg.id} já foi usado em ${reg.usada_em}; cada aprovação vale uma vez só`);
        if (!(Date.parse(reg.expira_em) > agora())) nao(`o pedido ${reg.id} venceu em ${reg.expira_em}; peça de novo`);
        if (aprovacao.aprovado_por !== reg.decidido_por) nao(`quem aprovou (${String(aprovacao.aprovado_por).slice(0, 40)}) não bate com o registro do pedido ${reg.id}`);
        reg.usada_em = new Date(agora()).toISOString();
        reg.usada_por = quem;
        return null;
      });
    } catch (e) {
      if (e instanceof Recusa) return recusa('aprovacao_invalida', `Aprovação recusada pelo controle: ${e.message}.`);
      if (e instanceof ErroAprovacao) {
        if (e.codigo === 'NAO_EXISTE') return recusa('aprovacao_invalida', `Aprovação recusada pelo controle: não existe o pedido ${aprovacao.id}.`);
        log('erro', `Controle: falha ao conferir a aprovação ${aprovacao.id}: ${e.message}`);
        return recusa('aprovacao_invalida', `O controle não conseguiu conferir a aprovação ${aprovacao.id}: ${e.message}`);
      }
      throw e;
    }
    return null;
  }

  async function executarDef(def, params, ctx) {
    if (def.nativa) return def.nativa(params, ctx);
    return def.executar(ctx, params);
  }

  /** Processa um pedido já em objeto e devolve a resposta (objeto). Nunca lança. */
  async function processar(pedido) {
    if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) return recusa('pedido_invalido', 'O pedido precisa ser um objeto JSON {"op": "...", "params": {...}, "quem": "..."}.');
    const { op, quem } = pedido;
    if (typeof quem !== 'string' || !RX_QUEM.test(quem)) return recusa('pedido_invalido', 'O campo "quem" é obrigatório: de 1 a 80 caracteres entre letras, números e _ . : @ - (por exemplo "agente:admin" ou "ti:maria").');
    const v = catalogo.validar(op, pedido.params);
    if (!v.ok) {
      auditar('controle_recusado', { op: String(op).slice(0, 60), motivo: v.motivo, erro: v.erro.slice(0, 300) }, quem);
      return recusa(v.motivo, v.erro);
    }
    const def = catalogo.OPS[op];
    const params = v.params;
    const comum = { op, classe: def.classe, params: paramsParaAuditoria(params) };

    let aprovacaoId = null;
    if (def.classe === 'perigosa') {
      const r = consumirAprovacao(op, params, quem, pedido.aprovacao);
      if (r) {
        auditar('controle_recusado', Object.assign({}, comum, { motivo: r.motivo, erro: r.erro.slice(0, 300), aprovacao: pedido.aprovacao && typeof pedido.aprovacao.id === 'string' ? pedido.aprovacao.id.slice(0, 40) : null }), quem);
        return r;
      }
      aprovacaoId = pedido.aprovacao.id;
    }
    const extra = aprovacaoId ? { aprovacao: aprovacaoId, aprovado_por: pedido.aprovacao.aprovado_por } : {};
    const ctx = Object.assign({}, base, { quem });

    try {
      if (def.demorada) {
        const chave = def.chave ? def.chave(params) : null;
        const andando = tarefas.emAndamento(op, chave);
        if (andando) {
          auditar('controle_recusado', Object.assign({}, comum, extra, { motivo: 'em_andamento', tarefa: andando.id }), quem);
          return recusa('em_andamento', `Já existe uma tarefa ${op} em andamento para isso (${andando.id}). Acompanhe com tarefa.ver e peça de novo quando ela terminar.`);
        }
        const t = tarefas.criar(op, quem, chave);
        auditar('controle_op', Object.assign({}, comum, extra, { resultado: 'iniciada', tarefa: t.id }), quem);
        executarDef(def, params, ctx).then((res) => {
          Object.assign(t, { estado: 'ok', fim: new Date(agora()).toISOString(), resultado: res });
          auditar('controle_tarefa_fim', { op, tarefa: t.id, resultado: 'ok' }, quem);
        }, (e) => {
          const msg = e instanceof catalogo.ErroOperacao ? e.message : `Erro inesperado em ${op}: ${e && e.message}`;
          if (!(e instanceof catalogo.ErroOperacao)) log('erro', `Controle: ${msg}`);
          Object.assign(t, { estado: 'erro', fim: new Date(agora()).toISOString(), erro: msg });
          auditar('controle_tarefa_fim', { op, tarefa: t.id, resultado: 'erro', erro: msg.slice(0, 300) }, quem);
        });
        return { ok: true, resultado: { tarefa: t.id, estado: 'rodando', aviso: 'A operação segue em segundo plano. Acompanhe com tarefa.ver.' } };
      }
      const resultado = await executarDef(def, params, ctx);
      auditar('controle_op', Object.assign({}, comum, extra, { resultado: 'ok' }), quem);
      return { ok: true, resultado };
    } catch (e) {
      if (e instanceof catalogo.ErroOperacao) {
        auditar('controle_op', Object.assign({}, comum, extra, { resultado: 'erro', erro: e.message.slice(0, 300) }), quem);
        return recusa(e.motivo, e.message);
      }
      log('erro', `Controle: erro inesperado na operação ${op}: ${e && e.stack || e}`);
      auditar('controle_op', Object.assign({}, comum, extra, { resultado: 'erro', erro: String(e && e.message).slice(0, 300) }), quem);
      return recusa('falha_execucao', `Erro inesperado ao executar ${op} (${e && e.message}). Veja o log do dgclaw-controle no servidor: journalctl -u dgclaw-controle.`);
    }
  }

  // ── socket ─────────────────────────────────────────────────────────────────
  let servidor = null;

  function atende(conexao) {
    conexao.setEncoding('utf8');
    conexao.setTimeout(120000, () => conexao.destroy());
    let buf = '';
    let fila = Promise.resolve();
    const responde = (obj) => { if (!conexao.destroyed) conexao.write(`${JSON.stringify(obj)}\n`); };
    conexao.on('error', (e) => log('aviso', `Controle: conexão com erro (${e.code || e.message}).`));
    conexao.on('data', (pedaco) => {
      buf += pedaco;
      if (buf.length > LINHA_MAX && !buf.includes('\n')) {
        responde(recusa('pedido_invalido', `O pedido passa de ${LINHA_MAX} bytes numa linha só.`));
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
            responde(recusa('pedido_invalido', `O pedido não é um JSON válido (${e.message}).`));
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
        fs.chmodSync(pasta, 0o750);
        if (fs.existsSync(o.socket)) fs.unlinkSync(o.socket);
      } catch (e) {
        reject(new Error(`Não consegui preparar a pasta do socket ${pasta} (${e.code || e.message}). O controle precisa rodar como root e a pasta precisa existir com permissão 750.`));
        return;
      }
      servidor = net.createServer(atende);
      servidor.once('error', (e) => reject(new Error(`Não consegui abrir o socket ${o.socket} (${e.code || e.message}).`)));
      servidor.listen(o.socket, () => {
        try {
          // Se o Web um dia deixar de ser root, o grupo dele entra aqui (DGCLAW_CONTROLE_GRUPO) e o modo passa a 660.
          if (o.gid != null) { fs.chownSync(o.socket, 0, o.gid); fs.chmodSync(o.socket, 0o660); } else fs.chmodSync(o.socket, 0o600);
        } catch (e) {
          servidor.close();
          reject(new Error(`Não consegui ajustar a permissão do socket ${o.socket} (${e.code || e.message}).`));
          return;
        }
        log('info', `Controle escutando em ${o.socket}.`);
        resolve();
      });
    });
  }

  function fechar() {
    return new Promise((resolve) => {
      if (!servidor) { resolve(); return; }
      servidor.close(() => { try { fs.unlinkSync(o.socket); } catch (_) { /* já sumiu */ } resolve(); });
      servidor.closeAllConnections && servidor.closeAllConnections();
    });
  }

  return { ouvir, fechar, processar, tarefas, armazem };
}

module.exports = { criarControle, criarTarefas };

/**
 * Se a máquina reiniciou (ou o timer do systemd se perdeu) com a manutenção de emergência aberta, o estado fica
 * para trás. Ao subir, o controle confere o prazo e manda fechar o que venceu.
 */
function fecharManutencaoVencida(env, log) {
  const arq = path.join(env.DGCLAW_WEB_DATA || '/var/lib/dgclaw/web', 'controle', 'manutencao.json');
  let estado;
  try { estado = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') log('aviso', `Controle: não consegui ler o estado da manutenção em ${arq} (${e.code || e.message}). Se a manutenção ficou aberta, feche com: dgclaw admin manutencao fechar`);
    return;
  }
  if (Number(estado.fecha_em) > Date.now()) return;
  log('aviso', `Controle: a manutenção de emergência aberta por ${estado.por || 'alguém'} venceu e continuava registrada. Estou fechando.`);
  execFile(env.DGCLAW_BIN || '/usr/local/bin/dgclaw', ['admin', 'manutencao', 'fechar', '--auto'], { timeout: 60000 }, (erro, saida, errosaida) => {
    if (erro) log('erro', `Controle: não consegui fechar a manutenção vencida (${erro.message}). ${String(errosaida || saida).trim().slice(0, 300)} Feche à mão: dgclaw admin manutencao fechar`);
  });
}

if (require.main === module) {
  const env = process.env;
  const log = (nivel, msg) => { process.stderr.write(`[${new Date().toISOString()}] [${nivel}] ${msg}\n`); };
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !env.DGCLAW_CONTROLE_SEM_ROOT) {
    log('erro', 'O serviço de controle precisa rodar como root (ele chama o dgclaw, que mexe em containers e firewall). Suba pela unidade dgclaw-controle.service.');
    process.exit(1);
  }
  const c = criarControle({
    socket: env.DGCLAW_CONTROLE_SOCK || '/run/dgclaw/controle.sock',
    dataDir: env.DGCLAW_WEB_DATA || '/var/lib/dgclaw/web',
    bin: env.DGCLAW_BIN || '/usr/local/bin/dgclaw',
    agentesPath: env.DGCLAW_AGENTES || '/etc/dgclaw/agentes.json',
    casasDir: env.DGCLAW_CASAS || '/var/lib/dgclaw/agentes',
    protecoesPath: env.DGCLAW_PROTECOES || '/etc/dgclaw/protecoes.json',
    auditoriaPath: env.DGCLAW_AUDITORIA || '/var/log/dgclaw/auditoria.jsonl',
    gid: env.DGCLAW_CONTROLE_GRUPO ? Number(env.DGCLAW_CONTROLE_GRUPO) : null,
    log,
  });
  c.ouvir().then(() => fecharManutencaoVencida(env, log)).catch((e) => { log('erro', e.message); process.exit(1); });
  for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => { c.fechar().then(() => process.exit(0)); });
}
