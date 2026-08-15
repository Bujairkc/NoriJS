const mkvMetaEngine = require('../../mkvMetaEngine');
const WebMAudioSerializer = require('./WebMAudioSerializer');
const AACSerializer = require('./AACSerializer');
const ISOBMFFSerializer = require('../../backend/audio/isobmff/ISOBMFFSerializer');
const clusterManager = require('../../clusterManager');
const transportManager = require('../../TransportManager');
const MP4Backend = require('../../MP4Backend');
const diagnosticManager = require('../../DiagnosticManager');
const path = require('path');
const fs = require('fs');

// Auth cache for container resolution and backend instances
const backendCache = new Map(); // fileId -> { containerType, instance }
const resolutionPromises = new Map(); // Phase 5 FIX: De-duplicate simultaneous resolution requests

/**
 * AudioStreamOrchestrator
 * Detects container/codec and routes to the appropriate backend.
 */
class AudioStreamOrchestrator {
    constructor(fileId, filePath, tdSend, fileEvents, log) {
        this.fileId = fileId;
        this.filePath = filePath;
        this.tdSend = tdSend;
        this.fileEvents = fileEvents;
        this.log = log;
    }

    /**
     * Authoritative resolution step.
     * Checks cache -> Sniffs signature -> Falls back to extension.
     */
    async _resolveBackend() {
        if (backendCache.has(this.fileId)) {
            const cached = backendCache.get(this.fileId);
            this.log(`[ROUTER] reusing backend: ${cached.containerType} for file=${this.fileId}`);
            return cached;
        }

        // Phase 5 FIX: De-duplicate sniffing/probing to prevent TDLIB congestion
        if (resolutionPromises.has(this.fileId)) {
            this.log(`[ROUTER] waiting for existing resolution for file=${this.fileId}`);
            return resolutionPromises.get(this.fileId);
        }

        const promise = (async () => {
            let containerType = "unknown";
            const ext = path.extname(this.filePath).toLowerCase();

            // 1. Perform Sniffing (Authoritative)
            try {
                await transportManager.ensureRange(this.fileId, 0, 16, this.tdSend, this.fileEvents, this.log);
                const fd = fs.openSync(this.filePath, 'r');
                const sniffBuf = Buffer.alloc(16);
                fs.readSync(fd, sniffBuf, 0, 16, 0);
                fs.closeSync(fd);

                // EBML / MKV Signature: 1A 45 DF A3
                if (sniffBuf[0] === 0x1A && sniffBuf[1] === 0x45 && sniffBuf[2] === 0xDF && sniffBuf[3] === 0xA3) {
                    containerType = "mkv";
                }
                // MP4 Signature: 'ftyp' at offset 4
                else if (sniffBuf.toString('ascii', 4, 8) === 'ftyp') {
                    containerType = "mp4";
                }
            } catch (e) {
                this.log(`[ROUTER] Sniffing failed: ${e.message}.`);
            }

            // 2. Extension Fallback (Only if sniffing was inconclusive)
            if (containerType === "unknown") {
                if (ext === '.mp4' || ext === '.mov' || ext === '.m4a') {
                    containerType = "mp4";
                } else {
                    containerType = "mkv"; // Default to MKV
                }
            }

            this.log(`[ROUTER] container resolved: ${containerType} for file=${this.fileId}`);

            let instance;
            if (containerType === "mp4") {
                instance = new MP4Backend(this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);
            } else {
                instance = mkvMetaEngine;
            }

            return { containerType, instance };
        })();

        resolutionPromises.set(this.fileId, promise);
        try {
            const result = await promise;
            backendCache.set(this.fileId, result);
            this.log(`[ROUTER] backend cached: ${result.containerType}`);
            return result;
        } finally {
            resolutionPromises.delete(this.fileId);
        }
    }

    /**
     * Generic metadata getter.
     */
    async getMetadata() {
        const filename = path.basename(this.filePath);
        this.log(`[ORCHESTRATOR] getMetadata for file=${this.fileId} name=${filename}`);

        const cached = await this._resolveBackend();

        if (cached.containerType === "mp4") {
            return await cached.instance.getMetadata();
        }

        // MKV Path
        return await mkvMetaEngine.parse(this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);
    }

    /**
     * Resolves the correct backend based on the container and codec.
     */
    async getBackend(trackNumber, requestedMode = 'adts') {
        this.log(`[ORCHESTRATOR] CALL getBackend(track=${trackNumber}, mode=${requestedMode})`);
        const cached = await this._resolveBackend();

        if (cached.containerType === 'mp4') {
            this.log(`[ORCHESTRATOR] RETURN MP4Backend instance`);
            return cached.instance;
        }

        // MKV Logic
        try {
            this.log(`[ORCHESTRATOR] Entering MKV Logic Path`);
            const metadata = await mkvMetaEngine.parse(this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);

            // COMMIT 1: Metadata Link
            clusterManager.setMetadata(this.fileId, metadata);
            const audioTrack = (metadata.tracks || []).find(t => t.number === trackNumber && t.type === 'audio');

            if (audioTrack) {
                this.log(`[METADATA LINK] File=${this.fileId} | Tracks=${metadata.tracks.length} | AudioTrack=${audioTrack.number} | SampleRate=${audioTrack.samplingFrequency || audioTrack.sampleRate || 'Unknown'} | MetadataBound=true`);
            }

            const track = audioTrack;

            if (!track) {
                return { supported: false, codec: 'UNKNOWN', error: 'Track not found' };
            }

            const cleanCodec = (track.codec || '').trim();

            // Phase 1: Opus & Vorbis via WebM Serializer
            if (cleanCodec === 'A_OPUS' || cleanCodec === 'A_VORBIS') {
                return new WebMAudioSerializer(track, metadata, this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);
            }

            // Phase 2: AAC Support
            if (cleanCodec === 'A_AAC') {
                if (track.contentEncodings && track.contentEncodings.length > 0) {
                    this.log(`[ORCHESTRATOR] AAC track ${trackNumber} has ContentEncodings - unsupported`);
                    return { supported: false, codec: 'A_AAC', error: 'ContentEncodings not supported' };
                }

                const mode = requestedMode;

                if (mode === "fmp4") {
                    this.log(`[ORCHESTRATOR] Routing AAC to ISOBMFFSerializer (v2) [Mode: ${mode}]`);
                    const normalizedTrack = {
                        ...track,
                        sampleRate: track.samplingFrequency || 44100
                    };
                    return new ISOBMFFSerializer(normalizedTrack, metadata, this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);
                } else {
                    this.log(`[ORCHESTRATOR] Routing AAC to AACSerializer (ADTS legacy)`);
                    return new AACSerializer(track, metadata, this.fileId, this.filePath, this.tdSend, this.fileEvents, this.log);
                }
            }

            return { supported: false, codec: cleanCodec };
        } catch (err) {
            this.log(`[ORCHESTRATOR ERROR] ${err.message}`);
            throw err;
        }
    }
}

module.exports = AudioStreamOrchestrator;
