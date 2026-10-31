'use strict';
// Aviso de segurança: o painel só LÊ o que scripts/checar-boletins.mjs grava (o Web não consulta o GitHub nem
// instala nada) e guarda quando o dono adiou ou dispensou o aviso.
// Contrato das rotas: web/docs/SEGURANCA-BOLETINS.md. Visão geral: docs/BOLETINS-DE-SEGURANCA.md.
//
// O arquivo vem de uma pasta que só o root escreve, mas o texto dentro dele nasceu no GitHub: cada boletim é
// revalidado pelo contrato antes de sair pela API, e quem desenha (a tela) escapa.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const C = require('./boletim-contrato');

const BASE = '/api/v1/seguranca';
const ADIAR_MS = 24 * 3600 * 1000;
const COMO_REFAZER = 'Rode "sudo systemctl start dgclaw-checar-boletins.service" no servidor para refazê-lo.';

const texto = (v, max) => (typeof v === 'string' ? Array.from(v).slice(0, max).join('') : null);
const data = (v) => (typeof v === 'string' && C.RX_DATA.test(v) ? v : null);

function criarSeguranca(opcoes) {
  const { dataDir, log } = opcoes;
  const relogio = opcoes.agora || (() => Date.now());
  const dir = path.join(dataDir, 'atualizacao');
  const arqBoletins = path.join(dir, 'boletins.json');
  const arqAdiados = path.join(dir, 'boletins-adiados.json');

  /** { ausente: true } | { erro } | { estado: {desligado, verificado_em, erro, pendentes} }. */
  function lerEstado() {
    let bruto;
    try { bruto = fs.readFileSync(arqBoletins, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { ausente: true };
      return { erro: `Não consegui ler ${arqBoletins} (${e.code || e.message}). ${COMO_REFAZER}` };
    }
    let j;
    try { j = JSON.parse(bruto); } catch (e) {
      return { erro: `O arquivo ${arqBoletins} está corrompido (${e.message}). ${COMO_REFAZER}` };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.pendentes)) {
      return { erro: `O arquivo ${arqBoletins} não tem o formato esperado. ${COMO_REFAZER}` };
    }
    const pendentes = [];
    for (const item of j.pendentes) {
      const r = C.validaBoletim(item);
      if (r.boletim) pendentes.push(r.boletim);
      else log('aviso', `Segurança: descartei um boletim de ${arqBoletins} que não passa no contrato (${r.id || 'sem id'}: ${r.motivo}).`);
    }
    const erro = j.erro && typeof j.erro === 'object' ? { quando: data(j.erro.quando), motivo: texto(j.erro.motivo, 600) } : null;
    return { estado: { desligado: j.desligado === true, verificado_em: data(j.verificado_em), erro, pendentes: C.ordena(pendentes) } };
  }

  /** { adiados: {id: iso}, dispensados: {id: iso} }. Ilegível vale como "nada adiado" (o aviso volta a aparecer). */
  function lerAdiados() {
    try {
      const d = JSON.parse(fs.readFileSync(arqAdiados, 'utf8'));
      const limpa = (o) => {
        const s = {};
        if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (C.RX_ID.test(k) && data(v)) s[k] = v;
        return s;
      };
      return { adiados: limpa(d && d.adiados), dispensados: limpa(d && d.dispensados) };
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Segurança: ${arqAdiados} está ilegível (${e.code || e.message}); o aviso volta a aparecer até o dono adiar de novo.`);
      return { adiados: {}, dispensados: {} };
    }
  }

  function gravaAdiados(estado) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${arqAdiados}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(estado)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, arqAdiados);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter sido criado */ }
      throw e;
    }
  }

  function falhaDeGravacao(res, e) {
    log('erro', `Segurança: não consegui gravar ${arqAdiados} (${e.code || e.message}).`);
    return H.erroJson(res, 500, 'Não consegui guardar a sua escolha. Peça ao Admin para conferir o espaço em disco e as permissões de /var/lib/dgclaw/web/atualizacao.');
  }

  function listar(res) {
    const l = lerEstado();
    if (l.ausente) {
      return H.enviaJson(res, 200, { ok: true, nunca_verificado: true, verificado_em: null, erro: null, boletins: [] });
    }
    if (l.erro) { log('erro', `Segurança: ${l.erro}`); return H.erroJson(res, 500, l.erro); }
    const agora = relogio();
    const { adiados, dispensados } = lerAdiados();
    const boletins = l.estado.pendentes.map((b) => {
      const ate = adiados[b.id] && Date.parse(adiados[b.id]) > agora ? adiados[b.id] : null;
      const dispensado = !!dispensados[b.id];
      return { ...b, pendente: true, adiado_ate: ate, dispensado, mostrar_modal: !ate && !dispensado };
    });
    return H.enviaJson(res, 200, {
      ok: true, desligado: l.estado.desligado, verificado_em: l.estado.verificado_em, erro: l.estado.erro, boletins,
    });
  }

  /** O boletim pendente com esse id, ou responde o erro e devolve null. */
  function achaPendente(res, id) {
    if (!C.RX_ID.test(id)) { H.erroJson(res, 400, 'O id do boletim não tem o formato esperado (letras maiúsculas, números, ponto, hífen e sublinhado). Use um id de GET ' + BASE + '/boletins.'); return null; }
    const l = lerEstado();
    if (l.erro) { log('erro', `Segurança: ${l.erro}`); H.erroJson(res, 500, l.erro); return null; }
    const b = l.estado && l.estado.pendentes.find((x) => x.id === id);
    if (!b) {
      H.erroJson(res, 404, `Não há boletim pendente com o id ${id}. Ele pode já ter sido corrigido pela atualização. Atualize a tela.`);
      return null;
    }
    return b;
  }

  /** Tira do arquivo os ids que não estão mais pendentes e as marcas vencidas: ele não cresce para sempre. */
  function podado(estado, pendentesIds, agora) {
    const adiados = {};
    for (const [k, v] of Object.entries(estado.adiados)) if (pendentesIds.has(k) && Date.parse(v) > agora) adiados[k] = v;
    const dispensados = {};
    for (const [k, v] of Object.entries(estado.dispensados)) if (pendentesIds.has(k)) dispensados[k] = v;
    return { adiados, dispensados };
  }

  function adiar(res, id) {
    const b = achaPendente(res, id);
    if (!b) return;
    const agora = relogio();
    const ate = new Date(agora + ADIAR_MS).toISOString();
    const atual = lerAdiados();
    atual.adiados[id] = ate;
    const ids = new Set(lerEstado().estado.pendentes.map((x) => x.id));
    try { gravaAdiados(podado(atual, ids, agora)); } catch (e) { return falhaDeGravacao(res, e); }
    return H.enviaJson(res, 200, { ok: true, id, adiado_ate: ate });
  }

  function dispensar(res, id) {
    const b = achaPendente(res, id);
    if (!b) return;
    if (b.acao !== 'aguardar') {
      return H.erroJson(res, 409, 'Este aviso só some quando o sistema for atualizado, porque ele pede uma ação sua. Para tirá-lo da frente por 24 horas, use POST ' + `${BASE}/boletins/${id}/adiar` + '.');
    }
    const agora = relogio();
    const atual = lerAdiados();
    atual.dispensados[id] = new Date(agora).toISOString();
    const ids = new Set(lerEstado().estado.pendentes.map((x) => x.id));
    try { gravaAdiados(podado(atual, ids, agora)); } catch (e) { return falhaDeGravacao(res, e); }
    return H.enviaJson(res, 200, { ok: true, id, dispensado: true });
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SEGURANCA-BOLETINS.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Segurança: não consegui ler docs/SEGURANCA-BOLETINS.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento do aviso de segurança não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Devolve true quando tratou o pedido. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    // Agente em container não tem o que fazer aqui; a rota não entra em caixa.permitir, isto é a segunda trava.
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'O aviso de segurança é do dono, pelo painel. Agente não usa esta rota.');
      return true;
    }
    const m = req.method;
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '/boletins') { if (m !== 'GET') return metodoErrado('GET'); listar(res); return true; }
      if (sub === '/docs.md') { if (m !== 'GET') return metodoErrado('GET'); docs(res); return true; }
      const acao = /^\/boletins\/([^/]+)\/(adiar|dispensar)$/.exec(sub);
      if (acao) {
        if (m !== 'POST') return metodoErrado('POST');
        let id;
        try { id = decodeURIComponent(acao[1]); } catch { id = ''; }
        if (acao[2] === 'adiar') adiar(res, id); else dispensar(res, id);
        return true;
      }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message); return true; }
      log('erro', `Segurança: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido do aviso de segurança. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  return { rotas, lerEstado };
}

module.exports = { criarSeguranca };
