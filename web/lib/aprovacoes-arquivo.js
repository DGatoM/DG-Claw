'use strict';
// Armazenamento das aprovações: <dataDir>/aprovacoes/<id>.json (pasta 700, arquivo 600), um arquivo por pedido.
// É compartilhado por dois processos que rodam como root: o Web (cria, aprova, recusa, marca executada) e o
// serviço de controle (confere e consome a aprovação antes de executar). Por isso toda mudança passa por
// `atualizar`, que pega uma trava por pedido (`mkdir <id>.trava`, a mesma ideia da auditoria).
// Quem escreve usa o gravador seguro (grava-seguro.js): a pasta fica dentro do dataDir, sem atalho.
// Contrato dos campos e do fluxo: web/lib/ent/aprovacoes.js e docs/enterprise/CONTROLE.md.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gravaArquivoSeguro, ErroGravacao } = require('./grava-seguro');

const RX_ID = /^[0-9a-f]{24}$/;
const TRAVA_VELHA_MS = 30 * 1000;
const ESPERA_MAX_MS = 10 * 1000;
const DORME = new Int32Array(new SharedArrayBuffer(4));

class ErroAprovacao extends Error {
  constructor(mensagem, status, codigo) {
    super(mensagem);
    this.name = 'ErroAprovacao';
    this.status = status || 500;
    this.codigo = codigo || 'ERRO';
  }
}

/** JSON com as chaves em ordem alfabética em todos os níveis: o mesmo valor dá sempre o mesmo texto. */
function canonico(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
}

/** Hash dos parâmetros de um pedido. O Web grava este valor; o controle o recalcula antes de executar. */
function hashParams(params) {
  return crypto.createHash('sha256').update(canonico(params == null ? {} : params)).digest('hex');
}

function criarArmazem({ dataDir, log }) {
  if (!dataDir) throw new Error('criarArmazem precisa do dataDir (a pasta de dados do Web, por exemplo /var/lib/dgclaw/web).');
  const pasta = path.join(dataDir, 'aprovacoes');
  const avisa = log || (() => {});

  function garantePasta() {
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      fs.chmodSync(pasta, 0o700);
    } catch (e) {
      throw new ErroAprovacao(`Não consegui preparar a pasta das aprovações ${pasta} (${e.code || e.message}). Confira a permissão de ${dataDir}; sem ela nenhum pedido perigoso pode ser guardado.`, 503, 'PASTA');
    }
  }

  const caminhoDe = (id) => path.join(pasta, `${id}.json`);
  const exigeId = (id) => {
    if (typeof id !== 'string' || !RX_ID.test(id)) throw new ErroAprovacao(`O identificador "${String(id).slice(0, 40)}" não é de uma aprovação (são 24 caracteres entre 0-9 e a-f).`, 400, 'ID');
  };

  function lerArquivo(id) {
    let texto;
    try { texto = fs.readFileSync(caminhoDe(id), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new ErroAprovacao(`Não consegui ler a aprovação ${id} (${e.code || e.message}). Confira a permissão de ${pasta}.`, 503, 'LEITURA');
    }
    try { return JSON.parse(texto); } catch (e) {
      throw new ErroAprovacao(`O arquivo da aprovação ${id} não é um JSON válido (${e.message}). Restaure a cópia de segurança ou apague ${caminhoDe(id)} depois de anotar o que ele pedia.`, 500, 'JSON');
    }
  }

  function gravar(reg) {
    try {
      gravaArquivoSeguro(caminhoDe(reg.id), JSON.stringify(reg, null, 2) + '\n', { raiz: dataDir, modo: 0o600 });
    } catch (e) {
      if (e instanceof ErroGravacao) throw new ErroAprovacao(`Não consegui gravar a aprovação ${reg.id}: ${e.message}`, 503, 'GRAVACAO');
      throw e;
    }
  }

  function pegarTrava(id) {
    const trava = `${caminhoDe(id)}.trava`;
    const limite = Date.now() + ESPERA_MAX_MS;
    for (;;) {
      try { fs.mkdirSync(trava); return trava; } catch (e) {
        if (e.code !== 'EEXIST') throw new ErroAprovacao(`Não consegui criar a trava ${trava} (${e.code || e.message}). Confira a permissão de ${pasta}.`, 503, 'TRAVA');
      }
      let idade = 0;
      try { idade = Date.now() - fs.statSync(trava).mtimeMs; } catch (_) { continue; }
      if (idade > TRAVA_VELHA_MS) {
        avisa('aviso', `A trava ${trava} tinha ${Math.round(idade / 1000)} s (mais de 30); o processo que a criou provavelmente morreu. Estou removendo e seguindo.`);
        try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      if (Date.now() > limite) throw new ErroAprovacao(`Outro processo segura a aprovação ${id} há mais de ${ESPERA_MAX_MS / 1000} s (${trava}). Tente de novo; se nada estiver rodando, apague a pasta ${trava}.`, 503, 'TRAVA');
      Atomics.wait(DORME, 0, 0, 20);
    }
  }

  return {
    pasta,
    novoId: () => crypto.randomBytes(12).toString('hex'),
    ehId: (id) => typeof id === 'string' && RX_ID.test(id),

    /** Guarda um pedido novo. Recusa se o id já existe. */
    criar(reg) {
      exigeId(reg.id);
      garantePasta();
      const trava = pegarTrava(reg.id);
      try {
        if (fs.existsSync(caminhoDe(reg.id))) throw new ErroAprovacao(`Já existe a aprovação ${reg.id}.`, 409, 'EXISTE');
        gravar(reg);
      } finally {
        try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') avisa('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}).`); }
      }
      return reg;
    },

    /** O pedido, ou null se não existe. */
    ler(id) {
      exigeId(id);
      return lerArquivo(id);
    },

    /** Todos os pedidos, do mais novo para o mais velho. Arquivo estragado é pulado com aviso no log. */
    listar() {
      let nomes;
      try { nomes = fs.readdirSync(pasta); } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw new ErroAprovacao(`Não consegui listar ${pasta} (${e.code || e.message}). Confira a permissão da pasta.`, 503, 'LISTA');
      }
      const lista = [];
      for (const n of nomes) {
        const m = /^([0-9a-f]{24})\.json$/.exec(n);
        if (!m) continue;
        try {
          const r = lerArquivo(m[1]);
          if (r) lista.push(r);
        } catch (e) {
          avisa('erro', e.message);
        }
      }
      return lista.sort((a, b) => String(b.pedido_em).localeCompare(String(a.pedido_em)));
    },

    /**
     * Muda um pedido sob trava. `fn(reg)` muda o objeto e pode devolver { semMudanca: true }; se lançar, nada é gravado.
     * Devolve o pedido como ficou.
     */
    atualizar(id, fn) {
      exigeId(id);
      garantePasta();
      const trava = pegarTrava(id);
      try {
        const reg = lerArquivo(id);
        if (!reg) throw new ErroAprovacao(`Não existe a aprovação ${id}.`, 404, 'NAO_EXISTE');
        const r = fn(reg);
        if (!(r && r.semMudanca === true)) gravar(reg);
        return reg;
      } finally {
        try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') avisa('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}).`); }
      }
    },
  };
}

module.exports = { criarArmazem, hashParams, canonico, ErroAprovacao, RX_ID };
