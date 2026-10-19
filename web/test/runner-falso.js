'use strict';
// Runner FALSO para os testes: imita o que o Web usa do runner (estado, input, provedor).
// Guarda tudo o que recebeu para o teste conferir.

const http = require('node:http');

function criarRunnerFalso(opcoes) {
  const o = Object.assign({ agenteId: 'ag1', token: null, sessionId: 'sess-0001-aaaa', status: 'idle', currentTool: null, provedor: null, codexHome: null, atrasoProvedorMs: 0, falhaInput: null,
    statusReason: null, erroEstado: null,
    // login assistido: o estado que GET/POST /api/provedor/login devolvem (o teste muda à vontade)
    login: { estado: 'nenhum' }, loginRecusa: null }, opcoes || {});
  const rec = { reinicios: 0, permissoes: [], inputs: [], cabecalhos: [], estadoPedidos: 0, provedorPedidos: 0, loginPosts: 0, loginDeletes: 0, codigos: [] };
  const servidor = http.createServer((req, res) => {
    const json = (status, corpo) => { const t = JSON.stringify(corpo); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(t); };
    rec.cabecalhos.push({ metodo: req.method, url: req.url, authorization: req.headers.authorization || null });
    if (o.token && req.headers.authorization !== `Bearer ${o.token}`) return json(401, { success: false, error: 'token ausente ou errado' });
    const rota = req.url.split('?')[0];
    if (rota === `/api/agents/${o.agenteId}` && req.method === 'GET') {
      rec.estadoPedidos += 1;
      if (o.falhaEstado) return json(503, { success: false, error: 'runner indisponível no teste' });
      return json(200, { success: true, data: { id: o.agenteId, status: o.status, sessionId: o.sessionId, currentTool: o.currentTool, updatedAt: Date.now(), codexHome: o.codexHome, statusReason: o.statusReason, error: o.erroEstado } });
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
    if (rota === `/api/agents/${o.agenteId}/permissao` && req.method === 'POST') {
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        const corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        if (o.semRotaPermissao) return json(404, { success: false, error: 'sem rota' });
        if (o.falhaPermissao) return json(o.falhaPermissao.status, o.falhaPermissao.corpo);
        rec.permissoes.push(corpo.decisao);
        return json(200, { success: true, data: { decisao: corpo.decisao } });
      });
      return undefined;
    }
    if (rota === `/api/agents/${o.agenteId}/reiniciar` && req.method === 'POST') {
      if (o.semRotaReiniciar) return json(404, { success: false, error: 'sem rota' });
      if (o.derrubaReiniciar) { req.socket.destroy(); return undefined; }
      if (o.falhaReiniciar) return json(o.falhaReiniciar.status, o.falhaReiniciar.corpo);
      rec.reinicios += 1;
      return json(202, { ok: true, sessao: o.sessionId, modo: 'retomar' });
    }
    if (rota === '/api/provedor' && req.method === 'GET') {
      rec.provedorPedidos += 1;
      if (!o.provedor) return json(404, { success: false, error: 'rota inexistente' });
      return setTimeout(() => json(200, o.provedor), o.atrasoProvedorMs);
    }
    if (rota === '/api/provedor/login' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      if (req.method === 'GET') return json(200, o.login);
      if (o.loginRecusa) return json(o.loginRecusa.status, o.loginRecusa.corpo);
      if (req.method === 'DELETE') { rec.loginDeletes += 1; o.login = { estado: 'nenhum' }; return json(200, { ok: true, estado: 'nenhum' }); }
      rec.loginPosts += 1;
      if (o.login.estado === 'nenhum' || o.login.estado === 'falhou' || o.login.estado === 'concluido') o.login = { estado: 'aguardando_link' };
      return json(202, o.login);
    }
    if (rota === '/api/provedor/login/codigo' && req.method === 'POST') {
      const partes = [];
      req.on('data', (c) => partes.push(c));
      req.on('end', () => {
        const corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        rec.codigos.push(corpo.codigo);
        if (o.loginRecusa) return json(o.loginRecusa.status, o.loginRecusa.corpo);
        return json(200, { ok: true });
      });
      return undefined;
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
