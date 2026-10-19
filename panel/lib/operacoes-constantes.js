'use strict';
// operacoes-constantes.js: ids do journal, janelas de tempo e o agrupamento por propósito da aba Operações.

const ID = {
  TERMINOU: '39f53479d3a045ac8e11786248231fbf',
  FALHOU_AO_RODAR: 'be02cf6855d2428ba40df7e9d022f03d',
  COMECOU: '7d4958e842da4a758f6c1cdc7b36dcc5',
  PAROU: '9d1aaa27d60140bd96365438aad20286',
  CAIU: 'd9b373ed55a64feb8242e02dbe79a49c',
};

const CACHE_MS = 45000;
const DIAS = 7;
// Quantos quadradinhos cada operação manda para a tela. A tela mostra quantos
// couberem (os mais recentes à direita); mandar mais que isto seria peso morto.
const MAX_QUADRADOS = 48;
// Serviço contínuo: um quadradinho por hora, nas últimas 48 horas.
const HORAS_DE_SERVICO = 48;

/**
 * O AGRUPAMENTO POR PROPÓSITO, em linguagem de quem não é técnico.
 *
 * A chave é o sufixo da unidade (dgclaw-<slug>-<sufixo>) ou o nome que o
 * pulso-status dá aos serviços ("canal (runtime)", "painel"). Operação que não
 * está aqui cai em "Outras rotinas do sistema", e isso é melhor do que encaixar à
 * força num grupo que diz outra coisa.
 */
const GRUPOS = [
  {
    id: 'de-pe',
    titulo: 'Mantém ele de pé',
    explica: 'As peças que fazem ele estar ligado e respondendo: o processo onde ele pensa, '
      + 'o vigia que o religa quando trava, o batimento que confere se ele responde e o '
      + 'recibo dos recados automáticos.',
    membros: ['canal (runtime)', 'watchdog', 'channel-watchdog', 'heartbeat', 'poke-verify', 'painel'],
  },
  {
    id: 'memoria',
    titulo: 'Memória',
    explica: 'O que faz ele lembrar de vocês: a reflexão da noite, o conferente dela, a '
      + 'remontagem da memória de trabalho de manhã, o fichário das conversas e a arrumação '
      + 'da conversa quando ela fica comprida demais.',
    membros: ['reflection', 'audit', 'build-wm', 'auto-compact', 'consolidate', 'conversas-fts'],
  },
  {
    id: 'vigilancia',
    titulo: 'Vigilância e custos',
    explica: 'O que fica de olho no resto: quanto ele gasta, se as rotinas continuam '
      + 'instaladas, e o resumo do dia que chega para você no seu canal.',
    membros: ['cost-alerts', 'channels-tokens-logger', 'cron-audit', 'security-audit',
      'openrouter-credit-alert', 'pulso-report-1', 'pulso-report-2', 'pulso-report-3'],
  },
];
const GRUPO_PODERES = {
  id: 'poderes',
  titulo: 'Poderes instalados',
  explica: 'As rotinas que vêm junto com cada poder que você ligou (por exemplo, publicar no Instagram).',
};
const GRUPO_OUTRAS = {
  id: 'outras',
  titulo: 'Outras rotinas do sistema',
  explica: 'Rotinas do sistema que esta tela ainda não sabe agrupar. Elas são medidas igual às outras.',
};

// ─── utilidades de tempo ────────────────────────────────────────────────────

module.exports = { ID, CACHE_MS, DIAS, MAX_QUADRADOS, HORAS_DE_SERVICO, GRUPOS, GRUPO_PODERES, GRUPO_OUTRAS };
