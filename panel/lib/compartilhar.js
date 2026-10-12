// compartilhar.js — O roteiro pronto virando UM link que o dono manda pro cliente.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  O ARQUIVO PUBLICADO É AUTOSSUFICIENTE. UM HTML, E MAIS NADA.            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// As imagens vão DENTRO do arquivo, como data: URI, e não como link para cá.
// Três motivos, e nenhum deles é preferência:
//
//   1. quem abre o link é uma pessoa de fora, no celular, sem senha nenhuma. Um
//      `<img src="http://127.0.0.1:8303/...">` abriria uma página de fotos
//      quebradas, e ela não teria como saber por quê;
//   2. o painel do agente fica atrás de login, de propósito. Servir a imagem por
//      um caminho público seria abrir um buraco na porta que a gente acabou de
//      trancar;
//   3. o link continua funcionando com o painel fora do ar, com o agente
//      desligado e daqui a seis meses. O que foi enviado ao cliente não deveria
//      depender de uma máquina continuar de pé.
//
// O QUE VAI NA PÁGINA, nesta ordem: o roteiro (que é o que a pessoa pediu para
// ler), depois o material que já existe, e por último o que ainda falta e de
// quem é. A última seção é a que evita a pergunta "cadê o resto?": ela responde
// antes, e diz quem tem que fazer.
//
// NADA DE SEGREDO ATRAVESSA. Só entram arquivos de dentro da pasta do projeto, e
// só os tipos que a tela sabe mostrar. O `.dgclaw/`, o `config.sh` e qualquer
// coisa fora de `arquivos/projetos/<slug>/` são inalcançáveis daqui, porque este
// módulo nunca monta caminho a partir de texto que veio de fora: ele lista a
// pasta e usa o que achou.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { md, esc } = require('../public/js/markdown');
const { extDe, mimeDaExt, tipoDaExt } = require('./mime');

/**
 * Teto do que vai embutido, e o que acontece quando estoura.
 *
 * 12 MB é generoso para um roteiro com quinze provas de tela e ainda abre rápido
 * no 4G do cliente. Acima disso os arquivos que não couberam são LISTADOS na
 * página, com o tamanho, em vez de sumirem. Truncar em silêncio faria a página
 * dizer "este é o material" mostrando metade dele, que é exatamente o defeito
 * que a gente passou o dia consertando neste painel.
 */
const TETO_EMBUTIDO = 12 * 1024 * 1024;

/** Tipos que a página sabe MOSTRAR ali mesmo, sem a pessoa clicar em nada. */
const MOSTRAVEIS = ['imagem', 'video', 'audio'];

