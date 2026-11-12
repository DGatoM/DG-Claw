#!/usr/bin/env node
// docs-inventario: tira do CODIGO do DG Claw a lista do que existe (telas, rotas, comandos, skills,
// powers, canais, provedores). E a verdade que o teste tests/docs-em-dia compara com o manual
// (docs/manual/*.md). Node 22, sem dependencias, sem rede.
//
// Uso: node scripts/docs-inventario.mjs [--raiz <pasta do repositorio>]
//   Imprime um JSON ordenado e deterministico em stdout. Cada item e {id, origem: "arquivo:linha"}.
//   Saida 0 = inventario gerado. Saida 2 = o extrator nao conseguiu ler o codigo (arquivo esperado
//   sumiu, lista ficou vazia, tela sem rota): o teste trata isso como "verificador quebrado", nunca
//   como "manual em dia".
//
// NIVEL DE EXTRACAO (decidido pelo que da para tirar do codigo sem chutar):
//  - rotas do web (web/server.js e web/lib/*.js): o web despacha por comparacao de string
//    (p === '/api/v1/x', sub === '/y' com BASE, regex), sem tabela de rotas. Metodo e subcaminho
//    ficam espalhados em ifs, entao o nivel CONFIAVEL e a FAMILIA: "/api/v1/<familia>" (e os
//    caminhos exatos fora do /api/v1, como "/api/saude" e "/sair"). Uma familia nova nunca passa
//    despercebida: toda comparacao, startsWith, regex, BASE e caixa.permitir com /api/v1/<x> entra.
//    O que e so texto de mensagem de erro ou comentario NAO entra (evita familia fantasma).
//  - rotas do panel (Express): "METODO /caminho", exato, porque ali cada rota e uma chamada
//    router.get/post/put/delete/patch(...). Arrays de caminhos viram uma rota por caminho.
//  - "rotas_detalhe" e uma lista EXTRA e informativa (o teste nao a cobra): subcaminhos do web
//    que deu para ler de comparacoes literais (ex.: /api/v1/seguranca/boletins). Serve de apoio
//    para escrever o manual e para validar citacoes de rota na referencia.
//
// Limites conhecidos (ver o relatorio do teste): rota montada por concatenacao dinamica, metodo
// HTTP do web, subcomando que o bin/dgclaw despacha sem `case` nem `<nome>_main`, e opcoes (--flags).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
let RAIZ = path.resolve(AQUI, '..');
const ia = process.argv.indexOf('--raiz');
if (ia !== -1) {
  if (!process.argv[ia + 1]) quebrou('faltou o valor de --raiz.', 'use: node scripts/docs-inventario.mjs --raiz <pasta do repositorio>');
  RAIZ = path.resolve(process.argv[ia + 1]);
}

function quebrou(o_que, o_que_fazer) {
  process.stderr.write(`docs-inventario: ${o_que}\n  O que fazer: ${o_que_fazer}\n`);
  process.exit(2);
}

function ler(rel) {
  const f = path.join(RAIZ, rel);
  try { return fs.readFileSync(f, 'utf8'); }
  catch (e) { return quebrou(`nao consegui ler ${rel} (${e.code || e.message}) em ${RAIZ}.`, 'confira se a pasta e a raiz do repositorio do DG Claw (opcao --raiz) e se o arquivo ainda existe; se ele mudou de lugar, atualize scripts/docs-inventario.mjs.'); }
}

function listar(rel, filtro) {
  const d = path.join(RAIZ, rel);
  try { return fs.readdirSync(d, { withFileTypes: true }).filter(filtro).map((e) => e.name).sort(); }
  catch (e) { return quebrou(`nao consegui listar ${rel} (${e.code || e.message}) em ${RAIZ}.`, 'confira se a pasta existe; se mudou de lugar, atualize scripts/docs-inventario.mjs.'); }
}

