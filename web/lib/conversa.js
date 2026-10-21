'use strict';
// A conversa de um agente: achar o transcript da sessão principal, montar a thread,
// calcular a atividade, enviar mensagens (envelope) e o rótulo do provedor.

const fs = require('node:fs');
const path = require('node:path');
const { paraContainer } = require('./thread');
const { criaInterceptor } = require('./token-telegram');
const { acharRollout, ehRollout, confinar } = require('./rollout');
const { motivoDoRunner } = require('./runner');
const { criarComandos } = require('./comandos');

const RX_SESSION = /^[A-Za-z0-9_-]{8,80}$/;
const TTL_RUNNER_MS = 2000;
const TTL_ROTULO_MS = 60 * 1000;
const TTL_ENVIO_MS = 60 * 60 * 1000;
const MAX_ENVIOS = 2000;
const RX_CLIENTE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ANEXOS = 10;
// Pausa entre uma tecla e outra ao responder a pergunta de escolha: a TUI redesenha a tela a cada tecla e
// uma tecla que chega antes disso se perde (conferido ao vivo no Claude Code 2.1.304).
const MAX_TEXTO_RESPOSTA = 2000;
// Controle (inclui \n, \r, \t, ESC), C1 e separadores de linha/parágrafo: nada disso vai para o terminal.
const RX_CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Quantos transcripts de sessões um agente do Claude junta na conversa. Cada reinício do runner abre
// uma sessão nova (um .jsonl novo); agente antigo pode ter centenas e ler tudo travaria o servidor.
// Vale os mais recentes por mtime; o da sessão atual sempre entra, mesmo que seja mais velho que o corte.
const MAX_SESSOES_NA_THREAD = 40;

/**
 * O envelope de entrada. Mesmo formato do panel/lib/conversa.js (montarEnvelope):
 * o agente, o hook de cobrança e o extrator de thread dependem de ele ser exatamente este.
 * `voz: true` acrescenta voz="1" no fim dos atributos: a resposta vai ser OUVIDA (ver docs/CONVERSA.md).
 * Os leitores pegam from/chat/msg/ts por nome, então o atributo extra passa sem efeito.
 */
function montarEnvelope({ from, chat, msg, ts, text, voz }) {
  const atributo = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();
  // Quem digitasse "</dgchat>" fecharia o envelope no meio: escapa, como se escapa HTML.
  const corpo = String(text == null ? '' : text).replace(/<\/dgchat>/gi, '<\\/dgchat>');
  return `<dgchat from="${atributo(from) || 'pessoa'}" chat="${atributo(chat)}" msg="${atributo(msg)}" ts="${atributo(ts)}"${voz === true ? ' voz="1"' : ''}>${corpo}</dgchat>`;
}

/**
 * Confere as respostas contra as perguntas lidas do transcript. Devolve a mensagem do problema (em português,
 * dizendo o que fazer) ou null se estão válidas. Não escreve nada em lugar nenhum.
 */
function validarRespostas(perguntas, respostas) {
  if (!Array.isArray(respostas) || respostas.length !== perguntas.length) {
    return `Mande uma resposta para cada pergunta: são ${perguntas.length} e recebi ${Array.isArray(respostas) ? respostas.length : 'um valor que não é lista'}. Nada foi enviado.`;
  }
  for (let i = 0; i < perguntas.length; i++) {
    const q = perguntas[i], r = respostas[i], n = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `A resposta ${n} precisa ser um objeto com "opcao", "opcoes" ou "texto". Nada foi enviado.`;
    const campos = ['opcao', 'opcoes', 'texto'].filter((c) => r[c] !== undefined);
    if (campos.length !== 1) return `A resposta ${n} precisa ter exatamente um destes campos: "opcao", "opcoes" ou "texto". Nada foi enviado.`;
    const campo = campos[0];
    const inteiroValido = (v) => Number.isInteger(v) && v >= 1 && v <= q.opcoes.length;
    if (q.multipla) {
      if (campo === 'texto') return `A pergunta ${n} deixa marcar várias opções e não aceita texto livre por aqui. Responda pelo terminal, na aba Sessões. Nada foi enviado.`;
      if (campo === 'opcao') return `A pergunta ${n} deixa marcar várias opções: use "opcoes" (lista de números de 1 a ${q.opcoes.length}). Nada foi enviado.`;
      if (!Array.isArray(r.opcoes) || !r.opcoes.length) return `A resposta ${n} precisa de "opcoes" com pelo menos um número de 1 a ${q.opcoes.length}. Nada foi enviado.`;
      if (!r.opcoes.every(inteiroValido)) return `A resposta ${n} tem opção fora do intervalo: use números inteiros de 1 a ${q.opcoes.length}. Nada foi enviado.`;
      if (new Set(r.opcoes).size !== r.opcoes.length) return `A resposta ${n} repete uma opção: cada número pode aparecer uma vez só. Nada foi enviado.`;
    } else if (campo === 'opcoes') {
      return `A pergunta ${n} aceita uma escolha só: use "opcao" (número de 1 a ${q.opcoes.length}) ou "texto". Nada foi enviado.`;
    } else if (campo === 'opcao') {
      if (!inteiroValido(r.opcao)) return `A resposta ${n} tem "opcao" fora do intervalo: use um número inteiro de 1 a ${q.opcoes.length}. Nada foi enviado.`;
    } else {
      if (typeof r.texto !== 'string' || !r.texto.trim()) return `A resposta ${n} tem "texto" vazio. Escreva a resposta ou escolha uma opção. Nada foi enviado.`;
      if (r.texto.length > MAX_TEXTO_RESPOSTA) return `A resposta ${n} tem ${r.texto.length} caracteres; o limite é ${MAX_TEXTO_RESPOSTA}. Encurte o texto. Nada foi enviado.`;
      if (RX_CONTROLE.test(r.texto)) return `A resposta ${n} tem quebra de linha ou caractere de controle. Escreva em uma linha só. Nada foi enviado.`;
    }
  }
  return null;
}

/**
 * As teclas, em ordem, que respondem às perguntas na TUI do Claude Code (protocolo conferido ao vivo na 2.1.304):
 * escolha única = o dígito da opção; texto livre = o dígito "Type something" (opções+1), o texto e \r; várias
 * escolhas = um dígito por opção marcada e \t para avançar. Com mais de uma pergunta, ou com a última de
 * múltipla escolha, a TUI mostra "Review your answers" e o `1` envia. Cada item é uma escrita separada.
 * Supõe respostas já validadas por validarRespostas.
 */
