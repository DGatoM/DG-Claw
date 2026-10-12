// rotas-saude.js — As rotas da saúde do agente e da sessão de socorro.
//
// Moram fora do server.js de propósito: o server.js é o ponto onde várias frentes
// penduram coisas ao mesmo tempo, e cada uma entrar com UMA linha (`require(...)(router,
// ctx)`) é o que evita duas sessões editando o mesmo bloco. O porquê de cada rota está
// em lib/saude.js e lib/socorro.js; aqui é só HTTP.
//
//   GET  /api/saude              o selo do cabeçalho: os campos de sempre (viva, chave,
//                                frase, cardStatus, motivo, podeReativar) + `diagnostico`
//                                (o contrato do saude_sessao.py) + `modoSeguro`.
//   POST /api/saude/reiniciar    {"modo": "normal" | "seguro"}
//   GET  /api/socorro/estado     ?desde=<seq>: os eventos da sessão de socorro
//   POST /api/socorro/mensagem   {"texto": "..."}
//   POST /api/socorro/encerrar

const { buildSaude } = require('./saude');
const { buildSocorro } = require('./socorro');

module.exports = function registrarRotasDaSaude(router, { CONFIG, conversa, serverDir }) {
  const saude = buildSaude(CONFIG, serverDir);
  const socorro = buildSocorro(CONFIG, serverDir);

  /**
   * A saúde do agente, para o selo do cabeçalho.
   *
   * POR QUE ESTA ROTA EXISTE. O selo "● Online" nascia verde e escrito no index.html,
   * e nenhum javascript escrevia nele. Em 28/08/2026 o agente do cliente passou catorze
   * horas fora do ar com o painel dizendo "Online". A primeira versão desta rota mediu
   * o PROCESSO (conversa.estado()); o `diagnostico` (01/10/2026) mede a RESPOSTA, porque
   * processo de pé que só devolve recusa ou "Login expired" também é agente fora do ar.
   * Os campos antigos continuam iguais: a tela de hoje usa eles.
   */
  router.get('/api/saude', async (req, res) => {
    let e;
    let estadoFalhou = false;
    try {
      e = await conversa.estado();
    } catch (err) {
      estadoFalhou = true;
      // Erro aqui não pode virar selo verde nem vermelho: "não consegui ver" é o que
      // de fato aconteceu.
      console.error('[saude] conversa.estado() falhou:', err);
      e = { viva: null, chave: 'indeterminado', frase: `não consegui verificar como ele está: ${err.message}` };
    }

    // A EXPLICAÇÃO DO RUNNER NÃO DESCE PARA O NAVEGADOR, de propósito. Ela traz caminho
    // de arquivo do servidor e comando de conserto, coisas de quem ADMINISTRA a
    // máquina. Vai para o log do serviço; a tela recebe o estado e a frase.
    if (e && !e.viva && e.explicacao) {
      console.error(`[saude] agente fora do ar (${e.cardStatus || 'sem status'}`
        + `${e.motivo ? `, ${e.motivo}` : ''}): ${e.explicacao}`);
    }

    let diagnostico = null;
    let modoSeguro = null;
    try {
      [diagnostico, modoSeguro] = await Promise.all([saude.diagnostico(), saude.modoSeguro()]);
    } catch (err) {
      console.error('[saude] diagnostico falhou:', err);
      diagnostico = {
        estado: 'indeterminado', tipo: 'desconhecido',
        frase: 'Não consegui conferir as respostas dele agora.', trecho: null, desde: null,
        ocorrencias: 0, recomendacao: 'esperar',
        comoResolver: 'Espere um minuto. Se continuar, avise quem cuida do sistema.',
        sessionId: null, verificadoEm: new Date().toISOString(),
      };
    }

    // 500 quando a medição do processo quebrou, como sempre foi: a tela trata qualquer
    // resposta que não é 200 como "não consegui ver", e o corpo vai junto do mesmo jeito.
    res.status(estadoFalhou ? 500 : 200).json({
      viva: e.viva === null ? null : !!e.viva,
      chave: e.chave || null,
      frase: e.frase || null,
      cardStatus: e.cardStatus || null,
      motivo: e.motivo || null,
      podeReativar: !!e.podeReativar,
      diagnostico,
      modoSeguro,
    });
  });

  router.post('/api/saude/reiniciar', async (req, res) => {
    const modo = req.body && req.body.modo;
    try {
      const r = await saude.reiniciar(modo);
      if (r.status >= 400) console.error(`[saude] reiniciar(${modo}) recusado ${r.status}: ${r.corpo.error}`);
      res.status(r.status).json(r.corpo);
    } catch (err) {
      console.error(`[saude] reiniciar(${modo}) quebrou:`, err);
      res.status(500).json({
        error: `Não consegui reiniciar: ${err.message}`,
        howToFix: 'Tente de novo em um minuto. Se continuar, avise quem cuida do sistema: o registro do painel tem o detalhe.',
      });
    }
  });

  // ── a sessão de socorro ─────────────────────────────────────────────────────

  router.get('/api/socorro/estado', (req, res) => {
    try {
      res.json(socorro.estado(req.query.desde));
    } catch (err) {
      console.error('[socorro] estado falhou:', err);
      res.status(500).json({ error: `Não consegui ler a sessão de socorro: ${err.message}` });
    }
  });

  router.post('/api/socorro/mensagem', (req, res) => {
    try {
      const r = socorro.mensagem(req.body && req.body.texto);
      res.status(r.status).json(r.corpo);
    } catch (err) {
      console.error('[socorro] mensagem falhou:', err);
      res.status(500).json({ error: `Não consegui mandar a mensagem ao socorro: ${err.message}` });
    }
  });

  router.post('/api/socorro/encerrar', (req, res) => {
    try {
      res.json(socorro.encerrar());
    } catch (err) {
      console.error('[socorro] encerrar falhou:', err);
      res.status(500).json({ error: `Não consegui encerrar a sessão de socorro: ${err.message}` });
    }
  });

  return { saude, socorro };
};
