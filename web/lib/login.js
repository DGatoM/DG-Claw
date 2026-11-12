'use strict';
// Login assistido na conversa: o Web repassa ao runner do agente as rotas /api/provedor/login
// (começar, conferir, mandar o código, cancelar) e faz o "primeiro oi" quando o agente fica pronto.
// O código colado e o link de login (que carrega o estado do OAuth) nunca vão para o log.

const { motivoDoRunner } = require('./runner');
const PROV = require('../public/provedores');

const RX_CODIGO_PROIBIDO = /[\s\x00-\x1f\x7f]/;
const MAX_CODIGO = 512;
const OI_PRAZO_PADRAO_MS = 60 * 1000;
const OI_PASSO_PADRAO_MS = 1500;
const OI_JANELA_MS = 10 * 60 * 1000;

const nomeDoProvedor = (p) => (/codex/i.test(String(p || '')) ? 'Codex' : 'Claude');

function criarLogin({ runner, conversa, log, agora, oiPrazoMs, oiPassoMs, provedores }) {
  const relogio = agora || (() => Date.now());
  const prazo = oiPrazoMs || OI_PRAZO_PADRAO_MS;
  const passo = oiPassoMs || OI_PASSO_PADRAO_MS;
  const oiFeito = new Map(); // slug -> quando o "oi" saiu (ou começou a sair)
  const erro = (status, motivo, extra) => ({ status, corpo: Object.assign({ ok: false, erro: motivo }, extra || {}) });

  /** Falha ao falar com o runner -> { status, corpo } no formato de erro da API. */
  function falha(agente, r, acao) {
    if (r.erro) {
      log('aviso', `Login de ${agente.slug}: ${acao} não chegou ao runner: ${r.erro}`);
      return erro(503, r.erro);
    }
    // 401/403 do runner são do token entre o Web e o runner, não da sessão da pessoa: se
    // passassem como estão, a tela entenderia "sessão expirada" e mandaria para o login.
    const status = r.status === 401 || r.status === 403 ? 502 : r.status;
    const motivo = motivoDoRunner(agente, r);
    log('aviso', `Login de ${agente.slug}: ${acao} recusado pelo runner (HTTP ${r.status}): ${motivo}`);
    return erro(status, motivo);
  }

  /** Provedor, forma de pagar e conferência, do runner. Se falhar, cai no registro (auth null). */
  async function sobreOProvedor(agente) {
    const r = await runner.provedor(agente, 3000);
    if (r.ok) {
      const d = r.dados;
      return { provedor: nomeDoProvedor(d.provedor).toLowerCase(), auth: typeof d.auth === 'string' ? d.auth : null, conferido: d.conferido && typeof d.conferido === 'object' ? d.conferido : null };
    }
    return { provedor: nomeDoProvedor(agente.provedor).toLowerCase(), auth: null, conferido: null };
  }

  /** As três consultas juntas (runner, provedor e estado). Quem decide o que mostrar é quem chama. */
  async function consultar(agente) {
    const [lg, prov, est] = await Promise.all([
      runner.pedir(agente, 'GET', '/api/provedor/login'),
      sobreOProvedor(agente),
      conversa.estado(agente),
    ]);
    return { lg, prov, est };
  }

  /**
   * Como consultar(), mas SEM nenhum cache: o estado do runner vai direto (sem o cache de 2 s) e a conferência do CLI é
   * refeita (`?fresco=1`, sem o cache de 60 s). `fresco` diz se o runner entendeu o pedido: runner antigo não manda o
   * campo, e então a conferência pode estar velha (quem decide trata como dúvida).
   */
  async function consultarFresco(agente) {
    const [lg, pr, est] = await Promise.all([
      runner.pedir(agente, 'GET', '/api/provedor/login'),
      runner.provedor(agente, 30000, true),
      runner.estado(agente),
    ]);
    const d = pr.ok ? pr.dados : null;
    const prov = pr.ok
      ? { provedor: nomeDoProvedor(d.provedor).toLowerCase(), auth: typeof d.auth === 'string' ? d.auth : null, conferido: d.conferido && typeof d.conferido === 'object' ? d.conferido : null }
      : { provedor: nomeDoProvedor(agente.provedor).toLowerCase(), auth: null, conferido: null };
    return { lg, prov, est, fresco: !!(d && d.fresco === true) };
  }

  /** O corpo de GET /login a partir do que consultar() trouxe (a consulta ao runner já deu certo). */
  function corpoDaConsulta({ lg, prov, est }) {
    const expirado = est.ok && est.estado.status === 'errored' && est.estado.statusReason === 'runner:login-expirado';
    const semLogin = expirado || (est.ok && est.estado.status === 'errored' && est.estado.statusReason === 'runner:sem-login');
    const precisa = semLogin || (prov.conferido != null && prov.conferido.ok === false);
    return Object.assign({}, lg.corpo, { ok: true, provedor: prov.provedor, auth: prov.auth, conferido: prov.conferido, precisa_login: precisa, login_expirado: expirado });
  }

  async function ver(agente) {
    const c = await consultar(agente);
    if (!c.lg.ok) return falha(agente, c.lg, 'consulta');
    return { status: 200, corpo: corpoDaConsulta(c) };
  }

  async function comecar(agente, corpo) {
    // A IA escolhida na tela. Sem `provedor` o comportamento é o de sempre. Com um que não é o do agente,
    // recusa: é neste ponto que a troca de IA vai entrar no futuro (hoje o agente usa a IA em que nasceu).
    const pedido = corpo && corpo.provedor;
    if (pedido !== undefined && pedido !== null && pedido !== '') {
      const prov = await sobreOProvedor(agente);
      const v = PROV.valida(pedido, prov.provedor, provedores);
      if (!v.ok) return erro(400, v.erro);
    }
    const r = await runner.pedir(agente, 'POST', '/api/provedor/login', {});
    if (!r.ok) return falha(agente, r, 'início');
    log('info', `Login de ${agente.slug} iniciado (estado: ${(r.corpo && r.corpo.estado) || 'desconhecido'}).`);
    return { status: r.status, corpo: Object.assign({}, r.corpo, { ok: true }) };
  }

  async function enviarCodigo(agente, corpo) {
    const bruto = corpo && corpo.codigo;
    const codigo = typeof bruto === 'string' ? bruto.trim() : '';
    if (!codigo) return erro(400, 'Falta o código: cole o texto que a página de login mostrou no fim, no campo "codigo". Nada foi enviado.');
    if (codigo.length > MAX_CODIGO) return erro(400, `O código tem ${codigo.length} caracteres e o limite é ${MAX_CODIGO}. Copie só o código que a página mostrou, sem o resto da tela. Nada foi enviado.`);
    if (RX_CODIGO_PROIBIDO.test(codigo)) return erro(400, 'O código tem espaço ou quebra de linha no meio. Copie só o código que a página mostrou, de uma vez, sem nada em volta. Nada foi enviado.');
    const r = await runner.pedir(agente, 'POST', '/api/provedor/login/codigo', { codigo });
    if (!r.ok) return falha(agente, r, 'envio do código');
    log('info', `Login de ${agente.slug}: código enviado ao runner.`);
    return { status: 200, corpo: { ok: true } };
  }

  async function cancelar(agente) {
    const r = await runner.pedir(agente, 'DELETE', '/api/provedor/login');
    if (!r.ok) return falha(agente, r, 'cancelamento');
    log('info', `Login de ${agente.slug} cancelado.`);
    return { status: 200, corpo: Object.assign({}, r.corpo, { ok: true }) };
  }

  /** Espera o runner ficar idle e entrega o pedido de "oi". No máximo um por agente a cada 10 min. */
  async function primeiroOi(agente) {
    const t = relogio();
    const anterior = oiFeito.get(agente.slug);
    if (anterior != null && t - anterior < OI_JANELA_MS) return { status: 200, corpo: { ok: true, ja_enviado: true } };
    oiFeito.set(agente.slug, t); // reserva já, para duas chamadas juntas não entregarem duas vezes
    const solta = () => { if (oiFeito.get(agente.slug) === t) oiFeito.delete(agente.slug); };
    try {
      const limite = Date.now() + prazo;
      let ultimo = 'sem resposta do runner';
      for (;;) {
        const e = await runner.estado(agente);
        if (e.ok) {
          if (e.estado.status === 'idle') break;
          ultimo = `o runner informa "${e.estado.status}"${e.estado.statusReason ? ` (${e.estado.statusReason})` : ''}`;
        } else ultimo = e.erro;
        if (Date.now() + passo >= limite) {
          solta();
          log('aviso', `Login de ${agente.slug}: o agente não ficou pronto em ${Math.round(prazo / 1000)} s (${ultimo}). Primeiro oi não enviado.`);
          return erro(504, `${agente.nome} não ficou pronto em ${Math.round(prazo / 1000)} s depois do login (${ultimo}). Confira a aba Status do agente; quando ele estiver pronto, escreva um oi na conversa.`);
        }
        await new Promise((resolve) => setTimeout(resolve, passo));
      }
      const prov = await sobreOProvedor(agente);
      // Recado da plataforma, não fala do dono: o <plataforma> some da thread (web/lib/thread.js)
      // e só a resposta do agente aparece. Mesmo envelope do primeiro boot do Admin (install.sh).
      const texto = `<plataforma recado="login-concluido" tipo="aviso" ts="${new Date(relogio()).toISOString()}">` +
        `A conta do ${nomeDoProvedor(prov.provedor)} deste agente acabou de ser conectada pela conversa. ` +
        'Este é um aviso da plataforma, não uma mensagem escrita pelo dono. ' +
        `Mande agora um oi curto para ele pelo chat ${agente.chat_id}, usando a ferramenta reply do dgchat: ` +
        'diga que já está pronto e pergunte em que pode ajudar.</plataforma>';
      const r = await conversa.entregar(agente, texto, { cru: true });
      if (r.status >= 300) { solta(); return r; }
      return { status: 200, corpo: Object.assign({}, r.corpo, { ja_enviado: false }) };
    } catch (e) {
      solta();
      throw e;
    }
  }

  return { ver, consultar, consultarFresco, corpoDaConsulta, falha, comecar, enviarCodigo, cancelar, primeiroOi };
}

module.exports = { criarLogin, nomeDoProvedor };
