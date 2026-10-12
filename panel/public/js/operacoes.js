// operacoes.js — a aba Operações: uma página de status das rotinas do sistema.
//
// POR QUE ESTA TELA É ASSIM (Danilo, 01/10/2026). Havia duas abas, "Operações" (o
// que está marcado) e "Pulso" (se rodou certo), e nem quem mandou construir sabia
// a diferença. Agora é uma aba só, no formato que todo mundo já conhece de página
// de status: cada operação aparece uma vez, com o nome, de quanto em quanto tempo
// roda, e uma fileira de quadradinhos das últimas execuções. Tudo verde, está
// tudo funcionando. Vermelho falhou. Amarelo pede atenção. Cinza é sem dado.
//
// QUEM DECIDE A COR É O SERVIDOR (lib/operacoes.js), lendo o diário do sistema e
// cruzando com o registro de cada rotina. Esta tela só desenha: se ela decidisse
// cor também, seriam duas regras para a mesma coisa, e um dia elas discordam.
//
// OS MAIS RECENTES FICAM À DIREITA, e a fileira mostra quantos couberem: no
// celular aparecem menos quadradinhos, nunca uma rolagem para o lado. Isso é CSS
// (flex em ordem invertida com o excesso cortado à esquerda), não conta de
// largura em JavaScript.
//
// Passar o mouse num quadradinho mostra quando foi e o resultado. No celular, onde
// não há "passar o mouse", tocar na fileira mostra o mesmo texto embaixo dela.

