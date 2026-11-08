'use strict';
/* seguranca-resumo.js: o AVISO ÚNICO de segurança do painel (uma janela e um selo), em todas as telas.

   Antes eram duas famílias de janelas (uma por boletim e uma por falha crítica) que voltavam a cada visita e obrigavam a
   fechar várias. Agora há UMA janela, "Seu ambiente está em risco", que só lista os pontos e leva à tela Segurança, onde
   ficam o detalhe e todas as ações (aplicar, agendar, pedir ao Admin, tirar do ar, Atualizar, Entendi).

   O que conta como "ponto em risco":
   - boletim de segurança (GET /boletins) que não foi dispensado. Os que o dono mandou "lembrar depois" continuam
     contando: o risco não sumiu, só a janela repetida;
   - falha crítica de nível 2 da ronda (GET /ronda) em estado "aberto" e sem decisão do dono neste aparelho. "Agendado"
     não conta (o dono já decidiu). Com o sistema fora do ar (GET /emergencia, cortado e consistente) nada conta.
   - se um achado da ronda é o mesmo problema de um boletim (mesmo id ou alias), conta uma vez só, como boletim.

   Quando abre sozinha: fechar uma vez fecha tudo e grava no aparelho uma "assinatura" (ids vistos, pior gravidade, hora).
   Ela só reabre sozinha se aparecer um id novo, se a pior gravidade piorar, ou se passarem 24 h do último fechamento
   (no máximo uma vez por dia). Na própria tela /seguranca ela não abre sozinha e o selo some (a tela já é o detalhe).
   Enquanto houver pontos em risco, o selo discreto no alto leva à tela Segurança.
   Tudo que vem da API é escapado. Falha de rede ou 401 nunca derruba a tela. Testes: web/test/seguranca-resumo.test.js. */
