'use strict';
// Fila de aprovações humanas (bloco C). É GENÉRICA: qualquer bloco enterprise que tenha uma ação perigosa
// (o controle do servidor, as ações externas do bloco E, o que o bloco I vier a ter) registra um TIPO aqui e
// passa a ter, de graça, a página, a API, o 2FA recente, o prazo de 24 h, a auditoria e o aviso no celular.
//
// ── Como um bloco usa esta fila ───────────────────────────────────────────────
//   // dentro do criar(ctx) do seu módulo em web/lib/ent/ (use `ordem` maior que 20 para este módulo já existir):
//   ctx.aprovacoes.registrarTipo('instagram', {
//     // A frase que o TI lê na tela. Monte-a SÓ a partir dos params que o SEU código validou; nunca repasse
//     // texto escrito pelo LLM como descrição (armadilha 7 do DESENHO): é a frase do dono do tipo que o TI confia.
//     descrever(params, op) { return `Publicar o post "${params.titulo}" no Instagram.`; },
//     // O que acontece depois que o TI aprova. Lance Error (com mensagem em português) se falhar.
//     // O valor devolvido (objeto simples, até 8 KB) vira o `resultado` do pedido.
//     async executar(params, aprovacao) { return publicar(params); },
//   });
//   // e quando o agente pedir a ação perigosa:
//   const r = ctx.aprovacoes.pedir({ tipo: 'instagram', op: 'post.publicar', params, pedido_por: 'agente:luna' });
//   // r.id é o identificador; responda ao agente { pendente: true, aprovacao: r.id }.
//
//   registrarTipo(tipo, { descrever(params, op) -> texto, executar(params, aprovacao) -> objeto })
//       `tipo` é minúsculo com a-z, 0-9, _ e -, de 2 a 31 caracteres. Registrar o mesmo tipo duas vezes é erro.
//   pedir({ tipo, op, params, pedido_por }) -> pedido público (estado "pendente")
//       `op` é o nome da ação dentro do tipo; `params` é um objeto JSON simples e JÁ VALIDADO por quem pede.
//       `pedido_por` é "agente:<slug>" ou "ti:<usuario>". O pedido guarda o hash canônico dos params.
//   obter(id), listar({ estado }), pendentes()
//
//   `aprovacao` (2º argumento de executar): { id, tipo, op, pedido_por, decidido_por, decidido_em, params_hash }.
//   Se executar() lançar um erro com `revertePedido = true` (a ação nem chegou a ser tentada, por exemplo o serviço
//   que a executa está fora do ar), o pedido VOLTA a "pendente" em vez de virar "falhou", e o TI pode aprovar de novo.
//
// ── Pedido (arquivo <dataDir>/aprovacoes/<id>.json, pasta 700; armazenamento em web/lib/aprovacoes-arquivo.js) ──
//   { id, tipo, op, params, params_hash, descricao, pedido_por, pedido_em, expira_em (24 h),
//     estado: pendente|aprovada|recusada|expirada|executada|falhou, decidido_por, decidido_em, resultado, usada_em, usada_por }
//   `usada_em` é preenchido por QUEM EXECUTA (o serviço de controle o faz sob trava, antes de rodar): cada aprovação vale uma vez.
//
// ── Rotas (só no nível enterprise; no pessoal só se o Admin isolado foi ligado à mão) ───────
//   GET  /aprovacoes                        página (só TI)
//   GET  /api/v1/aprovacoes[?estado=...]    lista (só TI, sessão de navegador)
//   GET  /api/v1/aprovacoes/resumo          { pendentes } (só TI): alimenta o contador do menu
//   GET  /api/v1/aprovacoes/<id>            TI vê tudo; o agente que fez o pedido vê o estado do próprio pedido, pela caixa
//   POST /api/v1/aprovacoes/<id>/aprovar    só TI em sessão de navegador, NUNCA pela caixa; exige o 2FA feito há menos de 15 min
//   POST /api/v1/aprovacoes/<id>/recusar    idem (não exige 2FA recente: recusar nunca é perigoso)
//   Quando o 2FA está velho a resposta é 403 com { reautenticar: true }; a tela pede o código e chama POST /api/v1/eu/reautenticar.
//
// ── Auditoria ────────────────────────────────────────────────────────────────
//   aprovacao_criada, aprovacao_aprovada, aprovacao_recusada, aprovacao_expirada, aprovacao_executada, aprovacao_falhou
//   (os dados levam id, tipo, op, descricao e o hash dos params; os params em si não vão para a trilha)

