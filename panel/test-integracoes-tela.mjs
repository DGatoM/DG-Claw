// test-integracoes-tela.mjs - a aba Integrações, sem navegador: layout do mapa, tabelas de cor e de
// ícone, frase-resumo, e as garantias de segurança do arquivo (texto de dado nunca vira HTML).
// Uso: node test-integracoes-tela.mjs (na pasta panel)

import fs from 'node:fs';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
let falhas = 0;
const ok = (cond, msg) => { console.log(cond ? `  ok   ${msg}` : `  FALHOU  ${msg}`); if (!cond) falhas++; };

const fonte = fs.readFileSync(path.join(AQUI, 'public/js/integracoes.js'), 'utf-8');
const fonteApi = fs.readFileSync(path.join(AQUI, 'public/js/api.js'), 'utf-8');
const janela = {};
new Function('window', 'document', fonte)(janela, {});
const { puro } = janela.DGIntegracoes;

console.log('\nLayout');
const ids = ['whatsapp', 'instagram', 'gmail', 'pluggy', 'nota-fiscal', 'crm', 'openai', 'elevenlabs', 'google-calendar', 'telegram'];
const a = puro.layout(ids);
const b = puro.layout(ids);
ok(JSON.stringify(a) === JSON.stringify(b), 'o mesmo conjunto de ids dá sempre o mesmo desenho');
ok(a.nos.length === 10 && a.nos.every((n) => n.anel === 1), '10 nós cabem no primeiro anel');
const raios = a.nos.map((n) => n.raio);
ok(new Set(raios.map((r) => r.toFixed(2))).size > 5, 'os raios são diferentes entre si');
ok(raios.every((r) => r >= 190 * 0.88 - 1e-9 && r <= 190 * 1.12 + 1e-9), 'o raio varia no máximo 12% para cada lado');
const um = puro.layout(['instagram']).nos[0];
const um2 = puro.layout(['instagram', 'gmail']).nos.find((n) => n.id === 'instagram');
ok(um.raio === um2.raio, 'o raio de um id não depende dos outros ids');
const topo = puro.layout(['x']).nos[0];
ok(Math.abs(topo.angulo + Math.PI / 2) < Math.PI * 2 * 0.16, 'com um nó só, ele fica perto do topo');
const passo = (Math.PI * 2) / 10;
ok(a.nos.every((n, i) => Math.abs(n.angulo - (-Math.PI / 2 + i * passo)) <= passo * 0.15 + 1e-9), 'ângulos igualmente distribuídos, com desvio de no máximo 15% do passo');
ok(a.nos.every((n) => Math.abs(Math.hypot(n.x, n.y) - n.raio) < 1e-6), 'x e y batem com ângulo e raio');
const treze = Array.from({ length: 15 }, (_, i) => 'sistema-' + i);
const c = puro.layout(treze);
ok(c.nos.filter((n) => n.anel === 1).length === 12 && c.nos.filter((n) => n.anel === 2).length === 3, 'até 12 no primeiro anel; o resto vai para o segundo');
const m1 = Math.max(...c.nos.filter((n) => n.anel === 1).map((n) => n.raio));
const m2 = Math.min(...c.nos.filter((n) => n.anel === 2).map((n) => n.raio));
ok(m2 > m1, 'o segundo anel fica todo depois do primeiro');
ok(c.meia > Math.max(...c.nos.map((n) => n.raio)), 'a área do desenho cobre todos os nós');
ok(c.nos.every((n) => n.x >= c.caixa.x && n.x <= c.caixa.x + c.caixa.w && n.y >= c.caixa.y && n.y <= c.caixa.y + c.caixa.h), 'a caixa do desenho contém todos os nós');
ok(a.nos.every((n) => (Math.abs(Math.sin(n.angulo)) < 0.4 ? ['dir', 'esq'] : n.y < 0 ? ['cima'] : ['baixo']).includes(n.lado)), 'o rótulo fica do lado de fora: acima, abaixo ou ao lado conforme o ângulo');
const g = puro.layout(ids, { raioBase: 230 });
ok(g.nos.every((n) => n.raio >= 230 * 0.88 - 1e-9 && n.raio <= 230 * 1.12 + 1e-9), 'com raio base maior, a variação continua em 12%');
ok(puro.layout([]).nos.length === 0, 'sem integrações, sem nós');
ok(puro.hash('instagram') === puro.hash('instagram') && puro.hash('a') !== puro.hash('b'), 'hash estável e distinto');

