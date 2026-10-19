// cofre-cifra.js: a cifragem do cofre (systemd-creds ou AES-256-GCM local), as pastas e o log de falha.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ─── A cifragem ──────────────────────────────────────────────────────────────
//
// DOIS MOTORES, e o store guarda em qual deles cada segredo foi cifrado, para que
// uma máquina que ganhe o motor bom depois não perca o que já estava guardado.
//
//   `systemd-creds` (preferido): a chave mestra é a do host, em
//     /var/lib/systemd/credential.secret, modo 0400 root. Um `tar` da pasta do
//     agente leva o segredo cifrado e NÃO leva a chave, que é justamente o que a
//     regra 3 pede.
//
//   `local` (alternativa): AES-256-GCM com chave num arquivo separado, fora da
//     pasta do cofre. Protege contra quem lê o store e não protege contra uma
//     cópia da pasta inteira do agente. É pior, e por isso o `estado()` conta
//     qual dos dois está em uso, e a tela mostra.

function temSystemdCreds() {
  try {
    execFileSync('systemd-creds', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * `DIR` e `SEGREDOS` sao as pastas do cofre; `CHAVE_MESTRA`, o arquivo da chave do motor `local`
 * (fora de `DIR`, de proposito).
 */
function criarCifra({ slug, DIR, SEGREDOS, CHAVE_MESTRA }) {
  const MOTOR = temSystemdCreds() ? 'systemd-creds' : 'local';

  function garantirPastas() {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(SEGREDOS, { recursive: true, mode: 0o700 });
    // `mkdirSync` só aplica o modo na criação. Um cofre que veio de uma versão
    // anterior, ou de um `umask` diferente, é corrigido aqui em vez de continuar
    // frouxo para sempre.
    try { fs.chmodSync(DIR, 0o700); } catch { /* sistema de arquivos sem modo */ }
    try { fs.chmodSync(SEGREDOS, 0o700); } catch { /* idem */ }
  }

  function chaveMestra() {
    try {
      const k = fs.readFileSync(CHAVE_MESTRA);
      if (k.length === 32) return k;
    } catch { /* ainda não existe */ }
    const nova = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(CHAVE_MESTRA), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CHAVE_MESTRA, nova, { mode: 0o600 });
    try { fs.chmodSync(CHAVE_MESTRA, 0o600); } catch { /* idem */ }
    return nova;
  }

  /** Texto puro entrando, blob cifrado saindo. Devolve `{ motor, blob }`. */
  function cifrar(nome, valor) {
    if (MOTOR === 'systemd-creds') {
      try {
        const blob = execFileSync(
          'systemd-creds',
          ['encrypt', '--name', nome, '--with-key=host', '-', '-'],
          // `stdio` com stderr em `pipe` e não herdado: o systemd-creds escreve
          // avisos de rotina na saída de erro ("não está em mídia cifrada"), e
          // herdada ela iria parar no log do painel a cada gravação, virando
          // ruído que esconde o aviso que importa. Em caso de falha o texto vem
          // dentro do erro, e o `registrarFalha` o mostra.
          { input: valor, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        return { motor: 'systemd-creds', blob };
      } catch (err) {
        // Cai para o motor local em vez de recusar a gravação: o dono do agente
        // não tem como consertar systemd nenhum, e uma chave guardada de um jeito
        // pior é melhor do que uma tela que não deixa guardar. O `estado()` conta
        // qual motor guardou cada uma, então isso não vira segredo de ninguém.
        registrarFalha('cifrar com systemd-creds', err);
      }
    }
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', chaveMestra(), iv);
    const dados = Buffer.concat([c.update(valor, 'utf-8'), c.final()]);
    return { motor: 'local', blob: Buffer.concat([iv, c.getAuthTag(), dados]) };
  }

  /**
   * Blob cifrado entrando, texto puro saindo. Só a materialização chama.
   *
   * O `--name` NÃO É COSMÉTICO na decifragem. O nome vai cifrado junto com o
   * segredo, e passá-lo aqui faz o systemd-creds conferir se o blob é mesmo o
   * daquela variável. Sem ele, trocar o arquivo `OPENAI_API_KEY.enc` pelo
   * `DATABASE_URL.enc` passaria batido, e o agente sairia usando um segredo com o
   * nome de outro.
   */
  function decifrar(motor, blob, nome) {
    if (motor === 'systemd-creds') {
      return execFileSync(
        'systemd-creds',
        ['decrypt', '--name', nome, '-', '-'],
        { input: blob, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString('utf-8');
    }
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', chaveMestra(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf-8');
  }

  /**
   * O log de falha do cofre. NUNCA recebe valor de segredo, e é por isso que ele
   * é uma função e não um `console.error` solto: o único jeito de garantir que
   * ninguém vai passar o valor "só para depurar" é não existir um caminho que
   * aceite.
   */
  function registrarFalha(oQue, err) {
    const motivo = err && err.message ? err.message : String(err);
    // O que o programa externo escreveu na saída de erro entra aqui, porque é
    // ele que diz o motivo de verdade ("chave do host não existe", por exemplo).
    // Ele nunca contém o valor: o segredo vai pela entrada padrão, não pela
    // linha de comando.
    const dele = err && err.stderr ? ` ${String(err.stderr).trim()}` : '';
    console.error(`[cofre:${slug}] falhou ao ${oQue}: ${motivo}${dele}`);
  }

  return { MOTOR, garantirPastas, cifrar, decifrar, registrarFalha };
}

module.exports = { criarCifra, temSystemdCreds };
