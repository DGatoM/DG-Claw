'use strict';
// Provedores reais do modo demonstração (docs/MODO-DEMONSTRACAO.md): Organizap (WhatsApp e e-mail) e CPDF (WhatsApp).
// Só o servidor chama estas funções, depois de um clique humano; o agente nunca vê endereço nem chave.
// A chave é lida na hora (chaveDe) e nunca entra em log, em mensagem de erro nem em resposta.

const crypto = require('node:crypto');

class ErroDemo extends Error {
  constructor(status, codigo, mensagem, extra, detalhe) {
    super(mensagem);
    this.detalhe = detalhe || null; // resposta bruta (já sanitizada) do provedor: só log e tela do dono, nunca o agente
    this.name = 'ErroDemo';
    this.status = status;
    this.codigo = codigo;
    this.extra = extra || null;
  }
}

const ehTexto = (v) => typeof v === 'string';
const soDigitos = (s) => String(s || '').replace(/\D+/g, '');

/** Telefone do `remoteJid` do WhatsApp ("5511999990000@s.whatsapp.net"). LID e grupo não têm número. */
function telefoneDoJid(jid) {
  if (!ehTexto(jid)) return { telefone: null, semNumero: true };
  const [esq, dir] = jid.split('@');
  if (/lid/i.test(dir || '')) return { telefone: null, semNumero: true };
  const d = soDigitos(esq);
  return d.length >= 10 && d.length <= 15 ? { telefone: d, semNumero: false } : { telefone: null, semNumero: true };
}

