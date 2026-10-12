// test-operacoes.mjs — as cores da aba Operações dizem a verdade?
//
// POR QUE ESTE TESTE EXISTE. A aba Operações é uma página de status: o dono bate o
// olho, vê tudo verde e vai embora. Então o pior defeito possível aqui não é a tela
// quebrar, é ela ficar VERDE com a rotina quebrada. Este teste conferre os casos
// em que isso já aconteceu ou quase aconteceu:
//   - a falha que vem com outro MESSAGE_ID (be02cf68) e sumia de um filtro só pelo
//     de sucesso;
//   - o job que termina "sem erro" para o sistema mas anotou erro no ledger;
//   - a rotina que simplesmente parou de rodar (sem falhar), que só aparece pela
//     cadência;
//   - o diário ilegível, que tem que virar "não consegui ler", nunca "tudo
//     funcionando".
//
// Nada aqui toca em systemd de verdade: o journalctl e o systemctl são falsos.
// `node test-operacoes.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildOperacoes, _interno } = require('./lib/operacoes.js');
const { duracaoMs, horariosEsperados, quadradosDeRotina, quadradosDeServico, ID } = _interno;

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const MIN = 60000;
const H = 60 * MIN;
// Um "agora" fixo, numa quinta às 18h no horário desta máquina.
const AGORA = new Date(2026, 9, 1, 18, 0, 0).getTime();

console.log('\nDuração no formato do systemd');
ok(duracaoMs('30min') === 30 * MIN, '30min');
ok(duracaoMs('1h 30min') === 90 * MIN, '1h 30min');
ok(duracaoMs('1d') === 24 * H, '1d');
ok(duracaoMs('qualquer coisa') === null, 'texto que não é duração vira null, nunca zero');

console.log('\nHorários esperados de um timer de calendário');
{
  const desde = AGORA - 7 * 24 * H;
  const diario = horariosEsperados('*-*-* 23:30:00', desde, AGORA);
  ok(Array.isArray(diario) && diario.length === 7, `todo dia às 23:30: 7 horários em 7 dias (deu ${diario && diario.length})`);
  const comFuso = horariosEsperados('*-*-* 09:00:00 America/Sao_Paulo', desde, AGORA);
  ok(Array.isArray(comFuso) && comFuso.length >= 7, 'o fuso no fim do horário não atrapalha');
  const util = horariosEsperados('Mon..Fri *-*-* 09:00:00', desde, AGORA);
  ok(Array.isArray(util) && util.length === 5, `de segunda a sexta: 5 em 7 dias (deu ${util && util.length})`);
  ok(horariosEsperados('*-*-1/2 10:00', desde, AGORA) === null, 'forma que eu não entendo devolve null (não sei), e não lista vazia');
}

// Fábrica de eventos do diário para UMA unidade.
const ev = (t, id, extra = {}) => ({ unit: 'x.service', t, id, jobType: 'start', jobResult: id === ID.FALHOU_AO_RODAR ? 'failed' : 'done', ...extra });
const rodada = (t, dur = 2000, falhou = false) => [ev(t, ID.COMECOU), ev(t + dur, falhou ? ID.FALHOU_AO_RODAR : ID.TERMINOU)];
const base = { ledger: [], chave: 'heartbeat', desde: AGORA - 7 * 24 * H, agora: AGORA, ativo: true, ultimaAntes: null };

console.log('\nRotina de intervalo (a cada 30 min)');
{
  const eventos = [];
  for (let t = AGORA - 10 * 30 * MIN; t < AGORA; t += 30 * MIN) eventos.push(...rodada(t));
  const r = quadradosDeRotina({ ...base, eventos, horario: 'cada:30min' });
  ok(r.quadrados.length === 10 && r.quadrados.every((q) => q.cor === 'verde'), 'dez rodadas boas = dez quadradinhos verdes');
  ok(r.semana.falhas === 0 && r.semana.faltas === 0, 'nenhuma falha, nenhuma falta');
  ok(r.quadrados[0].duracao === '2 s', 'a duração vem do par começou/terminou');
}
{
  const eventos = [...rodada(AGORA - 5 * H), ...rodada(AGORA - 4.5 * H), ...rodada(AGORA - 2 * H), ...rodada(AGORA - 1.5 * H), ...rodada(AGORA - 60 * MIN), ...rodada(AGORA - 30 * MIN), ...rodada(AGORA - 2 * MIN)];
  const r = quadradosDeRotina({ ...base, eventos, horario: 'cada:30min' });
  const amarelos = r.quadrados.filter((q) => q.cor === 'amarelo');
  ok(amarelos.length === 1 && amarelos[0].falta, 'um buraco de 2,5 h vira UM quadradinho amarelo de "não rodou"');
  ok(r.semana.faltas === 1, 'e entra na conta da semana como falta');
}
{
  const eventos = [...rodada(AGORA - 3 * H)];
  const r = quadradosDeRotina({ ...base, eventos, horario: 'cada:30min' });
  const ult = r.quadrados[r.quadrados.length - 1];
  ok(ult.cor === 'amarelo' && /atrasada/.test(ult.titulo), 'parada há 3 h numa rotina de 30 min: o último quadradinho é amarelo de atraso');
}
{
  const eventos = [...rodada(AGORA - 40 * MIN), ...rodada(AGORA - 10 * MIN, 1500, true)];
  const r = quadradosDeRotina({ ...base, eventos, horario: 'cada:30min' });
  ok(r.quadrados[r.quadrados.length - 1].cor === 'vermelho', 'a falha com o MESSAGE_ID be02cf68 vira vermelho (era o que sumia)');
  ok(r.semana.falhas === 1, 'e conta como falha');
}

