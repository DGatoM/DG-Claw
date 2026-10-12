'use strict';
// Upload multipart sem dependências. O corpo é lido em memória até o limite configurado
// (DGCLAW_WEB_MAX_UPLOAD_MB, padrão 50) e gravado em <home_host>/uploads/AAAA-MM-DD/.

const fs = require('node:fs');
const path = require('node:path');
const { lerCorpo } = require('./http');

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

/** Grava sem sobrescrever (flag wx; se existir, acrescenta -1, -2...). Devolve o caminho final. */
function gravaSemSobrescrever(pasta, nome, dados) {
  const ext = path.extname(nome);
  const raiz = path.basename(nome, ext);
  for (let i = 0; i < 1000; i += 1) {
    const alvo = path.join(pasta, i === 0 ? nome : `${raiz}-${i}${ext}`);
    try {
      fs.writeFileSync(alvo, dados, { flag: 'wx', mode: 0o644 });
      return alvo;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Não achei um nome livre para o arquivo.');
}

module.exports = { lerMultipart, nomeSeguro, gravaSemSobrescrever };
