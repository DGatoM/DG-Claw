#!/usr/bin/env node
'use strict';
// O login único (SSO) pela linha de comando, no servidor (host). É o que "dgclaw sso" chama.
//
//   node web/bin/sso.js configurar --provedor google|microsoft|oidc --client-id ID [--emissor URL] [--tenant GUID]
//                                  [--dominios a.com,b.com] [--nome "texto do botão"] [--redirect-uri URL] [--dominio painel.empresa.com.br]
//                                  (--segredo-stdin | --segredo-arquivo F | --manter-segredo)
//   node web/bin/sso.js testar [--dominio painel.empresa.com.br]
//   node web/bin/sso.js emergencia <usuario> | --remover <usuario>
//   node web/bin/sso.js status [--json]
//
// O segredo do aplicativo entra SEMPRE pelo stdin ou por arquivo, nunca por argumento (argumento aparece em `ps`).
// Saída: 0 deu certo, 1 recusa ou problema (o motivo vem escrito), 2 uso errado.
// Lê DGCLAW_WEB_ENV, DGCLAW_PROTECOES, DGCLAW_AUDITORIA e DGCLAW_WEB_DATA, como o servidor.

const fs = require('node:fs');
const path = require('node:path');
const { carregaConfig } = require('../lib/config');
const { criarProtecoes } = require('../lib/protecoes');
const { criarAuditoria } = require('../lib/auditoria');
const corrente = require('../lib/auditoria-corrente');
const sso = require('../lib/sso-config');
const { criarOidc, ErroOidc } = require('../lib/sso-oidc');
const { criarArquivoUsuarios, ErroUsuarios, chave } = require('../lib/usuarios-arquivo');

const USO = [
  'Uso:',
  '  sso configurar --provedor google|microsoft|oidc --client-id ID [--emissor URL] [--tenant GUID] [--dominios a.com,b.com]',
  '                 [--nome "texto do botão"] [--redirect-uri URL] [--dominio painel.empresa.com.br]',
  '                 (--segredo-stdin | --segredo-arquivo arq | --manter-segredo)',
  '  sso testar [--dominio painel.empresa.com.br]',
  '  sso emergencia <usuario>            marca a conta de emergência do TI (senha + 2FA, mesmo com o SSO obrigatório)',
  '  sso emergencia --remover <usuario>  tira a marca',
  '  sso status [--json]',
].join('\n');

const usoErrado = (msg) => { process.stderr.write(`${msg}\n\n${USO}\n`); return 2; };
const recusa = (msg, fazer) => { process.stderr.write(`Nao deu certo: ${msg}\nO que fazer: ${fazer || 'leia a mensagem acima e repita o comando.'}\n`); return 1; };

const COM_VALOR = new Set(['provedor', 'client-id', 'emissor', 'tenant', 'dominios', 'nome', 'redirect-uri', 'dominio', 'segredo-arquivo']);
const SEM_VALOR = new Set(['segredo-stdin', 'manter-segredo', 'remover', 'json']);

function lerArgumentos(argv) {
  const pos = []; const op = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const nome = a.slice(2);
      if (SEM_VALOR.has(nome)) op[nome] = true;
      else if (COM_VALOR.has(nome)) {
        if (i + 1 >= argv.length) return { erro: `Faltou o valor depois de ${a}.` };
        op[nome] = argv[i + 1]; i += 1;
      } else return { erro: `Não conheço a opção ${a}.` };
    } else pos.push(a);
  }
  return { pos, op };
}

function contexto() {
  const log = (nivel, msg) => { if (nivel === 'erro' || nivel === 'aviso') process.stderr.write(`[${nivel}] ${msg}\n`); };
  const config = carregaConfig({}, log);
  const protecoes = criarProtecoes({ caminho: config.protecoesPath, log });
  const quem = process.env.DGCLAW_QUEM || process.env.SUDO_USER || process.env.USER || 'desconhecido';
  return {
    config, protecoes, log, quem, caminhoSso: sso.caminhoDoSso(config.protecoesPath),
    auditoria: criarAuditoria({ caminho: config.auditoriaPath, protecoes, log }),
  };
}

