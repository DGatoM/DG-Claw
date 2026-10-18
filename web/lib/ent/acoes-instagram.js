'use strict';
// Bloco E: ações do Instagram com aprovação humana (proteção `travas_externas`). Texto completo: docs/enterprise/TRAVAS.md.
//
// O agente não publica sozinho. Com a trava ligada, o token do Instagram sai do agente e fica num cofre do host que o
// container não monta (<etc>/acoes-externas/<slug>/instagram.env, 600, ou instagram.env.cred cifrado com o mesmo mecanismo
// do bloco D). O `scripts/ig-publish.py` (DGCLAW_TRAVAS=1) pede a ação por aqui, pela caixa, e o TI aprova na tela de aprovações.
// Aprovado, o Web publica pela Graph API com o token no CORPO do POST, nunca na query string.
//
//   POST /api/v1/acoes/instagram          só pela caixa (agente). Corpo:
//        {"op":"publicar","conta":"1784...","legenda":"...","imagem_url":"https://..."}
//        {"op":"responder","comentario_id":"1785...","mensagem":"..."}
//        Responde 202 {pendente:true, aprovacao:<id>}. O agente consulta GET /api/v1/aprovacoes/<id> até virar "executada".
//   GET  /api/v1/acoes/instagram/<id>/previa   só TI em navegador: a mídia do pedido, buscada pelo servidor (a tela não carrega
//        URL de fora, a CSP não deixa e o endereço do TI não deve ir para um servidor escolhido pelo agente).
//
// A frase da aprovação sai dos parâmetros validados aqui (conta, legenda inteira, endereço da mídia, comentário respondido).
// A legenda é texto do agente, mas é justamente o que o TI precisa ler antes de aprovar: entra entre aspas, sem crase e sem
// caractere de controle. O resto da frase é nosso.

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const H = require('../http');
const { hashParams } = require('../aprovacoes-arquivo');

const GRAPH = 'https://graph.facebook.com/v21.0';
const RX_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RX_CONTA = /^[0-9]{5,25}$/;
const RX_COMENTARIO = /^[0-9]{5,30}$/;
const LEGENDA_MAX = 2200;
const MIDIA_MAX = 8 * 1024 * 1024;
const RX_PREVIA = /^\/api\/v1\/acoes\/instagram\/([0-9a-f]{24})\/previa$/;
const RX_CONTROLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

class ErroAcao extends Error {
  constructor(mensagem, status) { super(mensagem); this.status = status || 400; }
}

/** Texto do agente que vai para a frase da aprovação: sem controle, sem crase (a tela usa crase para destacar o nosso texto). */
function citar(texto) {
  return String(texto).replace(RX_CONTROLE, ' ').replace(/`/g, "'").replace(/\r\n?/g, '\n');
}

/** Valida o pedido do agente. Devolve os params limpos ou lança ErroAcao com o motivo em português. */
function validar(corpo, agente) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new ErroAcao('Mande um objeto JSON com "op": "publicar" ou "responder".');
  const permitidos = corpo.op === 'responder' ? ['op', 'comentario_id', 'mensagem'] : ['op', 'conta', 'legenda', 'imagem_url'];
  for (const k of Object.keys(corpo)) {
    if (!permitidos.includes(k)) throw new ErroAcao(`O campo "${String(k).slice(0, 40)}" não existe nesta ação. Os campos de "${corpo.op === 'responder' ? 'responder' : 'publicar'}" são: ${permitidos.join(', ')}.`);
  }
  if (corpo.op === 'publicar') {
    if (typeof corpo.conta !== 'string' || !RX_CONTA.test(corpo.conta)) throw new ErroAcao('"conta" precisa ser o igAccountId (só números, de 5 a 25 dígitos).');
    if (typeof corpo.legenda !== 'string' || !corpo.legenda.trim()) throw new ErroAcao('"legenda" precisa ser um texto (a legenda do post), e não pode ficar vazia.');
    if ([...corpo.legenda].length > LEGENDA_MAX) throw new ErroAcao(`A legenda passa de ${LEGENDA_MAX} caracteres, que é o limite do Instagram.`);
    const url = urlDaMidia(corpo.imagem_url);
    return { agente, conta: corpo.conta, legenda: citar(corpo.legenda).trim(), imagem_url: url };
  }
  if (corpo.op === 'responder') {
    if (typeof corpo.comentario_id !== 'string' || !RX_COMENTARIO.test(corpo.comentario_id)) throw new ErroAcao('"comentario_id" precisa ser o id do comentário (só números).');
    if (typeof corpo.mensagem !== 'string' || !corpo.mensagem.trim()) throw new ErroAcao('"mensagem" precisa ser o texto da resposta, e não pode ficar vazia.');
    if ([...corpo.mensagem].length > LEGENDA_MAX) throw new ErroAcao(`A resposta passa de ${LEGENDA_MAX} caracteres, que é o limite do Instagram.`);
    return { agente, comentario_id: corpo.comentario_id, mensagem: citar(corpo.mensagem).trim() };
  }
  throw new ErroAcao('"op" precisa ser "publicar" ou "responder".');
}

function urlDaMidia(v) {
  let u;
  try { u = new URL(String(v)); } catch (_) { throw new ErroAcao('"imagem_url" precisa ser um endereço https completo, como https://exemplo.com/foto.jpg.'); }
  if (u.protocol !== 'https:') throw new ErroAcao('"imagem_url" precisa começar com https://. O Instagram só aceita endereço público e seguro.');
  if (u.username || u.password) throw new ErroAcao('"imagem_url" não pode ter usuário e senha no endereço.');
  if (u.port && u.port !== '443') throw new ErroAcao('"imagem_url" precisa usar a porta padrão do https (443).');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new ErroAcao('"imagem_url" precisa ter um nome de site, não um número de IP.');
  if (String(v).length > 2000) throw new ErroAcao('"imagem_url" passa de 2000 caracteres.');
  return u.toString();
}

function descrever(params, op) {
  if (op === 'comentario.responder') {
    return `Responder no Instagram o comentário \`${params.comentario_id}\` (pedido do agente \`${params.agente}\`) com este texto: "${params.mensagem}"`;
  }
  return `Publicar no Instagram da conta \`${params.conta}\` (pedido do agente \`${params.agente}\`) o post com a imagem ${params.imagem_url} e esta legenda, inteira: "${params.legenda}"`;
}

