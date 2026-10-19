// cofre-unidade.js: descobre qual unidade do systemd reiniciar para a chave nova passar a valer.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { SLUG_OK } = require('./cofre-regras');

function criarUnidade({ slug, config }) {
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
   * de um caso concreto de uma VPS: duas unidades `dgclaw-agent-<slug>.service`
   * continuaram no disco depois do corte de 02/09/2026, desabilitadas e paradas,
   * porque os dois agentes passaram a rodar dentro de um contêiner. A versão anterior desta conferência só
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
   * O TERCEIRO CASO É O IMPORTANTE. Dois agentes saíram desta VPS em
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
        // O caso dos dois agentes depois do corte de 02/09: o arquivo está
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

  return { unidadeDoAgente };
}

module.exports = { criarUnidade };
