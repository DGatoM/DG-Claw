'use strict';
/* Modo demonstração: cartões de confirmação (envio e leitura) e botão "Novo cliente (Reset)".
   Só entra na conversa quando o servidor está com DGCLAW_DEMO_CONFIG (o HTML é montado com este script).
   O agente nunca decide: o clique é daqui, com a sessão do dono. Tudo que vem de dado entra por textContent. */
(function () {
  var INTERVALO = 2000;
  var FRASE = 'NOVO CLIENTE';
  var raiz = null;          // overlay do cartão
  var assinatura = '';
  var escolhido = null;     // candidato marcado no cartão de leitura
  var idAtual = null;       // id do cartão que está na tela
  var enviando = false;
  var vistos = {};          // recentes já avisados
  var timer = null;
  var resetAberto = false;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function api(metodo, url, corpo) {
    var init = { method: metodo, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (corpo !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(corpo); }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (_) { /* resposta sem JSON */ }
        if (!r.ok || !j || j.ok === false) {
          var msg = (j && j.erro) || ('O painel respondeu ' + r.status + ' sem explicar. Recarregue a página e tente de novo.');
          var e = new Error(msg);
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }
  function tamanho(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }

  // ── aviso de resultado ───────────────────────────────────────────────────
  var avisos = null;
  function aviso(texto, tipo) {
    if (!avisos) { avisos = el('div', 'dc-avisos'); avisos.setAttribute('role', 'status'); document.body.appendChild(avisos); }
    var a = el('div', 'dc-aviso ' + (tipo || ''), texto);
    avisos.appendChild(a);
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, tipo === 'erro' ? 15000 : 6000);
  }

  // ── cartão ───────────────────────────────────────────────────────────────
  /* Só tira o cartão da tela: a assinatura e a escolha da pessoa ficam, para a próxima consulta não refazer à toa. */
  function tiraDoDom() {
    if (raiz && raiz.parentNode) raiz.parentNode.removeChild(raiz);
    raiz = null;
  }
  /* Encerra o cartão de vez (decidido ou sumiu): limpa também o estado. */
  function fechaCartao() {
    tiraDoDom();
    assinatura = ''; escolhido = null; idAtual = null;
  }

  function linhaInfo(rotulo, valor, grande) {
    var l = el('div', 'dc-info');
    l.appendChild(el('span', 'dc-rotulo', rotulo));
    l.appendChild(el('span', 'dc-valor' + (grande ? ' dc-grande' : ''), valor));
    return l;
  }

  function decidir(c, decisao, erroEl, botoes) {
    if (enviando) return;
    enviando = true;
    erroEl.textContent = '';
    botoes.forEach(function (b) { b.disabled = true; });
    var corpo = { decisao: decisao };
    if (decisao === 'confirmar' && c.tipo === 'leitura') corpo.candidato = escolhido;
    api('POST', '/api/demo/cartoes/' + encodeURIComponent(c.id) + '/decisao', corpo).then(function () {
      enviando = false;
      fechaCartao();
      consulta();
    }).catch(function (e) {
      enviando = false;
      erroEl.textContent = e.message;
      botoes.forEach(function (b) { b.disabled = false; });
      if (e.status === 409 || e.status === 404) setTimeout(consulta, 300);
    });
  }

  function montaCartao(c, total) {
    if (idAtual !== c.id) escolhido = null; // outro cartão: a escolha do anterior não vale
    idAtual = c.id;
    tiraDoDom();
    raiz = el('div', 'dc-fundo');
    var cx = el('div', 'dc-cartao');
    cx.setAttribute('role', 'dialog');
    cx.setAttribute('aria-modal', 'true');
    cx.setAttribute('aria-label', 'Confirmação pedida pelo agente');
    var titulo = c.tipo === 'leitura' ? 'O agente quer abrir uma conversa' : (c.canal === 'email' ? 'O agente quer enviar este e-mail' : 'O agente quer enviar esta mensagem');
    cx.appendChild(el('h2', 'dc-titulo', titulo));
    if (total > 1) cx.appendChild(el('p', 'dc-outros', 'Mais ' + (total - 1) + ' esperando depois deste.'));
    cx.appendChild(linhaInfo('Canal', c.canal === 'email' ? 'E-mail' : 'WhatsApp'));
    cx.appendChild(linhaInfo('Linha', c.linha_rotulo || c.linha));
    var erroEl = el('p', 'dc-erro');
    erroEl.setAttribute('role', 'alert');
    var confirmar = el('button', 'dc-btn dc-ok', 'Confirmar');
    confirmar.type = 'button';
    var recusar = el('button', 'dc-btn dc-nao', 'Recusar');
    recusar.type = 'button';

    if (c.tipo === 'leitura') {
      cx.appendChild(linhaInfo('Nome pedido', c.nome_pedido, true));
      if (c.erro_busca) cx.appendChild(el('p', 'dc-erro', 'Não consegui buscar os contatos: ' + c.erro_busca));
      else if (!c.candidatos.length) cx.appendChild(el('p', 'dc-vazio', 'Não achei ninguém com esse nome nesta linha. Recuse e peça ao agente para tentar outro nome.'));
      else {
        cx.appendChild(el('p', 'dc-instr', 'Escolha quem é e confirme:'));
        var lista = el('div', 'dc-lista');
        var marcado = null;
        lista.setAttribute('role', 'radiogroup');
        c.candidatos.forEach(function (k) {
          var l = el('label', 'dc-cand');
          var r = el('input');
          r.type = 'radio'; r.name = 'dc-cand'; r.value = k.ref;
          if (k.ref === escolhido) { r.checked = true; marcado = r; }
          r.addEventListener('change', function () { escolhido = k.ref; confirmar.disabled = false; });
          l.appendChild(r);
          var t = el('span', 'dc-cand-txt');
          t.appendChild(el('b', null, k.nome));
          t.appendChild(el('span', null, k.telefone_mascarado || 'ainda sem número'));
          l.appendChild(t);
          lista.appendChild(l);
        });
        cx.appendChild(lista);
      }
      if (!marcado) escolhido = null;
      confirmar.disabled = !marcado;
    } else {
      var d = c.destinatario;
      if (c.canal === 'email') cx.appendChild(linhaInfo('Para', d.para, true));
      else {
        cx.appendChild(linhaInfo('Para', d.nome || 'Sem nome salvo', true));
        cx.appendChild(linhaInfo('Número', d.telefone || 'sem número', true));
      }
      if (c.assunto) cx.appendChild(linhaInfo('Assunto', c.assunto));
      var caixa = el('div', 'dc-texto', c.texto);
      caixa.setAttribute('tabindex', '0');
      caixa.setAttribute('aria-label', 'Texto completo da mensagem');
      var bloco = el('div', 'dc-info');
      bloco.appendChild(el('span', 'dc-rotulo', 'Texto'));
      cx.appendChild(bloco);
      cx.appendChild(caixa);
      if (c.anexos.length) {
        var an = el('div', 'dc-anexos');
        an.appendChild(el('span', 'dc-rotulo', 'Anexos (' + c.anexos.length + ')'));
        c.anexos.forEach(function (a) { an.appendChild(el('span', 'dc-anexo', a.nome + ' (' + tamanho(a.tamanho) + ')')); });
        cx.appendChild(an);
      }
    }
    cx.appendChild(el('p', 'dc-validade', 'Vale por mais ' + Math.max(0, Math.ceil(c.segundos_restantes / 60)) + ' min. Nada sai sem o seu clique.'));
    cx.appendChild(erroEl);
    var botoes = el('div', 'dc-botoes');
    botoes.appendChild(recusar);
    botoes.appendChild(confirmar);
    cx.appendChild(botoes);
    var todos = [confirmar, recusar];
    confirmar.addEventListener('click', function () { decidir(c, 'confirmar', erroEl, todos); });
    recusar.addEventListener('click', function () { decidir(c, 'recusar', erroEl, todos); });
    raiz.appendChild(cx);
    document.body.appendChild(raiz);
    (c.tipo === 'leitura' ? marcado || cx.querySelector('input') || recusar : confirmar).focus();
  }

  function sig(c) {
    return c.id + '|' + (c.candidatos ? c.candidatos.map(function (k) { return k.ref; }).join(',') : '') + '|' + (c.erro_busca || '');
  }

  function consulta() {
    if (resetAberto) return;
    api('GET', '/api/demo/cartoes').then(function (j) {
      // O cartão fica como está enquanto o conteúdo é o mesmo: refazer o DOM a cada 2 s apagaria a escolha da pessoa.
      var c = j.cartoes[0];
      if (!c) fechaCartao();
      else if (!raiz || assinatura !== sig(c)) { assinatura = sig(c); montaCartao(c, j.cartoes.length); }
      j.recentes.forEach(function (r) {
        if (r.estado === 'enviando' || vistos[r.id + r.estado]) return;
        vistos[r.id + r.estado] = true;
        var para = r.para ? ' para ' + r.para : '';
        if (r.estado === 'enviado') aviso('Enviado' + para + (r.confirmacao === 'na_fila' ? ' (na fila de entrega do provedor).' : '.'), 'ok');
        else if (r.estado === 'falhou') aviso('Não enviou' + para + ': ' + (r.motivo || 'sem detalhe.') + (r.detalhe ? ' Resposta do provedor: ' + r.detalhe : ''), 'erro');
      });
      if (j.resetando) mostraProgresso();
    }).catch(function (e) {
      if (e.status === 401) { clearInterval(timer); return; }
      if (e.status === 404) { clearInterval(timer); return; }
      aviso('Não consegui consultar os cartões do agente: ' + e.message, 'erro');
    });
  }

  // ── Reset ────────────────────────────────────────────────────────────────
  var modalReset = null;
  var timerReset = null;

  function fechaReset() {
    clearInterval(timerReset);
    resetAberto = false;
    if (modalReset && modalReset.parentNode) modalReset.parentNode.removeChild(modalReset);
    modalReset = null;
    consulta();
  }

  function mostraProgresso() {
    if (modalReset && modalReset.dataset.fase === 'progresso') return;
    abreReset(true);
  }

  function acompanha(corpo, status) {
    modalReset.dataset.fase = 'progresso';
    corpo.textContent = '';
    corpo.appendChild(el('p', 'dc-instr', 'Preparando o painel para um novo cliente. Isso leva cerca de um minuto, não feche esta página.'));
    var passos = el('ol', 'dc-passos');
    corpo.appendChild(passos);
    var fim = el('div', 'dc-botoes');
    corpo.appendChild(fim);
    clearInterval(timerReset);
    function atualiza() {
      api('GET', '/api/demo/reset/estado').then(function (j) {
        passos.textContent = '';
        (j.passos || []).forEach(function (p) { passos.appendChild(el('li', null, p)); });
        if (j.fase === 'ok') {
          clearInterval(timerReset);
          passos.appendChild(el('li', 'dc-passo-ok', 'Pronto. Recarregando.'));
          setTimeout(function () { location.reload(); }, 700);
        } else if (j.fase === 'falhou') {
          clearInterval(timerReset);
          status.textContent = j.mensagem || 'O reset falhou sem explicar. Veja o log do painel.';
          status.className = 'dc-erro';
          var f = el('button', 'dc-btn dc-nao', 'Fechar');
          f.type = 'button';
          f.addEventListener('click', fechaReset);
          fim.appendChild(f);
        }
      }).catch(function (e) {
        // O painel pode reiniciar durante o reset; continua tentando e mostra a causa enquanto isso.
        status.textContent = 'Esperando o painel responder (' + e.message + ').';
      });
    }
    atualiza();
    timerReset = setInterval(atualiza, 1500);
  }

  function abreReset(jaEmAndamento) {
    if (modalReset) return;
    resetAberto = true;
    fechaCartao();
    var fundo = el('div', 'dc-fundo');
    modalReset = fundo;
    var cx = el('div', 'dc-cartao');
    cx.setAttribute('role', 'dialog');
    cx.setAttribute('aria-modal', 'true');
    cx.setAttribute('aria-label', 'Novo cliente');
    cx.appendChild(el('h2', 'dc-titulo', 'Novo cliente (Reset)'));
    var corpo = el('div', 'dc-corpo');
    var status = el('p', 'dc-erro');
    status.setAttribute('role', 'alert');
    cx.appendChild(corpo);
    cx.appendChild(status);
    fundo.appendChild(cx);
    document.body.appendChild(fundo);
    if (jaEmAndamento) { acompanha(corpo, status); return; }
    corpo.appendChild(el('p', 'dc-instr', 'O agente começa do zero: a conversa, a memória, os arquivos e os cartões do cliente anterior saem da tela e são guardados em uma pasta de arquivo no servidor. Nada é apagado, e o login e a identidade do agente continuam.'));
    var rot = el('label', 'dc-rotulo-campo', 'Para continuar, escreva ' + FRASE);
    var campo = el('input', 'dc-campo');
    campo.type = 'text'; campo.autocomplete = 'off'; campo.setAttribute('autocapitalize', 'characters'); campo.setAttribute('spellcheck', 'false');
    campo.placeholder = FRASE;
    rot.appendChild(campo);
    corpo.appendChild(rot);
    var botoes = el('div', 'dc-botoes');
    var cancelar = el('button', 'dc-btn dc-nao', 'Cancelar');
    cancelar.type = 'button';
    var ir = el('button', 'dc-btn dc-ok', 'Fazer o reset');
    ir.type = 'button'; ir.disabled = true;
    botoes.appendChild(cancelar); botoes.appendChild(ir);
    corpo.appendChild(botoes);
    campo.addEventListener('input', function () { ir.disabled = campo.value.trim() !== FRASE; });
    cancelar.addEventListener('click', fechaReset);
    ir.addEventListener('click', function () {
      ir.disabled = true; cancelar.disabled = true; status.textContent = '';
      api('POST', '/api/demo/reset', { confirmacao: campo.value.trim() }).then(function () {
        acompanha(corpo, status);
      }).catch(function (e) {
        status.textContent = e.message;
        cancelar.disabled = false; ir.disabled = campo.value.trim() !== FRASE;
      });
    });
    campo.focus();
  }

  function botaoReset() {
    var barra = document.getElementById('tools');
    if (!barra || document.getElementById('btnDemoReset')) return;
    var b = el('button', 'btn');
    b.id = 'btnDemoReset'; b.type = 'button';
    b.title = 'Começar um novo cliente: guarda a conversa atual e deixa o agente do zero';
    b.setAttribute('aria-label', 'Novo cliente (Reset)');
    b.appendChild(document.createTextNode('🔄 '));
    b.appendChild(el('span', 'lbl', 'Novo cliente (Reset)'));
    b.addEventListener('click', function () { abreReset(false); });
    barra.insertBefore(b, barra.firstChild);
  }

  function inicia() {
    botaoReset();
    consulta();
    timer = setInterval(function () { if (!document.hidden) consulta(); }, INTERVALO);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia); else inicia();
})();
