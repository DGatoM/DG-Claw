'use strict';
// Núcleo do serviço de ferramentas (bloco I): acha as ferramentas em /etc/dgclaw/ferramentas, confere quem pode usar
// e com que parâmetros, roda o executor num processo filho de ambiente limpo, passa a saída pelo verificador e
// devolve o resultado. Não conhece socket nem HTTP: servidor.js e testar.js usam este arquivo.
//
// O executor roda com o MESMO usuário do serviço (sem privilégio). O que o separa do agente é que o agente nunca o
// vê: a credencial e a base ficam no host, e o agente só recebe o resultado conferido. Um executor enxerga as pastas
// das outras ferramentas (mesmo usuário); quem precisa de separação entre ferramentas usa um serviço por ferramenta.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const esquema = require('./esquema');
const verificador = require('./verificador');
const { mascarar } = require('../web/lib/mascara');

const SAIDA_MAX = 256 * 1024;
const META_MAX = 8 * 1024 * 1024;
const ARQUIVO_MAX = 2 * 1024 * 1024;
const STDERR_MAX = 4 * 1024;
const RX_ARQUIVO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(csv|txt|md|json|html)$/;
const RX_CHAVE_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVADAS = /^(PATH|HOME|TMPDIR|LANG|LC_.*|PYTHON.*|NODE.*|LD_.*|DGCLAW_.*)$/;
const RX_AGENTE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RX_QUEM = /^[A-Za-z0-9_.:@-]{1,80}$/;

const recusa = (motivo, erro, extra) => Object.assign({ ok: false, motivo, erro }, extra || {});
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Lê um credenciais.env (CHAVE=valor por linha). Devolve { ok, env } ou { ok:false, erro }. */
function lerCredenciais(arquivo) {
  let st;
  try { st = fs.lstatSync(arquivo); } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, env: {}, existe: false };
    return { ok: false, erro: `não consegui ler ${arquivo} (${e.code || e.message})` };
  }
  if (!st.isFile()) return { ok: false, erro: `${arquivo} não é um arquivo comum` };
  if (st.mode & 0o077) return { ok: false, erro: `${arquivo} está com permissão ${(st.mode & 0o777).toString(8)}, e arquivo de credencial precisa ser 600. Corrija com: chmod 600 ${arquivo}` };
  const env = {};
  const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (!m) return { ok: false, erro: `${arquivo}, linha ${i + 1}: esperava CHAVE=valor (o conteúdo da linha não é mostrado)` };
    if (!RX_CHAVE_ENV.test(m[1]) || RESERVADAS.test(m[1])) return { ok: false, erro: `${arquivo}, linha ${i + 1}: o nome ${m[1]} não pode ser usado (maiúsculas, números e _; os nomes PATH, HOME, DGCLAW_*, PYTHON*, NODE* e LD_* são reservados)` };
    let v = m[2];
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return { ok: true, env, existe: true };
}

