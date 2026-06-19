/**
 * MotoDash — sw.js  (Service Worker)
 *
 * Strategies:
 *   App shell  → Stale-While-Revalidate
 *   CDN assets → Cache-First (long TTL)
 *   Map tiles  → Cache-First (CartoDB/OSM)
 *   Nominatim  → Network-First
 *   OSRM       → Network-Only (routes must be fresh)
 *
 * BUG FIX: Uses individual fetch+catch instead of cache.addAll()
 * so one missing file (e.g. icon-192.png not yet generated)
 * does NOT kill the entire Service Worker installation.
 */

'use strict';

const CACHE_SHELL = 'motodash-shell-v1';
const CACHE_CDN   = 'motodash-cdn-v1';
const CACHE_TILES = 'motodash-tiles-v1';
const CACHE_API   = 'motodash-api-v1';

const SHELL_URLS = [
    './index.html',
    './css/style.css',
    './js/utilities.js',
    './js/trip.js',
    './js/speedometer.js',
    './js/maps.js',
    './js/bluetooth.js',
    './js/voice.js',
    './js/media.js',
    './js/app.js',
    './manifest.json',
    './assets/icons/icon.svg'
];

const CDN_URLS = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js'
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            // Cache shell files individually — one failure won't break others
            const shellCache = await caches.open(CACHE_SHELL);
            for (const url of SHELL_URLS) {
                try {
                    const res = await fetch(url);
                    if (res.ok) await shellCache.put(url, res);
                } catch { /* file not available yet, skip */ }
            }

            // Cache CDN assets individually
            const cdnCache = await caches.open(CACHE_CDN);
            for (const url of CDN_URLS) {
                try {
                    const res = await fetch(url, { mode: 'cors' });
                    if (res.ok) await cdnCache.put(url, res);
                } catch { /* CDN unavailable, skip */ }
            }

            await self.skipWaiting();
            console.log('[SW] Installed');
        })()
    );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    const KEEP = new Set([CACHE_SHELL, CACHE_CDN, CACHE_TILES, CACHE_API]);
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
    console.log('[SW] Activated');
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Map tiles → Cache-First
    if (url.hostname.includes('cartocdn.com') ||
        url.hostname.includes('tile.openstreetmap.org')) {
        event.respondWith(cacheFirst(req, CACHE_TILES));
        return;
    }

    // Nominatim geocoding → Network-First
    if (url.hostname.includes('nominatim.openstreetmap.org')) {
        event.respondWith(networkFirst(req, CACHE_API));
        return;
    }

    // OSRM routing → Network-Only (must be live)
    if (url.hostname.includes('router.project-osrm.org')) {
        event.respondWith(
            fetch(req).catch(() =>
                new Response(JSON.stringify({ code: 'NoRoute', message: 'Offline' }),
                    { headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }

    // CDN (Leaflet, fonts, jsmediatags) → Cache-First
    if (url.hostname.includes('unpkg.com') ||
        url.hostname.includes('cdnjs.cloudflare.com') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(cacheFirst(req, CACHE_CDN));
        return;
    }

    // App shell → Stale-While-Revalidate
    event.respondWith(staleWhileRevalidate(req, CACHE_SHELL));
});

// ── STRATEGIES ───────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
    } catch {
        return new Response('', { status: 503 });
    }
}

async function networkFirst(req, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
    } catch {
        return (await cache.match(req)) || new Response('', { status: 503 });
    }
}

async function staleWhileRevalidate(req, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(req);
    const fetchP = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
    }).catch(() => null);
    return cached || fetchP;
}

// ── MESSAGES ─────────────────────────────────────────────────
self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
