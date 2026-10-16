#!/usr/bin/env node
'use strict';
// Cofre dos agentes pela linha de comando, no servidor (host). É o que "dgclaw agente cofre" chama.
//
//   node web/bin/cofre.js guardar <agente> NOME [--provedor id] [--aplicar] [--quem texto] [--json]   (valor pelo stdin)
//   node web/bin/cofre.js revogar <agente> NOME [--quem texto] [--json]
//   node web/bin/cofre.js listar  <agente> [--json]
//   node web/bin/cofre.js aplicar <agente> [--json]
//
// O valor da chave entra SEMPRE pelo stdin, nunca por argumento (argumento aparece em `ps` e no
// histórico do shell). Nada que este programa imprime contém o valor.
// Saída: 0 deu certo, 1 recusa (o motivo vem escrito), 2 uso errado.
// Lê DGCLAW_WEB_ENV, DGCLAW_AGENTES e DGCLAW_WEB_DATA, como o servidor.

const fs = require('node:fs');
const { carregaConfig } = require('../lib/config');
const { criarRegistro } = require('../lib/registro');
const { criarCofreAgente } = require('../lib/cofre-agente');

const USO = [
  'Uso:',
  '  cofre guardar <agente> NOME [--provedor id] [--aplicar] [--quem texto] [--json]   (o valor vem pelo stdin)',
  '  cofre revogar <agente> NOME [--quem texto] [--json]',
  '  cofre listar  <agente> [--json]',
  '  cofre aplicar <agente> [--json]',
  'Exemplo: printf %s "$CHAVE" | cofre guardar bento OPENAI_API_KEY --provedor openai --aplicar',
].join('\n');

function usoErrado(msg) {
  process.stderr.write(`${msg}\n\n${USO}\n`);
  return 2;
}

function lerArgumentos(argv) {
  const pos = []; const op = { json: false, aplicar: false, provedor: null, quem: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') op.json = true;
    else if (a === '--aplicar') op.aplicar = true;
    else if (a === '--provedor' || a === '--quem') {
      if (i + 1 >= argv.length) return { erro: `Faltou o valor depois de ${a}.` };
      op[a.slice(2)] = argv[i + 1]; i += 1;
    } else if (a.startsWith('--')) return { erro: `Não conheço a opção ${a}.` };
    else pos.push(a);
  }
  return { pos, op };
}