function auditar(ctx, evento, dados) {
  try { ctx.auditoria.registrar(evento, dados, ctx.quem, 'cli'); } catch (e) {
    process.stderr.write(`aviso: a ação foi feita, mas não ficou registrada na auditoria (${e.message}).\n`);
  }
}

const enderecoDeRetorno = (op, cfg) => (cfg && cfg.redirect_uri) || (op.dominio ? `https://${op.dominio}/sso/retorno` : 'https://<o-dominio-do-painel>/sso/retorno');

function configurar(ctx, op) {
  let atual = null;
  try { atual = sso.ler(ctx.caminhoSso, { log: ctx.log }); } catch (e) {
    if (!(e instanceof sso.ErroSso)) throw e;
    if (op['manter-segredo']) return recusa(e.message, 'o arquivo atual não vale; informe o segredo de novo com --segredo-stdin.');
  }
  let segredo = '';
  if (op['segredo-stdin']) {
    if (process.stdin.isTTY) return usoErrado('O segredo precisa vir pelo stdin, e aqui o stdin é o teclado (ele ficaria na tela). Use: printf %s "$SEGREDO" | dgclaw sso configurar ... --segredo-stdin');
    segredo = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
  } else if (op['segredo-arquivo']) {
    try { segredo = fs.readFileSync(op['segredo-arquivo'], 'utf8').replace(/[\r\n]+$/, ''); } catch (e) { return recusa(`não consegui ler o arquivo do segredo (${e.code || e.message}).`, 'confira o caminho e a permissão do arquivo.'); }
  } else if (op['manter-segredo']) {
    if (!atual) return recusa('não há sso.json anterior de onde manter o segredo.', 'informe o segredo com --segredo-stdin.');
    segredo = atual.client_secret;
  } else return usoErrado('Faltou o segredo do aplicativo: --segredo-stdin, --segredo-arquivo ou --manter-segredo.');

  const novo = {
    provedor: op.provedor, client_id: op['client-id'], client_secret: segredo,
    dominios_permitidos: op.dominios ? op.dominios.split(',').map((d) => d.trim()).filter(Boolean) : [],
  };
  if (op.emissor) novo.emissor = op.emissor;
  if (op.tenant) novo.tenant = op.tenant;
  if (op.nome) novo.nome = op.nome;
  if (op['redirect-uri']) novo.redirect_uri = op['redirect-uri'];
  let gravado;
  try { gravado = sso.gravar(ctx.caminhoSso, novo); } catch (e) {
    if (e instanceof sso.ErroSso) return recusa(e.message, 'corrija a opção indicada e repita o comando.');
    return recusa(`não consegui gravar ${ctx.caminhoSso} (${e.message}).`, 'confira a permissão da pasta /etc/dgclaw (só o root escreve ali).');
  }
  process.stdout.write([
    `Login único configurado em ${ctx.caminhoSso} (modo 600): ${gravado.provedor}, aplicativo ${gravado.client_id}.`,
    `No provedor, cadastre este endereço de retorno (redirect URI): ${enderecoDeRetorno(op, gravado)}`,
    `Próximos passos: dgclaw sso testar  e  dgclaw nivel ajustar sso opcional|padrao|obrigatorio (o nível atual é ${ctx.protecoes.nivel()}, com sso = ${ctx.protecoes.valor('sso')}).`,
    gravado.provedor === 'oidc' ? '' : 'Lembre: o login por SSO conta como segundo fator feito pelo provedor. Exija MFA no próprio provedor da empresa.',
  ].filter(Boolean).join('\n') + '\n');
  auditar(ctx, 'sso_configurado', { provedor: gravado.provedor, emissor: gravado.emissor_efetivo, client_id: gravado.client_id, dominios: gravado.dominios_permitidos });
  return 0;
}