const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;
const ehComentario = (linha) => /^\s*(\/\/|\*|\/\*|#)/.test(linha);

// Um mapa id -> origem; mantem a PRIMEIRA origem vista (a ordem de varredura e fixa).
class Lista {
  constructor() { this.m = new Map(); }
  add(id, origem) { if (!this.m.has(id)) this.m.set(id, origem); }
  itens() {
    return [...this.m.entries()].map(([id, origem]) => ({ id, origem }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

// ---------------------------------------------------------------- web: rotas e telas
const arquivosWeb = ['web/server.js', ...listar('web/lib', (e) => e.isFile() && e.name.endsWith('.js')).map((n) => `web/lib/${n}`)];
const rotas = new Lista();
const detalhe = new Lista();
const telas = new Lista();

// Contextos em que um literal "/api/v1/<familia>" e codigo de verdade (e nao mensagem).
const FAMILIA_RXS = [
  /(?:===|!==)\s*['"`]\/api\/v1\/([a-z][a-z0-9-]*)/g,
  /(?:startsWith|permitir)\(\s*['"`]\/api\/v1\/([a-z][a-z0-9-]*)/g,
  /\bBASE\s*=\s*['"`]\/api\/v1\/([a-z][a-z0-9-]*)/g,
  /\/\^\\\/api\\\/v1\\\/([a-z][a-z0-9-]*)(?=\\\/|\(|\$|\))/g, // regex literal /^\/api\/v1\/<familia>
];
const EXATA_NAO_V1 = /(?:\bp|\bpathname)\s*===\s*'(\/[a-z][^']*)'/g;

for (const rel of arquivosWeb) {
  const texto = ler(rel);
  const linhas = texto.split('\n');
  const base = /\bBASE\s*=\s*'(\/api\/v1\/[^']+)'/.exec(texto)?.[1] || null;

  linhas.forEach((linha, i) => {
    if (ehComentario(linha)) return;
    const origem = `${rel}:${i + 1}`;
    for (const rx of FAMILIA_RXS) {
      rx.lastIndex = 0;
      for (let m; (m = rx.exec(linha));) rotas.add(`/api/v1/${m[1]}`, origem);
    }
    EXATA_NAO_V1.lastIndex = 0;
    for (let m; (m = EXATA_NAO_V1.exec(linha));) {
      const c = m[1].replace(/\/$/, '') || '/';
      if (c.startsWith('/api/v1/')) { detalhe.add(c, origem); continue; }
      if (c.startsWith('/api/')) rotas.add(c, origem);
      else if (rel === 'web/server.js') detalhe.add(`pagina:${c}`, origem); // separado depois em tela ou rota
    }
    // subcaminhos relativos a BASE: sub === '/estado'
    if (base) {
      for (let m, rx = /\bsub\s*===\s*'(\/[^']+)'/g; (m = rx.exec(linha));) detalhe.add(base + m[1], origem);
    }
    // regex de rota com parametros: /^\/api\/v1\/agents\/([^/]+)\/alertas(...)?$/
    for (let m, rx = /\/\^((?:\\\/[^/\s]+?)+?)(?=\$\/|\(\?:)/g; (m = rx.exec(linha));) {
      const c = m[1].replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':slug').replace(/\(\[0-9a-f\]\{16\}\)/g, ':id');
      if (c.startsWith('/api/v1/') && !/[()[\]]/.test(c)) detalhe.add(c, origem);
    }
    // acoes de /api/v1/agents/:slug/<acao>
    if (rel === 'web/server.js') {
      for (let m, rx = /\bacao\s*===\s*'([a-z-]+)'/g; (m = rx.exec(linha));) detalhe.add(`/api/v1/agents/:slug/${m[1]}`, origem);
    }
  });
}

// Telas do web: cada .html servido de web/public por um servirArquivo(...), amarrado ao p === '/x'
// mais proximo acima (ate 12 linhas), ou a regex /a/<slug> da conversa.
{
  const rel = 'web/server.js';
  const linhas = ler(rel).split('\n');
  const htmlMapeado = new Set();
  linhas.forEach((linha, i) => {
    const m = /servirArquivo\([^)]*publicDir,\s*'([^']+\.html)'/.exec(linha);
    if (!m) return;
    let rota = null;
    for (let j = i; j >= Math.max(0, i - 12) && !rota; j--) {
      const cands = [...linhas[j].matchAll(/\bp\s*===\s*'(\/[a-z][^']*)'/g)].map((x) => x[1].replace(/\/$/, ''));
      if (cands.length) rota = cands.sort((a, b) => a.length - b.length)[0];
      else if (/\/\^\\\/a\\\/\(\[\^\/\]\+\)/.test(linhas[j])) rota = '/a/:slug';
    }
    if (!rota) return quebrou(`a tela ${m[1]} e servida em ${rel}:${i + 1}, mas nao achei a rota (p === '/...') nas 12 linhas acima.`, 'ajuste a heuristica de telas em scripts/docs-inventario.mjs.');
    telas.add(rota, `${rel}:${i + 1}`);
    htmlMapeado.add(m[1]);
  });
  for (const h of listar('web/public', (e) => e.isFile() && e.name.endsWith('.html'))) {
    if (!htmlMapeado.has(h)) quebrou(`web/public/${h} existe mas nenhuma rota de ${rel} o serve (ou o extrator nao entendeu a rota).`, 'ajuste a heuristica de telas em scripts/docs-inventario.mjs, ou apague o html que ninguem serve.');
  }
}
// "pagina:/x" que nao e tela vira rota exata (ex.: /sair); as que sao tela somem do detalhe.
{
  const ids = new Set(telas.itens().map((t) => t.id));
  for (const { id, origem } of detalhe.itens()) {
    if (!id.startsWith('pagina:')) continue;
    detalhe.m.delete(id);
    const c = id.slice(7);
    if (!ids.has(c) && c !== '/') rotas.add(c, origem);
  }
}
rotas.add('/p/:slug', (() => {
  const l = ler('web/server.js').split('\n');
  const i = l.findIndex((x) => /\^\\\/p\\\/\(\[\^\/\]\+\)/.test(x));
  return i === -1 ? 'web/server.js:1' : `web/server.js:${i + 1}`;
})());

// ---------------------------------------------------------------- panel: rotas Express e abas
{
  const arquivos = ['panel/server.js'];
  for (const d of ['panel/lib', 'panel/rotas']) for (const n of listar(d, (e) => e.isFile() && e.name.endsWith('.js'))) arquivos.push(`${d}/${n}`);
  const RX = /\b(?:router|app)\.(get|post|put|delete|patch|all)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`|\w+)/g;
  for (const rel of arquivos) {
    const texto = ler(rel);
    const constantes = Object.fromEntries([...texto.matchAll(/\bconst\s+([A-Z_]+)\s*=\s*'([^']*)'/g)].map((x) => [x[1], x[2]]));
    for (let m; (m = RX.exec(texto));) {
      const origem = `${rel}:${linhaDe(texto, m.index)}`;
      const arg = m[2];
      let caminhos;
      if (arg[0] === '[') caminhos = [...arg.matchAll(/['"`]([^'"`]*)['"`]|(\b[A-Z_]{3,}\b)/g)].map((x) => (x[1] !== undefined ? x[1] : `\${${x[2]}}`));
      else if (/^['"`]/.test(arg)) caminhos = [arg.slice(1, -1)];
      else caminhos = [`\${${arg}}`]; // identificador: tenta resolver como constante abaixo
      for (let c of caminhos) {
        c = c.replace(/\$\{([A-Z_]+)\}/g, (_, n) => constantes[n] ?? `\${${n}}`);
        if (c.includes('${')) quebrou(`rota dinamica em ${origem} (${c}); o extrator nao sabe resolver.`, 'escreva a rota como texto literal ou como const NOME = \'/caminho\' no mesmo arquivo, ou ensine o extrator em scripts/docs-inventario.mjs.');
        rotas.add(`${m[1].toUpperCase()} ${c}`, origem);
      }
    }
  }
  {
    const rel = 'panel/lib/tela.js';
    const texto = ler(rel);
    const m = /`\$\{base\}(\/tela\/websockify)`/.exec(texto);
    if (!m) quebrou(`nao achei o caminho do WebSocket da Tela (\${base}/tela/websockify) em ${rel}.`, 'atualize scripts/docs-inventario.mjs para a nova forma de declarar o WebSocket.');
    rotas.add(`WS ${m[1]}`, `${rel}:${linhaDe(texto, m.index)}`);
  }
  const html = ler('panel/public/index.html');
  for (let m, rx = /data-tab="([a-z0-9-]+)"/g; (m = rx.exec(html));) {
    telas.add(`aba:${m[1]}`, `panel/public/index.html:${linhaDe(html, m.index)}`);
  }
}

// ---------------------------------------------------------------- comandos (bash)
// Le o `case` de um script e devolve [{nome, corpo(linhas), linha}] dos rotulos que sao subcomandos.
function blocoCase(linhas, ini, fim) {
  // primeiro `case` de MENOR indentacao dentro de [ini, fim) cuja variavel e $sub, $cmd ou ${1:-}.
  let melhor = null;
  for (let i = ini; i < fim; i++) {
    const m = /^(\s*)case\s+"(\$sub|\$cmd|\$\{1:-\})"\s+in\s*$/.exec(linhas[i]);
    if (m && (melhor === null || m[1].length < melhor.ind)) melhor = { i, ind: m[1].length };
  }
  if (!melhor) return null;
  let fimCase = fim;
  for (let i = melhor.i + 1; i < fim; i++) {
    if (new RegExp(`^\\s{${melhor.ind}}esac\\b`).test(linhas[i])) { fimCase = i; break; }
  }
  let indRot = null;
  for (let i = melhor.i + 1; i < fimCase; i++) { if (linhas[i].trim()) { indRot = linhas[i].match(/^\s*/)[0].length; break; } }
  if (indRot === null) return null;
  const rotulos = [];
  const rxRot = new RegExp(`^\\s{${indRot}}([^\\s()#][^()]*?)\\)(.*)$`);
  for (let i = melhor.i + 1; i < fimCase; i++) {
    const m = rxRot.exec(linhas[i]);
    if (m && linhas[i].match(/^\s*/)[0].length === indRot) rotulos.push({ i, nomes: m[1], resto: m[2] });
  }
  return rotulos.map((r, k) => {
    const fimCorpo = k + 1 < rotulos.length ? rotulos[k + 1].i : fimCase;
    return { nomes: r.nomes.split('|').map((n) => n.trim().replace(/^"|"$/g, '')), linha: r.i, corpo: [r.resto, ...linhas.slice(r.i + 1, fimCorpo)] };
  });
}

function corpoFuncao(linhas, nome) {
  const i = linhas.findIndex((l) => l.startsWith(`${nome}() {`));
  if (i === -1) return null;
  let f = linhas.findIndex((l, k) => k > i && l === '}');
  if (f === -1) f = linhas.length;
  return { ini: i, fim: f };
}

const comandos = new Lista();
const fontesBash = {};
function carregarBash(rel) { return (fontesBash[rel] ??= ler(rel).split('\n')); }
const libs = listar('lib', (e) => e.isFile() && e.name.endsWith('.sh')).map((n) => `lib/${n}`);

function acharFuncao(nome) {
  for (const rel of ['bin/dgclaw', ...libs]) {
    const l = carregarBash(rel);
    const c = corpoFuncao(l, nome);
    if (c) return { rel, linhas: l, ...c };
  }
  return null;
}

// percorre um case: para cada subcomando, ou recorre (case aninhado / <nome>_main / "listar" por if) ou emite folha.
function percorrer(prefixo, rel, linhas, ini, fim, profundidade = 0) {
  const blocos = blocoCase(linhas, ini, fim);
  const filhosPorIf = [];
  if (!blocos) return false;
  let achou = false;
  for (const b of blocos) {
    const nomes = b.nomes.filter((n) => n && n !== '*' && !n.startsWith('-'));
    if (nomes.length === 0) continue;
    achou = true;
    for (const nome of nomes) {
      const id = `${prefixo} ${nome}`;
      const origem = `${rel}:${b.linha + 1}`;
      const corpoTxt = b.corpo.join('\n');
      let filhos = false;
      if (profundidade < 3) {
        const fn = /\b([a-z][a-z_]*)_main\b/.exec(corpoTxt);
        if (fn) {
          const f = acharFuncao(`${fn[1]}_main`);
          if (f) {
            filhos = percorrer(id, f.rel, f.linhas, f.ini, f.fim, profundidade + 1);
            for (const m of f.linhas.slice(f.ini, f.fim).join('\n').matchAll(/"\$\{1:-\}"\s*=\s*([a-z][\w-]*)/g)) {
              comandos.add(`${id} ${m[1]}`, `${f.rel}:${f.ini + 1}`);
              comandos.add(id, origem); // o comando sem o subcomando tambem existe
              filhos = true;
            }
          }
        }
        const arq = /lib\/([a-z-]+\.sh)/.exec(corpoTxt);
        if (!filhos && arq && /\bexec\s+bash\b/.test(corpoTxt)) {
          const l = carregarBash(`lib/${arq[1]}`);
          const c = corpoFuncao(l, 'main');
          if (c) filhos = percorrer(id, `lib/${arq[1]}`, l, c.ini, c.fim, profundidade + 1);
        }
        if (!filhos) {
          // case aninhado logo no corpo do rotulo (dgclaw-agente canal telegram ...)
          filhos = percorrer(id, rel, linhas, b.linha + 1, b.linha + b.corpo.length, profundidade + 1);
        }
      }
      if (!filhos) comandos.add(id, origem);
    }
  }
  void filhosPorIf;
  return achou;
}

{
  const l = carregarBash('bin/dgclaw');
  const c = corpoFuncao(l, 'main');
  if (!c) quebrou('nao achei a funcao main() em bin/dgclaw.', 'atualize scripts/docs-inventario.mjs para o novo formato do bin/dgclaw.');
  percorrer('dgclaw', 'bin/dgclaw', l, c.ini, c.fim);

  for (const [rel, prefixo, depoisDe] of [['bin/dgclaw-agente', 'dgclaw-agente', 'canal'], ['bin/dgclaw-card', 'dgclaw-card', null]]) {
    const lin = carregarBash(rel);
    percorrer(depoisDe ? `${prefixo} ${depoisDe}` : prefixo, rel, lin, 0, lin.length);
  }
}

// ---------------------------------------------------------------- skills, powers, canais, provedores
const skills = new Lista();
for (const n of listar('skills', (e) => e.isDirectory() && e.name !== 'node_modules')) {
  if (fs.existsSync(path.join(RAIZ, 'skills', n, 'SKILL.md'))) skills.add(n, `skills/${n}/SKILL.md:1`);
}
const powers = new Lista();
for (const n of listar('powers', (e) => e.isDirectory() && e.name !== 'node_modules')) powers.add(n, `powers/${n}`);
const canais = new Lista();
for (const n of listar('canais', (e) => e.isDirectory() && e.name !== 'node_modules')) canais.add(n, `canais/${n}`);
const provedores = new Lista();
{
  const texto = ler('providers/catalogo.json');
  let json;
  try { json = JSON.parse(texto); } catch (e) { quebrou(`providers/catalogo.json nao e JSON valido (${e.message}).`, 'conserte o catalogo.'); }
  for (const id of Object.keys(json.provedores || {})) {
    const i = texto.split('\n').findIndex((x) => x.startsWith(`    "${id}":`));
    provedores.add(id, `providers/catalogo.json:${i === -1 ? 1 : i + 1}`);
  }
}

const saida = {
  telas: telas.itens(), rotas: rotas.itens(), rotas_detalhe: detalhe.itens(),
  comandos: comandos.itens(), skills: skills.itens(), powers: powers.itens(),
  canais: canais.itens(), provedores: provedores.itens(),
};
for (const k of ['telas', 'rotas', 'comandos', 'skills', 'powers', 'canais', 'provedores']) {
  if (saida[k].length === 0) quebrou(`a lista "${k}" saiu vazia em ${RAIZ}.`, 'o extrator nao entendeu o codigo (ou a pasta nao e o DG Claw). Ajuste scripts/docs-inventario.mjs.');
}
process.stdout.write(`${JSON.stringify(saida, null, 2)}\n`);
