'use strict';
// Download do YouTube do agente. Faz um download REAL e pequeno dentro do container, como o usuário agente, e
// guarda o último resultado com horário. O yt-dlp lê os cookies do navegador da Tela (configuração em
// ~/.config/yt-dlp/config); quando a conta sai do YouTube, é aqui que o dono fica sabendo, em vez de o agente
// falhar calado no meio de um pedido. Não depende do motor do agente (Claude ou Codex): roda no container.

const fs = require('node:fs');
const path = require('node:path');
const { higienizar } = require('./higiene');
const U = require('./util');

const { R, conserta } = U;
const DIA_MS = 24 * 3600 * 1000;
const NOVA_TENTATIVA_MS = 5 * 60 * 1000; // depois de uma falha, quem abre a saúde pode testar de novo a cada 5 min
const PRAZO_DOWNLOAD_S = 80;             // teto dentro do container (comando `timeout`)
const PRAZO_EXEC_MS = 100000;            // teto de quem chama, um pouco acima do de dentro
const VIDEO_TESTE = 'https://www.youtube.com/watch?v=jNQXAC9IJRQ'; // "Me at the zoo": 19 s, o primeiro vídeo do YouTube, estável
const NOME_ARQUIVO = 'youtube-saude.json';

// Roda dentro do container, sem nenhum valor vindo de fora. A pasta é temporária e some ao final.
const SCRIPT = [
  'd=$(mktemp -d /tmp/yt-saude.XXXXXX) || exit 70',
  'trap \'rm -rf "$d"\' EXIT',
  'if ! command -v yt-dlp >/dev/null 2>&1',
  'then',
  '  echo "yt-dlp: command not found" >&2',
  '  exit 127',
  'fi',
  `timeout ${PRAZO_DOWNLOAD_S} yt-dlp --no-playlist --no-warnings --no-progress --socket-timeout 20 -f worst --max-filesize 5M -P "$d" -o '%(id)s.%(ext)s' '${VIDEO_TESTE}' || exit $?`,
  'if ! ls "$d" | grep -q .',
  'then',
  '  echo "nenhum arquivo foi baixado" >&2',
  '  exit 65',
  'fi',
].join('\n');

const RX_LOGIN = /sign in to confirm|cookies are no longer valid|please sign in|login required/i;
// Cookie e token não podem sair na tela: além da higiene geral, some linha de cabeçalho Cookie, par nome=valor dos
// cookies do Google e qualquer sequência longa de letras e números (valor de cookie ou token).
const RX_CABECALHO_COOKIE = /(?:set-)?cookie\s*:.*$/i;
const RX_PAR_COOKIE = /\b(?:__Secure-\w+|\w*SID\w*|LOGIN_INFO|VISITOR_\w+|YSC|NID)\s*=\s*[^\s;]+/gi;
const RX_SEQUENCIA_LONGA = /[A-Za-z0-9_%.-]{32,}/g;
const semCookies = (t) => String(t).replace(RX_CABECALHO_COOKIE, '[oculto]').replace(RX_PAR_COOKIE, '[oculto]').replace(RX_SEQUENCIA_LONGA, '[oculto]');
const RX_AUSENTE = /yt-dlp:? (?:command )?not found|yt-dlp: no such file|executable file .*yt-dlp.* not found/i;

/**
 * Classifica o resultado do comando. `r` é { codigo, stdout, stderr, erro }.
 * Devolve { tipo: 'ok' | 'login' | 'ausente' | 'tempo' | 'outro', detalhe }.
 * `detalhe` só existe em 'outro' e 'tempo': a última linha do stderr, já sem segredo.
 */
function classificarYoutube(r) {
  const saida = `${String(r.stderr || '').slice(0, 16384)}\n${String(r.stdout || '').slice(0, 16384)}`;
  if (r.codigo === 0 && !r.erro) return { tipo: 'ok' };
  if (RX_LOGIN.test(saida)) return { tipo: 'login' };
  if (r.codigo === 127 || RX_AUSENTE.test(saida)) return { tipo: 'ausente' };
  if (r.erro === 'timeout' || r.erro === 'prazo' || r.codigo === 124) return { tipo: 'tempo', detalhe: `passou de ${PRAZO_DOWNLOAD_S} s` };
  const linhas = String(r.stderr || '').slice(-4096).split('\n').map((l) => l.trim()).filter(Boolean);
  const ultima = linhas.length ? linhas[linhas.length - 1] : '';
  return { tipo: 'outro', detalhe: higienizar(semCookies(ultima), 200) || `o comando terminou com código ${r.codigo === null || r.codigo === undefined ? 'desconhecido' : r.codigo}` };
}

/** Estado guardado por agente, em memória e em <dataDir>/youtube-saude.json (só horário, tipo e detalhe higienizado). */
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
    andando,
  };
}

function tarefaYoutube(ctx, ag, container) {
  const { agora, log } = ctx;
  const { slug } = ag;
  if (!ctx.youtube) ctx.youtube = criarEstadoYoutube(ctx);
  const est = ctx.youtube;

  async function testar() {
    const r = await ctx.execSolto('podman', ['exec', '--user', 'agente', '-e', 'HOME=/home/agente', ag.container, 'sh', '-c', SCRIPT], { timeout: PRAZO_EXEC_MS });
    if (r.erro === 'ENOENT') { log('aviso', 'Diagnóstico: o comando podman não foi encontrado; o teste do YouTube não rodou.'); return; }
    const c = classificarYoutube(r);
    if (c.tipo === 'outro' && /no such container|cannot (?:exec|find)|container .* (?:is not running|does not exist)/i.test(String(r.stderr).slice(0, 2000))) {
      log('aviso', `Diagnóstico: o container ${ag.container} não aceitou o teste do YouTube: ${higienizar(semCookies(r.stderr), 200)}`);
      return;
    }
    if (c.tipo !== 'ok') log('aviso', `Diagnóstico: o teste do YouTube do agente ${slug} falhou (${c.tipo}${c.detalhe ? `: ${c.detalhe}` : ''}).`);
    est.guardar(slug, { em: agora(), tipo: c.tipo, detalhe: c.detalhe || null });
  }

  /** Dispara o teste em segundo plano (a verificação tem poucos segundos; o download pode levar mais). */
  function disparar() {
    if (est.andando.has(slug)) return;
    const p = testar().catch((e) => log('erro', `Diagnóstico: o teste do YouTube do agente ${slug} falhou por erro interno: ${e && e.stack ? e.stack : e}`))
      .finally(() => est.andando.delete(slug));
    est.andando.set(slug, p);
  }

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
        ? `O download de teste do YouTube demorou demais (${v.detalhe || 'tempo esgotado'}).`
        : `O download de teste do YouTube falhou: ${protegeDetalhe(v.detalhe)}.`;
      return R('atencao', motivo, Object.assign(base, {
        o_que_fazer: 'Tente de novo em alguns minutos (o teste se repete sozinho). Se continuar assim, mostre este item ao suporte.',
      }));
    },
  };
}

function protegeDetalhe(d) { return higienizar(semCookies(d || 'erro sem mensagem'), 200); }

module.exports = { tarefaYoutube, classificarYoutube, SCRIPT, VIDEO_TESTE };
