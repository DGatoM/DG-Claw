// test-agents-seletor.mjs - Prova que o painel atras da fachada nao conta para a dona de
// um agente que existem os agentes das outras pessoas.
//
// O seletor de agente nasceu num mundo de UMA maquina por dono: varrer o disco e listar
// todo DG Claw achado era exatamente o certo. Com a plataforma isso virou vazamento: a
// Ana fica em /opt/agentes/ana numa VPS onde tambem ficam o Bento e outros agentes,
// e a rota /api/agents dela, servida pela fachada autenticada, devolvia nome, slug e ate
// link dos outros. Medido antes da correcao: ["bento"].
//
// A correcao e o corte no dado (lib/agents.js, opcao soOAtual), nao o esconde-esconde de
// tela: o front ja esconde o seletor abaixo de dois agentes, mas a resposta HTTP continuava
// carregando a lista para quem abrisse o inspetor. Por isso o teste bate na funcao.
//
// Uso: node panel/test-agents-seletor.mjs
//   (o painel nao tem node_modules no repo; este teste nao precisa de nenhum)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let falhas = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const falhou = (msg) => { console.error(`❌ ${msg}`); falhas++; };

// ── Raiz descartavel com dois agentes de mentira ────────────────────────────
// Nunca toca em agente real. Os dois entram por DGCLAW_ROOTS, que e o caminho pelo qual
// /opt/agentes passou a ser enxergado.
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'dgclaw-seletor-'));
const criarAgente = (slug, nome) => {
  const dir = path.join(raiz, slug, '.dgclaw');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.sh'),
    `export DGCLAW_SLUG="${slug}"\nexport DGCLAW_NAME="${nome}"\n`);
};
criarAgente('agente-da-dona', 'Agente da Dona');
criarAgente('agente-de-outra-pessoa', 'Agente de Outra Pessoa');

process.env.DGCLAW_ROOTS = raiz;
const { listar } = require('./lib/agents');

// ── 1. Sem fachada: o comportamento de sempre, byte a byte ──────────────────
// Um DG Claw instalado sozinho na maquina de quem o comprou continua listando os agentes
// dela. A correcao nao pode ter tirado isso: e o modo normal, e e util.
const semFachada = listar('agente-da-dona', 'exemplo.local').map((a) => a.slug);
if (semFachada.includes('agente-da-dona') && semFachada.includes('agente-de-outra-pessoa')) {
  ok('sem fachada: o seletor continua enxergando os dois agentes da maquina');
} else {
  falhou(`sem fachada: esperava os dois agentes na lista, veio ${JSON.stringify(semFachada)}`);
}

// ── 2. Com fachada: so o agente deste painel ────────────────────────────────
const comFachada = listar('agente-da-dona', 'exemplo.local', { soOAtual: true });
const slugs = comFachada.map((a) => a.slug);
if (slugs.length === 1 && slugs[0] === 'agente-da-dona') {
  ok('com fachada: a rota devolve so o agente deste painel');
} else {
  falhou(`com fachada: esperava so ["agente-da-dona"], veio ${JSON.stringify(slugs)}`);
}

// ── 3. Nem o nome do outro escapa ───────────────────────────────────────────
// O slug e o alvo obvio, mas quem le a resposta le o objeto inteiro. Se algum campo novo
// entrar na lista amanha carregando dado de outro agente, este teste cai.
const bruto = JSON.stringify(comFachada);
if (!bruto.includes('outra-pessoa') && !bruto.includes('Outra Pessoa')) {
  ok('com fachada: nenhum vestigio do outro agente na resposta (nem slug, nem nome)');
} else {
  falhou(`com fachada: a resposta ainda menciona o outro agente: ${bruto}`);
}

// ── 4. Sem link para fora ───────────────────────────────────────────────────
// O `url` do seletor e "http://<host>:<porta>/", que e justamente o que a fachada existe
// para nunca mostrar. Atras dela, nenhuma entrada pode trazer porta.
if (comFachada.every((a) => !a.url)) {
  ok('com fachada: nenhuma entrada traz url com porta');
} else {
  falhou('com fachada: alguma entrada trouxe url com porta, que e o que a fachada esconde');
}

fs.rmSync(raiz, { recursive: true, force: true });

console.log('');
if (falhas) {
  console.error(`${falhas} falha(s).`);
  process.exit(1);
}
console.log('4/4 verdes: atras da fachada, o painel so fala do proprio agente.');
