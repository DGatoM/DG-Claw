'use strict';
// Diagnóstico remoto, só leitura: GET /api/v1/diagnostico devolve o estado de tudo o que precisa estar vivo, com o
// motivo de cada item parado e o que fazer. Contrato e formato: docs/interno/PLANO-DIAGNOSTICO-REMOTO.md.
// O porteiro (chave de API, sessão) fica no server.js; aqui só se coleta e se responde.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../http');
const { lerEnvArquivo } = require('../config');
const { criarAtualizacao } = require('../atualizacao');
const { lerSeguro } = require('./arquivos');
const { protege } = require('./higiene');
const { sanearOcorrencias } = require('./classificar');
const { tarefasDaMaquina } = require('./maquina');
const { tarefaDeVersao } = require('./versao');
const { tarefasDoAgente } = require('./agente');
const { analisaLogin, analisaSessao } = require('./sessao');
const U = require('./util');

const BASE = '/api/v1/diagnostico';
const ARQUIVO_DOCS = path.join(__dirname, '..', '..', 'docs', 'DIAGNOSTICO-REMOTO.md');
const CACHE_MS = 20000;
const LIMITE_PADRAO_MS = 5000;
const SCHEMA = 1;
const GRAVIDADE = { ok: 0, nao_medido: 1, atencao: 2, quebrado: 3 };

