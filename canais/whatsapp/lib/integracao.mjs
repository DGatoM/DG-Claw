// Anota o resultado do WhatsApp no registro de integracoes do agente (docs/PLANO-INTEGRACOES-E-VIGIA.md),
// chamando o comando `dgclaw-integracao`. Chamada sem shell, sem esperar e sem nunca derrubar a ponte.
import { execFile } from 'node:child_process';
import { motivoErro } from './util.mjs';

/**
 * @param {{ registrar: (msg: string) => void, env: object, opcoes?: object }} deps
 * `opcoes.registrarIntegracao(resultado, origem)` substitui a chamada real (usado nos testes).
 * `opcoes.binIntegracao` ou DGCLAW_INTEGRACAO_BIN escolhe o comando (padrao: dgclaw-integracao no PATH).
 */
export function criarAnotadorIntegracao({ registrar, env, opcoes = {} }) {
  const bin = opcoes.binIntegracao || env.DGCLAW_INTEGRACAO_BIN || 'dgclaw-integracao';
  let avisouAusente = false;

  function anotar(resultado, origem) {
    try {
      if (typeof opcoes.registrarIntegracao === 'function') {
        opcoes.registrarIntegracao(resultado, origem);
        return;
      }
      const filho = execFile(bin, ['registrar', 'whatsapp', resultado, '--origem', origem], { timeout: 10000, env }, (erro) => {
        if (!erro) return;
        if (erro.code === 'ENOENT') {
          if (!avisouAusente) {
            avisouAusente = true;
            registrar(`o comando ${bin} nao existe aqui (fora do container?); o resultado do WhatsApp nao foi anotado no mapa de integracoes`);
          }
          return;
        }
        registrar(`nao consegui anotar "${resultado}" do WhatsApp no mapa de integracoes (${motivoErro(erro)}); a ponte segue normalmente`);
      });
      filho.on('error', () => { /* tratado no callback acima */ });
      if (typeof filho.unref === 'function') filho.unref();
    } catch (e) {
      registrar(`nao consegui anotar "${resultado}" do WhatsApp no mapa de integracoes (${motivoErro(e)}); a ponte segue normalmente`);
    }
  }

  return { anotar };
}
