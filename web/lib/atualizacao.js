'use strict';
// Aviso de nova versão do DG Claw: o painel só LÊ o estado que scripts/checar-atualizacao.mjs grava
// (o Web não consulta o GitHub nem instala nada) e guarda quando o dono dispensou a faixa.
// Contrato das rotas: web/docs/ATUALIZACAO.md. Visão geral: docs/AVISO-DE-ATUALIZACAO.md.
//
// O estado vem de uma pasta que só o root escreve, mas o texto dentro dele nasceu no GitHub:
// aqui cada campo é conferido de novo antes de sair pela API, e quem desenha (a faixa) escapa.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');

const BASE = '/api/v1/atualizacao';
const RX_SHA = /^[0-9a-f]{40}$/;
const RX_VERSAO = /^[0-9A-Za-z._+-]{1,40}$/;
const RX_DATA = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,12}(Z|[+-]\d{2}:\d{2})$/;

const texto = (v, max) => (typeof v === 'string' ? Array.from(v).slice(0, max).join('') : null);
const sha = (v) => (typeof v === 'string' && RX_SHA.test(v) ? v : null);
const versao = (v) => (typeof v === 'string' && RX_VERSAO.test(v) ? v : null);
const data = (v) => (typeof v === 'string' && RX_DATA.test(v) ? v : null);

function commitInfo(v, comData) {
  if (!v || typeof v !== 'object') return null;
  const commit = sha(v.commit);
  if (!commit) return null;
  const saida = { commit, versao: versao(v.versao) };
  if (comData) saida.data = data(v.data);
  return saida;
}

/** Só o que a API promete, com tipo e tamanho conferidos. */
function normaliza(e) {
  const novidades = Array.isArray(e.novidades)
    ? e.novidades.filter((n) => typeof n === 'string').slice(0, 15).map((n) => texto(n, 400)).filter(Boolean)
    : [];
  const erro = e.erro && typeof e.erro === 'object'
    ? { quando: data(e.erro.quando), motivo: texto(e.erro.motivo, 600) }
    : null;
  return {
    desligado: e.desligado === true,
    disponivel: e.disponivel === true,
    motivo: texto(e.motivo, 80),
    instalado: commitInfo(e.instalado, false),
    publicado: commitInfo(e.publicado, true),
    commits_a_frente: Number.isInteger(e.commits_a_frente) && e.commits_a_frente >= 0 ? e.commits_a_frente : 0,
    fonte_resumo: e.fonte_resumo === 'changelog' || e.fonte_resumo === 'commits' ? e.fonte_resumo : null,
    novidades,
    verificado_em: data(e.verificado_em),
    erro,
  };
}

function criarAtualizacao(opcoes) {
  const { dataDir, log } = opcoes;
  const dir = path.join(dataDir, 'atualizacao');
  const arqEstado = path.join(dir, 'estado.json');
  const arqDescanso = path.join(dir, 'descanso.json');

  /** { ausente: true } | { erro } | { estado }. */
  function lerEstado() {
    let bruto;
    try { bruto = fs.readFileSync(arqEstado, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { ausente: true };
      return { erro: `Não consegui ler ${arqEstado} (${e.code || e.message}). Rode "sudo dgclaw atualizar --checar" no servidor para refazê-lo.` };
    }
    let j;
    try { j = JSON.parse(bruto); } catch (e) {
      return { erro: `O arquivo ${arqEstado} está corrompido (${e.message}). Rode "sudo dgclaw atualizar --checar" no servidor para refazê-lo.` };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      return { erro: `O arquivo ${arqEstado} não tem o formato esperado. Rode "sudo dgclaw atualizar --checar" no servidor para refazê-lo.` };
    }
    return { estado: normaliza(j) };
  }

  /** O commit publicado que o dono dispensou, ou null. Arquivo ilegível vale como "não dispensou" (a faixa aparece de novo). */
  function lerDescanso() {
    try {
      const d = JSON.parse(fs.readFileSync(arqDescanso, 'utf8'));
      return d && typeof d === 'object' ? sha(d.commit) : null;
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Atualização: ${arqDescanso} está ilegível (${e.code || e.message}); a faixa volta a aparecer até o dono dispensar de novo.`);
      return null;
    }
  }

  function gravaDescanso(commit) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${arqDescanso}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ commit, quando: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, arqDescanso);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter sido criado */ }
      throw e;
    }
  }

  function estadoDaApi(res) {
    const l = lerEstado();
    if (l.ausente) {
      return H.enviaJson(res, 200, { ok: true, disponivel: false, mostrar_faixa: false, nunca_verificado: true });
    }
    if (l.erro) {
      log('erro', `Atualização: ${l.erro}`);
      return H.erroJson(res, 500, l.erro);
    }
    const e = l.estado;
    const dispensado = lerDescanso();
    const mostrar = e.disponivel && !!e.publicado && dispensado !== e.publicado.commit;
    return H.enviaJson(res, 200, {
      ok: true, desligado: e.desligado, disponivel: e.disponivel, mostrar_faixa: mostrar, motivo: e.motivo,
      instalado: e.instalado, publicado: e.publicado, commits_a_frente: e.commits_a_frente,
      novidades: e.novidades, fonte_resumo: e.fonte_resumo, verificado_em: e.verificado_em, erro: e.erro,
    });
  }

  async function descansar(req, res) {
    const corpo = await H.lerJson(req, 1024);
    const commit = corpo.commit;
    if (typeof commit !== 'string' || !RX_SHA.test(commit)) {
      return H.erroJson(res, 400, 'Mande {"commit": "<40 caracteres hexadecimais>"} com o commit publicado que aparece em GET ' + BASE + '.');
    }
    const l = lerEstado();
    if (l.erro) { log('erro', `Atualização: ${l.erro}`); return H.erroJson(res, 500, l.erro); }
    const atual = l.estado && l.estado.disponivel && l.estado.publicado ? l.estado.publicado.commit : null;
    if (commit !== atual) {
      return H.erroJson(res, 409, atual
        ? 'Esse não é mais o commit publicado: saiu uma versão mais nova. Atualize a tela e dispense a faixa de novo.'
        : 'Não há aviso de versão nova para dispensar agora. Atualize a tela.');
    }
    try { gravaDescanso(commit); } catch (e) {
      log('erro', `Atualização: não consegui gravar ${arqDescanso} (${e.code || e.message}).`);
      return H.erroJson(res, 500, 'Não consegui guardar que você dispensou o aviso. Peça ao Admin para conferir o espaço em disco e as permissões de /var/lib/dgclaw/web/atualizacao.');
    }
    return H.enviaJson(res, 200, { ok: true, dispensado: commit });
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ATUALIZACAO.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Atualização: não consegui ler docs/ATUALIZACAO.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento do aviso de atualização não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Devolve true quando tratou o pedido. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    // Agente não tem o que fazer aqui; o servidor já não libera a rota na caixa, isto é a segunda trava.
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'O aviso de atualização é só do dono, pelo painel. Agente não usa esta rota.');
      return true;
    }
    const m = req.method;
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '') { if (m !== 'GET') return metodoErrado('GET'); estadoDaApi(res); return true; }
      if (sub === '/docs.md') { if (m !== 'GET') return metodoErrado('GET'); docs(res); return true; }
      if (sub === '/descansar') { if (m !== 'POST') return metodoErrado('POST'); await descansar(req, res); return true; }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message); return true; }
      log('erro', `Atualização: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido do aviso de atualização. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  return { rotas, lerEstado, normaliza };
}

module.exports = { criarAtualizacao };
