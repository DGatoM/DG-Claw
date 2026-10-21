'use strict';
// Diagnóstico remoto (coletor): comandos, arquivos e runner falsos, nada de máquina de verdade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarDiagnostico } = require('../lib/diagnostico');

const AGORA = Date.UTC(2026, 9, 21, 15, 0, 0); // 21/10/2026 12:00 em São Paulo
const seg = (ms) => `@${Math.floor(ms / 1000)}`;
const H = 3600 * 1000;

function criaCasa() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const home = path.join(raiz, 'home');
  fs.mkdirSync(path.join(home, '.dgclaw', 'logs', 'pulso'), { recursive: true });
  fs.writeFileSync(path.join(home, 'working-memory.md'), 'x'.repeat(4000));
  fs.writeFileSync(path.join(home, '.dgclaw', 'logs', 'pulso', '2026-10-21.jsonl'), `${JSON.stringify({ ts: '2026-10-21T07:00:19-03:00', id: 'build-wm', status: 'ok', detalhe: '' })}\n`);
  fs.writeFileSync(path.join(home, '.dgclaw', 'logs', 'saude.json'), JSON.stringify({ estado: 'ativo', tipo: 'ok', frase: 'Está ativo.', trecho: null, verificadoEm: new Date(AGORA - 60000).toISOString() }));
  return { raiz, home, limpa: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

const CADENCIAS = {
  reflection: { cal: '*-*-* 23:30:00' },
  'build-wm': { cal: '*-*-* 07:00:00' },
  heartbeat: { intervalo: '30min' },
};

/** Blocos de `systemctl show` dos timers do container a partir de uma especificação. */
function blocosDeTimers(slug, specs) {
  return specs.map((s) => {
    const nome = `dgclaw-${slug}-${s.nome}`;
    const cad = CADENCIAS[s.nome];
    const ultimo = s.ultimoMs === undefined ? AGORA - (cad.intervalo ? 10 * 60000 : 2 * H) : s.ultimoMs;
    const timer = [`Id=${nome}.timer`, `ActiveState=${s.ativo || 'active'}`, 'SubState=waiting', 'Result=success',
      `LastTriggerUSec=${ultimo ? 'Wed 2026-10-21 09:11:30 -03' : ''}`, 'NextElapseUSecRealtime='];
    if (cad.cal) timer.push(`TimersCalendar={ OnCalendar=${cad.cal} ; next_elapse=${seg(s.proximaMs === undefined ? AGORA + 8 * H : s.proximaMs)} }`);
    if (cad.intervalo) timer.push(`TimersMonotonic={ OnUnitActiveUSec=${cad.intervalo} ; next_elapse=2d 1h }`);
    const servico = [`Id=${nome}.service`, 'ActiveState=inactive', 'SubState=dead', `Result=${s.resultado || 'success'}`,
      `ExecMainStatus=${s.codigo === undefined ? 0 : s.codigo}`, `ExecMainStartTimestamp=${ultimo ? seg(ultimo) : ''}`, `ExecMainExitTimestamp=${ultimo ? seg(ultimo) : ''}`];
    return `${timer.join('\n')}\n\n${servico.join('\n')}\n`;
  }).join('\n');
}

function montar(op) {
  op = op || {};
  const casa = criaCasa();
  const slug = 'tina';
  const chamadas = [];
  const logs = [];
  const timers = op.timers || [{ nome: 'reflection' }, { nome: 'build-wm' }, { nome: 'heartbeat' }];
  const inspect = op.inspect || { State: { Status: 'running', Running: true, ConmonPid: 4242, ExitCode: 0, StartedAt: '2026-10-19T17:19:43Z', FinishedAt: '0001-01-01T00:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'always' } } };
  const servicoHost = (u) => (op.servicos && op.servicos[u]) || { ActiveState: 'active', SubState: 'running', Result: 'success' };

  async function exec(cmd, args) {
    chamadas.push([cmd, ...args]);
    if (op.exec) { const r = op.exec(cmd, args); if (r !== undefined) return r; }
    if (cmd === 'systemctl' && args[0] === 'show') {
      const units = args.filter((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-p');
      const blocos = units.map((u) => {
        const base = u.replace(/\.(service|timer)$/, '');
        const s = servicoHost(base);
        return [`Id=${u}`, 'LoadState=loaded', `ActiveState=${s.ActiveState}`, `SubState=${s.SubState}`, `Result=${s.Result}`, `ExecMainStatus=${s.codigo || 0}`,
          `ActiveEnterTimestamp=${seg(AGORA - 5 * 24 * H)}`, `ExecMainExitTimestamp=${seg(AGORA - 3 * 60000)}`, `LastTriggerUSec=${seg(AGORA - 3 * 60000)}`].join('\n');
      });
      return { codigo: 0, stdout: `${blocos.join('\n\n')}\n`, stderr: '' };
    }
    if (cmd === 'journalctl') return { codigo: 0, stdout: op.journalHost || '', stderr: '' };
    if (cmd === 'podman' && args[0] === 'inspect') return { codigo: 0, stdout: JSON.stringify([inspect]), stderr: '' };
    if (cmd === 'podman' && args[0] === 'exec') {
      const resto = args.slice(2);
      if (resto[0] === 'systemctl' && resto[1] === 'list-units') return { codigo: 0, stdout: timers.map((t) => `dgclaw-${slug}-${t.nome}.timer loaded active waiting desc`).join('\n'), stderr: '' };
      if (resto[0] === 'systemctl' && resto[1] === 'show') return { codigo: 0, stdout: blocosDeTimers(slug, timers), stderr: '' };
      if (resto[0] === 'journalctl') return { codigo: 0, stdout: op.journal || '', stderr: '' };
      if (resto[0] === 'systemctl' && resto[1] === 'is-active') return { codigo: op.whatsappAtivo === 'active' ? 0 : 3, stdout: `${op.whatsappAtivo || 'inactive'}\n`, stderr: '' };
    }
    return { codigo: 1, stdout: '', stderr: `comando não previsto no teste: ${cmd} ${args.join(' ')}` };
  }

  const agentes = [
    { slug: 'admin', nome: 'Admin', tipo: 'admin', runner: 'http://127.0.0.1:1', agente_id: 'admin', home_host: path.join(casa.raiz, 'admin') },
    { slug, nome: 'Tina', tipo: 'agente', runner: 'http://127.0.0.1:2', agente_id: 'tina', home_host: casa.home, container: 'dgclaw-tina' },
    ...(op.agentesExtras || []),
  ];
  const saudeOk = { ok: true, status: 200, corpo: { ok: true, agente: { id: 'x', status: 'idle', ptyVivo: true }, ultimaSaidaEm: AGORA - 5 * 60000 } };
  const estadoOk = { ok: true, estado: { status: 'idle', updatedAt: AGORA - 5 * 60000, statusReason: null } };
  const provedorOk = { ok: true, dados: { conferido: { ok: true, em: new Date(AGORA - 60000).toISOString() }, canais: { telegram: 'desligado' } } };
  const falhaRunner = { ok: false, erro: 'não respondeu (/etc/dgclaw/runner/tina.token)' };
  const runner = {
    pedir: async () => (op.runner === 'fora' ? falhaRunner : (op.saude || saudeOk)),
    estado: async () => (op.runner === 'fora' ? falhaRunner : (op.estado || estadoOk)),
    provedor: async () => (op.runner === 'fora' ? falhaRunner : (op.provedor || provedorOk)),
  };
  const estadoAtualizacao = op.atualizacao || { estado: { desligado: false, disponivel: false, publicado: { commit: 'a'.repeat(40), versao: '1.0.0', data: null }, instalado: { commit: 'a'.repeat(40), versao: '1.0.0' }, commits_a_frente: 0, verificado_em: new Date(AGORA - 3 * H).toISOString(), erro: null } };
  const deps = {
    config: { tz: 'America/Sao_Paulo', agentesPath: path.join(casa.raiz, 'agentes.json'), dataDir: path.join(casa.raiz, 'web') },
    registro: { estado: () => (op.registro || { ok: true, erro: null, agentes }) },
    runner,
    log: (n, m) => logs.push([n, m]),
    exec,
    agora: () => (op.agoraFn ? op.agoraFn() : AGORA),
    statfs: async (p) => (op.statfs ? op.statfs(p) : { bsize: 4096, blocks: 1000000, bfree: 500000, bavail: 500000 }),
    meminfo: async () => op.meminfo || 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    uptime: () => (op.uptime === undefined ? 10 * 24 * 3600 : op.uptime),
    procVivo: (pid) => (op.conmonVivo === false ? false : pid === 4242),
    lerEnv: () => ({ vars: { DGCLAW_VERSAO: '1.0.0', DGCLAW_COMMIT: 'a'.repeat(40) }, erro: null }),
    atualizacao: { lerEstado: () => estadoAtualizacao },
    limiteMs: op.limiteMs,
  };
  if (op.ajusta) op.ajusta(casa, deps);
  const diag = criarDiagnostico(deps);
  return { diag, casa, chamadas, logs, deps };
}

const achar = (r, id) => r.verificacoes.find((v) => v.id === id);

test('tudo certo: resumo ok, sem item quebrado e ordem máquina, versão, admin, agentes', async () => {
  const m = montar();
  const r = await m.diag.coletar();
  assert.equal(r.ok, true);
  assert.equal(r.schema, 1);
  assert.equal(r.resumo.estado, 'ok');
  assert.equal(r.resumo.contagem.quebrado, 0);
  assert.equal(r.resumo.contagem.atencao, 0);
  assert.equal(achar(r, 'agente.tina.container').estado, 'ok');
  assert.equal(achar(r, 'agente.tina.cron.reflection').estado, 'ok');
  assert.equal(achar(r, 'agente.tina.canal.telegram').nome, 'Canal Telegram (desligado) - Tina');
  assert.equal(achar(r, 'agente.tina.memoria.injecao').estado, 'nao_medido', 'sem log de falha da memória não dá para afirmar');
  assert.equal(achar(r, 'admin.sessao').estado, 'ok');
  assert.equal(r.versao.instalada, '1.0.0');
  assert.equal(r.versao.commit, 'aaaaaaa');
  assert.equal(r.versao.atualizacao_disponivel, false);
  const ordem = r.verificacoes.map((v) => v.grupo);
  assert.ok(ordem.indexOf('versao') > ordem.lastIndexOf('maquina'), 'versão depois da máquina');
  assert.ok(ordem.indexOf('admin') > ordem.indexOf('versao'));
  assert.ok(ordem.indexOf('agente') > ordem.indexOf('admin'));
  for (const v of r.verificacoes) {
    if (v.estado !== 'ok') assert.ok(v.motivo && v.o_que_fazer, `${v.id} precisa de motivo e o que fazer`);
    else assert.equal(v.motivo, null);
  }
  m.casa.limpa();
});

test('container "created" depois de reiniciar: quebrado, e os dependentes ficam sem medida', async () => {
  const m = montar({
    runner: 'fora',
    inspect: { State: { Status: 'created', Running: false, ConmonPid: 0, ExitCode: 0, StartedAt: '0001-01-01T00:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'no' } } },
    ajusta: (casa) => { fs.mkdirSync(path.join(casa.home, '.dgclaw', 'whatsapp'), { recursive: true }); fs.writeFileSync(path.join(casa.home, '.dgclaw', 'whatsapp', 'ligado'), ''); },
  });
  const r = await m.diag.coletar();
  const c = achar(r, 'agente.tina.container');
  assert.equal(c.estado, 'quebrado');
  assert.match(c.motivo, /parado/);
  assert.match(c.motivo, /reinicia/);
  assert.match(c.prompt_sugerido, /dgclaw agente iniciar tina/);
  assert.match(c.o_que_fazer, /Admin/);
  for (const id of ['agente.tina.sessao', 'agente.tina.login', 'agente.tina.cron', 'agente.tina.canal.whatsapp', 'agente.tina.canal.painel']) {
    assert.equal(achar(r, id).estado, 'nao_medido', id);
  }
  assert.match(achar(r, 'agente.tina.cron').motivo, /container está parado/);
  assert.equal(r.verificacoes.filter((v) => v.estado === 'quebrado' && v.grupo === 'agente').length, 1, 'só o container fica quebrado');
  assert.equal(m.chamadas.filter((c2) => c2[0] === 'podman' && c2[1] === 'exec').length, 0, 'não tenta podman exec com o container parado');
  assert.equal(r.resumo.estado, 'quebrado');
  m.casa.limpa();
});

test('conmon morto com o podman dizendo "running": quebrado', async () => {
  const m = montar({ conmonVivo: false });
  const r = await m.diag.coletar();
  const c = achar(r, 'agente.tina.container');
  assert.equal(c.estado, 'quebrado');
  assert.match(c.motivo, /conmon/);
  assert.equal(achar(r, 'agente.tina.cron.reflection').estado, 'ok', 'o container responde, então o resto continua sendo medido');
  assert.equal(achar(r, 'agente.tina.sessao').estado, 'ok');
  m.casa.limpa();
});

test('login expirado: quebrado com a hora, sem prompt, e a sessão aponta para o login', async () => {
  const expirou = new Date(AGORA - 14 * H).toISOString();
  const m = montar({ estado: { ok: true, estado: { status: 'errored', statusReason: 'runner:login-expirado', loginExpiradoEm: expirou, updatedAt: AGORA - 14 * H } } });
  const r = await m.diag.coletar();
  const l = achar(r, 'agente.tina.login');
  assert.equal(l.estado, 'quebrado');
  assert.match(l.motivo, /expirou em 20\/10 às 22h00/);
  assert.equal(l.evidencia.trecho, 'runner:login-expirado');
  assert.equal(l.prompt_sugerido, null);
  assert.match(l.o_que_fazer, /login/i);
  assert.equal(achar(r, 'agente.tina.sessao').estado, 'quebrado');
  assert.equal(achar(r, 'admin.sessao').estado, 'quebrado', 'o mesmo runner falso serve o Admin');
  m.casa.limpa();
});

test('conferência da conta recusada: quebrado; sem conferência: sem medida', async () => {
  let m = montar({ provedor: { ok: true, dados: { conferido: { ok: false, detalhe: 'Conta recusada', em: new Date(AGORA).toISOString() }, canais: {} } } });
  assert.equal(achar(await m.diag.coletar(), 'agente.tina.login').estado, 'quebrado');
  m.casa.limpa();
  m = montar({ provedor: { ok: true, dados: { conferido: null, canais: {} } } });
  assert.equal(achar(await m.diag.coletar(), 'agente.tina.login').estado, 'nao_medido');
  m.casa.limpa();
});

test('rotina que falhou: evidência com exit code e linhas do journal sem segredo', async () => {
  // Segredos de mentira montados em pedaços, para o arquivo de teste não parecer uma chave de verdade.
  const segredo = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-');
  const chave = ['dgc', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join('_');
  const email = ['maria', 'exemplo.com.br'].join('@');
  const journal = [
    '2026-10-21T07:00:19-03:00 tina build-wm[12]: iniciando',
    `2026-10-21T07:00:20-03:00 tina build-wm[12]: erro ao chamar a API com ${segredo} para ${email}`,
    `2026-10-21T07:00:21-03:00 tina build-wm[12]: falhou: Authorization falhou com ${chave} em /etc/dgclaw/runner/tina.token`,
  ].join('\n');
  const m = montar({ journal, timers: [{ nome: 'reflection' }, { nome: 'build-wm', resultado: 'exit-code', codigo: 3 }, { nome: 'heartbeat' }] });
  const r = await m.diag.coletar();
  const c = achar(r, 'agente.tina.cron.build-wm');
  assert.equal(c.estado, 'quebrado');
  assert.equal(c.evidencia.codigo_saida, 3);
  assert.match(c.motivo, /código de saída 3/);
  assert.match(c.nome, /Montagem da memória de trabalho/);
  const tudo = JSON.stringify(r);
  for (const proibido of [segredo, chave, email, '/etc/dgclaw/runner']) assert.ok(!tudo.includes(proibido), `vazou ${proibido}`);
  assert.match(c.evidencia.trecho, /\[segredo oculto\]/);
  assert.match(c.evidencia.trecho, /\[arquivo protegido\]/);
  m.casa.limpa();
});

test('rotina atrasada vira atenção; rotina que nunca rodou vira sem medida', async () => {
  const m = montar({ timers: [{ nome: 'reflection', proximaMs: AGORA - 2 * H }, { nome: 'build-wm', ultimoMs: null }, { nome: 'heartbeat', ultimoMs: AGORA - 3 * H }] });
  const r = await m.diag.coletar();
  const atrasada = achar(r, 'agente.tina.cron.reflection');
  assert.equal(atrasada.estado, 'atencao');
  assert.match(atrasada.motivo, /Deveria ter rodado .* e não rodou/);
  const nunca = achar(r, 'agente.tina.cron.build-wm');
  assert.equal(nunca.estado, 'nao_medido');
  assert.match(nunca.motivo, /Ainda não rodou/);
  assert.equal(achar(r, 'agente.tina.cron.heartbeat').estado, 'atencao', 'batimento de 30 min sem rodar há 3 h');
  m.casa.limpa();
});

test('timer desligado: quebrado', async () => {
  const m = montar({ timers: [{ nome: 'reflection', ativo: 'inactive' }, { nome: 'build-wm' }, { nome: 'heartbeat' }] });
  const c = achar(await m.diag.coletar(), 'agente.tina.cron.reflection');
  assert.equal(c.estado, 'quebrado');
  assert.match(c.motivo, /desligada/);
  m.casa.limpa();
});

test('disco 96% cheio: quebrado, com porcentagem e GB livres', async () => {
  const m = montar({ statfs: () => ({ bsize: 4096, blocks: 1000000, bfree: 40000, bavail: 40000 }) });
  const d = achar(await m.diag.coletar(), 'maquina.disco');
  assert.equal(d.estado, 'quebrado');
  assert.match(d.motivo, /96% cheio/);
  assert.match(d.evidencia.trecho, /GB livres/);
  m.casa.limpa();
  const m2 = montar({ statfs: () => ({ bsize: 4096, blocks: 1000000, bfree: 100000, bavail: 100000 }) });
  assert.equal(achar(await m2.diag.coletar(), 'maquina.disco').estado, 'atencao');
  m2.casa.limpa();
});

test('memória: abaixo de 10% é atenção, abaixo de 5% é quebrado', async () => {
  let m = montar({ meminfo: 'MemTotal: 1000000 kB\nMemAvailable: 80000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' });
  assert.equal(achar(await m.diag.coletar(), 'maquina.memoria').estado, 'atencao');
  m.casa.limpa();
  m = montar({ meminfo: 'MemTotal: 1000000 kB\nMemAvailable: 30000 kB\n' });
  assert.equal(achar(await m.diag.coletar(), 'maquina.memoria').estado, 'quebrado');
  m.casa.limpa();
  m = montar({ meminfo: 'lixo' });
  assert.equal(achar(await m.diag.coletar(), 'maquina.memoria').estado, 'nao_medido');
  m.casa.limpa();
});

test('máquina reiniciada há pouco: atenção informativa; serviço parado: quebrado', async () => {
  const m = montar({ uptime: 2 * 3600, servicos: { 'dgclaw-web': { ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', codigo: 1 } } });
  const r = await m.diag.coletar();
  const rein = achar(r, 'maquina.reinicio');
  assert.equal(rein.estado, 'atencao');
  assert.match(rein.motivo, /reiniciou 21\/10 às 10h00/);
  const web = achar(r, 'maquina.servico.dgclaw-web');
  assert.equal(web.estado, 'quebrado');
  assert.equal(web.evidencia.codigo_saida, 1);
  m.casa.limpa();
});

test('saude.json: o campo "trecho" (texto de conversa) nunca sai', async () => {
  const frase = 'MINHA SENHA DO BANCO E A CONVERSA PRIVADA DO CLIENTE XYZ123';
  const m = montar({ ajusta: (casa) => fs.writeFileSync(path.join(casa.home, '.dgclaw', 'logs', 'saude.json'), JSON.stringify({ estado: 'atencao', tipo: 'recusa', frase, trecho: frase, desde: new Date(AGORA - H).toISOString(), verificadoEm: new Date(AGORA - 60000).toISOString() })) });
  const r = await m.diag.coletar();
  const s = achar(r, 'agente.tina.saude_resposta');
  assert.equal(s.estado, 'atencao');
  assert.match(s.motivo, /recusou/);
  assert.ok(!JSON.stringify(r).includes('XYZ123'));
  m.casa.limpa();
});

test('saude.json que é link para fora da casa: sem medida e o conteúdo não vaza', async () => {
  const m = montar({
    ajusta: (casa) => {
      const fora = path.join(casa.raiz, 'fora.json');
      fs.writeFileSync(fora, JSON.stringify({ estado: 'inativo', tipo: 'sessao_caida', frase: 'SEGREDO-DE-FORA-777' }));
      const alvo = path.join(casa.home, '.dgclaw', 'logs', 'saude.json');
      fs.unlinkSync(alvo);
      fs.symlinkSync(fora, alvo);
    },
  });
  const r = await m.diag.coletar();
  const s = achar(r, 'agente.tina.saude_resposta');
  assert.equal(s.estado, 'nao_medido');
  assert.match(s.motivo, /fora da pasta do agente/);
  assert.ok(!JSON.stringify(r).includes('SEGREDO-DE-FORA-777'));
  assert.ok(!JSON.stringify(r).includes('fora.json'));
  m.casa.limpa();
});

test('pasta .dgclaw trocada por link para fora da casa também é recusada', async () => {
  const m = montar({
    ajusta: (casa) => {
      const fora = path.join(casa.raiz, 'outra');
      fs.mkdirSync(path.join(fora, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(fora, 'logs', 'saude.json'), JSON.stringify({ estado: 'ativo', tipo: 'ok', frase: 'OUTRA-PASTA-999' }));
      fs.rmSync(path.join(casa.home, '.dgclaw'), { recursive: true });
      fs.symlinkSync(fora, path.join(casa.home, '.dgclaw'));
    },
  });
  const r = await m.diag.coletar();
  assert.equal(achar(r, 'agente.tina.saude_resposta').estado, 'nao_medido');
  assert.ok(!JSON.stringify(r).includes('OUTRA-PASTA-999'));
  m.casa.limpa();
});

test('saude.json com JSON inválido: sem medida', async () => {
  const m = montar({ ajusta: (casa) => fs.writeFileSync(path.join(casa.home, '.dgclaw', 'logs', 'saude.json'), '{ isto não é json') });
  const s = achar(await m.diag.coletar(), 'agente.tina.saude_resposta');
  assert.equal(s.estado, 'nao_medido');
  assert.match(s.motivo, /JSON válido/);
  m.casa.limpa();
});

test('verificação que estoura o tempo vira sem medida e as outras seguem', async () => {
  const m = montar({
    limiteMs: 80,
    exec: (cmd, args) => (cmd === 'systemctl' && args.includes('caddy.service') ? new Promise(() => {}) : undefined),
  });
  const r = await m.diag.coletar();
  const caddy = achar(r, 'maquina.servico.caddy');
  assert.equal(caddy.estado, 'nao_medido');
  assert.match(caddy.motivo, /Não respondeu em/);
  assert.equal(achar(r, 'maquina.servico.dgclaw-web').estado, 'ok');
  assert.equal(achar(r, 'agente.tina.container').estado, 'ok');
  m.casa.limpa();
});

test('exceção dentro de uma verificação não derruba as outras e não vaza a mensagem', async () => {
  const m = montar({ statfs: () => { throw new Error('boom /etc/dgclaw/runner/tina.token'); } });
  const r = await m.diag.coletar();
  assert.equal(achar(r, 'maquina.disco').estado, 'nao_medido');
  assert.ok(!JSON.stringify(r).includes('tina.token'));
  assert.equal(achar(r, 'maquina.memoria').estado, 'ok');
  m.casa.limpa();
});

test('resumo: quebrado vence atenção, e a frase conta certo', async () => {
  const m = montar({ uptime: 3600, statfs: () => ({ bsize: 4096, blocks: 1000000, bfree: 40000, bavail: 40000 }) });
  const r = await m.diag.coletar();
  assert.equal(r.resumo.estado, 'quebrado');
  const c = r.resumo.contagem;
  assert.equal(c.ok + c.atencao + c.quebrado + c.nao_medido, r.verificacoes.length);
  assert.match(r.resumo.frase, /^1 item quebrado e 1 pedindo atenção/);
  m.casa.limpa();
});

test('atualização disponível: atenção com instrução; sem estado.json: sem medida e null no topo', async () => {
  let m = montar({ atualizacao: { estado: { desligado: false, disponivel: true, publicado: { commit: 'b'.repeat(40), versao: '1.0.1', data: null }, instalado: { commit: 'a'.repeat(40), versao: '1.0.0' }, commits_a_frente: 4, verificado_em: new Date(AGORA - H).toISOString(), erro: null } } });
  let r = await m.diag.coletar();
  assert.equal(achar(r, 'versao').estado, 'atencao');
  assert.match(achar(r, 'versao').prompt_sugerido, /dgclaw atualizar/);
  assert.equal(r.versao.publicada, '1.0.1');
  assert.equal(r.versao.atualizacao_disponivel, true);
  assert.equal(r.versao.commits_a_frente, 4);
  m.casa.limpa();
  m = montar({ atualizacao: { ausente: true } });
  r = await m.diag.coletar();
  assert.equal(achar(r, 'versao').estado, 'nao_medido');
  assert.equal(r.versao.atualizacao_disponivel, null);
  assert.equal(r.versao.commits_a_frente, null);
  assert.equal(r.versao.instalada, '1.0.0');
  m.casa.limpa();
});

test('slug fora do padrão nunca chega a um comando', async () => {
  const m = montar({ agentesExtras: [{ slug: 'x;rm -rf', nome: 'Mau', tipo: 'agente', runner: 'http://127.0.0.1:3', agente_id: 'x', home_host: '/tmp', container: 'dgclaw-x;rm' }] });
  const r = await m.diag.coletar();
  assert.ok(!r.verificacoes.some((v) => v.alvo && v.alvo.includes(';')));
  assert.ok(!m.chamadas.some((c) => c.join(' ').includes(';')));
  m.casa.limpa();
});

test('canais ligados: WhatsApp deslogado e Telegram com vigia marcando dead', async () => {
  const m = montar({
    whatsappAtivo: 'active',
    provedor: { ok: true, dados: { conferido: { ok: true, em: new Date(AGORA).toISOString() }, canais: { telegram: 'ligado' } } },
    ajusta: (casa) => {
      const wa = path.join(casa.home, '.dgclaw', 'whatsapp');
      fs.mkdirSync(wa, { recursive: true });
      fs.writeFileSync(path.join(wa, 'ligado'), '');
      fs.writeFileSync(path.join(wa, 'estado.json'), JSON.stringify({ versao: 1, estado: 'deslogado', desde: new Date(AGORA - 2 * H).toISOString(), numero_bot: '5511999998888', motivo: 'o WhatsApp encerrou o aparelho' }));
      fs.writeFileSync(path.join(casa.home, '.dgclaw', 'canais.json'), JSON.stringify({ versao: 1, telegram: { ligado: true } }));
      fs.writeFileSync(path.join(casa.home, '.dgclaw', 'logs', 'channel-watchdog.state'), 'dead 3 1792000000 1792000000\n');
    },
  });
  const r = await m.diag.coletar();
  assert.equal(achar(r, 'agente.tina.canal.whatsapp').estado, 'quebrado');
  assert.equal(achar(r, 'agente.tina.canal.telegram').estado, 'quebrado');
  assert.ok(!JSON.stringify(r).includes('5511999998888'), 'o número do bot nunca sai');
  m.casa.limpa();
});

test('memória: erros nas últimas 24 h viram atenção com linha higienizada; teto da working memory', async () => {
  const m = montar({
    ajusta: (casa) => {
      fs.writeFileSync(path.join(casa.home, '.dgclaw', 'logs', 'memory-recall.log'), '[2026-10-21 08:00:00] erro ao buscar a memória: "o cliente Fulano de Tal disse que o telefone dele é bem grande e secreto demais para sair daqui"\n');
      fs.writeFileSync(path.join(casa.home, 'working-memory.md'), 'x'.repeat(15000));
    },
  });
  const r = await m.diag.coletar();
  const i = achar(r, 'agente.tina.memoria.injecao');
  assert.equal(i.estado, 'atencao');
  assert.ok(!JSON.stringify(r).includes('Fulano de Tal'));
  assert.equal(achar(r, 'agente.tina.memoria.working_memory').estado, 'atencao');
  m.casa.limpa();
});

function resposta() {
  return { status: null, cab: null, corpo: '', writeHead(s, c) { this.status = s; this.cab = c; }, end(t) { this.corpo = t || ''; } };
}

test('responder: JSON 200 sem cache no navegador, rotas erradas dão 404/405, docs.md em markdown', async () => {
  const m = montar();
  const chamar = async (metodo, caminho) => {
    const res = resposta();
    await m.diag.responder({ method: metodo }, res, new URL(caminho, 'http://x'), { tipo: 'chave', nome: 'Suporte' });
    return res;
  };
  const ok = await chamar('GET', '/api/v1/diagnostico/');
  assert.equal(ok.status, 200);
  assert.equal(ok.cab['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(ok.corpo).schema, 1);
  assert.equal((await chamar('GET', '/api/v1/diagnostico/outra')).status, 404);
  const post = await chamar('POST', '/api/v1/diagnostico');
  assert.equal(post.status, 405);
  assert.match(JSON.parse(post.corpo).erro, /só lê/);
  const docs = await chamar('GET', '/api/v1/diagnostico/docs.md');
  assert.equal(docs.status, 200);
  assert.match(docs.cab['Content-Type'], /text\/markdown; charset=utf-8/);
  assert.match(docs.corpo, /Diagnóstico remoto/);
  m.casa.limpa();
});

test('responder: cache de 20 s compartilhado entre pedidos simultâneos', async () => {
  let agora = AGORA;
  const m = montar({ agoraFn: () => agora });
  const chamar = async () => {
    const res = resposta();
    await m.diag.responder({ method: 'GET' }, res, new URL('/api/v1/diagnostico', 'http://x'), null);
    return res;
  };
  await Promise.all([chamar(), chamar(), chamar()]);
  const depoisDoPrimeiro = m.chamadas.length;
  assert.ok(depoisDoPrimeiro > 0);
  agora += 10000;
  await chamar();
  assert.equal(m.chamadas.length, depoisDoPrimeiro, 'dentro de 20 s usa o cache, e os três pedidos simultâneos dividiram uma coleta');
  agora += 11000;
  await chamar();
  assert.equal(m.chamadas.length, depoisDoPrimeiro * 2, 'passados 20 s coleta de novo');
  m.casa.limpa();
});

test('responder: coleta que estoura vira 500 com motivo, sem stack e sem caminho', async () => {
  const m = montar();
  m.deps.registro.estado = () => { throw new Error('falha em /etc/dgclaw/runner/tina.token'); };
  const res = resposta();
  await m.diag.responder({ method: 'GET' }, res, new URL('/api/v1/diagnostico', 'http://x'), null);
  assert.equal(res.status, 500);
  assert.ok(!res.corpo.includes('tina.token'));
  assert.ok(!res.corpo.includes(' at '));
  assert.ok(m.logs.some(([n, t]) => n === 'erro' && t.includes('tina.token')), 'o log tem o detalhe');
  m.casa.limpa();
});
