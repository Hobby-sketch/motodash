/**
 * MotoDash — sw.js
 * Service Worker: offline caching strategy.
 *
 * Caches:
 *   SHELL  — app HTML/CSS/JS (stale-while-revalidate)
 *   CDN    — Leaflet, fonts (cache-first, long-lived)
 *   TILES  — OSM / CartoDB map tiles (cache-first)
 *   API    — Nominatim search responses (network-first, short TTL)
 */

'use strict';

const CACHE_SHELL = 'motodash-shell-v1.0.0';
const CACHE_CDN   = 'motodash-cdn-v1.0.0';
const CACHE_TILES = 'motodash-tiles-v1.0.0';
const CACHE_API   = 'motodash-api-v1.0.0';

/* ── App shell files (relative paths) ──────────────────────────── */
const SHELL_URLS = [
    './',
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

/* ── CDN assets ─────────────────────────────────────────────────── */
const CDN_URLS = [
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
    'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js'
];

// ═══════════════════════════════════════════════════════════
//  INSTALL  — pre-cache shell + CDN
// ═══════════════════════════════════════════════════════════
self.addEventListener('install', (event) => {
    console.log('[SW] Installing…');
    event.waitUntil(
        Promise.all([
            caches.open(CACHE_SHELL).then(c => c.addAll(SHELL_URLS)),
            caches.open(CACHE_CDN).then(c =>
                Promise.all(CDN_URLS.map(url =>
                    fetch(url, { mode: 'cors' })
                        .then(r => r.ok ? c.put(url, r) : null)
                        .catch(() => null)
                ))
            )
        ]).then(() => self.skipWaiting())
    );
});

// ═══════════════════════════════════════════════════════════
//  ACTIVATE  — purge old caches
// ═══════════════════════════════════════════════════════════
self.addEventListener('activate', (event) => {
    const KEEP = new Set([CACHE_SHELL, CACHE_CDN, CACHE_TILES, CACHE_API]);
    event.waitUntil(
        caches.keys()
              .then(keys => Promise.all(
                  keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))
              ))
              .then(() => self.clients.claim())
    );
    console.log('[SW] Activated');
});

// ═══════════════════════════════════════════════════════════
//  FETCH  — routing strategy
// ═══════════════════════════════════════════════════════════
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    /* ── Skip non-GET ──────────────────────────────────── */
    if (request.method !== 'GET') return;

    /* ── Map tiles (CartoDB / OSM) → Cache-First ──────── */
    if (url.hostname.includes('cartocdn.com') ||
        url.hostname.includes('tile.openstreetmap.org') ||
        url.hostname.includes('basemaps.cartocdn.com')) {
        event.respondWith(cacheFirst(request, CACHE_TILES));
        return;
    }

    /* ── Nominatim (geocoding) → Network-First ─────────── */
    if (url.hostname.includes('nominatim.openstreetmap.org')) {
        event.respondWith(networkFirst(request, CACHE_API));
        return;
    }

    /* ── OSRM routing → Network only (needs real-time) ─── */
    if (url.hostname.includes('router.project-osrm.org')) {
        event.respondWith(
            fetch(request).catch(() =>
                new Response(JSON.stringify({ code: 'NoRoute', message: 'Offline' }),
                    { headers: { 'Content-Type': 'application/json' } })
            )
        );
        return;
    }

    /* ── CDN (Leaflet, Google Fonts) → Cache-First ─────── */
    if (url.hostname.includes('unpkg.com') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(cacheFirst(request, CACHE_CDN));
        return;
    }

    /* ── App shell → Stale-While-Revalidate ─────────────── */
    event.respondWith(staleWhileRevalidate(request, CACHE_SHELL));
});

// ═══════════════════════════════════════════════════════════
//  STRATEGIES
// ═══════════════════════════════════════════════════════════

/** Cache-first: serve from cache, fetch & store on miss. */
async function cacheFirst(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch {
        return new Response('', { status: 503, statusText: 'Service Unavailable' });
    }
}

/** Network-first: try network, fall back to cache. */
async function networkFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
    } catch {
        const cached = await cache.match(request);
        return cached || new Response('', { status: 503 });
    }
}

/** Stale-While-Revalidate: serve cache immediately, update in background. */
async function staleWhileRevalidate(request, cacheName) {
    const cache    = await caches.open(cacheName);
    const cached   = await cache.match(request);
    const fetchPrm = fetch(request)
        .then(r => { if (r.ok) cache.put(request, r.clone()); return r; })
        .catch(() => null);
    return cached || fetchPrm;
}

// ═══════════════════════════════════════════════════════════
//  BACKGROUND SYNC (optional) — keep state current
// ═══════════════════════════════════════════════════════════
self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
