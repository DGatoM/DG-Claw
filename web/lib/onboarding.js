'use strict';
// O Web guarda o pedido; somente o Admin executa a criação pela CLI existente.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const RX_ID = /^[a-f0-9]{32}$/;
function erro(texto, status = 400) { return Object.assign(new Error(texto), { status }); }
function campo(v, nome, max) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f<>]/.test(v)) throw erro(`Preencha ${nome} com até ${max} caracteres, sem quebras de linha.`);
  return v.trim();
}
// Valida as escolhas da pessoa. Serve ao formulário (solicitar) e à conversa (registrarPedido).
function escolhas(body, dono) {
  const d = dono == null ? undefined : campo(dono, 'seu nome', 70);
  // Versão empresa (credencial_empresa): de quem é o agente. Sem a escolha, vale "pessoa" (o assento de quem está criando).
  const uso = body.uso == null ? 'pessoa' : body.uso;
  if (uso !== 'pessoa' && uso !== 'setor') throw erro('Diga se o agente é de uma pessoa ou de um setor (uso: "pessoa" ou "setor").');
  return { dono: d, nome: campo(body.nome, 'o nome', 70), papel: campo(body.papel, 'a função', 700), jeito: campo(body.jeito, 'o tom', 180), uso };
}
function slugNome(nome) {
  let s = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 26).replace(/-$/, '');
  if (s.length < 2) s = 'agente-' + s;
  if (s === 'admin') s = 'agente-admin';
  return s;
}

// ---- Progresso -------------------------------------------------------------
// Tudo o que a barra mostra sai daqui: da fase do pedido, do log da CLI e do log da imagem.
// Só circulam textos de listas conhecidas; a linha de falha da CLI passa por limpar().
const LIMITE_LOG = 64 * 1024;
const FAIXA_IMAGEM = [5, 30], FAIXA_CRIACAO = [30, 80];
const FIXOS = {
  enviando: [2, 'Enviando suas escolhas ao Admin'],
  solicitado: [5, 'O Admin está lendo o seu pedido'],
  login: [85, 'Falta conectar a assinatura'],
  testando: [92, 'Esperando o primeiro oi do agente'],
  pronto: [100, 'Pronto! Seu agente chegou'],
};
// Marco seguinte de cada fase fixa (a imagem e a criação calculam o seu pelo passo).
const PROXIMOS = { enviando: FIXOS.solicitado[0], solicitado: FAIXA_IMAGEM[1], login: FIXOS.testando[0], testando: FIXOS.pronto[0], pronto: 100 };
const ETAPA_IMAGEM = 'Preparando a imagem dos agentes (só na primeira vez, pode levar de 5 a 15 minutos)';
// Ordem e títulos de `dgclaw agente criar` (bin/dgclaw). O texto do log vem sem acento.
const ETAPAS = [
  [/^Reservando a faixa/i, 'Reservando um espaço para o agente'],
  [/^Montando a casa/i, 'Preparando a casa do agente'],
  [/^Escrevendo a identidade/i, 'Escrevendo a identidade do agente'],
  [/^Gerando os segredos/i, 'Gerando as chaves de segurança'],
  [/^Criando a rede e o container/i, 'Criando o ambiente isolado'],
  [/^Aplicando as regras de firewall/i, 'Aplicando as regras de proteção'],
  [/^Esperando a maquina/i, 'Ligando a máquina do agente'],
  [/^Instalando as rotinas/i, 'Instalando as rotinas do agente'],
  [/^Esperando o agente responder/i, 'Esperando o agente acordar'],
  [/^Testando o isolamento/i, 'Conferindo o isolamento'],
  [/^Registrando o agente/i, 'Registrando o agente'],
];
const sobe = (faixa, frac) => faixa[0] + Math.floor((faixa[1] - faixa[0]) * Math.min(Math.max(frac, 0), 1));
// eslint-disable-next-line no-control-regex
const RX_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

