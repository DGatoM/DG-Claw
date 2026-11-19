'use strict';
// Download do YouTube do agente. Faz um download REAL e pequeno dentro do container, como o usuário agente, e
// guarda o último resultado com horário. O teste ignora qualquer configuração do yt-dlp e passa as opções na própria
// chamada (inclusive os cookies da Tela, quando a pasta do Chrome existe); quando a conta sai do YouTube, é aqui que o
// dono fica sabendo, em vez de o agente falhar calado no meio de um pedido. Nada do stderr do yt-dlp sai daqui: a
// classificação devolve só um tipo de uma lista fechada (e o código de saída), e todo texto mostrado é fixo. Não depende do motor do agente (Claude ou Codex): roda no container.

const fs = require('node:fs');
const path = require('node:path');
const U = require('./util');

const { R, conserta } = U;
const DIA_MS = 24 * 3600 * 1000;
const NOVA_TENTATIVA_MS = 5 * 60 * 1000; // depois de uma falha, quem abre a saúde pode testar de novo a cada 5 min
const PRAZO_DOWNLOAD_S = 80;             // teto dentro do container (comando `timeout`)
const PRAZO_EXEC_MS = 100000;            // teto de quem chama, um pouco acima do de dentro
const VIDEO_TESTE = 'https://www.youtube.com/watch?v=jNQXAC9IJRQ'; // "Me at the zoo": 19 s, o primeiro vídeo do YouTube, estável
const NOME_ARQUIVO = 'youtube-saude.json';
const LIMITE_SAIDA = 8192;               // bytes lidos de stderr e de stdout, cortados antes de qualquer regex ou log
const PASTA_COOKIES = '/home/agente/.tela-chrome';

// Roda dentro do container, sem nenhum valor vindo de fora. A pasta é temporária e some ao final. O yt-dlp ignora
// a configuração do usuário e dos plugins; os cookies da Tela entram só se a pasta do Chrome existir.
const SCRIPT = [
  'd=$(mktemp -d /tmp/yt-saude.XXXXXX) || exit 70',
  'trap \'rm -rf "$d"\' EXIT',
  'if ! command -v yt-dlp >/dev/null 2>&1',
  'then',
  '  echo "yt-dlp: command not found" >&2',
  '  exit 127',
  'fi',
  'set --',
  `if [ -d ${PASTA_COOKIES} ]`,
  'then',
  `  set -- --cookies-from-browser "chrome+basictext:${PASTA_COOKIES}"`,
  'fi',
  `timeout ${PRAZO_DOWNLOAD_S} yt-dlp --ignore-config --no-plugin-dirs --js-runtimes node "$@" --no-playlist --no-progress --socket-timeout 20 -f worst --max-filesize 5M -P "$d" -o '%(id)s.%(ext)s' '${VIDEO_TESTE}' || exit $?`,
  'if ! ls "$d" | grep -q .',
  'then',
  '  echo "nenhum arquivo foi baixado" >&2',
  '  exit 65',
  'fi',
].join('\n');

// Sinais de que a conta do YouTube não vale mais: o pedido de login, e o aviso de cookies inválidos (que o yt-dlp dá
// mesmo quando consegue baixar um vídeo público).
const RX_LOGIN = /sign in to confirm|cookies are no longer valid|cookies.{0,40}(?:invalid|expired)|please sign in|login required/i;
const RX_AUSENTE = /yt-dlp:? (?:command )?not found|yt-dlp: no such file|executable file .*yt-dlp.* not found/i;
const RX_CONTAINER = /no such container|cannot (?:exec|find)|container .* (?:is not running|does not exist)/i;

/** Corta stderr e stdout no limite ANTES de qualquer regex, log ou gravação. */
function cortarSaida(r) {
  return { codigo: r.codigo, erro: r.erro, stderr: String(r.stderr || '').slice(0, LIMITE_SAIDA), stdout: String(r.stdout || '').slice(0, LIMITE_SAIDA) };
}

/**
 * Classifica o resultado do comando. `r` é { codigo, stdout, stderr, erro }.
 * Devolve { tipo: 'ok' | 'login' | 'ausente' | 'tempo' | 'outro', codigo? }. `codigo` (número) só existe em 'outro'.
 * Nunca devolve texto do stderr: o que sai daqui pode ir para log, arquivo e resposta da API.
 */
function classificarYoutube(r) {
  const c = cortarSaida(r);
  const saida = `${c.stderr}\n${c.stdout}`;
  if (RX_LOGIN.test(saida)) return { tipo: 'login' };
  if (c.codigo === 0 && !c.erro) return { tipo: 'ok' };
  if (c.codigo === 127 || RX_AUSENTE.test(saida)) return { tipo: 'ausente' };
  if (c.erro === 'timeout' || c.erro === 'prazo' || c.codigo === 124) return { tipo: 'tempo' };
  return { tipo: 'outro', codigo: Number.isInteger(c.codigo) ? c.codigo : null };
}

const TEXTO_TIPO = {
  login: 'o YouTube pediu login',
  ausente: 'o yt-dlp não existe no container',
  tempo: `o download passou de ${PRAZO_DOWNLOAD_S} s`,
  outro: 'o download terminou com erro',
};
const textoFalha = (tipo, codigo) => `${TEXTO_TIPO[tipo] || tipo}${tipo === 'outro' ? ` (código de saída ${codigo === null || codigo === undefined ? 'desconhecido' : codigo})` : ''}`;

