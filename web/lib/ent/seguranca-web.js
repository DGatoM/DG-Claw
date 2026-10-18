'use strict';
// Bloco E: cabeçalhos de segurança do Web e cookie de sessão endurecido (proteção `https_endurecido`).
// No nível pessoal este módulo não faz nada. Ligada a proteção, TODA resposta (menos as que já trazem a própria
// política, como a página do visual do chat e os arquivos ativos) leva:
//
//   Content-Security-Policy   página do Web: default-src 'self'; script-src 'self' + o hash de cada <script> inline das
//                             páginas; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; object-src 'none';
//                             base-uri 'self'; form-action 'self'; img/media/font com data: e blob:; connect-src 'self'.
//   rotas /p/<slug>/ (painel)  política própria: o painel do agente tem <script> inline e onclick="" (janela modal), então
//                             script-src leva 'unsafe-inline'. Fica registrado em docs/enterprise/TRAVAS.md.
//   Permissions-Policy        câmera e microfone só do próprio site (o chat grava voz).
//   Strict-Transport-Security só quando o pedido chegou por HTTPS (pelo proxy confiável).
//
// Por que hash e não nonce: as páginas são arquivos estáticos servidos do disco (e cacheados com ETag); um nonce por
// resposta obrigaria a reescrever o HTML. O hash é calculado na partida e de novo quando o arquivo muda.
// Por que style 'unsafe-inline': as páginas têm <style> e style="" dentro do HTML e o JavaScript monta estilos
// por atributo. O risco que sobra é injeção de CSS (sem execução de script); está registrado como aceito.
// Cookie: com HTTPS ligado o cookie de sessão passa a se chamar __Host-dgclaw_sessao (web/lib/auth.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RX_SCRIPT_INLINE = /<script(?![^>]*\ssrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;

/** Hashes (sha256, base64) dos <script> inline de um texto HTML. Script com type diferente de JavaScript também entra: é inofensivo. */
function hashesDeScripts(html) {
  const saida = [];
  for (const m of String(html).matchAll(RX_SCRIPT_INLINE)) {
    if (!m[2].trim()) continue;
    saida.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return saida;
}

function politicaDaPagina(hashes) {
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

// O painel do agente (/p/<slug>/) não pode usar a política das páginas do Web: tem <script> inline com dados da página
// (window.DGCLAW_BASE) e onclick="" no HTML. É a política mais firme que não quebra o painel.
const POLITICA_PAINEL = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()';

module.exports = {
  nome: 'seguranca-web',
  ordem: 5,
  criar(ctx) {
    const { config, protecoes, auth, log } = ctx;
    const esquema = ctx.esquemaDoPedido || ((req) => {
      const confiaveis = config.proxiesConfiaveis;
      return require('../http').esquemaDoPedido(req, confiaveis);
    });
    if (auth && typeof auth.definirCookieEndurecido === 'function') {
      auth.definirCookieEndurecido(() => protecoes.ligada('https_endurecido'));
    }

    let cache = { marca: null, politica: null };
    /** A política das páginas, recalculada quando algum .html da pasta pública muda. */
    function politica() {
      let marca = '';
      let arquivos;
      try {
        arquivos = fs.readdirSync(config.publicDir).filter((n) => n.endsWith('.html')).sort();
        for (const n of arquivos) { const st = fs.statSync(path.join(config.publicDir, n)); marca += `${n}:${st.mtimeMs}:${st.size};`; }
      } catch (e) {
        if (cache.politica) return cache.politica;
        log('aviso', `Não consegui ler as páginas em ${config.publicDir} para montar a política de conteúdo (${e.code || e.message}). Vale a política sem hashes; as páginas com script inline não vão rodar até a pasta ser lida.`);
        return politicaDaPagina([]);
      }
      if (cache.marca === marca) return cache.politica;
      const hashes = new Set();
      for (const n of arquivos) {
        try {
          for (const h of hashesDeScripts(fs.readFileSync(path.join(config.publicDir, n), 'utf8'))) hashes.add(h);
        } catch (e) {
          log('aviso', `Não consegui ler ${n} para calcular o hash dos scripts dele (${e.code || e.message}); a página pode não rodar com a política de conteúdo.`);
        }
      }
      cache = { marca, politica: politicaDaPagina([...hashes].sort()) };
      return cache.politica;
    }

    return {
      // Roda antes do login e do roteamento: o setHeader vale para o que vier depois (writeHead com cabeçalho igual vence).
      antesDaSessao(req, res, url) {
        if (!protecoes.ligada('https_endurecido')) return false;
        const painel = url.pathname.startsWith('/p/');
        res.setHeader('Content-Security-Policy', painel ? POLITICA_PAINEL : politica());
        res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (esquema(req) === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        return false;
      },
    };
  },
  hashesDeScripts,
  politicaDaPagina,
  POLITICA_PAINEL,
};
