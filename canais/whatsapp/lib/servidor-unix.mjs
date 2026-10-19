// O socket unix por onde as tools do agente pedem envios a ponte (uma linha JSON por conexao).
import fs from 'node:fs';
import net from 'node:net';
import { LIMITE_LINHA_SOCKET } from './limites.mjs';
import { falha, motivoErro } from './util.mjs';

/** `aoSubir(servidor)` guarda o servidor para a ponte poder fecha-lo ao encerrar. */
export function subirSocketUnix({ arqSocket, arqLog, timeoutLeitura, timeoutExecTexto, timeoutExecArquivo, tratarPedido, registrar, aoSubir }) {
  return new Promise((resolve, reject) => {
    try {
      const st = fs.lstatSync(arqSocket);
      if (!st.isSocket()) {
        reject(new Error(`${arqSocket} existe e nao e um socket; apague-o a mao ou rode "dgclaw-agente canal whatsapp desligar"`));
        return;
      }
      fs.unlinkSync(arqSocket);
    } catch (e) {
      if (e.code !== 'ENOENT') { reject(e); return; }
    }
    const srv = net.createServer((c) => {
      let buf = Buffer.alloc(0);
      let respondido = false;
      const responder = (obj) => {
        if (respondido) return;
        respondido = true;
        clearTimeout(timeout);
        c.end(JSON.stringify(obj) + '\n');
      };
      // Prazo para o cliente mandar a linha. Cai assim que a linha chega; a execucao do
      // pedido tem prazo proprio, maior (enviar arquivo grande demora).
      const timeout = setTimeout(() => {
        responder(falha('PEDIDO_INVALIDO', `a conexao ficou ${Math.round(timeoutLeitura / 1000)} segundos sem mandar a linha do pedido`));
      }, timeoutLeitura);
      timeout.unref();
      let timeoutExec = null;
      const tratar = (bytes) => {
        clearTimeout(timeout);
        const linha = bytes.toString('utf8').trim();
        let acao = null;
        try { acao = JSON.parse(linha).acao; } catch { /* o tratarPedido explica a linha invalida */ }
        const limite = acao === 'arquivo' ? timeoutExecArquivo : timeoutExecTexto;
        const estouro = new Promise((r) => {
          timeoutExec = setTimeout(() => r(falha('FALHA_ENVIO', `o envio passou de ${Math.round(limite / 1000)} segundos sem resposta; a mensagem pode ou nao ter saido. Nao repita as cegas: confira no celular antes de mandar de novo`)), limite);
        });
        Promise.race([
          tratarPedido(linha).catch((e) => {
            registrar(`erro inesperado ao tratar um pedido do socket: ${motivoErro(e)}`);
            return falha('FALHA_ENVIO', `erro inesperado na ponte (${motivoErro(e)}); veja ${arqLog}`);
          }),
          estouro,
        ]).then((r) => { clearTimeout(timeoutExec); responder(r); });
      };
      let recebido = false;
      c.on('data', (parte) => {
        if (respondido || recebido) return;
        buf = Buffer.concat([buf, parte]);
        const nl = buf.indexOf(0x0a);
        if (nl >= 0) { recebido = true; tratar(buf.subarray(0, nl)); return; }
        if (buf.length > LIMITE_LINHA_SOCKET) {
          responder(falha('PEDIDO_INVALIDO', `a linha passou de ${LIMITE_LINHA_SOCKET} bytes; para arquivos use a acao "arquivo" com o caminho`));
        }
      });
      c.on('end', () => {
        // Cliente que fechou sem enviar "\n": trata o que veio.
        if (respondido || recebido) return;
        if (buf.length > 0) { recebido = true; tratar(buf); } else {
          responder(falha('PEDIDO_INVALIDO', 'a conexao fechou sem mandar nenhum pedido'));
        }
      });
      c.on('error', (e) => registrar(`erro numa conexao do socket ${arqSocket}: ${motivoErro(e)}`));
    });
    srv.once('error', reject);
    srv.listen(arqSocket, () => {
      try {
        fs.chmodSync(arqSocket, 0o600);
      } catch (e) {
        srv.close();
        reject(new Error(`nao consegui fechar a permissao de ${arqSocket} (${motivoErro(e)})`));
        return;
      }
      aoSubir(srv);
      resolve();
    });
  });
}
