// leitor.js — a janela que abre UM arquivo de memória, renderizado, e deixa editar.
//
// POR QUE ELE EXISTE (Danilo, 01/10/2026). Clicar num arquivo da aba Memória abria
// uma caixa com o texto cru, em letra de código de 13px: "ruim, feia,
// pequenininha". E a memória dele é justamente o que o dono mais precisa conseguir
// LER, porque é ali que se descobre se o agente entendeu errado alguma coisa.
//
// UM COMPONENTE SÓ, quatro lugares: o raio-X da aba Status, a aba Memória, a aba
// Identidade e o histórico da Personalidade. Com uma cópia em cada aba, um dia a
// tipografia melhora numa e não nas outras, ou o "salvar" de uma esquece a trava de
// conflito. Aqui o leitor e o editor são o mesmo objeto.
//
// O QUE ELE GARANTE:
//   - leitura com corpo de 16px, entrelinha 1.6 e linha de no máximo ~72
//     caracteres (o que um livro faz, e o que cansa menos);
//   - JSON formatado, num bloco legível, nunca numa linha só;
//   - editor de texto grande, em fonte monoespaçada de 15px, que funciona no
//     celular (o teclado não cobre o botão de salvar: os botões ficam em cima);
//   - salvar leva a VERSÃO que foi lida. Se o agente escreveu no arquivo enquanto
//     a pessoa editava, o servidor recusa (409) e o texto dela FICA no editor;
//   - fechar com alteração não salva pergunta antes.
//
// O texto que aparece é renderizado pelo js/markdown.js, que escapa tudo antes de
// virar HTML. Nada do arquivo vira tag.