(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Texto livre (12/10/2026): marcas viram negrito/código/link pelo renderizador único; sem ele, escape.
  const rl = (t) => (window.DGMarkdown && window.DGMarkdown.ricoLinha ? window.DGMarkdown.ricoLinha(t) : esc(t));
  const COR_TEXTO = {
    verde: 'deu certo',
    vermelho: 'falhou',
    amarelo: 'pede atenção',
    cinza: 'sem dado',
  };

  const ESTADO_TEXTO = {
    ok: 'funcionando',
    falha: 'falhou',
    atencao: 'pede atenção',
    'sem-dado': 'sem dado ainda',
  };

  function quando(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function horaCurta(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  /** O texto do balão de UM quadradinho: quando, o resultado e o detalhe. */
  function textoDoQuadrado(q, porHora) {
    const partes = [];
    if (porHora) partes.push(`${quando(q.em)} até ${horaCurta(q.ate || q.em)}`);
    else partes.push(quando(q.em));
    partes.push(q.titulo || COR_TEXTO[q.cor] || '');
    if (q.duracao) partes.push(`levou ${q.duracao}`);
    let t = partes.filter(Boolean).join(' · ');
    if (q.detalhe) t += `\n${q.detalhe}`;
    return t;
  }

  /** "nos últimos 7 dias: 329 rodadas, nenhuma falha" */
  function textoDaSemana(op, dias) {
    const s = op.semana || {};
    if (op.porHora) {
      const ruins = (s.falhas || 0) + (s.avisos || 0);
      return ruins ? `nas últimas 48 h: ${s.falhas || 0} hora(s) com queda, ${s.avisos || 0} com reinício` : 'nas últimas 48 h: de pé o tempo todo';
    }
    if (s.rodadas == null) return '';
    const partes = [`${s.rodadas.toLocaleString('pt-BR')} ${s.rodadas === 1 ? 'vez' : 'vezes'}`];
    partes.push(s.falhas ? `${s.falhas} ${s.falhas === 1 ? 'falha' : 'falhas'}` : 'nenhuma falha');
    if (s.faltas) partes.push(`${s.faltas} ${s.faltas === 1 ? 'vez que não rodou' : 'vezes que não rodou'}`);
    if (s.avisos) partes.push(`${s.avisos} com aviso`);
    return `nos últimos ${dias} dias: ${partes.join(', ')}`;
  }

  function balaoDoNome(op) {
    const linhas = [];
    if (op.oQueE) linhas.push(op.oQueE);
    if (op.praQueServe) linhas.push('', op.praQueServe);
    if (op.cadencia) linhas.push('', `Com que frequência: ${op.cadencia}.`);
    if (op.crit === 'alta') linhas.push('', 'É essencial: se esta cai, o agente para de responder.');
    linhas.push('', `Nome no sistema: ${op.unit}`);
    return linhas.join('\n').trim();
  }

  /** A frase do estado, com a data em ISO trocada por algo legível. */
  function fraseDo(op) {
    const f = String(op.frase || '');
    const m = f.match(/^de pé desde (\d{4}-\d{2}-\d{2}T[^ ]+)$/);
    if (m) return `de pé desde ${quando(m[1])}`;
    return f;
  }

  function linhaDaOperacao(op, dias) {
    // Mais recente PRIMEIRO no DOM: com flex-direction:row-reverse ele fica na
    // direita, e o que não cabe some pela esquerda (os mais antigos).
    const qs = (op.quadrados || []).slice().reverse();
    const fileira = qs.length
      ? qs.map((q, i) => `<span class="opq ${esc(q.cor)}${q.falta ? ' falta' : ''}" data-i="${i}" title="${esc(textoDoQuadrado(q, op.porHora))}"></span>`).join('')
      : '<span class="opq-vazia">sem histórico para mostrar</span>';
    const crit = op.crit === 'alta' ? '<span class="op-essencial" title="Se esta cai, o agente para de responder.">essencial</span>' : '';
    return `<div class="op-linha estado-${esc(op.estado)}" id="op-${esc(op.id)}" data-id="${esc(op.id)}">
      <div class="op-cabeca">
        <span class="op-sinal ${esc(op.estado)}" title="${esc(ESTADO_TEXTO[op.estado] || op.estado)}" aria-hidden="true"></span>
        <div class="op-textos">
          <div class="op-nome" title="${esc(balaoDoNome(op))}">${esc(op.nome)} ${crit}</div>
          <div class="op-quando">${rl([op.cadencia, fraseDo(op)].filter(Boolean).join(' · '))}</div>
        </div>
      </div>
      <div class="op-fileira" tabindex="0" role="group"
           aria-label="${esc(`Últimas execuções de ${op.nome}. Use as setas para ver cada uma.`)}">${fileira}</div>
      <div class="op-semana">${esc(textoDaSemana(op, dias))}</div>
      <div class="op-detalhe" aria-live="polite" hidden></div>
    </div>`;
  }

  /** Tocar (ou usar as setas) mostra o texto do quadradinho embaixo da fileira. */
  function ligarFileiras(raiz, dados) {
    const porId = {};
    for (const g of dados.grupos || []) for (const op of g.operacoes) porId[op.id] = op;
    raiz.querySelectorAll('.op-linha').forEach((linha) => {
      const op = porId[linha.dataset.id];
      const fileira = linha.querySelector('.op-fileira');
      const detalhe = linha.querySelector('.op-detalhe');
      if (!op || !fileira || !(op.quadrados || []).length) return;
      const qs = op.quadrados.slice().reverse();
      let atual = -1;
      const mostrar = (i) => {
        if (i < 0 || i >= qs.length) return;
        atual = i;
        fileira.querySelectorAll('.opq.sel').forEach((el) => el.classList.remove('sel'));
        const el = fileira.querySelector(`.opq[data-i="${i}"]`);
        if (el) el.classList.add('sel');
        detalhe.hidden = false;
        detalhe.textContent = textoDoQuadrado(qs[i], op.porHora);
      };
      fileira.addEventListener('click', (ev) => {
        let alvo = ev.target.closest('.opq');
        if (!alvo) {
          // Tocou no vão entre dois: pega o mais perto do dedo.
          let melhor = null; let dist = Infinity;
          fileira.querySelectorAll('.opq').forEach((el) => {
            const r = el.getBoundingClientRect();
            const d = Math.abs(r.left + r.width / 2 - ev.clientX);
            if (d < dist) { dist = d; melhor = el; }
          });
          alvo = melhor;
        }
        if (alvo) mostrar(Number(alvo.dataset.i));
      });
      fileira.addEventListener('keydown', (ev) => {
        // Na tela, a direita é o mais recente (índice 0).
        if (ev.key === 'ArrowLeft') { ev.preventDefault(); mostrar(atual < 0 ? 0 : Math.min(qs.length - 1, atual + 1)); }
        if (ev.key === 'ArrowRight') { ev.preventDefault(); mostrar(atual < 0 ? 0 : Math.max(0, atual - 1)); }
        if (ev.key === 'Escape') { detalhe.hidden = true; atual = -1; fileira.querySelectorAll('.opq.sel').forEach((el) => el.classList.remove('sel')); }
      });
    });
  }

  function desenharResumo(el, dados) {
    const r = dados.resumo || {};
    const icone = { ok: '✓', atencao: '!', 'sem-dado': '…', indisponivel: '?' }[r.estado] || '?';
    const porId = {};
    for (const g of dados.grupos || []) for (const op of g.operacoes) porId[op.id] = op;
    const nomes = (r.atencao || []).map((id) => porId[id]).filter(Boolean)
      .map((op) => `<a href="#op-${esc(op.id)}" class="op-ir" data-alvo="op-${esc(op.id)}">${esc(op.nome)}</a>`);
    let frase = rl(r.frase || '');
    if (r.estado === 'atencao' && nomes.length) {
      const n = nomes.length;
      frase = `${n} ${n === 1 ? 'operação pede' : 'operações pedem'} atenção: ${nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`}`;
    }
    const conta = r.total
      ? `${r.verdes} de ${r.total} funcionando${r.semDado ? `, ${r.semDado} ainda sem dado` : ''}`
      : '';
    el.className = `op-resumo ${esc(r.estado || '')}`;
    el.innerHTML = `<span class="op-resumo-icone" aria-hidden="true">${icone}</span>
      <div class="op-resumo-texto">
        <div class="op-resumo-frase">${frase}</div>
        <div class="op-resumo-pe" title="A conta olha a ÚLTIMA execução de cada operação. Verde só conta quando rodou e deu certo; o que ainda não rodou fica de fora, em vez de contar como sucesso.">
          ${esc(conta)}${r.motivo ? ` · ${rl(r.motivo)}` : ''} · conferido às ${esc(horaCurta(dados.geradoEm))}
        </div>
      </div>
      <button type="button" class="btn-leve op-atualizar" title="Lê o diário do sistema de novo agora, em vez de esperar o próximo minuto.">atualizar</button>`;
    el.querySelectorAll('.op-ir').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const alvo = document.getElementById(a.dataset.alvo);
      if (alvo) { alvo.scrollIntoView({ behavior: 'smooth', block: 'center' }); alvo.classList.add('destacada'); setTimeout(() => alvo.classList.remove('destacada'), 1800); }
    }));
    el.querySelector('.op-atualizar').addEventListener('click', () => carregar(true));
  }

  function ligarAlternador() {
    const botoes = document.querySelectorAll('#op-alternar [data-vista]');
    botoes.forEach((b) => {
      if (b._ligado) return;
      b._ligado = true;
      b.addEventListener('click', () => mostrarVista(b.dataset.vista));
    });
  }

  function mostrarVista(vista) {
    document.querySelectorAll('#op-alternar [data-vista]').forEach((b) => {
      const sim = b.dataset.vista === vista;
      b.classList.toggle('ativo', sim);
      b.setAttribute('aria-selected', sim ? 'true' : 'false');
    });
    const sit = document.getElementById('op-situacao');
    const reg = document.getElementById('op-registros');
    if (sit) sit.hidden = vista !== 'situacao';
    if (reg) reg.hidden = vista !== 'registros';
    // Os registros só carregam quando alguém pede: ler log custa e quase ninguém olha.
    if (vista === 'registros' && typeof window.carregarRegistrosDaOperacao === 'function') window.carregarRegistrosDaOperacao();
  }

  let _ultima = null;

  async function carregar(forcar) {
    ligarAlternador();
    const resumo = document.getElementById('op-resumo');
    const grupos = document.getElementById('op-grupos');
    if (!resumo || !grupos) return;
    if (!_ultima) grupos.innerHTML = '<div class="vazio-util">Lendo o diário do sistema...</div>';
    const r = await API.operacoes(forcar);
    if (!r.ok) {
      const c = r.corpo || {};
      resumo.className = 'op-resumo indisponivel';
      resumo.innerHTML = `<span class="op-resumo-icone" aria-hidden="true">?</span><div class="op-resumo-texto">
        <div class="op-resumo-frase">${rl(c.error || 'Não consegui carregar as operações.')}</div>
        <div class="op-resumo-pe">${rl(c.howToFix || 'Recarregue a página.')}</div></div>`;
      if (!_ultima) grupos.innerHTML = '';
      return;
    }
    const dados = r.corpo;
    _ultima = dados;
    desenharResumo(resumo, dados);
    const dias = (dados.janela && dados.janela.dias) || 7;
    if (!(dados.grupos || []).length) {
      grupos.innerHTML = '<div class="vazio-util">Nenhuma operação do sistema encontrada nesta máquina. '
        + 'É o caso de um agente que ainda não passou pela instalação completa.</div>';
      return;
    }
    grupos.innerHTML = dados.grupos.map((g) => `<section class="op-grupo">
        <div class="section-title" title="${esc(g.explica)}">${esc(g.titulo)}${botaoAjuda('operations', 'fileiras')}</div>
        <p class="ajuda-secao">${esc(g.explica)}</p>
        ${g.operacoes.map((op) => linhaDaOperacao(op, dias)).join('')}
      </section>`).join('');
    ligarFileiras(grupos, dados);
    ligarAjudas(grupos);
  }

  /**
   * O "?" das partes que esta tela desenha sozinha (os títulos de grupo e a linha
   * da home). Mesmo botão e mesmo texto do js/tutoriais.js, só que pendurado daqui,
   * porque estes títulos não existem no HTML para o mapa de lá achar.
   */
  function botaoAjuda(aba, chave) {
    return `<button type="button" class="app-ajuda-secao" data-ajuda-aba="${aba}" data-ajuda-chave="${chave}"
      aria-label="O que é esta seção" title="O que é esta seção, e como a conta é feita">?</button>`;
  }
  function ligarAjudas(raiz) {
    raiz.querySelectorAll('[data-ajuda-aba]').forEach((b) => {
      if (b._ligado) return;
      b._ligado = true;
      b.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (window.DGTutoriais) window.DGTutoriais.abrir(b.dataset.ajudaAba, b.dataset.ajudaChave);
      });
    });
  }

  /**
   * A linha da home: "Operações do sistema: tudo funcionando ✓", com link para a aba.
   * Mesma fonte da aba, mesma frase: a home não tem conta própria.
   */
  async function linhaDaHome(el) {
    if (!el) return null;
    const r = await API.operacoes(false);
    if (!r.ok) {
      el.className = 'home-operacoes indisponivel';
      el.innerHTML = `<span class="hop-icone" aria-hidden="true">?</span> <span><b>Operações do sistema:</b> não consegui ler agora (${esc((r.corpo && r.corpo.error) || 'sem resposta')}).</span>`
        + ' <a href="#" class="link-aba" data-ir-para="operations">ver Operações</a>';
      return null;
    }
    const s = r.corpo.resumo || {};
    const icone = { ok: '✓', atencao: '!', 'sem-dado': '…', indisponivel: '?' }[s.estado] || '?';
    const texto = s.estado === 'ok' ? 'tudo funcionando' : (s.frase || '').replace(/^./, (c) => c.toLowerCase());
    el.className = `home-operacoes ${esc(s.estado || '')}`;
    el.title = 'As rotinas que mantêm ele de pé, a memória e a vigilância de custos. Verde quando a última execução de cada uma deu certo.';
    el.innerHTML = `<span class="hop-icone" aria-hidden="true">${icone}</span> <span><b>Operações do sistema:</b> ${esc(texto)}</span>`
      + botaoAjuda('status', 'operacoes')
      + ' <a href="#" class="link-aba" data-ir-para="operations">ver Operações</a>';
    ligarAjudas(el);
    return r.corpo;
  }

  window.DGOperacoes = { carregar, mostrarVista, linhaDaHome, ultima: () => _ultima };
})();
