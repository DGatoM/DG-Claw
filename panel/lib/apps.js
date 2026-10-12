// apps.js — a aba Apps: os aplicativos que o agente sabe operar.
//
// O QUE ISTO É, em uma frase: as outras abas do painel falam SOBRE o agente
// (memória, personalidade, custo, rotina); a aba Apps mostra o TRABALHO dele.
//
// POR QUE É GENÉRICO E NÃO "a tela de um agente específico". Cada agente entregue faz uma
// coisa diferente, e o painel é o mesmo para todos. Então a lista de aplicativos
// não mora aqui: mora no agente, em `<agentDir>/.dgclaw/apps.json`. Quem não tem
// o arquivo não tem app, e a aba explica isso em vez de aparecer vazia. Instalar
// um app é escrever uma entrada nesse arquivo, sem tocar no painel.
//
// O TIPO `conteudo` (o primeiro, e o único de fábrica). Mostra os vídeos que o
// agente preparou, cada um com as suas etapas. A fonte é a PASTA que ele já cria
// enquanto trabalha, uma por vídeo:
//
//   <agentDir>/arquivos/projetos/<AAAA-MM-DD-slug>/
//       estado.json          <- opcional; é o que o agente escreve ao concluir etapa
//       pesquisa.md
//       catalogo-assets.md
//       roteiro.md
//       assets/
//
// AS DUAS FONTES, E POR QUE SÃO DUAS. O `estado.json` é a fonte boa: traz o
// resumo de uma linha e o status real de cada etapa, e é o que faz o card dizer
// alguma coisa sem abrir arquivo nenhum. Mas ele é OPCIONAL de propósito, porque
// a pasta existe desde antes dele e um agente pode simplesmente esquecer de
// escrevê-lo. Sem `estado.json`, este módulo DEDUZ da pasta: arquivo da etapa no
// disco vira `concluido`, ausência vira `pendente`, e o resumo vira a primeira
// linha de verdade do markdown. O app degrada, nunca mente e nunca fica em
// branco.
//
// A REGRA QUE NÃO PODE SER QUEBRADA: deduzido não é igual a declarado. Toda
// etapa devolvida diz de onde veio (`origem: 'estado' | 'pasta'`), porque
// "concluído porque o agente disse" e "concluído porque o arquivo existe" são
// afirmações diferentes, e a segunda não sabe se o arquivo está pela metade.
//
// SEGURANÇA. Tudo que vem da URL (o slug do projeto, o nome do arquivo) é
// tratado como hostil: só passa o que casa com um formato estreito, e o caminho
// final ainda é conferido contra a pasta de projetos antes de qualquer leitura.
// Sem isso, `../../.dgclaw/config.sh` seria um pedido válido.

const fs = require('fs');
const path = require('path');
// A tabela de tipo por extensao mora em lib/mime.js: a aba Pasta serve arquivo do
// disco pelas mesmas regras, e duas tabelas separadas viravam duas respostas
// diferentes para o mesmo .webp.
const { extDe, mimeDaExt, tipoDaExt } = require('./mime');

/** O vocabulário de status, herdado do `content_stages` do DG Social. */
const STATUS = ['pendente', 'em_producao', 'aguardando_aprovacao', 'concluido', 'reprovado', 'nao_aplicavel'];

/**
 * As três etapas de fábrica do app de conteúdo.
 *
 * Ficam aqui como DEFAULT, e não como lei, porque o apps.json pode declarar
 * outras. Mas elas sempre existem todas, mesmo as que ninguém começou: uma etapa
 * ausente da lista seria indistinguível de uma etapa que não se aplica, e essa
 * confusão é exatamente o que o schema do DG Social evita nascendo com as nove
 * linhas em `pendente`.
 */
const ETAPAS_PADRAO = [
  { key: 'pesquisa', nome: 'Pesquisa', arquivo: 'pesquisa.md', extras: ['numeros.md'] },
  { key: 'assets', nome: 'Assets', arquivo: 'catalogo-assets.md', pasta: 'assets' },
  { key: 'roteiro', nome: 'Roteiro', arquivo: 'roteiro.md' },
];

