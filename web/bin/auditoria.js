#!/usr/bin/env node
'use strict';
// A trilha de auditoria pela linha de comando, no servidor (host). É o que "dgclaw auditoria" chama.
//
//   node web/bin/auditoria.js verificar [--json]
//   node web/bin/auditoria.js selo [--json]
//   node web/bin/auditoria.js exportar [--de AAAA-MM-DD] [--ate AAAA-MM-DD] [--formato jsonl|csv] [--evento X] [--quem Y]
//                                      [--origem O] [--q texto] [--saida arquivo]
//   node web/bin/auditoria.js externa configurar --tipo http --url U [--token-stdin | --token-arquivo F] [--timeout-s N]
//   node web/bin/auditoria.js externa configurar --tipo syslog --host H [--porta 6514] [--ca arquivo.pem] [--timeout-s N]
//   node web/bin/auditoria.js externa testar | status [--json] | enviar
//   node web/bin/auditoria.js retencao mostrar | definir <dias> | aplicar [--confirmar]
//
// O token do coletor entra SEMPRE pelo stdin ou por arquivo, nunca por argumento (argumento aparece em `ps`).
// Saída: 0 deu certo, 1 recusa ou problema (o motivo vem escrito), 2 uso errado.
// Lê DGCLAW_WEB_ENV, DGCLAW_PROTECOES, DGCLAW_AUDITORIA e DGCLAW_WEB_DATA, como o servidor.

const fs = require('node:fs');
const path = require('node:path');
const { carregaConfig } = require('../lib/config');
const { criarProtecoes } = require('../lib/protecoes');
const { criarAuditoria } = require('../lib/auditoria');
const corrente = require('../lib/auditoria-corrente');
const ext = require('../lib/auditoria-externa');
const { gravaArquivoSeguro } = require('../lib/grava-seguro');

const USO = [
  'Uso:',
  '  auditoria verificar [--json]                 confere a corrente inteira e diz em que linha ela quebrou',
  '  auditoria selo [--json]                      o hash da última linha (o que o selo por hora leva)',
  '  auditoria exportar [--de AAAA-MM-DD] [--ate AAAA-MM-DD] [--formato jsonl|csv] [--evento X] [--quem Y] [--origem O] [--q texto] [--saida arquivo]',
  '  auditoria externa configurar --tipo http --url https://... [--token-stdin | --token-arquivo arq] [--timeout-s N]',
  '  auditoria externa configurar --tipo syslog --host logs.empresa.com [--porta 6514] [--ca arq.pem] [--timeout-s N]',
  '  auditoria externa testar | status [--json] | enviar',
  '  auditoria retencao mostrar | definir <dias> | aplicar [--confirmar]',
].join('\n');

const usoErrado = (msg) => { process.stderr.write(`${msg}\n\n${USO}\n`); return 2; };
const recusa = (msg, fazer) => { process.stderr.write(`Nao deu certo: ${msg}\nO que fazer: ${fazer || 'leia a mensagem acima e repita o comando.'}\n`); return 1; };

const COM_VALOR = new Set(['de', 'ate', 'formato', 'evento', 'quem', 'origem', 'q', 'saida', 'tipo', 'url', 'host', 'porta', 'ca', 'token-arquivo', 'timeout-s']);
const SEM_VALOR = new Set(['json', 'token-stdin', 'confirmar']);

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
  const auditoria = criarAuditoria({ caminho: config.auditoriaPath, protecoes, log });
  const externa = ext.criarExterna({
    base: config.auditoriaPath, dataDir: config.dataDir, log,
    caminhoConfig: path.join(path.dirname(config.protecoesPath), 'auditoria-externa.json'),
  });
  return { config, protecoes, auditoria, externa, log, quem, dirEtc: path.dirname(config.protecoesPath) };
}

function auditar(ctx, evento, dados) {
  try { ctx.auditoria.registrar(evento, dados, ctx.quem, 'cli'); } catch (e) {
    process.stderr.write(`aviso: a ação foi feita, mas não ficou registrada na auditoria (${e.message}).\n`);
  }
}

