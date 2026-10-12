'use strict';
// Mídia: registro de id -> caminho e entrega com suporte a Range.
// Só sai arquivo que esteja DENTRO do home_host do agente dono (ou de DGCLAW_WEB_DATA),
// conferido com realpath a cada pedido (link simbólico para fora é recusado).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { erroJson } = require('./http');

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

function criarMidia({ dataDir, log, registro }) {
  const reg = new Map(); // id -> { path, kind, mime, nome, slug }

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
        thumb: lexico && k === 'photo' ? `/api/v1/media/${id}/thumb${versao}` : null,
        path: o.visto || null,
      };
    },

    obter(id) { return reg.get(id) || null; },

    /** Serve o arquivo. `modo` é 'arquivo' ou 'thumb'. */
    servir(req, res, id, modo, baixar) {
      const e = reg.get(id);
      if (!e) {
        erroJson(res, 404, 'Não conheço esta mídia. Ela pode ter sido registrada antes de o servidor reiniciar: recarregue a conversa para ela voltar.');
        return;
      }
      if (modo === 'thumb' && e.kind !== 'photo') {
        erroJson(res, 404, 'Só fotos têm miniatura. Abra o arquivo inteiro.');
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
      const total = st.size;
      const cab = {
        'Content-Type': e.mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${baixar ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(e.nome)}`,
      };
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

module.exports = { criarMidia, kindDe, mimeDe, idDe, dentro };
