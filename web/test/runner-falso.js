'use strict';
// Runner FALSO para os testes: imita o que o Web usa do runner (estado, input, provedor).
// Guarda tudo o que recebeu para o teste conferir.

const http = require('node:http');

function criarRunnerFalso(opcoes) {
  const o = Object.assign({ agenteId: 'ag1', token: null, sessionId: 'sess-0001-aaaa', status: 'idle', currentTool: null, provedor: null, codexHome: null, atrasoProvedorMs: 0, falhaInput: null }, opcoes || {});
  const rec = { inputs: [], cabecalhos: [], estadoPedidos: 0, provedorPedidos: 0 };
  const servidor = http.createServer((req, res) => {
    const json = (status, corpo) => { const t = JSON.stringify(corpo); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(t); };
    rec.cabecalhos.push({ metodo: req.method, url: req.url, authorization: req.headers.authorization || null });
    if (o.token && req.headers.authorization !== `Bearer ${o.token}`) return json(401, { success: false, error: 'token ausente ou errado' });
    const rota = req.url.split('?')[0];
    if (rota === `/api/agents/${o.agenteId}` && req.method === 'GET') {
      rec.estadoPedidos += 1;
      return json(200, { success: true, data: { id: o.agenteId, status: o.status, sessionId: o.sessionId, currentTool: o.currentTool, updatedAt: Date.now(), codexHome: o.codexHome } });
    }
    if (rota === `/api/agents/${o.agenteId}/input` && req.method === 'POST') {
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        const corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        rec.inputs.push(corpo);
        if (o.falhaInput) return json(o.falhaInput.status, o.falhaInput.corpo);
        return json(202, { success: true, data: { enfileirado: true, aguardando: 'idle' } });
      });
      return undefined;
    }
    if (rota === '/api/provedor' && req.method === 'GET') {
      rec.provedorPedidos += 1;
      if (!o.provedor) return json(404, { success: false, error: 'rota inexistente' });
      return setTimeout(() => json(200, o.provedor), o.atrasoProvedorMs);
    }
    return json(404, { success: false, error: `sem rota ${req.method} ${rota}` });
  });
  return {
    opcoes: o, rec,
    ouvir() { return new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(servidor.address().port))); },
    fechar() { return new Promise((r) => { servidor.closeAllConnections(); servidor.close(() => r()); }); },
  };
}

module.exports = { criarRunnerFalso };
