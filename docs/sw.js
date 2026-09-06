// Service worker: receives the push, shows the Android notification, and can
// acknowledge straight from the notification button without opening the page.

const CACHE = 'emsalert-v1';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Offline-friendly shell: network first, fall back to cache. API calls always
// go to the network — a stale alert state would be worse than an error.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Incoming call', body: event.data ? event.data.text() : 'Tap to respond' };
  }

  const title = data.title || 'Incoming call';
  const options = {
    body: data.body || 'Tap to respond',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'oncall-alert',
    renotify: true,
    requireInteraction: true, // stays on screen until you deal with it
    vibrate: [300, 120, 300, 120, 300],
    timestamp: Date.now(),
    data,
    actions: [
      { action: 'ack', title: "I'm on my way" },
      { action: 'open', title: 'Open' }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

async function acknowledge(data, via) {
  if (!data?.ackUrl || !data?.token) return { ok: false, error: 'no ack details in push' };
  try {
    const res = await fetch(data.ackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      body: JSON.stringify({ id: data.id, via })
    });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...json } : { ok: false, error: json.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function focusApp(url) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if (client.url.includes(self.registration.scope) && 'focus' in client) {
      client.navigate?.(url).catch(() => {});
      return client.focus();
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const action = event.action;
  event.notification.close();

  const appBase = data.appUrl || self.registration.scope;
  const sep = appBase.includes('?') ? '&' : '?';

  if (action === 'ack') {
    event.waitUntil(
      (async () => {
        const result = await acknowledge(data, 'notification');
        // Tell any open tab so the page flips to "on the way" immediately.
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) client.postMessage({ type: 'ack-result', id: data.id, result });

        await self.registration.showNotification(
          result.ok ? 'Sent to the LINE group' : 'Could not post to LINE',
          {
            body: result.ok
              ? (result.duplicate ? 'Already acknowledged.' : 'The group has been told you are on the way.')
              : `${result.error} — open the app and try again.`,
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: 'oncall-ack',
            requireInteraction: !result.ok
          }
        );
        if (!result.ok) await focusApp(`${appBase}${sep}id=${encodeURIComponent(data.id || '')}`);
      })()
    );
    return;
  }

  event.waitUntil(focusApp(`${appBase}${sep}id=${encodeURIComponent(data.id || '')}&incoming=1`));
});

// Chrome can rotate the push subscription; re-register when that happens.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) client.postMessage({ type: 'resubscribe' });
    })()
  );
});
