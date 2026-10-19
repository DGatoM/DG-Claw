'use strict';
// A corrente de auditoria inteira: os arquivos mensais já fechados `auditoria-AAAA-MM.jsonl` e o arquivo vivo
// `auditoria.jsonl`, onde a próxima linha sempre entra. Quem grava (web/lib/auditoria.js e lib/enterprise/auditoria.sh)
// e quem lê (verificar, exportar, tela /auditoria, envio para fora) usam as mesmas regras daqui.
//
// Rotação (só nível completo em diante): na primeira gravação de um mês novo, o `auditoria.jsonl` vira
// `auditoria-AAAA-MM.jsonl` (o mês da última linha dele) e começa outro `auditoria.jsonl`. Escolhi manter o nome do
// arquivo vivo para quem já lê `auditoria.jsonl` (testes, ferramentas, o bash) continuar achando a linha mais nova.
// Ordem da corrente: os meses em ordem, depois o vivo. A primeira linha de cada arquivo guarda em `ant` o hash da
// última linha do anterior, então a corrente atravessa os arquivos sem emenda. A trava é sempre `<auditoria.jsonl>.trava`.
//
// Poda por retenção: apagar meses antigos (dgclaw auditoria retencao aplicar) deixa em `auditoria-poda.json`
// o hash da última linha apagada. A conferência passa a esperar esse hash na primeira linha que sobrou.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ZERO = '0'.repeat(64);
const RX_HASH = /,"hash":"([0-9a-f]{64})"\}$/;
const RX_MES = /^auditoria-(\d{4})-(0[1-9]|1[0-2])\.jsonl$/;
/** Retenção padrão da auditoria: 5 anos. É prova de conformidade, por isso é bem maior que `retencao_dias`. */
const RETENCAO_PADRAO_DIAS = 1825;
const RETENCAO_MIN_DIAS = 365;

const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

/** Os arquivos da corrente, em ordem: [{ caminho, nome, mes }] (mes = 'AAAA-MM' para os fechados, null para o vivo). */
function arquivosDaCorrente(base) {
  const pasta = path.dirname(base);
  const vivo = path.basename(base);
  let nomes;
  try { nomes = fs.readdirSync(pasta); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`Não consegui listar a pasta da auditoria ${pasta} (${e.code || e.message}). Confira a permissão da pasta.`);
  }
  const meses = nomes.map((n) => ({ n, m: RX_MES.exec(n) })).filter((x) => x.m).sort((a, b) => (a.n < b.n ? -1 : 1));
  const lista = meses.map((x) => ({ caminho: path.join(pasta, x.n), nome: x.n, mes: `${x.m[1]}-${x.m[2]}` }));
  if (nomes.includes(vivo)) lista.push({ caminho: base, nome: vivo, mes: null });
  return lista;
}

const mesDe = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Fecha o mês: se o arquivo vivo tem a última linha de um mês anterior ao de `ms`, renomeia para auditoria-AAAA-MM.jsonl.
 * Chamar com a trava na mão. Devolve o caminho do arquivo fechado, ou null se não havia o que fechar.
 */
function rotacionar(base, ms, log) {
  if (!fs.existsSync(base) || fs.statSync(base).size === 0) return null;
  const ultima = ultimaLinha(base);
  let t = NaN;
  try { t = Date.parse(JSON.parse(ultima).ts); } catch (_) { /* usa o mtime abaixo */ }
  if (!Number.isFinite(t)) {
    t = fs.statSync(base).mtimeMs;
    if (log) log('aviso', `A última linha de ${base} não tem data legível; usei a data de modificação do arquivo para decidir a rotação do mês.`);
  }
  const mes = mesDe(t);
  if (mes >= mesDe(ms)) return null;
  const destino = path.join(path.dirname(base), `auditoria-${mes}.jsonl`);
  if (fs.existsSync(destino)) {
    throw new Error(`Não consegui fechar o mês ${mes} da auditoria: já existe ${destino}. Isso não deveria acontecer; confira com "dgclaw auditoria verificar" e mova um dos dois arquivos para fora da pasta antes de continuar.`);
  }
  fs.renameSync(base, destino);
  if (log) log('info', `Auditoria: o mês ${mes} foi fechado em ${destino}. A corrente segue no ${base}.`);
  return destino;
}

