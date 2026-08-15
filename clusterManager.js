const fs = require('fs');
const EventEmitter = require('events');
const transportManager = require('./TransportManager');

/**
 * ClusterManager - Handles the lifecycle of MKV Clusters.
 */
class ClusterManager extends EventEmitter {
    constructor() {
        super();
        this.fileStates = new Map();
        this.activeParses = new Map();
        this.waitCounter = 0;
    }

    setMetadata(fileId, metadata) {
        const state = this.getRegistry(fileId);
        state.metadata = metadata;
    }

    setActivePlayerRange(fileId, start, end) {
        transportManager.setPriorityWindow(fileId, start, end);
    }

    getRegistry(fileId) {
        if (!this.fileStates.has(fileId)) {
            this.fileStates.set(fileId, { clusters: new Map(), metadata: null });
        }
        return this.fileStates.get(fileId);
    }

    async ensureCluster(fileId, filePath, clusterInfo, trackNumber, tdSend, fileEvents, log) {
        const offset = clusterInfo.startOffset;
        const state = this.getRegistry(fileId);

        if (!state.clusters.has(offset)) {
            state.clusters.set(offset, {
                offset,
                packets: new Map(),
                parseState: 'IDLE',
                parserPosition: 0,
                clusterTimecode: 0,
                dataOffset: 0,
                endOffset: 0,
                headerParsed: false
            });
        }

        const cluster = state.clusters.get(offset);
        if (cluster.parseState === 'PARSED') {
            return { state: 'PARSED_WITH_PACKETS' };
        }

        const parseKey = `${fileId}_${offset}`;
        if (cluster.parseState === 'PARSING') {
            const p = this.activeParses.get(parseKey);
            if (p) {
                const result = await p;
                if (result && result.state === 'WAITING_FOR_BYTES') return result;
                return { state: 'PARSED_WITH_PACKETS' };
            }
        }

        const parseTask = (async () => {
            try {
                cluster.parseState = 'PARSING';

                while (cluster.parseState !== 'PARSED') {
                    const result = await this._processCluster(fileId, filePath, offset, tdSend, fileEvents, log);

                    if (result === 'COMPLETED') {
                        cluster.parseState = 'PARSED';
                        return 'COMPLETED';
                    } else if (result && result.state === 'WAITING_FOR_BYTES') {
                        return result;
                    } else {
                        throw new Error(`Cluster process returned ${result}`);
                    }
                }
                return 'COMPLETED';
            } catch (err) {
                log(`[ClusterManager] [ERROR] Cluster ${offset}: ${err.message}`);
                cluster.parseState = 'ERROR';
                return 'ERROR';
            } finally {
                this.activeParses.delete(parseKey);
            }
        })();

        this.activeParses.set(parseKey, parseTask);
        const taskResult = await parseTask;
        if (taskResult && taskResult.state === 'WAITING_FOR_BYTES') return taskResult;
        return { state: 'PARSED_WITH_PACKETS' };
    }

