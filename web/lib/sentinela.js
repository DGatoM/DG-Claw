'use strict';
// Sentinela do servidor, lado do painel: lê o estado que a sentinela (root, a cada minuto) grava em
// <dataDir>/sentinela/estado.json, manda push quando sai um aviso novo e deixa o dono pedir um aviso de teste.
// O Web não mede nada e não escreve no estado: só lê. Rotas: web/docs/SENTINELA.md. Desenho: docs/SENTINELA.md.
//
// O arquivo não tem segredo (a sentinela o grava sem token, chat id, senha nem URL do pulso), e aqui cada campo
// é conferido de novo antes de sair pela API: só passa o que o contrato promete, com tipo e tamanho.
// Medida que não veio vale null (não medido), nunca 0.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const H = require('./http');

const BASE = '/api/v1/sentinela';
const CACHE_MS = 30 * 1000;
const PARADA_S = 5 * 60;
const MAX_ARQUIVO = 1024 * 1024;
const TIMEOUT_TESTE_MS = 60 * 1000;
const MAX_SAIDA = 256 * 1024;
const NIVEIS = ['ok', 'aviso', 'serio', 'critico'];
const ESTADOS_AGENTE = ['ok', 'caido', 'canal_caido'];
const COMO_REFAZER = 'Rode "sudo dgclaw sentinela rodar" no servidor para refazê-lo.';

