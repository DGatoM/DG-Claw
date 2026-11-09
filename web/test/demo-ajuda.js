'use strict';
// Apoio dos testes do modo demonstração: demo.json em pasta temporária, casa do agente, provedores falsos e um Web de teste.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pastaTemp, subirWeb } = require('./ajuda');

// Token do agente e chaves dos provedores nascem a cada rodada: o teste nunca carrega segredo escrito no código.
const aleatorio = () => crypto.randomBytes(18).toString('hex');
const TOKEN = aleatorio();
const CHAVES = { 'organizap.key': aleatorio(), 'cpdf.key': aleatorio(), 'openai.key': aleatorio() };
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** Provedores falsos: guardam cada chamada e respondem como o Organizap e o CPDF respondem. */
function provedoresFalsos() {
  const f = { chamadas: [], envios: [], falha: null, status202: false };
  const MARIA1 = { id: 'chat-maria-silva', name: 'Maria Silva', remoteJid: '5511999990001@s.whatsapp.net', isGroup: false };
  const MARIA2 = { id: 'chat-maria-souza', name: 'Maria Souza', remoteJid: '5511999990002@s.whatsapp.net', isGroup: false };
  const LID = { id: 'chat-lid', name: 'Maria Lid', remoteJid: '135720983351411@lid', isGroup: false };
  const resp = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
  f.fetch = async (url, init) => {
    const u = new URL(url);
    const corpo = init && init.body ? JSON.parse(init.body) : null;
    f.chamadas.push({ metodo: init.method, caminho: u.pathname, busca: Object.fromEntries(u.searchParams), corpo, cab: init.headers });
    if (f.falha) return resp(f.falha.status, f.falha.corpo);
    if (u.host === 'organizap.teste') {
      if (u.pathname === '/api/assistant/chats') {
        const q = (u.searchParams.get('search') || '').toLowerCase();
        if (q.includes('maria')) return resp(200, { success: true, data: [MARIA1, MARIA2, LID] });
        if (q === '5511999990001') return resp(200, { success: true, data: [MARIA1] });
        return resp(200, { success: true, data: [] });
      }
      if (/\/transcript$/.test(u.pathname)) {
        const msgs = [
          { id: 'm1', fromMe: false, body: 'Oi, quero uma proposta', timestamp: '2026-11-09T10:00:00Z', type: 'text' },
          { id: 'm2', fromMe: true, body: 'Claro, já te mando', timestamp: '2026-11-09T10:01:00Z', type: 'text' },
          { id: 'm3', fromMe: false, body: '', audioTranscript: 'pode ser hoje', timestamp: '2026-11-09T10:02:00Z', type: 'audio' },
        ];
        return resp(200, { success: true, data: { chat: MARIA1, messages: msgs } });
      }
      if (u.pathname.endsWith('/messages/send')) {
        f.envios.push({ via: 'organizap', corpo, chave: init.headers['Idempotency-Key'], auth: init.headers.Authorization });
        return resp(f.status202 ? 202 : 200, { success: true, data: { status: f.status202 ? 'PENDING' : 'SENT' } });
      }
      if (u.pathname.endsWith('/gmail/send')) {
        f.envios.push({ via: 'email', corpo, chave: init.headers['Idempotency-Key'] });
        return resp(202, { success: true, data: { status: 'PENDING' } });
      }
    }
    if (u.host === 'cpdf.teste') {
      if (u.pathname.endsWith('/contacts')) return resp(200, { items: [{ id: 'ct-1', displayName: 'Isa Contato', phone: '5511988887777' }] });
      if (u.pathname.endsWith('/whatsapp/instances')) return resp(200, { items: [{ id: 'inst-1', name: 'Isa', phone: '5511900000000', status: 'CONNECTED' }] });
      if (u.pathname.endsWith('/whatsapp/send')) {
        f.envios.push({ via: 'cpdf', corpo });
        return resp(200, { success: true, messageId: 'z1' });
      }
    }
    return resp(404, { success: false, error: 'rota não prevista no teste' });
  };
  return f;
}

