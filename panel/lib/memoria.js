'use strict';
/**
 * memoria.js: o raio-X do cérebro do agente, e a edição à mão da memória dele.
 *
 * O PEDIDO (Danilo, 01/10/2026): "um raio-X do cérebro dele, eu conseguir ver
 * todos os arquivos que ele está usando ali referentes à atividade do usuário:
 * pesquisa, tarefas, preferências... sempre renderizado em markdown correto,
 * bonito, e o usuário pode clicar e editar à mão, e fica salvo como principal
 * para a próxima rodada o agente puxar".
 *
 * A memória do agente é TEXTO em arquivo, e não um banco fechado. É isso que
 * torna o pedido possível sem mágica: a tela lê os mesmos arquivos que ele lê, e
 * quando o dono salva, grava no mesmo lugar de onde ele lê. Nenhuma cópia, nenhum
 * "rascunho do painel" que depois precisa ser sincronizado.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  AS CINCO TRAVAS DA GRAVAÇÃO, e por que cada uma existe                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 1. LISTA DE PERMISSÃO, não de proibição. Só se grava nos arquivos de memória e
 *    de identidade que estão em EDITAVEIS abaixo, e só se o caminho também passa
 *    pelo sanitizador da leitura (lib/sanitize.js: nada fora do agentDir, nada em
 *    pasta começada por ponto, nada em pasta de segredo, link simbólico
 *    resolvido). Uma lista de proibição esquece sempre o arquivo novo; a vistoria
 *    de 01/10 achou o cofre inteiro legível por esse esquecimento.
 * 2. VERSÃO LIDA. O agente escreve nestes arquivos sozinho (o batimento reescreve
 *    o "## Agora" da memória de trabalho a cada meia hora). Se o arquivo mudou
 *    desde que o dono abriu o editor, salvar por cima apagaria o que o agente
 *    escreveu nesse meio tempo. Então a gravação leva a versão que foi lida, e se
 *    o arquivo de agora é outro, a resposta é 409 e nada é gravado.
 * 3. GRAVAÇÃO ATÔMICA. Escreve num arquivo temporário na mesma pasta e troca de
 *    nome (rename), que o sistema faz de uma vez. Quem ler no meio do caminho lê
 *    o arquivo velho inteiro ou o novo inteiro, nunca metade.
 * 4. O DONO DO ARQUIVO CONTINUA O MESMO. O painel roda como root dentro do
 *    container; o agente roda como outro usuário. Um arquivo novo criado pelo
 *    root (o temporário) e trocado de nome ficaria com dono root, e o agente
 *    PERDERIA a permissão de escrever na própria memória. O temporário recebe o
 *    dono e as permissões do original antes do rename.
 * 5. CÓPIA DO QUE HAVIA ANTES. A versão anterior vai para
 *    .dgclaw/backups/memoria/<arquivo>.<carimbo>, as 20 últimas de cada arquivo,
 *    e cada edição fica anotada em .dgclaw/logs/edicoes-memoria.jsonl (o quê e
 *    quando, nunca o conteúdo). Errar uma edição à mão não pode custar a memória.
 *
 * COMO O AGENTE FICA SABENDO DA EDIÇÃO: ele lê working-memory.md e MEMORY.md no
 * começo de cada sessão e depois de cada compactação (hooks/session-context.sh),
 * e lê os arquivos de memory/ quando precisa deles. A edição vale "para a próxima
 * rodada" sem fazer nada. Para valer AGORA, na conversa que já está aberta, a tela
 * oferece um botão que manda uma linha pela Conversa avisando que o arquivo mudou.
 * Detalhe em panel/docs/CEREBRO.md.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildSanitizer } = require('./sanitize');

const TETO_GRAVACAO_BYTES = 1024 * 1024; // 1 MB: memória maior que isso não é memória
const BACKUPS_POR_ARQUIVO = 20;

/**
 * O que pode ser editado à mão, por caminho relativo ao agentDir.
 *
 * Ficam DE FORA, de propósito: LAWS.md e ETHICS.md (as regras de segurança dele,
 * imutáveis por desenho: o próprio arquivo pede chmod 444), AGENT.md e CLAUDE.md
 * (as instruções de trabalho, que o plugin reescreve na atualização e apagaria a
 * edição), e qualquer coisa fora destas pastas.
 */
