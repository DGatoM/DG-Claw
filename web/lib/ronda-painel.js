'use strict';
// Ronda de segurança de fábrica, lado do painel: lê o que o motor (root) grava em
// <dataDir>/seguranca/ronda.json e emergencia.json, e transforma os cliques do dono em PEDIDOS
// (arquivos em seguranca/pedidos/) que o root valida de novo e executa. O Web nunca executa nada.
// Contrato: docs/interno/CONTRATO-RONDA.md. Rotas para agentes: web/docs/RONDA-PAINEL.md.
//
// O ronda.json nasceu em fontes externas (OSV, Ubuntu, GitHub): cada campo é revalidado aqui antes
// de sair pela API (sem caractere de controle, cortado no tamanho, URL só https), e a tela escapa.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./http');
const C = require('./boletim-contrato');

const BASE = '/api/v1/seguranca';
const COMO_REFAZER = 'Rode "sudo dgclaw seguranca rodar" no servidor para refazê-lo.';
const COMO_REFAZER_EMERGENCIA = 'Rode "sudo dgclaw emergencia estado" no servidor para refazê-lo.';
const MAX_ARQUIVO = 4 * 1024 * 1024;
const MAX_PENDENTES = 20;
const FRASE_CORTAR = 'TIRAR-DO-AR';
const FRASE_RELIGAR = 'RELIGAR';
const MAX_AGENDA_MS = 90 * 24 * 3600 * 1000;
const MIN_AGENDA_MS = 60 * 1000;

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RX_ACAO = /^[a-z0-9][a-z0-9._-]{0,60}$/;
// Contrato de id dos achados da ronda: o motor grava em MAIÚSCULAS, mas o painel aceita as duas formas
// (a API e o OSV escrevem GHSA-xxxx-xxxx-xxxx em minúsculas) e sempre compara e envia em maiúsculas.
const RX_ID_ACHADO = /^[A-Za-z0-9][A-Za-z0-9._-]{2,60}$/;
const RX_CODIGO = /^[A-Za-z0-9]{6}$/;
const INVISIVEIS = '\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF';
const RX_PROIBIDO = new RegExp(`[${INVISIVEIS}]`);
const RX_PROIBIDO_G = new RegExp(`[${INVISIVEIS}]`, 'g');
const SEVERIDADES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'desconhecida'];
const PESO = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, desconhecida: 4 };
const TIPOS_CORRECAO = ['acao-catalogo', 'atualizar-dgclaw', 'apt', 'nenhuma'];
const ESTADOS = ['aberto', 'aplicado-sozinho', 'aplicado-pelo-dono', 'mitigado', 'agendado'];

const idAchado = (v) => (typeof v === 'string' && RX_ID_ACHADO.test(v) ? v.toUpperCase() : null);

