// Kwibus offline cache.
//
// Online, every request still goes to the network exactly as without this
// worker (index.html and assets revalidate on every visit), so a new build is
// never held back. The cache is only the fallback for when the network is
// gone: the last build this device saw keeps working on the train.
//
// tool/deploy_web.sh fills in BUILD and PRECACHE. Unfilled (a local build)
// the worker still runs and caches whatever the page loads.
const BUILD = 'dev'; // KW_BUILD
const PRECACHE = []; // KW_PRECACHE
const CACHE = 'kwibus-offline';
const INDEX = new URL('./', self.registration.scope).href;
const MAIN = /\/main\.[0-9a-f]{12}\.dart\.(js|wasm|mjs)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Revalidates: unchanged files come back as a cheap 304 from the HTTP cache.
    await Promise.all(PRECACHE.map((path) => store(cache, new URL(path, self.registration.scope).href, 'no-cache')));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Caches from Flutter's old worker and anything that is not ours.
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// The page lists what it loaded before this worker took control (the first
// visit), so that the renderer and fonts it used are there offline too.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'kw-cache' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of data.urls) {
      if (typeof url !== 'string' || !url.startsWith(self.location.origin)) continue;
      if (await cache.match(url)) continue;
      await store(cache, url, 'default');
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The usage API is never cached: it is live data for the maker only.
  if (url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(navigate(req, url));
  } else if (MAIN.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

async function navigate(req, url) {
  const cache = await caches.open(CACHE);
  const isApp = url.pathname === '/' || url.pathname.endsWith('/index.html');
  try {
    // A train connection that hangs is treated as no connection.
    const res = await withTimeout(fetch(req), 6000);
    if (res.ok) await cache.put(isApp ? INDEX : req.url.split('#')[0].split('?')[0], res.clone());
    return res;
  } catch (err) {
    const hit = isApp
      ? await cache.match(INDEX)
      : (await cache.match(req, { ignoreSearch: true })) || (await cache.match(INDEX));
    if (hit) return hit;
    throw err;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await put(cache, req.url, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    throw err;
  }
}

// The app script (JavaScript, or WebAssembly plus its runtime) has its
// content hash in its name, so a cached copy is always the right one.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await put(cache, req.url, res.clone());
  return res;
}

async function store(cache, url, mode) {
  try {
    const res = await fetch(url, { cache: mode });
    if (res.ok && res.type === 'basic') await put(cache, url, res);
  } catch (_) {
    // Offline or gone: keep whatever copy there is.
  }
}

// Keeps one copy per file: a new ?v= of the bootstrap or a new app script
// replaces the old one instead of piling up build after build.
async function put(cache, url, res) {
  const clean = url.split('#')[0];
  const path = new URL(clean).pathname;
  for (const key of await cache.keys()) {
    const other = new URL(key.url).pathname;
    const sameFile = other === path && key.url !== clean;
    // An older build of the same kind of app file (.js, .wasm or .mjs).
    const kind = (p) => (p.match(MAIN) || [])[1];
    const oldMain = MAIN.test(path) && MAIN.test(other) && other !== path && kind(other) === kind(path);
    if (sameFile || oldMain) await cache.delete(key);
  }
  await cache.put(clean, res);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
