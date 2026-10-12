// saude.js — A saúde da RESPOSTA do agente, e os dois botões de reiniciar.
//
// POR QUE ESTE MÓDULO EXISTE (01/10/2026). O selo do cabeçalho media o PROCESSO: o
// terminal está de pé? Dois agentes passaram uma semana mudos por login
// vencido com o runner dizendo "working", o watchdog dizendo "VIVA" e o selo verde.
// A Isa, agente irmã, ficou 56 minutos muda porque o filtro de segurança da Anthropic
// cortou uma resposta, e ninguém viu. Processo de pé que só devolve recusa está, para
// quem fala com ele, tão fora do ar quanto um processo morto.
//
// Quem sabe ler a resposta é o `scripts/_lib/saude_sessao.py` (o contrato está no
// cabeçalho dele). Quem sabe reiniciar, nos três mundos (card do Bunker, runner da
// jaula, sessão --channels clássica), é o `scripts/_lib/reinicio.py`. Este módulo NÃO
// reimplementa nenhum dos dois: chama, guarda em cache e traduz para HTTP. O watchdog
// chama os mesmos dois arquivos, então o painel e o vigia nunca discordam.
//
// O QUE NÃO DESCE PARA O NAVEGADOR: caminho de arquivo do servidor. O diagnóstico é
// pedido SEM --interno (que é onde moram os caminhos), e o trecho literal da resposta
// passa por `semCaminhos()`, porque a explicação do runner às vezes cita um arquivo
// ("não achei /home/agente/.credentials.json"). Quem abre o painel é o dono do agente, não o
// dono da máquina.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { acharLibDir } = require('./conversa');
const { caminhoDoToken } = require('./runner-token');

/** Quanto tempo um diagnóstico vale. O selo pergunta a cada 30 s; o watchdog, a cada 5 min. */
const CACHE_MS = 20000;

/**
 * Tira caminhos absolutos de um texto que vai para a tela. Troca por "[arquivo do
 * servidor]" em vez de apagar, para a frase continuar fazendo sentido.
 */
function semCaminhos(texto) {
  if (texto == null) return texto;
  return String(texto).replace(/(?:~|\/)(?:[\w.@-]+\/)+[\w.@-]*/g, '[arquivo do servidor]');
}

