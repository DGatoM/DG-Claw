'use strict';
/* saude-servidor.js: o cartão "Saúde do servidor" da tela Segurança (id saude-servidor).

   Lê GET /api/v1/sentinela (o estado que a sentinela do servidor grava a cada minuto) e desenha: barras de disco e de
   memória com a cor do nível, a reserva de disco, os agentes, os serviços, as maiores pastas, as últimas ações
   automáticas e os canais de aviso. O botão Testar avisos chama POST /api/v1/sentinela/testar.
   Medida que não veio (null) aparece como "não medido", nunca como 0. Tudo que vem da API passa por esc().
   Contrato: web/docs/SENTINELA.md. As funções que só montam HTML ficam fora do DOM e têm teste em web/test/sentinela.test.js. */
(function (raiz, fabrica) {
  const m = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGSaudeServidor = m;
})(this, function (raiz) {
  const POLL_MS = 60 * 1000;
  const ROTULO_NIVEL = { ok: 'Tudo certo', aviso: 'Atenção', serio: 'Sério', critico: 'Crítico' };
  const ROTULO_AGENTE = { ok: 'No ar', caido: 'Fora do ar', canal_caido: 'WhatsApp parado', desconhecido: 'Estado desconhecido' };

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ehNum = v => typeof v === 'number' && Number.isFinite(v);
  const fmt = (v, casas) => (ehNum(v) ? v.toLocaleString('pt-BR', { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 }) : null);
  const nivelOk = n => (['ok', 'aviso', 'serio', 'critico'].includes(n) ? n : 'sem');

  function gb(v) { return ehNum(v) ? fmt(v, 1) + ' GB' : 'não medido'; }
  function mb(v) { return ehNum(v) ? (v >= 1024 ? fmt(v / 1024, 1) + ' GB' : fmt(v) + ' MB') : 'não medido'; }

  /* "agora há pouco", "há 5 min", "há 3 h", "há 2 dias". Sem data legível: "não informado". */
  function haQuanto(iso, agora) {
    const t = Date.parse(iso);
    if (!iso || Number.isNaN(t)) return 'não informado';
    const s = Math.max(0, Math.round(((typeof agora === 'number' ? agora : Date.now()) - t) / 1000));
    if (s < 90) return 'agora há pouco';
    if (s < 3600) return 'há ' + Math.round(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.round(s / 3600) + ' h';
    return 'há ' + Math.round(s / 86400) + ' dia' + (Math.round(s / 86400) === 1 ? '' : 's');
  }

  /* Barra de uso: a largura é só o número (0 a 100) já conferido; sem medida, sem barra. */
  function barraHtml(pct, nivel, rotulo) {
    if (!ehNum(pct)) return '<span class="sd-barra sd-sem" role="img" aria-label="' + esc(rotulo) + ': não medido"><i style="width:0"></i></span>';
    const w = Math.max(0, Math.min(100, Math.round(pct)));
    return '<span class="sd-barra sd-n-' + nivelOk(nivel) + '" role="img" aria-label="' + esc(rotulo) + ': ' + w + '% usado"><i style="width:' + w + '%"></i></span>';
  }

  function discoHtml(lista) {
    if (!Array.isArray(lista) || !lista.length) return '<p class="sd-vazio">A sentinela não mediu nenhum disco nesta rodada.</p>';
    return lista.map(d => {
      const usado = ehNum(d.usado_pct) ? fmt(d.usado_pct, 1) + '% usado' : 'uso não medido';
      const livre = ehNum(d.livre_gb) && ehNum(d.total_gb) ? ', ' + fmt(d.livre_gb, 1) + ' GB livres de ' + fmt(d.total_gb, 1) + ' GB' : '';
      const inodes = ehNum(d.inodes_pct) ? ' Arquivos (inodes): ' + fmt(d.inodes_pct, 1) + '% usados.' : '';
      return '<div class="sd-lin"><div class="sd-rot"><b>' + esc(d.ponto || 'disco') + '</b><span class="sd-tag sd-n-' + nivelOk(d.nivel) + '">' + esc(ROTULO_NIVEL[d.nivel] || 'sem nível') + '</span></div>' +
        barraHtml(d.usado_pct, d.nivel, 'Disco ' + (d.ponto || '')) + '<p class="sd-fraco">' + esc(usado + livre + '.' + inodes) + '</p></div>';
    }).join('');
  }

  function ramHtml(r) {
    r = r || {};
    const usado = ehNum(r.usado_pct) ? fmt(r.usado_pct, 1) + '% usada' : 'uso não medido';
    const livre = ehNum(r.disponivel_mb) && ehNum(r.total_mb) ? ', ' + mb(r.disponivel_mb) + ' livres de ' + mb(r.total_mb) : '';
    const swap = ehNum(r.swap_pct) ? ' Swap: ' + fmt(r.swap_pct, 1) + '% usado.' : '';
    return '<div class="sd-lin"><div class="sd-rot"><b>Memória (RAM)</b><span class="sd-tag sd-n-' + nivelOk(r.nivel) + '">' + esc(ROTULO_NIVEL[r.nivel] || 'sem nível') + '</span></div>' +
      barraHtml(r.usado_pct, r.nivel, 'Memória') + '<p class="sd-fraco">' + esc(usado + livre + '.' + swap) + '</p></div>';
  }

  function reservaHtml(r, agora) {
    r = r || {};
    if (r.ligada === false) return '<p>A reserva de emergência está desligada neste servidor.</p>';
    if (r.ligada == null) return '<p class="sd-vazio">Sem informação da reserva nesta rodada.</p>';
    const tam = ehNum(r.tamanho_gb) ? fmt(r.tamanho_gb, 1) + ' GB' : 'tamanho não informado';
    if (r.existe === true) return '<p>Guardada: ' + esc(tam) + ' de disco reservados. Se o disco chegar ao limite extremo, a sentinela os libera sozinha para o servidor ter fôlego.</p>';
    if (r.existe === false) {
      return '<p class="sd-alerta">Liberada' + (r.liberada_em ? ' ' + esc(haQuanto(r.liberada_em, agora)) : '') + ' (' + esc(tam) + '). Isso compra tempo, não resolve: libere espaço no disco. A sentinela a recria sozinha quando o disco sossega.</p>';
    }
    return '<p class="sd-vazio">Não deu para saber se a reserva existe nesta rodada.</p>';
  }

  function agentesHtml(lista) {
    if (!Array.isArray(lista) || !lista.length) return '<p class="sd-vazio">Nenhum agente de trabalho cadastrado neste servidor.</p>';
    return '<ul class="sd-lista">' + lista.map(a => {
      const ok = a.estado === 'ok';
      return '<li><span class="sd-tag ' + (ok ? 'sd-n-ok' : 'sd-n-critico') + '">' + esc(ROTULO_AGENTE[a.estado] || ROTULO_AGENTE.desconhecido) + '</span> <b>' + esc(a.nome || a.slug || 'agente') + '</b>' +
        (a.motivo ? '<p class="sd-fraco">' + esc(a.motivo) + '</p>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function servicosHtml(lista) {
    if (!Array.isArray(lista) || !lista.length) return '<p class="sd-vazio">Nenhum serviço do servidor foi conferido nesta rodada.</p>';
    return '<ul class="sd-lista">' + lista.map(s => '<li><span class="sd-tag ' + (s.ativo === true ? 'sd-n-ok' : s.ativo === false ? 'sd-n-critico' : 'sd-n-sem') + '">' +
      (s.ativo === true ? 'Ativo' : s.ativo === false ? 'Parado' : 'Não conferido') + '</span> <b>' + esc(s.nome || 'serviço') + '</b></li>').join('') + '</ul>';
  }

  function pastasHtml(lista) {
    if (!Array.isArray(lista) || !lista.length) return '<p class="sd-vazio">A lista das maiores pastas só é montada quando o disco passa do limite de aviso, ou quando você roda "sudo dgclaw sentinela levantar".</p>';
    return '<ul class="sd-lista">' + lista.map(p => '<li><b>' + esc(gb(p.gb)) + '</b> <span class="sd-caminho">' + esc(p.caminho || '') + '</span></li>').join('') + '</ul>';
  }

  function acoesHtml(lista, agora) {
    if (!Array.isArray(lista) || !lista.length) return '<p class="sd-vazio">A sentinela ainda não precisou fazer nenhuma limpeza ou ajuste sozinha.</p>';
    return '<ul class="sd-lista">' + lista.map(a => '<li>' + (a.em ? '<span class="sd-fraco">' + esc(haQuanto(a.em, agora)) + '</span> ' : '') + esc(a.descricao || a.tipo || 'ação') +
      (ehNum(a.liberou_mb) ? ' <span class="sd-fraco">(liberou ' + esc(mb(a.liberou_mb)) + ')</span>' : '') + '</li>').join('') + '</ul>';
  }

  function canaisHtml(c, agora) {
    c = c || {};
    const linha = (nome, ligado) => '<li><span class="sd-tag ' + (ligado ? 'sd-n-ok' : 'sd-n-sem') + '">' + (ligado ? 'Ligado' : 'Não configurado') + '</span> <b>' + nome + '</b>' +
      (ligado ? '' : '<p class="sd-fraco">Não configurado: peça ao Admin para configurar.</p>') + '</li>';
    return '<ul class="sd-lista">' + linha('Telegram', c.telegram === true) + linha('E-mail', c.email === true) + linha('Pulso externo', c.pulso === true) + linha('Recado ao Admin', c.admin === true) + '</ul>' +
      (c.ultimo_envio_ok ? '<p class="sd-fraco">Último aviso entregue ' + esc(haQuanto(c.ultimo_envio_ok, agora)) + '.</p>' : '<p class="sd-fraco">Nenhum aviso entregue ainda.</p>') +
      (c.ultima_falha ? '<p class="sd-alerta">Última falha de envio: ' + esc(c.ultima_falha) + '</p>' : '');
  }

  /* O que o motor devolveu no teste: { ok, canais: { telegram|email|pulso|admin: { configurado, ok, motivo } } }.
     ok null = canal não configurado. Formato fora disso aparece cru, como último recurso. */
  function resultadoTesteHtml(resp) {
    const r = resp && resp.resultado;
    const canais = r && r.canais && typeof r.canais === 'object' && !Array.isArray(r.canais) ? r.canais : null;
    const nomes = { telegram: 'Telegram', email: 'E-mail', pulso: 'Pulso externo', admin: 'Recado ao Admin' };
    const chaves = canais ? Object.keys(canais) : [];
    if (!chaves.length || !chaves.every(k => canais[k] && typeof canais[k] === 'object')) {
      return '<p class="sd-fraco">Resposta da sentinela:</p><pre class="sd-pre">' + esc(JSON.stringify(r, null, 2).slice(0, 1500)) + '</pre>';
    }
    const algum = chaves.some(k => canais[k].ok === true);
    const nenhumConfigurado = chaves.every(k => canais[k].ok == null);
    const resumo = nenhumConfigurado
      ? '<p class="sd-alerta" role="alert">Nenhum canal está configurado: os alarmes só aparecem no painel. Peça ao Admin para ligar o Telegram.</p>'
      : algum ? '<p class="sd-fraco" role="status">O teste terminou: veja abaixo qual canal chegou.</p>'
        : '<p class="sd-alerta" role="alert">Nenhum aviso chegou. Veja o motivo de cada canal abaixo.</p>';
    return resumo + '<ul class="sd-lista">' + chaves.map(k => {
      const c = canais[k];
      const rot = esc(nomes[k] || k);
      if (c.ok == null) return '<li><span class="sd-tag sd-n-sem">Não configurado</span> <b>' + rot + '</b><p class="sd-fraco">Não configurado: peça ao Admin para ligar.</p></li>';
      return '<li><span class="sd-tag ' + (c.ok === true ? 'sd-n-ok' : 'sd-n-critico') + '">' + (c.ok === true ? 'Chegou' : 'Não chegou') + '</span> <b>' + rot + '</b>' +
        (c.motivo ? '<p class="sd-fraco">' + esc(c.motivo) + '</p>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function semRodarHtml(motivo) {
    return '<div class="sd-vazio-grande"><p><b>A sentinela ainda não rodou neste servidor.</b></p>' +
      '<p>Ela é o vigia que confere o disco, a memória e os agentes a cada minuto, e avisa você antes de o servidor parar. Assim que ela rodar pela primeira vez, este cartão mostra tudo.</p>' +
      '<p>Se você acabou de atualizar o DG Claw, espere um minuto e recarregue a página. Se continuar assim, peça ao Admin: "confere se a sentinela do servidor está ligada" (no servidor: <code>sudo systemctl status dgclaw-sentinela.timer</code>).</p>' +
      (motivo ? '<p class="sd-fraco">' + esc(motivo) + '</p>' : '') + '</div>';
  }

  function erroHtml(texto) {
    return '<p class="sd-alerta" role="alert">' + esc(texto || 'Não consegui ler a saúde do servidor.') + '</p>';
  }

  /* O corpo do cartão para uma resposta de GET /api/v1/sentinela. Cada bloco tem o próprio id para o tutorial. */
  function corpoHtml(e, agora) {
    if (!e || e.instalado === false) return semRodarHtml(e && e.motivo);
    const resumo = '<p class="sd-resumo"><span class="sd-tag sd-n-' + nivelOk(e.nivel_geral) + '">' + esc(ROTULO_NIVEL[e.nivel_geral] || 'Sem nível') + '</span> ' +
      (e.servidor ? esc(e.servidor) + '. ' : '') + 'Última medição ' + esc(haQuanto(e.atualizado_em, agora)) + '.</p>' +
      (e.parada === true ? '<p class="sd-alerta" role="alert">A sentinela não atualiza há mais de 5 minutos: o que aparece abaixo pode estar velho. Peça ao Admin para conferir se ela está rodando (dgclaw-sentinela.timer).</p>' : '');
    return resumo +
      '<div class="sd-bloco" id="sdDisco"><h3>Disco</h3>' + discoHtml(e.disco) + '</div>' +
      '<div class="sd-bloco" id="sdRam"><h3>Memória</h3>' + ramHtml(e.ram) + '</div>' +
      '<div class="sd-bloco" id="sdReserva"><h3>Reserva de emergência</h3>' + reservaHtml(e.reserva, agora) + '</div>' +
      '<div class="sd-bloco" id="sdAgentes"><h3>Agentes</h3>' + agentesHtml(e.agentes) + '</div>' +
      '<div class="sd-bloco" id="sdServicos"><h3>Serviços do servidor</h3>' + servicosHtml(e.servicos) + '</div>' +
      '<div class="sd-bloco" id="sdPastas"><h3>Maiores pastas</h3>' + pastasHtml(e.maiores_pastas) + '</div>' +
      '<div class="sd-bloco" id="sdAcoes"><h3>Últimas ações automáticas</h3>' + acoesHtml(e.ultimas_acoes, agora) + '</div>' +
      '<div class="sd-bloco" id="sdCanais"><h3>Onde os avisos chegam</h3>' + canaisHtml(e.canais, agora) + '</div>';
  }

  const PASSOS = [
    { alvo: '#saude-servidor', titulo: 'Saúde do servidor',
      oque: 'O retrato do servidor onde o DG Claw roda: quanto do disco e da memória está em uso, se os agentes estão no ar e o que a sentinela já fez sozinha.',
      como: 'A sentinela é um programa leve que roda no servidor a cada minuto. Ela mede o disco e a memória, vê se cada agente responde e grava o resultado. Esta tela só lê esse resultado, nada é medido pelo navegador.',
      porque: 'O servidor para de funcionar quando o disco enche ou a memória acaba, e junto param os agentes que atendem os seus clientes. Ver isso aqui, e ser avisado antes, evita ficar de fora.' },
    { alvo: '#sdDisco', titulo: 'Disco',
      oque: 'Uma barra por disco ou pasta de dados do servidor, com a porcentagem usada e quanto ainda está livre.',
      como: 'A conta é a mesma do comando df: usado dividido por usado mais livre. Os arquivos (inodes) contam igual: disco com poucos inodes livres também trava. Com os limites padrão, a barra fica verde até 75%, amarela a partir de 75%, laranja a partir de 85% e vermelha a partir de 92%.',
      porque: 'Disco cheio é o que mais derruba servidor, e costuma encher devagar sem ninguém ver. A barra mostra a tendência antes da parada.' },
    { alvo: '#sdRam', titulo: 'Memória',
      oque: 'Quanto da memória do servidor está em uso, e quanto do swap (a memória de emergência no disco).',
      como: 'Usada = total menos a memória disponível, dividido pelo total. A sentinela só sobe o nível depois de 2 medições seguidas acima do limite, para um pico de um minuto não assustar.',
      porque: 'Sem memória, o sistema começa a matar programas, e pode matar o agente no meio de uma conversa com um cliente.' },
    { alvo: '#sdReserva', titulo: 'Reserva de emergência',
      oque: 'Um espaço de disco guardado de propósito, como um balão de ar de reserva.',
      como: 'A sentinela reserva um arquivo de alguns GB (no máximo 5% do disco). Se o disco chegar ao limite extremo (97%), ela apaga o arquivo sozinha e devolve esse espaço ao servidor. Quando o disco sossega, ela recria a reserva.',
      porque: 'Com o disco em 100% até o acesso de administração pode falhar. A reserva compra algumas horas para você agir. Ela compra tempo, não resolve.' },
    { alvo: '#sdAgentes', titulo: 'Agentes',
      oque: 'Cada agente de trabalho, com a indicação de que está no ar ou fora, e o motivo quando está fora.',
      como: 'A cada minuto a sentinela pergunta ao agente se ele responde. Depois de 2 falhas seguidas ela o marca como fora do ar e descobre o motivo (container parado, não existe, ou programa travado). O WhatsApp é conferido de tempos em tempos.',
      porque: 'Agente fora do ar é cliente sem resposta. Ver o motivo e o comando para consertar encurta o tempo parado.' },
    { alvo: '#sdServicos', titulo: 'Serviços do servidor',
      oque: 'Os programas que mantêm o painel, o Admin e o endereço seguro (HTTPS) de pé.',
      como: 'A sentinela pergunta ao sistema se cada serviço está ativo. Parado por 2 medições seguidas vira alerta crítico.',
      porque: 'Se o painel ou o Caddy param, você perde o acesso e os clientes perdem os agentes.' },
    { alvo: '#sdPastas', titulo: 'Maiores pastas',
      oque: 'As pastas que mais ocupam o disco, da maior para a menor.',
      como: 'A sentinela soma o tamanho das pastas conhecidas (casas dos agentes, containers, logs, temporários). A medição é pesada, então só roda quando o disco passa do limite de aviso, e o resultado vale por 30 minutos.',
      porque: 'Para saber onde está o espaço antes de decidir o que limpar. Quem apaga, e só com o seu ok, é o Admin.' },
    { alvo: '#sdAcoes', titulo: 'Últimas ações automáticas',
      oque: 'O que a sentinela fez sozinha: limpezas, a reserva liberada ou recriada, memória aliviada.',
      como: 'Só entram aqui ações de uma lista fechada e segura (logs antigos, cache de instalador, imagens soltas, arquivos temporários velhos, cache dos navegadores dos agentes). Cada uma mostra quanto liberou.',
      porque: 'Nada muda no seu servidor sem aparecer aqui. Você vê o que foi feito e quanto adiantou.' },
    { alvo: '#sdCanais', titulo: 'Onde os avisos chegam',
      oque: 'Os canais pelos quais a sentinela avisa: Telegram, e-mail, pulso externo e recado ao Admin. O painel e o celular avisam sempre.',
      como: 'Cada canal aparece como Ligado ou Não configurado. A sentinela não mostra endereço, senha nem token, só se o canal está configurado. Quem configura é o Admin, conversando com você.',
      porque: 'Um alarme que só toca no painel não acorda ninguém de madrugada. O Telegram e o pulso externo avisam mesmo com o servidor travado.' },
    { alvo: '#sdTestar', titulo: 'Testar avisos',
      oque: 'Um botão que manda um aviso de teste em cada canal configurado e mostra qual chegou e qual falhou.',
      como: 'O servidor pede à sentinela para enviar uma mensagem de teste por Telegram, e-mail e pulso, e espera até 1 minuto pela resposta. O resultado aparece logo abaixo do botão, com o motivo de cada falha.',
      porque: 'Alarme que nunca foi testado pode estar quebrado sem você saber. Teste uma vez depois de configurar, e de vez em quando.' },
  ];

  const passosDoCartao = doc => PASSOS.filter(p => !doc || !!doc.querySelector(p.alvo));

  if (!raiz.document) return { esc, fmt, haQuanto, barraHtml, discoHtml, ramHtml, reservaHtml, agentesHtml, servicosHtml, pastasHtml, acoesHtml, canaisHtml, resultadoTesteHtml, semRodarHtml, erroHtml, corpoHtml, PASSOS, passosDoCartao };

  /* ── Parte com DOM ─────────────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  let ocupado = false;
  let testando = false;

  async function carrega() {
    const corpo = $('sdCorpo');
    if (!corpo || ocupado) return;
    ocupado = true;
    try {
      let r;
      try { r = await fetch('/api/v1/sentinela', { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {
        corpo.innerHTML = erroHtml('Não consegui falar com o servidor (' + e.message + '). Confira a conexão e recarregue a página.');
        return;
      }
      let json = null;
      try { json = await r.json(); } catch (e) { json = null; }
      if (!r.ok || !json || json.ok === false) {
        corpo.innerHTML = erroHtml((json && json.erro) || ('O servidor respondeu ' + r.status + ' ao ler a saúde do servidor. Recarregue a página; se continuar, peça ao Admin para ver o log do painel (journalctl -u dgclaw-web).'));
        return;
      }
      corpo.innerHTML = corpoHtml(json, Date.now());
    } finally { ocupado = false; }
  }

  async function testar(botao) {
    if (testando) return;
    testando = true;
    botao.disabled = true;
    const saida = $('sdTesteSaida');
    saida.hidden = false;
    saida.innerHTML = '<p class="sd-fraco" role="status">Mandando um aviso de teste em cada canal… pode levar até 1 minuto.</p>';
    try {
      let r; let json = null;
      try {
        r = await fetch('/api/v1/sentinela/testar', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        try { json = await r.json(); } catch (e) { json = null; }
      } catch (e) {
        saida.innerHTML = erroHtml('Não consegui falar com o servidor (' + e.message + '). Confira a conexão e toque em Testar avisos de novo.');
        return;
      }
      if (!r.ok || !json || json.ok === false) {
        saida.innerHTML = erroHtml((json && json.erro) || ('O servidor respondeu ' + r.status + ' e não explicou o motivo. Rode "sudo dgclaw sentinela testar-avisos" no servidor.'));
        return;
      }
      saida.innerHTML = resultadoTesteHtml(json);
    } finally { testando = false; botao.disabled = false; }
  }

  function comTour(fn) {
    if (raiz.DGTour) { fn(); return; }
    const s = document.createElement('script');
    s.src = '/tour.js';
    s.onload = fn;
    s.onerror = () => { const o = $('sdTesteSaida'); if (o) { o.hidden = false; o.innerHTML = erroHtml('A visita guiada não carregou. Recarregue a página e tente de novo.'); } };
    document.head.appendChild(s);
  }

  function aoClicar(ev) {
    const b = ev.target.closest('button[data-sd]');
    if (!b || b.disabled) return;
    if (b.dataset.sd === 'ajuda') { ev.preventDefault(); comTour(() => raiz.DGTour.inicia({ passos: passosDoCartao(document) })); }
    else if (b.dataset.sd === 'testar') testar(b);
  }

  function inicia() {
    if (!$('saude-servidor')) return;
    document.addEventListener('click', aoClicar);
    carrega();
    setInterval(carrega, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') carrega(); });
    if (location.hash === '#saude-servidor') setTimeout(() => { const s = $('saude-servidor'); if (s) s.scrollIntoView({ block: 'start' }); }, 600);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicia);
  else inicia();

  return { esc, fmt, haQuanto, barraHtml, discoHtml, ramHtml, reservaHtml, agentesHtml, servicosHtml, pastasHtml, acoesHtml, canaisHtml, resultadoTesteHtml, semRodarHtml, erroHtml, corpoHtml, PASSOS, passosDoCartao, carrega };
});
