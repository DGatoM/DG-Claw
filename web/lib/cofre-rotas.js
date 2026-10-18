'use strict';
// As rotas do cofre que o DG Claw Web responde SOZINHO, sem repassar ao painel do agente.
//
// Por que aqui: na v1 o painel roda dentro do container, e o container não pode guardar a chave
// (o agente leria). Quem grava é o Web, no host (./cofre-agente). O navegador continua falando com
// /p/<slug>/api/..., e o proxy chama `tratar` antes de repassar. Só vale para agente com
// `cofre_arquivo` no registro; os demais seguem passando direto.
//
//   GET    /p/<slug>/api/cofre            estado (sem valor)
//   POST   /p/<slug>/api/cofre            guardar {envName, valor, provedor, aplicar}   (PUT igual)
//   DELETE /p/<slug>/api/cofre?envName=X  revogar
//   POST   /p/<slug>/api/cofre/aplicar    reiniciar o agente
//   POST   /p/<slug>/api/provedor         só o ramo com chave (ver `provedor` abaixo)
//   POST   /p/<slug>/api/chat/transcrever transcrever o áudio do microfone (ver `transcreverRota`)
//
// O formato das respostas e dos erros ({error, howToFix}) é o do painel, porque é a tela do painel
// que as lê. Segredo nunca entra em log, em mensagem de erro nem em resposta.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { enviaJson, lerCorpo } = require('./http');
const { FORMA_DA_CHAVE, limpar } = require('../../panel/lib/provedores');

const LIMITE_CORPO = 64 * 1024;
const RAIZ_REPO = path.join(__dirname, '..', '..');

const SEM_RUNNER = {
  error: 'O agente ainda não sabe informar o modelo',
  howToFix: 'A plataforma que roda o agente é de uma versão antiga, sem a escolha de modelo, ou o agente está fora do ar. Peça a quem cuida da instalação para conferir; enquanto isso o agente segue funcionando como estava.',
};

const LIMITE_AUDIO = 25 * 1024 * 1024;

