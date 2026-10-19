'use strict';
// Teste sintético de uma ferramenta (bloco I): `dgclaw ferramenta testar <nome>` chama este arquivo.
//
// Lê o teste.json da pasta da ferramenta: um comando que prepara uma base FALSA (nomes e CPFs conhecidos), as credenciais
// de teste e uma lista de casos. Cada caso passa pelo mesmo núcleo do serviço (esquema, executor, verificador). Em TODO
// caso o teste falha se algum dos "segredos" (nomes e CPFs da base falsa) aparecer na resposta que iria ao agente.
//
// Uso: node testar.js <pasta-da-ferramenta> [--python caminho]      (sai com 1 se algum caso falhar)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { criarNucleo } = require('./nucleo');

function substituir(valor, tmp) {
  if (typeof valor === 'string') return valor.split('{TMP}').join(tmp);
  if (Array.isArray(valor)) return valor.map((v) => substituir(v, tmp));
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, substituir(v, tmp)]));
  return valor;
}

/** Roda o teste.json da ferramenta em `pasta`. Devolve { ok, casos: [{ nome, ok, detalhe }] } ou lança com o motivo em português. */
async function testarFerramenta(pasta, opcoes) {
  const o = opcoes || {};
  const python = o.python || 'python3';
  const arqTeste = path.join(pasta, 'teste.json');
  let teste;
  try { teste = JSON.parse(fs.readFileSync(arqTeste, 'utf8')); } catch (e) {
    throw new Error(`Não consegui ler ${arqTeste} (${e.code || e.message}). A ferramenta precisa de um teste.json com a base sintética e os casos; veja templates/ferramenta-sensivel/exemplo-carteira/teste.json.`);
  }
  let def;
  try { def = JSON.parse(fs.readFileSync(path.join(pasta, 'ferramenta.json'), 'utf8')); } catch (e) {
    throw new Error(`Não consegui ler ${path.join(pasta, 'ferramenta.json')} (${e.code || e.message}).`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dgf-teste-'));
  try {
    const dir = path.join(tmp, 'ferramentas');
    const copia = path.join(dir, def.nome);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.cpSync(pasta, copia, { recursive: true });
    for (const sobra of ['credenciais.env', 'credenciais.env.cred']) fs.rmSync(path.join(copia, sobra), { force: true });
    const chave = path.join(dir, 'chave-pseudonimo');
    fs.writeFileSync(chave, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    if (teste.preparar) {
      const argv = substituir(teste.preparar, tmp);
      const interp = argv[0] === 'python3' ? python : argv[0];
      try { execFileSync(interp, argv.slice(1), { cwd: copia, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); } catch (e) {
        throw new Error(`O comando "preparar" do teste falhou (${argv.join(' ')}): ${String(e.stderr || e.message).trim().slice(0, 300)}`);
      }
    }
    const creds = Object.entries(substituir(teste.credenciais || {}, tmp)).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(copia, 'credenciais.env'), `${creds}\n`, { mode: 0o600 });
    let segredos = [];
    if (teste.segredos) {
      try { segredos = JSON.parse(fs.readFileSync(substituir(teste.segredos, tmp), 'utf8')); } catch (e) {
        throw new Error(`O teste.json aponta "segredos" para um arquivo que não abre (${e.code || e.message}). O comando "preparar" precisa gravar a lista de nomes e CPFs falsos.`);
      }
    }
    if (!segredos.length) throw new Error('O teste não tem nenhum "segredo" (nome ou CPF falso conhecido). Sem isso ele não prova que nada vaza; gere a lista no comando "preparar".');
    const nucleo = criarNucleo({ dir, libDir: path.join(__dirname, 'lib'), python, log: () => {}, tmpBase: tmp });
    const casos = [];
    for (const c of teste.casos || []) {
      const r = await nucleo.executar({ ferramenta: def.nome, agente: def.agentes[0], params: c.params, executor: c.executor });
      const problemas = [];
      const motivo = r.ok ? 'ok' : r.motivo;
      if (motivo !== c.espera) problemas.push(`esperava "${c.espera}" e veio "${motivo}"${r.erro ? ` (${r.erro})` : ''}`);
      const entregue = JSON.stringify(r.ok ? r.resultado : { erro: r.erro, tipos: r.tipos });
      for (const s of segredos) if (entregue.includes(s)) problemas.push('VAZAMENTO: um nome ou CPF da base falsa apareceu na resposta que iria ao agente');
      for (const t of c.contem || []) if (!entregue.includes(t)) problemas.push(`a saída devia conter ${t}`);
      for (const t of c.nao_contem || []) if (entregue.includes(t)) problemas.push(`a saída não devia conter ${t}`);
      for (const t of c.tipos || []) if (!(r.tipos || []).includes(t)) problemas.push(`o verificador devia apontar o tipo ${t} (apontou: ${(r.tipos || []).join(', ') || 'nenhum'})`);
      casos.push({ nome: c.nome, ok: problemas.length === 0, detalhe: problemas.join('; ') });
    }
    if (!casos.length) throw new Error('O teste.json não tem nenhum caso em "casos".');
    return { ok: casos.every((c) => c.ok), casos };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { testarFerramenta };

if (require.main === module) {
  const args = process.argv.slice(2);
  let python = 'python3';
  const i = args.indexOf('--python');
  if (i >= 0) { python = args[i + 1]; args.splice(i, 2); }
  if (args.length !== 1) { process.stderr.write('Uso: node testar.js <pasta-da-ferramenta> [--python caminho]\n'); process.exit(2); }
  testarFerramenta(path.resolve(args[0]), { python }).then((r) => {
    for (const c of r.casos) process.stdout.write(`${c.ok ? 'ok     ' : 'FALHOU '}${c.nome}${c.detalhe ? `\n        ${c.detalhe}` : ''}\n`);
    process.stdout.write(r.ok ? `\nTeste sintético: tudo certo (${r.casos.length} casos).\n` : '\nTeste sintético: HOUVE FALHAS.\n');
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => { process.stderr.write(`Nao deu certo: ${e.message}\n`); process.exit(2); });
}