const EDITAVEIS = [
  /^working-memory\.md$/,
  /^persona\/working-memory\.md$/,
  /^MEMORY\.md$/,
  /^memory\/[^/]+\.(md|json|txt)$/,
  /^memory\/[^/]+\/[^/]+\.(md|json|txt)$/,
  /^(SOUL|PERSONALITY|IDENTITY|CREATOR)\.md$/,
];
const MOTIVO_NAO_EDITAVEL = {
  'LAWS.md': 'são as leis de segurança dele, e elas são imutáveis de propósito: nem um pedido seu muda essas regras. Quem cuida do sistema altera pelo instalador.',
  'ETHICS.md': 'é o código de ética dele, que protege você e quem fala com ele. Ele é mudado pelo instalador, não à mão.',
  'AGENT.md': 'são as instruções de trabalho dele, e a próxima atualização do plugin reescreve este arquivo. Uma edição aqui se perderia.',
  'CLAUDE.md': 'são as instruções de trabalho dele, e a próxima atualização do plugin reescreve este arquivo. Uma edição aqui se perderia.',
};

/** Normaliza para comparar título de seção sem acento nem maiúscula ("Últimas" = "ultimas"). */
function normal(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function versaoDe(conteudo) {
  return crypto.createHash('sha256').update(conteudo, 'utf8').digest('hex').slice(0, 24);
}

/** As seções "## " de um markdown, em ordem. */
function secoes(texto) {
  const saida = [];
  let atual = null;
  for (const linha of String(texto || '').split('\n')) {
    const h = linha.match(/^##\s+(.+?)\s*$/);
    if (h) {
      atual = { titulo: h[1], corpo: [] };
      saida.push(atual);
    } else if (atual) {
      atual.corpo.push(linha);
    }
  }
  return saida.map((s) => ({ titulo: s.titulo, corpo: s.corpo.join('\n').trim() }));
}

/** Seção só com o recado de "vazio" do gerador ("- (vazio — ...)") conta como vazia. */
function secaoVazia(corpo) {
  const linhas = String(corpo || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return !linhas.length || linhas.every((l) => /^[-*]\s*\(.*\)\s*$/.test(l));
}

/**
 * As seções da memória de trabalho que merecem destaque no raio-X.
 *
 * As quatro primeiras são as que o Danilo pediu e que outra frente está
 * criando no gerador (scripts/build-working-memory.py). Enquanto elas não
 * existem, entram as que já existem hoje e dizem a mesma coisa de outro jeito.
 * O casamento é pelo começo do título, sem acento: o gerador escreve "Na minha
 * cabeca" sem cedilha, e o agente às vezes escreve com.
 */
const DESTAQUES_WM = [
  // O gerador escreve o NOME do dono no título ("## Objetivos do Paulo"), então o
  // casamento é só pelo começo.
  { chave: 'objetivos d', rotulo: 'Objetivos do dono' },
  { chave: 'tarefas em andamento', rotulo: 'Tarefas em andamento' },
  { chave: 'o que eu sei sobre', rotulo: 'O que ele sabe sobre você' },
  { chave: 'ultimas conversas', rotulo: 'Últimas conversas' },
];
const DESTAQUES_WM_HOJE = [
  { chave: 'agora', rotulo: 'Agora' },
  { chave: 'pendencias', rotulo: 'Pendências' },
  { chave: 'na minha cabeca', rotulo: 'Na cabeça dele' },
  { chave: 'metas de curto prazo', rotulo: 'Metas de curto prazo' },
  { chave: 'quero falar', rotulo: 'O que ele quer falar com você' },
  { chave: 'instrucoes d', rotulo: 'Suas instruções para ele' },
];

/** Corta um markdown num tamanho de prévia, sem partir linha no meio. */
function previa(texto, teto) {
  const t = String(texto || '').trim();
  if (t.length <= teto) return { texto: t, cortado: false };
  const corte = t.lastIndexOf('\n', teto);
  return { texto: t.slice(0, corte > teto * 0.5 ? corte : teto).trimEnd(), cortado: true };
}

function buildMemoria(config) {
  const AGENT_DIR = config.agentDir;
  const { explicarRecusa } = buildSanitizer(config);
  const BACKUP_DIR = path.join(AGENT_DIR, '.dgclaw', 'backups', 'memoria');
  const LOG_EDICOES = path.join(AGENT_DIR, '.dgclaw', 'logs', 'edicoes-memoria.jsonl');

  /** Caminho relativo normalizado (com "/"), ou null se não dá para normalizar. */
  function relativo(pedido) {
    if (!pedido || typeof pedido !== 'string') return null;
    const abs = path.resolve(AGENT_DIR, pedido);
    const rel = path.relative(AGENT_DIR, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  /** Por que este arquivo não pode ser editado à mão, ou null se pode. */
  function motivoNaoEditavel(rel, stat) {
    if (!rel) return 'o caminho é inválido';
    const recusa = explicarRecusa(rel);
    if (recusa) return recusa;
    if (MOTIVO_NAO_EDITAVEL[rel]) return MOTIVO_NAO_EDITAVEL[rel];
    if (!EDITAVEIS.some((re) => re.test(rel))) {
      return 'só a memória (working-memory.md, MEMORY.md, a pasta memory/) e os arquivos de quem ele é (SOUL, PERSONALITY, IDENTITY, CREATOR) podem ser editados por aqui';
    }
    if (stat && (stat.mode & 0o222) === 0) {
      return 'o arquivo foi marcado como somente leitura no sistema, de propósito. Quem cuida do sistema sabe o motivo.';
    }
    return null;
  }

  // ── as edições do dono, para saber "quem escreveu por último" ──
  function ultimasEdicoes() {
    const mapa = {};
    let texto = '';
    try { texto = fs.readFileSync(LOG_EDICOES, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[memoria] nao consegui ler o registro de edicoes (${e.code}).`);
      return mapa;
    }
    for (const linha of texto.split('\n').slice(-500)) {
      if (!linha.trim()) continue;
      try {
        const o = JSON.parse(linha);
        if (o && o.path) mapa[o.path] = o;
      } catch { /* linha torta no registro: as outras continuam valendo */ }
    }
    return mapa;
  }

  function lerSeguro(rel) {
    const abs = path.join(AGENT_DIR, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      if (st.size > TETO_GRAVACAO_BYTES * 2) return { abs, st, conteudo: null, grande: true };
      return { abs, st, conteudo: fs.readFileSync(abs, 'utf8') };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[memoria] nao consegui ler ${rel} (${e.code}): ${e.message}`);
      return null;
    }
  }

  /** Quem escreve este arquivo, em português, e se a última mão foi a do dono. */
  function autoria(rel, conteudo, edicoes) {
    let quem = 'agente';
    let frase = 'Ele escreve aqui quando aprende algo sobre este assunto.';
    if (/(^|\/)working-memory\.md$/.test(rel)) {
      quem = 'rotina';
      frase = 'Remontada toda manhã por uma rotina, e ele acrescenta ao longo do dia. A linha "Agora" é atualizada a cada batimento.';
    } else if (rel === 'MEMORY.md') {
      frase = 'Ele escreve aqui na reflexão da noite, quando um fato merece ficar para sempre.';
    } else if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(rel)) {
      quem = 'rotina';
      frase = 'A reflexão da noite escreve uma página por dia.';
    } else if (/^(SOUL|PERSONALITY|IDENTITY|CREATOR)\.md$/.test(rel)) {
      quem = 'dono';
      frase = 'Nasceu na instalação, a partir da conversa com você. Quem muda este arquivo é você.';
    }
    const ed = edicoes[rel];
    const voceFoiOUltimo = !!(ed && conteudo != null && ed.versaoDepois === versaoDe(conteudo));
    return { quem: voceFoiOUltimo ? 'dono' : quem, frase, voceEditouEm: ed ? ed.ts : null, voceFoiOUltimo };
  }

  const TITULOS = {
    'working-memory.md': 'Memória de trabalho',
    'persona/working-memory.md': 'Memória de trabalho',
    'MEMORY.md': 'Memória longa',
    'CREATOR.md': 'Quem é você, para ele',
    'memory/preferencias.md': 'Suas preferências',
    'memory/preferences.md': 'Suas preferências',
    'memory/pessoas.md': 'Pessoas',
    'memory/people.md': 'Pessoas',
    'memory/projetos.md': 'Projetos',
    'memory/projects.md': 'Projetos',
    'memory/pesquisas.md': 'Pesquisas',
    'memory/research.md': 'Pesquisas',
    'memory/tarefas.md': 'Tarefas',
    'memory/relationships.json': 'Com quem ele se relaciona',
    'memory/opinions.json': 'As opiniões dele',
    'memory/triggers.json': 'O que mexe com ele',
  };
  const EXPLICA = {
    'working-memory.md': 'O bloco de anotações do momento: o que ele está fazendo, o que ficou pendente e o que combinou com você há pouco. Ele lê isto no começo de toda conversa.',
    'MEMORY.md': 'Os fatos que ficam: uma linha por coisa importante que aconteceu, com o link para o diário daquele dia.',
    'CREATOR.md': 'O que ele sabe sobre você: quem você é, como prefere ser tratado e como falar com você.',
    diario: 'O diário que ele escreve toda noite, contando o dia. O mais recente aparece aqui; os outros estão na aba Memória.',
  };

  function tituloDe(rel) {
    if (TITULOS[rel]) return TITULOS[rel];
    const base = path.basename(rel).replace(/\.(md|json|txt)$/i, '').replace(/[-_]+/g, ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  function tipoDe(rel) {
    if (/\.json$/i.test(rel)) return 'json';
    if (/\.md$/i.test(rel)) return 'md';
    return 'texto';
  }

  /** JSON legível: formatado, num bloco de código. Inválido aparece cru, com o aviso. */
  function jsonComoMarkdown(conteudo, teto) {
    let bonito;
    try { bonito = JSON.stringify(JSON.parse(conteudo), null, 2); } catch {
      return { texto: `> Este arquivo deveria ser JSON, mas não está válido. Aparece cru.\n\n\`\`\`\n${conteudo.slice(0, teto)}\n\`\`\``, cortado: conteudo.length > teto };
    }
    const p = previa(bonito, teto);
    return { texto: '```json\n' + p.texto + '\n```', cortado: p.cortado };
  }

  function cartao(rel, edicoes, extra = {}) {
    // A MESMA recusa da leitura vale para o cartão: sem isto, um arquivo bloqueado
    // ou um link simbólico para fora do agente apareceria na prévia do raio-X
    // (pego pelo test-memoria-editar.mjs em 01/10/2026).
    if (explicarRecusa(rel)) return null;
    const lido = lerSeguro(rel);
    if (!lido) return null;
    const tipo = tipoDe(rel);
    const base = {
      path: rel,
      titulo: extra.titulo || tituloDe(rel),
      explica: extra.explica || EXPLICA[rel] || 'Um assunto que ele separou num arquivo próprio para lembrar melhor.',
      tipo,
      atualizadoEm: lido.st.mtime.toISOString(),
      tamanho: lido.st.size,
      editavel: !motivoNaoEditavel(rel, lido.st),
      motivoNaoEditavel: motivoNaoEditavel(rel, lido.st),
      autoria: autoria(rel, lido.conteudo, edicoes),
    };
    if (lido.grande) return { ...base, previa: '> Arquivo grande demais para mostrar aqui.', cortado: true };
    if (tipo === 'json') {
      const p = jsonComoMarkdown(lido.conteudo, 900);
      return { ...base, previa: p.texto, cortado: p.cortado };
    }
    // Tira o comentário HTML de cabeçalho que o instalador deixa nos arquivos
    // ("<!-- CREATOR.md: gerado por DG Claw ... -->"): é recado para máquina.
    const limpo = lido.conteudo.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
    const p = previa(limpo, extra.teto || 1100);
    return { ...base, previa: p.texto, cortado: p.cortado };
  }

  /** O cartão da memória de trabalho, com as seções que importam separadas. */
  function cartaoWM(rel, edicoes) {
    const c = cartao(rel, edicoes, { teto: 600 });
    if (!c) return null;
    const lido = lerSeguro(rel);
    const todas = secoes(lido && lido.conteudo);
    const achar = (lista) => lista.map((d) => {
      const s = todas.find((x) => normal(x.titulo).startsWith(d.chave));
      if (!s) return null;
      const vazia = secaoVazia(s.corpo);
      const p = previa(s.corpo, 700);
      return { titulo: d.rotulo, tituloNoArquivo: s.titulo, markdown: vazia ? '' : p.texto, cortado: p.cortado, vazia };
    }).filter(Boolean);
    const pedidas = achar(DESTAQUES_WM);
    const deHoje = achar(DESTAQUES_WM_HOJE);
    // As pedidas primeiro; as de hoje completam até seis, sem repetir.
    // As de hoje que entram só para completar não entram VAZIAS: um cartão cheio de
    // "nada anotado aqui" esconde o que importa.
    const completar = deHoje.filter((d) => !d.vazia && !pedidas.some((p) => p.tituloNoArquivo === d.tituloNoArquivo));
    const destaques = [...pedidas, ...completar].slice(0, 6);
    return {
      ...c,
      destaques,
      // As quatro seções novas ainda não existem neste agente. A tela diz isso
      // em vez de fingir que estão vazias.
      faltamSecoesNovas: DESTAQUES_WM.filter((d) => !pedidas.some((p) => p.titulo === d.rotulo)).map((d) => d.rotulo),
    };
  }

  /** O raio-X inteiro: um cartão por arquivo vivo da memória, e o tamanho de cada camada. */
  function cerebro() {
    const edicoes = ultimasEdicoes();
    const cartoes = [];
    const wmRel = fs.existsSync(path.join(AGENT_DIR, 'working-memory.md')) ? 'working-memory.md'
      : (fs.existsSync(path.join(AGENT_DIR, 'persona', 'working-memory.md')) ? 'persona/working-memory.md' : null);
    if (wmRel) { const c = cartaoWM(wmRel, edicoes); if (c) cartoes.push(c); }
    for (const rel of ['MEMORY.md', 'CREATOR.md']) {
      const c = cartao(rel, edicoes);
      if (c) cartoes.push(c);
    }

    let nomes = [];
    try { nomes = fs.readdirSync(path.join(AGENT_DIR, 'memory')); } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[memoria] nao consegui listar memory/ (${e.code}).`);
    }
    const diarios = nomes.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
    const assuntos = nomes.filter((n) => /\.(md|json|txt)$/i.test(n) && !/^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
    for (const n of assuntos) {
      const c = cartao(`memory/${n}`, edicoes);
      if (c) cartoes.push(c);
    }
    if (diarios.length) {
      const ult = diarios[diarios.length - 1];
      const [a, m, d] = ult.slice(0, 10).split('-');
      const c = cartao(`memory/${ult}`, edicoes, {
        titulo: `Diário de ${d}/${m}/${a}`,
        explica: EXPLICA.diario + ` São ${diarios.length} dias guardados.`,
        teto: 900,
      });
      if (c) cartoes.push({ ...c, diarios: diarios.length });
    }

    // ── as camadas, para o mapa da aba "Como funciona" ──
    const tam = (rels) => rels.reduce((soma, r) => {
      try { return soma + fs.statSync(path.join(AGENT_DIR, r)).size; } catch { return soma; }
    }, 0);
    const existe = (r) => { try { return fs.statSync(path.join(AGENT_DIR, r)).isFile(); } catch { return false; } };
    const identidade = ['SOUL.md', 'IDENTITY.md', 'PERSONALITY.md', 'CREATOR.md', 'ETHICS.md', 'LAWS.md'].filter(existe);
    const camadas = [
      { id: 'trabalho', titulo: 'Memória de trabalho', explica: 'o que ele tem na cabeça agora; lida no começo de toda conversa',
        arquivos: wmRel ? 1 : 0, bytes: wmRel ? tam([wmRel]) : null },
      { id: 'longa', titulo: 'Memória longa', explica: 'os fatos que ficam (MEMORY.md)',
        arquivos: existe('MEMORY.md') ? 1 : 0, bytes: existe('MEMORY.md') ? tam(['MEMORY.md']) : null },
      { id: 'assuntos', titulo: 'Assuntos', explica: 'um arquivo por tema que ele separou (memory/)',
        arquivos: assuntos.length, bytes: assuntos.length ? tam(assuntos.map((n) => `memory/${n}`)) : null },
      { id: 'diarios', titulo: 'Diários', explica: 'uma página por dia, escrita na reflexão da noite',
        arquivos: diarios.length, bytes: diarios.length ? tam(diarios.map((n) => `memory/${n}`)) : null },
      { id: 'identidade', titulo: 'Identidade', explica: 'quem ele é e as regras que segue (SOUL, IDENTITY, LAWS...)',
        arquivos: identidade.length, bytes: identidade.length ? tam(identidade) : null },
    ];

    return { cartoes, camadas, geradoEm: new Date().toISOString() };
  }

  /** Um arquivo inteiro, para o leitor. Devolve { erro, status } quando não dá. */
  function ler(pedido) {
    const rel = relativo(pedido);
    if (!rel) return { status: 400, erro: 'O caminho do arquivo veio vazio ou inválido.', howToFix: 'Volte e abra o arquivo pela lista.' };
    const recusa = explicarRecusa(rel);
    if (recusa) return { status: 403, erro: `Este arquivo não abre pelo painel: ${recusa}.`, howToFix: 'Os arquivos de memória ficam na aba Memória.' };
    const lido = lerSeguro(rel);
    if (!lido) return { status: 404, erro: `Não achei o arquivo ${rel}.`, howToFix: 'Ele pode ter sido renomeado ou apagado pelo agente. Recarregue a lista.' };
    if (lido.grande) return { status: 413, erro: 'O arquivo é grande demais para abrir aqui (passa de 2 MB).', howToFix: 'Peça a ele na Conversa o trecho que você quer ver.' };
    const motivo = motivoNaoEditavel(rel, lido.st);
    const aviso = /(^|\/)working-memory\.md$/.test(rel)
      ? 'Esta memória é remontada toda manhã por uma rotina, e a linha "Agora" muda a cada batimento. '
        + 'O que você escrever nas seções de instruções e de recados é preservado; nas outras, ele pode reescrever com o tempo.'
      : null;
    return {
      status: 200,
      corpo: {
        path: rel,
        titulo: tituloDe(rel),
        tipo: tipoDe(rel),
        conteudo: lido.conteudo,
        versao: versaoDe(lido.conteudo),
        atualizadoEm: lido.st.mtime.toISOString(),
        tamanho: lido.st.size,
        editavel: !motivo,
        motivoNaoEditavel: motivo,
        aviso,
        autoria: autoria(rel, lido.conteudo, ultimasEdicoes()),
      },
    };
  }

  /** Guarda a versão de antes e mantém só as últimas 20 deste arquivo. */
  function guardarCopia(rel, conteudoAntigo, carimbo) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const nome = rel.replace(/\//g, '__');
    const destino = path.join(BACKUP_DIR, `${nome}.${carimbo}`);
    fs.writeFileSync(destino, conteudoAntigo, { mode: 0o600 });
    const minhas = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(nome + '.')).sort();
    for (const velho of minhas.slice(0, Math.max(0, minhas.length - BACKUPS_POR_ARQUIVO))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, velho)); } catch (e) {
        console.warn(`[memoria] nao consegui apagar a copia velha ${velho} (${e.code}). Sobra uma a mais, nada se perde.`);
      }
    }
    return path.relative(AGENT_DIR, destino).split(path.sep).join('/');
  }

  function anotar(registro) {
    try {
      fs.mkdirSync(path.dirname(LOG_EDICOES), { recursive: true });
      fs.appendFileSync(LOG_EDICOES, JSON.stringify(registro) + '\n');
    } catch (e) {
      // A edição já foi gravada; perder a anotação não desfaz nada, mas fica no log.
      console.error(`[memoria] gravei ${registro.path}, mas nao consegui anotar a edicao em ${LOG_EDICOES}: ${e.message}`);
    }
  }

  /**
   * Grava o arquivo editado à mão. Devolve { status, corpo } ou { status, erro, howToFix }.
   * `agora` e `fsOps` existem só para o teste.
   */
  function gravar({ path: pedido, conteudo, versaoLida } = {}, opcoes = {}) {
    const rel = relativo(pedido);
    if (!rel) return { status: 400, erro: 'O caminho do arquivo veio vazio ou inválido.', howToFix: 'Feche o editor e abra o arquivo de novo pela lista.' };
    if (typeof conteudo !== 'string') return { status: 400, erro: 'O texto do arquivo não chegou.', howToFix: 'Tente salvar de novo.' };
    if (typeof versaoLida !== 'string' || !versaoLida) {
      return { status: 400, erro: 'Faltou dizer qual versão do arquivo você estava editando.', howToFix: 'Feche o editor, abra o arquivo de novo e refaça a edição.' };
    }
    const bytes = Buffer.byteLength(conteudo, 'utf8');
    if (bytes > TETO_GRAVACAO_BYTES) {
      return { status: 413, erro: 'O texto passou de 1 MB, que é o teto para memória editada à mão.', howToFix: 'Memória boa é curta. Corte o que for histórico e salve de novo.' };
    }
    if (conteudo.includes('\u0000')) return { status: 400, erro: 'O texto tem um caractere inválido (byte nulo).', howToFix: 'Cole o texto de novo a partir de um editor comum.' };

    const recusa = explicarRecusa(rel);
    if (recusa) return { status: 403, erro: `Este arquivo não pode ser gravado pelo painel: ${recusa}.`, howToFix: 'Só a memória e a identidade dele se editam por aqui.' };
    const lido = lerSeguro(rel);
    if (!lido) return { status: 404, erro: `O arquivo ${rel} não existe mais.`, howToFix: 'Ele pode ter sido renomeado pelo agente. Copie o seu texto antes de fechar, e recarregue a lista.' };
    if (lido.grande) return { status: 413, erro: 'O arquivo é grande demais para ser editado aqui.', howToFix: 'Peça a ele na Conversa a mudança que você quer.' };
    const motivo = motivoNaoEditavel(rel, lido.st);
    if (motivo) return { status: 403, erro: `Este arquivo não pode ser editado à mão: ${motivo}`, howToFix: 'Se a mudança é importante, peça a ele na Conversa.' };

    if (tipoDe(rel) === 'json') {
      try { JSON.parse(conteudo); } catch (e) {
        return { status: 400, erro: `O texto não é JSON válido, então nada foi gravado (${e.message}).`, howToFix: 'Confira vírgulas, aspas e chaves. Uma vírgula sobrando depois do último item é o erro mais comum.' };
      }
    }

    const versaoAtual = versaoDe(lido.conteudo);
    if (versaoAtual !== versaoLida) {
      return {
        status: 409,
        erro: 'Este arquivo mudou enquanto você editava (quase sempre é ele escrevendo nele), então eu NÃO gravei por cima.',
        howToFix: 'O seu texto continua no editor. Copie o que você mudou, carregue a versão nova e refaça a sua mudança nela.',
        versaoAtual,
        atualizadoEm: lido.st.mtime.toISOString(),
      };
    }
    if (conteudo === lido.conteudo) {
      return { status: 200, corpo: { ok: true, semMudanca: true, versao: versaoAtual, atualizadoEm: lido.st.mtime.toISOString(), backup: null } };
    }

    const agora = opcoes.agora || new Date();
    const carimbo = agora.toISOString().replace(/[:.]/g, '-');
    let backup;
    try {
      backup = guardarCopia(rel, lido.conteudo, carimbo);
    } catch (e) {
      console.error(`[memoria] nao consegui guardar a copia de ${rel} antes de gravar: ${e.message}`);
      return { status: 500, erro: 'Não consegui guardar a cópia de segurança do arquivo, então não gravei nada.', howToFix: 'Isto costuma ser disco cheio. Avise quem cuida do sistema; a sua edição continua no editor.' };
    }

    // Gravação atômica: temporário na MESMA pasta (rename entre discos não é atômico).
    const tmp = path.join(path.dirname(lido.abs), `.${path.basename(lido.abs)}.painel-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      const fd = fs.openSync(tmp, 'wx', lido.st.mode & 0o777);
      try {
        fs.writeSync(fd, conteudo);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Trava 4: o arquivo novo nasce com o dono e as permissões do original.
      try { fs.chownSync(tmp, lido.st.uid, lido.st.gid); } catch (e) {
        if (e.code !== 'EPERM') throw e; // sem root e dono igual: nada a mudar
      }
      fs.chmodSync(tmp, lido.st.mode & 0o7777);
      (opcoes.antesDoRename || (() => {}))();
      fs.renameSync(tmp, lido.abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter nascido */ }
      console.error(`[memoria] falhou a gravacao de ${rel}: ${e.message}`);
      return { status: 500, erro: `Não consegui gravar o arquivo (${e.code || e.message}). O original ficou como estava.`, howToFix: 'Tente de novo. Se continuar, avise quem cuida do sistema; a sua edição continua no editor.' };
    }

    let st;
    try { st = fs.statSync(lido.abs); } catch { st = null; }
    const versaoNova = versaoDe(conteudo);
    anotar({
      ts: agora.toISOString(), path: rel, quem: 'dono (painel)',
      bytesAntes: Buffer.byteLength(lido.conteudo, 'utf8'), bytesDepois: bytes,
      versaoAntes: versaoAtual, versaoDepois: versaoNova, backup,
    });
    return {
      status: 200,
      corpo: { ok: true, versao: versaoNova, atualizadoEm: st ? st.mtime.toISOString() : agora.toISOString(), backup },
    };
  }

  return { cerebro, ler, gravar, BACKUP_DIR, LOG_EDICOES };
}

module.exports = { buildMemoria, EDITAVEIS, _interno: { secoes, secaoVazia, versaoDe, normal } };
