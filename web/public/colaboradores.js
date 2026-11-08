'use strict';
/* colaboradores.js: a tela /colaboradores, só do dono. Convida, reenvia e revoga o colaborador de um agente.
   Consome só a API (GET/POST /api/v1/colaboradores, POST .../reenviar, DELETE .../<id>): contrato em
   web/docs/COLABORADORES.md. Todo texto que vem do servidor entra com textContent. */
(function () {
  const $ = id => document.getElementById(id);
  const est = { agentes: [], colabs: [], agente: null };

  const ROTULO = {
    aguardando_primeiro_acesso: ['Aguardando o primeiro acesso', 'espera'],
    ativo: ['Ativo', 'ativo'],
    temporaria_vencida: ['Senha temporária vencida', 'espera'],
    revogado: ['Acesso revogado', 'revogado'],
  };

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  const quando = ms => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const nomeDoAgente = slug => { const a = est.agentes.find(x => x.id === slug); return a ? a.nome : slug; };

  function mostraErro(texto) {
    const e = $('coMsg');
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  async function chama(metodo, url, corpo) {
    let r;
    try {
      r = await fetch(url, {
        method: metodo, cache: 'no-store', credentials: 'same-origin',
        headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined,
      });
    } catch (e) {
      throw new Error('Não consegui falar com o servidor (' + e.message + '). Confira a internet e tente de novo.');
    }
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Sua sessão acabou. Entre de novo.'); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('O servidor respondeu ' + r.status + '. Tente de novo; se repetir, veja o log do Web.'));
    return d;
  }

  /* ── Convite gerado ─────────────────────────────────────────────────────── */
  function mostraConvite(c, colab) {
    const st = $('coEmailStatus');
    if (c.email_enviado) {
      st.textContent = 'O e-mail foi enviado para ' + colab.email + '. Se ele não chegar, mande o texto abaixo por WhatsApp.';
      st.className = 'co-status ok';
    } else {
      st.textContent = 'O e-mail não saiu: ' + (c.email_motivo || 'motivo não informado') + ' Mande o texto abaixo por WhatsApp ou outro meio.';
      st.className = 'co-status falha';
    }
    $('coTexto').value = c.texto;
    $('coCopiaMsg').hidden = true;
    $('coConvite').hidden = false;
    $('coConvite').scrollIntoView({ block: 'nearest' });
  }

  async function copia() {
    const m = $('coCopiaMsg');
    m.hidden = false; m.className = 'co-msg';
    try {
      await navigator.clipboard.writeText($('coTexto').value);
      m.textContent = 'Texto copiado.'; m.classList.add('ok');
    } catch (e) {
      $('coTexto').focus(); $('coTexto').select();
      m.textContent = 'O navegador não deixou copiar sozinho (' + ((e && e.message) || 'sem permissão') + '). O texto ficou selecionado: toque e segure para copiar.';
      m.classList.add('erro');
    }
  }

  /* ── Seção do agente escolhido ──────────────────────────────────────────── */
  function desenhaAgente() {
    const corpo = $('coCorpoAgente');
    $('coNomeAgente').textContent = est.agente ? nomeDoAgente(est.agente) : 'um agente';
    if (!est.agente) { corpo.replaceChildren(el('p', 'co-fraco', 'Ainda não há agente de trabalho para convidar alguém. Peça ao Admin para criar o primeiro.')); return; }
    const atual = est.colabs.find(c => c.agente === est.agente && c.estado !== 'revogado');
    if (!atual) { corpo.replaceChildren(formulario()); return; }
    corpo.replaceChildren(cartaoAtual(atual));
  }

  function formulario() {
    const f = el('form', 'co-form');
    f.setAttribute('data-tour', 'co-form');
    f.autocomplete = 'off';
    const campo = (rotulo, id, tipo, extra) => {
      const l = el('label', 'co-campo', rotulo);
      const i = document.createElement('input');
      i.id = id; i.type = tipo; Object.assign(i, extra || {});
      l.append(i);
      return [l, i];
    };
    const [lMail, iMail] = campo('E-mail do colaborador', 'coEmail', 'email', { required: true, maxLength: 254, autocapitalize: 'none', spellcheck: false });
    iMail.setAttribute('inputmode', 'email');
    const [lNome, iNome] = campo('Nome (opcional)', 'coNome', 'text', { maxLength: 80 });
    const b = el('button', 'co-btn co-pri', 'Convidar');
    b.type = 'submit';
    f.append(el('p', 'co-fraco', 'Este agente ainda não tem colaborador. A pessoa recebe um e-mail com o link, o login e uma senha temporária.'), lMail, lNome, b);
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      mostraErro('');
      b.disabled = true; b.textContent = 'Convidando…';
      try {
        const d = await chama('POST', '/api/v1/colaboradores', { agente: est.agente, email: iMail.value, nome: iNome.value });
        await carrega();
        mostraConvite(d.convite, d.colaborador);
      } catch (e) { mostraErro(e.message); }
      finally { b.disabled = false; b.textContent = 'Convidar'; }
    });
    return f;
  }

  function fato(dl, nome, valor) {
    if (!valor) return;
    const d = el('div', 'co-fato');
    d.append(el('dt', '', nome), el('dd', '', valor));
    dl.append(d);
  }

  function cartaoAtual(c) {
    const box = el('div', 'co-atual');
    box.setAttribute('data-tour', 'co-atual');
    const [rot, cls] = ROTULO[c.estado] || [c.estado, ''];
    const h = el('h3', '', c.nome || c.email);
    h.append(el('span', 'co-tag ' + cls, rot));
    const dl = el('dl', 'co-fatos');
    fato(dl, 'E-mail', c.email);
    fato(dl, 'Convidado em', quando(c.criado_em));
    fato(dl, 'Último acesso', c.ultimo_login ? quando(c.ultimo_login) : 'ainda não entrou');
    if (c.estado === 'aguardando_primeiro_acesso') fato(dl, 'Senha temporária', 'vale até ' + quando(c.temporaria_expira));
    if (c.estado === 'temporaria_vencida') fato(dl, 'Senha temporária', 'venceu em ' + quando(c.temporaria_expira) + '. Mande o convite de novo.');
    const acoes = el('div', 'co-acoes');
    const reenviar = el('button', 'co-btn', 'Mandar convite de novo');
    reenviar.type = 'button';
    reenviar.addEventListener('click', () => reenvia(c, reenviar));
    const revogar = el('button', 'co-btn co-perigo', 'Revogar acesso');
    revogar.type = 'button';
    revogar.addEventListener('click', () => confirmaRevogar(c, acoes, revogar));
    acoes.append(reenviar, revogar);
    box.append(h, dl, acoes);
    return box;
  }

  async function reenvia(c, btn) {
    mostraErro('');
    btn.disabled = true; btn.textContent = 'Gerando…';
    try {
      const d = await chama('POST', '/api/v1/colaboradores/' + encodeURIComponent(c.id) + '/reenviar');
      await carrega();
      mostraConvite(d.convite, d.colaborador);
    } catch (e) { mostraErro(e.message); btn.disabled = false; btn.textContent = 'Mandar convite de novo'; }
  }

  /* Duas etapas: o primeiro toque pede a confirmação, o segundo revoga. */
  function confirmaRevogar(c, acoes, btn) {
    btn.textContent = 'Confirmar: revogar agora';
    btn.classList.add('co-confirma');
    const cancela = el('button', 'co-btn', 'Cancelar');
    cancela.type = 'button';
    cancela.addEventListener('click', () => desenhaAgente());
    acoes.append(cancela);
    btn.onclick = async () => {
      mostraErro('');
      btn.disabled = true; cancela.disabled = true; btn.textContent = 'Revogando…';
      try {
        await chama('DELETE', '/api/v1/colaboradores/' + encodeURIComponent(c.id));
        $('coConvite').hidden = true;
        await carrega();
      } catch (e) { mostraErro(e.message); btn.disabled = false; cancela.disabled = false; btn.textContent = 'Confirmar: revogar agora'; }
    };
  }

  /* ── Lista de todos ─────────────────────────────────────────────────────── */
  function desenhaLista() {
    const caixa = $('coCartoes');
    if (!est.colabs.length) { caixa.replaceChildren(el('p', 'co-fraco', 'Ninguém foi convidado ainda.')); return; }
    caixa.replaceChildren(...est.colabs.map(c => {
      const card = el('div', 'co-card');
      const [rot, cls] = ROTULO[c.estado] || [c.estado, ''];
      const h = el('h3', '', c.nome ? c.nome + ' (' + c.email + ')' : c.email);
      h.append(el('span', 'co-tag ' + cls, rot));
      const dl = el('dl', 'co-fatos');
      fato(dl, 'Agente', nomeDoAgente(c.agente));
      fato(dl, 'Convidado em', quando(c.criado_em));
      fato(dl, 'Último acesso', c.ultimo_login ? quando(c.ultimo_login) : 'ainda não entrou');
      if (c.revogado_em) fato(dl, 'Revogado em', quando(c.revogado_em));
      card.append(h, dl);
      return card;
    }));
  }

  async function carrega() {
    const d = await chama('GET', '/api/v1/colaboradores');
    est.colabs = d.colaboradores;
    desenhaAgente();
    desenhaLista();
  }

  async function inicia() {
    try {
      const d = await chama('GET', '/api/v1/agents');
      est.agentes = d.agentes;
    } catch (e) { mostraErro('Não consegui carregar a lista de agentes. ' + e.message); $('coCorpoAgente').replaceChildren(); return; }
    const trabalho = est.agentes.filter(a => a.tipo !== 'admin');
    const sel = $('coSeletor');
    sel.replaceChildren(...trabalho.map(a => { const o = el('option', '', a.nome); o.value = a.id; return o; }));
    const pedido = new URLSearchParams(location.search).get('agente');
    if (pedido && !trabalho.some(a => a.id === pedido)) {
      mostraErro(pedido === 'admin' || est.agentes.some(a => a.id === pedido && a.tipo === 'admin')
        ? 'O Admin nunca pode ser compartilhado: ele mexe no servidor inteiro. Escolha um agente de trabalho.'
        : 'Não existe o agente "' + pedido.slice(0, 40) + '". Escolha um da lista.');
    }
    est.agente = trabalho.some(a => a.id === pedido) ? pedido : (trabalho[0] ? trabalho[0].id : null);
    if (est.agente) sel.value = est.agente;
    sel.hidden = trabalho.length < 2;
    sel.parentElement.hidden = trabalho.length < 2;
    sel.addEventListener('change', () => { est.agente = sel.value; $('coConvite').hidden = true; mostraErro(''); history.replaceState(null, '', '/colaboradores?agente=' + encodeURIComponent(est.agente)); desenhaAgente(); });
    try { await carrega(); } catch (e) { mostraErro('Não consegui carregar os colaboradores. ' + e.message); $('coCorpoAgente').replaceChildren(); $('coCartoes').replaceChildren(); }
  }

  $('coCopiar').addEventListener('click', copia);
  $('coFechaConvite').addEventListener('click', () => { $('coConvite').hidden = true; $('coTexto').value = ''; });

  /* ── Tutorial ───────────────────────────────────────────────────────────── */
  const PASSOS = {
    agente: [
      { alvo: '#coAgente', titulo: 'O colaborador deste agente',
        oque: 'Quem você convidou para usar este agente. Cada agente tem um colaborador por vez, e cada pessoa acessa um agente só.',
        como: 'Sem ninguém convidado, a tela mostra o formulário. Com alguém convidado, mostra o estado dele (aguardando o primeiro acesso, ativo) e os botões para mandar o convite de novo ou revogar o acesso.',
        porque: 'A pessoa usa este agente por inteiro: a conversa, as sessões, as rotinas, a memória, os arquivos e a Tela. Não vê o Admin nem outros agentes, e o cofre, as chaves de API, a troca da conta de IA, as credenciais dos canais e a senha da Tela continuam com você.' },
      { alvo: '[data-tour="co-form"]', titulo: 'Convidar',
        oque: 'O e-mail da pessoa (que será o login dela) e, se quiser, o nome.',
        como: 'Ao tocar em Convidar, o DG Claw gera uma senha temporária que vale 7 dias e tenta mandar um e-mail com o link. No primeiro acesso a pessoa cria a senha dela.',
        porque: 'O e-mail só sai se o servidor de e-mail estiver configurado (opcional). Se não estiver, a tela mostra o texto pronto para você mandar por WhatsApp.' },
      { alvo: '[data-tour="co-atual"]', titulo: 'Convite de novo e revogar',
        oque: 'Os dois botões do colaborador atual.',
        como: 'Mandar convite de novo gera outra senha temporária e derruba as sessões abertas dele. Revogar acesso encerra tudo na hora, e o registro continua na lista, com a data.',
        porque: 'Serve para quando a pessoa perdeu a senha ou quando o acesso dela precisa acabar.' },
    ],
    convite: [
      { alvo: '#coConvite', titulo: 'O convite pronto',
        oque: 'O resultado do convite: se o e-mail saiu e o texto da mensagem, com o link, o login e a senha temporária.',
        como: 'Copie o texto e mande por WhatsApp se o e-mail não saiu ou não chegou. A senha temporária aparece só nesta tela, agora.',
        porque: 'O servidor guarda só um resumo da senha, que não dá para ler de volta. Perdeu o texto? Use Mandar convite de novo.' },
    ],
    lista: [
      { alvo: '#coLista', titulo: 'Todos os colaboradores',
        oque: 'Todo mundo que já foi convidado, de todos os agentes, inclusive os acessos revogados.',
        como: 'Cada cartão mostra o agente, o estado, quando a pessoa foi convidada e entrou pela última vez, e a data da revogação, se houve.',
        porque: 'Fica o histórico de quem já teve acesso a quê, sem apagar nada.' },
    ],
  };
  function comTour(passos) {
    if (!window.DGTour) { mostraErro('A visita guiada não carregou. Recarregue a página e tente de novo.'); return; }
    window.DGTour.inicia({ passos: passos.filter(p => { const e = document.querySelector(p.alvo); return e && e.offsetParent !== null; }) });
  }
  function tutorial() { comTour([].concat(PASSOS.agente, PASSOS.convite, PASSOS.lista)); }
  document.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-co="ajuda"]');
    if (b) { ev.preventDefault(); comTour(PASSOS[b.dataset.secao] || []); }
  });

  window.DGCasca.monta({ pagina: 'colaboradores', titulo: 'Colaboradores', aoTutorial: tutorial });
  inicia();
})();
