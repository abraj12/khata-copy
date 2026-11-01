/**
 * Khata Application Service Worker
 *
 * Designed for reliable business application operation in TWA and PWA modes:
 * 1. ONLY INTERCEPTS SAME-ORIGIN REQUESTS: External requests (Cloudflare R2,
 *    Render API backend, etc.) are NEVER intercepted or cached by the Service Worker.
 * 2. Network-first for navigation/HTML documents: Guarantees that freshly deployed website
 *    updates become visible immediately on refresh/reopen without requiring an APK rebuild.
 * 3. Cache-first for immutable versioned static assets (/assets/*) with network fallback.
 * 4. STRICT EXCLUSION FOR ALL API CALLS (/api/*): Financial transactions, customer data,
 *    offline bills, and authentication sessions are NEVER cached in Service Worker storage.
 * 5. Safe cache invalidation and client claim on activation.
 */

const CACHE_VERSION = 'khata-static-v1.0.2';
const STATIC_CACHE_NAME = `khata-assets-${CACHE_VERSION}`;
// Matches Vite's hashed asset filenames (e.g. /assets/index-D1wM4r-5.js, /assets/index-DwglHT6G.css, /assets/font-Dx9f2Ab3.woff2)
const IMMUTABLE_ASSET_REGEX = /^\/assets\/[\w.-]+[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|gif|svg|webp|ico)$/i;

self.addEventListener('install', (event) => {
  // Activate immediately without waiting for existing tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            if (name !== STATIC_CACHE_NAME) {
              return caches.delete(name);
            }
            return Promise.resolve(false);
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept or cache non-GET requests (mutations, login, uploads, etc.)
  if (request.method !== 'GET') {
    return;
  }

  // 2. Strict origin check: ONLY handle requests to this PWA's own origin.
  // Never intercept or cache external domains (R2 storage, Render API, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. Strict exclusion for all API endpoints and health probes
  // Financial, customer, session, CSRF, and bill requests MUST always reach the server
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // 4. Document / Navigation requests: Network-First with cache fallback
  // This guarantees that any new index.html deployed to Vercel is fetched immediately
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            return (
              cachedResponse ||
              caches.match('/index.html') ||
              new Response(
                '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:2rem;background:#0f172a;color:#fff;"><h2>Khata Offline</h2><p>Please check your internet connection and refresh.</p></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              )
            );
          });
        })
    );
    return;
  }

  // 5. Versioned immutable static assets: Cache-First with network fallback
  if (IMMUTABLE_ASSET_REGEX.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 6. All other same-origin static GET requests (manifest, favicon, app icons): Stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(STATIC_CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => null);

      return cachedResponse || fetchPromise;
    })
  );
});

// Skip waiting / Cache clear message listener
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))));
  }
});
