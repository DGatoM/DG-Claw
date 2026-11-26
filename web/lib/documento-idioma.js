'use strict';
// Somente documentos do produto, em caminhos definidos pelo código. Conteúdo
// de agentes e de pessoas nunca passa por este leitor.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const AVISO = '> English translation unavailable or awaiting review after a source update. The current Portuguese document follows.\n\n';
function arquivoSeguro(dir, nome) {
  const raiz = fs.realpathSync(dir);
  const alvo = fs.realpathSync(path.join(dir, nome));
  if (path.dirname(alvo) !== raiz) return null;
  const stat = fs.statSync(alvo);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  return fs.readFileSync(alvo, 'utf8');
}
function traduzirDocumento(caminho, original, idioma) {
  if (idioma !== 'en') return original;
  const dir = path.dirname(caminho), nome = path.basename(caminho);
  try {
    const dirEn = path.join(dir, 'en'), raiz = fs.realpathSync(dir);
    if (path.dirname(fs.realpathSync(dirEn)) !== raiz) return AVISO + original;
    const manifesto = arquivoSeguro(dirEn, 'fontes.json');
    const fontes = manifesto && JSON.parse(manifesto);
    if (!fontes || typeof fontes !== 'object' || Array.isArray(fontes) || !Object.hasOwn(fontes, nome) || fontes[nome] !== createHash('sha256').update(original).digest('hex')) return AVISO + original;
    const traduzido = arquivoSeguro(dirEn, nome);
    return traduzido === null ? AVISO + original : traduzido;
  } catch (_) { return AVISO + original; }
}
function lerDocumento(caminho, idioma) { return traduzirDocumento(caminho, fs.readFileSync(caminho, 'utf8'), idioma); }
module.exports = { lerDocumento, traduzirDocumento };
