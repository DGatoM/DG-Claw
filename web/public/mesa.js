'use strict';
/* mesa.js: a tela da Mesa de tarefas (/mesa). Contrato da API em web/docs/MESA.md.

   As partes puras (rótulos, texto do progresso, "há X min", agrupamento, texto da origem, HTML do
   cartão) ficam fora do DOM e têm teste em web/test/mesa-tela.test.js. O resto só roda no navegador.

   Abas: window.DGMesaAbas.registrar({ id, titulo, montar(elemento), bolinha }). A aba "tarefas" é
   registrada aqui mesmo. `bolinha` é opcional: uma função chamada UMA vez, logo após o registro, com o
   setter acende(true|false) que acende ou apaga o pontinho da aba. Abrir a aba apaga o pontinho.
   O mesmo setter volta no retorno de registrar() e no segundo argumento de montar(elemento, { bolinha }).
   montar() roda uma vez só, na primeira abertura da aba. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGMesa = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');

  /* ───────────── partes puras ───────────── */

  const ESTADO_DONO = 'esperando_dono';
  const normEstado = e => (e === 'esperando_danilo' ? ESTADO_DONO : e);

  /* { texto, classe } do selo. "parada?" só vale para fazendo. */
  function rotuloEstado(t) {
    const e = normEstado(t && t.estado);
    if (e === 'concluida') return { texto: 'concluída ✓', classe: 'concluida' };
    if (e === 'cancelada') return { texto: 'cancelada', classe: 'cancelada' };
    if (e === ESTADO_DONO) return { texto: 'esperando você', classe: 'esperando' };
    if (e === 'travada') return { texto: 'travada', classe: 'travada' };
    if (e === 'fazendo' && t.parada) return { texto: 'parada?', classe: 'parada' };
    if (e === 'fazendo') return { texto: 'fazendo', classe: 'fazendo' };
    return { texto: String(e || 'sem estado'), classe: 'outro' };
  }

  /* null (não medido) nunca vira 0%: 0 é "medido e deu zero". */
  function textoProgresso(p) {
    if (p == null || typeof p !== 'number' || !isFinite(p)) return 'sem medida';
    return Math.round(Math.max(0, Math.min(100, p))) + '%';
  }

  function haMin(min) {
    if (min == null || typeof min !== 'number' || !isFinite(min)) return 'sem registro de atualização';
    if (min < 1) return 'atualizada agora mesmo';
    if (min < 60) return 'atualizada há ' + Math.floor(min) + ' min';
    if (min < 1440) return 'atualizada há ' + Math.floor(min / 60) + ' h';
    return 'atualizada há ' + Math.floor(min / 1440) + ' d';
  }

  /* [{ agente, tarefas }] na ordem da lista de agentes; tarefa de agente desconhecido vai no fim. */
  function agrupaPorAgente(tarefas, agentes) {
    const mapa = new Map();
    for (const a of agentes || []) mapa.set(a.id, { agente: a, tarefas: [] });
    for (const t of tarefas || []) {
      if (!mapa.has(t.agente)) mapa.set(t.agente, { agente: { id: t.agente, nome: t.agente, cor: null }, tarefas: [] });
      mapa.get(t.agente).tarefas.push(t);
    }
    return [...mapa.values()];
  }

  function textoOrigem(d) {
    return 'Dono, ' + pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' +
      pad2(d.getHours()) + 'h' + pad2(d.getMinutes()) + ': ';
  }

  /* Só http(s) e caminhos do próprio Web (/x). Qualquer outra coisa (javascript:, //host) vira texto. */
  function urlSegura(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) || /^\/(?!\/)/.test(s) ? s : '';
  }

  function linkHtml(url, rotulo) {
    const u = urlSegura(url);
    if (!u) return esc(rotulo || url);
    return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(rotulo || url)}</a>`;
  }

  /* Frase do erro da API: { texto, campos } com o `erro` e os `erros` campo a campo. */
  function fraseErro(dados, status) {
    const campos = dados && dados.erros && typeof dados.erros === 'object' ? dados.erros : {};
    let texto = dados && dados.erro ? String(dados.erro) : '';
    if (!texto) texto = Object.keys(campos).length ? 'Alguns campos precisam de ajuste.' : 'O servidor recusou o pedido (código ' + status + ').';
    return { texto, campos };
  }

  function formataQuando(v) {
    if (v == null || v === '') return '';
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + 'h' + pad2(d.getMinutes());
  }

  function valorCurto(v) {
    if (v == null || v === '') return 'vazio';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 80 ? s.slice(0, 77) + '...' : s;
  }

  /* O formato exato dos eventos é do backend: aqui se aceita o que a spec descreve (quem, quando,
     o antes e o depois de cada campo) em mais de um desenho, sem quebrar se faltar algo. */
  function htmlHistorico(eventos) {
    if (eventos === 'erro') return '<p class="mz-vazio">Não consegui carregar o histórico. Feche e abra o cartão para tentar de novo.</p>';
    if (!Array.isArray(eventos)) return '<p class="mz-vazio">Carregando o histórico...</p>';
    if (!eventos.length) return '<p class="mz-vazio">Ainda não há eventos registrados.</p>';
    return '<ol class="mz-eventos">' + eventos.map(e => {
      const quando = formataQuando(e.quando || e.em || e.data || e.criado_em || e.em_iso || e.epoch);
      const mud = e.mudancas || e.campos || e.alteracoes || e.diff;
      let linhas = [];
      if (Array.isArray(mud)) {
        linhas = mud.map(c => `${esc(c.campo)}: ${esc(valorCurto(c.antes))} → ${esc(valorCurto(c.depois))}`);
      } else if (mud && typeof mud === 'object') {
        linhas = Object.keys(mud).map(k => {
          const c = mud[k];
          return c && typeof c === 'object' && ('antes' in c || 'depois' in c)
            ? `${esc(k)}: ${esc(valorCurto(c.antes))} → ${esc(valorCurto(c.depois))}`
            : `${esc(k)}: ${esc(valorCurto(c))}`;
        });
      }
      return `<li><span class="mz-ev-q">${esc(quando)}${e.por ? ' · ' + esc(e.por) : ''}</span>` +
        `<b>${esc(e.acao || e.tipo || 'mudança')}</b>` +
        (linhas.length ? '<ul>' + linhas.map(l => `<li>${l}</li>`).join('') + '</ul>' : '') + '</li>';
    }).join('') + '</ol>';
  }

  function htmlErros(erro) {
    if (!erro) return '';
    const campos = erro.campos || {};
    const lista = Object.keys(campos).map(k => `<li><b>${esc(k)}:</b> ${esc(campos[k])}</li>`).join('');
    return `<div class="mz-erro" role="alert"><p>${esc(erro.texto)}</p>${lista ? '<ul>' + lista + '</ul>' : ''}</div>`;
  }

  /* Formulário que abre dentro do cartão. form = { tipo: 'responder'|'cancelar'|'editar', valores, erro } */
  function htmlFormCartao(t, form) {
    const v = form.valores || {};
    const id = t.id;
    const atrib = `data-id="${esc(id)}"`;
    let campos = '', titulo = '', ok = '';
    if (form.tipo === 'responder') {
      titulo = 'Sua resposta ao agente';
      ok = 'Enviar resposta';
      campos = `<label>Resposta<textarea name="nota" rows="3" maxlength="200" required>${esc(v.nota != null ? v.nota : '')}</textarea></label>` +
        '<p class="mz-dica">A resposta vira a nota da tarefa, ela volta para "fazendo" e o agente é avisado.</p>';
    } else if (form.tipo === 'cancelar') {
      titulo = 'Cancelar esta tarefa?';
      ok = 'Cancelar a tarefa';
      campos = `<label>Motivo (opcional)<input name="motivo" type="text" maxlength="300" value="${esc(v.motivo != null ? v.motivo : '')}"></label>`;
    } else {
      titulo = 'Editar a tarefa';
      ok = 'Salvar';
      const prog = v.progresso != null ? v.progresso : (t.progresso_origem === 'informado' && t.progresso != null ? t.progresso : '');
      campos = `<label>Título<input name="titulo" type="text" maxlength="120" value="${esc(v.titulo != null ? v.titulo : t.titulo)}"></label>` +
        `<label>Nota<input name="nota" type="text" maxlength="200" value="${esc(v.nota != null ? v.nota : (t.nota || ''))}"></label>` +
        `<label>Progresso (0 a 100, vazio = sem medida)<input name="progresso" type="number" min="0" max="100" step="1" inputmode="numeric" value="${esc(prog)}"></label>` +
        `<label>Link<input name="link" type="text" maxlength="500" value="${esc(v.link != null ? v.link : (t.link || ''))}"></label>`;
    }
    return `<form class="mz-form" ${atrib} data-form="${esc(form.tipo)}"><h4>${esc(titulo)}</h4>${campos}${htmlErros(form.erro)}` +
      `<div class="mz-linha"><button type="submit" class="mz-btn pri" ${atrib} data-acao="enviar-form">${esc(ok)}</button>` +
      `<button type="button" class="mz-btn" ${atrib} data-acao="fechar-form">Voltar</button></div></form>`;
  }

  /* opcoes = { aberto, eventos, form, msg, demo }. Tudo o que vem da API passa por esc(). */
  function htmlCartao(t, opcoes) {
    const o = opcoes || {};
    const sel = rotuloEstado(t);
    const estado = normEstado(t.estado);
    const fechada = estado === 'concluida' || estado === 'cancelada';
    const id = esc(t.id);
    const atrib = `data-id="${id}"`;
    const prog = textoProgresso(t.progresso);
    const pct = typeof t.progresso === 'number' ? Math.max(0, Math.min(100, t.progresso)) : null;
    const origemProg = { informado: 'informado pelo agente', passos: 'passos feitos ÷ total', concluida: 'tarefa concluída' }[t.progresso_origem] || '';
    const passos = Array.isArray(t.passos) ? t.passos : [];
    const anexos = Array.isArray(t.anexos) ? t.anexos : [];
    let h = `<article class="mz-cartao est-${sel.classe}${fechada ? ' fechada' : ''}${o.demo ? ' demo' : ''}" id="t${id}" ${atrib} data-estado="${esc(estado)}">`;
    h += `<button type="button" class="mz-cab" ${atrib} data-acao="abrir" aria-expanded="${o.aberto ? 'true' : 'false'}">` +
      `<span class="mz-tit">${esc(t.titulo)}${o.demo ? ' <em>(demonstração)</em>' : ''}</span>` +
      `<span class="mz-selo ${sel.classe}">${esc(sel.texto)}</span></button>`;
    if ((estado === ESTADO_DONO || estado === 'travada') && t.motivo) {
      h += `<p class="mz-motivo"><b>${estado === 'travada' ? 'Travou porque' : 'Precisa de você'}:</b> ${esc(t.motivo)}</p>`;
    }
    h += pct == null
      ? '<div class="mz-prog" data-tour-alvo="progresso"><span class="mz-semmedida">sem medida</span></div>'
      : `<div class="mz-prog" data-tour-alvo="progresso"><div class="mz-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(pct))}"` +
        `${origemProg ? ` title="${esc(origemProg)}"` : ''}><i style="width:${pct}%"></i></div><span class="mz-pnum">${esc(prog)}</span></div>`;
    if (passos.length) {
      h += '<ul class="mz-passos">' + passos.map(p => `<li class="${p.feito ? 'feito' : ''}"><span aria-hidden="true">${p.feito ? '✓' : '○'}</span> ${esc(p.texto)}</li>`).join('') + '</ul>';
    }
    if (t.nota) h += `<p class="mz-nota">${esc(t.nota)}</p>`;
    if (t.origem) h += `<p class="mz-origem">${esc(t.origem)}</p>`;
    const ligacoes = [];
    if (t.link) ligacoes.push(linkHtml(t.link, 'Ver o trabalho'));
    for (const a of anexos) ligacoes.push(linkHtml(a.url, a.rotulo || a.url));
    if (ligacoes.length) h += '<p class="mz-links">' + ligacoes.join('') + '</p>';
    h += `<p class="mz-quando">${esc(haMin(t.atualizada_ha_min))}</p>`;
    if (o.msg) h += htmlErros(o.msg);
    if (o.aberto) {
      h += '<div class="mz-detalhes">';
      if (o.form) {
        h += htmlFormCartao(t, o.form);
      } else {
        h += '<div class="mz-acoes" role="group" aria-label="Ações do dono">';
        if (estado === ESTADO_DONO || estado === 'travada') h += `<button type="button" class="mz-btn pri" ${atrib} data-acao="responder">Responder</button>`;
        if (!fechada) {
          h += `<button type="button" class="mz-btn" ${atrib} data-acao="concluir">Concluir</button>` +
            `<button type="button" class="mz-btn" ${atrib} data-acao="cancelar">Cancelar</button>`;
        } else {
          h += `<button type="button" class="mz-btn" ${atrib} data-acao="reabrir">Reabrir</button>`;
        }
        h += `<button type="button" class="mz-btn" ${atrib} data-acao="editar">Editar</button></div>`;
      }
      h += `<h4 class="mz-h4">Histórico</h4><div class="mz-hist">${htmlHistorico(o.demo ? [] : o.eventos)}</div></div>`;
    }
    return h + '</article>';
  }

  const puras = { esc, rotuloEstado, textoProgresso, haMin, agrupaPorAgente, textoOrigem, urlSegura, fraseErro, htmlCartao, htmlHistorico, htmlFormCartao, formataQuando };
  if (typeof document === 'undefined') return puras;

  /* ───────────── navegador ───────────── */
  const $ = id => document.getElementById(id);
  const INTERVALO_MS = 15000;
  const CHAVE_ABA = 'dgclaw:mesa:aba';

  function guardado(chave, valor) {
    try {
      if (valor === undefined) return localStorage.getItem(chave);
      localStorage.setItem(chave, valor);
    } catch (e) { console.warn('mesa: localStorage indisponível:', e.message); }
    return null;
  }

  /* ── Registro de abas ── */
  const abas = [];           // { id, titulo, montar, bolinhaFn, botao, painel, montada }
  let abasIniciadas = false;
  let abaAtual = null;
  const ouvintesAba = [];

  function bolinha(id, ligada) {
    const a = abas.find(x => x.id === id);
    if (a && a.botao) a.botao.classList.toggle('com-bolinha', !!ligada);
  }

  function registrar(def) {
    if (!def || !def.id || typeof def.montar !== 'function') {
      console.warn('mesa: registrar() precisa de { id, titulo, montar }', def);
      return null;
    }
    if (abas.some(a => a.id === def.id)) { console.warn('mesa: aba já registrada:', def.id); return null; }
    const aba = { id: def.id, titulo: def.titulo || def.id, montar: def.montar, montada: false, botao: null, painel: null };
    abas.push(aba);
    const interruptor = v => bolinha(aba.id, v);
    aba.interruptor = interruptor;
    if (typeof def.bolinha === 'function') {
      try { def.bolinha(interruptor); } catch (e) { console.warn('mesa: bolinha() da aba ' + def.id + ' falhou:', e); }
    }
    if (abasIniciadas) { criaAba(aba); escolheAba(abaDesejada()); }
    return { bolinha: interruptor };
  }

  function criaAba(aba) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mz-aba'; b.id = 'mzAba-' + aba.id;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', 'false');
    b.textContent = aba.titulo;
    b.onclick = () => escolheAba(aba.id, true);
    $('mzAbas').appendChild(b);
    const p = document.createElement('div');
    p.className = 'mz-painel-aba'; p.id = 'mzPainel-' + aba.id; p.hidden = true;
    p.setAttribute('role', 'tabpanel');
    $('mzPaineis').appendChild(p);
    aba.botao = b; aba.painel = p;
  }

  function abaDesejada() {
    const h = (location.hash || '').replace(/^#/, '');
    if (/^t\d+$/.test(h)) return 'tarefas';
    if (h && abas.some(a => a.id === h)) return h;
    const g = guardado(CHAVE_ABA);
    if (g && abas.some(a => a.id === g)) return g;
    return 'tarefas';
  }

  function escolheAba(id, deUsuario) {
    const aba = abas.find(a => a.id === id) || abas[0];
    if (!aba) return;
    for (const a of abas) {
      const on = a === aba;
      a.botao.classList.toggle('ativa', on);
      a.botao.setAttribute('aria-selected', on ? 'true' : 'false');
      a.painel.hidden = !on;
    }
    abaAtual = aba.id;
    bolinha(aba.id, false);
    if (deUsuario) {
      guardado(CHAVE_ABA, aba.id);
      history.replaceState(null, '', aba.id === 'tarefas' ? location.pathname : '#' + aba.id);
    }
    if (!aba.montada) {
      aba.montada = true;
      try { aba.montar(aba.painel, { bolinha: aba.interruptor }); } catch (e) {
        console.warn('mesa: a aba ' + aba.id + ' falhou ao montar:', e);
        aba.painel.innerHTML = `<div class="mz-erro" role="alert"><p>Não consegui montar a aba "${esc(aba.titulo)}": ${esc(e && e.message)}.</p></div>`;
      }
    }
    for (const f of ouvintesAba) f(aba.id);
  }

  raiz.DGMesaAbas = { registrar, bolinha };

  /* ── Aba Tarefas ── */
  const E = {
    agentes: [], tarefas: [], contagem: null, etag: null,
    filtroAgentes: new Set(), dia: 'hoje',
    abertos: new Set(), eventos: {}, form: null, msg: {},
    mostraVazios: false, demo: false, pendente: false, ocupado: false,
    focoId: null, ativa: false, jaCarregou: false,
  };
  const els = {};

  function setErroCarga(texto) {
    els.erro.innerHTML = texto
      ? `<div class="mz-erro mz-erro-carga" role="alert"><p>${esc(texto)}</p>` +
        '<button type="button" class="mz-btn pri" data-acao="recarregar">Tentar de novo</button></div>'
      : '';
  }

  async function lerJson(r) {
    try { return await r.json(); } catch (e) { console.warn('mesa: resposta sem JSON (código ' + r.status + '):', e.message); return null; }
  }

  function vaiParaLogin() { location.href = '/login?next=' + encodeURIComponent('/mesa'); }

  async function carregaAgentes() {
    let r;
    try { r = await fetch('/api/v1/agents', { credentials: 'same-origin', headers: { Accept: 'application/json' } }); }
    catch (e) { throw new Error('Não consegui falar com o servidor para listar os agentes (' + e.message + ').'); }
    if (r.status === 401) { vaiParaLogin(); throw new Error('Sua sessão expirou. Redirecionando para o login...'); }
    const d = await lerJson(r);
    if (!r.ok || !d || !Array.isArray(d.agentes)) {
      throw new Error('Não consegui carregar a lista de agentes: ' + fraseErro(d, r.status).texto);
    }
    E.agentes = d.agentes;
  }

  /* forca = ignora o ETag. Devolve true se a tela mudou. */
  async function carrega(forca) {
    try {
      if (!E.agentes.length) await carregaAgentes();
      const h = { Accept: 'application/json' };
      if (E.etag && !forca) h['If-None-Match'] = E.etag;
      let r;
      try { r = await fetch('/api/v1/tarefas?dia=' + encodeURIComponent(E.dia), { credentials: 'same-origin', headers: h, cache: 'no-store' }); }
      catch (e) { throw new Error('Não consegui falar com o servidor (' + e.message + '). Verifique a conexão.'); }
      if (r.status === 304) { setErroCarga(''); return false; }
      if (r.status === 401) { vaiParaLogin(); throw new Error('Sua sessão expirou. Redirecionando para o login...'); }
      const d = await lerJson(r);
      if (!r.ok || !d || !Array.isArray(d.tarefas)) {
        const f = fraseErro(d, r.status);
        throw new Error((r.status === 503 ? 'A mesa está indisponível: ' : 'Não consegui carregar a mesa: ') + f.texto);
      }
      E.tarefas = d.tarefas; E.contagem = d.contagem || null;
      E.etag = r.headers.get('ETag'); E.jaCarregou = true;
      setErroCarga('');
      return true;
    } catch (e) {
      console.warn('mesa: falha ao carregar:', e);
      setErroCarga(e.message);
      return false;
    }
  }

  async function atualiza(forca) {
    if (E.form || E.ocupado) { E.pendente = true; return; }
    E.pendente = false;
    const mudou = await carrega(forca);
    if (mudou || forca) { renderFiltros(); render(); }
    if (E.focoId != null) focaTarefa(E.focoId);
  }

  function tarefasVisiveis() {
    if (E.demo && !E.tarefas.length) {
      const ag = E.agentes[0];
      return [{ id: 0, agente: ag ? ag.id : 'exemplo', titulo: 'Roteiro do reels de exemplo', estado: ESTADO_DONO, aberta: true, parada: false,
        progresso: 50, progresso_origem: 'passos', motivo: 'Gancho A ou B? Os dois estão na conversa.', nota: 'escrevendo o gancho',
        passos: [{ texto: 'pesquisa', feito: true }, { texto: 'roteiro', feito: false }], origem: 'Dono, 05/10 15h42: faz o roteiro do reels',
        versao: '0', atualizada_ha_min: 3, _demo: true }];
    }
    return E.tarefas.filter(t => !E.filtroAgentes.size || E.filtroAgentes.has(t.agente));
  }

  function avatar(a) {
    const img = a.avatar_img || (/^https:\/\//i.test(a.avatar || '') ? a.avatar : '');
    const cor = esc(a.cor || '#2f9e5e');
    return `<span class="mz-foto" style="background:${cor}">${img ? `<img src="${esc(img)}" alt="">` : esc(a.avatar || (a.nome || '?').slice(0, 1))}</span>`;
  }

  function render() {
    const y = window.scrollY;
    const visiveis = tarefasVisiveis();
    const grupos = agrupaPorAgente(visiveis, E.agentes)
      .filter(g => !E.filtroAgentes.size || E.filtroAgentes.has(g.agente.id) || g.tarefas.length);
    const comTarefa = grupos.filter(g => g.tarefas.length), sem = grupos.filter(g => !g.tarefas.length);
    const bloco = g => {
      const abertas = g.tarefas.filter(t => t.aberta).length;
      return `<section class="mz-bloco" data-agente="${esc(g.agente.id)}">` +
        `<header class="mz-bloco-cab">${avatar(g.agente)}<h3>${esc(g.agente.nome)}</h3>` +
        `<span class="mz-conta">${abertas} ${abertas === 1 ? 'aberta' : 'abertas'}</span>` +
        `<button type="button" class="mz-ajuda" data-acao="ajuda-cartao" title="Como ler um cartão" aria-label="Como ler um cartão">?</button></header>` +
        (g.tarefas.length
          ? '<div class="mz-cartoes">' + g.tarefas.map(t => htmlCartao(t, {
            aberto: E.abertos.has(t.id), eventos: E.eventos[t.id], demo: !!t._demo,
            form: E.form && E.form.id === t.id ? E.form : null, msg: E.msg[t.id],
          })).join('') + '</div>'
          : '<p class="mz-vazio">Nenhuma tarefa neste filtro.</p>') +
        '</section>';
    };
    let h = comTarefa.map(bloco).join('');
    if (!comTarefa.length && E.jaCarregou) {
      h = '<p class="mz-vazio grande">Nenhuma tarefa neste filtro. Quando um agente começar um trabalho, ele aparece aqui.</p>';
    }
    if (sem.length) {
      h += `<button type="button" class="mz-btn mz-vazios-btn" data-acao="vazios" aria-expanded="${E.mostraVazios}">` +
        `${E.mostraVazios ? 'esconder' : 'mostrar'} agentes sem tarefa (${sem.length})</button>`;
      if (E.mostraVazios) h += '<div class="mz-sem">' + sem.map(bloco).join('') + '</div>';
    }
    els.board.innerHTML = h;
    window.scrollTo(0, y);
    renderContagem();
    bolinha('tarefas', abaAtual !== 'tarefas' && E.contagem && E.contagem.esperando_dono > 0);
  }

  function renderContagem() {
    const c = E.contagem;
    if (!c) { els.contagem.innerHTML = '<span class="mz-vazio">Carregando a mesa...</span>'; return; }
    const item = (n, rot, cl) => `<span class="mz-cont ${cl}${n ? ' tem' : ''}"><b>${esc(n)}</b> ${esc(rot)}</span>`;
    els.contagem.innerHTML = item(c.esperando_dono, 'esperando você', 'esperando') + item(c.travadas, 'travadas', 'travada') +
      item(c.paradas, 'paradas', 'parada') + item(c.abertas, 'abertas', 'abertas');
  }

  function renderFiltros() {
    const chips = E.agentes.map(a => `<button type="button" class="mz-chip${E.filtroAgentes.has(a.id) ? ' on' : ''}" data-acao="chip" data-agente="${esc(a.id)}" aria-pressed="${E.filtroAgentes.has(a.id)}">${esc(a.nome)}</button>`).join('');
    const ehData = /^\d{4}-\d{2}-\d{2}$/.test(E.dia);
    els.filtros.innerHTML =
      `<div class="mz-grupo" role="group" aria-label="Filtrar por agente">${chips}</div>` +
      '<div class="mz-grupo" role="group" aria-label="Filtrar por dia">' +
      `<button type="button" class="mz-chip${E.dia === 'hoje' ? ' on' : ''}" data-acao="dia" data-dia="hoje">Hoje</button>` +
      `<button type="button" class="mz-chip${E.dia === 'todos' ? ' on' : ''}" data-acao="dia" data-dia="todos">Todos</button>` +
      `<input type="date" class="mz-data${ehData ? ' on' : ''}" id="mzData" aria-label="Escolher um dia" value="${ehData ? esc(E.dia) : ''}"></div>`;
  }

  function focaTarefa(id) {
    const el = document.getElementById('t' + id);
    if (!el) return false;
    E.focoId = null;
    if (!E.abertos.has(id)) { E.abertos.add(id); abreDetalhes(id); render(); }
    const alvo = document.getElementById('t' + id);
    alvo.scrollIntoView({ block: 'center' });
    alvo.classList.add('destaque');
    setTimeout(() => alvo.classList.remove('destaque'), 2600);
    return true;
  }

  async function abreDetalhes(id) {
    if (id === 0) return;
    try {
      const r = await fetch('/api/v1/tarefas/' + encodeURIComponent(id), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await lerJson(r);
      if (!r.ok || !d || !d.tarefa) throw new Error(fraseErro(d, r.status).texto);
      E.eventos[id] = Array.isArray(d.tarefa.eventos) ? d.tarefa.eventos : [];
    } catch (e) {
      console.warn('mesa: histórico da tarefa ' + id + ' falhou:', e);
      E.eventos[id] = 'erro';
    }
    if (E.abertos.has(id)) render();
  }

  /* ── Escritas do dono ── */
  async function escreve(metodo, url, corpo, versao) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (versao != null) h['If-Match'] = '"' + versao + '"';
    let r;
    try { r = await fetch(url, { method: metodo, headers: h, credentials: 'same-origin', body: corpo == null ? undefined : JSON.stringify(corpo) }); }
    catch (e) {
      console.warn('mesa: ' + metodo + ' ' + url + ' falhou:', e);
      return { ok: false, status: 0, erro: { texto: 'Não consegui falar com o servidor (' + e.message + '). Nada foi gravado; tente de novo.', campos: {} } };
    }
    if (r.status === 401) { vaiParaLogin(); }
    const d = await lerJson(r);
    const ok = r.ok && !(d && d.ok === false);
    return { ok, status: r.status, dados: d, erro: ok ? null : fraseErro(d, r.status) };
  }

  const FRASE_412 = 'Esta tarefa mudou enquanto você editava; recarreguei a versão nova.';

  async function aplica(id, metodo, corpo, rotuloErro) {
    const t = E.tarefas.find(x => x.id === id);
    if (!t) return;
    E.ocupado = true; delete E.msg[id];
    const res = await escreve(metodo, '/api/v1/tarefas/' + encodeURIComponent(id), corpo, t.versao);
    E.ocupado = false;
    if (res.ok) {
      E.form = null; delete E.eventos[id];
      await atualiza(true);
      if (E.abertos.has(id)) abreDetalhes(id);
      return;
    }
    console.warn('mesa: ' + rotuloErro + ' recusado (' + res.status + '):', res.dados || res.erro);
    const erro = res.status === 412 ? { texto: FRASE_412, campos: {} } : res.erro;
    if (E.form && E.form.id === id && res.status !== 412) { E.form.erro = erro; }
    else { E.form = null; E.msg[id] = erro; }
    if (res.status === 412) { E.form = null; E.msg[id] = erro; delete E.eventos[id]; await carrega(true); renderFiltros(); }
    render();
  }

  function valoresDoForm(f) {
    const v = {};
    for (const el of f.elements) if (el.name) v[el.name] = el.value;
    return v;
  }

  async function enviaForm(f) {
    const id = Number(f.dataset.id);
    const t = E.tarefas.find(x => x.id === id);
    if (!t || !E.form) return;
    const v = valoresDoForm(f);
    E.form.valores = v;
    if (E.form.tipo === 'responder') {
      if (!v.nota.trim()) { E.form.erro = { texto: 'Escreva a resposta antes de enviar.', campos: {} }; render(); return; }
      return aplica(id, 'PATCH', { nota: v.nota.trim(), estado: 'fazendo' }, 'resposta');
    }
    if (E.form.tipo === 'cancelar') {
      return aplica(id, 'DELETE', v.motivo.trim() ? { motivo: v.motivo.trim() } : null, 'cancelamento');
    }
    const corpo = {};
    if (v.titulo.trim() !== t.titulo) corpo.titulo = v.titulo.trim();
    if (v.nota.trim() !== (t.nota || '')) corpo.nota = v.nota.trim();
    if (v.link.trim() !== (t.link || '')) corpo.link = v.link.trim() || null;
    const prog = v.progresso.trim();
    if (prog === '') { if (t.progresso_origem === 'informado') corpo.progresso = null; }
    else if (Number(prog) !== t.progresso || t.progresso_origem !== 'informado') corpo.progresso = Number(prog);
    return aplica(id, 'PATCH', corpo, 'edição');
  }

  /* ── Nova tarefa ── */
  function abreNova() {
    if (els.nova.firstChild) { els.nova.innerHTML = ''; els.novaBtn.setAttribute('aria-expanded', 'false'); atualizaSePendente(); return; }
    const padrao = E.filtroAgentes.size === 1 ? [...E.filtroAgentes][0] : (E.agentes[0] && E.agentes[0].id);
    const opAg = E.agentes.map(a => `<option value="${esc(a.id)}"${a.id === padrao ? ' selected' : ''}>${esc(a.nome)}</option>`).join('');
    els.nova.innerHTML = '<form class="mz-form mz-nova-form" id="mzNovaForm" novalidate>' +
      '<h4>Nova tarefa</h4>' +
      `<label>Agente<select name="agente">${opAg}</select></label>` +
      '<label>Título<input name="titulo" type="text" maxlength="120" required></label>' +
      `<label>Origem (o pedido, com a data)<input name="origem" type="text" maxlength="300" required value="${esc(textoOrigem(new Date()))}"></label>` +
      '<label>Tipo<select name="tipo"><option value="outro">outro</option><option value="conteudo">conteúdo</option><option value="desenvolvimento">desenvolvimento</option><option value="projeto">projeto</option></select></label>' +
      '<label>Passos (um por linha, opcional)<textarea name="passos" rows="3"></textarea></label>' +
      '<div id="mzNovaErro"></div>' +
      '<div class="mz-linha"><button type="submit" class="mz-btn pri">Criar tarefa</button><button type="button" class="mz-btn" data-acao="fechar-nova">Voltar</button></div></form>';
    els.novaBtn.setAttribute('aria-expanded', 'true');
    els.nova.querySelector('[name=titulo]').focus();
  }

  function atualizaSePendente() { if (E.pendente && !E.form) atualiza(); }

  async function enviaNova(f) {
    const v = valoresDoForm(f);
    const corpo = { agente: v.agente, titulo: v.titulo.trim(), origem: v.origem.trim(), tipo: v.tipo };
    const passos = v.passos.split('\n').map(s => s.trim()).filter(Boolean);
    if (passos.length) corpo.passos = passos.map(texto => ({ texto, feito: false }));
    const caixa = $('mzNovaErro');
    if (!corpo.agente) { caixa.innerHTML = htmlErros({ texto: 'Escolha o agente que vai fazer a tarefa.', campos: {} }); return; }
    E.ocupado = true;
    const res = await escreve('POST', '/api/v1/tarefas', corpo, null);
    E.ocupado = false;
    if (!res.ok) {
      console.warn('mesa: criar tarefa recusado (' + res.status + '):', res.dados || res.erro);
      caixa.innerHTML = htmlErros(res.erro);
      return;
    }
    els.nova.innerHTML = ''; els.novaBtn.setAttribute('aria-expanded', 'false');
    E.focoId = res.dados && res.dados.tarefa ? res.dados.tarefa.id : null;
    await atualiza(true);
  }

  /* ── Cliques ── */
  function aoClicar(ev) {
    const b = ev.target.closest('[data-acao]');
    if (!b) return;
    const acao = b.dataset.acao;
    const id = b.dataset.id != null ? Number(b.dataset.id) : null;
    if (id === 0 && acao !== 'abrir') return;       // cartão de demonstração do tutorial
    switch (acao) {
      case 'abrir':
        if (E.abertos.has(id)) { E.abertos.delete(id); if (E.form && E.form.id === id) E.form = null; }
        else { E.abertos.add(id); abreDetalhes(id); }
        delete E.msg[id]; render(); atualizaSePendente(); break;
      case 'responder': case 'editar': case 'cancelar':
        delete E.msg[id]; E.form = { id, tipo: acao, valores: {}, erro: null }; render(); break;
      case 'concluir': aplica(id, 'PATCH', { estado: 'concluida' }, 'conclusão'); break;
      case 'reabrir': aplica(id, 'PATCH', { estado: 'fazendo' }, 'reabertura'); break;
      case 'fechar-form': E.form = null; render(); atualizaSePendente(); break;
      case 'chip': {
        const a = b.dataset.agente;
        if (E.filtroAgentes.has(a)) E.filtroAgentes.delete(a); else E.filtroAgentes.add(a);
        renderFiltros(); render(); break;
      }
      case 'dia': E.dia = b.dataset.dia; E.etag = null; renderFiltros(); atualiza(true); break;
      case 'vazios': E.mostraVazios = !E.mostraVazios; render(); break;
      case 'recarregar': E.agentes = []; atualiza(true); break;
      case 'nova': abreNova(); break;
      case 'fechar-nova': abreNova(); break;
      case 'ajuda-contagem': iniciaPassos([passoContagem()]); break;
      case 'ajuda-filtros': iniciaPassos([passoFiltros()]); break;
      case 'ajuda-cartao': iniciaPassos(passosCartao(), true); break;
      default: console.warn('mesa: ação desconhecida:', acao);
    }
  }

  function aoEnviar(ev) {
    const f = ev.target;
    if (!(f instanceof HTMLFormElement)) return;
    ev.preventDefault();
    if (f.id === 'mzNovaForm') enviaNova(f);
    else if (f.classList.contains('mz-form')) enviaForm(f);
  }

  /* ── Tutorial ── */
  const passoContagem = () => ({ alvo: '#mzContagem', titulo: 'A contagem do topo',
    oque: 'Quantas tarefas pedem a sua atenção agora: esperando você, travadas, paradas e o total de abertas.',
    como: 'O servidor conta a mesa inteira, de todos os agentes. "Parada" é uma tarefa em "fazendo" que ninguém atualiza há 45 minutos.',
    porque: 'Você vê de relance se alguém está esperando uma resposta sua, sem precisar abrir cartão por cartão.' });
  const passoFiltros = () => ({ alvo: '#mzFiltros', titulo: 'Filtros por agente e por dia',
    oque: 'Os botões com o nome dos agentes mostram só o trabalho deles. Hoje, Todos e a data escolhem o dia das tarefas já fechadas.',
    como: 'Marque um ou mais agentes. As tarefas abertas aparecem sempre; o dia só vale para as concluídas e canceladas (pelo dia em que foram fechadas).',
    porque: 'Com muitos agentes a mesa fica longa. O filtro deixa só o que você quer olhar agora.' });
  function passosCartao() {
    const abre = () => { const t = tarefasVisiveis()[0]; if (t) { E.abertos.add(t.id); render(); } };
    const fecha = () => { const t = tarefasVisiveis()[0]; if (t) { E.abertos.delete(t.id); render(); } };
    return [
      { alvo: '.mz-cartao', titulo: 'O cartão da tarefa',
        oque: 'Uma tarefa de um agente: o título, o estado, o que ele está fazendo agora e quando atualizou pela última vez.',
        como: 'O agente cria e atualiza o cartão sozinho enquanto trabalha. Toque no título para abrir os detalhes. A nota é o sinal de vida: uma linha com o que está acontecendo.',
        porque: 'Você acompanha o trabalho sem interromper a conversa com o agente.' },
      { alvo: '.mz-cartao .mz-selo', titulo: 'O selo de estado',
        oque: 'Diz em que pé a tarefa está: fazendo, travada, esperando você, parada?, concluída ou cancelada.',
        como: '"Travada" e "esperando você" vêm sempre com o motivo em destaque e sobem para o topo. "Parada?" aparece quando uma tarefa em "fazendo" passa de 45 minutos sem nenhuma atualização.',
        porque: 'O que precisa de você fica no alto, e o que parou sem avisar não passa despercebido.' },
      { alvo: '.mz-cartao .mz-prog', titulo: 'A barra de progresso',
        oque: 'Quanto da tarefa já foi feito.',
        como: 'Se o agente informou um número, vale o número. Sem número, é a conta dos passos feitos ÷ total. Sem nenhum dos dois, aparece "sem medida": a tarefa não foi medida, o que é diferente de 0%.',
        porque: 'Mostrar 0% numa tarefa que ninguém mediu seria mentira. "Sem medida" diz a verdade.' },
      { alvo: '.mz-cartao .mz-acoes', antes: abre, depois: fecha, titulo: 'As ações do dono',
        oque: 'Responder, Concluir, Cancelar, Reabrir e Editar. Você mexe na tarefa de qualquer agente.',
        como: 'Responder grava sua resposta na nota, devolve a tarefa para "fazendo" e avisa o agente. Cancelar pede um motivo opcional e não apaga: a tarefa fica registrada. Se a tarefa mudar enquanto você edita, a tela avisa e recarrega.',
        porque: 'O agente fica sabendo na hora do que você decidiu, sem você precisar repetir na conversa.' },
      { alvo: '.mz-cartao .mz-hist', antes: abre, depois: fecha, titulo: 'O histórico',
        oque: 'A lista de tudo o que aconteceu na tarefa: quem mexeu, quando e o que mudou.',
        como: 'Cada criação e cada mudança é registrada pelo servidor, com o antes e o depois de cada campo. Aqui aparecem os 50 eventos mais recentes.',
        porque: 'Você confere o que o agente fez e o que você mesmo respondeu.' },
    ];
  }
  function passosPagina() {
    return [
      { alvo: '#mzAbas', titulo: 'As abas', oque: 'Cada aba é uma frente da mesa. "Tarefas" é a mesa; outras frentes podem aparecer ao lado.',
        como: 'A aba escolhida fica guardada neste aparelho. Um endereço terminando em #nome-da-aba abre direto nela.',
        porque: 'Tudo o que acompanha o trabalho dos agentes fica numa página só.' },
      passoContagem(), passoFiltros(),
      { alvo: '#mzNovaBtn', titulo: 'Nova tarefa', oque: 'Cria uma tarefa para um agente, em nome do dono.',
        como: 'Escolha o agente, escreva o título e o pedido (a origem já vem com a data). Os passos, um por linha, são opcionais e alimentam a barra de progresso.',
        porque: 'Quando você quer que o trabalho fique acompanhado desde o começo, não precisa esperar o agente criar o cartão.' },
      { alvo: '.mz-bloco', titulo: 'O bloco do agente', oque: 'Todas as tarefas de um agente juntas, com a foto, o nome e quantas estão abertas.',
        como: 'Os blocos seguem a ordem dos agentes. Agentes sem tarefa no filtro atual ficam escondidos atrás do botão "mostrar agentes sem tarefa".',
        porque: 'Você sabe quem está em quê sem misturar o trabalho de um agente com o de outro.' },
      ...passosCartao(),
    ];
  }
  function iniciaPassos(passos, soCartao) {
    if (!raiz.DGTour) { setErroCarga('A visita guiada não carregou (tour.js). Recarregue a página.'); return; }
    if (!E.tarefas.length) { E.demo = true; render(); }
    raiz.DGTour.inicia({ passos, aoFechar: () => { if (E.demo) { E.demo = false; render(); } } });
  }

  /* ── Montagem da aba ── */
  function montaTarefas(el) {
    el.innerHTML =
      '<div class="mz-topo2">' +
      '<div class="mz-contagem-lin"><div id="mzContagem" class="mz-contagem" data-tour="mz-contagem"></div>' +
      '<button type="button" class="mz-ajuda" data-acao="ajuda-contagem" title="O que é a contagem" aria-label="O que é a contagem">?</button></div>' +
      '<button type="button" class="mz-btn pri" id="mzNovaBtn" data-acao="nova" aria-expanded="false">+ Nova tarefa</button></div>' +
      '<div id="mzNova"></div>' +
      '<div class="mz-filtros-lin"><div id="mzFiltros" class="mz-filtros"></div>' +
      '<button type="button" class="mz-ajuda" data-acao="ajuda-filtros" title="Como funcionam os filtros" aria-label="Como funcionam os filtros">?</button></div>' +
      '<div id="mzErroCarga"></div><div id="mzBoard" class="mz-board"></div>';
    els.contagem = $('mzContagem'); els.nova = $('mzNova'); els.novaBtn = $('mzNovaBtn');
    els.filtros = $('mzFiltros'); els.erro = $('mzErroCarga'); els.board = $('mzBoard');
    el.addEventListener('click', aoClicar);
    el.addEventListener('submit', aoEnviar);
    el.addEventListener('change', ev => {
      if (ev.target.id === 'mzData') { E.dia = ev.target.value || 'hoje'; E.etag = null; renderFiltros(); atualiza(true); }
    });
    renderContagem(); renderFiltros();
    E.ativa = true;
    atualiza(true).then(aplicaHashTarefa);
    setInterval(tick, INTERVALO_MS);
  }

  function tick() {
    if (document.visibilityState !== 'visible' || abaAtual !== 'tarefas') return;
    atualiza(false);
  }

  function aplicaHashTarefa() {
    const m = /^#t(\d+)$/.exec(location.hash || '');
    if (!m) return;
    const id = Number(m[1]);
    if (focaTarefa(id)) return;
    if (E.dia !== 'todos') { E.dia = 'todos'; E.etag = null; E.focoId = id; renderFiltros(); atualiza(true); }
    else setErroCarga('A tarefa #' + id + ' não está na mesa.');
  }

  /* ── Boot ── */
  function boot() {
    registrar({ id: 'tarefas', titulo: 'Tarefas', montar: montaTarefas });
    if (raiz.DGAvisos && typeof raiz.DGAvisos.montar === 'function' && !abas.some(a => a.id === 'avisos')) {
      registrar({ id: 'avisos', titulo: raiz.DGAvisos.titulo || 'Quadro de avisos', montar: raiz.DGAvisos.montar, bolinha: raiz.DGAvisos.bolinha });
    }
    abasIniciadas = true;
    for (const a of abas) criaAba(a);
    escolheAba(abaDesejada());
    // o botão Tutorial agora fica no cabeçalho da casca (casca.js), que chama esta função
    raiz.DGMesaTutorial = () => {
      if (abaAtual !== 'tarefas') escolheAba('tarefas', true);
      iniciaPassos(passosPagina());
    };
    window.addEventListener('hashchange', () => {
      escolheAba(abaDesejada());
      if (abaAtual === 'tarefas') aplicaHashTarefa();
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn('sw:', e.message));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return puras;
});
