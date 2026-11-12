'use strict';
// Rotas do colaborador: a API do dono (/api/v1/colaboradores...) e a troca de senha do próprio
// colaborador (/api/v1/eu/senha). Referência completa em web/docs/COLABORADORES.md.

const fs = require('node:fs');
const path = require('node:path');
const H = require('./http');
const { instanciaDe } = require('./instancia');

const RX_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SENHA_MIN = 10;
const SENHA_MAX = 128;
const JANELA_SENHA_MS = 15 * 60 * 1000;
const MAX_FALHAS_SENHA = 5;
const SO_DONO = 'Convidar e gerenciar colaboradores é só do dono do DG Claw, pelo painel.';

function criarColaboradoresRotas({ colaboradores, auth, registro, email, config, log, aoDerrubar, agora, conta }) {
  const relogio = agora || (() => Date.now());
  // Erros da senha atual na troca de senha: 5 em 15 min por colaborador e por IP.
  const falhasDeSenha = new Map();
  const bloqueioDe = (chaves) => {
    const t = relogio();
    let espera = 0;
    for (const k of chaves) {
      const lista = (falhasDeSenha.get(k) || []).filter((x) => t - x < JANELA_SENHA_MS);
      if (lista.length) falhasDeSenha.set(k, lista); else falhasDeSenha.delete(k);
      if (lista.length >= MAX_FALHAS_SENHA) espera = Math.max(espera, Math.ceil((lista[0] + JANELA_SENHA_MS - t) / 1000));
    }
    return espera;
  };
  const registraFalha = (chaves) => { const t = relogio(); for (const k of chaves) falhasDeSenha.set(k, [...(falhasDeSenha.get(k) || []), t]); };
  /** Derruba as sessões do colaborador e fecha as conexões abertas dele (o stream da conversa). */
  const derruba = (id) => { auth.encerraDoColaborador(id); if (aoDerrubar) aoDerrubar(id); };

  const fmtData = (ms) => new Intl.DateTimeFormat('pt-BR', { timeZone: config.tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));

  function textoDoConvite({ quem, nomeAgente, nomePessoa, link, usuario, senha, expira }) {
    return [
      `Olá${nomePessoa ? ', ' + nomePessoa : ''}!`,
      '',
      `${quem} convidou você para conversar com o agente ${nomeAgente} no DG Claw.`,
      '',
      `Endereço: ${link}`,
      `Login: ${usuario}`,
      `Senha temporária: ${senha}`,
      '',
      `A senha temporária vale até ${fmtData(expira)} (7 dias). No primeiro acesso você cria a sua própria senha.`,
    ].join('\n');
  }

  /**
   * Endereço do link do convite pedido pelo comando de host: não há navegador, então não existe cabeçalho Host. Vale, nesta
   * ordem, o `base` que o comando mandou (ele lê DGCLAW_DOMINIO do dgclaw.env), DGCLAW_DOMINIO do ambiente do Web, a primeira
   * origem https de DGCLAW_WEB_ORIGENS e, por último, o endereço local, com um aviso de que só abre no servidor.
   */
  function enderecoDoHost(corpo) {
    const dado = corpo && typeof corpo.base === 'string' ? corpo.base.trim().replace(/\/+$/, '') : '';
    if (dado) {
      if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(dado)) {
        const e = new Error(`O campo "base" precisa ser só o endereço (https://painel.exemplo.com), sem caminho. Recebi: ${dado.slice(0, 80)}.`);
        e.status = 400;
        throw e;
      }
      return { base: dado, aviso: null };
    }
    const dominio = String((config.env && config.env.DGCLAW_DOMINIO) || '').trim();
    if (/^[A-Za-z0-9.-]+$/.test(dominio) && dominio) return { base: `https://${dominio}`, aviso: null };
    const extra = [...(config.origensExtras || [])].find((o) => o.startsWith('https://'));
    if (extra) return { base: extra, aviso: null };
    return {
      base: `http://127.0.0.1:${config.porta}`,
      aviso: 'Este DG Claw não tem domínio configurado, então o link do convite é o endereço local e só abre no próprio servidor. Configure um domínio (sudo dgclaw dominio trocar <nome>) ou passe o endereço de acesso à pessoa.',
    };
  }

  /** Monta o convite, tenta o e-mail e devolve o objeto "convite" da resposta. A senha só existe aqui. */
  async function convite(req, sessao, registroColab, senha, corpoDoPedido) {
    const ag = registro.obter(registroColab.agente);
    const nomeAgente = ag ? ag.nome : registroColab.agente;
    let aviso = null;
    let base;
    if (sessao.via === 'host') { const e = enderecoDoHost(corpoDoPedido); base = e.base; aviso = e.aviso; } else base = H.origemPropria(req, config.proxiesConfiaveis);
    const link = `${base}/login?usuario=${encodeURIComponent(registroColab.email)}`;
    const texto = textoDoConvite({
      quem: sessao.usuario, nomeAgente, nomePessoa: registroColab.nome, link, usuario: registroColab.email, senha, expira: registroColab.temporaria_expira,
    });
    const envio = await email.enviar({ para: registroColab.email, assunto: `Convite para conversar com o agente ${nomeAgente} no DG Claw`, texto });
    return {
      link, usuario: registroColab.email, senha_temporaria: senha, expira: registroColab.temporaria_expira,
      email_enviado: envio.enviado === true, email_motivo: envio.enviado ? null : envio.motivo, texto,
      ...(aviso ? { aviso } : {}),
    };
  }

  function falha(res, e, contexto) {
    if (e && e.ocupado) return H.erroJson(res, 429, e.message, { retryAfter: 2 }, { 'Retry-After': '2' });
    if (e && e.status) return H.erroJson(res, e.status, e.message);
    log('erro', `${contexto}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    return H.erroJson(res, 500, `${contexto}. O detalhe foi registrado no log do Web.`);
  }

  const ehDono = (sessao) => sessao && sessao.via !== 'caixa' && sessao.papel !== 'colaborador';

  /** Devolve true quando respondeu. */
  async function tratar(req, res, url, sessao) {
    const p = url.pathname;
    const m = req.method;
    if (p !== '/api/v1/colaboradores' && !p.startsWith('/api/v1/colaboradores/')) return false;
    if (!ehDono(sessao)) { H.erroJson(res, 403, SO_DONO); return true; }

    if (p === '/api/v1/colaboradores/docs.md') {
      if (m !== 'GET') { H.erroJson(res, 405, 'Use GET para ler a documentação.'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, '..', 'docs', 'COLABORADORES.md'), 'utf8'));
      return true;
    }

    if (p === '/api/v1/colaboradores') {
      if (m === 'GET') {
        const agente = url.searchParams.get('agente');
        H.enviaJson(res, 200, { ok: true, colaboradores: colaboradores.lista(agente || undefined) });
        return true;
      }
      if (m === 'POST') {
        let corpo;
        try { corpo = await H.lerJson(req, 8 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return true; }
        try {
          const est = registro.estado();
          if (!est.ok) { H.erroJson(res, 503, est.erro); return true; }
          const slug = typeof corpo.agente === 'string' ? corpo.agente : '';
          if (!slug) { H.erroJson(res, 400, 'Diga para qual agente é o convite, no campo "agente" (o slug; veja GET /api/v1/agents).'); return true; }
          const ag = registro.obter(slug);
          if (!ag) { H.erroJson(res, 404, `Não existe agente com o id "${slug.slice(0, 40)}". Veja GET /api/v1/agents.`); return true; }
          if (ag.tipo === 'admin') { H.erroJson(res, 400, 'O Admin nunca pode ser compartilhado: ele mexe no servidor inteiro. Convide para um agente de trabalho.'); return true; }
          const mail = colaboradores.normalizaEmail(corpo.email);
          if (mail === String(auth.usuario || '').trim().toLowerCase()) {
            H.erroJson(res, 400, 'Esse e-mail é o do próprio dono do DG Claw (o usuário do login). Informe o e-mail do colaborador.');
            return true;
          }
          const instancia = instanciaDe(ag);
          if (!instancia) {
            log('erro', `Convite para ${slug} recusado: não consegui identificar a instância do agente (sem "instancia" no registro e a casa ${ag.home_host || '(sem home_host)'} não pôde ser lida).`);
            H.erroJson(res, 500, `Não consegui identificar esta instância do agente ${slug} (casa ausente ou ilegível), e o convite precisa dela para não valer num agente recriado com o mesmo nome. Rode "dgclaw agente reparar ${slug}" e convide de novo.`);
            return true;
          }
          // Convite de um agente que foi removido e recriado com o mesmo nome não vale e não pode barrar o novo.
          const velhos = await colaboradores.revogarDeOutraInstancia(slug, instancia);
          if (velhos) log('aviso', `Convite(s) de uma instância antiga do agente ${slug} revogado(s) (${velhos}): o agente foi removido e criado de novo.`);
          const r = await colaboradores.criar({ agente: slug, email: mail, nome: corpo.nome, criadoPor: sessao.via === 'host' ? 'admin' : sessao.usuario, instancia });
          log('info', `Colaborador convidado: ${r.registro.email} para o agente ${slug} (por ${sessao.usuario}).`);
          const c = await convite(req, sessao, r.registro, r.senha, corpo);
          H.enviaJson(res, 201, { ok: true, colaborador: r.registro, convite: c });
        } catch (e) { falha(res, e, 'Não consegui criar o convite'); }
        return true;
      }
      H.erroJson(res, 405, 'Use GET para listar e POST para convidar.');
      return true;
    }

    const mr = /^\/api\/v1\/colaboradores\/([^/]+)(?:\/(reenviar))?$/.exec(p);
    if (mr) {
      const id = decodeURIComponent(mr[1]);
      if (!RX_ID.test(id)) { H.erroJson(res, 404, `Não existe colaborador com o id "${id.slice(0, 40)}". Veja GET /api/v1/colaboradores.`); return true; }
      try {
        if (mr[2] === 'reenviar') {
          if (m !== 'POST') { H.erroJson(res, 405, 'Use POST para mandar o convite de novo.'); return true; }
          let corpoReenvio = {};
          if (sessao.via === 'host') corpoReenvio = await H.lerJson(req, 8 * 1024);
          const r = await colaboradores.reenviar(id);
          derruba(id);
          const enc = conta ? await conta.encerraPendencias(id, (slug) => registro.obter(slug)) : { avisos: [] };
          log('info', `Convite reenviado a ${r.registro.email} (agente ${r.registro.agente}); sessões dele derrubadas (por ${sessao.usuario}).`);
          const c = await convite(req, sessao, r.registro, r.senha, corpoReenvio);
          H.enviaJson(res, 200, { ok: true, colaborador: r.registro, convite: c, avisos: enc.avisos });
          return true;
        }
        if (m === 'DELETE') {
          const r = await colaboradores.revogar(id);
          derruba(id);
          log('info', `Acesso de ${r.email} ao agente ${r.agente} revogado (por ${sessao.usuario}).`);
          const contas = conta ? conta.contasDe(id).map((x) => x.agente) : [];
          const enc = conta ? await conta.encerraPendencias(id, (slug) => registro.obter(slug)) : { avisos: [], agentes: [] };
          for (const a of enc.agentes) if (!contas.includes(a)) contas.push(a);
          if (contas.length) log('aviso', `${r.email} conectou, ou deixou em andamento, a conta de IA do agente ${contas.join(', ')} e ela pode continuar conectada depois da revogação. Se quiser, entre com a sua conta em Conectar conta para trocar.`);
          H.enviaJson(res, 200, { ok: true, colaborador: r, contas_de_ia: contas, avisos: enc.avisos });
          return true;
        }
        H.erroJson(res, 405, 'Use DELETE para revogar o acesso, ou POST em /reenviar.');
      } catch (e) { falha(res, e, 'Não consegui atualizar o colaborador'); }
      return true;
    }
    H.erroJson(res, 404, `Não existe ${m} ${p}. As rotas estão em /api/v1/colaboradores/docs.md.`);
    return true;
  }

  /** GET /api/v1/eu */
  function eu(res, sessao) {
    H.enviaJson(res, 200, {
      ok: true, usuario: sessao.usuario, papel: sessao.papel === 'colaborador' ? 'colaborador' : 'dono',
      agente: sessao.papel === 'colaborador' ? sessao.agente : null, nome: sessao.papel === 'colaborador' ? (sessao.nome || '') : '',
      trocar_senha: sessao.papel === 'colaborador' ? !!sessao.trocar_senha : false,
    });
  }

  /** POST /api/v1/eu/senha: o colaborador escolhe a senha dele. */
  async function trocarSenha(req, res, sessao) {
    if (sessao.papel !== 'colaborador') {
      H.erroJson(res, 403, 'A senha do dono não se troca por aqui. No servidor, rode: sudo dgclaw senha');
      return;
    }
    let corpo;
    try { corpo = await H.lerJson(req, 8 * 1024); } catch (e) { H.erroJson(res, e.status || 400, e.message); return; }
    const nova = typeof corpo.nova === 'string' ? corpo.nova : '';
    if (nova.length < SENHA_MIN || nova.length > SENHA_MAX) {
      H.erroJson(res, 400, `A senha nova precisa ter de ${SENHA_MIN} a ${SENHA_MAX} caracteres (a sua tem ${nova.length}).`);
      return;
    }
    if (nova !== corpo.confirmacao) { H.erroJson(res, 400, 'A confirmação não é igual à senha nova. Digite as duas de novo.'); return; }
    // O corpo pode ter demorado: a sessão que autorizou este pedido tem de continuar valendo, e o registro tem de
    // estar na MESMA versão de senha em que ela nasceu (senão o convite foi reenviado, ou a senha trocada, no meio).
    const agoraSessao = auth.sessaoDoPedido(req);
    if (!agoraSessao || agoraSessao.papel !== 'colaborador' || agoraSessao.colaborador_id !== sessao.colaborador_id || agoraSessao.senha_versao !== sessao.senha_versao) {
      H.erroJson(res, 401, 'A sua sessão deixou de valer enquanto você trocava a senha (o dono pode ter mandado um convite novo). Entre de novo.');
      return;
    }
    const c = colaboradores.obter(sessao.colaborador_id);
    if (!c || c.revogado_em) { H.erroJson(res, 401, 'Seu acesso não vale mais. Peça ao dono do DG Claw um convite novo.'); return; }
    if ((c.senha_versao || 1) !== sessao.senha_versao) {
      H.erroJson(res, 409, 'Sua senha ou seu convite mudou enquanto você trocava a senha (o dono pode ter mandado um convite novo). Entre de novo com a senha mais recente.');
      return;
    }
    if (c.trocar_senha && Number(c.temporaria_expira) < relogio()) { H.erroJson(res, 401, 'A senha temporária venceu. Peça ao dono do DG Claw um convite novo.'); return; }
    // O que este pedido viu: a gravação só passa se isso ainda for verdade no momento de gravar (ver definirSenha).
    const esperado = { versao: sessao.senha_versao, hash: c.hash, trocar_senha: !!c.trocar_senha };
    const chaves = [`colab:${c.id}`, `ip:${H.ipDoPedido(req, config.proxiesConfiaveis)}`];
    try {
      if (!c.trocar_senha) {
        if (typeof corpo.atual !== 'string' || !corpo.atual) { H.erroJson(res, 400, 'Informe a senha atual no campo "atual".'); return; }
        const espera = bloqueioDe(chaves);
        if (espera) {
          log('aviso', `Troca de senha de ${c.email} bloqueada: ${MAX_FALHAS_SENHA} erros da senha atual em 15 min.`);
          H.erroJson(res, 429, `Muitos erros na senha atual. Tente de novo em ${Math.ceil(espera / 60)} min.`, { retryAfter: espera }, { 'Retry-After': String(espera) });
          return;
        }
        if (!(await auth.senhaConfereHash(corpo.atual, c.hash))) { registraFalha(chaves); H.erroJson(res, 403, 'A senha atual não confere.'); return; }
        for (const k of chaves) falhasDeSenha.delete(k);
      }
      if (await auth.senhaConfereHash(nova, c.hash)) {
        H.erroJson(res, 400, c.trocar_senha ? 'A senha nova precisa ser diferente da senha temporária.' : 'A senha nova precisa ser diferente da atual.');
        return;
      }
      const hash = await auth.gerarHash(nova);
      const r = await colaboradores.definirSenha(c.id, hash, esperado);
      derruba(c.id);
      const s = auth.criaSessao(c.email, req, { id: c.id, agente: c.agente, senha_versao: r.senha_versao });
      log('info', `${c.email} trocou a senha (agente ${c.agente}); as outras sessões dele foram derrubadas.`);
      H.enviaJson(res, 200, { ok: true, destino: `/a/${encodeURIComponent(c.agente)}` }, { 'Set-Cookie': s.cookies });
    } catch (e) { falha(res, e, 'Não consegui trocar a senha'); }
  }

  return { tratar, eu, trocarSenha };
}

module.exports = { criarColaboradoresRotas, SENHA_MIN, SENHA_MAX };
