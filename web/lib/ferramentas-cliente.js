'use strict';
// Cliente do serviço de ferramentas (ferramentas/servidor.js): uma linha JSON por pedido no socket unix, uma linha de resposta.
// O caminho do socket vem de DGCLAW_FERRAMENTAS_SOCK (padrão /run/dgclaw-ferramentas/ferramentas.sock) e é lido a cada chamada.

const net = require('node:net');

const PADRAO = '/run/dgclaw-ferramentas/ferramentas.sock';
// A ferramenta tem no máximo 25 s para rodar (ferramentas/esquema.js); sobra folga para a conversa pelo socket.
const PRAZO_MS = 40 * 1000;

function caminhoDoSocket(env) {
  return (env && env.DGCLAW_FERRAMENTAS_SOCK) || process.env.DGCLAW_FERRAMENTAS_SOCK || PADRAO;
}

/**
 * Faz um pedido ao serviço. Devolve a resposta dele ({ ok, ... }) ou { ok:false, motivo:'ferramentas_fora', erro } com o que
 * fazer quando não consegue falar com ele. Nunca lança.
 */
function chamar(pedido, opcoes) {
  const o = opcoes || {};
  const socket = caminhoDoSocket(o.env);
  return new Promise((resolve) => {
    let pronto = false;
    let buf = '';
    const fim = (r) => { if (!pronto) { pronto = true; resolve(r); } };
    const falha = (erro) => fim({ ok: false, motivo: 'ferramentas_fora', erro });
    const c = net.createConnection(socket);
    c.setEncoding('utf8');
    c.setTimeout(o.prazoMs || PRAZO_MS, () => {
      c.destroy();
      falha(`O serviço de ferramentas não respondeu em ${(o.prazoMs || PRAZO_MS) / 1000} s (${socket}). No servidor: systemctl status dgclaw-ferramentas; o log fica em journalctl -u dgclaw-ferramentas.`);
    });
    c.on('error', (e) => {
      const razao = e.code === 'ENOENT' ? `o socket ${socket} não existe` : e.code === 'ECONNREFUSED' ? `ninguém escuta em ${socket}` : e.code === 'EACCES' ? `sem permissão para abrir ${socket}` : `${e.code || e.message}`;
      falha(`Não consegui falar com o serviço de ferramentas: ${razao}. No servidor, rode: systemctl status dgclaw-ferramentas (e systemctl restart dgclaw-ferramentas se ele estiver parado).`);
    });
    c.on('connect', () => { c.write(`${JSON.stringify(pedido)}\n`); });
    c.on('data', (pedaco) => {
      buf += pedaco;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const linha = buf.slice(0, i);
      c.end();
      try { fim(JSON.parse(linha)); } catch (e) {
        fim({ ok: false, motivo: 'ferramentas_fora', erro: `O serviço de ferramentas respondeu algo que não é JSON (${e.message}). Reinicie: systemctl restart dgclaw-ferramentas.` });
      }
    });
    c.on('close', () => falha('O serviço de ferramentas fechou a conexão sem responder. Veja o log: journalctl -u dgclaw-ferramentas.'));
  });
}

module.exports = { chamar, caminhoDoSocket };
