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
//
// Autorização e uso ficam em arquivos separados. chaves-api.json só muda por criar ou revogar, e
// toda mudança acontece sob uma trava entre processos, relendo o disco dentro da trava: assim uma
// revogação feita pela CLI nunca é desfeita por um processo que tinha lido o arquivo antes. O
// registro de uso (último acesso e IP) vai para chaves-api-uso.json, que pode perder uma gravação
// sem consequência de segurança.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIXO = 'dgc_';
const ESCOPOS = Object.freeze(['diagnostico']);
const USO_MIN_INTERVALO_MS = 60 * 1000;
const FALHAS_MAX = 20;
const JANELA_FALHAS_MS = 10 * 60 * 1000;
const TRAVA_ESPERA_MS = 3000;
const TRAVA_VELHA_MS = 30 * 1000;
const FORMATO_BEARER = /^\s*Bearer\s+(dgc_[A-Za-z0-9_-]{20,})\s*$/i;

function recusa(erro, status, comoResolver) {
  const r = { ok: false, erro, status: status || 400 };
  if (comoResolver) r.como_resolver = comoResolver;
  return r;
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest();

function criarChavesApi({ config, log, agora }) {
  const ARQUIVO = config.chavesApiArquivo || path.join(config.dataDir, 'chaves-api.json');
  const ARQUIVO_USO = path.join(path.dirname(ARQUIVO), 'chaves-api-uso.json');
  const TRAVA = `${ARQUIVO}.lock`;
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
  function gravarArquivo(destino, dados) {
    fs.mkdirSync(path.dirname(destino), { recursive: true, mode: 0o700 });
    const tmp = `${destino}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* sistema de arquivos sem modo: o mode do writeFileSync já valeu */ }
    fs.renameSync(tmp, destino);
  }
  function gravar(dados) {
    gravarArquivo(ARQUIVO, dados);
    cache = null;
  }

  const dormir = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  /**
   * Trava entre processos (Web e CLI): arquivo criado com O_EXCL, com pid e horário dentro.
   * Tenta por até 3 s; trava com mais de 30 s é de um processo que morreu e é removida (com log).
   * Roda `fn` com a trava e a solta sempre. Lança Error com causa se não conseguir a trava.
   */
  function comTrava(fn) {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true, mode: 0o700 });
    const limite = Date.now() + TRAVA_ESPERA_MS;
    let fd = null;
    for (;;) {
      try {
        fd = fs.openSync(TRAVA, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, em: new Date().toISOString() }));
        break;
      } catch (e) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* nada a fechar */ } fd = null; }
        if (e.code !== 'EEXIST') throw e;
        let idade = 0;
        try { idade = Date.now() - fs.statSync(TRAVA).mtimeMs; } catch (s) {
          if (s.code === 'ENOENT') continue; // soltaram agora: tenta de novo já
          throw s;
        }
        if (idade > TRAVA_VELHA_MS) {
          log('aviso', `Chaves de API: a trava ${TRAVA} tem ${Math.round(idade / 1000)} s, mais de ${TRAVA_VELHA_MS / 1000} s. Quem a criou deve ter morrido no meio da gravação, então ela foi removida e a gravação segue.`);
          try { fs.unlinkSync(TRAVA); } catch (u) { if (u.code !== 'ENOENT') throw u; }
          continue;
        }
        if (Date.now() >= limite) {
          const err = new Error(`outro processo está mexendo nas chaves há mais de ${TRAVA_ESPERA_MS / 1000} s (trava ${TRAVA})`);
          err.code = 'TRAVA_OCUPADA';
          throw err;
        }
        dormir(25);
      }
    }
    try { return fn(); } finally {
      try { fs.closeSync(fd); } catch (_) { /* já fechado */ }
      try { fs.unlinkSync(TRAVA); } catch (e) { if (e.code !== 'ENOENT') log('aviso', `Chaves de API: não consegui soltar a trava ${TRAVA} (${e.code || e.message}). Ela vence sozinha em ${TRAVA_VELHA_MS / 1000} s.`); }
    }
  }

  /** Lê o disco de verdade (sem cache), para decidir uma mudança. Arquivo ilegível lança: nunca se sobrescreve o que não se leu. */
  function lerParaMudar() {
    let texto;
    try { texto = fs.readFileSync(ARQUIVO, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { schema: 1, chaves: [] };
      throw e;
    }
    let dados;
    try { dados = JSON.parse(texto); } catch (e) {
      const err = new Error(`o arquivo ${ARQUIVO} está ilegível (${e.message}); nada foi alterado para não perder as chaves`);
      err.code = 'ARQUIVO_ILEGIVEL';
      throw err;
    }
    if (!dados || !Array.isArray(dados.chaves)) {
      const err = new Error(`o arquivo ${ARQUIVO} não tem a lista "chaves"; nada foi alterado para não perder as chaves`);
      err.code = 'ARQUIVO_ILEGIVEL';
      throw err;
    }
    return dados;
  }

  function lerUso() {
    try {
      const u = JSON.parse(fs.readFileSync(ARQUIVO_USO, 'utf8'));
      return u && typeof u.usos === 'object' && u.usos ? u.usos : {};
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Chaves de API: não consegui ler ${ARQUIVO_USO} (${e.code || e.message}). O último acesso aparece como desconhecido até a próxima gravação; as chaves não são afetadas.`);
      return {};
    }
  }

  function publica(c, usos) {
    const uso = (usos && usos[c.id]) || null;
    return {
      id: c.id,
      nome: c.nome,
      escopos: Array.isArray(c.escopos) ? c.escopos.slice() : [],
      ultimos4: c.ultimos4,
      criadaPor: c.criadaPor,
      criadaEm: c.criadaEm,
      ultimoUsoEm: (uso && uso.em) || c.ultimoUsoEm || null,
      ultimoUsoIp: (uso && uso.ip) || c.ultimoUsoIp || null,
      revogadaEm: c.revogadaEm || null,
      revogadaPor: c.revogadaPor || null,
    };
  }

  function listar() {
    const usos = lerUso();
    return ler().chaves.map((c) => publica(c, usos));
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
      comTrava(() => {
        const dados = lerParaMudar();
        gravar({ schema: 1, chaves: [...dados.chaves, reg] });
      });
    } catch (err) {
      return falhaDeMudanca(err, 'gravar a chave');
    }
    return { ok: true, token, chave: publica(reg) };
  }

  function falhaDeMudanca(err, o_que) {
    log('erro', `Chaves de API: não consegui ${o_que} (${err.code || ''} ${err.message}).`);
    if (err.code === 'TRAVA_OCUPADA') {
      return recusa(`Não consegui ${o_que}: outro processo estava mexendo nas chaves.`, 503, `Tente de novo em alguns segundos. Se repetir, quem administra a máquina apaga ${TRAVA} (sobra de um processo que morreu).`);
    }
    if (err.code === 'ARQUIVO_ILEGIVEL') {
      return recusa(`Não consegui ${o_que}: o arquivo de chaves está ilegível e não foi alterado.`, 500, `Quem administra a máquina confere ${ARQUIVO}: restaure o último backup ou corrija o JSON.`);
    }
    return recusa(`Não consegui ${o_que}: ${err.code || err.message}.`, 500,
      `Quem administra a máquina confere se a pasta ${path.dirname(ARQUIVO)} aceita escrita.`);
  }

  function revogar(id, quem) {
    let resultado;
    try {
      resultado = comTrava(() => {
        const dados = lerParaMudar();   // relê do disco dentro da trava: nada de decidir em cima de leitura antiga
        const alvo = dados.chaves.find((c) => c.id === String(id || ''));
        if (!alvo) return recusa(`Não achei nenhuma chave com o código "${String(id || '').slice(0, 20)}".`, 404, 'Veja os códigos na lista de chaves.');
        if (alvo.revogadaEm) return recusa(`A chave "${alvo.nome}" já tinha sido revogada em ${alvo.revogadaEm.slice(0, 10)}.`, 409);
        alvo.revogadaEm = new Date(relogio()).toISOString();
        alvo.revogadaPor = String(quem || 'Dono').slice(0, 80);
        gravar(dados);
        return { ok: true, chave: publica(alvo, lerUso()) };
      });
    } catch (err) {
      return falhaDeMudanca(err, 'anotar a revogação');
    }
    return resultado;
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

  // No máximo uma gravação por minuto por chave, e só no arquivo de uso: marcar acesso nunca
  // reescreve chaves-api.json (era isso que permitia desfazer uma revogação feita no meio).
  // Sem trava de propósito: se duas gravações se cruzarem, perde-se um carimbo, e só.
  function marcarUso(id, ip) {
    const t = relogio();
    if (t - (ultimoRegistroDeUso.get(id) || 0) < USO_MIN_INTERVALO_MS) return;
    ultimoRegistroDeUso.set(id, t);
    try {
      const usos = lerUso();
      usos[id] = { em: new Date(t).toISOString(), ip: String(ip || '').slice(0, 64) || null };
      gravarArquivo(ARQUIVO_USO, { schema: 1, usos });
    } catch (err) {
      // Não derruba o pedido por causa de um carimbo, mas também não fica mudo.
      log('aviso', `Chaves de API: não consegui anotar o último uso da chave ${id} em ${ARQUIVO_USO} (${err.code || err.message}).`);
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

  return { listar, criar, revogar, julgar, marcarUso, bloqueio, registrarFalha, ARQUIVO, ARQUIVO_USO };
}

module.exports = { criarChavesApi, ESCOPOS, PREFIXO, FALHAS_MAX, JANELA_FALHAS_MS };
