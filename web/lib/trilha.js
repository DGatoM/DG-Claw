'use strict';
// Trilha de comandos: descreve o tool_use/tool_result do transcript (o que o agente vai rodar). Serve ao cartão
// de permissão e à barrinha de status. Desde 18/10/2026 NÃO vira mais item no histórico da conversa (as linhas
// "rodou: ..." saíram a pedido do dono). Só o que mexe na máquina entra. Tudo passa pela máscara e é cortado.

const { mascarar } = require('./mascara');

const MAX_COMANDO = 1200;
const MAX_SAIDA = 700;
const MAX_LINHAS_SAIDA = 8;
const MAX_TITULO = 140;

// Ferramentas do Claude Code que a trilha mostra. As de conversa (dgchat, telegram, whatsapp) e as de
// leitura pura (Read, Grep, Glob) ficam de fora de propósito: não mudam nada e encheriam a conversa.
const FERRAMENTAS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const corta = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
const umaLinha = (t) => String(t).replace(/\s+/g, ' ').trim();

/** Resumo do que a ferramenta vai fazer: { ferramenta, titulo, comando } já mascarado, ou null se não entra na trilha. */
function descreveUso(nome, inp) {
  if (!FERRAMENTAS.has(nome)) return null;
  const i = inp && typeof inp === 'object' ? inp : {};
  if (nome === 'Bash') {
    const comando = typeof i.command === 'string' ? i.command : '';
    if (!comando.trim()) return null;
    const desc = typeof i.description === 'string' ? i.description.trim() : '';
    return { ferramenta: 'Bash', titulo: corta(mascarar(umaLinha(desc || comando)), MAX_TITULO), comando: corta(mascarar(comando), MAX_COMANDO) };
  }
  const arq = String(i.file_path || i.notebook_path || i.path || '').trim();
  const verbo = nome === 'Write' ? 'gravou' : 'editou';
  const titulo = `${verbo} ${arq || '(arquivo não informado)'}`;
  let detalhe = '';
  if (nome === 'Write' && typeof i.content === 'string') detalhe = `${i.content.length} caracteres`;
  else if (typeof i.new_string === 'string') detalhe = `troca de ${String(i.old_string || '').length} por ${i.new_string.length} caracteres`;
  else if (Array.isArray(i.edits)) detalhe = `${i.edits.length} trocas`;
  return { ferramenta: nome, titulo: corta(mascarar(titulo), MAX_TITULO), comando: corta(mascarar(`${titulo}${detalhe ? ` (${detalhe})` : ''}`), MAX_COMANDO) };
}

// Limites da pergunta de escolha. O Claude Code aceita de 1 a 4 perguntas com 2 a 4 opções; aceitamos até 8
// opções porque o atalho é um dígito só (o "Type something" é opções+1, e precisa continuar sendo um dígito).
const MAX_PERGUNTAS = 4;
const MIN_OPCOES = 2;
const MAX_OPCOES = 8;

/**
 * O input do AskUserQuestion como [{ pergunta, cabecalho, multipla, opcoes:[{rotulo, descricao}] }], mascarado e cortado,
 * ou null se não tem o formato esperado (a tela então manda a pessoa para o terminal, em vez de chutar teclas).
 */
function descrevePerguntas(inp) {
  const qs = inp && Array.isArray(inp.questions) ? inp.questions : null;
  if (!qs || !qs.length || qs.length > MAX_PERGUNTAS) return null;
  const texto = (v, n) => corta(mascarar(umaLinha(typeof v === 'string' ? v : '')), n);
  const saida = [];
  for (const q of qs) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) return null;
    if (!Array.isArray(q.options) || q.options.length < MIN_OPCOES || q.options.length > MAX_OPCOES) return null;
    const opcoes = [];
    for (const o of q.options) {
      if (!o || typeof o.label !== 'string' || !o.label.trim()) return null;
      opcoes.push({ rotulo: texto(o.label, 200), descricao: texto(o.description, 400) });
    }
    saida.push({ pergunta: texto(q.question, 600), cabecalho: texto(q.header, 40), multipla: q.multiSelect === true, opcoes });
  }
  return saida;
}

/** O conteúdo de um tool_result como texto simples. */
function textoDoResultado(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

/** Resumo do resultado: primeiras linhas, cortado, mascarado. { saida, cortado, erro }. */
function descreveResultado(bloco) {
  // mascara ANTES de cortar: um segredo cortado no limite não bate mais com o padrão e vazaria pela metade
  const bruto = mascarar(textoDoResultado(bloco && bloco.content).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim());
  const linhas = bruto ? bruto.split('\n') : [];
  let saida = linhas.slice(0, MAX_LINHAS_SAIDA).join('\n');
  let cortado = linhas.length > MAX_LINHAS_SAIDA;
  if (saida.length > MAX_SAIDA) { saida = saida.slice(0, MAX_SAIDA); cortado = true; }
  return { saida, cortado, erro: !!(bloco && bloco.is_error === true) };
}

/** Texto curto para a faixa/cartão: o que está pendente. */
function resumoPendente(uso) {
  return uso ? { ferramenta: uso.ferramenta, titulo: uso.titulo, comando: uso.comando } : null;
}

module.exports = { descreveUso, descrevePerguntas, descreveResultado, resumoPendente, textoDoResultado, FERRAMENTAS };
