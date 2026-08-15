const fs = require('fs');
const transportManager = require('./TransportManager');

/**
 * MKV Metadata Engine - Focused on Structural Metadata (Header, Info, Tracks, Cues)
 */
class MKVMetaEngine {
    constructor() {
        this.cache = new Map();
        this.activeParses = new Map();
    }

    async parse(fileId, filePath, tdSend, fileEvents, log) {
        if (this.cache.has(fileId)) return this.cache.get(fileId);
        if (this.activeParses.has(fileId)) return this.activeParses.get(fileId);

        const parseTask = (async () => {
            try {
                const metadata = {
                    fileId,
                    tracks: [],
                    cues: {},
                    seekMap: {},
                    segmentDataOffset: 0,
                    firstClusterPos: 0,
                    fileSize: 0,
                    duration: 0,
                    timecodeScale: 1000000,
                    tracksReady: false,
                    cuesReady: false
                };

                // CRITICAL PATH: Header -> Tracks
                await this._runCriticalParse(metadata, filePath, tdSend, fileEvents, log);

                // BACKGROUND PATH: Cues + First Cluster
                this._runBackgroundParse(metadata, filePath, tdSend, fileEvents, log);

                this.cache.set(fileId, metadata);
                return metadata;
            } finally {
                this.activeParses.delete(fileId);
            }
        })();

        this.activeParses.set(fileId, parseTask);
        return parseTask;
    }

    getMetadata(fileId) { return this.cache.get(fileId); }

    getSubtitleTracks(fileId) {
        const meta = this.cache.get(fileId);
        return (meta?.tracks || []).filter(t => t.type === 'subtitle');
    }

    getClusterForTime(fileId, timestampMs, trackNumber) {
        const meta = this.cache.get(fileId);
        if (!meta || !meta.cues) return null;

        // 1. Try track-specific cues first
        const trackCues = meta.cues[trackNumber] || [];
        const bestTrackCue = trackCues.reduce((prev, curr) => {
            if (curr.time > timestampMs) return prev;
            if (!prev) return curr;
            return (curr.time > prev.time) ? curr : prev;
        }, null);

        // 2. If track cues are missing or significantly behind (sparse index),
        // fallback to a global search across all track cues to find the closest physical cluster
        if (!bestTrackCue || (timestampMs - bestTrackCue.time > 60000)) { // 60s gap threshold
            let bestGlobalCue = null;
            for (const tId in meta.cues) {
                const cues = meta.cues[tId];
                const cue = cues.reduce((prev, curr) => {
                    if (curr.time > timestampMs) return prev;
                    if (!prev) return curr;
                    return (curr.time > prev.time) ? curr : prev;
                }, null);

                if (cue && (!bestGlobalCue || cue.time > bestGlobalCue.time)) {
                    bestGlobalCue = cue;
                }
            }
            if (bestGlobalCue) {
                return {
                    startOffset: meta.segmentDataOffset + bestGlobalCue.clusterPos,
                    timeStart: bestGlobalCue.time
                };
            }
        }

        if (!bestTrackCue) return { startOffset: meta.firstClusterPos, timeStart: 0 };

        return {
            startOffset: meta.segmentDataOffset + bestTrackCue.clusterPos,
            timeStart: bestTrackCue.time
        };
    }

    async _runCriticalParse(metadata, filePath, tdSend, fileEvents, log) {
        let fd;
        try {
            const fileInfo = await tdSend({ '@type': 'getFile', 'file_id': metadata.fileId });
            metadata.fileSize = fileInfo.size;

            // 1. Initial Scan for SeekHead
            await this._ensureBytes(metadata.fileId, 0, 256 * 1024, tdSend, fileEvents);
            fd = fs.openSync(filePath, 'r');

            const segment = this._findTopLevelElement(fd, 0x18538067);
            if (!segment) throw new Error("Segment not found");
            metadata.segmentDataOffset = segment.dataOffset;

            // 2. Parse SeekHead
            const seekHead = this._findTopLevelElement(fd, 0x114D9B74, segment.dataOffset);
            if (seekHead) {
                const headBuf = Buffer.alloc(seekHead.size);
                fs.readSync(fd, headBuf, 0, headBuf.length, seekHead.dataOffset);
                metadata.seekMap = this._parseSeekHeadFromBuffer(headBuf);
            }

            // 3. Parse Info
            let infoPos = metadata.seekMap[0x1549A966] !== undefined ? (segment.dataOffset + metadata.seekMap[0x1549A966]) : null;
            if (!infoPos) infoPos = this._findTopLevelElement(fd, 0x1549A966, segment.dataOffset)?.offset;

            if (infoPos) {
                const infoEl = await this._ensureAndReadElement(metadata.fileId, filePath, infoPos, tdSend, fileEvents, log);
                if (infoEl) this._parseInfoFromBuffer(infoEl.data, metadata);
            }

            // 4. Parse Tracks
            let tracksPos = metadata.seekMap[0x1654AE6B] !== undefined ? (segment.dataOffset + metadata.seekMap[0x1654AE6B]) : null;
            if (!tracksPos) tracksPos = this._findTopLevelElement(fd, 0x1654AE6B, segment.dataOffset)?.offset;

            if (tracksPos) {
                const tracksEl = await this._ensureAndReadElement(metadata.fileId, filePath, tracksPos, tdSend, fileEvents, log);
                if (tracksEl) metadata.tracks = this._parseTracksFromBuffer(tracksEl.data);
            }

            // 5. Find first cluster (fallback)
            const firstCluster = this._findTopLevelElement(fd, 0x1F43B675, metadata.segmentDataOffset);
            if (firstCluster) {
                metadata.firstClusterPos = firstCluster.offset;
            } else {
                metadata.firstClusterPos = metadata.segmentDataOffset + (metadata.seekMap[0x1F43B675] || 0);
            }

            metadata.tracksReady = true;
            log(`[MKV] Critical metadata ready for ${metadata.fileId}`);
        } finally {
            if (fd) fs.closeSync(fd);
        }
    }

