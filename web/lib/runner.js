'use strict';
// Cliente do runner do agente (HTTP em loopback). Manda Bearer quando há arquivo de token.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

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
      if (!valor) return { erro: `O arquivo do token do runner (${arq}) está vazio.` };
      cacheToken.set(arq, { mtimeMs: st.mtimeMs, valor });
      return { token: valor };
    } catch (e) {
      return { erro: `Não consegui ler o arquivo do token do runner de ${agente.nome} (${arq}): ${e.code || e.name}. Confira se o arquivo existe e se este serviço roda como root.` };
    }
  }

  /**
   * Faz uma chamada. Devolve { ok, status, corpo } quando o runner respondeu (qualquer status)
   * ou { ok:false, erro } quando nem chegou lá.
   */
  function chamar(agente, metodo, caminho, corpo, timeoutPedido) {
    return new Promise((resolve) => {
      const t = lerToken(agente);
      if (t.erro) { log('erro', t.erro); resolve({ ok: false, erro: t.erro }); return; }
      let url;
      try { url = new URL(agente.runner + caminho); } catch (e) {
        resolve({ ok: false, erro: `A URL do runner de ${agente.nome} (${agente.runner}) é inválida.` });
        return;
      }
      const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
      const headers = { Accept: 'application/json' };
      if (dados) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = dados.length; }
      if (t.token) headers.Authorization = `Bearer ${t.token}`;
      const lib = url.protocol === 'https:' ? https : http;
      let terminou = false;
      const fim = (r) => { if (!terminou) { terminou = true; resolve(r); } };
      const req = lib.request(url, { method: metodo, headers, timeout: timeoutPedido || limite }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* resposta que não é JSON fica em `texto` */ }
          fim({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, corpo: json, texto });
        });
        res.on('error', (e) => fim({ ok: false, erro: `A resposta do runner de ${agente.nome} foi interrompida (${e.code || e.message}).` }));
      });
      req.on('timeout', () => { req.destroy(); fim({ ok: false, erro: `O runner de ${agente.nome} (${agente.runner}) não respondeu em ${Math.round((timeoutPedido || limite) / 100) / 10} s.` }); });
      req.on('error', (e) => fim({ ok: false, erro: `Não consegui falar com o runner de ${agente.nome} em ${agente.runner} (${e.code || e.message}). Confira se o serviço do agente está rodando.` }));
      if (dados) req.write(dados);
      req.end();
    });
  }

  return {
    /** Estado do agente: { ok, estado:{status,sessionId,currentTool,...} } ou { ok:false, erro }. */
    async estado(agente) {
      const r = await chamar(agente, 'GET', `/api/agents/${encodeURIComponent(agente.agente_id)}`);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: motivoDoRunner(agente, r) };
      const dados = r.corpo && (r.corpo.data || r.corpo);
      if (!dados || typeof dados !== 'object') return { ok: false, erro: `O runner de ${agente.nome} respondeu sem o estado do agente.` };
      return { ok: true, estado: dados };
    },
    /** GET /api/provedor do runner (sessão principal). Devolve { ok, dados } ou { ok:false, erro }. */
    async provedor(agente, timeoutMs) {
      const r = await chamar(agente, 'GET', '/api/provedor', null, timeoutMs);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: r.status === 404 ? `O runner de ${agente.nome} não tem a rota /api/provedor (versão antiga).` : motivoDoRunner(agente, r) };
      const dados = r.corpo && (r.corpo.data && typeof r.corpo.data === 'object' ? r.corpo.data : r.corpo);
      if (!dados || typeof dados !== 'object') return { ok: false, erro: `O runner de ${agente.nome} respondeu /api/provedor sem corpo útil.` };
      return { ok: true, dados };
    },
    /**
     * Chamada genérica (para rotas que o Web só repassa, como POST /api/provedor). Devolve
     * { ok, status, corpo, texto } quando o runner respondeu, ou { ok:false, erro } quando nem chegou lá.
     */
    pedir(agente, metodo, caminho, corpo, timeoutPedido) { return chamar(agente, metodo, caminho, corpo, timeoutPedido); },
    /** Digita no agente. Devolve { ok, status, enfileirado } ou { ok:false, status, erro }. */
    async input(agente, corpo) {
      const r = await chamar(agente, 'POST', `/api/agents/${encodeURIComponent(agente.agente_id)}/input`, corpo);
      if (!r.ok && r.erro) return r;
      if (!r.ok) return { ok: false, status: r.status, erro: motivoDoRunner(agente, r) };
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
