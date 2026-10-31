'use strict';
/* seguranca.js: a tela "Segurança" (/seguranca): a ronda de fábrica, o que foi aplicado sozinho, o que pede decisão,
   o que dá para corrigir sem pressa e o botão de emergência.

   Lê GET /api/v1/seguranca/ronda e /emergencia. Cada clique vira um PEDIDO (o servidor, como root, valida de novo e
   executa); a tela espera o resultado a cada 2 s, por até 2 min. Contrato: web/docs/RONDA-PAINEL.md.
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

  /* ── níveis ─────────────────────────────────────────────────────────────── */
  function rotuloAgendado(a) { return a.estado === 'agendado' ? '<span class="rp-tag rp-tag-ok">Agendado</span>' : ''; }

  function cabecaCard(a) {
    return '<h3>' + esc(a.nome_simples) + ' <span class="rp-tag rp-grav-' + esc(String(a.severidade).toLowerCase()) + '">' +
      esc(R.gravidadeRotulo(a.severidade)) + '</span>' + rotuloAgendado(a) + '</h3>';
  }

  function cardAplicadoHtml(a, agora) {
    const desfaz = a.estado === 'aplicado-sozinho' && a.aplicado && a.aplicado.desfazer
      ? '<button type="button" class="rp-btn" data-rp="desfazer">Desfazer</button>' : '';
    return '<article class="rp-card rp-n1" data-id="' + esc(a.id) + '">' + cabecaCard(a) +
      '<p class="rp-texto">' + esc(R.textoAplicado(a, agora)) + '</p>' +
      '<details class="rp-detalhe"><summary>Ver detalhes da falha</summary>' + R.fatosHtml(a) + '</details>' +
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
      corpo = '<p class="rp-aviso">' + esc(TEXTO_PEDIR_ADMIN) + '</p>' +
        '<div class="rp-acoes">' +
        '<button type="button" class="rp-btn rp-pri" data-rp="pedir-admin">Pedir ao Admin</button>' +
        '<button type="button" class="rp-btn rp-perigo" data-rp="tirar-do-ar">Tirar do ar</button></div>';
    } else {
      corpo = '<p class="rp-aviso">' + esc(pode ? R.avisoReinicio(a) : 'A correção ainda não está pronta. Enquanto isso, o botão "Tirar do ar" é a proteção disponível.') + '</p>' +
        '<div class="rp-acoes">' +
        '<button type="button" class="rp-btn rp-pri" data-rp="aplicar"' + (pode ? '' : ' disabled') + '>Aplicar correção</button>' +
        '<button type="button" class="rp-btn" data-rp="agendar-abre"' + (pode && aberto ? '' : ' disabled') + '>Agendar</button>' +
        '<button type="button" class="rp-btn rp-perigo" data-rp="tirar-do-ar">Tirar do ar</button></div>' +
        '<div class="rp-agenda" hidden><label>Aplicar em<input type="datetime-local" class="rp-quando"></label>' +
        '<button type="button" class="rp-btn rp-pri" data-rp="agendar">Confirmar agendamento</button></div>';
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
          ? '<button type="button" class="rp-btn rp-pri" data-rp="pedir-admin">Pedir ao Admin</button>'
          : '<button type="button" class="rp-btn rp-pri" data-rp="corrigir"' + (R.podeAplicar(a) ? '' : ' disabled') + '>Corrigir agora</button>') + '</div>';
    }
    return '<article class="rp-card rp-n3" data-id="' + esc(a.id) + '">' + cabecaCard(a) + corpo + R.fatosHtml(a) +
      '<p class="rp-msg" role="status" hidden></p></article>';
  }

  function listaNivelHtml(achados, nivel, agora) {
    if (!achados || !achados.length) return '<p class="rp-vazio">' + esc(VAZIO[nivel]) + '</p>';
    const f = nivel === 1 ? cardAplicadoHtml : nivel === 2 ? cardAcaoHtml : cardSemPressaHtml;
    return achados.map(a => f(a, agora)).join('');
  }

  function tratadasHtml(lista) {
    if (!lista || !lista.length) return '<p class="rp-vazio">Nenhuma falha foi marcada como tratada até agora.</p>';
    return '<ul class="rp-tratadas">' + lista.map(t => '<li><b>' + esc(t.componente || t.id) + '</b>' +
      (t.id && t.componente ? ' <small>' + esc(t.id) + '</small>' : '') + (t.como ? ': ' + esc(t.como) : '') + '</li>').join('') + '</ul>';
  }

  function inventarioHtml(inv) {
    if (!inv) return '<p class="rp-vazio">A ronda ainda não registrou o que olha neste servidor.</p>';
    const linhas = [];
    if (inv.kernel) linhas.push('<li><b>Kernel</b>: ' + esc(inv.kernel) + '</li>');
    if (inv.componentes != null) linhas.push('<li><b>Componentes conferidos</b>: ' + esc(inv.componentes) + '</li>');
    const portas = (inv.portas_publicas || []).map(p => esc(p.porta) + (p.processo ? ' (' + esc(p.processo) + ')' : ''));
    linhas.push('<li><b>Portas abertas para a internet</b>: ' + (portas.length ? portas.join(', ') : 'nenhuma informada') + '</li>');
    const ext = (inv.servicos_externos || []).map(s => esc(s.nome) + (s.via ? ' <small>via ' + esc(s.via) + (s.versao ? ', versão ' + esc(s.versao) : '') + '</small>' : ''));
    linhas.push('<li><b>Serviços externos conectados</b>: ' + (ext.length ? ext.join('; ') : 'nenhum informado') + '</li>');
    if (inv.reinventariado_em) linhas.push('<li><b>Lista refeita em</b>: ' + esc(R.quando(inv.reinventariado_em, Date.now())) + '</li>');
    return '<ul class="rp-inv">' + linhas.join('') + '</ul>';
  }

  /* ── emergência ─────────────────────────────────────────────────────────── */
  function planoHtml(plano) {
    if (!plano || !plano.comandos || !plano.comandos.length) return '<p class="rp-vazio">O servidor não trouxe o plano. Rode "sudo dgclaw emergencia simular".</p>';
    return '<div class="rp-plano"><p class="rp-texto"><b>O que vai acontecer, passo a passo:</b></p><ol>' +
      plano.comandos.map(c => '<li><code>' + esc(c) + '</code></li>').join('') + '</ol>' +
      (plano.avisos && plano.avisos.length ? '<ul class="rp-aviso-lista">' + plano.avisos.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
  }

  /* e = resposta de GET /emergencia; ui = { fase: 'ocioso'|'preparando'|'codigo', verPlano, acao, codigo, expira_em, plano } */
  function emergenciaHtml(e, ui) {
    const u = ui || { fase: 'ocioso' };
    const est = (e && e.estado) || { cortado: false };
    let h = '<p class="rp-texto" id="rpEmTexto">' + esc(TEXTO_EMERGENCIA) + '</p>';
    if (est.cortado) {
      h += '<div class="rp-alerta" id="rpEmCortado" role="alert"><b>O sistema está fora do ar</b> desde ' + esc(R.quando(est.desde, Date.now())) + '.' +
        (est.confirmado ? ' O corte foi confirmado e fica até você religar.'
          : est.religar_automatico_em ? ' Se ninguém confirmar, ele religa sozinho em ' + esc(R.quando(est.religar_automatico_em, Date.now())) + '.' : '') + '</div>';
    }
    const indisponivel = !est.cortado && (!e || !e.disponivel);
    if (indisponivel) {
      h += '<div class="rp-bloqueio" id="rpEmMotivo" role="status"><b>O botão está desligado por enquanto.</b> ' + esc((e && e.motivo) || 'Não foi possível saber se o corte é seguro.') + '</div>';
    } else if (e && e.desatualizado) {
      h += '<p class="rp-fraco">A medição do servidor tem mais de 2 horas. Rode "sudo dgclaw emergencia estado" para atualizar.</p>';
    }
    const ocupado = u.fase === 'preparando';
    h += '<div class="rp-acoes"><button type="button" class="rp-btn" data-rp="simular" id="btnSimular"' + (e && e.plano && e.plano.comandos && e.plano.comandos.length ? '' : ' disabled') + '>Simular</button>';
    if (est.cortado) h += '<button type="button" class="rp-btn rp-pri" data-rp="preparar" id="btnReligar"' + (ocupado ? ' disabled' : '') + '>Religar</button>';
    else h += '<button type="button" class="rp-btn rp-perigo" data-rp="preparar" id="btnTirarDoAr"' + (indisponivel || ocupado ? ' disabled' : '') + '>Tirar do ar</button>';
    h += '</div>';
    if (u.verPlano && e) h += planoHtml(e.plano);
    if (u.fase === 'codigo') {
      const frase = u.acao === 'religar' ? FRASE_RELIGAR : FRASE_CORTAR;
      h += '<div class="rp-confirma" id="rpConfirma">' + planoHtml(u.plano) +
        '<p class="rp-texto">Código de confirmação: <span class="rp-codigo" id="rpCodigo">' + esc(u.codigo) + '</span>' +
        (u.expira_em ? ' <small>(vale até ' + esc(R.horaBr(u.expira_em)) + ')</small>' : '') + '</p>' +
        '<label class="rp-frase">Para continuar, digite <b>' + esc(frase) + '</b><input type="text" id="rpFrase" autocomplete="off" autocapitalize="characters" spellcheck="false" data-frase="' + esc(frase) + '"></label>' +
        '<div class="rp-acoes"><button type="button" class="rp-btn ' + (u.acao === 'religar' ? 'rp-pri' : 'rp-perigo') + '" data-rp="confirmar-emergencia" id="btnConfirmaEm" disabled>' +
        (u.acao === 'religar' ? 'Religar agora' : 'Tirar do ar agora') + '</button>' +
        '<button type="button" class="rp-btn" data-rp="cancelar-emergencia">Cancelar</button></div></div>';
    }
    return h;
  }

  function fraseConfere(digitado, esperada) { return typeof digitado === 'string' && digitado === esperada; }

  /* ── tutorial ───────────────────────────────────────────────────────────── */
  const PASSOS = {
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
        porque: 'Falha crítica não pode esperar sem ninguém decidir. Por isso uma janela vermelha volta a cada visita ao painel até você escolher.' },
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
    return [].concat(PASSOS.topo, PASSOS.aplicado, PASSOS.acao, PASSOS.sempressa, PASSOS.emergencia, PASSOS.tratadas, PASSOS.inventario).filter(p => tem(p.alvo));
  }

  if (!raiz.document) {
    return { cardAplicadoHtml, cardAcaoHtml, cardSemPressaHtml, listaNivelHtml, tratadasHtml, inventarioHtml, planoHtml, emergenciaHtml, fraseConfere, passosPagina, PASSOS, VAZIO, TEXTO_EMERGENCIA };
  }

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const buscar = raiz.fetch.bind(raiz);
  const est = { ronda: null, emergencia: null, ui: { fase: 'ocioso' }, ocupados: new Set(), erro: null };

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
    $('rpResumo').textContent = r ? R.resumoTopo(r, Date.now()) : (est.erro ? 'Não consegui ler a ronda de segurança.' : 'Conferindo…');
    const parcial = R.textoParcial(r);
    const pa = $('rpParcial'); pa.textContent = parcial; pa.hidden = !parcial;
    const vigia = R.textoVigia(r);
    const vi = $('rpVigia'); vi.textContent = vigia; vi.hidden = !vigia;
    const er = $('rpErro'); er.textContent = est.erro || ''; er.hidden = !est.erro;
    const sem = $('rpSemNovidade');
    sem.textContent = R.FRASE_SEM_NOVIDADE;
    sem.hidden = !(r && !r.nunca_rodou && r.sem_novidades);
  }

  function pintaNiveis() {
    const r = est.ronda && !est.ronda.nunca_rodou ? est.ronda : null;
    const agora = Date.now();
    for (const [n, id] of [[1, 'listaAplicado'], [2, 'listaAcao'], [3, 'listaSemPressa']]) {
      if (est.ocupados.size && $(id).querySelector('.rp-card.ocupado')) continue;   // não apaga um pedido em andamento
      $(id).innerHTML = r ? listaNivelHtml(r.niveis[n], n, agora) : '<p class="rp-vazio">' + esc(est.erro ? 'Sem dados da ronda.' : 'Ainda sem ronda.') + '</p>';
    }
    $('listaTratadas').innerHTML = tratadasHtml(r && r.ja_tratadas);
    $('listaInventario').innerHTML = inventarioHtml(r && r.inventario);
  }

  function pintaEmergencia() {
    if (est.ui.fase === 'codigo' && document.activeElement && document.activeElement.id === 'rpFrase') return;   // não tira o teclado da pessoa
    const e = est.emergencia;
    $('corpoEmergencia').innerHTML = e ? emergenciaHtml(e, est.ui) : '<p class="rp-vazio">' + esc(est.erro || 'Conferindo…') + '</p>';
  }

  async function carrega() {
    const [r, e] = await Promise.all([R.chama(buscar, 'GET', R.API + '/ronda'), R.chama(buscar, 'GET', R.API + '/emergencia')]);
    est.erro = null;
    if (r.ok) est.ronda = r.json; else { est.ronda = null; est.erro = r.erro; }
    if (e.ok) est.emergencia = e.json;
    else { est.emergencia = null; est.erro = est.erro || e.erro; }
    pintaTopo(); pintaNiveis(); pintaEmergencia();
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
    if (!a) { msgDoCard(card, 'Não achei este item na ronda. Atualize a página.', 'erro'); return; }
    travaCard(card, true);
    msgDoCard(card, 'Enviando o pedido…', '');
    const res = await R.pedirEEsperar(buscar, R.urlAchado(a.id, acao), corpo, { aoProgresso: t => msgDoCard(card, t, '') });
    travaCard(card, false);
    if (res.ok) {
      if (a.nivel === 2) R.marcaDecidido(raiz.localStorage, a.id, Date.now());
      await carrega();
      const novo = document.querySelector('.rp-card[data-id="' + (raiz.CSS && raiz.CSS.escape ? raiz.CSS.escape(a.id) : a.id) + '"]');
      if (novo) msgDoCard(novo, res.mensagem || mensagemFinal, 'ok');
    } else {
      msgDoCard(card, res.mensagem || 'O servidor não conseguiu executar o pedido e não explicou o motivo. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30', 'erro');
    }
  }

  function irParaEmergencia() {
    const s = $('secEmergencia');
    s.scrollIntoView({ block: 'start' });
    s.classList.add('rp-destaque');
    setTimeout(() => s.classList.remove('rp-destaque'), 2500);
  }

  async function acaoDoCard(botao) {
    const card = botao.closest('.rp-card');
    const a = card && achadoDe(card);
    const k = botao.dataset.rp;
    if (!card || !a) return;
    if (k === 'aplicar') return pedirDoCard(card, 'aplicar', {}, 'Correção aplicada.');
    if (k === 'agendar-abre') { const box = card.querySelector('.rp-agenda'); box.hidden = !box.hidden; return undefined; }
    if (k === 'agendar') {
      const iso = R.agendaParaIso(card.querySelector('.rp-quando').value, Date.now());
      if (!iso) { msgDoCard(card, 'Escolha uma data e hora pelo menos 1 minuto à frente.', 'erro'); return undefined; }
      return pedirDoCard(card, 'agendar', { quando: iso }, 'Agendado.');
    }
    if (k === 'tirar-do-ar') return irParaEmergencia();
    if (k === 'desfazer') {
      if (botao.dataset.confirma !== '1') {
        botao.dataset.confirma = '1'; botao.textContent = 'Confirmar: desfazer';
        msgDoCard(card, 'Isto devolve o valor de antes (' + (a.aplicado && a.aplicado.antes ? a.aplicado.antes : 'registrado pela ronda') + '). Toque de novo para confirmar.', '');
        return undefined;
      }
      return pedirDoCard(card, 'desfazer', {}, 'Desfeito.');
    }
    if (k === 'pedir-admin') {
      const faixa = raiz.DGAtualizacaoFaixa;
      if (!faixa || typeof faixa.instalar !== 'function') { msgDoCard(card, 'O atalho para o Admin ainda não carregou. Recarregue a página e toque de novo.', 'erro'); return undefined; }
      faixa.instalar(R.textoDoPedidoAoAdmin(a));
      return undefined;
    }
    if (k === 'corrigir') return pedirDoCard(card, 'aplicar', {}, 'Correção aplicada.');
    return undefined;
  }

  function msgEmergencia(texto, tipo) {
    const p = $('rpEmMsg');
    p.textContent = texto || '';
    p.className = 'rp-msg' + (tipo ? ' ' + tipo : '');
    p.hidden = !texto;
  }

  async function prepararEmergencia() {
    est.ui = { fase: 'preparando' };
    pintaEmergencia();
    msgEmergencia('Pedindo o plano e o código ao servidor…', '');
    const res = await R.pedirEEsperar(buscar, R.API + '/emergencia/preparar', {}, { aoProgresso: t => msgEmergencia(t, '') });
    if (!res.ok || !res.dados || !res.dados.codigo) {
      est.ui = { fase: 'ocioso' };
      pintaEmergencia();
      msgEmergencia(res.mensagem || 'O servidor não trouxe o código. Rode "sudo dgclaw emergencia preparar" para ver o motivo.', 'erro');
      return;
    }
    est.ui = { fase: 'codigo', acao: res.dados.acao || 'cortar', codigo: res.dados.codigo, expira_em: res.dados.expira_em, plano: res.dados.plano };
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
      msgEmergencia((res.mensagem || (u.acao === 'cortar' ? 'Sistema fora do ar.' : 'Sistema religado.')) +
        (u.acao === 'cortar' ? ' Esta tela e o painel deixam de responder até você confirmar ou religar pelo servidor (sudo dgclaw emergencia confirmar). Sem confirmação, ele religa sozinho em 5 minutos.' : ''), 'ok');
    } else {
      msgEmergencia(res.mensagem || 'O servidor não executou o pedido e não explicou o motivo. Veja: journalctl -u dgclaw-seguranca-pedidos -n 30', 'erro');
    }
    await carrega();
  }

  function aoClicar(ev) {
    const bt = ev.target.closest('button[data-rp]');
    if (!bt || bt.disabled) return;
    const k = bt.dataset.rp;
    if (k === 'ajuda') { ev.preventDefault(); ajudaSecao(bt.dataset.secao); return; }
    if (k === 'simular') { est.ui = Object.assign({}, est.ui, { verPlano: !est.ui.verPlano }); pintaEmergencia(); return; }
    if (k === 'preparar') { prepararEmergencia(); return; }
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
    msgGeral('A visita guiada não carregou. Recarregue a página e tente de novo.', 'erro');
  }

  function ajudaSecao(chave) {
    comTour(() => raiz.DGTour.inicia({ passos: (PASSOS[chave] || []).filter(p => document.querySelector(p.alvo)) }));
  }

  function tutorial() { comTour(() => raiz.DGTour.inicia({ passos: passosPagina(document) })); }

  function inicia() {
    document.addEventListener('click', aoClicar);
    document.addEventListener('input', aoDigitar);
    carrega();
    setInterval(carrega, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') carrega(); });
    if (location.hash === '#emergencia') setTimeout(irParaEmergencia, 600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { cardAplicadoHtml, cardAcaoHtml, cardSemPressaHtml, listaNivelHtml, tratadasHtml, inventarioHtml, planoHtml, emergenciaHtml, fraseConfere, passosPagina, PASSOS, VAZIO, TEXTO_EMERGENCIA, tutorial, carrega };
});
