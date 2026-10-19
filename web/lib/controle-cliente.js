'use strict';
// Cliente do serviço de controle (controle/servidor.js): uma linha JSON por pedido no socket unix, uma linha de resposta.
// O caminho do socket vem de DGCLAW_CONTROLE_SOCK (padrão /run/dgclaw/controle.sock) e é lido a cada chamada.

const net = require('node:net');

const PADRAO = '/run/dgclaw/controle.sock';
const PRAZO_MS = 60 * 1000;

function caminhoDoSocket(env) {
  return (env && env.DGCLAW_CONTROLE_SOCK) || process.env.DGCLAW_CONTROLE_SOCK || PADRAO;
}

/**
 * Faz um pedido ao controle. Devolve a resposta do controle ({ ok, resultado } ou { ok:false, motivo, erro }).
 * Se não conseguir falar com ele, devolve { ok:false, motivo:'controle_fora', erro } com o que fazer, e nunca lança.
 */
function chamar(pedido, opcoes) {
  const o = opcoes || {};
  const socket = caminhoDoSocket(o.env);
  return new Promise((resolve) => {
    let pronto = false;
    let buf = '';
    const fim = (r) => { if (!pronto) { pronto = true; resolve(r); } };
    const falha = (erro) => fim({ ok: false, motivo: 'controle_fora', erro });
    const c = net.createConnection(socket);
    c.setEncoding('utf8');
    c.setTimeout(o.prazoMs || PRAZO_MS, () => {
      c.destroy();
      falha(`O serviço de controle não respondeu em ${(o.prazoMs || PRAZO_MS) / 1000} s (${socket}). Veja se ele está rodando: systemctl status dgclaw-controle; o log fica em journalctl -u dgclaw-controle.`);
    });
    c.on('error', (e) => {
      const razao = e.code === 'ENOENT' ? `o socket ${socket} não existe` : e.code === 'ECONNREFUSED' ? `ninguém escuta em ${socket}` : e.code === 'EACCES' ? `sem permissão para abrir ${socket}` : `${e.code || e.message}`;
      falha(`Não consegui falar com o serviço de controle: ${razao}. No servidor, rode: systemctl status dgclaw-controle (e systemctl restart dgclaw-controle se ele estiver parado).`);
    });
    c.on('connect', () => { c.write(`${JSON.stringify(pedido)}\n`); });
    c.on('data', (pedaco) => {
      buf += pedaco;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const linha = buf.slice(0, i);
      c.end();
      try { fim(JSON.parse(linha)); } catch (e) {
        fim({ ok: false, motivo: 'controle_fora', erro: `O controle respondeu algo que não é JSON (${e.message}). Reinicie o serviço: systemctl restart dgclaw-controle.` });
      }
    });
    c.on('close', () => falha('O serviço de controle fechou a conexão sem responder. Veja o log: journalctl -u dgclaw-controle.'));
  });
}

module.exports = { chamar, caminhoDoSocket };
