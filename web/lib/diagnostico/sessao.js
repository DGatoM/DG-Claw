'use strict';
// Sessão e login de um agente (ou do Admin) a partir do que o runner diz. Os textos do runner NUNCA
// entram no resultado: o erro dele pode citar o caminho do arquivo de token, então aqui só saem frases nossas.

const U = require('./util');

const TRAVADO_MS = 30 * 60 * 1000;

// O runner roda dentro do container: o motivo só vale se for um dos que o runner conhece.
const razaoDe = (est) => (est ? U.dentro(est.statusReason, U.ENUMS.razaoRunner) : null);
const httpDe = (saude) => (saude && Number.isInteger(saude.status) && saude.status >= 100 && saude.status <= 599 ? saude.status : null);

function comandoDeReinicio(ag) {
  return ag.tipo === 'admin' ? 'systemctl restart dgclaw-admin' : `dgclaw agente reiniciar ${ag.slug}`;
}

const admin = (ag) => ag.tipo === 'admin';
const o = (ag) => (admin(ag) ? 'o Admin' : `o agente ${ag.nome}`);
const O = (ag) => (admin(ag) ? 'O Admin' : `O agente ${ag.nome}`);
const doo = (ag) => (admin(ag) ? 'do Admin' : `do agente ${ag.nome}`);
// Dentro de prompt entra o slug (validado), não o nome livre.
const oP = (ag) => (admin(ag) ? 'o Admin' : `o agente ${ag.slug}`);
const dooP = (ag) => (admin(ag) ? 'do Admin' : `do agente ${ag.slug}`);

/** Login: { estado, ... } ou null quando o login não é o problema (e não há o que dizer). */
function analisaLogin(ag, dados, tz) {
  const { estado, provedor } = dados;
  const razao = estado && estado.ok ? razaoDe(estado.estado) : null;
  const refazer = `Abra a conversa ${doo(ag)} no painel do DG Claw e refaça o login do Claude pelo cartão ou pelo aviso "Seu login do Claude expirou" (passo a passo em web/docs/LOGIN-NA-CONVERSA.md). Se o cartão não abrir, digite /login na conversa.`;
  if (razao === 'runner:login-expirado') {
    const ms = Date.parse(estado.estado.loginExpiradoEm);
    return {
      estado: 'quebrado',
      motivo: `O login do Claude expirou${Number.isFinite(ms) ? ` em ${U.quando(ms, tz)}` : ''} e ${o(ag)} parou de responder.`,
      ultimo_sinal: U.iso(ms),
      evidencia: { horario: U.iso(ms), codigo_saida: null, sinal: 'runner:login-expirado' },
      o_que_fazer: refazer,
      prompt_sugerido: null,
    };
  }
  if (razao === 'runner:sem-login') {
    return {
      estado: 'quebrado',
      motivo: `${O(ag)} não está com uma conta do Claude conectada, então não responde.`,
      ultimo_sinal: null,
      evidencia: { horario: null, codigo_saida: null, sinal: 'runner:sem-login' },
      o_que_fazer: refazer,
      prompt_sugerido: null,
    };
  }
  if (!provedor || !provedor.ok) {
    return { estado: 'nao_medido', motivo: `O runner não respondeu a pergunta sobre a conta conectada (/api/provedor), então não deu para conferir o login ${doo(ag)}.`, ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null };
  }
  const conf = provedor.dados.conferido;
  const emMs = conf && typeof conf.em === 'string' ? Date.parse(conf.em) : NaN;
  if (conf && conf.ok === false) {
    return {
      estado: 'quebrado',
      motivo: 'A conferência da conta do Claude falhou: a conta aparece como desconectada ou recusada.',
      ultimo_sinal: U.iso(emMs),
      evidencia: { horario: U.iso(emMs), codigo_saida: null, sinal: 'conferência da conta do Claude falhou' },
      o_que_fazer: refazer,
      prompt_sugerido: null,
    };
  }
  if (!conf || conf.ok !== true) {
    return { estado: 'nao_medido', motivo: 'O runner ainda não conferiu a conta conectada (a resposta veio sem o resultado da conferência).', ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null };
  }
  return { estado: 'ok', motivo: null, ultimo_sinal: U.iso(emMs), evidencia: null, o_que_fazer: null, prompt_sugerido: null };
}

/**
 * Sessão viva. `contMorto`: o container já foi dado como quebrado, então um runner mudo é consequência
 * e vira nao_medido em vez de mais um quebrado.
 */
