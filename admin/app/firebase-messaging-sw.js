const serviceWorkerUrl = new URL(self.location.href);
const firebaseWebApiKey = serviceWorkerUrl.searchParams.get('apiKey') || '';
const managerWebBasePath = serviceWorkerUrl.pathname.replace(
  /\/firebase-messaging-sw\.js$/,
  '',
);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: firebaseWebApiKey,
  authDomain: 'ander-baher-attendance.firebaseapp.com',
  projectId: 'ander-baher-attendance',
  storageBucket: 'ander-baher-attendance.firebasestorage.app',
  messagingSenderId: '658419766549',
  appId: '1:658419766549:web:84ebf8fb1ca9e284d9051c',
  measurementId: 'G-7SD56VGTL4',
});

const messaging = firebase.messaging();

function isSupportedNotificationRoute(route) {
  const cleanRoute = String(route || '').trim();

  return (
    /^\/[^/]+\/home$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/team-members$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/regularisation\/[^/]+$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/edit-member\/[^/]+$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/add-member$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/quick-add-member$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/attendance-logs$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/holiday-plan$/i.test(cleanRoute) ||
    /^\/[^/]+\/home\/organisation$/i.test(cleanRoute)
  );
}

function resolveManagerAppUrl(route) {
  const cleanRoute = String(route || '').trim();
  const appBaseUrl = `${self.location.origin}${managerWebBasePath}`;
  if (!cleanRoute) {
    return `${appBaseUrl}/#/`;
  }

  if (/^https?:\/\//i.test(cleanRoute)) {
    return cleanRoute;
  }

  if (!isSupportedNotificationRoute(cleanRoute)) {
    return `${appBaseUrl}/#/`;
  }

  const normalizedRoute = cleanRoute.startsWith('/') ? cleanRoute : `/${cleanRoute}`;
  return `${appBaseUrl}/#${normalizedRoute}`;
}

messaging.onBackgroundMessage((payload) => {
  const data = payload && payload.data ? payload.data : {};
  const notification = payload && payload.notification ? payload.notification : {};

  const title = notification.title || data.title || 'Ander Baher Manager';
  const body = notification.body || data.body || '';
  const route = data.route || '';

  self.registration.showNotification(title, {
    body,
    data: {
      route,
      clickUrl: resolveManagerAppUrl(route),
    },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data =
    event.notification && event.notification.data ? event.notification.data : {};
  const clickUrl = resolveManagerAppUrl(data.clickUrl || data.route || '');
  const appBaseUrl = `${self.location.origin}${managerWebBasePath}`;
  const route = String(data.route || '').trim();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(
      (windowClients) => {
        for (const client of windowClients) {
          if (!client || !client.url || !client.url.startsWith(appBaseUrl)) {
            continue;
          }

          if ('postMessage' in client && route) {
            client.postMessage({
              type: 'ab-push-notification-route',
              route,
            });
          }

          if ('navigate' in client) {
            return client.navigate(clickUrl).then(function (navigatedClient) {
              if (navigatedClient && 'focus' in navigatedClient) {
                return navigatedClient.focus();
              }

              if ('focus' in client) {
                return client.focus();
              }

              return undefined;
            });
          }

          if ('focus' in client) {
            return client.focus();
          }
        }

        if (clients.openWindow) {
          return clients.openWindow(clickUrl);
        }

        return undefined;
      },
    ),
  );
});
