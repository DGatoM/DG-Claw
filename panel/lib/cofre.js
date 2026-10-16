// cofre.js — a aba Cofre: onde o dono do agente guarda a chave de um serviço.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  O QUE ENTRA AQUI VIRA VARIÁVEL DE AMBIENTE DE UM PROCESSO QUE RODA       ║
// ║  COMO ROOT. Cada recusa deste arquivo existe por causa disso.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// O caso concreto que pediu esta tela: o Bento, que é o agente do Paulo,
// precisa de uma chave da OpenAI para gerar capa de YouTube. Sem esta aba, a
// única forma de dar uma chave a um agente era alguém com acesso à máquina
// editar um arquivo à mão.
//
// O DESENHO INTEIRO SAIU DE UM DOCUMENTO ESCRITO ANTES DESTA TELA EXISTIR:
// `panel/docs/COFRE.md`, da rodada de segurança. Quem for mexer aqui lê aquilo primeiro. O resumo do que ele manda, e que
// está implementado abaixo:
//
//   1. allowlist por agente: chave cadastrada aqui vale para ESTE agente e para
//      mais nenhum. É a lição de 18/08/2026, quando se descobriu que o cofre do
//      Bunker entregava 77 dos 79 segredos a todo card, e dois agentes
//      nasciam com Hotmart, Kiwify e credencial contábil no ambiente;
//   2. write-only: depois de salvar, NENHUM caminho deste módulo devolve o valor.
//      Ele nem chega perto: o valor mora cifrado num arquivo por chave, e os
//      metadados moram noutro. Não existe objeto em memória com os dois juntos;
//   3. cifrado em repouso;
//   4. escrita estreita e validada, porque o painel roda como root;
//   5. nunca logar valor, nem em erro;
//   6. revogar é datar, não apagar;
//   7. trocar segredo exige reiniciar o agente, e a tela precisa dizer isso;
//  10. os nomes que o provisionamento do runner já usa são reservados;
//  11. a chave é do DONO do agente, e a fatura é dele.
//
// A DÉCIMA SEGUNDA REGRA NASCEU AQUI, escrevendo o arquivo, e é a mais fácil de
// não enxergar: o NOME da variável é vetor de execução de código. `NODE_OPTIONS`
// passa em `^[A-Z][A-Z0-9_]*$`, e `NODE_OPTIONS=--require /pasta/dele/x.js` faz o
// runner (`/usr/bin/node dist/index.js`) executar o arquivo do dono do agente
// como root, na máquina do Danilo. `LD_PRELOAD` faz o mesmo com qualquer binário,
// e `BASH_ENV` faz o mesmo no agente de plugin, que sobe por um script de shell.
// Por isso o nome passa por LISTA DE PERMITIDOS (`NOME_PERMITIDO`), e não por
// lista de proibidos: numa lista de proibidos, o nome perigoso seguinte é sempre
// o que ninguém lembrou de proibir. A lista de recusa que existe logo abaixo dela
// é redundância deliberada, para o dia em que alguém alargar a de permitidos sem
// pensar em execução de código.
//
// AS DUAS FORMAS DE AGENTE, e as duas existem em produção hoje:
//
//   | forma   | unidade                  | de onde ele lê o ambiente        |
//   | ------- | ------------------------ | -------------------------------- |
//   | runner  | `dgclaw-agent-<slug>`    | `/etc/dgclaw/agents/<slug>.env`  |
//   | plugin  | `dgclaw-<slug>`          | `~/.dgclaw/config.sh` (shell)    |
//
// O cofre NÃO ESCREVE EM NENHUM DOS DOIS. Ele escreve um terceiro arquivo, só
// dele, em `KEY='valor'`, e as duas formas passam a ler esse arquivo: o runner
// por `EnvironmentFile=`, o de plugin por uma linha `set -a; . <arquivo>; set +a`
// no `config.sh`. O motivo de não escrever direto no `config.sh` é que ele é
// script de shell: um valor com `$(...)`, crase ou aspas dentro dele deixa de ser
// configuração e vira comando rodando na inicialização do agente.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * O slug do agente, que vira nome de arquivo e nome de unidade do systemd.
 *
 * Ele não vem da tela (a tela não escolhe agente: o painel serve um só, o do
 * `config.json`), mas passa pela régua assim mesmo. Um `..` aqui viraria escrita
 * fora da pasta do cofre, com o privilégio do painel, que é root.
 */
const SLUG_OK = /^[a-z0-9-]{1,32}$/;

/**
 * O formato de um nome de variável de ambiente. É a régua de FORMA, e ela sozinha
 * não basta: ver `NOME_PERMITIDO` logo abaixo, que é a régua de SENTIDO.
 */
const NOME_FORMA_OK = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A LISTA DE PERMITIDOS DE NOME. Só passa nome que anuncia ser credencial de um
 * serviço externo, ou a outra metade de uma credencial.
 *
 * É uma lista de permitidos e não de proibidos de propósito, e o cabeçalho deste
 * arquivo explica o ataque que ela fecha.
 *
 * A SEGUNDA METADE DA LISTA CUSTOU UMA CONFERÊNCIA CONTRA AS 88 CHAVES REAIS do
 * vault do Danilo, e ela existe porque credencial quase sempre vem em PAR. Só com
 * os sufixos de "segredo" (`_API_KEY`, `_TOKEN`, `_SECRET`), doze chaves legítimas
 * ficavam de fora, entre elas `HOTMART_CLIENT_ID`, `KIWIFY_ACCOUNT_ID`,
 * `META_APP_ID`, `DATABASE_URL` e `TWILIO_ACCOUNT_SID`. Sem o `CLIENT_ID` o
 * `CLIENT_SECRET` sozinho não autentica em lugar nenhum: o dono cadastraria
 * metade da credencial, a integração falharia, e ele não teria como entender por
 * quê. Quebra calada é o modo de falha que este módulo inteiro tenta não ter.
 *
 * Quando um nome legítimo for recusado, a correção é acrescentar o sufixo aqui,
 * com uma linha dizendo por quê, e nunca afrouxar a régua. Para o caso pontual
 * existe `cofreNomesExtras` no `config.json`, que só quem administra a máquina
 * edita.
 */
const NOME_PERMITIDO = [
  // O segredo em si.
  /_API_KEY$/, /_API_TOKEN$/, /_TOKEN$/, /_SECRET$/, /_KEY$/, /_PASSWORD$/, /_WEBHOOK_URL$/,
  // A outra metade da credencial, e o endereço de onde ela vale.
  /_ID$/, /_SID$/, /_USERNAME$/, /_USER$/, /_ACCOUNT$/, /_URL$/, /_DSN$/, /_ENDPOINT$/,
  /_REGION$/, /_BUCKET$/, /_PROJECT$/, /_ORG$/, /_VERSION$/, /_EMAIL$/,
  // Nome oficial de credencial que não termina em nenhum sufixo acima.
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
];

