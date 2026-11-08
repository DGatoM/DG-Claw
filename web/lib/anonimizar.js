'use strict';
// Anonimizar documentos (lado Web). Combinado com o motor Python em anonimizar/CONTRATO.md.
//
// O que este módulo faz:
//   - guarda, por agente, a configuração, a tabela de correspondência (valor real <-> marcador) e o
//     registro dos documentos, os dois últimos CIFRADOS (AES-256-GCM, chave em DGCLAW_ANON_CHAVE);
//   - mantém um processo do motor vivo, uma requisição por vez, com tempo limite e encerramento por ociosidade;
//   - recebe o upload, passa pelo motor num temporário e entrega ao agente SÓ as saídas anonimizadas;
//   - troca, sem o motor, os valores já conhecidos no que o dono digita e reverte marcadores em texto.
// Falha fechada: se qualquer passo falhar, nada vai para a casa do agente.
// Regra de log: nunca valor da tabela, nunca conteúdo de documento, nunca o nome original (só o id).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { gravaArquivoSeguro } = require('./grava-seguro');
const { dentro } = require('./media');
const { entregar: entregarSeguro, ler: lerSeguro, ErroEntrega } = require('./entrega-segura');

const TIPOS = ['PESSOA', 'EMPRESA', 'ENDERECO', 'CPF', 'CNPJ', 'RG', 'PIS', 'CNH', 'TITULO', 'CEP', 'TELEFONE', 'EMAIL',
  'CARTAO', 'CONTA', 'AGENCIA', 'PIX', 'VALOR', 'DATA'];
const TIPOS_SO_DIGITOS = new Set(['CPF', 'CNPJ', 'RG', 'PIS', 'CNH', 'TITULO', 'CEP', 'TELEFONE', 'CARTAO', 'CONTA', 'AGENCIA']);
const RX_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RX_ID = /^[0-9a-f]{8}$/;
const RX_MARCADOR = /\[([A-Z]+)_(\d+)\]/g;
const NIVEIS_INSTALAVEIS = ['leitores', 'completo'];
// Tudo o que o motor pode vir a ler (o nível instalado diz o que ele lê de verdade, via op "estado").
const EXT_POSSIVEIS = new Set(['.txt', '.md', '.csv', '.json', '.pdf', '.docx', '.xlsx']);
const EXT_FINAL = new Set(['.txt', '.md', '.csv', '.json', '.docx', '.xlsx', '.pptx']);
const EXT_ATIVA = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);
const MAX_FINAL_BYTES = 100 * 1024 * 1024;
const MAX_LINHA_MOTOR = 64 * 1024 * 1024;
const MAX_TEXTO = 200000;

const PADRAO_CONFIG = Object.freeze({
  ligado: false, valores: false, datas: false, empresas: true, aplicar_no_que_digito: false,
  sem_detector: 'bloquear', nao_anonimizavel: 'bloquear',
});
const CAMPOS_BOOL = ['ligado', 'valores', 'datas', 'empresas', 'aplicar_no_que_digito'];
const CAMPOS_ENUM = { sem_detector: ['bloquear', 'so_numeros'], nao_anonimizavel: ['bloquear', 'enviar'] };

class ErroAnon extends Error {
  constructor(status, mensagem, codigo) { super(mensagem); this.status = status; this.codigo = codigo || null; }
}

const normaliza = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDigitos = (s) => String(s).replace(/\D+/g, '');
const escapaRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nomeSeguroHeader = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'arquivo';

/**
 * Texto -> {norm, mapa, fimDe}: `norm` sem acento e em minúsculas. Tudo em unidades UTF-16, as mesmas de
 * RegExp.exec, .index e slice: `mapa[i]` = início, no original, do caractere que gerou `norm[i]`;
 * `fimDe[i]` = fim desse caractere no original. Cada unidade de `norm` aponta para o caractere inteiro de
 * origem, então emoji (par substituto) e caracteres que mudam de tamanho ao normalizar não desalinham o mapa.
 */
function normalizaComMapa(texto) {
  let norm = ''; const mapa = []; const fimDe = [];
  let i = 0;
  for (const ch of texto) {
    const n = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\p{M}/gu, '');
    for (let k = 0; k < n.length; k++) { norm += n[k]; mapa.push(i); fimDe.push(i + ch.length); }
    i += ch.length;
  }
  mapa.push(i); fimDe.push(i);
  return { norm, mapa, fimDe };
}

/** Troca no `texto` os valores da `tabela` (exatos, normalizados, palavra inteira, do mais longo ao mais curto). */
function trocarValoresConhecidos(texto, tabela, jaConferido) {
  if (!texto || !tabela || !tabela.length) return { texto, trocas: 0 };
  const { norm, mapa, fimDe } = normalizaComMapa(texto);
  const ordem = tabela.filter((e) => e && !e.apagado && typeof e.valor === 'string' && e.valor.trim())
    .sort((a, b) => b.valor.length - a.valor.length);
  const reservados = [];
  const livre = (a, b) => !reservados.some(([x, y]) => a < y && b > x);
  const letraOuNumero = /[\p{L}\p{N}]/u;
  for (const e of ordem) {
    // CNPJ alfanumérico (12.ABC.345/01DE-35) tem letras: nele a normalização mantém letras e números, só tira a pontuação.
    const alnum = e.tipo === 'CNPJ' ? String(e.valor).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^0-9A-Za-z]/g, '').toLowerCase() : '';
    const digitos = alnum || (TIPOS_SO_DIGITOS.has(e.tipo) ? soDigitos(e.valor) : '');
    const porDigitos = digitos.length >= 4;
    let rx;
    if (alnum.length >= 4) {
      rx = new RegExp(`(?<![0-9a-z])${alnum.split('').join('[\\s.\\-/]*')}(?![0-9a-z])`, 'g');
    } else if (porDigitos) {
      // Telefone brasileiro: o código do país (55, com ou sem +) pode estar na tabela e faltar no texto, ou o inverso.
      // Fica só o número nacional (DDD + 8 ou 9 dígitos) e o 55 passa a ser opcional na frente.
      const fone = e.tipo === 'TELEFONE';
      const nacional = fone && /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
      const comPais = fone && /^\d{10,11}$/.test(nacional);
      const prefixo = comPais ? '(?:(?:\\+\\s*)?55[\\s.\\-]*)?' : '';
      rx = new RegExp(`(?<![\\d])${prefixo}(?:\\((?=\\d+\\)))?${nacional.split('').join('(?:[\\s.\\-/]|\\)(?=\\s?\\d))*')}(?![\\d])`, 'g');
    } else {
      const v = normaliza(e.valor);
      if (!v) continue;
      rx = new RegExp(escapaRx(v).replace(/ /g, '\\s+'), 'g');
    }
    let m;
    while ((m = rx.exec(norm)) !== null) {
      const ini = m.index; const fim = m.index + m[0].length;
      if (m[0].length === 0) { rx.lastIndex += 1; continue; }
      if (!porDigitos) {
        const antes = norm[ini - 1]; const depois = norm[fim];
        if ((antes && letraOuNumero.test(antes)) || (depois && letraOuNumero.test(depois))) continue;
      }
      const a = mapa[ini]; const b = fimDe[fim - 1];
      if (livre(a, b)) reservados.push([a, b, e.marcador]);
    }
  }
  if (!reservados.length) return { texto, trocas: 0 };
  reservados.sort((x, y) => y[0] - x[0]);
  let saida = texto;
  for (const [a, b, marcador] of reservados) saida = saida.slice(0, a) + marcador + saida.slice(b);
  // Salvaguarda: depois da troca não pode sobrar nenhum valor conhecido. Se sobrou, o mapa falhou: não entrega.
  if (!jaConferido && trocarValoresConhecidos(saida, tabela, true).trocas > 0) {
    throw new ErroAnon(503, 'O filtro de dados conhecidos não conseguiu trocar tudo neste texto, então ele não foi entregue. Nada foi enviado.', 'filtro_incompleto');
  }
  return { texto: saida, trocas: reservados.length };
}

