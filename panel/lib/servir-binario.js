const fs = require('fs');
const { disposicao } = require('./mime');

// Serve UM arquivo do disco para o navegador.
//
// POR QUE ISTO NÃO PASSA PELO `responderApps`. Aquele helper devolve JSON, e aqui
// o corpo da resposta é o próprio arquivo. O `{erro, status}` que os módulos
// devolvem continua sendo tratado, só que à mão: erro sai como texto simples, e o
// caminho feliz vira um `pipe` direto do disco para a resposta.
//
// STREAMING, e não `readFileSync`: o painel roda numa VPS pequena e um vídeo de
// 300 MB lido para a memória antes de responder derruba o processo inteiro, com o
// dono do agente vendo o painel cair por ter clicado numa miniatura.
//
// `nosniff` mais `sandbox` porque o arquivo veio da pasta do agente. O tipo que
// desce é o da tabela de lib/mime.js e mais nenhum, e um .svg servido inline não
// pode virar uma página que roda script na origem do painel.
function servirBinario(res, r, comoAnexo) {
  if (r && r.erro) return res.status(r.status || 500).type('text/plain; charset=utf-8').send(r.erro);
  res.type(r.mime);
  res.setHeader('Content-Length', r.bytes);
  res.setHeader('Content-Disposition', disposicao(r.nome, !!comoAnexo));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  // 60 segundos: o suficiente para a grade de miniaturas não rebuscar tudo a cada
  // redesenho da aba (que acontece a cada minuto), e curto para o arquivo trocado
  // no disco aparecer trocado na tela sem ninguém precisar limpar cache. `private`
  // porque isto é material do agente de UM dono, e não pode ficar em cache de meio.
  res.setHeader('Cache-Control', 'private, max-age=60');
  const fluxo = fs.createReadStream(r.caminho);
  fluxo.on('error', (err) => {
    console.error('[painel] falhou ao servir arquivo:', r.caminho, err.message);
    if (!res.headersSent) res.status(500).type('text/plain; charset=utf-8').send('Não consegui ler o arquivo do disco.');
    else res.destroy();
  });
  fluxo.pipe(res);
}

module.exports = { servirBinario };
