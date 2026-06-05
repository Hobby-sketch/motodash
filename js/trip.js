/**
 * MotoDash — trip.js
 * Trip Computer: distance, avg/max speed, duration, GPX recording.
 * Persists session state in LocalStorage.
 */

'use strict';

class TripComputer {
    constructor() {
        // ── Trip metrics ──────────────────────────────────
        this.totalDistance   = 0;    // meters
        this.maxSpeed        = 0;    // km/h
        this.speedReadings   = [];   // rolling buffer for avg
        this.elapsedSeconds  = 0;
        this.lastPosition    = null; // { lat, lng }

        // ── GPX track recording ───────────────────────────
        this.trackPoints     = [];   // { lat, lng, speed, time }

        // ── Internals ─────────────────────────────────────
        this._timer          = null;

        this._loadState();
        this._startTimer();
        console.log('[TripComputer] Initialized ✓');
    }

    // ─────────────────────────────────────────────────────
    //  PERSISTENCE
    // ─────────────────────────────────────────────────────
    _loadState() {
        const s = Utils.Storage.get('trip_state', null);
        if (s) {
            this.totalDistance  = s.totalDistance  || 0;
            this.maxSpeed       = s.maxSpeed       || 0;
            this.speedReadings  = s.speedReadings  || [];
            this.elapsedSeconds = s.elapsedSeconds || 0;
        }
    }

    _saveState() {
        Utils.Storage.set('trip_state', {
            totalDistance  : this.totalDistance,
            maxSpeed       : this.maxSpeed,
            speedReadings  : this.speedReadings.slice(-100),
            elapsedSeconds : this.elapsedSeconds
        });
    }

    // ─────────────────────────────────────────────────────
    //  TIMER
    // ─────────────────────────────────────────────────────
    _startTimer() {
        this._timer = setInterval(() => {
            this.elapsedSeconds++;
            Utils.setEl('ride-duration', Utils.formatDuration(this.elapsedSeconds));
            if (this.elapsedSeconds % 30 === 0) this._saveState();
        }, 1000);
        // Render immediately
        Utils.setEl('ride-duration', Utils.formatDuration(this.elapsedSeconds));
    }

    // ─────────────────────────────────────────────────────
    //  UPDATE  (called by Speedometer on every GPS fix)
    // ─────────────────────────────────────────────────────
    update(lat, lng, speedKmh) {
        const now = Date.now();

        // ── Record track point ────────────────────────────
        if (lat && lng) {
            this.trackPoints.push({ lat, lng, speed: speedKmh, time: now });
            if (this.trackPoints.length > 2000) this.trackPoints.shift();
        }

        // ── Distance accumulation ─────────────────────────
        if (this.lastPosition && lat && lng) {
            const d = Utils.haversineDistance(
                this.lastPosition.lat, this.lastPosition.lng, lat, lng
            );
            // Accept movement only when >3 m and speed meaningful
            if (d > 3 && speedKmh > 2) {
                this.totalDistance += d;
            }
        }

        // ── Max speed ─────────────────────────────────────
        if (speedKmh > this.maxSpeed) this.maxSpeed = speedKmh;

        // ── Speed buffer (exclude near-zero) ──────────────
        if (speedKmh >= 0) {
            this.speedReadings.push(speedKmh);
            if (this.speedReadings.length > 300) this.speedReadings.shift();
        }

        if (lat && lng) this.lastPosition = { lat, lng };

        this._render();
    }

    // ─────────────────────────────────────────────────────
    //  COMPUTED
    // ─────────────────────────────────────────────────────
    get averageSpeed() {
        const moving = this.speedReadings.filter(s => s > 3);
        if (!moving.length) return 0;
        return moving.reduce((a, b) => a + b, 0) / moving.length;
    }

    get distanceKm() { return this.totalDistance / 1000; }

    // ─────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────
    _render() {
        Utils.setEl('trip-distance', `${this.distanceKm.toFixed(1)} km`);
        Utils.setEl('avg-speed',     `${Math.round(this.averageSpeed)} km/h`);
        Utils.setEl('max-speed',     `${Math.round(this.maxSpeed)} km/h`);
    }

    // ─────────────────────────────────────────────────────
    //  PUBLIC ACTIONS
    // ─────────────────────────────────────────────────────
    reset() {
        this.totalDistance  = 0;
        this.maxSpeed       = 0;
        this.speedReadings  = [];
        this.trackPoints    = [];
        this.lastPosition   = null;
        this.elapsedSeconds = 0;
        Utils.Storage.remove('trip_state');
        this._render();
        Utils.setEl('ride-duration', '00:00');
        Utils.showToast('Trip data reset ✓', 'success');
    }

    exportGPX() {
        if (this.trackPoints.length < 2) {
            Utils.showToast('Not enough data to export', 'warning');
            return;
        }
        const date  = new Date().toISOString().slice(0, 10);
        const gpx   = Utils.generateGPX(this.trackPoints, `MotoDash ${date}`);
        Utils.downloadFile(gpx, `motodash-${date}.gpx`, 'application/gpx+xml');
        Utils.showToast('GPX exported ✓', 'success');
    }

    destroy() {
        clearInterval(this._timer);
        this._saveState();
    }
}

// ── Bootstrap ────────────────────────────────────────────
window.tripComputer = new TripComputer();
console.log('[TripComputer] Ready ✓');
