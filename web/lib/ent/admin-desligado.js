'use strict';
// Criar agente sem Admin (bloco J). Com a proteção `admin_llm` = false (`dgclaw admin desligar`) não há conversa com o Admin,
// que era quem recebia o pedido do onboarding e rodava `dgclaw agente criar`. No lugar, o TI usa o formulário /novo-agente:
// ele grava o pedido no mesmo armazém do onboarding (web/lib/onboarding.js) e cria o agente PELO SERVIÇO DE CONTROLE
// (controle/catalogo.js, operação agente.criar), em nome do TI que está logado. O controle é determinístico e audita.
//
//   GET  /novo-agente                  a página (só TI)
//   GET  /api/v1/novo-agente/estado    { ativo, ti }: o menu usa para mostrar o atalho
//   POST /api/v1/novo-agente           { nome, papel, jeito, dono }: grava o pedido e começa a criar (202)
//   POST /api/v1/novo-agente/retomar   refaz a criação de um pedido que parou com erro (202)
//   POST /api/v1/novo-agente/testar    depois do login do agente: manda o "oi" e conclui (202)
// O andamento sai de GET /api/v1/onboarding, o mesmo de sempre. Com o Admin ligado este módulo não responde a nada.
// Sem o Admin, `/` sem nenhum agente leva ao formulário.
//
// Limite honesto: o controle só devolve a saída da criação quando termina (tarefa em segundo plano), então a barra de
// progresso mostra "preparando" até o fim em vez de passar etapa por etapa.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');
const { chamar } = require('../controle-cliente');
const { registrarPedido, loja } = require('../onboarding');

const LIMITES = { nome: 60, papel: 300, jeito: 180, dono: 60 };
const ROTULOS = { nome: 'o nome', papel: 'a função', jeito: 'o tom', dono: 'seu nome' };

/**
 * Faz as vezes do `spawn` que web/bin/onboarding.js usa para chamar o dgclaw: em vez de rodar o programa, pede ao controle.
 * Só entende `agente criar` e `agente reiniciar`, que são as duas chamadas do onboarding.
 */
function criarSpawnControle({ quem, env, log, intervaloMs, prazoMs, chamarControle }) {
  const falar = chamarControle || chamar;
  const espera = intervaloMs || 2000;
  const prazo = prazoMs || 35 * 60 * 1000;
  const FLAGS = { '--nome': 'nome', '--provedor': 'provedor', '--auth': 'auth', '--papel': 'papel', '--jeito': 'jeito', '--dono': 'dono', '--canal': 'canal' };

  function paraControle(argv) {
    if (argv[0] === 'agente' && argv[1] === 'criar') {
      const params = { slug: argv[2] };
      for (let i = 3; i + 1 < argv.length; i += 2) if (FLAGS[argv[i]]) params[FLAGS[argv[i]]] = argv[i + 1];
      return { op: 'agente.criar', params };
    }
    if (argv[0] === 'agente' && argv[1] === 'reiniciar') return { op: 'agente.reiniciar', params: { agente: argv[2] } };
    return null;
  }

  return function spawnControle(_comando, argv, opcoes) {
    const proc = new EventEmitter();
    const fd = opcoes && Array.isArray(opcoes.stdio) && Number.isInteger(opcoes.stdio[1]) ? opcoes.stdio[1] : null;
    const escrever = (texto) => {
      if (fd === null || !texto) return;
      try { fs.writeSync(fd, `${texto}\n`); } catch (e) { log('aviso', `Não consegui gravar a saída da criação no log do pedido (${e.code || e.message}).`); }
    };
    (async () => {
      const pedido = paraControle(argv);
      if (!pedido) throw new Error(`O formulário só sabe pedir "agente criar" e "agente reiniciar" ao controle (recebi "${argv.slice(0, 2).join(' ')}").`);
      const r = await falar({ op: pedido.op, params: pedido.params, quem }, { env });
      if (!r.ok) { escrever(`Nao deu certo: ${r.erro}`); return 1; }
      const tarefa = r.resultado && r.resultado.tarefa;
      if (!tarefa) { escrever(JSON.stringify(r.resultado || {})); return 0; }
      const fim = Date.now() + prazo;
      while (Date.now() < fim) {
        await new Promise((ok) => setTimeout(ok, espera));
        const v = await falar({ op: 'tarefa.ver', params: { id: tarefa }, quem }, { env });
        if (!v.ok) { escrever(`Nao deu certo: ${v.erro}`); return 1; }
        const t = v.resultado && v.resultado.tarefa;
        if (t && t.estado === 'ok') { escrever(t.resultado && t.resultado.saida); return 0; }
        if (t && t.estado === 'erro') { escrever(`Nao deu certo: ${t.erro}`); return 1; }
      }
      escrever(`Nao deu certo: a tarefa ${tarefa} do controle passou de ${Math.round(prazo / 60000)} minutos sem terminar. Veja: journalctl -u dgclaw-controle no servidor.`);
      return 1;
    })().then((codigo) => proc.emit('exit', codigo), (e) => proc.emit('error', e));
    return proc;
  };
}

