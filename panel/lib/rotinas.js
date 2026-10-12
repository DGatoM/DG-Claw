'use strict';
/**
 * rotinas.js: a agenda do agente, lida do systemd.
 *
 * REGRA DESTE ARQUIVO: a fonte da verdade e o systemd, nunca uma lista escrita a mao.
 * O painel pergunta pra maquina quais timers do agente existem AGORA. Criou uma rotina,
 * ela aparece no proximo carregamento; apagou, ela some. Nao existe caso de "sumiu o cron
 * mas o painel ainda mostra", porque nao ha nada guardado aqui pra ficar desatualizado.
 *
 * Duas familias, mesmo lugar:
 *   - rotinas de VIDA: as que o plugin instala junto com o agente (reflexao noturna,
 *     auditoria, batimento, pulso). Nome `dgclaw-<slug>-<coisa>`.
 *   - rotinas MARCADAS pelo agente: as que ele mesmo cria quando o dono pede, pelo
 *     persona-cron-mgr.py. Nome `dgclaw-<slug>-self-<coisa>`.
 *
 * O manifesto (.dgclaw/self-crons.json) entra so pra enfeitar: dele vem o RECADO que o
 * agente vai receber quando a rotina disparar. Se o manifesto discordar do systemd, quem
 * manda e o systemd, e a diferenca e reportada em `inconsistencias` em vez de escondida.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROPS = [
  'Id', 'Description', 'ActiveState', 'UnitFileState', 'NextElapseUSecRealtime',
  'LastTriggerUSec', 'TimersCalendar', 'TimersMonotonic', 'Unit',
];

/**
 * Pergunta ao systemctl SEM travar o painel.
 *
 * ATÉ 01/10/2026 ISTO ERA `execFileSync`, um por timer. Com 13 timers eram 15
 * chamadas seguidas, cada uma com teto de 6 s, e durante todas elas o Node não
 * atendia mais ninguém: nem a Conversa, nem o selo de saúde, nem o login. A
 * vistoria de 01/10 achou isso (docs/VISTORIA-2026-10-01.md, 2.2). Agora é
 * assíncrono, e as propriedades de todos os timers vêm numa chamada só.
 *
 * Devolve { saida, falhou, motivo }. `falhou` separa "o systemctl respondeu que
 * não há nada" (código 1 e saída vazia, que é como o list-unit-files diz "nenhum
 * casamento") de "o systemctl não respondeu", que é defeito e precisa chegar na
 * tela com o motivo, em vez de virar "nada marcado nesta máquina".
 */
function systemctl(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('systemctl', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ saida: stdout || '', falhou: false, motivo: null });
      if (err.code === 'ENOENT') {
        return resolve({ saida: '', falhou: true, motivo: 'esta máquina não tem systemctl (o painel não está rodando num sistema com systemd)' });
      }
      // list-unit-files sem nenhum casamento sai com código 1 e stdout vazio: não é erro.
      if (err.code === 1 && !String(stderr || '').trim()) return resolve({ saida: stdout || '', falhou: false, motivo: null });
      resolve({
        saida: stdout || '',
        falhou: !(stdout || '').trim(),
        motivo: `o systemctl ${args[0]} falhou (${String(stderr || err.message || '').trim().slice(0, 200) || 'sem detalhe'})`,
      });
    });
  });
}

/**
 * `systemctl show` de VÁRIAS unidades numa chamada só. A saída vem em blocos
 * separados por linha em branco, um por unidade, e é o `Id=` que diz de quem é
 * cada bloco (a ordem das propriedades dentro do bloco não é a pedida).
 * Devolve {unit: {chave: [valores]}}; uma chave pode repetir (TimersMonotonic).
 */
async function propriedadesEmLote(units) {
  if (!units.length) return {};
  const r = await systemctl(['show', ...units, '--no-pager', '-p', PROPS.join(',')]);
  const porUnit = {};
  for (const bloco of r.saida.split(/\n\s*\n/)) {
    const mapa = {};
    for (const linha of bloco.split('\n')) {
      const i = linha.indexOf('=');
      if (i < 1) continue;
      (mapa[linha.slice(0, i)] = mapa[linha.slice(0, i)] || []).push(linha.slice(i + 1));
    }
    const id = mapa.Id && mapa.Id[0];
    if (id) porUnit[id] = mapa;
  }
  return porUnit;
}

function primeiro(mapa, chave) {
  const v = mapa[chave];
  return v && v.length ? v[0] : '';
}