console.log('\nO ledger como segunda opinião');
{
  const t = AGORA - 20 * MIN;
  const eventos = rodada(t, 30000);
  const ledger = [{ id: 'heartbeat', t: t + 10000, status: 'erro', detalhe: 'a sessão não respondeu ao cutucão' }];
  const r = quadradosDeRotina({ ...base, eventos, ledger, horario: 'cada:30min' });
  const q = r.quadrados[r.quadrados.length - 1];
  ok(q.cor === 'vermelho', 'job "done" com erro no ledger naquele intervalo = vermelho');
  ok(q.detalhe === 'a sessão não respondeu ao cutucão', 'com o detalhe do ledger');
}
{
  const t = AGORA - 20 * MIN;
  const eventos = rodada(t, 30000);
  const ledger = [{ id: 'heartbeat', t: t - 3 * H, status: 'erro', detalhe: 'velho' }];
  const r = quadradosDeRotina({ ...base, eventos, ledger, horario: 'cada:30min' });
  ok(r.quadrados[r.quadrados.length - 1].cor === 'verde', 'erro do ledger FORA do intervalo da execução não contamina');
}
{
  const t = AGORA - 5 * H;
  const r = quadradosDeRotina({ ...base, chave: 'pulso-report-1', eventos: rodada(t, 20000), ledger: [{ id: 'pulso-report', t: t + 5000, status: 'aviso', detalhe: 'canal lento' }], horario: '*-*-* 13:00:00' });
  ok(r.quadrados.some((q) => q.cor === 'amarelo' && q.detalhe === 'canal lento'), 'o ledger "pulso-report" casa com a unidade pulso-report-1 (aviso = amarelo)');
}

console.log('\nRotina de calendário (todo dia às 23:30)');
{
  const eventos = [];
  for (let d = 7; d >= 1; d--) {
    if (d === 3) continue; // a noite que não rodou
    const dia = new Date(AGORA - d * 24 * H);
    eventos.push(...rodada(new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 23, 30).getTime(), 60000));
  }
  const r = quadradosDeRotina({ ...base, chave: 'reflection', eventos, horario: '*-*-* 23:30:00' });
  ok(r.quadrados.filter((q) => q.cor === 'verde').length === 6, 'seis noites boas');
  ok(r.quadrados.filter((q) => q.falta).length === 1, 'a noite em que ela não rodou vira amarelo');
}
{
  const r = quadradosDeRotina({ ...base, chave: 'reflection', eventos: [], horario: '*-*-* 23:30:00', ultimaAntes: null });
  ok(r.quadrados.length === 0, 'rotina recém-instalada que nunca rodou não ganha amarelo inventado');
}

console.log('\nServiço contínuo (fica de pé o tempo todo)');
{
  const r = quadradosDeServico({ eventos: [], agora: AGORA, ativoAgora: true, ativoDesde: AGORA - 10 * 24 * H });
  ok(r.quadrados.length === 48 && r.quadrados.every((q) => q.cor === 'verde'), 'de pé há dez dias: 48 horas verdes');
}
{
  const t = AGORA - 5 * H - 20 * MIN;
  const eventos = [ev(t, ID.PAROU, { jobType: 'restart' }), ev(t + 3000, ID.TERMINOU, { jobType: 'restart' })];
  const r = quadradosDeServico({ eventos, agora: AGORA, ativoAgora: true, ativoDesde: t + 3000 });
  ok(r.quadrados.filter((q) => q.cor === 'amarelo').length === 1, 'um reinício vira uma hora amarela');
  ok(r.quadrados.filter((q) => q.cor === 'verde').length === 47, 'o resto continua verde');
}
{
  const t = AGORA - 2 * H;
  const eventos = [ev(t, ID.CAIU, { jobType: null, jobResult: null })];
  const r = quadradosDeServico({ eventos, agora: AGORA, ativoAgora: false, ativoDesde: null });
  const ultimas = r.quadrados.slice(-2).map((q) => q.cor);
  ok(r.quadrados.some((q) => q.cor === 'vermelho' && /Caiu/.test(q.titulo)), 'a hora em que caiu é vermelha');
  ok(ultimas.every((c) => c === 'vermelho'), 'e as horas fora do ar depois também');
}
{
  const r = quadradosDeServico({ eventos: [], agora: AGORA, ativoAgora: null, ativoDesde: null });
  ok(r.quadrados.every((q) => q.cor === 'cinza'), 'sem saber o estado, a hora é cinza (nunca verde)');
}

