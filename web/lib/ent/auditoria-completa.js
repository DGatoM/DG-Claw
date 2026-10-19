'use strict';
// Bloco G do enterprise, parte 2: auditoria completa e externa. Guia em docs/enterprise/SSO-AUDITORIA.md.
//
// Com `auditoria` = completa (ou externa) este módulo registra, além dos eventos básicos:
//   api_mutacao       toda escrita na API (método, rota sem valores de query, status, quem, agente alvo)
//   painel_aberto     abertura de /p/<slug>/ (só as que deram certo)
//   midia_baixada     download explícito de mídia (?baixar=1)
//   agente_comando    cada comando de máquina que um agente roda (título já mascarado; nunca a saída)
//   auditoria_exportada
// A origem "controle" (serviço de controle do bloco C) já é aceita pela trilha; o que ele grava entra na mesma corrente.
// Com `auditoria` = externa, um temporizador entrega a corrente ao destino da empresa (web/lib/auditoria-externa.js).
//
// Rotas (todas só para o TI, e só com auditoria ligada): GET /auditoria (tela), GET /api/v1/auditoria (lista, filtros,
// integridade), GET /api/v1/auditoria/exportar (jsonl ou csv), GET /api/v1/auditoria/externa (estado do envio).

const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const corrente = require('../auditoria-corrente');
const { criarExterna, ErroExterna } = require('../auditoria-externa');
const trilha = require('../trilha');

const ESCREVE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const POR_PADRAO = 50;
const POR_MAX = 200;
const INTERVALO_EXTERNA_MS = 30 * 1000;
const IDS_POR_EP_MAX = 200;

const curto = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

