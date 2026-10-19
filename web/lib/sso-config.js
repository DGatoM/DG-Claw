'use strict';
// Configuração do login único (SSO): /etc/dgclaw/sso.json (600, root). Quem lê é o Web (web/lib/ent/sso.js) e a CLI
// (web/bin/sso.js, chamada por `dgclaw sso`). O client_secret fica aqui e só aqui: nunca em log, em argv ou na resposta de API.
//
// Forma: { provedor: 'google' | 'microsoft' | 'oidc', emissor, client_id, client_secret, dominios_permitidos: [],
//          tenant, nome, redirect_uri }
//   google     emissor fixo (https://accounts.google.com); exige dominios_permitidos (confere o `hd` do token)
//   microsoft  emissor vem do `tenant` (id do diretório, um GUID); `common` e `organizations` não servem porque o
//              emissor do token muda de uma empresa para outra e não dá para conferir
//   oidc       qualquer provedor OIDC (Keycloak, Okta, Auth0...): `emissor` obrigatório
//   nome       texto do botão ("Entrar com <nome>"); padrão pelo provedor
//   redirect_uri  endereço de retorno fixo; sem ele vale a origem do pedido + /sso/retorno

const fs = require('node:fs');
const path = require('node:path');
const { gravaArquivoSeguro } = require('./grava-seguro');

const PROVEDORES = ['google', 'microsoft', 'oidc'];
const NOMES = { google: 'Google', microsoft: 'Microsoft', oidc: 'a conta da empresa' };
const EMISSOR_GOOGLE = 'https://accounts.google.com';
const RX_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RX_DOMINIO = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class ErroSso extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroSso';
  }
}

/** Onde fica o sso.json: ao lado do protecoes.json (mesma pasta de configuração), ou em DGCLAW_SSO. */
function caminhoDoSso(protecoesPath, env) {
  const e = env || process.env;
  return e.DGCLAW_SSO || path.join(path.dirname(protecoesPath || '/etc/dgclaw/protecoes.json'), 'sso.json');
}

function ehUrlSegura(u, aceitaLoopback) {
  let x;
  try { x = new URL(u); } catch (_) { return false; }
  if (x.protocol === 'https:') return true;
  return aceitaLoopback && x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
}

/** O emissor que o provedor tem de anunciar e que o token tem de trazer em `iss`. */
function emissorEfetivo(cfg) {
  if (cfg.provedor === 'google') return EMISSOR_GOOGLE;
  if (cfg.provedor === 'microsoft') return `https://login.microsoftonline.com/${cfg.tenant}/v2.0`;
  return cfg.emissor.replace(/\/+$/, '');
}

/**
 * Valida e normaliza. Lança ErroSso com o que está errado e o que fazer.
 * opcoes.aceitaLoopback: http://127.0.0.1 vale como emissor (só os testes e laboratórios usam).
 */
