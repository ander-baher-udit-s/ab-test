(() => {
  let db, conn, context, manifest, currentFilter, initPromise;
  let hostOrigin = (() => {
    try { return document.referrer ? new URL(document.referrer).origin : location.origin; }
    catch (_) { return location.origin; }
  })();
  let pendingInit;
  const bridgeVersion = 1;
  const patchVersion = '2026.10.27-p11';
  const isLoopback = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const params = new URL(location.href).searchParams;
  const explicitFixture = params.get('devFixture') === 'org_3';
  const standaloneFixture = isLoopback && (explicitFixture ||
    (params.get('hostSession') !== '1' && !params.has('devFixture') &&
      window.parent === window && !window.AndroidDashboard));
  const send = (type, payload = {}) => {
    const message = {version: bridgeVersion, type, payload};
    if (type === 'ERROR' && !context) pendingInit = message;
    if (window.parent !== window) window.parent.postMessage(message, hostOrigin);
    if (window.opener && !window.opener.closed) window.opener.postMessage(message, hostOrigin);
    if (window.AndroidDashboard?.postMessage) window.AndroidDashboard.postMessage(JSON.stringify(message));
    window.dispatchEvent(new CustomEvent('dashboard-host-message', {detail: message}));
  };
  const capability = () => ({webAssembly: typeof WebAssembly !== 'undefined',
    worker: typeof Worker !== 'undefined', opfs: !!navigator.storage?.getDirectory,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true});
  const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item);
  const rows = table => table.toArray().map(row => {
    const out = {}; for (const field of table.schema.fields) out[field.name] = row[field.name];
    return out;
  });
  const cacheDbName = 'attendance-dashboard-snapshots-v1';
  const cacheTtlMs = 7 * 24 * 60 * 60 * 1000;
  const cacheLimit = 3;
  function scopeKey() {
    const auth = context?.authContext ?? context ?? {};
    const required = ['orgId', 'userId', 'email', 'surface'];
    if (!context?.gasEndpoint || required.some(key => !auth[key])) return null;
    return JSON.stringify({endpoint: context.gasEndpoint, orgId: auth.orgId,
      userId: auth.userId, email: auth.email, surface: auth.surface,
      schemaVersion: 1});
  }
  function openCache() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(cacheDbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('snapshots'))
          request.result.createObjectStore('snapshots', {keyPath: 'scopeKey'});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function cacheRequest(mode, operation) {
    const db = await openCache();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('snapshots', mode);
        const store = tx.objectStore('snapshots');
        let result;
        try { result = operation(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Snapshot cache failed'));
      });
    } finally { db.close(); }
  }
  async function readCachedSnapshot() {
    const key = scopeKey();
    if (!key) return null;
    const cached = await cacheRequest('readwrite', store => {
      const request = store.get(key);
      request.onsuccess = () => {
        const value = request.result;
        if (!value || Date.now() - value.savedAt > cacheTtlMs) store.delete(key);
        else { value.lastAccess = Date.now(); store.put(value); }
      };
      return request;
    });
    if (!cached || Date.now() - cached.savedAt > cacheTtlMs ||
        cached.manifest?.schemaVersion !== 1 || !cached.manifest?.datasetVersion ||
        !cached.datasets) return null;
    return cached;
  }
  async function writeCachedSnapshot(snapshot) {
    const key = scopeKey();
    if (!key) return;
    await cacheRequest('readwrite', store => {
      store.put({...snapshot, scopeKey: key, savedAt: Date.now(), lastAccess: Date.now()});
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(item =>
          Date.now() - item.savedAt <= cacheTtlMs).sort((a, b) => b.lastAccess - a.lastAccess);
        for (const item of request.result)
          if (Date.now() - item.savedAt > cacheTtlMs ||
              (entries.indexOf(item) >= cacheLimit)) store.delete(item.scopeKey);
      };
      return request;
    });
  }
  async function removeCachedSnapshot() {
    const key = scopeKey();
    if (key) await cacheRequest('readwrite', store => store.delete(key));
  }
  async function getModules() {
    const [duckdb, core] = await Promise.all([
      globalThis.duckdbWasmReady,
      import(new URL('analytics_core.mjs', document.baseURI).href)]);
    return {duckdb, core};
  }
  function safeUrl(url) {
    const result = new URL(url, location.origin);
    if (result.origin !== location.origin || !result.pathname.startsWith('/attendance/'))
      throw new Error('Invalid snapshot URL');
    return result.href;
  }
  function gasEndpoint() {
    const endpoint = new URL(context.gasEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com' ||
        endpoint.search || endpoint.hash ||
        !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint.pathname))
      throw new Error('Invalid GAS endpoint');
    return endpoint.href;
  }
  function gasForm(action, extra = {}) {
    const auth = context.authContext ?? {
      orgId: context.orgId, email: context.email, userId: context.userId,
      surface: context.surface, token: context.token,
    };
    const values = {action, ...auth, ...extra};
    if (!values.orgId || !values.email || !values.userId || !values.surface || !values.token)
      throw new Error('Host session required');
    return new URLSearchParams(Object.entries(values).map(([key, value]) =>
      [key, typeof value === 'string' ? value : String(value ?? '')]));
  }
  async function postGas(action, extra = {}) {
    const response = await fetch(gasEndpoint(), {method: 'POST', mode: 'cors',
      credentials: 'omit', cache: 'no-store',
      headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
      body: gasForm(action, extra).toString(), redirect: 'follow'});
    if (response.status === 401 || response.status === 403) {
      send('SESSION_EXPIRED'); throw new Error('Session expired');
    }
    if (!response.ok) throw new Error('Authorized dataset unavailable');
    return response;
  }
  async function fetchText(url) {
    const response = await fetch(safeUrl(url), {credentials: 'omit', cache: 'no-store',
      headers: {Authorization: `Bearer ${context.token}`}});
    if (response.status === 401 || response.status === 403) {
      send('SESSION_EXPIRED'); throw new Error('Session expired');
    }
    if (!response.ok) throw new Error('Authorized dataset unavailable');
    return response.text();
  }
  async function obtainManifest() {
    if (context.fixture === true && isLoopback && context.orgId === 'org_3')
      return {schemaVersion: 1, datasetVersion: 'sanitized-dev-fixture',
        sources: Object.fromEntries(['users','punches','approvals','locations','activity']
          .map(name => [name, `dev_fixture/${name}.csv`]))};
    if (context.gasEndpoint) {
      const response = await postGas('dashboardManifest');
      const result = await response.json();
      if (result.status && result.status !== 'ok') {
        if (['unauthorized', 'forbidden'].includes(String(result.status).toLowerCase()) ||
            ['SESSION_EXPIRED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(result.code)) send('SESSION_EXPIRED');
        throw new Error('Authorized dataset unavailable');
      }
      return {...result, sources: undefined};
    }
    if (!context.token || !context.manifestUrl) throw new Error('Host session required');
    return JSON.parse(await fetchText(context.manifestUrl));
  }
  async function datasetText(name, next) {
    if (context.fixture === true && isLoopback && context.orgId === 'org_3')
      return (await fetch(new URL(next.sources[name], document.baseURI), {cache:'no-store'})).text();
    if (context.gasEndpoint) {
      const response = await postGas('dashboardCsv', {dataset: name});
      const content = await response.text();
      if (/^\s*\{/.test(content)) {
        try {
          const result = JSON.parse(content);
          if (['unauthorized', 'forbidden'].includes(String(result.status).toLowerCase()) ||
              ['SESSION_EXPIRED', 'UNAUTHORIZED', 'FORBIDDEN'].includes(result.code)) send('SESSION_EXPIRED');
        } catch (_) { /* CSV may begin with a quoted/object-like field. */ }
        if (/^\s*\{"status"\s*:/.test(content)) throw new Error('Authorized dataset unavailable');
      }
      return content;
    }
    return fetchText(next.sources[name]);
  }
  async function load() {
    const {duckdb, core} = await getModules();
    if (!capability().webAssembly || !capability().worker)
      throw new Error('This device cannot run the analytics engine');
    const base = new URL('duckdb/', document.baseURI).href;
    const bundles = {
      mvp: {mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js'},
      eh: {mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js'},
    };
    const bundle = await duckdb.selectBundle(bundles);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(bundle.mainWorker));
    await db.instantiate(bundle.mainModule);
    await db.open({path: ':memory:', query: {castBigIntToDouble: true,
      castDecimalToDouble: true, castTimestampToDate: false}});
    conn = await db.connect();
    const cached = context.gasEndpoint ? await readCachedSnapshot().catch(() => null) : null;
    if (cached) {
      try {
        const snapshot = {manifest: cached.manifest, datasets: cached.datasets};
        await applySnapshot(snapshot, core);
        activeSnapshot = snapshot;
      } catch (_) {
        await removeCachedSnapshot().catch(() => {});
      }
    }
    if (!activeSnapshot) {
      const snapshot = await downloadSnapshot(core);
      await applySnapshot(snapshot, core);
      activeSnapshot = snapshot;
      if (context.gasEndpoint) await writeCachedSnapshot(snapshot).catch(() => {});
    }
    return {capabilities: capability(), version: manifest.datasetVersion,
      bundle: bundle.mainModule.split('/').pop()};
  }
  async function downloadSnapshot(core) {
    const next = await obtainManifest();
    if (next.schemaVersion !== 1) throw new Error('Unsupported dataset schema');
    const names = Object.keys(core.schemas);
    const datasets = {};
    await Promise.all(names.map(async name => {
      const available = context.gasEndpoint
        ? next.datasets?.[name] === true
        : Boolean(next.sources?.[name]);
      if (name === 'activity' && !available) { datasets[name] = null; return; }
      if (!available) throw new Error(`Missing ${name} source`);
      const content = await datasetText(name, next);
      const header = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]
        .split(',').map(v => v.replaceAll('"',''));
      if (core.required[name].some(field => !header.includes(field)))
        throw new Error(`Invalid ${name} schema`);
      datasets[name] = content;
    }));
    return {manifest: next, datasets};
  }
  async function applySnapshot(snapshot, core) {
    const sourceHeaders = {};
    const names = Object.keys(core.schemas);
    try {
      for (const name of names) {
        const content = snapshot.datasets[name];
        if (content === null && name === 'activity') {
          await conn.query(`CREATE OR REPLACE TABLE incoming_${name} (${core.schemas.activity})`);
          sourceHeaders[name] = [];
          continue;
        }
        if (typeof content !== 'string') throw new Error(`Missing ${name} dataset`);
        const header = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]
          .split(',').map(v => v.replaceAll('"',''));
        if (core.required[name].some(field => !header.includes(field)))
          throw new Error(`Invalid ${name} schema`);
        sourceHeaders[name] = header;
        const path = `incoming_${name}.csv`;
        await db.registerFileText(path, content);
        await conn.query(`CREATE OR REPLACE TABLE incoming_${name} AS SELECT * FROM read_csv_auto('${path}',
          all_varchar=true, header=true, sample_size=-1, null_padding=true)`);
      }
      for (const field of ['latitude','longitude']) {
        if (sourceHeaders.activity.length && !sourceHeaders.activity.includes(field))
          await conn.query(`ALTER TABLE incoming_activity ADD COLUMN ${field} VARCHAR`);
      }
      // The nearest-site hint remains scoped data; it is not an authorization result.
      const optionalPunchFields = ['reason_code','latitude','longitude']
        .filter(field => !sourceHeaders.punches.includes(field))
        .map(field => `NULL::VARCHAR AS ${field}`);
      await conn.query('BEGIN TRANSACTION');
      try {
        await conn.query('DROP VIEW IF EXISTS punch_fact');
        for (const name of names)
          await conn.query(`CREATE OR REPLACE TABLE raw_${name} AS SELECT * FROM incoming_${name}`);
        await conn.query(`CREATE OR REPLACE VIEW punch_fact AS SELECT *${optionalPunchFields.length
          ? ', ' + optionalPunchFields.join(', ') : ''} FROM raw_punches`);
        await conn.query('COMMIT');
        manifest = snapshot.manifest;
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      for (const name of names) await conn.query(`DROP TABLE IF EXISTS incoming_${name}`).catch(() => {});
    }
  }
  async function refreshSnapshot() {
    const {core} = await getModules();
    const previous = activeSnapshot;
    const next = await downloadSnapshot(core); // Always obtains a fresh manifest.
    await applySnapshot(next, core);
    activeSnapshot = next;
    if (context.gasEndpoint) {
      try { await writeCachedSnapshot(next); }
      catch (error) {
        if (previous) {
          await applySnapshot(previous, core);
          activeSnapshot = previous;
        }
        throw error;
      }
    }
  }
  let activeSnapshot;
  async function clearPersistedCache() {
    try { await removeCachedSnapshot(); } catch (_) { /* Session teardown must continue. */ }
  }
  globalThis.dashboardBridge = {
    patchVersion,
    openMap(latitude, longitude) {
      const lat=Number(latitude), lon=Number(longitude);
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)
        return false;
      const popup=window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`,
        '_blank');
      if (popup) popup.opener=null;
      return popup !== null;
    },
    onHostMessage(handler) {window.addEventListener('dashboard-host-message', e => handler(json(e.detail)));
      if (pendingInit) {
        const replay = pendingInit;
        pendingInit = undefined;
        // Flutter's bridge subscribes before its controller listens to the
        // broadcast stream. A synchronous replay would be discarded.
        queueMicrotask(() => handler(json(replay)));
      }},
    emit: send,
    emitJson(type, payload) { send(type, JSON.parse(payload)); },
    downloadCsv(filename, content) {
      const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;
      anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },
    async initialize(input) {
      context = typeof input === 'string' ? JSON.parse(input) : input;
      // The persistent cache is scoped to the supplied GAS deployment and auth
      // context; a normal reopen may therefore avoid a new export.
      initPromise ??= load();
      return json(await initPromise);
    },
    async query(input) {
      await initPromise;
      const filter = typeof input === 'string' ? JSON.parse(input) : input;
      const {core} = await getModules();
      currentFilter = filter;
      const start = performance.now();
      const statements = core.queries(filter,context?.metricPolicy), output = {};
      for (const [name, sql] of Object.entries(statements)) output[name] = rows(await conn.query(sql));
      return json({generation: filter.generation, queryMs: performance.now()-start,
        datasetVersion: manifest.datasetVersion, ...output});
    },
    async details(kind, id) {
      const {core} = await getModules();
      return json(rows(await conn.query(core.detailsQuery(currentFilter, kind, id,context?.metricPolicy))));
    },
    async refresh() {if (!conn) throw new Error('Not initialized');
      await refreshSnapshot();
      return json({datasetVersion: manifest.datasetVersion});},
    async clearCache() { await clearPersistedCache(); },
    async clear() {if (conn) await conn.close(); if (db) await db.terminate();
      conn = db = context = manifest = currentFilter = initPromise = activeSnapshot = undefined;},
  };
  function receive(message, origin, source) {
    if (origin !== hostOrigin || (source && source !== window.parent && source !== window.opener)) return;
    if (!message || message.version !== 1 || typeof message.type !== 'string') return;
    if (!['INIT_CONTEXT','SET_THEME','SET_USER_SCOPE','SET_LOCALE','SET_TIMEZONE',
      'REFRESH_DATA','CLEAR_CACHE','SESSION_EXPIRED','INSIGHT_RESULT'].includes(message.type)) return;
    if (message.type === 'INIT_CONTEXT') pendingInit = message;
    window.dispatchEvent(new CustomEvent('dashboard-host-message', {detail: message}));
  }
  window.addEventListener('message', e => receive(e.data, e.origin, e.source));
  globalThis.dashboardHostReceive = text => receive(JSON.parse(text), hostOrigin, null);
  queueMicrotask(async () => {
    send('READY', {capabilities: capability()});
    if (standaloneFixture) {
      try {
        const response = await fetch(new URL('dev_fixture/context.json',document.baseURI),{cache:'no-store'});
        if (!response.ok) throw new Error('Fixture context unavailable');
        const payload = await response.json();
        if (payload.fixture !== true || payload.orgId !== 'org_3')
          throw new Error('Invalid fixture context');
        receive({version:1,type:'INIT_CONTEXT',payload},hostOrigin,null);
      } catch (_) { send('ERROR',{code:'DEV_FIXTURE_UNAVAILABLE'}); }
    }
  });
})();