(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function md(texto) {
    return window.DGMarkdown ? window.DGMarkdown.md(texto) : `<pre>${esc(texto)}</pre>`;
  }

  /** "há 3 min", "há 2 h", "ontem", "12/09": o jeito que a pessoa fala. */
  function haQuanto(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'agora há pouco';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    if (s < 2 * 86400) return 'ontem';
    if (s < 7 * 86400) return `há ${Math.round(s / 86400)} dias`;
    return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  const QUEM = { agente: 'ele', rotina: 'uma rotina automática', dono: 'você' };

  /** O miolo renderizado de um arquivo, conforme o tipo. Também usado pelo raio-X. */
  function renderizar(tipo, conteudo) {
    if (tipo === 'json') {
      let bonito;
      try { bonito = JSON.stringify(JSON.parse(conteudo), null, 2); } catch {
        return '<p class="dgl-alerta">Este arquivo deveria ser JSON, mas não está válido. Ele aparece cru abaixo.</p>'
          + `<pre class="app-code">${esc(conteudo)}</pre>`;
      }
      return `<pre class="app-code dgl-json">${esc(bonito)}</pre>`;
    }
    if (tipo === 'md') return md(String(conteudo || '').replace(/^\s*<!--[\s\S]*?-->\s*/, ''));
    return `<pre class="dgl-texto">${esc(conteudo)}</pre>`;
  }

  let estado = null;

  function fechar(forcar) {
    if (!estado) return;
    if (!forcar && estado.editando && estado.campo && estado.campo.value !== estado.arquivo.conteudo) {
      if (!window.confirm('Você mudou o texto e não salvou. Fechar e descartar o que escreveu?')) return;
    }
    document.removeEventListener('keydown', estado.tecla);
    estado.fundo.remove();
    document.body.classList.remove('dgl-aberto');
    if (estado.voltarFoco && document.contains(estado.voltarFoco)) estado.voltarFoco.focus();
    estado = null;
  }

  function recado(tipo, titulo, texto, botoes) {
    const caixa = estado && estado.fundo.querySelector('.dgl-recado');
    if (!caixa) return;
    if (!titulo) { caixa.hidden = true; caixa.innerHTML = ''; return; }
    caixa.hidden = false;
    caixa.className = `dgl-recado ${tipo}`;
    caixa.innerHTML = `<b>${esc(titulo)}</b>${texto ? `<span>${esc(texto)}</span>` : ''}`
      + (botoes && botoes.length ? `<div class="dgl-recado-botoes">${botoes.map((b, i) =>
        `<button type="button" class="dgl-btn ${b.classe || ''}" data-i="${i}">${esc(b.rotulo)}</button>`).join('')}</div>` : '');
    (botoes || []).forEach((b, i) => {
      caixa.querySelector(`[data-i="${i}"]`).addEventListener('click', b.acao);
    });
  }

  function desenharCabeca() {
    const a = estado.arquivo;
    const cab = estado.fundo.querySelector('.dgl-meta');
    const autor = a.autoria || {};
    const partes = [];
    if (a.atualizadoEm) partes.push(`atualizado ${haQuanto(a.atualizadoEm)}`);
    if (autor.voceFoiOUltimo) partes.push('a última mudança foi sua, pelo painel');
    else if (autor.quem) partes.push(`quem escreve: ${QUEM[autor.quem] || autor.quem}`);
    cab.textContent = partes.join(' · ');
    cab.title = [autor.frase, a.atualizadoEm ? `Última mudança: ${new Date(a.atualizadoEm).toLocaleString('pt-BR')}` : '']
      .filter(Boolean).join('\n');
    estado.fundo.querySelector('.dgl-titulo').textContent = estado.titulo || a.titulo || a.path;
    estado.fundo.querySelector('.dgl-caminho').textContent = a.path;
  }

  function modoLeitura() {
    const a = estado.arquivo;
    estado.editando = false;
    estado.campo = null;
    const corpo = estado.fundo.querySelector('.dgl-corpo');
    corpo.innerHTML = `${a.aviso ? `<p class="dgl-aviso">${esc(a.aviso)}</p>` : ''}`
      + `<div class="md-leitura">${renderizar(a.tipo, a.conteudo) || '<p class="dgl-vazio">O arquivo está vazio.</p>'}</div>`;
    const acoes = estado.fundo.querySelector('.dgl-acoes');
    if (a.editavel) {
      acoes.innerHTML = `<button type="button" class="dgl-btn principal" data-acao="editar"
        title="Abre o texto do arquivo para você corrigir à mão. Ele passa a valer na próxima vez que o agente ler este arquivo.">Editar</button>`;
      acoes.querySelector('[data-acao="editar"]').addEventListener('click', modoEdicao);
    } else {
      acoes.innerHTML = `<span class="dgl-so-leitura" title="${esc(a.motivoNaoEditavel || '')}">só leitura</span>`;
    }
    corpo.scrollTop = 0;
  }

  function modoEdicao() {
    const a = estado.arquivo;
    estado.editando = true;
    const corpo = estado.fundo.querySelector('.dgl-corpo');
    corpo.innerHTML = `${a.aviso ? `<p class="dgl-aviso">${esc(a.aviso)}</p>` : ''}`
      + `<label class="dgl-rotulo-editor" for="dgl-editor">Texto do arquivo ${a.tipo === 'json' ? '(JSON: o painel confere se está válido antes de gravar)' : '(markdown)'}</label>`
      + `<textarea id="dgl-editor" class="dgl-editor" spellcheck="${a.tipo === 'md' ? 'true' : 'false'}"></textarea>`;
    const campo = corpo.querySelector('textarea');
    campo.value = estado.rascunho != null ? estado.rascunho : a.conteudo;
    estado.rascunho = null;
    estado.campo = campo;
    const acoes = estado.fundo.querySelector('.dgl-acoes');
    acoes.innerHTML = `<button type="button" class="dgl-btn" data-acao="cancelar" title="Volta para a leitura sem gravar nada.">Cancelar</button>
      <button type="button" class="dgl-btn principal" data-acao="salvar" title="Grava no arquivo de verdade, no lugar de onde ele lê. A versão anterior fica guardada.">Salvar</button>`;
    acoes.querySelector('[data-acao="cancelar"]').addEventListener('click', () => {
      if (campo.value !== a.conteudo && !window.confirm('Descartar o que você mudou?')) return;
      recado(null);
      modoLeitura();
    });
    acoes.querySelector('[data-acao="salvar"]').addEventListener('click', salvar);
    campo.focus();
  }

  async function recarregar() {
    const r = await API.memoriaArquivo(estado.arquivo.path);
    if (!r.ok) {
      recado('erro', (r.corpo && r.corpo.error) || 'Não consegui abrir o arquivo de novo.', (r.corpo && r.corpo.howToFix) || '');
      return false;
    }
    estado.arquivo = r.corpo;
    desenharCabeca();
    return true;
  }

  async function salvar() {
    const campo = estado.campo;
    if (!campo) return;
    const botao = estado.fundo.querySelector('[data-acao="salvar"]');
    if (botao) { botao.disabled = true; botao.textContent = 'salvando...'; }
    recado(null);
    const texto = campo.value;
    const r = await API.memoriaSalvar(estado.arquivo.path, texto, estado.arquivo.versao);
    if (botao) { botao.disabled = false; botao.textContent = 'Salvar'; }

    if (r.ok) {
      estado.arquivo = { ...estado.arquivo, conteudo: texto, versao: r.corpo.versao, atualizadoEm: r.corpo.atualizadoEm,
        autoria: { ...(estado.arquivo.autoria || {}), voceFoiOUltimo: true } };
      desenharCabeca();
      modoLeitura();
      if (r.corpo.semMudanca) { recado('ok', 'Nada mudou, então não gravei nada.', ''); return; }
      recado('ok', 'Salvo.', 'Ele lê este arquivo no começo da próxima conversa. Se quiser que valha já nesta, avise ele.',
        [{ rotulo: 'Avisar ele agora', classe: 'principal', acao: avisar }]);
      if (typeof estado.aoSalvar === 'function') estado.aoSalvar(estado.arquivo);
      return;
    }

    const corpo = r.corpo || {};
    if (r.status === 409) {
      // O texto da pessoa NÃO se perde: ele fica no editor até ela decidir.
      recado('erro', corpo.error || 'Este arquivo mudou enquanto você editava.', corpo.howToFix || '', [
        { rotulo: 'Copiar o meu texto', acao: async () => {
          try { await navigator.clipboard.writeText(campo.value); recado('ok', 'Copiei o seu texto.', 'Agora carregue a versão dele e cole a sua mudança no lugar certo.', [
            { rotulo: 'Carregar a versão dele', classe: 'principal', acao: carregarVersaoDele }]); }
          catch { campo.select(); recado('erro', 'O navegador não deixou copiar sozinho.', 'O texto está selecionado: use Ctrl+C (ou "copiar" no celular).'); }
        } },
        { rotulo: 'Carregar a versão dele', classe: 'principal', acao: carregarVersaoDele },
      ]);
      return;
    }
    recado('erro', corpo.error || 'Não consegui salvar.', corpo.howToFix || 'O seu texto continua no editor. Tente de novo.');
  }

  async function carregarVersaoDele() {
    if (estado.campo && estado.campo.value !== estado.arquivo.conteudo
        && !window.confirm('Carregar a versão dele substitui o que está no editor. Continuar?')) return;
    if (await recarregar()) {
      recado('ok', 'Esta é a versão que está no arquivo agora.', 'Refaça a sua mudança nela e salve.');
      estado.rascunho = null;
      modoEdicao();
    }
  }

  async function avisar() {
    const r = await API.chatEnviar(
      `Editei à mão, pelo painel, o arquivo ${estado.arquivo.path}. Releia esse arquivo antes de continuar, e me diga em uma linha o que mudou para você.`);
    if (r && r.ok) recado('ok', 'Avisei ele pela Conversa.', 'A mensagem aparece lá como sua.');
    else recado('erro', (r && r.corpo && r.corpo.error) || 'Não consegui avisar.', (r && r.corpo && r.corpo.howToFix) || 'O arquivo está salvo; ele lê na próxima conversa.');
  }

  /**
   * Abre um arquivo. `opcoes.titulo` troca o título (o raio-X manda "Memória de
   * trabalho" em vez do nome do arquivo); `opcoes.aoSalvar` é chamado depois de
   * gravar, para a tela de baixo se atualizar.
   */
  async function abrir(caminho, opcoes = {}) {
    const voltarFoco = document.activeElement;
    fechar(true);
    const fundo = document.createElement('div');
    fundo.className = 'dgl-fundo';
    fundo.innerHTML = `
      <div class="dgl-janela" role="dialog" aria-modal="true" aria-labelledby="dgl-titulo">
        <header class="dgl-topo">
          <div class="dgl-topo-texto">
            <h2 class="dgl-titulo" id="dgl-titulo">abrindo...</h2>
            <div class="dgl-sub"><code class="dgl-caminho"></code> <span class="dgl-meta"></span></div>
          </div>
          <div class="dgl-acoes"></div>
          <button type="button" class="dgl-x" aria-label="Fechar" title="Fechar (Esc)">&times;</button>
        </header>
        <div class="dgl-recado" hidden></div>
        <div class="dgl-corpo"><p class="dgl-vazio">Carregando o arquivo...</p></div>
      </div>`;
    document.body.appendChild(fundo);
    document.body.classList.add('dgl-aberto');
    const tecla = (ev) => { if (ev.key === 'Escape') fechar(false); };
    document.addEventListener('keydown', tecla);
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(false); });
    fundo.querySelector('.dgl-x').addEventListener('click', () => fechar(false));
    estado = { fundo, tecla, voltarFoco, titulo: opcoes.titulo || null, aoSalvar: opcoes.aoSalvar, arquivo: { path: caminho } };
    fundo.querySelector('.dgl-caminho').textContent = caminho;
    fundo.querySelector('.dgl-x').focus();

    const r = await API.memoriaArquivo(caminho);
    if (!estado || estado.fundo !== fundo) return; // fechou antes de chegar
    if (!r.ok) {
      fundo.querySelector('.dgl-titulo').textContent = opcoes.titulo || caminho;
      fundo.querySelector('.dgl-corpo').innerHTML = '';
      recado('erro', (r.corpo && r.corpo.error) || 'Não consegui abrir este arquivo.', (r.corpo && r.corpo.howToFix) || '');
      return;
    }
    estado.arquivo = r.corpo;
    desenharCabeca();
    modoLeitura();
  }

  window.DGLeitor = { abrir, fechar: () => fechar(false), renderizar, haQuanto };
})();
