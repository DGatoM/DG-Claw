// arquivos.js — a aba Pasta: o que o agente guarda, e o que o dono sobe para ele.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  A RAIZ É `<agentDir>/arquivos`, E NADA ACIMA DISSO EXISTE PARA ESTA ABA. ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Esta é a decisão mais fácil de alguém desfazer sem perceber, e por isso ela
// está no topo do arquivo, e não escondida numa constante no meio.
//
// A tentação é óbvia: `agentDir` já é a raiz de tudo, o `lib/sanitize.js` já é
// ancorado nele, e apontar esta aba para lá daria "acesso à pasta do agente",
// que foi literalmente o que o Danilo pediu. Só que a pasta do agente tem
// `.dgclaw/creds`, `.plataforma/identidade.md`, `.claude/` e os arquivos de alma
// dele. Quem abre este painel é a Marta e o Paulo, e nenhum dos dois pediu para
// ver credencial nenhuma: eles querem ver o material do trabalho.
//
// Então a aba enxerga UMA pasta, `arquivos/`, que é onde o agente já guarda o que
// produz (os projetos da aba Apps moram em `arquivos/projetos/`). Tudo que está
// fora dela não é "escondido": é inexistente para este módulo, e um pedido que
// aponte para fora volta como erro, não como lista vazia.
//
// A PASTA NÃO É CRIADA POR AQUI. Se `arquivos/` não existe, `listar('')` devolve
// lista vazia com o motivo escrito. Criar a pasta sozinho faria o painel mentir
// duas vezes: diria que o agente tem um lugar de trabalho que ele nunca usou, e
// esconderia do dono o fato de que o agente ainda não guardou nada.
//
// AS TRÊS CAMADAS DE CONFERÊNCIA, em toda função sem exceção:
//   1. o caminho pedido é relativo, sem `..`, sem segmento que comece com ponto;
//   2. o caminho resolvido cai dentro da RAIZ (`dentroDe`);
//   3. o caminho REAL, com link simbólico já seguido, também cai dentro da RAIZ.
// A terceira existe porque as duas primeiras olham para o texto do caminho, e um
// atalho chamado `notas` apontando para `/etc` passa nas duas.

const fs = require('fs');
const path = require('path');
const { extDe, mimeDaExt, tipoDaExt } = require('./mime');

/**
 * As extensões que a tela abre como TEXTO, e portanto deixa editar.
 *
 * A lista é de coisas que o agente escreve e o dono lê ou corrige. Nada de
 * binário entra aqui: um .xlsx aberto como texto viraria uma parede de lixo, e
 * salvar por cima destruiria a planilha.
 */
const EXT_TEXTO = ['md', 'txt', 'json', 'csv', 'yml', 'yaml', 'log', 'sh', 'py', 'js', 'html', 'css'];

/**
 * Teto de 2 MB para abrir e para salvar texto.
 *
 * Não é medo de disco: é a tela. Um .log de 400 MB abriria um `<textarea>` que
 * trava o navegador do dono, e ele não teria como saber por que a aba congelou.
 * Acima do teto a resposta diz o tamanho, que é a informação com a qual ele
 * decide o que fazer.
 */
const TETO_TEXTO = 2 * 1024 * 1024;

/**
 * Nome aceito num arquivo que CHEGA pelo upload.
 *
 * É mais estreito do que o que a navegação aceita, e de propósito: o que já está
 * na pasta foi o agente que criou e a tela precisa conseguir listar, aconteça o
 * que acontecer com o nome. O que entra pelo painel, não: aí quem escolhe as
 * regras somos nós, e a regra é começar por letra ou número e não trazer barra,
 * ponto inicial nem caractere de controle.
 */
const NOME_UPLOAD_OK = /^[A-Za-z0-9À-ſ][A-Za-z0-9À-ſ ._()+-]{0,180}$/;

/** `alvo` está mesmo dentro de `base`? Resolve os dois antes de comparar. */
function dentroDe(base, alvo) {
  const b = path.resolve(base);
  const a = path.resolve(alvo);
  return a === b || a.startsWith(b + path.sep);
}

