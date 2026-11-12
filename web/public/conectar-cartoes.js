'use strict';
/* conectar-cartoes.js: os cartões de login (um por agente) e o fluxo de cada um, compartilhados pela página
   /conectar e pelo modal "Faça o login nos seus agentes" da conversa (modal-login.js).

   Cada chamada de DGConectarCartoes.cria(opcoes) devolve um controlador com o próprio estado: não há estado
   global de módulo, então a página e o modal podem coexistir. Opções:
     lista       elemento que recebe os cartões
     agentes     lista de agentes já ordenada
     principal   o agente principal (ou null)
     prefixoId   prefixo do id do campo do código (único por controlador)
     voltarPara  destino do /login?next= quando a sessão do painel vence (401)
     aoMudar     função(controlador) chamada depois de cada desenho geral
     desenhar    false para não tocar no DOM (usado pelo teste da corrida)
   Devolve { inicia, selos, visaoDe, para, novoLink, est }.

   Usa só rotas que já existem: GET /api/v1/agents e GET/POST/DELETE /api/v1/agents/<id>/login, mais
   /login/codigo e /login/oi. Contrato: web/docs/CONECTAR-CONTA.md e web/docs/LOGIN-NA-CONVERSA.md.
   O que cada cartão mostra e como cada erro vira frase vem de conectar-puro.js (com teste).

   SEGREDOS: o link de login e o código colado nunca vão para console, log, localStorage, URL nem atributo
   title. O campo do código é limpo depois de cada envio, com sucesso ou erro. Todo texto que vem do
   servidor entra com textContent. */
