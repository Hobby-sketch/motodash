/**
 * MotoDash — app.js
 * Main Application Controller:
 * panel switching, status bar, Wake Lock, Screen Orientation,
 * settings UI, auto theme, dial pad, PWA service worker.
 */

'use strict';

class MotoDash {
    constructor() {
        this.currentPanel = 'maps';
        this.wakeLock     = null;
        this.settings     = this._loadSettings();

        this._init();
        console.log('[MotoDash] Application started ✓');
    }

    // ─────────────────────────────────────────────────────
    //  INITIALISE
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupDock();
        this._startClock();
        this._watchNetworkStatus();
        this._requestBattery();
        this._requestWakeLock();
        this._lockOrientation();
        this._applySettings();
        this._setupSettingsUI();
        this._setupDialPad();
        this._applyAutoTheme();
        this._registerSW();
        this._subscribeEvents();

        /* Switch to maps on start */
        this.switchPanel('maps');

        setTimeout(() => Utils.showToast('MotoDash ready — ride safe! 🏍', 'success'), 800);
    }

    // ─────────────────────────────────────────────────────
    //  DOCK & PANEL SWITCHING
    // ─────────────────────────────────────────────────────
    _setupDock() {
        document.querySelectorAll('.dock-btn').forEach(btn =>
            btn.addEventListener('click', () => this.switchPanel(btn.dataset.panel))
        );
    }

    switchPanel(name) {
        this.currentPanel = name;

        document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.dock-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.panel === name)
        );

        const target = document.getElementById(`panel-${name}`);
        if (target) target.classList.add('active');

        /* Leaflet needs invalidateSize when its container becomes visible */
        if (name === 'maps' && window.mapsModule?.map) {
            setTimeout(() => window.mapsModule.map.invalidateSize(), 60);
        }
    }

    // ─────────────────────────────────────────────────────
    //  CLOCK & DATE  (status bar)
    // ─────────────────────────────────────────────────────
    _startClock() {
        const tick = () => {
            Utils.setEl('current-time', Utils.getCurrentTime());
            Utils.setEl('current-date', Utils.getCurrentDate());
        };
        tick();
        setInterval(tick, 1000);
    }

    // ─────────────────────────────────────────────────────
    //  NETWORK STATUS
    // ─────────────────────────────────────────────────────
    _watchNetworkStatus() {
        const update = () => {
            const online = navigator.onLine;
            const ico    = document.getElementById('wifi-icon');
            if (ico) ico.style.opacity = online ? '1' : '0.3';
        };
        update();
        window.addEventListener('online',  () => { update(); Utils.showToast('Back online ✓', 'success'); });
        window.addEventListener('offline', () => { update(); Utils.showToast('Offline mode',  'warning'); });
        setInterval(update, 30000);
    }

    // ─────────────────────────────────────────────────────
    //  BATTERY STATUS
    // ─────────────────────────────────────────────────────
    async _requestBattery() {
        if (!('getBattery' in navigator)) return;
        try {
            const bat = await navigator.getBattery();
            const upd = () => {
                const lvl  = Math.round(bat.level * 100);
                Utils.setEl('battery-percent', `${lvl}%`);
                const fill = document.getElementById('battery-fill');
                if (fill) {
                    fill.style.width      = `${lvl}%`;
                    fill.style.background = lvl <= 20 ? '#FF4444' :
                                            lvl <= 50 ? '#FFAA00' : '#00FF66';
                }
            };
            upd();
            bat.addEventListener('levelchange',   upd);
            bat.addEventListener('chargingchange', upd);
        } catch { /* Battery API optional */ }
    }

    // ─────────────────────────────────────────────────────
    //  WAKE LOCK  (prevent screen sleep while riding)
    // ─────────────────────────────────────────────────────
    async _requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this.wakeLock = await navigator.wakeLock.request('screen');
            console.log('[App] Wake Lock acquired');

            /* Re-acquire after tab visibility change */
            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible') {
                    try { this.wakeLock = await navigator.wakeLock.request('screen'); }
                    catch { /* ignore */ }
                }
            });
        } catch (e) { console.warn('[App] Wake Lock:', e.message); }
    }

    // ─────────────────────────────────────────────────────
    //  SCREEN ORIENTATION  (force landscape)
    // ─────────────────────────────────────────────────────
    _lockOrientation() {
        screen.orientation?.lock?.('landscape').catch(() => {/* non-critical */});
    }

    // ─────────────────────────────────────────────────────
    //  FULLSCREEN
    // ─────────────────────────────────────────────────────
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            (document.documentElement.requestFullscreen?.() ||
             document.documentElement.webkitRequestFullscreen?.());
            Utils.setEl('fullscreen-btn-label', 'Exit Fullscreen');
        } else {
            (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
            Utils.setEl('fullscreen-btn-label', 'Enter Fullscreen');
        }
    }

    // ─────────────────────────────────────────────────────
    //  SETTINGS
    // ─────────────────────────────────────────────────────
    _loadSettings() {
        return Utils.Storage.get('app_settings', {
            brightness  : 100,
            autoTheme   : true,
            highAccuracy: true
        });
    }

    _saveSettings() { Utils.Storage.set('app_settings', this.settings); }

    _applySettings() {
        document.body.style.filter = `brightness(${this.settings.brightness}%)`;
    }

    _setupSettingsUI() {
        /* Brightness slider */
        const brightSlider = document.getElementById('brightness-slider');
        if (brightSlider) {
            brightSlider.value = this.settings.brightness;
            brightSlider.addEventListener('input', () => {
                this.settings.brightness = +brightSlider.value;
                Utils.setEl('brightness-value', `${brightSlider.value}%`);
                document.body.style.filter = `brightness(${brightSlider.value}%)`;
                this._saveSettings();
            });
        }

        /* Auto theme toggle */
        const autoTheme = document.getElementById('auto-theme-toggle');
        if (autoTheme) {
            autoTheme.checked = this.settings.autoTheme;
            autoTheme.addEventListener('change', () => {
                this.settings.autoTheme = autoTheme.checked;
                this._saveSettings();
            });
        }

        /* High GPS accuracy toggle */
        const hiAcc = document.getElementById('high-accuracy-toggle');
        if (hiAcc) {
            hiAcc.checked = this.settings.highAccuracy;
            hiAcc.addEventListener('change', () => {
                this.settings.highAccuracy = hiAcc.checked;
                Utils.Storage.set('high_accuracy', hiAcc.checked);
                this._saveSettings();
                Utils.showToast('GPS accuracy updated — restart app to apply', 'info');
            });
        }

        /* Fullscreen button */
        document.getElementById('fullscreen-btn')
            ?.addEventListener('click', () => this.toggleFullscreen());

        /* Reset trip */
        document.getElementById('reset-trip-btn')
            ?.addEventListener('click', () => {
                if (confirm('Reset all trip data?')) window.tripComputer?.reset();
            });

        /* Clear cache */
        document.getElementById('clear-cache-btn')
            ?.addEventListener('click', async () => {
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
                Utils.showToast('Cache cleared ✓', 'success');
            });

        /* Export GPX */
        document.getElementById('export-gpx-btn')
            ?.addEventListener('click', () => window.tripComputer?.exportGPX());

        /* GPS Calibration (bound in speedometer.js, but stop-btn here too) */
        document.getElementById('save-calibration')
            ?.addEventListener('click', () => window.speedometer?.saveCalibration());
        document.getElementById('reset-calibration')
            ?.addEventListener('click', () => window.speedometer?.resetCalibration());
    }

    // ─────────────────────────────────────────────────────
    //  AUTO DAY / NIGHT THEME
    // ─────────────────────────────────────────────────────
    _applyAutoTheme() {
        const apply = () => {
            if (!this.settings.autoTheme) return;
            const h = new Date().getHours();
            document.documentElement.setAttribute('data-time', (h >= 6 && h < 19) ? 'day' : 'night');
        };
        apply();
        setInterval(apply, 60_000);
    }

    // ─────────────────────────────────────────────────────
    //  DIAL PAD
    // ─────────────────────────────────────────────────────
    _setupDialPad() {
        let num = '';

        document.querySelectorAll('.dial-key').forEach(btn =>
            btn.addEventListener('click', () => {
                num += btn.dataset.key;
                Utils.setEl('dial-number', num);
            })
        );

        document.getElementById('dial-backspace')
            ?.addEventListener('click', () => {
                num = num.slice(0, -1);
                Utils.setEl('dial-number', num || '--');
            });

        document.getElementById('dial-call')
            ?.addEventListener('click', () => {
                if (num) window.location.href = `tel:${num}`;
            });
    }

    // ─────────────────────────────────────────────────────
    //  EVENT BUS
    // ─────────────────────────────────────────────────────
    _subscribeEvents() {
        Utils.EventBus.on('panel:switch', ({ panel }) => this.switchPanel(panel));
    }

    // ─────────────────────────────────────────────────────
    //  SERVICE WORKER
    // ─────────────────────────────────────────────────────
    _registerSW() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('[App] SW registered:', reg.scope))
            .catch(e  => console.error('[App] SW failed:', e));
    }
}

/* ── Bootstrap ─────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MotoDash();
});
