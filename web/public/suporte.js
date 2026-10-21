'use strict';
/* suporte.js: a tela /suporte (Suporte remoto).

   Fala com /api/v1/chaves-api (lista, cria, revoga) e com /api/v1/diagnostico (o mesmo que a chave de suporte lê).
   Os textos do diagnóstico podem vir de logs: tudo aqui entra na página por textContent e createElement,
   nunca como HTML montado a partir de texto.

   Parte pura (sem DOM, testada em web/test/suporte-tela.test.js): agrupamento, rótulos e formatação. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else {
    raiz.DGSuporte = m;
    m.inicia();
  }
})(this, function (raiz) {
  const ROTULO_ESTADO = { ok: 'funcionando', atencao: 'atenção', quebrado: 'quebrado', nao_medido: 'não medido' };
  const p2 = n => String(n).padStart(2, '0');

  /* "21/10/2026 14:05" no fuso do aparelho. Data ausente ou ilegível devolve '' (nunca uma data inventada). */
  function dataHora(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function estadoValido(e) {
    return Object.prototype.hasOwnProperty.call(ROTULO_ESTADO, e) ? e : 'nao_medido';
  }

  /* Título do grupo de verificações: máquina, admin ou um agente. */
  function tituloGrupo(chave) {
    if (chave === 'maquina') return 'Máquina';
    if (chave === 'admin') return 'Admin';
    if (chave.indexOf('agente:') === 0) return 'Agente ' + chave.slice(7);
    return chave.charAt(0).toUpperCase() + chave.slice(1);
  }

  /* Agrupa mantendo a ordem de chegada. Cada agente forma o seu grupo. */
  function agrupar(verificacoes) {
    const grupos = [];
    const por = new Map();
    for (const v of Array.isArray(verificacoes) ? verificacoes : []) {
      const g = String(v.grupo || 'outros');
      const chave = g === 'agente' && v.alvo ? 'agente:' + v.alvo : g;
      if (!por.has(chave)) {
        const novo = { chave, titulo: tituloGrupo(chave), itens: [] };
        por.set(chave, novo);
        grupos.push(novo);
      }
      por.get(chave).itens.push(v);
    }
    return grupos;
  }

  /* Estado de uma chave para a lista: 'ativa' ou 'revogada'. */
  function situacaoChave(c) {
    return c && c.revogadaEm ? 'revogada' : 'ativa';
  }

  /* Junta o erro da API com o "como resolver", se vier. */
  function textoDoErro(json, status) {
    if (json && json.erro) return json.erro + (json.como_resolver ? ' ' + json.como_resolver : '');
    return 'O servidor respondeu ' + status + ' sem explicar o motivo.';
  }

  /* Linhas de evidência de uma verificação: o sinal fixo e as categorias de erro (nunca texto de log). */
  function linhasDeEvidencia(ev) {
    const linhas = [];
    if (!ev || typeof ev !== 'object') return linhas;
    if (ev.sinal) linhas.push('Sinal: ' + ev.sinal);
    if (ev.codigo_saida != null) linhas.push('Código de saída: ' + ev.codigo_saida);
    if (Array.isArray(ev.ocorrencias)) {
      for (const o of ev.ocorrencias) {
        if (!o || !o.frase) continue;
        const quando = o.ultima_em ? ', última em ' + (dataHora(o.ultima_em) || o.ultima_em) : '';
        linhas.push('Erro: ' + o.frase + ' (' + o.quantidade + (o.quantidade === 1 ? ' vez' : ' vezes') + quando + ')');
      }
    }
    return linhas;
  }

  const puros = { linhasDeEvidencia, dataHora, estadoValido, tituloGrupo, agrupar, situacaoChave, textoDoErro, ROTULO_ESTADO };
  if (!raiz.document) return puros;

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function msg(id, texto, tipo) {
    const e = $(id);
    if (!e) return;
    e.textContent = texto || '';
    e.className = 'sp-msg' + (tipo ? ' ' + tipo : '');
    e.hidden = !texto;
  }

  /* Chama a API. Nunca lança: devolve { ok, status, json, erro } com o motivo já escrito. */
  async function chamar(metodo, url, corpo) {
    const opcoes = { method: metodo, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (corpo !== undefined) { opcoes.body = JSON.stringify(corpo); opcoes.headers['Content-Type'] = 'application/json'; }
    let r;
    try { r = await fetch(url, opcoes); } catch (e) {
      return { ok: false, status: 0, json: null, erro: 'Não consegui falar com o servidor (' + e.message + '). Confira a conexão e tente de novo.' };
    }
    let json = null;
    try { json = await r.json(); } catch (_) { /* resposta sem JSON: o texto de erro cobre */ }
    if (r.status === 401) {
      return { ok: false, status: 401, json, erro: 'Sua sessão acabou. Entre de novo em /login e volte a esta tela.' };
    }
    if (!r.ok || (json && json.ok === false)) return { ok: false, status: r.status, json, erro: textoDoErro(json, r.status) };
    return { ok: true, status: r.status, json };
  }

  /* Copia para a área de transferência. Sem permissão do navegador, avisa em vez de fingir que copiou. */
  async function copiar(texto, idMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(texto);
        msg(idMsg, 'Copiado.', 'ok');
        return;
      }
      throw new Error('o navegador não deixa copiar por aqui');
    } catch (e) {
      msg(idMsg, 'Não consegui copiar sozinho (' + e.message + '). Selecione o texto e copie à mão.', 'erro');
    }
  }

  /* ── Chaves ───────────────────────────────────────────────────────────── */
  let chaves = [];
  let confirmando = null;   // id da chave cuja revogação está pedindo confirmação

  function dado(rotulo, valor) {
    const d = el('div');
    d.appendChild(el('dt', null, rotulo + ': '));
    d.appendChild(el('dd', null, valor));
    return d;
  }

  function cartaoChave(c) {
    const sit = situacaoChave(c);
    const card = el('div', 'sp-cartao' + (sit === 'revogada' ? ' revogada' : ''));
    const topo = el('div', 'sp-cartao-topo');
    topo.appendChild(el('b', null, c.nome));
    topo.appendChild(el('span', 'sp-chip ' + sit, sit === 'ativa' ? 'ativa' : 'revogada em ' + (dataHora(c.revogadaEm) || 'data desconhecida')));
    card.appendChild(topo);
    const dados = el('dl', 'sp-dados');
    dados.appendChild(dado('Final', '****' + c.ultimos4));
    dados.appendChild(dado('Criada em', dataHora(c.criadaEm) || 'data desconhecida'));
    dados.appendChild(dado('Último acesso', c.ultimoUsoEm
      ? dataHora(c.ultimoUsoEm) + (c.ultimoUsoIp ? ' (IP ' + c.ultimoUsoIp + ')' : '')
      : 'nunca usada'));
    if (sit === 'revogada' && c.revogadaPor) dados.appendChild(dado('Revogada por', c.revogadaPor));
    card.appendChild(dados);
    if (sit === 'ativa') {
      const acoes = el('div', 'sp-acoes');
      if (confirmando === c.id) {
        acoes.appendChild(el('span', 'sp-fraco', 'Revogar "' + c.nome + '"? O acesso acaba na hora.'));
        const sim = el('button', 'sp-btn perigo', 'Sim, revogar');
        sim.type = 'button';
        sim.onclick = () => revogar(c, sim);
        const nao = el('button', 'sp-btn', 'Cancelar');
        nao.type = 'button';
        nao.onclick = () => { confirmando = null; pintaChaves(); };
        acoes.appendChild(sim);
        acoes.appendChild(nao);
      } else {
        const b = el('button', 'sp-btn perigo', 'Revogar');
        b.type = 'button';
        b.onclick = () => { confirmando = c.id; pintaChaves(); };
        acoes.appendChild(b);
      }
      card.appendChild(acoes);
    }
    return card;
  }

  function pintaChaves() {
    const lista = $('chavesLista');
    lista.textContent = '';
    if (!chaves.length) {
      $('chavesEstado').textContent = 'Nenhuma chave de suporte criada ainda. Ninguém de fora consegue ler o diagnóstico desta máquina.';
      return;
    }
    const ativas = chaves.filter(c => situacaoChave(c) === 'ativa').length;
    $('chavesEstado').textContent = ativas + (ativas === 1 ? ' chave ativa' : ' chaves ativas') + ' de ' + chaves.length + '.';
    // ativas primeiro, depois as revogadas; dentro de cada grupo a mais nova no alto
    const ordenadas = chaves.slice().sort((a, b) => (situacaoChave(a) === situacaoChave(b) ? String(b.criadaEm).localeCompare(String(a.criadaEm)) : (situacaoChave(a) === 'ativa' ? -1 : 1)));
    for (const c of ordenadas) lista.appendChild(cartaoChave(c));
  }

  async function carregaChaves() {
    const r = await chamar('GET', '/api/v1/chaves-api');
    if (!r.ok) {
      $('chavesEstado').textContent = 'Não consegui carregar as chaves. ' + r.erro;
      $('chavesLista').textContent = '';
      return;
    }
    chaves = Array.isArray(r.json.chaves) ? r.json.chaves : [];
    pintaChaves();
  }

  async function criar(ev) {
    ev.preventDefault();
    const nome = $('fNome').value.trim();
    msg('criarMsg', '');
    if (!nome) { msg('criarMsg', 'Dê um nome à chave, por exemplo "Suporte DG".', 'erro'); return; }
    $('btnCriar').disabled = true;
    const r = await chamar('POST', '/api/v1/chaves-api', { nome, escopos: ['diagnostico'] });
    $('btnCriar').disabled = false;
    if (!r.ok) { msg('criarMsg', 'Não criei a chave. ' + r.erro, 'erro'); return; }
    $('tokenTexto').textContent = r.json.token;
    $('tokenCaixa').hidden = false;
    msg('criarMsg', 'Chave "' + r.json.chave.nome + '" criada.', 'ok');
    await carregaChaves();
  }

  async function revogar(c, botao) {
    botao.disabled = true;
    const r = await chamar('DELETE', '/api/v1/chaves-api?id=' + encodeURIComponent(c.id));
    confirmando = null;
    if (!r.ok) {
      msg('msgGeral', 'Não revoguei a chave "' + c.nome + '". ' + r.erro, 'erro');
    } else {
      msg('msgGeral', '');
      msg('criarMsg', 'A chave "' + c.nome + '" foi revogada. O acesso acabou agora.', 'ok');
    }
    await carregaChaves();
  }

  /* ── Diagnóstico ──────────────────────────────────────────────────────── */
  function cartaoVerificacao(v) {
    const estado = estadoValido(v.estado);
    const card = el('div', 'sp-check ' + estado);
    const topo = el('div', 'sp-check-topo');
    topo.appendChild(el('b', null, v.nome || v.id || 'Verificação sem nome'));
    topo.appendChild(el('span', 'sp-chip ' + estado, ROTULO_ESTADO[estado]));
    card.appendChild(topo);
    if (v.motivo) card.appendChild(el('p', null, v.motivo));
    if (v.o_que_fazer) {
      const p = el('p');
      p.appendChild(el('b', null, 'O que fazer: '));
      p.appendChild(document.createTextNode(v.o_que_fazer));
      card.appendChild(p);
    }
    const evid = linhasDeEvidencia(v.evidencia);
    if (evid.length) {
      const caixa = el('div', 'sp-fraco');
      for (const l of evid) caixa.appendChild(el('div', null, l));
      card.appendChild(caixa);
    }
    if (v.ultimo_sinal) card.appendChild(el('p', 'sp-fraco', 'Último sinal: ' + (dataHora(v.ultimo_sinal) || v.ultimo_sinal)));
    if (v.prompt_sugerido) {
      const caixa = el('div', 'sp-prompt');
      caixa.appendChild(el('pre', null, v.prompt_sugerido));
      const b = el('button', 'sp-btn', 'Copiar');
      b.type = 'button';
      const idMsg = 'diagMsg';
      b.onclick = () => copiar(v.prompt_sugerido, idMsg);
      caixa.appendChild(b);
      card.appendChild(caixa);
    }
    return card;
  }

  function pintaDiagnostico(d) {
    const resumo = $('diagResumo');
    const grupos = $('diagGrupos');
    resumo.textContent = '';
    grupos.textContent = '';
    const r = d.resumo || {};
    const estado = estadoValido(r.estado);
    const caixa = el('div', 'sp-resumo ' + estado);
    caixa.appendChild(el('p', null, r.frase || 'O diagnóstico não trouxe um resumo.'));
    const c = r.contagem || {};
    const partes = ['ok', 'atencao', 'quebrado', 'nao_medido'].filter(k => typeof c[k] === 'number').map(k => c[k] + ' ' + ROTULO_ESTADO[k]);
    if (partes.length) caixa.appendChild(el('p', 'sp-fraco', partes.join(' · ')));
    const v = d.versao;
    if (v && v.instalada) {
      caixa.appendChild(el('p', 'sp-fraco', 'Versão instalada: ' + v.instalada +
        (v.atualizacao_disponivel ? ' (há versão nova' + (v.publicada ? ': ' + v.publicada : '') + ')' : '')));
    }
    resumo.appendChild(caixa);
    $('diagQuando').textContent = d.gerado_em ? 'Gerado em ' + (dataHora(d.gerado_em) || d.gerado_em) : '';
    for (const g of agrupar(d.verificacoes)) {
      const bloco = el('div', 'sp-grupo');
      bloco.appendChild(el('h3', null, g.titulo));
      for (const item of g.itens) bloco.appendChild(cartaoVerificacao(item));
      grupos.appendChild(bloco);
    }
  }

  async function carregaDiagnostico() {
    const b = $('btnAtualizaDiag');
    b.disabled = true;
    msg('diagMsg', 'Conferindo a máquina…');
    const r = await chamar('GET', '/api/v1/diagnostico');
    b.disabled = false;
    if (!r.ok) {
      msg('diagMsg', 'Não consegui ler o diagnóstico. ' + r.erro, 'erro');
      return;
    }
    msg('diagMsg', '');
    pintaDiagnostico(r.json);
  }

  /* ── Tutorial ─────────────────────────────────────────────────────────── */
  const PASSOS = {
    explica: {
      alvo: '[data-tour="explica"]', titulo: 'O suporte remoto',
      oque: 'Um jeito de quem dá suporte ao seu DG Claw ver se está tudo funcionando, sem pedir a senha da sua máquina.',
      como: 'Você cria uma chave e passa para a pessoa. Com ela, o único pedido que funciona é ler o diagnóstico de saúde. Qualquer outra coisa, a chave recusa.',
      porque: 'Quando algo para de funcionar, o suporte enxerga o motivo sem mexer em nada, e você continua dono de tudo.',
    },
    chaves: {
      alvo: '[data-tour="chaves"]', titulo: 'Suas chaves',
      oque: 'A lista de todas as chaves de suporte que já existiram: nome, quando foi criada, os 4 últimos caracteres e quando alguém usou pela última vez.',
      como: 'O último acesso mostra a data e o endereço (IP) de quem leu o diagnóstico. "Revogar" apaga o poder da chave na hora, e o registro continua aqui, marcado como revogado.',
      porque: 'Você confere quem está com acesso e quando usou, e corta quando quiser.',
    },
    criar: {
      alvo: '[data-tour="criar"]', titulo: 'Criar uma chave',
      oque: 'Gera uma chave nova só de leitura do diagnóstico, com o nome que você escolher.',
      como: 'O sistema sorteia a chave e mostra uma vez só. Guardamos apenas uma marca dela, então nem nós conseguimos mostrá-la de novo. Se perder, revogue e crie outra.',
      porque: 'Assim, mesmo que alguém veja os dados do servidor, não consegue descobrir a chave.',
    },
    ve: {
      alvo: '[data-tour="ve"]', titulo: 'O que o suporte vê agora',
      oque: 'O diagnóstico completo, exatamente como a chave de suporte o recebe: um resumo e a lista de verificações da máquina, do Admin e de cada agente.',
      como: 'Cada item tem um estado (funcionando, atenção, quebrado ou não medido), o motivo, o que fazer e, quando existe, um texto pronto para colar numa conversa. "Não medido" quer dizer que o sistema não conseguiu checar, e isso não é o mesmo que estar funcionando.',
      porque: 'Você vê, antes de qualquer pessoa, o que está sendo compartilhado. Aqui não aparece conversa, memória nem arquivo, porque o diagnóstico não leva nada disso.',
    },
  };

  function ajuda(chave) {
    if (!window.DGTour) { msg('msgGeral', 'A visita guiada não carregou. Recarregue a página.', 'erro'); return; }
    window.DGTour.inicia({ passos: [PASSOS[chave]] });
  }

  function tutorialPagina() {
    if (!window.DGTour) { msg('msgGeral', 'A visita guiada não carregou. Recarregue a página.', 'erro'); return; }
    window.DGTour.inicia({ passos: [PASSOS.explica, PASSOS.chaves, PASSOS.criar, PASSOS.ve] });
  }

  function inicia() {
    window.DGSuporteTutorial = tutorialPagina;
    document.querySelectorAll('[data-ajuda]').forEach(b => { b.onclick = () => ajuda(b.dataset.ajuda); });
    $('formCriar').addEventListener('submit', criar);
    $('btnCopiarToken').onclick = () => copiar($('tokenTexto').textContent, 'criarMsg');
    $('btnAtualizaDiag').onclick = carregaDiagnostico;
    carregaChaves();
    carregaDiagnostico();
  }

  return Object.assign({ inicia }, puros);
});
