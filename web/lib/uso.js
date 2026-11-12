'use strict';
// Uso da assinatura de todos os agentes do registro (o Admin inclusive). O Web não calcula nada:
// pergunta ao runner de cada agente (GET /api/agents/<id>/uso) e junta as respostas.
// Um agente que falha vira { uso:null, erro } com o motivo; os outros seguem. Janela não medida
// chega como null (nunca 0) e janela vencida chega com vencida:true: quem mostra decide como.

function criarUso({ registro, runner, log, timeoutMs }) {
  const limite = timeoutMs || 3000;

  async function deUm(agente) {
    const r = await runner.uso(agente, limite);
    if (!r.ok) {
      log('aviso', `Uso da assinatura de ${agente.nome}: ${r.erro} A lista segue sem o número dele.`);
      return { uso: null, erro: r.erro };
    }
    return r.motivo ? { uso: r.uso, motivo: r.motivo } : { uso: r.uso };
  }

  /** { <slug>: { uso, motivo? } | { uso:null, erro } } para todos os agentes do registro, em paralelo.
   *  Com `soSlug`, só aquele agente: é o caso do pedido que chega pela caixa de um agente, que não
   *  tem por que ver o uso (nem o nome) dos outros. */
  async function consultar(soSlug) {
    const est = registro.estado();
    const todos = est.ok ? est.agentes : [];
    const agentes = soSlug ? todos.filter((a) => a.slug === soSlug) : todos;
    const pares = await Promise.all(agentes.map(async (a) => {
      try {
        return [a.slug, await deUm(a)];
      } catch (e) {
        const erro = `Não consegui ler o uso da assinatura de ${a.nome} (${e.message}).`;
        log('erro', erro);
        return [a.slug, { uso: null, erro }];
      }
    }));
    return Object.fromEntries(pares);
  }

  return { consultar };
}

module.exports = { criarUso };
