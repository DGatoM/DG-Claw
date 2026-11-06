'use strict';
/* conectar-puro.js: a parte pura da página /conectar (conectar a conta do Claude ou do Codex de cada agente).

   Sem DOM e sem rede: decide a ordem e o texto dos cartões, o selo de estado de cada um, o que o cartão
   mostra em cada fase do login e como cada erro vira uma frase de leigo. O desenho e as chamadas ficam em
   conectar.js; aqui fica o que se testa com node:test (web/test/conectar-puro.test.js).

   O link de login carrega o estado do OAuth e o código colado é segredo: nenhuma função daqui os devolve
   fora das fases em que a pessoa precisa deles, e nenhum texto de erro os repete. */
(function (raiz, fabrica) {
  const LC = typeof module === 'object' && module.exports ? require('./login-cartao') : raiz.DGLoginCartao;
  const m = fabrica(LC);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGConectar = m;
})(this, function (LC) {
  const PAPEL_ADMIN = 'o agente supervisor, que cuida do servidor';
  const PAPEL_AGENTE = 'o seu agente de trabalho';

  /** Admin primeiro; os demais na ordem em que vieram. Não altera a lista de entrada. */
  function ordenar(agentes) {
    const lista = Array.isArray(agentes) ? agentes.filter(a => a && a.id) : [];
    return lista.filter(a => a.tipo === 'admin').concat(lista.filter(a => a.tipo !== 'admin'));
  }

  /** A frase de papel em linguagem de leigo. O subtítulo do agente, se houver, vai à parte. */
  function papel(agente) {
    const a = agente || {};
    return {
      papel: a.tipo === 'admin' ? PAPEL_ADMIN : PAPEL_AGENTE,
      subtitulo: a.subtitulo ? String(a.subtitulo) : '',
    };
  }

  const usaChaveDeApi = auth => /^(api|token)$/i.test(String(auth || ''));
  const emAndamento = estado => estado === 'aguardando_link' || estado === 'aguardando_codigo' || estado === 'aguardando_navegador';

  /**
   * O selo do cartão. `d` é a resposta de GET .../login (ou null se a consulta falhou) e `ctx.erroConferir` é a
   * frase de erro dessa consulta. `ctx.concluiuAgora` marca o login que acabou de terminar nesta página.
   * Devolve { chave, texto, cor } com cor em verde | ambar | vermelho | cinza.
   */
  function selo(d, ctx) {
    ctx = ctx || {};
    if (!d || ctx.erroConferir) return { chave: 'sem_resposta', texto: 'Não consegui conferir', cor: 'cinza' };
    if (usaChaveDeApi(d.auth)) return { chave: 'api', texto: 'Usa chave de API', cor: 'cinza' };
    if (d.estado === 'concluido' && ctx.concluiuAgora) return { chave: 'conectado', texto: 'Conectado', cor: 'verde' };
    if (emAndamento(d.estado)) return { chave: 'andamento', texto: 'Conectando', cor: 'ambar' };
    if (d.login_expirado) return { chave: 'expirou', texto: 'Login expirou', cor: 'vermelho' };
    const ok = !!(d.conferido && d.conferido.ok === true) && !d.precisa_login;
    return ok ? { chave: 'conectado', texto: 'Conectado', cor: 'verde' } : { chave: 'falta', texto: 'Falta conectar', cor: 'ambar' };
  }

  /** Tira só os espaços das pontas. Espaço ou quebra no meio NÃO é consertado: o servidor explica a recusa. */
  function limpaCodigo(texto) {
    return typeof texto === 'string' ? texto.trim() : '';
  }

  /* ── Tradução de erros ────────────────────────────────────────────────────── */

  const RX_CODIGO_RUIM = /c[óo]digo.{0,40}(inv[áa]lid|venc|expir|incorret|errad|n[ãa]o (?:aceit|confere|bate)|rejeit)|invalid.{0,20}(code|grant)|expired|n[ãa]o terminou/i;
  const RX_PRAZO = /n[ãa]o foi conclu[íi]do em \d+ minutos|foi cancelado|passou de \d+ min/i;

  const FRASE_CODIGO_RUIM = 'O código não valeu. Ele vence em poucos minutos e só serve uma vez. Toque em Gerar novo link e cole o código novo logo em seguida.';
  const FRASE_PRAZO = 'O prazo de 15 minutos acabou e o login foi cancelado. Toque em Gerar link de login e termine tudo sem demorar.';

  /** Uma mensagem de falha do estado `falhou` (o runner descreve o que houve): código ruim, prazo ou o texto dele. */
  function traduzFalha(mensagem) {
    const t = String(mensagem || '').trim();
    if (RX_PRAZO.test(t)) return FRASE_PRAZO;
    if (RX_CODIGO_RUIM.test(t)) return FRASE_CODIGO_RUIM;
    return t || 'O login terminou sem conectar a conta. Toque em Gerar link de login para tentar de novo.';
  }

  const ACOES = {
    conferir: 'conferir a conta',
    gerar: 'gerar o link de login',
    codigo: 'enviar o código',
    cancelar: 'cancelar o login',
    oi: 'avisar o agente de que a conta foi conectada',
  };

  /**
   * Erro de uma chamada vira { texto, sessaoExpirada }. `acao` é uma chave de ACOES; `nome` é o agente.
   * `status` é o HTTP (0 ou ausente = a rede falhou); `mensagem` é o `erro` que o servidor mandou.
   * Nunca devolve texto vazio: toda frase diz o que houve e o que fazer.
   */
  function traduzErro(status, mensagem, acao, nome) {
    const msg = String(mensagem || '').trim();
    const quem = nome || 'o agente';
    const fazer = ACOES[acao] || 'concluir isso';
    if (status === 401) {
      return { sessaoExpirada: true, texto: 'A sua sessão no painel acabou. Vou levar você de volta ao login; depois de entrar, esta página abre de novo.' };
    }
    if (!status) {
      return { sessaoExpirada: false, texto: 'Não consegui falar com o painel para ' + fazer + (msg ? ' (' + msg + ')' : '') + '. Confira a internet do aparelho e tente de novo.' };
    }
    if (status === 400) {
      return { sessaoExpirada: false, texto: msg || ('O painel recusou o pedido para ' + fazer + '. Confira o que foi digitado e tente de novo.') };
    }
    if (status === 409) {
      const extra = msg ? ' Detalhe: ' + msg : '';
      if (acao === 'gerar') return { sessaoExpirada: false, texto: 'Já existe um login em andamento para ' + quem + '. Termine esse login ou toque em Cancelar, e só depois gere um novo link.' + extra };
      return { sessaoExpirada: false, texto: 'O estado do login de ' + quem + ' mudou enquanto você mexia. Recarregue a página para ver como ele está.' + extra };
    }
    if (status === 503) {
      return { sessaoExpirada: false, texto: 'O programa de ' + quem + ' não respondeu' + (msg ? ' (' + msg + ')' : '') + '. Confira se ele está ligado na tela de Status do painel ou peça ao Admin para reiniciá-lo, depois toque em tentar de novo.' };
    }
    if (status === 504) {
      return { sessaoExpirada: false, texto: quem + ' demorou para ficar pronto depois do login' + (msg ? ' (' + msg + ')' : '') + '. A conta já está conectada: quando ele estiver de pé, escreva um oi na conversa dele.' };
    }
    if (acao === 'codigo' && RX_CODIGO_RUIM.test(msg)) return { sessaoExpirada: false, texto: FRASE_CODIGO_RUIM };
    if (RX_PRAZO.test(msg)) return { sessaoExpirada: false, texto: FRASE_PRAZO };
    return { sessaoExpirada: false, texto: 'Não consegui ' + fazer + ' (erro ' + status + (msg ? ': ' + msg : '') + '). Tente de novo e, se repetir, peça ajuda ao Admin.' };
  }

  /**
   * O que um cartão mostra. `d` é a resposta de GET .../login (ou null), `ctx`:
   *   iniciado      o login foi começado ou visto em andamento nesta página
   *   concluiuAgora terminou nesta página
   *   erroConferir  frase de erro da consulta do estado
   *   outroNome     nome do agente que está no meio de um login (bloqueia este cartão), ou ''
   *   agente        { id, nome, tipo, subtitulo }
   * fase: sem_resposta | api | conectado | inicio | preparando | codigo | navegador | concluido | falhou
   * O link só existe nas fases codigo e navegador.
   */
  function visaoCartao(d, ctx) {
    ctx = ctx || {};
    const agente = ctx.agente || {};
    const nome = agente.nome || 'O agente';
    const sel = selo(d, ctx);
    const prov = LC.nomeProvedor(d && d.provedor ? d.provedor : agente.provedor);
    const p = papel(agente);
    const base = {
      id: agente.id, nome, papel: p.papel, subtitulo: p.subtitulo, provedor: prov, selo: sel,
      fase: 'inicio', texto: '', passos: [], gerar: false, gerarRotulo: 'Gerar link de login', gerarBloqueio: '',
      link: null, campoCodigo: false, codigoDispositivo: null, cancelar: false, novoLink: false, entrarOutra: false, aviso: '',
    };
    const bloqueio = ctx.outroNome ? 'Termine o login do ' + ctx.outroNome + ' primeiro.' : '';
    if (sel.chave === 'sem_resposta') {
      return Object.assign(base, {
        fase: 'sem_resposta', gerar: false,
        texto: ctx.erroConferir || 'Não consegui conferir a conta de ' + nome + '. Toque em Conferir de novo.',
      });
    }
    if (sel.chave === 'api') {
      return Object.assign(base, {
        fase: 'api',
        texto: nome + ' não usa assinatura: ele trabalha com uma chave de API, que fica guardada no cofre dele. Não há conta do ' + prov + ' para conectar aqui.',
      });
    }
    let estado = (d && d.estado) || 'nenhum';
    if ((estado === 'concluido' || estado === 'falhou') && !ctx.iniciado) estado = 'nenhum';
    switch (estado) {
      case 'aguardando_link':
        return Object.assign(base, { fase: 'preparando', texto: 'Preparando o link…', cancelar: true, aviso: 'Preparando o link de login' });
      case 'aguardando_codigo':
        return Object.assign(base, {
          fase: 'codigo', link: LC.linkSeguro(d.link), campoCodigo: true, cancelar: true, novoLink: true,
          passos: ['Abra a página de login e entre com a sua conta do ' + prov + '.', 'No fim, a página mostra um código. Copie e cole aqui embaixo.'],
          aviso: 'Falta colar o código que a página mostrou',
        });
      case 'aguardando_navegador':
        return Object.assign(base, {
          fase: 'navegador', link: LC.linkSeguro(d.link), codigoDispositivo: d.codigoDispositivo ? String(d.codigoDispositivo) : null, cancelar: true, novoLink: true,
          passos: ['Abra a página de login e entre com a sua conta.', 'Quando a página pedir, digite o código grande abaixo. Eu espero você terminar.'],
          aviso: 'Esperando você terminar o login na página',
        });
      case 'concluido':
        return Object.assign(base, { fase: 'concluido', texto: 'Pronto! ' + nome + ' já pode responder.', entrarOutra: true, aviso: 'Conectado' });
      case 'falhou':
        return Object.assign(base, {
          fase: 'falhou', texto: traduzFalha(d && d.mensagem), gerar: !bloqueio, gerarRotulo: 'Gerar novo link', gerarBloqueio: bloqueio,
          aviso: 'O login falhou',
        });
      default:
        if (sel.chave === 'conectado') {
          return Object.assign(base, {
            fase: 'conectado', texto: nome + ' já usa a sua conta do ' + prov + '. Só entre com outra conta se quiser trocar.',
            entrarOutra: !bloqueio, gerarBloqueio: bloqueio,
          });
        }
        return Object.assign(base, {
          fase: 'inicio', gerar: !bloqueio, gerarBloqueio: bloqueio,
          texto: sel.chave === 'expirou'
            ? 'A conta do ' + prov + ' de ' + nome + ' expirou e ele parou de responder. Reconecte para ele voltar.'
            : nome + ' precisa da sua conta do ' + prov + ' para responder.',
        });
    }
  }

  /** Todos os agentes que usam assinatura estão conectados? (quem usa chave de API não conta) */
  function tudoConectado(selos) {
    const lista = (Array.isArray(selos) ? selos : []).filter(s => s && s.chave !== 'api');
    return lista.length > 0 && lista.every(s => s.chave === 'conectado');
  }

  return { PAPEL_ADMIN, PAPEL_AGENTE, ordenar, papel, selo, limpaCodigo, traduzFalha, traduzErro, visaoCartao, tudoConectado, emAndamento };
});