function criarCofreRotas({ config, runner, cofre, voz, log, protecoes }) {
  // Versão empresa: o modo "token" (CLAUDE_CODE_OAUTH_TOKEN) não é oferecido nem gravado. Texto igual ao de lib/enterprise/credencial.sh.
  const MOTIVO_TOKEN = 'na versão empresa, cada pessoa entra com o próprio assento do Team ou do Enterprise, ou o agente usa a chave de API da empresa';
  const semToken = () => !!protecoes && protecoes.ligada('credencial_empresa');
  let catalogoCache = null;
  async function catalogo() {
    if (catalogoCache) return catalogoCache;
    const mjs = path.join(RAIZ_REPO, 'scripts', 'provedores', 'catalogo.mjs');
    const json = (config.env && config.env.DGCLAW_CATALOGO) || path.join(RAIZ_REPO, 'providers', 'catalogo.json');
    // import() dinâmico: o catálogo é ESM e o Web é CommonJS.
    const mod = await import(pathToFileURL(mjs).href);
    catalogoCache = { mod, cat: mod.carregar(json) };
    return catalogoCache;
  }

  /** Qual rota do cofre é este pedido? Devolve 'cofre', 'aplicar', 'provedor', 'transcrever' ou null. */
  function casa(req, slug) {
    const bruto = String(req.url || '').split('?')[0];
    const prefixo = `/p/${slug}`;
    if (!bruto.startsWith(prefixo)) return null;
    // O Express do painel não distingue maiúscula nem barra final; casar do mesmo jeito evita
    // que "/API/cofre/" escape da interceptação.
    const resto = bruto.slice(prefixo.length).toLowerCase().replace(/\/+$/, '');
    const m = req.method;
    if (resto === '/api/cofre' && (m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE')) return 'cofre';
    if (resto === '/api/cofre/aplicar' && m === 'POST') return 'aplicar';
    if (resto === '/api/provedor' && m === 'POST') return 'provedor';
    if (resto === '/api/chat/transcrever' && m === 'POST') return 'transcrever';
    return null;
  }

  function recusar(res, r) {
    const corpo = { error: r.erro };
    if (r.howToFix) corpo.howToFix = r.howToFix;
    enviaJson(res, r.status || 500, corpo);
  }

  function falhaGeral(res, slug, oQue, e) {
    // A mensagem da exceção não leva o corpo do pedido junto: o valor da chave está lá.
    log('erro', `Cofre /p/${slug}: ${oQue} quebrou (${e && e.stack ? limpar(e.stack) : limpar(e && e.message)}).`);
    enviaJson(res, 500, { error: `Não consegui ${oQue}: ${limpar(e && e.message)}`, howToFix: 'Tente de novo. Se continuar, o registro do DG Claw Web tem o detalhe.' });
  }

  /** Lê o corpo (até 64 KB). Devolve { buf, json } ou null depois de ter respondido o erro. */
  async function lerJsonDoPedido(req, res, slug) {
    let buf;
    try { buf = await lerCorpo(req, LIMITE_CORPO); } catch (e) {
      if (e.status === 413) {
        enviaJson(res, 413, { error: `O pedido passou de ${LIMITE_CORPO / 1024} KB, que é muito mais do que uma chave precisa.`, howToFix: 'Mande só o nome e o valor da chave.' });
      } else {
        log('erro', `Cofre /p/${slug}: não consegui ler o corpo do pedido (${e.code || e.message}).`);
        enviaJson(res, 400, { error: 'Não consegui ler o corpo do pedido.', howToFix: 'Tente de novo.' });
      }
      return null;
    }
    if (!buf.length) return { buf, json: {} };
    try {
      const j = JSON.parse(buf.toString('utf8'));
      return { buf, json: j && typeof j === 'object' && !Array.isArray(j) ? j : {} };
    } catch (_) {
      enviaJson(res, 400, { error: 'O corpo do pedido não é um JSON válido.', howToFix: 'Mande o objeto com Content-Type: application/json.' });
      return null;
    }
  }

  async function guardarRota(req, res, agente, usuario) {
    const p = await lerJsonDoPedido(req, res, agente.slug); if (!p) return;
    const b = p.json;
    if (b.envName === 'CLAUDE_CODE_OAUTH_TOKEN' && semToken()) {
      log('aviso', `Cofre /p/${agente.slug}: recusei guardar CLAUDE_CODE_OAUTH_TOKEN (credencial_empresa ligada).`);
      enviaJson(res, 403, { error: `Este código de acesso de longa duração não pode ser guardado: ${MOTIVO_TOKEN}.`, howToFix: 'Entre pela assinatura (login assistido do painel) ou use a chave de API da empresa (ANTHROPIC_API_KEY) em um agente de setor.' });
      return;
    }
    const g = cofre.guardar(agente, { envName: b.envName, valor: b.valor, provedor: b.provedor, quem: usuario, origem: 'tela' });
    if (g.erro || b.aplicar !== true) return recusarOuJson(res, g);
    const a = await cofre.aplicar(agente);
    if (a.erro) {
      // A chave CONTINUA guardada; a resposta diz as duas coisas, com status de erro.
      return enviaJson(res, a.status || 500, {
        error: `A chave foi guardada. ${a.erro}`,
        howToFix: a.howToFix || 'Guardar já foi feito; falta só reiniciar o agente (aba Cofre, "aplicar e reiniciar").',
        guardado: g,
        aplicado: { ok: false, erro: a.erro },
      });
    }
    enviaJson(res, 200, Object.assign({}, g, { aplicado: a }));
  }

  function recusarOuJson(res, r) { if (r && r.erro) return recusar(res, r); return enviaJson(res, 200, r); }

  async function cofreRota(req, res, agente, usuario) {
    if (req.method === 'GET') return recusarOuJson(res, cofre.estado(agente));
    if (req.method === 'DELETE') {
      const envName = new URL(req.url, 'http://local').searchParams.get('envName') || '';
      return recusarOuJson(res, cofre.revogar(agente, envName, usuario));
    }
    return guardarRota(req, res, agente, usuario);
  }

  async function aplicarRota(req, res, agente) {
    // O corpo, se vier, é ignorado, mas precisa ser consumido para a conexão seguir.
    req.resume();
    const r = await cofre.aplicar(agente);
    if (r.erro) {
      const corpo = { error: r.erro };
      if (r.howToFix) corpo.howToFix = r.howToFix;
      return enviaJson(res, r.status || 500, corpo);
    }
    enviaJson(res, 200, r);
  }

  /**
   * POST /api/provedor. O Web assume o pedido quando o modo de pagar usa uma variável
   * (chave de API ou token): é ele que guarda a chave, grava a escolha no runner e reinicia.
   * Modo sem variável (assinatura) e pedido que o catálogo recusa sem chave seguem para o
   * painel, com a `chave` tirada do corpo se tiver vindo uma.
   * Devolve { corpo: Buffer } quando é para repassar ao painel.
   */
  async function provedorRota(req, res, agente, usuario) {
    const p = await lerJsonDoPedido(req, res, agente.slug); if (!p) return undefined;
    const b = p.json;
    const chave = typeof b.chave === 'string' ? b.chave.trim() : '';
    const repassarComoChegou = () => ({ corpo: p.buf });
    const repassarSemChave = () => {
      if (!('chave' in b)) return repassarComoChegou();
      const resto = Object.assign({}, b); delete resto.chave;
      return { corpo: Buffer.from(JSON.stringify(resto)) };
    };

    if (!b.provedor || !b.auth) {
      if (!chave) return repassarComoChegou();
      enviaJson(res, 400, { error: 'Faltou escolher o provedor e a forma de pagar.', howToFix: 'Mande provedor (claude ou codex) e auth (assinatura, token ou api).' });
      return undefined;
    }

    let c;
    try { c = await catalogo(); } catch (e) {
      if (!chave) return repassarComoChegou();
      log('erro', `Cofre /p/${agente.slug}: não carreguei o catálogo de provedores (${limpar(e.message)}).`);
      enviaJson(res, 500, { error: 'Não consegui ler o catálogo de provedores, então não guardei a chave.', howToFix: 'Quem cuida da instalação precisa conferir providers/catalogo.json no servidor. Nada foi alterado.' });
      return undefined;
    }
    let escolha;
    try {
      escolha = c.mod.validar(c.cat, String(b.provedor), String(b.auth), String(b.modelo || ''));
    } catch (e) {
      if (!(e instanceof c.mod.ErroCatalogo)) throw e;
      if (!chave) return repassarComoChegou();
      enviaJson(res, 400, { error: limpar(e.message, chave), howToFix: 'Escolha o provedor, o modelo e a forma de pagar nas listas da tela de troca.' });
      return undefined;
    }

    if (escolha.auth === 'token' && semToken()) {
      log('aviso', `Cofre /p/${agente.slug}: recusei o modo token (credencial_empresa ligada).`);
      enviaJson(res, 403, { error: `Este modo de pagar não está disponível: ${MOTIVO_TOKEN}.`, howToFix: 'Escolha "na assinatura" (cada pessoa entra com o próprio assento) ou "na API" (chave da organização, para agente de setor). Nada foi alterado.' });
      return undefined;
    }
    const modo = c.cat.provedores[escolha.provedor].auth[escolha.auth];
    const variavel = modo.variavel || null;
    if (!variavel) return repassarSemChave();

    if (chave) {
      const forma = FORMA_DA_CHAVE[variavel];
      if (forma && !chave.startsWith(forma.prefixo)) {
        enviaJson(res, 400, {
          error: `Essa chave não parece ser a certa para ${c.cat.provedores[escolha.provedor].nome} ${modo.nome}. ${forma.como}`,
          howToFix: modo.ondeCriar ? `Crie uma chave nova em ${modo.ondeCriar} e cole de novo. Nada foi alterado.` : 'Confira a chave e cole de novo. Nada foi alterado.',
        });
        return undefined;
      }
      const g = cofre.guardar(agente, {
        envName: variavel, valor: chave,
        provedor: escolha.provedor === 'codex' ? 'openai' : (escolha.auth === 'token' ? 'claude-assinatura' : 'anthropic'),
        quem: usuario, origem: 'tela',
      });
      if (g.erro) {
        log('aviso', `Cofre /p/${agente.slug}: recusei a chave de ${variavel}: ${limpar(g.erro, chave)}`);
        const out = { error: limpar(g.erro, chave) };
        if (g.howToFix) out.howToFix = limpar(g.howToFix, chave);
        enviaJson(res, g.status || 400, out);
        return undefined;
      }
    } else {
      const est = cofre.estado(agente);
      if (est.erro) { recusar(res, est); return undefined; }
      if (!est.chaves.some((k) => k.envName === variavel && !k.revogadaEm)) {
        const out = {
          error: `Para pagar ${modo.nome} falta a chave ${variavel}, e ela não está no Cofre.`,
          howToFix: modo.ondeCriar
            ? `Crie uma chave em ${modo.ondeCriar} e cole no campo da janela de troca. Ela fica guardada no Cofre e não aparece mais.`
            : `Gere o código (${modo.logar || 'veja a documentação do provedor'}) e cole no campo da janela de troca.`,
          precisaChave: variavel,
        };
        if (modo.ondeCriar) out.ondeCriar = modo.ondeCriar;
        enviaJson(res, 409, out);
        return undefined;
      }
    }

    // A chave já está no cofre: o runner só grava a escolha, e o reinício vem do cofre.
    const r = await runner.pedir(agente, 'POST', '/api/provedor', {
      sessao: agente.slug, provedor: escolha.provedor, auth: escolha.auth, modelo: escolha.modelo, reiniciar: false,
    }, 8000);
    if (!r.ok && r.erro) {
      log('erro', `Cofre /p/${agente.slug}: o runner não respondeu à troca de modelo: ${limpar(r.erro, chave)}`);
      enviaJson(res, 503, Object.assign({}, SEM_RUNNER, chave ? { howToFix: `${SEM_RUNNER.howToFix} A chave já ficou guardada no Cofre; basta tentar a troca de novo.` } : {}));
      return undefined;
    }
    if (!r.ok) {
      const cr = r.corpo || {};
      if (r.status === 404 && !(cr.error || cr.erro)) { enviaJson(res, 503, SEM_RUNNER); return undefined; }
      const out = { error: limpar(cr.error || cr.erro || `o agente recusou (${r.status})`, chave) };
      out.howToFix = limpar(cr.howToFix || '', chave) + (chave ? ' A chave já ficou guardada no Cofre; basta tentar a troca de novo.' : '');
      log('erro', `Cofre /p/${agente.slug}: o runner recusou a troca de modelo (${r.status}): ${out.error}`);
      enviaJson(res, r.status >= 400 ? r.status : 502, out);
      return undefined;
    }
    const rotulo = (r.corpo && r.corpo.rotulo) || null;

    const a = await cofre.aplicar(agente);
    if (a.erro) {
      log('erro', `Cofre /p/${agente.slug}: a escolha foi gravada mas o reinício falhou: ${limpar(a.erro, chave)}`);
      const out = { error: limpar(a.erro, chave), gravado: true };
      if (a.howToFix) out.howToFix = limpar(a.howToFix, chave);
      enviaJson(res, a.status || 500, out);
      return undefined;
    }
    enviaJson(res, 200, { ok: true, reiniciando: true, rotulo, feito: a.feito || null });
    return undefined;
  }

  /**
   * POST /api/chat/transcrever. Na v1 o painel roda no container, sem Bunker e sem chave de voz;
   * quem tem a chave é o Web (web.env), então ele transcreve aqui. O cliente manda o áudio cru,
   * com o Content-Type do MediaRecorder, e espera {texto} ou {error, howToFix}.
   * O áudio fica só na memória: nem disco nem log.
   */
  async function transcreverRota(req, res, agente) {
    if (!voz.microfone) {
      req.resume();
      return enviaJson(res, 503, {
        error: 'O microfone do painel está desligado: a transcrição usa a chave de voz da plataforma e ela ainda não foi configurada.',
        howToFix: 'Peça ao Admin: "ativa o microfone". Ele copia a GROQ_API_KEY (grátis), a OPENAI_API_KEY ou a ELEVENLABS_API_KEY do cofre para a configuração da plataforma.',
      });
    }
    let buf;
    try { buf = await lerCorpo(req, LIMITE_AUDIO); } catch (e) {
      if (e.status === 413) {
        return enviaJson(res, 413, { error: `O áudio passou de ${LIMITE_AUDIO / 1024 / 1024} MB.`, howToFix: 'Grave um trecho mais curto e envie de novo.' });
      }
      log('erro', `Transcrição /p/${agente.slug}: não consegui ler o áudio do pedido (${e.code || e.message}).`);
      return enviaJson(res, 400, { error: 'Não consegui ler o áudio do pedido.', howToFix: 'Grave de novo e envie.' });
    }
    if (buf.length < 1024) {
      return enviaJson(res, 400, { error: `O áudio chegou com ${buf.length} bytes, que é menos de 1 KB: a gravação veio vazia.`, howToFix: 'Toque para falar, diga algo e toque de novo.' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || 'audio/webm';
    const ext = (/^audio\/(?:x-)?([a-z0-9]+)/.exec(mime) || [])[1] || 'webm';
    const r = await voz.transcrever(buf, `audio.${ext === 'mpeg' ? 'mp3' : ext}`, mime);
    if (r.erro) {
      log('erro', `Transcrição /p/${agente.slug}: ${r.erro}`);
      return enviaJson(res, r.status || 502, { error: r.erro, howToFix: 'Tente gravar de novo. Se continuar, avise o Admin.' });
    }
    return enviaJson(res, 200, { texto: r.texto });
  }

  /**
   * Trata o pedido. Devolve undefined quando já respondeu, ou { corpo: Buffer } quando o proxy
   * deve repassar ao painel o corpo que foi lido aqui.
   */
  async function tratar(req, res, agente, usuario, qual) {
    try {
      if (qual === 'cofre') return await cofreRota(req, res, agente, usuario);
      if (qual === 'aplicar') return await aplicarRota(req, res, agente);
      if (qual === 'transcrever') return await transcreverRota(req, res, agente);
      return await provedorRota(req, res, agente, usuario);
    } catch (e) {
      if (!res.headersSent) falhaGeral(res, agente.slug, 'atender o pedido do cofre', e);
      else res.destroy();
      return undefined;
    }
  }

  return { casa, tratar };
}

module.exports = { criarCofreRotas };
