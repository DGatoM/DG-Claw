'use strict';
// Catálogo FECHADO das operações que o serviço de controle sabe fazer (docs/enterprise/CONTROLE.md).
//
// O controle roda como root, sem nenhum modelo de linguagem. Quem pede (o Admin dentro do container, ou o TI pelo
// painel) só escolhe UMA entrada desta lista e preenche parâmetros. Nada aqui vira comando por interpolação:
//   - cada parâmetro tem tipo, limite e expressão regular; o que não está no esquema é recusado;
//   - texto livre só existe onde é só texto (nome, papel de um agente) e vai para o `execFile` como um item do argv;
//   - `descrever` monta a frase da tela de confirmação SÓ com os parâmetros já validados, nunca com texto do pedido;
//   - `executar` chama `bin/dgclaw` com argv em lista (nunca por shell), com prazo e saída cortada e mascarada.
//
// Classes: `leitura` (só olha), `reversivel` (executa direto e audita), `perigosa` (só executa com aprovação humana).
// `demorada: true` quer dizer que a operação vira uma tarefa em segundo plano (resposta na hora com o id; quem pediu
// consulta com `tarefa.ver`): a caixa do agente desiste de esperar em 30 s, e criar um agente leva minutos.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { mascarar } = require('../web/lib/mascara');
const { criarArmazem } = require('../web/lib/aprovacoes-arquivo');

const RX_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVADOS = new Set(['admin', 'admin-manutencao']);
const RX_CONTROLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RX_DOMINIO = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RX_PACOTE = /^[a-z0-9][a-z0-9+.-]+$/;
const RX_CHAVE_NIVEL = /^[a-z][a-z0-9_]{1,39}$/;
const RX_VALOR_NIVEL = /^[a-z0-9_]{1,20}$/;
const RX_MODELO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
const RX_ID_TAREFA = /^[0-9a-f]{12}$/;
const RX_ID_APROVACAO = /^[0-9a-f]{24}$/;
const SAIDA_MAX = 8000;

class ErroOperacao extends Error {
  constructor(mensagem, motivo) {
    super(mensagem);
    this.name = 'ErroOperacao';
    this.motivo = motivo || 'falha_execucao';
  }
}

