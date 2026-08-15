/**
 * MP4BufferController - Shaka-style buffer management for MP4 MSE Player.
 * Handles buffering goals, segment scheduling, append serialization,
 * seek coordination, quota recovery, and buffer eviction.
 */
class MP4BufferController {
    constructor(videoElement, mediaSource, sourceBuffers, manifest, log, onSeekReady) {
        this.video = videoElement;
        this.mediaSource = mediaSource;
        this.sourceBuffers = sourceBuffers; // Map<trackId, {sb, type, queue, isAppending}>
        this.manifest = manifest;
        this.log = log;
        this.onSeekReady = onSeekReady || (() => {});

        // Configuration (Shaka-style defaults)
        this.BUFFERING_GOAL = 20;      // seconds of forward buffer to maintain
        this.REBUFFERING_GOAL = 5;     // seconds below which we aggressively buffer
        this.BUFFER_BEHIND = 15;       // seconds of back buffer to keep

        // State
        this.generation = 0;
        this.activeGeneration = 0;
        this.destroyed = false;
        this.isSeeking = false;
        this.isFetching = false;
        this.fetchAbortController = null;

        // Scheduler
        this.schedulerWakeup = null;
        this.schedulerRunning = false;
        this.heartbeatTimer = null;

        // Track info
        this.videoTrackId = manifest?.video?.[0]?.trackNumber;
        this.audioTrackId = manifest?.audio?.find(t => t.supported)?.trackNumber ?? manifest?.audio?.[0]?.trackNumber;

        // Bind methods
        this._onUpdateEnd = this._onUpdateEnd.bind(this);
        this._onVideoTimeUpdate = this._onVideoTimeUpdate.bind(this);
        this._onVideoWaiting = this._onVideoWaiting.bind(this);
        this._onVideoPlaying = this._onVideoPlaying.bind(this);
        this._onVideoSeeking = this._onVideoSeeking.bind(this);
        this._onVideoSeeked = this._onVideoSeeked.bind(this);

        // Attach updateend listeners
        this.sourceBuffers.forEach((state, trackId) => {
            state.sb.addEventListener('updateend', () => this._onUpdateEnd(trackId));
        });

        // Attach video event listeners
        this.video.addEventListener('timeupdate', this._onVideoTimeUpdate);
        this.video.addEventListener('waiting', this._onVideoWaiting);
        this.video.addEventListener('playing', this._onVideoPlaying);
        this.video.addEventListener('seeking', this._onVideoSeeking);
        this.video.addEventListener('seeked', this._onVideoSeeked);

        // Heartbeat for Queue Draining and Decisive Diagnostics
        this.heartbeatTimer = setInterval(() => this._onHeartbeat(), 1000);
    }

    /**
     * Heartbeat - ensures queues are drained even if network is finished.
     */
    _onHeartbeat() {
        if (this.destroyed) return;

        // Active Queue Draining
        this._processAllQueues();

        // Throttled Diagnostic Logging
        const bufferEnd = this._getEffectiveBufferEnd();
        const bufferedAhead = bufferEnd - this.video.currentTime;
        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        const vQueued = videoState ? videoState.queue.length : 0;
        const aQueued = audioState ? audioState.queue.length : 0;

        if (this.video.paused === false || this.isSeeking) {
             this.log(`[HEARTBEAT] gen=${this.activeGeneration} current=${this.video.currentTime.toFixed(1)}s ahead=${bufferedAhead.toFixed(1)}s qV=${vQueued} qA=${aQueued} seek=${this.isSeeking} fetch=${this.isFetching}`);
        }

        // Proactive eviction check
        if (!this.isSeeking) this._proactiveEviction();
    }

    /**
     * Initialize the buffer controller for a new playback session.
     */
    init() {
        this.activeGeneration = ++this.generation;
        this.destroyed = false;
        this.isSeeking = false;
        this.isFetching = false;
        this.schedulerRunning = false;

        this.log(`[BUFFER CTRL] Initialized generation=${this.activeGeneration}`);
        this._startScheduler();
    }

    /**
     * Proactive back-buffer eviction.
     */
    _proactiveEviction() {
        if (this.destroyed || this.isSeeking) return;

        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        // Only evict if SourceBuffers are not busy
        if (videoState && !videoState.sb.updating) this._evictOldBuffer('VIDEO');
        if (audioState && !audioState.sb.updating) this._evictOldBuffer('AUDIO');
    }

