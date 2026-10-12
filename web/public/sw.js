'use strict';
/* sw.js: service worker simples do DG Claw.

   Guarda só os arquivos estáticos da tela (CSS, JS, ícones, manifesto), para ela
   abrir rápido e para o app instalado ter o que mostrar. NUNCA mexe em /api/,
   /p/, /login, /sair nem nas páginas de conversa (/a/...): conteúdo da conversa,
   painéis e sessão passam direto para a rede, sem cópia nenhuma. */
const VERSAO = 'dgclaw-estaticos-v1';
const ESTATICOS = [
  '/conversa.css', '/chat.css', '/conversa.js', '/tour.js',
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
