/**
 * MotoDash — speedometer.js
 * GPS Speedometer: watchPosition, Kalman filter, Haversine speed,
 * animated arc gauge, riding modes, DeviceOrientation compass,
 * GPS calibration, vehicle status.
 */

'use strict';

class SpeedometerModule {
    constructor() {
        // ── Speed state ───────────────────────────────────
        this.targetSpeed  = 0;   // Kalman-filtered GPS speed (km/h)
        this.displaySpeed = 0;   // Animated display speed
        this.vehicleStatus = 'STOPPED';
        this.ridingMode   = 'SPORT';

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
        this.kf = { Q: 0.0001, R: 0.01, P: 1.0, x: 0.0 };

        // ── SVG arc geometry ──────────────────────────────
        this.ARC_MAX_KMH  = 200;
        this.ARC_CIRCUM   = 2 * Math.PI * 85;   // r = 85 → ≈ 534 px

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
        this._loadRidingMode();
        this._setupUI();
        this._startGPS();
        this._startAnimation();
        this._setupCompass();
        this._loadCalibrationUI();
        console.log('[Speedometer] Initialized ✓');
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
    //  RENDER
    // ─────────────────────────────────────────────────────
    _renderSpeed() {
        const spd = Math.round(this.displaySpeed);
        const valEl = document.getElementById('speed-value');
        const arcEl = document.getElementById('speed-arc-fill');

        // Numeric display + colour
        if (valEl) {
            valEl.textContent = spd;
            valEl.className   = 'speed-value';
            if (spd >= 140) { valEl.classList.add('speed-danger');  }
            else if (spd >= 100) { valEl.classList.add('speed-warning'); }
        }

        // Arc progress (stroke-dashoffset)
        if (arcEl) {
            const pct    = Math.min(this.displaySpeed / this.ARC_MAX_KMH, 1);
            const offset = this.ARC_CIRCUM * (1 - pct);
            arcEl.style.strokeDashoffset = offset.toFixed(1);

            // Arc colour matches speed range
            if (spd >= 140)      arcEl.style.stroke = '#FF4444';
            else if (spd >= 100) arcEl.style.stroke = '#FFAA00';
            else                 arcEl.style.stroke = '#00AEEF';
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
    //  RIDING MODE
    // ─────────────────────────────────────────────────────
    setRidingMode(mode) {
        this.ridingMode = mode;
        Utils.Storage.set('riding_mode', mode);

        // Tune Kalman responsiveness per mode
        switch (mode) {
            case 'ECO':    this.kf.Q = 0.00003; this.kf.R = 0.04; break;
            case 'NORMAL': this.kf.Q = 0.0001;  this.kf.R = 0.01; break;
            case 'SPORT':  this.kf.Q = 0.0004;  this.kf.R = 0.004; break;
        }

        document.querySelectorAll('.riding-mode-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.mode === mode)
        );
        Utils.showToast(`Mode: ${mode}`, 'success');
        Utils.EventBus.emit('mode:change', { mode });
    }

    _loadRidingMode() {
        this.setRidingMode(Utils.Storage.get('riding_mode', 'SPORT'));
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
        document.querySelectorAll('.riding-mode-btn').forEach(btn =>
            btn.addEventListener('click', () => this.setRidingMode(btn.dataset.mode))
        );
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
