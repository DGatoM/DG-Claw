#!/usr/bin/env node
// Gancho PreToolUse do Claude Code das restrições do dono (roda dentro do container, como o usuário
// agente). Vale para Write, Edit, MultiEdit e NotebookEdit. Lê /etc/dgclaw-runner/restricoes.json (pasta
// do dono do servidor, só leitura aqui dentro) e funciona em dois modos:
//   - escrita_so_em nulo: modo "só protegidos". Libera o resto da casa e bloqueia apenas os caminhos
//     protegidos (abaixo). É o que roda quando o dono travou só o Bash ou só o envio de arquivo;
//   - escrita_so_em com pastas: só grava nelas (mais a memória), e os protegidos também valem DENTRO delas.
// Arquivo ausente ou ilegível bloqueia. Contrato e limites: docs/RESTRICOES-DO-AGENTE.md.
//
// Limite que o dono precisa saber: este gancho só enxerga as ferramentas de arquivo do Claude Code.
// Com o Bash ligado, o agente grava em qualquer lugar por comando de terminal. Para a trava valer de
// verdade, combine com "sem Bash".
//
// A política e a casa são CONSTANTES. Variável de ambiente não serve de fonte: o agente grava `env` no
// settings.local.json dele e apontaria a política para um arquivo que não existe. O comando registrado
// no managed-settings também roda com `env -i` (nem NODE_OPTIONS chega aqui). Só os testes trocam os
// caminhos, por argumento de linha de comando (--restricoes <arquivo> --casa <pasta>), que o
// managed-settings nunca passa e o agente não consegue acrescentar.
import fs from 'node:fs';
import path from 'node:path';

function argumento(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return i > 1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const ARQUIVO = argumento('--restricoes', '/etc/dgclaw-runner/restricoes.json');
const CASA = argumento('--casa', '/home/agente');

// O que o agente grava sozinho: SO a memoria. Tudo o que algum executor do agente (batimento, rotinas,
// ganchos, config.sh, extensoes, MCP, Claude Code) le para EXECUTAR ou como instrucao fica fechado, senao
// "so grava em relatorios" ou "sem Bash" viraria "executa o que quiser".
const INTERNOS_ARQUIVOS = ['MEMORY.md', 'working-memory.md'];
const INTERNOS_PASTAS = ['memory'];

// PROTEGIDOS, em qualquer profundidade e depois de normalizar o caminho (.., barras duplas, atalhos):
//  - todo componente que comece por ponto (pasta ou arquivo oculto): .claude, .dgclaw (config.sh que o
//    batimento carrega com source, ext/*/hooks), .codex, .plataforma (comando do MCP), .config, .bashrc,
//    .profile, .mcp.json, .git/hooks... O Claude Code descobre .claude/skills e .claude/settings em
//    subpastas, entao "relatorios/.claude/skills/x" vale tanto quanto "~/.claude/skills/x";
//  - os arquivos de instrucao/skill do Claude Code em qualquer pasta (SKILL.md pode trazer hook no
//    frontmatter), comparados sem diferenciar maiusculas;
//  - na raiz da casa, os arquivos de identidade que o DG Claw regrava (AGENT.md e afins).
const PROTEGIDOS_NOMES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'skill.md']);
const PROTEGIDOS_RAIZ = new Set(['agent.md', 'personality.md', 'identity.md', 'ethics.md', 'creator.md', 'laws.md']);

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
  // O gancho só está registrado quando o dono ligou alguma restrição. Política ausente ou ilegível
  // (inclusive um arquivo que sumiu) não pode virar "sem trava": tiraria a proteção em silêncio.
  bloqueia(
    `O dono limitou onde você pode gravar, mas não consegui ler ${ARQUIVO} (${e.message}). ` +
      'Por segurança nada foi gravado. Avise o dono; quem conserta é ele, com: dgclaw agente restricoes <seu-nome>.',
  );
}

const pastas = restricoes && restricoes.escrita_so_em;
const soProtegidos = pastas === null || pastas === undefined;
if (!soProtegidos && (!Array.isArray(pastas) || pastas.some((p) => typeof p !== 'string'))) {
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
for (const p of soProtegidos ? [] : pastas) {
  const base = resolve(path.join(casa, p));
  // Pasta permitida que hoje aponta para fora da casa (atalho trocado) não vale.
  if (dentro(base, casa) && base !== casa && !path.relative(casa, base).startsWith('.')) liberadas.push(base);
}

// Protegido: vale para o caminho pedido normalizado E para o resolvido (atalho de uma pasta comum para
// dentro de .dgclaw, por exemplo). Antes de qualquer liberacao, inclusive dentro das pastas liberadas.
function protegido(abs) {
  const rel = path.relative(casa, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const partes = rel.split(path.sep).filter(Boolean);
  for (const parte of partes) {
    if (parte.startsWith('.')) return parte;
  }
  const nome = partes[partes.length - 1].toLowerCase();
  if (PROTEGIDOS_NOMES.has(nome)) return partes[partes.length - 1];
  if (partes.length === 1 && PROTEGIDOS_RAIZ.has(nome)) return partes[0];
  return null;
}
const achado = protegido(alvo) || protegido(path.resolve(cwd, pedido));
if (achado) {
  bloqueia(
    `${alvo} é um arquivo de configuração ou instrução do agente (${achado}), que só o dono altera. ` +
      'Não tente contornar; avise o dono se precisar de outra configuração.',
  );
}
if (soProtegidos) libera();
if (INTERNOS_ARQUIVOS.some((a) => alvo === path.join(casa, a))) libera();
if (INTERNOS_PASTAS.some((d) => dentro(alvo, path.join(casa, d)))) libera();
if (liberadas.some((b) => dentro(alvo, b))) libera();

const lista = pastas.map((p) => `${casa}/${p}`).join(', ');
bloqueia(
  `O dono só permite que você grave em: ${lista}. ${alvo} fica fora. ` +
    'Grave dentro de uma dessas pastas ou explique ao dono o que precisa; não tente contornar por outro caminho.',
);
