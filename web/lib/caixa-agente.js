'use strict';
// Caixa do agente: o agente (dentro do container, sem alcance ao host) deixa um pedido em
// <home_host>/.dgclaw/caixa/entrada/<id>.json; o Web, que é root, executa o pedido contra a
// própria API em 127.0.0.1 e grava a resposta em saida/<id>.json. Contrato completo em
// docs/CAIXA-DO-AGENTE.md.
//
// O Web lê e grava numa pasta que o agente controla. Por isso toda leitura usa lstat + O_NOFOLLOW
// e só aceita arquivo regular do dono da casa, e toda escrita passa pelo gravador seguro.
// O segredo da chamada interna nasce na memória a cada partida e nunca vai para disco nem para log.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { gravaArquivoSeguro, ErroGravacao } = require('./grava-seguro');

const RX_ID = /^[a-z0-9-]{8,64}$/;
const RX_ARQ = /^[a-z0-9-]{8,64}\.json$/;
const RX_REL = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const RX_FRENTE = /^[a-z0-9-]{1,40}$/;
const METODOS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_PEDIDO = 1024 * 1024;
const MAX_RESPOSTA = 8 * 1024 * 1024;
const MAX_POR_VOLTA = 20;
const TETO_POR_MINUTO = 120;
const IDADE_MAX_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 30 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Quem fez o pedido: o dono (sessão do navegador) ou um agente (pela caixa). */
function quemChamou(sessao) {
  if (sessao && sessao.via === 'caixa') return { tipo: 'agente', slug: sessao.agente };
  // `pode` (enterprise): função (slug) => boolean que o server.js pendura na sessão; só existe para quem é dono. Sem ela, vê tudo.
  const dono = { tipo: 'dono', usuario: sessao ? sessao.usuario : null };
  if (sessao && typeof sessao.pode === 'function') dono.pode = sessao.pode;
  return dono;
}

