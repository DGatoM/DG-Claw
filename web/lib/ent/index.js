'use strict';
// Ponto de extensão enterprise do Web. Carrega todo web/lib/ent/*.js (menos este arquivo); cada um exporta
//   { nome, ordem?, criar(ctx) }   e   criar() devolve   { antes?(req,res,url,sessao), podeVerAgente?(sessao,slug) }
// Cada bloco enterprise é um arquivo novo nesta pasta, sem mexer em server.js nem nos outros blocos.
//
//   antes            roda, na ordem (`ordem` e depois o nome), antes do roteamento da API e das páginas, logo
//                    depois de calculada a sessão. Devolve true quando já respondeu (rota enterprise, recusa por
//                    papel) e aí os seguintes não rodam. Pode ser async.
//   podeVerAgente    a regra única de acesso a agente: todos os módulos que a definem precisam concordar.
//                    Sem nenhum módulo que a defina, vale true (nível pessoal: todo mundo vê tudo).
//
// ctx: config, registro, auth, log, protecoes, auditoria (e o que o server.js acrescentar, como servirArquivo).

const fs = require('node:fs');
const path = require('node:path');

function carregarModulos(pasta, log) {
  const arquivos = fs.readdirSync(pasta)
    .filter((n) => n.endsWith('.js') && n !== 'index.js')
    .sort();
  const modulos = [];
  for (const arquivo of arquivos) {
    const caminho = path.join(pasta, arquivo);
    let m;
    try {
      m = require(caminho);
    } catch (e) {
      throw new Error(`O módulo enterprise ${caminho} não carregou (${e.message}). Corrija o arquivo ou tire-o de web/lib/ent/; o Web não sobe com um bloco de segurança quebrado.`);
    }
    if (!m || typeof m.nome !== 'string' || !m.nome || typeof m.criar !== 'function') {
      throw new Error(`O módulo enterprise ${caminho} precisa exportar { nome: 'texto', criar(ctx) }. Recebi: ${m ? Object.keys(m).join(', ') || '(objeto vazio)' : String(m)}.`);
    }
    modulos.push({ arquivo, nome: m.nome, ordem: Number.isFinite(m.ordem) ? m.ordem : 100, criar: m.criar });
  }
  modulos.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome));
  log('info', `Módulos enterprise: ${modulos.length ? modulos.map((m) => m.nome).join(', ') : 'nenhum'}.`);
  return modulos;
}

function criarEnterprise(ctx, opcoes) {
  const log = (ctx && ctx.log) || (() => {});
  const pasta = (opcoes && opcoes.pasta) || __dirname;
  const instancias = [];
  for (const m of carregarModulos(pasta, log)) {
    let inst;
    try {
      inst = m.criar(ctx) || {};
    } catch (e) {
      throw new Error(`O módulo enterprise "${m.nome}" (${m.arquivo}) falhou ao iniciar: ${e.message}`);
    }
    instancias.push({ nome: m.nome, antes: inst.antes, podeVerAgente: inst.podeVerAgente });
  }
  const comAntes = instancias.filter((i) => typeof i.antes === 'function');
  const comRegra = instancias.filter((i) => typeof i.podeVerAgente === 'function');

  return {
    modulos: instancias.map((i) => i.nome),
    async antes(req, res, url, sessao) {
      for (const i of comAntes) {
        if (await i.antes(req, res, url, sessao)) return true;
      }
      return false;
    },
    podeVerAgente(sessao, slug) {
      return comRegra.every((i) => i.podeVerAgente(sessao, slug) === true);
    },
  };
}

module.exports = { criarEnterprise };
