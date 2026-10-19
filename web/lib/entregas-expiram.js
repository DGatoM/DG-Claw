'use strict';
// Entregas com prazo (bloco I): o relatório que uma ferramenta sensível gera vai para <casa>/.dgclaw/entregas/ com um
// arquivo irmão <nome>.expira (data ISO). Aqui está a varredura que apaga o relatório e o .expira quando o prazo passa.
// Roda como root no Web: só entra em pasta real (nunca atalho) que fique dentro da casa do agente.

const fs = require('node:fs');
const path = require('node:path');

const SUFIXO = '.expira';

/** Apaga as entregas vencidas da casa de um agente. Devolve { apagadas, orfas, erros }. */
function varrerCasa(home, agora, log) {
  const saida = { apagadas: 0, orfas: 0, erros: 0 };
  let homeReal;
  try { homeReal = fs.realpathSync(home); } catch (e) {
    if (e.code !== 'ENOENT') { log('aviso', `Entregas com prazo: não consegui resolver a casa ${home} (${e.code || e.message}).`); saida.erros++; }
    return saida;
  }
  const pasta = path.join(homeReal, '.dgclaw', 'entregas');
  let st;
  try { st = fs.lstatSync(pasta); } catch (e) {
    if (e.code !== 'ENOENT') { log('aviso', `Entregas com prazo: não consegui conferir ${pasta} (${e.code || e.message}).`); saida.erros++; }
    return saida;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    log('aviso', `Entregas com prazo: ${pasta} não é uma pasta comum (é um atalho ou outro tipo). Não varri; confira com: dgclaw agente reparar.`);
    saida.erros++;
    return saida;
  }
  let nomes;
  try { nomes = fs.readdirSync(pasta); } catch (e) {
    log('aviso', `Entregas com prazo: não consegui listar ${pasta} (${e.code || e.message}).`);
    saida.erros++;
    return saida;
  }
  for (const n of nomes) {
    if (!n.endsWith(SUFIXO) || n === SUFIXO) continue;
    const marca = path.join(pasta, n);
    const alvo = path.join(pasta, n.slice(0, -SUFIXO.length));
    try {
      const ms = fs.lstatSync(marca);
      if (!ms.isFile()) continue;
      const quando = Date.parse(fs.readFileSync(marca, 'utf8').trim());
      if (Number.isNaN(quando)) { log('aviso', `Entregas com prazo: ${marca} não tem uma data ISO válida; mantive o relatório.`); saida.erros++; continue; }
      if (quando > agora) continue;
      let existe = true;
      try { fs.lstatSync(alvo); } catch (e) { if (e.code !== 'ENOENT') throw e; existe = false; }
      // unlink não segue atalho: se o alvo for um link, só o link some.
      if (existe) { fs.unlinkSync(alvo); saida.apagadas++; } else saida.orfas++;
      fs.unlinkSync(marca);
    } catch (e) {
      log('erro', `Entregas com prazo: não consegui apagar ${alvo} (${e.code || e.message}). Apague à mão: o prazo dele já passou.`);
      saida.erros++;
    }
  }
  return saida;
}

/** Varre a casa de todos os agentes do registro. */
function varrer({ agentes, agora, log }) {
  const total = { apagadas: 0, orfas: 0, erros: 0 };
  for (const a of agentes || []) {
    if (!a.home_host) continue;
    const r = varrerCasa(a.home_host, agora, log);
    total.apagadas += r.apagadas; total.orfas += r.orfas; total.erros += r.erros;
  }
  return total;
}

module.exports = { varrer, varrerCasa, SUFIXO };