function buildCompartilhar(CONFIG) {
  const RAIZ_PROJETOS = path.resolve(CONFIG.agentDir, 'arquivos', 'projetos');

  /**
   * O comando que publica. Recebe o caminho do arquivo e imprime a URL.
   *
   * Configurável de propósito: quem instalar este painel noutra casa não tem o
   * mesmo bucket de quem escreveu o painel, e o certo é falhar dizendo o que configurar, não publicar no
   * bucket de outra pessoa.
   */
  function comandoDePublicar() {
    // Sem padrão (S19): um padrão aqui seria o comando de uma máquina específica.
    const cmd = (CONFIG.publicarCmd || process.env.DGCLAW_PUBLICAR_CMD || '').trim();
    if (!cmd) return null;
    const partes = cmd.split(/\s+/);
    return { bin: partes[0], args: partes.slice(1) };
  }

  function lerTexto(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
  }

  /** Os arquivos da pasta de material do projeto, com o que a página precisa. */
  function materiais(dirProjeto, subpasta) {
    const dir = path.join(dirProjeto, subpasta);
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch { return []; }
    return nomes
      .filter((n) => !n.startsWith('.'))
      .sort()
      .map((nome) => {
        const p = path.join(dir, nome);
        let st;
        try { st = fs.statSync(p); } catch { return null; }
        if (!st.isFile()) return null;
        const ext = extDe(nome);
        return { nome, caminho: p, bytes: st.size, ext, tipo: tipoDaExt(ext) };
      })
      .filter(Boolean);
  }

  /**
   * Embute o que couber no teto, na ordem da pasta, e devolve o que ficou de fora.
   *
   * A ordem é a do nome do arquivo (01-, 02-, ...), que é a ordem em que o asset
   * aparece no vídeo. Deixar de fora o começo do vídeo para caber o fim seria a
   * escolha errada, e é por isso que não se ordena por tamanho.
   */
  function embutir(lista) {
    let usado = 0;
    const dentro = [];
    const fora = [];
    // PLANILHA TAMBÉM VAI DENTRO, como download.
    //
    // A primeira versão embutia só imagem, vídeo e áudio, e listava o resto num
    // bloco "o que ainda não está aqui". Só que os quatro .xlsx deste roteiro são
    // a assinatura didática do canal: são o que o cliente mais quer na mão. Dizer
    // a ele "existem quatro planilhas, e elas não estão aqui" é a versão educada
    // de não entregar. Navegador nenhum ABRE um .xlsx, mas todo navegador BAIXA
    // um, e é isso que a página passa a oferecer.
    //
    // Fica no bloco "o que ainda não está aqui" só o que realmente não veio: o
    // que não coube no teto e o que deu erro de leitura.
    for (const m of lista) {
      if (usado + m.bytes > TETO_EMBUTIDO) { fora.push({ ...m, motivo: 'não coube no tamanho da página' }); continue; }
      let b64;
      try { b64 = fs.readFileSync(m.caminho).toString('base64'); }
      catch (e) { fora.push({ ...m, motivo: `não consegui ler: ${e.message}` }); continue; }
      usado += m.bytes;
      dentro.push({
        ...m,
        mostravel: MOSTRAVEIS.includes(m.tipo),
        dataUri: `data:${mimeDaExt(m.ext)};base64,${b64}`,
      });
    }
    return { dentro, fora, usado };
  }

  function bytesHumano(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** O HTML inteiro. Sem fonte de fora, sem script, sem pedido de rede nenhum. */
  function montarHtml({ titulo, data, roteiro, catalogo, dentro, fora, agente }) {
    const mostraveis = dentro.filter((m) => m.mostravel);
    const baixaveis = dentro.filter((m) => !m.mostravel);

    const galeria = mostraveis.map((m) => {
      const midia = m.tipo === 'imagem'
        ? `<img src="${m.dataUri}" alt="${esc(m.nome)}" loading="lazy">`
        : m.tipo === 'video'
          ? `<video src="${m.dataUri}" controls playsinline preload="metadata"></video>`
          : `<audio src="${m.dataUri}" controls preload="metadata"></audio>`;
      return `<figure class="peca">
          ${midia}
          <figcaption>${esc(m.nome)} <span class="peso">${esc(bytesHumano(m.bytes))}</span></figcaption>
        </figure>`;
    }).join('\n');

    const paraBaixar = baixaveis.length
      ? `<section class="bloco">
           <h2>Para baixar (${baixaveis.length})</h2>
           <p class="nota">Planilha e documento não abrem dentro do navegador, mas estão guardados
              nesta mesma página: clicar baixa o arquivo, sem precisar de internet.</p>
           <ul class="baixar">${baixaveis.map((m) =>
             `<li><a href="${m.dataUri}" download="${esc(m.nome)}">${esc(m.nome)}</a>
                  <span class="peso">${esc(bytesHumano(m.bytes))}</span></li>`).join('')}</ul>
         </section>`
      : '';

    const pendentes = fora.length
      ? `<section class="bloco">
           <h2>O que ainda não está aqui</h2>
           <p class="nota">Estes arquivos existem na pasta do projeto mas não entraram nesta página:</p>
           <ul class="faltando">${fora.map((m) =>
             `<li><code>${esc(m.nome)}</code> <span class="peso">${esc(bytesHumano(m.bytes))}</span> — ${esc(m.motivo)}</li>`).join('')}</ul>
         </section>`
      : '';

    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titulo)}</title>
<style>
  :root { color-scheme: light dark; --tinta:#16181d; --fundo:#fff; --fraco:#5c6270;
          --linha:#e3e6ec; --caixa:#f7f8fa; --realce:#2f6fed; }
  @media (prefers-color-scheme: dark) {
    :root { --tinta:#e8eaf0; --fundo:#14161b; --fraco:#9aa1b0; --linha:#272b34;
            --caixa:#1b1e25; --realce:#6ea8fe; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0 20px 80px; background:var(--fundo); color:var(--tinta);
         font:16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .folha { max-width: 820px; margin: 0 auto; }
  header.capa { padding: 40px 0 24px; border-bottom: 1px solid var(--linha); margin-bottom: 32px; }
  header.capa h1 { margin:0 0 6px; font-size: 30px; line-height:1.2; }
  header.capa .sub { color: var(--fraco); font-size: 14px; }
  .bloco { margin: 40px 0; }
  .bloco > h2 { font-size: 20px; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--linha); }
  h3 { font-size: 18px; margin: 28px 0 8px; }
  p { margin: 0 0 14px; }
  code { background: var(--caixa); padding: 1px 5px; border-radius: 4px; font-size: .9em; }
  pre { background: var(--caixa); padding: 14px; border-radius: 8px; overflow-x: auto; }
  blockquote { margin: 0 0 14px; padding-left: 14px; border-left: 3px solid var(--linha); color: var(--fraco); }
  ul { margin: 0 0 14px; padding-left: 22px; }
  a { color: var(--realce); }
  /* Tabela larga rola dentro da própria caixa. A página nunca rola de lado. */
  .app-tabela-rolagem { overflow-x: auto; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid var(--linha); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: var(--caixa); }
  .galeria { display: grid; gap: 22px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .peca { margin: 0; }
  .peca img, .peca video { width: 100%; height: auto; border: 1px solid var(--linha); border-radius: 8px; display: block; background: var(--caixa); }
  .peca audio { width: 100%; }
  figcaption { font-size: 12.5px; color: var(--fraco); margin-top: 6px; word-break: break-word; }
  .peso { opacity: .7; }
  .nota { color: var(--fraco); font-size: 14px; }
  .faltando { font-size: 14px; color: var(--fraco); }
  .baixar { list-style: none; padding: 0; }
  .baixar li { padding: 9px 0; border-bottom: 1px solid var(--linha); }
  .baixar a { font-weight: 600; }
  footer { margin-top: 60px; padding-top: 18px; border-top: 1px solid var(--linha);
           color: var(--fraco); font-size: 13px; }
</style>
</head>
<body>
<div class="folha">
  <header class="capa">
    <h1>${esc(titulo)}</h1>
    <div class="sub">${esc(data ? `Projeto de ${data}` : 'Projeto')}${agente ? ` · preparado por ${esc(agente)}` : ''}</div>
  </header>

  <section class="bloco">
    <h2>Roteiro</h2>
    ${roteiro ? md(roteiro) : '<p class="nota">O roteiro deste projeto ainda não foi escrito.</p>'}
  </section>

  <section class="bloco">
    <h2>O material${mostraveis.length ? ` (${mostraveis.length})` : ''}</h2>
    ${mostraveis.length
      ? `<div class="galeria">${galeria}</div>`
      : '<p class="nota">Nenhuma imagem, vídeo ou áudio foi produzido para este roteiro ainda.</p>'}
  </section>

  ${paraBaixar}

  ${pendentes}

  ${catalogo ? `<section class="bloco">
    <h2>De onde vem cada peça</h2>
    <p class="nota">A lista completa do material, com o que cada um prova no roteiro e de quem é a captura.</p>
    ${md(catalogo)}
  </section>` : ''}

  <footer>
    Página gerada a partir da pasta do projeto. As imagens estão dentro deste próprio arquivo,
    então ele continua abrindo mesmo offline e mesmo daqui a muito tempo.
  </footer>
</div>
</body>
</html>`;
  }

  /**
   * Monta e publica. Devolve `{ ok, url, ... }` ou `{ erro, status }`.
   *
   * Nenhum caminho vem de fora: `slug` é conferido contra a lista de pastas que
   * existem, e o resto é montado a partir do que a pasta tem.
   */
  function publicar(slug, opcoes = {}) {
    let pastas;
    try { pastas = fs.readdirSync(RAIZ_PROJETOS); }
    catch (e) {
      return Promise.resolve({
        erro: `Não consegui abrir a pasta de projetos do agente: ${e.message}`,
        status: 500,
      });
    }
    if (!pastas.includes(slug)) {
      return Promise.resolve({
        erro: `Não existe um projeto chamado "${slug}" na pasta deste agente.`,
        status: 404,
      });
    }

    const dirProjeto = path.join(RAIZ_PROJETOS, slug);
    const roteiro = lerTexto(path.join(dirProjeto, opcoes.arquivo || 'roteiro.md'));
    if (!roteiro) {
      return Promise.resolve({
        erro: 'Este projeto ainda não tem roteiro escrito, então não há o que mandar para o cliente.',
        status: 409,
      });
    }
    const catalogo = lerTexto(path.join(dirProjeto, 'catalogo-assets.md'));
    const { dentro, fora, usado } = embutir(materiais(dirProjeto, opcoes.pasta || 'assets'));

    const m = slug.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
    const titulo = (m ? m[4] : slug).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const data = m ? `${m[3]}/${m[2]}/${m[1]}` : null;

    const html = montarHtml({
      titulo, data, roteiro, catalogo, dentro, fora, agente: CONFIG.agentName,
    });

    // O nome do arquivo publicado leva um sufixo aleatório porque a URL é o
    // único segredo desta página: sem ele, quem soubesse o nome do projeto
    // adivinharia o endereço. Não é senha, e a tela diz isso para quem gera.
    const sufixo = require('crypto').randomBytes(6).toString('hex');
    const nomeArquivo = `roteiro-${slug}-${sufixo}.html`.replace(/[^A-Za-z0-9._-]/g, '-');
    const tmp = path.join(require('os').tmpdir(), nomeArquivo);

    try { fs.writeFileSync(tmp, html, 'utf8'); }
    catch (e) {
      return Promise.resolve({ erro: `Não consegui montar a página: ${e.message}`, status: 500 });
    }

    const comando = comandoDePublicar();
    if (!comando) {
      return Promise.resolve({
        erro: 'Este painel não tem um comando de publicar configurado, então a página foi montada mas não foi para lugar nenhum.',
        howToFix: 'Configure `publicarCmd` no config.json do painel, ou DGCLAW_PUBLICAR_CMD no serviço, '
          + 'apontando para um comando que receba o caminho de um arquivo e imprima a URL pública dele.',
        status: 503,
      });
    }
    const { bin, args } = comando;
    if (!fs.existsSync(bin)) {
      return Promise.resolve({
        erro: `O comando que publica ("${bin}") não existe nesta máquina, então a página foi montada mas não foi para lugar nenhum.`,
        howToFix: 'Configure `publicarCmd` no config.json do painel, ou DGCLAW_PUBLICAR_CMD no serviço, '
          + 'apontando para um comando que receba o caminho de um arquivo e imprima a URL pública dele.',
        status: 503,
      });
    }

    return new Promise((resolve) => {
      execFile(bin, [...args, tmp], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmp); } catch { /* o temporário some no próximo boot de qualquer jeito */ }
        const saida = `${stdout || ''}\n${stderr || ''}`;
        const url = (saida.match(/https?:\/\/\S+/) || [])[0];
        if (err || !url) {
          return resolve({
            erro: 'A página foi montada, mas quem publica não devolveu um endereço.',
            detalhe: (saida.trim().split('\n').slice(-3).join(' · ') || String(err && err.message)).slice(0, 400),
            status: 502,
          });
        }
        resolve({
          ok: true,
          url,
          arquivo: nomeArquivo,
          embutidos: dentro.length,
          deFora: fora.length,
          tamanho: usado + Buffer.byteLength(html, 'utf8'),
        });
      });
    });
  }

  return { publicar };
}

module.exports = { buildCompartilhar, TETO_EMBUTIDO };
