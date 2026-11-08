'use strict';
/* ronda-comum.js: o que a tela Segurança (seguranca.js) e o aviso único (seguranca-resumo.js) têm em comum.

   Só funções que montam texto e HTML, falam com a API e guardam a escolha do dono; nada aqui mexe na página.
   Tudo que vem da API nasceu em fontes externas: esc() antes de virar HTML e link só se for https://.
   Contrato das rotas: web/docs/RONDA-PAINEL.md. Testes: web/test/ronda-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGRondaComum = m;
})(this, function () {
  const API = '/api/v1/seguranca';
  const FUSO = 'America/Sao_Paulo';
  const DECIDIDO_MS = 24 * 3600 * 1000;
  const SONDA_CADA_MS = 2000;
  const SONDA_MAX_MS = 2 * 60 * 1000;
  const CHAVE_DECIDIDO = 'dgclaw:ronda:decidido';
  const GRAVIDADE = { CRITICAL: 'Crítica', HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa' };
  const PESO = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const QUARENTA_E_OITO_H = 48 * 3600 * 1000;
  const FRASE_SEM_NOVIDADE = 'Nenhuma vulnerabilidade nova que afete o seu sistema nesta ronda.';
  const TEXTO_NIVEL3 = 'Nova vulnerabilidade de impacto leve/médio. Sugestão: corrija o quanto antes; a correção já está pronta, é só dar o ok.';
  const AVISO_REINICIO = 'Esta correção pode reiniciar um serviço por alguns segundos.';
  const AVISO_REINICIO_CERTO = 'Esta correção reinicia um serviço por alguns segundos.';

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ehHttps = u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);

  const partes = (iso, opcoes) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const o = {};
    new Intl.DateTimeFormat('pt-BR', Object.assign({ timeZone: FUSO }, opcoes)).formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
    return o;
  };

  function dataBr(iso) {
    const p = partes(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
    return p ? p.day + '/' + p.month + '/' + p.year : 'data não informada';
  }

  /* "13h02" (ou "19h00"). */
  function horaBr(iso) {
    const p = partes(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return p ? p.hour + 'h' + p.minute : '';
  }

  /* Diferença em dias de calendário (no fuso do painel) entre `iso` e `agora`: 0 hoje, -1 ontem, 1 amanhã. */
  function diasDeDiferenca(iso, agora) {
    const a = partes(iso, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const b = partes(new Date(agora).toISOString(), { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!a || !b) return null;
    return Math.round((Date.UTC(+a.year, +a.month - 1, +a.day) - Date.UTC(+b.year, +b.month - 1, +b.day)) / 86400000);
  }

  /* "hoje, 13h02" | "ontem, 13h02" | "amanhã, 19h00" | "29/10/2026, 13h02". */
  function quando(iso, agora) {
    if (!iso || Number.isNaN(Date.parse(iso))) return '';
    const d = diasDeDiferenca(iso, typeof agora === 'number' ? agora : Date.now());
    const dia = d === 0 ? 'hoje' : d === -1 ? 'ontem' : d === 1 ? 'amanhã' : dataBr(iso);
    return dia + ', ' + horaBr(iso);
  }

  /* "Última ronda: hoje, 13h02. Próxima: 19h00." (a próxima só leva o dia quando não é hoje). */
  function resumoTopo(ronda, agora) {
    if (!ronda || ronda.nunca_rodou || !ronda.rodada_em) {
      return 'A ronda de segurança ainda não rodou neste servidor. Ela roda sozinha; para rodar agora, peça ao Admin: sudo dgclaw seguranca rodar.';
    }
    const ref = typeof agora === 'number' ? agora : Date.now();
    let s = 'Última ronda: ' + quando(ronda.rodada_em, ref) + '.';
    if (ronda.proxima_em) {
      const d = diasDeDiferenca(ronda.proxima_em, ref);
      s += ' Próxima: ' + (d === 0 ? horaBr(ronda.proxima_em) : quando(ronda.proxima_em, ref)) + '.';
    }
    return s;
  }

  function lista(nomes) {
    if (nomes.length <= 1) return nomes.join('');
    return nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
  }

  /* Texto da faixa amarela, ou '' quando a ronda está completa. */
  function textoParcial(ronda) {
    if (!ronda || !ronda.parcial) return '';
    const fora = Array.isArray(ronda.fontes_fora) ? ronda.fontes_fora : [];
    if (fora.length === 0) return 'Ronda parcial: alguma fonte ficou fora, então este resultado pode estar incompleto.';
    if (fora.length === 1) return 'Ronda parcial: a fonte ' + fora[0] + ' ficou fora, então este resultado pode estar incompleto.';
    return 'Ronda parcial: as fontes ' + lista(fora) + ' ficaram fora, então este resultado pode estar incompleto.';
  }

  function textoVigia(ronda) {
    const v = ronda && ronda.vigia_alerta;
    if (!v) return '';
    return 'A ronda automática falhou: ' + v.motivo + (v.quando ? ' (visto em ' + quando(v.quando, Date.now()) + ')' : '') +
      ' Rode "sudo dgclaw seguranca rodar" no servidor ou peça ao Admin para ver o motivo.';
  }

  function gravidadeRotulo(sev) { return GRAVIDADE[sev] || 'Não informada'; }

  function linkHtml(url, rotulo) {
    if (!ehHttps(url)) return esc(url);
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(rotulo || url) + '</a>';
  }

  function fato(rotulo, valorHtml, classe) {
    return '<div class="rp-fato' + (classe ? ' ' + classe : '') + '"><dt>' + esc(rotulo) + '</dt><dd>' + valorHtml + '</dd></div>';
  }

  /* Os fatos de uma falha, na ordem pedida: publicada em, gravidade, onde afeta, o que faz, como corrigir, fonte e notícia. */
  function fatosHtml(a) {
    let h = fato('Publicada em', esc(a.publicado_em ? dataBr(a.publicado_em) : 'data não informada'), 'rp-f-data');
    h += fato('Gravidade', esc(gravidadeRotulo(a.severidade)), 'rp-f-grav');
    if (a.onde && a.onde.length) h += fato('Onde afeta', a.onde.map(esc).join('<br>'), 'rp-f-onde');
    h += fato('O que faz', esc(a.o_que_faz || 'A fonte oficial não descreve o impacto.'), 'rp-f-faz');
    h += fato('Como corrigir', esc(a.como_corrigir || 'Ainda não há orientação publicada.'), 'rp-f-como');
    h += fato('Fonte oficial', linkHtml(a.fonte_url), 'rp-f-fonte');
    if (a.noticia_url) h += fato('Notícia', linkHtml(a.noticia_url), 'rp-f-noticia');
    return '<dl class="rp-fatos">' + h + '</dl>';
  }

  function ehAtualizarDgclaw(a) { return !!(a && a.correcao && a.correcao.tipo === 'atualizar-dgclaw'); }

  function textoDoPedidoAtualizar(a) {
    return 'Quero instalar a atualização de segurança do DG Claw (achado ' + a.id + ').';
  }

  function avisoReinicio(a) { return a && a.correcao && a.correcao.exige_reinicio ? AVISO_REINICIO_CERTO : AVISO_REINICIO; }

  /* A correção pode ser pedida pelo painel? (o servidor confere de novo). */
  function podeAplicar(a) { return !!(a && (a.estado === 'aberto' || a.estado === 'agendado') && a.correcao && a.correcao.disponivel && a.correcao.executavel); }

  /* Correção já publicada, mas que não é uma ação do catálogo: o painel não aplica nem agenda, o Admin analisa e faz. */
  function podePedirAoAdmin(a) { return !!(a && a.estado === 'aberto' && a.correcao && a.correcao.disponivel && !a.correcao.executavel); }

  function textoDoPedidoAoAdmin(a) {
    if (ehAtualizarDgclaw(a)) return textoDoPedidoAtualizar(a);
    return 'Quero aplicar a correção de segurança ' + a.id + ' (atualização do pacote ' + (a.componente || 'afetado') + '). Analise antes e me diga se vai reiniciar algum serviço.';
  }

  const ROTULO_ESTADO = {
    'aplicado-sozinho': 'Aplicado sozinho', 'aplicado-pelo-dono': 'Aplicado por você', mitigado: 'Mitigado', agendado: 'Agendado', aberto: 'Aberto',
    'protegido-aguardando': 'Protegido, aguardando correção oficial', 'aguardando-fornecedor': 'Aguardando correção do fornecedor',
  };
  /* Sem correção instalável: informativo, nunca entra na lista de pontos em risco nem pede decisão. */
  function aguardaCorrecao(a) { return !!a && (a.estado === 'protegido-aguardando' || a.estado === 'aguardando-fornecedor'); }
  function estadoRotulo(e) { return ROTULO_ESTADO[e] || 'Aberto'; }

  /* "Aplicado sozinho em hoje, 13h02: <antes> para <depois>". */
  function textoAplicado(a, agora) {
    const ap = a.aplicado || {};
    let s = estadoRotulo(a.estado) + (ap.em ? ', ' + quando(ap.em, agora) : '') + '.';
    if (ap.antes || ap.depois) s += ' Antes: ' + (ap.antes || 'não registrado') + '. Depois: ' + (ap.depois || 'não registrado') + '.';
    return s;
  }

  /* datetime-local ("2026-11-01T03:00", hora do aparelho) para ISO; null se inválido ou menos de 1 minuto à frente. */
  function agendaParaIso(valor, agora) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(valor)) return null;
    const t = new Date(valor).getTime();
    const ref = typeof agora === 'number' ? agora : Date.now();
    if (Number.isNaN(t) || t - ref < 60 * 1000) return null;
    return new Date(t).toISOString();
  }

  /* ── "já decidi" guardado no aparelho (vale até o servidor mudar o estado, ou 24 h) ── */
  function lerMapa(storage, chave) {
    try {
      const j = JSON.parse(storage.getItem(chave) || '{}');
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch (e) { return {}; }
  }
  function gravaMapa(storage, chave, mapa) {
    try { storage.setItem(chave, JSON.stringify(mapa)); } catch (e) { /* sem armazenamento: o aviso só reaparece mais cedo */ }
  }
  function marcaDecidido(storage, id, agora) {
    const m = lerMapa(storage, CHAVE_DECIDIDO);
    m[id] = agora;
    gravaMapa(storage, CHAVE_DECIDIDO, m);
  }
  function estaDecidido(storage, id, agora) { const v = lerMapa(storage, CHAVE_DECIDIDO)[id]; return typeof v === 'number' && agora - v < DECIDIDO_MS; }

  /* Os achados de nível 2 que contam como "ponto em risco" no aviso único: abertos e sem decisão do dono neste aparelho.
     "Agendado" fica de fora: o dono já decidiu e o servidor aplica na hora marcada.
     Com o sistema fora do ar (emergência em andamento) não conta: a decisão já foi tomada.
     Corte inconsistente (marcado, mas sem firewall) é falha de proteção: continua contando. */
  function criticasEmAberto(ronda, storage, agora, emergencia) {
    if (!ronda || ronda.nunca_rodou || !ronda.niveis) return [];
    if (emergencia && emergencia.estado && emergencia.estado.cortado && !emergencia.estado.inconsistente) return [];
    return (ronda.niveis['2'] || []).filter(a => a.estado === 'aberto' && !estaDecidido(storage, a.id, agora));
  }

  /* ── boletins de segurança (GET /boletins), mostrados na tela Segurança ─────────────────────────────────────── */
  function ordenaPorGravidade(lista) {
    const peso = x => (PESO[x.severidade] != null ? PESO[x.severidade] : 9);
    return lista.map((x, i) => ({ x, i })).sort((a, b) => peso(a.x) - peso(b.x) || a.i - b.i).map(o => o.x);
  }

  /* "Nas últimas horas" quando a falha foi publicada há menos de 48 h; senão "Em 21/10/2026". */
  function abertura(publicadoEm, agora) {
    const t = Date.parse(publicadoEm);
    const ref = typeof agora === 'number' ? agora : Date.now();
    if (!Number.isNaN(t) && ref - t < QUARENTA_E_OITO_H) return 'Nas últimas horas';
    return 'Em ' + dataBr(publicadoEm);
  }

  function temCorrecaoParaAplicar(b) { return b.acao === 'atualizar-dgclaw' || b.acao === 'atualizar-sistema'; }

  /* Texto corrido do boletim, em texto puro (quem desenha escapa). */
  function textoBoletim(b, agora) {
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

  function textoDoPedidoBoletim(b) {
    return b.acao === 'atualizar-sistema'
      ? 'Quero aplicar a atualização de segurança do servidor (boletim ' + b.id + '). Depois de aplicar, confirme que o aviso pode sumir.'
      : 'Quero instalar a atualização de segurança do DG Claw (boletim ' + b.id + ').';
  }

  function fatosBoletimHtml(b) {
    let h = fato('Publicada em', esc(dataBr(b.publicado_em)), 'rp-f-data');
    h += fato('Gravidade', esc(gravidadeRotulo(b.severidade)), 'rp-f-grav');
    h += fato('Fonte oficial', linkHtml(b.fonte_url), 'rp-f-fonte');
    if (b.noticia_url) h += fato('Notícia', linkHtml(b.noticia_url), 'rp-f-noticia');
    if (b.o_que_muda) h += fato('O que muda', esc(b.o_que_muda), 'rp-f-muda');
    return '<dl class="rp-fatos">' + h + '</dl>';
  }

  /* ── conversa com a API ─────────────────────────────────────────────────── */
  function msgHttp(r, json) {
    return (json && json.erro) || ('O servidor respondeu ' + r.status + '. Atualize a página e tente de novo.');
  }

  /* GET ou POST JSON. Devolve { ok:true, json } ou { ok:false, erro, status }. */
  async function chama(fetchFn, metodo, url, corpo) {
    let r; let json = null;
    try {
      const op = { method: metodo, credentials: 'same-origin', cache: 'no-store' };
      if (corpo !== undefined) { op.headers = { 'Content-Type': 'application/json' }; op.body = JSON.stringify(corpo); }
      r = await fetchFn(url, op);
      try { json = await r.json(); } catch (e) { json = null; }
    } catch (e) {
      return { ok: false, status: 0, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.' };
    }
    if (!r.ok) return { ok: false, status: r.status, erro: msgHttp(r, json) };
    return { ok: true, json: json || {} };
  }

  const PEDIDO_ROTULO = {
    aplicar: 'Aplicando a correção', agendar: 'Agendando', desfazer: 'Desfazendo', 'emergencia-preparar': 'Preparando o plano',
    'emergencia-cortar': 'Tirando o sistema do ar', 'emergencia-religar': 'Religando o sistema',
  };

  /* Espera o servidor terminar um pedido. aoProgresso(texto) recebe a mensagem de andamento.
     Devolve { ok, mensagem, dados } ou { ok:false, mensagem } (erro, ou 2 min sem resposta). */
  async function sondar(uuid, o) {
    const fetchFn = o.fetchFn;
    const dorme = o.dorme || (ms => new Promise(r => setTimeout(r, ms)));
    const relogio = o.relogio || (() => Date.now());
    const inicio = relogio();
    const rotulo = o.rotulo || 'Aguardando o servidor';
    let n = 0;
    for (;;) {
      const r = await chama(fetchFn, 'GET', API + '/pedidos/' + encodeURIComponent(uuid));
      if (!r.ok) return { ok: false, mensagem: r.erro };
      if (!r.json.pendente) {
        const res = r.json.resultado || {};
        return { ok: res.ok === true, mensagem: res.mensagem || '', dados: r.json.dados || null };
      }
      if (relogio() - inicio >= (o.maxMs || SONDA_MAX_MS)) {
        return { ok: false, mensagem: 'O servidor não respondeu em 2 minutos. O pedido pode ainda ser executado: confira a tela em instantes. Se nada mudar, o executor não está rodando; peça ao Admin: systemctl status dgclaw-seguranca-pedidos.path' };
      }
      n += 1;
      if (o.aoProgresso) o.aoProgresso(rotulo + '… (' + n * (SONDA_CADA_MS / 1000) + ' s)');
      await dorme(o.cadaMs || SONDA_CADA_MS);
    }
  }

  /* POST que cria um pedido e já espera o resultado. */
  async function pedirEEsperar(fetchFn, url, corpo, o) {
    const p = await chama(fetchFn, 'POST', url, corpo);
    if (!p.ok) return { ok: false, mensagem: p.erro };
    if (!p.json.pedido) return { ok: false, mensagem: 'O servidor aceitou, mas não devolveu o número do pedido. Atualize a página e confira o estado.' };
    return sondar(p.json.pedido, Object.assign({ fetchFn, rotulo: PEDIDO_ROTULO[p.json.tipo] }, o || {}));
  }

  const urlAchado = (id, acao) => API + '/ronda/' + encodeURIComponent(id) + '/' + acao;

  return {
    API, FUSO, PESO, SONDA_CADA_MS, SONDA_MAX_MS, FRASE_SEM_NOVIDADE, TEXTO_NIVEL3, GRAVIDADE,
    esc, ehHttps, dataBr, horaBr, quando, resumoTopo, textoParcial, textoVigia, gravidadeRotulo, linkHtml, fatosHtml,
    ehAtualizarDgclaw, textoDoPedidoAtualizar, textoDoPedidoAoAdmin, avisoReinicio, podeAplicar, podePedirAoAdmin, estadoRotulo, textoAplicado, agendaParaIso,
    marcaDecidido, estaDecidido, criticasEmAberto, aguardaCorrecao,
    ordenaPorGravidade, abertura, temCorrecaoParaAplicar, textoBoletim, textoDoPedidoBoletim, fatosBoletimHtml,
    chama, sondar, pedirEEsperar, urlAchado, PEDIDO_ROTULO,
  };
});
