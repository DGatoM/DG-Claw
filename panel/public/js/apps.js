// apps.js — a tela da aba Apps.
//
// O QUE ELA MOSTRA: os aplicativos que o agente opera e, dentro do primeiro deles
// (Conteúdo), tudo o que ele já produziu, um cartão por vídeo, com as etapas em
// régua. Cada etapa é clicável e abre o que aquela etapa produziu.
//
// POR QUE ESTE ARQUIVO NÃO USA O `API.get`. Aquele wrapper devolve `null` quando
// a resposta não é 200, e com isso o MOTIVO que o servidor mandou junto morre no
// caminho. A aba inteira foi escrita para nunca virar tela em branco: toda falha
// aqui precisa chegar na pessoa com a frase que explica o que aconteceu. Então o
// fetch é próprio e guarda o corpo do erro. Nada mais deste arquivo depende do
// resto do painel, de propósito, para o enxerto nos arquivos compartilhados ficar
// em poucas linhas.
//
// A DISTINÇÃO QUE A TELA PRESERVA: uma etapa "concluída porque o agente declarou"
// e uma "concluída porque o arquivo está lá" não são a mesma afirmação. O servidor
// manda `origem`, e a segunda aparece com o rótulo "deduzido da pasta". Apagar
// essa diferença deixaria o cartão mais bonito e mais mentiroso.