function criarCaixaAgente({ config, registro, log, porta, agora }) {
  const relogio = agora || (() => Date.now());
  const segredo = crypto.randomBytes(32).toString('hex');
  const segredoHash = crypto.createHash('sha256').update(segredo).digest();
  const prefixos = [];
  const janelas = new Map();      // slug -> instantes (ms) dos pedidos do último minuto
  const ocupados = new Set();     // agentes em atendimento nesta volta
  const jaAvisado = new Set();    // avisos que só valem uma vez por causa
  const naoApagados = new Set();  // pedidos já respondidos que o Web não conseguiu apagar
  let timer = null;

  function avisaUmaVez(chave, mensagem) {
    if (jaAvisado.has(chave)) return;
    jaAvisado.add(chave);
    log('aviso', mensagem);
  }

  function permitir(prefixo) {
    if (typeof prefixo !== 'string' || !prefixo.startsWith('/api/v1/') || prefixo.includes('..')) {
      throw new TypeError(`caixa.permitir precisa de um prefixo começando por /api/v1/ (recebi ${JSON.stringify(prefixo)}). Corrija a chamada no server.js.`);
    }
    const limpo = prefixo.replace(/\/+$/, '');
    if (!prefixos.includes(limpo)) prefixos.push(limpo);
  }

  function rotaPermitida(pathname) {
    return prefixos.some((p) => pathname === p || pathname.startsWith(p + '/'));
  }

  // ── identidade do pedido interno ───────────────────────────────────────────
  function ehPedidoDaCaixa(req) {
    const cab = req.headers['x-dgclaw-caixa'];
    if (typeof cab !== 'string' || !cab) return null;
    const ip = req.socket && req.socket.remoteAddress;
    if (!LOOPBACK.has(ip)) return null;
    const dado = crypto.createHash('sha256').update(cab).digest();
    if (!crypto.timingSafeEqual(dado, segredoHash)) return null;
    const slug = req.headers['x-dgclaw-agente'];
    if (typeof slug !== 'string') return null;
    const ag = registro.obter(slug);
    // O Admin em container (enterprise, papel "admin") também usa a caixa: é por ela que chega ao controle do servidor.
    return ag && (ag.tipo === 'agente' || ag.papel === 'admin') ? slug : null;
  }

  // ── caminhos e dono da casa ────────────────────────────────────────────────
  /** Dono da casa do agente, ou null (com aviso, uma vez) se a caixa não deve atender. */
  function donoDaCasa(agente) {
    let st;
    try { st = fs.statSync(agente.home_host); } catch (e) {
      avisaUmaVez(`casa:${agente.slug}`, `Caixa de ${agente.slug}: não consegui ler a casa ${agente.home_host} (${e.code || e.message}). Confira o home_host no registro de agentes.`);
      return null;
    }
    if (!st.isDirectory()) {
      avisaUmaVez(`casa:${agente.slug}`, `Caixa de ${agente.slug}: ${agente.home_host} não é uma pasta. Confira o home_host no registro de agentes.`);
      return null;
    }
    if (st.uid === 0) {
      avisaUmaVez(`root:${agente.slug}`, `Caixa de ${agente.slug} desligada: a casa ${agente.home_host} pertence ao root (uid 0), e casa de root não é casa de agente. Confira o home_host no registro; o agente deve ter um usuário próprio.`);
      return null;
    }
    return { uid: st.uid, gid: st.gid };
  }

  /**
   * Confere .dgclaw/caixa/<sub> sem seguir atalho. Devolve o caminho, ou null:
   * pasta ainda não existe (silencioso) ou é atalho/estranha (aviso uma vez).
   */
  function pastaDaCaixa(agente, sub) {
    let homeReal;
    try { homeReal = fs.realpathSync(agente.home_host); } catch (e) {
      avisaUmaVez(`casa:${agente.slug}`, `Caixa de ${agente.slug}: não consegui resolver a casa ${agente.home_host} (${e.code || e.message}).`);
      return null;
    }
    let atual = homeReal;
    for (const parte of ['.dgclaw', 'caixa', sub]) {
      atual = path.join(atual, parte);
      let st;
      try { st = fs.lstatSync(atual); } catch (e) {
        if (e.code === 'ENOENT') return null;
        avisaUmaVez(`pasta:${atual}`, `Caixa de ${agente.slug}: não consegui conferir ${atual} (${e.code || e.message}).`);
        return null;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        avisaUmaVez(`pasta:${atual}`, `Caixa de ${agente.slug}: ${atual} é ${st.isSymbolicLink() ? 'um atalho' : 'algo que não é pasta'}. Recusei por segurança; o dono deve rodar "sudo dgclaw agente reparar ${agente.slug}".`);
        return null;
      }
    }
    let real;
    try { real = fs.realpathSync(atual); } catch (e) {
      avisaUmaVez(`pasta:${atual}`, `Caixa de ${agente.slug}: não consegui resolver ${atual} (${e.code || e.message}).`);
      return null;
    }
    if (real !== atual || !real.startsWith(homeReal + path.sep)) {
      avisaUmaVez(`pasta:${atual}`, `Caixa de ${agente.slug}: ${atual} aponta para ${real}, fora da casa do agente. Recusei por segurança.`);
      return null;
    }
    return atual;
  }

  // ── limite de pedidos ──────────────────────────────────────────────────────
  /** Janela deslizante de 60 s. Devolve 0 se pode, ou quantos segundos esperar. */
  function esperaDoTeto(slug) {
    const t = relogio();
    const lista = (janelas.get(slug) || []).filter((x) => t - x < 60000);
    janelas.set(slug, lista);
    if (lista.length >= TETO_POR_MINUTO) return Math.max(1, Math.ceil((lista[0] + 60000 - t) / 1000));
    lista.push(t);
    return 0;
  }

  // ── resposta ───────────────────────────────────────────────────────────────
  function responde(agente, dono, entrada, id, status, corpo) {
    // A pasta saida/ pode faltar: o gravador seguro a cria (dono da casa, 0700) e recusa atalho.
    const saida = path.join(path.dirname(entrada), 'saida');
    return gravaArquivoSeguro(path.join(saida, `${id}.json`), JSON.stringify({ v: 1, id, status, corpo }), {
      raiz: agente.home_host, uid: dono.uid, gid: dono.gid, modo: 0o600,
      pasta: { modo: 0o700, uid: dono.uid, gid: dono.gid },
    });
  }

  function apagaPedido(agente, entrada, id) {
    const arq = path.join(entrada, `${id}.json`);
    if (pastaDaCaixa(agente, 'entrada') !== entrada) {
      log('erro', `Caixa de ${agente.slug}: a pasta de entrada mudou durante o atendimento do pedido ${id}; não apaguei ${arq}. Confira se o agente trocou a pasta por um atalho.`);
      naoApagados.add(arq);
      return;
    }
    try { fs.unlinkSync(arq); } catch (e) {
      if (e.code === 'ENOENT') return;
      naoApagados.add(arq);
      log('erro', `Caixa de ${agente.slug}: respondi o pedido ${id}, mas não consegui apagar ${arq} (${e.code || e.message}). Apague o arquivo à mão; enquanto ele ficar lá, o Web não o atende de novo.`);
    }
  }

  // ── execução contra a própria API ──────────────────────────────────────────
  function executa(slug, pedido) {
    return new Promise((resolve) => {
      const temCorpo = pedido.corpo !== undefined && pedido.corpo !== null;
      const dados = temCorpo ? Buffer.from(JSON.stringify(pedido.corpo), 'utf8') : null;
      const cab = { 'X-DGClaw-Caixa': segredo, 'X-DGClaw-Agente': slug };
      if (dados) { cab['Content-Type'] = 'application/json'; cab['Content-Length'] = dados.length; }
      let terminou = false;
      const fim = (r) => { if (!terminou) { terminou = true; resolve(r); } };
      let req;
      try {
        req = http.request({ host: '127.0.0.1', port: porta(), method: pedido.metodo, path: pedido.rota, headers: cab, timeout: TIMEOUT_MS }, (res) => {
          const partes = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > MAX_RESPOSTA) { res.destroy(); fim({ status: 502, corpo: { ok: false, erro: `A resposta de ${pedido.metodo} ${pedido.rota} passou de ${MAX_RESPOSTA} bytes e foi descartada. Peça menos dados (use filtros ou limit).` } }); return; }
            partes.push(c);
          });
          res.on('error', (e) => fim({ status: 502, corpo: { ok: false, erro: `A resposta de ${pedido.rota} foi interrompida (${e.code || e.message}). Tente de novo.` } }));
          res.on('end', () => {
            const texto = Buffer.concat(partes).toString('utf8');
            let corpo = texto;
            if (/json/i.test(String(res.headers['content-type'] || ''))) {
              try { corpo = JSON.parse(texto); } catch (e) {
                log('aviso', `Caixa de ${slug}: ${pedido.rota} respondeu Content-Type JSON mas o corpo não é JSON (${e.message}); devolvi como texto.`);
              }
            }
            fim({ status: res.statusCode, corpo });
          });
        });
      } catch (e) {
        fim({ status: 502, corpo: { ok: false, erro: `Não consegui montar a chamada para ${pedido.rota} (${e.message}). Confira o caminho da rota.` } });
        return;
      }
      req.on('timeout', () => { req.destroy(new Error('sem resposta em 30 s')); });
      req.on('error', (e) => {
        log('erro', `Caixa de ${slug}: a chamada interna ${pedido.metodo} ${pedido.rota} falhou (${e.code || e.message}). Se o Web acabou de reiniciar, o agente pode repetir o pedido.`);
        fim({ status: 502, corpo: { ok: false, erro: `O Web não conseguiu atender ${pedido.metodo} ${pedido.rota} (${e.code || e.message}). Tente de novo em instantes; se repetir, avise o dono.` } });
      });
      if (dados) req.write(dados);
      req.end();
    });
  }

  // ── leitura segura de um pedido ────────────────────────────────────────────
  /** Devolve { pedido } ou { status, erro } (resposta a gravar) ou { descarta, motivo }. */
  function lePedido(agente, dono, entrada, nome, id) {
    const p = path.join(entrada, nome);
    let st;
    try { st = fs.lstatSync(p); } catch (e) {
      if (e.code === 'ENOENT') return { sumiu: true };
      return { status: 500, erro: `O Web não conseguiu conferir o pedido ${id} (${e.code || e.message}). Envie de novo.` };
    }
    if (!st.isFile()) {
      log('aviso', `Caixa de ${agente.slug}: recusei ${p} porque não é um arquivo comum (${st.isSymbolicLink() ? 'é um atalho' : 'tipo estranho'}). Pedidos são arquivos .json normais.`);
      return { status: 403, erro: `O pedido ${id} não é um arquivo comum (atalhos, pastas e pipes são recusados). Grave um arquivo .json normal em entrada/.` };
    }
    if (st.uid !== dono.uid) {
      log('aviso', `Caixa de ${agente.slug}: recusei ${p} porque o dono dele (uid ${st.uid}) não é o dono da casa (uid ${dono.uid}).`);
      return { status: 403, erro: `O pedido ${id} pertence a outro usuário (uid ${st.uid}) e foi recusado.` };
    }
    if (st.size > MAX_PEDIDO) {
      log('aviso', `Caixa de ${agente.slug}: pedido ${id} com ${st.size} bytes passou do teto de ${MAX_PEDIDO}.`);
      return { status: 413, erro: `O pedido ${id} tem ${st.size} bytes e o teto é ${MAX_PEDIDO} (1 MB). Mande menos dados.` };
    }
    if (relogio() - st.mtimeMs > IDADE_MAX_MS) {
      log('aviso', `Caixa de ${agente.slug}: pedido ${id} esperou mais de 5 minutos e foi descartado.`);
      return { status: 408, erro: `O pedido ${id} esperou mais de 5 minutos na entrada e foi descartado. Envie de novo.` };
    }
    let fd = null; let texto;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st2 = fs.fstatSync(fd);
      if (!st2.isFile() || st2.ino !== st.ino || st2.dev !== st.dev || st2.uid !== dono.uid || st2.size > MAX_PEDIDO) {
        log('aviso', `Caixa de ${agente.slug}: ${p} mudou entre a conferência e a leitura; recusei.`);
        return { status: 403, erro: `O pedido ${id} mudou enquanto era lido e foi recusado. Envie de novo.` };
      }
      const buf = Buffer.alloc(st2.size);
      let lidos = 0;
      while (lidos < st2.size) {
        const n = fs.readSync(fd, buf, lidos, st2.size - lidos, lidos);
        if (n === 0) break;
        lidos += n;
      }
      texto = buf.toString('utf8', 0, lidos);
    } catch (e) {
      log('aviso', `Caixa de ${agente.slug}: não consegui abrir ${p} (${e.code || e.message}); recusei.`);
      return { status: 403, erro: `O pedido ${id} não pôde ser aberto (${e.code || e.message}). Grave um arquivo .json normal em entrada/.` };
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (e) { log('aviso', `Caixa de ${agente.slug}: falha ao fechar ${p} (${e.code || e.message}).`); } }
    }
    let ped;
    try { ped = JSON.parse(texto); } catch (e) {
      log('aviso', `Caixa de ${agente.slug}: o pedido ${id} não é JSON válido (${e.message}).`);
      return { status: 400, erro: `O pedido ${id} não é um JSON válido (${e.message}). Use o comando dgclaw-api, que monta o arquivo certo.` };
    }
    const prob = validaPedido(ped, id);
    if (prob) {
      log('aviso', `Caixa de ${agente.slug}: pedido ${id} inválido: ${prob}`);
      return { status: 400, erro: `O pedido ${id} é inválido: ${prob}` };
    }
    return { pedido: ped };
  }

  function validaPedido(p, id) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'o arquivo precisa ser um objeto {"v":1,"id":...,"metodo":...,"rota":...}.';
    if (p.v !== 1) return `o campo "v" precisa ser 1 (veio ${JSON.stringify(p.v)}).`;
    if (p.id !== id) return `o campo "id" (${JSON.stringify(p.id)}) precisa ser igual ao nome do arquivo (${id}).`;
    if (!METODOS.has(p.metodo)) return `o "metodo" precisa ser GET, POST, PUT, PATCH ou DELETE (veio ${JSON.stringify(p.metodo)}).`;
    if (typeof p.rota !== 'string' || !p.rota.startsWith('/api/v1/')) return 'a "rota" precisa ser um texto começando por /api/v1/.';
    if (p.rota.length > 2000) return 'a "rota" passa de 2000 caracteres.';
    if (p.rota.includes('..') || /[\x00-\x20\x7f\\]/.test(p.rota)) return 'a "rota" tem ".." ou caracteres inválidos (espaço, barra invertida, controle).';
    return null;
  }

  // ── atendimento ────────────────────────────────────────────────────────────
  async function atende(agente, dono, entrada, nome) {
    const id = nome.slice(0, -5);
    const chave = path.join(entrada, nome);
    if (naoApagados.has(chave)) return;
    const l = lePedido(agente, dono, entrada, nome, id);
    if (l.sumiu) return;

    let status; let corpo;
    if (l.erro) {
      status = l.status; corpo = { ok: false, erro: l.erro };
    } else {
      const espera = esperaDoTeto(agente.slug);
      if (espera) {
        log('aviso', `Caixa de ${agente.slug}: passou de ${TETO_POR_MINUTO} pedidos por minuto; o pedido ${id} voltou 429.`);
        status = 429;
        corpo = { ok: false, erro: `Pedidos demais: o limite é ${TETO_POR_MINUTO} por minuto por agente. Espere ${espera} s e tente de novo.`, retryAfter: espera };
      } else {
        const ped = l.pedido;
        let pathname = '';
        try { pathname = decodeURIComponent(new URL(ped.rota, 'http://local').pathname); } catch (e) {
          log('aviso', `Caixa de ${agente.slug}: a rota do pedido ${id} não é um endereço válido (${e.message}).`);
          status = 400; corpo = { ok: false, erro: `A rota ${ped.rota.slice(0, 80)} não é um endereço válido (${e.message}).` };
        }
        if (status === undefined) {
          if (pathname.includes('..') || !rotaPermitida(pathname)) {
            log('aviso', `Caixa de ${agente.slug}: rota ${pathname.slice(0, 120)} não liberada (pedido ${id}).`);
            status = 403;
            corpo = { ok: false, erro: `A rota ${pathname.slice(0, 120)} não está liberada para agentes. Só as rotas que a frente liberou com caixa.permitir() respondem pela caixa; peça ao dono se precisar dela.` };
          } else {
            const r = await executa(agente.slug, ped);
            status = r.status; corpo = r.corpo;
          }
        }
      }
    }
    try {
      responde(agente, dono, entrada, id, status, corpo);
    } catch (e) {
      log('erro', `Caixa de ${agente.slug}: não consegui gravar a resposta do pedido ${id} (${e.message}). Corrija a pasta saida/ da caixa (dono e permissão 700) e deixe o agente repetir o pedido.`);
      naoApagados.add(chave);
      return;
    }
    apagaPedido(agente, entrada, id);
  }

  async function voltaDoAgente(agente) {
    const dono = donoDaCasa(agente);
    if (!dono) return;
    const entrada = pastaDaCaixa(agente, 'entrada');
    if (!entrada) return;
    let nomes;
    try { nomes = fs.readdirSync(entrada); } catch (e) {
      log('erro', `Caixa de ${agente.slug}: não consegui listar ${entrada} (${e.code || e.message}). Confira a permissão da pasta.`);
      return;
    }
    for (const chave of [...naoApagados]) {
      if (chave.startsWith(entrada + path.sep) && !nomes.includes(path.basename(chave))) naoApagados.delete(chave);
    }
    const fila = nomes.filter((n) => !n.startsWith('.') && RX_ARQ.test(n)).sort().slice(0, MAX_POR_VOLTA);
    for (const nome of fila) {
      try { await atende(agente, dono, entrada, nome); } catch (e) {
        log('erro', `Caixa de ${agente.slug}: erro inesperado no pedido ${nome} (${e && e.message}). O pedido continua na entrada; se repetir, avise quem mantém o DG Claw.`);
        naoApagados.add(path.join(entrada, nome));
      }
    }
  }

  /** Uma passada por todos os agentes. Os agentes andam em paralelo; cada um, um pedido por vez. */
  async function volta() {
    const est = registro.estado();
    if (!est.ok) return;
    const tarefas = [];
    for (const ag of est.agentes) {
      if (!(ag.tipo === 'agente' || ag.papel === 'admin') || !ag.home_host || ocupados.has(ag.slug)) continue;
      ocupados.add(ag.slug);
      tarefas.push(voltaDoAgente(ag).catch((e) => {
        log('erro', `Caixa de ${ag.slug}: a volta falhou (${e && e.message}). Confira a casa ${ag.home_host}.`);
      }).finally(() => ocupados.delete(ag.slug)));
    }
    await Promise.all(tarefas);
  }

  function iniciar() {
    if (timer) return;
    timer = setInterval(() => { volta(); }, 1000);
    timer.unref();
  }

  function parar() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ── Web deixando arquivo na casa do agente ─────────────────────────────────
  function agenteOuErro(agente) {
    const a = typeof agente === 'string' ? registro.obter(agente) : agente;
    if (!a || !a.home_host) throw new ErroGravacao(`Não achei a casa do agente ${JSON.stringify(typeof agente === 'string' ? agente : agente && agente.slug)}: ele não existe ou não tem home_host no registro.`, 'SEM_CASA');
    return a;
  }

  function gravaNaCasa(agente, relPath, objeto) {
    const ag = agenteOuErro(agente);
    if (typeof relPath !== 'string' || !RX_REL.test(relPath) || relPath.includes('..')) {
      throw new ErroGravacao(`O caminho ${JSON.stringify(relPath)} não vale: use só a-z, 0-9, ponto, sublinhado e hífen, separados por barras, sem "..", sem começar por barra.`, 'OPCAO_INVALIDA');
    }
    let st;
    try { st = fs.statSync(ag.home_host); } catch (e) {
      throw new ErroGravacao(`Não consegui ler a casa ${ag.home_host} do agente ${ag.slug} (${e.code || e.name}). Confira o home_host no registro.`, 'PASTA_AUSENTE');
    }
    if (st.uid === 0) throw new ErroGravacao(`A casa ${ag.home_host} de ${ag.slug} pertence ao root; recusei gravar ali. Confira o home_host no registro.`, 'CASA_DE_ROOT');
    const partes = ['.dgclaw', ...relPath.split('/')];
    let atual = fs.realpathSync(ag.home_host);
    for (const parte of partes.slice(0, -1)) {
      atual = path.join(atual, parte);
      let s;
      try { s = fs.lstatSync(atual); } catch (e) {
        if (e.code !== 'ENOENT') throw new ErroGravacao(`Não consegui conferir ${atual} (${e.code || e.name}).`, 'FALHA_ESCRITA');
        try { fs.mkdirSync(atual, { mode: 0o700 }); fs.chownSync(atual, st.uid, st.gid); fs.chmodSync(atual, 0o700); } catch (e2) {
          throw new ErroGravacao(`Não consegui criar a pasta ${atual} (${e2.code || e2.name}).`, 'FALHA_ESCRITA');
        }
        continue;
      }
      if (s.isSymbolicLink() || !s.isDirectory()) throw new ErroGravacao(`${atual} é ${s.isSymbolicLink() ? 'um atalho' : 'algo que não é pasta'}; recusei gravar por ele.`, s.isSymbolicLink() ? 'ATALHO' : 'NAO_E_PASTA');
    }
    return gravaArquivoSeguro(path.join(atual, partes[partes.length - 1]), JSON.stringify(objeto, null, 2), {
      raiz: ag.home_host, uid: st.uid, gid: st.gid, modo: 0o600,
    });
  }

  function gravaRetrato(agente, frente, objeto) {
    if (typeof frente !== 'string' || !RX_FRENTE.test(frente)) {
      throw new ErroGravacao(`O nome da frente ${JSON.stringify(frente)} não vale para retrato: use de 1 a 40 caracteres entre a-z, 0-9 e hífen.`, 'OPCAO_INVALIDA');
    }
    return gravaNaCasa(agente, `retratos/${frente}.json`, Object.assign({}, objeto, { atualizado_em: new Date(relogio()).toISOString() }));
  }

  return {
    permitir, rotaPermitida, iniciar, parar, volta, gravaNaCasa, gravaRetrato, ehPedidoDaCaixa,
    get segredo() { return segredo; },
  };
}

module.exports = { criarCaixaAgente, quemChamou, ErroGravacao };
