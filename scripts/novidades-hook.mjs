#!/usr/bin/env node
// Gancho UserPromptSubmit do Claude Code para o aviso de novidades depois de uma atualização do
// DG Claw. Roda dentro do container do agente (como o usuário agente) e no host (Admin, como root).
//
// Como funciona: lê a versão atual em <app>/VERSAO (o instalador grava, e como a imagem do agente
// copia o app inteiro, o container enxerga a versão da imagem em que está, não a do host). Compara
// com a última versão que ESTE agente viu (<workspace>/.dgclaw/novidades-visto.json). Se mudou,
// acrescenta ao contexto do turno as entradas do CHANGELOG.md que ele ainda não tinha visto e pede
// que ele avise o dono. Marca como visto no momento da injeção, então o aviso sai uma vez só.
//
// As versões instaladas são commits (v1-<commit>), então não dá para casar versão com título de
// seção do CHANGELOG. Por isso o "visto" guarda a impressão digital de cada item do CHANGELOG que
// o agente já conhecia; novidade = item cuja impressão ainda não está lá.
//
// Qualquer erro: sai com 0, sem texto no stdout, e anota o motivo em
// <workspace>/.dgclaw/logs/novidades-hook.log. Contrato e decisões: docs/NOVIDADES.md.
//
// Modo `--semear`: grava o "visto" com a versão e o CHANGELOG de agora, sem imprimir aviso. É o que o
// `dgclaw agente criar` (e a primeira instalação do Admin) usam para o agente NOVO não receber aviso
// de coisas que já nasceram com ele. Agente antigo, sem arquivo de visto, recebe o aviso uma vez.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digital, itensDoChangelog } from './novidades-lib.mjs';

const LIMITE = 2500;
const LIMITE_ITEM = 220;
const ws = process.env.DGCLAW_WORKSPACE || '/home/agente';
const app = process.env.DGCLAW_APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versaoArq = path.join(app, 'VERSAO');
const changelogArq = path.join(app, 'CHANGELOG.md');
const vistoArq = path.join(ws, '.dgclaw', 'novidades-visto.json');
const logArq = path.join(ws, '.dgclaw', 'logs', 'novidades-hook.log');
const configArq = process.env.DGCLAW_CONFIG || path.join(ws, '.dgclaw', 'config.sh');

function anota(motivo) {
  try {
    fs.mkdirSync(path.dirname(logArq), { recursive: true });
    fs.appendFileSync(logArq, `${new Date().toISOString()} ${motivo}\n`);
  } catch (e) {
    process.stderr.write(`novidades-hook: ${motivo} (e não consegui anotar em ${logArq}: ${e.message})\n`);
  }
}

function lerVersao() {
  let v;
  try { v = fs.readFileSync(versaoArq, 'utf8').trim(); } catch (e) {
    anota(`não consegui ler a versão em ${versaoArq}: ${e.message}. Sem versão não há como saber se houve atualização; o instalador grava esse arquivo.`);
    return null;
  }
  if (!/^[0-9A-Za-z._+-]+$/.test(v)) {
    anota(`a versão em ${versaoArq} tem caracteres estranhos (${JSON.stringify(v.slice(0, 40))}); ignorei neste turno.`);
    return null;
  }
  return v;
}

function lerChangelog() {
  let bruto;
  try { bruto = fs.readFileSync(changelogArq, 'utf8'); } catch (e) {
    anota(`não consegui ler o CHANGELOG em ${changelogArq}: ${e.message}. Sem ele não há o que avisar.`);
    return null;
  }
  const itens = itensDoChangelog(bruto);
  if (!itens.length) {
    anota(`o CHANGELOG ${changelogArq} não tem nenhum item no formato "- texto"; ignorei neste turno.`);
    return null;
  }
  return itens;
}