// ─── o módulo inteiro, com systemd falso ─────────────────────────────────────
const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'operacoes-teste-'));
fs.mkdirSync(path.join(RAIZ, '.dgclaw', 'logs', 'pulso'), { recursive: true });
const SLUG = 'teste';

function linhaDoDiario(unit, t, id, jobResult = 'done', jobType = 'start') {
  return JSON.stringify({ __REALTIME_TIMESTAMP: String(Math.round(t * 1000)), UNIT: unit, MESSAGE_ID: id, JOB_RESULT: jobResult, JOB_TYPE: jobType });
}

function montar({ diario, stderr = '', semJournal = false, rotinas }) {
  const executar = async (cmd, args) => {
    if (cmd === 'journalctl') {
      if (semJournal) return { ok: false, code: -1, erro: 'ENOENT', stdout: '', stderr: '' };
      return { ok: true, code: 0, erro: null, stdout: diario.join('\n'), stderr };
    }
    if (cmd === 'systemctl') {
      return { ok: true, code: 0, erro: null, stdout: `ActiveState=active\nActiveEnterTimestamp=Thu 2026-09-01 10:00:00 -03\nLoadState=loaded\nDescription=DG Claw ${args[1]}\n`, stderr: '' };
    }
    return { ok: false, code: 1, erro: 'inesperado', stdout: '', stderr: '' };
  };
  return buildOperacoes({ agentSlug: SLUG, agentDir: RAIZ }, {
    executar,
    agora: () => AGORA,
    listarRotinas: async () => ({ rotinas, inconsistencias: [] }),
    pulsoStatus: async () => ({ processos: [
      { nome: 'canal (runtime)', kind: 'servico', unit: `dgclaw-${SLUG}.service`, grupo: 'runtime', crit: 'alta', oQueE: 'O agente em si.', praQueServe: 'É o processo onde ele pensa.' },
      { nome: 'heartbeat', kind: 'timer', unit: `dgclaw-${SLUG}-heartbeat.timer`, grupo: 'vida', crit: 'media', oQueE: 'O batimento.', praQueServe: 'Cutuca o agente.' },
    ] }),
  });
}

const ROTINAS = [
  { unit: `dgclaw-${SLUG}-heartbeat.timer`, nome: 'heartbeat', tipo: 'vida', ativo: true, horario: 'cada:30min', quando: 'a cada 30 minutos', proxima: null, ultima: null, descricao: '' },
  { unit: `dgclaw-${SLUG}-self-resumo.timer`, nome: 'resumo', tipo: 'marcada', ativo: true, horario: '*-*-* 09:00:00', quando: 'todo dia às 09:00', proxima: null, ultima: null, descricao: 'resumo do dia', recado: 'manda o resumo' },
];

