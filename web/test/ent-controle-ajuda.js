'use strict';
// Apoio dos testes do bloco C: o cenário do bloco B (TI, funcionária, três agentes) mais o serviço de controle de verdade,
// num socket temporário, chamando um `dgclaw` de mentira que só anota o argv que recebeu.
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, cliente } = require('./ajuda');
const { cenarioEnt, criarUsuario } = require('./ent-usuarios-ajuda');
const { criarControle } = require('../../controle/servidor');

const DGCLAW_FALSO = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (process.env.DGCLAW_FAKE_LOG) fs.appendFileSync(process.env.DGCLAW_FAKE_LOG, JSON.stringify({ argv: a, quem: process.env.DGCLAW_QUEM }) + '\\n');
const k = a.slice(0, 2).join(' ');
if (process.env.DGCLAW_FAKE_FALHA && k === process.env.DGCLAW_FAKE_FALHA) { console.error('o falso falhou de proposito'); process.exit(1); }
if (k === 'agente listar') { console.log(JSON.stringify([{ slug: 'ana', nome: 'Ana', provedor: 'claude', estado: 'running', porta_runner: 4311, saude: 'ok' }])); process.exit(0); }
if (a[0] === 'status') { console.log('tudo de pe, menos o firewall'); process.exit(3); }
if (a[0] === 'agente' && a[1] === 'criar') { setTimeout(() => { console.log('ana esta criada. chave sk-ant-api03-' + 'x'.repeat(95)); process.exit(0); }, 300); return; }
console.log('feito: ' + a.join(' '));
process.exit(0);
`;

/** Cenário do bloco C: o Admin com papel "admin", o controle no ar e o dgclaw falso. `opcoes.nivel` troca o nível. */
async function cenarioControle(opcoes) {
  const o = opcoes || {};
  const c = await cenarioEnt({ nivel: o.nivel || 'escritorio', ajustes: o.ajustes });
  fs.copyFileSync(path.join(__dirname, '../public/aprovacoes.html'), path.join(c.s.publico, 'aprovacoes.html'));
  const dir = pastaTemp('ctl');
  const bin = path.join(dir, 'dgclaw');
  fs.writeFileSync(bin, DGCLAW_FALSO, { mode: 0o755 });
  const log = path.join(dir, 'chamadas.jsonl');
  const socket = path.join(dir, 'controle.sock');
  process.env.DGCLAW_FAKE_LOG = log;
  delete process.env.DGCLAW_FAKE_FALHA;
  process.env.DGCLAW_CONTROLE_SOCK = socket;

  // o registro do bloco B tem o Admin só com tipo "admin"; aqui ele ganha o papel que o bloco C exige
  const lista = JSON.parse(fs.readFileSync(c.s.agentesPath, 'utf8'));
  for (const a of lista.agentes) if (a.slug === 'admin') a.papel = 'admin';
  fs.writeFileSync(c.s.agentesPath, JSON.stringify(lista, null, 2));

  const casas = path.join(dir, 'casas');
  fs.mkdirSync(path.join(casas, 'ana', 'home', '.dgclaw', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(casas, 'ana', 'home', '.dgclaw', 'logs', 'runner.log'), Array.from({ length: 300 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n');

  const controle = criarControle({
    socket, dataDir: c.dataDir, bin, agentesPath: c.s.agentesPath, casasDir: casas,
    protecoesPath: c.protecoesPath, auditoriaPath: c.auditoriaPath, log: () => {}, agora: c.tempo.agora,
  });
  await controle.ouvir();

  // pessoal com o Admin isolado ligado à mão: o arquivo de nível só existe se houver ajuste
  if ((o.nivel === 'pessoal') && o.ajustes && Object.keys(o.ajustes).length) fs.writeFileSync(c.protecoesPath, JSON.stringify({ nivel: 'pessoal', ajustes: o.ajustes }));
  /** Sobe de novo o controle depois de ele ter sido fechado pelo teste. */
  const religar = async () => {
    const novo = criarControle({ socket, dataDir: c.dataDir, bin, agentesPath: c.s.agentesPath, casasDir: casas, protecoesPath: c.protecoesPath, auditoriaPath: c.auditoriaPath, log: () => {}, agora: c.tempo.agora });
    await novo.ouvir();
    return novo;
  };
  const chamadas = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fechar = async () => { await controle.fechar(); await c.fechar(); delete process.env.DGCLAW_CONTROLE_SOCK; delete process.env.DGCLAW_FAKE_LOG; delete process.env.DGCLAW_FAKE_FALHA; };

  /** Cliente que fala como o agente `slug` pela caixa (cabeçalhos que só o Web conhece). */
  function comoAgente(slug) {
    const cli = cliente(c.s.porta);
    const h = { 'X-DGClaw-Caixa': c.s.web.caixa.segredo, 'X-DGClaw-Agente': slug };
    return {
      post: (rota, json) => cli.pedir('POST', rota, { json, headers: h, origin: false }),
      get: (rota) => cli.pedir('GET', rota, { headers: h, origin: false }),
    };
  }
  const ti = async () => (await c.entrar('dono', c.senhaTi)).cli;
  const funcionaria = async (ctiCli) => {
    const u = await criarUsuario(c, ctiCli, { usuario: 'fran', nome: 'Fran', papel: 'funcionario', agentes: ['ana'] });
    return (await c.entrar('fran', u.senha)).cli;
  };
  return { c, controle, religar, socket, bin, chamadas, fechar, comoAgente, ti, funcionaria, casas };
}

module.exports = { cenarioControle };