// ── a mídia da prévia, buscada pelo servidor com defesa contra SSRF ─────────────────────────────
function enderecoPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapeado) return enderecoPrivado(mapeado[1]);
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

/** Baixa a imagem com https, sem seguir redirecionamento, no máximo 8 MB e só se for imagem. Devolve { tipo, buf }. */
async function buscarMidia(url, { resolver } = {}) {
  const u = new URL(url);
  const res = resolver || ((h) => dns.promises.lookup(h, { all: true }));
  let enderecos;
  try { enderecos = await res(u.hostname); } catch (e) {
    throw new ErroAcao(`Não consegui achar o endereço de ${u.hostname} (${e.code || e.message}). A prévia não carregou; confira a URL nos detalhes do pedido.`, 502);
  }
  if (!enderecos.length || enderecos.some((a) => enderecoPrivado(a.address))) {
    throw new ErroAcao(`${u.hostname} aponta para um endereço interno ou reservado, então o servidor não busca essa mídia. A prévia foi recusada; olhe o endereço nos detalhes do pedido.`, 403);
  }
  const alvo = enderecos[0];
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: alvo.address, family: alvo.family, port: 443, method: 'GET', path: u.pathname + u.search, servername: u.hostname,
      headers: { Host: u.hostname, 'User-Agent': 'dgclaw-previa/1', Accept: 'image/*' }, timeout: 15000,
    }, (r) => {
      const tipo = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (r.statusCode !== 200) { r.resume(); reject(new ErroAcao(`O site da mídia respondeu ${r.statusCode}, então não há prévia.`, 502)); return; }
      if (!/^image\/(jpeg|png|webp|gif)$/.test(tipo)) { r.resume(); reject(new ErroAcao(`A URL não devolve uma imagem (veio "${tipo.slice(0, 40) || 'sem tipo'}"), então não há prévia.`, 415)); return; }
      const partes = []; let total = 0;
      r.on('data', (c) => {
        total += c.length;
        if (total > MIDIA_MAX) { req.destroy(new ErroAcao('A imagem passa de 8 MB; não mostro a prévia.', 413)); return; }
        partes.push(c);
      });
      r.on('end', () => resolve({ tipo, buf: Buffer.concat(partes) }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ErroAcao('O site da mídia demorou demais (15 s), então não há prévia.', 504)));
    req.on('error', (e) => reject(e instanceof ErroAcao ? e : new ErroAcao(`Não consegui baixar a mídia (${e.code || e.message}).`, 502)));
    req.end();
  });
}

