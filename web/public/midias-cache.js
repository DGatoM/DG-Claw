/* Cache de metadados por conta, agente e aba. Os arquivos não entram no IndexedDB. */
(function (raiz) {
  'use strict';
  const memoria = new Map();
  let banco;
  function abrirBanco() {
    if (!banco) banco = new Promise((resolve, reject) => {
      if (!raiz.indexedDB) return reject(new Error('armazenamento local indisponível'));
      const r = raiz.indexedDB.open('dg-midias-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('abas');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('cache bloqueado por outra janela'));
    });
    return banco;
  }
  async function disco(op, chave, valor) {
    const db = await abrirBanco();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('abas', op === 'get' ? 'readonly' : 'readwrite');
      const s = tx.objectStore('abas');
      const r = op === 'limpar' ? s.openCursor() : op === 'put' ? s.put(valor, chave) : s[op](chave);
      if (op === 'limpar') r.onsuccess = () => {
        const c = r.result; if (!c) return;
        if (String(c.key).startsWith(chave)) c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('falha no cache local'));
    });
  }
  function mescla(antigos, novos) {
    return [...new Map([...antigos, ...novos].map(i => [i.chave, i])).values()]
      .sort((a, b) => b.ep - a.ep || (a.chave < b.chave ? 1 : a.chave > b.chave ? -1 : 0));
  }
  function criar({ conta, agente, base, mudou, fetch: pedir = raiz.fetch.bind(raiz), guardar = disco }) {
    const abas = {}, prefixo = 'v1|' + conta + '|' + agente + '|';
    let aberto = false, geracao = 0;
    function estado(aba) {
      if (!abas[aba]) abas[aba] = { itens: [], proximo: null, recente: null, carregou: false,
        carregando: false, erro: null, avisoCache: null, atualizado: null, pronto: null };
      return abas[aba];
    }
    const avisa = aba => mudou(aba, estado(aba));
    async function carregarDisco(aba) {
      const d = estado(aba), chave = prefixo + aba;
      if (d.pronto) return d.pronto;
      const aplicar = v => {
        if (v && Date.now() - v.salvo < 30 * 86400000 && Array.isArray(v.itens)) {
          Object.assign(d, { itens: v.itens, proximo: v.proximo, recente: v.recente,
            atualizado: v.salvo, carregou: true });
          avisa(aba);
        }
      };
      if (memoria.has(chave)) { aplicar(memoria.get(chave)); d.pronto = Promise.resolve(); }
      else d.pronto = (async () => {
        try {
          // Safari privado ou banco bloqueado não pode atrasar a consulta da rede.
          let timer;
          const limite = new Promise((_, rejeita) => { timer = setTimeout(() => rejeita(new Error('cache local demorou a abrir')), 1200); });
          try { aplicar(await Promise.race([guardar('get', chave), limite])); }
          finally { clearTimeout(timer); }
        } catch (e) { d.avisoCache = 'Cache só nesta aba: ' + e.message; avisa(aba); }
      })();
      return d.pronto;
    }
    async function salvar(aba) {
      const d = estado(aba), itens = d.itens.slice(0, 600);
      const v = { itens, recente: d.recente, proximo: d.itens.length > 600 ? itens.at(-1).cursor : d.proximo, salvo: Date.now() };
      memoria.set(prefixo + aba, v);
      try { await guardar('put', prefixo + aba, v); }
      catch (e) { d.avisoCache = 'Cache só nesta aba: ' + e.message; }
    }
    async function pagina(aba, cursor, desde) {
      const q = new URLSearchParams({ tipo: aba, limite: '20', progressivo: '1' });
      if (cursor) q.set('cursor', cursor);
      if (desde) q.set('desde', desde);
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        const r = await pedir(base + '/compartilhados?' + q, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
        let v; try { v = await r.json(); } catch (_) { throw new Error('o servidor não devolveu uma lista válida'); }
        if (!r.ok || v.ok === false) {
          const e = new Error(v.error || v.erro || ('HTTP ' + r.status)); e.status = r.status; throw e;
        }
        if (!Array.isArray(v.itens) || typeof v.recente !== 'string' || (v.proximo != null && typeof v.proximo !== 'string')) throw new Error('O servidor está atualizando a paginação. Tente novamente em instantes.');
        return v;
      } finally { clearTimeout(timer); }
    }
    async function trabalhar(aba, mais) {
      await carregarDisco(aba);
      const d = estado(aba), g = geracao;
      if (d.carregando || !aberto || (mais && !d.proximo)) return;
      d.carregando = true; d.erro = null; avisa(aba);
      try {
        if (!mais && d.carregou && d.recente) {
          // O checkpoint só anda após TODAS as páginas do delta. Assim, 100 itens
          // novos entre duas visitas não deixam um buraco depois dos primeiros 20.
          let cursor = null, recente = null, voltas = 0;
          do {
            const p = await pagina(aba, cursor, d.recente);
            if (g !== geracao) return;
            recente = recente || p.recente;
            d.itens = mescla(d.itens, p.itens || []); cursor = p.proximo;
            avisa(aba);
            if (++voltas >= 50 && cursor) throw new Error('Há muitas novidades. Reabra a aba para continuar a atualização.');
          } while (cursor && aberto);
          if (!cursor) d.recente = recente || d.recente;
          d.atualizado = Date.now(); await salvar(aba);
        } else {
          let voltas = 0;
          do {
            const p = await pagina(aba, d.carregou ? d.proximo : null, null);
            if (g !== geracao) return;
            if (!d.carregou) d.recente = p.recente;
            d.itens = mescla(d.itens, p.itens || []); d.proximo = p.proximo;
            d.carregou = true; d.atualizado = Date.now();
            avisa(aba); await salvar(aba);
            // Recentes primeiro, 20 por vez. Depois de 60 itens ou 30 dias,
            // só um gesto do dono solicita páginas antigas.
            if (mais || !d.proximo || d.itens.length >= 60 || ++voltas >= 10 ||
                (d.itens.length && d.itens.at(-1).ep < Date.now() / 1000 - 30 * 86400)) break;
          } while (aberto);
        }
      } catch (e) {
        d.erro = (e.name === 'AbortError' ? 'A busca demorou. Tente novamente.' : e.message);
        if (e.status === 401 || e.status === 403 || e.status === 423) {
          d.itens = []; d.carregou = false; d.recente = null; d.proximo = null;
          memoria.delete(prefixo + aba);
          try { await guardar('delete', prefixo + aba); } catch (falha) { console.warn('cache: limpeza recusada:', falha.message); }
        }
      } finally { d.carregando = false; avisa(aba); }
    }
    return {
      estado,
      abrir(aba) { aberto = true; avisa(aba); return trabalhar(aba, false); },
      mais(aba) { return trabalhar(aba, true); },
      fechar() { aberto = false; },
      async limpar() {
        aberto = false; geracao++;
        const escopo = 'v1|' + conta + '|';
        for (const k of memoria.keys()) if (k.startsWith(escopo)) memoria.delete(k);
        for (const aba of ['midias', 'links', 'docs']) {
          Object.assign(estado(aba), { itens: [], recente: null, proximo: null, carregou: false });
        }
        try { await guardar('limpar', escopo); } catch (e) { console.warn('cache: não consegui limpar:', e.message); }
      },
    };
  }
  raiz.DGMidias = { criar, mescla };
  if (typeof module !== 'undefined') module.exports = raiz.DGMidias;
})(typeof window === 'undefined' ? globalThis : window);