function criarDiagnostico(deps) {
  const { config, registro, runner, log } = deps;
  const ctx = {
    config, runner, log,
    exec: deps.exec || U.execPadrao,
    lerArquivo: deps.lerArquivo || lerSeguro,
    agora: deps.agora || (() => Date.now()),
    statfs: deps.statfs || ((p) => fs.promises.statfs(p)),
    meminfo: deps.meminfo || (() => fs.promises.readFile('/proc/meminfo', 'utf8')),
    uptime: deps.uptime || (() => os.uptime()),
    procVivo: deps.procVivo || ((pid) => fs.existsSync(`/proc/${pid}`)),
    lerEnv: deps.lerEnv || lerEnvArquivo,
    atualizacao: deps.atualizacao || criarAtualizacao({ dataDir: config.dataDir, log }),
  };
  ctx.tz = config.tz;
  const limiteMs = deps.limiteMs || LIMITE_PADRAO_MS;

  /** Roda uma tarefa (uma vez só) com tempo limite próprio e devolve o resultado já completo e higienizado. */
  function executar(t) {
    if (t.promessa) return t.promessa;
    t.promessa = (async () => {
      const dep = t.depende ? await executar(t.depende) : undefined;
      let bruto;
      const lim = await U.comLimite((async () => {
        try { return await t.fn(dep); } catch (e) {
          log('erro', `Diagnóstico: a verificação ${t.id} falhou por erro interno: ${e && e.stack ? e.stack : e}`);
          return U.R('nao_medido', 'O diagnóstico não conseguiu medir este item por um erro interno. O detalhe está no log do DG Claw Web (journalctl -u dgclaw-web).');
        }
      })(), limiteMs);
      if (lim.estourou) {
        log('aviso', `Diagnóstico: a verificação ${t.id} não respondeu em ${limiteMs / 1000} s e ficou como não medida.`);
        bruto = U.R('nao_medido', `Não respondeu em ${limiteMs / 1000} s.`);
      } else bruto = lim.valor;
      if (bruto && Array.isArray(bruto.varias)) {
        const itens = bruto.varias.map((v) => completa(t, v, `${t.id}.${String(v.sufixo).replace(/^cron\./, '')}`));
        return { estado: itens.reduce((a, i) => (GRAVIDADE[i.estado] > GRAVIDADE[a] ? i.estado : a), 'ok'), varias: itens };
      }
      return completa(t, bruto, t.id);
    })();
    return t.promessa;
  }

  /** Deixa a verificação no formato final, com os campos obrigatórios e uma passada de higiene nos textos. */
  function completa(t, r, id) {
    const estado = GRAVIDADE[r.estado] !== undefined ? r.estado : 'nao_medido';
    const ev = r.evidencia && typeof r.evidencia === 'object'
      ? {
        horario: r.evidencia.horario || null,
        codigo_saida: Number.isInteger(r.evidencia.codigo_saida) ? r.evidencia.codigo_saida : null,
        sinal: protege(r.evidencia.sinal) || null,
        ocorrencias: sanearOcorrencias(r.evidencia.ocorrencias),
      }
      : null;
    let motivo = protege(r.motivo);
    let fazer = protege(r.o_que_fazer);
    if (estado !== 'ok' && !motivo) motivo = 'O diagnóstico não registrou o motivo deste item.';
    if (estado !== 'ok' && !fazer) {
      fazer = estado === 'nao_medido'
        ? 'Nada a fazer agora. Se continuar sem medir por mais de um dia, mostre este diagnóstico ao suporte.'
        : 'Mostre este item ao suporte, que vai dizer o que fazer.';
    }
    const v = {
      id, grupo: t.grupo, alvo: t.alvo || null, nome: protege(r.nome || t.nome), estado,
      ultimo_sinal: r.ultimo_sinal || null, motivo: estado === 'ok' ? null : motivo, evidencia: ev,
      o_que_fazer: estado === 'ok' ? null : fazer, prompt_sugerido: protege(r.prompt_sugerido) || null,
    };
    if (r.bloco) Object.defineProperty(v, 'bloco', { value: r.bloco, enumerable: false });
    if (r.parado) Object.defineProperty(v, 'parado', { value: true, enumerable: false });
    return v;
  }

  function montaTarefas() {
    const reg = registro.estado();
    const tarefas = [];
    const add = (t, grupo, alvo, id) => { t.grupo = grupo; t.alvo = alvo; t.id = id; tarefas.push(t); return t; };
    for (const t of tarefasDaMaquina(ctx)) add(t, 'maquina', null, `maquina.${t.sufixo}`);
    if (!reg.ok) {
      add({ nome: 'Registro de agentes', fn: async () => U.R('quebrado', 'Não consegui ler a lista de agentes. Sem ela o painel não sabe quem existe.', {
        o_que_fazer: U.ONDE_COLAR, prompt_sugerido: U.promptAdmin('o registro de agentes (agentes.json) do DG Claw não pôde ser lido.', '`dgclaw agente listar` e o log do serviço dgclaw-web', 'dgclaw status'),
      }) }, 'maquina', null, 'maquina.registro');
    }
    add(tarefaDeVersao(ctx), 'versao', null, 'versao');

    const admin = reg.ok ? reg.agentes.find((a) => a.tipo === 'admin') : null;
    if (admin) {
      add({ nome: 'Sessão do Admin', async fn() {
        const [saude, estado, provedor] = await Promise.all([runner.pedir(admin, 'GET', '/api/saude', null, 4000), runner.estado(admin), runner.provedor(admin, 4000)]);
        const login = analisaLogin(admin, { estado, provedor }, ctx.tz);
        if (login.estado === 'quebrado') return login;
        const sessao = analisaSessao(admin, { saude, estado }, { agoraMs: ctx.agora(), tz: ctx.tz, contMorto: false });
        return sessao;
      } }, 'admin', 'admin', 'admin.sessao');
    }
    for (const ag of reg.ok ? reg.agentes.filter((a) => a.tipo !== 'admin') : []) {
      if (!U.RX_NOME_SEGURO.test(ag.slug)) continue; // o registro já valida; aqui é a segunda trava antes de entrar em comando
      for (const t of tarefasDoAgente(ctx, ag)) add(t, 'agente', ag.slug, `agente.${ag.slug}.${t.sufixo}`);
    }
    return tarefas;
  }

  function resume(itens) {
    const c = { ok: 0, atencao: 0, quebrado: 0, nao_medido: 0 };
    for (const i of itens) c[i.estado] += 1;
    let estado = 'ok';
    if (c.quebrado) estado = 'quebrado';
    else if (c.atencao || (itens.length && c.ok === 0)) estado = 'atencao';
    const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
    const partes = [];
    if (c.quebrado) partes.push(`${plural(c.quebrado, 'item quebrado', 'itens quebrados')}`);
    if (c.atencao) partes.push(`${plural(c.atencao, 'pedindo atenção', 'pedindo atenção')}`);
    let frase;
    if (!itens.length) frase = 'Não havia nada para conferir.';
    else if (!partes.length) frase = c.ok === 0 ? `Nenhum item pôde ser medido (${c.nao_medido}).` : `Tudo certo: ${plural(c.ok, 'item conferido', 'itens conferidos')}${c.nao_medido ? `, ${c.nao_medido} sem medida` : ''}.`;
    else frase = `${partes.join(' e ')}${c.nao_medido ? `; ${c.nao_medido} sem medida` : ''}.`;
    return { estado, frase: frase.charAt(0).toUpperCase() + frase.slice(1), contagem: c };
  }

  async function coletar() {
    const inicio = process.hrtime.bigint();
    const tarefas = montaTarefas();
    const resultados = await Promise.all(tarefas.map((t) => executar(t)));
    const itens = [];
    let bloco = null;
    resultados.forEach((r, i) => {
      if (r.varias) itens.push(...r.varias);
      else { itens.push(r); if (tarefas[i].id === 'versao') bloco = r.bloco; }
    });
    return {
      ok: true,
      schema: SCHEMA,
      gerado_em: new Date(ctx.agora()).toISOString().replace(/\.\d+Z$/, 'Z'),
      duracao_ms: Number((process.hrtime.bigint() - inicio) / 1000000n),
      versao: bloco || { instalada: null, commit: null, publicada: null, atualizacao_disponivel: null, commits_a_frente: null, verificado_em: null },
      resumo: resume(itens),
      verificacoes: itens,
    };
  }

  let cache = null;
  let emAndamento = null;
  function obter() {
    if (cache && ctx.agora() - cache.em < CACHE_MS) return Promise.resolve(cache.valor);
    if (emAndamento) return emAndamento;
    emAndamento = coletar().then((valor) => { cache = { em: ctx.agora(), valor }; return valor; }).finally(() => { emAndamento = null; });
    return emAndamento;
  }

  function docs(req, res) {
    try {
      const t = fs.readFileSync(ARQUIVO_DOCS, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : t);
    } catch (e) {
      log('erro', `Diagnóstico: não consegui ler ${ARQUIVO_DOCS} (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento do diagnóstico remoto não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Atende GET/HEAD em /api/v1/diagnostico e /api/v1/diagnostico/docs.md. `quem` é só para o log. */
  async function responder(req, res, url, quem) {
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method;
    if (p !== BASE && p !== `${BASE}/docs.md`) {
      H.erroJson(res, 404, `Não existe a rota ${p}. Use GET ${BASE} ou GET ${BASE}/docs.md.`);
      return;
    }
    if (m !== 'GET' && m !== 'HEAD') {
      H.erroJson(res, 405, `Use GET em ${p}. O diagnóstico só lê, não aceita ${m}.`, null, { Allow: 'GET, HEAD' });
      return;
    }
    if (p === `${BASE}/docs.md`) { docs(req, res); return; }
    try {
      const corpo = await obter();
      H.enviaJson(res, 200, corpo);
    } catch (e) {
      const autor = quem && quem.nome ? ` (pedido de ${quem.tipo || 'alguém'} "${quem.nome}")` : '';
      log('erro', `Diagnóstico: a coleta estourou${autor}: ${e && e.stack ? e.stack : e}`);
      H.erroJson(res, 500, 'Não consegui montar o diagnóstico agora por um erro interno. Tente de novo em um minuto; se repetir, o detalhe está no log do DG Claw Web (journalctl -u dgclaw-web).');
    }
  }

  return { responder, coletar };
}

module.exports = { criarDiagnostico, BASE };