/** Uma chave de idempotência derivada (UUID v4 formatado) para os anexos: a do texto é o próprio id do cartão. */
function idDerivado(id, sufixo) {
  const h = crypto.createHash('sha256').update(`${id}:${sufixo}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Tira de um texto qualquer a chave e tudo o que parece credencial (Bearer, sk-..., sequências longas de token). */
function sanitiza(texto, chave) {
  let t = String(texto == null ? '' : texto);
  if (chave) t = t.split(chave).join('[chave]');
  return t
    .replace(/Bearer\s+\S+/gi, 'Bearer [chave]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[chave]')
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '[token]');
}

function htmlDoTexto(texto) {
  const esc = String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return esc.replace(/\r?\n/g, '<br>');
}

function criarProvedores({ fetchImpl, chaveDe, log, timeoutMs }) {
  const f = fetchImpl || fetch;
  const prazo = timeoutMs || 20000;

  /** Uma chamada HTTP. Erro de rede, prazo ou resposta que não é JSON viram ErroDemo com a causa; a chave nunca aparece. */
  async function chamar(cfg, metodo, caminho, { params, corpo, cabecalhos } = {}) {
    const rotulo = cfg.rotulo || cfg.id || 'o provedor';
    let chave;
    try { chave = chaveDe(cfg.chave_arquivo); } catch (e) {
      throw new ErroDemo(500, 'CHAVE_ILEGIVEL', `Não consegui ler a chave de ${rotulo} (${e.message}). Nada foi enviado. Peça ao dono para conferir o arquivo da chave.`);
    }
    const url = new URL(cfg.base.replace(/\/+$/, '') + caminho);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const cab = Object.assign({ Authorization: `Bearer ${chave}`, Accept: 'application/json' }, cabecalhos || {});
    let corpoTexto;
    if (corpo !== undefined) { corpoTexto = JSON.stringify(corpo); cab['Content-Type'] = 'application/json'; }
    let r;
    try {
      r = await f(url.toString(), { method: metodo, headers: cab, body: corpoTexto, signal: AbortSignal.timeout(prazo), redirect: 'error' });
    } catch (e) {
      const causa = e && e.name === 'TimeoutError' ? `não respondeu em ${Math.round(prazo / 1000)} segundos` : sanitiza(String((e && (e.cause && e.cause.code || e.message)) || e), chave).slice(0, 120);
      throw new ErroDemo(502, 'PROVEDOR_FORA', `Não consegui falar com ${rotulo} (${causa}). Confira a conexão e tente de novo.`, { incerto: metodo !== 'GET' });
    }
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch (_) { /* resposta sem JSON: tratada abaixo */ }
    const bruto = (json && (json.error || json.message || json.details)) || texto || `HTTP ${r.status}`;
    const detalhe = sanitiza(typeof bruto === 'string' ? bruto : JSON.stringify(bruto), chave).slice(0, 200);
    return { status: r.status, json, texto: sanitiza(texto, chave).slice(0, 300), detalhe };
  }

  function exigeOk(r, cfg, o) {
    if (r.status >= 200 && r.status < 300) return;
    const rotulo = cfg.rotulo || cfg.id || 'o provedor';
    const codigoProv = r.json && r.json.code;
    if (r.status === 401) throw new ErroDemo(502, 'CHAVE_RECUSADA', `${rotulo} recusou a chave (401). Peça ao dono para conferir a chave desta linha. ${o}`);
    if (r.status === 403 && codigoProv === 'INSTANCE_SEND_FORBIDDEN') throw new ErroDemo(502, 'LINHA_SEM_PERMISSAO_DE_ENVIO', `${rotulo} não deixa esta chave enviar por essa linha. ${o}`);
    if (r.status === 422 && codigoProv === 'RECIPIENT_IS_LID') throw new ErroDemo(422, 'DESTINO_SEM_NUMERO', 'Esta conversa ainda não tem o número do contato, só um identificador interno do WhatsApp, e a mensagem não chegaria. Espere o contato responder ou envie pelo celular. Nada foi enviado.');
    if (r.status === 409) throw new ErroDemo(409, 'IDEMPOTENCIA_CONFLITO', `${rotulo} diz que esse envio já existia com outro conteúdo. Não repita: confira no ${rotulo} se a mensagem saiu.`);
    // O agente recebe só o código e o status. A mensagem do provedor (sanitizada) vai para o log e para a tela do dono.
    try { log('erro', `Modo demonstração: ${rotulo} respondeu HTTP ${r.status}: ${r.detalhe}`); } catch (_) { /* log nunca derruba o pedido */ }
    throw new ErroDemo(r.status >= 500 ? 502 : 422, 'PROVEDOR_RECUSOU', `${rotulo} recusou o pedido (HTTP ${r.status}). ${o}`.trim(), null, r.detalhe);
  }

  // ── Organizap ────────────────────────────────────────────────────────────
  const org = {
    async buscarContatos(cfg, nome) {
      const r = await chamar(cfg, 'GET', '/chats', { params: { search: nome, privateOnly: 'true', includeArchived: 'true', limit: 8 } });
      exigeOk(r, cfg, 'Nada foi aberto.');
      const lista = Array.isArray(r.json && r.json.data) ? r.json.data : [];
      return lista.filter((c) => c && c.id && !c.isGroup).slice(0, 5).map((c) => {
        const { telefone, semNumero } = telefoneDoJid(c.remoteJid);
        return { ref: String(c.id), nome: String(c.name || (c.contact && c.contact.name) || (c.customer && c.customer.name) || 'Sem nome'), telefone, semNumero };
      });
    },

    async resolverPorTelefone(cfg, telefone) {
      const r = await chamar(cfg, 'GET', '/chats', { params: { search: telefone, privateOnly: 'true', includeArchived: 'true', limit: 10 } });
      exigeOk(r, cfg, 'Nada foi aberto.');
      const lista = Array.isArray(r.json && r.json.data) ? r.json.data : [];
      for (const c of lista) {
        if (!c || !c.id || c.isGroup) continue;
        const t = telefoneDoJid(c.remoteJid);
        if (t.telefone === telefone) return { ref: String(c.id), nome: String(c.name || (c.contact && c.contact.name) || 'Sem nome'), telefone, semNumero: false };
      }
      return null;
    },

    /**
     * As mensagens MAIS RECENTES. O `limit` do transcript traz o COMEÇO da conversa, então a leitura usa `since`
     * e procura, por bisseção, a janela que traz pelo menos `limite` mensagens sem estourar o teto de 500.
     */
    async lerConversa(cfg, { ref }, limite) {
      const TETO = 500;
      const dia = 86400000;
      const busca = async (dias) => {
        const since = new Date(Date.now() - dias * dia).toISOString();
        const r = await chamar(cfg, 'GET', `/chats/${encodeURIComponent(ref)}/transcript`, { params: { format: 'json', limit: TETO, since } });
        if (r.status === 404) throw new ErroDemo(404, 'CONVERSA_NAO_ENCONTRADA', 'Esta conversa não existe mais ou não é visível para a chave da linha.');
        exigeOk(r, cfg, 'Nada foi lido.');
        const m = r.json && r.json.data && r.json.data.messages;
        return Array.isArray(m) ? m : [];
      };
      const janelas = [1, 7, 30, 180, 3650];
      let boa = null; // última janela que não estourou o teto
      let anterior = 0;
      for (const d of janelas) {
        const m = await busca(d);
        if (m.length < TETO) { boa = m; if (m.length >= limite) break; anterior = d; continue; }
        // Estourou: a janela certa está entre `anterior` e `d`.
        let lo = anterior; let hi = d;
        for (let i = 0; i < 5; i++) {
          const meio = Math.max(1, Math.round((lo + hi) / 2));
          const mm = await busca(meio);
          if (mm.length >= TETO) hi = meio; else { boa = mm; lo = meio; if (mm.length >= limite) break; }
        }
        break;
      }
      if (!boa) throw new ErroDemo(502, 'CONVERSA_MUITO_MOVIMENTADA', 'Esta conversa tem mais de 500 mensagens no último dia e não consegui separar as mais recentes. Nada foi lido.');
      const msgs = boa.slice(-limite);
      return msgs.map((m) => ({
        quando: m.timestamp ? new Date(m.timestamp).toISOString() : null,
        de: m.fromMe ? 'nos' : 'contato',
        texto: String(m.body && !/^\[[^\]]*\]$/.test(String(m.body).trim()) ? m.body
          : m.audioTranscript ? `[áudio transcrito]: ${m.audioTranscript}`
          : m.mediaAltText ? `[${m.type || 'mídia'}: ${m.mediaAltText}]` : `[${m.type || 'mensagem sem texto'}]`).slice(0, 2000),
      }));
    },

    async enviarWhatsapp(cfg, { ref, texto, anexos, id }) {
      const status = [];
      const r = await chamar(cfg, 'POST', '/messages/send', { corpo: { chatId: ref, type: 'text', content: texto }, cabecalhos: { 'Idempotency-Key': id } });
      exigeOk(r, cfg, 'Confira no WhatsApp se a mensagem saiu antes de tentar de novo.');
      status.push(r.status === 202 ? 'na_fila' : 'enviado');
      for (let i = 0; i < anexos.length; i++) {
        const a = anexos[i];
        const tipo = /^image\//.test(a.mime) ? 'image' : /^video\//.test(a.mime) ? 'video' : 'document';
        const corpo = { chatId: ref, type: tipo, content: `data:${a.mime};base64,${a.dados.toString('base64')}` };
        if (tipo === 'document') corpo.fileName = a.nome;
        let ra;
        try {
          ra = await chamar(cfg, 'POST', '/messages/send', { corpo, cabecalhos: { 'Idempotency-Key': idDerivado(id, `a${i}`) } });
          exigeOk(ra, cfg, '');
        } catch (e) {
          throw new ErroDemo(e.status || 502, 'ENVIO_PARCIAL', `O texto foi enviado, mas o anexo ${i + 1} (${a.nome}) não: ${e.message} Não reenvie o texto; mande só o anexo que faltou.`, null, e.detalhe);
        }
        status.push(ra.status === 202 ? 'na_fila' : 'enviado');
      }
      return { confirmacao: status.includes('na_fila') ? 'na_fila' : 'confirmada' };
    },

    async enviarEmail(cfg, { para, assunto, texto, anexos, id }) {
      const corpo = { to: para, subject: assunto, body: htmlDoTexto(texto) };
      if (anexos.length) corpo.attachments = anexos.map((a) => ({ fileName: a.nome, mimeType: a.mime, content: a.dados.toString('base64') }));
      const r = await chamar(cfg, 'POST', '/gmail/send', { corpo, cabecalhos: { 'Idempotency-Key': id } });
      exigeOk(r, cfg, 'Confira na caixa de enviados antes de tentar de novo.');
      return { confirmacao: r.status === 202 ? 'na_fila' : 'confirmada' };
    },
  };

  // ── CPDF (WhatsApp por contato ou telefone; mídia só por URL pública, então sem anexo) ──
  async function instanciaCpdf(cfg) {
    if (cfg.instancia_id) return cfg.instancia_id;
    const r = await chamar(cfg, 'GET', '/whatsapp/instances');
    exigeOk(r, cfg, 'Nada foi enviado.');
    const itens = Array.isArray(r.json && r.json.items) ? r.json.items : [];
    if (itens.length !== 1) throw new ErroDemo(500, 'INSTANCIA_AMBIGUA', `${cfg.rotulo || 'A linha CPDF'} tem ${itens.length} instâncias de WhatsApp e o demo.json não diz qual usar. Peça ao dono para acrescentar "instancia_id" nesta linha. Nada foi enviado.`);
    return String(itens[0].id);
  }

  const cpdf = {
    async buscarContatos(cfg, nome) {
      const r = await chamar(cfg, 'GET', '/contacts', { params: { name: nome, limit: 5 } });
      exigeOk(r, cfg, 'Nada foi aberto.');
      const itens = Array.isArray(r.json && r.json.items) ? r.json.items : [];
      return itens.filter((c) => c && c.id).slice(0, 5).map((c) => {
        const t = soDigitos(c.phone);
        return { ref: String(c.id), nome: String(c.displayName || 'Sem nome'), telefone: t.length >= 10 ? t : null, semNumero: t.length < 10 };
      });
    },

    async resolverPorTelefone(cfg, telefone) {
      const r = await chamar(cfg, 'GET', '/contacts', { params: { phone: telefone, limit: 5 } });
      exigeOk(r, cfg, 'Nada foi aberto.');
      const itens = Array.isArray(r.json && r.json.items) ? r.json.items : [];
      const c = itens.find((x) => x && soDigitos(x.phone) === telefone);
      return { ref: c ? String(c.id) : null, nome: c ? String(c.displayName || '') || null : null, telefone, semNumero: false };
    },

    async lerConversa(cfg, { telefone }, limite) {
      if (!telefone) throw new ErroDemo(422, 'CONVERSA_SEM_NUMERO', 'Este contato não tem número cadastrado, então não consigo achar a conversa dele.');
      const rc = await chamar(cfg, 'GET', '/conversations', { params: { phone: telefone, limit: 1 } });
      exigeOk(rc, cfg, 'Nada foi lido.');
      const conv = rc.json && Array.isArray(rc.json.items) ? rc.json.items[0] : null;
      if (!conv) return [];
      const base = `/conversations/${encodeURIComponent(conv.id)}/messages`;
      const r0 = await chamar(cfg, 'GET', base, { params: { limit: 1 } });
      exigeOk(r0, cfg, 'Nada foi lido.');
      const total = Number(r0.json && r0.json.total) || 0;
      const r = await chamar(cfg, 'GET', base, { params: { limit: limite, offset: Math.max(0, total - limite) } });
      exigeOk(r, cfg, 'Nada foi lido.');
      const itens = Array.isArray(r.json && r.json.items) ? r.json.items : [];
      return itens.map((m) => ({
        quando: m.createdAt ? new Date(m.createdAt).toISOString() : null,
        de: m.direction === 'OUTBOUND' ? 'nos' : 'contato',
        texto: String(m.content || `[${m.mediaType || 'mensagem sem texto'}]`).slice(0, 2000),
      }));
    },

    async enviarWhatsapp(cfg, { ref, telefone, texto, anexos }) {
      if (anexos.length) throw new ErroDemo(422, 'ANEXO_NAO_SUPORTADO_NA_LINHA', 'Esta linha do CPDF só envia mídia por endereço público, e o Portão não publica arquivos. Mande só o texto ou use uma linha do Organizap.');
      const instanceId = await instanciaCpdf(cfg);
      const corpo = { instanceId, message: texto };
      if (ref) corpo.contactId = ref; else corpo.phone = telefone;
      const r = await chamar(cfg, 'POST', '/whatsapp/send', { corpo });
      exigeOk(r, cfg, 'O CPDF tenta duas vezes por conta própria: confira no WhatsApp se a mensagem saiu antes de tentar de novo.');
      return { confirmacao: 'confirmada' };
    },
  };

  const porTipo = { organizap: org, cpdf };
  const de = (cfg) => {
    const p = porTipo[cfg.tipo];
    if (!p) throw new ErroDemo(500, 'TIPO_DE_LINHA_DESCONHECIDO', `A linha "${cfg.id}" tem tipo "${cfg.tipo}", que o modo demonstração não conhece (use organizap ou cpdf).`);
    return p;
  };

  return {
    buscarContatos: (cfg, nome) => de(cfg).buscarContatos(cfg, nome),
    resolverPorTelefone: (cfg, tel) => de(cfg).resolverPorTelefone(cfg, tel),
    lerConversa: (cfg, alvo, limite) => de(cfg).lerConversa(cfg, alvo, limite),
    enviarWhatsapp: (cfg, o) => de(cfg).enviarWhatsapp(cfg, o),
    enviarEmail: (cfg, o) => {
      if (cfg.tipo !== 'organizap') throw new ErroDemo(500, 'EMAIL_TIPO_INVALIDO', 'O e-mail do modo demonstração só funciona pelo Organizap.');
      return org.enviarEmail(cfg, o);
    },
    log,
  };
}

module.exports = { criarProvedores, ErroDemo, sanitiza, telefoneDoJid, soDigitos, htmlDoTexto, idDerivado };
