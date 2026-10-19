// cofre.js: a aba Cofre: onde o dono do agente guarda a chave de um serviço.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  O QUE ENTRA AQUI VIRA VARIÁVEL DE AMBIENTE DE UM PROCESSO QUE RODA       ║
// ║  COMO ROOT. Cada recusa deste arquivo existe por causa disso.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// O caso concreto que pediu esta tela: um agente de cliente
// precisava de uma chave da OpenAI para gerar capa de YouTube. Sem esta aba, a
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
// como root, na máquina do dono. `LD_PRELOAD` faz o mesmo com qualquer binário,
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
const regras = require('./cofre-regras');
const { criarCifra } = require('./cofre-cifra');
const { buildCofreHost } = require('./cofre-host');
const { criarUnidade } = require('./cofre-unidade');

const { NOME_FORMA_OK, PROVEDORES, linhaDeAmbiente, validarChave, recusa } = regras;

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

  const { MOTOR, garantirPastas, cifrar, decifrar, registrarFalha } = criarCifra({ slug, DIR, SEGREDOS, CHAVE_MESTRA });
  const { unidadeDoAgente } = criarUnidade({ slug, config });

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
  NOME_FORMA_OK: regras.NOME_FORMA_OK,
  NOME_PERMITIDO: regras.NOME_PERMITIDO,
  NOME_PREFIXO_PROIBIDO: regras.NOME_PREFIXO_PROIBIDO,
  NOME_EXATO_PROIBIDO: regras.NOME_EXATO_PROIBIDO,
  NOME_EXATO_LIBERADO: regras.NOME_EXATO_LIBERADO,
  RESERVADOS: regras.RESERVADOS,
  VALOR_OK: regras.VALOR_OK,
  SLUG_OK: regras.SLUG_OK,
  PROVEDORES: regras.PROVEDORES,
  linhaDeAmbiente: regras.linhaDeAmbiente,
  validarChave: regras.validarChave,
  recusa: regras.recusa,
};
