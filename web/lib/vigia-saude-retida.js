'use strict';
// Vigia da saúde retida: avisa o DONO (e a equipe) quando um agente cujos avisos estão retidos
// (DGCLAW_AVISOS_RETIDOS=1 no .dgclaw/config.sh da casa dele) para de responder.
//
// Por que existe: com a retenção ligada, o notify-owner.sh de dentro do container não entrega nada pela
// conversa, para o aviso não cair na conversa do cliente. A trava nunca foi para ninguém ficar sem saber:
// um agente já passou 22 h sem login enquanto o watchdog marcava saude.json = atencao/login a cada 5 min.
// Este vigia roda no HOST, lê o saude.json que o watchdog já grava e avisa por canais que não passam
// pela conversa do agente: Web Push no aparelho do dono e, se configurado, um comando da equipe.
//
// Regras:
//   * só olha agente retido; agente que não é retido já recebe o aviso pelo notify-owner dele;
//   * avisa na TRANSIÇÃO (ok -> caído e caído -> ok), nunca a cada rodada; o estado fica em disco
//     (<dataDir>/vigia-saude/estado.json), então reiniciar o painel não repete aviso;
//   * o arquivo saude.json é escrito de dentro do container: só estado e tipo (ambos conferidos contra as
//     listas do vigia) entram na decisão, e NENHUM texto livre dele entra no aviso;
//   * nada vai para a conversa do agente: este módulo não recebe runner, conversa, thread nem caixa e não
//     escreve na casa do agente (só lê, com o leitor seguro contra atalho).
// Relógio, intervalo, leitor, push e executor de comando são injetados para os testes andarem no tempo.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const U = require('./diagnostico/util');
const { lerJsonSeguro } = require('./diagnostico/arquivos');
const { FRASES_SAUDE } = require('./diagnostico/agente');
const { gravaArquivoSeguro } = require('./grava-seguro');

