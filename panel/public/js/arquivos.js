// arquivos.js — a tela da aba Pasta.
//
// O QUE ELA MOSTRA: a pasta de trabalho do agente. O que ele guardou enquanto
// trabalhava, e o que o dono sobe para ele usar. As outras abas contam o que o
// agente é e o que ele fez; esta abre a gaveta.
//
// A RAIZ É `<agentDir>/arquivos` E ISSO NÃO É NEGOCIÁVEL. A trava mora no
// servidor, em `lib/arquivos.js`, e o porquê está escrito no topo daquele arquivo:
// a pasta do agente também tem credencial e alma dele, e quem abre este painel é o
// dono, que quer ver o material do trabalho. Aqui na tela a consequência é que a
// trilha de navegação começa em "Pasta do agente" e não sobe mais do que isso.
//
// POR QUE ESTE ARQUIVO NÃO USA O `API.get`, igual à aba Apps: aquele wrapper
// devolve `null` quando a resposta não é 200, e com isso o MOTIVO que o servidor
// escreveu morre no caminho. Toda falha aqui tem que chegar na pessoa com a frase
// que explica o que aconteceu e o que fazer, senão a aba vira "erro ao enviar".
//
// O QUE ELA PEGA EMPRESTADO E NÃO REESCREVE: o visualizador (js/visualizador.js) e
// o motor do tutorial (js/tutorial.js). Os dois nasceram na aba Apps e saíram de lá
// justamente para não existirem em duas versões.

