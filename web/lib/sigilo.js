'use strict';
// Modo escondido (o olhinho da conversa): aponta os trechos sensíveis de cada texto para a tela
// trocar por asteriscos. O modelo NÃO reescreve nada: devolve só a lista dos trechos, copiados
// exatamente como aparecem. Assim o texto fica intacto, a resposta é curta e barata, e um nome
// achado numa mensagem some de todas as outras na tela.
//
// Provedor (a primeira chave que existir no web.env/ambiente):
//   ANTHROPIC_API_KEY -> Claude Haiku   (Messages API)
//   OPENAI_API_KEY    -> gpt-4.1-mini   (chat/completions, JSON)
// Sem nenhuma chave não chama modelo nenhum: devolve trechos vazios e `so_regex: true`, e a tela
// segue só com o filtro automático dela (e-mail, valor, CPF, telefone, chave).
//
// Variáveis: DGCLAW_SIGILO_MODELO (troca o modelo), DGCLAW_SIGILO_LIBERADOS (nomes que nunca
// somem, separados por vírgula), ANTHROPIC_BASE_URL / OPENAI_BASE_URL (para testes e proxies).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { gravaArquivoSeguro } = require('./grava-seguro');
// Gancho enterprise: com `sigilo_externo` desligado nenhum texto sai para modelo externo (ver ent/sigilo.js).
const { externoPermitido, MENSAGEM_BLOQUEIO } = require('./ent/sigilo');

const MAX_ITENS = 600;
const LOTE = 12;
const PARALELO = 8;
const MAX_CHARS = 6000;          // por texto: o resto da mensagem fica só com o filtro da tela
const MAX_CACHE = 20000;         // entradas; passou disso, as mais antigas saem
const MODELO_CLAUDE = 'claude-haiku-4-5';
const MODELO_OPENAI = 'gpt-4.1-mini';

// Nomes que nunca somem, mesmo se o modelo apontar: um trecho achado numa mensagem some de TODAS,
// então "Claude" apontado uma vez apagaria o nome do assistente na conversa inteira.
const LIBERADOS_PADRAO = [
  'DG Claw', 'Claude', 'Claude Code', 'Anthropic', 'OpenAI', 'ChatGPT', 'Codex', 'Gemini', 'Telegram',
  'WhatsApp', 'Google', 'GitHub', 'Instagram', 'Meta', 'Facebook', 'YouTube', 'TikTok', 'LinkedIn',
  'Cloudflare', 'Hotmart', 'Kiwify', 'Pix', 'Gmail', 'Notion', 'Slack', 'Zoom', 'Canva', 'Stripe',
  'Vercel', 'Docker', 'Ubuntu', 'Linux', 'Hostinger', 'RunPod',
];

// Mudar este prompt muda o hash e invalida o cache inteiro (a próxima ativação reanalisa tudo).
const SISTEMA = `Você protege a tela de uma pessoa que vai mostrar a conversa de trabalho dela com assistentes de IA \
numa aula, palestra ou gravação. Recebe mensagens reais entre o dono (a pessoa que usa o sistema) e os \
agentes de IA dele. Sua tarefa é APONTAR os trechos sensíveis.

Para cada mensagem, devolva a lista de trechos sensíveis COPIADOS EXATAMENTE como aparecem no texto \
(mesmas letras, maiúsculas, acentos e espaços), sem explicar. Na dúvida, aponte: esconder demais é \
aceitável, vazar não é.

É SENSÍVEL:
- nome de pessoa que não seja o dono nem um dos agentes: nome completo, primeiro nome sozinho, apelido,
  sobrenome (aponte cada forma que aparecer: "Ana Paula" e "Ana")
- nome de empresa, cliente, fornecedor, escola, banco ou instituição de terceiro
- @usuário e handle de terceiro, e-mail, telefone, CPF, CNPJ, RG, endereço, CEP
- qualquer valor em dinheiro ("R$ 35k", "1.997 reais", "US$ 200", "35 mil")
- chave de API, token, senha, segredo, id de pedido, transação ou reunião, código de convite
- em link com identificador ou convite, só a parte identificadora (o domínio fica)
- nome de aluno, lead, participante ou paciente

NÃO é sensível (é o que a pessoa quer mostrar):
- o nome do dono e os nomes dos agentes (a lista vem na mensagem do usuário, em "liberados")
- produto, curso, ferramenta, plataforma e tecnologia conhecida (Claude, OpenAI, Telegram, WhatsApp,
  Google, GitHub, Instagram, Pix...)
- horário, data, métrica sem dono, caminho de arquivo e comando sem segredo

Responda SÓ com JSON: {"r":[{"i":<índice>,"s":["trecho", ...]}, ...]}. A lista "r" tem UM item para \
CADA mensagem recebida, inclusive as que não têm nada sensível: essas vêm com "s": []. Nunca pule um índice.`;

