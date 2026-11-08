#!/usr/bin/env node
// checar.mjs: compara o inventario tirado do codigo (scripts/docs-inventario.mjs) com o manual
// (docs/manual/*.md) e acusa documentacao defasada. Node 22, sem dependencias, sem rede.
//
// Uso: node tests/docs-em-dia/checar.mjs [--json]
//   Saida 0 = manual em dia. Saida 1 = defasado (ha achados). Saida 2 = o proprio verificador
//   quebrou (extrator falhou, inventario vazio, manual ou excecoes.tsv ausente): nunca e "em dia".
//   Sem --json, escreve texto em portugues. Com --json, uma linha JSON por achado:
//   {"tipo","item","origem","falta_em","como_resolver"}.
// Env: DOCS_MANUAL_DIR         pasta do manual (padrao: docs/manual do repositorio)
//      DOCS_INVENTARIO_ARQUIVO usa este JSON em vez de rodar o extrator (so para a bancada)
//      DOCS_RAIZ               raiz do repositorio passada ao extrator (--raiz; so para a bancada)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_OUT = process.argv.includes('--json');
const MANUAL = path.resolve(process.env.DOCS_MANUAL_DIR || path.join(REPO, 'docs', 'manual'));
const relManual = (f) => (MANUAL.startsWith(`${REPO}${path.sep}`) ? path.relative(REPO, f) : f);

function semComentarios(linha) {
  let resto = linha;
  for (;;) {
    const ini = resto.indexOf('<!--');
    const fim = ini < 0 ? -1 : resto.indexOf('-->', ini + 4);
    if (fim < 0) return resto;
    resto = resto.slice(0, ini) + resto.slice(fim + 3);
  }
}

function quebrou(o_que, o_que_fazer) {
  process.stderr.write(`docs-em-dia: o verificador quebrou: ${o_que}\n  O que fazer: ${o_que_fazer}\n`);
  process.exit(2);
}

// ------------------------------------------------------------------ inventario
let inv;
if (process.env.DOCS_INVENTARIO_ARQUIVO) {
  try { inv = JSON.parse(fs.readFileSync(process.env.DOCS_INVENTARIO_ARQUIVO, 'utf8')); }
  catch (e) { quebrou(`nao consegui ler o inventario ${process.env.DOCS_INVENTARIO_ARQUIVO} (${e.message}).`, 'confira o caminho e o JSON.'); }
} else {
  const args = [path.join(REPO, 'scripts', 'docs-inventario.mjs')];
  if (process.env.DOCS_RAIZ) args.push('--raiz', process.env.DOCS_RAIZ);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    quebrou(`o extrator scripts/docs-inventario.mjs falhou (codigo ${r.status ?? 'sem codigo'}): ${(r.stderr || r.error?.message || '').trim()}`, 'rode `node scripts/docs-inventario.mjs` e conserte o que ele disser.');
  }
  try { inv = JSON.parse(r.stdout); } catch (e) { quebrou(`o extrator nao devolveu JSON valido (${e.message}).`, 'rode `node scripts/docs-inventario.mjs` e confira a saida.'); }
}
const LISTAS = { telas: 'tela', rotas: 'rota', comandos: 'comando', skills: 'skill', powers: 'power', canais: 'canal', provedores: 'provedor' };
for (const k of Object.keys(LISTAS)) {
  if (!Array.isArray(inv[k]) || inv[k].length === 0) quebrou(`a lista "${k}" do inventario esta vazia ou ausente.`, 'o extrator nao entendeu o codigo; ajuste scripts/docs-inventario.mjs. Lista vazia nunca conta como "em dia".');
}

// ------------------------------------------------------------------ manual
if (!fs.existsSync(MANUAL) || !fs.statSync(MANUAL).isDirectory()) quebrou(`a pasta do manual ${MANUAL} nao existe.`, 'crie docs/manual/ ou aponte DOCS_MANUAL_DIR para a pasta certa.');
function mdsDe(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdsDe(f)); else if (e.name.endsWith('.md')) out.push(f);
  }
  return out;
}
const arquivosMd = mdsDe(MANUAL);
const textos = new Map(arquivosMd.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const corpus = [...textos.values()].join('\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ')).join('\n');

const excFile = path.join(MANUAL, 'excecoes.tsv');
if (!fs.existsSync(excFile)) quebrou(`falta ${relManual(excFile)}.`, 'crie o arquivo com o cabecalho comentado (tipo<TAB>id<TAB>justificativa).');

