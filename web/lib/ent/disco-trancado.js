'use strict';
// Dados trancados (bloco J): com a chave do disco FORA da VPS (proteção `disco_cifrado` = externo), depois de reiniciar
// o volume cifrado só abre quando o Tang responde ou o TI digita a frase (`dgclaw disco desbloquear`). Enquanto isso a
// pasta dos agentes está vazia e os containers não sobem. Em vez de uma tela quebrada, este módulo responde, nas rotas que
// dependem dos dados dos agentes, "dados trancados, aguardando desbloqueio" (503), e diz ao TI o que fazer.
//
//   GET /api/v1/disco   { trancado, metodo }  (exige sessão; a tela usa para mostrar o aviso)
//
// "Trancado" = proteção em externo + o volume cifrado existe + a pasta dos agentes NÃO é um ponto de montagem (o device
// dela é o mesmo da pasta de cima). Sem a proteção (todos os outros níveis) este módulo não responde a nada.
// Caminhos (lidos de config.env, e os mesmos que o lado bash usa): DGCLAW_DISCO_ARQUIVO e DGCLAW_CASAS.

const fs = require('node:fs');
const path = require('node:path');
const H = require('../http');

// Páginas e APIs que leem a casa de algum agente. Login, proteções, auditoria, aprovações e usuários ficam de fora:
// o TI precisa delas para resolver.
const PAGINAS = [/^\/$/, /^\/a\//, /^\/p\//, /^\/mesa\/?$/, /^\/lembretes\/?$/, /^\/avisos\/?$/, /^\/novo-agente\/?$/];
const APIS = ['/api/v1/agents', '/api/v1/avisos', '/api/v1/foco', '/api/v1/lembretes', '/api/v1/onboarding', '/api/v1/tarefas',
  '/api/v1/novo-agente', '/api/v1/tts', '/api/v1/transcribe', '/api/v1/push'];

const TEXTO = 'Dados trancados, aguardando desbloqueio. O disco cifrado dos agentes ainda não foi aberto depois da última reinicialização.';

function pagina(res, metodo) {
  const como = metodo === 'tang'
    ? 'O servidor confere o Tang da empresa sozinho. Se a rede para ele estiver fora do ar, o disco não abre. Peça a quem cuida do servidor para rodar: dgclaw disco abrir'
    : 'Peça a quem cuida do servidor (o TI) para rodar no servidor: dgclaw disco desbloquear, e digitar a frase do disco.';
  H.paginaErro(res, 503, 'Dados trancados', `${TEXTO} ${como} Esta página volta ao normal sozinha quando o disco abrir.`, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
}

module.exports = {
  nome: 'disco-trancado',
  ordem: 5,
  criar(ctx) {
    const { protecoes, config, log } = ctx;
    const env = (config && config.env) || process.env;
    const raiz = env.DGCLAW_RAIZ || process.env.DGCLAW_RAIZ || '';
    const volume = env.DGCLAW_DISCO_ARQUIVO || path.join(raiz, 'var/lib/dgclaw-cofre/dados.luks');
    const casas = env.DGCLAW_CASAS || path.join(raiz, 'var/lib/dgclaw/agentes');
    const estadoMetodo = path.join(path.dirname(config.protecoesPath || path.join(raiz, 'etc/dgclaw/protecoes.json')), 'disco-externo.json');
    let avisouLeitura = false;

    function montado() {
      try {
        return fs.statSync(casas).dev !== fs.statSync(path.dirname(casas)).dev;
      } catch (e) {
        if (e.code !== 'ENOENT' && !avisouLeitura) {
          avisouLeitura = true;
          log('erro', `Não consegui saber se ${casas} é um disco montado (${e.code || e.message}). Trato como trancado. Confira com: dgclaw disco status`);
        }
        return false;
      }
    }

    function trancado() {
      if (protecoes.valor('disco_cifrado') !== 'externo') return false;
      if (!fs.existsSync(volume)) return false;
      return !montado();
    }

    function metodo() {
      try { return JSON.parse(fs.readFileSync(estadoMetodo, 'utf8')).metodo || null; } catch (_) { return null; }
    }

    return {
      trancado,
      antes(req, res, url, sessao) {
        const p = url.pathname;
        const leitura = req.method === 'GET' || req.method === 'HEAD';
        if (p === '/api/v1/disco') {
          if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para ver o estado do disco. Faça login em /login.'); return true; }
          if (!leitura) { H.erroJson(res, 405, 'Use GET.'); return true; }
          H.enviaJson(res, 200, { ok: true, trancado: trancado(), metodo: metodo() });
          return true;
        }
        if (!sessao) return false;
        const ehApi = p.startsWith('/api/');
        if (ehApi ? !APIS.some((a) => p === a || p.startsWith(a + '/')) : !(leitura && PAGINAS.some((rx) => rx.test(p)))) return false;
        if (!trancado()) return false;
        if (ehApi) H.enviaJson(res, 503, { ok: false, trancado: true, erro: `${TEXTO} Peça ao TI para rodar no servidor: dgclaw disco desbloquear (ou dgclaw disco abrir, se a chave vem de um Tang).` }, { 'Retry-After': '30' });
        else pagina(res, metodo());
        return true;
      },
    };
  },
};
