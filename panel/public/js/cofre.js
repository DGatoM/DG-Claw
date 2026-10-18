// cofre.js — a tela da aba Cofre.
//
// O QUE ELA MOSTRA: as chaves de serviço que o dono deste agente cadastrou, para
// que ele possa usar coisas que se pagam à parte (gerar imagem, transcrever
// áudio, publicar em algum lugar). As outras abas contam o que o agente é e o que
// ele fez; esta dá a ele uma chave.
//
// TRÊS COISAS QUE ESTA TELA PRECISA DIZER, e que não são detalhe de implementação:
//
//   1. A CHAVE É DE QUEM CADASTRA, E A FATURA TAMBÉM. Foi decisão do mantenedor em
//      07/09/2026, e ela resolveu de graça o pior cenário: chave dele num agente
//      de terceiro, com um limite de gasto mal configurado, viraria prejuízo dele
//      por uso alheio. Quem gera a chave é o dono do agente, na conta dele.
//   2. GUARDAR NÃO É VALER. O agente lê o cofre quando inicia, então a chave nova
//      só passa a existir para ele depois do botão de aplicar. Sem esta frase na
//      tela, o modo de falha é um "não autorizado" três dias depois, que ninguém
//      liga a esta tela.
//   3. DEPOIS DE GUARDADA, A CHAVE NÃO VOLTA. Nem para o dono, nem para o painel.
//      A tela mostra os quatro últimos caracteres e mais nada. Quem perdeu a
//      chave gera outra no provedor.
//
// A LISTA DE RECUSAS DE NOME MORA NO SERVIDOR, em `lib/cofre.js`, e o motivo de
// cada uma está lá. Aqui a tela só mostra a frase que o servidor mandou: duplicar
// a régua no navegador criaria duas versões dela, e um dia elas discordam.
//
// Igual à aba Pasta, este arquivo NÃO usa o `API.get`: aquele wrapper devolve
// `null` quando a resposta não é 200, e com isso morre o motivo que o servidor
// escreveu. Numa tela de credencial, "não funcionou" sem dizer o quê é pior ainda
// do que nas outras.