console.log('\nO módulo inteiro (systemd falso)');
{
  const hb = `dgclaw-${SLUG}-heartbeat.service`;
  const diario = [];
  for (let t = AGORA - 6 * 30 * MIN; t < AGORA; t += 30 * MIN) {
    diario.push(linhaDoDiario(hb, t, ID.COMECOU), linhaDoDiario(hb, t + 1000, ID.TERMINOU));
  }
  const dia = new Date(AGORA);
  const nove = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), 9, 0).getTime();
  diario.push(linhaDoDiario(`dgclaw-${SLUG}-self-resumo.service`, nove, ID.COMECOU), linhaDoDiario(`dgclaw-${SLUG}-self-resumo.service`, nove + 4000, ID.FALHOU_AO_RODAR, 'failed'));

  const r = await montar({ diario, rotinas: ROTINAS }).retrato();
  const todas = r.grupos.flatMap((g) => g.operacoes);
  ok(r.historico.disponivel === true, 'o histórico foi lido');
  ok(!todas.some((o) => o.unit.includes('-self-')), 'a rotina marcada pelo dono NÃO entra na lista do sistema');
  ok(r.rotinasDoUsuario.length === 1 && r.rotinasDoUsuario[0].ultimoResultado === 'falha', 'ela aparece nas rotinas do usuário, com a última execução falhando');
  const batimento = todas.find((o) => o.chave === 'heartbeat');
  ok(batimento && batimento.nome === 'O batimento', 'o nome vem do catálogo do pulso-status (o "o que é"), sem o ponto final');
  ok(batimento && batimento.estado === 'ok' && batimento.grupo === 'de-pe', 'o batimento está ok e no grupo "Mantém ele de pé"');
  ok(r.resumo.estado === 'ok' && r.resumo.frase === 'Tudo funcionando', 'tudo verde no sistema: "Tudo funcionando"');
}
{
  const hb = `dgclaw-${SLUG}-heartbeat.service`;
  const diario = [linhaDoDiario(hb, AGORA - 10 * MIN, ID.COMECOU), linhaDoDiario(hb, AGORA - 10 * MIN + 1000, ID.FALHOU_AO_RODAR, 'failed')];
  const r = await montar({ diario, rotinas: ROTINAS }).retrato();
  ok(r.resumo.estado === 'atencao' && /1 operação pede atenção: O batimento/.test(r.resumo.frase), `com o batimento falhando, a frase diz qual (${r.resumo.frase})`);
}
{
  const r = await montar({ diario: [], stderr: 'No journal files were opened due to insufficient permissions.', rotinas: ROTINAS }).retrato();
  const todas = r.grupos.flatMap((g) => g.operacoes);
  ok(r.historico.disponivel === false && /permissão/.test(r.historico.motivo), 'sem permissão no diário: o motivo diz isso em português');
  ok(r.resumo.estado === 'indisponivel', 'e o resumo NÃO diz "tudo funcionando"');
  ok(todas.every((o) => o.estado !== 'ok' || o.tipo === 'servico'), 'nenhuma rotina fica verde sem histórico');
  ok(r.rotinasDoUsuario.every((u) => u.ultimoResultado === null), 'rotina do usuário sem histórico fica "sem resultado" (null), nunca "deu certo"');
}
{
  const r = await montar({ diario: [], semJournal: true, rotinas: ROTINAS }).retrato();
  ok(r.historico.disponivel === false && /journalctl/.test(r.historico.motivo), 'máquina sem journalctl: o motivo diz isso');
}

console.log('\nO diagnóstico de saúde vence o "de pé" do agente');
{
  const executar = async (cmd, args) => {
    if (cmd === 'journalctl') return { ok: true, code: 0, erro: null, stdout: '', stderr: '' };
    return { ok: true, code: 0, erro: null, stdout: `ActiveState=active\nActiveEnterTimestamp=Thu 2026-09-01 10:00:00 -03\nLoadState=loaded\nDescription=x ${args[1]}\n`, stderr: '' };
  };
  const fazer = (diagnostico) => buildOperacoes({ agentSlug: SLUG, agentDir: RAIZ }, {
    executar, agora: () => AGORA, diagnostico,
    listarRotinas: async () => ({ rotinas: ROTINAS, inconsistencias: [] }),
    pulsoStatus: async () => ({ processos: [
      { nome: 'canal (runtime)', kind: 'servico', unit: `dgclaw-${SLUG}.service`, grupo: 'runtime', crit: 'alta', oQueE: 'O agente em si.', praQueServe: 'x' },
    ] }),
  });
  const achar = (r) => r.grupos.flatMap((g) => g.operacoes).find((o) => o.chave === 'canal (runtime)');
  const inativo = { estado: 'inativo', tipo: 'login', frase: 'O login da conta dele na Anthropic não está valendo.' };
  const m1 = fazer(async () => inativo);
  const r1 = await m1.retrato();
  const ag = achar(r1);
  ok(ag && ag.estado === 'falha', 'diagnóstico inativo: o cartão do agente NÃO fica verde');
  ok(ag && /de pé, mas ele não consegue responder/.test(ag.frase) && /login/.test(ag.frase), `a frase diz que o processo está de pé mas não responde, com o motivo (${ag && ag.frase})`);
  ok(ag && !/de pé o tempo todo/.test(ag.cadencia), 'e não diz "de pé o tempo todo"');
  ok(r1.resumo.estado === 'atencao' && /O agente em si|agente/.test(r1.resumo.frase), `o resumo do topo passa a pedir atenção (${r1.resumo.frase})`);
  const r1b = await m1.retrato();
  ok(r1b === r1 || achar(r1b).estado === 'falha', 'a segunda chamada (cache do retrato) continua certa');
  const r2 = await fazer(async () => ({ estado: 'ativo', tipo: 'ok', frase: '' })).retrato();
  ok(achar(r2).estado !== 'falha', 'diagnóstico ativo: o cartão fica como estava');
  const r3 = await fazer(async () => { throw new Error('boom'); }).retrato();
  ok(achar(r3).estado !== 'falha', 'diagnóstico que quebra: não inventa problema, o cartão fica como estava');
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