async function testar(ctx, op) {
  let cfg;
  try { cfg = sso.ler(ctx.caminhoSso, { log: ctx.log }); } catch (e) {
    if (e instanceof sso.ErroSso) return recusa(e.message, 'refaça a configuração com: dgclaw sso configurar');
    throw e;
  }
  if (!cfg) return recusa(`falta o arquivo ${ctx.caminhoSso}.`, 'configure com: dgclaw sso configurar');
  try {
    const r = await criarOidc({ log: ctx.log }).conferir(cfg);
    process.stdout.write([
      `Provedor respondeu: ${r.emissor}`,
      `  autorização: ${r.authorization_endpoint}`,
      `  troca de código: ${r.token_endpoint}`,
      `  chaves de assinatura (JWKS): ${r.chaves} em ${r.jwks_uri}`,
      `  algoritmos do id_token: ${r.algoritmos ? r.algoritmos.join(', ') : 'o provedor não anunciou (aceito RS256 e ES256)'}`,
      `Endereço de retorno a cadastrar no provedor: ${enderecoDeRetorno(op, cfg)}`,
      'O teste não faz login: confira o botão na tela de entrada com uma conta de teste.',
    ].join('\n') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof ErroOidc) return recusa(e.message, 'confira o emissor/tenant do sso.json e se esta máquina alcança o provedor (DNS, firewall, proxy de saída).');
    throw e;
  }
}

function emergencia(ctx, pos, op) {
  const nome = pos[1];
  if (!nome) return usoErrado('Faltou o usuário. Exemplo: dgclaw sso emergencia ana.ti');
  if (!ctx.protecoes.ligada('multiusuario')) return recusa('o multiusuário está desligado neste nível, então não há usuários nem conta de emergência.', 'use um nível com multiusuário (dgclaw nivel definir escritorio).');
  const arq = criarArquivoUsuarios({ dataDir: ctx.config.dataDir, log: ctx.log, semente: () => [] });
  let resultado;
  try {
    resultado = arq.atualizar((d) => {
      const u = d.usuarios.find((x) => chave(x.usuario) === chave(nome));
      if (!u) throw new ErroUsuarios(`não existe o usuário "${String(nome).slice(0, 40)}". Veja: dgclaw usuario listar`, 404);
      if (op.remover) {
        if (u.emergencia !== true) return { semMudanca: true, ja: true, usuario: u.usuario };
        delete u.emergencia;
        return { usuario: u.usuario };
      }
      if (u.papel !== 'ti') throw new ErroUsuarios(`"${u.usuario}" é funcionário. A conta de emergência precisa ser do TI.`, 409);
      if (u.desativado_em) throw new ErroUsuarios(`"${u.usuario}" está desativado. Reative antes de marcar como emergência.`, 409);
      const outra = d.usuarios.find((x) => x.emergencia === true && x.usuario !== u.usuario);
      if (outra) throw new ErroUsuarios(`já existe uma conta de emergência ("${outra.usuario}"). Só uma por instalação: tire a marca dela com: dgclaw sso emergencia --remover ${outra.usuario}`, 409);
      if (u.emergencia === true) return { semMudanca: true, ja: true, usuario: u.usuario };
      u.emergencia = true;
      return { usuario: u.usuario };
    });
  } catch (e) {
    if (e instanceof ErroUsuarios) return recusa(e.message);
    throw e;
  }
  if (resultado.ja) { process.stdout.write(op.remover ? `"${resultado.usuario}" não era a conta de emergência. Nada mudou.\n` : `"${resultado.usuario}" já é a conta de emergência. Nada mudou.\n`); return 0; }
  if (op.remover) {
    process.stdout.write(`"${resultado.usuario}" deixou de ser a conta de emergência.\n`);
    auditar(ctx, 'sso_emergencia_removida', { usuario: resultado.usuario });
    return 0;
  }
  process.stdout.write(`"${resultado.usuario}" agora é a conta de emergência: com o SSO obrigatório, só ela entra com senha, e sempre com segundo fator. Cada uso fica registrado em destaque na auditoria e o "dgclaw status" avisa.\n`);
  auditar(ctx, 'sso_emergencia_definida', { usuario: resultado.usuario });
  return 0;
}

