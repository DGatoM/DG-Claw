'use strict';
// Contrato do boletim de segurança (docs/interno/CONTRATO-BOLETINS.md, versão 2; a 1 continua sendo lida).
// Um só validador, usado por quem baixa (scripts/checar-boletins.mjs) e por quem serve (web/lib/seguranca.js):
// o arquivo nasceu no GitHub, então é dado não confiável nas duas pontas. Regra de ouro: boletim sem
// fonte_url https válida é DESCARTADO. Nada de alerta sem fonte.

const RX_ID = /^[A-Z0-9][A-Z0-9._-]{2,60}$/;
const RX_DATA = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,12}(Z|[+-]\d{2}:\d{2})$/;
// Controles (menos \n), marcas de direção e invisíveis: texto de aviso não precisa de nenhum deles.
const RX_PROIBIDO = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const RX_PROIBIDO_COM_QUEBRA = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const SEVERIDADES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'desconhecida'];
const ACOES = ['atualizar-dgclaw', 'atualizar-sistema', 'parar-servico', 'aguardar'];
const MAX_BOLETINS = 200;

const tamanho = (s) => Array.from(s).length;

/** Texto obrigatório (ou opcional, com padrão) dentro do limite, sem caractere proibido. Devolve [valor, motivo]. */
function texto(v, campo, max, { quebra = false, opcional = false } = {}) {
  if (v === undefined || v === null) return opcional ? ['', null] : [null, `${campo} ausente`];
  if (typeof v !== 'string') return [null, `${campo} não é texto`];
  if ((quebra ? RX_PROIBIDO : RX_PROIBIDO_COM_QUEBRA).test(v)) return [null, `${campo} tem caractere de controle`];
  const t = v.trim();
  if (!t && !opcional) return [null, `${campo} vazio`];
  if (tamanho(t) > max) return [null, `${campo} passa de ${max} caracteres`];
  return [t, null];
}

/** https:// e nada mais; sem espaço, sem usuário/senha embutidos. */
function urlHttps(v, campo, obrigatoria) {
  if (v === undefined || v === null || v === '') return obrigatoria ? [null, `${campo} ausente`] : [null, null];
  if (typeof v !== 'string') return [null, `${campo} não é texto`];
  if (v.length > 300) return [null, `${campo} passa de 300 caracteres`];
  if (!v.startsWith('https://')) return [null, `${campo} não começa com https://`];
  if (RX_PROIBIDO_COM_QUEBRA.test(v) || /\s/.test(v)) return [null, `${campo} tem espaço ou caractere de controle`];
  if (!/^https:\/\/[^/?#\\@]+(\/|\?|#|$)/.test(v)) return [null, `${campo} não é um endereço https simples`];
  let u;
  try { u = new URL(v); } catch { return [null, `${campo} não é um endereço válido`]; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return [null, `${campo} não é um endereço https simples`];
  return [v, null];
}

function dataIso(v, campo, obrigatoria) {
  if (v === undefined || v === null) return obrigatoria ? [null, `${campo} ausente`] : [null, null];
  if (typeof v !== 'string' || !RX_DATA.test(v) || Number.isNaN(Date.parse(v))) return [null, `${campo} não é uma data ISO`];
  return [v, null];
}

/** { boletim } ou { motivo }. Campos desconhecidos são ignorados (compatibilidade para frente). */
function validaBoletim(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { motivo: 'o item não é um objeto' };
  if (typeof b.id !== 'string' || !RX_ID.test(b.id)) return { motivo: 'id fora do formato' };
  const id = b.id;
  const nega = (m) => ({ id, motivo: m });

  let relacionados = [];
  if (b.relacionados !== undefined && b.relacionados !== null) {
    if (!Array.isArray(b.relacionados) || b.relacionados.length > 20) return nega('relacionados não é uma lista de até 20');
    if (!b.relacionados.every((r) => typeof r === 'string' && RX_ID.test(r))) return nega('relacionados tem id fora do formato');
    relacionados = b.relacionados.slice();
  }
  if (!SEVERIDADES.includes(b.severidade)) return nega('severidade fora da lista');
  if (!ACOES.includes(b.acao)) return nega('acao fora da lista');

  const campos = {};
  for (const [campo, max, opcoes] of [
    ['componente', 80, {}], ['titulo', 120, {}], ['detalhe', 600, { quebra: true }], ['o_que_muda', 400, { opcional: true }],
  ]) {
    const [v, erro] = texto(b[campo], campo, max, opcoes);
    if (erro) return nega(erro);
    campos[campo] = v;
  }
  const [publicado, e1] = dataIso(b.publicado_em, 'publicado_em', true);
  if (e1) return nega(e1);
  const [boletimEm, e2] = dataIso(b.boletim_em, 'boletim_em', false);
  if (e2) return nega(e2);
  const [fonte, e3] = urlHttps(b.fonte_url, 'fonte_url', true);
  if (e3) return nega(e3 === 'fonte_url ausente' ? 'sem fonte_url (nada de alerta sem fonte)' : e3);
  const [noticia, e4] = urlHttps(b.noticia_url, 'noticia_url', false);
  if (e4) return nega(e4);

  return {
    boletim: {
      id, relacionados, severidade: b.severidade, componente: campos.componente, acao: b.acao, titulo: campos.titulo,
      detalhe: campos.detalhe, o_que_muda: campos.o_que_muda, publicado_em: publicado, boletim_em: boletimEm,
      fonte_url: fonte, noticia_url: noticia,
    },
  };
}

/** { boletins, descartados: [{id, motivo}] }. Lança Error com mensagem pronta se o arquivo inteiro não serve. */
function validaArquivo(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('o arquivo não é um objeto JSON');
  if (j.versao !== 1 && j.versao !== 2) throw new Error(`versao ${JSON.stringify(typeof j.versao === 'number' ? j.versao : String(j.versao).slice(0, 20))} não é 1 nem 2`);
  if (!Array.isArray(j.boletins)) throw new Error('"boletins" não é uma lista');
  if (j.boletins.length > MAX_BOLETINS) throw new Error(`mais de ${MAX_BOLETINS} boletins`);
  const boletins = [];
  const descartados = [];
  const vistos = new Set();
  for (const item of j.boletins) {
    const r = validaBoletim(item);
    if (!r.boletim) { descartados.push({ id: r.id || null, motivo: r.motivo }); continue; }
    if (vistos.has(r.boletim.id)) { descartados.push({ id: r.boletim.id, motivo: 'id repetido' }); continue; }
    vistos.add(r.boletim.id);
    boletins.push(r.boletim);
  }
  return { boletins, descartados };
}

const PESO = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, desconhecida: 4 };
/** Mais grave primeiro; empate: o boletim mais recente primeiro. */
function ordena(lista) {
  return lista.slice().sort((a, b) => (PESO[a.severidade] - PESO[b.severidade])
    || (Date.parse(b.boletim_em || b.publicado_em) - Date.parse(a.boletim_em || a.publicado_em)));
}

module.exports = { RX_ID, RX_DATA, SEVERIDADES, ACOES, validaBoletim, validaArquivo, ordena, PESO };
