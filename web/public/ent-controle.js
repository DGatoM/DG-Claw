'use strict';
/* ent-controle.js (bloco C): põe "Aprovações" (com o número de pedidos esperando) no menu do TI e, enquanto a manutenção de
   emergência do Admin estiver aberta, um aviso no topo da página. Fora do enterprise, ou para quem não é TI, o servidor
   responde 404 ou 403 e este arquivo não faz nada. */
(function () {
  const sair = document.getElementById('formSair');
  if (!sair || document.getElementById('entControleLinks')) return;
  const get = (url) => fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  get('/api/v1/aprovacoes/resumo').then((r) => {
    if (!r || typeof r.pendentes !== 'number') return;
    const caixa = document.createElement('div');
    caixa.id = 'entControleLinks';
    const n = r.pendentes;
    caixa.innerHTML = '<a class="ml-tab" href="/aprovacoes"><span class="ml-ico" aria-hidden="true">✓</span>Aprovações' +
      (n > 0 ? ' <span id="entAprovContador" style="background:#d9961a;color:#fff;border-radius:10px;padding:0 8px;font-size:12px;font-weight:700;margin-left:6px">' + n + '</span>' : '') + '</a>';
    sair.parentNode.insertBefore(caixa, sair);
  });

  get('/api/v1/controle/manutencao').then((m) => {
    if (!m || !m.aberta || document.getElementById('entManutencaoFaixa')) return;
    const faixa = document.createElement('a');
    faixa.id = 'entManutencaoFaixa';
    faixa.href = m.link || '/a/admin-manutencao';
    faixa.style.cssText = 'display:block;position:sticky;top:0;z-index:50;padding:8px 12px;background:#c0392b;color:#fff;font:600 14px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;text-decoration:none';
    faixa.textContent = 'Manutenção de emergência aberta: o Admin antigo roda como root no servidor por mais ' + m.minutos_restantes + ' min' + (m.por ? ' (aberta por ' + m.por + ')' : '') + '. Toque para abrir a conversa.';
    document.body.insertBefore(faixa, document.body.firstChild);
  });
})();
