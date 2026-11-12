'use strict';
// Token do painel isolado (/pv/<token>/...). O painel de cada agente roda numa origem opaca, dentro de um iframe
// sandbox, e fala com a própria API por este token no caminho: ele é a credencial, porque a origem opaca não leva cookie.
//
// Formato: base64url(JSON {s: slug, i: idDaSessao, e: expiraEpochSeg}) + "." + base64url(HMAC-SHA256 do primeiro pedaço).
// Só letras, números, "_", "-" e ".": seguro para caminho de URL.
//
// O token não prova a sessão sozinho: `i` é um identificador derivado (HMAC da chave do mapa de sessões, nunca o valor do
// cookie nem o hash dele) e o servidor resolve de volta a sessão a CADA pedido (auth.sessaoPorIdPainel). Logout, troca de
// senha, revogação de colaborador e expiração da sessão invalidam o token na hora.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TAM_CHAVE = 32;
const VIDA_MAX_S = 12 * 3600;
const TAM_MAX_TOKEN = 400;
const RX_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function criarPainelToken({ dataDir, agora }) {
  const relogio = agora || (() => Date.now());
  const arquivo = path.join(dataDir, 'painel-token.chave');
  let chave = null; // { id, mac }: duas subchaves derivadas da chave do arquivo

  function derivar(base) {
    return {
      id: crypto.createHmac('sha256', base).update('dgclaw painel id').digest(),
      mac: crypto.createHmac('sha256', base).update('dgclaw painel mac').digest(),
    };
  }

  /** Lê a chave; cria no primeiro uso. Arquivo que existe com tamanho errado NÃO é recriado: erro com o motivo. */
  function carregaChave() {
    if (chave) return chave;
    let bruto;
    try {
      bruto = fs.readFileSync(arquivo);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Não consegui ler a chave dos painéis isolados em ${arquivo} (${e.code || e.message}). Confira a permissão da pasta de dados do DG Claw Web.`);
      const nova = crypto.randomBytes(TAM_CHAVE);
      try {
        fs.writeFileSync(arquivo, nova, { mode: 0o600, flag: 'wx' });
        bruto = nova;
      } catch (e2) {
        if (e2.code !== 'EEXIST') throw new Error(`Não consegui criar a chave dos painéis isolados em ${arquivo} (${e2.code || e2.message}). Confira se a pasta de dados do DG Claw Web aceita gravação.`);
        bruto = fs.readFileSync(arquivo); // outro processo criou entre a leitura e a gravação
      }
    }
    if (bruto.length !== TAM_CHAVE) {
      throw new Error(`A chave dos painéis isolados (${arquivo}) tem ${bruto.length} bytes e deveria ter ${TAM_CHAVE}. Não vou recriar sozinho, porque isso derrubaria os painéis abertos sem aviso. Apague o arquivo, de propósito, e reinicie o DG Claw Web.`);
    }
    chave = derivar(bruto);
    return chave;
  }

  const assina = (corpo) => crypto.createHmac('sha256', carregaChave().mac).update(corpo).digest('base64url');

  /** Identificador da sessão para uso no token: derivado da chave do mapa de sessões, truncado em 16 bytes. */
  function idDaSessao(chaveDoMapa) {
    return crypto.createHmac('sha256', carregaChave().id).update(String(chaveDoMapa)).digest().subarray(0, 16).toString('base64url');
  }

  /** `sessaoExpiraMs` é a expiração da sessão (epoch ms); o token vale no máximo 12 h e nunca mais que a sessão. */
  function emitir({ slug, id, sessaoExpiraMs }) {
    const agoraS = Math.floor(relogio() / 1000);
    const e = Math.min(Math.floor(sessaoExpiraMs / 1000), agoraS + VIDA_MAX_S);
    const corpo = Buffer.from(JSON.stringify({ s: slug, i: id, e }), 'utf8').toString('base64url');
    return { token: `${corpo}.${assina(corpo)}`, expira: e };
  }

  /** { ok:true, slug, id, expira } ou { ok:false, motivo }. Lança só se a chave estiver ilegível ou corrompida. */
  function verificar(token) {
    if (typeof token !== 'string' || token.length > TAM_MAX_TOKEN || !RX_TOKEN.test(token)) return { ok: false, motivo: 'O endereço do painel está malformado.' };
    const [corpo, mac] = token.split('.');
    const esperado = Buffer.from(assina(corpo));
    const recebido = Buffer.from(mac);
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return { ok: false, motivo: 'O endereço do painel não é válido.' };
    let dados;
    try { dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch (_) { return { ok: false, motivo: 'O endereço do painel não é válido.' }; }
    if (!dados || typeof dados.s !== 'string' || typeof dados.i !== 'string' || !Number.isInteger(dados.e)) return { ok: false, motivo: 'O endereço do painel não é válido.' };
    if (dados.e <= Math.floor(relogio() / 1000)) return { ok: false, motivo: 'O acesso deste painel expirou.' };
    return { ok: true, slug: dados.s, id: dados.i, expira: dados.e };
  }

  return { idDaSessao, emitir, verificar };
}

module.exports = { criarPainelToken, VIDA_MAX_S };
