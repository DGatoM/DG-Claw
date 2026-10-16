'use strict';
// Escrita de arquivo de segredo pelo DG Claw Web, que roda como root no host.
//
// Quem escreve como root numa pasta que outra pessoa alcança corre um risco
// conhecido: trocar uma pasta (ou o próprio arquivo) por um atalho e fazer o root
// gravar em outro lugar. Por isso esta função:
//   1. só grava dentro de `raiz` (o caminho real, já sem atalhos, tem de ficar lá dentro);
//   2. recusa atalho em qualquer pasta entre a raiz e o destino, e no destino;
//   3. recusa pasta que outra pessoa possa alterar (dono tem de ser o root ou o dono
//      do próprio arquivo, sem escrita para grupo e outros);
//   4. escreve num temporário na MESMA pasta (O_EXCL + O_NOFOLLOW), faz fsync, ajusta
//      dono e modo no temporário aberto e só então troca pelo nome final (rename);
//   5. confere as pastas de novo logo antes da troca.
// O conteúdo nunca vai para mensagem de erro.
//
// Limite que fica: se a pasta for do próprio dono do arquivo (a casa do agente, por
// exemplo), esse dono ainda pode trocá-la por um atalho entre a conferência do passo 5
// e a troca. Para segredo que o agente não deve alterar, use uma pasta de dono root.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class ErroGravacao extends Error {
  constructor(mensagem, codigo) {
    super(mensagem);
    this.name = 'ErroGravacao';
    this.code = codigo || 'RECUSADO';
  }
}

function inteiroOuNull(v, nome) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0) throw new ErroGravacao(`A opção ${nome} precisa ser um número inteiro (recebi ${JSON.stringify(v)}).`, 'OPCAO_INVALIDA');
  return v;
}

/** Confere uma pasta: existe, não é atalho, e só root ou `uidPermitido` alteram. */
function conferePasta(p, uidPermitido) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    throw new ErroGravacao(`A pasta ${p} não existe ou não pôde ser lida (${e.code || e.name}).`, 'PASTA_AUSENTE');
  }
  if (st.isSymbolicLink()) throw new ErroGravacao(`${p} é um atalho (link simbólico). Por segurança não gravo segredo passando por atalho.`, 'ATALHO');
  if (!st.isDirectory()) throw new ErroGravacao(`${p} existe mas não é uma pasta.`, 'NAO_E_PASTA');
  if (st.uid !== 0 && st.uid !== uidPermitido) {
    throw new ErroGravacao(`A pasta ${p} é do usuário ${st.uid}, que não é o root nem o dono do arquivo (${uidPermitido}). Outra pessoa poderia trocar o que tem dentro.`, 'PASTA_DE_OUTRO');
  }
  if (st.mode & 0o022) {
    throw new ErroGravacao(`A pasta ${p} aceita escrita de grupo ou de outros (modo ${(st.mode & 0o777).toString(8)}). Deixe 700 ou 755 antes de gravar segredo nela.`, 'PASTA_ABERTA');
  }
  return st;
}

/** Lista as pastas de `raizReal` (inclusive) até `pasta` (inclusive). */
function pastasDoCaminho(raizReal, pasta) {
  const rel = path.relative(raizReal, pasta);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const lista = [raizReal];
  let atual = raizReal;
  for (const parte of rel ? rel.split(path.sep) : []) {
    atual = path.join(atual, parte);
    lista.push(atual);
  }
  return lista;
}

/**
 * Grava `conteudo` em `caminho` de forma atômica e segura. Síncrona.
 *
 * opcoes:
 *   raiz   (obrigatória) pasta que tem de conter o destino.
 *   uid, gid  dono do arquivo. Sem eles: o dono do arquivo que já existe; se não existe,
 *             o dono da pasta onde ele fica.
 *   modo   modo do arquivo. Sem ele: o do arquivo que já existe; se não existe, 0o600.
 *   pasta  { modo, uid, gid } para criar a pasta do arquivo se ela faltar (só um nível,
 *          a pasta-mãe dela tem de existir). Se ela já existe, dono e modo são conferidos,
 *          não alterados.
 *
 * Devolve { caminho, uid, gid, modo, bytes }. Lança ErroGravacao (mensagem em português,
 * `code` estável) quando recusa ou quando a escrita falha.
 */
