// provedores.js: as rotas do bloco "Modelo e autenticação" da tela Status.
//
// O painel NÃO decide qual modelo o agente roda: quem decide e grava é o runner
// (docs/PROVEDORES.md, "Contrato entre painel e runner"). Este módulo faz três coisas:
//
//   1. repassa ao runner o que ele sabe (GET /api/provedor) e acrescenta o que só o
//      painel sabe: o catálogo de provedores e se a chave de cada serviço está no Cofre;
//   2. valida a escolha pelo catálogo (scripts/provedores/catalogo.mjs, a fonte única)
//      ANTES de incomodar o runner;
//   3. cuida da chave de API: ela vai para o Cofre (cofre.guardar) e NUNCA segue para o
//      runner, nem para o log, nem volta na resposta. O runner recebe só a escolha, com
//      `reiniciar:false`, e quem reinicia o agente é o cofre.aplicar(), já com a chave
//      no ambiente.
//
//   GET    /api/provedor                 a escolha atual + conferido + catálogo + chaves
//   POST   /api/provedor                 {provedor, auth, modelo, chave?}
//   POST   /api/provedor/login           começa o login assistido da assinatura
//   GET    /api/provedor/login           estado do login
//   POST   /api/provedor/login/codigo    {codigo}: cola o código no terminal do login
//   DELETE /api/provedor/login           cancela
//
// Doc para quem opera por API: panel/docs/PROVEDOR-NA-TELA.md.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { cabecalhoDoRunner } = require('./runner-token');

const TIMEOUT_MS = 8000;

// A forma mínima de cada chave. É só para pegar o engano mais comum (colar a chave de
// outro serviço); quem diz se a chave vale de verdade é o próprio serviço.
const FORMA_DA_CHAVE = {
  ANTHROPIC_API_KEY: { prefixo: 'sk-ant-', como: 'As chaves da Anthropic começam com "sk-ant-".' },
  OPENAI_API_KEY: { prefixo: 'sk-', como: 'As chaves da OpenAI começam com "sk-".' },
};

const SEM_RUNNER = {
  error: 'O agente ainda não sabe informar o modelo',
  howToFix: 'A plataforma que roda o agente é de uma versão antiga, sem a escolha de modelo. Peça a quem cuida da instalação para atualizá-la; enquanto isso o agente segue funcionando como estava.',
};

/** Tira de um texto qualquer o que parece chave (e a chave exata, se for dada). */
function limpar(texto, chave) {
  let t = String(texto == null ? '' : texto);
  if (chave) t = t.split(chave).join('[chave]');
  return t.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[chave]');
}

function achar(candidatos) {
  return candidatos.find((c) => c && fs.existsSync(c)) || null;
}

