'use strict';
// Kit "skill com dado sensível" (bloco I): validação à mão da definição de uma ferramenta (ferramenta.json) e dos
// parâmetros que o agente manda. Catálogo fechado: campo que não está no esquema é recusado, e não existe tipo "livre".

const RX_NOME = /^[a-z][a-z0-9_-]{0,38}(\.[a-z][a-z0-9_-]{0,38})?$/;
const RX_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RX_PARAM = /^[a-z][a-z0-9_]{0,38}$/;
const RX_PERIODO = /^(20\d{2})-(0[1-9]|1[0-2])$/;
const RX_DATA = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const RX_EXECUTOR = /^executor\.(py|js)$/;
const TIPOS = ['texto', 'inteiro', 'numero', 'booleano', 'enum', 'periodo', 'data'];
const TIPOS_RENUNCIAVEIS = ['data_nascimento'];
const CAMPOS_DEF = ['nome', 'descricao', 'agentes', 'parametros', 'finalidade', 'base_legal', 'campos_usados', 'retencao_dias', 'responsavel',
  'minimo_grupo', 'executor', 'timeout_s', 'memoria_mb', 'gera_arquivo', 'permitir_tipos'];
const CAMPOS_PARAM = {
  texto: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'regex', 'max'],
  inteiro: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'min', 'max'],
  numero: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'min', 'max'],
  booleano: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
  enum: ['tipo', 'descricao', 'obrigatorio', 'padrao', 'valores'],
  periodo: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
  data: ['tipo', 'descricao', 'obrigatorio', 'padrao'],
};

// O caixa do agente responde em 30 s; a ferramenta precisa terminar antes disso para o agente receber a resposta.
const TIMEOUT_MAX_S = 25;

const ehObjeto = (v) => v && typeof v === 'object' && !Array.isArray(v);
const textoSimples = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function validarEsquemaParametro(nome, p) {
  const onde = `o parâmetro "${nome}"`;
  if (!RX_PARAM.test(nome)) return `${onde} tem um nome que não vale (use minúsculas, números e sublinhado, começando por letra)`;
  if (!ehObjeto(p)) return `${onde} precisa ser um objeto com pelo menos "tipo"`;
  if (!TIPOS.includes(p.tipo)) return `${onde} tem tipo ${JSON.stringify(p.tipo)}; os tipos aceitos são: ${TIPOS.join(', ')}`;
  for (const k of Object.keys(p)) if (!CAMPOS_PARAM[p.tipo].includes(k)) return `${onde} (tipo ${p.tipo}) não aceita o campo "${k}"`;
  if (p.obrigatorio !== undefined && typeof p.obrigatorio !== 'boolean') return `${onde}: "obrigatorio" precisa ser true ou false`;
  if (p.tipo === 'texto') {
    if (typeof p.regex !== 'string' || !p.regex) return `${onde} é de tipo texto e por isso precisa de "regex" (texto livre, sem regra, não existe)`;
    try { new RegExp(p.regex); } catch (e) { return `${onde}: a regex não compila (${e.message})`; }
    if (p.max !== undefined && !(Number.isInteger(p.max) && p.max >= 1 && p.max <= 200)) return `${onde}: "max" precisa ser um inteiro de 1 a 200`;
  }
  if ((p.tipo === 'inteiro' || p.tipo === 'numero')) {
    for (const k of ['min', 'max']) if (p[k] !== undefined && !Number.isFinite(p[k])) return `${onde}: "${k}" precisa ser um número`;
  }
  if (p.tipo === 'enum') {
    if (!Array.isArray(p.valores) || !p.valores.length || p.valores.some((v) => typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(v))) {
      return `${onde} é de tipo enum e precisa de "valores": uma lista de textos curtos (letras, números, _ . -)`;
    }
  }
  if (p.padrao !== undefined) {
    const r = validarValor(nome, Object.assign({}, p, { obrigatorio: false }), p.padrao);
    if (!r.ok) return `${onde}: o "padrao" não passa no próprio esquema (${r.erro})`;
  }
  return null;
}

