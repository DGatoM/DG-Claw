'use strict';
// Download do YouTube do agente. Faz um download REAL e pequeno dentro do container, como o usuário agente, e
// guarda o último resultado com horário. Quem testa é o vigia (a cada 6 horas); a tela de diagnóstico só LÊ o último
// resultado, nunca dispara download. O teste ignora qualquer configuração do yt-dlp e passa as opções na própria
// chamada. O teste é SEMPRE sem cookies: ele nunca usa a conta Google que estiver na Tela, que pode ser a pessoal do dono.
// Se o YouTube pedir a checagem anti-robô, o script só confere OFFLINE (sem rede, sem ler valor de cookie) se a Tela tem
// uma sessão do YouTube dentro da validade, e isso vira o tipo `sessao` (ok). Se a pasta do Chrome da Tela não existe, o
// resultado é sem_perfil. Quando o download para de funcionar, é aqui que o
// dono fica sabendo, em vez de o agente falhar calado no meio de um pedido. Nada do stderr do yt-dlp sai daqui: a
// classificação devolve só um tipo de uma lista fechada (e o código de saída), e todo texto mostrado é fixo. Não depende do motor do agente (Claude ou Codex): roda no container.

const fs = require('node:fs');
const path = require('node:path');
const U = require('./util');
const { instanciaDe } = require('../instancia');

const { R, conserta } = U;
const PRAZO_DOWNLOAD_S = 80;             // teto dentro do container (comando `timeout`)
const PRAZO_EXEC_MS = (PRAZO_DOWNLOAD_S + 40) * 1000; // teto de quem chama: o download e a checagem offline, com margem
const VIDEO_TESTE = 'https://www.youtube.com/watch?v=jNQXAC9IJRQ'; // "Me at the zoo": 19 s, o primeiro vídeo do YouTube, estável
const NOME_ARQUIVO = 'youtube-saude.json';
const LIMITE_SAIDA = 8192;               // bytes lidos de stderr e de stdout, cortados antes de qualquer regex ou log
const PASTA_COOKIES = '/home/agente/.tela-chrome/Default'; // só o perfil padrão da Tela: outro perfil aberto nela nunca entra na checagem
const VALIDADE_MS = 13 * 3600 * 1000;    // duas rodadas de 6 horas e uma margem: resultado mais velho que isso não é mais medida
const SAIDA_SEM_TMP = 70;                // o script não conseguiu criar a pasta temporária: o yt-dlp nem começou
const SAIDA_PODMAN_FALHOU = 125;         // o próprio podman não conseguiu executar o comando (ex.: container parado)
const SAIDA_SEM_PERFIL = 66;             // código próprio do script: a pasta do Chrome da Tela não existe
const SAIDA_SESSAO = 67;                 // código próprio do script: anti-robô sem login, e a Tela tem sessão do YouTube dentro da validade
const SAIDA_SEM_CHECAGEM = 71;           // código próprio do script: sem sqlite3 ou a consulta ao banco de cookies falhou (infraestrutura)

