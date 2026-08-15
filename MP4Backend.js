const fs = require('fs');
const path = require('path');
const mediaDataSource = require('./MediaDataSource');
const transportManager = require('./TransportManager');
const diagnosticManager = require('./DiagnosticManager');

// Load official MP4Box v2.4.1 CommonJS build
const MP4Box = require('./thirdparty/mp4box/mp4box.all.cjs');

console.log("MP4Box loaded");

/**
 * MP4Backend - Authoritative MP4/MOV parsing via MP4Box.js.
 * Implemented as an HTTP streaming adapter (Phase 3B).
 */
class MP4Backend {
    constructor(fileId, filePath, tdSend, fileEvents, log) {
        this.fileId = fileId;
        this.filePath = filePath;
        this.tdSend = tdSend;
        this.fileEvents = fileEvents;
        this.log = log;
        this.metadata = null;
        this.metadataChunks = []; // Stores {offset, data} for metadata injection
        this.fileSize = 0;
        this.activeStreamController = null; // Phase 5 FIX: Kill previous stream loops

        diagnosticManager.setSessionInfo('fileId', fileId);
        diagnosticManager.setSessionInfo('filename', path.basename(filePath));
        diagnosticManager.setSessionInfo('extension', path.extname(filePath));
        diagnosticManager.setSessionInfo('backend', 'MP4');
        this.supported = true;
    }

    async init() {
        this.log('Backend Init');
        if (!this.metadata) {
            this.log('Metadata missing, fetching...');
            this.metadata = await this.getMetadata();
        } else {
            this.log(`Metadata already ready: tracks=${this.metadata.tracks.length}`);
        }
    }

    async getMetadata() {
        if (this.metadata) return this.metadata;

        return new Promise(async (resolve, reject) => {
            try {
                const fileInfo = await this.tdSend({ '@type': 'getFile', 'file_id': this.fileId });
                this.fileSize = parseInt(fileInfo.size, 10);
                this.log(`[MP4 DISCOVERY] File Size: ${this.fileSize}`);
            } catch (e) {
                this.log(`[MP4] Failed to get file size: ${e.message}`);
                this.fileSize = 0;
            }

            // 1. Structural Probe - find ftyp and moov box locations and sizes
            const probeHeader = async (offset) => {
                const headBuf = await mediaDataSource.getBytes(this.fileId, this.filePath, offset, 16384, this.tdSend, this.fileEvents, this.log);
                if (!headBuf) return [];
                let pos = 0;
                const boxes = [];
                while (pos + 8 <= headBuf.length) {
                    const size = headBuf.readUInt32BE(pos);
                    const type = headBuf.toString('ascii', pos + 4, pos + 8);
                    this.log(`[MP4 PROBE] Offset: ${offset + pos} Type: ${type} Size: ${size}`);
                    if (type === 'moov' || type === 'ftyp') {
                        boxes.push({ type, offset: offset + pos, size });
                    }
                    if (size === 0) break;
                    pos += size;
                    if (size === 1) pos += 8;
                }
                return boxes;
            };

            // Find locations
            let ftypInfo = null;
            let moovInfo = null;

            const headerBoxes = await probeHeader(0);
            for (const box of headerBoxes) {
                if (box.type === 'ftyp' && !ftypInfo) ftypInfo = box;
                if (box.type === 'moov' && !moovInfo) moovInfo = box;
            }

            if (!ftypInfo) {
                ftypInfo = { offset: 0, size: 24 }; // Fallback
            }

            if (!moovInfo) {
                this.log(`[MP4 DISCOVERY] moov not found in header, probing tail...`);
                const tailBoxes = await probeHeader(Math.max(0, this.fileSize - 2 * 1024 * 1024));
                for (const box of tailBoxes) {
                    if (box.type === 'moov' && !moovInfo) moovInfo = box;
                }
            }

            if (!moovInfo) {
                this.log(`[MP4 DISCOVERY ERROR] moov box not found`);
                return reject(new Error("moov box not found"));
            }

            // Fetch boxes
            const ftypBuffer = await mediaDataSource.getBytes(this.fileId, this.filePath, ftypInfo.offset, ftypInfo.size, this.tdSend, this.fileEvents, this.log);
            const moovBuffer = await mediaDataSource.getBytes(this.fileId, this.filePath, moovInfo.offset, moovInfo.size, this.tdSend, this.fileEvents, this.log);

            if (!moovBuffer || moovBuffer.length !== moovInfo.size) {
                return reject(new Error("Incomplete moov read"));
            }

            // Create MP4Box instance
            const mp4File = MP4Box.createFile();
            let isReady = false;

            mp4File.onReady = (info) => {
                if (isReady) return;
                isReady = true;

                this.log(`[MP4 DISCOVERY] onReady tracks=${info.tracks.length} duration=${info.duration} timescale=${info.timescale}`);
                this.metadataChunks = [
                    { offset: ftypInfo.offset, data: Buffer.from(ftypBuffer) },
                    { offset: moovInfo.offset, data: Buffer.from(moovBuffer) }
                ];

                const durationMs = info.duration ? Math.floor((info.duration * 1000) / info.timescale) : 0;
                const metadata = {
                    fileId: this.fileId,
                    duration: durationMs,
                    timecodeScale: 1000000,
                    fileSize: this.fileSize,
                    isFragmented: info.isFragmented,
                    tracks: [],
                    tracksReady: true
                };

                info.tracks.forEach((t, idx) => {
                    const track = {
                        number: t.id,
                        codec: t.codec,
                        type: t.video ? 'video' : (t.audio ? 'audio' : 'subtitle'),
                        flags: { default: idx === 0, forced: false }
                    };
                    if (t.video) {
                        track.width = t.video.width;
                        track.height = t.video.height;
                    } else if (t.audio) {
                        track.samplingFrequency = t.audio.sample_rate;
                        track.channels = t.audio.channel_count;
                    }
                    metadata.tracks.push(track);
                });

                this.metadata = metadata;
                resolve(metadata);
            };

            mp4File.onError = (e) => {
                this.log(`[MP4 DISCOVERY ERROR] ${e}`);
                reject(new Error(e));
            };

            // Feed ftyp + moov as a single contiguous buffer
            this.log(`[MP4 DISCOVERY] Feeding ftyp+moov buffer to MP4Box`);
            const combinedBuffer = new ArrayBuffer(ftypBuffer.length + moovBuffer.length);
            const combinedView = new Uint8Array(combinedBuffer);
            combinedView.set(new Uint8Array(ftypBuffer.buffer, ftypBuffer.byteOffset, ftypBuffer.byteLength), 0);
            combinedView.set(new Uint8Array(moovBuffer.buffer, moovBuffer.byteOffset, moovBuffer.byteLength), ftypBuffer.length);
            combinedBuffer.fileStart = ftypInfo.offset;

            mp4File.appendBuffer(combinedBuffer);

            // Give it some time to fire onReady
            setTimeout(() => {
                if (!isReady) {
                    this.log(`[MP4 DISCOVERY] onReady timed out after 5s`);
                    reject(new Error("MP4 discovery timeout"));
                }
            }, 5000);
        });
    }

