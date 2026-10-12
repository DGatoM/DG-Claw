// test-texto-rico.mjs: o texto livre do painel é formatado SEM abrir brecha de segurança?
//
// Cobre js/markdown.js (rico, ricoLinha, cortar, tituloCaixaAlta, autolink). O
// ponto que não pode quebrar: tudo é escapado antes de virar tag, então nenhum
// HTML do texto original sobrevive e nenhum esquema perigoso vira link.
//
// `node test-texto-rico.mjs` na pasta do painel. Sai com código 1 se algo falhar.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('./public/js/markdown.js');

let falhas = 0;
function ok(cond, oQue, extra) {
  if (cond) console.log(`  ok   ${oQue}`);
  else { console.log(`  FALHOU  ${oQue}${extra !== undefined ? `\n         ${JSON.stringify(extra)}` : ''}`); falhas++; }
}

let h = D.rico('<script>alert(1)</script>');
ok(!h.includes('<script') && h.includes('&lt;script&gt;'), 'script sai escapado', h);
h = D.rico('<img src=x onerror=alert(1)>');
ok(!h.includes('<img') && h.includes('&lt;img'), 'img com onerror sai escapado', h);
h = D.rico('[x](javascript:alert(1))');
ok(!h.includes('<a '), 'link markdown javascript: não vira <a>', h);
h = D.rico('veja javascript:alert(1) aqui');
ok(!h.includes('<a '), 'javascript: solto não vira link', h);
h = D.rico('data:text/html;base64,AAA e [y](data:text/html,x)');
ok(!h.includes('<a '), 'data: não vira link', h);
h = D.rico('abra https://a.com/"onmouseover="x agora');
ok(!/<a [^>]*onmouseover/.test(h) && h.includes('href="https://a.com/"'), 'aspas não fecham o href', h);
h = D.ricoLinha("ver https://a.com/'x");
ok(h.includes('href="https://a.com/"'), 'aspa simples encerra a URL', h);
h = D.rico('isto é **negrito**');
ok(h.includes('<strong>negrito</strong>'), '** vira <strong>', h);
h = D.rico('use `**dentro de código**` ok');
ok(h.includes('<code>**dentro de código**</code>') && !h.includes('<strong>'), 'negrito dentro de código não vira negrito', h);
h = D.rico('veja (https://exemplo.com/a/b?x=1&y=2), depois.');
ok(h.includes('href="https://exemplo.com/a/b?x=1&amp;y=2"') && h.includes('</a>), depois.'), 'URL solta vira link e a pontuação final fica fora', h);
h = D.rico('confira **https://a.com/x**');
ok(h.includes('href="https://a.com/x"'), 'URL dentro de negrito não leva os asteriscos', h);
h = D.rico('https://a.com/foo_bar_baz e _x_');
ok(h.includes('foo_bar_baz</a>') && !h.includes('<em>bar'), 'sublinhado na URL não vira itálico', h);
h = D.rico('- um\n- dois\n\nparágrafo');
ok(h.includes('<ul>') && h.includes('<li>um') && h.includes('<p>parágrafo</p>'), 'lista e parágrafo', h);
h = D.rico('linha 1\nlinha 2');
ok((h.match(/<p>/g) || []).length === 2, 'linhas viram parágrafos', h);

let t = D.tituloCaixaAlta('IR ATE A ORIGEM DO PEDIDO (11/10). Duas vezes eu fui até lá.');
ok(t.titulo === 'IR ATE A ORIGEM DO PEDIDO (11/10)' && t.corpo.startsWith('Duas vezes'), 'título em caixa alta separado', t);
t = D.tituloCaixaAlta('API caiu às 3h. Voltou.');
ok(t.titulo === '' && t.corpo === 'API caiu às 3h. Voltou.', 'frase com sigla não vira título', t);
t = D.tituloCaixaAlta('NÃO ESQUECER: confirmar o horário com ele.');
ok(t.titulo === 'NÃO ESQUECER' && t.corpo.startsWith('confirmar'), 'título terminado em dois-pontos', t);
t = D.tituloCaixaAlta('OK. Feito.');
ok(t.titulo === '', 'título curto demais não separa', t);
h = D.rico('IR ATE A ORIGEM DO PEDIDO (11/10). Duas vezes eu fui.', { titulo: true });
ok(h.includes('<div class="rt-titulo">IR ATE A ORIGEM DO PEDIDO (11/10)</div>') && h.startsWith('<div class="rt">'), 'rico com titulo:true monta o título', h);
h = D.rico('IR ATE A ORIGEM DO PEDIDO (11/10). Duas vezes eu fui.');
ok(!h.includes('rt-titulo'), 'rico sem a opção não separa título', h);

let c = D.cortar('uma frase com **negrito que vai ser cortado no meio da marca** e mais texto depois', 40);
ok(c.cortou && c.texto.endsWith('…') && (c.texto.match(/\*\*/g) || []).length % 2 === 0, 'cortar não deixa ** órfão', c);
c = D.cortar('veja o `comando muito longo aqui dentro` e siga em frente sempre', 25);
ok(c.cortou && (c.texto.match(/`/g) || []).length % 2 === 0, 'cortar não deixa crase órfã', c);
c = D.cortar('curto', 50);
ok(!c.cortou && c.texto === 'curto', 'texto curto não é cortado', c);
c = D.cortar('palavra1 palavra2 palavra3 palavra4', 20);
ok(c.cortou && c.texto === 'palavra1 palavra2…', 'corta na fronteira de palavra', c);
c = D.cortar('veja [o link bonito](https://a.com/x) e depois mais texto aqui', 20);
ok(!c.texto.includes('[') || c.texto.includes(']('), 'cortar não deixa link markdown pela metade', c);

const semOpts = D.md('veja https://a.com/x agora');
ok(!semOpts.includes('<a ') && semOpts === '<p>veja https://a.com/x agora</p>', 'md() sem opts não autolinka', semOpts);
ok(D.md('veja https://a.com/x', { autolink: true }).includes('<a href="https://a.com/x"'), 'md() com autolink linka');
ok(D.md('[t](https://a.com)').includes('<a href="https://a.com"'), 'link markdown continua igual');

ok(D.rico('') === '' && D.rico(null) === '' && D.rico(undefined) === '', 'rico vazio/null devolve vazio');
ok(D.ricoLinha('') === '' && D.ricoLinha(null) === '', 'ricoLinha vazio/null devolve vazio');
h = D.ricoLinha('a **b** `c` <b>x</b> https://a.com.');
ok(h.includes('<strong>b</strong>') && h.includes('<code>c</code>') && h.includes('&lt;b&gt;') && !h.includes('<p>') && h.includes('</a>.'), 'ricoLinha: marcas sem <p> e HTML escapado', h);

console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
process.exit(falhas ? 1 : 0);
