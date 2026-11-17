'use strict';
/**
 * integracoes.js: o mapa de integracoes do agente (docs/PLANO-INTEGRACOES-E-VIGIA.md, fase 1).
 *
 *   GET  /api/integracoes              estado de cada integracao, com nome, icone, palavra e skills
 *   POST /api/integracoes/:id/desligar o dono desliga uma integracao no mapa (preferencias.json)
 *   POST /api/integracoes/:id/ligar    desfaz
 *
 * DE ONDE VEM O DADO: o `estado.json` que o comando `dgclaw-integracao registrar` mantem em
 * <agentDir>/.dgclaw/integracoes/ (scripts/_lib/integracoes.py). O painel so LE; quem decide o
 * estado e o modulo Python. Aqui so se recalcula o que depende do relogio (sem uso ha 7 dias).
 *
 * O arquivo e escrito pelo agente, entao e tratado como entrada de fora: arquivo comum, ate
 * 64 KiB, esquema conferido. Qualquer falha vira `medido:false` com o motivo, e NUNCA uma lista
 * verde. "Sem arquivo" e diferente de "arquivo ruim": o primeiro e lista vazia e medido:true.
 *
 * Doc para quem opera por API: panel/docs/INTEGRACOES.md.
 */
const fs = require('fs');
const path = require('path');
const skillsLib = require('./skills');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESULTADOS = ['ok', 'credencial_recusada', 'sem_saldo', 'limite', 'fora_do_ar', 'desconectado', 'rede', 'incerto', 'vencendo', 'erro'];
const ESTADOS = ['verde', 'amarelo', 'vermelho', 'sem_uso_recente'];
const MAX_BYTES = 64 * 1024;
const MAX_ITENS = 50;
const SETE_DIAS_MS = 7 * 24 * 3600 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const PALAVRA = {
  verde: 'Funcionando',
  amarelo: 'Atenção',
  vermelho: 'Com defeito',
  desligado: 'Desligado',
  sem_uso_recente: 'Sem uso recente',
};

const EXPLICA = {
  credencial_recusada: 'A senha de acesso (chave) foi recusada pelo sistema.',
  sem_saldo: 'O saldo ou o crédito acabou.',
  limite: 'O sistema pediu para ir mais devagar: o limite de uso foi atingido.',
  fora_do_ar: 'O sistema está fora do ar ou com problema do lado dele.',
  desconectado: 'A conexão foi encerrada e precisa ser refeita.',
  rede: 'Houve uma falha de internet no caminho.',
  incerto: 'Não deu para confirmar se a operação foi concluída.',
  vencendo: 'O acesso ou o saldo está perto de acabar.',
  erro: 'Deu um erro que não foi possível classificar.',
};

function pastaIntegracoes(CONFIG) {
  return process.env.DGCLAW_INTEGRACOES_DIR || path.join(CONFIG.agentDir, '.dgclaw', 'integracoes');
}

function lerCatalogo(serverDir) {
  const arq = path.join(serverDir, '..', 'templates', 'integracoes', 'catalogo.json');
  try {
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return j && typeof j.integracoes === 'object' && j.integracoes ? j.integracoes : {};
  } catch (e) {
    console.warn(`[painel] não consegui ler o catálogo de integrações em ${arq} (${e.code || e.message}); os nomes saem como o próprio id.`);
    return {};
  }
}

/** Abre sem seguir atalho nem travar em FIFO; confere pelo descritor que e arquivo comum e pequeno. */
function lerArquivoPequeno(arq) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(arq, flags);
  } catch (e) {
    if (e.code === 'ENOENT') return { ausente: true };
    return { erro: `não consegui abrir ${arq} (${e.code || e.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { erro: `${arq} não é um arquivo comum` };
    if (st.size > MAX_BYTES) return { erro: `${arq} tem ${st.size} bytes, acima do limite de ${MAX_BYTES}` };
    const buf = Buffer.alloc(st.size);
    let lidos = 0;
    while (lidos < st.size) {
      const n = fs.readSync(fd, buf, lidos, st.size - lidos, lidos);
      if (n <= 0) break;
      lidos += n;
    }
    return { texto: buf.subarray(0, lidos).toString('utf8') };
  } catch (e) {
    return { erro: `não consegui ler ${arq} (${e.code || e.message})` };
  } finally {
    fs.closeSync(fd);
  }
}

const ehIsoOuNulo = (v) => v === null || (typeof v === 'string' && ISO_RE.test(v));

/** Confere o esquema do estado.json. Devolve { itens } ou { erro }. */
function validarEstado(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.versao !== 1 || !Array.isArray(j.integracoes)) {
    return { erro: 'o estado.json não tem o formato esperado (versão 1 com a lista de integrações)' };
  }
  if (j.integracoes.length > MAX_ITENS) return { erro: `o estado.json lista mais de ${MAX_ITENS} integrações` };
  const itens = [];
  const vistos = new Set();
  for (const it of j.integracoes) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !ID_RE.test(it.id) || vistos.has(it.id) || !ESTADOS.includes(it.estado)
        || !RESULTADOS.includes(it.ultimoResultado) || typeof it.ultimoEvento !== 'string' || !ISO_RE.test(it.ultimoEvento)
        || !ehIsoOuNulo(it.ultimoOk ?? null) || !ehIsoOuNulo(it.ultimaFalha ?? null)
        || !(it.ultimaFalhaResultado == null || RESULTADOS.includes(it.ultimaFalhaResultado))) {
      return { erro: 'o estado.json tem uma integração fora do formato (id, estado, resultado ou data inválidos)' };
    }
    vistos.add(it.id);
    itens.push(it);
  }
  return { itens };
}

/** Ausente: []. Existe mas está ilegível ou inválido: null (quem grava não pode partir de lista vazia). */
function lerDesligadas(dir) {
  const arq = path.join(dir, 'preferencias.json');
  const r = lerArquivoPequeno(arq);
  if (r.ausente) return [];
  if (r.erro) {
    console.warn(`[painel] ignorei as preferências de integrações: ${r.erro}.`);
    return null;
  }
  try {
    const j = JSON.parse(r.texto);
    if (!j || typeof j !== 'object' || !Array.isArray(j.desligadas)) {
      console.warn(`[painel] ignorei ${arq}: não tem a lista "desligadas".`);
      return null;
    }
    return j.desligadas.filter((x) => typeof x === 'string' && ID_RE.test(x));
  } catch (e) {
    console.warn(`[painel] ignorei ${arq}: o JSON está quebrado (${e.message}).`);
    return null;
  }
}

function gravarDesligadas(dir, lista) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const arq = path.join(dir, 'preferencias.json');
  const tmp = `${arq}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ desligadas: lista }, null, 1) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, arq);
}