function analisaSessao(ag, dados, { agoraMs, tz, contMorto }) {
  const { saude, estado } = dados;
  const cmd = comandoDeReinicio(ag);
  const fix = (viu) => ({
    o_que_fazer: U.ONDE_COLAR,
    prompt_sugerido: U.promptAdmin(viu, `\`dgclaw status\` e o log do runner`, cmd),
  });
  if (!saude || !saude.ok) {
    if (contMorto) return { estado: 'nao_medido', motivo: 'O container está parado, então o runner não responde e não deu para conferir a sessão.', ultimo_sinal: null, evidencia: null, o_que_fazer: null, prompt_sugerido: null };
    const codigoHttp = httpDe(saude);
    const http = codigoHttp ? ` (HTTP ${codigoHttp})` : '';
    const recusou = codigoHttp === 401 || codigoHttp === 403;
    const viu = recusou
      ? `o runner ${dooP(ag)} recusou o token do Web${http}.`
      : `o runner ${dooP(ag)} (o programa que mantém a conversa viva) não está respondendo${http}.`;
    return Object.assign({
      estado: 'quebrado',
      motivo: recusou
        ? `O runner ${doo(ag)} recusou o token que o Web usa${http}, então a conversa não funciona.`
        : `O runner ${doo(ag)} (o programa que mantém a conversa viva) não respondeu${http}.`,
      ultimo_sinal: null,
      evidencia: { horario: null, codigo_saida: codigoHttp, sinal: recusou ? 'token do runner recusado' : 'runner sem resposta' },
    }, fix(viu.charAt(0).toUpperCase() + viu.slice(1)));
  }
  const corpo = saude.corpo || {};
  const agente = corpo.agente || {};
  const status = U.dentro(agente.status, U.ENUMS.statusRunner);
  const saidaMs = Number.isFinite(corpo.ultimaSaidaEm) ? corpo.ultimaSaidaEm : null;
  const atualMs = estado && estado.ok && Number.isFinite(estado.estado.updatedAt) ? estado.estado.updatedAt : null;
  const sinalMs = saidaMs != null ? saidaMs : atualMs;
  const razao = estado && estado.ok ? razaoDe(estado.estado) : null;
  const base = { ultimo_sinal: U.iso(sinalMs), evidencia: { horario: U.iso(sinalMs), codigo_saida: null, sinal: `status ${status || 'desconhecido'}, sessão ${agente.ptyVivo ? 'viva' : 'sem terminal vivo'}` } };

  if (razao === 'runner:login-expirado' || razao === 'runner:sem-login') {
    return Object.assign({
      estado: 'quebrado',
      motivo: `A sessão está parada por falta de login (${razao === 'runner:login-expirado' ? 'login expirado' : 'sem login'}). Resolva primeiro o item de login.`,
      o_que_fazer: 'Refaça o login conforme o item de login deste agente; a sessão volta sozinha depois.',
      prompt_sugerido: null,
    }, base);
  }
  if (status === 'errored') {
    return Object.assign({
      estado: 'quebrado',
      motivo: `A sessão ${doo(ag)} está com erro${razao ? ` (${razao})` : ''} e não está respondendo.`,
    }, base, fix(`a sessão ${dooP(ag)} está com status de erro${razao ? ` (${razao})` : ''}.`));
  }
  if (agente.ptyVivo === false) {
    return Object.assign({
      estado: 'quebrado',
      motivo: `O Claude ${doo(ag)} não está rodando: o runner está de pé, mas a sessão não tem terminal vivo.`,
    }, base, fix(`o runner responde, mas a sessão ${dooP(ag)} está sem terminal vivo.`));
  }
  if ((status === 'working' || status === 'waiting_input') && sinalMs != null && agoraMs - sinalMs > TRAVADO_MS) {
    const espera = status === 'waiting_input';
    return Object.assign({
      estado: 'atencao',
      motivo: espera
        ? `Está esperando uma aprovação sua há ${U.duracaoCurta(agoraMs - sinalMs)}, sem andar.`
        : `Parece travado: aparece como trabalhando, mas não escreve nada há ${U.duracaoCurta(agoraMs - sinalMs)} (desde ${U.quando(sinalMs, tz)}).`,
    }, base, espera
      ? { o_que_fazer: `Abra a conversa ${doo(ag)} no painel e aprove ou negue o pedido de permissão que está na tela.`, prompt_sugerido: null }
      : fix(`${oP(ag)} aparece como trabalhando, mas está há ${U.duracaoCurta(agoraMs - sinalMs)} sem escrever nada.`));
  }
  return Object.assign({ estado: 'ok', motivo: null, o_que_fazer: null, prompt_sugerido: null }, base);
}

module.exports = { analisaLogin, analisaSessao, comandoDeReinicio, razaoDe };
