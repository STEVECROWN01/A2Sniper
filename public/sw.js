/**
 * A2Sniper Service Worker — Web Push Notifications
 *
 * This service worker receives push messages from the backend when a signal
 * fires on the signals page. It shows a notification with:
 *   - Pair name (e.g. "EUR/USD OTC")
 *   - Trade direction (CALL / PUT)
 *   - Expiration (e.g. "3m expiry")
 *   - Payout and winrate
 *
 * The notification has two action buttons:
 *   - "Open PO" → opens https://pocketoption.com
 *   - "View Signal" → opens the A2Sniper signals page
 *
 * The SW also forwards the push to any open tabs so they can play the
 * user's selected notification sound (bell, chime, alert, coin, digital).
 */

const PO_URL = 'https://pocketoption.com/';
const SIGNALS_URL = '/signals';

// ─── Install: activate immediately ───────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ─── Push event: show notification + notify open tabs ────────────────
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'A2Sniper Signal', body: event.data ? event.data.text() : 'New signal available' };
  }

  const title = data.title || '🎯 A2Sniper Signal';
  const body = data.body || 'New trading signal available';

  const options = {
    body: body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'a2sniper-signal',
    renotify: true,
    requireInteraction: true,
    data: {
      pair: data.pair || '',
      direction: data.direction || '',
      expiration: data.expiration || 3,
      payout: data.payout || 0,
      winrate: data.winrate || 0,
      signalId: data.signal_id || '',
      url: data.url || SIGNALS_URL,
    },
    actions: [
      { action: 'open-po', title: '📈 Open PO' },
      { action: 'view-signal', title: '🎯 View Signal' },
    ],
  };

  event.waitUntil(
    Promise.all([
      // Show the notification
      self.registration.showNotification(title, options),
      // Forward to open tabs so they can play the sound
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'PUSH_SIGNAL',
            data: data,
          });
        });
      }),
    ])
  );
});

// ─── Notification click: handle action buttons ───────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl;

  if (event.action === 'open-po') {
    targetUrl = PO_URL;
  } else if (event.action === 'view-signal') {
    targetUrl = event.notification.data?.url || SIGNALS_URL;
  } else {
    // Default click (notification body, not an action button)
    targetUrl = event.notification.data?.url || SIGNALS_URL;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a tab is already open, focus it and navigate
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          if (targetUrl.startsWith('/')) {
            client.postMessage({ type: 'NAVIGATE', url: targetUrl });
          } else {
            // External URL (PO) — open in new tab
            return self.clients.openWindow(targetUrl);
          }
          return;
        }
      }
      // No open tab — open a new one
      if (targetUrl.startsWith('/')) {
        return self.clients.openWindow(targetUrl);
      } else {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ─── Message from page: trigger sound playback in all tabs ───────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
