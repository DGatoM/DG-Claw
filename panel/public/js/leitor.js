const dgReviewPanelUI_leitor = (s,p) => globalThis.DGI18n ? globalThis.DGI18n.frase(s,p) : s.replace(/\{([a-z_][a-z_0-9]*)\}/g,(m,k)=>p&&Object.hasOwn(p,k)?String(p[k]):m);
const dgBindFull_leitor = (el, fonte, atributo, valores) => { if(globalThis.DGI18n) return globalThis.DGI18n.rotulo(el,fonte,atributo,valores); const valor=String(fonte).replace(/\{([a-z_][a-z_0-9]*)\}/g,(m,k)=>valores&&Object.hasOwn(valores,k)?String(valores[k]):m); if(atributo)el.setAttribute(atributo,valor);else el.textContent=valor; };
const dgHtmlFull_leitor = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_leitor = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_leitor = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);

const dgTexto_leitor = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
// leitor.js — a janela que abre UM arquivo de memória, renderizado, e deixa editar.
//
// POR QUE ELE EXISTE (01/10/2026). Clicar num arquivo da aba Memória abria
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
    if (s < 90) return dgTextFull_leitor("agora há pouco");
    if (s < 3600) return dgPhraseFull_leitor("há {v0} min",{v0:(Math.round(s / 60))});
    if (s < 86400) return dgPhraseFull_leitor("há {v0} h",{v0:(Math.round(s / 3600))});
    if (s < 2 * 86400) return dgTextFull_leitor("ontem");
    if (s < 7 * 86400) return dgPhraseFull_leitor("há {v0} dias",{v0:(Math.round(s / 86400))});
    return new Date(t).toLocaleDateString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'), { day: '2-digit', month: '2-digit' });
  }

  const QUEM = { agente: 'ele', rotina: 'uma rotina automática', dono: 'você' };

  /** O miolo renderizado de um arquivo, conforme o tipo. Também usado pelo raio-X. */
  function renderizar(tipo, conteudo) {
    if (tipo === 'json') {
      let bonito;
      try { bonito = JSON.stringify(JSON.parse(conteudo), null, 2); } catch {
        return dgHtmlFull_leitor(`<p class="dgl-alerta"><!--dg-i18n:61f3aa8fa6ff-->Este arquivo deveria ser JSON, mas não está válido. Ele aparece cru abaixo.<!--/dg-i18n--></p>`)
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
      if (!window.confirm(dgTextFull_leitor("Você mudou o texto e não salvou. Fechar e descartar o que escreveu?"))) return;
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
        `<button type="button" class="dgl-btn ${b.classe || ''}" data-i="${i}">${globalThis.DGI18n ? globalThis.DGI18n.fragmento(b.rotulo) : esc(b.rotulo)}</button>`).join('')}</div>` : '');
    (botoes || []).forEach((b, i) => {
      caixa.querySelector(`[data-i="${i}"]`).addEventListener('click', b.acao);
    });
  }

  function desenharCabeca() {
    const a = estado.arquivo;
    const cab = estado.fundo.querySelector('.dgl-meta');
    const autor = a.autoria || {};
    const partes = [];
    if (a.atualizadoEm) partes.push(dgPhraseFull_leitor("atualizado {v0}",{v0:(haQuanto(a.atualizadoEm))}));
    if (autor.voceFoiOUltimo) partes.push(dgTextFull_leitor("a última mudança foi sua, pelo painel"));
    else if (autor.quem) partes.push(dgPhraseFull_leitor("quem escreve: {v0}",{v0:(QUEM[autor.quem] || autor.quem)}));
    cab.textContent = partes.join(' · ');
    cab.title = [autor.frase, a.atualizadoEm ? `Última mudança: ${new Date(a.atualizadoEm).toLocaleString((globalThis.DGI18n ? globalThis.DGI18n.locale : 'pt-BR'))}` : '']
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
      + `<div class="md-leitura">${renderizar(a.tipo, a.conteudo) || dgHtmlFull_leitor(`<p class="dgl-vazio"><!--dg-i18n:ef91a6e4af0b-->O arquivo está vazio.<!--/dg-i18n--></p>`)}</div>`;
    const acoes = estado.fundo.querySelector('.dgl-acoes');
    if (a.editavel) {
      acoes.innerHTML = dgHtmlFull_leitor(`<button type="button" class="dgl-btn principal" data-acao="editar"
        data-dg-i18n-title="dd67f6ef678b" title="Abre o texto do arquivo para você corrigir à mão. Ele passa a valer na próxima vez que o agente ler este arquivo."><!--dg-i18n:2eba946b2e1e-->Editar<!--/dg-i18n--></button>`);
      acoes.querySelector('[data-acao="editar"]').addEventListener('click', modoEdicao);
    } else {
      acoes.innerHTML = dgHtmlFull_leitor(`<span class="dgl-so-leitura" title="${esc(a.motivoNaoEditavel || '')}"><!--dg-i18n:3879dacc0cbd-->só leitura<!--/dg-i18n--></span>`);
    }
    corpo.scrollTop = 0;
  }

  function modoEdicao() {
    const a = estado.arquivo;
    estado.editando = true;
    const corpo = estado.fundo.querySelector('.dgl-corpo');
    corpo.innerHTML = `${a.aviso ? `<p class="dgl-aviso">${esc(a.aviso)}</p>` : ''}`
      + dgHtmlFull_leitor(`<label class="dgl-rotulo-editor" for="dgl-editor"><!--dg-i18n:9129de1a3bf2-->Texto do arquivo<!--/dg-i18n--> ${a.tipo === 'json' ? dgTextFull_leitor("(JSON: o painel confere se está válido antes de gravar)") : '(markdown)'}</label>`)
      + `<textarea id="dgl-editor" class="dgl-editor" spellcheck="${a.tipo === 'md' ? 'true' : 'false'}"></textarea>`;
    const campo = corpo.querySelector('textarea');
    campo.value = estado.rascunho != null ? estado.rascunho : a.conteudo;
    estado.rascunho = null;
    estado.campo = campo;
    const acoes = estado.fundo.querySelector('.dgl-acoes');
    acoes.innerHTML = dgHtmlFull_leitor(`<button type="button" class="dgl-btn" data-acao="cancelar" title="Volta para a leitura sem gravar nada."><!--dg-i18n:bb9dbb406dcb-->Cancelar<!--/dg-i18n--></button>
      <button type="button" class="dgl-btn principal" data-acao="salvar" data-dg-i18n-title="63b17fd34ef2" title="Grava no arquivo de verdade, no lugar de onde ele lê. A versão anterior fica guardada."><!--dg-i18n:aef7cd5b2081-->Salvar<!--/dg-i18n--></button>`);
    acoes.querySelector('[data-acao="cancelar"]').addEventListener('click', () => {
      if (campo.value !== a.conteudo && !window.confirm(dgTextFull_leitor("Descartar o que você mudou?"))) return;
      recado(null);
      modoLeitura();
    });
    acoes.querySelector('[data-acao="salvar"]').addEventListener('click', salvar);
    campo.focus();
  }

  async function recarregar() {
    const r = await API.memoriaArquivo(estado.arquivo.path);
    if (!r.ok) {
      recado('erro', (r.corpo && r.corpo.error) || dgTextFull_leitor("Não consegui abrir o arquivo de novo."), (r.corpo && r.corpo.howToFix) || '');
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
    if (botao) { botao.disabled = true; dgBindFull_leitor(botao,'salvando...',undefined); }
    recado(null);
    const texto = campo.value;
    const r = await API.memoriaSalvar(estado.arquivo.path, texto, estado.arquivo.versao);
    if (botao) { botao.disabled = false; dgBindFull_leitor(botao,dgTexto_leitor('Salvar'),undefined); }

    if (r.ok) {
      estado.arquivo = { ...estado.arquivo, conteudo: texto, versao: r.corpo.versao, atualizadoEm: r.corpo.atualizadoEm,
        autoria: { ...(estado.arquivo.autoria || {}), voceFoiOUltimo: true } };
      desenharCabeca();
      modoLeitura();
      if (r.corpo.semMudanca) { recado('ok', dgTextFull_leitor("Nada mudou, então não gravei nada."), ''); return; }
      recado('ok', 'Salvo.', dgTextFull_leitor("Ele lê este arquivo no começo da próxima conversa. Se quiser que valha já nesta, avise ele."),
        [{ rotulo: 'Avisar ele agora', classe: 'principal', acao: avisar }]);
      if (typeof estado.aoSalvar === 'function') estado.aoSalvar(estado.arquivo);
      return;
    }

    const corpo = r.corpo || {};
    if (r.status === 409) {
      // O texto da pessoa NÃO se perde: ele fica no editor até ela decidir.
      recado('erro', corpo.error || dgTextFull_leitor("Este arquivo mudou enquanto você editava."), corpo.howToFix || '', [
        { rotulo: 'Copiar o meu texto', acao: async () => {
          try { await navigator.clipboard.writeText(campo.value); recado('ok', dgReviewPanelUI_leitor("Copiei o seu texto."), dgReviewPanelUI_leitor("Agora carregue a versão dele e cole a sua mudança no lugar certo."), [
            { rotulo: 'Carregar a versão dele', classe: 'principal', acao: carregarVersaoDele }]); }
          catch { campo.select(); recado('erro', dgReviewPanelUI_leitor("O navegador não deixou copiar sozinho."), dgReviewPanelUI_leitor("O texto está selecionado: use Ctrl+C (ou \"copiar\" no celular).")); }
        } },
        { rotulo: 'Carregar a versão dele', classe: 'principal', acao: carregarVersaoDele },
      ]);
      return;
    }
    recado('erro', corpo.error || dgTextFull_leitor("Não consegui salvar."), corpo.howToFix || dgTextFull_leitor("O seu texto continua no editor. Tente de novo."));
  }

  async function carregarVersaoDele() {
    if (estado.campo && estado.campo.value !== estado.arquivo.conteudo
        && !window.confirm(dgTextFull_leitor("Carregar a versão dele substitui o que está no editor. Continuar?"))) return;
    if (await recarregar()) {
      recado('ok', dgTextFull_leitor("Esta é a versão que está no arquivo agora."), dgTextFull_leitor("Refaça a sua mudança nela e salve."));
      estado.rascunho = null;
      modoEdicao();
    }
  }

  async function avisar() {
    const r = await API.chatEnviar(
      `Editei à mão, pelo painel, o arquivo ${estado.arquivo.path}. Releia esse arquivo antes de continuar, e me diga em uma linha o que mudou para você.`);
    if (r && r.ok) recado('ok', 'Avisei ele pela Conversa.', dgTextFull_leitor("A mensagem aparece lá como sua."));
    else recado('erro', (r && r.corpo && r.corpo.error) || dgTextFull_leitor("Não consegui avisar."), (r && r.corpo && r.corpo.howToFix) || dgTextFull_leitor("O arquivo está salvo; ele lê na próxima conversa."));
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
    fundo.innerHTML = dgHtmlFull_leitor(`
      <div class="dgl-janela" role="dialog" aria-modal="true" aria-labelledby="dgl-titulo">
        <header class="dgl-topo">
          <div class="dgl-topo-texto">
            <h2 class="dgl-titulo" id="dgl-titulo">abrindo...</h2>
            <div class="dgl-sub"><code class="dgl-caminho"></code> <span class="dgl-meta"></span></div>
          </div>
          <div class="dgl-acoes"></div>
          <button type="button" class="dgl-x" data-dg-i18n-aria-label="0f2bd88ef0ac" aria-label="Fechar" data-dg-i18n-title="e439f8753d9d" title="Fechar (Esc)">&times;</button>
        </header>
        <div class="dgl-recado" hidden></div>
        <div class="dgl-corpo"><p class="dgl-vazio">${dsCarregando({ rotulo: 'Carregando o arquivo', tamanho: 'p' })} <!--dg-i18n:1aca2cd798be-->Carregando o arquivo...<!--/dg-i18n--></p></div>
      </div>`);
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
      recado('erro', (r.corpo && r.corpo.error) || dgTextFull_leitor("Não consegui abrir este arquivo."), (r.corpo && r.corpo.howToFix) || '');
      return;
    }
    estado.arquivo = r.corpo;
    desenharCabeca();
    modoLeitura();
  }

  window.DGLeitor = { abrir, fechar: () => fechar(false), renderizar, haQuanto };
})();
