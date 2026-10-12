'use strict';
/**
 * operacoes.js: a aba Operações, com uma fileira de quadradinhos por operação.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POR QUE ESTE ARQUIVO EXISTE (Danilo, 01/10/2026)                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * O painel tinha duas abas para a mesma pergunta: "Operações" (o que está
 * marcado) e "Pulso" (se rodou certo). O próprio Danilo, que mandou construir as
 * duas, não sabia dizer a diferença. Agora é uma aba só, desenhada como uma
 * página de status: cada operação aparece UMA vez, com o nome, a cadência e uma
 * fileira de quadradinhos das últimas execuções. Verde rodou e deu certo,
 * vermelho falhou, amarelo pede atenção (não rodou quando devia, foi cancelada,
 * ou o registro dela disse que algo saiu torto), cinza é sem dado.
 *
 * DE ONDE VEM CADA QUADRADINHO. Do diário do systemd (o journal), que guarda
 * uma linha por fim de execução de cada unidade, com o resultado. É a única fonte
 * que cobre TODAS as rotinas: o ledger do pulso só tem o que cada script decidiu
 * anotar, e várias rotinas (vigia, arrumação da conversa, recibo dos recados,
 * aviso de orçamento, medidor de consumo) não anotam nada lá.
 *
 *   MESSAGE_ID 39f53479...  "Finished X"       JOB_RESULT=done   rodou e terminou bem
 *   MESSAGE_ID be02cf68...  "Failed to start X" JOB_RESULT=failed falhou
 *   MESSAGE_ID 7d4958e8...  "Starting X"        começo da execução (para medir a duração)
 *   MESSAGE_ID 9d1aaa27...  "Stopped X"         serviço contínuo parou
 *   MESSAGE_ID d9b373ed...  "X: Failed with result ..."  serviço contínuo caiu
 *
 * ARMADILHA QUE CUSTOU UMA FALHA INVISÍVEL: a primeira validação desta fonte
 * pedia só o 39f53479. Execução que FALHA não sai com esse id, sai com o
 * be02cf68. Filtrando só o primeiro, toda falha some e a fileira fica verde com a
 * rotina quebrada, que é exatamente o tipo de alarme que esta tela existe para
 * não ser. Conferido no diário desta máquina em 01/10/2026: os "Failed to start"
 * de uma rotina marcada vinham todos com o be02cf68.
 *
 * O LEDGER ENTRA COMO SEGUNDA OPINIÃO. Um script pode terminar com código 0 e
 * mesmo assim ter anotado `erro` no ledger (ele pegou a exceção, registrou e saiu
 * "limpo"). Para o systemd foi sucesso; para quem lê, falhou. Então, se o job
 * terminou bem mas o ledger diz erro naquele intervalo, o quadradinho é VERMELHO
 * com o detalhe do ledger. Se diz aviso, é amarelo.
 *
 * AMARELO DE "NÃO RODOU QUANDO DEVIA" é inferido da cadência do timer:
 *   - timer de intervalo ("a cada 30 min"): um buraco maior que duas vezes o
 *     intervalo entre duas execuções vira um quadradinho amarelo no meio;
 *   - timer de calendário que eu entendo ("todo dia às 23:30", "de segunda a
 *     sexta às 9h"): cada horário esperado sem execução por perto vira amarelo.
 *   Horário de calendário que eu não entendo NÃO gera amarelo nenhum: inventar
 *   atraso de uma rotina cujo horário eu não sei ler seria acusar sem prova.
 *   Também não acuso nada antes da primeira execução que o diário conhece: o
 *   diário pode ter sido rodado, e a rotina pode ter sido instalada ontem.
 *
 * NULL NUNCA VIRA VERDE. Sem diário (sem permissão, sem journalctl), a operação
 * aparece com a fileira cinza e o motivo escrito, e o resumo do topo diz que não
 * conseguiu ler, em vez de "tudo funcionando".
 *
 * As rotinas MARCADAS PELO DONO (dgclaw-<slug>-self-*) ficam FORA da lista do
 * sistema: elas são do usuário e aparecem na aba Status (ver `rotinasDoUsuario`).
 *
 * O "o que é / pra que serve" de cada operação NÃO mora aqui: vem do CATALOGO do
 * scripts/pulso-status.py, através do /api/pulso (lib/pulso.js). Este arquivo só
 * decide o AGRUPAMENTO por propósito, que é coisa desta tela.
 *
 * O journalctl de sete dias leva perto de meio segundo e devolve milhares de
 * linhas, então o resultado fica em cache por 45 s e chamadas simultâneas
 * dividem a mesma leitura.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const rotinasLib = require('./rotinas');

const ID = {
  TERMINOU: '39f53479d3a045ac8e11786248231fbf',
  FALHOU_AO_RODAR: 'be02cf6855d2428ba40df7e9d022f03d',
  COMECOU: '7d4958e842da4a758f6c1cdc7b36dcc5',
  PAROU: '9d1aaa27d60140bd96365438aad20286',
  CAIU: 'd9b373ed55a64feb8242e02dbe79a49c',
};

const CACHE_MS = 45000;
const DIAS = 7;
// Quantos quadradinhos cada operação manda para a tela. A tela mostra quantos
// couberem (os mais recentes à direita); mandar mais que isto seria peso morto.
const MAX_QUADRADOS = 48;
// Serviço contínuo: um quadradinho por hora, nas últimas 48 horas.
const HORAS_DE_SERVICO = 48;

/**
 * O AGRUPAMENTO POR PROPÓSITO, em linguagem de quem não é técnico.
 *
 * A chave é o sufixo da unidade (dgclaw-<slug>-<sufixo>) ou o nome que o
 * pulso-status dá aos serviços ("canal (runtime)", "painel"). Operação que não
 * está aqui cai em "Outras rotinas do sistema", e isso é melhor do que encaixar à
 * força num grupo que diz outra coisa.
 */
