const EventEmitter = require('events');
const diagnosticManager = require('./DiagnosticManager');

/**
 * TransportManager - Generic TDLib Transport Broker.
 * Handles range prioritization, download requests, and the update wait-loop.
 */
class TransportManager {
    constructor() {
        this.activePlayerRanges = new Map();
        this.activeGapRepairs = new Map();
        this.activeSessionId = 0;
        this.activeFileId = null;
        this.activeGeneration = null; // Phase 4 FIX: Track generation to separate Refill from Seek
        this.waitCounter = 0;
    }

    /**
     * Starts or continues a playback session.
     * New generations (Seeks) trigger a reset. Same generations (Refills) reuse the session.
     */
    async startSession(fileId, tdSend, generation = null, fileEvents = null) {
        const isSameFile = (this.activeFileId === fileId);
        const isSameGen = (generation !== null && this.activeGeneration === generation);

        // Phase 4 FIX: If this is a buffer refill for the same seek generation, REUSE the session.
        if (isSameFile && isSameGen) {
            diagnosticManager.log('transport', `[SESSION] #REFILL | Reusing Session #${this.activeSessionId} for gen=${generation}`);
            return this.activeSessionId;
        }

        const oldSession = this.activeSessionId;
        this.activeSessionId++;
        const newSession = this.activeSessionId;
        this.activeGeneration = generation;

        diagnosticManager.log('transport', `[SESSION] #NEW_PLAYBACK | Started #${newSession} (gen=${generation}) | Previous #${oldSession} killed`);

        // Phase 5 FIX: Wake up any ensureRange operations tied to the old session so they can abort immediately.
        if (fileEvents) {
            diagnosticManager.log('transport', `[SESSION] Waking stale listeners for file=${fileId}`);
            fileEvents.emit(`update_${fileId}`);
        }

        // 1. Native TDLib Cancellation: Instantly clear the C++ download queue
        if (tdSend) {
            try {
                // Tells TDLib to stop all pending download operations for this file immediately
                await tdSend({
                    '@type': 'cancelDownloadFile',
                    'file_id': fileId,
                    'only_if_pending': true
                });
                diagnosticManager.log('transport', `[TDLIB] Native cancel sent for file=${fileId}`);
            } catch (e) {
                diagnosticManager.log('transport', `[TDLIB] Cancel failed: ${e.message}`);
            }
        }

        this.activeFileId = fileId;

        // 2. Clear internal JS repair queue
        this.activeGapRepairs.forEach((task, key) => {
            if (key.startsWith(`${fileId}:`)) {
                this.activeGapRepairs.delete(key);
            }
        });

        return newSession;
    }

    /**
     * Informs TDLib of the current playhead priority window.
     */
    setPriorityWindow(fileId, start, end) {
        diagnosticManager.log('transport', `Priority Window: file=${fileId} range=[${start}..${end}]`);
        if (start === 0 && end === 0) {
            this.activePlayerRanges.delete(fileId);
        } else {
            this.activePlayerRanges.set(fileId, { start, end });
        }
    }

    /**
     * Core Transport Logic: Ensures a specific range is on disk before resolving.
     */
    async ensureRange(fileId, offset, limit, tdSend, fileEvents, log, sessionId = null, signal = null) {
        diagnosticManager.setSessionInfo('transportRequests', (diagnosticManager.sections.session.transportRequests || 0) + 1);

        return new Promise((resolve) => {
            let isDone = false;
            let timeout = null;

            // Shared cleanup for all exit paths (Success, Abort, Timeout)
            const cleanup = () => {
                isDone = true;
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                fileEvents.removeListener(`update_${fileId}`, check);
                if (signal) signal.removeEventListener('abort', handleAbort);
            };

            const finish = (result) => {
                if (isDone) return;
                cleanup();
                resolve(result);
            };

            const handleAbort = () => finish({ state: 'ABORTED' });

            const check = async () => {
                if (isDone) return;

                // 1. Session Validity Check (Critical for preventing stale 45s timeouts)
                if (sessionId !== null && sessionId !== this.activeSessionId) {
                    if (log) log(`[TRANSPORT ABORT] offset=${offset} reason=SessionChanged current=${this.activeSessionId} req=${sessionId}`);
                    return finish({ state: 'ABORTED' });
                }

                // 2. AbortSignal Check
                if (signal && signal.aborted) {
                    return finish({ state: 'ABORTED' });
                }

                try {
                    // 3. Check local availability
                    const prefix = await tdSend({
                        '@type': 'getFileDownloadedPrefixSize',
                        'file_id': fileId,
                        'offset': offset
                    });

                    if (prefix && prefix.size >= limit) {
                        this.activeGapRepairs.delete(`${fileId}:${offset}:${limit}`);
                        diagnosticManager.log('transport', `Range Ready: file=${fileId} offset=${offset} limit=${limit}`);
                        return finish({ state: 'READY' });
                    }

                    // 4. Trigger Download if not already in progress
                    const activeRange = this.activePlayerRanges.get(fileId);
                    const isHighPriority = activeRange && offset >= activeRange.start && (offset + limit) <= activeRange.end;
                    const repairKey = `${fileId}:${offset}:${limit}`;

                    if (!this.activeGapRepairs.has(repairKey)) {
                        const priority = isHighPriority ? 32 : 1;
                        diagnosticManager.log('transport', `Requesting Range: file=${fileId} offset=${offset} limit=${limit} priority=${priority}`);
                        if (log) log(`[TRANSPORT] Requesting range [${offset}..${offset + limit}] (Priority: ${priority})`);

                        const task = tdSend({
                            '@type': 'downloadFile', 'file_id': fileId, 'priority': priority,
                            'offset': offset, 'limit': limit, 'synchronous': false
                        }).catch(() => {});
                        this.activeGapRepairs.set(repairKey, task);
                    }

                    // 5. Wait for next update
                    if (!isDone) {
                        fileEvents.once(`update_${fileId}`, check);
                    }
                } catch (e) {
                    diagnosticManager.log('transport', `Error: ${e.message}`);
                    if (!isDone) {
                        fileEvents.once(`update_${fileId}`, check);
                    }
                }
            };

            // Initialize Abort Handling
            if (signal) {
                if (signal.aborted) return handleAbort();
                signal.addEventListener('abort', handleAbort, { once: true });
            }

            // Safety Timeout
            timeout = setTimeout(() => {
                const msg = `Range ${offset} failed to arrive in 45s`;
                if (log) log(`[TRANSPORT-TIMEOUT] ${msg}`);
                diagnosticManager.log('transport', `TIMEOUT: ${msg}`);
                finish({ state: 'TIMEOUT' });
            }, 45000);

            // Start first check
            check();
        });
    }
}

module.exports = new TransportManager();
