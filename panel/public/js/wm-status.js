// wm-status.js: o cartão "Memória de trabalho" da aba Status.
//
// O PEDIDO (Danilo, 05/10/2026, "importantíssimo"): ele abriu o painel e achou que o
// agente não tinha working memory, porque ela só aparecia na aba Memória. Este cartão
// responde na página inicial, sem abrir outra aba: ela existe, está em dia, quando foi
// atualizada, quanto do teto ocupa, se a remontagem das 7h rodou hoje e o que está
// pendente. O conteúdo inteiro continua na aba Memória, e o link leva até lá.
//
// Os números vêm prontos de GET /api/working-memory/status (lib/wm-status.js), que
// diz de onde tirou cada um. Aqui só se desenha. O que a rota mandar como `null` (não
// medido) aparece como "não consegui ver", nunca como zero.
//
// Não depende de nenhum outro script do painel além de window.DGCLAW_BASE, para
// poder ser levado à mão a painéis instalados antes de 01/10/2026.

(function () {
  const BASE = window.DGCLAW_BASE || '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Texto livre (12/10/2026): marcas de Markdown viram negrito/código/link quando o
  // renderizador do painel está carregado. Este arquivo é levado à mão para painéis
  // antigos e precisa funcionar sozinho, então sem ele cai no escape de sempre.
  const rl = (s) => (window.DGMarkdown && window.DGMarkdown.ricoLinha ? window.DGMarkdown.ricoLinha(s) : esc(s));
  // Cada pendência costuma abrir com o assunto em CAIXA ALTA ("PINGENTE BL-254: ...").
  // O assunto vira negrito na frente, para o olho achar onde começa cada uma.
  const pendItem = (s) => {
    const D = window.DGMarkdown;
    if (!D || !D.tituloCaixaAlta) return rl(s);
    const { titulo, corpo } = D.tituloCaixaAlta(s);
    return titulo ? `<b class="wms-pend-assunto">${rl(titulo)}</b> ${rl(corpo)}` : rl(s);
  };
  const num = (n) => (n == null ? null : Number(n).toLocaleString('pt-BR'));

  const ESTADOS = {
    'em-dia': {
      rotulo: 'Em dia',
      cor: 'ok',
      explica: 'Em dia: a remontagem das 7h rodou hoje (ou ainda não era hora) e a máquina mexeu nela há menos de 6 horas.',
    },
    atrasada: {
      rotulo: 'Atrasada',
      cor: 'atencao',
      explica: 'Atrasada: a remontagem das 7h não rodou hoje, falhou, ou ninguém mexe na memória há mais de 6 horas. Ele continua trabalhando com o que tem, mas pode estar com o dia de ontem na cabeça.',
    },
    ausente: {
      rotulo: 'Ausente',
      cor: 'falha',
      explica: 'Ausente: o arquivo working-memory.md não existe na pasta dele. Sem ele, cada conversa começa sem lembrar o que estava fazendo.',
    },
    vazia: {
      rotulo: 'Vazia',
      cor: 'atencao',
      explica: 'Vazia: o arquivo existe, mas não tem nada escrito.',
    },
  };

  const TIP = {
    titulo: 'A memória de trabalho (em inglês, working memory) é o bloco de anotações do momento: o que ele está fazendo, '
      + 'o que ficou pendente e o que combinou com você há pouco. Ele lê este arquivo no começo de toda conversa. '
      + 'Fica no arquivo working-memory.md, na pasta dele.',
    atualizada: 'Quando a máquina mexeu nela pela última vez. Vem da linha "Agora" do próprio arquivo, que o batimento '
      + 'dele reescreve a cada 30 minutos; sem essa linha, da data em que o arquivo foi gravado.',
    tamanho: 'Quantas letras, números e espaços o arquivo tem agora. Entre parênteses, o mesmo em bytes (letra com acento ocupa dois).',
    ocupacao: 'O tamanho do arquivo em bytes dividido pelo teto da remontagem. Acima de 100%, a remontagem das 7h encolhe as '
      + 'seções mais descartáveis e manda o excesso para memory/wm-transbordo.md, que continua pesquisável.',
    remontagem: 'Todo dia às 7h uma rotina remonta a memória: vira o "Hoje" em "Ontem", atualiza as últimas conversas e corta o '
      + 'que passou do teto. Conferido no registro do pulso e no relógio do sistema (o timer da remontagem).',
    pendencias: 'A linha "⚡ PENDÊNCIAS ATIVAS" do topo do arquivo: um resumo, escrito por ele, do que está em aberto com você. '
      + 'É a primeira coisa que ele lê ao começar uma conversa.',
  };

  async function buscar() {
    let res;
    try {
      res = await fetch(`${BASE}/api/working-memory/status`);
    } catch (e) {
      return { ok: false, corpo: { error: `não alcancei o painel (${e.message})`, howToFix: 'Confira a internet e recarregue a página.' } };
    }
    if (res.status === 401) { window.location = `${BASE}/login.html`; return { ok: false, corpo: {} }; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* sem json */ }
    if (res.status === 404) {
      corpo = { error: 'este painel ainda não tem a rota da memória de trabalho', howToFix: 'Avise quem instalou: o painel precisa ser atualizado.' };
    }
    return { ok: res.ok, corpo };
  }

  function item(rotulo, tip, valor, pe, extraClasse) {
    return `<div class="wms-item${extraClasse ? ` ${extraClasse}` : ''}">
      <span class="wms-rot" title="${esc(tip)}">${esc(rotulo)}</span>
      <b class="wms-val">${valor}</b>
      ${pe ? `<span class="wms-pe">${pe}</span>` : ''}
    </div>`;
  }

  function desenhar(el, s) {
    const est = ESTADOS[s.estado] || { rotulo: s.estado, cor: 'sem', explica: '' };
    const naoVi = '<span class="wms-nao">não consegui ver</span>';
    const rem = s.remontagem || {};
    const teto = s.teto || {};
    const hk = s.tetoInicioSessao || {};

    const atualizada = s.atualizadaEm
      ? item('Atualizada', `${TIP.atualizada}\nFonte agora: ${s.atualizadaFonte}.`, esc(s.idadeTexto || ''), esc(s.atualizadaTexto || ''))
      : item('Atualizada', TIP.atualizada, s.arquivo && s.arquivo.existe ? naoVi : '--', s.arquivo && s.arquivo.existe ? '' : 'sem arquivo');

    const tamanho = s.arquivo && s.arquivo.caracteres != null
      ? item('Tamanho', TIP.tamanho, `${esc(num(s.arquivo.caracteres))} caracteres`, `${esc(num(s.arquivo.bytes))} bytes`)
      : item('Tamanho', TIP.tamanho, '--', 'sem arquivo');

    let ocupacao;
    if (s.ocupacaoPct != null) {
      const pct = s.ocupacaoPct;
      const cor = pct > 100 ? 'falha' : (pct >= 90 ? 'atencao' : 'ok');
      const chega = hk.inteira === true ? '\nNo começo de cada conversa ele recebe o arquivo inteiro: o CLAUDE.md dele importa a memória.'
        : (hk.caracteres != null ? `\nNo começo de cada conversa ele recebe até ${num(hk.caracteres)} caracteres (${hk.fonte}).` : '');
      ocupacao = item('Ocupação do teto',
        `${TIP.ocupacao}\nTeto: ${num(teto.bytes)} bytes, de ${teto.fonte}.${chega}`,
        `${esc(pct)}%`,
        `de ${esc(num(teto.bytes))} bytes<span class="wms-barra"><i class="${cor}" style="width:${Math.min(100, pct)}%"></i></span>`);
    } else {
      ocupacao = item('Ocupação do teto', TIP.ocupacao, '--', teto.bytes ? `teto de ${esc(num(teto.bytes))} bytes` : '');
    }

    const remVal = rem.rodouHoje === true ? 'rodou hoje' : (rem.rodouHoje === false ? (rem.falhou ? 'falhou hoje' : 'não rodou hoje') : (rem.fontes && rem.fontes.length ? 'ainda não' : naoVi));
    const remCor = rem.rodouHoje === true ? 'ok' : (rem.rodouHoje === false ? 'ruim' : '');
    const fontesRem = rem.fontes && rem.fontes.length ? `\nConferido em: ${rem.fontes.join(', ')}.` : '';
    const remontagem = item('Remontagem das 7h', `${TIP.remontagem}${fontesRem}`,
      `<span class="${remCor}">${esc(remVal)}</span>`, esc(rem.frase || ''));

    let pend;
    const p = s.pendencias || {};
    if (p.existe && !p.nenhuma) {
      // A linha vem do arquivo com marcas de Markdown (** e `) e com " | " separando
      // os assuntos. Cru, o dono lia asteriscos e uma parede de texto (vistoria de
      // 08/10/2026): aqui as marcas saem e cada assunto vira um item de lista.
      // Com o renderizador carregado (12/10/2026) as marcas viram negrito e código de
      // verdade; sem ele, saem como antes.
      const temMd = !!(window.DGMarkdown && window.DGMarkdown.ricoLinha);
      const itens = (temMd ? String(p.texto || '') : String(p.texto || '').replace(/\*\*/g, '').replace(/`/g, ''))
        .split(/\s+\|\s+/).map((t) => t.trim()).filter(Boolean);
      pend = itens.length > 1
        ? `<ul class="wms-pend-texto wms-pend-lista">${itens.map((t) => `<li>${pendItem(t)}</li>`).join('')}</ul>`
        : `<div class="wms-pend-texto">${pendItem(itens[0] || '')}</div>`;
    }
    else if (p.existe) pend = '<div class="wms-pend-texto wms-fraco">Nenhuma pendência ativa anotada.</div>';
    else pend = `<div class="wms-pend-texto wms-fraco">${s.arquivo && s.arquivo.existe ? 'A memória dele não tem a linha de pendências ativas.' : '--'}</div>`;

    const problema = s.causa || s.oQueFazer
      ? `<div class="wms-problema ${est.cor}">
          ${s.causa ? `<div><b>Por quê:</b> ${rl(s.causa)}</div>` : ''}
          ${s.oQueFazer ? `<div><b>O que fazer:</b> ${rl(s.oQueFazer)}</div>` : ''}
        </div>` : '';
    const avisos = (s.avisos || []).map((a) => `<div class="wms-aviso">${rl(a)}</div>`).join('');

    el.innerHTML = `
      <div class="wms-topo">
        <span class="wms-selo ${est.cor}" title="${esc(est.explica)}"><i></i>${esc(est.rotulo)}</span>
        <span class="wms-frase">${esc(s.frase || '')}</span>
      </div>
      ${problema}
      <div class="wms-grade">${atualizada}${tamanho}${ocupacao}${remontagem}</div>
      <div class="wms-pend">
        <span class="wms-rot" title="${esc(TIP.pendencias)}">⚡ Pendências ativas</span>
        ${pend}
      </div>
      ${avisos}
      <div class="wms-rodape">
        <a href="#" class="wms-ir-memoria" title="Abre a aba Memória, onde está o texto inteiro da memória de trabalho, para ler e corrigir à mão.">Ler a memória de trabalho inteira, na aba Memória →</a>
        <code title="O arquivo, dentro da pasta dele">${esc(s.arquivo ? s.arquivo.caminho : '')}</code>
      </div>`;

    const link = el.querySelector('.wms-ir-memoria');
    if (link) {
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        const aba = document.querySelector('.tab[data-tab="memory"]');
        if (aba) aba.click();
      });
    }
  }

  async function carregar(el) {
    if (!el) return null;
    const r = await buscar();
    if (!r.ok) {
      const c = r.corpo || {};
      el.innerHTML = `<div class="vazio-util">Não consegui ver a memória de trabalho: ${esc(c.error || 'sem resposta do painel')}. ${esc(c.howToFix || '')}</div>`;
      return null;
    }
    desenhar(el, r.corpo);
    return r.corpo;
  }

  window.DGWmStatus = { carregar, TIP };
})();
