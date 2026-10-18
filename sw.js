// Bdel had numéro kol merra katbeddel l'app bach telephone yjib version jdida
const VERSION = 'mizan-v32';
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png'];
// Ila l'réseau t3eTTel ktar men had l'modda w kayna nos5a f l'cache, l'app kat7ell b l'nos5a (w l'jdida katsjjel men ba3d)
const NET_TIMEOUT = 3500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Only the app page itself may replace the cached copy — never a 404, an error page or another URL
function isAppPage(r) {
  if (!r || !r.ok || r.status !== 200 || r.type !== 'basic' || r.redirected) return false;
  const scope = new URL(self.registration.scope).pathname;
  const p = new URL(r.url).pathname;
  return p === scope || p === scope + 'index.html';
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Page: network first (bach tjib l'update), cache ila ma kaynch internet wla ila t3eTTel
  if (req.mode === 'navigate') {
    // keeps the worker alive until the fresh page is stored, even when the cached copy was served first
    let stored; e.waitUntil(new Promise(res => { stored = res; }));
    const net = fetch(req).then(async r => {
      if (isAppPage(r)) { const c = await caches.open(VERSION); await c.put('./index.html', r.clone()).catch(() => {}); }
      return r;
    });
    net.then(stored, stored);
    e.respondWith((async () => {
      const cached = await caches.match('./index.html', { cacheName: VERSION });
      if (!cached) return net;
      const late = new Promise(res => setTimeout(() => res(cached), NET_TIMEOUT));
      return Promise.race([net.catch(() => cached), late]);
    })());
    return;
  }
  // Google Fonts w fichiers dyal l'app: cache, w update f l'arrière-plan
  // fonts only: the Firestore API (firestore.googleapis.com) must always go to the network
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit || Response.error());
      return hit || net;
    }));
  }
});