function teclasDaResposta(perguntas, respostas) {
  const teclas = [];
  perguntas.forEach((q, i) => {
    const r = respostas[i];
    if (q.multipla) {
      for (const n of r.opcoes) teclas.push(String(n));
      teclas.push('\t');
    } else if (r.texto !== undefined) {
      teclas.push(String(q.opcoes.length + 1), r.texto, '\r');
    } else {
      teclas.push(String(r.opcao));
    }
  });
  if (perguntas.length > 1 || perguntas[perguntas.length - 1].multipla) teclas.push('1');
  return teclas;
}

function criarConversa({ config, runner, leitor, leitorRollout, midia, log, agora, gravaToken, alertas, comandos: comandosInjetado }) {
  const comandos = comandosInjetado || criarComandos({ runner, log, agora });
  const alertasVersao = new Map();
  const juntadas = new Map();       // slug -> { chave, partes, msgs, versao }: a thread juntada da última leitura
  const tokenTelegram = criaInterceptor({ gravaToken });
  const relogio = agora || (() => Date.now());
  const estadoRunner = new Map();   // slug -> { ts, promessa, valor }
  const arquivoPorSessao = new Map(); // `${slug}|${sessionId}` -> caminho
  const rolloutPorSessao = new Map(); // `${slug}|${sessionId}` -> rollout do Codex
  const ultimoArquivo = new Map();  // slug -> caminho (para quando o runner some)
  const atividadeAnterior = new Map(); // slug -> { chave, desde }
  const rotulos = new Map();        // slug -> { ts, valor }
  const ultimas = new Map();        // slug -> { ts, valor } (epoch ms da última mensagem, ou null)
  const envios = new Map();         // chave -> { promessa, ts }
  const logUmaVez = new Map();      // chave -> último motivo

  function avisaUmaVez(chave, nivel, msg) {
    if (logUmaVez.get(chave) === msg) return;
    logUmaVez.set(chave, msg);
    log(nivel, msg);
  }
  function esquece(chave) { logUmaVez.delete(chave); }

  // ── estado do runner, com cache de 2 s e uma chamada só por vez ──────────
  function estado(agente) {
    const c = estadoRunner.get(agente.slug);
    if (c && relogio() - c.ts < TTL_RUNNER_MS) return c.promessa;
    const promessa = runner.estado(agente).then((r) => {
      if (r.ok) esquece(`runner|${agente.slug}`); else avisaUmaVez(`runner|${agente.slug}`, 'aviso', `Runner de ${agente.nome}: ${r.erro}`);
      return r;
    });
    estadoRunner.set(agente.slug, { ts: relogio(), promessa });
    return promessa;
  }

  // ── achar o .jsonl ───────────────────────────────────────────────────────
  function achaPorSessao(agente, sessionId) {
    if (!agente.transcripts_dir || !RX_SESSION.test(sessionId)) return null;
    const chave = `${agente.slug}|${sessionId}`;
    const guardado = arquivoPorSessao.get(chave);
    if (guardado && fs.existsSync(guardado)) return guardado;
    const direto = path.join(agente.transcripts_dir, `${sessionId}.jsonl`);
    if (fs.existsSync(direto)) { arquivoPorSessao.set(chave, direto); return direto; }
    let pastas = [];
    try { pastas = fs.readdirSync(agente.transcripts_dir, { withFileTypes: true }); } catch (_) { return null; }
    for (const p of pastas) {
      if (!p.isDirectory()) continue;
      const cand = path.join(agente.transcripts_dir, p.name, `${sessionId}.jsonl`);
      if (fs.existsSync(cand)) { arquivoPorSessao.set(chave, cand); return cand; }
    }
    return null;
  }

  function maisRecente(agente) {
    if (!agente.transcripts_dir) return null;
    let melhor = null; let mt = -1;
    const olha = (dir) => {
      let nomes = [];
      try { nomes = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const n of nomes) {
        if (!n.isFile() || !n.name.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(dir, n.name)); if (st.mtimeMs > mt) { mt = st.mtimeMs; melhor = path.join(dir, n.name); } } catch (_) { /* some entre o readdir e o stat */ }
      }
    };
    olha(agente.transcripts_dir);
    try {
      for (const p of fs.readdirSync(agente.transcripts_dir, { withFileTypes: true })) if (p.isDirectory()) olha(path.join(agente.transcripts_dir, p.name));
    } catch (_) { /* pasta ausente: devolve null */ }
    return melhor;
  }

  /**
   * Os transcripts de TODAS as sessões do agente (só o nível de cima de transcripts_dir: subagents/ e
   * outras subpastas não entram), do mais antigo para o mais novo, cada um confinado em transcripts_dir.
   * O `atual` (já confinado) sempre entra. Arquivo recusado vira aviso e é pulado.
   */
  function sessoesDoClaude(agente, atual, avisos) {
    const dir = agente.transcripts_dir;
    let nomes = [];
    try { nomes = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { /* sem pasta: fica só o atual */ }
    const candidatos = [];
    for (const n of nomes) {
      if (!n.name.endsWith('.jsonl') || !(n.isFile() || n.isSymbolicLink())) continue;
      const caminho = path.join(dir, n.name);
      let mtime = 0;
      try { mtime = fs.statSync(caminho).mtimeMs; } catch (_) { if (!n.isSymbolicLink()) continue; } // atalho quebrado segue: o confinar explica
      candidatos.push({ caminho, mtime });
    }
    candidatos.sort((a, b) => b.mtime - a.mtime || (a.caminho < b.caminho ? -1 : 1));
    const lista = []; const vistos = new Set();
    for (const c of candidatos.slice(0, MAX_SESSOES_NA_THREAD).reverse()) {
      const r = confinar(c.caminho, dir, 'um transcript de sessão do Claude');
      if (r.erro) {
        avisos.push(r.erro);
        avisaUmaVez(`conf|${agente.slug}|${c.caminho}`, 'aviso', `Thread de ${agente.nome}: ${r.erro} Pulei esse arquivo e segui com os outros.`);
        continue;
      }
      esquece(`conf|${agente.slug}|${c.caminho}`);
      if (!vistos.has(r.real)) { vistos.add(r.real); lista.push(r.real); }
    }
    if (!vistos.has(atual)) lista.push(atual);
    while (lista.length > MAX_SESSOES_NA_THREAD) lista.splice(lista.findIndex((a) => a !== atual), 1);
    return lista;
  }

  /** Número de 32 bits estável a partir de um texto (FNV-1a). */
  function hash32(texto) {
    let h = 0x811c9dc5;
    for (let i = 0; i < texto.length; i += 1) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }

  /** Codex: o rollout da sessão. Cache por sessão. Devolve { arquivo, procurados, erro }. */
  function achaRolloutDaSessao(agente, sessionId, codexHome) {
    const chave = `${agente.slug}|${sessionId}`;
    const guardado = rolloutPorSessao.get(chave);
    if (guardado && fs.existsSync(guardado)) return { arquivo: guardado, procurados: [] };
    const r = acharRollout(agente, sessionId, codexHome);
    if (r.arquivo) rolloutPorSessao.set(chave, r.arquivo);
    return r;
  }

  /** { msgs, versao, avisos } da thread do agente. Nunca lança: problema vira aviso. */
  async function thread(agente) {
    const avisos = [];
    const r = await estado(agente);
    let arquivo = null;
    if (r.ok && r.estado.sessionId) {
      const sid = String(r.estado.sessionId);
      const codexHome = typeof r.estado.codexHome === 'string' && r.estado.codexHome.trim() ? r.estado.codexHome.trim() : null;
      // Com codexHome o motor é o Codex. Sem ele, o transcript do Claude vem primeiro e o rollout é a segunda chance.
      if (!codexHome) arquivo = achaPorSessao(agente, sid);
      let rol = null;
      if (!arquivo) {
        rol = achaRolloutDaSessao(agente, sid, codexHome);
        arquivo = rol.arquivo;
      }
      if (!arquivo) {
        const onde = agente.transcripts_dir || '(transcripts_dir não configurado)';
        let motivo;
        if (rol && rol.erro) motivo = `Não consegui localizar o registro Codex da sessão ${sid}: ${rol.erro}`;
        else if (codexHome) motivo = `Não achei o registro Codex da sessão ${sid}. Procurei em ${rol.procurados.join(', ')}.`;
        else motivo = `Não achei o registro da sessão ${sid} em ${onde}.${rol && rol.procurados.length ? ` Também procurei o rollout do Codex em ${rol.procurados.join(', ')}.` : ''}`;
        // Agente que nunca conversou (novo, sem login) não tem registro nenhum: é o estado normal,
        // então a tela não mostra faixa. A pessoa só vê um recado sem caminho de servidor nem termo técnico;
        // o detalhe vai para o log do Web.
        if ((codexHome && rol && rol.erro) || ultimoArquivo.get(agente.slug) || maisRecente(agente)) {
          avisos.push('Não consegui abrir o histórico desta conversa agora. As mensagens novas continuam chegando, e quem cuida do sistema pode ver o motivo no log do Web.');
        }
        avisaUmaVez(`arq|${agente.slug}`, 'aviso', `Thread de ${agente.nome}: o runner diz que a sessão é ${sid}, mas ${motivo.charAt(0).toLowerCase()}${motivo.slice(1)} Confira transcripts_dir e home_host no registro de agentes.`);
      } else esquece(`arq|${agente.slug}`);
    } else if (!r.ok) {
      avisos.push(`O runner não respondeu (${r.erro}). Mostro a última conversa conhecida.`);
    }
    if (!arquivo) arquivo = ultimoArquivo.get(agente.slug) || (r.ok && !r.estado.sessionId ? maisRecente(agente) : null) || (!r.ok ? maisRecente(agente) : null);
    // incompleta: não deu para ler a conversa (há aviso e nada veio). Sem aviso, vazio é agente que nunca conversou.
    if (!arquivo) return { msgs: [], versao: 0, avisos, arquivo: null, incompleta: avisos.length > 0 };
    // Última guarda: o arquivo final, com realpath, precisa ficar dentro da raiz (atalho para fora é recusado).
    const eRollout = ehRollout(arquivo);
    {
      const raiz = eRollout ? agente.home_host : agente.transcripts_dir;
      const c = raiz ? confinar(arquivo, raiz, eRollout ? 'o registro Codex' : 'o transcript do Claude') : { erro: `Recusei ler ${arquivo}: o registro de ${agente.nome} não tem ${eRollout ? 'home_host' : 'transcripts_dir'} para conferir. Nada foi lido.` };
      if (c.erro) {
        avisos.push(c.erro);
        avisaUmaVez(`conf|${agente.slug}`, 'aviso', `Thread de ${agente.nome}: ${c.erro}`);
        ultimoArquivo.delete(agente.slug);
        return { msgs: [], versao: 0, avisos, arquivo: null, incompleta: true };
      }
      arquivo = c.real;
    }
    ultimoArquivo.set(agente.slug, arquivo);
    // Claude: a conversa é a de todas as sessões do agente. Codex: só o rollout da sessão (ver nota no relatório da mudança).
    const arquivos = eRollout ? [arquivo] : sessoesDoClaude(agente, arquivo, avisos);
    const fonte = eRollout && leitorRollout ? leitorRollout : leitor;
    const partes = []; const marcas = [];
    for (const a of arquivos) {
      try {
        const { eventos, versao } = fonte.ler(a, agente);
        partes.push(eventos);
        marcas.push(`${a}=${versao}`);
        esquece(`ler|${agente.slug}|${a}`);
      } catch (e) {
        const motivo = `Não consegui ler a conversa em ${a}: ${e.message}`;
        avisos.push(motivo);
        avisaUmaVez(`ler|${agente.slug}|${a}`, 'erro', `Thread de ${agente.nome}: ${motivo}`);
        marcas.push(`${a}=erro`);
      }
    }
    // Sem mudança em nenhum arquivo devolve a MESMA lista (compartilhados e alertas comparam por identidade).
    // A versão é um hash de "caminho=versão" de cada arquivo: muda quando qualquer um cresce ou quando a
    // lista de arquivos muda. Os consumidores (sse.js, compartilhados.js) só comparam por igualdade.
    const chaveVersao = marcas.join('|');
    let juntada = juntadas.get(agente.slug);
    if (!juntada || juntada.chave !== chaveVersao || partes.length !== juntada.partes.length || partes.some((p, i) => p !== juntada.partes[i])) {
      const vistos = new Set(); const msgs = [];
      for (const m of partes.flat().sort((a, b) => a.ep - b.ep)) {
        if (vistos.has(m.id)) continue;
        vistos.add(m.id); msgs.push(m);
      }
      juntada = { chave: chaveVersao, partes, msgs, versao: partes.length ? hash32(chaveVersao) + 1 : 0 };
      juntadas.set(agente.slug, juntada);
    }
    const { msgs, versao } = juntada;
    const assinatura = `${arquivo}|${versao}`;
    const observado = alertasVersao.get(agente.slug);
    if (alertas && (!observado || observado.assinatura !== assinatura || observado.eventos !== msgs)) {
      alertas(agente).observar(msgs);
      alertasVersao.set(agente.slug, { assinatura, eventos: msgs });
    }
    return { msgs, versao, avisos, arquivo };
  }

  /** O comando/arquivo que o agente quer rodar e ainda não rodou (sem tool_result), ou null. */
  async function pendenteDe(agente) {
    try {
      const t = await thread(agente);
      if (!t.arquivo) return null;
      const fonte = ehRollout(t.arquivo) && leitorRollout ? leitorRollout : leitor;
      return fonte.pendente ? fonte.pendente(t.arquivo, agente.slug) : null;
    } catch (e) {
      log('aviso', `Permissão de ${agente.nome}: não consegui descobrir o que ele quer fazer (${e.message}). O cartão aparece sem o detalhe.`);
      return null;
    }
  }

  /** A pergunta de escolha (AskUserQuestion) esperando resposta: { id, perguntas } ou null (Codex não tem). */
  async function perguntaDe(agente) {
    try {
      const t = await thread(agente);
      if (!t.arquivo || ehRollout(t.arquivo) || !leitor.perguntaPendente) return null;
      return leitor.perguntaPendente(t.arquivo, agente.slug);
    } catch (e) {
      log('aviso', `Pergunta de ${agente.nome}: não consegui ler a pergunta no transcript (${e.message}). A tela manda responder pelo terminal.`);
      return null;
    }
  }

  // ── atividade ────────────────────────────────────────────────────────────
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

  async function atividade(agente) {
    const r = await estado(agente);
    const agoraMs = relogio();
    let est;
    if (!r.ok) {
      est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: null, alerta: null, motivo: r.erro };
    } else {
      const e = r.estado;
      const ultimo = typeof e.updatedAt === 'number' ? iso(e.updatedAt) : null;
      if (e.status === 'working') {
        est = { estado: 'trabalhando', acao: e.currentTool || 'pensando', detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: null };
      } else if (e.status === 'waiting_input' && e.motivo === 'pergunta') {
        // Pergunta de escolha (AskUserQuestion): a tela mostra o cartão de escolhas (POST /pergunta); sem a pergunta
        // lida do transcript (`pergunta: null`), manda a pessoa para o terminal.
        const perg = await perguntaDe(agente);
        est = { estado: 'trabalhando', acao: 'esperando a sua resposta', detalhe: null, ultimo_sinal: ultimo, alerta: 'pergunta', motivo: null, pergunta: perg };
      } else if (e.status === 'waiting_input') {
        // O que ele quer fazer é o último comando do transcript que ainda não tem resultado.
        const pend = await pendenteDe(agente);
        est = { estado: 'trabalhando', acao: 'esperando permissão', detalhe: pend ? `${pend.ferramenta}: ${pend.titulo}` : null,
                ultimo_sinal: ultimo, alerta: 'permissao', motivo: null, permissao: pend };
      } else if (e.status === 'idle') {
        est = { estado: 'ocioso', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: null };
      } else if (e.status === 'errored' && e.statusReason === 'runner:login-expirado') {
        // A conta ESTAVA conectada e a credencial morreu: a sessão tem conversa e volta por retomada.
        // Alerta próprio (não 'sem_login') para a tela dizer o que aconteceu e desde quando.
        est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: 'login_expirado',
                motivo: e.error ? String(e.error) : `O login da conta de ${agente.nome} expirou.`,
                expirou_em: typeof e.loginExpiradoEm === 'string' ? e.loginExpiradoEm : null,
                provedor: /codex/i.test(String(agente.provedor || '')) ? 'codex' : 'claude' };
      } else if (e.status === 'errored' && e.statusReason === 'runner:sem-login') {
        // O motor não tem conta conectada: a tela oferece o cartão de login.
        est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: 'sem_login', motivo: e.error ? String(e.error) : `${agente.nome} não está logado no Claude/Codex.` };
      } else {
        est = { estado: 'sem_sinal', acao: null, detalhe: null, ultimo_sinal: ultimo, alerta: null, motivo: `O runner informa o status "${e.status}" para ${agente.nome}, então não sei se ele está trabalhando.` };
      }
    }
    const chave = `${est.estado}|${est.acao}|${est.alerta}`;
    const ant = atividadeAnterior.get(agente.slug);
    const desde = ant && ant.chave === chave ? ant.desde : iso(agoraMs);
    atividadeAnterior.set(agente.slug, { chave, desde });
    est.desde = est.estado === 'ocioso' ? null : desde;
    return est;
  }

  // ── rótulo do provedor (cache de 60 s, 1,5 s de espera, reserva do registro) ─
  function reservaDoRotulo(agente) {
    return [agente.provedor, agente.modelo].filter(Boolean).join(', ');
  }
  async function rotuloProvedor(agente) {
    const c = rotulos.get(agente.slug);
    if (c && relogio() - c.ts < TTL_ROTULO_MS) return c.valor;
    const espera = new Promise((resolve) => { setTimeout(() => resolve({ ok: false, erro: 'demorou mais de 1,5 s' }), 1500).unref(); });
    let r;
    try {
      r = await Promise.race([runner.provedor(agente, 1500), espera]);
    } catch (e) {
      r = { ok: false, erro: e.message };
    }
    let valor;
    if (r.ok && typeof r.dados.rotulo === 'string' && r.dados.rotulo.trim()) {
      valor = r.dados.rotulo.trim();
      esquece(`rotulo|${agente.slug}`);
    } else {
      valor = reservaDoRotulo(agente);
      const motivo = r.ok ? 'a resposta não trouxe o campo "rotulo"' : r.erro;
      avisaUmaVez(`rotulo|${agente.slug}`, 'aviso', `Rótulo do provedor de ${agente.nome}: ${motivo}. Uso a reserva do registro de agentes ("${valor}").`);
    }
    rotulos.set(agente.slug, { ts: relogio(), valor });
    return valor;
  }

  // ── thread compartilhada: quem pede enquanto outra leitura roda recebe a mesma promessa ─
  // thread() faz parse síncrono; sem isto, chamadas simultâneas (ou repetidas depois de uma espera
  // que estourou) refazem a leitura inteira à toa.
  const threadsEmAndamento = new Map(); // slug -> promessa de thread(agente)
  function threadCompartilhada(agente) {
    const em = threadsEmAndamento.get(agente.slug);
    if (em) return em;
    const promessa = Promise.resolve().then(() => thread(agente));
    const limpa = () => { if (threadsEmAndamento.get(agente.slug) === promessa) threadsEmAndamento.delete(agente.slug); };
    promessa.then(limpa, limpa);
    threadsEmAndamento.set(agente.slug, promessa);
    return promessa;
  }

  // ── hora da última mensagem (menu "trocar de agente"; cache de 60 s, 1,5 s de espera) ─
  // null quer dizer "não sei" (sem conversa ainda, ou a thread não respondeu a tempo): nunca vira 0.
  // Quem chama espera no máximo 1,5 s; a leitura continua e, ao terminar, alimenta o cache.
  const ultimasEmAndamento = new Map(); // slug -> promessa que resolve com o valor (e grava o cache)
  function leUltimaMensagem(agente) {
    const em = ultimasEmAndamento.get(agente.slug);
    if (em) return em;
    const promessa = threadCompartilhada(agente).then((t) => {
      esquece(`ultima|${agente.slug}`);
      const ult = t.msgs.length ? t.msgs[t.msgs.length - 1] : null;
      const valor = ult && Number.isFinite(ult.ep) && ult.ep > 0 ? Math.round(ult.ep * 1000) : null;
      ultimas.set(agente.slug, { ts: relogio(), valor });
      return { ok: true, valor };
    }, (e) => {
      avisaUmaVez(`ultima|${agente.slug}`, 'aviso', `Hora da última mensagem de ${agente.nome}: não consegui ler a thread (${e.message}). A lista do menu segue sem a hora.`);
      return { ok: false, valor: null };
    });
    const limpa = () => { if (ultimasEmAndamento.get(agente.slug) === promessa) ultimasEmAndamento.delete(agente.slug); };
    promessa.then(limpa, limpa);
    ultimasEmAndamento.set(agente.slug, promessa);
    return promessa;
  }
  async function ultimaMensagemTs(agente) {
    const c = ultimas.get(agente.slug);
    if (c && relogio() - c.ts < TTL_ROTULO_MS) return c.valor;
    let espera;
    const limite = new Promise((resolve) => { espera = setTimeout(() => resolve(null), 1500); espera.unref(); });
    const r = await Promise.race([leUltimaMensagem(agente), limite]);
    clearTimeout(espera);
    return r ? r.valor : null;
  }

  // ── idempotência por cliente_id (em memória, com validade) ───────────────
  async function umaVez(agente, rota, clienteId, faz) {
    if (!clienteId) return faz();
    const chave = `${agente.slug}|${rota}|${clienteId}`;
    const t = relogio();
    for (const [k, e] of envios) if (e.pronto && t - e.ts > TTL_ENVIO_MS) envios.delete(k);
    while (envios.size > MAX_ENVIOS) envios.delete(envios.keys().next().value);
    const existente = envios.get(chave);
    if (existente) {
      let espera;
      const limite = new Promise((resolve) => { espera = setTimeout(() => resolve('tempo'), 30000); espera.unref(); });
      const r = await Promise.race([existente.promessa, limite]);
      clearTimeout(espera);
      if (r === 'tempo') {
        return { status: 409, corpo: { ok: false, erro: `Já existe um envio com o cliente_id ${clienteId} em andamento há mais de 30 s e ele ainda não respondeu. Não mandei de novo para não duplicar: confira a conversa antes de tentar outra vez.`, cliente_id: clienteId } };
      }
      if (r && r.status < 300) {
        log('info', `${rota} repetido para ${agente.slug} (cliente_id ${clienteId}): devolvi a resposta do envio que já tinha saído.`);
        return { status: r.status, corpo: Object.assign({}, r.corpo, { repetido: true }) };
      }
      // o original falhou: segue e tenta de novo
    }
    const promessa = Promise.resolve().then(faz);
    const entrada = { promessa, ts: t, pronto: false };
    envios.set(chave, entrada);
    try {
      const r = await promessa;
      entrada.pronto = true;
      entrada.ts = relogio();
      if (r.status >= 300) envios.delete(chave);
      return r;
    } catch (e) {
      envios.delete(chave);
      throw e;
    }
  }

  // ── enviar ───────────────────────────────────────────────────────────────
  let sequencia = 0;
  const erro = (status, motivo, extra) => ({ status, corpo: Object.assign({ ok: false, erro: motivo }, extra || {}) });

  /** Entrega o texto (já com marcadores de anexo) ao agente. Devolve { status, corpo }. */
  async function entregar(agente, textoFinal, { cru, voz }) {
    sequencia += 1;
    const payload = cru
      ? textoFinal
      : montarEnvelope({ from: 'pessoa', chat: agente.chat_id, msg: `w${relogio().toString(36)}${sequencia}`, ts: new Date(relogio()).toISOString(), text: textoFinal, voz });
    const epEnviado = relogio() / 1000 - 2;
    // O runner responde 202 "enfileirado" sempre; quem sabe se vai esperar é o estado de AGORA (sem o cache de 2 s).
    const antes = await runner.estado(agente);
    if (antes.ok && antes.estado.status === 'waiting_input' && antes.estado.motivo === 'pergunta') {
      // O agente só fica ocioso depois de a pergunta ser respondida: enfileirar aqui prenderia a mensagem em silêncio.
      log('aviso', `Envio para ${agente.slug} barrado: ele espera a resposta de uma pergunta de escolha (${cru ? 'comando cru' : `${textoFinal.length} caracteres`}).`);
      return erro(409, `${agente.nome} está esperando você responder uma pergunta de escolha; a mensagem não foi enviada.`,
        { howToFix: 'Responda no cartão da pergunta, acima da caixa de mensagem, ou cancele a pergunta ali; depois reenvie.', codigo: 'PERGUNTA_PENDENTE' });
    }
    const motivoFila = antes.ok && antes.estado.status === 'waiting_input' ? (antes.estado.motivo === 'pergunta' ? 'pergunta' : 'permissao')
      : antes.ok && antes.estado.status === 'working' ? 'resposta' : null;
    const r = await runner.input(agente, { text: payload, submit: true, injectWhenIdle: true });
    if (!r.ok) {
      log('erro', `Envio para ${agente.slug} não entregue (${cru ? 'comando cru' : `${textoFinal.length} caracteres`}): ${r.erro}`);
      // O código do runner (LOGIN_EXPIRADO) segue até a tela, que abre o pop-up de reconectar em vez de só dar erro.
      return erro(r.status === 409 ? 409 : 502, `Não consegui entregar a mensagem a ${agente.nome}: ${r.erro}`, r.code ? { codigo: r.code } : undefined);
    }
    log('info', `Mensagem entregue a ${agente.slug} (${cru ? 'comando cru' : `${textoFinal.length} caracteres`}).`);
    const corpo = { ok: true, ep_enviado: epEnviado, agente: agente.slug };
    if (motivoFila) corpo.fila = { motivo: motivoFila };
    return { status: 200, corpo };
  }

  /**
   * Aprova ou nega o pedido de permissão do agente. Confere no runner (estado de agora) que ele está mesmo
   * esperando e repassa a decisão. Devolve { status, corpo } com motivo e o que fazer em toda falha.
   */
  async function permissao(agente, decisao, toolUseId) {
    if (decisao !== 'aprovar' && decisao !== 'negar') {
      return erro(400, `A "decisao" precisa ser "aprovar" ou "negar". Recebi: ${JSON.stringify(decisao === undefined ? null : String(decisao).slice(0, 40))}. Nada foi enviado.`);
    }
    const e = await runner.estado(agente);
    if (!e.ok) {
      log('erro', `Permissão de ${agente.slug}: não consegui ler o estado do runner: ${e.erro}`);
      return erro(503, `Não consegui confirmar o estado de ${agente.nome}: ${e.erro} Nada foi enviado. Tente de novo em instantes.`);
    }
    if (toolUseId !== undefined && toolUseId !== null && (typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 200)) {
      return erro(400, 'O "tool_use_id" da permissão precisa ser um texto de 1 a 200 caracteres (vem em "permissao.id" da atividade do agente). Nada foi enviado.');
    }
    if (e.estado.status === 'waiting_input' && e.estado.motivo === 'pergunta') {
      // O "1" que aprova um comando escolheria a primeira opção da pergunta: o runner também recusa, mas aqui nem chamamos.
      return erro(409, `${agente.nome} está esperando a resposta de uma pergunta de escolha, não uma permissão. Responda no cartão da pergunta. Nada foi enviado.`, { estado: e.estado.status, motivo: 'pergunta' });
    }
    if (e.estado.status !== 'waiting_input') {
      return erro(409, `${agente.nome} não está esperando permissão agora (estado: ${e.estado.status}). Provavelmente o pedido já foi resolvido. Atualize a conversa.`, { estado: e.estado.status });
    }
    const r = await runner.pedir(agente, 'POST', `/api/agents/${encodeURIComponent(agente.agente_id)}/permissao`, toolUseId ? { decisao, tool_use_id: toolUseId } : { decisao });
    if (r.erro) {
      log('erro', `Permissão de ${agente.slug} (${decisao}) não entregue: ${r.erro}`);
      return erro(503, `${r.erro} A decisão não foi enviada: tente de novo.`);
    }
    if (r.status === 404) {
      const msg = `O runner de ${agente.nome} é de uma versão antiga e não tem a rota de permissão (POST /api/agents/${agente.agente_id}/permissao). Atualize o agente pelo Admin; enquanto isso, a decisão pode ser dada pelo terminal do agente.`;
      log('erro', `Permissão de ${agente.slug}: ${msg}`);
      return erro(501, msg);
    }
    if (!r.ok) {
      const motivo = motivoDoRunner(agente, r);
      log('erro', `Permissão de ${agente.slug} (${decisao}) recusada pelo runner (HTTP ${r.status}): ${motivo}`);
      if (r.status === 409 && r.corpo && r.corpo.code === 'PERGUNTA_JA_RESPONDIDA') {
        return erro(409, `A resposta desta pergunta de ${agente.nome} já foi enviada (por esta ou outra aba). Nada foi digitado agora.`,
          { howToFix: 'Atualize a conversa. Se o terminal ficou no meio da resposta, termine pela aba Sessões.', codigo: 'PERGUNTA_JA_RESPONDIDA' });
      }
      return erro(r.status === 409 ? 409 : 502, `O runner de ${agente.nome} não aplicou a decisão: ${motivo}`);
    }
    log('info', `Permissão de ${agente.slug}: ${decisao === 'aprovar' ? 'aprovada' : 'negada'} pela tela.`);
    return { status: 200, corpo: { ok: true, decisao, agente: agente.slug } };
  }

  /**
   * Responde (ou cancela) a pergunta de escolha do agente digitando as teclas no terminal dele.
   * Corpo: { tool_use_id, respostas:[{opcao}|{opcoes}|{texto}] } ou { tool_use_id, cancelar:true }.
   * Devolve { status, corpo } com motivo e o que fazer em toda falha; nada é escrito antes de tudo validar.
   */
  async function responderPergunta(agente, corpo) {
    const c = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
    if (typeof c.tool_use_id !== 'string' || !c.tool_use_id) {
      return erro(400, 'Faltou o "tool_use_id" da pergunta (vem em "pergunta.id" da atividade do agente). Nada foi enviado.');
    }
    if (c.cancelar !== undefined && c.cancelar !== true) return erro(400, 'O campo "cancelar" só aceita true. Nada foi enviado.');
    if (c.cancelar === true && c.respostas !== undefined) return erro(400, 'Mande "cancelar" ou "respostas", não os dois. Nada foi enviado.');
    if (c.cancelar !== true && c.respostas === undefined) return erro(400, 'Faltou o campo "respostas" (uma por pergunta) ou "cancelar": true. Nada foi enviado.');

    const e = await runner.estado(agente);
    if (!e.ok) {
      log('erro', `Pergunta de ${agente.slug}: não consegui ler o estado do runner: ${e.erro}`);
      return erro(503, `Não consegui confirmar o estado de ${agente.nome}: ${e.erro} Nada foi enviado. Tente de novo em instantes.`);
    }
    if (e.estado.status !== 'waiting_input' || e.estado.motivo !== 'pergunta') {
      return erro(409, `${agente.nome} não está esperando a resposta de uma pergunta agora (estado: ${e.estado.status}). Provavelmente ela já foi respondida ou não existe mais. Atualize a conversa. Nada foi enviado.`, { estado: e.estado.status });
    }
    const pend = await perguntaDe(agente);
    if (!pend) {
      log('aviso', `Pergunta de ${agente.slug}: o runner diz que há pergunta, mas não achei a pergunta no transcript.`);
      return erro(409, `Não consegui ler a pergunta que ${agente.nome} fez, então não sei como responder daqui. Responda pelo terminal, na aba Sessões. Nada foi enviado.`);
    }
    if (pend.id !== c.tool_use_id) {
      return erro(409, 'Essa pergunta já não é a que está na tela. Atualize a conversa e responda a pergunta atual. Nada foi enviado.');
    }
    let teclas;
    if (c.cancelar === true) {
      teclas = ['\x1b'];
    } else {
      const problema = validarRespostas(pend.perguntas, c.respostas);
      if (problema) return erro(400, problema);
      teclas = teclasDaResposta(pend.perguntas, c.respostas);
    }
    // O runner digita as teclas e confere o estado antes de CADA uma: se a pessoa respondeu pelo terminal no meio,
    // ele para sem escrever o resto (escrever às cegas daqui aprovaria um comando que surgisse no lugar).
    const r = await runner.pedir(agente, 'POST', `/api/agents/${encodeURIComponent(agente.agente_id)}/pergunta`, { tool_use_id: c.tool_use_id, teclas }, 30000);
    if (r.erro) {
      log('erro', `Pergunta de ${agente.slug} não entregue: ${r.erro}`);
      if (!r.antesDoEnvio) {
        return erro(504, `Não sei se a resposta chegou inteira ao runner de ${agente.nome} (${r.erro}). Confira o terminal na aba Sessões antes de tentar de novo.`);
      }
      return erro(503, `${r.erro} A resposta não foi enviada: tente de novo.`);
    }
    if (r.status === 404) {
      const msg = `O runner de ${agente.nome} é de uma versão antiga e não tem a rota da pergunta de escolha (POST /api/agents/${agente.agente_id}/pergunta). Atualize o agente pelo Admin; enquanto isso, responda a pergunta pelo terminal do agente, na aba Sessões.`;
      log('erro', `Pergunta de ${agente.slug}: ${msg}`);
      return erro(501, msg);
    }
    if (!r.ok) {
      const motivo = motivoDoRunner(agente, r);
      log('erro', `Pergunta de ${agente.slug} recusada pelo runner (HTTP ${r.status}, ${(r.corpo && r.corpo.code) || 'sem código'}): ${motivo}`);
      if (r.status === 409 && r.corpo && r.corpo.code === 'PERGUNTA_JA_MEXIDA') {
        return erro(409, `A pergunta de ${agente.nome} já recebeu teclas pelo terminal desde que abriu; a resposta pelo chat poderia cair na etapa errada. Nada foi enviado.`,
          { howToFix: 'Termine a resposta pelo terminal, na aba Sessões.', codigo: 'PERGUNTA_JA_MEXIDA' });
      }
      return erro(r.status === 409 ? 409 : 502, `O runner de ${agente.nome} não aplicou a resposta: ${motivo}`);
    }
    const tamanhoTexto = c.cancelar === true ? 0 : c.respostas.reduce((t, r) => t + (typeof r.texto === 'string' ? r.texto.length : 0), 0);
    log('info', `Pergunta de ${agente.slug}: ${c.cancelar === true ? 'cancelada' : `respondida (${c.respostas.length} resposta(s), ${tamanhoTexto} caracteres de texto livre)`} pela tela.`);
    return { status: 200, corpo: { ok: true, agente: agente.slug, tool_use_id: c.tool_use_id } };
  }

  /**
   * Reinicia a sessão do agente no runner: a MESMA conversa continua, só o processo é refeito.
   * Devolve { status, corpo } com motivo e o que fazer em toda falha.
   */
  async function reiniciar(agente) {
    const r = await runner.pedir(agente, 'POST', `/api/agents/${encodeURIComponent(agente.agente_id)}/reiniciar`, null, 30000);
    if (r.erro) {
      log('erro', `Reinício de ${agente.slug}: ${r.erro}`);
      if (!r.antesDoEnvio) {
        // Timeout ou conexão derrubada depois do envio: o runner pode ter recebido e estar reiniciando.
        return erro(504, `Não sei se o reinício chegou ao runner de ${agente.nome} (${r.erro}). Espere uns 30 s e olhe se ele voltou a responder antes de tentar de novo.`);
      }
      return erro(503, `${r.erro} O reinício não foi pedido. Se o agente está parado, peça ao Admin para conferir o serviço dele.`);
    }
    if (r.status === 404) {
      const msg = `O runner de ${agente.nome} é de uma versão antiga e não tem a rota de reinício (POST /api/agents/${agente.agente_id}/reiniciar). Atualize o agente pelo Admin.`;
      log('erro', `Reinício de ${agente.slug}: ${msg}`);
      return erro(501, msg);
    }
    if (!r.ok) {
      const motivo = motivoDoRunner(agente, r);
      log('erro', `Reinício de ${agente.slug} recusado pelo runner (HTTP ${r.status}): ${motivo}`);
      return erro(r.status === 409 || r.status === 429 ? r.status : 502, `O runner de ${agente.nome} não reiniciou a sessão: ${motivo}`);
    }
    const dados = r.corpo || {};
    log('info', `Reinício de ${agente.slug}: pedido pela tela (sessão ${dados.sessao || '?'}, modo ${dados.modo || '?'}).`);
    return { status: 202, corpo: { ok: true, agente: agente.slug, sessao: dados.sessao || null, modo: dados.modo || null } };
  }

  async function enviar(agente, req) {
    const texto = typeof req.text === 'string' ? req.text.trim() : '';
    const ids = req.anexos == null ? [] : req.anexos;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string' && i)) {
      return erro(400, `"anexos" precisa ser a lista dos ids devolvidos por /upload com enviar=0 (anexo.id). Recebi: ${JSON.stringify(ids).slice(0, 200)}.`);
    }
    if (ids.length > MAX_ANEXOS) return erro(413, `Vieram ${ids.length} anexos e o limite é ${MAX_ANEXOS} por mensagem. Mande o resto em outra.`);
    if (new Set(ids).size !== ids.length) return erro(400, 'Há ids repetidos em "anexos". Cada arquivo entra uma vez só.');
    if (!texto && !ids.length) return erro(400, 'Mande o texto em "text" (ou os ids dos arquivos em "anexos"). Recebi vazio.');
    // Token do BotFather colado sozinho: vai para o .env do agente e nunca para o runner.
    if (!ids.length && tokenTelegram.ehToken(texto)) {
      const g = await tokenTelegram.guardar(agente, texto);
      if (g.erro) {
        log('aviso', `Token do Telegram colado na conversa de ${agente.slug} não foi guardado: ${g.erro.corpo.erro}`);
        return g.erro;
      }
      const r = await entregar(agente, g.marca, { cru: false });
      if (r.status >= 300) return r;
      log('info', `Token do Telegram de ${agente.slug} guardado no .env do agente (${g.mascarado}).`);
      return { status: 200, corpo: Object.assign({}, r.corpo, { token_guardado: true, mascarado: g.mascarado, marca: g.marca }) };
    }
    if (texto.length > config.maxTexto) return erro(413, `O texto tem ${texto.length} caracteres e o limite é ${config.maxTexto} por mensagem. Divida em partes.`);
    const marcadores = []; const faltam = [];
    for (const id of ids) {
      const e = midia.obter(id);
      if (!e || e.slug !== agente.slug) { faltam.push(id); continue; }
      marcadores.push(`[anexo: ${paraContainer(e.path, agente)}]`);
    }
    if (faltam.length) {
      return erro(404, `Não achei o anexo ${faltam.join(', ')} entre os arquivos de ${agente.nome}. Suba o arquivo de novo em /upload (enviar=0) e use o anexo.id que voltar. Nada foi enviado.`, { anexos_faltando: faltam });
    }
    // Mensagem que começa com "/": comando de barra (ver comandos.js). Anexos desligam; "//" escapa.
    const d = await comandos.decidir(agente, texto, { temAnexos: ids.length > 0 });
    if (d.erro) {
      log('aviso', `Comando recusado para ${agente.slug} (${d.erro.codigo}): ${String(texto).slice(0, 80)}`);
      const { status, ...corpo } = d.erro;
      return erro(status, corpo.erro, { codigo: corpo.codigo, ...omite(corpo, ['erro', 'codigo']) });
    }
    if (d.tipo === 'comando') return entregaComando(agente, d);
    const base = d.texto !== undefined ? d.texto : texto;
    // Só `voz: true` conta (a tela manda quando o modo de ouvir está ligado); outro valor é sem a tag.
    return entregar(agente, [base, ...marcadores].filter(Boolean).join('\n'), { cru: false, voz: req.voz === true });
  }

  const omite = (o, chaves) => Object.fromEntries(Object.entries(o).filter(([k]) => !chaves.includes(k)));

  /** Entrega uma decisão do tipo 'comando' e anexa o objeto `comando` ao corpo 200. */
  async function entregaComando(agente, d) {
    const r = await entregar(agente, d.textoParaRunner, { cru: d.entregue_como === 'cru' });
    if (r.status >= 300) return r;
    const comando = Object.assign({}, d.comando, { entregue_como: d.entregue_como });
    return { status: r.status, corpo: Object.assign({}, r.corpo, { comando }) };
  }

  /**
   * POST /comando: { comando, argumentos } ou { text }. Mesmo caminho do /send, mas aqui tudo que não for
   * comando é erro (o /send, ao contrário, segue como texto).
   */
  async function comando(agente, req) {
    const b = req || {};
    let texto;
    if (typeof b.comando === 'string' && b.comando.trim()) {
      const nome = b.comando.trim();
      if (b.argumentos != null && typeof b.argumentos !== 'string') {
        return erro(400, `"argumentos" precisa ser um texto. Recebi ${JSON.stringify(b.argumentos).slice(0, 80)}. Nada foi enviado.`, { codigo: 'COMANDO_MALFORMADO' });
      }
      texto = nome + (typeof b.argumentos === 'string' && b.argumentos.trim() ? ` ${b.argumentos.trim()}` : '');
    } else if (typeof b.text === 'string' && b.text.trim()) {
      texto = b.text.trim();
    } else {
      return erro(400, 'Mande o comando em "comando" (ex.: "/compact") ou o texto inteiro em "text" (ex.: "/compact foque nas decisões"). Recebi vazio. Nada foi enviado.', { codigo: 'COMANDO_MALFORMADO' });
    }
    if (texto.length > config.maxTexto) return erro(413, `O comando tem ${texto.length} caracteres e o limite é ${config.maxTexto}. Encurte os argumentos.`);
    const d = await comandos.decidir(agente, texto, { temAnexos: false });
    if (d.erro) {
      const { status, ...corpo } = d.erro;
      return erro(status, corpo.erro, { codigo: corpo.codigo, ...omite(corpo, ['erro', 'codigo']) });
    }
    if (d.tipo !== 'comando') {
      return erro(400, `"${texto.slice(0, 80)}" não é um comando: o comando começa com uma barra e o nome vai colado nela, sem espaço (ex.: "/compact"). Para mandar texto comum ao agente, use o /send. Nada foi enviado.`, { codigo: 'COMANDO_MALFORMADO' });
    }
    return entregaComando(agente, d);
  }

  return {
    montarEnvelope, estado, thread, threadCompartilhada, atividade, rotuloProvedor, ultimaMensagemTs, umaVez, enviar, comando, comandos, entregar, permissao, responderPergunta, reiniciar,
    RX_CLIENTE_ID,
  };
}

module.exports = { criarConversa, montarEnvelope, validarRespostas, teclasDaResposta, RX_CLIENTE_ID };
