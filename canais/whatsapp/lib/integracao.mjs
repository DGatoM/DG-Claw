// Anota o resultado do WhatsApp no registro de integracoes do agente (docs/PLANO-INTEGRACOES-E-VIGIA.md),
// chamando o comando `dgclaw-integracao`. Chamada sem shell, um registro por vez e sem nunca derrubar a ponte.
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
  const MAX_FILA = 20;
  // Um registro por vez: uma rajada de mensagens nao abre um processo por mensagem.
  // "ok" repetido logo em seguida e condensado; a ordem das falhas e mantida.
  const fila = [];
  let rodando = false;
  let avisouCheia = false;

  function anotar(resultado, origem) {
    const ultimo = fila[fila.length - 1];
    if (ultimo && ultimo.resultado === 'ok' && resultado === 'ok' && ultimo.origem === origem) return comPrazo(ultimo.promessa, resultado);
    if (fila.length >= MAX_FILA) {
      if (!avisouCheia) { avisouCheia = true; registrar(`a fila de registros do mapa de integracoes passou de ${MAX_FILA}; "${resultado}" do WhatsApp nao foi anotado`); }
      return Promise.resolve();
    }
    const item = { resultado, origem };
    item.promessa = new Promise((resolve) => { item.resolve = resolve; });
    fila.push(item);
    proximo();
    return comPrazo(item.promessa, resultado);
  }

  // Quem espera (o logout) nunca espera mais que o prazo, mesmo com registros na frente da fila.
  function comPrazo(promessa, rotulo) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        registrar(`o registro de "${rotulo}" do WhatsApp no mapa de integracoes passou de ${PRAZO_MS / 1000} s; a ponte encerra sem esperar mais`);
        resolve();
      }, PRAZO_MS);
      if (typeof t.unref === 'function') t.unref();
      promessa.then(() => { clearTimeout(t); resolve(); });
    });
  }

  function proximo() {
    if (rodando || !fila.length) return;
    rodando = true;
    const item = fila[0];
    executar(item.resultado, item.origem).then(() => {
      fila.shift();
      rodando = false;
      if (!fila.length) avisouCheia = false;
      item.resolve();
      proximo();
    });
  }

  function executar(resultado, origem) {
    return new Promise((resolve) => {
      // So termina quando o processo filho termina (o execFile ja tem timeout de 10 s): o proximo registro nunca
      // comeca com o anterior ainda rodando. O prazo de 3 s e de quem espera (comPrazo), nao da fila.
      const fim = () => resolve();
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
      } catch (e) {
        registrar(`nao consegui anotar "${resultado}" do WhatsApp no mapa de integracoes (${motivoErro(e)}); a ponte segue normalmente`);
        fim();
      }
    });
  }

  return { anotar };
}