    async _runBackgroundParse(metadata, filePath, tdSend, fileEvents, log) {
        try {
            // A. Parse Cues
            const cuesPos = metadata.seekMap[0x1C53BB6B];
            if (cuesPos !== undefined) {
                const absPos = metadata.segmentDataOffset + cuesPos;
                const cuesEl = await this._ensureAndReadElement(metadata.fileId, filePath, absPos, tdSend, fileEvents, log);
                if (cuesEl) {
                    metadata.cues = this._parseCuesFromBuffer(cuesEl.data);
                    metadata.cuesReady = true;
                    log(`[MKV-BG] Cue map built for ${metadata.fileId}`);
                }
            }

            // B. Prime First Cluster
            if (metadata.firstClusterPos) {
                log(`[MKV-BG] Priming first cluster at ${metadata.firstClusterPos}`);
                // We don't need to do anything complex here, just ensure the bytes
                // so ClusterManager doesn't stall when it's eventually called.
                await this._ensureBytes(metadata.fileId, metadata.firstClusterPos, 64 * 1024, tdSend, fileEvents);
            }
        } catch (e) {
            log(`[MKV-BG] [ERROR] ${e.message}`);
        }
    }

    async _ensureAndReadElement(fileId, filePath, offset, tdSend, fileEvents, log) {
        // 1. Probe Header (12 bytes is enough for ID + Size VINT)
        await this._ensureBytes(fileId, offset, 12, tdSend, fileEvents);

        let fd = fs.openSync(filePath, 'r');
        const hBuf = Buffer.alloc(12);
        fs.readSync(fd, hBuf, 0, 12, offset);

        const idRaw = this._readVINT_ID(hBuf, 0);
        const sizeRaw = this._readVINT(hBuf, idRaw.len);
        fs.closeSync(fd);

        if (idRaw.status || sizeRaw.status) return null;

        const totalSize = idRaw.len + sizeRaw.len + sizeRaw.val;

        // 2. Ensure Full Element
        await this._ensureBytes(fileId, offset, totalSize, tdSend, fileEvents);

        fd = fs.openSync(filePath, 'r');
        const dataBuf = Buffer.alloc(sizeRaw.val);
        fs.readSync(fd, dataBuf, 0, sizeRaw.val, offset + idRaw.len + sizeRaw.len);
        fs.closeSync(fd);

        return { id: idRaw.val, data: dataBuf };
    }

    _parseInfoFromBuffer(buf, metadata) {
        let pos = 0;
        while (pos < buf.length) {
            const el = this._readElementFromBuffer(buf, pos);
            if (!el) break;
            if (el.id === 0x2AD7B1) metadata.timecodeScale = buf.readUIntBE(el.dataOffset, el.size);
            else if (el.id === 0x4489) { // Duration
                if (el.size === 4) metadata.duration = buf.readFloatBE(el.dataOffset);
                else if (el.size === 8) metadata.duration = buf.readDoubleBE(el.dataOffset);
            }
            pos += el.totalSize;
        }
        // Convert duration to MS if it was using TimecodeScale
        if (metadata.duration > 0 && metadata.timecodeScale > 0) {
            metadata.duration = Math.floor((metadata.duration * metadata.timecodeScale) / 1000000);
        }
    }

