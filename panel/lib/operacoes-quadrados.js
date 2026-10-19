'use strict';
// operacoes-quadrados.js: o leitor do diário do systemd e do ledger, e a montagem dos quadradinhos.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ID, MAX_QUADRADOS, HORAS_DE_SERVICO } = require('./operacoes-constantes');
const { horariosEsperados, intervaloDoTimer, haQuanto, duracaoHumana, RESULTADO, corDoLedger } = require('./operacoes-tempo');

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

module.exports = { executarPadrao, lerDiario, lerLedger, ledgerCasa, quadradosDeRotina, quadradosDeServico };
