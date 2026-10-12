// socorro.js — a tela da aba Socorro.
//
// O QUE ELA É: um técnico de plantão para quando o agente parece estar com problema.
// A pessoa escreve "aconteceu alguma coisa com o meu agente, vê aí", e um Claude
// NEUTRO, que não é o agente, lê os registros dele, explica em português o que houve e
// propõe o conserto. Antes de mudar qualquer coisa, ele pergunta e espera o "sim".
//
// POR QUE ELA EXISTE (Danilo, 01/10/2026): quando o agente trava, a pessoa perde
// justamente quem ela consultaria. A Isa ficou 56 minutos muda por um bloqueio da
// Anthropic, e a única saída foi o Danilo abrir um terminal. O dono de um agente de
// cliente não tem terminal nem sabe o que procurar.
//
// TRÊS COISAS QUE A TELA PRECISA DIZER, e que não são detalhe:
//   1. ESTE NÃO É O SEU AGENTE. É outra conversa, com outro Claude, que não lembra de
//      nada do que vocês conversaram e não fala com os seus clientes.
//   2. ELE PERGUNTA ANTES DE MEXER. Ler é livre; reiniciar, restaurar ou editar só
//      depois do seu "sim".
//   3. ELA É PASSAGEIRA. "Encerrar" esquece a conversa de socorro (o histórico fica
//      guardado para quem cuida do sistema).
//
// A aba é desenhada inteira por este arquivo (o mesmo padrão do cofre.js), e se pendura
// sozinha no botão do menu: o js/app.js não precisa saber que ela existe. A resposta
// chega por POLLING do /api/socorro/estado?desde=<n>: sem dependência nova, e robusto
// quando a conexão pisca (a próxima pergunta pega o que faltou).
//
// Este arquivo NÃO usa o `API.get`, pelo mesmo motivo do cofre.js: aquele wrapper devolve
// `null` quando a resposta não é 200, e com isso morre o motivo que o servidor escreveu.