// Roda dentro do container, sem nenhum valor vindo de fora. A pasta é temporária e some ao final. O yt-dlp ignora
// a configuração do usuário e dos plugins. A tentativa é SEM cookies (o stderr dela fica em "$d/err", fora da
// pasta de download, e só é repassado se ela falhar por outro motivo). Quando o YouTube pede login (checagem
// anti-robô), o script NÃO tenta de novo com cookies: só conta, offline, as linhas do banco de cookies da Tela que são de
// sessão do YouTube e ainda valem (nunca seleciona a coluna value nem encrypted_value). Se a pasta da Tela não existe, sai com 66.
const OPCOES_BASE = `--ignore-config --no-plugin-dirs --js-runtimes node --no-playlist --no-progress --socket-timeout 20 -f "worst/worstvideo" --max-filesize 5M -P "$d/v" -o '%(id)s.%(ext)s'`;
// Só a CONTAGEM de linhas: nada de value nem encrypted_value. AGORA ($agora, definido no script) está na época do Chrome (microssegundos desde 1601).
const SQL_SESSAO = "SELECT COUNT(*) FROM cookies WHERE host_key = '.youtube.com' AND name IN ('__Secure-3PSID','SAPISID','LOGIN_INFO') AND (expires_utc = 0 OR expires_utc > $agora)";
const SCRIPT = [
  `d=$(mktemp -d /tmp/yt-saude.XXXXXX) || exit ${SAIDA_SEM_TMP}`,
  'trap \'rm -rf "$d"\' EXIT',
  'if ! command -v yt-dlp >/dev/null 2>&1',
  'then',
  '  echo "yt-dlp: command not found" >&2',
  '  exit 127',
  'fi',
  `mkdir "$d/v" || exit ${SAIDA_SEM_TMP}`,
  `timeout ${PRAZO_DOWNLOAD_S} yt-dlp ${OPCOES_BASE} '${VIDEO_TESTE}' 2>"$d/err"`,
  'c=$?',
  'if [ $c -eq 0 ] && [ -n "$(find "$d/v" -type f -size +0c)" ]',
  'then',
  '  exit 0',
  'fi',
  // Só o desafio anti-robô libera os cookies; "Sign in to confirm your age" (restrição de idade) não.
  'if ! head -c 8192 "$d/err" | grep -qiE "sign in to confirm you.re not a bot"',
  'then',
  '  head -c 8192 "$d/err" >&2',
  '  if [ $c -eq 0 ]',
  '  then',
  '    echo "nenhum arquivo foi baixado" >&2',
  '    exit 65',
  '  fi',
  '  exit $c',
  'fi',
  `if [ ! -d ${PASTA_COOKIES} ]`,
  'then',
  '  echo "perfil da Tela ausente" >&2',
  `  exit ${SAIDA_SEM_PERFIL}`,
  'fi',
  'if ! command -v sqlite3 >/dev/null 2>&1',
  'then',
  '  echo "sqlite3: command not found" >&2',
  `  exit ${SAIDA_SEM_CHECAGEM}`,
  'fi',
  `b=${PASTA_COOKIES}/Network/Cookies`,
  'if [ ! -f "$b" ]',
  'then',
  `  b=${PASTA_COOKIES}/Cookies`,
  'fi',
  'n=0',
  'if [ -f "$b" ]',
  'then',
  `  cp "$b" "$d/cookies.db" || exit ${SAIDA_SEM_CHECAGEM}`,
  '  agora=$(( ($(date +%s) + 11644473600) * 1000000 ))',
  `  n=$(sqlite3 -readonly "$d/cookies.db" "${SQL_SESSAO}") || exit ${SAIDA_SEM_CHECAGEM}`,
  `  [ "$n" -ge 0 ] 2>/dev/null || exit ${SAIDA_SEM_CHECAGEM}`,
  'fi',
  'if [ "$n" -gt 0 ]',
  'then',
  '  echo "sessao do YouTube valida na Tela" >&2',
  `  exit ${SAIDA_SESSAO}`,
  'fi',
  // Sem sessão: repassa o stderr da tentativa anônima (que traz o texto de login) e sai com erro.
  'head -c 8192 "$d/err" >&2',
  'exit 1',
].join('\n');

// Sinais de que o YouTube recusou o download por falta de login: o pedido de login, e o aviso de cookies inválidos (que o yt-dlp dá
// mesmo quando consegue baixar um vídeo público).
const RX_LOGIN = /sign in to confirm you.re not a bot|cookies are no longer valid|cookies.{0,40}(?:invalid|expired)|please sign in|login required/i;
const RX_AUSENTE = /yt-dlp:? (?:command )?not found|yt-dlp: no such file|executable file .*yt-dlp.* not found/i;
const RX_CONTAINER = /no such container|cannot (?:exec|find)|container .* (?:is not running|does not exist)/i;

/** Corta stderr e stdout no limite ANTES de qualquer regex, log ou gravação. */
function cortarSaida(r) {
  return { codigo: r.codigo, erro: r.erro, stderr: String(r.stderr || '').slice(0, LIMITE_SAIDA), stdout: String(r.stdout || '').slice(0, LIMITE_SAIDA) };
}

