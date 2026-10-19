// Saida de arquivos: valida o caminho pedido pelo agente e monta a mensagem do Baileys.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITE_ARQUIVO_SAIDA } from './limites.mjs';
import { falha, motivoErro } from './util.mjs';

/** `raizesArquivo`: as pastas de onde o agente pode mandar arquivo (por padrao, so a casa). */
export function criarEnvioArquivo({ home, raizesArquivo }) {
  // Lista de PERMITIDAS, nao de proibidas: o arquivo tem que estar na casa do agente e nenhum
  // pedaco do caminho, a partir da raiz, pode comecar com ponto. Isso barra ~/.dgclaw, ~/.claude,
  // ~/.codex, ~/.ssh, ~/.config e qualquer segredo futuro sem precisar lembrar de cada um.
  // So a casa e raiz: nada de pasta em /tmp, que qualquer processo poderia trocar por um atalho.
  // A raiz tem que ser ela mesma (realpath igual ao caminho); raiz que e atalho e recusada.
  function dentroDeRaizPermitida(alvo) {
    return raizesArquivo.some((r) => {
      const rel = path.relative(path.resolve(r), alvo);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
      return !rel.split(path.sep).some((parte) => parte.startsWith('.'));
    });
  }

  /**
   * Valida e ABRE o arquivo uma vez so. Devolve { fd, tamanho } (quem chama fecha o fd) ou
   * { erro }. Depois da abertura tudo o que se confere e se le vem do fd, nunca do caminho:
   * trocar o arquivo por um atalho entre a conferencia e a leitura nao muda nada.
   */
  function validarArquivo(caminho) {
    const ondeFica = 'copie o arquivo para uma pasta da sua casa que nao comece com ponto, como ~/saida/, e envie de la';
    const recusa = (msg) => ({ erro: falha('ARQUIVO', msg) });
    if (typeof caminho !== 'string' || !path.isAbsolute(caminho)) {
      return recusa(`o caminho "${String(caminho).slice(0, 80)}" nao e absoluto; informe o caminho completo, como ${home}/saida/relatorio.pdf`);
    }
    for (const r of raizesArquivo) {
      let real;
      try { real = fs.realpathSync(r); } catch { continue; }
      if (real !== path.resolve(r)) {
        return recusa(`a pasta liberada ${r} e um atalho para ${real}; por seguranca nada sai por ela. Avise o dono para conferir quem criou esse atalho`);
      }
    }
    const pedido = path.resolve(caminho);
    let lst;
    let real;
    try {
      lst = fs.lstatSync(pedido);
      real = fs.realpathSync(pedido);
    } catch (e) {
      return recusa(`nao achei o arquivo ${caminho} (${e.code || motivoErro(e)}); confira o caminho`);
    }
    if (!dentroDeRaizPermitida(pedido) || !dentroDeRaizPermitida(real)) {
      return recusa(`${caminho} fica fora das pastas liberadas para envio (a sua casa, sem pastas que comecem com ponto); ${ondeFica}`);
    }
    if (!lst.isFile()) {
      return recusa(`${caminho} nao e um arquivo comum (e pasta, atalho, fila ou dispositivo); envie o arquivo em si`);
    }
    let fd = null;
    try {
      // O_NOFOLLOW: se alguem trocou o arquivo por um atalho agora, a abertura falha.
      fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return recusa(`${caminho} nao e um arquivo comum; envie o arquivo em si`);
      if (st.dev !== lst.dev || st.ino !== lst.ino) {
        return recusa(`${caminho} mudou enquanto era conferido; tente de novo`);
      }
      if (st.nlink > 1) {
        return recusa(`${caminho}: o arquivo tem mais de um nome no disco; copie para ~/saida/ com cp e mande a copia`);
      }
      if (st.size > LIMITE_ARQUIVO_SAIDA) {
        return recusa(`${caminho} tem ${Math.round(st.size / 1048576)} MB e o limite e 64 MB; envie uma versao menor`);
      }
      // Onde o fd aponta de verdade agora (o kernel responde, nao o nome).
      const doFd = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (!dentroDeRaizPermitida(doFd)) {
        return recusa(`${caminho} aponta para fora das pastas liberadas; ${ondeFica}`);
      }
      const aberto = fd;
      fd = null;
      return { fd: aberto, tamanho: st.size };
    } catch (e) {
      return recusa(`nao consegui abrir ${caminho} com seguranca (${e.code || motivoErro(e)}); confira se e um arquivo comum da sua casa`);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  const MIME_AUDIO = { ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
  const MIME_DOC = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip' };

  function montarEnvioArquivo(fd, nomeOriginal, legenda) {
    const buf = fs.readFileSync(fd);
    const ext = path.extname(nomeOriginal).slice(1).toLowerCase();
    const cap = legenda ? { caption: legenda } : {};
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return { image: buf, ...cap };
    if (MIME_AUDIO[ext]) return { audio: buf, mimetype: MIME_AUDIO[ext] };
    if (ext === 'mp4') return { video: buf, ...cap };
    return { document: buf, mimetype: MIME_DOC[ext] || 'application/octet-stream', fileName: path.basename(nomeOriginal), ...cap };
  }

  return { validarArquivo, montarEnvioArquivo };
}