/** Monta a resposta do GET. `agora` e injetavel para teste. */
function montar(CONFIG, serverDir, agora = new Date()) {
  const base = { ok: true, agente: { nome: CONFIG.agentName, slug: CONFIG.agentSlug } };
  const dir = pastaIntegracoes(CONFIG);
  const lido = lerArquivoPequeno(path.join(dir, 'estado.json'));
  if (lido.ausente) return { ...base, integracoes: [], medido: true };
  if (lido.erro) return { ...base, integracoes: [], medido: false, motivo: `Não foi possível medir as integrações: ${lido.erro}.` };
  let j;
  try { j = JSON.parse(lido.texto); } catch (e) {
    return { ...base, integracoes: [], medido: false, motivo: `Não foi possível medir as integrações: o estado.json está com o JSON quebrado (${e.message}).` };
  }
  const v = validarEstado(j);
  if (v.erro) return { ...base, integracoes: [], medido: false, motivo: `Não foi possível medir as integrações: ${v.erro}.` };

  const catalogo = lerCatalogo(serverDir);
  const desligadas = new Set(lerDesligadas(dir) || []);
  const skillsPorId = {};
  try {
    for (const sk of skillsLib.listar(CONFIG.agentDir, process.env.DGCLAW_PANEL_SKILLS_DIR).skills) {
      for (const id of sk.integracoes || []) (skillsPorId[id] = skillsPorId[id] || []).push(sk.nome);
    }
  } catch (e) {
    console.warn(`[painel] não consegui ler as skills para anotar as integrações (${e.message}).`);
  }

  const integracoes = v.itens.map((it) => {
    let estado = it.estado;
    if (estado !== 'sem_uso_recente' && agora.getTime() - Date.parse(it.ultimoEvento) > SETE_DIAS_MS) estado = 'sem_uso_recente';
    if (desligadas.has(it.id)) estado = 'desligado';
    const cat = Object.prototype.hasOwnProperty.call(catalogo, it.id) ? catalogo[it.id] : null;
    const falhaRes = it.ultimaFalhaResultado || null;
    return {
      id: it.id,
      nome: (cat && cat.nome) || it.id,
      icone: (cat && cat.icone) || 'link',
      estado,
      palavra: PALAVRA[estado],
      ultimoEvento: it.ultimoEvento,
      ultimoOk: it.ultimoOk ?? null,
      ultimaFalha: it.ultimaFalha ?? null,
      ultimaFalhaResultado: falhaRes,
      ultimaFalhaExplica: falhaRes ? EXPLICA[falhaRes] : null,
      skills: skillsPorId[it.id] || [],
    };
  });
  return { ...base, integracoes, medido: true };
}

function registrar(router, { CONFIG, serverDir }) {
  router.get('/api/integracoes', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(montar(CONFIG, serverDir));
    } catch (e) {
      console.error('[painel] /api/integracoes quebrou:', e);
      res.status(500).json({ error: `Não consegui montar o mapa de integrações: ${e.message}`, howToFix: 'Recarregue a página. Se continuar, o registro do painel diz o motivo.' });
    }
  });

  function mudar(desligar) {
    return (req, res) => {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) {
        return res.status(400).json({ error: `O id "${id.slice(0, 40)}" não é válido para uma integração.`, howToFix: 'Use de 1 a 32 caracteres: letras minúsculas, números e hífen (exemplo: instagram, nota-fiscal).' });
      }
      const dir = pastaIntegracoes(CONFIG);
      try {
        const atual = lerDesligadas(dir);
        if (atual === null) {
          return res.status(409).json({ error: `Não gravei a preferência da integração ${id}: o arquivo preferencias.json em ${dir} existe, mas está ilegível ou fora do formato, e gravar agora apagaria o que ele guarda.`, howToFix: 'Peça ao Admin para conferir o arquivo preferencias.json dessa pasta (ou apague-o se não precisar do que ele guarda) e tente de novo.' });
        }
        const set = new Set(atual);
        if (desligar) set.add(id); else set.delete(id);
        gravarDesligadas(dir, [...set].sort());
        res.json({ ok: true, id, desligada: desligar });
      } catch (e) {
        console.error(`[painel] não consegui gravar as preferências de integrações em ${dir}:`, e);
        res.status(500).json({ error: `Não consegui gravar a preferência da integração ${id} em ${dir}: ${e.message}`, howToFix: 'Confira se a pasta existe e se o painel pode escrever nela.' });
      }
    };
  }
  router.post('/api/integracoes/:id/desligar', mudar(true));
  router.post('/api/integracoes/:id/ligar', mudar(false));
}

module.exports = { registrar, montar, validarEstado, PALAVRA, EXPLICA, MAX_BYTES };
