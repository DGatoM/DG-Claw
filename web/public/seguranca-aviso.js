'use strict';
/* seguranca-aviso.js: o "Aviso de segurança" do painel (janela + selo).

   Lê GET /api/v1/seguranca/boletins ao carregar, a cada 30 minutos e quando a aba volta ao foco. Se algum boletim
   tem mostrar_modal, abre uma janela com ele (um por vez, o mais grave primeiro). Enquanto houver boletim pendente
   e não dispensado, um selo discreto fica no alto das telas e reabre a janela.
   Botões: "Atualizar" (leva ao chat do Admin com o pedido já escrito, pela mesma função do botão Instalar da faixa
   de nova versão, SEM enviar), "Lembrar depois" (esconde a janela por 24 h) e, nos avisos sem correção ainda,
   "Entendi". Tudo que vem da API nasceu no GitHub: passa por esc() antes de virar HTML, e link só se for https://.
   Falha ao buscar os boletins nunca derruba a tela. Contrato: web/docs/SEGURANCA-BOLETINS.md. As funções que só
   montam texto e HTML ficam fora do DOM e têm teste em web/test/seguranca-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGSegurancaAviso = m;
})(this, function (raiz) {
  const POLL_MS = 30 * 60 * 1000;
  const QUARENTA_E_OITO_H = 48 * 3600 * 1000;
  const API = '/api/v1/seguranca/boletins';
  const FUSO = 'America/Sao_Paulo';
  const GRAVIDADE = { CRITICAL: 'Crítica', HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };
  const PESO = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ehHttps = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);

  function dataBr(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return 'data não informada';
    return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(t));
  }

  function gravidadeRotulo(sev) { return GRAVIDADE[sev] || 'Não informada'; }

  /* "Nas últimas horas" quando a falha foi publicada há menos de 48 h; senão "Em 21/10/2026". */
  function abertura(publicadoEm, agora) {
    const t = Date.parse(publicadoEm);
    const ref = typeof agora === 'number' ? agora : Date.now();
    if (!Number.isNaN(t) && ref - t < QUARENTA_E_OITO_H) return 'Nas últimas horas';
    return 'Em ' + dataBr(publicadoEm);
  }

  function temCorrecaoParaAplicar(b) { return b.acao === 'atualizar-dgclaw' || b.acao === 'atualizar-sistema'; }

  /* Texto corrido da janela, em texto puro (quem desenha escapa). */
  function textoPrincipal(b, agora) {
    const ini = abertura(b.publicado_em, agora) + ' foi identificada uma vulnerabilidade em uma das ferramentas que o sistema usa: ' + b.componente + '.';
    if (b.acao === 'atualizar-dgclaw') {
      return ini + ' A correção já foi publicada pela equipe oficial dela. Para aplicar, basta clicar em Atualizar abaixo, e o seu sistema vai para a versão com essa correção. É muito importante que você atualize.';
    }
    if (b.acao === 'atualizar-sistema') {
      return ini + ' A correção já foi publicada pela equipe oficial dela. Para aplicar, clique em Atualizar abaixo e o Admin atualiza os pacotes do servidor com você. Depois de aplicar, o Admin confirma e o aviso some.';
    }
    if (b.acao === 'parar-servico') return ini + ' A correção ainda não saiu. Enquanto isso, veja abaixo o que fazer.';
    return ini + ' A correção ainda não saiu. Não há nada a fazer agora além de acompanhar; o aviso sai da frente sozinho quando ela chegar.';
  }

  function textoDoPedido(b) {
    return b.acao === 'atualizar-sistema'
      ? 'Quero aplicar a atualização de segurança do servidor (boletim ' + b.id + '). Depois de aplicar, confirme que o aviso pode sumir.'
      : 'Quero instalar a atualização de segurança do DG Claw (boletim ' + b.id + ').';
  }

  function linkHtml(url) {
    if (!ehHttps(url)) return esc(url);
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>';
  }

  function fatoHtml(id, rotulo, valorHtml) {
    return '<div class="sb-fato"' + (id ? ' id="' + id + '"' : '') + '><dt>' + esc(rotulo) + '</dt><dd>' + valorHtml + '</dd></div>';
  }

  function fatosHtml(b) {
    let h = fatoHtml('sbData', 'Publicada em', esc(dataBr(b.publicado_em)));
    h += fatoHtml('sbGravidade', 'Gravidade', esc(gravidadeRotulo(b.severidade)));
    h += fatoHtml('sbFonte', 'Fonte oficial', linkHtml(b.fonte_url));
    if (b.noticia_url) h += fatoHtml('sbNoticia', 'Notícia', linkHtml(b.noticia_url));
    if (b.o_que_muda) h += fatoHtml('sbMuda', 'O que muda', esc(b.o_que_muda));
    return '<dl class="sb-fatos">' + h + '</dl>';
  }

  /* O botão principal do rodapé: Atualizar quando há correção para aplicar, senão só "Entendi". */
  function botoesHtml(b) {
    if (temCorrecaoParaAplicar(b)) {
      return '<button type="button" class="sb-btn" id="sbLembrar" data-sb="lembrar">Lembrar depois</button>' +
        '<button type="button" class="sb-btn sb-pri" id="sbAtualizar" data-sb="atualizar">Atualizar</button>';
    }
    return '<button type="button" class="sb-btn sb-pri" id="sbEntendi" data-sb="entendi">Entendi</button>';
  }

  function modalHtml(b, agora) {
    const detalheEmCima = !temCorrecaoParaAplicar(b);
    const detalhe = b.detalhe ? esc(b.detalhe) : '';
    return '<div class="sb-caixa" id="sbCaixa">' +
      '<div class="sb-cab"><h2 id="sbTitulo">Aviso de segurança</h2>' +
      '<button type="button" class="sb-ajuda" data-sb="ajuda" aria-label="Tutorial do aviso de segurança" title="O que é este aviso">?</button></div>' +
      '<p class="sb-texto" id="sbTexto">' + esc(textoPrincipal(b, agora)) + '</p>' +
      (detalheEmCima && detalhe ? '<p class="sb-detalhe-aberto">' + detalhe + '</p>' : '') +
      fatosHtml(b) +
      (!detalheEmCima && detalhe ? '<details class="sb-detalhe"><summary>Ver detalhes</summary><p>' + detalhe + '</p></details>' : '') +
      '<p class="sb-erro" role="alert" hidden></p>' +
      '<div class="sb-acoes">' + botoesHtml(b) + '</div></div>';
  }

  function seloHtml(qtd) {
    return qtd > 1 ? 'Avisos de segurança pendentes (' + qtd + ')' : 'Aviso de segurança pendente';
  }

  function ordena(lista) {
    return lista.slice().sort((a, b) => (PESO[a.severidade] != null ? PESO[a.severidade] : 9) - (PESO[b.severidade] != null ? PESO[b.severidade] : 9));
  }

  function passosDoModal(doc) {
    const tem = sel => !doc || !!doc.querySelector(sel);
    const passos = [
      { alvo: '#sbTexto', titulo: 'O aviso',
        oque: 'Um aviso de que foi encontrada uma falha de segurança em uma das ferramentas que o seu sistema usa.',
        como: 'A cada hora o servidor consulta, de forma pública e sem enviar nada seu, a lista de avisos que a equipe do DG Claw conferiu e aprovou. Se saiu um aviso que a sua versão ainda não corrige, esta janela aparece.',
        porque: 'Para você ficar sabendo na hora, em palavras simples, sem ter que acompanhar notícias de segurança.' },
      { alvo: '#sbData', titulo: 'A data',
        oque: 'O dia em que a falha foi publicada pela fonte oficial.',
        como: 'Vem do próprio registro oficial da falha, não do dia em que você recebeu o aviso. Se foi há menos de 48 horas, a janela diz "nas últimas horas".',
        porque: 'Para você ter ideia de há quanto tempo a falha é conhecida.' },
      { alvo: '#sbFonte', titulo: 'A fonte oficial',
        oque: 'O link para o registro oficial da falha, feito por quem mantém a ferramenta ou pela distribuição do sistema.',
        como: 'O aviso só existe se tiver essa fonte. O link abre em outra aba e você pode conferir tudo com os seus olhos.',
        porque: 'Para você não precisar acreditar na nossa palavra: a prova está num lugar que não é nosso.' },
      { alvo: '#sbMuda', titulo: 'O que muda',
        oque: 'O que acontece no seu sistema quando você aplica a correção.',
        como: 'É um resumo escrito pela equipe do DG Claw ao preparar o aviso, com base no registro oficial.',
        porque: 'Para você decidir com calma, sabendo o que vai mudar antes de clicar.' },
      { alvo: '#sbAtualizar', titulo: 'O botão Atualizar',
        oque: 'O atalho para aplicar a correção.',
        como: 'Ele leva você ao chat do Admin com o pedido já escrito no campo. Você só envia, e o Admin faz a atualização com você. Nada é instalado sozinho.',
        porque: 'Para a correção ser um passo simples, e a decisão continuar sempre sua.' },
      { alvo: '#sbEntendi', titulo: 'O botão Entendi',
        oque: 'Fecha o aviso quando não há nada para aplicar agora.',
        como: 'Quando a correção ainda não saiu, não existe o que atualizar. O aviso continua marcado pelo selo no alto da tela até a situação se resolver.',
        porque: 'Para você ler, entender e seguir o seu trabalho.' },
      { alvo: '#sbLembrar', titulo: 'Lembrar depois',
        oque: 'Esconde esta janela por 24 horas.',
        como: 'O selo "Aviso de segurança pendente" continua no alto da tela e reabre a janela quando você quiser. O aviso só some de vez quando o sistema é atualizado.',
        porque: 'Para você escolher a hora de atualizar, sem que a janela atrapalhe o que está fazendo.' },
    ];
    return passos.filter(p => tem(p.alvo));
  }

  const PASSO_SELO = {
    alvo: '#seloSeguranca',
    titulo: 'Selo de aviso de segurança',
    oque: 'Um lembrete discreto de que existe um aviso de segurança que ainda não foi resolvido.',
    como: 'Ele aparece enquanto o seu sistema não tiver a correção. Tocar nele reabre a janela do aviso. Quando você atualiza, o servidor percebe e o selo some sozinho.',
    porque: 'Para o aviso não se perder se você escolheu "Lembrar depois", e para você saber que há uma pendência sem que ela fique te interrompendo.',
  };

  if (!raiz.document) {
    return { esc, ehHttps, dataBr, gravidadeRotulo, abertura, textoPrincipal, textoDoPedido, fatosHtml, modalHtml, botoesHtml, seloHtml, ordena, passosDoModal, PASSO_SELO, temCorrecaoParaAplicar, passoSelo: () => PASSO_SELO };
  }

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let lista = [];          // boletins pendentes e não dispensados, mais graves primeiro
  let selo = null;
  let fundo = null;
  let aberto = null;       // boletim que está na janela
  let ocupado = false;
  let ciclo = 0;           // qual boletim o selo abre da próxima vez
  const jaMostrados = new Set();   // nesta aba, cada boletim abre sozinho uma vez; depois só pelo selo

  function garanteCss() {
    if (document.querySelector('link[href="/seguranca-aviso.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/seguranca-aviso.css';
    document.head.appendChild(l);
  }

  function garanteSelo() {
    if (selo) return;
    garanteCss();
    selo = document.createElement('button');
    selo.type = 'button';
    selo.id = 'seloSeguranca';
    selo.className = 'sb-selo';
    selo.hidden = true;
    selo.addEventListener('click', () => {
      if (!lista.length) return;
      const b = lista[ciclo % lista.length];
      ciclo += 1;
      abre(b);
    });
    const ref = document.getElementById('faixaAtualizacao') || document.querySelector('header');
    if (ref && ref.parentNode) ref.parentNode.insertBefore(selo, ref.nextSibling);
    else document.body.insertBefore(selo, document.body.firstChild);
  }

  function pintaSelo() {
    if (!lista.length) { if (selo) selo.hidden = true; return; }
    garanteSelo();
    selo.textContent = seloHtml(lista.length);
    selo.hidden = false;
  }

  function mostraErro(texto) {
    const e = fundo && fundo.querySelector('.sb-erro');
    if (!e) return;
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  function fecha() {
    if (fundo) { fundo.remove(); fundo = null; }
    aberto = null;
    document.removeEventListener('keydown', aoTeclar, true);
  }

  function aoTeclar(ev) {
    if (ev.key === 'Escape' && !document.getElementById('tourCaixa')) fecha();
  }

  function abre(b) {
    if (aberto || document.getElementById('tourCaixa') || document.getElementById('rpFundo')) return;
    garanteCss();
    jaMostrados.add(b.id);
    aberto = b;
    fundo = document.createElement('div');
    fundo.id = 'sbFundo';
    fundo.className = 'sb-fundo';
    fundo.setAttribute('role', 'dialog');
    fundo.setAttribute('aria-modal', 'true');
    fundo.setAttribute('aria-labelledby', 'sbTitulo');
    fundo.innerHTML = modalHtml(b, Date.now());
    fundo.addEventListener('click', aoClicar);
    document.body.appendChild(fundo);
    document.addEventListener('keydown', aoTeclar, true);
    const foco = fundo.querySelector('.sb-pri');
    if (foco) foco.focus({ preventScroll: true });
  }

  /* POST adiar/dispensar. Devolve true se o servidor aceitou; senão mostra a causa na janela. */
  async function manda(b, acao) {
    let r; let json = null;
    try {
      r = await fetch(API + '/' + encodeURIComponent(b.id) + '/' + acao, { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      try { json = await r.json(); } catch (e) { json = null; }
    } catch (e) {
      mostraErro('Não consegui falar com o servidor (' + e.message + '). Confira a conexão e toque de novo.');
      return false;
    }
    if (!r.ok) {
      mostraErro((json && json.erro) || ('O servidor respondeu ' + r.status + '. Atualize a página e tente de novo.'));
      return false;
    }
    return true;
  }

  function travaBotoes(sim) {
    if (!fundo) return;
    fundo.querySelectorAll('.sb-acoes button').forEach(x => { x.disabled = sim; });
  }

  async function lembrar(b, acao) {
    travaBotoes(true);
    const ok = await manda(b, acao);
    travaBotoes(false);
    if (!ok) return false;
    fecha();
    await atualiza();
    return true;
  }

  async function atualizar(b) {
    const faixa = raiz.DGAtualizacaoFaixa;
    if (!faixa || typeof faixa.instalar !== 'function') {
      mostraErro('O atalho de atualização ainda não carregou. Recarregue a página e toque em Atualizar de novo.');
      return;
    }
    travaBotoes(true);
    // Adia a janela por 24 h para ela não reaparecer por cima do chat do Admin; o selo continua até atualizar.
    // Se o servidor recusar, o pedido segue mesmo assim: a janela só vai reaparecer na próxima visita.
    const ok = await manda(b, 'adiar');
    if (!ok) console.warn('seguranca-aviso: não consegui adiar o aviso ' + b.id + ' antes de ir ao Admin; sigo com o pedido.');
    mostraErro('');
    fecha();
    faixa.instalar(textoDoPedido(b));
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => mostraErro('A visita guiada não carregou. Recarregue a página e tente de novo.');
    document.head.appendChild(s);
  }

  function aoClicar(ev) {
    const bt = ev.target.closest('button[data-sb]');
    if (!bt || !aberto) return;
    const a = bt.dataset.sb;
    if (a === 'lembrar') lembrar(aberto, 'adiar');
    else if (a === 'entendi') lembrar(aberto, aberto.acao === 'aguardar' ? 'dispensar' : 'adiar');
    else if (a === 'atualizar') atualizar(aberto);
    else if (a === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: passosDoModal(document) }));
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      let r;
      try { r = await fetch(API, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
        return;   // sem rede: fica como está e tenta de novo na próxima volta
      }
      if (!r.ok) {
        if (r.status !== 401) console.warn('seguranca-aviso: o servidor respondeu ' + r.status + ' em ' + API + '; sigo sem o aviso de segurança.');
        return;
      }
      let json = null;
      try { json = await r.json(); } catch (e) { console.warn('seguranca-aviso: a resposta não veio em JSON:', e.message); return; }
      const todos = Array.isArray(json && json.boletins) ? json.boletins.filter(b => b && typeof b.id === 'string') : [];
      lista = ordena(todos.filter(b => !b.dispensado));
      pintaSelo();
      if (!aberto) {
        const novo = lista.find(b => b.mostrar_modal && !jaMostrados.has(b.id));
        if (novo) abre(novo);
      }
    } catch (e) {
      console.warn('seguranca-aviso: falhou ao montar o aviso de segurança:', e);
    } finally { ocupado = false; }
  }

  function inicia() {
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { esc, ehHttps, dataBr, gravidadeRotulo, abertura, textoPrincipal, textoDoPedido, fatosHtml, modalHtml, botoesHtml, seloHtml, ordena, passosDoModal, PASSO_SELO, temCorrecaoParaAplicar, atualiza, passoSelo: () => PASSO_SELO };
});
