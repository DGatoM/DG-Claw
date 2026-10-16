// socorro.js — A sessão de SOCORRO: um Claude neutro, fora do agente, que o dono chama
// quando "aconteceu alguma coisa com o meu agente, vê aí".
//
// POR QUE ELA EXISTE (Danilo, 01/10/2026). Quando o agente trava, a pessoa que tem o
// problema é justamente a que não tem a quem perguntar: o agente é quem ela consultaria,
// e ele está mudo. Esta aba dá a ela um técnico de plantão que lê os registros, explica
// em português o que houve e propõe o conserto, sem ser o agente e sem carregar a
// conversa dele (que pode ser exatamente o que o trava).
//
// COMO CADA MENSAGEM RODA. Um `claude -p` por mensagem: a primeira abre a sessão e as
// seguintes continuam com `--resume <id>`. Quatro escolhas que não são detalhe:
//
//   --safe-mode   desliga CLAUDE.md, hooks, plugins e MCP. Sem ele, um Claude aberto na
//                 casa do agente leria o CLAUDE.md DO AGENTE e viraria o agente, e os
//                 hooks do DG Claw gravariam a conversa de socorro no fio do agente
//                 (chat-tail.md). Neutro quer dizer isto.
//   cwd = <ws>/.dgclaw/socorro/sala, e NÃO a casa do agente. O Claude grava o transcript
//                 da sessão numa pasta derivada do cwd, e na pasta do agente ele se
//                 misturaria com os transcripts que o watchdog, o injetor e o contador de
//                 custo leem. A casa do agente entra por `--add-dir` e pelo prompt.
//   ferramentas   só Read, Grep, Glob e Bash (`--tools`), liberadas sem pergunta
//                 (`--allowedTools`), e qualquer outra coisa que pedisse permissão é
//                 NEGADA (`--permission-prompts none`), porque aqui não há terminal para
//                 alguém responder. O freio das ações que MUDAM algo é a regra do prompt:
//                 perguntar ao dono e esperar o "sim" na mensagem seguinte.
//   modelo        sonnet por padrão (`socorroModelo` no config.json troca).
//
// ELA RODA COM O USUÁRIO DO PAINEL, na conta Claude dessa máquina. Num agente da jaula é
// o usuário do agente; numa instalação clássica costuma ser root. Isso está escrito em
// panel/docs/SOCORRO.md, porque é o tipo de coisa que quem instala precisa saber.
//
// É EFÊMERA. A tela mostra só a sessão atual; "encerrar" esquece o id e a próxima
// mensagem começa do zero. O que foi dito fica em <ws>/.dgclaw/socorro/<data>.jsonl só
// como histórico, para quem cuida do sistema conferir depois.
//
// DESLIGÁVEL: `"socorro": false` no config.json do painel.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acharLibDir } = require('./conversa');
const { caminhoDoToken } = require('./runner-token');

const TETO_EVENTOS = 600;
const TETO_TEXTO = 8000;

function acharClaude(CONFIG) {
  const candidatos = [CONFIG.claudeBin, process.env.DGCLAW_CLAUDE_BIN, process.env.CLAUDE_BIN].filter(Boolean);
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) candidatos.push(path.join(d, 'claude'));
  candidatos.push(path.join(os.homedir(), '.local', 'bin', 'claude'));
  for (const c of candidatos) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* candidato seguinte; quem nao achar nenhum diz isso na tela */ }
  }
  return null;
}

/** O que a ferramenta fez, em uma linha, sem despejar o comando inteiro na tela. */
function resumoDaFerramenta(nome, entrada) {
  const e = entrada || {};
  const curto = (s, n = 140) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  if (nome === 'Bash') return `rodou um comando: ${curto(e.command)}`;
  if (nome === 'Read') return `leu o arquivo ${curto(e.file_path, 100)}`;
  if (nome === 'Grep') return `procurou "${curto(e.pattern, 60)}"${e.path ? ` em ${curto(e.path, 60)}` : ''}`;
  if (nome === 'Glob') return `listou arquivos ${curto(e.pattern, 80)}`;
  return `usou ${nome}`;
}

