'use strict';
// Diagnóstico remoto, só leitura: GET /api/v1/diagnostico devolve o estado de tudo o que precisa estar vivo, com o
// motivo de cada item parado e o que fazer. Contrato e formato: docs/interno/PLANO-DIAGNOSTICO-REMOTO.md.
// O porteiro (chave de API, sessão) fica no server.js; aqui só se coleta e se responde.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const H = require('../http');
const { lerEnvArquivo } = require('../config');
const { criarAtualizacao } = require('../atualizacao');
const { lerSeguro } = require('./arquivos');
const { protege } = require('./higiene');
const { sanearOcorrencias } = require('./classificar');
const { tarefasDaMaquina } = require('./maquina');
const { tarefaDeVersao } = require('./versao');
const { tarefasDoAgente } = require('./agente');
const { testarYoutube, criarEstadoYoutube } = require('./youtube');
const { analisaLogin, analisaSessao } = require('./sessao');
const U = require('./util');

const BASE = '/api/v1/diagnostico';
const ARQUIVO_DOCS = path.join(__dirname, '..', '..', 'docs', 'DIAGNOSTICO-REMOTO.md');
const CACHE_MS = 20000;
const LIMITE_PADRAO_MS = 5000;     // cada verificação
const PRAZO_COLETA_MS = 12000;     // a coleta inteira
const GRACA_MS = 3000;             // depois do prazo da coleta, quanto esperar o que ficou pendente antes de liberar
const IDADE_MAXIMA_CACHE_MS = 120000; // além disso o último resultado não é devolvido no lugar de uma coleta nova
const SCHEMA = 1;
const INTERVALO_YOUTUBE_MS = 6 * 3600 * 1000;
const GRAVIDADE = { ok: 0, nao_medido: 1, atencao: 2, quebrado: 3 };

