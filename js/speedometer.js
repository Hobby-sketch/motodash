/**
 * MotoDash — speedometer.js
 * GPS Speedometer: watchPosition, Kalman filter, Haversine speed,
 * animated arc gauge, DeviceOrientation compass, GPS calibration,
 * vehicle status.
 */

'use strict';

class SpeedometerModule {
    constructor() {
        // ── Speed state ───────────────────────────────────
        this.targetSpeed  = 0;   // Kalman-filtered GPS speed (km/h)
        this.displaySpeed = 0;   // Animated display speed
        this.vehicleStatus = 'STOPPED';

        // ── GPS state ─────────────────────────────────────
        this.watchId      = null;
        this.lastPosition = null;   // { lat, lng }
        this.lastTimestamp = null;
        this.gpsAccuracy  = null;
        this.heading      = null;
        this.altitude     = null;
        this.gpsSignal    = 'SEARCHING';
        this.gpsPosition  = null;   // Exposed to other modules

        // ── Kalman filter  (1-D, speed) ───────────────────
        // Fixed, balanced tuning — smooths GPS noise without lagging
        // behind real speed changes.
        this.kf = { Q: 0.0001, R: 0.01, P: 1.0, x: 0.0 };

        // ── SVG arc/shape geometry per face ───────────────
        this.ARC_MAX_KMH         = 200;
        this.NEXUS_CIRCUM        = 2 * Math.PI * 68;  // Nexus ring r=68 → ≈427px
        this.TECHNO_HEX_PERIMETER = 546;              // Techno hexagon perimeter (6 sides, computed)

        // ── GPS calibration ───────────────────────────────
        this.calibration  = Utils.Storage.get('gps_calibration', { lat: 0, lng: 0 });

        // ── Animation frame ───────────────────────────────
        this._animFrame   = null;

        this._init();
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupUI();
        this._generateOriginBars();
        this._generateNexusDots();
        this._generateTechnoLEDs();
        this._startGPS();
        this._startAnimation();
        this._setupCompass();
        this._loadCalibrationUI();
        console.log('[Speedometer] Initialized ✓');
    }

    /**
     * ORIGIN face: numbered speed-scale ring (0,40,80,120,160,200 km/h)
     * with a progress arc — purely GPS-speed-driven, NOT RPM/gear,
     * since this app has no ECU/engine connection. Visual motif
     * inspired by OEM TFT clusters, adapted to be 100% honest about
     * what data is actually available.
     *
     * Geometry: 270° sweep, gap centred at the bottom. The ring track
     * uses transform="rotate(135 110 110)" — native SVG angle 135°
     * lands at lower-left (where "0" sits) and the dash extends
     * clockwise 270° to native 45° at lower-right (where "200" sits),
     * passing through native 270° (straight up) at the midpoint —
     * exactly like a real speedometer face.
     */
    _generateOriginBars() {
        const g = document.getElementById('origin-ticks');
        if (!g) return;
        const cx = 110, cy = 110, rLabel = 78;
        const labels = [0, 40, 80, 120, 160, 200];
        let svg = '';
        labels.forEach((val, i) => {
            const angleDeg = 135 + (i / 5) * 270;
            const rad = (angleDeg * Math.PI) / 180;
            const x = cx + rLabel * Math.cos(rad);
            const y = cy + rLabel * Math.sin(rad);
            svg += `<text class="origin-tick-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${val}</text>`;
        });
        g.innerHTML = svg;
    }

