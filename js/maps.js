/**
 * MotoDash — maps.js
 * Leaflet.js maps: OpenStreetMap tiles (CartoDB Dark),
 * custom motorcycle marker, Nominatim geocoding,
 * OSRM turn-by-turn navigation via Leaflet Routing Machine,
 * ETA & distance remaining display.
 */

'use strict';

class MapsModule {
    constructor() {
        this.map              = null;
        this.motoMarker       = null;
        this.destMarker       = null;
        this.routeControl     = null;
        this.currentPos       = null;  // { lat, lng }
        this.isFollowing      = true;
        this.isNavigating     = false;
        this.routeSteps       = [];
        this.currentStepIdx   = 0;
        this.totalDist        = 0;     // meters
        this.totalTime        = 0;     // seconds
        this._searchResults   = [];
        this._searchDebounce  = null;

        // Turn arrow icons (defined here for broader browser compatibility)
        this.TURN_ICONS = {
            Straight          : '⬆',
            SlightRight       : '↗',
            Right             : '➡',
            SharpRight        : '↪',
            Roundabout        : '🔄',
            SharpLeft         : '↩',
            Left              : '⬅',
            SlightLeft        : '↖',
            DestinationReached: '🏁',
            WaypointReached   : '📍'
        };

        this._init();
    }

    // ─────────────────────────────────────────────────────
    //  INITIALISE MAP
    // ─────────────────────────────────────────────────────
    _init() {
        /* Default centre: Jakarta — overridden by first GPS fix */
        const lat0 = -6.2088, lng0 = 106.8456, z0 = 14;

        this.map = L.map('map', {
            center       : [lat0, lng0],
            zoom         : z0,
            zoomControl  : false,
            attributionControl: false
        });

        /* CartoDB Dark Matter — no API key, free */
        L.tileLayer(
            'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
            {
                attribution : '© OpenStreetMap © CartoDB',
                subdomains   : 'abcd',
                maxZoom      : 19
            }
        ).addTo(this.map);

        /* Compact attribution */
        L.control.attribution({ position: 'bottomright', prefix: '© OSM · CartoDB' })
                 .addTo(this.map);

        /* Zoom buttons */
        L.control.zoom({ position: 'bottomright' }).addTo(this.map);

        /* Stop auto-follow when user drags map */
        this.map.on('dragstart', () => { this.isFollowing = false; });

        /*
         * FIX: Call invalidateSize after a short delay to ensure the container
         * has been painted by the browser before Leaflet measures it.
         * Also called again by switchPanel() on every panel activation.
         */
        setTimeout(() => this.map.invalidateSize(), 200);

        this._setupSearch();
        this._setupToolbarButtons();
        this._subscribeGPS();
        this._subscribeEvents();

        console.log('[Maps] Initialized ✓');
    }

    // ─────────────────────────────────────────────────────
    //  MOTORCYCLE MARKER
    // ─────────────────────────────────────────────────────
    _motoIconHTML(heading = 0) {
        return `<div class="moto-marker-wrap" style="transform:rotate(${heading}deg)">
          <svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
            <circle cx="22" cy="22" r="20" fill="rgba(0,174,239,0.18)" stroke="#00AEEF" stroke-width="2"/>
            <!-- Arrow head -->
            <polygon points="22,6 28,34 22,29 16,34" fill="#00AEEF"/>
            <!-- Centre dot -->
            <circle cx="22" cy="22" r="4" fill="#FFFFFF" opacity="0.9"/>
            <!-- Accuracy pulse -->
            <circle cx="22" cy="22" r="8" fill="none" stroke="#00AEEF"
                    stroke-width="1" opacity="0.4" class="moto-pulse"/>
          </svg>
        </div>`;
    }

    _updateMotoMarker(lat, lng, heading = 0) {
        const icon = L.divIcon({
            html       : this._motoIconHTML(heading),
            iconSize   : [44, 44],
            iconAnchor : [22, 22],
            className  : 'moto-marker-icon'
        });
        if (!this.motoMarker) {
            this.motoMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
                               .addTo(this.map);
        } else {
            this.motoMarker.setLatLng([lat, lng]);
            this.motoMarker.setIcon(icon);
        }
    }

    _placeDestMarker(lat, lng, label = 'Destination') {
        this.destMarker?.remove();
        const html = `<div class="dest-pin">
          <svg width="32" height="44" viewBox="0 0 32 44">
            <path d="M16 0C7.16 0 0 7.16 0 16 0 28 16 44 16 44S32 28 32 16C32 7.16 24.84 0 16 0Z"
                  fill="#FF4444"/>
            <circle cx="16" cy="16" r="8" fill="white" opacity="0.9"/>
          </svg>
        </div>`;
        this.destMarker = L.marker([lat, lng], {
            icon: L.divIcon({ html, iconSize:[32,44], iconAnchor:[16,44], className:'' })
        }).addTo(this.map).bindTooltip(label.slice(0,40), { permanent:false });
    }