/**
 * Trechos onde o marcador NUNCA é trocado: URL, destino de link ou de imagem em markdown (`](...)`) e atributo
 * de HTML. Trocar ali mudaria para onde um link aponta, e um dado real no endereço sai do texto visível.
 */
function trechosProtegidos(texto) {
  const lista = [];
  const rxs = [
    /\]\([^)\n]*\)/g,
    /\b(?:https?|ftp|file|data|mailto|javascript):[^\s<>"'`]*/gi,
    /\bwww\.[^\s<>"'`]*/gi,
    /\b(?:href|src|action|poster|srcset|data|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
  ];
  for (const rx of rxs) for (const m of texto.matchAll(rx)) lista.push([m.index, m.index + m[0].length]);
  return lista;
}

/** Troca marcadores pelos valores da tabela. Marcador desconhecido, apagado ou dentro de URL fica como está. */
function reverterMarcadores(texto, tabela) {
  texto = String(texto);
  const porMarcador = new Map(tabela.filter((e) => !e.apagado).map((e) => [e.marcador, e.valor]));
  const protegidos = trechosProtegidos(texto);
  const desconhecidos = new Set();
  let trocas = 0;
  const saida = texto.replace(RX_MARCADOR, (todo, _t, _n, pos) => {
    if (protegidos.some(([x, y]) => pos >= x && pos < y)) return todo;
    if (porMarcador.has(todo)) { trocas += 1; return porMarcador.get(todo); }
    desconhecidos.add(todo);
    return todo;
  });
  return { texto: saida, trocas, desconhecidos: Array.from(desconhecidos) };
}

function ramDisponivelMb() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch (_) { /* sem /proc: usa o que o Node sabe */ }
  return Math.round(os.freemem() / 1048576);
}

