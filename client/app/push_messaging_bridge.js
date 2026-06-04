(function () {
  const firebaseSdkVersion = '12.13.0';
  const bridgeAppName = '__ab_push_bridge__';
  let firebaseModulesPromise = null;
  let workerRegistrationPromise = null;

  function getBaseUri() {
    return new URL(document.baseURI);
  }

  function buildFirebaseConfig(
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
    measurementId,
  ) {
    const config = {
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
    };

    if (measurementId) {
      config.measurementId = measurementId;
    }

    return config;
  }

  function getPushServiceWorkerScope() {
    return new URL('firebase-cloud-messaging-push-scope/', getBaseUri()).pathname;
  }

  function getPushServiceWorkerUrl(apiKey) {
    const workerUrl = new URL('firebase-messaging-sw.js', getBaseUri());
    workerUrl.searchParams.set('apiKey', apiKey);
    return workerUrl.toString();
  }

  async function loadFirebaseModules() {
    if (!firebaseModulesPromise) {
      firebaseModulesPromise = Promise.all([
        import(`https://www.gstatic.com/firebasejs/${firebaseSdkVersion}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${firebaseSdkVersion}/firebase-messaging.js`),
      ]);
    }

    return firebaseModulesPromise;
  }

  async function getBridgeApp(firebaseConfig) {
    const [{ initializeApp, getApps }] = await loadFirebaseModules();
    const existingApp = getApps().find((app) => app.name === bridgeAppName);

    if (existingApp) {
      return existingApp;
    }

    return initializeApp(firebaseConfig, bridgeAppName);
  }

  function waitForActivation(registration) {
    const serviceWorker =
      registration.active ?? registration.installing ?? registration.waiting;

    if (!serviceWorker || serviceWorker.state === 'activated') {
      return Promise.resolve(registration);
    }

    return new Promise((resolve, reject) => {
      const handleStateChange = () => {
        if (serviceWorker.state === 'activated') {
          serviceWorker.removeEventListener('statechange', handleStateChange);
          resolve(registration);
          return;
        }

        if (serviceWorker.state === 'redundant') {
          serviceWorker.removeEventListener('statechange', handleStateChange);
          reject(
            new Error(
              'Push messaging service worker became redundant before activation.',
            ),
          );
        }
      };

      serviceWorker.addEventListener('statechange', handleStateChange);
    });
  }

  async function ensurePushServiceWorkerRegistration(firebaseConfig) {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are not supported in this browser.');
    }

    if (!window.isSecureContext) {
      throw new Error('Push messaging requires a secure context.');
    }

    if (!firebaseConfig.apiKey) {
      throw new Error('Firebase web API key is missing.');
    }

    const scope = getPushServiceWorkerScope();
    const workerUrl = getPushServiceWorkerUrl(firebaseConfig.apiKey);

    if (!workerRegistrationPromise) {
      workerRegistrationPromise = navigator.serviceWorker
        .register(workerUrl, { scope })
        .then(waitForActivation)
        .then((registration) => {
          console.info('[abPushMessaging] Registered push service worker', {
            workerUrl,
            requestedScope: scope,
            registrationScope: registration.scope,
          });
          return registration;
        })
        .catch((error) => {
          workerRegistrationPromise = null;
          throw error;
        });
    }

    return workerRegistrationPromise;
  }

  window.abEnsurePushMessagingServiceWorkerRegistration = async function (
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
    measurementId,
  ) {
    const firebaseConfig = buildFirebaseConfig(
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
      measurementId,
    );

    await ensurePushServiceWorkerRegistration(firebaseConfig);
  };

  window.abGetPushMessagingToken = async function (
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
    measurementId,
    vapidKey,
  ) {
    if (!vapidKey) {
      throw new Error('FCM web VAPID key is missing.');
    }

    const firebaseConfig = buildFirebaseConfig(
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
      measurementId,
    );

    const registration = await ensurePushServiceWorkerRegistration(
      firebaseConfig,
    );
    const [, { getMessaging, getToken }] = await loadFirebaseModules();
    const app = await getBridgeApp(firebaseConfig);
    const messaging = getMessaging(app);

    return getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    });
  };

  window.abShowPushMessagingNotification = async function (
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
    measurementId,
    title,
    body,
    route,
  ) {
    const firebaseConfig = buildFirebaseConfig(
      apiKey,
      authDomain,
      projectId,
      storageBucket,
      messagingSenderId,
      appId,
      measurementId,
    );

    const registration = await ensurePushServiceWorkerRegistration(
      firebaseConfig,
    );

    const normalizedTitle = String(title || '').trim();
    const normalizedBody = String(body || '').trim();
    const normalizedRoute = String(route || '').trim();

    if (!normalizedTitle && !normalizedBody) {
      return;
    }

    await registration.showNotification(
      normalizedTitle || 'Ander Baher Attendance',
      {
        body: normalizedBody,
        data: {
          route: normalizedRoute,
        },
      },
    );
  };
})();
