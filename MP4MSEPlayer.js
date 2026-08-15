/**
 * MP4MSEPlayer - Clean state-machine based MSE controller for Unified MP4.
 * Uses MP4BufferController for Shaka-style buffer management.
 */
class MP4MSEPlayer {
    constructor(videoElement) {
        console.log("[MP4 MSE] constructor");
        this.video = videoElement;
        this.mediaSource = null;
        this.fileId = null;
        this.manifest = null;
        this.generation = 0;

        // Track States
        this.sourceBuffers = new Map(); // trackId -> { sb, type, queue, isAppending }
        this.isAttached = false;
        this.state = 'IDLE'; // IDLE, DISCOVERING, READY, SEEKING, BUFFERING, PLAYING, STOPPED

        this.internalSeekGuard = false;
        this.pendingSeekTime = null;
        this.seekTargetTime = null;

        // Buffer Controller (Shaka-style)
        this.bufferController = null;

        // Configuration
        this.FORWARD_BUFFER_THRESHOLD = 0.5; // Seconds required to start playing
    }

    log(msg) {
        const gen = this.bufferController?.activeGeneration ?? this.generation;
        const line = `[MP4 MSE] gen=${gen} ${msg}`;
        console.log(line);
        if (window.electronAPI && window.electronAPI.sendDiagnosticLog) {
            window.electronAPI.sendDiagnosticLog('player', line);
        }
    }

    async attach(fileId, manifest) {
        this.log(`attach() called for fileId=${fileId}`);
        this.fileId = fileId;
        this.manifest = manifest;
        this.generation = 1;
        this.isAttached = true;
        this.state = 'DISCOVERING';

        return new Promise((resolve) => {
            this.mediaSource = new MediaSource();
            this.video.src = URL.createObjectURL(this.mediaSource);

            this.mediaSource.addEventListener('sourceopen', () => {
                this.log("MediaSource event: sourceopen");
                if (this.mediaSource.readyState !== 'open') return;

                if (manifest.duration) {
                    this.mediaSource.duration = manifest.duration / 1000;
                }

                // 1. Setup SourceBuffers from Manifest
                const videoTrack = manifest.video[0];
                const audioTrack = manifest.audio.find(t => t.supported) || manifest.audio[0];

                if (videoTrack) this._createSB(videoTrack.trackNumber, `video/mp4; codecs="${videoTrack.codec}"`, 'VIDEO');
                if (audioTrack) this._createSB(audioTrack.trackNumber, `audio/mp4; codecs="${audioTrack.codec}"`, 'AUDIO');

                this.state = 'READY';
                this.log(`[MP4 READY] MediaSource open. Buffers created.`);

                // Initialize Buffer Controller
                if (window.MP4BufferController) {
                    this.bufferController = new MP4BufferController(
                        this.video,
                        this.mediaSource,
                        this.sourceBuffers,
                        manifest,
                        (msg) => this.log(msg),
                        () => {
                            if (window.safePlay) {
                                window.safePlay(this.video, "MP4 Ready");
                            } else {
                                this.video.play().catch(() => {});
                            }
                        }
                    );
                    this.bufferController.init();
                }

                // Initial seek to 0 to start playback
                this.seek(0);
                resolve();
            }, { once: true });
        });
    }

    _createSB(trackId, mime, type) {
        if (!MediaSource.isTypeSupported(mime)) {
            this.log(`[MP4 ERROR] Unsupported mime: ${mime}`);
            return;
        }

        const sb = this.mediaSource.addSourceBuffer(mime);
        sb.mode = 'segments';

        const state = { sb, type, queue: [], isAppending: false };
        this.sourceBuffers.set(trackId, state);

        // updateend is handled by buffer controller
        sb.addEventListener('error', (e) => this.log(`[MP4 ERROR] ${type} SourceBuffer error`));
    }