    /**
     * Destroy the buffer controller.
     */
    destroy() {
        this.destroyed = true;
        this.activeGeneration = 0;
        this.generation = 0;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Cancel any pending fetch
        if (this.fetchAbortController) {
            this.fetchAbortController.abort();
            this.fetchAbortController = null;
        }

        // Clear scheduler
        if (this.schedulerWakeup) {
            clearTimeout(this.schedulerWakeup);
            this.schedulerWakeup = null;
        }
        this.schedulerRunning = false;

        // Remove video event listeners
        this.video.removeEventListener('timeupdate', this._onVideoTimeUpdate);
        this.video.removeEventListener('waiting', this._onVideoWaiting);
        this.video.removeEventListener('playing', this._onVideoPlaying);
        this.video.removeEventListener('seeking', this._onVideoSeeking);
        this.video.removeEventListener('seeked', this._onVideoSeeked);

        // Clear queues
        this.sourceBuffers.forEach((state, trackId) => {
            state.queue = [];
            state.isAppending = false;
        });

        this.log(`[BUFFER CTRL] Destroyed`);
    }

    /**
     * Public seek method - called by MP4MSEPlayer.seek()
     */
    async seek(targetTime) {
        if (this.destroyed) return;

        // Check if target is already buffered (LOCAL SEEK)
        if (this._isTimeBufferedLocally(targetTime)) {
            this.log(`[SEEK] LOCAL - target=${targetTime.toFixed(3)}s already buffered`);
            this.video.currentTime = targetTime;
            return;
        }

        const newGen = ++this.generation;
        this.activeGeneration = newGen;
        this.isSeeking = true;
        this.isFetching = false;

        this.log(`[SEEK] REMOTE requested=${targetTime.toFixed(3)}s gen=${newGen}`);

        // 1. CRITICAL: Abort old generation fetch FIRST
        if (this.fetchAbortController) {
            this.fetchAbortController.abort();
            this.log(`[SEEK ABORT] aborted old fetch`);
        }
        this.fetchAbortController = new AbortController();

        // 2. Invalidate current append queues and abort SourceBuffers
        this.sourceBuffers.forEach((state, trackId) => {
            state.queue = [];
            state.isAppending = false;
            if (state.sb.updating) {
                try { state.sb.abort(); } catch(e) {}
            }
            // Remove existing buffered data for clean seek
            const duration = this.mediaSource.duration || 1000000;
            if (this.mediaSource.readyState === 'open' && !state.sb.updating) {
                try { state.sb.remove(0, duration); } catch(e) {}
            }
        });

        // 3. Wait briefly for SourceBuffer operations to settle
        await this._waitForSourceBuffersIdle();

        // 4. Start fetching from the new position with new generation
        await this._fetchAndSchedule(targetTime, newGen);
    }

    /**
     * Wait for all SourceBuffers to become idle (not updating).
     */
    async _waitForSourceBuffersIdle() {
        const states = Array.from(this.sourceBuffers.values());
        for (const state of states) {
            let safetyTimeout = null;
            while (state.sb.updating) {
                await new Promise(resolve => {
                    const handler = () => {
                        if (safetyTimeout) clearTimeout(safetyTimeout);
                        state.sb.removeEventListener('updateend', handler);
                        resolve();
                    };
                    state.sb.addEventListener('updateend', handler, { once: true });
                    safetyTimeout = setTimeout(handler, 2000); // 2s safety
                });
            }
        }
    }

    /**
     * Check if target time is already buffered in both audio and video.
     */
    _isTimeBufferedLocally(targetTime) {
        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        if (!videoState) return false;
        if (videoState.sb.buffered.length === 0) return false;

        // If audio exists, it must also be buffered
        if (audioState && audioState.sb.buffered.length === 0) return false;

        const videoBuffered = this._isTimeBuffered(this.videoTrackId, targetTime);
        const audioBuffered = audioState ? this._isTimeBuffered(this.audioTrackId, targetTime) : true;

        return videoBuffered && audioBuffered;
    }