(function () {
  const P = window.DGConectar;
  const LC = window.DGLoginCartao;
  const COLAB = !!(window.DGPapel && window.DGPapel.colaborador);

  function paraOLogin(voltarPara) { location.href = '/login?next=' + encodeURIComponent(voltarPara || '/conectar'); }

  /* Chama a API sem nunca lançar: devolve { ok, status, dados, erro } com o erro já em frase de leigo.
     Com 401 leva ao login e volta para `voltarPara`. */
  async function chama(metodo, url, corpo, acao, nome, timeoutMs, voltarPara) {
    const init = { method: metodo, cache: 'no-store', credentials: 'same-origin' };
    if (corpo !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(corpo); }
    const ctl = new AbortController();
    init.signal = ctl.signal;
    const relogio = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    let r = null, dados = null, falhaRede = '';
    try {
      r = await fetch(url, init);
      try { dados = await r.json(); } catch (e) { dados = null; }
    } catch (e) {
      falhaRede = ctl.signal.aborted ? 'o painel não respondeu a tempo' : (e && e.message) || 'sem rede';
    } finally { clearTimeout(relogio); }
    if (!r) return { ok: false, status: 0, dados: null, erro: P.traduzErro(0, falhaRede, acao, nome, COLAB) };
    if (r.ok && !(dados && dados.ok === false)) return { ok: true, status: r.status, dados: dados || {}, erro: null };
    const t = P.traduzErro(r.status, dados && dados.erro, acao, nome, COLAB);
    if (t.sessaoExpirada) paraOLogin(voltarPara);
    return { ok: false, status: r.status, dados, erro: t };
  }

  const urlLogin = id => '/api/v1/agents/' + encodeURIComponent(id) + '/login';
  const novoEstado = () => ({ dados: null, erroConferir: '', iniciado: false, concluiuAgora: false, ocupado: false,
                              erro: '', erroPoll: '', aviso: '', copiado: false, confirmando: false, oiFeito: false, conferindo: false,
                              geracao: 0 });
  const emAndamento = e => !!e.dados && P.emAndamento(e.dados.estado);

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function botao(texto, classe, aoClicar, desligado) {
    const b = el('button', 'cn-btn ' + classe, texto);
    b.type = 'button';
    b.disabled = !!desligado;
    b.addEventListener('click', aoClicar);
    return b;
  }
  function foto(a) {
    const f = el('div', 'cn-foto');
    f.setAttribute('aria-hidden', 'true');
    if (a.cor) f.style.background = /^#[0-9a-f]{3,8}$/i.test(a.cor) ? a.cor : '';
    if (a.avatar_img && /^(https:\/\/|\/)/i.test(a.avatar_img) && !a.avatar_img.startsWith('//')) {
      const img = document.createElement('img');
      img.alt = ''; img.src = a.avatar_img;
      f.append(img);
    } else f.textContent = a.avatar && a.avatar.length <= 2 ? a.avatar : (a.nome || '?').slice(0, 1).toUpperCase();
    return f;
  }

  function cria(opcoes) {
    const o = opcoes || {};
    const desenha = o.desenhar !== false;
    const lista = o.lista;
    const prefixoId = o.prefixoId || 'cnCodigo-';
    const voltarPara = o.voltarPara || '/conectar';
    const est = { agentes: o.agentes || [], por: {}, timer: null, principal: o.principal || null };
    for (const a of est.agentes) est.por[a.id] = novoEstado();
    let ligado = true;

    const chamaApi = (m, u, c, ac, n, t) => chama(m, u, c, ac, n, t, voltarPara);

    function outroEmAndamento(id) {
      for (const a of est.agentes) {
        if (a.id !== id && emAndamento(est.por[a.id])) return a.nome;
      }
      return '';
    }

    function visaoDe(a) {
      const e = est.por[a.id];
      return P.visaoCartao(e.dados, { agente: a, iniciado: e.iniciado, concluiuAgora: e.concluiuAgora, erroConferir: e.erroConferir, outroNome: outroEmAndamento(a.id), principal: !!est.principal && est.principal.id === a.id, colaborador: COLAB });
    }
    const selos = () => est.agentes.map(a => visaoDe(a).selo);

    function desenhaCartao(a) {
      if (!desenha) return;
      const e = est.por[a.id];
      const v = visaoDe(a);
      let cartao = Array.from(lista.children).find(c => c.dataset && c.dataset.agente === a.id);
      if (!cartao) { cartao = el('article', 'cn-cartao'); cartao.dataset.agente = a.id; lista.append(cartao); }
      cartao.dataset.fase = v.fase;

      // o campo do código é refeito junto com o cartão: guarda o texto e o foco para o teclado não fechar
      const antes = cartao.querySelector('.cn-campo');
      const valor = antes ? antes.value : '';
      const focado = !!antes && document.activeElement === antes;

      const topo = el('div', 'cn-topo');
      const quem = el('div', 'cn-quem');
      quem.append(el('b', 'cn-nome', v.rotulo), el('span', 'cn-agnome', v.nome), el('span', 'cn-papel', v.papel));
      if (v.subtitulo) quem.append(el('span', 'cn-sub', v.subtitulo));
      const selo = el('span', 'cn-selo cn-' + v.selo.cor, v.selo.texto);
      selo.dataset.tour = 'cn-selo';
      topo.append(foto(a), quem, selo);
      const corpo = [topo];

      if (v.texto) corpo.push(el('p', 'cn-texto', v.texto));
      // Com qual IA o agente vai entrar. Hoje há uma só opção compatível, então só o nome. Quando houver mais de
      // uma (v.ia.seletor), este bloco vira um seletor e o escolhido segue em `provedor` no POST de comeca.
      if (v.gerar && v.ia && v.ia.escolhido) {
        const ia = el('p', 'cn-ia');
        ia.append(el('span', 'cn-ia-pergunta', v.ia.pergunta + ' '), el('b', 'cn-ia-nome', v.ia.escolhido.nome));
        corpo.push(ia);
      }
      if (v.passos.length) {
        const ol = el('ol', 'cn-lista-passos');
        for (const p of v.passos) ol.append(el('li', '', p));
        corpo.push(ol);
      }
      if (v.link) {
        const ab = el('a', 'cn-btn cn-principal cn-grande', 'Abrir a página de login');
        ab.href = v.link; ab.target = '_blank'; ab.rel = 'noopener noreferrer';
        corpo.push(ab);
        corpo.push(botao(e.copiado ? 'Link copiado' : 'Copiar link', 'cn-leve', () => copiaLink(a), e.ocupado));
      }
      if (v.codigoDispositivo) corpo.push(el('div', 'cn-dispositivo', v.codigoDispositivo));
      if (v.campoCodigo) {
        const rot = el('label', 'cn-rotulo', 'Cole aqui o código');
        rot.htmlFor = prefixoId + a.id;
        const campo = document.createElement('input');
        campo.type = 'text'; campo.id = rot.htmlFor; campo.className = 'cn-campo';
        campo.autocomplete = 'off'; campo.spellcheck = false; campo.value = valor;
        campo.setAttribute('autocapitalize', 'off');
        campo.setAttribute('autocorrect', 'off');
        campo.dataset.tour = 'cn-codigo';
        campo.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); enviaCodigo(a); } });
        const linha = el('div', 'cn-linha');
        linha.append(campo, botao(e.ocupado ? 'Enviando…' : 'Conectar', 'cn-principal', () => enviaCodigo(a), e.ocupado));
        corpo.push(rot, linha);
      }
      if (e.erro || e.erroPoll) { const p = el('p', 'cn-erro', e.erro || e.erroPoll); p.setAttribute('role', 'alert'); corpo.push(p); }
      if (e.aviso) corpo.push(el('p', 'cn-nota', e.aviso));
      if (v.gerarBloqueio && (v.gerar === false) && v.fase !== 'conectado') corpo.push(el('p', 'cn-nota', v.gerarBloqueio));

      const pe = el('div', 'cn-pe');
      if (v.gerar) {
        const g = botao(e.ocupado ? 'Gerando…' : v.gerarRotulo, 'cn-principal cn-grande', () => comeca(a), e.ocupado);
        g.dataset.tour = 'cn-gerar';
        pe.append(g);
      }
      if (v.fase === 'sem_resposta') pe.append(botao('Conferir de novo', 'cn-principal', () => confere(a, true), e.conferindo));
      if (v.entrarOutra) {
        if (e.confirmando) {
          pe.append(el('p', 'cn-texto', 'Isso troca a conta de ' + v.nome + '. Continuar?'));
          pe.append(botao('Sim, trocar a conta', 'cn-principal', () => { e.confirmando = false; comeca(a); }, e.ocupado));
          pe.append(botao('Não', 'cn-leve', () => { e.confirmando = false; desenhaCartao(a); }));
        } else {
          pe.append(botao('Entrar com outra conta', 'cn-leve', () => { e.confirmando = true; desenhaCartao(a); }, e.ocupado));
        }
      }
      if (v.novoLink) pe.append(botao('Gerar novo link', 'cn-leve', () => novoLink(a), e.ocupado));
      if (v.cancelar) pe.append(botao('Cancelar', 'cn-leve', () => cancela(a), e.ocupado));
      if (pe.childElementCount) corpo.push(pe);
      const vivo = el('p', 'cn-vivo', v.aviso || '');
      vivo.setAttribute('aria-live', 'polite');
      corpo.push(vivo);

      cartao.replaceChildren(...corpo);
      if (focado) {
        const novo = cartao.querySelector('.cn-campo');
        if (novo) novo.focus({ preventScroll: true });
      }
    }

    function desenhaTudo() {
      if (desenha) for (const a of est.agentes) desenhaCartao(a);
      if (typeof o.aoMudar === 'function') o.aoMudar(ctrl);
    }

    async function confere(a, mostraCarregando) {
      const e = est.por[a.id];
      if (e.conferindo) return;
      e.conferindo = true;
      if (mostraCarregando) desenhaCartao(a);
      // geração: toda ação (gerar, cancelar, enviar código) a incrementa. Uma consulta que saiu antes da ação
      // e chegou depois dela traz um estado velho e é descartada (corrida apontada na revisão do PR #86).
      const geracao = e.geracao;
      const r = await chamaApi('GET', urlLogin(a.id), undefined, 'conferir', a.nome, 15000);
      e.conferindo = false;
      if (geracao !== e.geracao) return;
      if (!r.ok) {
        // no meio de um login, um tropeço da consulta não esconde o cartão: aparece como aviso e a próxima volta tenta de novo
        if (emAndamento(e)) e.erroPoll = r.erro.texto;
        else e.erroConferir = r.erro.texto;
      } else {
        e.erroConferir = ''; e.erroPoll = '';
        const eraEmAndamento = emAndamento(e);
        e.dados = r.dados;
        if (emAndamento(e)) e.iniciado = true;
        // O GET do colaborador só diz { conectado: true } quando já há conta (sem `estado`).
        else if ((r.dados.estado === 'concluido' || (COLAB && r.dados.conectado === true)) && (e.iniciado || eraEmAndamento)) { e.iniciado = true; conclui(a); }
      }
      desenhaCartao(a);
      desenhaTudo();
    }

    /* O oi é pedido uma vez; se falhar, a conta continua conectada e o aviso diz a causa. */
    async function conclui(a) {
      const e = est.por[a.id];
      if (e.concluiuAgora) return;
      e.concluiuAgora = true; e.erro = '';
      desenhaCartao(a); desenhaTudo();
      if (e.oiFeito) return;
      e.oiFeito = true;
      const r = await chamaApi('POST', urlLogin(a.id) + '/oi', {}, 'oi', a.nome, 75000);
      if (!r.ok) e.aviso = 'A conta foi conectada, mas ' + r.erro.texto;
      desenhaCartao(a);
    }

    async function comeca(a) {
      const e = est.por[a.id];
      if (e.ocupado) return;
      e.ocupado = true; e.erro = ''; e.aviso = ''; e.confirmando = false;
      e.geracao++;
      desenhaCartao(a);
      const ia = visaoDe(a).ia;
      const r = await chamaApi('POST', urlLogin(a.id), ia && ia.escolhido ? { provedor: ia.escolhido.id } : {}, 'gerar', a.nome);
      e.ocupado = false;
      if (!r.ok) e.erro = r.erro.texto;
      else {
        const velho = e.dados || {};
        e.dados = Object.assign({ provedor: velho.provedor, auth: velho.auth, conferido: velho.conferido, precisa_login: velho.precisa_login, login_expirado: velho.login_expirado }, r.dados);
        e.iniciado = true; e.concluiuAgora = false; e.oiFeito = false; e.erroConferir = '';
      }
      desenhaCartao(a); desenhaTudo();
    }

    async function cancela(a) {
      const e = est.por[a.id];
      if (e.ocupado) return false;
      e.ocupado = true; e.erro = '';
      e.geracao++;
      desenhaCartao(a);
      const r = await chamaApi('DELETE', urlLogin(a.id), undefined, 'cancelar', a.nome);
      e.ocupado = false;
      if (!r.ok) { e.erro = r.erro.texto; desenhaCartao(a); return false; }
      e.iniciado = false;
      if (e.dados) e.dados = Object.assign({}, e.dados, { estado: 'nenhum', link: undefined, codigoDispositivo: undefined, mensagem: undefined });
      desenhaCartao(a); desenhaTudo();
      confere(a);
      return true;
    }

    async function novoLink(a) {
      if (await cancela(a)) comeca(a);
    }

    async function enviaCodigo(a) {
      const e = est.por[a.id];
      if (e.ocupado) return;
      const campo = desenha ? lista.querySelector('#' + CSS.escape(prefixoId + a.id)) : null;
      const codigo = P.limpaCodigo(campo ? campo.value : '');
      if (!codigo) { e.erro = 'Cole o código que a página mostrou no fim do login.'; desenhaCartao(a); if (campo) campo.focus(); return; }
      e.ocupado = true; e.erro = '';
      e.geracao++;
      // o código sai do campo antes da chamada, com sucesso ou erro: não fica na tela nem em variável
      campo.value = '';
      desenhaCartao(a);
      const r = await chamaApi('POST', urlLogin(a.id) + '/codigo', { codigo }, 'codigo', a.nome);
      e.ocupado = false;
      if (!r.ok) e.erro = r.erro.texto;
      desenhaCartao(a);
      if (r.ok) confere(a);
    }

    async function copiaLink(a) {
      const e = est.por[a.id];
      const link = e.dados ? LC.linkSeguro(e.dados.link) : null;
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        e.copiado = true; e.erro = '';
        setTimeout(() => { e.copiado = false; desenhaCartao(a); }, 2000);
      } catch (err) {
        e.erro = 'Não consegui copiar sozinho (' + ((err && err.message) || 'o navegador recusou') + '). Use o botão Abrir a página de login neste aparelho.';
      }
      desenhaCartao(a);
    }

    function conferePendentes() {
      if (!ligado || document.visibilityState !== 'visible') return;
      for (const a of est.agentes) if (emAndamento(est.por[a.id])) confere(a);
    }

    /* Confere de 2 em 2 s só os cartões com login em andamento, e só com a aba à vista. */
    function liga() {
      if (est.timer) return;
      est.timer = setInterval(conferePendentes, 2000);
      document.addEventListener('visibilitychange', conferePendentes);
    }

    function para() {
      ligado = false;
      if (est.timer) { clearInterval(est.timer); est.timer = null; }
      if (document.removeEventListener) document.removeEventListener('visibilitychange', conferePendentes);
    }

    async function inicia() {
      ligado = true;
      desenhaTudo();
      await Promise.all(est.agentes.map(a => confere(a, false)));
      liga();
    }

    const ctrl = { inicia, selos, visaoDe, para, novoLink, est };
    return ctrl;
  }

  window.DGConectarCartoes = { cria, chama };
})();