    async seek(targetTime) {
        if (!this.isAttached) return;

        // Harden: Ensure targetTime is valid and finite
        if (typeof targetTime !== 'number' || isNaN(targetTime) || !isFinite(targetTime)) {
            targetTime = 0;
        }

        // Clamp to duration if available
        if (this.video.duration && isFinite(this.video.duration)) {
            targetTime = Math.max(0, Math.min(targetTime, this.video.duration));
        } else {
            targetTime = Math.max(0, targetTime);
        }

        // Prevent micro-seeks (stutter prevention) unless we are already seeking
        if (Math.abs(this.video.currentTime - targetTime) < 0.1 && !this.video.seeking) {
            return;
        }

        this.internalSeekGuard = true;
        this.seekTargetTime = targetTime;

        this.log(`[SEEK] requested=${targetTime.toFixed(3)}s`);

        // Delegate to buffer controller
        if (this.bufferController) {
            await this.bufferController.seek(targetTime);
        } else {
            this._legacySeek(targetTime);
        }

        // Brief guard to prevent event loops
        setTimeout(() => { this.internalSeekGuard = false; }, 500);
    }

    _legacySeek(targetTime) {
        const gen = ++this.generation;
        this.state = 'SEEKING';
        this.log(`[SEEK] requested=${targetTime.toFixed(3)}s (legacy)`);

        this.sourceBuffers.forEach(s => {
            s.queue = [];
            if (s.sb.updating) {
                try { s.sb.abort(); } catch(e) {}
            }
            if (this.mediaSource.readyState === 'open' && !s.sb.updating) {
                try { s.sb.remove(0, Infinity); } catch(e) {}
            }
        });

        this._fetchUnified(targetTime, gen);
    }