/** Data do systemd ("Thu 2026-08-06 17:41:38 -03") em ISO. Vazio ou "n/a" vira null. */
function paraISO(texto) {
  if (!texto || /^n\/a$/i.test(texto.trim())) return null;
  const d = new Date(texto.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Quando cada timer roda de novo, numa chamada so.
 *
 * `systemctl show` nao serve aqui: pra timer de intervalo (a cada 1h) ele devolve o proximo
 * disparo em tempo desde o boot ("1month 30min"), que so vira data com a hora de boot na mao.
 * O `list-timers --output=json` ja entrega microssegundos desde 1970 pros dois tipos.
 */
async function horarios(slug) {
  const bruto = (await systemctl(['list-timers', `dgclaw-${slug}-*`, '--all', '--output=json', '--no-pager'])).saida;
  const mapa = {};
  let lista;
  try {
    lista = JSON.parse(bruto || '[]');
  } catch {
    return mapa; // systemd velho sem --output=json: seguimos sem as datas
  }
  const emISO = (usec) => (usec && usec > 0 ? new Date(usec / 1000).toISOString() : null);
  for (const t of (Array.isArray(lista) ? lista : [])) {
    if (t && t.unit) mapa[t.unit] = { proxima: emISO(t.next), ultima: emISO(t.last) };
  }
  return mapa;
}

const DIAS = { Mon: 'segunda', Tue: 'terça', Wed: 'quarta', Thu: 'quinta', Fri: 'sexta', Sat: 'sábado', Sun: 'domingo' };

/**
 * Traduz o horario do systemd pra uma frase que o dono entende.
 * So traduz as formas que reconhece COM CERTEZA; qualquer outra coisa volta crua, porque
 * inventar uma frase bonita pra um horario que eu nao entendi seria mentir sobre quando a
 * rotina roda.
 */
function emPortugues(spec) {
  if (!spec) return '';
  // O horario pode vir carimbado com o fuso do dono ("*-*-* 17:00:00 America/Sao_Paulo").
  // Pra frase, o fuso nao interessa: ele existe justamente pra que a hora escrita SEJA a
  // hora do dono. Tiro o carimbo antes de traduzir e nao mostro na tela.
  const s = spec.trim().replace(/\s+(?:[A-Za-z]+\/[A-Za-z_+-]+|UTC)$/, '');

  // a cada X (timer monotonico)
  const m = s.match(/^cada:(.+)$/);
  if (m) {
    const g = m[1].trim().match(/^(\d+)(min|h|s|d)$/);
    if (g) {
      const n = Number(g[1]);
      const nomes = { min: ['minuto', 'minutos'], h: ['hora', 'horas'], s: ['segundo', 'segundos'], d: ['dia', 'dias'] };
      const [um, varios] = nomes[g[2]];
      return n === 1 ? `a cada ${um}` : `a cada ${n} ${varios}`;
    }
    return `a cada ${m[1].trim()}`;
  }

  // todo dia num horario: *-*-* 23:30:00
  let g = s.match(/^\*-\*-\* (\d{2}):(\d{2})(?::\d{2})?$/);
  if (g) return `todo dia às ${g[1]}:${g[2]}`;

  // dias da semana: Mon..Fri *-*-* 09:00:00  /  Mon *-*-* 09:00:00
  g = s.match(/^([A-Z][a-z]{2})(?:\.\.([A-Z][a-z]{2}))? \*-\*-\* (\d{2}):(\d{2})(?::\d{2})?$/);
  if (g) {
    const de = DIAS[g[1]] || g[1];
    const ate = g[2] ? DIAS[g[2]] || g[2] : null;
    const quando = ate ? `de ${de} a ${ate}` : `toda ${de}`;
    return `${quando}, às ${g[3]}:${g[4]}`;
  }

  // dia fixo do mes: *-*-05 09:00:00
  g = s.match(/^\*-\*-(\d{2}) (\d{2}):(\d{2})(?::\d{2})?$/);
  if (g) return `todo dia ${Number(g[1])} do mês, às ${g[2]}:${g[3]}`;

  // atalhos do systemd
  if (s === 'daily') return 'todo dia à meia-noite';
  if (s === 'hourly') return 'de hora em hora';
  if (s === 'weekly') return 'toda segunda, à meia-noite';
  if (s === 'monthly') return 'todo dia 1º do mês';

  return s; // nao reconheci: mostro o horario cru, sem inventar
}

/** Extrai o horario configurado (calendario ou intervalo) das props do timer. */
function horario(mapa) {
  for (const v of (mapa.TimersCalendar || [])) {
    const g = v.match(/OnCalendar=([^;}]+)/);
    if (g) return g[1].trim();
  }
  for (const v of (mapa.TimersMonotonic || [])) {
    // OnBootUSec e so o empurrao inicial depois do boot: nao e o ritmo da rotina.
    const g = v.match(/OnUnitActiveUSec=([^;}]+)/);
    if (g) return 'cada:' + g[1].trim();
  }
  return '';
}