// ── verificar e selo ────────────────────────────────────────────────────
function verificar(ctx, op) {
  const base = ctx.config.auditoriaPath;
  const arquivos = corrente.arquivosDaCorrente(base);
  if (!arquivos.length) {
    const msg = ctx.protecoes.valor('auditoria') === 'nao' ? 'A auditoria está desligada neste nível; não há trilha para conferir.' : `Ainda não há trilha em ${base}.`;
    if (op.json) process.stdout.write(`${JSON.stringify({ ok: true, linhas: 0, arquivos: 0 })}\n`); else process.stdout.write(`${msg}\n`);
    return 0;
  }
  const r = corrente.verificar(base);
  if (op.json) { process.stdout.write(`${JSON.stringify(Object.assign({ arquivos: arquivos.length }, r))}\n`); return r.ok ? 0 : 1; }
  if (r.ok) {
    process.stdout.write(`Corrente íntegra: ${r.linhas} linha(s) em ${arquivos.length} arquivo(s). Nada foi alterado ou apagado no meio da trilha.\n`);
    return 0;
  }
  process.stderr.write(`Corrente QUEBRADA na linha ${r.quebradaEm} (${r.arquivo}, linha ${r.linhaNoArquivo}): ${r.motivo}.\n`
    + '  As linhas antes dela estão íntegras. Isto pode ser adulteração ou disco cortado no meio de uma escrita.\n'
    + `O que fazer: guarde uma cópia da pasta ${path.dirname(base)} antes de mexer em qualquer coisa, compare com o backup e com os selos que o destino externo guardou (dgclaw auditoria externa status). Veja docs/enterprise/SSO-AUDITORIA.md.\n`);
  return 1;
}

function selo(ctx, op) {
  const u = corrente.ultimoHash(ctx.config.auditoriaPath);
  if (!u) return recusa('a trilha ainda não tem nenhuma linha.', 'espere o primeiro evento (ou ligue a auditoria no nível: dgclaw nivel).');
  const v = corrente.verificar(ctx.config.auditoriaPath);
  if (op.json) process.stdout.write(`${JSON.stringify({ hash: u.hash, arquivo: u.arquivo, linhas: v.ok ? v.linhas : null, integra: v.ok })}\n`);
  else process.stdout.write(`${u.hash}  ${u.arquivo}${v.ok ? `  (${v.linhas} linhas, corrente íntegra)` : '  (ATENÇÃO: a corrente está quebrada; rode: dgclaw auditoria verificar)'}\n`);
  return 0;
}

// ── exportar ────────────────────────────────────────────────────────────
function exportar(ctx, op) {
  const filtro = {};
  for (const c of ['de', 'ate', 'evento', 'quem', 'origem', 'q']) if (op[c]) filtro[c] = op[c];
  const formato = op.formato || 'jsonl';
  let r;
  try { r = corrente.exportar(ctx.config.auditoriaPath, filtro, formato); } catch (e) {
    if (e.status === 400) return usoErrado(e.message);
    throw e;
  }
  if (op.saida) {
    const destino = path.resolve(op.saida);
    try { gravaArquivoSeguro(destino, r.corpo, { raiz: path.dirname(destino), modo: 0o600 }); } catch (e) {
      return recusa(`não consegui gravar ${destino} (${e.message}).`, 'escolha uma pasta que só o root altera, como /root/ ou /var/lib/dgclaw/.');
    }
    process.stderr.write(`${r.total} evento(s) exportado(s) para ${destino} (modo 600).\n`);
  } else {
    process.stdout.write(r.corpo);
    process.stderr.write(`${r.total} evento(s) exportado(s).\n`);
  }
  auditar(ctx, 'auditoria_exportada', { formato, filtros: filtro, total: r.total, via: 'cli', destino: op.saida ? path.resolve(op.saida) : 'stdout' });
  return 0;
}

