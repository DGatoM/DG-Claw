'use strict';
/**
 * sessoes-local.js: a aba Sessões em "modo local" (mini-Bunker do DG Claw, 17/10/2026).
 *
 * Aqui um card é uma SESSÃO PARALELA DO RUNNER do próprio agente. O painel não guarda
 * estado de sessão: pergunta ao runner (`/api/agents?todas=1`, `/input`, `/permissao`,
 * `/resume`, `/revive`, `/suspend`, `/conversation`, `POST/DELETE /api/sessoes`) e só
 * guarda o que o runner não conhece (nome escolhido na tela, estrela, arquivado, quem
 * criou, pasta) em <agentDir>/.dgclaw/panel/sessoes-local.json.
 *
 * Fala o mesmo contrato de /api/sessoes* do modo proxy (lib/sessoes-proxy.js), para a
 * tela e para o agente nem perceberem a diferença. Ver docs/SESSOES.md.
 *
 * Duas decisões de segurança que valem aqui:
 *   - decidir pedido de permissão só com login humano: chave de API recebe 403, porque
 *     um agente não pode aprovar o próprio pedido;
 *   - documentos só saem da casa do agente, e só os que a conversa citou.
 *
 * O corpo da requisição é lido aqui (o server.js tira /api/sessoes dos parsers globais).
 * Token do runner: lib/runner-token.js (cache por mtime, nunca vai para log).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { cabecalhoDoRunner, caminhoDoToken } = require('./runner-token');
const { veioDaTela, partesDoCaminho } = require('./sessoes-proxy');

const PREFIXO = '/api/sessoes';
const TIMEOUT_GET_MS = 8000;
const TIMEOUT_ESCRITA_MS = 30000;
const TETO_RESPOSTA_RUNNER = 16 * 1024 * 1024;
const TETO_JSON_BYTES = 1024 * 1024;
const ANEXO_MAX_BYTES = 50 * 1024 * 1024;
const DOC_TEXTO_MAX = 2 * 1024 * 1024;
const DOC_BINARIO_MAX = 25 * 1024 * 1024;
const FECHADOS_MAX = 60;
const FALA_MAX = 280;
const CONVERSA_TEXTO_MAX = 6000;
const CONVERSA_BUSCA_MAX = 500;
const NOME_MAX = 120;
const PROMPT_MAX = 20000;
const RECADO_MAX = 8000;
const CACHE_FALA_MAX = 200;

const GRUPOS = ['esperando_voce', 'trabalhando', 'concluido', 'parado', 'erro', 'fechado'];
const GRUPOS_FILTRO = ['ativos', 'todos', 'arquivado', ...GRUPOS];
const ORDEM_GRUPO = { esperando_voce: 0, trabalhando: 1, erro: 2, parado: 3, concluido: 4, fechado: 5 };

const RECURSOS = {
  criar: true, pedidos: true, decidir: true, handoff: true, parar: true, retomar: true, anexo: true,
  renomear: true, favorito: true, documentos: true, apagar: true,
  link_externo: false, cofre: false, teclado: false,
};
const FONTE = { id: 'local', nome: 'agente', recursos: RECURSOS };

const PEDIDO_DE_HANDOFF = 'Escreva agora o handoff desta sessão, numa única mensagem, neste formato. '
  + 'Primeira linha: começa com "▶️ ATIVA [VPS] -" e traz o tema e o próximo passo. '
  + 'No meio: um bloco de código com o prompt de continuação, autossuficiente (o que é o projeto, arquivos, '
  + 'estado atual, próximo passo e armadilhas). '
  + 'Última linha: começa com "✅ ENCERRADA [VPS] -" e traz o tema e o ponto onde você parou. '
  + 'Não faça mais nada além de escrever essa mensagem.';

/** Erro que já sabe como virar resposta HTTP. */
class ErroLocal extends Error {
  constructor(status, erro, extra) {
    super(erro);
    this.status = status;
    this.corpo = Object.assign({ ok: false, erro }, extra || {});
  }
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const espacos = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const isoDeMs = (ms) => (typeof ms === 'number' && isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// Mesmo prefixo de status que a tela do DG Telegram tira do nome ("▶️ ATIVA [VPS] - ").
const RE_PREFIXO = /^\s*[▶✅⏳]️?\s*(?:\[[^\]]*\]\s*)?(?:ATIVA|ENCERRADA|VOCÊ)?\s*(?:\[[^\]]*\]\s*)?[—–-]\s*/u;
function nomeLimpo(nome) {
  if (typeof nome !== 'string') return nome;
  const limpo = nome.replace(RE_PREFIXO, '').trim();
  return limpo || nome;
}

