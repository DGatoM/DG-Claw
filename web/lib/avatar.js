'use strict';
// Foto do agente cadastrada como URL de fora (https://...). No iPhone a mesma URL externa era
// pedida várias vezes por página e a foto chegava a pintar pela metade (21/10/2026). Aqui o
// servidor baixa uma vez, guarda em <dataDir>/avatares/ e entrega do mesmo domínio, inteira, com
// suporte a Range e cache longo. O `?v=` (hash da URL) muda quando o cadastro muda de URL, então
// o cache de 1 ano nunca segura foto velha.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const PRAZO_MS = 10000;
// SVG fica de fora: aberto direto rodaria script na origem do app, com a sessão.
const RX_TIPO = /^image\/(png|jpe?g|webp|gif|avif)$/i;

const hashDaUrl = (url) => crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
const ehUrlDeFoto = (v) => typeof v === 'string' && /^https:\/\//i.test(v);

function criarAvatar({ dataDir, log, buscar }) {
  const pasta = path.join(dataDir, 'avatares');
  const baixar = buscar || ((url) => fetch(url, { signal: AbortSignal.timeout(PRAZO_MS), redirect: 'follow' }));
  const emCurso = new Map(); // arquivo -> promessa, para dois pedidos juntos baixarem uma vez só

  /** URL que a interface usa no lugar da externa. */
  function urlPublica(slug, urlExterna) {
    return `/api/v1/agents/${encodeURIComponent(slug)}/avatar?v=${hashDaUrl(urlExterna)}`;
  }

  async function garantir(slug, urlExterna) {
    const base = path.join(pasta, `${slug.replace(/[^a-z0-9_-]/gi, '_')}-${hashDaUrl(urlExterna)}`);
    if (fs.existsSync(base) && fs.existsSync(base + '.tipo')) return base;
    if (emCurso.has(base)) return emCurso.get(base);
    const p = (async () => {
      const r = await baixar(urlExterna);
      if (!r.ok) throw new Error(`o servidor da foto respondeu ${r.status}`);
      const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim();
      if (!RX_TIPO.test(tipo)) throw new Error(`a resposta não é uma foto aceita (Content-Type "${tipo || 'vazio'}"; aceito PNG, JPEG, WebP, GIF ou AVIF)`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('a foto veio vazia');
      if (buf.length > MAX_BYTES) throw new Error(`a foto tem ${buf.length} bytes e o limite é ${MAX_BYTES}`);
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      // temporário + rename: um pedido que chegue no meio nunca lê foto pela metade; o .tipo vai por último
      fs.writeFileSync(base + '.tmp', buf, { mode: 0o600 });
      fs.renameSync(base + '.tmp', base);
      fs.writeFileSync(base + '.tipo', tipo.toLowerCase(), { mode: 0o600 });
      return base;
    })();
    emCurso.set(base, p);
    try { return await p; } finally { emCurso.delete(base); }
  }

  /** Entrega a foto de `agente` (precisa ter `avatar` https). Devolve {status,erro} se falhar. */
  async function servir(req, res, agente) {
    const url = agente.avatar;
    if (!ehUrlDeFoto(url)) return { status: 404, erro: `O agente "${agente.slug}" não tem foto por endereço cadastrada. Veja GET /api/v1/agents.` };
    let base;
    try { base = await garantir(agente.slug, url); } catch (e) {
      log('erro', `Avatar de ${agente.slug}: não consegui baixar ${url}: ${e.message}. Confira o endereço da foto no cadastro e a saída do servidor para a internet.`);
      return { status: 502, erro: `Não consegui baixar a foto de ${agente.slug}: ${e.message}.` };
    }
    const tipo = fs.readFileSync(base + '.tipo', 'utf8').trim();
    const total = fs.statSync(base).size;
    const cab = { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
    let inicio = 0, fim = total - 1, status = 200;
    const faixa = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (faixa && (faixa[1] || faixa[2])) {
      if (faixa[1]) { inicio = Number(faixa[1]); if (faixa[2]) fim = Math.min(Number(faixa[2]), total - 1); }
      else { inicio = Math.max(0, total - Number(faixa[2])); }
      if (inicio > fim || inicio >= total) {
        res.writeHead(416, Object.assign({ 'Content-Range': `bytes */${total}` }, cab, { 'Content-Length': 0 }));
        res.end();
        return null;
      }
      status = 206;
      cab['Content-Range'] = `bytes ${inicio}-${fim}/${total}`;
    }
    cab['Content-Length'] = fim - inicio + 1;
    res.writeHead(status, cab);
    if (req.method === 'HEAD') { res.end(); return null; }
    fs.createReadStream(base, { start: inicio, end: fim }).pipe(res);
    return null;
  }

  return { urlPublica, servir, ehUrlDeFoto };
}

module.exports = { criarAvatar };