(function (raiz, fabrica) {
  const R = typeof module === 'object' && module.exports ? require('./ronda-comum') : raiz.DGRondaComum;
  const m = fabrica(raiz, R);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGSegurancaResumo = m;
})(this, function (raiz, R) {
  const { esc } = R;
  const POLL_MS = 2 * 60 * 1000;
  const REABRE_MS = 24 * 3600 * 1000;
  const MAX_LISTA = 5;
  const CHAVE_ASSINATURA = 'dgclaw:seguranca:resumo';
  const API_BOLETINS = R.API + '/boletins';
  const SEM_PESO = 9;

  const peso = sev => (R.PESO[sev] != null ? R.PESO[sev] : SEM_PESO);

  /* ── regras puras ───────────────────────────────────────────────────────── */

  /* entrada = { boletins, ronda, emergencia, storage, agora }; cada fonte pode ser null (não consegui ler).
     Devolve [{ tipo: 'boletim'|'ronda', id, nome, severidade }], os mais graves primeiro. */
  function pontosEmRisco(entrada) {
    const e = entrada || {};
    const agora = typeof e.agora === 'number' ? e.agora : Date.now();
    const itens = [];
    const boletimPorId = new Map();
    for (const b of Array.isArray(e.boletins) ? e.boletins : []) {
      if (!b || typeof b.id !== 'string' || b.dispensado) continue;
      const item = { tipo: 'boletim', id: b.id, nome: b.titulo || b.componente || b.id, severidade: b.severidade };
      boletimPorId.set(b.id, item);
      itens.push(item);
    }
    for (const a of R.criticasEmAberto(e.ronda, e.storage, agora, e.emergencia)) {
      if (!a || typeof a.id !== 'string') continue;
      const ids = [a.id].concat(Array.isArray(a.aliases) ? a.aliases : []);
      const igual = ids.map(x => boletimPorId.get(x)).find(Boolean);
      if (igual) {
        // Mesmo problema nas duas fontes: conta uma vez, com a gravidade maior (as fontes não precisam concordar).
        if (peso(a.severidade) < peso(igual.severidade)) igual.severidade = a.severidade;
        continue;
      }
      itens.push({ tipo: 'ronda', id: a.id, nome: a.nome_simples || a.componente || a.id, severidade: a.severidade });
    }
    return R.ordenaPorGravidade(itens);
  }

  const pior = itens => itens.reduce((p, i) => Math.min(p, peso(i.severidade)), SEM_PESO);

  /* "Encontramos 3 pontos de segurança que precisam da sua atenção." */
  function textoContagem(n) {
    return n === 1
      ? 'Encontramos 1 ponto de segurança que precisa da sua atenção.'
      : 'Encontramos ' + n + ' pontos de segurança que precisam da sua atenção.';
  }

  function textoSelo(n) { return '🛡 ' + n + (n === 1 ? ' ponto de segurança' : ' pontos de segurança'); }

  /* No máximo MAX_LISTA itens; o resto vira "e mais X". */
  function recorta(itens, max) {
    const lim = max || MAX_LISTA;
    return { mostrados: itens.slice(0, lim), resto: Math.max(0, itens.length - lim) };
  }

  function textoResto(n) { return n === 1 ? 'e mais 1 ponto' : 'e mais ' + n + ' pontos'; }

  function assinaturaDe(itens, agora) {
    return { ids: itens.map(i => i.id), pior: pior(itens), em: agora };
  }

  function lerAssinatura(storage) {
    try {
      const j = JSON.parse(storage.getItem(CHAVE_ASSINATURA) || 'null');
      if (j && Array.isArray(j.ids) && typeof j.pior === 'number' && typeof j.em === 'number') return j;
    } catch (e) { /* ilegível: vale como "nunca fechou", a janela volta a abrir */ }
    return null;
  }

  function gravaAssinatura(storage, itens, agora) {
    try { storage.setItem(CHAVE_ASSINATURA, JSON.stringify(assinaturaDe(itens, agora))); } catch (e) { /* sem armazenamento: a janela só volta a abrir mais vezes */ }
  }

  /* Abre sozinha? Id novo, gravidade pior, ou 24 h desde o último fechamento. Lista vazia nunca abre. */
  function deveReabrir(itens, assinatura, agora) {
    if (!itens.length) return false;
    if (!assinatura) return true;
    const vistos = new Set(assinatura.ids);
    if (itens.some(i => !vistos.has(i.id))) return true;
    if (pior(itens) < assinatura.pior) return true;
    return agora - assinatura.em >= REABRE_MS;
  }

  /* ── HTML ───────────────────────────────────────────────────────────────── */
  function itemHtml(i) {
    return '<li class="sr-item"><span class="sr-nome">' + esc(i.nome) + '</span> <span class="sr-grav sr-grav-' +
      esc(String(i.severidade).toLowerCase()) + '">' + esc(R.gravidadeRotulo(i.severidade)) + '</span></li>';
  }

  function modalHtml(itens) {
    const { mostrados, resto } = recorta(itens);
    return '<div class="sr-caixa" id="srCaixa">' +
      '<div class="sr-cab"><h2 id="srTitulo">Seu ambiente está em risco</h2>' +
      '<button type="button" class="sr-icone" data-sr="ajuda" aria-label="Tutorial do aviso de segurança" title="O que é este aviso">?</button>' +
      '<button type="button" class="sr-icone" data-sr="fechar" aria-label="Fechar o aviso" title="Fechar">✕</button></div>' +
      '<p class="sr-texto" id="srTexto">' + esc(textoContagem(itens.length)) + '</p>' +
      '<ul class="sr-lista" id="srLista">' + mostrados.map(itemHtml).join('') +
      (resto ? '<li class="sr-resto">' + esc(textoResto(resto)) + '</li>' : '') + '</ul>' +
      '<div class="sr-acoes"><button type="button" class="sr-btn" id="srAgoraNao" data-sr="fechar">Agora não</button>' +
      '<button type="button" class="sr-btn sr-pri" id="srVer" data-sr="ver">Ver na Segurança</button></div></div>';
  }

  /* ── tutorial ───────────────────────────────────────────────────────────── */
  function passosDoModal(doc) {
    const tem = sel => !doc || !!doc.querySelector(sel);
    return [
      { alvo: '#srTexto', titulo: 'O aviso único',
        oque: 'Uma janela só que junta tudo o que está pedindo atenção na segurança do seu ambiente: avisos sobre ferramentas com falha e falhas críticas achadas pela ronda.',
        como: 'O painel soma os avisos de segurança do DG Claw que você ainda não dispensou com as falhas críticas abertas da ronda. Nada é enviado para fora: ele só lê o que o seu servidor já sabe.',
        porque: 'Para você não precisar fechar uma janela por problema. É um aviso só, e o detalhe de cada um fica na tela Segurança.' },
      { alvo: '#srLista', titulo: 'Os pontos em risco',
        oque: 'Os nomes simples dos problemas e a gravidade de cada um, os mais graves primeiro (no máximo 5, o resto aparece como "e mais").',
        como: 'A gravidade vem do registro oficial de cada falha. Aqui você só vê o resumo; as provas, os links e os botões de ação estão na tela Segurança.',
        porque: 'Para você saber de relance o tamanho do problema antes de decidir se olha agora.' },
      { alvo: '#srVer', titulo: 'Ver na Segurança',
        oque: 'Leva à tela Segurança, onde cada ponto tem os fatos e as ações.',
        como: 'Lá você aplica a correção, agenda, pede ao Admin, tira o sistema do ar ou, nos avisos sem correção ainda, marca que entendeu.',
        porque: 'Decidir com os fatos na frente é melhor do que decidir dentro de uma janela.' },
      { alvo: '#srAgoraNao', titulo: 'Agora não',
        oque: 'Fecha o aviso, e fecha todos de uma vez.',
        como: 'A janela só volta sozinha se aparecer um ponto novo, se a situação piorar, ou depois de 24 horas (no máximo uma vez por dia). O selo no alto da tela continua enquanto houver pontos em risco.',
        porque: 'Para você escolher a hora de cuidar disso, sem uma janela te interrompendo o dia todo e sem o risco ser esquecido.' },
    ].filter(p => tem(p.alvo));
  }

  const PASSO_SELO = {
    alvo: '#seloSeguranca',
    titulo: 'Selo de segurança',
    oque: 'Um lembrete discreto de que existem pontos de segurança que ainda pedem a sua atenção, com a quantidade.',
    como: 'Ele aparece enquanto houver aviso de segurança não dispensado ou falha crítica aberta. Tocar nele leva à tela Segurança. Quando tudo é resolvido, o servidor percebe e o selo some sozinho.',
    porque: 'Para o risco não se perder depois que você fecha a janela, e para você saber que há pendência sem ser interrompido.',
  };

  const puras = {
    pontosEmRisco, textoContagem, textoSelo, recorta, textoResto, assinaturaDe, lerAssinatura, gravaAssinatura, deveReabrir,
    itemHtml, modalHtml, passosDoModal, PASSO_SELO, passoSelo: () => PASSO_SELO, CHAVE_ASSINATURA, REABRE_MS, MAX_LISTA,
  };

  if (!raiz.document) return puras;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const naTelaSeguranca = () => location.pathname.replace(/\/+$/, '') === '/seguranca';
  let selo = null;
  let fundo = null;
  let ocupado = false;
  let itens = [];
  let naJanela = [];   // a lista que a janela está mostrando; fechar grava só ela, para o que chegou depois ainda reabrir
  const fontes = { boletins: null, ronda: null, emergencia: null };   // última leitura boa de cada fonte

  /* Navegador que bloqueia o localStorage (modo privado restrito, política da empresa) lança erro só de tocar na
     propriedade. Aí a assinatura vive em memória: a janela volta a cada carregamento, mas o alerta nunca some. */
  let reserva = null;
  function armazenamento() {
    try { const s = raiz.localStorage; if (s) return s; } catch (e) { /* bloqueado: cai na reserva abaixo */ }
    if (!reserva) {
      const m = new Map();
      reserva = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
      console.warn('seguranca-resumo: o navegador não deixa usar o localStorage; o aviso vai lembrar o que você fechou só até recarregar a página.');
    }
    return reserva;
  }

  function garanteCss() {
    if (document.querySelector('link[href="/seguranca-resumo.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/seguranca-resumo.css';
    document.head.appendChild(l);
  }

  function garanteSelo() {
    if (selo) return;
    garanteCss();
    selo = document.createElement('button');
    selo.type = 'button';
    selo.id = 'seloSeguranca';
    selo.className = 'sr-selo';
    selo.hidden = true;
    selo.addEventListener('click', () => { location.href = '/seguranca'; });
    const ref = document.getElementById('faixaAtualizacao') || document.querySelector('header');
    if (ref && ref.parentNode) ref.parentNode.insertBefore(selo, ref.nextSibling);
    else document.body.insertBefore(selo, document.body.firstChild);
  }

  function pintaSelo() {
    if (!itens.length || naTelaSeguranca()) { if (selo) selo.hidden = true; return; }
    garanteSelo();
    selo.textContent = textoSelo(itens.length);
    selo.hidden = false;
  }

  function aoTeclar(ev) {
    if (ev.key === 'Escape' && !document.getElementById('tourCaixa')) fecha();
  }

  /* Fechar por qualquer caminho vale como "vi tudo isto": grava a assinatura da lista atual. */
  function fecha() {
    if (!fundo) return;
    gravaAssinatura(armazenamento(), naJanela, Date.now());
    fundo.remove();
    fundo = null;
    document.removeEventListener('keydown', aoTeclar, true);
  }

  function abre() {
    if (fundo || !itens.length) return;
    garanteCss();
    naJanela = itens.slice();
    fundo = document.createElement('div');
    fundo.id = 'srFundo';
    fundo.className = 'sr-fundo';
    fundo.setAttribute('role', 'alertdialog');
    fundo.setAttribute('aria-modal', 'true');
    fundo.setAttribute('aria-labelledby', 'srTitulo');
    fundo.innerHTML = modalHtml(itens);
    fundo.addEventListener('click', aoClicar);
    document.body.appendChild(fundo);
    document.addEventListener('keydown', aoTeclar, true);
    const foco = fundo.querySelector('.sr-pri');
    if (foco) foco.focus({ preventScroll: true });
  }

  function irParaSeguranca() {
    fecha();
    if (naTelaSeguranca()) {
      const alvo = document.getElementById('secBoletins') || document.getElementById('secAcao');
      if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ block: 'start' });
      else if (raiz.scrollTo) raiz.scrollTo(0, 0);
    } else location.href = '/seguranca';
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => console.warn('seguranca-resumo: a visita guiada (/tour.js) não carregou; recarregue a página e tente de novo.');
    document.head.appendChild(s);
  }

  function aoClicar(ev) {
    if (ev.target === fundo) { fecha(); return; }   // clique fora da caixa
    const bt = ev.target.closest('button[data-sr]');
    if (!bt) return;
    const k = bt.dataset.sr;
    if (k === 'fechar') fecha();
    else if (k === 'ver') irParaSeguranca();
    else if (k === 'ajuda') comTour(() => raiz.DGTour.inicia({ passos: passosDoModal(document) }));
  }

  /* Lê uma fonte; só troca a última leitura boa se esta veio boa. 401 e falta de rede não são ruído. */
  async function le(chave, url) {
    const r = await R.chama(raiz.fetch.bind(raiz), 'GET', url);
    if (r.ok) { fontes[chave] = r.json; return; }
    // O estado de emergência só serve para ESCONDER alertas; leitura velha dele não vale: sem leitura boa agora, os
    // alertas voltam a contar até o corte ser confirmado de novo.
    if (chave === 'emergencia') fontes.emergencia = null;
    if (r.status !== 401 && r.status !== 0) console.warn('seguranca-resumo: ' + r.erro + ' (' + url + '). Sigo com a última leitura boa, se houver.');
  }

  async function atualiza() {
    if (ocupado) return;
    ocupado = true;
    try {
      await Promise.all([le('boletins', API_BOLETINS), le('ronda', R.API + '/ronda'), le('emergencia', R.API + '/emergencia')]);
      const agora = Date.now();
      itens = pontosEmRisco({
        boletins: fontes.boletins && fontes.boletins.boletins, ronda: fontes.ronda, emergencia: fontes.emergencia,
        storage: armazenamento(), agora,
      });
      pintaSelo();
      if (!fundo && !naTelaSeguranca() && !document.getElementById('tourCaixa') && deveReabrir(itens, lerAssinatura(armazenamento()), agora)) abre();
    } catch (err) {
      console.warn('seguranca-resumo: falhou ao montar o aviso de segurança:', err);
    } finally { ocupado = false; }
  }

  function inicia() {
    atualiza();
    setInterval(atualiza, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') atualiza(); });
  }

  // Aviso de segurança do servidor é só do dono.
  if (raiz.DGPapel && raiz.DGPapel.colaborador) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return Object.assign({ atualiza }, puras);
});
