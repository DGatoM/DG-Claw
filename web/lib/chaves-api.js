'use strict';
// Chaves de API do DG Claw Web (Bearer). Hoje existe um só uso: a chave de SUPORTE, que
// lê o diagnóstico de saúde (GET /api/v1/diagnostico) e não faz mais nada.
//
// Mesmo modelo do panel/lib/chaves-api.js:
//   - guarda-se SÓ o hash (sha256). O token aparece uma vez, na criação;
//   - nenhuma chave gerencia chaves (a recusa fica no porteiro do server.js);
//   - revogar é datar: o registro fica, com quem revogou e quando.
// Diferenças: cada chave tem `escopos` (o que ela pode fazer) e anota o último uso com o IP.
//
// O arquivo é relido quando o mtime ou o tamanho muda, porque a CLI (bin/chave-api.js) cria e
// revoga chave com o Web rodando e o Web precisa enxergar na hora.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIXO = 'dgc_';
const ESCOPOS = Object.freeze(['diagnostico']);
const USO_MIN_INTERVALO_MS = 60 * 1000;
const FALHAS_MAX = 20;
const JANELA_FALHAS_MS = 10 * 60 * 1000;
const FORMATO_BEARER = /^\s*Bearer\s+(dgc_[A-Za-z0-9_-]{20,})\s*$/i;

