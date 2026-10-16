'use strict';
// Mídia: registro de id -> caminho e entrega com suporte a Range.
// Só sai arquivo que esteja DENTRO do home_host do agente dono (ou de DGCLAW_WEB_DATA),
// conferido com realpath a cada pedido (link simbólico para fora é recusado).

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executar = promisify(execFile);
const thumbsEmCurso = new Map();
let thumbsAtivas = 0;
const filaThumbs = [];
async function geraMiniatura(real, destino) {
  if (thumbsEmCurso.has(destino)) return thumbsEmCurso.get(destino);
  const promessa = (async () => {
    if (thumbsAtivas >= 2) await new Promise(r => filaThumbs.push(r));
    thumbsAtivas++;
    const tmp = destino + '.tmp.jpg';
    try {
      await fs.promises.mkdir(path.dirname(destino), { recursive: true, mode: 0o700 });
      await executar('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', real,
        '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '5', '-threads', '1', tmp], { timeout: 15000, maxBuffer: 65536 });
      await fs.promises.rename(tmp, destino);
    } finally {
      thumbsAtivas--; const proximo = filaThumbs.shift(); if (proximo) proximo();
      try { await fs.promises.unlink(tmp); } catch (e) { if (e.code !== 'ENOENT') console.warn('miniatura: temporário não removido:', e.message); }
    }
  })();
  thumbsEmCurso.set(destino, promessa);
  try { return await promessa; } finally { thumbsEmCurso.delete(destino); }
}

const path = require('node:path');
const { erroJson, escapaHtml } = require('./http');

const MIMES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.zip': 'application/zip', '.html': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const EXT_FOTO = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif', '.bmp']);
const EXT_VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const EXT_AUDIO = new Set(['.mp3', '.m4a', '.ogg', '.oga', '.opus', '.wav', '.aac', '.flac']);

