'use strict';
// Identificador da INSTÂNCIA de um agente: muda quando o agente é removido e criado de novo com o mesmo nome (o slug,
// o agente_id e o chat_id são derivados do nome e voltam iguais). O convite de um colaborador guarda este valor.
//
// 1. `instancia` do agentes.json, gravado pelo `dgclaw agente criar` (aleatório, novo a cada criação);
// 2. agentes criados antes desse campo: a casa do agente (uid e inode de home_host). O `remover` move a casa para
//    aposentados/ e a faixa de uid fica queimada, então um agente recriado nasce com outra casa e outro uid;
// 3. sem nenhum dos dois: null (um convite que guardou valor não bate com null: fica inválido).

const fs = require('node:fs');

function instanciaDe(agente) {
  if (!agente) return null;
  if (agente.instancia) return `i:${agente.instancia}`;
  if (agente.home_host) {
    try {
      const st = fs.statSync(agente.home_host);
      return `casa:${st.uid}:${st.ino}`;
    } catch (_) { return null; }
  }
  return null;
}

module.exports = { instanciaDe };
