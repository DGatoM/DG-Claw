'use strict';
/* provedores.js: a lista das IAs (provedores) que o DG Claw conhece, num lugar só.

   O mesmo arquivo serve ao navegador (window.DGProvedores, via conectar-puro.js) e ao servidor
   (require, em lib/login.js). Para ligar uma IA nova, acrescente uma linha aqui com ativo:true; para
   desligar, ativo:false. Hoje todo agente usa a IA em que nasceu: a troca de IA de um agente que já
   existe ainda não está disponível (o servidor recusa com uma explicação). */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGProvedores = m;
})(this, function () {
  const PROVEDORES = [
    { id: 'claude', nome: 'Claude', ativo: true },
    { id: 'codex', nome: 'Codex', ativo: true },
  ];

  /** O id canônico ('claude' ou 'codex') de qualquer texto que o runner ou o registro mande; vazio cai em claude. */
  function idDoProvedor(texto) {
    return /codex/i.test(String(texto || '')) ? 'codex' : 'claude';
  }

  /** O provedor da lista pelo id exato (sem maiúsculas), ou null. */
  function acha(id, lista) {
    const l = Array.isArray(lista) ? lista : PROVEDORES;
    const k = typeof id === 'string' ? id.trim().toLowerCase() : '';
    return l.find(p => p.id === k) || null;
  }

  /**
   * Valida o `provedor` que o front mandou ao começar um login. Sem `provedor` (undefined, null, ''): vale o
   * atual, ok. Devolve { ok:true } ou { ok:false, erro } com a frase em português.
   * `atual` é o id do provedor do agente hoje.
   */
  function valida(pedido, atual, lista) {
    if (pedido === undefined || pedido === null || pedido === '') return { ok: true };
    if (typeof pedido !== 'string') return { ok: false, erro: 'O campo "provedor" precisa ser um texto, como "claude" ou "codex". Nada foi iniciado.' };
    const l = Array.isArray(lista) ? lista : PROVEDORES;
    const p = acha(pedido, l);
    const conhecidos = l.filter(x => x.ativo).map(x => x.id).join(', ');
    if (!p) return { ok: false, erro: 'Não conheço a IA "' + pedido.slice(0, 40) + '". As disponíveis são: ' + conhecidos + '. Nada foi iniciado.' };
    if (!p.ativo) return { ok: false, erro: 'A IA ' + p.nome + ' ainda não está disponível no DG Claw. As disponíveis são: ' + conhecidos + '. Nada foi iniciado.' };
    if (p.id !== idDoProvedor(atual)) {
      const nomeAtual = (acha(idDoProvedor(atual), l) || {}).nome || idDoProvedor(atual);
      return { ok: false, erro: 'Este agente usa ' + nomeAtual + ' e trocar para ' + p.nome + ' ainda não está disponível. Conecte a conta de ' + nomeAtual + ' ou peça ao Admin para criar um agente novo com ' + p.nome + '. Nada foi iniciado.' };
    }
    return { ok: true };
  }

  return { PROVEDORES, idDoProvedor, acha, valida };
});
