'use strict';
// Proxy /p/<slug>/* para o painel do agente em 127.0.0.1:<porta_painel>.
// Só chega aqui quem tem sessão (o server.js confere antes). Acrescenta os cabeçalhos de
// confiança X-DGClaw-Proxy (segredo) e X-DGClaw-Usuario, e apaga os que vieram do navegador.
// O segredo nunca vai para log nem para resposta.

const fs = require('node:fs');
const http = require('node:http');
const { erroJson, paginaErro, ipDoPedido, esquemaDoPedido, hostDoPedido, lerCorpo } = require('./http');
const { NOME_COOKIE } = require('./auth');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const PROIBIDOS_DO_NAVEGADOR = new Set(['x-dgclaw-proxy', 'x-dgclaw-usuario', 'x-dgclaw-papel', 'x-dgclaw-colaborador']);
const INTERVALO_REVALIDA_MS = 30 * 1000;

/** Tira o cookie de sessão do Web do que vai para o painel (ele não precisa do nosso token). */
function limpaCookie(c) {
  if (!c) return null;
  const resto = String(c).split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${NOME_COOKIE}=`) && !p.startsWith('dgclaw_papel='));
  return resto.length ? resto.join('; ') : null;
}

/** Valor de cabeçalho seguro: só ASCII imprimível; o resto vira percent-encoding. */
function valorSeguro(v) {
  const s = String(v == null ? '' : v);
  return /^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s);
}

function criarProxy({ config, registro, log, cofreRotas }) {
  const cacheSegredo = new Map(); // caminho -> { mtimeMs, valor }
  const socketsAbertos = new Set(); // conexões WebSocket, para fechar junto com o servidor
  const deColaborador = new Set(); // { colaborador_id (ausente no dono), valeAinda() (opcional), sessaoHash, socket, psocket }

  const fechaPar = (r) => { r.socket.destroy(); r.psocket.destroy(); deColaborador.delete(r); };
  /** Revogação, convite novo ou troca de senha: fecha os dois lados dos WebSockets daquele colaborador. */
  function fecharDoColaborador(id) { for (const r of [...deColaborador]) if (r.colaborador_id === id) fechaPar(r); }
  /** Fecha os WebSockets cuja sessão deixou de valer (expirou, foi apagada, o acesso mudou) ou que travou pelo cadeado (Face ID). */
  /** Fecha os WebSockets de uma sessão que foi encerrada por fora (Face ID removido, por exemplo). `hash` vem de auth.hashDaSessao. */
  function fecharDaSessao(hash) { let n = 0; for (const r of [...deColaborador]) if (hash && r.sessaoHash === hash) { fechaPar(r); n++; } return n; }
  function revalidar() {
    for (const r of [...deColaborador]) {
      if (typeof r.valeAinda !== 'function') continue;
      let vale = false;
      try { vale = !!r.valeAinda(); } catch (e) { log('erro', `Proxy: não consegui revalidar a sessão de um WebSocket (${e.message}); fechei a conexão.`); }
      if (!vale) { log('aviso', 'Proxy: fechei um WebSocket cuja sessão deixou de valer ou travou pelo cadeado (Face ID).'); fechaPar(r); }
    }
  }
  const relogio = setInterval(revalidar, INTERVALO_REVALIDA_MS);
  if (relogio.unref) relogio.unref();

  function lerSegredo(agente) {
    const arq = agente.proxy_segredo_arquivo;
    if (!arq) return { erro: `O agente ${agente.nome} não tem proxy_segredo_arquivo no registro; sem o segredo o painel não confia no Web. Rode o instalador para configurar o painel.` };
    try {
      const st = fs.statSync(arq);
      const c = cacheSegredo.get(arq);
      if (c && c.mtimeMs === st.mtimeMs) return { segredo: c.valor };
      const valor = fs.readFileSync(arq, 'utf8').trim();
      if (!valor) return { erro: `O arquivo do segredo do painel de ${agente.nome} (${arq}) está vazio.` };
      cacheSegredo.set(arq, { mtimeMs: st.mtimeMs, valor });
      return { segredo: valor };
    } catch (e) {
      return { erro: `Não consegui ler o segredo do painel de ${agente.nome} (${arq}): ${e.code || e.name}. Confira se o arquivo existe e se este serviço roda como root.` };
    }
  }

  /** Resolve o destino. Devolve { agente, segredo } ou { status, motivo }. */
  function destino(slug) {
    const est = registro.estado();
    if (!est.ok) return { status: 503, motivo: est.erro };
    const agente = est.agentes.find((a) => a.slug === slug);
    if (!agente) return { status: 404, motivo: `Não existe agente com o nome "${slug}".` };
    if (!agente.porta_painel) return { status: 404, motivo: `${agente.nome} não tem painel (porta_painel vazia no registro). A conversa fica em /a/${agente.slug}.` };
    const s = lerSegredo(agente);
    if (s.erro) { log('erro', s.erro); return { status: 500, motivo: s.erro }; }
    return { agente, segredo: s.segredo };
  }

  function cabecalhosParaPainel(req, usuario, segredo, agente, quem) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const nome = k.toLowerCase();
      if (HOP.has(nome) || PROIBIDOS_DO_NAVEGADOR.has(nome) || nome === 'cookie') continue;
      h[nome] = v;
    }
    const ck = limpaCookie(req.headers.cookie);
    if (ck) h.cookie = ck;
    h['x-forwarded-for'] = ipDoPedido(req, config.proxiesConfiaveis);
    h['x-forwarded-proto'] = esquemaDoPedido(req, config.proxiesConfiaveis);
    h['x-forwarded-host'] = hostDoPedido(req, config.proxiesConfiaveis);
    h['x-dgclaw-proxy'] = segredo;
    h['x-dgclaw-usuario'] = valorSeguro(usuario);
    // Quem é, para o painel decidir no futuro. O navegador nunca consegue mandar estes: são apagados acima.
    h['x-dgclaw-papel'] = quem && quem.colaborador_id ? 'colaborador' : 'dono';
    if (quem && quem.colaborador_id) h['x-dgclaw-colaborador'] = valorSeguro(quem.colaborador_id);
    return h;
  }

  /**
   * Agente da v1 (com cofre_arquivo): as rotas do cofre e a troca de modelo com chave são
   * respondidas pelo Web (./cofre-rotas) e nunca chegam ao painel. Se o Web leu o corpo para
   * decidir e a rota é do painel, o corpo lido segue como Buffer.
   */
  function responder(req, res, slug, usuario, quem) {
    const agente = cofreRotas ? registro.obter(slug) : null;
    if (agente && !agente.cofre_arquivo && cofreRotas.casaLegado(req, slug)) {
      legadoComAviso(req, res, slug, usuario, agente, quem);
      return undefined;
    }
    const qual = agente && agente.cofre_arquivo ? cofreRotas.casa(req, slug) : null;
    if (!qual) {
      const escrita = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (!(quem && (quem.colaborador_id || quem.lerCorpoAntes) && escrita)) return encaminhar(req, res, slug, usuario, null, undefined, quem);
      // Colaborador (e dono com Face ID ligado): o painel age quando o corpo termina. Lê tudo aqui, confere a sessão e o cadeado
      // (req.dgRevalidar, em lerCorpo) e só então abre a conexão com o painel.
      const limite = config.maxUploadBytes + 64 * 1024;
      lerCorpo(req, limite).then((buf) => {
        encaminhar(req, res, slug, usuario, buf.length ? buf : null, undefined, quem, true);
      }).catch((e) => {
        if (e && e.status === 413) return erroJson(res, 413, `O envio passou do limite de ${Math.round(config.maxUploadBytes / 1048576)} MB. Mande um arquivo menor.`);
        if (e && e.status === 401 && quem && quem.colaborador_id) return recusaSessaoVelha(res, slug, quem);
        if (e && e.status === 423) return erroJson(res, 423, e.message);
        log('erro', `Proxy /p/${slug}: não consegui ler o corpo do pedido (${(e && (e.code || e.message)) || 'erro'}).`);
        return erroJson(res, 400, 'Não consegui ler o corpo do pedido. Tente de novo.');
      });
      return undefined;
    }
    cofreRotas.tratar(req, res, agente, usuario, qual).then((repasse) => {
      if (repasse && repasse.corpo) encaminhar(req, res, slug, usuario, repasse.corpo, undefined, quem);
    }).catch((e) => {
      log('erro', `Proxy /p/${slug}: o tratamento do cofre quebrou (${e && e.message}).`);
      if (!res.headersSent) erroJson(res, 500, 'Não consegui atender o pedido do cofre. Veja o registro do DG Claw Web.');
      else res.destroy();
    });
    return undefined;
  }

  /**
   * Agente legado guardando chave: o painel dele grava e ignora `avisar`. Lê o corpo (até 64 KB), repassa
   * igual ao painel e, com a resposta dele em mãos, deixa o cofre-rotas montar o aviso. O corpo nunca vai a log.
   */
  function legadoComAviso(req, res, slug, usuario, agente, quem) {
    lerCorpo(req, 64 * 1024).then((buf) => {
      encaminhar(req, res, slug, usuario, buf, (status, resposta) => cofreRotas.avisarLegado(agente, buf, status, resposta), quem);
    }).catch((e) => {
      if (e && e.status === 413) return erroJson(res, 413, 'O pedido passou de 64 KB, que é muito mais do que uma chave precisa. Mande só o nome e o valor da chave.');
      log('erro', `Proxy /p/${slug}: não consegui ler o corpo do pedido do cofre (${(e && (e.code || e.message)) || 'erro'}).`);
      return erroJson(res, 400, 'Não consegui ler o corpo do pedido. Tente de novo.');
    });
  }

  function recusaSessaoVelha(res, slug, quem) {
    log('aviso', `Proxy /p/${slug}: pedido do colaborador ${quem.colaborador_id} recusado, a sessão deixou de valer enquanto o corpo chegava. Nada foi ao painel.`);
    return erroJson(res, 401, 'Seu acesso mudou enquanto o envio estava em andamento (foi revogado ou o convite foi reenviado). Nada foi feito. Entre de novo com o convite mais recente.');
  }

  function encaminhar(req, res, slug, usuario, corpoLido, aoTerminar, quem, corpoJaConferido) {
    // Corpo lido por outro caminho (cofre, legado): a sessão é conferida de novo antes de abrir a conexão.
    if (!corpoJaConferido && corpoLido && quem && quem.colaborador_id && typeof quem.valeAinda === 'function' && !quem.valeAinda()) return recusaSessaoVelha(res, slug, quem);
    const d = destino(slug);
    if (d.status) {
      if (/\btext\/html\b/.test(String(req.headers.accept || ''))) paginaErro(res, d.status, 'Painel indisponível', d.motivo);
      else erroJson(res, d.status, d.motivo);
      return;
    }
    const { agente, segredo } = d;
    const opcoes = {
      host: '127.0.0.1', port: agente.porta_painel, method: req.method, path: req.url,
      headers: cabecalhosParaPainel(req, usuario, segredo, agente, quem),
    };
    if (corpoLido) opcoes.headers['content-length'] = String(corpoLido.length);
    const preq = http.request(opcoes, (pres) => {
      const h = {};
      // Set-Cookie do painel do agente nunca chega ao navegador: o painel pode estar comprometido
      // e plantaria cookie no domínio do Web. O painel não depende de cookie atrás do proxy
      // (confia no X-DGClaw-Proxy).
      for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie') h[k] = v;
      res.writeHead(pres.statusCode, pres.statusMessage, h);
      pres.pipe(res);
      pres.on('error', () => res.destroy());
      if (aoTerminar) {
        const pedacos = []; let tam = 0;
        pres.on('data', (c) => { if (tam < 64 * 1024) { pedacos.push(c); tam += c.length; } });
        pres.on('end', () => {
          try { aoTerminar(pres.statusCode, Buffer.concat(pedacos)); } catch (e) { log('erro', `Proxy /p/${slug}: o aviso da chave quebrou (${e && e.message}).`); }
        });
      }
    });
    preq.on('error', (e) => {
      const motivo = `O painel de ${agente.nome} (porta ${agente.porta_painel}) não está respondendo (${e.code || e.message}). Confira se o serviço do painel está ligado.`;
      log('erro', `Proxy /p/${slug}: ${motivo}`);
      if (res.headersSent) { res.destroy(); return; }
      if (/\btext\/html\b/.test(String(req.headers.accept || ''))) paginaErro(res, 502, 'Painel fora do ar', motivo);
      else erroJson(res, 502, motivo);
    });
    res.on('close', () => { if (!res.writableEnded) preq.destroy(); });
    if (corpoLido) preq.end(corpoLido);
    else if (req.readableEnded || req.complete && !req.readable) preq.end();
    else req.pipe(preq);
  }

  /** WebSocket/Upgrade: abre a mesma conexão no painel e liga os dois lados. */
  function upgrade(req, socket, head, slug, usuario, quem) {
    const d = destino(slug);
    if (d.status) {
      socket.write(`HTTP/1.1 ${d.status} Erro\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${d.motivo}`);
      socket.destroy();
      return;
    }
    const { agente, segredo } = d;
    const h = cabecalhosParaPainel(req, usuario, segredo, agente, quem);
    h.connection = 'Upgrade';
    h.upgrade = req.headers.upgrade;
    const preq = http.request({ host: '127.0.0.1', port: agente.porta_painel, method: req.method, path: req.url, headers: h });
    preq.on('upgrade', (pres, psocket, phead) => {
      let cab = `HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\n`;
      // Set-Cookie do painel não passa para o navegador (mesma regra do HTTP comum).
      for (let i = 0; i < pres.rawHeaders.length; i += 2) {
        if (pres.rawHeaders[i].toLowerCase() === 'set-cookie') continue;
        cab += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
      }
      socket.write(`${cab}\r\n`);
      if (phead && phead.length) socket.write(phead);
      if (head && head.length) psocket.write(head);
      socketsAbertos.add(socket); socketsAbertos.add(psocket);
      // WebSocket com conferência (colaborador, ou dono com cadeado ligado): guardado para fechar quando a sessão deixar de valer ou travar.
      if (quem && (typeof quem.valeAinda === 'function' || quem.sessaoHash)) {
        const reg = { colaborador_id: quem.colaborador_id, valeAinda: quem.valeAinda, sessaoHash: quem.sessaoHash, socket, psocket };
        deColaborador.add(reg);
        socket.on('close', () => deColaborador.delete(reg));
      }
      socket.on('close', () => socketsAbertos.delete(socket));
      psocket.on('close', () => socketsAbertos.delete(psocket));
      psocket.pipe(socket); socket.pipe(psocket);
      psocket.on('error', () => socket.destroy());
      socket.on('error', () => psocket.destroy());
      socket.on('close', () => psocket.destroy());
      psocket.on('close', () => socket.destroy());
    });
    preq.on('response', (pres) => {
      // o painel respondeu sem aceitar o upgrade: repassa o status e fecha
      socket.write(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\nConnection: close\r\n\r\n`);
      pres.resume();
      socket.destroy();
    });
    preq.on('error', (e) => {
      log('erro', `Proxy /p/${slug} (WebSocket): o painel de ${agente.nome} não respondeu (${e.code || e.message}).`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    preq.end();
  }

  return { responder, upgrade, destino, fecharDoColaborador, fecharDaSessao, revalidar, fecharTudo() { clearInterval(relogio); for (const x of socketsAbertos) x.destroy(); socketsAbertos.clear(); deColaborador.clear(); } };
}

module.exports = { criarProxy, limpaCookie };
