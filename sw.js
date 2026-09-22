// Kwibus offline cache.
//
// Online, every request still goes to the network exactly as without this
// worker (index.html and assets revalidate on every visit), so a new build is
// never held back. The cache is only the fallback for when the network is
// gone: the last build this device saw keeps working on the train.
//
// tool/deploy_web.sh fills in BUILD and PRECACHE. Unfilled (a local build)
// the worker still runs and caches whatever the page loads.
const BUILD = 'd694dda1f766';
const PRECACHE = ["./", "flutter_bootstrap.js?v=d694dda1f766", "manifest.json", "favicon.png", "icons/Icon-192.png", "privacy", "assets/AssetManifest.bin", "assets/AssetManifest.bin.json", "assets/FontManifest.json", "assets/assets/fonts/Figtree.ttf", "assets/assets/fonts/LilitaOne.ttf", "assets/assets/sounds/box.wav", "assets/assets/sounds/card_place.wav", "assets/assets/sounds/card_tap.wav", "assets/assets/sounds/chalk_place.wav", "assets/assets/sounds/chalk_tap.wav", "assets/assets/sounds/dice_place.wav", "assets/assets/sounds/dice_tap.wav", "assets/assets/sounds/draw.wav", "assets/assets/sounds/error.wav", "assets/assets/sounds/flip.wav", "assets/assets/sounds/glass_place.wav", "assets/assets/sounds/glass_tap.wav", "assets/assets/sounds/lacquer_place.wav", "assets/assets/sounds/lacquer_tap.wav", "assets/assets/sounds/lose.wav", "assets/assets/sounds/metal_place.wav", "assets/assets/sounds/metal_tap.wav", "assets/assets/sounds/paper_place.wav", "assets/assets/sounds/paper_tap.wav", "assets/assets/sounds/pass.wav", "assets/assets/sounds/pop.wav", "assets/assets/sounds/pour.wav", "assets/assets/sounds/roll.wav", "assets/assets/sounds/stone_place.wav", "assets/assets/sounds/stone_tap.wav", "assets/assets/sounds/success.wav", "assets/assets/sounds/sweep.wav", "assets/assets/sounds/swish.wav", "assets/assets/sounds/tile_place.wav", "assets/assets/sounds/tile_tap.wav", "assets/assets/sounds/win.wav", "assets/assets/sounds/wood_place.wav", "assets/assets/sounds/wood_tap.wav", "assets/assets/words/en_common.txt", "assets/assets/words/en_guess.txt", "assets/assets/words/en_target.txt", "assets/assets/words/nl_common.txt", "assets/assets/words/nl_guess.txt", "assets/assets/words/nl_target.txt", "assets/fonts/MaterialIcons-Regular.otf", "assets/fonts/fallback/Roboto-Regular.ttf", "assets/shaders/ink_sparkle.frag", "assets/shaders/stretch_effect.frag"];
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