/** Texto de fonte externa: troca controles e invisíveis por espaço, apara e corta. */
function txt(v, max) {
  if (typeof v !== 'string') return null;
  const limpo = v.replace(RX_PROIBIDO_G, ' ').replace(/ {2,}/g, ' ').trim();
  if (!limpo) return null;
  const letras = Array.from(limpo);
  return letras.length > max ? `${letras.slice(0, max - 1).join('')}…` : limpo;
}
const data = (v) => (typeof v === 'string' && C.RX_DATA.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
/** https simples ou null (a URL ruim some; quem exige fonte descarta o achado). */
function urlHttps(v) {
  if (typeof v !== 'string' || v.length > 300 || !v.startsWith('https://') || /\s/.test(v) || RX_PROIBIDO.test(v)) return null;
  if (!/^https:\/\/[^/?#\\@]+(\/|\?|#|$)/.test(v)) return null;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && u.hostname ? v : null; } catch { return null; }
}
const lista = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const inteiro = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

/** { achado } ou { id, motivo }. */
function validaAchado(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { motivo: 'o item não é um objeto' };
  const id = idAchado(a.id);
  if (!id) return { motivo: 'id fora do formato' };
  const nega = (motivo) => ({ id, motivo });
  const nivel = inteiro(a.nivel, 1, 3);
  if (!nivel) return nega('nivel fora de 1, 2 ou 3');
  const fonte = urlHttps(a.fonte_url);
  if (!fonte) return nega('sem fonte_url https (nada de alerta sem fonte)');
  const nome = txt(a.nome_simples, 140) || txt(a.componente, 140);
  if (!nome) return nega('sem nome_simples');
  const c = a.correcao && typeof a.correcao === 'object' && !Array.isArray(a.correcao) ? a.correcao : {};
  const correcao = {
    tipo: TIPOS_CORRECAO.includes(c.tipo) ? c.tipo : 'nenhuma',
    acao_id: typeof c.acao_id === 'string' && RX_ACAO.test(c.acao_id) ? c.acao_id : null,
    exige_reinicio: c.exige_reinicio === true,
    disponivel: c.disponivel === true,
    // só a ação do catálogo pode ser aplicada ou agendada pelo painel; o resto vai ao Admin
    executavel: c.executavel === true && c.tipo === 'acao-catalogo',
  };
  let aplicado = null;
  if (a.aplicado && typeof a.aplicado === 'object' && !Array.isArray(a.aplicado)) {
    const d = a.aplicado.desfazer;
    aplicado = {
      em: data(a.aplicado.em),
      acao_id: typeof a.aplicado.acao_id === 'string' && RX_ACAO.test(a.aplicado.acao_id) ? a.aplicado.acao_id : null,
      antes: txt(a.aplicado.antes, 200),
      depois: txt(a.aplicado.depois, 200),
      desfazer: typeof d === 'string' ? txt(d, 300) : d === true,
    };
  }
  const aliases = lista(a.aliases, 10).map(idAchado).filter(Boolean);
  return {
    achado: {
      id, aliases, nivel,
      severidade: SEVERIDADES.includes(a.severidade) ? a.severidade : 'desconhecida',
      nome_simples: nome,
      componente: txt(a.componente, 80),
      publicado_em: data(a.publicado_em),
      fonte_url: fonte,
      noticia_url: urlHttps(a.noticia_url),
      onde: lista(a.onde, 10).map((x) => txt(x, 200)).filter(Boolean),
      o_que_faz: txt(a.o_que_faz, 500),
      como_corrigir: txt(a.como_corrigir, 500),
      correcao,
      estado: ESTADOS.includes(a.estado) ? a.estado : 'aberto',
      aplicado,
      primeira_vez_em: data(a.primeira_vez_em),
    },
  };
}

function validaInventario(inv) {
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) return null;
  return {
    componentes: inteiro(inv.componentes, 0, 10000000),
    kernel: txt(inv.kernel, 80),
    portas_publicas: lista(inv.portas_publicas, 50).filter((p) => p && typeof p === 'object')
      .map((p) => ({ porta: inteiro(p.porta, 1, 65535), processo: txt(p.processo, 60), pacote: txt(p.pacote, 80) })).filter((p) => p.porta),
    servicos_externos: lista(inv.servicos_externos, 50).filter((s) => s && typeof s === 'object')
      .map((s) => ({ nome: txt(s.nome, 60), via: txt(s.via, 120), pacote: txt(s.pacote, 100), versao: txt(s.versao, 40) })).filter((s) => s.nome),
    reinventariado_em: data(inv.reinventariado_em),
  };
}

function validaVigia(v) {
  if (!v) return null;
  if (v === true) return { quando: null, motivo: 'A ronda automática não rodou no horário previsto.' };
  if (typeof v === 'string') return { quando: null, motivo: txt(v, 400) || 'A ronda automática não rodou no horário previsto.' };
  if (typeof v === 'object' && !Array.isArray(v)) {
    return { quando: data(v.quando), motivo: txt(v.motivo, 400) || 'A ronda automática não rodou no horário previsto.' };
  }
  return null;
}

/** { erro } ou { ronda } já sanitizada. `descarte(id, motivo)` é chamado para cada achado recusado. */
function validaRonda(j, descarte) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.achados)) {
    return { erro: 'não tem o formato esperado (falta a lista "achados")' };
  }
  const fontes = lista(j.fontes, 30).filter((f) => f && typeof f === 'object')
    .map((f) => ({ nome: txt(f.nome, 60), ok: f.ok === true, motivo: txt(f.motivo, 300) })).filter((f) => f.nome);
  const achados = [];
  const vistos = new Set();
  for (const item of j.achados.slice(0, 500)) {
    const r = validaAchado(item);
    if (r.achado && !vistos.has(r.achado.id)) { vistos.add(r.achado.id); achados.push(r.achado); } else if (descarte) descarte(r.id || (r.achado && r.achado.id), r.motivo || 'id repetido');
  }
  achados.sort((a, b) => a.nivel - b.nivel || PESO[a.severidade] - PESO[b.severidade]);
  const niveis = { 1: [], 2: [], 3: [] };
  for (const a of achados) niveis[a.nivel].push(a);
  return {
    ronda: {
      rodada_em: data(j.rodada_em), proxima_em: data(j.proxima_em),
      parcial: j.parcial === true,
      fontes, fontes_fora: fontes.filter((f) => !f.ok).map((f) => f.nome),
      inventario: validaInventario(j.inventario),
      niveis,
      sem_novidades: achados.length === 0,
      ja_tratadas: lista(j.ja_tratadas, 200).filter((t) => t && typeof t === 'object')
        .map((t) => ({ id: txt(t.id, 80), componente: txt(t.componente, 80), como: txt(t.como, 200) })).filter((t) => t.id || t.componente),
      vigia_alerta: validaVigia(j.vigia_alerta),
    },
  };
}

