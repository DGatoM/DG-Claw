'use strict';
// Leitura blindada do estado das integrações de UM agente (docs/PLANO-INTEGRACOES-E-VIGIA.md, seção 3.5).
//
// O Web roda como root e o estado.json é escrito pelo agente, então o arquivo é tratado como entrada hostil:
//   - a casa vem do registro do host (agente.home_host), nunca de dado do agente;
//   - cada componente do caminho fixo (.dgclaw, integracoes, estado.json) é aberto RELATIVO ao descritor do
//     anterior, por /proc/self/fd/<fd>/<nome> (o equivalente a um openat), com O_NOFOLLOW e O_NONBLOCK: um
//     atalho plantado no meio do caminho não desvia a leitura e um FIFO não prende o Web;
//   - cada descritor é conferido com fstat (pasta ou arquivo comum, do UID do agente, nunca do root);
//   - arquivo acima de 64 KiB é recusado inteiro (nunca se lê só o fim);
//   - qualquer falha vira { medido:false, motivo } com texto fixo, e nunca devolve itens.
// "Sem arquivo" (ENOENT) é diferente de "arquivo ruim": o primeiro é lista vazia e medido:true.

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESULTADOS = ['ok', 'credencial_recusada', 'sem_saldo', 'limite', 'fora_do_ar', 'desconectado', 'rede', 'incerto', 'vencendo', 'erro'];
const ESTADOS = ['verde', 'amarelo', 'vermelho', 'sem_uso_recente'];
const MAX_BYTES = 64 * 1024;
const MAX_ITENS = 50;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const COMPONENTES = ['.dgclaw', 'integracoes'];

const C = fs.constants;
const FLAGS_BASE = C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK;
const FLAGS_PASTA = FLAGS_BASE | C.O_DIRECTORY;

class Recusa extends Error {
  constructor(motivo, ausente) { super(motivo); this.motivo = motivo; this.ausente = !!ausente; }
}

const ehIsoOuNulo = (v) => v === null || (typeof v === 'string' && ISO_RE.test(v));

/** Mesmo esquema de validarEstado (panel/lib/integracoes.js), mais ultimaTentativaReal. Devolve { itens } ou { erro }. */
function validarEstado(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.versao !== 1 || !Array.isArray(j.integracoes)) {
    return { erro: 'o estado.json não tem o formato esperado' };
  }
  if (j.integracoes.length > MAX_ITENS) return { erro: 'o estado.json lista integrações demais' };
  const itens = [];
  const vistos = new Set();
  for (const it of j.integracoes) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID_RE.test(it.id) || vistos.has(it.id) || !ESTADOS.includes(it.estado)
        || !RESULTADOS.includes(it.ultimoResultado) || typeof it.ultimoEvento !== 'string' || !ISO_RE.test(it.ultimoEvento)
        || !ehIsoOuNulo(it.ultimoOk ?? null) || !ehIsoOuNulo(it.ultimaFalha ?? null) || !ehIsoOuNulo(it.ultimaTentativaReal ?? null)
        || !(it.ultimaFalhaResultado == null || RESULTADOS.includes(it.ultimaFalhaResultado))) {
      return { erro: 'o estado.json tem uma integração fora do formato (ou com id repetido)' };
    }
    vistos.add(it.id);
    itens.push({
      id: it.id, estado: it.estado, ultimoEvento: it.ultimoEvento, ultimoResultado: it.ultimoResultado,
      ultimoOk: it.ultimoOk ?? null, ultimaTentativaReal: it.ultimaTentativaReal ?? null,
      ultimaFalha: it.ultimaFalha ?? null, ultimaFalhaResultado: it.ultimaFalhaResultado ?? null,
    });
  }
  return { itens };
}

/** Abre `nome` relativo ao descritor `fdPai`. ENOENT vira Recusa(ausente). */
function abreRelativo(fdPai, nome, flags) {
  try {
    return fs.openSync(`/proc/self/fd/${fdPai}/${nome}`, flags);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Recusa('não existe', true);
    throw new Recusa('o caminho do agente não passou na conferência de segurança');
  }
}

