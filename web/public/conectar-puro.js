'use strict';
const dgUiText_conectar_puro_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgTexto_conectar_puro = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
/* conectar-puro.js: a parte pura da página /conectar (conectar a conta do Claude ou do Codex de cada agente).

   Sem DOM e sem rede: decide a ordem e o texto dos cartões, o selo de estado de cada um, o que o cartão
   mostra em cada fase do login e como cada erro vira uma frase de leigo. O desenho e as chamadas ficam em
   conectar.js; aqui fica o que se testa com node:test (web/test/conectar-puro.test.js).

   O link de login carrega o estado do OAuth e o código colado é segredo: nenhuma função daqui os devolve
   fora das fases em que a pessoa precisa deles, e nenhum texto de erro os repete. */
(function (raiz, fabrica) {
  const nodeJs = typeof module === 'object' && module.exports;
  const LC = nodeJs ? require('./login-cartao') : raiz.DGLoginCartao;
  const PV = nodeJs ? require('./provedores') : raiz.DGProvedores;
  const m = fabrica(LC, PV);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGConectar = m;
})(this, function (LC, PV) {
  const ROTULO_ADMIN = 'Agente admin';
  const ROTULO_PRINCIPAL = 'Agente principal';
  const ROTULO_TRABALHO = 'Agente de trabalho';
  const PAPEL_ADMIN = 'Para administrar: atualizar o DG Claw, criar agentes e configurar.';
  const PAPEL_PRINCIPAL = 'O seu agente do dia a dia: é com ele que você conversa e pede tarefas.';
  const PAPEL_TRABALHO = 'O seu agente de trabalho.';

  /** Admin primeiro; os demais na ordem em que vieram. Não altera a lista de entrada. */
  function ordenar(agentes) {
    const lista = Array.isArray(agentes) ? agentes.filter(a => a && a.id) : [];
    return lista.filter(a => a.tipo === 'admin').concat(lista.filter(a => a.tipo !== 'admin'));
  }

  /** O agente principal é o primeiro agente de trabalho da lista já ordenada; null se não houver. */
  function principal(agentes) {
    return ordenar(agentes).find(a => a.tipo !== 'admin') || null;
  }

  /** Rótulo e frase de papel em linguagem de leigo. O subtítulo do agente, se houver, vai à parte. */
  function papel(agente, ehPrincipal, colaborador) {
    const a = agente || {};
    if (colaborador) return { rotulo: dgUiText_conectar_puro_js("Seu agente"), papel: dgUiText_conectar_puro_js("O agente com quem você conversa por aqui."), subtitulo: a.subtitulo ? String(a.subtitulo) : '' };
    const adm = a.tipo === 'admin';
    return {
      rotulo: adm ? dgUiText_conectar_puro_js(ROTULO_ADMIN) : ehPrincipal ? dgUiText_conectar_puro_js(ROTULO_PRINCIPAL) : dgUiText_conectar_puro_js(ROTULO_TRABALHO),
      papel: adm ? dgUiText_conectar_puro_js(PAPEL_ADMIN) : ehPrincipal ? dgUiText_conectar_puro_js(PAPEL_PRINCIPAL) : dgUiText_conectar_puro_js(PAPEL_TRABALHO),
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
    if (!d || ctx.erroConferir) return { chave: 'sem_resposta', texto: dgUiText_conectar_puro_js("Não consegui conferir"), cor: 'cinza' };
    // Colaborador: a resposta do servidor não traz auth nem conferido (lista de campos permitidos); vem conectado/precisa_login.
    if (ctx.colaborador) {
      if (d.chave_api === true) return { chave: 'api', texto: dgUiText_conectar_puro_js("Usa chave de API"), cor: 'cinza' };
      if (d.estado === 'concluido' && ctx.concluiuAgora) return { chave: 'conectado', texto: dgUiText_conectar_puro_js("Conectado"), cor: 'verde' };
      if (emAndamento(d.estado)) return { chave: 'andamento', texto: 'Conectando', cor: 'ambar' };
      if (d.login_expirado) return { chave: 'expirou', texto: 'Login expirou', cor: 'vermelho' };
      return d.conectado === true ? { chave: 'conectado', texto: dgUiText_conectar_puro_js("Conectado"), cor: 'verde' } : { chave: 'falta', texto: 'Falta conectar', cor: 'ambar' };
    }
    if (usaChaveDeApi(d.auth)) return { chave: 'api', texto: dgUiText_conectar_puro_js("Usa chave de API"), cor: 'cinza' };
    if (d.estado === 'concluido' && ctx.concluiuAgora) return { chave: 'conectado', texto: dgUiText_conectar_puro_js("Conectado"), cor: 'verde' };
    if (emAndamento(d.estado)) return { chave: 'andamento', texto: 'Conectando', cor: 'ambar' };
    if (d.login_expirado) return { chave: 'expirou', texto: 'Login expirou', cor: 'vermelho' };
    const ok = !!(d.conferido && d.conferido.ok === true) && !d.precisa_login;
    return ok ? { chave: 'conectado', texto: dgUiText_conectar_puro_js("Conectado"), cor: 'verde' } : { chave: 'falta', texto: 'Falta conectar', cor: 'ambar' };
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
    if (RX_PRAZO.test(t)) return dgUiText_conectar_puro_js(FRASE_PRAZO);
    if (RX_CODIGO_RUIM.test(t)) return dgUiText_conectar_puro_js(FRASE_CODIGO_RUIM);
    return t || dgUiText_conectar_puro_js("O login terminou sem conectar a conta. Toque em Gerar link de login para tentar de novo.");
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
  function traduzErro(status, mensagem, acao, nome, colaborador) {
    const msg = String(mensagem || '').trim();
    const quem = nome || dgUiText_conectar_puro_js("o agente");
    const fazer = ACOES[acao] || 'concluir isso';
    if (status === 401) {
      return { sessaoExpirada: true, texto: dgUiText_conectar_puro_js("A sua sessão no painel acabou. Vou levar você de volta ao login; depois de entrar, esta página abre de novo.") };
    }
    if (!status) {
      return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("Não consegui falar com o painel para ") + fazer + (msg ? ' (' + msg + ')' : '') + dgUiText_conectar_puro_js('. Confira a internet do aparelho e tente de novo.') };
    }
    // Colaborador: o servidor já explica em português quem pode o quê (outra pessoa conectando, agente já conectado...).
    if (colaborador && msg && (status === 403 || status === 409)) return { sessaoExpirada: false, texto: msg };
    if (colaborador && status === 503) {
      return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("O agente não respondeu") + (msg ? ' (' + msg + ')' : '') + dgUiText_conectar_puro_js('. Tente de novo em instantes; se continuar, avise o dono do DG Claw.') };
    }
    if (status === 400) {
      return { sessaoExpirada: false, texto: msg || (dgUiText_conectar_puro_js("O painel recusou o pedido para ") + fazer + dgUiText_conectar_puro_js('. Confira o que foi digitado e tente de novo.')) };
    }
    if (status === 409) {
      const extra = msg ? ' Detalhe: ' + msg : '';
      if (acao === 'gerar') return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("Já existe um login em andamento para ") + quem + dgUiText_conectar_puro_js('. Termine esse login ou toque em Cancelar, e só depois gere um novo link.') + extra };
      return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("O estado do login de ") + quem + dgUiText_conectar_puro_js(" mudou enquanto você mexia. Recarregue a página para ver como ele está.") + extra };
    }
    if (status === 503) {
      return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("O programa de ") + quem + dgUiText_conectar_puro_js(" não respondeu") + (msg ? ' (' + msg + ')' : '') + dgUiText_conectar_puro_js('. Confira se ele está ligado na tela de Status do painel ou peça ao Admin para reiniciá-lo, depois toque em tentar de novo.') };
    }
    if (status === 504) {
      return { sessaoExpirada: false, texto: quem + dgUiText_conectar_puro_js(" demorou para ficar pronto depois do login") + (msg ? ' (' + msg + ')' : '') + dgUiText_conectar_puro_js('. A conta já está conectada: quando ele estiver de pé, escreva um oi na conversa dele.') };
    }
    if (acao === 'codigo' && RX_CODIGO_RUIM.test(msg)) return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js(FRASE_CODIGO_RUIM) };
    if (RX_PRAZO.test(msg)) return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js(FRASE_PRAZO) };
    return { sessaoExpirada: false, texto: dgUiText_conectar_puro_js("Não consegui ") + fazer + ' (erro ' + status + (msg ? ': ' + msg : '') + dgUiText_conectar_puro_js("). Tente de novo e, se repetir, ") + (colaborador ? dgUiText_conectar_puro_js("avise o dono do DG Claw.") : dgUiText_conectar_puro_js("peça ajuda ao Admin.")) };
  }

  /**
   * As IAs com que este agente pode entrar, em ordem: só as ativas e compatíveis com ele. Hoje o agente usa a
   * IA em que nasceu, então vem uma só (a dele); quando a troca de IA existir, esta função passa a devolver
   * mais de uma e o cartão vira seletor. A lista de IAs fica em provedores.js.
   */
  function provedoresDoAgente(agente) {
    const id = PV.idDoProvedor(agente && agente.provedor);
    const p = PV.acha(id);
    return p && p.ativo ? [{ id: p.id, nome: p.nome }] : [];
  }

  /** O bloco "Com qual IA este agente vai entrar?" do cartão: `seletor` só vale com mais de uma opção. */
  function escolhaDeIA(agente) {
    const opcoes = provedoresDoAgente(agente);
    return { pergunta: dgUiText_conectar_puro_js("Com qual IA este agente vai entrar?"), opcoes, escolhido: opcoes[0] || null, seletor: opcoes.length > 1 };
  }

  /**
   * O que um cartão mostra. `d` é a resposta de GET .../login (ou null), `ctx`:
   *   iniciado      o login foi começado ou visto em andamento nesta página
   *   concluiuAgora terminou nesta página
   *   erroConferir  frase de erro da consulta do estado
   *   outroNome     nome do agente que está no meio de um login (bloqueia este cartão), ou ''
   *   agente        { id, nome, tipo, subtitulo }
   *   principal     este é o agente principal (o primeiro agente de trabalho)
   * fase: sem_resposta | api | conectado | inicio | preparando | codigo | navegador | concluido | falhou
   * O link só existe nas fases codigo e navegador.
   */
  function visaoCartao(d, ctx) {
    ctx = ctx || {};
    const agente = ctx.agente || {};
    const nome = agente.nome || dgUiText_conectar_puro_js("O agente");
    const sel = selo(d, ctx);
    const prov = LC.nomeProvedor(d && d.provedor ? d.provedor : agente.provedor);
    const p = papel(agente, !!ctx.principal, !!ctx.colaborador);
    const base = {
      id: agente.id, nome, rotulo: p.rotulo, papel: p.papel, subtitulo: p.subtitulo, provedor: prov, selo: sel,
      fase: 'inicio', texto: '', passos: [], gerar: false, gerarRotulo: dgTexto_conectar_puro('Gerar link de login'), gerarBloqueio: '',
      link: null, campoCodigo: false, codigoDispositivo: null, cancelar: false, novoLink: false, entrarOutra: false, aviso: '',
      ia: escolhaDeIA(d && d.provedor ? Object.assign({}, agente, { provedor: d.provedor }) : agente),
    };
    const bloqueio = ctx.outroNome ? dgUiText_conectar_puro_js("Termine o login do ") + ctx.outroNome + ' primeiro.' : '';
    if (ctx.colaborador) {
      // Só o agente dele, sem menção a Admin. Já conectado: uma frase e nenhum botão.
      if (sel.chave === 'api') return Object.assign(base, { fase: 'api', texto: (d && d.mensagem) || (nome + dgUiText_conectar_puro_js(" usa uma chave de API, e não há conta para conectar aqui.")) });
      if (d && d.so_dono) return Object.assign(base, { fase: 'so_dono', texto: d.mensagem || dgUiText_conectar_puro_js("O login deste agente expirou. Avise o dono do DG Claw.") });
      if (d && d.ocupado) return Object.assign(base, { fase: 'ocupado', texto: d.mensagem || dgUiText_conectar_puro_js("Outra pessoa está conectando a conta deste agente agora.") });
    }
    if (sel.chave === 'sem_resposta') {
      return Object.assign(base, {
        fase: 'sem_resposta', gerar: false,
        texto: ctx.erroConferir || dgUiText_conectar_puro_js("Não consegui conferir a conta de ") + nome + dgUiText_conectar_puro_js('. Toque em Conferir de novo.'),
      });
    }
    if (sel.chave === 'api') {
      return Object.assign(base, {
        fase: 'api',
        texto: nome + dgUiText_conectar_puro_js(" não usa assinatura: ele trabalha com uma chave de API, que fica guardada no cofre dele. Não há conta do ") + prov + dgUiText_conectar_puro_js(" para conectar aqui."),
      });
    }
    let estado = (d && d.estado) || 'nenhum';
    if ((estado === 'concluido' || estado === 'falhou') && !ctx.iniciado) estado = 'nenhum';
    switch (estado) {
      case 'aguardando_link':
        return Object.assign(base, { fase: 'preparando', texto: dgUiText_conectar_puro_js("Preparando o link…"), cancelar: true, aviso: dgUiText_conectar_puro_js("Preparando o link de login") });
      case 'aguardando_codigo':
        return Object.assign(base, {
          fase: 'codigo', link: LC.linkSeguro(d.link), campoCodigo: true, cancelar: true, novoLink: true,
          passos: [dgUiText_conectar_puro_js("Abra a página de login e entre com a sua conta do ") + prov + '.', dgUiText_conectar_puro_js("No fim, a página mostra um código. Copie e cole aqui embaixo.")],
          aviso: dgUiText_conectar_puro_js("Falta colar o código que a página mostrou"),
        });
      case 'aguardando_navegador':
        return Object.assign(base, {
          fase: 'navegador', link: LC.linkSeguro(d.link), codigoDispositivo: d.codigoDispositivo ? String(d.codigoDispositivo) : null, cancelar: true, novoLink: true,
          passos: [dgUiText_conectar_puro_js("Abra a página de login e entre com a sua conta."), dgUiText_conectar_puro_js("Quando a página pedir, digite o código grande abaixo. Eu espero você terminar.")],
          aviso: dgUiText_conectar_puro_js("Esperando você terminar o login na página"),
        });
      case 'concluido':
        if (ctx.colaborador) return Object.assign(base, { fase: 'concluido', texto: dgUiText_conectar_puro_js("Este agente já está conectado."), aviso: dgUiText_conectar_puro_js("Conectado") });
        return Object.assign(base, { fase: 'concluido', texto: dgUiText_conectar_puro_js("Seu agente DG Claw já está conectado."), entrarOutra: true, aviso: dgUiText_conectar_puro_js("Conectado") });
      case 'falhou':
        return Object.assign(base, {
          fase: 'falhou', texto: traduzFalha(d && d.mensagem), gerar: !bloqueio, gerarRotulo: dgUiText_conectar_puro_js("Gerar novo link"), gerarBloqueio: bloqueio,
          aviso: dgUiText_conectar_puro_js("O login falhou"),
        });
      default:
        if (sel.chave === 'conectado' && ctx.colaborador) return Object.assign(base, { fase: 'conectado', texto: dgUiText_conectar_puro_js("Este agente já está conectado.") });
        if (sel.chave === 'conectado') {
          return Object.assign(base, {
            fase: 'conectado', texto: nome + dgUiText_conectar_puro_js(" já usa a sua conta do ") + prov + dgUiText_conectar_puro_js('. Só entre com outra conta se quiser trocar.'),
            entrarOutra: !bloqueio, gerarBloqueio: bloqueio,
          });
        }
        return Object.assign(base, {
          fase: 'inicio', gerar: !bloqueio, gerarBloqueio: bloqueio,
          texto: ctx.colaborador
            ? nome + dgUiText_conectar_puro_js(" ainda não tem uma conta de IA conectada. Conecte a sua conta do ") + prov + dgUiText_conectar_puro_js(" para o agente poder responder.")
            : sel.chave === 'expirou'
              ? dgUiText_conectar_puro_js("A conta do ") + prov + dgUiText_conectar_puro_js(" de ") + nome + dgUiText_conectar_puro_js(" expirou e ele parou de responder. Reconecte para ele voltar.")
              : nome + dgUiText_conectar_puro_js(" precisa da sua conta do ") + prov + dgUiText_conectar_puro_js(" para responder."),
        });
    }
  }

  /** Todos os agentes que usam assinatura estão conectados? (quem usa chave de API não conta) */
  function tudoConectado(selos) {
    const lista = (Array.isArray(selos) ? selos : []).filter(s => s && s.chave !== 'api');
    return lista.length > 0 && lista.every(s => s.chave === 'conectado');
  }

  /** Textos do mini tutorial "Tudo pronto". Nunca recebe nem mostra senha. */
  function pronto(ctx) {
    ctx = ctx || {};
    const usuario = ctx.usuario ? String(ctx.usuario) : '';
    // Colaborador conversa com um agente só: nada de Admin nem de "pedir ao Admin".
    if (ctx.colaborador) {
      return {
        get titulo() { return dgUiText_conectar_puro_js("Tudo pronto! Agora é só usar"); },
        passo1: dgUiText_conectar_puro_js("1. Acesse o seu agente:"),
        endereco: String(ctx.endereco || ''),
        passo2: dgUiText_conectar_puro_js("2. Entre com o seu e-mail") + (usuario ? ' (' + usuario + ')' : '') + dgUiText_conectar_puro_js(" e a senha que você criou."),
        passo3: dgUiText_conectar_puro_js("3. O que você vai ver:"),
        itens: [(ctx.principalNome || dgUiText_conectar_puro_js("O seu agente")) + dgUiText_conectar_puro_js(": o agente com quem você conversa por aqui.")],
        legendaVideo: dgUiText_conectar_puro_js("Veja em menos de 1 minuto"),
      };
    }
    const itens = [dgUiText_conectar_puro_js("Admin: para administrar (atualizar o DG Claw, criar agentes e configurar).")];
    if (ctx.principalNome) itens.push(ctx.principalNome + dgUiText_conectar_puro_js(": o seu agente do dia a dia. Você pode trocar o nome dele depois, é só pedir ao Admin."));
    return {
      get titulo() { return dgUiText_conectar_puro_js("Tudo pronto! Agora é só usar"); },
      passo1: dgUiText_conectar_puro_js("1. Acesse o seu painel:"),
      endereco: String(ctx.endereco || ''),
      passo2: dgUiText_conectar_puro_js("2. Entre com o usuário ") + (usuario || dgUiText_conectar_puro_js("que você escolheu")) + dgUiText_conectar_puro_js(" e a mesma senha que você usou para entrar aqui."),
      passo3: dgUiText_conectar_puro_js("3. O que você vai ver:"),
      itens,
      legendaVideo: dgUiText_conectar_puro_js("Veja em menos de 1 minuto"),
    };
  }

  /** O modal abre se algum agente está sem login ou com o login vencido. Erro de consulta, chave de API e login em andamento não abrem. */
  function deveAbrirModal(selos) {
    return (Array.isArray(selos) ? selos : []).some(x => x && (x.chave === 'falta' || x.chave === 'expirou'));
  }

  /** Quais agentes sem login o modal ainda não apresentou a esta pessoa. `ids` e `selos` andam na mesma ordem;
   *  `prefs` é { vistos, nao_mostrar_mais } vindo do servidor. Com "não mostrar mais" a lista é vazia. */
  function agentesNovosParaModal(ids, selos, prefs) {
    if (prefs && prefs.nao_mostrar_mais === true) return [];
    const vistos = new Set(prefs && Array.isArray(prefs.vistos) ? prefs.vistos : []);
    const lista = Array.isArray(ids) ? ids : [];
    const ss = Array.isArray(selos) ? selos : [];
    return lista.filter((id, i) => ss[i] && (ss[i].chave === 'falta' || ss[i].chave === 'expirou') && !vistos.has(id));
  }

  /** Todos os agentes que usam assinatura ficaram conectados (e há pelo menos um). */
  function modalCompleto(selos) {
    return tudoConectado(selos);
  }

  /** Os textos do modal de login para `n` agentes. `ctx.principalNome` entra na lista "o que fazer agora". */
  function textosModal(n, ctx) {
    const um = n <= 1;
    const fim = um ? dgUiText_conectar_puro_js("Login efetuado no seu agente") : n === 2 ? 'Login efetuado nos dois agentes' : 'Login efetuado nos seus ' + n + ' agentes';
    return {
      get titulo() { return um ? dgUiText_conectar_puro_js("Faça o login no seu agente") : dgUiText_conectar_puro_js("Faça o login nos seus agentes"); },
      intro: um
        ? dgUiText_conectar_puro_js("Ele precisa da sua conta para responder. Gere o link, entre na sua conta e cole o código aqui.")
        : dgUiText_conectar_puro_js("Eles precisam da sua conta para responder. Em cada cartão, gere o link, entre na sua conta e cole o código aqui."),
      tituloFim: fim,
      agora: dgUiText_conectar_puro_js("Está tudo certo. Agora é só começar a conversar:"),
      itens: pronto(ctx).itens,
      depois: dgUiText_conectar_puro_js("Fazer depois"),
      nunca: dgUiText_conectar_puro_js("Não mostrar mais"),
      comecar: dgUiText_conectar_puro_js("Começar a usar"),
      legendaVideo: dgUiText_conectar_puro_js("Veja em menos de 1 minuto"),
    };
  }

  return { deveAbrirModal, agentesNovosParaModal, modalCompleto, textosModal, provedoresDoAgente, escolhaDeIA, pronto, ROTULO_ADMIN, ROTULO_PRINCIPAL, ROTULO_TRABALHO, PAPEL_ADMIN, PAPEL_PRINCIPAL, PAPEL_TRABALHO, ordenar, principal, papel, selo, limpaCodigo, traduzFalha, traduzErro, visaoCartao, tudoConectado, emAndamento };
});
