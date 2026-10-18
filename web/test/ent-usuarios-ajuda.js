'use strict';
// Apoio dos testes do bloco B (multiusuário): Web de teste em um nível enterprise, com relógio falso,
// três agentes (admin, ana e marina), auditoria numa pasta temporária e atalhos para o login com 2FA.
// As senhas daqui são de mentira, só para os testes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { subirWeb, pastaTemp, cliente } = require('./ajuda');
const { criarRunnerFalso } = require('./runner-falso');
const totp = require('../lib/totp');

async function cenarioEnt(opcoes) {
  const o = Object.assign({ nivel: 'escritorio', ajustes: {} }, opcoes || {});
  const dirNivel = pastaTemp('nivel');
  const protecoesPath = path.join(dirNivel, 'protecoes.json');
  if (o.nivel !== 'pessoal') fs.writeFileSync(protecoesPath, JSON.stringify({ nivel: o.nivel, ajustes: o.ajustes }));
  const auditoriaPath = path.join(dirNivel, 'auditoria.jsonl');
  let agora = Date.parse('2026-10-18T12:00:00Z');
  const tempo = { agora: () => agora, avanca: (ms) => { agora += ms; }, ms: () => agora };

  const runners = {};
  const agentes = [];
  for (const [slug, tipo, nome] of [['admin', 'admin', 'Admin'], ['ana', 'agente', 'Ana'], ['marina', 'agente', 'Marina']]) {
    const r = criarRunnerFalso({ agenteId: `${slug}1`, sessionId: `sess-${slug}-0001` });
    const porta = await r.ouvir();
    runners[slug] = r;
    const home = pastaTemp(`home-${slug}`);
    agentes.push({ slug, nome, tipo, runner: `http://127.0.0.1:${porta}`, agente_id: `${slug}1`, chat_id: `c_${slug}`, avatar: '🌿', cor: '#2f9e5e', provedor: 'claude', modelo: 'sonnet', home_host: home, home_container: `/home/${slug}` });
  }
  const s = await subirWeb({ agentes, ...(o.web || {}), opcoesServidor: Object.assign({ protecoesPath, auditoriaPath, agora: tempo.agora }, o.opcoesServidor) });
  // as telas do bloco B, para as rotas de página poderem servi-las
  for (const arq of ['login-2fa.html', 'conta.html', 'usuarios.html', 'protecoes.html']) fs.copyFileSync(path.join(__dirname, '../public', arq), path.join(s.publico, arq));
  const segredos = {};

  /** Eventos da auditoria como lista de { evento, quem, dados }. */
  function eventos() {
    if (!fs.existsSync(auditoriaPath)) return [];
    return fs.readFileSync(auditoriaPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const fechar = async () => { await s.fechar(); for (const r of Object.values(runners)) await r.fechar(); };

  /** Código do 2FA da pessoa, sempre de um passo novo (o mesmo código não vale duas vezes). */
  function codigo(usuario) { tempo.avanca(30000); return totp.codigoEm(segredos[usuario], tempo.ms()); }

  /**
   * Login completo. Devolve { r, cli }. Se o servidor pedir o segundo fator, ativa (primeira vez) ou digita o código.
   * `semSegundaEtapa: true` devolve logo depois da senha.
   */
  async function entrar(usuario, senha, extra) {
    const cli = (extra && extra.cli) || cliente(s.porta);
    const r = await cli.post('/login', { json: { usuario, senha } });
    if (r.status !== 200 || !r.json || !r.json.etapa || (extra && extra.semSegundaEtapa)) return { r, cli };
    const est = await cli.get('/api/v1/login/2fa');
    if (r.json.etapa === 'ativar') segredos[usuario] = est.json.segredo;
    const fim = await cli.post('/api/v1/login/2fa', { json: { codigo: codigo(usuario) } });
    return { r: fim, cli, ativacao: fim.json };
  }

  return { s, tempo, runners, agentes, eventos, entrar, codigo, segredos, fechar, protecoesPath, auditoriaPath, dataDir: s.dados, ti: 'dono', senhaTi: s.senha };
}

/** Cria um usuário pela API (como o TI logado em `cliTi`), define a senha pelo link e devolve { usuario, senha, link }. */
async function criarUsuario(c, cliTi, dados) {
  const r = await cliTi.post('/api/v1/usuarios', { json: dados });
  if (r.status !== 201) throw new Error(`criar usuário falhou: ${r.status} ${r.texto}`);
  const token = r.json.link.split('#')[1];
  const senha = dados.senha || aleatoria('usuario');
  const anon = cliente(c.s.porta);
  const l = await anon.post('/api/primeiro-acesso', { json: { token, senha, confirmacao: senha } });
  if (l.status !== 200) throw new Error(`link de senha falhou: ${l.status} ${l.texto}`);
  return { usuario: dados.usuario, senha, link: r.json.link };
}

/** Senha de teste gerada na hora (nenhuma senha fica escrita no código): prefixo + 16 hexadecimais, sempre com mais de 12 caracteres. */
const aleatoria = (prefixo) => `${prefixo || 'senha'}-${crypto.randomBytes(8).toString('hex')}`;

module.exports = { cenarioEnt, criarUsuario, aleatoria };