/** Tira chave de qualquer texto que vá para log ou resposta (a OpenAI devolve parte da chave no 401). */
function limpaSegredo(texto, chave) {
  let s = String(texto || '');
  if (chave) s = s.split(chave).join('[chave]');
  return s.replace(/\b(?:sk|pk|ghp|gho|xoxb)-[A-Za-z0-9_-]{6,}/g, '[chave]').replace(/\s+/g, ' ');
}

function criarSigilo({ env, registro, dataDir, log, timeoutMs, dono, protecoes }) {
  env = env || {};
  const chaveClaude = env.ANTHROPIC_API_KEY || '';
  const chaveOpenai = env.OPENAI_API_KEY || '';
  const provedor = chaveClaude ? 'anthropic' : (chaveOpenai ? 'openai' : null);
  const chave = provedor === 'anthropic' ? chaveClaude : chaveOpenai;
  const modelo = provedor
    ? (env.DGCLAW_SIGILO_MODELO || (provedor === 'anthropic' ? MODELO_CLAUDE : MODELO_OPENAI))
    : null;
  const urlClaude = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const urlOpenai = (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
  const limite = timeoutMs || 90000;
  const hashPrompt = crypto.createHash('sha1').update(`${SISTEMA}|${modelo}`).digest('hex').slice(0, 8);
  const caminhoCache = dataDir ? path.join(dataDir, 'sigilo-cache.json') : null;

  const semChave = 'Sem chave de modelo, só o filtro automático (e-mail, valor, CPF, telefone, chave) está escondendo. ' +
    'Nomes de pessoas e empresas passam. Para ligar, peça ao Admin: "liga o modo escondido completo" ' +
    '(ele copia ANTHROPIC_API_KEY ou OPENAI_API_KEY do cofre para o web.env).';

  /** Enterprise: lido a cada chamada, porque `dgclaw nivel ajustar` vale sem reiniciar o Web. */
  const bloqueado = () => !externoPermitido(protecoes, log);

  /** Nomes que nunca somem: dono, agentes do registro, plataformas conhecidas e o que o dono listou. */
  function liberados() {
    const s = new Set(LIBERADOS_PADRAO.map((x) => x.toLowerCase()));
    const add = (v) => { if (typeof v === 'string' && v.trim()) s.add(v.trim().toLowerCase()); };
    String(env.DGCLAW_SIGILO_LIBERADOS || '').split(',').forEach(add);
    add(dono);
    try {
      const est = registro && registro.estado ? registro.estado() : null;
      for (const a of (est && est.agentes) || []) { add(a.nome); add(a.slug); add(a.dono); }
    } catch (e) {
      log('aviso', `Modo escondido: não li o registro de agentes para a lista de nomes liberados (${e.message}). Sigo só com os nomes padrão.`);
    }
    return s;
  }

  // ── cache por texto, em disco ──────────────────────────────────────────
  let cache = null;               // Map chave -> [trechos]
  function carregaCache() {
    if (cache) return cache;
    cache = new Map();
    if (!caminhoCache) return cache;
    let bruto;
    try { bruto = fs.readFileSync(caminhoCache, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Modo escondido: não consegui ler o cache ${caminhoCache} (${e.code || e.message}). Começo vazio; o modelo reanalisa o que for preciso.`);
      return cache;
    }
    try {
      const obj = JSON.parse(bruto);
      for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) cache.set(k, v.filter((x) => typeof x === 'string'));
    } catch (e) {
      log('aviso', `Modo escondido: o cache ${caminhoCache} está ilegível (${e.message}). Começo vazio e ele é regravado na próxima análise.`);
    }
    return cache;
  }
  function gravaCache() {
    if (!caminhoCache || !cache) return;
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    try {
      gravaArquivoSeguro(caminhoCache, JSON.stringify(Object.fromEntries(cache)), { raiz: dataDir, modo: 0o600 });
    } catch (e) {
      log('erro', `Modo escondido: não consegui gravar o cache em ${caminhoCache} (${e.code || e.message}). A análise segue valendo, mas será refeita depois de reiniciar. Confira a pasta de dados do Web.`);
    }
  }
  const chaveDe = (texto) => crypto.createHash('sha1').update(`${hashPrompt}|${texto}`).digest('hex').slice(0, 24);

  // ── chamada ao modelo ──────────────────────────────────────────────────
  async function chamaApi(usuario) {
    // Segunda trava: mesmo que algum caminho novo chegue aqui, com `sigilo_externo` desligado o texto não sai.
    if (bloqueado()) throw new Error(MENSAGEM_BLOQUEIO);
    let url; let init;
    if (provedor === 'anthropic') {
      url = `${urlClaude}/v1/messages`;
      init = {
        method: 'POST',
        headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelo, max_tokens: 4096, temperature: 0, system: SISTEMA, messages: [{ role: 'user', content: usuario }] }),
      };
    } else {
      url = `${urlOpenai}/v1/chat/completions`;
      init = {
        method: 'POST',
        headers: { Authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelo, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SISTEMA }, { role: 'user', content: usuario }] }),
      };
    }
    const nome = provedor === 'anthropic' ? 'Claude' : 'OpenAI';
    let r;
    try {
      r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(limite) }, init));
    } catch (e) {
      throw new Error(`não consegui falar com ${nome} (${e.name === 'TimeoutError' ? 'demorou mais de ' + Math.round(limite / 1000) + ' s' : limpaSegredo(e.message, chave)})`);
    }
    if (!r.ok) {
      let detalhe = '';
      try { detalhe = limpaSegredo((await r.text()).slice(0, 200), chave); } catch (_) { /* sem corpo */ }
      const dica = r.status === 401 || r.status === 403 ? ' A chave do web.env foi recusada: confira se está certa.'
        : (r.status === 429 || r.status === 402 ? ' O limite ou o crédito da conta pode ter acabado.' : '');
      throw new Error(`${nome} respondeu HTTP ${r.status}${detalhe ? ` (${detalhe})` : ''}.${dica}`);
    }
    let j;
    try { j = await r.json(); } catch (_) { throw new Error(`${nome} respondeu algo que não é JSON`); }
    const texto = provedor === 'anthropic'
      ? ((j.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join(''))
      : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return String(texto || '');
  }

  /** [texto] -> [[trechos]] na mesma ordem. Lança Error com o motivo se o lote não vier utilizável. */
  async function analisaLote(textos, lib) {
    const carga = textos.map((t, i) => ({ i, t: t.slice(0, MAX_CHARS) }));
    const usuario = `São ${textos.length} mensagens (índices 0 a ${textos.length - 1}). Devolva os ${textos.length} itens.\n` +
      `liberados (nunca aponte): ${JSON.stringify(Array.from(lib).slice(0, 80))}\n` + JSON.stringify(carga);
    const conteudo = await chamaApi(usuario);
    const ini = conteudo.indexOf('{'); const fim = conteudo.lastIndexOf('}');
    let linhas;
    try {
      linhas = JSON.parse(ini >= 0 && fim > ini ? conteudo.slice(ini, fim + 1) : conteudo).r;
    } catch (e) {
      throw new Error(`o modelo não devolveu JSON (${e.message}): ${limpaSegredo(conteudo.slice(0, 120), chave)}`);
    }
    if (!Array.isArray(linhas)) throw new Error('o modelo devolveu JSON sem a lista "r"');
    const achou = new Map();
    for (const l of linhas) {
      const i = Number(l && l.i);
      if (Number.isInteger(i) && i >= 0 && i < textos.length && Array.isArray(l.s)) achou.set(i, l.s.map(String));
    }
    for (let i = 0; i < textos.length; i++) {
      if (achou.has(i)) continue;
      // o modelo às vezes pula a mensagem sem nada sensível: ela vai de novo sozinha
      // (pular de novo, aí, é falha de verdade e sobe como erro)
      if (textos.length === 1) throw new Error('o modelo não devolveu a análise da mensagem');
      achou.set(i, (await analisaLote([textos[i]], lib))[0]);
    }
    return textos.map((t, i) => {
      // trecho que não está no texto é invenção do modelo: fora
      const vistos = new Set(); const ok = [];
      for (const bruto of achou.get(i)) {
        const x = bruto.trim();
        if (x.length >= 2 && t.includes(x) && !vistos.has(x) && !lib.has(x.toLowerCase())) { vistos.add(x); ok.push(x); }
      }
      return ok;
    });
  }

  async function emParalelo(tarefas, n) {
    const saida = new Array(tarefas.length);
    let prox = 0;
    async function trabalhador() {
      while (prox < tarefas.length) { const k = prox++; saida[k] = await tarefas[k](); }
    }
    await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trabalhador));
    return saida;
  }

  /** Valida o corpo do POST. Devolve { textos } ou { erro } (para 400). */
  function validaEntrada(corpo) {
    const t = corpo && corpo.textos;
    if (t === undefined) return { erro: 'Faltou o campo "textos". Mande {"textos": ["mensagem 1", "mensagem 2"]}.' };
    if (!Array.isArray(t)) return { erro: `O campo "textos" precisa ser uma lista de textos. Recebi: ${typeof t}.` };
    if (t.length > MAX_ITENS) return { erro: `Até ${MAX_ITENS} textos por chamada (vieram ${t.length}). Divida em partes.` };
    const ruim = t.findIndex((x) => typeof x !== 'string');
    if (ruim >= 0) return { erro: `Todo item de "textos" precisa ser texto. O item ${ruim} é do tipo ${tipoDe(t[ruim])}.` };
    return { textos: t };
  }
  const tipoDe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'lista' : typeof v);

  return {
    modelo, provedor, semChave, validaEntrada, liberados,
    get soRegex() { return !provedor || bloqueado(); },
    estado() {
      if (bloqueado()) return { modelo: null, provedor: null, so_regex: true, aviso: MENSAGEM_BLOQUEIO, bloqueado_por: 'sigilo_externo' };
      return { modelo, provedor, so_regex: !provedor, aviso: provedor ? null : semChave };
    },

    /** { trechos, avisos, analisados, modelo, so_regex } */
    async analisar(textos) {
      if (bloqueado()) {
        return { trechos: textos.map(() => []), avisos: [MENSAGEM_BLOQUEIO], analisados: 0, modelo: null, so_regex: true };
      }
      if (!provedor) {
        return { trechos: textos.map(() => []), avisos: [semChave], analisados: 0, modelo: null, so_regex: true };
      }
      const t0 = Date.now();
      const lib = liberados();
      const c = carregaCache();
      const saida = new Array(textos.length).fill(null);
      const pend = new Map();                    // chave -> { texto, idx: [] }
      textos.forEach((t, n) => {
        if (!t.trim()) { saida[n] = []; return; }
        const k = chaveDe(t);
        if (c.has(k)) { saida[n] = c.get(k).filter((x) => !lib.has(x.toLowerCase())); return; }
        if (!pend.has(k)) pend.set(k, { texto: t, idx: [] });
        pend.get(k).idx.push(n);
      });
      const avisos = [];
      const itens = Array.from(pend.entries());
      if (itens.length) {
        const lotes = [];
        for (let i = 0; i < itens.length; i += LOTE) lotes.push(itens.slice(i, i + LOTE));
        const guarda = (k, p, trechos) => { c.set(k, trechos); for (const n of p.idx) saida[n] = trechos.filter((x) => !lib.has(x.toLowerCase())); };
        await emParalelo(lotes.map((lote) => async () => {
          try {
            const res = await analisaLote(lote.map(([, p]) => p.texto), lib);
            lote.forEach(([k, p], j) => guarda(k, p, res[j]));
            return;
          } catch (e) {
            log('aviso', `Modo escondido: o lote de ${lote.length} mensagens falhou (${e.message}). Tento uma por uma.`);
          }
          // lote que falha tenta item a item; o que ainda falhar fica null (a tela mantém escondido)
          for (const [k, p] of lote) {
            try {
              guarda(k, p, (await analisaLote([p.texto], lib))[0]);
            } catch (e) {
              const motivo = `${p.texto.length} caracteres: ${e.message}`;
              log('erro', `Modo escondido: não consegui analisar uma mensagem (${motivo}). Ela continua escondida na tela; toque no 👁 para tentar de novo.`);
              if (avisos.length < 5) avisos.push(`Não consegui analisar uma mensagem (${e.message}). Ela continua escondida.`);
            }
          }
        }), PARALELO);
        gravaCache();
        const achados = saida.reduce((s, x) => s + (x ? x.length : 0), 0);
        log('info', `Modo escondido: ${textos.length} textos, ${itens.length} novos para o modelo ${modelo}, ${achados} trechos apontados, ${((Date.now() - t0) / 1000).toFixed(1)} s${avisos.length ? `, ${avisos.length} falha(s)` : ''}.`);
      }
      return { trechos: saida, avisos, analisados: itens.length, modelo, so_regex: false };
    },
  };
}

module.exports = { criarSigilo, LIBERADOS_PADRAO, MAX_ITENS, MODELO_CLAUDE, MODELO_OPENAI };
