'use strict';
// Leitor do histórico dos agentes (seção Logs do Admin). Sem HTTP: descobre os arquivos de sessão
// (Claude em <casa>/.claude/projects, Codex em <casa>/.codex/sessions), lê de trás para frente sem
// carregar o arquivo inteiro, junta tudo numa linha do tempo única e mascara o que sai.
//
// O Web é root e a casa do agente é do agente: tudo aqui trata o conteúdo da pasta como hostil.
//   - atalho (symlink) nunca é seguido; só entra arquivo regular com nome conhecido e um único nome (nlink 1);
//   - todo arquivo abre com O_NOFOLLOW|O_NONBLOCK, é conferido com fstat e o caminho real do descritor
//     (/proc/self/fd) precisa ficar dentro da raiz permitida;
//   - só a API assíncrona do fs (o Web é um processo só e serve o chat), em blocos de 64 KB;
//   - o texto do log nunca é de confiança: sai mascarado (limpa) e truncado, e a busca olha o texto já mascarado.
// Contrato e limites: web/docs/LOGS.md.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { mascarar, OCULTO } = require('./mascara');

const BLOCO = 64 * 1024;
const MAX_LINHA = 4 * 1024 * 1024;
const JANELA_HINT = 512 * 1024;
const DETECCAO = 256 * 1024;
const FOLGA_MTIME = 5 * 60 * 1000;
const MAX_PROFUNDIDADE = 5;
const MAX_ARQUIVOS = 20000;
const MAX_FDS = 32;
const MAX_HINTS = 64;
const MAX_RESULTADOS = 512;
const MAX_AVISOS = 50;
const MAX_ENTRADAS = 50000;
const MAX_PASTAS = 10000;
const PRAZO_DESCOBERTA_MS = 3000;
const BRUTO = 64 * 1024;
const TETO_TEXTO = 4096;
const TETO_COMANDO = 2048;
const TETO_RESULTADO = 4096;
const TETO_CURSOR = 8 * 1024;
const ORCAMENTO_BYTES = 64 * 1024 * 1024;
const ORCAMENTO_MS = 1500;

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RX_CLAUDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const RX_SUBAGENTE = /^agent-[A-Za-z0-9_-]{1,100}\.jsonl$/;
const RX_ROLLOUT = /^rollout-[A-Za-z0-9_.-]{1,160}\.jsonl$/;
const RX_UUID_FIM = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RX_ID_CURTO = /^[0-9a-f]{12}$/;
const TIPOS = ['mensagem', 'comando', 'arquivo', 'ferramenta', 'sistema'];
const CONTEXTO_INJETADO = ['<environment_context>', '<user_instructions>', '# AGENTS.md'];

/** Devolve uma função que cede o laço de eventos a cada ~8 ms de trabalho seguido (o Web serve o chat no mesmo processo). */
function criaCede(relogio) {
  let ultimo = relogio();
  return async function cede() {
    const t = relogio();
    if (t - ultimo < 8 && t >= ultimo) return;
    await new Promise((r) => setImmediate(r));
    ultimo = relogio();
  };
}

class ErroEntrada extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

class ErroArquivo extends Error {
  constructor(tipo, motivo) { super(motivo); this.tipo = tipo; this.motivo = motivo; }
}

