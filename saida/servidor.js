#!/usr/bin/env node
'use strict';
// dgclaw-saida: o proxy de saída dos agentes. Roda como usuário sem privilégio (unidade dgclaw-saida.service).
// Variáveis: DGCLAW_ETC (padrão /etc/dgclaw), DGCLAW_LOG_SAIDA (padrão /var/log/dgclaw/saida), DGCLAW_SAIDA_PORTA (3128).
const path = require('node:path');
const { criarProxy } = require('./proxy');

const etc = process.env.DGCLAW_ETC || '/etc/dgclaw';
const logDir = process.env.DGCLAW_LOG_SAIDA || '/var/log/dgclaw/saida';
const porta = Number(process.env.DGCLAW_SAIDA_PORTA || 3128);
if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
  console.error(`[dgclaw-saida] DGCLAW_SAIDA_PORTA="${process.env.DGCLAW_SAIDA_PORTA}" não é uma porta válida. Use um número de 1 a 65535 ou tire a variável (o padrão é 3128).`);
  process.exit(2);
}

const proxy = criarProxy({
  etc,
  logDir,
  baseArq: process.env.DGCLAW_SAIDA_BASE || path.join(__dirname, '..', 'config', 'saida-base.json'),
  porta,
});
proxy.iniciar();
console.log(`[dgclaw-saida] no ar (config em ${etc}/saida, registro em ${logDir})`);

for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => { proxy.parar().finally(() => process.exit(0)); });
}