// Frase curta e segura para ir à tela: sem cor, sem segredo, sem caminho de segredo, até 300 caracteres.
function limpar(texto, max = 300) {
  return String(texto || '').replace(RX_ANSI, ' ')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[oculto]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [oculto]')
    .replace(/\b(token|senha|secret|segredo|password|passwd|api[_-]?key|chave)(\s*[:=]\s*)\S+/gi, '$1$2[oculto]')
    .replace(/\S*\/etc\/dgclaw\S*/g, '[caminho oculto]')
    .replace(/\S*\/\S*(segredo|secret|\.env|credenc)\S*/gi, '[caminho oculto]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[oculto]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// Lê só o fim do arquivo: o log cresce e a tela consulta a cada 1,5 s.
function lerFim(arquivo, log) {
  let fd;
  try {
    fd = fs.openSync(arquivo, 'r');
    const tam = fs.fstatSync(fd).size, ini = Math.max(0, tam - LIMITE_LOG), buf = Buffer.alloc(tam - ini);
    fs.readSync(fd, buf, 0, buf.length, ini);
    const linhas = buf.toString('utf8').split('\n');
    if (ini > 0) linhas.shift();
    return linhas.map(l => l.replace(RX_ANSI, '').trimEnd());
  } catch (e) {
    if (e.code !== 'ENOENT') log('aviso', `Não consegui ler o log ${path.basename(arquivo)} para mostrar o andamento (${e.code || e.name}). A barra segue pela fase do pedido.`);
    return [];
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Etapa mais adiantada da última execução de `agente criar` e a falha dela, se houver.
function lerCriacao(linhas) {
  const eventos = [];
  linhas.forEach((l, i) => {
    const m = /^\s*\[\d+\]\s+(.+)$/.exec(l);
    const idx = m ? ETAPAS.findIndex(([rx]) => rx.test(m[1].trim())) : -1;
    if (idx >= 0) eventos.push({ i, idx });
  });
  // Uma nova tentativa reaproveita o mesmo arquivo: vale só a execução mais recente.
  let ini = 0;
  for (const e of eventos) if (e.idx === 0) ini = e.i;
  const dela = eventos.filter(e => e.i >= ini);
  const idx = dela.length ? Math.max(...dela.map(e => e.idx)) : -1;
  let falha = null;
  for (let i = linhas.length - 1; i >= ini; i--) {
    const m = /^Nao deu certo:\s*(.*)$/.exec(linhas[i]);
    if (!m) continue;
    const fazer = linhas.slice(i + 1, i + 4).map(l => /^O que fazer:\s*(.*)$/.exec(l)).find(Boolean);
    falha = { motivo: limpar(m[1]), oQueFazer: fazer ? limpar(fazer[1]) : null };
    break;
  }
  return { idx, falha };
}

// Último "STEP n/m" do podman na construção em curso.
function lerImagem(linhas) {
  let n = 0, m = 0;
  for (const l of linhas) { const x = /^\s*(?:\[\d+\/\d+\]\s*)?STEP\s+(\d+)\/(\d+)/.exec(l); if (x) { n = +x[1]; m = +x[2]; } }
  const uteis = linhas.filter(l => l.trim()).slice(-3).map(l => limpar(l, 120)).filter(Boolean);
  return { n, m, uteis };
}

function estadoSystemd(unidade, log) {
  return new Promise(resolve => {
    execFile('systemctl', ['is-active', unidade], { timeout: 2000, windowsHide: true }, (e, saida) => {
      const texto = String(saida || '').trim();
      // is-active sai com código != 0 quando a unidade não está ativa; o texto basta.
      if (texto) return resolve(texto);
      log('aviso', `Não consegui perguntar ao systemd se ${unidade} está construindo a imagem (${e ? e.code || e.killed && 'tempo esgotado' || e.message : 'sem resposta'}). A barra segue pela fase do pedido.`);
      resolve('desconhecido');
    });
  });
}
function loja(dataDir) {
  const dir = path.join(dataDir, 'onboarding');
  function arquivo(id) { if (!RX_ID.test(id || '')) throw erro('Pedido inválido. Abra o Admin e tente novamente.'); return path.join(dir, id + '.json'); }
  function ler(id) { try { return JSON.parse(fs.readFileSync(arquivo(id), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  function gravar(p) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    p.atualizado = new Date().toISOString();
    // Hora em que a criação terminou: é ela que posiciona o cartão no histórico da conversa.
    if (p.fase === 'pronto' && !p.concluidoEp) p.concluidoEp = Math.floor(Date.now() / 1000);
    const arq = arquivo(p.id), tmp = arq + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, arq);
    return p;
  }
  function todos() {
    let nomes;
    try { nomes = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return nomes.filter(f => /^[a-f0-9]{32}\.json$/.test(f)).map(f => ler(f.slice(0, -5))).filter(Boolean).sort((a,b) => b.criado.localeCompare(a.criado));
  }
  function ultimo() { return todos()[0] || null; }
  return { dir, arquivo, ler, gravar, ultimo, todos };
}
function criarOnboarding({ config, registro, conversa, midia, log = () => {}, imagem = {} }) {
  const db = loja(config.dataDir);
  let ocupado = false;
  const unidade = imagem.unidade || 'dgclaw-imagem.service';
  const logImagem = imagem.log || path.join(process.env.DGCLAW_RAIZ || '', 'var/log/dgclaw/imagem.log');
  const consultarImagem = imagem.estado || (() => estadoSystemd(unidade, log));
  const ttlImagem = imagem.ttlMs ?? 3000;
  let cacheImagem = { t: 0, estado: 'desconhecido' }, voo = null;
  const maximos = new Map();
  // A tela consulta a cada 1,5 s; o systemd responde no máximo a cada ttlImagem.
  function atualizarImagem(p) {
    if (!p || !['solicitado', 'criando'].includes(p.fase)) return Promise.resolve();
    if (Date.now() - cacheImagem.t < ttlImagem) return Promise.resolve();
    voo = voo || Promise.resolve().then(consultarImagem)
      .then(estado => { cacheImagem = { t: Date.now(), estado: String(estado) }; })
      .catch(e => { cacheImagem = { t: Date.now(), estado: 'desconhecido' }; log('aviso', `Falha ao consultar a construção da imagem (${e.code || e.message}). A barra segue pela fase do pedido.`); })
      .finally(() => { voo = null; });
    return voo;
  }
  function progresso(p) {
    const criacao = lerCriacao(lerFim(path.join(db.dir, p.id + '.log'), log));
    const emErro = p.fase === 'erro' || p.fase === 'erro-envio';
    const fase = p.fase === 'erro-envio' ? 'enviando' : p.fase === 'erro' ? (p.ultimaFase || (criacao.idx >= 0 ? 'criando' : 'solicitado')) : p.fase;
    const construindo = ['active', 'activating'].includes(cacheImagem.estado), falhou = cacheImagem.estado === 'failed';
    let pct, etapa, passo = null, total = null, erroImg = null, proximo = null;
    if (fase === 'criando' && (criacao.idx >= 0 || !construindo)) {
      pct = sobe(FAIXA_CRIACAO, criacao.idx < 0 ? 0 : criacao.idx / ETAPAS.length);
      proximo = criacao.idx + 1 >= ETAPAS.length ? FIXOS.login[0] : sobe(FAIXA_CRIACAO, (criacao.idx + 1) / ETAPAS.length);
      etapa = criacao.idx < 0 ? 'Preparando a criação do agente' : ETAPAS[criacao.idx][1];
      if (criacao.idx >= 0) { passo = criacao.idx + 1; total = ETAPAS.length; }
    } else if (fase === 'solicitado' || fase === 'criando') {
      if (construindo) {
        const im = lerImagem(lerFim(logImagem, log));
        pct = im.m ? sobe(FAIXA_IMAGEM, im.n / im.m) : FAIXA_IMAGEM[0]; etapa = ETAPA_IMAGEM;
        proximo = im.m ? sobe(FAIXA_IMAGEM, (im.n + 1) / im.m) : FAIXA_IMAGEM[1];
        if (im.m) { passo = im.n; total = im.m; }
      } else if (falhou && fase === 'solicitado') {
        const im = lerImagem(lerFim(logImagem, log));
        [pct, etapa] = FIXOS.solicitado;
        erroImg = { motivo: 'A construção da imagem dos agentes falhou.' + (im.uteis.length ? ' Últimas linhas do registro: ' + im.uteis.join(' | ') : ''), oQueFazer: 'Peça ao Admin para rodar dgclaw imagem construir de novo.' };
      } else [pct, etapa] = FIXOS.solicitado;
    } else [pct, etapa] = FIXOS[fase] || FIXOS.solicitado;
    pct = Math.max(pct, maximos.get(p.id) || 0);
    maximos.set(p.id, pct);
    // Próximo marco real: a tela anda devagar até perto dele enquanto a etapa não muda.
    if (proximo == null) proximo = PROXIMOS[fase] ?? pct;
    proximo = Math.max(pct, Math.min(100, proximo));
    let erro = erroImg;
    if (emErro) {
      erro = { motivo: limpar((fase === 'criando' && criacao.falha && criacao.falha.motivo) || p.motivo || p.mensagem) || 'A preparação parou sem detalhes.',
        oQueFazer: (fase === 'criando' && criacao.falha && criacao.falha.oQueFazer) || null };
    }
    if (erro) proximo = pct;
    return { pct, etapa, passo, total, erro, proximo };
  }
  // Cartão estático do histórico: um por criação cuja animação já foi exibida (em qualquer aparelho).
  function cartoes() {
    const admin = registro.estado().agentes.find(a => a.tipo === 'admin');
    return db.todos().filter(p => p.fase === 'pronto' && p.animacaoVista && !p.cartaoDispensado).map(p => {
      const agente = registro.obter(p.slug);
      if (p.foto && p.fotoPath && admin) midia.registrar(admin.slug, p.fotoPath);
      return { id: p.id, nome: p.nome, foto: p.foto ? '/api/v1/media/' + p.foto : null, conversa: agente ? '/a/' + agente.slug : null,
        concluido: p.concluidoEp || Math.floor(Date.parse(p.atualizado) / 1000) };
    }).sort((a, b) => a.concluido - b.concluido);
  }
  // Guarda no servidor que a animação de "nasceu" já tocou, para valer em qualquer aparelho e em todo recarregamento.
  function animacaoVista(id) {
    const p = RX_ID.test(id || '') ? db.ler(id) : null;
    if (!p) throw erro('Não achei esse pedido de criação. Recarregue a conversa com o Admin.', 404);
    if (p.fase !== 'pronto') throw erro('O agente ainda não chegou, então a animação não pode ser marcada como vista. Aguarde o "pronto".', 409);
    // Pedidos antigos não tinham concluidoEp: fixa agora a hora real, antes de esta gravação mexer em `atualizado`.
    if (!p.animacaoVista) db.gravar({ ...p, concluidoEp: p.concluidoEp || Math.floor(Date.parse(p.atualizado) / 1000), animacaoVista: new Date().toISOString() });
    return { id: p.id, animacaoVista: true };
  }
  // O X do cartão: dispensa de vez, guardado no servidor para valer em qualquer aparelho. Idempotente.
  function dispensarCartao(id) {
    const p = RX_ID.test(id || '') ? db.ler(id) : null;
    if (!p) throw erro('Não achei esse pedido de criação. Recarregue a conversa com o Admin.', 404);
    if (p.fase !== 'pronto') throw erro('O agente ainda não chegou, então o cartão não pode ser dispensado. Aguarde o "pronto".', 409);
    if (!p.cartaoDispensado) db.gravar({ ...p, concluidoEp: p.concluidoEp || Math.floor(Date.parse(p.atualizado) / 1000), cartaoDispensado: new Date().toISOString() });
    return { id: p.id, cartaoDispensado: true };
  }
  function publico(p) {
    if (!p) return { fase: registro.estado().agentes.some(a => a.tipo !== 'admin') ? 'inativo' : 'boas-vindas' };
    const agente = registro.obter(p.slug);
    if (p.foto && p.fotoPath) {
      const admin = registro.estado().agentes.find(a => a.tipo === 'admin');
      if (admin) midia.registrar(admin.slug, p.fotoPath);
    }
    return { id: p.id, nome: p.nome, papel: p.papel, jeito: p.jeito, fase: p.fase, mensagem: p.mensagem || '', atualizado: p.atualizado,
      animacaoVista: !!p.animacaoVista, cartaoDispensado: !!p.cartaoDispensado, concluido: p.concluidoEp || Math.floor(Date.parse(p.atualizado) / 1000),
      foto: p.foto ? '/api/v1/media/' + p.foto : null,
      conversa: agente && p.fase === 'pronto' ? '/a/' + agente.slug : null,
      login: agente && agente.porta_painel ? '/p/' + agente.slug + '/?aba=status' : null,
      progresso: progresso(p) };
  }
  // `usuario` é o login de quem está criando: na versão empresa ele vira o dono do agente de pessoa.
  async function solicitar(body, usuario) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw erro('Preencha o formulário para criar seu agente.');
    if (ocupado) throw erro('O Admin está recebendo seu pedido. Aguarde um instante.', 409);
    if (!RX_ID.test(body.id || '')) throw erro('Faltou identificar o pedido. Recarregue o formulário.');
    const anterior = db.ler(body.id);
    if (anterior && anterior.fase !== 'erro-envio') return publico(anterior);
    const ultimo = db.ultimo();
    if (ultimo && ultimo.id !== body.id && !['pronto', 'erro-envio'].includes(ultimo.fase)) throw erro('Já existe uma criação em andamento. Continue com o Admin antes de criar outra.', 409);
    const { dono: donoInformado, nome, papel, jeito, uso } = escolhas(body, body.dono);
    const dono = donoInformado === undefined ? usuario : donoInformado;
    const admin = registro.estado().agentes.find(a => a.tipo === 'admin');
    if (!admin) throw erro('O Admin não está cadastrado. Peça para conferir a instalação.', 503);
    let foto = null, fotoPath = null;
    if (body.foto) {
      const f = midia.obter(body.foto);
      if (!f || f.slug !== admin.slug || f.kind !== 'photo' || !/\.(png|jpe?g|webp)$/i.test(f.path)) throw erro('Escolha uma foto PNG, JPEG ou WebP pelo formulário.');
      if (fs.statSync(f.path).size > 5 * 1024 * 1024) throw erro('A foto precisa ter até 5 MB.');
      foto = body.foto; fotoPath = f.path;
    }
    let slug = slugNome(nome);
    if (!anterior && registro.obter(slug)) slug = slug.slice(0, 22) + '-' + body.id.slice(0, 6);
    const p = anterior || { id: body.id, criado: new Date().toISOString(), nome, papel, jeito, dono, uso, usuario, slug, foto, fotoPath, provedor: admin.provedor === 'codex' ? 'codex' : 'claude' };
    ocupado = true;
    try {
      db.gravar({ ...p, fase: 'enviando', mensagem: 'Enviando suas escolhas ao Admin.' });
      // As escolhas ficam no JSON do pedido e nunca viram código de shell.
      const texto = '[do visual Criar meu agente] Quero criar meu agente com estas escolhas: ' +
        'Pode me chamar de ' + p.dono + '. Nome: ' + p.nome + '. Função: ' + p.papel + '. Tom: ' + p.jeito + '. ' +
        (p.uso === 'setor' ? 'Este agente é de um setor da empresa e usa a chave de API da empresa. ' : '') +
        (p.foto ? 'Escolhi a foto em anexo.' : 'Pode usar o avatar neutro.') + ' Confirmo a criação pelo formulário do painel.';
      const r = await conversa.enviar(admin, { text: texto, anexos: p.foto ? [p.foto] : [] });
      if (r.status >= 300) {
        db.gravar({ ...p, fase: 'erro-envio', mensagem: 'O pedido não chegou ao Admin. Confira a conexão e tente enviar novamente.' });
        throw erro(r.corpo.erro || 'O Admin não recebeu o pedido. Tente novamente.', r.status);
      }
      const atual = db.ler(p.id);
      // O Admin pode ter iniciado antes de o POST terminar.
      if (atual.fase === 'enviando') db.gravar({ ...atual, fase: 'solicitado', mensagem: 'O Admin recebeu suas escolhas e vai preparar seu agente.' });
      return publico(db.ler(p.id));
    } catch (e) {
      const atual = db.ler(p.id);
      if (atual && atual.fase === 'enviando') db.gravar({ ...atual, fase: 'erro-envio', mensagem: 'Não consegui confirmar a entrega. Confira a conversa com o Admin antes de tentar novamente.' });
      throw e;
    } finally { ocupado = false; }
  }
  return { estado: async () => { const p = db.ultimo(); await atualizarImagem(p); return { ...publico(p), cartoes: cartoes() }; }, solicitar, animacaoVista, dispensarCartao, db, foto: slug => {
    try { const p = db.todos().find(p => p.slug === slug && p.foto); return p ? publico(p).foto : null; }
    catch (e) { log('aviso', 'Não consegui ler a foto do onboarding (' + (e.code || e.name) + '). A conversa continua com o avatar do registro.'); return null; }
  } };
}
// Pedido vindo da CONVERSA: o dono respondeu ao Admin no chat em vez de usar o formulário.
// Grava o mesmo arquivo que o formulário grava, para `criar atual` e `testar atual` funcionarem igual
// e o painel mostrar a animação. Não escreve ao Admin: quem chama já é o Admin.
// semAdmin: o Admin está desligado de propósito (admin_llm = false, web/lib/ent/admin-desligado.js) e o formulário do Web
// cria o agente pelo controle; sem Admin cadastrado o provedor é o pedido em dados.provedor (claude ou codex) ou claude.
function registrarPedido({ config, registro, dados, semAdmin = false }) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw erro('Faltou o JSON com nome, papel, jeito e dono do agente.');
  const db = loja(config.dataDir);
  const ultimo = db.ultimo();
  if (ultimo && !['pronto', 'erro-envio'].includes(ultimo.fase)) throw erro(`Já existe uma criação em andamento (pedido na fase "${ultimo.fase}"). Termine ou resolva essa antes de gravar outro pedido.`, 409);
  const { dono, nome, papel, jeito, uso } = escolhas(dados, dados.dono);
  if (dono === undefined) throw erro('Preencha seu nome com até 70 caracteres, sem quebras de linha.');
  const admin = registro.estado().agentes.find(a => a.tipo === 'admin');
  if (!admin && !semAdmin) throw erro('O Admin não está cadastrado. Peça para conferir a instalação.', 503);
  const provedor = admin ? (admin.provedor === 'codex' ? 'codex' : 'claude') : (dados.provedor === 'codex' ? 'codex' : 'claude');
  const id = crypto.randomBytes(16).toString('hex');
  let slug = slugNome(nome);
  if (registro.obter(slug)) slug = slug.slice(0, 22) + '-' + id.slice(0, 6);
  return db.gravar({ id, criado: new Date().toISOString(), nome, papel, jeito, dono, uso, usuario: typeof dados.usuario === 'string' ? dados.usuario : undefined, slug, foto: null, fotoPath: null,
    provedor, fase: 'solicitado', origem: semAdmin ? 'formulario' : 'conversa',
    mensagem: semAdmin ? 'Recebi suas escolhas e vou preparar seu agente.' : 'O Admin recebeu suas escolhas pela conversa e vai preparar seu agente.' });
}
module.exports = { criarOnboarding, registrarPedido, loja, slugNome, RX_ID, limpar };
