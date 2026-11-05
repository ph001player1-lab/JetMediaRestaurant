// Service worker приложения персонала: показывает push-уведомления о вызовах и заказах
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// квитанция серверу: телефон получил уведомление / показал / не смог показать — для диагностики в приложении
const ack = (id, stage, err) => (id ? fetch('/api/staff/push-ack', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, stage, err }), keepalive: true,
}).catch(() => {}) : Promise.resolve());

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'JET MEDIA', body: '' };
  // напоминание: прежнее уведомление этого стола и вида убираем, показываем новое — со звуком и вибрацией
  const show = () => self.registration.getNotifications().then((list) => {
    for (const n of list) if (d.group && n.data?.group === d.group) n.close();
  }).catch(() => {}).then(() => self.registration.showNotification(d.title, {
    data: { group: d.group || '' },
    body: d.body,
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300],
  }));
  // сначала показываем (это главное), квитанции серверу — следом
  e.waitUntil(Promise.all([
    ack(d.ack, 'got'),
    show().then(() => ack(d.ack, 'shown'), (err) => ack(d.ack, 'fail', String((err && err.message) || err))),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
    list.length ? list[0].focus() : self.clients.openWindow('/staff/')));
});

self.addEventListener('fetch', () => {});
