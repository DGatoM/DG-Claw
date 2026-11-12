'use strict';
// Conta de IA do agente conectada pelo colaborador (web/docs/COLABORADORES.md, "Se o agente ainda não tem IA conectada").
//
// O escopo (escopo.js) deixa o colaborador do próprio slug chegar às rotas /api/v1/agents/<dele>/login*. O portão de
// verdade é este módulo, no servidor, e na dúvida ele recusa:
//   - o colaborador só conecta quando o agente está SEM conta de verdade (e não usa chave de API);
//   - login expirado só é dele se foi ele quem conectou essa conta (registro conta-agentes.json);
//   - uma reserva por agente (em memória, 15 min) impede duas pessoas de misturarem link e código;
//   - o GET do colaborador devolve só uma lista de campos permitidos: nada de conferido, e-mail da conta, auth;
//   - link e código só aparecem para quem tem a reserva em andamento.
// Link, código e senha nunca vão para o log.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { instanciaDe } = require('./instancia');

const VALIDADE_RESERVA_MS = 15 * 60 * 1000;
const SEGURA_MAX_MS = 10 * 60 * 1000;
const CAMPOS_DO_LOGIN = ['estado', 'link', 'codigoDispositivo', 'mensagem'];
const EM_ANDAMENTO = new Set(['aguardando_link', 'aguardando_codigo', 'aguardando_navegador']);
const usaChaveDeApi = (auth) => /^(api|token)$/i.test(String(auth || ''));

const MSG_OCUPADO = 'Outra pessoa está conectando a conta deste agente agora. Espere ela terminar (no máximo 15 minutos) ou avise o dono do DG Claw.';
const MSG_DONO_OCUPADO = (email) => `O colaborador ${email} está conectando a conta deste agente agora. Espere ele terminar ou toque em Cancelar para tomar a vez.`;
const MSG_SEM_RESERVA = 'Você não tem um login em andamento neste agente. Toque em "Gerar link de login" primeiro.';
const MSG_JA_CONECTADO = 'Este agente já está conectado. Nada foi enviado.';
const MSG_EXPIRADO = 'A conta deste agente expirou e só o dono do DG Claw reconecta. Peça ao dono para reconectar em Conectar conta.';
const MSG_CHAVE_API = 'Este agente usa chave de API, não conta de assinatura. Não há conta para conectar.';

