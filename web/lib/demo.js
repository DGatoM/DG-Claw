'use strict';
// Modo demonstração: o Portão do agente, os cartões de confirmação e o Reset. Contrato em docs/MODO-DEMONSTRACAO.md.
//
// O agente fala só com as rotas /api/demo/v1/* (Bearer). Nenhuma delas manda ou lê nada sozinha: cada pedido vira um
// cartão em <dados>/demo/cartoes, e só o clique do dono (rotas /api/demo/*, com sessão e Origin) o executa. Sem
// DGCLAW_DEMO_CONFIG nada disto existe: tudo responde 404 e o menu não muda.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const H = require('./http');
const { criarProvedores, ErroDemo, soDigitos } = require('./demo-provedores');

const RX_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RX_ID_LINHA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RX_ID_CARTAO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RX_EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const VALIDADE_CARTAO_MS = 10 * 60 * 1000;
const VALIDADE_LIBERACAO_MS = 30 * 60 * 1000;
const RECENTES_MS = 3 * 60 * 1000;
const CACHE_CANDIDATOS_MS = 2 * 60 * 1000;
const LIMITE_POR_MINUTO = 60;
const MAX_ABERTOS = 10;
const MAX_CORPO = 256 * 1024;
const MAX_TEXTO_WHATSAPP = 4000;
const MAX_TEXTO_EMAIL = 20000;
const MAX_ANEXOS = 5;
const MAX_ANEXOS_BYTES = 20 * 1024 * 1024;
const MAX_ANEXO_EMAIL_BYTES = 10 * 1024 * 1024;
const PASTAS_ANEXO = ['arquivos', 'saida'];
const FRASE_RESET = 'NOVO CLIENTE';

const MIMES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** "+55 ••••• 1234": o DDI e os quatro últimos dígitos, o que basta para a pessoa reconhecer. */
function mascarar(tel) {
  const d = soDigitos(tel);
  if (d.length < 8) return '••••';
  return `+${d.slice(0, 2)} ••••• ${d.slice(-4)}`;
}

function mascararEmail(e) {
  const [u, dom] = String(e).split('@');
  return `${(u || '').slice(0, 1)}***@${dom || ''}`;
}

/** Telefone só com dígitos e DDI. 10 ou 11 dígitos são tratados como brasileiros (prefixo 55). Inválido: null. */
function normalizaTelefone(s) {
  let d = soDigitos(s);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? d : null;
}

// ── configuração ───────────────────────────────────────────────────────────
function permissaoFechada(st) { return (st.mode & 0o077) === 0; }

