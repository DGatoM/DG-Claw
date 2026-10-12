// test-tutoriais.mjs — o "?" de cada seção aponta para um passo que existe?
//
// POR QUE ESTE TESTE EXISTE. O mapa `SECOES` diz "este ? abre o passo `metas` da
// aba `status`", e a lista `PASSOS` é quem tem o passo. São duas listas que
// precisam concordar, e quando elas discordam NADA QUEBRA: o motor do tutorial
// recebe uma chave que não casa com passo nenhum, não acha, e abre no primeiro
// passo da aba. A pessoa clica no "?" de Custos e recebe a explicação da tela
// inteira, sem erro em lugar nenhum.
//
// É o mesmo defeito que apareceu quatro vezes no cofre: sucesso sobre algo que
// não aconteceu. Aqui ele custa barato, e por isso é barato testar.
//
// Também confere que todo alvo de passo é um seletor que existe no index.html,
// porque passo com alvo inexistente é PULADO pelo motor, em silêncio.
//
// `node test-tutoriais.mjs` na pasta do painel.

import fs from 'node:fs';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
const fonte = fs.readFileSync(path.join(AQUI, 'public/js/tutoriais.js'), 'utf-8');
const html = fs.readFileSync(path.join(AQUI, 'public/index.html'), 'utf-8');

// O arquivo é um IIFE que pendura tudo em `window`. Aqui basta um `window` de
// mentira: nada do que o teste usa toca no documento.
const janela = {};
new Function('window', 'document', fonte)(janela, {
  querySelector: () => null,
  querySelectorAll: () => [],
});
const { passosDa } = janela.DGTutoriais;

// O mapa SECOES não é exportado (ele é detalhe interno), então o teste o lê do
// próprio texto do arquivo. Ler a fonte é feio, e é melhor do que abrir uma porta
// no módulo só para o teste espiar.
const SECOES = [...fonte.matchAll(/\{\s*alvo:\s*'([^']+)',\s*aba:\s*'([^']+)',\s*chave:\s*'([^']+)'\s*\}/g)]
  .map((m) => ({ alvo: m[1], aba: m[2], chave: m[3] }));

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

console.log(`\nO mapa de seções (${SECOES.length} entradas)`);
ok(SECOES.length >= 15, 'o teste conseguiu ler o mapa do arquivo');
for (const s of SECOES) {
  const passos = passosDa(s.aba);
  ok(!!passos, `a aba "${s.aba}" tem lista de passos`);
  if (!passos) continue;
  ok(passos.some((p) => p.chave === s.chave),
    `o ? de ${s.alvo} abre o passo "${s.chave}" da aba ${s.aba}`);
  // O alvo precisa existir no HTML, senão o "?" nunca é pendurado em lugar nenhum.
  const id = s.alvo.startsWith('#') ? s.alvo.slice(1) : null;
  if (id) ok(html.includes(`id="${id}"`), `o alvo ${s.alvo} existe no index.html`);
}

console.log('\nOs passos de cada aba');
// 'pulso' saiu em 01/10/2026: a aba foi fundida na Operações. 'como' (Como
// funciona) entrou no lugar.
const ABAS = ['conversa', 'status', 'identity', 'personality', 'memory', 'costs',
  'operations', 'como', 'posts', 'followers', 'reunioes'];
for (const aba of ABAS) {
  const passos = passosDa(aba);
  ok(Array.isArray(passos) && passos.length > 0, `${aba} tem tutorial`);
  if (!passos) continue;
  ok(passos.every((p) => p.titulo && p.corpo && p.porque),
    `${aba}: todo passo responde o que é, como é e POR QUE está ali`);
  ok(passos[0].alvo === null, `${aba}: o primeiro passo fala da tela inteira`);
  const chaves = passos.map((p) => p.chave);
  ok(new Set(chaves).size === chaves.length, `${aba}: nenhuma chave repetida`);
  // Alvo que não existe no HTML faz o motor PULAR o passo, calado.
  for (const p of passos) {
    if (!p.alvo) continue;
    const id = (p.alvo.match(/#([A-Za-z0-9_-]+)/) || [])[1];
    if (id && !p.alvo.includes(' ')) {
      ok(html.includes(`id="${id}"`), `${aba}/${p.chave}: o alvo ${p.alvo} existe no HTML`);
    }
  }
}

console.log('\nA fusão de Operações e Pulso (01/10/2026)');
ok(!html.includes('data-tab="pulso"'), 'a aba Pulso não existe mais no menu');
ok(!html.includes('data-ir-para="pulso"'), 'nenhum link leva para a aba Pulso');
ok(!html.includes('id="panel-pulso"'), 'nem o painel dela');
ok(!html.includes('ext-off-note'), 'nenhum bilhete "isso só aparece com o DG Alive" na tela');
ok(html.includes('data-tab="como"') && html.includes('id="panel-como"'), 'a aba Como funciona existe');

console.log('\nAs abas que desenham o próprio tutorial');
for (const aba of ['apps', 'arquivos', 'cofre']) {
  ok(passosDa(aba) === null, `${aba} NÃO tem passos aqui (o tutorial dela é dela)`);
}

// A aba Socorro também desenha a si mesma: o tutorial dela mora em js/socorro.js, e o
// botão do cabeçalho o acha pelo `.app-tutorial-abrir` que ela desenha. Aqui confere
// que ele existe e que todo passo de lá responde o "por que".
{
  const fonteSocorro = fs.readFileSync(path.join(AQUI, 'public/js/socorro.js'), 'utf-8');
  ok(passosDa('socorro') === null, 'socorro NÃO tem passos aqui (o tutorial dela é dela)');
  ok(/id="socorro-tutorial-abrir"/.test(fonteSocorro) && /app-tutorial-abrir/.test(fonteSocorro),
    'socorro desenha o próprio botão de Tutorial');
  const passosSocorro = [...fonteSocorro.matchAll(/chave: '([^']+)',[\s\S]*?porque: '/g)].map((m) => m[1]);
  ok(passosSocorro.length >= 4 && passosSocorro[0] === 'tela', `socorro tem ${passosSocorro.length} passos, começando pela tela inteira`);
  const ajudas = [...fonteSocorro.matchAll(/data-tutorial="([^"]+)"/g)].map((m) => m[1]);
  ok(ajudas.every((c) => passosSocorro.includes(c)), 'todo "?" da aba Socorro abre um passo que existe');
  ok(html.includes('id="panel-socorro"') && html.includes('data-tab="socorro"'), 'a aba Socorro está no menu e tem painel');
}

console.log(`\n${falhas === 0 ? 'TUDO CERTO' : `${falhas} FALHA(S)`}\n`);
process.exit(falhas === 0 ? 0 : 1);