function gravaArquivoSeguro(caminho, conteudo, opcoes) {
  const o = opcoes || {};
  if (typeof caminho !== 'string' || !path.isAbsolute(caminho)) {
    throw new ErroGravacao(`O destino precisa ser um caminho absoluto (recebi ${JSON.stringify(caminho)}).`, 'OPCAO_INVALIDA');
  }
  if (typeof o.raiz !== 'string' || !path.isAbsolute(o.raiz)) {
    throw new ErroGravacao('Faltou a opção raiz (caminho absoluto da pasta que tem de conter o arquivo).', 'OPCAO_INVALIDA');
  }
  const dados = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo == null ? '' : conteudo), 'utf8');
  let uid = inteiroOuNull(o.uid, 'uid');
  let gid = inteiroOuNull(o.gid, 'gid');
  let modo = inteiroOuNull(o.modo, 'modo');
  if (modo != null && modo > 0o777) throw new ErroGravacao(`O modo ${modo.toString(8)} não vale para um arquivo de segredo.`, 'OPCAO_INVALIDA');

  let raizReal;
  try { raizReal = fs.realpathSync(o.raiz); } catch (e) {
    throw new ErroGravacao(`A raiz ${o.raiz} não existe ou não pôde ser lida (${e.code || e.name}).`, 'PASTA_AUSENTE');
  }
  const destino = path.resolve(caminho);
  const pasta = path.dirname(destino);
  const nome = path.basename(destino);
  const pastas = pastasDoCaminho(raizReal, pasta);
  if (!pastas || destino === raizReal) {
    throw new ErroGravacao(`O destino ${destino} fica fora da raiz permitida (${raizReal}).`, 'FORA_DA_RAIZ');
  }

  // O destino que já existe manda no dono e no modo que faltaram.
  let atual = null;
  try { atual = fs.lstatSync(destino); } catch (e) {
    if (e.code !== 'ENOENT') throw new ErroGravacao(`Não consegui conferir ${destino} (${e.code || e.name}).`, 'FALHA_ESCRITA');
  }
  if (atual) {
    if (atual.isSymbolicLink()) throw new ErroGravacao(`${destino} é um atalho (link simbólico). Por segurança não gravo segredo nele.`, 'ATALHO');
    if (!atual.isFile()) throw new ErroGravacao(`${destino} existe mas não é um arquivo comum.`, 'NAO_E_ARQUIVO');
    if (uid == null) uid = atual.uid;
    if (gid == null) gid = atual.gid;
    if (modo == null) modo = atual.mode & 0o777;
  }

  // Pasta do arquivo: cria se pedido e se faltar (um nível só).
  const criar = o.pasta || null;
  if (criar) {
    try { fs.lstatSync(pasta); } catch (e) {
      if (e.code !== 'ENOENT') throw new ErroGravacao(`Não consegui conferir a pasta ${pasta} (${e.code || e.name}).`, 'FALHA_ESCRITA');
      const pm = inteiroOuNull(criar.modo, 'pasta.modo');
      const pu = inteiroOuNull(criar.uid, 'pasta.uid');
      const pg = inteiroOuNull(criar.gid, 'pasta.gid');
      if (pm == null || pu == null || pg == null) throw new ErroGravacao('Para criar a pasta preciso de pasta.modo, pasta.uid e pasta.gid.', 'OPCAO_INVALIDA');
      for (const p of pastas.slice(0, -1)) conferePasta(p, pu);
      try {
        fs.mkdirSync(pasta, { mode: 0o700 });
        fs.chownSync(pasta, pu, pg);
        fs.chmodSync(pasta, pm);
      } catch (e2) {
        throw new ErroGravacao(`Não consegui criar a pasta ${pasta} (${e2.code || e2.name}).`, 'FALHA_ESCRITA');
      }
    }
  }

  if (uid == null || gid == null) {
    let sp;
    try { sp = fs.lstatSync(pasta); } catch (e) {
      throw new ErroGravacao(`A pasta ${pasta} não existe (${e.code || e.name}).`, 'PASTA_AUSENTE');
    }
    if (uid == null) uid = sp.uid;
    if (gid == null) gid = sp.gid;
  }
  if (modo == null) modo = 0o600;

  for (const p of pastas) conferePasta(p, uid);

  const tmp = path.join(pasta, `.${nome}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, dados, 0, dados.length, 0);
    fs.fsyncSync(fd);
    fs.fchownSync(fd, uid, gid);
    fs.fchmodSync(fd, modo);
    fs.closeSync(fd);
    fd = null;
    for (const p of pastas) conferePasta(p, uid);
    fs.renameSync(tmp, destino);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* já fechado */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* não chegou a existir ou já foi trocado */ }
    if (e instanceof ErroGravacao) throw e;
    throw new ErroGravacao(`Não consegui gravar ${destino} (${e.code || e.name}). Nada foi alterado no arquivo.`, 'FALHA_ESCRITA');
  }
  // fsync da pasta: sem ele a troca de nome pode se perder numa queda de energia.
  try {
    const fdp = fs.openSync(pasta, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fdp); } finally { fs.closeSync(fdp); }
  } catch (_) { /* o arquivo já está no lugar; o fsync da pasta é só reforço */ }

  return { caminho: destino, uid, gid, modo, bytes: dados.length };
}

module.exports = { gravaArquivoSeguro, ErroGravacao };
