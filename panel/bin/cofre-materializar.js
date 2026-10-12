#!/usr/bin/env node
//
// cofre-materializar.js — decifra o cofre do agente e escreve o arquivo de
// ambiente que ele lê ao iniciar.
//
// QUEM CHAMA: o `ExecStartPre=` da unidade do agente, uma vez por inicialização.
// Não é cron e não roda sozinho.
//
// POR QUE O ARQUIVO NÃO É GERADO DE UMA VEZ E DEIXADO NO DISCO: porque aí o
// segredo em texto puro passaria a viver num arquivo permanente, e a regra 3 do
// cofre (`panel/docs/COFRE.md`) existe justamente
// porque modo 600 não protege contra backup, snapshot ou um `tar` distraído. Aqui
// o texto puro nasce em `/run` (memória), com modo 600, e some quando a máquina
// desliga. O que fica no disco é só o cifrado.
//
// O CÓDIGO DE SAÍDA IMPORTA, e é a regra 9 dos padrões de construção do Danilo:
// erro que se explica sozinho. Se o cofre não abrir, este script sai com código
// diferente de zero e a mensagem diz o que houve. O agente NÃO sobe achando que
// tem chave. Sair com zero e um arquivo pela metade seria o pior dos mundos: o
// agente subiria, trabalharia, e falharia num 401 três dias depois, longe daqui.
//
// COMO PENDURAR NA UNIDADE (o `-` no ExecStartPre NÃO deve ser usado: ele faria o
// systemd ignorar a falha, que é exatamente o contrário do parágrafo acima):
//
//   [Service]
//   ExecStartPre=/usr/bin/node /caminho/do/painel/bin/cofre-materializar.js
//   EnvironmentFile=/run/dgclaw/<slug>.env
//   ExecStopPost=/bin/rm -f /run/dgclaw/<slug>.env
//
// E o script precisa saber de qual agente ele está falando, igual ao painel:
//
//   Environment=DGCLAW_PANEL_CONFIG=/caminho/do/agente/.dgclaw/panel/config.json
//
// NO AGENTE DE PLUGIN, que sobe por `launch.sh` e lê `config.sh` em vez de
// `EnvironmentFile=`, o `config.sh` ganha UMA linha, e nunca o valor de um
// segredo:
//
//   set -a; . /run/dgclaw/<slug>.env; set +a
//
// A razão de o `config.sh` não receber o valor direto está no topo de
// `lib/cofre.js`: ele é script de shell, e valor com `$(...)` dentro de script de
// shell deixa de ser configuração e vira comando.

const path = require('path');
const { loadConfig } = require('../lib/config');
const { buildCofre } = require('../lib/cofre');

const config = loadConfig(path.join(__dirname, '..'));
const cofre = buildCofre(config);

const r = cofre.materializar();

if (r.erro) {
  console.error(`[cofre] NÃO consegui preparar o ambiente do agente: ${r.erro}`);
  console.error('[cofre] O agente não vai subir sem isso, de propósito: melhor não subir do que subir sem as chaves.');
  process.exit(1);
}

if (r.falhas && r.falhas.length) {
  // Chave que não abriu é falha DURA, e não aviso. Uma chave que não decifra
  // quase sempre quer dizer que o arquivo cifrado foi copiado de outra máquina
  // (o motor `systemd-creds` amarra o segredo à máquina que cifrou), e nesse caso
  // o agente subiria sem a chave e ninguém saberia por quê.
  console.error(`[cofre] Estas chaves estão no cofre e não abriram nesta máquina: ${r.falhas.join(', ')}.`);
  console.error('[cofre] Se o cofre veio de outra máquina, cadastre essas chaves de novo pelo painel: ' +
    'o segredo é cifrado com a chave desta máquina e não viaja junto com o arquivo.');
  process.exit(2);
}

console.log(`[cofre] ${r.chaves} ${r.chaves === 1 ? 'chave preparada' : 'chaves preparadas'} em ${r.arquivo}.`);
