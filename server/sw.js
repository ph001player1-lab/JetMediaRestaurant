// Service worker приложения персонала: показывает push-уведомления о вызовах и заказах
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// квитанция серверу: телефон получил уведомление / показал / не смог показать — для диагностики в приложении
const ack = (id, stage, err) => (id ? fetch('/api/staff/push-ack', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, stage, err }), keepalive: true,
}).catch(() => {}) : Promise.resolve());

// «Получил» — и заодно вопрос серверу: ещё актуально? Телефон мог проспать уведомление несколько минут, а вызов
// за это время уже приняли. Ответа нет 2 секунды (нет сети) — показываем как обычно: лучше лишний звонок, чем пропущенный
const check = (id) => (id ? Promise.race([
  fetch('/api/staff/push-ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, stage: 'got' }) })
    .then((r) => (r.ok ? r.json() : null)),
  new Promise((res) => setTimeout(() => res(null), 2000)),
]).catch(() => null) : Promise.resolve(null));

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'JET MEDIA', body: '' };
  // прежние уведомления этого стола и вида убираем
  const closeGroup = () => self.registration.getNotifications().then((list) => {
    for (const n of list) if (d.group && n.data?.group === d.group) n.close();
  }).catch(() => {});
  // как обычно: новое — со звуком и вибрацией
  const loud = () => closeGroup().then(() => self.registration.showNotification(d.title, {
    data: { group: d.group || '' },
    body: d.body,
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300],
  }));
  // уже приняли: тихое «✓ Вызов официанта — принято: Tin» на несколько секунд (совсем ничего не показать нельзя —
  // iPhone и Chrome за это отключают уведомления), старые уведомления этого стола убираем
  const okTag = `${d.group || 'jm'}-ok`;
  const quiet = (body) => closeGroup().then(() => self.registration.showNotification(d.title, {
    data: { group: d.group || '' }, body, tag: okTag, silent: true,
  })).then(() => ack(d.ack, 'quiet'))
    .then(() => wait(8000))
    .then(() => self.registration.getNotifications())
    .then((list) => { for (const n of list) if (n.tag === okTag) n.close(); })
    .catch(() => {});
  e.waitUntil(check(d.ack).then((st) => (st && st.stale && st.body ? quiet(st.body)
    : loud().then(() => ack(d.ack, 'shown'), (err) => ack(d.ack, 'fail', String((err && err.message) || err))))));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
    list.length ? list[0].focus() : self.clients.openWindow('/staff/')));
});

self.addEventListener('fetch', () => {});
