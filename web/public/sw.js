'use strict';
/* sw.js: service worker simples do DG Claw.

   Guarda só os arquivos estáticos da tela (CSS, JS, ícones, manifesto), para ela
   abrir rápido e para o app instalado ter o que mostrar. NUNCA mexe em /api/,
   /p/, /login, /sair nem nas páginas de conversa (/a/...): conteúdo da conversa,
   painéis e sessão passam direto para a rede, sem cópia nenhuma. */
const VERSAO = 'dgclaw-estaticos-v19';
const ESTATICOS = [
  '/conversa.css', '/chat.css', '/conversa.js', '/menu-lado.js', '/menu-lado.css', '/casca.js', '/casca.css', '/login-cartao.js', '/trilha-tela.js', '/rolagem.js', '/tour.js',
  '/onboarding.js', '/onboarding.css',
  '/campo-cofre.js', '/campo-cofre.css',
  '/barra.js', '/barra.css',
  '/sigilo.js', '/sigilo.css',
  '/avisos-aparelho.js',
  '/lembretes-faixa.js', '/lembretes.js', '/lembretes.css',
  '/foco-tela.js', '/foco-tela.css',
  '/login.css', '/login.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
const PROIBIDOS = [/^\/api\//, /^\/p\//, /^\/login/, /^\/sair/, /^\/a\//];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(VERSAO)
      .then(c => Promise.all(ESTATICOS.map(u => c.add(u).catch(e => {
        console.warn('sw: não consegui guardar ' + u + ':', e.message);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (PROIBIDOS.some(rx => rx.test(url.pathname))) return;
  if (!ESTATICOS.includes(url.pathname)) return;     // o que não é estático nem passa por aqui
  // rede primeiro (a tela sempre pega a versão nova); sem rede, a cópia guardada
  ev.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copia = res.clone();
        caches.open(VERSAO).then(c => c.put(req, copia)).catch(e => {
          console.warn('sw: não consegui atualizar ' + url.pathname + ':', e.message);
        });
      }
      return res;
    }).catch(() => caches.match(req).then(c => c || Response.error()))
  );
});

/* Avisos no aparelho (web push). Contrato do JSON em web/docs/AVISOS-NO-APARELHO.md. */
self.addEventListener('push', ev => {
  let cru = '';
  let d = null;
  if (ev.data) {
    try { cru = ev.data.text(); } catch (e) { console.warn('sw: não consegui ler o texto do aviso:', e.message); }
    try { d = JSON.parse(cru); } catch (e) { console.warn('sw: o aviso não veio em JSON, mostro o texto cru:', e.message); }
  }
  if (!d || typeof d !== 'object') d = { titulo: 'DG Claw', corpo: cru || 'Você tem um aviso novo.' };
  const acoes = Array.isArray(d.acoes) ? d.acoes.filter(a => a && a.acao && a.titulo).slice(0, 2) : [];
  const opcoes = {
    body: d.corpo || '',
    renotify: !!d.tag,
    requireInteraction: !!d.exigir_interacao,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : '/', acoes },
    actions: acoes.map(a => ({ action: a.acao, title: a.titulo })),
  };
  if (d.tag) opcoes.tag = d.tag;
  if (d.imagem) opcoes.image = d.imagem;
  ev.waitUntil(self.registration.showNotification(d.titulo || 'DG Claw', opcoes));
});

/* Foca uma janela já aberta do DG Claw e leva para a url; sem janela, abre uma. */
function abrirDestino(url) {
  const alvo = new URL(url, self.location.origin).href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(janelas => {
    const mesma = janelas.find(c => new URL(c.url).origin === self.location.origin);
    if (!mesma) return self.clients.openWindow(alvo);
    return mesma.focus().then(c => (c && c.navigate ? c.navigate(alvo) : self.clients.openWindow(alvo)));
  }).catch(e => {
    console.warn('sw: não consegui focar a janela, abro uma nova:', e.message);
    return self.clients.openWindow(alvo);
  });
}

self.addEventListener('notificationclick', ev => {
  const dados = ev.notification.data || {};
  const url = typeof dados.url === 'string' && dados.url.startsWith('/') ? dados.url : '/';
  const acao = ev.action ? (dados.acoes || []).find(a => a.acao === ev.action && a.post) : null;
  ev.notification.close();
  if (!acao) { ev.waitUntil(abrirDestino(url)); return; }
  ev.waitUntil(
    fetch(acao.post, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(r => { if (!r.ok) throw new Error('o servidor respondeu ' + r.status); })
      .catch(e => {
        console.warn('sw: a ação "' + acao.acao + '" falhou (' + e.message + '); abro a tela para o dono resolver.');
        return abrirDestino(url);
      })
  );
});
