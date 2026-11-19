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

function criarPrimeiroAcesso({ config, auth, log, agora, revalidarProxy }) {
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
    // Edição linha a linha: troca só a linha do hash e mantém o resto do web.env como está.
    if (hash.includes("'")) throw new Error('o hash gerado contém aspas simples e não pode ser gravado no web.env');
    let texto = '';
    try { texto = fs.readFileSync(webEnv, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const linha = `DGCLAW_PANEL_PASSWORD_HASH='${hash}'`;
    if (RX_LINHA_HASH.test(texto)) {
      // Fica uma definição só: a nova entra no lugar da primeira e as outras saem (o dotenv usaria a última).
      let primeira = true;
      // A definição que fica é sempre a canônica (início da linha, sem export), que é o que o instalador procura.
      texto = texto.replace(/^(\s*(?:export\s+)?)DGCLAW_PANEL_PASSWORD_HASH\s*=.*(?:\r?\n|$)/gm, () => {
        if (!primeira) return '';
        primeira = false;
        return `${linha}\n`;
      });
    } else texto = texto + (texto && !texto.endsWith('\n') ? '\n' : '') + `${linha}\n`;
    gravaAtomico(webEnv, texto);
  }

  const erro = (status, msg, extra) => ({ status, corpo: Object.assign({ ok: false, erro: msg }, extra || {}) });
  let trocandoDono = false;

  /** Troca da senha do dono logado: confere a atual (mesmo limitador do login), grava só o hash no web.env e abre sessão nova.
   *  As demais sessões caem em auth.definirHash. Mesmas regras de força do primeiro acesso. */
  async function trocarSenhaDono(dados, ip, req, sessao) {
    const { atual, nova, confirmacao } = dados || {};
    if (typeof atual !== 'string' || !atual) return erro(400, 'Digite a senha atual.');
    if (typeof nova !== 'string') return erro(400, 'Digite a senha nova.');
    if (typeof confirmacao !== 'string' || nova.normalize('NFKC') !== confirmacao.normalize('NFKC')) return erro(400, 'As senhas não conferem.');
    const tamNova = [...nova.normalize('NFKC')].length; // a mesma forma que o scrypt usa, contada em pontos de código
    if (tamNova < 12) return erro(400, `A senha precisa ter pelo menos 12 caracteres (a sua tem ${tamNova}).`);
    if (nova.toLowerCase() === 'admin') return erro(400, 'Essa senha é fácil demais de adivinhar. Escolha outra.');
    const norm = (v) => String(v).normalize('NFKC'); // a mesma normalização do scrypt em lib/auth.js
    if (norm(nova) === norm(atual)) return erro(400, 'A senha nova precisa ser diferente da atual.');
    if (trocandoDono) return erro(409, 'Já há uma troca de senha em andamento. Espere alguns segundos e tente de novo.');
    trocandoDono = true;
    try {
      const v = await auth.verificaSenha(auth.usuario, atual, ip);
      if (!v.ok) {
        if (v.limite) { log('aviso', `Troca de senha do dono bloqueada por excesso de tentativas (ip ${ip}).`); return erro(429, v.erro, { retryAfter: v.retryAfter }); }
        if (v.trancado) return erro(403, v.erro);
        log('aviso', `Troca de senha do dono recusada (ip ${ip}): senha atual não confere.`);
        return v.campo ? erro(403, 'A senha atual não confere.') : erro(500, v.erro);
      }
      let hash;
      try {
        hash = await auth.gerarHash(nova);
      } catch (e) {
        if (e.ocupado) return erro(429, e.message, { retryAfter: 2 });
        log('erro', `Troca de senha do dono: falha ao gerar o hash (${e.message}).`);
        return erro(500, 'Não consegui processar a senha agora. Tente de novo em instantes.');
      }
      // Depois dos awaits: a sessão que autorizou o pedido ainda tem de valer.
      const agoraSessao = auth.sessaoDoPedido(req);
      if (!agoraSessao || agoraSessao.papel !== 'dono' || agoraSessao.usuario !== sessao.usuario) return erro(401, 'A sua sessão deixou de valer enquanto você trocava a senha. Entre de novo.');
      // Antes de gravar: o link de primeiro acesso pendente deixa de valer (como na troca pelo terminal).
      // Se não der para apagar, a troca não acontece e a senha antiga continua valendo.
      try {
        fs.rmSync(arquivo, { force: true });
      } catch (e) {
        log('erro', `Troca de senha do dono: não consegui invalidar o link de primeiro acesso pendente em ${arquivo} (${e.code || e.message}). A senha antiga continua valendo.`);
        return erro(500, `Não consegui invalidar o link de recuperação pendente (${e.code || e.message}). A senha antiga continua valendo; peça ao Admin para conferir a permissão da pasta de configuração.`);
      }
      try {
        gravaHashNoEnv(hash);
      } catch (e) {
        log('erro', `Troca de senha do dono: não consegui gravar a senha em ${webEnv} (${e.code || e.message}). A senha antiga continua valendo.`);
        return erro(500, `Não consegui gravar a senha no servidor (${e.code || e.message}). A senha antiga continua valendo; peça ao Admin para conferir a permissão do arquivo de configuração.`);
      }
      const r = auth.definirHash(hash);
      if (!r.ok) {
        log('erro', `Troca de senha do dono: o hash gerado não foi aceito (${r.erro}).`);
        return erro(500, `O servidor não aceitou o hash gerado (${r.erro}). Rode no servidor: sudo dgclaw senha`);
      }
      // As outras sessões já caíram; os WebSockets do proxy que seguem abertos precisam ser conferidos agora, não em até 30 s.
      if (revalidarProxy) revalidarProxy();
      const s = auth.criaSessao(auth.usuario, req);
      log('info', `${auth.usuario} trocou a senha do painel pelo painel (ip ${ip}); as outras sessões foram derrubadas.`);
      return { status: 200, corpo: { ok: true, destino: '/' }, cookies: s.cookies };
    } finally { trocandoDono = false; }
  }

  return {
    arquivo,
    trocarSenhaDono,
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

      if (typeof senha !== 'string') return erro(400, 'Digite a senha.');
      if (typeof confirmacao !== 'string' || senha.normalize('NFKC') !== confirmacao.normalize('NFKC')) return erro(400, 'As senhas não conferem.');
      const tamSenha = [...senha.normalize('NFKC')].length;
      if (tamSenha < 12) return erro(400, `A senha precisa ter pelo menos 12 caracteres (a sua tem ${tamSenha}).`);
      if (senha.toLowerCase() === 'admin') return erro(400, 'Essa senha é fácil demais de adivinhar. Escolha outra.');

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

module.exports = { criarPrimeiroAcesso, caminhoArquivo };