module.exports = {
  nome: 'admin-desligado',
  ordem: 60,
  criarSpawnControle,
  criar(ctx) {
    const { config, registro, protecoes, auditoria, log, conversa, servirArquivo, semSessaoPagina } = ctx;
    if (!ctx.aprovacoes) throw new Error('O módulo admin-desligado precisa do módulo aprovacoes (web/lib/ent/aprovacoes.js, ordem 20) carregado antes dele.');
    const ehTI = ctx.aprovacoes.ehTI;
    const ativo = () => protecoes.valor('admin_llm') === false;
    const intervalo = Number((config.env || {}).DGCLAW_NOVO_AGENTE_INTERVALO_MS) || 2000;

    function registrar(evento, dados, quem) {
      try { auditoria.registrar(evento, dados, quem, 'web'); } catch (e) {
        log('erro', `Não consegui gravar o evento "${evento}" na auditoria (${e.message}). A ação foi feita, mas ficou sem registro; confira a pasta da auditoria.`);
      }
    }

    // A criação e o teste demoram minutos: respondem 202 e seguem em segundo plano. O erro fica no pedido (fase "erro").
    function seguirEmSegundoPlano(acao, id, usuario, slug) {
      const { executar } = require('../../bin/onboarding');   // carregado só agora: o bin importa o server
      const web = { config, registro, conversa };
      const spawn = criarSpawnControle({ quem: `ti:${usuario}`, env: config.env, log, intervaloMs: intervalo });
      executar(acao, id, { web, spawn, cli: 'dgclaw' }).catch((e) => {
        log('erro', `A ${acao === 'criar' ? 'criação' : 'conferência'} do agente "${slug}" pelo formulário parou: ${e.message}. O pedido ficou na fase de erro; abra /novo-agente para retomar ou veja: journalctl -u dgclaw-controle.`);
      });
    }

    function campo(corpo, nome) {
      const v = corpo && corpo[nome];
      const max = LIMITES[nome];
      if (typeof v !== 'string' || !v.trim() || [...v.trim()].length > max || /[\u0000-\u001f<>]/.test(v)) {
        throw Object.assign(new Error(`Preencha ${ROTULOS[nome]} com até ${max} caracteres, sem quebras de linha.`), { status: 400 });
      }
      return v.trim();
    }

    async function criarAgente(req, res, usuario) {
      let corpo;
      try { corpo = await H.lerJson(req, 8 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
      let dados;
      try { dados = { nome: campo(corpo, 'nome'), papel: campo(corpo, 'papel'), jeito: campo(corpo, 'jeito'), dono: campo(corpo, 'dono') }; } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
      let p;
      try { p = registrarPedido({ config, registro, dados, semAdmin: true }); } catch (e) { H.erroJson(res, e.status || 500, e.status ? e.message : `Não consegui guardar o pedido (${e.code || e.message}). Confira o espaço e as permissões de ${config.dataDir}.`); return; }
      registrar('agente.criar_formulario', { slug: p.slug, nome: p.nome, pedido: p.id }, usuario);
      seguirEmSegundoPlano('criar', p.id, usuario, p.slug);
      H.enviaJson(res, 202, { ok: true, id: p.id, slug: p.slug, fase: p.fase });
    }

    function pedidoAtual(res, fasesOk, textoFase) {
      const p = loja(config.dataDir).ultimo();
      if (!p) { H.erroJson(res, 404, 'Não há nenhum pedido de agente. Preencha o formulário em /novo-agente.'); return null; }
      if (!fasesOk.includes(p.fase)) { H.erroJson(res, 409, `O pedido do agente ${p.nome} está na fase "${p.fase}", ${textoFase}`); return null; }
      return p;
    }

    return {
      async antes(req, res, url, sessao) {
        const p = url.pathname;
        const leitura = req.method === 'GET' || req.method === 'HEAD';

        if (p === '/api/v1/novo-agente/estado') {
          if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar. Faça login em /login.'); return true; }
          if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return true; }
          H.enviaJson(res, 200, { ok: true, ativo: ativo(), ti: ativo() && ehTI(sessao) });
          return true;
        }
        if (!ativo()) return false;

        if (p === '/' && leitura && sessao && ehTI(sessao) && !registro.estado().agentes.some((a) => a.tipo !== 'admin')) {
          res.writeHead(302, { Location: '/novo-agente', 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
        if ((p === '/novo-agente' || p === '/novo-agente/') && leitura) {
          if (!sessao) { semSessaoPagina(req, res, url); return true; }
          if (!ehTI(sessao)) { H.paginaErro(res, 403, 'Só para o TI', 'Criar agentes é com o TI desta instalação. Peça a alguém do TI.'); return true; }
          const arquivo = path.join(config.publicDir, 'novo-agente.html');
          if (!servirArquivo(req, res, arquivo, 'no-store')) {
            log('erro', `A tela de novo agente não está instalada: falta ${arquivo}.`);
            H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de novo agente não foi encontrado no servidor. Reinstale o DG Claw Web.');
          }
          return true;
        }
        if (!(p === '/api/v1/novo-agente' || p === '/api/v1/novo-agente/retomar' || p === '/api/v1/novo-agente/testar')) return false;
        if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar. Faça login em /login.'); return true; }
        if (req.method !== 'POST') { H.erroJson(res, 405, `Use POST em ${p}.`); return true; }
        if (!ehTI(sessao)) {
          registrar('acesso_negado', { recurso: p, metodo: 'POST' }, sessao.usuario);
          H.erroJson(res, 403, 'Criar agentes é com o TI desta instalação. Peça a alguém do TI.');
          return true;
        }
        if (p === '/api/v1/novo-agente') { await criarAgente(req, res, sessao.usuario); return true; }
        if (p.endsWith('/retomar')) {
          const ped = pedidoAtual(res, ['erro'], 'e só se retoma o que parou com erro.');
          if (!ped) return true;
          registrar('agente.criar_formulario', { slug: ped.slug, nome: ped.nome, pedido: ped.id, retomada: true }, sessao.usuario);
          seguirEmSegundoPlano('criar', ped.id, sessao.usuario, ped.slug);
        } else {
          const ped = pedidoAtual(res, ['login', 'erro'], 'e só se testa depois de o agente ser criado e entrar com a assinatura.');
          if (!ped) return true;
          if (!registro.obter(ped.slug)) { H.erroJson(res, 409, `O agente ${ped.nome} ainda não foi criado, então não há o que testar. Use "Tentar de novo".`); return true; }
          seguirEmSegundoPlano('testar', ped.id, sessao.usuario, ped.slug);
        }
        H.enviaJson(res, 202, { ok: true });
        return true;
      },
    };
  },
};