const INVISIVEIS = '\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF';
const CONTROLE = new RegExp(`[${INVISIVEIS}]`, 'g');
const texto = (v, max) => (typeof v === 'string' ? Array.from(v.replace(CONTROLE, ' ')).slice(0, max).join('').trim() : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nivel = (v) => (NIVEIS.includes(v) ? v : null);
const lista = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function dataIso(v) {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Só o que a API promete. O corpo do aviso fica inteiro aqui (a tela escapa); o push corta em 300. */
function normaliza(j) {
  const ram = objeto(j.ram);
  const reserva = objeto(j.reserva);
  const canais = objeto(j.canais);
  const aviso = j.aviso && typeof j.aviso === 'object' && !Array.isArray(j.aviso) ? j.aviso : null;
  return {
    versao: Number.isInteger(j.versao) ? j.versao : null,
    atualizado_em: dataIso(j.atualizado_em),
    servidor: texto(j.servidor, 120),
    nivel_geral: nivel(j.nivel_geral),
    disco: lista(j.disco, 12).map((d) => ({
      ponto: texto(objeto(d).ponto, 200), usado_pct: numero(objeto(d).usado_pct), livre_gb: numero(objeto(d).livre_gb),
      total_gb: numero(objeto(d).total_gb), inodes_pct: numero(objeto(d).inodes_pct), nivel: nivel(objeto(d).nivel),
    })),
    ram: {
      usado_pct: numero(ram.usado_pct), disponivel_mb: numero(ram.disponivel_mb), total_mb: numero(ram.total_mb),
      swap_pct: numero(ram.swap_pct), nivel: nivel(ram.nivel),
    },
    reserva: {
      ligada: typeof reserva.ligada === 'boolean' ? reserva.ligada : null,
      existe: typeof reserva.existe === 'boolean' ? reserva.existe : null,
      tamanho_gb: numero(reserva.tamanho_gb), liberada_em: dataIso(reserva.liberada_em),
    },
    agentes: lista(j.agentes, 60).map((a) => ({
      slug: texto(objeto(a).slug, 60), nome: texto(objeto(a).nome, 80),
      estado: ESTADOS_AGENTE.includes(objeto(a).estado) ? a.estado : 'desconhecido',
      desde: dataIso(objeto(a).desde), motivo: texto(objeto(a).motivo, 300) || '',
    })),
    servicos: lista(j.servicos, 20).map((s) => ({ nome: texto(objeto(s).nome, 80), ativo: typeof objeto(s).ativo === 'boolean' ? s.ativo : null })),
    maiores_pastas: lista(j.maiores_pastas, 20).map((p) => ({ caminho: texto(objeto(p).caminho, 300), gb: numero(objeto(p).gb) })),
    ultimas_acoes: lista(j.ultimas_acoes, 20).map((a) => ({
      em: dataIso(objeto(a).em), tipo: texto(objeto(a).tipo, 40), descricao: texto(objeto(a).descricao, 300), liberou_mb: numero(objeto(a).liberou_mb),
    })),
    canais: {
      telegram: canais.telegram === true, email: canais.email === true, pulso: canais.pulso === true, admin: canais.admin === true,
      ultimo_envio_ok: dataIso(canais.ultimo_envio_ok),
      ultima_falha: canais.ultima_falha == null ? null : texto(typeof canais.ultima_falha === 'string' ? canais.ultima_falha : JSON.stringify(canais.ultima_falha), 300),
    },
    aviso: aviso ? {
      seq: Number.isInteger(aviso.seq) && aviso.seq >= 0 ? aviso.seq : null, nivel: nivel(aviso.nivel) || (aviso.nivel === 'resolvido' ? 'resolvido' : null),
      titulo: texto(aviso.titulo, 200), corpo: Array.from(String(aviso.corpo == null ? '' : aviso.corpo).replace(CONTROLE, (c) => (c === '\n' ? '\n' : ' '))).slice(0, 2000).join(''),
      em: dataIso(aviso.em),
    } : null,
  };
}

function criarSentinela(opcoes) {
  const { dataDir, log } = opcoes;
  const push = opcoes.push;
  const agora = opcoes.agora || (() => Date.now());
  const executa = opcoes.execFile || execFile;
  const appDir = opcoes.appDir || path.join(__dirname, '..', '..');
  const dir = path.join(dataDir, 'sentinela');
  const arqEstado = path.join(dir, 'estado.json');
  const arqPush = path.join(dir, 'push.json');
  const script = path.join(appDir, 'seguranca', 'sentinela', 'sentinela.py');

  let cache = null;            // { mtimeMs, tamanho, resultado }
  let ultimoSeq = null;        // espelho em memória de push.json: um disco que não grava não pode repetir o push a cada tick
  let seqCarregado = false;
  let timer = null;
  let testando = false;
  let falhaLogada = null;

  /** { ausente: true } | { erro } | { estado }. Um stat por chamada; relê o arquivo só quando o mtime (ou o tamanho) muda. */
  function lerEstado() {
    let st;
    try { st = fs.statSync(arqEstado); } catch (e) {
      cache = null;
      if (e.code === 'ENOENT') return { ausente: true };
      return { erro: `Não consegui ler ${arqEstado} (${e.code || e.message}). ${COMO_REFAZER}` };
    }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.tamanho === st.size) return cache.resultado;
    let resultado;
    if (st.size > MAX_ARQUIVO) {
      resultado = { erro: `O arquivo ${arqEstado} tem ${st.size} bytes e o limite é ${MAX_ARQUIVO}. ${COMO_REFAZER}` };
    } else {
      try {
        const j = JSON.parse(fs.readFileSync(arqEstado, 'utf8'));
        resultado = j && typeof j === 'object' && !Array.isArray(j)
          ? { estado: normaliza(j) }
          : { erro: `O arquivo ${arqEstado} não tem o formato esperado (precisa ser um objeto JSON). ${COMO_REFAZER}` };
      } catch (e) {
        resultado = { erro: `Não consegui ler ${arqEstado} (${e.code || e.message}). ${COMO_REFAZER}` };
      }
    }
    cache = { mtimeMs: st.mtimeMs, tamanho: st.size, resultado };
    return resultado;
  }

  function lerSeqGuardado() {
    if (seqCarregado) return ultimoSeq;
    seqCarregado = true;
    try {
      const d = JSON.parse(fs.readFileSync(arqPush, 'utf8'));
      ultimoSeq = Number.isInteger(d && d.seq) ? d.seq : null;
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Sentinela: ${arqPush} está ilegível (${e.code || e.message}); trato como primeira leitura e só guardo o aviso atual, sem mandar push.`);
      ultimoSeq = null;
    }
    return ultimoSeq;
  }

  function gravaSeq(seq) {
    ultimoSeq = seq;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      const tmp = `${arqPush}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify({ seq, quando: new Date(agora()).toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, arqPush);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter sido criado */ }
        throw e;
      }
    } catch (e) {
      log('erro', `Sentinela: não consegui guardar o último aviso em ${arqPush} (${e.code || e.message}). Se o Web reiniciar, o próximo aviso pode chegar repetido; confira o espaço e as permissões de ${dir}.`);
    }
  }

  /** Manda push quando aviso.seq cresceu. A primeira leitura só guarda. Nunca lança. */
  async function verificar() {
    const l = lerEstado();
    if (l.ausente) return;
    if (l.erro) {
      if (falhaLogada !== l.erro) { falhaLogada = l.erro; log('erro', `Sentinela: ${l.erro}`); }
      return;
    }
    falhaLogada = null;
    const aviso = l.estado.aviso;
    if (!aviso || aviso.seq == null) return;
    const antes = lerSeqGuardado();
    if (antes === aviso.seq) return;
    gravaSeq(aviso.seq);
    if (antes == null || aviso.seq < antes) return;   // primeira leitura, ou a sentinela recomeçou a contagem: só guarda
    const critico = aviso.nivel === 'critico';
    try {
      const r = await push.enviar({
        titulo: aviso.titulo || 'Aviso do servidor',
        corpo: Array.from((aviso.corpo || '').replace(/\s+/g, ' ').trim()).slice(0, 300).join(''),
        tag: 'sentinela',
        url: '/seguranca#saude-servidor',
        exigir_interacao: critico,
      });
      log('info', `Sentinela: aviso ${aviso.seq} (${aviso.nivel || 'sem nível'}) mandado ao celular: ${r.ok} de ${r.inscricoes} aparelhos${r.falhas && r.falhas.length ? `, ${r.falhas.length} falha(s)` : ''}.`);
    } catch (e) {
      log('erro', `Sentinela: não consegui mandar o aviso ${aviso.seq} ao celular (${e.message}).`);
    }
  }

  function iniciar() {
    if (timer) return;
    timer = setInterval(() => { verificar().catch((e) => log('erro', `Sentinela: ${e.message}`)); }, opcoes.intervaloMs || CACHE_MS);
    if (timer.unref) timer.unref();
    verificar().catch((e) => log('erro', `Sentinela: ${e.message}`));
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }

  function estadoDaApi(res) {
    const l = lerEstado();
    if (l.ausente) {
      return H.enviaJson(res, 200, {
        ok: true, instalado: false,
        motivo: 'A sentinela ainda não rodou neste servidor: o arquivo de estado ainda não existe. Ela roda a cada minuto; se acabou de atualizar o DG Claw, espere um minuto. Se continuar assim, peça ao Admin para conferir o dgclaw-sentinela.timer.',
      });
    }
    if (l.erro) { log('erro', `Sentinela: ${l.erro}`); return H.erroJson(res, 503, l.erro); }
    const e = l.estado;
    const idade = e.atualizado_em ? Math.max(0, Math.round((agora() - Date.parse(e.atualizado_em)) / 1000)) : null;
    return H.enviaJson(res, 200, { ok: true, instalado: true, idade_s: idade, parada: idade == null ? null : idade > PARADA_S, ...e });
  }

  function testar(res) {
    if (!fs.existsSync(script)) {
      log('erro', `Sentinela: o motor não está instalado (falta ${script}).`);
      return H.erroJson(res, 503, `O motor da sentinela não está instalado neste servidor (falta ${script}). Peça ao Admin para atualizar o DG Claw com "dgclaw atualizar".`);
    }
    if (testando) return H.erroJson(res, 409, 'Já há um teste de avisos em andamento. Espere ele terminar (até 1 minuto) e tente de novo.');
    testando = true;
    return new Promise((resolve) => {
      executa('python3', ['-I', script, 'testar-avisos', '--json'], { timeout: TIMEOUT_TESTE_MS, maxBuffer: MAX_SAIDA, windowsHide: true, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } }, (err, stdout, stderr) => {
        testando = false;
        let j = null;
        try { j = JSON.parse(String(stdout || '')); } catch { j = null; }
        if (j && typeof j === 'object') {
          resolve(H.enviaJson(res, 200, { ok: true, codigo_saida: err && typeof err.code === 'number' ? err.code : 0, resultado: j }));
          return;
        }
        const cortaStderr = texto(String(stderr || ''), 300) || '(sem mensagem)';
        if (err && (err.killed || err.signal === 'SIGTERM')) {
          log('erro', 'Sentinela: o teste de avisos passou de 60 s e foi interrompido.');
          resolve(H.erroJson(res, 504, 'O teste de avisos demorou mais de 60 segundos e foi interrompido. Algum canal pode estar sem resposta; rode "sudo dgclaw sentinela testar-avisos" no servidor para ver qual.'));
          return;
        }
        log('erro', `Sentinela: o teste de avisos não devolveu um resultado legível (${err ? err.code || err.message : 'saída vazia'}): ${cortaStderr}`);
        resolve(H.erroJson(res, 502, `O teste de avisos não terminou como esperado (${err && err.code ? `código ${err.code}` : 'saída ilegível'}: ${cortaStderr}). Rode "sudo dgclaw sentinela testar-avisos" no servidor para ver o detalhe.`));
      });
    });
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SENTINELA.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Sentinela: não consegui ler docs/SENTINELA.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento da sentinela não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Devolve true quando tratou o pedido. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    // O servidor já não libera estas rotas na caixa; esta é a segunda trava.
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'A saúde do servidor é só do dono, pelo painel. Agente não usa esta rota.');
      return true;
    }
    const m = req.method;
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '') { if (m !== 'GET') return metodoErrado('GET'); estadoDaApi(res); return true; }
      if (sub === '/docs.md') { if (m !== 'GET') return metodoErrado('GET'); docs(res); return true; }
      if (sub === '/testar') { if (m !== 'POST') return metodoErrado('POST'); await testar(res); return true; }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message); return true; }
      log('erro', `Sentinela: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido da saúde do servidor. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  return { rotas, lerEstado, verificar, iniciar, parar };
}

module.exports = { criarSentinela, normaliza };
