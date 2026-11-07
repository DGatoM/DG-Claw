'use strict';
// Comandos de barra na conversa (referência completa em web/docs/COMANDOS-DE-BARRA.md).
//
// Este módulo faz três coisas:
//   1. monta o catálogo de um agente: os comandos nativos do motor (Claude Code ou Codex) que rodam
//      pelo runner, os que não rodam (com o motivo) e as skills lidas do disco da casa dele;
//   2. reconhece, no texto que a pessoa mandou, se aquilo é um comando de barra;
//   3. devolve uma DECISÃO para a conversa: seguir como texto, entregar um comando (cru ou dentro do
//      envelope) ou recusar com status, código e o que fazer.
// Não há dependência do panel: o web roda separado, então o leitor de cabeçalho de SKILL.md é uma
// cópia enxuta do de panel/lib/skills.js.

const fs = require('node:fs');
const path = require('node:path');

// A raiz do repositório instalado: onde ficam as skills de fábrica vistas do host.
const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const PREFIXO_APP_CONTAINER = '/opt/dgclaw/app';
const RX_BARRA = /^\/([A-Za-z0-9][A-Za-z0-9:._-]*)(\s+[\s\S]*)?$/;
const RX_NOME = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX_DESCRICAO = 160;
const MAX_LEITURA_SKILL = 16 * 1024;
const TTL_DISCO_MS = 10 * 1000;
const MAX_SUGESTOES = 5;

// ── nativos ────────────────────────────────────────────────────────────────

const MOTIVO_CONFIG = 'Abre uma tela de configuração no terminal. Configure pelo painel do agente ou pelo terminal dele no painel.';
const MOTIVO_EDITOR = 'Abre um editor de texto no terminal. Peça ao agente para editar a memória, em conversa.';
const MOTIVO_MENU = 'Abre um menu de escolha no terminal. Use o terminal do agente no painel.';
const MOTIVO_SAIR = 'Encerraria a sessão do agente. Para reiniciar, use o painel.';
const MOTIVO_TELA = 'Mostra uma tela no terminal que não chega na conversa, ou pede confirmação lá. Use o terminal do agente no painel.';
const MOTIVO_CONTA = 'Gerenciar a conta não funciona pela conversa digitada. Use o cartão de login da tela ou siga /api/v1/login/docs.md.';
const MOTIVO_MODELO_CODEX = 'Abre um menu de escolha no terminal. Troque o modelo pelo painel do agente.';

const roda = (nome, descricao, argumentos, espera, extra) =>
  Object.assign({ nome, tipo: 'nativo', descricao, argumentos, roda: true, espera_resposta: espera }, extra || {});
const naoRoda = (nome, descricao, motivo) =>
  ({ nome, tipo: 'nativo', descricao, argumentos: null, roda: false, motivo, espera_resposta: false });

const TELA_LOGIN = { nome: '/login', tipo: 'tela', descricao: 'Abre o cartão de login da conta do motor', argumentos: null, roda: true, espera_resposta: false };

