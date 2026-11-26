'use strict';
// A mensagem interna continua PT (logs e decisões existentes). Somente textos de
// UI registrados pelo código desta requisição são localizados na saída HTTP.
const { AsyncLocalStorage } = require('node:async_hooks');
const I = require('../public/ds/idioma');
const contexto = new AsyncLocalStorage();
function executar(req, padrao, funcao) {
  return contexto.run({ idioma: I.doCookie(req.headers && req.headers.cookie, padrao), mensagens: new Map() }, funcao);
}
function idioma() { return contexto.getStore()?.idioma || 'pt-BR'; }
function mensagem(fonte, valores) {
  const original = I.frase(fonte, valores, 'pt-BR');
  const atual = contexto.getStore();
  if (atual && atual.idioma !== 'pt-BR' && atual.mensagens.size < 512) {
    // Um erro próprio pode ser parâmetro de outro erro próprio. Não faz lookup
    // global de texto recebido de provedores ou pessoas.
    const parametros = valores && Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, localizar(v)]));
    const traduzida = I.frase(fonte, parametros, atual.idioma);
    if (traduzida !== original) atual.mensagens.set(original, traduzida);
  }
  return original;
}
function localizar(valor) {
  return typeof valor === 'string' ? (contexto.getStore()?.mensagens.get(valor) || valor) : valor;
}
function texto(fonte, valores) { return I.frase(fonte, valores, idioma()); }
function erro(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return corpo;
  let copia;
  for (const chave of ['erro', 'error', 'mensagem', 'como_resolver', 'aviso', 'motivo', 'titulo']) {
    if (!Object.hasOwn(corpo, chave)) continue;
    const traduzido = localizar(corpo[chave]);
    if (traduzido !== corpo[chave]) { if (!copia) copia = { ...corpo }; copia[chave] = traduzido; }
  }
  return copia || corpo;
}
module.exports = { executar, idioma, mensagem, localizar, texto, erro };