    _findTopLevelElement(fd, targetId, startOffset = 0) {
        let offset = startOffset;
        while (true) {
            const el = this._readElement(fd, offset);
            if (!el) break;
            if (el.id === targetId) return el;
            if (el.id === 0x00) { offset += 1; continue; }
            if (el.id === 0x18538067) offset = el.dataOffset; else offset += el.totalSize;
            if (offset > startOffset + 50 * 1024 * 1024) break;
        }
        return null;
    }

    _readElement(fd, offset) {
        const headerBuf = Buffer.alloc(12);
        try {
            const bytesRead = fs.readSync(fd, headerBuf, 0, 12, offset);
            if (bytesRead < 2) return null;
            const idRaw = this._readVINT_ID(headerBuf, 0);
            if (idRaw.status) return null;
            const sizeRaw = this._readVINT(headerBuf, idRaw.len);
            if (sizeRaw.status) return null;
            const isUnknown = (sizeRaw.val === (Math.pow(2, 7 * sizeRaw.len) - 1));
            return { id: idRaw.val, offset, dataOffset: offset + idRaw.len + sizeRaw.len, size: isUnknown ? -1 : sizeRaw.val, totalSize: idRaw.len + sizeRaw.len + (isUnknown ? 0 : sizeRaw.val) };
        } catch(e) { return null; }
    }

    _readVINT_ID(buf, pos) {
        if (pos >= buf.length) return { status: 'NEED_DATA' };
        const first = buf[pos];
        let len = 0;
        if (first & 0x80) len = 1;
        else if (first & 0x40) len = 2;
        else if (first & 0x20) len = 3;
        else if (first & 0x10) len = 4;
        else if (first === 0x00) return { val: 0x00, len: 1 };
        else return { status: 'INVALID' };

        if (pos + len > buf.length) return { status: 'NEED_DATA', len };
        let val = 0;
        for (let i = 0; i < len; i++) val = val * 256 + buf[pos + i];
        return { val, len };
    }

    _readVINT(buf, pos) {
        if (pos >= buf.length) return { status: 'NEED_DATA' };
        const first = buf[pos];
        let len = 0;
        if (first & 0x80) len = 1;
        else if (first & 0x40) len = 2;
        else if (first & 0x20) len = 3;
        else if (first & 0x10) len = 4;
        else if (first & 0x08) len = 5;
        else if (first & 0x04) len = 6;
        else if (first & 0x02) len = 7;
        else if (first & 0x01) len = 8;

        if (len === 0) return { status: 'INVALID' };
        if (pos + len > buf.length) return { status: 'NEED_DATA', len };

        let val = first & (0xFF >> len);
        for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
        return { val, len };
    }

    _parseSeekHeadFromBuffer(buf) {
        const map = {}; let pos = 0;
        while (pos < buf.length) {
            const el = this._readElementFromBuffer(buf, pos);
            if (!el) break;
            if (el.id === 0x4DBB) {
                let sPos = el.dataOffset - el.offset + pos, sEnd = sPos + el.size;
                let sId = null, sOff = null;
                while (sPos < sEnd) {
                    const sub = this._readElementFromBuffer(buf, sPos);
                    if (!sub) break;
                    if (sub.id === 0x53AB) sId = buf.readUIntBE(sub.dataOffset, sub.size);
                    else if (sub.id === 0x53AC) sOff = buf.readUIntBE(sub.dataOffset, sub.size);
                    sPos += sub.totalSize;
                }
                if (sId !== null && sOff !== null) map[sId] = sOff;
            }
            pos += el.totalSize;
        }
        return map;
    }

