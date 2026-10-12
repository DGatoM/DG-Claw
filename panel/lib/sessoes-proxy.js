'use strict';
/**
 * sessoes-proxy.js: a aba Sessões do painel (12/10/2026).
 *
 * O painel SÓ APRESENTA. Estado, dono, filtro e fonte dos cards continuam no DG
 * Telegram (`/api/v1/sessoes*`), e esta rota é um proxy fino que põe a chave da
 * agente do lado do servidor, para que ela nunca desça ao navegador. Nenhuma regra
 * do mini-Bunker é duplicada aqui. Ver docs/SESSOES.md.
 *
 *   GET  /api/sessoes-config   { ligado, motivo?, agente, appUrl }  (nunca a chave nem a URL interna)
 *   ALL  /api/sessoes[/...]    vai para ${URL}/api/v1/sessoes[/...], com a query intacta
 *
 * O QUE O PROXY NÃO REPASSA, de propósito:
 *   - o cookie e o Authorization do navegador (a origem recebe só a chave da agente);
 *   - Host e cabeçalhos do Cloudflare;
 *   - o Set-Cookie da origem.
 *
 * O QUE O PROXY RECUSA SOZINHO (403, sem chegar à origem): decidir pedido, mandar tecla
 * ao terminal, cofre e a barra de pedidos. A API já recusa chave de API nesses pontos,
 * mas a recusa aqui deixa o motivo claro, com o link de onde isso se faz.
 *
 * O corpo vai em STREAM nos dois sentidos (anexo é multipart de até 100 MB). Por isso o
 * server.js tira /api/sessoes dos parsers de corpo globais.
 *
 * Modo só leitura (DGCLAW_PANEL_SESSOES_SO_LEITURA=1 ou sessoes.soLeitura no config.json): toda
 * escrita dá 403 aqui, sem chegar à origem.
 *
 * Configuração: DGCLAW_PANEL_SESSOES_URL, _KEY (ou _KEY_FILE), _AGENTE e _APP_URL, com
 * `sessoes: {url, keyFile, agente, appUrl}` no config.json como alternativa. A CHAVE só
 * vem de env ou de arquivo: o config.json é lido por muita coisa e não é lugar de segredo.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

// Sem endereço do app configurado não há link para oferecer: abrir_em vai null e a tela
// esconde o botão, em vez de mandar a pessoa para um domínio que não é o dela.
const APP_URL_PADRAO = '';
const PREFIXO = '/api/sessoes';
const PREFIXO_ORIGEM = '/api/v1/sessoes';

const TIMEOUT_GET_MS = 20000;
const TIMEOUT_ESCRITA_MS = 75000;
const TIMEOUT_ANEXO_MS = 120000;
const CACHE_CHAVE_MS = 5000;
// Anexo maior que isto nem sai do painel: a origem corta em 100 MB (o Cloudflare também).
const TETO_CORPO_BYTES = 110 * 1024 * 1024;
const TETO_ERRO_BYTES = 1024 * 1024;

const FRASE_BLOQUEIO = 'Isso só se faz no DG Telegram, com o login do Danilo: um card não pode aprovar o próprio pedido. '
  + 'Use o botão Decidir no DG Telegram.';
const FRASE_COFRE = 'O cofre do Bunker está trancado. Destrave pelo DG Telegram, com a senha mestra, e volte aqui.';

function registrar(router, { CONFIG }) {
  const cfgArquivo = (CONFIG && CONFIG.sessoes) || {};
  let cacheChave = null; // { em, valor, erro }

  function lerChave() {
    const direta = (process.env.DGCLAW_PANEL_SESSOES_KEY || '').trim();
    if (direta) return { valor: direta };
    const arquivo = (process.env.DGCLAW_PANEL_SESSOES_KEY_FILE || cfgArquivo.keyFile || '').trim();
    if (!arquivo) return { valor: '' };
    const agora = Date.now();
    if (cacheChave && agora - cacheChave.em < CACHE_CHAVE_MS && cacheChave.arquivo === arquivo) return cacheChave.res;
    let res;
    try {
      res = { valor: fs.readFileSync(arquivo, 'utf-8').trim() };
    } catch (e) {
      res = { valor: '', erro: `não consegui ler o arquivo da chave (${e.code || e.message})` };
      console.error(`sessoes: não consegui ler o arquivo da chave configurado em DGCLAW_PANEL_SESSOES_KEY_FILE: ${e.code || e.message}`);
    }
    cacheChave = { em: agora, arquivo, res };
    return res;
  }

  // Env ganha do config.json. Painel sem Cloudflare Access na frente (o da Isa) fica só leitura.
  function ehSoLeitura() {
    const env = (process.env.DGCLAW_PANEL_SESSOES_SO_LEITURA || '').trim().toLowerCase();
    if (env) return ['1', 'true', 'sim', 'yes'].includes(env);
    return cfgArquivo.soLeitura === true;
  }

  // Lido a cada pedido: trocar a env ou o arquivo da chave não exige reiniciar o painel.
  function configuracao() {
    const urlTexto = (process.env.DGCLAW_PANEL_SESSOES_URL || cfgArquivo.url || '').trim();
    const agente = (process.env.DGCLAW_PANEL_SESSOES_AGENTE || cfgArquivo.agente || CONFIG.agentSlug || '').trim();
    const appUrl = ((process.env.DGCLAW_PANEL_SESSOES_APP_URL || cfgArquivo.appUrl || APP_URL_PADRAO).trim()).replace(/\/+$/, '');
    const falta = [];
    let url = null;
    if (!urlTexto) {
      falta.push('DGCLAW_PANEL_SESSOES_URL');
    } else {
      try {
        const u = new URL(urlTexto);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
        url = u;
      } catch {
        return { ligado: false, agente, appUrl, motivo: 'O endereço configurado em DGCLAW_PANEL_SESSOES_URL não é um endereço http ou https válido.' };
      }
    }
    const chave = lerChave();
    if (!chave.valor) falta.push(chave.erro ? `a chave (${chave.erro})` : 'a chave (DGCLAW_PANEL_SESSOES_KEY ou DGCLAW_PANEL_SESSOES_KEY_FILE)');
    if (falta.length) {
      return {
        ligado: false, agente, appUrl,
        motivo: `A aba Sessões não está ligada nesta instalação: falta ${falta.join(' e ')}. `
          + 'Ela só existe onde o DG Telegram roda junto.',
      };
    }
    return { ligado: true, agente, appUrl, url, chave: chave.valor, soLeitura: ehSoLeitura() };
  }

  router.get('/api/sessoes-config', (req, res) => {
    const c = configuracao();
    res.setHeader('Cache-Control', 'no-store');
    const corpo = { ligado: c.ligado, agente: c.agente, appUrl: c.appUrl, soLeitura: ehSoLeitura() };
    if (!c.ligado) corpo.motivo = c.motivo;
    res.json(corpo);
  });

  function limparChave(texto, chave) {
    return chave ? String(texto).split(chave).join('***') : String(texto);
  }

  function linkDecidir(c, qual, id) {
    if (!c.appUrl) return null;
    const base = `${c.appUrl}/a/${encodeURIComponent(c.agente)}`;
    if (qual === 'cofre') return `${base}?sessoes=1`;
    return id ? `${base}?sessoes=pedidos&card=${encodeURIComponent(id)}` : `${base}?sessoes=pedidos`;
  }

  /** Separa o caminho em partes decodificadas e minúsculas. null quando o caminho é suspeito. */
  function partesDoCaminho(resto) {
    const cruas = resto.split('/').slice(1); // o primeiro item é o vazio antes da primeira barra
    if (cruas.length && cruas[cruas.length - 1] === '') cruas.pop();
    const partes = [];
    for (const p of cruas) {
      let d;
      try { d = decodeURIComponent(p); } catch { return null; }
      if (!d || d === '.' || d === '..' || /[\\/\u0000]/.test(d)) return null;
      partes.push(d);
    }
    return partes;
  }

  function qualBloqueio(partes) {
    const a = (partes[0] || '').toLowerCase();
    if (a.startsWith('cofre')) return 'cofre';
    if (a.startsWith('pedidos')) return 'pedidos';
    const acao = (partes[1] || '').toLowerCase();
    if (acao === 'decidir' || acao === 'tecla') return acao;
    return null;
  }

  function nomeDeLog(metodo, partes, query) {
    let alvo = '/' + partes.join('/');
    if (partes[1] === 'documentos' && partes[2] === 'conteudo') {
      const m = /(?:^|&)caminho=([^&]*)/.exec(query || '');
      let arq = '';
      if (m) {
        try { arq = decodeURIComponent(m[1].replace(/\+/g, ' ')).split('/').pop(); } catch { arq = ''; }
      }
      alvo += arq ? ` (arquivo: ${arq})` : '';
    }
    return `sessoes: ${metodo} ${alvo === '/' ? '' : alvo}`.trimEnd();
  }

  function falhar(res, status, corpo) {
    if (res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.status(status).json(Object.assign({ ok: false }, corpo));
  }

  /**
   * Trava contra pedido forjado por outro site (CSRF). O cookie de login do painel não tem
   * SameSite, então Safari e Firefox o mandam em um form POST vindo de qualquer página. Aqui
   * um POST criaria um card com permissão automática: execução de código na máquina. Por isso
   * toda mutação precisa vir da própria tela: Origin (ou, na falta, o Referer) com o mesmo
   * host do pedido.
   */
  function veioDaTela(req) {
    let origem = req.headers.origin;
    if (!origem && req.headers.referer) {
      try { origem = new URL(req.headers.referer).origin; } catch { origem = ''; }
    }
    if (!origem || origem === 'null') return { ok: false, visto: origem || '(ausente)' };
    let hostOrigem;
    try { hostOrigem = new URL(origem).host.toLowerCase(); } catch { return { ok: false, visto: '(ilegível)' }; }
    const hostPedido = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    return { ok: !!hostPedido && hostOrigem === hostPedido, visto: hostOrigem };
  }

  function tratar(req, res) {
    const c = configuracao();
    if (!c.ligado) { falhar(res, 501, { erro: c.motivo }); return; }

    const original = req.url || '';
    const corte = original.indexOf('?');
    const caminhoBruto = corte === -1 ? original : original.slice(0, corte);
    const query = corte === -1 ? '' : original.slice(corte);
    const resto = caminhoBruto.slice(PREFIXO.length); // '' ou '/...'
    const partes = partesDoCaminho(resto);
    if (!partes) {
      falhar(res, 400, { erro: 'O endereço pedido tem uma parte inválida (vazia, "." ou ".." ou com barra escondida), então não foi enviado ao DG Telegram.' });
      return;
    }

    const metodo = req.method;
    const escrita = metodo !== 'GET' && metodo !== 'HEAD' && metodo !== 'OPTIONS';
    if (escrita && c.soLeitura) {
      const reservado = /^(cofre|pedidos|donos)/i.test(partes[0] || '');
      const id = partes.length >= 2 && !reservado ? partes[0] : null;
      console.log(`sessoes: ${metodo} /${partes.join('/')} recusado: painel em modo só leitura`);
      falhar(res, 403, {
        erro: 'Neste painel a aba Sessões é só para ler: as ações (recado, criar, arquivar, renomear...) ficam no DG Telegram, porque este painel não tem a proteção de login do Cloudflare na frente.',
        abrir_em: id ? linkDecidir(c, 'pedidos', id) : linkDecidir(c, 'cofre'),
      });
      req.resume();
      return;
    }
    if (escrita) {
      const o = veioDaTela(req);
      if (!o.ok) {
        console.log(`sessoes: ${metodo} /${partes.join('/')} recusado: Origin de outro site ou ausente (visto: ${o.visto})`);
        falhar(res, 403, { erro: 'Pedido recusado: ele não veio da tela deste painel (Origin ausente ou de outro site). Por segurança, as ações da aba Sessões só valem quando feitas pela própria tela.' });
        req.resume();
        return;
      }
    }

    const bloqueio = qualBloqueio(partes);
    if (bloqueio) {
      console.log(`sessoes: ${req.method} /${partes.join('/')} recusado no painel (${bloqueio} só no DG Telegram)`);
      falhar(res, 403, {
        erro: FRASE_BLOQUEIO,
        abrir_em: linkDecidir(c, bloqueio === 'cofre' ? 'cofre' : 'pedidos', bloqueio === 'decidir' || bloqueio === 'tecla' ? partes[0] : null),
      });
      return;
    }

    const temCorpo = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
    const tamanho = parseInt(req.headers['content-length'] || '0', 10);
    if (tamanho > TETO_CORPO_BYTES) {
      falhar(res, 413, { erro: 'O arquivo passou do limite de 100 MB. Mande um menor ou peça ao card que busque o arquivo direto no disco.' });
      req.resume();
      return;
    }

    const tipo = String(req.headers['content-type'] || '').toLowerCase();
    if (temCorpo && metodo !== 'GET' && metodo !== 'HEAD' && metodo !== 'OPTIONS' && !/^(application\/json|multipart\/form-data)\s*(;|$)/.test(tipo)) {
      falhar(res, 415, { erro: 'O pedido tem um tipo de conteúdo que a aba Sessões não aceita. Só vale JSON (application/json) ou envio de arquivo (multipart/form-data), que é o que a tela manda.' });
      req.resume();
      return;
    }

    const ehAnexo = partes[1] === 'anexo';
    const padraoMs = ehAnexo ? TIMEOUT_ANEXO_MS : (metodo === 'GET' || metodo === 'HEAD' ? TIMEOUT_GET_MS : TIMEOUT_ESCRITA_MS);
    const forcado = parseInt(process.env.DGCLAW_PANEL_SESSOES_TIMEOUT_MS || '', 10);
    const timeoutMs = forcado > 0 ? forcado : padraoMs;

    const cabecalhos = {
      Authorization: `Bearer ${c.chave}`,
      Accept: req.headers.accept || 'application/json',
      'User-Agent': 'dgclaw-painel',
    };
    if (req.headers['content-type']) cabecalhos['Content-Type'] = req.headers['content-type'];
    if (req.headers['content-length'] !== undefined) cabecalhos['Content-Length'] = req.headers['content-length'];

    const caminhoOrigem = (c.url.pathname.replace(/\/+$/, '') + PREFIXO_ORIGEM) + (resto || '') + query;
    const motor = c.url.protocol === 'https:' ? https : http;
    const hostPorta = c.url.host;
    const nome = nomeDeLog(metodo, partes, query);

    let respondeu = false; // a origem já devolveu o cabeçalho: um erro de escrita depois disso não vira 502
    const pedido = motor.request({
      protocol: c.url.protocol, hostname: c.url.hostname, port: c.url.port || undefined,
      method: metodo, path: caminhoOrigem, headers: cabecalhos,
    }, (resp) => {
      const status = resp.statusCode || 502;
      respondeu = true;
      if (metodo !== 'GET') console.log(`${nome} -> ${status}`);

      // Erro da origem: lido inteiro (é JSON curto), com a chave trocada por *** por garantia.
      if (status >= 400) {
        const pedacos = [];
        let total = 0;
        let estourou = false;
        resp.on('data', (b) => {
          total += b.length;
          if (total > TETO_ERRO_BYTES) { estourou = true; resp.destroy(); return; }
          pedacos.push(b);
        });
        resp.on('error', () => { /* tratado no 'close' */ });
        resp.on('close', () => {
          if (res.headersSent) return;
          if (estourou) {
            console.error(`${nome} falhou: a resposta de erro do DG Telegram passou de ${TETO_ERRO_BYTES} bytes`);
            falhar(res, 502, { erro: `O DG Telegram respondeu ${status} com um corpo grande demais para ser uma mensagem de erro.` });
            return;
          }
          const texto = limparChave(Buffer.concat(pedacos).toString('utf-8'), c.chave);
          if (status === 423) {
            let frase = FRASE_COFRE;
            try { const j = JSON.parse(texto); if (j && j.erro) frase = j.erro; } catch { /* corpo que não é JSON: vale a frase padrão */ }
            res.status(503).json({ ok: false, erro: frase, cofre_trancado: true, abrir_em: linkDecidir(c, 'cofre') });
            return;
          }
          res.status(status);
          if (resp.headers['content-type']) res.setHeader('Content-Type', resp.headers['content-type']);
          res.setHeader('Cache-Control', 'no-store');
          res.end(texto);
        });
        return;
      }

      res.status(status);
      for (const h of ['content-type', 'content-length', 'content-disposition']) {
        if (resp.headers[h]) res.setHeader(h, resp.headers[h]);
      }
      res.setHeader('Cache-Control', 'no-store');
      resp.on('error', (e) => {
        console.error(`${nome} falhou: a resposta do DG Telegram foi cortada no meio (${e.code || e.message})`);
        res.destroy();
      });
      resp.pipe(res);
    });

    pedido.setTimeout(timeoutMs, () => {
      pedido.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    pedido.on('error', (e) => {
      if (respondeu) return; // a resposta da origem já está sendo tratada acima
      const causa = e.code || e.message || 'erro desconhecido';
      console.error(`${nome} falhou: ${causa} ao falar com o DG Telegram em ${hostPorta}`);
      const seg = Math.round(timeoutMs / 1000);
      falhar(res, 502, {
        erro: `O DG Telegram não respondeu (${causa}) em ${hostPorta}`
          + `${causa === 'ETIMEDOUT' ? `, depois de ${seg} segundos` : ''}. `
          + 'Confira se o serviço dg-telegram está de pé e tente de novo. '
          + (metodo === 'GET' ? '' : 'Se foi um envio, olhe a conversa do card antes de repetir: ele pode ter chegado.'),
      });
    });
    res.on('close', () => { if (!res.writableEnded) pedido.destroy(); });

    if (temCorpo && metodo !== 'GET' && metodo !== 'HEAD') req.pipe(pedido);
    else pedido.end();
  }

  router.all([PREFIXO, `${PREFIXO}/*`], tratar);
}

module.exports = { registrar };