(function () {
  const BASE = window.DGCLAW_BASE || '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function bytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function quando(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : '';
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

  const pegar = (url) => chamar(url);

  /** A frase do servidor, com o "o que fazer" junto quando ele mandou um. */
  function motivoDoErro(r) {
    const c = r.corpo || {};
    if (c.error && c.howToFix) return `${c.error} ${c.howToFix}`;
    return c.error || `O painel respondeu ${r.status}.`;
  }

  function vazio(titulo, motivo) {
    return `<div class="app-vazio"><strong>${esc(titulo)}</strong><p>${esc(motivo || '')}</p></div>`;
  }

  function erro(motivo) {
    return `<div class="app-erro"><strong>Não consegui fazer isto.</strong><p>${esc(motivo)}</p></div>`;
  }

  // ─── Tutorial da tela ───────────────────────────────────────────────────
  // Regra do repo: nenhuma tela nasce muda. Cada passo responde o que é, como a
  // conta é feita e por que aquilo está aqui. O motor é o de js/tutorial.js.

  function passosDoTutorial() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'Esta é a gaveta do agente',
        corpo: 'Tudo o que ele guarda enquanto trabalha fica aqui: pesquisa, roteiro, planilha, imagem que ele baixou. Você pode ler, corrigir, baixar, apagar, e também subir um arquivo para ele usar.',
        porque: 'Antes desta aba, mandar um arquivo para o agente exigia acesso à máquina. Agora é um botão, e o que ele produz deixa de morar num lugar que só o Danilo alcança.',
      },
      {
        chave: 'trilha',
        alvo: '#arquivos-root .arq-trilha',
        titulo: 'Onde você está, e como voltar',
        corpo: 'A trilha começa sempre em "Pasta do agente" e mostra o caminho até a pasta aberta. Clique em qualquer pedaço para voltar para ele.',
        porque: '"Pasta do agente" é o topo de verdade, e não uma escolha de tela: acima dela ficam a configuração e as credenciais dele, que esta aba não abre para ninguém.',
      },
      {
        chave: 'lista',
        alvo: '#arquivos-root .arq-lista',
        titulo: 'As pastas vêm antes dos arquivos',
        corpo: 'Cada linha traz o nome, o tamanho e quando foi mexido pela última vez. Clicar numa pasta entra nela; nos arquivos, os botões da direita dizem o que dá para fazer com cada um.',
        porque: 'Pasta antes de arquivo porque esta lista serve para navegar, e quem procura onde entrar não deveria garimpar no meio de trinta arquivos de texto.',
      },
      {
        chave: 'acoes',
        alvo: '#arquivos-root .arq-linha-acoes',
        titulo: 'Ver, Editar, Baixar e Apagar',
        corpo: 'Ver abre na hora: texto aqui embaixo, imagem e vídeo numa janela por cima. Editar só aparece em arquivo de texto. Apagar sempre pergunta antes, dizendo o nome.',
        porque: 'Editar um .xlsx como texto destruiria a planilha, então o botão simplesmente não existe nesses. E apagar em um clique é o tipo de facilidade da qual ninguém se lembra com carinho.',
      },
      {
        chave: 'subir',
        alvo: '#arquivos-root .arq-subir',
        titulo: 'Subir um arquivo para o agente',
        corpo: 'Escolha um arquivo do seu computador e ele é guardado na pasta que está aberta agora. Se já existir um com o mesmo nome, eu aviso em vez de escrever por cima.',
        porque: 'Sobrescrever calado apagaria um trabalho do agente sem ninguém saber. E o limite é 25 MB: acima disso, peça a ele na aba Conversa, que ele busca sozinho.',
      },
    ];
  }

  function abrirTutorial(comecarEm) {
    window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  // ─── Estado da tela ──────────────────────────────────────────
  // Só o suficiente para saber onde a pessoa está e o que ela abriu. A verdade
  // continua no servidor: toda navegação busca a pasta de novo.
  let caminhoAtual = '';
  let aberto = null; // { rel, modo: 'ver' | 'editar' }
  let aviso = null;  // { tipo: 'ok' | 'erro' | 'andando', texto }

  function raiz() { return document.getElementById('arquivos-root'); }

  function urlBaixar(rel) {
    return `${BASE}/api/arquivos/baixar?path=${encodeURIComponent(rel)}`;
  }

  function juntar(pasta, nome) {
    return pasta ? `${pasta}/${nome}` : nome;
  }

  /**
   * Redesenha a aba inteira.
   *
   * ELA SE RECUSA A REDESENHAR ENQUANTO ALGUÉM ESTÁ EDITANDO. O painel recarrega
   * a aba aberta a cada minuto, e sem esta guarda o texto que a pessoa estava
   * digitando sumiria no meio da frase, sem aviso e sem volta. A lista espera; o
   * trabalho dela, não.
   */
  async function carregar() {
    const el = raiz();
    if (!el) return;
    if (aberto && aberto.modo === 'editar') return;

    // O "Carregando..." VAI DENTRO DO #arq-corpo, e não ao lado dele.
    //
    // Era assim: `el.innerHTML = cabecalho() + '<div>Carregando...</div>'`. Só que
    // o cabecalho() já termina com o `<div id="arq-corpo">`, então o aviso nascia
    // como IRMÃO dele, e daí em diante só o #arq-corpo era reescrito. Resultado: o
    // "Carregando..." ficava para sempre embaixo do conteúdo, em toda visita à
    // aba. Numa pasta cheia ele se escondia no fim de uma lista longa; numa pasta
    // vazia ficava logo abaixo do aviso, e a tela dizia ao mesmo tempo que a pasta
    // estava vazia e que ainda estava carregando.
    el.innerHTML = cabecalho();
    ligarCabecalho();
    const corpoInicial = document.getElementById('arq-corpo');
    if (corpoInicial) corpoInicial.innerHTML = '<div class="app-carregando">Carregando...</div>';

    const r = await pegar(`/api/arquivos?path=${encodeURIComponent(caminhoAtual)}`);
    const alvo = document.getElementById('arq-corpo');
    if (!alvo) return;

    if (!r.ok) {
      // Caminho que não existe mais (pasta renomeada pelo agente, por exemplo)
      // devolve a pessoa para a raiz, que é o único lugar que sempre responde.
      alvo.innerHTML = erro(motivoDoErro(r))
        + (caminhoAtual ? '<button type="button" class="btn-leve arq-voltar-raiz">voltar para a pasta do agente</button>' : '');
      const b = alvo.querySelector('.arq-voltar-raiz');
      if (b) b.addEventListener('click', () => { caminhoAtual = ''; aberto = null; carregar(); });
      return;
    }

    alvo.innerHTML = trilha(r.corpo.caminho) + barraDeAcoes() + areaDeAviso() + lista(r.corpo) + '<div id="arq-aberto"></div>';
    ligarLista();

    // O que estava aberto para leitura volta a abrir depois do redesenho. Sem
    // isto, quem estava lendo um roteiro perdia o texto na virada do minuto.
    if (aberto && aberto.modo === 'ver') mostrarTexto(aberto.rel);
  }

  function cabecalho() {
    const ajuda = 'A pasta onde este agente guarda o que produz, e onde você pode deixar arquivo para ele. '
      + 'É só esta pasta: a configuração e as credenciais dele ficam fora daqui e não abrem nesta tela.';
    return `<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(ajuda)}">Pasta do agente</h2>
          <button type="button" class="app-tutorial-abrir" id="arq-tutorial-abrir"
                  title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="tela"
                  aria-label="O que é esta pasta" title="O que é esta pasta">?</button>
        </div>
        <p>${esc(ajuda)}</p>
      </div>
      <div id="arq-corpo"></div>`;
  }

  function ligarCabecalho() {
    const el = raiz();
    const b = document.getElementById('arq-tutorial-abrir');
    if (b) b.addEventListener('click', () => abrirTutorial());
    // Delegação: os "?" nascem e morrem a cada redesenho, e um listener na raiz
    // sobrevive a todos eles.
    if (el && !el.dataset.ajudaLigada) {
      el.dataset.ajudaLigada = '1';
      el.addEventListener('click', (ev) => {
        const alvo = ev.target.closest('.app-ajuda-secao');
        if (!alvo) return;
        ev.stopPropagation();
        abrirTutorial(alvo.dataset.tutorial);
      });
    }
  }

  function trilha(caminho) {
    const partes = (caminho || '').split('/').filter(Boolean);
    const pedacos = [
      `<button type="button" class="arq-trilha-item" data-ir=""
               title="Volta para o topo da pasta de arquivos do agente.">Pasta do agente</button>`,
    ];
    let acumulado = '';
    partes.forEach((parte, i) => {
      acumulado = acumulado ? `${acumulado}/${parte}` : parte;
      const ultima = i === partes.length - 1;
      pedacos.push('<span class="arq-trilha-sep" aria-hidden="true">/</span>');
      pedacos.push(ultima
        ? `<span class="arq-trilha-item atual" title="Você está aqui.">${esc(parte)}</span>`
        : `<button type="button" class="arq-trilha-item" data-ir="${esc(acumulado)}"
                   title="Voltar para ${esc(parte)}.">${esc(parte)}</button>`);
    });
    return `<nav class="arq-trilha" aria-label="Onde você está">${pedacos.join('')}</nav>`;
  }

  function barraDeAcoes() {
    return `<div class="arq-barra">
        <span class="arq-barra-dica" title="O arquivo é guardado na pasta que está aberta agora, e o limite é 25 MB por arquivo.">
          o arquivo vai para a pasta aberta acima
        </span>
        <button type="button" class="arq-subir" id="arq-subir"
                title="Escolhe um arquivo do seu computador e guarda na pasta aberta. Limite de 25 MB. Se já existir um com o mesmo nome, eu aviso em vez de escrever por cima.">
          Subir arquivo
        </button>
        <input type="file" id="arq-file" class="arq-file" hidden>
      </div>`;
  }

  function areaDeAviso() {
    if (!aviso) return '<div id="arq-aviso"></div>';
    const classe = aviso.tipo === 'erro' ? 'app-erro' : aviso.tipo === 'andando' ? 'arq-aviso-andando' : 'arq-aviso-ok';
    if (aviso.tipo === 'erro') {
      return `<div id="arq-aviso">${erro(aviso.texto)}</div>`;
    }
    return `<div id="arq-aviso"><div class="${classe}">${esc(aviso.texto)}</div></div>`;
  }

  function mostrarAviso(tipo, texto) {
    aviso = { tipo, texto };
    const el = document.getElementById('arq-aviso');
    if (!el) return;
    el.outerHTML = areaDeAviso();
  }

  function limparAviso() {
    aviso = null;
    const el = document.getElementById('arq-aviso');
    if (el) el.innerHTML = '';
  }

  function lista(dados) {
    const pastas = dados.pastas || [];
    const arquivos = dados.arquivos || [];
    if (!pastas.length && !arquivos.length) {
      return `<div class="arq-lista">${vazio('Nada nesta pasta', dados.motivo)}</div>`;
    }

    const linhasPasta = pastas.map((p) => `
      <li class="arq-linha">
        <button type="button" class="arq-linha-nome" data-pasta="${esc(p.nome)}"
                title="Abrir a pasta ${esc(p.nome)}.">
          <span class="arq-ico" aria-hidden="true">▤</span>
          <span class="arq-nome">${esc(p.nome)}</span>
        </button>
        <span class="arq-meta" title="Quando alguma coisa dentro desta pasta mudou pela última vez.">${esc(quando(p.em))}</span>
        <span class="arq-linha-acoes"><span class="arq-tag" title="É uma pasta. Clique no nome para entrar.">pasta</span></span>
      </li>`).join('');

    const linhasArquivo = arquivos.map((a) => {
      const rel = juntar(dados.caminho, a.nome);
      const botoes = [];
      botoes.push(`<button type="button" class="arq-btn" data-ver="${esc(rel)}" data-tipo="${esc(a.tipo)}"
                     data-ext="${esc(a.ext || '')}" data-bytes="${esc(a.bytes == null ? '' : a.bytes)}"
                     data-nome="${esc(a.nome)}" data-editavel="${a.editavel ? '1' : ''}"
                     title="${esc(a.editavel
                       ? 'Abre o texto deste arquivo aqui embaixo, só para ler.'
                       : 'Abre este arquivo numa janela por cima da tela.')}">Ver</button>`);
      if (a.editavel) {
        botoes.push(`<button type="button" class="arq-btn" data-editar="${esc(rel)}"
                       title="Abre o texto numa caixa para você corrigir e salvar por cima.">Editar</button>`);
      }
      botoes.push(`<a class="arq-btn" href="${esc(urlBaixar(rel))}" download="${esc(a.nome)}"
                     title="Salva ${esc(a.nome)} no seu computador.">Baixar</a>`);
      botoes.push(`<button type="button" class="arq-btn perigo" data-apagar="${esc(rel)}" data-nome="${esc(a.nome)}"
                     title="Apaga ${esc(a.nome)} da pasta do agente. Eu pergunto antes.">Apagar</button>`);

      return `
        <li class="arq-linha">
          <button type="button" class="arq-linha-nome" data-ver="${esc(rel)}" data-tipo="${esc(a.tipo)}"
                  data-ext="${esc(a.ext || '')}" data-bytes="${esc(a.bytes == null ? '' : a.bytes)}"
                  data-nome="${esc(a.nome)}" data-editavel="${a.editavel ? '1' : ''}"
                  title="Abrir ${esc(a.nome)}.">
            ${miniatura(a, rel)}
            <span class="arq-nome">${esc(a.nome)}</span>
          </button>
          <span class="arq-meta" title="Tamanho do arquivo no disco e quando ele foi salvo pela última vez.">${esc(bytes(a.bytes))} · ${esc(quando(a.em))}</span>
          <span class="arq-linha-acoes">${botoes.join('')}</span>
        </li>`;
    }).join('');

    return `<ul class="arq-lista">${linhasPasta}${linhasArquivo}</ul>`;
  }

  /**
   * O quadradinho à esquerda do nome. Imagem vira a PRÓPRIA imagem.
   *
   * Numa pasta de assets, o ícone `▩` responde "isto é uma imagem", que é a
   * única coisa que a pessoa já sabia: ela acabou de ler o nome do arquivo. O
   * que ela quer é ver QUAL imagem, e para isso tinha que abrir uma por uma.
   *
   * `loading="lazy"` porque uma pasta com sessenta prints não pode baixar
   * sessenta arquivos para desenhar uma lista. E o `onerror` troca a miniatura
   * quebrada pelo ícone de volta: um arquivo com extensão de imagem e conteúdo
   * corrompido existe, e um retângulo quebrado no meio da lista faria a pessoa
   * achar que o painel falhou, quando quem está errado é o arquivo.
   */
  function miniatura(a, rel) {
    const icone = a.tipo === 'video' ? '▷' : a.tipo === 'audio' ? '∿' : '▢';
    if (a.tipo !== 'imagem') {
      return `<span class="arq-ico" aria-hidden="true">${icone}</span>`;
    }
    return `<span class="arq-ico arq-ico-img" aria-hidden="true">` +
      `<img src="${esc(urlBaixar(rel))}" alt="" loading="lazy" decoding="async"` +
      ` onerror="this.parentNode.textContent='▩'"></span>`;
  }

  function ligarLista() {
    const el = raiz();
    if (!el) return;

    el.querySelectorAll('.arq-trilha-item[data-ir]').forEach((b) => {
      b.addEventListener('click', () => { caminhoAtual = b.dataset.ir; aberto = null; limparAviso(); carregar(); });
    });
    el.querySelectorAll('[data-pasta]').forEach((b) => {
      b.addEventListener('click', () => {
        caminhoAtual = juntar(caminhoAtual, b.dataset.pasta);
        aberto = null;
        limparAviso();
        carregar();
      });
    });
    el.querySelectorAll('[data-ver]').forEach((b) => {
      b.addEventListener('click', () => abrirArquivo(b));
    });
    el.querySelectorAll('[data-editar]').forEach((b) => {
      b.addEventListener('click', () => mostrarEditor(b.dataset.editar));
    });
    el.querySelectorAll('[data-apagar]').forEach((b) => {
      b.addEventListener('click', () => apagar(b.dataset.apagar, b.dataset.nome));
    });

    const btn = document.getElementById('arq-subir');
    const campo = document.getElementById('arq-file');
    if (btn && campo) {
      btn.addEventListener('click', () => campo.click());
      campo.addEventListener('change', () => {
        const arquivo = campo.files && campo.files[0];
        if (arquivo) subir(arquivo);
        // Zera o campo para o mesmo arquivo poder ser escolhido de novo depois de
        // um erro. Sem isto, o `change` não dispara na segunda tentativa e a tela
        // parece ter ignorado o clique.
        campo.value = '';
      });
    }
  }

  /**
   * O clique em "Ver".
   *
   * Texto abre aqui embaixo, na própria página, porque é para ler com calma e
   * comparar com o resto da lista. Imagem, vídeo, áudio e PDF abrem na janela por
   * cima, que é onde eles cabem grandes. O resto também abre a janela, e lá dentro
   * encontra a frase dizendo que aquele formato não é aberto por navegador nenhum.
   */
  function abrirArquivo(b) {
    const rel = b.dataset.ver;
    if (b.dataset.editavel) {
      if (aberto && aberto.rel === rel && aberto.modo === 'ver') { aberto = null; limparAberto(); return; }
      aberto = { rel, modo: 'ver' };
      mostrarTexto(rel);
      return;
    }
    window.DGVisualizador.abrir({
      nome: b.dataset.nome,
      url: urlBaixar(rel),
      tipo: b.dataset.tipo,
      ext: b.dataset.ext,
      bytes: b.dataset.bytes ? Number(b.dataset.bytes) : null,
    });
  }

  function limparAberto() {
    const caixa = document.getElementById('arq-aberto');
    if (caixa) caixa.innerHTML = '';
  }

  async function mostrarTexto(rel) {
    const caixa = document.getElementById('arq-aberto');
    if (!caixa) return;
    caixa.innerHTML = '<div class="app-carregando">Carregando...</div>';
    const r = await pegar(`/api/arquivos/conteudo?path=${encodeURIComponent(rel)}`);
    if (!r.ok) { caixa.innerHTML = erro(motivoDoErro(r)); return; }
    const c = r.corpo;
    caixa.innerHTML = `<div class="arq-aberto-caixa">
        <div class="arq-aberto-topo">
          <strong title="O arquivo aberto agora.">${esc(c.nome)}</strong>
          <span class="arq-meta">${esc(bytes(c.bytes))} · ${esc(quando(c.em))}</span>
          <button type="button" class="arq-btn" id="arq-fechar" title="Fecha esta leitura e volta só para a lista.">Fechar</button>
        </div>
        <pre class="arq-texto">${esc(c.texto || '')}</pre>
      </div>`;
    const f = document.getElementById('arq-fechar');
    if (f) f.addEventListener('click', () => { aberto = null; limparAberto(); });
  }

  /**
   * O editor.
   *
   * Sem markdown, sem realce: um `<textarea>` com o texto exatamente como está no
   * disco. Editar arquivo do agente é operação de precisão, e qualquer coisa que
   * "embeleze" o conteúdo entre a leitura e a gravação é uma chance de salvar algo
   * diferente do que a pessoa viu.
   */
  async function mostrarEditor(rel) {
    const caixa = document.getElementById('arq-aberto');
    if (!caixa) return;
    caixa.innerHTML = '<div class="app-carregando">Carregando...</div>';
    const r = await pegar(`/api/arquivos/conteudo?path=${encodeURIComponent(rel)}`);
    if (!r.ok) { caixa.innerHTML = erro(motivoDoErro(r)); return; }
    const c = r.corpo;
    if (!c.editavel) { caixa.innerHTML = erro(`"${c.nome}" não é um arquivo de texto, então não dá para editar aqui.`); return; }

    aberto = { rel, modo: 'editar' };
    caixa.innerHTML = `<div class="arq-aberto-caixa">
        <div class="arq-aberto-topo">
          <strong title="O arquivo que você está editando. O que for salvo aqui sobrescreve o que está no disco.">${esc(c.nome)}</strong>
          <span class="arq-meta">${esc(bytes(c.bytes))} · ${esc(quando(c.em))}</span>
        </div>
        <textarea class="arq-editor" id="arq-editor" spellcheck="false"
                  aria-label="Conteúdo de ${esc(c.nome)}">${esc(c.texto || '')}</textarea>
        <div class="arq-editor-acoes">
          <button type="button" class="arq-btn principal" id="arq-salvar"
                  title="Grava este texto por cima do arquivo, na hora.">Salvar</button>
          <button type="button" class="arq-btn" id="arq-cancelar"
                  title="Fecha sem gravar nada. O arquivo continua como está no disco.">Cancelar</button>
          <span class="arq-editor-recado" id="arq-editor-recado"></span>
        </div>
      </div>`;

    document.getElementById('arq-cancelar').addEventListener('click', () => {
      aberto = null;
      limparAberto();
      carregar();
    });
    document.getElementById('arq-salvar').addEventListener('click', () => salvar(rel));
  }

  async function salvar(rel) {
    const area = document.getElementById('arq-editor');
    const recado = document.getElementById('arq-editor-recado');
    const botao = document.getElementById('arq-salvar');
    if (!area) return;
    if (recado) { recado.className = 'arq-editor-recado'; recado.textContent = 'salvando...'; }
    if (botao) botao.disabled = true;

    const r = await chamar(`/api/arquivos?path=${encodeURIComponent(rel)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: area.value }),
    });

    if (botao) botao.disabled = false;
    if (!r.ok) {
      // O texto digitado NÃO é descartado: o editor continua aberto com o que a
      // pessoa escreveu, e o motivo aparece ao lado do botão. Recarregar aqui
      // jogaria fora o trabalho dela por causa de uma falha do servidor.
      if (recado) { recado.className = 'arq-editor-recado ruim'; recado.textContent = motivoDoErro(r); }
      return;
    }
    // O aviso é posto ANTES do redesenho de propósito: o `carregar` reimprime o
    // aviso que estiver no estado, então a frase sobrevive à troca da lista.
    aberto = null;
    mostrarAviso('ok', `Salvo: ${rel}`);
    await carregar();
  }

  /**
   * Apagar SEMPRE pergunta, e a pergunta diz o nome do arquivo.
   *
   * Não é formalidade: a lista se redesenha sozinha a cada minuto, e um clique que
   * apaga na hora acerta o arquivo errado com uma facilidade desconfortável.
   */
  async function apagar(rel, nome) {
    const certeza = window.confirm(
      `Apagar "${nome}"?\n\nEle sai da pasta do agente e não vai para lixeira nenhuma. `
      + 'Se ele fizer parte de um trabalho em andamento, o agente vai sentir falta.',
    );
    if (!certeza) return;

    mostrarAviso('andando', `apagando ${nome}...`);
    const r = await chamar(`/api/arquivos?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
    if (!r.ok) { mostrarAviso('erro', motivoDoErro(r)); return; }
    if (aberto && aberto.rel === rel) aberto = null;
    await carregar();
    mostrarAviso('ok', `Apagado: ${nome}`);
  }

  /**
   * Sobe um arquivo.
   *
   * O CORPO DO POST É O ARQUIVO INTEIRO, e nada mais: nome e pasta viajam na URL.
   * Sem formulário multipart, e por isso sem multer nem dependência nova no
   * painel, que hoje tem três e é bom que continue assim.
   *
   * O `Content-Type` VAI FIXO EM `application/octet-stream` DE PROPÓSITO. O
   * servidor tem um `express.json()` global que roda antes das rotas: se o
   * navegador anunciasse o tipo real de um .json subido pelo dono, o arquivo seria
   * engolido pelo parser errado e chegaria na rota como objeto, nunca como
   * arquivo. Trocar esta linha por `body: arquivo` sem o cabeçalho quebra
   * exatamente esse caso, e só ele, que é o pior tipo de quebra.
   */
  async function subir(arquivo) {
    mostrarAviso('andando', `enviando ${arquivo.name}...`);
    const url = `/api/arquivos/upload?path=${encodeURIComponent(caminhoAtual)}&nome=${encodeURIComponent(arquivo.name)}`;
    const r = await chamar(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: arquivo,
    });
    if (!r.ok) { mostrarAviso('erro', motivoDoErro(r)); return; }
    await carregar();
    mostrarAviso('ok', `Guardado: ${arquivo.name} (${bytes(r.corpo.bytes)})`);
  }

  window.DGArquivos = { carregar };
})();
