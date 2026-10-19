'use strict';
/* protecoes.js: a tela Proteções (rota /protecoes). Só leitura: mostra o nível da instalação e, para cada
   proteção, se está ligada, o valor, se é travada e o "o que é / como o sistema aplica / por que está aqui".

   Parte pura (sem DOM, com teste em web/test/ent-protecoes-tela.test.js): rótulos, HTML de cada proteção e do resumo.
   Parte com DOM: window.DGProtecoes.montar(elemento). Fala com GET /api/v1/protecoes (web/lib/ent/protecoes-tela.js). */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGProtecoes = m;
    m.registra();
  }
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NIVEIS = {
    pessoal: 'O DG Claw de sempre, para uma pessoa. Nenhuma proteção enterprise está ligada.',
    escritorio: 'Para um escritório pequeno: cada pessoa com seu login, segundo fator para a TI, registro das ações e containers mais fechados.',
    empresa: 'Para uma empresa: segundo fator para todos, registro completo, cofre e disco cifrados, política única para o Claude.',
    regulado: 'Para quem responde a regra de órgão regulador: tudo da empresa, mais login único obrigatório, saída da internet bloqueada e isolamento extra.',
  };
  const UNIDADE = { sessao_horas: 'horas', backup_retencao_dias: 'dias', retencao_dias: 'dias' };

  /* O valor como a pessoa lê: sim/não, número com unidade, ou a palavra. */
  function rotuloValor(c) {
    const v = c.valor;
    if (v === true) return 'sim';
    if (v === false) return 'não';
    if (typeof v === 'number') {
      if (v === 0 && c.chave === 'retencao_dias') return 'sem prazo';
      return v + (UNIDADE[c.chave] ? ' ' + UNIDADE[c.chave] : '');
    }
    return String(v);
  }

  function htmlChave(c) {
    // protegendo: true/false, ou null quando é só um parâmetro (horas de sessão, dias de cópia)
    const protegendo = c.protegendo === undefined ? c.ligada : c.protegendo;
    const selos = [protegendo === null ? '<span class="pr-selo">parâmetro</span>'
      : '<span class="pr-selo ' + (protegendo ? 'pr-on">ligada' : 'pr-off">desligada') + '</span>'];
    if (c.travado) selos.push('<span class="pr-selo pr-trava" title="Neste nível não dá para baixar abaixo do padrão">travado</span>');
    if (c.ajustado) selos.push('<span class="pr-selo pr-aj">ajustado (padrão: ' + esc(rotuloValor({ chave: c.chave, valor: c.padrao })) + ')</span>');
    return '<li class="pr-item' + (protegendo ? ' pr-ligada' : '') + '" data-chave="' + esc(c.chave) + '">' +
      '<div class="pr-topo"><span class="pr-titulo">' + esc(c.chave) + '</span> ' + selos.join(' ') + '</div>' +
      '<p class="pr-valor">Valor: <b>' + esc(rotuloValor(c)) + '</b></p>' +
      '<dl class="pr-det"><dt>O que é</dt><dd>' + esc(c.descricao) + '</dd>' +
      '<dt>Como o sistema aplica</dt><dd>' + esc(c.como) + '</dd>' +
      '<dt>Por que está aqui</dt><dd>' + esc(c.porque) + '</dd></dl></li>';
  }

  function htmlLista(chaves) {
    return '<ul class="pr-lista" data-pr-tour="lista">' + (chaves || []).map(htmlChave).join('') + '</ul>';
  }

  /* O resumo da API vira o corpo da tela. No nível pessoal avisa que nada está ligado e deixa a lista recolhida. */
  function htmlResumo(r) {
    const nivel = String(r.nivel || 'pessoal');
    const chaves = Array.isArray(r.chaves) ? r.chaves : [];
    const comChave = chaves.filter(c => c.protegendo !== null);
    const ligadas = comChave.filter(c => c.protegendo).length;
    let h = '<section class="pr-sec" data-pr-tour="nivel" aria-labelledby="prTNivel">' +
      '<h2 id="prTNivel">Nível <button type="button" class="pr-ajuda" data-pr-tutorial="nivel" aria-label="Ajuda sobre o nível">?</button></h2>' +
      '<div class="pr-nivel"><span class="pr-nivel-nome">' + esc(nivel) + '</span>' +
      (nivel === 'pessoal' ? '' : '<span class="pr-selo pr-on">' + ligadas + ' de ' + comChave.length + ' proteções ligadas</span>') + '</div>' +
      '<p class="pr-texto">' + esc(NIVEIS[nivel] || '') + '</p>' +
      (r.org_uuid ? '<p class="pr-fraco">Organização do Claude: ' + esc(r.org_uuid) + '</p>' : '') +
      '<p class="pr-fraco">Quem muda o nível é o administrador do servidor: <code>dgclaw nivel</code>.</p></section>';
    if (nivel === 'pessoal') {
      h += '<section class="pr-sec" data-pr-tour="lista" aria-labelledby="prTLista"><h2 id="prTLista">Proteções ' +
        '<button type="button" class="pr-ajuda" data-pr-tutorial="lista" aria-label="Ajuda sobre as proteções">?</button></h2>' +
        '<p class="pr-vazio">Nenhuma proteção enterprise está ligada neste nível. O DG Claw funciona como sempre funcionou.</p>' +
        '<details class="pr-mais"><summary>Ver as ' + chaves.length + ' proteções que existem nos outros níveis</summary>' + htmlLista(chaves) + '</details></section>';
    } else {
      h += '<section class="pr-sec" data-pr-tour="lista" aria-labelledby="prTLista"><h2 id="prTLista">Proteções ' +
        '<button type="button" class="pr-ajuda" data-pr-tutorial="lista" aria-label="Ajuda sobre as proteções">?</button></h2>' +
        htmlLista(chaves) + '</section>';
    }
    return h;
  }

  const PASSOS = {
    pagina: [
      { alvo: '[data-pr-tour="titulo"]', titulo: 'A tela de proteções',
        oque: 'Mostra quanta proteção esta instalação tem ligada e o que cada uma faz.',
        como: 'Lê o nível e os ajustes que o administrador gravou no servidor e mostra o valor que está valendo agora.',
        porque: 'Quem usa o sistema, ou quem precisa responder a uma auditoria, vê num lugar só o que protege os dados.' },
    ],
    nivel: [
      { alvo: '[data-pr-tour="nivel"]', titulo: 'O nível',
        oque: 'Um dos quatro pacotes: pessoal, escritório, empresa ou regulado. Cada um liga mais proteções que o anterior.',
        como: 'O administrador escolhe no servidor com o comando dgclaw nivel definir. Esta tela só mostra, não muda nada.',
        porque: 'Um pacote por nível evita ter que decidir 22 coisas uma a uma, e deixa claro o que a instalação promete.' },
    ],
    lista: [
      { alvo: '[data-pr-tour="lista"]', titulo: 'As proteções',
        oque: 'Uma ficha por proteção, com o valor que vale agora, se está ligada e se é travada.',
        como: 'Travada quer dizer que o administrador pode aumentar a proteção, mas não baixar abaixo do padrão do nível. Ajustada quer dizer que o valor é diferente do padrão.',
        porque: 'Cada ficha traz o que é, como o sistema aplica e por que está ali, para quem lê não precisar adivinhar.' },
    ],
  };

  const puros = { esc, NIVEIS, rotuloValor, htmlChave, htmlLista, htmlResumo, PASSOS };

  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  let raizEl = null;

  function tela() {
    return '<div class="pr-tela"><header class="pr-cab" data-pr-tour="titulo"><h1>Proteções</h1>' +
      '<button type="button" class="pr-btn" data-pr-tutorial="pagina">Tutorial</button></header>' +
      '<p id="prStatus" class="pr-status" role="status" aria-live="polite"></p><div id="prCorpo"></div></div>';
  }

  function status(msg, erro) {
    const s = raizEl && raizEl.querySelector('#prStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'pr-status' + (erro ? ' pr-erro' : '');
  }

  async function carrega() {
    try {
      const r = await fetch('/api/v1/protecoes', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('a API respondeu ' + r.status));
      raizEl.querySelector('#prCorpo').innerHTML = htmlResumo(d);
      status('');
    } catch (e) {
      status('Não consegui carregar as proteções: ' + e.message + '. Recarregue a página; se continuar, veja o log do dgclaw-web no servidor (journalctl -u dgclaw-web).', true);
    }
  }

  function tour(chave) {
    if (!raiz.DGTour) { status('O modo tutorial não carregou nesta página.', true); return; }
    let passos = chave === 'pagina' ? [].concat(PASSOS.pagina, PASSOS.nivel, PASSOS.lista) : PASSOS[chave];
    // Na tela /protecoes o título e o Tutorial moram no cabeçalho da casca e o .pr-cab fica escondido.
    const cab = raizEl.querySelector('.pr-cab');
    if (chave === 'pagina' && cab && cab.offsetParent === null && document.getElementById('cabecalho')) {
      passos = passos.map(p => (p.alvo === '[data-pr-tour="titulo"]' ? Object.assign({}, p, { alvo: '#cabecalho' }) : p));
    }
    // A lista pode estar recolhida (nível pessoal): abre antes de apontar para ela.
    const mais = raizEl.querySelector('details.pr-mais');
    if (mais && chave !== 'nivel') mais.open = true;
    raiz.DGTour.inicia({ passos });
  }

  function montar(elemento) {
    raizEl = elemento;
    elemento.classList.add('pr-raiz');
    elemento.innerHTML = tela();
    elemento.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (b && b.dataset.prTutorial) tour(b.dataset.prTutorial);
    });
    return carrega();
  }

  function registra() {
    const el = document.getElementById('protecoesRaiz');
    if (el) montar(el);
  }

  return Object.assign({ montar, registra }, puros);
});
