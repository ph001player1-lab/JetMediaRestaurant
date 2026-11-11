// Запас планшета стола (JET MEDIA): страница открывается и без связи, фото меню, слайдов и персонажа — из памяти планшета.
// Страница и её скрипты — сначала из сети (свежая версия), нет сети или сервер не ответил — сохранённая копия.
// Картинки /uploads (имя — хэш содержимого, не меняются) — из памяти, а нет — из сети с сохранением.
// Список картинок присылает страница (меню, слайды, персонаж): недостающие докачиваем по 3, лишние удаляем.
// Запросы к API (заказы, вызовы, состояние стола) не трогаем — они всегда идут в сеть.
const PAGE = 'jm-guest-page-v1', FILES = 'jm-guest-files-v1';
const IMG = /^\/uploads\/[a-f0-9]+\.(jpg|png|webp|svg)$/;
const ASSET = /^\/(vendor\/[\w.-]+\.js|favicon\.svg)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('jm-guest') && k !== PAGE && k !== FILES) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== self.location.origin || req.headers.has('range')) return;
  if (req.mode === 'navigate' && u.pathname === '/guest/') e.respondWith(fresh(req, '/guest/'));
  else if (ASSET.test(u.pathname)) e.respondWith(fresh(req, u.pathname));
  else if (IMG.test(u.pathname)) e.respondWith(stored(req));
});

// сначала сеть (до 8 с); ошибка сети или сервера — сохранённая копия
async function fresh(req, key) {
  const c = await caches.open(PAGE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 8000))]);
    if (res.ok) { await c.put(key, res.clone()); return res; }
    return (await c.match(key)) || res;
  } catch (err) {
    const hit = await c.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function stored(req) {
  const c = await caches.open(FILES), hit = await c.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req.url, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'precache' || !Array.isArray(e.data.urls)) return;
  e.waitUntil(precache(e.data.urls.filter((x) => IMG.test(x)).slice(0, 3000)));
});

let running = null;
async function precache(urls) {
  if (running) await running.catch(() => {});
  running = (async () => {
    const c = await caches.open(FILES), want = new Set(urls.map((x) => new URL(x, self.location.origin).href));
    for (const k of await c.keys()) if (!want.has(k.url)) await c.delete(k);
    const todo = [];
    for (const x of want) if (!(await c.match(x))) todo.push(x);
    const work = async () => {
      for (let x; (x = todo.shift());) {
        try { const r = await fetch(x); if (r.ok) await c.put(x, r); } catch { /* нет сети — докачаем при следующем списке */ }
      }
    };
    await Promise.all([work(), work(), work()]);
  })();
  return running;
}