// ── validadores de tipo: cada um devolve { valor } ou { erro } ────────────────
const rot = (c, nome) => c.rotulo || nome;
const TIPOS = {
  slug(v, c, nome) {
    if (typeof v !== 'string' || !RX_SLUG.test(v)) return { erro: `${rot(c, nome)} precisa ter de 2 a 31 caracteres, só letras minúsculas sem acento, números e hífen, começando por letra ou número (recebi ${JSON.stringify(String(v).slice(0, 40))})` };
    return { valor: v };
  },
  slug_agente(v, c, nome) {
    const r = TIPOS.slug(v, c, nome);
    if (r.erro) return r;
    if (RESERVADOS.has(v)) return { erro: `${rot(c, nome)} não pode ser "${v}": esse nome é do Admin, que o controle não cria, remove nem reinicia (o TI cuida dele pelo servidor)` };
    return r;
  },
  texto(v, c, nome) {
    if (typeof v !== 'string') return { erro: `${rot(c, nome)} precisa ser um texto` };
    const t = v.trim();
    const max = c.max || 200;
    if (!t) return { erro: `${rot(c, nome)} não pode ficar vazio` };
    if ([...t].length > max) return { erro: `${rot(c, nome)} passa de ${max} caracteres` };
    if (RX_CONTROLE.test(t)) return { erro: `${rot(c, nome)} tem quebra de linha ou caractere de controle, que não são aceitos` };
    return { valor: t };
  },
  inteiro(v, c, nome) {
    let n = v;
    if (typeof v === 'string' && /^[0-9]{1,6}$/.test(v)) n = Number(v);
    if (typeof n !== 'number' || !Number.isInteger(n)) return { erro: `${rot(c, nome)} precisa ser um número inteiro (recebi ${JSON.stringify(String(v).slice(0, 20))})` };
    if (n < c.min || n > c.max) return { erro: `${rot(c, nome)} precisa estar entre ${c.min} e ${c.max} (recebi ${n})` };
    return { valor: n };
  },
  enum(v, c, nome) {
    if (typeof v !== 'string' || !c.valores.includes(v)) return { erro: `${rot(c, nome)} precisa ser um destes: ${c.valores.join(', ')} (recebi ${JSON.stringify(String(v).slice(0, 30))})` };
    return { valor: v };
  },
  dominio(v, c, nome) {
    const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!RX_DOMINIO.test(t)) return { erro: `${rot(c, nome)} precisa ser um endereço como painel.suaempresa.com.br, só com letras, números, hífen e pontos, sem https:// e sem barra` };
    return { valor: t };
  },
  cor(v, c, nome) {
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return { erro: `${rot(c, nome)} precisa estar no formato #rrggbb` };
    return { valor: v };
  },
  modelo(v, c, nome) {
    if (typeof v !== 'string' || !RX_MODELO.test(v)) return { erro: `${rot(c, nome)} só aceita letras, números, ponto, dois-pontos, sublinhado e hífen (até 60 caracteres)` };
    return { valor: v };
  },
  pacotes(v, c, nome) {
    const lista = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : null);
    if (!lista || !lista.length || lista.length > 20) return { erro: `${rot(c, nome)} precisa ter de 1 a 20 nomes de pacote Debian (separados por vírgula)` };
    const limpos = [];
    for (const p of lista) {
      const t = typeof p === 'string' ? p.trim() : '';
      if (t.length > 100 || !RX_PACOTE.test(t)) return { erro: `"${String(p).slice(0, 40)}" não parece nome de pacote Debian (use letras minúsculas, números e os sinais + - .; sem versão nem opções)` };
      limpos.push(t);
    }
    return { valor: limpos };
  },
  chave_nivel(v, c, nome) {
    if (typeof v !== 'string' || !RX_CHAVE_NIVEL.test(v)) return { erro: `${rot(c, nome)} precisa ser o nome de uma proteção (letras minúsculas, números e sublinhado)` };
    return { valor: v };
  },
  valor_nivel(v, c, nome) {
    if (typeof v === 'boolean') return { valor: String(v) };
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e6) return { valor: String(v) };
    if (typeof v !== 'string' || !RX_VALOR_NIVEL.test(v)) return { erro: `${rot(c, nome)} precisa ser true, false, um número ou uma palavra simples (letras minúsculas, números e sublinhado)` };
    return { valor: v };
  },
  id_aprovacao(v, c, nome) {
    if (typeof v !== 'string' || !RX_ID_APROVACAO.test(v)) return { erro: `${rot(c, nome)} precisa ser o identificador do pedido (24 caracteres entre 0-9 e a-f)` };
    return { valor: v };
  },
  id_tarefa(v, c, nome) {
    if (typeof v !== 'string' || !RX_ID_TAREFA.test(v)) return { erro: `${rot(c, nome)} precisa ser o identificador da tarefa (12 caracteres entre 0-9 e a-f)` };
    return { valor: v };
  },
};

/** Valida e normaliza os parâmetros de uma operação. { ok: true, params } ou { ok: false, erro }. */
function validarParams(def, params) {
  const bruto = params == null ? {} : params;
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, erro: 'Os parâmetros precisam ser um objeto JSON, por exemplo {"agente": "ana"}.' };
  const esquema = def.params || {};
  for (const k of Object.keys(bruto)) {
    if (!Object.prototype.hasOwnProperty.call(esquema, k)) {
      const aceitos = Object.keys(esquema);
      return { ok: false, erro: `O parâmetro "${String(k).slice(0, 40)}" não existe nesta operação.${aceitos.length ? ` Os parâmetros dela são: ${aceitos.join(', ')}.` : ' Ela não recebe parâmetros.'}` };
    }
  }
  const saida = {};
  for (const [nome, c] of Object.entries(esquema)) {
    const v = bruto[nome];
    if (v === undefined || v === null || v === '') {
      if (c.padrao !== undefined) { saida[nome] = c.padrao; continue; }
      if (c.obrigatorio) return { ok: false, erro: `Falta o parâmetro "${nome}" (${c.ajuda || rot(c, nome)}).` };
      continue;
    }
    const r = TIPOS[c.tipo](v, c, nome);
    if (r.erro) return { ok: false, erro: `Parâmetro "${nome}": ${r.erro}.` };
    saida[nome] = r.valor;
  }
  return { ok: true, params: saida };
}