// ── externa ─────────────────────────────────────────────────────────────
async function externa(ctx, pos, op) {
  const sub = pos[0];
  if (sub === 'configurar') {
    const tipo = String(op.tipo || '').toLowerCase();
    const cfg = { tipo };
    if (tipo === 'http') {
      cfg.url = op.url;
      let token = '';
      if (op['token-stdin']) {
        if (process.stdin.isTTY) return usoErrado('O token precisa vir pelo stdin, e aqui o stdin é o teclado (ele ficaria na tela). Use: printf %s "$TOKEN" | dgclaw auditoria externa configurar ... --token-stdin');
        token = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
      } else if (op['token-arquivo']) {
        try { token = fs.readFileSync(op['token-arquivo'], 'utf8').replace(/[\r\n]+$/, ''); } catch (e) { return recusa(`não consegui ler o arquivo do token (${e.code || e.message}).`, 'confira o caminho e a permissão do arquivo.'); }
      }
      if (token) cfg.token = token;
    } else if (tipo === 'syslog') {
      cfg.host = op.host;
      if (op.porta) cfg.porta = Number(op.porta);
      if (op.ca) cfg.ca = path.resolve(op.ca);
    } else return usoErrado(`Faltou --tipo http ou --tipo syslog (veio ${JSON.stringify(op.tipo || null)}).`);
    if (op['timeout-s']) cfg.timeout_s = Number(op['timeout-s']);
    const caminho = path.join(ctx.dirEtc, 'auditoria-externa.json');
    let gravado;
    try { gravado = ext.gravarConfig(caminho, cfg); } catch (e) {
      if (e instanceof ext.ErroExterna) return recusa(e.message, 'corrija a opção indicada e repita o comando.');
      return recusa(`não consegui gravar ${caminho} (${e.message}).`, 'confira a permissão da pasta /etc/dgclaw (só o root escreve ali).');
    }
    process.stdout.write(`Destino da auditoria externa gravado em ${caminho} (modo 600): ${ext.destinoPublico(gravado)}.\nProximo passo: dgclaw auditoria externa testar\n`);
    auditar(ctx, 'auditoria_externa_configurada', { tipo: gravado.tipo, destino: ext.destinoPublico(gravado), com_token: !!gravado.token });
    return 0;
  }
  if (sub === 'status') {
    const s = ctx.externa.status();
    if (op.json) { process.stdout.write(`${JSON.stringify(Object.assign({ nivel: ctx.protecoes.valor('auditoria') }, s))}\n`); return 0; }
    if (!s.configurado) { process.stdout.write(`Sem destino externo. ${s.erro_config || 'Configure com: dgclaw auditoria externa configurar'}\n`); return 0; }
    process.stdout.write([
      `Destino: ${s.tipo} ${s.destino}`,
      `Pendentes: ${s.pendentes == null ? 'não sei (corrente alterada)' : s.pendentes}${s.pendentes_desde ? ` desde ${s.pendentes_desde}` : ''}`,
      `Último envio ok: ${s.ultimo_envio_ok || 'nunca'}`,
      `Último selo: ${s.selo_em ? `${s.selo_em} (hash ${s.selo_hash})` : 'nunca'}`,
      s.ultimo_erro ? `Último erro: ${s.ultimo_erro}` : 'Último erro: nenhum',
      s.alerta ? 'SITUAÇÃO: ALERTA (a fila passou de 1 hora sem esvaziar, ou a corrente local mudou atrás do ponto entregue).' : 'Situação: em dia.',
    ].join('\n') + '\n');
    return s.alerta ? 1 : 0;
  }
  if (sub === 'testar') {
    try { const r = await ctx.externa.testar(); process.stdout.write(`Mensagem de teste entregue a ${r.destino}. Confira no destino que ela chegou.\n`); } catch (e) {
      if (e instanceof ext.ErroExterna) return recusa(e.message, 'corrija o destino com: dgclaw auditoria externa configurar');
      throw e;
    }
    return 0;
  }
  if (sub === 'enviar') {
    const r = await ctx.externa.enviar();
    if (r.erro) return recusa(r.erro, 'o que está pendente continua guardado na trilha local e sai na próxima tentativa. Confira o destino com: dgclaw auditoria externa testar');
    process.stdout.write(`${r.enviadas} linha(s) entregue(s)${r.selo ? ' e o selo da hora' : ''}.\n`);
    return 0;
  }
  return usoErrado('Use: externa configurar | testar | status | enviar');
}

