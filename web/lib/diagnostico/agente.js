'use strict';
// Verificações de um agente. Cada tarefa é { sufixo, nome, depende?, fn(dependencia) } e devolve um resultado
// (ver util.R) ou { varias: [...] } quando uma tarefa vira vários itens (as rotinas).
// Nada aqui devolve o conteúdo cru de arquivo do agente: só campos da lista permitida, higienizados.

const { higienizar } = require('./higiene');
const { lerJsonSeguro } = require('./arquivos');
const { analisaLogin, analisaSessao } = require('./sessao');
const { conferirRotinas } = require('./cron');
const U = require('./util');

const { R, conserta } = U;
const DIA_MS = 24 * 3600 * 1000;
const TETO_WM_AVISO = 14000; // o session-context.sh corta em 14000 caracteres; acima disso a memória de trabalho não cabe inteira
const RX_ERRO_LOG = /error|erro|falh|fail|traceback|exception|denied/i;
const PARADO = 'O container está parado, então não deu para conferir.';

function memo(fn) { let p = null; return () => (p || (p = Promise.resolve().then(fn))); }

/** Data AAAA-MM-DD no fuso da instalação. */
function diaNoFuso(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const FRASES_SAUDE = {
  recusa: ['O Claude recusou um pedido e a sessão ficou parada nesse aviso.', 'reiniciar a sessão'],
  login: ['A sessão parou por problema de login do Claude.', 'refazer o login'],
  limite: ['O plano do Claude chegou no limite de uso e a sessão está esperando renovar.', 'esperar o limite renovar'],
  sobrecarga: ['O serviço do Claude estava sobrecarregado e a sessão não conseguiu responder.', 'reiniciar a sessão se não passar sozinho'],
  contexto: ['A conversa ficou grande demais para o Claude e precisa ser compactada.', 'compactar ou reiniciar a sessão'],
  sem_resposta: ['A sessão recebeu mensagens e não respondeu.', 'reiniciar a sessão'],
  erro_api: ['A API do Claude devolveu erro para a sessão.', 'reiniciar a sessão se persistir'],
  sessao_caida: ['A sessão do Claude caiu.', 'reiniciar a sessão'],
};

function tarefasDoAgente(ctx, ag) {
  const { exec, config, lerArquivo, agora, runner, log, procVivo } = ctx;
  const { slug } = ag;
  const nome = ag.nome;
  const home = ag.home_host;
  const tz = config.tz;
  const cmdReiniciar = `dgclaw agente reiniciar ${slug}`;
  const cmdReparar = `dgclaw agente reparar ${slug}`;

  const saudeRunner = memo(() => runner.pedir(ag, 'GET', '/api/saude', null, 4000));
  const estadoRunner = memo(() => runner.estado(ag));
  const provedorRunner = memo(() => runner.provedor(ag, 4000));
  const ledger = memo(async () => {
    const agoraMs = agora();
    const registros = [];
    for (const ms of [agoraMs - DIA_MS, agoraMs]) {
      const r = lerArquivo(home, `.dgclaw/logs/pulso/${diaNoFuso(ms, tz)}.jsonl`);
      if (r.estado !== 'ok') continue;
      for (const linha of r.texto.split('\n')) {
        if (!linha.trim()) continue;
        try {
          const j = JSON.parse(linha);
          if (j && typeof j === 'object') registros.push({ ts: String(j.ts || j.timestamp || ''), id: String(j.id || j.component || ''), status: String(j.status || ''), detalhe: String(j.detalhe || j.detail || '') });
        } catch (_) { /* linha parcial ou lixo: o registro do pulso é só apoio */ }
      }
    }
    return registros;
  });
  // `parado` é marca interna do container (não sai no JSON): só ele diz que podman exec não tem como funcionar.
  const naoRodando = (dep) => !!dep && dep.parado === true;

  // ── container ──────────────────────────────────────────────────────────
  const container = {
    sufixo: 'container', nome: `Container do agente ${nome}`,
    async fn() {
      if (!ag.container || !U.RX_NOME_SEGURO.test(ag.container.replace(/^dgclaw-/, ''))) {
        return R('nao_medido', 'O registro de agentes não informa o nome do container deste agente.');
      }
      const r = await exec('podman', ['inspect', '--format', 'json', ag.container], { timeout: 4500 });
      if (r.erro === 'ENOENT') return R('nao_medido', 'O comando podman não foi encontrado na máquina, então não deu para conferir o container.');
      if (r.codigo !== 0) {
        if (/no such|não existe|nao existe|not found/i.test(r.stderr)) {
          return R('quebrado', `O container ${ag.container} não existe mais na máquina.`, {
            parado: true,
            evidencia: { horario: null, codigo_saida: r.codigo, trecho: higienizar(r.stderr, 160) },
            ...conserta(`o container do agente ${nome} (${ag.container}) não existe.`, '`podman ps -a`', `dgclaw agente recriar ${slug}`),
          });
        }
        log('aviso', `Diagnóstico: podman inspect ${ag.container} falhou (código ${r.codigo}, ${r.erro || 'sem erro de sistema'}): ${higienizar(r.stderr, 300)}`);
        return R('nao_medido', `Não consegui consultar o podman (${r.erro === 'timeout' ? 'demorou demais' : `código ${r.codigo}`}).`, { evidencia: { horario: null, codigo_saida: r.codigo, trecho: higienizar(r.stderr, 160) || null } });
      }
      let info;
      try { info = JSON.parse(r.stdout); } catch (_) { info = null; }
      const c = Array.isArray(info) ? info[0] : info;
      const st = c && c.State;
      if (!st) return R('nao_medido', 'O podman respondeu num formato que o diagnóstico não entendeu.');
      const politica = (c.HostConfig && c.HostConfig.RestartPolicy && c.HostConfig.RestartPolicy.Name) || 'desconhecida';
      const comeco = Date.parse(st.StartedAt);
      const fim = Date.parse(st.FinishedAt);
      const marco = Number.isFinite(fim) && fim > 0 && st.FinishedAt && !st.FinishedAt.startsWith('0001') ? fim : (Number.isFinite(comeco) && !String(st.StartedAt).startsWith('0001') ? comeco : null);
      const trecho = `estado ${higienizar(st.Status, 20)}, código de saída ${Number.isInteger(st.ExitCode) ? st.ExitCode : 'desconhecido'}, política de reinício ${higienizar(politica, 20)}`;
      if (st.Status === 'running' && st.Running !== false) {
        const pid = Number(st.ConmonPid);
        if (Number.isInteger(pid) && pid > 0 && !procVivo(pid)) {
          return R('quebrado', 'O podman diz que o container está rodando, mas o processo que o acompanha (conmon) morreu. O container pode até estar funcionando, porém o podman perdeu o controle dele: se cair, ninguém registra nem reinicia.', {
            ultimo_sinal: U.iso(comeco), evidencia: { horario: U.iso(comeco), codigo_saida: null, trecho: 'conmon morto com o container marcado como running' },
            ...conserta(`o container do agente ${nome} aparece como rodando, mas o processo conmon dele morreu.`, '`podman ps` e `ps aux | grep conmon`', `dgclaw agente reiniciar ${slug}`),
          });
        }
        return R('ok', null, { ultimo_sinal: U.iso(comeco), evidencia: { horario: U.iso(comeco), codigo_saida: null, trecho } });
      }
      const desde = marco ? ` desde ${U.quando(marco, tz)}` : '';
      return R('quebrado', `O container está parado${desde} (${higienizar(st.Status, 20)}). Isso costuma acontecer depois que a máquina reinicia${politica === 'no' ? ' e o container não volta sozinho' : ''}.`, {
        parado: true,
        ultimo_sinal: U.iso(marco), evidencia: { horario: U.iso(marco), codigo_saida: Number.isInteger(st.ExitCode) ? st.ExitCode : null, trecho },
        ...conserta(`o container do agente ${nome} está parado (${higienizar(st.Status, 20)})${desde}.`, '`dgclaw status` e `podman ps -a`', `dgclaw agente iniciar ${slug}`),
      });
    },
  };

  // ── sessão, login, painel ───────────────────────────────────────────────
  const sessao = {
    sufixo: 'sessao', nome: `Sessão do agente ${nome}`, depende: container,
    async fn(dep) {
      const [saude, estado] = await Promise.all([saudeRunner(), estadoRunner()]);
      return analisaSessao(ag, { saude, estado }, { agoraMs: agora(), tz, contMorto: naoRodando(dep) });
    },
  };
  const login = {
    sufixo: 'login', nome: `Login do Claude do agente ${nome}`, depende: container,
    async fn(dep) {
      const [estado, provedor] = await Promise.all([estadoRunner(), provedorRunner()]);
      if (naoRodando(dep) && !(estado && estado.ok)) return R('nao_medido', 'O container está parado, então o runner não responde e não deu para conferir o login.');
      return analisaLogin(ag, { estado, provedor }, tz);
    },
  };
  const painel = {
    sufixo: 'canal.painel', nome: `Canal painel (conversa pelo navegador) - ${nome}`, depende: container,
    async fn(dep) {
      const saude = await saudeRunner();
      if (saude && saude.ok) return R('ok', null);
      if (naoRodando(dep)) return R('nao_medido', 'O container está parado, então o painel do agente não responde e não deu para conferir.');
      return R('quebrado', `A conversa pelo painel não funciona: o runner do agente ${nome} não respondeu.`, {
        evidencia: { horario: null, codigo_saida: saude && saude.status ? saude.status : null, trecho: 'runner sem resposta' },
        ...conserta(`o painel de conversa do agente ${nome} não responde (o runner dele está mudo).`, '`dgclaw status`', cmdReiniciar),
      });
    },
  };

  // ── saúde da resposta (watchdog) ────────────────────────────────────────
  const saudeResposta = {
    sufixo: 'saude_resposta', nome: `Resposta do agente ${nome} (vigia da sessão)`,
    async fn() {
      const r = lerJsonSeguro(lerArquivo, home, '.dgclaw/logs/saude.json');
      if (r.estado === 'ausente') return R('nao_medido', 'O vigia da sessão ainda não gravou nenhum resultado (o timer de vigia pode não estar instalado ou ainda não rodou).');
      if (r.estado !== 'ok') return R('nao_medido', `Não consegui ler o resultado do vigia: ${r.motivo}.`);
      const d = r.dados;
      const verificadoMs = Date.parse(d.verificadoEm);
      const desdeMs = Date.parse(d.desde);
      const tipo = typeof d.tipo === 'string' && /^[a-z_]{1,30}$/.test(d.tipo) ? d.tipo : null;
      const estado = d.estado;
      const base = { ultimo_sinal: U.iso(verificadoMs) };
      if (estado === 'ativo') {
        if (Number.isFinite(verificadoMs) && agora() - verificadoMs > 30 * 60000) {
          return R('atencao', `O vigia da sessão não confere há ${U.duracaoCurta(agora() - verificadoMs)} (última conferência ${U.quando(verificadoMs, tz)}).`, Object.assign(base, conserta(`o vigia da sessão do agente ${nome} não confere desde ${U.quando(verificadoMs, tz)}.`, `\`podman exec dgclaw-${slug} systemctl status dgclaw-${slug}-watchdog.timer\``, cmdReparar)));
        }
        return R('ok', null, base);
      }
      if (estado === 'indeterminado') return R('nao_medido', 'O vigia não conseguiu avaliar a sessão na última conferência.', base);
      const [frase, acao] = FRASES_SAUDE[tipo] || [`O vigia da sessão apontou um problema${tipo ? ` do tipo "${tipo}"` : ''}.`, 'conferir a sessão'];
      const desde = Number.isFinite(desdeMs) ? ` desde ${U.quando(desdeMs, tz)}` : '';
      const nivel = estado === 'inativo' ? 'quebrado' : 'atencao';
      const extra = Object.assign(base, {
        evidencia: { horario: U.iso(Number.isFinite(desdeMs) ? desdeMs : verificadoMs), codigo_saida: null, trecho: tipo },
      });
      if (tipo === 'login') return R(nivel, `${frase}${desde ? ` Está assim${desde}.` : ''}`, Object.assign(extra, { o_que_fazer: 'Refaça o login pela conversa do agente (veja o item de login).', prompt_sugerido: null }));
      if (tipo === 'limite') return R(nivel, `${frase}${desde ? ` Está assim${desde}.` : ''}`, Object.assign(extra, { o_que_fazer: 'Espere o limite do plano renovar (o horário aparece na conversa) ou confira o plano do Claude do cliente.', prompt_sugerido: null }));
      return R(nivel, `${frase}${desde ? ` Está assim${desde}.` : ''}`, Object.assign(extra, conserta(`o vigia da sessão do agente ${nome} marcou "${tipo || 'problema'}"${desde}. Ação sugerida: ${acao}.`, `o log do vigia (\`${home ? '.dgclaw/logs/watchdog.log' : 'watchdog.log'}\` na casa do agente)`, cmdReiniciar)));
    },
  };

  // ── canais ──────────────────────────────────────────────────────────────
  const telegram = {
    sufixo: 'canal.telegram', nome: `Canal Telegram - ${nome}`,
    async fn() {
      const arq = lerJsonSeguro(lerArquivo, home, '.dgclaw/canais.json');
      if (arq.estado === 'invalido') return R('nao_medido', `Não consegui ler a configuração dos canais: ${arq.motivo}.`);
      const provedor = await provedorRunner();
      const doRunner = provedor && provedor.ok && provedor.dados.canais && typeof provedor.dados.canais.telegram === 'string' ? provedor.dados.canais.telegram : null;
      const ligadoArq = arq.estado === 'ok' ? !!(arq.dados.telegram && arq.dados.telegram.ligado === true) : false;
      if (doRunner === 'indisponivel_no_codex') return Object.assign(R('ok', null), { nome: `Canal Telegram (indisponível no Codex) - ${nome}` });
      if (!ligadoArq && doRunner !== 'ligado') {
        if (arq.estado === 'ausente' && doRunner == null) return R('nao_medido', 'Não há configuração de canais e o runner não respondeu, então não sei se o Telegram está ligado.', { nome: `Canal Telegram - ${nome}` });
        return Object.assign(R('ok', null), { nome: `Canal Telegram (desligado) - ${nome}` });
      }
      const est = lerArquivo(home, '.dgclaw/logs/channel-watchdog.state', { max: 4096 });
      const palavras = est.estado === 'ok' ? est.texto.trim().split(/\s+/) : [];
      const vigia = palavras[0] || null;
      const falhas = Number(palavras[1]);
      if (vigia === 'dead') {
        return R('quebrado', `O Telegram está ligado, mas o vigia do canal marcou que ele parou de responder${Number.isFinite(falhas) ? ` (${falhas} reinício${falhas === 1 ? '' : 's'} seguido${falhas === 1 ? '' : 's'} sem resolver)` : ''}.`, {
          evidencia: { horario: est.estado === 'ok' ? U.iso(est.mtimeMs) : null, codigo_saida: null, trecho: 'vigia do canal: dead' },
          ...conserta(`o canal do Telegram do agente ${nome} está ligado, mas o vigia do canal marcou como parado.`, '`dgclaw-agente canal status` dentro da casa do agente e o log do vigia do canal', cmdReiniciar),
        });
      }
      if (doRunner === 'desligado') {
        return R('atencao', 'O Telegram está ligado na configuração, mas a sessão em execução ainda não carregou o canal.', {
          evidencia: { horario: null, codigo_saida: null, trecho: 'configuração ligada, sessão sem o canal' },
          ...conserta(`o Telegram do agente ${nome} está ligado na configuração, mas a sessão em execução não carregou o canal.`, '`dgclaw-agente canal status`', cmdReiniciar),
        });
      }
      if (doRunner == null) return R('nao_medido', 'O Telegram está ligado na configuração, mas o runner não respondeu para confirmar que a sessão carregou o canal.');
      return R('ok', null, { ultimo_sinal: est.estado === 'ok' ? U.iso(est.mtimeMs) : null });
    },
  };

  const whatsapp = {
    sufixo: 'canal.whatsapp', nome: `Canal WhatsApp - ${nome}`, depende: container,
    async fn(dep) {
      const flag = lerArquivo(home, '.dgclaw/whatsapp/ligado', { max: 256 });
      if (flag.estado === 'invalido') return R('nao_medido', `Não consegui conferir se o WhatsApp está ligado: ${flag.motivo}.`);
      if (flag.estado === 'ausente') return Object.assign(R('ok', null), { nome: `Canal WhatsApp (desligado) - ${nome}` });
      const est = lerJsonSeguro(lerArquivo, home, '.dgclaw/whatsapp/estado.json', { max: 16384 });
      let ativo = null;
      if (naoRodando(dep)) ativo = 'container-parado';
      else {
        const r = await exec('podman', ['exec', ag.container, 'systemctl', 'is-active', 'dgclaw-whatsapp'], { timeout: 4500 });
        const palavra = r.stdout.trim().split('\n')[0];
        ativo = palavra && /^[a-z-]{3,20}$/.test(palavra) ? palavra : null;
      }
      const e = est.estado === 'ok' ? est.dados : null;
      const estadoPonte = e && typeof e.estado === 'string' && /^[a-z_]{1,30}$/.test(e.estado) ? e.estado : null;
      const desdeMs = e ? Date.parse(e.desde) : NaN;
      const sinal = { ultimo_sinal: U.iso(desdeMs) };
      const motivoPonte = e && e.motivo ? higienizar(e.motivo, 160) : null;
      if (ativo === 'container-parado') return R('nao_medido', PARADO);
      if (ativo === null) return R('nao_medido', 'Não consegui perguntar ao container se a ponte do WhatsApp está de pé.');
      if (ativo !== 'active') {
        return R('quebrado', `O WhatsApp está ligado, mas o serviço da ponte está parado (${higienizar(ativo, 20)}).`, Object.assign(sinal, {
          evidencia: { horario: U.iso(desdeMs), codigo_saida: null, trecho: `serviço ${higienizar(ativo, 20)}${estadoPonte ? `, estado da ponte ${estadoPonte}` : ''}` },
          ...conserta(`o WhatsApp do agente ${nome} está ligado, mas o serviço dgclaw-whatsapp está parado dentro do container.`, `\`podman exec dgclaw-${slug} journalctl -u dgclaw-whatsapp -n 50\``, cmdReparar),
        }));
      }
      if (!estadoPonte) return R('nao_medido', est.estado === 'ausente' ? 'A ponte do WhatsApp ainda não gravou seu estado.' : `Não consegui ler o estado da ponte: ${est.motivo || 'formato inesperado'}.`);
      const evid = { horario: U.iso(desdeMs), codigo_saida: null, trecho: `${estadoPonte}${motivoPonte ? `: ${motivoPonte}` : ''}` };
      if (estadoPonte === 'conectado') return R('ok', null, sinal);
      if (estadoPonte === 'deslogado') {
        return R('quebrado', 'O WhatsApp desconectou o aparelho do agente. É preciso parear de novo, e isso exige o celular do dono em mãos.', Object.assign(sinal, {
          evidencia: evid,
          ...conserta(`o WhatsApp do agente ${nome} foi desconectado pelo próprio WhatsApp e precisa parear de novo.`, '`dgclaw-agente canal status`', 'dgclaw-agente canal whatsapp parear'),
        }));
      }
      if (estadoPonte === 'erro') {
        return R('quebrado', `A ponte do WhatsApp está com erro${motivoPonte ? `: ${motivoPonte}` : ''}.`, Object.assign(sinal, {
          evidencia: evid,
          ...conserta(`a ponte do WhatsApp do agente ${nome} está com erro.`, `\`podman exec dgclaw-${slug} journalctl -u dgclaw-whatsapp -n 50\``, cmdReparar),
        }));
      }
      return R('atencao', `A ponte do WhatsApp está em "${estadoPonte}"${Number.isFinite(desdeMs) ? ` desde ${U.quando(desdeMs, tz)}` : ''}, sem estar conectada.`, Object.assign(sinal, {
        evidencia: evid,
        ...conserta(`a ponte do WhatsApp do agente ${nome} está em "${estadoPonte}" e não conectada.`, '`dgclaw-agente canal status`', cmdReparar),
      }));
    },
  };

  // ── rotinas ─────────────────────────────────────────────────────────────
  const rotinas = {
    sufixo: 'cron', nome: `Rotinas automáticas - ${nome}`, depende: container,
    async fn(dep) {
      if (naoRodando(dep)) return R('nao_medido', PARADO);
      const r = await conferirRotinas(ctx, ag, ledger);
      if (r.geral) return r.geral;
      return { varias: r.itens.map((i) => Object.assign({}, i, { sufixo: `cron.${i.sufixo}` })) };
    },
  };

  // ── memória ─────────────────────────────────────────────────────────────
  const injecao = {
    sufixo: 'memoria.injecao', nome: `Memória entrando na conversa - ${nome}`,
    async fn() {
      const agoraMs = agora();
      const dias = new Set([diaNoFuso(agoraMs, tz), diaNoFuso(agoraMs - DIA_MS, tz)]);
      const linhasRuins = [];
      let algum = false;
      let maisRecente = null;
      for (const arq of ['memory-recall.log', 'session-context.log']) {
        const r = lerArquivo(home, `.dgclaw/logs/${arq}`);
        if (r.estado === 'invalido') return R('nao_medido', `Não consegui ler o registro de falhas da memória (${arq}): ${r.motivo}.`);
        if (r.estado === 'ausente') continue;
        algum = true;
        maisRecente = Math.max(maisRecente || 0, r.mtimeMs);
        if (agoraMs - r.mtimeMs > DIA_MS) continue;
        for (const l of r.texto.split('\n')) {
          const m = l.match(/^\[(\d{4}-\d{2}-\d{2})/);
          if (m && !dias.has(m[1])) continue;
          if (m || RX_ERRO_LOG.test(l)) linhasRuins.push(higienizar(l, 160));
        }
      }
      if (!algum) return R('nao_medido', 'Não há registro de falhas da memória. Os ganchos só escrevem esses arquivos quando algo dá errado, então a ausência costuma ser boa notícia, mas não prova que a memória está entrando na conversa.');
      if (linhasRuins.length) {
        return R('atencao', `A injeção da memória na conversa registrou ${linhasRuins.length} falha${linhasRuins.length === 1 ? '' : 's'} nas últimas 24 horas.`, {
          ultimo_sinal: U.iso(maisRecente),
          evidencia: { horario: U.iso(maisRecente), codigo_saida: null, trecho: linhasRuins.slice(-5).join('\n') },
          ...conserta(`a memória do agente ${nome} falhou ao entrar na conversa ${linhasRuins.length} vez(es) nas últimas 24 horas.`, '`.dgclaw/logs/memory-recall.log` e `session-context.log` na casa do agente', cmdReparar),
        });
      }
      return R('ok', null, { ultimo_sinal: U.iso(maisRecente) });
    },
  };

  const workingMemory = {
    sufixo: 'memoria.working_memory', nome: `Memória de trabalho - ${nome}`,
    async fn() {
      const agoraMs = agora();
      const r = lerArquivo(home, 'working-memory.md', { max: 64 * 1024 });
      if (r.estado === 'invalido') return R('nao_medido', `Não consegui conferir a memória de trabalho: ${r.motivo}.`);
      const montagens = (await ledger()).filter((x) => x.id === 'build-wm' && /^ok/i.test(x.status));
      const hoje = diaNoFuso(agoraMs, tz);
      const horaLocal = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(agoraMs)));
      const rodouHoje = montagens.some((x) => x.ts.startsWith(hoje));
      if (r.estado === 'ausente') {
        return R('atencao', 'A memória de trabalho (working-memory.md) ainda não existe. Ela é montada pela rotina das 7h.', conserta(`o agente ${nome} está sem o arquivo working-memory.md.`, `a rotina dgclaw-${slug}-build-wm`, cmdReparar));
      }
      const evid = { horario: U.iso(r.mtimeMs), codigo_saida: null, trecho: `${r.tamanho} bytes (teto da remontagem: 9000)` };
      if (r.tamanho > TETO_WM_AVISO) {
        return R('atencao', `A memória de trabalho está com ${r.tamanho} bytes, acima do que cabe inteiro no começo da conversa (${TETO_WM_AVISO}).`, { ultimo_sinal: U.iso(r.mtimeMs), evidencia: evid, ...conserta(`a memória de trabalho do agente ${nome} passou de ${TETO_WM_AVISO} bytes.`, `a rotina dgclaw-${slug}-build-wm`, cmdReparar) });
      }
      if (horaLocal >= 8 && montagens.length > 0 && !rodouHoje) {
        return R('atencao', 'A remontagem das 7h não deixou registro hoje.', { ultimo_sinal: U.iso(r.mtimeMs), evidencia: evid, ...conserta(`a remontagem das 7h da memória de trabalho do agente ${nome} não deixou registro hoje.`, `a rotina dgclaw-${slug}-build-wm`, cmdReparar) });
      }
      if (agoraMs - r.mtimeMs > 36 * 3600 * 1000) {
        return R('atencao', `Ninguém atualiza a memória de trabalho há ${U.duracaoCurta(agoraMs - r.mtimeMs)}.`, { ultimo_sinal: U.iso(r.mtimeMs), evidencia: evid, ...conserta(`a memória de trabalho do agente ${nome} não é atualizada há mais de 36 horas.`, `a rotina dgclaw-${slug}-build-wm`, cmdReparar) });
      }
      return R('ok', null, { ultimo_sinal: U.iso(r.mtimeMs), evidencia: evid });
    },
  };

  const compactacao = {
    sufixo: 'compactacao', nome: `Compactação da conversa - ${nome}`, depende: rotinas,
    async fn(dep) {
      let r = lerJsonSeguro(lerArquivo, home, `.dgclaw/logs/.${slug}-compact-state.json`, { max: 16384 });
      if (r.estado === 'ausente') r = lerJsonSeguro(lerArquivo, home, '.dgclaw/logs/.auto-compact-state.json', { max: 16384 });
      if (r.estado === 'invalido') return R('nao_medido', `Não consegui ler o estado da compactação: ${r.motivo}.`);
      const reflexaoRuim = dep && Array.isArray(dep.varias) ? dep.varias.find((i) => i.id === `agente.${slug}.cron.reflection` && i.estado === 'quebrado') : null;
      const ultimoMs = r.estado === 'ok' ? Date.parse(r.dados.last_compact_ts) : NaN;
      const falhas = r.estado === 'ok' && Number.isInteger(r.dados.consecutive_fail) ? r.dados.consecutive_fail : 0;
      const base = { ultimo_sinal: U.iso(ultimoMs), evidencia: r.estado === 'ok' ? { horario: U.iso(ultimoMs), codigo_saida: null, trecho: `falhas seguidas: ${falhas}` } : { horario: null, codigo_saida: null, trecho: 'nunca compactou' } };
      if (falhas >= 3) {
        return R('atencao', `A compactação automática falhou ${falhas} vezes seguidas; a conversa pode crescer até travar.`, Object.assign(base, conserta(`a compactação automática do agente ${nome} falhou ${falhas} vezes seguidas.`, `a rotina dgclaw-${slug}-auto-compact`, cmdReiniciar)));
      }
      if (reflexaoRuim) {
        return R('atencao', 'A reflexão noturna está quebrada, então a memória do dia não está sendo consolidada. Veja o item da rotina de reflexão.', Object.assign(base, { o_que_fazer: `Resolva primeiro o item agente.${slug}.cron.reflection.`, prompt_sugerido: null }));
      }
      return R('ok', null, base);
    },
  };

  return [container, sessao, login, saudeResposta, painel, telegram, whatsapp, rotinas, injecao, workingMemory, compactacao];
}

module.exports = { tarefasDoAgente };
