'use strict';
const dgUiText_seguranca_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgUiHtml_seguranca_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
const dgSegFrase = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.frase(fonte, valores) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m, k) => valores && Object.hasOwn(valores, k) ? String(valores[k]) : m);
const dgSegFragmento = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : RSegEsc(dgSegFrase(fonte, valores));
const RSegEsc = texto => String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const dgSegRotulo = (el, fonte, valores) => { if (globalThis.DGI18n) globalThis.DGI18n.rotulo(el, fonte, undefined, valores); else if (el) el.textContent = dgSegFrase(fonte, valores); };
const dgTexto_seguranca = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgHtml_seguranca = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
/* seguranca.js: a tela "Segurança" (/seguranca): os avisos de segurança do DG Claw (boletins), a ronda de fábrica, o que
   foi aplicado sozinho, o que pede decisão, o que dá para corrigir sem pressa e o botão de emergência. É aqui que fica o
   detalhe de tudo o que o aviso único (seguranca-resumo.js) resume.

   Lê GET /api/v1/seguranca/boletins, /ronda e /emergencia. Cada clique vira um PEDIDO (o servidor, como root, valida de novo e
   executa); a tela espera o resultado a cada 2 s, por até 2 min. Contrato: web/docs/RONDA-PAINEL.md e
   web/docs/SEGURANCA-BOLETINS.md.
   Tudo que vem da API nasceu em fontes externas: passa por esc() antes de virar HTML e link só se for https://.
   As funções que só montam texto e HTML ficam fora do DOM e têm teste em web/test/ronda-tela.test.js. */
