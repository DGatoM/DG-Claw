'use strict';
// Linha de log NUNCA sai na resposta do diagnóstico: filtro por padrão não é fronteira de confidencialidade
// (um cabeçalho, um nome, uma frase do cliente passam por qualquer lista de padrões). Em vez do texto, sai só
// uma categoria fixa, a contagem, o horário da última ocorrência e, se houver, o código de saída.
// Este módulo é o único lugar que lê texto de log para o diagnóstico, e só devolve frases escritas aqui.

const { MAX_LINHA } = require('./higiene');

const MAX_LINHAS = 500;     // só o fim do arquivo interessa; o resto é descartado sem olhar
const MAX_OCORRENCIAS = 12;
const RX_LINHA_DE_ERRO = /error|erro|falh|fail|traceback|exception|denied|exit|killed|oom|timeout|timed out|refused|unauthori|forbidden|not found|no such|\b(?:401|403|429)\b/i;
const RX_EXCECAO = /^[A-Z][A-Za-z0-9_]{0,40}(?:Error|Exception)$/;
const RX_HORA = /^\[?(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?/;

// A ordem importa: a primeira categoria que casa vence. Tudo em minúsculas e só com literais (custo linear).
const REGRAS = [
  ['comando_ausente', /command not found|comando não encontrado|comando nao encontrado|status=127|executable file not found/],
  ['permissao_negada', /permission denied|permissão negada|permissao negada|eacces|eperm\b|operation not permitted/],
  ['disco_cheio', /no space left|enospc|disk full|disco cheio|sem espaço|sem espaco/],
  ['memoria', /out of memory|\boom\b|oom-kill|killed|sem memória|sem memoria|cannot allocate memory|enomem|memoryerror/],
  ['tempo_esgotado', /timed out|timeout|etimedout|tempo esgotado|deadline exceeded/],
  ['rede', /econnrefused|econnreset|enotfound|ehostunreach|enetunreach|name or service not known|temporary failure in name resolution|network is unreachable|connection refused|connection reset|dns/],
  ['limite', /\b429\b|rate.?limit|usage limit|limite de uso|too many requests|quota/],
  ['login', /\b401\b|\b403\b|unauthori[sz]ed|authentication|forbidden|login|credencial|credential|invalid (?:api )?key|invalid token|token expirado|expired/],
  ['arquivo_ausente', /no such file|enoent|não encontrado|nao encontrado|not found/],
];
const FRASES = {
  permissao_negada: 'permissão negada',
  arquivo_ausente: 'arquivo ou pasta não encontrado',
  disco_cheio: 'sem espaço em disco',
  tempo_esgotado: 'tempo esgotado',
  rede: 'falha de rede ou DNS',
  login: 'credencial recusada ou login expirado',
  limite: 'limite de uso ou 429',
  comando_ausente: 'comando não encontrado',
  python_excecao: 'exceção Python',
  memoria: 'sem memória / killed',
  outro: 'erro não classificado',
};
const CATEGORIAS = Object.freeze(Object.keys(FRASES));

/** Horário no começo da linha, só se trouxer fuso (sem fuso não dá para saber o instante). Milissegundos ou null. */
function horaDaLinha(linha) {
  const m = RX_HORA.exec(linha.slice(0, 48));
  if (!m || !m[7]) return null;
  const fuso = m[7] === 'Z' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(-2)}`;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${fuso}`);
  return Number.isFinite(ms) ? ms : null;
}

/** Nome da classe de exceção Python só se tiver o formato exato; senão null. */
function nomeDaExcecao(linha) {
  for (const tok of linha.split(/[\s:(),;'"=<>[\]]+/, 60)) if (RX_EXCECAO.test(tok)) return tok;
  return null;
}

function categoriaDe(linha) {
  const baixa = linha.toLowerCase();
  for (const [cat, rx] of REGRAS) if (rx.test(baixa)) return { categoria: cat, excecao: null };
  const exc = nomeDaExcecao(linha);
  if (exc || /traceback \(most recent call last\)/.test(baixa)) return { categoria: 'python_excecao', excecao: exc };
  return { categoria: 'outro', excecao: null };
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : null);

/**
 * Classifica as linhas de erro de um texto de log. `soErros` (padrão true) ignora linha que não parece erro;
 * use false quando todas as linhas já são o erro (stderr de comando, detalhe do pulso).
 * Devolve [{ categoria, frase, quantidade, ultima_em }] (mais frequentes primeiro), sem nenhum texto do log.
 * `fallbackMs`: horário a usar quando a linha não traz um com fuso (por exemplo, a data de modificação do arquivo).
 */
function classificar(texto, { soErros = true, fallbackMs = null } = {}) {
  // Fim do texto, no máximo 500 linhas, cada uma cortada em 1000 caracteres ANTES de qualquer regex.
  const linhas = String(texto == null ? '' : texto).split('\n').slice(-MAX_LINHAS).map((l) => l.slice(0, MAX_LINHA));
  const porChave = new Map();
  for (const linha of linhas) {
    if (!linha.trim()) continue;
    if (soErros && !RX_LINHA_DE_ERRO.test(linha)) continue;
    const { categoria, excecao } = categoriaDe(linha);
    const chave = excecao ? `${categoria}:${excecao}` : categoria;
    const frase = excecao ? `${FRASES[categoria]} ${excecao}` : FRASES[categoria];
    const hora = horaDaLinha(linha) ?? fallbackMs;
    const atual = porChave.get(chave) || { categoria, frase, quantidade: 0, ms: null };
    atual.quantidade += 1;
    if (hora != null && (atual.ms == null || hora > atual.ms)) atual.ms = hora;
    porChave.set(chave, atual);
  }
  return [...porChave.values()]
    .sort((a, b) => b.quantidade - a.quantidade)
    .slice(0, MAX_OCORRENCIAS)
    .map((o) => ({ categoria: o.categoria, frase: o.frase, quantidade: o.quantidade, ultima_em: iso(o.ms) }));
}

/**
 * Última barreira, usada ao montar a resposta: reconstrói cada ocorrência só com o que é válido
 * (categoria da lista, frase da lista ou com nome de exceção no formato exato, inteiro, horário ISO).
 */
function sanearOcorrencias(lista) {
  if (!Array.isArray(lista) || !lista.length) return null;
  const limpas = [];
  for (const o of lista.slice(0, MAX_OCORRENCIAS)) {
    if (!o || !CATEGORIAS.includes(o.categoria)) continue;
    let frase = FRASES[o.categoria];
    if (o.categoria === 'python_excecao' && typeof o.frase === 'string' && o.frase.startsWith(`${FRASES.python_excecao} `)) {
      const nome = o.frase.slice(FRASES.python_excecao.length + 1);
      if (RX_EXCECAO.test(nome)) frase = o.frase;
    }
    const q = Number.isInteger(o.quantidade) && o.quantidade > 0 ? o.quantidade : 1;
    const ultima = typeof o.ultima_em === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o.ultima_em) && Number.isFinite(Date.parse(o.ultima_em)) ? o.ultima_em : null;
    limpas.push({ categoria: o.categoria, frase, quantidade: q, ultima_em: ultima });
  }
  return limpas.length ? limpas : null;
}

const total = (ocorrencias) => (ocorrencias || []).reduce((a, o) => a + o.quantidade, 0);

module.exports = { classificar, sanearOcorrencias, horaDaLinha, total, CATEGORIAS, FRASES };
