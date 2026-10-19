// Entrada: mensagem do WhatsApp -> agente.
import fs from 'node:fs';
import path from 'node:path';
import { GUARDAR_IDS, LIMITE_MIDIA_ENTRADA } from './limites.mjs';
import { numeroDeJid } from './numeros.mjs';
import { dataLocal, escaparCorpo, extensaoDe, horaLocal, motivoErro, numeroDe } from './util.mjs';

export function criarEntrada({ opcoes, registrar, agora, lids, aprenderLid, estaPermitido, entregar, gravarAtomico, arqUltimo, dirUploads, downloadMediaMessage, pendentes }) {
  const idsVistos = new Set();

  const recusasRecentes = new Map();
  const intervaloRecusa = opcoes.intervaloRecusaMs ?? 600000;
  function deveLogarRecusa(chave) {
    const t = agora().getTime();
    const ultima = recusasRecentes.get(chave);
    if (ultima !== undefined && t - ultima < intervaloRecusa) return false;
    recusasRecentes.delete(chave);
    recusasRecentes.set(chave, t);
    if (recusasRecentes.size > 1000) recusasRecentes.delete(recusasRecentes.keys().next().value);
    return true;
  }

  function jaVisto(id) {
    if (!id) return false;
    if (idsVistos.has(id)) return true;
    idsVistos.add(id);
    if (idsVistos.size > GUARDAR_IDS) idsVistos.delete(idsVistos.values().next().value);
    return false;
  }

  function desembrulhar(m) {
    let atual = m;
    for (let i = 0; i < 4 && atual; i++) {
      const dentro = atual.ephemeralMessage?.message || atual.viewOnceMessage?.message ||
        atual.viewOnceMessageV2?.message || atual.viewOnceMessageV2Extension?.message ||
        atual.documentWithCaptionMessage?.message || atual.editedMessage?.message;
      if (!dentro) break;
      atual = dentro;
    }
    return atual;
  }

  function remetente(key) {
    const jid = key.remoteJid;
    if (typeof jid !== 'string') return null;
    if (jid.endsWith('@lid')) {
      // Em LID o numero de verdade pode vir em outro campo (e entao aprendemos o par), ou estar no
      // mapa que a ponte foi guardando. Sem nenhum dos dois, nao ha como conferir a lista.
      const pn = numeroDeJid(key.senderPn) || numeroDeJid(key.participantPn) || numeroDeJid(key.remoteJidAlt);
      if (pn) { aprenderLid(jid, pn); return pn; }
      return lids.get(jid) || null;
    }
    return numeroDeJid(jid);
  }

  const ROTULO_MIDIA = { imageMessage: 'imagem', audioMessage: 'áudio', videoMessage: 'vídeo', documentMessage: 'documento' };

  async function montarCorpo(msg, conteudo, tipo, id) {
    if (tipo === 'conversation') return String(conteudo.conversation);
    if (tipo === 'extendedTextMessage') return String(conteudo.extendedTextMessage.text || '');
    if (ROTULO_MIDIA[tipo]) {
      const m = conteudo[tipo];
      const rotulo = ROTULO_MIDIA[tipo];
      const legenda = m.caption ? String(m.caption) : '';
      const tamanho = numeroDe(m.fileLength);
      let marca;
      if (Number.isFinite(tamanho) && tamanho > LIMITE_MIDIA_ENTRADA) {
        marca = `[${rotulo} acima de 25 MB, que a ponte não baixa]`;
      } else {
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {});
          if (buf.length > LIMITE_MIDIA_ENTRADA) {
            marca = `[${rotulo} acima de 25 MB, que a ponte não guarda]`;
          } else {
            const pasta = path.join(dirUploads, dataLocal(agora()));
            fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
            const arq = path.join(pasta, `${id}.${extensaoDe(m.mimetype, m.fileName)}`);
            fs.writeFileSync(arq, buf, { mode: 0o600 });
            fs.chmodSync(arq, 0o600);
            marca = `[${rotulo} salvo em ${arq}]`;
          }
        } catch (e) {
          registrar(`nao consegui baixar a midia ${id} (${rotulo}): ${motivoErro(e)}. A mensagem segue sem o arquivo.`);
          marca = `[${rotulo} que a ponte não conseguiu baixar]`;
        }
      }
      return legenda ? `${marca}\n${legenda}` : marca;
    }
    return `[mensagem do tipo ${tipo}, que a ponte ainda não lê]`;
  }

  async function processarMensagem(sock, msg) {
    const key = msg && msg.key;
    if (!key || key.fromMe) return;
    const jid = key.remoteJid;
    if (typeof jid !== 'string') return;
    if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    if (!msg.message) return;
    const conteudo = desembrulhar(msg.message);
    if (!conteudo) return;
    const tipo = Object.keys(conteudo).find((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
    if (!tipo || tipo === 'reactionMessage' || tipo === 'protocolMessage') return;
    const numero = remetente(key);
    if (!numero || !estaPermitido(numero)) {
      // No maximo uma linha por numero a cada 10 minutos: um desconhecido insistente nao
      // enche o log. O id dele tambem nao entra no Set de ids vistos (so aceitos entram).
      if (deveLogarRecusa(numero || 'oculto')) {
        const hora = horaLocal(agora());
        registrar(numero ? `recusado ${numero} às ${hora}` : `recusado (número oculto) às ${hora}`);
      }
      return;
    }
    if (jaVisto(key.id)) return;

    const id = String(key.id || '').replace(/[^A-Za-z0-9_-]/g, '') || 'sem-id';
    const corpo = await montarCorpo(msg, conteudo, tipo, id);
    const seg = numeroDe(msg.messageTimestamp);
    const quando = Number.isFinite(seg) && seg > 0 ? new Date(seg * 1000) : agora();
    const envelope = `<canal-externo origem="whatsapp" de="${numero}" msg="${id}" ts="${quando.toISOString()}">${escaparCorpo(corpo)}</canal-externo>`;

    const r = await entregar(envelope);
    if (!r.ok) {
      registrar(`nao entreguei a mensagem ${id} de ${numero} ao agente: ${r.motivo}`);
      const aviso = r.status === 409
        ? 'Sua mensagem não chegou ao agente: ele está sem login ou sem chave. Avise o dono para abrir o painel do DG Claw.'
        : 'Sua mensagem não chegou ao agente agora. Tente de novo daqui a pouco.';
      try {
        await sock.sendMessage(jid, { text: aviso });
      } catch (e) {
        registrar(`nao consegui avisar ${numero} que a mensagem ${id} falhou: ${motivoErro(e)}`);
      }
      return;
    }
    try {
      gravarAtomico(arqUltimo, JSON.stringify({ numero, ts: agora().toISOString() }) + '\n');
    } catch (e) {
      registrar(`nao consegui gravar ${arqUltimo}: ${motivoErro(e)}. Respostas sem destino explicito podem falhar.`);
    }
    try {
      await sock.readMessages([key]);
    } catch (e) {
      registrar(`nao consegui marcar a mensagem ${id} como lida: ${motivoErro(e)}`);
    }
  }

  function aoReceber(sock, { messages, type }) {
    if (type !== 'notify' || !Array.isArray(messages)) return;
    for (const msg of messages) {
      const p = processarMensagem(sock, msg)
        .catch((e) => registrar(`erro ao tratar uma mensagem recebida: ${motivoErro(e)}`))
        .finally(() => pendentes.delete(p));
      pendentes.add(p);
    }
  }

  return { aoReceber };
}