/**
 * CINTO E SUSPENSÓRIO: nomes recusados mesmo que casem com a lista de permitidos.
 *
 * Isto NÃO substitui a lista de permitidos e não contradiz a lição de 18/08. A
 * allowlist continua sendo A defesa; esta lista é a redundância para o dia em que
 * alguém acrescentar um sufixo à `NOME_PERMITIDO` sem pensar em execução de
 * código, e esse dia chega.
 *
 * `LD_` e `DYLD_` carregam biblioteca antes do programa. `NODE_`, `PYTHON`,
 * `PERL`, `RUBY` e `BASH_` mandam o interpretador executar arquivo escolhido por
 * quem escreveu a variável (`NODE_OPTIONS=--require`, `BASH_ENV`, `PYTHONSTARTUP`).
 * `GIT_` cobre `GIT_SSH_COMMAND` e `GIT_EXTERNAL_DIFF`, que são o mesmo truque com
 * outro nome.
 *
 * OS DOIS ÚLTIMOS EXATOS NÃO EXECUTAM NADA, e é por isso que eles são fáceis de
 * esquecer numa lista pensada só em execução de código: `SSL_CERT_FILE` e
 * `NODE_EXTRA_CA_CERTS` movem a âncora de confiança de TLS do agente para um
 * certificado escolhido pelo dono, que é como se lê o tráfego cifrado dele
 * inteiro sem rodar uma linha de código.
 */
const NOME_PREFIXO_PROIBIDO = ['LD_', 'DYLD_', 'NODE_', 'PYTHON', 'PERL', 'RUBY', 'GIT_', 'BASH_', 'NPM_', 'CLAUDE_'];
/**
 * A ÚNICA EXCEÇÃO ao prefixo `CLAUDE_`, consultada ANTES dele.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` é o token de longa duração que o próprio Claude Code
 * gera com `claude setup-token`, o fluxo oficial da Anthropic para usar a
 * assinatura sem copiar o `.credentials.json` entre contêineres. A cópia do
 * arquivo derrubava o login: quando um dos contêineres renovava o token, o outro
 * ficava com um token já trocado. Este nome não executa nada nem muda o
 * comportamento do binário, só entrega a credencial.
 *
 * O RESTO DO PREFIXO CONTINUA PROIBIDO, porque `CLAUDE_CONFIG_DIR`,
 * `CLAUDE_CODE_USE_BEDROCK` e companhia mudam o jeito como o binário roda.
 * Esta lista é exata de propósito: acrescentar um nome aqui é uma decisão a ser
 * escrita com o motivo, nunca um padrão.
 */
const NOME_EXATO_LIBERADO = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

const NOME_EXATO_PROIBIDO = new Set([
  'PATH', 'HOME', 'ENV', 'IFS', 'PS4', 'SHELL', 'SHELLOPTS', 'TMPDIR',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
]);

/**
 * Nomes que o provisionamento do runner já escreve, e que o cofre nunca pode
 * ocupar (regra 10).
 *
 * Se um deles fosse cadastrado, o `provisionar-runner.mjs` o reescreveria no
 * próximo provisionamento e o segredo sumiria em silêncio, que é exatamente o
 * modo de falha que a regra 7 existe para evitar. Nenhum deles passaria na
 * `NOME_PERMITIDO` de qualquer forma; a lista está aqui para que a RECUSA seja
 * explicada com o motivo certo, em vez de um "nome não aceito" genérico.
 */
const RESERVADOS = new Set([
  'RUNNER_AGENT_FILE', 'RUNNER_PORT', 'RUNNER_LOG', 'HOME', 'PATH', 'CLAUDE_CONFIG_DIR',
]);

/**
 * O que um valor de segredo pode conter: caractere imprimível de ASCII, MENOS a
 * aspa simples.
 *
 * Chave de API é ASCII. O que esta régua barra primeiro é o acidente: quebra de
 * linha colada junto (que quebraria o arquivo de ambiente em duas linhas, e a
 * segunda viraria uma variável que ninguém cadastrou), caractere de controle e
 * byte nulo. O teto de 4096 é folgado para qualquer chave de serviço e barra
 * alguém colar um arquivo inteiro aqui por engano.
 *
 * A ASPA SIMPLES (\x27) SAI POR UM MOTIVO MEDIDO, e não por precaução vaga.
 * O arquivo gerado é lido por DOIS leitores diferentes: o `EnvironmentFile=` do
 * systemd e o `.` do bash. Os dois entendem aspas simples do mesmo jeito, e
 * também leem igual barra invertida, aspas duplas, cifrão, crase e espaço lá
 * dentro (conferido nesta máquina, systemd 255). O que eles NÃO entendem igual é
 * uma aspa simples DENTRO do valor: o jeito POSIX de escrevê-la (`'\''`) é do
 * bash, e o systemd lê aquilo ao pé da letra. O bash receberia `a'b` e o systemd
 * receberia `a''b'`, ou seja, o mesmo arquivo daria duas chaves diferentes
 * conforme a forma do agente, e o sintoma seria um "não autorizado" que só
 * acontece num dos dois tipos de agente.
 *
 * Chave de serviço não tem apóstrofo. Custa barrar isso: nada. Custa não barrar:
 * uma falha que muda conforme o agente, que é o tipo mais caro de perseguir.
 */
const VALOR_OK = /^[\x20-\x26\x28-\x7E]{8,4096}$/;

/**
 * O catálogo de provedores.
 *
 * `onde` existe por causa da regra 11: quem cadastra a chave é o dono do agente,
 * e ele pode nunca ter gerado uma chave de API na vida. Mandar a pessoa
 * "pegar a chave no painel do provedor" sem dizer onde é meia instrução.
 */