module.exports = {
  nome: 'auditoria-completa',
  ordem: 90,
  criar(ctx) {
    const { config, log, protecoes, auditoria, servirArquivo, semSessaoPagina } = ctx;
    const relogio = ctx.agora ? () => { const a = ctx.agora(); return a instanceof Date ? a.getTime() : Number(a); } : () => Date.now();
    const teste = ctx.auditoriaExterna || {};
    const base = config.auditoriaPath || '/var/log/dgclaw/auditoria.jsonl';
    const dataDir = config.dataDir || '/var/lib/dgclaw/web';
    const protecoesPath = config.protecoesPath || '/etc/dgclaw/protecoes.json';
    const nivel = () => protecoes.valor('auditoria');
    const completa = () => { const n = nivel(); return n === 'completa' || n === 'externa'; };

    const externa = criarExterna({
      base, dataDir, log, agora: relogio, fetch: teste.fetch, aceitaSemTls: !!teste.aceitaSemTls,
      caminhoConfig: path.join(path.dirname(protecoesPath), 'auditoria-externa.json'),
      instalacao: teste.instalacao,
    });

    const ipDe = (req) => H.ipDoPedido(req, config.proxiesConfiaveis);
    const uaDe = (req) => curto(req && req.headers && req.headers['user-agent'], 120);
    function registrar(evento, dados, quem, req) {
      try {
        auditoria.registrar(evento, Object.assign({}, dados, req ? { ip: ipDe(req), ua: uaDe(req) } : {}), quem || 'desconhecido', 'web');
      } catch (e) {
        log('erro', `Não consegui gravar o evento "${evento}" na auditoria (${e.message}). A ação foi feita, mas ficou sem registro; confira a pasta da auditoria.`);
      }
    }

    // ── captura dos eventos da auditoria completa ───────────────────────────
    function agenteAlvo(p, url) {
      const m = /^\/api\/v1\/(?:agents|foco)\/([^/]+)/.exec(p) || /^\/(?:a|p)\/([^/]+)/.exec(p);
      if (m) { try { return decodeURIComponent(m[1]).slice(0, 60); } catch (_) { return m[1].slice(0, 60); } }
      const q = url.searchParams.get('agente') || url.searchParams.get('agent_id');
      return q ? curto(q, 60) : null;
    }

    function capturar(req, res, url, sessao) {
      const m = req.method;
      const p = url.pathname;
      let tipo = null;
      if (ESCREVE.has(m) && p.startsWith('/api/')) tipo = 'api_mutacao';
      else if ((m === 'GET' || m === 'HEAD') && /^\/p\/[^/]+\/$/.test(p)) tipo = 'painel_aberto';
      else if (m === 'GET' && /^\/api\/v1\/media\/[0-9a-f]{16}$/.test(p) && url.searchParams.get('baixar') === '1') tipo = 'midia_baixada';
      if (!tipo) return;
      res.on('finish', () => {
        const status = res.statusCode;
        const quem = sessao.usuario;
        if (tipo === 'api_mutacao') {
          const dados = { metodo: m, rota: p.slice(0, 200), consulta: [...new Set([...url.searchParams.keys()])].slice(0, 20), status };
          const alvo = agenteAlvo(p, url);
          if (alvo) dados.agente = alvo;
          if (sessao.via === 'caixa') dados.credencial = 'caixa-do-agente';
          registrar('api_mutacao', dados, quem, req);
        } else if (status < 400) {
          if (tipo === 'painel_aberto') registrar('painel_aberto', { agente: agenteAlvo(p, url), status }, quem, req);
          else registrar('midia_baixada', { midia: p.split('/').pop(), status }, quem, req);
        }
      });
    }

    // ── comandos que os agentes rodam (vêm do leitor de transcript) ────────
    const comandosPath = path.join(dataDir, 'auditoria-comandos.json');
    let comandos = null;   // { desde (s), agentes: { slug: { ep, ids: [] } } }
    function carregaComandos() {
      if (comandos) return comandos;
      try {
        comandos = JSON.parse(fs.readFileSync(comandosPath, 'utf8'));
        if (!comandos || typeof comandos !== 'object' || !comandos.agentes) throw new Error('formato inesperado');
      } catch (e) {
        if (e.code !== 'ENOENT') log('aviso', `Não consegui ler ${comandosPath} (${e.message}); recomecei a lista de comandos já registrados a partir de agora. Comandos antigos não são registrados de novo.`);
        comandos = { desde: relogio() / 1000, agentes: {} };
        salvaComandos();
      }
      return comandos;
    }
    function salvaComandos() {
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(comandosPath, JSON.stringify(comandos), { mode: 0o600 });
      } catch (e) {
        log('erro', `Não consegui gravar ${comandosPath} (${e.code || e.message}). Os comandos dos agentes podem ser registrados em duplicata depois de um restart; confira a permissão de ${dataDir}.`);
      }
    }
    function aoUsarFerramenta({ slug, id, ep, uso }) {
      if (!completa()) return;
      const c = carregaComandos();
      if (!(ep >= c.desde)) return;   // comando de antes de a auditoria completa ligar: o leitor só está relendo o transcript
      const a = c.agentes[slug] || (c.agentes[slug] = { ep: 0, ids: [] });
      if (ep < a.ep || (ep === a.ep && a.ids.includes(id))) return;   // já registrado (relido depois de um restart)
      if (ep > a.ep) { a.ep = ep; a.ids = []; }
      if (a.ids.length < IDS_POR_EP_MAX) a.ids.push(id);
      salvaComandos();
      registrar('agente_comando', { agente: slug, ferramenta: uso.ferramenta, titulo: uso.titulo }, `agente:${slug}`, null);
    }
    trilha.definirOuvinteDeUso(aoUsarFerramenta);

    // ── envio externo ──────────────────────────────────────────────────────
    let avisouSemDestino = false;
    async function rodadaExterna() {
      try {
        if (nivel() !== 'externa') return;
        if (!externa.lerConfig()) {
          if (!avisouSemDestino) { avisouSemDestino = true; log('erro', `A auditoria está no nível externa, mas falta o destino: configure com "dgclaw auditoria externa configurar" (arquivo ${path.join(path.dirname(protecoesPath), 'auditoria-externa.json')}). Enquanto isso a trilha só existe nesta VPS.`); }
          return;
        }
        avisouSemDestino = false;
        await externa.enviar();
      } catch (e) {
        if (!(e instanceof ErroExterna)) log('erro', `Envio da auditoria para fora quebrou: ${e.stack || e.message}`);
        else log('erro', e.message);
      }
    }
    const intervalo = teste.intervaloMs || INTERVALO_EXTERNA_MS;
    const timer = setInterval(rodadaExterna, intervalo);
    timer.unref();
    const primeiro = setTimeout(rodadaExterna, teste.primeiraMs == null ? 2000 : teste.primeiraMs);
    primeiro.unref();

    // ── API e tela (só TI) ─────────────────────────────────────────────────
    const erro = (res, status, msg, extra) => H.erroJson(res, status, msg, extra);
    const ehTI = (s) => !!s && s.via !== 'caixa' && (s.papel === 'ti' || (s.papel === undefined && !protecoes.ligada('multiusuario')));

    let integ = { marca: null, valor: null };
    function integridade() {
      let marca;
      try { marca = corrente.marcaDaCorrente(base); } catch (e) { return { ok: false, motivo: `Não consegui ler a pasta da auditoria: ${e.message}` }; }
      if (integ.marca === marca) return integ.valor;
      let valor;
      try { valor = corrente.verificar(base); } catch (e) { valor = { ok: false, motivo: e.message }; }
      integ = { marca, valor };
      return valor;
    }

    function filtroDe(url) {
      const f = {};
      for (const k of ['de', 'ate', 'evento', 'quem', 'origem', 'q']) {
        const v = curto(url.searchParams.get(k), 120);
        if (v) f[k] = v;
      }
      return f;
    }

    function listar(req, res, url) {
      const f = filtroDe(url);
      const por = Math.min(POR_MAX, Math.max(1, Number.parseInt(url.searchParams.get('por') || POR_PADRAO, 10) || POR_PADRAO));
      const todos = corrente.lerEventos(base, { de: f.de, ate: f.ate });
      const filtrados = todos.filter((e) => (!f.evento || e.obj.evento === f.evento) && (!f.quem || e.obj.quem === f.quem)
        && (!f.origem || e.obj.origem === f.origem) && (!f.q || e.texto.toLowerCase().includes(f.q.toLowerCase())));
      filtrados.reverse();
      const paginas = Math.max(1, Math.ceil(filtrados.length / por));
      const pagina = Math.min(paginas, Math.max(1, Number.parseInt(url.searchParams.get('pagina') || '1', 10) || 1));
      const fatia = filtrados.slice((pagina - 1) * por, pagina * por).map((e) => e.obj);
      const distintos = (campo) => [...new Set(todos.map((e) => e.obj[campo]).filter(Boolean))].sort();
      H.enviaJson(res, 200, {
        ok: true, nivel: nivel(), total: filtrados.length, pagina, por, paginas, eventos: fatia,
        integridade: integridade(), opcoes: { eventos: distintos('evento'), quem: distintos('quem'), origens: distintos('origem') },
        arquivos: corrente.arquivosDaCorrente(base).map((a) => a.nome),
        externa: nivel() === 'externa' ? externa.status() : null,
      });
    }

    function exportar(req, res, url, sessao) {
      const f = filtroDe(url);
      const formato = curto(url.searchParams.get('formato'), 10) || 'jsonl';
      let r;
      try {
        r = corrente.exportar(base, f, formato);
      } catch (e) {
        if (e.status === 400) { erro(res, 400, e.message); return; }
        throw e;
      }
      registrar('auditoria_exportada', { formato, filtros: f, total: r.total, via: 'web' }, sessao.usuario, req);
      const nome = `auditoria-${f.de || 'inicio'}-a-${f.ate || 'agora'}.${r.extensao}`;
      res.writeHead(200, {
        'Content-Type': r.tipo, 'Content-Disposition': `attachment; filename="${nome}"`, 'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(r.corpo), 'X-Total-Eventos': String(r.total),
      });
      res.end(r.corpo);
    }

    function negado(req, res, url, sessao, motivo) {
      registrar('acesso_negado', { recurso: curto(url.pathname, 160), metodo: req.method }, sessao.usuario, req);
      if (url.pathname.startsWith('/api/')) erro(res, 403, motivo); else H.paginaErro(res, 403, 'Sem acesso', motivo);
      return true;
    }

    async function rotas(req, res, url, sessao) {
      const p = url.pathname;
      const api = p === '/api/v1/auditoria' || p.startsWith('/api/v1/auditoria/');
      const pagina = (p === '/auditoria' || p === '/auditoria/') && (req.method === 'GET' || req.method === 'HEAD');
      if (!api && !pagina) return false;
      if (!sessao) {
        if (pagina) { semSessaoPagina(req, res, url); return true; }
        erro(res, 401, 'Você precisa entrar para ver a auditoria. Faça login em /login.');
        return true;
      }
      if (!ehTI(sessao)) return negado(req, res, url, sessao, 'A auditoria é só do TI. Peça a alguém do TI o que você precisa saber.');
      if (pagina) {
        const arq = path.join(config.publicDir, 'auditoria.html');
        if (!servirArquivo(req, res, arq, 'no-store')) {
          log('erro', `A tela da auditoria não está instalada: falta ${arq}.`);
          H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela da auditoria não foi encontrado no servidor. Reinstale o DG Claw Web.');
        }
        return true;
      }
      if (req.method !== 'GET') { erro(res, 405, 'A auditoria só se lê: use GET. Ninguém altera a trilha pela API.'); return true; }
      try {
        if (p === '/api/v1/auditoria') listar(req, res, url);
        else if (p === '/api/v1/auditoria/exportar') exportar(req, res, url, sessao);
        else if (p === '/api/v1/auditoria/externa') H.enviaJson(res, 200, Object.assign({ ok: true, nivel: nivel() }, externa.status()));
        else erro(res, 404, `Não existe GET ${p}. As rotas são /api/v1/auditoria, /exportar e /externa.`);
      } catch (e) {
        if (e.status === 400) erro(res, 400, e.message);
        else {
          log('erro', `Auditoria ${p}: ${e.stack || e.message}`);
          erro(res, 500, `Não consegui ler a auditoria: ${e.message}. Rode no servidor: dgclaw auditoria verificar`);
        }
      }
      return true;
    }

    return {
      async antes(req, res, url, sessao) {
        if (nivel() === 'nao') return false;   // nível pessoal: nada responde, nada muda
        if (sessao && completa()) capturar(req, res, url, sessao);
        return rotas(req, res, url, sessao);
      },
    };
  },
};
