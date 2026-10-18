'use strict';
// Bloco I: as rotas do kit "skill com dado sensível" (protecao `kit_sensivel`). O agente nunca toca no dado bruto nem na
// credencial: ele pede uma operação com nome e parâmetros, o serviço de ferramentas (ferramentas/servidor.js, no host,
// usuário sem privilégio) roda o executor, confere a saída e devolve só o resultado agregado.
//
//   GET  /api/v1/ferramentas           as ferramentas que ESTE agente pode usar (nome, descrição, esquema dos parâmetros)
//   POST /api/v1/ferramentas/<nome>    corpo {"params": {...}}: executa e devolve o resultado conferido
//
// Só o agente comum, pela caixa (dgclaw-ferramenta), usa estas rotas. O Admin, o navegador e o funcionário recebem 403.
// Com a proteção desligada o módulo não responde a nada e a rota cai no 404 de sempre.
//
// A auditoria (`ferramenta_usada`) é gravada AQUI, e não no serviço, porque o serviço roda sem privilégio e não escreve
// na trilha. Se a trilha estiver ligada e a gravação falhar, o resultado NÃO é entregue (sem registro de acesso, sem dado).

const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const { chamar } = require('../ferramentas-cliente');
const { gravaArquivoSeguro } = require('../grava-seguro');
const { varrer } = require('../entregas-expiram');
const { mascarar } = require('../mascara');

const RX_NOME = /^[a-z][a-z0-9_-]{0,38}(\.[a-z][a-z0-9_-]{0,38})?$/;
const STATUS_DO_MOTIVO = {
  pedido_invalido: 400, parametros: 400, ferramenta_desconhecida: 404, agente_nao_autorizado: 403, bloqueado_pelo_verificador: 422,
  ocupado: 429, tempo_esgotado: 504, memoria_esgotada: 502, falha_execucao: 502, saida_invalida: 502, ferramenta_invalida: 502,
  credencial: 502, ferramentas_fora: 503,
};
const HORA_MS = 3600 * 1000;

/** Parâmetros para a auditoria: texto mascarado e cortado, nada de objeto aninhado. */
function paramsParaAuditoria(params) {
  const saida = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return saida;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') saida[k.slice(0, 40)] = mascarar(v).slice(0, 120);
    else if (typeof v === 'number' || typeof v === 'boolean') saida[k.slice(0, 40)] = v;
    else saida[k.slice(0, 40)] = '(valor fora do esquema)';
  }
  return saida;
}

