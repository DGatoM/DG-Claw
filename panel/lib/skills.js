'use strict';
/**
 * skills.js: lista as skills do agente, lendo as pastas `<dir>/<nome>/SKILL.md`.
 *
 * Fonte da verdade e o disco: nada e guardado aqui. Pasta que nao existe nao e erro (o agente
 * pode ainda nao ter nenhuma skill); vira `existe:false` e a tela diz onde procurou. Um SKILL.md
 * ilegivel ou sem frontmatter nao derruba a lista: o item vem com `erro` explicando.
 *
 * O frontmatter e lido na mao (sem dependencia nova) e so entende o que as skills usam de fato:
 * `chave: valor` em uma linha, e descricao em varias linhas com `>` ou `|` (ou com linhas
 * indentadas logo abaixo da chave).
 */
const fs = require('fs');
const path = require('path');

/** Pastas onde procurar: a do agente e as extras de DGCLAW_PANEL_SKILLS_DIR (separadas por virgula). */
function pastasDeSkills(agentDir, extras) {
  // `.agents/skills` e onde o Codex procura as skills (paridade com o Claude).
  const lista = [path.join(agentDir, '.claude', 'skills'), path.join(agentDir, '.agents', 'skills')];
  for (const e of String(extras || '').split(',')) {
    const p = e.trim();
    if (p && !lista.includes(p)) lista.push(p);
  }
  return lista;
}

function tiraAspas(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

const ID_INTEGRACAO = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `integracoes: instagram, openai` (uma linha, separada por virgula) vira a lista de ids validos. */
function lerIntegracoes(valor) {
  const ids = [];
  for (const parte of String(valor || '').split(',')) {
    const id = parte.trim();
    if (ID_INTEGRACAO.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const MAX_CABECALHO = 64 * 1024;

/**
 * Le so o comeco do SKILL.md (o cabecalho basta): abre sem seguir atalho e sem travar em FIFO, confere pelo
 * descritor que e arquivo comum e le no maximo 64 KB. O agente escreve esse arquivo, entao e entrada de fora.
 */
function lerCabecalho(arquivo) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(arquivo, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('não é um arquivo comum');
    const buf = Buffer.alloc(MAX_CABECALHO);
    let lidos = 0;
    while (lidos < MAX_CABECALHO) {
      const n = fs.readSync(fd, buf, lidos, MAX_CABECALHO - lidos, lidos);
      if (n <= 0) break;
      lidos += n;
    }
    return buf.subarray(0, lidos).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Devolve { name, description } do frontmatter, ou null se o arquivo nao abre com `---`. */
function lerFrontmatter(texto) {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/);
  if (linhas[0].trim() !== '---') return null;
  const fim = linhas.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (fim < 0) return null;
  const campos = {};
  for (let i = 1; i < fim; i++) {
    const m = linhas[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, chave, resto] = m;
    if (/^[>|][+-]?$/.test(resto.trim()) || resto.trim() === '') {
      // bloco: junta as linhas indentadas que vem depois
      const partes = [];
      let j = i + 1;
      while (j < fim && (/^\s+\S/.test(linhas[j]) || linhas[j].trim() === '')) { partes.push(linhas[j].trim()); j++; }
      const dobrado = resto.trim().startsWith('|') ? '\n' : ' ';
      campos[chave] = partes.join(dobrado).replace(/\s+$/, '').replace(/ {2,}/g, ' ');
      i = j - 1;
    } else {
      campos[chave] = tiraAspas(resto);
    }
  }
  return campos;
}

function listar(agentDir, extras) {
  const pastas = pastasDeSkills(agentDir, extras);
  const skills = [];
  const infoPastas = [];
  for (const dir of pastas) {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      infoPastas.push({ caminho: dir, existe: false, ...(e.code === 'ENOENT' ? {} : { erro: `não consegui abrir: ${e.message}` }) });
      continue;
    }
    infoPastas.push({ caminho: dir, existe: true });
    for (const ent of entradas.filter((x) => (x.isDirectory() || x.isSymbolicLink())).sort((a, b) => a.name.localeCompare(b.name))) {
      const pasta = path.join(dir, ent.name);
      const arquivo = path.join(pasta, 'SKILL.md');
      if (!fs.existsSync(arquivo)) continue;
      const item = { nome: ent.name, descricao: '', pasta, origem: dir };
      try {
        const fm = lerFrontmatter(lerCabecalho(arquivo));
        if (!fm) item.erro = `O SKILL.md em ${arquivo} não começa com o bloco de cabeçalho entre "---". Peça ao agente para corrigir o arquivo.`;
        else {
          if (fm.name) item.nome = fm.name;
          item.descricao = fm.description || '';
          item.integracoes = lerIntegracoes(fm.integracoes);
          if (!item.descricao) item.erro = `O cabeçalho de ${arquivo} não tem "description".`;
        }
      } catch (e) {
        item.erro = `Não consegui ler ${arquivo}: ${e.message}`;
        console.warn(`[painel] ignorei a skill em ${arquivo}: ${e.message}.`);
      }
      skills.push(item);
    }
  }
  return { skills, pastas: infoPastas };
}

module.exports = { listar, lerCabecalho, MAX_CABECALHO, pastasDeSkills, lerFrontmatter, lerIntegracoes };
