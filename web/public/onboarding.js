'use strict';
const dgUiText_onboarding_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgUiHtml_onboarding_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, '');
const dgUiLabel_onboarding_js = (el, fonte, atributo) => { if (globalThis.DGI18n) globalThis.DGI18n.rotulo(el, fonte, atributo); else if (atributo) el.setAttribute(atributo, fonte); else el.textContent = fonte; };
/* Visual de criação no chat do Admin. Mesmo contrato de texto dos vis-*:
   data-pergunta descreve a intenção; só o gesto do dono envia para a conversa.
   Foto usa o upload autenticado do chat, nunca uma URL externa. */
(function () {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function json(url, op) {
    const r = await fetch(url, { cache: 'no-store', ...op });
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error(dgUiText_onboarding_js("Entre novamente para continuar.")); }
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.erro || dgUiText_onboarding_js("Não consegui falar com o servidor. Tente novamente."));
    return d;
  }
  function iniciar({ agente, enviar, refazer }) {
    if (agente.tipo !== 'admin') {
      try {
        if (sessionStorage.getItem('dgclaw-agente-novo') === agente.id) {
          sessionStorage.removeItem('dgclaw-agente-novo');
          setTimeout(() => window.DGTour?.inicia({ passos: [{ alvo:'#btnMenu', titulo: 'Seu agente está no menu', oque: 'Agora é só selecionar e falar com ele.', como: 'Toque no menu à esquerda e escolha o nome do agente.', porque: 'Você pode voltar ao Admin ou conversar com seus agentes por aqui.' }] }), 500);
        }
      } catch (_) { /* A conversa funciona mesmo sem armazenamento local. */ }
      return;
    }
    const host = document.createElement('section');
    host.className = 'nascimento'; host.id = 'nascimento';
    dgUiLabel_onboarding_js(host, "Criar meu agente", "aria-label");
    /* O cartão vive num modal anexado ao body, fora do #chat: mensagem nova do Admin não o empurra nem
       o faz pular. Fechar só esconde o modal (o host e tudo o que foi digitado continuam intactos). */
    const modal = document.createElement('div');
    modal.className = 'nas-modal'; modal.hidden = true;
    const caixa = document.createElement('div');
    caixa.className = 'nas-caixa'; caixa.tabIndex = -1;
    caixa.setAttribute('role', 'dialog'); caixa.setAttribute('aria-modal', 'true'); dgUiLabel_onboarding_js(caixa, "Criar meu agente", "aria-label");
    const rolo = document.createElement('div'); rolo.className = 'nas-rolo';
    const bFechar = document.createElement('button');
    bFechar.type = 'button'; bFechar.className = 'nas-fechar'; dgUiLabel_onboarding_js(bFechar, "Fechar e continuar no chat", "aria-label");
    bFechar.innerHTML = dsIcone('x');
    rolo.appendChild(host); caixa.append(bFechar, rolo); modal.appendChild(caixa);
    const pilula = document.createElement('button');
    pilula.type = 'button'; pilula.className = 'nas-pilula'; pilula.hidden = true;
    document.body.append(modal, pilula);
    let tela = '', preenchendo = false, id = '', foto = null, nome = '';
    let minimizado = false, aberto = false, focoAnterior = null, finalDe = null;
    let faseAtual = '', comErroAtual = false, nomeAtual = '';
    /* Depois de tocar, a animação vira um cartão estático no histórico (posicionado pela hora em que a
       criação terminou). Quem monta a lista da conversa pede os cartões por DGOnboarding.cartoes(). */
    const cartoes = new Map();
    // Ids dispensados nesta sessão: o polling não pode trazer de volta um cartão cuja gravação no servidor ainda está a caminho.
    const dispensados = new Set();
    let animando = null, esperaVisivel = false;
    const chaveVista = i => 'dgclaw-anim-vista:' + i;
    function vistaLocal(i) { try { return localStorage.getItem(chaveVista(i)) === '1'; } catch (_) { return false; } }
    async function marcarVista(i) {
      try { localStorage.setItem(chaveVista(i), '1'); } catch (_) { /* o servidor é a fonte principal */ }
      try { await json('/api/v1/onboarding/animacao-vista', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i }) }); }
      catch (e) { console.warn('onboarding: não consegui guardar no servidor que a animação já tocou (' + e.message + '). Ela fica marcada só neste navegador; a próxima abertura tenta de novo.'); }
    }
    function pedeRender() { if (typeof refazer === 'function') refazer(); }
    const temConteudo = () => host.childElementCount > 0;
    function atualizaPilula() {
      const mostra = minimizado && !aberto && temConteudo();
      pilula.hidden = !mostra;
      if (mostra) pilula.textContent = textoPilula({ tela, fase: faseAtual, nome: nomeAtual || nome, comErro: comErroAtual });
    }
    const focaveis = () => [...caixa.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(e => e.getClientRects().length > 0);
    // Mostra o modal, a não ser que a pessoa o tenha minimizado nesta página (aí só a pílula é atualizada).
    function abreModal() {
      if (minimizado) { atualizaPilula(); return; }
      if (aberto) return;
      aberto = true;
      focoAnterior = document.activeElement;
      modal.hidden = false; pilula.hidden = true;
      document.body.classList.add('nas-modal-aberto');
      // Foca a caixa, nunca um campo: no iPhone isso abriria o teclado sozinho.
      try { caixa.focus({ preventScroll: true }); } catch (_) { caixa.focus(); }
    }
    function escondeModal() {
      const estava = aberto;
      aberto = false; modal.hidden = true;
      document.body.classList.remove('nas-modal-aberto');
      return estava;
    }
    function devolveFoco() {
      const f = focoAnterior; focoAnterior = null;
      const campo = f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName || '') || (f && f.isContentEditable);
      try {
        if (f && f.isConnected && !campo && f !== document.body) f.focus({ preventScroll: true });
        else if (!pilula.hidden) pilula.focus({ preventScroll: true });
      } catch (_) { /* foco é só conforto */ }
    }
    // Pelo X ou pelo Esc: esconde, nada é apagado. No estado final (pronto), fechar leva o cartão ao histórico.
    function fechaModal() {
      if (finalDe) { const d = finalDe; finalDe = null; animando = null; escondeModal(); encerraAnimacao(d, true); devolveFoco(); return; }
      minimizado = true;
      escondeModal();
      atualizaPilula();
      devolveFoco();
    }
    // O fluxo terminou: some tudo e o próximo cartão que surgir abre normalmente.
    function encerraModal() {
      escondeModal();
      pilula.hidden = true;
      host.innerHTML = ''; tela = ''; finalDe = null; minimizado = false;
      pararTique(); exibido = 0; realPct = 0; proxPct = 0; temErro = false; ultimaBarra = '';
      document.body.classList.remove('admin-primeiro-acesso');
    }
    bFechar.onclick = fechaModal;
    pilula.onclick = () => { minimizado = false; abreModal(); };
    document.addEventListener('keydown', ev => {
      if (!aberto) return;
      if (document.getElementById('tourCaixa') || document.getElementById('tourFundo')) return; // o tutorial manda
      if (ev.key === 'Escape') { ev.preventDefault(); fechaModal(); return; }
      if (ev.key !== 'Tab') return;
      const l = focaveis();
      if (!l.length) { ev.preventDefault(); caixa.focus(); return; }
      const p = l[0], u = l[l.length - 1], at = document.activeElement;
      if (!caixa.contains(at) || at === caixa) { ev.preventDefault(); (ev.shiftKey ? u : p).focus(); }
      else if (ev.shiftKey && at === p) { ev.preventDefault(); u.focus(); }
      else if (!ev.shiftKey && at === u) { ev.preventDefault(); p.focus(); }
    });
    /* tocou: a animação rodou nesta aba. Só então ela conta como vista; uma aba que abre já com tudo pronto
       (sem tela de progresso) só mostra o cartão e não pode gastar a animação da aba que acompanhou a criação. */
    function encerraAnimacao(d, tocou) {
      if (dispensados.has(d.id)) return;
      if (cartoes.has(d.id) && !temConteudo()) return;
      encerraModal();
      cartoes.set(d.id, { id: d.id, nome: d.nome, foto: d.foto, conversa: d.conversa, concluido: d.concluido });
      if (tocou && !d.animacaoVista) marcarVista(d.id);
      pedeRender();
    }
    function avisoDeErro(m) {
      tela = ''; minimizado = false;
      host.innerHTML = '<p class="nas-erro" role="alert"></p>';
      const e = host.querySelector('.nas-erro'); e.textContent = m; e.hidden = false;
      abreModal();
      setTimeout(() => { if (host.querySelector('.nas-erro') && tela === '') encerraModal(); }, 8000);
    }
    // O X some com o cartão na hora; se o servidor não confirmar, o cartão volta e a causa aparece na tela.
    async function dispensar(i) {
      const c = cartoes.get(i);
      dispensados.add(i); cartoes.delete(i);
      if (animando === i) { animando = null; encerraModal(); }
      pedeRender();
      try { await json('/api/v1/onboarding/cartao-dispensado', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: i }) }); }
      catch (e) {
        dispensados.delete(i);
        if (c) cartoes.set(i, c);
        pedeRender();
        avisoDeErro(dgUiText_onboarding_js("Não consegui dispensar o cartão: ") + e.message + dgUiText_onboarding_js(" O cartão voltou; tente de novo em instantes."));
      }
    }
    // Um único ouvinte: os cartões do histórico são recriados a cada desenho da conversa.
    document.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest && ev.target.closest('[data-dispensar]');
      if (b) { ev.preventDefault(); dispensar(b.dataset.dispensar); }
    });
    // Botão do texto do Admin ([ver a criação]) e DGOnboarding.abrir(): reabre o modal ou leva ao cartão do histórico.
    let reabrindo = false;
    async function reabrir(btn) {
      if (temConteudo()) { minimizado = false; abreModal(); return; }
      if (reabrindo) return;
      reabrindo = true;
      const original = btn ? btn.textContent : '';
      const avisa = t => { if (!btn) return; btn.textContent = t; setTimeout(() => { if (btn.textContent === t) btn.textContent = original; }, 4000); };
      try {
        minimizado = false;
        const d = await json('/api/v1/onboarding');
        ultimaFase = d.fase; mostrar(d);
        if (temConteudo()) { minimizado = false; abreModal(); return; }
        const alvo = d.fase === 'pronto' ? d.id : '';
        const acha = () => alvo && document.querySelector('[data-msg="' + (window.CSS && CSS.escape ? CSS.escape('nasc-' + alvo) : 'nasc-' + alvo) + '"]');
        const el = acha();
        if (el) el.scrollIntoView({ block: 'center' });
        else if (alvo && cartoes.has(alvo)) requestAnimationFrame(() => { const e2 = acha(); if (e2) e2.scrollIntoView({ block: 'center' }); });
        else avisa(dgUiText_onboarding_js("Nenhuma criação em andamento agora"));
      } catch (e) { avisa(e.message); }
      finally { reabrindo = false; }
    }
    document.addEventListener('click', ev => {
      const b = ev.target && ev.target.closest && ev.target.closest('[data-abrir-criacao]');
      if (b) { ev.preventDefault(); reabrir(b); }
    });
    window.DGOnboarding.abrir = () => reabrir(null);
    const dataHora = ep => {
      const dt = new Date(ep * 1000), z = n => String(n).padStart(2, '0');
      return { dia: z(dt.getDate()) + '/' + z(dt.getMonth() + 1) + '/' + dt.getFullYear(), hhmm: z(dt.getHours()) + ':' + z(dt.getMinutes()) };
    };
    window.DGOnboarding.cartoes = () => [...cartoes.values()].filter(c => c.id !== animando && c.concluido > 0).map(c => ({ ...c, ep: c.concluido, ...dataHora(c.concluido) }));
    const novoId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2,'0')).join('');
    function erro(m) { const e = host.querySelector('.nas-erro'); if (e) { e.textContent = m; e.hidden = false; } }
    const passos = [
      { alvo:'[data-tour="nas-inicio"]', titulo: 'Seu primeiro passo', oque: 'O Admin prepara os agentes e cuida do servidor.', como: 'O botão envia seu pedido nesta conversa. Você escolhe nome, função, tom e foto antes de confirmar a criação.', porque: 'Você faz a configuração pelo painel e acompanha cada etapa.' },
      { alvo:'[data-tour="nas-nome"]', titulo: 'Nome do seu agente', oque:'É como ele vai aparecer na conversa e no menu.', como: 'Você escolhe o nome. O Admin cuida do cadastro.', porque: 'Você reconhece seu agente pelo nome, sem precisar lidar com códigos.' },
      { alvo:'[data-tour="nas-papel"]', titulo: 'Função e tom', oque: 'O trabalho que você quer delegar e o jeito de conversar.', como: 'Essas respostas entram na identidade do agente. Não existe uma nota ou cálculo.', porque: 'Ele começa sabendo como pode ajudar você.' },
      { alvo:'[data-tour="nas-foto"]', titulo:'Foto opcional', oque: 'A imagem que identifica seu agente.', como: 'Suba PNG, JPEG ou WebP de até 5 MB, ou gere um avatar ilustrado aqui. A geração é local e não usa IA nem envia dados a outro serviço. Sem foto, usamos um avatar neutro.', porque: 'A foto ajuda a reconhecer o agente. Você pode começar sem ela.' },
      { alvo:'[data-tour="nas-estado"]', titulo: 'Preparação e boas-vindas', oque: 'A etapa real da criação.', como: 'O Admin prepara o agente, você conecta sua assinatura e ele testa uma resposta. Só depois a caixa abre.', porque: 'Assim você sabe se precisa fazer algo e quando já pode conversar.' }
    ];
    function tutorial(seletor) { if (window.DGTour) window.DGTour.inicia({ passos: seletor ? passos.filter(p=>p.alvo===seletor) : passos }); }
    function cab(titulo) {
      return dgUiHtml_onboarding_js("<div class=\"nas-topo\"><span class=\"nas-marca\"><!--dg-i18n:1cd14ecd3f5f-->DG CLAW · ADMIN<!--/dg-i18n--></span><button type=\"button\" class=\"nas-tutorial\"><!--dg-i18n:c26982b1425d-->Tutorial<!--/dg-i18n--></button></div><h2>")+titulo+'</h2>';
    }
    function ligarAjuda() {
      host.querySelector('.nas-tutorial').onclick = () => tutorial();
      host.querySelectorAll('[data-ajuda]').forEach(b => b.onclick = () => tutorial(b.dataset.ajuda));
    }
    function inicio() {
      tela = 'inicio';
      document.body.classList.add('admin-primeiro-acesso');
      host.innerHTML = cab(dgUiText_onboarding_js("Bem-vindo ao seu DG Claw")) + dgUiHtml_onboarding_js("<section data-tour=\"nas-inicio\"><p><!--dg-i18n:732a689436b1-->Eu sou o Admin. Cuido deste servidor e ajudo você a criar seus agentes.<!--/dg-i18n--></p><p><!--dg-i18n:a2ce0f7879cf-->Você escolhe um nome, conta o que quer delegar e acompanha tudo por aqui. Depois, é só conversar com seu agente pelo menu à esquerda.<!--/dg-i18n--></p><button id=\"nasComecar\" type=\"button\" class=\"nas-principal\" data-pergunta=\"Quero criar meu primeiro agente\"><!--dg-i18n:e0b6ef90f988-->Quero criar meu primeiro agente<!--/dg-i18n--></button></section><p class=\"nas-erro\" role=\"alert\" hidden></p>");
      abreModal();
      host.querySelector('.nas-tutorial').onclick = () => tutorial('[data-tour="nas-inicio"]');
      host.querySelector('#nasComecar').onclick = async () => {
        const b = host.querySelector('#nasComecar'); b.disabled = true;
        try { await enviar(dgUiText_onboarding_js("Quero criar meu primeiro agente")); boasVindas(); }
        catch (e) { erro(e.message); b.disabled = false; }
      };
    }
    function boasVindas() {
      tela = 'boas-vindas';
      host.innerHTML = cab(dgUiText_onboarding_js("Vamos criar seu primeiro agente?")) + dgUiHtml_onboarding_js("<p><!--dg-i18n:b75001c69d73-->Eu sou o Admin. Cuido deste servidor e preparo seus agentes. Como vai se chamar o primeiro?<!--/dg-i18n--></p><form id=\"nasNome\"><section data-tour=\"nas-nome\"><div class=\"nas-rotulo\"><label for=\"nasNomeInput\"><!--dg-i18n:14e56277fd03-->Nome do agente<!--/dg-i18n--></label><button type=\"button\" data-ajuda=\"[data-tour=nas-nome]\" aria-label=\"Ajuda sobre o nome\" data-dg-i18n-aria-label=\"a8c80662e5e4\">?</button></div><input id=\"nasNomeInput\" name=\"nome\" maxlength=\"70\" placeholder=\"Ex.: Sofia\" data-dg-i18n-placeholder=\"d92461c953d2\" required autocomplete=\"off\"><button class=\"nas-principal\" type=\"submit\" data-pergunta=\"Quero criar meu primeiro agente\"><!--dg-i18n:63e2bbaf1c92-->Continuar<!--/dg-i18n--></button></section></form><p class=\"nas-erro\" role=\"alert\" hidden></p>");
      abreModal();
      // Os seletores de tutorial são âncoras estáveis, sem dependência da aparência.
      host.querySelector('[data-ajuda]').onclick = () => tutorial('[data-tour="nas-nome"]');
      host.querySelector('.nas-tutorial').onclick = () => tutorial('[data-tour="nas-nome"]');
      host.querySelector('form').onsubmit = async ev => {
        ev.preventDefault(); nome = host.querySelector('input').value.trim(); if (!nome) return;
        const bot = host.querySelector('[type=submit]'); bot.disabled = true;
        try { await enviar(dgUiText_onboarding_js("Quero criar meu primeiro agente. O nome será ") + nome + dgUiText_onboarding_js('. Vou preencher a função, o tom e a foto no formulário do painel. Aguarde minha confirmação em Criar meu agente.')); formulario(); }
        catch (e) { erro(e.message); bot.disabled = false; }
      };
    }
    // Só a caixa do modal rola (o chat por trás não é tocado). Chamado quando o formulário abre.
    function topoDoFormulario() { rolo.scrollTop = 0; }
    function formulario() {
      preenchendo = true; tela = 'formulario'; id = id || novoId();
      host.innerHTML = cab(dgUiText_onboarding_js("Dê um jeito só dele")) + dgUiHtml_onboarding_js("<p><!--dg-i18n:2c673f6c1e6a-->Me conte o que você quer delegar. Eu preparo o resto.<!--/dg-i18n--></p><form id=\"nasForm\">")+
        dgUiHtml_onboarding_js("<section data-tour=\"nas-nome\"><div class=\"nas-rotulo\"><label for=\"nasNomeCompleto\"><!--dg-i18n:5086900635fe-->Nome<!--/dg-i18n--></label><button type=\"button\" data-ajuda=\"[data-tour=&quot;nas-nome&quot;]\" aria-label=\"Ajuda sobre o nome\" data-dg-i18n-aria-label=\"a8c80662e5e4\">?</button></div><input id=\"nasNomeCompleto\" name=\"nome\" value=\"")+esc(nome)+dgUiHtml_onboarding_js("\" maxlength=\"70\" required><label for=\"nasDono\"><!--dg-i18n:2efcebfbf562-->Como você quer ser chamado?<!--/dg-i18n--></label><input id=\"nasDono\" name=\"dono\" maxlength=\"70\" placeholder=\"Seu nome (opcional)\" data-dg-i18n-placeholder=\"81dc4fd588ff\" autocomplete=\"given-name\"></section>")+
        dgUiHtml_onboarding_js("<section data-tour=\"nas-papel\"><div class=\"nas-rotulo\"><label for=\"nasPapel\"><!--dg-i18n:d6819dea3c72-->O que ele vai fazer por você?<!--/dg-i18n--></label><button type=\"button\" data-ajuda=\"[data-tour=&quot;nas-papel&quot;]\" aria-label=\"Ajuda sobre função e tom\" data-dg-i18n-aria-label=\"afb453e24263\">?</button></div><textarea id=\"nasPapel\" name=\"papel\" rows=\"3\" maxlength=\"700\" placeholder=\"Ex.: organizar minha agenda e me ajudar a escrever para o Instagram\" data-dg-i18n-placeholder=\"066283968049\" required></textarea><label for=\"nasTom\" title=\"O jeito de conversar que será gravado na identidade do agente\" data-dg-i18n-title=\"69a5a8976295\"><!--dg-i18n:dd8dfffc9af6-->Tom da conversa<!--/dg-i18n--></label><select id=\"nasTom\" name=\"jeito\"><option><!--dg-i18n:46a66fbd92e7-->Acolhedor e direto<!--/dg-i18n--></option><option><!--dg-i18n:03485d5e352e-->Descontraído e bem-humorado<!--/dg-i18n--></option><option><!--dg-i18n:2ad4b0d049a3-->Formal e objetivo<!--/dg-i18n--></option><option><!--dg-i18n:5d4c259e2d5a-->Paciente e didático<!--/dg-i18n--></option></select></section>")+
        dgUiHtml_onboarding_js("<section data-tour=\"nas-foto\"><div class=\"nas-rotulo\"><label for=\"nasFoto\"><!--dg-i18n:494e0843d958-->Foto<!--/dg-i18n--> <span><!--dg-i18n:83eddb5a6b9b-->(opcional)<!--/dg-i18n--></span></label><button type=\"button\" data-ajuda=\"[data-tour=&quot;nas-foto&quot;]\" aria-label=\"Ajuda sobre a foto\" data-dg-i18n-aria-label=\"b37452ceed17\">?</button></div><div class=\"nas-foto\"><div class=\"nas-avatar\" id=\"nasPrevia\" aria-label=\"Avatar neutro\" data-dg-i18n-aria-label=\"1990f4297933\">") + dsIcone('user') + dgUiHtml_onboarding_js("</div><div><input id=\"nasFoto\" type=\"file\" accept=\"image/png,image/jpeg,image/webp\"><small><!--dg-i18n:819505cf51e4-->PNG, JPEG ou WebP · até 5 MB<!--/dg-i18n--></small><button type=\"button\" id=\"nasGerarFoto\" title=\"Cria um avatar ilustrado neste navegador, sem IA e sem custo\" data-dg-i18n-title=\"4506f81c6490\"><!--dg-i18n:f145078bafc3-->Gerar avatar<!--/dg-i18n--></button></div></div></section>")+
        dgUiHtml_onboarding_js("<p class=\"nas-nota\"><!--dg-i18n:ecfd68930a29-->Ao tocar em criar, você confirma essas escolhas. Seu agente usará a mesma assinatura do Admin e vocês conversarão aqui no painel.<!--/dg-i18n--></p><button type=\"submit\" class=\"nas-principal\" data-pergunta=\"Crie meu agente com as escolhas deste formulário\"><!--dg-i18n:840b301a30b3-->Criar meu agente<!--/dg-i18n--></button></form><p class=\"nas-erro\" role=\"alert\" hidden></p>");
      abreModal();
      ligarAjuda();
      topoDoFormulario();
      host.querySelector('#nasFoto').onchange = () => {
        const f = host.querySelector('#nasFoto').files[0]; foto = null;
        const prev = host.querySelector('#nasPrevia'); prev.innerHTML = dsIcone('user');
        if (!f) return;
        if (!['image/png','image/jpeg','image/webp'].includes(f.type) || f.size > 5*1024*1024) { erro(dgUiText_onboarding_js("Escolha uma foto PNG, JPEG ou WebP de até 5 MB.")); host.querySelector('#nasFoto').value = ''; return; }
        foto = f;
        const url = URL.createObjectURL(f), img = new Image(); img.alt = 'Foto escolhida'; img.onload = () => URL.revokeObjectURL(url); img.src = url; prev.replaceChildren(img);
      };
      host.querySelector('#nasGerarFoto').onclick = () => {
        const c = document.createElement('canvas'); c.width = c.height = 320;
        const x = c.getContext('2d'), cores = [['#e1ecdc','#477553'],['#e7e2f3','#7963a7'],['#f5e3d6','#b57750'],['#dceaf3','#497c9a']];
        const cor = cores[crypto.getRandomValues(new Uint8Array(1))[0] % cores.length];
        x.fillStyle = cor[0]; x.fillRect(0,0,320,320);
        x.fillStyle = cor[1]; x.beginPath(); x.roundRect(70,82,180,158,55); x.fill();
        x.lineWidth = 9; x.strokeStyle = cor[1]; x.beginPath(); x.moveTo(160,82); x.lineTo(160,56); x.stroke();
        x.beginPath(); x.arc(160,48,13,0,Math.PI*2); x.fill();
        x.fillStyle = '#fffefa'; [125,195].forEach(v => { x.beginPath(); x.arc(v,147,17,0,Math.PI*2); x.fill(); });
        x.strokeStyle = '#fffefa'; x.lineWidth = 8; x.lineCap = 'round'; x.beginPath(); x.arc(160,175,30,.15,Math.PI-.15); x.stroke();
        x.fillStyle = cor[1]; x.beginPath(); x.roundRect(95,257,130,65,24); x.fill();
        c.toBlob(blob => {
          if (!blob || tela !== 'formulario') return;
          foto = new File([blob], 'avatar.png', { type:'image/png' });
          host.querySelector('#nasFoto').value = '';
          const img = new Image(); img.alt = 'Avatar ilustrado gerado'; img.src = c.toDataURL('image/png'); host.querySelector('#nasPrevia').replaceChildren(img);
        }, 'image/png');
      };
      host.querySelector('form').onsubmit = async ev => {
        ev.preventDefault(); const f = ev.target, bot = f.querySelector('[type=submit]'); bot.disabled = true; bot.textContent = 'Enviando suas escolhas…';
        try {
          let fotoId = null;
          if (foto) { const fd = new FormData(); fd.append('file',foto); fd.append('enviar','0'); fd.append('cliente_id',id+'-foto'); const up = await json('/api/v1/agents/'+encodeURIComponent(agente.id)+'/upload',{method:'POST',body:fd}); fotoId = up.anexo.id; }
          const pedido = { id, dono:f.elements.dono.value.trim() || undefined, nome:f.elements.nome.value.trim(), papel:f.elements.papel.value.trim().replace(/\s+/g,' '), jeito:f.elements.jeito.value, foto:fotoId };
          const d = await json('/api/v1/onboarding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pedido)});
          preenchendo = false; mostrar(d);
        } catch(e) { erro(e.message); bot.disabled = false; dgUiLabel_onboarding_js(bot, "Tentar enviar novamente", null); }
      };
    }
    // A barra tem estrutura fixa; as consultas só trocam texto e largura, sem redesenhar o cartão.
    function barraHtml() {
      return '<div class="nas-prog" data-estado="ok"><div class="nas-prog-topo"><strong class="nas-pct">0%</strong><span class="nas-etapa"></span></div>'+
        dgUiHtml_onboarding_js("<div class=\"nas-trilho\" role=\"progressbar\" aria-label=\"Andamento da criação do agente\" data-dg-i18n-aria-label=\"eedcf026b055\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"0\"><div class=\"nas-barra\"></div></div>")+
        '<div class="nas-prog-erro" role="alert" hidden><b></b><span></span></div></div>';
    }
    let ultimaBarra = '', exibido = 0, realPct = 0, proxPct = 0, temErro = false, tique = null;
    const pararTique = () => { clearInterval(tique); tique = null; };
    // Largura exibida: só cresce (ver passoOtimista). O número acompanha o exibido; 100 só com o real em 100.
    function desenhaBarra() {
      const el = host.querySelector('.nas-prog');
      if (!el) { pararTique(); return; }
      el.querySelector('.nas-barra').style.width = exibido + '%';
      el.querySelector('.nas-pct').textContent = (realPct >= 100 ? 100 : Math.min(99, Math.round(exibido))) + '%';
      el.dataset.anda = tique ? '1' : '0';
    }
    function ligaTique() {
      const anda = !temErro && realPct < 100;
      if (!anda) { pararTique(); desenhaBarra(); return; }
      if (!tique) tique = setInterval(() => { exibido = passoOtimista(exibido, realPct, proxPct); desenhaBarra(); }, 250);
      desenhaBarra();
    }
    function pintaBarra(d) {
      const pr = d.progresso, el = host.querySelector('.nas-prog');
      if (!pr || !el) return;
      realPct = Math.max(0, Math.min(100, Math.round(pr.pct || 0)));
      proxPct = typeof pr.proximo === 'number' ? pr.proximo : realPct;
      temErro = !!pr.erro;
      if (realPct > exibido) exibido = realPct;   // pula até o real; nunca volta
      const chave = JSON.stringify(pr);
      if (chave !== ultimaBarra || el.dataset.pintada !== d.id) {
        ultimaBarra = chave; el.dataset.pintada = d.id;
        const passos = pr.passo && pr.total ? ' (' + pr.passo + dgUiText_onboarding_js(" de ") + pr.total + ')' : '';
        el.dataset.estado = pr.erro ? 'erro' : 'ok';
        el.querySelector('.nas-etapa').textContent = pr.etapa + passos;
        const trilho = el.querySelector('.nas-trilho');
        // Leitor de tela recebe sempre o valor real, nunca o otimista.
        trilho.setAttribute('aria-valuenow', String(realPct));
        trilho.setAttribute('aria-valuetext', realPct + '%, ' + pr.etapa + (pr.erro ? '. Parou: ' + pr.erro.motivo : ''));
        const e = el.querySelector('.nas-prog-erro');
        e.hidden = !pr.erro;
        if (pr.erro) {
          e.querySelector('b').textContent = 'Parou nesta etapa: ' + pr.erro.motivo;
          e.querySelector('span').textContent = pr.erro.oQueFazer ? 'O que fazer: ' + pr.erro.oQueFazer : dgUiText_onboarding_js("Peça ajuda ao Admin: ele confere o registro e retoma de onde parou.");
        }
      }
      ligaTique();
    }
    function mostrar(d) { mostrarInterno(d); atualizaPilula(); }
    function mostrarInterno(d) {
      faseAtual = d.fase; comErroAtual = !!(d.progresso && d.progresso.erro); nomeAtual = d.nome || nomeAtual;
      let novos = false;
      for (const c of d.cartoes || []) if (c.id !== animando && !cartoes.has(c.id) && !dispensados.has(c.id)) { cartoes.set(c.id, c); novos = true; }
      if (novos) pedeRender();
      if (preenchendo) return;
      if (d.fase === 'pronto' && (d.cartaoDispensado || dispensados.has(d.id))) {
        encerraModal(); return;
      }
      if (d.fase === 'inativo') { encerraModal(); return; }
      if (d.fase === 'boas-vindas') { if (!tela) inicio(); return; }
      const comErro = !!(d.progresso && d.progresso.erro);
      if (d.fase === 'pronto' && d.conversa) {
        if (animando === d.id) return;
        // Criação acompanhada nesta página (havia tela de progresso): o modal mostra o estado final e fica
        // aberto até a pessoa fechar. Se a página já abriu com tudo pronto, vai direto para o histórico.
        const acompanhada = !!tela;
        if (!acompanhada) { encerraAnimacao(d, false); return; }
        // Aba oculta: a animação só toca (e só conta como vista) quando a pessoa a estiver vendo.
        if (document.visibilityState !== 'visible') { esperaVisivel = true; return; }
        esperaVisivel = false;
      }
      const assinatura = d.fase + ':' + d.id + ':' + d.mensagem + ':' + comErro;
      if (assinatura === tela) { pintaBarra(d); return; }
      tela = assinatura; ultimaBarra = '';
      const pronto = d.fase === 'pronto' && d.conversa;
      const ocupado = ['solicitado','enviando','criando','testando'].includes(d.fase);
      const tit = pronto ? dgUiText_onboarding_js("Seu agente chegou.") : d.fase === 'login' ? dgUiText_onboarding_js("Falta conectar sua assinatura") : d.fase === 'erro' || d.fase === 'erro-envio' ? 'Vamos resolver juntos' : dgUiText_onboarding_js("Um começo só seu");
      const fotoHtml = d.foto ? '<img src="'+esc(d.foto)+dgUiText_onboarding_js("\" alt=\"Foto de ")+esc(d.nome)+'">' : dgUiHtml_onboarding_js("<span aria-label=\"Avatar neutro\" data-dg-i18n-aria-label=\"1990f4297933\">") + dsIcone('user') + '</span>';
      host.innerHTML = cab(tit) + '<section data-tour="nas-estado"><div class="nas-rotulo"><span class="nas-status">'+(pronto?'PRONTO PARA CONVERSAR':ocupado?'PREPARANDO '+esc(d.nome).toUpperCase():'PRÓXIMO PASSO')+dgUiHtml_onboarding_js("</span><button type=\"button\" data-ajuda=\"[data-tour=&quot;nas-estado&quot;]\" aria-label=\"Entenda esta etapa\" data-dg-i18n-aria-label=\"9c3a82782bf0\">?</button></div><div class=\"nas-palco ")+(pronto?'nas-abriu':ocupado?'nas-gerando':'')+'" aria-hidden="true"><div class="nas-aura"></div><div class="nas-cubo"><div class="nas-face nas-frente"></div><div class="nas-face nas-lado"></div><div class="nas-face nas-tampa"></div><div class="nas-racha"></div></div></div>'+
        barraHtml()+
        (pronto?'<div class="nas-cx">'+botaoX(d.id, d.nome)+'<a class="nas-badge" href="'+esc(d.conversa)+'"><div class="nas-retrato">'+fotoHtml+dgUiHtml_onboarding_js("</div><strong><!--dg-i18n:43e6fc10226e-->Oi, eu sou<!--/dg-i18n--> ")+esc(d.nome)+dgUiHtml_onboarding_js(".</strong><span><!--dg-i18n:ebd2652d1a15-->Clique aqui pra gente começar a conversar<!--/dg-i18n--> <b aria-hidden=\"true\">") + dsIcone('external') + '</b></span></a></div>':'<p class="nas-andamento" role="status" aria-live="polite">'+esc(d.mensagem)+'</p>')+
        (d.fase==='login' && d.login?'<a class="nas-principal" href="'+esc(d.login)+dgUiHtml_onboarding_js("\" target=\"_blank\" rel=\"noopener\"><!--dg-i18n:a51542822648-->Conectar minha assinatura<!--/dg-i18n--></a><button type=\"button\" id=\"nasTestar\"><!--dg-i18n:21ce61360f8e-->Já entrei. Pode testar.<!--/dg-i18n--></button>"):'')+
        (d.fase==='erro'||d.fase==='erro-envio'||comErro?dgUiHtml_onboarding_js("<button type=\"button\" id=\"nasReparar\" class=\"nas-principal\"><!--dg-i18n:05cd628303f5-->Pedir ajuda ao Admin<!--/dg-i18n--></button>"):'')+
        '<p class="nas-erro" role="alert" hidden></p></section>';
      pintaBarra(d);
      // A chegada do agente abre o modal mesmo minimizado: quem criou pela conversa fechou a janela para
      // escrever ao Admin, e sem isto a animação tocaria escondida, só com a pílula no canto.
      if (pronto) minimizado = false;
      abreModal();
      ligarAjuda();
      const teste = host.querySelector('#nasTestar');
      if (teste) teste.onclick = async () => { teste.disabled = true; try { await enviar(dgUiText_onboarding_js("Já entrei com minha assinatura. Pode testar meu agente e concluir a criação pelo formulário.")); teste.textContent='Avisei o Admin. Aguarde o teste.'; } catch(e) { erro(e.message); teste.disabled=false; } };
      const reparar = host.querySelector('#nasReparar');
      if (reparar) reparar.onclick = async () => { reparar.disabled=true; try { await enviar(dgUiText_onboarding_js("Preciso de ajuda para continuar a criação do meu agente pelo formulário. Pode conferir o que aconteceu e retomar?")); reparar.textContent='Avisei o Admin'; } catch(e) {erro(e.message); reparar.disabled=false;} };
      // sem rolar aqui: esta tela é refeita a cada novidade do Admin, e puxar a página para o topo dela
      // a cada atualização fazia a conversa pular para cima. O fim é seguido por quem já estava no fim.
      if (pronto) {
        document.body.classList.remove('admin-primeiro-acesso');
        host.querySelector('.nas-badge').addEventListener('click', () => { try { sessionStorage.setItem('dgclaw-agente-novo', d.conversa.split('/').pop()); } catch (_) { /* sem sessionStorage (navegação privada ou bloqueado): só não guarda a marca de agente novo */ } });
        animando = d.id; finalDe = d; marcarVista(d.id);
        host.querySelector('.nas-badge').setAttribute('aria-label', 'Oi, eu sou '+d.nome+dgUiText_onboarding_js('. Clique aqui pra gente começar a conversar'));
      }
    }
    let timer = null, rodando = false, ultimaFase = '';
    // Mais rápido enquanto algo está sendo criado; devagar quando só espera a pessoa; para no pronto.
    const ritmo = f => ['enviando','solicitado','criando','testando'].includes(f) ? 1500 : 6000;
    function agendar() { clearTimeout(timer); if (ultimaFase !== 'pronto') timer = setTimeout(atualizar, ritmo(ultimaFase)); }
    async function atualizar() {
      if (rodando) return;
      if (document.hidden) { agendar(); return; }
      rodando = true;
      try { const d = await json('/api/v1/onboarding'); ultimaFase = d.fase; mostrar(d); }
      catch(e) { if (!temConteudo()) { host.innerHTML=cab(dgUiText_onboarding_js("Vamos começar"))+'<p class="nas-erro" role="alert"></p>'; host.querySelector('.nas-tutorial').onclick=()=>tutorial(); abreModal(); } erro(e.message); }
      finally { rodando = false; agendar(); }
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && (ultimaFase !== 'pronto' || esperaVisivel)) atualizar(); });
    atualizar();
    window.addEventListener('pagehide',()=>clearTimeout(timer),{once:true});
  }
  const botaoX = (id, nome) => '<button type="button" class="nas-x" data-dispensar="' + esc(id) + '" aria-label="' + esc(dgUiText_onboarding_js("Dispensar o cartão de ") + nome) + '">' + dsIcone('x') + '</button>';
  function htmlCartao(c) {
    const retrato = c.foto ? '<img src="' + esc(c.foto) + dgUiText_onboarding_js("\" alt=\"Foto de ") + esc(c.nome) + '" loading="lazy">' : dgUiHtml_onboarding_js("<span aria-label=\"Avatar neutro\" data-dg-i18n-aria-label=\"1990f4297933\">") + dsIcone('user') + '</span>';
    const miolo = '<div class="nas-retrato">' + retrato + '</div><strong>' + esc(c.nome) + dgUiText_onboarding_js(" nasceu às ") + esc(c.hhmm) + '</strong>' +
      (c.conversa ? dgUiHtml_onboarding_js("<span><!--dg-i18n:68c9e0bb50ee-->Clique aqui pra conversar com<!--/dg-i18n--> ") + esc(c.nome) + ' <b aria-hidden="true">' + dsIcone('external') + '</b></span>' : '');
    return '<div class="nas-hist" data-msg="' + esc('nasc-' + c.id) + '"><div class="nas-cx">' + botaoX(c.id, c.nome) + (c.conversa ? '<a class="nas-badge" href="' + esc(c.conversa) + '">' + miolo + '</a>' : '<div class="nas-badge">' + miolo + '</div>') + '</div></div>';
  }
  /* Texto da pílula que aparece com o modal minimizado (função pura, testada sem DOM). */
  function textoPilula({ tela, fase, nome, comErro } = {}) {
    const n = String(nome || '').trim();
    if (['inicio', 'boas-vindas', 'formulario'].includes(tela) || !fase) return dgUiText_onboarding_js("Continuar a criação do agente");
    if (fase === 'pronto') return (n || dgUiText_onboarding_js("Seu agente")) + dgUiText_onboarding_js(" está pronto. Ver");
    if (comErro || fase === 'erro' || fase === 'erro-envio') return dgUiText_onboarding_js("A criação ") + (n ? dgUiText_onboarding_js("do ") + n : dgUiText_onboarding_js("do agente")) + dgUiText_onboarding_js(" parou. Ver");
    return n ? 'Criando o ' + n + dgUiText_onboarding_js("… ver") : dgUiText_onboarding_js("Criando seu agente… ver");
  }
  /* O texto do Admin traz [ver a criação]; já escapado, vira um botão que reabre o modal. */
  const MARCADOR = /\[ver a criação\]/g;
  const BOTAO_REABRIR = dgUiHtml_onboarding_js("<button type=\"button\" class=\"nas-reabrir\" data-abrir-criacao><!--dg-i18n:55d014303086-->Fechou sem querer? Toque aqui para ver a criação<!--/dg-i18n--></button>");
  function marcadorParaBotao(htmlSeguro) { return String(htmlSeguro).replace(MARCADOR, BOTAO_REABRIR); }
  /* Barra otimista: o valor exibido anda sozinho do real rumo ao próximo marco, sem nunca voltar,
     sem passar do teto (real + 92% do caminho até o próximo) e sem chegar a 100 antes do real. */
  function passoOtimista(exibido, real, proximo, fracao) {
    const r = Math.max(0, Math.min(100, Number(real) || 0));
    let e = Number(exibido); if (!isFinite(e)) e = 0;
    if (r >= 100) return 100;
    const p = Math.max(r, Math.min(100, Number(proximo) || r));
    const teto = Math.min(99.9, r + 0.92 * (p - r));
    if (r > e) e = r;                       // o real passou do exibido: salta até ele
    if (e >= teto) return e;                // parado: nunca volta
    return Math.min(teto, e + (teto - e) * (fracao == null ? 0.04 : fracao));
  }
  const api = { iniciar, htmlCartao, textoPilula, marcadorParaBotao, passoOtimista };
  if (typeof window !== 'undefined') window.DGOnboarding = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
