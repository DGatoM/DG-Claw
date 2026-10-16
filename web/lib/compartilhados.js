// Metadados do acervo, paginados sem ler bytes dos arquivos de mídia.
'use strict';
function cursor(a, t, ep, chave) { return Buffer.from(JSON.stringify([1, a, t, ep, chave])).toString('base64url'); }
function decodifica(v, a, t) {
  if (!v) return null;
  try {
    if (v.length > 2048) throw Error();
    const x = JSON.parse(Buffer.from(v, 'base64url'));
    if (x.length !== 5 || x[0] !== 1 || x[1] !== a || x[2] !== t || !Number.isFinite(x[3]) || x[3] < 0 || typeof x[4] !== 'string') throw Error();
    return { ep: x[3], chave: x[4] };
  } catch (_) { throw new Error('Cursor inválido ou de outra conversa/aba. Reabra a lista para atualizar.'); }
}
const cmp = (a, b) => a.ep - b.ep || (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0);
function criarCompartilhados(conversa) {
  const cache = new Map();
  return async function pagina(agente, q) {
    const tipo = q.get('tipo'), limite = Number(q.get('limite') || 20);
    if (!['midias', 'links', 'docs'].includes(tipo) || !Number.isInteger(limite) || limite < 1 || limite > 60) throw new Error('Informe tipo=midias|links|docs e limite entre 1 e 60.');
    const antes = decodifica(q.get('cursor'), agente.slug, tipo), desde = decodifica(q.get('desde'), agente.slug, tipo);
    const tr = await conversa.thread(agente);
    const chave = agente.slug + '|' + tipo;
    let c = cache.get(chave);
    if (!c || c.eventos !== tr.msgs || c.versao !== tr.versao || c.arquivo !== tr.arquivo) {
      const itens = [];
      for (const m of tr.msgs) {
        const base = { msg_id: m.id, ep: m.ep, dia: m.dia, hhmm: m.hhmm, origin: m.origin,
          mes: new Date(m.ep * 1000).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }), texto: m.text || '' };
        if (tipo === 'links') {
          if (m.media) continue;
          const urls = [...new Set((m.text || '').match(/https?:\/\/[^\s<>"'`]+/g) || [])];
          urls.forEach((u, n) => {
            u = u.replace(/[.,;:!?)\]}*_>]+$/, '');
            try { const url = new URL(u); itens.push({ ...base, chave: m.id + ':' + n, url: url.href, dominio: url.hostname }); }
            catch (_) { /* texto parecido com URL, mas não é um endereço */ }
          });
        } else if (m.media && (['photo', 'video'].includes(m.media.kind) === (tipo === 'midias'))) {
          itens.push({ ...base, chave: m.id, media: m.media });
        }
      }
      itens.sort((a, b) => -cmp(a, b));
      c = { itens, eventos: tr.msgs, versao: tr.versao, arquivo: tr.arquivo }; cache.set(chave, c);
    }
    const itens = c.itens.filter(i => (!antes || cmp(i, antes) < 0) && (!desde || cmp(i, desde) > 0));
    const pag = itens.slice(0, limite).map(i => ({ ...i, cursor: cursor(agente.slug, tipo, i.ep, i.chave) }));
    const recente = c.itens[0] || desde || { ep: 0, chave: '' };
    return { ok: true, tipo, itens: pag, proximo: itens.length > limite ? pag.at(-1).cursor : null,
      recente: cursor(agente.slug, tipo, recente.ep, recente.chave), total: null, parcial: true, avisos: tr.avisos };
  };
}
module.exports = { criarCompartilhados, cursor, decodifica };
