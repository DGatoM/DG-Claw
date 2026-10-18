#!/usr/bin/env node
'use strict';
// Lado Node do `dgclaw saida`: edita a lista de cada agente e monta o relatório do registro.
// A CLI em bash (lib/enterprise/saida.sh) sincroniza o geral.json antes de chamar e cuida de auditoria e firewall.
//
// Uso: node cli.js <acao> --etc <dir> --log <dir> --base <arquivo> [--dias N] [--json] <slug> [dominio|modo]
//   acoes: mostrar | permitir | remover | modo | relatorio
// Erros saem em stderr no formato "Nao deu certo: ... / O que fazer: ..." com código 1.

const fs = require('node:fs');
const path = require('node:path');
const { MODOS, SLUG_RX, modoMaisForte, validarEntrada, casa } = require('./lista');

class Falha extends Error {
  constructor(oque, fazer) { super(oque); this.fazer = fazer; }
}

function lerJsonOu(arq, padrao) {
  let txt;
  try { txt = fs.readFileSync(arq, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return padrao;
    throw new Falha(`não consegui ler ${arq} (${e.code}).`, 'rode como root (sudo) ou confira a permissão do arquivo.');
  }
  try { return JSON.parse(txt); } catch (e) {
    throw new Falha(`${arq} não é um JSON válido (${e.message}).`, `corrija o arquivo à mão ou apague-o (a lista do agente volta a ficar vazia) e rode de novo.`);
  }
}

function gravarAtomico(arq, obj) {
  fs.mkdirSync(path.dirname(arq), { recursive: true, mode: 0o750 });
  const tmp = `${arq}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(tmp, arq);
}

function parseArgs(argv) {
  const o = { pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.flags.json = true;
    else if (['--etc', '--log', '--base', '--dias'].includes(a)) {
      if (i + 1 >= argv.length) throw new Falha(`faltou o valor depois de ${a}.`, 'veja: dgclaw saida');
      o.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Falha(`a opção ${a} não existe.`, 'veja as opções com: dgclaw saida');
    else o.pos.push(a);
  }
  return o;
}

function contexto(o) {
  const etc = o.flags.etc;
  if (!etc) throw new Falha('faltou --etc.', 'isto é um erro do DG Claw: o dgclaw saida deve passar --etc. Avise quem mantém o DG Claw.');
  const geral = lerJsonOu(path.join(etc, 'saida', 'geral.json'), null);
  return { etc, dir: path.join(etc, 'saida'), logDir: o.flags.log, base: lerJsonOu(o.flags.base || '', {}), geral };
}

function exigirAgente(ctx, slug) {
  if (!slug || !SLUG_RX.test(slug)) throw new Falha(`o nome de agente "${String(slug || '').slice(0, 40)}" não é válido.`, 'use o nome curto do agente, como no dgclaw agente listar.');
  if (!ctx.geral || !ctx.geral.agentes || !ctx.geral.agentes[slug]) {
    throw new Falha(`não conheço o agente "${slug}" na saída controlada.`, 'confira os nomes com: dgclaw agente listar. Se o agente é novo, rode: dgclaw saida sincronizar');
  }
}

function arqAgente(ctx, slug) { return path.join(ctx.dir, `${slug}.json`); }

function lerAgente(ctx, slug) {
  const v = lerJsonOu(arqAgente(ctx, slug), {});
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Falha(`${arqAgente(ctx, slug)} não é um objeto JSON.`, 'apague o arquivo e refaça a lista com dgclaw saida permitir.');
  return { modo: v.modo, permitidos: Array.isArray(v.permitidos) ? v.permitidos : [] };
}

function salvarAgente(ctx, slug, ag) {
  const obj = {};
  if (ag.modo) obj.modo = ag.modo;
  obj.permitidos = [...new Set(ag.permitidos)].sort();
  gravarAtomico(arqAgente(ctx, slug), obj);
}

function modoEfetivo(ctx, ag) {
  const m = ctx.geral && MODOS.includes(ctx.geral.modo) ? ctx.geral.modo : 'livre';
  return m === 'livre' ? 'livre' : modoMaisForte(m, ag.modo);
}

function listaBase(ctx, slug) {
  const prov = ctx.geral.agentes[slug].provedor;
  return [...(ctx.base.comuns || []), ...(ctx.base[prov] || [])];
}

function acaoMostrar(ctx, slug, saida) {
  exigirAgente(ctx, slug);
  const ag = lerAgente(ctx, slug);
  const base = listaBase(ctx, slug);
  saida(`Agente ${slug} (${ctx.geral.agentes[slug].provedor})`);
  saida(`  modo da instalação: ${ctx.geral.modo}${ag.modo ? `; modo deste agente: ${ag.modo}` : ''}; vale: ${modoEfetivo(ctx, ag)}`);
  saida('  lista base do provedor (vem com o DG Claw, não se edita aqui):');
  for (const b of base) saida(`    ${b}`);
  saida(`  lista deste agente (${ag.permitidos.length}):`);
  for (const p of [...ag.permitidos].sort()) saida(`    ${p}`);
  if (ag.permitidos.length === 0) saida('    (vazia)');
  saida('  Para ver o que o agente tentou acessar: dgclaw saida relatorio ' + slug);
}

function acaoPermitir(ctx, slug, dominio, saida) {
  exigirAgente(ctx, slug);
  const v = validarEntrada(dominio);
  if (v.erro) throw new Falha(v.erro + '.', v.como + '.');
  const ag = lerAgente(ctx, slug);
  if (ag.permitidos.includes(v.valor)) { saida(`${v.valor} já estava na lista do agente ${slug}; nada mudou.`); return null; }
  ag.permitidos.push(v.valor);
  salvarAgente(ctx, slug, ag);
  saida(`${v.valor} liberado para o agente ${slug} (vale na hora).`);
  return v.valor;
}

function acaoRemover(ctx, slug, dominio, saida) {
  exigirAgente(ctx, slug);
  const v = validarEntrada(dominio);
  if (v.erro) throw new Falha(v.erro + '.', v.como + '.');
  const ag = lerAgente(ctx, slug);
  if (!ag.permitidos.includes(v.valor)) {
    const naBase = listaBase(ctx, slug).includes(v.valor);
    throw new Falha(`${v.valor} não está na lista do agente ${slug}${naBase ? ' (ele faz parte da lista base do provedor, que o agente precisa para funcionar e não se edita)' : ''}.`, 'veja a lista com: dgclaw saida mostrar ' + slug);
  }
  ag.permitidos = ag.permitidos.filter((x) => x !== v.valor);
  salvarAgente(ctx, slug, ag);
  saida(`${v.valor} saiu da lista do agente ${slug} (vale na hora).`);
  return v.valor;
}

function acaoModo(ctx, slug, modo, saida) {
  exigirAgente(ctx, slug);
  if (!MODOS.includes(modo)) throw new Falha(`o modo "${String(modo || '').slice(0, 30)}" não existe.`, `use um destes: ${MODOS.join(', ')}.`);
  if (!ctx.geral || ctx.geral.modo === 'livre') {
    throw new Falha('a saída está livre nesta instalação, então não há o que endurecer por agente.', 'suba o nível (dgclaw nivel definir escritorio) ou ligue a saída: dgclaw nivel ajustar saida registro');
  }
  if (MODOS.indexOf(modo) < MODOS.indexOf(ctx.geral.modo)) {
    throw new Falha(`o modo ${modo} é mais solto que o da instalação (${ctx.geral.modo}); um agente só pode ficar igual ou mais firme.`, 'escolha o mesmo modo da instalação ou um mais firme, ou mude a instalação inteira com dgclaw nivel ajustar saida <modo>.');
  }
  const ag = lerAgente(ctx, slug);
  const antes = modoEfetivo(ctx, ag);
  ag.modo = modo === ctx.geral.modo ? undefined : modo;
  salvarAgente(ctx, slug, ag);
  saida(`Agente ${slug}: modo ${antes} -> ${modo}.`);
  return { antes, depois: modo };
}

function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function acaoRelatorio(ctx, slug, dias, json, saida) {
  exigirAgente(ctx, slug);
  if (!ctx.logDir) throw new Falha('faltou --log.', 'isto é um erro do DG Claw: avise quem mantém o DG Claw.');
  const arq = path.join(ctx.logDir, `${slug}.jsonl`);
  let txt;
  try { txt = fs.readFileSync(arq, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') {
      saida(`Ainda não há registro de saída do agente ${slug} (${arq}). O proxy anota cada conexão assim que o agente usar a internet; se o modo é livre ou o serviço dgclaw-saida não está de pé, nada é anotado. Confira: systemctl status dgclaw-saida`);
      return;
    }
    throw new Falha(`não consegui ler ${arq} (${e.code}).`, 'rode como root (sudo).');
  }
  const corte = Date.now() - dias * 86400000;
  const entradas = [...listaBase(ctx, slug), ...lerAgente(ctx, slug).permitidos]
    .map((x) => validarEntrada(x).valor).filter(Boolean);
  const por = new Map();
  let ruins = 0;
  for (const l of txt.split('\n')) {
    if (!l) continue;
    let r;
    try { r = JSON.parse(l); } catch { ruins++; continue; }
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < corte || typeof r.host !== 'string') continue;
    const e = por.get(r.host) || { host: r.host, acessos: 0, permitidos: 0, recusados: 0, erros: 0, up: 0, down: 0 };
    e.acessos++;
    if (r.decisao === 'permitido') e.permitidos++;
    else if (r.decisao === 'recusado') e.recusados++;
    else e.erros++;
    e.up += r.bytes_up || 0;
    e.down += r.bytes_down || 0;
    por.set(r.host, e);
  }
  const linhas = [...por.values()].sort((a, b) => b.acessos - a.acessos || a.host.localeCompare(b.host))
    .map((e) => ({ ...e, na_lista: casa(entradas, e.host) }));
  if (json) { saida(JSON.stringify({ agente: slug, dias, destinos: linhas }, null, 2)); return; }
  saida(`Saída do agente ${slug} nos últimos ${dias} dia(s): ${linhas.length} destino(s)`);
  if (linhas.length === 0) saida('  (nenhuma conexão no período)');
  else {
    saida('  acessos  recusados  enviado     recebido    na lista  destino');
    for (const e of linhas) {
      saida(`  ${String(e.acessos).padStart(7)}  ${String(e.recusados).padStart(9)}  ${fmtBytes(e.up).padEnd(10)}  ${fmtBytes(e.down).padEnd(10)}  ${(e.na_lista ? 'sim' : 'nao').padEnd(8)}  ${e.host}`);
    }
    const fora = linhas.filter((e) => !e.na_lista).length;
    if (fora > 0) saida(`  ${fora} destino(s) fora da lista. Para liberar um: dgclaw saida permitir ${slug} <destino>`);
  }
  if (ruins > 0) saida(`  aviso: ${ruins} linha(s) do registro estavam ilegíveis e foram ignoradas.`);
}

function principal(argv) {
  const [acao, ...resto] = argv;
  const o = parseArgs(resto);
  const ctx = contexto(o);
  const saida = (t) => process.stdout.write(`${t}\n`);
  const [slug, arg] = o.pos;
  switch (acao) {
    case 'mostrar': acaoMostrar(ctx, slug, saida); break;
    case 'permitir': if (!arg) throw new Falha('faltou o domínio.', 'use: dgclaw saida permitir <agente> <dominio>'); acaoPermitir(ctx, slug, arg, saida); break;
    case 'remover': if (!arg) throw new Falha('faltou o domínio.', 'use: dgclaw saida remover <agente> <dominio>'); acaoRemover(ctx, slug, arg, saida); break;
    case 'modo': acaoModo(ctx, slug, arg, saida); break;
    case 'relatorio': {
      const dias = o.flags.dias === undefined ? 7 : Number(o.flags.dias);
      if (!Number.isInteger(dias) || dias < 1 || dias > 3650) throw new Falha(`--dias "${o.flags.dias}" não é um número de 1 a 3650.`, 'exemplo: dgclaw saida relatorio ana --dias 7');
      acaoRelatorio(ctx, slug, dias, !!o.flags.json, saida);
      break;
    }
    default: throw new Falha(`a ação "${String(acao || '').slice(0, 30)}" não existe.`, 'use: mostrar | permitir | remover | modo | relatorio');
  }
}

if (require.main === module) {
  try { principal(process.argv.slice(2)); } catch (e) {
    if (e instanceof Falha) {
      process.stderr.write(`\nNao deu certo: ${e.message}\nO que fazer: ${e.fazer}\n`);
      process.exit(1);
    }
    process.stderr.write(`\nNao deu certo: erro inesperado no dgclaw saida: ${e.stack || e.message}\nO que fazer: avise quem mantém o DG Claw com esta mensagem.\n`);
    process.exit(2);
  }
}

module.exports = { principal, Falha };