(function (raiz, fabrica) {
  const R = typeof module === 'object' && module.exports ? require('./ronda-comum') : raiz.DGRondaComum;
  const m = fabrica(raiz, R);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGSegurancaTela = m;
})(this, function (raiz, R) {
  const { esc } = R;
  const POLL_MS = 5 * 60 * 1000;
  const FRASE_CORTAR = 'TIRAR-DO-AR';
  const FRASE_RELIGAR = 'RELIGAR';

  const TEXTO_EMERGENCIA = 'O botão de emergência tira o sistema da internet: o painel, os sites e tudo o que é público saem do ar, e só o seu acesso de administração pelo Tailscale continua entrando. Se ninguém confirmar, ele religa sozinho em 5 minutos. Use quando uma falha crítica estiver sendo explorada e a correção ainda não puder ser aplicada.';

  const TEXTO_PEDIR_ADMIN = 'A correção já foi publicada, mas o painel não a aplica sozinho: o Admin analisa com você, diz se algum serviço vai reiniciar e faz a atualização. O botão abre a conversa com o pedido já escrito.';

  const VAZIO = {
    1: 'Nada foi aplicado sozinho nesta ronda.',
    2: 'Nenhuma falha crítica pedindo decisão.',
    3: 'Nada para corrigir sem pressa.',
  };

  const AVISO_AUTO_ADMIN = 'Ligado, o DG Claw chama o Admin sozinho quando uma integração cair. O Admin tem acesso total ao servidor, e um agente consegue registrar uma falha que não aconteceu: com isso ele faria o Admin olhar uma integração que está boa. O pedido tem texto fixo, só pede para investigar e propor, e há limites (um por defeito, um a cada 6 horas por integração, cinco por dia). Nada é aplicado sem o seu ok.';

  /* O que a seção mostra e quais botões oferece, para cada estado do interruptor (ui: confirmando = aviso aberto). */
  function autoAdminEstadoTexto(ligado) {
    return ligado ? 'Ligado: o DG Claw chama o Admin sozinho quando uma integração cair.' : 'Desligado: o Admin só é chamado quando você pede, pelo botão da faixa de integrações.';
  }
  function autoAdminBotoes(ligado, confirmando) {
    if (ligado) return [{ acao: 'auto-desligar', rotulo: 'Desligar', classe: 'rp-btn' }];
    if (confirmando) return [{ acao: 'auto-confirmar', rotulo: 'Entendi o risco, ligar', classe: 'rp-btn rp-perigo' }, { acao: 'auto-cancelar', rotulo: 'Cancelar', classe: 'rp-btn' }];
    return [{ acao: 'auto-ligar', rotulo: 'Ligar', classe: 'rp-btn rp-pri' }];
  }

  const VAZIO_BOLETINS = 'Nenhum aviso de segurança pendente.';

  const FRASE_AGUARDANDO = 'Estas falhas ainda não têm correção publicada pelo fornecedor. Nada a fazer agora: a ronda confere a cada rodada e avisa quando a correção sair.';
  const VAZIO_AGUARDANDO = 'Nenhuma falha esperando a correção do fornecedor.';
  const FRASE_ATUALIZACOES = 'Estas falhas já têm correção pelo canal normal de atualização do Ubuntu e não são alarme. Com a atualização automática ligada (o padrão do Ubuntu), ela entra sozinha; se não estiver, use o botão para pedir ao Admin.';
  const VAZIO_ATUALIZACOES = 'Nenhuma atualização do sistema na fila.';

  /* ── avisos de segurança do DG Claw (boletins) ──────────────────────────── */
  function botoesBoletimHtml(b) {
    if (R.temCorrecaoParaAplicar(b)) {
      return dgHtml_seguranca("<button type=\"button\" class=\"rp-btn rp-pri\" data-rp=\"b-atualizar\"><!--dg-i18n:dafb59613e12-->Atualizar<!--/dg-i18n--></button>") +
        dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn\" data-rp=\"b-lembrar\"><!--dg-i18n:17d13d732364-->Lembrar depois<!--/dg-i18n--></button>");
    }
    return dgHtml_seguranca("<button type=\"button\" class=\"rp-btn rp-pri\" data-rp=\"b-entendi\"><!--dg-i18n:9f93738a0362-->Entendi<!--/dg-i18n--></button>");
  }

  /* Boletim sem correção ainda: o detalhe fica à vista. Com correção: recolhido, para a decisão ficar no botão. */
  function cardBoletimHtml(b, agora) {
    const comCorrecao = R.temCorrecaoParaAplicar(b);
    const detalhe = b.detalhe ? esc(b.detalhe) : '';
    const adiado = b.adiado_ate && Date.parse(b.adiado_ate) > agora
      ? dgUiHtml_seguranca_js("<p class=\"rp-fraco\"><!--dg-i18n:857a0b776f4c-->Você pediu para lembrar depois (até<!--/dg-i18n--> ") + esc(R.quando(b.adiado_ate, agora)) + dgUiHtml_seguranca_js("<!--dg-i18n:ddeb6123af58-->). O aviso continua valendo até o sistema ser atualizado.<!--/dg-i18n--></p>") : '';
    return '<article class="rp-card rp-n2" data-id="' + esc(b.id) + '" data-boletim="1"><h3>' + esc(b.titulo || b.componente || b.id) +
      ' <span class="rp-tag rp-grav-' + esc(String(b.severidade).toLowerCase()) + '">' + esc(R.gravidadeRotulo(b.severidade)) + '</span></h3>' +
      '<p class="rp-texto">' + esc(R.textoBoletim(b, agora)) + '</p>' +
      (!comCorrecao && detalhe ? '<p class="rp-texto rp-boletim-detalhe">' + detalhe + '</p>' : '') +
      R.fatosBoletimHtml(b) +
      (comCorrecao && detalhe ? dgUiHtml_seguranca_js("<details class=\"rp-detalhe\"><summary><!--dg-i18n:4a4ed02d3dca-->Ver detalhes<!--/dg-i18n--></summary><p class=\"rp-texto rp-boletim-detalhe\">") + detalhe + '</p></details>' : '') +
      adiado + '<div class="rp-acoes">' + botoesBoletimHtml(b) + '</div>' +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  /* Boletins pendentes viram cards; os já dispensados ("Entendi" num aviso sem correção) ficam numa linha recolhida,
     porque o risco continua até a correção sair: nenhum aviso some da tela. */
  function listaBoletinsHtml(boletins, agora) {
    const todos = Array.isArray(boletins) ? boletins.filter(b => b && typeof b.id === 'string') : [];
    const pendentes = R.ordenaPorGravidade(todos.filter(b => !b.dispensado));
    const dispensados = R.ordenaPorGravidade(todos.filter(b => b.dispensado));
    let h = pendentes.length ? pendentes.map(b => cardBoletimHtml(b, agora)).join('') : '<p class="rp-vazio">' + esc(dgUiText_seguranca_js(VAZIO_BOLETINS)) + '</p>';
    if (dispensados.length) {
      h += dgUiHtml_seguranca_js("<details class=\"rp-detalhe rp-dispensados\"><summary><!--dg-i18n:40e5008e3ab9-->Já dispensados (<!--/dg-i18n-->") + dispensados.length + ')</summary><ul class="rp-tratadas">' +
        dispensados.map(b => '<li><b>' + esc(b.titulo || b.componente || b.id) + '</b> <small>' + esc(R.gravidadeRotulo(b.severidade)) +
          ', publicado em ' + esc(R.dataBr(b.publicado_em)) + '</small></li>').join('') + '</ul></details>';
    }
    return h;
  }

  /* ── níveis ─────────────────────────────────────────────────────────────── */
  function rotuloAgendado(a) { return a.estado === 'agendado' ? dgUiHtml_seguranca_js("<span class=\"rp-tag rp-tag-ok\"><!--dg-i18n:413243064dd9-->Agendado<!--/dg-i18n--></span>") : ''; }

  function cabecaCard(a) {
    return '<h3>' + esc(a.nome_simples) + ' <span class="rp-tag rp-grav-' + esc(String(a.severidade).toLowerCase()) + '">' +
      esc(R.gravidadeRotulo(a.severidade)) + '</span>' + rotuloAgendado(a) + '</h3>';
  }

  function cardAplicadoHtml(a, agora) {
    const desfaz = a.estado === 'aplicado-sozinho' && a.aplicado && a.aplicado.desfazer
      ? dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn\" data-rp=\"desfazer\"><!--dg-i18n:786b48222848-->Desfazer<!--/dg-i18n--></button>") : '';
    return '<article class="rp-card rp-n1" data-id="' + esc(a.id) + '">' + cabecaCard(a) +
      '<p class="rp-texto">' + esc(R.textoAplicado(a, agora)) + '</p>' +
      dgUiHtml_seguranca_js("<details class=\"rp-detalhe\"><summary><!--dg-i18n:3147c027813b-->Ver detalhes da falha<!--/dg-i18n--></summary>") + R.fatosHtml(a) + '</details>' +
      (desfaz ? '<div class="rp-acoes">' + desfaz + '</div>' : '') +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  function cardAcaoHtml(a, agora) {
    const aberto = a.estado === 'aberto';
    const pode = R.podeAplicar(a);
    let corpo;
    if (!aberto && a.estado !== 'agendado') {
      corpo = '<p class="rp-texto">' + esc(R.textoAplicado(a, agora)) + '</p>';
    } else if (R.podePedirAoAdmin(a)) {
      corpo = '<p class="rp-aviso">' + esc(dgUiText_seguranca_js(TEXTO_PEDIR_ADMIN)) + '</p>' +
        '<div class="rp-acoes">' +
        dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn rp-pri\" data-rp=\"pedir-admin\"><!--dg-i18n:dacc9a5bdd47-->Pedir ao Admin<!--/dg-i18n--></button>") +
        dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn rp-perigo\" data-rp=\"tirar-do-ar\"><!--dg-i18n:938ec9aaa1ba-->Tirar do ar<!--/dg-i18n--></button></div>");
    } else {
      const paliativo = !!(a.correcao && a.correcao.paliativo);
      const aviso = paliativo ? dgUiText_seguranca_js("Esta é uma proteção provisória, enquanto a correção oficial não sai.") + (a.paliativo && a.paliativo.efeito ? ' ' + a.paliativo.efeito : '') + dgUiText_seguranca_js(" Não pede reinício e dá para desfazer depois.")
        : pode ? R.avisoReinicio(a) : dgUiText_seguranca_js("A correção ainda não está pronta. Enquanto isso, o botão \"Tirar do ar\" é a proteção disponível.");
      corpo = '<p class="rp-aviso">' + esc(aviso) + '</p>' +
        '<div class="rp-acoes">' +
        '<button type="button" class="rp-btn rp-pri" data-rp="aplicar"' + (pode ? '' : ' disabled') + '>' + (paliativo ? dgUiText_seguranca_js("Aplicar proteção provisória") : dgUiText_seguranca_js("Aplicar correção")) + '</button>' +
        '<button type="button" class="rp-btn" data-rp="agendar-abre"' + (pode && aberto ? '' : ' disabled') + dgUiHtml_seguranca_js("><!--dg-i18n:8bb241e9ee6b-->Agendar<!--/dg-i18n--></button>") +
        dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn rp-perigo\" data-rp=\"tirar-do-ar\"><!--dg-i18n:938ec9aaa1ba-->Tirar do ar<!--/dg-i18n--></button></div>") +
        dgUiHtml_seguranca_js("<div class=\"rp-agenda\" hidden><label><!--dg-i18n:a3aee5d86e88-->Aplicar em<!--/dg-i18n--><input type=\"datetime-local\" class=\"rp-quando\"></label>") +
        dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn rp-pri\" data-rp=\"agendar\"><!--dg-i18n:f1a6a27b446b-->Confirmar agendamento<!--/dg-i18n--></button></div>");
    }
    return '<article class="rp-card rp-n2" data-id="' + esc(a.id) + '">' + cabecaCard(a) + R.fatosHtml(a) + corpo +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  function cardSemPressaHtml(a, agora) {
    let corpo;
    if (a.estado !== 'aberto') {
      corpo = '<p class="rp-texto">' + esc(R.textoAplicado(a, agora)) + '</p>';
    } else {
      corpo = '<p class="rp-texto">' + esc(R.TEXTO_NIVEL3) + '</p>' +
        '<div class="rp-acoes">' + (R.podePedirAoAdmin(a)
          ? dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn rp-pri\" data-rp=\"pedir-admin\"><!--dg-i18n:dacc9a5bdd47-->Pedir ao Admin<!--/dg-i18n--></button>")
          : '<button type="button" class="rp-btn rp-pri" data-rp="corrigir"' + (R.podeAplicar(a) ? '' : ' disabled') + dgUiHtml_seguranca_js("><!--dg-i18n:c48b9ae2734b-->Corrigir agora<!--/dg-i18n--></button>")) + '</div>';
    }
    return '<article class="rp-card rp-n3" data-id="' + esc(a.id) + '">' + cabecaCard(a) + corpo + R.fatosHtml(a) +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  /* Falha sem correção instalável: card neutro e informativo. Mostra a proteção provisória quando há, e o Desfazer dela. */
  function cardAguardandoHtml(a, agora) {
    const pal = a.paliativo && a.paliativo.verificado ? a.paliativo : null;
    const desfaz = a.estado === 'protegido-aguardando' && a.aplicado && a.aplicado.desfazer
      ? dgUiHtml_seguranca_js("<button type=\"button\" class=\"rp-btn\" data-rp=\"desfazer\"><!--dg-i18n:786b48222848-->Desfazer<!--/dg-i18n--></button>") : '';
    return '<article class="rp-card rp-aguarda" data-id="' + esc(a.id) + '"><h3>' + esc(a.nome_simples) + ' <span class="rp-tag rp-grav-' +
      esc(String(a.severidade).toLowerCase()) + '">' + esc(R.gravidadeRotulo(a.severidade)) + '</span> <span class="rp-tag' +
      (pal ? ' rp-tag-ok' : '') + '">' + esc(R.estadoRotulo(a.estado)) + '</span></h3>' +
      (pal ? dgUiHtml_seguranca_js("<p class=\"rp-texto\"><b><!--dg-i18n:eb7e30de7480-->Proteção provisória ativa:<!--/dg-i18n--></b> ") + esc(pal.descricao) + (pal.efeito ? '. ' + esc(pal.efeito) : '') +
        (pal.verificado_em ? dgUiHtml_seguranca_js(" <small><!--dg-i18n:cff210bec2c8-->(conferida<!--/dg-i18n--> ") + esc(R.quando(pal.verificado_em, agora)) + ')</small>' : '') + '</p>' : '') +
      '<p class="rp-texto">' + esc(a.como_corrigir || dgUiText_seguranca_js("Aguardando a correção do fornecedor.")) + '</p>' +
      dgUiHtml_seguranca_js("<details class=\"rp-detalhe\"><summary><!--dg-i18n:3147c027813b-->Ver detalhes da falha<!--/dg-i18n--></summary>") + R.fatosHtml(a) + '</details>' +
      (desfaz ? '<div class="rp-acoes">' + desfaz + '</div>' : '') +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  function listaAguardandoHtml(achados, agora) {
    if (!achados || !achados.length) return '<p class="rp-vazio">' + esc(dgUiText_seguranca_js(VAZIO_AGUARDANDO)) + '</p>';
    return '<p class="rp-texto" id="rpAguardandoFrase">' + esc(dgUiText_seguranca_js(FRASE_AGUARDANDO)) + '</p>' + achados.map(a => cardAguardandoHtml(a, agora)).join('');
  }

  function tituloAguardando(n) { return dgUiText_seguranca_js("Aguardando correção oficial (") + n + ')'; }

  /* Pacote do sistema com correção no apt: card neutro, sem etiqueta de gravidade. O kernel sozinho junta dezenas de falhas,
     então cada componente vira UMA linha recolhida; abrir mostra cada falha. */
  function cardAtualizacaoHtml(a) {
    const pede = R.podePedirAtualizacao(a)
      ? '<div class="rp-acoes"><button type="button" class="rp-btn rp-pri" data-rp="pedir-admin">' + dgSegFragmento('Pedir ao Admin') + '</button></div>' : '';
    return '<article class="rp-card rp-aguarda" data-id="' + esc(a.id) + '"><h3>' + esc(a.nome_simples) + ' <span class="rp-tag">' +
      esc(R.estadoRotulo(a.estado)) + '</span></h3>' +
      '<p class="rp-texto">' + (a.como_corrigir ? esc(a.como_corrigir) : dgSegFragmento(FRASE_ATUALIZACOES)) + '</p>' + pede +
      '<details class="rp-detalhe"><summary>' + dgSegFragmento('Ver detalhes da falha') + '</summary>' + R.fatosHtml(a) + '</details>' +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }



  function agrupaPorComponente(achados) {
    const grupos = new Map();
    for (const a of achados) {
      const nome = (a.componente && String(a.componente).trim()) || 'Outros componentes';
      if (!grupos.has(nome)) grupos.set(nome, []);
      grupos.get(nome).push(a);
    }
    return Array.from(grupos, ([nome, itens]) => ({ nome, itens })).sort((x, y) => y.itens.length - x.itens.length || x.nome.localeCompare(y.nome, 'pt-BR'));
  }

  function resumoGrupoAtualizacoes(g, html) {
    const n = g.itens.length;
    const semNome = g.itens.every(a => !a.componente || !String(a.componente).trim());
    const fonte = semNome ? (n === 1 ? 'Outros componentes: {n} correção na fila da atualização do sistema' : 'Outros componentes: {n} correções na fila da atualização do sistema') : (n === 1 ? '{nome}: {n} correção na fila da atualização do sistema' : '{nome}: {n} correções na fila da atualização do sistema');
    const valores = { nome: g.nome.charAt(0).toUpperCase() + g.nome.slice(1), n };
    return html ? dgSegFragmento(fonte, valores) : dgSegFrase(fonte, valores);
  }

  function listaAtualizacoesHtml(achados) {
    if (!achados || !achados.length) return '<p class="rp-vazio">' + dgSegFragmento(VAZIO_ATUALIZACOES) + '</p>';
    return '<p class="rp-texto" id="rpAtualizacoesFrase">' + dgSegFragmento(FRASE_ATUALIZACOES) + '</p>' +
      agrupaPorComponente(achados).map(g => '<details class="rp-detalhe rp-grupo-aguarda" data-componente="' + esc(g.nome) + '"><summary>' +
        resumoGrupoAtualizacoes(g, true) + '</summary>' + g.itens.map(cardAtualizacaoHtml).join('') + '</details>').join('');
  }

  function tituloAtualizacoes(n) { return dgSegFrase('Atualizações do sistema ({n})', { n }); }

  /* Os níveis 2 e 3 só mostram o que pede alguma coisa de alguém; o resto vai para a seção informativa. */
  function listaNivelHtml(achados, nivel, agora) {
    const lista = (achados || []).filter(a => !R.segundoPlano(a));
    if (!lista.length) return '<p class="rp-vazio">' + esc(dgUiText_seguranca_js(VAZIO[nivel])) + '</p>';
    const f = nivel === 1 ? cardAplicadoHtml : nivel === 2 ? cardAcaoHtml : cardSemPressaHtml;
    return lista.map(a => f(a, agora)).join('');
  }

  function tratadasHtml(lista) {
    if (!lista || !lista.length) return dgUiHtml_seguranca_js("<p class=\"rp-vazio\"><!--dg-i18n:b1c48f5fb934-->Nenhuma falha foi marcada como tratada até agora.<!--/dg-i18n--></p>");
    return '<ul class="rp-tratadas">' + lista.map(t => '<li><b>' + esc(t.componente || t.id) + '</b>' +
      (t.id && t.componente ? ' <small>' + esc(t.id) + '</small>' : '') + (t.como ? ': ' + esc(t.como) : '') + '</li>').join('') + '</ul>';
  }

  function inventarioHtml(inv) {
    if (!inv) return dgUiHtml_seguranca_js("<p class=\"rp-vazio\"><!--dg-i18n:85919fc908b2-->A ronda ainda não registrou o que olha neste servidor.<!--/dg-i18n--></p>");
    const linhas = [];
    if (inv.kernel) linhas.push(dgUiHtml_seguranca_js("<li><b><!--dg-i18n:8a716159a685-->Kernel<!--/dg-i18n--></b>: ") + esc(inv.kernel) + '</li>');
    if (inv.componentes != null) linhas.push(dgUiHtml_seguranca_js("<li><b><!--dg-i18n:ff4e40e65b60-->Componentes conferidos<!--/dg-i18n--></b>: ") + esc(inv.componentes) + '</li>');
    const portas = (inv.portas_publicas || []).map(p => esc(p.porta) + (p.processo ? ' (' + esc(p.processo) + ')' : ''));
    linhas.push(dgUiHtml_seguranca_js("<li><b><!--dg-i18n:631288dc91a2-->Portas abertas para a internet<!--/dg-i18n--></b>: ") + (portas.length ? portas.join(', ') : 'nenhuma informada') + '</li>');
    const ext = (inv.servicos_externos || []).map(s => esc(s.nome) + (s.via ? dgUiHtml_seguranca_js(" <small><!--dg-i18n:4d327af41f96-->via<!--/dg-i18n--> ") + esc(s.via) + (s.versao ? dgUiText_seguranca_js(", versão ") + esc(s.versao) : '') + '</small>' : ''));
    linhas.push(dgUiHtml_seguranca_js("<li><b><!--dg-i18n:e56031c66da1-->Serviços externos conectados<!--/dg-i18n--></b>: ") + (ext.length ? ext.join('; ') : 'nenhum informado') + '</li>');
    if (inv.reinventariado_em) linhas.push(dgUiHtml_seguranca_js("<li><b><!--dg-i18n:e388bc87340f-->Lista refeita em<!--/dg-i18n--></b>: ") + esc(R.quando(inv.reinventariado_em, Date.now())) + '</li>');
    return '<ul class="rp-inv">' + linhas.join('') + '</ul>';
  }

  /* ── emergência ─────────────────────────────────────────────────────────── */
  function planoHtml(plano) {
    if (!plano || !plano.comandos || !plano.comandos.length) return dgUiHtml_seguranca_js("<p class=\"rp-vazio\"><!--dg-i18n:a32bdddf3af3-->O servidor não trouxe o plano. Rode \"sudo dgclaw emergencia simular\".<!--/dg-i18n--></p>");
    return dgUiHtml_seguranca_js("<div class=\"rp-plano\"><p class=\"rp-texto\"><b><!--dg-i18n:f0f69190217d-->O que vai acontecer, passo a passo:<!--/dg-i18n--></b></p><ol>") +
      plano.comandos.map(c => '<li><code>' + esc(c) + '</code></li>').join('') + '</ol>' +
      (plano.avisos && plano.avisos.length ? '<ul class="rp-aviso-lista">' + plano.avisos.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
  }

  /* e = resposta de GET /emergencia; ui = { fase: 'ocioso'|'preparando'|'codigo', verPlano, acao, codigo, expira_em, plano } */
  function emergenciaHtml(e, ui) {
    const u = ui || { fase: 'ocioso' };
    const est = (e && e.estado) || { cortado: false };
    let h = '<p class="rp-texto" id="rpEmTexto">' + esc(dgUiText_seguranca_js(TEXTO_EMERGENCIA)) + '</p>';
    const inconsistente = !!(est.cortado && est.inconsistente);
    if (inconsistente) {
      h += dgUiHtml_seguranca_js("<div class=\"rp-alerta rp-alerta-vermelha\" id=\"rpEmInconsistente\" role=\"alert\"><b><!--dg-i18n:34afc138c1ad-->Falha de proteção.<!--/dg-i18n--></b> <!--dg-i18n:60539c7f7176-->O corte de emergência está marcado, mas o firewall não está carregado: o servidor pode estar exposto.<!--/dg-i18n-->") +
        (est.motivo_inconsistente ? ' <small>' + esc(est.motivo_inconsistente) + '</small>' : '') + '</div>';
    } else if (est.cortado) {
      h += dgUiHtml_seguranca_js("<div class=\"rp-alerta\" id=\"rpEmCortado\" role=\"alert\"><b><!--dg-i18n:0c11fb57fe74-->O sistema está fora do ar<!--/dg-i18n--></b> <!--dg-i18n:1e06e6dac28b-->desde<!--/dg-i18n--> ") + esc(R.quando(est.desde, Date.now())) + '.' +
        (est.confirmado ? dgUiText_seguranca_js(" O corte foi confirmado e fica até você religar.")
          : est.religar_automatico_em ? dgUiText_seguranca_js(" Se ninguém confirmar, ele religa sozinho em ") + esc(R.quando(est.religar_automatico_em, Date.now())) + '.' : '') + '</div>';
    }
    const indisponivel = !est.cortado && (!e || !e.disponivel);
    if (indisponivel) {
      h += dgUiHtml_seguranca_js("<div class=\"rp-bloqueio\" id=\"rpEmMotivo\" role=\"status\"><b><!--dg-i18n:3ecfa6e1d4f7-->O botão está desligado por enquanto.<!--/dg-i18n--></b> ") + esc((e && e.motivo) || dgUiText_seguranca_js("Não foi possível saber se o corte é seguro.")) + '</div>';
    } else if (e && e.desatualizado) {
      h += dgUiHtml_seguranca_js("<p class=\"rp-fraco\"><!--dg-i18n:3927815afc2f-->A medição do servidor tem mais de 2 horas. Rode \"sudo dgclaw emergencia estado\" para atualizar.<!--/dg-i18n--></p>");
    }
    const ocupado = u.fase === 'preparando';
    h += '<div class="rp-acoes"><button type="button" class="rp-btn" data-rp="simular" id="btnSimular"' + (e && e.plano && e.plano.comandos && e.plano.comandos.length ? '' : ' disabled') + dgUiHtml_seguranca_js("><!--dg-i18n:6b58dcab6a07-->Simular<!--/dg-i18n--></button>");
    if (inconsistente) {
      h += '<button type="button" class="rp-btn rp-perigo" data-rp="preparar" data-acao="cortar" id="btnReaplicar"' + (ocupado ? ' disabled' : '') + dgUiHtml_seguranca_js("><!--dg-i18n:5bd1a3df8a52-->Reaplicar o corte<!--/dg-i18n--></button>") +
        '<button type="button" class="rp-btn rp-pri" data-rp="preparar" data-acao="religar" id="btnReligar"' + (ocupado ? ' disabled' : '') + dgUiHtml_seguranca_js("><!--dg-i18n:30083a4772b0-->Religar<!--/dg-i18n--></button>");
    } else if (est.cortado) h += '<button type="button" class="rp-btn rp-pri" data-rp="preparar" data-acao="religar" id="btnReligar"' + (ocupado ? ' disabled' : '') + dgUiHtml_seguranca_js("><!--dg-i18n:30083a4772b0-->Religar<!--/dg-i18n--></button>");
    else h += '<button type="button" class="rp-btn rp-perigo" data-rp="preparar" id="btnTirarDoAr"' + (indisponivel || ocupado ? ' disabled' : '') + dgUiHtml_seguranca_js("><!--dg-i18n:938ec9aaa1ba-->Tirar do ar<!--/dg-i18n--></button>");
    h += '</div>';
    if (u.verPlano && e) h += planoHtml(e.plano);
    if (u.fase === 'codigo') {
      const frase = u.acao === 'religar' ? FRASE_RELIGAR : FRASE_CORTAR;
      h += '<div class="rp-confirma" id="rpConfirma">' + planoHtml(u.plano) +
        dgUiHtml_seguranca_js("<p class=\"rp-texto\"><!--dg-i18n:77b74b97f7c0-->Código de confirmação:<!--/dg-i18n--> <span class=\"rp-codigo\" id=\"rpCodigo\">") + esc(u.codigo) + '</span>' +
        (u.expira_em ? dgUiHtml_seguranca_js(" <small><!--dg-i18n:db06286cdd6c-->(vale até<!--/dg-i18n--> ") + esc(R.horaBr(u.expira_em)) + ')</small>' : '') + '</p>' +
        dgUiHtml_seguranca_js("<label class=\"rp-frase\"><!--dg-i18n:415a3551d906-->Para continuar, digite<!--/dg-i18n--> <b>") + esc(frase) + '</b><input type="text" id="rpFrase" autocomplete="off" autocapitalize="characters" spellcheck="false" data-frase="' + esc(frase) + '"></label>' +
        '<div class="rp-acoes"><button type="button" class="rp-btn ' + (u.acao === 'religar' ? 'rp-pri' : 'rp-perigo') + '" data-rp="confirmar-emergencia" id="btnConfirmaEm" disabled>' +
        (u.acao === 'religar' ? dgUiText_seguranca_js("Religar agora") : dgUiText_seguranca_js("Tirar do ar agora")) + '</button>' +
        dgHtml_seguranca("<button type=\"button\" class=\"rp-btn\" data-rp=\"cancelar-emergencia\"><!--dg-i18n:bb9dbb406dcb-->Cancelar<!--/dg-i18n--></button></div></div>");
    }
    return h;
  }

  function fraseConfere(digitado, esperada) { return typeof digitado === 'string' && digitado === esperada; }

  /* ── tutorial ───────────────────────────────────────────────────────────── */
  const PASSOS = {
    autoadmin: [
      { alvo: '#secAutoAdmin', titulo: 'Chamar o Admin sozinho',
        oque: 'Um interruptor que decide se o DG Claw chama o Admin por conta própria quando uma integração de um agente cai (chave recusada, saldo acabado, sistema fora do ar ou conexão caída).',
        como: 'Desligado de fábrica. Ligado, quando uma integração fica com defeito o Web escreve um pedido com texto fixo e o entrega ao Admin: investigar e propor, sem aplicar nada antes do seu ok. Há limites: um pedido por defeito, um a cada 6 horas por integração e cinco por dia. Para ligar, a tela mostra o risco e pede a sua confirmação.',
        porque: 'Quem decide é você. O Admin tem acesso total ao servidor e um agente consegue registrar uma falha que não aconteceu, então ligar troca um pouco de segurança por rapidez. Desligar é imediato.' },
    ],
    boletins: [
      { alvo: '#secBoletins', titulo: 'Avisos de segurança do DG Claw',
        oque: 'Os avisos sobre falhas em ferramentas que o seu sistema usa, conferidos e aprovados pela equipe do DG Claw. Cada um mostra a data, a gravidade, o link da fonte oficial e o que muda quando você corrige.',
        como: 'A cada hora o servidor consulta a lista pública de avisos, sem enviar nada seu. Atualizar leva ao chat do Admin com o pedido já escrito, e você só envia. Lembrar depois adia o lembrete por 24 horas. Entendi é para os avisos sem correção ainda: nada a aplicar agora, e ele sai da fila.',
        porque: 'Antes cada aviso abria a própria janela. Agora existe um aviso único no alto das telas e os detalhes ficam aqui, para você resolver com calma e sem fechar várias janelas.' },
    ],
    topo: [
      { alvo: '#rpResumo', titulo: 'Quando a ronda rodou',
        oque: 'O horário da última ronda de segurança e o da próxima.',
        como: 'O servidor guarda o horário em que a ronda terminou e o em que ela vai rodar de novo; a tela só mostra, no horário de Brasília.',
        porque: 'Para você saber se o que está vendo é de hoje ou está velho. Ronda parada há dias é um problema em si.' },
      { alvo: '#rpFaixas', titulo: 'Avisos sobre a própria ronda',
        oque: 'Uma faixa amarela quando alguma fonte de informação ficou fora, e uma vermelha quando a ronda falhou.',
        como: 'Se uma das fontes oficiais (OSV, Ubuntu, GitHub) não respondeu, a ronda marca o resultado como parcial. A faixa vermelha vem do vigia, que confere se a ronda rodou no horário.',
        porque: 'Um resultado incompleto não pode parecer "tudo certo". Você precisa saber quando a ronda enxergou menos do que deveria.' },
      { alvo: '#rpSemNovidade', titulo: 'Nenhuma novidade',
        oque: 'A frase fixa de quando a ronda não achou nada novo que afete o seu sistema.',
        como: 'Ela aparece quando a lista de achados da ronda vem vazia. É um texto fixo, escrito por gente, sem inteligência artificial.',
        porque: 'Dia sem novidade também é uma resposta, e você merece vê-la escrita em vez de uma tela vazia.' },
    ],
    aplicado: [
      { alvo: '#secAplicado', titulo: 'Aplicado sozinho',
        oque: 'As correções de baixo risco que a ronda já aplicou por conta própria, com o que mudou e quando.',
        como: 'Só entram aqui correções do catálogo aprovado, que não derrubam nada. A ronda guarda o valor de antes e o de depois e o caminho de volta.',
        porque: 'Para você não ser surpreendido: nada muda no seu servidor sem aparecer aqui. O botão Desfazer devolve o estado anterior.' },
    ],
    acao: [
      { alvo: '#secAcao', titulo: 'Ação necessária',
        oque: 'Falhas críticas que pedem uma decisão sua. Cada uma mostra o que é, onde afeta, o que faz e como corrigir.',
        como: 'O nível é decidido pela ronda: crítico quando a falha é grave e atinge algo que está instalado e exposto aqui. Aplicar corrige agora e Agendar escolhe a hora (só para ações do catálogo aprovado). Quando a correção é uma atualização de pacote, o botão vira Pedir ao Admin, que abre a conversa com o pedido já escrito. Tirar do ar protege enquanto a correção não chega.',
        porque: 'Falha crítica não pode esperar sem ninguém decidir. Por isso o aviso único de segurança continua lembrando (o selo no alto das telas e uma janela por dia) até você escolher.' },
    ],
    sempressa: [
      { alvo: '#secSemPressa', titulo: 'Para corrigir sem pressa',
        oque: 'Falhas de impacto leve ou médio que já têm correção pronta, esperando o seu ok.',
        como: 'O botão Corrigir agora aplica a correção quando ela é uma ação do catálogo aprovado. Quando é uma atualização de pacote ou do próprio DG Claw, o botão vira Pedir ao Admin e leva você ao chat com o pedido já escrito.',
        porque: 'Não são urgentes, mas ficar sem corrigir cria acúmulo. Aqui você resolve com um toque, quando puder.' },
    ],
    emergencia: [
      { alvo: '#secEmergencia', titulo: 'Botão de emergência',
        oque: 'Tira o sistema da internet e mantém só o seu acesso de administração pelo Tailscale.',
        como: 'Simular mostra, passo a passo, o que vai ser feito, sem mudar nada. Tirar do ar pede um código de uso único e a frase TIRAR-DO-AR. Sem confirmação em 5 minutos, o servidor religa sozinho.',
        porque: 'Quando a falha está sendo explorada e a correção ainda não existe, tirar do ar é a única proteção. A dupla confirmação evita acidente, e o religar automático evita que você se tranque para fora.' },
    ],
    aguardando: [
      { alvo: '#secAguardando', titulo: 'Aguardando correção oficial',
        oque: 'As falhas que ainda não têm correção publicada pelo fornecedor para este servidor. Algumas já têm uma proteção provisória ativa, e o cartão diz qual é.',
        como: 'A cada rodada a ronda pergunta ao apt deste servidor se a versão corrigida já pode ser instalada, e confere de verdade se a proteção provisória continua ligada. Se a correção chegar, a falha sai desta lista e aparece em Ação necessária. Se a proteção cair, ela também volta para lá.',
        porque: 'Você não precisa decidir nada sobre elas hoje, então elas não entram no aviso de risco. Ficam aqui, à vista, para você saber que a ronda está de olho.' },
    ],
    atualizacoes: [
      { alvo: '#secAtualizacoes', titulo: 'Atualizações do sistema',
        oque: 'As falhas de pacotes do Ubuntu (o kernel Linux, por exemplo) que já têm correção pronta. Ficam numa linha por componente, como "Kernel Linux: 12 correções na fila da atualização do sistema". Toque na linha para ver cada falha.',
        como: 'A cada rodada a ronda pergunta ao apt deste servidor se a versão corrigida já pode ser instalada. Se pode para todos os pacotes da falha, ela não constava no catálogo de falhas exploradas da CISA na última consulta válida, ela entra aqui, e o número da linha é a quantidade de falhas desse componente nessa situação. Quando o pacote é atualizado, a falha some sozinha.',
        porque: 'Com a atualização automática do Ubuntu ligada (o padrão), a correção entra sozinha e você não precisa decidir nada. Se ela não estiver ligada, o botão Pedir ao Admin abre a conversa com o pedido já escrito. O Admin também recebe um recado sobre elas e confere isso. Por isso elas não entram no aviso de risco nem no selo, e ficam recolhidas aqui, à vista.' },
    ],
    tratadas: [
      { alvo: '#secTratadas', titulo: 'Já tratadas',
        oque: 'As falhas de rondas anteriores que já foram resolvidas.',
        como: 'A ronda move para cá o que deixou de afetar o servidor: porque foi corrigido na versão instalada ou porque a mitigação foi aplicada.',
        porque: 'Para você ter o histórico e não ver a mesma falha de novo como se fosse novidade.' },
    ],
    inventario: [
      { alvo: '#secInventario', titulo: 'O que a ronda olha',
        oque: 'O resumo do que foi conferido: o kernel, as portas abertas para a internet e os serviços externos conectados, como o Notion.',
        como: 'A ronda refaz essa lista sozinha e compara cada item com as fontes oficiais de falhas. Nada sai do servidor além do nome do componente e da versão.',
        porque: 'Uma falha só importa se atinge algo que você tem. Ver a lista mostra o tamanho da área vigiada.' },
    ],
  };

  function passosPagina(doc) {
    const tem = sel => !doc || !!doc.querySelector(sel);
    return [].concat(PASSOS.topo, PASSOS.autoadmin, PASSOS.boletins, PASSOS.aplicado, PASSOS.acao, PASSOS.sempressa, PASSOS.aguardando, PASSOS.atualizacoes, PASSOS.emergencia, PASSOS.tratadas, PASSOS.inventario).filter(p => tem(p.alvo));
  }

  if (!raiz.document) {
    return { cardBoletimHtml, listaBoletinsHtml, cardAplicadoHtml, cardAcaoHtml, cardSemPressaHtml, cardAguardandoHtml, listaAguardandoHtml, tituloAguardando, cardAtualizacaoHtml, listaAtualizacoesHtml, agrupaPorComponente, resumoGrupoAtualizacoes, tituloAtualizacoes, FRASE_ATUALIZACOES, VAZIO_ATUALIZACOES, listaNivelHtml, tratadasHtml, inventarioHtml, planoHtml, emergenciaHtml, fraseConfere, autoAdminEstadoTexto, autoAdminBotoes, AVISO_AUTO_ADMIN, passosPagina, PASSOS, VAZIO, VAZIO_BOLETINS, VAZIO_AGUARDANDO, FRASE_AGUARDANDO, TEXTO_EMERGENCIA };
  }

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const buscar = raiz.fetch.bind(raiz);
  const est = { boletins: null, erroBoletins: null, ronda: null, emergencia: null, ui: { fase: 'ocioso' }, ocupados: new Set(), erro: null };

  function msgDoCard(card, texto, tipo) {
    const p = card.querySelector('.rp-msg');
    if (!p) return;
    p.textContent = texto || '';
    p.className = 'rp-msg' + (tipo ? ' ' + tipo : '');
    p.hidden = !texto;
  }

  function msgGeral(texto, tipo) {
    const p = $('rpMsgGeral');
    p.textContent = texto || '';
    p.className = 'rp-msg' + (tipo ? ' ' + tipo : '');
    p.hidden = !texto;
  }

  function pintaTopo() {
    const r = est.ronda;
    $('rpResumo').textContent = r ? R.resumoTopo(r, Date.now()) : (est.erro ? dgUiText_seguranca_js("Não consegui ler a ronda de segurança.") : dgTexto_seguranca('Conferindo…'));
    const parcial = R.textoParcial(r);
    const pa = $('rpParcial'); pa.textContent = parcial; pa.hidden = !parcial;
    const vigia = R.textoVigia(r);
    const vi = $('rpVigia'); vi.textContent = vigia; vi.hidden = !vigia;
    const er = $('rpErro'); er.textContent = est.erro || ''; er.hidden = !est.erro;
    const sem = $('rpSemNovidade');
    sem.textContent = dgUiText_seguranca_js(R.FRASE_SEM_NOVIDADE);
    sem.hidden = !(r && !r.nunca_rodou && r.sem_novidades);
  }

  function pintaBoletins() {
    const el = $('listaBoletins');
    if (est.ocupados.size && el.querySelector('.rp-card.ocupado')) return;   // não apaga um pedido em andamento
    el.innerHTML = est.boletins ? listaBoletinsHtml(est.boletins, Date.now())
      : '<p class="rp-vazio">' + esc(est.erroBoletins || dgTexto_seguranca('Conferindo…')) + '</p>';
  }

  function pintaNiveis() {
    const r = est.ronda && !est.ronda.nunca_rodou ? est.ronda : null;
    const agora = Date.now();
    for (const [n, id] of [[1, 'listaAplicado'], [2, 'listaAcao'], [3, 'listaSemPressa']]) {
      if (est.ocupados.size && $(id).querySelector('.rp-card.ocupado')) continue;   // não apaga um pedido em andamento
      $(id).innerHTML = r ? listaNivelHtml(r.niveis[n], n, agora) : '<p class="rp-vazio">' + esc(est.erro ? dgUiText_seguranca_js("Sem dados da ronda.") : dgUiText_seguranca_js("Ainda sem ronda.")) + '</p>';
    }
    if (!(est.ocupados.size && $('listaAguardando').querySelector('.rp-card.ocupado'))) {
      const espera = r ? [].concat(r.niveis['1'], r.niveis['2'], r.niveis['3']).filter(R.aguardaCorrecao) : [];
      $('tituloAguardando').textContent = tituloAguardando(espera.length);
      $('listaAguardando').innerHTML = r ? listaAguardandoHtml(espera, agora) : '<p class="rp-vazio">' + esc(est.erro ? dgUiText_seguranca_js("Sem dados da ronda.") : dgUiText_seguranca_js("Ainda sem ronda.")) + '</p>';
    }
    const fila = r ? [].concat(r.niveis['1'], r.niveis['2'], r.niveis['3']).filter(R.ehAtualizacaoSistema) : [];
    dgSegRotulo($('tituloAtualizacoes'), 'Atualizações do sistema ({n})', { n: fila.length });
    $('listaAtualizacoes').innerHTML = r ? listaAtualizacoesHtml(fila) : '<p class="rp-vazio">' + dgSegFragmento(est.erro ? 'Sem dados da ronda.' : 'Ainda sem ronda.') + '</p>';
    $('listaTratadas').innerHTML = tratadasHtml(r && r.ja_tratadas);
    $('listaInventario').innerHTML = inventarioHtml(r && r.inventario);
  }

  function pintaEmergencia() {
    if (est.ui.fase === 'codigo' && document.activeElement && document.activeElement.id === 'rpFrase') return;   // não tira o teclado da pessoa
    const e = est.emergencia;
    $('corpoEmergencia').innerHTML = e ? emergenciaHtml(e, est.ui) : '<p class="rp-vazio">' + esc(est.erro || dgTexto_seguranca('Conferindo…')) + '</p>';
  }

  async function carrega() {
    const [r, e, bo] = await Promise.all([R.chama(buscar, 'GET', R.API + '/ronda'), R.chama(buscar, 'GET', R.API + '/emergencia'), R.chama(buscar, 'GET', R.API + '/boletins')]);
    est.erro = null;
    if (bo.ok) { est.boletins = Array.isArray(bo.json.boletins) ? bo.json.boletins : []; est.erroBoletins = null; }
    else { est.boletins = null; est.erroBoletins = dgUiText_seguranca_js("Não consegui ler os avisos de segurança do DG Claw. ") + bo.erro; }
    if (r.ok) est.ronda = r.json; else { est.ronda = null; est.erro = r.erro; }
    if (e.ok) est.emergencia = e.json;
    else { est.emergencia = null; est.erro = est.erro || e.erro; }
    pintaTopo(); pintaBoletins(); pintaNiveis(); pintaEmergencia();
  }

  /* ── chamar o Admin sozinho ─────────────────────────────────────────────── */
  const auto = { ligado: null, suspenso: false, erro: null, confirmando: false };
  const TEXTO_SUSPENSO = 'O pedido automático está suspenso: o arquivo de incidentes estava ilegível; confira incidentes.json.corrompido. Mexa no interruptor abaixo para retomar.';

  function pintaAutoAdmin() {
    const estado = $('autoAdminEstado'); const aviso = $('autoAdminAviso'); const acoes = $('autoAdminAcoes');
    if (!estado) return;
    acoes.textContent = '';
    const susp = $('autoAdminSuspenso');
    if (susp) { dgSegRotulo(susp, auto.suspenso ? TEXTO_SUSPENSO : ''); susp.hidden = !auto.suspenso; }
    if (auto.ligado === null) {
      if (auto.erro !== null) dgSegRotulo(estado, 'Não consegui ler o estado do Admin automático. {erro}', { erro: auto.erro }); else dgSegRotulo(estado, 'Conferindo…');
      aviso.hidden = true;
      return;
    }
    dgSegRotulo(estado, autoAdminEstadoTexto(auto.ligado));
    dgSegRotulo(aviso, AVISO_AUTO_ADMIN);
    aviso.hidden = !auto.confirmando;
    for (const b of autoAdminBotoes(auto.ligado, auto.confirmando)) {
      const e = document.createElement('button');
      e.type = 'button'; e.className = b.classe; e.dataset.rp = b.acao; dgSegRotulo(e, b.rotulo);
      acoes.appendChild(e);
    }
  }

  function msgAuto(texto, tipo) {
    const p = $('autoAdminMsg');
    if (!p) return;
    dgSegRotulo(p, '');
    p.textContent = texto || '';
    p.className = 'rp-msg' + (tipo ? ' ' + tipo : '');
    p.hidden = !texto;
  }

  async function carregaAutoAdmin() {
    const r = await R.chama(buscar, 'GET', '/api/v1/integracoes');
    if (r.ok && r.json && r.json.automatico && typeof r.json.automatico.ligado === 'boolean') { auto.ligado = r.json.automatico.ligado; auto.suspenso = r.json.automatico.suspenso === true; auto.erro = null; }
    else { auto.ligado = null; auto.erro = r.erro || '';  }
    pintaAutoAdmin();
  }

  async function mudaAutoAdmin(ligado) {
    msgAuto('', '');
    const corpo = ligado ? { ligado: true, entendoORisco: true } : { ligado: false };
    const r = await R.chama(buscar, 'POST', '/api/v1/integracoes/automatico', corpo);
    if (!r.ok) { msgAuto('', 'erro'); dgSegRotulo($('autoAdminMsg'), 'Não consegui mudar: {erro}', { erro: r.erro || '' }); $('autoAdminMsg').hidden = false; return; }
    auto.ligado = !!(r.json && r.json.automatico && r.json.automatico.ligado);
    auto.suspenso = false;   // mexer no interruptor retoma o pedido automático
    auto.confirmando = false;
    pintaAutoAdmin();
    msgAuto('', 'ok'); dgSegRotulo($('autoAdminMsg'), auto.ligado ? 'Ligado.' : 'Desligado.'); $('autoAdminMsg').hidden = false;
  }

  function achadoDe(card) {
    if (!est.ronda || !est.ronda.niveis) return null;
    const id = card.dataset.id;
    return [].concat(est.ronda.niveis['1'], est.ronda.niveis['2'], est.ronda.niveis['3']).find(a => a.id === id) || null;
  }

  function travaCard(card, sim) {
    card.classList.toggle('ocupado', sim);
    if (sim) est.ocupados.add(card.dataset.id); else est.ocupados.delete(card.dataset.id);
    card.querySelectorAll('button').forEach(b => { b.disabled = sim; });
  }

  async function pedirDoCard(card, acao, corpo, mensagemFinal) {
    const a = achadoDe(card);
    if (!a) { msgDoCard(card, dgUiText_seguranca_js("Não achei este item na ronda. Atualize a página."), 'erro'); return; }
    travaCard(card, true);
    msgDoCard(card, 'Enviando o pedido…', '');
    const res = await R.pedirEEsperar(buscar, R.urlAchado(a.id, acao), corpo, { aoProgresso: t => msgDoCard(card, t, '') });
    travaCard(card, false);
    if (res.ok) {
      if (a.nivel === 2 && acao !== 'desfazer') R.marcaDecidido(raiz.localStorage, a.id, Date.now());
      await carrega();
      const novo = document.querySelector('.rp-card[data-id="' + (raiz.CSS && raiz.CSS.escape ? raiz.CSS.escape(a.id) : a.id) + '"]');
      if (novo) msgDoCard(novo, res.mensagem || mensagemFinal, 'ok');
    } else {
      msgDoCard(card, res.mensagem || dgUiText_seguranca_js("O servidor não conseguiu executar o pedido e não explicou o motivo. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30"), 'erro');
    }
  }

  function irParaEmergencia() {
    const s = $('secEmergencia');
    s.scrollIntoView({ block: 'start' });
    s.classList.add('rp-destaque');
    setTimeout(() => s.classList.remove('rp-destaque'), 2500);
  }

  /* Atualizar leva ao Admin com o pedido escrito; Lembrar depois e Entendi avisam o servidor (adiar 24 h ou dispensar). */
  async function acaoBoletim(card, botao) {
    const b = (est.boletins || []).find(x => x.id === card.dataset.id);
    if (!b) { msgDoCard(card, dgUiText_seguranca_js("Não achei este aviso na lista. Atualize a página."), 'erro'); return; }
    const k = botao.dataset.rp;
    if (k === 'b-atualizar') {
      const faixa = raiz.DGAtualizacaoFaixa;
      if (!faixa || typeof faixa.instalar !== 'function') { msgDoCard(card, dgUiText_seguranca_js("O atalho para o Admin ainda não carregou. Recarregue a página e toque de novo."), 'erro'); return; }
      faixa.instalar(R.textoDoPedidoBoletim(b));
      return;
    }
    const rota = k === 'b-entendi' && b.acao === 'aguardar' ? 'dispensar' : 'adiar';
    travaCard(card, true);
    const res = await R.chama(buscar, 'POST', R.API + '/boletins/' + encodeURIComponent(b.id) + '/' + rota);
    travaCard(card, false);
    if (!res.ok) { msgDoCard(card, res.erro, 'erro'); return; }
    await carrega();
  }

  async function acaoDoCard(botao) {
    const card = botao.closest('.rp-card');
    if (card && card.dataset.boletim) return acaoBoletim(card, botao);
    const a = card && achadoDe(card);
    const k = botao.dataset.rp;
    if (!card || !a) return;
    if (k === 'aplicar') return pedirDoCard(card, 'aplicar', {}, dgUiText_seguranca_js("Correção aplicada."));
    if (k === 'agendar-abre') { const box = card.querySelector('.rp-agenda'); box.hidden = !box.hidden; return undefined; }
    if (k === 'agendar') {
      const iso = R.agendaParaIso(card.querySelector('.rp-quando').value, Date.now());
      if (!iso) { msgDoCard(card, dgUiText_seguranca_js("Escolha uma data e hora pelo menos 1 minuto à frente."), 'erro'); return undefined; }
      return pedirDoCard(card, 'agendar', { quando: iso }, 'Agendado.');
    }
    if (k === 'tirar-do-ar') return irParaEmergencia();
    if (k === 'desfazer') {
      if (botao.dataset.confirma !== '1') {
        botao.dataset.confirma = '1'; botao.textContent = 'Confirmar: desfazer';
        msgDoCard(card, dgUiText_seguranca_js("Isto devolve o valor de antes (") + (a.aplicado && a.aplicado.antes ? a.aplicado.antes : 'registrado pela ronda') + dgUiText_seguranca_js("). Toque de novo para confirmar."), '');
        return undefined;
      }
      return pedirDoCard(card, 'desfazer', {}, 'Desfeito.');
    }
    if (k === 'pedir-admin') {
      const faixa = raiz.DGAtualizacaoFaixa;
      if (!faixa || typeof faixa.instalar !== 'function') { msgDoCard(card, dgUiText_seguranca_js("O atalho para o Admin ainda não carregou. Recarregue a página e toque de novo."), 'erro'); return undefined; }
      faixa.instalar(R.textoDoPedidoAoAdmin(a));
      return undefined;
    }
    if (k === 'corrigir') return pedirDoCard(card, 'aplicar', {}, dgUiText_seguranca_js("Correção aplicada."));
    return undefined;
  }

  function msgEmergencia(texto, tipo) {
    const p = $('rpEmMsg');
    p.textContent = texto || '';
    p.className = 'rp-msg' + (tipo ? ' ' + tipo : '');
    p.hidden = !texto;
  }

  async function prepararEmergencia(acaoEscolhida) {
    est.ui = { fase: 'preparando' };
    pintaEmergencia();
    msgEmergencia(dgUiText_seguranca_js("Pedindo o plano e o código ao servidor…"), '');
    const res = await R.pedirEEsperar(buscar, R.API + '/emergencia/preparar', {}, { aoProgresso: t => msgEmergencia(t, '') });
    if (!res.ok || !res.dados || !res.dados.codigo) {
      est.ui = { fase: 'ocioso' };
      pintaEmergencia();
      msgEmergencia(res.mensagem || dgUiText_seguranca_js("O servidor não trouxe o código. Rode \"sudo dgclaw emergencia preparar\" para ver o motivo."), 'erro');
      return;
    }
    est.ui = { fase: 'codigo', acao: acaoEscolhida || res.dados.acao || 'cortar', codigo: res.dados.codigo, expira_em: res.dados.expira_em, plano: res.dados.plano };
    msgEmergencia('', '');
    pintaEmergencia();
  }

  async function confirmarEmergencia() {
    const u = est.ui;
    const campo = $('rpFrase');
    if (!campo || !fraseConfere(campo.value, campo.dataset.frase)) return;
    const btn = $('btnConfirmaEm');
    btn.disabled = true;
    msgEmergencia('Enviando o pedido…', '');
    const res = await R.pedirEEsperar(buscar, R.API + '/emergencia/' + u.acao, { codigo: u.codigo, frase: campo.value }, { aoProgresso: t => msgEmergencia(t, '') });
    est.ui = { fase: 'ocioso' };
    if (res.ok) {
      msgEmergencia((res.mensagem || (u.acao === 'cortar' ? dgUiText_seguranca_js("Sistema fora do ar.") : 'Sistema religado.')) +
        (u.acao === 'cortar' ? dgUiText_seguranca_js(" Esta tela e o painel deixam de responder até você confirmar ou religar pelo servidor (sudo dgclaw emergencia confirmar). Sem confirmação, ele religa sozinho em 5 minutos.") : ''), 'ok');
    } else {
      msgEmergencia(res.mensagem || dgUiText_seguranca_js("O servidor não executou o pedido e não explicou o motivo. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30"), 'erro');
    }
    await carrega();
  }

  function aoClicar(ev) {
    const bt = ev.target.closest('button[data-rp]');
    if (!bt || bt.disabled) return;
    const k = bt.dataset.rp;
    if (k === 'ajuda') { ev.preventDefault(); ajudaSecao(bt.dataset.secao); return; }
    if (k === 'auto-ligar') { auto.confirmando = true; msgAuto('', ''); pintaAutoAdmin(); return; }
    if (k === 'auto-cancelar') { auto.confirmando = false; pintaAutoAdmin(); return; }
    if (k === 'auto-confirmar') { mudaAutoAdmin(true); return; }
    if (k === 'auto-desligar') { mudaAutoAdmin(false); return; }
    if (k === 'simular') { est.ui = Object.assign({}, est.ui, { verPlano: !est.ui.verPlano }); pintaEmergencia(); return; }
    if (k === 'preparar') { prepararEmergencia(bt.dataset.acao); return; }
    if (k === 'cancelar-emergencia') { est.ui = { fase: 'ocioso' }; msgEmergencia('', ''); pintaEmergencia(); return; }
    if (k === 'confirmar-emergencia') { confirmarEmergencia(); return; }
    acaoDoCard(bt);
  }

  function aoDigitar(ev) {
    if (ev.target.id !== 'rpFrase') return;
    $('btnConfirmaEm').disabled = !fraseConfere(ev.target.value, ev.target.dataset.frase);
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    msgGeral(dgUiText_seguranca_js("A visita guiada não carregou. Recarregue a página e tente de novo."), 'erro');
  }

  function ajudaSecao(chave) {
    comTour(() => raiz.DGTour.inicia({ passos: (PASSOS[chave] || []).filter(p => document.querySelector(p.alvo)) }));
  }

  function tutorial() { comTour(() => raiz.DGTour.inicia({ passos: passosPagina(document) })); }

  function inicia() {
    document.addEventListener('click', aoClicar);
    document.addEventListener('input', aoDigitar);
    carrega();
    carregaAutoAdmin();
    setInterval(carrega, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') carrega(); });
    if (location.hash === '#emergencia') setTimeout(irParaEmergencia, 600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { cardAplicadoHtml, cardAcaoHtml, cardSemPressaHtml, cardAguardandoHtml, listaAguardandoHtml, tituloAguardando, cardAtualizacaoHtml, listaAtualizacoesHtml, agrupaPorComponente, resumoGrupoAtualizacoes, tituloAtualizacoes, FRASE_ATUALIZACOES, VAZIO_ATUALIZACOES, listaNivelHtml, tratadasHtml, inventarioHtml, planoHtml, emergenciaHtml, fraseConfere, autoAdminEstadoTexto, autoAdminBotoes, AVISO_AUTO_ADMIN, passosPagina, PASSOS, VAZIO, VAZIO_BOLETINS, VAZIO_AGUARDANDO, FRASE_AGUARDANDO, TEXTO_EMERGENCIA, tutorial, carrega };
});