// ── retenção ────────────────────────────────────────────────────────────
function lerRetencao(ctx) {
  const arq = path.join(ctx.dirEtc, 'auditoria.json');
  try {
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    if (!Number.isInteger(j.retencao_dias) || j.retencao_dias < corrente.RETENCAO_MIN_DIAS) throw new Error(`retencao_dias precisa ser um número inteiro de ${corrente.RETENCAO_MIN_DIAS} ou mais`);
    return { dias: j.retencao_dias, arquivo: arq, definida: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { dias: corrente.RETENCAO_PADRAO_DIAS, arquivo: arq, definida: false };
    throw new Error(`${arq} não vale (${e.message}). Corrija com: dgclaw auditoria retencao definir <dias>`);
  }
}

function retencao(ctx, pos, op) {
  const sub = pos[0];
  const base = ctx.config.auditoriaPath;
  let r;
  try { r = lerRetencao(ctx); } catch (e) { return recusa(e.message); }
  if (sub === 'mostrar') {
    process.stdout.write(`Retenção da auditoria: ${r.dias} dias (${(r.dias / 365).toFixed(1)} anos)${r.definida ? '' : ', o padrão'}.\n`
      + 'Ela é separada da retencao_dias do nível (que vale para conversas e logs): a trilha é prova de conformidade e fica 5 anos por padrão.\n');
    return 0;
  }
  if (sub === 'definir') {
    const dias = Number(pos[1]);
    if (!Number.isInteger(dias) || dias < corrente.RETENCAO_MIN_DIAS) return recusa(`${JSON.stringify(pos[1] || null)} não serve: a retenção da auditoria é de no mínimo ${corrente.RETENCAO_MIN_DIAS} dias.`, `use: dgclaw auditoria retencao definir ${corrente.RETENCAO_PADRAO_DIAS}`);
    try { gravaArquivoSeguro(r.arquivo, `${JSON.stringify({ retencao_dias: dias }, null, 2)}\n`, { raiz: ctx.dirEtc, modo: 0o600 }); } catch (e) { return recusa(`não consegui gravar ${r.arquivo} (${e.message}).`, 'confira a permissão de /etc/dgclaw.'); }
    process.stdout.write(`Retenção da auditoria: ${dias} dias.\n`);
    auditar(ctx, 'auditoria_retencao_definida', { de: r.dias, para: dias });
    return 0;
  }
  if (sub === 'aplicar') {
    const agora = Date.now();
    const candidatos = [];
    for (const a of corrente.arquivosDaCorrente(base)) {
      if (!a.mes) break;   // o arquivo vivo nunca é podado
      const [ano, mes] = a.mes.split('-').map(Number);
      if (Date.UTC(ano, mes, 1) + r.dias * 86400000 < agora) candidatos.push(a); else break;   // só a ponta mais antiga, sem buracos
    }
    if (!candidatos.length) { process.stdout.write(`Nada a apagar: nenhum mês fechado passou de ${r.dias} dias.\n`); return 0; }
    process.stdout.write(`Meses que passaram de ${r.dias} dias: ${candidatos.map((a) => a.mes).join(', ')}.\n`);
    if (!op.confirmar) {
      process.stdout.write('Nada foi apagado. Exporte esses meses para o arquivo morto da empresa (dgclaw auditoria exportar --de ... --ate ...) e repita com --confirmar.\n');
      return 0;
    }
    const ultimoArquivo = candidatos[candidatos.length - 1];
    const linha = corrente.ultimaLinha(ultimoArquivo.caminho);
    const m = corrente.RX_HASH.exec(linha);
    if (!m) return recusa(`a última linha de ${ultimoArquivo.nome} não tem hash; não vou apagar sem poder registrar onde a corrente continua.`, 'rode: dgclaw auditoria verificar');
    const ok = corrente.verificar(base);
    if (!ok.ok) return recusa(`a corrente está quebrada (linha ${ok.quebradaEm}); apagar meses agora esconderia o problema.`, 'resolva a quebra antes (dgclaw auditoria verificar) e repita.');
    const marca = path.join(path.dirname(base), 'auditoria-poda.json');
    gravaArquivoSeguro(marca, `${JSON.stringify({ ate_hash: m[1], ate_mes: ultimoArquivo.mes, podada_em: new Date(agora).toISOString(), retencao_dias: r.dias }, null, 2)}\n`, { raiz: path.dirname(base), modo: 0o600 });
    for (const a of candidatos) fs.unlinkSync(a.caminho);
    process.stdout.write(`${candidatos.length} mês(es) apagado(s). A conferência passa a começar do hash ${m[1].slice(0, 16)}… (auditoria-poda.json).\n`);
    auditar(ctx, 'auditoria_podada', { meses: candidatos.map((a) => a.mes), ate_hash: m[1], retencao_dias: r.dias });
    return 0;
  }
  return usoErrado('Use: retencao mostrar | definir <dias> | aplicar [--confirmar]');
}

async function main(argv) {
  const r = lerArgumentos(argv);
  if (r.erro) return usoErrado(r.erro);
  const { pos, op } = r;
  const comando = pos[0];
  if (!['verificar', 'selo', 'exportar', 'externa', 'retencao'].includes(comando)) return usoErrado(comando ? `Não conheço o comando "${comando}".` : 'Faltou o comando.');
  const ctx = contexto();
  if (comando === 'verificar') return verificar(ctx, op);
  if (comando === 'selo') return selo(ctx, op);
  if (comando === 'exportar') return exportar(ctx, op);
  if (comando === 'externa') return externa(ctx, pos.slice(1), op);
  return retencao(ctx, pos.slice(1), op);
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }).catch((e) => {
    process.stderr.write(`O comando quebrou: ${e && e.message}. Nada foi alterado na trilha; veja o registro do servidor.\n`);
    process.exitCode = 1;
  });
}