// Visuais na conversa (docs/VISUAIS.md): o balão mostra um vis-<assunto>.html num iframe
// sandbox. A rota /visual monta o documento e leva o CSP no cabeçalho, então o isolamento
// vale mesmo se alguém abrir a URL direto numa aba. Texto igual ao CSP_VISUAL do DG Telegram.
const VISUAL_MAX_BYTES = 2 * 1024 * 1024;
const CDNS_VISUAL = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com';
const CSP_VISUAL = 'sandbox allow-scripts; default-src \'none\'; ' +
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS_VISUAL}; ` +
  `style-src 'unsafe-inline' ${CDNS_VISUAL}; ` +
  'img-src data: blob:; media-src data: blob:; ' +
  `font-src data: ${CDNS_VISUAL}; ` +
  'connect-src \'none\'; form-action \'none\'; base-uri \'none\'; frame-src \'none\'; ' +
  'worker-src \'none\'; manifest-src \'none\'; frame-ancestors \'self\'';
const CABECALHOS_VISUAL = {
  'Content-Security-Policy': CSP_VISUAL,
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store, no-transform',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
};
// Arquivo que o navegador EXECUTA quando a URL é aberta direto. Aqui o .html já sai como
// text/plain, mas decidimos pela extensão também: se alguém mudar o mime, o sandbox continua.
const EXT_ATIVA = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs']);
const MIME_ATIVO = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript']);
const CSP_MIDIA_ATIVA = 'sandbox; default-src \'none\'; style-src \'unsafe-inline\'; img-src data:';

function ehAtiva(caminho, mime) {
  return EXT_ATIVA.has(path.extname(caminho || '').toLowerCase()) ||
    MIME_ATIVO.has(String(mime || '').split(';')[0].trim().toLowerCase());
}

function kindDe(caminho) {
  const e = path.extname(caminho || '').toLowerCase();
  if (EXT_FOTO.has(e)) return 'photo';
  if (EXT_VIDEO.has(e)) return 'video';
  if (EXT_AUDIO.has(e)) return 'audio';
  return 'document';
}
function mimeDe(caminho) { return MIMES[path.extname(caminho || '').toLowerCase()] || 'application/octet-stream'; }
const idDe = (caminho) => crypto.createHash('sha1').update(caminho).digest('hex').slice(0, 16);

/** Está `alvo` (já com realpath) dentro de `raiz` (já com realpath)? */
function dentro(raiz, alvo) {
  const rel = path.relative(raiz, alvo);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function criarMidia({ dataDir, log, registro, publicDir }) {
  const reg = new Map(); // id -> { path, kind, mime, nome, slug }
  const baseVisual = new Map(); // nome do arquivo -> { mtime, texto }

  /** Texto de public/<nome>, com cache pela mtime (editar a base vale sem restart). Ausente: log e '' (o visual sai sem a base). */
  function lerBase(nome) {
    const caminho = path.join(publicDir || path.join(__dirname, '..', 'public'), nome);
    try {
      const mt = fs.statSync(caminho).mtimeMs;
      const c = baseVisual.get(nome);
      if (c && c.mtime === mt) return c.texto;
      const texto = fs.readFileSync(caminho, 'utf8');
      baseVisual.set(nome, { mtime: mt, texto });
      return texto;
    } catch (err) {
      log('erro', `Visual: não li a base public/${nome} (${err.code || err.message}); o visual sai SEM ela (sem peças dv-* nem window.dgvis). Confira se o arquivo existe.`);
      return '';
    }
  }

  function paginaVisual(corpo, tema) {
    // um "</style" ou "</script" dentro da base fecharia a tag antes da hora
    const css = lerBase('dgvis.css').replace(/<\/(style)/gi, '<\\/$1');
    const js = lerBase('dgvis.js').replace(/<\/(script)/gi, '<\\/$1');
    // linhas que vêm antes do arquivo da agente, pro dgvis.js dizer a linha DO ARQUIVO dela
    const linhas = 2 + (css.match(/\n/g) || []).length + (js.match(/\n/g) || []).length;
    return '<!doctype html>\n' +
      `<html lang="pt-BR" data-tema="${tema}" data-dgvis="1" data-linhas-base="${linhas}"><head>` +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<style id="dgvis-css">${css}</style>` +
      `<script id="dgvis-js">${js}</script>\n${corpo}`;
  }

  function enviaPagina(req, res, status, html) {
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(status, Object.assign({}, CABECALHOS_VISUAL, { 'Content-Length': buf.length }));
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  /** Página de erro DENTRO do iframe, que também avisa o app por postMessage. Nunca JSON nem página em branco. */
  function erroVisual(req, res, status, msg, tema, nome) {
    log('aviso', `Visual${nome ? ' ' + nome : ''}: ${msg} (status ${status})`);
    const aviso = JSON.stringify({ dgvis: 1, tipo: 'erro', msg: msg.slice(0, 400), status }).replace(/</g, '\\u003c');
    const corpo = '<div class="dv-cartao dv-alerta" style="margin:12px">' +
      '<strong>Não deu para mostrar o visual.</strong>' +
      `<p>${escapaHtml(msg)}</p></div>` +
      `<script>try{parent.postMessage(${aviso},"*")}catch(e){}</script>`;
    enviaPagina(req, res, status, paginaVisual(corpo, tema));
  }

  function raizesDe(slug) {
    const raizes = [];
    const ag = slug ? registro.obter(slug) : null;
    if (ag && ag.home_host) raizes.push(ag.home_host);
    raizes.push(dataDir);
    return raizes;
  }
  function realpathOuNull(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }

  /** O caminho (sem realpath ainda) está dentro de alguma raiz permitida? Devolve o realpath ou null. */
  function caminhoPermitido(slug, caminho) {
    const real = realpathOuNull(caminho);
    if (!real) return null;
    for (const r of raizesDe(slug)) {
      const rr = realpathOuNull(r);
      if (rr && dentro(rr, real)) return real;
    }
    return null;
  }

  return {
    kindDe, mimeDe, idDe,

    /**
     * Registra um arquivo da thread/upload e devolve o objeto `media` da tela.
     * Fora das raízes permitidas (ou inexistente) volta `disponivel:false` e SEM url.
     * `visto` é o caminho como o agente o enxerga (home_container), só para exibição.
     */
    registrar(slug, caminho, opcoes) {
      if (!caminho) return null;
      const o = opcoes || {};
      const abs = path.resolve(caminho);
      const id = idDe(abs);
      const k = o.kind && o.kind !== 'document' ? o.kind : kindDe(abs);
      const nome = o.nome || path.basename(abs);
      const real = caminhoPermitido(slug, abs);
      let bytes = null; let versao = '';
      let disponivel = false;
      if (real) {
        try {
          const st = fs.statSync(real);
          if (st.isFile()) { disponivel = true; bytes = st.size; versao = `?v=${st.mtimeMs.toString(16).replace('.', '')}${st.size.toString(16)}`.slice(0, 20); }
        } catch (_) { /* some entre o realpath e o stat: fica indisponível */ }
      }
      // Dentro das pastas permitidas (conferido só pelo texto do caminho): registra mesmo que o
      // arquivo ainda não exista; o realpath é conferido de novo a cada entrega.
      const lexico = raizesDe(slug).some((r) => dentro(path.resolve(r), abs));
      if (lexico) reg.set(id, { path: abs, kind: k, mime: mimeDe(abs), nome, slug });
      return {
        id, kind: k, nome, bytes, disponivel,
        url: lexico ? `/api/v1/media/${id}${versao}` : null,
        thumb: lexico && ['photo', 'video'].includes(k) ? `/api/v1/media/${id}/thumb${versao}` : null,
        path: o.visto || null,
      };
    },

    obter(id) { return reg.get(id) || null; },

    /** GET|HEAD /api/v1/media/<id>/visual?tema=claro|escuro (ver docs/VISUAIS.md). */
    servirVisual(req, res, id, temaPedido) {
      const tema = temaPedido === 'escuro' ? 'escuro' : 'claro';
      const e = reg.get(id);
      if (!e) {
        erroVisual(req, res, 404, 'Não conheço esta mídia. Ela pode ter sido registrada antes de o servidor reiniciar: recarregue a conversa para ela voltar.', tema);
        return;
      }
      const nome = e.nome;
      if (!/\.html?$/i.test(e.path)) {
        erroVisual(req, res, 415, `'${nome}' não é um arquivo .html, então não dá para desenhar como visual. Peça ao agente um arquivo vis-<assunto>.html, ou use o botão de baixar.`, tema, nome);
        return;
      }
      const real = caminhoPermitido(e.slug, e.path);
      if (!real) {
        const sumiu = !fs.existsSync(e.path);
        erroVisual(req, res, sumiu ? 410 : 404, sumiu
          ? `'${nome}' saiu do disco (foi apagado ou movido). Peça ao agente para mandar de novo.`
          : `'${nome}' está fora da pasta permitida do agente e não será aberto.`, tema, nome);
        return;
      }
      let st;
      try { st = fs.statSync(real); } catch (err) {
        erroVisual(req, res, 410, `Não consegui ler o tamanho de '${nome}' (${err.code || err.message}). O arquivo pode ter saído do disco.`, tema, nome);
        return;
      }
      if (!st.isFile()) { erroVisual(req, res, 404, `O caminho de '${nome}' não é um arquivo.`, tema, nome); return; }
      if (st.size > VISUAL_MAX_BYTES) {
        erroVisual(req, res, 413, `'${nome}' tem ${(st.size / 1048576).toFixed(1).replace('.', ',')} MB, acima do teto de ${VISUAL_MAX_BYTES / 1048576} MB de um visual. Peça ao agente para enxugar (imagem grande vai fora do arquivo) ou use o botão de baixar.`, tema, nome);
        return;
      }
      let texto;
      try { texto = fs.readFileSync(real).toString('utf8').replace(/^\uFEFF/, ''); } catch (err) {
        erroVisual(req, res, 500, `Não consegui abrir '${nome}' (${err.code || err.message}).`, tema, nome);
        return;
      }
      enviaPagina(req, res, 200, paginaVisual(texto, tema));
    },

    /** Serve o arquivo. `modo` é 'arquivo' ou 'thumb'. */
    async servir(req, res, id, modo, baixar) {
      const e = reg.get(id);
      if (!e) {
        erroJson(res, 404, 'Não conheço esta mídia. Ela pode ter sido registrada antes de o servidor reiniciar: recarregue a conversa para ela voltar.');
        return;
      }
      if (modo === 'thumb' && !['photo', 'video'].includes(e.kind)) {
        erroJson(res, 404, 'Este tipo de arquivo não tem miniatura.');
        return;
      }
      const real = caminhoPermitido(e.slug, e.path);
      if (!real) {
        log('aviso', `Mídia ${id} recusada: ${e.path} saiu da pasta permitida do agente ${e.slug || '-'} ou não existe mais (link simbólico para fora? arquivo apagado?).`);
        erroJson(res, 404, 'O arquivo não está mais disponível dentro da pasta do agente.');
        return;
      }
      let st;
      try { st = fs.statSync(real); } catch (err) {
        erroJson(res, 404, `Não consegui abrir o arquivo (${err.code || err.message}).`);
        return;
      }
      if (!st.isFile()) { erroJson(res, 404, 'O caminho registrado não é um arquivo.'); return; }
      if (modo === 'thumb') {
        const versao = `${id}-${st.mtimeMs}-${st.size}`;
        const thumb = path.join(dataDir, 'miniaturas', versao + '.jpg');
        try {
          if (!fs.existsSync(thumb)) await geraMiniatura(real, thumb);
          const buf = await fs.promises.readFile(thumb);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length,
            'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          return res.end(req.method === 'HEAD' ? undefined : buf);
        } catch (err) {
          log('erro', `Miniatura ${id}: ${err.code || err.message}. Confira ffmpeg e permissões da pasta miniaturas.`);
          return erroJson(res, 503, 'Não consegui gerar a miniatura. Confira ffmpeg e a pasta de dados. O arquivo original só é baixado ao abrir.');
        }
      }
      const total = st.size;
      const cab = {
        'Content-Type': e.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${baixar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(e.nome)}`,
      };
      // html/svg/xml/js abertos direto rodariam na origem do app, com a sessão: o sandbox isola
      if (ehAtiva(e.path, e.mime)) cab['Content-Security-Policy'] = CSP_MIDIA_ATIVA;
      let inicio = 0; let fim = total - 1; let status = 200;
      const faixa = req.headers.range;
      if (faixa) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(faixa).trim());
        if (!m || (m[1] === '' && m[2] === '')) {
          res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${total}` }, cab, { 'Content-Length': 0 }));
          res.end();
          return;
        }
        if (m[1] === '') { const n = Number(m[2]); inicio = Math.max(0, total - n); } else { inicio = Number(m[1]); if (m[2] !== '') fim = Math.min(Number(m[2]), total - 1); }
        if (inicio > fim || inicio >= total) {
          res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${total}` }, cab, { 'Content-Length': 0 }));
          res.end();
          return;
        }
        status = 206;
        cab['Content-Range'] = `bytes ${inicio}-${fim}/${total}`;
      }
      cab['Content-Length'] = total === 0 ? 0 : fim - inicio + 1;
      res.writeHead(status, cab);
      if (req.method === 'HEAD' || total === 0) { res.end(); return; }
      const s = fs.createReadStream(real, { start: inicio, end: fim });
      s.on('error', (err) => { log('erro', `Falha lendo a mídia ${id} (${err.code || err.message}).`); res.destroy(); });
      res.on('close', () => s.destroy());
      s.pipe(res);
    },
  };
}

module.exports = { CSP_VISUAL, CSP_MIDIA_ATIVA, VISUAL_MAX_BYTES, criarMidia, kindDe, mimeDe, idDe, dentro };
