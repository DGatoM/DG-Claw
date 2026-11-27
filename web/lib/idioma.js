'use strict';
const I = require('../public/ds/idioma');
/** Valores vindos do cookie e do ambiente nunca viram caminhos, HTML ou código. */
function idiomaDoPedido(req, padrao) { return I.doCookie(req.headers && req.headers.cookie, padrao); }
function renderizarIdioma(fonte, req, padrao) {
  const idioma = idiomaDoPedido(req, padrao);
  return I.html(fonte, idioma)
    .replace(/(<html\b[^>]*\blang=")[^"]*(")/, '$1' + idioma + '$2');
}
module.exports = { idiomaDoPedido, renderizarIdioma };