module.exports = function registrarRotasDeProvedor(router, { CONFIG, cofre, serverDir, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  // ── o catálogo: o mesmo arquivo e o mesmo validador que os scripts usam ──────
  const raizes = [
    CONFIG.pluginDir,
    CONFIG.agentDir && path.join(CONFIG.agentDir, '.dgclaw', 'plugin'),
    serverDir && path.join(serverDir, '..'),
  ];
  const arquivoMjs = achar(raizes.map((r) => r && path.join(r, 'scripts', 'provedores', 'catalogo.mjs')));
  const arquivoJson = process.env.DGCLAW_CATALOGO
    || achar(raizes.map((r) => r && path.join(r, 'providers', 'catalogo.json')));

  let carregado = null;
  async function catalogo() {
    if (carregado) return carregado;
    if (!arquivoMjs || !arquivoJson) {
      throw new Error('o catálogo de provedores não está nesta instalação (providers/catalogo.json)');
    }
    // import() dinâmico: o catálogo é ESM e o painel é CommonJS.
    const mod = await import(pathToFileURL(arquivoMjs).href);
    carregado = { mod, cat: mod.carregar(arquivoJson) };
    return carregado;
  }

  // ── o runner ──────────────────────────────────────────────────────────────
  function alvo() {
    const base = (CONFIG.bunkerUrl || process.env.DGCLAW_BUNKER_URL || 'http://127.0.0.1:4001').replace(/\/+$/, '');
    const sessao = CONFIG.bunkerCard || process.env.DGCLAW_BUNKER_CARD || null;
    return { base, sessao };
  }

  /** {status, corpo}; ou {fora:true, motivo} se o runner não respondeu ou não conhece a rota. */
  async function runner(metodo, caminho, corpo) {
    const { base, sessao } = alvo();
    const url = new URL(base + caminho);
    if (sessao && metodo !== 'POST') url.searchParams.set('sessao', sessao);
    const init = { method: metodo, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { ...cabecalhoDoRunner(CONFIG) } };
    if (corpo !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(sessao ? { sessao, ...corpo } : corpo);
    }
    let r;
    try {
      r = await doFetch(url, init);
    } catch (e) {
      return { fora: true, motivo: limpar(e.message) };
    }
    let json = {};
    try { json = await r.json(); } catch { /* resposta sem json */ }
    if (r.status === 404 && !(json && (json.error || json.erro))) return { fora: true, motivo: 'rota não existe (404)' };
    return { status: r.status, corpo: json || {} };
  }

  function semRunner(res, quando, motivo) {
    console.error(`[provedor] ${quando}: o runner não respondeu ou é antigo (${limpar(motivo)}); respondi 503`);
    return res.status(503).json(SEM_RUNNER);
  }

  function falhaGeral(res, quando, entrada, err, chave) {
    console.error(`[provedor] ${quando} quebrou (entrada: ${limpar(JSON.stringify(entrada), chave)}):`, limpar(err && err.stack || err, chave));
    res.status(500).json({
      error: `Não consegui ${quando}: ${limpar(err && err.message, chave)}`,
      howToFix: 'Tente de novo em um minuto. Se continuar, avise quem cuida do sistema: o registro do painel tem o detalhe.',
    });
  }

  /** Repassa a recusa do runner no padrão da casa, sem nunca copiar o corpo cru. */
  function repassarRecusa(res, quando, r, chave) {
    const c = r.corpo || {};
    const error = limpar(c.error || c.erro || `o agente recusou (${r.status})`, chave);
    console.error(`[provedor] ${quando}: runner recusou ${r.status}: ${error}`);
    const out = { error };
    if (c.howToFix) out.howToFix = limpar(c.howToFix, chave);
    res.status(r.status >= 400 ? r.status : 502).json(out);
  }

  // ── o cofre: só metadado, nunca valor ────────────────────────────────────
  function cofreTem(nome) {
    try {
      return cofre.estado().chaves.some((c) => c.envName === nome && !c.revogadaEm);
    } catch (e) {
      console.error(`[provedor] não consegui consultar o cofre para ${nome}: ${limpar(e.message)}`);
      return false;
    }
  }

  function variaveisDo(cat) {
    const vars = new Set();
    for (const p of Object.values(cat.provedores)) {
      for (const a of Object.values(p.auth || {})) if (a.variavel) vars.add(a.variavel);
    }
    return [...vars];
  }

  /** O catálogo que a tela precisa: nomes, explicações, modelos. Sem comando de instalar nem de login. */
  function resumo({ mod, cat }, modelosDoRunner) {
    const out = {};
    for (const [id, p] of Object.entries(cat.provedores)) {
      const modos = {};
      for (const [modo, a] of Object.entries(p.auth || {})) {
        modos[modo] = { nome: a.nome, explica: a.explica };
        if (a.variavel) modos[modo].variavel = a.variavel;
        if (a.ondeCriar) modos[modo].ondeCriar = a.ondeCriar;
      }
      let modelos;
      if (p.modelosDe && Array.isArray(modelosDoRunner && modelosDoRunner[id]) && modelosDoRunner[id].length) {
        modelos = modelosDoRunner[id].map((m) => ({ id: m.id, nome: m.nome || m.id }));
      } else {
        modelos = mod.modelos(cat, id).map((m) => ({ id: m.id, nome: m.nome }));
      }
      out[id] = {
        nome: p.nome, disponivel: !!p.disponivel, motivo: p.motivo || null,
        auth: modos, modeloPadrao: p.modeloPadrao || '', modelos,
      };
    }
    return out;
  }

  // ── GET /api/provedor ────────────────────────────────────────────────────
  router.get('/api/provedor', async (req, res) => {
    try {
      const r = await runner('GET', '/api/provedor');
      if (r.fora) return semRunner(res, 'GET /api/provedor', r.motivo);
      if (r.status >= 400) return repassarRecusa(res, 'GET /api/provedor', r);

      const c = await catalogo();
      const chaves = {};
      for (const v of variaveisDo(c.cat)) chaves[v] = cofreTem(v);
      const corpo = r.corpo || {};
      // O runner nunca devolve segredo (contrato), mas o painel não confia: o que sai daqui
      // é a escolha, o conferido e o login, e mais nada.
      const modelosDoRunner = Array.isArray(corpo.modelos) ? { codex: corpo.modelos } : (corpo.modelos || {});
      res.json({
        sessao: corpo.sessao ?? null,
        provedor: corpo.provedor ?? null,
        auth: corpo.auth ?? null,
        modelo: corpo.modelo ?? '',
        rotulo: corpo.rotulo ?? null,
        conferido: corpo.conferido ?? null,
        login: corpo.login ?? { estado: 'nenhum' },
        chaves,
        catalogo: resumo(c, modelosDoRunner),
      });
    } catch (err) {
      falhaGeral(res, 'ler o modelo do agente', {}, err);
    }
  });

  // ── POST /api/provedor ───────────────────────────────────────────────────
  router.post('/api/provedor', async (req, res) => {
    const b = req.body || {};
    // `chave` fica fora de qualquer objeto de log ou de erro daqui para baixo.
    const chave = typeof b.chave === 'string' ? b.chave.trim() : '';
    const entrada = { provedor: b.provedor, auth: b.auth, modelo: b.modelo, temChave: !!chave };
    try {
      if (!b.provedor || !b.auth) {
        return res.status(400).json({
          error: 'Faltou escolher o provedor e a forma de pagar.',
          howToFix: 'Mande provedor (claude ou codex) e auth (assinatura, token ou api).',
        });
      }
      const c = await catalogo();
      let escolha;
      try {
        escolha = c.mod.validar(c.cat, String(b.provedor), String(b.auth), String(b.modelo || ''));
      } catch (e) {
        if (!(e instanceof c.mod.ErroCatalogo)) throw e;
        return res.status(400).json({
          error: limpar(e.message, chave),
          howToFix: 'Escolha o provedor, o modelo e a forma de pagar nas listas da tela de troca.',
        });
      }

      const modo = c.cat.provedores[escolha.provedor].auth[escolha.auth];
      const variavel = modo.variavel || null;
      const corpoRunner = { provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo };

      // Modo "host" (v1): quem guarda a chave e reinicia é o DG Claw Web. Recusa ANTES de
      // falar com o runner, para a escolha não ficar gravada sem a chave e sem o reinício.
      if (variavel && cofre.modoHost) {
        const h = cofre.recusaDoHost();
        console.error(`[provedor] POST /api/provedor: este agente guarda chave pelo DG Claw Web; recusei com 409 (entrada: ${limpar(JSON.stringify(entrada), chave)})`);
        return res.status(h.status).json({ error: h.erro, howToFix: h.howToFix });
      }

      // Modo sem chave (assinatura): o runner grava e reinicia sozinho.
      if (!variavel) {
        const r = await runner('POST', '/api/provedor', { ...corpoRunner, reiniciar: true });
        if (r.fora) return semRunner(res, 'POST /api/provedor', r.motivo);
        if (r.status >= 400) return repassarRecusa(res, 'POST /api/provedor', r);
        return res.json({ ok: true, reiniciando: true, rotulo: r.corpo.rotulo || null });
      }

      if (chave) {
        const forma = FORMA_DA_CHAVE[variavel];
        if (forma && !chave.startsWith(forma.prefixo)) {
          return res.status(400).json({
            error: `Essa chave não parece ser a certa para ${c.cat.provedores[escolha.provedor].nome} ${modo.nome}. ${forma.como}`,
            howToFix: modo.ondeCriar
              ? `Crie uma chave nova em ${modo.ondeCriar} e cole de novo. Nada foi alterado.`
              : 'Confira a chave e cole de novo. Nada foi alterado.',
          });
        }
        const g = cofre.guardar({
          envName: variavel, valor: chave, provedor: escolha.provedor === 'codex' ? 'openai' : (escolha.auth === 'token' ? 'claude-assinatura' : 'anthropic'),
          quem: CONFIG.creatorName || 'Dono',
        });
        if (g && g.erro) {
          console.error(`[provedor] cofre recusou ${variavel}: ${limpar(g.erro, chave)}`);
          const out = { error: limpar(g.erro, chave) };
          if (g.howToFix) out.howToFix = limpar(g.howToFix, chave);
          return res.status(g.status || 400).json(out);
        }
      } else if (!cofreTem(variavel)) {
        const out = {
          error: `Para pagar ${modo.nome} falta a chave ${variavel}, e ela não está no Cofre.`,
          howToFix: modo.ondeCriar
            ? `Crie uma chave em ${modo.ondeCriar} e cole no campo da janela de troca. Ela fica guardada no Cofre e não aparece mais.`
            : `Gere o código (${modo.logar || 'veja a documentação do provedor'}) e cole no campo da janela de troca.`,
          precisaChave: variavel,
        };
        if (modo.ondeCriar) out.ondeCriar = modo.ondeCriar;
        return res.status(409).json(out);
      }

      // A chave já está no Cofre: o runner só grava a escolha, e o cofre reinicia o agente.
      const r = await runner('POST', '/api/provedor', { ...corpoRunner, reiniciar: false });
      if (r.fora) return semRunner(res, 'POST /api/provedor', r.motivo);
      if (r.status >= 400) {
        const out = { error: limpar((r.corpo && (r.corpo.error || r.corpo.erro)) || `o agente recusou (${r.status})`, chave) };
        out.howToFix = limpar((r.corpo && r.corpo.howToFix) || '', chave)
          + (chave ? ' A chave já ficou guardada no Cofre; basta tentar a troca de novo.' : '');
        console.error(`[provedor] POST /api/provedor: runner recusou ${r.status}: ${out.error}`);
        return res.status(r.status).json(out);
      }

      const a = cofre.aplicar();
      if (a && a.erro) {
        console.error(`[provedor] cofre.aplicar() não reiniciou: ${limpar(a.erro, chave)}`);
        const out = { error: limpar(a.erro, chave), gravado: true };
        if (a.howToFix) out.howToFix = limpar(a.howToFix, chave);
        return res.status(a.status || 500).json(out);
      }
      res.json({ ok: true, reiniciando: true, rotulo: r.corpo.rotulo || null, feito: a && a.feito ? a.feito : null });
    } catch (err) {
      falhaGeral(res, 'trocar o modelo do agente', entrada, err, chave);
    }
  });

  // ── o login assistido: repasse fino ──────────────────────────────────────
  function repasse(metodo, caminho, comCorpo) {
    return async (req, res) => {
      const quando = `${metodo} ${caminho}`;
      try {
        const corpoIn = comCorpo ? { codigo: String((req.body && req.body.codigo) || '') } : (metodo === 'POST' ? {} : undefined);
        if (comCorpo && !corpoIn.codigo.trim()) {
          return res.status(400).json({
            error: 'Faltou o código que apareceu depois do login.',
            howToFix: 'Cole o código inteiro no campo e envie de novo.',
          });
        }
        const r = await runner(metodo, caminho, corpoIn);
        if (r.fora) return semRunner(res, quando, r.motivo);
        if (r.status >= 400) return repassarRecusa(res, quando, r);
        res.json(r.corpo);
      } catch (err) {
        falhaGeral(res, 'falar com o login do agente', { rota: quando }, err);
      }
    };
  }
  router.post('/api/provedor/login', repasse('POST', '/api/provedor/login', false));
  router.get('/api/provedor/login', repasse('GET', '/api/provedor/login', false));
  router.post('/api/provedor/login/codigo', repasse('POST', '/api/provedor/login/codigo', true));
  router.delete('/api/provedor/login', repasse('DELETE', '/api/provedor/login', false));
};

module.exports.FORMA_DA_CHAVE = FORMA_DA_CHAVE;
module.exports.limpar = limpar;
