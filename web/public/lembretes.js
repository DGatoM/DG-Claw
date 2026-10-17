'use strict';
/* lembretes.js: a tela /lembretes. Lista, filtra, cria, pausa, retoma e apaga lembretes, mostra o
   histórico de cada um e liga os avisos neste aparelho (window.DGClawAvisos).
   Tudo passa pela API (web/docs/LEMBRETES.md); nenhuma informação vem de outro lugar.
   As funções que só montam dados (montaCorpo, fmt, fraseAvisos) ficam fora do DOM e têm teste em
   web/test/lembretes-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGLembretesTela = m;
})(this, function (raiz) {
  const ROTULO_ESTADO = {
    ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado', insistindo: 'Insistindo', adiada: 'Adiada',
    feito: 'Feito', sem_resposta: 'Sem resposta', perdida: 'Perdida', cancelada: 'Cancelada',
  };

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* "2026-10-20T14:30:00-03:00" -> "20/10/2026 14:30". O servidor já manda no fuso dele. */
  function fmt(iso) {
    if (typeof iso !== 'string' || iso.length < 16) return '-';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) + ' ' + iso.slice(11, 16);
  }

  /* Valores do formulário -> corpo do POST. Devolve { corpo } ou { erro }. */
  function montaCorpo(v) {
    const texto = String(v.texto || '').trim();
    if (!texto) return { erro: 'Escreva o que lembrar.' };
    const corpo = { texto };
    if (v.agente) corpo.agente = v.agente;
    const inteiro = x => (x === '' || x == null ? NaN : Number(x));
    if (v.quando === 'daqui') {
      const n = inteiro(v.daqui);
      if (!Number.isInteger(n) || n < 1 || n > 10080) return { erro: 'Diga daqui a quantos minutos (de 1 a 10080).' };
      corpo.daqui_min = n;
    } else {
      if (!v.hora) return { erro: 'Escolha a hora.' };
      let regra;
      if (v.quando === 'unico') {
        if (!v.data) return { erro: 'Escolha a data.' };
        regra = { tipo: 'unico', data: v.data, hora: v.hora };
      } else if (v.quando === 'diario') {
        regra = { tipo: 'diario', hora: v.hora };
      } else if (v.quando === 'semanal') {
        if (!v.dias || !v.dias.length) return { erro: 'Marque pelo menos um dia da semana.' };
        regra = { tipo: 'semanal', dias: v.dias, hora: v.hora };
      } else if (v.quando === 'a_cada_n_dias') {
        const n = inteiro(v.n);
        if (!Number.isInteger(n) || n < 1 || n > 365) return { erro: 'Diga de quantos em quantos dias (de 1 a 365).' };
        if (!v.inicio) return { erro: 'Escolha o dia em que a contagem começa.' };
        regra = { tipo: 'a_cada_n_dias', n, inicio: v.inicio, hora: v.hora };
      } else return { erro: 'Escolha quando o lembrete toca.' };
      corpo.regra = regra;
      if (v.fim) corpo.fim = v.fim;
    }
    const intervalo = inteiro(v.intervalo);
    if (v.intervalo !== '' && v.intervalo != null) {
      if (!Number.isInteger(intervalo) || intervalo < 1 || intervalo > 120) return { erro: 'O intervalo vai de 1 a 120 minutos.' };
      corpo.intervalo_min = intervalo;
    }
    const teto = inteiro(v.teto);
    if (v.teto !== '' && v.teto != null) {
      if (!Number.isInteger(teto) || teto < 1 || teto > 60) return { erro: 'O máximo de avisos vai de 1 a 60.' };
      corpo.teto_envios = teto;
    }
    corpo.pelo_agente = v.peloAgente !== false;
    return { corpo };
  }

  /* Estado dos avisos neste aparelho (DGClawAvisos.estado) -> frase e botões. */
  function fraseAvisos(estado) {
    switch (estado) {
      case 'ativo': return { texto: 'Os avisos estão ativos neste aparelho: o lembrete toca mesmo com a tela fechada.', ativar: false, desativar: true, teste: true };
      case 'inativo': return { texto: 'Os avisos ainda não estão ativos neste aparelho. Ative para o lembrete tocar com a tela fechada.', ativar: true, desativar: false, teste: false };
      case 'negado': return { texto: 'O navegador bloqueou os avisos deste site. Libere nas configurações do navegador (cadeado ao lado do endereço, Notificações, Permitir) e ative de novo.', ativar: true, desativar: false, teste: false };
      case 'iphone-precisa-instalar': return { texto: 'No iPhone, os avisos só funcionam com o DG Claw instalado na tela de início: toque em Compartilhar, Adicionar à Tela de Início, abra por lá e ative de novo.', ativar: false, desativar: false, teste: false };
      case 'sem-suporte': return { texto: 'Este navegador não aceita avisos. Use o Chrome, o Edge ou o Firefox no computador ou no Android, ou instale o DG Claw na tela de início do iPhone.', ativar: false, desativar: false, teste: false };
      default: return { texto: 'Não consegui conferir o estado dos avisos.', ativar: true, desativar: false, teste: false };
    }
  }

  const PASSOS = {
    avisos: {
      alvo: '#secAvisos', titulo: 'Avisos neste aparelho',
      oque: 'O botão que liga os avisos do DG Claw neste celular ou computador, e o botão que manda um aviso de teste.',
      como: 'O navegador guarda uma inscrição deste aparelho no servidor. Quando um lembrete toca, o servidor manda o aviso para todos os aparelhos inscritos, com os botões Feito e Adiar, mesmo com a tela fechada.',
      porque: 'Sem isso o lembrete só aparece na faixa dentro da conversa e no recado do agente. O teste confirma agora que o aviso chega.',
    },
    novo: {
      alvo: '#secNovo', titulo: 'Novo lembrete',
      oque: 'O formulário para agendar um lembrete: o que lembrar, de qual agente, quando e com que insistência.',
      como: 'Daqui a N minutos é o jeito mais seguro: o DG Claw faz a conta da hora no fuso do servidor. As outras opções repetem o lembrete (todo dia, em certos dias da semana, a cada N dias). O aviso se repete a cada intervalo até você tocar Feito ou até o máximo de avisos.',
      porque: 'Para você agendar na própria tela. O agente também cria lembretes por conta própria quando você pede na conversa.',
    },
    lista: {
      alvo: '#secLista', titulo: 'Seus lembretes',
      oque: 'Todos os lembretes, com a regra em português, a próxima vez que tocam e o estado (ativo, pausado ou encerrado).',
      como: 'A próxima vez é calculada pelo servidor na regra e no fuso dele. Pausar não acumula nada: ao retomar, vale a próxima hora a partir de agora. O Histórico mostra cada vez que o lembrete tocou e como terminou.',
      porque: 'Para você ver o que está agendado, pausar o que não vale mais e conferir se algum aviso ficou sem resposta.',
    },
  };

  if (!raiz.document) return { montaCorpo, fmt, fraseAvisos, ROTULO_ESTADO, PASSOS };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const abertos = new Set();
  let ultimaLista = [];
  let agentes = [];
  const POLL_MS = 15000;

  async function chamar(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(caminho, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) {
      return { ok: false, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.' };
    }
    let json = null;
    try { json = await r.json(); } catch (e) { console.warn('lembretes: a resposta de ' + caminho + ' não veio em JSON:', e.message); }
    if (r.status === 401) return { ok: false, erro: 'Sua sessão acabou. Entre de novo em /login.' };
    if (!r.ok) return { ok: false, erro: (json && json.erro) || ('O servidor respondeu ' + r.status + ' em ' + caminho + '.') };
    return { ok: true, json: json || {} };
  }

  function msg(id, texto, tipo) {
    const e = $(id);
    e.textContent = texto || '';
    e.className = 'lp-msg' + (tipo ? ' ' + tipo : '');
    e.hidden = !texto;
  }

  // ── avisos neste aparelho ──
  async function pintaAvisos() {
    const A = window.DGClawAvisos;
    if (!A) {
      $('avisosEstado').textContent = 'O código dos avisos não carregou. Recarregue a página.';
      $('btnAtivar').hidden = true; $('btnTeste').hidden = true;
      return;
    }
    let estado = 'desconhecido';
    try { estado = await A.estado(); } catch (e) { console.warn('lembretes: não li o estado dos avisos:', e.message); }
    const f = fraseAvisos(estado);
    $('avisosEstado').textContent = f.texto;
    $('btnAtivar').hidden = !f.ativar;
    $('btnDesativar').hidden = !f.desativar;
    $('btnTeste').disabled = !f.teste;
  }

  async function acaoAvisos(botao, fazer, okTexto) {
    botao.disabled = true;
    msg('avisosMsg', '');
    try {
      const r = await fazer();
      if (!r.ok) msg('avisosMsg', r.erro, 'erro');
      else msg('avisosMsg', okTexto(r), 'ok');
    } catch (e) {
      msg('avisosMsg', 'Algo falhou (' + e.message + '). Recarregue a página e tente de novo.', 'erro');
    }
    botao.disabled = false;
    pintaAvisos();
  }

  // ── lista ──
  function preencheAgentes(lista) {
    const sel = $('fAgente'), filtro = $('filtroAgente');
    const guardado = filtro.value;
    const opts = lista.map(a => `<option value="${esc(a.id)}">${esc(a.nome)}</option>`).join('');
    sel.innerHTML = opts;
    filtro.innerHTML = '<option value="">Todos os agentes</option>' + opts;
    filtro.value = guardado;
    const trabalho = lista.filter(a => a.tipo === 'agente');
    if (trabalho.length) sel.value = trabalho[0].id;
  }

  function linhaHtml(l) {
    const aberto = abertos.has(l.id);
    const acoes = `<button type="button" class="lp-btn" data-hist="${esc(l.id)}">${aberto ? 'Esconder histórico' : 'Histórico'}</button>` +
      (l.estado === 'pausado'
        ? `<button type="button" class="lp-btn" data-retomar="${esc(l.id)}">Retomar</button>`
        : `<button type="button" class="lp-btn" data-pausar="${esc(l.id)}">Pausar</button>`) +
      `<button type="button" class="lp-btn perigo" data-apagar="${esc(l.id)}">Apagar</button>`;
    return `<tr data-id="${esc(l.id)}"><td data-r="Lembrete">${esc(l.texto)}<span class="lp-regra">${esc(l.regra_texto)}</span></td>` +
      `<td data-r="Agente">${esc(l.agente_nome || l.agente)}</td>` +
      `<td data-r="Próxima">${esc(fmt(l.proxima))}</td>` +
      `<td data-r="Estado"><span class="lp-chip ${esc(l.estado)}">${esc(ROTULO_ESTADO[l.estado] || l.estado)}</span></td>` +
      `<td class="acoes">${acoes}</td></tr>` +
      (aberto ? `<tr class="lp-hist" data-hist-de="${esc(l.id)}"><td colspan="5"><p class="lp-fraco">Carregando o histórico…</p></td></tr>` : '');
  }

  function pintaLista(itens) {
    ultimaLista = itens;
    if (!itens.length) {
      $('lista').innerHTML = '<p class="lp-vazio">Nenhum lembrete por aqui. Crie o primeiro no formulário acima, ou peça ao agente na conversa.</p>';
      return;
    }
    $('lista').innerHTML = '<table class="lp-tabela"><thead><tr><th>Lembrete</th><th>Agente</th><th>Próxima</th><th>Estado</th><th></th></tr></thead><tbody>' +
      itens.map(linhaHtml).join('') + '</tbody></table>';
    for (const id of abertos) carregaHistorico(id);
  }

  async function carregaHistorico(id) {
    const linha = document.querySelector('tr[data-hist-de="' + id + '"] td');
    if (!linha) return;
    const r = await chamar('GET', '/api/v1/lembretes/' + encodeURIComponent(id) + '/ocorrencias?limit=30');
    if (!r.ok) { linha.innerHTML = '<p class="lp-msg erro">Não consegui ler o histórico: ' + esc(r.erro) + '</p>'; return; }
    const ocs = r.json.ocorrencias || [];
    if (!ocs.length) { linha.innerHTML = '<p class="lp-fraco">Ainda não tocou nenhuma vez.</p>'; return; }
    linha.innerHTML = '<ul>' + ocs.map(o => {
      const quem = o.feito_por ? ' por ' + esc(o.feito_por) + (o.tarde ? ' (depois do teto)' : '') : '';
      const abertoOc = ['insistindo', 'adiada', 'sem_resposta'].includes(o.estado);
      const bot = abertoOc
        ? `<button type="button" class="lp-btn pri" data-feito="${esc(o.id)}">Feito</button><button type="button" class="lp-btn" data-adiar="${esc(o.id)}">Adiar 10 min</button>` : '';
      return `<li><b>${esc(fmt(o.agendada_para))}</b><span class="lp-chip ${esc(o.estado)}">${esc(ROTULO_ESTADO[o.estado] || o.estado)}</span>` +
        `<span class="lp-fraco">${o.total_envios} aviso(s)${quem}${o.motivo ? ', ' + esc(o.motivo) : ''}</span>${bot}</li>`;
    }).join('') + '</ul>';
  }

  async function carrega() {
    const q = new URLSearchParams();
    if ($('filtroAgente').value) q.set('agente', $('filtroAgente').value);
    if ($('filtroEstado').value) q.set('estado', $('filtroEstado').value);
    const r = await chamar('GET', '/api/v1/lembretes' + (q.toString() ? '?' + q : ''));
    if (!r.ok) {
      msg('msgGeral', 'Não consegui ler os lembretes: ' + r.erro, 'erro');
      if (!ultimaLista.length) $('lista').innerHTML = '<p class="lp-vazio">A lista não carregou. <button type="button" class="lp-btn" id="btnRecarrega">Tentar de novo</button></p>';
      const b = $('btnRecarrega'); if (b) b.onclick = carrega;
      return;
    }
    msg('msgGeral', '');
    pintaLista(r.json.lembretes || []);
    const a = r.json.agendador || {};
    $('agendador').textContent = a.erro
      ? 'Atenção: o agendador está parado. ' + a.erro
      : 'Fuso: ' + (a.fuso || '?') + '. Última conferência do agendador: ' + fmt(a.ultimo_tique_em) + ' (confere a cada ' + (a.intervalo_s || 15) + ' s).';
  }

  async function carregaAgentes() {
    const r = await chamar('GET', '/api/v1/agents');
    if (!r.ok) { msg('msgGeral', 'Não consegui ler a lista de agentes: ' + r.erro, 'erro'); return; }
    agentes = r.json.agentes || [];
    preencheAgentes(agentes);
  }

  async function aoClicarLista(ev) {
    const b = ev.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.hist) {
      if (abertos.has(d.hist)) abertos.delete(d.hist); else abertos.add(d.hist);
      pintaLista(ultimaLista);
      return;
    }
    let r;
    if (d.pausar) r = await chamar('POST', '/api/v1/lembretes/' + encodeURIComponent(d.pausar) + '/pausar');
    else if (d.retomar) {
      r = await chamar('POST', '/api/v1/lembretes/' + encodeURIComponent(d.retomar) + '/retomar');
      if (r.ok && r.json.aviso) msg('msgGeral', r.json.aviso, 'erro');
    } else if (d.apagar) {
      const l = ultimaLista.find(x => x.id === d.apagar);
      if (!window.confirm('Apagar o lembrete "' + (l ? l.texto : d.apagar) + '"? Isso não tem volta.')) return;
      r = await chamar('DELETE', '/api/v1/lembretes/' + encodeURIComponent(d.apagar));
      abertos.delete(d.apagar);
    } else if (d.feito) r = await chamar('POST', '/api/v1/lembretes/ocorrencias/' + encodeURIComponent(d.feito) + '/feito', { origem: 'tela' });
    else if (d.adiar) r = await chamar('POST', '/api/v1/lembretes/ocorrencias/' + encodeURIComponent(d.adiar) + '/adiar', { minutos: 10 });
    else return;
    if (!r.ok) { msg('msgGeral', r.erro, 'erro'); return; }
    if (!(d.retomar && r.json.aviso)) msg('msgGeral', '');
    carrega();
  }

  // ── formulário ──
  function mostraCampos() {
    const q = $('fQuando').value;
    document.querySelectorAll('#formNovo [data-so]').forEach(e => { e.hidden = !e.dataset.so.split(' ').includes(q); });
  }

  function lerFormulario() {
    return {
      texto: $('fTexto').value, agente: $('fAgente').value, quando: $('fQuando').value, daqui: $('fDaqui').value,
      data: $('fData').value, hora: $('fHora').value, n: $('fN').value, inicio: $('fInicio').value, fim: $('fFim').value,
      dias: [...document.querySelectorAll('#fDias input:checked')].map(i => i.value),
      intervalo: $('fIntervalo').value, teto: $('fTeto').value, peloAgente: $('fPeloAgente').checked,
    };
  }

  async function criar(ev) {
    ev.preventDefault();
    msg('novoMsg', '');
    const r0 = montaCorpo(lerFormulario());
    if (r0.erro) { msg('novoMsg', r0.erro, 'erro'); return; }
    $('btnCriar').disabled = true;
    const r = await chamar('POST', '/api/v1/lembretes', r0.corpo);
    $('btnCriar').disabled = false;
    if (!r.ok) { msg('novoMsg', r.erro, 'erro'); return; }
    const l = r.json.lembrete;
    msg('novoMsg', 'Criado: ' + l.regra_texto + '. Próxima vez: ' + fmt(l.proxima) + '.', 'ok');
    $('fTexto').value = '';
    carrega();
  }

  function ajuda(chave) {
    if (!window.DGTour) { msg('msgGeral', 'A visita guiada não carregou. Recarregue a página.', 'erro'); return; }
    window.DGTour.inicia({ passos: [PASSOS[chave]] });
  }

  function iniciaTutorial() {
    if (!window.DGTour) { msg('msgGeral', 'A visita guiada não carregou. Recarregue a página.', 'erro'); return; }
    window.DGTour.inicia({
      passos: [
        { alvo: '#cabecalho', titulo: 'Lembretes', oque: 'A tela de todos os lembretes que insistem até você confirmar.', como: 'O DG Claw confere a cada 15 segundos. Na hora marcada, avisa na faixa da conversa, no aparelho e pelo agente, e repete até você tocar Feito ou Adiar.', porque: 'Para nada que você pediu para lembrar ficar esquecido.' },
        PASSOS.avisos, PASSOS.novo, PASSOS.lista,
      ],
    });
  }

  function inicia() {
    // o botão Tutorial fica no cabeçalho da casca (casca.js), que chama esta função
    window.DGLembretesTutorial = iniciaTutorial;
    document.querySelectorAll('[data-ajuda]').forEach(b => { b.onclick = () => ajuda(b.dataset.ajuda); });
    $('btnAtivar').onclick = () => acaoAvisos($('btnAtivar'), () => window.DGClawAvisos.ativar(), () => 'Pronto: os avisos estão ativos neste aparelho.');
    $('btnDesativar').onclick = () => acaoAvisos($('btnDesativar'), () => window.DGClawAvisos.desativar(), () => 'Avisos desligados neste aparelho.');
    $('btnTeste').onclick = () => acaoAvisos($('btnTeste'), () => window.DGClawAvisos.testar(), r => 'Aviso de teste enviado para ' + r.enviados + ' aparelho(s).');
    $('fQuando').onchange = mostraCampos;
    $('formNovo').addEventListener('submit', criar);
    $('lista').addEventListener('click', aoClicarLista);
    $('filtroAgente').onchange = carrega;
    $('filtroEstado').onchange = carrega;
    const hoje = new Date();
    const dia = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0') + '-' + String(hoje.getDate()).padStart(2, '0');
    $('fInicio').value = dia;
    mostraCampos();
    pintaAvisos();
    carregaAgentes().then(carrega);
    setInterval(carrega, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') carrega(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { montaCorpo, fmt, fraseAvisos, ROTULO_ESTADO, PASSOS };
});