const GRUPOS = [
  {
    id: 'de-pe',
    titulo: 'Mantém ele de pé',
    explica: 'As peças que fazem ele estar ligado e respondendo: o processo onde ele pensa, '
      + 'o vigia que o religa quando trava, o batimento que confere se ele responde e o '
      + 'recibo dos recados automáticos.',
    membros: ['canal (runtime)', 'watchdog', 'channel-watchdog', 'heartbeat', 'poke-verify', 'painel'],
  },
  {
    id: 'memoria',
    titulo: 'Memória',
    explica: 'O que faz ele lembrar de vocês: a reflexão da noite, o conferente dela, a '
      + 'remontagem da memória de trabalho de manhã, o fichário das conversas e a arrumação '
      + 'da conversa quando ela fica comprida demais.',
    membros: ['reflection', 'audit', 'build-wm', 'auto-compact', 'consolidate', 'conversas-fts'],
  },
  {
    id: 'vigilancia',
    titulo: 'Vigilância e custos',
    explica: 'O que fica de olho no resto: quanto ele gasta, se as rotinas continuam '
      + 'instaladas, e o resumo do dia que chega para você no seu canal.',
    membros: ['cost-alerts', 'channels-tokens-logger', 'cron-audit', 'security-audit',
      'openrouter-credit-alert', 'pulso-report-1', 'pulso-report-2', 'pulso-report-3'],
  },
];
const GRUPO_PODERES = {
  id: 'poderes',
  titulo: 'Poderes instalados',
  explica: 'As rotinas que vêm junto com cada poder que você ligou (por exemplo, publicar no Instagram).',
};
const GRUPO_OUTRAS = {
  id: 'outras',
  titulo: 'Outras rotinas do sistema',
  explica: 'Rotinas do sistema que esta tela ainda não sabe agrupar. Elas são medidas igual às outras.',
};

// ─── utilidades de tempo ────────────────────────────────────────────────────

