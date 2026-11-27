const dgHtmlFull_skills = fonte => globalThis.DGI18n ? globalThis.DGI18n.html(fonte) : fonte.replace(/<!--(?:dg-i18n:[a-f0-9]{12}|\/dg-i18n)-->/g, "");
const dgTextFull_skills = fonte => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.t(trecho)) : fonte;
const dgPhraseFull_skills = (fonte, valores) => globalThis.DGI18n ? fonte.replace(/\S[\s\S]*\S|\S/g, trecho => globalThis.DGI18n.frase(trecho, valores)) : fonte.replace(/\{([a-z_][a-z_0-9]*)\}/g, (m,k) => valores && Object.hasOwn(valores,k) ? String(valores[k]) : m);
const dgFragFull_skills = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.fragmento(fonte, valores) : dgPhraseFull_skills(fonte,valores).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
// skills.js: a aba Skills. Mostra o que o agente sabe fazer, uma skill por cartão.
//
// A lista vem de /api/skills, que lê as pastas do disco (ver lib/skills.js). Usa fetch próprio
// em vez do API.get porque aquele devolve null no erro e o MOTIVO que o servidor mandou
// precisa chegar na pessoa. Cartão fechado mostra ~2 linhas; tocar abre a descrição inteira e a
// pasta onde a skill fica salva (a resposta de "onde fica salvo isso?").
(function () {
  const BASE = window.DGCLAW_BASE || '';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function carregar() {
    const raiz = document.getElementById('skills-root');
    if (!raiz) return;
    let res;
    try {
      res = await fetch(BASE + '/api/skills');
    } catch (e) {
      raiz.innerHTML = dgHtmlFull_skills(`<div class="vazio-util">${dgFragFull_skills("Não alcancei o painel: {v0}. Confira a internet e tente de novo.",{v0:(e.message)})}</div>`);
      return;
    }
    if (res.status === 401) { window.location = BASE + '/login.html'; return; }
    let corpo = {};
    try { corpo = await res.json(); } catch { /* sem json */ }
    if (!res.ok) {
      raiz.innerHTML = `<div class="vazio-util">${esc(corpo.error || dgTextFull_skills("Não consegui listar as skills."))} ${esc(corpo.howToFix || '')}</div>`;
      return;
    }
    desenhar(raiz, corpo.skills || [], corpo.pastas || []);
  }

  function desenhar(raiz, skills, pastas) {
    const principal = pastas[0] ? pastas[0].caminho : '';
    const n = skills.length;
    let html = `<div class="sk-topo"><div class="sk-contador"><b>${n}</b> ${n === 1 ? 'skill' : 'skills'}</div>`
      + dgHtmlFull_skills(`<div class="sk-onde"><!--dg-i18n:309f08376e65-->ficam salvas em<!--/dg-i18n--> <code>${esc(principal)}</code>`)
      + (pastas.length > 1 ? ' e em mais ' + (pastas.length - 1) + (pastas.length - 1 === 1 ? dgTextFull_skills(" pasta") : ' pastas') : '') + '</div></div>';
    const semPasta = pastas.filter((p) => !p.existe);
    if (semPasta.length) {
      html += dgHtmlFull_skills(`<div class="vazio-util sk-aviso"><!--dg-i18n:c40fe39e4645-->Procurei e não achei:<!--/dg-i18n--> `)
        + semPasta.map((p) => `<code>${esc(p.caminho)}</code>${p.erro ? ' (' + esc(p.erro) + ')' : ''}`).join(', ')
        + dgHtmlFull_skills(`<!--dg-i18n:4b615d390c0b-->. A pasta aparece quando a primeira skill é criada.<!--/dg-i18n--></div>`);
    }
    if (!n) {
      html += dgHtmlFull_skills(`<div class="vazio-util convite"><!--dg-i18n:5d98facbaff8-->Este agente ainda não tem nenhuma skill. Peça a ele na Conversa,<!--/dg-i18n--> `)
        + dgHtmlFull_skills(`<!--dg-i18n:942b58dea3d4-->por exemplo:<!--/dg-i18n--> <b><!--dg-i18n:fb72a5710f8e-->"cria uma skill que monta o meu resumo semanal"<!--/dg-i18n--></b><!--dg-i18n:f34b7f871342-->. Ela aparece aqui.<!--/dg-i18n--></div>`);
    } else {
      html += '<div class="sk-grade">' + skills.map((s, i) => dgHtmlFull_skills(`
        <article class="sk-cartao${s.erro ? ' sk-erro' : ''}" data-i="${i}">
          <button type="button" class="sk-cab" aria-expanded="false">
            <span class="sk-nome">${esc(s.nome)}</span>
            <span class="sk-desc">${esc(s.descricao || dgTextFull_skills("sem descrição"))}</span>
          </button>
          <div class="sk-detalhe" hidden>
            <div class="sk-desc-inteira">${esc(s.descricao || dgTextFull_skills("sem descrição"))}</div>
            ${s.erro ? `<div class="sk-msg-erro">${esc(s.erro)}</div>` : ''}
            <div class="sk-pasta"><!--dg-i18n:428759b7b418-->Fica salva em<!--/dg-i18n--> <code>${esc(s.pasta)}</code></div>
          </div>
        </article>`)).join('') + '</div>';
    }
    raiz.innerHTML = html;
    raiz.querySelectorAll('.sk-cab').forEach((b) => b.addEventListener('click', () => {
      const cartao = b.closest('.sk-cartao');
      const det = cartao.querySelector('.sk-detalhe');
      const abrir = det.hidden;
      det.hidden = !abrir;
      cartao.classList.toggle('aberto', abrir);
      b.setAttribute('aria-expanded', String(abrir));
    }));
  }

  window.DGSkills = { carregar };
})();