/** Estado guardado por agente, em memória e em <dataDir>/youtube-saude.json (só horário, tipo, código de saída e a marca de aviso pendente). */
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
    ler: (slug) => {
      const v = carregar()[slug];
      return v && typeof v === 'object' && typeof v.em === 'number' && typeof v.tipo === 'string' ? v : null;
    },
    guardar: (slug, v) => { carregar()[slug] = v; gravar(); },
    /** Slugs com queda ainda não avisada ao dono. */
    pendentes: () => Object.keys(carregar()).filter((k) => carregar()[k] && carregar()[k].avisoPendente === true),
    limparAviso: (slug) => { const v = carregar()[slug]; if (v && v.avisoPendente) { v.avisoPendente = false; gravar(); } },
    andando,
  };
}

/**
 * Roda o teste do YouTube do agente e grava o resultado no estado (ctx.youtube). Não dispara dois testes do mesmo
 * slug ao mesmo tempo: se já há um rodando, espera esse e devolve o tipo que ele gravou. Devolve o tipo gravado, ou
 * null quando o teste não rodou (podman ausente, container que não aceitou o comando ou erro interno).
 */
function testarYoutube(ctx, ag) {
  const { agora, log } = ctx;
  const { slug } = ag;
  if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
  const est = ctx.youtube;
  if (est.andando.has(slug)) return est.andando.get(slug);

  async function testar() {
    const r = cortarSaida(await ctx.execSolto('podman', ['exec', '--user', 'agente', '-e', 'HOME=/home/agente', ag.container, 'sh', '-c', SCRIPT], { timeout: PRAZO_EXEC_MS }));
    if (r.erro === 'ENOENT') { log('aviso', 'Diagnóstico: o comando podman não foi encontrado; o teste do YouTube não rodou.'); return null; }
    const c = classificarYoutube(r);
    if (c.tipo === 'outro' && RX_CONTAINER.test(r.stderr)) {
      log('aviso', `Diagnóstico: o container ${ag.container} não aceitou o teste do YouTube (código de saída ${c.codigo === null ? 'desconhecido' : c.codigo}). Confira com dgclaw status.`);
      return null;
    }
    if (c.tipo !== 'ok') log('aviso', `Diagnóstico: o teste do YouTube do agente ${slug} falhou: ${textoFalha(c.tipo, c.codigo)}.`);
    const antes = est.ler(slug);
    let avisoPendente = !!(antes && antes.avisoPendente);
    if (c.tipo === 'login' && !(antes && antes.tipo === 'login')) avisoPendente = true;
    if (c.tipo === 'ok') avisoPendente = false;
    est.guardar(slug, { em: agora(), tipo: c.tipo, codigo: c.tipo === 'outro' ? c.codigo : null, avisoPendente });
    return c.tipo;
  }

  const p = testar().catch((e) => { log('erro', `Diagnóstico: o teste do YouTube do agente ${slug} falhou por erro interno: ${e && e.stack ? e.stack : e}`); return null; })
    .finally(() => est.andando.delete(slug));
  est.andando.set(slug, p);
  return p;
}

function tarefaYoutube(ctx, ag, container) {
  const { agora } = ctx;
  const { slug } = ag;
  if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
  const est = ctx.youtube;

  /** Dispara o teste em segundo plano (a verificação tem poucos segundos; o download pode levar mais). */
  function disparar() { testarYoutube(ctx, ag); }

  return {
    sufixo: 'youtube', nome: `Download do YouTube - ${ag.nome}`, depende: container,
    async fn(dep) {
      if (dep && dep.parado === true) return R('nao_medido', 'O container está parado, então não deu para testar o download do YouTube.');
      const v = est.ler(slug);
      const idade = v ? agora() - v.em : Infinity;
      if (!v || idade > DIA_MS || (v.tipo !== 'ok' && idade > NOVA_TENTATIVA_MS)) disparar();
      if (!v) return R('nao_medido', 'O teste do download do YouTube está rodando pela primeira vez. Abra o diagnóstico de novo em um minuto.');
      const horario = U.iso(v.em);
      const base = { ultimo_sinal: horario, evidencia: { horario, codigo_saida: null, sinal: `teste do YouTube: ${v.tipo}` } };
      if (v.tipo === 'ok') return R('ok', null, base);
      if (v.tipo === 'login') {
        return R('atencao', 'O YouTube pediu login: a Tela deste agente não tem uma conta do YouTube logada (ou a sessão caiu), e por isso ele não consegue baixar vídeos.', Object.assign(base, {
          o_que_fazer: 'Abra a Tela do agente (menu do agente, grupo Conexões, "Navegador"), entre em youtube.com com a conta do dono e abra este diagnóstico de novo em alguns minutos para testar.',
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
        o_que_fazer: 'Tente de novo em alguns minutos (o teste se repete sozinho). Se continuar assim, mostre este item ao suporte.',
      }));
    },
  };
}

module.exports = { tarefaYoutube, testarYoutube, criarEstadoYoutube, classificarYoutube, cortarSaida, LIMITE_SAIDA, SCRIPT, VIDEO_TESTE };
