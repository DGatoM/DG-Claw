'use strict';
// Rotas /api/v1/anonimizar (só o dono, pela tela). Ver web/docs/ANONIMIZAR.md.
// Não entram em caixa.permitir: agente em container não chama nenhuma delas, e a checagem de `sessao.via`
// abaixo é a segunda trava. Nenhuma resposta traz valor da tabela, exceto a de tabela e a de reverter.

const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');
const { mimeDe } = require('./media');
const { RX_SLUG, ErroAnon } = require('./anonimizar');

const BASE = '/api/v1/anonimizar';
const RX_MEDIA = /^[0-9a-f]{16}$/;
const ESCREVE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function criarRotasAnonimizar({ anon, registro, midia, log, origemOk, arquivoDocs }) {
  const docsPath = arquivoDocs || path.join(__dirname, '..', 'docs', 'ANONIMIZAR.md');

  /**
   * GET que devolve dado sensível: o navegador não manda Origin num GET do próprio site, então vale
   * o Sec-Fetch-Site. Com `estrita`, pedido sem nenhum dos dois cabeçalhos é recusado.
   */
  function leituraDoSite(req, estrita) {
    if (req.headers.origin) return origemOk(req);
    const sfs = req.headers['sec-fetch-site'];
    if (sfs) return sfs === 'same-origin' || sfs === 'none';
    return !estrita;
  }

  function agenteOuErro(res, slug) {
    if (!RX_SLUG.test(slug)) { H.erroJson(res, 400, `O id de agente "${slug.slice(0, 40)}" não vale. Veja GET /api/v1/agents.`); return null; }
    const a = registro.obter(slug);
    if (!a) { H.erroJson(res, 404, `Não existe agente com o id "${slug}". Veja GET /api/v1/agents.`); return null; }
    return a;
  }

  async function corpo(req, max) {
    try { return await H.lerJson(req, max || 1024 * 1024); } catch (e) { throw new ErroAnon(e.status || 400, e.message); }
  }

  async function rotas(req, res, url, sessao) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p !== BASE && !p.startsWith(`${BASE}/`)) return false;
    if (!sessao || sessao.via === 'caixa') {
      H.erroJson(res, 403, 'A anonimização é do dono, pelo painel. Agente não usa estas rotas: ele só recebe os documentos já com marcadores.');
      return true;
    }
    const m = req.method;
    if (ESCREVE.has(m) && !origemOk(req)) {
      H.erroJson(res, 403, 'Pedido recusado: a origem não é a deste site. Abra o DG Claw pelo endereço normal e tente de novo.');
      return true;
    }
    const sub = p.slice(BASE.length);
    const metodoErrado = (usar) => { H.erroJson(res, 405, `Use ${usar} em ${p}.`); return true; };
    try {
      if (sub === '/docs.md') {
        if (m !== 'GET') return metodoErrado('GET');
        const texto = fs.readFileSync(docsPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(texto);
        return true;
      }
      if (sub === '/estado') {
        if (m !== 'GET') return metodoErrado('GET');
        H.enviaJson(res, 200, Object.assign({ ok: true }, await anon.estado()));
        return true;
      }
      if (sub === '/detector/instalar') {
        if (m !== 'POST') return metodoErrado('POST');
        const c = await corpo(req, 4096);
        const r = await anon.instalarDetector(c.nivel, c.forcar === true);
        H.enviaJson(res, 202, { ok: true, nivel: r.nivel, mensagem: 'Instalação iniciada. Acompanhe o progresso em GET /api/v1/anonimizar/estado.' });
        return true;
      }
      if (sub === '/testar') {
        if (m !== 'POST') return metodoErrado('POST');
        const c = await corpo(req);
        let slug = null;
        if (c.slug != null) {
          if (typeof c.slug !== 'string') { H.erroJson(res, 400, 'O campo "slug" precisa ser o id de um agente (texto).'); return true; }
          if (!agenteOuErro(res, c.slug)) return true;
          slug = c.slug;
        }
        H.enviaJson(res, 200, Object.assign({ ok: true }, await anon.testarTexto(slug, c.texto)));
        return true;
      }
      const mm = /^\/([^/]+)\/(config|documentos|tabela|reverter-texto|final)(?:\/([^/]+))?$/.exec(sub);
      if (mm) {
        let slug; try { slug = decodeURIComponent(mm[1]); } catch (_) { slug = ''; }
        const acao = mm[2]; const extra = mm[3] ? decodeURIComponent(mm[3]) : null;
        const agente = agenteOuErro(res, slug);
        if (!agente) return true;

        if (acao === 'config' && !extra) {
          if (m === 'GET') { H.enviaJson(res, 200, { ok: true, slug, config: anon.config(slug) }); return true; }
          if (m !== 'PUT') return metodoErrado('GET ou PUT');
          const v = anon.validaConfig(await corpo(req, 8192));
          if (v.erro) { H.erroJson(res, 400, v.erro); return true; }
          const nova = anon.gravarConfig(slug, v.mudancas);
          log('info', `Anonimizar: configuração de ${slug} alterada (${Object.keys(v.mudancas).join(', ') || 'nada'}).`);
          H.enviaJson(res, 200, { ok: true, slug, config: nova });
          return true;
        }
        if (acao === 'documentos') {
          if (!extra) {
            if (m === 'GET') { H.enviaJson(res, 200, { ok: true, slug, documentos: anon.listarDocumentos(slug) }); return true; }
            if (m === 'DELETE') { H.enviaJson(res, 200, Object.assign({ ok: true, slug }, await anon.apagarTudo(slug))); return true; }
            return metodoErrado('GET ou DELETE');
          }
          if (m !== 'DELETE') return metodoErrado('DELETE');
          H.enviaJson(res, 200, Object.assign({ ok: true, slug, id: extra }, await anon.apagarDocumento(slug, extra)));
          return true;
        }
        if (acao === 'tabela' && !extra) {
          if (m !== 'GET') return metodoErrado('GET');
          if (!leituraDoSite(req, true)) {
            log('aviso', `Anonimizar: leitura da tabela de ${slug} recusada (pedido sem Origin do próprio site).`);
            H.erroJson(res, 403, 'Pedido recusado: a tabela só abre pela tela do DG Claw, neste mesmo site. Abra a tela Anonimizar e use "Ver tabela".');
            return true;
          }
          const entradas = anon.tabela(slug);
          log('info', `Anonimizar: a tabela de ${slug} foi aberta pelo dono (${entradas.length} entradas).`);
          H.enviaJson(res, 200, { ok: true, slug, total: entradas.length, entradas });
          return true;
        }
        if (acao === 'reverter-texto' && !extra) {
          if (m !== 'POST') return metodoErrado('POST');
          const c = await corpo(req);
          H.enviaJson(res, 200, Object.assign({ ok: true }, anon.reverterTexto(slug, c.texto)));
          return true;
        }
        if (acao === 'final' && extra) {
          if (m !== 'GET') return metodoErrado('GET');
          if (!leituraDoSite(req, false)) { H.erroJson(res, 403, 'Pedido recusado: a versão final só baixa pela tela do DG Claw, neste mesmo site.'); return true; }
          if (!RX_MEDIA.test(extra)) { H.erroJson(res, 400, 'O id do arquivo não vale. Use o botão "Baixar versão final" ao lado do anexo.'); return true; }
          const r = await anon.gerarFinal(agente, midia.obter(extra));
          const ativo = ['.html', '.htm'].includes(r.ext);
          const ascii = r.nome.replace(/[^A-Za-z0-9._-]+/g, '_');
          res.writeHead(200, {
            'Content-Type': ativo ? 'text/plain; charset=utf-8' : mimeDe(r.nome),
            'Content-Length': r.dados.length,
            'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.nome)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': 'sandbox; default-src \'none\'',
          });
          res.end(r.dados);
          return true;
        }
      }
    } catch (e) {
      if (e instanceof ErroAnon) {
        H.erroJson(res, e.status, e.message, e.codigo ? { codigo: e.codigo } : undefined);
        return true;
      }
      log('erro', `Anonimizar: falha inesperada em ${m} ${p}: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`);
      H.erroJson(res, 500, 'Não consegui tratar o pedido de anonimização. O detalhe está no log do Web (journalctl -u dgclaw-web).');
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em GET ${BASE}/docs.md.`);
    return true;
  }

  /** GET /api/v1/anonimizar/docs.md: conteúdo estático, sem sessão (o agente lê a doc sem credencial). */
  function servirDocs(res) {
    let texto;
    try { texto = fs.readFileSync(docsPath, 'utf8'); } catch (e) {
      log('erro', `Anonimizar: não li ${docsPath} (${e.code || e.message}).`);
      H.erroJson(res, 500, 'A documentação não está instalada neste servidor. Reinstale o DG Claw Web.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(texto);
  }

  return { rotas, servirDocs };
}

module.exports = { criarRotasAnonimizar };