function criarContaColaborador({ dataDir, login, log, agora, escreveArquivo }) {
  const escreve = escreveArquivo || ((caminho, texto, opcoes) => fs.writeFileSync(caminho, texto, opcoes));
  const relogio = agora || (() => Date.now());
  const arquivo = path.join(dataDir, 'conta-agentes.json');
  let regs = {};
  let mtimeVisto = -1;
  let ilegivel = null;
  let filaGrava = Promise.resolve();
  const reservas = new Map();   // slug -> { tipo, id, email, desde, codigoEnviado }
  const filas = new Map();      // slug -> promessa encadeada

  const erro = (status, motivo, extra) => ({ status, corpo: Object.assign({ ok: false, erro: motivo }, extra || {}) });

  // ── registro durável ───────────────────────────────────────────────────────
  function carrega() {
    let st;
    try { st = fs.statSync(arquivo); } catch (e) {
      if (e.code === 'ENOENT') { regs = {}; ilegivel = null; mtimeVisto = 0; return; }
      if (mtimeVisto !== -2) log('erro', `Não consegui acessar ${arquivo} (${e.code || e.message}). Sem esse registro, toda conta de IA conta como do dono (o colaborador não reconecta login expirado). Confira a permissão de ${dataDir}.`);
      regs = {}; ilegivel = `${e.code || e.message}`; mtimeVisto = -2;
      return;
    }
    if (st.mtimeMs === mtimeVisto) return;
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (!j || typeof j !== 'object' || !j.agentes || typeof j.agentes !== 'object' || Array.isArray(j.agentes)) throw new Error('o conteúdo não tem o objeto "agentes"');
      regs = j.agentes;
      ilegivel = null;
    } catch (e) {
      regs = {};
      ilegivel = e.message;
      log('erro', `O arquivo ${arquivo} está ilegível (${e.message}). Trato toda conta de IA como do dono e NÃO vou regravar o arquivo. Corrija o JSON ou renomeie o arquivo para recomeçar.`);
    }
    mtimeVisto = st.mtimeMs;
  }

  function gravaArquivo(conteudo) {
    const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
      escreve(tmp, JSON.stringify({ versao: 1, agentes: conteudo }, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, arquivo);
      mtimeVisto = fs.statSync(arquivo).mtimeMs;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* o temporário nem chegou a existir */ }
      throw new Error(`não consegui gravar ${arquivo} (${e.code || e.message})`);
    }
  }

  /** Grava em fila, numa gravação só (valor undefined apaga a chave). Lança se não conseguir. */
  function grava(mudancas) {
    const p = filaGrava.then(() => {
      carrega();
      if (ilegivel) throw new Error(`o arquivo está ilegível (${ilegivel})`);
      // Muda uma cópia e só adota depois de gravar: com disco cheio a memória não pode ficar "já apagada".
      const copia = Object.assign({}, regs);
      for (const [k, v] of Object.entries(mudancas)) { if (v === undefined) delete copia[k]; else copia[k] = v; }
      gravaArquivo(copia);
      regs = copia;
    });
    filaGrava = p.catch(() => undefined);
    return p;
  }
  const kPend = (slug) => `${slug}:pendente`;

  /** O registro desta INSTÂNCIA do agente (um agente recriado com o mesmo nome começa sem registro). */
  function registroDe(agente) {
    carrega();
    const r = regs[agente.slug];
    const inst = instanciaDe(agente);
    return r && inst && r.instancia === inst ? r : null;
  }
  /** A tentativa em andamento (gravada ANTES de o colaborador iniciar o login, para a revogação conseguir reconciliar). */
  function pendenteDe(agente) {
    carrega();
    const r = regs[kPend(agente.slug)];
    const inst = instanciaDe(agente);
    return r && inst && r.instancia === inst ? r : null;
  }
  /** A autoria vale só para o provedor em que foi feita: dono que trocou Claude por Codex (ou o contrário) a invalida. */
  const foiDele = (reg, q, provedorAtual) => !!reg && q.tipo === 'colaborador' && reg.por === 'colaborador' && reg.colaborador_id === q.id
    && !!reg.provedor && reg.provedor === provedorAtual;

  // ── fila e reserva por agente ───────────────────────────────────────────────
  function emFila(slug, fn) {
    const anterior = filas.get(slug) || Promise.resolve();
    const p = anterior.then(fn);
    const marca = p.catch(() => undefined);
    filas.set(slug, marca);
    marca.then(() => { if (filas.get(slug) === marca) filas.delete(slug); });
    return p;
  }

  function reservaViva(slug) {
    const r = reservas.get(slug);
    if (!r) return null;
    if (relogio() - r.desde >= VALIDADE_RESERVA_MS) {
      reservas.delete(slug);
      log('info', `A reserva de login do agente ${slug} (de ${r.email}) venceu depois de 15 minutos e foi solta.`);
      return null;
    }
    return r;
  }
  const quem = (sessao) => (sessao && sessao.papel === 'colaborador'
    ? { tipo: 'colaborador', id: sessao.colaborador_id, email: sessao.usuario }
    : { tipo: 'dono', id: String(sessao && sessao.usuario || 'dono'), email: String(sessao && sessao.usuario || 'dono') });
  const mesma = (r, q) => !!r && r.tipo === q.tipo && r.id === q.id;

  // ── o que a consulta ao runner quer dizer ───────────────────────────────────
  /** 'sem_conta' | 'conectado' | 'expirado' | 'chave_api' | 'duvida'. Qualquer lacuna na informação é 'duvida'. */
  function situacao(c) {
    if (!c.est.ok) return { tipo: 'duvida', motivo: 'não consegui ver o estado do agente' };
    if (!c.prov.auth) return { tipo: 'duvida', motivo: 'o agente não respondeu sobre a forma de pagamento da IA' };
    if (usaChaveDeApi(c.prov.auth)) return { tipo: 'chave_api' };
    const { status, statusReason } = c.est.estado;
    if (status === 'errored' && statusReason === 'runner:login-expirado') return { tipo: 'expirado' };
    const conf = c.prov.conferido;
    // "Sem conta" exige a prova da conferência (`ok:false` com `motivo:'sem_credencial'`). O estado operacional do agente
    // (`runner:sem-login`) sozinho nunca autoriza: com a conferência inconclusiva ou contraditória é dúvida.
    if (status === 'errored' && statusReason === 'runner:sem-login' && conf && conf.ok === true) {
      return { tipo: 'duvida', motivo: 'o agente deu sinais contraditórios sobre a conta' };
    }
    // `ok:false` também sai quando o CLI demora, responde algo ilegível ou usa outro método: isso NÃO prova que falta conta.
    // Só o runner dizendo `motivo:'sem_credencial'` prova (runner antigo, sem o campo, cai na dúvida).
    if (conf && conf.ok === false && conf.motivo === 'sem_credencial') return { tipo: 'sem_conta' };
    if (conf && conf.ok === true) return { tipo: 'conectado' };
    return { tipo: 'duvida', motivo: 'o agente não confirmou se a conta está conectada' };
  }

  /**
   * Situação do ponto de vista do colaborador. Credencial presente, mesmo vencida e mesmo com autoria registrada dele,
   * nunca vira "sem conta": o registro não prova que a credencial atual é a que ele conectou (o dono pode tê-la trocado).
   */
  const situacaoPara = (c) => situacao(c);

  /** Como situacaoPara, mas só vale com a conferência refeita sem cache (`c` vem de login.consultarFresco). */
  function situacaoFresca(c, agente, q) {
    if (!c.fresco) return { tipo: 'duvida', atualizar: true, motivo: 'o programa deste agente é de uma versão antiga e não refaz a conferência na hora' };
    return situacaoPara(c);
  }

  function recusaPorSituacao(s) {
    if (s.atualizar) return erro(503, 'O programa deste agente ainda é de uma versão antiga e, por segurança, não deixa o colaborador conectar a conta. Avise o dono do DG Claw para atualizar (comando "dgclaw atualizar", que recria o agente com a versão nova).');
    switch (s.tipo) {
      case 'conectado': return erro(409, MSG_JA_CONECTADO);
      case 'expirado': return erro(403, MSG_EXPIRADO);
      case 'chave_api': return erro(409, MSG_CHAVE_API);
      default: return erro(503, `Não consegui confirmar que este agente está sem conta (${s.motivo || 'sem resposta clara do agente'}), então não deixo conectar agora. Tente de novo em instantes; se continuar, avise o dono do DG Claw.`);
    }
  }

  /** Grava quem conectou a conta atual do agente e encerra a tentativa pendente. Falhar aqui é seguro: sem registro, a conta é do dono. */
  async function registra(agente, valor, quemTexto) {
    const inst = instanciaDe(agente);
    if (!inst) { log('aviso', `Conta de IA do agente ${agente.slug} conectada, mas não consegui identificar a instância do agente para registrar quem conectou. Ela conta como do dono.`); return; }
    try {
      await grava({ [agente.slug]: Object.assign({ instancia: inst, em: relogio() }, valor), [kPend(agente.slug)]: undefined });
      log('info', `Conta de IA do agente ${agente.slug} conectada por ${quemTexto}.`);
    } catch (e) {
      log('erro', `Conta de IA do agente ${agente.slug} conectada por ${quemTexto}, mas não consegui registrar quem foi (${e.message}). Ela conta como do dono.`);
    }
  }

  /**
   * O dono vai começar um login: a autoria de qualquer colaborador sobre a conta deste agente (e a tentativa pendente dele)
   * deixa de valer ANTES de o login começar. É gravação durável: se não der para gravar, o login não começa.
   * Devolve null (pode seguir) ou o erro 503 que explica.
   */
  async function invalidaAutoria(agente) {
    carrega();
    if (ilegivel) return erro(503, `Não consegui conferir quem conectou a conta deste agente: o arquivo ${arquivo} está ilegível (${ilegivel}). Corrija o JSON ou renomeie o arquivo e tente de novo. O login não foi iniciado.`);
    if (!regs[agente.slug] && !regs[kPend(agente.slug)]) return null;
    try { await grava({ [agente.slug]: undefined, [kPend(agente.slug)]: undefined }); return null; } catch (e) {
      log('erro', `Não consegui apagar o registro de quem conectou a conta do agente ${agente.slug} (${e.message}). O login não foi iniciado, para o colaborador antigo não poder reconectar esta conta depois.`);
      return erro(503, `Não consegui apagar o registro de quem conectou a conta deste agente (${e.message}). Confira o espaço em disco e a permissão da pasta ${dataDir}. O login não foi iniciado.`);
    }
  }

  /** Grava a tentativa do colaborador antes de o login começar. Devolve null ou o erro 503. */
  async function gravaPendente(agente, q, provedor) {
    const inst = instanciaDe(agente);
    if (!inst) return erro(503, 'Não consegui identificar esta instância do agente para registrar a tentativa de login, então não iniciei. Avise o dono do DG Claw.');
    try { await grava({ [kPend(agente.slug)]: { instancia: inst, por: 'colaborador', colaborador_id: q.id, email: q.email, em: relogio(), pendente: true, provedor } }); return null; } catch (e) {
      log('erro', `Não registrei a tentativa de login de ${q.email} no agente ${agente.slug} (${e.message}); o login não foi iniciado.`);
      return erro(503, `Não consegui registrar a tentativa de login (${e.message}), então não iniciei. Avise o dono do DG Claw (disco ou permissão da pasta de dados do Web).`);
    }
  }
  /** A tentativa deste colaborador terminou sem conta: apaga o rastro (sem falhar a operação se não der). */
  async function limpaPendente(agente, id) {
    const pend = pendenteDe(agente);
    if (!pend || pend.colaborador_id !== id) return;
    try { await grava({ [kPend(agente.slug)]: undefined }); } catch (e) { log('aviso', `Não consegui apagar a tentativa pendente do agente ${agente.slug} (${e.message}); ela só vale para a revogação avisar o dono.`); }
  }

  /**
   * Cancela o login no runner e reconcilia a tentativa pendente do colaborador `colabId` com a conferência SEM cache feita
   * depois do cancelamento (cancelar não remove uma credencial já gravada). Conta presente: grava a autoria dele.
   * Dúvida (conferência falhou ou o runner é antigo): mantém a tentativa pendente. Ausência comprovada: apaga o rastro.
   * É o único lugar que apaga a tentativa depois de um cancelamento. Devolve { res, conta } com o resultado do cancelamento.
   */
  async function cancelaEReconcilia(agente, colabId) {
    const res = await login.cancelar(agente);
    if (res.status >= 300 || !colabId) return { res, conta: false };
    const pend = pendenteDe(agente);
    if (!pend || pend.colaborador_id !== colabId) return { res, conta: false };
    let situ = null; let motivo = '';
    let c = null;
    try { c = await login.consultarFresco(agente); } catch (e) { motivo = e.message; }
    if (c && !c.lg.ok) { motivo = c.lg.erro || 'o runner não respondeu'; c = null; }
    if (c) {
      if (!c.fresco) motivo = 'o runner é de versão antiga e não refaz a conferência na hora';
      else { const t = situacao(c); if (t.tipo === 'duvida') motivo = t.motivo; else situ = t; }
    }
    if (situ && (situ.tipo === 'conectado' || situ.tipo === 'expirado')) {
      await registra(agente, { por: 'colaborador', colaborador_id: colabId, email: pend.email, provedor: c.prov.provedor }, `${pend.email} (colaborador)`);
      return { res, conta: true };
    }
    if (!situ) {
      log('aviso', `Cancelei o login de ${pend.email} no agente ${agente.slug}, mas não consegui confirmar se a conta entrou (${motivo}). A tentativa continua registrada para a revogação avisar o dono.`);
      return { res, conta: false };
    }
    await limpaPendente(agente, colabId);
    return { res, conta: false };
  }

  /**
   * O GET observa o estado. A reserva só se resolve com conclusão COMPROVADA daquela tentativa: o runner diz `concluido`,
   * ou o código foi enviado e o login não está mais em andamento (nem falhou). Enquanto o login está em andamento a
   * credencial antiga pode ser a que está conectada, então a reserva fica.
   */
  /** A tentativa começou num provedor e a conta que apareceu é de outro: não é dele, então não se registra autoria. */
  async function descartaPorTrocaDeProvedor(agente, email, de, para, colabId) {
    log('aviso', `${email} começou a conectar a conta do agente ${agente.slug} no ${de}, mas o provedor do agente passou a ser ${para} antes de a conta entrar. A conta atual não foi registrada como dele.`);
    await limpaPendente(agente, colabId);
  }

  async function observaConclusao(agente, c, s) {
    const estado = c.lg.ok && c.lg.corpo ? c.lg.corpo.estado : undefined;
    const andamento = EM_ANDAMENTO.has(estado);
    const r = reservaViva(agente.slug);
    if (r) {
      if (andamento || s.tipo !== 'conectado') return;
      reservas.delete(agente.slug);
      if (!(estado === 'concluido' || (r.codigoEnviado && estado !== 'falhou'))) {
        if (r.tipo === 'colaborador') await limpaPendente(agente, r.id);
        return;
      }
      if (r.tipo === 'colaborador' && r.provedor && r.provedor !== c.prov.provedor) {
        await descartaPorTrocaDeProvedor(agente, r.email, r.provedor, c.prov.provedor, r.id);
        return;
      }
      await registra(agente, { por: r.tipo, colaborador_id: r.tipo === 'colaborador' ? r.id : null, email: r.email, provedor: c.prov.provedor }, `${r.email} (${r.tipo})`);
      return;
    }
    // Tentativa de colaborador já revogado que o runner não deixou cancelar: se a conta entrar, a autoria não fica sem dono.
    const p = pendenteDe(agente);
    if (!p || !p.revogado || andamento) return;
    if (s.tipo === 'conectado' && estado !== 'falhou') {
      if (p.provedor && p.provedor !== c.prov.provedor) { await descartaPorTrocaDeProvedor(agente, p.email, p.provedor, c.prov.provedor, p.colaborador_id); return; }
      await registra(agente, { por: 'colaborador', colaborador_id: p.colaborador_id, email: p.email, revogado: true, provedor: c.prov.provedor }, `${p.email} (colaborador já revogado)`);
      log('aviso', `A conta de IA do agente ${agente.slug} foi conectada por ${p.email} depois de o acesso dele ser revogado. Se quiser trocar, entre com a sua conta em Conectar conta.`);
    } else if (s.tipo === 'sem_conta') await limpaPendente(agente, p.colaborador_id);
  }

  const filtraLogin = (corpo, extra) => {
    const out = { ok: true };
    for (const k of CAMPOS_DO_LOGIN) if (corpo && corpo[k] !== undefined) out[k] = corpo[k];
    return Object.assign(out, extra || {});
  };
  const filtraResultado = (r, q) => {
    if (q.tipo === 'dono') return r;
    if (r.status >= 300 || !r.corpo || r.corpo.ok === false) return { status: r.status, corpo: { ok: false, erro: (r.corpo && r.corpo.erro) || 'O agente recusou o pedido.' } };
    return { status: r.status, corpo: filtraLogin(r.corpo) };
  };

  // ── operações ───────────────────────────────────────────────────────────────
  function ver(agente, sessao) {
    const q = quem(sessao);
    return emFila(agente.slug, async () => {
      const c = await login.consultar(agente);
      if (!c.lg.ok) return login.falha(agente, c.lg, 'consulta');
      const s = situacao(c);
      await observaConclusao(agente, c, s);
      const r = reservaViva(agente.slug);
      const corpo = login.corpoDaConsulta(c);
      if (q.tipo === 'dono') {
        if (r && r.tipo === 'colaborador') {
          delete corpo.link; delete corpo.codigoDispositivo;
          return { status: 200, corpo: Object.assign(corpo, { login_de: 'colaborador', login_de_email: r.email }) };
        }
        return { status: 200, corpo };
      }
      const sc = situacaoPara(c);
      const provedor = corpo.provedor;
      if (sc.tipo === 'duvida') return recusaPorSituacao(sc);
      if (sc.tipo === 'conectado') return { status: 200, corpo: { ok: true, conectado: true, precisa_login: false, provedor } };
      if (sc.tipo === 'chave_api') return { status: 200, corpo: { ok: true, conectado: false, precisa_login: false, chave_api: true, provedor, mensagem: MSG_CHAVE_API } };
      if (sc.tipo === 'expirado') return { status: 200, corpo: { ok: true, conectado: false, precisa_login: false, login_expirado: true, so_dono: true, provedor, mensagem: MSG_EXPIRADO } };
      // sem conta
      const dele = mesma(r, q);
      const andamentoDeOutro = (!r && EM_ANDAMENTO.has(corpo.estado)) || (r && !dele);
      if (andamentoDeOutro) return { status: 200, corpo: { ok: true, conectado: false, precisa_login: true, ocupado: true, estado: 'nenhum', provedor, mensagem: MSG_OCUPADO } };
      const base = dele ? filtraLogin(corpo) : { ok: true, estado: 'nenhum' };
      return { status: 200, corpo: Object.assign(base, { conectado: false, precisa_login: true, provedor }) };
    });
  }

  function comecar(agente, sessao, corpoPedido, aindaVale) {
    const q = quem(sessao);
    return emFila(agente.slug, async () => {
      const antes = reservaViva(agente.slug);
      let provedorInicio;
      if (q.tipo === 'dono') {
        if (antes && antes.tipo === 'colaborador') return erro(409, MSG_DONO_OCUPADO(antes.email));
      } else {
        const c = await login.consultar(agente);
        if (!c.lg.ok) return login.falha(agente, c.lg, 'consulta');
        const s = situacaoPara(c);
        if (s.tipo !== 'sem_conta') return recusaPorSituacao(s);
        const atual = reservaViva(agente.slug);
        if (atual && !mesma(atual, q)) return erro(409, MSG_OCUPADO);
        if (!atual && EM_ANDAMENTO.has(c.lg.corpo && c.lg.corpo.estado)) return erro(409, MSG_OCUPADO);
      }
      if (aindaVale && !aindaVale()) return { sessaoVelha: true };
      if (q.tipo === 'colaborador') {
        // Imediatamente antes de iniciar, SEM cache (nem o do estado, nem o da conferência do CLI): ainda está sem conta?
        const c2 = await login.consultarFresco(agente);
        if (!c2.lg.ok) return login.falha(agente, c2.lg, 'consulta');
        const s2 = situacaoFresca(c2, agente, q);
        if (s2.tipo !== 'sem_conta') return recusaPorSituacao(s2);
        const atual2 = reservaViva(agente.slug);
        if (atual2 && !mesma(atual2, q)) return erro(409, MSG_OCUPADO);
        if (aindaVale && !aindaVale()) return { sessaoVelha: true };
        provedorInicio = c2.prov.provedor;
        const falhaPendente = await gravaPendente(agente, q, provedorInicio);
        if (falhaPendente) return falhaPendente;
      } else {
        const falhaInvalida = await invalidaAutoria(agente);
        if (falhaInvalida) return falhaInvalida;
      }
      const nova = !mesma(reservaViva(agente.slug), q);
      if (nova) reservas.set(agente.slug, { tipo: q.tipo, id: q.id, email: q.email, desde: relogio(), codigoEnviado: false, provedor: provedorInicio });
      const r = await login.comecar(agente, corpoPedido);
      if (r.status >= 300 && nova && mesma(reservas.get(agente.slug), q)) {
        reservas.delete(agente.slug);
        if (q.tipo === 'colaborador') await limpaPendente(agente, q.id);
      }
      return filtraResultado(r, q);
    });
  }

  function enviarCodigo(agente, sessao, corpoPedido, aindaVale) {
    const q = quem(sessao);
    return emFila(agente.slug, async () => {
      const r = reservaViva(agente.slug);
      if (q.tipo === 'dono') {
        if (r && r.tipo === 'colaborador') return erro(409, MSG_DONO_OCUPADO(r.email));
      } else {
        if (r && !mesma(r, q)) return erro(409, MSG_OCUPADO);
        if (!r) return erro(403, MSG_SEM_RESERVA);
        // Imediatamente antes de mandar ao runner: a conta ainda está ausente?
        const c = await login.consultarFresco(agente);
        if (!c.lg.ok) return login.falha(agente, c.lg, 'consulta');
        const s = situacaoFresca(c, agente, q);
        if (s.tipo === 'conectado') {
          // A conta apareceu por fora da tentativa dele: solta a reserva e o rastro, sem registrar autoria.
          if (mesma(reservas.get(agente.slug), q)) reservas.delete(agente.slug);
          await limpaPendente(agente, q.id);
          return erro(409, MSG_JA_CONECTADO);
        }
        if (s.tipo !== 'sem_conta') return recusaPorSituacao(s);
        if (!mesma(reservaViva(agente.slug), q)) return erro(409, MSG_OCUPADO);
      }
      if (aindaVale && !aindaVale()) return { sessaoVelha: true };
      const res = await login.enviarCodigo(agente, corpoPedido);
      if (res.status < 300) {
        const atual = reservaViva(agente.slug);
        if (mesma(atual, q)) atual.codigoEnviado = true;
        else if (!atual) reservas.set(agente.slug, { tipo: q.tipo, id: q.id, email: q.email, desde: relogio(), codigoEnviado: true });
      }
      return filtraResultado(res, q);
    });
  }

  function cancelar(agente, sessao) {
    const q = quem(sessao);
    return emFila(agente.slug, async () => {
      const r = reservaViva(agente.slug);
      if (q.tipo === 'colaborador' && !mesma(r, q)) return erro(403, 'Você só pode cancelar o login que você mesmo começou. Se for de outra pessoa, avise o dono do DG Claw.');
      const { res } = await cancelaEReconcilia(agente, r && r.tipo === 'colaborador' ? r.id : null);
      if (res.status < 300) reservas.delete(agente.slug);
      return filtraResultado(res, q);
    });
  }

  function oi(agente, sessao) {
    const q = quem(sessao);
    if (q.tipo !== 'colaborador') return login.primeiroOi(agente).then((r) => filtraResultado(r, q));
    return emFila(agente.slug, async () => {
      let ok = mesma(reservaViva(agente.slug), q);
      if (!ok) {
        const c = await login.consultar(agente);
        ok = foiDele(registroDe(agente), q, c.prov.provedor);
      }
      if (!ok) return erro(403, 'O primeiro oi só sai para quem conectou a conta deste agente.');
      return filtraResultado(await login.primeiroOi(agente), q);
    });
  }

  /** Contas de IA que este colaborador conectou (para avisar o dono quando o acesso dele é revogado). */
  function contasDe(colaboradorId) {
    carrega();
    return Object.entries(regs).filter(([k, r]) => !k.endsWith(':pendente') && r && r.por === 'colaborador' && r.colaborador_id === colaboradorId)
      .map(([agente, r]) => ({ agente, em: r.em }));
  }

  /**
   * Revogado (ou convite reenviado, que derruba as sessões). Para cada agente em que ele tem reserva ou tentativa pendente,
   * pela fila do agente: consulta o runner SEM cache, cancela a autenticação pendente e só então solta a reserva. Cancelar
   * não prova que não há conta (a credencial pode já ter sido gravada), então reconcilia: conta conectada e tentativa
   * dele grava a autoria com `revogado:true`; estado que não dá para confirmar deixa a tentativa marcada e avisa o dono.
   * Tentativa pendente sem reserva (depois de um restart) é dúvida. Devolve { avisos, agentes }: `agentes` são os agentes
   * cuja conta pode ser dele (para `contas_de_ia`). A conta já conectada nunca é desconectada.
   */
  async function encerraPendencias(colaboradorId, obterAgente) {
    carrega();
    const avisos = []; const agentes = [];
    const slugs = new Set();
    for (const [slug, r] of reservas) if (r.tipo === 'colaborador' && r.id === colaboradorId) slugs.add(slug);
    for (const [k, r] of Object.entries(regs)) if (k.endsWith(':pendente') && r && r.colaborador_id === colaboradorId) slugs.add(k.slice(0, -':pendente'.length));
    for (const slug of slugs) {
      await emFila(slug, async () => {
        const agente = obterAgente(slug);
        const r = reservas.get(slug);
        const dele = !!r && r.tipo === 'colaborador' && r.id === colaboradorId;
        const pend = agente ? pendenteDe(agente) : null;
        const email = (dele && r.email) || (pend && pend.email) || colaboradorId;
        const confira = `Confira a conta de IA do agente ${slug} em Conectar conta (troque-a se quiser).`;
        if (!agente) { if (dele) reservas.delete(slug); avisos.push(`${email} tinha um login pendente no agente ${slug}, que não está mais no registro.`); return; }
        const confere = async () => {
          let cc = null; let mot = '';
          try {
            cc = await login.consultarFresco(agente);
            if (!cc.lg.ok) { mot = cc.lg.erro || 'o runner não respondeu'; cc = null; }
          } catch (e) { mot = e.message; cc = null; }
          let sit = null;
          if (cc) {
            sit = cc.fresco ? situacao(cc) : { tipo: 'duvida', motivo: 'o runner é de versão antiga e não refaz a conferência na hora' };
            if (sit.tipo === 'duvida') { mot = sit.motivo; sit = null; }
          }
          return { c: cc, situ: sit, motivo: mot };
        };
        let { c, situ, motivo } = await confere();
        const estado = c && c.lg.corpo ? c.lg.corpo.estado : undefined;
        let cancelFalhou = '';
        if (dele || (pend && (!c || EM_ANDAMENTO.has(estado)))) {
          try {
            const res = await login.cancelar(agente);
            if (res.status >= 300) cancelFalhou = (res.corpo && res.corpo.erro) || `HTTP ${res.status}`;
          } catch (e) { cancelFalhou = e.message; }
        }
        if (dele && reservas.get(slug) === r) reservas.delete(slug);
        // O colaborador pode ter concluído o login entre a conferência e o cancelamento, e cancelar não remove uma
        // credencial já gravada: reconfere depois, e se entrou conta (ou não dá para saber) a tentativa não é apagada.
        let aposCancelar = false;
        if (pend && !cancelFalhou && situ && !(situ.tipo === 'conectado' || situ.tipo === 'expirado')) {
          const depois = await confere();
          c = depois.c; situ = depois.situ; motivo = depois.motivo;
          aposCancelar = true;
        }
        if (cancelFalhou) {
          log('aviso', `Não consegui cancelar o login pendente de ${email} no agente ${slug} (${cancelFalhou}). Ele pode concluir a tentativa mesmo revogado; se a conta entrar, ela fica registrada como dele.`);
          avisos.push(`Não consegui cancelar o login que ${email} deixou em andamento no agente ${slug} (${cancelFalhou}). Cancele pelo botão Cancelar em Conectar conta. ${confira}`);
        }
        const existe = situ && (situ.tipo === 'conectado' || situ.tipo === 'expirado');
        if (existe && pend) {
          await registra(agente, { por: 'colaborador', colaborador_id: colaboradorId, email, revogado: true, provedor: c.prov.provedor }, `${email} (colaborador já revogado)`);
          avisos.push(aposCancelar
            ? `A conta do colaborador ${email} continua conectada no agente ${slug}: o login dele terminou enquanto o acesso era revogado, e cancelar não desconecta uma conta que já entrou. Para trocá-la, desconecte pela página Conectar conta.`
            : `O agente ${slug} está com conta conectada e ${email} tinha uma tentativa de login em andamento: a conta pode ser a dele. ${confira}`);
          agentes.push(slug);
        } else if (!situ || cancelFalhou) {
          if (pend) { try { await grava({ [kPend(slug)]: Object.assign({}, pend, { revogado: true }) }); } catch (e) { log('erro', `Não consegui marcar a tentativa revogada de ${email} no agente ${slug} (${e.message}).`); } }
          if (!cancelFalhou) avisos.push(`Não consegui confirmar o estado da conta do agente ${slug} (${motivo}) depois de revogar ${email}. ${confira}`);
          agentes.push(slug);
        } else {
          await limpaPendente(agente, colaboradorId);
          log('info', `Login pendente de ${email} no agente ${slug} cancelado porque o acesso dele terminou.`);
        }
      });
    }
    return { avisos, agentes };
  }

  /**
   * O dono mexe no login pelo painel do agente (POST/DELETE /p/<slug>/api/provedor/login[/codigo]), que não passa pelas
   * rotas acima. Chamado pelo Web antes do proxy: respeita a reserva do colaborador (409), invalida a autoria dele quando o
   * dono começa e acompanha a reserva do dono. Devolve null para seguir ao proxy, ou { status, corpo } para recusar.
   */
  function noPainelDoDono(agente, sessao, metodo, codigo) {
    const q = quem(sessao);
    return emFila(agente.slug, async () => {
      const r = reservaViva(agente.slug);
      if (r && r.tipo === 'colaborador' && metodo !== 'DELETE') return erro(409, MSG_DONO_OCUPADO(r.email));
      if (metodo === 'DELETE') {
        // O cancelamento real segue pelo proxy; aqui ele é feito antes só para reconciliar a tentativa do colaborador.
        if (r && r.tipo === 'colaborador') await cancelaEReconcilia(agente, r.id);
        reservas.delete(agente.slug);
        return null;
      }
      if (codigo) {
        const atual = reservaViva(agente.slug);
        if (mesma(atual, q)) atual.codigoEnviado = true;
        else reservas.set(agente.slug, { tipo: q.tipo, id: q.id, email: q.email, desde: relogio(), codigoEnviado: true });
        return null;
      }
      const falhaInvalida = await invalidaAutoria(agente);
      if (falhaInvalida) return falhaInvalida;
      if (!mesma(reservaViva(agente.slug), q)) reservas.set(agente.slug, { tipo: q.tipo, id: q.id, email: q.email, desde: relogio(), codigoEnviado: false });
      return null;
    });
  }

  /**
   * O dono muda algo do provedor pelo painel (POST/PUT/PATCH/DELETE em /p/<slug>/api/provedor, fora do /login): trocar de IA
   * ou de forma de pagar. A autoria do colaborador deixa de valer (gravação durável, 503 se falhar), e não se mexe no
   * provedor enquanto um colaborador está conectando. Mantém a exclusão por TODA a operação encaminhada ao painel do agente: a fila do agente
   * só é liberada quando quem chamou chama `liberar()` (fim da resposta, erro ou conexão fechada). Assim nenhum colaborador
   * começa nem conclui um login enquanto o provedor está mudando. Devolve { veto } ou { liberar }; sem `liberar` a fila
   * se destrava sozinha depois de SEGURA_MAX_MS.
   */
  function seguraProvedorNoPainelDoDono(agente) {
    return new Promise((resolve) => {
      emFila(agente.slug, async () => {
        const r = reservaViva(agente.slug);
        const veto = r && r.tipo === 'colaborador' ? erro(409, MSG_DONO_OCUPADO(r.email)) : await invalidaAutoria(agente);
        if (veto) { resolve({ veto }); return; }
        await new Promise((fim) => {
          let timer = null;
          const liberar = () => { if (timer) clearTimeout(timer); timer = null; fim(); };
          timer = setTimeout(() => { log('aviso', `A troca de provedor do agente ${agente.slug} passou de ${SEGURA_MAX_MS / 60000} minutos; liberei a fila do login do colaborador.`); fim(); }, SEGURA_MAX_MS);
          if (timer.unref) timer.unref();
          resolve({ liberar });
        });
      });
    });
  }

  return { ver, comecar, enviarCodigo, cancelar, oi, contasDe, encerraPendencias, noPainelDoDono, seguraProvedorNoPainelDoDono, arquivo, VALIDADE_RESERVA_MS };
}

module.exports = { criarContaColaborador, VALIDADE_RESERVA_MS };
