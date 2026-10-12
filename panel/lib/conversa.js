// conversa.js — A conversa do dono com o agente, para a aba Conversa do painel.
//
// A REGRA QUE MANDA AQUI: a conversa tem UMA FONTE SÓ, que é o transcript da sessão
// viva (o .jsonl do Claude Code). Não existe banco de mensagens do painel, e isso é
// decisão de desenho, não economia. Duas consequências que valem o texto:
//
//   1. O Telegram e o painel aparecem na MESMA lista, em ordem, sem sincronizar nada.
//      Os dois caem na mesma sessão, então ler o transcript uma vez já devolve tudo.
//      Quem nunca plugou um bot vê só o painel; plugar depois não perde nem duplica
//      nada, porque a fonte sempre foi a mesma.
//   2. Não há dado para migrar, e não há duas verdades para divergirem. Uma tabela
//      paralela seria uma segunda versão da conversa, que um dia discorda da primeira.
//
// Quem sabe ONDE a sessão está e COMO se fala com ela é o `_lib/inject.py` (ele
// conhece os três mundos: card do Bunker, sessão --channels com TIOCSTI e tmux). Quem
// sabe LER o transcript é o `_lib/thread_log.py`. Este módulo não reimplementa nenhum
// dos dois: ele os chama. Assim o painel, os crons de vida e os self-crons da persona
// enxergam exatamente a mesma sessão, e um conserto vale para os três.
//
// Precedente em produção: o `dg-telegram` (Flask :4045) serve a thread da Isa assim
// desde 01/08/2026.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cabecalhoDoRunner, caminhoDoToken } = require('./runner-token');

/** Teto de mensagens devolvidas de uma vez. Acima disso é histórico, não conversa. */
const TETO_MENSAGENS = 400;
// (Havia aqui um CACHE_MS de 1,5 s. Saiu em 01/10/2026: o cache da conversa vale
// pela assinatura do arquivo, sem prazo. Ver o comentário dentro de mensagens().)

/**
 * Onde estão o `inject.py` e o `thread_log.py`.
 *
 * As duas árvores em que o painel roda NÃO põem os scripts no mesmo lugar, e essa
 * diferença custou caro em 10/08/2026:
 *
 *   plugin, rodando de dentro do repo:  <plugin>/panel/  →  ../scripts/_lib
 *   agente instalado pelo instalador:   <ws>/.dgclaw/panel/  →  o plugin fica ao
 *                                       LADO, em <ws>/.dgclaw/plugin/, porque o
 *                                       install-panel-service.sh copia só o painel
 *
 * Enquanto só o primeiro caso era considerado, o painel de um agente em produção
 * procurava `inject.py` numa pasta que não existe. E o sintoma era pior que o
 * defeito: como um script que não existe faz o `execFile` falhar igual a um script
 * que não achou nada, a tela dizia "ainda não achei o diário desta sessão" e a
 * pessoa lia uma explicação plausível e errada, sobre um transcript de 111 KB que
 * estava ali no disco o tempo todo.
 *
 * Por isso agora se PROCURA, em ordem, e se registra o que foi encontrado. Quem
 * monta a árvore de outro jeito continua tendo a saída pelo `DGCLAW_LIB_DIR`.
 */
function acharLibDir(serverDir) {
  const candidatos = [
    process.env.DGCLAW_LIB_DIR,
    path.resolve(serverDir, '..', 'plugin', 'scripts', '_lib'),
    path.resolve(serverDir, '..', 'scripts', '_lib'),
  ].filter(Boolean);
  for (const dir of candidatos) {
    if (fs.existsSync(path.join(dir, 'inject.py'))) return { dir, candidatos };
  }
  return { dir: null, candidatos };
}