async function main(argv) {
  const r = lerArgumentos(argv);
  if (r.erro) return usoErrado(r.erro);
  const { pos, op } = r;
  const [comando, slug, nome, ...sobra] = pos;
  if (!['guardar', 'revogar', 'listar', 'aplicar'].includes(comando)) return usoErrado(comando ? `Não conheço o comando "${comando}".` : 'Faltou o comando.');
  if (!slug) return usoErrado('Faltou o nome do agente (o slug do registro).');
  const precisaNome = comando === 'guardar' || comando === 'revogar';
  if (precisaNome && !nome) return usoErrado(`Faltou o NOME da variável (ex.: OPENAI_API_KEY) em "${comando}".`);
  if (!precisaNome && nome) return usoErrado(`"${comando}" não recebe nome de variável (recebi "${nome}").`);
  if (sobra.length || (nome && nome.includes('='))) {
    return usoErrado('Não passe o valor da chave na linha de comando: ele ficaria no histórico do shell e na lista de processos. Mande o valor pelo stdin (printf %s "$CHAVE" | ...).');
  }

  const log = (nivel, msg) => {
    if (nivel === 'erro' || (nivel === 'aviso' && !/^Não li o arquivo de ambiente/.test(msg))) process.stderr.write(`[${nivel}] ${msg}\n`);
  };
  const config = carregaConfig({}, log);
  const registro = criarRegistro({ caminho: config.agentesPath, log });
  const est = registro.estado();
  if (!est.ok) { process.stderr.write(`${est.erro}\n`); return 1; }
  const agente = est.agentes.find((a) => a.slug === slug);
  if (!agente) {
    process.stderr.write(`Não existe agente "${slug}" no registro (${config.agentesPath}). Agentes: ${est.agentes.map((a) => a.slug).join(', ')}.\n`);
    return 1;
  }
  const cofre = criarCofreAgente({ config, log });
  const quem = op.quem || 'administrador (linha de comando)';
  const saida = (obj, texto) => process.stdout.write(op.json ? `${JSON.stringify(obj)}\n` : `${texto}\n`);
  const recusou = (rec) => {
    if (op.json) process.stdout.write(`${JSON.stringify({ ok: false, erro: rec.erro, howToFix: rec.howToFix || null, status: rec.status || null })}\n`);
    else process.stderr.write(`${rec.erro}${rec.howToFix ? `\n${rec.howToFix}` : ''}\n`);
    return 1;
  };

  if (comando === 'listar') {
    const l = cofre.listar(agente);
    if (l.erro) return recusou(l);
    const linhas = l.chaves.length
      ? l.chaves.map((c) => `${c.envName}  termina em ${c.ultimos4 || '?'}  ${c.provedor}  ${c.revogadaEm ? `revogada em ${String(c.revogadaEm).slice(0, 10)}` : `ativa${c.cadastradaEm ? `, cadastrada em ${String(c.cadastradaEm).slice(0, 10)}` : ''}`}`).join('\n')
      : `${agente.nome} não tem chave no cofre.`;
    saida({ ok: true, chaves: l.chaves }, linhas);
    return 0;
  }

  if (comando === 'revogar') {
    const v = cofre.revogar(agente, nome, quem);
    if (v.erro) return recusou(v);
    saida(v, `Chave ${v.envName} revogada. ${v.aviso}`);
    return 0;
  }

  if (comando === 'aplicar') {
    const a = await cofre.aplicar(agente);
    if (a.erro) return recusou(a);
    saida(a, a.feito);
    return 0;
  }

  // guardar
  if (process.stdin.isTTY) {
    return usoErrado('O valor da chave precisa vir pelo stdin, e aqui o stdin é o teclado (ele ficaria na tela). Use: printf %s "$CHAVE" | cofre guardar ...');
  }
  let valor;
  try { valor = fs.readFileSync(0, 'utf8'); } catch (e) {
    return usoErrado(`Não consegui ler o valor pelo stdin (${e.code || e.message}).`);
  }
  const g = cofre.guardar(agente, { envName: nome, valor: valor.replace(/[\r\n]+$/, ''), provedor: op.provedor || 'outro', quem, origem: 'cli' });
  if (g.erro) return recusou(g);
  if (!op.aplicar) {
    saida(g, `Chave ${g.envName} ${g.trocada ? 'trocada' : 'guardada'} (termina em ${g.ultimos4}). ${g.aviso} Rode "aplicar ${slug}" (ou use --aplicar) para reiniciar o agente.`);
    return 0;
  }
  const a = await cofre.aplicar(agente);
  if (a.erro) {
    if (op.json) process.stdout.write(`${JSON.stringify({ ok: false, guardado: g, erro: a.erro, howToFix: a.howToFix || null })}\n`);
    else process.stderr.write(`Chave ${g.envName} guardada (termina em ${g.ultimos4}), mas o agente não reiniciou.\n${a.erro}${a.howToFix ? `\n${a.howToFix}` : ''}\n`);
    return 1;
  }
  saida(Object.assign({}, g, { aplicado: a }), `Chave ${g.envName} ${g.trocada ? 'trocada' : 'guardada'} (termina em ${g.ultimos4}). ${a.feito}`);
  return 0;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }).catch((e) => {
    process.stderr.write(`O comando quebrou: ${e && e.message}. Nada do valor da chave foi impresso; veja o registro do servidor.\n`);
    process.exitCode = 1;
  });
}