/** Última linha com conteúdo de um arquivo, ou ''. Lê só o fim. */
function ultimaLinha(caminho) {
  let fd;
  try { fd = fs.openSync(caminho, 'r'); } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
  try {
    let fim = fs.fstatSync(fd).size;
    if (fim === 0) return '';
    let pedaco = 4096;
    let texto = '';
    while (fim > 0) {
      const ini = Math.max(0, fim - pedaco);
      const buf = Buffer.alloc(fim - ini);
      fs.readSync(fd, buf, 0, buf.length, ini);
      texto = buf.toString('utf8') + texto;
      const limpo = texto.replace(/\n+$/, '');
      const i = limpo.lastIndexOf('\n');
      if (i >= 0 || ini === 0) return limpo.slice(i + 1);
      fim = ini;
      pedaco *= 2;
    }
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

/** O `ant` da próxima linha: o hash da última linha da corrente (ou da poda, ou zeros se a trilha está vazia). */
function hashAnterior(base) {
  const u = ultimoHash(base);
  if (u) return u.hash;
  const poda = lerPoda(base);
  return poda ? poda.ate_hash : ZERO;
}

function lerPoda(base) {
  const arq = path.join(path.dirname(base), 'auditoria-poda.json');
  let texto;
  try { texto = fs.readFileSync(arq, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Não consegui ler ${arq} (${e.code || e.message}). Sem ele a conferência da corrente não sabe onde a poda parou.`);
  }
  try {
    const j = JSON.parse(texto);
    if (j && /^[0-9a-f]{64}$/.test(j.ate_hash)) return j;
  } catch (_) { /* cai no erro abaixo */ }
  throw new Error(`${arq} não é um JSON válido com "ate_hash". Restaure a cópia boa; sem ele a conferência da corrente não sabe onde a poda parou.`);
}

/**
 * Confere a corrente inteira. { ok, linhas } ou
 * { ok:false, linhas, quebradaEm (linha, contando desde a primeira da corrente), arquivo, linhaNoArquivo, motivo }.
 */
function verificar(base) {
  const arquivos = arquivosDaCorrente(base);
  let esperado = ZERO;
  const poda = lerPoda(base);
  if (poda) esperado = poda.ate_hash;
  let contadas = 0;
  for (const a of arquivos) {
    const texto = fs.readFileSync(a.caminho, 'utf8');
    const linhas = texto.split('\n');
    if (linhas[linhas.length - 1] === '') linhas.pop();
    for (let i = 0; i < linhas.length; i += 1) {
      const linha = linhas[i];
      const quebra = (motivo) => ({ ok: false, linhas: contadas, quebradaEm: contadas + 1, arquivo: a.nome, linhaNoArquivo: i + 1, motivo });
      const m = RX_HASH.exec(linha);
      if (!m) return quebra('a linha não termina com o campo hash');
      let obj;
      try { obj = JSON.parse(linha); } catch (e) { return quebra(`a linha não é JSON válido (${e.message})`); }
      if (obj.ant !== esperado) {
        return quebra(i === 0 && a.mes
          ? 'o campo ant da primeira linha do mês não bate com a última linha do arquivo anterior (arquivo apagado, trocado ou fora de ordem)'
          : 'o campo ant não bate com o hash da linha anterior (linha apagada, trocada ou reordenada)');
      }
      const corpo = `${linha.slice(0, m.index)}}`;
      if (sha(obj.ant + corpo) !== m[1]) return quebra('o hash não bate com o conteúdo (a linha foi alterada)');
      esperado = m[1];
      contadas += 1;
    }
  }
  return { ok: true, linhas: contadas };
}

/** O hash da última linha da corrente (o que o selo da auditoria externa leva), ou null se não há nenhuma. */
function ultimoHash(base) {
  const arquivos = arquivosDaCorrente(base);
  for (let i = arquivos.length - 1; i >= 0; i -= 1) {
    const m = RX_HASH.exec(ultimaLinha(arquivos[i].caminho));
    if (m) return { hash: m[1], arquivo: arquivos[i].nome };
  }
  return null;
}

/** O hash que a linha declara, se o conteúdo dela ainda produz esse hash. null se a linha foi mexida ou não tem hash. */
function hashConferido(linha) {
  const m = RX_HASH.exec(linha);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(linha); } catch (_) { return null; }
  return sha(String(obj.ant) + linha.slice(0, m.index) + '}') === m[1] ? m[1] : null;
}

/** Marca barata para saber se a corrente mudou (nome, tamanho e mtime de cada arquivo). */
function marcaDaCorrente(base) {
  return arquivosDaCorrente(base).map((a) => {
    const st = fs.statSync(a.caminho);
    return `${a.nome}:${st.size}:${Math.round(st.mtimeMs)}`;
  }).join('|');
}

const RX_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'AAAA-MM-DD' -> ms do início do dia em UTC; null se não for uma data real. */
function inicioDoDia(texto) {
  const m = RX_DIA.exec(String(texto || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

/**
 * Lê os eventos que passam pelo filtro, do mais antigo para o mais novo.
 * filtro: { de, ate (AAAA-MM-DD, inclusivos, UTC), evento, quem, origem, q (texto livre) }.
 * Devolve [{ texto (a linha como foi escrita), obj, arquivo }]. Linha ilegível vira erro explicado: a conferência diz onde.
 */
function lerEventos(base, filtro) {
  const f = filtro || {};
  const de = f.de ? inicioDoDia(f.de) : null;
  const ate = f.ate ? inicioDoDia(f.ate) : null;
  if (f.de && de === null) throw Object.assign(new Error(`A data inicial "${String(f.de).slice(0, 20)}" não é uma data AAAA-MM-DD válida.`), { status: 400 });
  if (f.ate && ate === null) throw Object.assign(new Error(`A data final "${String(f.ate).slice(0, 20)}" não é uma data AAAA-MM-DD válida.`), { status: 400 });
  const fimMs = ate === null ? null : ate + 24 * 3600 * 1000;
  const q = f.q ? String(f.q).toLowerCase() : '';
  const saida = [];
  for (const a of arquivosDaCorrente(base)) {
    if (a.mes) {
      const [ano, mes] = a.mes.split('-').map(Number);
      const ini = Date.UTC(ano, mes - 1, 1);
      const fim = Date.UTC(ano, mes, 1);
      if (de !== null && fim <= de) continue;
      if (fimMs !== null && ini >= fimMs) continue;
    }
    const linhas = fs.readFileSync(a.caminho, 'utf8').split('\n');
    for (const texto of linhas) {
      if (!texto) continue;
      let obj;
      try { obj = JSON.parse(texto); } catch (_) { continue; /* o verificar aponta a linha ruim; aqui ela não entra na lista */ }
      const t = Date.parse(obj.ts);
      if (de !== null && !(t >= de)) continue;
      if (fimMs !== null && !(t < fimMs)) continue;
      if (f.evento && obj.evento !== f.evento) continue;
      if (f.quem && obj.quem !== f.quem) continue;
      if (f.origem && obj.origem !== f.origem) continue;
      if (q && !texto.toLowerCase().includes(q)) continue;
      saida.push({ texto, obj, arquivo: a.nome });
    }
  }
  return saida;
}

const CAMPOS_CSV = ['ts', 'evento', 'quem', 'origem', 'dados', 'ant', 'hash'];
/** Célula de CSV: aspas dobradas, e um apóstrofo na frente do que o Excel leria como fórmula. */
function celulaCsv(v) {
  let s = typeof v === 'string' ? v : JSON.stringify(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Exportação no formato pedido. jsonl devolve as linhas exatamente como foram escritas (continuam conferíveis). */
function exportar(base, filtro, formato) {
  const fmt = formato || 'jsonl';
  if (fmt !== 'jsonl' && fmt !== 'csv') throw Object.assign(new Error(`O formato "${String(fmt).slice(0, 20)}" não existe. Use jsonl ou csv.`), { status: 400 });
  const eventos = lerEventos(base, filtro);
  if (fmt === 'jsonl') return { tipo: 'application/x-ndjson; charset=utf-8', extensao: 'jsonl', total: eventos.length, corpo: eventos.map((e) => `${e.texto}\n`).join('') };
  const linhas = [CAMPOS_CSV.map((c) => `"${c}"`).join(',')];
  for (const e of eventos) linhas.push(CAMPOS_CSV.map((c) => celulaCsv(e.obj[c])).join(','));
  return { tipo: 'text/csv; charset=utf-8', extensao: 'csv', total: eventos.length, corpo: `\ufeff${linhas.join('\r\n')}\r\n` };
}

module.exports = {
  ZERO, RX_HASH, RETENCAO_PADRAO_DIAS, RETENCAO_MIN_DIAS,
  arquivosDaCorrente, rotacionar, mesDe, ultimaLinha, hashAnterior, lerPoda, verificar, ultimoHash, hashConferido, marcaDaCorrente,
  inicioDoDia, lerEventos, exportar, sha,
};
