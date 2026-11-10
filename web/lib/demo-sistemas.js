'use strict';
// Página "Sistemas conectados" do modo demonstração: mede de verdade cada sistema ligado ao agente
// (runner, linhas de WhatsApp, e-mail, CRM, geração de imagens) e devolve o estado em GET /api/demo/sistemas.
// Regra de ouro: o que não foi medido nunca vira "conectado". Sem rota de status, é "nao_medido" com o motivo.
// O demo.json é lido aqui por conta própria (o contrato está em docs/MODO-DEMONSTRACAO.md).

const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');

const PRAZO_MS = 6000;
const CACHE_MS = 20000;
const URL_OPENAI = 'https://api.openai.com/v1/models';
const STATUS_CONECTADO = new Set(['connected', 'open', 'online', 'conectado']);
const STATUS_CAIDO = new Set(['disconnected', 'close', 'closed', 'offline', 'logout', 'logged_out', 'desconectado', 'error', 'banned']);

/** Lê e valida o mínimo do demo.json. Devolve { ok:true, config } ou { ok:false, erro }. */
function carregar(caminho) {
  if (!caminho) return { ok: false, erro: 'DGCLAW_DEMO_CONFIG não está definida.' };
  let bruto;
  try { bruto = fs.readFileSync(caminho, 'utf8'); } catch (e) {
    return { ok: false, erro: `Não consegui ler o demo.json em ${caminho} (${e.code || e.message}). Confira se o arquivo existe e se este serviço tem permissão de leitura.` };
  }
  let c;
  try { c = JSON.parse(bruto); } catch (e) {
    return { ok: false, erro: `O demo.json em ${caminho} não é um JSON válido (${e.message}).` };
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, erro: 'O demo.json precisa ser um objeto JSON.' };
  if (typeof c.agente !== 'string' || !c.agente) return { ok: false, erro: 'O demo.json não tem o campo "agente" (o slug do agente da demonstração).' };
  if (c.linhas_whatsapp != null && !Array.isArray(c.linhas_whatsapp)) return { ok: false, erro: 'No demo.json, "linhas_whatsapp" precisa ser uma lista.' };
  for (const l of c.linhas_whatsapp || []) {
    if (!l || typeof l.id !== 'string' || !l.id) return { ok: false, erro: 'No demo.json, toda linha de WhatsApp precisa de "id".' };
  }
  return { ok: true, config: c };
}

/** Troca números longos por "final NNNN" e remove o valor da chave, se por acaso aparecer. */
function limpar(texto, segredos) {
  let t = String(texto == null ? '' : texto);
  for (const s of segredos || []) if (s && s.length >= 6) t = t.split(s).join('[chave]');
  return t.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => `final ${m.replace(/\D/g, '').slice(-4)}`);
}

