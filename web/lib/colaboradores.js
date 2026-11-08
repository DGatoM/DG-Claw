'use strict';
// Colaboradores: pessoas convidadas pelo dono para UM agente de trabalho (docs em web/docs/COLABORADORES.md).
// Guardados em <dataDir>/colaboradores.json (modo 600, gravação atômica). O Web é o único escritor: as
// gravações passam por uma fila em memória. Revogar é datar (revogado_em), nunca apagar o registro.
// O hash da senha nunca sai daqui para a API: use publico().

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VALIDADE_TEMPORARIA_MS = 7 * 24 * 60 * 60 * 1000;
// Sem 0, O, 1, I, l: a pessoa digita a senha temporária lendo de um e-mail ou de uma mensagem.
const ALFABETO_SENHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TAMANHO_SENHA = 12;
const RX_EMAIL = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/;

function erroStatus(status, mensagem, extra) {
  const e = new Error(mensagem);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

/** E-mail minúsculo e validado, ou lança erro 400 que diz o que está errado. */
function normalizaEmail(bruto) {
  const e = typeof bruto === 'string' ? bruto.trim().toLowerCase() : '';
  if (!e) throw erroStatus(400, 'Informe o e-mail do colaborador no campo "email".');
  if (/[\r\n]/.test(e)) throw erroStatus(400, 'O e-mail não pode ter quebra de linha.');
  if (e.length > 254) throw erroStatus(400, `O e-mail tem ${e.length} caracteres e o limite é 254.`);
  if (!RX_EMAIL.test(e)) throw erroStatus(400, `"${e.slice(0, 80)}" não parece um e-mail válido. Use o formato nome@dominio.com.`);
  return e;
}

/** Nome opcional (até 80, sem quebra de linha nem < >). Devolve '' quando não veio. */
function normalizaNome(bruto) {
  if (bruto == null || bruto === '') return '';
  if (typeof bruto !== 'string') throw erroStatus(400, 'O campo "nome" precisa ser um texto.');
  const n = bruto.trim();
  if (/[\r\n<>]/.test(n)) throw erroStatus(400, 'O nome não pode ter quebra de linha nem os sinais < e >.');
  if (n.length > 80) throw erroStatus(400, `O nome tem ${n.length} caracteres e o limite é 80.`);
  return n;
}

function geraSenhaTemporaria() {
  let s = '';
  for (let i = 0; i < TAMANHO_SENHA; i++) s += ALFABETO_SENHA[crypto.randomInt(ALFABETO_SENHA.length)];
  return s;
}

/**
 * config: { dataDir }; log; agora (relógio injetável); gerarHash(senha) -> Promise<string> (o do auth.js).
 */
function criarColaboradores({ config, log, agora, gerarHash }) {
  const relogio = agora || (() => Date.now());
  const arquivo = path.join(config.dataDir, 'colaboradores.json');
  let lista = [];
  let mtimeVisto = -1;     // -1: ainda não li; 0: arquivo ausente
  let ilegivel = null;     // motivo, quando o arquivo existe e não deu para ler
  let fila = Promise.resolve();

  /** Relê do disco quando o mtime mudou (alguém pode ter editado à mão). Nunca apaga nem sobrescreve. */
  function carrega() {
    let st;
    try { st = fs.statSync(arquivo); } catch (e) {
      if (e.code === 'ENOENT') { lista = []; ilegivel = null; mtimeVisto = 0; return; }
      if (mtimeVisto !== -2) log('erro', `Não consegui acessar ${arquivo} (${e.code || e.message}). Trato como "nenhum colaborador" e não gravo nada até o arquivo voltar a abrir; confira a permissão de ${config.dataDir}.`);
      lista = []; ilegivel = `${e.code || e.message}`; mtimeVisto = -2;
      return;
    }
    const marca = st.mtimeMs;
    if (marca === mtimeVisto) return;
    try {
      const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.colaboradores)) throw new Error('o conteúdo não tem a lista "colaboradores"');
      lista = j.colaboradores.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.email === 'string' && typeof c.agente === 'string');
      if (lista.length !== j.colaboradores.length) log('aviso', `Em ${arquivo}, ${j.colaboradores.length - lista.length} registro(s) sem id, e-mail ou agente foram ignorados (o arquivo não foi alterado).`);
      ilegivel = null;
    } catch (e) {
      lista = [];
      ilegivel = e.message;
      log('erro', `O arquivo ${arquivo} está ilegível (${e.message}). Trato como "nenhum colaborador" e NÃO apaguei nem vou regravar o arquivo. Corrija o JSON (ou renomeie o arquivo para recomeçar) e tente de novo.`);
    }
    mtimeVisto = marca;
  }

  function grava() {
    const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ versao: 1, colaboradores: lista }, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, arquivo);
      mtimeVisto = fs.statSync(arquivo).mtimeMs;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* o temporário nem chegou a existir */ }
      log('erro', `Não consegui gravar ${arquivo} (${e.code || e.message}). Confira o espaço em disco e a permissão de ${config.dataDir}.`);
      throw erroStatus(500, `Não consegui gravar a lista de colaboradores (${e.code || e.message}). Confira o espaço em disco e a permissão da pasta de dados do Web.`);
    }
  }

  /** Roda fn em fila (uma por vez), com o arquivo recém-lido. Se o arquivo está ilegível, recusa em vez de sobrescrevê-lo. */
  function transacao(fn) {
    const p = fila.then(async () => {
      carrega();
      if (ilegivel) throw erroStatus(500, `O arquivo ${arquivo} está ilegível (${ilegivel}), então não gravo nada para não perder o que está nele. Corrija o JSON ou renomeie o arquivo para recomeçar.`);
      return fn();
    });
    fila = p.catch(() => undefined);
    return p;
  }

  function estadoDe(c) {
    if (c.revogado_em) return 'revogado';
    if (c.trocar_senha) return Number(c.temporaria_expira) < relogio() ? 'temporaria_vencida' : 'aguardando_primeiro_acesso';
    return 'ativo';
  }

  /** O registro sem o hash, com o estado calculado. */
  function publico(c) {
    return {
      id: c.id, email: c.email, nome: c.nome || '', agente: c.agente, estado: estadoDe(c),
      trocar_senha: !!c.trocar_senha, temporaria_expira: c.trocar_senha ? c.temporaria_expira : null,
      criado_em: c.criado_em, criado_por: c.criado_por, revogado_em: c.revogado_em || null, ultimo_login: c.ultimo_login || null,
    };
  }

  const ativos = () => { carrega(); return lista.filter((c) => !c.revogado_em); };

  return {
    arquivo,
    VALIDADE_TEMPORARIA_MS,
    publico,
    estadoDe,
    normalizaEmail,

    /** Todos (inclusive os revogados), do mais novo para o mais antigo; `agente` filtra. */
    lista(agente) {
      carrega();
      return lista.filter((c) => !agente || c.agente === agente).slice().sort((a, b) => b.criado_em - a.criado_em).map(publico);
    },
    obter(id) { carrega(); return lista.find((c) => c.id === id) || null; },
    porEmailAtivo(email) {
      const e = String(email || '').trim().toLowerCase();
      return e ? ativos().find((c) => c.email === e) || null : null;
    },
    ativoDoAgente(slug) { return ativos().find((c) => c.agente === slug) || null; },

    /** Cria o convite. As regras que dependem do registro de agentes (existe? é o Admin?) ficam na rota. */
    criar({ agente, email, nome, criadoPor, instancia }) {
      return transacao(async () => {
        if (!instancia) throw erroStatus(500, `Não consegui identificar esta instância do agente ${agente} (casa ausente ou ilegível), e o convite precisa dela para não valer num agente recriado com o mesmo nome. Rode "dgclaw agente reparar ${agente}" e convide de novo.`);
        const mail = normalizaEmail(email);
        const nomeOk = normalizaNome(nome);
        const doAgente = lista.find((c) => !c.revogado_em && c.agente === agente);
        if (doAgente) throw erroStatus(409, `O agente ${agente} já tem um colaborador ativo (${doAgente.email}). Hoje cada agente tem um colaborador só: revogue o acesso atual antes de convidar outra pessoa.`);
        const doEmail = lista.find((c) => !c.revogado_em && c.email === mail);
        if (doEmail) throw erroStatus(409, `O e-mail ${mail} já é colaborador do agente ${doEmail.agente}. Hoje cada pessoa acessa um agente só: revogue o acesso dela lá antes de convidar para este.`);
        const senha = geraSenhaTemporaria();
        const hash = await gerarHash(senha);
        const t = relogio();
        const registro = {
          id: crypto.randomBytes(16).toString('base64url'), email: mail, nome: nomeOk, agente, instancia, hash,
          trocar_senha: true, temporaria_expira: t + VALIDADE_TEMPORARIA_MS, senha_versao: 1,
          criado_em: t, criado_por: criadoPor || null, revogado_em: null, ultimo_login: null,
        };
        lista.push(registro);
        try { grava(); } catch (e) { lista.pop(); throw e; }
        return { registro: publico(registro), senha };
      });
    },

    /** Senha temporária nova: derruba as sessões (senha_versao sobe) e exige a troca no próximo acesso. */
    reenviar(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) throw erroStatus(404, `Não existe colaborador com o id "${String(id).slice(0, 40)}". Veja GET /api/v1/colaboradores.`);
        if (c.revogado_em) throw erroStatus(409, `O acesso de ${c.email} já foi revogado. Convide a pessoa de novo para ela voltar a entrar.`);
        const senha = geraSenhaTemporaria();
        const hash = await gerarHash(senha);
        const antes = Object.assign({}, c);
        Object.assign(c, { hash, trocar_senha: true, temporaria_expira: relogio() + VALIDADE_TEMPORARIA_MS, senha_versao: (c.senha_versao || 1) + 1 });
        try { grava(); } catch (e) { Object.assign(c, antes); throw e; }
        return { registro: publico(c), senha };
      });
    },

    /**
     * Revoga os convites ativos do agente `slug` que foram feitos para outra instância dele (o agente foi removido e
     * recriado com o mesmo nome). Devolve quantos. Chamado antes de convidar de novo e quando o Web nota a troca.
     */
    revogarDeOutraInstancia(slug, instanciaAtual) {
      return transacao(async () => {
        let n = 0;
        const t = relogio();
        for (const c of lista) {
          if (c.agente === slug && !c.revogado_em && (!c.instancia || c.instancia !== instanciaAtual)) { c.revogado_em = t; n += 1; }
        }
        if (n) {
          try { grava(); } catch (e) { for (const c of lista) if (c.revogado_em === t) c.revogado_em = null; throw e; }
        }
        return n;
      });
    },

    revogar(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) throw erroStatus(404, `Não existe colaborador com o id "${String(id).slice(0, 40)}". Veja GET /api/v1/colaboradores.`);
        if (c.revogado_em) throw erroStatus(409, `O acesso de ${c.email} já foi revogado em ${new Date(c.revogado_em).toISOString()}. Nada a fazer.`);
        c.revogado_em = relogio();
        try { grava(); } catch (e) { c.revogado_em = null; throw e; }
        return publico(c);
      });
    },

    /** O próprio colaborador escolhe a senha: hash novo, fim da temporária, senha_versao sobe. */
    definirSenha(id, hash, esperado) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c || c.revogado_em) throw erroStatus(401, 'Seu acesso não vale mais. Peça ao dono do DG Claw um convite novo.');
        // A conferência e a gravação acontecem juntas, na fila: se o dono reenviou o convite (ou a senha mudou por
        // outro caminho) depois que este pedido começou, a troca velha não pode passar por cima.
        if (esperado && ((c.senha_versao || 1) !== esperado.versao || c.hash !== esperado.hash || (esperado.trocar_senha !== undefined && !!c.trocar_senha !== esperado.trocar_senha))) {
          throw erroStatus(409, 'Sua senha ou seu convite mudou enquanto você trocava a senha (o dono pode ter mandado um convite novo). Entre de novo com a senha mais recente.');
        }
        if (c.trocar_senha && Number(c.temporaria_expira) < relogio()) throw erroStatus(401, 'A senha temporária venceu. Peça ao dono do DG Claw um convite novo.');
        const antes = Object.assign({}, c);
        Object.assign(c, { hash, trocar_senha: false, temporaria_expira: null, senha_versao: (c.senha_versao || 1) + 1 });
        try { grava(); } catch (e) { Object.assign(c, antes); throw e; }
        return { registro: publico(c), senha_versao: c.senha_versao };
      });
    },

    registrarLogin(id) {
      return transacao(async () => {
        const c = lista.find((x) => x.id === id);
        if (!c) return;
        c.ultimo_login = relogio();
        try { grava(); } catch (e) { log('aviso', `Não consegui registrar o último acesso de ${c.email} (${e.message}).`); }
      }).catch((e) => { log('aviso', `Não registrei o último acesso: ${e.message}`); });
    },
  };
}

module.exports = { criarColaboradores, normalizaEmail, normalizaNome, geraSenhaTemporaria, VALIDADE_TEMPORARIA_MS };