    async _fetchUnified(startTime, gen) {
        const url = `http://127.0.0.1:3301/stream/${this.fileId}/mp4/unified?start=${startTime}&gen=${gen}`;
        this.log(`[SEEK] requesting unified endpoint: ${url}`);

        try {
            const response = await fetch(url);
            this.log(`[SEEK] unified response status: ${response.status}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const rapTime = parseFloat(response.headers.get('X-RAP-Time'));
            if (!isNaN(rapTime)) {
                this.log(`[MP4 RAP] Target=${startTime.toFixed(3)}s RAP=${rapTime.toFixed(3)}s`);
            }

            const reader = response.body.getReader();
            let leftover = new Uint8Array(0);

            while (true) {
                if (gen !== this.generation) {
                    reader.cancel();
                    break;
                }

                const { done, value } = await reader.read();
                if (done) break;

                // Combine with leftover
                const data = new Uint8Array(leftover.length + value.length);
                data.set(leftover);
                data.set(value, leftover.length);

                let offset = 0;
                while (offset + 5 <= data.length) {
                    const trackId = data[offset];
                    const length = (data[offset+1] << 24) | (data[offset+2] << 16) | (data[offset+3] << 8) | data[offset+4];

                    if (offset + 5 + length <= data.length) {
                        const chunk = data.slice(offset + 5, offset + 5 + length);
                        const state = this.sourceBuffers.get(trackId);
                        if (state) {
                            state.queue.push(chunk);
                        } else {
                            this.log(`[SEEK] Received segment for unknown trackId=${trackId}`);
                        }
                        offset += 5 + length;
                    } else {
                        break;
                    }
                }
                leftover = data.slice(offset);

                // Process queues after receiving some data
                this._processAllQueues();
            }

            // Final processing after stream ends
            this._processAllQueues();

            // Log buffer state and verify readiness
            this._logBufferStateAndVerify(gen);

        } catch (e) {
            if (gen === this.generation) this.log(`[MP4 ERROR] Fetch failed: ${e.message}`);
        }
    }

    _processAllQueues() {
        this.sourceBuffers.forEach((state, trackId) => {
            this._processQueue(trackId);
        });
    }

    _processQueue(trackId) {
        const state = this.sourceBuffers.get(trackId);
        if (!state || state.isAppending || state.sb.updating || state.queue.length === 0) return;

        const chunk = state.queue.shift();
        state.isAppending = true;

        try {
            state.sb.appendBuffer(chunk);
        } catch (e) {
            state.isAppending = false;
            this.log(`[MP4 ERROR] ${state.type} Append failed: ${e.name}`);
        }
    }

    _logBufferStateAndVerify(gen) {
        if (gen !== this.generation) return;

        const videoState = this.sourceBuffers.get(this.manifest?.video?.[0]?.trackNumber);
        const audioState = this.sourceBuffers.get(this.manifest?.audio?.[0]?.trackNumber);

        let videoBuffered = "none";
        let audioBuffered = "none";
        let videoContainsTarget = false;
        let audioContainsTarget = false;

        if (videoState && videoState.sb.buffered.length > 0) {
            videoBuffered = Array.from(videoState.sb.buffered).map(r => `[${r.start.toFixed(3)} - ${r.end.toFixed(3)}]`).join(', ');
            const target = this.seekTargetTime ?? this.video.currentTime;
            for (let i = 0; i < videoState.sb.buffered.length; i++) {
                if (target >= videoState.sb.buffered.start(i) - 0.1 && target < videoState.sb.buffered.end(i) + 0.1) {
                    videoContainsTarget = true;
                    break;
                }
            }
        }

        if (audioState && audioState.sb.buffered.length > 0) {
            audioBuffered = Array.from(audioState.sb.buffered).map(r => `[${r.start.toFixed(3)} - ${r.end.toFixed(3)}]`).join(', ');
            const target = this.seekTargetTime ?? this.video.currentTime;
            for (let i = 0; i < audioState.sb.buffered.length; i++) {
                if (target >= audioState.sb.buffered.start(i) - 0.1 && target < audioState.sb.buffered.end(i) + 0.1) {
                    audioContainsTarget = true;
                    break;
                }
            }
        }

        this.log(`[SEEK BUFFER] video=${videoBuffered || 'none'}`);
        this.log(`[SEEK BUFFER] audio=${audioBuffered || 'none'}`);
        this.log(`[SEEK READY] videoContainsTarget=${videoContainsTarget}`);
        this.log(`[SEEK READY] audioContainsTarget=${audioContainsTarget}`);
        this.log(`[SEEK READY] bothTracksReady=${videoContainsTarget && audioContainsTarget}`);

        // If both tracks have the target, transition to PLAYING
        if (videoContainsTarget && audioContainsTarget) {
            this.state = 'PLAYING';
            this.log(`[PLAY] currentTime=${this.video.currentTime.toFixed(3)}`);
            if (window.safePlay) {
                window.safePlay(this.video, "MP4 Ready");
            } else {
                this.video.play().catch(() => {});
            }
        }
    }

    _checkReadiness() {
        if (this.state !== 'BUFFERING') return;

        const ct = this.video.currentTime;
        let ready = true;

        this.sourceBuffers.forEach(state => {
            const buf = state.sb.buffered;
            let covered = false;
            for (let i = 0; i < buf.length; i++) {
                if (ct >= buf.start(i) - 0.1 && ct < buf.end(i) + 0.1) {
                    const forward = buf.end(i) - ct;
                    if (forward > 0.1) covered = true;
                }
            }
            if (!covered) ready = false;
        });

        if (ready) {
            this.state = 'PLAYING';
            this.log(`[MP4 READY] All buffers covered at ${ct.toFixed(3)}s`);
            if (window.safePlay) {
                window.safePlay(this.video, "MP4 Ready");
            } else {
                this.video.play().catch(() => {});
            }
        }
    }

    detach() {
        this.isAttached = false;
        this.generation++;
        if (this.bufferController) {
            this.bufferController.destroy();
            this.bufferController = null;
        }
        if (this.mediaSource) {
            if (this.mediaSource.readyState === 'open') {
                try { this.mediaSource.endOfStream(); } catch(e) {}
            }
            this.video.src = '';
            this.mediaSource = null;
        }
        this.sourceBuffers.clear();
        this.state = 'IDLE';
        this.log(`[MP4 STOPPED] Player detached`);
    }
}

window.MP4MSEPlayer = MP4MSEPlayer;
