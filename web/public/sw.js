/*
 * Web Push service worker (P2 step 7) — plain JS (public/ is copied as-is,
 * no build step). Renders pushes from the daemon's webpush notifier and
 * focuses/opens the app on click.
 */

self.addEventListener('install', () => {
  // No waiting: the page registers this once and expects it live.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'EV Charge Coordinator';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      // One slot per event type — a newer charging-stopped supersedes.
      tag: payload.type || 'evcc',
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow(url);
      })
  );
});