function criarNucleo(opcoes) {
  const o = opcoes || {};
  if (!o.dir) throw new Error('criarNucleo precisa de "dir" (a pasta das ferramentas, por exemplo /etc/dgclaw/ferramentas).');
  const log = o.log || (() => {});
  const agora = o.agora || Date.now;
  const dir = o.dir;
  const credRam = o.credRam || null;
  const libDir = o.libDir || path.join(__dirname, 'lib');
  const chavePath = o.chavePath || path.join(dir, 'chave-pseudonimo');
  const python = o.python || 'python3';
  const tmpBase = o.tmpBase || os.tmpdir();
  const maxConcorrentes = o.maxConcorrentes || 4;
  let emExecucao = 0;

  /** Lê e valida a pasta de UMA ferramenta. { ok, def, pasta } ou { ok:false, erro }. */
  function carregarUma(nome) {
    if (typeof nome !== 'string' || !esquema.RX_NOME.test(nome)) return { ok: false, motivo: 'ferramenta_desconhecida', erro: `"${String(nome).slice(0, 60)}" não é um nome de ferramenta válido.` };
    const pasta = path.join(dir, nome);
    let st;
    try { st = fs.lstatSync(pasta); } catch (e) {
      if (e.code === 'ENOENT') return { ok: false, motivo: 'ferramenta_desconhecida', erro: `Não existe a ferramenta "${nome}".` };
      return { ok: false, motivo: 'ferramenta_invalida', erro: `Não consegui ler a pasta da ferramenta "${nome}" (${e.code || e.message}).` };
    }
    if (!st.isDirectory()) return { ok: false, motivo: 'ferramenta_desconhecida', erro: `Não existe a ferramenta "${nome}".` };
    let bruto;
    try { bruto = JSON.parse(fs.readFileSync(path.join(pasta, 'ferramenta.json'), 'utf8')); } catch (e) {
      return { ok: false, motivo: 'ferramenta_invalida', erro: `A ferramenta "${nome}" tem um ferramenta.json que não abre (${e.code || e.message}). Corrija o arquivo em ${pasta}.` };
    }
    const v = esquema.validarDefinicao(bruto, nome);
    if (!v.ok) return { ok: false, motivo: 'ferramenta_invalida', erro: `A ferramenta "${nome}" está com defeito: ${v.erro}` };
    return { ok: true, def: v.def, pasta };
  }

  function nomesNaPasta() {
    let itens;
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') return [];
      log('erro', `Ferramentas: não consegui listar ${dir} (${e.code || e.message}). Confira a pasta e a permissão do usuário do serviço.`);
      return [];
    }
    return itens.filter((d) => d.isDirectory() && esquema.RX_NOME.test(d.name)).map((d) => d.name).sort();
  }

  /** As ferramentas que `agente` pode usar (ou todas, com agente = null, para o `dgclaw ferramenta listar`). */
  function listar(agente) {
    const boas = [];
    const defeituosas = [];
    for (const nome of nomesNaPasta()) {
      const r = carregarUma(nome);
      if (!r.ok) { defeituosas.push({ nome, erro: r.erro }); log('aviso', `Ferramentas: ${r.erro}`); continue; }
      if (agente == null || r.def.agentes.includes(agente)) boas.push(r.def);
    }
    return { ferramentas: boas, defeituosas: agente == null ? defeituosas : [] };
  }

  function achaExecutor(def, pasta, forcado) {
    const candidatos = forcado ? [forcado] : def.executor ? [def.executor] : ['executor.py', 'executor.js'];
    for (const nome of candidatos) {
      const p = path.join(pasta, nome);
      let st;
      try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (st.isFile()) return p;
    }
    return null;
  }

  function credenciaisDa(nome, pasta) {
    const ram = credRam ? path.join(credRam, nome, 'credenciais.env') : null;
    if (ram && fs.existsSync(ram)) return lerCredenciais(ram);
    if (fs.existsSync(path.join(pasta, 'credenciais.env.cred'))) {
      return { ok: false, erro: `a credencial da ferramenta "${nome}" está cifrada e ainda não foi aberta em memória. Rode no servidor: dgclaw ferramenta abrir ${nome}` };
    }
    return lerCredenciais(path.join(pasta, 'credenciais.env'));
  }

  /** Roda o executor. Devolve { codigo, sinal, stdout, stderr, meta, estourou } e nunca lança. */
  function rodar({ interprete, args, cwd, env, entrada, timeoutMs, memoriaMb, limitaVirtual }) {
    return new Promise((resolve) => {
      const kb = limitaVirtual ? String(memoriaMb * 1024) : '';
      const roteiro = 'if [ -n "$1" ]; then ulimit -v "$1" || { echo "ulimit -v falhou" >&2; exit 125; }; fi; shift; exec "$@"';
      let filho;
      try {
        filho = spawn('/bin/sh', ['-c', roteiro, 'sh', kb, interprete, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        resolve({ codigo: null, sinal: null, stdout: '', stderr: `não consegui iniciar o executor (${e.message})`, meta: '', estourou: null });
        return;
      }
      let stdout = ''; let stderr = ''; let meta = '';
      let estourou = null;
      const mata = (motivo) => {
        if (!estourou) estourou = motivo;
        try { process.kill(-filho.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') log('aviso', `Ferramentas: não consegui matar o executor (${e.code || e.message}).`); }
      };
      const relogio = setTimeout(() => mata('tempo'), timeoutMs);
      filho.stdout.setEncoding('utf8');
      filho.stderr.setEncoding('utf8');
      filho.stdio[3].setEncoding('utf8');
      filho.stdout.on('data', (c) => { stdout += c; if (stdout.length > SAIDA_MAX) mata('saida_grande'); });
      filho.stderr.on('data', (c) => { if (stderr.length < STDERR_MAX) stderr += c; });
      filho.stdio[3].on('data', (c) => { meta += c; if (meta.length > META_MAX) mata('saida_grande'); });
      for (const f of [filho.stdout, filho.stderr, filho.stdio[3], filho.stdin]) f.on('error', () => { /* o filho pode fechar antes de nós; o resultado vem do evento close */ });
      filho.on('error', (e) => { clearTimeout(relogio); resolve({ codigo: null, sinal: null, stdout, stderr: `${stderr} (${e.message})`, meta, estourou }); });
      filho.on('close', (codigo, sinal) => {
        clearTimeout(relogio);
        // Se sobrou algum neto no grupo, ele morre junto.
        try { process.kill(-filho.pid, 'SIGKILL'); } catch (_) { /* grupo já vazio */ }
        resolve({ codigo, sinal, stdout, stderr, meta, estourou });
      });
      filho.stdin.end(JSON.stringify(entrada));
    });
  }

  /**
   * Executa uma ferramenta para um agente. pedido: { ferramenta, agente, usuario?, params?, executor? }.
   * `executor` (nome de arquivo da pasta) só existe para o teste da ferramenta; o socket nunca o repassa.
   */
  async function executar(pedido) {
    const inicio = agora();
    const duracao = () => agora() - inicio;
    if (!pedido || typeof pedido !== 'object') return recusa('pedido_invalido', 'O pedido precisa ser um objeto {"ferramenta": "...", "agente": "...", "params": {...}}.');
    const { ferramenta, agente } = pedido;
    if (typeof agente !== 'string' || !RX_AGENTE.test(agente)) return recusa('pedido_invalido', 'O campo "agente" é obrigatório e precisa ser o slug do agente (ex.: "ana").');
    if (pedido.usuario != null && (typeof pedido.usuario !== 'string' || !RX_QUEM.test(pedido.usuario))) return recusa('pedido_invalido', 'O campo "usuario" tem caracteres que não aceito.');
    const t = carregarUma(ferramenta);
    if (!t.ok) return recusa(t.motivo, t.erro);
    const { def, pasta } = t;
    if (!def.agentes.includes(agente)) {
      return recusa('agente_nao_autorizado', `O agente "${agente}" não está na lista de agentes da ferramenta "${def.nome}". Quem pode incluí-lo é o responsável: ${def.responsavel}.`);
    }
    const v = esquema.validarParametros(def.parametros, pedido.params);
    if (!v.ok) return recusa('parametros', v.erro);
    const executorPath = achaExecutor(def, pasta, pedido.executor);
    if (!executorPath) return recusa('ferramenta_invalida', `A ferramenta "${def.nome}" não tem o executor (executor.py ou executor.js) em ${pasta}.`);
    const cred = credenciaisDa(def.nome, pasta);
    if (!cred.ok) {
      log('erro', `Ferramentas: credencial da ferramenta ${def.nome}: ${cred.erro}`);
      return recusa('credencial', `A credencial da ferramenta "${def.nome}" não está utilizável. Quem cuida do servidor vê o motivo no log do dgclaw-ferramentas.`);
    }
    if (emExecucao >= maxConcorrentes) return recusa('ocupado', `Já há ${maxConcorrentes} ferramentas rodando ao mesmo tempo. Espere alguns segundos e tente de novo.`);

    emExecucao++;
    let tmp = null;
    try {
      tmp = fs.mkdtempSync(path.join(tmpBase, 'dgf-'));
      fs.chmodSync(tmp, 0o700);
      const saidaDir = path.join(tmp, 'saida');
      fs.mkdirSync(saidaDir, { mode: 0o700 });
      const ehPython = executorPath.endsWith('.py');
      const env = Object.assign({}, cred.env, {
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, LANG: 'C.UTF-8',
        PYTHONPATH: libDir, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
        DGCLAW_FERRAMENTA: def.nome, DGCLAW_SAIDA_DIR: saidaDir, DGCLAW_MINIMO_GRUPO: String(def.minimo_grupo),
        DGCLAW_CHAVE_PSEUDONIMO: chavePath,
      });
      const r = await rodar({
        interprete: ehPython ? python : process.execPath,
        args: ehPython ? ['-B', executorPath] : [`--max-old-space-size=${def.memoria_mb}`, executorPath],
        cwd: tmp, env, entrada: { ferramenta: def.nome, params: v.params, minimo_grupo: def.minimo_grupo },
        timeoutMs: def.timeout_s * 1000, memoriaMb: def.memoria_mb, limitaVirtual: ehPython,
      });
      const falhou = (motivo, erro) => {
        log('erro', `Ferramentas: ${def.nome} (agente ${agente}): ${erro} Saída de erro do executor (cortada e mascarada): ${mascarar(r.stderr).replace(/\s+/g, " ").slice(-400)}`);
        return recusa(motivo, erro, { meta: { ferramenta: def.nome, duracao_ms: duracao(), registros_lidos: null } });
      };
      if (r.estourou === 'tempo') return falhou('tempo_esgotado', `A ferramenta "${def.nome}" passou de ${def.timeout_s} s e foi encerrada. Nada foi entregue; tente com um período menor.`);
      if (r.estourou === 'saida_grande') return falhou('saida_invalida', `O executor da ferramenta "${def.nome}" devolveu mais dados do que o limite (${SAIDA_MAX} bytes) e foi encerrado.`);
      if (r.codigo !== 0) {
        if (/MemoryError|Cannot allocate memory|heap out of memory/.test(r.stderr) || r.codigo === 137) return falhou('memoria_esgotada', `A ferramenta "${def.nome}" estourou o limite de memória (${def.memoria_mb} MB). Nada foi entregue.`);
        return falhou('falha_execucao', `O executor da ferramenta "${def.nome}" terminou com erro (${r.sinal ? `sinal ${r.sinal}` : `código ${r.codigo}`}). O motivo está no log do dgclaw-ferramentas, que só o TI lê.`);
      }

      let dados;
      try { dados = JSON.parse(r.stdout); } catch (_) { return falhou('saida_invalida', `O executor da ferramenta "${def.nome}" não devolveu um JSON válido. Corrija o executor para entregar o resultado com resultado() da biblioteca dgclaw_ferramenta.`); }
      if (dados === null || typeof dados !== 'object') return falhou('saida_invalida', `O executor da ferramenta "${def.nome}" precisa devolver um objeto ou uma lista JSON.`);
      let meta = {};
      if (r.meta.trim()) {
        try { meta = JSON.parse(r.meta); } catch (_) { return falhou('saida_invalida', `O executor da ferramenta "${def.nome}" mandou metadados que não são JSON.`); }
      }
      const registros = Number.isInteger(meta.registros_lidos) && meta.registros_lidos >= 0 ? meta.registros_lidos : null;
      const nomes = Array.isArray(meta.nomes_proibidos) ? meta.nomes_proibidos.filter((n) => typeof n === 'string') : [];
      try {
        for (const l of fs.readFileSync(path.join(pasta, 'nomes-proibidos.txt'), 'utf8').split('\n')) if (l.trim()) nomes.push(l.trim());
      } catch (e) {
        if (e.code !== 'ENOENT') log('aviso', `Ferramentas: não consegui ler nomes-proibidos.txt de ${def.nome} (${e.code || e.message}); o verificador usou só os nomes que o executor mandou.`);
      }
      const opcoesVer = { nomes, permitir: def.permitir_tipos, agora: agora() };
      const bloqueio = (tipos) => {
        log('aviso', `Ferramentas: resultado de ${def.nome} (agente ${agente}) BLOQUEADO pelo verificador: ${tipos.join(', ')}. Corrija o executor.`);
        return recusa('bloqueado_pelo_verificador', verificador.mensagemDeBloqueio(tipos), { tipos, meta: { ferramenta: def.nome, duracao_ms: duracao(), registros_lidos: registros, verificador: 'bloqueado' } });
      };
      const achado = verificador.verificar(dados, opcoesVer);
      if (achado.achou) return bloqueio(achado.tipos);

      let arquivo = null;
      if (meta.arquivo != null) {
        if (!def.gera_arquivo) return falhou('saida_invalida', `O executor da ferramenta "${def.nome}" gerou um arquivo, mas ferramenta.json não declara "gera_arquivo": true.`);
        if (typeof meta.arquivo !== 'string' || !RX_ARQUIVO.test(meta.arquivo)) return falhou('saida_invalida', `O nome do arquivo gerado por "${def.nome}" não vale: use letras, números, ponto, traço e sublinhado, terminando em .csv, .txt, .md, .json ou .html.`);
        const caminho = path.join(saidaDir, meta.arquivo);
        let st;
        try { st = fs.lstatSync(caminho); } catch (_) { return falhou('saida_invalida', `O executor de "${def.nome}" disse que gerou ${meta.arquivo}, mas o arquivo não está na pasta de saída.`); }
        if (!st.isFile() || st.size > ARQUIVO_MAX) return falhou('saida_invalida', `O arquivo ${meta.arquivo} de "${def.nome}" não é um arquivo comum ou passa de ${ARQUIVO_MAX} bytes.`);
        const conteudo = fs.readFileSync(caminho);
        const achouArq = verificador.verificar(conteudo.toString('utf8'), opcoesVer);
        if (achouArq.achou) return bloqueio(achouArq.tipos);
        arquivo = { nome: meta.arquivo, bytes: conteudo.length, conteudo_b64: conteudo.toString('base64') };
      }
      const texto = JSON.stringify(dados);
      return {
        ok: true,
        resultado: dados,
        meta: {
          ferramenta: def.nome, registros_lidos: registros, hash_resultado: sha(texto + (arquivo ? `\n${sha(arquivo.conteudo_b64)}` : '')),
          duracao_ms: duracao(), verificador: 'aprovado', retencao_dias: def.retencao_dias, arquivo,
        },
      };
    } catch (e) {
      log('erro', `Ferramentas: erro inesperado ao executar ${def.nome}: ${e && e.stack || e}`);
      return recusa('falha_execucao', `Erro inesperado ao executar "${def.nome}". Veja o log do dgclaw-ferramentas no servidor: journalctl -u dgclaw-ferramentas.`, { meta: { ferramenta: def.nome, duracao_ms: duracao(), registros_lidos: null } });
    } finally {
      emExecucao--;
      if (tmp) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {
          log('erro', `Ferramentas: não consegui apagar a pasta temporária ${tmp} (${e.code || e.message}). Ela pode ter dado pessoal: apague à mão.`);
        }
      }
    }
  }

  return { listar, executar, carregarUma, emExecucao: () => emExecucao };
}

module.exports = { criarNucleo, lerCredenciais };
