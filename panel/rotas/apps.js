const { servirBinario } = require('../lib/servir-binario');

// Aba Apps: os aplicativos que o agente opera e o link de compartilhamento.

module.exports = function registrar(router, ctx) {
  const { apps, compartilhar } = ctx;

  // ─── API: Apps (os aplicativos que o agente opera) ────────────
  // Endpoint do nucleo, sem poder: quem decide se ha app e o proprio agente, pelo
  // .dgclaw/apps.json dele. Todo erro daqui desce com MOTIVO em portugues, porque a
  // aba Apps nunca pode virar tela em branco.

  function responderApps(res, r) {
    if (r && r.erro) return res.status(r.status || 500).json({ error: r.erro });
    res.json(r);
  }

  router.get('/api/apps', (req, res) => {
    try {
      res.json(apps.listar());
    } catch (e) {
      res.status(500).json({ error: `Nao consegui ler a lista de apps: ${e.message}` });
    }
  });

  router.get('/api/apps/:app/conteudos', (req, res) => {
    try {
      responderApps(res, apps.projetos(req.params.app));
    } catch (e) {
      res.status(500).json({ error: `Nao consegui listar os conteudos: ${e.message}` });
    }
  });

  router.get('/api/apps/:app/conteudos/:slug', (req, res) => {
    try {
      responderApps(res, apps.projeto(req.params.app, req.params.slug));
    } catch (e) {
      res.status(500).json({ error: `Nao consegui abrir o conteudo: ${e.message}` });
    }
  });

  router.get('/api/apps/:app/conteudos/:slug/assets', (req, res) => {
    try {
      responderApps(res, apps.assets(req.params.app, req.params.slug));
    } catch (e) {
      res.status(500).json({ error: `Nao consegui listar o material: ${e.message}` });
    }
  });

  router.get('/api/apps/:app/conteudos/:slug/arquivo/:nome', (req, res) => {
    try {
      responderApps(res, apps.arquivo(req.params.app, req.params.slug, req.params.nome));
    } catch (e) {
      res.status(500).json({ error: `Nao consegui ler o arquivo: ${e.message}` });
    }
  });

  // A prévia de um asset. Existe porque, até ela, a aba Apps contava quantas imagens
  // o agente juntou e não mostrava nenhuma: o dono via "14 arquivos" e continuava
  // sem saber se o material presta.
  router.get('/api/apps/:app/conteudos/:slug/asset/:nome', (req, res) => {
    try {
      servirBinario(res, apps.assetBinario(req.params.app, req.params.slug, req.params.nome), false);
    } catch (e) {
      res.status(500).type('text/plain; charset=utf-8').send(`Não consegui abrir o material: ${e.message}`);
    }
  });

  // A etapa pronta virando link para quem nao tem senha deste painel.
  //
  // POST e nao GET DE PROPOSITO: cada chamada PUBLICA um arquivo novo na internet,
  // e isso nao pode acontecer por um navegador pre-carregando um link, nem ser
  // repetido por um F5. Quem aperta o botao esta decidindo mandar o trabalho do
  // agente para fora da casa.
  router.post('/api/apps/:app/conteudos/:slug/compartilhar', async (req, res) => {
    try {
      const r = await compartilhar.publicar(req.params.slug);
      if (r && r.erro) {
        console.error('[painel] compartilhar falhou:', r.erro, r.detalhe || '');
        return res.status(r.status || 500).json({
          error: r.erro,
          howToFix: r.howToFix,
          detalhe: r.detalhe,
        });
      }
      console.log(`[painel] roteiro de ${req.params.slug} publicado em ${r.url}`);
      res.json(r);
    } catch (e) {
      console.error('[painel] erro ao compartilhar:', e);
      res.status(500).json({ error: `Nao consegui gerar o link: ${e.message}` });
    }
  });
};