// ── execução ─────────────────────────────────────────────────────────────────
function corta(texto, max) {
  const t = String(texto == null ? '' : texto);
  return t.length > max ? `[...cortado, mostrando o fim]\n${t.slice(-max)}` : t;
}

/** Roda `bin/dgclaw` com o argv em lista. Devolve { codigo, saida }; nunca lança por causa de código de saída. */
function rodarCli(ctx, argv, def) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1', DGCLAW_QUEM: `controle:${ctx.quem}` };
    if (process.env.HOME) env.HOME = process.env.HOME;
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DGCLAW_') && k !== 'DGCLAW_QUEM') env[k] = v;
    execFile(ctx.bin, argv, { timeout: def.timeoutMs || 120000, maxBuffer: 4 * 1024 * 1024, env, windowsHide: true }, (erro, stdout, stderr) => {
      const saida = corta(mascarar(`${stdout || ''}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.trim()), SAIDA_MAX);
      if (erro && erro.code === 'ENOENT') {
        reject(new ErroOperacao(`Não achei o programa ${ctx.bin}. Confira a instalação do DG Claw no servidor (variável DGCLAW_BIN do serviço de controle).`, 'falha_execucao'));
        return;
      }
      if (erro && erro.killed) {
        reject(new ErroOperacao(`O comando "dgclaw ${argv.join(' ')}" passou do prazo de ${Math.round((def.timeoutMs || 120000) / 1000)} s e foi interrompido. Confira o estado no servidor antes de repetir.${saida ? ` Última saída:\n${saida}` : ''}`, 'falha_execucao'));
        return;
      }
      const codigo = erro ? (typeof erro.code === 'number' ? erro.code : 1) : 0;
      resolve({ codigo, saida });
    });
  });
}

async function viaCli(ctx, def, params) {
  const argv = def.cli(params, ctx);
  const r = await rodarCli(ctx, argv, def);
  if (r.codigo !== 0 && !def.aceitaCodigo) {
    throw new ErroOperacao(`O comando "dgclaw ${argv.slice(0, 3).join(' ')}" terminou com código ${r.codigo}.${r.saida ? ` O que ele disse:\n${r.saida}` : ' Ele não escreveu nada.'}`, 'falha_execucao');
  }
  return def.aceitaCodigo ? { codigo: r.codigo, saida: r.saida } : { saida: r.saida };
}

/** Últimas `n` linhas de um arquivo, lendo só o fim. Devolve '' se o arquivo não existe. */
function ultimasLinhas(arquivo, n) {
  let fd;
  try { fd = fs.openSync(arquivo, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ErroOperacao(`Não consegui abrir o log ${arquivo} (${e.code || e.message}).`, 'falha_execucao');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ErroOperacao(`${arquivo} não é um arquivo comum.`, 'falha_execucao');
    const tam = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(tam);
    fs.readSync(fd, buf, 0, tam, st.size - tam);
    const linhas = buf.toString('utf8').split('\n');
    if (linhas[linhas.length - 1] === '') linhas.pop();
    return linhas.slice(-n).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

const crit = (def) => Object.assign({ params: {} }, def);
const P_AGENTE = { tipo: 'slug_agente', obrigatorio: true, rotulo: 'o agente', ajuda: 'o nome curto do agente' };
const P_AGENTE_OPC = { tipo: 'slug', rotulo: 'o agente', ajuda: 'o nome curto do agente' };

/** A lista fechada. A chave é o nome da operação (também é o que vai na rota /api/v1/controle/<op>). */
const OPS = {
  // ── leitura ────────────────────────────────────────────────────────────────
  'agentes.listar': crit({
    classe: 'leitura',
    resumo: 'Lista os agentes registrados (nome, tipo, provedor, container).',
    descrever: () => 'Listar os agentes registrados.',
    nativa(params, ctx) {
      let texto;
      try { texto = fs.readFileSync(ctx.agentesPath, 'utf8'); } catch (e) {
        throw new ErroOperacao(`Não consegui ler o registro de agentes ${ctx.agentesPath} (${e.code || e.message}). Confira a instalação.`, 'falha_execucao');
      }
      let j;
      try { j = JSON.parse(texto); } catch (e) {
        throw new ErroOperacao(`O registro ${ctx.agentesPath} não é um JSON válido (${e.message}).`, 'falha_execucao');
      }
      const lista = (Array.isArray(j.agentes) ? j.agentes : []).map((a) => ({
        slug: a.slug, nome: a.nome, tipo: a.tipo, papel: a.papel || null, provedor: a.provedor || null, container: a.container || null,
      }));
      return { agentes: lista };
    },
  }),
  'agente.status': crit({
    classe: 'leitura',
    resumo: 'Estado do container e do runner de um agente (ou de todos, sem o parâmetro agente).',
    params: { agente: P_AGENTE_OPC },
    descrever: (p) => (p.agente ? `Ver o estado do agente \`${p.agente}\`.` : 'Ver o estado de todos os agentes.'),
    cli: () => ['agente', 'listar', '--json'],
    timeoutMs: 60000,
    async executar(ctx, params) {
      const r = await viaCli(ctx, this, params);
      let lista;
      try { lista = JSON.parse(r.saida); } catch (e) {
        throw new ErroOperacao(`O comando "dgclaw agente listar --json" não devolveu JSON (${e.message}). O que ele disse:\n${corta(r.saida, 1000)}`, 'falha_execucao');
      }
      if (params.agente) {
        const um = lista.find((a) => a.slug === params.agente);
        if (!um) throw new ErroOperacao(`Não existe o agente "${params.agente}". Veja os que existem com a operação agentes.listar.`, 'nao_encontrado');
        return { agente: um };
      }
      return { agentes: lista };
    },
  }),
  'agente.log': crit({
    classe: 'leitura',
    resumo: 'Últimas linhas do log do runner de um agente (no máximo 200).',
    params: { agente: Object.assign({}, P_AGENTE_OPC, { obrigatorio: true }), linhas: { tipo: 'inteiro', min: 1, max: 200, padrao: 50, rotulo: 'o número de linhas' } },
    descrever: (p) => `Ler as últimas ${p.linhas} linhas do log do agente \`${p.agente}\`.`,
    nativa(params, ctx) {
      const arq = path.join(ctx.casasDir, params.agente, 'home', '.dgclaw', 'logs', 'runner.log');
      const texto = ultimasLinhas(arq, params.linhas);
      if (texto === null) throw new ErroOperacao(`O agente "${params.agente}" ainda não tem log do runner (${arq} não existe). Confira o nome com agentes.listar.`, 'nao_encontrado');
      return { agente: params.agente, linhas: corta(mascarar(texto), SAIDA_MAX) };
    },
  }),
  'status.geral': crit({
    classe: 'leitura',
    resumo: 'Roda `dgclaw status` (tudo de pé?). O código de saída vem no resultado.',
    descrever: () => 'Conferir se tudo está de pé (dgclaw status).',
    cli: () => ['status'],
    aceitaCodigo: true,
    timeoutMs: 90000,
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'imagem.status': crit({
    classe: 'leitura',
    resumo: 'Diz se a imagem dos agentes está pronta, construindo ou falhou.',
    descrever: () => 'Ver o estado da imagem dos agentes.',
    cli: () => ['imagem', 'status'],
    aceitaCodigo: true,
    timeoutMs: 30000,
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'nivel.mostrar': crit({
    classe: 'leitura',
    resumo: 'Mostra o nível de proteção e o valor de cada proteção.',
    descrever: () => 'Ver o nível de proteção e as proteções.',
    cli: () => ['nivel', 'mostrar'],
    timeoutMs: 30000,
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'pedido.ver': crit({
    classe: 'leitura',
    resumo: 'Estado de um pedido de aprovação que esta pessoa fez.',
    params: { id: { tipo: 'id_aprovacao', obrigatorio: true, rotulo: 'o pedido', ajuda: 'o identificador que voltou quando o pedido ficou pendente' } },
    descrever: (p) => `Ver o pedido de aprovação ${p.id}.`,
    nativa(params, ctx) {
      const reg = criarArmazem({ dataDir: ctx.dataDir, log: ctx.log }).ler(params.id);
      if (!reg) throw new ErroOperacao(`Não existe o pedido ${params.id}. Confira o identificador que o controle devolveu.`, 'nao_encontrado');
      return { pedido: { id: reg.id, tipo: reg.tipo, op: reg.op, descricao: reg.descricao, estado: reg.estado, pedido_por: reg.pedido_por, pedido_em: reg.pedido_em, expira_em: reg.expira_em, decidido_por: reg.decidido_por, decidido_em: reg.decidido_em, resultado: reg.resultado } };
    },
  }),
  'tarefa.ver': crit({
    classe: 'leitura',
    resumo: 'Estado de uma tarefa em segundo plano (criar agente, reparar, etc.).',
    params: { id: { tipo: 'id_tarefa', obrigatorio: true, rotulo: 'a tarefa', ajuda: 'o identificador que voltou quando a operação começou' } },
    descrever: (p) => `Ver a tarefa ${p.id}.`,
    nativa(params, ctx) {
      const t = ctx.tarefas.ver(params.id);
      if (!t) throw new ErroOperacao(`Não existe a tarefa ${params.id} (o controle guarda as últimas 100 e esquece tudo quando reinicia). Confira o estado com agente.status.`, 'nao_encontrado');
      return { tarefa: t };
    },
  }),
  'cofre.nomes': crit({
    classe: 'leitura',
    resumo: 'Só os NOMES das chaves guardadas no cofre de um agente. Nunca o valor: quem cola a chave é o TI, no painel.',
    params: { agente: P_AGENTE },
    descrever: (p) => `Listar os nomes das chaves do cofre do agente \`${p.agente}\`.`,
    cli: (p) => ['agente', 'cofre', p.agente, 'listar', '--json'],
    timeoutMs: 30000,
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),

  // ── reversíveis: executam direto e ficam na auditoria ──────────────────────
  'agente.criar': crit({
    classe: 'reversivel',
    demorada: true,
    timeoutMs: 30 * 60 * 1000,
    resumo: 'Cria um agente novo (container, painel e conversa). Leva alguns minutos: devolve uma tarefa.',
    params: {
      slug: { tipo: 'slug_agente', obrigatorio: true, rotulo: 'o nome curto', ajuda: 'o nome curto do agente, como ana' },
      nome: { tipo: 'texto', max: 60, obrigatorio: true, rotulo: 'o nome', ajuda: 'o nome que aparece no painel' },
      provedor: { tipo: 'enum', valores: ['claude', 'codex'], padrao: 'claude', rotulo: 'o provedor' },
      auth: { tipo: 'enum', valores: ['assinatura', 'api'], padrao: 'assinatura', rotulo: 'a autenticação' },
      modelo: { tipo: 'modelo', rotulo: 'o modelo' },
      papel: { tipo: 'texto', max: 300, rotulo: 'o papel' },
      jeito: { tipo: 'texto', max: 300, rotulo: 'o jeito de falar' },
      dono: { tipo: 'texto', max: 60, rotulo: 'como ele chama o dono' },
      canal: { tipo: 'enum', valores: ['chat', 'telegram', 'whatsapp'], padrao: 'chat', rotulo: 'o canal' },
      avatar: { tipo: 'texto', max: 8, rotulo: 'o avatar' },
      cor: { tipo: 'cor', rotulo: 'a cor' },
      // Versão empresa (credencial_empresa): de quem é o agente. Pessoa entra com o assento dela (auth assinatura); setor usa a chave de API.
      uso: { tipo: 'enum', valores: ['pessoa', 'setor'], rotulo: 'o uso', ajuda: 'pessoa ou setor; obrigatório quando a proteção credencial_empresa está ligada' },
      usuario: { tipo: 'texto', max: 64, rotulo: 'o login da pessoa dona', ajuda: 'o login do usuário (veja com dgclaw usuario listar); vale para uso pessoa' },
    },
    descrever: (p) => `Criar o agente \`${p.slug}\` (nome "${p.nome}", provedor ${p.provedor}${p.uso ? `, uso ${p.uso}${p.usuario ? ` da pessoa ${p.usuario}` : ''}` : ''}).`,
    chave: (p) => p.slug,
    cli(p) {
      const a = ['agente', 'criar', p.slug, '--nome', p.nome, '--provedor', p.provedor, '--auth', p.auth, '--canal', p.canal];
      for (const [flag, k] of [['--modelo', 'modelo'], ['--papel', 'papel'], ['--jeito', 'jeito'], ['--dono', 'dono'], ['--avatar', 'avatar'], ['--cor', 'cor'], ['--uso', 'uso'], ['--usuario', 'usuario']]) {
        if (p[k] !== undefined) a.push(flag, p[k]);
      }
      return a;
    },
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'agente.iniciar': crit({
    classe: 'reversivel', demorada: true, timeoutMs: 5 * 60 * 1000,
    resumo: 'Liga o container de um agente.',
    params: { agente: P_AGENTE },
    descrever: (p) => `Ligar o agente \`${p.agente}\`.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'iniciar', p.agente],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'agente.parar': crit({
    classe: 'reversivel', demorada: true, timeoutMs: 2 * 60 * 1000,
    resumo: 'Desliga o container de um agente (a casa dele fica intacta).',
    params: { agente: P_AGENTE },
    descrever: (p) => `Desligar o agente \`${p.agente}\`.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'parar', p.agente],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'agente.reiniciar': crit({
    classe: 'reversivel', demorada: true, timeoutMs: 3 * 60 * 1000,
    resumo: 'Reinicia o runner de um agente (o container não cai).',
    params: { agente: P_AGENTE },
    descrever: (p) => `Reiniciar o runner do agente \`${p.agente}\`.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'reiniciar', p.agente],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'agente.reparar': crit({
    classe: 'reversivel', demorada: true, timeoutMs: 15 * 60 * 1000,
    resumo: 'Refaz a parte de dentro de um agente (config, runner, painel e rotinas).',
    params: { agente: P_AGENTE },
    descrever: (p) => `Reparar o agente \`${p.agente}\`.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'reparar', p.agente],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'imagem.construir': crit({
    classe: 'reversivel',
    timeoutMs: 60000,
    resumo: 'Começa a construir a imagem dos agentes em segundo plano (acompanhe com imagem.status).',
    descrever: () => 'Construir a imagem dos agentes.',
    cli: () => ['imagem', 'construir'],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  // O comando dgclaw agente pacote é do bloco D (container endurecido). Se esta versão não o tem, o erro vem da própria CLI.
  'agente.pacote': crit({
    classe: 'reversivel', demorada: true, timeoutMs: 20 * 60 * 1000,
    resumo: 'Instala pacotes Debian num agente que não tem sudo (container endurecido).',
    params: { agente: P_AGENTE, pacotes: { tipo: 'pacotes', obrigatorio: true, rotulo: 'os pacotes', ajuda: 'nomes separados por vírgula' } },
    descrever: (p) => `Instalar no agente \`${p.agente}\` os pacotes: ${p.pacotes.join(', ')}.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'pacote', p.agente, ...p.pacotes],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),

  // ── perigosas: só executam com aprovação humana ────────────────────────────
  'agente.remover': crit({
    classe: 'perigosa', demorada: true, timeoutMs: 5 * 60 * 1000,
    resumo: 'Tira um agente do ar. A casa dele vai para a pasta de aposentados (nada é apagado).',
    params: { agente: P_AGENTE },
    descrever: (p) => `Remover o agente \`${p.agente}\`. A casa dele vai para aposentados.`,
    chave: (p) => p.agente,
    cli: (p) => ['agente', 'remover', p.agente, '--sim'],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'dominio.trocar': crit({
    classe: 'perigosa', demorada: true, timeoutMs: 10 * 60 * 1000,
    resumo: 'Passa o painel para outro endereço (o DNS precisa já apontar para este servidor).',
    params: { dominio: { tipo: 'dominio', obrigatorio: true, rotulo: 'o domínio', ajuda: 'por exemplo painel.suaempresa.com.br' } },
    descrever: (p) => `Trocar o endereço do painel para \`${p.dominio}\`. O painel muda de endereço e um certificado novo é pedido.`,
    chave: () => 'dominio',
    cli: (p) => ['dominio', 'trocar', p.dominio],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  // Para o bloco E (travas externas). O comando `dgclaw travas liberar` é dele; sem ele a CLI responde que o comando não existe.
  'travas.liberar': crit({
    classe: 'perigosa', timeoutMs: 60000,
    resumo: 'Libera por um tempo curto uma trava de ação externa de um agente (bloco E).',
    params: { agente: P_AGENTE, minutos: { tipo: 'inteiro', min: 5, max: 240, padrao: 30, rotulo: 'os minutos' } },
    descrever: (p) => `Liberar as travas de ações externas do agente \`${p.agente}\` por ${p.minutos} minutos.`,
    cli: (p) => ['travas', 'liberar', p.agente, '--minutos', String(p.minutos)],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'manutencao.abrir': crit({
    classe: 'perigosa', timeoutMs: 60000,
    resumo: 'Liga por alguns minutos o Admin antigo, como root no servidor (manutenção de emergência). Fecha sozinho.',
    params: { minutos: { tipo: 'inteiro', min: 5, max: 60, obrigatorio: true, rotulo: 'os minutos', ajuda: 'de 5 a 60' } },
    descrever: (p) => `Abrir a manutenção de emergência por ${p.minutos} minutos. Durante esse tempo o Admin antigo roda como root no servidor, sem a proteção do container.`,
    cli: (p, ctx) => ['admin', 'manutencao', 'abrir', String(p.minutos), '--por', ctx.quem],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
  'nivel.ajustar': crit({
    classe: 'perigosa', timeoutMs: 30000,
    resumo: 'Ajusta uma proteção (nunca abaixo da trava do nível).',
    params: { chave: { tipo: 'chave_nivel', obrigatorio: true, rotulo: 'a proteção' }, valor: { tipo: 'valor_nivel', obrigatorio: true, rotulo: 'o valor' } },
    descrever: (p) => `Ajustar a proteção \`${p.chave}\` para \`${p.valor}\`.`,
    cli: (p) => ['nivel', 'ajustar', p.chave, p.valor],
    executar(ctx, params) { return viaCli(ctx, this, params); },
  }),
};
for (const [nome, def] of Object.entries(OPS)) def.nome = nome;

const eOp = (op) => typeof op === 'string' && Object.prototype.hasOwnProperty.call(OPS, op);

/** Valida os parâmetros de uma operação pelo nome. { ok: true, params } ou { ok: false, erro, motivo }. */
function validar(op, params) {
  if (!eOp(op)) return { ok: false, motivo: 'op_desconhecida', erro: `A operação "${String(op).slice(0, 60)}" não existe. As operações são: ${Object.keys(OPS).join(', ')}.` };
  const r = validarParams(OPS[op], params);
  return r.ok ? r : Object.assign({ motivo: 'parametros' }, r);
}

/** A frase da confirmação, montada só com parâmetros já validados por `validar`. */
function descrever(op, params) {
  return OPS[op].descrever(params);
}

/** Resumo do catálogo para a documentação e para a tela. */
function listar() {
  return Object.entries(OPS).map(([op, d]) => ({
    op, classe: d.classe, demorada: !!d.demorada, resumo: d.resumo,
    params: Object.entries(d.params || {}).map(([nome, c]) => ({ nome, tipo: c.tipo, obrigatorio: !!c.obrigatorio, padrao: c.padrao, min: c.min, max: c.max, valores: c.valores, ajuda: c.ajuda || c.rotulo })),
  }));
}

/** O markdown que o agente lê (GET /api/v1/controle/docs.md). Sai do mesmo catálogo, então nunca fica velho. */
function docsMarkdown() {
  const nomes = { leitura: 'Leitura (executa na hora)', reversivel: 'Reversíveis (executam direto e ficam na auditoria)', perigosa: 'Perigosas (esperam o TI aprovar no painel)' };
  let md = '# Controle do servidor\n\nVocê não roda comandos no servidor. Você pede uma destas operações ao serviço de controle com `dgclaw-controle <operação> --parametro valor`.\n'
    + 'As perigosas viram um pedido que o TI aprova no painel (em /aprovacoes); você acompanha com `dgclaw-controle pedido <id>`.\n'
    + 'As operações marcadas como demoradas voltam com um identificador de tarefa; acompanhe com `dgclaw-controle tarefa <id>`.\n';
  for (const classe of ['leitura', 'reversivel', 'perigosa']) {
    md += `\n## ${nomes[classe]}\n\n`;
    for (const o of listar().filter((x) => x.classe === classe)) {
      md += `- \`${o.op}\`${o.demorada ? ' (demorada)' : ''}: ${o.resumo}\n`;
      for (const p of o.params) {
        md += `  - \`--${p.nome}\`${p.obrigatorio ? ' (obrigatório)' : ''}: ${p.ajuda}${p.padrao !== undefined ? `; padrão ${p.padrao}` : ''}${p.valores ? `; um de ${p.valores.join(', ')}` : ''}${p.min !== undefined ? `; de ${p.min} a ${p.max}` : ''}\n`;
      }
    }
  }
  return md;
}

module.exports = { OPS, eOp, validar, validarParams, descrever, listar, docsMarkdown, rodarCli, viaCli, corta, ErroOperacao, RX_SLUG, RESERVADOS };