    _parseTracksFromBuffer(buf) {
        const tracks = []; let pos = 0;
        while (pos < buf.length) {
            const entry = this._readElementFromBuffer(buf, pos);
            if (!entry) break;
            if (entry.id === 0xAE) {
                const t = { flags: { enabled: true, default: false, forced: false } };
                let tPos = entry.dataOffset - entry.offset + pos, tEnd = tPos + entry.size;
                while (tPos < tEnd) {
                    const el = this._readElementFromBuffer(buf, tPos);
                    if (!el) break;
                    if (el.id === 0xD7) t.number = buf.readUIntBE(el.dataOffset, el.size);
                    else if (el.id === 0x73C5) t.uid = buf.readBigUInt64BE(el.dataOffset);
                    else if (el.id === 0x83) t.type = (buf[el.dataOffset] === 1 ? 'video' : buf[el.dataOffset] === 2 ? 'audio' : buf[el.dataOffset] === 17 ? 'subtitle' : 'other');
                    else if (el.id === 0x86) t.codec = buf.toString('utf8', el.dataOffset, el.dataOffset + el.size).replace(/\0/g, '');
                    else if (el.id === 0x63A2) t.codecPrivate = Buffer.from(buf.slice(el.dataOffset, el.dataOffset + el.size));
                    else if (el.id === 0xE1) { // Audio
                        let aPos = el.dataOffset, aEnd = el.dataOffset + el.size;
                        while (aPos < aEnd) {
                            const aEl = this._readElementFromBuffer(buf, aPos);
                            if (!aEl) break;
                            if (aEl.id === 0xB5) t.samplingFrequency = buf.readFloatBE(aEl.dataOffset);
                            else if (aEl.id === 0x9F) t.channels = buf.readUIntBE(aEl.dataOffset, aEl.size);
                            else if (aEl.id === 0x6264) t.bitDepth = buf.readUIntBE(aEl.dataOffset, aEl.size);
                            aPos += aEl.totalSize;
                        }
                    }
                    else if (el.id === 0xE0) { // Video
                        let vPos = el.dataOffset, vEnd = el.dataOffset + el.size;
                        while (vPos < vEnd) {
                            const vEl = this._readElementFromBuffer(buf, vPos);
                            if (!vEl) break;
                            if (vEl.id === 0xB0) t.width = buf.readUIntBE(vEl.dataOffset, vEl.size);
                            else if (vEl.id === 0xBA) t.height = buf.readUIntBE(vEl.dataOffset, vEl.size);
                            vPos += vEl.totalSize;
                        }
                    }
                    else if (el.id === 0x56BB) t.seekPreRoll = buf.readUIntBE(el.dataOffset, el.size);
                    else if (el.id === 0x56AA) t.codecDelay = buf.readUIntBE(el.dataOffset, el.size);
                    else if (el.id === 0x75A2) t.discardPadding = buf.readIntBE(el.dataOffset, el.size);
                    else if (el.id === 0x22B59C) t.language = buf.toString('utf8', el.dataOffset, el.dataOffset + el.size).replace(/\0/g, '');
                    else if (el.id === 0x536E) t.title = buf.toString('utf8', el.dataOffset, el.dataOffset + el.size).replace(/\0/g, '');
                    else if (el.id === 0x6D80) t.contentEncodings = true;
                    tPos += el.totalSize;
                }
                if (t.number) tracks.push(t);
            }
            pos += entry.totalSize;
        }
        return tracks;
    }

    _parseCuesFromBuffer(buf) {
        const cues = {}; let pos = 0;
        while (pos < buf.length) {
            const cuePoint = this._readElementFromBuffer(buf, pos);
            if (cuePoint && cuePoint.id === 0xBB) {
                let cpPos = cuePoint.dataOffset, cpEnd = cuePoint.dataOffset + cuePoint.size, time = 0;
                while (cpPos < cpEnd) {
                    const el = this._readElementFromBuffer(buf, cpPos);
                    if (!el) break;
                    if (el.id === 0xB3) time = buf.readUIntBE(el.dataOffset, el.size);
                    else if (el.id === 0xB7) {
                        let ctpPos = el.dataOffset, ctpEnd = el.dataOffset + el.size, tId = 0, cPos = 0;
                        while (ctpPos < ctpEnd) {
                            const sub = this._readElementFromBuffer(buf, ctpPos);
                            if (!sub) break;
                            if (sub.id === 0xF7) tId = buf.readUIntBE(sub.dataOffset, sub.size);
                            else if (sub.id === 0xF1) cPos = buf.readUIntBE(sub.dataOffset, sub.size);
                            ctpPos += sub.totalSize;
                        }
                        if (tId) { if (!cues[tId]) cues[tId] = []; cues[tId].push({ time, clusterPos: cPos }); }
                    }
                    cpPos += el.totalSize;
                }
            }
            pos += cuePoint?.totalSize || buf.length;
        }
        return cues;
    }

    _readElementFromBuffer(buf, offset) {
        if (offset + 1 >= buf.length) return null;
        const idRaw = this._readVINT_ID(buf, offset);
        if (!idRaw) return null;
        const sOffset = offset + idRaw.len;
        if (sOffset >= buf.length) return null;
        const sizeRaw = this._readVINT(buf, sOffset);
        if (!sizeRaw) return null;
        const isUnknown = (sizeRaw.val === (Math.pow(2, 7 * sizeRaw.len) - 1));
        return { id: idRaw.val, offset, dataOffset: sOffset + sizeRaw.len, size: isUnknown ? -1 : sizeRaw.val, totalSize: idRaw.len + sizeRaw.len + (isUnknown ? 0 : sizeRaw.val) };
    }

    async _ensureBytes(fileId, offset, limit, tdSend, fileEvents) {
        // Wrapper for new TransportManager
        return await transportManager.ensureRange(fileId, offset, limit, tdSend, fileEvents);
    }

    cancel(fileId) {
        this.cache.delete(fileId);
    }
}

module.exports = new MKVMetaEngine();
