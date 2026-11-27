'use strict';
// O idioma pertence à requisição; a mensagem traduzível, a uma propriedade
// identificada por WeakMap. Strings comuns nunca são procuradas num catálogo.
const { AsyncLocalStorage } = require('node:async_hooks');
const I = require('../public/ds/idioma');
const contexto = new AsyncLocalStorage();
const descricoes = new WeakMap();
const propriedades = new WeakMap();
const controles = new WeakMap();
const gravavel = Symbol('dg-ui-gravavel');
const objetoOuFuncao = v => v !== null && (typeof v === 'object' || typeof v === 'function');
const ehDescricao = v => objetoOuFuncao(v) && descricoes.has(v);
function executar(req, padrao, funcao) { return contexto.run({ idioma: I.doCookie(req.headers && req.headers.cookie, padrao) }, funcao); }
function idioma() { return contexto.getStore()?.idioma || 'pt-BR'; }
function original(v) { return ehDescricao(v) ? descricoes.get(v).original : v; }
function parametros(valores, lingua) {
  return valores && Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, ehDescricao(v) ? renderizar(v, lingua) : v]));
}
function renderizar(d, lingua = idioma()) {
  const v = descricoes.get(d);
  return v ? I.frase(v.fonte, parametros(v.valores, lingua), lingua) : d;
}
function descricao(fonte, valores) {
  // Captura dados comuns uma vez; só descrições privadas podem ser encadeadas.
  const copia = valores && Object.freeze(Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, ehDescricao(v) ? v : String(v)])));
  const pt = I.frase(fonte, parametros(copia, 'pt-BR'), 'pt-BR');
  const d = Object.create(null);
  Object.defineProperties(d, {
    [Symbol.toPrimitive]: { value: () => pt }, toString: { value: () => pt },
    // Persistência e logs continuam PT, mesmo dentro de uma requisição EN.
    toJSON: { value: () => pt },
  });
  descricoes.set(d, { fonte, valores: copia, original: pt });
  return Object.freeze(d);
}
function mensagem(fonte, valores) { return I.frase(fonte, parametros(valores, 'pt-BR'), 'pt-BR'); }
function localizar(v) { return ehDescricao(v) ? renderizar(v) : v; }
function texto(fonte, valores) { return I.frase(fonte, parametros(valores, idioma()), idioma()); }
function ativa(obj, chave) {
  if (!objetoOuFuncao(obj)) return undefined;
  const r = propriedades.get(obj)?.get(chave);
  if (!r) return undefined;
  const p = Object.getOwnPropertyDescriptor(obj, chave);
  const c = controles.get(obj)?.get(chave);
  const estado = Object.getOwnPropertyDescriptor(obj, gravavel);
  if (c && p && p.get === c.get && p.set === c.set && estado && estado.value === null && !estado.enumerable && !estado.configurable) return r.descricao;
  propriedades.get(obj).delete(chave);
  return undefined;
}
function controlar(obj, chave, esperado) {
  const p = Object.getOwnPropertyDescriptor(obj, chave);
  let mapa = controles.get(obj);
  const existente = mapa?.get(chave);
  if (existente && p?.get === existente.get && p?.set === existente.set) return existente.valor === esperado;
  if (!p || !Object.hasOwn(p, 'value') || !p.configurable || p.value !== esperado) return false;
  if (!Object.hasOwn(obj, gravavel)) {
    if (!Object.isExtensible(obj)) return false;
    // Seal mantém esse bit gravável; freeze o torna somente leitura. O símbolo
    // não é enumerável, não é copiado por spread/assign e nunca entra no JSON.
    Object.defineProperty(obj, gravavel, { value: null, writable: true, enumerable: false, configurable: false });
  }
  const c = { valor: p.value, gravavel: p.writable };
  c.get = function () { return c.valor; };
  c.set = function (valor) {
    if (!c.gravavel || !Object.getOwnPropertyDescriptor(obj, gravavel)?.writable) throw new TypeError('Cannot assign to read only UI message property');
    if (this !== obj) {
      // Uma escrita num objeto que herdou o campo não altera o objeto de origem.
      Object.defineProperty(this, chave, { value: valor, enumerable: true, writable: true, configurable: true });
      return;
    }
    c.valor = original(valor);
    propriedades.get(obj)?.delete(chave);
    if (ehDescricao(valor)) marcar(obj, chave, valor);
  };
  Object.defineProperty(obj, chave, { get: c.get, set: c.set, enumerable: p.enumerable, configurable: p.configurable });
  mapa = mapa || new Map(); mapa.set(chave, c); controles.set(obj, mapa);
  return true;
}
function marcar(obj, chave, valor) {
  const mapa = propriedades.get(obj);
  if (mapa) mapa.delete(chave);
  if (!ehDescricao(valor)) return;
  if (!controlar(obj, chave, original(valor))) return;
  const registro = mapa || new Map();
  registro.set(chave, { descricao: valor });
  propriedades.set(obj, registro);
}
function campo(obj, chave) { const valor = obj[chave]; return valor ? (ativa(obj, chave) || valor) : valor; }
function definir(obj, chave, valor) { obj[chave] = original(valor); marcar(obj, chave, valor); return original(valor); }
function objeto(obj) {
  for (const chave of Reflect.ownKeys(obj)) {
    const p = Object.getOwnPropertyDescriptor(obj, chave);
    if (p && Object.hasOwn(p, 'value') && ehDescricao(p.value)) definir(obj, chave, p.value);
  }
  return obj;
}
function espalhar(origem) {
  const copia = {};
  if (origem == null) return copia;
  const fonte = Object(origem);
  for (const chave of Reflect.ownKeys(fonte)) {
    if (!Object.getOwnPropertyDescriptor(fonte, chave).enumerable) continue;
    const valor = fonte[chave];
    // Spread define propriedades; não chama o setter de __proto__.
    Object.defineProperty(copia, chave, { value: ativa(fonte, chave) || valor, enumerable: true, writable: true, configurable: true });
  }
  return copia;
}
function atribuir(destino, ...fontes) {
  if (destino == null) throw new TypeError('Cannot convert undefined or null to object');
  const alvo = Object(destino);
  for (const origem of fontes) {
    if (origem == null) continue;
    const fonte = Object(origem);
    for (const chave of Reflect.ownKeys(fonte)) {
      if (!Object.getOwnPropertyDescriptor(fonte, chave).enumerable) continue;
      const valor = fonte[chave];
      definir(alvo, chave, ativa(fonte, chave) || valor);
    }
  }
  return alvo;
}
function registrarErro(erro, valor) { marcar(erro, 'message', valor); return erro; }
function criarErro(Tipo, args, vinculos) {
  const erro = Reflect.construct(Tipo, args.map(original));
  const primeiro = args.findIndex(ehDescricao);
  if (primeiro >= 0) registrarErro(erro, args[primeiro]);
  for (const [caminho, indice] of Object.entries(vinculos || {})) {
    const partes = caminho.split('.'); let alvo = erro;
    for (const p of partes.slice(0, -1)) {
      const d = objetoOuFuncao(alvo) && Object.getOwnPropertyDescriptor(alvo, p);
      alvo = d && Object.hasOwn(d, 'value') ? d.value : undefined;
    }
    if (objetoOuFuncao(alvo)) marcar(alvo, partes.at(-1), args[indice]);
  }
  return erro;
}
function replacer(chave, valor) {
  const propria = ativa(this, chave);
  if (propria) return renderizar(propria);
  // Um descritor direto pode ter passado pelo seu toJSON PT. Inspeciona apenas
  // o campo de dados original, sem repetir getters nem procurar palavras.
  const p = objetoOuFuncao(this) && Object.getOwnPropertyDescriptor(this, chave);
  const direta = p && Object.hasOwn(p, 'value') && p.value;
  if (ehDescricao(direta)) return renderizar(direta);
  return ehDescricao(valor) ? renderizar(valor) : valor;
}
function erro(corpo) {
  // Adaptador explícito: só ramos com identidade própria recebem uma cópia HTTP.
  const vistos = new WeakMap();
  function visitar(v) {
    if (ehDescricao(v)) return renderizar(v);
    if (!v || typeof v !== 'object') return v;
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    if (vistos.has(v)) return vistos.get(v);
    const mudancas = []; vistos.set(v, v);
    for (const k of Object.keys(v)) {
      const p = Object.getOwnPropertyDescriptor(v, k);
      const controle = controles.get(v)?.get(k);
      const controlado = controle && p.get === controle.get && p.set === controle.set;
      if (!Object.hasOwn(p, 'value') && !controlado) continue;
      const valor = controlado ? controle.valor : p.value;
      const propria = ativa(v, k), novo = propria ? renderizar(propria) : visitar(valor);
      if (novo !== valor) mudancas.push([k, novo]);
    }
    if (!mudancas.length) return v;
    const descritores = Object.getOwnPropertyDescriptors(v);
    delete descritores[gravavel];
    for (const [k, c] of controles.get(v) || []) {
      const p = descritores[k];
      if (p && p.get === c.get && p.set === c.set) descritores[k] = { value: c.valor, enumerable: p.enumerable, writable: true, configurable: true };
    }
    for (const [k, novo] of mudancas) descritores[k] = { value: novo, enumerable: true, writable: true, configurable: true };
    const copia = Object.defineProperties(Array.isArray(v) ? new Array(v.length) : Object.create(proto), descritores);
    vistos.set(v, copia); return copia;
  }
  return visitar(corpo);
}
module.exports = { executar, idioma, mensagem, descricao, original, localizar, texto, objeto, campo, definir, espalhar, atribuir, registrarErro, criarErro, replacer, erro };