console.log('\nCor e ícone por tabela');
for (const [estado, cls] of [['verde', 'verde'], ['amarelo', 'amarelo'], ['vermelho', 'vermelho'], ['desligado', 'desligado'], ['sem_uso_recente', 'sem-uso']]) {
  ok(puro.classeDoEstado(estado) === cls, `estado ${estado} vira a classe ${cls}`);
}
for (const ruim of ['azul', '', null, undefined, 'verde ', 'VERDE', '__proto__', 'constructor', 'toString', 'x" onload="alert(1)']) {
  ok(puro.classeDoEstado(ruim) === null, `estado fora da lista é recusado: ${JSON.stringify(ruim)}`);
}
ok(puro.ESTADOS.verde.pulso === 'calmo' && puro.ESTADOS.amarelo.pulso === 'lento' && puro.ESTADOS.vermelho.pulso === 'falha', 'verde calmo, amarelo lento, vermelho falha');
ok(puro.ESTADOS.desligado.pulso === null && puro.ESTADOS.sem_uso_recente.pulso === null, 'desligado e sem uso recente não têm pulso');
ok(puro.DURACAO.calmo === 2600 && puro.DURACAO.lento === 4000, 'durações do pulso: 2,6 s e 4 s');
ok(puro.iconeSeguro('camera') === 'camera' && puro.iconeSeguro('file-text') === 'file-text', 'ícone da lista passa');
for (const ruim of ['nao-existe', '../../x', '', null, undefined, 42, 'camera"/><script>', '__proto__']) {
  ok(puro.iconeSeguro(ruim) === 'link', `ícone fora da lista vira link: ${JSON.stringify(ruim)}`);
}
const sprite = fs.readFileSync(path.join(AQUI, '../web/public/ds/icones.svg'), 'utf-8');
ok(puro.ICONES.every((n) => sprite.includes(`id="i-${n}"`)), 'todo ícone da lista existe no sprite');
const catalogo = JSON.parse(fs.readFileSync(path.join(AQUI, '../templates/integracoes/catalogo.json'), 'utf-8'));
ok(Object.values(catalogo.integracoes).every((i) => puro.ICONES.includes(i.icone)), 'todo ícone do catálogo está na lista da tela');

console.log('\nTextos');
const dois = [{ estado: 'verde' }, { estado: 'vermelho' }, { estado: 'desligado' }];
ok(puro.frase(dois) === 'Ligado em 2 sistemas · 1 com defeito', 'frase-resumo com defeito, sem contar os desligados');
ok(puro.frase([{ estado: 'verde' }]) === 'Ligado em 1 sistema', 'singular');
ok(/^Ainda não usou nenhum sistema externo\./.test(puro.frase([])), 'sem integrações: convite');
ok(puro.visiveis(dois, true).length === 1 && puro.visiveis(dois, true)[0].estado === 'verde', 'modo aula mostra só o verde');
ok(puro.visiveis([{ estado: 'amarelo' }, { estado: 'sem_uso_recente' }], true).length === 0, 'modo aula nunca inclui o que não é verde');
ok(puro.visiveis(dois, false).length === 3, 'estado real mostra tudo');
ok(puro.quando('2026-11-17T12:00:00Z').length > 8 && puro.quando('lixo') === '' && puro.quando(null) === '', 'data legível; inválida vira vazio');