/**
 * Classifica o resultado do comando. `r` é { codigo, stdout, stderr, erro }.
 * Devolve { tipo: 'ok' | 'sessao' | 'login' | 'sem_perfil' | 'ausente' | 'tempo' | 'outro', codigo? }. `codigo` (número) só existe em 'outro'.
 * Nunca devolve texto do stderr: o que sai daqui pode ir para log, arquivo e resposta da API.
 */
function classificarYoutube(r) {
  const c = cortarSaida(r);
  const saida = `${c.stderr}\n${c.stdout}`;
  // Os códigos próprios do script valem antes do texto de login: o stderr da tentativa anônima pode trazer esse texto.
  if (c.codigo === SAIDA_SESSAO && !c.erro) return { tipo: 'sessao' };
  if (RX_LOGIN.test(saida)) return { tipo: 'login' };
  if (c.codigo === 0 && !c.erro) return { tipo: 'ok' };
  if (c.codigo === SAIDA_SEM_PERFIL) return { tipo: 'sem_perfil' };
  if (c.codigo === 127 || RX_AUSENTE.test(saida)) return { tipo: 'ausente' };
  if (c.erro === 'timeout' || c.erro === 'prazo' || c.codigo === 124) return { tipo: 'tempo' };
  return { tipo: 'outro', codigo: Number.isInteger(c.codigo) ? c.codigo : null };
}

const TEXTO_TIPO = {
  login: 'o YouTube pediu login',
  sessao: 'o YouTube pediu a checagem anti-robô e a Tela tem uma sessão do YouTube válida (o teste automático não a usa)',
  sem_perfil: 'o YouTube pediu login e a Tela do agente ainda não foi aberta',
  ausente: 'o yt-dlp não existe no container',
  tempo: `o download passou de ${PRAZO_DOWNLOAD_S} s`,
  outro: 'o download terminou com erro',
};
const textoFalha = (tipo, codigo) => `${TEXTO_TIPO[tipo] || tipo}${tipo === 'outro' ? ` (código de saída ${codigo === null || codigo === undefined ? 'desconhecido' : codigo})` : ''}`;

