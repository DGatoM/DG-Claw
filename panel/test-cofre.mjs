// test-cofre.mjs — as recusas do cofre, que são a parte que precisa estar certa.
//
// Roda contra uma pasta temporária, nunca contra o cofre de um agente de verdade.
// `node test-cofre.mjs` na pasta do painel.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildCofre } = require('./lib/cofre.js');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'cofre-teste-'));
const config = {
  agentSlug: 'teste',
  agentName: 'Agente de Teste',
  agentDir: RAIZ,
  creatorName: 'Dono de Teste',
  cofreDir: path.join(RAIZ, 'cofre'),
  cofreChaveMestra: path.join(RAIZ, 'cofre.chave'),
  cofreRuntimeDir: path.join(RAIZ, 'run'),
  cofreNomesExtras: ['MEU_SERVICO_ESQUISITO'],
};
const cofre = buildCofre(config);

let falhas = 0;
function ok(condicao, oQue) {
  if (condicao) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}`); falhas++; }
}

console.log('\nNomes que precisam ser RECUSADOS');
for (const [nome, porque] of [
  ['NODE_OPTIONS', 'executa arquivo escolhido pelo dono, como root'],
  ['LD_PRELOAD', 'carrega biblioteca antes do programa'],
  ['BASH_ENV', 'executa script na inicialização do agente de plugin'],
  ['GIT_SSH_COMMAND', 'execução por outro caminho'],
  ['NODE_EXTRA_CA_CERTS', 'move a âncora de confiança de TLS'],
  ['SSL_CERT_FILE', 'idem, sem executar nada'],
  ['PATH', 'reservado e perigoso'],
  ['HOME', 'reservado do provisionamento do runner'],
  ['RUNNER_PORT', 'reservado do provisionamento do runner'],
  ['CLAUDE_CONFIG_DIR', 'reservado: derrubou dois agentes em 28/08'],
  ['MINHA_COISA', 'não parece nome de credencial'],
  ['1CHAVE_API_KEY', 'fora do formato: começa com número'],
  ['CHAVE-API-KEY', 'fora do formato: hífen'],
  ['../ESCAPE', 'fora do formato'],
  ['node_options', 'a recusa vale depois de normalizar para maiúsculas'],
]) {
  const r = cofre.guardar({ envName: nome, valor: 'sk-1234567890abcdef', provedor: 'outro' });
  ok(!!r.erro, `${nome} recusado (${porque})`);
  if (r.erro && /sk-1234567890abcdef/.test(r.erro + (r.howToFix || ''))) {
    console.log('  FALHOU  a recusa repetiu o valor do segredo'); falhas++;
  }
}

console.log('\nNomes que precisam ser ACEITOS');
for (const nome of [
  'OPENAI_API_KEY', 'HOTMART_CLIENT_ID', 'KIWIFY_ACCOUNT_ID', 'META_APP_ID',
  'DATABASE_URL', 'TWILIO_ACCOUNT_SID', 'TELNYX_SIP_USERNAME', 'AWS_ACCESS_KEY_ID',
  'MEU_SERVICO_ESQUISITO',
]) {
  const r = cofre.guardar({ envName: nome, valor: `chave-de-teste-${nome.toLowerCase()}`, provedor: 'outro' });
  ok(r.ok === true, `${nome} aceito${r.erro ? ` (recusou: ${r.erro})` : ''}`);
}
// Minúscula é digitação, não intenção: o nome é normalizado para maiúsculas
// ANTES de passar pelas listas, então `x_api_key` vira `X_API_KEY` e `node_options`
// vira `NODE_OPTIONS`, que continua recusado (está na lista acima).
{
  const r = cofre.guardar({ envName: 'x_api_key', valor: 'chave-de-teste-minuscula', provedor: 'outro' });
  ok(r.ok === true && r.envName === 'X_API_KEY', 'x_api_key entra normalizado como X_API_KEY');
}

console.log('\nValores que precisam ser RECUSADOS');
for (const [valor, porque] of [
  ['curta', 'menos de 8 caracteres'],
  ['chave\ncom quebra de linha', 'quebra de linha viraria uma segunda variável'],
  ['chave\u0000nula', 'byte nulo'],
  ["chave'com'apostrofo", 'aspa simples: o bash e o systemd leriam valores diferentes'],
  ['chave-com-acento-é', 'fora de ASCII'],
]) {
  const r = cofre.guardar({ envName: 'TESTE_API_KEY', valor, provedor: 'outro' });
  ok(!!r.erro, `valor recusado: ${porque}`);
}

console.log('\nO arquivo de ambiente');
const m = cofre.materializar();
ok(m.ok === true, `materializou (${m.chaves} chaves, falhas: ${(m.falhas || []).length})`);
const texto = fs.readFileSync(m.arquivo, 'utf-8');
ok(/^OPENAI_API_KEY='chave-de-teste-openai_api_key'$/m.test(texto), 'a linha sai em aspas simples');
ok((fs.statSync(m.arquivo).mode & 0o777) === 0o600, 'o arquivo de ambiente está em 600');
ok((fs.statSync(config.cofreDir).mode & 0o777) === 0o700, 'a pasta do cofre está em 700');

// O valor com cara de comando sai LITERAL, e não escapado: dentro de aspas
// simples nem o bash nem o systemd expandem nada, e é por isso que a linha pode
// ser a mesma para os dois. Quem garante que não há aspa simples no meio (o único
// caractere em que os dois discordam) é a VALOR_OK, testada logo acima.
cofre.guardar({ envName: 'COMANDO_API_KEY', valor: 'abc$(whoami)`id`${HOME}def', provedor: 'outro' });
cofre.materializar();
const comComando = fs.readFileSync(m.arquivo, 'utf-8');
ok(
  comComando.includes('COMANDO_API_KEY=\'abc$(whoami)`id`${HOME}def\''),
  'valor com $(), crase e ${} sai literal entre aspas simples',
);

{
  const r = cofre.guardar({ envName: 'REFERENCIA_API_KEY', valor: 'vault:referencia-de-teste', provedor: 'outro' });
  ok(r.erro && r.status === 400 && /referência de cofre/.test(r.erro) && !r.erro.includes('referencia-de-teste'),
    'referência de outro cofre ("vault:...") é recusada, sem repetir o valor');
}

console.log('\nO valor nunca volta');
const estado = cofre.estado();
const comoTexto = JSON.stringify(estado);
ok(!/chave-de-teste/.test(comoTexto), 'o estado da tela não traz valor de segredo nenhum');
ok(estado.chaves.every((c) => c.ultimos4 && c.ultimos4.length === 4), 'toda chave mostra os 4 últimos');

console.log('\nRevogar é datar');
const rev = cofre.revogar('OPENAI_API_KEY', 'Dono de Teste');
ok(rev.ok === true, 'revogou');
const depois = cofre.estado().chaves.find((c) => c.envName === 'OPENAI_API_KEY');
ok(!!(depois && depois.revogadaEm), 'o registro continua, com a data da revogação');
ok(!fs.existsSync(path.join(config.cofreDir, 'segredos', 'OPENAI_API_KEY.enc')), 'o valor cifrado foi removido');
const m2 = cofre.materializar();
ok(!/OPENAI_API_KEY=/.test(fs.readFileSync(m2.arquivo, 'utf-8')), 'a chave revogada sai do arquivo de ambiente');
ok(!!cofre.revogar('OPENAI_API_KEY').erro, 'revogar duas vezes é recusado com motivo');

console.log('\nCLAUDE_CODE_OAUTH_TOKEN: a única exceção ao prefixo CLAUDE_');
{
  const r = cofre.guardar({ envName: 'CLAUDE_CODE_OAUTH_TOKEN', valor: 'sk-teste-assinatura-000000', provedor: 'claude-assinatura' });
  ok(r.ok === true, 'CLAUDE_CODE_OAUTH_TOKEN aceito (token do claude setup-token)');
  for (const nome of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN_X', 'CLAUDE_ANYTHING_TOKEN']) {
    ok(!!cofre.guardar({ envName: nome, valor: 'sk-teste-assinatura-000000' }).erro, `${nome} continua recusado`);
  }
  ok(cofre.PROVEDORES.some((p) => p.id === 'claude-assinatura' && p.sugestao === 'CLAUDE_CODE_OAUTH_TOKEN' && p.onde === null),
    'o catálogo tem o item claude-assinatura, separado do provedor anthropic');
}

console.log('\ntem(): só metadado, falso para revogada');
{
  const c2 = buildCofre({ ...config, cofreDir: path.join(RAIZ, 'cofre-tem'), cofreChaveMestra: path.join(RAIZ, 'tem.chave'), cofreRuntimeDir: path.join(RAIZ, 'run-tem') });
  ok(c2.tem('OPENAI_API_KEY') === false, 'cofre vazio: nada existe');
  c2.guardar({ envName: 'OPENAI_API_KEY', valor: 'sk-teste-000000000000', provedor: 'openai' });
  ok(c2.tem('OPENAI_API_KEY') === true, 'depois de guardar: existe');
  ok(c2.tem('openai_api_key') === true, 'o nome é normalizado como no guardar');
  ok(c2.tem('OUTRA_API_KEY') === false, 'outro nome: não existe');
  ok(c2.tem('../ESCAPE') === false && c2.tem('') === false && c2.tem(undefined) === false, 'nome inválido ou vazio: falso, sem erro');
  // Prova de que não decifra: apagar o .enc não muda a resposta (ela vem do metadado).
  fs.rmSync(path.join(RAIZ, 'cofre-tem', 'segredos', 'OPENAI_API_KEY.enc'));
  ok(c2.tem('OPENAI_API_KEY') === true, 'não abre o arquivo cifrado: responde só pelo metadado');
  c2.guardar({ envName: 'OPENAI_API_KEY', valor: 'sk-teste-000000000000', provedor: 'openai' });
  c2.revogar('OPENAI_API_KEY', 'Dono de Teste');
  ok(c2.tem('OPENAI_API_KEY') === false, 'revogada: falso');
}

console.log('\nOrigem: quem cadastrou, e por onde');
{
  const c3 = buildCofre({ ...config, cofreDir: path.join(RAIZ, 'cofre-origem'), cofreChaveMestra: path.join(RAIZ, 'origem.chave'), cofreRuntimeDir: path.join(RAIZ, 'run-origem') });
  c3.guardar({ envName: 'A_API_KEY', valor: 'sk-teste-000000000000', quem: 'Dono de Teste' });
  c3.guardar({ envName: 'B_API_KEY', valor: 'sk-teste-000000000000', quem: 'Admin (por API)', origem: 'api' });
  c3.guardar({ envName: 'C_API_KEY', valor: 'sk-teste-000000000000', origem: 'qualquer-coisa' });
  const por = Object.fromEntries(c3.estado().chaves.map((c) => [c.envName, c]));
  ok(por.A_API_KEY.origem === 'tela', 'sem origem informada: tela');
  ok(por.B_API_KEY.origem === 'api' && por.B_API_KEY.cadastradaPor === 'Admin (por API)', 'origem api e o nome de quem cadastrou aparecem no estado');
  ok(por.C_API_KEY.origem === 'tela', 'origem desconhecida não vira api');
}

console.log('\nO valor guardado não vaza para lugar nenhum além do .enc');
{
  const VALOR = 'sk-teste-vazamento-0123456789';
  const dirVaza = path.join(RAIZ, 'cofre-vaza');
  const c4 = buildCofre({ ...config, cofreDir: dirVaza, cofreChaveMestra: path.join(RAIZ, 'vaza.chave'), cofreRuntimeDir: path.join(RAIZ, 'run-vaza') });

  // Captura tudo o que o módulo imprime enquanto trabalha, inclusive nos caminhos de recusa.
  const impresso = [];
  const originais = {};
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) {
    originais[nivel] = console[nivel];
    console[nivel] = (...a) => impresso.push(a.map(String).join(' '));
  }
  let respostas;
  try {
    const guardou = c4.guardar({ envName: 'VAZA_API_KEY', valor: VALOR, provedor: 'outro', quem: 'Teste' });
    const trocou = c4.guardar({ envName: 'VAZA_API_KEY', valor: VALOR, provedor: 'outro', quem: 'Teste' });
    const recusadoNome = c4.guardar({ envName: 'NODE_OPTIONS', valor: VALOR });
    const recusadoValor = c4.guardar({ envName: 'VAZA_API_KEY', valor: `${VALOR}'` });
    const mat = c4.materializar();
    const rev = c4.revogar('VAZA_API_KEY', 'Teste');
    respostas = JSON.stringify([guardou, trocou, recusadoNome, recusadoValor, mat, rev, c4.estado(), c4.tem('VAZA_API_KEY')]);
  } finally {
    Object.assign(console, originais);
  }
  // Guardar de novo, depois de revogar, para ter um .enc vivo no momento da conferência de arquivos.
  c4.guardar({ envName: 'VAZA_API_KEY', valor: VALOR, provedor: 'outro' });

  ok(!respostas.includes(VALOR), 'nenhuma resposta (guardar, recusas, materializar, revogar, estado) traz o valor');
  ok(!impresso.join('\n').includes(VALOR), `nada do que o módulo imprimiu no console traz o valor (${impresso.length} linha(s) capturada(s))`);
  ok(!JSON.stringify(c4.estado()).includes(VALOR), 'o estado() não traz o valor');
  ok(!fs.readFileSync(path.join(dirVaza, 'chaves.json'), 'utf-8').includes(VALOR), 'o arquivo de metadado não traz o valor');

  const arquivos = [];
  (function varrer(pasta) {
    for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
      const caminho = path.join(pasta, e.name);
      if (e.isDirectory()) varrer(caminho); else arquivos.push(caminho);
    }
  })(dirVaza);
  const fora = arquivos.filter((a) => !a.endsWith('.enc'));
  ok(fora.length >= 1 && fora.every((a) => !fs.readFileSync(a, 'utf-8').includes(VALOR)), `nenhum dos ${fora.length} arquivo(s) da pasta do cofre fora do .enc traz o valor`);
  const enc = arquivos.filter((a) => a.endsWith('.enc'));
  ok(enc.length === 1 && !fs.readFileSync(enc[0]).includes(Buffer.from(VALOR)), 'e o próprio .enc não guarda o valor em texto puro');
}

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
