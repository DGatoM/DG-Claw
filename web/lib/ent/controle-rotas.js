'use strict';
// Bloco C: a rota do Admin (e da tela do TI) para o serviço de controle (controle/servidor.js).
// Só age com a proteção `admin_isolado` ligada; no nível pessoal este módulo não responde a nada.
//
//   POST /api/v1/controle/<operacao>   corpo {"params": {...}}
//        leitura e reversível: o Web repassa ao socket do controle e devolve a resposta;
//        perigosa: cria um pedido de aprovação (tipo "controle") e devolve 202 {pendente: true, aprovacao: <id>};
//        quando o TI aprova, a execução passa pelo controle com a aprovação anexada (ele confere tudo de novo).
//   GET  /api/v1/controle/ops          o catálogo (JSON)
//   GET  /api/v1/controle/docs.md      o mesmo catálogo em markdown, para o agente ler
//   GET  /api/v1/controle/manutencao   { aberta, fecha_em, minutos_restantes, por, link }: alimenta o aviso do topo do chat
//
// Quem pode chamar: o agente cujo registro no agentes.json tem `papel: "admin"` (pela caixa, via dgclaw-controle) e o TI em
// sessão de navegador. Outro agente recebe 403. Funcionário recebe 403.

const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const catalogo = require('../../../controle/catalogo');
const { chamar } = require('../controle-cliente');
const { hashParams, ErroAprovacao } = require('../aprovacoes-arquivo');

const RX_OP = /^[a-z]+\.[a-z]+$/;
const STATUS_DO_MOTIVO = {
  parametros: 400, pedido_invalido: 400, op_desconhecida: 404, nao_encontrado: 404, em_andamento: 409,
  aprovacao_necessaria: 403, aprovacao_invalida: 403, controle_fora: 503, falha_execucao: 502,
};

