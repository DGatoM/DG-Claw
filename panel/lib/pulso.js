// pulso.js — Leitor do PULSO (saude operacional) do agente DG Claw.
//
// Fonte UNICA = scripts/pulso-status.py (descobre os componentes dinamicamente
// de powers.json + timers/servicos systemd, e cruza com o ledger de pulso).
// Aqui NAO se reimplementa o parsing pra nao criar fonte dupla — so chama o
// script com um cache curto (~30s) pra nao spawnar Python a cada request.
//
// Factory: buildPulso(config). Tudo parametrizado por env DGCLAW_*:
//   - DGCLAW_WORKSPACE = config.agentDir
//   - DGCLAW_SLUG      = config.agentSlug
//   - DGCLAW_PULSO_DIR = config.pulsoDir (default <agentDir>/.dgclaw/logs/pulso)
//
// Se o script nao existir/falhar, retorna um payload zerado mas integro (o
// painel degrada gracioso, nunca quebra).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_MS = 30000;

function buildPulso(config, serverDir) {
  const AGENT_DIR = config.agentDir;
  const SLUG = config.agentSlug || 'agente';
  const PULSO_DIR =
    config.pulsoDir || path.join(AGENT_DIR, '.dgclaw', 'logs', 'pulso');

  /**
   * O nome da unidade systemd da sessao viva, lido do config.sh do agente.
   *
   * POR QUE ISTO EXISTE. O pulso-status.py descobre o servico do canal por
   * DGCLAW_SERVICE, e cai num `dgclaw-<slug>.service` quando ela nao vem. Esse
   * default vale para o DG Claw classico; num agente de runner a unidade se
   * chama `dgclaw-agent-<slug>.service`, e o default aponta para um nome que o
   * systemd nunca ouviu falar.
   *
   * O cron acertava e o painel errava, porque o cron carrega o config.sh e o
   * painel nao. O resultado era a linha `canal (runtime)`, que e a de
   * criticidade ALTA, aparecendo vermelha com o agente vivo e trabalhando. Um
   * alarme que toca com tudo certo custa mais caro que alarme nenhum: ensina a
   * pessoa a ignorar a cor.
   *
   * Le so esta variavel, e por leitura de texto: dar `source` num .sh a partir
   * do painel seria executar, na conta do painel, um arquivo que o agente pode
   * reescrever.
   */
  function servicoDoCanal() {
    if (config.canalService) return config.canalService;
    if (process.env.DGCLAW_SERVICE) return process.env.DGCLAW_SERVICE;
    try {
      const texto = fs.readFileSync(
        path.join(AGENT_DIR, '.dgclaw', 'config.sh'),
        'utf8',
      );
      const m = texto.match(/^\s*export\s+DGCLAW_SERVICE=["']?([^"'\n]+)["']?\s*$/m);
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* sem config.sh: o script usa o default dele */ }
    return '';
  }

  // Resolve o pulso-status.py. Em producao a copia estavel vive em
  // <ws>/.dgclaw/plugin/scripts; em dev, ao lado deste pacote (../../scripts).
  function resolveScript() {
    const candidates = [
      config.pulsoStatusScript, // override explicito (path absoluto)
      path.join(AGENT_DIR, '.dgclaw', 'plugin', 'scripts', 'pulso-status.py'),
      serverDir && path.join(serverDir, '..', 'scripts', 'pulso-status.py'),
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
  }

  const _cache = new Map(); // date -> { ts, data }

  function emptyReport(date, error) {
    return {
      slug: SLUG,
      date,
      now: '',
      counts: { ok: 0, erro: 0, aguardando: 0, pendente: 0, 'sem-sinal': 0 },
      // `null` E NÃO 100. Este relatório vazio é devolvido quando o
      // `pulso-status.py` não foi encontrado ou quebrou, ou seja, quando NADA foi
      // medido. Com `pct: 100` a aba Pulso mostrava "100%" bem ao lado da frase
      // "nada foi medido ainda", que é uma tela dizendo duas coisas opostas ao
      // mesmo tempo, e a que a pessoa lê é o número verde.
      //
      // Nada medido não é saúde perfeita: é ausência de leitura. `null` é o que o
      // front já espera para esse caso, e ele desenha "--". Mesmo princípio do
      // resto do pulso, onde o que está armado e ainda não rodou fica FORA da
      // conta em vez de contar como sucesso.
      pct: null,
      total: 0,
      processos: [],
      ...(error ? { error } : {}),
    };
  }

  // Promessa cacheada. Sempre resolve (nunca rejeita) — degrada pra zerado.
  function getStatus(date) {
    const cached = _cache.get(date);
    if (cached && Date.now() - cached.ts < CACHE_MS) {
      return Promise.resolve(cached.data);
    }

    const script = resolveScript();
    if (!script) {
      const data = emptyReport(date, 'pulso-status.py nao encontrado');
      _cache.set(date, { ts: Date.now(), data });
      return Promise.resolve(data);
    }

    return new Promise((resolve) => {
      execFile(
        'python3',
        [script, '--json', `--date=${date}`],
        {
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            DGCLAW_WORKSPACE: AGENT_DIR,
            DGCLAW_SLUG: SLUG,
            DGCLAW_PULSO_DIR: PULSO_DIR,
            DGCLAW_TZ_OFFSET_HOURS: String(config.timezoneOffsetHours ?? -3),
            // Sem esta linha o Pulso pinta de vermelho a sessao viva de todo
            // agente de runner. Ver servicoDoCanal() acima.
            ...(servicoDoCanal() ? { DGCLAW_SERVICE: servicoDoCanal() } : {}),
          },
        },
        (err, stdout) => {
          if (err) {
            const data = emptyReport(date, String(err.message || err));
            _cache.set(date, { ts: Date.now(), data });
            return resolve(data);
          }
          try {
            const data = JSON.parse(stdout);
            _cache.set(date, { ts: Date.now(), data });
            resolve(data);
          } catch (e) {
            const data = emptyReport(date, 'json invalido do pulso-status');
            _cache.set(date, { ts: Date.now(), data });
            resolve(data);
          }
        }
      );
    });
  }

  // servicoDoCanal sai daqui também: a aba Operações (lib/operacoes.js) precisa do
  // MESMO nome de unidade da sessão viva, e duas leituras do config.sh seriam duas
  // verdades sobre qual unidade é o agente.
  return { PULSO_DIR, getStatus, servicoDoCanal };
}

module.exports = { buildPulso };
