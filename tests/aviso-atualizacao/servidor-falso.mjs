// GitHub falso e Admin falso para tests/aviso-atualizacao/rodar.sh, num servidor http local só.
//
// Uso: node servidor-falso.mjs <cenario.json> <arquivo-da-porta> <log-de-requisicoes> <log-do-admin>
// O cenário é relido a cada pedido, então o teste muda o comportamento sem reiniciar o servidor:
//   compare: { status, headers, body (objeto ou texto), paginas: { "2": objeto }, atraso_ms }
//   raw:     { "CHANGELOG.md": { status, body }, "VERSION": { status, body } }
//   admin:   { status }
import fs from 'node:fs';
import http from 'node:http';

const [cenarioArq, portaArq, reqLog, adminLog] = process.argv.slice(2);
const cenario = () => JSON.parse(fs.readFileSync(cenarioArq, 'utf8'));

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  fs.appendFileSync(reqLog, `${req.method} ${req.url}\n`);
  const c = cenario();
  if (req.method === 'POST' && url.pathname === '/api/agents/admin/input') {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      fs.appendFileSync(adminLog, `${JSON.stringify({ auth: req.headers.authorization || null, tipo: req.headers['content-type'], corpo: Buffer.concat(partes).toString('utf8') })}\n`);
      res.writeHead((c.admin && c.admin.status) || 200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (url.pathname.startsWith('/repos/')) {
    const cmp = c.compare || { status: 404, body: {} };
    const pagina = url.searchParams.get('page') || '1';
    const corpo = pagina !== '1' && cmp.paginas && cmp.paginas[pagina] ? cmp.paginas[pagina] : cmp.body;
    setTimeout(() => {
      res.writeHead(cmp.status || 200, { 'Content-Type': 'application/json', ...(cmp.headers || {}) });
      res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
    }, cmp.atraso_ms || 0);
    return;
  }
  const arquivo = url.pathname.split('/').pop();
  const r = (c.raw || {})[arquivo];
  if (!r) { res.writeHead(404); res.end('nao existe'); return; }
  res.writeHead(r.status || 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(r.body || '');
});
servidor.listen(0, '127.0.0.1', () => fs.writeFileSync(portaArq, String(servidor.address().port)));