    /**
     * NEXUS face: small decorative dots around the outer holographic ring.
     * Purely atmospheric (not speed-reactive) — the inner progress ring
     * already conveys speed; these add a "scanned particle ring" feel.
     */
    _generateNexusDots() {
        const g = document.getElementById('nexus-dots');
        if (!g) return;
        const cx = 110, cy = 110, r = 102, count = 20;
        let svg = '';
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * 2 * Math.PI;
            const x = cx + r * Math.cos(angle);
            const y = cy + r * Math.sin(angle);
            svg += `<circle class="nexus-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6"/>`;
        }
        g.innerHTML = svg;
    }

    /**
     * TECHNO face: horizontal LED bargraph (14 segments), classic
     * equalizer/VU-meter look, lights up left→right with speed.
     */
    _generateTechnoLEDs() {
        const bar = document.getElementById('techno-led-bar');
        if (!bar) return;
        this.TECHNO_SEGMENTS = 14;
        let html = '';
        for (let i = 0; i < this.TECHNO_SEGMENTS; i++) {
            html += '<div class="techno-led-segment"></div>';
        }
        bar.innerHTML = html;
        this._technoSegmentEls = [...bar.children];
    }

    // ─────────────────────────────────────────────────────
    //  KALMAN FILTER
    // ─────────────────────────────────────────────────────
    /**
     * Update Kalman filter with new speed measurement.
     * Returns smoothed estimate.
     */
    _kalman(measurement) {
        const { Q, R } = this.kf;
        this.kf.P += Q;                                     // predict
        const K    = this.kf.P / (this.kf.P + R);          // gain
        this.kf.x += K * (measurement - this.kf.x);        // update
        this.kf.P  = (1 - K) * this.kf.P;
        return Math.max(0, this.kf.x);
    }

    // ─────────────────────────────────────────────────────
    //  GPS
    // ─────────────────────────────────────────────────────
    _startGPS() {
        if (!navigator.geolocation) {
            this._setSignalEl('GPS NOT SUPPORTED', '');
            Utils.showToast('Geolocation not supported', 'error');
            return;
        }

        const options = {
            enableHighAccuracy : Utils.Storage.get('high_accuracy', true),
            timeout            : 10000,
            maximumAge         : 0
        };

        this.watchId = navigator.geolocation.watchPosition(
            (pos) => this._onFix(pos),
            (err) => this._onError(err),
            options
        );
        this._setSignalEl('ACQUIRING', 'gps-searching');
    }

    _onFix(position) {
        const { latitude, longitude, accuracy, speed, heading, altitude } = position.coords;
        const ts = position.timestamp;

        // Apply calibration offsets
        const lat = latitude  + this.calibration.lat;
        const lng = longitude + this.calibration.lng;

        // Expose for maps module
        this.gpsPosition  = { lat, lng, accuracy, heading, altitude };
        this.gpsAccuracy  = Math.round(accuracy);
        this.altitude     = altitude !== null ? Math.round(altitude) : null;

        // Update GPS signal quality indicator
        this._updateSignalQuality(accuracy);

        // ── Heading ───────────────────────────────────────
        if (heading !== null && !isNaN(heading)) {
            this.heading = Math.round(heading);
        } else if (this.lastPosition) {
            this.heading = Math.round(
                Utils.calculateBearing(this.lastPosition.lat, this.lastPosition.lng, lat, lng)
            );
        }

        // ── Speed calculation ─────────────────────────────
        let rawSpeed = 0;

        if (speed !== null && speed >= 0) {
            // Native GPS speed (m/s) → km/h
            rawSpeed = speed * 3.6;
        } else if (this.lastPosition && this.lastTimestamp) {
            // Haversine fallback
            const distM  = Utils.haversineDistance(
                this.lastPosition.lat, this.lastPosition.lng, lat, lng
            );
            const dtSecs = (ts - this.lastTimestamp) / 1000;
            if (dtSecs > 0.05) rawSpeed = (distM / dtSecs) * 3.6;
        }

        // Clamp implausible jumps (>350 km/h)
        rawSpeed = Math.min(Math.max(rawSpeed, 0), 350);

        // Apply Kalman smoothing
        const smoothed    = this._kalman(rawSpeed);
        this.targetSpeed  = Math.round(smoothed);

        // Vehicle status
        this.vehicleStatus = this.targetSpeed > 3 ? 'MOVING' : 'STOPPED';

        // Update info displays
        this._updateGPSInfo();
        this._updateStatusBadge();
        this._updateCompass(this.heading);

        // Store last fix
        this.lastPosition  = { lat, lng };
        this.lastTimestamp = ts;

        // Broadcast for maps, trip, voice
        Utils.EventBus.emit('gps:update', {
            lat, lng,
            speed   : this.targetSpeed,
            heading : this.heading,
            accuracy: this.gpsAccuracy,
            altitude: this.altitude,
            status  : this.vehicleStatus,
            timestamp: ts
        });

        // Update trip computer
        window.tripComputer?.update(lat, lng, this.targetSpeed);
    }

    _onError(error) {
        const msgs = {
            1: 'PERMISSION DENIED',
            2: 'POSITION UNAVAILABLE',
            3: 'GPS TIMEOUT'
        };
        const msg = msgs[error.code] || 'GPS ERROR';
        this._setSignalEl(msg, 'gps-poor');
        Utils.showToast(`GPS: ${msg}`, 'error');
    }

    // ─────────────────────────────────────────────────────
    //  GPS SIGNAL QUALITY
    // ─────────────────────────────────────────────────────
    _updateSignalQuality(accuracy) {
        let label, cls;
        if      (accuracy <= 5)   { label = 'EXCELLENT'; cls = 'gps-excellent'; }
        else if (accuracy <= 10)  { label = 'GOOD';      cls = 'gps-good';      }
        else if (accuracy <= 25)  { label = 'FAIR';      cls = 'gps-fair';      }
        else if (accuracy <= 100) { label = 'POOR';      cls = 'gps-poor';      }
        else                      { label = 'SEARCHING'; cls = 'gps-searching'; }
        this.gpsSignal = label;
        this._setSignalEl(label, cls);

        // Status-bar GPS icon colour
        const ico = document.getElementById('gps-icon');
        if (ico) ico.className = `status-icon ${cls}`;
    }

    _setSignalEl(label, cls) {
        const el = document.getElementById('gps-signal');
        if (!el) return;
        el.textContent = label;
        el.className   = `info-value ${cls}`;
    }

    // ─────────────────────────────────────────────────────
    //  ANIMATION LOOP — smooth speed towards target
    // ─────────────────────────────────────────────────────
    _startAnimation() {
        const tick = () => {
            const diff = this.targetSpeed - this.displaySpeed;

            // Slower deceleration easing when stopped (engine wind-down feel)
            const factor = this.vehicleStatus === 'STOPPED' ? 0.04 : 0.14;
            this.displaySpeed += diff * factor;
            if (Math.abs(diff) < 0.15) this.displaySpeed = this.targetSpeed;

            this._renderSpeed();
            this._animFrame = requestAnimationFrame(tick);
        };
        this._animFrame = requestAnimationFrame(tick);
    }

    // ─────────────────────────────────────────────────────
    //  RENDER — drives all 3 speed faces simultaneously.
    //  CSS shows only the one matching the active color theme; updating
    //  all three unconditionally is cheap and avoids JS branching on
    //  which theme is active.
    // ─────────────────────────────────────────────────────
    _renderSpeed() {
        const spd = Math.round(this.displaySpeed);
        const zone = spd >= 140 ? 'danger' : (spd >= 100 ? 'warning' : 'normal');

        this._renderFaceOrigin(spd, zone);
        this._renderFaceNexus(spd, zone);
        this._renderFaceTechno(spd, zone);
    }

    /* ── FACE 1: Origin numbered ring + status icons + info strip ── */
    _renderFaceOrigin(spd, zone) {
        const valEl = document.getElementById('speed-value-origin');
        if (valEl) {
            valEl.className = 'origin-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        const ringEl = document.getElementById('origin-ring-fill');
        if (ringEl) {
            const pct = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);
            const ORIGIN_VISIBLE = 448;   // arc-length of the 270° sweep (r=95)
            const ORIGIN_TOTAL   = 597;   // full circumference (r=95)
            const filled = ORIGIN_VISIBLE * pct;
            ringEl.setAttribute('stroke-dasharray', `${filled.toFixed(1)} ${(ORIGIN_TOTAL - filled).toFixed(1)}`);

            ringEl.classList.remove('origin-ring-normal', 'origin-ring-warning', 'origin-ring-danger');
            ringEl.classList.add(`origin-ring-${zone}`);
        }

        this._updateOriginStatusIcons();
        this._updateOriginInfoStrip();
    }

    /**
     * Status icon column — 100% honest, app-derived signals only.
     * No engine/ABS/side-stand/fuel warnings (no ECU connection exists).
     */
    _updateOriginStatusIcons() {
        const gpsIcon = document.getElementById('origin-icon-gps');
        if (gpsIcon) {
            const good = this.gpsSignal === 'EXCELLENT' || this.gpsSignal === 'GOOD';
            gpsIcon.classList.toggle('active', good);
        }

        const btIcon = document.getElementById('origin-icon-bt');
        if (btIcon) {
            btIcon.classList.toggle('active', !!window.bluetoothModule?.hasConnectedDevice);
        }

        const voiceIcon = document.getElementById('origin-icon-voice');
        if (voiceIcon) {
            voiceIcon.classList.toggle('active', !!window.voiceModule?.isListening);
        }

        const battIcon = document.getElementById('origin-icon-battery');
        if (battIcon) {
            const lvl = window.app?.batteryLevel;
            const low = typeof lvl === 'number' && lvl <= 15;
            battIcon.style.display = low ? 'flex' : 'none';
        }
    }

    /** Bottom info strip: lifetime ODO + average speed + current time. */
    _updateOriginInfoStrip() {
        Utils.setEl('origin-time', Utils.getCurrentTime());
        // ODO and AVG are updated by TripComputer._render() directly
        // (it already targets #origin-odo / #origin-avg) — nothing
        // further needed here, kept for clarity of render flow.
    }

    /* ── FACE 2: Nexus holographic ring ───────────────────── */
    _renderFaceNexus(spd, zone) {
        const valEl = document.getElementById('speed-value-nexus');
        const arcEl = document.getElementById('nexus-arc-fill');

        if (valEl) {
            valEl.className = 'nexus-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        if (arcEl) {
            const pct    = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);
            const offset = this.NEXUS_CIRCUM * (1 - pct);
            arcEl.style.strokeDashoffset = offset.toFixed(1);

            arcEl.classList.remove('nexus-progress-normal', 'nexus-progress-warning', 'nexus-progress-danger');
            arcEl.classList.add(`nexus-progress-${zone}`);
        }
    }

    /* ── FACE 3: Techno hexagon + LED bargraph ────────────── */
    _renderFaceTechno(spd, zone) {
        const valEl = document.getElementById('speed-value-techno');
        const hexEl = document.getElementById('techno-hex-fill');

        if (valEl) {
            valEl.className = 'techno-value';
            if (zone === 'danger')       valEl.classList.add('speed-danger');
            else if (zone === 'warning') valEl.classList.add('speed-warning');
            valEl.textContent = spd;
        }

        const pct = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);

        if (hexEl) {
            const offset = this.TECHNO_HEX_PERIMETER * (1 - pct);
            hexEl.style.strokeDashoffset = offset.toFixed(1);

            hexEl.classList.remove('hex-warning', 'hex-danger');
            if (zone === 'danger')       hexEl.classList.add('hex-danger');
            else if (zone === 'warning') hexEl.classList.add('hex-warning');
        }

        if (this._technoSegmentEls) {
            const litCount = Math.round(pct * this.TECHNO_SEGMENTS);
            this._technoSegmentEls.forEach((seg, i) => {
                const isLit = i < litCount;
                seg.classList.toggle('lit', isLit);
                seg.classList.remove('seg-warning', 'seg-danger');
                if (isLit && zone === 'danger')       seg.classList.add('seg-danger');
                else if (isLit && zone === 'warning') seg.classList.add('seg-warning');
            });
        }
    }

    _updateStatusBadge() {
        const el = document.getElementById('vehicle-status');
        if (!el) return;
        el.textContent = `● ${this.vehicleStatus}`;
        el.className   = `vehicle-status ${this.vehicleStatus.toLowerCase()}`;
    }

    _updateGPSInfo() {
        if (this.gpsAccuracy !== null)
            Utils.setEl('gps-accuracy', `±${this.gpsAccuracy} m`);
        if (this.altitude !== null)
            Utils.setEl('current-altitude', `${this.altitude} m`);
    }

    // ─────────────────────────────────────────────────────
    //  COMPASS  (DeviceOrientationEvent)
    // ─────────────────────────────────────────────────────
    _setupCompass() {
        if (!window.DeviceOrientationEvent) return;

        const attach = () => {
            window.addEventListener('deviceorientation', (e) => {
                if (e.webkitCompassHeading !== undefined) {
                    // iOS gives compass heading directly
                    this._updateCompass(e.webkitCompassHeading);
                } else if (e.alpha !== null) {
                    this._updateCompass((360 - e.alpha) % 360);
                }
            }, { passive: true });
        };

        // iOS 13+ requires explicit permission
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            document.addEventListener('click', async function once() {
                try {
                    const perm = await DeviceOrientationEvent.requestPermission();
                    if (perm === 'granted') attach();
                } catch (e) { /* ignore */ }
                document.removeEventListener('click', once);
            }, { once: true });
        } else {
            attach();
        }
    }

    _updateCompass(angle) {
        if (angle === null || isNaN(angle)) return;
        const needle = document.getElementById('compass-needle');
        if (needle) needle.setAttribute('transform', `rotate(${angle.toFixed(0)} 30 30)`);
        Utils.setEl('current-heading', `${Math.round(angle)}°`);
    }

    // ─────────────────────────────────────────────────────
    //  GPS CALIBRATION
    // ─────────────────────────────────────────────────────
    saveCalibration() {
        const lat = parseFloat(document.getElementById('lat-offset')?.value) || 0;
        const lng = parseFloat(document.getElementById('lng-offset')?.value) || 0;
        this.calibration = { lat, lng };
        Utils.Storage.set('gps_calibration', this.calibration);
        Utils.showToast('GPS calibration saved ✓', 'success');
    }

    resetCalibration() {
        this.calibration = { lat: 0, lng: 0 };
        Utils.Storage.remove('gps_calibration');
        const latEl = document.getElementById('lat-offset');
        const lngEl = document.getElementById('lng-offset');
        if (latEl) latEl.value = '0';
        if (lngEl) lngEl.value = '0';
        Utils.showToast('GPS calibration reset', 'info');
    }

    _loadCalibrationUI() {
        const latEl = document.getElementById('lat-offset');
        const lngEl = document.getElementById('lng-offset');
        if (latEl) latEl.value = this.calibration.lat;
        if (lngEl) lngEl.value = this.calibration.lng;
    }

    // ─────────────────────────────────────────────────────
    //  UI BINDINGS
    // ─────────────────────────────────────────────────────
    _setupUI() {
        document.getElementById('save-calibration')
            ?.addEventListener('click', () => this.saveCalibration());
        document.getElementById('reset-calibration')
            ?.addEventListener('click', () => this.resetCalibration());
    }

    // ─────────────────────────────────────────────────────
    //  CLEANUP
    // ─────────────────────────────────────────────────────
    destroy() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        if (this._animFrame)       cancelAnimationFrame(this._animFrame);
    }
}

// ── Bootstrap ────────────────────────────────────────────
window.speedometer = new SpeedometerModule();
console.log('[Speedometer] Ready ✓');
