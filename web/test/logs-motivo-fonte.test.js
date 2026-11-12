'use strict';
// Seção Logs: o motivo de uma fonte (cartão Fontes) passa pelo mascarador, porque pode citar o caminho de uma pasta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, subirWeb } = require('./ajuda');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const SEG = 'SEGREDO_SINTETICO_105';

test('motivo da fonte com caminho de segredo não aparece em agentes, sessões nem eventos', async () => {
  const home = pastaTemp('logs-motivo');
  const agentes = [{ slug: 'ana', nome: 'Ana', tipo: 'agente', runner: 'http://127.0.0.1:1', agente_id: 'ana1', provedor: 'claude', home_host: home, home_container: '/home/agente' }];
  const t = await subirWeb({ agentes });
  try {
    await t.login();
    const dir = path.join(home, '.claude', 'projects', `password=${SEG}`);
    fs.mkdirSync(dir, { recursive: true });
    const a = path.join(dir, `${U1}.jsonl`);
    fs.writeFileSync(a, JSON.stringify({ type: 'user', timestamp: '2026-11-01T12:00:00.000Z', sessionId: U1, message: { role: 'user', content: 'oi' } }) + '\n');
    fs.linkSync(a, path.join(dir, `${U2}.jsonl`));
    for (const rota of ['/api/v1/logs/agentes', '/api/v1/logs/agentes/ana/sessoes', '/api/v1/logs/agentes/ana/eventos']) {
      const r = await t.c.get(rota);
      assert.equal(r.status, 200, rota);
      const claude = JSON.stringify(r.json);
      assert.ok(!claude.includes(SEG), `${rota} expôs o segredo: ${claude}`);
    }
    const fontes = (await t.c.get('/api/v1/logs/agentes')).json.agentes[0].fontes;
    assert.equal(fontes.find((f) => f.motor === 'claude').estado, 'ilegivel');
  } finally { await t.fechar(); }
});
