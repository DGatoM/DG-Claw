const fs = require('fs');
const path = require('path');

// Defaults que NUNCA devem ser servidos, independente da config.
const DEFAULT_BLOCKED = [
  '.instagram_token',
  '.heygen_token',
  '.cpdf_api_key',
  'cookies.txt',
  'env.sh',
  'config.sh',
  'data/config.json',
  '.env',
];

/**
 * Pastas que guardam segredo em QUALQUER nível do caminho. Basta um segmento do
 * caminho ter um destes nomes para a leitura ser recusada.
 *
 * POR QUE A LISTA EXISTE (vistoria de 01/10/2026, docs/VISTORIA-2026-10-01.md,
 * seção 4). Até aqui o sanitizador só barrava arquivo cujo NOME começasse com
 * ponto, e uma lista fixa. A rota /api/memory/file entregava, sem reclamar,
 * `.dgclaw/cofre.chave` (a chave mestra do cofre), os segredos cifrados de
 * `.dgclaw/cofre/segredos/`, o `.dgclaw/run/<slug>.env` e os transcripts em
 * `.claude/projects/`. Com a chave e o blob juntos, quem tinha a senha do painel
 * decifrava todas as chaves de serviço do dono. O nome do arquivo não começava
 * com ponto; a PASTA é que começava, e ninguém olhava a pasta.
 */
const PASTAS_SECRETAS = ['cofre', 'creds', 'credenciais', 'segredos', 'secrets', 'secret'];
// Extensões de material de chave. Nunca é memória, nunca é texto para o dono ler aqui.
const EXTENSOES_SECRETAS = ['.chave', '.key', '.pem', '.enc', '.p12', '.pfx', '.crt', '.secret', '.token'];
// Teto de leitura pela rota de memória. Arquivo maior que isso não é memória
// (é transcript, log ou banco), e lê-lo inteiro só gasta a RAM do painel.
const TETO_LEITURA_BYTES = 2 * 1024 * 1024;

// buildSanitizer(config) → { isPathAllowed, explicarRecusa }
// ALLOWED_ROOTS = [config.agentDir]; blocklist = defaults + config.blockedFiles.
function buildSanitizer(config) {
  const AGENT_DIR = config.agentDir;
  const ALLOWED_ROOTS = [AGENT_DIR];

  const extra = Array.isArray(config.blockedFiles) ? config.blockedFiles : [];
  const BLOCKED_FILES = [...new Set([...DEFAULT_BLOCKED, ...extra])];

  let _raizReal = null;
  function raizReal() {
    if (_raizReal) return _raizReal;
    try { _raizReal = fs.realpathSync(AGENT_DIR); } catch { _raizReal = path.resolve(AGENT_DIR); }
    return _raizReal;
  }

  /**
   * O caminho REAL (links simbólicos resolvidos) de onde o pedido vai parar.
   * Arquivo que ainda não existe é resolvido pela pasta dele. Devolve null se nem
   * a pasta existe.
   *
   * POR QUE REALPATH: `memory/atalho.md` pode ser um link simbólico para
   * `/etc/shadow`. O `path.resolve` só olha o texto do caminho e diria "está
   * dentro do agentDir"; o disco segue o link e entrega o arquivo de fora.
   */
  function caminhoReal(resolved) {
    try { return fs.realpathSync(resolved); } catch (e) {
      if (e.code !== 'ENOENT') return null;
    }
    try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch { return null; }
  }

  /**
   * Por que este caminho é recusado, em português, ou null se ele é permitido.
   * É a mesma regra do isPathAllowed, só que dizendo o motivo, para o erro da
   * rota se explicar sozinho.
   */
  function explicarRecusa(requestedPath) {
    if (!requestedPath || typeof requestedPath !== 'string') return 'o caminho veio vazio';
    if (requestedPath.includes('\0')) return 'o caminho tem um caractere inválido';

    const resolved = path.resolve(AGENT_DIR, requestedPath);

    // Must be within allowed roots
    const withinAllowed = ALLOWED_ROOTS.some(
      (root) => resolved.startsWith(root + path.sep) || resolved === root
    );
    if (!withinAllowed) return 'o caminho aponta para fora da pasta do agente';

    const relative = path.relative(AGENT_DIR, resolved);
    const segmentos = relative.split(path.sep);

    // Nenhum segmento começado por ponto, em nível nenhum: `.dgclaw/`, `.claude/`,
    // `.sessions/` e companhia são a casa das máquinas do agente (cofre, chaves,
    // transcripts, estado interno), e nada ali é memória para o dono editar.
    // A única exceção é o `.replied_comments` na raiz, que sempre foi lido.
    const ponto = segmentos.find((seg, i) => seg.startsWith('.') && !(i === 0 && segmentos.length === 1 && seg === '.replied_comments'));
    if (ponto) return `"${ponto}" é uma pasta (ou arquivo) interna do sistema, e o painel não abre nada dali`;

    const pasta = segmentos.slice(0, -1).find((seg) => PASTAS_SECRETAS.includes(seg.toLowerCase()));
    if (pasta) return `a pasta "${pasta}" guarda segredo, e o painel não abre nada dali`;

    const ext = path.extname(resolved).toLowerCase();
    if (EXTENSOES_SECRETAS.includes(ext)) return `arquivo "${ext}" é material de chave, e o painel não abre`;

    // Check against blocked files (exact or basename match)
    for (const blocked of BLOCKED_FILES) {
      if (relative === blocked || relative.endsWith('/' + blocked)) return 'este arquivo está na lista dos que o painel nunca abre (guarda chave ou senha)';
      // padrões tipo "cookies*.txt"
      if (blocked.includes('*')) {
        const re = new RegExp('^' + blocked.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (re.test(path.basename(resolved))) return 'este arquivo está na lista dos que o painel nunca abre (guarda chave ou senha)';
      }
    }

    // O disco, e não só o texto: link simbólico que sai do agentDir é recusado.
    const real = caminhoReal(resolved);
    if (!real) return 'a pasta deste caminho não existe';
    const raiz = raizReal();
    if (!(real === raiz || real.startsWith(raiz + path.sep))) {
      return 'o caminho é um atalho (link simbólico) que leva para fora da pasta do agente';
    }
    return null;
  }

  function isPathAllowed(requestedPath) {
    return explicarRecusa(requestedPath) === null;
  }

  return { isPathAllowed, explicarRecusa, BLOCKED_FILES, ALLOWED_ROOTS, TETO_LEITURA_BYTES };
}

module.exports = { buildSanitizer, DEFAULT_BLOCKED, PASTAS_SECRETAS, TETO_LEITURA_BYTES };
