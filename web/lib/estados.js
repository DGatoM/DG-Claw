'use strict';
// Estado de atenção de cada agente: o que o selo do menu e o aviso no celular precisam saber.
//
//   trabalhando      o runner diz que o agente está no meio de um turno
//   precisa_de_voce  ele parou esperando a pessoa (permissão, pergunta de escolha ou login da conta)
//   terminou         ocioso, com resposta que a pessoa ainda não leu (ou que ela marcou como não lida)
//   ocioso           ocioso e tudo lido
//   sem_sinal        não consegui falar com o runner (nunca vira "ocioso": não sei não é "parado")
//
// O `resumo` é uma frase curta montada aqui, só com o NOME da ferramenta. Nunca o comando nem o texto do
// pedido: o selo aparece no menu e no aviso do aparelho, e esse conteúdo pode ter segredo.

const { mascarar } = require('./mascara');

const LIMITE_RESUMO = 80;
const RX_FERRAMENTA = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;

/** Corta em 80 caracteres e passa pelo mascarador de segredos. */
function resumoSeguro(texto) {
  const limpo = mascarar(String(texto == null ? '' : texto)).replace(/\s+/g, ' ').trim();
  return limpo.length > LIMITE_RESUMO ? `${limpo.slice(0, LIMITE_RESUMO - 1)}…` : limpo;
}

function resumoDaPermissao(ferramenta) {
  const f = typeof ferramenta === 'string' && RX_FERRAMENTA.test(ferramenta) ? ferramenta : null;
  if (!f) return 'pede a sua permissão';
  return f === 'Bash' ? 'pede permissão para rodar Bash' : `pede permissão para usar ${f}`;
}

/** Traduz a foto do runner (GET /api/agents/<id>) para o estado base. `r` é o retorno de conversa.estado(). */
function estadoBase(agente, r) {
  if (!r || !r.ok) {
    const erro = (r && r.erro) || `Não consegui falar com o runner de ${agente.nome}.`;
    return { estado: 'sem_sinal', motivo: null, resumo: null, erro };
  }
  const e = r.estado;
  switch (e.status) {
    case 'working':
    case 'spawning':
      return { estado: 'trabalhando', motivo: null, resumo: null, erro: null };
    case 'waiting_input': {
      // Runner antigo não manda `motivo`: o único waiting_input que ele conhecia era o de permissão.
      // Codex nunca informa motivo nem pede permissão pelo Web: fica sem motivo, com frase genérica.
      const codex = /codex/i.test(String(agente.provedor || ''));
      const motivo = e.motivo === 'pergunta' || e.motivo === 'permissao' ? e.motivo : (codex ? null : 'permissao');
      const resumo = motivo === 'pergunta' ? 'fez uma pergunta' : motivo === 'permissao' ? resumoDaPermissao(e.currentTool) : 'está esperando você';
      return { estado: 'precisa_de_voce', motivo, resumo, erro: null };
    }
    case 'idle':
    case 'completed':
      return { estado: 'ocioso', motivo: null, resumo: null, erro: null };
    case 'errored':
      if (e.statusReason === 'runner:login-expirado' || e.motivo === 'login') {
        return { estado: 'precisa_de_voce', motivo: 'login', resumo: 'o login da conta expirou', erro: null };
      }
      if (e.statusReason === 'runner:sem-login') {
        return { estado: 'precisa_de_voce', motivo: 'login', resumo: 'falta conectar a conta', erro: null };
      }
      return { estado: 'sem_sinal', motivo: null, resumo: null, erro: `O runner informa erro para ${agente.nome}${e.error ? `: ${resumoSeguro(e.error)}` : ''}. Veja o log do agente.` };
    default:
      return { estado: 'sem_sinal', motivo: null, resumo: null, erro: `O runner informa o status "${resumoSeguro(e.status)}" para ${agente.nome}, então não sei se ele está trabalhando.` };
  }
}

function criarEstados({ conversa, naoLidas, registro, log }) {
  /** O estado base de um agente, sem olhar não lidas. Nunca lança. */
  async function doRunner(agente) {
    try {
      return estadoBase(agente, await conversa.estado(agente));
    } catch (e) {
      log('erro', `Estado de ${agente.nome}: falha inesperada ao ler o runner (${e.message}). Marquei o agente como sem sinal.`);
      return { estado: 'sem_sinal', motivo: null, resumo: null, erro: `Falha inesperada ao ler o estado de ${agente.nome} (${e.message}).` };
    }
  }

  /** { <slug>: { estado, motivo, resumo, nao_lidas, marcada_nao_lida, erro? } } para o usuário da sessão. */
  async function todos(usuario) {
    const est = registro.estado();
    const agentes = est.ok ? est.agentes : [];
    const [bases, lidas] = await Promise.all([
      Promise.all(agentes.map(async (a) => [a, await doRunner(a)])),
      // Sem usuário (consulta do Admin pela caixa) não há "lido": nao_lidas fica null e ninguém ganha marco.
      usuario == null ? {} : naoLidas.contar(usuario),
    ]);
    const saida = {};
    for (const [a, base] of bases) {
      const nl = lidas[a.slug] || { nao_lidas: null };
      const marcada = nl.marcada_nao_lida === true;
      let estado = base.estado;
      if (estado === 'ocioso' && ((typeof nl.nao_lidas === 'number' && nl.nao_lidas > 0) || marcada)) estado = 'terminou';
      const item = {
        estado, motivo: base.motivo, resumo: base.resumo,
        nao_lidas: nl.nao_lidas, marcada_nao_lida: marcada,
        visto_ep: nl.visto_ep === undefined ? null : nl.visto_ep, ultima_ep: nl.ultima_ep === undefined ? null : nl.ultima_ep,
      };
      if (nl.mais) item.mais = true;
      if (nl.marco_novo) item.marco_novo = true;
      const erros = [base.erro, nl.erro].filter(Boolean);
      if (erros.length) item.erro = erros.join(' ');
      saida[a.slug] = item;
    }
    return saida;
  }

  return { todos, doRunner };
}

module.exports = { criarEstados, estadoBase, resumoSeguro };
