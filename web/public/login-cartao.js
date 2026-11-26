'use strict';
const dgUiText_login_cartao_js = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgTexto_login_cartao = fonte => globalThis.DGI18n ? globalThis.DGI18n.t(fonte) : fonte;
const dgFrase_login_cartao = (fonte, valores) => globalThis.DGI18n ? globalThis.DGI18n.frase(fonte, valores) : fonte.replace(/\{([a-z_]+)\}/g, (m, k) => Object.hasOwn(valores, k) ? String(valores[k]) : m);
/* login-cartao.js: a parte pura do cartão "Conectar o seu Claude/Codex" da conversa.

   Sem DOM e sem rede: decide qual provedor o cartão mostra, se o texto digitado é o
   comando /login e o que o cartão exibe em cada estado do login. O desenho e as chamadas
   ficam em conversa.js; aqui fica o que se pode testar com node:test (web/test/login-cartao.test.js). */
(function (raiz, fabrica) {
  const m = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else raiz.DGLoginCartao = m;
})(this, function () {
  /** "/login" sozinho, sem diferenciar maiúsculas nem espaços nas pontas. */
  function ehComandoLogin(texto) {
    return typeof texto === 'string' && texto.trim().toLowerCase() === '/login';
  }

  /** O nome que a pessoa conhece: Codex ou Claude (qualquer outra coisa cai em Claude). */
  function nomeProvedor(provedor) {
    return /codex/i.test(String(provedor || '')) ? 'Codex' : 'Claude';
  }

  /** Só abre em nova aba um link https: o texto vem de um programa que repassa o que o provedor mandou. */
  function linkSeguro(u) {
    return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
  }

  /**
   * O que o cartão mostra. `d` é a resposta de GET .../login (estado, link, codigoDispositivo,
   * mensagem, provedor, conferido, precisa_login). `ctx.iniciado` diz se o login foi começado
   * por este cartão (ou visto em andamento): um "concluido" ou "falhou" que sobrou de antes não deve aparecer como novidade.
   *
   * fase: inicio | ja_conectado | preparando | codigo | navegador | concluido | falhou
   */
  function visao(d, ctx) {
    d = d || {};
    const iniciado = !!(ctx && ctx.iniciado);
    const nome = nomeProvedor(d.provedor);
    const agente = (ctx && ctx.agente) || dgTexto_login_cartao('O agente');
    let estado = d.estado || 'nenhum';
    if ((estado === 'concluido' || estado === 'falhou') && !iniciado) estado = 'nenhum';
    const base = {
      fase: 'inicio', provedor: nome, titulo: dgFrase_login_cartao("Conectar o seu {provedor}", { provedor: nome }), texto: '', passos: [],
      botao: null, link: null, campoCodigo: false, codigoDispositivo: null,
      cancelar: false, fechar: false, entrarDeNovo: false, aviso: '',
    };
    switch (estado) {
      case 'aguardando_link':
        return Object.assign(base, { fase: 'preparando', texto: dgTexto_login_cartao('Preparando o link…'), cancelar: true, aviso: dgTexto_login_cartao('Preparando o link de login') });
      case 'aguardando_codigo':
        return Object.assign(base, {
          fase: 'codigo', link: linkSeguro(d.link), campoCodigo: true, cancelar: true,
          passos: [dgTexto_login_cartao('Abra a página de login e entre com a sua conta.'), dgTexto_login_cartao('No fim, a página mostra um código. Cole ele aqui embaixo.')],
          aviso: dgTexto_login_cartao('Falta colar o código que a página mostrou'),
        });
      case 'aguardando_navegador':
        return Object.assign(base, {
          fase: 'navegador', link: linkSeguro(d.link), codigoDispositivo: d.codigoDispositivo || null, cancelar: true,
          passos: [dgTexto_login_cartao('Abra a página de login e entre com a sua conta.'), dgTexto_login_cartao('Quando a página pedir, digite o código abaixo.')],
          aviso: dgTexto_login_cartao('Esperando você terminar o login na página'),
        });
      case 'concluido':
        return Object.assign(base, { fase: 'concluido', get titulo() { return dgUiText_login_cartao_js("Conectado!"); }, texto: dgFrase_login_cartao(dgUiText_login_cartao_js("Tudo certo. {agente} já pode responder."), { agente }), aviso: dgTexto_login_cartao('Conectado') });
      case 'falhou':
        return Object.assign(base, {
          fase: 'falhou', get titulo() { return dgUiText_login_cartao_js("O login não deu certo"); },
          texto: d.mensagem ? String(d.mensagem) : dgTexto_login_cartao('O login terminou sem conectar a conta.'),
          botao: dgTexto_login_cartao('Tentar de novo'), fechar: true, aviso: dgTexto_login_cartao('O login falhou'),
        });
      default: {
        const jaOk = !!(d.conferido && d.conferido.ok === true) && !d.precisa_login;
        if (jaOk) {
          return Object.assign(base, {
            fase: 'ja_conectado', get titulo() { return dgUiText_login_cartao_js("Esta conta já está conectada"); },
            texto: dgFrase_login_cartao(dgUiText_login_cartao_js("{agente} já usa a sua conta do {provedor}. Só entre de novo se quiser trocar de conta."), { agente, provedor: nome }),
            fechar: true, entrarDeNovo: true,
          });
        }
        return Object.assign(base, {
          texto: dgFrase_login_cartao(dgUiText_login_cartao_js("{agente} precisa da sua conta do {provedor} para responder. Conecte aqui, sem terminal."), { agente, provedor: nome }),
          botao: dgTexto_login_cartao('Conectar'), fechar: true,
        });
      }
    }
  }

  return { ehComandoLogin, nomeProvedor, linkSeguro, visao };
});