/** Escreve o demo.json e as chaves (600) numa pasta nova. `ajusta(json)` altera o conteúdo; `modoChave` troca a permissão. */
function escreveConfig(dir, { ajusta, modoChave, modoArquivo } = {}) {
  const pastaChaves = path.join(dir, 'chaves');
  fs.mkdirSync(pastaChaves, { recursive: true });
  for (const [n, v] of Object.entries(CHAVES)) {
    fs.writeFileSync(path.join(pastaChaves, n), v + '\n', { mode: modoChave || 0o600 });
    fs.chmodSync(path.join(pastaChaves, n), modoChave || 0o600);
  }
  const j = {
    versao: 1, instancia: 'nova', agente: 'nova', url_publica: 'https://nova.exemplo.org', token_agente_sha256: sha(TOKEN),
    linhas_whatsapp: [
      { id: 'danilo', rotulo: 'WhatsApp do Danilo', tipo: 'organizap', base: 'https://organizap.teste/api/assistant', chave_arquivo: path.join(pastaChaves, 'organizap.key') },
      { id: 'isa', rotulo: 'WhatsApp da Isa', tipo: 'cpdf', base: 'https://cpdf.teste/api/external-agent/v1', chave_arquivo: path.join(pastaChaves, 'cpdf.key') },
    ],
    email: { tipo: 'organizap', base: 'https://organizap.teste/api/assistant', chave_arquivo: path.join(pastaChaves, 'organizap.key'), rotulo: 'E-mail' },
    imagem: { chave_arquivo: path.join(pastaChaves, 'openai.key'), rotulo: 'Geração de imagens' },
  };
  if (ajusta) ajusta(j);
  const arq = path.join(dir, 'demo.json');
  fs.writeFileSync(arq, JSON.stringify(j), { mode: modoArquivo || 0o600 });
  fs.chmodSync(arq, modoArquivo || 0o600);
  return arq;
}

function assertOk(c, m) { if (!c) throw new Error(m); }

/**
 * Sobe um Web de teste com o modo demonstração ligado (ou desligado, com `semDemo`).
 * Devolve o Web de subirWeb mais: casa (a casa do agente), fake (provedores), portao(metodo, caminho, corpo, token), decide, esperaFim.
 */
async function subirDemo(opcoes) {
  const o = opcoes || {};
  const dirCfg = pastaTemp('demo-cfg');
  const casa = path.join(dirCfg, 'casa');
  fs.mkdirSync(path.join(casa, 'arquivos'), { recursive: true });
  fs.mkdirSync(path.join(casa, 'saida'), { recursive: true });
  const cfgPath = escreveConfig(dirCfg, { ajusta: o.ajusta, modoChave: o.modoChave, modoArquivo: o.modoArquivo });
  const fake = provedoresFalsos();
  const relogio = { t: Date.parse('2026-11-09T12:00:00Z') };
  const env = Object.assign({}, o.semDemo ? {} : { DGCLAW_DEMO_CONFIG: cfgPath }, o.env || {});
  const w = await subirWeb({
    agentes: [{ slug: 'nova', nome: 'Nova', runner: 'http://127.0.0.1:1', agente_id: 'x', home_host: casa, home_container: '/home/agente' }],
    env,
    opcoesServidor: Object.assign({ demoFetch: fake.fetch, agora: () => relogio.t }, o.opcoesServidor || {}),
  });
  if (!o.semLogin) await w.login();
  async function portao(metodo, caminho, corpo, token) {
    const h = { Accept: 'application/json' };
    if (token !== null) h.Authorization = `Bearer ${token === undefined ? TOKEN : token}`;
    let body;
    if (corpo !== undefined) { body = JSON.stringify(corpo); h['Content-Type'] = 'application/json'; }
    const r = await fetch(`http://127.0.0.1:${w.porta}${caminho}`, { method: metodo, headers: h, body });
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch (_) { /* sem JSON */ }
    return { status: r.status, json, texto, headers: r.headers };
  }
  /** Decide um cartão como o dono (sessão e Origin). */
  const decide = (id, corpo) => w.c.post(`/api/demo/cartoes/${id}/decisao`, { json: corpo });
  /** Espera o cartão de envio sair de `enviando`. */
  async function esperaFim(id) {
    for (let i = 0; i < 100; i++) {
      const r = await portao('GET', `/api/demo/v1/envio/${id}`);
      if (r.json && r.json.estado !== 'enviando') return r.json;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error('o envio não saiu de "enviando"');
  }
  /** Pede o contato "maria", confirma o candidato `refCandidato` e devolve o id (que também é o ref). */
  async function liberaContato(refCandidato, linha) {
    const p = await portao('POST', '/api/demo/v1/contato', { linha: linha || 'danilo', nome: 'maria' });
    assertOk(p.status === 201, `pedido de contato: ${p.texto}`);
    const r = await decide(p.json.id, { decisao: 'confirmar', candidato: refCandidato || 'chat-maria-silva' });
    assertOk(r.status === 200, `liberação: ${r.texto}`);
    return p.json.id;
  }
  return Object.assign(w, { casa, fake, relogio, cfgPath, dirCfg, portao, decide, esperaFim, liberaContato, TOKEN });
}

module.exports = { subirDemo, escreveConfig, provedoresFalsos, TOKEN, CHAVES, sha };