/** Confere ferramenta.json. Devolve { ok: true, def } (com os padrões preenchidos) ou { ok: false, erro } em português. */
function validarDefinicao(bruto, nomePasta) {
  if (!ehObjeto(bruto)) return { ok: false, erro: 'ferramenta.json precisa ser um objeto JSON.' };
  for (const k of Object.keys(bruto)) if (!CAMPOS_DEF.includes(k)) return { ok: false, erro: `ferramenta.json tem o campo "${k}", que não existe. Campos aceitos: ${CAMPOS_DEF.join(', ')}.` };
  const falta = (k) => ({ ok: false, erro: `ferramenta.json: falta "${k}" (ou está vazio).` });
  if (typeof bruto.nome !== 'string' || !RX_NOME.test(bruto.nome)) return { ok: false, erro: `ferramenta.json: "nome" ${JSON.stringify(bruto.nome)} não vale. Use o formato carteira ou carteira.resumo (minúsculas, números, - e _).` };
  if (nomePasta && bruto.nome !== nomePasta) return { ok: false, erro: `ferramenta.json: o nome "${bruto.nome}" é diferente do nome da pasta "${nomePasta}". Os dois precisam ser iguais.` };
  for (const k of ['descricao', 'finalidade', 'base_legal', 'responsavel']) {
    if (!textoSimples(bruto[k], 500)) return falta(k);
    // `dgclaw ferramenta criar` deixa PREENCHER: nos campos que alimentam o RIPD; ferramenta sem eles preenchidos não roda.
    if (/^PREENCHER/.test(bruto[k])) return { ok: false, erro: `ferramenta.json: o campo "${k}" ainda está com o texto PREENCHER. Escreva o conteúdo real (ele alimenta o relatório de impacto) e rode de novo.` };
  }
  if (!Array.isArray(bruto.agentes) || !bruto.agentes.length || bruto.agentes.some((s) => typeof s !== 'string' || !RX_SLUG.test(s))) {
    return { ok: false, erro: 'ferramenta.json: "agentes" precisa ser uma lista com pelo menos um slug de agente (ex.: ["ana"]). Sem agente listado, ninguém usa a ferramenta.' };
  }
  if (!Array.isArray(bruto.campos_usados) || !bruto.campos_usados.length || bruto.campos_usados.some((c) => !textoSimples(c, 80))) {
    return { ok: false, erro: 'ferramenta.json: "campos_usados" precisa listar os campos da base que a ferramenta lê (entra na ficha do RIPD).' };
  }
  if (!Number.isInteger(bruto.retencao_dias) || bruto.retencao_dias < 1 || bruto.retencao_dias > 365) {
    return { ok: false, erro: 'ferramenta.json: "retencao_dias" precisa ser um inteiro de 1 a 365 (por quantos dias um relatório gerado fica na pasta de entregas).' };
  }
  if (!ehObjeto(bruto.parametros)) return { ok: false, erro: 'ferramenta.json: "parametros" precisa ser um objeto (pode ser vazio: {}).' };
  for (const [nome, p] of Object.entries(bruto.parametros)) {
    const e = validarEsquemaParametro(nome, p);
    if (e) return { ok: false, erro: `ferramenta.json: ${e}.` };
  }
  const def = Object.assign({}, bruto);
  def.minimo_grupo = bruto.minimo_grupo === undefined ? 10 : bruto.minimo_grupo;
  if (!Number.isInteger(def.minimo_grupo) || def.minimo_grupo < 2 || def.minimo_grupo > 1000) return { ok: false, erro: 'ferramenta.json: "minimo_grupo" precisa ser um inteiro de 2 a 1000 (o padrão é 10).' };
  def.timeout_s = bruto.timeout_s === undefined ? 20 : bruto.timeout_s;
  if (!Number.isInteger(def.timeout_s) || def.timeout_s < 1 || def.timeout_s > TIMEOUT_MAX_S) {
    return { ok: false, erro: `ferramenta.json: "timeout_s" precisa ser um inteiro de 1 a ${TIMEOUT_MAX_S} (o agente recebe a resposta pela caixa, que espera 30 s no máximo).` };
  }
  def.memoria_mb = bruto.memoria_mb === undefined ? 512 : bruto.memoria_mb;
  if (!Number.isInteger(def.memoria_mb) || def.memoria_mb < 64 || def.memoria_mb > 4096) return { ok: false, erro: 'ferramenta.json: "memoria_mb" precisa ser um inteiro de 64 a 4096.' };
  def.gera_arquivo = bruto.gera_arquivo === undefined ? false : bruto.gera_arquivo;
  if (typeof def.gera_arquivo !== 'boolean') return { ok: false, erro: 'ferramenta.json: "gera_arquivo" precisa ser true ou false.' };
  def.permitir_tipos = bruto.permitir_tipos === undefined ? [] : bruto.permitir_tipos;
  if (!Array.isArray(def.permitir_tipos) || def.permitir_tipos.some((t) => !TIPOS_RENUNCIAVEIS.includes(t))) {
    return { ok: false, erro: `ferramenta.json: "permitir_tipos" só aceita ${TIPOS_RENUNCIAVEIS.join(', ')}. CPF, CNPJ, e-mail, telefone, cartão e nomes da base nunca são liberados.` };
  }
  if (def.executor !== undefined && !RX_EXECUTOR.test(def.executor)) return { ok: false, erro: 'ferramenta.json: "executor" precisa ser executor.py ou executor.js (na pasta da ferramenta).' };
  return { ok: true, def };
}

