'use strict';
/**
 * wm-status.js: a saúde da memória de trabalho (working memory), para a aba Status.
 *
 * O PEDIDO (Danilo, 05/10/2026): ele abriu o painel e achou que o DG Claw não tinha
 * working memory, porque ela só aparecia na aba Memória, e na Status vinha com outro
 * nome ("Memória de curto prazo") mostrando só a linha "Agora". Esta rota responde,
 * numa leitura só, as perguntas que ele tinha: ela existe? está em dia? quando foi
 * atualizada? cabe no teto? a remontagem das 7h rodou hoje? o que está pendente?
 *
 *   GET /api/working-memory/status
 *
 * O conteúdo do arquivo continua na rota de sempre (GET /api/working-memory) e no
 * raio-X (GET /api/cerebro). Aqui sai só o estado, para a tela não precisar
 * adivinhar nada a partir do texto.
 *
 * DE ONDE VEM CADA NÚMERO (e é isso que o tooltip e o tutorial dizem):
 *
 *   atualizada    a linha "- **Agora:** segunda, 05/10/2026 15:16" que a máquina
 *                 reescreve (o batimento a cada 30 min, a remontagem às 7h). Sem essa
 *                 linha, a data em que o arquivo foi gravado pela última vez.
 *   tamanho       caracteres do arquivo, e os bytes (acento ocupa 2 bytes).
 *   teto          MAX_BYTES do scripts/build-working-memory.py do plugin instalado
 *                 (9000 hoje): acima dele, a remontagem das 7h encolhe as seções e
 *                 manda o excesso para memory/wm-transbordo.md. Lido do script, e não
 *                 copiado aqui, para o número da tela ser o número que corta.
 *                 E quanto dela chega ao começo de cada conversa: inteira, se o
 *                 CLAUDE.md importa @working-memory.md; senão, até o TETO do
 *                 hooks/session-context.sh (14000 caracteres em 05/10/2026).
 *   remontagem    1) o registro do pulso (.dgclaw/logs/pulso/AAAA-MM-DD.jsonl, linhas
 *                    id "build-wm"), que o build-wm.sh grava a cada rodada completa;
 *                 2) o systemd (timer dgclaw-<slug>-build-wm e o service dele);
 *                 3) um log configurado (config.wmRebuildLog), para quem roda por cron;
 *                 4) a marca "<!-- virada do dia: AAAA-MM-DD -->" que o build escreve.
 *                 Qualquer uma dizendo "rodou hoje" basta. Nenhuma legível = não medido.
 *   pendências    a linha "⚡ PENDÊNCIAS ATIVAS: ..." do topo do arquivo.
 *
 * NULL NÃO É ZERO. O que não deu para medir sai `null`, com o motivo, e a tela escreve
 * "não consegui ver". "Ausente" (o arquivo não existe), "vazia" (existe sem texto) e
 * "atrasada" (a remontagem não rodou ou ninguém mexe nela há horas) são três estados
 * diferentes, cada um com a causa e o que fazer.
 *
 * Este módulo não depende de nenhuma outra lib do painel, de propósito: ele é levado à
 * mão para painéis instalados antes da reorganização de 01/10 (Lara, Marina, Luna) e
 * para o painel da Isa, e precisa funcionar sozinho nos dois lugares.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TETO_BUILD_PADRAO = 9000; // MAX_BYTES de scripts/build-working-memory.py (05/10/2026)
const HORA_REMONTAGEM = 7; // o timer build-wm roda às 07:00 (scripts/install-timers.sh)
const FOLGA_MIN = 15; // depois das 07:15 sem registro, ela não rodou
const PARADA_HORAS = 6; // a linha "Agora" é refeita a cada 30 min; 6 h sem mexer é parada

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "2026-10-05" no fuso do dono. */
function diaLocal(d, offH) {
  return new Date(d.getTime() + offH * 3600e3).toISOString().slice(0, 10);
}

