'use strict';
/* anonimizar.js: a tela "Anonimizar documentos" (/anonimizar): liga e desliga por agente, instala o detector de
   nomes, testa um texto, lista e apaga os documentos anonimizados e mostra a tabela (só para o dono conferir).

   Toda escrita usa as rotas de /api/v1/anonimizar (web/docs/ANONIMIZAR.md); a tela não guarda nada por conta própria.
   Tudo que vem da API passa por esc() antes de virar HTML, e o texto do teste só ganha destaque nos marcadores.
   As funções que só montam texto e HTML ficam fora do DOM e têm teste em web/test/anonimizar-tela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGAnonimizarTela = m;
})(this, function (raiz) {
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BASE = '/api/v1/anonimizar';
  const POLL_MS = 3000;

  const OPCOES = [
    ['valores', 'Trocar valores em dinheiro', 'Por exemplo R$ 1.500,00 vira [VALOR_1].'],
    ['datas', 'Trocar datas', 'Por exemplo 12/03/1985 vira [DATA_1]. Ligue só se a data identifica alguém.'],
    ['empresas', 'Trocar nomes de empresas', 'Precisa do detector completo para achar o nome; o CNPJ é trocado sempre.'],
    ['aplicar_no_que_digito', 'Aplicar também no que eu digito', 'Troca, nas suas mensagens, só os dados que já apareceram em algum documento deste agente.'],
  ];
  const SEM_DETECTOR = [['bloquear', 'Bloquear o envio (recomendado)'], ['so_numeros', 'Enviar trocando só os números (nomes e endereços passam)']];
  const NAO_ANONIMIZAVEL = [['bloquear', 'Bloquear o envio (recomendado)'], ['enviar', 'Enviar assim mesmo, sem anonimizar']];

  /* Texto do nível do detector. */
  function rotuloNivel(nivel) {
    if (nivel === 'completo') return 'Completo: procura nomes de pessoas, empresas e endereços, além dos números de documento, telefone e e-mail. Lê texto, PDF, Word e Excel.';
    if (nivel === 'leitores') return 'Leitores instalados: lê texto, PDF, Word e Excel e troca números de documento, telefone e e-mail. Nomes e endereços NÃO são procurados.';
    if (nivel === 'regex') return 'Básico: só arquivos de texto (txt, md, csv, json), e só números de documento, telefone e e-mail. Nomes e endereços NÃO são procurados.';
    return 'O motor de anonimização não respondeu.';
  }

  function mbParaTexto(mb) {
    if (typeof mb !== 'number' || !isFinite(mb)) return 'não medida';
    return mb >= 1024 ? (mb / 1024).toFixed(1).replace('.', ',') + ' GB' : Math.round(mb) + ' MB';
  }

  /* Escapa o texto e destaca os marcadores. Nada além dos marcadores vira marcação. */
  function destacaMarcadores(texto) {
    return esc(texto).replace(/\[([A-Z]+_\d+)\]/g, '<mark class="an-marca">[$1]</mark>');
  }

  function textoContagem(n) {
    n = Number(n) || 0;
    return n === 1 ? '1 dado trocado' : n + ' dados trocados';
  }

  function dataCurta(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* O estado.json do instalador tem { nivel, nivel_pedido, versao_modelo, instalado_em, erro }. Durante a instalação
     ele ainda mostra a tentativa anterior; quem diz que está instalando é a unidade do sistema (em_andamento). */
  function textoInstalacao(inst) {
    const pedido = inst && (inst.nivel || (inst.arquivo && inst.arquivo.nivel_pedido));
    const nome = pedido === 'completo' ? 'o detector completo (cerca de 2 GB)' : pedido === 'leitores' ? 'os leitores (cerca de 30 MB)' : 'o detector';
    return 'Instalando ' + nome + '… isso leva alguns minutos e roda sozinho no servidor. Pode sair desta tela.';
  }
  function erroInstalacao(inst) {
    const a = (inst && inst.arquivo) || {};
    if (inst && inst.em_andamento) return '';
    if (typeof a.erro === 'string' && a.erro) {
      return 'A última instalação (' + (a.nivel_pedido || 'detector') + ') falhou: ' + a.erro + ' Tente de novo; se repetir, peça ao Admin para ver o registro da unidade dgclaw-anonimizar-instalar.';
    }
    return '';
  }

  /* Aviso fixo quando o config.json do servidor está ilegível: o envio fica bloqueado e o dono precisa saber a saída. */
  function configErroHtml(e) {
    const c = e && e.config_erro;
    if (!c) return '';
    return '<div class="an-aviso-real" role="alert"><b>A configuração da anonimização está ilegível.</b><br>' + esc(c.mensagem) +
      '<br>Arquivo: <code>' + esc(c.caminho) + '</code><br>' + esc(c.o_que_fazer) + '</div>';
  }

  function detectorHtml(e) {
    const d = e.detector || {};
    const inst = e.instalacao || {};
    const ram = e.ram || {};
    let h = '';
    if (!d.nivel) {
      h += '<p class="an-aviso-real" role="alert">' + esc(rotuloNivel(null)) + (d.erro ? ' ' + esc(d.erro) : '') + '</p>';
    } else {
      h += '<p><b>Nível atual:</b> ' + esc(rotuloNivel(d.nivel)) + '</p>';
    }
    h += '<p class="an-fraco">Memória livre agora: ' + esc(mbParaTexto(ram.disponivel_mb)) + ' de ' + esc(mbParaTexto(ram.total_mb)) + '.</p>';
    if (inst.em_andamento) {
      h += '<div class="an-barra" role="progressbar" aria-label="Instalando o detector"><i></i></div><p>' + esc(textoInstalacao(inst)) + '</p>';
    }
    const erro = erroInstalacao(inst);
    if (erro) h += '<p class="an-aviso-real" role="alert">' + esc(erro) + '</p>';
    const bloqueia = inst.em_andamento ? ' disabled' : '';
    const botoes = [];
    if (d.nivel === 'regex' || !d.nivel) {
      botoes.push('<button type="button" class="an-btn an-pri" data-an="instalar" data-nivel="leitores"' + bloqueia + '>Instalar leitores (cerca de 30 MB)</button>');
    }
    if (d.nivel !== 'completo') {
      botoes.push('<button type="button" class="an-btn' + (d.nivel === 'leitores' ? ' an-pri' : '') + '" data-an="instalar" data-nivel="completo"' + bloqueia + '>Instalar o detector completo (cerca de 2 GB, precisa de uns 2,5 GB de memória livre)</button>');
    }
    if (botoes.length) h += '<div class="an-acoes">' + botoes.join('') + '</div>';
    return h + '<p class="an-msg" id="anDetMsg" role="status" hidden></p>';
  }

  function agenteHtml(a, c) {
    const ligado = !!(c && c.ligado);
    const linhas = OPCOES.map(([k, rot, dica]) =>
      '<label class="an-linha-op"><input type="checkbox" data-an="opcao" data-campo="' + k + '"' + (c && c[k] ? ' checked' : '') + '>' +
      '<span>' + esc(rot) + '<br><small class="an-fraco">' + esc(dica) + '</small></span></label>').join('');
    const sel = (campo, lista, rot, dica) =>
      '<label class="an-campo">' + esc(rot) + '<small>' + esc(dica) + '</small><select data-an="opcao" data-campo="' + campo + '">' +
      lista.map(([v, t]) => '<option value="' + v + '"' + (c && c[campo] === v ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></label>';
    return '<article class="an-card" data-slug="' + esc(a.slug) + '">' +
      '<div class="an-topo"><h3>' + esc(a.nome) + '</h3>' +
      '<label class="an-chave"><input type="checkbox" data-an="ligado"' + (ligado ? ' checked' : '') + '><span>Anonimizar documentos</span></label></div>' +
      '<p class="an-fraco">' + (a.documentos === 1 ? '1 documento anonimizado' : (a.documentos || 0) + ' documentos anonimizados') + '</p>' +
      '<details class="an-op"><summary>Opções</summary><div class="an-opcoes">' + linhas +
      sel('sem_detector', SEM_DETECTOR, 'Sem o detector de nomes', 'O que fazer quando o detector completo não está instalado.') +
      sel('nao_anonimizavel', NAO_ANONIMIZAVEL, 'Se não der para anonimizar', 'Imagem, áudio, vídeo e formatos que o filtro não lê.') +
      '</div></details><p class="an-msg" role="status" hidden></p></article>';
  }

  function documentosHtml(docs) {
    if (!docs.length) return '<p class="an-vazio">Nenhum documento anonimizado para este agente.</p>';
    return docs.map(d => '<div class="an-doc" data-id="' + esc(d.id) + '"><div class="an-doc-nome">' + esc(d.nome_original) +
      '<small>' + esc(dataCurta(d.criado_em)) + ' · ' + esc(textoContagem(d.total)) + ' · código ' + esc(d.id) + '</small></div>' +
      '<button type="button" class="an-btn an-perigo" data-an="apagar" data-id="' + esc(d.id) + '">Apagar</button></div>').join('');
  }

  function tabelaHtml(entradas) {
    if (!entradas.length) return '<p class="an-vazio">A tabela deste agente está vazia.</p>';
    return '<p class="an-aviso-real">Estes são os dados reais. Feche a tabela quando terminar de conferir.</p><div class="an-tab">' +
      entradas.map(e => '<b>' + esc(e.marcador) + '</b><span>' + (e.apagado ? '<i class="an-fraco">apagado (o número não será reaproveitado)</i>' : esc(e.valor)) + '</span>').join('') + '</div>' +
      '<div class="an-acoes"><button type="button" class="an-btn" data-an="fechar-tabela">Esconder a tabela</button></div>';
  }

  /* ── Tutorial ─────────────────────────────────────────────────────────── */
  const PASSOS = {
    sobre: { alvo: '#secSobre', titulo: 'O que esta tela faz',
      oque: 'Um filtro que troca dados pessoais dos documentos por marcadores antes de o agente ler.',
      como: 'Você liga a opção para um agente. Daí em diante, todo documento enviado pelo clipe da conversa passa pelo filtro: o agente recebe só a cópia com [PESSOA_1], [CPF_1] e parecidos. O original não entra na pasta dele. Hoje vale só para o clipe da conversa web: WhatsApp, Telegram e e-mail ainda não passam pelo filtro.',
      porque: 'O agente e o modelo na nuvem trabalham sem ver os dados dos seus clientes, e você continua lendo tudo completo.' },
    detector: { alvo: '#secDetector', titulo: 'O detector de nomes',
      oque: 'O programa que reconhece nomes, empresas e endereços no meio do texto.',
      como: 'Sem ele, o filtro só acha o que tem formato fixo (CPF, CNPJ, telefone, e-mail). Os leitores (cerca de 30 MB) abrem PDF, Word e Excel. O completo (cerca de 2 GB) acha os nomes. A instalação roda sozinha no servidor e esta barra acompanha.',
      porque: 'Um nome escrito por extenso não tem formato: sem o detector ele passaria para o agente. Por isso o padrão é bloquear o envio quando ele não está instalado.' },
    agentes: { alvo: '#secAgentes', titulo: 'Opções de cada agente',
      oque: 'Um cartão por agente, com o interruptor e as opções dele.',
      como: 'O interruptor liga e desliga na hora. Em Opções você escolhe o que mais trocar (valores, datas, empresas), se o que você digita também é trocado e o que fazer quando não dá para anonimizar um arquivo. Cada mudança é salva sozinha.',
      porque: 'Cada agente trabalha com dados diferentes: o que é sensível para um pode ser público para outro.' },
    teste: { alvo: '#secTeste', titulo: 'Testar com um texto',
      oque: 'Uma caixa para ver o filtro funcionando sem enviar nada a ninguém.',
      como: 'Cole um texto e toque em Testar. Os marcadores aparecem destacados. Nada é gravado: a tabela do teste é temporária.',
      porque: 'Você confere, antes de confiar, se o filtro acha os dados do seu tipo de documento.' },
    docs: { alvo: '#secDocs', titulo: 'Documentos anonimizados',
      oque: 'A lista do que já passou pelo filtro, por agente: nome original, data e quantos dados foram trocados.',
      como: 'Apagar um documento tira da tabela os marcadores que nenhum outro documento usa. Ver tabela mostra os dados reais, só para você conferir. Os valores nunca aparecem na lista.',
      porque: 'Dá para limpar o que não precisa mais ficar guardado. Atenção: sem a tabela, não há como voltar os dados reais de um arquivo antigo.' },
  };

  function passosDaPagina() { return ['sobre', 'detector', 'agentes', 'teste', 'docs'].map(k => PASSOS[k]); }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => alert('A visita guiada não carregou. Recarregue a página e tente de novo.');
    document.head.appendChild(s);
  }
  function tutorial() { comTour(() => raiz.DGTour.inicia({ passos: passosDaPagina() })); }
  function tutorialSecao(chave) { if (PASSOS[chave]) comTour(() => raiz.DGTour.inicia({ passos: [PASSOS[chave]] })); }

  if (!raiz.document) return { esc, rotuloNivel, configErroHtml, mbParaTexto, destacaMarcadores, textoContagem, dataCurta, textoInstalacao, erroInstalacao, detectorHtml, agenteHtml, documentosHtml, tabelaHtml, passosDaPagina, PASSOS, OPCOES };

  /* ── Parte com DOM ──────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const est = { estado: null, configs: {}, docsSlug: '', timer: null, instalando: false };

  async function api(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(BASE + caminho, {
        method: metodo, credentials: 'same-origin', cache: 'no-store',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
    } catch (e) { throw new Error('não consegui falar com o servidor (' + e.message + ')'); }
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('sua sessão expirou'); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.ok === false) throw new Error((d && d.erro) || ('o servidor respondeu ' + r.status));
    return d;
  }

  function aviso(el, texto, tipo) {
    if (!el) return;
    el.textContent = texto || '';
    el.className = 'an-msg' + (tipo ? ' ' + tipo : '');
    el.hidden = !texto;
  }

  function pintaDetector() {
    $('anConfigErro').innerHTML = configErroHtml(est.estado);
    $('anDetector').innerHTML = detectorHtml(est.estado);
    const andamento = !!(est.estado.instalacao && est.estado.instalacao.em_andamento);
    if (andamento && !est.timer) est.timer = setInterval(() => carregaEstado(true), POLL_MS);
    if (!andamento && est.timer) { clearInterval(est.timer); est.timer = null; }
    if (est.instalando && !andamento) {
      est.instalando = false;
      const erro = erroInstalacao(est.estado.instalacao);
      aviso($('anDetMsg'), erro ? '' : 'Instalação concluída.', 'ok');
    }
    if (andamento) est.instalando = true;
  }

  function pintaAgentes() {
    const ags = est.estado.agentes;
    $('anAgentes').innerHTML = ags.length ? ags.map(a => agenteHtml(a, est.configs[a.slug])).join('') : '<p class="an-vazio">Nenhum agente de trabalho ainda.</p>';
    const opcoes = ags.map(a => '<option value="' + esc(a.slug) + '">' + esc(a.nome) + '</option>').join('');
    const t = $('anTesteAgente'); const guardadoT = t.value;
    t.innerHTML = '<option value="">Opções padrão</option>' + opcoes; if (guardadoT) t.value = guardadoT;
    const d = $('anDocsAgente'); const guardadoD = d.value || est.docsSlug;
    d.innerHTML = opcoes;
    if (guardadoD && ags.some(a => a.slug === guardadoD)) d.value = guardadoD;
    est.docsSlug = d.value;
  }

  async function carregaEstado(silencioso) {
    try {
      est.estado = await api('GET', '/estado');
      const falta = est.estado.config_erro ? [] : est.estado.agentes.filter(a => !est.configs[a.slug]);
      await Promise.all(falta.map(async a => { est.configs[a.slug] = (await api('GET', '/' + encodeURIComponent(a.slug) + '/config')).config; }));
      aviso($('anMsgGeral'), '');
      pintaDetector();
      if (!silencioso) { pintaAgentes(); await carregaDocs(); }
    } catch (e) {
      if (!silencioso || !est.estado) {
        aviso($('anMsgGeral'), 'Não consegui carregar a tela: ' + e.message + '. Recarregue a página; se continuar, peça ao Admin para conferir o painel.', 'erro');
        $('anMsgGeral').hidden = false;
      }
    }
  }

  async function carregaDocs() {
    const slug = $('anDocsAgente').value;
    est.docsSlug = slug;
    $('anTabela').hidden = true; $('anTabela').innerHTML = '';
    if (!slug) { $('anDocs').innerHTML = '<p class="an-vazio">Escolha um agente.</p>'; $('anDocsAcoes').hidden = true; return; }
    try {
      const d = await api('GET', '/' + encodeURIComponent(slug) + '/documentos');
      $('anDocs').innerHTML = documentosHtml(d.documentos);
      $('anDocsAcoes').hidden = !d.documentos.length;
    } catch (e) {
      $('anDocs').innerHTML = '';
      aviso($('anDocsMsg'), 'Não consegui listar os documentos: ' + e.message, 'erro');
    }
  }

  async function salva(card, mudanca) {
    const slug = card.dataset.slug; const msg = card.querySelector('.an-msg');
    try {
      const d = await api('PUT', '/' + encodeURIComponent(slug) + '/config', mudanca);
      est.configs[slug] = d.config;
      aviso(msg, 'Salvo.', 'ok');
      const a = est.estado.agentes.find(x => x.slug === slug); if (a) a.ligado = d.config.ligado;
    } catch (e) {
      aviso(msg, 'Não salvei: ' + e.message, 'erro');
      const antigo = est.configs[slug] || {};
      for (const [k, v] of Object.entries(mudanca)) {
        const el = k === 'ligado' ? card.querySelector('[data-an=ligado]') : card.querySelector('[data-campo="' + k + '"]');
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!antigo[k]; else el.value = antigo[k] == null ? v : antigo[k];
      }
    }
  }

  document.addEventListener('change', ev => {
    const el = ev.target;
    const card = el.closest && el.closest('.an-card');
    if (card && el.dataset.an === 'ligado') salva(card, { ligado: el.checked });
    else if (card && el.dataset.an === 'opcao') salva(card, { [el.dataset.campo]: el.type === 'checkbox' ? el.checked : el.value });
    else if (el.id === 'anDocsAgente') carregaDocs();
  });

  const pendentes = new Map();   // confirmação em dois toques, sem janela do navegador
  document.addEventListener('click', async ev => {
    const bt = ev.target.closest && ev.target.closest('button[data-an]');
    if (!bt) return;
    const acao = bt.dataset.an;
    if (acao === 'ajuda') { tutorialSecao(bt.dataset.secao); return; }
    if (acao === 'instalar') {
      const nivel = bt.dataset.nivel;
      bt.disabled = true;
      try {
        await api('POST', '/detector/instalar', { nivel });
        est.instalando = true;
        await carregaEstado(true);
      } catch (e) {
        if (/forcar/.test(e.message) && confirm(e.message + '\n\nInstalar assim mesmo?')) {
          try { await api('POST', '/detector/instalar', { nivel, forcar: true }); est.instalando = true; await carregaEstado(true); return; } catch (e2) { e = e2; }
        }
        aviso($('anDetMsg'), 'Não consegui iniciar a instalação: ' + e.message, 'erro');
        bt.disabled = false;
      }
      return;
    }
    if (acao === 'apagar' || acao === 'apagar-tudo') {
      const chave = acao + (bt.dataset.id || '');
      if (!pendentes.has(chave)) {
        const rotulo = bt.textContent;
        bt.textContent = acao === 'apagar' ? 'Confirmar: apagar' : 'Confirmar: apagar tudo';
        const t = setTimeout(() => { pendentes.delete(chave); bt.textContent = rotulo; }, 5000);
        pendentes.set(chave, t);
        return;
      }
      clearTimeout(pendentes.get(chave)); pendentes.delete(chave);
      const slug = est.docsSlug;
      bt.disabled = true;
      try {
        const r = acao === 'apagar' ? await api('DELETE', '/' + encodeURIComponent(slug) + '/documentos/' + encodeURIComponent(bt.dataset.id))
          : await api('DELETE', '/' + encodeURIComponent(slug) + '/documentos');
        aviso($('anDocsMsg'), acao === 'apagar' ? 'Documento apagado. Saíram da tabela ' + r.removidos_da_tabela + ' marcador(es) que ninguém mais usa.' : 'Tudo apagado: ' + r.apagados + ' documento(s) e a tabela.', 'ok');
        const a = est.estado.agentes.find(x => x.slug === slug);
        await carregaEstado(false);
        if (a) $('anDocsAgente').value = slug;
        await carregaDocs();
      } catch (e) {
        aviso($('anDocsMsg'), 'Não apaguei: ' + e.message, 'erro');
        bt.disabled = false;
      }
      return;
    }
    if (acao === 'tabela') {
      const slug = est.docsSlug;
      try {
        const d = await api('GET', '/' + encodeURIComponent(slug) + '/tabela');
        $('anTabela').innerHTML = tabelaHtml(d.entradas); $('anTabela').hidden = false;
      } catch (e) { aviso($('anDocsMsg'), 'Não abri a tabela: ' + e.message, 'erro'); }
      return;
    }
    if (acao === 'fechar-tabela') { $('anTabela').hidden = true; $('anTabela').innerHTML = ''; }
  });

  $('anTesteBtn').onclick = async () => {
    const texto = $('anTesteTexto').value;
    const saida = $('anTesteSaida'); const msg = $('anTesteMsg');
    aviso(msg, '');
    if (!texto.trim()) { aviso(msg, 'Escreva ou cole um texto para testar.', 'erro'); return; }
    $('anTesteBtn').disabled = true;
    try {
      const corpo = { texto };
      if ($('anTesteAgente').value) corpo.slug = $('anTesteAgente').value;
      const d = await api('POST', '/testar', corpo);
      saida.innerHTML = destacaMarcadores(d.texto); saida.hidden = false;
      aviso(msg, textoContagem(d.total) + '.' + (d.aviso ? ' ' + d.aviso : ''), d.aviso ? 'erro' : 'ok');
    } catch (e) {
      saida.hidden = true;
      aviso(msg, 'Não consegui testar: ' + e.message, 'erro');
    } finally { $('anTesteBtn').disabled = false; }
  };

  carregaEstado(false);
  return { tutorial, tutorialSecao, passosDaPagina, destacaMarcadores };
});
