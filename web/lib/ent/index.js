'use strict';
// Ponto de extensão enterprise do Web. Carrega todo web/lib/ent/*.js (menos este arquivo); cada um exporta
//   { nome, ordem?, criar(ctx) }   e   criar() devolve   { antes?(req,res,url,sessao), podeVerAgente?(sessao,slug) }
// Cada bloco enterprise é um arquivo novo nesta pasta, sem mexer em server.js nem nos outros blocos.
//
//   antes            roda, na ordem (`ordem` e depois o nome), antes do roteamento da API e das páginas, logo
//                    depois de calculada a sessão. Devolve true quando já respondeu (rota enterprise, recusa por
//                    papel) e aí os seguintes não rodam. Pode ser async.
//   antesDaSessao    como `antes`, mas roda ANTES do login e da sessão: (req, res, url) => true | false. Serve às rotas
//                    de quem ainda não tem sessão completa (tela do segundo fator, link de senha nova). Pode ser async.
//   login            (usuario, senha, ip, req) => resultado do login | null (null = não cuido, vale o login de sempre).
//                    O primeiro módulo que devolve diferente de null decide. Resultado: { ok, usuario, sessao?: { cookie },
//                    destino?, limite?, retryAfter?, erro? }.
//   aoSair           (req, sessao) => void, chamada em /sair antes de encerrar a sessão.
//   aoNegar          (req, sessao, recurso) => void, chamada quando o server.js recusa um agente (403) por causa de podeVerAgente.
//   podeVerAgente    a regra única de acesso a agente: todos os módulos que a definem precisam concordar.
//                    Sem nenhum módulo que a defina, vale true (nível pessoal: todo mundo vê tudo).
//
// ctx: config, registro, auth, log, protecoes, auditoria, servirArquivo, semSessaoPagina, caixa, push, agora (e o que um módulo
// anterior pendurar nele: web/lib/ent/aprovacoes.js, de ordem 20, põe ctx.aprovacoes para os blocos com ação perigosa).

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
    instancias.push({ nome: m.nome, antes: inst.antes, antesDaSessao: inst.antesDaSessao, login: inst.login, aoSair: inst.aoSair, aoNegar: inst.aoNegar, podeVerAgente: inst.podeVerAgente });
  }
  const comAntes = instancias.filter((i) => typeof i.antes === 'function');
  const comAntesDaSessao = instancias.filter((i) => typeof i.antesDaSessao === 'function');
  const comLogin = instancias.filter((i) => typeof i.login === 'function');
  const comSaida = instancias.filter((i) => typeof i.aoSair === 'function');
  const comNegacao = instancias.filter((i) => typeof i.aoNegar === 'function');
  const comRegra = instancias.filter((i) => typeof i.podeVerAgente === 'function');

  return {
    modulos: instancias.map((i) => i.nome),
    async antes(req, res, url, sessao) {
      for (const i of comAntes) {
        if (await i.antes(req, res, url, sessao)) return true;
      }
      return false;
    },
    async antesDaSessao(req, res, url) {
      for (const i of comAntesDaSessao) {
        if (await i.antesDaSessao(req, res, url)) return true;
      }
      return false;
    },
    async login(usuario, senha, ip, req) {
      for (const i of comLogin) {
        const r = await i.login(usuario, senha, ip, req);
        if (r != null) return r;
      }
      return null;
    },
    aoSair(req, sessao) { for (const i of comSaida) i.aoSair(req, sessao); },
    aoNegar(req, sessao, recurso) { for (const i of comNegacao) i.aoNegar(req, sessao, recurso); },
    podeVerAgente(sessao, slug) {
      return comRegra.every((i) => i.podeVerAgente(sessao, slug) === true);
    },
  };
}

module.exports = { criarEnterprise };