/** Lê o arquivo `nomeArquivo` dentro de <casa>/.dgclaw/integracoes. Devolve { ausente:true } ou { texto } ou lança Recusa. */
function lerTexto(agente, nomeArquivo) {
  if (!agente || typeof agente.home_host !== 'string' || !path.isAbsolute(agente.home_host)) throw new Recusa('o agente não tem casa registrada no host');
  if (!fs.existsSync('/proc/self/fd')) throw new Recusa('este sistema não tem /proc, a leitura segura não é possível');
  const abertos = [];
  const abre = (fn) => { const fd = fn(); abertos.push(fd); return fd; };
  try {
    let realCasa;
    try { realCasa = fs.realpathSync(agente.home_host); } catch (e) { throw new Recusa('a casa do agente não está acessível'); }
    let fdCasa;
    try { fdCasa = abre(() => fs.openSync(agente.home_host, FLAGS_PASTA)); } catch (e) {
      if (e instanceof Recusa) throw e;
      throw new Recusa('a casa do agente não está acessível');
    }
    const stCasa = fs.fstatSync(fdCasa);
    if (!stCasa.isDirectory() || stCasa.uid === 0) throw new Recusa('a casa do agente não pertence ao agente');
    const uid = stCasa.uid;

    let fdAtual = fdCasa;
    for (const nome of COMPONENTES) {
      try { fdAtual = abre(() => abreRelativo(fdAtual, nome, FLAGS_PASTA)); } catch (e) {
        if (e instanceof Recusa && e.ausente) return { ausente: true };
        throw e;
      }
      const st = fs.fstatSync(fdAtual);
      if (!st.isDirectory() || st.uid !== uid) throw new Recusa('uma pasta do caminho não pertence ao agente');
    }
    let fdArq;
    try { fdArq = abre(() => abreRelativo(fdAtual, nomeArquivo, FLAGS_BASE)); } catch (e) {
      if (e instanceof Recusa && e.ausente) return { ausente: true };
      throw e;
    }
    const st = fs.fstatSync(fdArq);
    if (!st.isFile() || st.uid !== uid) throw new Recusa('o arquivo não é um arquivo comum do agente');
    if (st.size > MAX_BYTES) throw new Recusa('o arquivo é grande demais');
    let destino;
    try { destino = fs.readlinkSync(`/proc/self/fd/${fdArq}`); } catch (e) { throw new Recusa('não consegui conferir onde o arquivo está'); }
    if (!destino.startsWith(`${realCasa}/`)) throw new Recusa('o arquivo está fora da casa do agente');

    const buf = Buffer.alloc(MAX_BYTES + 1);
    let lidos = 0;
    while (lidos < buf.length) {
      let n;
      try { n = fs.readSync(fdArq, buf, lidos, buf.length - lidos, null); } catch (e) {
        if (e.code === 'EAGAIN') throw new Recusa('o arquivo não pôde ser lido');
        throw new Recusa('o arquivo não pôde ser lido');
      }
      if (n <= 0) break;
      lidos += n;
    }
    if (lidos > MAX_BYTES) throw new Recusa('o arquivo é grande demais');
    return { texto: buf.subarray(0, lidos).toString('utf8') };
  } catch (e) {
    if (e instanceof Recusa) throw e;
    throw new Recusa('o arquivo não pôde ser lido com segurança');
  } finally {
    for (const fd of abertos) { try { fs.closeSync(fd); } catch (_) { /* já fechado */ } }
  }
}

/** Estado das integrações de um agente: { medido:true, itens } ou { medido:false, motivo }. */
function lerEstado(agente) {
  if (!agente || agente.tipo === 'admin' || typeof agente.home_host !== 'string' || !agente.home_host) {
    return { medido: false, motivo: 'este agente não é medido (sem casa registrada, ou é o Admin)' };
  }
  try {
    const r = lerTexto(agente, 'estado.json');
    if (r.ausente) return { medido: true, itens: [] };
    let j;
    try { j = JSON.parse(r.texto); } catch (_) { return { medido: false, motivo: 'o estado.json está com o JSON quebrado' }; }
    const v = validarEstado(j);
    if (v.erro) return { medido: false, motivo: v.erro };
    return { medido: true, itens: v.itens };
  } catch (e) {
    return { medido: false, motivo: e.motivo || 'falha ao ler o estado das integrações' };
  }
}

module.exports = { lerEstado, validarEstado, MAX_BYTES, ID_RE };