function buildConversa(CONFIG, serverDir) {
  const { dir: libDir, candidatos } = acharLibDir(serverDir);
  if (!libDir) {
    // Grita uma vez, no boot, dizendo onde procurou. Silêncio aqui é o que
    // transformou um caminho errado numa mensagem de tela que mentia.
    console.error(
      '[painel] NAO ACHEI o inject.py, entao a aba Conversa nao vai conseguir ler nem escrever.\n' +
      '         Procurei em:\n' + candidatos.map((c) => `           - ${c}\n`).join('') +
      '         O que fazer: aponte DGCLAW_LIB_DIR para a pasta scripts/_lib do plugin DG Claw.',
    );
  }
  const INJECT = libDir ? path.join(libDir, 'inject.py') : null;
  const THREAD_LOG = libDir ? path.join(libDir, 'thread_log.py') : null;

  const SLUG = CONFIG.agentSlug || 'agente';
  /** O id da conversa no envelope. Sem ele o agente não sabe para onde responder. */
  const CHAT = process.env.DGCLAW_CHAT_ID || CONFIG.chat || `c_${SLUG}`;
  /** Como o agente vê quem escreveu. O painel tem uma senha só, então é o dono. */
  const DONO = CONFIG.creatorName || process.env.DGCLAW_OWNER || 'Dono';

  /**
   * O ambiente dos scripts. Montado À MÃO, item por item, em vez de repassar o
   * `process.env` inteiro: numa sessão que roda dentro de um card da instância de
   * administração o ambiente traz `SERVER_PORT=4201`, e herdar isso em silêncio
   * mandaria o recado para o painel errado, onde o card nem existe.
   */
  function ambiente() {
    const e = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || 'C.UTF-8',
      PYTHONIOENCODING: 'utf-8',
      TZ: process.env.TZ || 'America/Sao_Paulo',
      DGCLAW_SLUG: SLUG,
      DGCLAW_WORKSPACE: CONFIG.agentDir,
      DGCLAW_OWNER: DONO,
    };
    const opcionais = {
      DGCLAW_BUNKER_CARD: CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD,
      DGCLAW_BUNKER_URL: CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL,
      RUNNER_TOKEN_FILE: caminhoDoToken(CONFIG),
      DGCLAW_CHANNEL_NAME: process.env.DGCLAW_CHANNEL_NAME,
      DGCLAW_SESSION_DIR: process.env.DGCLAW_SESSION_DIR,
      DGCLAW_INJECT_MODE: process.env.DGCLAW_INJECT_MODE,
    };
    for (const [k, v] of Object.entries(opcionais)) if (v) e[k] = String(v);
    return e;
  }

  /** Roda um dos scripts e devolve {ok, code, stdout, stderr}. Nunca lança. */
  function rodar(script, args, timeout = 20000) {
    // Sem os scripts não há o que rodar, e a falha precisa dizer ISSO, e não se
    // disfarçar de "não achei nada". Ver o cabeçalho de acharLibDir().
    if (!script) {
      return Promise.resolve({
        ok: false,
        code: 127,
        stdout: '',
        stderr: 'faltando: nao achei o inject.py/thread_log.py do plugin DG Claw (veja o erro no log do painel)',
      });
    }
    return new Promise((resolve) => {
      execFile(
        'python3', [script, ...args],
        { env: ambiente(), timeout, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
          resolve({
            ok: code === 0,
            code,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
          });
        },
      );
    });
  }

  // ── onde a conversa está gravada ───────────────────────────────────────────
  // O caminho muda quando a sessão é retomada (o `/resume` dentro do TUI faz o
  // Claude gravar sob outro uuid), então isto não pode virar constante de boot.

  let _transcript = { caminho: null, em: 0 };

  async function transcript() {
    if (_transcript.caminho && Date.now() - _transcript.em < 10000) {
      return _transcript.caminho;
    }
    const r = await rodar(INJECT, ['--slug', SLUG, '--transcript'], 15000);
    const caminho = r.ok ? r.stdout.trim() : null;
    _transcript = { caminho: caminho || null, em: Date.now() };
    return _transcript.caminho;
  }

  // ── o estado ao vivo ───────────────────────────────────────────────────────

  /**
   * O estado do card virado frase de gente, no mesmo espírito do `estadoHumano` da
   * plataforma: a frase diz o que está acontecendo E o que a pessoa faz a respeito
   * (quase sempre, nada). "erro" não vira "erro", porque numa tela de quem não é
   * técnico isso só produz uma pergunta que essa pessoa não tem como responder.
   *
   * `trabalhando` é o que acende o sinal de vida. Ele é DERIVADO do estado, nunca
   * de um palpite de tempo: um agente calado há dez minutos pode estar compilando.
   */
  const ESTADOS = {
    spawning: { chave: 'acordando', frase: 'Acordando, só um instante.', escreve: true, trabalhando: true },
    working: { chave: 'trabalhando', frase: 'está trabalhando nisso agora', escreve: true, trabalhando: true },
    waiting_input: {
      chave: 'autorizacao',
      frase: 'parou para pedir uma autorização a quem cuida do sistema',
      escreve: true, trabalhando: true,
    },
    idle: { chave: 'pronto', frase: 'pronta para o que você precisar', escreve: true, trabalhando: false },
    completed: { chave: 'pronto', frase: 'pronta para o que você precisar', escreve: true, trabalhando: false },
  };
  const FORA = {
    chave: 'fora',
    frase: 'está fora do ar no momento. A sua conversa está guardada.',
    escreve: false,
    trabalhando: false,
  };

  const INTERROMPIDO = {
    chave: 'interrompido',
    frase: 'parou porque você pediu',
    escreve: true,
    trabalhando: false,
  };

  async function estado() {
    const temCard = !!cardConfigurado();
    if (temCard) {
      // Com card, o painel do Bunker já responde vivo/morto E o estado, numa
      // chamada só. Perguntar também ao `--check` seria gastar um subprocesso de
      // python por poll para saber o que já veio.
      const { alcancou, status: bruto, motivo, explicacao } = await estadoDoCard();
      // Não alcancei a plataforma: o agente pode até estar de pé, eu é que não
      // consigo ver. Dizer "ele caiu" aqui seria afirmar o que não foi medido, e
      // oferecer o botão de acordar seria oferecer uma porta que não abre.
      if (!alcancou) {
        return {
          ...FORA,
          viva: false,
          frase:
            'não está respondendo à plataforma agora, então não consigo ver como ele está. ' +
            'A sua conversa está guardada.',
        };
      }
      const mapeado = ESTADOS[bruto];
      // Card alcançado e num estado que não é de sessão viva: aqui sim ele está
      // fora do ar, e aqui sim há o que fazer.
      if (!mapeado) {
        return {
          ...FORA,
          viva: false,
          cardStatus: bruto,
          motivo,
          // A frase do runner explica O QUE FAZER, e quase sempre é coisa de quem
          // administra, não da dona do agente. Ela vai junto para a tela poder
          // mostrar "está fora do ar" para ela e o detalhe para quem cuida, em vez
          // de deixar os dois no escuro.
          explicacao,
          podeReativar: RETOMAVEIS.has(bruto),
        };
      }
      // A correção do "trabalhando eterno": ver o comentário de foiInterrompido().
      if (mapeado.trabalhando && (await foiInterrompido())) {
        return { ...INTERROMPIDO, viva: true };
      }
      return { ...mapeado, viva: true };
    }
    const r = await rodar(INJECT, ['--slug', SLUG, '--check'], 15000);
    if (!r.ok) return { ...FORA, viva: false };
    // Sessão viva num modo que não publica estado: o honesto é dizer que está de pé
    // sem afirmar o que ela está fazendo. Não medido nunca vira "ociosa".
    if (await foiInterrompido()) return { ...INTERROMPIDO, viva: true };
    return { chave: 'viva', frase: 'está de pé', escreve: true, trabalhando: null, viva: true };
  }

  /**
   * O turno terminou porque alguém apertou o freio?
   *
   * Existe por um defeito real, medido em 10/08/2026: o ESC interrompe o turno de
   * verdade, mas NÃO dispara o hook `Stop`, então o card do Bunker fica marcado como
   * "trabalhando" para sempre. Sem isto, apertar "parar" produziria exatamente o
   * spinner eterno que esta fase existe para matar, e o vigia do Bunker ainda abriria
   * um escalonamento de "travado" que é falso.
   *
   * O sinal usado NÃO é palpite de tempo: é o `[Request interrupted by user]` que o
   * próprio Claude Code grava no transcript, que é a fonte da verdade da conversa.
   * Serve também para quem apertou ESC pelo terminal, não só pelo botão da tela.
   *
   * O conserto definitivo é no `bunker-server` (mapear o evento para o status), mexe
   * no processo que hospeda todos os cards e por isso exige restart combinado.
   */
  const MARCA_INTERRUPCAO = '[Request interrupted';

  async function foiInterrompido() {
    const caminho = await transcript();
    if (!caminho) return false;
    let ultimo = null;
    for (const linha of tailLinhas(caminho, 64 * 1024).slice(-80)) {
      let o;
      try {
        o = JSON.parse(linha);
      } catch {
        continue; // linha truncada (o transcript está sendo escrito agora)
      }
      if (o && (o.type === 'user' || o.type === 'assistant')) ultimo = o;
    }
    if (!ultimo || ultimo.type !== 'user') return false;
    const c = ultimo.message && ultimo.message.content;
    const texto =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
          : '';
    return texto.trimStart().startsWith(MARCA_INTERRUPCAO);
  }

  /**
   * As últimas linhas do arquivo sem ler o arquivo inteiro. Um transcript de sessão
   * longa passa dos 50 MB, e isto roda a cada poll da tela.
   */
  function tailLinhas(caminho, bytes) {
    let fd;
    try {
      const st = fs.statSync(caminho);
      const inicio = Math.max(0, st.size - bytes);
      const buf = Buffer.alloc(Math.min(bytes, st.size));
      fd = fs.openSync(caminho, 'r');
      fs.readSync(fd, buf, 0, buf.length, inicio);
      const linhas = buf.toString('utf8').split('\n');
      // A primeira pode ter sido cortada no meio quando não começamos do byte zero.
      if (inicio > 0) linhas.shift();
      return linhas.filter((l) => l.trim());
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* já fechado */ }
      }
    }
  }

  /**
   * ONDE MORA QUEM SABE TRANSCREVER, que NAO e onde mora a sessao do agente.
   *
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║  O DITADO E UM SERVICO, NAO UMA OPERACAO DA SESSAO.                  ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   *
   * O bug que criou esta funcao (26/08/2026): o gravador ligava, a pessoa
   * falava, e a tela dizia que nao conseguiu transcrever. Motivo: a transcricao
   * ia para `bunkerUrl`, que e o mesmo endereco usado para digitar na sessao. Em
   * agente de card isso funciona por acidente, porque os dois moram no Bunker.
   * Quando dois agentes sairam para runner proprio, o `bunkerUrl` passou a
   * apontar para a porta do runner (4311/4312) e o ditado foi junto. So que o
   * runner e dono do processo `claude` e nada mais: ele NAO tem rota de
   * transcricao, e devolvia 404 para todo audio.
   *
   * Digitar na sessao tem que ir para onde a sessao esta. Transcrever tem que ir
   * para onde esta a chave do Scribe, que e o Bunker, e que nem olha o id do
   * agente nessa rota. Sao dois enderecos porque sao duas perguntas, e junta-las
   * de novo quebra o ditado no dia seguinte a qualquer agente mudar de casa.
   */
  function transcricaoConfigurada() {
    const base = (
      CONFIG.transcricaoUrl ||
      process.env.DGCLAW_TRANSCRICAO_URL ||
      process.env.DGCLAW_BUNKER_API ||
      'http://127.0.0.1:4001'
    ).replace(/\/+$/, '');
    // O id vai na URL porque a rota tem esse formato, mas o Bunker NAO o usa
    // para transcrever: audio entra, texto sai. Por isso um agente que nao e
    // card do Bunker continua conseguindo ditar.
    const card = CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD || CONFIG.agentSlug || 'painel';
    return { base, card };
  }

  /** O card e a plataforma que o hospeda, do jeito que este painel os conhece. */
  function cardConfigurado() {
    const card = CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD;
    if (!card) return null;
    const base = (CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL || 'http://127.0.0.1:4001')
      .replace(/\/+$/, '');
    return { card, base };
  }

  /**
   * O status cru do card. Devolve {alcancou, status}, e NÃO um status solto.
   *
   * A diferença importa porque as duas falhas produziam o mesmo `null` e viravam a
   * mesma frase na tela: "a plataforma não respondeu" e "o terminal dele morreu" são
   * coisas opostas. A primeira não tem nada que a dona do agente possa fazer; a
   * segunda tem exatamente uma coisa, que é acordá-lo. Sem separar as duas, o botão
   * de acordar apareceria justamente quando não há ninguém para ouvi-lo.
   */
  async function estadoDoCard() {
    const alvo = cardConfigurado();
    if (!alvo) return { alcancou: false, status: null };
    try {
      const r = await fetch(`${alvo.base}/api/agents/${encodeURIComponent(alvo.card)}`, {
        headers: cabecalhoDoRunner(CONFIG),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { alcancou: false, status: null };
      const corpo = await r.json();
      if (!corpo || !corpo.success || !corpo.data) return { alcancou: false, status: null };
      // `motivo` e `explicacao` são ADICIONAIS: quem já consome {alcancou, status}
      // continua igual. Vêm juntos porque, quando o card está num estado ruim, quem
      // sabe o PORQUÊ é o runner, e a frase dele já vem escrita para uma pessoa ler
      // (ex.: "ainda não fez login: ... o que fazer: abrir um terminal e rodar
      // claude"). Reescrever isso aqui seria inventar uma segunda versão do motivo,
      // que envelhece separado da primeira.
      return {
        alcancou: true,
        status: corpo.data.status || null,
        motivo: corpo.data.statusReason || null,
        explicacao: corpo.data.error || null,
      };
    } catch {
      return { alcancou: false, status: null };
    }
  }

  /**
   * Estados de card em que a sessão está morta MAS dá para retomar de onde parou.
   * A mesma lista que o reanimador do Bunker usa; um card assim volta com `--resume`,
   * quer dizer, com a conversa inteira na cabeça.
   */
  const RETOMAVEIS = new Set(['resumable', 'stopped', 'errored']);

  // ── ler a conversa ─────────────────────────────────────────────────────────

  let _cache = { chave: '', em: 0, mensagens: [] };

  /**
   * A conversa inteira que a pessoa viu, das duas origens. Cacheada pela assinatura
   * do arquivo (tamanho + mtime): a tela pergunta de poucos em poucos segundos e o
   * transcript de uma sessão longa tem dezenas de MB, então reprocessar sem nada ter
   * mudado seria queimar CPU para devolver a mesma lista.
   */
  async function mensagens({ last = 80 } = {}) {
    const caminho = await transcript();
    if (!caminho) {
      // Instalação quebrada e sessão nova são coisas DIFERENTES, e a frase precisa
      // separar as duas: dizer "é normal, ele acabou de subir" para quem tem uma
      // instalação sem os scripts manda a pessoa esperar por algo que nunca vem.
      return {
        mensagens: [],
        transcript: null,
        aviso: INJECT
          ? 'Ainda não achei o diário desta sessão. Isso é normal num agente que acabou de subir; ' +
            'se persistir, é sinal de que a sessão caiu.'
          : 'A instalação deste painel está incompleta: falta a parte que lê a conversa. ' +
            'Quem cuida do sistema precisa reinstalar o painel; o registro diz o que conferir.',
      };
    }
    let assinatura;
    try {
      const st = fs.statSync(caminho);
      assinatura = `${caminho}:${st.size}:${st.mtimeMs}:${last}`;
    } catch {
      assinatura = `${caminho}:?:${Date.now()}:${last}`;
    }
    // SÓ A ASSINATURA, SEM PRAZO (01/10/2026). Antes havia também um TTL de 1,5 s,
    // e como a tela pergunta a cada 3 s o cache NUNCA acertava: cada pergunta
    // rodava o thread_log.py, que relê o transcript inteiro (0,32 s de CPU num de
    // 20 MB, medido na vistoria de 01/10, docs/VISTORIA-2026-10-01.md 2.2). Se o
    // tamanho e o mtime do arquivo não mudaram, a conversa é a mesma: não há o que
    // expirar. O que a assinatura não cobre (a sessão trocar de arquivo) entra
    // pelo caminho, que está nela.
    if (_cache.chave === assinatura && !assinatura.includes(':?:')) {
      return { mensagens: _cache.mensagens, transcript: caminho, doCache: true };
    }

    const quantas = Math.min(Math.max(1, Number(last) || 80), TETO_MENSAGENS);
    const r = await rodar(
      THREAD_LOG,
      ['--jsonl', caminho, '--last', String(quantas), '--format', 'json'],
      25000,
    );
    if (!r.ok) {
      // Falha aqui não pode virar "conversa vazia": a pessoa acharia que perdeu tudo.
      return {
        mensagens: [],
        transcript: caminho,
        erro:
          `Não consegui reconstruir a conversa a partir de ${caminho}. ` +
          `O extrator saiu com código ${r.code}: ${(r.stderr || '').trim().slice(0, 300)}`,
      };
    }
    let eventos;
    try {
      eventos = JSON.parse(r.stdout || '[]');
    } catch (e) {
      return {
        mensagens: [],
        transcript: caminho,
        erro: `O extrator devolveu algo que não é JSON: ${(r.stdout || '').slice(0, 200)}`,
      };
    }

    const mensagens = eventos.map((e, i) => ({
      id: `${e.ts || ''}-${i}`,
      de: e.origin === 'owner' ? 'voce' : 'agente',
      // "por conta própria" é o agente falando puxado por uma rotina, não respondendo
      // a você. A tela marca isso, senão a pessoa lê como resposta a outra coisa.
      porContaPropria: e.origin === 'persona-cron',
      quem: e.who || '',
      texto: e.text || '',
      tipo: e.tipo || 'texto',
      arquivo: e.arquivo || null,
      via: e.via || 'plataforma',
      em: e.ts || '',
    }));
    _cache = { chave: assinatura, em: Date.now(), mensagens };
    return { mensagens, transcript: caminho };
  }

  // ── escrever ───────────────────────────────────────────────────────────────

  /**
   * O envelope de entrada. Formato definido em
   * `apps/agents-server/src/dgchat/envelope.ts`, que é a FONTE da verdade: o agente,
   * o hook de cobrança e o extrator dependem de ele ser exatamente este. Mudar lá
   * sem mudar aqui deixa a conversa muda, sem erro nenhum aparecer.
   */
  function montarEnvelope({ from, chat, msg, ts, text }) {
    const atributo = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();
    // Quem digitasse "</dgchat>" fecharia o envelope no meio, e o resto viraria texto
    // solto na sessão, fora de qualquer etiqueta. É o mesmo cuidado de escapar HTML.
    const corpo = String(text == null ? '' : text).replace(/<\/dgchat>/gi, '<\\/dgchat>');
    return (
      `<dgchat from="${atributo(from) || 'pessoa'}" chat="${atributo(chat)}" ` +
      `msg="${atributo(msg)}" ts="${atributo(ts)}">${corpo}</dgchat>`
    );
  }

  let _sequencia = 0;

  /**
   * Entrega a mensagem na sessão viva. Devolve {ok, motivo}.
   *
   * NÃO grava nada em lugar nenhum: a mensagem entra na conversa quando o transcript
   * a registra, que é o mesmo instante em que o agente a recebeu. É isto que impede a
   * tela de mostrar como enviada uma mensagem que ficou pelo caminho, e a pessoa
   * esperar uma resposta que nunca viria.
   */
  async function enviar(texto) {
    const limpo = String(texto || '').trim();
    if (!limpo) return { ok: false, motivo: 'A mensagem veio vazia.' };
    _sequencia += 1;
    const envelope = montarEnvelope({
      from: DONO,
      chat: CHAT,
      msg: `p${Date.now().toString(36)}${_sequencia}`,
      ts: new Date().toISOString(),
      text: limpo,
    });
    // --require-idle: no card do Bunker isto vira "enfileira e entrega quando ele
    // ficar livre", nunca "descarta". Injetar no meio de um turno perderia o texto.
    //
    // A EXCEÇÃO é o turno que acabou de ser interrompido. Ali o TUI está parado no
    // prompt, esperando alguém digitar, mas o painel do Bunker ainda acha que o card
    // trabalha (o ESC não dispara o hook `Stop`). Pedir "quando estiver ocioso" nesse
    // estado enfileira o recado para um instante que nunca chega, e a pessoa fica
    // esperando resposta de uma mensagem que o agente nunca viu. Medido em 10/08/2026,
    // logo depois de apertar o botão de parar pela primeira vez.
    const interrompido = await foiInterrompido();
    const args = interrompido
      ? ['--slug', SLUG, envelope]
      : ['--slug', SLUG, '--require-idle', envelope];
    const r = await rodar(INJECT, args, 40000);
    if (r.ok) return { ok: true };
    const detalhe = (r.stderr || '').trim().split('\n').slice(-2).join(' ');
    return {
      ok: false,
      codigo: r.code,
      motivo: detalhe || `o injetor saiu com código ${r.code}`,
    };
  }

  /** O freio: ESC na sessão, sem \r. Interrompe o turno em voo. */
  async function parar() {
    const r = await rodar(INJECT, ['--slug', SLUG, '--stop'], 20000);
    if (r.ok) return { ok: true };
    const detalhe = (r.stderr || '').trim().split('\n').slice(-2).join(' ');
    return { ok: false, codigo: r.code, motivo: detalhe || `código ${r.code}` };
  }

  /**
   * Acorda o terminal do agente: `--resume` na MESMA sessão, pelo painel do Bunker.
   *
   * É `/resume`, e nunca `/revive`. Os dois nomes se parecem e fazem coisas opostas:
   * o revive sobe uma sessão NOVA, e o agente volta sem lembrar de nada do que foi
   * conversado. Para quem fala com ele, um agente amnésico é indistinguível de um
   * agente que não presta atenção, e o botão desta tela promete continuar a
   * conversa, não recomeçá-la. Se um dia o resume não for possível (sessão sem
   * transcript no disco), o certo é dizer isso, não trocar em silêncio pelo revive.
   */
  async function reativar() {
    const alvo = cardConfigurado();
    if (!alvo) {
      return {
        ok: false,
        motivo:
          'este painel não está ligado a um card da plataforma, então não tem como acordar ' +
          'o terminal daqui. Quem cuida do sistema sobe a sessão pelo terminal.',
      };
    }
    const { alcancou, status } = await estadoDoCard();
    if (!alcancou) {
      return { ok: false, motivo: 'não consegui falar com a plataforma que hospeda o agente.' };
    }
    // Já está de pé: acordar de novo derrubaria uma sessão viva para subir outra.
    if (ESTADOS[status]) return { ok: true, jaEstavaDePe: true };
    if (!RETOMAVEIS.has(status)) {
      return { ok: false, motivo: `o card está em "${status}", que não é um estado de onde eu saiba retomar.` };
    }
    try {
      const r = await fetch(`${alvo.base}/api/agents/${encodeURIComponent(alvo.card)}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cabecalhoDoRunner(CONFIG) },
        body: '{}',
        signal: AbortSignal.timeout(30000),
      });
      const corpo = await r.json().catch(() => null);
      if (!r.ok || !corpo || corpo.success === false) {
        return {
          ok: false,
          motivo: (corpo && (corpo.error || corpo.message)) || `a plataforma respondeu ${r.status}.`,
        };
      }
      // O transcript pode mudar de caminho quando a sessão é retomada, então a
      // memória de onde ele estava não vale mais um segundo sequer.
      _transcript = { caminho: null, em: 0 };
      return { ok: true, status: corpo.data && corpo.data.status };
    } catch (e) {
      return { ok: false, motivo: `a chamada para a plataforma falhou: ${e.message}` };
    }
  }

  /**
   * Transcreve um áudio gravado no navegador e devolve o texto.
   *
   * NÃO transcreve aqui: encaminha para o `POST /api/agents/:id/transcribe` da
   * plataforma, que já fala com o ElevenLabs Scribe em pt-BR e já aplica a camada
   * de substituição de vocabulário (os nomes próprios que todo transcritor erra).
   * É o mesmo caminho que o terminal do Bunker usa, e reusá-lo tem duas
   * consequências que valem mais que a economia de código: a chave do Scribe
   * continua morando num lugar só, e uma correção de vocabulário feita lá vale
   * para quem dita aqui no mesmo instante.
   *
   * O áudio é de PASSAGEM. Nada é gravado em disco deste lado: o que fica é o
   * texto, e o texto só entra na conversa quando a pessoa aperta enviar.
   */
  async function transcrever(audio, contentType) {
    const alvo = transcricaoConfigurada();
    if (!audio || audio.length < 1024) {
      return { ok: false, motivo: 'o áudio veio vazio ou curto demais para transcrever.' };
    }
    try {
      const r = await fetch(`${alvo.base}/api/agents/${encodeURIComponent(alvo.card)}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': contentType || 'audio/webm', ...cabecalhoDoRunner(CONFIG) },
        body: audio,
        // Áudio de dois minutos leva alguns segundos no Scribe, e um ditado longo
        // é justamente o caso que esta tela existe para atender.
        signal: AbortSignal.timeout(120000),
      });
      const corpo = await r.json().catch(() => null);
      if (!r.ok || !corpo || corpo.success === false || typeof corpo.text !== 'string') {
        // UM 404 AQUI TEM UM DONO CONHECIDO, e dizer só "respondeu 404" mandaria
        // a pessoa conferir a chave do Scribe, que não é onde está o problema.
        if (r.status === 404) {
          return {
            ok: false,
            motivo:
              `não existe serviço de transcrição em ${alvo.base}. ` +
              'Esse endereço é o do agente, e quem sabe transcrever é o Bunker.',
            comoResolver:
              'Ponha `transcricaoUrl` no config.json do painel apontando para o Bunker ' +
              '(normalmente http://127.0.0.1:4001), ou defina DGCLAW_TRANSCRICAO_URL no serviço.',
          };
        }
        if (r.status === 503) {
          return {
            ok: false,
            motivo: 'o Bunker está sem transcritor configurado, então ninguém ali sabe virar áudio em texto.',
            comoResolver: 'Configure a chave do Groq Whisper ou do ElevenLabs Scribe no Bunker.',
          };
        }
        return {
          ok: false,
          motivo: (corpo && corpo.error) || `quem transcreve (${alvo.base}) respondeu ${r.status}.`,
        };
      }
      const texto = corpo.text.trim();
      // Silêncio transcrito devolve string vazia, e colar isso na caixa faria a
      // pessoa achar que o botão não funcionou. Dizer que não veio fala é a
      // informação certa: o remédio é falar mais perto do microfone.
      if (!texto) {
        return { ok: false, motivo: 'não veio fala nenhuma nesse áudio.', silencio: true };
      }
      return { ok: true, texto };
    } catch (e) {
      // O endereço entra na frase porque a falha mais comum daqui é estar
      // falando com a porta errada, e sem o endereço a pessoa não tem como ver isso.
      return { ok: false, motivo: `a transcrição falhou ao falar com ${alvo.base}: ${e.message}` };
    }
  }

  /** Diagnóstico do módulo, para o /doctor e para a tela dizer o que falta. */
  function diagnostico() {
    const faltando = [];
    if (!fs.existsSync(INJECT)) faltando.push(`não achei o injetor em ${INJECT}`);
    if (!fs.existsSync(THREAD_LOG)) faltando.push(`não achei o extrator em ${THREAD_LOG}`);
    let python = null;
    try {
      python = execFileSync('python3', ['--version'], { encoding: 'utf-8' }).trim();
    } catch {
      faltando.push('python3 não está no PATH deste serviço');
    }
    return { slug: SLUG, chat: CHAT, dono: DONO, inject: INJECT, threadLog: THREAD_LOG, python, faltando };
  }

  return { estado, mensagens, enviar, parar, reativar, transcrever, transcript, diagnostico, CHAT };
}

// acharLibDir sai junto porque o lib/saude.js procura os scripts do mesmo jeito, e
// duas buscas escritas separadas foi exatamente o defeito de 10/08/2026 (ver acima).
module.exports = { buildConversa, acharLibDir };