/** Hora e minuto locais no fuso do dono. */
function horaLocal(d, offH) {
  const l = new Date(d.getTime() + offH * 3600e3);
  return { h: l.getUTCHours(), m: l.getUTCMinutes() };
}

/** Data local (dia/mês/ano hora:min no fuso do dono) para Date de verdade. */
function deLocal(ano, mes, dia, h, m, offH) {
  return new Date(Date.UTC(ano, mes - 1, dia, h, m) - offH * 3600e3);
}

function hhmm(d, offH) {
  const { h, m } = horaLocal(d, offH);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function ddmm(d, offH) {
  const s = diaLocal(d, offH);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

/** "há 12 min", "há 3 h", "há 2 dias". */
function haQuanto(min) {
  if (min == null) return null;
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 48) return `há ${Math.floor(h)} h`;
  return `há ${Math.floor(h / 24)} dias`;
}

/** Lê o primeiro número de `NOME = 1234` num script. null se não achar. */
function numeroDoScript(arq, nome) {
  try {
    const t = fs.readFileSync(arq, 'utf8');
    const m = t.match(new RegExp(`^\\s*${nome}\\s*=\\s*(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** systemctl show, devolvendo {Prop: valor}. null se o systemctl não respondeu. */
function systemctlShow(unidade, props) {
  return new Promise((resolve) => {
    execFile('systemctl', ['show', unidade, '-p', props.join(',')], { timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      const r = {};
      for (const l of String(out).split('\n')) {
        const i = l.indexOf('=');
        if (i > 0) r[l.slice(0, i)] = l.slice(i + 1);
      }
      resolve(r);
    });
  });
}

/** "Mon 2026-10-05 07:00:02 -03" para Date. null se vazio ou ilegível. */
function dataDoSystemd(s) {
  if (!s || s === 'n/a' || s === '0') return null;
  const m = s.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] || '00'}`);
  return isNaN(d) ? null : d;
}

function buildWmStatus(config, opcoes = {}) {
  const AGENT_DIR = config.agentDir;
  const OFF = typeof config.timezoneOffsetHours === 'number' ? config.timezoneOffsetHours : -3;
  const SLUG = config.agentSlug || 'agente';
  const PULSO_DIR = config.pulsoDir || path.join(AGENT_DIR, '.dgclaw', 'logs', 'pulso');
  const PLUGIN = config.pluginDir || path.join(AGENT_DIR, '.dgclaw', 'plugin');
  const agora = opcoes.agora || (() => new Date());
  const show = opcoes.systemctl || systemctlShow;
  const HORA = Number.isInteger(config.wmRebuildHora) ? config.wmRebuildHora : HORA_REMONTAGEM;

  function arquivoWm() {
    const cands = [path.join(AGENT_DIR, 'working-memory.md'), path.join(AGENT_DIR, 'persona', 'working-memory.md')];
    for (const c of cands) {
      try { if (fs.existsSync(c)) return c; } catch { /* ilegível conta como ausente */ }
    }
    return null;
  }

  /** O teto da remontagem, com de onde ele veio. */
  function tetoBuild(texto) {
    if (Number.isInteger(config.wmTetoBytes)) {
      return { bytes: config.wmTetoBytes, fonte: 'configurado no painel (config.json, wmTetoBytes)' };
    }
    const n = numeroDoScript(path.join(PLUGIN, 'scripts', 'build-working-memory.py'), 'MAX_BYTES');
    if (n) return { bytes: n, fonte: 'MAX_BYTES do scripts/build-working-memory.py instalado neste agente' };
    // A working memory da Isa (ClaudeClaw) escreve o próprio teto no cabeçalho:
    // "*Ocupação: 5123B/6500B*".
    const m = texto && texto.match(/Ocupa[çc][ãa]o:\s*\d+\s*B?\s*\/\s*(\d+)\s*B/i);
    if (m) return { bytes: Number(m[1]), fonte: 'a linha "Ocupação" do cabeçalho do próprio arquivo' };
    return { bytes: TETO_BUILD_PADRAO, fonte: 'o valor de fábrica do plugin (MAX_BYTES = 9000); não achei o script instalado para conferir' };
  }

  /**
   * Quanto da memória chega ao começo de cada conversa. Desde 05/10/2026 o CLAUDE.md
   * do agente importa o arquivo inteiro (`@working-memory.md`), e aí não há corte. Sem
   * o import, quem reinjeta é o hooks/session-context.sh, que corta no TETO dele.
   */
  function tetoHook() {
    let claudeMd = '';
    try { claudeMd = fs.readFileSync(path.join(AGENT_DIR, 'CLAUDE.md'), 'utf8'); } catch { /* sem CLAUDE.md */ }
    if (/^@(persona\/)?working-memory\.md\s*$/m.test(claudeMd)) {
      return { caracteres: null, inteira: true, fonte: 'o CLAUDE.md dele importa o arquivo inteiro (@working-memory.md), sem corte' };
    }
    const n = numeroDoScript(path.join(PLUGIN, 'hooks', 'session-context.sh'), 'TETO');
    if (n) return { caracteres: n, inteira: false, fonte: 'TETO do hooks/session-context.sh instalado neste agente' };
    return { caracteres: null, inteira: null, fonte: 'não achei o import no CLAUDE.md nem o hooks/session-context.sh: não sei quanto dela chega ao começo da conversa' };
  }

  /** A linha "- **Agora:** segunda, 05/10/2026 15:16". */
  function linhaAgora(texto) {
    const m = texto.match(/\*\*Agora:\*\*[^\n]*?(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = deLocal(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), OFF);
    return isNaN(d) ? null : d;
  }

  function pendencias(texto) {
    const m = texto.match(/^\s*⚡\s*PEND[ÊE]NCIAS\s+ATIVAS\s*:?\s*(.*)$/mi);
    if (!m) return { existe: false, texto: null, nenhuma: null };
    const t = m[1].trim();
    const nenhuma = !t || /^\(?\s*nenhuma/i.test(t);
    return { existe: true, texto: t, nenhuma };
  }

  /** Entradas build-wm do registro do pulso num dia. null = registro ilegível/inexistente. */
  function pulsoDoDia(dia) {
    const arq = path.join(PULSO_DIR, `${dia}.jsonl`);
    let t;
    try { t = fs.readFileSync(arq, 'utf8'); } catch { return null; }
    const r = [];
    for (const l of t.split('\n')) {
      if (!l.includes('build-wm')) continue;
      try {
        const o = JSON.parse(l);
        if (o.id === 'build-wm' && o.ts) r.push({ em: new Date(o.ts), ok: o.status === 'ok', detalhe: o.detalhe || '' });
      } catch { /* linha quebrada: pula, as outras valem */ }
    }
    return r;
  }

  async function remontagem(texto, agoraD) {
    const hoje = diaLocal(agoraD, OFF);
    const ontem = diaLocal(new Date(agoraD.getTime() - 86400e3), OFF);
    const prazo = deLocal(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)), Number(hoje.slice(8, 10)), HORA, FOLGA_MIN, OFF);
    const horaDela = deLocal(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)), Number(hoje.slice(8, 10)), HORA, 0, OFF);
    const jaEraHora = agoraD >= prazo;
    const fontes = [];
    const rodadas = [];

    // 1) o registro do pulso
    let pulsoLegivel = false;
    try { pulsoLegivel = fs.statSync(PULSO_DIR).isDirectory(); } catch { /* sem pulso */ }
    if (pulsoLegivel) {
      fontes.push('registro do pulso');
      for (const dia of [ontem, hoje]) for (const e of pulsoDoDia(dia) || []) rodadas.push({ ...e, fonte: 'registro do pulso' });
    }

    // 2) o systemd
    const unidade = `dgclaw-${SLUG}-build-wm`;
    const timer = { unidade: `${unidade}.timer`, existe: null, instaladoEm: null, proxima: null };
    const t = await show(`${unidade}.timer`, ['LoadState', 'ActiveState', 'ActiveEnterTimestamp', 'NextElapseUSecRealtime']);
    if (t && t.LoadState) {
      timer.existe = t.LoadState === 'loaded';
      if (timer.existe) {
        fontes.push('systemd');
        const inst = dataDoSystemd(t.ActiveEnterTimestamp);
        timer.instaladoEm = inst ? inst.toISOString() : null;
        const prox = dataDoSystemd(t.NextElapseUSecRealtime);
        timer.proxima = prox ? prox.toISOString() : null;
        const s = await show(`${unidade}.service`, ['ExecMainExitTimestamp', 'ExecMainStatus', 'Result']);
        const fim = s && dataDoSystemd(s.ExecMainExitTimestamp);
        if (fim) rodadas.push({ em: fim, ok: s.ExecMainStatus === '0' && s.Result === 'success', detalhe: s.ExecMainStatus !== '0' ? `saiu com código ${s.ExecMainStatus}` : '', fonte: 'systemd' });
      }
    }

    // 3) log configurado (quem roda a remontagem por cron, como a Isa)
    if (config.wmRebuildLog) {
      try {
        const st = fs.statSync(config.wmRebuildLog);
        fontes.push('log da remontagem');
        rodadas.push({ em: st.mtime, ok: true, detalhe: '', fonte: 'log da remontagem' });
      } catch { /* log ainda não existe: fica de fora */ }
    }

    // 4) a marca que o próprio build escreve no arquivo
    const marca = texto && texto.match(/<!--\s*virada do dia:\s*(\d{4}-\d{2}-\d{2})\s*-->/);
    if (marca) {
      fontes.push('marca no arquivo');
      const [a, mm, d] = marca[1].split('-').map(Number);
      // Só a data: conta como rodada às 7h daquele dia.
      rodadas.push({ em: deLocal(a, mm, d, HORA, 0, OFF), ok: true, detalhe: '', fonte: 'marca no arquivo', soData: true });
    }

    rodadas.sort((x, y) => y.em - x.em);
    const deHoje = rodadas.filter((r) => diaLocal(r.em, OFF) === hoje && r.em >= horaDela - 60e3);
    const okHoje = deHoje.find((r) => r.ok);
    const ultima = rodadas[0] || null;
    const proxima = timer.proxima || (jaEraHora ? new Date(horaDela.getTime() + 86400e3) : horaDela).toISOString();

    const base = {
      fontes,
      timer,
      proxima,
      ultima: ultima ? { em: ultima.em.toISOString(), ok: ultima.ok, detalhe: ultima.detalhe, fonte: ultima.fonte, soData: !!ultima.soData } : null,
    };
    const quandoUltima = ultima ? (ultima.soData ? `em ${ddmm(ultima.em, OFF)}` : `${diaLocal(ultima.em, OFF) === hoje ? 'hoje' : (diaLocal(ultima.em, OFF) === ontem ? 'ontem' : `em ${ddmm(ultima.em, OFF)}`)} às ${hhmm(ultima.em, OFF)}`) : null;

    if (!fontes.length) {
      return { ...base, rodouHoje: null, falhou: false, frase: 'Não consigo ver se a remontagem das 7h rodou: este agente não tem registro do pulso, timer nem log da remontagem que eu consiga ler.' };
    }
    if (okHoje) {
      const quando = okHoje.soData ? 'hoje' : `hoje às ${hhmm(okHoje.em, OFF)}`;
      return { ...base, rodouHoje: true, falhou: false, frase: `Rodou ${quando}.` };
    }
    const falhaHoje = deHoje.find((r) => !r.ok);
    if (falhaHoje) {
      return { ...base, rodouHoje: false, falhou: true, frase: `Rodou hoje às ${hhmm(falhaHoje.em, OFF)} e falhou${falhaHoje.detalhe ? ` (${falhaHoje.detalhe})` : ''}.` };
    }
    if (!jaEraHora) {
      return { ...base, rodouHoje: null, falhou: false, frase: `A de hoje roda às ${String(HORA).padStart(2, '0')}:00.${quandoUltima ? ` A última foi ${quandoUltima}.` : ''}` };
    }
    // Timer instalado hoje depois da hora: ainda não teve chance de rodar.
    const inst = timer.instaladoEm ? new Date(timer.instaladoEm) : null;
    if (inst && inst > horaDela && diaLocal(inst, OFF) === hoje) {
      return { ...base, rodouHoje: null, falhou: false, frase: `O timer foi ligado (ou religado) hoje às ${hhmm(inst, OFF)}, depois das ${HORA}h: a próxima remontagem é amanhã às ${String(HORA).padStart(2, '0')}:00.` };
    }
    if (timer.existe === false && !rodadas.length) {
      return { ...base, rodouHoje: false, falhou: false, semTimer: true, frase: 'Não rodou hoje, e o timer da remontagem não está instalado neste agente.' };
    }
    return { ...base, rodouHoje: false, falhou: false, frase: `Não rodou hoje.${quandoUltima ? ` A última foi ${quandoUltima}.` : ''}` };
  }

  async function status() {
    const agoraD = agora();
    const arq = arquivoWm();
    const geradoEm = agoraD.toISOString();
    const relativo = arq ? path.relative(AGENT_DIR, arq) : 'working-memory.md';

    if (!arq) {
      const rem = await remontagem('', agoraD);
      return {
        estado: 'ausente',
        frase: 'Ele não tem memória de trabalho: o arquivo working-memory.md não existe na pasta dele.',
        causa: 'O arquivo nasce na instalação e é remontado todo dia às 7h. Se ele não existe, a instalação não criou, ou alguém apagou.',
        oQueFazer: rem.rodouHoje === null && rem.timer.existe
          ? 'Se o agente é novo, espere a primeira remontagem (amanhã às 7h). Se ele já trabalhava, avise quem instalou: é preciso rodar a remontagem (build-wm) uma vez.'
          : 'Avise quem instalou: é preciso rodar a remontagem da memória (build-wm) uma vez. Sem ela, ele começa cada conversa sem lembrar o que estava fazendo.',
        arquivo: { caminho: relativo, existe: false, caracteres: null, bytes: null, gravadoEm: null },
        atualizadaEm: null, atualizadaFonte: null, idadeMin: null, idadeTexto: null,
        teto: tetoBuild(''), tetoInicioSessao: tetoHook(), ocupacaoPct: null,
        remontagem: rem, pendencias: { existe: false, texto: null, nenhuma: null },
        geradoEm,
      };
    }

    let texto = '';
    let gravadoEm = null;
    try {
      texto = fs.readFileSync(arq, 'utf8');
      gravadoEm = fs.statSync(arq).mtime;
    } catch (e) {
      const err = new Error(`não consegui ler ${relativo}: ${e.code || e.message}`);
      err.howToFix = 'O painel precisa de permissão de leitura na pasta do agente. Avise quem instalou.';
      throw err;
    }

    const caracteres = [...texto].length;
    const bytes = Buffer.byteLength(texto, 'utf8');
    const teto = tetoBuild(texto);
    const tetoHk = tetoHook();
    const ocupacaoPct = teto.bytes ? Math.round((bytes / teto.bytes) * 100) : null;
    const dAgora = linhaAgora(texto);
    const atualizadaEm = dAgora || gravadoEm;
    const atualizadaFonte = dAgora ? 'a linha "Agora" do arquivo' : 'a data em que o arquivo foi gravado';
    const idadeMin = atualizadaEm ? Math.max(0, (agoraD - atualizadaEm) / 60000) : null;
    const rem = await remontagem(texto, agoraD);
    const pend = pendencias(texto);

    const avisos = [];
    if (ocupacaoPct != null && ocupacaoPct > 100) {
      avisos.push(`Passou do teto (${ocupacaoPct}%). Na próxima remontagem, o que sobrar vai para memory/wm-transbordo.md, que continua pesquisável: nada se perde.`);
    }
    if (tetoHk.caracteres != null && caracteres > tetoHk.caracteres) {
      avisos.push(`Tem mais de ${tetoHk.caracteres.toLocaleString('pt-BR')} caracteres: no começo de cada conversa ele recebe só esse tanto, e o fim fica para ele ler no arquivo se precisar.`);
    }

    let estado = 'em-dia';
    let frase;
    let causa = null;
    let oQueFazer = null;
    const idade = haQuanto(idadeMin);

    if (!texto.trim()) {
      estado = 'vazia';
      frase = 'O arquivo da memória de trabalho existe, mas está vazio.';
      causa = 'Ninguém escreveu nele ainda, ou uma gravação falhou no meio.';
      oQueFazer = rem.rodouHoje === true
        ? 'A remontagem de hoje rodou e mesmo assim ficou vazio: avise quem instalou.'
        : 'A remontagem das 7h preenche o arquivo. Se amanhã ele continuar vazio, avise quem instalou.';
    } else if (rem.falhou) {
      estado = 'atrasada';
      frase = 'A remontagem de hoje falhou: ele está usando a memória de ontem.';
      causa = rem.frase;
      oQueFazer = 'Na aba Operações, a linha da remontagem da memória mostra o erro. Se repetir amanhã, mande esse erro para quem instalou.';
    } else if (rem.rodouHoje === false) {
      estado = 'atrasada';
      frase = 'A remontagem das 7h não rodou hoje: as seções de ontem não foram viradas.';
      causa = rem.semTimer ? 'O timer da remontagem não está instalado neste agente.' : rem.frase;
      oQueFazer = rem.semTimer
        ? 'Avise quem instalou: falta instalar os timers do agente (install-timers.sh).'
        : 'Ele continua trabalhando com a memória que tem. Se amanhã ela também não rodar, avise quem instalou e mostre a aba Operações.';
    } else if (idadeMin != null && idadeMin > PARADA_HORAS * 60) {
      estado = 'atrasada';
      frase = `Ninguém mexe na memória de trabalho ${idade}.`;
      causa = 'A linha "Agora" é refeita a cada 30 minutos pelo batimento dele. Parada por tanto tempo quer dizer que o batimento não está rodando.';
      oQueFazer = 'Veja na aba Operações se o batimento está verde. Se estiver vermelho ou parado, avise quem instalou.';
    } else {
      frase = `Atualizada ${idade || 'há pouco'}`
        + (rem.rodouHoje === true ? ` e remontada ${rem.frase.replace(/^Rodou /, '').replace(/\.$/, '')}.` : '.');
    }

    return {
      estado, frase, causa, oQueFazer, avisos,
      arquivo: { caminho: relativo, existe: true, caracteres, bytes, gravadoEm: gravadoEm ? gravadoEm.toISOString() : null },
      atualizadaEm: atualizadaEm ? atualizadaEm.toISOString() : null,
      atualizadaTexto: atualizadaEm ? `${DIAS[new Date(atualizadaEm.getTime() + OFF * 3600e3).getUTCDay()]}, ${ddmm(atualizadaEm, OFF)} às ${hhmm(atualizadaEm, OFF)}` : null,
      atualizadaFonte, idadeMin: idadeMin == null ? null : Math.round(idadeMin), idadeTexto: idade,
      teto, tetoInicioSessao: tetoHk, ocupacaoPct,
      remontagem: rem, pendencias: pend,
      geradoEm,
    };
  }

  return { status };
}

/** Pendura GET /api/working-memory/status no roteador do painel. */
function registrar(router, { CONFIG }) {
  const wm = buildWmStatus(CONFIG);
  router.get('/api/working-memory/status', async (req, res) => {
    try {
      res.json(await wm.status());
    } catch (e) {
      console.error('[painel] /api/working-memory/status quebrou:', e);
      res.status(500).json({
        error: `Não consegui ver a memória de trabalho: ${e.message}`,
        howToFix: e.howToFix || 'Recarregue a página. Se continuar, o registro do painel diz o motivo.',
      });
    }
  });
}

module.exports = { buildWmStatus, registrar };
