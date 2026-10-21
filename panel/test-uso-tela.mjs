// test-uso-tela.mjs — o cartão "Uso da assinatura" (public/js/uso.js).
//
// Roda o arquivo com um `window`, um `document` e um `fetch` de mentira e confere o que
// vai para a tela: cores por faixa, "sem dado" no lugar de 0%, janela vencida, modo API
// e escape de HTML. `node test-uso-tela.mjs` na pasta do painel.

import fs from 'node:fs';
import path from 'node:path';

const AQUI = path.dirname(new URL(import.meta.url).pathname);
const fonte = fs.readFileSync(path.join(AQUI, 'public/js/uso.js'), 'utf-8');

let falhas = 0;
const ok = (cond, oQue) => {
  console.log(`  ${cond ? 'ok  ' : 'FALHOU'}  ${oQue}`);
  if (!cond) falhas++;
};

const el = { innerHTML: '' };
const painel = { offsetParent: {} };
const document = {
  readyState: 'loading',
  visibilityState: 'visible',
  getElementById: (id) => (id === 'uso-assinatura' ? el : id === 'panel-status' ? painel : null),
  addEventListener: () => {},
};
let resposta = { status: 200, json: { ok: true, uso: null } };
globalThis.fetch = async () => ({ ok: resposta.status < 400, status: resposta.status, json: async () => resposta.json });
const janela = { DGCLAW_BASE: '' };
const timers = [];
const setIntervalReal = globalThis.setInterval;
globalThis.setInterval = (f, ms) => { timers.push([f, ms]); return 0; };
new Function('window', 'document', fonte)(janela, document);
globalThis.setInterval = setIntervalReal;
const U = janela.DGUso;

console.log('\nFaixas de cor');
ok(U.corDe(0) === 'verde' && U.corDe(69.9) === 'verde', 'abaixo de 70 é verde');
ok(U.corDe(70) === 'ambar' && U.corDe(89.9) === 'ambar', '70 a 89 é âmbar');
ok(U.corDe(90) === 'vermelho' && U.corDe(100) === 'vermelho', 'a partir de 90 é vermelho');
ok(timers.length === 1 && timers[0][1] === 60_000, 'atualiza a cada 60 s');

console.log('\nHorários');
const agora = new Date(2026, 9, 19, 12, 0, 0); // segunda, 19/10/2026, hora local
ok(U.quandoZera(new Date(2026, 9, 19, 18, 40).toISOString(), agora) === 'hoje 18:40', 'hoje 18:40');
ok(U.quandoZera(new Date(2026, 9, 20, 9, 0).toISOString(), agora) === 'amanhã 09:00', 'amanhã 09:00');
ok(/^qua 09:00$/.test(U.quandoZera(new Date(2026, 9, 21, 9, 0).toISOString(), agora)), 'dia da semana abreviado');
ok(U.quandoZera(new Date(2026, 9, 28, 9, 0).toISOString(), agora) === '28/10 09:00', 'depois de uma semana vira data');
ok(U.haQuanto('2026-10-19T11:50:00.000Z', Date.parse('2026-10-19T12:00:00.000Z')) === 'medido há 10 min', 'medido há 10 min');
ok(U.haQuanto(null) === 'sem hora de medição', 'sem hora não inventa');

console.log('\nO cartão');
const futuro = new Date(Date.now() + 3 * 3600_000).toISOString();
const agoraIso = new Date().toISOString();
resposta = { status: 200, json: { ok: true, uso: { sessao_5h: { usado_pct: 42, zera_em: futuro, vencida: false }, semanal: { usado_pct: 93.5, zera_em: futuro, vencida: false }, medido_em: agoraIso } } };
await U.carregar();
ok(el.innerHTML.includes('42%') && el.innerHTML.includes('93,5%'), 'mostra os dois percentuais');
ok(el.innerHTML.includes('uso-barra verde') && el.innerHTML.includes('uso-barra vermelho'), 'cada barra com a cor da faixa');
ok(el.innerHTML.includes('width:93.5%') && el.innerHTML.includes('zera em') && el.innerHTML.includes('medido agora'), 'largura, "zera em" e "medido"');

resposta = { status: 200, json: { ok: true, uso: { sessao_5h: null, semanal: null, medido_em: null }, motivo: 'Ainda não houve resposta desde o medidor' } };
await U.carregar();
ok((el.innerHTML.match(/sem dado/g) || []).length >= 2 && !el.innerHTML.includes('0%'), 'sem medição: "sem dado" e nenhum 0%');
ok(el.innerHTML.includes('Ainda não houve resposta'), 'mostra o motivo do runner');

resposta = { status: 200, json: { ok: true, uso: { sessao_5h: { usado_pct: 99, zera_em: '2026-10-19T10:00:00.000Z', vencida: true }, semanal: { usado_pct: 5, zera_em: futuro, vencida: false }, medido_em: agoraIso } } };
await U.carregar();
ok(el.innerHTML.includes('zerou às') && el.innerHTML.includes('nova medição na próxima resposta') && !el.innerHTML.includes('99%'), 'janela vencida não mostra o percentual antigo');

resposta = { status: 502, json: { error: 'O agente <b>caiu</b>', howToFix: 'Tente de novo' } };
await U.carregar();
ok(el.innerHTML.includes('&lt;b&gt;caiu') && !el.innerHTML.includes('<b>caiu'), 'texto vindo do servidor é escapado');
ok(el.innerHTML.includes('Tente de novo'), 'erro mostra o que fazer');

U.definirAuth('api');
ok(el.innerHTML.includes('não tem limite de janela') && el.innerHTML.includes('painel do provedor'), 'modo API explica que não há janela');

console.log(falhas ? `\n${falhas} FALHA(S)\n` : '\nTUDO CERTO\n');
process.exit(falhas ? 1 : 0);