function criarDemoSistemas({ env, runner, registro, avatarDe, log, fetchFn, agora, prazoMs, cacheMs }) {
  const ler = carregar((env || {}).DGCLAW_DEMO_CONFIG);
  const config = ler.ok ? ler.config : null;
  if (!ler.ok && (env || {}).DGCLAW_DEMO_CONFIG) log('erro', `Modo demonstração desligado: ${ler.erro}`);
  const buscar = fetchFn || ((url, op) => fetch(url, op));
  const hora = agora || (() => Date.now());
  const prazo = prazoMs || PRAZO_MS;
  const validade = cacheMs == null ? CACHE_MS : cacheMs;
  let cache = null; // { quando, corpo }
  let voo = null;

  const ativo = () => !!config;

  /** fetch com prazo: aborta o pedido e também desiste da espera se o provedor ignorar o sinal. */
  async function pedir(url, headers) {
    const ctl = new AbortController();
    let timer;
    const estouro = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error('prazo'), { prazo: true })); }, prazo); });
    try { return await Promise.race([buscar(url, { headers, signal: ctl.signal }), estouro]); } finally { clearTimeout(timer); }
  }

  const motivoDeRede = (rotulo, e) => (e && e.prazo
    ? `${rotulo} não respondeu em ${Math.round(prazo / 100) / 10} s.`
    : `Não consegui falar com ${rotulo} (${(e && (e.cause && e.cause.code || e.code || e.name)) || 'erro de rede'}).`);

  function lerChave(arquivo, rotulo) {
    if (!arquivo) return { erro: `O demo.json não indica o arquivo da chave de ${rotulo}.` };
    try {
      const v = fs.readFileSync(arquivo, 'utf8').trim();
      if (!v) return { erro: `O arquivo da chave de ${rotulo} (${path.basename(arquivo)}) está vazio.` };
      return { chave: v };
    } catch (e) {
      return { erro: `Não achei a chave de ${rotulo}: o arquivo ${path.basename(arquivo)} ${e.code === 'ENOENT' ? 'não existe' : `não pôde ser lido (${e.code || e.message})`}.` };
    }
  }

  const sis = (id, rotulo, tipo, estado, motivo, detalhe) => ({ id, rotulo, tipo, estado, motivo: motivo || null, detalhe: detalhe || null });
  const naoMedido = (id, rotulo, tipo, motivo) => sis(id, rotulo, tipo, 'nao_medido', motivo);

  async function medirAgente(agente) {
    const rotulo = 'Agente';
    if (!agente) return sis('agente', rotulo, 'agente', 'caido', `O agente "${config.agente}" do demo.json não está no registro deste painel.`);
    const r = await runner.estado(agente);
    if (!r.ok) return sis('agente', rotulo, 'agente', 'caido', limpar(r.erro || 'O runner não respondeu.'));
    const st = String((r.estado && r.estado.status) || '').toLowerCase();
    if (/^(stopped|dead|exited|error|errored|crashed|offline|failed)$/.test(st)) return sis('agente', rotulo, 'agente', 'caido', `O runner respondeu, mas a sessão do agente está "${st}".`);
    return sis('agente', rotulo, 'agente', 'conectado', null, st ? `Sessão: ${st}` : 'Sessão viva');
  }

  async function medirOrganizap(id, rotulo, tipo, base, arquivoChave, instanciaId) {
    const k = lerChave(arquivoChave, rotulo);
    if (k.erro) return naoMedido(id, rotulo, tipo, k.erro);
    let r;
    try {
      r = await pedir(`${String(base).replace(/\/+$/, '')}/instances`, { Authorization: `Bearer ${k.chave}`, Accept: 'application/json' });
    } catch (e) { return sis(id, rotulo, tipo, 'caido', limpar(motivoDeRede('o Organizap', e), [k.chave])); }
    if (r.status === 401) return sis(id, rotulo, tipo, 'caido', 'O Organizap recusou a chave (401). Gere uma chave nova e troque o arquivo.');
    if (r.status === 403) return naoMedido(id, rotulo, tipo, 'A chave não tem permissão de ver as instâncias (403), então não dá para confirmar.');
    if (!r.ok) return sis(id, rotulo, tipo, 'caido', `O Organizap respondeu ${r.status} ao pedir as instâncias.`);
    let corpo;
    try { corpo = await r.json(); } catch (e) { return naoMedido(id, rotulo, tipo, 'O Organizap respondeu algo que não é JSON.'); }
    const lista = Array.isArray(corpo && corpo.data) ? corpo.data : null;
    if (!lista) return naoMedido(id, rotulo, tipo, 'O Organizap respondeu sem a lista de instâncias.');
    let inst = instanciaId ? lista.find((i) => i && i.id === instanciaId) : (lista.length === 1 ? lista[0] : null);
    if (!inst) {
      return naoMedido(id, rotulo, tipo, instanciaId
        ? 'A instância indicada no demo.json não apareceu na lista do Organizap.'
        : `O Organizap devolveu ${lista.length} instâncias e o demo.json não diz qual é desta linha (campo "instancia_id").`);
    }
    inst = inst || {};
    const st = String(inst.status || '').toLowerCase();
    const detalhe = limpar(inst.phoneNumber ? `${inst.name || 'Instância'}, ${inst.phoneNumber}` : (inst.name || ''), [k.chave]) || null;
    if (STATUS_CAIDO.has(st)) return sis(id, rotulo, tipo, 'caido', `A instância está "${st}". Reconecte o WhatsApp pelo Organizap (leia o QR code de novo).`, detalhe);
    if (!STATUS_CONECTADO.has(st)) return naoMedido(id, rotulo, tipo, `A instância devolveu o status "${limpar(st).slice(0, 30) || 'vazio'}", que eu não sei interpretar.`);
    if (inst.canSend !== true) return sis(id, rotulo, tipo, 'caido', 'A instância está conectada, mas esta chave não pode enviar por ela (canSend falso).', detalhe);
    return sis(id, rotulo, tipo, 'conectado', null, detalhe);
  }

  async function medirLinha(l) {
    const rotulo = l.rotulo || l.id;
    if (l.tipo === 'organizap') return medirOrganizap(`whatsapp-${l.id}`, rotulo, 'whatsapp', l.base, l.chave_arquivo, l.instancia_id);
    if (l.tipo === 'cpdf') return naoMedido(`whatsapp-${l.id}`, rotulo, 'whatsapp', 'O provedor desta linha não tem rota de status da instância liberada para o painel, então a conexão não é medida.');
    return naoMedido(`whatsapp-${l.id}`, rotulo, 'whatsapp', `Tipo de linha "${limpar(l.tipo).slice(0, 30)}" que o painel não sabe medir.`);
  }

  function medirEmail(e) {
    const rotulo = (e && e.rotulo) || 'E-mail';
    if (!e) return naoMedido('email', rotulo, 'email', 'O demo.json não configura o e-mail.');
    return naoMedido('email', rotulo, 'email', 'A API do provedor não tem rota de status da conta de e-mail liberada para a chave do agente, então a conexão não é medida.');
  }

  async function medirCrm(c) {
    const rotulo = (c && c.rotulo) || 'CRM';
    if (!c || !c.url_saude) return naoMedido('crm', rotulo, 'crm', 'O demo.json não indica a URL de saúde do CRM (crm.url_saude).');
    let r;
    try { r = await pedir(c.url_saude, { Accept: 'application/json' }); } catch (e) { return sis('crm', rotulo, 'crm', 'caido', motivoDeRede('o CRM', e)); }
    if (!r.ok) return sis('crm', rotulo, 'crm', 'caido', `O CRM respondeu ${r.status} na verificação de saúde.`);
    let corpo = null;
    try { corpo = await r.json(); } catch (_) { /* corpo que não é JSON cai na mensagem abaixo */ }
    if (!corpo || corpo.ok !== true) return sis('crm', rotulo, 'crm', 'caido', 'O CRM respondeu 200, mas sem "ok": true na verificação de saúde.');
    return sis('crm', rotulo, 'crm', 'conectado');
  }

  async function medirImagem(i) {
    const rotulo = (i && i.rotulo) || 'Geração de imagens';
    const k = lerChave(i && i.chave_arquivo, rotulo);
    if (k.erro) return naoMedido('imagem', rotulo, 'imagem', k.erro);
    let r;
    try { r = await pedir(URL_OPENAI, { Authorization: `Bearer ${k.chave}` }); } catch (e) { return sis('imagem', rotulo, 'imagem', 'caido', limpar(motivoDeRede('a OpenAI', e), [k.chave])); }
    if (r.status === 200) return sis('imagem', rotulo, 'imagem', 'conectado');
    if (r.status === 401) return sis('imagem', rotulo, 'imagem', 'caido', 'A OpenAI recusou a chave (401). Troque a chave no arquivo.');
    if (r.status === 403) return naoMedido('imagem', rotulo, 'imagem', 'A chave existe, mas não tem permissão de listar modelos (403), então não dá para confirmar que ela gera imagens.');
    if (r.status === 429) return naoMedido('imagem', rotulo, 'imagem', 'A OpenAI limitou os pedidos (429) e a chave não pôde ser conferida agora.');
    return sis('imagem', rotulo, 'imagem', 'caido', `A OpenAI respondeu ${r.status} ao conferir a chave.`);
  }

  /** Uma checagem que quebra vira "caido" com a causa, sem derrubar as outras. */
  async function protegido(id, rotulo, tipo, fn) {
    try { return await fn(); } catch (e) {
      log('erro', `Sistemas conectados: a checagem de "${id}" falhou por erro inesperado: ${e.message}`);
      return sis(id, rotulo, tipo, 'caido', `A checagem falhou por um erro inesperado (${limpar(e.message).slice(0, 80)}). Veja o log do painel.`);
    }
  }

  async function medir() {
    const agente = registro.obter(config.agente);
    const medidoEm = new Date(hora()).toISOString();
    const tarefas = [protegido('agente', 'Agente', 'agente', () => medirAgente(agente))];
    for (const l of config.linhas_whatsapp || []) tarefas.push(protegido(`whatsapp-${l.id}`, l.rotulo || l.id, 'whatsapp', () => medirLinha(l)));
    if (config.email) tarefas.push(protegido('email', config.email.rotulo || 'E-mail', 'email', async () => medirEmail(config.email)));
    if (config.crm) tarefas.push(protegido('crm', config.crm.rotulo || 'CRM', 'crm', () => medirCrm(config.crm)));
    if (config.imagem) tarefas.push(protegido('imagem', config.imagem.rotulo || 'Geração de imagens', 'imagem', () => medirImagem(config.imagem)));
    const sistemas = (await Promise.all(tarefas)).map((s) => Object.assign(s, { medido_em: medidoEm }));
    const info = (agente && avatarDe ? avatarDe(agente) : null) || {};
    return {
      ok: true, medido_em: medidoEm,
      agente: { nome: agente ? agente.nome : config.agente, avatar_url: info.avatar_img || null, letra: (agente && agente.nome ? agente.nome[0] : config.agente[0] || '?').toUpperCase(), cor: (agente && agente.cor) || null },
      sistemas,
    };
  }

  /** Cache de 20 s; pedidos simultâneos dividem a mesma medição. */
  function sistemas() {
    if (cache && hora() - cache.quando < validade) return Promise.resolve(cache.corpo);
    if (!voo) {
      voo = medir().then((corpo) => { cache = { quando: hora(), corpo }; return corpo; }).finally(() => { voo = null; });
    }
    return voo;
  }

  /** Trata GET /api/demo/sistemas. Devolve true se a rota era esta. */
  async function rota(req, res, url, sessao) {
    if (url.pathname !== '/api/demo/sistemas') return false;
    if (!ativo()) { H.erroJson(res, 404, 'O modo demonstração não está ligado neste painel.'); return true; }
    if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para ver os sistemas conectados. Faça login em /login.'); return true; }
    if (req.method !== 'GET') { H.erroJson(res, 405, 'Use GET para ver o estado dos sistemas conectados.'); return true; }
    try { H.enviaJson(res, 200, await sistemas()); } catch (e) {
      log('erro', `Sistemas conectados: a medição falhou: ${e.message}`);
      H.erroJson(res, 500, `Não consegui medir os sistemas: ${limpar(e.message).slice(0, 120)}. Veja o log do painel.`);
    }
    return true;
  }

  return { ativo, rota, sistemas };
}

module.exports = { criarDemoSistemas, carregar, limpar };
