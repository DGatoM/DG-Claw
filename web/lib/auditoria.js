'use strict';
// Trilha de auditoria (lado Node). O lado bash é lib/enterprise/auditoria.sh; os dois escrevem
// na mesma corrente, no mesmo arquivo e com a mesma trava.
//
// Linha: {"ts","evento","quem","origem","dados","ant","hash"}. `ant` é o `hash` da linha anterior
// (64 zeros na primeira). `hash` = sha256 de (ant + a linha sem o campo hash, como foi escrita).
// Quem confere recorta o texto da linha, nunca re-serializa: bash (jq) e Node (JSON.stringify)
// escapam alguns caracteres de jeitos diferentes, e a conferência não pode depender disso.
// Trava: `mkdir <arquivo>.trava`. Trava com mais de 30 s é de processo morto: sai com aviso.
// A corrente prova que nada foi alterado ou apagado no MEIO da trilha; cortar o fim só se
// descobre guardando o último hash fora do servidor (nível `externa`, web/lib/auditoria-externa.js).
// Nível completo em diante: o arquivo vira auditoria-AAAA-MM.jsonl por mês e a corrente atravessa os arquivos
// (regras em web/lib/auditoria-corrente.js). `caminho` continua sendo o auditoria.jsonl; é ele que dá nome à trava.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const corrente = require('./auditoria-corrente');

const { ZERO, RX_HASH } = corrente;
const TRAVA_VELHA_MS = 30 * 1000;
const DORME = new Int32Array(new SharedArrayBuffer(4));

const sha = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const dormir = (ms) => Atomics.wait(DORME, 0, 0, ms);

function criarAuditoria(opcoes) {
  const o = opcoes || {};
  const { caminho, protecoes } = o;
  const log = o.log || (() => {});
  const agora = o.agora || Date.now;
  if (!caminho) throw new Error('criarAuditoria precisa do caminho do auditoria.jsonl (por exemplo /var/log/dgclaw/auditoria.jsonl).');
  const trava = `${caminho}.trava`;
  // Mesma variável do bash (décimos de segundo), lida na criação para o teste poder encurtar.
  const ESPERA_MAX_MS = o.esperaMs != null ? o.esperaMs : Number(process.env.DGCLAW_AUDITORIA_ESPERA_DS || 100) * 100;

  function pegarTrava() {
    const limite = Date.now() + ESPERA_MAX_MS;
    for (;;) {
      try {
        fs.mkdirSync(trava);
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw new Error(`Não consegui criar a trava da auditoria ${trava} (${e.code || e.message}). Confira a permissão da pasta ${path.dirname(caminho)}.`);
      }
      let idade = 0;
      try { idade = Date.now() - fs.statSync(trava).mtimeMs; } catch (_) { continue; /* sumiu entre o mkdir e o stat: tenta de novo */ }
      if (idade > TRAVA_VELHA_MS) {
        log('aviso', `A trava ${trava} tinha ${Math.round(idade / 1000)} s (mais de 30); o processo que a criou provavelmente morreu. Estou removendo e seguindo.`);
        try { fs.rmdirSync(trava); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      if (Date.now() > limite) throw new Error(`Não consegui a trava da auditoria (${trava}) em ${ESPERA_MAX_MS / 1000} s: outro processo a segura. Espere e repita; se nada estiver rodando, apague a pasta ${trava}.`);
      dormir(20);
    }
  }

  function soltarTrava() {
    try { fs.rmdirSync(trava); } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Não consegui soltar a trava ${trava} (${e.code || e.message}). Apague a pasta se ela ficar para trás.`);
    }
  }

  /** Acrescenta um evento. Devolve a linha gravada, ou null se a auditoria está desligada no nível. */
  function registrar(evento, dados, quem, origem) {
    if (!evento || typeof evento !== 'string') throw new Error('registrar precisa do nome do evento (texto), por exemplo "login".');
    if (protecoes && protecoes.valor('auditoria') === 'nao') return null;
    const d = dados == null ? {} : dados;
    if (typeof d !== 'object' || Array.isArray(d)) throw new Error(`Os dados do evento "${evento}" precisam ser um objeto, e recebi ${Array.isArray(d) ? 'uma lista' : typeof d}.`);
    fs.mkdirSync(path.dirname(caminho), { recursive: true, mode: 0o750 });
    pegarTrava();
    try {
      const instante = agora();
      const nivel = protecoes ? protecoes.valor('auditoria') : null;
      if (nivel === 'completa' || nivel === 'externa') corrente.rotacionar(caminho, instante, log);
      const alvo = caminho;
      let ant = null;
      if (fs.existsSync(alvo)) {
        const ultima = corrente.ultimaLinha(alvo);
        if (ultima) {
          const m = RX_HASH.exec(ultima);
          if (m) ant = m[1];
          else {
            ant = ZERO;
            log('aviso', `A última linha de ${alvo} não tem hash válido (arquivo cortado ou editado); recomecei a corrente aqui. A conferência vai apontar essa linha.`);
          }
        }
      }
      // arquivo vivo novo ou vazio (primeiro evento do mês): a corrente continua do último hash do arquivo fechado
      if (ant === null) ant = corrente.hashAnterior(caminho);
      const corpo = JSON.stringify({
        ts: new Date(instante).toISOString(), evento, quem: quem || process.env.DGCLAW_QUEM || process.env.USER || 'desconhecido',
        origem: origem || 'web', dados: d, ant,
      });
      const hash = sha(ant + corpo);
      const linha = `${corpo.slice(0, -1)},"hash":"${hash}"}`;
      const novo = !fs.existsSync(alvo);
      let prefixo = '';
      if (!novo && fs.statSync(alvo).size > 0) {
        const lido = fs.openSync(alvo, 'r');
        try {
          const b = Buffer.alloc(1);
          fs.readSync(lido, b, 0, 1, fs.fstatSync(lido).size - 1);
          if (b[0] !== 0x0a) prefixo = '\n';
        } finally {
          fs.closeSync(lido);
        }
      }
      const fd = fs.openSync(alvo, 'a', 0o600);
      try {
        fs.writeSync(fd, `${prefixo}${linha}\n`);
        fs.fsyncSync(fd);
        if (novo) fs.fchmodSync(fd, 0o600);
      } finally {
        fs.closeSync(fd);
      }
      return linha;
    } finally {
      soltarTrava();
    }
  }

  /** Confere a corrente inteira (todos os arquivos). { ok, linhas } ou { ok:false, linhas, quebradaEm, arquivo, motivo }. */
  function verificar() {
    return corrente.verificar(caminho);
  }

  return { registrar, verificar, caminho };
}

module.exports = { criarAuditoria, ZERO };