/** Lê e valida o demo.json. Devolve { config } ou { erro } com o motivo e o que fazer. Nunca lança. */
function carregarConfig(caminho) {
  const falha = (m) => ({ erro: m });
  let st;
  try { st = fs.statSync(caminho); } catch (e) { return falha(`Não achei o arquivo do modo demonstração ${caminho} (${e.code || e.message}). Confira DGCLAW_DEMO_CONFIG.`); }
  if (!st.isFile()) return falha(`${caminho} não é um arquivo comum. Aponte DGCLAW_DEMO_CONFIG para o demo.json.`);
  if (!permissaoFechada(st)) return falha(`O arquivo ${caminho} está com permissão aberta demais (${(st.mode & 0o777).toString(8)}). Rode: chmod 600 ${caminho}`);
  if (typeof process.getuid === 'function' && st.uid !== 0 && st.uid !== process.getuid()) return falha(`O arquivo ${caminho} não é do root nem do usuário do painel. Rode: chown root:root ${caminho}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (e) { return falha(`O arquivo ${caminho} não é um JSON válido (${e.message}).`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return falha(`O arquivo ${caminho} precisa conter um objeto JSON.`);
  if (j.versao !== 1) return falha(`O demo.json tem "versao" ${JSON.stringify(j.versao)}; só conheço a versão 1.`);
  const texto = (v, campo, rx) => { if (typeof v !== 'string' || !v.trim() || (rx && !rx.test(v))) throw new Error(`o campo "${campo}" está ausente ou inválido`); return v; };
  const chaveOk = (c, onde) => {
    if (typeof c.chave_arquivo !== 'string' || !path.isAbsolute(c.chave_arquivo)) throw new Error(`${onde}: "chave_arquivo" precisa ser um caminho absoluto`);
    let sc;
    try { sc = fs.statSync(c.chave_arquivo); } catch (e) { throw new Error(`${onde}: o arquivo da chave ${c.chave_arquivo} não existe (${e.code || e.message})`); }
    if (!sc.isFile() || sc.size === 0) throw new Error(`${onde}: ${c.chave_arquivo} não é um arquivo com a chave dentro`);
    if (!permissaoFechada(sc)) throw new Error(`${onde}: o arquivo da chave ${c.chave_arquivo} está com permissão aberta demais. Rode: chmod 600 ${c.chave_arquivo}`);
  };
  try {
    const config = {
      versao: 1,
      instancia: texto(j.instancia, 'instancia', RX_SLUG),
      agente: texto(j.agente, 'agente', RX_SLUG),
      url_publica: typeof j.url_publica === 'string' ? j.url_publica : null,
      linhas_whatsapp: [],
      email: null,
      crm: j.crm && typeof j.crm === 'object' ? j.crm : null,
      imagem: j.imagem && typeof j.imagem === 'object' ? j.imagem : null,
      destinos_de_teste: [],
    };
    const hash = texto(j.token_agente_sha256, 'token_agente_sha256', /^[0-9a-f]{64}$/i).toLowerCase();
    if (!Array.isArray(j.linhas_whatsapp) || !j.linhas_whatsapp.length) throw new Error('"linhas_whatsapp" precisa ter pelo menos uma linha');
    const ids = new Set();
    for (const [i, l] of j.linhas_whatsapp.entries()) {
      const onde = `linhas_whatsapp[${i}]`;
      if (!l || typeof l !== 'object') throw new Error(`${onde} não é um objeto`);
      const id = texto(l.id, `${onde}.id`, RX_ID_LINHA);
      if (ids.has(id)) throw new Error(`${onde}: o id "${id}" aparece duas vezes`);
      ids.add(id);
      if (l.tipo !== 'organizap' && l.tipo !== 'cpdf') throw new Error(`${onde}: "tipo" precisa ser organizap ou cpdf`);
      texto(l.base, `${onde}.base`, /^https?:\/\//i);
      chaveOk(l, onde);
      config.linhas_whatsapp.push({ id, rotulo: typeof l.rotulo === 'string' && l.rotulo.trim() ? l.rotulo : id, tipo: l.tipo, base: l.base, chave_arquivo: l.chave_arquivo, instancia_id: typeof l.instancia_id === 'string' ? l.instancia_id : null });
    }
    if (j.email != null) {
      if (typeof j.email !== 'object') throw new Error('"email" precisa ser um objeto');
      if (j.email.tipo !== 'organizap') throw new Error('email: "tipo" precisa ser organizap');
      texto(j.email.base, 'email.base', /^https?:\/\//i);
      chaveOk(j.email, 'email');
      config.email = { id: 'email', rotulo: typeof j.email.rotulo === 'string' ? j.email.rotulo : 'E-mail', tipo: 'organizap', base: j.email.base, chave_arquivo: j.email.chave_arquivo };
    }
    if (config.imagem && typeof config.imagem.chave_arquivo === 'string') chaveOk(config.imagem, 'imagem');
    if (j.destinos_de_teste != null) {
      if (!Array.isArray(j.destinos_de_teste)) throw new Error('"destinos_de_teste" precisa ser uma lista');
      for (const d of j.destinos_de_teste) {
        const v = typeof d === 'string' && d.includes('@') ? d.trim().toLowerCase() : normalizaTelefone(d);
        if (!v) throw new Error(`"destinos_de_teste" tem um valor que não é telefone nem e-mail (${JSON.stringify(d)})`);
        config.destinos_de_teste.push(v);
      }
    }
    return { config, hash };
  } catch (e) {
    return falha(`O demo.json (${caminho}) não vale: ${e.message}.`);
  }
}

// ── o módulo ───────────────────────────────────────────────────────────────
function criarDemo({ config: webConfig, registro, log, agora, fetchImpl, spawnImpl, esquecerConversa, resetBin }) {
  const agoraMs = () => +(agora ? agora() : Date.now());
  const caminhoCfg = String((webConfig.env && webConfig.env.DGCLAW_DEMO_CONFIG) || '').trim();
  const extrasTela = [];
  const base = {
    configurado: !!caminhoCfg, ligado: false, motivoDesligado: null, config: null,
    chaveDe() { throw new Error('o modo demonstração está desligado'); },
    registrarRotaTela(fn) { extrasTela.push(fn); },
  };
  const respondeDesligado = (res) => {
    if (!base.configurado) return H.enviaJson(res, 404, { ok: false, codigo: 'DEMO_DESLIGADO', erro: 'O modo demonstração não está ligado nesta instalação.' });
    return H.enviaJson(res, 503, { ok: false, codigo: 'DEMO_COM_DEFEITO', erro: `O modo demonstração está desligado por um defeito na configuração: ${base.motivoDesligado} Corrija e reinicie o painel.` });
  };
  const desligado = Object.assign(base, {
    async rotaAgente(req, res) { respondeDesligado(res); return true; },
    async rotaTela(req, res) { respondeDesligado(res); return true; },
  });
  if (!caminhoCfg) return desligado;

  const lido = carregarConfig(caminhoCfg);
  if (lido.erro) {
    base.motivoDesligado = lido.erro;
    log('erro', `Modo demonstração DESLIGADO: ${lido.erro}`);
    return desligado;
  }
  const cfg = lido.config;
  const tokenHash = Buffer.from(lido.hash, 'hex');
  const chavesPermitidas = new Set([...cfg.linhas_whatsapp.map((l) => l.chave_arquivo), cfg.email && cfg.email.chave_arquivo, cfg.imagem && cfg.imagem.chave_arquivo].filter(Boolean));
  /** Lê a chave de um arquivo que está no demo.json. Para o servidor só; nunca devolva o valor numa resposta. */
  function chaveDe(caminho) {
    if (!chavesPermitidas.has(caminho)) throw new Error(`o caminho ${caminho} não é uma chave do demo.json`);
    const t = fs.readFileSync(caminho, 'utf8').trim();
    if (!t) throw new Error(`o arquivo da chave ${caminho} está vazio`);
    return t;
  }
  const provedores = criarProvedores({ fetchImpl, chaveDe, log });
  const linhaDe = (id) => cfg.linhas_whatsapp.find((l) => l.id === id) || null;

  const pasta = path.join(webConfig.dataDir, 'demo');
  const pastaCartoes = path.join(pasta, 'cartoes');
  const arqAuditoria = path.join(pasta, 'auditoria.jsonl');
  const arqReset = path.join(pasta, 'reset-estado.json');
  const binReset = resetBin || process.env.DGCLAW_DEMO_RESET_BIN || path.join(__dirname, '..', '..', 'bin', 'dgclaw-demo-reset');

  function garantePasta(p) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(p, 0o700); } catch (e) { throw new ErroDemo(500, 'PASTA_DO_DEMO', `Não consegui proteger a pasta ${p} (${e.code || e.message}). Confira as permissões da pasta de dados do painel.`); }
  }

  // ── cartões em disco ────────────────────────────────────────────────────
  function gravaCartao(c) {
    garantePasta(pasta); garantePasta(pastaCartoes);
    const alvo = path.join(pastaCartoes, `${c.id}.json`);
    const tmp = `${alvo}.${process.pid}.tmp`;
    c.atualizado_em = agoraMs();
    try {
      fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
      fs.renameSync(tmp, alvo);
    } catch (e) {
      throw new ErroDemo(500, 'CARTAO_NAO_GRAVADO', `Não consegui guardar o cartão ${c.id} (${e.code || e.message}). Confira o espaço em disco e as permissões de ${pastaCartoes}.`);
    }
  }

  function lerCartaoArquivo(id) {
    let txt;
    try { txt = fs.readFileSync(path.join(pastaCartoes, `${id}.json`), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new ErroDemo(500, 'CARTAO_ILEGIVEL', `Não consegui ler o cartão ${id} (${e.code || e.message}).`);
    }
    try { return JSON.parse(txt); } catch (e) {
      throw new ErroDemo(500, 'CARTAO_ILEGIVEL', `O cartão ${id} está corrompido (${e.message}). Ele foi preservado em ${pastaCartoes}.`);
    }
  }

  /** O cartão, já com a expiração aplicada. Um pedido que expirou nunca mais pode ser confirmado. */
  function lerCartao(id) {
    if (!RX_ID_CARTAO.test(String(id))) return null;
    const c = lerCartaoArquivo(id);
    if (!c) return null;
    if (c.estado === 'aguardando' && agoraMs() > c.expira_em) {
      c.estado = 'expirado';
      c.motivo = 'Ninguém confirmou em 10 minutos. Peça de novo se ainda for preciso.';
      gravaCartao(c);
      auditar('expirou', c);
    }
    if (c.tipo === 'leitura' && c.estado === 'liberado' && agoraMs() > c.liberado_ate) {
      c.estado = 'expirado';
      c.motivo = 'A liberação deste contato durou 30 minutos e acabou. Peça o contato de novo.';
      gravaCartao(c);
    }
    return c;
  }

  function listarCartoes() {
    let nomes;
    try { nomes = fs.readdirSync(pastaCartoes); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw new ErroDemo(500, 'CARTAO_ILEGIVEL', `Não consegui listar ${pastaCartoes} (${e.code || e.message}).`);
    }
    const lista = [];
    for (const n of nomes) {
      const id = n.replace(/\.json$/, '');
      if (n.endsWith('.json') && RX_ID_CARTAO.test(id)) { const c = lerCartao(id); if (c) lista.push(c); }
    }
    return lista.sort((a, b) => a.criado_em - b.criado_em);
  }

  // O que estava `enviando` quando o painel caiu não sabe se saiu: nunca vira "enviado" por conta própria.
  try {
    for (const c of listarCartoes()) {
      if (c.estado === 'enviando') {
        c.estado = 'falhou';
        c.codigo = 'ENVIO_INTERROMPIDO';
        c.motivo = 'O painel reiniciou no meio do envio e não sei se a mensagem saiu. Confira no WhatsApp ou na caixa de enviados antes de pedir de novo.';
        gravaCartao(c);
        auditar('falhou', c, { codigo: c.codigo });
      }
    }
  } catch (e) { log('erro', `Modo demonstração: não consegui revisar os cartões que ficaram em andamento (${e.message}).`); }

  // ── auditoria: nunca o corpo, nunca o número inteiro ────────────────────
  function destinoAuditavel(c) {
    if (c.tipo === 'leitura') return { nome_pedido: c.nome, contato: c.contato ? { nome: c.contato.nome, final: String(c.contato.telefone || '').slice(-4) || null } : null };
    const d = c.destinatario || {};
    return d.para ? { para: mascararEmail(d.para) } : { nome: d.nome || null, final: String(d.telefone || '').slice(-4) || null };
  }

  function auditar(evento, c, extra) {
    garantePasta(pasta);
    const linha = JSON.stringify(Object.assign({
      quando: new Date(agoraMs()).toISOString(), evento, quem: (extra && extra.quem) || c.decidido_por || 'agente',
      id: c.id, tipo: c.tipo, canal: c.canal, linha: c.linha || null,
    }, destinoAuditavel(c), c.texto != null ? { texto_sha256: sha256(c.texto), assunto_sha256: c.assunto ? sha256(c.assunto) : undefined, anexos: (c.anexos || []).map((a) => ({ nome: a.nome, sha256: a.sha256 })) } : {}, extra || {}));
    try {
      fs.appendFileSync(arqAuditoria, linha + '\n', { mode: 0o600 });
      fs.chmodSync(arqAuditoria, 0o600);
    } catch (e) {
      throw new ErroDemo(500, 'AUDITORIA_INDISPONIVEL', `Não consegui gravar a auditoria em ${arqAuditoria} (${e.code || e.message}). Por segurança nada foi feito. Confira o espaço em disco e as permissões.`);
    }
  }

  // ── anexos ──────────────────────────────────────────────────────────────
  /** Abre um anexo da casa do agente sem seguir atalho. Devolve { nome, mime, dados, sha256, tamanho }. */
  function lerAnexoSeguro(caminho) {
    const agente = registro.obter(cfg.agente);
    if (!agente || !agente.home_host) throw new ErroDemo(500, 'AGENTE_SEM_CASA', `Não achei a casa do agente "${cfg.agente}" no registro, então não consigo conferir o anexo ${caminho}. Peça ao dono para conferir o agentes.json.`);
    const homeC = (agente.home_container || '/home/agente').replace(/\/+$/, '');
    const homeH = agente.home_host.replace(/\/+$/, '');
    if (typeof caminho !== 'string' || !caminho.startsWith(homeC + '/')) throw new ErroDemo(422, 'ANEXO_FORA_DA_PASTA', `O anexo ${String(caminho).slice(0, 120)} não está em ${homeC}/arquivos nem em ${homeC}/saida. Nada foi pedido.`);
    const partes = caminho.slice(homeC.length + 1).split('/');
    if (!PASTAS_ANEXO.includes(partes[0]) || partes.length < 2) throw new ErroDemo(422, 'ANEXO_FORA_DA_PASTA', `O anexo ${caminho.slice(0, 120)} não está em ${homeC}/arquivos nem em ${homeC}/saida. Nada foi pedido.`);
    for (const p of partes) {
      if (!p || p.startsWith('.') || p.includes('\0') || p.includes('\\')) throw new ErroDemo(422, 'ANEXO_CAMINHO_INVALIDO', `O caminho do anexo ${caminho.slice(0, 120)} tem um componente vazio, com ponto ou inválido. Use o caminho direto do arquivo, sem "." nem "..".`);
    }
    let atual = homeH;
    let ls;
    for (const [i, p] of partes.entries()) {
      atual = path.join(atual, p);
      try { ls = fs.lstatSync(atual); } catch (e) { throw new ErroDemo(422, 'ANEXO_NAO_ENCONTRADO', `O anexo ${caminho.slice(0, 120)} não existe (${e.code || e.message}).`); }
      if (ls.isSymbolicLink()) throw new ErroDemo(422, 'ANEXO_COM_ATALHO', `O anexo ${caminho.slice(0, 120)} passa por um atalho (link simbólico), que o Portão não segue. Copie o arquivo de verdade para ${homeC}/saida.`);
      if (i < partes.length - 1 && !ls.isDirectory()) throw new ErroDemo(422, 'ANEXO_CAMINHO_INVALIDO', `O caminho do anexo ${caminho.slice(0, 120)} passa por algo que não é pasta.`);
    }
    if (!ls.isFile()) throw new ErroDemo(422, 'ANEXO_NAO_E_ARQUIVO', `O anexo ${caminho.slice(0, 120)} não é um arquivo comum.`);
    if (ls.nlink > 1) throw new ErroDemo(422, 'ANEXO_COM_HARDLINK', `O anexo ${caminho.slice(0, 120)} tem mais de um nome no disco (hardlink), e o Portão não o aceita. Copie o arquivo para ${homeC}/saida.`);
    if (ls.size > MAX_ANEXOS_BYTES) throw new ErroDemo(422, 'ANEXO_GRANDE', `O anexo ${caminho.slice(0, 120)} tem ${Math.round(ls.size / 1048576)} MB; o limite é 20 MB.`);
    let fd;
    try {
      fd = fs.openSync(atual, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const fs2 = fs.fstatSync(fd);
      if (!fs2.isFile() || fs2.ino !== ls.ino || fs2.dev !== ls.dev || fs2.nlink > 1) throw new ErroDemo(409, 'ANEXO_MUDOU', `O anexo ${caminho.slice(0, 120)} foi trocado enquanto eu o abria. Nada foi pedido.`);
      if (fs.realpathSync(atual) !== atual) throw new ErroDemo(422, 'ANEXO_COM_ATALHO', `O anexo ${caminho.slice(0, 120)} passa por um atalho, que o Portão não segue.`);
      const dados = fs.readFileSync(fd);
      const nome = partes[partes.length - 1];
      return { nome, mime: MIMES[path.extname(nome).toLowerCase()] || 'application/octet-stream', dados, sha256: sha256(dados), tamanho: dados.length };
    } catch (e) {
      if (e instanceof ErroDemo) throw e;
      throw new ErroDemo(422, 'ANEXO_ILEGIVEL', `Não consegui abrir o anexo ${caminho.slice(0, 120)} (${e.code || e.message}).`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // ── conferências comuns ─────────────────────────────────────────────────
  function destinoPermitido(c) {
    if (!cfg.destinos_de_teste.length) return true;
    const d = c.destinatario || {};
    const v = d.para ? String(d.para).toLowerCase() : d.telefone;
    return !!v && cfg.destinos_de_teste.includes(v);
  }
  const erroDestinoDeTeste = () => new ErroDemo(403, 'DESTINO_FORA_DO_TESTE', 'Esta instalação está em fase de teste e só envia para os destinos de teste combinados. Esse destinatário não está na lista, então nada foi enviado. Se for um engano, peça ao dono para ajustar "destinos_de_teste".');

  const janelaAgente = []; // instantes dos últimos pedidos
  function limiteDeTaxa() {
    const t = agoraMs();
    while (janelaAgente.length && t - janelaAgente[0] > 60000) janelaAgente.shift();
    if (janelaAgente.length >= LIMITE_POR_MINUTO) return Math.max(1, Math.ceil((60000 - (t - janelaAgente[0])) / 1000));
    janelaAgente.push(t);
    return 0;
  }

  function bearerValido(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const h = crypto.createHash('sha256').update(m[1]).digest();
    return h.length === tokenHash.length && crypto.timingSafeEqual(h, tokenHash);
  }

  const erro = (res, e) => {
    if (e instanceof ErroDemo) return H.enviaJson(res, e.status, Object.assign({ ok: false, codigo: e.codigo, erro: e.message }, e.extra || {}));
    if (e && e.status && e.message && !(e instanceof TypeError)) return H.enviaJson(res, e.status, { ok: false, codigo: 'PEDIDO_INVALIDO', erro: e.message });
    log('erro', `Modo demonstração: falha inesperada (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}).`);
    return H.enviaJson(res, 500, { ok: false, codigo: 'ERRO_INTERNO', erro: 'Erro interno do modo demonstração. O detalhe está no log do painel; tente de novo e, se repetir, avise quem instalou.' });
  };
  const ruim = (status, codigo, msg) => new ErroDemo(status, codigo, msg);

  let resetando = false;
  // Geração: sobe quando um reset começa e quando termina. Todo pedido que espera o provedor guarda a geração em que
  // entrou e, ao voltar, confere: se mudou, o cliente anterior já foi arquivado e nada dele pode ser recriado.
  let geracao = 0;
  const erroGeracao = () => ruim(503, 'RESET_EM_ANDAMENTO', 'Houve um reset enquanto este pedido era feito, então ele foi descartado. Nada foi criado nem enviado. Comece de novo com o cliente atual.');
  const confereGeracao = (g) => { if (g !== geracao || resetando) throw erroGeracao(); };
  const abertos = () => listarCartoes().filter((c) => c.estado === 'aguardando').length;

  // ── Portão: rotas do agente ─────────────────────────────────────────────
  async function criarLeitura(corpo) {
    const g = geracao;
    const l = linhaDe(corpo.linha);
    if (!l) throw ruim(404, 'LINHA_DESCONHECIDA', `Não existe a linha "${String(corpo.linha).slice(0, 40)}". As linhas são: ${cfg.linhas_whatsapp.map((x) => x.id).join(', ')}.`);
    const nome = typeof corpo.nome === 'string' ? corpo.nome.trim() : '';
    if (nome.length < 3) throw ruim(400, 'NOME_CURTO', 'O "nome" precisa ter 3 caracteres ou mais. Peça ao usuário o nome completo do contato.');
    if (nome.length > 80) throw ruim(400, 'NOME_LONGO', 'O "nome" passou de 80 caracteres. Mande só o nome da pessoa.');
    if (abertos() >= MAX_ABERTOS) throw ruim(429, 'MUITOS_CARTOES_ABERTOS', 'Já há 10 cartões esperando confirmação na tela. Peça ao usuário para decidir os que estão abertos antes de pedir outro.');
    const t = agoraMs();
    const c = { id: crypto.randomUUID(), tipo: 'leitura', canal: 'whatsapp', linha: l.id, nome, estado: 'aguardando', criado_em: t, expira_em: t + VALIDADE_CARTAO_MS };
    confereGeracao(g);
    gravaCartao(c);
    auditar('pediu', c);
    return { id: c.id, estado: c.estado, aviso: 'Peça ao usuário para confirmar na tela e acompanhe com GET /api/demo/v1/contato/<id>.' };
  }

  function leituraLiberada(ref, linha) {
    const c = lerCartao(ref);
    if (!c || c.tipo !== 'leitura') throw ruim(404, 'CONTATO_NAO_LIBERADO', 'Esse contato não foi liberado. Peça o contato com POST /api/demo/v1/contato e espere o usuário confirmar na tela.');
    if (c.estado !== 'liberado') {
      const porEstado = { aguardando: 'O usuário ainda não confirmou na tela.', recusado: 'O usuário recusou abrir esta conversa.', expirado: 'A liberação expirou; peça o contato de novo.' };
      throw ruim(409, 'CONTATO_NAO_LIBERADO', `Esse contato não está liberado (${c.estado}). ${porEstado[c.estado] || ''}`.trim());
    }
    if (linha && linha !== c.linha) throw ruim(400, 'LINHA_DIFERENTE', `Esse contato foi liberado na linha "${c.linha}", não em "${linha}".`);
    return c;
  }

  async function criarEnvio(corpo) {
    const g = geracao;
    const canal = corpo.canal;
    if (canal !== 'whatsapp' && canal !== 'email') throw ruim(400, 'CANAL_INVALIDO', 'O "canal" precisa ser "whatsapp" ou "email".');
    const texto = corpo.texto;
    const maxTexto = canal === 'email' ? MAX_TEXTO_EMAIL : MAX_TEXTO_WHATSAPP;
    if (typeof texto !== 'string' || !texto.trim()) throw ruim(400, 'TEXTO_OBRIGATORIO', 'Falta o "texto" da mensagem (texto não vazio).');
    if (texto.includes('\0')) throw ruim(400, 'TEXTO_INVALIDO', 'O "texto" tem um caractere inválido (nulo).');
    if (texto.length > maxTexto) throw ruim(400, 'TEXTO_GRANDE', `O "texto" tem ${texto.length} caracteres e o limite é ${maxTexto}. Encurte e tente de novo.`);
    const caminhos = corpo.anexos === undefined ? [] : corpo.anexos;
    if (!Array.isArray(caminhos) || caminhos.some((x) => typeof x !== 'string')) throw ruim(400, 'ANEXOS_INVALIDOS', '"anexos" precisa ser uma lista de caminhos (texto).');
    if (caminhos.length > MAX_ANEXOS) throw ruim(422, 'ANEXOS_DEMAIS', `No máximo ${MAX_ANEXOS} anexos por envio (vieram ${caminhos.length}).`);
    const anexos = [];
    let total = 0;
    for (const cam of caminhos) {
      const a = lerAnexoSeguro(cam);
      total += a.tamanho;
      if (total > MAX_ANEXOS_BYTES) throw ruim(422, 'ANEXOS_GRANDES', 'Os anexos somam mais de 20 MB. Mande menos arquivos ou arquivos menores.');
      if (canal === 'email' && a.tamanho > MAX_ANEXO_EMAIL_BYTES) throw ruim(422, 'ANEXO_GRANDE_PARA_EMAIL', `O anexo ${a.nome} passa de 10 MB, o limite do e-mail.`);
      anexos.push({ caminho: cam, nome: a.nome, mime: a.mime, tamanho: a.tamanho, sha256: a.sha256 });
    }
    if (abertos() >= MAX_ABERTOS) throw ruim(429, 'MUITOS_CARTOES_ABERTOS', 'Já há 10 cartões esperando confirmação na tela. Peça ao usuário para decidir os que estão abertos antes de pedir outro.');
    const t = agoraMs();
    const c = { id: crypto.randomUUID(), tipo: 'envio', canal, texto, anexos, estado: 'aguardando', criado_em: t, expira_em: t + VALIDADE_CARTAO_MS };

    if (canal === 'email') {
      if (!cfg.email) throw ruim(422, 'SEM_EMAIL', 'Esta instalação não tem e-mail configurado no modo demonstração.');
      const para = typeof corpo.para === 'string' ? corpo.para.trim() : '';
      if (!RX_EMAIL.test(para) || para.length > 254) throw ruim(400, 'EMAIL_INVALIDO', 'O campo "para" precisa ser um único endereço de e-mail válido.');
      const assunto = typeof corpo.assunto === 'string' ? corpo.assunto.trim() : '';
      if (!assunto || assunto.length > 200 || /[\r\n]/.test(assunto)) throw ruim(400, 'ASSUNTO_INVALIDO', 'O "assunto" precisa ter de 1 a 200 caracteres, em uma linha só.');
      c.linha = 'email';
      c.assunto = assunto;
      c.destinatario = { para, via: 'email' };
    } else {
      const l = linhaDe(corpo.linha);
      if (!l) throw ruim(404, 'LINHA_DESCONHECIDA', `Não existe a linha "${String(corpo.linha).slice(0, 40)}". As linhas são: ${cfg.linhas_whatsapp.map((x) => x.id).join(', ')}.`);
      if (l.tipo === 'cpdf' && anexos.length) throw ruim(422, 'ANEXO_NAO_SUPORTADO_NA_LINHA', 'Esta linha (CPDF) só envia texto. Mande sem anexos ou use uma linha do Organizap.');
      if ((corpo.ref == null) === (corpo.telefone == null)) throw ruim(400, 'DESTINO_AMBIGUO', 'Mande "ref" (de um contato liberado) ou "telefone", um dos dois.');
      c.linha = l.id;
      if (corpo.ref != null) {
        const lib = leituraLiberada(String(corpo.ref), l.id);
        c.destinatario = { nome: lib.contato.nome, telefone: lib.contato.telefone, ref_provedor: lib.contato.ref_provedor, via: 'contato' };
      } else {
        const tel = normalizaTelefone(corpo.telefone);
        if (!tel) throw ruim(400, 'TELEFONE_INVALIDO', 'O "telefone" precisa ter DDI e DDD (de 12 a 15 dígitos, ex.: 5511999990000).');
        const achado = await provedores.resolverPorTelefone(l, tel);
        confereGeracao(g);
        if (l.tipo === 'organizap' && !achado) throw ruim(422, 'SEM_CONVERSA_ABERTA', `Esse WhatsApp só fala com quem já tem conversa, e não existe conversa com ${mascarar(tel)} na linha "${l.rotulo}". Tente outra linha (por exemplo uma do tipo CPDF) ou peça o contato pelo nome.`);
        c.destinatario = { nome: achado && achado.nome ? achado.nome : null, telefone: tel, ref_provedor: achado ? achado.ref : null, via: 'telefone' };
      }
      if (l.tipo === 'organizap' && !c.destinatario.ref_provedor) throw ruim(422, 'SEM_CONVERSA_ABERTA', 'Não achei a conversa deste contato nesta linha.');
    }
    if (!destinoPermitido(c)) throw erroDestinoDeTeste();
    confereGeracao(g);
    gravaCartao(c);
    auditar('pediu', c);
    return { id: c.id, estado: c.estado, aviso: 'Peça ao usuário para confirmar na tela e acompanhe com GET /api/demo/v1/envio/<id>.' };
  }

  async function rotaAgente(req, res, url) {
    try {
      const m = req.method;
      const p = url.pathname.replace(/\/+$/, '');
      if (!bearerValido(req)) throw ruim(401, 'TOKEN_INVALIDO', 'O token do Portão não foi aceito. Leia o token em ~/.dgclaw/demo.token e mande no cabeçalho Authorization: Bearer <token>.');
      const espera = limiteDeTaxa();
      if (espera) { res.setHeader('Retry-After', String(espera)); throw ruim(429, 'MUITOS_PEDIDOS', `Mais de ${LIMITE_POR_MINUTO} pedidos em um minuto. Espere ${espera} segundos.`); }
      if (resetando) throw ruim(503, 'RESET_EM_ANDAMENTO', 'Um reset está em andamento. Espere alguns minutos.');
      let r;
      if ((r = /^\/api\/demo\/v1\/contato$/.exec(p))) {
        if (m !== 'POST') throw ruim(405, 'METODO_INVALIDO', 'Use POST com {"linha": "...", "nome": "..."}.');
        return H.enviaJson(res, 201, Object.assign({ ok: true }, await criarLeitura(await H.lerJson(req, MAX_CORPO))));
      }
      if ((r = /^\/api\/demo\/v1\/contato\/([^/]+)$/.exec(p))) {
        if (m !== 'GET') throw ruim(405, 'METODO_INVALIDO', 'Use GET.');
        const c = lerCartao(decodeURIComponent(r[1]));
        if (!c || c.tipo !== 'leitura') throw ruim(404, 'CARTAO_NAO_ENCONTRADO', 'Não existe este pedido de contato. Confira o id que o POST devolveu.');
        const saida = { ok: true, id: c.id, estado: c.estado };
        if (c.estado === 'liberado') {
          saida.contato = { nome: c.contato.nome, telefone_mascarado: c.contato.telefone ? mascarar(c.contato.telefone) : null, ref: c.id };
          saida.liberado_ate = new Date(c.liberado_ate).toISOString();
        }
        if (c.estado === 'recusado') saida.motivo = 'O usuário recusou abrir esta conversa. Não peça de novo sem ele pedir.';
        if (c.estado === 'expirado') saida.motivo = c.motivo;
        return H.enviaJson(res, 200, saida);
      }
      if ((r = /^\/api\/demo\/v1\/contato\/([^/]+)\/conversa$/.exec(p))) {
        if (m !== 'GET') throw ruim(405, 'METODO_INVALIDO', 'Use GET.');
        const bruto = url.searchParams.get('limite');
        const limite = bruto == null || bruto === '' ? 60 : Number(bruto);
        if (!Number.isInteger(limite) || limite < 1 || limite > 200) throw ruim(400, 'LIMITE_INVALIDO', 'O "limite" precisa ser um número inteiro de 1 a 200.');
        const g = geracao;
        const c = leituraLiberada(decodeURIComponent(r[1]));
        const l = linhaDe(c.linha);
        const mensagens = await provedores.lerConversa(l, { ref: c.contato.ref_provedor, telefone: c.contato.telefone }, limite);
        confereGeracao(g);
        auditar('leu_conversa', c, { mensagens: mensagens.length });
        return H.enviaJson(res, 200, { ok: true, contato: { nome: c.contato.nome, telefone_mascarado: c.contato.telefone ? mascarar(c.contato.telefone) : null }, mensagens, total: mensagens.length });
      }
      if (p === '/api/demo/v1/envio') {
        if (m !== 'POST') throw ruim(405, 'METODO_INVALIDO', 'Use POST com o corpo do envio.');
        return H.enviaJson(res, 201, Object.assign({ ok: true }, await criarEnvio(await H.lerJson(req, MAX_CORPO))));
      }
      if ((r = /^\/api\/demo\/v1\/envio\/([^/]+)$/.exec(p))) {
        if (m !== 'GET') throw ruim(405, 'METODO_INVALIDO', 'Use GET.');
        const c = lerCartao(decodeURIComponent(r[1]));
        if (!c || c.tipo !== 'envio') throw ruim(404, 'CARTAO_NAO_ENCONTRADO', 'Não existe este envio. Confira o id que o POST devolveu.');
        const saida = { ok: true, id: c.id, estado: c.estado };
        if (c.estado === 'recusado') saida.motivo = 'O usuário recusou este envio. Não reenvie nem crie um igual sem ele pedir.';
        else if (c.motivo) saida.motivo = c.motivo;
        if (c.codigo) saida.codigo = c.codigo;
        if (c.confirmacao === 'na_fila') saida.observacao = 'O provedor aceitou e colocou na fila de entrega.';
        return H.enviaJson(res, 200, saida);
      }
      throw ruim(404, 'ROTA_INEXISTENTE', `Não existe ${m} ${url.pathname.slice(0, 80)} no Portão. As rotas são: contato, contato/<id>, contato/<id>/conversa, envio e envio/<id>. O Portão não lista conversas nem contatos.`);
    } catch (e) { erro(res, e); }
    return true;
  }

  // ── tela: candidatos, cartões abertos, decisão ──────────────────────────
  const cacheCandidatos = new Map(); // id do cartão -> { ate, promessa }
  function candidatosDe(c) {
    const g = cacheCandidatos.get(c.id);
    if (g && g.ate > agoraMs()) return g.promessa;
    const l = linhaDe(c.linha);
    const promessa = provedores.buscarContatos(l, c.nome);
    cacheCandidatos.set(c.id, { ate: agoraMs() + CACHE_CANDIDATOS_MS, promessa });
    promessa.catch(() => cacheCandidatos.delete(c.id));
    return promessa;
  }

  const rotuloDe = (id) => { const l = linhaDe(id); return l ? l.rotulo : (id === 'email' && cfg.email ? cfg.email.rotulo : id); };

  async function visao(c) {
    const resto = Math.max(0, Math.round((c.expira_em - agoraMs()) / 1000));
    if (c.tipo === 'leitura') {
      let candidatos = []; let erroBusca = null;
      try { candidatos = (await candidatosDe(c)).map((x) => ({ ref: x.ref, nome: x.nome, telefone_mascarado: x.telefone ? mascarar(x.telefone) : null, sem_numero: x.semNumero })); } catch (e) { erroBusca = e.message; }
      return { id: c.id, tipo: 'leitura', canal: c.canal, linha: c.linha, linha_rotulo: rotuloDe(c.linha), nome_pedido: c.nome, candidatos, erro_busca: erroBusca, segundos_restantes: resto };
    }
    const d = c.destinatario;
    return {
      id: c.id, tipo: 'envio', canal: c.canal, linha: c.linha, linha_rotulo: rotuloDe(c.linha),
      destinatario: { nome: d.nome || null, telefone: d.telefone ? `+${d.telefone}` : null, para: d.para || null },
      assunto: c.assunto || null, texto: c.texto, anexos: c.anexos.map((a) => ({ nome: a.nome, tamanho: a.tamanho })), segundos_restantes: resto,
    };
  }

  async function listaTela() {
    const todos = listarCartoes();
    const abertosC = todos.filter((c) => c.estado === 'aguardando');
    const recentes = todos.filter((c) => c.tipo === 'envio' && c.estado !== 'aguardando' && agoraMs() - (c.atualizado_em || 0) < RECENTES_MS)
      .map((c) => ({ id: c.id, estado: c.estado, canal: c.canal, para: c.destinatario.nome || c.destinatario.para || (c.destinatario.telefone ? mascarar(c.destinatario.telefone) : ''), motivo: c.motivo || null, detalhe: c.detalhe || null, confirmacao: c.confirmacao || null }));
    return { ok: true, agente: cfg.agente, resetando, cartoes: await Promise.all(abertosC.map(visao)), recentes };
  }

  async function decidir(id, corpo, sessao) {
    if (resetando) throw ruim(503, 'RESET_EM_ANDAMENTO', 'Um reset está em andamento. Espere terminar.');
    const g = geracao;
    const c = lerCartao(id);
    if (!c) throw ruim(404, 'CARTAO_NAO_ENCONTRADO', 'Este cartão não existe mais (talvez já tenha saído num reset).');
    if (c.estado !== 'aguardando') throw ruim(409, 'CARTAO_JA_DECIDIDO', c.estado === 'expirado' ? 'Este cartão expirou. Peça ao agente para pedir de novo.' : `Este cartão já foi decidido (${c.estado}). Cada cartão vale uma vez só.`);
    const decisao = corpo.decisao;
    if (decisao !== 'confirmar' && decisao !== 'recusar') throw ruim(400, 'DECISAO_INVALIDA', 'A "decisao" precisa ser "confirmar" ou "recusar".');
    const quem = (sessao && sessao.usuario) || 'dono';
    c.decidido_por = quem;
    if (decisao === 'recusar') {
      c.estado = 'recusado';
      gravaCartao(c);
      cacheCandidatos.delete(c.id);
      auditar('recusou', c, { quem });
      return { ok: true, estado: c.estado };
    }
    if (c.tipo === 'leitura') {
      const ref = typeof corpo.candidato === 'string' ? corpo.candidato : '';
      if (!ref) throw ruim(400, 'CANDIDATO_OBRIGATORIO', 'Escolha um dos contatos da lista antes de confirmar, ou recuse.');
      const lista = await candidatosDe(c);
      confereGeracao(g);
      const esc = lista.find((x) => x.ref === ref);
      if (!esc) throw ruim(409, 'CANDIDATO_INVALIDO', 'Esse contato não está na lista deste cartão. Atualize a tela e escolha de novo.');
      c.estado = 'liberado';
      c.contato = { nome: esc.nome, telefone: esc.telefone, ref_provedor: esc.ref };
      c.liberado_ate = agoraMs() + VALIDADE_LIBERACAO_MS;
      gravaCartao(c);
      cacheCandidatos.delete(c.id);
      auditar('liberou', c, { quem });
      return { ok: true, estado: c.estado };
    }
    // Envio: a ordem é conferir tudo, auditar, marcar `enviando` (uso único) e só então falar com o provedor.
    const falhar = (e) => {
      c.estado = 'falhou'; c.codigo = e.codigo || 'ERRO'; c.motivo = e.message;
      gravaCartao(c);
      try { auditar('falhou', c, { quem, codigo: c.codigo }); } catch (a) { log('erro', a.message); }
    };
    if (!destinoPermitido(c)) { const e = erroDestinoDeTeste(); falhar(e); throw e; }
    let dados;
    try {
      dados = c.anexos.map((a) => {
        const novo = lerAnexoSeguro(a.caminho);
        if (novo.sha256 !== a.sha256) throw ruim(409, 'ANEXO_MUDOU', `O arquivo ${a.nome} mudou depois que o cartão foi criado. Por segurança nada foi enviado. Peça ao agente para pedir de novo.`);
        return { nome: a.nome, mime: novo.mime, dados: novo.dados };
      });
    } catch (e) { if (e instanceof ErroDemo) { falhar(e); } throw e; }
    auditar('confirmou', c, { quem });
    c.estado = 'enviando';
    gravaCartao(c);
    enviarEmSegundoPlano(c, dados, quem);
    return { ok: true, estado: 'enviando' };
  }

  function enviarEmSegundoPlano(c, anexos, quem) {
    const g = geracao;
    (async () => {
      try {
        let r;
        if (c.canal === 'email') {
          r = await provedores.enviarEmail(cfg.email, { para: c.destinatario.para, assunto: c.assunto, texto: c.texto, anexos, id: c.id });
        } else {
          r = await provedores.enviarWhatsapp(linhaDe(c.linha), { ref: c.destinatario.ref_provedor, telefone: c.destinatario.telefone, texto: c.texto, anexos, id: c.id });
        }
        if (g !== geracao) { log('erro', `Modo demonstração: o envio ${c.id} terminou depois de um reset; o cartão do cliente anterior não foi recriado (resultado do provedor: ${r.confirmacao}).`); return; }
        c.estado = 'enviado'; c.confirmacao = r.confirmacao;
        gravaCartao(c);
        auditar('enviou', c, { quem, confirmacao: r.confirmacao });
      } catch (e) {
        const ed = e instanceof ErroDemo ? e : new ErroDemo(500, 'ERRO_INTERNO', `Falha inesperada no envio (${e && e.message}). Confira antes de repetir.`);
        if (!(e instanceof ErroDemo)) log('erro', `Modo demonstração: falha inesperada ao enviar ${c.id}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        if (g !== geracao) { log('erro', `Modo demonstração: o envio ${c.id} falhou depois de um reset (${ed.codigo}); o cartão do cliente anterior não foi recriado.`); return; }
        c.estado = 'falhou'; c.codigo = ed.codigo; c.motivo = ed.message; if (ed.detalhe) c.detalhe = ed.detalhe;
        try { gravaCartao(c); auditar('falhou', c, { quem, codigo: ed.codigo }); } catch (a) { log('erro', a.message); }
      }
    })();
  }

  // ── Reset ───────────────────────────────────────────────────────────────
  let estadoReset = { fase: 'parado' };
  try { const g = JSON.parse(fs.readFileSync(arqReset, 'utf8')); if (g && g.fase && g.fase !== 'em_andamento') estadoReset = g; } catch (_) { /* nunca houve reset */ }
  const guardaReset = () => { try { garantePasta(pasta); fs.writeFileSync(arqReset, JSON.stringify(estadoReset), { mode: 0o600 }); } catch (e) { log('erro', `Modo demonstração: não consegui guardar o estado do reset (${e.code || e.message}).`); } };

  function iniciarReset(quem) {
    if (resetando) throw ruim(409, 'RESET_EM_ANDAMENTO', 'Já há um reset em andamento. Espere terminar.');
    resetando = true;
    geracao++;
    estadoReset = { fase: 'em_andamento', inicio: agoraMs(), passos: [], por: quem };
    try { auditar('reset_iniciado', { id: 'reset', tipo: 'reset', canal: 'painel' }, { quem }); } catch (e) { resetando = false; throw e; }
    const lancar = spawnImpl || childProcess.spawn;
    let filho;
    try {
      filho = lancar(binReset, [cfg.agente, '--dados', webConfig.dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resetando = false;
      estadoReset = { fase: 'falhou', fim: agoraMs(), mensagem: `Não consegui iniciar o reset (${e.code || e.message}). Confira se ${binReset} existe e roda como root. Nada foi movido.`, passos: [] };
      guardaReset();
      return;
    }
    let cauda = '';
    const lerSaida = (d) => {
      cauda = (cauda + d.toString('utf8')).slice(-4000);
      for (const linha of d.toString('utf8').split('\n')) if (linha.startsWith('==> ') && estadoReset.passos.length < 40) estadoReset.passos.push(linha.slice(4).slice(0, 200));
    };
    filho.stdout.on('data', lerSaida);
    filho.stderr.on('data', lerSaida);
    const prazo = setTimeout(() => { try { filho.kill('SIGTERM'); } catch (_) { /* já saiu */ } }, 6 * 60 * 1000);
    const encerra = (codigo, sinal, falhaDeInicio) => {
      clearTimeout(prazo);
      if (!resetando) return;
      resetando = false;
      geracao++;
      cacheCandidatos.clear();
      if (codigo === 0) {
        try { if (esquecerConversa) esquecerConversa(cfg.agente); } catch (e) { log('erro', `Modo demonstração: o reset terminou, mas não consegui limpar a conversa em memória (${e.message}). Recarregue a página.`); }
        estadoReset = Object.assign(estadoReset, { fase: 'ok', fim: agoraMs() });
        try { auditar('reset_concluido', { id: 'reset', tipo: 'reset', canal: 'painel' }, { quem }); } catch (e) { log('erro', e.message); }
      } else {
        const ultima = cauda.trim().split('\n').filter(Boolean).slice(-6).join(' | ');
        estadoReset = Object.assign(estadoReset, { fase: 'falhou', fim: agoraMs(), mensagem: falhaDeInicio || `O reset parou (${sinal ? `sinal ${sinal}` : `código ${codigo}`}): ${ultima || 'sem mensagem'}. O que já foi movido está guardado em /var/lib/dgclaw/demo-arquivo; nada foi apagado. Corrija o motivo e tente de novo.` });
        log('erro', `Modo demonstração: o reset falhou (${estadoReset.mensagem})`);
        try { auditar('reset_falhou', { id: 'reset', tipo: 'reset', canal: 'painel' }, { quem }); } catch (e) { log('erro', e.message); }
      }
      guardaReset();
    };
    filho.on('error', (e) => encerra(-1, null, `Não consegui rodar o reset (${e.code || e.message}). Confira se ${binReset} existe e é executável. Nada foi movido.`));
    filho.on('close', (codigo, sinal) => encerra(codigo === null ? -1 : codigo, sinal));
  }

  async function rotaTela(req, res, url, sessao) {
    try {
      const m = req.method;
      const p = url.pathname.replace(/\/+$/, '');
      let r;
      if (p === '/api/demo/cartoes') {
        if (m !== 'GET') throw ruim(405, 'METODO_INVALIDO', 'Use GET.');
        return H.enviaJson(res, 200, await listaTela());
      }
      if ((r = /^\/api\/demo\/cartoes\/([^/]+)\/decisao$/.exec(p))) {
        if (m !== 'POST') throw ruim(405, 'METODO_INVALIDO', 'Use POST com {"decisao": "confirmar" ou "recusar"}.');
        if (!sessao || sessao.via) throw ruim(403, 'SO_O_DONO_DECIDE', 'Só o dono, pelo painel, decide um cartão.');
        return H.enviaJson(res, 200, await decidir(decodeURIComponent(r[1]), await H.lerJson(req, 16 * 1024), sessao));
      }
      if (p === '/api/demo/reset') {
        if (m !== 'POST') throw ruim(405, 'METODO_INVALIDO', 'Use POST com {"confirmacao": "NOVO CLIENTE"}.');
        if (!sessao || sessao.via) throw ruim(403, 'SO_O_DONO_DECIDE', 'Só o dono, pelo painel, faz o reset.');
        const corpo = await H.lerJson(req, 4 * 1024);
        if (corpo.confirmacao !== FRASE_RESET) throw ruim(400, 'CONFIRMACAO_ERRADA', `Para fazer o reset, escreva exatamente ${FRASE_RESET}.`);
        iniciarReset(sessao.usuario || 'dono');
        return H.enviaJson(res, 202, { ok: true, fase: estadoReset.fase });
      }
      if (p === '/api/demo/reset/estado') {
        if (m !== 'GET') throw ruim(405, 'METODO_INVALIDO', 'Use GET.');
        return H.enviaJson(res, 200, Object.assign({ ok: true }, estadoReset));
      }
      for (const fn of extrasTela) { if (await fn(req, res, url, sessao)) return true; }
      throw ruim(404, 'ROTA_INEXISTENTE', `Não existe ${m} ${url.pathname.slice(0, 80)} no modo demonstração.`);
    } catch (e) { erro(res, e); }
    return true;
  }

  const visivel = Object.assign({}, cfg);
  log('info', `Modo demonstração LIGADO para o agente ${cfg.agente} (instância ${cfg.instancia}; ${cfg.linhas_whatsapp.length} linha(s) de WhatsApp${cfg.email ? ', e-mail' : ''}${cfg.destinos_de_teste.length ? `, travado em ${cfg.destinos_de_teste.length} destino(s) de teste` : ''}).`);
  return Object.assign(base, { ligado: true, config: Object.freeze(visivel), chaveDe, rotaAgente, rotaTela, motivoDesligado: null });
}

module.exports = { criarDemo, carregarConfig, mascarar, normalizaTelefone, FRASE_RESET };