function validar(bruto, opcoes) {
  const o = opcoes || {};
  const cfg = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : null;
  if (!cfg) throw new ErroSso('O sso.json precisa ser um objeto JSON com provedor, client_id e client_secret. Refaça com: dgclaw sso configurar');
  const provedor = String(cfg.provedor || '').toLowerCase();
  if (!PROVEDORES.includes(provedor)) throw new ErroSso(`O provedor ${JSON.stringify(String(cfg.provedor || '').slice(0, 30))} não existe. Use ${PROVEDORES.join(', ')}.`);
  const clientId = String(cfg.client_id || '').trim();
  if (!clientId) throw new ErroSso('Falta o client_id (o identificador do aplicativo que você registrou no provedor).');
  const segredo = String(cfg.client_secret || '').trim();
  if (!segredo) throw new ErroSso('Falta o client_secret (o segredo do aplicativo registrado no provedor). Mande-o pelo stdin: printf %s "$SEGREDO" | dgclaw sso configurar ... --segredo-stdin');

  const dominiosBrutos = cfg.dominios_permitidos == null ? [] : cfg.dominios_permitidos;
  if (!Array.isArray(dominiosBrutos)) throw new ErroSso('dominios_permitidos precisa ser uma lista, como ["empresa.com.br"].');
  const dominios = [...new Set(dominiosBrutos.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')))];
  for (const d of dominios) {
    if (!RX_DOMINIO.test(d)) throw new ErroSso(`O domínio ${JSON.stringify(d.slice(0, 60))} não parece certo. Use só o domínio do e-mail, como empresa.com.br.`);
  }

  const saida = { provedor, client_id: clientId, client_secret: segredo, dominios_permitidos: dominios };
  if (provedor === 'google') {
    if (!dominios.length) throw new ErroSso('No Google Workspace o domínio da empresa é obrigatório (dominios_permitidos). Sem ele, qualquer conta Gmail comum passaria no primeiro filtro. Exemplo: --dominios empresa.com.br');
  } else if (provedor === 'microsoft') {
    const tenant = String(cfg.tenant || '').trim();
    if (!RX_GUID.test(tenant)) throw new ErroSso(`O tenant da Microsoft precisa ser o ID do diretório (um GUID como 11111111-2222-3333-4444-555555555555), e veio ${JSON.stringify(tenant.slice(0, 60))}. "common" e "organizations" não servem, porque o emissor do token muda de empresa para empresa. Você acha o ID em Microsoft Entra, Visão geral.`);
    saida.tenant = tenant.toLowerCase();
  } else {
    const emissor = String(cfg.emissor || '').trim();
    if (!emissor) throw new ErroSso('Falta o emissor (issuer) do provedor OIDC, o endereço base que tem /.well-known/openid-configuration. Exemplo: --emissor https://login.empresa.com/realms/principal');
    if (!ehUrlSegura(emissor, o.aceitaLoopback)) throw new ErroSso(`O emissor ${JSON.stringify(emissor.slice(0, 120))} precisa ser um endereço https://.`);
    saida.emissor = emissor.replace(/\/+$/, '');
  }
  if (cfg.nome != null && String(cfg.nome).trim()) saida.nome = String(cfg.nome).trim().slice(0, 40);
  if (cfg.redirect_uri != null && String(cfg.redirect_uri).trim()) {
    const r = String(cfg.redirect_uri).trim();
    if (!ehUrlSegura(r, o.aceitaLoopback) || !/\/sso\/retorno$/.test(new URL(r).pathname)) {
      throw new ErroSso(`O redirect_uri ${JSON.stringify(r.slice(0, 120))} precisa ser https:// e terminar em /sso/retorno, como https://painel.empresa.com.br/sso/retorno.`);
    }
    saida.redirect_uri = r;
  }
  saida.emissor_efetivo = emissorEfetivo(saida);
  return saida;
}

/** Lê o sso.json. null se não existe. Lança ErroSso se existe e não vale. */
function ler(caminho, opcoes) {
  const log = (opcoes && opcoes.log) || (() => {});
  let st;
  try { st = fs.statSync(caminho); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ErroSso(`Não consegui ler ${caminho} (${e.code || e.message}). Confira a permissão do arquivo e da pasta.`);
  }
  if (st.mode & 0o077) log('aviso', `${caminho} está com modo ${(st.mode & 0o777).toString(8)} e guarda o segredo do login único. Rode: chmod 600 ${caminho}`);
  let j;
  try { j = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (e) {
    throw new ErroSso(`${caminho} não é um JSON válido (${e.message}). Refaça com: dgclaw sso configurar`);
  }
  try { return validar(j, opcoes); } catch (e) {
    if (e instanceof ErroSso) throw new ErroSso(`${caminho}: ${e.message}`);
    throw e;
  }
}

/** Grava o sso.json (600) depois de validar. O segredo nunca entra na mensagem de erro. */
function gravar(caminho, bruto, opcoes) {
  const cfg = validar(bruto, opcoes);
  const { emissor_efetivo: _derivado, ...paraDisco } = cfg;
  gravaArquivoSeguro(caminho, `${JSON.stringify(paraDisco, null, 2)}\n`, { raiz: path.dirname(caminho), modo: 0o600 });
  return cfg;
}

/** Nome para o botão: "Entrar com Google", "Entrar com Microsoft", "Entrar com a conta da empresa". */
const nomeDoProvedor = (cfg) => cfg.nome || NOMES[cfg.provedor];

module.exports = { ErroSso, PROVEDORES, caminhoDoSso, emissorEfetivo, validar, ler, gravar, nomeDoProvedor };
