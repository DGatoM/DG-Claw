'use strict';
/* integracoes-faixa.js: a faixa vermelha "integração com defeito" no alto das telas.

   Lê GET /api/v1/integracoes ao carregar, a cada 5 minutos e quando a aba volta ao foco. Só aparece quando o
   servidor devolve incidentes na faixa. Resposta 403 (colaborador) ou erro de rede não mostra nada.
   Botões: "Pedir ao Admin para verificar" (leva ao chat do Admin com o pedido escrito, SEM enviar),
   "Ver detalhes" (uma integração: abre o painel do agente na aba Integrações; várias: abre a lista) e
   "Lembrar em 1 hora". Na lista, cada linha tem o link para o painel e "Silenciar esta integração".
   Tudo que vem da API entra na tela por textContent (nunca por innerHTML).
   Contrato das rotas: web/docs/INTEGRACOES.md. As funções que só montam texto ficam fora do DOM e têm teste
   em web/test/integracoes-faixa.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGIntegracoesFaixa = m;
})(this, function (raiz) {
  const dgIntT = fonte => raiz.DGI18n ? raiz.DGI18n.t(fonte) : fonte;
  const dgIntF = (fonte, valores) => raiz.DGI18n ? raiz.DGI18n.frase(fonte, valores) : fonte.replace(/\{([a-z_]+)\}/g, (m,k) => String(valores[k]));
  const POLL_MS = 5 * 60 * 1000;
  const RX_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

  /* A frase da faixa: uma integração por extenso, várias em resumo. */
  function textoDaFaixa(faixa) {
    const lista = Array.isArray(faixa) ? faixa : [];
    if (!lista.length) return '';
    if (lista.length > 1) return dgIntT('Várias integrações estão com defeito.');
    const i = lista[0];
    return dgIntF('A integração {integracao} do agente {agente} está com defeito: {categoria}.', { integracao: i.integracaoNome, agente: i.agenteNome, categoria: i.categoriaTexto });
  }

  /* Uma linha da lista de detalhes (várias integrações). */
  function textoDaLinha(item) {
    return dgIntF('{integracao} (agente {agente}): {categoria}.', { integracao: item.integracaoNome, agente: item.agenteNome, categoria: item.categoriaTexto });
  }

  /* Uma linha por agente cujas integrações não deu para medir (o motivo é texto fixo do servidor). */
  function textoNaoMedido(n) {
    const nome = n && (n.agenteNome || n.agente) ? (n.agenteNome || n.agente) : dgIntT('um agente');
    return dgIntF('Não consegui medir as integrações de {nome}: {motivo}', { nome, motivo: n && n.motivo ? n.motivo : dgIntT('sem motivo informado') });
  }

  /* Endereço do painel do agente já na aba Integrações; slug fora do formato não gera link. */
  function hrefPainel(slug) {
    return typeof slug === 'string' && RX_ID.test(slug) ? '/p/' + slug + '/#aba=integracoes' : null;
  }

  const PASSO = {
    alvo: '#faixaIntegracoes',
    titulo: 'Aviso de integração com defeito',
    oque: 'Um aviso de que uma integração de algum agente (WhatsApp, Instagram, uma chave de IA e outras) está com defeito.',
    como: 'Cada agente anota o resultado de cada uso real de um sistema externo. Quando os últimos resultados mostram a chave recusada, o saldo acabando, o sistema fora do ar ou a conexão caída, e houve uso nos últimos 7 dias, a integração fica vermelha e esta faixa aparece. Ela some sozinha quando a integração volta a funcionar.',
    porque: 'Para você saber na hora, sem abrir cada agente, e pedir ao Admin para verificar. Nada é consertado sozinho. Lembrar em 1 hora esconde o aviso por uma hora.',
  };

  if (!raiz.document) return { textoDaFaixa, textoDaLinha, textoNaoMedido, hrefPainel, PASSO, POLL_MS };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let faixa = null;
  let atual = null;
  let ocupado = false;
  const pendentes = new Set();
  let ultimoErro = '';
  const chaveDoPost = (caminho, corpo) => caminho + '|' + JSON.stringify(corpo || {});
  function atualizaBotoesPendentes() {
    if (!faixa) return;
    for (const b of faixa.querySelectorAll('button[data-if]')) {
      if (b.dataset.if === 'lembrar') b.disabled = pendentes.has(chaveDoPost('/api/v1/integracoes/lembrar', {}));
      else if (b.dataset.if === 'silenciar') b.disabled = pendentes.has(chaveDoPost('/api/v1/integracoes/silenciar', { agente: b.dataset.agente, integracao: b.dataset.integracao }));
    }
  }

  function garanteCss() {
    if (document.querySelector('link[href="/integracoes-faixa.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/integracoes-faixa.css';
    document.head.appendChild(l);
  }

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function botao(rotulo, acao, classe) {
    const b = el('button', 'if-btn' + (classe ? ' ' + classe : ''), rotulo);
    b.type = 'button';
    b.dataset.if = acao;
    return b;
  }

  function garanteFaixa() {
    if (faixa) return;
    garanteCss();
    faixa = el('section', 'if');
    faixa.id = 'faixaIntegracoes';
    faixa.setAttribute('role', 'alert');
    faixa.setAttribute('aria-label', dgIntT('Integração com defeito'));
    faixa.hidden = true;
    const cab = document.querySelector('header');
    if (cab && cab.parentNode) cab.parentNode.insertBefore(faixa, cab.nextSibling);
    else document.body.insertBefore(faixa, document.body.firstChild);
    faixa.addEventListener('click', aoClicar);
  }

  function mostraErro(texto) {
    ultimoErro = texto || '';
    const e = faixa && faixa.querySelector('.if-erro');
    if (!e) return;
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  function linhaDetalhe(item) {
    const li = el('li', 'if-item');
    li.appendChild(el('span', 'if-item-txt', textoDaLinha(item)));
    const href = hrefPainel(item.agente);
    if (href) {
      const a = el('a', 'if-link', dgIntT('Ver detalhes'));
      a.href = href;
      li.appendChild(a);
    }
    const s = botao(dgIntT('Silenciar esta integração'), 'silenciar', 'if-silenciar');
    s.dataset.agente = item.agente;
    s.dataset.integracao = item.integracao;
    li.appendChild(s);
    return li;
  }

  function monta(estado) {
    const lista = estado.faixa;
    faixa.textContent = '';
    const linha = el('div', 'if-linha');
    const tit = el('span', 'if-tit');
    const ico = el('span', 'if-ico');
    ico.setAttribute('aria-hidden', 'true');
    ico.innerHTML = dsIcone('alert');   // HTML fixo do próprio sistema de ícones, sem dado da API
    tit.appendChild(ico);
    tit.appendChild(document.createTextNode(' ' + textoDaFaixa(lista)));
    linha.appendChild(tit);
    const acoes = el('span', 'if-acoes');
    acoes.appendChild(botao(dgIntT('Pedir ao Admin para verificar'), 'pedir', 'if-pedir'));
    if (lista.length === 1) {
      const href = hrefPainel(lista[0].agente);
      if (href) {
        const a = el('a', 'if-btn', dgIntT('Ver detalhes'));
        a.href = href;
        acoes.appendChild(a);
      }
    } else {
      const v = botao(dgIntT('Ver detalhes'), 'ver');
      v.setAttribute('aria-expanded', 'false');
      v.setAttribute('aria-controls', 'faixaIntegracoesLista');
      acoes.appendChild(v);
    }
    acoes.appendChild(botao(dgIntT('Lembrar em 1 hora'), 'lembrar'));
    const aj = botao('?', 'ajuda', 'if-ajuda');
    aj.setAttribute('aria-label', dgIntT('Tutorial da faixa de integração com defeito'));
    aj.title = dgIntT('O que é esta faixa');
    acoes.appendChild(aj);
    linha.appendChild(acoes);
    faixa.appendChild(linha);
    if (lista.length > 1) {
      const ul = el('ul', 'if-lista');
      ul.id = 'faixaIntegracoesLista';
      ul.hidden = true;
      for (const i of lista) ul.appendChild(linhaDetalhe(i));
      faixa.appendChild(ul);
    }
    const erro = el('p', 'if-erro');
    erro.setAttribute('role', 'alert');
    erro.hidden = true;
    faixa.appendChild(erro);
    mostraErro(ultimoErro);
    atualizaBotoesPendentes();
  }

  /* Linhas discretas dos agentes que não deu para medir, mesmo sem nenhum incidente. Só textContent. */
  let naoMedidosEl = null;
  function pintaNaoMedidos(estado) {
    const lista = estado && Array.isArray(estado.naoMedidos) ? estado.naoMedidos : [];
    if (!lista.length) {
      if (naoMedidosEl) { naoMedidosEl.hidden = true; naoMedidosEl.textContent = ''; }
      return;
    }
    if (!naoMedidosEl) {
      garanteCss();
      naoMedidosEl = el('section', 'if-nm');
      naoMedidosEl.id = 'faixaIntegracoesNaoMedidas';
      naoMedidosEl.setAttribute('aria-label', dgIntT('Integrações que não deu para medir'));
      const ancora = faixa || document.querySelector('header');
      if (ancora && ancora.parentNode) ancora.parentNode.insertBefore(naoMedidosEl, ancora.nextSibling);
      else document.body.insertBefore(naoMedidosEl, document.body.firstChild);
    }
    naoMedidosEl.textContent = '';
    for (const n of lista.slice(0, 20)) naoMedidosEl.appendChild(el('p', 'if-nm-linha', textoNaoMedido(n)));
    naoMedidosEl.hidden = false;
  }

  function pinta(estado) {
    pintaNaoMedidos(estado);
    if (!estado || !Array.isArray(estado.faixa) || !estado.faixa.length) {
      if (faixa) { faixa.hidden = true; faixa.textContent = ''; }
      atual = null;
      return;
    }
    garanteFaixa();
    atual = estado;
    const aberta = faixa.querySelector('.if-lista') && !faixa.querySelector('.if-lista').hidden;
    monta(estado);
    if (aberta) {
      const ul = faixa.querySelector('.if-lista');
      if (ul) { ul.hidden = false; faixa.querySelector('[data-if="ver"]').setAttribute('aria-expanded', 'true'); }
    }
    faixa.hidden = false;
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      let r;
      try { r = await fetch('/api/v1/integracoes', { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { return; }
      if (!r.ok) {
        if (r.status !== 401 && r.status !== 403) console.warn('integracoes-faixa: o servidor respondeu ' + r.status + ' em /api/v1/integracoes; sigo sem a faixa.');
        pinta(null);
        return;
      }
      let json = null;
      try { json = await r.json(); } catch (e) { console.warn('integracoes-faixa: a resposta não veio em JSON:', e.message); return; }
      pinta(json);
    } finally { ocupado = false; }
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => mostraErro(dgIntT('A visita guiada não carregou. Recarregue a página e tente de novo.'));
    document.head.appendChild(s);
  }

  /* Escreve o pedido no campo do Admin (sem enviar); quem faz isso é o mesmo atalho da faixa de atualização. */
  function pedirAoAdmin() {
    if (!atual || typeof atual.pedido !== 'string' || !atual.pedido) { mostraErro(dgIntT('O servidor não trouxe o texto do pedido. Atualize a página e tente de novo.')); return; }
    if (raiz.DGAtualizacaoFaixa && typeof raiz.DGAtualizacaoFaixa.instalar === 'function') { raiz.DGAtualizacaoFaixa.instalar(atual.pedido); return; }
    mostraErro(dgIntT('Não consegui abrir a conversa com o Admin (o atalho não carregou). Recarregue a página e tente de novo.'));
  }

  async function postar(caminho, corpo, botaoClicado) {
    const chave = chaveDoPost(caminho, corpo);
    if (pendentes.has(chave)) return false;
    pendentes.add(chave);
    if (botaoClicado) botaoClicado.disabled = true;
    let r; let json = null;
    try {
      r = await fetch(caminho, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
      try { json = await r.json(); } catch (e) { json = null; }
    } catch (e) {
      pendentes.delete(chave);
      atualizaBotoesPendentes();
      if (botaoClicado) botaoClicado.disabled = false;
      mostraErro(dgIntF('Não consegui falar com o servidor ({erro}). Confira a conexão e toque de novo.', { erro: e.message }));
      return false;
    }
    pendentes.delete(chave);
    atualizaBotoesPendentes();
    if (!r.ok) {
      if (botaoClicado) botaoClicado.disabled = false;
      mostraErro((json && json.erro) || (dgIntF('O servidor respondeu {status}. Atualize a página e tente de novo.', { status: r.status })));
      return false;
    }
    return true;
  }

  function aoClicar(ev) {
    const b = ev.target.closest('button[data-if]');
    if (!b) return;
    const acao = b.dataset.if;
    if (acao === 'pedir') pedirAoAdmin();
    else if (acao === 'ver') {
      const ul = faixa.querySelector('.if-lista');
      ul.hidden = !ul.hidden;
      b.setAttribute('aria-expanded', String(!ul.hidden));
    } else if (acao === 'lembrar') postar('/api/v1/integracoes/lembrar', {}, b).then(ok => { if (ok) pinta(null); });
    else if (acao === 'silenciar') postar('/api/v1/integracoes/silenciar', { agente: b.dataset.agente, integracao: b.dataset.integracao }, b).then(ok => { if (ok) atualiza(); });
    else if (acao === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: [PASSO] }));
  }

  function inicia() {
    atualiza();
    setInterval(atualiza, POLL_MS);
    raiz.addEventListener('dgclaw:idioma', () => {
      if (faixa) faixa.setAttribute('aria-label', dgIntT('Integração com defeito'));
      if (naoMedidosEl) naoMedidosEl.setAttribute('aria-label', dgIntT('Integrações que não deu para medir'));
      if (atual) pinta(atual);
      atualiza();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  // Integrações de todos os agentes: só o dono.
  if (raiz.DGPapel && raiz.DGPapel.colaborador) return { textoDaFaixa, textoDaLinha, textoNaoMedido, hrefPainel, PASSO, POLL_MS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { textoDaFaixa, textoDaLinha, textoNaoMedido, hrefPainel, PASSO, POLL_MS, atualiza };
});