function buildArquivos(config) {
  const RAIZ = path.resolve(config.agentDir, 'arquivos');

  function existe(p) {
    try { return fs.existsSync(p); } catch { return false; }
  }

  /**
   * O caminho pedido pela URL vira caminho de disco, ou vira erro com motivo.
   *
   * Devolve `{ caminho, rel }` no caminho feliz, e `{ erro, status }` em qualquer
   * recusa. NENHUMA função deste módulo toca no disco sem passar por aqui antes.
   */
  function resolver(rel) {
    const bruto = typeof rel === 'string' ? rel : '';
    if (bruto.includes('\0')) {
      return { erro: 'Pedido inválido: o caminho tem um caractere que não pode existir em nome de arquivo.', status: 400 };
    }
    if (path.isAbsolute(bruto)) {
      return {
        erro: 'Pedido inválido: esta aba só aceita caminho relativo à pasta do agente. ' +
          'Volte para a raiz pela trilha lá em cima e navegue clicando nas pastas.',
        status: 400,
      };
    }

    // Barra dupla e barra no fim são digitação, não intenção: some com elas antes
    // de julgar os segmentos, senão um `notas//` viraria um segmento vazio e uma
    // recusa que a pessoa não entenderia.
    const partes = bruto.split('/').filter((p) => p !== '');
    for (const parte of partes) {
      if (parte === '.' || parte === '..') {
        return {
          erro: 'Pedido inválido: caminho com ".." não é aceito. ' +
            'Esta aba enxerga só a pasta de arquivos do agente, e nada acima dela.',
          status: 400,
        };
      }
      if (parte.startsWith('.')) {
        return {
          erro: `Pedido inválido: "${parte}" começa com ponto. ` +
            'Arquivo e pasta que começam com ponto são configuração interna do agente, e esta aba não mostra nenhum.',
          status: 400,
        };
      }
    }

    const limpo = partes.join('/');
    const caminho = path.resolve(RAIZ, limpo);
    if (!dentroDe(RAIZ, caminho)) {
      return { erro: 'Pedido inválido: esse caminho cai fora da pasta de arquivos do agente.', status: 400 };
    }

    // Terceira camada: o caminho REAL, com atalho já seguido. Só vale para o que
    // já existe; o que ainda vai nascer (o upload) é conferido pela pasta-mãe.
    if (existe(caminho)) {
      let real;
      try {
        real = fs.realpathSync(caminho);
      } catch (err) {
        return { erro: `Não consegui resolver o caminho "${limpo}": ${err.message}`, status: 500 };
      }
      let raizReal = RAIZ;
      try { raizReal = fs.realpathSync(RAIZ); } catch { /* raiz ainda não existe */ }
      if (!dentroDe(raizReal, real)) {
        return {
          erro: `"${limpo}" é um atalho que aponta para fora da pasta do agente, então eu não abro.`,
          status: 400,
        };
      }
    }

    return { caminho, rel: limpo };
  }

  function ehTexto(ext) {
    return EXT_TEXTO.includes(String(ext || '').toLowerCase());
  }

  function mtime(p) {
    try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
  }

  /**
   * O conteúdo de uma pasta: subpastas primeiro, arquivos depois, em ordem
   * alfabética dentro de cada grupo.
   *
   * Pasta antes de arquivo porque a lista é usada para NAVEGAR, e quem procura
   * onde entrar não quer garimpar entre trinta .md. Dotfile fica de fora, que é a
   * mesma regra do `resolver`: se não dá para abrir, não faz sentido listar.
   */
  function listar(rel) {
    const r = resolver(rel);
    if (r.erro) return r;

    if (!existe(r.caminho)) {
      if (!r.rel) {
        return {
          caminho: '',
          pastas: [],
          arquivos: [],
          motivo:
            'O agente ainda não guardou nada. A pasta de arquivos dele nasce sozinha ' +
            'no primeiro trabalho que ele salvar, e a partir daí o que estiver lá aparece aqui.',
        };
      }
      return { erro: `Não achei a pasta "${r.rel}". Ela pode ter sido renomeada ou apagada.`, status: 404 };
    }

    let st;
    try { st = fs.statSync(r.caminho); } catch (err) {
      return { erro: `Não consegui abrir "${r.rel || 'a pasta de arquivos'}": ${err.message}`, status: 500 };
    }
    if (!st.isDirectory()) {
      return { erro: `"${r.rel}" é um arquivo, não uma pasta. Use o botão Ver para abrir.`, status: 400 };
    }

    let entradas;
    try {
      entradas = fs.readdirSync(r.caminho, { withFileTypes: true });
    } catch (err) {
      return { erro: `Não consegui ler "${r.rel || 'a pasta de arquivos'}": ${err.message}`, status: 500 };
    }

    const pastas = [];
    const arquivos = [];
    for (const e of entradas) {
      if (e.name.startsWith('.')) continue;
      const cheio = path.join(r.caminho, e.name);
      if (e.isDirectory()) {
        pastas.push({ nome: e.name, em: mtime(cheio) });
      } else if (e.isFile()) {
        const ext = extDe(e.name);
        let bytes = null;
        try { bytes = fs.statSync(cheio).size; } catch { bytes = null; }
        arquivos.push({ nome: e.name, bytes, em: mtime(cheio), tipo: tipoDaExt(ext), ext, editavel: ehTexto(ext) });
      }
      // Link simbólico e o resto ficam de fora da lista: o `resolver` não deixaria
      // abrir de qualquer forma, e listar o que não abre só gera clique frustrado.
    }
    const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
    pastas.sort(porNome);
    arquivos.sort(porNome);

    return {
      caminho: r.rel,
      pastas,
      arquivos,
      motivo: pastas.length || arquivos.length
        ? null
        : `A pasta "${r.rel || 'arquivos'}" existe, mas está vazia.`,
    };
  }

  /** O que a tela precisa para abrir um arquivo: o texto, ou o aviso de que não é texto. */
  function ler(rel) {
    const r = resolver(rel);
    if (r.erro) return r;

    let st;
    try { st = fs.lstatSync(r.caminho); } catch {
      return { erro: `Não achei o arquivo "${r.rel}". Ele pode ter sido renomeado ou apagado.`, status: 404 };
    }
    if (!st.isFile()) {
      return { erro: `"${r.rel}" não é um arquivo comum, então eu não abro.`, status: 400 };
    }

    const nome = path.basename(r.caminho);
    const ext = extDe(nome);

    if (!ehTexto(ext)) {
      return { nome, caminho: r.rel, bytes: st.size, em: mtime(r.caminho), editavel: false, mime: mimeDaExt(ext), tipo: tipoDaExt(ext), ext };
    }
    if (st.size > TETO_TEXTO) {
      return {
        erro:
          `"${nome}" tem ${(st.size / (1024 * 1024)).toFixed(1)} MB, e o limite para abrir na tela é 2 MB. ` +
          'Arquivo maior que isso trava o navegador em vez de mostrar alguma coisa. Use o botão Baixar para ver o arquivo inteiro no seu computador.',
        status: 413,
      };
    }
    try {
      return {
        nome,
        caminho: r.rel,
        texto: fs.readFileSync(r.caminho, 'utf-8'),
        bytes: st.size,
        em: mtime(r.caminho),
        editavel: true,
        ext,
      };
    } catch (err) {
      return { erro: `Não consegui ler "${nome}": ${err.message}`, status: 500 };
    }
  }

  /** O caminho no disco de um arquivo, para a rota que faz o streaming. */
  function binario(rel) {
    const r = resolver(rel);
    if (r.erro) return r;
    let st;
    try { st = fs.lstatSync(r.caminho); } catch {
      return { erro: `Não achei o arquivo "${r.rel}".`, status: 404 };
    }
    if (!st.isFile()) {
      return { erro: `"${r.rel}" não é um arquivo comum, então eu não sirvo.`, status: 400 };
    }
    const nome = path.basename(r.caminho);
    const ext = extDe(nome);
    return { caminho: r.caminho, nome, mime: mimeDaExt(ext), tipo: tipoDaExt(ext), ext, bytes: st.size };
  }

  /**
   * Grava o texto editado por cima do arquivo.
   *
   * SÓ EM ARQUIVO QUE JÁ EXISTE, e só nos de texto. Criar arquivo por aqui seria
   * um segundo caminho de escrita, com regras próprias, ao lado do upload: quem
   * cria arquivo nesta aba é o botão Subir arquivo, e só ele.
   */
  function salvar(rel, texto) {
    if (typeof texto !== 'string') {
      return { erro: 'Não veio texto nenhum para salvar. Nada foi alterado no arquivo.', status: 400 };
    }
    if (Buffer.byteLength(texto, 'utf-8') > TETO_TEXTO) {
      return { erro: 'O texto passou de 2 MB, que é o limite desta tela. Nada foi alterado no arquivo.', status: 413 };
    }
    const r = resolver(rel);
    if (r.erro) return r;

    let st;
    try { st = fs.lstatSync(r.caminho); } catch {
      return {
        erro: `Não achei o arquivo "${r.rel}" para salvar. Se ele foi apagado enquanto você editava, ` +
          'copie o seu texto antes de recarregar a lista: eu não crio arquivo novo por aqui.',
        status: 404,
      };
    }
    if (!st.isFile()) {
      return { erro: `"${r.rel}" não é um arquivo comum, então eu não escrevo nele.`, status: 400 };
    }
    if (!ehTexto(extDe(r.caminho))) {
      return {
        erro: `"${path.basename(r.caminho)}" não é um arquivo de texto, e salvar texto por cima dele destruiria o conteúdo.`,
        status: 400,
      };
    }
    try {
      fs.writeFileSync(r.caminho, texto, 'utf-8');
    } catch (err) {
      return { erro: `Não consegui salvar "${path.basename(r.caminho)}": ${err.message}`, status: 500 };
    }
    return { ok: true, caminho: r.rel, bytes: Buffer.byteLength(texto, 'utf-8'), em: mtime(r.caminho) };
  }

  /**
   * Apaga UM arquivo.
   *
   * PASTA NÃO. E não é falta de código: apagar pasta é apagar tudo que está
   * dentro, inclusive o que a pessoa não viu na tela naquele momento, e um clique
   * que destrói o que não está à vista não é um clique honesto. Quem precisa
   * mesmo remover uma pasta pede ao agente, que sabe o que tem lá dentro.
   */
  function apagar(rel) {
    const r = resolver(rel);
    if (r.erro) return r;
    if (!r.rel) {
      return { erro: 'A pasta de arquivos do agente não é apagada por aqui.', status: 400 };
    }

    let st;
    try { st = fs.lstatSync(r.caminho); } catch {
      return { erro: `Não achei "${r.rel}". Talvez já tenha sido apagado.`, status: 404 };
    }
    if (st.isDirectory()) {
      return {
        erro:
          `"${r.rel}" é uma pasta, e apagar pasta não é feito por aqui. ` +
          'Apagar uma pasta levaria junto tudo o que está dentro dela, inclusive o que não aparece nesta tela. ' +
          'Se for isso mesmo, peça ao agente na aba Conversa, que ele diz o que tem lá dentro antes.',
        status: 400,
      };
    }
    if (!st.isFile()) {
      return { erro: `"${r.rel}" não é um arquivo comum, então eu não apago.`, status: 400 };
    }
    try {
      fs.unlinkSync(r.caminho);
    } catch (err) {
      return { erro: `Não consegui apagar "${r.rel}": ${err.message}`, status: 500 };
    }
    return { ok: true, apagado: r.rel };
  }

  /**
   * Grava um arquivo NOVO dentro de uma pasta.
   *
   * NÃO SOBRESCREVE. Se já existe um arquivo com aquele nome, a resposta é um
   * erro dizendo isso, e não uma gravação silenciosa: o dono está subindo um
   * arquivo, não substituindo um que ele talvez nem soubesse que estava lá.
   */
  function subir(rel, nome, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { erro: 'O arquivo chegou vazio, então não gravei nada. Escolha o arquivo de novo e tente outra vez.', status: 400 };
    }
    if (typeof nome !== 'string' || !NOME_UPLOAD_OK.test(nome)) {
      return {
        erro:
          'Nome de arquivo não aceito. Ele precisa começar com letra ou número e pode ter letras, números, ' +
          'espaço, ponto, hífen, sublinhado e parênteses. Renomeie o arquivo no seu computador e envie de novo.',
        status: 400,
      };
    }

    const r = resolver(rel);
    if (r.erro) return r;
    if (!existe(r.caminho)) {
      return { erro: `Não achei a pasta "${r.rel || 'arquivos'}" para guardar o arquivo.`, status: 404 };
    }
    let stPasta;
    try { stPasta = fs.statSync(r.caminho); } catch (err) {
      return { erro: `Não consegui abrir a pasta de destino: ${err.message}`, status: 500 };
    }
    if (!stPasta.isDirectory()) {
      return { erro: `"${r.rel}" não é uma pasta, então não dá para guardar arquivo dentro dele.`, status: 400 };
    }

    const alvo = path.join(r.caminho, nome);
    // O `resolver` já conferiu a pasta; o nome ainda passa pela mesma régua,
    // porque é ele que vem do formulário e é ele que vira caminho no fim.
    if (!dentroDe(r.caminho, alvo) || path.dirname(alvo) !== r.caminho) {
      return { erro: 'Pedido inválido: esse nome de arquivo sairia da pasta escolhida.', status: 400 };
    }
    if (existe(alvo)) {
      return {
        erro:
          `Já existe um arquivo chamado "${nome}" nesta pasta, e eu não escrevo por cima. ` +
          'Renomeie o seu arquivo, ou apague o que está aqui antes de subir o novo.',
        status: 409,
      };
    }

    try {
      // `wx` = cria, e falha se alguém tiver criado no meio do caminho. É a mesma
      // recusa de cima, agora garantida pelo sistema de arquivos e não por uma
      // conferência que aconteceu um instante antes.
      fs.writeFileSync(alvo, buffer, { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return { erro: `Já existe um arquivo chamado "${nome}" nesta pasta, e eu não escrevo por cima.`, status: 409 };
      }
      return { erro: `Não consegui guardar "${nome}": ${err.message}`, status: 500 };
    }
    return { ok: true, nome, caminho: r.rel ? `${r.rel}/${nome}` : nome, bytes: buffer.length };
  }

  return { listar, ler, binario, salvar, apagar, subir, RAIZ, EXT_TEXTO, TETO_TEXTO };
}

module.exports = { buildArquivos, EXT_TEXTO, TETO_TEXTO };