/** Quando a conta de emergência entrou pela última vez (login_ok) dentro dos últimos `dias` dias. */
function usoRecenteDaEmergencia(ctx, usuario, dias) {
  const desde = Date.now() - dias * 86400000;
  let ultimo = null;
  for (const e of corrente.lerEventos(ctx.config.auditoriaPath, {})) {
    if (e.obj.evento === 'login_ok' && e.obj.quem === usuario && Date.parse(e.obj.ts) >= desde) ultimo = e.obj.ts;
  }
  return ultimo;
}

function status(ctx, op) {
  const modo = ctx.protecoes.valor('sso');
  const saida = { modo, configurado: false, provedor: null, emergencia: null, emergencia_usada_em: null, avisos: [] };
  let cfg = null;
  try { cfg = sso.ler(ctx.caminhoSso, { log: ctx.log }); } catch (e) {
    if (!(e instanceof sso.ErroSso)) throw e;
    saida.avisos.push(e.message);
  }
  if (cfg) { saida.configurado = true; saida.provedor = cfg.provedor; saida.emissor = cfg.emissor_efetivo; }
  if (modo !== 'nao' && !cfg && !saida.avisos.length) saida.avisos.push(`o SSO está em "${modo}", mas falta ${ctx.caminhoSso}. Configure com: dgclaw sso configurar`);
  if (ctx.protecoes.ligada('multiusuario')) {
    const arq = path.join(ctx.config.dataDir, 'usuarios.json');
    if (fs.existsSync(arq)) {
      let lista = [];
      try { lista = criarArquivoUsuarios({ dataDir: ctx.config.dataDir, log: ctx.log, semente: () => [] }).lista(); } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        saida.avisos.push(e.message);
      }
      const em = lista.find((u) => u.emergencia === true && !u.desativado_em);
      if (em) {
        saida.emergencia = em.usuario;
        try { saida.emergencia_usada_em = usoRecenteDaEmergencia(ctx, em.usuario, 30); } catch (e) { saida.avisos.push(`não consegui ler a auditoria para ver o uso da conta de emergência (${e.message})`); }
        if (saida.emergencia_usada_em) saida.avisos.push(`a conta de emergência "${em.usuario}" foi usada em ${saida.emergencia_usada_em} (últimos 30 dias). Confira na auditoria se era esperado.`);
      } else if (modo === 'obrigatorio') {
        saida.avisos.push('o SSO é obrigatório e não há conta de emergência: se o provedor cair, ninguém entra. Marque uma com: dgclaw sso emergencia <usuario-ti>');
      }
    }
  }
  if (op.json) { process.stdout.write(`${JSON.stringify(saida)}\n`); return 0; }
  const linhas = [`SSO: modo ${modo}${cfg ? `, provedor ${saida.provedor}` : ', sem configuração'}.`];
  linhas.push(saida.emergencia ? `Conta de emergência: ${saida.emergencia}.` : 'Conta de emergência: nenhuma.');
  for (const a of saida.avisos) linhas.push(`AVISO: ${a}`);
  process.stdout.write(`${linhas.join('\n')}\n`);
  return 0;
}

async function main(argv) {
  const r = lerArgumentos(argv);
  if (r.erro) return usoErrado(r.erro);
  const { pos, op } = r;
  const comando = pos[0];
  if (!['configurar', 'testar', 'emergencia', 'status'].includes(comando)) return usoErrado(comando ? `Não conheço o comando "${comando}".` : 'Faltou o comando.');
  const ctx = contexto();
  if (comando === 'configurar') {
    if (!op.provedor) return usoErrado('Faltou --provedor google, microsoft ou oidc.');
    if (!op['client-id']) return usoErrado('Faltou --client-id (o identificador do aplicativo registrado no provedor).');
    return configurar(ctx, op);
  }
  if (comando === 'testar') return testar(ctx, op);
  if (comando === 'emergencia') {
    // aceita "emergencia --remover ana" e "emergencia ana --remover": o nome é o primeiro argumento solto
    return emergencia(ctx, [pos[0], pos[1]], op);
  }
  return status(ctx, op);
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }).catch((e) => {
    process.stderr.write(`O comando quebrou: ${e && e.message}. O segredo não foi impresso; veja o registro do servidor.\n`);
    process.exitCode = 1;
  });
}
