#!/usr/bin/env node
'use strict';
// Chaves de API do DG Claw Web pela linha de comando, no servidor (host). É o que "dgclaw chave-api" chama.
//
//   node web/bin/chave-api.js criar --nome "<nome>" --escopo diagnostico [--quem texto]
//   node web/bin/chave-api.js listar [--json]
//   node web/bin/chave-api.js revogar <id> [--quem texto]
//
// `criar` imprime SÓ o token no stdout (dá para capturar com $(...)); os avisos vão para o stderr.
// O token nunca é gravado em log nem passa por argumento de outro processo.
// Saída: 0 deu certo, 1 recusa (o motivo vem escrito), 2 uso errado.
// Lê DGCLAW_WEB_ENV e DGCLAW_WEB_DATA, como o servidor: o arquivo é <dados do Web>/chaves-api.json.

const { carregaConfig } = require('../lib/config');
const { criarChavesApi, ESCOPOS } = require('../lib/chaves-api');

const USO = [
  'Uso:',
  '  chave-api criar --nome "<nome>" --escopo diagnostico [--quem texto]',
  '  chave-api listar [--json]',
  '  chave-api revogar <id> [--quem texto]',
  `Escopos aceitos: ${ESCOPOS.join(', ')}.`,
  'Exemplo: dgclaw chave-api criar --nome "Suporte DG" --escopo diagnostico',
].join('\n');

function usoErrado(msg) {
  process.stderr.write(`${msg}\n\n${USO}\n`);
  return 2;
}

function lerArgumentos(argv) {
  const pos = []; const op = { nome: null, escopo: [], quem: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') op.json = true;
    else if (a === '--nome' || a === '--escopo' || a === '--quem') {
      if (i + 1 >= argv.length) return { erro: `Faltou o valor depois de ${a}.` };
      if (a === '--escopo') op.escopo.push(argv[i + 1]); else op[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) return { erro: `Não conheço a opção ${a}.` };
    else pos.push(a);
  }
  return { pos, op };
}

const dia = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '-');

function tabela(chaves) {
  const cab = ['ID', 'NOME', 'FINAL', 'ESCOPOS', 'CRIADA', 'ÚLTIMO ACESSO', 'ESTADO'];
  const linhas = chaves.map((c) => [
    c.id, c.nome, `****${c.ultimos4}`, c.escopos.join(','), dia(c.criadaEm),
    c.ultimoUsoEm ? `${dia(c.ultimoUsoEm)}${c.ultimoUsoIp ? ` (${c.ultimoUsoIp})` : ''}` : 'nunca usada',
    c.revogadaEm ? `revogada em ${dia(c.revogadaEm)}` : 'ativa',
  ]);
  const larg = cab.map((t, i) => Math.max(t.length, ...linhas.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((v, i) => String(v).padEnd(larg[i])).join('  ').trimEnd();
  return [fmt(cab), ...linhas.map(fmt)].join('\n');
}

function main(argv) {
  const r = lerArgumentos(argv);
  if (r.erro) return usoErrado(r.erro);
  const { pos, op } = r;
  const [comando, ...sobra] = pos;
  if (!['criar', 'listar', 'revogar'].includes(comando)) return usoErrado(comando ? `Não conheço o comando "${comando}".` : 'Faltou o comando.');

  const log = (nivel, msg) => {
    if (nivel === 'erro' || (nivel === 'aviso' && !/^Não li o arquivo de ambiente/.test(msg))) process.stderr.write(`[${nivel}] ${msg}\n`);
  };
  const config = carregaConfig({}, log);
  const chaves = criarChavesApi({ config, log });
  const quem = op.quem || 'administrador (linha de comando)';
  const recusou = (rec) => {
    process.stderr.write(`${rec.erro}${rec.como_resolver ? `\n${rec.como_resolver}` : ''}\n`);
    return 1;
  };

  if (comando === 'listar') {
    if (sobra.length) return usoErrado('"listar" não recebe argumentos.');
    const lista = chaves.listar();
    if (op.json) process.stdout.write(`${JSON.stringify({ ok: true, chaves: lista })}\n`);
    else process.stdout.write(`${lista.length ? tabela(lista) : 'Nenhuma chave de API criada ainda.'}\n`);
    return 0;
  }

  if (comando === 'revogar') {
    if (sobra.length !== 1) return usoErrado('Diga o código da chave a revogar (veja em "listar").');
    const v = chaves.revogar(sobra[0], quem);
    if (!v.ok) return recusou(v);
    process.stderr.write(`A chave "${v.chave.nome}" deixou de valer agora.\n`);
    return 0;
  }

  // criar
  if (sobra.length) return usoErrado(`"criar" não recebe argumentos soltos (recebi "${sobra[0]}"). Use --nome e --escopo.`);
  if (!op.nome) return usoErrado('Faltou --nome, que diz para quem é a chave.');
  if (!op.escopo.length) return usoErrado(`Faltou --escopo. Escopos aceitos: ${ESCOPOS.join(', ')}.`);
  const c = chaves.criar({ nome: op.nome, escopos: op.escopo, quem });
  if (!c.ok) return recusou(c);
  process.stderr.write(`Chave "${c.chave.nome}" criada (código ${c.chave.id}, termina em ${c.chave.ultimos4}). Guarde o token agora: ele não aparece de novo.\n`);
  process.stdout.write(`${c.token}\n`);
  return 0;
}

module.exports = { main };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`O comando quebrou: ${e && e.message}. Nada do token foi impresso; confira a pasta de dados do Web.\n`);
    process.exitCode = 1;
  }
}