/** Estado guardado por agente, em memória e em <dataDir>/youtube-saude.json (só horário, tipo, código de saída, a identidade da instância do agente e, quando a última tentativa não rodou, o último resultado concluído). */
function criarEstadoYoutube(ctx) {
  const arquivo = ctx.config && ctx.config.dataDir ? path.join(ctx.config.dataDir, NOME_ARQUIVO) : null;
  let dados = null;
  const andando = new Map();
  function carregar() {
    if (dados) return dados;
    dados = {};
    if (!arquivo) return dados;
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) dados = j;
    } catch (e) {
      if (e.code !== 'ENOENT') ctx.log('aviso', `Diagnóstico: não consegui ler ${arquivo} (${e.message}); o teste do YouTube será refeito.`);
    }
    return dados;
  }
  function gravar() {
    if (!arquivo) return;
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      const tmp = `${arquivo}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 });
      fs.renameSync(tmp, arquivo);
    } catch (e) {
      ctx.log('aviso', `Diagnóstico: não consegui guardar o resultado do teste do YouTube em ${arquivo} (${e.code || e.message}). O resultado vale só até o painel reiniciar.`);
    }
  }
  return {
    // O resultado pertence a uma instância do agente: se o agente foi removido e criado de novo com o mesmo nome, o antigo não vale.
    ler: (slug, instancia) => {
      const v = carregar()[slug];
      if (!(v && typeof v === 'object' && typeof v.em === 'number' && typeof v.tipo === 'string')) return null;
      const falta = (x) => x === undefined || x === null || x === '';
      if (falta(instancia) || falta(v.instancia)) return null;
      return v.instancia === instancia ? v : null;
    },
    guardar: (slug, v) => { carregar()[slug] = v; gravar(); },
    andando,
  };
}

/**
 * Roda o teste do YouTube do agente e grava o resultado no estado (ctx.youtube). Não dispara dois testes do mesmo
 * slug ao mesmo tempo: se já há um rodando, espera esse e devolve o tipo que ele gravou. Devolve o tipo gravado
 * ('nao_medido' quando a infraestrutura falhou: podman ausente, container que não aceitou ou erro interno), ou null
 * quando nem tentou (nome fora do padrão).
 */
function testarYoutube(ctx, ag) {
  const { agora, log } = ctx;
  const { slug } = ag;
  if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
  const est = ctx.youtube;
  // O nome do container vem do registro; confere que é o esperado antes de chegar perto de um comando.
  if (!U.RX_NOME_SEGURO.test(String(slug)) || ag.container !== `dgclaw-${slug}`) {
    log('aviso', 'Diagnóstico: o teste do YouTube não rodou porque o nome do agente ou do container está fora do padrão (dgclaw-<nome>). Confira com dgclaw status.');
    return Promise.resolve(null);
  }
  if (est.andando.has(slug)) return est.andando.get(slug);

  const instancia = instanciaDe(ag);

  /** Falha de infraestrutura: guarda a tentativa (tipo nao_medido) e preserva o último resultado concluído. */
  function registrarTentativa() {
    const antes = est.ler(slug, instancia);
    const concluido = antes ? (antes.tipo === 'nao_medido' ? antes.ultimoConcluido : { em: antes.em, tipo: antes.tipo, codigo: antes.codigo === undefined ? null : antes.codigo }) : null;
    est.guardar(slug, { em: agora(), tipo: 'nao_medido', codigo: null, instancia, ultimoConcluido: concluido || null });
  }

  async function testar() {
    const r = cortarSaida(await ctx.execSolto('podman', ['exec', '--user', 'agente', '-e', 'HOME=/home/agente', '--', ag.container, 'sh', '-c', SCRIPT], { timeout: PRAZO_EXEC_MS }));
    if (r.erro === 'ENOENT') { log('aviso', 'Diagnóstico: o comando podman não foi encontrado; o teste do YouTube não rodou.'); registrarTentativa(); return 'nao_medido'; }
    // Outro erro do sistema ao iniciar o podman (EACCES, EMFILE...): o teste nem começou.
    if (r.codigo === null && typeof r.erro === 'string' && /^E[A-Z0-9]+$/.test(r.erro)) {
      log('aviso', `Diagnóstico: não consegui iniciar o podman para o teste do YouTube (${r.erro}); o teste não rodou.`);
      registrarTentativa();
      return 'nao_medido';
    }
    // Código 125 é do podman (ex.: "can only create exec sessions on running containers"): infraestrutura, e vale antes de qualquer análise do que o yt-dlp disse.
    if (r.codigo === SAIDA_PODMAN_FALHOU) {
      log('aviso', `Diagnóstico: o container ${ag.container} não aceitou o teste do YouTube (código de saída 125, falha do podman). Confira com dgclaw status.`);
      registrarTentativa();
      return 'nao_medido';
    }
    if (r.codigo === SAIDA_SEM_TMP) {
      log('aviso', `Diagnóstico: o container ${ag.container} não conseguiu criar a pasta temporária do teste do YouTube (código de saída 70). Confira o espaço em disco do agente.`);
      registrarTentativa();
      return 'nao_medido';
    }
    if (r.codigo === SAIDA_SEM_CHECAGEM) {
      log('aviso', `Diagnóstico: o container ${ag.container} não conseguiu conferir a sessão do YouTube da Tela (código de saída 71: falta o sqlite3 ou a consulta ao banco de cookies falhou). A imagem do agente pode estar antiga.`);
      registrarTentativa();
      return 'nao_medido';
    }
    const c = classificarYoutube(r);
    if (c.tipo === 'outro' && RX_CONTAINER.test(r.stderr)) {
      log('aviso', `Diagnóstico: o container ${ag.container} não aceitou o teste do YouTube (código de saída ${c.codigo === null ? 'desconhecido' : c.codigo}). Confira com dgclaw status.`);
      registrarTentativa();
      return 'nao_medido';
    }
    if (c.tipo !== 'ok' && c.tipo !== 'sessao') log('aviso', `Diagnóstico: o teste do YouTube do agente ${slug} falhou: ${textoFalha(c.tipo, c.codigo)}.`);
    est.guardar(slug, { em: agora(), tipo: c.tipo, codigo: c.tipo === 'outro' ? c.codigo : null, instancia });
    return c.tipo;
  }

  const p = testar().catch((e) => {
    log('erro', `Diagnóstico: o teste do YouTube do agente ${slug} não rodou por erro interno (${(e && (e.code || e.name)) || 'desconhecido'}). Confira o log do DG Claw Web e tente de novo na próxima rodada.`);
    try { registrarTentativa(); } catch (e2) { log('erro', `Diagnóstico: não consegui guardar a tentativa do teste do YouTube de ${slug} (${e2.message}).`); }
    return 'nao_medido';
  }).finally(() => est.andando.delete(slug));
  est.andando.set(slug, p);
  return p;
}

function tarefaYoutube(ctx, ag, container) {
  const { slug } = ag;
  if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
  const est = ctx.youtube;

  return {
    sufixo: 'youtube', nome: `Download do YouTube - ${ag.nome}`, depende: container,
    async fn(dep) {
      if (dep && dep.parado === true) return R('nao_medido', 'O container está parado, então não deu para testar o download do YouTube.');
      const v = est.ler(slug, instanciaDe(ag));
      if (!v) return R('nao_medido', 'Ainda não há resultado do teste do download do YouTube. O teste roda sozinho a cada 6 horas.');
      const horario = U.iso(v.em);
      if (v.tipo !== 'nao_medido' && ctx.agora() - v.em > VALIDADE_MS) {
        return R('nao_medido', `O último teste do download do YouTube foi em ${horario}, faz mais de 13 horas, e não vale mais como medida. O teste roda sozinho a cada 6 horas.`, { ultimo_sinal: horario, evidencia: { horario, codigo_saida: null, sinal: 'teste do YouTube: resultado antigo' } });
      }
      const base = { ultimo_sinal: horario, evidencia: { horario, codigo_saida: null, sinal: `teste do YouTube: ${v.tipo}` } };
      if (v.tipo === 'ok') return R('ok', null, base);
      if (v.tipo === 'sessao') return R('ok', 'Sem login o YouTube pede a checagem anti-robô, e a Tela do agente tem uma sessão do YouTube dentro da validade. O teste automático nunca usa essa sessão (só confere que ela existe, sem ler os cookies); é o agente que a usa quando precisa.', base);
      if (v.tipo === 'nao_medido') return R('nao_medido', `A última tentativa de testar o download do YouTube (${horario}) não chegou a rodar. O teste roda sozinho a cada 6 horas.`, base);
      if (v.tipo === 'sem_perfil') {
        return R('atencao', 'O YouTube pediu login ao baixar o vídeo de teste e a Tela deste agente ainda não foi aberta, então não há o navegador dela para usar.', Object.assign(base, {
          o_que_fazer: 'Abra a Tela do agente (menu do agente, grupo Conexões, "Navegador") e entre em youtube.com. O próximo teste automático confere o download.',
        }));
      }
      if (v.tipo === 'login') {
        return R('atencao', 'O YouTube pediu login ao baixar o vídeo de teste, e por isso o download do YouTube parou.', Object.assign(base, {
          o_que_fazer: 'Abra a Tela do agente (menu do agente, grupo Conexões, "Navegador") e entre em youtube.com. O próximo teste automático (a cada 6 horas) confere o download.',
        }));
      }
      if (v.tipo === 'ausente') {
        return R('atencao', 'O comando yt-dlp não existe dentro do container do agente. A imagem do agente está antiga.', Object.assign(base,
          conserta(`o yt-dlp não existe no container de o agente ${slug}; a imagem está antiga.`, '`dgclaw status`', `dgclaw agente recriar ${slug}`)));
      }
      const motivo = v.tipo === 'tempo'
        ? `O download de teste do YouTube demorou demais (passou de ${PRAZO_DOWNLOAD_S} s).`
        : `O download de teste do YouTube falhou (código de saída ${Number.isInteger(v.codigo) ? v.codigo : 'desconhecido'}).`;
      return R('atencao', motivo, Object.assign(base, {
        o_que_fazer: 'Tente de novo mais tarde (o teste se repete a cada 6 horas). Se continuar assim, mostre este item ao suporte.',
      }));
    },
  };
}

module.exports = { tarefaYoutube, testarYoutube, criarEstadoYoutube, classificarYoutube, cortarSaida, LIMITE_SAIDA, SCRIPT, VIDEO_TESTE };