const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const { criarArmazem, hashParams, ErroAprovacao } = require('../aprovacoes-arquivo');
const { criarArquivoUsuarios, ErroUsuarios } = require('../usuarios-arquivo');
const { exigeReautenticacao } = require('./usuarios');

const EXPIRA_MS = 24 * 60 * 60 * 1000;
const REAUTENTICACAO_MIN = 15;
const RESULTADO_MAX = 8000;
const RX_TIPO = /^[a-z][a-z0-9_-]{1,30}$/;
const RX_ROTA = /^\/api\/v1\/aprovacoes\/([0-9a-f]{24})(?:\/(aprovar|recusar))?$/;
const ESTADOS = ['pendente', 'aprovada', 'recusada', 'expirada', 'executada', 'falhou'];

class Conflito extends Error {}

module.exports = {
  nome: 'aprovacoes',
  ordem: 20,
  criar(ctx) {
    const { config, log, protecoes, auditoria, servirArquivo, semSessaoPagina } = ctx;
    const relogio = ctx.agora ? () => { const a = ctx.agora(); return a instanceof Date ? a.getTime() : Number(a); } : () => Date.now();
    const iso = () => new Date(relogio()).toISOString();
    const tipos = new Map();
    let armazemReal = null;
    const armazem = () => armazemReal || (armazemReal = criarArmazem({ dataDir: config.dataDir, log }));
    let usuariosReal = null;

    // ── quem é TI ──────────────────────────────────────────────────────────
    /** Sem multiusuário o único usuário é o dono (TI). Com ele, vale o papel gravado no arquivo de usuários agora, não o do cookie. */
    function ehTI(sessao) {
      if (!sessao || sessao.via === 'caixa') return false;
      if (!protecoes.ligada('multiusuario')) return true;
      const arq = path.join(config.dataDir, 'usuarios.json');
      if (!fs.existsSync(arq)) return false;
      try {
        usuariosReal = usuariosReal || criarArquivoUsuarios({ dataDir: config.dataDir, log });
        const rec = usuariosReal.buscar(sessao.usuario);
        return !!rec && !rec.desativado_em && rec.papel === 'ti';
      } catch (e) {
        if (!(e instanceof ErroUsuarios)) throw e;
        log('erro', e.message);
        return false;
      }
    }

    function auditar(evento, reg, extra, quem) {
      try {
        auditoria.registrar(evento, Object.assign({ id: reg.id, tipo: reg.tipo, op: reg.op, descricao: reg.descricao, params_hash: reg.params_hash }, extra || {}), quem || reg.pedido_por || 'desconhecido', 'web');
      } catch (e) {
        log('erro', `Não consegui gravar o evento "${evento}" da aprovação ${reg.id} na auditoria (${e.message}). A ação foi feita, mas ficou sem registro; confira a pasta da auditoria.`);
      }
    }

    function limitar(valor) {
      if (valor === undefined || valor === null) return null;
      const t = JSON.stringify(valor);
      if (t.length <= RESULTADO_MAX) return valor;
      return { truncado: true, texto: t.slice(0, RESULTADO_MAX) };
    }

    const vencida = (r) => (r.estado === 'pendente' || r.estado === 'aprovada') && !(Date.parse(r.expira_em) > relogio());

    /** Marca como expirado o que passou do prazo e audita. Devolve o pedido atual. */
    function conferirPrazo(reg) {
      if (!vencida(reg)) return reg;
      let virou = false;
      const novo = armazem().atualizar(reg.id, (r) => {
        if (!vencida(r)) return { semMudanca: true };
        r.estado = 'expirada';
        r.decidido_em = r.decidido_em || iso();
        virou = true;
        return null;
      });
      if (virou) auditar('aprovacao_expirada', novo, { expirou_em: novo.expira_em }, 'sistema');
      return novo;
    }

    const publico = (r, completo) => {
      const v = {
        id: r.id, tipo: r.tipo, op: r.op, descricao: r.descricao, estado: r.estado, pedido_por: r.pedido_por, pedido_em: r.pedido_em,
        expira_em: r.expira_em, decidido_por: r.decidido_por || null, decidido_em: r.decidido_em || null, resultado: r.resultado === undefined ? null : r.resultado,
      };
      if (completo) { v.params = r.params; v.usada_em = r.usada_em || null; }
      return v;
    };

    // ── API para os outros blocos ──────────────────────────────────────────
    function registrarTipo(tipo, def) {
      if (typeof tipo !== 'string' || !RX_TIPO.test(tipo)) throw new TypeError(`O tipo de aprovação ${JSON.stringify(tipo)} não vale: use minúsculas, números, _ e -, de 2 a 31 caracteres, começando por letra.`);
      if (!def || typeof def.descrever !== 'function' || typeof def.executar !== 'function') throw new TypeError(`O tipo de aprovação "${tipo}" precisa de { descrever(params, op), executar(params, aprovacao) }.`);
      if (tipos.has(tipo)) throw new Error(`O tipo de aprovação "${tipo}" já foi registrado por outro bloco. Escolha outro nome.`);
      tipos.set(tipo, def);
    }

    function pedir({ tipo, op, params, pedido_por: pedidoPor }) {
      const def = tipos.get(tipo);
      if (!def) throw new Error(`Não existe o tipo de aprovação "${tipo}". Registre-o antes com ctx.aprovacoes.registrarTipo (tipos: ${[...tipos.keys()].join(', ') || 'nenhum'}).`);
      if (typeof op !== 'string' || !op) throw new TypeError('pedir precisa do nome da operação (op).');
      if (typeof pedidoPor !== 'string' || !pedidoPor) throw new TypeError('pedir precisa de pedido_por ("agente:<slug>" ou "ti:<usuario>").');
      const p = params == null ? {} : params;
      const descricao = String(def.descrever(p, op)).slice(0, 500);
      const t = relogio();
      const reg = {
        id: armazem().novoId(), tipo, op, params: p, params_hash: hashParams(p), descricao, pedido_por: pedidoPor,
        pedido_em: new Date(t).toISOString(), expira_em: new Date(t + EXPIRA_MS).toISOString(),
        estado: 'pendente', decidido_por: null, decidido_em: null, resultado: null, usada_em: null,
      };
      armazem().criar(reg);
      auditar('aprovacao_criada', reg, { pedido_por: pedidoPor }, pedidoPor);
      if (ctx.push && typeof ctx.push.enviar === 'function') {
        Promise.resolve().then(() => ctx.push.enviar({ titulo: 'Aprovação pendente', corpo: descricao, tag: `aprovacao-${reg.id}`, url: '/aprovacoes' }))
          .catch((e) => log('aviso', `Não consegui avisar o celular da aprovação ${reg.id} (${e.message}). O pedido está na tela /aprovacoes do mesmo jeito.`));
      }
      return publico(reg, true);
    }

    function listar(filtro) {
      let lista = armazem().listar().map(conferirPrazo);
      if (filtro && filtro.estado) lista = lista.filter((r) => r.estado === filtro.estado);
      return lista.map((r) => publico(r, true));
    }
    const pendentes = () => listar({ estado: 'pendente' });
    function obter(id) {
      const r = armazem().ler(id);
      return r ? publico(conferirPrazo(r), true) : null;
    }

    ctx.aprovacoes = { registrarTipo, pedir, obter, listar, pendentes, ehTI, ESTADOS };

    // ── decisão ────────────────────────────────────────────────────────────
    async function executar(reg) {
      const def = tipos.get(reg.tipo);
      const info = { id: reg.id, tipo: reg.tipo, op: reg.op, pedido_por: reg.pedido_por, decidido_por: reg.decidido_por, decidido_em: reg.decidido_em, params_hash: reg.params_hash };
      let estado = 'executada';
      let resultado;
      try {
        if (!def) throw new Error(`o tipo "${reg.tipo}" não está registrado nesta versão do Web (o bloco que o criou não carregou). Veja o log do dgclaw-web.`);
        resultado = limitar(await def.executar(reg.params, info));
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 1000);
        if (e && e.revertePedido === true) {
          const volta = armazem().atualizar(reg.id, (r) => { r.estado = 'pendente'; r.decidido_por = null; r.decidido_em = null; r.resultado = null; });
          auditar('aprovacao_falhou', volta, { erro: msg, voltou_a_pendente: true }, reg.decidido_por);
          return { revertido: true, reg: volta, erro: msg };
        }
        estado = 'falhou';
        resultado = { erro: msg };
      }
      const final = armazem().atualizar(reg.id, (r) => { r.estado = estado; r.resultado = resultado; });
      if (estado === 'executada') auditar('aprovacao_executada', final, {}, final.decidido_por);
      else auditar('aprovacao_falhou', final, { erro: resultado.erro }, final.decidido_por);
      return final;
    }

    async function decidir(res, sessao, id, acao, motivo) {
      const aprovar = acao === 'aprovar';
      if (aprovar && exigeReautenticacao(sessao, REAUTENTICACAO_MIN, relogio())) {
        H.enviaJson(res, 403, { ok: false, reautenticar: true, erro: `Para aprovar, confirme com o código do aplicativo autenticador: o último código foi digitado há mais de ${REAUTENTICACAO_MIN} minutos. Digite o código atual e tente de novo.` });
        return;
      }
      let antes;
      let expirou = false;
      try {
        antes = armazem().atualizar(id, (r) => {
          if (vencida(r)) { r.estado = 'expirada'; r.decidido_em = r.decidido_em || iso(); expirou = true; return null; }
          if (r.estado !== 'pendente') throw new Conflito(`Este pedido já está "${r.estado}"${r.decidido_por ? ` (decidido por ${r.decidido_por})` : ''}; só um pedido pendente pode ser ${aprovar ? 'aprovado' : 'recusado'}.`);
          r.estado = aprovar ? 'aprovada' : 'recusada';
          r.decidido_por = sessao.usuario;
          r.decidido_em = iso();
          if (!aprovar && motivo) r.resultado = { motivo };
          return null;
        });
      } catch (e) {
        if (e instanceof Conflito) { H.erroJson(res, 409, e.message); return; }
        throw e;
      }
      if (expirou) {
        auditar('aprovacao_expirada', antes, { expirou_em: antes.expira_em }, 'sistema');
        H.erroJson(res, 409, 'Este pedido venceu (passou de 24 horas sem decisão). Peça a ação de novo.');
        return;
      }
      if (!aprovar) {
        auditar('aprovacao_recusada', antes, motivo ? { motivo } : {}, sessao.usuario);
        H.enviaJson(res, 200, { ok: true, aprovacao: publico(antes, true) });
        return;
      }
      auditar('aprovacao_aprovada', antes, {}, sessao.usuario);
      const final = await executar(antes);
      if (final.revertido) {
        H.enviaJson(res, 503, { ok: false, erro: `${final.erro} O pedido voltou a ficar pendente: aprove de novo quando o problema for resolvido.`, aprovacao: publico(final.reg, true) });
        return;
      }
      H.enviaJson(res, 200, { ok: true, executada: final.estado === 'executada', aprovacao: publico(final, true) });
    }

    // ── rotas ──────────────────────────────────────────────────────────────
    function negaNaoTI(req, res, url, sessao) {
      try { auditoria.registrar('acesso_negado', { recurso: url.pathname.slice(0, 160), metodo: req.method }, sessao.usuario, 'web'); } catch (e) {
        log('erro', `Não consegui gravar o acesso negado a ${url.pathname} na auditoria (${e.message}).`);
      }
      const motivo = 'As aprovações são só do TI. Peça a alguém do TI para decidir o pedido.';
      if (url.pathname.startsWith('/api/')) H.erroJson(res, 403, motivo);
      else H.paginaErro(res, 403, 'Sem acesso', motivo);
    }

    async function rotaApi(req, res, url, sessao) {
      const p = url.pathname;
      const leitura = req.method === 'GET' || req.method === 'HEAD';
      const m = RX_ROTA.exec(p);

      if (sessao.via === 'caixa') {
        if (!m || m[2] || !leitura) { H.erroJson(res, 403, 'Pela caixa o agente só consulta o estado do próprio pedido (GET /api/v1/aprovacoes/<id>). Aprovar e recusar são do TI, no painel.'); return; }
        const reg = armazem().ler(m[1]);
        if (!reg || reg.pedido_por !== `agente:${sessao.agente}`) { H.erroJson(res, 404, `Não achei um pedido ${m[1]} feito por você. Confira o identificador que o controle devolveu.`); return; }
        const atual = conferirPrazo(reg);
        H.enviaJson(res, 200, { ok: true, aprovacao: publico(atual, false) });
        return;
      }
      if (!ehTI(sessao)) { negaNaoTI(req, res, url, sessao); return; }

      if (p === '/api/v1/aprovacoes') {
        if (!leitura) { H.erroJson(res, 405, 'Use GET para listar os pedidos.'); return; }
        const estado = url.searchParams.get('estado');
        if (estado && !ESTADOS.includes(estado)) { H.erroJson(res, 400, `O filtro estado precisa ser um destes: ${ESTADOS.join(', ')} (recebi "${estado.slice(0, 30)}").`); return; }
        const todos = listar({});
        H.enviaJson(res, 200, { ok: true, pendentes: todos.filter((r) => r.estado === 'pendente').length, aprovacoes: (estado ? todos.filter((r) => r.estado === estado) : todos).slice(0, 200) });
        return;
      }
      if (p === '/api/v1/aprovacoes/resumo') {
        if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return; }
        H.enviaJson(res, 200, { ok: true, pendentes: pendentes().length });
        return;
      }
      if (!m) { H.erroJson(res, 404, `Não existe ${req.method} ${p.slice(0, 100)}. As rotas são /api/v1/aprovacoes, /resumo e /<id>[/aprovar|/recusar].`); return; }
      const id = m[1];
      if (!m[2]) {
        if (!leitura) { H.erroJson(res, 405, 'Use GET para ver o pedido, ou POST em /aprovar e /recusar.'); return; }
        const r = obter(id);
        if (!r) { H.erroJson(res, 404, `Não existe o pedido ${id}.`); return; }
        H.enviaJson(res, 200, { ok: true, aprovacao: r });
        return;
      }
      if (req.method !== 'POST') { H.erroJson(res, 405, `Use POST em /${m[2]}.`); return; }
      if (!armazem().ler(id)) { H.erroJson(res, 404, `Não existe o pedido ${id}.`); return; }
      let motivo = '';
      if (m[2] === 'recusar') {
        try {
          const corpo = await H.lerJson(req, 4096);
          motivo = corpo && typeof corpo.motivo === 'string' ? corpo.motivo.trim().slice(0, 300) : '';
        } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
      }
      await decidir(res, sessao, id, m[2], motivo);
    }

    return {
      async antes(req, res, url, sessao) {
        const p = url.pathname;
        const ehApi = p === '/api/v1/aprovacoes' || p.startsWith('/api/v1/aprovacoes/');
        const ehPagina = p === '/aprovacoes' || p === '/aprovacoes/';
        if (!ehApi && !ehPagina) return false;
        // No nível pessoal só responde para quem ligou o Admin isolado por conta própria (dgclaw admin isolar): o controle precisa da fila.
        if (protecoes.nivel() === 'pessoal' && !protecoes.ligada('admin_isolado')) return false;
        try {
          if (ehPagina) {
            if (!(req.method === 'GET' || req.method === 'HEAD')) return false;
            if (!sessao) { semSessaoPagina(req, res, url); return true; }
            if (!ehTI(sessao)) { negaNaoTI(req, res, url, sessao); return true; }
            const arquivo = path.join(config.publicDir, 'aprovacoes.html');
            if (!servirArquivo(req, res, arquivo, 'no-store')) {
              log('erro', `A tela de aprovações não está instalada: falta ${arquivo}.`);
              H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de aprovações não foi encontrado no servidor. Reinstale o DG Claw Web.');
            }
            return true;
          }
          if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para ver as aprovações. Faça login em /login.'); return true; }
          await rotaApi(req, res, url, sessao);
          return true;
        } catch (e) {
          if (e instanceof ErroAprovacao) {
            log('erro', e.message);
            if (!res.headersSent) H.erroJson(res, e.status, e.message);
            return true;
          }
          throw e;
        }
      },
    };
  },
};