function registrar(router, { CONFIG }) {
  const cfgArquivo = (CONFIG && CONFIG.sessoes) || {};
  const casaBruta = CONFIG.agentDir || process.cwd();
  const arquivoRegistro = path.join(casaBruta, '.dgclaw', 'panel', 'sessoes-local.json');
  const cacheFala = new Map(); // `${id}|${sessionId}|${updatedAt}` -> fala | null
  const falhasJaVistas = new Set();

  function ehSoLeitura() {
    const env = (process.env.DGCLAW_PANEL_SESSOES_SO_LEITURA || '').trim().toLowerCase();
    if (env) return ['1', 'true', 'sim', 'yes'].includes(env);
    return cfgArquivo.soLeitura === true;
  }

  const agenteSlug = () => (process.env.DGCLAW_PANEL_SESSOES_AGENTE || cfgArquivo.agente || CONFIG.agentSlug || '').trim();

  function casa() {
    try { return fs.realpathSync(casaBruta); } catch (e) {
      throw new ErroLocal(500, `Não consegui abrir a pasta do agente (${casaBruta}): ${e.code || e.message}.`, {
        como_resolver: 'Confira agentDir no config.json do painel.', code: 'SEM_CASA',
      });
    }
  }

  function log(msg) { console.log(`sessoes-local: ${msg}`); }

  // ─── Cliente do runner ──────────────────────────────────────

  function baseDoRunner() {
    const bruta = (CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL || 'http://127.0.0.1:4300').trim();
    try {
      const u = new URL(bruta);
      if (u.protocol !== 'http:') throw new Error('só http');
      return u;
    } catch {
      throw new ErroLocal(503, `O endereço do runner (${bruta}) não é um endereço http válido.`, {
        como_resolver: 'Corrija bunkerUrl no config.json do painel (ou DGCLAW_BUNKER_URL) e reinicie o agente pelo Admin.', code: 'RUNNER_FORA',
      });
    }
  }

  function chamarRunner(metodo, caminho, corpo, ms) {
    const base = baseDoRunner();
    const cab = cabecalhoDoRunner(CONFIG);
    if (!cab.Authorization) {
      const arq = caminhoDoToken(CONFIG);
      throw new ErroLocal(503, arq
        ? `Não consegui ler o token do runner em ${arq} (arquivo ausente, vazio ou sem permissão).`
        : 'O painel não sabe onde está o token do runner (falta runnerTokenFile no config.json ou RUNNER_TOKEN_FILE).', {
        como_resolver: 'Reinicie o agente pelo Admin. Se continuar, o instalador precisa ser rodado de novo.', code: 'SEM_TOKEN_RUNNER',
      });
    }
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo), 'utf-8');
    const headers = { ...cab, Accept: 'application/json', 'User-Agent': 'dgclaw-painel' };
    if (dados) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = dados.length; }
    const timeout = ms || (metodo === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_ESCRITA_MS);
    return new Promise((resolve, reject) => {
      const falhou = (e) => {
        const causa = e.code || e.message || 'erro desconhecido';
        console.error(`sessoes-local: ${metodo} ${caminho.split('?')[0]} falhou: ${causa} ao falar com o runner em ${base.host}`);
        reject(new ErroLocal(503, `O runner deste agente não respondeu (${causa}) em ${base.host}`
          + `${causa === 'ETIMEDOUT' ? `, depois de ${Math.round(timeout / 1000)} segundos` : ''}.`, {
          como_resolver: 'Reinicie o agente pelo Admin. '
            + (metodo === 'GET' ? '' : 'Se foi um envio, olhe a conversa do card antes de repetir: ele pode ter chegado.'),
          code: 'RUNNER_FORA',
        }));
      };
      const req = http.request({ hostname: base.hostname, port: base.port || 80, method: metodo, path: caminho, headers }, (resp) => {
        const pedacos = [];
        let total = 0;
        resp.on('data', (b) => {
          total += b.length;
          if (total > TETO_RESPOSTA_RUNNER) { resp.destroy(Object.assign(new Error('resposta grande demais'), { code: 'EMSGSIZE' })); return; }
          pedacos.push(b);
        });
        resp.on('error', falhou);
        resp.on('end', () => {
          const texto = Buffer.concat(pedacos).toString('utf-8');
          let json = null;
          try { json = JSON.parse(texto); } catch { /* o status explica */ }
          resolve({ status: resp.statusCode || 502, json: json && typeof json === 'object' ? json : null, texto });
        });
      });
      req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', falhou);
      req.end(dados);
    });
  }

  /** Resposta de erro do runner -> ErroLocal com a frase dele e o que fazer. */
  function erroDoRunner(r, acao) {
    const j = r.json || {};
    const code = j.code || 'RUNNER_ERRO';
    if (r.status === 401 || r.status === 403) {
      return new ErroLocal(503, `O runner deste agente recusou o token do painel (HTTP ${r.status}) ao ${acao}.`, {
        como_resolver: 'Reinicie o agente pelo Admin. Se continuar, o instalador precisa ser rodado de novo.', code: 'RUNNER_RECUSOU_TOKEN',
      });
    }
    const status = r.status >= 500 && r.status !== 503 ? 502 : r.status;
    const erro = j.error || j.erro || `O runner respondeu HTTP ${r.status} ao ${acao}, sem explicar.`;
    const extra = { code };
    if (j.howToFix) extra.como_resolver = j.howToFix;
    if (code === 'NO_PTY') extra.como_resolver = 'Mande de novo com "retomar": true (ou use Retomar) para reabrir o terminal.';
    if (code === 'LIMITE_DE_SESSOES') {
      extra.como_resolver = 'Arquive e apague um card que não precisa mais (aba Sessões, filtro Arquivadas, botão Apagar) para liberar uma vaga.';
    }
    return new ErroLocal(status, erro, extra);
  }

  async function runner(metodo, caminho, corpo, acao, ms) {
    const r = await chamarRunner(metodo, caminho, corpo, ms);
    if (r.status >= 400) throw erroDoRunner(r, acao);
    return r;
  }

  // ─── Registro de metadados ──────────────────────────────────

  function lerRegistro() {
    let cru;
    try {
      cru = fs.readFileSync(arquivoRegistro, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return { dados: {}, aviso: null };
      return { dados: {}, aviso: `Não consegui ler ${arquivoRegistro} (${e.code || e.message}): nomes e estrelas escolhidos na tela não aparecem agora.` };
    }
    try {
      const d = JSON.parse(cru);
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('não é um objeto');
      return { dados: d, aviso: null };
    } catch (e) {
      console.error(`sessoes-local: ${arquivoRegistro} está quebrado (${e.message}); sigo sem ele e não escrevo por cima`);
      return { dados: {}, aviso: `O registro ${arquivoRegistro} está ilegível (${e.message}). Conserte ou apague o arquivo para voltar a guardar nomes e estrelas.` };
    }
  }

  function gravarRegistro(dados) {
    const lido = lerRegistro();
    if (lido.aviso) {
      throw new ErroLocal(500, lido.aviso, { como_resolver: 'Depois disso repita a ação.', code: 'REGISTRO_ILEGIVEL' });
    }
    const pasta = path.dirname(arquivoRegistro);
    const tmp = `${arquivoRegistro}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, arquivoRegistro);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nunca chegou a existir */ }
      throw new ErroLocal(500, `Não consegui gravar ${arquivoRegistro} (${e.code || e.message}).`, {
        como_resolver: 'Confira a permissão de escrita nessa pasta.', code: 'REGISTRO_NAO_GRAVOU',
      });
    }
  }

  /** Lê, deixa `fn` mexer no registro e grava. Síncrono de ponta a ponta: sem corrida entre duas ações. */
  function mexerNoRegistro(fn) {
    const { dados } = lerRegistro();
    fn(dados);
    gravarRegistro(dados);
  }

  // ─── Itens ──────────────────────────────────────────────────

  function papelDe(ag) {
    const s = ag.sessao || {};
    if (s.papel !== 'paralela') return 'principal';
    return s.tipo === 'bastidores' ? 'bastidores' : 'card';
  }

  /** {grupo, estado, motivo, tem_terminal} a partir do status do runner. */
  function estadoDe(ag) {
    const st = ag.status;
    const ferramenta = ag.currentTool ? ` (${ag.currentTool})` : '';
    switch (st) {
      case 'waiting_input':
        return { grupo: 'esperando_voce', estado: ag.pendingPermission ? 'pedindo_permissao' : 'esperando_resposta', motivo: 'esperando sua decisão', tem_terminal: true };
      case 'working':
      case 'spawning':
        return { grupo: 'trabalhando', estado: 'trabalhando', motivo: `trabalhando agora${ferramenta}`, tem_terminal: true };
      case 'idle':
      case 'completed':
        return { grupo: 'concluido', estado: 'ocioso', motivo: 'terminou e espera o próximo pedido', tem_terminal: true };
      case 'errored':
        // A lista do runner não diz se o terminal ainda vive; tratar como sem terminal deixa o Retomar disponível.
        return { grupo: 'erro', estado: 'erro', motivo: ag.error ? `erro: ${espacos(ag.error).slice(0, 200)}` : 'o runner marcou erro nesta sessão', tem_terminal: false };
      case 'stopped':
        return { grupo: 'parado', estado: 'parado', motivo: 'terminal parado', tem_terminal: false };
      case 'resumable':
        return { grupo: 'fechado', estado: 'fechado', motivo: 'dormindo: acorda com um recado', tem_terminal: false };
      default:
        return { grupo: 'erro', estado: 'desconhecido', motivo: `o runner mandou um estado que não conheço (${st})`, tem_terminal: false };
    }
  }

  function montarItem(ag, reg, fala) {
    const e = estadoDe(ag);
    const cfg = ag.config || {};
    const papel = papelDe(ag);
    const nome = reg.nome || (ag.sessao && ag.sessao.titulo) || cfg.name || ag.id;
    const cwd = reg.pasta || cfg.cwd || null;
    const pedido = ag.pendingPermission
      ? espacos(ag.pendingPermission.description || `Permissão para usar ${ag.pendingPermission.toolName || 'uma ferramenta'}`).slice(0, 500)
      : null;
    return {
      id: ag.id, nome, nome_limpo: nomeLimpo(nome), papel,
      grupo: e.grupo, estado: e.estado, motivo: e.motivo, status_bunker: ag.status,
      cwd, pasta: cwd ? path.basename(cwd.replace(/\/+$/, '')) || null : null,
      dono: agenteSlug() || null, favorito: !!reg.favorito,
      desde: isoDeMs(ag.lastActivatedAt || ag.updatedAt || ag.createdAt),
      criado_em: reg.criado_em || isoDeMs(ag.createdAt), criado_por: reg.criado_por || null,
      tem_terminal: e.tem_terminal, subagente: false,
      arquivado: !!reg.arquivado, arquivado_em: reg.arquivado ? reg.arquivado.quando : null,
      ultima_fala: fala, pedido, pedido_ponte: null, alerta: null,
      handoff: { fase: ag.handoffPhase || null }, link_externo: null,
    };
  }

  async function listarCrus() {
    const r = await runner('GET', '/api/agents?todas=1', undefined, 'listar as sessões');
    const lista = r.json && r.json.data;
    if (!Array.isArray(lista)) {
      throw new ErroLocal(502, 'O runner respondeu a lista de sessões num formato inesperado (faltou "data" como lista).', {
        como_resolver: 'Reinicie o agente pelo Admin; se continuar, o runner e o painel estão em versões diferentes.', code: 'RUNNER_FORMATO',
      });
    }
    return lista.filter((x) => x && typeof x.id === 'string');
  }

  function avisarUmaVez(chave, msg) {
    if (falhasJaVistas.has(chave)) return;
    falhasJaVistas.add(chave);
    console.error(msg);
  }

  /** Última fala do assistente. Cache por estado: o runner só é perguntado de novo se a sessão mexeu. */
  async function falaDe(ag) {
    const tela = espacos(ag.lastMessage).slice(0, FALA_MAX);
    const reserva = tela ? { texto: tela, quando: isoDeMs(ag.updatedAt), fonte: 'tela' } : null;
    if (!ag.sessionId) return reserva;
    const chave = `${ag.id}|${ag.sessionId}|${ag.updatedAt}`;
    if (cacheFala.has(chave)) return cacheFala.get(chave) || reserva;
    let fala = null;
    try {
      const r = await runner('GET', `/api/agents/${encodeURIComponent(ag.id)}/conversation?limit=6`, undefined, 'ler a última fala');
      const msgs = Array.isArray(r.json && r.json.data) ? r.json.data : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'assistant' && typeof msgs[i].text === 'string' && msgs[i].text.trim()) {
          fala = { texto: espacos(msgs[i].text).slice(0, FALA_MAX), quando: isoDeMs(ag.updatedAt), fonte: 'transcript' };
          break;
        }
      }
    } catch (e) {
      avisarUmaVez(`${ag.id}|${e.message}`, `sessoes-local: não consegui a última fala de ${ag.id} (${e.message}); mostro o texto da tela`);
      return reserva;
    }
    if (cacheFala.size >= CACHE_FALA_MAX) cacheFala.delete(cacheFala.keys().next().value);
    cacheFala.set(chave, fala);
    return fala || reserva;
  }

  async function itens() {
    const crus = await listarCrus();
    const { dados: reg, aviso } = lerRegistro();
    const montados = await Promise.all(crus.map(async (ag) => montarItem(ag, reg[ag.id] || {}, await falaDe(ag))));
    return { itens: montados, avisoRegistro: aviso };
  }

  async function itemPorId(id) {
    const { itens: todos } = await itens();
    const it = todos.find((x) => x.id === id);
    if (!it) {
      throw new ErroLocal(404, `Não achei a sessão ${id} neste agente.`, { como_resolver: 'Recarregue a lista: ela pode ter sido apagada.', code: 'SESSAO_INEXISTENTE' });
    }
    return it;
  }

  function limparRegistrosOrfaos(crus) {
    const vivos = new Set(crus.map((x) => x.id));
    const { dados } = lerRegistro();
    if (Object.keys(dados).every((k) => vivos.has(k))) return;
    for (const k of Object.keys(dados)) if (!vivos.has(k)) delete dados[k];
    gravarRegistro(dados);
  }

  // ─── Lista ──────────────────────────────────────────────────

  function montarLista(todos, filtro) {
    const cont = Object.fromEntries(GRUPOS.map((g) => [g, 0]));
    cont.arquivado = 0;
    for (const it of todos) cont[it.arquivado ? 'arquivado' : it.grupo] += 1;
    const q = semAcento(filtro.q);
    const entra = (it) => {
      if (filtro.grupo === 'arquivado') return it.arquivado;
      if (it.arquivado) return false;
      if (filtro.grupo === 'ativos') return it.grupo !== 'fechado';
      return filtro.grupo === 'todos' || filtro.grupo === it.grupo;
    };
    let sel = todos.filter(entra);
    if (q) sel = sel.filter((it) => semAcento(`${it.nome} ${it.cwd} ${it.id} ${it.pasta}`).includes(q));
    sel.sort((a, b) => String(b.desde || '').localeCompare(String(a.desde || '')));
    const fechados = sel.filter((it) => it.grupo === 'fechado').slice(0, FECHADOS_MAX);
    sel = sel.filter((it) => it.grupo !== 'fechado').concat(fechados);
    sel.sort((a, b) => ORDEM_GRUPO[a.grupo] - ORDEM_GRUPO[b.grupo]);
    // quem espera há mais tempo vem primeiro; depois os favoritos sobem dentro do grupo
    const esperando = sel.filter((it) => it.grupo === 'esperando_voce').reverse();
    sel = esperando.concat(sel.filter((it) => it.grupo !== 'esperando_voce'));
    sel.sort((a, b) => (ORDEM_GRUPO[a.grupo] - ORDEM_GRUPO[b.grupo]) || (Number(!!b.favorito) - Number(!!a.favorito)));
    return { contagem: cont, itens: sel.slice(0, filtro.limite), total: sel.length };
  }

  // ─── Corpo, origem e quem pede ──────────────────────────────

  function lerCorpoBruto(req, teto) {
    return new Promise((resolve, reject) => {
      const pedacos = [];
      let total = 0;
      req.on('data', (b) => {
        total += b.length;
        if (total > teto) { req.destroy(); reject(new ErroLocal(413, `O corpo do pedido passou de ${Math.round(teto / 1024 / 1024)} MB.`, { como_resolver: 'Mande um menor.' })); return; }
        pedacos.push(b);
      });
      req.on('end', () => resolve(Buffer.concat(pedacos)));
      req.on('error', (e) => reject(new ErroLocal(400, `O pedido foi interrompido antes de terminar (${e.code || e.message}).`)));
    });
  }

  async function lerJson(req) {
    const bruto = await lerCorpoBruto(req, TETO_JSON_BYTES);
    if (!bruto.length) return {};
    let d;
    try { d = JSON.parse(bruto.toString('utf-8')); } catch {
      throw new ErroLocal(400, 'O corpo do pedido não é um JSON válido.', { como_resolver: 'Mande um objeto JSON com Content-Type: application/json.' });
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ErroLocal(400, 'O corpo do pedido precisa ser um objeto JSON.');
    return d;
  }

  const ehChave = (req) => !!req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api';
  const ehProxy = (req) => !!req.dgclawAuth && req.dgclawAuth.tipo === 'proxy';
  const quemPediu = (req) => (ehChave(req) ? `chave:${req.dgclawAuth.nome}` : 'tela');

  // ─── Rotas ──────────────────────────────────────────────────

  function enviarJson(res, status, corpo) {
    res.status(status);
    res.setHeader('Cache-Control', 'no-store');
    res.json(corpo);
  }

  function checarId(id) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id || '')) {
      throw new ErroLocal(404, `"${String(id).slice(0, 40)}" não é um código de sessão.`, { como_resolver: 'Veja os códigos em GET /api/sessoes.', code: 'SESSAO_INEXISTENTE' });
    }
  }

  async function rotaLista(req, res, query) {
    const grupo = query.get('grupo') || 'ativos';
    if (!GRUPOS_FILTRO.includes(grupo)) {
      throw new ErroLocal(400, `O grupo "${grupo}" não existe.`, { como_resolver: `Use um destes: ${GRUPOS_FILTRO.join(', ')}.` });
    }
    const brutoLimite = query.get('limite');
    const limite = brutoLimite === null ? 100 : Number(brutoLimite);
    if (!Number.isInteger(limite) || limite < 1 || limite > 300) {
      throw new ErroLocal(400, 'O limite precisa ser um número inteiro de 1 a 300.');
    }
    const { itens: todos, avisoRegistro } = await itens();
    const lista = montarLista(todos, { grupo, q: query.get('q') || '', limite });
    const corpo = {
      ok: true, gerado_em: new Date().toISOString(), contagem: lista.contagem, itens: lista.itens,
      total_filtrado: lista.total, agente: agenteSlug(), ve_tudo: true, fonte: FONTE,
    };
    if (avisoRegistro) corpo.aviso_registro = avisoRegistro;
    enviarJson(res, 200, corpo);
  }

  /** Página de mensagens: `antes` conta quantas mensagens do fim já foram entregues. */
  async function rotaConversa(req, res, id, query) {
    const it = await itemPorId(id);
    const lim = Number(query.get('limite') || 30);
    const antesTxt = query.get('before');
    const antes = antesTxt === null || antesTxt === '' ? 0 : Number(antesTxt);
    if (!Number.isInteger(lim) || lim < 1 || !Number.isInteger(antes) || antes < 0) {
      throw new ErroLocal(400, 'limite e before precisam ser números inteiros (limite de 1 a 100, before a partir de 0).');
    }
    const limite = Math.min(100, lim);
    const pedir = Math.min(CONVERSA_BUSCA_MAX, antes + limite);
    const r = await runner('GET', `/api/agents/${encodeURIComponent(it.id)}/conversation?limit=${pedir}`, undefined, 'ler a conversa');
    const msgs = Array.isArray(r.json && r.json.data) ? r.json.data : null;
    if (!msgs) {
      throw new ErroLocal(502, `O runner devolveu a conversa da sessão ${id} num formato inesperado (faltou "data" como lista).`, { code: 'RUNNER_FORMATO' });
    }
    const janela = msgs.slice(0, Math.max(0, msgs.length - antes)).slice(-limite);
    const mensagens = janela.filter((m) => m && typeof m === 'object').map((m) => {
      const texto = typeof m.text === 'string' ? m.text : '';
      const o = { role: m.role, texto: texto.slice(0, CONVERSA_TEXTO_MAX) };
      if (texto.length > CONVERSA_TEXTO_MAX) o.cortado = true;
      return o;
    });
    const entregues = antes + mensagens.length;
    enviarJson(res, 200, {
      ok: true, mensagens, antes: entregues,
      truncado: msgs.length >= pedir && pedir < CONVERSA_BUSCA_MAX,
    });
  }

  function resolverPasta(pasta) {
    if (pasta === undefined || pasta === null || pasta === '') return null;
    if (typeof pasta !== 'string' || pasta.length > 500 || pasta.includes('\0')) {
      throw new ErroLocal(400, 'O campo "pasta" precisa ser um caminho de texto (até 500 caracteres).');
    }
    const raiz = casa();
    let real;
    try { real = fs.realpathSync(path.resolve(raiz, pasta)); } catch {
      throw new ErroLocal(400, `A pasta "${pasta}" não existe.`, { como_resolver: `Escolha uma pasta que exista dentro de ${raiz}, ou deixe o campo vazio.` });
    }
    if (real !== raiz && !real.startsWith(raiz + path.sep)) {
      throw new ErroLocal(400, `A pasta "${pasta}" fica fora da casa do agente (${raiz}).`, { como_resolver: 'Escolha uma pasta dentro da casa do agente, ou deixe o campo vazio.' });
    }
    if (!fs.statSync(real).isDirectory()) throw new ErroLocal(400, `"${pasta}" é um arquivo, e não uma pasta.`);
    return real;
  }

  function textoDoNome(nome) {
    if (typeof nome !== 'string' || !nome.trim() || nome.trim().length > NOME_MAX) {
      throw new ErroLocal(400, `O campo "nome" é obrigatório (1 a ${NOME_MAX} caracteres).`);
    }
    return nome.trim();
  }

  const NOME_DO_PROVEDOR = { claude: 'Claude', codex: 'Codex' };

  /** O provedor da conversa principal e os que um card novo pode usar. O runner informa `disponiveis`; um runner
   *  antigo que não informa só deixa o da principal (não adivinho um motor que talvez nem esteja instalado). */
  async function lerProvedores() {
    const prov = (await runner('GET', '/api/provedor', undefined, 'ler o provedor da sessão principal')).json || {};
    if (typeof prov.provedor !== 'string' || !prov.provedor) {
      throw new ErroLocal(502, 'O runner não disse qual é o provedor da sessão principal (faltou "provedor" em GET /api/provedor).', { code: 'RUNNER_FORMATO' });
    }
    const lista = Array.isArray(prov.disponiveis) ? prov.disponiveis.filter((x) => typeof x === 'string' && x) : [];
    const disponiveis = lista.includes(prov.provedor) ? lista : [prov.provedor, ...lista];
    return { prov, disponiveis };
  }

  async function rotaProvedores(req, res) {
    const { prov, disponiveis } = await lerProvedores();
    enviarJson(res, 200, {
      ok: true, principal: prov.provedor,
      disponiveis: disponiveis.map((id) => ({ id, nome: NOME_DO_PROVEDOR[id] || id })),
    });
  }

  async function criarCard({ nome, prompt, pasta, por, provedor }) {
    const absoluta = resolverPasta(pasta);
    const { prov, disponiveis } = await lerProvedores();
    let escolhido = prov.provedor;
    if (provedor !== undefined && provedor !== null && provedor !== '') {
      if (typeof provedor !== 'string' || !disponiveis.includes(provedor)) {
        throw new ErroLocal(400, `O provedor ${JSON.stringify(provedor)} não está disponível neste agente.`, {
          como_resolver: `Use um destes: ${disponiveis.join(', ')}. Sem o campo "provedor", o card usa o da conversa principal (${prov.provedor}).`, code: 'PROVEDOR_INVALIDO',
        });
      }
      escolhido = provedor;
    }
    const corpo = { tipo: 'card', provedor: escolhido, titulo: nome };
    // Forma de pagar e modelo são do provedor da principal: noutro provedor o runner usa o padrão (assinatura, modelo padrão).
    if (escolhido === prov.provedor) {
      if (prov.auth) corpo.auth = prov.auth;
      if (prov.modelo) corpo.modelo = prov.modelo;
    }
    const criada = await runner('POST', '/api/sessoes', corpo, 'criar a sessão');
    const ag = criada.json && criada.json.data;
    if (!ag || typeof ag.id !== 'string') {
      throw new ErroLocal(502, 'O runner criou a sessão mas não devolveu o código dela (faltou data.id).', { como_resolver: 'Confira a lista de sessões antes de tentar de novo.', code: 'RUNNER_FORMATO' });
    }
    mexerNoRegistro((d) => {
      d[ag.id] = { nome, favorito: false, arquivado: null, criado_em: new Date().toISOString(), criado_por: por, pasta: absoluta };
    });
    const texto = (absoluta ? `Pasta de trabalho: ${absoluta}. Comece trabalhando por lá.\n\n` : '') + prompt;
    try {
      await runner('POST', `/api/agents/${encodeURIComponent(ag.id)}/input`, { text: texto, submit: true }, 'entregar o pedido à sessão nova');
    } catch (e) {
      if (['SEM_LOGIN', 'SEM_CHAVE', 'SEM_CAPACIDADE'].includes(e.corpo && e.corpo.code)) {
        // Card sem pedido e sem como trabalhar só ocuparia uma vaga.
        try {
          await runner('DELETE', `/api/sessoes/${encodeURIComponent(ag.id)}`, undefined, 'fechar a sessão que não recebeu o pedido');
          mexerNoRegistro((d) => { delete d[ag.id]; });
        } catch (e2) {
          console.error(`sessoes-local: não consegui fechar a sessão ${ag.id} depois que o pedido falhou: ${e2.message}`);
        }
      } else {
        e.corpo.erro = `A sessão ${ag.id} foi criada, mas o pedido não foi entregue: ${e.corpo.erro}`;
        e.corpo.como_resolver = `${e.corpo.como_resolver ? `${e.corpo.como_resolver} ` : ''}Mande o pedido de novo como recado nessa sessão.`;
      }
      throw e;
    }
    return itemPorId(ag.id);
  }

  async function rotaCriar(req, res) {
    const d = await lerJson(req);
    const nome = textoDoNome(d.nome);
    if (typeof d.prompt !== 'string' || !d.prompt.trim() || d.prompt.trim().length > PROMPT_MAX) {
      throw new ErroLocal(400, `O campo "prompt" é obrigatório (1 a ${PROMPT_MAX} caracteres).`);
    }
    const it = await criarCard({ nome, prompt: d.prompt.trim(), pasta: d.pasta, por: quemPediu(req), provedor: d.provedor });
    log(`criar ${it.id} por ${quemPediu(req)}`);
    enviarJson(res, 201, { ok: true, item: it });
  }

  /** O que vale para qualquer entrega de texto a uma sessão. Devolve {enviado, enfileirado, quando, retomado}. */
  async function entregarTexto(it, texto, quando, retomar) {
    if (it.grupo === 'esperando_voce') {
      throw new ErroLocal(409, 'A sessão está esperando você decidir um pedido. Um recado agora cairia dentro do menu de permissão.', {
        como_resolver: 'Aprove ou negue o pedido primeiro (POST /decidir ou os botões Aprovar e Negar) e mande o recado depois.', code: 'ESPERANDO_DECISAO',
      });
    }
    let retomado = false;
    if (!it.tem_terminal) {
      if (!retomar) {
        throw new ErroLocal(409, 'A sessão está fechada (sem terminal), então o recado não tem para onde ir.', {
          como_resolver: 'Mande de novo com "retomar": true para abrir o terminal e entregar o recado quando ele estiver livre.', code: 'SEM_TERMINAL',
        });
      }
      await runner('POST', `/api/agents/${encodeURIComponent(it.id)}/resume`, undefined, 'retomar a sessão');
      retomado = true;
      quando = 'quando_livre';
    }
    const corpo = quando === 'quando_livre' ? { text: texto, injectWhenIdle: true } : { text: texto, submit: true };
    const r = await runner('POST', `/api/agents/${encodeURIComponent(it.id)}/input`, corpo, 'entregar o recado');
    return { enviado: r.status === 200, enfileirado: r.status === 202, quando, retomado };
  }

  const prefixoDeChave = (req) => (ehChave(req) ? `[recado de ${req.dgclawAuth.nome} pelo painel] ` : '');

  async function rotaRecado(req, res, id) {
    const d = await lerJson(req);
    if (typeof d.texto !== 'string' || !d.texto.trim()) throw new ErroLocal(400, 'O campo "texto" é obrigatório e precisa ser um texto não vazio.');
    if (d.texto.length > RECADO_MAX) throw new ErroLocal(400, `O recado tem ${d.texto.length} caracteres; o limite é ${RECADO_MAX}.`);
    const quando = d.quando === undefined ? 'agora' : d.quando;
    if (quando !== 'agora' && quando !== 'quando_livre') throw new ErroLocal(400, 'O campo "quando" aceita "agora" ou "quando_livre".');
    const it = await itemPorId(id);
    const r = await entregarTexto(it, prefixoDeChave(req) + d.texto, quando, d.retomar === true);
    log(`recado (${r.quando}) em ${id} por ${quemPediu(req)}`);
    enviarJson(res, r.enfileirado ? 202 : 200, Object.assign({ ok: true }, r));
  }

  async function rotaDecidir(req, res, id) {
    if (ehChave(req)) {
      throw new ErroLocal(403, 'Uma chave de API não decide pedidos de permissão: um agente não pode aprovar o próprio pedido.', {
        como_resolver: 'Peça à pessoa para decidir pela tela do painel, com o login dela (botões Aprovar e Negar).', code: 'DECIDIR_SO_COM_LOGIN',
      });
    }
    const d = await lerJson(req);
    if (d.acao !== 'aprovar' && d.acao !== 'negar') throw new ErroLocal(400, 'O campo "acao" precisa ser "aprovar" ou "negar".');
    const it = await itemPorId(id);
    if (it.grupo !== 'esperando_voce') {
      throw new ErroLocal(409, `A sessão ${id} não tem pedido esperando decisão agora (estado: ${it.estado}).`, { como_resolver: 'Recarregue a lista: o pedido pode já ter sido decidido.', code: 'SEM_PEDIDO' });
    }
    await runner('POST', `/api/agents/${encodeURIComponent(id)}/permissao`, { decisao: d.acao }, 'decidir o pedido');
    log(`decidir ${d.acao} em ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, decidido: d.acao });
  }

  function exigirCard(it, acao) {
    if (it.papel !== 'card') {
      throw new ErroLocal(409, `A sessão ${it.id} é a ${it.papel === 'principal' ? 'principal' : 'de bastidores'} deste agente e não pode ser ${acao}.`, {
        como_resolver: 'Isso vale só para os cards que você abriu; a principal e a de bastidores ficam sempre.', code: 'SESSAO_FIXA',
      });
    }
  }

  async function arquivarCard(it, por) {
    let parou = false;
    if (it.tem_terminal) {
      await runner('POST', `/api/agents/${encodeURIComponent(it.id)}/suspend`, undefined, 'parar o terminal');
      parou = true;
    }
    mexerNoRegistro((d) => {
      d[it.id] = Object.assign({}, d[it.id], { arquivado: { quando: new Date().toISOString(), por } });
    });
    return parou;
  }

  async function rotaArquivar(req, res, id) {
    const it = await itemPorId(id);
    exigirCard(it, 'arquivada');
    const parou = await arquivarCard(it, quemPediu(req));
    log(`arquivar ${id} por ${quemPediu(req)} (terminal parado: ${parou})`);
    enviarJson(res, 200, { ok: true, arquivado: true, terminal_parado: parou });
  }

  async function rotaDesarquivar(req, res, id) {
    const it = await itemPorId(id);
    if (!it.arquivado) throw new ErroLocal(404, `A sessão ${id} não está arquivada.`);
    mexerNoRegistro((d) => { d[id] = Object.assign({}, d[id], { arquivado: null }); });
    log(`desarquivar ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, arquivado: false });
  }

  async function rotaRetomar(req, res, id) {
    const d = await lerJson(req);
    const it = await itemPorId(id);
    if (it.tem_terminal) {
      throw new ErroLocal(409, `A sessão ${id} já tem terminal aberto (estado: ${it.estado}); só dá para retomar uma sem terminal.`, { code: 'JA_TEM_TERMINAL' });
    }
    const nova = d.nova === true;
    await runner('POST', `/api/agents/${encodeURIComponent(id)}/${nova ? 'revive' : 'resume'}`, undefined, nova ? 'abrir uma conversa nova' : 'retomar a conversa');
    log(`retomar ${id} (${nova ? 'conversa nova' : 'mesma conversa'}) por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, retomado: true, modo: nova ? 'nova' : 'mesma' });
  }

  async function apagarNoRunner(id) {
    await runner('DELETE', `/api/sessoes/${encodeURIComponent(id)}`, undefined, 'apagar a sessão');
    mexerNoRegistro((d) => { delete d[id]; });
  }

  async function rotaApagar(req, res, id) {
    const it = await itemPorId(id);
    exigirCard(it, 'apagada');
    if (!it.arquivado) {
      throw new ErroLocal(409, `A sessão ${id} não está arquivada, e só se apaga uma arquivada.`, { como_resolver: 'Arquive primeiro (POST /arquivar) e depois apague.', code: 'APAGAR_SO_ARQUIVADA' });
    }
    await apagarNoRunner(id);
    log(`apagar ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, apagado: true, aviso: 'A sessão saiu da lista. A conversa dela continua guardada no disco.' });
  }

  async function rotaRenomear(req, res, id) {
    const d = await lerJson(req);
    const nome = textoDoNome(d.nome);
    await itemPorId(id);
    mexerNoRegistro((reg) => { reg[id] = Object.assign({}, reg[id], { nome }); });
    log(`renomear ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, item: await itemPorId(id) });
  }

  async function rotaFavorito(req, res, id) {
    const d = await lerJson(req);
    if (d.favorito !== undefined && typeof d.favorito !== 'boolean') {
      throw new ErroLocal(400, 'O campo "favorito" precisa ser verdadeiro ou falso (ou ficar de fora, para alternar).');
    }
    const it = await itemPorId(id);
    const valor = d.favorito === undefined ? !it.favorito : d.favorito;
    mexerNoRegistro((reg) => { reg[id] = Object.assign({}, reg[id], { favorito: valor }); });
    log(`favorito=${valor} em ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, { ok: true, item: await itemPorId(id) });
  }

  // ─── Handoff ────────────────────────────────────────────────

  /** Procura, da resposta mais nova para a mais velha, uma mensagem no formato do handoff. */
  function acharHandoff(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || typeof m.text !== 'string') continue;
      const linhas = m.text.split('\n').map((l) => l.trimEnd());
      const nao = linhas.filter((l) => l.trim());
      if (nao.length < 3 || !/^▶/u.test(nao[0].trim()) || !/^✅/u.test(nao[nao.length - 1].trim())) continue;
      const abre = linhas.findIndex((l) => l.trim().startsWith('```'));
      let fecha = -1;
      for (let j = linhas.length - 1; j > abre; j--) if (linhas[j].trim().startsWith('```')) { fecha = j; break; }
      if (abre < 0 || fecha <= abre) continue;
      const prompt = linhas.slice(abre + 1, fecha).join('\n').trim();
      if (!prompt) continue;
      return { nome_novo: nao[0].trim().slice(0, NOME_MAX), nome_antigo: nao[nao.length - 1].trim().slice(0, NOME_MAX), prompt };
    }
    return null;
  }

  async function handoffExistente(id) {
    const r = await runner('GET', `/api/agents/${encodeURIComponent(id)}/conversation?limit=8`, undefined, 'procurar o handoff');
    return acharHandoff(Array.isArray(r.json && r.json.data) ? r.json.data : []);
  }

  async function rotaHandoffConsulta(req, res, id) {
    const it = await itemPorId(id);
    exigirCard(it, 'passada adiante por handoff');
    const h = await handoffExistente(id);
    if (!h) {
      enviarJson(res, 200, { ok: true, encontrado: false, motivo: 'A última resposta desta sessão não tem um handoff no formato (▶️ no começo, bloco de código no meio, ✅ no fim).' });
      return;
    }
    const corte = h.prompt.length > 600 ? `${h.prompt.slice(0, 600).trimEnd()}…` : h.prompt;
    enviarJson(res, 200, { ok: true, encontrado: true, nome_novo: h.nome_novo, nome_antigo: h.nome_antigo, prompt: corte, trecho: corte });
  }

  async function rotaHandoff(req, res, id) {
    const d = await lerJson(req);
    const usar = d.usar_existente === undefined ? true : d.usar_existente;
    const apagar = d.apagar_antigo === undefined ? false : d.apagar_antigo;
    if (typeof usar !== 'boolean' || typeof apagar !== 'boolean') {
      throw new ErroLocal(400, '"usar_existente" e "apagar_antigo" precisam ser verdadeiro ou falso.');
    }
    const it = await itemPorId(id);
    exigirCard(it, 'passada adiante por handoff');
    const h = usar ? await handoffExistente(id) : null;
    if (h) {
      const reg = lerRegistro().dados[id] || {};
      const novo = await criarCard({ nome: h.nome_novo, prompt: h.prompt, pasta: reg.pasta || undefined, por: quemPediu(req) });
      mexerNoRegistro((r) => { r[id] = Object.assign({}, r[id], { nome: h.nome_antigo }); });
      let apagado = false;
      await arquivarCard(Object.assign({}, it, { nome: h.nome_antigo }), quemPediu(req));
      if (apagar) { await apagarNoRunner(id); apagado = true; }
      log(`handoff de ${id} para ${novo.id} por ${quemPediu(req)} (antigo apagado: ${apagado})`);
      enviarJson(res, 201, { ok: true, modo: 'novo', novo, abrir_em: novo.id, antigo_apagado: apagado });
      return;
    }
    await entregarTexto(it, prefixoDeChave(req) + PEDIDO_DE_HANDOFF, 'quando_livre', true);
    log(`handoff pedido em ${id} por ${quemPediu(req)}`);
    enviarJson(res, 202, { ok: true, modo: 'pedido', aviso: 'Pedi o handoff. Quando ele responder, aperte Handoff de novo.' });
  }

  // ─── Anexo (multipart sem dependência) ──────────────────────

  function partesMultipart(corpo, boundary) {
    const sep = Buffer.from(`--${boundary}`);
    const saida = [];
    let pos = corpo.indexOf(sep);
    while (pos !== -1) {
      const ini = pos + sep.length;
      if (corpo.slice(ini, ini + 2).toString() === '--') break;
      const prox = corpo.indexOf(sep, ini);
      if (prox === -1) break;
      const bloco = corpo.slice(ini + 2, prox - 2); // tira o \r\n depois do boundary e antes do próximo
      const fimCab = bloco.indexOf('\r\n\r\n');
      if (fimCab !== -1) {
        const cab = bloco.slice(0, fimCab).toString('utf-8');
        const nome = /name="([^"]*)"/i.exec(cab);
        const arq = /filename="([^"]*)"/i.exec(cab);
        saida.push({ campo: nome ? nome[1] : '', arquivo: arq ? arq[1] : null, dados: bloco.slice(fimCab + 4) });
      }
      pos = prox;
    }
    return saida;
  }

  function nomeSaneado(nome) {
    const base = path.basename(String(nome || '').replace(/\\/g, '/'));
    return base.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(0, NOME_MAX).trim() || 'anexo';
  }

  async function rotaAnexo(req, res, id) {
    const tam = Number(req.headers['content-length'] || 0);
    if (tam > ANEXO_MAX_BYTES + 64 * 1024) {
      throw new ErroLocal(413, `O anexo passa do limite de ${ANEXO_MAX_BYTES / 1024 / 1024} MB.`, { como_resolver: 'Deixe o arquivo numa pasta do agente e cite o caminho no recado.' });
    }
    const tipo = String(req.headers['content-type'] || '');
    const m = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(tipo);
    if (!m) throw new ErroLocal(400, 'Mande o arquivo num multipart/form-data, no campo "arquivo".');
    const it = await itemPorId(id);
    const corpo = await lerCorpoBruto(req, ANEXO_MAX_BYTES + 64 * 1024);
    const partes = partesMultipart(corpo, m[1] || m[2]);
    const arq = partes.find((p) => p.campo === 'arquivo' && p.arquivo !== null);
    if (!arq) throw new ErroLocal(400, 'Não achei o campo "arquivo" no envio.', { como_resolver: 'Mande o arquivo num multipart/form-data, no campo "arquivo".' });
    if (!arq.dados.length) throw new ErroLocal(400, 'O arquivo chegou vazio (0 bytes).', { como_resolver: 'Escolha o arquivo de novo.' });
    if (arq.dados.length > ANEXO_MAX_BYTES) {
      throw new ErroLocal(413, `O anexo tem ${(arq.dados.length / 1024 / 1024).toFixed(1)} MB e o limite é ${ANEXO_MAX_BYTES / 1024 / 1024} MB.`, { como_resolver: 'Mande um menor.' });
    }
    const nome = nomeSaneado(arq.arquivo);
    const pasta = path.join(casa(), 'anexos', id);
    let destino;
    try {
      fs.mkdirSync(pasta, { recursive: true });
      const { name, ext } = path.parse(nome);
      destino = path.join(pasta, nome);
      for (let n = 2; fs.existsSync(destino); n++) destino = path.join(pasta, `${name}-${n}${ext}`);
      fs.writeFileSync(destino, arq.dados, { mode: 0o644, flag: 'wx' });
    } catch (e) {
      throw new ErroLocal(500, `Não consegui guardar o anexo em ${pasta} (${e.code || e.message}).`, { como_resolver: 'Confira a permissão de escrita na pasta do agente.', code: 'ANEXO_NAO_GRAVOU' });
    }
    const resposta = { ok: true, caminho: destino, nome: path.basename(destino), tamanho: arq.dados.length };
    const texto = partes.find((p) => p.campo === 'texto' && p.arquivo === null);
    if (texto && texto.dados.toString('utf-8').trim()) {
      const quandoP = partes.find((p) => p.campo === 'quando');
      const quando = quandoP && quandoP.dados.toString('utf-8').trim() === 'quando_livre' ? 'quando_livre' : 'agora';
      const t = `${texto.dados.toString('utf-8').trim()}\n[anexo: ${destino}]`;
      resposta.recado = await entregarTexto(it, prefixoDeChave(req) + t, quando, false);
    }
    log(`anexo ${path.basename(destino)} (${arq.dados.length} bytes) em ${id} por ${quemPediu(req)}`);
    enviarJson(res, 200, resposta);
  }

  // ─── Documentos ─────────────────────────────────────────────

  const MIME_IMAGEM = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  /** Caminho com algum trecho oculto (.env, .dgclaw, .ssh...) nunca é oferecido, mesmo citado. */
  const temTrechoOculto = (rel) => rel.split(path.sep).some((p) => p.startsWith('.'));

  function candidatosDoTexto(texto) {
    const achados = new Set();
    const re = /(?:^|[\s`'"(\[<=])((?:\/|\.\.?\/)?[\w@%+~.\-]+(?:\/[\w@%+~.\-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s`'")\]>,;:!?]|\.(?:\s|$))/gm;
    let m;
    while ((m = re.exec(texto)) !== null) achados.add(m[1]);
    return achados;
  }

  /** Arquivos citados nas últimas mensagens que existem dentro da casa. Mais novo primeiro. */
  async function documentosCitados(it) {
    const raiz = casa();
    const r = await runner('GET', `/api/agents/${encodeURIComponent(it.id)}/conversation?limit=60`, undefined, 'ler as mensagens para achar documentos');
    const msgs = Array.isArray(r.json && r.json.data) ? r.json.data : [];
    const vistos = new Map();
    for (const msg of msgs) {
      if (!msg || typeof msg.text !== 'string') continue;
      for (const c of candidatosDoTexto(msg.text)) {
        const bases = c.startsWith('/') ? [''] : [raiz, it.cwd].filter(Boolean);
        for (const b of bases) {
          let real;
          try { real = fs.realpathSync(path.resolve(b || '/', c)); } catch { continue; }
          if (!real.startsWith(raiz + path.sep) || temTrechoOculto(path.relative(raiz, real)) || vistos.has(real)) continue;
          let st;
          try { st = fs.statSync(real); } catch { continue; }
          if (!st.isFile()) continue;
          vistos.set(real, {
            caminho: real, nome: path.basename(real), pasta: path.relative(raiz, path.dirname(real)) || '.',
            tipo: path.extname(real).slice(1).toLowerCase(), tamanho: st.size, quando: st.mtime.toISOString(),
          });
          break;
        }
      }
    }
    return [...vistos.values()].sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, 50);
  }

  async function rotaDocumentos(req, res, id) {
    const it = await itemPorId(id);
    enviarJson(res, 200, { ok: true, documentos: await documentosCitados(it) });
  }

  async function rotaDocumento(req, res, id, query) {
    const pedido = query.get('caminho');
    if (!pedido || pedido.length > 1000 || pedido.includes('\0')) {
      throw new ErroLocal(400, 'Mande ?caminho= com o caminho de um documento da lista (até 1000 caracteres).');
    }
    const raiz = casa();
    let real;
    try { real = fs.realpathSync(path.resolve(raiz, pedido)); } catch {
      throw new ErroLocal(404, 'Esse documento não existe mais no disco.', { como_resolver: 'Atualize a lista de documentos.' });
    }
    if (!real.startsWith(raiz + path.sep)) {
      throw new ErroLocal(403, 'Esse arquivo fica fora da pasta do agente, então não abro.', { como_resolver: 'Só abro arquivos que ficam dentro da casa do agente.', code: 'FORA_DA_CASA' });
    }
    const it = await itemPorId(id);
    const citados = await documentosCitados(it);
    if (!citados.some((d) => d.caminho === real)) {
      throw new ErroLocal(403, 'Esse documento não foi citado nesta conversa, então não abro.', { como_resolver: 'Escolha um da lista de documentos da sessão.', code: 'NAO_CITADO' });
    }
    const nome = path.basename(real);
    const ext = path.extname(real).slice(1).toLowerCase();
    const st = fs.statSync(real);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ext === 'pdf' || MIME_IMAGEM[ext]) {
      if (st.size > DOC_BINARIO_MAX) throw new ErroLocal(413, `O arquivo ${nome} tem ${(st.size / 1024 / 1024).toFixed(1)} MB e o limite de leitura é ${DOC_BINARIO_MAX / 1024 / 1024} MB.`);
      res.status(200);
      res.setHeader('Content-Type', ext === 'pdf' ? 'application/pdf' : MIME_IMAGEM[ext]);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nome)}`);
      res.end(fs.readFileSync(real));
      return;
    }
    const fd = fs.openSync(real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, DOC_TEXTO_MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally { fs.closeSync(fd); }
    if (buf.slice(0, 8192).includes(0)) {
      throw new ErroLocal(415, `${nome} não é um arquivo de texto, então não dá para mostrar aqui.`, { como_resolver: 'Abra o arquivo direto na máquina.' });
    }
    enviarJson(res, 200, { ok: true, nome, texto: buf.toString('utf-8'), cortado: st.size > DOC_TEXTO_MAX });
  }

  function rotaDocsMd(req, res) {
    const arq = path.join(__dirname, '..', 'docs', 'SESSOES.md');
    let texto;
    try { texto = fs.readFileSync(arq, 'utf-8'); } catch (e) {
      throw new ErroLocal(500, `Não consegui ler a documentação da aba Sessões (${arq}): ${e.code || e.message}.`, { como_resolver: 'Reinstale o painel.', code: 'SEM_DOCS' });
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(texto);
  }

  // ─── Despacho ───────────────────────────────────────────────

  router.get('/api/sessoes-config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ligado: true, modo: 'local', agente: agenteSlug(), appUrl: null, soLeitura: ehSoLeitura() });
  });

  const NAO_EXISTE_AQUI = 'Isso não existe nesta instalação: o modo local da aba Sessões não tem cofre, barra de pedidos, teclado do terminal nem donos de card.';

  async function despachar(req, res) {
    const original = req.url || '';
    const corte = original.indexOf('?');
    const caminhoBruto = corte === -1 ? original : original.slice(0, corte);
    const query = new URLSearchParams(corte === -1 ? '' : original.slice(corte + 1));
    const resto = caminhoBruto.slice(PREFIXO.length);
    const partes = partesDoCaminho(resto);
    if (!partes) throw new ErroLocal(400, 'O endereço pedido tem uma parte inválida (vazia, "." ou ".." ou com barra escondida).');
    const metodo = req.method;
    const [a, acao, sub] = partes;
    const escrita = metodo !== 'GET' && metodo !== 'HEAD';

    if (metodo !== 'GET' && metodo !== 'POST' && metodo !== 'HEAD') {
      throw new ErroLocal(405, `O método ${metodo} não existe na aba Sessões.`, { como_resolver: 'Use GET para ler e POST para agir.' });
    }
    if (escrita) {
      if (ehSoLeitura()) {
        console.log(`sessoes-local: ${metodo} /${partes.join('/')} recusado: painel em modo só leitura`);
        req.resume();
        throw new ErroLocal(403, 'Neste painel a aba Sessões é só para ler: as ações (recado, criar, arquivar, renomear...) estão desligadas porque este painel não tem a proteção de login na frente.', {
          como_resolver: 'Para liberar as ações, tire DGCLAW_PANEL_SESSOES_SO_LEITURA (ou sessoes.soLeitura do config.json) e reinicie o painel.', code: 'SO_LEITURA',
        });
      }
      // Cookie e Access são credenciais que o navegador manda sozinho; chave de API e proxy do dono não.
      if (!ehChave(req) && !ehProxy(req)) {
        const o = veioDaTela(req);
        if (!o.ok) {
          console.log(`sessoes-local: ${metodo} /${partes.join('/')} recusado: Origin de outro site ou ausente (visto: ${o.visto})`);
          req.resume();
          throw new ErroLocal(403, 'Pedido recusado: ele não veio da tela deste painel (Origin ausente ou de outro site). Por segurança, as ações da aba Sessões só valem quando feitas pela própria tela.');
        }
      }
      const tipo = String(req.headers['content-type'] || '').toLowerCase();
      const temCorpo = req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.headers['transfer-encoding'] !== undefined;
      const aceita = acao === 'anexo' ? /^multipart\/form-data\s*;/ : /^application\/json\s*(;|$)/;
      if (temCorpo && !aceita.test(tipo)) {
        req.resume();
        throw new ErroLocal(415, acao === 'anexo'
          ? 'O anexo precisa vir como envio de arquivo (multipart/form-data).'
          : 'O pedido tem um tipo de conteúdo que a aba Sessões não aceita. Só vale JSON (application/json).');
      }
    }

    if (a && /^(cofre|pedidos|donos)/i.test(a)) throw new ErroLocal(501, NAO_EXISTE_AQUI);
    if (acao === 'tecla') throw new ErroLocal(501, NAO_EXISTE_AQUI);

    if (!escrita) {
      if (!a) return rotaLista(req, res, query);
      if (a === 'docs.md' && !acao) return rotaDocsMd(req, res);
      if (a === 'provedores' && !acao) return rotaProvedores(req, res);
      checarId(a);
      if (!acao) { const it = await itemPorId(a); return enviarJson(res, 200, { ok: true, item: it, fonte: FONTE }); }
      if (acao === 'conversa') return rotaConversa(req, res, a, query);
      if (acao === 'handoff') return rotaHandoffConsulta(req, res, a);
      if (acao === 'documentos' && !sub) return rotaDocumentos(req, res, a);
      if (acao === 'documentos' && sub === 'conteudo') return rotaDocumento(req, res, a, query);
    } else {
      if (!a) return rotaCriar(req, res);
      checarId(a);
      const rotas = {
        recado: rotaRecado, decidir: rotaDecidir, arquivar: rotaArquivar, desarquivar: rotaDesarquivar, retomar: rotaRetomar,
        apagar: rotaApagar, handoff: rotaHandoff, anexo: rotaAnexo, renomear: rotaRenomear, favorito: rotaFavorito,
      };
      if (acao && !sub && Object.prototype.hasOwnProperty.call(rotas, acao)) return rotas[acao](req, res, a);
    }
    throw new ErroLocal(404, `A aba Sessões não tem a rota ${metodo} /${partes.join('/')}.`, { como_resolver: 'Veja as rotas em GET /api/sessoes/docs.md.' });
  }

  router.all([PREFIXO, `${PREFIXO}/*`], (req, res) => {
    despachar(req, res).catch((e) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof ErroLocal) {
        if (e.status >= 500) console.error(`sessoes-local: ${req.method} ${req.url.split('?')[0]} -> ${e.status}: ${e.message}`);
        enviarJson(res, e.status, e.corpo);
        return;
      }
      console.error(`sessoes-local: ${req.method} ${req.url.split('?')[0]} estourou: ${(e && e.stack) || e}`);
      enviarJson(res, 500, { ok: false, erro: `Erro inesperado na aba Sessões: ${(e && e.message) || e}.`, como_resolver: 'Veja o log do painel; a mensagem completa está lá.', code: 'ERRO_INTERNO' });
    });
  });

  // Faxina leve ao subir: registro de sessão que o runner não tem mais não deve ficar para sempre.
  listarCrus().then(limparRegistrosOrfaos).catch((e) => {
    console.log(`sessoes-local: não limpei o registro agora (${e.message}); tento na próxima vez que o painel subir`);
  });
}

module.exports = { registrar };