// ── máscara ────────────────────────────────────────────────────────────────
// mascara.js cobre os formatos mais comuns; aqui entram os de outros fornecedores, cabeçalhos, flags de linha
// de comando e atribuições em português. É defesa em profundidade: segredo fora destes formatos passa.
const EXTRAS = [
  [/sk-[A-Za-z0-9_-]{20,200}/g, OCULTO],
  [/sk_[a-z0-9]{20,200}/gi, OCULTO],
  [/\bgsk_[A-Za-z0-9]{10,200}/g, OCULTO],
  [/\bxai-[A-Za-z0-9]{10,200}/g, OCULTO],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,200}/g, OCULTO],
  [/\bgh[srpu]_[A-Za-z0-9]{20,200}/g, OCULTO],
  [/\beyJ[A-Za-z0-9_-]{5,200}\.[A-Za-z0-9_-]{5,200}\.[A-Za-z0-9_-]{5,200}/g, OCULTO],
  // Depois de mascarar(), o valor pode chegar como "[segredo oculto] resto" (o esquema vira o marcador e o token sobra).
  [/\b(Authorization[ \t]{0,20}:[ \t]{0,20})(?:\[segredo oculto\](?:[ \t]{1,20}\S{1,300})?|\S{1,300}(?:[ \t]{1,20}\S{1,300})?)/gi, '$1' + OCULTO],
  [/\b(X-Api-Key[ \t]{0,20}:[ \t]{0,20})\S{1,300}/gi, '$1' + OCULTO],
  [/(--(?:password|token|api-key|secret|senha)(?:=|[ \t]{1,20}))("[^"\n]{0,300}"|'[^'\n]{0,300}'|\S{1,300})/gi, '$1' + OCULTO],
  [/(\bcurl\b[^\n]{0,300}?[ \t](?:-u|--user)[ \t]{1,20})("[^"\n]{0,300}"|'[^'\n]{0,300}'|\S{1,300})/gi, '$1' + OCULTO],
  [/(\bmysql(?:dump)?\b[^\n]{0,300}?[ \t]-p)(\S{1,300})/gi, '$1' + OCULTO],
  [/((?:\bchave|\bpwd|\bcookie)[A-Za-z0-9_.-]{0,60}["']?[ \t]{0,20}[=:][ \t]{0,20})("[^"\n]{0,500}"|'[^'\n]{0,500}'|[^\s"'&;|]{1,500})/gi, '$1' + OCULTO],
];

// Os padrões de mascara.js (principalmente a atribuição NOME=valor) varrem cada trecho de letras e números até o fim
// para achar uma palavra-chave: numa sequência de 64 KB sem espaço isso vira conta quadrática, e o agente é quem escreve
// o texto. Sequência longa demais não é palavra nem segredo conhecido (um JWT ou uma chave em base64 também cai aqui):
// sai omitida por inteiro, o que protege o valor e mantém todos os padrões em tempo linear.
const RX_SEQUENCIA_LONGA = /[A-Za-z0-9_.-]{129,}/g;

/** Corta em 64 KB e descarta também o último pedaço sem espaço, para não sobrar um segredo cortado no limite. */
function corteBruto(s) {
  if (s.length <= BRUTO) return s;
  let fim = BRUTO;
  while (fim > 0 && !/\s/.test(s[fim - 1])) fim--;
  return s.slice(0, fim);
}

/** Tudo o que sai da API passa por aqui: limite de 64 KB, mascarar de mascara.js e depois os padrões extras. */
function limpa(texto) {
  if (texto == null) return '';
  let r = corteBruto(typeof texto === 'string' ? texto : String(texto));
  r = mascarar(r.replace(RX_SEQUENCIA_LONGA, '[trecho longo omitido]'));
  for (const [rx, sub] of EXTRAS) { rx.lastIndex = 0; r = r.replace(rx, sub); }
  return r;
}

function serializa(valor) {
  if (valor == null) return '';
  if (typeof valor === 'string') return valor;
  try { return JSON.stringify(valor); } catch (_) { return '[objeto que não pude serializar]'; }
}

/** Corta em `max` caracteres sem partir um par substituto. */
function corta(texto, max) {
  const s = String(texto == null ? '' : texto);
  if (s.length <= max) return { texto: s, truncado: false };
  let fim = max;
  const c = s.charCodeAt(fim - 1);
  if (c >= 0xD800 && c <= 0xDBFF) fim -= 1;
  return { texto: s.slice(0, fim), truncado: true };
}

/** Mascara antes de truncar. Devolve { cheio (mascarado, até 64 KB), texto (teto), truncado }. */
function preparaTexto(bruto, teto) {
  const s = serializa(bruto);
  const cheio = limpa(s);
  const c = corta(cheio, teto);
  return { cheio, texto: c.texto, truncado: c.truncado || s.length > BRUTO };
}

function normaliza(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function caminhoRelativo(p, bases) {
  const s = String(p == null ? '' : p);
  if (!s) return '';
  for (const b of bases) {
    if (!b) continue;
    const base = b.replace(/\/+$/, '');
    if (s === base || s.startsWith(base + '/')) return '~' + s.slice(base.length);
  }
  if (s.startsWith('/')) return '…/' + s.split('/').filter(Boolean).slice(-3).join('/');
  return s;
}

// ── cursor ─────────────────────────────────────────────────────────────────
function codificaCursor(c) { return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url'); }

function inteiro(v, min) { return Number.isSafeInteger(v) && v >= min; }

/** Valida o cursor recebido. Hint inválido é descartado em silêncio; o resto inválido é erro 400. */
function decodificaCursor(texto) {
  if (texto == null || texto === '') return null;
  const ruim = (m) => new ErroEntrada(400, `O cursor "${String(texto).slice(0, 40)}" não vale (${m}). Peça a primeira página de novo, sem o parâmetro "cursor".`);
  if (typeof texto !== 'string' || texto.length > TETO_CURSOR || !/^[A-Za-z0-9_-]+$/.test(texto)) throw ruim('formato ou tamanho');
  let o;
  try { o = JSON.parse(Buffer.from(texto, 'base64url').toString('utf8')); } catch (_) { throw ruim('não é JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw ruim('estrutura');
  const temChave = o.t !== undefined || o.f !== undefined || o.o !== undefined || o.i !== undefined;
  const r = { chave: null, h: {} };
  if (temChave) {
    if (!(typeof o.t === 'number' && Number.isFinite(o.t)) || typeof o.f !== 'string' || !RX_ID_CURTO.test(o.f) || !inteiro(o.o, 0) || !inteiro(o.i, 0)) throw ruim('chave de posição');
    r.chave = { t: o.t, f: o.f, o: o.o, i: o.i };
  }
  if (o.h !== undefined) {
    if (!o.h || typeof o.h !== 'object' || Array.isArray(o.h)) throw ruim('hints');
    let n = 0;
    for (const [k, v] of Object.entries(o.h)) {
      if (++n > MAX_HINTS) break;
      if (!RX_ID_CURTO.test(k) || !Array.isArray(v) || v.length !== 2) continue;
      if (!(Number.isSafeInteger(v[0]) && v[0] >= -1) || !(typeof v[1] === 'number' && Number.isFinite(v[1]))) continue;
      r.h[k] = { o: v[0], teto: v[1] };
    }
  }
  return r;
}

function cmp(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.f !== b.f) return a.f < b.f ? -1 : 1;
  if (a.o !== b.o) return a.o < b.o ? -1 : 1;
  return a.i < b.i ? -1 : a.i > b.i ? 1 : 0;
}

// ── descoberta ─────────────────────────────────────────────────────────────
function idCurto(motor, rel) { return crypto.createHash('sha256').update(`${motor}/${rel}`).digest('hex').slice(0, 12); }

function fontesDoAgente(ag) {
  const r = [];
  if (ag.tipo === 'admin') {
    if (ag.transcripts_dir) r.push({ motor: 'claude', raiz: ag.transcripts_dir, permitida: ag.transcripts_dir, rotulo: 'transcripts_dir', projetoFixo: path.basename(ag.transcripts_dir) });
    else r.push({ motor: 'claude', semRaiz: 'o registro não informa transcripts_dir para o Admin' });
    if (ag.codex_home_host) r.push({ motor: 'codex', raiz: path.join(ag.codex_home_host, 'sessions'), permitida: ag.codex_home_host, rotulo: 'codex_home_host/sessions' });
    return r;
  }
  if (!ag.home_host) {
    return [{ motor: 'claude', semRaiz: 'o registro não informa home_host deste agente' }, { motor: 'codex', semRaiz: 'o registro não informa home_host deste agente' }];
  }
  r.push({ motor: 'claude', raiz: path.join(ag.home_host, '.claude', 'projects'), permitida: ag.home_host, rotulo: '.claude/projects' });
  r.push({ motor: 'codex', raiz: path.join(ag.home_host, '.codex', 'sessions'), permitida: ag.home_host, rotulo: '.codex/sessions' });
  return r;
}

function nomeValido(motor, nome) {
  return motor === 'claude' ? (RX_CLAUDE.test(nome) || RX_SUBAGENTE.test(nome)) : RX_ROLLOUT.test(nome);
}

function descreveArquivo(fonte, raizReal, abs, st) {
  const rel = path.relative(raizReal, abs).split(path.sep).join('/');
  const nome = path.basename(abs);
  const segs = rel.split('/');
  let sessao = null;
  if (fonte.motor === 'claude') {
    if (RX_CLAUDE.test(nome)) sessao = nome.slice(0, -6).toLowerCase();
    else { const s = segs.find((x) => RX_UUID.test(x)); sessao = s ? s.toLowerCase() : null; }
  } else {
    const m = RX_UUID_FIM.exec(nome);
    sessao = m ? m[1].toLowerCase() : null;
  }
  const projeto = fonte.projetoFixo || (fonte.motor === 'claude' && segs.length >= 2 ? segs[0] : null);
  return {
    abs, raizReal, rel, nome, motor: fonte.motor, id: idCurto(fonte.motor, rel), bytes: st.size, mtimeMs: st.mtimeMs,
    subagente: fonte.motor === 'claude' && (RX_SUBAGENTE.test(nome) || segs.includes('subagents')),
    projeto, sessao, rotulo: `${fonte.motor}:${rel}`,
  };
}

/** Lista os arquivos de uma fonte, sem seguir atalho. Nunca lança: o que deu errado vira estado e aviso. */
async function descobreFonte(fonte, lim) {
  const saida = { motor: fonte.motor, estado: 'ok', motivo: null, arquivos: [], avisos: [], atalhos_ignorados: 0, avisosOmitidos: 0, raizReal: null };
  if (fonte.semRaiz) { saida.estado = 'ausente'; saida.motivo = fonte.semRaiz; return saida; }
  let permReal;
  let raizReal;
  try { permReal = await fsp.realpath(fonte.permitida); } catch (e) {
    saida.estado = e.code === 'ENOENT' ? 'ausente' : 'ilegivel';
    saida.motivo = e.code === 'ENOENT' ? 'a pasta do agente não existe no servidor (nunca rodou neste motor)' : `não consegui abrir a pasta do agente (${e.code || e.message})`;
    return saida;
  }
  try { raizReal = await fsp.realpath(fonte.raiz); } catch (e) {
    if (e.code === 'ENOENT') { saida.estado = 'ausente'; saida.motivo = `nunca rodou neste motor (${fonte.rotulo} não existe)`; } else {
      saida.estado = 'ilegivel'; saida.motivo = `não consegui resolver ${fonte.rotulo} (${e.code || e.message})`;
    }
    return saida;
  }
  if (raizReal !== permReal && !raizReal.startsWith(permReal + path.sep)) {
    saida.estado = 'ilegivel';
    saida.motivo = `${fonte.rotulo} aponta para fora da pasta do agente; recusei por segurança`;
    return saida;
  }
  saida.raizReal = raizReal;
  const inicio = lim.relogio();
  const aviso = (a) => { if (saida.avisos.length < lim.maxAvisos) saida.avisos.push(a); else saida.avisosOmitidos++; };
  const pilha = [{ dir: raizReal, prof: 0 }];
  let parcial = null;     // motivo de ter parado antes de ver tudo
  let entradas = 0;
  while (pilha.length && !parcial) {
    const { dir, prof } = pilha.pop();
    let d;
    try { d = await fsp.opendir(dir); } catch (e) {
      const relDir = path.relative(raizReal, dir) || '.';
      if (dir === raizReal) { saida.estado = 'ilegivel'; saida.motivo = `não consegui listar ${fonte.rotulo} (${e.code || e.message})`; return saida; }
      aviso({ tipo: 'pasta_ilegivel', motivo: `não consegui listar a pasta (${e.code || e.message})`, arquivo: `${fonte.motor}:${relDir}` });
      continue;
    }
    try {
      for await (const ent of d) {
        if (saida.arquivos.length >= lim.maxArquivos) { parcial = `a pasta tem mais de ${lim.maxArquivos} arquivos de sessão; só os primeiros ${lim.maxArquivos} entraram na lista`; break; }
        if (++entradas > lim.maxEntradas) { parcial = `a pasta tem mais de ${lim.maxEntradas} entradas; parei de olhar por segurança e a lista pode estar incompleta`; break; }
        if (entradas % 64 === 0) {
          await lim.cede();
          if (lim.relogio() - inicio > lim.ms) { parcial = `a leitura da pasta passou de ${lim.ms} ms e parou; a lista pode estar incompleta`; break; }
        }
        const abs = path.join(dir, ent.name);
        let tipo = ent.isSymbolicLink() ? 'l' : ent.isDirectory() ? 'd' : ent.isFile() ? 'f' : null;
        let st = null;
        if (!tipo) {
          try { st = await fsp.lstat(abs); } catch (_) { continue; }
          tipo = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
        }
        if (tipo === 'l') { saida.atalhos_ignorados++; continue; }
        if (tipo === 'd') {
          if (prof + 1 > lim.maxProfundidade) continue;
          if (pilha.length >= lim.maxPastas) { parcial = `a pasta tem mais de ${lim.maxPastas} subpastas esperando leitura; parei de olhar por segurança e a lista pode estar incompleta`; break; }
          pilha.push({ dir: abs, prof: prof + 1 });
          continue;
        }
        if (!nomeValido(fonte.motor, ent.name)) continue;
        const rel = `${fonte.motor}:${path.relative(raizReal, abs).split(path.sep).join('/')}`;
        if (tipo !== 'f') { aviso({ tipo: 'arquivo_recusado', motivo: 'não é um arquivo regular', arquivo: rel }); continue; }
        try { st = await fsp.lstat(abs); } catch (e) { aviso({ tipo: 'arquivo_ilegivel', motivo: `não consegui conferir o arquivo (${e.code || e.message})`, arquivo: rel }); continue; }
        if (!st.isFile()) { aviso({ tipo: 'arquivo_recusado', motivo: 'não é um arquivo regular', arquivo: rel }); continue; }
        if (st.nlink !== 1) { aviso({ tipo: 'arquivo_recusado', motivo: 'o arquivo tem mais de um nome no disco (hardlink); recusei por segurança', arquivo: rel }); continue; }
        saida.arquivos.push(descreveArquivo(fonte, raizReal, abs, st));
      }
    } catch (e) {
      aviso({ tipo: 'pasta_ilegivel', motivo: `a leitura da pasta parou (${e.code || e.message})`, arquivo: `${fonte.motor}:${path.relative(raizReal, dir) || '.'}` });
    } finally {
      await d.close().catch(() => {});
    }
  }
  if (parcial) {
    saida.avisos.push({ tipo: 'limite', motivo: parcial, arquivo: fonte.motor });
    saida.estado = 'parcial';
    saida.motivo = parcial;
    return saida;
  }
  if (!saida.arquivos.length) {
    if (saida.avisos.length) {
      saida.estado = 'ilegivel';
      saida.motivo = `nenhum arquivo pôde ser lido: ${saida.avisos[0].motivo}${saida.avisos[0].arquivo ? ` (${saida.avisos[0].arquivo})` : ''}`;
    } else {
      saida.estado = 'vazia';
      saida.motivo = `${fonte.rotulo} existe, mas ainda não tem nenhuma sessão gravada`;
    }
  }
  return saida;
}

function resumoDaFonte(f) {
  const ok = f.estado === 'ok' || f.estado === 'parcial';
  return {
    motor: f.motor,
    estado: f.estado,
    motivo: f.motivo,
    arquivos: ok || f.estado === 'vazia' ? f.arquivos.length : null,
    bytes: ok || f.estado === 'vazia' ? f.arquivos.reduce((s, a) => s + a.bytes, 0) : null,
    ultima_atividade: ok && f.arquivos.length ? Math.round(f.arquivos.reduce((m, a) => Math.max(m, a.mtimeMs), 0)) : null,
  };
}

// ── abrir com segurança ────────────────────────────────────────────────────
async function abrirSeguro(arq) {
  let fh;
  try {
    fh = await fsp.open(arq.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP') throw new ErroArquivo('arquivo_recusado', 'o arquivo virou um atalho; recusei por segurança');
    throw new ErroArquivo('arquivo_ilegivel', `não consegui abrir o arquivo (${e.code || e.message})`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ErroArquivo('arquivo_recusado', 'não é um arquivo regular');
    if (st.nlink !== 1) throw new ErroArquivo('arquivo_recusado', 'o arquivo tem mais de um nome no disco (hardlink); recusei por segurança');
    let alvo;
    try { alvo = await fsp.readlink(`/proc/self/fd/${fh.fd}`); } catch (e) {
      throw new ErroArquivo('arquivo_recusado', `não consegui confirmar o caminho real do arquivo (/proc indisponível: ${e.code || e.message}); recusei por segurança`);
    }
    alvo = alvo.replace(/ \(deleted\)$/, '');
    if (!(alvo === arq.raizReal || alvo.startsWith(arq.raizReal + path.sep))) throw new ErroArquivo('arquivo_recusado', 'o caminho real do arquivo fica fora da pasta do agente; recusei por segurança');
    return { fh, size: st.size };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

// ── extração por motor ─────────────────────────────────────────────────────
const OPERACAO_ARQUIVO = { Read: 'ler', Write: 'escrever', Edit: 'editar', MultiEdit: 'editar', NotebookEdit: 'editar' };

function textoDeBlocos(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const partes = [];
  for (const b of c) {
    if (typeof b === 'string') partes.push(b);
    else if (b && typeof b.text === 'string') partes.push(b.text);
    else if (b && typeof b === 'object' && b.type) partes.push(`[${String(b.type).slice(0, 30)}]`);
  }
  return partes.join('\n');
}

function resultadoDe(bruto, erro) {
  const p = preparaTexto(bruto, TETO_RESULTADO);
  return { erro: !!erro, texto: p.texto, truncado: p.truncado };
}

function comandoDeLista(c) {
  if (Array.isArray(c)) {
    if (c.length >= 3 && /^(?:-lc|-c)$/.test(String(c[1]))) return String(c[2]);
    return c.map(String).join(' ');
  }
  return typeof c === 'string' ? c : '';
}

async function extraiClaude(j, leitor, soRes) {
  const tipoLinha = j.type;
  if (tipoLinha === 'system') {
    if (!soRes && j.subtype === 'compact_boundary') return [{ tipo: 'sistema', papel: 'sistema', titulo: 'Conversa compactada', texto: '' }];
    return [];
  }
  if (tipoLinha !== 'user' && tipoLinha !== 'assistant') return [];
  const msg = j.message;
  if (!msg || typeof msg !== 'object') return [];
  const papel = tipoLinha === 'assistant' ? 'agente' : (leitor.arq.subagente ? 'sistema' : 'pessoa');
  const c = msg.content;
  const out = [];
  const mensagem = (texto) => {
    if (typeof texto !== 'string' || !texto.trim()) return;
    out.push({ tipo: 'mensagem', papel, titulo: papel === 'pessoa' ? 'Mensagem da pessoa' : papel === 'agente' ? 'Resposta do agente' : 'Instrução recebida', texto });
  };
  if (typeof c === 'string') { if (!soRes) mensagem(c); return out; }
  if (!Array.isArray(c)) return [];
  let n = 0;
  for (const b of c) {
    // Uma linha pode trazer milhares de blocos: cede o laço e confere o prazo no meio dela (null = abandonada, será relida).
    if (++n % 16 === 0) {
      await leitor.ctx.cede();
      if (leitor.ctx.excedeu()) return null;
    }
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') {
      if (typeof b.tool_use_id === 'string') leitor.guardaResultado(b.tool_use_id, resultadoDe(textoDeBlocos(b.content), b.is_error));
      continue;
    }
    if (soRes) continue;
    if (b.type === 'text') mensagem(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      const entrada = b.input && typeof b.input === 'object' ? b.input : {};
      const resultado = typeof b.id === 'string' ? leitor.resultados.get(b.id) || null : null;
      if (b.name === 'Bash') {
        out.push({ tipo: 'comando', titulo: typeof entrada.description === 'string' && entrada.description ? entrada.description : 'Comando', comando: entrada.command, descricao: entrada.description, resultado });
      } else if (OPERACAO_ARQUIVO[b.name]) {
        const caminho = entrada.file_path || entrada.notebook_path || entrada.path || '';
        out.push({ tipo: 'arquivo', titulo: `${OPERACAO_ARQUIVO[b.name] === 'ler' ? 'Leu' : OPERACAO_ARQUIVO[b.name] === 'escrever' ? 'Escreveu' : 'Editou'} um arquivo`, caminho, operacao: OPERACAO_ARQUIVO[b.name], ferramenta: b.name, resultado });
      } else {
        out.push({ tipo: 'ferramenta', titulo: b.name, ferramenta: b.name, entrada, resultado });
      }
    }
  }
  return out;
}

function ehContextoInjetado(texto) {
  const t = String(texto).trimStart();
  return CONTEXTO_INJETADO.some((p) => t.startsWith(p)) || t.startsWith('<plataforma');
}

function itemCodex(item, out) {
  switch (item && item.type) {
    case 'UserMessage': { const t = textoDeBlocos(item.content); if (t.trim()) out.push({ tipo: 'mensagem', papel: 'pessoa', titulo: 'Mensagem da pessoa', texto: t }); break; }
    case 'AgentMessage': { const t = textoDeBlocos(item.content); if (t.trim()) out.push({ tipo: 'mensagem', papel: 'agente', titulo: 'Resposta do agente', texto: t }); break; }
    case 'CommandExecution': {
      const erro = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      out.push({ tipo: 'comando', titulo: 'Comando', comando: comandoDeLista(item.command), resultado: resultadoDe(item.aggregated_output, erro) });
      break;
    }
    case 'McpToolCall': {
      const nome = [item.server, item.tool].filter((x) => typeof x === 'string' && x).join('/') || 'ferramenta MCP';
      const erro = item.status !== undefined && item.status !== 'completed';
      const res = item.result ? resultadoDe(textoDeBlocos(item.result.content), erro) : (item.error ? resultadoDe(item.error, true) : null);
      out.push({ tipo: 'ferramenta', titulo: nome, ferramenta: nome, entrada: item.arguments, resultado: res });
      break;
    }
    case 'FileChange': {
      let caminho = item.path || item.file_path || '';
      if (!caminho && Array.isArray(item.changes) && item.changes[0]) caminho = item.changes[0].path || '';
      if (!caminho && item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes)) caminho = Object.keys(item.changes)[0] || '';
      out.push({ tipo: 'arquivo', titulo: 'Alterou um arquivo', caminho, operacao: 'alterar', ferramenta: 'FileChange', resultado: null });
      break;
    }
    default: break;
  }
}

function saidaDeFuncao(o) {
  if (typeof o === 'string') {
    try {
      const j = JSON.parse(o);
      if (j && typeof j === 'object' && typeof j.output === 'string') {
        const cod = j.metadata && j.metadata.exit_code;
        return resultadoDe(j.output, typeof cod === 'number' && cod !== 0);
      }
    } catch (_) { /* texto puro */ }
    return resultadoDe(o, false);
  }
  return resultadoDe(textoDeBlocos(o), false);
}

const NOMES_SHELL = new Set(['shell', 'local_shell', 'exec_command', 'container.exec', 'shell_command']);

function extraiCodex(j, leitor, soRes) {
  const p = j.payload;
  if (!p || typeof p !== 'object') return [];
  const out = [];
  if (leitor.formato === 'itens') {
    if (soRes || j.type !== 'event_msg' || p.type !== 'item_completed') return [];
    itemCodex(p.item, out);
    return out;
  }
  if (j.type !== 'response_item') return [];
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    if (typeof p.call_id === 'string') leitor.guardaResultado(p.call_id, saidaDeFuncao(p.output));
    return [];
  }
  if (soRes) return [];
  if (p.type === 'message') {
    const t = textoDeBlocos(p.content);
    if (!t.trim()) return [];
    if (p.role === 'assistant') out.push({ tipo: 'mensagem', papel: 'agente', titulo: 'Resposta do agente', texto: t });
    else if (p.role === 'user' && !ehContextoInjetado(t)) out.push({ tipo: 'mensagem', papel: 'pessoa', titulo: 'Mensagem da pessoa', texto: t });
    return out;
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const nome = typeof p.name === 'string' ? p.name : 'ferramenta';
    const resultado = typeof p.call_id === 'string' ? leitor.resultados.get(p.call_id) || null : null;
    let args = p.type === 'function_call' ? p.arguments : p.input;
    if (typeof args === 'string' && p.type === 'function_call') { try { args = JSON.parse(args); } catch (_) { /* fica texto */ } }
    if (nome === 'apply_patch') {
      const txt = typeof args === 'string' ? args : serializa(args && (args.input || args.patch));
      const m = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/.exec(txt);
      out.push({ tipo: 'arquivo', titulo: 'Alterou um arquivo', caminho: m ? m[1].trim() : '', operacao: 'alterar', ferramenta: nome, resultado });
    } else if (NOMES_SHELL.has(nome) || nome === 'exec') {
      const cmd = args && typeof args === 'object' ? (comandoDeLista(args.command) || (typeof args.cmd === 'string' ? args.cmd : '')) : (typeof args === 'string' ? args : '');
      out.push({ tipo: 'comando', titulo: 'Comando', comando: cmd, resultado });
    } else {
      out.push({ tipo: 'ferramenta', titulo: nome, ferramenta: nome, entrada: args, resultado });
    }
  }
  return out;
}

// ── evento final ───────────────────────────────────────────────────────────
function montaEvento(item, arq, bases) {
  const { r, key, ts, suspeito } = item;
  const detalhes = {};
  let truncado = false;
  const busca = [];
  const titulo = corta(limpa(r.titulo), 200).texto;
  busca.push(titulo);
  let texto = '';
  if (r.texto) {
    const p = preparaTexto(r.texto, TETO_TEXTO);
    texto = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  if (r.comando != null && r.comando !== '') {
    const p = preparaTexto(r.comando, TETO_COMANDO);
    detalhes.comando = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  if (typeof r.descricao === 'string' && r.descricao) { detalhes.descricao = corta(limpa(r.descricao), 300).texto; busca.push(detalhes.descricao); }
  if (r.caminho) { detalhes.caminho = limpa(caminhoRelativo(r.caminho, bases)); busca.push(detalhes.caminho); }
  if (r.operacao) detalhes.operacao = r.operacao;
  if (r.ferramenta) detalhes.ferramenta = corta(limpa(r.ferramenta), 120).texto;
  if (r.entrada !== undefined && r.entrada !== null && r.entrada !== '') {
    const p = preparaTexto(r.entrada, TETO_COMANDO);
    detalhes.entrada = p.texto; truncado = truncado || p.truncado; busca.push(p.cheio);
  }
  const ev = {
    id: `${key.f}:${key.o}${key.i ? '.' + key.i : ''}`,
    horario: new Date(ts).toISOString(),
    t: ts,
    sessao: arq.sessao,
    motor: arq.motor,
    subagente: arq.subagente,
    projeto: arq.projeto ? limpa(arq.projeto) : null,
    tipo: r.tipo,
  };
  if (r.papel) ev.papel = r.papel;
  ev.titulo = titulo;
  ev.texto = texto;
  ev.detalhes = detalhes;
  if (r.resultado !== undefined && (r.tipo === 'comando' || r.tipo === 'arquivo' || r.tipo === 'ferramenta')) {
    ev.resultado = r.resultado;
    if (r.resultado) { busca.push(r.resultado.texto); truncado = truncado || r.resultado.truncado; }
  }
  if (truncado) ev.truncado = true;
  if (suspeito) ev.horario_suspeito = true;
  return { ev, busca: normaliza(busca.join('\n')) };
}

// ── leitor de um arquivo, de trás para frente ──────────────────────────────
class LeitorArquivo {
  constructor(arq, ctx, hint) {
    this.arq = arq;
    this.ctx = ctx;
    this.hint = hint || null;
    this.fh = null;
    this.size = 0;
    this.estado = 'novo';     // novo | aberto | suspenso | fim
    this.formato = arq.motor === 'claude' ? 'claude' : null;
    this.resultados = new Map();
    this.fila = [];
    this.cabeca = null;
    this.teto = arq.mtimeMs + FOLGA_MTIME;
    this.pend = Buffer.alloc(0);
    this.pos = 0;
    this.pulando = false;
    this.contaGigante = false;
    this.pausado = false;
    this.soResultadoAcima = Infinity;
    this.ultimaLida = null;
    this.retomada = null;
  }

  guardaResultado(id, res) {
    if (this.resultados.has(id)) this.resultados.delete(id);
    this.resultados.set(id, res);
    if (this.resultados.size > MAX_RESULTADOS) this.resultados.delete(this.resultados.keys().next().value);
  }

  aviso(tipo, motivo) { this.ctx.avisa({ tipo, motivo, arquivo: this.arq.rotulo }); }

  async _le(buf, n, pos) {
    const { bytesRead } = await this.fh.read(buf, 0, n, pos);
    this.ctx.lidos += bytesRead;
    return bytesRead;
  }

  async _abre() {
    const a = await abrirSeguro(this.arq);
    this.fh = a.fh;
    this.size = a.size;
    this.ctx.fdsAbertos++;
  }

  /** Primeira abertura: aplica o hint (se for válido) ou começa pelo fim do arquivo. */
  async iniciar() {
    try {
      if (this.hint && this.hint.o === -1) { this.estado = 'fim'; return; }
      await this._abre();
      this.estado = 'aberto';
      if (this.formato === null) await this._detectaFormato();
      if (this.estado === 'fim') return;
      let topo = this.size;
      const h = this.hint;
      if (h && h.o >= 0 && h.o <= this.size) {
        let valido = h.o === 0;
        if (!valido) {
          const b = Buffer.alloc(1);
          valido = (await this._le(b, 1, h.o - 1)) === 1 && b[0] === 10;
        }
        if (valido) {
          topo = Math.min(this.size, h.o + JANELA_HINT);
          this.soResultadoAcima = h.o;
          this.teto = Math.min(this.teto, h.teto);
        }
      }
      await this._completaTopo(topo);
    } catch (e) { this._falhou(e); }
  }

  async _detectaFormato() {
    const n = Math.min(DETECCAO, this.size);
    const b = Buffer.alloc(n);
    const lidos = n ? await this._le(b, n, 0) : 0;
    const t = b.subarray(0, lidos).toString('latin1');
    if (t.includes('"item_completed"')) this.formato = 'itens';
    else if (t.includes('"response_item"')) this.formato = 'resposta';
    else {
      this.aviso('formato_desconhecido', `formato não reconhecido: não achei registros de conversa (item_completed ou response_item) nos primeiros ${Math.round(DETECCAO / 1024)} KB`);
      this._encerra();
    }
  }

  /** Move o topo da leitura para uma fronteira de linha (depois de um \n). Resto parcial no fim do arquivo é descartado. */
  async _completaTopo(topo) {
    this.pos = topo;
    this.pend = Buffer.alloc(0);
    if (topo === 0) return;
    const b = Buffer.alloc(1);
    await this._le(b, 1, topo - 1);
    if (b[0] === 10) return;
    if (topo >= this.size) { this.pulando = true; return; }   // última linha sem \n: está sendo escrita
    // topo no meio de uma linha: anda para frente até o próximo \n
    let p = topo;
    const bloco = Buffer.allocUnsafe(BLOCO);
    const limite = topo + MAX_LINHA;
    while (p < this.size && p < limite) {
      const n = Math.min(BLOCO, this.size - p);
      const lidos = await this._le(bloco, n, p);
      if (lidos <= 0) break;
      const i = bloco.subarray(0, lidos).indexOf(10);
      if (i >= 0) { this.pos = p + i + 1; return; }
      p += lidos;
    }
    if (p >= this.size) { this.pos = this.size; this.pulando = true; return; }
    this.pos = topo; this.pulando = true;
  }

  /** Próxima linha de trás para frente: { off, fim, buf } ou null (acabou, ou o orçamento estourou: ver this.pausado). */
  async _proxLinha() {
    for (;;) {
      if (!this.pulando) {
        const fimLinha = this.pend.length - 1;
        if (fimLinha >= 0) {
          const j = fimLinha === 0 ? -1 : this.pend.lastIndexOf(10, fimLinha - 1);
          if (j >= 0) {
            const l = { off: this.pos + j + 1, fim: this.pos + fimLinha + 1, buf: this.pend.subarray(j + 1, fimLinha) };
            this.pend = this.pend.subarray(0, j + 1);
            return l;
          }
          if (this.pos === 0) {
            const l = { off: 0, fim: fimLinha + 1, buf: this.pend.subarray(0, fimLinha) };
            this.pend = Buffer.alloc(0);
            return l;
          }
          if (this.pend.length > MAX_LINHA + 1) {
            this.pulando = true;
            this.contaGigante = true;
            this.pend = Buffer.alloc(0);
            continue;
          }
        }
      }
      if (this.pos === 0) {
        if (this.pulando && this.contaGigante) this.ctx.contagens.linhas_gigantes++;
        this.pulando = false; this.contaGigante = false; this.pend = Buffer.alloc(0);
        return null;
      }
      if (this.ctx.excedeu()) { this.pausado = true; return null; }
      const n = Math.min(BLOCO, this.pos);
      const ini = this.pos - n;
      const b = Buffer.allocUnsafe(n);
      const lidos = await this._le(b, n, ini);
      if (lidos < n) throw new ErroArquivo('arquivo_ilegivel', 'o arquivo encolheu durante a leitura (alguém o reescreveu)');
      this.pos = ini;
      if (this.pulando) {
        const idx = b.lastIndexOf(10);
        if (idx >= 0) {
          this.pend = b.subarray(0, idx + 1);
          this.pulando = false;
          if (this.contaGigante) { this.ctx.contagens.linhas_gigantes++; this.contaGigante = false; }
        }
        continue;
      }
      this.pend = this.pend.length ? Buffer.concat([b, this.pend]) : b;
    }
  }

  /** Preenche this.cabeca com o próximo evento (ou null se acabou ou pausou). */
  async avancar() {
    this.cabeca = null;
    if (this.estado === 'novo') await this.iniciar();
    try {
      for (;;) {
        if (this.fila.length) { this.cabeca = this.fila.shift(); return; }
        if (this.estado === 'suspenso') await this._retoma();
        if (this.estado !== 'aberto') return;
        const l = await this._proxLinha();
        if (!l) { if (!this.pausado) this._encerra(); return; }
        this.ultimaLida = { off: l.off, fim: l.fim, tetoAntes: this.teto };
        await this.ctx.cede();
        await this._processa(l);
        if (this.pausado) return;
      }
    } catch (e) { this._falhou(e); }
  }

  async _processa(l) {
    const soRes = l.off > this.soResultadoAcima;
    if (!l.buf.length) return;
    let j;
    try { j = JSON.parse(l.buf.toString('utf8')); } catch (_) { if (!soRes) this.ctx.contagens.linhas_ilegiveis++; return; }
    if (!j || typeof j !== 'object') { if (!soRes) this.ctx.contagens.linhas_ilegiveis++; return; }
    const rasc = this.arq.motor === 'claude' ? await extraiClaude(j, this, soRes) : extraiCodex(j, this, soRes);
    if (rasc === null) { this.pausado = true; return; }
    if (soRes || !rasc.length) return;
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
    if (!Number.isFinite(ts)) { this.ctx.contagens.sem_horario += rasc.length; return; }
    const tOrdem = Math.min(ts, this.teto);
    this.teto = tOrdem;
    if (tOrdem < this.ctx.desde) { this._encerra(); return; }
    if (ts > this.ctx.ate) return;
    const suspeito = ts > this.arq.mtimeMs + FOLGA_MTIME;
    const novos = [];
    rasc.forEach((r, i) => {
      const key = { t: tOrdem, f: this.arq.id, o: l.off, i };
      if (this.ctx.cursorChave && cmp(key, this.ctx.cursorChave) >= 0) return;
      if (this.ctx.tipos && !this.ctx.tipos.has(r.tipo)) return;
      novos.push({ key, r, ts, suspeito, arq: this.arq });
    });
    novos.reverse();
    this.fila.push(...novos);
  }

  /** Hint para o próximo pedido: a última linha lida (relida e filtrada pela chave) e o teto de antes dela. */
  hintAtual() {
    if (this.estado === 'fim' && !this.fila.length && !this.cabeca) return [-1, 0];
    if (this.ultimaLida) return [this.ultimaLida.off, this.ultimaLida.tetoAntes];
    if (this.hint && this.hint.o >= -1) return [this.hint.o, this.hint.teto];
    return null;
  }

  async suspender() {
    if (this.estado !== 'aberto') return;
    this.retomada = { topo: this.ultimaLida ? this.ultimaLida.off : this.pos, teto: this.teto, soRes: this.soResultadoAcima };
    await this.fechaFd();
    this.estado = 'suspenso';
  }

  async _retoma() {
    try {
      await this._abre();
      this.estado = 'aberto';
      const r = this.retomada;
      this.pos = r.topo; this.pend = Buffer.alloc(0); this.pulando = false; this.contaGigante = false;
      this.teto = r.teto; this.soResultadoAcima = r.soRes;
    } catch (e) { this._falhou(e); }
  }

  async fechaFd() {
    if (!this.fh) return;
    const fh = this.fh;
    this.fh = null;
    this.ctx.fdsAbertos--;
    await fh.close().catch(() => {});
  }

  _encerra() { this.estado = 'fim'; this.fila = []; this.fechaFd(); }

  _falhou(e) {
    if (e instanceof ErroArquivo) this.aviso(e.tipo, e.motivo);
    else this.aviso('arquivo_ilegivel', `falha ao ler o arquivo (${e && (e.code || e.message)})`);
    this._encerra();
  }
}

// ── pedido ─────────────────────────────────────────────────────────────────
function novoCtx(opc) {
  const ctx = {
    lidos: 0,
    inicio: opc.relogio(),
    maxBytes: opc.maxBytes,
    maxMs: opc.maxMs,
    relogio: opc.relogio,
    fdsAbertos: 0,
    contagens: { linhas_ilegiveis: 0, linhas_gigantes: 0, sem_horario: 0, atalhos_ignorados: 0 },
    avisos: [],
    omitidos: 0,
    maxAvisos: opc.maxAvisos || MAX_AVISOS,
    vistos: new Set(),
    cede: criaCede(opc.relogio),
    desde: -Infinity,
    ate: Infinity,
    tipos: null,
    cursorChave: null,
    excedeu() { return ctx.lidos >= ctx.maxBytes || ctx.relogio() - ctx.inicio >= ctx.maxMs; },
    avisa(a) {
      const k = `${a.tipo}|${a.arquivo || ''}|${a.motivo}`;
      if (ctx.vistos.has(k)) return;
      ctx.vistos.add(k);
      if (ctx.avisos.length < ctx.maxAvisos || a.tipo === 'limite') ctx.avisos.push({ tipo: a.tipo, motivo: limpa(a.motivo), ...(a.arquivo ? { arquivo: limpa(a.arquivo) } : {}) });
      else ctx.omitidos++;
    },
    /** Lista final de avisos: os guardados e, se passou do teto, uma linha dizendo quantos ficaram de fora. */
    avisosFinais() {
      if (!ctx.omitidos) return ctx.avisos;
      return ctx.avisos.concat([{ tipo: 'avisos_omitidos', motivo: `mais ${ctx.omitidos} aviso(s) parecidos foram omitidos para a resposta não crescer sem limite` }]);
    },
  };
  return ctx;
}

function criarLeitor({ log, agora, orcamento } = {}) {
  const relogio = typeof agora === 'function' ? agora : () => Date.now();
  const o = orcamento || {};
  const lim = {
    maxArquivos: o.maxArquivos || MAX_ARQUIVOS, maxProfundidade: o.maxProfundidade || MAX_PROFUNDIDADE,
    maxEntradas: o.maxEntradas || MAX_ENTRADAS, maxPastas: o.maxPastas || MAX_PASTAS, maxAvisos: o.maxAvisos || MAX_AVISOS,
    ms: o.descobertaMs || PRAZO_DESCOBERTA_MS, relogio, cede: criaCede(relogio),
  };
  const aviso = log || (() => {});

  async function descobre(ag, ctx) {
    const fontes = [];
    for (const f of fontesDoAgente(ag)) {
      const d = await descobreFonte(f, lim);
      for (const a of d.avisos) ctx.avisa(a);
      ctx.contagens.atalhos_ignorados += d.atalhos_ignorados;
      ctx.omitidos += d.avisosOmitidos;
      fontes.push(d);
    }
    // Nada para ler em nenhuma fonte: os motivos vão também nos avisos (a tela nunca diz "sem ações" nesse caso).
    if (!fontes.some((d) => (d.estado === 'ok' || d.estado === 'parcial') && d.arquivos.length)) {
      for (const d of fontes) ctx.avisa({ tipo: `fonte_${d.estado}`, motivo: d.motivo, arquivo: d.motor });
    }
    return fontes;
  }

  const ctxSimples = () => novoCtx({ relogio, maxBytes: Infinity, maxMs: Infinity, maxAvisos: lim.maxAvisos });

  async function resumoDasFontes(ag) {
    const ctx = ctxSimples();
    const fontes = await descobre(ag, ctx);
    return { fontes: fontes.map(resumoDaFonte), avisos: ctx.avisosFinais(), contagens: ctx.contagens };
  }

  async function sessoes(ag, { limite, cursor }) {
    const ctx = ctxSimples();
    const fontes = await descobre(ag, ctx);
    const todas = fontes.flatMap((f) => f.arquivos).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    let ini = 0;
    if (cursor) {
      if (!cursor.chave) throw new ErroEntrada(400, 'O cursor das sessões não tem posição. Peça a primeira página de novo, sem o parâmetro "cursor".');
      ini = todas.findIndex((a) => a.mtimeMs < cursor.chave.t || (a.mtimeMs === cursor.chave.t && a.id > cursor.chave.f));
      if (ini < 0) ini = todas.length;
    }
    const pagina = todas.slice(ini, ini + limite);
    const mais = ini + limite < todas.length;
    const ultimo = pagina[pagina.length - 1];
    return {
      sessoes: pagina.map((a) => ({ id: a.id, sessao: a.sessao, motor: a.motor, projeto: a.projeto ? limpa(a.projeto) : null, subagente: a.subagente, bytes: a.bytes, atualizado: new Date(a.mtimeMs).toISOString() })),
      proximo: mais && ultimo ? codificaCursor({ t: ultimo.mtimeMs, f: ultimo.id, o: 0, i: 0 }) : null,
      fontes: fontes.map(resumoDaFonte),
      avisos: ctx.avisosFinais(),
      contagens: ctx.contagens,
    };
  }

  /** filtros: { desde, ate (ms|null), tipos (Set|null), q (texto|null), sessao (string|null), limite, cursor } */
  async function eventos(ag, f) {
    const ctx = novoCtx({ relogio, maxBytes: o.maxBytes || ORCAMENTO_BYTES, maxMs: o.maxMs || ORCAMENTO_MS, maxAvisos: lim.maxAvisos });
    if (f.desde != null) ctx.desde = f.desde;
    if (f.ate != null) ctx.ate = f.ate;
    ctx.tipos = f.tipos || null;
    ctx.cursorChave = f.cursor && f.cursor.chave ? f.cursor.chave : null;
    const hints = f.cursor ? f.cursor.h : {};
    const q = f.q ? normaliza(f.q) : null;
    const bases = [ag.home_host, ag.home_container, ag.codex_home_host];

    const fontes = await descobre(ag, ctx);
    let arqs = fontes.flatMap((x) => x.arquivos);
    if (f.sessao) {
      const alvo = String(f.sessao).toLowerCase();
      arqs = arqs.filter((a) => a.id === alvo || a.sessao === alvo);
      if (!arqs.length) throw new ErroEntrada(404, `Não achei a sessão "${String(f.sessao).slice(0, 40)}" neste agente. Veja as sessões em /api/v1/logs/agentes/${ag.slug}/sessoes.`);
    }
    arqs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
    if (ctx.desde > -Infinity) arqs = arqs.filter((a) => a.mtimeMs + FOLGA_MTIME >= ctx.desde);

    const pendentes = arqs.slice();
    const todos = [];        // leitores já criados
    const abertos = [];      // leitores com cabeça
    const emitidos = [];
    let ultimaChave = null;
    let parcial = false;
    let mais = false;
    let acabou = false;

    const topoAtual = () => {
      let m = null;
      for (const r of abertos) if (r.cabeca && (!m || cmp(r.cabeca.key, m) > 0)) m = r.cabeca.key;
      return m;
    };

    async function limitaFds() {
      while (ctx.fdsAbertos > MAX_FDS) {
        let alvo = null;
        for (const r of abertos) if (r.estado === 'aberto' && r.cabeca && (!alvo || cmp(r.cabeca.key, alvo.cabeca.key) < 0)) alvo = r;
        if (!alvo) return;
        await alvo.suspender();
      }
    }

    async function abrePendentes() {
      while (pendentes.length && !ctx.excedeu()) {
        const topo = topoAtual();
        const prox = pendentes[0];
        if (topo && prox.mtimeMs + FOLGA_MTIME < topo.t) return;
        pendentes.shift();
        const l = new LeitorArquivo(prox, ctx, hints[prox.id]);
        todos.push(l);
        await l.avancar();
        if (l.cabeca) abertos.push(l);
        await limitaFds();
      }
    }

    let voltas = 0;
    for (;;) {
      if (ctx.excedeu()) { parcial = true; break; }
      // Página cheia: para sem olhar adiante (olhar adiante leria o arquivo todo quando o resto não tem ação).
      if (emitidos.length >= f.limite) { mais = abertos.length > 0 || pendentes.length > 0; break; }
      // Quem teve a cabeça consumida só avança agora, quando a leitura é de fato necessária.
      for (const r of abertos.slice()) {
        if (!r.cabeca) {
          await r.avancar();
          if (!r.cabeca && !r.pausado) abertos.splice(abertos.indexOf(r), 1);
        }
        if (ctx.excedeu()) break;
      }
      await limitaFds();
      if (ctx.excedeu()) { parcial = true; break; }
      await abrePendentes();
      if (ctx.excedeu()) { parcial = true; break; }
      const prontos = abertos.filter((r) => r.cabeca);
      if (!prontos.length) {
        if (abertos.length || pendentes.length) continue;
        acabou = true;
        break;
      }
      let melhor = prontos[0];
      for (const r of prontos) if (cmp(r.cabeca.key, melhor.cabeca.key) > 0) melhor = r;
      const item = melhor.cabeca;
      const { ev, busca } = montaEvento(item, item.arq, bases);
      ultimaChave = item.key;
      melhor.cabeca = null;
      if (!q || busca.includes(q)) emitidos.push(ev);
      if (++voltas % 200 === 0) await new Promise((r) => setImmediate(r));
    }

    // hints dos arquivos abertos (os que ainda têm o que ler primeiro)
    const h = {};
    const comHint = todos.filter((l) => l.hintAtual()).sort((a, b) => (a.hintAtual()[0] === -1) - (b.hintAtual()[0] === -1));
    for (const l of comHint.slice(0, MAX_HINTS)) h[l.arq.id] = l.hintAtual();
    for (const l of todos) await l.fechaFd();

    const temMais = mais || parcial;
    let proximo = null;
    if (temMais) {
      const c = ultimaChave || ctx.cursorChave;
      proximo = codificaCursor(Object.assign(c ? { t: c.t, f: c.f, o: c.o, i: c.i } : {}, { h }));
      if (proximo.length > TETO_CURSOR) proximo = codificaCursor(c ? { t: c.t, f: c.f, o: c.o, i: c.i } : {});
    }
    if (!acabou && !temMais) aviso('aviso', 'Logs: a busca terminou sem motivo conhecido.');
    return {
      eventos: emitidos,
      proximo,
      parcial: parcial && !mais,
      lidos_bytes: ctx.lidos,
      fontes: fontes.map(resumoDaFonte),
      avisos: ctx.avisosFinais(),
      contagens: ctx.contagens,
    };
  }

  /** Fontes de um agente que não deu tempo de verificar: o estado diz isso, nunca "ausente" nem lista vazia. */
  function fontesNaoVerificadas(ag, motivo) {
    return fontesDoAgente(ag).map((f) => ({ motor: f.motor, estado: 'nao_verificada', motivo, arquivos: null, bytes: null, ultima_atividade: null }));
  }

  return { resumoDasFontes, sessoes, eventos, fontesNaoVerificadas };
}

module.exports = {
  criarLeitor, limpa, corta, normaliza, caminhoRelativo, codificaCursor, decodificaCursor, cmp, fontesDoAgente, descobreFonte,
  abrirSeguro, ErroEntrada, ErroArquivo, TIPOS, RX_ID_CURTO, RX_UUID, MAX_LINHA,
};