const achados = [];
const achar = (tipo, item, origem, falta_em, como_resolver) => achados.push({ tipo, item, origem, falta_em, como_resolver });

// ------------------------------------------------------------------ excecoes
const excecoes = new Map(); // "tipo\tid" -> linha
const idsDoCodigo = new Set();
for (const [lista, tipo] of Object.entries(LISTAS)) for (const it of inv[lista]) idsDoCodigo.add(`${tipo}\t${it.id}`);
fs.readFileSync(excFile, 'utf8').split('\n').forEach((linha, i) => {
  if (!linha.trim() || linha.trim().startsWith('#')) return;
  const origem = `${relManual(excFile)}:${i + 1}`;
  const campos = linha.split('\t');
  const [tipo, id, ...resto] = campos.map((c) => c.trim());
  const just = resto.join(' ').trim();
  if (campos.length < 3 || !tipo || !id) { achar('excecao', linha.trim().slice(0, 80), origem, relManual(excFile), 'A linha precisa ter tres campos separados por TAB: tipo, id e justificativa. Corrija a linha ou apague-a.'); return; }
  if (!Object.values(LISTAS).includes(tipo)) { achar('excecao', `${tipo} ${id}`, origem, relManual(excFile), `O tipo "${tipo}" nao existe. Use um de: ${Object.values(LISTAS).join(', ')}.`); return; }
  if (!just) { achar('excecao', `${tipo} ${id}`, origem, relManual(excFile), 'Excecao sem justificativa nao vale. Escreva no terceiro campo por que este item fica fora do manual, ou apague a linha e documente o item.'); return; }
  if (!idsDoCodigo.has(`${tipo}\t${id}`)) { achar('excecao', `${tipo} ${id}`, origem, relManual(excFile), 'Excecao obsoleta: este item ja nao existe no codigo. Apague a linha.'); return; }
  excecoes.set(`${tipo}\t${id}`, i + 1);
});

// ------------------------------------------------------------------ citacoes
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normParam = (s) => s.replace(/<[A-Za-z_-]+>|\{[A-Za-z_-]+\}|:[A-Za-z_]+/g, ':p');
const corpusNorm = normParam(corpus);

function citado(tipo, item) {
  const id = item.id;
  if (tipo === 'tela') {
    if (id.startsWith('aba:')) return new RegExp(`(?<![\\w-])${esc(id)}(?![\\w-])`).test(corpus);
    return new RegExp(`(?<![\\w])${esc(normParam(id))}(?![\\w-])(?!/\\w)`).test(corpusNorm);
  }
  if (tipo === 'rota') {
    const caminho = id.includes(' ') ? id.slice(id.indexOf(' ') + 1) : id;
    const familia = /^\/api\/v1\/[^/]+$/.test(caminho);
    const base = normParam(caminho.replace(/\/\*$/, ''));
    return new RegExp(`(?<![\\w])${esc(base)}(?![\\w-])${familia ? '' : '(?!/\\w)'}`).test(corpusNorm);
  }
  if (tipo === 'comando') return new RegExp(`(?<![\\w-])${esc(id)}(?![\\w-])`).test(corpus);
  return corpus.includes(`\`${id}\``);
}

const ONDE = { rota: 'docs/manual/referencia-admin.md', comando: 'docs/manual/referencia-admin.md' };
const FORMA = {
  tela: 'pelo caminho (ex.: /mesa) ou, para abas do painel, por aba:<nome>',
  rota: 'pelo caminho (a familia /api/v1/<nome> basta para o web; no painel, o caminho exato)',
  comando: 'com o comando inteiro (ex.: dgclaw agente criar)',
  skill: 'pelo nome entre crases', power: 'pelo nome entre crases', canal: 'pelo nome entre crases', provedor: 'pelo nome entre crases',
};
for (const [lista, tipo] of Object.entries(LISTAS)) {
  for (const it of inv[lista]) {
    if (excecoes.has(`${tipo}\t${it.id}`) || citado(tipo, it)) continue;
    achar(tipo, it.id, it.origem, ONDE[tipo] || 'docs/manual/*.md',
      `Documente em ${ONDE[tipo] || 'algum docs/manual/*.md'} citando o item ${FORMA[tipo]}, ou justifique em ${relManual(excFile)} (tipo<TAB>id<TAB>justificativa).`);
  }
}

