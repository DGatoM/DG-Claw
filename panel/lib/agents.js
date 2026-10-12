// agents.js: quais assistentes DG Claw existem nesta maquina.
//
// Serve o seletor de agente do painel. Cada agente tem o painel dele, numa porta propria,
// entao "trocar de agente" e abrir outro endereco, nao recarregar dados aqui dentro.
//
// So le arquivo, nunca executa nada, e nunca deixa vazar segredo: devolve slug, nome, se o
// servico existe, se tem vida emocional e a porta do painel. Falha em qualquer ponto vira
// lista vazia, e o seletor simplesmente nao aparece.

const fs = require('fs');
const path = require('path');

/**
 * Onde procurar agente nesta maquina.
 *
 * Os dois jeitos historicos de instalar o DG Claw servidor sao a pasta `dgclaw/<slug>/` do
 * usuario root e um usuario dedicado `dgclaw-<slug>` (veja RAIZES_DE_SEMPRE). Enquanto
 * foram os dois unicos, a lista podia ser fixa; deixou de poder em 10/08/2026, quando o
 * primeiro agente entregue pela plataforma nasceu em `/opt/agentes/ana` e ficou INVISIVEL para o seletor. O sintoma
 * e traicoeiro: nada quebra, nada loga, o agente simplesmente nao existe na lista.
 *
 * `DGCLAW_ROOTS` e uma lista separada por dois-pontos, no molde do PATH. Cada item pode
 * ser uma pasta cujos filhos sao workspaces (`/opt/agentes`), ou vir com um filtro de
 * prefixo depois de uma virgula (`/home,dgclaw-`), que e como se descreve o caso do
 * `/home` sem varrer a casa de todo mundo.
 *
 * Os dois caminhos historicos continuam valendo SEMPRE, somados ao que vier no env: uma
 * VPS de aluna que nunca ouviu falar desta variavel nao pode perder o proprio agente
 * porque alguem definiu a lista pensando em outro servidor.
 */
const RAIZES_DE_SEMPRE = [
  { base: '/root/dgclaw', prefixo: null },
  { base: '/home', prefixo: 'dgclaw-' },
];

function raizes() {
  const extras = (process.env.DGCLAW_ROOTS || '')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [base, prefixo] = item.split(',');
      return { base: (base || '').trim(), prefixo: (prefixo || '').trim() || null };
    })
    .filter((r) => r.base.startsWith('/'));

  // Sem duplicar: a mesma pasta listada duas vezes viraria o mesmo agente duas vezes na
  // tela, e o dono ficaria sem saber qual dos dois clicar.
  const vistas = new Set();
  return [...RAIZES_DE_SEMPRE, ...extras].filter((r) => {
    const chave = `${r.base}|${r.prefixo || ''}`;
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

function candidatos() {
  const achados = [];
  const jaVistos = new Set();
  for (const { base, prefixo } of raizes()) {
    let entradas = [];
    try { entradas = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isDirectory() || (prefixo && !e.name.startsWith(prefixo))) continue;
      const ws = path.join(base, e.name);
      if (jaVistos.has(ws)) continue;
      const cfg = path.join(ws, '.dgclaw', 'config.sh');
      if (fs.existsSync(cfg)) {
        jaVistos.add(ws);
        achados.push({ ws, cfg });
      }
    }
  }
  return achados;
}

// Le uma variavel do config sem dar source: o config e shell, e nao vamos executar shell
// por causa de um seletor de tela.
function lerVar(texto, nome) {
  const m = texto.match(new RegExp(`^export ${nome}="?([^"\n]*)"?`, 'm'));
  return m ? m[1].trim() : null;
}

// A porta do painel de cada agente esta no proprio unit dele.
function portaDoPainel(slug) {
  try {
    const unit = fs.readFileSync(`/etc/systemd/system/dgclaw-panel-${slug}.service`, 'utf-8');
    const m = unit.match(/DGCLAW_PANEL_PORT=(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* sem unit: o painel dele pode nem estar instalado */ }
  return null;
}

/**
 * Lista os agentes da maquina.
 *
 * @param {string} slugAtual slug do agente que este painel serve
 * @param {string} hostname  host pelo qual o navegador chegou ate aqui
 * @param {{soOAtual?: boolean}} [opcoes]
 *   `soOAtual` corta a lista no agente deste painel e nada mais. E o modo de quando o
 *   painel esta atras da fachada da plataforma: quem entrou ali entrou pelo cartao de UM
 *   agente, e a maquina por baixo e compartilhada com os agentes de outras pessoas (e com
 *   os do Danilo). Sem esse corte a rota conta para a dona de um agente que existem o
 *   Bento e outros, com nome e slug, e ainda oferece link para eles. Nao e uma
 *   falha de tela: e a rota devolvendo o que nao e da pessoa, entao o corte e aqui, antes
 *   de montar qualquer coisa sobre os outros.
 */
function listar(slugAtual, hostname, opcoes = {}) {
  const soOAtual = !!opcoes.soOAtual;
  const saida = [];
  for (const { ws, cfg } of candidatos()) {
    let texto;
    try { texto = fs.readFileSync(cfg, 'utf-8'); } catch { continue; }
    const slug = lerVar(texto, 'DGCLAW_SLUG');
    if (!slug) continue;
    if (soOAtual && slug !== slugAtual) continue;
    const porta = portaDoPainel(slug);
    const atual = slug === slugAtual;
    saida.push({
      slug,
      nome: lerVar(texto, 'DGCLAW_NAME') || slug,
      atual,
      emocoes: fs.existsSync(path.join(ws, '.dgclaw', 'ext', 'alive', 'ext.json')),
      servico: fs.existsSync(`/etc/systemd/system/dgclaw-${slug}.service`) ? 'instalado' : 'sem serviço',
      // Sem porta conhecida nao da pra oferecer link: o painel dele nao esta instalado.
      url: !atual && porta && hostname ? `http://${hostname}:${porta}/` : null,
    });
  }
  // O atual primeiro, o resto em ordem alfabetica.
  saida.sort((a, b) => (b.atual - a.atual) || a.nome.localeCompare(b.nome));
  return saida;
}

module.exports = { listar };