/** Lê o manifesto dos crons que o proprio agente marcou (só pra pegar o recado e a descricao). */
function lerManifesto(workspace) {
  const arq = path.join(workspace, '.dgclaw', 'self-crons.json');
  let bruto;
  try {
    bruto = fs.readFileSync(arq, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[painel] nao consegui ler ${arq} (${err.code}): ${err.message}. ` +
        `As rotinas marcadas pelo agente aparecem sem o recado.`);
    }
    return {};
  }
  // O arquivo vem cercado por marcadores de texto; o JSON e o miolo.
  const ini = bruto.indexOf('{');
  const fim = bruto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return {};
  try {
    return (JSON.parse(bruto.slice(ini, fim + 1)).crons) || {};
  } catch (e) {
    console.warn(`[painel] ${arq} nao e JSON valido (${e.message}). ` +
      `Mostro as rotinas do systemd sem o recado de cada uma.`);
    return {};
  }
}

/**
 * A agenda completa do agente, como ela esta na maquina neste instante.
 * Nunca rejeita: sem systemd (ou sem permissao) devolve lista vazia COM o motivo
 * em `erro`, para a tela dizer "não consegui ler" em vez de "nada marcado".
 *
 * Cache de 30 s por agente. A tela pede a agenda a cada minuto e a aba Operações
 * também a usa; perguntar ao systemd mais vezes que isso só gasta processo para
 * devolver a mesma lista. Chamadas simultâneas dividem a mesma pergunta.
 */
const _cacheListar = new Map(); // slug -> { em, promessa }
const CACHE_LISTAR_MS = 30000;

function listar(slug, workspace) {
  const chave = `${slug}::${workspace}`;
  const c = _cacheListar.get(chave);
  if (c && Date.now() - c.em < CACHE_LISTAR_MS) return c.promessa;
  const promessa = listarAgora(slug, workspace).catch((e) => ({
    rotinas: [], inconsistencias: [], total: 0,
    erro: `nao consegui ler a agenda no systemd: ${e.message}`,
  }));
  _cacheListar.set(chave, { em: Date.now(), promessa });
  return promessa;
}

async function listarAgora(slug, workspace) {
  if (!slug) return { rotinas: [], inconsistencias: [], erro: 'agente sem slug na config do painel' };

  const lista = await systemctl(['list-unit-files', `dgclaw-${slug}-*.timer`, '--no-legend', '--no-pager']);
  if (lista.falhou) return { rotinas: [], inconsistencias: [], total: 0, erro: lista.motivo };
  const units = lista.saida.split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && u.endsWith('.timer'));

  const manifesto = lerManifesto(workspace);
  const [quando, props] = await Promise.all([horarios(slug), propriedadesEmLote(units)]);
  const prefixoSelf = `dgclaw-${slug}-self-`;
  const rotinas = [];
  const vistas = new Set();

  for (const unit of units) {
    const mapa = props[unit] || {};
    const base = unit.replace(/\.timer$/, '');
    const marcada = base.startsWith(prefixoSelf);
    const nomeCurto = marcada ? base.slice(prefixoSelf.length) : base.slice(`dgclaw-${slug}-`.length);
    if (marcada) vistas.add(nomeCurto);
    const doManifesto = marcada ? (manifesto[nomeCurto] || {}) : {};
    const spec = horario(mapa);
    const ativo = primeiro(mapa, 'ActiveState') === 'active';

    rotinas.push({
      unit,
      nome: nomeCurto,
      tipo: marcada ? 'marcada' : 'vida',
      ativo,
      estado: primeiro(mapa, 'ActiveState') || 'desconhecido',
      instalada: primeiro(mapa, 'UnitFileState') || '',
      horario: spec,
      quando: emPortugues(spec),
      proxima: (quando[unit] || {}).proxima || paraISO(primeiro(mapa, 'NextElapseUSecRealtime')),
      ultima: (quando[unit] || {}).ultima || paraISO(primeiro(mapa, 'LastTriggerUSec')),
      descricao: doManifesto.desc || primeiro(mapa, 'Description') || '',
      recado: doManifesto.poke || null,
    });
  }

  // Manifesto que promete uma rotina que o systemd nao tem: mostrar, nao esconder.
  const inconsistencias = Object.keys(manifesto)
    .filter((nome) => !vistas.has(nome))
    .map((nome) => ({
      nome,
      motivo: 'está no manifesto do agente, mas não existe timer no systemd. ' +
        'A rotina NÃO vai rodar até ser criada de novo.',
    }));

  rotinas.sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === 'marcada' ? -1 : 1;
    return (a.proxima || '9999').localeCompare(b.proxima || '9999');
  });

  return { rotinas, inconsistencias, total: rotinas.length };
}

module.exports = { listar, emPortugues };
