// cofre-regras.js: as regras do cofre (o que pode virar variavel de ambiente de um processo
// que roda como root). Sem disco e sem efeito colateral: so validacao e formatacao.
// O desenho e o porque de cada recusa estao no cabecalho de cofre.js.


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
 * A SEGUNDA METADE DA LISTA CUSTOU UMA CONFERÊNCIA CONTRA AS 88 CHAVES REAIS de
 * um vault de produção, e ela existe porque credencial quase sempre vem em PAR. Só com
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
  { id: 'groq', nome: 'Groq (grátis, transcrição de áudio)', sugestao: 'GROQ_API_KEY', onde: 'https://console.groq.com/keys' },
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

module.exports = {
  NOME_FORMA_OK, NOME_PERMITIDO, NOME_PREFIXO_PROIBIDO, NOME_EXATO_PROIBIDO, NOME_EXATO_LIBERADO,
  RESERVADOS, VALOR_OK, SLUG_OK, PROVEDORES, linhaDeAmbiente, validarChave, recusa,
};