    async _processCluster(fileId, filePath, offset, tdSend, fileEvents, log) {
        const registry = this.getRegistry(fileId);
        const cluster = registry.clusters.get(offset);
        let fd;

        try {
            if (!cluster.headerParsed) {
                const status = await this._ensureBytes(fileId, offset, 64, tdSend, fileEvents, log, 'HEADER_ID_SIZE', offset);
                if (status && status.state === 'WAITING_FOR_BYTES') return status;

                fd = fs.openSync(filePath, 'r');
                const hBuf = Buffer.alloc(64);
                const bytesRead = fs.readSync(fd, hBuf, 0, 64, offset);
                // log(`[WAKE_PROFILE] READ | Stage: HEADER_ID_SIZE | Req: 64 | Actual: ${bytesRead} | Pos: ${offset} -> ${offset + bytesRead}`);

                const idRaw = this._readVINT_ID(hBuf, 0);
                if (!idRaw || idRaw.val !== 0x1F43B675) throw new Error(`Invalid cluster ID at ${offset}`);

                const sizeRaw = this._readVINT(hBuf, idRaw.len);
                cluster.dataOffset = offset + idRaw.len + sizeRaw.len;
                const clusterSize = sizeRaw.val;
                cluster.endOffset = clusterSize === -1 ? (registry.metadata?.fileSize || Infinity) : (cluster.dataOffset + clusterSize);
                cluster.parserPosition = cluster.dataOffset;
                cluster.headerParsed = true;
                fs.closeSync(fd);
                fd = null;
            }

            // log(`[ClusterManager] [RESUME] Cluster ${offset} at ${cluster.parserPosition}`);

            while (cluster.parserPosition < cluster.endOffset) {
                const headStatus = await this._ensureBytes(fileId, cluster.parserPosition, 32, tdSend, fileEvents, log, 'ELEMENT_ID_SIZE', offset);
                if (headStatus && headStatus.state === 'WAITING_FOR_BYTES') return headStatus;

                if (!fd) fd = fs.openSync(filePath, 'r');
                const elH = Buffer.alloc(32);
                const hBytesRead = fs.readSync(fd, elH, 0, 32, cluster.parserPosition);
                // log(`[WAKE_PROFILE] READ | Stage: ELEMENT_ID_SIZE | Req: 32 | Actual: ${hBytesRead} | Pos: ${cluster.parserPosition} -> ${cluster.parserPosition + hBytesRead}`);

                const elId = this._readVINT_ID(elH, 0);
                if (!elId) break;
                const elSize = this._readVINT(elH, elId.len);
                if (!elSize) break;

                const elTotal = elId.len + elSize.len + elSize.val;

                if (elId.val === 0xE7) {
                    const tBuf = Buffer.alloc(elSize.val);
                    fs.readSync(fd, tBuf, 0, elSize.val, cluster.parserPosition + elId.len + elSize.len);
                    cluster.clusterTimecode = tBuf.readUIntBE(0, elSize.val);
                } else if (elId.val === 0xA3 || elId.val === 0xA0) {
                    const dataStatus = await this._ensureBytes(fileId, cluster.parserPosition, elTotal, tdSend, fileEvents, log, 'ELEMENT_PAYLOAD', offset);
                    if (dataStatus && dataStatus.state === 'WAITING_FOR_BYTES') return dataStatus;

                    const bBuf = Buffer.alloc(elTotal);
                    const bBytesRead = fs.readSync(fd, bBuf, 0, elTotal, cluster.parserPosition);
                    log(`[WAKE_PROFILE] READ | Stage: ELEMENT_PAYLOAD | Req: ${elTotal} | Actual: ${bBytesRead} | Pos: ${cluster.parserPosition} -> ${cluster.parserPosition + bBytesRead}`);

                    const bData = (elId.val === 0xA3) ?
                        { block: { dataOffset: elId.len + elSize.len, size: elSize.val } } :
                        this._findInBlockGroupInBuffer(bBuf, elId.len + elSize.len, elSize.val);

                    if (bData && bData.block) {
                        const h = this._decodeBlockHeader(bBuf, bData.block.dataOffset, bData.block.size);

                        // Debug: print Block info to console so we can inspect while playing
                        try {
                            const blockOffset = cluster.parserPosition;
                            const payloadBuf = Buffer.from(bBuf.slice(h.payloadOffset, h.payloadOffset + h.payloadSize));
                            const lacing = (h.flags >> 1) & 0x03;
                            console.log(`[BLOCK-DBG] Offset=${blockOffset} TimestampMs=${Math.round(((cluster.clusterTimecode + h.timecode) * (registry.metadata?.timecodeScale || 1000000)) / 1000000)} Track=${h.trackNumber} Lacing=${lacing} PayloadSize=${h.payloadSize}`);

                            // Inspect payload for ADTS (AAC) access units and print their offsets/lengths
                            const adtsFrames = this._scanADTSFrames(payloadBuf);
                            if (adtsFrames.length > 0) {
                                console.log(`[BLOCK-DBG] Detected ${adtsFrames.length} ADTS frames inside Block at payload offset ${h.payloadOffset}:`);
                                for (let i = 0; i < adtsFrames.length; i++) {
                                    const f = adtsFrames[i];
                                    const absOff = blockOffset + h.payloadOffset + f.offset;
                                    console.log(`[ADTS] #${i + 1} offset=${f.offset} abs=${absOff} length=${f.length}`);
                                }
                            } else {
                                console.log('[BLOCK-DBG] No ADTS syncwords found in payload');
                            }
                        } catch (e) {
                            console.error('[BLOCK-DBG] Error inspecting payload:', e && e.stack ? e.stack : e);
                        }

                        const rawTimestamp = cluster.clusterTimecode + h.timecode;
                        const timecodeScale = registry.metadata?.timecodeScale || 1000000;
                        const timestampMs = Math.round((rawTimestamp * timecodeScale) / 1000000);

                        let durationMs = 2000;
                        if (bData.duration) {
                            const rawDuration = bBuf.readUIntBE(bData.duration.dataOffset, bData.duration.size);
                            durationMs = Math.round((rawDuration * timecodeScale) / 1000000);
                        }

                        const lacing = (h.flags >> 1) & 0x03;

                        if (!cluster.packets.has(h.trackNumber)) cluster.packets.set(h.trackNumber, []);
                        const trackPackets = cluster.packets.get(h.trackNumber);

                        if (lacing === 0) {
                            trackPackets.push({ time: timestampMs, payload: Buffer.from(bBuf.slice(h.payloadOffset, h.payloadOffset + h.payloadSize)), duration: durationMs });
                        } else {
                            let frameIndex = 0;
                            const track = (registry.metadata?.tracks || []).find(t => t.number === h.trackNumber);

                            // Audit metadata resolution
                            if (!this._metadataVerified) {
                                console.log(`[CLUSTER-AUDIT] Metadata check for FileID=${fileId}: FoundTrack=${!!track} | TotalTracks=${registry.metadata?.tracks?.length || 0}`);
                                this._metadataVerified = true;
                            }

                            // Use loose equality for fileId comparison if needed, or ensure metadata is bound.
                            let frameDurationMs = 0;
                            if (track?.codec === 'A_AAC') {
                                if (track.samplingFrequency) {
                                    frameDurationMs = (1024 / track.samplingFrequency) * 1000;
                                } else {
                                    console.warn(`[CLUSTER-LACING] AAC track missing samplingFrequency, using 44100 fallback for lacing duration calculation`);
                                    frameDurationMs = (1024 / 44100) * 1000;
                                }
                            }

                            this._unpackLacing(bBuf, h.payloadOffset, h.payloadSize, lacing, (f) => {
                                const frameTime = timestampMs + (frameIndex * frameDurationMs);
                                // If we don't have a specific frame duration (not AAC), we fall back to the block duration (legacy behavior)
                                // or we could divide block duration by numFrames, but let's stick to the requirement for AAC.
                                const packetDuration = frameDurationMs > 0 ? frameDurationMs : durationMs;

                                trackPackets.push({
                                    time: frameTime,
                                    payload: Buffer.from(f),
                                    duration: packetDuration
                                });
                                frameIndex++;
                            });
                        }
                    }
                }

                cluster.parserPosition += elTotal;
                if (cluster.parserPosition >= (registry.metadata?.fileSize || Infinity)) break;
            }

            // log(`[ClusterManager] [DONE] Cluster ${offset} parsed.`);
            return 'COMPLETED';
        } finally {
            if (fd) fs.closeSync(fd);
        }
    }