function buildSaude(CONFIG, serverDir) {
  const { dir: LIB, candidatos } = acharLibDir(serverDir);
  const SAUDE_PY = LIB ? path.join(LIB, 'saude_sessao.py') : null;
  const REINICIO_PY = LIB ? path.join(LIB, 'reinicio.py') : null;
  if (!LIB || !fs.existsSync(SAUDE_PY)) {
    console.error(
      '[saude] NAO ACHEI o saude_sessao.py, entao o selo nao vai saber se ele RESPONDE (so se esta de pe).\n' +
      `        Procurei em: ${candidatos.join(', ')}\n` +
      '        O que fazer: atualizar a copia do plugin do agente (.dgclaw/plugin) para a versao do painel.',
    );
  }
  const SLUG = CONFIG.agentSlug || 'agente';
  const CONFIG_SH = path.join(CONFIG.agentDir, '.dgclaw', 'config.sh');

  /**
   * O ambiente dos scripts, item por item (mesmo motivo do `ambiente()` do conversa.js:
   * herdar o process.env inteiro já mandou recado para o painel errado). A senha do
   * painel NUNCA entra.
   */
  function ambiente(extra) {
    const e = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      TZ: process.env.TZ || 'America/Sao_Paulo',
      DGCLAW_SLUG: SLUG,
      DGCLAW_WORKSPACE: CONFIG.agentDir,
      DGCLAW_NAME: CONFIG.agentName || '',
    };
    const opcionais = {
      DGCLAW_BUNKER_CARD: CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD,
      DGCLAW_BUNKER_URL: CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL,
      RUNNER_TOKEN_FILE: caminhoDoToken(CONFIG),
      DGCLAW_CHANNEL_NAME: process.env.DGCLAW_CHANNEL_NAME,
      DGCLAW_SESSION_DIR: process.env.DGCLAW_SESSION_DIR,
      DGCLAW_INJECT_MODE: process.env.DGCLAW_INJECT_MODE,
      DGCLAW_SERVICE: CONFIG.cofreUnidade || process.env.DGCLAW_SERVICE,
      DGCLAW_CHAT_ID: process.env.DGCLAW_CHAT_ID || CONFIG.chat,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      DGCLAW_CLAUDE_BIN: process.env.DGCLAW_CLAUDE_BIN || process.env.CLAUDE_BIN,
    };
    for (const [k, v] of Object.entries(opcionais)) if (v) e[k] = String(v);
    return Object.assign(e, extra || {});
  }

  /**
   * Como rodar o reinicio.py. Com o config.sh do agente legível, ele é LIDO antes
   * (`source`), igual ao timer do watchdog: assim o reinício do painel enxerga o mesmo
   * DGCLAW_SERVICE, o mesmo modo de injeção e o mesmo canal de aviso que o vigia. Sem o
   * config.sh, vale o ambiente montado aqui.
   */
  function comandoReinicio(args) {
    if (fs.existsSync(CONFIG_SH)) {
      try {
        fs.accessSync(CONFIG_SH, fs.constants.R_OK);
        return {
          bin: 'bash',
          // O rc do `source` NAO e conferido de proposito: ele e o rc da ultima linha do
          // config, que pode ser um teste qualquer. A leitura ja foi conferida acima.
          args: ['-c', 'source "$1" >/dev/null 2>&1; shift; exec python3 "$@"',
            '_', CONFIG_SH, REINICIO_PY, ...args],
        };
      } catch (e) {
        console.error(`[saude] o config.sh do agente existe mas nao e legivel por este painel (${e.code}); ` +
          'reinicio vai com o ambiente do painel.');
      }
    }
    return { bin: 'python3', args: [REINICIO_PY, ...args] };
  }

  function rodar(bin, args, { timeout = 30000, env } = {}) {
    return new Promise((resolve) => {
      execFile(bin, args, { env: env || ambiente(), timeout, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
          let json = null;
          try { json = JSON.parse(String(stdout || '').trim().split('\n').pop() || 'null'); } catch { json = null; }
          resolve({ code, json, stdout: String(stdout || ''), stderr: String(stderr || ''), morto: !!(err && err.killed) });
        });
    });
  }

  // ── o diagnóstico ──────────────────────────────────────────────────────────

  let _cache = { em: 0, valor: null };
  let _emVoo = null;

  function indeterminado(frase, como) {
    return {
      estado: 'indeterminado', tipo: 'desconhecido', frase, trecho: null, desde: null,
      ocorrencias: 0, recomendacao: 'esperar', comoResolver: como, sessionId: null,
      verificadoEm: new Date().toISOString(),
    };
  }

  async function medir() {
    if (!SAUDE_PY || !fs.existsSync(SAUDE_PY)) {
      return indeterminado(
        'Este painel não tem a parte que confere se ele está respondendo.',
        'Quem cuida do sistema precisa atualizar o plugin do agente; o registro do painel diz onde procurei.');
    }
    const r = await rodar('python3', [SAUDE_PY, '--json'], { timeout: 25000 });
    if (r.morto) {
      console.error('[saude] o diagnostico passou de 25 s e foi interrompido');
      return indeterminado('A conferência demorou demais e eu parei no meio.', 'Espere um minuto: o painel tenta de novo sozinho.');
    }
    if (!r.json || typeof r.json.estado !== 'string') {
      console.error(`[saude] saude_sessao.py saiu ${r.code} sem JSON valido. stderr: ${r.stderr.trim().slice(0, 400)}`);
      return indeterminado('Não consegui conferir as respostas dele agora.',
        'Espere um minuto. Se continuar, avise quem cuida do sistema: o registro do painel tem o motivo.');
    }
    if (r.stderr.trim()) console.error(`[saude] avisos do diagnostico: ${r.stderr.trim().slice(0, 400)}`);
    const d = r.json;
    d.trecho = semCaminhos(d.trecho);
    d.frase = semCaminhos(d.frase);
    return d;
  }

  /** O diagnóstico, com cache de 20 s e UMA medição por vez (duas abas abertas não dobram o custo). */
  async function diagnostico({ fresco = false } = {}) {
    if (!fresco && _cache.valor && Date.now() - _cache.em < CACHE_MS) return _cache.valor;
    if (_emVoo) return _emVoo;
    _emVoo = (async () => {
      try {
        const valor = await medir();
        _cache = { em: Date.now(), valor };
        return valor;
      } finally {
        _emVoo = null;
      }
    })();
    return _emVoo;
  }

  /** A marca do modo de segurança, sem caminho de servidor (reinicio.py status). */
  async function modoSeguro() {
    if (!REINICIO_PY || !fs.existsSync(REINICIO_PY)) return null;
    const r = await rodar('python3', [REINICIO_PY, 'status', '--json'], { timeout: 10000 });
    if (!r.json) {
      console.error(`[saude] reinicio.py status saiu ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
      return null;
    }
    if (r.json.quarentena) r.json.quarentena.trechoDaMensagem = semCaminhos(r.json.quarentena.trechoDaMensagem);
    return r.json;
  }

  // ── reiniciar ──────────────────────────────────────────────────────────────

  let _seguroEmVoo = null;

  /**
   * Reinicia. Devolve { status, corpo } já no formato da resposta HTTP.
   *
   * normal: síncrono, com espera curta (25 s) para a sessão ficar de pé. A resposta
   *   diz se confirmou ou não; "pedi e ainda não confirmei" é diferente de "voltou".
   * seguro: leva até dois minutos (sessão nova, esperar ela ficar ociosa, entregar o
   *   recado, conferir que chegou), então roda em SEGUNDO PLANO. Antes, o `checar`
   *   rápido diz se dá para fazer daqui; o andamento a tela acompanha pelo
   *   `modoSeguro` do /api/saude.
   */
  async function reiniciar(modo) {
    if (modo !== 'normal' && modo !== 'seguro') {
      return { status: 400, corpo: {
        error: 'Não sei reiniciar desse jeito.',
        howToFix: 'Escolha "normal" (volta na mesma conversa) ou "seguro" (volta sem carregar a conversa que travou).',
      } };
    }
    if (!REINICIO_PY || !fs.existsSync(REINICIO_PY)) {
      console.error(`[saude] reiniciar(${modo}): reinicio.py ausente (procurei em ${candidatos.join(', ')})`);
      return { status: 500, corpo: {
        error: 'Este painel não tem a parte que sabe reiniciar o agente.',
        howToFix: 'Quem cuida do sistema precisa atualizar o plugin do agente (.dgclaw/plugin) para a versão deste painel.',
      } };
    }
    _cache = { em: 0, valor: null }; // o diagnóstico de antes do reinício não vale mais

    if (modo === 'normal') {
      const c = comandoReinicio(['normal', '--origem', 'painel', '--json']);
      const r = await rodar(c.bin, c.args, { timeout: 90000, env: ambiente({ DGCLAW_REINICIO_PRAZO_S: '25' }) });
      if (r.json && r.json.ok) return { status: 200, corpo: { reiniciado: true, ...r.json } };
      const motivo = (r.json && r.json.motivo) || r.stderr.trim().split('\n').pop() || `saiu com código ${r.code}`;
      console.error(`[saude] reinicio NORMAL falhou (rc ${r.code}): ${motivo}`);
      return { status: r.json ? 502 : 500, corpo: {
        error: `Não consegui reiniciar ${CONFIG.agentName || 'o agente'}: ${semCaminhos(motivo)}`,
        howToFix: semCaminhos((r.json && r.json.comoResolver) || 'Tente de novo em um minuto. Se continuar, avise quem cuida do sistema.'),
      } };
    }

    if (_seguroEmVoo) {
      return { status: 409, corpo: {
        error: 'Já estou reiniciando em modo de segurança.',
        howToFix: 'Espere terminar: leva até dois minutos. O selo mostra quando ele voltar.',
      } };
    }
    const chk = comandoReinicio(['checar', '--json']);
    const pre = await rodar(chk.bin, chk.args, { timeout: 30000 });
    if (!pre.json) {
      console.error(`[saude] reinicio.py checar saiu ${pre.code} sem JSON: ${pre.stderr.trim().slice(0, 300)}`);
      return { status: 500, corpo: { error: 'Não consegui nem conferir se dá para reiniciar daqui.',
        howToFix: 'Avise quem cuida do sistema: o registro do painel tem o motivo.' } };
    }
    if (!pre.json.ok) {
      const ocupado = pre.json.emAndamento;
      return { status: ocupado ? 409 : 503, corpo: {
        error: `Não dá para reiniciar em modo de segurança agora: ${semCaminhos(pre.json.motivo)}.`,
        howToFix: semCaminhos(pre.json.comoResolver || 'Tente de novo em um minuto.'),
      } };
    }

    const log = path.join(CONFIG.agentDir, '.dgclaw', 'logs', 'reinicio-painel.log');
    let fd;
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fd = fs.openSync(log, 'a');
    } catch (e) {
      console.error(`[saude] nao consegui abrir o registro ${log}: ${e.message}`);
      return { status: 500, corpo: { error: 'Não consegui preparar o registro do reinício.',
        howToFix: 'Avise quem cuida do sistema: a pasta .dgclaw/logs do agente não está gravável.' } };
    }
    const c = comandoReinicio(['seguro', '--origem', 'painel', '--json']);
    const filho = spawn(c.bin, c.args, { env: ambiente(), stdio: ['ignore', fd, fd], detached: true });
    fs.closeSync(fd);
    _seguroEmVoo = new Promise((resolve) => {
      filho.on('error', (e) => {
        console.error(`[saude] o modo de seguranca nao comecou: ${e.message}`);
        resolve();
      });
      filho.on('exit', (code) => {
        if (code !== 0) console.error(`[saude] o modo de seguranca terminou com codigo ${code}; ver .dgclaw/logs/reinicio-painel.log`);
        _cache = { em: 0, valor: null };
        resolve();
      });
    }).finally(() => { _seguroEmVoo = null; });
    filho.unref();
    return { status: 202, corpo: {
      iniciado: true,
      frase: 'Estou reiniciando em modo de segurança. Leva até dois minutos: ele volta sem carregar a ' +
        'conversa que travou, e deve te mandar uma mensagem dizendo que voltou.',
    } };
  }

  return { diagnostico, modoSeguro, reiniciar, semCaminhos };
}

module.exports = { buildSaude, semCaminhos };