(function () {
  const BASE = window.DGCLAW_BASE || '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function quando(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    // Fuso do navegador, como o resto do painel: o ISO do servidor vem em UTC.
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /** Chamada que preserva o corpo do erro. Devolve {ok, status, corpo}. */
  async function chamar(url, opcoes) {
    let res;
    try {
      res = await fetch(BASE + url, opcoes);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  }

  function motivoDoErro(r) {
    const c = r.corpo || {};
    if (c.error && c.howToFix) return `${c.error} ${c.howToFix}`;
    return c.error || `O painel respondeu ${r.status}.`;
  }

  // ─── Tutorial da tela ───────────────────────────────────────────────────
  // Regra do repo: nenhuma tela nasce muda. Cada passo responde o que é, como a
  // conta é feita e por que aquilo está aqui.

  function passosDoTutorial() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'Aqui você dá uma chave ao agente',
        corpo: 'Alguns trabalhos dependem de um serviço que se paga à parte: gerar uma imagem, transcrever um áudio, publicar em algum lugar. Para usar esses serviços o agente precisa de uma chave, que é uma senha comprida que o serviço te dá. É ela que fica guardada aqui.',
        porque: 'Antes desta tela, dar uma chave ao agente exigia alguém com acesso à máquina editando arquivo à mão. Agora é um campo, e a chave fica guardada cifrada em vez de escrita em texto puro num arquivo de configuração.',
      },
      {
        chave: 'conta',
        alvo: '#cofre-root .cofre-conta',
        titulo: 'A chave é sua, e a conta também',
        corpo: 'Quem gera a chave é você, no site do serviço, com o seu cadastro. O que o agente gastar usando essa chave é cobrado de você, direto pelo serviço. O painel não intermedeia pagamento nenhum.',
        porque: 'Se a chave fosse de outra pessoa, o seu agente estaria gastando o dinheiro dela sem que ela visse o consumo. Com a chave no seu nome você enxerga o gasto, define limite e revoga quando quiser, tudo no painel do próprio serviço.',
      },
      {
        chave: 'lista',
        alvo: '#cofre-root .cofre-lista',
        titulo: 'O que está guardado',
        corpo: 'Uma linha por chave: o serviço, o nome pelo qual o agente a encontra, os quatro últimos caracteres, quem cadastrou e quando. Os quatro últimos servem para você conferir que é a chave certa sem precisar ver a chave.',
        porque: 'A chave nunca mais aparece inteira, nem para você, nem para quem administra a máquina. Uma tela que devolvesse a chave em texto seria um jeito novo de ela vazar, e não existe motivo bom para ler de volta uma chave que você já tem no seu provedor.',
      },
      {
        chave: 'nova',
        alvo: '#cofre-root .cofre-nova',
        titulo: 'Guardar uma chave',
        corpo: 'Escolha o serviço na lista: ela preenche sozinha o nome pelo qual o agente procura a chave, e mostra o endereço onde você gera essa chave no site do serviço. Depois cole a chave no campo e clique em guardar.',
        porque: 'O nome não é decoração: é por ele que o agente encontra a chave. Escolher o serviço na lista evita o erro mais comum, que é cadastrar a chave certa com um nome que o agente nunca vai procurar.',
      },
      {
        chave: 'aplicar',
        alvo: '#cofre-root .cofre-aplicar',
        titulo: 'Guardar não é o mesmo que valer',
        corpo: 'O agente lê o cofre uma vez só, quando inicia. Enquanto você não clicar aqui, ele continua trabalhando com o que tinha antes. Este botão reinicia o agente, e a partir daí a chave nova vale. Ele volta na mesma conversa, de onde parou; o terminal dele só pisca alguns segundos enquanto se levanta.',
        porque: 'Sem este passo explícito, o modo de falha seria o pior possível: você cadastraria a chave, a tela diria que deu certo, e o serviço continuaria recusando o agente por dias, sem nada na tela ligando uma coisa à outra. Reiniciar interrompe o que ele estiver fazendo, e por isso a decisão é sua e não do painel.',
      },
      {
        chave: 'api',
        alvo: '#cofre-root .cofre-api',
        titulo: 'Quem pode guardar chaves aqui por API',
        corpo: 'Uma chave de API é uma senha comprida que você entrega a outro assistente (por exemplo a assistente principal ou o Admin) para ele guardar chaves neste agente sem abrir esta tela. Você cria a chave aqui, copia o token na hora e entrega a quem você confia. Cada chave tem um nome, e a lista mostra quem criou, quando e a última vez que foi usada.',
        porque: 'Sem isto, toda chave nova precisaria ser colada por uma pessoa nesta tela. Com isto, quem cuida da instalação coloca a chave por conta própria, e você continua mandando: cada chave é só deste agente, não consegue ler o que já está guardado, não consegue criar outras chaves e some no instante em que você clica em revogar.',
      },
      {
        chave: 'guarda',
        alvo: '#cofre-root .cofre-guarda',
        titulo: 'Como a chave fica guardada',
        corpo: 'A chave é cifrada antes de tocar no disco, e cada agente tem o cofre dele: uma chave cadastrada aqui não entra no ambiente de nenhum outro agente. Na hora de usar, ela é escrita num arquivo que vive na memória da máquina e some quando ela desliga. A cifra é amarrada a esta máquina, então cadastre sempre por esta tela: cofre copiado de outro lugar não abre aqui.',
        porque: 'Essa frase é resposta a um acidente de verdade: em agosto de 2026 descobriu-se que um cofre antigo entregava quase todas as chaves guardadas a todos os agentes, incluindo credencial financeira. O dono de um agente não é o dono das chaves dos outros, e a separação por agente é o que garante isso.',
      },
    ];
  }

  function abrirTutorial(comecarEm) {
    window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  // ─── Estado da tela ──────────────────────────────────────────
  let dados = null;   // o que veio de /api/cofre
  let chavesApi = { ok: false, lista: [], erro: '' };   // o que veio de /api/chaves-api
  let tokenNovo = null;   // { nome, token }: a chave de API recém-criada, mostrada UMA vez
  let aviso = null;   // { tipo: 'ok' | 'erro' | 'andando', texto }
  let ocupado = false;

  function raiz() { return document.getElementById('cofre-root'); }

  function mostrarAviso(tipo, texto) {
    aviso = { tipo, texto };
    desenhar();
  }

  // ─── Desenho ─────────────────────────────────────────────────

  function cabecalho() {
    const ajuda = 'As chaves de serviço que este agente pode usar. Uma chave cadastrada aqui vale só para ele, '
      + 'e o que ele gastar com ela é cobrado de quem cadastrou.';
    return `<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(ajuda)}">Cofre do agente</h2>
          <button type="button" class="app-tutorial-abrir" id="cofre-tutorial-abrir"
                  title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="tela"
                  aria-label="O que é este cofre" title="O que é este cofre">?</button>
        </div>
        <p>${esc(ajuda)}</p>
      </div>
      <div id="cofre-corpo"></div>`;
  }

  function blocoAviso() {
    if (!aviso) return '';
    const classe = aviso.tipo === 'erro' ? 'app-erro' : (aviso.tipo === 'andando' ? 'app-carregando' : 'cofre-ok');
    const titulo = aviso.tipo === 'erro' ? 'Não consegui fazer isto.' : '';
    return `<div class="${classe} cofre-aviso">${titulo ? `<strong>${esc(titulo)}</strong>` : ''}<p>${esc(aviso.texto)}</p></div>`;
  }

  /** O aviso de quem paga a conta. Regra 11 da nota de segurança do cofre. */
  function blocoConta() {
    return `<div class="cartao cofre-conta">
        <div class="section-title">A chave é sua, e a conta também
          <button type="button" class="app-ajuda-secao" data-tutorial="conta"
                  aria-label="Quem paga pelo uso da chave" title="Quem paga pelo uso da chave">?</button>
        </div>
        <p class="ajuda-secao">A chave que você cadastra aqui é gerada por <b>você</b>, no site do serviço, com o seu
          cadastro. O que o agente consumir com ela é cobrado <b>de você</b>, direto pelo serviço, e não passa por este
          painel. No painel do próprio serviço você vê o gasto, pode pôr um limite e pode cancelar a chave a qualquer
          momento.</p>
      </div>`;
  }

  function linhaDaChave(c) {
    const revogada = !!c.revogadaEm;
    const estado = revogada
      ? `<span class="cofre-selo revogada" title="Esta chave saiu do cofre em ${esc(quando(c.revogadaEm))}. O registro fica para você saber o que já esteve aqui.">revogada</span>`
      : '<span class="cofre-selo ativa" title="Esta chave está no cofre e entra no ambiente do agente quando ele inicia.">ativa</span>';
    const acao = revogada
      ? ''
      : `<button type="button" class="btn-leve cofre-revogar" data-env="${esc(c.envName)}"
                 title="Tira esta chave do cofre. Ela some do agente no próximo reinício, e o registro de que ela existiu fica.">revogar</button>`;
    // O `data-rot` é o rótulo da coluna, e ele existe para o CELULAR: em tela
    // estreita a tabela vira cartão, e cada valor aparece com o nome da coluna do
    // lado. Tabela de seis colunas em 390px ou rola para o lado ou espreme tudo,
    // e as duas saídas são ruins numa tela em que a pessoa precisa conferir de
    // qual chave ela está falando antes de clicar em revogar.
    return `<tr>
        <td data-rot="Serviço">${esc(c.provedorNome || c.provedor)}</td>
        <td data-rot="Nome"><code title="É por este nome que o agente procura a chave.">${esc(c.envName)}</code></td>
        <td data-rot="Chave"><span class="cofre-mascara" title="Os quatro últimos caracteres da chave. Servem para você conferir que é a chave certa sem precisar ver a chave inteira.">••••${esc(c.ultimos4 || '')}</span></td>
        <td data-rot="Cadastrada por" title="Quem cadastrou e quando.">${esc(c.cadastradaPor || '')} <span class="cofre-quando">${esc(quando(c.cadastradaEm))}</span>
          <span class="cofre-selo origem" title="${c.origem === 'api' ? 'Esta chave foi colocada por outro assistente, usando uma chave de API, sem passar pela tela.' : 'Esta chave foi colada por uma pessoa, nesta tela.'}">${c.origem === 'api' ? 'por API' : 'pela tela'}</span></td>
        <td data-rot="Estado">${estado}</td>
        <td class="cofre-linha-acoes">${acao}</td>
      </tr>`;
  }

  function blocoLista() {
    const chaves = (dados && dados.chaves) || [];
    if (!chaves.length) {
      return `<div class="cartao cofre-lista">
          <div class="section-title">Chaves guardadas
            <button type="button" class="app-ajuda-secao" data-tutorial="lista"
                    aria-label="O que aparece nesta lista" title="O que aparece nesta lista">?</button>
          </div>
          <div class="app-vazio"><strong>Nenhuma chave guardada ainda.</strong>
            <p>Enquanto não houver nenhuma, o agente trabalha normalmente: ele só não consegue usar
               serviço que cobre à parte. Use o campo abaixo para guardar a primeira.</p></div>
        </div>`;
    }
    return `<div class="cartao cofre-lista">
        <div class="section-title">Chaves guardadas
          <button type="button" class="app-ajuda-secao" data-tutorial="lista"
                  aria-label="O que aparece nesta lista" title="O que aparece nesta lista">?</button>
        </div>
        <p class="ajuda-secao">A chave inteira não aparece aqui e não aparece em lugar nenhum depois de guardada.
          Se você perdeu a sua, gere outra no site do serviço e cadastre por cima.</p>
        <table class="pixel-table cofre-tabela">
          <thead><tr>
            <th title="O serviço que emitiu a chave.">Serviço</th>
            <th title="O nome pelo qual o agente procura esta chave no ambiente dele.">Nome</th>
            <th title="Os quatro últimos caracteres, para conferência.">Chave</th>
            <th title="Quem cadastrou, e quando.">Cadastrada por</th>
            <th title="Se ela está no cofre agora ou se já foi revogada.">Estado</th>
            <th></th>
          </tr></thead>
          <tbody>${chaves.map(linhaDaChave).join('')}</tbody>
        </table>
      </div>`;
  }

  function blocoNova() {
    const provedores = (dados && dados.provedores) || [];
    const opcoes = provedores.map((p) => `<option value="${esc(p.id)}" data-sugestao="${esc(p.sugestao || '')}" data-onde="${esc(p.onde || '')}" data-dica="${esc(p.dica || '')}">${esc(p.nome)}</option>`).join('');
    return `<div class="cartao cofre-nova">
        <div class="section-title">Guardar uma chave
          <button type="button" class="app-ajuda-secao" data-tutorial="nova"
                  aria-label="Como guardar uma chave" title="Como guardar uma chave">?</button>
        </div>
        <div class="cofre-campo">
          <label for="cofre-provedor" title="Escolher o serviço preenche sozinho o nome certo e mostra onde gerar a chave.">Serviço</label>
          <select id="cofre-provedor">${opcoes}</select>
        </div>
        <p class="ajuda-secao cofre-onde" id="cofre-onde"></p>
        <div class="cofre-campo">
          <label for="cofre-nome" title="É por este nome que o agente procura a chave. Escolher o serviço acima já preenche o nome certo.">Nome da chave</label>
          <input type="text" id="cofre-nome" spellcheck="false" autocomplete="off" placeholder="OPENAI_API_KEY">
        </div>
        <div class="cofre-campo">
          <label for="cofre-valor" title="Cole aqui a chave que você gerou no site do serviço. Ela não volta a aparecer depois de guardada.">A chave</label>
          <input type="password" id="cofre-valor" spellcheck="false" autocomplete="off" placeholder="cole aqui a chave gerada no serviço">
        </div>
        <div class="cofre-botoes">
          <button type="button" class="btn-leve" id="cofre-ver" title="Mostrar o que você colou, para conferir antes de guardar.">mostrar o que colei</button>
          <button type="button" class="btn-principal" id="cofre-guardar">guardar a chave</button>
        </div>
        <p class="ajuda-secao">Depois de guardada, a chave não volta a aparecer nesta tela nem em nenhuma outra.
          Guarde a sua cópia no gerenciador de senhas do seu computador.</p>
      </div>`;
  }

  function blocoAplicar() {
    const a = (dados && dados.aplicar) || {};
    if (!a.pode) {
      return `<div class="cartao cofre-aplicar">
          <div class="section-title">Fazer a chave valer
            <button type="button" class="app-ajuda-secao" data-tutorial="aplicar"
                    aria-label="Por que precisa reiniciar" title="Por que precisa reiniciar">?</button>
          </div>
          <div class="app-erro"><strong>Não dá para reiniciar o agente por aqui.</strong>
            <p>${esc(a.motivo || '')} ${esc(a.howToFix || '')}</p></div>
        </div>`;
    }
    return `<div class="cartao cofre-aplicar">
        <div class="section-title">Fazer a chave valer
          <button type="button" class="app-ajuda-secao" data-tutorial="aplicar"
                  aria-label="Por que precisa reiniciar" title="Por que precisa reiniciar">?</button>
        </div>
        <p class="ajuda-secao">O agente lê o cofre <b>quando inicia</b>. Enquanto você não clicar aqui, ele continua
          usando o que tinha antes. Reiniciar interrompe o que ele estiver fazendo neste momento, e por isso o botão
          é seu e não acontece sozinho ao guardar.</p>
        <p class="ajuda-secao"><b>A conversa não se perde.</b> Ele volta de onde parou, na mesma conversa. O que
          acontece é que o terminal dele pisca por alguns segundos enquanto ele se levanta, e quem estiver olhando
          a aba Conversa nesse instante vê isso.</p>
        <button type="button" class="btn-principal" id="cofre-aplicar"
                title="Reinicia o agente para que ele leia o cofre. É o passo que faz a chave nova passar a valer.">
          aplicar e reiniciar o agente
        </button>
      </div>`;
  }

  function blocoGuarda() {
    const g = (dados && dados.guarda) || {};
    return `<div class="cartao cofre-guarda">
        <div class="section-title">Como a chave fica guardada
          <button type="button" class="app-ajuda-secao" data-tutorial="guarda"
                  aria-label="Como a chave fica guardada" title="Como a chave fica guardada">?</button>
        </div>
        <ul class="cofre-guarda-lista">
          <li>${esc(g.motorExplicacao || '')}</li>
          <li>${esc(g.emMemoriaExplicacao || '')}</li>
          <li>Uma chave cadastrada aqui vale <b>só para este agente</b>. Nenhum outro agente a enxerga, nem o assistente
              principal. Para outro agente usar o mesmo serviço, o dono dele cadastra a chave lá, ou autoriza alguém
              (criando uma chave de API <b>daquele</b> agente) a cadastrar.</li>
          <li>O cofre é <b>desta máquina</b>: a chave é cifrada de um jeito que só abre aqui. Cadastre sempre por esta
              tela. Copiar o cofre de outro lugar não funciona, e se este agente for refeito do zero as chaves
              precisam ser cadastradas de novo.</li>
          <li>Revogar tira a chave do cofre e guarda a data. Para a chave deixar de funcionar de verdade,
              cancele também no site do serviço, que é o único lugar onde isso acontece.</li>
        </ul>
      </div>`;
  }

  function linhaDaChaveApi(c) {
    const revogada = !!c.revogadaEm;
    const estado = revogada
      ? `<span class="cofre-selo revogada" title="Esta chave de API deixou de valer em ${esc(quando(c.revogadaEm))}.">revogada</span>`
      : '<span class="cofre-selo ativa" title="Quem tiver este token consegue guardar chaves neste agente.">ativa</span>';
    const acao = revogada ? '' : `<button type="button" class="btn-leve cofre-api-revogar" data-id="${esc(c.id)}" data-nome="${esc(c.nome)}"
        title="Faz esta chave de API parar de valer agora. Quem a usava passa a receber recusa.">revogar</button>`;
    return `<tr>
        <td data-rot="Nome" title="O nome que você deu à chave, para lembrar quem a usa.">${esc(c.nome)}</td>
        <td data-rot="Final do token" title="Os quatro últimos caracteres do token, para você reconhecer a chave."><span class="cofre-mascara">••••${esc(c.ultimos4 || '')}</span></td>
        <td data-rot="Criada por" title="Quem criou a chave e quando.">${esc(c.criadaPor || '')} <span class="cofre-quando">${esc(quando(c.criadaEm))}</span></td>
        <td data-rot="Último uso" title="A última vez que alguém usou esta chave. Uma chave que nunca foi usada talvez não precise existir.">${c.ultimoUsoEm ? esc(quando(c.ultimoUsoEm)) : '<span class="cofre-quando">nunca usada</span>'}</td>
        <td data-rot="Estado">${estado}</td>
        <td class="cofre-linha-acoes">${acao}</td>
      </tr>`;
  }

  function blocoTokenNovo() {
    if (!tokenNovo) return '';
    return `<div class="cofre-token-novo">
        <strong>Chave "${esc(tokenNovo.nome)}" criada. Guarde agora, ele não aparece de novo.</strong>
        <p class="ajuda-secao">Copie este token e entregue a quem vai usá-lo. O painel guarda só uma marca dele: se você
          perder, a saída é revogar esta chave e criar outra.</p>
        <div class="cofre-token-linha">
          <input type="text" id="cofre-token-valor" readonly value="${esc(tokenNovo.token)}" spellcheck="false"
                 title="O token da chave de API. Ele só aparece nesta tela agora.">
          <button type="button" class="btn-principal" id="cofre-token-copiar" title="Copia o token para a área de transferência.">copiar</button>
          <button type="button" class="btn-leve" id="cofre-token-fechar" title="Esconde o token. Depois de fechar, não há como vê-lo de novo.">já guardei</button>
        </div>
      </div>`;
  }

  function blocoApi() {
    const lista = chavesApi.lista || [];
    let corpo;
    if (!chavesApi.ok) {
      corpo = `<div class="app-erro"><strong>Não consegui abrir a lista de chaves de API.</strong><p>${esc(chavesApi.erro)}</p></div>`;
    } else if (!lista.length) {
      corpo = `<div class="app-vazio"><strong>Nenhuma chave de API criada ainda.</strong>
          <p>Sem chave de API, só quem entra nesta tela guarda chaves aqui. Crie uma quando outro assistente precisar
             fazer isso por conta própria.</p></div>`;
    } else {
      corpo = `<table class="pixel-table cofre-tabela">
          <thead><tr>
            <th title="O nome que você deu à chave.">Nome</th>
            <th title="Os quatro últimos caracteres do token.">Final do token</th>
            <th title="Quem criou a chave e quando.">Criada por</th>
            <th title="A última vez que a chave foi usada.">Último uso</th>
            <th title="Se a chave ainda vale ou já foi revogada.">Estado</th>
            <th></th>
          </tr></thead>
          <tbody>${lista.map(linhaDaChaveApi).join('')}</tbody>
        </table>`;
    }
    return `<div class="cartao cofre-api">
        <div class="section-title">Quem pode guardar chaves aqui por API
          <button type="button" class="app-ajuda-secao" data-tutorial="api"
                  aria-label="O que é uma chave de API" title="O que é uma chave de API">?</button>
        </div>
        <p class="ajuda-secao">É o jeito de <b>outro assistente</b> (a assistente principal, ou o Admin, por exemplo)
          colocar chaves neste agente <b>sem ver esta tela</b>. Você cria uma chave de API, copia o token na hora e
          entrega a quem você confia. Ela só serve para guardar chaves <b>neste</b> agente: não lê o que já está
          guardado, não cria outras chaves de API e deixa de valer quando você clica em revogar.</p>
        ${blocoTokenNovo()}
        ${corpo}
        <div class="cofre-campo cofre-api-nova">
          <label for="cofre-api-nome" title="Um nome que lembre quem vai usar esta chave, por exemplo Admin.">Nome da nova chave de API</label>
          <input type="text" id="cofre-api-nome" maxlength="60" spellcheck="false" autocomplete="off" placeholder="Admin">
        </div>
        <div class="cofre-botoes">
          <button type="button" class="btn-principal" id="cofre-api-criar"
                  title="Cria a chave de API e mostra o token uma única vez.">criar chave de API</button>
        </div>
      </div>`;
  }

  function desenhar() {
    const corpo = document.getElementById('cofre-corpo');
    if (!corpo) return;
    corpo.innerHTML = blocoAviso() + blocoConta() + blocoLista() + blocoNova() + blocoAplicar() + blocoApi() + blocoGuarda();
    ligarCorpo();
  }

  // ─── Ligações ────────────────────────────────────────────────

  function ligarCabecalho() {
    const b = document.getElementById('cofre-tutorial-abrir');
    if (b) b.addEventListener('click', () => abrirTutorial(0));
    document.querySelectorAll('#cofre-root .app-cabeca .app-ajuda-secao[data-tutorial]').forEach((el) => {
      el.addEventListener('click', () => abrirTutorial(el.dataset.tutorial));
    });
  }

  function ligarCorpo() {
    document.querySelectorAll('#cofre-corpo .app-ajuda-secao[data-tutorial]').forEach((el) => {
      el.addEventListener('click', () => abrirTutorial(el.dataset.tutorial));
    });

    const sel = document.getElementById('cofre-provedor');
    const nome = document.getElementById('cofre-nome');
    const onde = document.getElementById('cofre-onde');
    if (sel && nome && onde) {
      const aplicarProvedor = () => {
        const op = sel.options[sel.selectedIndex];
        const sugestao = op ? op.dataset.sugestao : '';
        // Só preenche o nome se a pessoa ainda não escreveu o dela: sobrescrever
        // o que ela digitou seria a tela desfazendo o trabalho dela.
        if (sugestao && !nome.value.trim()) nome.value = sugestao;
        else if (sugestao && nome.dataset.veioDaLista === '1') nome.value = sugestao;
        if (sugestao) nome.dataset.veioDaLista = '1';
        const url = op ? op.dataset.onde : '';
        const dica = op ? op.dataset.dica : '';
        onde.innerHTML = dica ? esc(dica) : url
          ? `Você gera essa chave aqui: <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>. Precisa estar logado na sua conta do serviço.`
          : 'Gere a chave no painel do serviço que você quer ligar, com a sua conta, e escreva abaixo o nome pelo qual o agente deve procurá-la.';
      };
      sel.addEventListener('change', aplicarProvedor);
      nome.addEventListener('input', () => { nome.dataset.veioDaLista = '0'; });
      aplicarProvedor();
    }

    const ver = document.getElementById('cofre-ver');
    const valor = document.getElementById('cofre-valor');
    if (ver && valor) {
      ver.addEventListener('click', () => {
        const escondido = valor.type === 'password';
        valor.type = escondido ? 'text' : 'password';
        ver.textContent = escondido ? 'esconder de novo' : 'mostrar o que colei';
      });
    }

    const guardar = document.getElementById('cofre-guardar');
    if (guardar) guardar.addEventListener('click', salvarChave);

    const aplicar = document.getElementById('cofre-aplicar');
    if (aplicar) aplicar.addEventListener('click', aplicarCofre);

    document.querySelectorAll('#cofre-corpo .cofre-revogar').forEach((b) => {
      b.addEventListener('click', () => revogarChave(b.dataset.env));
    });

    const criarApi = document.getElementById('cofre-api-criar');
    if (criarApi) criarApi.addEventListener('click', criarChaveApi);
    document.querySelectorAll('#cofre-corpo .cofre-api-revogar').forEach((b) => {
      b.addEventListener('click', () => revogarChaveApi(b.dataset.id, b.dataset.nome));
    });
    const copiar = document.getElementById('cofre-token-copiar');
    if (copiar) copiar.addEventListener('click', copiarToken);
    const fechar = document.getElementById('cofre-token-fechar');
    if (fechar) fechar.addEventListener('click', () => { tokenNovo = null; desenhar(); });
  }

  // ─── Ações ───────────────────────────────────────────────────

  async function salvarChave() {
    if (ocupado) return;
    const nome = (document.getElementById('cofre-nome') || {}).value || '';
    const valor = (document.getElementById('cofre-valor') || {}).value || '';
    const provedor = (document.getElementById('cofre-provedor') || {}).value || 'outro';

    ocupado = true;
    mostrarAviso('andando', 'Guardando a chave...');
    const r = await chamar('/api/cofre', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envName: nome, valor, provedor }),
    });
    ocupado = false;

    if (!r.ok) {
      // A recusa do servidor vem inteira para a tela. É ela que diz qual nome
      // não passou e por quê, e sem ela a pessoa ficaria adivinhando.
      await recarregar({ tipo: 'erro', texto: motivoDoErro(r) });
      return;
    }
    const c = r.corpo || {};
    await recarregar({
      tipo: 'ok',
      texto: `${c.trocada ? 'Chave trocada' : 'Chave guardada'} (${c.envName}, terminada em ${c.ultimos4}). ${c.aviso || ''} Clique em "aplicar e reiniciar o agente" para ela passar a valer.`,
    });
    // O campo da chave é limpo SEMPRE que a gravação dá certo. Deixar o valor
    // ali seria manter a chave em texto na tela de quem já terminou o que veio
    // fazer, à mercê do próximo que passar na frente do computador.
    const campo = document.getElementById('cofre-valor');
    if (campo) { campo.value = ''; campo.type = 'password'; }
  }

  async function revogarChave(envName) {
    if (ocupado || !envName) return;
    const certeza = window.confirm(
      `Revogar a chave "${envName}"?\n\n` +
      'Ela sai do cofre agora e some do agente no próximo reinício dele. ' +
      'Isso NÃO cancela a chave no site do serviço: se ela vazou, cancele lá também.',
    );
    if (!certeza) return;

    ocupado = true;
    mostrarAviso('andando', `Revogando ${envName}...`);
    const r = await chamar(`/api/cofre?envName=${encodeURIComponent(envName)}`, { method: 'DELETE' });
    ocupado = false;

    if (!r.ok) { await recarregar({ tipo: 'erro', texto: motivoDoErro(r) }); return; }
    await recarregar({ tipo: 'ok', texto: (r.corpo && r.corpo.aviso) || `A chave ${envName} foi revogada.` });
  }

  async function aplicarCofre() {
    if (ocupado) return;
    const certeza = window.confirm(
      'Reiniciar o agente agora?\n\n' +
      'É o que faz as chaves do cofre passarem a valer. Se ele estiver no meio de um trabalho, o trabalho é interrompido.\n' +
      'A conversa de vocês não se perde: ele volta de onde parou.',
    );
    if (!certeza) return;

    ocupado = true;
    mostrarAviso('andando', 'Reiniciando o agente para ele ler o cofre...');
    const r = await chamar('/api/cofre/aplicar', { method: 'POST' });
    ocupado = false;

    if (!r.ok) { await recarregar({ tipo: 'erro', texto: motivoDoErro(r) }); return; }
    const c = r.corpo || {};
    let texto = c.feito || 'O agente foi reiniciado.';
    if (c.falhas && c.falhas.length) {
      texto += ` Atenção: ${c.falhas.join(', ')} está no cofre e não abriu nesta máquina, então o agente ficou sem ela.`;
    }
    await recarregar({ tipo: 'ok', texto });
  }

  async function criarChaveApi() {
    if (ocupado) return;
    const nome = ((document.getElementById('cofre-api-nome') || {}).value || '').trim();
    ocupado = true;
    mostrarAviso('andando', 'Criando a chave de API...');
    const r = await chamar('/api/chaves-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome }),
    });
    ocupado = false;
    if (!r.ok) { await recarregar({ tipo: 'erro', texto: motivoDoErro(r) }); return; }
    // O token fica só nesta variável, na memória da página. Recarregar a página o apaga.
    tokenNovo = { nome: r.corpo.nome || nome, token: r.corpo.token };
    await recarregar({ tipo: 'ok', texto: `Chave de API "${tokenNovo.nome}" criada. ${r.corpo.aviso || ''}` });
  }

  async function revogarChaveApi(id, nome) {
    if (ocupado || !id) return;
    const certeza = window.confirm(
      `Revogar a chave de API "${nome}"?\n\n` +
      'Ela deixa de valer agora. Quem a usa passa a receber recusa até você criar outra. ' +
      'As chaves de serviço que ela já guardou neste cofre continuam onde estão.',
    );
    if (!certeza) return;
    ocupado = true;
    mostrarAviso('andando', 'Revogando a chave de API...');
    const r = await chamar(`/api/chaves-api?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    ocupado = false;
    if (!r.ok) { await recarregar({ tipo: 'erro', texto: motivoDoErro(r) }); return; }
    await recarregar({ tipo: 'ok', texto: (r.corpo && r.corpo.aviso) || 'A chave de API foi revogada.' });
  }

  async function copiarToken() {
    const campo = document.getElementById('cofre-token-valor');
    if (!campo) return;
    try {
      await navigator.clipboard.writeText(campo.value);
      mostrarAviso('ok', 'Token copiado. Cole-o onde o outro assistente vai guardá-lo.');
    } catch {
      // Página sem HTTPS não tem área de transferência: seleciona para copiar à mão.
      campo.focus(); campo.select();
      mostrarAviso('erro', 'O navegador não deixou copiar sozinho. O token está selecionado: use Ctrl+C (ou "copiar" do menu).');
    }
  }

  async function carregarChavesApi() {
    const r = await chamar('/api/chaves-api');
    chavesApi = r.ok
      ? { ok: true, lista: (r.corpo && r.corpo.chaves) || [], erro: '' }
      : { ok: false, lista: [], erro: motivoDoErro(r) };
  }

  // ─── Carregar ────────────────────────────────────────────────

  async function recarregar(novoAviso) {
    const r = await chamar('/api/cofre');
    if (r.ok) dados = r.corpo;
    await carregarChavesApi();
    aviso = novoAviso || aviso;
    if (!r.ok && !novoAviso) aviso = { tipo: 'erro', texto: motivoDoErro(r) };
    desenhar();
  }

  async function carregar() {
    const el = raiz();
    if (!el) return;
    el.innerHTML = cabecalho();
    ligarCabecalho();
    const corpo = document.getElementById('cofre-corpo');
    if (corpo) corpo.innerHTML = '<div class="app-carregando">Carregando...</div>';

    const r = await chamar('/api/cofre');
    if (!r.ok) {
      const alvo = document.getElementById('cofre-corpo');
      if (alvo) alvo.innerHTML = `<div class="app-erro"><strong>Não consegui abrir o cofre.</strong><p>${esc(motivoDoErro(r))}</p></div>`;
      return;
    }
    dados = r.corpo;
    await carregarChavesApi();
    tokenNovo = null;
    aviso = null;
    desenhar();
  }

  window.DGCofre = { carregar, abrirTutorial };
})();