function validaPlano(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const textos = (v, n, max) => lista(v, n).map((x) => txt(x, max)).filter(Boolean);
  return {
    recusado: p.recusado === true,
    problemas: textos(p.problemas, 20, 500),
    avisos: textos(p.avisos, 20, 500),
    isolar_saida: p.isolar_saida === true,
    prazo_min: inteiro(p.prazo_min, 1, 240),
    servicos_a_parar: textos(p.servicos_a_parar, 20, 80),
    comandos: textos(p.comandos, 60, 400),
  };
}

function validaEstadoEmergencia(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  return {
    cortado: e.cortado === true,
    inconsistente: e.inconsistente === true,
    motivo_inconsistente: txt(e.motivo_inconsistente, 300),
    desde: data(e.desde),
    quem: txt(e.quem, 60),
    isolar_saida: e.isolar_saida === true,
    confirmado: e.confirmado === true,
    religar_automatico_agendado: e.religar_automatico_agendado === true,
    religar_automatico_em: data(e.religar_automatico_em),
    servicos: lista(e.servicos, 20).filter((s) => s && typeof s === 'object').map((s) => ({ nome: txt(s.nome, 80), ativo: s.ativo === true })).filter((s) => s.nome),
  };
}

function criarRondaPainel(opcoes) {
  const { dataDir, log } = opcoes;
  const relogio = opcoes.agora || (() => Date.now());
  const dir = path.join(dataDir, 'seguranca');
  const arqRonda = path.join(dir, 'ronda.json');
  const arqEmergencia = path.join(dir, 'emergencia.json');
  const dirPedidos = path.join(dir, 'pedidos');
  const dirFeitos = path.join(dirPedidos, 'feitos');

  /** { ausente } | { erro } | { json }. */
  function lerJson(arq, comoRefazer) {
    let bruto;
    try {
      if (fs.statSync(arq).size > MAX_ARQUIVO) return { erro: `O arquivo ${arq} é grande demais (mais de ${MAX_ARQUIVO} bytes). ${comoRefazer}` };
      bruto = fs.readFileSync(arq, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { ausente: true };
      return { erro: `Não consegui ler ${arq} (${e.code || e.message}). ${comoRefazer}` };
    }
    try { return { json: JSON.parse(bruto) }; } catch (e) {
      return { erro: `O arquivo ${arq} está corrompido (${e.message}). ${comoRefazer}` };
    }
  }

  /** { ausente } | { erro } | { ronda }. */
  function lerRonda() {
    const l = lerJson(arqRonda, COMO_REFAZER);
    if (l.ausente || l.erro) return l;
    const r = validaRonda(l.json, (id, motivo) => log('aviso', `Ronda: descartei um achado de ${arqRonda} que não passa no contrato (${id || 'sem id'}: ${motivo}).`));
    if (r.erro) return { erro: `O arquivo ${arqRonda} ${r.erro}. ${COMO_REFAZER}` };
    return { ronda: r.ronda };
  }

  function falha(res, l, assunto) {
    log('erro', `Ronda: ${l.erro}`);
    H.erroJson(res, 500, l.erro);
    return assunto;
  }

  function listar(res) {
    const l = lerRonda();
    if (l.ausente) return H.enviaJson(res, 200, { ok: true, nunca_rodou: true });
    if (l.erro) return falha(res, l);
    return H.enviaJson(res, 200, { ok: true, nunca_rodou: false, ...l.ronda });
  }

  // ── pedidos ────────────────────────────────────────────────────────────────

  function pendentes() {
    try { return fs.readdirSync(dirPedidos).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)); } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  function lePedido(nome) {
    try { return JSON.parse(fs.readFileSync(path.join(dirPedidos, nome), 'utf8')); } catch { return null; }
  }

  /** Grava o pedido de forma atômica (nome temporário que o executor ignora, depois rename). Devolve o uuid. */
  function gravaPedido(corpo, sessao) {
    const fila = pendentes();
    if (fila.length >= MAX_PENDENTES) {
      const e = new Error(`Já há ${fila.length} pedidos esperando o servidor executar. Espere um pouco: se continuar assim, o executor (dgclaw-seguranca-pedidos.path) não está rodando. Veja: systemctl status dgclaw-seguranca-pedidos.path`);
      e.status = 429;
      throw e;
    }
    for (const nome of fila) {
      const p = lePedido(nome);
      if (p && p.tipo === corpo.tipo && p.id === corpo.id) {
        const e = new Error('Esse pedido já foi enviado e o servidor ainda não terminou de executar. Espere o resultado antes de pedir de novo.');
        e.status = 409;
        e.extra = { pedido: nome.replace(/\.json$/, '') };
        throw e;
      }
    }
    const uuid = crypto.randomUUID();
    fs.mkdirSync(dirFeitos, { recursive: true, mode: 0o700 });
    const tmp = path.join(dirPedidos, `.${uuid}.tmp`);
    const final = path.join(dirPedidos, `${uuid}.json`);
    const pedido = {
      tipo: corpo.tipo, id: corpo.id || null, quando: corpo.quando || null, codigo: corpo.codigo || null,
      pedido_em: new Date(relogio()).toISOString(), por: (sessao && sessao.usuario) || 'dono',
    };
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(pedido)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, final);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* o temporário pode nem ter sido criado */ }
      log('erro', `Ronda: não consegui gravar o pedido em ${final} (${e.code || e.message}).`);
      const err = new Error(`Não consegui gravar o pedido (${e.code || e.message}). Peça ao Admin para conferir o espaço em disco e as permissões de ${dirPedidos}.`);
      err.status = 500;
      throw err;
    }
    log('info', `Ronda: pedido ${pedido.tipo}${pedido.id ? ` ${pedido.id}` : ''} gravado (${uuid}) por ${pedido.por}.`);
    return uuid;
  }

  function achaAchado(res, id) {
    const norm = idAchado(id);
    if (!norm) { H.erroJson(res, 400, `O id do achado não tem o formato esperado (letras, números, ponto, hífen e sublinhado). Use um id de GET ${BASE}/ronda.`); return null; }
    id = norm;
    const l = lerRonda();
    if (l.ausente) { H.erroJson(res, 404, `A ronda ainda não rodou, então não há achado ${id}. Rode "sudo dgclaw seguranca rodar" no servidor.`); return null; }
    if (l.erro) { falha(res, l); return null; }
    const a = [...l.ronda.niveis[1], ...l.ronda.niveis[2], ...l.ronda.niveis[3]].find((x) => x.id === id);
    if (!a) { H.erroJson(res, 404, `Não há achado com o id ${id} na última ronda. Ele pode já ter sido resolvido. Atualize a tela.`); return null; }
    return a;
  }

  async function pedirDoAchado(req, res, sessao, id, tipo) {
    const a = achaAchado(res, id);
    if (!a) return;
    id = a.id;
    let corpo = {};
    if (tipo === 'agendar') corpo = await H.lerJson(req, 4 * 1024);
    if (tipo === 'desfazer') {
      if (a.estado !== 'aplicado-sozinho' || !a.aplicado || !a.aplicado.desfazer) {
        return H.erroJson(res, 409, `O achado ${id} não tem como ser desfeito: só dá para desfazer o que a ronda aplicou sozinha e deixou o caminho de volta registrado.`);
      }
    } else {
      if (a.estado !== 'aberto' && !(a.estado === 'agendado' && tipo === 'aplicar')) {
        return H.erroJson(res, 409, `O achado ${id} já está como "${a.estado}", então não há nada a aplicar nem a agendar.`);
      }
      if (!a.correcao.disponivel) {
        return H.erroJson(res, 409, `A correção do achado ${id} ainda não está pronta (${a.correcao.tipo === 'nenhuma' ? 'o fabricante ainda não publicou uma correção' : 'ela ainda não está disponível neste servidor'}). Use o botão de emergência se for urgente.`);
      }
      if (!a.correcao.executavel) {
        return H.erroJson(res, 409, `A correção do achado ${id} (${a.correcao.tipo}) não é uma ação do catálogo aprovado, então o painel não aplica nem agenda: o servidor recusaria. Use o botão "Pedir ao Admin" na tela Segurança, ou escreva ao Admin: "Quero aplicar a correção de segurança ${id}. Analise antes e me diga se vai reiniciar algum serviço."`);
      }
    }
    let quando = null;
    if (tipo === 'agendar') {
      const t = typeof corpo.quando === 'string' ? Date.parse(corpo.quando) : NaN;
      if (Number.isNaN(t) || !C.RX_DATA.test(corpo.quando)) {
        return H.erroJson(res, 400, 'Mande "quando" como data e hora no formato ISO com fuso, por exemplo 2026-11-01T03:00:00-03:00.');
      }
      const dif = t - relogio();
      if (dif < MIN_AGENDA_MS) return H.erroJson(res, 400, 'A hora do agendamento precisa estar pelo menos 1 minuto à frente. Para aplicar já, use "Aplicar correção".');
      if (dif > MAX_AGENDA_MS) return H.erroJson(res, 400, 'O agendamento pode ser de no máximo 90 dias à frente.');
      quando = new Date(t).toISOString();
    }
    const uuid = gravaPedido({ tipo, id, quando }, sessao);
    return H.enviaJson(res, 202, { ok: true, pedido: uuid, tipo, id, quando });
  }

  function resultadoDoPedido(res, uuid) {
    if (!RX_UUID.test(uuid)) return H.erroJson(res, 400, 'O id do pedido não tem o formato esperado (um UUID). Use o "pedido" devolvido pelo POST.');
    const feito = path.join(dirFeitos, `${uuid}.json`);
    let j;
    try { j = JSON.parse(fs.readFileSync(feito, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') {
        if (fs.existsSync(path.join(dirPedidos, `${uuid}.json`))) return H.enviaJson(res, 200, { ok: true, pendente: true });
        return H.erroJson(res, 404, `Não há pedido ${uuid}. Ele pode ter sido apagado pela limpeza do servidor; confira o estado em GET ${BASE}/ronda.`);
      }
      const msg = e instanceof SyntaxError ? `está corrompido (${e.message})` : `não consegui ler (${e.code || e.message})`;
      log('erro', `Ronda: o resultado ${feito} ${msg}.`);
      return H.erroJson(res, 500, `O resultado do pedido ${msg}. Veja o log do servidor: journalctl -u dgclaw-seguranca-pedidos -n 30`);
    }
    if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') {
      log('erro', `Ronda: o resultado ${feito} não tem o formato esperado.`);
      return H.erroJson(res, 500, 'O resultado do pedido não tem o formato esperado. Veja o log do servidor: journalctl -u dgclaw-seguranca-pedidos -n 30');
    }
    const d = j.dados && typeof j.dados === 'object' && !Array.isArray(j.dados) ? j.dados : null;
    let dados = null;
    if (d) {
      dados = {
        acao: d.acao === 'religar' ? 'religar' : d.acao === 'cortar' ? 'cortar' : null,
        codigo: typeof d.codigo === 'string' && RX_CODIGO.test(d.codigo) ? d.codigo : null,
        expira_em: data(d.expira_em),
        valido_s: inteiro(d.valido_s, 1, 3600),
        plano: validaPlano(d.plano),
      };
    }
    return H.enviaJson(res, 200, {
      ok: true, pendente: false,
      resultado: { ok: j.ok, mensagem: txt(j.mensagem, 2000) || (j.ok ? 'Feito.' : 'O servidor não explicou o motivo da falha. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30'), feito_em: data(j.feito_em) },
      dados,
    });
  }

  // ── emergência ─────────────────────────────────────────────────────────────

  /** { ausente } | { erro } | { emergencia }. */
  function lerEmergencia() {
    const l = lerJson(arqEmergencia, COMO_REFAZER_EMERGENCIA);
    if (l.ausente || l.erro) return l;
    const j = l.json;
    const estado = j && validaEstadoEmergencia(j.estado);
    if (!estado || typeof j.disponivel !== 'boolean') return { erro: `O arquivo ${arqEmergencia} não tem o formato esperado. ${COMO_REFAZER_EMERGENCIA}` };
    const atualizado = data(j.atualizado_em);
    return {
      emergencia: {
        disponivel: j.disponivel,
        motivo: txt(j.motivo, 800),
        avisos: lista(j.avisos, 10).map((x) => txt(x, 500)).filter(Boolean),
        atualizado_em: atualizado,
        desatualizado: !atualizado || relogio() - Date.parse(atualizado) > 2 * 3600 * 1000,
        estado,
        plano: validaPlano(j.plano),
      },
    };
  }

  function estadoEmergencia(res) {
    const l = lerEmergencia();
    if (l.ausente) {
      return H.enviaJson(res, 200, {
        ok: true, desconhecido: true, disponivel: false,
        motivo: 'O servidor ainda não mediu se o botão de emergência pode ser usado. Rode "sudo dgclaw emergencia estado" no servidor.',
      });
    }
    if (l.erro) return falha(res, l);
    return H.enviaJson(res, 200, { ok: true, desconhecido: false, ...l.emergencia });
  }

  async function pedirEmergencia(req, res, sessao, acao) {
    const l = lerEmergencia();
    if (l.erro) return falha(res, l);
    if (acao === 'preparar') {
      if (!l.ausente && l.emergencia.estado.cortado === false && !l.emergencia.disponivel) {
        return H.erroJson(res, 409, `O botão de emergência está indisponível: ${l.emergencia.motivo || 'o servidor não disse o motivo'}`);
      }
      const uuid = gravaPedido({ tipo: 'emergencia-preparar' }, sessao);
      return H.enviaJson(res, 202, { ok: true, pedido: uuid, tipo: 'emergencia-preparar' });
    }
    const corpo = await H.lerJson(req, 4 * 1024);
    const frase = acao === 'cortar' ? FRASE_CORTAR : FRASE_RELIGAR;
    if (corpo.frase !== frase) {
      return H.erroJson(res, 400, `Para ${acao === 'cortar' ? 'tirar o sistema do ar' : 'religar'} é preciso digitar exatamente ${frase} no campo "frase". Recebi: ${typeof corpo.frase === 'string' ? `"${corpo.frase.slice(0, 40)}"` : 'nada'}.`);
    }
    if (typeof corpo.codigo !== 'string' || !RX_CODIGO.test(corpo.codigo)) {
      return H.erroJson(res, 400, 'Falta o "codigo" de 6 letras e números que a etapa "preparar" mostrou. Peça um novo em POST ' + `${BASE}/emergencia/preparar` + '.');
    }
    if (!l.ausente) {
      const e = l.emergencia;
      if (acao === 'cortar' && e.estado.cortado && !e.estado.inconsistente) return H.erroJson(res, 409, 'O sistema já está fora do ar. Use "religar" para voltar ao normal.');
      if (acao === 'cortar' && !e.disponivel) return H.erroJson(res, 409, `O botão de emergência está indisponível: ${e.motivo || 'o servidor não disse o motivo'}`);
      if (acao === 'religar' && !e.estado.cortado) return H.erroJson(res, 409, 'O sistema não está fora do ar, então não há o que religar.');
    }
    const uuid = gravaPedido({ tipo: acao === 'cortar' ? 'emergencia-cortar' : 'emergencia-religar', codigo: corpo.codigo.toUpperCase() }, sessao);
    return H.enviaJson(res, 202, { ok: true, pedido: uuid, tipo: acao === 'cortar' ? 'emergencia-cortar' : 'emergencia-religar' });
  }

  function docs(res) {
    try {
      const t = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RONDA-PAINEL.md'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(t);
    } catch (e) {
      log('erro', `Ronda: não consegui ler docs/RONDA-PAINEL.md (${e.code || e.message}).`);
      H.erroJson(res, 500, 'O documento da ronda de segurança não foi encontrado no servidor. Reinstale o DG Claw Web.');
    }
  }

  /** Devolve true quando tratou o pedido. */
  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    const sub = p.startsWith(`${BASE}/`) ? p.slice(BASE.length) : null;
    if (sub === null || !(sub === '/ronda' || sub.startsWith('/ronda/') || sub.startsWith('/pedidos/') || sub === '/emergencia' || sub.startsWith('/emergencia/'))) return false;
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'A ronda de segurança e o botão de emergência são do dono, pelo painel. Agente não usa esta rota.');
      return true;
    }
    const m = req.method;
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '/ronda') { if (m !== 'GET') return metodoErrado('GET'); listar(res); return true; }
      if (sub === '/ronda/docs.md') { if (m !== 'GET') return metodoErrado('GET'); docs(res); return true; }
      const acao = /^\/ronda\/([^/]+)\/(aplicar|agendar|desfazer)$/.exec(sub);
      if (acao) {
        if (m !== 'POST') return metodoErrado('POST');
        let id;
        try { id = decodeURIComponent(acao[1]); } catch { id = ''; }
        await pedirDoAchado(req, res, sessao, id, acao[2]);
        return true;
      }
      const ped = /^\/pedidos\/([^/]+)$/.exec(sub);
      if (ped) { if (m !== 'GET') return metodoErrado('GET'); resultadoDoPedido(res, ped[1]); return true; }
      if (sub === '/emergencia') { if (m !== 'GET') return metodoErrado('GET'); estadoEmergencia(res); return true; }
      const em = /^\/emergencia\/(preparar|cortar|religar)$/.exec(sub);
      if (em) { if (m !== 'POST') return metodoErrado('POST'); await pedirEmergencia(req, res, sessao, em[1]); return true; }
    } catch (e) {
      if (e.status) { H.erroJson(res, e.status, e.message, e.extra); return true; }
      log('erro', `Ronda: falha inesperada em ${m} ${p}: ${e.stack || e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido da ronda de segurança. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/ronda/docs.md.`);
    return true;
  }

  return { rotas, lerRonda };
}

module.exports = { criarRondaPainel, validaRonda, validaAchado, validaPlano, FRASE_CORTAR, FRASE_RELIGAR };
