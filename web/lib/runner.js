'use strict';
const dgIdiomaBackend = require("./idioma-contexto");
// Cliente do runner do agente (HTTP em loopback). Manda Bearer quando há arquivo de token.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const ERROS_ANTES_DO_ENVIO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function criarRunner({ log, timeoutMs }) {
  const limite = timeoutMs || 6000;
  const cacheToken = new Map(); // caminho -> { mtimeMs, valor }

  /** Lê o token. Devolve { token } (pode ser null) ou { erro }. O valor nunca vai para log. */
  function lerToken(agente) {
    const arq = agente.runner_token_arquivo;
    if (!arq) return { token: null };
    try {
      const st = fs.statSync(arq);
      const c = cacheToken.get(arq);
      if (c && c.mtimeMs === st.mtimeMs) return { token: c.valor };
      const valor = fs.readFileSync(arq, 'utf8').trim();
      if (!valor) return { erro: dgIdiomaBackend.mensagem("O arquivo do token do runner ({p0}) está vazio.", {p0: (arq)}) };
      cacheToken.set(arq, { mtimeMs: st.mtimeMs, valor });
      return { token: valor };
    } catch (e) {
      return { erro: dgIdiomaBackend.mensagem("Não consegui ler o arquivo do token do runner de {p0} ({p1}): {p2}. Confira se o arquivo existe e se este serviço roda como root.", {p0: (agente.nome), p1: (arq), p2: (e.code || e.name)}) };
    }
  }

  /**
   * Faz uma chamada. Devolve { ok, status, corpo } quando o runner respondeu (qualquer status)
   * ou { ok:false, erro } quando nem chegou lá.
   */
  function chamar(agente, metodo, caminho, corpo, timeoutPedido, opcoes) {
    // opcoes (só o diagnóstico usa): { signal, prazoMs, maxBytes }. O prazo é TOTAL (o timeout do http só mede
    // inatividade, e um runner que manda fragmentos sem parar nunca o dispara); o signal cancela de fora.
    const op = opcoes || {};
    return new Promise((resolve) => {
      const t = lerToken(agente);
      if (t.erro) { log('erro', t.erro); resolve({ ok: false, erro: t.erro, antesDoEnvio: true }); return; }
      let url;
      try { url = new URL(agente.runner + caminho); } catch (e) {
        resolve({ ok: false, erro: dgIdiomaBackend.mensagem("A URL do runner de {p0} ({p1}) é inválida.", {p0: (agente.nome), p1: (agente.runner)}), antesDoEnvio: true });
        return;
      }
      const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
      const headers = { Accept: 'application/json' };
      if (dados) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = dados.length; }
      if (t.token) headers.Authorization = `Bearer ${t.token}`;
      const lib = url.protocol === 'https:' ? https : http;
      let terminou = false;
      let timerTotal = null;
      let aoAbortar = null;
      let req = null;
      const fim = (r) => {
        if (terminou) return;
        terminou = true;
        if (timerTotal) clearTimeout(timerTotal);
        if (aoAbortar && op.signal) op.signal.removeEventListener('abort', aoAbortar);
        resolve(r);
      };
      const derrubar = (erro) => { fim({ ok: false, erro }); if (req) req.destroy(); };
      if (op.signal && op.signal.aborted) { derrubar(`A consulta ao runner de ${agente.nome} foi cancelada porque o prazo do diagnóstico acabou.`); return; }
      req = lib.request(url, { method: metodo, headers, timeout: timeoutPedido || limite }, (res) => {
        const partes = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (op.maxBytes && bytes > op.maxBytes) {
            res.destroy();
            derrubar(`A resposta do runner de ${agente.nome} passou de ${op.maxBytes} bytes e foi descartada.`);
            return;
          }
          partes.push(c);
        });
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* resposta que não é JSON fica em `texto` */ }
          fim({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, corpo: json, texto });
        });
        res.on('error', (e) => fim({ ok: false, erro: dgIdiomaBackend.mensagem("A resposta do runner de {p0} foi interrompida ({p1}).", {p0: (agente.nome), p1: (e.code || e.message)}) }));
      });
      req.on('timeout', () => { req.destroy(); fim({ ok: false, erro: dgIdiomaBackend.mensagem("O runner de {p0} ({p1}) não respondeu em {p2} s.", {p0: (agente.nome), p1: (agente.runner), p2: (Math.round((timeoutPedido || limite) / 100) / 10)}) }); });
      // antesDoEnvio: a conexão nem abriu, então o pedido com certeza não chegou. Timeout e conexão
      // derrubada no meio (ECONNRESET, EPIPE) ficam sem a marca: o runner pode ter recebido.
      req.on('error', (e) => fim({ ok: false, antesDoEnvio: ERROS_ANTES_DO_ENVIO.has(e.code), erro: dgIdiomaBackend.mensagem("Não consegui falar com o runner de {p0} em {p1} ({p2}). Confira se o serviço do agente está rodando.", {p0: (agente.nome), p1: (agente.runner), p2: (e.code || e.message)}) }));
      if (op.prazoMs > 0) {
        timerTotal = setTimeout(() => derrubar(`O runner de ${agente.nome} não terminou de responder em ${Math.round(op.prazoMs / 100) / 10} s (prazo total da consulta).`), op.prazoMs);
        timerTotal.unref();
      }
      if (op.signal) {
        aoAbortar = () => derrubar(`A consulta ao runner de ${agente.nome} foi cancelada porque o prazo do diagnóstico acabou.`);
        op.signal.addEventListener('abort', aoAbortar, { once: true });
      }
      if (dados) req.write(dados);
      req.end();
    });
  }

  return {
    /** Estado do agente: { ok, estado:{status,sessionId,currentTool,...} } ou { ok:false, erro }. */
    async estado(agente, opcoes) {
      const r = await chamar(agente, 'GET', `/api/agents/${encodeURIComponent(agente.agente_id)}`, null, undefined, opcoes);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: motivoDoRunner(agente, r) };
      const dados = r.corpo && (r.corpo.data || r.corpo);
      if (!dados || typeof dados !== 'object') return { ok: false, erro: dgIdiomaBackend.mensagem("O runner de {p0} respondeu sem o estado do agente.", {p0: (agente.nome)}) };
      return { ok: true, estado: dados };
    },
    /** GET /api/provedor do runner (sessão principal). Devolve { ok, dados } ou { ok:false, erro }. */
    async provedor(agente, timeoutMs, fresco, opcoes) {
      const r = await chamar(agente, 'GET', fresco ? '/api/provedor?fresco=1' : '/api/provedor', null, timeoutMs, opcoes);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: r.status === 404 ? dgIdiomaBackend.mensagem("O runner de {p0} não tem a rota /api/provedor (versão antiga).", {p0: (agente.nome)}) : motivoDoRunner(agente, r) };
      const dados = r.corpo && (r.corpo.data && typeof r.corpo.data === 'object' ? r.corpo.data : r.corpo);
      if (!dados || typeof dados !== 'object') return { ok: false, erro: dgIdiomaBackend.mensagem("O runner de {p0} respondeu /api/provedor sem corpo útil.", {p0: (agente.nome)}) };
      return { ok: true, dados };
    },
    /** GET /api/agents/<id>/uso: o uso da assinatura. Devolve { ok, uso, motivo? } ou { ok:false, erro }. */
    async uso(agente, timeoutMs) {
      const r = await chamar(agente, 'GET', `/api/agents/${encodeURIComponent(agente.agente_id)}/uso`, null, timeoutMs);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: r.status === 404 && !(r.corpo && r.corpo.code) ? dgIdiomaBackend.mensagem("O runner de {p0} não tem a rota de uso da assinatura (versão antiga). Atualize o DG Claw.", {p0: (agente.nome)}) : motivoDoRunner(agente, r) };
      const c = r.corpo;
      if (!c || typeof c !== 'object' || !c.uso || typeof c.uso !== 'object') return { ok: false, erro: dgIdiomaBackend.mensagem("O runner de {p0} respondeu o uso da assinatura sem o campo \"uso\".", {p0: (agente.nome)}) };
      return { ok: true, uso: c.uso, motivo: typeof c.motivo === 'string' ? c.motivo : undefined };
    },
    /**
     * Chamada genérica (para rotas que o Web só repassa, como POST /api/provedor). Devolve
     * { ok, status, corpo, texto } quando o runner respondeu, ou { ok:false, erro } quando nem chegou lá.
     */
    pedir(agente, metodo, caminho, corpo, timeoutPedido, opcoes) { return chamar(agente, metodo, caminho, corpo, timeoutPedido, opcoes); },
    /** Digita no agente. Devolve { ok, status, enfileirado } ou { ok:false, status, erro }. */
    async input(agente, corpo) {
      const r = await chamar(agente, 'POST', `/api/agents/${encodeURIComponent(agente.agente_id)}/input`, corpo);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: motivoDoRunner(agente, r), code: r.corpo && typeof r.corpo.code === 'string' ? r.corpo.code : undefined };
      return { ok: true, status: r.status, dados: r.corpo && r.corpo.data };
    },
  };
}

function motivoDoRunner(agente, r) {
  const c = r.corpo || {};
  const partes = [];
  if (c.error) partes.push(String(c.error));
  if (c.howToFix) partes.push(String(c.howToFix));
  if (!partes.length) partes.push(`O runner de ${agente.nome} respondeu HTTP ${r.status}.`);
  if (r.status === 401 || r.status === 403) partes.push('Confira o arquivo de token do runner no registro de agentes.');
  return partes.join(' ');
}

module.exports = { criarRunner, motivoDoRunner };
