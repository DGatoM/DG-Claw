// Mapa LID -> numero (lids.json). O WhatsApp pode entregar o remetente como "123@lid" e nem
// sempre manda o numero junto; sem este mapa o dono permitido seria recusado como oculto.
import fs from 'node:fs';
import path from 'node:path';
import { normalizar } from './numeros.mjs';
import { motivoErro } from './util.mjs';

/**
 * `obterSocketConectado` devolve o socket do Baileys quando a ponte esta conectada, ou null.
 * `pendentes` e o conjunto de tarefas em andamento que os testes esperam terminar.
 */
export function criarLids({ dir, registrar, gravarAtomico, lerPermitidos, obterSocketConectado, estaEncerrando, pendentes }) {
  const arqLids = path.join(dir, 'lids.json');
  const lids = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(arqLids, 'utf8'));
    for (const [lid, n] of Object.entries((j && j.lids) || {})) {
      const norm = normalizar(n);
      if (/@lid$/.test(lid) && norm) lids.set(lid, norm);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') registrar(`o ${arqLids} esta ilegivel (${motivoErro(e)}); o mapa de LID recomeca vazio e se refaz sozinho.`);
  }

  function aprenderLid(lid, numero) {
    const norm = normalizar(numero);
    if (typeof lid !== 'string' || !lid.endsWith('@lid') || !norm) return;
    if (lids.get(lid) === norm) return;
    lids.delete(lid);
    lids.set(lid, norm);
    if (lids.size > 5000) lids.delete(lids.keys().next().value);
    try {
      gravarAtomico(arqLids, JSON.stringify({ versao: 1, lids: Object.fromEntries(lids) }) + '\n');
    } catch (e) {
      registrar(`nao consegui gravar ${arqLids}: ${motivoErro(e)}. O mapa vale so ate a ponte reiniciar.`);
    }
  }

  let sincronizandoLids = false;
  let sincronizarDeNovo = false;
  /** Pergunta ao WhatsApp o LID de cada numero da lista de permitidos. Falha vira linha de log. */
  async function sincronizarLids() {
    const sock = obterSocketConectado();
    if (!sock) return;
    if (sincronizandoLids) { sincronizarDeNovo = true; return; }
    sincronizandoLids = true;
    try {
      do {
        sincronizarDeNovo = false;
        for (const numero of lerPermitidos()) {
          try {
            const r = await sock.onWhatsApp(numero.slice(1));
            const achado = Array.isArray(r) ? r.find((x) => x && x.exists !== false && x.lid) : null;
            if (achado) aprenderLid(String(achado.lid).includes('@') ? String(achado.lid) : `${achado.lid}@lid`, numero);
          } catch (e) {
            registrar(`nao consegui perguntar ao WhatsApp o LID de ${numero}: ${motivoErro(e)}. Se ele escrever e for recusado como numero oculto, mande a mensagem de novo depois de a ponte reconectar.`);
          }
        }
      } while (sincronizarDeNovo && !estaEncerrando());
    } finally {
      sincronizandoLids = false;
    }
  }

  function agendarSincronizacaoLids() {
    const p = sincronizarLids()
      .catch((e) => registrar(`erro ao sincronizar os LID: ${motivoErro(e)}`))
      .finally(() => pendentes.delete(p));
    pendentes.add(p);
  }

  return { lids, aprenderLid, agendarSincronizacaoLids };
}