    async _ensureBytes(fileId, offset, limit, tdSend, fileEvents, log, elementStage, clusterOffset) {
        // Wrapper for new TransportManager
        return await transportManager.ensureRange(fileId, offset, limit, tdSend, fileEvents, log);
    }

    _readVINT_ID(buf, pos) {
        const first = buf[pos];
        let len = 0;
        if (first & 0x80) len = 1; else if (first & 0x40) len = 2; else if (first & 0x20) len = 3; else if (first & 0x10) len = 4;
        else return null;
        let val = 0; for (let i = 0; i < len; i++) val = val * 256 + buf[pos + i];
        return { val, len };
    }

    _readVINT(buf, pos) {
        const first = buf[pos];
        let len = 0;
        if (first & 0x80) len = 1; else if (first & 0x40) len = 2; else if (first & 0x20) len = 3; else if (first & 0x10) len = 4;
        else if (first & 0x08) len = 5; else if (first & 0x04) len = 6; else if (first & 0x02) len = 7; else if (first & 0x01) len = 8;
        if (len === 0) return null;
        let val = first & (0xFF >> len);
        for (let i = 1; i < len; i++) val = val * 256 + buf[pos + i];
        return { val, len };
    }

    _readSignedVINT(buf, pos) {
        const raw = this._readVINT(buf, pos);
        if (!raw) return null;
        const data = [0, 0x3F, 0x1FFF, 0x0FFFFF, 0x07FFFFFF, 0x03FFFFFFFF, 0x01FFFFFFFFFF, 0x00FFFFFFFFFFFF, 0x007FFFFFFFFFFFFF];
        return { val: raw.val - data[raw.len], len: raw.len };
    }

