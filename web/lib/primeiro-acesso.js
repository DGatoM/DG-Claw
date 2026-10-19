'use strict';
// Primeiro acesso por link de uso único: o instalador (ou `dgclaw primeiro-acesso`) grava o sha256 de um token
// em primeiro-acesso.json; a pessoa abre /primeiro-acesso#<token>, cadastra a senha no navegador e já entra logada.
// O token nunca vai para o disco nem para o log. O arquivo tem {versao, usuario, token_sha256, criado, expira, usado_em}
// (epoch ms) e é gerado por gerar_primeiro_acesso em lib/comum.sh.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const JANELA_MS = 10 * 60 * 1000;
const MAX_POSTS = 10;
const RX_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RX_LINHA_HASH = /^(\s*(?:export\s+)?)DGCLAW_PANEL_PASSWORD_HASH\s*=.*$/m;

const sha256buf = (v) => crypto.createHash('sha256').update(v).digest();

/** Caminho do primeiro-acesso.json (ao lado do web.env, salvo DGCLAW_PRIMEIRO_ACESSO). */
function caminhoArquivo(config) {
  if (config.env.DGCLAW_PRIMEIRO_ACESSO) return config.env.DGCLAW_PRIMEIRO_ACESSO;
  return path.join(path.dirname(caminhoWebEnv(config)), 'primeiro-acesso.json');
}
function caminhoWebEnv(config) { return config.env.DGCLAW_WEB_ENV || '/etc/dgclaw/web.env'; }

function gravaAtomico(arquivo, texto) {
  const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, texto, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, arquivo);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* não existia */ }
    throw e;
  }
}

/** Por que a senha nova não serve (texto para a pessoa), ou null se serve. Usada também pelo multiusuário. */
function motivoSenhaInvalida(senha, confirmacao) {
  if (typeof senha !== 'string') return 'Digite a senha.';
  if (senha !== confirmacao) return 'As senhas não conferem.';
  if (senha.length < 12) return `A senha precisa ter pelo menos 12 caracteres (a sua tem ${senha.length}).`;
  if (senha.toLowerCase() === 'admin') return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  return null;
}

