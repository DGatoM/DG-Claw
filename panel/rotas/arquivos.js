const express = require('express');
const { servirBinario } = require('../lib/servir-binario');

// Aba Pasta: os arquivos que o agente guarda.

module.exports = function registrar(router, ctx) {
  const { arquivos } = ctx;

  // ─── API: Pasta (os arquivos que o agente guarda) ─────────────
  // Endpoint do núcleo, sem poder: todo agente tem uma pasta de trabalho. A raiz é
  // travada em <agentDir>/arquivos pelo lib/arquivos.js, e nenhuma rota daqui aceita
  // caminho que saia dela. Todo erro desce com motivo em português E o que fazer.

  function responderArquivos(res, r) {
    if (r && r.erro) return res.status(r.status || 500).json({ error: r.erro });
    res.json(r);
  }

  router.get('/api/arquivos', (req, res) => {
    try {
      responderArquivos(res, arquivos.listar(req.query.path || ''));
    } catch (e) {
      res.status(500).json({ error: `Não consegui listar a pasta: ${e.message}` });
    }
  });

  router.get('/api/arquivos/conteudo', (req, res) => {
    try {
      responderArquivos(res, arquivos.ler(req.query.path || ''));
    } catch (e) {
      res.status(500).json({ error: `Não consegui abrir o arquivo: ${e.message}` });
    }
  });

  // O download e a prévia saem pela MESMA rota. Imagem, vídeo, áudio e PDF descem
  // `inline`, para poderem abrir no visualizador; o resto desce como anexo, que é o
  // único destino honesto de um .xlsx num navegador.
  router.get('/api/arquivos/baixar', (req, res) => {
    try {
      const r = arquivos.binario(req.query.path || '');
      const abreNaTela = r && !r.erro && ['imagem', 'video', 'audio', 'pdf'].includes(r.tipo);
      servirBinario(res, r, !abreNaTela);
    } catch (e) {
      res.status(500).type('text/plain; charset=utf-8').send(`Não consegui baixar o arquivo: ${e.message}`);
    }
  });

  router.put('/api/arquivos', (req, res) => {
    try {
      const texto = req.body && typeof req.body.texto === 'string' ? req.body.texto : null;
      if (texto === null) {
        return res.status(400).json({
          error: 'Não veio texto nenhum no pedido, então o arquivo continua como estava.',
          howToFix: 'Abra o arquivo de novo, edite e clique em Salvar.',
        });
      }
      responderArquivos(res, arquivos.salvar(req.query.path || '', texto));
    } catch (e) {
      res.status(500).json({ error: `Não consegui salvar o arquivo: ${e.message}` });
    }
  });

  router.delete('/api/arquivos', (req, res) => {
    try {
      responderArquivos(res, arquivos.apagar(req.query.path || ''));
    } catch (e) {
      res.status(500).json({ error: `Não consegui apagar o arquivo: ${e.message}` });
    }
  });

  // O upload.
  //
  // SEM MULTER E SEM DEPENDÊNCIA NOVA. O corpo do POST é o arquivo inteiro e nada
  // mais: nome e pasta viajam na URL, e por isso não há formulário multipart para
  // desmontar. `express.raw` como middleware SÓ DESTA ROTA, e não global, porque um
  // parser binário global engoliria o corpo de toda rota JSON do painel.
  //
  // A TELA MANDA `application/octet-stream` DE PROPÓSITO. O `express.json()` lá em
  // cima é global e roda ANTES do router: se o navegador anunciasse o tipo real de
  // um .json subido pelo dono, o JSON seria comido pelo parser errado e chegaria
  // aqui como objeto, nunca como Buffer. Por isso o teste abaixo é explícito, e a
  // mensagem diz o que aconteceu em vez de gravar um arquivo corrompido.
  router.post(
    '/api/arquivos/upload',
    express.raw({ type: '*/*', limit: '25mb' }),
    (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body)) {
          return res.status(400).json({
            error: 'O arquivo não chegou como arquivo, e eu prefiro não gravar um pedaço de coisa nenhuma.',
            howToFix: 'Tente enviar de novo pelo botão Subir arquivo. Se continuar, recarregue a página antes.',
          });
        }
        responderArquivos(res, arquivos.subir(req.query.path || '', req.query.nome || '', req.body));
      } catch (e) {
        res.status(500).json({ error: `Não consegui guardar o arquivo: ${e.message}` });
      }
    },
  );
};