    /**
     * Fetch unified stream from backend and schedule segments.
     */
    async _fetchAndSchedule(startTime, gen) {
        if (this.destroyed || gen !== this.activeGeneration) return;

        // Unified HTTP `start` parameter = seconds (Backend converts to ms)
        const url = `http://127.0.0.1:3301/stream/${this.manifest.fileId}/mp4/unified?start=${startTime}&gen=${gen}`;
        this.log(`[SCHEDULER] fetching unified: ${url}`);

        try {
            const response = await fetch(url, { signal: this.fetchAbortController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const rapTime = parseFloat(response.headers.get('X-RAP-Time'));
            // Phase 2 FIX: Remove RAP -> currentTime feedback loop. Just log it.
            if (!isNaN(rapTime)) {
                this.log(`[MP4 SEEK] Target=${startTime.toFixed(3)}s RAP=${rapTime.toFixed(3)}s`);
            }

            // Process the interleaved stream
            await this._processUnifiedStream(response.body, gen);

            // After stream ends, check if seek target is buffered and ready for playback
            if (gen === this.activeGeneration) {
                this._checkSeekReadyInternal(gen);
            }

        } catch (e) {
            if (gen === this.activeGeneration && e.name !== 'AbortError') {
                this.log(`[SCHEDULER ERROR] ${e.message}`);
            }
        } finally {
            this.isSeeking = false;
            this.isFetching = false;
        }
    }

    /**
     * Process the interleaved stream from the backend.
     * Protocol: [1-byte TrackID] [4-byte length BE] [Data]
     */
    async _processUnifiedStream(body, gen) {
        const reader = body.getReader();
        let leftover = new Uint8Array(0);

        try {
            while (true) {
                if (this.destroyed || gen !== this.activeGeneration) {
                    await reader.cancel();
                    break;
                }

                // Phase 4 FIX: Bounded Network Backpressure
                const videoState = this.sourceBuffers.get(this.videoTrackId);
                const audioState = this.sourceBuffers.get(this.audioTrackId);
                const vQueued = videoState ? videoState.queue.length : 0;
                const aQueued = audioState ? audioState.queue.length : 0;

                if (vQueued > 50 || aQueued > 100) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
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
                            // Phase 5 FIX: Always queue received data.
                            // Backpressure is handled by the reader loop above.
                            state.queue.push({ data: chunk, gen });
                            this._processQueue(trackId);
                        }
                        offset += 5 + length;
                    } else {
                        break;
                    }
                }
                leftover = data.slice(offset);

                // Try to process queues after receiving data
                this._processAllQueues();
            }
        } finally {
            reader.releaseLock();
            this._processAllQueues();

            // Check if we need to continue scheduling after stream ends
            if (gen === this.activeGeneration) {
                this._scheduleNextCheck();
            }
        }
    }

    /**
     * Check if the seek target time is now buffered and ready for playback.
     */
    _checkSeekReadyInternal(gen) {
        if (this.destroyed || gen !== this.activeGeneration || !this.isSeeking) return;

        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        if (!videoState) return;

        // CRITICAL: The target is the playhead position.
        // If we cleared the buffer, the playhead MUST be within the new data for playback to resume.
        const target = this.video.currentTime;
        let videoReady = false;
        let audioReady = audioState ? false : true;

        if (videoState.sb.buffered.length > 0) {
            for (let i = 0; i < videoState.sb.buffered.length; i++) {
                const start = videoState.sb.buffered.start(i);
                const end = videoState.sb.buffered.end(i);
                // Allow a small tolerance for demuxer alignment
                if (target >= start - 0.3 && target < end + 0.1) {
                    videoReady = true;
                    break;
                }
            }
        }

        if (audioState && audioState.sb.buffered.length > 0) {
            for (let i = 0; i < audioState.sb.buffered.length; i++) {
                const start = audioState.sb.buffered.start(i);
                const end = audioState.sb.buffered.end(i);
                if (target >= start - 0.3 && target < end + 0.1) {
                    audioReady = true;
                    break;
                }
            }
        }

        if (videoReady && audioReady) {
            this.log(`[SEEK] READY at target ${target.toFixed(3)}s. Resuming.`);
            this.isSeeking = false;

            if (this.video.paused) {
                if (window.safePlay) {
                    window.safePlay(this.video, "MP4 Seek Ready");
                } else {
                    this.video.play().catch(() => {});
                }
            }
            this.onSeekReady();
        } else {
            // Log periodically while stuck
            if (!this.lastStuckLog || Date.now() - this.lastStuckLog > 2000) {
                this.log(`[SEEK WAIT] target=${target.toFixed(3)}s | V-Buffered=${videoState.sb.buffered.length > 0 ? videoState.sb.buffered.start(0).toFixed(3) : 'NONE'}`);
                this.lastStuckLog = Date.now();
            }
            // Schedule another check
            setTimeout(() => this._checkSeekReadyInternal(gen), 200);
        }
    }

    /**
     * Determine if we should queue a segment for the given track type.
     * Returns true if the effective buffer ahead is less than BUFFERING_GOAL.
     */
    _shouldQueueSegment(type) {
        if (this.destroyed) return false;
        if (this.isSeeking) return true; // Always queue during seek

        const bufferEnd = this._getEffectiveBufferEnd();
        const currentTime = this.video.currentTime;
        const bufferedAhead = bufferEnd - currentTime;

        // If we're below rebuffering goal, always queue
        if (bufferedAhead < this.REBUFFERING_GOAL) return true;

        // If we're below buffering goal, queue
        if (bufferedAhead < this.BUFFERING_GOAL) return true;

        // Buffer is sufficient
        return false;
    }

    /**
     * Get the effective buffer end (minimum of video and audio buffer ends).
     */
    _getEffectiveBufferEnd() {
        let videoEnd = -Infinity;
        let audioEnd = -Infinity;

        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        if (videoState && videoState.sb.buffered.length > 0) {
            videoEnd = videoState.sb.buffered.end(videoState.sb.buffered.length - 1);
        }
        if (audioState && audioState.sb.buffered.length > 0) {
            audioEnd = audioState.sb.buffered.end(audioState.sb.buffered.length - 1);
        }

        // Phase 5 FIX: Fallback to current time if no data is buffered
        if (videoEnd === -Infinity && audioEnd === -Infinity) {
            return this.video.currentTime;
        }

        // If one track has no data yet, use the other
        if (videoEnd === -Infinity) return audioEnd;
        if (audioEnd === -Infinity) return videoEnd;

        // Effective end is the minimum (both tracks must be buffered)
        return Math.min(videoEnd, audioEnd);
    }

    /**
     * Get buffered ranges for a track type.
     */
    _getBufferedRanges(trackId) {
        const state = this.sourceBuffers.get(trackId);
        if (!state || state.sb.buffered.length === 0) return [];
        const ranges = [];
        for (let i = 0; i < state.sb.buffered.length; i++) {
            ranges.push({ start: state.sb.buffered.start(i), end: state.sb.buffered.end(i) });
        }
        return ranges;
    }

    /**
     * Check if a specific time is buffered for a track.
     */
    _isTimeBuffered(trackId, time) {
        const state = this.sourceBuffers.get(trackId);
        if (!state) return false;
        for (let i = 0; i < state.sb.buffered.length; i++) {
            if (time >= state.sb.buffered.start(i) - 0.1 && time < state.sb.buffered.end(i) + 0.1) {
                return true;
            }
        }
        return false;
    }

    /**
     * Process all track queues.
     */
    _processAllQueues() {
        this.sourceBuffers.forEach((state, trackId) => {
            this._processQueue(trackId);
        });
    }

    /**
     * Process a single track's append queue.
     * Serializes appends by waiting for updateend.
     */
    _processQueue(trackId) {
        const state = this.sourceBuffers.get(trackId);
        if (!state || state.isAppending || state.sb.updating || state.queue.length === 0) return;

        // Check generation match
        const item = state.queue[0];
        if (item.gen !== this.activeGeneration) {
            state.queue.shift();
            this._processQueue(trackId);
            return;
        }

        // Check buffer need before appending
        if (!this._shouldQueueSegment(state.type)) {
            // If the buffer is full, we stop appending from memory queue.
            return;
        }

        const chunk = state.queue.shift();
        state.isAppending = true;

        const chunkData = chunk.data;
        try {
            state.sb.appendBuffer(chunkData);
        } catch (e) {
            state.isAppending = false;
            if (e.name === 'QuotaExceededError') {
                this._handleQuotaExceeded(state.type, chunk);
            } else {
                this.log(`[APPEND ERROR] ${state.type} ${e.name}: ${e.message}`);
            }
        }
    }

    /**
     * Handle QuotaExceededError by evicting old buffer and retrying.
     */
    async _handleQuotaExceeded(trackType, failedChunk) {
        this.log(`[QUOTA] ${trackType} QuotaExceededError - attempting recovery`);

        // 1. Pause scheduling
        this.isFetching = true; // Prevent new fetches

        // 2. Evict old buffer behind playhead
        await this._evictOldBuffer(trackType);

        // 3. Wait for SourceBuffer to be ready
        await this._waitForUpdateEnd(trackType);

        // 4. Re-queue the failed chunk
        const state = this.sourceBuffers.get(this._getTrackIdByType(trackType));
        if (state) {
            state.queue.unshift(failedChunk);
            this.log(`[QUOTA] ${trackType} re-queued failed chunk`);
        }

        // 5. Resume scheduling
        this.isFetching = false;
        this._processQueue(this._getTrackIdByType(trackType));
        this._scheduleNextCheck();
    }

    /**
     * Evict old buffer behind the playhead (Shaka-style bufferBehind).
     */
    async _evictOldBuffer(trackType) {
        const trackId = this._getTrackIdByType(trackType);
        const state = this.sourceBuffers.get(trackId);
        if (!state) return;

        const currentTime = this.video.currentTime;
        const evictEnd = currentTime - this.BUFFER_BEHIND;

        // Don't evict if we don't have enough forward buffer
        const bufferedRanges = this._getBufferedRanges(trackId);
        if (bufferedRanges.length === 0) return;

        const bufferEnd = bufferedRanges[bufferedRanges.length - 1].end;
        const bufferAhead = bufferEnd - currentTime;

        // Only evict if we have more than BUFFERING_GOAL ahead
        if (bufferAhead < this.BUFFERING_GOAL) {
            this.log(`[EVICT] ${trackType} SKIPPED - buffer ahead=${bufferAhead.toFixed(1)}s < goal`);
            return;
        }

        // Don't evict past the current playback position
        if (evictEnd <= 0) return;

        // Find ranges that are completely before evictEnd
        let evicted = false;
        for (let i = 0; i < state.sb.buffered.length; i++) {
            const start = state.sb.buffered.start(i);
            const end = state.sb.buffered.end(i);

            if (end <= evictEnd) {
                // This entire range can be evicted
                try {
                    this.log(`[EVICT] ${trackType} removing [${start.toFixed(3)} - ${end.toFixed(3)}]`);
                    state.sb.remove(start, end);
                    evicted = true;
                    // Wait for remove to complete
                    await this._waitForUpdateEnd(trackType);
                } catch (e) {
                    this.log(`[EVICT ERROR] ${trackType} ${e.name}`);
                }
            } else if (start < evictEnd && end > evictEnd) {
                // Partial overlap - evict up to evictEnd
                try {
                    this.log(`[EVICT] ${trackType} trimming [${start.toFixed(3)} - ${evictEnd.toFixed(3)}]`);
                    state.sb.remove(start, evictEnd);
                    evicted = true;
                    await this._waitForUpdateEnd(trackType);
                } catch (e) {
                    this.log(`[EVICT ERROR] ${trackType} ${e.name}`);
                }
            }
        }

        if (evicted) {
            this.log(`[EVICT] ${trackType} eviction complete`);
        }
    }

    /**
     * Wait for SourceBuffer to finish updating.
     */
    _waitForUpdateEnd(trackType) {
        const trackId = this._getTrackIdByType(trackType);
        const state = this.sourceBuffers.get(trackId);
        if (!state) return Promise.resolve();

        return new Promise((resolve) => {
            if (!state.sb.updating) {
                resolve();
                return;
            }
            const handler = () => {
                state.sb.removeEventListener('updateend', handler);
                resolve();
            };
            state.sb.addEventListener('updateend', handler, { once: true });
        });
    }

    /**
     * Handle updateend event from SourceBuffer.
     */
    _onUpdateEnd(trackId) {
        const state = this.sourceBuffers.get(trackId);
        if (!state) return;

        state.isAppending = false;

        // CRITICAL: Check if we are now ready to play after a seek segment is appended
        if (this.isSeeking) {
            this._checkSeekReadyInternal(this.activeGeneration);
        }

        // Process next in queue
        this._processQueue(trackId);

        // Check if we should continue scheduling
        this._scheduleNextCheck();
    }

    /**
     * Video event handlers to wake the scheduler.
     */
    _onVideoTimeUpdate() {
        if (this.destroyed) return;
        this._processAllQueues(); // Active Drain
        this._scheduleNextCheck();
    }

    _onVideoWaiting() {
        if (this.destroyed) return;
        this.log(`[EVENT] waiting at ${this.video.currentTime.toFixed(3)}`);
        this._scheduleNextCheck();
    }

    _onVideoPlaying() {
        if (this.destroyed) return;
        this._scheduleNextCheck();
    }

    _onVideoSeeking() {
        this.isSeeking = true;
    }

    _onVideoSeeked() {
        this.isSeeking = false;
        this._scheduleNextCheck();
    }

    /**
     * Schedule the next buffer check.
     * Uses a debounced approach to avoid tight loops.
     */
    _scheduleNextCheck() {
        if (this.destroyed || this.schedulerRunning) return;

        // Clear existing wakeup
        if (this.schedulerWakeup) {
            clearTimeout(this.schedulerWakeup);
        }

        // Schedule check - immediate if rebuffering, debounced otherwise
        const bufferEnd = this._getEffectiveBufferEnd();
        const bufferedAhead = bufferEnd - this.video.currentTime;
        const delay = bufferedAhead < this.REBUFFERING_GOAL ? 0 : 100;

        this.schedulerWakeup = setTimeout(() => {
            this.schedulerWakeup = null;
            this._runScheduler();
        }, delay);
    }

    /**
     * Run the scheduler - check buffer and fetch if needed.
     */
    async _runScheduler() {
        if (this.destroyed || this.schedulerRunning || this.isSeeking || this.isFetching) {
            this.schedulerRunning = false;
            return;
        }

        this.schedulerRunning = true;

        try {
            const bufferEnd = this._getEffectiveBufferEnd();
            const currentTime = this.video.currentTime;
            const bufferedAhead = bufferEnd - currentTime;

            // Check if we need more buffer
            if (bufferedAhead >= this.BUFFERING_GOAL) {
                this.schedulerRunning = false;
                return;
            }

            // Need more buffer - fetch next segment
            this.isFetching = true;
            await this._fetchNextSegment(bufferEnd);

        } catch (e) {
            if (this.activeGeneration === this.generation) {
                this.log(`[SCHEDULER ERROR] ${e.message}`);
            }
        } finally {
            this.isFetching = false;
            this.schedulerRunning = false;

            // Schedule next check
            this._scheduleNextCheck();
        }
    }

    /**
     * Fetch the next required media segment from the backend.
     */
    async _fetchNextSegment(startTime) {
        if (this.destroyed || this.activeGeneration !== this.generation) return;

        // Unified HTTP `start` parameter = seconds (Backend converts to ms)
        const url = `http://127.0.0.1:3301/stream/${this.manifest.fileId}/mp4/unified?start=${startTime}&gen=${this.activeGeneration}`;
        this.log(`[SCHEDULER] fetching next segment from ${startTime.toFixed(3)}s gen=${this.activeGeneration}`);

        try {
            const response = await fetch(url, { signal: this.fetchAbortController?.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await this._processUnifiedStream(response.body, this.activeGeneration);

        } catch (e) {
            if (e.name !== 'AbortError' && this.activeGeneration === this.generation) {
                this.log(`[SCHEDULER] Fetch failed: ${e.message}`);
            }
        }
    }

    /**
     * Log buffer state for diagnostics.
     */
    _logBufferState(bufferEnd, bufferedAhead) {
        const videoState = this.sourceBuffers.get(this.videoTrackId);
        const audioState = this.sourceBuffers.get(this.audioTrackId);

        let videoEnd = 'none', audioEnd = 'none';
        if (videoState && videoState.sb.buffered.length > 0) {
            videoEnd = videoState.sb.buffered.end(videoState.sb.buffered.length - 1).toFixed(1);
        }
        if (audioState && audioState.sb.buffered.length > 0) {
            audioEnd = audioState.sb.buffered.end(audioState.sb.buffered.length - 1).toFixed(1);
        }

        this.log(`[BUFFER] current=${this.video.currentTime.toFixed(1)} videoEnd=${videoEnd} audioEnd=${audioEnd} ahead=${bufferedAhead.toFixed(1)} goal=${this.BUFFERING_GOAL}`);
    }

    /**
     * Helper to get trackId by type.
     */
    _getTrackIdByType(type) {
        return type === 'VIDEO' ? this.videoTrackId : this.audioTrackId;
    }

    /**
     * Start the scheduler loop.
     */
    _startScheduler() {
        this._scheduleNextCheck();
    }

    // Utility methods for external use
    getBufferedRanges(trackId) {
        return this._getBufferedRanges(trackId);
    }

    isTimeBuffered(trackId, time) {
        return this._isTimeBuffered(trackId, time);
    }

    getBufferedAhead() {
        const bufferEnd = this._getEffectiveBufferEnd();
        return bufferEnd - this.video.currentTime;
    }

    getGeneration() {
        return this.activeGeneration;
    }
}

window.MP4BufferController = MP4BufferController;
