// chaves-api.js — as chaves de API do painel (Bearer): como OUTRO assistente opera
// este agente sem abrir a tela.
//
// O PADRÃO, e cada linha dele está implementada abaixo:
//   - tudo o que se faz clicando se faz por API (o caso concreto: o Admin guardar
//     uma chave no cofre deste agente sem ver a tela);
//   - GUARDA-SE SÓ O HASH. O token aparece uma vez, na criação, e o painel não tem
//     como mostrá-lo de novo, nem a quem administra a máquina;
//   - NENHUMA CHAVE GERENCIA CHAVES (a recusa fica no requireAuth e de novo nas
//     rotas): uma chave vazada não consegue criar outra para sobreviver à revogação;
//   - REVOGAR É DATAR. O registro fica, com quem revogou e quando.
//
// O token tem 32 bytes aleatórios, então sha256 simples basta para guardá-lo: não há
// senha curta para um atacante adivinhar offline, que é o caso em que se usa scrypt.
//
// O arquivo é lido a cada conferência quando o mtime muda, porque a CLI
// (bin/chave-api.js) cria chave com o painel rodando e o painel precisa enxergá-la.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIXO = 'dgc_';
const USO_MIN_INTERVALO_MS = 60 * 1000;

function recusa(erro, status, howToFix) {
  const r = { erro, status: status || 400 };
  if (howToFix) r.howToFix = howToFix;
  return r;
}

function sha256(texto) {
  return crypto.createHash('sha256').update(texto).digest();
}

