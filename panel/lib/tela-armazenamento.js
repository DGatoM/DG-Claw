'use strict';
/**
 * O painel do agente roda num iframe em sandbox sem allow-same-origin (origem opaca), e nesse
 * documento tocar em localStorage ou sessionStorage lança SecurityError. O noVNC lê as
 * preferências dele ali já no carregamento (app/ui.js), então a Tela quebraria antes de conectar.
 *
 * Em vez de copiar o noVNC para o repositório, o painel injeta este script no começo do
 * vnc.html servido: se o armazenamento do navegador não responde, entra um substituto em memória
 * (as preferências valem só enquanto a aba estiver aberta). Com armazenamento normal (painel
 * aberto fora do sandbox), o script não faz nada.
 */

const SHIM = `(function () {
  function memoria() {
    var d = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return k in d ? d[k] : null; },
      setItem: function (k, v) { d[String(k)] = String(v); },
      removeItem: function (k) { delete d[String(k)]; },
      clear: function () { d = Object.create(null); },
      key: function (i) { var ks = Object.keys(d); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(d).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (nome) {
    try { var s = window[nome]; s.getItem('dgclaw-teste'); return; } catch (e) { /* sandbox sem allow-same-origin */ }
    try { Object.defineProperty(window, nome, { value: memoria(), configurable: true }); }
    catch (e) { console.error('Tela: não consegui substituir ' + nome + ' (' + e.message + '); o noVNC pode não abrir.'); }
  });
})();`;

/** Põe o shim logo depois de <head> (ou no começo, se o HTML não tiver). Roda antes dos scripts do noVNC. */
function injetar(html) {
  const tag = `<script>${SHIM}</script>`;
  const texto = String(html);
  const m = /<head(\s[^>]*)?>/i.exec(texto);
  if (!m) return tag + texto;
  const fim = m.index + m[0].length;
  return texto.slice(0, fim) + tag + texto.slice(fim);
}

module.exports = { SHIM, injetar };