module.exports = {
  nome: 'acoes-instagram',
  ordem: 40,
  criar(ctx) {
    const { config, registro, protecoes, auditoria, log, caixa } = ctx;
    if (!ctx.aprovacoes) throw new Error('O módulo acoes-instagram precisa do módulo aprovacoes (web/lib/ent/aprovacoes.js, ordem 20) carregado antes dele.');
    const aprovacoes = ctx.aprovacoes;
    const o = ctx.instagram || {};
    const doFetch = o.fetch || fetch;
    const dormir = o.dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const buscar = o.buscarMidia || buscarMidia;
    const creds = o.comandoCreds || process.env.DGCLAW_SYSTEMD_CREDS || 'systemd-creds';
    const dirAcoes = () => o.dir || process.env.DGCLAW_ACOES_EXTERNAS_DIR || path.join(path.dirname(config.protecoesPath), 'acoes-externas');
    if (caixa) caixa.permitir('/api/v1/acoes');

    /** { token, conta } do cofre do host do agente, ou null se não foi configurado. Nunca vai para log nem para resposta. */
    function lerCofre(slug) {
      if (!RX_SLUG.test(slug)) throw new ErroAcao(`O nome curto "${String(slug).slice(0, 40)}" não serve.`);
      const base = path.join(dirAcoes(), slug);
      let texto;
      const cred = path.join(base, 'instagram.env.cred');
      const claro = path.join(base, 'instagram.env');
      if (fs.existsSync(cred)) {
        try {
          texto = execFileSync(creds, ['decrypt', `--name=dgclaw-acoes-instagram-${slug}`, cred, '-'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).toString('utf8');
        } catch (e) {
          const motivo = (e && e.stderr ? String(e.stderr).replace(/\s+/g, ' ').trim().slice(0, 160) : '') || (e && e.code === 'ENOENT' ? 'o programa systemd-creds não existe' : 'erro desconhecido');
          throw Object.assign(new Error(`Não consegui decifrar o token do Instagram do agente ${slug} (${motivo}). Confira o systemd-creds no servidor; nada foi publicado.`), { revertePedido: true });
        }
      } else if (fs.existsSync(claro)) {
        texto = fs.readFileSync(claro, 'utf8');
      } else {
        return null;
      }
      const campo = (n) => { const m = new RegExp(`^${n}=(.*)$`, 'm').exec(texto); return m ? m[1].trim() : ''; };
      const token = campo('IG_TOKEN');
      return token ? { token, conta: campo('IG_CONTA') } : null;
    }

    /** Erro da Graph API em português, sem nunca incluir o token. */
    async function erroGraph(r, o2) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        const e = j && j.error ? j.error : {};
        msg = `Graph API erro ${e.code || r.status}${e.error_subcode ? `/${e.error_subcode}` : ''}: ${String(e.message || '').slice(0, 300)}`;
        if (e.error_user_msg) msg += ` | ${String(e.error_user_msg).slice(0, 200)}`;
      } catch (_) { /* resposta sem JSON: fica o status */ }
      return new Error(`O Instagram recusou ${o2}: ${msg}. O token e o pedido não foram repetidos; confira o token (dgclaw acoes instagram testar <agente>) e peça de novo.`);
    }

    /** POST com o token no corpo (form), nunca na URL. */
    async function postar(caminho, campos, token, o2) {
      const corpo = new URLSearchParams(Object.assign({}, campos, { access_token: token }));
      let r;
      try {
        r = await doFetch(`${GRAPH}/${caminho}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo.toString(), signal: AbortSignal.timeout(60000) });
      } catch (e) {
        throw new Error(`Não consegui falar com o Instagram para ${o2} (${e.name === 'TimeoutError' ? 'demorou mais de 60 s' : (e.cause && e.cause.code) || e.message}). A ação pode ou não ter saído: confira no app do Instagram antes de pedir de novo.`);
      }
      if (!r.ok) throw await erroGraph(r, o2);
      return r.json();
    }

    aprovacoes.registrarTipo('instagram', {
      descricaoMax: 2600,
      descrever,
      async executar(params, ap) {
        const cofre = lerCofre(params.agente);
        if (!cofre) {
          throw Object.assign(new Error(`O token do Instagram do agente ${params.agente} não está no cofre do host. Rode no servidor: dgclaw acoes instagram configurar ${params.agente}`), { revertePedido: true });
        }
        if (ap.op === 'comentario.responder') {
          const r = await postar(`${params.comentario_id}/replies`, { message: params.mensagem }, cofre.token, 'responder o comentário');
          return { saida: `Respondi o comentário ${params.comentario_id} no Instagram.`, reply_id: r.id || null };
        }
        if (cofre.conta && cofre.conta !== params.conta) {
          throw new Error(`A conta do pedido (${params.conta}) não é a que o TI configurou para o agente ${params.agente}. Nada foi publicado.`);
        }
        const c = await postar(`${params.conta}/media`, { image_url: params.imagem_url, caption: params.legenda }, cofre.token, 'criar o post');
        if (!c.id) throw new Error('O Instagram não devolveu o id do rascunho do post. Nada foi publicado.');
        await dormir(o.esperaMs == null ? 2000 : o.esperaMs);
        const p = await postar(`${params.conta}/media_publish`, { creation_id: c.id }, cofre.token, 'publicar o post');
        let permalink = null;
        try {
          // O token vai no cabeçalho, não na query string.
          const g = await doFetch(`${GRAPH}/${p.id}?fields=permalink`, { headers: { Authorization: `Bearer ${cofre.token}` }, signal: AbortSignal.timeout(30000) });
          if (g.ok) permalink = (await g.json()).permalink || null;
        } catch (e) {
          log('aviso', `Publiquei o post ${p.id} do agente ${params.agente}, mas não consegui buscar o endereço dele (${e.name}). O post está no ar.`);
        }
        return { saida: `Publicado no Instagram${permalink ? `: ${permalink}` : ` (id ${p.id})`}`, media_id: p.id || null, permalink };
      },
    });

    function negar(res, status, msg) { H.erroJson(res, status, msg); return true; }

    async function pedido(req, res, sessao) {
      if (sessao.via !== 'caixa') return negar(res, 403, 'Quem pede a ação do Instagram é o agente, pela caixa (scripts/ig-publish.py). O TI aprova em /aprovacoes.');
      const ag = registro.obter(sessao.agente);
      if (!ag || ag.tipo !== 'agente') return negar(res, 403, 'Só agentes de trabalho pedem ações do Instagram.');
      if (req.method !== 'POST') return negar(res, 405, 'Use POST em /api/v1/acoes/instagram.');
      let corpo;
      try { corpo = await H.lerJson(req, 16 * 1024); } catch (e) { return negar(res, e.status || 400, e.message); }
      let params;
      try { params = validar(corpo, sessao.agente); } catch (e) {
        if (e instanceof ErroAcao) return negar(res, e.status, e.message);
        throw e;
      }
      let cofre;
      try { cofre = lerCofre(sessao.agente); } catch (e) { log('erro', e.message); return negar(res, 503, e.message); }
      if (!cofre) return negar(res, 409, `O token do Instagram deste agente não está no cofre do host, então a ação não pode ser aprovada. Peça ao TI para rodar no servidor: dgclaw acoes instagram configurar ${sessao.agente}`);
      if (params.conta && cofre.conta && params.conta !== cofre.conta) {
        return negar(res, 403, 'A conta do pedido não é a conta do Instagram que o TI configurou para este agente. Use o igAccountId do .dgclaw/instagram.json.');
      }
      const op = corpo.op === 'responder' ? 'comentario.responder' : 'post.publicar';
      const hash = hashParams(params);
      const existente = aprovacoes.pendentes().find((p) => p.tipo === 'instagram' && p.op === op && p.pedido_por === `agente:${sessao.agente}` && hashParams(p.params) === hash);
      const ap = existente || aprovacoes.pedir({ tipo: 'instagram', op, params, pedido_por: `agente:${sessao.agente}` });
      H.enviaJson(res, 202, {
        ok: true, pendente: true, aprovacao: ap.id, estado: ap.estado, descricao: ap.descricao, expira_em: ap.expira_em, onde_aprovar: '/aprovacoes', ja_existia: !!existente,
        mensagem: 'A ação espera a aprovação de uma pessoa do TI em /aprovacoes. Consulte o resultado com GET /api/v1/aprovacoes/' + ap.id + ' (estado "executada" quer dizer que foi publicado).',
      });
      return true;
    }

    async function previa(req, res, sessao, id) {
      if (sessao.via === 'caixa' || !aprovacoes.ehTI(sessao)) return negar(res, 403, 'A prévia da mídia é só do TI.');
      const ap = aprovacoes.obter(id);
      if (!ap || ap.tipo !== 'instagram' || !ap.params || !ap.params.imagem_url) return negar(res, 404, 'Este pedido não tem mídia para mostrar.');
      try {
        const m = await buscar(ap.params.imagem_url);
        res.writeHead(200, {
          'Content-Type': m.tipo, 'Content-Length': m.buf.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline',
        });
        res.end(m.buf);
      } catch (e) {
        if (!(e instanceof ErroAcao)) { log('erro', `Prévia da mídia do pedido ${id}: ${e.message}`); return negar(res, 502, `Não consegui buscar a mídia (${e.message}).`); }
        return negar(res, e.status, e.message);
      }
      return true;
    }

    return {
      async antes(req, res, url, sessao) {
        const p = url.pathname;
        if (!(p === '/api/v1/acoes/instagram' || RX_PREVIA.test(p))) return false;
        if (!protecoes.ligada('travas_externas')) {
          return negar(res, 404, 'As travas de ação externa estão desligadas neste nível, então a publicação não passa por aprovação aqui (o ig-publish.py chama o Instagram direto).');
        }
        if (!sessao) return negar(res, 401, 'Você precisa entrar para usar esta rota. Faça login em /login.');
        const m = RX_PREVIA.exec(p);
        if (m) return previa(req, res, sessao, m[1]);
        return pedido(req, res, sessao);
      },
    };
  },
  validar, descrever, citar, enderecoPrivado, buscarMidia, urlDaMidia, ErroAcao,
};