console.log('\nO centro: foto do agente ou logo');
// DOM de mentira, só o que a tela usa. Serve para ler o que ela desenha, sem navegador.
class No {
  constructor(tag) { this.tagName = tag; this.attrs = {}; this.filhos = []; this.pai = null; this.ouvintes = {}; this.style = {}; this.hidden = false; this.clientWidth = 900; this._texto = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(f) { f.pai = this; this.filhos.push(f); return f; }
  remove() { if (this.pai) this.pai.filhos = this.pai.filhos.filter((x) => x !== this); this.pai = null; }
  addEventListener(ev, fn) { (this.ouvintes[ev] = this.ouvintes[ev] || []).push(fn); }
  dispara(ev) { (this.ouvintes[ev] || []).forEach((fn) => fn({ stopPropagation() {}, key: '' })); }
  set textContent(v) { this.filhos = []; this._texto = String(v); }
  get textContent() { return this._texto + this.filhos.map((f) => f.textContent).join(''); }
  getClientRects() { return [1]; }
  querySelector() { return null; }
  get isConnected() { return true; }
  get ownerSVGElement() { return this; }
  busca(fn, saida = []) { for (const f of this.filhos) { if (fn(f)) saida.push(f); f.busca(fn, saida); } return saida; }
}
function montaTela(foto, chamadas) {
  const ids = {};
  for (const id of ['int-mapa', 'int-mapa-caixa', 'int-resumo-texto', 'int-aviso', 'int-cartao', 'int-resumo', 'int-alternar', 'panel-integracoes']) ids[id] = new No('div');
  const doc = { hidden: false, createElementNS: (ns, tag) => new No(tag), createElement: (tag) => new No(tag),
    createTextNode: (x) => { const n = new No('#text'); n._texto = x; return n; },
    getElementById: (id) => ids[id] || null, querySelectorAll: () => [], addEventListener() {} };
  const dados = { ok: true, medido: true, agente: { nome: 'Ana', slug: 'ana' }, integracoes: [
    { id: 'whatsapp', nome: 'WhatsApp', icone: 'message', estado: 'verde', palavra: 'Funcionando', skills: [] },
    { id: 'instagram', nome: 'Instagram', icone: 'camera', estado: 'vermelho', palavra: 'Com defeito', skills: [] },
    { id: 'telegram', nome: 'Telegram', icone: 'send', estado: 'sem_uso_recente', palavra: 'Sem uso recente', skills: [] }] };
  const win = { matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setInterval: () => 0, addEventListener() {} };
  // O api.js real, carregado como script clássico: `const API` fica no escopo do script, não em window.
  const fetchFalso = async (url, op) => { if (chamadas) chamadas.push({ url, metodo: (op && op.method) || 'GET', corpo: op && op.body }); return { ok: true, status: 200, json: async () => dados }; };
  const API = new Function('window', 'fetch', `${fonteApi}\n;return API;`)({ DGCLAW_BASE: '' }, fetchFalso);
  new Function('window', 'document', 'performance', 'API', fonte)(win, doc, { now: () => 0 }, API);
  return { ids, tela: win.DGIntegracoes, dados };
}
const imagens = (raiz) => raiz.busca((n) => n.tagName === 'image');
{
  const { ids, tela } = montaTela();
  await tela.carregar({ foto: '/assets/sprites/avatar.jpg' });
  const [logo, foto] = imagens(ids['int-mapa']);
  ok(foto && foto.getAttribute('href') === '/assets/sprites/avatar.jpg', 'com avatar, a foto do agente é desenhada no centro');
  ok(logo && logo.getAttribute('href') === '/marca/logo' && logo.getAttribute('visibility') === 'hidden', 'com avatar, o logo fica escondido por baixo');
  foto.dispara('error');
  ok(imagens(ids['int-mapa']).length === 1 && logo.getAttribute('visibility') === 'visible', 'se a foto falhar ao carregar, entra o logo');
  ok(/^\d+\.?\d*$/.test(ids['int-mapa-caixa'].style.height.replace('px', '')) , 'o palco recebe uma altura em px');
}
{
  const { ids, tela } = montaTela();
  await tela.carregar({ foto: '' });
  const imgs = imagens(ids['int-mapa']);
  ok(imgs.length === 1 && imgs[0].getAttribute('href') === '/marca/logo' && imgs[0].getAttribute('visibility') === null, 'sem avatar, o logo do DG Claw aparece no centro');
  imgs[0].dispara('error');
  ok(imagens(ids['int-mapa']).length === 0, 'se nem o logo carregar, sai a imagem e sobra a inicial do nome');
}
{
  const { ids, tela } = montaTela();
  await tela.carregar({ foto: 'https://exemplo.com/x.png' });
  ok(imagens(ids['int-mapa']).length === 1, 'endereço de fora (não começa com uma barra) nunca vira foto');
}
{
  const { ids, tela, dados } = montaTela();
  await tela.carregar({ foto: '' });
  const placas = ids['int-mapa'].busca((n) => n.tagName === 'g' && n.getAttribute('role') === 'button');
  ok(placas.length === 3, 'uma placa por integração');
  ok(placas.every((p) => /: (Funcionando|Com defeito|Sem uso recente)$/.test(p.getAttribute('aria-label'))), 'cada placa diz o estado por escrito');
  ok(ids['int-mapa'].textContent.includes('Funcionando') && ids['int-mapa'].textContent.includes('Desligado'), 'a legenda lista os estados');
  dados.medido = false; dados.motivo = 'sem leitura';
  await tela.carregar();
  ok(ids['int-resumo-texto'].textContent === 'Não foi possível medir as integrações agora.' && imagens(ids['int-mapa']).length === 0, 'medido:false mostra "não foi possível medir" e nenhum mapa');
  dados.medido = true; dados.integracoes = [];
  await tela.carregar();
  ok(/^Ainda não usou nenhum sistema externo/.test(ids['int-resumo-texto'].textContent) && ids['int-mapa-caixa'].hidden === true, 'lista vazia mostra o convite e esconde o palco');
}

console.log('\nBotões Ligar/Desligar no mapa (api.js real, fetch falso)');
for (const [estadoInicial, rotulo, sufixo] of [['verde', 'Desligar no mapa', '/desligar'], ['desligado', 'Ligar no mapa', '/ligar']]) {
  const chamadas = [];
  const { ids, tela, dados } = montaTela('', chamadas);
  dados.integracoes = [{ id: 'instagram', nome: 'Instagram', icone: 'camera', estado: estadoInicial, palavra: 'x', skills: [] }];
  await tela.carregar({ foto: '' });
  const placa = ids['int-mapa'].busca((n) => n.tagName === 'g' && n.getAttribute('role') === 'button')[0];
  placa.dispara('click');
  const botao = ids['int-cartao'].busca((n) => n.tagName === 'button' && /int-botao/.test(n.getAttribute('class') || ''))[0];
  ok(botao && botao.textContent === rotulo, `o cartão mostra o botão "${rotulo}"`);
  chamadas.length = 0;
  await Promise.all((botao.ouvintes.click || []).map((fn) => fn({})));
  const post = chamadas.find((c) => c.metodo === 'POST');
  ok(post && post.url === `/api/integracoes/instagram${sufixo}`, `clicar faz POST em /api/integracoes/instagram${sufixo} (veio ${post && post.url})`);
  ok(post && post.corpo === '{}', 'o corpo do POST é {}');
  ok(chamadas.some((c) => c.metodo === 'GET' && c.url === '/api/integracoes'), 'depois do POST a tela recarrega o mapa');
}
ok(!/raiz\.API|window\.API/.test(fonte), 'a tela não usa raiz.API nem window.API (o API do api.js é um const de script)');

console.log('\nSegurança do arquivo');
ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(fonte), 'nenhum innerHTML, outerHTML, insertAdjacentHTML, write ou eval');
ok(!/—|–/.test(fonte), 'sem travessão no arquivo');
const html = fs.readFileSync(path.join(AQUI, 'public/index.html'), 'utf-8');
ok(html.includes('data-tab="integracoes"') && html.includes('id="panel-integracoes"') && html.includes('js/integracoes.js') && html.includes('css/integracoes.css'), 'o index.html tem a aba, o painel, o script e o estilo');
const css = fs.readFileSync(path.join(AQUI, 'public/css/integracoes.css'), 'utf-8');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'o CSS não tem cor escrita à mão (só tokens)');
ok(/prefers-reduced-motion|reduzMovimento/.test(fonte), 'o pulso respeita "reduzir movimento"');
ok(/box-shadow|gradient\(/.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace('radial-gradient(circle, var(--login-pontos)', '')) === false, 'o CSS não tem sombra nem gradiente (só a textura de pontinhos do login)');
ok(/--login-fundo/.test(css) && /--login-pontos/.test(css), 'o palco usa o fundo e os pontinhos da tela de login');
ok(/document\.hidden/.test(fonte), 'o pulso pausa com a aba do navegador escondida');

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO CERTO');
process.exit(falhas ? 1 : 0);