module.exports = {
  nome: 'ferramentas',
  ordem: 50,
  criar(ctx) {
    const { config, registro, protecoes, auditoria, log, caixa } = ctx;
    const agora = ctx.agora || Date.now;
    if (caixa) caixa.permitir('/api/v1/ferramentas');

    // Relatórios vencidos saem da pasta de entregas mesmo que a proteção tenha sido desligada depois.
    const varre = () => {
      try {
        const est = registro.estado();
        if (est.ok) varrer({ agentes: est.agentes, agora: Number(agora()), log });
      } catch (e) {
        log('erro', `Entregas com prazo: a varredura falhou (${e.message}). Os relatórios vencidos continuam na pasta de entregas; reinicie o Web ou apague-os à mão.`);
      }
    };
    setTimeout(varre, 10 * 1000).unref();
    setInterval(varre, HORA_MS).unref();

    function negado(req, res, url, sessao, motivo) {
      try { auditoria.registrar('acesso_negado', { recurso: url.pathname.slice(0, 160), metodo: req.method }, sessao.usuario || sessao.agente, 'web'); } catch (e) {
        log('erro', `Não consegui gravar o acesso negado a ${url.pathname} na auditoria (${e.message}).`);
      }
      H.erroJson(res, 403, motivo);
    }

    /** Grava o relatório na pasta de entregas do agente, com o .expira. Devolve { caminho, expira_em } ou lança com a causa. */
    function entregarArquivo(ag, arquivo, retencaoDias) {
      const dono = fs.statSync(ag.home_host);
      const pasta = path.join(ag.home_host, '.dgclaw', 'entregas');
      const marca = new Date(Number(agora())).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      const nome = `${marca}-${arquivo.nome}`;
      const expira = new Date(Number(agora()) + retencaoDias * 24 * HORA_MS).toISOString();
      const opc = { raiz: ag.home_host, uid: dono.uid, gid: dono.gid, modo: 0o600, pasta: { modo: 0o700, uid: dono.uid, gid: dono.gid } };
      gravaArquivoSeguro(path.join(pasta, nome), Buffer.from(arquivo.conteudo_b64, 'base64'), opc);
      gravaArquivoSeguro(path.join(pasta, `${nome}.expira`), `${expira}\n`, opc);
      return { caminho: path.posix.join(ag.home_container || ag.home_host, '.dgclaw', 'entregas', nome), expira_em: expira };
    }

    async function executar(req, res, nome, ag) {
      let corpo;
      try { corpo = await H.lerJson(req, 64 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
      const params = corpo && corpo.params;
      const r = await chamar({ op: 'executar', ferramenta: nome, agente: ag.slug, usuario: ag.dono || null, params }, { env: config.env });
      const meta = r.meta || {};
      const evento = {
        agente: ag.slug, usuario_dono: ag.dono || null, ferramenta: nome, parametros: paramsParaAuditoria(params),
        registros_lidos: meta.registros_lidos == null ? null : meta.registros_lidos,
        hash_resultado: r.ok ? meta.hash_resultado : null, duracao_ms: meta.duracao_ms == null ? null : meta.duracao_ms,
        decisao: r.ok ? 'liberado' : r.motivo === 'bloqueado_pelo_verificador' ? 'bloqueado' : 'recusado',
      };
      if (!r.ok) {
        evento.motivo = r.motivo;
        if (r.tipos) evento.tipos = r.tipos;
      }
      let entrega = null;
      if (r.ok && meta.arquivo) {
        try { entrega = entregarArquivo(ag, meta.arquivo, meta.retencao_dias); } catch (e) {
          log('erro', `Ferramenta ${nome}: gerou o relatório para ${ag.slug}, mas não consegui gravá-lo na pasta de entregas (${e.message}). Rode: dgclaw agente reparar ${ag.slug}`);
          evento.decisao = 'recusado';
          evento.motivo = 'entrega_arquivo';
          try { auditoria.registrar('ferramenta_usada', evento, `agente:${ag.slug}`, 'ferramentas'); } catch (e2) { log('erro', `Não consegui gravar ferramenta_usada na auditoria (${e2.message}).`); }
          H.enviaJson(res, 502, { ok: false, motivo: 'entrega_arquivo', erro: 'A ferramenta rodou, mas o relatório não pôde ser gravado na sua pasta de entregas, então nada foi entregue. Avise o dono: ele precisa rodar "dgclaw agente reparar".' });
          return;
        }
        evento.arquivo = path.basename(entrega.caminho);
      }
      try {
        auditoria.registrar('ferramenta_usada', evento, `agente:${ag.slug}`, 'ferramentas');
      } catch (e) {
        log('erro', `Ferramenta ${nome} (agente ${ag.slug}): não consegui gravar ferramenta_usada na auditoria (${e.message}). Sem registro de acesso o resultado não é entregue; corrija a trilha em /var/log/dgclaw.`);
        H.enviaJson(res, 503, { ok: false, motivo: 'auditoria_indisponivel', erro: 'O registro de acesso não pôde ser gravado, então o resultado não foi entregue. Avise o dono: a trilha de auditoria do servidor precisa de atenção.' });
        return;
      }
      if (!r.ok) {
        H.enviaJson(res, STATUS_DO_MOTIVO[r.motivo] || 502, { ok: false, motivo: r.motivo, erro: r.erro });
        return;
      }
      H.enviaJson(res, 200, Object.assign({ ok: true, ferramenta: nome, resultado: r.resultado, verificador: 'aprovado' }, entrega ? { arquivo: entrega } : {}));
    }

    return {
      async antes(req, res, url, sessao) {
        const p = url.pathname;
        if (!(p === '/api/v1/ferramentas' || p.startsWith('/api/v1/ferramentas/'))) return false;
        if (!protecoes.ligada('kit_sensivel')) return false;
        if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para usar as ferramentas. Faça login em /login.'); return true; }
        if (sessao.via !== 'caixa') {
          negado(req, res, url, sessao, 'As ferramentas sensíveis são usadas só pelos agentes, pela caixa (comando dgclaw-ferramenta). Quem cuida do servidor vê a lista com: dgclaw ferramenta listar.');
          return true;
        }
        const ag = registro.obter(sessao.agente);
        if (!ag || ag.tipo !== 'agente' || ag.papel === 'admin') {
          negado(req, res, url, sessao, `O agente "${String(sessao.agente).slice(0, 40)}" não usa ferramentas sensíveis. Elas são só dos agentes comuns que o TI listou na ferramenta.`);
          return true;
        }
        const leitura = req.method === 'GET' || req.method === 'HEAD';
        if (p === '/api/v1/ferramentas') {
          if (!leitura) { H.erroJson(res, 405, 'Use GET para listar. Para executar: POST /api/v1/ferramentas/<nome>.'); return true; }
          const r = await chamar({ op: 'listar', agente: ag.slug }, { env: config.env });
          if (!r.ok) { H.enviaJson(res, STATUS_DO_MOTIVO[r.motivo] || 502, { ok: false, motivo: r.motivo, erro: r.erro }); return true; }
          H.enviaJson(res, 200, { ok: true, ferramentas: r.ferramentas });
          return true;
        }
        const nome = p.slice('/api/v1/ferramentas/'.length);
        if (!RX_NOME.test(nome)) { H.erroJson(res, 404, `Não existe a rota ${p.slice(0, 100)}. Use POST /api/v1/ferramentas/<nome>, com o nome que GET /api/v1/ferramentas mostra.`); return true; }
        if (req.method !== 'POST') { H.erroJson(res, 405, `Use POST em /api/v1/ferramentas/${nome}, com o corpo {"params": {...}}.`); return true; }
        await executar(req, res, nome, ag);
        return true;
      },
    };
  },
};
