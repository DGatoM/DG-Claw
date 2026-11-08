'use strict';
// Marca (white label): nome, logo, favicon, cores e fontes lidos de `${DGCLAW_MARCA_DIR}/marca.json`.
// As rotas são públicas (o login precisa delas), então TUDO que vem do arquivo é validado campo a campo:
// campo inválido cai no padrão só daquele campo e vira um aviso no log, em português, com o valor e o que fazer.
// Este módulo NUNCA grava em marca.json (o dono edita à mão; o que for desconhecido fica como está).

const fs = require('node:fs');
const path = require('node:path');

const RX_COR = /^#[0-9a-fA-F]{6}$/;
const RX_FAMILIA = /^[\p{L}0-9 -]{1,60}$/u;
const RX_ARQUIVO = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,99}$/;
const RX_CONTROLE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const RX_MARCAS_HTML = /[<>]/;

const TEXTOS = {
  nome: { max: 60, obrigatorio: true },
  nome_curto: { max: 30, obrigatorio: true },
  slogan: { max: 140, obrigatorio: false },
  titulo_login: { max: 120, obrigatorio: true },
};
const EXT_LOGO = ['.svg', '.png', '.webp', '.jpg'];
const TETO = { logo: 512 * 1024, favicon: 256 * 1024, icone_app: 2 * 1024 * 1024, fonte: 1536 * 1024, json: 64 * 1024 };
const TOKENS_COR = new Set([
  'cor-fundo', 'cor-superficie', 'cor-texto', 'cor-texto-2', 'cor-borda', 'cor-acento', 'cor-sobre-acento', 'cor-link',
  'cor-perigo', 'cor-sucesso', 'cor-aviso', 'botao-fundo', 'botao-texto', 'botao-borda', 'botao2-fundo', 'botao2-texto',
  'campo-fundo', 'campo-texto', 'campo-borda', 'cartao-fundo', 'cartao-borda', 'login-fundo', 'login-pontos',
  'logo-no', 'logo-centro', 'conversa-fundo', 'balao-meu-fundo', 'balao-meu-texto', 'balao-agente-fundo', 'balao-agente-texto',
]);
const TIPOS = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const PILHA_BASE = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif';
const PILHA_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

const escapaHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** @param {{dir:string, padraoJson:string, padraoDir:string, log:Function}} cfg */
function criarMarca(cfg) {
  const { dir, padraoJson, padraoDir, log } = cfg;
  let cache = null; // { chave, dados }

  function padrao() {
    try {
      return JSON.parse(fs.readFileSync(padraoJson, 'utf8'));
    } catch (e) {
      log('erro', `Não li o padrão de fábrica da marca (${padraoJson}: ${e.code || e.message}). Uso nomes mínimos embutidos; reinstale o DG Claw Web para restaurar o arquivo.`);
      return { nome: 'DG Claw', nome_curto: 'DG Claw', slogan: '', titulo_login: 'Entre para falar com os seus agentes.', logo_tem_nome: false, tema: 'claro' };
    }
  }

  const avisados = new Set();
  // O mesmo problema não deve encher o log a cada pedido: avisa uma vez por (campo, valor).
  function avisa(campo, valor, causa, fazer) {
    const v = typeof valor === 'string' ? valor.slice(0, 60) : JSON.stringify(valor === undefined ? null : valor).slice(0, 60);
    const chave = campo + '|' + v + '|' + causa;
    if (avisados.has(chave)) return;
    avisados.add(chave);
    log('aviso', `Marca: o campo "${campo}" de ${path.join(dir, 'marca.json')} foi ignorado (valor recebido: ${JSON.stringify(v)}; ${causa}). Uso o padrão do DG Claw só para esse campo. ${fazer}`);
  }

  /** Confere um arquivo da pasta da marca. Devolve { caminho, tam, mtime } ou null (com aviso). */
  function arquivoOk(campo, nome, extensoes, teto) {
    if (typeof nome !== 'string' || !RX_ARQUIVO.test(nome)) {
      avisa(campo, nome, 'o nome do arquivo precisa ter só letras, números, ponto, hífen e sublinhado, sem barra e sem começar com ponto', 'Coloque o arquivo na pasta da marca e escreva só o nome dele, como logo.png.');
      return null;
    }
    const ext = path.extname(nome).toLowerCase();
    if (!extensoes.includes(ext)) {
      avisa(campo, nome, `a extensão ${ext || '(nenhuma)'} não é aceita aqui`, `Use um destes formatos: ${extensoes.join(', ')}.`);
      return null;
    }
    const caminho = path.join(dir, nome);
    let st;
    try { st = fs.lstatSync(caminho); } catch (e) {
      avisa(campo, nome, e.code === 'ENOENT' ? 'o arquivo não existe na pasta da marca' : `não consegui ler o arquivo (${e.code || e.message})`, 'Confira o nome do arquivo e se ele está na pasta da marca.');
      return null;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      avisa(campo, nome, 'o arquivo é um atalho (link simbólico) ou não é um arquivo comum', 'Copie o arquivo de verdade para a pasta da marca.');
      return null;
    }
    if (st.size === 0 || st.size > teto) {
      avisa(campo, nome, `o arquivo tem ${st.size} bytes e o limite é ${teto}`, 'Use um arquivo menor (e não vazio).');
      return null;
    }
    return { caminho, tam: st.size, mtime: st.mtimeMs, ext, nome };
  }

  function dimensoesPng(caminho) {
    try {
      const fd = fs.openSync(caminho, 'r');
      const b = Buffer.alloc(24);
      fs.readSync(fd, b, 0, 24, 0);
      fs.closeSync(fd);
      if (b.readUInt32BE(0) !== 0x89504e47) return null;
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } catch (_) { return null; }
  }

  function carregar() {
    const base = padrao();
    const dados = {
      nome: base.nome, nome_curto: base.nome_curto, slogan: base.slogan || '', titulo_login: base.titulo_login,
      logo_tem_nome: !!base.logo_tem_nome, tema: base.tema === 'escuro' ? 'escuro' : 'claro',
      cores: {}, cores_escuro: {}, fontes: {}, logo: null, favicon: null, icone_app: null,
    };
    const arq = path.join(dir, 'marca.json');
    let bruto = null;
    try {
      const st = fs.lstatSync(arq);
      if (st.isSymbolicLink() || !st.isFile() || st.size > TETO.json) {
        log('aviso', `Marca: ${arq} foi ignorado (precisa ser um arquivo comum de até ${TETO.json} bytes, não um atalho). Uso a marca padrão do DG Claw.`);
      } else {
        bruto = JSON.parse(fs.readFileSync(arq, 'utf8'));
        if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) { log('aviso', `Marca: ${arq} precisa conter um objeto JSON ({ ... }). Uso a marca padrão do DG Claw.`); bruto = null; }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('aviso', `Marca: não consegui ler ${arq} (${e.code || e.message}). Uso a marca padrão do DG Claw; corrija o JSON (aspas, vírgulas) e a marca volta sozinha.`);
    }
    if (!bruto) return dados;

    for (const [campo, regra] of Object.entries(TEXTOS)) {
      if (!(campo in bruto)) continue;
      const v = bruto[campo];
      if (typeof v !== 'string' || (regra.obrigatorio && !v.trim()) || v.length > regra.max || RX_CONTROLE.test(v) || RX_MARCAS_HTML.test(v)) {
        avisa(campo, v, `precisa ser um texto de até ${regra.max} caracteres, sem quebra de linha, sem < ou >${regra.obrigatorio ? ' e não vazio' : ''}`, 'Corrija o texto em marca.json.');
        continue;
      }
      dados[campo] = v.trim();
    }
    if ('logo_tem_nome' in bruto) {
      if (typeof bruto.logo_tem_nome === 'boolean') dados.logo_tem_nome = bruto.logo_tem_nome;
      else avisa('logo_tem_nome', bruto.logo_tem_nome, 'precisa ser true ou false', 'Escreva true se o logo já traz o nome da marca.');
    }
    if ('tema' in bruto) {
      if (bruto.tema === 'claro' || bruto.tema === 'escuro') dados.tema = bruto.tema;
      else avisa('tema', bruto.tema, 'precisa ser "claro" ou "escuro"', 'Escolha um dos dois.');
    }
    for (const [campo, chave] of [['cores', 'cores'], ['cores_escuro', 'cores_escuro']]) {
      if (!(campo in bruto)) continue;
      const m = bruto[campo];
      if (!m || typeof m !== 'object' || Array.isArray(m)) { avisa(campo, m, 'precisa ser um mapa nome-da-cor para #RRGGBB', 'Exemplo: { "botao-fundo": "#C62828" }.'); continue; }
      for (const [k, v] of Object.entries(m)) {
        const token = String(k).replace(/^--/, '');
        if (!TOKENS_COR.has(token)) { avisa(`${campo}.${String(k).slice(0, 40)}`, v, 'esse nome de cor não está na lista permitida', 'Veja os nomes aceitos em docs/MARCA.md.'); continue; }
        if (typeof v !== 'string' || !RX_COR.test(v)) { avisa(`${campo}.${token}`, v, 'a cor precisa ser #RRGGBB (seis dígitos hexadecimais)', 'Exemplo: #C62828.'); continue; }
        dados[chave][token] = v.toLowerCase();
      }
    }
    if ('logo' in bruto) dados.logo = arquivoOk('logo', bruto.logo, EXT_LOGO, TETO.logo);
    if ('favicon' in bruto) {
      const f = arquivoOk('favicon', bruto.favicon, ['.png'], TETO.favicon);
      if (f && !dimensoesPng(f.caminho)) { avisa('favicon', bruto.favicon, 'o arquivo não é um PNG de verdade', 'Exporte a imagem de novo como PNG.'); } else dados.favicon = f;
    }
    if ('icone_app' in bruto) {
      const f = arquivoOk('icone_app', bruto.icone_app, ['.png'], TETO.icone_app);
      const d = f && dimensoesPng(f.caminho);
      if (f && (!d || d.w !== d.h || d.w < 192)) { avisa('icone_app', bruto.icone_app, 'precisa ser um PNG quadrado de pelo menos 192x192', 'Exporte um PNG quadrado de 512x512.'); } else if (f) { f.lado = d.w; dados.icone_app = f; }
    }
    if ('fontes' in bruto) {
      const fo = bruto.fontes;
      if (!fo || typeof fo !== 'object' || Array.isArray(fo)) avisa('fontes', fo, 'precisa ser { "base": {...}, "mono": {...} }', 'Veja docs/MARCA.md.');
      else {
        for (const papel of ['base', 'mono']) {
          if (!(papel in fo)) continue;
          const d = fo[papel];
          if (!d || typeof d !== 'object' || typeof d.familia !== 'string' || !RX_FAMILIA.test(d.familia)) {
            avisa(`fontes.${papel}.familia`, d && d.familia, 'a família precisa ter só letras, números, espaço e hífen (até 60)', 'Exemplo: "Inter".');
            continue;
          }
          const f = arquivoOk(`fontes.${papel}.arquivo`, d.arquivo, ['.woff2'], TETO.fonte);
          if (f) dados.fontes[papel] = { familia: d.familia, arq: f };
        }
      }
    }
    return dados;
  }

  /** Dados validados, recalculados quando marca.json ou qualquer arquivo citado muda (sem reiniciar). */
  function obter() {
    const parte = (p) => { try { const s = fs.lstatSync(p); return `${s.mtimeMs}:${s.size}`; } catch (_) { return '-'; } };
    let chave = parte(path.join(dir, 'marca.json')) + '|' + parte(padraoJson);
    if (cache) {
      for (const a of cache.arquivos) chave += '|' + parte(a);
      if (chave === cache.chave) return cache.dados;
    }
    const dados = carregar();
    const arquivos = [dados.logo, dados.favicon, dados.icone_app, dados.fontes.base && dados.fontes.base.arq, dados.fontes.mono && dados.fontes.mono.arq].filter(Boolean).map((a) => a.caminho);
    let nova = parte(path.join(dir, 'marca.json')) + '|' + parte(padraoJson);
    for (const a of arquivos) nova += '|' + parte(a);
    cache = { chave: nova, dados, arquivos };
    return dados;
  }

  const corTema = (d) => (d.cores['cor-fundo'] || (d.tema === 'escuro' ? '#0f141b' : '#f3f5f8'));

  /** Troca {{MARCA_*}} (com escape HTML) em uma página. */
  function html(texto) {
    const d = obter();
    const mapa = {
      MARCA_NOME: d.nome, MARCA_SLOGAN: d.slogan, MARCA_TITULO_LOGIN: d.titulo_login,
      MARCA_TEMA: d.tema, MARCA_COR_TEMA: corTema(d),
      MARCA_LOGO_TEM_NOME: d.logo_tem_nome ? 'sim' : 'nao',
    };
    return texto.replace(/\{\{(MARCA_[A-Z_]+)\}\}/g, (m, k) => (k in mapa ? escapaHtml(mapa[k]) : m));
  }

  function css() {
    const d = obter();
    const bloco = (mapa) => Object.entries(mapa).map(([k, v]) => `--${k}:${v};`).join('');
    let s = '/* gerado do marca.json validado; não edite */\n';
    let fontes = '';
    const vars = bloco(d.cores);
    let raiz = vars;
    let fonteVars = '';
    for (const [papel, dado] of Object.entries(d.fontes)) {
      fontes += `@font-face{font-family:"${dado.familia}";font-style:normal;font-weight:100 900;font-display:swap;src:url("/marca/fonte/${papel}") format("woff2")}\n`;
      fonteVars += `--fonte-${papel}:"${dado.familia}",${papel === 'base' ? PILHA_BASE : PILHA_MONO};`;
    }
    s += fontes;
    if (fonteVars) s += `html:root{${fonteVars}}\n`;
    // Especificidade maior que a do :root de tokens.css: vale mesmo se o marca.css vier antes de um CSS que importa os tokens.
    if (raiz) s += `html:root:not([data-tema="escuro"]){${raiz}}\n`;
    const esc = bloco(d.cores_escuro);
    if (esc) s += `html[data-tema="escuro"]:root{${esc}}\n`;
    if (d.logo) {
      s += '.ds-carregando svg{display:none}\n' +
        '.ds-carregando-logo{display:block;background:url("/marca/logo") center/contain no-repeat;animation:ds-car-quieto var(--tempo-carregando-quieto) ease-in-out infinite}\n';
    }
    return s;
  }

  function manifest() {
    const d = obter();
    const icones = d.icone_app
      ? [{ src: '/marca/icone-app', sizes: `${d.icone_app.lado}x${d.icone_app.lado}`, type: 'image/png', purpose: 'any' }]
      : [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
    return JSON.stringify({
      name: d.nome, short_name: d.nome_curto, description: d.slogan || d.nome, lang: 'pt-BR', start_url: '/', scope: '/', display: 'standalone',
      background_color: corTema(d), theme_color: corTema(d), icons: icones,
    });
  }

  /** Arquivo de uma rota /marca/<tipo>: devolve { caminho, tipo, svg } ou null. */
  function arquivo(tipo, papel) {
    const d = obter();
    const pad = (n) => path.join(padraoDir, n);
    let a; let caminho;
    if (tipo === 'logo') { a = d.logo; caminho = a ? a.caminho : pad('logo.svg'); }
    else if (tipo === 'favicon') { a = d.favicon; caminho = a ? a.caminho : pad('favicon.png'); }
    else if (tipo === 'icone-app') { a = d.icone_app; caminho = a ? a.caminho : pad('icone-512.png'); }
    else if (tipo === 'fonte') { a = d.fontes[papel] && d.fontes[papel].arq; if (!a) return null; caminho = a.caminho; }
    else return null;
    return { caminho, tipo: TIPOS[path.extname(caminho).toLowerCase()] || 'application/octet-stream' };
  }

  return { obter, html, css, manifest, arquivo, escapaHtml };
}

module.exports = { criarMarca, escapaHtml, TOKENS_COR };
