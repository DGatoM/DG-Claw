'use strict';
// A função extraída para uma bancada conserva os helpers reais do seu arquivo.
function preludioIdioma(fonte) {
  return fonte.split('\n').filter(l => /^const dg(?:Ui|Texto|Html|Frase)/.test(l)).join('\n') + '\n';
}
module.exports = { preludioIdioma };