function validarValor(nome, p, v) {
  const falha = (erro) => ({ ok: false, erro: `O parâmetro "${nome}" ${erro}` });
  switch (p.tipo) {
    case 'texto': {
      const max = p.max || 80;
      if (typeof v !== 'string' || !v.length) return falha('precisa ser um texto não vazio.');
      if (v.length > max) return falha(`passa de ${max} caracteres.`);
      if (/[\u0000-\u001f\u007f]/.test(v)) return falha('não pode ter quebra de linha nem caractere de controle.');
      if (!new RegExp(p.regex).test(v)) return falha(`não tem o formato esperado (${p.regex}).`);
      return { ok: true, valor: v };
    }
    case 'inteiro': {
      const n = typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : v;
      if (!Number.isInteger(n)) return falha('precisa ser um número inteiro.');
      if (p.min !== undefined && n < p.min) return falha(`precisa ser pelo menos ${p.min}.`);
      if (p.max !== undefined && n > p.max) return falha(`precisa ser no máximo ${p.max}.`);
      return { ok: true, valor: n };
    }
    case 'numero': {
      const n = typeof v === 'string' && /^-?\d{1,15}(\.\d{1,10})?$/.test(v) ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return falha('precisa ser um número.');
      if (p.min !== undefined && n < p.min) return falha(`precisa ser pelo menos ${p.min}.`);
      if (p.max !== undefined && n > p.max) return falha(`precisa ser no máximo ${p.max}.`);
      return { ok: true, valor: n };
    }
    case 'booleano': {
      if (v === true || v === 'true') return { ok: true, valor: true };
      if (v === false || v === 'false') return { ok: true, valor: false };
      return falha('precisa ser true ou false.');
    }
    case 'enum':
      if (typeof v !== 'string' || !p.valores.includes(v)) return falha(`precisa ser um destes: ${p.valores.join(', ')}.`);
      return { ok: true, valor: v };
    case 'periodo':
      if (typeof v !== 'string' || !RX_PERIODO.test(v)) return falha('precisa ser um mês no formato AAAA-MM (ex.: 2026-09).');
      return { ok: true, valor: v };
    case 'data':
      if (typeof v !== 'string' || !RX_DATA.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
        return falha('precisa ser uma data real no formato AAAA-MM-DD.');
      }
      return { ok: true, valor: v };
    default:
      return falha('tem um tipo que o kit não conhece.');
  }
}

/** Confere os parâmetros do pedido contra o esquema. Devolve { ok: true, params } ou { ok: false, erro }. */
function validarParametros(esquema, bruto) {
  const entrada = bruto === undefined || bruto === null ? {} : bruto;
  if (!ehObjeto(entrada)) return { ok: false, erro: 'Os parâmetros precisam ser um objeto JSON, por exemplo {"periodo": "2026-09"}.' };
  for (const k of Object.keys(entrada)) {
    if (!Object.prototype.hasOwnProperty.call(esquema, k)) {
      return { ok: false, erro: `O parâmetro "${k.slice(0, 40)}" não existe nesta ferramenta. Parâmetros aceitos: ${Object.keys(esquema).join(', ') || '(nenhum)'}.` };
    }
  }
  const saida = {};
  for (const [nome, p] of Object.entries(esquema)) {
    let v = entrada[nome];
    if (v === undefined || v === null) {
      if (p.padrao !== undefined) v = p.padrao;
      else if (p.obrigatorio) return { ok: false, erro: `Falta o parâmetro "${nome}"${p.descricao ? ` (${p.descricao})` : ''}.` };
      else continue;
    }
    const r = validarValor(nome, p, v);
    if (!r.ok) return r;
    saida[nome] = r.valor;
  }
  return { ok: true, params: saida };
}

/** O que o agente precisa saber de uma ferramenta, sem nada de credencial nem de base. */
function resumoPublico(def) {
  return { nome: def.nome, descricao: def.descricao, finalidade: def.finalidade, parametros: def.parametros, gera_arquivo: def.gera_arquivo, minimo_grupo: def.minimo_grupo };
}

module.exports = { validarDefinicao, validarParametros, resumoPublico, RX_NOME, TIMEOUT_MAX_S };