function buildSocorro(CONFIG, serverDir) {
  const LIGADO = CONFIG.socorro !== false;
  const MODELO = CONFIG.socorroModelo || 'sonnet';
  const TIMEOUT_MS = (Number(CONFIG.socorroTimeoutMin) || 10) * 60 * 1000;
  const WS = CONFIG.agentDir;
  const DIR = path.join(WS, '.dgclaw', 'socorro');
  const SALA = path.join(DIR, 'sala');
  const { dir: LIB } = acharLibDir(serverDir);
  const PLUGIN = LIB ? path.resolve(LIB, '..', '..') : null;
  const EMERGENCIA = PLUGIN ? path.join(PLUGIN, 'docs', 'EMERGENCIA.md') : null;
  const SKILL = PLUGIN ? path.join(PLUGIN, 'skills', 'socorro', 'SKILL.md') : null;

  let sessao = novaSessao();

  function novaSessao() {
    return { id: null, iniciadaEm: null, eventos: [], seq: 0, proc: null, encerrando: false };
  }

  function registrarNoHistorico(ev) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const dia = new Date().toISOString().slice(0, 10);
      fs.appendFileSync(path.join(DIR, `${dia}.jsonl`),
        `${JSON.stringify({ ...ev, sessao: sessao.id, agente: CONFIG.agentSlug })}\n`);
    } catch (e) {
      // O histórico é para depois. Falhar nele não pode derrubar a conversa de agora,
      // mas também não fica calado.
      console.error(`[socorro] nao consegui gravar o historico em ${DIR}: ${e.message}`);
    }
  }

  function evento(tipo, texto, extra) {
    sessao.seq += 1;
    const ev = { seq: sessao.seq, em: new Date().toISOString(), tipo, texto, ...(extra || {}) };
    sessao.eventos.push(ev);
    if (sessao.eventos.length > TETO_EVENTOS) sessao.eventos.splice(0, sessao.eventos.length - TETO_EVENTOS);
    registrarNoHistorico(ev);
    return ev;
  }

  function promptDoSistema() {
    const lib = LIB || '(scripts do plugin não encontrados)';
    const temManual = EMERGENCIA && fs.existsSync(EMERGENCIA);
    const temSkill = SKILL && fs.existsSync(SKILL);
    return [
      `Você é a SESSÃO DE SOCORRO do agente "${CONFIG.agentName || CONFIG.agentSlug}", um agente DG Claw.`,
      'Você NÃO é o agente. Você é um técnico neutro, chamado pelo dono dele '
        + `(${CONFIG.creatorName || 'o dono'}, uma pessoa leiga) porque algo parece errado com o agente.`,
      `A casa do agente (o workspace) é ${WS}. Os scripts do DG Claw estão em ${lib}.`,
      temManual
        ? `PRIMEIRO, leia o manual de emergência: ${EMERGENCIA}. Siga o que ele manda.`
        : `O manual de emergência (${EMERGENCIA || 'docs/EMERGENCIA.md'}) ainda não existe nesta instalação: diga isso ao dono uma vez e siga o roteiro abaixo.`,
      temSkill ? `Leia também a skill de socorro: ${SKILL}.` : '',
      'ONDE VOCÊ ESTÁ: se o comando `podman` não existir, você roda DENTRO do container do agente, sem root. '
        + 'A seção 0.1 do manual traduz os comandos dele para cá; o que só se resolve no servidor, você explica ao dono '
        + 'e diz que quem cuida do servidor precisa agir.',
      'ONDE OLHAR, nesta ordem: a saúde do runner com `curl -s http://127.0.0.1:4300/api/saude` (dentro do container); '
        + 'o diagnóstico do vigia em .dgclaw/logs/saude.json; '
        + `o diagnóstico de agora com \`python3 ${lib}/saude_sessao.py --json\` (as variáveis DGCLAW_* já estão no ambiente); `
        + 'a marca .dgclaw/modo-seguro.json, se existir; os registros .dgclaw/logs/runner.log, watchdog.log, reinicio.log, '
        + 'notify-owner.log e session-context.log.',
      'REGRAS, sem exceção:',
      '1. Por conta própria você só LÊ e diagnostica.',
      '2. Antes de QUALQUER ação que mude algo (reiniciar o agente, restaurar backup, editar, mover ou apagar arquivo, '
        + 'mexer em serviço, rodar comando que escreve), explique em uma frase o que vai fazer e por quê, pergunte '
        + '"posso fazer?" e PARE a resposta aí. Só execute se, na mensagem seguinte, o dono disser que sim.',
      `3. Para reiniciar (depois do sim): \`python3 ${lib}/reinicio.py normal --origem manual --json\` volta na mesma `
        + `conversa; \`python3 ${lib}/reinicio.py seguro --origem manual --json\` volta SEM a conversa anterior, que é o `
        + 'certo quando a Anthropic bloqueou uma resposta ou a conversa ficou grande demais. Login vencido não se resolve '
        + 'reiniciando: se a tela do agente tiver o botão "Entrar com a assinatura", é por ele que o dono refaz o login '
        + '(a tela mostra um link e um código); se não tiver, diga ao dono que quem cuida do sistema precisa refazer o login.',
      '4. Nunca leia nem mostre segredo: .env, credenciais, .credentials.json, config.sh, o cofre, tokens.',
      '5. Não abra a pasta .dgclaw/quarentena e nunca reenvie o conteúdo dela ao agente: é o texto que fez ele travar.',
      '6. Transcript (.jsonl) pode ter dezenas de MB: nunca leia inteiro, use tail, grep ou o saude_sessao.py.',
      '7. Fale português do Brasil simples, frases curtas, sem jargão. Termo técnico, quando inevitável, vem explicado.',
      'Feche cada resposta com: o que você acha que aconteceu, e qual o próximo passo que você sugere.',
    ].filter(Boolean).join('\n');
  }

  /** O ambiente do Claude de socorro. Item por item; a senha do painel nunca entra. */
  function ambiente() {
    const e = {};
    for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'CLAUDE_CONFIG_DIR',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
      'DGCLAW_INJECT_MODE', 'DGCLAW_SERVICE', 'DGCLAW_CHAT_ID']) {
      if (process.env[k]) e[k] = process.env[k];
    }
    e.LANG = e.LANG || 'C.UTF-8';
    e.DGCLAW_WORKSPACE = WS;
    e.DGCLAW_SLUG = CONFIG.agentSlug || 'agente';
    if (CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD) e.DGCLAW_BUNKER_CARD = CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD;
    if (CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL) e.DGCLAW_BUNKER_URL = CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL;
    if (caminhoDoToken(CONFIG)) e.RUNNER_TOKEN_FILE = caminhoDoToken(CONFIG);
    if (CONFIG.cofreUnidade && !e.DGCLAW_SERVICE) e.DGCLAW_SERVICE = CONFIG.cofreUnidade;
    return e;
  }

  function estado(desde) {
    const n = Number(desde) || 0;
    return {
      ligado: LIGADO,
      ativa: !!(sessao.id || sessao.eventos.length),
      respondendo: !!sessao.proc,
      iniciadaEm: sessao.iniciadaEm,
      modelo: MODELO,
      eventos: sessao.eventos.filter((e) => e.seq > n),
      ultimo: sessao.seq,
    };
  }

  /**
   * Manda uma mensagem. Devolve { status, corpo }. A resposta chega pela tela por
   * polling do /estado: aqui só se aceita (202) ou se recusa com o motivo.
   */
  /**
   * O CLI desta máquina conhece a flag? A jaula roda o 2.1.247, que não tem
   * `--permission-prompts`, e flag desconhecida faz o claude sair na hora: a aba
   * ficaria muda em todo agente de cliente. Sem ela o resultado é o mesmo, porque
   * no `-p` o que pediria permissão já é negado. Pergunta uma vez por binário.
   */
  const _flags = new Map();
  function conheceFlag(bin, flag) {
    const chave = `${bin} ${flag}`;
    if (!_flags.has(chave)) {
      let ajuda = '';
      try {
        const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 15000, env: ambiente() });
        ajuda = `${r.stdout || ''}${r.stderr || ''}`;
      } catch (e) {
        console.error(`[socorro] nao consegui rodar ${bin} --help (${e.message}); sigo sem ${flag}`);
      }
      _flags.set(chave, ajuda.includes(flag));
    }
    return _flags.get(chave);
  }

  function mensagem(texto) {
    if (!LIGADO) {
      return { status: 403, corpo: { error: 'A sessão de socorro está desligada neste painel.',
        howToFix: 'Quem cuida do sistema liga de volta tirando "socorro": false do config.json do painel.' } };
    }
    const limpo = String(texto || '').trim();
    if (!limpo) return { status: 400, corpo: { error: 'A mensagem veio vazia.', howToFix: 'Escreva o que está acontecendo e envie.' } };
    if (limpo.length > TETO_TEXTO) {
      return { status: 413, corpo: { error: `A mensagem passou de ${TETO_TEXTO} caracteres.`,
        howToFix: 'Resuma o que está acontecendo. Se precisar mostrar um registro grande, diga onde ele está e o socorro lê sozinho.' } };
    }
    if (sessao.proc) {
      return { status: 409, corpo: { error: 'O socorro ainda está respondendo a mensagem anterior.',
        howToFix: 'Espere a resposta terminar e mande de novo.' } };
    }
    const bin = acharClaude(CONFIG);
    if (!bin) {
      console.error('[socorro] nao achei o binario do claude (claudeBin no config.json, DGCLAW_CLAUDE_BIN, PATH, ~/.local/bin)');
      return { status: 503, corpo: { error: 'Esta máquina não tem o Claude instalado onde o painel procura, então o socorro não tem como responder.',
        howToFix: 'Quem cuida do sistema aponta "claudeBin" no config.json do painel para o caminho do claude.' } };
    }
    try {
      fs.mkdirSync(SALA, { recursive: true });
    } catch (e) {
      console.error(`[socorro] nao consegui criar a sala ${SALA}: ${e.message}`);
      return { status: 500, corpo: { error: 'Não consegui preparar a pasta do socorro.',
        howToFix: 'Avise quem cuida do sistema: a pasta .dgclaw do agente não está gravável por este painel.' } };
    }

    const args = ['-p', limpo, '--output-format', 'stream-json', '--verbose', '--model', MODELO,
      '--safe-mode', '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', 'Read,Grep,Glob,Bash',
      ...(conheceFlag(bin, '--permission-prompts') ? ['--permission-prompts', 'none'] : []),
      '--append-system-prompt', promptDoSistema(), '--add-dir', WS];
    if (sessao.id) args.push('--resume', sessao.id);
    if (!sessao.iniciadaEm) sessao.iniciadaEm = new Date().toISOString();
    evento('voce', limpo);

    const minha = sessao; // se "encerrar" trocar a sessão no meio, os eventos tardios não vazam para a nova
    let proc;
    try {
      proc = spawn(bin, args, { cwd: SALA, env: ambiente(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      evento('erro', `Não consegui abrir o Claude de socorro: ${e.message}`);
      return { status: 500, corpo: { error: `Não consegui abrir o socorro: ${e.message}` } };
    }
    minha.proc = proc;
    let resto = '';
    let stderr = '';
    let terminou = false;
    const relogio = setTimeout(() => {
      if (minha.proc === proc) {
        evento('erro', `A resposta passou de ${TIMEOUT_MS / 60000} minutos e eu interrompi. Mande de novo, de preferência com um pedido menor.`);
        proc.kill('SIGTERM');
      }
    }, TIMEOUT_MS);

    const tratarLinha = (linha) => {
      if (!linha.trim() || minha !== sessao) return;
      let o;
      try { o = JSON.parse(linha); } catch { return; } // linha que não é JSON é ruído do CLI
      if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
        minha.id = o.session_id;
      } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (b.type === 'text' && b.text && b.text.trim()) evento('socorro', b.text.trim());
          else if (b.type === 'tool_use') evento('ferramenta', resumoDaFerramenta(b.name, b.input), { ferramenta: b.name });
        }
      } else if (o.type === 'result') {
        terminou = true;
        if (o.session_id) minha.id = o.session_id;
        if (o.is_error) {
          evento('erro', `O socorro terminou com erro: ${String(o.result || o.subtype || 'sem detalhe').slice(0, 300)}`);
        }
        evento('fim', '', { custoUsd: o.total_cost_usd ?? null, duracaoMs: o.duration_ms ?? null });
      }
    };
    proc.stdout.on('data', (d) => {
      resto += d.toString('utf8');
      const linhas = resto.split('\n');
      resto = linhas.pop();
      linhas.forEach(tratarLinha);
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    proc.on('error', (e) => {
      console.error(`[socorro] o claude nao rodou (${bin}): ${e.message}`);
      if (minha === sessao) evento('erro', `O Claude de socorro não rodou: ${e.message}`);
    });
    proc.on('close', (code) => {
      clearTimeout(relogio);
      if (resto) tratarLinha(resto);
      if (minha.proc === proc) minha.proc = null;
      if (minha !== sessao || minha.encerrando) return;
      if (!terminou) {
        const motivo = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `saiu com código ${code}`;
        console.error(`[socorro] o claude saiu ${code} sem resultado: ${motivo}`);
        const login = /login|auth|credential|401/i.test(motivo);
        evento('erro', login
          ? 'O socorro não conseguiu entrar na conta Claude desta máquina (login vencido ou ausente). Quem cuida do sistema precisa refazer o login.'
          : `O socorro parou sem responder: ${motivo}`);
      }
    });
    return { status: 202, corpo: { aceito: true, seq: sessao.seq } };
  }

  function encerrar() {
    const antiga = sessao;
    antiga.encerrando = true;
    if (antiga.proc) {
      try { antiga.proc.kill('SIGTERM'); } catch (e) { console.error(`[socorro] nao consegui parar o claude: ${e.message}`); }
    }
    if (antiga.id || antiga.eventos.length) registrarNoHistorico({ seq: antiga.seq + 1, em: new Date().toISOString(), tipo: 'encerrada', texto: '' });
    sessao = novaSessao();
    return { encerrada: true };
  }

  return { estado, mensagem, encerrar, LIGADO, _prompt: promptDoSistema };
}

module.exports = { buildSocorro, resumoDaFerramenta };
