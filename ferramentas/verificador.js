'use strict';
// Verificador de saída do kit sensível (bloco I). Roda no serviço de ferramentas, DEPOIS do executor e ANTES de devolver
// o resultado ao agente. Procura CPF, CNPJ, e-mail, telefone brasileiro, data de nascimento, cartão (Luhn) e os nomes
// de pessoas da própria base. Se achar qualquer um, quem chama bloqueia a resposta inteira.
//
// É uma rede de segurança contra erro do executor, não uma defesa contra um executor mal-intencionado: quem escreve o
// executor é de confiança, e um texto que esconde o CPF (dígitos separados por letras, por exemplo) passa.
// O verificador devolve só o TIPO e a QUANTIDADE do que achou, nunca o dado.

const SEP = '\u0001';

function soDigitos(s) { return s.replace(/\D/g, ''); }

function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (const tam of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(d[i]) * (tam + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(d[tam])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  for (const tam of [12, 13]) {
    const pesos = tam === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    const dv = r < 2 ? 0 : 11 - r;
    if (dv !== Number(d[tam])) return false;
  }
  return true;
}

function luhnValido(d) {
  let soma = 0;
  let dobra = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dobra) { n *= 2; if (n > 9) n -= 9; }
    soma += n;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

const DDD_VALIDO = new Set(['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99']);

const RX_CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const RX_CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
const RX_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RX_FONE = /(?<![\d])(?:\+?55[ -]?)?\(?[1-9]\d\)?[ -]?9?\d{4}[ -]?\d{4}(?!\d)/g;
const RX_FONE_CURTO = /(?<![\d])9\d{4}-\d{4}(?!\d)/g;
const RX_DATA_BR = /(?<!\d)(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])[/.-]((?:19|20)\d{2})(?!\d)/g;
const RX_DATA_ISO = /(?<!\d)((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/g;
const RX_CARTAO = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

function dataReal(a, m, d) {
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizar(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Todo texto e todo número do resultado, na ordem, separados por SEP (chaves também contam). */
function coletarTextos(valor, saida, profundidade) {
  if (profundidade > 40) return saida;
  if (valor === null || valor === undefined) return saida;
  if (typeof valor === 'string') saida.push(valor);
  else if (typeof valor === 'number' || typeof valor === 'boolean') saida.push(String(valor));
  else if (Array.isArray(valor)) for (const v of valor) coletarTextos(v, saida, profundidade + 1);
  else if (typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) { saida.push(k); coletarTextos(v, saida, profundidade + 1); }
  }
  return saida;
}

/**
 * Procura dado pessoal em `conteudo` (texto, ou objeto/lista JSON). Opções:
 *   nomes      lista de nomes de pessoas da própria base (qualquer escrita, com ou sem acento);
 *   permitir   tipos que a ferramenta pode devolver (só "data_nascimento" é renunciável);
 *   agora      instante de referência (ms), para decidir o que é data de nascimento.
 * Devolve { achou: boolean, tipos: [...], quantidade: { tipo: n } }. Nunca devolve o trecho achado.
 */
function verificar(conteudo, opcoes) {
  const o = opcoes || {};
  const permitir = new Set(o.permitir || []);
  const anoAtual = new Date(o.agora != null ? o.agora : Date.now()).getUTCFullYear();
  const texto = typeof conteudo === 'string' ? conteudo : coletarTextos(conteudo, [], 0).join(SEP);
  const contagem = {};
  const soma = (tipo, n) => { if (n) contagem[tipo] = (contagem[tipo] || 0) + n; };

  const casos = (rx) => Array.from(texto.matchAll(rx), (m) => m[0]);
  soma('cpf', casos(RX_CPF).filter((s) => cpfValido(soDigitos(s))).length);
  soma('cnpj', casos(RX_CNPJ).filter((s) => cnpjValido(soDigitos(s))).length);
  soma('email', casos(RX_EMAIL).length);

  let fones = 0;
  for (const s of casos(RX_FONE)) {
    const d = soDigitos(s);
    const formatado = /[()+ -]/.test(s);
    const sem55 = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
    if (!DDD_VALIDO.has(sem55.slice(0, 2)) || ![10, 11].includes(sem55.length)) continue;
    // Número cru só conta quando é celular de 11 dígitos (DDD + 9): dez dígitos soltos são quase sempre uma soma.
    if (!formatado && !(sem55.length === 11 && sem55[2] === '9')) continue;
    if (cpfValido(d) || cnpjValido(d)) continue;
    fones++;
  }
  fones += casos(RX_FONE_CURTO).length;
  soma('telefone', fones);

  if (!permitir.has('data_nascimento')) {
    let datas = 0;
    const antiga = (a) => a >= 1900 && a < anoAtual;
    for (const m of texto.matchAll(RX_DATA_BR)) if (dataReal(Number(m[3]), Number(m[2]), Number(m[1])) && antiga(Number(m[3]))) datas++;
    for (const m of texto.matchAll(RX_DATA_ISO)) if (dataReal(Number(m[1]), Number(m[2]), Number(m[3])) && antiga(Number(m[1]))) datas++;
    soma('data_nascimento', datas);
  }

  soma('cartao', casos(RX_CARTAO).filter((s) => {
    const d = soDigitos(s);
    return d.length >= 13 && d.length <= 19 && luhnValido(d) && !cnpjValido(d) && !cpfValido(d);
  }).length);

  const nomes = new Set();
  let maxPalavras = 0;
  for (const n of o.nomes || []) {
    if (typeof n !== 'string') continue;
    const norm = normalizar(n);
    if (norm.length < 4) continue;
    nomes.add(norm);
    maxPalavras = Math.max(maxPalavras, norm.split(' ').length);
  }
  if (nomes.size) {
    let achados = 0;
    for (const trecho of texto.split(SEP)) {
      const palavras = normalizar(trecho).split(' ').filter(Boolean);
      for (let i = 0; i < palavras.length; i++) {
        for (let n = 1; n <= maxPalavras && i + n <= palavras.length; n++) {
          if (nomes.has(palavras.slice(i, i + n).join(' '))) achados++;
        }
      }
    }
    soma('nome', achados);
  }

  const tipos = Object.keys(contagem);
  return { achou: tipos.length > 0, tipos, quantidade: contagem };
}

const ROTULO = { cpf: 'CPF', cnpj: 'CNPJ', email: 'e-mail', telefone: 'telefone', data_nascimento: 'data de nascimento', cartao: 'cartão', nome: 'nome de pessoa da base' };

function mensagemDeBloqueio(tipos) {
  const lista = tipos.map((t) => ROTULO[t] || t).join(', ');
  return `O resultado foi bloqueado porque continha dado pessoal (tipo ${lista}). Nada foi entregue. Peça ao responsável pela ferramenta para corrigir o executor, que deve devolver só números agregados.`;
}

module.exports = { verificar, mensagemDeBloqueio, cpfValido, cnpjValido, luhnValido, normalizar };