module.exports = {
  nome: 'controle-rotas',
  ordem: 30,
  criar(ctx) {
    const { config, registro, protecoes, auditoria, log, caixa } = ctx;
    if (!ctx.aprovacoes) throw new Error('O módulo controle-rotas precisa do módulo aprovacoes (web/lib/ent/aprovacoes.js, ordem 20) carregado antes dele.');
    const aprovacoes = ctx.aprovacoes;
    if (caixa) {
      // A caixa só entrega à rota o que foi liberado aqui; cada rota confere de novo QUEM é o agente.
      caixa.permitir('/api/v1/controle');
      caixa.permitir('/api/v1/aprovacoes');
    }

    aprovacoes.registrarTipo('controle', {
      descrever: (params, op) => catalogo.descrever(op, params),
      async executar(params, ap) {
        const r = await chamar({
          op: ap.op, params, quem: ap.pedido_por,
          aprovacao: { id: ap.id, aprovado_por: ap.decidido_por, aprovado_em: ap.decidido_em },
        }, { env: config.env });
        if (!r.ok) {
          const e = new Error(r.erro);
          // O controle fora do ar não executou nada: o pedido volta a pendente (a fila olha este campo).
          if (r.motivo === 'controle_fora') e.revertePedido = true;
          throw e;
        }
        return r.resultado;
      },
    });

    const arquivoManutencao = () => path.join(config.dataDir, 'controle', 'manutencao.json');

    function estadoManutencao() {
      let j;
      try { j = JSON.parse(fs.readFileSync(arquivoManutencao(), 'utf8')); } catch (e) {
        if (e.code === 'ENOENT') return { aberta: false };
        log('erro', `Não consegui ler o estado da manutenção em ${arquivoManutencao()} (${e.code || e.message}). O aviso do topo do chat pode estar errado; confira com: dgclaw admin manutencao status`);
        return { aberta: false, erro: 'estado ilegível' };
      }
      const resta = Number(j.fecha_em) - (ctx.agora ? Number(ctx.agora()) : Date.now());
      if (!(resta > 0)) return { aberta: false };
      return { aberta: true, fecha_em: Number(j.fecha_em), minutos_restantes: Math.ceil(resta / 60000), por: j.por || null, link: `/a/${j.slug || 'admin-manutencao'}` };
    }

    function negado(req, res, url, sessao, motivo) {
      try { auditoria.registrar('acesso_negado', { recurso: url.pathname.slice(0, 160), metodo: req.method }, sessao.usuario, 'web'); } catch (e) {
        log('erro', `Não consegui gravar o acesso negado a ${url.pathname} na auditoria (${e.message}).`);
      }
      H.erroJson(res, 403, motivo);
    }

    const responde = (res, r) => {
      if (r.ok) { H.enviaJson(res, 200, { ok: true, resultado: r.resultado }); return; }
      H.enviaJson(res, STATUS_DO_MOTIVO[r.motivo] || 502, { ok: false, motivo: r.motivo, erro: r.erro });
    };

    async function chamaOperacao(req, res, op, quem) {
      let corpo;
      try { corpo = await H.lerJson(req, 64 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
      const v = catalogo.validar(op, corpo && corpo.params);
      if (!v.ok) { H.enviaJson(res, STATUS_DO_MOTIVO[v.motivo] || 400, { ok: false, motivo: v.motivo, erro: v.erro }); return; }
      if (catalogo.OPS[op].classe !== 'perigosa') {
        responde(res, await chamar({ op, params: v.params, quem }, { env: config.env }));
        return;
      }
      // Pedido igual, da mesma pessoa, ainda pendente: devolve o que já existe em vez de encher a fila do TI.
      const hash = hashParams(v.params);
      let pedido = aprovacoes.pendentes().find((p) => p.tipo === 'controle' && p.op === op && p.pedido_por === quem && hashParams(p.params) === hash);
      const repetido = !!pedido;
      if (!pedido) pedido = aprovacoes.pedir({ tipo: 'controle', op, params: v.params, pedido_por: quem });
      H.enviaJson(res, 202, {
        ok: true, pendente: true, aprovacao: pedido.id, estado: pedido.estado, descricao: pedido.descricao, expira_em: pedido.expira_em,
        onde_aprovar: '/aprovacoes', ja_existia: repetido,
        mensagem: `Esta operação é perigosa e espera a aprovação de uma pessoa do TI no painel (/aprovacoes). Acompanhe com: dgclaw-controle pedido ${pedido.id}`,
      });
    }

    return {
      async antes(req, res, url, sessao) {
        const p = url.pathname;
        if (!(p === '/api/v1/controle' || p.startsWith('/api/v1/controle/'))) return false;
        if (!protecoes.ligada('admin_isolado')) return false;
        if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para usar o controle. Faça login em /login.'); return true; }
        let quem;
        if (sessao.via === 'caixa') {
          const ag = registro.obter(sessao.agente);
          if (!ag || ag.papel !== 'admin') {
            H.erroJson(res, 403, `O agente "${String(sessao.agente).slice(0, 40)}" não é o Admin, então não pode usar o controle do servidor. Só o agente com papel "admin" no registro chama /api/v1/controle.`);
            return true;
          }
          quem = `agente:${sessao.agente}`;
        } else {
          if (!aprovacoes.ehTI(sessao)) { negado(req, res, url, sessao, 'O controle do servidor é só do TI. Peça a alguém do TI.'); return true; }
          quem = `ti:${sessao.usuario}`;
        }
        const leitura = req.method === 'GET' || req.method === 'HEAD';
        if (p === '/api/v1/controle/docs.md') {
          if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return true; }
          const md = catalogo.docsMarkdown();
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': Buffer.byteLength(md), 'Cache-Control': 'no-store' });
          res.end(md);
          return true;
        }
        if (p === '/api/v1/controle/ops') {
          if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return true; }
          H.enviaJson(res, 200, { ok: true, operacoes: catalogo.listar() });
          return true;
        }
        if (p === '/api/v1/controle/manutencao') {
          if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return true; }
          H.enviaJson(res, 200, Object.assign({ ok: true }, estadoManutencao()));
          return true;
        }
        const op = p.slice('/api/v1/controle/'.length);
        if (!RX_OP.test(op)) { H.erroJson(res, 404, `Não existe a rota ${p.slice(0, 100)}. Use POST /api/v1/controle/<operação>; veja GET /api/v1/controle/docs.md.`); return true; }
        if (req.method !== 'POST') { H.erroJson(res, 405, `Use POST em /api/v1/controle/${op}, com o corpo {"params": {...}}.`); return true; }
        try {
          await chamaOperacao(req, res, op, quem);
        } catch (e) {
          if (!(e instanceof ErroAprovacao)) throw e;
          log('erro', e.message);
          if (!res.headersSent) H.erroJson(res, e.status, e.message);
        }
        return true;
      },
    };
  },
};
