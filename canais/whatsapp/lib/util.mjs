import path from 'node:path';

export const FUSO = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------
// Pequenos utilitarios
// ---------------------------------------------------------------------------

/** Escapa o corpo para nenhum texto de fora fechar o envelope nem forjar um <dgchat>. */
export function escaparCorpo(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function horaLocal(data) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(data);
}

export function dataLocal(data) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(data);
}

export function numeroDe(x) {
  if (x == null) return NaN;
  if (typeof x === 'object') return Number(x.toString());
  return Number(x);
}

export function formatarCodigo(bruto) {
  const c = String(bruto).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function motivoErro(e) {
  return e && e.message ? String(e.message) : String(e);
}

const EXT_POR_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

export function extensaoDe(mimetype, nomeArquivo) {
  const doNome = nomeArquivo ? path.extname(String(nomeArquivo)).slice(1) : '';
  if (/^[A-Za-z0-9]{1,8}$/.test(doNome)) return doNome.toLowerCase();
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (EXT_POR_MIME[mime]) return EXT_POR_MIME[mime];
  const sub = mime.split('/')[1] || '';
  return /^[a-z0-9]{1,5}$/.test(sub) ? sub : 'bin';
}

/** Resposta de erro do socket: { ok: false, codigo, erro }. */
export function falha(codigo, erro) { return { ok: false, codigo, erro }; }