// ------------------------------------------------------------------ varredura de linhas (links, estilo, referencia)
// Devolve [{n, texto, codigo}] marcando o que esta dentro de bloco de codigo.
function linhasDe(texto) {
  let dentro = false;
  return texto.split('\n').map((l, i) => {
    const cerca = /^\s*(```|~~~)/.test(l);
    if (cerca) { dentro = !dentro; return { n: i + 1, texto: l, codigo: true }; }
    return { n: i + 1, texto: l, codigo: dentro };
  });
}
const semCodigoInline = (s) => s.replace(/`[^`]*`/g, '``');
const slugDeTitulo = (t) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
function ancoras(texto) {
  const set = new Set(); const vistos = new Map();
  for (const l of linhasDe(texto)) {
    if (l.codigo) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l.texto);
    if (h) {
      const s = slugDeTitulo(h[1]); const k = vistos.get(s) || 0; vistos.set(s, k + 1);
      set.add(k ? `${s}-${k}` : s);
    }
    for (const m of l.texto.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1]);
  }
  return set;
}

for (const [arq, texto] of textos) {
  const rel = relManual(arq);
  const lin = linhasDe(texto);
  let emComentario = false;
  for (const l of lin) {
    if (l.codigo) continue;
    const t = semCodigoInline(l.texto);
    // --- c) links relativos
    for (const m of t.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const alvo = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(alvo) || alvo.startsWith('//')) continue;
      const [caminhoBruto, ancora] = alvo.split('#');
      let destino = arq;
      if (caminhoBruto) {
        let dec = caminhoBruto; try { dec = decodeURIComponent(caminhoBruto); } catch { /* fica como veio */ }
        destino = path.resolve(path.dirname(arq), dec);
        if (!fs.existsSync(destino)) { achar('link', alvo, `${rel}:${l.n}`, rel, `O arquivo "${caminhoBruto}" nao existe a partir de ${path.dirname(rel)}. Corrija o link ou crie o arquivo.`); continue; }
      }
      if (ancora && destino.endsWith('.md') && fs.existsSync(destino) && fs.statSync(destino).isFile()) {
        const alvoTexto = textos.get(destino) ?? fs.readFileSync(destino, 'utf8');
        if (!ancoras(alvoTexto).has(ancora.toLowerCase()) && !ancoras(alvoTexto).has(ancora)) {
          achar('link', alvo, `${rel}:${l.n}`, rel, `O arquivo existe, mas nao tem um titulo cuja ancora seja "#${ancora}". Corrija a ancora ou o titulo.`);
        }
      }
    }
    // --- e) travessao em texto corrido
    // Comparacao por texto: isto so limpa o markdown para o teste, nao filtra HTML de ninguem.
    if (t.includes('<!--') && !t.includes('-->')) emComentario = true;
    if (emComentario) { if (t.includes('-->')) emComentario = false; continue; }
    const ehTitulo = /^\s*#{1,6}\s/.test(t);
    const ehTabela = /^\s*\|/.test(t);
    if (ehTitulo || ehTabela) continue;
    let corpoLinha = semComentarios(t);
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(corpoLinha);
    if (item) {
      // item com rotulo na frente ("**Rotulo** - texto"): o primeiro traco e separador estrutural
      const rot = /^(\*\*[^*]+\*\*|[^.,;:!?]{1,40}?)\s+[—–]\s+(.*)$/.exec(item[2]);
      corpoLinha = rot ? rot[2] : item[2];
    }
    if (/\s[—–]\s/.test(corpoLinha) || /[—–]\s*$/.test(corpoLinha.trimEnd())) {
      achar('estilo', l.texto.trim().slice(0, 100), `${rel}:${l.n}`, rel, 'Tire o travessao ou a meia-risca do meio da frase: troque por virgula, ponto, dois-pontos ou parenteses (ou reescreva a frase).');
    }
  }
}

// ------------------------------------------------------------------ d) referencia-admin.md: o documentado que sumiu do codigo
{
  const ref = arquivosMd.find((f) => path.basename(f) === 'referencia-admin.md');
  if (ref) {
    const rel = relManual(ref);
    const lin = linhasDe(textos.get(ref));
    const dentro = []; let aberto = null;
    for (const l of lin) {
      if (l.texto.includes('<!-- inventario:inicio -->')) { if (aberto) achar('estilo', 'inventario:inicio', `${rel}:${l.n}`, rel, `Marcador <!-- inventario:inicio --> aberto de novo sem fechar o da linha ${aberto}.`); aberto = l.n; continue; }
      if (l.texto.includes('<!-- inventario:fim -->')) { if (!aberto) achar('estilo', 'inventario:fim', `${rel}:${l.n}`, rel, 'Marcador <!-- inventario:fim --> sem <!-- inventario:inicio --> antes.'); aberto = null; continue; }
      if (aberto) dentro.push(l);
    }
    if (aberto) achar('estilo', 'inventario:inicio', `${rel}:${aberto}`, rel, 'Marcador <!-- inventario:inicio --> sem o <!-- inventario:fim --> correspondente.');

    const caminhos = new Set(); const familias = new Set(); const prefixosLivres = ['/p/'];
    for (const r of [...inv.rotas, ...(inv.rotas_detalhe || [])]) {
      const c = normParam((r.id.includes(' ') ? r.id.slice(r.id.indexOf(' ') + 1) : r.id).replace(/\/\*$/, ''));
      caminhos.add(c);
      const f = /^\/api\/v1\/[^/]+/.exec(c); if (f) familias.add(f[0]);
    }
    for (const t of inv.telas) caminhos.add(normParam(t.id));
    const cmds = inv.comandos.map((c) => c.id);
    const RAIZES_CMD = new Set(cmds.map((c) => c.split(' ').slice(0, 1).join(' ')));
    for (const l of dentro) {
      const origem = `${rel}:${l.n}`;
      for (const m of l.texto.matchAll(/(?<![\w/.-])(\/(?:api|tela|p|a)\/[^\s`|),;"']*|\/sair\b)/g)) {
        let c = m[1].replace(/\?.*$/, '').replace(/[.:]+$/, '').replace(/\/$/, '');
        c = normParam(c).replace(/\/\*$/, '');
        const fam = /^\/api\/v1\/[^/]+/.exec(c);
        const ok = caminhos.has(c) || (fam && familias.has(fam[0])) || prefixosLivres.some((p) => c.startsWith(p) && caminhos.has(c.split('/').slice(0, 3).join('/')));
        if (!ok) achar('rota', m[1], origem, 'codigo', 'Esta rota esta documentada no bloco de inventario, mas nao existe mais no codigo. Atualize ou remova a linha (confira o nome atual com `node scripts/docs-inventario.mjs`).');
      }
      for (const m of l.texto.matchAll(/(?<![\w-])(dgclaw(?:-agente|-card)?)((?: [a-z][a-z0-9-]*)+)/g)) {
        const palavras = m[2].trim().split(' ');
        // vale se algum prefixo e um comando exato (o resto sao argumentos), ou se a citacao e so o pai
        // de comandos que existem ("dgclaw agente"); pai seguido de palavra que nao e filho nao vale.
        let casou = false;
        for (let k = palavras.length; k >= 1 && !casou; k--) casou = cmds.includes(`${m[1]} ${palavras.slice(0, k).join(' ')}`);
        if (!casou) casou = cmds.some((c) => c.startsWith(`${m[1]} ${palavras.join(' ')} `));
        if (!casou && RAIZES_CMD.has(m[1])) achar('comando', `${m[1]} ${palavras.slice(0, 3).join(' ')}`, origem, 'codigo', 'Este comando esta documentado no bloco de inventario, mas nao existe mais no codigo. Atualize ou remova a linha (confira com `node scripts/docs-inventario.mjs`).');
      }
    }
  }
}

// ------------------------------------------------------------------ saida
if (JSON_OUT) {
  for (const a of achados) process.stdout.write(`${JSON.stringify(a)}\n`);
} else if (achados.length === 0) {
  const total = Object.keys(LISTAS).reduce((s, k) => s + inv[k].length, 0);
  process.stdout.write(`docs-em-dia: manual em dia (${total} itens do codigo conferidos contra ${arquivosMd.length} arquivo(s) em ${relManual(MANUAL)}).\n`);
} else {
  process.stdout.write(`docs-em-dia: ${achados.length} problema(s) no manual:\n`);
  for (const a of achados) {
    process.stdout.write(`\n[${a.tipo}] ${a.item}\n  origem: ${a.origem}\n  falta em: ${a.falta_em}\n  o que fazer: ${a.como_resolver}\n`);
  }
}
process.exit(achados.length ? 1 : 0);
