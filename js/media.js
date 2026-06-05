/**
 * MotoDash — media.js
 * Media Control: Media Session API handlers, track info display,
 * play/pause/next/prev controls, progress bar, volume.
 */

'use strict';

class MediaModule {
    constructor() {
        this.isPlaying   = false;
        this.title       = 'No media playing';
        this.artist      = '--';
        this.album       = '--';
        this.currentTime = 0;
        this.totalTime   = 0;
        this.volume      = 0.7;
        this._progressT  = null;

        this._init();
        console.log('[Media] Initialized ✓');
    }

    // ─────────────────────────────────────────────────────
    //  INIT
    // ─────────────────────────────────────────────────────
    _init() {
        this._setupMediaSession();
        this._setupUI();
        this._startProgressTick();
    }

    // ─────────────────────────────────────────────────────
    //  MEDIA SESSION API
    // ─────────────────────────────────────────────────────
    _setupMediaSession() {
        if (!('mediaSession' in navigator)) {
            console.warn('[Media] MediaSession API not available');
            return;
        }

        const ms = navigator.mediaSession;

        const setHandler = (action, fn) => {
            try { ms.setActionHandler(action, fn); }
            catch { /* action not supported */ }
        };

        setHandler('play',          () => this._onPlay());
        setHandler('pause',         () => this._onPause());
        setHandler('previoustrack', () => this._onPrev());
        setHandler('nexttrack',     () => this._onNext());
        setHandler('stop',          () => this._onPause());

        /* Sync existing metadata if something was already playing */
        this._syncMeta();
    }

    _syncMeta() {
        const meta = navigator.mediaSession?.metadata;
        if (!meta) return;
        this.title  = meta.title  || 'Unknown Track';
        this.artist = meta.artist || 'Unknown Artist';
        this.album  = meta.album  || 'Unknown Album';
        this._renderMeta();
    }

    // ─────────────────────────────────────────────────────
    //  ACTION HANDLERS
    // ─────────────────────────────────────────────────────
    _onPlay() {
        this.isPlaying = true;
        this._syncMeta();
        this._renderPlayBtn();
    }

    _onPause() {
        this.isPlaying = false;
        this._renderPlayBtn();
    }

    _onNext() {
        Utils.showToast('Next track', 'info');
        this.currentTime = 0;
        setTimeout(() => this._syncMeta(), 600);
    }

    _onPrev() {
        Utils.showToast('Previous track', 'info');
        this.currentTime = 0;
        setTimeout(() => this._syncMeta(), 600);
    }

    // ─────────────────────────────────────────────────────
    //  PUBLIC API (called by Voice module, UI buttons)
    // ─────────────────────────────────────────────────────
    playPause() { this.isPlaying ? this._onPause() : this._onPlay(); }
    next()      { this._onNext(); }
    previous()  { this._onPrev(); }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
    }

    /** Called externally to update track info (e.g. from media metadata) */
    setTrack(title, artist, album, duration = 0) {
        this.title       = title   || 'Unknown';
        this.artist      = artist  || '--';
        this.album       = album   || '--';
        this.totalTime   = duration;
        this.currentTime = 0;
        this._renderMeta();
        Utils.setEl('track-total', this._fmtTime(this.totalTime));
    }

    // ─────────────────────────────────────────────────────
    //  PROGRESS BAR TICK
    // ─────────────────────────────────────────────────────
    _startProgressTick() {
        this._progressT = setInterval(() => {
            if (this.isPlaying && this.totalTime > 0) {
                this.currentTime = Math.min(this.currentTime + 1, this.totalTime);
                this._renderProgress();
            }
        }, 1000);
    }

    // ─────────────────────────────────────────────────────
    //  RENDER
    // ─────────────────────────────────────────────────────
    _renderMeta() {
        Utils.setEl('track-title',  this.title);
        Utils.setEl('track-artist', this.artist);
        Utils.setEl('track-album',  this.album);
    }

    _renderPlayBtn() {
        const playIco  = document.querySelector('#btn-play-pause .play-icon');
        const pauseIco = document.querySelector('#btn-play-pause .pause-icon');
        if (playIco)  playIco.style.display  = this.isPlaying ? 'none'  : 'block';
        if (pauseIco) pauseIco.style.display = this.isPlaying ? 'block' : 'none';
    }

    _renderProgress() {
        const fill = document.getElementById('progress-fill');
        const cur  = document.getElementById('track-current');
        if (fill && this.totalTime > 0)
            fill.style.width = `${(this.currentTime / this.totalTime) * 100}%`;
        if (cur)
            cur.textContent = this._fmtTime(this.currentTime);
    }

    _fmtTime(secs) {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    // ─────────────────────────────────────────────────────
    //  UI SETUP
    // ─────────────────────────────────────────────────────
    _setupUI() {
        document.getElementById('btn-play-pause')
            ?.addEventListener('click', () => this.playPause());
        document.getElementById('btn-prev')
            ?.addEventListener('click', () => this.previous());
        document.getElementById('btn-next')
            ?.addEventListener('click', () => this.next());

        const vol = document.getElementById('volume-slider');
        if (vol) {
            vol.value = Math.round(this.volume * 100);
            vol.addEventListener('input', () => this.setVolume(vol.value / 100));
        }

        /* Watch for system media metadata changes (if browser supports) */
        if ('mediaSession' in navigator) {
            /* Poll for metadata changes every 2 s (no native event for this) */
            setInterval(() => this._syncMeta(), 2000);
        }
    }

    destroy() { clearInterval(this._progressT); }
}

/* ── Bootstrap ─────────────────────────────────────────── */
window.mediaModule = new MediaModule();
console.log('[Media] Ready ✓');