function recusa(erro, status, comoResolver) {
  const r = { ok: false, erro, status: status || 400 };
  if (comoResolver) r.como_resolver = comoResolver;
  return r;
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest();

function criarChavesApi({ config, log, agora }) {
  const ARQUIVO = config.chavesApiArquivo || path.join(config.dataDir, 'chaves-api.json');
  const relogio = agora || Date.now;
  const ultimoRegistroDeUso = new Map();   // id -> ms da última gravação de ultimoUsoEm
  const falhas = new Map();                // ip -> [ms das tentativas inválidas]
  let cache = null;                        // { mtimeMs, tamanho, dados }

  function ler() {
    let stat;
    try { stat = fs.statSync(ARQUIVO); } catch (e) {
      if (e.code === 'ENOENT') return { schema: 1, chaves: [] };
      log('erro', `Chaves de API: não consegui olhar ${ARQUIVO} (${e.code || e.message}). Nenhuma chave de API vale até o arquivo ficar acessível.`);
      return { schema: 1, chaves: [] };
    }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.tamanho === stat.size) return cache.dados;
    try {
      const dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
      if (dados && Array.isArray(dados.chaves)) {
        cache = { mtimeMs: stat.mtimeMs, tamanho: stat.size, dados };
        return dados;
      }
      log('erro', `Chaves de API: ${ARQUIVO} não tem a lista "chaves". Nenhuma chave de API vale até o arquivo ser consertado.`);
    } catch (err) {
      // Arquivo ilegível NÃO vira "nenhuma chave" em silêncio: o efeito é recusar todo
      // pedido por chave, e quem administra precisa saber por quê.
      log('erro', `Chaves de API: não consegui ler ${ARQUIVO} (${err.message}). Nenhuma chave de API vale até o arquivo ser consertado.`);
    }
    return { schema: 1, chaves: [] };
  }

  // Escrita atômica: grava ao lado e renomeia. Um corte de luz no meio deixaria o arquivo
  // pela metade, e aí todas as chaves deixariam de valer.
  function gravar(dados) {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true, mode: 0o700 });
    const tmp = `${ARQUIVO}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* sistema de arquivos sem modo: o mode do writeFileSync já valeu */ }
    fs.renameSync(tmp, ARQUIVO);
    cache = null;
  }

  function publica(c) {
    return {
      id: c.id,
      nome: c.nome,
      escopos: Array.isArray(c.escopos) ? c.escopos.slice() : [],
      ultimos4: c.ultimos4,
      criadaPor: c.criadaPor,
      criadaEm: c.criadaEm,
      ultimoUsoEm: c.ultimoUsoEm || null,
      ultimoUsoIp: c.ultimoUsoIp || null,
      revogadaEm: c.revogadaEm || null,
      revogadaPor: c.revogadaPor || null,
    };
  }

  function listar() {
    return ler().chaves.map(publica);
  }

  function criar({ nome, escopos, quem } = {}) {
    const limpo = String(nome == null ? '' : nome).trim();
    if (!limpo) {
      return recusa('Faltou o nome da chave, que diz para quem ela é.', 400,
        'Dê um nome que lembre quem vai usá-la, por exemplo "Suporte DG".');
    }
    if (limpo.length > 60 || /[\x00-\x1f\x7f]/.test(limpo)) {
      return recusa('O nome da chave tem mais de 60 caracteres ou tem quebra de linha ou caractere invisível.', 400,
        'Use um nome curto, de uma linha só.');
    }
    if (!Array.isArray(escopos) || !escopos.length) {
      return recusa('Faltou o escopo da chave: ela precisa dizer o que pode fazer.', 400,
        `Mande "escopos" com um ou mais destes valores: ${ESCOPOS.join(', ')}.`);
    }
    const desconhecidos = escopos.filter((e) => !ESCOPOS.includes(e));
    if (desconhecidos.length) {
      return recusa(`Não conheço o escopo ${desconhecidos.map((e) => `"${String(e).slice(0, 30)}"`).join(', ')}.`, 400,
        `Os escopos aceitos hoje são: ${ESCOPOS.join(', ')}.`);
    }
    const token = PREFIXO + crypto.randomBytes(32).toString('base64url');
    const dados = ler();
    const reg = {
      id: crypto.randomBytes(5).toString('hex'),
      nome: limpo,
      escopos: [...new Set(escopos)],
      hash: sha256(token).toString('hex'),
      ultimos4: token.slice(-4),
      criadaPor: String(quem || 'Dono').slice(0, 80),
      criadaEm: new Date(relogio()).toISOString(),
      ultimoUsoEm: null,
      ultimoUsoIp: null,
      revogadaEm: null,
      revogadaPor: null,
    };
    try {
      gravar({ schema: 1, chaves: [...dados.chaves, reg] });
    } catch (err) {
      log('erro', `Chaves de API: não consegui gravar ${ARQUIVO} (${err.code || err.message}).`);
      return recusa(`Não consegui gravar a chave: ${err.code || err.message}.`, 500,
        `Quem administra a máquina confere se a pasta ${path.dirname(ARQUIVO)} aceita escrita.`);
    }
    return { ok: true, token, chave: publica(reg) };
  }

  function revogar(id, quem) {
    const dados = ler();
    const alvo = dados.chaves.find((c) => c.id === String(id || ''));
    if (!alvo) return recusa(`Não achei nenhuma chave com o código "${String(id || '').slice(0, 20)}".`, 404, 'Veja os códigos na lista de chaves.');
    if (alvo.revogadaEm) {
      return recusa(`A chave "${alvo.nome}" já tinha sido revogada em ${alvo.revogadaEm.slice(0, 10)}.`, 409);
    }
    alvo.revogadaEm = new Date(relogio()).toISOString();
    alvo.revogadaPor = String(quem || 'Dono').slice(0, 80);
    try {
      gravar(dados);
    } catch (err) {
      log('erro', `Chaves de API: não consegui anotar a revogação em ${ARQUIVO} (${err.code || err.message}).`);
      return recusa(`Não consegui anotar a revogação: ${err.code || err.message}.`, 500,
        `Quem administra a máquina confere se a pasta ${path.dirname(ARQUIVO)} aceita escrita.`);
    }
    return { ok: true, chave: publica(alvo) };
  }

  /**
   * Julga o cabeçalho Authorization inteiro. Devolve um destes:
   *   { estado: 'valida', id, nome, escopos }
   *   { estado: 'revogada', nome, revogadaEm }
   *   { estado: 'desconhecida' }
   *   { estado: 'formato' }
   *
   * Compara com TODAS as chaves, sem parar na primeira que casa, e em tempo constante por
   * chave, para que o tempo de resposta não conte quantas chaves existem.
   */
  function julgar(cabecalho) {
    const m = FORMATO_BEARER.exec(String(cabecalho || ''));
    if (!m) return { estado: 'formato' };
    const h = sha256(m[1]);
    let achada = null;
    for (const c of ler().chaves) {
      const guardado = Buffer.from(String(c.hash || ''), 'hex');
      if (guardado.length === h.length && crypto.timingSafeEqual(guardado, h)) achada = c;
    }
    if (!achada) return { estado: 'desconhecida' };
    if (achada.revogadaEm) return { estado: 'revogada', nome: achada.nome, revogadaEm: achada.revogadaEm };
    return { estado: 'valida', id: achada.id, nome: achada.nome, escopos: Array.isArray(achada.escopos) ? achada.escopos.slice() : [] };
  }

  // No máximo uma gravação por minuto por chave: cada pedido gravando o arquivo seria
  // desgaste de disco à toa e disputa com a CLI.
  function marcarUso(id, ip) {
    const t = relogio();
    if (t - (ultimoRegistroDeUso.get(id) || 0) < USO_MIN_INTERVALO_MS) return;
    ultimoRegistroDeUso.set(id, t);
    try {
      const dados = ler();   // relê: a CLI pode ter mexido desde a última conferência
      const c = dados.chaves.find((x) => x.id === id);
      if (!c) return;
      c.ultimoUsoEm = new Date(t).toISOString();
      c.ultimoUsoIp = String(ip || '').slice(0, 64) || null;
      gravar(dados);
    } catch (err) {
      // Não derruba o pedido por causa de um carimbo, mas também não fica mudo.
      log('aviso', `Chaves de API: não consegui anotar o último uso da chave ${id} (${err.code || err.message}).`);
    }
  }

  // ── limite de tentativas inválidas por IP ────────────────────────────────
  function janela(ip) {
    const t = relogio();
    const lista = (falhas.get(ip) || []).filter((x) => t - x < JANELA_FALHAS_MS);
    if (lista.length) falhas.set(ip, lista); else falhas.delete(ip);
    return lista;
  }
  /** { bloqueado, retryAfter } em segundos. */
  function bloqueio(ip) {
    const lista = janela(ip);
    if (lista.length < FALHAS_MAX) return { bloqueado: false, retryAfter: 0 };
    return { bloqueado: true, retryAfter: Math.max(1, Math.ceil((lista[0] + JANELA_FALHAS_MS - relogio()) / 1000)) };
  }
  function registrarFalha(ip) {
    const lista = janela(ip);
    lista.push(relogio());
    falhas.set(ip, lista);
    // Teto no mapa: um atacante com muitos IPs não pode encher a memória.
    if (falhas.size > 5000) falhas.delete(falhas.keys().next().value);
  }

  return { listar, criar, revogar, julgar, marcarUso, bloqueio, registrarFalha, ARQUIVO };
}

module.exports = { criarChavesApi, ESCOPOS, PREFIXO, FALHAS_MAX, JANELA_FALHAS_MS };