(function () {
  const BASE = window.DGCLAW_BASE || '';

  /** GET que preserva o corpo do erro. Devolve {ok, status, corpo}. */
  async function pegar(url) {
    let res;
    try {
      res = await fetch(BASE + url);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  }

  /**
   * POST, com o mesmo contrato do `pegar`.
   *
   * Timeout generoso (2 min) porque publicar uma página com quinze imagens
   * dentro é uma coisa lenta por natureza: ler os arquivos, virar base64 e subir.
   * Um timeout curto aqui faria a tela dizer que falhou enquanto o arquivo
   * estava, na verdade, sendo publicado com sucesso.
   */
  async function enviar(url, dados) {
    let res;
    try {
      res = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dados || {}),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json */ }
    return { ok: res.ok, status: res.status, corpo };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const STATUS_ROTULO = {
    pendente: 'não começou',
    em_producao: 'em produção',
    aguardando_aprovacao: 'esperando você',
    concluido: 'pronto',
    reprovado: 'refazer',
    nao_aplicavel: 'não se aplica',
  };

  // O que cada palavrinha de status quer dizer, na mão de quem passa o mouse.
  // Rótulo curto na tela, frase inteira aqui: ninguém precisa perguntar a
  // ninguém o que significa "esperando você".
  const STATUS_AJUDA = {
    pendente: 'O agente ainda não começou esta etapa.',
    em_producao: 'O agente está trabalhando nesta etapa agora.',
    aguardando_aprovacao: 'O agente terminou e está esperando você aprovar ou pedir para refazer.',
    concluido: 'Etapa terminada e aprovada. O arquivo dela está aqui, é só clicar.',
    reprovado: 'Você pediu para refazer. O motivo aparece quando você abre a etapa.',
    nao_aplicavel: 'Esta etapa não vale para este conteúdo, e por isso não conta no total.',
  };

  // Uma ideia, um nome. O selo aparece no cartão e dentro da etapa, e nos dois
  // lugares diz a mesma coisa com as mesmas palavras. (Antes eram dois nomes,
  // "lido da pasta" e "deduzido da pasta", para exatamente o mesmo fato.)
  const SELO_DEDUZIDO_TEXTO = 'lido da pasta';
  const SELO_DEDUZIDO_AJUDA = 'O agente não deixou um estado escrito para esta etapa. '
    + 'O que você vê foi lido direto da pasta do projeto: existe o arquivo, então a etapa saiu do papel. '
    + 'É uma afirmação mais fraca do que "o agente declarou que terminou", e por isso vem marcada.';

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function dataCurta(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  }

  // O renderizador de markdown mora em js/markdown.js, que o index.html carrega
  // antes deste arquivo. Ele saiu daqui porque a página de compartilhar roteiro
  // precisa do MESMO renderizador no servidor: ver o cabeçalho de lá.
  const md = (t) => window.DGMarkdown.md(t);

  // ─── Tutorial da tela ───────────────────────────────────────────────────
  //
  // POR QUE ISTO EXISTE. A regra do repo: nenhuma tela nasce muda. Quem abre este
  // painel não é desenvolvedor e não mandou construir nada — é o dono do agente,
  // que quer saber se está tudo bem. Cada passo aqui responde as três perguntas
  // que ele faria em voz alta: O QUE É isso, COMO a conta é feita, e POR QUE está
  // nesta tela. Sem biblioteca: é holofote (uma sombra gigante em volta do alvo)
  // mais um balão, e nada disso viaja para fora da aba Apps.
  //
  // Passo com `alvo` nulo aparece centralizado, sem holofote. Passo cujo alvo não
  // existe na tela naquele momento (o selo, por exemplo, que só aparece quando o
  // agente não escreveu estado) é PULADO, nunca apontado para o vazio.

  function passosDoTutorial() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'Esta é a prateleira do que o agente já fez',
        corpo: 'Um "app" aqui é um trabalho que o agente toca sozinho, do começo ao fim. Esta aba não manda ele fazer nada: ela mostra o que já foi feito e em que pé está.',
        porque: 'Ele trabalha enquanto você não está olhando. Sem esta tela, a única forma de saber do andamento era perguntar a ele no chat, uma pergunta de cada vez.',
      },
      {
        chave: 'seletor',
        alvo: '#apps-root .app-seletor',
        titulo: 'Quando houver mais de um app, ele aparece aqui',
        corpo: 'Cada botão é um app diferente do mesmo agente. Com um só, esta linha nem aparece.',
        porque: 'Hoje é um. A linha existe para o dia em que forem três, e você precisar saber de qual deles está vendo o resultado.',
      },
      {
        chave: 'cabeca',
        alvo: '#apps-root .app-cabeca',
        titulo: 'O nome do app e o que ele faz',
        corpo: 'A frase embaixo do nome é a descrição que o agente carrega para este app. Passe o mouse em qualquer rótulo desta tela: quase todos explicam a si mesmos assim.',
        porque: 'É o contrato do app em uma linha. Se o que aparece abaixo não combina com esta frase, alguma coisa está errada, e vale perguntar a ele.',
      },
      {
        chave: 'cartao',
        alvo: '#apps-root .app-card',
        titulo: 'Um cartão para cada trabalho',
        corpo: 'Aqui, um vídeo. O título é o que o agente deu ao projeto; embaixo vêm a data em que ele começou e o nome da pasta no disco.',
        porque: 'A pasta aparece de propósito. Se você um dia for procurar o material fora daqui, é por esse nome que vai encontrar.',
      },
      {
        chave: 'progresso',
        alvo: '#apps-root .app-progresso',
        titulo: 'A conta de quanto já andou',
        corpo: 'Etapas prontas sobre o total deste conteúdo. Uma etapa marcada como "não se aplica" sai da conta dos dois lados, então 2/2 pode significar que uma terceira etapa foi dispensada.',
        porque: 'É o único número da tela, e um número precisa dizer como foi calculado. Sem isso, 2/2 e 3/3 pareceriam a mesma coisa dita de dois jeitos.',
      },
      {
        chave: 'selo',
        alvo: '#apps-root .app-selo-deduzido',
        titulo: 'Quando o painel deduziu em vez de ler',
        corpo: 'Este selo diz que o agente não deixou um estado escrito. O que você vê foi lido direto da pasta: o arquivo existe, então a etapa saiu do papel.',
        porque: '"O agente declarou que terminou" e "o arquivo está lá" não são a mesma afirmação. Apagar essa diferença deixaria o cartão mais bonito e mais mentiroso.',
      },
      {
        chave: 'regua',
        alvo: '#apps-root .app-regua',
        titulo: 'As etapas, na ordem em que acontecem',
        corpo: 'A bolinha e a palavra à direita dão o estado de cada uma. "Esperando você" é a única que pede ação sua: o agente parou ali de propósito.',
        porque: 'O trabalho tem ordem. Ver a régua inteira mostra não só onde ele está, mas o que ainda vem pela frente.',
      },
      {
        chave: 'etapa',
        alvo: '#apps-root .app-etapa',
        titulo: 'Clique em qualquer etapa para ver o que ela produziu',
        corpo: 'Abre logo abaixo do cartão, com o arquivo daquela etapa. Clicar de novo fecha. A tela se atualiza sozinha a cada minuto e o que você deixou aberto continua aberto.',
        porque: 'O resumo de uma linha serve para bater o olho. A decisão de aprovar ou mandar refazer você toma lendo o material inteiro, e ele está a um clique.',
      },
      {
        chave: 'assets',
        alvo: '#apps-root .app-assets',
        titulo: 'O material que o agente juntou, para você ver',
        corpo: 'Imagem aparece em miniatura; clicar abre grande. Vídeo, áudio e PDF também abrem aqui dentro. Planilha e arquivo compactado não abrem no navegador, e nesses o botão é o de baixar.',
        porque: 'Antes esta parte da tela dizia só "14 arquivos". Saber a quantidade não ajuda a decidir se o material presta: para isso é preciso olhar, e olhar tinha que ser possível sem sair do painel.',
      },
    ];
  }

  // O MOTOR da visita guiada mora em js/tutorial.js, e não mais aqui.
  //
  // Ele saiu quando a aba Pasta precisou do mesmo tutorial: a alternativa era uma
  // segunda cópia das mesmas 120 linhas, que um dia se comportaria diferente sem
  // ninguém ter decidido isso. O que ficou desta aba é o que sempre foi dela, a
  // lista de passos logo acima. As classes de CSS continuam `app-tut-*`, e o
  // estilo delas continua em css/apps.css.
  function abrirTutorial(comecarEm) {
    window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  /** O bloco de "não tem nada aqui, e este é o motivo". Nunca um vazio mudo. */
  function vazio(titulo, motivo) {
    return `<div class="app-vazio"><strong>${esc(titulo)}</strong><p>${esc(motivo || '')}</p></div>`;
  }

  function erro(motivo) {
    return `<div class="app-erro"><strong>Não consegui mostrar isto.</strong><p>${esc(motivo)}</p></div>`;
  }

  // ─── Estado da tela ──────────────────────────────────────────
  // Só o suficiente para saber o que está aberto. A verdade continua no servidor:
  // toda abertura de etapa busca o arquivo de novo, em vez de guardar cópia.
  let appAtual = null;
  let abertos = {}; // slug -> etapa aberta (ou null)

  function raiz() { return document.getElementById('apps-root'); }

  async function carregar() {
    const el = raiz();
    if (!el) return;
    el.innerHTML = '<div class="app-carregando">Carregando...</div>';

    const r = await pegar('/api/apps');
    if (!r.ok) { el.innerHTML = erro(r.corpo.error || `O painel respondeu ${r.status}.`); return; }

    const { apps, motivo } = r.corpo;
    if (!apps || !apps.length) {
      el.innerHTML = vazio('Nenhum aplicativo instalado', motivo);
      return;
    }
    if (!appAtual || !apps.some((a) => a.key === appAtual)) appAtual = apps[0].key;

    const seletor = apps.length > 1
      ? `<div class="app-seletor">${apps.map((a) => `
          <button type="button" class="app-chip${a.key === appAtual ? ' ativo' : ''}" data-app="${esc(a.key)}"
                  title="${esc(a.descricao || a.nome)}">
            <span class="ico">${esc(a.icone)}</span>${esc(a.nome)}
          </button>`).join('')}</div>`
      : '';

    const atual = apps.find((a) => a.key === appAtual);
    if (!atual.suportado) {
      el.innerHTML = seletor + vazio(
        `O app "${atual.nome}" ainda não tem tela`,
        `Ele é do tipo "${atual.tipo}", que este painel ainda não sabe mostrar. O agente continua operando o app normalmente; o que falta é a visualização aqui.`,
      );
      ligarSeletor();
      return;
    }

    el.innerHTML = seletor + `<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(atual.descricao)}">${esc(atual.nome)}</h2>
          <button type="button" class="app-tutorial-abrir" id="app-tutorial-abrir"
                  title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="cabeca"
                  aria-label="O que é este app" title="O que é este app">?</button>
        </div>
        <p>${esc(atual.descricao)}</p>
      </div>
      <div id="app-corpo"><div class="app-carregando">Carregando...</div></div>`;
    ligarSeletor();
    const btnTutorial = document.getElementById('app-tutorial-abrir');
    if (btnTutorial) btnTutorial.addEventListener('click', () => abrirTutorial());
    // Delegação: os "?" das seções nascem e morrem a cada redesenho, e um listener
    // na raiz sobrevive a todos eles.
    if (!el.dataset.ajudaLigada) {
      el.dataset.ajudaLigada = '1';
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('.app-ajuda-secao');
        if (!b) return;
        ev.stopPropagation();
        abrirTutorial(b.dataset.tutorial);
      });
    }
    await carregarConteudos();
  }

  function ligarSeletor() {
    document.querySelectorAll('#apps-root .app-chip').forEach((b) => {
      b.addEventListener('click', () => { appAtual = b.dataset.app; abertos = {}; carregar(); });
    });
  }

  async function carregarConteudos() {
    const corpo = document.getElementById('app-corpo');
    if (!corpo) return;

    const r = await pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos`);
    if (!r.ok) { corpo.innerHTML = erro(r.corpo.error || `O painel respondeu ${r.status}.`); return; }

    const { projetos, motivo } = r.corpo;
    if (!projetos || !projetos.length) {
      corpo.innerHTML = vazio('Nenhum conteúdo ainda', motivo);
      return;
    }

    corpo.innerHTML = projetos.map(cartao).join('');
    ligarEtapas();
  }

  /** O selo de "isto eu deduzi", com o mesmo nome e a mesma frase em toda a aba. */
  function seloDeduzido() {
    return `<span class="app-selo-deduzido" title="${esc(SELO_DEDUZIDO_AJUDA)}">${esc(SELO_DEDUZIDO_TEXTO)}</span>`;
  }

  function cartao(p) {
    const { concluidas, total } = p.progresso || { concluidas: 0, total: 0 };
    const selo = p.temEstado ? '' : seloDeduzido();
    const ajudaProgresso = `Etapas prontas sobre o total deste conteúdo: ${concluidas} de ${total}. `
      + 'Etapa marcada como "não se aplica" sai da conta, dos dois lados.';
    return `
      <article class="app-card" data-slug="${esc(p.slug)}">
        <header class="app-card-topo">
          <div>
            <h3>${esc(p.titulo)}</h3>
            <span class="app-card-meta" title="A data em que o agente abriu este conteúdo e o nome da pasta dele no disco.">${esc(dataCurta(p.data))} · ${esc(p.slug)} ${selo}</span>
          </div>
          <span class="app-card-cantos">
            <span class="app-progresso" title="${esc(ajudaProgresso)}">${concluidas}/${total}</span>
            <button type="button" class="app-ajuda-secao" data-tutorial="cartao"
                    aria-label="O que este cartão mostra" title="O que este cartão mostra">?</button>
          </span>
        </header>
        <div class="app-regua">
          ${(p.etapas || []).map((e) => etapaBotao(p.slug, e)).join('')}
        </div>
        <div class="app-etapa-aberta" id="etapa-${esc(p.slug)}"></div>
      </article>`;
  }

  /**
   * A frase que a etapa mostra quando a pasta dela discorda do rótulo.
   *
   * O TEXTO VEM DO SERVIDOR (`e.porQue`), nunca daqui. Quem sabe a diferença
   * entre um catálogo e o material que ele descreve é o lib/apps.js, que é quem
   * olha a pasta. Escrever a frase nesta função significaria a tela adivinhando
   * o motivo, que é como a etapa Assets passou a dizer "pronto" com a pasta
   * vazia em primeiro lugar.
   */
  function avisoDaEtapa(e) {
    if (!e.porQue) return '';
    return `<span class="app-etapa-aviso" title="${esc(e.porQue)}">${esc(e.porQue)}</span>`;
  }

  /**
   * O balão do status. Quando a etapa tem um `porQue`, ele MANDA.
   *
   * O texto genérico de `em_producao` é "o agente está trabalhando nesta etapa
   * agora", e isso seria falso justamente no caso que esta mudança criou: uma
   * etapa em produção porque a pasta está vazia não tem ninguém trabalhando
   * nela neste instante. O motivo específico é sempre mais verdadeiro que o
   * genérico.
   */
  function ajudaDoStatus(e) {
    if (e.porQue) return e.porQue;
    return STATUS_AJUDA[e.status] || `Status "${e.status}", que esta tela ainda não sabe explicar.`;
  }

  function etapaBotao(slug, e) {
    const rotulo = STATUS_ROTULO[e.status] || e.status;
    const ajudaStatus = ajudaDoStatus(e);
    const resumo = e.resumo
      ? `<span class="app-etapa-resumo">${esc(e.resumo)}</span>`
      : '<span class="app-etapa-resumo vazio" title="O agente não deixou uma linha de resumo desta etapa. Abra para ver o arquivo inteiro.">sem resumo</span>';
    return `
      <button type="button" class="app-etapa st-${esc(e.status)}" data-slug="${esc(slug)}" data-etapa="${esc(e.key)}"
              title="Clique para ver o que esta etapa produziu.">
        <span class="app-etapa-topo">
          <span class="app-bolinha" title="${esc(ajudaStatus)}"></span>
          <span class="app-etapa-nome">${esc(e.nome)}</span>
          <span class="app-etapa-status" title="${esc(ajudaStatus)}">${esc(rotulo)}</span>
        </span>
        ${resumo}
        ${avisoDaEtapa(e)}
      </button>`;
  }

  function ligarEtapas() {
    document.querySelectorAll('#apps-root .app-etapa').forEach((b) => {
      b.addEventListener('click', () => abrirEtapa(b.dataset.slug, b.dataset.etapa));
    });
    ligarCompartilhar();
    reabrirAbertas();
  }

  /**
   * O clique em "Gerar link para o cliente", por DELEGAÇÃO.
   *
   * O botão nasce e morre a cada vez que uma etapa é aberta, fechada ou
   * redesenhada (a aba se reconstrói sozinha a cada minuto). Um listener preso a
   * cada botão morreria junto com ele; um na raiz sobrevive a todos, e é
   * registrado uma vez só graças ao `dataset`.
   */
  function ligarCompartilhar() {
    const raiz = document.getElementById('apps-root');
    if (!raiz || raiz.dataset.compartilharLigado) return;
    raiz.dataset.compartilharLigado = '1';
    raiz.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-compartilhar]');
      if (!b) return;
      ev.preventDefault();
      gerarLink(b.dataset.compartilhar, b);
    });
  }

  /**
   * Devolve à tela as etapas que estavam abertas antes do redesenho.
   *
   * POR QUE ISTO EXISTE. A aba se redesenha sozinha a cada minuto. Sem esta
   * função acontecia o seguinte, e foi visto acontecendo: a pessoa abria o
   * roteiro para ler, o redesenho apagava o texto no meio da leitura, ela
   * clicava de novo para reabrir e NÃO ABRIA NADA — porque para o `abertos`
   * aquela etapa continuava aberta, então o clique era lido como o segundo, o
   * de fechar. Ela precisava clicar duas vezes, sem nenhuma pista do motivo.
   */
  function reabrirAbertas() {
    for (const [slug, etapaKey] of Object.entries(abertos)) {
      if (etapaKey) desenharEtapa(slug, etapaKey);
    }
  }

  /**
   * O clique na etapa. Só decide ABRIR ou FECHAR; quem desenha é `desenharEtapa`.
   *
   * A separação existe por causa do redesenho automático: a aba se reconstrói
   * sozinha a cada minuto (`refreshCurrentPanel`, no app.js) e o `abertos`
   * sobrevive, porque é estado do módulo. Se abrir e desenhar fossem a mesma
   * função, o `reabrirAbertas` de depois do redesenho cairia no toggle e
   * fecharia justamente o que precisava reabrir.
   */
  function abrirEtapa(slug, etapaKey) {
    const alvo = document.getElementById(`etapa-${slug}`);
    if (!alvo) return;

    // Segundo clique na mesma etapa fecha, que é o que a pessoa espera de uma régua.
    if (abertos[slug] === etapaKey) { abertos[slug] = null; alvo.innerHTML = ''; return; }
    abertos[slug] = etapaKey;
    desenharEtapa(slug, etapaKey);
  }

  async function desenharEtapa(slug, etapaKey) {
    const alvo = document.getElementById(`etapa-${slug}`);
    if (!alvo) return;
    alvo.innerHTML = '<div class="app-carregando">Carregando...</div>';

    const r = await pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}`);
    if (!r.ok) { alvo.innerHTML = erro(r.corpo.error || `O painel respondeu ${r.status}.`); return; }

    const etapa = (r.corpo.projeto.etapas || []).find((e) => e.key === etapaKey);
    if (!etapa) { alvo.innerHTML = erro(`A etapa "${etapaKey}" não existe neste conteúdo.`); return; }

    const cabeca = `
      <div class="app-etapa-cabeca">
        <strong>${esc(etapa.nome)}</strong>
        <span class="app-etapa-status" title="${esc(ajudaDoStatus(etapa))}">${esc(STATUS_ROTULO[etapa.status] || etapa.status)}</span>
        ${etapa.origem === 'pasta' ? seloDeduzido() : ''}
        ${etapa.atualizadoEm ? `<span class="app-etapa-meta" title="Quando o arquivo desta etapa foi escrito pela última vez.">${esc(dataCurta(etapa.atualizadoEm))}</span>` : ''}
        ${botaoCompartilhar(slug, etapa)}
      </div>
      <div class="app-compartilhar-saida" id="compartilhar-${esc(slug)}"></div>
      ${etapa.feedback ? `<div class="app-feedback"><strong>O que você pediu para refazer:</strong> ${esc(etapa.feedback)}</div>` : ''}`;

    if (etapa.pasta) {
      alvo.innerHTML = cabeca + '<div class="app-carregando">Carregando o material...</div>';
      await desenharAssets(alvo, cabeca, slug, etapa);
      return;
    }

    if (!etapa.arquivo) {
      alvo.innerHTML = cabeca + vazio(
        'Esta etapa ainda não produziu nada',
        'Quando o agente concluir esta etapa, o arquivo dela aparece aqui.',
      );
      return;
    }

    const a = await pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}/arquivo/${encodeURIComponent(etapa.arquivo)}`);
    if (!a.ok) { alvo.innerHTML = cabeca + erro(a.corpo.error || `O painel respondeu ${a.status}.`); return; }

    const extras = (etapa.extras || []).length
      ? `<div class="app-extras">Junto desta etapa: ${etapa.extras.map((x) => `<button type="button" class="app-extra" data-slug="${esc(slug)}" data-arquivo="${esc(x.arquivo)}">${esc(x.arquivo)}</button>`).join(' ')}</div>`
      : '';

    alvo.innerHTML = cabeca + extras +
      `<div class="app-arquivo-nome">${esc(a.corpo.nome)} · ${esc(bytes(a.corpo.bytes))}</div>` +
      `<div class="app-markdown">${md(a.corpo.texto)}</div>`;

    alvo.querySelectorAll('.app-extra').forEach((b) => {
      b.addEventListener('click', () => abrirExtra(alvo, b.dataset.slug, b.dataset.arquivo));
    });
  }

  async function abrirExtra(alvo, slug, arquivo) {
    const caixa = document.createElement('div');
    caixa.className = 'app-markdown app-extra-corpo';
    caixa.innerHTML = '<div class="app-carregando">Carregando...</div>';
    alvo.appendChild(caixa);
    const a = await pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}/arquivo/${encodeURIComponent(arquivo)}`);
    caixa.innerHTML = a.ok
      ? `<div class="app-arquivo-nome">${esc(arquivo)} · ${esc(bytes(a.corpo.bytes))}</div>` + md(a.corpo.texto)
      : erro(a.corpo.error || `O painel respondeu ${a.status}.`);
  }

  /**
   * O botão que transforma o roteiro num link para mandar ao cliente.
   *
   * SÓ NA ETAPA QUE TEM O ROTEIRO, e não em toda etapa. O que o cliente quer ler
   * é o roteiro; mandar a ele a "pesquisa" ou o "catálogo de assets" soltos seria
   * mandar o rascunho da cozinha. As imagens vão junto porque elas são o que
   * prova o que está escrito, e o cliente lê as duas coisas ao mesmo tempo.
   *
   * A etapa precisa ter arquivo. Um botão de compartilhar num roteiro que ainda
   * não existe só produziria um erro que a pessoa não tinha como prever.
   */
  function botaoCompartilhar(slug, etapa) {
    if (etapa.key !== 'roteiro' || !etapa.arquivo) return '';
    return `<button type="button" class="app-compartilhar" data-compartilhar="${esc(slug)}"
              title="Monta uma página com este roteiro e as imagens dentro, publica, e te devolve um link para mandar ao cliente. Quem abrir não precisa de senha.">
        Gerar link para o cliente
      </button>`;
  }

  /**
   * Gera o link e mostra o resultado.
   *
   * O botão vira "gerando..." e fica DESABILITADO enquanto trabalha, porque cada
   * clique publica um arquivo novo na internet: dois cliques impacientes deixam
   * duas páginas no ar, e a pessoa manda uma e esquece a outra existindo.
   */
  async function gerarLink(slug, botao) {
    const saida = document.getElementById(`compartilhar-${slug}`);
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'gerando...';
    if (saida) saida.innerHTML = '<div class="app-carregando">Montando a página com as imagens dentro. Isso leva alguns segundos.</div>';

    const r = await enviar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}/compartilhar`);
    botao.disabled = false;
    botao.textContent = rotulo;
    if (!saida) return;

    if (!r.ok) {
      const c = r.corpo || {};
      saida.innerHTML = erro(c.error || `O painel respondeu ${r.status}.`)
        + (c.howToFix ? `<div class="app-compartilhar-como">${esc(c.howToFix)}</div>` : '')
        + (c.detalhe ? `<div class="app-compartilhar-como">${esc(c.detalhe)}</div>` : '');
      return;
    }

    const d = r.corpo;
    const fora = d.deFora
      ? ` ${d.deFora} ${d.deFora === 1 ? 'arquivo não entrou' : 'arquivos não entraram'} (a própria página lista quais).`
      : '';
    saida.innerHTML = `<div class="app-compartilhar-ok">
        <div class="app-compartilhar-linha">
          <input type="text" readonly value="${esc(d.url)}" id="url-${esc(slug)}"
                 title="O endereço da página. Mande este link para o cliente.">
          <button type="button" class="app-btn-copiar" data-copiar="url-${esc(slug)}">copiar</button>
          <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" class="app-btn-abrir">abrir</a>
        </div>
        <p class="app-compartilhar-nota">
          Pronto: ${d.embutidos} ${d.embutidos === 1 ? 'imagem entrou' : 'imagens entraram'} dentro do arquivo, ${esc(bytes(d.tamanho))} no total.${esc(fora)}
          Quem abrir este link não precisa de senha, então mande só para quem deve ver.
        </p>
      </div>`;
    const b = saida.querySelector('[data-copiar]');
    if (b) b.addEventListener('click', () => {
      const campo = document.getElementById(b.dataset.copiar);
      if (!campo) return;
      campo.select();
      // O clipboard moderno falha fora de HTTPS em alguns navegadores, e aí o
      // execCommand ainda funciona. Tentar os dois é a diferença entre copiar e
      // a pessoa achar que o botão não faz nada.
      const feito = () => { b.textContent = 'copiado'; setTimeout(() => { b.textContent = 'copiar'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(campo.value).then(feito, () => { document.execCommand('copy'); feito(); });
      else { document.execCommand('copy'); feito(); }
    });
  }

  /** O endereço que serve UM asset. É o mesmo para a miniatura e para o botão de baixar. */
  function urlDoAsset(slug, nome) {
    return `${BASE}/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}`
      + `/asset/${encodeURIComponent(nome)}`;
  }

  /**
   * Os dados de um asset viajam no próprio botão, em `data-`.
   *
   * Guardar a lista numa variável do módulo pareceria mais limpo e seria uma
   * segunda cópia da verdade: a aba se redesenha sozinha a cada minuto, e a cópia
   * viveria mais que os botões que ela descreve. O botão que está na tela carrega
   * o que ele mesmo precisa.
   */
  function itemDoBotao(b) {
    return {
      nome: b.dataset.nome,
      url: b.dataset.url,
      tipo: b.dataset.tipo,
      ext: b.dataset.ext,
      bytes: b.dataset.bytes ? Number(b.dataset.bytes) : null,
    };
  }

  function atributosDoAsset(slug, x) {
    return `data-nome="${esc(x.nome)}" data-url="${esc(urlDoAsset(slug, x.nome))}" `
      + `data-tipo="${esc(x.tipo)}" data-ext="${esc(x.ext || '')}" data-bytes="${esc(x.bytes == null ? '' : x.bytes)}"`;
  }

  /** A grade de miniaturas das imagens. */
  function gradeDeImagens(slug, imagens) {
    return `<div class="app-assets-grade">${imagens.map((x) => `
      <button type="button" class="app-asset-mini" ${atributosDoAsset(slug, x)}
              title="Clique para ver ${esc(x.nome)} em tamanho grande.">
        <span class="app-asset-mini-quadro">
          <img src="${esc(urlDoAsset(slug, x.nome))}" alt="${esc(x.nome)}" loading="lazy">
        </span>
        <span class="app-asset-mini-nome">${esc(x.nome)}</span>
        <span class="app-asset-mini-bytes">${esc(bytes(x.bytes))}</span>
      </button>`).join('')}</div>`;
  }

  /**
   * A lista do que não é imagem.
   *
   * Vídeo, áudio e PDF abrem no visualizador. Planilha, zip e companhia abrem
   * também, e lá dentro encontram a frase que diz que aquele formato não é
   * mostrado por navegador nenhum, com o botão de baixar do lado. O link "baixar"
   * fica na própria linha para quem já sabe o que quer e não precisa do aviso.
   */
  function listaDeAssets(slug, itens) {
    return `<ul class="app-assets-lista">${itens.map((x) => `
      <li>
        <button type="button" class="app-asset-linha" ${atributosDoAsset(slug, x)}
                title="${esc(x.tipo === 'arquivo'
                  ? `${x.nome} não é um formato que o navegador abre. Clique para ver o porquê e baixar.`
                  : `Clique para abrir ${x.nome} aqui mesmo.`)}">
          <span class="app-asset-tipo">${esc(x.tipo)}</span>
          <span class="app-asset-nome">${esc(x.nome)}</span>
          <span class="app-asset-bytes">${esc(bytes(x.bytes))}</span>
        </button>
        <a class="app-asset-baixar" href="${esc(urlDoAsset(slug, x.nome))}" download="${esc(x.nome)}"
           title="Salva ${esc(x.nome)} no seu computador.">baixar</a>
      </li>`).join('')}</ul>`;
  }

  async function desenharAssets(alvo, cabeca, slug, etapa) {
    // A etapa de assets tem DUAS coisas: o catálogo (o que o agente decidiu usar)
    // e a pasta (o que de fato foi baixado). Mostrar as duas é o que deixa visível
    // o caso mais comum de etapa pela metade: catálogo escrito, pasta vazia.
    const [cat, ass] = await Promise.all([
      etapa.arquivo
        ? pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}/arquivo/${encodeURIComponent(etapa.arquivo)}`)
        : Promise.resolve(null),
      pegar(`/api/apps/${encodeURIComponent(appAtual)}/conteudos/${encodeURIComponent(slug)}/assets`),
    ]);

    let html = cabeca;

    if (ass.ok) {
      const lista = ass.corpo.assets || [];
      const imagens = lista.filter((x) => x.tipo === 'imagem');
      const outros = lista.filter((x) => x.tipo !== 'imagem');
      const ajudaContagem = `Arquivos dentro da pasta ${ass.corpo.pasta || 'assets'} deste conteúdo, `
        + 'contados no disco na hora em que você abriu esta etapa. Não é o que o catálogo pediu: é o que está lá.';
      html += lista.length
        ? `<div class="app-assets">
             <div class="app-assets-topo">
               <span class="app-assets-titulo" title="${esc(ajudaContagem)}">${lista.length} arquivo(s) em ${esc(ass.corpo.pasta)}</span>
               <button type="button" class="app-ajuda-secao" data-tutorial="assets"
                       aria-label="O que é este material" title="O que é este material">?</button>
             </div>
             ${imagens.length ? gradeDeImagens(slug, imagens) : ''}
             ${outros.length ? listaDeAssets(slug, outros) : ''}
           </div>`
        : vazio('Nada baixado ainda', ass.corpo.motivo);
    } else {
      html += erro(ass.corpo.error || `O painel respondeu ${ass.status}.`);
    }

    if (cat && cat.ok) {
      html += `<div class="app-arquivo-nome">${esc(cat.corpo.nome)} · ${esc(bytes(cat.corpo.bytes))}</div>` +
        `<div class="app-markdown">${md(cat.corpo.texto)}</div>`;
    } else if (cat && !cat.ok) {
      html += erro(cat.corpo.error || `O painel respondeu ${cat.status}.`);
    }

    alvo.innerHTML = html;

    // Os listeners nascem depois do innerHTML, e morrem com ele no próximo
    // redesenho. Não há o que desligar: quem some é o botão inteiro.
    alvo.querySelectorAll('.app-asset-mini, .app-asset-linha').forEach((b) => {
      b.addEventListener('click', () => window.DGVisualizador.abrir(itemDoBotao(b)));
    });
  }

  window.DGApps = { carregar };
})();
