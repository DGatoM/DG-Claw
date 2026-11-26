'use strict';
const dgIdiomaBackend = require("./idioma-contexto");
// Manual do DG Claw: serve, só para leitura, os arquivos markdown de docs/manual/ (a pasta do repositório).
// Contrato em web/docs/MANUAL.md.
//
// Segurança: o nome da página só vale se casar com ^[a-z0-9-]+$ E constar da lista lida da pasta agora.
// O arquivo precisa ser regular e o caminho real dele ficar dentro do caminho real da pasta (atalho para fora é recusado).
// Nada aqui escreve em disco.

const fs = require('node:fs');
const path = require('node:path');
const { traduzirDocumento } = require('./documento-idioma');

const RX_NOME = /^[a-z0-9-]+$/;
const MAX_BYTES = 2 * 1024 * 1024;

class ErroManual extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

/** Pedaço do nome que pode ir numa mensagem: sem quebra de linha nem controle, curto. */
const mostraNome = (n) => JSON.stringify(String(n).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 60));

function criarManual({ dir, log }) {
  const aviso = log || (() => {});

  /** Caminho real da pasta, ou lança ErroManual 503 que diz o que fazer. */
  function raizReal() {
    try { return fs.realpathSync(dir); } catch (e) {
      const msg = `O manual não está instalado: não achei a pasta ${dir} (${e.code || e.message}).`;
      aviso('erro', msg);
      throw new ErroManual(503, dgIdiomaBackend.mensagem("{p0} Atualize o DG Claw (peça ao Admin: \"atualiza o DG Claw\") para trazer a pasta docs/manual.", {p0: (msg)}));
    }
  }

  /** Lê o arquivo sem seguir atalho para fora da pasta. Devolve o texto ou null se não for um arquivo aceito. */
  function lerArquivo(raiz, arquivo, idioma) {
    const alvo = path.join(dir, arquivo);
    let real;
    try { real = fs.realpathSync(alvo); } catch (_) { return null; }
    if (path.dirname(real) !== raiz) {
      aviso('aviso', `Manual: ${alvo} aponta para fora da pasta do manual (${real}); recusei por segurança.`);
      return null;
    }
    let st;
    try { st = fs.statSync(real); } catch (_) { return null; }
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return traduzirDocumento(alvo, fs.readFileSync(real, 'utf8'), idioma);
  }

  const tituloDe = (texto, padrao) => {
    const m = /^#\s+(.+?)\s*#*\s*$/m.exec(texto);
    return m ? m[1].replace(/\s+\{#[a-z0-9-]+\}$/, '') : padrao;
  };

  /** Páginas disponíveis agora, em ordem alfabética: [{ nome, titulo }]. O README é o índice e vem à parte. */
  function listar(idioma) {
    const raiz = raizReal();
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch (e) {
      throw new ErroManual(503, dgIdiomaBackend.mensagem("Não consegui ler a pasta do manual {p0} ({p1}). Confira as permissões ou atualize o DG Claw.", {p0: (dir), p1: (e.code || e.message)}));
    }
    const paginas = [];
    for (const arq of nomes.sort()) {
      if (!arq.endsWith('.md')) continue;
      const nome = arq.slice(0, -3);
      if (!RX_NOME.test(nome)) continue;
      const texto = lerArquivo(raiz, arq, idioma);
      if (texto === null) continue;
      paginas.push({ nome, titulo: tituloDe(texto, nome) });
    }
    const indice = lerArquivo(raiz, 'README.md', idioma);
    return { indice: indice === null ? null : { titulo: tituloDe(indice, 'Manual do DG Claw') }, paginas };
  }

  /** Texto de uma página; nome 'README' é o índice. Lança ErroManual 404 com a explicação quando não existe. */
  function ler(nome, idioma) {
    const raiz = raizReal();
    if (nome === 'README') {
      const t = lerArquivo(raiz, 'README.md', idioma);
      if (t === null) throw new ErroManual(404, dgIdiomaBackend.mensagem("O índice do manual (README.md) não está na pasta {p0}. Atualize o DG Claw para trazê-lo.", {p0: (dir)}));
      return t;
    }
    const naoAchou = () => new ErroManual(404, dgIdiomaBackend.mensagem("Não existe a página {p0} no manual. Veja a lista de páginas em /api/v1/manual.", {p0: (mostraNome(nome))}));
    if (typeof nome !== 'string' || !RX_NOME.test(nome)) throw naoAchou();
    if (!listar().paginas.some((p) => p.nome === nome)) throw naoAchou();
    const t = lerArquivo(raiz, `${nome}.md`, idioma);
    if (t === null) throw naoAchou();
    return t;
  }

  return { listar, ler, ErroManual };
}

module.exports = { criarManual, ErroManual, RX_NOME };