function nativosClaude() {
  return [
    roda('/compact', 'Resume a conversa para liberar contexto', 'instruções opcionais', false),
    roda('/clear', 'Começa uma conversa limpa (a anterior fica no disco)', null, false),
    roda('/context', 'Mostra quanto do contexto está ocupado', null, false),
    roda('/cost', 'Mostra o gasto e a duração da sessão', null, false),
    roda('/model', 'Troca o modelo da sessão, ex.: /model sonnet', 'nome do modelo (obrigatório)', false, { argumento_obrigatorio: true, exemplo: '/model sonnet' }),
    roda('/init', 'Pede ao agente para escrever o CLAUDE.md da pasta', null, true),
    roda('/review', 'Pede uma revisão de código', 'número do PR opcional', true),
    roda('/security-review', 'Pede uma revisão de segurança das mudanças', null, true),
    ...['/config:Configurações do Claude Code', '/permissions:Regras de permissão das ferramentas', '/hooks:Hooks do Claude Code',
      '/agents:Subagentes do Claude Code', '/mcp:Servidores MCP', '/plugin:Plugins do Claude Code', '/skills:Lista de skills do terminal',
      '/statusline:Linha de status do terminal', '/output-style:Estilo de resposta', '/theme:Tema do terminal', '/vim:Modo vim do campo de texto',
      '/privacy-settings:Configurações de privacidade'].map((s) => naoRoda(s.split(':')[0], s.split(':')[1], MOTIVO_CONFIG)),
    naoRoda('/memory', 'Edita os arquivos de memória', MOTIVO_EDITOR),
    ...['/resume:Retoma uma conversa anterior', '/rewind:Volta a conversa para um ponto anterior', '/export:Exporta a conversa'].map((s) => naoRoda(s.split(':')[0], s.split(':')[1], MOTIVO_MENU)),
    naoRoda('/logout', 'Sai da conta do Claude Code', MOTIVO_CONTA),
    naoRoda('/exit', 'Encerra o Claude Code', MOTIVO_SAIR),
    naoRoda('/quit', 'Encerra o Claude Code', MOTIVO_SAIR),
    ...['/help:Ajuda do terminal', '/status:Status do Claude Code', '/doctor:Diagnóstico da instalação', '/usage:Uso do plano', '/release-notes:Novidades da versão',
      '/bug:Envia um relato de erro', '/feedback:Envia um comentário', '/ide:Integração com o editor', '/terminal-setup:Configura o terminal',
      '/upgrade:Troca de plano', '/install-github-app:Instala o app do GitHub', '/add-dir:Adiciona uma pasta de trabalho', '/bashes:Lista os comandos em segundo plano',
      '/todos:Lista de tarefas do terminal'].map((s) => naoRoda(s.split(':')[0], s.split(':')[1], MOTIVO_TELA)),
  ];
}

function nativosCodex() {
  return [
    roda('/compact', 'Resume a conversa para liberar contexto', null, false),
    roda('/new', 'Começa uma conversa nova', null, false),
    roda('/clear', 'Apelido de /new: o Web troca antes de entregar', null, false, { vira: '/new' }),
    roda('/init', 'Pede ao agente para escrever o AGENTS.md da pasta', null, true),
    roda('/review', 'Pede uma revisão das mudanças', null, true),
    naoRoda('/model', 'Troca o modelo da sessão', MOTIVO_MODELO_CODEX),
    naoRoda('/approvals', 'Muda o nível de aprovação', MOTIVO_CONFIG),
    naoRoda('/mcp', 'Servidores MCP', MOTIVO_CONFIG),
    naoRoda('/status', 'Status do Codex', MOTIVO_TELA),
    naoRoda('/diff', 'Mostra as diferenças do Git', MOTIVO_TELA),
    naoRoda('/mention', 'Escolhe um arquivo para citar', MOTIVO_MENU),
    naoRoda('/logout', 'Sai da conta do Codex', MOTIVO_CONTA),
    naoRoda('/quit', 'Encerra o Codex', MOTIVO_SAIR),
  ];
}

// ── skills do disco ────────────────────────────────────────────────────────

function tiraAspas(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Devolve { name, description, ... } do cabeçalho, ou null se o arquivo não abre com `---`. */
function lerFrontmatter(texto) {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/);
  if (linhas[0].trim() !== '---') return null;
  const fim = linhas.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (fim < 0) return null;
  const campos = {};
  for (let i = 1; i < fim; i++) {
    const m = linhas[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, chave, resto] = m;
    if (/^[>|][+-]?$/.test(resto.trim()) || resto.trim() === '') {
      const partes = [];
      let j = i + 1;
      while (j < fim && (/^\s+\S/.test(linhas[j]) || linhas[j].trim() === '')) { partes.push(linhas[j].trim()); j++; }
      const dobrado = resto.trim().startsWith('|') ? '\n' : ' ';
      campos[chave] = partes.join(dobrado).replace(/\s+$/, '').replace(/ {2,}/g, ' ');
      i = j - 1;
    } else {
      campos[chave] = tiraAspas(resto);
    }
  }
  return campos;
}

