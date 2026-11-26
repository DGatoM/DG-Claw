// Saida: pedidos do agente (socket unix) -> mensagem no WhatsApp.
import fs from 'node:fs';
import { LIMITE_TEXTO } from './limites.mjs';
import { motivoNumeroInvalido, normalizar } from './numeros.mjs';
import { falha, motivoErro } from './util.mjs';

/** `ligacao()` diz, na hora do pedido, se a ponte esta conectada e qual e o socket do Baileys. */
export function criarPedidos({ memoria, lerPermitidos, estaPermitido, validarArquivo, montarEnvioArquivo, ligacao, envioSeguro }) {
  const jids = new Map();

  // Sem "para", so ha destino padrao quando a lista tem exatamente um numero. Com dois ou mais,
  // "quem mandou a ultima mensagem" seria um palpite: uma resposta ao dono podia sair para outra
  // pessoa liberada. O agente passa sempre o "para" do envelope que esta respondendo.
  function destinoPadrao() {
    const lista = lerPermitidos();
    return lista.length === 1 ? lista[0] : null;
  }

  async function resolverJid(sock, numero) {
    const chave = numero.replace(/\D/g, '');
    if (jids.has(chave)) return jids.get(chave);
    const r = await sock.onWhatsApp(chave);
    const achado = Array.isArray(r) ? r.find((x) => x && x.exists !== false && x.jid) : null;
    if (!achado) return null;
    jids.set(chave, achado.jid);
    return achado.jid;
  }

  async function tratarPedido(linha) {
    const inicio = Date.now(); // o prazo conta do pedido recebido, nao de quando a fila chega a vez dele
    let p;
    try {
      p = JSON.parse(linha);
    } catch (e) {
      return falha('PEDIDO_INVALIDO', `a linha nao e JSON valido (${motivoErro(e)}); mande uma linha como {"acao":"enviar","texto":"..."}`);
    }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return falha('PEDIDO_INVALIDO', 'o pedido tem que ser um objeto JSON');
    if (p.acao !== 'enviar' && p.acao !== 'arquivo') {
      return falha('PEDIDO_INVALIDO', `acao "${String(p.acao).slice(0, 30)}" desconhecida; use "enviar" ou "arquivo"`);
    }
    if (p.acao === 'enviar') {
      if (typeof p.texto !== 'string' || !p.texto.trim()) return falha('PEDIDO_INVALIDO', 'o texto esta vazio; escreva a mensagem');
      if (p.texto.length > LIMITE_TEXTO) return falha('PEDIDO_INVALIDO', `o texto tem ${p.texto.length} caracteres e o limite e ${LIMITE_TEXTO}; divida em mensagens menores`);
    } else {
      if (typeof p.caminho !== 'string' || !p.caminho) return falha('PEDIDO_INVALIDO', 'falta o campo "caminho" (caminho absoluto do arquivo)');
      if (p.legenda != null && typeof p.legenda !== 'string') return falha('PEDIDO_INVALIDO', 'a legenda tem que ser texto');
    }

    let numero;
    if (p.para != null && p.para !== '') {
      numero = normalizar(p.para);
      if (!numero) return falha('PEDIDO_INVALIDO', motivoNumeroInvalido(p.para));
      if (!estaPermitido(numero)) {
        return falha('FORA_DA_LISTA', `${numero} nao esta na lista de permitidos; so o dono pode liberar, com "dgclaw-agente canal whatsapp permitir ${numero}"`);
      }
    } else {
      numero = destinoPadrao();
      if (!numero) {
        const n = lerPermitidos().length;
        return falha('SEM_DESTINO', n === 0
          ? 'a lista de permitidos esta vazia; o dono libera um numero com "dgclaw-agente canal whatsapp permitir <numero>"'
          : 'ha mais de um numero na lista; passe em "para" o numero do atributo "de" do envelope que voce esta respondendo');
      }
    }

    let arq = null;
    if (p.acao === 'arquivo') {
      arq = validarArquivo(p.caminho);
      if (arq.erro) return arq.erro;
    }
    // O fd fecha em qualquer saida daqui para baixo (erro, DESCONECTADO, sucesso).
    try {
      const { conectado, sock } = ligacao();
      if (!conectado || !sock) {
        return falha('DESCONECTADO', 'a ponte nao esta conectada ao WhatsApp agora (reconectando ou deslogada); tente de novo em instantes ou confira "dgclaw-agente canal status"');
      }

      let jid;
      try {
        jid = await resolverJid(sock, numero);
      } catch (e) {
        return falha('FALHA_ENVIO', `nao consegui perguntar ao WhatsApp se ${numero} tem conta (${motivoErro(e)}); tente de novo`);
      }
      if (!jid) return falha('SEM_WHATSAPP', `${numero} nao tem conta no WhatsApp; confira o numero`);

      let conteudo;
      try {
        conteudo = p.acao === 'enviar'
          ? { text: p.texto }
          : montarEnvioArquivo(arq.fd, p.caminho, p.legenda);
      } catch (e) {
        return falha('FALHA_ENVIO', `nao consegui preparar o envio para ${numero} (${motivoErro(e)}); nada foi enviado`);
      }
      // As travas contra banimento (ritmo, teto, texto repetido, trava no primeiro erro) ficam em
      // envio-seguro.mjs. O erro do WhatsApp vira FALHA_ENVIO la dentro, junto com a trava.
      const r = await envioSeguro.enviar({
        para: numero,
        texto: p.acao === 'enviar' ? p.texto : (p.legenda || ''),
        // O socket e lido na hora de enviar: uma reconexao durante a espera troca o socket.
        executar: () => ligacao().sock.sendMessage(jid, conteudo),
        // Menor que o prazo do socket (75 s texto, 120 s arquivo): pedido que ficou velho na fila nao e enviado.
        prazoMs: (p.acao === 'enviar' ? 65000 : 105000) - (Date.now() - inicio),
        // A lista pode ter mudado durante a espera da fila: o dono removeu o numero, a mensagem nao sai.
        conferir: () => {
          if (!estaPermitido(numero)) return falha('FORA_DA_LISTA', `${numero} saiu da lista de permitidos enquanto o pedido esperava; nada foi enviado`);
          // Queda durante a espera nao e erro de envio: nada saiu, nao trava, tente de novo.
          const l = ligacao();
          if (!l.conectado || !l.sock) return falha('DESCONECTADO', 'a conexao caiu enquanto o pedido esperava; nada foi enviado e nada foi travado. Tente de novo em instantes');
          return null;
        },
      });
      if (!r.ok) return r;
      const envio = r.resultado;
      const idEnviado = envio && envio.key && envio.key.id;
      // Guarda o que de fato saiu: o audio, por exemplo, vai sem a legenda pedida.
      const enviado = conteudo.text || conteudo.caption;
      if (enviado) memoria.lembrar((envio && envio.key && envio.key.remoteJid) || jid, idEnviado, enviado);
      const ok = { ok: true, para: numero, id: idEnviado || null };
      if (r.aviso) ok.aviso = r.aviso;
      return ok;
    } finally {
      if (arq && arq.fd != null) fs.closeSync(arq.fd);
    }
  }

  return { tratarPedido };
}