/** Nome de pasta de projeto e de arquivo: estreito de propósito. */
const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/**
 * Quantos arquivos um catálogo em markdown CITA.
 *
 * Conta nomes com extensão conhecida escritos entre crases (`01-grafico.png`),
 * que é como o agente escreve a tabela dele. É heurística, e por isso o número
 * só é usado quando é maior que zero: com zero, a tela diz que a pasta está
 * vazia sem citar quantidade nenhuma. Chutar "o catálogo lista 0" seria trocar
 * uma leitura que falhou por uma afirmação, que é o defeito que esta mudança
 * inteira existe para consertar.
 *
 * Não vira parser de markdown de propósito: o formato do catálogo é do agente e
 * pode mudar amanhã, e um parser que exige formato quebraria a tela em vez de
 * apenas deixar de mostrar um número.
 */
// `md` e `txt` FICAM DE FORA. Um catálogo de assets cita mídia e planilha; os
// .md que aparecem entre crases nele são referências aos outros documentos do
// próprio projeto ("os números estão em `numeros.md`"). Contá-los inflava o
// total: no primeiro teste real deu 17 onde o catálogo dizia 15.
const EXT_DE_ASSET = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a|pdf|xlsx|xls|csv|pptx|docx|zip)$/i;

function contarCitados(arquivoPath) {
  try {
    const texto = fs.readFileSync(arquivoPath, 'utf8');
    const nomes = new Set();
    for (const m of texto.matchAll(/`([^`\n]{3,120})`/g)) {
      const nome = m[1].trim();
      if (EXT_DE_ASSET.test(nome) && !nome.includes('/') && !nome.includes(' ')) {
        nomes.add(nome.toLowerCase());
      }
    }
    return nomes.size || null;
  } catch {
    return null;
  }
}

function nomeSeguro(nome) {
  return typeof nome === 'string' && SLUG_OK.test(nome) && !nome.includes('..');
}

/** `alvo` está mesmo dentro de `base`? Resolve os dois antes de comparar. */
function dentroDe(base, alvo) {
  const b = path.resolve(base);
  const a = path.resolve(alvo);
  return a === b || a.startsWith(b + path.sep);
}

function lerJSON(arquivo) {
  try {
    const bruto = fs.readFileSync(arquivo, 'utf-8');
    const o = JSON.parse(bruto);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function existe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function mtime(p) {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return null; }
}

function tamanho(p) {
  try { return fs.statSync(p).size; } catch { return null; }
}

/**
 * A primeira linha de VERDADE de um markdown, para servir de resumo quando o
 * agente não deixou um escrito.
 *
 * Pula título, frontmatter, linha em branco e marcador solto, porque "# Pesquisa"
 * como resumo de um arquivo chamado pesquisa.md não informa nada. Corta em 160
 * para caber no card sem empurrar o resto da tela.
 */
function primeiraLinhaUtil(arquivo) {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf-8');
  } catch {
    return null;
  }
  const linhas = bruto.split('\n');
  let dentroDoFrontmatter = false;
  for (let i = 0; i < linhas.length && i < 200; i++) {
    let l = linhas[i].trim();
    if (i === 0 && l === '---') { dentroDoFrontmatter = true; continue; }
    if (dentroDoFrontmatter) {
      if (l === '---') dentroDoFrontmatter = false;
      continue;
    }
    if (!l) continue;
    if (l.startsWith('#')) continue;
    l = l.replace(/^[-*+>]\s+/, '').replace(/^\d+[.)]\s+/, '');
    l = l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
    l = l.replace(/\[(.+?)\]\(.+?\)/g, '$1').trim();
    if (l.length < 12) continue;
    return l.length > 160 ? l.slice(0, 159).trimEnd() + '…' : l;
  }
  return null;
}

function buildApps(config) {
  const AGENT_DIR = config.agentDir;
  const APPS_FILE = path.join(AGENT_DIR, '.dgclaw', 'apps.json');

  /**
   * Os apps instalados neste agente.
   *
   * Devolve sempre `{ apps, motivo }`: `motivo` é o que a tela mostra quando a
   * lista vem vazia. Lista vazia sem explicação é justamente a tela em branco que
   * a gente não aceita, e "não tem app" e "o arquivo está quebrado" são coisas
   * diferentes que precisam chegar diferentes na pessoa.
   */
  function listar() {
    if (!existe(APPS_FILE)) {
      return {
        apps: [],
        motivo:
          'Este agente ainda não tem nenhum aplicativo instalado. ' +
          'Quem instala é ele mesmo, escrevendo o arquivo .dgclaw/apps.json no espaço dele.',
      };
    }
    const cru = lerJSON(APPS_FILE);
    if (!cru) {
      return {
        apps: [],
        motivo:
          `Achei o ${APPS_FILE}, mas não consegui ler o JSON dele. ` +
          'Enquanto ele estiver inválido eu prefiro não mostrar app nenhum a mostrar uma lista pela metade.',
      };
    }
    const lista = Array.isArray(cru.apps) ? cru.apps : [];
    const apps = lista
      .filter((a) => a && typeof a === 'object' && nomeSeguro(a.key) && typeof a.tipo === 'string')
      .map((a) => ({
        key: a.key,
        nome: typeof a.nome === 'string' && a.nome.trim() ? a.nome.trim() : a.key,
        descricao: typeof a.descricao === 'string' ? a.descricao : '',
        tipo: a.tipo,
        icone: typeof a.icone === 'string' ? a.icone : '▨',
        suportado: a.tipo === 'conteudo',
      }));
    const descartados = lista.length - apps.length;
    return {
      apps,
      motivo: apps.length
        ? null
        : 'O arquivo .dgclaw/apps.json existe, mas nenhuma entrada dele é um app válido ' +
          '(cada app precisa de "key" e "tipo").',
      descartados: descartados > 0 ? descartados : undefined,
    };
  }

  /** A config de um app declarado, já com os defaults do tipo aplicados. */
  function acharApp(appKey) {
    const { apps } = listar();
    const achado = apps.find((a) => a.key === appKey);
    if (!achado) return null;
    const cru = lerJSON(APPS_FILE) || {};
    const bruto = (Array.isArray(cru.apps) ? cru.apps : []).find((a) => a && a.key === appKey) || {};
    const cfg = bruto.config && typeof bruto.config === 'object' ? bruto.config : {};
    const etapas = Array.isArray(cfg.etapas) && cfg.etapas.length
      ? cfg.etapas.filter((e) => e && nomeSeguro(e.key))
      : ETAPAS_PADRAO;
    return {
      ...achado,
      pasta: typeof cfg.pasta === 'string' && cfg.pasta ? cfg.pasta : 'arquivos/projetos',
      etapas,
    };
  }

  /** A pasta onde moram os projetos daquele app, já conferida. */
  function raizDosProjetos(app) {
    const raiz = path.resolve(AGENT_DIR, app.pasta);
    // `pasta` vem do apps.json, que é do agente, não da URL. Ainda assim é
    // conferida: um app mal escrito não deve virar leitura do disco inteiro.
    if (!dentroDe(AGENT_DIR, raiz)) return null;
    return raiz;
  }

  /**
   * Monta as etapas de UM projeto, casando o que o agente declarou com o que
   * está no disco.
   */
  function etapasDoProjeto(app, dirProjeto, estado) {
    const declaradas = estado && estado.etapas && typeof estado.etapas === 'object' ? estado.etapas : {};

    return app.etapas.map((def, i) => {
      const d = declaradas[def.key] || {};
      const arquivoNome = typeof d.arquivo === 'string' && nomeSeguro(d.arquivo) ? d.arquivo : def.arquivo;
      const arquivoPath = arquivoNome ? path.join(dirProjeto, arquivoNome) : null;
      const temArquivo = arquivoPath ? existe(arquivoPath) : false;

      // Contagem da pasta da etapa (o `assets/` do catálogo). `null` quando a
      // etapa não tem pasta; `0` só quando a pasta existe e está mesmo vazia.
      let itensNaPasta = null;
      if (def.pasta) {
        const p = path.join(dirProjeto, def.pasta);
        if (existe(p)) {
          try { itensNaPasta = fs.readdirSync(p).filter((n) => !n.startsWith('.')).length; }
          catch { itensNaPasta = null; }
        }
      }

      const statusDeclarado = STATUS.includes(d.status) ? d.status : null;

      // ╔════════════════════════════════════════════════════════════════════╗
      // ║  ETAPA QUE TEM PASTA SÓ ESTÁ CONCLUÍDA COM ARQUIVO DENTRO DELA.    ║
      // ╚════════════════════════════════════════════════════════════════════╝
      //
      // Era `temArquivo ? 'concluido' : 'pendente'`, e o `itensNaPasta` acima já
      // era calculado e jogado fora na hora de decidir. Resultado: a etapa Assets
      // ficava VERDE porque o `catalogo-assets.md` existia, mesmo com a pasta
      // `assets/` sem um único arquivo. O catálogo DESCREVE o material; ele não é
      // o material.
      //
      // O custo disso foi real (26/08/2026): o Danilo abriu o painel de um dono,
      // leu "Assets · concluído · 15 assets", e passou três rodadas procurando
      // por que as prévias não apareciam. Não havia o que prever. A tela o mandou
      // procurar uma coisa que ela mesma tinha inventado.
      //
      // É a mesma doença do Pulso, no mesmo dia: medir que a etapa RODOU e
      // apresentar isso como se fosse o que ela ENTREGOU. Aqui o desfecho certo
      // não é `pendente` (o trabalho começou, e dizer que não começou apagaria o
      // catálogo que existe): é `em_producao`, com o motivo escrito.
      const pastaVazia = !!def.pasta && itensNaPasta === 0;

      // Quantos arquivos o catálogo CITA, para a tela poder dizer "4 dos 16".
      // Só entra na resposta se a leitura achou alguma coisa: um zero aqui
      // significa "não consegui contar", e apresentar isso como "o catálogo não
      // cita nada" seria trocar uma falha de leitura por um fato.
      const citados = temArquivo && def.pasta ? contarCitados(arquivoPath) : null;

      // PASTA PELA METADE TAMBÉM NÃO É "PRONTO".
      //
      // A primeira versão desta correção só olhava a pasta VAZIA, e o defeito
      // apenas mudou de lugar: assim que o agente produziu o primeiro dos 16
      // arquivos, a etapa voltou a dizer "pronto" com 4 de 16 na pasta. Corrigir
      // o zero e deixar passar o um é consertar o exemplo, não a regra.
      const incompleta = !!def.pasta && !!citados && (itensNaPasta || 0) < citados;

      let status;
      if (statusDeclarado) status = statusDeclarado;
      else if (temArquivo && (pastaVazia || incompleta)) status = 'em_producao';
      else if (temArquivo) status = 'concluido';
      else status = 'pendente';
      const origem = statusDeclarado ? 'estado' : 'pasta';

      // A frase que a tela mostra quando a etapa não está do jeito que o nome
      // dela sugere. Escrita AQUI, e não na tela, porque quem sabe a diferença
      // entre catálogo e material é este módulo.
      let porQue = null;
      if (temArquivo && (pastaVazia || incompleta)) {
        if (pastaVazia) {
          porQue = citados
            ? `O catálogo cita ${citados} ${citados === 1 ? 'arquivo' : 'arquivos'}, e a pasta "${def.pasta}" `
              + 'está vazia: nenhum foi produzido ou baixado ainda.'
            : `O catálogo foi escrito, mas a pasta "${def.pasta}" está vazia: o material ainda não foi produzido.`;
        } else {
          // O RESTO PODE NÃO SER DO AGENTE, e a frase precisa dizer isso, senão
          // uma etapa cujos últimos itens dependem de alguém capturar no dia da
          // gravação ficaria "em produção" para sempre, e a pessoa iria cobrar
          // do agente uma coisa que é dela.
          porQue = `A pasta "${def.pasta}" tem ${itensNaPasta} dos ${citados} arquivos que o catálogo cita. `
            + 'Se o que falta depende de você capturar, o agente fecha a etapa quando terminar a parte dele.';
        }
        if (statusDeclarado === 'concluido') {
          // O agente AFIRMOU que terminou e a pasta discorda. Não sobrescrevo a
          // afirmação dele (ela é dado, e `origem: 'estado'` já diz que é dele),
          // mas quem lê a tela precisa ver as duas coisas.
          porQue = `Esta etapa está marcada como concluída pelo agente, mas ${porQue[0].toLowerCase()}${porQue.slice(1)}`;
        }
      }

      const resumoDeclarado = typeof d.resumo === 'string' && d.resumo.trim() ? d.resumo.trim() : null;
      const resumo = resumoDeclarado || (temArquivo ? primeiraLinhaUtil(arquivoPath) : null);

      return {
        key: def.key,
        nome: def.nome || def.key,
        posicao: i + 1,
        status,
        origem,
        resumo,
        resumoOrigem: resumoDeclarado ? 'estado' : resumo ? 'arquivo' : null,
        arquivo: temArquivo ? arquivoNome : null,
        arquivoBytes: temArquivo ? tamanho(arquivoPath) : null,
        atualizadoEm: typeof d.em === 'string' ? d.em : temArquivo ? mtime(arquivoPath) : null,
        pasta: def.pasta || null,
        itensNaPasta,
        citadosNoCatalogo: citados,
        porQue,
        extras: (def.extras || [])
          .filter((n) => nomeSeguro(n) && existe(path.join(dirProjeto, n)))
          .map((n) => ({ arquivo: n, bytes: tamanho(path.join(dirProjeto, n)) })),
        feedback: typeof d.feedback === 'string' && d.feedback.trim() ? d.feedback.trim() : null,
      };
    });
  }

  function montarProjeto(app, raiz, nome) {
    const dir = path.join(raiz, nome);
    const estado = lerJSON(path.join(dir, 'estado.json'));
    const etapas = etapasDoProjeto(app, dir, estado);
    const concluidas = etapas.filter((e) => e.status === 'concluido').length;
    const contam = etapas.filter((e) => e.status !== 'nao_aplicavel').length;

    // A data vem do nome da pasta (AAAA-MM-DD-slug), que é a convenção do agente.
    const m = nome.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);

    return {
      slug: nome,
      titulo:
        (estado && typeof estado.titulo === 'string' && estado.titulo.trim()) ||
        (m ? m[4].replace(/-/g, ' ') : nome.replace(/-/g, ' ')),
      data: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
      temEstado: !!estado,
      etapas,
      progresso: { concluidas, total: contam },
      atualizadoEm: mtime(dir),
    };
  }

  /**
   * Todos os projetos de um app, do mais novo para o mais velho.
   *
   * O erro aqui é RESPOSTA, nunca lista vazia: "a pasta não existe ainda" e "o
   * agente não produziu nada" são a mesma tela vazia e causas opostas, e só uma
   * delas tem o que a pessoa fazer a respeito.
   */
  function projetos(appKey) {
    const app = acharApp(appKey);
    if (!app) return { erro: `Não achei o app "${appKey}" na lista deste agente.`, status: 404 };
    if (app.tipo !== 'conteudo') {
      return { erro: `O app "${app.nome}" é do tipo "${app.tipo}", que este painel ainda não sabe mostrar.`, status: 501 };
    }
    const raiz = raizDosProjetos(app);
    if (!raiz) return { erro: `A pasta configurada para o app "${app.nome}" cai fora do espaço do agente.`, status: 500 };
    if (!existe(raiz)) {
      return {
        app,
        projetos: [],
        motivo:
          `A pasta ${app.pasta} ainda não existe no espaço do agente. ` +
          'Ela nasce sozinha no primeiro conteúdo que ele começar.',
      };
    }

    let nomes;
    try {
      nomes = fs.readdirSync(raiz, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && nomeSeguro(d.name))
        .map((d) => d.name);
    } catch (err) {
      return { erro: `Não consegui ler a pasta ${app.pasta}: ${err.message}`, status: 500 };
    }

    const lista = nomes.map((n) => montarProjeto(app, raiz, n));
    lista.sort((a, b) => (b.data || '').localeCompare(a.data || '') || b.slug.localeCompare(a.slug));

    return {
      app,
      projetos: lista,
      motivo: lista.length ? null : `A pasta ${app.pasta} existe, mas ainda não tem nenhum conteúdo dentro.`,
    };
  }

  /** Um projeto só, com as etapas. */
  function projeto(appKey, slug) {
    if (!nomeSeguro(slug)) return { erro: 'Nome de conteúdo inválido.', status: 400 };
    const app = acharApp(appKey);
    if (!app) return { erro: `Não achei o app "${appKey}" na lista deste agente.`, status: 404 };
    const raiz = raizDosProjetos(app);
    if (!raiz) return { erro: 'A pasta configurada cai fora do espaço do agente.', status: 500 };
    const dir = path.join(raiz, slug);
    if (!dentroDe(raiz, dir) || !existe(dir)) {
      return { erro: `Não achei o conteúdo "${slug}".`, status: 404 };
    }
    return { app, projeto: montarProjeto(app, raiz, slug) };
  }

  /**
   * O conteúdo de um arquivo de etapa, em texto.
   *
   * Só lê o que a etapa declarou (o arquivo principal e os extras dela). Não é
   * um navegador de arquivos: o pedido tem que casar com algo que este módulo
   * já tinha resolvido, senão a aba viraria uma porta para o workspace inteiro.
   */
  function arquivo(appKey, slug, nome) {
    if (!nomeSeguro(slug) || !nomeSeguro(nome)) return { erro: 'Pedido inválido.', status: 400 };
    const r = projeto(appKey, slug);
    if (r.erro) return r;

    const permitidos = new Set();
    for (const e of r.projeto.etapas) {
      if (e.arquivo) permitidos.add(e.arquivo);
      for (const x of e.extras) permitidos.add(x.arquivo);
    }
    if (!permitidos.has(nome)) {
      return {
        erro: `O arquivo "${nome}" não é de nenhuma etapa deste conteúdo, então eu não abro.`,
        status: 404,
      };
    }

    const raiz = raizDosProjetos(r.app);
    const alvo = path.join(raiz, slug, nome);
    if (!dentroDe(path.join(raiz, slug), alvo)) return { erro: 'Pedido inválido.', status: 400 };
    try {
      return { nome, texto: fs.readFileSync(alvo, 'utf-8'), bytes: tamanho(alvo), em: mtime(alvo) };
    } catch (err) {
      return { erro: `Não consegui ler ${nome}: ${err.message}`, status: 500 };
    }
  }

  /** O que a etapa de assets juntou: nome, tamanho e tipo, sem servir o binário. */
  function assets(appKey, slug) {
    const r = projeto(appKey, slug);
    if (r.erro) return r;
    const etapa = r.projeto.etapas.find((e) => e.pasta);
    if (!etapa) return { assets: [], motivo: 'Este conteúdo não tem etapa com pasta de material.' };

    const raiz = raizDosProjetos(r.app);
    const dir = path.join(raiz, slug, etapa.pasta);
    if (!dentroDe(path.join(raiz, slug), dir) || !existe(dir)) {
      return { assets: [], motivo: `A pasta ${etapa.pasta} ainda não existe neste conteúdo.` };
    }
    let nomes;
    try {
      nomes = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && !d.name.startsWith('.'));
    } catch (err) {
      return { erro: `Não consegui ler a pasta ${etapa.pasta}: ${err.message}`, status: 500 };
    }
    const assets = nomes.map((d) => {
      const ext = extDe(d.name);
      return { nome: d.name, tipo: tipoDaExt(ext), ext, bytes: tamanho(path.join(dir, d.name)) };
    });
    return {
      assets,
      pasta: etapa.pasta,
      motivo: assets.length
        ? null
        : `A pasta ${etapa.pasta} existe, mas está vazia: o catálogo foi escrito e o material ainda não foi baixado.`,
    };
  }

  /**
   * O caminho no disco de UM asset, para a rota que serve o binário.
   *
   * POR QUE ISTO PRECISOU EXISTIR. Até aqui o `assets()` devolvia nome, tipo e
   * tamanho "sem servir o binário", e o resultado na tela era uma lista de nomes
   * de imagem que ninguém conseguia ver. Saber que há 14 arquivos na pasta não
   * ajuda a decidir se o material presta.
   *
   * ELA NÃO LÊ O ARQUIVO. Devolve o caminho já conferido e deixa o streaming com
   * a rota: um asset é um vídeo de 300 MB tão facilmente quanto um png, e ler
   * tudo para a memória antes de responder seria derrubar o painel por vaidade de
   * simetria com as outras funções daqui.
   *
   * A CONFERÊNCIA É A MESMA DE SEMPRE, em três camadas: o slug e o nome têm que
   * casar com o formato estreito, o caminho resolvido tem que cair DENTRO da
   * pasta da etapa daquele projeto, e o que estiver lá tem que ser arquivo comum.
   * Link simbólico é recusado mesmo apontando para dentro: quem decide o que sai
   * daqui é esta função, não um atalho que alguém deixou na pasta.
   */
  function assetBinario(appKey, slug, nome) {
    if (!nomeSeguro(slug) || !nomeSeguro(nome)) {
      return { erro: 'Pedido inválido: nome de conteúdo ou de arquivo fora do formato aceito.', status: 400 };
    }
    const r = projeto(appKey, slug);
    if (r.erro) return r;

    const etapa = r.projeto.etapas.find((e) => e.pasta);
    if (!etapa) {
      return { erro: `O conteúdo "${slug}" não tem etapa com pasta de material.`, status: 404 };
    }
    const raiz = raizDosProjetos(r.app);
    if (!raiz) return { erro: 'A pasta configurada cai fora do espaço do agente.', status: 500 };

    const dirEtapa = path.join(raiz, slug, etapa.pasta);
    const alvo = path.join(dirEtapa, nome);
    if (!dentroDe(dirEtapa, alvo)) {
      return { erro: 'Pedido inválido: o arquivo pedido cai fora da pasta de material deste conteúdo.', status: 400 };
    }

    let st;
    try {
      st = fs.lstatSync(alvo);
    } catch {
      return { erro: `Não achei o arquivo "${nome}" na pasta ${etapa.pasta} deste conteúdo.`, status: 404 };
    }
    // `lstat` e não `stat`: aqui o `isFile()` já dá falso para link simbólico, que
    // é justamente o caso que a gente não quer seguir sem olhar.
    if (!st.isFile()) {
      return {
        erro: `"${nome}" não é um arquivo comum (pode ser uma pasta ou um atalho), então eu não sirvo.`,
        status: 400,
      };
    }

    const ext = extDe(nome);
    return { caminho: alvo, nome, mime: mimeDaExt(ext), tipo: tipoDaExt(ext), ext, bytes: st.size };
  }

  return { listar, projetos, projeto, arquivo, assets, assetBinario, STATUS, ETAPAS_PADRAO };
}

module.exports = { buildApps, STATUS, ETAPAS_PADRAO };
