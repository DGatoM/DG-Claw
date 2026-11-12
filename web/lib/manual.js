'use strict';
// Manual do DG Claw: serve, só para leitura, os arquivos markdown de docs/manual/ (a pasta do repositório).
// Contrato em web/docs/MANUAL.md.
//
// Segurança: o nome da página só vale se casar com ^[a-z0-9-]+$ E constar da lista lida da pasta agora.
// O arquivo precisa ser regular e o caminho real dele ficar dentro do caminho real da pasta (atalho para fora é recusado).
// Nada aqui escreve em disco.

const fs = require('node:fs');
const path = require('node:path');

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
      throw new ErroManual(503, `${msg} Atualize o DG Claw (peça ao Admin: "atualiza o DG Claw") para trazer a pasta docs/manual.`);
    }
  }

  /** Lê o arquivo sem seguir atalho para fora da pasta. Devolve o texto ou null se não for um arquivo aceito. */
  function lerArquivo(raiz, arquivo) {
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
    return fs.readFileSync(real, 'utf8');
  }

  const tituloDe = (texto, padrao) => {
    const m = /^#\s+(.+?)\s*#*\s*$/m.exec(texto);
    return m ? m[1] : padrao;
  };

  /** Páginas disponíveis agora, em ordem alfabética: [{ nome, titulo }]. O README é o índice e vem à parte. */
  function listar() {
    const raiz = raizReal();
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch (e) {
      throw new ErroManual(503, `Não consegui ler a pasta do manual ${dir} (${e.code || e.message}). Confira as permissões ou atualize o DG Claw.`);
    }
    const paginas = [];
    for (const arq of nomes.sort()) {
      if (!arq.endsWith('.md')) continue;
      const nome = arq.slice(0, -3);
      if (!RX_NOME.test(nome)) continue;
      const texto = lerArquivo(raiz, arq);
      if (texto === null) continue;
      paginas.push({ nome, titulo: tituloDe(texto, nome) });
    }
    const indice = lerArquivo(raiz, 'README.md');
    return { indice: indice === null ? null : { titulo: tituloDe(indice, 'Manual do DG Claw') }, paginas };
  }

  /** Texto de uma página; nome 'README' é o índice. Lança ErroManual 404 com a explicação quando não existe. */
  function ler(nome) {
    const raiz = raizReal();
    if (nome === 'README') {
      const t = lerArquivo(raiz, 'README.md');
      if (t === null) throw new ErroManual(404, `O índice do manual (README.md) não está na pasta ${dir}. Atualize o DG Claw para trazê-lo.`);
      return t;
    }
    const naoAchou = () => new ErroManual(404, `Não existe a página ${mostraNome(nome)} no manual. Veja a lista de páginas em /api/v1/manual.`);
    if (typeof nome !== 'string' || !RX_NOME.test(nome)) throw naoAchou();
    if (!listar().paginas.some((p) => p.nome === nome)) throw naoAchou();
    const t = lerArquivo(raiz, `${nome}.md`);
    if (t === null) throw naoAchou();
    return t;
  }

  return { listar, ler, ErroManual };
}

module.exports = { criarManual, ErroManual, RX_NOME };