(function () {
  const BASE = window.DGCLAW_BASE || '';
  const POLL_RESPONDENDO_MS = 1500;

  // Texto livre (12/10/2026): marcas viram negrito/código/link pelo renderizador único; sem ele, escape.
  const rl = (t) => (window.DGMarkdown && window.DGMarkdown.ricoLinha ? window.DGMarkdown.ricoLinha(t) : esc(t));
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hora(iso) {
    const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
    if (!m) return '';
    try {
      return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return `${m[1]}:${m[2]}`;
    }
  }

  async function chamar(url, opcoes) {
    let res;
    try {
      res = await fetch(BASE + url, opcoes);
    } catch (e) {
      return { ok: false, status: 0, corpo: { error: `Não alcancei o painel: ${e.message}` } };
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return { ok: false, status: 401, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* resposta sem json: o status diz o que houve */ }
    return { ok: res.ok, status: res.status, corpo };
  }

  function motivoDoErro(r) {
    const c = r.corpo || {};
    if (c.error && c.howToFix) return `${c.error} ${c.howToFix}`;
    return c.error || `O painel respondeu ${r.status}.`;
  }

  // ─── Tutorial ─────────────────────────────────────────────────
  // Regra do repo: nenhuma tela nasce muda. Cada passo responde o que é, como funciona
  // e por que está aqui.

  function passosDoTutorial() {
    return [
      {
        chave: 'tela',
        alvo: null,
        titulo: 'Um técnico de plantão para o seu agente',
        corpo: 'Quando o seu agente parece estar com problema (não responde, responde estranho, sumiu), você conversa aqui com um ajudante que olha os registros dele e explica, em português, o que aconteceu e o que dá para fazer.',
        porque: 'Quando o agente trava, você perde justamente quem consultaria. Sem esta aba, a única saída seria alguém abrir o servidor e procurar o problema na mão.',
      },
      {
        chave: 'nao-e-o-agente',
        alvo: '#socorro-root .socorro-intro',
        titulo: 'Este não é o seu agente',
        corpo: 'É outra conversa, com outro Claude. Ele não lembra de nada do que você conversou com o seu agente, não fala com os seus clientes e não carrega a conversa do agente, que às vezes é justamente o que está travando tudo.',
        porque: 'Se o problema estiver na conversa do agente (por exemplo, a Anthropic bloqueou uma resposta), perguntar a ele mesmo só repetiria o problema. Um ajudante de fora consegue olhar sem tropeçar no mesmo lugar.',
      },
      {
        chave: 'perguntar',
        alvo: '#socorro-root .socorro-conversa',
        titulo: 'A conversa de socorro',
        corpo: 'Você escreve, ele responde aqui. As linhas cinzas mostram o que ele está consultando (um registro, um arquivo). Cada resposta termina com o que ele acha que aconteceu e o próximo passo sugerido.',
        porque: 'Ver o que ele consultou deixa claro que a resposta veio dos registros do agente, e não de um palpite.',
      },
      {
        chave: 'sim',
        alvo: '#socorro-root .socorro-escrever',
        titulo: 'Ele pergunta antes de mexer',
        corpo: 'Para ler e investigar ele não pede licença. Para mudar qualquer coisa (reiniciar o agente, restaurar um backup, corrigir um arquivo), ele explica o que quer fazer, pergunta "posso fazer?" e para. Só faz depois que você responder que sim.',
        porque: 'Uma ação errada no agente pode interromper um trabalho ou apagar uma configuração. A decisão é sua, e o ajudante existe para te dar informação para decidir, não para decidir por você.',
      },
      {
        chave: 'encerrar',
        alvo: '#socorro-encerrar',
        titulo: 'Encerrar a sessão',
        corpo: 'Quando o problema estiver resolvido, encerre. A próxima mensagem começa uma sessão nova, do zero. O que foi dito fica guardado num registro para quem cuida do sistema conferir depois.',
        porque: 'A sessão de socorro gasta da conta Claude desta máquina a cada mensagem, e uma conversa longa fica mais cara. Encerrar mantém cada atendimento curto e barato.',
      },
    ];
  }

  function abrirTutorial(comecarEm) {
    if (window.DGTutorial) window.DGTutorial.abrir(passosDoTutorial(), comecarEm);
  }

  // ─── Estado ───────────────────────────────────────────────────

  let ultimo = 0;
  let eventos = [];
  let respondendo = false;
  let ligado = true;
  let enviando = false;
  let relogio = null;
  let aviso = null;

  function raiz() { return document.getElementById('socorro-root'); }

  // ─── Desenho ──────────────────────────────────────────────────

  function cabecalho() {
    const ajuda = 'Um ajudante neutro, que não é o seu agente, para quando ele parecer estar com problema. '
      + 'Ele lê os registros e explica o que houve.';
    return `<div class="app-cabeca">
        <div class="app-cabeca-linha">
          <h2 title="${esc(ajuda)}">Socorro</h2>
          <button type="button" class="app-tutorial-abrir" id="socorro-tutorial-abrir"
                  title="Uma visita guiada por esta tela, passo a passo.">Tutorial</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="tela"
                  aria-label="O que é o socorro" title="O que é o socorro">?</button>
        </div>
        <p>${esc(ajuda)}</p>
      </div>
      <div class="cartao socorro-intro">
        <div class="section-title">Antes de começar
          <button type="button" class="app-ajuda-secao" data-tutorial="nao-e-o-agente"
                  aria-label="Por que este não é o meu agente" title="Por que este não é o meu agente">?</button>
        </div>
        <ul class="socorro-lista">
          <li><b>Quando usar:</b> o agente não responde, responde estranho, ou o selo lá em cima ficou amarelo ou vermelho e você quer entender por quê.</li>
          <li><b>Este não é o seu agente.</b> É outro Claude, que não lembra das conversas de vocês e não fala com os seus clientes.</li>
          <li><b>Ele pergunta antes de mexer.</b> Ler os registros é livre; reiniciar, restaurar ou corrigir alguma coisa, só depois do seu "sim".</li>
          <li><b>Custa uso da conta Claude desta máquina</b>, a cada mensagem. Encerre quando terminar.</li>
        </ul>
      </div>
      <div id="socorro-corpo"></div>`;
  }

  function linhaDoEvento(e) {
    if (e.tipo === 'voce') {
      return `<div class="bolha de-voce">${esc(e.texto)}<span class="bolha-pe">você · ${esc(hora(e.em))}</span></div>`;
    }
    if (e.tipo === 'socorro') {
      const html = window.DGMarkdown ? window.DGMarkdown.md(e.texto) : esc(e.texto);
      return `<div class="bolha de-agente socorro-resposta"><div class="socorro-md">${html}</div>`
        + `<span class="bolha-pe">socorro · ${esc(hora(e.em))}</span></div>`;
    }
    if (e.tipo === 'ferramenta') {
      return `<div class="socorro-ferramenta" title="O que o ajudante consultou para responder. Ele só lê, a não ser que você autorize uma mudança.">↳ ${rl(e.texto)}</div>`;
    }
    if (e.tipo === 'erro') {
      return `<div class="app-erro socorro-erro"><strong>O socorro teve um problema.</strong><p>${rl(e.texto)}</p></div>`;
    }
    if (e.tipo === 'fim') {
      const s = e.duracaoMs ? `${Math.max(1, Math.round(e.duracaoMs / 1000))} s` : '';
      const custo = typeof e.custoUsd === 'number' ? ` · uso estimado US$ ${e.custoUsd.toFixed(2).replace('.', ',')}` : '';
      return s || custo
        ? `<div class="socorro-fim" title="Quanto tempo a resposta levou e quanto ela gastou da conta Claude desta máquina (estimativa do próprio Claude).">respondeu em ${esc(s)}${esc(custo)}</div>`
        : '';
    }
    return '';
  }

  function blocoConversa() {
    const vazio = !eventos.length
      ? `<div class="conversa-vazia">Conte o que está acontecendo, do seu jeito. Por exemplo:
           "ele parou de responder desde ontem" ou "o selo ficou vermelho, o que houve?".</div>`
      : '';
    const pensando = respondendo
      ? '<div class="socorro-pensando" title="O ajudante está lendo os registros e montando a resposta.">o socorro está investigando…</div>'
      : '';
    return `<div class="cartao socorro-conversa">
        <div class="section-title">Conversa de socorro
          <button type="button" class="app-ajuda-secao" data-tutorial="perguntar"
                  aria-label="Como funciona a conversa" title="Como funciona a conversa">?</button>
        </div>
        <div class="socorro-linhas" id="socorro-linhas">${vazio}${eventos.map(linhaDoEvento).join('')}${pensando}</div>
      </div>`;
  }

  const SUGESTOES = [
    'Aconteceu alguma coisa com o meu agente, vê aí.',
    'Por que ele parou de responder?',
    'Ele está bem agora?',
  ];

  function blocoEscrever() {
    if (!ligado) {
      return `<div class="app-erro socorro-escrever"><strong>A sessão de socorro está desligada neste painel.</strong>
          <p>Quem cuida do sistema liga de volta tirando "socorro": false do config.json do painel.</p></div>`;
    }
    const avisoHtml = aviso ? `<div class="app-erro socorro-aviso"><p>${rl(aviso)}</p></div>` : '';
    const chips = eventos.length ? '' : `<div class="socorro-sugestoes">${SUGESTOES.map((s) =>
      `<button type="button" class="btn-leve socorro-sugestao" title="Usar esta frase para começar.">${esc(s)}</button>`).join('')}</div>`;
    return `<div class="cartao socorro-escrever">
        <div class="section-title">Escrever
          <button type="button" class="app-ajuda-secao" data-tutorial="sim"
                  aria-label="O que ele pode fazer sozinho" title="O que ele pode fazer sozinho">?</button>
        </div>
        ${avisoHtml}${chips}
        <textarea id="socorro-texto" rows="3" maxlength="8000"
                  placeholder="Ex.: ele parou de responder desde ontem à noite"
                  title="Escreva para o ajudante. Para autorizar uma mudança que ele propôs, responda sim."
                  ${respondendo || enviando ? 'disabled' : ''}></textarea>
        <div class="socorro-botoes">
          <button type="button" class="btn-principal" id="socorro-enviar" ${respondendo || enviando ? 'disabled' : ''}
                  title="Manda a mensagem para o ajudante. A resposta aparece acima.">enviar</button>
          <button type="button" class="btn-leve" id="socorro-encerrar" ${eventos.length ? '' : 'disabled'}
                  title="Esquece esta conversa de socorro. A próxima mensagem começa do zero. O registro fica guardado para quem cuida do sistema.">encerrar a sessão</button>
          <button type="button" class="app-ajuda-secao" data-tutorial="encerrar"
                  aria-label="O que acontece ao encerrar" title="O que acontece ao encerrar">?</button>
        </div>
      </div>`;
  }

  function desenhar() {
    const corpo = document.getElementById('socorro-corpo');
    if (!corpo) return;
    const rascunho = (document.getElementById('socorro-texto') || {}).value || '';
    corpo.innerHTML = blocoConversa() + blocoEscrever();
    const campo = document.getElementById('socorro-texto');
    if (campo && rascunho) campo.value = rascunho;
    const lista = document.getElementById('socorro-linhas');
    if (lista) lista.scrollTop = lista.scrollHeight;
    ligarCorpo();
  }

  // ─── Ligações ─────────────────────────────────────────────────

  function ligarCabecalho() {
    const b = document.getElementById('socorro-tutorial-abrir');
    if (b) b.addEventListener('click', () => abrirTutorial(0));
    document.querySelectorAll('#socorro-root .app-cabeca .app-ajuda-secao[data-tutorial], #socorro-root .socorro-intro .app-ajuda-secao[data-tutorial]')
      .forEach((el) => el.addEventListener('click', () => abrirTutorial(el.dataset.tutorial)));
  }

  function ligarCorpo() {
    document.querySelectorAll('#socorro-corpo .app-ajuda-secao[data-tutorial]').forEach((el) => {
      el.addEventListener('click', () => abrirTutorial(el.dataset.tutorial));
    });
    const enviar = document.getElementById('socorro-enviar');
    if (enviar) enviar.addEventListener('click', () => mandar());
    const campo = document.getElementById('socorro-texto');
    if (campo) {
      campo.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); mandar(); }
      });
    }
    const encerrar = document.getElementById('socorro-encerrar');
    if (encerrar) encerrar.addEventListener('click', encerrarSessao);
    document.querySelectorAll('#socorro-corpo .socorro-sugestao').forEach((b) => {
      b.addEventListener('click', () => {
        const c = document.getElementById('socorro-texto');
        if (c) { c.value = b.textContent; c.focus(); }
      });
    });
  }

  // ─── Ações ────────────────────────────────────────────────────

  async function mandar() {
    const campo = document.getElementById('socorro-texto');
    const texto = campo ? campo.value.trim() : '';
    if (!texto || enviando || respondendo) return;
    enviando = true;
    aviso = null;
    desenhar();
    const r = await chamar('/api/socorro/mensagem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    enviando = false;
    if (!r.ok) {
      // A mensagem NÃO entrou: o texto volta para o campo, para a pessoa não perder.
      aviso = motivoDoErro(r);
      desenhar();
      const c = document.getElementById('socorro-texto');
      if (c) c.value = texto;
      return;
    }
    const c = document.getElementById('socorro-texto');
    if (c) c.value = '';
    respondendo = true;
    await atualizar();
  }

  async function encerrarSessao() {
    const certeza = window.confirm(
      'Encerrar a sessão de socorro?\n\nO ajudante esquece esta conversa e a próxima mensagem começa do zero. '
      + 'Nada no seu agente muda com isso.',
    );
    if (!certeza) return;
    const r = await chamar('/api/socorro/encerrar', { method: 'POST' });
    if (!r.ok) { aviso = motivoDoErro(r); desenhar(); return; }
    eventos = [];
    ultimo = 0;
    respondendo = false;
    aviso = null;
    desenhar();
  }

  // ─── Carregar e acompanhar ────────────────────────────────────

  async function atualizar() {
    clearTimeout(relogio);
    const r = await chamar(`/api/socorro/estado?desde=${ultimo}`);
    if (!r.ok) {
      aviso = `Não consegui acompanhar a resposta: ${motivoDoErro(r)} Tento de novo em instantes.`;
      desenhar();
      relogio = setTimeout(atualizar, 5000);
      return;
    }
    const c = r.corpo || {};
    ligado = c.ligado !== false;
    // O servidor reiniciou ou a sessão foi encerrada em outra aba: começa do zero.
    if (c.ultimo < ultimo) { eventos = []; ultimo = 0; }
    if (Array.isArray(c.eventos) && c.eventos.length) {
      eventos = eventos.concat(c.eventos.filter((e) => e.seq > ultimo));
      ultimo = c.ultimo;
    }
    respondendo = !!c.respondendo;
    if (aviso && aviso.startsWith('Não consegui acompanhar')) aviso = null;
    desenhar();
    if (respondendo) relogio = setTimeout(atualizar, POLL_RESPONDENDO_MS);
  }

  async function carregar() {
    const el = raiz();
    if (!el) return;
    el.innerHTML = cabecalho();
    ligarCabecalho();
    const corpo = document.getElementById('socorro-corpo');
    if (corpo) corpo.innerHTML = '<div class="app-carregando">Carregando...</div>';
    eventos = [];
    ultimo = 0;
    await atualizar();
  }

  // ─── A aba se pendura sozinha no menu ─────────────────────────
  // O js/app.js troca o painel visível e o título; o resto é daqui. O subtítulo é
  // escrito DEPOIS do clique do app.js (que o zera para abas que ele não conhece),
  // por isso o setTimeout de zero.
  const EXPLICACAO = 'Um ajudante neutro, que não é o seu agente, para quando ele parecer estar com problema: '
    + 'lê os registros, explica o que houve e pergunta antes de mexer em qualquer coisa.';
  const SUBTITULO = 'quando o agente parece estar com problema';

  function pendurar() {
    const aba = document.querySelector('.tab[data-tab="socorro"]');
    if (!aba || aba._socorro) return;
    aba._socorro = true;
    aba.title = EXPLICACAO;
    let carregou = false;
    aba.addEventListener('click', () => {
      setTimeout(() => {
        const sub = document.getElementById('subtitulo-aba');
        if (sub) sub.textContent = SUBTITULO;
      }, 0);
      if (!carregou) { carregou = true; carregar(); } else atualizar();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pendurar);
  else pendurar();

  window.DGSocorro = { carregar, abrirTutorial };
})();
