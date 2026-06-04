const serviceWorkerUrl = new URL(self.location.href);
const firebaseWebApiKey = serviceWorkerUrl.searchParams.get('apiKey') || '';
const attendanceWebBasePath = serviceWorkerUrl.pathname.replace(
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
  appId: '1:658419766549:web:91a4fceed01520dd9051c',
  measurementId: 'G-JV1QRPPZ67',
});

const messaging = firebase.messaging();

function isSupportedNotificationRoute(route) {
  const cleanRoute = String(route || '').trim();

  return (
    /^\/attendance\/[^/]+$/i.test(cleanRoute) ||
    /^\/attendance\/[^/]+\/log$/i.test(cleanRoute) ||
    /^\/attendance\/[^/]+\/regularise$/i.test(cleanRoute)
  );
}

function resolveAttendanceAppUrl(route) {
  const cleanRoute = String(route || '').trim();
  if (!cleanRoute) {
    return `${self.location.origin}${attendanceWebBasePath}/`;
  }

  if (/^https?:\/\//i.test(cleanRoute)) {
    return cleanRoute;
  }

  if (!isSupportedNotificationRoute(cleanRoute)) {
    return `${self.location.origin}${attendanceWebBasePath}/`;
  }

  if (cleanRoute.startsWith('/')) {
    return `${self.location.origin}${attendanceWebBasePath}${cleanRoute}`;
  }

  return `${self.location.origin}${attendanceWebBasePath}/${cleanRoute}`;
}

messaging.onBackgroundMessage((payload) => {
  const data = payload && payload.data ? payload.data : {};
  const notification = payload && payload.notification ? payload.notification : {};

  const title = notification.title || data.title || 'Ander Baher Attendance';
  const body = notification.body || data.body || '';
  const route = data.route || '';

  self.registration.showNotification(title, {
    body,
    data: {
      route,
      clickUrl: resolveAttendanceAppUrl(route),
    },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data =
    event.notification && event.notification.data ? event.notification.data : {};
  const clickUrl = resolveAttendanceAppUrl(data.clickUrl || data.route || '');
  const appBaseUrl = `${self.location.origin}${attendanceWebBasePath}`;
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