function cortaDescricao(d) {
  const t = String(d || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESCRICAO ? `${t.slice(0, MAX_DESCRICAO - 1).trimEnd()}…` : t;
}

const semBarraFinal = (p) => String(p || '').replace(/\/+$/, '');

/**
 * Traduz o destino de um atalho para um caminho que existe no host.
 * - destino sob /opt/dgclaw/app que não existe no host vira <raiz do repositório instalado>/resto;
 * - destino sob home_container vira home_host.
 * Devolve o caminho (talvez igual ao de entrada).
 */
function destinoNoHost(destino, agente, raizRepo) {
  const cont = semBarraFinal(agente.home_container);
  const host = semBarraFinal(agente.home_host);
  if (destino === PREFIXO_APP_CONTAINER || destino.startsWith(`${PREFIXO_APP_CONTAINER}/`)) {
    if (fs.existsSync(destino)) return destino;
    return path.join(raizRepo, destino.slice(PREFIXO_APP_CONTAINER.length));
  }
  if (cont && host && (destino === cont || destino.startsWith(`${cont}/`))) return host + destino.slice(cont.length);
  return destino;
}

/**
 * Lê as skills de <home_host>/.claude/skills. Nunca lança: problema vira aviso.
 * Devolve { skills:[{nome, pasta, descricao}], pastas:[{caminho, existe, erro?}], avisos:[] }.
 */
function lerSkillsDoDisco(agente, raizRepo) {
  const avisos = []; const skills = [];
  if (!agente.home_host) {
    avisos.push(`O registro do agente ${agente.nome} não tem home_host, então não sei onde procurar as skills dele. As skills não aparecem na lista.`);
    return { skills, pastas: [], avisos };
  }
  const dir = path.join(agente.home_host, '.claude', 'skills');
  const pasta = { caminho: dir, existe: true };
  let entradas = [];
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    pasta.existe = false;
    if (e.code !== 'ENOENT') {
      pasta.erro = `não consegui abrir: ${e.code || e.message}`;
      avisos.push(`Não consegui abrir a pasta de skills ${dir} (${e.code || e.message}). Confira a permissão da pasta; as skills do agente não aparecem na lista.`);
    }
    return { skills, pastas: [pasta], avisos };
  }
  entradas.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entradas) {
    if (!(ent.isDirectory() || ent.isSymbolicLink())) continue;
    const entrada = path.join(dir, ent.name);
    let real = entrada;
    if (ent.isSymbolicLink()) {
      let alvo;
      try { alvo = fs.readlinkSync(entrada); } catch (e) {
        avisos.push(`A skill "${ent.name}" é um atalho que não consegui ler (${e.code || e.message}). Recrie o atalho em ${entrada}.`);
        continue;
      }
      if (!path.isAbsolute(alvo)) alvo = path.resolve(dir, alvo);
      real = destinoNoHost(alvo, agente, raizRepo);
      if (!fs.existsSync(real)) {
        avisos.push(`A skill "${ent.name}" é um atalho para ${alvo}${real !== alvo ? ` (visto aqui como ${real})` : ''}, e esse caminho não existe. Recrie o atalho ou apague ${entrada}.`);
        continue;
      }
    }
    const arquivo = path.join(real, 'SKILL.md');
    let texto;
    try {
      const fd = fs.openSync(arquivo, 'r');
      try {
        const buf = Buffer.alloc(MAX_LEITURA_SKILL);
        const n = fs.readSync(fd, buf, 0, MAX_LEITURA_SKILL, 0);
        texto = buf.subarray(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (e) {
      if (e.code === 'ENOENT' && !ent.isSymbolicLink()) continue; // pasta comum sem SKILL.md não é skill: não é erro
      avisos.push(`Não consegui ler ${arquivo} (${e.code || e.message}), então a skill "${ent.name}" não aparece na lista. Confira se o arquivo existe e se dá para ler.`);
      continue;
    }
    const fm = lerFrontmatter(texto);
    if (!fm) {
      avisos.push(`O SKILL.md da skill "${ent.name}" (${arquivo}) não começa com o cabeçalho entre "---", então ela não aparece na lista. Peça ao agente para corrigir o arquivo.`);
      continue;
    }
    const nome = (fm.name && fm.name.trim()) || ent.name;
    if (!RX_NOME.test(nome)) {
      avisos.push(`A skill da pasta "${ent.name}" tem o nome "${nome}", que não dá para chamar pela barra (use letras, números, "-", "_", ".", ":"). Ela não aparece na lista.`);
      continue;
    }
    skills.push({ nome, pasta: ent.name, descricao: cortaDescricao(fm.description) || 'Sem descrição no cabeçalho da skill.' });
  }
  return { skills, pastas: [pasta], avisos };
}

// ── sugestões ──────────────────────────────────────────────────────────────

function distancia(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Até 5 nomes parecidos: começa com / contém / pouca distância de edição. */
function sugerir(digitado, itens) {
  const d = digitado.toLowerCase();
  const pontuados = [];
  for (const it of itens) {
    if (!it.roda) continue;
    const n = it.nome.slice(1).toLowerCase();
    let ponto = null;
    if (n.startsWith(d) || d.startsWith(n)) ponto = 0;
    else if (n.includes(d) || d.includes(n)) ponto = 1;
    else {
      const dist = distancia(d, n);
      if (dist <= Math.max(2, Math.ceil(Math.max(d.length, n.length) / 3))) ponto = 2 + dist;
    }
    if (ponto !== null) pontuados.push({ nome: it.nome, ponto });
  }
  pontuados.sort((a, b) => a.ponto - b.ponto || (a.nome < b.nome ? -1 : 1));
  return pontuados.slice(0, MAX_SUGESTOES).map((x) => x.nome);
}

// ── o módulo ───────────────────────────────────────────────────────────────

function provedorNormalizado(p) {
  const t = String(p || '');
  if (/codex|openai/i.test(t)) return 'codex';
  if (/claude|anthropic/i.test(t)) return 'claude';
  return null;
}

function criarComandos({ runner, log, agora, raizRepo }) {
  const relogio = agora || (() => Date.now());
  const raiz = raizRepo || RAIZ_REPO;
  const discos = new Map(); // `${slug}|${home_host}` -> { ts, valor }

  function doDisco(agente) {
    const chave = `${agente.slug}|${agente.home_host || ''}`;
    const c = discos.get(chave);
    if (c && relogio() - c.ts < TTL_DISCO_MS) return c.valor;
    const valor = lerSkillsDoDisco(agente, raiz);
    discos.set(chave, { ts: relogio(), valor });
    return valor;
  }

  /** O provedor do agente agora: runner, depois registro, depois claude. Devolve { provedor, aviso|null }. */
  async function descobreProvedor(agente) {
    let motivo = '';
    try {
      const r = await runner.provedor(agente, 1500);
      if (r.ok) {
        const p = provedorNormalizado(r.dados.provedor);
        if (p) return { provedor: p, aviso: null };
        motivo = `o runner respondeu o provedor ${JSON.stringify(r.dados.provedor == null ? null : String(r.dados.provedor).slice(0, 40))}, que não reconheço`;
      } else motivo = r.erro || 'o runner não respondeu';
    } catch (e) {
      motivo = e.message;
    }
    const doRegistro = provedorNormalizado(agente.provedor);
    if (doRegistro) return { provedor: doRegistro, aviso: `Não consegui saber o motor pelo runner (${motivo}). Usei o do registro do agente (${doRegistro}); se você trocou o motor há pouco, a lista pode estar desatualizada.` };
    const aviso = `Não consegui saber o motor do agente ${agente.nome} (${motivo}) e o registro também não diz. Assumi o Claude Code; se o agente usa Codex, a lista pode estar errada.`;
    if (log) log('aviso', `Comandos de ${agente.slug}: ${aviso}`);
    return { provedor: 'claude', aviso };
  }

  /** O catálogo de um agente: { provedor, comandos, pastas_de_skills, avisos }. */
  async function catalogo(agente) {
    const { provedor, aviso } = await descobreProvedor(agente);
    const avisos = aviso ? [aviso] : [];
    const nativos = provedor === 'codex' ? nativosCodex() : nativosClaude();
    const comandos = [...nativos, Object.assign({}, TELA_LOGIN)];
    const usados = new Set(comandos.map((c) => c.nome.toLowerCase()));
    const disco = doDisco(agente);
    avisos.push(...disco.avisos);
    for (const s of disco.skills) {
      const nome = `/${s.nome}`;
      if (usados.has(nome.toLowerCase())) {
        const nativo = comandos.find((c) => c.nome.toLowerCase() === nome.toLowerCase());
        avisos.push(nativo && nativo.tipo === 'skill'
          ? `Há duas skills chamadas "${s.nome}". A de ${nativo.pasta ? `.claude/skills/${nativo.pasta}` : 'outra pasta'} ficou e a da pasta ".claude/skills/${s.pasta}" foi ignorada. Renomeie uma delas.`
          : `A skill "${s.nome}" (pasta .claude/skills/${s.pasta}) tem o mesmo nome do comando nativo ${nome}, então ela não pode ser chamada pela barra. Renomeie a skill (campo "name" do cabeçalho do SKILL.md).`);
        continue;
      }
      usados.add(nome.toLowerCase());
      comandos.push({ nome, tipo: 'skill', descricao: s.descricao, argumentos: 'o pedido', roda: true, espera_resposta: true, pasta: s.pasta });
    }
    return { provedor, comandos, pastas_de_skills: disco.pastas, avisos };
  }

  const erro = (status, codigo, motivo, extra) => ({ erro: { status, codigo, erro: motivo, ...(extra || {}) } });

  /**
   * Decide o que fazer com o texto que a pessoa mandou.
   * Devolve { tipo:'texto', texto? } | { tipo:'comando', entregue_como, textoParaRunner, comando } | { erro:{status, codigo, erro, ...} }.
   * Com `texto` na decisão, a conversa usa esse texto no lugar do original (caso `//`).
   */
  async function decidir(agente, textoBruto, { temAnexos } = {}) {
    const texto = typeof textoBruto === 'string' ? textoBruto.trim() : '';
    if (temAnexos || !texto.startsWith('/')) return { tipo: 'texto' };
    if (texto.startsWith('//')) return { tipo: 'texto', texto: texto.slice(1) };
    const m = RX_BARRA.exec(texto);
    if (!m) return { tipo: 'texto' };
    const digitado = m[1];
    const args = (m[2] || '').trim();
    const cat = await catalogo(agente);
    const item = cat.comandos.find((c) => c.nome === `/${digitado}`) || cat.comandos.find((c) => c.nome.toLowerCase() === `/${digitado}`.toLowerCase());
    if (!item) {
      const sugestoes = sugerir(digitado, cat.comandos);
      return erro(404, 'COMANDO_INEXISTENTE',
        `O comando /${digitado} não existe para ${agente.nome} (motor ${cat.provedor === 'codex' ? 'Codex' : 'Claude Code'}).` +
        (sugestoes.length ? ` Parecidos: ${sugestoes.join(', ')}.` : ' Digite / no campo para ver a lista do que dá para usar.') +
        ` Se era um texto para o agente e não um comando, comece com duas barras (//${digitado}). Nada foi enviado.`,
        { sugestoes, provedor: cat.provedor });
    }
    if (item.tipo === 'tela') {
      return erro(422, 'COMANDO_DA_TELA',
        `${item.nome} é tratado pela tela (abre o cartão "entrar na conta") e não vai ao agente. Pela API, siga /api/v1/login/docs.md. Nada foi enviado.`,
        { comando: item.nome, docs: '/api/v1/login/docs.md' });
    }
    if (!item.roda) {
      return erro(422, 'COMANDO_NAO_RODA',
        `${item.nome} não roda pela conversa. ${item.motivo} Nada foi enviado.`,
        { comando: item.nome, motivo: item.motivo });
    }
    if (item.argumento_obrigatorio && !args) {
      return erro(400, 'COMANDO_PEDE_ARGUMENTO',
        `${item.nome} sem argumento abre um menu de escolha no terminal, e o terminal do agente ficaria parado nele. Mande com o nome, por exemplo: ${item.exemplo}. Nada foi enviado.`,
        { comando: item.nome, exemplo: item.exemplo });
    }
    const comando = { nome: item.nome, tipo: item.tipo, espera_resposta: item.espera_resposta };
    if (item.tipo === 'skill' && cat.provedor === 'codex') {
      // O Codex do runner não lê ~/.claude/skills: a skill vai como fala normal, com o pedido explícito.
      const texto2 = `Rode a skill "${item.nome.slice(1)}" (arquivo .claude/skills/${item.pasta}/SKILL.md): leia o SKILL.md e siga o roteiro com estes argumentos: ${args || '(nenhum)'}`;
      return { tipo: 'comando', entregue_como: 'envelope', textoParaRunner: texto2, comando };
    }
    const nomeFinal = item.vira || item.nome; // /clear no Codex vira /new
    if (item.vira) comando.executado_como = item.vira;
    // Cru vai digitado no campo do TUI: uma quebra de linha ali pode virar Enter no meio do comando.
    const argsCru = args.replace(/\s+/g, ' ');
    return { tipo: 'comando', entregue_como: 'cru', textoParaRunner: argsCru ? `${nomeFinal} ${argsCru}` : nomeFinal, comando };
  }

  return { catalogo, decidir };
}

module.exports = { criarComandos, lerSkillsDoDisco, lerFrontmatter, sugerir, nativosClaude, nativosCodex, RX_BARRA, RAIZ_REPO };