function criarAnonimizar(opcoes) {
  const o = opcoes || {};
  const { dataDir, registro, log } = o;
  const env = o.env || {};
  const appDir = o.appDir || path.join(__dirname, '..', '..');
  const base = env.DGCLAW_ANON_BASE || '/opt/dgclaw/anonimizar';
  const caminhoChave = env.DGCLAW_ANON_CHAVE || '/etc/dgclaw/anonimizar.chave';
  const raiz = path.join(dataDir, 'anonimizar');
  const dirTmp = path.join(raiz, 'tmp');
  const caminhoConfig = path.join(raiz, 'config.json');
  const timeoutS = Number(env.DGCLAW_ANON_TIMEOUT_S) > 0 ? Number(env.DGCLAW_ANON_TIMEOUT_S) : 180;
  const ociosoMs = o.ociosoMs != null ? o.ociosoMs : 10 * 60 * 1000;
  const executaSystemctl = o.systemctl || ((args) => new Promise((resolve) => {
    execFile('systemctl', args, { timeout: 5000, windowsHide: true }, (e, saida) => resolve({ erro: e, saida: String(saida || '').trim() }));
  }));
  const paraContainer = o.paraContainer || ((p) => p);

  // ── chave e cifra ─────────────────────────────────────────────────────────
  let chave = null;
  function obterChave() {
    if (chave) return chave;
    let bruto = null;
    try { bruto = fs.readFileSync(caminhoChave); } catch (e) {
      if (e.code !== 'ENOENT') throw new ErroAnon(500, `Não consegui ler a chave de cifra em ${caminhoChave} (${e.code || e.message}). Confira o dono (root) e o modo (600) do arquivo.`, 'CHAVE_ILEGIVEL');
    }
    if (bruto) {
      if (bruto.length !== 32) {
        throw new ErroAnon(500, `A chave de cifra em ${caminhoChave} tem ${bruto.length} bytes e deveria ter 32. Não vou criar outra por cima: apagar a chave tornaria ilegíveis as tabelas já gravadas. Restaure o arquivo original.`, 'CHAVE_INVALIDA');
      }
      chave = bruto;
      return chave;
    }
    const pasta = path.dirname(caminhoChave);
    try {
      fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
      gravaArquivoSeguro(caminhoChave, crypto.randomBytes(32), { raiz: pasta, modo: 0o600 });
      chave = fs.readFileSync(caminhoChave);
    } catch (e) {
      throw new ErroAnon(500, `Não consegui criar a chave de cifra em ${caminhoChave} (${e.code || e.message}). Crie a pasta ${pasta} com permissão 700 e tente de novo.`, 'CHAVE_NAO_CRIADA');
    }
    log('info', `Anonimizar: chave de cifra criada em ${caminhoChave}.`);
    return chave;
  }
  function cifra(objeto, ctx) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', obterChave(), iv);
    c.setAAD(Buffer.from(`dgclaw-anon|v1|${ctx}`));
    const dados = Buffer.concat([c.update(JSON.stringify(objeto), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), dados]);
  }
  function decifra(buf, ctx) {
    if (buf.length < 30 || buf[0] !== 1) throw new ErroAnon(500, `O arquivo cifrado de ${ctx} não está no formato esperado.`, 'CIFRA_FORMATO');
    const d = crypto.createDecipheriv('aes-256-gcm', obterChave(), buf.subarray(1, 13));
    d.setAAD(Buffer.from(`dgclaw-anon|v1|${ctx}`));
    d.setAuthTag(buf.subarray(13, 29));
    try {
      return JSON.parse(Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf8'));
    } catch (_) {
      throw new ErroAnon(500, `Não consegui decifrar ${ctx}. A chave em ${caminhoChave} não é a que cifrou esse arquivo, ou ele foi alterado. Restaure a chave original; nada foi apagado.`, 'CIFRA_FALHOU');
    }
  }

  // ── pastas e arquivos ─────────────────────────────────────────────────────
  function pasta0700(p) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    fs.chmodSync(p, 0o700);
  }
  function pastaDoAgente(slug) {
    if (typeof slug !== 'string' || !RX_SLUG.test(slug)) throw new ErroAnon(400, `O id de agente "${String(slug).slice(0, 40)}" não vale.`, 'SLUG');
    const base = path.resolve(raiz);
    const p = path.resolve(base, slug);
    if (!p.startsWith(base + path.sep)) throw new ErroAnon(400, `O id de agente "${String(slug).slice(0, 40)}" não vale.`, 'SLUG');
    pasta0700(base);
    pasta0700(p);
    return p;
  }
  function lerCifrado(slug, nome, vazio) {
    const arq = path.join(pastaDoAgente(slug), nome);
    let buf;
    try { buf = fs.readFileSync(arq); } catch (e) {
      if (e.code === 'ENOENT') return vazio();
      throw new ErroAnon(500, `Não consegui ler ${nome} de ${slug} (${e.code || e.message}).`, 'LEITURA');
    }
    return decifra(buf, `${slug}|${nome}`);
  }
  function gravarCifrado(slug, nome, obj) {
    const pasta = pastaDoAgente(slug);
    const buf = cifra(obj, `${slug}|${nome}`);
    try {
      gravaArquivoSeguro(path.join(pasta, nome), buf, { raiz: dataDir, modo: 0o600 });
    } catch (e) {
      throw new ErroAnon(500, `Não consegui gravar ${nome} de ${slug} (${e.code || e.message}). Confira o espaço em disco e a pasta ${raiz}.`, 'GRAVACAO');
    }
  }
  const lerTabela = (slug) => lerCifrado(slug, 'tabela.enc', () => ({ entradas: [] }));
  const gravarTabela = (slug, t) => gravarCifrado(slug, 'tabela.enc', t);
  const lerDocs = (slug) => lerCifrado(slug, 'documentos.enc', () => ({ docs: [] }));
  const gravarDocs = (slug, d) => gravarCifrado(slug, 'documentos.enc', d);

  // Um de cada vez por agente: a tabela é lida, o motor numera os marcadores novos e a tabela é regravada.
  const travas = new Map();
  function comTrava(slug, fn) {
    const anterior = travas.get(slug) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);
    travas.set(slug, atual);
    const limpa = () => { if (travas.get(slug) === atual) travas.delete(slug); };
    atual.then(limpa, limpa);
    return atual;
  }

  // ── configuração ──────────────────────────────────────────────────────────
  function lerArquivoConfig() {
    let bruto;
    try { bruto = fs.readFileSync(caminhoConfig, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new ErroAnon(500, `Não consegui ler ${caminhoConfig} (${e.code || e.message}). Sem ler a configuração eu não sei se este agente está com a anonimização ligada, então nada passa.`, 'CONFIG_ILEGIVEL');
    }
    try {
      const j = JSON.parse(bruto);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('não é um objeto');
      return j;
    } catch (e) {
      throw new ErroAnon(500, `O arquivo ${caminhoConfig} está ilegível (${e.message}). Não vou sobrescrevê-lo. Corrija o JSON ou renomeie o arquivo; enquanto isso nenhum documento passa.`, 'CONFIG_CORROMPIDA');
    }
  }
  function config(slug) {
    const c = lerArquivoConfig()[slug];
    return Object.assign({}, PADRAO_CONFIG, c && typeof c === 'object' ? c : {});
  }
  /** Valida o PUT. Devolve { mudancas } ou { erro }. */
  function validaConfig(corpo) {
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return { erro: 'Mande um objeto JSON com as opções a mudar, por exemplo {"ligado": true}.' };
    const mud = {};
    for (const [k, v] of Object.entries(corpo)) {
      if (CAMPOS_BOOL.includes(k)) {
        if (typeof v !== 'boolean') return { erro: `A opção "${k}" precisa ser true ou false. Recebi: ${JSON.stringify(v).slice(0, 40)}.` };
        mud[k] = v;
      } else if (CAMPOS_ENUM[k]) {
        if (!CAMPOS_ENUM[k].includes(v)) return { erro: `A opção "${k}" aceita ${CAMPOS_ENUM[k].map((x) => `"${x}"`).join(' ou ')}. Recebi: ${JSON.stringify(v).slice(0, 40)}.` };
        mud[k] = v;
      } else {
        return { erro: `Não conheço a opção "${String(k).slice(0, 40)}". As opções são: ${CAMPOS_BOOL.concat(Object.keys(CAMPOS_ENUM)).join(', ')}.` };
      }
    }
    return { mudancas: mud };
  }
  function gravarConfig(slug, mudancas) {
    const tudo = lerArquivoConfig();
    const atual = tudo[slug] && typeof tudo[slug] === 'object' ? tudo[slug] : {};
    tudo[slug] = Object.assign({}, atual, mudancas);   // chaves que não conheço sobrevivem
    pasta0700(raiz);
    try {
      gravaArquivoSeguro(caminhoConfig, JSON.stringify(tudo, null, 2) + '\n', { raiz: dataDir, modo: 0o600 });
    } catch (e) {
      throw new ErroAnon(500, `Não consegui gravar a configuração em ${caminhoConfig} (${e.code || e.message}). Nada mudou.`, 'GRAVACAO');
    }
    return config(slug);
  }

  // ── processo do motor ─────────────────────────────────────────────────────
  /** Muda quando uma instalação do detector termina com sucesso (nivel/instalado_em do estado.json) ou o venv aparece. */
  function assinaturaInstalacao() {
    let nivel = null; let quando = null;
    try { const j = JSON.parse(fs.readFileSync(path.join(base, 'estado.json'), 'utf8')); nivel = j.nivel; quando = j.instalado_em; } catch (_) { /* sem estado.json ainda */ }
    return `${nivel}|${quando}|${fs.existsSync(path.join(base, 'venv', 'bin', 'python'))}`;
  }

  const motor = (() => {
    let assinaturaProc = null;
    let proc = null; let buffer = ''; let atual = null; const fila = []; let ocioso = null;
    function comandoMotor() {
      if (o.motor) return o.motor;
      const script = path.join(appDir, 'anonimizar', 'motor.py');
      if (!fs.existsSync(script)) {
        throw new ErroAnon(503, `O motor de anonimização não está instalado (falta ${script}). Atualize o DG Claw com "dgclaw atualizar" e tente de novo. Nada foi enviado ao agente.`, 'MOTOR_AUSENTE');
      }
      let py = env.DGCLAW_ANON_PYTHON;
      if (!py) { const venv = path.join(base, 'venv', 'bin', 'python'); py = fs.existsSync(venv) ? venv : 'python3'; }
      return { comando: py, args: ['-I', script, 'servir'] };
    }
    function ambiente() {
      const e = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', DGCLAW_ANON_BASE: base };
      for (const [k, v] of Object.entries(env)) if (k.startsWith('DGCLAW_ANON_') && typeof v === 'string') e[k] = v;
      return e;
    }
    function falhaAtual(erro) {
      const a = atual; atual = null;
      if (a) { clearTimeout(a.relogio); a.rejeita(erro); }
    }
    function encerra() {
      if (ocioso) { clearTimeout(ocioso); ocioso = null; }
      const p = proc; proc = null; buffer = '';
      if (p) { p.removeAllListeners('exit'); try { p.kill('SIGTERM'); } catch (_) { /* já saiu */ } }
    }
    function iniciar() {
      const { comando, args } = comandoMotor();
      pasta0700(raiz);
      const p = spawn(comando, args, { env: ambiente(), cwd: raiz, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      proc = p; buffer = ''; assinaturaProc = assinaturaInstalacao();
      p.stdin.on('error', () => { /* o motivo chega pelo evento exit */ });
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        buffer += d;
        if (buffer.length > MAX_LINHA_MOTOR) { encerra(); falhaAtual(new ErroAnon(503, 'O motor de anonimização devolveu uma resposta grande demais. Nada foi enviado ao agente; tente um arquivo menor.', 'MOTOR_RESPOSTA_GRANDE')); proximo(); return; }
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const linha = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (!linha.trim()) continue;
          const a = atual;
          if (!a) { log('aviso', 'Anonimizar: o motor escreveu uma linha sem eu ter pedido nada. Ignorei.'); continue; }
          atual = null; clearTimeout(a.relogio);
          let j;
          try { j = JSON.parse(linha); } catch (_) {
            a.rejeita(new ErroAnon(503, 'O motor de anonimização respondeu algo que não é JSON. Nada foi enviado ao agente. Reinstale o detector pela tela de Anonimizar ou peça ao Admin para conferir o motor.', 'MOTOR_RESPOSTA_INVALIDA'));
            encerra(); proximo(); return;
          }
          a.resolve(j);
          proximo();
        }
      });
      let ultimaErr = '';
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (d) => { ultimaErr = (ultimaErr + d).slice(-400); });
      p.on('error', (e) => {
        if (proc === p) { proc = null; buffer = ''; }
        log('erro', `Anonimizar: não consegui iniciar o motor com "${comando}" (${e.code || e.message}). Confira se o Python existe e o detector está instalado.`);
        falhaAtual(new ErroAnon(503, `Não consegui iniciar o motor de anonimização (${e.code || e.message}). Peça ao Admin para conferir se o Python está instalado. Nada foi enviado ao agente.`, 'MOTOR_NAO_INICIA'));
        proximo();
      });
      p.on('exit', (codigo, sinal) => {
        if (proc === p) { proc = null; buffer = ''; }
        log(atual ? 'erro' : 'info', `Anonimizar: o motor saiu (código ${codigo}, sinal ${sinal || '-'})${atual ? ' no meio de um pedido' : ''}.${ultimaErr ? ` Últimas linhas dele: ${ultimaErr.replace(/\s+/g, ' ').slice(-200)}` : ''}`);
        falhaAtual(new ErroAnon(503, 'O motor de anonimização parou no meio do pedido (provavelmente faltou memória). Nada foi enviado ao agente. Tente de novo; se repetir, use um arquivo menor ou instale só os leitores, sem o detector completo.', 'MOTOR_CAIU'));
        proximo();
      });
    }
    function proximo() {
      if (atual) return;
      const item = fila.shift();
      if (!item) {
        if (proc && ociosoMs > 0) { ocioso = setTimeout(() => { log('info', 'Anonimizar: motor encerrado por ociosidade.'); encerra(); }, ociosoMs); ocioso.unref(); }
        return;
      }
      if (ocioso) { clearTimeout(ocioso); ocioso = null; }
      // Detector instalado ou atualizado enquanto o motor estava vivo: ele guarda o interpretador e o estado do NER antigos.
      // Nenhum pedido está em curso aqui, então encerra e este abre um processo novo (com o Python do venv).
      if (proc && assinaturaProc !== assinaturaInstalacao()) {
        log('info', 'Anonimizar: o detector mudou desde que o motor subiu; reiniciando o motor para o próximo pedido.');
        encerra();
        cacheEstado = { t: 0, valor: null };
      }
      try {
        if (!proc) iniciar();
      } catch (e) { item.rejeita(e); proximo(); return; }
      atual = item;
      item.relogio = setTimeout(() => {
        log('erro', `Anonimizar: o motor passou de ${Math.round(item.limite / 1000)} s no pedido "${item.op}". Encerrei o processo.`);
        encerra();
        falhaAtual(new ErroAnon(503, `O motor de anonimização demorou mais de ${Math.round(item.limite / 1000)} segundos e foi interrompido. O documento deve ser grande demais para esta máquina. Nada foi enviado ao agente; tente um arquivo menor.`, 'MOTOR_DEMOROU'));
        proximo();
      }, item.limite);
      item.relogio.unref();
      try { proc.stdin.write(JSON.stringify(item.req) + '\n'); } catch (e) {
        encerra();
        falhaAtual(new ErroAnon(503, `Não consegui falar com o motor de anonimização (${e.code || e.message}). Nada foi enviado ao agente.`, 'MOTOR_NAO_ESCUTA'));
        proximo();
      }
    }
    return {
      enviar(req, limiteMs) {
        return new Promise((resolve, reject) => {
          fila.push({ req, op: req.op, limite: limiteMs || 60000, resolve, rejeita: reject, relogio: null });
          proximo();
        });
      },
      encerrar: encerra,
      vivo: () => !!proc,
    };
  })();

  // ── estado do detector ────────────────────────────────────────────────────
  let cacheEstado = { t: 0, valor: null };
  async function estadoMotor(forcar) {
    if (!forcar && cacheEstado.valor && Date.now() - cacheEstado.t < 5000) return cacheEstado.valor;
    let valor;
    try {
      const r = await motor.enviar({ op: 'estado' }, 30000);
      valor = r && r.ok ? { ok: true, nivel: r.nivel, formatos: r.formatos || [], modelo_carregado: !!r.modelo_carregado, rss_mb: r.rss_mb == null ? null : r.rss_mb, versao_modelo: r.versao_modelo || null }
        : { ok: false, erro: (r && r.erro) || 'O motor não soube dizer o estado.' };
    } catch (e) {
      valor = { ok: false, erro: e.message };
    }
    cacheEstado = { t: Date.now(), valor };
    return valor;
  }
  function lerEstadoInstalacao() {
    const arq = path.join(base, 'estado.json');
    try {
      const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
      return j && typeof j === 'object' ? j : null;
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Anonimizar: não consegui ler ${arq} (${e.code || e.message}). A tela mostra o estado só pelo motor.`);
      return null;
    }
  }
  async function instalacaoEmCurso() {
    for (const nivel of NIVEIS_INSTALAVEIS) {
      const r = await executaSystemctl(['is-active', `dgclaw-anonimizar-instalar@${nivel}.service`]);
      if (['active', 'activating'].includes(r.saida)) return nivel;
    }
    return null;
  }
  async function estado() {
    const [detector, emCurso] = await Promise.all([estadoMotor(false), instalacaoEmCurso()]);
    const agentes = [];
    // Config ilegível bloqueia os envios (falha fechada): a tela precisa mostrar o caminho e a saída.
    let configErro = null;
    try { lerArquivoConfig(); } catch (e) {
      configErro = { codigo: e.codigo || 'CONFIG_ILEGIVEL', mensagem: e.message, caminho: caminhoConfig,
        o_que_fazer: `Enquanto ${caminhoConfig} estiver ilegível, nenhuma mensagem é enviada aos agentes. Corrija o JSON, ou apague/renomeie esse arquivo (peça ao Admin, se preferir) e ligue de novo a anonimização de cada agente nesta tela.` };
    }
    const lista = registro && registro.estado && registro.estado().ok ? registro.estado().agentes : [];
    for (const a of lista) {
      if (a.tipo === 'admin' || !RX_SLUG.test(a.slug)) continue;
      let ligado = false; let documentos = 0; let aviso = null;
      try { ligado = config(a.slug).ligado; documentos = lerDocs(a.slug).docs.length; } catch (e) { aviso = e.message; }
      agentes.push({ slug: a.slug, nome: a.nome, ligado, documentos, aviso });
    }
    return {
      config_erro: configErro,
      detector: detector.ok ? { nivel: detector.nivel, formatos: detector.formatos, modelo_carregado: detector.modelo_carregado, rss_mb: detector.rss_mb, versao_modelo: detector.versao_modelo }
        : { nivel: null, erro: detector.erro },
      instalacao: { em_andamento: !!emCurso, nivel: emCurso, arquivo: lerEstadoInstalacao() },
      ram: { disponivel_mb: ramDisponivelMb(), total_mb: Math.round(os.totalmem() / 1048576), necessaria_completo_mb: 2500 },
      agentes,
    };
  }
  async function instalarDetector(nivel, forcar) {
    if (!NIVEIS_INSTALAVEIS.includes(nivel)) throw new ErroAnon(400, `O nível precisa ser "leitores" ou "completo". Recebi: ${JSON.stringify(nivel).slice(0, 40)}.`);
    const emCurso = await instalacaoEmCurso();
    if (emCurso) throw new ErroAnon(409, `Já tem uma instalação do detector em andamento (${emCurso}). Espere ela terminar; o progresso aparece nesta tela.`, 'JA_INSTALANDO');
    const livre = ramDisponivelMb();
    if (nivel === 'completo' && livre < 2500 && !forcar) {
      throw new ErroAnon(409, `O detector completo usa cerca de 2 GB de memória e só há ${livre} MB livres agora. Feche o que puder, ou instale só os leitores (30 MB). Para instalar assim mesmo, repita o pedido com "forcar": true.`, 'POUCA_RAM');
    }
    // Só os dois valores fixos entram no nome da unidade; nada vindo do usuário vai para o comando.
    const unidade = nivel === 'completo' ? 'dgclaw-anonimizar-instalar@completo.service' : 'dgclaw-anonimizar-instalar@leitores.service';
    const r = await executaSystemctl(['start', '--no-block', unidade]);
    if (r.erro) {
      log('erro', `Anonimizar: systemctl start ${unidade} falhou (${r.erro.code || r.erro.message}).`);
      throw new ErroAnon(503, `Não consegui iniciar a instalação do detector (${r.erro.code || r.erro.message}). Peça ao Admin para rodar: systemctl start ${unidade}`, 'SYSTEMCTL');
    }
    cacheEstado = { t: 0, valor: null };
    log('info', `Anonimizar: instalação do detector (${nivel}) iniciada.`);
    return { nivel, unidade };
  }

  // ── tabela e documentos ───────────────────────────────────────────────────
  function opcoesMotor(c) { return { valores: !!c.valores, datas: !!c.datas, empresas: !!c.empresas }; }
  function validaNovas(novas, tabela) {
    if (!Array.isArray(novas)) throw new ErroAnon(502, 'O motor devolveu a lista de dados novos num formato inesperado. Nada foi enviado ao agente.', 'MOTOR_RESPOSTA_INVALIDA');
    const existentes = new Map(tabela.map((e) => [e.marcador, e.valor]));
    const ok = [];
    for (const n of novas) {
      const valido = n && TIPOS.includes(n.tipo) && typeof n.valor === 'string' && n.valor && typeof n.marcador === 'string' && n.marcador.startsWith(`[${n.tipo}_`) && /^\[[A-Z]+_\d+\]$/.test(n.marcador);
      if (!valido) throw new ErroAnon(502, 'O motor devolveu um dado novo malformado. Nada foi enviado ao agente. Peça ao Admin para atualizar o DG Claw.', 'MOTOR_RESPOSTA_INVALIDA');
      if (existentes.has(n.marcador)) {
        if (existentes.get(n.marcador) !== n.valor) throw new ErroAnon(502, `O motor reaproveitou o marcador ${n.marcador} para outro valor. Nada foi enviado ao agente, para não misturar duas pessoas.`, 'MARCADOR_DUPLICADO');
        continue;
      }
      existentes.set(n.marcador, n.valor);
      ok.push({ tipo: n.tipo, valor: n.valor, marcador: n.marcador });
    }
    return ok;
  }
  const marcadoresDe = (texto) => { const s = new Set(); for (const m of String(texto).matchAll(RX_MARCADOR)) s.add(m[0]); return s; };
  const somaContagem = (c) => Object.values(c || {}).reduce((s, n) => s + (Number(n) || 0), 0);

  function listarDocumentos(slug) {
    return lerDocs(slug).docs.map((d) => ({
      id: d.id, nome_original: d.nome_original, criado_em: d.criado_em, contagem: d.contagem || {}, total: somaContagem(d.contagem), saidas: d.saidas || [],
    })).sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
  }
  function contaDocumentos(slug) { return lerDocs(slug).docs.length; }

  /**
   * Os marcadores que nenhum documento restante usa perdem o dado real: o valor vira uma lápide que nunca casa com
   * texto. A entrada fica na tabela de propósito, porque o motor numera o próximo marcador como "maior + 1": sem a
   * lápide, o número do último marcador apagado seria dado a outra pessoa.
   */
  const lapide = (e) => ({ tipo: e.tipo, marcador: e.marcador, valor: `\u0000apagado:${crypto.randomBytes(16).toString('hex')}`, apagado: true });
  function podarTabela(slug, docs) {
    const usados = new Set();
    for (const d of docs) for (const m of d.marcadores || []) usados.add(m);
    const t = lerTabela(slug);
    let removidos = 0;
    t.entradas = t.entradas.map((e) => {
      if (e.apagado || usados.has(e.marcador)) return e;
      removidos += 1;
      return lapide(e);
    });
    gravarTabela(slug, t);
    return removidos;
  }
  function apagarDocumento(slug, id) {
    return comTrava(slug, async () => {
      if (!RX_ID.test(id || '')) throw new ErroAnon(400, `O id de documento "${String(id).slice(0, 20)}" não vale.`);
      const r = lerDocs(slug);
      if (!r.docs.some((d) => d.id === id)) throw new ErroAnon(404, `Não achei o documento ${id} neste agente. Veja a lista em GET /api/v1/anonimizar/${slug}/documentos.`);
      r.docs = r.docs.filter((d) => d.id !== id);
      gravarDocs(slug, r);
      const removidos = podarTabela(slug, r.docs);
      log('info', `Anonimizar: documento ${id} de ${slug} apagado do registro; ${removidos} marcador(es) saíram da tabela.`);
      return { removidos_da_tabela: removidos };
    });
  }
  function apagarTudo(slug) {
    return comTrava(slug, async () => {
      const n = lerDocs(slug).docs.length;
      gravarDocs(slug, { docs: [] });
      podarTabela(slug, []);
      log('info', `Anonimizar: registro e tabela de ${slug} apagados (${n} documento(s)).`);
      return { apagados: n };
    });
  }
  function tabela(slug) {
    return lerTabela(slug).entradas.map((e) => (e.apagado ? { tipo: e.tipo, marcador: e.marcador, apagado: true } : { tipo: e.tipo, valor: e.valor, marcador: e.marcador }));
  }

  // ── texto ─────────────────────────────────────────────────────────────────
  // Config que não dá para ler NÃO desliga a proteção em silêncio: lança 503 e a mensagem não é enviada.
  function estaLigado(slug) {
    try { return config(slug).ligado; } catch (e) {
      log('erro', `Anonimizar: não li a configuração de ${slug} (${e.codigo || e.message}). Mensagem recusada até corrigir.`);
      throw new ErroAnon(503, `${e.message} A mensagem não foi enviada, para não mandar dados pessoais sem o filtro.`, e.codigo || 'CONFIG_ILEGIVEL');
    }
  }
  function aplicaDigitado(slug) {
    const c = (() => { try { return config(slug); } catch (e) {
      log('erro', `Anonimizar: não li a configuração de ${slug} (${e.codigo || e.message}). Mensagem recusada até corrigir.`);
      throw new ErroAnon(503, `${e.message} A mensagem não foi enviada, para não mandar dados pessoais sem o filtro.`, e.codigo || 'CONFIG_ILEGIVEL');
    } })();
    return c.ligado && c.aplicar_no_que_digito;
  }
  /** Troca no texto digitado os valores já conhecidos da tabela. Não roda o modelo. */
  function trocarDigitado(slug, texto) {
    if (typeof texto !== 'string' || !texto) return { texto, trocas: 0 };
    const r = trocarValoresConhecidos(texto, lerTabela(slug).entradas);
    if (r.trocas) log('info', `Anonimizar: ${r.trocas} dado(s) trocado(s) no texto digitado para ${slug}.`);
    return r;
  }
  /**
   * Filtro das respostas que o agente recebe pela caixa (tarefas, lembretes, avisos, foco...): troca os valores
   * conhecidos daquele agente em cada texto do JSON, recursivamente. Devolve null se a anonimização está desligada.
   * Lança (503) se a configuração ou a tabela não puderem ser lidas: melhor recusar do que entregar o nome real.
   */
  function filtroSaida(slug) {
    if (!estaLigado(slug)) return null;
    const entradas = lerTabela(slug).entradas;
    if (!entradas.length) return (v) => v;
    const anda = (v) => {
      if (typeof v === 'string') return trocarValoresConhecidos(v, entradas).texto;
      if (Array.isArray(v)) return v.map(anda);
      if (v && typeof v === 'object') { const o2 = {}; for (const [k, x] of Object.entries(v)) o2[k] = anda(x); return o2; }
      return v;
    };
    return anda;
  }
  function reverterTexto(slug, texto) {
    if (typeof texto !== 'string') throw new ErroAnon(400, 'Mande o texto em "texto" (uma string).');
    if (texto.length > MAX_TEXTO) throw new ErroAnon(413, `O texto tem ${texto.length} caracteres e o limite é ${MAX_TEXTO}.`);
    const r = reverterMarcadores(texto, lerTabela(slug).entradas);
    return { texto: r.texto, trocas: r.trocas, desconhecidos: r.desconhecidos };
  }
  /** Tela de teste: tabela temporária, nada é gravado. */
  async function testarTexto(slug, texto) {
    if (typeof texto !== 'string' || !texto.trim()) throw new ErroAnon(400, 'Escreva um texto para testar, no campo "texto".');
    if (texto.length > MAX_TEXTO) throw new ErroAnon(413, `O texto tem ${texto.length} caracteres e o limite do teste é ${MAX_TEXTO}.`);
    const c = slug ? config(slug) : PADRAO_CONFIG;
    const r = await motor.enviar({ op: 'anonimizar_texto', texto, tabela: [], opcoes: opcoesMotor(c) }, 60000);
    if (!r || !r.ok) throw new ErroAnon(422, (r && r.erro) || 'O motor não conseguiu anonimizar o texto.', r && r.codigo);
    const est = await estadoMotor(false);
    const nivel = est.ok ? est.nivel : null;
    return {
      texto: r.texto, contagem: r.contagem || {}, total: somaContagem(r.contagem), nivel,
      aviso: nivel && nivel !== 'completo' ? 'Sem o detector completo, nomes de pessoas, empresas e endereços não são procurados. Só números de documento, e-mail, telefone e parecidos.' : null,
    };
  }

  // ── upload ────────────────────────────────────────────────────────────────
  function limpaTmp() {
    try { fs.rmSync(dirTmp, { recursive: true, force: true }); } catch (e) {
      log('aviso', `Anonimizar: não consegui limpar a pasta temporária ${dirTmp} (${e.code || e.message}). Apague-a à mão: ela pode ter documentos originais.`);
    }
  }
  limpaTmp();   // sobra de uma queda no meio de um pedido; ao subir não há pedido em andamento

  function bloqueio(status, erro, codigo) { return { ok: false, status, erro, codigo }; }

  /**
   * Passa o arquivo pelo motor e copia SÓ as saídas para `pastaDestino`.
   * Devolve { ok:true, id, principal, hostSaidas:[caminho no host], vistos:[caminho que o agente vê], contagem, total, avisos, legenda }
   *      ou { ok:true, semAnonimizar:true, aviso }  (dono escolheu "enviar" para o que não dá para anonimizar)
   *      ou { ok:false, status, erro, codigo }.
   */
  async function processarUpload(agente, { nome, dados, legenda, dia }) {
    const slug = agente.slug;
    let c;
    try { c = config(slug); } catch (e) { return bloqueio(e.status || 500, e.message, e.codigo); }
    if (!c.ligado) return { ok: true, desligado: true };
    return comTrava(slug, () => processarLigado(agente, c, { nome, dados, legenda, dia }));
  }

  async function processarLigado(agente, c, { nome, dados, legenda, dia }) {
    const slug = agente.slug;
    const ext = path.extname(String(nome || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
    const instalarDica = 'Para anonimizar este tipo de arquivo, instale os leitores na tela Anonimizar. Ou mude a opção "Se não der para anonimizar" para enviar assim mesmo.';
    const naoLe = (motivo) => (c.nao_anonimizavel === 'enviar'
      ? { ok: true, semAnonimizar: true, aviso: `Este arquivo foi enviado SEM anonimizar (${motivo}), como você escolheu.` }
      : bloqueio(422, `Não consigo anonimizar este arquivo (${motivo}), então ele não foi enviado ao agente. ${instalarDica}`, 'NAO_ANONIMIZAVEL'));

    if (!EXT_POSSIVEIS.has(ext)) return naoLe(`o formato ${ext || 'sem extensão'} não é de texto nem documento`);
    const est = await estadoMotor(false);
    if (!est.ok) return bloqueio(503, `O motor de anonimização não respondeu: ${est.erro} O documento não foi enviado ao agente. Se isso se repetir, peça ao Admin para conferir o motor.`, 'MOTOR_INDISPONIVEL');
    if (!est.formatos.includes(ext)) return naoLe(`os leitores de ${ext} não estão instalados`);

    const avisos = [];
    if (est.nivel !== 'completo') {
      if (c.sem_detector === 'bloquear') {
        return bloqueio(422, 'O detector de nomes não está instalado, então nomes de pessoas, empresas e endereços passariam sem ser trocados. O documento não foi enviado ao agente. Instale o detector completo na tela Anonimizar, ou mude a opção "Sem o detector de nomes" para trocar só os números (CPF, telefone, e-mail).', 'SEM_DETECTOR');
      }
      avisos.push('Sem o detector de nomes: só números de documento, e-mail e telefone foram trocados. Nomes e endereços passaram.');
    }

    const id = crypto.randomBytes(4).toString('hex');
    let trabalho = null;
    let tabelaAnterior = null; let docGravado = false;
    try {
      pasta0700(raiz); pasta0700(dirTmp);
      trabalho = fs.mkdtempSync(path.join(dirTmp, 'p-'));
      fs.chmodSync(trabalho, 0o700);
      const entrada = path.join(trabalho, `original${ext}`);
      const saidaDir = path.join(trabalho, 'saida');
      fs.writeFileSync(entrada, dados, { mode: 0o600, flag: 'wx' });
      fs.mkdirSync(saidaDir, { mode: 0o700 });

      const t = lerTabela(slug);
      const op = opcoesMotor(c);
      let r;
      try {
        r = await motor.enviar({ op: 'anonimizar', entrada, saida_dir: saidaDir, nome_base: `doc-${id}`, tabela: t.entradas, opcoes: op }, timeoutS * 1000);
      } catch (e) {
        log('erro', `Anonimizar: falha do motor no documento ${id} de ${slug} (${e.codigo || e.message}).`);
        return bloqueio(e.status || 503, e.message, e.codigo);
      }
      if (!r || !r.ok) {
        log('aviso', `Anonimizar: o motor recusou o documento ${id} de ${slug} (${(r && r.codigo) || 'sem código'}).`);
        return bloqueio(422, `${(r && r.erro) || 'O motor não conseguiu anonimizar este documento.'} O documento não foi enviado ao agente.`, (r && r.codigo) || 'MOTOR_RECUSOU');
      }

      const novas = validaNovas(r.novas || [], t.entradas);
      // Só entra o que o motor gravou em saida_dir, com o nome combinado e como arquivo comum.
      const saidasReais = [];
      const raizSaida = fs.realpathSync(saidaDir);
      for (const s of Array.isArray(r.saidas) ? r.saidas : []) {
        const cam = s && typeof s.caminho === 'string' ? s.caminho : '';
        let real;
        try { real = fs.realpathSync(cam); } catch (_) { throw new ErroAnon(502, 'O motor disse ter gravado um arquivo que não existe. Nada foi enviado ao agente.', 'MOTOR_RESPOSTA_INVALIDA'); }
        const st = fs.lstatSync(real);
        if (!dentro(raizSaida, real) || !st.isFile() || !path.basename(real).startsWith(`doc-${id}.anon.`)) {
          throw new ErroAnon(502, 'O motor devolveu um arquivo fora do combinado. Nada foi enviado ao agente.', 'MOTOR_RESPOSTA_INVALIDA');
        }
        saidasReais.push(real);
      }
      if (!saidasReais.length) throw new ErroAnon(502, 'O motor terminou sem gravar nenhum arquivo. Nada foi enviado ao agente.', 'MOTOR_SEM_SAIDA');

      // Marcadores deste documento: SÓ a lista `usados` do motor (ele olha todas as partes de todas as saídas, inclusive
      // cabeçalho, comentário e metadado). Sem ela eu não sei o que apagar depois, então o documento não segue.
      if (!Array.isArray(r.usados) || r.usados.some((m) => typeof m !== 'string' || !/^\[[A-Z]+_\d+\]$/.test(m))) {
        throw new ErroAnon(502, 'O motor de anonimização não informou quais marcadores o documento usa (lista "usados"). Ele está desatualizado: peça ao Admin para atualizar o DG Claw. Nada foi enviado ao agente.', 'MOTOR_SEM_USADOS');
      }
      const marcadores = new Set(r.usados);
      for (const n of novas) marcadores.add(n.marcador);
      let legendaFinal = legenda || '';
      let contagem = r.contagem && typeof r.contagem === 'object' ? Object.assign({}, r.contagem) : {};
      let tabelaAtual = t.entradas.concat(novas);
      if (legendaFinal) {
        const lr = await anonimizaLegenda(slug, legendaFinal, tabelaAtual, op);
        legendaFinal = lr.texto;
        tabelaAtual = tabelaAtual.concat(lr.novas);
        for (const m of marcadoresDe(legendaFinal)) marcadores.add(m);
        for (const n of lr.novas) marcadores.add(n.marcador);
        for (const [k, v] of Object.entries(lr.contagem)) contagem[k] = (Number(contagem[k]) || 0) + v;
      }
      // Primeiro a tabela e o registro (com os caminhos que o agente verá), depois a entrega. Se a entrega falhar, desfaz os dois.
      const nomesSaida = saidasReais.map((p) => path.basename(p));
      const destinoVisivel = path.join(agente.home_host, 'uploads', dia);
      const vistos = nomesSaida.map((n) => paraContainer(path.join(destinoVisivel, n), agente));
      tabelaAnterior = t.entradas;
      t.entradas = tabelaAtual;
      gravarTabela(slug, t);
      const regDocs = lerDocs(slug);
      regDocs.docs.push({ id, nome_original: String(nome || '').slice(0, 200), criado_em: new Date().toISOString(), contagem, marcadores: Array.from(marcadores), saidas: vistos });
      gravarDocs(slug, regDocs);
      docGravado = true;
      // A descida até a pasta é feita pelo ajudante em Python, sem seguir atalho em nenhum componente (o agente pode trocar a pasta enquanto o motor trabalha).
      const entregues = await entregarSeguro({ casa: agente.home_host, dia, origem: saidaDir, nomes: nomesSaida, python: env.DGCLAW_ANON_PYTHON_SISTEMA });
      if (entregues.some((n, i) => n !== nomesSaida[i])) throw new ErroAnon(500, 'Um arquivo com o mesmo nome já estava na pasta do agente. Nada foi enviado; tente de novo.', 'NOME_EM_USO');
      docGravado = false;
      const hostSaidas = nomesSaida.map((n) => path.join(destinoVisivel, n));
      // A saída principal é a que o agente lê melhor: markdown, depois csv, depois a primeira.
      const preferida = ['.md', '.csv'].map((e) => hostSaidas.find((p) => path.extname(p) === e)).find(Boolean);
      const principal = preferida || hostSaidas[0];
      const aviso = Array.isArray(r.avisos) ? r.avisos.filter((x) => typeof x === 'string').slice(0, 10) : [];
      log('info', `Anonimizar: documento ${id} de ${slug} anonimizado (${somaContagem(contagem)} dado(s), nível ${est.nivel}, ${hostSaidas.length} arquivo(s)).`);
      return { ok: true, id, principal, hostSaidas, vistos, contagem, total: somaContagem(contagem), avisos: avisos.concat(aviso), legenda: legendaFinal, nivel: est.nivel };
    } catch (e) {
      if (docGravado) {
        try {
          const rd = lerDocs(slug); rd.docs = rd.docs.filter((d) => d.id !== id); gravarDocs(slug, rd);
          const rt = lerTabela(slug); rt.entradas = tabelaAnterior; gravarTabela(slug, rt);
        } catch (e2) { log('erro', `Anonimizar: não consegui desfazer o registro do documento ${id} (${e2.message}).`); }
      }
      if (e instanceof ErroEntrega) return bloqueio(e.status, `${e.message} Nada foi enviado ao agente.`, e.codigo || 'ENTREGA');
      if (!(e instanceof ErroAnon)) log('erro', `Anonimizar: erro inesperado no documento ${id} de ${slug} (${e.code || e.message}).`);
      return bloqueio(e.status || 500, e instanceof ErroAnon ? e.message : `Não consegui anonimizar o documento (${e.code || e.message}). Nada foi enviado ao agente. Confira o espaço em disco e as permissões da pasta do agente.`, e.codigo || 'ERRO');
    } finally {
      if (trabalho) { try { fs.rmSync(trabalho, { recursive: true, force: true }); } catch (e) { log('aviso', `Anonimizar: não apaguei o temporário do documento ${id} (${e.code || e.message}). Apague ${dirTmp} à mão.`); } }
    }
  }

  async function anonimizaLegenda(slug, legenda, tabelaAtual, op) {
    // O motor já reaproveita a tabela; trocar antes aqui faria ele neutralizar os marcadores que eu pusesse.
    let r;
    try {
      r = await motor.enviar({ op: 'anonimizar_texto', texto: legenda, tabela: tabelaAtual, opcoes: op }, 60000);
    } catch (e) { throw new ErroAnon(e.status || 503, `Não consegui anonimizar a legenda: ${e.message}`, e.codigo); }
    if (!r || !r.ok) throw new ErroAnon(422, `Não consegui anonimizar a legenda: ${(r && r.erro) || 'o motor recusou o texto'}. Nada foi enviado ao agente.`, 'LEGENDA');
    const novas = validaNovas(r.novas || [], tabelaAtual);
    return { texto: typeof r.texto === 'string' ? r.texto : '', novas, contagem: r.contagem && typeof r.contagem === 'object' ? r.contagem : {} };
  }

  // ── versão final ──────────────────────────────────────────────────────────
  /**
   * Gera a versão com os dados reais de um arquivo que o agente mandou. `entrada` vem de midia.obter(id).
   * Devolve { dados, nome, mime, trocas, desconhecidos }. Lança ErroAnon (404/422/503...).
   */
  async function gerarFinal(agente, entrada) {
    const slug = agente.slug;
    if (!agente.home_host) throw new ErroAnon(503, `O agente ${agente.nome} não tem home_host no registro.`);
    if (!entrada || entrada.slug !== slug) throw new ErroAnon(404, 'Não achei esse arquivo entre os do agente. Recarregue a conversa e tente de novo.', 'MIDIA_DE_OUTRO');
    // Só a checagem do texto do caminho; quem abre o arquivo de verdade é o ajudante, sem seguir atalho.
    const relativo = path.relative(path.resolve(agente.home_host), path.resolve(entrada.path));
    if (!relativo || relativo.startsWith('..') || path.isAbsolute(relativo)) {
      log('aviso', `Anonimizar: pedido de versão final recusado para ${slug}: o arquivo está fora da pasta do agente.`);
      throw new ErroAnon(403, 'Este arquivo está fora da pasta do agente e não será aberto.', 'FORA_DA_CASA');
    }
    const ext = path.extname(relativo).toLowerCase();
    if (EXT_ATIVA.has(ext)) throw new ErroAnon(422, `Arquivo ${ext} pode conter scripts e endereços, e trocar os marcadores dentro dele não é seguro. Peça ao agente o mesmo resultado em .md ou .docx e baixe a versão final desse.`, 'FORMATO_ATIVO');
    if (ext === '.pdf') throw new ErroAnon(422, 'PDF não dá para voltar aos dados reais, porque o texto dele não é trocado de forma segura. Peça ao agente o mesmo resultado em .docx ou .md e baixe a versão final desse.', 'PDF');
    if (!EXT_FINAL.has(ext)) throw new ErroAnon(422, `Não sei voltar os dados reais em arquivo ${ext || 'sem extensão'}. Os formatos aceitos são .docx, .xlsx, .pptx, .md, .txt, .csv e .json. Peça ao agente o resultado em um deles.`, 'FORMATO');
    const tab = lerTabela(slug).entradas.filter((e) => !e.apagado);
    if (!tab.length) throw new ErroAnon(422, 'Este agente não tem tabela de dados (nenhum documento anonimizado ainda), então não há o que voltar.', 'SEM_TABELA');

    let trabalho = null;
    try {
      pasta0700(raiz); pasta0700(dirTmp);
      trabalho = fs.mkdtempSync(path.join(dirTmp, 'f-'));
      fs.chmodSync(trabalho, 0o700);
      const ent = path.join(trabalho, `entrada${ext}`); const sai = path.join(trabalho, `final${ext}`);
      // Copia para o temporário do root antes de chamar o motor: atalho, FIFO e arquivo especial são recusados sem travar.
      try { await lerSeguro({ casa: agente.home_host, relativo: relativo.split(path.sep).join('/'), destino: ent, maximo: MAX_FINAL_BYTES, python: env.DGCLAW_ANON_PYTHON_SISTEMA }); } catch (e) {
        if (e instanceof ErroEntrega) {
          log('aviso', `Anonimizar: versão final recusada para ${slug} (${e.codigo || 'erro'}).`);
          throw new ErroAnon(e.codigo === 'grande' ? 413 : (e.codigo === 'ausente' ? 404 : 422), e.message, e.codigo);
        }
        throw e;
      }
      let r;
      try { r = await motor.enviar({ op: 'reverter', entrada: ent, saida: sai, tabela: tab }, 120000); } catch (e) {
        log('erro', `Anonimizar: falha do motor ao gerar a versão final para ${slug} (${e.codigo || e.message}).`);
        throw e;
      }
      if (!r || !r.ok) throw new ErroAnon(422, `${(r && r.erro) || 'O motor não conseguiu gerar a versão final.'}`, (r && r.codigo) || 'REVERTER');
      let dadosFinal;
      try { dadosFinal = fs.readFileSync(sai); } catch (_) { throw new ErroAnon(502, 'O motor disse ter gerado a versão final mas o arquivo não está lá.', 'MOTOR_SEM_SAIDA'); }
      const baseNome = path.basename(entrada.nome || relativo, path.extname(entrada.nome || relativo));
      log('info', `Anonimizar: versão final gerada para ${slug} (${r.trocas == null ? '?' : r.trocas} troca(s)).`);
      return { dados: dadosFinal, nome: `${baseNome}-final${ext}`, ext, trocas: r.trocas == null ? null : r.trocas, desconhecidos: Array.isArray(r.desconhecidos) ? r.desconhecidos : [] };
    } finally {
      if (trabalho) { try { fs.rmSync(trabalho, { recursive: true, force: true }); } catch (e) { log('aviso', `Anonimizar: não apaguei o temporário da versão final (${e.code || e.message}).`); } }
    }
  }

  return {
    ErroAnon, config, validaConfig, gravarConfig, estado, instalarDetector, estadoMotor,
    listarDocumentos, contaDocumentos, apagarDocumento, apagarTudo, tabela,
    estaLigado, filtroSaida, aplicaDigitado, trocarDigitado, reverterTexto, testarTexto, processarUpload, gerarFinal,
    encerrar() { motor.encerrar(); }, motorVivo: () => motor.vivo(),
    caminhos: { raiz, tmp: dirTmp, config: caminhoConfig, chave: caminhoChave },
  };
}

module.exports = { criarAnonimizar, ErroAnon, trocarValoresConhecidos, reverterMarcadores, PADRAO_CONFIG, TIPOS, EXT_FINAL, RX_SLUG, RX_ID };
