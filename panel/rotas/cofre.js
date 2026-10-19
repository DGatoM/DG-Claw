// Cofre do agente e chaves de API do painel.

module.exports = function registrar(router, ctx) {
  const { CONFIG, cofre, chavesApi, quemFez } = ctx;

  // ─── API: Cofre ───────────────────────────────────────────────
  //
  // NENHUMA DESTAS ROTAS DEVOLVE O VALOR DE UM SEGREDO, e isso não depende de
  // disciplina de quem escreve rota: o `lib/cofre.js` guarda metadado e valor em
  // arquivos separados, e o único caminho que decifra é a materialização, que
  // devolve contagem e não conteúdo. Não existe objeto aqui dentro com o valor.
  //
  // TAMBÉM NÃO EXISTE ROTA DE LEITURA EM CLARO, e isso é de propósito: se ela
  // existisse, um dia alguém a chamaria. Quem perdeu a chave gera outra no
  // provedor.

  function responderCofre(res, r) {
    if (r && r.erro) {
      const corpo = { error: r.erro };
      if (r.howToFix) corpo.howToFix = r.howToFix;
      return res.status(r.status || 500).json(corpo);
    }
    res.json(r);
  }

  router.get('/api/cofre', (req, res) => {
    try {
      res.json(cofre.estado());
    } catch (e) {
      res.status(500).json({ error: `Não consegui abrir o cofre: ${e.message}` });
    }
  });

  router.post('/api/cofre', (req, res) => {
    try {
      const b = req.body || {};
      // Quem cadastrou fica registrado COM A ORIGEM: o dono precisa distinguir a chave
      // que ele mesmo colou na tela da que outro assistente colocou por API.
      const porApi = !!(req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api');
      const guardado = cofre.guardar({
        envName: b.envName,
        valor: b.valor,
        provedor: b.provedor,
        quem: porApi ? `${req.dgclawAuth.nome} (por API)` : quemFez(req),
        origem: porApi ? 'api' : 'tela',
      });
      if (guardado.erro || b.aplicar !== true) return responderCofre(res, guardado);

      // `aplicar: true`: guarda e reinicia na mesma chamada. Se o reinício falhar, a
      // chave CONTINUA guardada, e a resposta diz as duas coisas com status de erro,
      // para que quem só olha o status não ache que deu tudo certo.
      const aplicado = cofre.aplicar();
      if (aplicado && aplicado.erro) {
        return res.status(aplicado.status || 500).json({
          error: `A chave foi guardada. ${aplicado.erro}`,
          howToFix: aplicado.howToFix || 'Guardar já foi feito; falta só reiniciar o agente (aba Cofre, "aplicar e reiniciar").',
          guardado,
          aplicado: { ok: false, erro: aplicado.erro },
        });
      }
      res.json({ ...guardado, aplicado });
    } catch (e) {
      // A mensagem de exceção NÃO leva o corpo do pedido junto, e é por isso que
      // este catch não faz `JSON.stringify(req.body)`: o valor da chave está lá.
      res.status(500).json({ error: `Não consegui guardar a chave: ${e.message}` });
    }
  });

  router.delete('/api/cofre', (req, res) => {
    try {
      responderCofre(res, cofre.revogar(req.query.envName || '', CONFIG.creatorName || 'Dono'));
    } catch (e) {
      res.status(500).json({ error: `Não consegui revogar a chave: ${e.message}` });
    }
  });

  // Aplicar = preparar o ambiente e REINICIAR o agente. É o passo que faz a chave
  // passar a valer, e ele é um botão separado do salvar de propósito: reiniciar o
  // agente interrompe o que ele estiver fazendo, e essa é uma decisão do dono, não
  // um efeito colateral de ter clicado em guardar.
  router.post('/api/cofre/aplicar', (req, res) => {
    try {
      const r = cofre.aplicar();
      if (r && r.erro) {
        const corpo = { error: r.erro };
        if (r.howToFix) corpo.howToFix = r.howToFix;
        if (r.materializou) corpo.materializou = true;
        return res.status(r.status || 500).json(corpo);
      }
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: `Não consegui aplicar o cofre: ${e.message}` });
    }
  });

  // ─── API: Chaves de API do painel ─────────────────────────────
  //
  // NENHUMA CHAVE DE API GERENCIA CHAVES DE API. O requireAuth já barra o Bearer em
  // /api/chaves-api*; o `soHumano` abaixo é a segunda tranca, para o dia em que
  // alguém mexer lá e esquecer desta regra. O token só aparece na resposta do POST.

  function soHumano(req, res, next) {
    if (req.dgclawAuth && req.dgclawAuth.tipo === 'chave-api') {
      return res.status(403).json({
        error: 'Uma chave de API não pode criar, listar nem revogar chaves de API.',
        howToFix: 'Faça isto pela aba Cofre do painel (entrando com a senha).',
      });
    }
    next();
  }

  router.get('/api/chaves-api', soHumano, (req, res) => {
    try {
      res.json({ chaves: chavesApi.listar() });
    } catch (e) {
      res.status(500).json({ error: `Não consegui listar as chaves de API: ${e.message}` });
    }
  });

  router.post('/api/chaves-api', soHumano, (req, res) => {
    try {
      const r = chavesApi.criar({ nome: (req.body || {}).nome, quem: quemFez(req) });
      responderCofre(res, r);
    } catch (e) {
      res.status(500).json({ error: `Não consegui criar a chave de API: ${e.message}` });
    }
  });

  router.delete('/api/chaves-api', soHumano, (req, res) => {
    try {
      responderCofre(res, chavesApi.revogar(req.query.id || '', quemFez(req)));
    } catch (e) {
      res.status(500).json({ error: `Não consegui revogar a chave de API: ${e.message}` });
    }
  });
};
