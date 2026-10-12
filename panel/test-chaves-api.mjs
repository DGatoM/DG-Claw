// test-chaves-api.mjs — as chaves de API do painel: o que é guardado, o que volta e quando vale.
//
// Roda contra uma pasta temporária, nunca contra o agente de verdade, e com um relógio
// que o teste controla (o carimbo de último uso grava no máximo 1x por minuto).
// `node test-chaves-api.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildChavesApi, PREFIXO } = require('./lib/chaves-api.js');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'chaves-api-teste-'));
const ARQUIVO = path.join(RAIZ, '.dgclaw', 'panel', 'chaves-api.json');
let agora = Date.parse('2026-01-01T10:00:00Z');
const config = { agentDir: RAIZ, creatorName: 'Dono de Teste', agora: () => agora };
const chaves = buildChavesApi(config);

let falhas = 0;
function ok(condicao, oQue) {
  if (condicao) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}
const lerArquivo = () => JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));

console.log('\nCriar');
const c = chaves.criar({ nome: '  Admin  ', quem: 'Dono de Teste' });
ok(c.ok === true && c.token.startsWith(PREFIXO) && c.token.length === 4 + 43, 'o token é dgc_ + 32 bytes em base64url');
ok(/^[\w-]+$/.test(c.token), 'só caracteres seguros para cabeçalho');
ok(c.nome === 'Admin' && /^[0-9a-f]{10}$/.test(c.id), 'o nome é aparado e o código é curto');
ok(/não aparece de novo/.test(c.aviso), 'o aviso diz que o token não aparece de novo');
ok(chaves.criar({ nome: 'Admin', quem: 'x' }).token !== c.token, 'dois tokens nunca se repetem');

console.log('\nO que fica no disco');
const arquivo = fs.readFileSync(ARQUIVO, 'utf-8');
ok(!arquivo.includes(c.token), 'o token não está no arquivo');
const reg = lerArquivo().chaves.find((x) => x.id === c.id);
ok(reg.hash === crypto.createHash('sha256').update(c.token).digest('hex'), 'só o sha256 do token fica guardado');
ok(reg.ultimos4 === c.token.slice(-4) && reg.criadaPor === 'Dono de Teste' && reg.criadaEm && reg.ultimoUsoEm === null && reg.revogadaEm === null,
  'ficam id, nome, quem criou, quando, 4 últimos, último uso nulo e revogada nula');
ok((fs.statSync(ARQUIVO).mode & 0o777) === 0o600, 'o arquivo é modo 600');
ok(fs.readdirSync(path.dirname(ARQUIVO)).every((f) => !f.endsWith('.tmp')), 'a escrita atômica não deixa arquivo temporário para trás');

console.log('\nListar');
const lista = chaves.listar();
const texto = JSON.stringify(lista);
ok(lista.length === 2, 'lista as duas chaves');
ok(!texto.includes(c.token) && !texto.includes(reg.hash) && !/"hash"/.test(texto), 'a lista não traz token nem hash');
ok(lista[0].id && lista[0].nome && lista[0].criadaPor && lista[0].criadaEm && lista[0].ultimos4, 'traz o que a tela precisa');

console.log('\nConferir');
ok(chaves.conferir(c.token) && chaves.conferir(c.token).nome === 'Admin', 'o token certo confere e devolve o nome');
const errada = c.token.slice(0, -1) + (c.token.endsWith('A') ? 'B' : 'A');
ok(chaves.conferir(errada) === null, 'um caractere diferente: recusa');
ok(chaves.conferir('') === null && chaves.conferir(undefined) === null && chaves.conferir('lixo') === null, 'vazio, ausente e sem prefixo: recusa');
ok(chaves.conferir(crypto.createHash('sha256').update(c.token).digest('hex')) === null, 'o hash guardado NÃO serve como token');

console.log('\nÚltimo uso: no máximo uma gravação por minuto');
ok(lerArquivo().chaves.find((x) => x.id === c.id).ultimoUsoEm === new Date(agora).toISOString(), 'o primeiro uso grava o carimbo');
const mtimeAntes = fs.statSync(ARQUIVO).mtimeMs;
agora += 30 * 1000;
chaves.conferir(c.token);
ok(fs.statSync(ARQUIVO).mtimeMs === mtimeAntes, 'um segundo uso 30 s depois NÃO regrava o arquivo');
agora += 31 * 1000;
chaves.conferir(c.token);
ok(lerArquivo().chaves.find((x) => x.id === c.id).ultimoUsoEm === new Date(agora).toISOString(), 'passado 1 minuto, o carimbo é atualizado');

console.log('\nCriar com a CLI enquanto o painel roda');
{
  // Outra instância sobre o mesmo arquivo é a CLI (bin/chave-api.js): a chave dela precisa valer sem reiniciar.
  const cli = buildChavesApi(config);
  const daCli = cli.criar({ nome: 'Criada pela CLI', quem: 'CLI' });
  ok(chaves.conferir(daCli.token) && chaves.conferir(daCli.token).nome === 'Criada pela CLI', 'a chave criada por outro processo vale no painel que já estava no ar');
  ok(cli.conferir(c.token) !== null, 'e a que o painel carimbou continua válida para a CLI');
}

console.log('\nRevogar é datar');
const rev = chaves.revogar(c.id, 'Dono de Teste');
ok(rev.ok === true, 'revoga');
ok(chaves.conferir(c.token) === null, 'revogada, o token deixa de valer na hora');
const depois = lerArquivo().chaves.find((x) => x.id === c.id);
ok(depois && depois.revogadaEm && depois.revogadaPor === 'Dono de Teste', 'o registro continua, com a data e quem revogou');
ok(chaves.listar().find((x) => x.id === c.id).revogadaEm, 'a lista mostra a data');
ok(!!chaves.revogar(c.id).erro && chaves.revogar(c.id).status === 409, 'revogar duas vezes: recusa com motivo (409)');
ok(chaves.revogar('naoexiste').status === 404, 'código que não existe: 404');

console.log('\nRecusas com motivo');
for (const [pedido, porque] of [
  [{ nome: '' }, 'nome vazio'],
  [{ nome: '   ' }, 'nome só de espaços'],
  [{}, 'sem nome'],
  [{ nome: 'x'.repeat(61) }, 'nome comprido demais'],
  [{ nome: 'com\nquebra' }, 'caractere de controle'],
]) {
  const r = chaves.criar(pedido);
  ok(!!r.erro && r.status === 400 && r.howToFix, `${porque}: recusa com erro e howToFix`);
}

console.log('\nArquivo ilegível não vira "nenhuma chave" em silêncio');
{
  const dir = path.join(RAIZ, 'quebrado');
  const arq = path.join(dir, '.dgclaw', 'panel', 'chaves-api.json');
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  fs.writeFileSync(arq, '{ isto não é json', { mode: 0o600 });
  const impresso = [];
  const original = console.error;
  console.error = (...a) => impresso.push(a.join(' '));
  let valeu;
  try { valeu = buildChavesApi({ agentDir: dir }).conferir(`${PREFIXO}${'a'.repeat(43)}`); } finally { console.error = original; }
  ok(valeu === null && impresso.some((l) => /chaves de API/.test(l) && /não consegui ler/.test(l)), 'recusa e escreve no log o que houve');
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