/** "30min", "1h 30min", "5min", "1d", "2w", "45s" (formato do systemd) em ms. null se não entender. */
function duracaoMs(texto) {
  if (!texto) return null;
  const unidades = {
    us: 1e-3, usec: 1e-3, ms: 1, msec: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, minute: 60000, minutes: 60000,
    h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000,
    w: 604800000, week: 604800000, weeks: 604800000,
  };
  let total = 0;
  let achou = false;
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let m;
  while ((m = re.exec(String(texto)))) {
    const u = unidades[m[2].toLowerCase()];
    if (!u) return null;
    total += Number(m[1]) * u;
    achou = true;
  }
  return achou && total > 0 ? total : null;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** "Mon..Fri", "Mon,Wed,Fri", "Sat" num conjunto de dias da semana (0 = domingo). null se não entender. */
function diasDaSemana(texto) {
  const dias = new Set();
  for (const parte of texto.split(',')) {
    const faixa = parte.match(/^([A-Z][a-z]{2})(?:\.\.([A-Z][a-z]{2}))?$/);
    if (!faixa || !(faixa[1] in DOW) || (faixa[2] && !(faixa[2] in DOW))) return null;
    const ini = DOW[faixa[1]];
    const fim = faixa[2] ? DOW[faixa[2]] : ini;
    for (let d = ini; ; d = (d + 1) % 7) {
      dias.add(d);
      if (d === fim) break;
    }
  }
  return dias;
}

/**
 * Os horários em que um timer de CALENDÁRIO devia ter rodado entre `desde` e `ate`.
 *
 * Só entende as formas que o plugin e o persona-cron-mgr realmente escrevem:
 *   *-*-* HH:MM[:SS]            todo dia
 *   Dow[..Dow][,Dow] *-*-* HH:MM  certos dias da semana
 *   *-*-DD HH:MM               um dia fixo do mês
 *   daily / weekly / hourly
 * com ou sem o fuso no fim ("America/Sao_Paulo"). O fuso é ignorado e a hora é
 * lida no horário desta máquina, que é o mesmo do systemd que dispara o timer
 * (o painel roda junto dele, no mesmo container). Qualquer outra forma devolve
 * null, e null quer dizer "não sei", nunca "não devia rodar".
 */
function horariosEsperados(spec, desde, ate) {
  if (!spec) return null;
  let s = String(spec).trim().replace(/\s+(?:[A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?|UTC)$/, '');
  if (s === 'daily') s = '*-*-* 00:00:00';
  if (s === 'weekly') s = 'Mon *-*-* 00:00:00';
  const saida = [];
  if (s === 'hourly') {
    const d = new Date(desde);
    d.setMinutes(0, 0, 0);
    for (let t = d.getTime(); t <= ate; t += 3600000) if (t >= desde) saida.push(t);
    return saida;
  }
  const m = s.match(/^(?:([A-Za-z.,]+)\s+)?\*-\*-(\*|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const dias = m[1] ? diasDaSemana(m[1]) : null;
  if (m[1] && !dias) return null;
  const diaDoMes = m[2] === '*' ? null : Number(m[2]);
  const [hh, mm, ss] = [Number(m[3]), Number(m[4]), Number(m[5] || 0)];
  const d = new Date(desde);
  d.setHours(0, 0, 0, 0);
  for (; d.getTime() <= ate; d.setDate(d.getDate() + 1)) {
    if (dias && !dias.has(d.getDay())) continue;
    if (diaDoMes != null && d.getDate() !== diaDoMes) continue;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss).getTime();
    if (t >= desde && t <= ate) saida.push(t);
  }
  return saida;
}

/** O intervalo de um timer de intervalo ("cada:30min" das rotinas.js) em ms, ou null. */
function intervaloDoTimer(horario) {
  const m = String(horario || '').match(/^cada:(.+)$/);
  return m ? duracaoMs(m[1]) : null;
}

/** "há 3 min", "há 2 h", "há 3 dias": para a frase de cada operação. */
function haQuanto(ms, agora) {
  const s = Math.max(0, (agora - ms) / 1000);
  if (s < 90) return 'agora há pouco';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400 * 1.5) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}

function duracaoHumana(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function listaHumana(nomes) {
  if (nomes.length <= 1) return nomes.join('');
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

// ─── o que o JOB_RESULT quer dizer, em português ──────────────────────────────

const RESULTADO = {
  done: { cor: 'verde', titulo: 'Rodou e deu certo' },
  failed: { cor: 'vermelho', titulo: 'Falhou: o programa terminou com erro' },
  timeout: { cor: 'vermelho', titulo: 'Falhou: passou do tempo máximo e foi interrompida' },
  dependency: { cor: 'vermelho', titulo: 'Não rodou: uma peça de que ela depende falhou antes' },
  canceled: { cor: 'amarelo', titulo: 'Foi cancelada antes de terminar (normalmente por um reinício do sistema)' },
  skipped: { cor: 'amarelo', titulo: 'Não rodou: a condição para começar não foi atendida' },
  assert: { cor: 'vermelho', titulo: 'Não rodou: uma checagem obrigatória falhou' },
  invalid: { cor: 'vermelho', titulo: 'Não rodou: a configuração dela está inválida' },
  unsupported: { cor: 'vermelho', titulo: 'Não rodou: o sistema não sabe executar este tipo de rotina' },
};

/** Status do ledger do pulso traduzido em cor. Desconhecido = null (não muda o quadradinho). */
function corDoLedger(status) {
  const s = String(status || '').toLowerCase();
  if (['erro', 'error', 'fail', 'failed', 'falhou', 'faltou', 'missing'].includes(s)) return 'vermelho';
  if (['aviso', 'atencao', 'atenção', 'warn', 'warning', 'parcial', 'partial', 'pulado', 'skip', 'skipped'].includes(s)) return 'amarelo';
  if (['ok', 'success', 'done', 'rodou', 'completed'].includes(s)) return 'verde';
  return null;
}

// ─── o leitor do diário ─────────────────────────────────────────────────────

function executarPadrao(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
        erro: err ? (err.code === 'ENOENT' ? 'ENOENT' : String(err.message || err)) : null,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

/**
 * Lê do diário os eventos de começo, fim, falha e parada das unidades pedidas.
 * Nunca rejeita: devolve { eventos, motivo }, e `motivo` preenchido quer dizer que
 * a leitura NÃO aconteceu (e não que não houve evento).
 */
async function lerDiario(executar, padroes, desdeMs) {
  const args = ['-o', 'json', '--no-pager', '--quiet', `--since=@${Math.floor(desdeMs / 1000)}`];
  for (const p of padroes) args.push('-u', p);
  for (const id of Object.values(ID)) args.push(`MESSAGE_ID=${id}`);
  args.push('--output-fields=UNIT,JOB_RESULT,JOB_TYPE,MESSAGE_ID,UNIT_RESULT');

  const r = await executar('journalctl', args, {});
  if (r.erro === 'ENOENT') {
    return { eventos: [], motivo: 'esta máquina não tem o journalctl, então não há diário do sistema para ler o histórico' };
  }
  const queixa = `${r.stderr}`;
  if (/insufficient permissions|No journal files were opened|not seeing messages from other users/i.test(queixa) && !r.stdout.trim()) {
    return {
      eventos: [],
      motivo: 'o painel não tem permissão para ler o diário do sistema (journal). '
        + 'Quem cuida da máquina resolve colocando o usuário do painel no grupo "systemd-journal".',
    };
  }
  if (!r.ok && !r.stdout.trim()) {
    return { eventos: [], motivo: `o journalctl não respondeu (${(queixa || r.erro || 'sem detalhe').trim().slice(0, 200)})` };
  }
  const eventos = [];
  let ruins = 0;
  for (const linha of r.stdout.split('\n')) {
    if (!linha.trim()) continue;
    let o;
    try { o = JSON.parse(linha); } catch { ruins++; continue; }
    const t = Number(o.__REALTIME_TIMESTAMP) / 1000;
    if (!o.UNIT || !Number.isFinite(t)) continue;
    eventos.push({ unit: o.UNIT, t, id: o.MESSAGE_ID, jobResult: o.JOB_RESULT || null, jobType: o.JOB_TYPE || null, unitResult: o.UNIT_RESULT || null });
  }
  if (ruins) console.warn(`[operacoes] ${ruins} linha(s) do journalctl nao eram JSON e foram puladas.`);
  eventos.sort((a, b) => a.t - b.t);
  return { eventos, motivo: null };
}

// ─── o ledger do pulso ──────────────────────────────────────────────────────

/**
 * As linhas do ledger dos últimos dias, nos dois formatos que existem por aí:
 * o novo da pulso_lib ({ts, id, status, detalhe}) e o antigo ({timestamp,
 * component, status, detail}). Arquivo ausente é normal (agente novo); arquivo
 * ilegível é avisado no log do painel e o cruzamento segue sem ele.
 */
function lerLedger(pulsoDir, desdeMs) {
  const saida = [];
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(pulsoDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[operacoes] nao consegui listar o ledger do pulso em ${pulsoDir} (${e.code}). Sigo sem a segunda opiniao.`);
    return saida;
  }
  const corteDia = new Date(desdeMs - 86400000).toISOString().slice(0, 10);
  for (const f of arquivos) {
    if (f.slice(0, 10) < corteDia) continue;
    let texto;
    try { texto = fs.readFileSync(path.join(pulsoDir, f), 'utf8'); } catch (e) {
      console.warn(`[operacoes] nao consegui ler ${f} do ledger (${e.code}).`);
      continue;
    }
    for (const linha of texto.split('\n')) {
      if (!linha.trim()) continue;
      let o;
      try { o = JSON.parse(linha); } catch { continue; }
      const id = o.id || o.component || o.name;
      const t = Date.parse(o.ts || o.timestamp || '');
      if (!id || !Number.isFinite(t) || t < desdeMs - 3600000) continue;
      saida.push({ id: String(id), t, status: o.status || o.estado || '', detalhe: o.detalhe || o.detail || '' });
    }
  }
  return saida;
}

/** O ledger anota "pulso-report" para as três rotinas pulso-report-1/2/3: casa por prefixo. */
function ledgerCasa(idLedger, chave) {
  return idLedger === chave || chave.startsWith(idLedger + '-');
}

// ─── as execuções de uma rotina (timer) ─────────────────────────────────────

/**
 * Junta "começou" e "terminou/falhou" em execuções, cruza com o ledger e acha os
 * buracos. Devolve os quadradinhos em ordem de tempo e a contagem da semana.
 */
function quadradosDeRotina({ eventos, ledger, chave, horario, desde, agora, ativo, ultimaAntes }) {
  const execucoes = [];
  let comeco = null;
  for (const e of eventos) {
    if (e.id === ID.COMECOU) { comeco = e.t; continue; }
    if (e.id === ID.TERMINOU && e.jobType === 'start') {
      execucoes.push({ ini: comeco != null ? comeco : e.t, fim: e.t, resultado: e.jobResult || 'done' });
      comeco = null;
    } else if (e.id === ID.FALHOU_AO_RODAR) {
      execucoes.push({ ini: comeco != null ? comeco : e.t, fim: e.t, resultado: e.jobResult || 'failed' });
      comeco = null;
    }
  }

  const quadrados = [];
  const semana = { rodadas: execucoes.length, falhas: 0, avisos: 0, faltas: 0 };

  for (const x of execucoes) {
    const base = RESULTADO[x.resultado] || { cor: 'vermelho', titulo: `Terminou de um jeito que o sistema chama de "${x.resultado}"` };
    let cor = base.cor;
    let titulo = base.titulo;
    let detalhe = '';
    // A segunda opinião: o que o próprio script anotou enquanto rodava.
    const janelaIni = x.ini - 5000;
    const janelaFim = x.fim + 90000;
    const notas = ledger.filter((l) => ledgerCasa(l.id, chave) && l.t >= janelaIni && l.t <= janelaFim);
    if (notas.length && cor === 'verde') {
      const pior = notas.map((n) => ({ n, c: corDoLedger(n.status) }))
        .sort((a, b) => ({ vermelho: 0, amarelo: 1, verde: 2 }[a.c] ?? 3) - ({ vermelho: 0, amarelo: 1, verde: 2 }[b.c] ?? 3))[0];
      if (pior && pior.c === 'vermelho') {
        cor = 'vermelho';
        titulo = 'Terminou sem erro para o sistema, mas o registro dela diz que falhou';
        detalhe = pior.n.detalhe || '';
      } else if (pior && pior.c === 'amarelo') {
        cor = 'amarelo';
        titulo = 'Rodou, com um aviso no registro dela';
        detalhe = pior.n.detalhe || '';
      }
    } else if (notas.length && cor === 'vermelho') {
      const comDetalhe = notas.find((n) => n.detalhe);
      if (comDetalhe) detalhe = comDetalhe.detalhe;
    }
    if (cor === 'vermelho') semana.falhas++;
    if (cor === 'amarelo') semana.avisos++;
    quadrados.push({
      em: new Date(x.ini).toISOString(),
      ate: new Date(x.fim).toISOString(),
      cor, titulo, detalhe,
      duracao: x.fim > x.ini ? duracaoHumana(x.fim - x.ini) : '',
    });
  }

  // ── os buracos: rodou menos do que devia ──
  const primeira = execucoes.length ? execucoes[0].ini : null;
  const faltas = [];
  const intervalo = intervaloDoTimer(horario);
  if (ativo && intervalo && execucoes.length) {
    const folga = 2 * intervalo + 120000;
    for (let i = 1; i < execucoes.length; i++) {
      const buraco = execucoes[i].ini - execucoes[i - 1].fim;
      if (buraco > folga) {
        faltas.push({
          t: execucoes[i - 1].fim + intervalo,
          titulo: `Não rodou quando devia: ficou ${duracaoHumana(buraco)} sem rodar, e o combinado é a cada ${duracaoHumana(intervalo)}`,
        });
      }
    }
    const ultima = execucoes[execucoes.length - 1].fim;
    if (agora - ultima > folga) {
      faltas.push({
        t: ultima + intervalo,
        titulo: `Está atrasada: a última vez foi ${haQuanto(ultima, agora)}, e o combinado é a cada ${duracaoHumana(intervalo)}`,
      });
    }
  } else if (ativo && !intervalo) {
    // Calendário. Só cobro horários DEPOIS da primeira execução que o diário
    // conhece (ou do começo da janela, se ela já rodava antes dela).
    const inicioCobranca = ultimaAntes && ultimaAntes < desde ? desde : primeira;
    const esperados = inicioCobranca != null ? horariosEsperados(horario, inicioCobranca - 60000, agora) : null;
    if (esperados) {
      // Tolerância: o systemd pode atrasar alguns minutos (RandomizedDelaySec,
      // máquina ocupada, Persistent depois de um reinício). Quarenta minutos
      // depois do horário sem execução nenhuma por perto já não é atraso normal.
      const tolerancia = 40 * 60000;
      for (const e of esperados) {
        if (agora - e < tolerancia) continue;
        const houve = execucoes.some((x) => x.ini >= e - 120000 && x.ini <= e + tolerancia);
        if (!houve) {
          faltas.push({ t: e, titulo: 'Não rodou no horário marcado' });
        }
      }
    }
  }
  for (const f of faltas) {
    semana.faltas++;
    quadrados.push({ em: new Date(f.t).toISOString(), cor: 'amarelo', titulo: f.titulo, detalhe: '', falta: true });
  }

  quadrados.sort((a, b) => Date.parse(a.em) - Date.parse(b.em));
  return { quadrados: quadrados.slice(-MAX_QUADRADOS), semana, ultimaExecucao: execucoes.length ? execucoes[execucoes.length - 1] : null };
}

// ─── um serviço contínuo (fica de pé o tempo todo) ──────────────────────────

/**
 * Serviço contínuo não tem "execução": ele fica de pé. Então cada quadradinho é
 * UMA HORA das últimas 48, e a cor diz como foi aquela hora: verde ficou de pé o
 * tempo todo, amarelo reiniciou, vermelho caiu (ou ficou fora do ar), cinza é
 * hora de que eu não tenho como saber.
 *
 * O estado de cada hora é reconstruído de trás para frente, a partir do estado
 * de AGORA (que o systemd sabe) e dos eventos de subir, parar e cair do diário.
 */
function quadradosDeServico({ eventos, agora, ativoAgora, ativoDesde }) {
  const fimHoraAtual = (() => { const d = new Date(agora); d.setMinutes(59, 59, 999); return d.getTime() + 1; })();
  const inicio = fimHoraAtual - HORAS_DE_SERVICO * 3600000;
  const evs = eventos.filter((e) => e.t >= inicio && [ID.TERMINOU, ID.PAROU, ID.CAIU, ID.FALHOU_AO_RODAR].includes(e.id));
  const quadrados = [];
  const semana = { rodadas: null, falhas: 0, avisos: 0, faltas: 0 };
  // estado no FIM de cada hora, de trás pra frente
  let estado = ativoAgora; // true, false ou null (não sei)
  let i = evs.length - 1;
  for (let fim = fimHoraAtual; fim > inicio; fim -= 3600000) {
    const ini = fim - 3600000;
    const dentro = [];
    while (i >= 0 && evs[i].t >= ini) { dentro.unshift(evs[i]); i--; }
    const caiu = dentro.filter((e) => e.id === ID.CAIU || e.id === ID.FALHOU_AO_RODAR);
    const mexeu = dentro.filter((e) => e.id === ID.PAROU || (e.id === ID.TERMINOU && e.jobType !== 'stop'));
    let cor;
    let titulo;
    if (caiu.length) {
      cor = 'vermelho';
      titulo = caiu.length > 1 ? `Caiu ${caiu.length} vezes nesta hora` : 'Caiu nesta hora';
    } else if (mexeu.length) {
      cor = 'amarelo';
      const subidas = mexeu.filter((e) => e.id === ID.TERMINOU).length;
      titulo = subidas > 1 ? `Reiniciou ${subidas} vezes nesta hora` : 'Reiniciou nesta hora';
    } else if (estado === true || (ativoDesde && ativoDesde <= ini)) {
      cor = 'verde';
      titulo = 'Ficou de pé a hora inteira';
    } else if (estado === false) {
      cor = 'vermelho';
      titulo = 'Ficou fora do ar nesta hora';
    } else {
      cor = 'cinza';
      titulo = 'Sem dado desta hora';
    }
    if (cor === 'vermelho') semana.falhas++;
    if (cor === 'amarelo') semana.avisos++;
    quadrados.unshift({ em: new Date(ini).toISOString(), ate: new Date(Math.min(fim, agora)).toISOString(), cor, titulo, detalhe: '', hora: true });
    // O estado ANTES desta hora é o inverso do primeiro evento dela.
    if (dentro.length) {
      const primeiro = dentro[0];
      estado = primeiro.id === ID.TERMINOU ? false : (primeiro.id === ID.PAROU || primeiro.id === ID.CAIU ? true : estado);
    }
  }
  return { quadrados, semana };
}

// ─── o módulo ───────────────────────────────────────────────────────────────

function buildOperacoes(config, deps = {}) {
  const SLUG = config.agentSlug || 'agente';
  const AGENT_DIR = config.agentDir;
  const PULSO_DIR = config.pulsoDir || path.join(AGENT_DIR, '.dgclaw', 'logs', 'pulso');
  const executar = deps.executar || executarPadrao;
  const listarRotinas = deps.listarRotinas || (() => rotinasLib.listar(SLUG, AGENT_DIR));
  const pulsoStatus = deps.pulsoStatus || (async () => null);
  const servicoDoCanal = deps.servicoDoCanal || (() => '');
  const relogio = deps.agora || (() => Date.now());

  const PREFIXO = `dgclaw-${SLUG}-`;
  const PREFIXO_SELF = `dgclaw-${SLUG}-self-`;

  /** Estado agora de um serviço contínuo (ativo? desde quando?). Nunca lança. */
  async function estadoDoServico(unit) {
    const r = await executar('systemctl', ['show', unit, '--no-pager', '-p', 'ActiveState,ActiveEnterTimestamp,LoadState,Description'], { timeout: 6000 });
    if (!r.ok && !r.stdout) return { ativo: null, desde: null, existe: null };
    const mapa = {};
    for (const l of r.stdout.split('\n')) {
      const k = l.indexOf('=');
      if (k > 0) mapa[l.slice(0, k)] = l.slice(k + 1);
    }
    if (mapa.LoadState === 'not-found') return { ativo: null, desde: null, existe: false };
    const desde = Date.parse((mapa.ActiveEnterTimestamp || '').replace(/^[A-Z][a-z]{2}\s+/, '').replace(/ (-?\d{2})$/, ' $100'));
    return {
      ativo: mapa.ActiveState ? mapa.ActiveState === 'active' : null,
      desde: Number.isFinite(desde) && desde > 0 ? desde : null,
      existe: true,
      estado: mapa.ActiveState || '',
      descricao: mapa.Description || '',
    };
  }

  /** O nome que a tela mostra: o "o que é" do catálogo sem o ponto final; senão a descrição do systemd. */
  function nomeAmigavel(oQueE, descricao, chave) {
    if (oQueE) return oQueE.replace(/\.\s*$/, '');
    if (descricao) {
      const d = descricao.replace(/^DG Claw\s+/i, '').replace(/\s*\(timer\)/i, '').replace(new RegExp(`:\\s*${SLUG}\\s*$`), '').trim();
      if (d) return d.charAt(0).toUpperCase() + d.slice(1);
    }
    return chave;
  }

  function grupoDe(chave, grupoPulso) {
    for (const g of GRUPOS) if (g.membros.includes(chave)) return g;
    if (grupoPulso && !['runtime', 'vida', 'outro'].includes(grupoPulso)) return GRUPO_PODERES;
    return GRUPO_OUTRAS;
  }

  let _cache = null; // { em, promessa }

  async function calcular() {
    const agora = relogio();
    const desde = agora - DIAS * 86400000;

    let rot = { rotinas: [], erro: null };
    try { rot = (await listarRotinas()) || rot; } catch (e) {
      rot = { rotinas: [], erro: `não consegui ler as rotinas no systemd: ${e.message}` };
    }
    let pul = null;
    try { pul = await pulsoStatus(); } catch (e) {
      console.warn(`[operacoes] o pulso-status nao respondeu (${e.message}). Sigo sem o catalogo de explicacoes.`);
    }
    const processos = (pul && Array.isArray(pul.processos)) ? pul.processos : [];
    const porUnit = new Map();
    for (const p of processos) if (p.unit) porUnit.set(p.unit, p);

    // ── a lista de operações do SISTEMA ──
    const ops = [];
    const vistas = new Set();
    const adicionar = (o) => { if (!vistas.has(o.unit)) { vistas.add(o.unit); ops.push(o); } };

    // Serviços contínuos que o pulso conhece (o agente em si e o painel).
    for (const p of processos) {
      if (p.kind !== 'servico' || !p.unit) continue;
      if (p.unit.startsWith(PREFIXO_SELF)) continue;
      adicionar({ tipo: 'servico', unit: p.unit, chave: p.nome, proc: p });
    }
    // Sem pulso, ainda assim o agente e o painel entram, pelo nome conhecido.
    if (!processos.length) {
      const canal = servicoDoCanal() || `dgclaw-${SLUG}.service`;
      adicionar({ tipo: 'servico', unit: canal, chave: 'canal (runtime)', proc: null });
      adicionar({ tipo: 'servico', unit: `dgclaw-panel-${SLUG}.service`, chave: 'painel', proc: null });
    }
    // Rotinas (timers) do sistema: as do systemd, com o catálogo do pulso por cima.
    for (const r of (rot.rotinas || [])) {
      if (r.tipo !== 'vida') continue;
      const chave = r.unit.replace(/\.timer$/, '').slice(PREFIXO.length);
      adicionar({ tipo: 'rotina', unit: r.unit, chave, rotina: r, proc: porUnit.get(r.unit) || null });
    }
    // Timers de poderes que o pulso conhece e que não seguem o prefixo do agente.
    for (const p of processos) {
      if (p.kind !== 'timer' || !p.unit || vistas.has(p.unit) || p.unit.startsWith(PREFIXO_SELF)) continue;
      const chave = p.unit.replace(/\.timer$/, '').replace(PREFIXO, '');
      adicionar({ tipo: 'rotina', unit: p.unit, chave, rotina: null, proc: p });
    }

    // ── as rotinas do USUÁRIO (marcadas por ele, via agente) ──
    const doUsuario = (rot.rotinas || []).filter((r) => r.tipo === 'marcada');

    // ── uma leitura só do diário, para tudo ──
    const servicos = new Set();
    for (const o of ops) servicos.add(o.tipo === 'rotina' ? o.unit.replace(/\.timer$/, '.service') : o.unit);
    for (const r of doUsuario) servicos.add(r.unit.replace(/\.timer$/, '.service'));
    const diario = servicos.size
      ? await lerDiario(executar, [`${PREFIXO}*.service`, ...[...servicos].filter((u) => !u.startsWith(PREFIXO))], desde)
      : { eventos: [], motivo: null };
    const porServico = new Map();
    for (const e of diario.eventos) {
      if (!porServico.has(e.unit)) porServico.set(e.unit, []);
      porServico.get(e.unit).push(e);
    }
    const ledger = lerLedger(PULSO_DIR, desde);

    // ── monta cada operação ──
    const montarRotina = (unit, chave, r, proc) => {
      const svc = unit.replace(/\.timer$/, '.service');
      const ativo = r ? !!r.ativo : (proc ? proc.resumo !== 'sem-sinal' : null);
      const horario = r ? r.horario : '';
      const ultimaAntes = r && r.ultima ? Date.parse(r.ultima) : null;
      let q = { quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 }, ultimaExecucao: null };
      if (!diario.motivo) {
        q = quadradosDeRotina({ eventos: porServico.get(svc) || [], ledger, chave, horario, desde, agora, ativo, ultimaAntes });
      }
      return { svc, ativo, q };
    };

    const resultado = [];
    for (const o of ops) {
      const proc = o.proc;
      const oQueE = proc ? proc.oQueE || '' : '';
      const praQueServe = proc ? proc.praQueServe || '' : '';
      const g = grupoDe(o.chave, proc && proc.grupo);
      const base = {
        id: o.unit.replace(/\.(timer|service)$/, ''),
        unit: o.unit,
        chave: o.chave,
        grupo: g.id,
        nome: nomeAmigavel(oQueE, o.rotina ? o.rotina.descricao : '', o.chave),
        oQueE, praQueServe,
        crit: proc ? proc.crit || null : (o.chave === 'canal (runtime)' ? 'alta' : null),
        tipo: o.tipo,
      };
      if (o.tipo === 'servico') {
        const st = await estadoDoServico(o.unit);
        // Sem catálogo (pulso-status antigo instalado no agente), o nome vem da
        // descrição que o systemd tem da unidade, que é melhor que o id cru.
        if (!oQueE && st.descricao) base.nome = nomeAmigavel('', st.descricao, o.chave);
        const q = diario.motivo
          ? { quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 } }
          : quadradosDeServico({ eventos: porServico.get(o.unit) || [], agora, ativoAgora: st.ativo, ativoDesde: st.desde });
        let estado;
        let frase;
        if (st.existe === false) {
          estado = 'atencao';
          frase = `o sistema não conhece a unidade "${o.unit}": ou ela nunca foi instalada, ou tem outro nome`;
        } else if (st.ativo === true) {
          const ult = q.quadrados[q.quadrados.length - 1];
          estado = ult && ult.cor === 'vermelho' ? 'falha' : (ult && ult.cor === 'amarelo' ? 'atencao' : 'ok');
          frase = st.desde ? `de pé desde ${new Date(st.desde).toISOString()}` : 'de pé';
          if (estado !== 'ok') frase = `de pé agora, mas ${ult.titulo.toLowerCase()}`;
        } else if (st.ativo === false) {
          estado = 'falha';
          frase = `parado agora (o sistema diz "${st.estado || 'inativo'}")`;
        } else {
          estado = 'sem-dado';
          frase = 'não consegui perguntar ao sistema como ele está';
        }
        resultado.push({ ...base, cadencia: 'fica de pé o tempo todo', ativoDesde: st.desde ? new Date(st.desde).toISOString() : null,
          proxima: null, ultima: null, estado, frase, quadrados: q.quadrados, semana: q.semana, porHora: true });
        continue;
      }
      const r = o.rotina;
      // Timer que só o pulso conhece (de poder, ou que o systemd não listou): antes
      // de qualquer cor, conferir se ele existe. "Não existe" e "está desligado" são
      // problemas diferentes, e a frase precisa dizer qual dos dois é.
      if (!r) {
        const st = await estadoDoServico(o.unit);
        if (st.existe === false) {
          resultado.push({ ...base, cadencia: (proc && proc.cadencia) || '', proxima: null, ultima: null,
            estado: 'atencao', frase: `o sistema não conhece a rotina "${o.unit}": ela não foi instalada, então não roda`,
            quadrados: [], semana: { rodadas: null, falhas: 0, avisos: 0, faltas: 0 } });
          continue;
        }
        if (!oQueE && st.descricao) base.nome = nomeAmigavel('', st.descricao, o.chave);
      }
      const { ativo, q } = montarRotina(o.unit, o.chave, r, proc);
      const cadencia = (r && r.quando) || (proc && proc.cadencia) || '';
      let estado;
      let frase;
      const ult = q.quadrados[q.quadrados.length - 1];
      if (ativo === false) {
        estado = 'atencao';
        frase = 'o horário dela está desligado no sistema, então ela não vai rodar sozinha';
      } else if (diario.motivo) {
        estado = 'sem-dado';
        frase = 'sem histórico: não consegui ler o diário do sistema';
      } else if (!ult) {
        estado = 'sem-dado';
        // O diário pode vir vazio mesmo com a rotina rodando (o sistema tem a data da
        // última vez, mas não guardou o histórico). Dizer "não rodou nos últimos 7 dias"
        // ao lado de "a última vez foi há 3 min" é uma frase falsa, e ainda pintava a
        // operação de amarelo (vistoria de 08/10/2026). Última vez recente e sem
        // histórico é "sem dado", dito como tal; só vira atenção se a última vez for
        // mais velha que a janela.
        const ultimaMs = r && r.ultima ? Date.parse(r.ultima) : NaN;
        if (Number.isFinite(ultimaMs) && agora - ultimaMs <= DIAS * 86400000) {
          frase = `sem histórico para mostrar (a última vez que rodou foi ${haQuanto(ultimaMs, agora)})`;
        } else if (Number.isFinite(ultimaMs)) {
          frase = `não rodou nos últimos ${DIAS} dias (a última vez foi ${haQuanto(ultimaMs, agora)})`;
          estado = 'atencao';
        } else {
          frase = 'ainda não rodou nenhuma vez';
        }
      } else {
        estado = ult.cor === 'verde' ? 'ok' : (ult.cor === 'vermelho' ? 'falha' : 'atencao');
        const quando = q.ultimaExecucao ? haQuanto(q.ultimaExecucao.fim, agora) : '';
        frase = estado === 'ok' ? `rodou ${quando} e deu certo` : ult.titulo;
      }
      resultado.push({
        ...base,
        cadencia,
        proxima: r ? r.proxima : (proc && proc.proxima) || null,
        ultima: q.ultimaExecucao ? new Date(q.ultimaExecucao.fim).toISOString() : (r ? r.ultima : null),
        estado, frase, quadrados: q.quadrados, semana: q.semana,
      });
    }

    // ── os grupos, na ordem da tela ──
    const ordem = [...GRUPOS, GRUPO_PODERES, GRUPO_OUTRAS];
    const grupos = ordem
      .map((g) => ({ id: g.id, titulo: g.titulo, explica: g.explica, operacoes: resultado.filter((o) => o.grupo === g.id) }))
      .filter((g) => g.operacoes.length);

    // ── o resumo do topo ──
    const atencao = resultado.filter((o) => o.estado === 'falha' || o.estado === 'atencao');
    const medidas = resultado.filter((o) => o.estado !== 'sem-dado');
    let resumo;
    if (diario.motivo) {
      resumo = { estado: 'indisponivel', frase: 'Não consegui ler o histórico das operações', motivo: diario.motivo };
    } else if (atencao.length) {
      const nomes = atencao.map((o) => o.nome);
      resumo = {
        estado: 'atencao',
        frase: atencao.length === 1
          ? `1 operação pede atenção: ${nomes[0]}`
          : `${atencao.length} operações pedem atenção: ${listaHumana(nomes)}`,
      };
    } else if (!medidas.length) {
      resumo = { estado: 'sem-dado', frase: 'Ainda não há o que medir: nenhuma operação rodou até agora' };
    } else {
      resumo = { estado: 'ok', frase: 'Tudo funcionando' };
    }
    Object.assign(resumo, {
      total: resultado.length,
      verdes: resultado.filter((o) => o.estado === 'ok').length,
      atencao: atencao.map((o) => o.id),
      semDado: resultado.filter((o) => o.estado === 'sem-dado').length,
    });

    // ── as rotinas do usuário, com a última execução ──
    const usuario = doUsuario.map((r) => {
      const chave = r.unit.replace(/\.timer$/, '').slice(PREFIXO.length);
      const { ativo, q } = montarRotina(r.unit, chave, r, null);
      const ult = q.quadrados[q.quadrados.length - 1] || null;
      return {
        id: r.unit.replace(/\.timer$/, ''),
        unit: r.unit,
        nome: r.nome,
        descricao: r.descricao || '',
        recado: r.recado || null,
        quando: r.quando || r.horario || '',
        proxima: r.proxima || null,
        ultima: q.ultimaExecucao ? new Date(q.ultimaExecucao.fim).toISOString() : (r.ultima || null),
        ativo,
        // null = não medido (sem diário ou nunca rodou). Nunca vira "deu certo".
        ultimoResultado: diario.motivo || !ult ? null : (ult.cor === 'verde' ? 'ok' : (ult.cor === 'vermelho' ? 'falha' : 'atencao')),
        ultimoTitulo: ult ? ult.titulo : null,
        ultimoDetalhe: ult ? ult.detalhe || '' : '',
        quadrados: q.quadrados.slice(-14),
      };
    });

    return {
      geradoEm: new Date(agora).toISOString(),
      janela: { desde: new Date(desde).toISOString(), ate: new Date(agora).toISOString(), dias: DIAS },
      historico: { disponivel: !diario.motivo, motivo: diario.motivo },
      resumo,
      grupos,
      rotinasDoUsuario: usuario,
      inconsistencias: rot.inconsistencias || [],
      erroRotinas: rot.erro || null,
    };
  }

  /**
   * O diagnóstico de saúde vence o "de pé" do agente (vistoria de 08/10/2026).
   *
   * O cartão "O agente em si" mede o PROCESSO, e processo de pé com o login da Anthropic
   * vencido ficava verde, "de pé o tempo todo", ao lado do selo vermelho "Inativo". Quando o
   * diagnóstico (lib/saude.js, o mesmo do /api/saude, com o cache de 20 s dele) diz
   * "inativo", este cartão passa a dizer que o processo está de pé mas ele não responde, e
   * o resumo do topo é refeito. Roda DEPOIS do cache de 45 s do retrato, para o diagnóstico
   * nunca ficar velho, e devolve cópia: o objeto em cache não é alterado.
   */
  async function comDiagnostico(r) {
    if (!deps.diagnostico || !r || !Array.isArray(r.grupos)) return r;
    let d = null;
    try { d = await deps.diagnostico(); } catch (e) {
      console.error('[operacoes] não consegui o diagnóstico de saúde para o cartão do agente:', e.message);
      return r;
    }
    if (!d || d.estado !== 'inativo') return r;
    const canal = servicoDoCanal() || `dgclaw-${SLUG}.service`;
    let achou = false;
    const grupos = r.grupos.map((g) => ({
      ...g,
      operacoes: g.operacoes.map((o) => {
        if (o.tipo !== 'servico' || (o.unit !== canal && o.chave !== 'canal (runtime)')) return o;
        achou = true;
        const frase = `o processo está de pé, mas ele não consegue responder: ${d.frase || 'o diagnóstico de saúde diz que ele está inativo'}`;
        const qs = (o.quadrados || []).slice();
        if (qs.length) qs[qs.length - 1] = { ...qs[qs.length - 1], cor: 'vermelho', titulo: 'De pé, mas sem conseguir responder', detalhe: d.frase || '' };
        return { ...o, estado: 'falha', frase, cadencia: 'o processo está de pé', quadrados: qs, diagnostico: { estado: d.estado, tipo: d.tipo || null } };
      }),
    }));
    if (!achou) return r;
    // Sem diário, o resumo já diz que não leu o histórico: esse aviso é mais grave e fica.
    if (r.resumo && r.resumo.estado === 'indisponivel') return { ...r, grupos };
    const todas = grupos.flatMap((g) => g.operacoes);
    const atencao = todas.filter((o) => o.estado === 'falha' || o.estado === 'atencao');
    const nomes = atencao.map((o) => o.nome);
    const resumo = {
      ...r.resumo,
      estado: 'atencao',
      frase: atencao.length === 1 ? `1 operação pede atenção: ${nomes[0]}` : `${atencao.length} operações pedem atenção: ${listaHumana(nomes)}`,
      verdes: todas.filter((o) => o.estado === 'ok').length,
      atencao: atencao.map((o) => o.id),
    };
    delete resumo.motivo;
    return { ...r, grupos, resumo };
  }

  /** O retrato, com cache curto. `forcar` pula o cache mas nunca abaixo de 5 s. */
  function retrato(opcoes = {}) {
    return retratoEmCache(opcoes).then(comDiagnostico);
  }

  function retratoEmCache({ forcar } = {}) {
    const agora = Date.now();
    if (_cache && (agora - _cache.em < CACHE_MS) && !(forcar && agora - _cache.em > 5000)) return _cache.promessa;
    const promessa = calcular().catch((e) => {
      console.error('[operacoes] falha ao montar a aba Operacoes:', e);
      return {
        geradoEm: new Date().toISOString(),
        historico: { disponivel: false, motivo: `o painel quebrou ao montar esta tela: ${e.message}` },
        resumo: { estado: 'indisponivel', frase: 'Não consegui montar as operações', motivo: e.message, total: 0, verdes: 0, atencao: [], semDado: 0 },
        grupos: [], rotinasDoUsuario: [], inconsistencias: [],
      };
    });
    _cache = { em: agora, promessa };
    return promessa;
  }

  return { retrato };
}

module.exports = {
  buildOperacoes,
  // exportados para o test-operacoes.mjs
  _interno: { duracaoMs, horariosEsperados, intervaloDoTimer, quadradosDeRotina, quadradosDeServico, corDoLedger, ID, GRUPOS },
};