const INTERVALO_MS = 5 * 60000;
const PRIMEIRA_RODADA_MS = 30000;
const VIGIA_PARADO_MS = 30 * 60000; // igual ao diagnóstico: sem conferência há mais que isso = vigia de dentro parado
const TIMEOUT_COMANDO_MS = 30000;
const MAX_CONFIG_BYTES = 64 * 1024;
const TOLERANCIA_FUTURO_MS = 5 * 60000; // relógio do container um pouco adiantado não invalida a conferência
// Valores que o saude_sessao.py grava em "recomendacao"; qualquer outro é ignorado.
const RECOMENDACOES = ['nada', 'esperar', 'reiniciar', 'modo_seguro', 'refazer_login'];
const RX_RETIDO = /^\s*(export\s+)?DGCLAW_AVISOS_RETIDOS=["']?1["']?\s*(#.*)?$/;
const RX_ATRIBUICAO = /^\s*(export\s+)?DGCLAW_AVISOS_RETIDOS=/;

const AVISO_RETIDO = 'Os avisos deste agente ao dono estão retidos (DGCLAW_AVISOS_RETIDOS=1), então ninguém do lado do cliente foi avisado e quem escreve para ele fica sem resposta.';

/** Quando o config.sh tem a retenção ligada. Nunca executa o arquivo: só procura a linha. A última atribuição vale, como num `source`. */
function estaRetido(texto) {
  let ultima = null;
  for (const linha of String(texto).split('\n')) if (RX_ATRIBUICAO.test(linha)) ultima = linha;
  return ultima !== null && RX_RETIDO.test(ultima);
}

/**
 * Executor padrão: bash -c com o texto no stdin. Nada é interpolado na string do comando. Nunca rejeita.
 * O comando roda em grupo de processos próprio: no prazo, o grupo inteiro é morto (um neto pendurado não prende a
 * rodada). A saída e o erro do comando são descartados de propósito: o erro pode conter a URL de um webhook.
 */
function executarComando({ cmd, texto, env, timeoutMs, log }) {
  return new Promise((resolve) => {
    let terminou = false;
    let filho;
    const fim = (r) => { if (terminou) return; terminou = true; clearTimeout(prazo); resolve(r); };
    const prazo = setTimeout(() => {
      if (filho && filho.pid) {
        try { process.kill(-filho.pid, 'SIGKILL'); } catch (e) {
          if (log) log('aviso', `Vigia de saúde retida: não consegui encerrar o grupo de processos do comando da equipe (${e.code || e.message}). Confira com ps se sobrou algum processo.`);
        }
      }
      try { filho.stdin.destroy(); } catch (_) { /* já fechado */ }
      fim({ rc: null, signal: 'SIGKILL', expirou: true });
    }, timeoutMs);
    try {
      filho = spawn('bash', ['-c', cmd], { env, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    } catch (e) { fim({ rc: null, signal: null, expirou: false, erroInicio: `não consegui iniciar o bash (${e.code || e.message})` }); return; }
    filho.stdin.on('error', () => { /* o comando fechou o stdin sem ler: o código de saída diz se deu certo */ });
    filho.on('error', (e) => fim({ rc: null, signal: null, expirou: false, erroInicio: `não consegui iniciar o bash (${e.code || e.message})` }));
    filho.on('close', (rc, signal) => fim({ rc, signal, expirou: false }));
    filho.stdin.end(texto);
  });
}

function criarVigiaSaudeRetida({ registro, lerArquivo, push, relogio, log, intervaloMs, primeiraRodadaMs, dataDir, tz, comando, executor, timeoutComandoMs }) {
  const agora = relogio || Date.now;
  const executa = executor || executarComando;
  const pasta = path.join(dataDir, 'vigia-saude');
  const arquivoEstado = path.join(pasta, 'estado.json');
  let estado = { versao: 1, agentes: {} };
  let carregado = false;
  let soMemoria = false; // arquivo de estado ilegível: não sobrescrever às cegas
  const semLeituraAvisado = new Set(); // slug: já registrei "sem leitura" nesta sequência
  const falhaLogada = new Set(); // slug: já registrei a falha completa de entrega do "caiu"
  const voltouFalhaLogada = new Set(); // slug: já registrei a falha completa de entrega do "voltou"
  const configAvisado = new Set();
  let timerInicial = null;
  let timer = null;
  let emCurso = false;

  // ── estado em disco ───────────────────────────────────────────────────────
  function carrega() {
    if (carregado) return;
    carregado = true;
    let texto;
    try { texto = fs.readFileSync(arquivoEstado, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return;
      soMemoria = true;
      log('erro', `Vigia de saúde retida: não consegui ler ${arquivoEstado} (${e.code || e.message}). Sigo só em memória e não vou sobrescrever o arquivo: confira a permissão dele ou mova-o para o lado e reinicie o painel. Até lá, depois de um reinício o aviso de um agente que já estava fora pode se repetir.`);
      return;
    }
    try {
      const j = JSON.parse(texto);
      if (!j || typeof j !== 'object' || j.versao !== 1 || !j.agentes || typeof j.agentes !== 'object' || Array.isArray(j.agentes)) throw new Error('o formato esperado é {"versao":1,"agentes":{...}}');
      estado = { versao: 1, agentes: j.agentes };
    } catch (e) {
      soMemoria = true;
      log('erro', `Vigia de saúde retida: o arquivo ${arquivoEstado} não tem um JSON válido (${e.message}). Sigo só em memória e não vou sobrescrevê-lo: corrija ou mova o arquivo e reinicie o painel (para zerar, apague-o com o painel parado).`);
    }
  }

  function salva() {
    if (soMemoria) return;
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
      const opc = { raiz: dataDir, modo: 0o600, pasta: { modo: 0o700, uid, gid, recursiva: true } };
      if (uid !== undefined) { opc.uid = uid; opc.gid = gid; }
      gravaArquivoSeguro(arquivoEstado, `${JSON.stringify(estado, null, 2)}\n`, opc);
    } catch (e) {
      log('erro', `Vigia de saúde retida: não consegui gravar ${arquivoEstado} (${e.message}). Sem o arquivo, depois de reiniciar o painel o aviso de um agente que já estava fora pode se repetir. Confira espaço e permissão da pasta de dados do Web.`);
    }
  }

  // ── leitura do agente ─────────────────────────────────────────────────────
  /** 'retido' | 'nao' | 'ilegivel'. */
  function lerRetencao(ag) {
    const r = lerArquivo(ag.home_host, '.dgclaw/config.sh', { max: MAX_CONFIG_BYTES });
    if (r.estado === 'ok' && r.tamanho <= MAX_CONFIG_BYTES) { configAvisado.delete(ag.slug); return estaRetido(r.texto) ? 'retido' : 'nao'; }
    if (r.estado === 'ausente') return 'nao';
    const motivoLeitura = r.estado === 'ok' ? `o arquivo tem ${r.tamanho} bytes e o leitor só olha os últimos ${MAX_CONFIG_BYTES}` : r.motivo;
    if (!configAvisado.has(ag.slug)) {
      configAvisado.add(ag.slug);
      log('aviso', `Vigia de saúde retida: não consegui ler o config.sh de ${ag.slug} (${motivoLeitura}). Não sei se os avisos dele estão retidos, então não mexi no estado dele. Confira a pasta .dgclaw da casa do agente.`);
    }
    return 'ilegivel';
  }

  /** Devolve { caido, tipo, desdeMs, desdeAproximado, verificadoMs, recomendacao } ou null (sem leitura). */
  function classificar(ag) {
    const r = lerJsonSeguro(lerArquivo, ag.home_host, '.dgclaw/logs/saude.json');
    const semLeitura = (motivo) => {
      if (!semLeituraAvisado.has(ag.slug)) {
        semLeituraAvisado.add(ag.slug);
        log('aviso', `Vigia de saúde retida: sem leitura da saúde de ${ag.slug} (${motivo}). Não mudei nada e não avisei; se isso durar, confira se o vigia da sessão (watchdog) está rodando.`);
      }
      return null;
    };
    if (r.estado === 'ausente') return semLeitura('o arquivo .dgclaw/logs/saude.json ainda não existe');
    if (r.estado !== 'ok') return semLeitura(r.motivo);
    const d = r.dados;
    // Primeiro a antiguidade: vale o horário mais recente e plausível entre a conferência da sessão e a do watchdog.
    // Horário ausente, inválido ou no futuro não conta (e, sozinho, nunca prova que o agente voltou).
    const limite = agora() + TOLERANCIA_FUTURO_MS;
    const horarios = [d.verificadoEm, d.watchdogEm].map((v) => Date.parse(v)).filter((ms) => Number.isFinite(ms) && ms <= limite);
    const verificadoMs = horarios.length ? Math.max(...horarios) : null;
    if (verificadoMs !== null && agora() - verificadoMs > VIGIA_PARADO_MS) {
      semLeituraAvisado.delete(ag.slug);
      return { caido: true, tipo: 'vigia_parado', desdeMs: verificadoMs, desdeAproximado: false, verificadoMs, recomendacao: null };
    }
    const est = U.dentro(d.estado, U.ENUMS.estadoSaude);
    if (!est) return semLeitura('o estado do arquivo está fora do esperado');
    if (est === 'indeterminado') return semLeitura('o vigia não conseguiu avaliar a sessão na última conferência');
    if (est === 'ativo' && verificadoMs === null) return semLeitura('o horário da conferência está ausente, inválido ou no futuro, então não dá para afirmar que o agente voltou');
    semLeituraAvisado.delete(ag.slug);
    if (est === 'ativo') return { caido: false };
    const tipo = U.dentro(d.tipo, U.ENUMS.tipoSaude) || 'desconhecido';
    const desdeMs = Date.parse(d.desde);
    return { caido: true, tipo, desdeMs: Number.isFinite(desdeMs) ? desdeMs : null, desdeAproximado: !Number.isFinite(desdeMs), verificadoMs, recomendacao: U.dentro(d.recomendacao, RECOMENDACOES) };
  }

  // ── texto ─────────────────────────────────────────────────────────────────
  // O nome vem do registro (texto livre do dono): sem caractere de controle e curto, para não quebrar a linha do log
  // nem o título do aviso no aparelho.
  const nomeLimpo = (ag) => String(ag.nome || ag.slug).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || ag.slug;
  const nomeMotor = (ag) => (ag.provedor === 'codex' ? 'Codex' : 'Claude');
  const minuscula = (t) => t.charAt(0).toLowerCase() + t.slice(1);

  /** Motivo em uma frase, em português, sem ponto final. Só usa texto fixo deste código. */
  function motivo(ag, tipo, verificadoMs) {
    if (tipo === 'vigia_parado') {
      const ha = Number.isFinite(verificadoMs) ? ` há ${U.duracaoCurta(agora() - verificadoMs)}` : '';
      return `o vigia da sessão dentro do container não confere${ha}, o container pode estar parado`;
    }
    const f = FRASES_SAUDE[tipo];
    const frase = f ? f[0] : (tipo === 'desconhecido' ? 'O vigia da sessão apontou um problema que ele mesmo não soube classificar.' : 'O vigia da sessão apontou um problema.');
    return minuscula(frase.replace(/\.$/, '').replace(/Claude/g, nomeMotor(ag)));
  }

  // Orientação fixa escrita aqui: a recomendação do arquivo só escolhe qual frase usar, nunca entra no texto.
  function oQueFazer(ag, tipo, rec) {
    const reiniciar = `rodar \`dgclaw agente reiniciar ${ag.slug}\``;
    if (tipo === 'vigia_parado') return `rodar \`dgclaw status\` e, se o container estiver parado, \`dgclaw agente iniciar ${ag.slug}\``;
    if (rec === 'modo_seguro') return 'colocar o agente em modo de segurança: abra a conversa dele no painel e use o botão de modo de segurança (passo a passo em docs/SAUDE-E-MODO-SEGURO.md)';
    if (rec === 'refazer_login' || tipo === 'login') return `refazer o login da conta do ${nomeMotor(ag)} deste agente, pela página Conectar conta do painel (menu, Conectar conta)`;
    if (tipo === 'limite') return 'esperar o limite do plano renovar ou conferir o plano da conta do agente';
    if (rec === 'esperar') return `esperar alguns minutos, porque isso costuma passar sozinho; se não passar, ${reiniciar}`;
    return reiniciar;
  }

  function textoCaiu(ag, reg) {
    const quando = U.quando(reg.desdeMs, tz);
    const desde = reg.desdeAproximado ? `pelo menos desde ${quando}` : `desde ${quando}`;
    const ha = U.duracaoCurta(agora() - reg.desdeMs);
    return `O agente ${nomeLimpo(ag)} (${ag.slug}) parou de responder: ${motivo(ag, reg.tipo, reg.verificadoMs)}. Está assim ${desde} (há ${ha}). ${AVISO_RETIDO} O que fazer: ${oQueFazer(ag, reg.tipo, reg.recomendacao)}.`;
  }

  function textoVoltou(ag, reg) {
    const hora = U.quando(reg.voltouEm, tz).replace(/^.* às /, '');
    const fora = U.duracaoCurta(reg.voltouEm - reg.desdeMs);
    return `${nomeLimpo(ag)} (${ag.slug}) voltou a responder normalmente às ${hora}. Ficou fora por ${fora} (motivo: ${motivo(ag, reg.tipo, null)}).`;
  }

  // ── canais ────────────────────────────────────────────────────────────────
  /** Devolve { entregue, canais:[...], falhas:[...] }. O aviso conta como entregue se qualquer canal entregou. */
  async function entrega(ag, tipoAviso, texto, titulo, corpoPush) {
    const canais = []; const falhas = [];
    try {
      const r = await push.enviar({ titulo, corpo: corpoPush, tag: `saude-retida-${ag.slug}`, url: `/a/${ag.slug}`, exigir_interacao: tipoAviso === 'caiu' });
      if (r && r.ok > 0) canais.push('push');
      else if (!r || !r.inscricoes) falhas.push('push: nenhum aparelho com avisos ativados');
      else falhas.push(`push: ${r.falhas && r.falhas.length ? (r.falhas[0].motivo || 'falha ao entregar') : 'não entregou a nenhum aparelho'}`);
    } catch (e) { falhas.push(`push: ${e.message}`); }

    if (comando) {
      if (!U.RX_NOME_SEGURO.test(ag.slug)) falhas.push('comando da equipe: o nome do agente não é seguro para passar ao comando, então não executei');
      else {
        // Ambiente mínimo de propósito: o painel carrega o web.env inteiro (hash da senha, SMTP e o que mais o dono
        // puser lá), e o comando da equipe não precisa enxergar nada disso. Credencial do canal fica num arquivo do
        // próprio script (docs/AVISO-DA-EQUIPE.md).
        const env = { DGCLAW_AVISO_TEXTO: texto, DGCLAW_AVISO_AGENTE: ag.slug, DGCLAW_AVISO_TIPO: tipoAviso };
        for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ']) if (process.env[k]) env[k] = process.env[k];
        let r;
        try { r = await executa({ cmd: comando, texto, env, timeoutMs: timeoutComandoMs || TIMEOUT_COMANDO_MS, log }); } catch (e) { r = { rc: null, signal: null, expirou: false, erroInicio: e.message }; }
        if (r.rc === 0) canais.push('comando da equipe');
        else {
          // O erro do comando não é registrado: pode conter a URL de um webhook com credencial.
          const como = r.erroInicio ? r.erroInicio : (r.expirou ? `passou de ${(timeoutComandoMs || TIMEOUT_COMANDO_MS) / 1000} s e foi encerrado` : `saiu com código ${r.rc === null ? 'desconhecido' : r.rc}${r.signal ? ` (sinal ${r.signal})` : ''}`);
          falhas.push(`comando da equipe: ${como}; rode o comando à mão como root para ver o erro`);
        }
      }
    }
    return { entregue: canais.length > 0, canais, falhas };
  }

  function registraLog(ag, tipoAviso, texto, r, repetido) {
    if (repetido && !r.entregue) return; // a falha completa já foi registrada na primeira tentativa
    const via = r.entregue ? `entregue por: ${r.canais.join(' e ')}` : `NÃO entregue a nenhum canal: ${r.falhas.join('; ')}. Tento de novo na próxima rodada`;
    log(tipoAviso === 'caiu' ? 'aviso' : 'info', `Vigia de saúde retida, aviso "${tipoAviso}" de ${ag.slug}: ${texto} [${via}]`);
  }

  async function avisaCaiu(ag, reg) {
    const texto = textoCaiu(ag, reg);
    const r = await entrega(ag, 'caiu', texto, `${nomeLimpo(ag)} parou de responder`, motivo(ag, reg.tipo, reg.verificadoMs).replace(/^./, (c) => c.toUpperCase()));
    registraLog(ag, 'caiu', texto, r, falhaLogada.has(ag.slug));
    if (r.entregue) { reg.avisoCaiuEntregue = true; reg.avisadoEm = agora(); falhaLogada.delete(ag.slug); } else falhaLogada.add(ag.slug);
  }

  /** Devolve true se algum canal entregou. */
  async function avisaVoltou(ag, reg) {
    const texto = textoVoltou(ag, reg);
    const r = await entrega(ag, 'voltou', texto, `${nomeLimpo(ag)} voltou ao normal`, 'Voltou a responder normalmente.');
    registraLog(ag, 'voltou', texto, r, voltouFalhaLogada.has(ag.slug));
    if (r.entregue) voltouFalhaLogada.delete(ag.slug); else voltouFalhaLogada.add(ag.slug);
    return r.entregue;
  }

  const registroLimpo = (ag) => ({ caido: false, tipo: null, desdeMs: null, avisoCaiuEntregue: false, avisadoEm: null, instancia: ag.instancia || null });

  // ── uma rodada ────────────────────────────────────────────────────────────
  async function olha(ag) {
    const retencao = lerRetencao(ag);
    if (retencao === 'ilegivel') return;
    if (retencao === 'nao') {
      if (estado.agentes[ag.slug]) { delete estado.agentes[ag.slug]; salva(); }
      semLeituraAvisado.delete(ag.slug); falhaLogada.delete(ag.slug); voltouFalhaLogada.delete(ag.slug);
      return;
    }
    const cls = classificar(ag);
    if (!cls) return;
    let prev = estado.agentes[ag.slug];
    // Agente recriado com o mesmo nome curto é outro agente: não herda o incidente do anterior.
    if (prev && (prev.instancia || null) !== (ag.instancia || null)) {
      log('info', `Vigia de saúde retida: ${ag.slug} tem outra instância no registro (foi recriado), então descartei o estado anterior dele e trato como a primeira vez.`);
      delete estado.agentes[ag.slug]; falhaLogada.delete(ag.slug); voltouFalhaLogada.delete(ag.slug);
      prev = undefined;
    }
    if (!cls.caido) {
      if (prev && prev.caido) {
        const entregueAntes = prev.avisoCaiuEntregue;
        estado.agentes[ag.slug] = Object.assign(registroLimpo(ag), { tipo: prev.tipo, avisadoEm: prev.avisadoEm || null });
        if (entregueAntes) {
          // A recuperação fica pendente em disco até algum canal entregar o "voltou" (inclusive depois de um reinício).
          estado.agentes[ag.slug].voltouPendente = { tipo: prev.tipo, desdeMs: prev.desdeMs, recomendacao: prev.recomendacao || null, voltouEm: agora() };
        } else log('info', `Vigia de saúde retida: ${ag.slug} voltou ao normal, mas o aviso de que tinha caído nunca chegou a nenhum canal, então não mandei o "voltou". Estado limpo.`);
        falhaLogada.delete(ag.slug);
        salva();
        prev = estado.agentes[ag.slug];
      } else if (!prev) {
        estado.agentes[ag.slug] = registroLimpo(ag);
        salva();
        return;
      }
      if (prev.voltouPendente) {
        if (await avisaVoltou(ag, prev.voltouPendente)) { delete prev.voltouPendente; salva(); }
      }
      return;
    }
    if (prev && prev.voltouPendente) {
      log('info', `Vigia de saúde retida: ${ag.slug} caiu de novo antes de o aviso "voltou" ser entregue. Descartei o "voltou" pendente e trato como uma queda nova.`);
      voltouFalhaLogada.delete(ag.slug);
      prev = undefined;
    }
    if (!prev || !prev.caido) {
      const reg = { caido: true, tipo: cls.tipo, desdeMs: cls.desdeMs !== null ? cls.desdeMs : agora(), desdeAproximado: cls.desdeAproximado, verificadoMs: cls.verificadoMs, recomendacao: cls.recomendacao, avisoCaiuEntregue: false, avisadoEm: null, instancia: ag.instancia || null };
      estado.agentes[ag.slug] = reg;
      await avisaCaiu(ag, reg);
      salva();
      return;
    }
    // caído -> caído: só atualiza tipo e recomendação; reenvia se o "caiu" nunca foi entregue a nenhum canal.
    let mudou = false;
    if (prev.tipo !== cls.tipo) { prev.tipo = cls.tipo; mudou = true; }
    if ((prev.recomendacao || null) !== cls.recomendacao) { prev.recomendacao = cls.recomendacao; mudou = true; }
    if (cls.verificadoMs !== null && prev.verificadoMs !== cls.verificadoMs && cls.tipo === 'vigia_parado') { prev.verificadoMs = cls.verificadoMs; mudou = true; }
    if (!prev.avisoCaiuEntregue) { await avisaCaiu(ag, prev); mudou = true; }
    if (mudou) salva();
  }

  async function tick() {
    if (emCurso) return;
    emCurso = true;
    try {
      carrega();
      const est = registro.estado();
      if (!est.ok) return;
      for (const ag of est.agentes) {
        if (!ag.home_host) continue;
        try { await olha(ag); } catch (e) {
          log('erro', `Vigia de saúde retida: falha inesperada ao olhar ${ag.slug} (${e.message}). Os outros agentes seguem sendo vigiados.`);
        }
      }
    } finally { emCurso = false; }
  }

  function iniciar() {
    if (timer || timerInicial) return;
    const rodar = () => { tick().catch((e) => log('erro', `Vigia de saúde retida: ${e.message}`)); };
    timerInicial = setTimeout(() => {
      timerInicial = null;
      rodar();
      timer = setInterval(rodar, intervaloMs || INTERVALO_MS);
      timer.unref();
    }, primeiraRodadaMs == null ? PRIMEIRA_RODADA_MS : primeiraRodadaMs);
    timerInicial.unref();
  }
  function parar() {
    if (timerInicial) { clearTimeout(timerInicial); timerInicial = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { tick, iniciar, parar };
}

module.exports = { criarVigiaSaudeRetida, estaRetido, executarComando, INTERVALO_MS, PRIMEIRA_RODADA_MS, VIGIA_PARADO_MS, TIMEOUT_COMANDO_MS };
