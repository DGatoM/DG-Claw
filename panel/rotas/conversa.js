const express = require('express');

// A aba Conversa: ler, enviar, parar, acordar e ditar por voz.

module.exports = function registrar(router, ctx) {
  const { CONFIG, conversa } = ctx;

  // ─── API: Conversa ────────────────────────────────────────────
  //
  // A aba Conversa. Tres rotas e nenhuma tabela: a conversa VEM do transcript da sessao
  // viva e VAI para a sessao viva, e nada fica guardado no meio do caminho. Ver o
  // cabecalho de lib/conversa.js para o porque.
  //
  // Estas sao as PRIMEIRAS rotas de escrita do painel (ate aqui so /login e
  // /api/costs/analyze eram POST). Escrever aqui nao mexe em arquivo nenhum do agente:
  // o maximo que uma chamada faz e datilografar uma frase na sessao dele.

  router.get('/api/chat/mensagens', async (req, res) => {
    const last = parseInt(req.query.last || '80', 10);
    try {
      const r = await conversa.mensagens({ last: Number.isFinite(last) ? last : 80 });
      const estado = await conversa.estado();
      res.json({
        mensagens: r.mensagens,
        // A diferenca entre "conversa vazia" e "nao consegui ler" precisa chegar na
        // tela: a primeira e normal num agente novo, a segunda e defeito.
        erro: r.erro || null,
        aviso: r.aviso || null,
        estado: {
          chave: estado.chave,
          frase: estado.frase,
          podeEscrever: estado.escreve,
          trabalhando: estado.trabalhando,
          viva: estado.viva,
          // Ele caiu E da para acordar daqui. So vem verdadeiro quando a plataforma
          // respondeu e disse que o card esta num estado retomavel: sem isso a tela
          // mostraria um botao de acordar em cima de uma sessao que ja esta de pe, ou
          // quando quem nao respondeu foi a propria plataforma.
          podeReativar: estado.podeReativar === true,
          cardStatus: estado.cardStatus || null,
        },
        chat: conversa.CHAT,
        agente: CONFIG.agentName,
      });
    } catch (e) {
      console.error('[painel] falha ao montar a conversa:', e);
      res.status(500).json({
        mensagens: [],
        erro: `Nao consegui montar a conversa: ${e.message}`,
      });
    }
  });

  router.post('/api/chat/mensagem', async (req, res) => {
    const texto = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    if (!texto.trim()) {
      return res.status(400).json({
        error: 'A mensagem veio vazia.',
        howToFix: 'Escreva o que voce quer pedir e envie de novo.',
      });
    }
    try {
      const r = await conversa.enviar(texto);
      if (r.ok) return res.status(202).json({ enviado: true });
      // A mensagem NAO entrou. Dizer isso com todas as letras importa mais que o motivo
      // tecnico: a pessoa precisa saber que nao adianta esperar resposta.
      console.error('[painel] mensagem NAO entregue na sessao viva:', r.motivo);
      return res.status(502).json({
        error: `${CONFIG.agentName} nao esta conseguindo receber mensagem agora, entao isto NAO foi enviado.`,
        howToFix:
          'Espere um minuto e mande de novo. Se continuar, avise quem cuida do sistema: ' +
          'a sua mensagem nao se perdeu, ela simplesmente nao saiu.',
        detalhe: r.motivo,
      });
    } catch (e) {
      console.error('[painel] erro ao enviar mensagem:', e);
      res.status(500).json({ error: `Nao consegui enviar: ${e.message}` });
    }
  });

  router.post('/api/chat/parar', async (req, res) => {
    try {
      const r = await conversa.parar();
      if (r.ok) return res.json({ parado: true });
      console.error('[painel] nao consegui interromper a sessao:', r.motivo);
      res.status(502).json({
        error: 'Nao consegui interromper o que ele esta fazendo.',
        howToFix: 'Tente de novo em alguns segundos. Se nao parar, quem cuida do sistema consegue parar pelo terminal.',
        detalhe: r.motivo,
      });
    } catch (e) {
      res.status(500).json({ error: `Nao consegui interromper: ${e.message}` });
    }
  });

  // Acordar o terminal do agente. E a unica acao desta tela que sobe processo: as
  // outras duas so datilografam numa sessao que ja existe. Fica aqui, do lado delas,
  // porque para quem usa o painel e a mesma conversa: a diferenca e que esta e a que
  // funciona quando ele esta fora do ar.
  router.post('/api/chat/reativar', async (req, res) => {
    try {
      const r = await conversa.reativar();
      if (r.ok) return res.json({ acordando: true, jaEstavaDePe: !!r.jaEstavaDePe });
      console.error('[painel] nao consegui acordar o terminal do agente:', r.motivo);
      return res.status(502).json({
        error: `Nao consegui acordar ${CONFIG.agentName}.`,
        howToFix:
          'Tente de novo em alguns segundos. Se continuar, quem cuida do sistema sobe a sessao ' +
          'pela plataforma; a sua conversa continua guardada e nao se perde.',
        detalhe: r.motivo,
      });
    } catch (e) {
      console.error('[painel] erro ao acordar o terminal:', e);
      res.status(500).json({ error: `Nao consegui acordar: ${e.message}` });
    }
  });

  // O ditado por voz. Recebe o audio bruto do MediaRecorder do navegador e devolve o
  // TEXTO, que a tela poe na caixa de escrever para a pessoa ler antes de enviar.
  //
  // `express.raw` so nesta rota: o resto do painel fala JSON, e um parser binario
  // global engoliria corpo de rota que nao e audio. O teto de 25 MB da uns 25 minutos
  // de fala no formato que o navegador grava, bem acima de qualquer ditado real.
  //
  // O audio NAO e gravado em disco em lugar nenhum: entra pela requisicao, sai para a
  // transcricao e morre com ela. O que sobra da voz da pessoa e o texto que ela mesma
  // aprovar.
  router.post(
    '/api/chat/transcrever',
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const r = await conversa.transcrever(req.body, req.headers['content-type']);
        if (r.ok) return res.json({ texto: r.texto });
        console.error('[painel] transcricao falhou:', r.motivo);
        return res.status(r.silencio ? 400 : 502).json({
          error: r.silencio
            ? 'Nao consegui ouvir fala nenhuma nesse audio.'
            : 'Nao consegui transcrever o seu audio.',
          // "Tente gravar de novo" e o conselho certo para um audio ruim e o
          // conselho ERRADO para uma configuracao errada: gravar de novo nunca vai
          // consertar um endereco que nao tem servico de transcricao. Quando o
          // modulo sabe o que fazer, quem manda e ele.
          howToFix: r.silencio
            ? 'Fale mais perto do microfone e grave de novo. Nada foi perdido: voce ainda pode escrever.'
            : (r.comoResolver
              || 'Tente gravar de novo. Se continuar, escreva a mensagem: a conversa funciona do mesmo jeito.'),
          detalhe: r.motivo,
        });
      } catch (e) {
        console.error('[painel] erro na transcricao:', e);
        res.status(500).json({ error: `Nao consegui transcrever: ${e.message}` });
      }
    },
  );
};
