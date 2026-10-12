'use strict';
/**
 * rotas-painel.js: as rotas da reorganização do painel (frente B, 01/10/2026).
 *
 * Moram num módulo próprio, registrado no server.js por UMA linha, porque outras
 * sessões penduram rotas no mesmo server.js ao mesmo tempo (a do Socorro, por
 * exemplo). Uma linha de cada um não colide; trinta linhas de cada um no meio do
 * arquivo colidem sempre.
 *
 *   GET  /api/operacoes          a aba Operações: cada operação do sistema com a
 *                                fileira de quadradinhos (lib/operacoes.js)
 *   GET  /api/rotinas/usuario    só as rotinas que o DONO pediu, com a última execução
 *   GET  /api/cerebro            o raio-X da memória, um cartão por arquivo vivo
 *   GET  /api/memoria/arquivo    um arquivo de memória inteiro, com a versão lida
 *   PUT  /api/memoria/arquivo    grava a edição à mão (lib/memoria.js explica as travas)
 *   GET  /api/radiografia        o "Como ele funciona" (docs/RADIOGRAFIA.md do plugin)
 *
 * Todo erro sai com `error` (o que aconteceu) e `howToFix` (o que fazer), em
 * português, com o status HTTP certo. Nada de 500 genérico nem de `{}` calado.
 */

const fs = require('fs');
const path = require('path');
const { buildOperacoes } = require('./operacoes');
const { buildMemoria } = require('./memoria');
const { todayStr } = require('./readers');

function registrar(router, { CONFIG, pulso, serverDir, diagnostico }) {
  const operacoes = buildOperacoes(CONFIG, {
    pulsoStatus: () => pulso.getStatus(todayStr(CONFIG.timezoneOffsetHours)),
    servicoDoCanal: () => (pulso.servicoDoCanal ? pulso.servicoDoCanal() : ''),
    // O diagnóstico de saúde (lib/saude.js, cache de 20 s) vence o "de pé" do cartão do agente.
    diagnostico,
  });
  const memoria = buildMemoria(CONFIG);

  router.get('/api/operacoes', async (req, res) => {
    try {
      const r = await operacoes.retrato({ forcar: req.query.atualizar === '1' });
      // As rotinas do usuário saem daqui de propósito: esta rota é só do sistema.
      const { rotinasDoUsuario, ...doSistema } = r;
      res.json({ ...doSistema, rotinasDoUsuario: (rotinasDoUsuario || []).length });
    } catch (e) {
      console.error('[painel] /api/operacoes quebrou:', e);
      res.status(500).json({ error: `Não consegui montar as operações: ${e.message}`, howToFix: 'Recarregue a página. Se continuar, o registro do painel diz o motivo.' });
    }
  });

  router.get('/api/rotinas/usuario', async (req, res) => {
    try {
      const r = await operacoes.retrato({ forcar: req.query.atualizar === '1' });
      res.json({
        rotinas: r.rotinasDoUsuario || [],
        inconsistencias: r.inconsistencias || [],
        historico: r.historico,
        erro: r.erroRotinas || null,
        geradoEm: r.geradoEm,
      });
    } catch (e) {
      console.error('[painel] /api/rotinas/usuario quebrou:', e);
      res.status(500).json({ error: `Não consegui ler as suas rotinas: ${e.message}`, howToFix: 'Recarregue a página.' });
    }
  });

  router.get('/api/cerebro', (req, res) => {
    try {
      res.json(memoria.cerebro());
    } catch (e) {
      console.error('[painel] /api/cerebro quebrou:', e);
      res.status(500).json({ error: `Não consegui ler a memória dele: ${e.message}`, howToFix: 'Recarregue a página. Se continuar, avise quem cuida do sistema.' });
    }
  });

  router.get('/api/memoria/arquivo', (req, res) => {
    const r = memoria.ler(req.query.path);
    if (r.status !== 200) return res.status(r.status).json({ error: r.erro, howToFix: r.howToFix });
    res.json(r.corpo);
  });

  router.put('/api/memoria/arquivo', (req, res) => {
    const corpo = req.body || {};
    const r = memoria.gravar({ path: corpo.path, conteudo: corpo.conteudo, versaoLida: corpo.versaoLida });
    if (r.status !== 200) {
      const extra = r.versaoAtual ? { versaoAtual: r.versaoAtual, atualizadoEm: r.atualizadoEm } : {};
      return res.status(r.status).json({ error: r.erro, howToFix: r.howToFix, ...extra });
    }
    res.json(r.corpo);
  });

  /**
   * A radiografia ("Como ele funciona"). O texto é do plugin, não do painel:
   * procura primeiro na cópia instalada no agente e depois ao lado deste painel
   * (o caso de quem roda o painel direto do repositório).
   */
  router.get('/api/radiografia', (req, res) => {
    const candidatos = [
      path.join(CONFIG.agentDir, '.dgclaw', 'plugin', 'docs', 'RADIOGRAFIA.md'),
      serverDir && path.join(serverDir, '..', 'docs', 'RADIOGRAFIA.md'),
    ].filter(Boolean);
    for (const c of candidatos) {
      try {
        const st = fs.statSync(c);
        if (!st.isFile()) continue;
        return res.json({
          ausente: false,
          markdown: fs.readFileSync(c, 'utf8'),
          origem: c.startsWith(CONFIG.agentDir) ? 'plugin instalado no agente' : 'repositório do painel',
          atualizadoEm: st.mtime.toISOString(),
        });
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[painel] nao consegui ler a radiografia em ${c} (${e.code}).`);
      }
    }
    // Ausente não é erro de servidor: é um texto que ainda não foi escrito.
    res.json({
      ausente: true,
      markdown: null,
      mensagem: 'O texto que explica como ele funciona ainda não foi instalado neste agente. '
        + 'Ele chega com a próxima atualização do plugin; o mapa acima já mostra os números de verdade.',
    });
  });

  return { operacoes, memoria };
}

module.exports = { registrar };
