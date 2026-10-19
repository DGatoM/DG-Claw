// Lint mínimo de JavaScript do DG Claw: só as regras que pegam bug de verdade.
//
// Cobre web/, panel/, canais/, scripts/, bin/ e qa/. O runner (TypeScript) fica de fora:
// o `tsc --noEmit` do CI já confere os tipos e os nomes dele.
//
// Rodar na raiz:  npm ci && npx eslint .
const globals = require('globals');

const regras = {
  // Variável ou import que ninguém usa costuma ser sobra de refatoração. Aviso, não erro.
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  // Nome que não existe vira ReferenceError só na hora em que a linha roda.
  'no-undef': 'error',
  // catch vazio é erro engolido em silêncio. Quem ignora de propósito escreve o porquê
  // num comentário dentro do bloco, e o ESLint aceita.
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-unsafe-finally': 'error',
  'no-cond-assign': 'error',
  'no-redeclare': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-const-assign': 'error',
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Artefatos que os testes criam dentro das pastas do repositório.
      'panel/.dgclaw/**',
      // TypeScript: conferido pelo tsc.
      'runner/**',
      'hooks/**',
    ],
  },
  // Padrão: Node, CommonJS (web/lib, web/server.js, panel/lib, panel/rotas, panel/server.js...).
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: regras,
  },
  // Módulos ES: tudo que é .mjs (ponte do WhatsApp, testes do painel, scripts).
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: regras,
  },
  // canais/ é um pacote ES (package.json com "type": "module"), inclusive os .js.
  {
    files: ['canais/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: regras,
  },
  // Navegador: os scripts que o painel e o DG Claw Web servem às telas.
  {
    files: ['web/public/**/*.js', 'panel/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      // `DGMidias` vem de outro <script> da página (conversa.html do Web).
      globals: { ...globals.browser, DGMidias: 'readonly' },
    },
    rules: regras,
  },
  // Os scripts do painel que vêm depois do api.js: `API` e `BASE` são declaradas nele.
  {
    files: ['panel/public/js/**/*.js'],
    ignores: ['panel/public/js/api.js'],
    languageOptions: { globals: { API: 'readonly', BASE: 'readonly' } },
  },
  // Roteiros de QA: o Node dirige o navegador e manda funções para rodar DENTRO da página
  // (page.evaluate), por isso eles enxergam os dois conjuntos de globais.
  {
    files: ['qa/**/*.mjs', 'panel/qa-conversa.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: regras,
  },
];
