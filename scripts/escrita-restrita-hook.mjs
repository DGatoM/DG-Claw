#!/usr/bin/env node
// Gancho PreToolUse do Claude Code para a restrição "gravar só em certas pastas" (roda dentro do
// container, como o usuário agente). Vale para Write, Edit, MultiEdit e NotebookEdit. Lê
// /etc/dgclaw-runner/restricoes.json (pasta do dono do servidor, só leitura aqui dentro); sem o arquivo,
// ou com escrita_so_em nulo, libera tudo. Contrato e limites: docs/RESTRICOES-DO-AGENTE.md.
//
// Limite que o dono precisa saber: este gancho só enxerga as ferramentas de arquivo do Claude Code.
// Com o Bash ligado, o agente grava em qualquer lugar por comando de terminal. Para a trava valer de
// verdade, combine com "sem Bash".
//
// Variáveis só para teste: DGCLAW_RESTRICOES (caminho do restricoes.json) e DGCLAW_WORKSPACE (a casa).
import fs from 'node:fs';
import path from 'node:path';

const ARQUIVO = process.env.DGCLAW_RESTRICOES || '/etc/dgclaw-runner/restricoes.json';
const CASA = process.env.DGCLAW_WORKSPACE || '/home/agente';

// O que o agente grava sozinho para funcionar (memória, rotinas, configuração do Claude Code).
// Fica sempre liberado, senão a trava deixaria o agente sem memória.
const INTERNOS_ARQUIVOS = ['MEMORY.md', 'working-memory.md'];
const INTERNOS_PASTAS = ['memory', '.dgclaw', '.claude'];
// Rascunho do sistema, fora da casa; não guarda trabalho do agente.
const TEMPORARIAS = ['/tmp', '/var/tmp'];

function bloqueia(motivo) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: motivo,
      },
    }) + '\n',
  );
  process.exit(0);
}

// Erro inesperado não pode virar "liberado": o Claude Code trata saída com erro comum como falha que
// não bloqueia, e a trava do dono sumiria em silêncio.
process.on('uncaughtException', (e) =>
  bloqueia(`O gancho que limita onde você grava falhou (${e.message}); por segurança nada foi gravado. Avise o dono.`),
);

function libera() {
  process.exit(0);
}

// realpath que aceita caminho que ainda não existe: resolve o ancestral mais fundo que existe
// (seguindo os atalhos dele) e põe o resto de volta. Atalho para fora da casa vira o caminho de fora.
// Atalho quebrado (aponta para algo que não existe) também é seguido: gravar nele criaria o arquivo
// no destino, que pode estar fora das pastas liberadas.
function resolve(caminho, fundo = 0) {
  if (fundo > 20) throw new Error(`atalhos demais seguidos a partir de ${caminho}`);
  let atual = path.resolve(caminho);
  const resto = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(atual), ...resto.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      let destino = null;
      try {
        if (fs.lstatSync(atual).isSymbolicLink()) destino = path.resolve(path.dirname(atual), fs.readlinkSync(atual));
      } catch {
        // não existe nem como atalho: segue subindo
      }
      if (destino) return path.join(resolve(destino, fundo + 1), ...resto.reverse());
      const pai = path.dirname(atual);
      if (pai === atual) return path.join(atual, ...resto.reverse());
      resto.push(path.basename(atual));
      atual = pai;
    }
  }
}

function dentro(alvo, base) {
  const rel = path.relative(base, alvo);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

let restricoes;
try {
  restricoes = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
} catch (e) {
  if (e.code === 'ENOENT') libera();
  // Arquivo que o dono pôs e que não dá para ler: tratar como "sem trava" tiraria a proteção em silêncio.
  bloqueia(
    `O dono limitou onde você pode gravar, mas não consegui ler ${ARQUIVO} (${e.message}). ` +
      'Por segurança nada foi gravado. Avise o dono; quem conserta é ele, com: dgclaw agente restricoes <seu-nome>.',
  );
}

const pastas = restricoes && restricoes.escrita_so_em;
if (pastas === null || pastas === undefined) libera();
if (!Array.isArray(pastas) || pastas.some((p) => typeof p !== 'string')) {
  bloqueia(
    `O dono limitou onde você pode gravar, mas "escrita_so_em" em ${ARQUIVO} não é uma lista de pastas. ` +
      'Por segurança nada foi gravado. Avise o dono para conferir com: dgclaw agente restricoes <seu-nome>.',
  );
}

let entrada;
try {
  entrada = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  bloqueia(`Não consegui ler o pedido de gravação (${e.message}); por segurança nada foi gravado.`);
}

const ti = (entrada && entrada.tool_input) || {};
const pedido = ti.file_path || ti.notebook_path || ti.path;
if (typeof pedido !== 'string' || !pedido) {
  bloqueia('Não consegui saber em que arquivo você quer gravar; por segurança nada foi gravado.');
}

const cwd = typeof entrada.cwd === 'string' && entrada.cwd ? entrada.cwd : CASA;
const alvo = resolve(path.resolve(cwd, pedido));
const casa = resolve(CASA);

const liberadas = [];
for (const p of pastas) {
  const base = resolve(path.join(casa, p));
  // Pasta permitida que hoje aponta para fora da casa (atalho trocado) não vale.
  if (dentro(base, casa)) liberadas.push(base);
}

// O settings.json é do servidor (é nele que este gancho está registrado): nunca liberar a gravação.
if (alvo === path.join(casa, '.claude', 'settings.json')) {
  bloqueia(`${alvo} é gerido pelo servidor e não pode ser alterado por você. Não tente contornar; avise o dono se precisar de outra configuração.`);
}
if (INTERNOS_ARQUIVOS.some((a) => alvo === path.join(casa, a))) libera();
if (INTERNOS_PASTAS.some((d) => dentro(alvo, path.join(casa, d)))) libera();
if (TEMPORARIAS.some((d) => dentro(alvo, d))) libera();
if (liberadas.some((b) => dentro(alvo, b))) libera();

const lista = pastas.map((p) => `${casa}/${p}`).join(', ');
bloqueia(
  `O dono só permite que você grave em: ${lista}. ${alvo} fica fora. ` +
    'Grave dentro de uma dessas pastas ou explique ao dono o que precisa; não tente contornar por outro caminho.',
);