const PROVEDORES = [
  { id: 'openai', nome: 'OpenAI', sugestao: 'OPENAI_API_KEY', onde: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', nome: 'Anthropic (Claude)', sugestao: 'ANTHROPIC_API_KEY', onde: 'https://console.anthropic.com/settings/keys' },
  { id: 'google', nome: 'Google (Gemini)', sugestao: 'GEMINI_API_KEY', onde: 'https://aistudio.google.com/apikey' },
  { id: 'elevenlabs', nome: 'ElevenLabs', sugestao: 'ELEVENLABS_API_KEY', onde: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'xai', nome: 'xAI (Grok)', sugestao: 'XAI_API_KEY', onde: 'https://console.x.ai' },
  // Não é chave de API: é a assinatura do Claude. `onde` é nulo porque o token não
  // sai de um site, sai de um comando; a `dica` diz qual, e a tela a mostra.
  { id: 'claude-assinatura', nome: 'Claude (assinatura, token do setup-token)', sugestao: 'CLAUDE_CODE_OAUTH_TOKEN', onde: null,
    dica: 'Este token não sai de um site. Num terminal da sua máquina, com o Claude Code instalado e logado na sua assinatura, rode "claude setup-token" e cole aqui o token que ele imprimir.' },
  { id: 'outro', nome: 'Outro serviço', sugestao: '', onde: null },
];

/** Erro com motivo em português e o status que a rota vai devolver. */
function recusa(erro, status, howToFix) {
  const r = { erro, status: status || 400 };
  if (howToFix) r.howToFix = howToFix;
  return r;
}

/**
 * Valor virando linha de arquivo de ambiente, em aspas SIMPLES.
 *
 * Aspas simples é a única forma que o systemd e o bash entendem do mesmo jeito,
 * porque nenhum dos dois expande nada lá dentro. Aspas duplas deixariam o bash
 * expandir `$` e crase, e aí o valor de um segredo poderia virar comando na
 * inicialização do agente.
 *
 * NÃO EXISTE ESCAPE AQUI, DE PROPÓSITO. Escapar aspa simples dentro de aspas
 * simples só tem um jeito, o `'\''` do POSIX, e ele é do bash: o systemd leria
 * aquilo ao pé da letra e entregaria outro valor. Em vez de gerar uma linha que
 * significa duas coisas, a aspa simples é recusada lá na entrada (`VALOR_OK`, e o
 * porquê está escrito lá). A conferência abaixo é a segunda tranca, para o caso
 * de alguém alargar a `VALOR_OK` sem ler o comentário dela.
 */
function linhaDeAmbiente(nome, valor) {
  const v = String(valor);
  if (v.includes("'") || /[\n\r\0]/.test(v)) {
    throw new Error('valor com aspa simples ou quebra de linha não pode virar linha de ambiente');
  }
  return `${nome}='${v}'`;
}

// ─── A cifragem ──────────────────────────────────────────────────────────────
//
// DOIS MOTORES, e o store guarda em qual deles cada segredo foi cifrado, para que
// uma máquina que ganhe o motor bom depois não perca o que já estava guardado.
//
//   `systemd-creds` (preferido): a chave mestra é a do host, em
//     /var/lib/systemd/credential.secret, modo 0400 root. Um `tar` da pasta do
//     agente leva o segredo cifrado e NÃO leva a chave, que é justamente o que a
//     regra 3 pede.
//
//   `local` (alternativa): AES-256-GCM com chave num arquivo separado, fora da
//     pasta do cofre. Protege contra quem lê o store e não protege contra uma
//     cópia da pasta inteira do agente. É pior, e por isso o `estado()` conta
//     qual dos dois está em uso, e a tela mostra.

function temSystemdCreds() {
  try {
    execFileSync('systemd-creds', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A validação inteira de uma chave que vai ser guardada, sem tocar em disco.
 *
 * Existe separada para que o painel (`guardar` abaixo) e o DG Claw Web, que na v1 é
 * quem grava no host, recusem EXATAMENTE as mesmas coisas, com as mesmas frases.
 * Duas cópias desta régua divergem no primeiro ajuste. `extras` é o conjunto de
 * nomes liberados à mão por quem administra a máquina (`cofreNomesExtras`).
 *
 * Devolve `{ nome, valor, provedor }` quando passa, ou o objeto de recusa
 * `{ erro, status, howToFix }`. A recusa nunca repete o valor.
 */
function validarChave(pedido, extras) {
  const EXTRAS = extras || new Set();
  const nome = String((pedido && pedido.envName) || '').trim().toUpperCase();
  const valor = typeof (pedido && pedido.valor) === 'string' ? pedido.valor.trim() : '';
  const provedor = String((pedido && pedido.provedor) || 'outro');

  if (!nome) {
    return recusa('Faltou o nome da variável, que é como o agente encontra a chave.', 400,
      'Escolha o serviço na lista: ele preenche o nome certo sozinho.');
  }
  if (!NOME_FORMA_OK.test(nome)) {
    return recusa(
      `"${nome}" não serve como nome de variável. Ele precisa começar com letra maiúscula e ter só letras maiúsculas, números e sublinhado.`,
      400,
      'Escolha o serviço na lista acima, que já traz o nome no formato certo.',
    );
  }
  if (RESERVADOS.has(nome)) {
    return recusa(
      `"${nome}" é um nome que o próprio sistema usa para dizer ao agente onde ele mora e por onde ele roda, então o cofre não pode ocupá-lo.`,
      409,
      'Se o serviço exige exatamente esse nome, fale com quem administra a máquina do agente: isso precisa de outro caminho.',
    );
  }
  // O deny vem ANTES do allow: um nome que case com os dois é recusado, que é o
  // ponto inteiro de ele existir.
  if (NOME_EXATO_PROIBIDO.has(nome) ||
      (!NOME_EXATO_LIBERADO.has(nome) && NOME_PREFIXO_PROIBIDO.some((p) => nome.startsWith(p)))) {
    return recusa(
      `"${nome}" não é uma chave de serviço: é um nome que muda o jeito como o próprio agente roda, ` +
      'e por isso o cofre não guarda nenhum com esse começo.',
      400,
      'Se o serviço que você está ligando exige exatamente esse nome, fale com quem administra a máquina do agente: ' +
      'esse caso precisa ser avaliado um por um, e não pela tela.',
    );
  }
  if (!NOME_PERMITIDO.some((re) => re.test(nome)) && !EXTRAS.has(nome)) {
    return recusa(
      `"${nome}" não parece nome de chave de serviço, e este campo só aceita chave de serviço.`,
      400,
      'Nome de credencial costuma terminar em _API_KEY, _TOKEN, _SECRET, _KEY, _PASSWORD, _ID, _URL ou _ACCOUNT. ' +
      'Escolher o serviço na lista acima preenche o nome certo. ' +
      'Se o seu serviço usa mesmo um nome fora desse padrão, ele pode ser liberado: peça a quem administra a máquina do agente, ' +
      'que é quem consegue avaliar se aquele nome é inofensivo.',
    );
  }
  if (!valor) {
    return recusa('Faltou a chave. Nada foi alterado no cofre.', 400,
      'Cole a chave que você gerou no painel do serviço.');
  }
  if (!VALOR_OK.test(valor)) {
    // A recusa NÃO REPETE O VALOR, nem um pedaço dele. Ver regra 5.
    return recusa(
      'Essa chave tem caractere que não pode entrar aqui, ou é curta demais (menos de 8 caracteres). ' +
      'Quebra de linha, acento, apóstrofo e caractere invisível costumam vir junto quando a chave é copiada ' +
      'de um PDF, de uma mensagem ou de um site que troca aspas por aspas curvas.',
      400,
      'Copie a chave direto do painel do serviço, sem selecionar o espaço em volta, e cole de novo.',
    );
  }
  // Referência de outro cofre ("vault:..."): só vale atrás do proxy que a troca pela
  // chave verdadeira. Guardada aqui, o agente receberia um texto que nenhum serviço aceita.
  if (/^vault:/i.test(valor)) {
    return recusa(
      'Isso é uma referência de cofre (começa com "vault:"), e não a chave. Dentro do agente ela não vale nada.',
      400,
      'Pegue a chave verdadeira na fonte onde ela fica guardada (ou no painel do serviço) e mande essa.',
    );
  }

  return { nome, valor, provedor };
}

// ─── O modo "host" (DG Claw v1) ──────────────────────────────────────────────
//
// Na v1 o agente roda num contêiner e quem guarda a chave é o DG Claw Web, no host,
// num arquivo que o agente não alcança (`web/lib/cofre-agente.js`). Este painel, de
// dentro, só consegue LER os nomes das chaves (o Web os escreve em
// `/run/dgclaw/config/cofre-nomes`, pasta montada só para leitura).
//
// POR QUE RECUSAR EM VEZ DE CAIR NO MOTOR LOCAL: o motor local guarda a chave
// mestra na casa do agente, e o agente a lê. Chave cifrada com uma chave que está
// ao lado dela não está guardada, está escondida. Uma versão anterior fez isso sem
// querer (o cofre do host dava EACCES e o painel guardou `OPENAI_API_KEY.enc` mais
// `cofre.chave` na casa). Neste modo NADA é escrito em disco: nem pasta, nem chave
// mestra, nem arquivo de segredo.
function buildCofreHost(config, arquivoDeNomes) {
  const slug = String(config.agentSlug || 'agente');

  function recusaDoHost() {
    return recusa(
      'Neste agente quem guarda a chave e reinicia o agente é o DG Claw Web, e não este painel. Nada foi guardado.',
      409,
      'Abra o painel pelo endereço do DG Claw (o do site, com o login), e não pela porta direta do painel. ' +
      'Quem administra o servidor também pode usar "dgclaw agente cofre <agente> guardar NOME" nele.',
    );
  }

  /** Os nomes das chaves ativas, na ordem do arquivo. Arquivo ausente = nenhuma chave. */
  function nomes() {
    let texto;
    try {
      texto = fs.readFileSync(arquivoDeNomes, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      console.error(`[cofre:${slug}] não consegui ler a lista de nomes ${arquivoDeNomes} (${err.code || err.message}); mostro o cofre como vazio.`);
      return [];
    }
    const vistos = [];
    for (const linha of texto.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,63})=/.exec(linha);
      if (m && !vistos.includes(m[1])) vistos.push(m[1]);
    }
    return vistos;
  }

  function estado() {
    return {
      agente: { slug, nome: config.agentName || slug, dono: config.creatorName || 'Dono' },
      chaves: nomes().map((n) => ({
        envName: n,
        provedor: 'outro',
        provedorNome: (PROVEDORES.find((p) => p.sugestao === n) || {}).nome || 'Outro serviço',
        ultimos4: '',
        cadastradaPor: 'DG Claw Web',
        origem: 'host',
        cadastradaEm: null,
        revogadaEm: null,
        motor: 'host',
      })),
      provedores: PROVEDORES,
      guarda: {
        motor: 'host',
        motorExplicacao: 'A chave fica num arquivo do servidor, fora da pasta do agente, que só o administrador da máquina lê. O agente recebe o valor quando é reiniciado.',
        emMemoria: false,
        emMemoriaExplicacao: 'Aqui este painel só mostra os nomes das chaves. Guardar e reiniciar são feitos pelo DG Claw Web.',
      },
      aplicar: {
        pode: false,
        motivo: 'Neste agente quem guarda a chave e reinicia o agente é o DG Claw Web.',
        howToFix: 'Abra o painel pelo endereço do DG Claw (o do site, com o login) para guardar a chave e aplicar.',
      },
      arquivoDeAmbiente: '/run/dgclaw/cofre/cofre.env',
    };
  }

  function tem(envName) {
    const nome = String(envName || '').trim().toUpperCase();
    return NOME_FORMA_OK.test(nome) && nomes().includes(nome);
  }

  return {
    modoHost: true,
    recusaDoHost,
    estado, tem,
    guardar: recusaDoHost, revogar: recusaDoHost, aplicar: recusaDoHost, materializar: recusaDoHost,
    DIR: null, ENV_DO_AGENTE: null, PROVEDORES, EXTRAS: new Set(),
  };
}

function buildCofre(config) {
  const NOMES_HOST = config.cofreNomesArquivo || process.env.DGCLAW_COFRE_NOMES || null;
  if (NOMES_HOST) return buildCofreHost(config, String(NOMES_HOST));
  const slug = String(config.agentSlug || 'agente');
  const AGENTE = config.agentDir;

  // Onde mora o cofre deste agente. Fica ao lado do resto da configuração dele
  // (`.dgclaw/`), que é a mesma pasta onde a credencial do Claude já vive, e
  // FORA da raiz da aba Pasta (`<agentDir>/arquivos`): quem abre o painel não
  // navega até aqui, nem de propósito nem por engano.
  const DIR = config.cofreDir || path.join(AGENTE, '.dgclaw', 'cofre');
  const CHAVES = path.join(DIR, 'chaves.json');
  const SEGREDOS = path.join(DIR, 'segredos');
  // A chave mestra do motor `local` mora FORA de DIR, de propósito: assim uma
  // cópia da pasta do cofre não leva junto o que abre a pasta do cofre.
  const CHAVE_MESTRA = config.cofreChaveMestra || path.join(AGENTE, '.dgclaw', 'cofre.chave');

  // O arquivo de ambiente que o agente lê. Nasce em tmpfs (`/run`), some no
  // reboot e nunca encosta no disco que vai para backup. Quando `/run` não
  // existe (máquina que não é Linux), cai para uma pasta local e o `estado()`
  // avisa, em vez de fingir que é a mesma coisa.
  const RUNTIME_TMPFS = fs.existsSync('/run');
  const RUNTIME_DIR = config.cofreRuntimeDir || (RUNTIME_TMPFS ? '/run/dgclaw' : path.join(AGENTE, '.dgclaw', 'run'));
  // `cofreArquivoAmbiente` dá o caminho inteiro quando quem monta o agente já
  // escolheu um nome (no DG Claw v1: `<casa>/cofre/cofre.env`, numa PASTA montada só
  // leitura no contêiner; montar o arquivo solto prenderia o contêiner ao inode velho).
  const ENV_DO_AGENTE = config.cofreArquivoAmbiente
    ? String(config.cofreArquivoAmbiente)
    : path.join(RUNTIME_DIR, `${slug}.env`);
  const PASTA_DO_ENV = path.dirname(ENV_DO_AGENTE);

  const MOTOR = temSystemdCreds() ? 'systemd-creds' : 'local';

  /**
   * A saída para o nome legítimo que a lista de permitidos não previu.
   *
   * Vem do `config.json`, que o painel LÊ e nunca escreve: quem libera um nome é
   * quem administra a máquina do agente, e não o dono do agente pela tela. Sem
   * isto a lista estreita viraria parede, e a pessoa ficaria sem caminho nenhum
   * na frente de uma integração que ela precisa ligar hoje.
   *
   * O deny (`NOME_EXATO_PROIBIDO` / `NOME_PREFIXO_PROIBIDO`) continua valendo por
   * cima disto: nem o administrador libera `NODE_OPTIONS` por aqui.
   */
  const EXTRAS = new Set(
    (Array.isArray(config.cofreNomesExtras) ? config.cofreNomesExtras : [])
      .map((n) => String(n).trim().toUpperCase())
      .filter((n) => NOME_FORMA_OK.test(n)),
  );

  function garantirPastas() {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(SEGREDOS, { recursive: true, mode: 0o700 });
    // `mkdirSync` só aplica o modo na criação. Um cofre que veio de uma versão
    // anterior, ou de um `umask` diferente, é corrigido aqui em vez de continuar
    // frouxo para sempre.
    try { fs.chmodSync(DIR, 0o700); } catch { /* sistema de arquivos sem modo */ }
    try { fs.chmodSync(SEGREDOS, 0o700); } catch { /* idem */ }
  }

  function chaveMestra() {
    try {
      const k = fs.readFileSync(CHAVE_MESTRA);
      if (k.length === 32) return k;
    } catch { /* ainda não existe */ }
    const nova = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(CHAVE_MESTRA), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CHAVE_MESTRA, nova, { mode: 0o600 });
    try { fs.chmodSync(CHAVE_MESTRA, 0o600); } catch { /* idem */ }
    return nova;
  }

  /** Texto puro entrando, blob cifrado saindo. Devolve `{ motor, blob }`. */
  function cifrar(nome, valor) {
    if (MOTOR === 'systemd-creds') {
      try {
        const blob = execFileSync(
          'systemd-creds',
          ['encrypt', '--name', nome, '--with-key=host', '-', '-'],
          // `stdio` com stderr em `pipe` e não herdado: o systemd-creds escreve
          // avisos de rotina na saída de erro ("não está em mídia cifrada"), e
          // herdada ela iria parar no log do painel a cada gravação, virando
          // ruído que esconde o aviso que importa. Em caso de falha o texto vem
          // dentro do erro, e o `registrarFalha` o mostra.
          { input: valor, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { motor: 'systemd-creds', blob };
      } catch (err) {
        // Cai para o motor local em vez de recusar a gravação: o dono do agente
        // não tem como consertar systemd nenhum, e uma chave guardada de um jeito
        // pior é melhor do que uma tela que não deixa guardar. O `estado()` conta
        // qual motor guardou cada uma, então isso não vira segredo de ninguém.
        registrarFalha('cifrar com systemd-creds', err);
      }
    }
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', chaveMestra(), iv);
    const dados = Buffer.concat([c.update(valor, 'utf-8'), c.final()]);
    return { motor: 'local', blob: Buffer.concat([iv, c.getAuthTag(), dados]) };
  }

  /**
   * Blob cifrado entrando, texto puro saindo. Só a materialização chama.
   *
   * O `--name` NÃO É COSMÉTICO na decifragem. O nome vai cifrado junto com o
   * segredo, e passá-lo aqui faz o systemd-creds conferir se o blob é mesmo o
   * daquela variável. Sem ele, trocar o arquivo `OPENAI_API_KEY.enc` pelo
   * `DATABASE_URL.enc` passaria batido, e o agente sairia usando um segredo com o
   * nome de outro.
   */
  function decifrar(motor, blob, nome) {
    if (motor === 'systemd-creds') {
      return execFileSync(
        'systemd-creds',
        ['decrypt', '--name', nome, '-', '-'],
        { input: blob, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString('utf-8');
    }
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', chaveMestra(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf-8');
  }

  /**
   * O log de falha do cofre. NUNCA recebe valor de segredo, e é por isso que ele
   * é uma função e não um `console.error` solto: o único jeito de garantir que
   * ninguém vai passar o valor "só para depurar" é não existir um caminho que
   * aceite.
   */
  function registrarFalha(oQue, err) {
    const motivo = err && err.message ? err.message : String(err);
    // O que o programa externo escreveu na saída de erro entra aqui, porque é
    // ele que diz o motivo de verdade ("chave do host não existe", por exemplo).
    // Ele nunca contém o valor: o segredo vai pela entrada padrão, não pela
    // linha de comando.
    const dele = err && err.stderr ? ` ${String(err.stderr).trim()}` : '';
    console.error(`[cofre:${slug}] falhou ao ${oQue}: ${motivo}${dele}`);
  }

  // ─── Os metadados ──────────────────────────────────────────────────────────
  // NENHUM VALOR DE SEGREDO PASSA POR AQUI. O valor mora num arquivo por chave,
  // em `segredos/<NOME>.enc`, e o único caminho que o abre é a materialização.
  // Isso é mais do que disciplina: significa que não existe objeto neste módulo
  // com metadado e segredo juntos, então nenhuma rota consegue vazar um valor
  // por descuido de `res.json`.

  function lerChaves() {
    try {
      const dados = JSON.parse(fs.readFileSync(CHAVES, 'utf-8'));
      if (dados && Array.isArray(dados.chaves)) return dados;
    } catch { /* ainda não existe, ou está ilegível */ }
    return { schema: 1, chaves: [] };
  }

  function gravarChaves(dados) {
    garantirPastas();
    fs.writeFileSync(CHAVES, JSON.stringify(dados, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(CHAVES, 0o600); } catch { /* idem */ }
  }

  function arquivoDoSegredo(nome) {
    // `nome` já passou pela `NOME_FORMA_OK` antes de chegar aqui, então não tem
    // barra nem ponto. A conferência abaixo é a segunda tranca, para o caso de
    // alguém chamar esta função de um caminho novo sem validar antes.
    if (!NOME_FORMA_OK.test(nome)) throw new Error('nome de variável inválido');
    return path.join(SEGREDOS, `${nome}.enc`);
  }

  // ─── A forma do agente, e a unidade que precisa reiniciar ──────────────────

  function perguntarAoSystemd(args) {
    try {
      return execFileSync('systemctl', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (err) {
      // `is-enabled` e `is-active` saem com código diferente de zero quando a
      // resposta é "não", e escrevem a resposta na saída padrão assim mesmo. Sem
      // este ramo, "disabled" viraria "não sei", e a diferença entre as duas é o
      // que este módulo precisa saber.
      if (err && err.stdout) return String(err.stdout).trim();
      return '';
    }
  }

  /**
   * A unidade está no disco, E ela é a que manda no agente de verdade?
   *
   * ARQUIVO NO DISCO NÃO QUER DIZER AGENTE VIVO, e esta função existe por causa
   * de um caso concreto de uma VPS: `dgclaw-agent-ana.service` e
   * `dgclaw-agent-bento.service` continuam no disco depois do corte de
   * 02/09/2026, desabilitadas e paradas, porque a Ana e o Bento passaram a
   * rodar dentro de um contêiner. A versão anterior desta conferência só
   * perguntava se o arquivo existia, e para o systemd ele existe.
   *
   * O estrago que isso daria: o botão de aplicar chamaria `systemctl restart` na
   * unidade velha, ela SUBIRIA (com sucesso, sem erro nenhum), e passaria a
   * existir um segundo runner do mesmo agente, fora do contêiner, apontando para
   * a casa antiga. A tela mostraria o agente errado, e nada em lugar nenhum
   * acusaria o problema.
   */
  function unidadeUsavel(nome) {
    const habilitada = perguntarAoSystemd(['is-enabled', `${nome}.service`]);
    if (!habilitada || habilitada === 'not-found') return { existe: false };
    const ativa = perguntarAoSystemd(['is-active', `${nome}.service`]);
    const ligada = habilitada === 'enabled' || habilitada === 'static' || habilitada === 'enabled-runtime';
    return { existe: true, usavel: ligada && ativa === 'active', habilitada, ativa };
  }

  /**
   * Qual unidade reiniciar, e o que dizer quando não há nenhuma.
   *
   * O TERCEIRO CASO É O IMPORTANTE. A Ana e o Bento saíram desta VPS em
   * 02/09/2026 e passaram a rodar dentro de um contêiner. A unidade
   * `dgclaw-agent-<slug>` não existe mais aqui. Sem esta função, o botão de
   * aplicar chamaria um `systemctl restart` que falha, ou pior, que "dá certo"
   * sem reiniciar coisa nenhuma, e a tela diria ao dono que a chave nova já está
   * valendo. Reiniciar o nada e reportar sucesso é a pior resposta possível para
   * uma tela cuja regra 7 é justamente avisar que o agente precisa reiniciar.
   */
  function unidadeDoAgente() {
    if (!SLUG_OK.test(slug)) {
      return { erro: `O slug deste agente ("${slug}") tem caractere que eu não aceito em nome de unidade.` };
    }

    // 1. O que estiver escrito no config.json manda, e nem confere nada: quem
    //    escreve ali é quem administra a máquina, e ele sabe mais do que este
    //    palpite. É por aqui que o agente da jaula chega com o nome certo.
    if (config.cofreUnidade) {
      return { unidade: String(config.cofreUnidade).replace(/\.service$/, ''), forma: 'configurada' };
    }

    // 2. DENTRO DE UM CONTÊINER DA JAULA o agente é o único morador, e a unidade
    //    dele se chama `dgclaw-runner`, sem slug nenhum no nome. O painel de lá
    //    roda no mesmo systemd que o agente, então manda nela direto.
    if (fs.existsSync('/etc/systemd/system/dgclaw-runner.service')) {
      return { unidade: 'dgclaw-runner', forma: 'jaula' };
    }

    // 3. Fora dela, o palpite pelo nome. E ele confere se a unidade está
    //    HABILITADA E ATIVA, não só se o arquivo existe: ver `unidadeUsavel`.
    for (const [nome, forma] of [[`dgclaw-agent-${slug}`, 'runner'], [`dgclaw-${slug}`, 'plugin']]) {
      const u = unidadeUsavel(nome);
      if (u.usavel) return { unidade: nome, forma };
      if (u.existe) {
        // O caso da Ana e do Bento depois do corte de 02/09: o arquivo está
        // no disco, parado, e o agente vive em outro lugar. Dizer isso é muito
        // melhor do que "não achei", porque é a frase que faz a pessoa procurar
        // no lugar certo.
        return {
          erro:
            `Existe uma unidade "${nome}" nesta máquina, mas ela está ${u.habilitada === 'disabled' ? 'desabilitada' : u.habilitada} e ${u.ativa || 'parada'}, ` +
            'ou seja, não é ela que mantém este agente de pé. Reiniciá-la subiria uma segunda cópia do agente, no lugar errado, ' +
            'então eu prefiro não encostar nela.',
          howToFix:
            'A chave FOI guardada e continua guardada. Isso costuma acontecer quando o agente mudou de casa (foi para um contêiner, por exemplo) ' +
            'e a unidade antiga ficou no disco. Quem administra a máquina resolve escrevendo o nome da unidade certa em "cofreUnidade", ' +
            'no config.json deste painel.',
        };
      }
    }

    return {
      erro:
        `Não achei nesta máquina nenhuma unidade do agente "${slug}" para reiniciar. ` +
        'Isso costuma querer dizer que ele roda em outro lugar (dentro de um contêiner, por exemplo), ' +
        'e daí quem reinicia é quem administra esse lugar.',
      howToFix:
        'A chave FOI guardada e continua guardada. Peça a quem cuida da máquina do agente para reiniciá-lo, ' +
        'e a partir daí ela passa a valer.',
    };
  }

  // ─── O que a tela mostra ───────────────────────────────────────────────────

  /**
   * O estado do cofre: as chaves (sem valor nenhum), onde ele mora, como cifra e
   * se dá para reiniciar o agente daqui.
   */
  function estado() {
    const dados = lerChaves();
    const u = unidadeDoAgente();
    return {
      agente: { slug, nome: config.agentName || slug, dono: config.creatorName || 'Dono' },
      chaves: dados.chaves.map((c) => ({
        envName: c.envName,
        provedor: c.provedor || 'outro',
        provedorNome: (PROVEDORES.find((p) => p.id === c.provedor) || {}).nome || 'Outro serviço',
        ultimos4: c.ultimos4,
        cadastradaPor: c.cadastradaPor,
        // Registro antigo não tinha o campo: só havia a tela, então 'tela' é verdade.
        origem: c.origem || 'tela',
        cadastradaEm: c.cadastradaEm,
        revogadaEm: c.revogadaEm || null,
        motor: c.motor,
      })),
      provedores: PROVEDORES,
      // O que a tela precisa para contar a verdade sobre o guardado.
      guarda: {
        motor: MOTOR,
        motorExplicacao: MOTOR === 'systemd-creds'
          ? 'O segredo é cifrado com a chave desta máquina, que fica fora da pasta do agente. Uma cópia da pasta não leva o que abre o cofre.'
          : 'Esta máquina não tem o cofre do sistema, então o segredo é cifrado com uma chave guardada aqui mesmo, em arquivo separado. Protege de quem lê o arquivo do cofre, e não protege de quem copia a pasta inteira do agente.',
        emMemoria: RUNTIME_TMPFS,
        emMemoriaExplicacao: RUNTIME_TMPFS
          ? 'Na hora de usar, o segredo é escrito num arquivo que vive na memória da máquina e some quando ela desliga.'
          : 'Esta máquina não tem a pasta de memória do sistema, então o arquivo de uso fica no disco, dentro da pasta do agente.',
      },
      aplicar: u.erro ? { pode: false, motivo: u.erro, howToFix: u.howToFix } : { pode: true, unidade: u.unidade, forma: u.forma },
      arquivoDeAmbiente: ENV_DO_AGENTE,
    };
  }

  /**
   * Existe uma chave ATIVA com este nome? Só metadado: não abre o `.enc`, então
   * serve para o Admin perguntar "falta alguma?" sem que o valor chegue perto de
   * quem pergunta. Revogada conta como não.
   */
  function tem(envName) {
    const nome = String(envName || '').trim().toUpperCase();
    if (!NOME_FORMA_OK.test(nome)) return false;
    return lerChaves().chaves.some((c) => c.envName === nome && !c.revogadaEm);
  }

  // ─── Guardar ───────────────────────────────────────────────────────────────

  /**
   * Guarda uma chave. Substitui a que já existir com o mesmo nome.
   *
   * SUBSTITUIR É O CAMINHO CERTO AQUI, e é o oposto do que a aba Pasta faz com
   * upload. Lá, escrever por cima apagaria trabalho que o agente fez. Aqui, quem
   * cadastra `OPENAI_API_KEY` de novo está trocando a chave dele, que é a coisa
   * mais comum de se fazer depois de girar uma credencial. Recusar obrigaria a
   * revogar antes, e o agente ficaria sem chave nenhuma no meio do caminho.
   */
  function guardar(pedido) {
    const quem = String((pedido && pedido.quem) || config.creatorName || 'Dono').slice(0, 80);

    const v = validarChave(pedido, EXTRAS);
    if (v.erro) return v;
    const { nome, valor, provedor } = v;

    let cifrado;
    try {
      cifrado = cifrar(nome, valor);
    } catch (err) {
      registrarFalha('cifrar a chave', err);
      return recusa('Não consegui guardar a chave em segurança, então preferi não guardar de jeito nenhum.', 500,
        'Tente de novo. Se continuar, quem administra a máquina do agente precisa olhar o registro do painel.');
    }

    try {
      garantirPastas();
      fs.writeFileSync(arquivoDoSegredo(nome), cifrado.blob, { mode: 0o600 });
      try { fs.chmodSync(arquivoDoSegredo(nome), 0o600); } catch { /* idem */ }
    } catch (err) {
      registrarFalha('gravar o arquivo da chave', err);
      return recusa(`Não consegui gravar a chave no cofre: ${err.message}`, 500);
    }

    const dados = lerChaves();
    const agora = new Date().toISOString();
    const anterior = dados.chaves.find((c) => c.envName === nome);
    const registro = {
      envName: nome,
      provedor,
      ultimos4: valor.slice(-4),
      cadastradaPor: quem,
      origem: pedido && pedido.origem === 'api' ? 'api' : 'tela',
      cadastradaEm: agora,
      revogadaEm: null,
      motor: cifrado.motor,
    };
    if (anterior) Object.assign(anterior, registro);
    else dados.chaves.push(registro);

    try {
      gravarChaves(dados);
    } catch (err) {
      registrarFalha('gravar a lista de chaves', err);
      return recusa(`Não consegui anotar a chave na lista: ${err.message}`, 500);
    }

    return {
      ok: true,
      envName: nome,
      ultimos4: registro.ultimos4,
      trocada: !!anterior,
      // A regra 7 mora nesta frase: guardado não é valendo.
      aviso: anterior
        ? 'A chave foi trocada, mas o agente ainda está usando a antiga: ele só lê o cofre quando inicia.'
        : 'A chave foi guardada, mas o agente ainda não a tem: ele só lê o cofre quando inicia.',
    };
  }

  /**
   * Revogar é DATAR, não apagar (regra 6).
   *
   * O segredo sai do arquivo de ambiente na próxima materialização e o arquivo
   * cifrado é removido, porque guardar o valor de uma chave revogada seria
   * guardar risco sem utilidade nenhuma. O REGISTRO fica, com a data: é ele que
   * responde "quem pôs essa chave aqui, e quando ela saiu".
   */
  function revogar(envNameBruto, quem) {
    const nome = String(envNameBruto || '').trim().toUpperCase();
    if (!NOME_FORMA_OK.test(nome)) {
      return recusa('Nome de variável inválido, então não mexi em nada.', 400);
    }
    const dados = lerChaves();
    const registro = dados.chaves.find((c) => c.envName === nome);
    if (!registro) {
      return recusa(`Não achei nenhuma chave chamada "${nome}" neste cofre.`, 404);
    }
    if (registro.revogadaEm) {
      return recusa(`A chave "${nome}" já tinha sido revogada em ${registro.revogadaEm.slice(0, 10)}.`, 409);
    }

    try {
      fs.rmSync(arquivoDoSegredo(nome), { force: true });
    } catch (err) {
      registrarFalha('remover o arquivo da chave revogada', err);
      return recusa(`Não consegui remover a chave do cofre: ${err.message}`, 500);
    }

    registro.revogadaEm = new Date().toISOString();
    registro.revogadaPor = String(quem || config.creatorName || 'Dono').slice(0, 80);
    try {
      gravarChaves(dados);
    } catch (err) {
      registrarFalha('anotar a revogação', err);
      return recusa(`Não consegui anotar a revogação: ${err.message}`, 500);
    }

    return {
      ok: true,
      envName: nome,
      aviso:
        'A chave saiu do cofre, mas o agente ainda tem a antiga em uso: ela some do ambiente dele quando ele reiniciar. ' +
        'Se a chave vazou, revogue também no painel do serviço, que é o único lugar onde ela deixa de funcionar de verdade.',
    };
  }

  // ─── Materializar ──────────────────────────────────────────────────────────

  /**
   * Escreve o arquivo `KEY='valor'` que o agente lê ao iniciar.
   *
   * É O ÚNICO CAMINHO DESTE MÓDULO QUE DECIFRA ALGUMA COISA, e ele não devolve
   * valor nenhum para quem chamou: devolve quantas chaves entraram e onde o
   * arquivo ficou. Quem chama é o `bin/cofre-materializar.js`, no ExecStartPre da
   * unidade, e o `aplicar()` aqui embaixo.
   */
  function materializar() {
    const dados = lerChaves();
    const vivas = dados.chaves.filter((c) => !c.revogadaEm);
    const linhas = [
      `# Ambiente do agente ${config.agentName || slug} (${slug}), escrito pelo cofre do painel.`,
      '#',
      '# ARQUIVO GERADO: não edite à mão, porque ele é reescrito toda vez que o',
      '# agente inicia. Quem manda é a aba Cofre do painel.',
      '#',
      '# Cada linha é uma chave que o DONO deste agente cadastrou, e vale só para',
      '# este agente. Ver panel/lib/cofre.js e a nota de segurança do cofre.',
    ];
    const falhas = [];
    for (const c of vivas) {
      let valor;
      try {
        valor = decifrar(c.motor, fs.readFileSync(arquivoDoSegredo(c.envName)), c.envName);
      } catch (err) {
        // UMA CHAVE QUE NÃO ABRE NÃO PODE DERRUBAR AS OUTRAS, e também não pode
        // sumir calada: ela vai para `falhas`, e quem chamou decide o que fazer.
        // O que NUNCA acontece aqui é a linha virar vazia ou um valor de mentira,
        // porque aí o agente subiria com uma chave inválida e o erro apareceria
        // três dias depois, como um 401 sem explicação.
        registrarFalha(`abrir a chave ${c.envName}`, err);
        falhas.push(c.envName);
        continue;
      }
      linhas.push(linhaDeAmbiente(c.envName, valor));
    }

    try {
      fs.mkdirSync(PASTA_DO_ENV, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(PASTA_DO_ENV, 0o700); } catch { /* idem */ }
      // Escrita atômica NA MESMA PASTA (o rename só é atômico dentro do mesmo sistema
      // de arquivos): o agente nunca lê um arquivo pela metade, e quem monta a PASTA
      // no contêiner enxerga o arquivo novo.
      const tmp = path.join(PASTA_DO_ENV, `.${path.basename(ENV_DO_AGENTE)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.writeFileSync(tmp, linhas.join('\n') + '\n', { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* idem */ }
      try {
        const antes = fs.statSync(ENV_DO_AGENTE);
        if (typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(tmp, antes.uid, antes.gid);
      } catch { /* primeira vez: o arquivo ainda não existe, fica com o dono de quem escreve */ }
      fs.renameSync(tmp, ENV_DO_AGENTE);
    } catch (err) {
      registrarFalha('escrever o arquivo de ambiente', err);
      return recusa(`Não consegui escrever o arquivo que o agente lê: ${err.message}`, 500);
    }

    return { ok: true, arquivo: ENV_DO_AGENTE, chaves: vivas.length - falhas.length, falhas };
  }

  /**
   * Materializa e reinicia o agente, que é o que faz a chave passar a valer
   * (regra 7).
   *
   * Reinicia SÓ a unidade deste agente. E quando não há unidade nesta máquina,
   * diz isso com todas as letras em vez de inventar um sucesso.
   */
  function aplicar() {
    const m = materializar();
    if (m.erro) return m;

    const u = unidadeDoAgente();
    if (u.erro) {
      return {
        ok: false,
        materializou: true,
        chaves: m.chaves,
        falhas: m.falhas,
        erro: u.erro,
        howToFix: u.howToFix,
        status: 409,
      };
    }

    // O painel roda como o usuário do agente, e `systemctl restart` pede root. Dentro
    // do contêiner esse usuário tem `sudo` sem senha, então a segunda tentativa é por
    // `sudo -n` (o -n nunca para esperando senha: sem permissão, falha na hora).
    const servico = `${u.unidade}.service`;
    const comoRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const tentativas = comoRoot ? [['systemctl', ['restart', servico]]]
      : [['systemctl', ['restart', servico]], ['sudo', ['-n', 'systemctl', 'restart', servico]]];
    let ultimoErro = null;
    for (const [cmd, args] of tentativas) {
      try {
        execFileSync(cmd, args, { stdio: 'ignore' });
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
      }
    }
    if (ultimoErro) {
      registrarFalha(`reiniciar ${u.unidade}`, ultimoErro);
      return recusa(
        `As chaves foram preparadas, mas o agente não reiniciou (${ultimoErro.message}).`,
        500,
        `O painel roda sem permissão para reiniciar "${u.unidade}". Quem administra a máquina reinicia o agente ` +
        `(ou dá ao usuário do painel permissão de "sudo systemctl restart ${servico}") e confere o motivo com "systemctl status ${u.unidade}".`,
      );
    }

    return {
      ok: true,
      unidade: u.unidade,
      chaves: m.chaves,
      falhas: m.falhas,
      // A frase que a tela mostra. Ela diz o que ACONTECEU, e não "sucesso".
      feito: `O agente foi reiniciado e leu o cofre. ${m.chaves === 1 ? 'A chave que está no cofre agora vale' : `As ${m.chaves} chaves que estão no cofre agora valem`} para ele.`,
    };
  }

  return {
    estado, tem, guardar, revogar, materializar, aplicar,
    // Exportados para o teste e para o script de materialização.
    DIR, ENV_DO_AGENTE, PROVEDORES, EXTRAS,
  };
}

module.exports = {
  buildCofre,
  NOME_FORMA_OK, NOME_PERMITIDO, NOME_PREFIXO_PROIBIDO, NOME_EXATO_PROIBIDO, NOME_EXATO_LIBERADO,
  RESERVADOS, VALOR_OK, SLUG_OK, PROVEDORES, linhaDeAmbiente, validarChave, recusa,
};
