'use strict';
/* logs.js: a tela "Logs" (/logs): o histórico do que cada agente fez, só para o dono. Lê GET /api/v1/logs/agentes,
   /agentes/:slug/sessoes e /agentes/:slug/eventos. Contrato: web/docs/LOGS.md.

   O texto de um log não é de confiança (nasceu do que o agente leu e escreveu). Por isso esta tela monta tudo com
   createElement e textContent: nenhum dado de log vira HTML, markdown, iframe ou link clicável.
   (web/test/logs-tela.test.js falha se este arquivo montar HTML por texto.)
   As funções que só montam texto ficam fora do DOM e têm teste. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGLogsTela = m;
})(this, function (raiz) {
  const TIPOS = [['mensagem', 'Mensagens'], ['comando', 'Comandos'], ['arquivo', 'Arquivos'], ['ferramenta', 'Ferramentas'], ['sistema', 'Sistema']];
  const ROTULO_TIPO = { mensagem: 'Mensagem', comando: 'Comando', arquivo: 'Arquivo', ferramenta: 'Ferramenta', sistema: 'Sistema' };
  const ROTULO_MOTOR = { claude: 'Claude', codex: 'Codex' };
  const ROTULO_ESTADO = { ok: 'Lida', parcial: 'Parcial', vazia: 'Vazia', ausente: 'Ausente', ilegivel: 'Ilegível', nao_verificada: 'Não verificada' };
  const ROTULO_PAPEL = { pessoa: 'Pessoa', agente: 'Agente', sistema: 'Sistema' };
  const TIPOS_COM_RESULTADO = ['comando', 'arquivo', 'ferramenta'];

  /* ── textos e contas puras ──────────────────────────────────────────────── */
  function consulta(f, cursor) {
    const p = new URLSearchParams();
    if (f.desde) p.set('desde', f.desde);
    if (f.ate) p.set('ate', f.ate);
    if (f.tipos && f.tipos.length) p.set('tipo', f.tipos.join(','));
    if (f.q) p.set('q', f.q);
    if (f.sessao) p.set('sessao', f.sessao);
    if (cursor) p.set('cursor', cursor);
    p.set('limite', '50');
    return p.toString();
  }

  function temFiltro(f) { return !!(f.desde || f.ate || (f.tipos && f.tipos.length) || f.q || f.sessao); }

  function quando(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const d = new Date(ms);
    const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return dia + ' ' + hora;
  }

  function tamanho(b) {
    if (typeof b !== 'number') return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  function sessaoCurta(ev) { return (ev.sessao || String(ev.id || '').split(':')[0]).slice(0, 8); }

  function descreveFonte(f) {
    const motor = ROTULO_MOTOR[f.motor] || f.motor;
    if (f.estado === 'ok' || (f.estado === 'parcial' && typeof f.arquivos === 'number')) {
      return { titulo: motor + ': ' + ROTULO_ESTADO[f.estado], detalhe: f.arquivos + ' arquivo(s), ' + tamanho(f.bytes) + (f.ultima_atividade ? '. Última atividade em ' + quando(f.ultima_atividade) + '.' : '.') + (f.estado === 'parcial' ? ' Atenção: ' + (f.motivo || 'a lista pode estar incompleta') + '.' : '') };
    }
    return { titulo: motor + ': ' + (ROTULO_ESTADO[f.estado] || f.estado), detalhe: f.motivo || '' };
  }

  /* O que dizer quando a lista veio vazia. "Nada com os filtros", "o agente ainda não fez nada" e "não há fonte para ler" são três coisas diferentes. */
  function estadoVazio(fontes, filtrado, parcial, podeContinuar) {
    const lista = Array.isArray(fontes) ? fontes : [];
    if (!lista.some(f => f.estado === 'ok' || (f.estado === 'parcial' && f.arquivos > 0))) {
      const motivos = lista.map(f => (ROTULO_MOTOR[f.motor] || f.motor) + ': ' + (f.motivo || f.estado)).join(' ');
      return { tipo: 'faltando', texto: 'Não há histórico para ler deste agente. ' + motivos + ' Confira se o agente já conversou neste servidor e se o registro de agentes aponta para a pasta certa.' };
    }
    if (parcial && podeContinuar === false) return { tipo: 'parada', texto: 'A busca parou antes de olhar tudo e não conseguiu avançar. Leia o aviso acima e estreite o período ou o tipo.' };
    if (parcial) return { tipo: 'parcial', texto: 'Ainda não achei nada, mas a busca não olhou tudo. Toque em "Continuar procurando".' };
    if (filtrado) return { tipo: 'filtro', texto: 'Nada com esses filtros. Tente outro período, outro tipo ou outra palavra.' };
    return { tipo: 'nada', texto: 'O agente ainda não fez nada que apareça aqui.' };
  }

  function erroDaResposta(status, corpo) {
    const motivo = corpo && typeof corpo.erro === 'string' ? corpo.erro : '';
    if (status === 401) return 'Sua sessão venceu. Entre de novo em /login.';
    if (status === 403) return motivo || 'Só o dono do DG Claw vê os logs.';
    if (status === 429) return (motivo || 'Há outras buscas em andamento.') + ' Espere um instante e toque em Aplicar de novo.';
    if (status === 503) return (motivo || 'A lista de agentes está indisponível.') + ' Confira o registro de agentes no servidor.';
    return (motivo || 'O servidor respondeu com o erro ' + status + '.') + ' Tente de novo; se repetir, veja o log do Web (journalctl -u dgclaw-web).';
  }

  function resumoContagens(c) {
    if (!c) return '';
    const p = [];
    if (c.linhas_ilegiveis) p.push(c.linhas_ilegiveis + ' linha(s) com JSON quebrado');
    if (c.linhas_gigantes) p.push(c.linhas_gigantes + ' linha(s) grande(s) demais, puladas');
    if (c.sem_horario) p.push(c.sem_horario + ' registro(s) sem horário, omitidos');
    if (c.atalhos_ignorados) p.push(c.atalhos_ignorados + ' atalho(s) ignorado(s)');
    return p.length ? 'Nesta leitura: ' + p.join('; ') + '.' : '';
  }

  /* ── tutorial ───────────────────────────────────────────────────────────── */
  const PASSOS = {
    agente: [
      { alvo: '#secAgente', titulo: 'Escolher o agente',
        oque: 'A lista de todos os agentes do seu DG Claw, o Admin primeiro. A tela mostra o histórico de um por vez.',
        como: 'A lista vem do registro de agentes do servidor. Ao trocar, a tela busca de novo as fontes e a linha do tempo daquele agente.',
        porque: 'Cada agente tem a própria casa e o próprio histórico. Você escolhe de quem quer conferir o que foi feito.' },
    ],
    fontes: [
      { alvo: '#secFontes', titulo: 'De onde vêm os registros',
        oque: 'Um cartão por motor (Claude e Codex), dizendo se o histórico foi lido, está vazio, não existe ou não pôde ser lido, e por quê.',
        como: 'O servidor olha, somente para leitura, as pastas de sessão que o Claude Code e o Codex gravam na casa do agente. Conta os arquivos, soma o tamanho e pega a data da última modificação.',
        porque: 'Uma lista vazia pode querer dizer "o agente não fez nada" ou "o servidor não conseguiu ler". Os cartões separam as duas coisas.' },
    ],
    filtros: [
      { alvo: '#secFiltros', titulo: 'Filtros',
        oque: 'Período, tipo de ação, uma palavra para buscar e a sessão.',
        como: 'Os filtros viram parâmetros do pedido ao servidor. A busca por palavra olha o texto já mascarado (segredos aparecem como [segredo oculto]) e não diferencia maiúsculas nem acentos.',
        porque: 'Um agente pode ter milhares de registros. Filtrar leva você direto ao dia, ao comando ou à frase que procura.' },
    ],
    lista: [
      { alvo: '#secLista', titulo: 'A linha do tempo',
        oque: 'Os registros do mais novo para o mais antigo: mensagens, comandos, arquivos e ferramentas, cada um com horário, sessão e tipo. Toque em Detalhes para ver o comando, o caminho e o resultado.',
        como: 'O servidor lê os arquivos de trás para frente, em blocos, e junta os motores numa só ordem. Se o pedido gastar o orçamento antes de encher a página, aparece "Continuar procurando". O selo "horário suspeito" marca registro com hora depois da última modificação do arquivo.',
        porque: 'Para você conferir o que o agente fez sem abrir arquivo por arquivo. Lembre que isso não é prova: o agente pode reescrever a própria casa.' },
    ],
  };

  function passosPagina(doc) {
    const tem = sel => !doc || !!doc.querySelector(sel);
    return [].concat(PASSOS.agente, PASSOS.fontes, PASSOS.filtros, PASSOS.lista).filter(p => tem(p.alvo));
  }

  if (!raiz.document) {
    return { consulta, temFiltro, quando, tamanho, sessaoCurta, descreveFonte, estadoVazio, erroDaResposta, resumoContagens, passosPagina, PASSOS, TIPOS, ROTULO_TIPO };
  }

  /* ── parte com DOM ──────────────────────────────────────────────────────── */
  const doc = raiz.document;
  const $ = id => doc.getElementById(id);

  function el(tag, classe, texto) {
    const e = doc.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function limpar(no) { while (no.firstChild) no.removeChild(no.firstChild); }

  const est = { agentes: [], agente: null, tipos: new Set(), gen: 0, proximo: null, parcial: false, carregando: false, filtrado: false, ultimaFontes: [] };

  function msgGeral(texto) {
    const e = $('lgMsgGeral');
    e.textContent = texto || '';
    e.hidden = !texto;
  }

  async function pedir(caminho) {
    let r;
    try { r = await raiz.fetch(caminho, { headers: { Accept: 'application/json' }, cache: 'no-store' }); } catch (e) {
      throw new Error('Não consegui falar com o servidor (' + (e && e.message ? e.message : 'sem rede') + '). Confira a conexão e tente de novo.');
    }
    let corpo = null;
    try { corpo = await r.json(); } catch (_) { /* resposta que não é JSON */ }
    if (!r.ok || !corpo || corpo.ok === false) throw new Error(erroDaResposta(r.status, corpo));
    return corpo;
  }

  function pintaFontes(fontes) {
    const caixa = $('lgFontes');
    limpar(caixa);
    const grade = el('div', 'lg-fontes');
    for (const f of fontes || []) {
      const d = descreveFonte(f);
      const c = el('div', 'lg-fonte');
      c.appendChild(el('b', null, d.titulo));
      if (d.detalhe) c.appendChild(el('small', null, d.detalhe));
      grade.appendChild(c);
    }
    if (!grade.childNodes.length) grade.appendChild(el('p', 'lg-fraco', 'Este agente não tem fontes de histórico configuradas.'));
    caixa.appendChild(grade);
  }

  function pintaAvisos(avisos, contagens) {
    const caixa = $('lgAvisos');
    limpar(caixa);
    for (const a of avisos || []) {
      caixa.appendChild(el('p', 'lg-faixa lg-amarela', (a.arquivo ? a.arquivo + ': ' : '') + a.motivo));
    }
    const c = resumoContagens(contagens);
    if (c) caixa.appendChild(el('p', 'lg-faixa lg-neutra', c));
  }

  function linhaDetalhe(lista, rotulo, valor, pre) {
    if (valor == null || valor === '') return;
    lista.appendChild(el('dt', null, rotulo));
    const dd = el('dd');
    dd.appendChild(pre ? el('pre', null, String(valor)) : doc.createTextNode(String(valor)));
    lista.appendChild(dd);
  }

  function cartao(ev) {
    const c = el('article', 'lg-card');
    const topo = el('div', 'lg-topo');
    topo.appendChild(el('span', null, quando(ev.t)));
    topo.appendChild(el('span', 'lg-tag', ROTULO_TIPO[ev.tipo] || ev.tipo));
    if (ev.papel) topo.appendChild(el('span', 'lg-tag', ROTULO_PAPEL[ev.papel] || ev.papel));
    topo.appendChild(el('span', null, (ROTULO_MOTOR[ev.motor] || ev.motor) + ' · sessão ' + sessaoCurta(ev)));
    if (ev.subagente) topo.appendChild(el('span', 'lg-tag lg-sub', 'subagente'));
    if (ev.horario_suspeito) topo.appendChild(el('span', 'lg-tag lg-susp', 'horário suspeito'));
    c.appendChild(topo);
    c.appendChild(el('p', 'lg-titulo', ev.titulo));
    if (ev.texto) c.appendChild(el('p', 'lg-texto', ev.texto + (ev.truncado ? '\n[texto cortado]' : '')));

    const d = ev.detalhes || {};
    const temResultado = TIPOS_COM_RESULTADO.indexOf(ev.tipo) >= 0;
    const temDetalhe = d.comando || d.descricao || d.caminho || d.operacao || d.ferramenta || d.entrada || temResultado;
    if (temDetalhe) {
      const det = el('details', 'lg-detalhe');
      det.appendChild(el('summary', null, 'Detalhes'));
      const dl = el('dl');
      linhaDetalhe(dl, 'Comando', d.comando, true);
      linhaDetalhe(dl, 'Descrição', d.descricao);
      linhaDetalhe(dl, 'Operação', d.operacao);
      linhaDetalhe(dl, 'Arquivo', d.caminho);
      linhaDetalhe(dl, 'Ferramenta', d.ferramenta);
      linhaDetalhe(dl, 'Entrada', d.entrada, true);
      if (temResultado) {
        if (ev.resultado) {
          dl.appendChild(el('dt', ev.resultado.erro ? 'lg-erro-res' : null, ev.resultado.erro ? 'Resultado (com erro)' : 'Resultado'));
          const dd = el('dd');
          dd.appendChild(el('pre', null, ev.resultado.texto === '' ? '(resultado vazio)' : ev.resultado.texto + (ev.resultado.truncado ? '\n[resultado cortado]' : '')));
          dl.appendChild(dd);
        } else {
          dl.appendChild(el('dt', null, 'Resultado'));
          dl.appendChild(el('dd', null, 'sem resultado registrado'));
        }
      }
      det.appendChild(dl);
      c.appendChild(det);
    }
    return c;
  }

  function pintaEstado(texto, tipo) {
    const caixa = $('lgEstado');
    limpar(caixa);
    if (!texto) return;
    caixa.appendChild(el('p', tipo === 'erro' ? 'lg-faixa lg-vermelha' : tipo === 'faltando' ? 'lg-faixa lg-amarela' : 'lg-fraco', texto));
  }

  function pintaRodape() {
    const r = $('lgRodape');
    const b = $('lgMais');
    r.hidden = !est.proximo;
    b.textContent = est.parcial ? 'Continuar procurando' : 'Carregar mais';
    b.disabled = est.carregando;
  }

  function filtros() {
    return {
      desde: $('lgDesde').value, ate: $('lgAte').value, q: $('lgBusca').value.trim(), sessao: $('lgSessao').value,
      tipos: TIPOS.map(t => t[0]).filter(t => est.tipos.has(t)),
    };
  }

  async function busca(maisUma) {
    if (!est.agente) return;
    const gen = maisUma ? est.gen : ++est.gen;
    est.carregando = true;
    msgGeral('');
    if (!maisUma) { limpar($('lgLista')); est.proximo = null; est.parcial = false; pintaEstado('Carregando…'); }
    pintaRodape();
    const f = filtros();
    try {
      const r = await pedir('/api/v1/logs/agentes/' + encodeURIComponent(est.agente) + '/eventos?' + consulta(f, maisUma ? est.proximo : null));
      if (gen !== est.gen) return;
      est.proximo = r.proximo || null;
      est.parcial = !!r.parcial;
      est.filtrado = temFiltro(f);
      est.ultimaFontes = r.fontes || [];
      pintaFontes(r.fontes);
      pintaAvisos(r.avisos, r.contagens);
      const lista = $('lgLista');
      for (const ev of r.eventos || []) lista.appendChild(cartao(ev));
      if (!lista.childNodes.length) {
        const v = estadoVazio(r.fontes, est.filtrado, est.parcial, !!est.proximo);
        pintaEstado(v.texto, v.tipo);
      } else {
        pintaEstado('');
      }
    } catch (e) {
      if (gen !== est.gen) return;
      pintaEstado(e.message, 'erro');
    } finally {
      if (gen === est.gen) { est.carregando = false; pintaRodape(); }
    }
  }

  async function carregaSessoes() {
    const sel = $('lgSessao');
    limpar(sel);
    sel.appendChild(el('option', null, 'Todas as sessões')).value = '';
    if (!est.agente) return;
    try {
      const r = await pedir('/api/v1/logs/agentes/' + encodeURIComponent(est.agente) + '/sessoes?limite=100');
      for (const s of r.sessoes || []) {
        const o = el('option', null, (ROTULO_MOTOR[s.motor] || s.motor) + ' · ' + quando(Date.parse(s.atualizado)) + (s.subagente ? ' · subagente' : '') + ' · ' + s.id);
        o.value = s.id;
        sel.appendChild(o);
      }
    } catch (e) { msgGeral('Não consegui listar as sessões: ' + e.message); }
  }

  async function trocaAgente() {
    est.agente = $('lgAgente').value;
    try { raiz.history.replaceState(null, '', '/logs?a=' + encodeURIComponent(est.agente)); } catch (_) { /* sem history */ }
    pintaFontes(est.agentes.find(a => a.id === est.agente)?.fontes);
    await carregaSessoes();
    await busca(false);
  }

  async function carrega() {
    try {
      const r = await pedir('/api/v1/logs/agentes');
      est.agentes = r.agentes || [];
    } catch (e) {
      $('lgAgente').disabled = true;
      limpar($('lgFontes'));
      pintaEstado(e.message, 'erro');
      return;
    }
    const sel = $('lgAgente');
    limpar(sel);
    for (const a of est.agentes) {
      const o = el('option', null, a.nome + (a.tipo === 'admin' ? ' (Admin)' : ''));
      o.value = a.id;
      sel.appendChild(o);
    }
    sel.disabled = !est.agentes.length;
    if (!est.agentes.length) { pintaEstado('O registro não tem nenhum agente.', 'faltando'); return; }
    const pedido = new URLSearchParams(raiz.location.search).get('a');
    if (pedido && est.agentes.some(a => a.id === pedido)) sel.value = pedido;
    await trocaAgente();
  }

  function pintaChips() {
    const caixa = $('lgChips');
    limpar(caixa);
    for (const [valor, rotulo] of TIPOS) {
      const b = el('button', 'lg-chip', rotulo);
      b.type = 'button';
      b.setAttribute('aria-pressed', est.tipos.has(valor) ? 'true' : 'false');
      b.dataset.tipo = valor;
      caixa.appendChild(b);
    }
  }

  function aoClicar(ev) {
    const chip = ev.target.closest && ev.target.closest('.lg-chip');
    if (chip) {
      const t = chip.dataset.tipo;
      if (est.tipos.has(t)) est.tipos.delete(t); else est.tipos.add(t);
      chip.setAttribute('aria-pressed', est.tipos.has(t) ? 'true' : 'false');
      return;
    }
    const aj = ev.target.closest && ev.target.closest('[data-lg="ajuda"]');
    if (aj) { ajudaSecao(aj.getAttribute('data-secao')); }
  }

  function limparFiltros() {
    $('lgDesde').value = ''; $('lgAte').value = ''; $('lgBusca').value = ''; $('lgSessao').value = '';
    est.tipos.clear();
    pintaChips();
    busca(false);
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    msgGeral('A visita guiada não carregou. Recarregue a página e tente de novo.');
  }
  function ajudaSecao(chave) { comTour(() => raiz.DGTour.inicia({ passos: (PASSOS[chave] || []).filter(p => doc.querySelector(p.alvo)) })); }
  function tutorial() { comTour(() => raiz.DGTour.inicia({ passos: passosPagina(doc) })); }

  function inicia() {
    pintaChips();
    doc.addEventListener('click', aoClicar);
    $('lgAgente').addEventListener('change', trocaAgente);
    $('lgForm').addEventListener('submit', ev => { ev.preventDefault(); busca(false); });
    $('lgLimpar').addEventListener('click', limparFiltros);
    $('lgMais').addEventListener('click', () => busca(true));
    carrega();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { consulta, temFiltro, quando, tamanho, sessaoCurta, descreveFonte, estadoVazio, erroDaResposta, resumoContagens, passosPagina, PASSOS, TIPOS, ROTULO_TIPO, tutorial, carrega };
});
