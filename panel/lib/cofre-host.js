// cofre-host.js: o cofre no modo "host" (DG Claw v1), em que este painel so le os nomes.
const fs = require('fs');
const { NOME_FORMA_OK, PROVEDORES, recusa } = require('./cofre-regras');

// ─── O modo "host" (DG Claw v1) ──────────────────────────────────────────────
//
// Na v1 o agente roda num contêiner e quem guarda a chave é o DG Claw Web, no host,
// num arquivo que o agente não alcança (`web/lib/cofre-agente.js`). Este painel, de
// dentro, só consegue LER os nomes das chaves (o Web os escreve em
// `/run/dgclaw/config/cofre-nomes`, pasta montada só para leitura).
//
// POR QUE RECUSAR EM VEZ DE CAIR NO MOTOR LOCAL: o motor local guarda a chave
// mestra na casa do agente, e o agente a lê. Chave cifrada com uma chave que está
// ao lado dela não está guardada, está escondida. Uma versão anterior fez isso sem
// querer (o cofre do host dava EACCES e o painel guardou `OPENAI_API_KEY.enc` mais
// `cofre.chave` na casa). Neste modo NADA é escrito em disco: nem pasta, nem chave
// mestra, nem arquivo de segredo.
function buildCofreHost(config, arquivoDeNomes) {
  const slug = String(config.agentSlug || 'agente');

  function recusaDoHost() {
    return recusa(
      'Neste agente quem guarda a chave e reinicia o agente é o DG Claw Web, e não este painel. Nada foi guardado.',
      409,
      'Abra o painel pelo endereço do DG Claw (o do site, com o login), e não pela porta direta do painel. ' +
      'Quem administra o servidor também pode usar "dgclaw agente cofre <agente> guardar NOME" nele.',
    );
  }

  /** Os nomes das chaves ativas, na ordem do arquivo. Arquivo ausente = nenhuma chave. */
  function nomes() {
    let texto;
    try {
      texto = fs.readFileSync(arquivoDeNomes, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      console.error(`[cofre:${slug}] não consegui ler a lista de nomes ${arquivoDeNomes} (${err.code || err.message}); mostro o cofre como vazio.`);
      return [];
    }
    const vistos = [];
    for (const linha of texto.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,63})=/.exec(linha);
      if (m && !vistos.includes(m[1])) vistos.push(m[1]);
    }
    return vistos;
  }

  function estado() {
    return {
      agente: { slug, nome: config.agentName || slug, dono: config.creatorName || 'Dono' },
      chaves: nomes().map((n) => ({
        envName: n,
        provedor: 'outro',
        provedorNome: (PROVEDORES.find((p) => p.sugestao === n) || {}).nome || 'Outro serviço',
        ultimos4: '',
        cadastradaPor: 'DG Claw Web',
        origem: 'host',
        cadastradaEm: null,
        revogadaEm: null,
        motor: 'host',
      })),
      provedores: PROVEDORES,
      guarda: {
        motor: 'host',
        motorExplicacao: 'A chave fica num arquivo do servidor, fora da pasta do agente, que só o administrador da máquina lê. O agente recebe o valor quando é reiniciado.',
        emMemoria: false,
        emMemoriaExplicacao: 'Aqui este painel só mostra os nomes das chaves. Guardar e reiniciar são feitos pelo DG Claw Web.',
      },
      aplicar: {
        pode: false,
        motivo: 'Neste agente quem guarda a chave e reinicia o agente é o DG Claw Web.',
        howToFix: 'Abra o painel pelo endereço do DG Claw (o do site, com o login) para guardar a chave e aplicar.',
      },
      arquivoDeAmbiente: '/run/dgclaw/cofre/cofre.env',
    };
  }

  function tem(envName) {
    const nome = String(envName || '').trim().toUpperCase();
    return NOME_FORMA_OK.test(nome) && nomes().includes(nome);
  }

  return {
    modoHost: true,
    recusaDoHost,
    estado, tem,
    guardar: recusaDoHost, revogar: recusaDoHost, aplicar: recusaDoHost, materializar: recusaDoHost,
    DIR: null, ENV_DO_AGENTE: null, PROVEDORES, EXTRAS: new Set(),
  };
}

module.exports = { buildCofreHost };
