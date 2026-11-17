// Anota o resultado do WhatsApp no registro de integracoes do agente (docs/PLANO-INTEGRACOES-E-VIGIA.md),
// chamando o comando `dgclaw-integracao`. Chamada sem shell, sem esperar e sem nunca derrubar a ponte.
import { execFile } from 'node:child_process';
import { motivoErro } from './util.mjs';

/**
 * @param {{ registrar: (msg: string) => void, env: object, opcoes?: object }} deps
 * `opcoes.registrarIntegracao(resultado, origem)` substitui a chamada real (usado nos testes).
 * `anotar` devolve uma promessa que resolve quando o comando termina ou passado o prazo (3 s), sem nunca rejeitar:
 * quem anota um evento terminal (logout) espera por ela antes de encerrar o processo.
 * `opcoes.binIntegracao` ou DGCLAW_INTEGRACAO_BIN escolhe o comando (padrao: dgclaw-integracao no PATH).
 */
export function criarAnotadorIntegracao({ registrar, env, opcoes = {} }) {
  const bin = opcoes.binIntegracao || env.DGCLAW_INTEGRACAO_BIN || 'dgclaw-integracao';
  let avisouAusente = false;
  const PRAZO_MS = 3000;

  function anotar(resultado, origem) {
    return new Promise((resolve) => {
      let timer = null;
      const fim = () => { if (timer) clearTimeout(timer); resolve(); };
      try {
        if (typeof opcoes.registrarIntegracao === 'function') {
          Promise.resolve(opcoes.registrarIntegracao(resultado, origem)).then(fim, fim);
          return;
        }
        const filho = execFile(bin, ['registrar', 'whatsapp', resultado, '--origem', origem], { timeout: 10000, env }, (erro) => {
          if (erro) {
            if (erro.code === 'ENOENT') {
              if (!avisouAusente) {
                avisouAusente = true;
                registrar(`o comando ${bin} nao existe aqui (fora do container?); o resultado do WhatsApp nao foi anotado no mapa de integracoes`);
              }
            } else {
              registrar(`nao consegui anotar "${resultado}" do WhatsApp no mapa de integracoes (${motivoErro(erro)}); a ponte segue normalmente`);
            }
          }
          fim();
        });
        filho.on('error', () => { /* tratado no callback acima */ });
        if (typeof filho.unref === 'function') filho.unref();
        timer = setTimeout(() => {
          registrar(`o registro de "${resultado}" do WhatsApp no mapa de integracoes passou de ${PRAZO_MS / 1000} s; a ponte encerra sem esperar mais`);
          resolve();
        }, PRAZO_MS);
        if (typeof timer.unref === 'function') timer.unref();
      } catch (e) {
        registrar(`nao consegui anotar "${resultado}" do WhatsApp no mapa de integracoes (${motivoErro(e)}); a ponte segue normalmente`);
        fim();
      }
    });
  }

  return { anotar };
}
