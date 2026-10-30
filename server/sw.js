// Service worker приложения персонала: показывает push-уведомления о вызовах и заказах
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'JET MEDIA', body: '' };
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) =>
    list.length ? list[0].focus() : self.clients.openWindow('/staff/')));
});

self.addEventListener('fetch', () => {});