function criarDiagnostico(deps) {
  const { config, registro, runner, log } = deps;
  // O prazo da verificação em curso viaja junto com a chamada assíncrona, para que todo exec (inclusive os das
  // verificações que não recebem o prazo como argumento) pare de criar subprocessos quando ele vence.
  const prazoAtual = new AsyncLocalStorage();
  // Toda consulta ao runner feita pelo diagnóstico herda o prazo da verificação em curso (cancelamento, prazo total
  // e teto de bytes), para um runner que nunca termina de responder não prender a coleta.
  const LIMITE_BYTES_RUNNER = 262144;
  const opcoesRunner = () => {
    const p = prazoAtual.getStore();
    return p ? { signal: p.signal, prazoMs: Math.max(1, Math.ceil(p.restanteMs())), maxBytes: LIMITE_BYTES_RUNNER } : { maxBytes: LIMITE_BYTES_RUNNER };
  };
  const runnerComPrazo = {
    pedir: (ag, m, c, corpo, t) => runner.pedir(ag, m, c, corpo, t, opcoesRunner()),
    estado: (ag) => runner.estado(ag, opcoesRunner()),
    provedor: (ag, t, fresco) => runner.provedor(ag, t, fresco, opcoesRunner()),
  };
  const ctx = {
    config, runner: runnerComPrazo, log,
    exec: U.comPrazo(deps.exec || U.execPadrao, () => prazoAtual.getStore()),
    // Para o que não cabe no prazo de uma verificação (o teste do YouTube roda em segundo plano): sem o cancelamento da coleta.
    execSolto: deps.exec || U.execPadrao,
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
  const prazoColetaMs = deps.prazoColetaMs || PRAZO_COLETA_MS;
  const gracaMs = deps.gracaMs || GRACA_MS;
  const idadeMaximaMs = deps.idadeMaximaMs || IDADE_MAXIMA_CACHE_MS;

  /**
   * Roda uma tarefa (uma vez só) com prazo próprio, dentro do prazo da coleta, e devolve o resultado já completo e
   * higienizado. Se o prazo vence, os subprocessos dela são mortos e nenhum novo começa.
   */
  function executar(t, coleta) {
    if (t.promessa) return t.promessa;
    t.promessa = (async () => {
      const dep = t.depende ? await executar(t.depende, coleta) : undefined;
      let bruto;
      if (coleta.prazo.expirou()) {
        bruto = U.R('nao_medido', `Esta verificação nem começou porque ${U.PARADO_POR_TEMPO}.`);
      } else {
        const prazo = U.criarPrazo(limiteMs, coleta.prazo);
        const andamento = prazoAtual.run(prazo, async () => {
          try { return await t.fn(dep, prazo); } catch (e) {
            log('erro', `Diagnóstico: a verificação ${t.id} falhou por erro interno: ${e && e.stack ? e.stack : e}`);
            return U.R('nao_medido', 'O diagnóstico não conseguiu medir este item por um erro interno. O detalhe está no log do DG Claw Web (journalctl -u dgclaw-web).');
          }
        });
        coleta.pendentes.push(andamento);
        const lim = await U.comLimite(andamento, Math.max(1, Math.min(limiteMs, Math.ceil(coleta.prazo.restanteMs()))));
        if (lim.estourou) {
          prazo.abortar();
          const global = coleta.prazo.expirou();
          log('aviso', `Diagnóstico: a verificação ${t.id} não respondeu a tempo (${global ? `o prazo de ${prazoColetaMs / 1000} s da coleta acabou` : `limite de ${limiteMs / 1000} s`}) e ficou como não medida.`);
          bruto = U.R('nao_medido', global ? `O diagnóstico parou por tempo (a coleta tem ${prazoColetaMs / 1000} s no total).` : `Não respondeu em ${limiteMs / 1000} s.`);
        } else bruto = lim.valor;
        andamento.then(() => prazo.encerrar(), () => prazo.encerrar());
      }
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
        o_que_fazer: U.ONDE_COLAR, prompt_sugerido: U.promptAdmin('o registro de agentes (agentes.json) do DG Claw não pôde ser lido.', '`dgclaw agente listar`', 'dgclaw status'),
      }) }, 'maquina', null, 'maquina.registro');
    }
    add(tarefaDeVersao(ctx), 'versao', null, 'versao');

    const admin = reg.ok ? reg.agentes.find((a) => a.tipo === 'admin') : null;
    if (admin) {
      add({ nome: 'Sessão do Admin', async fn() {
        const [saude, estado, provedor] = await Promise.all([ctx.runner.pedir(admin, 'GET', '/api/saude', null, 4000), ctx.runner.estado(admin), ctx.runner.provedor(admin, 4000)]);
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

  async function coletarUmaVez(coleta) {
    const inicio = process.hrtime.bigint();
    const tarefas = montaTarefas();
    const resultados = await Promise.all(tarefas.map((t) => executar(t, coleta)));
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

  // Uma coleta por vez. `emAndamento` é a coleta que ainda não respondeu; `encerrando` é a que já respondeu (talvez
  // por tempo) mas ainda tem verificação terminando. Enquanto qualquer uma das duas existir, ninguém começa outra:
  // pedidos novos recebem a promessa em andamento ou o último resultado.
  let cache = null;
  let emAndamento = null;
  let encerrando = null;

  async function coletar() {
    if (emAndamento) return emAndamento;
    if (encerrando && cache && ctx.agora() - cache.em < idadeMaximaMs) return cache.valor;
    if (encerrando) await encerrando;
    if (emAndamento) return emAndamento;
    const coleta = { prazo: U.criarPrazo(prazoColetaMs), pendentes: [] };
    const minha = coletarUmaVez(coleta).then((valor) => { cache = { em: ctx.agora(), valor }; return valor; });
    emAndamento = minha;
    const solta = () => {
      if (emAndamento === minha) emAndamento = null;
      // O que ainda estiver pendente depois do prazo mais a graça é abandonado: o cancelamento já foi mandado
      // (e derruba a conexão), então `encerrando` nunca fica preso a uma consulta que não termina.
      let timerGraca;
      const fim = Promise.race([
        Promise.allSettled(coleta.pendentes),
        new Promise((resolve) => { timerGraca = setTimeout(resolve, Math.ceil(coleta.prazo.restanteMs()) + gracaMs); timerGraca.unref(); }),
      ]).then(() => {
        clearTimeout(timerGraca);
        coleta.prazo.abortar();
        coleta.prazo.encerrar();
        if (encerrando === fim) encerrando = null;
      });
      encerrando = fim;
    };
    minha.then(solta, solta);
    return minha;
  }

  function obter() {
    if (cache && ctx.agora() - cache.em < CACHE_MS) return Promise.resolve(cache.valor);
    return coletar();
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

  /** Espera os testes em segundo plano (o do YouTube) que ainda estiverem rodando. Usado pelos testes. */
  const aguardarSegundoPlano = () => Promise.all(ctx.youtube ? [...ctx.youtube.andando.values()] : []);

  /**
   * Vigia periódico do YouTube: testa o download de cada agente e avisa no aparelho do dono quando a conta cai
   * (a transição para "login"). `push` é o mesmo do vigia de atenção: push.enviar({ titulo, corpo, tag, url }).
   */
  function vigiarYoutube({ push, intervaloMs } = {}) {
    let timer = null;
    let emCurso = false;

    /** Devolve true só quando o push chegou a pelo menos um aparelho e sem nenhuma falha. */
    async function avisar(ag) {
      try {
        const r = await push.enviar({
          titulo: `${ag.nome} saiu do YouTube`,
          corpo: 'A conta do YouTube na Tela dele caiu, e ele não consegue baixar vídeos. Abra a Tela e entre de novo em youtube.com.',
          tag: `youtube-${ag.slug}`,
          url: `/a/${ag.slug}`,
        });
        if (r && !r.inscricoes) { log('info', `Aviso do YouTube de ${ag.nome}: nenhum aparelho com avisos ativados. Ative em "Ativar avisos neste aparelho", no menu. O aviso continua pendente.`); return false; }
        if (r && r.falhas && r.falhas.length) { log('aviso', `Aviso do YouTube de ${ag.nome}: ${r.falhas.length} falha(s) ao entregar: ${r.falhas[0].motivo || 'sem motivo'}. O aviso continua pendente e será tentado de novo na próxima rodada.`); return false; }
        return !!(r && r.inscricoes > 0);
      } catch (e) {
        log('erro', `Aviso do YouTube de ${ag.nome} não saiu (${e.message}). Ele continua pendente. Confira a tela de avisos do aparelho e o arquivo push/vapid.json na pasta de dados.`);
        return false;
      }
    }

    // Avisa todo agente com queda pendente e só limpa a marca quando o push chegou a algum aparelho, sem falha.
    // Se o teste mais recente já não diz "login", a marca fica como está (volta a 'ok' ela é limpa no teste).
    async function avisarPendentes(agentes) {
      for (const ag of agentes) {
        const v = ctx.youtube.ler(ag.slug);
        if (!v || v.avisoPendente !== true || v.tipo !== 'login') continue;
        if (await avisar(ag)) ctx.youtube.limparAviso(ag.slug);
      }
    }

    async function rodada() {
      if (emCurso) return;
      emCurso = true;
      try {
        const reg = registro.estado();
        if (!reg.ok) return;
        if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
        const agentes = reg.agentes.filter((ag) => ag.tipo !== 'admin' && ag.container && U.RX_NOME_SEGURO.test(ag.slug));
        for (const ag of agentes) {
          try { await testarYoutube(ctx, ag); } catch (e) {
            log('erro', `Vigia do YouTube: falha inesperada ao testar ${ag.nome} (${e.message}). Os outros agentes seguem sendo testados.`);
          }
        }
        await avisarPendentes(agentes);
      } finally { emCurso = false; }
    }

    function iniciar() {
      if (timer) return;
      timer = setInterval(() => { rodada().catch((e) => log('erro', `Vigia do YouTube: ${e.message}`)); }, intervaloMs || INTERVALO_YOUTUBE_MS);
      timer.unref();
    }
    function parar() { if (timer) { clearInterval(timer); timer = null; } }
    return { iniciar, parar, rodada };
  }

  return { responder, coletar, aguardarSegundoPlano, vigiarYoutube };
}

module.exports = { criarDiagnostico, BASE };
