'use strict';
// Upload multipart sem dependências. O corpo é lido em memória até o limite configurado
// (DGCLAW_WEB_MAX_UPLOAD_MB, padrão 50) e gravado em <home_host>/uploads/AAAA-MM-DD/, sem seguir atalho (ver gravaUpload).

const fs = require('node:fs');
const path = require('node:path');
const { lerCorpo } = require('./http');
const { gravaArquivoSeguro, ErroGravacao } = require('./grava-seguro');

/** Lê um multipart. Devolve { campos:{nome:valor}, arquivos:[{campo,nome,tipo,dados}] }. Lança erro com .status. */
async function lerMultipart(req, limite) {
  const ct = String(req.headers['content-type'] || '');
  const m = /multipart\/form-data;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  if (!m) {
    const e = new Error('Mande o arquivo como multipart/form-data (campo "file").');
    e.status = 400;
    throw e;
  }
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > limite + 64 * 1024) {
    const e = new Error(`O envio tem ${Math.round(declarado / 1048576)} MB e o limite aqui é ${Math.round(limite / 1048576)} MB.`);
    e.status = 413;
    req.resume();
    throw e;
  }
  let corpo;
  try {
    corpo = await lerCorpo(req, limite + 64 * 1024);
  } catch (e) {
    if (e.status === 413) e.message = `O envio passou do limite de ${Math.round(limite / 1048576)} MB.`;
    throw e;
  }
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const campos = {}; const arquivos = [];
  let pos = corpo.indexOf(delim);
  while (pos >= 0) {
    const ini = pos + delim.length;
    if (corpo[ini] === 0x2d && corpo[ini + 1] === 0x2d) break; // "--" final
    const comeco = corpo[ini] === 0x0d ? ini + 2 : ini + 1;
    const prox = corpo.indexOf(delim, comeco);
    if (prox < 0) break;
    let fimParte = prox;
    if (corpo[fimParte - 2] === 0x0d && corpo[fimParte - 1] === 0x0a) fimParte -= 2;
    const parte = corpo.subarray(comeco, fimParte);
    const sep = parte.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const cab = parte.subarray(0, sep).toString('utf8');
      const dados = parte.subarray(sep + 4);
      const disp = /content-disposition:[^\r\n]*/i.exec(cab);
      const nomeCampo = disp && /\bname="([^"]*)"/i.exec(disp[0]);
      const nomeArq = disp && /\bfilename="([^"]*)"/i.exec(disp[0]);
      const tipo = /content-type:\s*([^\r\n;]+)/i.exec(cab);
      if (nomeCampo) {
        if (nomeArq) arquivos.push({ campo: nomeCampo[1], nome: nomeArq[1], tipo: tipo ? tipo[1].trim() : '', dados });
        else campos[nomeCampo[1]] = dados.toString('utf8');
      }
    }
    pos = prox;
  }
  return { campos, arquivos };
}

/** Nome seguro: sem pasta, sem acento, sem caracteres estranhos, com extensão em minúsculas. */
function nomeSeguro(original) {
  const base = path.basename(String(original || '').replace(/\\/g, '/'));
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  let raiz = path.basename(base, path.extname(base)).normalize('NFD').replace(/\p{M}/gu, '');
  raiz = raiz.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').replace(/_+/g, '_').slice(0, 80);
  return `${raiz || 'arquivo'}${ext}`;
}

/** Dono da casa do agente (uid/gid), ou lança Error em português. Casa de root é aceita: é a do Admin, que já roda como root. */
function donoDaCasa(agente) {
  let st;
  try { st = fs.statSync(agente.home_host); } catch (e) {
    throw new Error(`A casa do agente ${agente.nome} (${agente.home_host}) não existe ou não pôde ser lida (${e.code || e.name}). Confira o home_host no registro de agentes.`);
  }
  if (!st.isDirectory()) throw new Error(`O home_host de ${agente.nome} (${agente.home_host}) não é uma pasta. Confira o registro de agentes.`);
  return { uid: st.uid, gid: st.gid };
}

/**
 * Grava <casa>/uploads/<dia>/<nome> sem seguir atalho em nenhum ponto do caminho a partir da casa,
 * com o dono da casa e sem sobrescrever (se o nome existe, tenta nome-1, nome-2...).
 * O Web é root e a casa é gravável pelo agente: um atalho trocado por ele (uploads, a pasta do
 * dia) levaria o root a gravar fora da casa. Lança Error (ou ErroGravacao) em português.
 * Devolve o caminho final.
 */
function gravaUpload(agente, dia, nome, dados) {
  if (!agente.home_host) throw new Error(`O agente ${agente.nome} não tem home_host no registro, então não há onde guardar anexos.`);
  const dono = donoDaCasa(agente);
  const pasta = path.join(agente.home_host, 'uploads', dia);
  const ext = path.extname(nome);
  const raiz = path.basename(nome, ext);
  for (let i = 0; i < 1000; i += 1) {
    const alvo = path.join(pasta, i === 0 ? nome : `${raiz}-${i}${ext}`);
    try {
      return gravaArquivoSeguro(alvo, dados, {
        raiz: agente.home_host, uid: dono.uid, gid: dono.gid, modo: 0o644, exclusivo: true,
        pasta: { modo: 0o755, uid: dono.uid, gid: dono.gid, recursiva: true },
      }).caminho;
    } catch (e) {
      // nome já usado (inclusive por um atalho com esse nome, que nunca é seguido): tenta o próximo
      if (e instanceof ErroGravacao && (e.code === 'JA_EXISTE' || e.code === 'ATALHO' || e.code === 'NAO_E_ARQUIVO') && e.message.startsWith(alvo)) continue; // só o arquivo; atalho em pasta do caminho segue como erro
      throw e;
    }
  }
  throw new Error(`Não achei um nome livre para o arquivo ${nome} em ${pasta}.`);
}

module.exports = { lerMultipart, nomeSeguro, gravaUpload };