    /**
     * Unified Interleaved Stream Provider (Phase 3).
     * Response Protocol: [1-byte TrackID] [4-byte length BE] [Data]
     */
    async streamUnified(res, startTimeMs, signal, sessionId) {
        // Phase 5 FIX: Forcefully abort any previous stream loop for this file
        if (this.activeStreamController) {
            this.log(`[STREAM] #ABORT_OLD | Killing previous stream for Session #${sessionId}`);
            this.activeStreamController.abort();
        }
        this.activeStreamController = new AbortController();
        const internalSignal = this.activeStreamController.signal;

        this.log(`[MP4 UNIFIED] START fileId=${this.fileId} start=${startTimeMs}ms session=${sessionId}`);

        try {
            await this.init();

            // Hard Duration Validation
            if (this.metadata && startTimeMs > this.metadata.duration) {
                this.log(`[MP4 UNIFIED] Seek target ${startTimeMs / 1000}s exceeds duration ${this.metadata.duration / 1000}s. Clamping.`);
                startTimeMs = Math.max(0, this.metadata.duration - 1000);
            }

            this.log(`[MP4 UNIFIED] init complete, metadata tracks=${this.metadata?.tracks?.length || 0}`);
            const mp4File = MP4Box.createFile();
            const stats = { bytesWritten: 0, responseClosed: false };

            // Phase 5 FIX: Wait for the new MP4Box instance to be ready after metadata injection.
            // We repackage metadata as a contiguous block at offset 0 so onReady fires instantly.
            const readyPromise = new Promise((resolve, reject) => {
                mp4File.onReady = (info) => resolve(info);
                mp4File.onError = (e) => reject(new Error(e));
                setTimeout(() => reject(new Error("Metadata injection timeout")), 5000);
            });

            // Inject cached metadata chunks
            if (this.metadataChunks && this.metadataChunks.length > 0) {
                this.log(`[MP4 UNIFIED] injecting ${this.metadataChunks.length} metadata chunks`);

                // Pack all chunks (ftyp, moov) into one contiguous buffer starting at 0
                const totalLen = this.metadataChunks.reduce((acc, c) => acc + c.data.length, 0);
                const combined = new Uint8Array(totalLen);
                let writePos = 0;
                this.metadataChunks.forEach(chunk => {
                    combined.set(new Uint8Array(chunk.data), writePos);
                    writePos += chunk.data.length;
                });

                const ab = combined.buffer;
                ab.fileStart = 0; // Force to 0 so MP4Box treats this as the authoritative header
                mp4File.appendBuffer(ab);
            }

            await readyPromise;

            const videoTrackMeta = this.metadata.tracks.find(t => t.type === 'video');
            const audioTrackMeta = this.metadata.tracks.find(t => t.type === 'audio');

            if (!videoTrackMeta) throw new Error("No video track found");

            [videoTrackMeta, audioTrackMeta].filter(Boolean).forEach(t => {
                mp4File.setSegmentOptions(t.number, null, { nbSamples: 100, rapAlignement: true });
            });

            const initSegs = mp4File.initializeSegmentation("per-track");
            this.log(`[MP4 UNIFIED] init segments: ${initSegs.map(s => s.id).join(', ')}`);
            const seekInfo = mp4File.seek(startTimeMs / 1000, true);
            this.log(`[MP4 UNIFIED] seek to ${startTimeMs/1000}s -> RAP ${seekInfo.time}s offset ${seekInfo.offset}`);

            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('X-Seek-Session', sessionId.toString());
            res.setHeader('X-RAP-Time', seekInfo.time.toString());
            res.writeHead(200);

            initSegs.forEach(seg => {
                this._writePacket(res, seg.id, Buffer.from(seg.buffer));
            });
            this.log(`[MP4 UNIFIED] init segments sent`);

            mp4File.onSegment = (id, user, buffer, sampleNum, isLast) => {
                if (signal.aborted || internalSignal.aborted || stats.responseClosed) return;
                this._writePacket(res, id, Buffer.from(buffer));
                this.log(`[MP4 UNIFIED] onSegment track=${id} sample=${sampleNum} size=${buffer.byteLength}`);
            };

            mp4File.onError = (e) => {
                this.log(`[MP4 UNIFIED ERROR] MP4Box: ${e}`);
            };

            res.on('close', () => {
                this.log(`[MP4 UNIFIED] response closed`);
                stats.responseClosed = true;
                mp4File.stop();
            });

            let currentOffset = seekInfo.offset;
            const CHUNK_SIZE = 1024 * 1024;
            mp4File.start();

            // Initial priority window
            transportManager.setPriorityWindow(this.fileId, currentOffset, currentOffset + 10 * 1024 * 1024);

            while (currentOffset < this.fileSize) {
                if (signal.aborted || internalSignal.aborted || stats.responseClosed) break;

                // Update priority window ahead of current fetch
                transportManager.setPriorityWindow(this.fileId, currentOffset, currentOffset + 5 * 1024 * 1024);

                this.log(`[MP4 UNIFIED] getBytes offset=${currentOffset} size=${CHUNK_SIZE}`);
                const chunk = await mediaDataSource.getBytes(this.fileId, this.filePath, currentOffset, CHUNK_SIZE, this.tdSend, this.fileEvents, this.log, sessionId, signal);
                if (!chunk || chunk.length === 0) break;

                const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
                ab.fileStart = currentOffset;
                const nextOffset = mp4File.appendBuffer(ab);

                if (nextOffset !== undefined && nextOffset !== null && nextOffset !== currentOffset) {
                    this.log(`[MP4 UNIFIED] parser redirect ${currentOffset} -> ${nextOffset}`);
                    currentOffset = nextOffset;
                } else {
                    currentOffset += chunk.length;
                }

                // Phase 3 Hard Fix: Backend Backpressure
                if (res.writableLength > res.writableHighWaterMark) {
                    await new Promise(resolve => res.once('drain', resolve));
                }
            }

            mp4File.flush();
            if (!res.writableEnded) res.end();
            this.log(`[MP4 UNIFIED] stream ended`);

        } catch (err) {
            if (err.name !== 'AbortError') {
                this.log(`[MP4 UNIFIED ERROR] ${err.message}\n${err.stack}`);
            }
            if (!res.headersSent) res.status(500).send(err.message);
            else res.end();
        } finally {
            if (this.activeStreamController?.signal === internalSignal) {
                this.activeStreamController = null;
            }
        }
    }

    _writePacket(res, trackId, chunk) {
        if (res.writableEnded) return;
        const header = Buffer.alloc(5);
        header.writeUInt8(trackId, 0);
        header.writeUInt32BE(chunk.length, 1);
        res.write(header);
        res.write(chunk);
    }
}

module.exports = MP4Backend;