function buildChavesApi(config) {
  const ARQUIVO = config.chavesApiArquivo || path.join(config.agentDir, '.dgclaw', 'panel', 'chaves-api.json');
  const agora = config.agora || Date.now;
  const ultimoRegistroDeUso = new Map();   // id -> ms da última gravação de ultimoUsoEm
  let cache = null;                         // { mtimeMs, dados }

  function ler() {
    let stat;
    try { stat = fs.statSync(ARQUIVO); } catch { return { schema: 1, chaves: [] }; }
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.tamanho === stat.size) return cache.dados;
    try {
      const dados = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));
      if (dados && Array.isArray(dados.chaves)) {
        cache = { mtimeMs: stat.mtimeMs, tamanho: stat.size, dados };
        return dados;
      }
    } catch (err) {
      // Arquivo ilegível NÃO vira "nenhuma chave" em silêncio: o efeito é recusar
      // todo pedido por chave, e quem administra precisa saber por quê.
      console.error(`[painel] chaves de API: não consegui ler ${ARQUIVO} (${err.message}). Nenhuma chave de API vale até o arquivo ser consertado.`);
    }
    return { schema: 1, chaves: [] };
  }

  // Escrita atômica: grava num arquivo ao lado e renomeia. Um corte de luz no meio
  // deixaria o arquivo das chaves pela metade, e aí todas deixariam de valer.
  function gravar(dados) {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true, mode: 0o700 });
    const tmp = `${ARQUIVO}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* sistema de arquivos sem modo */ }
    // Rodando como root (a CLI chamada pelo Admin), o arquivo nasceria do root e o
    // painel, que roda como o usuário do agente, deixaria de ler as chaves. O dono
    // passa a ser o mesmo da pasta.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const pasta = fs.statSync(path.dirname(ARQUIVO));
      fs.chownSync(tmp, pasta.uid, pasta.gid);
    }
    fs.renameSync(tmp, ARQUIVO);
    cache = null;
  }

  function publica(c) {
    return {
      id: c.id,
      nome: c.nome,
      criadaPor: c.criadaPor,
      criadaEm: c.criadaEm,
      ultimoUsoEm: c.ultimoUsoEm || null,
      revogadaEm: c.revogadaEm || null,
      ultimos4: c.ultimos4,
    };
  }

  function listar() {
    return ler().chaves.map(publica);
  }

  function criar({ nome, quem } = {}) {
    const limpo = String(nome == null ? '' : nome).trim();
    if (!limpo) {
      return recusa('Faltou o nome da chave de API, que diz quem vai usá-la.', 400,
        'Dê um nome que lembre quem é, por exemplo "Admin" ou "Assistente principal".');
    }
    if (limpo.length > 60 || /[\x00-\x1f\x7f]/.test(limpo)) {
      return recusa('O nome da chave de API tem mais de 60 caracteres ou caractere invisível.', 400,
        'Use um nome curto, só com letras, números e espaço.');
    }
    const token = PREFIXO + crypto.randomBytes(32).toString('base64url');
    const dados = ler();
    const registro = {
      id: crypto.randomBytes(5).toString('hex'),
      nome: limpo,
      hash: sha256(token).toString('hex'),
      ultimos4: token.slice(-4),
      criadaPor: String(quem || config.creatorName || 'Dono').slice(0, 80),
      criadaEm: new Date(agora()).toISOString(),
      ultimoUsoEm: null,
      revogadaEm: null,
    };
    try {
      gravar({ schema: 1, chaves: [...dados.chaves, registro] });
    } catch (err) {
      console.error(`[painel] chaves de API: não consegui gravar ${ARQUIVO}: ${err.message}`);
      return recusa(`Não consegui gravar a chave de API: ${err.message}`, 500,
        'Quem administra a máquina confere se a pasta .dgclaw/panel do agente aceita escrita.');
    }
    return {
      ok: true, id: registro.id, nome: registro.nome, token, ultimos4: registro.ultimos4,
      aviso: 'Guarde este token agora: ele não aparece de novo. O painel guarda só uma marca dele, e ninguém consegue recuperá-lo depois.',
    };
  }

  function revogar(id, quem) {
    const dados = ler();
    const alvo = dados.chaves.find((c) => c.id === String(id || ''));
    if (!alvo) return recusa(`Não achei nenhuma chave de API com o código "${String(id || '').slice(0, 20)}".`, 404);
    if (alvo.revogadaEm) {
      return recusa(`A chave "${alvo.nome}" já tinha sido revogada em ${alvo.revogadaEm.slice(0, 10)}.`, 409);
    }
    alvo.revogadaEm = new Date(agora()).toISOString();
    alvo.revogadaPor = String(quem || config.creatorName || 'Dono').slice(0, 80);
    try {
      gravar(dados);
    } catch (err) {
      console.error(`[painel] chaves de API: não consegui anotar a revogação em ${ARQUIVO}: ${err.message}`);
      return recusa(`Não consegui anotar a revogação: ${err.message}`, 500);
    }
    return { ok: true, id: alvo.id, nome: alvo.nome, aviso: `A chave "${alvo.nome}" deixou de valer agora.` };
  }

  /**
   * Confere um token recebido. Devolve { id, nome } ou null.
   *
   * Compara com TODAS as chaves, sem parar na primeira que casa, e em tempo
   * constante por chave, para que o tempo de resposta não conte quantas chaves
   * existem nem qual delas quase bateu.
   */
  function conferir(tokenBruto) {
    const token = String(tokenBruto || '');
    if (!token.startsWith(PREFIXO)) return null;
    const h = sha256(token);
    let achada = null;
    for (const c of ler().chaves) {
      const guardado = Buffer.from(String(c.hash || ''), 'hex');
      if (guardado.length === h.length && crypto.timingSafeEqual(guardado, h) && !c.revogadaEm) achada = c;
    }
    if (!achada) return null;
    marcarUso(achada.id);
    return { id: achada.id, nome: achada.nome };
  }

  // No máximo uma gravação por minuto por chave: cada pedido da API gravando o
  // arquivo seria desgaste de disco à toa e uma disputa com a CLI.
  function marcarUso(id) {
    const t = agora();
    if (t - (ultimoRegistroDeUso.get(id) || 0) < USO_MIN_INTERVALO_MS) return;
    ultimoRegistroDeUso.set(id, t);
    try {
      const dados = ler();   // relê: a CLI pode ter criado chave desde a última conferência
      const c = dados.chaves.find((x) => x.id === id);
      if (!c) return;
      c.ultimoUsoEm = new Date(t).toISOString();
      gravar(dados);
    } catch (err) {
      // Não derruba o pedido por causa de um carimbo, mas também não fica mudo.
      console.error(`[painel] chaves de API: não consegui anotar o último uso da chave ${id}: ${err.message}`);
    }
  }

  return { listar, criar, revogar, conferir, ARQUIVO };
}

module.exports = { buildChavesApi, PREFIXO };