function gravaVisto(versao, itens) {
  const tmp = `${vistoArq}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(vistoArq), { recursive: true });
    const dados = { versao, itens: [...new Set(itens.map(i => digital(i.texto)))], visto_em: new Date().toISOString() };
    fs.writeFileSync(tmp, `${JSON.stringify(dados)}\n`);
    fs.renameSync(tmp, vistoArq);
    return true;
  } catch (e) {
    anota(`não consegui gravar ${vistoArq}: ${e.message}. Não avisei neste turno para não repetir o aviso a cada mensagem.`);
    try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter sido criado */ }
    return false;
  }
}

function lerVisto() {
  try {
    const v = JSON.parse(fs.readFileSync(vistoArq, 'utf8'));
    if (!v || typeof v.versao !== 'string' || !Array.isArray(v.itens)) throw new Error('faltam versao e itens');
    return v;
  } catch (e) {
    if (e.code !== 'ENOENT') anota(`o arquivo ${vistoArq} está ilegível (${e.message}); tratei como agente que nunca viu novidades.`);
    return null;
  }
}

/** Nome do dono, lido do config.sh SEM executá-lo (a casa do agente pode escrevê-lo). */
function nomeDoDono() {
  try {
    const linha = fs.readFileSync(configArq, 'utf8').split('\n').find(l => l.startsWith("export DGCLAW_OWNER='"));
    if (linha) {
      const v = linha.slice("export DGCLAW_OWNER='".length).replace(/'$/, '').split("'\\''").join("'").trim();
      if (v && v !== 'dono') return v;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') anota(`não consegui ler o nome do dono em ${configArq}: ${e.message}; usei "o dono".`);
  }
  return 'o dono';
}

/** O texto do turno que chega pelo stdin do gancho. Vazio quando não há (teste manual, TTY). */
function promptDoTurno() {
  if (process.stdin.isTTY) return '';
  try {
    const bruto = fs.readFileSync(0, 'utf8');
    if (!bruto.trim()) return '';
    const j = JSON.parse(bruto);
    return typeof j.prompt === 'string' ? j.prompt : '';
  } catch {
    return '';
  }
}

function monta(de, para, novos, dono) {
  const limpos = novos.map(i => (i.texto.length > LIMITE_ITEM ? `${i.texto.slice(0, LIMITE_ITEM - 1)}…` : i.texto));
  const cab = `🆕 O DG Claw foi atualizado (de ${de} para ${para}). Novidades:`;
  const rodape = `Nesta resposta, antes ou depois de atender o pedido, avise ${dono} em 2 a 4 linhas, no seu tom: "vi que você atualizou o DG Claw, o novo está com isso, isso e isso que você pode usar". Só o que ${dono} usa, em linguagem de gente, sem nome de arquivo, rota ou variável. Não repita o aviso nas próximas conversas.`;
  const reserva = cab.length + rodape.length + 4;
  const linhas = [];
  let usado = reserva;
  for (const t of limpos) {
    const l = `- ${t}`;
    if (usado + l.length + 1 > LIMITE && linhas.length) { linhas.push('- (e mais algumas novidades menores)'); break; }
    linhas.push(l);
    usado += l.length + 1;
  }
  return `${cab}\n${linhas.join('\n')}\n${rodape}`;
}

function principal() {
  const semear = process.argv.includes('--semear');
  const versao = lerVersao();
  if (!versao) { if (semear) process.exitCode = 1; return; }
  const itens = lerChangelog();

  if (semear) {
    // Sem CHANGELOG legível ainda grava a versão, com lista vazia: o próximo gancho só avisa se a versão mudar.
    if (!gravaVisto(versao, itens || [])) process.exitCode = 1;
    return;
  }

  const visto = lerVisto();
  if (visto && visto.versao === versao) return;
  if (!itens) return;

  // Só o turno de conversa com o dono consome o aviso. Rotina, batimento e carta de card entram pelo
  // mesmo gancho; se um deles gastasse o aviso, o dono nunca o leria.
  const prompt = promptDoTurno();
  if (prompt && !/<dgchat\s|<channel\s/.test(prompt)) return;

  let novos;
  if (visto) {
    const vistos = new Set(visto.itens);
    novos = itens.filter(i => !vistos.has(digital(i.texto)));
  } else {
    // Agente anterior a este aviso: não há memória do que ele viu. A seção [Não lançado] é o que veio
    // depois da última versão numerada; se ela estiver vazia, vale a seção mais recente.
    novos = itens.filter(i => /não lançado|unreleased/i.test(i.secao));
    if (!novos.length) novos = itens.filter(i => i.secao === itens[0].secao);
    // O CHANGELOG cresce para baixo: o que entrou por último fica no fim. Como o corte descarta o
    // final, aqui o mais recente vem primeiro.
    novos.reverse();
  }

  // Marca antes de imprimir: se a gravação falhar, melhor não avisar do que avisar a cada mensagem.
  if (!gravaVisto(versao, itens)) return;
  if (!novos.length) return;

  const de = visto ? visto.versao : 'uma versão anterior';
  const saida = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: monta(de, versao, novos, nomeDoDono()) } };
  process.stdout.write(`${JSON.stringify(saida)}\n`);
}

try { principal(); } catch (e) { anota(`falha inesperada: ${e.stack || e.message}`); }
process.exit(process.exitCode || 0);
