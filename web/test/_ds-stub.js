'use strict';
// Os scripts das telas chamam dsIcone/dsCarregando, que o navegador recebe de /ds/icone.js e /ds/carregando.js.
// Nos testes em Node eles não existem; este substituto devolve um marcador com o nome do ícone, para os testes
// poderem conferir qual ícone foi usado sem depender do desenho.
function dsIcone(nome) { return '<svg class="ds-ico" data-ico="' + nome + '"></svg>'; }
function dsCarregando(o) { return '<span class="ds-carregando" role="status" aria-label="' + ((o && o.rotulo) || 'Carregando') + '"></span>'; }
globalThis.dsIcone = dsIcone;
globalThis.dsCarregando = dsCarregando;
module.exports = { dsIcone, dsCarregando };