function criarPrimeiroAcesso({ config, auth, log, agora }) {
  const relogio = agora || (() => Date.now());
  const arquivo = caminhoArquivo(config);
  const webEnv = caminhoWebEnv(config);
  const posts = new Map(); // ip -> [timestamps]

  function limite(ip) {
    const t = relogio();
    const lista = (posts.get(ip) || []).filter((x) => t - x < JANELA_MS);
    if (lista.length >= MAX_POSTS) {
      posts.set(ip, lista);
      return Math.max(1, Math.ceil((lista[0] + JANELA_MS - t) / 60000));
    }
    lista.push(t); posts.set(ip, lista);
    if (posts.size > 5000) for (const [k, v] of posts) if (!v.some((x) => t - x < JANELA_MS)) posts.delete(k);
    return 0;
  }

  function lerArquivo() {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  }

  function gravaHashNoEnv(hash) {
    if (hash.includes("'")) throw new Error('o hash gerado contém aspas simples e não pode ser gravado no web.env');
    let texto = '';
    try { texto = fs.readFileSync(webEnv, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const linha = `DGCLAW_PANEL_PASSWORD_HASH='${hash}'`;
    if (RX_LINHA_HASH.test(texto)) texto = texto.replace(RX_LINHA_HASH, (_, pre) => `${pre}${linha}`);
    else texto = texto + (texto && !texto.endsWith('\n') ? '\n' : '') + `${linha}\n`;
    gravaAtomico(webEnv, texto);
  }

  const erro = (status, msg, extra) => ({ status, corpo: Object.assign({ ok: false, erro: msg }, extra || {}) });

  return {
    arquivo,
    async consumir(dados, ip, req) {
      const { token, senha, confirmacao } = dados || {};
      const espera = limite(ip || '?');
      if (espera) {
        log('aviso', `Primeiro acesso: excesso de tentativas (ip ${ip}).`);
        return erro(429, `Muitas tentativas. Tente de novo em ${espera} min.`, { retryAfter: espera * 60 });
      }
      if (typeof token !== 'string' || !RX_TOKEN.test(token)) {
        return erro(400, 'Este link está incompleto. Copie o link inteiro que apareceu no fim da instalação.');
      }
      let dado;
      try {
        dado = lerArquivo();
      } catch (e) {
        if (e.code === 'ENOENT') {
          if (!auth.semSenha && !auth.trancado) return erro(410, 'Este link já foi usado. Se não foi você, rode no servidor: sudo dgclaw senha');
          return erro(404, 'Este link não vale mais. Gere outro com: sudo dgclaw primeiro-acesso');
        }
        log('erro', `Primeiro acesso: não consegui ler ${arquivo} (${e.code || e.message}). Confira se o JSON está inteiro; gere outro com sudo dgclaw primeiro-acesso.`);
        return erro(500, `Não consegui ler o arquivo do link de primeiro acesso (${e.code || e.message}). No servidor, rode: sudo dgclaw primeiro-acesso`);
      }
      const esperado = Buffer.from(String(dado && dado.token_sha256 || ''), 'hex');
      if (esperado.length !== 32 || !crypto.timingSafeEqual(sha256buf(token), esperado)) {
        log('aviso', `Primeiro acesso: token que não confere (ip ${ip}).`);
        return erro(403, 'Este link não vale (ou foi copiado pela metade, ou já foi trocado por um mais novo). Gere outro com: sudo dgclaw primeiro-acesso');
      }
      if (dado.usado_em != null) return erro(410, 'Este link já foi usado. Se não foi você, rode no servidor: sudo dgclaw senha');
      if (!(Number(dado.expira) > relogio())) return erro(410, 'Este link expirou. Gere outro com: sudo dgclaw primeiro-acesso');

      const senhaRuim = motivoSenhaInvalida(senha, confirmacao);
      if (senhaRuim) return erro(400, senhaRuim);

      let hash;
      try {
        hash = await auth.gerarHash(senha);
      } catch (e) {
        if (e.ocupado) return erro(429, e.message, { retryAfter: 2 });
        log('erro', `Primeiro acesso: falha ao gerar o hash da senha (${e.message}).`);
        return erro(500, 'Não consegui processar a senha agora. Tente de novo em instantes.');
      }

      // depois do await: confere de novo, em sequência síncrona, que ninguém usou o token no meio
      let atual;
      try { atual = lerArquivo(); } catch (e) { return erro(410, 'Este link já foi usado. Se não foi você, rode no servidor: sudo dgclaw senha'); }
      if (atual.token_sha256 !== dado.token_sha256 || atual.usado_em != null) {
        return erro(410, 'Este link já foi usado. Se não foi você, rode no servidor: sudo dgclaw senha');
      }
      const usuario = String(atual.usuario || auth.usuario || '').trim();
      try {
        gravaAtomico(arquivo, JSON.stringify(Object.assign({}, atual, { usado_em: relogio() })) + '\n');
      } catch (e) {
        log('erro', `Primeiro acesso: não consegui marcar o link como usado em ${arquivo} (${e.code || e.message}).`);
        return erro(500, `Não consegui gravar o uso do link (${e.code || e.message}). No servidor, rode: sudo dgclaw primeiro-acesso`);
      }
      try {
        gravaHashNoEnv(hash);
      } catch (e) {
        log('erro', `Primeiro acesso: não consegui gravar a senha em ${webEnv} (${e.code || e.message}). O link já foi marcado como usado.`);
        return erro(500, `Não consegui gravar a senha no servidor (${e.code || e.message}). O link já foi usado: rode no servidor sudo dgclaw primeiro-acesso e tente de novo.`);
      }
      const r = auth.definirHash(hash);
      if (!r.ok) {
        log('erro', `Primeiro acesso: o hash gerado não foi aceito (${r.erro}).`);
        return erro(500, `O servidor não aceitou o hash gerado (${r.erro}). Rode: sudo dgclaw primeiro-acesso`);
      }
      const s = auth.criaSessao(usuario, req);
      log('info', `Primeiro acesso concluído: senha cadastrada para ${usuario} (ip ${ip}).`);
      return { status: 200, corpo: { ok: true, destino: '/a/admin' }, cookie: s.cookie };
    },
  };
}

module.exports = { criarPrimeiroAcesso, caminhoArquivo, motivoSenhaInvalida };
