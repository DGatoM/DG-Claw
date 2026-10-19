'use strict';
// Tela Proteções: o nível da instalação e o que cada proteção faz.
//   GET /api/v1/protecoes   o resumo (exige sessão)
//   GET /protecoes          a página (web/public/protecoes.html)
// Só leitura: mudar o nível é com `dgclaw nivel` no servidor.

const path = require('node:path');
const H = require('../http');

module.exports = {
  nome: 'protecoes-tela',
  ordem: 50,
  criar(ctx) {
    const { protecoes, servirArquivo, semSessaoPagina, config, log } = ctx;

    return {
      antes(req, res, url, sessao) {
        const p = url.pathname;
        const leitura = req.method === 'GET' || req.method === 'HEAD';

        if (p === '/api/v1/protecoes') {
          if (!sessao) { H.erroJson(res, 401, 'Você precisa entrar para ver as proteções. Faça login em /login.'); return true; }
          if (sessao.via === 'caixa') { H.erroJson(res, 403, 'A tela de proteções é só para quem entrou no painel; agentes não consultam esta rota.'); return true; }
          if (!leitura) { H.erroJson(res, 405, 'Use GET. O nível se muda no servidor, com: dgclaw nivel definir <nivel>.'); return true; }
          H.enviaJson(res, 200, Object.assign({ ok: true }, protecoes.resumo()));
          return true;
        }

        if ((p === '/protecoes' || p === '/protecoes/') && leitura) {
          if (!sessao) { semSessaoPagina(req, res, url); return true; }
          const arquivo = path.join(config.publicDir, 'protecoes.html');
          if (!servirArquivo(req, res, arquivo, 'no-store')) {
            log('erro', `A tela de proteções não está instalada: falta ${arquivo}.`);
            H.paginaErro(res, 500, 'Tela não instalada', 'O arquivo da tela de proteções não foi encontrado no servidor. Reinstale o DG Claw Web.');
          }
          return true;
        }
        return false;
      },
    };
  },
};