    // ─────────────────────────────────────────────────────
    //  GPS SUBSCRIPTION
    // ─────────────────────────────────────────────────────
    _subscribeGPS() {
        Utils.EventBus.on('gps:update', ({ lat, lng, heading, speed }) => {
            this.currentPos = { lat, lng };
            this._updateMotoMarker(lat, lng, heading || 0);

            if (this.isFollowing) {
                this.map.setView([lat, lng], this.map.getZoom(), { animate: true });
            }

            if (this.isNavigating) {
                this._checkStepProgress(lat, lng, speed);
            }
        });
    }

    // ─────────────────────────────────────────────────────
    //  SEARCH (Nominatim)
    // ─────────────────────────────────────────────────────
    _setupSearch() {
        const input = document.getElementById('search-input');
        const btn   = document.getElementById('search-btn');

        btn?.addEventListener('click',  () => this._doSearch());
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._doSearch(); });
        input?.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            const q = input.value.trim();
            if (q.length >= 3) {
                this._searchDebounce = setTimeout(() => this._doSearch(true), 650);
            } else {
                this._hideResults();
            }
        });

        /* Close dropdown when clicking outside */
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#map-toolbar') && !e.target.closest('#search-results'))
                this._hideResults();
        });
    }

    async _doSearch(silent = false) {
        const input = document.getElementById('search-input');
        const q     = input?.value?.trim();
        if (!q || q.length < 2) return;

        try {
            const url = `https://nominatim.openstreetmap.org/search` +
                        `?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=1`;
            const resp    = await fetch(url, {
                headers: {
                    'Accept'    : 'application/json',
                    'User-Agent': 'MotoDash/1.0 (https://github.com/motodash)'
                }
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const results = await resp.json();
            this._searchResults = results;
            this._showResults(results);
        } catch (err) {
            console.error('[Maps] Search error:', err);
            if (!silent) Utils.showToast('Search failed — check network', 'error');
        }
    }

    _showResults(results) {
        const box = document.getElementById('search-results');
        if (!box) return;

        if (!results.length) {
            box.innerHTML = '<div class="search-no-result">No results found</div>';
            box.style.display = 'block';
            return;
        }

        box.innerHTML = results.map((r, i) => {
            const name  = r.display_name.split(',')[0];
            const addr  = r.display_name.split(',').slice(1, 3).join(', ');
            return `<div class="search-result-item" data-i="${i}">
              <svg class="sr-pin" width="14" height="14" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              <div class="sr-text">
                <div class="sr-name">${name}</div>
                <div class="sr-addr">${addr}</div>
              </div>
            </div>`;
        }).join('');
        box.style.display = 'block';

        box.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const r = this._searchResults[+el.dataset.i];
                if (r) this._selectDestination(+r.lat, +r.lon, r.display_name);
            });
        });
    }

    _hideResults() {
        const box = document.getElementById('search-results');
        if (box) box.style.display = 'none';
    }

    // ─────────────────────────────────────────────────────
    //  SELECT & NAVIGATE
    // ─────────────────────────────────────────────────────
    _selectDestination(lat, lng, name) {
        this._hideResults();
        const label = name.split(',')[0];
        const input = document.getElementById('search-input');
        if (input) input.value = label;

        this._placeDestMarker(lat, lng, label);
        this.map.fitBounds([
            [this.currentPos?.lat ?? lat - 0.01, this.currentPos?.lng ?? lng - 0.01],
            [lat, lng]
        ], { padding: [40, 40] });

        if (this.currentPos) {
            this._startNavigation(
                this.currentPos.lat, this.currentPos.lng, lat, lng, label
            );
        } else {
            Utils.showToast('Waiting for GPS fix to begin navigation…', 'warning');
        }
    }

    // ─────────────────────────────────────────────────────
    //  ROUTING  (Leaflet Routing Machine + OSRM)
    // ─────────────────────────────────────────────────────
    _startNavigation(fromLat, fromLng, toLat, toLng, destName) {
        /*
         * DEFENSIVE CHECK: L.Routing comes from leaflet-routing-machine.js
         * (a separate CDN script). If that file failed to load — network
         * issue, CDN outage, blocked script — calling L.Routing.control()
         * would throw "Cannot read properties of undefined". Catch this
         * early with a clear message instead of a silent crash.
         */
        if (typeof L.Routing === 'undefined') {
            console.error('[Maps] FATAL: L.Routing is not defined. vendor/leaflet-routing-machine/leaflet-routing-machine.js failed to load.');
            Utils.showToast('Fitur navigasi gagal dimuat — coba refresh halaman', 'error', 5000);
            this.isNavigating = false;
            return;
        }

        /* Remove old route */
        if (this.routeControl) {
            this.map.removeControl(this.routeControl);
            this.routeControl = null;
        }

        this.isNavigating    = true;
        this.currentStepIdx  = 0;
        Utils.showToast('Calculating route…', 'info');

        this.routeControl = L.Routing.control({
            waypoints: [
                L.latLng(fromLat, fromLng),
                L.latLng(toLat,   toLng)
            ],
            routeWhileDragging : false,
            showAlternatives   : false,
            fitSelectedRoutes  : false,
            lineOptions: {
                styles: [
                    { color: '#00AEEF', opacity: 0.85, weight: 6 },
                    { color: '#005577', opacity: 0.4,  weight: 12 }
                ],
                extendToWaypoints     : true,
                missingRouteTolerance : 0
            },
            createMarker: () => null,   // use our custom markers
            router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1',
                profile   : 'driving'
            })
        }).addTo(this.map);

        this.routeControl.on('routesfound', (e) => {
            const route          = e.routes[0];
            this.routeSteps      = route.instructions || [];
            this.totalDist       = route.summary.totalDistance;
            this.totalTime       = route.summary.totalTime;
            this.currentStepIdx  = 0;

            this._showNavBar(true);
            this._showNavStopBtn(true);
            this._renderStep(0);

            const d = Utils.formatDistance(this.totalDist);
            const t = Utils.formatETA(this.totalTime);
            Utils.showToast(`Route found: ${d} · ETA ${t}`, 'success');

            /* Voice announcement */
            Utils.EventBus.emit('voice:announce',
                { text: `Route calculated. ${d}. Estimated ${t}.` }
            );
        });

        this.routeControl.on('routingerror', () => {
            Utils.showToast('Route calculation failed', 'error');
            this.isNavigating = false;
        });

        /*
         * FIX: Hide LRM's own panel with retry limit.
         * Without a limit, if LRM never renders (offline/error),
         * the recursive setTimeout runs forever causing CPU leak.
         */
        let hideRetries = 0;
        const hidePanel = () => {
            const lrm = document.querySelector('.leaflet-routing-container');
            if (lrm) {
                lrm.style.display = 'none';
            } else if (hideRetries++ < 20) {
                setTimeout(hidePanel, 200);
            }
            // Stop after 20 retries (4 seconds) — LRM may not have rendered
        };
        hidePanel();
    }

    stopNavigation() {
        if (this.routeControl) {
            this.map.removeControl(this.routeControl);
            this.routeControl = null;
        }
        this.destMarker?.remove();
        this.destMarker    = null;
        this.isNavigating  = false;
        this.routeSteps    = [];
        this.currentStepIdx = 0;

        this._showNavBar(false);
        this._showNavStopBtn(false);

        const input = document.getElementById('search-input');
        if (input) input.value = '';

        Utils.showToast('Navigation stopped', 'info');
    }

    // ─────────────────────────────────────────────────────
    //  TURN-BY-TURN RENDERING
    // ─────────────────────────────────────────────────────

    _renderStep(idx) {
        if (!this.routeSteps.length || idx >= this.routeSteps.length) return;
        const step   = this.routeSteps[idx];
        const arrow  = this.TURN_ICONS[step.type] || '⬆';
        const dist   = Utils.formatDistance(step.distance || 0);
        const text   = step.text || 'Continue';

        /* Remaining distance / time from current step onward */
        let remDist = this.totalDist;
        let remTime = this.totalTime;
        for (let i = 0; i < idx; i++) {
            remDist -= (this.routeSteps[i]?.distance || 0);
            remTime -= (this.routeSteps[i]?.time     || 0);
        }
        remDist = Math.max(0, remDist);
        remTime = Math.max(0, remTime);

        Utils.setEl('nav-turn-icon',        arrow);
        Utils.setEl('nav-instruction-text', text);
        Utils.setEl('nav-step-distance',    dist);
        Utils.setEl('nav-remaining',        Utils.formatDistance(remDist));

        /* Arrival time */
        const eta  = new Date(Date.now() + remTime * 1000);
        const etaS = `${String(eta.getHours()).padStart(2,'0')}:${String(eta.getMinutes()).padStart(2,'0')}`;
        Utils.setEl('nav-eta', `ETA ${etaS}`);
    }

    _checkStepProgress(lat, lng, speed) {
        if (!this.routeSteps.length) return;
        const step = this.routeSteps[this.currentStepIdx];
        if (!step?.waypoint) return;

        const dist = Utils.haversineDistance(lat, lng, step.waypoint.lat, step.waypoint.lng);
        /* Advance step when within 25 m of waypoint */
        if (dist < 25 && this.currentStepIdx < this.routeSteps.length - 1) {
            this.currentStepIdx++;
            this._renderStep(this.currentStepIdx);
            const nextStep = this.routeSteps[this.currentStepIdx];
            if (nextStep?.text) {
                Utils.EventBus.emit('voice:announce', { text: nextStep.text });
            }
        }
    }

    // ─────────────────────────────────────────────────────
    //  VOICE-DRIVEN NAVIGATE
    // ─────────────────────────────────────────────────────
    async navigateTo(query) {
        try {
            const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
            const resp = await fetch(url, {
                headers: {
                    'Accept'    : 'application/json',
                    'User-Agent': 'MotoDash/1.0 (https://github.com/motodash)'
                }
            });
            const data = await resp.json();
            if (data.length) {
                this._selectDestination(+data[0].lat, +data[0].lon, data[0].display_name);
                return true;
            }
            Utils.showToast(`Location not found: ${query}`, 'warning');
        } catch {
            Utils.showToast('Navigation search failed', 'error');
        }
        return false;
    }

    // ─────────────────────────────────────────────────────
    //  MAP CONTROLS
    // ─────────────────────────────────────────────────────
    centerOnLocation() {
        if (!this.currentPos) { Utils.showToast('GPS not available', 'warning'); return; }
        this.isFollowing = true;
        this.map.setView([this.currentPos.lat, this.currentPos.lng], 16, { animate: true });
    }

    zoomIn()  { this.map.zoomIn();  }
    zoomOut() { this.map.zoomOut(); }

    // ─────────────────────────────────────────────────────
    //  NAV UI HELPERS
    // ─────────────────────────────────────────────────────
    _showNavBar(visible) {
        const el = document.getElementById('nav-instruction-bar');
        if (el) el.style.display = visible ? 'flex' : 'none';
    }
    _showNavStopBtn(visible) {
        const el = document.getElementById('nav-stop-btn');
        if (el) el.style.display = visible ? 'flex' : 'none';
    }

    // ─────────────────────────────────────────────────────
    //  TOOLBAR BUTTONS
    // ─────────────────────────────────────────────────────
    _setupToolbarButtons() {
        document.getElementById('center-map-btn')
            ?.addEventListener('click', () => this.centerOnLocation());
        document.getElementById('nav-stop-btn')
            ?.addEventListener('click', () => this.stopNavigation());
    }

    // ─────────────────────────────────────────────────────
    //  EVENT BUS
    // ─────────────────────────────────────────────────────
    _subscribeEvents() {
        Utils.EventBus.on('navigate:to', ({ destination }) => this.navigateTo(destination));
        Utils.EventBus.on('map:zoom-in',  () => this.zoomIn());
        Utils.EventBus.on('map:zoom-out', () => this.zoomOut());
        Utils.EventBus.on('map:center',   () => this.centerOnLocation());
        Utils.EventBus.on('nav:stop',     () => this.stopNavigation());
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    /* Small delay — ensures the map <div> is painted */
    setTimeout(() => {
        /*
         * DEFENSIVE CHECK: If the Leaflet library (global `L`) failed to
         * load — e.g. CDN is down, blocked by network/firewall, ad-blocker,
         * or a corrupted SRI integrity hash — show a clear, visible error
         * instead of silently failing with a blank map and a console-only
         * error. This makes future CDN issues immediately diagnosable.
         */
        if (typeof L === 'undefined') {
            const mapEl = document.getElementById('map');
            if (mapEl) {
                mapEl.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;
                                justify-content:center;height:100%;padding:24px;
                                text-align:center;color:#FF4444;font-family:sans-serif;">
                        <div style="font-size:40px;margin-bottom:12px;">⚠️</div>
                        <div style="font-size:15px;font-weight:600;margin-bottom:8px;">
                            Peta gagal dimuat
                        </div>
                        <div style="font-size:13px;color:#7A9BB5;max-width:320px;line-height:1.6;">
                            File vendor/leaflet/leaflet.js tidak berhasil dimuat.
                            Pastikan folder <code>vendor/</code> ikut ter-upload ke
                            GitHub. Cek juga Console (F12) untuk detail error.
                        </div>
                    </div>`;
            }
            console.error('[Maps] FATAL: Leaflet (L) is not defined. vendor/leaflet/leaflet.js failed to load — check that the vendor/ folder was deployed.');
            Utils.showToast?.('Peta gagal dimuat — cek folder vendor/', 'error', 6000);
            return; // Do not attempt to construct MapsModule — it will throw
        }

        window.mapsModule = new MapsModule();
        console.log('[Maps] Ready ✓');
    }, 150);
});
