// Entrega da mensagem recebida ao runner do agente (POST /input), com tentativas.
import fs from 'node:fs';
import { motivoErro } from './util.mjs';

/** Nunca loga corpo de mensagem nem token. `estaEncerrando` interrompe as tentativas na saida. */
export function criarEntregaRunner({ opcoes, env, runnerUrl, tokenFile, runnerJson, esperasEntrega, dormir, estaEncerrando }) {
  async function lerTokenEAgente() {
    let token;
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch (e) {
      throw new Error(`nao consegui ler o token do runner em ${tokenFile} (${motivoErro(e)}); confira se o agente esta ligado`);
    }
    if (!token) throw new Error(`o arquivo de token ${tokenFile} esta vazio; reinicie o agente`);
    let id = opcoes.agenteId || env.DGCLAW_AGENTE_ID;
    if (!id) {
      try {
        id = JSON.parse(fs.readFileSync(runnerJson, 'utf8')).id;
      } catch (e) {
        throw new Error(`nao achei o id do agente: DGCLAW_AGENTE_ID nao esta definido e ${runnerJson} nao pôde ser lido (${motivoErro(e)})`);
      }
    }
    if (!id) throw new Error(`o campo "id" falta em ${runnerJson}`);
    return { token, id };
  }

  /** Um POST ao runner. Devolve { ok, definitivo, motivo }. Nunca loga corpo nem token. */
  async function postar(envelope) {
    let credenciais;
    try {
      credenciais = await lerTokenEAgente();
    } catch (e) {
      return { ok: false, definitivo: false, motivo: motivoErro(e) };
    }
    try {
      const r = await fetch(`${runnerUrl}/api/agents/${encodeURIComponent(credenciais.id)}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credenciais.token}` },
        body: JSON.stringify({ text: envelope, submit: true, injectWhenIdle: true }),
        signal: AbortSignal.timeout(15000),
      });
      // Só o status interessa; o corpo é lido para liberar a conexão, e um erro ao ler não muda a decisão.
      await r.arrayBuffer().catch(() => {});
      if (r.status >= 200 && r.status < 300) return { ok: true };
      if (r.status === 409) {
        return { ok: false, definitivo: true, status: 409, motivo: 'o runner respondeu 409: o agente esta sem login ou sem chave. Abra o painel do DG Claw e entre com a assinatura' };
      }
      if (r.status >= 500) return { ok: false, definitivo: false, motivo: `o runner respondeu ${r.status}` };
      return { ok: false, definitivo: true, status: r.status, motivo: `o runner recusou com ${r.status}` };
    } catch (e) {
      return { ok: false, definitivo: false, motivo: `nao consegui falar com o runner em ${runnerUrl} (${motivoErro(e)})` };
    }
  }

  async function entregar(envelope) {
    let ultimo = null;
    for (let i = 0; i <= esperasEntrega.length; i++) {
      ultimo = await postar(envelope);
      if (ultimo.ok || ultimo.definitivo || estaEncerrando()) return ultimo;
      if (i < esperasEntrega.length) await dormir(esperasEntrega[i]);
    }
    return ultimo;
  }

  return { entregar };
}