    _decodeBlockHeader(buf, offset, blockSize) {
        let pos = offset;
        const tn = this._readVINT(buf, pos);
        pos += tn.len;
        const timecode = buf.readInt16BE(pos);
        pos += 2;
        const flags = buf[pos];
        pos += 1;
        return { trackNumber: tn.val, timecode, flags, payloadOffset: pos, payloadSize: Math.max(0, blockSize - (pos - offset)) };
    }

    _unpackLacing(buf, offset, size, type, onFrame) {
        let pos = offset;
        const numFrames = buf[pos] + 1;
        pos++;
        const sizes = []; let sum = 0;
        if (type === 1) { for (let i = 0; i < numFrames - 1; i++) { let s = 0; while (true) { const b = buf[pos++]; s += b; if (b !== 255) break; } sizes.push(s); sum += s; } }
        else if (type === 2) { const s = (size - (pos - offset)) / numFrames; for (let i = 0; i < numFrames - 1; i++) { sizes.push(s); sum += s; } }
        else if (type === 3) { let l = this._readVINT(buf, pos); pos += l.len; sizes.push(l.val); sum += l.val; for (let i = 1; i < numFrames - 1; i++) { const d = this._readSignedVINT(buf, pos); pos += d.len; l.val += d.val; sizes.push(l.val); sum += l.val; } }
        sizes.push(size - (pos - offset) - sum);
        for (const s of sizes) { if (s > 0) onFrame(buf.slice(pos, pos + s)); pos += s; }
    }

    _findInBlockGroupInBuffer(buf, offset, size) {
        let pos = offset, end = offset + size;
        let block = null, duration = null;
        while (pos < end) {
            const id = this._readVINT_ID(buf, pos);
            if (!id) break;
            const s = this._readVINT(buf, pos + id.len);
            if (!s) break;
            if (id.val === 0xA1) block = { dataOffset: pos + id.len + s.len, size: s.val };
            else if (id.val === 0x9B) duration = { dataOffset: pos + id.len + s.len, size: s.val };

            if (block && duration) break;
            pos += id.len + s.len + s.val;
        }
        return block ? { block, duration } : null;
    }

    _scanADTSFrames(buf) {
        // Scans a Buffer for ADTS syncwords and returns array of { offset, length }
        const frames = [];
        let pos = 0;
        const len = buf.length;
        while (pos + 7 <= len) { // need at least 7 bytes for ADTS header
            if (buf[pos] === 0xFF && (buf[pos + 1] & 0xF0) === 0xF0) {
                // Potential ADTS header
                // frame length is 13 bits across bytes 3,4,5
                // ((buf[pos+3] & 0x03) << 11) | (buf[pos+4] << 3) | ((buf[pos+5] & 0xE0) >> 5)
                if (pos + 7 > len) break; // not enough for header
                const a = buf[pos + 3] & 0x03;
                const frameLen = (a << 11) | (buf[pos + 4] << 3) | ((buf[pos + 5] & 0xE0) >> 5);
                if (frameLen <= 0 || pos + frameLen > len) {
                    // invalid length — advance by 1 to continue scanning
                    pos++;
                    continue;
                }
                frames.push({ offset: pos, length: frameLen });
                pos += frameLen;
            } else {
                pos++;
            }
        }
        return frames;
    }
}

module.exports = new ClusterManager();
