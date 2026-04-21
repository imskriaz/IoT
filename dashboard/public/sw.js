/**
 * Service Worker — caches static assets for fast revisit.
 * Cache-first for static files; network-first for API and HTML pages.
 */

const CACHE_NAME = 'esp32-dash-v5';
const IS_LOCAL = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

const STATIC_ASSETS = [
    '/css/app.css',
    '/js/common.js',
    '/js/db.js',
    '/js/main.js'
];

// Install: pre-cache static assets
self.addEventListener('install', (event) => {
    if (IS_LOCAL) {
        event.waitUntil(
            caches.keys().then((keys) =>
                Promise.all(keys.map((k) => caches.delete(k)))
            )
        );
    } else {
        event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
        );
    }
    self.skipWaiting();
});

// Activate: remove old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: cache-first for static assets, network-first for everything else
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET, API calls, socket.io, and cross-origin assets.
    if (request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
    if (url.pathname.startsWith('/auth/')) return;
    if (url.origin !== self.location.origin) return;

    if (IS_LOCAL) return;

    // Cache-first for known static extensions
    const isStatic = /\.(css|js|woff2?|ttf|eot|svg|png|jpg|ico)(\?.*)?$/.test(url.pathname);

    if (isStatic) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                });
            })
        );
    }
    // HTML pages: network-first with cache fallback
    // Cache the last successful response so offline visits don't get a blank error page.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
        );
    }
});
