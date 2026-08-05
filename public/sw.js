const CACHE = 'jx-shell-v5';
const SHELL = ['/app/', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 只拦截学习中心 /app/；主站 CSS/JS/页面一律不拦截，避免荣耀等浏览器卡旧缓存
  const path = url.pathname;
  if (path !== '/app' && path !== '/app/' && !path.startsWith('/app/')) return;
  if (path.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (path === '/app/' || path === '/app') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/app/'))),
  );
});
